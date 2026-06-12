// PubChem REST API utilities for fetching molecular structure data via backend proxy
// All requests go through the FastAPI backend to avoid CORS issues
// In static mode, requests go directly to PubChem (CORS supported: Access-Control-Allow-Origin: *)

declare const __CATGO_STATIC_ONLY__: boolean
import { API_BASE as _DEFAULT_API } from './config'

const IS_STATIC = typeof __CATGO_STATIC_ONLY__ !== `undefined` && __CATGO_STATIC_ONLY__
const PUBCHEM_API = `https://pubchem.ncbi.nlm.nih.gov/rest/pug`

// API base URL - same as compute.ts
let API_BASE = _DEFAULT_API

/**
 * Configure the API base URL.
 */
export function setPubChemApiBase(base: string): void {
  API_BASE = base
}

/**
 * Get current API base URL.
 */
export function getPubChemApiBase(): string {
  return API_BASE
}

// VSCode extension API support - routes API calls through extension host to bypass CSP
let vscode_api: { postMessage: (msg: unknown) => void } | null = null

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
}
const pending_requests = new Map<string, PendingRequest>()

/**
 * Set VSCode API for extension context
 */
export function set_vscode_pubchem_api(
  api: { postMessage: (msg: unknown) => void },
): void {
  vscode_api = api
  if (typeof window !== `undefined`) {
    window.addEventListener(`message`, (event: MessageEvent) => {
      const msg = event.data

      // Handle old-style raw fetch responses
      if (msg?.command === `pubchem_fetch_response` && msg.request_id) {
        const pending = pending_requests.get(msg.request_id)
        if (pending) {
          pending_requests.delete(msg.request_id)
          if (msg.error) {
            pending.reject(new Error(msg.error))
          } else {
            pending.resolve(msg.data)
          }
        }
      }

      // Handle new-style search responses
      if (msg?.command === `pubchem_search_response` && msg.request_id) {
        const pending = pending_requests.get(msg.request_id)
        if (pending) {
          pending_requests.delete(msg.request_id)
          if (msg.error) {
            pending.reject(new Error(msg.error))
          } else {
            pending.resolve(msg.data)
          }
        }
      }
    })
    console.log(`[PubChem] VSCode extension proxy initialized`)
  }
}

/**
 * Fetch via VSCode extension host
 */
async function fetch_via_vscode(url: string): Promise<unknown> {
  if (!vscode_api) {
    throw new Error(`VSCode API not available`)
  }
  const request_id = `pubchem_${Date.now()}_${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    pending_requests.set(request_id, { resolve, reject })
    vscode_api!.postMessage({ command: `pubchem_fetch`, request_id, url })
    setTimeout(() => {
      if (pending_requests.has(request_id)) {
        pending_requests.delete(request_id)
        reject(new Error(`Request timeout for ${url}`))
      }
    }, 30000)
  })
}

/**
 * Context-aware fetch
 */
async function fetch_json_smart(url: string): Promise<unknown> {
  if (vscode_api) {
    try {
      return await fetch_via_vscode(url)
    } catch (error) {
      console.warn(`[PubChem] VSCode proxy failed:`, error)
      throw error
    }
  }

  const response = await fetch(url, {
    headers: { 'Accept': `application/json` },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return await response.json()
}

export interface PubChemAtom {
  number: number // atomic number
  x: number
  y: number
  z: number
  label?: string
}

export interface PubChemBond {
  aid1: number[] // atom index 1
  aid2: number[] // atom index 2
  order: number[] // bond order (1, 2, 3, 4)
}

export interface PubChemCompound {
  id: {
    id: {
      cid: number // compound ID
    }
  }
  atoms?: {
    aid?: number[] // atom IDs
    element?: number[] // atomic numbers
  }
  bonds?: {
    aid1?: number[]
    aid2?: number[]
    order?: number[]
  }
  coords?: Array<{
    type?: number[]
    aid?: number[]
    conformers?: Array<{
      x?: number[]
      y?: number[]
      z?: number[]
    }>
  }>
  props?: Array<{
    urn: {
      label: string
      name: string
    }
    value: {
      sval?: string
      ival?: number
      fval?: number
    }
  }>
}

export interface PubChemSearchResult {
  Compound: Array<{
    CID: number
    MolecularFormula?: string
    MolecularWeight?: number
    Title?: string
    IUPACName?: string
  }>
}

export interface PubChemSearchCompound {
  cid: number
  formula: string
  weight?: number
  name?: string
  XLogP?: number
  TPSA?: number
  HBondDonorCount?: number
  HBondAcceptorCount?: number
  RotatableBondCount?: number
  HeavyAtomCount?: number
}

export interface PubChemSearchResponse {
  compounds: PubChemSearchCompound[]
  total_count?: number
  has_more?: boolean
}

// Simple in-memory cache
const cached_search_results: Record<string, PubChemSearchResponse | null> = {}
const search_cache_time: Record<string, number> = {}
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

/**
 * Parse elements from a chemical formula (e.g., "C6H6" -> ["C", "H"])
 */
function parse_elements_from_formula(formula: string): string[] {
  const matches = formula.match(/[A-Z][a-z]?/g)
  return matches ? [...new Set(matches)] : []
}

/**
 * Autocomplete PubChem compound names for a partial search term.
 * Returns an array of name suggestions (up to `limit`).
 * Returns [] if `term` is shorter than 2 characters or on any error.
 */
export async function autocomplete_pubchem(term: string, limit = 8): Promise<string[]> {
  if (term.length < 2) return []
  try {
    const url = `${API_BASE}/pubchem/autocomplete?term=${
      encodeURIComponent(term)
    }&limit=${limit}`
    const response = await fetch(url, { headers: { 'Accept': `application/json` } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json() as { suggestions?: string[] }
    return data.suggestions ?? []
  } catch {
    return []
  }
}

/**
 * Search for compounds in PubChem by formula, name, CID, or element set.
 */
export async function search_pubchem_compounds(
  search_term?: string,
  elements?: string[],
  limit = 20,
  offset = 0,
): Promise<PubChemSearchResponse> {
  if (!search_term && (!elements || elements.length === 0)) {
    return { compounds: [] }
  }

  // Normalize element symbols to canonical case (H, Fe) — PubChem rejects "h" / "FE" with 400
  const normalized_elements = elements
    ?.map((el) => el.trim())
    .filter((el) => el.length > 0)
    .map((el) => el.charAt(0).toUpperCase() + el.slice(1).toLowerCase())

  // Determine search type and term
  let search_type: string
  let term: string

  if (!search_term && normalized_elements && normalized_elements.length > 0) {
    // Element-only search
    search_type = `element`
    term = normalized_elements.join(`,`)
  } else if (search_term && /^\d+$/.test(search_term)) {
    // Pure integer → direct CID lookup
    search_type = `cid`
    term = search_term
  } else if (search_term && /^[A-Z][a-z]?\d*([A-Z][a-z]?\d*)*$/.test(search_term)) {
    // Matches chemical formula pattern
    search_type = `formula`
    term = search_term
  } else {
    search_type = `name`
    term = search_term || ``
  }

  // Check cache (include search_type and offset in key)
  const cache_key = `${search_type}:${term}:${elements?.join(`,`) ?? ``}:${offset}`
  const now = Date.now()
  if (
    cached_search_results[cache_key] &&
    (now - (search_cache_time[cache_key] ?? 0)) < CACHE_DURATION
  ) {
    return cached_search_results[cache_key]!
  }

  try {
    let compounds: PubChemSearchCompound[] = []
    let total_count: number | undefined
    let has_more = false

    if (IS_STATIC) {
      // Static mode: query PubChem REST API directly (CORS supported)
      let url: string
      if (search_type === `cid`) {
        url =
          `${PUBCHEM_API}/compound/cid/${term}/property/MolecularFormula,MolecularWeight,IUPACName/JSON`
      } else if (search_type === `formula`) {
        url = `${PUBCHEM_API}/compound/fastformula/${
          encodeURIComponent(term)
        }/property/MolecularFormula,MolecularWeight,IUPACName/JSON?MaxRecords=${limit}`
      } else {
        url = `${PUBCHEM_API}/compound/name/${
          encodeURIComponent(term)
        }/property/MolecularFormula,MolecularWeight,IUPACName/JSON?MaxRecords=${limit}`
      }
      const response = await fetch(url)
      if (!response.ok) {
        if (response.status === 404) {
          // No results found
          const result: PubChemSearchResponse = { compounds: [] }
          cached_search_results[cache_key] = result
          search_cache_time[cache_key] = now
          return result
        }
        throw new Error(`PubChem search failed: ${response.status}`)
      }
      const data = await response.json() as {
        PropertyTable?: {
          Properties?: Array<
            {
              CID: number
              MolecularFormula?: string
              MolecularWeight?: number
              IUPACName?: string
            }
          >
        }
      }
      const props = data.PropertyTable?.Properties || []
      compounds = props.map((p) => ({
        cid: p.CID,
        formula: p.MolecularFormula || ``,
        weight: p.MolecularWeight,
        name: p.IUPACName,
      }))
      total_count = compounds.length
      has_more = compounds.length === limit
    } else {
      // Backend proxy mode
      const params = new URLSearchParams({
        term,
        search_type,
        max_results: String(limit),
        offset: String(offset),
      })
      const url = `${API_BASE}/pubchem/search?${params}`
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`PubChem search failed: ${response.status}`)
      }
      const data = await response.json() as {
        compounds?: Array<
          { cid: number; formula: string; weight?: number; name?: string }
        >
        total_count?: number
        has_more?: boolean
      }
      compounds = data.compounds || []
      total_count = data.total_count
      has_more = data.has_more ?? false
    }

    // Filter by elements if both search_term and elements are specified
    if (normalized_elements && normalized_elements.length > 0 && search_term) {
      compounds = compounds.filter((c) => {
        const compound_elements = parse_elements_from_formula(c.formula)
        return normalized_elements.every((e) => compound_elements.includes(e))
      })
    }

    const result: PubChemSearchResponse = { compounds, total_count, has_more }
    cached_search_results[cache_key] = result
    search_cache_time[cache_key] = now
    return result
  } catch (error) {
    console.warn(`[PubChem] Search failed for "${search_term}":`, error)
    const result: PubChemSearchResponse = { compounds: [] }
    cached_search_results[cache_key] = result
    search_cache_time[cache_key] = Date.now()
    return result
  }
}

/**
 * Post PubChem search to extension host and wait for response
 */
function post_to_extension_pubchem_search(
  search_term?: string,
  elements?: string[],
): Promise<PubChemSearchResponse> {
  if (!vscode_api) {
    throw new Error(`VSCode API not available`)
  }

  const request_id = `pubchem_search_${Date.now()}_${Math.random().toString(36).slice(2)}`

  return new Promise((resolve, reject) => {
    pending_requests.set(request_id, {
      resolve: (data) => {
        const result = data as PubChemSearchResponse
        resolve(result)
      },
      reject,
    })

    vscode_api!.postMessage({
      command: `pubchem_search`,
      request_id,
      search_term,
      elements,
    })

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pending_requests.has(request_id)) {
        pending_requests.delete(request_id)
        reject(new Error(`PubChem search timeout`))
      }
    }, 30000)
  })
}

/**
 * Fetch full structure data for a compound by CID
 */
export async function fetch_pubchem_compound(
  cid: number,
): Promise<PubChemCompound | null> {
  try {
    let url: string
    let data: {
      PC_Compounds?: Array<
        {
          id: { id: { cid: number } }
          atoms?: { aid?: number[]; element?: number[] }
          bonds?: { aid1?: number[]; aid2?: number[]; order?: number[] }
          coords?: Array<
            { conformers?: Array<{ x?: number[]; y?: number[]; z?: number[] }> }
          >
        }
      >
    }

    if (vscode_api || IS_STATIC) {
      // Direct PubChem API call (VSCode or static mode)
      url =
        `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/JSON?record_type=3d`
      data = await fetch_json_smart(url) as typeof data
    } else {
      // Backend proxy
      url = `${API_BASE}/pubchem/compound/${cid}?record_type=3d`
      const response = await fetch(url)
      if (!response.ok) {
        if (response.status === 404) return null
        throw new Error(`Failed to fetch compound: ${response.status}`)
      }
      const backend_data = await response.json() as {
        cid: number
        atoms?: { aid?: number[]; element?: number[] }
        bonds?: { aid1?: number[]; aid2?: number[]; order?: number[] }
        coords?: Array<{ x: number[]; y: number[]; z: number[] }>
      }

      // Convert backend format to PubChemCompound format
      const compound: PubChemCompound = {
        id: { id: { cid: backend_data.cid } },
        atoms: backend_data.atoms,
        bonds: backend_data.bonds,
        coords: backend_data.coords?.length
          ? [{
            conformers: backend_data.coords.map((c) => ({
              x: c.x,
              y: c.y,
              z: c.z,
            })),
          }]
          : undefined,
      }
      return compound
    }

    const compounds = data.PC_Compounds || []
    if (compounds.length === 0) return null

    return compounds[0] as PubChemCompound
  } catch (error) {
    console.warn(`[PubChem] Failed to fetch compound ${cid}:`, error)
    return null
  }
}

/**
 * Extract atoms and coordinates from PubChem compound
 */
export function extract_atoms_from_pubchem(
  compound: PubChemCompound,
): {
  atoms: PubChemAtom[]
  bonds?: PubChemBond
} {
  const atoms: PubChemAtom[] = []

  // Get atomic numbers from atoms array
  const atomic_numbers = compound.atoms?.element || []
  const atom_ids = compound.atoms?.aid || []

  // Get coordinates from first conformer if available
  let coords_x: number[] = []
  let coords_y: number[] = []
  let coords_z: number[] = []

  if (compound.coords && compound.coords.length > 0) {
    const conformers = compound.coords[0]?.conformers
    if (conformers && conformers.length > 0) {
      const conf = conformers[0]
      coords_x = conf.x || []
      coords_y = conf.y || []
      coords_z = conf.z || Array(coords_x.length).fill(0) // Default to 0 if no z
    }
  }

  // Build atom list
  for (let i = 0; i < atomic_numbers.length; i++) {
    atoms.push({
      number: atomic_numbers[i],
      x: coords_x[i] || 0,
      y: coords_y[i] || 0,
      z: coords_z[i] || 0,
      label: `${atom_ids[i] || i + 1}`,
    })
  }

  return {
    atoms,
    bonds: compound.bonds as PubChemBond | undefined,
  }
}

/** Properties returned by the PubChem compound properties endpoint. */
export interface PubChemProperties {
  CID?: number
  MolecularFormula?: string
  MolecularWeight?: number
  Title?: string
  IUPACName?: string
  // PubChem renamed the SMILES property (2025): `SMILES` / `ConnectivitySMILES`
  // are the current names; `CanonicalSMILES` is the deprecated legacy key.
  SMILES?: string
  ConnectivitySMILES?: string
  CanonicalSMILES?: string
  InChI?: string
  InChIKey?: string
  XLogP?: number
  TPSA?: number
  HBondDonorCount?: number
  HBondAcceptorCount?: number
  RotatableBondCount?: number
}

/**
 * Fetch extended properties for a compound by CID via backend.
 */
export async function fetch_pubchem_properties(
  cid: number,
): Promise<PubChemProperties | null> {
  try {
    let url: string
    if (IS_STATIC) {
      const props =
        `MolecularFormula,MolecularWeight,IUPACName,SMILES,InChI,InChIKey,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount`
      url = `${PUBCHEM_API}/compound/cid/${cid}/property/${props}/JSON`
    } else {
      url = `${API_BASE}/pubchem/compound/${cid}/properties`
    }
    const response = await fetch(url)
    if (!response.ok) {
      if (response.status === 404) return null
      throw new Error(`Failed to fetch properties: ${response.status}`)
    }
    if (IS_STATIC) {
      const data = await response.json() as {
        PropertyTable?: { Properties?: PubChemProperties[] }
      }
      return data.PropertyTable?.Properties?.[0] ?? null
    }
    return await response.json()
  } catch (error) {
    console.warn(`[PubChem] Failed to fetch properties for CID ${cid}:`, error)
    return null
  }
}

// Legacy exports for backward compatibility
// These are no longer needed but kept to avoid breaking imports
export function init_vscode_pubchem_proxy(): void {
  console.log(`[PubChem] VSCode proxy not needed - using backend API`)
}

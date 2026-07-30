// Materials Project API utilities.
// Requires user's API key from https://materialsproject.org/
// Three transports: VSCode extension host proxy, FastAPI backend proxy, and
// (STATIC_ONLY web build) browser-direct via the CORS relay — api.materialsproject.org
// sends no Access-Control-Allow-Origin, so direct browser fetches are blocked.

import { API_BASE as _DEFAULT_API, STATIC_ONLY } from './config'
import { isMobile } from '$lib/api/transport'
import { relay_fetch } from '$lib/chat/provider-routing'
import type { OptimadeSearchResult, OptimadeStructure } from './optimade'

// Mobile has no Python backend regardless of STATIC_ONLY (local dev builds run
// with STATIC_ONLY=false), so it must take the direct-API branch — same rule
// optimade.ts applies to every gate. relay_fetch then uses the native Tauri
// HTTP plugin (no browser CORS, key goes straight to MP).
const direct_api = (): boolean => STATIC_ONLY || isMobile()

// API base URL - same as other API modules
let API_BASE = _DEFAULT_API

/**
 * Configure the API base URL.
 */
export function setMPApiBase(base: string): void {
  API_BASE = base
}

// Local storage key for API key
const MP_API_KEY_STORAGE = `mp_api_key`

/**
 * Get stored Materials Project API key
 */
export function get_mp_api_key(): string | null {
  if (typeof window === `undefined`) return null
  return localStorage.getItem(MP_API_KEY_STORAGE)
}

/**
 * Store Materials Project API key
 */
export function set_mp_api_key(key: string): void {
  if (typeof window === `undefined`) return
  if (key.trim()) {
    localStorage.setItem(MP_API_KEY_STORAGE, key.trim())
  } else {
    localStorage.removeItem(MP_API_KEY_STORAGE)
  }
}

/**
 * Check if API key is configured
 */
export function has_mp_api_key(): boolean {
  return !!get_mp_api_key()
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
export function set_vscode_mp_api(api: { postMessage: (msg: unknown) => void }): void {
  vscode_api = api
  if (typeof window !== `undefined`) {
    window.addEventListener(`message`, (event: MessageEvent) => {
      const msg = event.data
      if (msg?.command === `mp_fetch_response` && msg.request_id) {
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
    console.log(`[Materials Project] VSCode extension proxy initialized`)
  }
}

/**
 * Fetch via VSCode extension host with API key
 */
async function fetch_via_vscode(url: string, api_key?: string): Promise<unknown> {
  if (!vscode_api) {
    throw new Error(`VSCode API not available`)
  }
  const request_id = `mp_${Date.now()}_${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    pending_requests.set(request_id, { resolve, reject })
    vscode_api!.postMessage({ command: `mp_fetch`, request_id, url, api_key })
    setTimeout(() => {
      if (pending_requests.has(request_id)) {
        pending_requests.delete(request_id)
        reject(new Error(`Request timeout for ${url}`))
      }
    }, 30000)
  })
}

/**
 * Context-aware fetch with API key
 */
async function fetch_json_smart(url: string, api_key: string): Promise<unknown> {
  if (vscode_api) {
    try {
      return await fetch_via_vscode(url, api_key)
    } catch (error) {
      console.warn(`[Materials Project] VSCode proxy failed:`, error)
      throw error
    }
  }

  // Web context: relay-aware fetch. api.materialsproject.org is CORS-blocked, so
  // relay_fetch transparently routes it through the edge relay (which forwards the
  // X-API-KEY header). Open hosts/backend-proxy URLs go direct.
  const response = await relay_fetch(url, {
    headers: {
      'Content-Type': `application/json`,
      'X-API-KEY': api_key,
    },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return await response.json()
}

export interface MPStructureData {
  lattice: {
    matrix: number[][]
    pbc?: boolean[]
    a?: number
    b?: number
    c?: number
    alpha?: number
    beta?: number
    gamma?: number
    volume?: number
    [key: string]: unknown
  }
  sites: Array<{
    species: Array<{
      element: string
      occu: number
      oxidation_state?: number
      [key: string]: unknown
    }>
    abc: number[]
    xyz: number[]
    label: string
    properties: Record<string, unknown>
    [key: string]: unknown
  }>
  charge?: number
  properties?: Record<string, unknown>
  [key: string]: unknown
}

export interface MPSummaryData {
  material_id: string
  formula_pretty: string
  nsites: number
  nelements: number
  symmetry?: {
    crystal_system?: string
    symbol?: string
    number?: number
  }
  energy_above_hull?: number
  formation_energy_per_atom?: number
  band_gap?: number
  is_stable?: boolean
  is_metal?: boolean
  efermi?: number
  cbm?: number
  vbm?: number
  ordering?: string
  structure?: MPStructureData
  // Availability map MP returns at `has_props`: { dos: bool, bandstructure: bool, ... }.
  // We only read .dos / .bandstructure for the preview — the full payloads are huge
  // and would defeat the point of "preview before import".
  has_props?: Record<string, boolean>
}

export interface MPSearchOptions {
  elements?: string[]
  formula?: string
  material_ids?: string[]
  num_elements?: number
  limit?: number
  offset?: number
}

export interface MPSearchPage {
  structures: MPSummaryData[]
  total_count?: number
  has_more: boolean
}

/**
 * Adapt an MP summary document to the result-card shape shared with OPTIMADE.
 */
export function mp_summary_to_optimade_structure(
  summary: MPSummaryData,
): OptimadeStructure {
  const mp_structure = summary.structure
  const pbc = mp_structure?.lattice.pbc ?? [true, true, true]
  const species_at_sites = mp_structure?.sites.map(
    (site) => site.species[0]?.element ?? site.label,
  )

  return {
    id: summary.material_id,
    type: `structures`,
    attributes: {
      chemical_formula_descriptive: summary.formula_pretty,
      chemical_formula_reduced: summary.formula_pretty,
      nsites: summary.nsites,
      nelements: summary.nelements,
      dimension_types: mp_structure
        ? pbc.map((periodic) => periodic ? 1 : 0)
        : undefined,
      nperiodic_dimensions: mp_structure
        ? pbc.filter(Boolean).length
        : undefined,
      lattice_vectors: mp_structure?.lattice.matrix,
      cartesian_site_positions: mp_structure?.sites.map((site) => site.xyz),
      species_at_sites,
      _mp_crystal_system: summary.symmetry?.crystal_system,
      _mp_spacegroup_symbol: summary.symmetry?.symbol,
      _mp_spacegroup_number: summary.symmetry?.number,
      _mp_energy_above_hull: summary.energy_above_hull,
      _mp_formation_energy_per_atom: summary.formation_energy_per_atom,
      _mp_band_gap: summary.band_gap,
      _mp_is_stable: summary.is_stable,
      _mp_is_metal: summary.is_metal,
      _mp_efermi: summary.efermi,
      _mp_cbm: summary.cbm,
      _mp_vbm: summary.vbm,
      _mp_ordering: summary.ordering,
      _mp_has_props: summary.has_props,
    },
  }
}

const MP_SUMMARY_FIELDS = [
  `material_id`,
  `formula_pretty`,
  `nsites`,
  `nelements`,
  `symmetry`,
  `energy_above_hull`,
  `formation_energy_per_atom`,
  `band_gap`,
  `is_stable`,
  `is_metal`,
  `efermi`,
  `cbm`,
  `vbm`,
  `ordering`,
  `has_props`,
].join(`,`)

/**
 * Search one page of Materials Project summary documents.
 */
export async function search_mp_structures_page(
  options: MPSearchOptions = {},
): Promise<MPSearchPage> {
  const api_key = get_mp_api_key()
  if (!api_key) {
    throw new Error(`Materials Project API key not configured`)
  }

  const limit = options.limit ?? 20
  const offset = options.offset ?? 0
  let data: {
    data?: MPSummaryData[]
    meta?: { total_doc?: number }
  }

  if (vscode_api || direct_api()) {
    const params = new URLSearchParams({
      _fields: MP_SUMMARY_FIELDS,
      _limit: String(limit),
    })

    if (offset > 0) params.set(`_skip`, String(offset))
    if (options.material_ids) {
      params.set(`material_ids`, options.material_ids.join(`,`))
    } else if (options.elements) {
      params.set(`elements`, options.elements.join(`,`))
    }
    if (options.formula) params.set(`formula`, options.formula)
    if (options.num_elements !== undefined) {
      params.set(`nelements_min`, String(options.num_elements))
      params.set(`nelements_max`, String(options.num_elements))
    }

    const url = `https://api.materialsproject.org/materials/summary/?${params}`
    data = await fetch_json_smart(url, api_key) as typeof data
  } else {
    const response = await fetch(`${API_BASE}/mp/search`, {
      method: `POST`,
      headers: {
        'Content-Type': `application/json`,
        'X-API-KEY': api_key,
      },
      body: JSON.stringify({
        elements: options.elements || null,
        formula: options.formula || null,
        material_ids: options.material_ids || null,
        num_elements: options.num_elements ?? null,
        limit,
        offset,
      }),
    })

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(`Invalid API key. Please check your Materials Project API key.`)
      }
      throw new Error(`Materials Project API error: ${response.status}`)
    }

    data = await response.json()
  }

  const structures = data.data || []
  const total_count = data.meta?.total_doc
  return {
    structures,
    total_count,
    has_more: total_count === undefined
      ? structures.length === limit
      : offset + structures.length < total_count,
  }
}

/**
 * Search MP's primary REST API while preserving the modal's shared result shape.
 */
export async function search_mp_structures_as_optimade(
  options: MPSearchOptions = {},
): Promise<OptimadeSearchResult> {
  const page = await search_mp_structures_page(options)
  return {
    structures: page.structures.map(mp_summary_to_optimade_structure),
    total_count: page.total_count,
    has_more: page.has_more,
  }
}

/**
 * Search Materials Project for structures with full computed properties
 */
export async function search_mp_structures(
  elements?: string[],
  formula?: string,
  limit: number = 20,
  material_ids?: string[],
): Promise<MPSummaryData[]> {
  const page = await search_mp_structures_page({
    elements,
    formula,
    limit,
    material_ids,
  })
  return page.structures
}

/**
 * Get a single structure's summary data from Materials Project
 */
export async function get_mp_structure_summary(material_id: string): Promise<MPSummaryData | null> {
  const api_key = get_mp_api_key()
  if (!api_key) {
    return null
  }

  try {
    let url: string
    let data: { data?: MPSummaryData | MPSummaryData[] }

    if (vscode_api || direct_api()) {
      // Direct API call (relay-routed in the web build)
      const params = new URLSearchParams({
        _fields: `${MP_SUMMARY_FIELDS},structure`,
        material_ids: material_id,
        _limit: `1`,
      })
      url = `https://api.materialsproject.org/materials/summary/?${params}`
      data = await fetch_json_smart(url, api_key) as typeof data
    } else {
      // Backend proxy
      const response = await fetch(`${API_BASE}/mp/structure/${material_id}`, {
        headers: { 'X-API-KEY': api_key },
      })

      if (!response.ok) return null

      data = await response.json()
    }

    if (Array.isArray(data.data)) return data.data[0] ?? null
    return data.data ?? null
  } catch (err) {
    console.error(`[MP API] Error fetching ${material_id}:`, err)
    return null
  }
}

/**
 * Validate an API key by making a test request
 */
export async function validate_mp_api_key(key: string): Promise<boolean> {
  try {
    let url: string
    let data: { valid_response?: boolean }

    if (vscode_api) {
      // Direct API call - try the dedicated check endpoint
      url = `https://www.materialsproject.org/rest/v1/api_check`
      data = await fetch_json_smart(url, key) as { valid_response?: boolean }
      if (data.valid_response) {
        return true
      }

      // Fallback: try summary endpoint with limit 1
      url = `https://api.materialsproject.org/materials/summary/?_limit=1`
      await fetch_json_smart(url, key)
      return true // If we got here without error, key is valid
    } else if (direct_api()) {
      // Web build: validate via the new MP API summary endpoint through the relay
      // (the www.materialsproject.org api_check host is not relay-allowlisted).
      // fetch_json_smart throws on a non-2xx (e.g. 401 invalid key) → caught below.
      url = `https://api.materialsproject.org/materials/summary/?_limit=1`
      await fetch_json_smart(url, key)
      return true
    } else {
      // Backend proxy
      const response = await fetch(`${API_BASE}/mp/validate-key`, {
        headers: { 'X-API-KEY': key },
      })

      if (!response.ok) return false

      data = await response.json()
      return (data as any).valid === true
    }
  } catch (err) {
    console.error(`[MP API] Validation error:`, err)
    return false
  }
}

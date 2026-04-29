// OPTIMADE API utilities for fetching structure data via backend proxy
// All requests go through the FastAPI backend to avoid CORS issues

declare const __CATGO_STATIC_ONLY__: boolean
import { API_BASE as _DEFAULT_API } from './config'

// API base URL - same as compute.ts
let API_BASE = _DEFAULT_API

/**
 * Configure the API base URL.
 */
export function setOptimadeApiBase(base: string): void {
  API_BASE = base
}

/**
 * Get current API base URL.
 */
export function getOptimadeApiBase(): string {
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
 * Set VSCode API for extension context (enables CORS-free fetching)
 */
export function set_vscode_api(api: { postMessage: (msg: unknown) => void }): void {
  vscode_api = api
  // Listen for responses from extension host
  if (typeof window !== `undefined`) {
    window.addEventListener(`message`, (event: MessageEvent) => {
      const msg = event.data

      // Handle old-style raw fetch responses
      if (msg?.command === `optimade_fetch_response` && msg.request_id) {
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
      if (msg?.command === `optimade_search_response` && msg.request_id) {
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
    console.log(`[OPTIMADE] VSCode extension proxy initialized`)
  }
}

/**
 * Fetch JSON via VSCode extension host (bypasses CSP restrictions)
 */
async function fetch_via_vscode(url: string): Promise<unknown> {
  if (!vscode_api) {
    throw new Error(`VSCode API not available`)
  }
  const request_id = `optimade_${Date.now()}_${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    pending_requests.set(request_id, { resolve, reject })
    vscode_api!.postMessage({ command: `optimade_fetch`, request_id, url })
    // Timeout after 30 seconds
    setTimeout(() => {
      if (pending_requests.has(request_id)) {
        pending_requests.delete(request_id)
        reject(new Error(`Request timeout for ${url}`))
      }
    }, 30000)
  })
}

/**
 * Context-aware fetch - uses VSCode proxy or backend, never direct from webview (CSP)
 */
async function fetch_json_smart(url: string): Promise<unknown> {
  // In VSCode extension context, MUST use extension host proxy (no direct webview fetches due to CSP)
  if (vscode_api) {
    return await fetch_via_vscode(url)
  }

  // In web context: direct fetch (backend will handle routing)
  const response = await fetch(url, {
    headers: { 'Accept': `application/vnd.api+json` },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return await response.json()
}

export interface OptimadeStructure {
  id: string
  type: `structures`
  attributes: {
    chemical_formula_descriptive?: string
    chemical_formula_reduced?: string
    chemical_formula_anonymous?: string
    dimension_types?: number[]
    nperiodic_dimensions?: number
    lattice_vectors?: number[][]
    cartesian_site_positions?: number[][]
    species_at_sites?: string[]
    species?: {
      name: string
      chemical_symbols?: string[]
      concentration?: number[]
      mass?: number[]
      original_name?: string
    }[]
    nsites?: number // OPTIMADE standard field
    n_sites?: number // Alternative field name
    last_modified?: string
    immutable_id?: string
    // Extended fields (provider-specific, commonly from Materials Project)
    // Crystal system
    _mp_crystal_system?: string
    // Space group
    _mp_spacegroup_symbol?: string
    _mp_spacegroup_number?: number
    // Thermodynamic stability
    _mp_energy_above_hull?: number // eV/atom
    _mp_formation_energy_per_atom?: number // eV/atom
    _mp_is_stable?: boolean
    // Electronic properties
    _mp_band_gap?: number // eV
    _mp_is_metal?: boolean
    // Alternative naming conventions
    _exmpl_band_gap?: number
    _odbx_band_gap?: number
    // Generic catch-all for other provider fields
    [key: string]: unknown
  }
  relationships?: Record<string, unknown>
  links?: Record<string, unknown>
}

export interface OptimadeProvider {
  id: string
  type: `links`
  attributes: {
    name: string
    description?: string
    base_url: string
    homepage?: string
    version?: string
    [key: string]: unknown
  }
}

// Simple in-memory cache
let cached_providers: OptimadeProvider[] | null = null
let providers_cache_time = 0
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

// URL encode/decode utilities for structure IDs with special characters
export const encode_structure_id = (id: string) =>
  encodeURIComponent(id).replace(/\./g, `%2E`).replace(/\//g, `%2F`)

export const decode_structure_id = (encoded_id: string) => decodeURIComponent(encoded_id)

export function detect_provider_from_slug(slug: string, providers: OptimadeProvider[]) {
  const decoded_slug = decode_structure_id(slug)
  const prefix = decoded_slug.split(`-`)[0].toLowerCase()
  return providers.find((p) => p.id === prefix)?.id ?? ``
}

/**
 * Fetch list of available OPTIMADE providers
 */
// Hardcoded OPTIMADE providers — providers.optimade.org does not support CORS,
// so we can't fetch the list from the browser. These are the working providers.
// base_url is required for direct browser queries in static mode.
const STATIC_PROVIDERS: OptimadeProvider[] = [
  { id: `mp`, type: `links`, attributes: { name: `The Materials Project`, description: `Materials data`, base_url: `https://optimade.materialsproject.org` } } as OptimadeProvider,
  { id: `alexandria`, type: `links`, attributes: { name: `Alexandria`, description: `PBE & PBEsol crystal structures`, base_url: `https://alexandria.icams.rub.de/pbe` } } as OptimadeProvider,
  { id: `mc3d`, type: `links`, attributes: { name: `MC3D`, description: `Materials Cloud 3D crystals`, base_url: `https://aiida.materialscloud.org/mc3d/optimade` } } as OptimadeProvider,
  { id: `mc2d`, type: `links`, attributes: { name: `MC2D`, description: `Materials Cloud 2D materials`, base_url: `https://aiida.materialscloud.org/mc2d/optimade` } } as OptimadeProvider,
  { id: `omdb`, type: `links`, attributes: { name: `Open Materials Database`, description: `Organic materials`, base_url: `https://optimade.openmaterialsdb.se` } } as OptimadeProvider,
]

export async function fetch_optimade_providers(): Promise<OptimadeProvider[]> {
  const now = Date.now()
  if (cached_providers && (now - providers_cache_time) < CACHE_DURATION) {
    return cached_providers
  }

  // In static-only mode, use hardcoded providers (CORS blocks providers.optimade.org).
  // Note: OPTIMADE search APIs also lack CORS, so only PubChem works in static mode.
  // OPTIMADE providers are excluded until a CORS proxy (e.g. Cloudflare Workers) is set up.
  const is_static = typeof __CATGO_STATIC_ONLY__ !== `undefined` && __CATGO_STATIC_ONLY__
  if (is_static) {
    cached_providers = []  // No OPTIMADE providers — PubChem is added by the modal
    providers_cache_time = now
    return cached_providers
  }

  try {
    // In VSCode context, fetch directly from providers.optimade.org
    // In web context with backend, go through backend proxy
    const url = vscode_api
      ? `https://providers.optimade.org/v1/links`
      : `${API_BASE}/optimade/providers`

    const data = await fetch_json_smart(url) as { data?: OptimadeProvider[] }

    // Filter broken providers if fetching directly
    let providers = data.data || []
    if (vscode_api) {
      const BROKEN_PROVIDER_IDS = new Set([
        `aflow`, `cod`, `cmr`, `exmpl`, `matcloud`, `mpds`,
        `mpod`, `nmd`, `odbx`, `oqmd`, `jarvis`, `tcod`,
      ])
      providers = providers.filter(p => !BROKEN_PROVIDER_IDS.has(p.id))
    }

    cached_providers = providers
    providers_cache_time = now
    return cached_providers ?? []
  } catch (error) {
    console.warn(`Failed to fetch OPTIMADE providers from backend:`, error)
    // Return cached providers if available, otherwise empty array
    return cached_providers ?? []
  }
}

/**
 * Fetch a single structure from an OPTIMADE provider
 */
export async function fetch_optimade_structure(
  structure_id: string,
  provider: string,
  providers: OptimadeProvider[],
): Promise<OptimadeStructure | null> {
  const encoded_id = encode_structure_id(structure_id)

  const is_static = typeof __CATGO_STATIC_ONLY__ !== `undefined` && __CATGO_STATIC_ONLY__
  let url: string
  if (vscode_api || is_static) {
    // Direct API call: need to resolve provider base URL and construct endpoint
    const provider_obj = providers.find(p => p.id === provider)
    if (!provider_obj) {
      throw new Error(`Unknown provider: ${provider}`)
    }
    let base_url = provider_obj.attributes.base_url
    // Special case: Materials Project has a real OPTIMADE API at optimade.materialsproject.org
    if (provider === `mp` || provider === `mpdd`) {
      base_url = `https://optimade.materialsproject.org`
    }
    // Try common endpoint patterns
    url = `${base_url}/v1/structures/${encoded_id}`
  } else {
    // Backend proxy
    url = `${API_BASE}/optimade/structure/${provider}/${encoded_id}`
  }

  try {
    const data = await fetch_json_smart(url) as { data?: OptimadeStructure }
    return data.data || null
  } catch (error) {
    if (error instanceof Error && error.message.includes(`404`)) {
      return null
    }
    throw error
  }
}

/**
 * Fetch suggested structures from a provider (for initial display)
 */
export async function fetch_suggested_structures(
  provider: string,
  providers: OptimadeProvider[],
  limit: number = 12,
): Promise<OptimadeStructure[]> {
  try {
    let url: string
    let data: { data?: OptimadeStructure[] }

    const is_static = typeof __CATGO_STATIC_ONLY__ !== `undefined` && __CATGO_STATIC_ONLY__
    if (vscode_api || is_static) {
      // Direct API call
      const provider_obj = providers.find(p => p.id === provider)
      if (!provider_obj) return []
      let base_url = provider_obj.attributes.base_url
      // Special case: Materials Project has a real OPTIMADE API at optimade.materialsproject.org
      if (provider === `mp` || provider === `mpdd`) {
        base_url = `https://optimade.materialsproject.org`
      }
      url = `${base_url}/v1/structures?page_limit=${limit}&page_offset=0`
      data = await fetch_json_smart(url) as typeof data
    } else {
      // Backend proxy
      const response = await fetch(`${API_BASE}/optimade/search`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({
          provider_id: provider,
          page_limit: limit,
          page_offset: 0,
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch suggested structures: ${response.status}`)
      }

      data = await response.json()
    }

    return data.data || []
  } catch (error) {
    console.warn(`Failed to fetch suggested structures for ${provider}:`, error)
    return []
  }
}

export interface OptimadeSearchOptions {
  formula?: string // e.g., "NaCl", "Fe2O3"
  elements?: string[] // e.g., ["Fe", "O"] - structures containing these elements
  elements_only?: string[] // structures containing ONLY these elements
  nelements?: number // exact number of elements
  nelements_min?: number
  nelements_max?: number
  nsites_min?: number
  nsites_max?: number
  limit?: number // max results (default 20)
  offset?: number // pagination offset
}

export interface OptimadeSearchResult {
  structures: OptimadeStructure[]
  total_count?: number
  has_more: boolean
}

/**
 * Parse elements from a chemical formula (e.g., "TiO2" -> ["Ti", "O"])
 */
function parse_elements_from_formula(formula: string): string[] {
  const matches = formula.match(/[A-Z][a-z]?/g)
  return matches ? [...new Set(matches)] : []
}

/**
 * Normalize a chemical formula for OPTIMADE search
 * OPTIMADE uses alphabetically sorted elements (Hill notation without C/H priority)
 * e.g., "Ta11O2" -> "O2Ta11"
 */
function normalize_formula_for_optimade(formula: string): string {
  // Parse formula into element-count pairs
  const regex = /([A-Z][a-z]?)(\d*)/g
  const elements: { symbol: string; count: number }[] = []
  let match
  while ((match = regex.exec(formula)) !== null) {
    if (match[1]) {
      elements.push({
        symbol: match[1],
        count: match[2] ? parseInt(match[2], 10) : 1,
      })
    }
  }
  // Sort alphabetically by element symbol
  elements.sort((a, b) => a.symbol.localeCompare(b.symbol))
  // Rebuild formula
  return elements.map((e) => e.symbol + (e.count > 1 ? e.count : ``)).join(``)
}

/**
 * Build an OPTIMADE filter string from search options
 */
function build_optimade_filter(options: OptimadeSearchOptions): string {
  const filters: string[] = []

  if (options.formula) {
    // Check if this looks like a specific formula (has numbers) or just elements
    const hasNumbers = /\d/.test(options.formula)

    if (hasNumbers) {
      // Search by chemical_formula_reduced for specific formulas like "Ta11O2"
      // Normalize to OPTIMADE format (alphabetically sorted)
      const normalized = normalize_formula_for_optimade(options.formula)
      console.log(`[OPTIMADE FILTER] Formula "${options.formula}" normalized to "${normalized}"`)
      filters.push(`chemical_formula_reduced="${normalized}"`)
    } else {
      // Just elements like "TaO" - search by elements
      const elements = parse_elements_from_formula(options.formula)
      if (elements.length > 0) {
        const elements_str = elements.map((e) => `"${e}"`).join(`,`)
        filters.push(`elements HAS ALL ${elements_str}`)
        filters.push(`nelements=${elements.length}`)
      }
    }
  }

  if (options.elements && options.elements.length > 0) {
    const elements_str = options.elements.map((e) => `"${e}"`).join(`,`)
    filters.push(`elements HAS ALL ${elements_str}`)
  }

  if (options.elements_only && options.elements_only.length > 0) {
    const elements_str = options.elements_only.map((e) => `"${e}"`).join(`,`)
    filters.push(`elements HAS ALL ${elements_str}`)
    filters.push(`nelements=${options.elements_only.length}`)
  }

  if (options.nelements !== undefined) {
    filters.push(`nelements=${options.nelements}`)
  }

  if (options.nelements_min !== undefined) {
    filters.push(`nelements>=${options.nelements_min}`)
  }

  if (options.nelements_max !== undefined) {
    filters.push(`nelements<=${options.nelements_max}`)
  }

  if (options.nsites_min !== undefined) {
    filters.push(`nsites>=${options.nsites_min}`)
  }

  if (options.nsites_max !== undefined) {
    filters.push(`nsites<=${options.nsites_max}`)
  }

  return filters.join(` AND `)
}

/**
 * Search for structures using OPTIMADE filter language
 */
export async function search_optimade_structures(
  provider: string,
  providers: OptimadeProvider[],
  options: OptimadeSearchOptions = {},
): Promise<OptimadeSearchResult> {
  try {
    if (vscode_api) {
      // VSCode extension: delegate to extension host backend logic
      return await post_to_extension_optimade_search(provider, options)
    }

    const is_static = typeof __CATGO_STATIC_ONLY__ !== `undefined` && __CATGO_STATIC_ONLY__
    const limit = options.limit ?? 20
    const offset = options.offset ?? 0
    const filter = build_optimade_filter(options)

    if (is_static) {
      // Static mode: query OPTIMADE API directly from browser (CORS supported by most providers)
      const provider_obj = providers.find(p => p.id === provider)
      let base_url = provider_obj?.attributes?.base_url
      if (!base_url && provider === `mp`) base_url = `https://optimade.materialsproject.org`
      if (!base_url) throw new Error(`No base URL for provider ${provider}`)

      let url = `${base_url}/v1/structures?page_limit=${limit}&page_offset=${offset}`
      if (filter) url += `&filter=${encodeURIComponent(filter)}`

      const response = await fetch(url, {
        headers: { 'Accept': `application/vnd.api+json` },
      })
      if (!response.ok) throw new Error(`OPTIMADE API error (${response.status})`)
      const data = await response.json() as { data?: OptimadeStructure[]; meta?: { data_returned?: number; data_available?: number } }
      const structures = data.data || []
      return {
        structures,
        total_count: data.meta?.data_returned ?? data.meta?.data_available,
        has_more: structures.length === limit,
      }
    }

    // Web app with backend: use backend proxy
    const response = await fetch(`${API_BASE}/optimade/search`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify({
        provider_id: provider,
        filter: filter || undefined,
        page_limit: limit,
        page_offset: offset,
      }),
    })

    if (!response.ok) {
      const error_text = await response.text()
      throw new Error(`OPTIMADE API error (${response.status}): ${error_text}`)
    }

    const data = await response.json() as { data?: OptimadeStructure[]; meta?: { data_returned?: number; data_available?: number } }

    const structures = data.data || []
    const total_count = data.meta?.data_returned ?? data.meta?.data_available

    return {
      structures,
      total_count,
      has_more: structures.length === limit,
    }
  } catch (error) {
    console.warn(`Failed to search structures for ${provider}:`, error)
    throw error
  }
}

/** Provider-specific details extracted from OPTIMADE extended attributes. */
export interface ProviderDetails {
  crystal_system?: string
  spacegroup_symbol?: string
  spacegroup_number?: number
  band_gap?: number
  energy_above_hull?: number
  formation_energy?: number
  is_stable?: boolean
  is_metal?: boolean
  /** Any other interesting extended fields keyed by display label. */
  extra: Record<string, string | number | boolean>
}

/** Pattern groups used to scan OPTIMADE attributes for known extended fields. */
const DETAIL_PATTERNS: {
  key: keyof Omit<ProviderDetails, 'extra'>
  regex: RegExp
}[] = [
  { key: `crystal_system`, regex: /^_\w+_crystal_system$|^crystal_system$/ },
  { key: `spacegroup_symbol`, regex: /^_\w+_spacegroup_symbol$|^_\w+_symmetry_symbol$/ },
  { key: `spacegroup_number`, regex: /^_\w+_spacegroup_number$|^_\w+_symmetry_number$/ },
  { key: `band_gap`, regex: /^_\w+_band_gap$/ },
  { key: `energy_above_hull`, regex: /^_\w+_energy_above_hull$/ },
  { key: `formation_energy`, regex: /^_\w+_formation_energy/ },
  { key: `is_stable`, regex: /^_\w+_is_stable$/ },
  { key: `is_metal`, regex: /^_\w+_is_metal$/ },
]

/**
 * Scan OPTIMADE attributes for provider-specific extended fields.
 * Works generically across any OPTIMADE provider that supplies `_prefix_*` fields.
 */
export function extract_provider_details(
  attributes: Record<string, unknown>,
): ProviderDetails {
  const details: ProviderDetails = { extra: {} }

  for (const [attr_key, attr_val] of Object.entries(attributes)) {
    if (attr_val === null || attr_val === undefined) continue
    // Skip standard OPTIMADE fields
    if (!attr_key.startsWith(`_`)) continue

    let matched = false
    for (const { key, regex } of DETAIL_PATTERNS) {
      if (regex.test(attr_key) && details[key] === undefined) {
        ;(details as unknown as Record<string, unknown>)[key] = attr_val
        matched = true
        break
      }
    }

    // Also handle nested symmetry objects (e.g. _mp_symmetry: { crystal_system, symbol, number })
    if (attr_key.endsWith(`_symmetry`) && typeof attr_val === `object` && attr_val !== null) {
      const sym = attr_val as Record<string, unknown>
      if (sym.crystal_system && !details.crystal_system) {
        details.crystal_system = String(sym.crystal_system)
      }
      if (sym.symbol && !details.spacegroup_symbol) {
        details.spacegroup_symbol = String(sym.symbol)
      }
      if (typeof sym.number === `number` && !details.spacegroup_number) {
        details.spacegroup_number = sym.number
      }
      matched = true
    }

    if (!matched) {
      // Collect other extended fields for display
      const nice_key = attr_key
        .replace(/^_\w+_/, ``)
        .replace(/_/g, ` `)
        .replace(/\b\w/g, (c) => c.toUpperCase())
      if (typeof attr_val === `string` || typeof attr_val === `number` || typeof attr_val === `boolean`) {
        details.extra[nice_key] = attr_val
      }
    }
  }

  return details
}

// Legacy exports for backward compatibility
// These are no longer needed but kept to avoid breaking imports
export function init_vscode_optimade_proxy(): void {
  console.log(`[OPTIMADE] VSCode proxy not needed - using backend API`)
}

/**
 * Post OPTIMADE search request to VSCode extension host
 */
async function post_to_extension_optimade_search(
  provider: string,
  options: OptimadeSearchOptions,
): Promise<OptimadeSearchResult> {
  const request_id = `optimade_search_${Date.now()}_${Math.random().toString(36).slice(2)}`

  return new Promise((resolve, reject) => {
    pending_requests.set(request_id, {
      resolve: (data) => {
        const result = data as OptimadeSearchResult
        resolve(result)
      },
      reject,
    })

    vscode_api!.postMessage({
      command: `optimade_search`,
      request_id,
      provider,
      options,
    })

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pending_requests.has(request_id)) {
        pending_requests.delete(request_id)
        reject(new Error(`OPTIMADE search timeout for ${provider}`))
      }
    }, 30000)
  })
}
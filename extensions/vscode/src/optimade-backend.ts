// OPTIMADE backend logic - runs in extension host to handle provider routing
// Replicated from src/lib/api/optimade.ts

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
    nsites?: number
    n_sites?: number
    last_modified?: string
    immutable_id?: string
    _mp_crystal_system?: string
    _mp_spacegroup_symbol?: string
    _mp_spacegroup_number?: number
    _mp_energy_above_hull?: number
    _mp_formation_energy_per_atom?: number
    _mp_is_stable?: boolean
    _mp_band_gap?: number
    _mp_is_metal?: boolean
    _exmpl_band_gap?: number
    _odbx_band_gap?: number
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

export interface OptimadeSearchOptions {
  formula?: string
  elements?: string[]
  elements_only?: string[]
  nelements?: number
  nelements_min?: number
  nelements_max?: number
  nsites_min?: number
  nsites_max?: number
  limit?: number
  offset?: number
}

export interface OptimadeSearchResult {
  structures: OptimadeStructure[]
  total_count?: number
  has_more: boolean
}

// Cache for providers
let cached_providers: OptimadeProvider[] | null = null
let providers_cache_time = 0
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

/**
 * Fetch list of OPTIMADE providers from central registry
 */
async function fetch_providers(): Promise<OptimadeProvider[]> {
  const now = Date.now()
  if (cached_providers && (now - providers_cache_time) < CACHE_DURATION) {
    return cached_providers
  }

  try {
    const response = await fetch(`https://providers.optimade.org/v1/links`, {
      headers: {
        'Accept': `application/vnd.api+json`,
        'User-Agent': `CatGO/1.0`,
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const data = await response.json() as { data?: OptimadeProvider[] }
    let providers = data.data || []

    // Filter out broken/unreliable providers when running in extension
    const BROKEN_PROVIDER_IDS = new Set([
      `aflow`, `cod`, `cmr`, `exmpl`, `matcloud`, `mpds`,
      `mpod`, `nmd`, `odbx`, `oqmd`, `jarvis`, `tcod`,
    ])
    providers = providers.filter(p => !BROKEN_PROVIDER_IDS.has(p.id))

    cached_providers = providers
    providers_cache_time = now
    return providers
  } catch (error) {
    console.warn(`[OPTIMADE] Failed to fetch providers:`, error)
    return cached_providers || []
  }
}

/**
 * Normalize formula for OPTIMADE (alphabetical sorting)
 */
function normalize_formula_for_optimade(formula: string): string {
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

  elements.sort((a, b) => a.symbol.localeCompare(b.symbol))
  return elements.map((e) => e.symbol + (e.count > 1 ? e.count : ``)).join(``)
}

/**
 * Parse elements from formula
 */
function parse_elements_from_formula(formula: string): string[] {
  const matches = formula.match(/[A-Z][a-z]?/g)
  return matches ? [...new Set(matches)] : []
}

/**
 * Build OPTIMADE filter string from search options
 */
function build_optimade_filter(options: OptimadeSearchOptions): string {
  const filters: string[] = []

  if (options.formula) {
    const hasNumbers = /\d/.test(options.formula)

    if (hasNumbers) {
      const normalized = normalize_formula_for_optimade(options.formula)
      console.log(`[OPTIMADE] Formula "${options.formula}" → "${normalized}"`)
      filters.push(`chemical_formula_reduced="${normalized}"`)
    } else {
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
 * Search for OPTIMADE structures - main entry point for extension
 */
export async function search_optimade_structures_backend(
  provider: string,
  options: OptimadeSearchOptions = {},
): Promise<OptimadeSearchResult> {
  const limit = options.limit ?? 20
  const offset = options.offset ?? 0
  const filter = build_optimade_filter(options)

  try {
    // Get list of providers
    const providers = await fetch_providers()
    const provider_obj = providers.find(p => p.id === provider)

    if (!provider_obj) {
      throw new Error(`Unknown provider: ${provider}`)
    }

    // Special case: Materials Project has a real OPTIMADE API at optimade.materialsproject.org
    // The providers registry returns a proxy URL that doesn't work for API calls
    let base_url = provider_obj.attributes.base_url
    if (provider === `mp` || provider === `mpdd`) {
      base_url = `https://optimade.materialsproject.org`
      console.log(`[OPTIMADE] Using real Materials Project API: ${base_url}`)
    }

    // Build query URL
    const filter_param = filter ? `&filter=${encodeURIComponent(filter)}` : ``
    const url = `${base_url}/v1/structures?page_limit=${limit}&page_offset=${offset}${filter_param}`

    console.log(`[OPTIMADE] Search URL: ${url}`)
    if (filter) console.log(`[OPTIMADE] Filter: ${filter}`)

    // Fetch from provider
    const response = await fetch(url, {
      headers: {
        'Accept': `application/vnd.api+json`,
        'User-Agent': `CatGO/1.0`,
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json() as {
      data?: OptimadeStructure[]
      meta?: { data_returned?: number; data_available?: number }
    }

    const structures = data.data || []
    const total_count = data.meta?.data_returned ?? data.meta?.data_available

    return {
      structures,
      total_count,
      has_more: structures.length === limit,
    }
  } catch (error) {
    console.error(`[OPTIMADE] Search failed:`, error)
    throw error
  }
}

/**
 * Fetch suggested structures for initial display
 */
export async function fetch_suggested_structures_backend(
  provider: string,
  limit: number = 12,
): Promise<OptimadeStructure[]> {
  try {
    const providers = await fetch_providers()
    const provider_obj = providers.find(p => p.id === provider)

    if (!provider_obj) return []

    const base_url = provider_obj.attributes.base_url
    const url = `${base_url}/v1/structures?page_limit=${limit}&page_offset=0`

    const response = await fetch(url, {
      headers: {
        'Accept': `application/vnd.api+json`,
        'User-Agent': `CatGO/1.0`,
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const data = await response.json() as { data?: OptimadeStructure[] }
    return data.data || []
  } catch (error) {
    console.warn(`[OPTIMADE] Failed to fetch suggested structures:`, error)
    return []
  }
}

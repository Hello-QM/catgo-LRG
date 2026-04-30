// PubChem backend logic - runs in extension host
// Replicated from src/lib/api/pubchem.ts

export interface PubChemSearchResponse {
  compounds: Array<{
    cid: number
    formula: string
    weight?: number
    name?: string
  }>
}

// Cache for searches
let cached_search_results: Record<string, PubChemSearchResponse | null> = {}
let search_cache_time: Record<string, number> = {}
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

/**
 * Parse elements from formula (e.g., "C6H6" -> ["C", "H"])
 */
function parse_elements_from_formula(formula: string): string[] {
  const matches = formula.match(/[A-Z][a-z]?/g)
  return matches ? [...new Set(matches)] : []
}

/**
 * Search PubChem - main entry point for extension
 * Handles both formula/name searches and element-based searches
 * NOTE: Pure element searches (e.g., "C", "FeO") typically return 0 results in PubChem
 * because PubChem contains compounds, not bare elements
 */
export async function search_pubchem_compounds_backend(
  search_term?: string,
  elements?: string[],
): Promise<PubChemSearchResponse> {
  if (!search_term && (!elements || elements.length === 0)) {
    return { compounds: [] }
  }

  // Check cache
  const cache_key = `${search_term}:${elements?.join(',') ?? ''}`
  const now = Date.now()

  if (
    cached_search_results[cache_key] &&
    (now - (search_cache_time[cache_key] ?? 0)) < CACHE_DURATION
  ) {
    console.log(`[PubChem] Using cached results for "${cache_key}"`)
    return cached_search_results[cache_key]!
  }

  try {
    // Determine search type and term
    let search_type = `name`
    let term = search_term || ``

    if (!search_term && elements && elements.length > 0) {
      search_type = `formula`
      // Element-only searches in PubChem often return 0 results
      // because PubChem is a compound database, not an element database
      // e.g., searching for "C" or "FeO" won't return anything useful
      term = elements.join(``)
      console.log(`[PubChem] Element search: elements=${elements.join(',')} → formula="${term}"`)
      console.log(`[PubChem] Note: Element-only searches in PubChem typically return no results (need actual compounds)`)
    }

    console.log(`[PubChem] Searching ${search_type}: "${term}"`)

    // Step 1: Get CIDs (Compound IDs)
    const cid_url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${search_type}/${encodeURIComponent(term)}/cids/JSON`
    console.log(`[PubChem] CID lookup: ${cid_url}`)

    const cid_response = await fetch(cid_url, {
      headers: {
        'Accept': `application/json`,
        'User-Agent': `CatGO/1.0`,
      },
    })

    if (!cid_response.ok) {
      console.warn(`[PubChem] CID lookup failed: HTTP ${cid_response.status}`)
      const result: PubChemSearchResponse = { compounds: [] }
      cached_search_results[cache_key] = result
      search_cache_time[cache_key] = now
      return result
    }

    const cid_data = await cid_response.json() as { IdentifierList?: { CID?: number[] } }
    const cids = (cid_data.IdentifierList?.CID || []).slice(0, 20)
    console.log(`[PubChem] Found ${cids.length} compounds`)

    if (cids.length === 0) {
      const result: PubChemSearchResponse = { compounds: [] }
      cached_search_results[cache_key] = result
      search_cache_time[cache_key] = now
      return result
    }

    // Step 2: Get properties for all CIDs
    const cids_str = cids.join(`,`)
    const props_url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cids_str}/property/MolecularFormula,MolecularWeight,Title,IUPACName/JSON`
    console.log(`[PubChem] Fetching properties for ${cids.length} compounds`)

    const props_response = await fetch(props_url, {
      headers: {
        'Accept': `application/json`,
        'User-Agent': `CatGO/1.0`,
      },
    })

    if (!props_response.ok) {
      console.warn(`[PubChem] Properties fetch failed: HTTP ${props_response.status}`)
      const result: PubChemSearchResponse = { compounds: [] }
      cached_search_results[cache_key] = result
      search_cache_time[cache_key] = now
      return result
    }

    const props_data = await props_response.json() as {
      PropertyTable?: {
        Properties?: Array<{
          CID: number
          MolecularFormula: string
          MolecularWeight: number
          Title?: string
          IUPACName?: string
        }>
      }
    }

    const properties = props_data.PropertyTable?.Properties || []
    console.log(`[PubChem] Got properties for ${properties.length} compounds`)

    let compounds = properties.map(prop => ({
      cid: prop.CID,
      formula: prop.MolecularFormula,
      weight: prop.MolecularWeight,
      name: prop.Title || prop.IUPACName,
    }))

    // Filter by elements if specified (when search term was also provided)
    if (elements && elements.length > 0 && search_term) {
      compounds = compounds.filter((c) => {
        const compound_elements = parse_elements_from_formula(c.formula)
        return elements.every((e) => compound_elements.includes(e))
      })
    }

    const result: PubChemSearchResponse = { compounds }
    cached_search_results[cache_key] = result
    search_cache_time[cache_key] = now
    return result
  } catch (error) {
    console.error(`[PubChem] Search failed:`, error)
    const result: PubChemSearchResponse = { compounds: [] }
    cached_search_results[cache_key] = result
    search_cache_time[cache_key] = now
    return result
  }
}

/**
 * Fetch full compound data by CID (for structure visualization)
 */
export async function fetch_pubchem_compound_backend(cid: number): Promise<unknown> {
  try {
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/JSON?record_type=3d`

    const response = await fetch(url, {
      headers: {
        'Accept': `application/json`,
        'User-Agent': `CatGO/1.0`,
      },
    })

    if (!response.ok) {
      if (response.status === 404) return null
      throw new Error(`HTTP ${response.status}`)
    }

    return await response.json()
  } catch (error) {
    console.warn(`[PubChem] Failed to fetch compound ${cid}:`, error)
    return null
  }
}

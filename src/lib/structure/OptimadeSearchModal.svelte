<script lang="ts">
  import { Icon, PeriodicTable } from '$lib'
  import { isMobile } from '$lib/api/transport'
  import type { OptimadeProvider, OptimadeSearchResult, OptimadeStructure } from '$lib/api/optimade'
  import {
    fetch_optimade_providers,
    fetch_optimade_structure,
    search_optimade_structures,
    extract_provider_details,
  } from '$lib/api/optimade'
  import {
    set_mp_api_key,
    has_mp_api_key,
    search_mp_structures,
    get_mp_structure_summary,
    validate_mp_api_key,
    type MPSummaryData,
  } from '$lib/api/materials-project'
  import type { PubChemCompound, PubChemSearchResponse, PubChemSearchCompound } from '$lib/api/pubchem'
  import { fetch_pubchem_compound, search_pubchem_compounds } from '$lib/api/pubchem'
  import { Composition } from '$lib/composition'
  import { get_electro_neg_formula } from '$lib/composition/parse'
  import { analyze_structure_symmetry } from '$lib/symmetry'
  import { get_conventional_cell } from '$lib/symmetry/cell-transform'
  import { spacegroup_num_to_crystal_sys } from '$lib/symmetry/spacegroups'
  import { get_density } from '$lib/structure'
  import type { PymatgenStructure } from './index'
  import { optimade_to_pymatgen, pubchem_to_pymatgen } from './parse'
  import { SvelteMap } from 'svelte/reactivity'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Structure fingerprint helpers for MP id-migration fallback matching
  function norm_formula(f: string | undefined): string {
    if (!f) return ``
    const counts: Record<string, number> = {}
    const re = /([A-Z][a-z]?)(\d*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(f)) !== null) {
      if (!m[1]) continue
      counts[m[1]] = (counts[m[1]] ?? 0) + (m[2] ? parseInt(m[2], 10) : 1)
    }
    return Object.keys(counts).sort().map((el) => `${el}${counts[el]}`).join(``)
  }
  function struct_key(formula: string | undefined, nsites: number | undefined, sg: string | undefined): string {
    return `${norm_formula(formula)}|${nsites ?? `?`}|${(sg ?? ``).replace(/\s+/g, ``)}`
  }

  // Lazy-load structure translations
  load_i18n_module('structure')

  interface Props {
    visible: boolean
    onclose: () => void
    onimport: (structure: PymatgenStructure) => void
    onpreview?: (
      optimade_struct: OptimadeStructure,
      pymatgen_struct: PymatgenStructure,
      // Optional: MP REST summary when MP is the active provider. Carries
      // electronic-structure fields (cbm/vbm/efermi/has_props/ordering) that
      // MP's OPTIMADE adapter doesn't always expose.
      mp_summary?: MPSummaryData | null,
    ) => void
    onpubchem_preview?: (
      compound: PubChemCompound,
      search_result: PubChemSearchCompound | null,
      structure: PymatgenStructure,
    ) => void
    initial_elements?: string // Pre-fill elements search and auto-search
    initial_provider?: string // Pre-select a provider (e.g., 'pubchem')
  }
  let {
    visible,
    onclose,
    onimport,
    onpreview,
    onpubchem_preview,
    initial_elements = ``,
    initial_provider = ``,
  }: Props = $props()

  // State
  let providers = $state<OptimadeProvider[]>([])
  let selected_provider = $state(`mp`)
  let search_formula = $state(``)
  let search_elements = $state(``)
  // Search mode: 'only' = exclusive elements, 'at_least' = HAS ALL, 'formula' = exact formula
  let search_mode = $state<`only` | `at_least` | `formula`>(`only`)
  // The element periodic-table picker is big; collapse it by default on mobile.
  let pt_collapsed = $state(isMobile())
  // Elements selected via the periodic table (used for 'only' and 'at_least' modes)
  let selected_elements = $state<string[]>([])
  let loading_providers = $state(false)
  let providers_error = $state<string | null>(null)
  let loading_search = $state(false)
  let loading_import = $state(false)
  let search_results = $state<OptimadeSearchResult | null>(null)
  let search_error = $state<string | null>(null)
  let selected_result = $state<OptimadeStructure | null>(null)
  let modal_element = $state<HTMLDivElement | null>(null)
  let last_initial_elements = $state(``) // Track to detect changes

  // PubChem state
  let is_pubchem = $derived(selected_provider === `pubchem`)
  let pubchem_results = $state<PubChemSearchResponse | null>(null)
  let selected_pubchem_result = $state<PubChemSearchCompound | null>(null)

  // Pagination
  const PAGE_SIZE = 20
  let current_page = $state(0)

  // Materials Project API key state
  let show_api_key_input = $state(false)
  let api_key_input = $state(``)
  let api_key_error = $state<string | null>(null)
  let api_key_validating = $state(false)
  let mp_has_key = $state(typeof localStorage !== `undefined` ? has_mp_api_key() : false)

  // Cache for MP summary data (keyed by material_id)
  let mp_summaries = $state<Map<string, MPSummaryData>>(new Map())
  // Fallback map keyed by structure fingerprint (formula|nsites|sg) for MP id-migration matching
  let mp_summaries_by_key = $state(new SvelteMap<string, MPSummaryData>())

  // Locally computed structure details (keyed by structure id)
  interface ComputedDetails {
    crystal_system?: string
    spacegroup_symbol?: string
    spacegroup_number?: number
    volume?: number
    density?: number
  }
  let computed_details = $state<Map<string, ComputedDetails>>(new Map())
  let computing_details = $state(false)

  // Load providers on mount
  $effect(() => {
    if (visible && providers.length === 0) {
      load_providers()
    }
  })

  // Apply initial_provider when modal becomes visible
  $effect(() => {
    if (visible && initial_provider) {
      selected_provider = initial_provider
    }
  })

  // Auto-search when initial_elements is provided and changes
  $effect(() => {
    if (visible && initial_elements && initial_elements !== last_initial_elements) {
      last_initial_elements = initial_elements
      search_elements = initial_elements
      // Pre-populate the periodic-table selection from a comma/space list
      selected_elements = initial_elements
        .split(/[,\s]+/)
        .map((e) => e.trim())
        .filter((e) => e.length > 0)
      // Auto-search after a short delay to ensure providers are loaded
      setTimeout(() => {
        if (providers.length > 0) {
          do_search()
        }
      }, 100)
    }
  })

  function toggle_element(symbol: string) {
    if (selected_elements.includes(symbol)) {
      selected_elements = selected_elements.filter((e) => e !== symbol)
    } else {
      selected_elements = [...selected_elements, symbol]
    }
    // Keep the elements text input in sync for visibility
    search_elements = selected_elements.join(`, `)
  }

  function clear_selected_elements() {
    selected_elements = []
    search_elements = ``
  }

  // Keep selected_elements synced when the user edits the text input directly
  $effect(() => {
    if (search_mode === `formula`) return
    const parsed = search_elements
      .split(/[,\s]+/)
      .map((e) => e.trim())
      .filter((e) => e.length > 0)
    // Only update if different to avoid loops
    const same =
      parsed.length === selected_elements.length &&
      parsed.every((e, i) => e === selected_elements[i])
    if (!same) selected_elements = parsed
  })

  async function load_providers() {
    loading_providers = true
    providers_error = null
    try {
      const fetched = await fetch_optimade_providers()
      // Append PubChem as a synthetic provider
      providers = [
        ...fetched,
        {
          id: `pubchem`,
          type: `links`,
          attributes: { name: `PubChem`, description: `Molecular structures` },
        } as OptimadeProvider,
      ]
      // Set default provider if current selection is invalid
      if (providers.length > 0 && !providers.find((p) => p.id === selected_provider)) {
        const mp = providers.find((p) => p.id === `mp`)
        selected_provider = mp?.id ?? providers[0].id
      }
      if (fetched.length === 0) {
        providers_error = t('structure.optimade_no_providers')
      }
    } catch (err) {
      console.error(`Failed to load OPTIMADE providers:`, err)
      // Still add PubChem even if OPTIMADE providers fail
      providers = [
        {
          id: `pubchem`,
          type: `links`,
          attributes: { name: `PubChem`, description: `Molecular structures` },
        } as OptimadeProvider,
      ]
      if (selected_provider !== `pubchem`) {
        selected_provider = `pubchem`
      }
      providers_error = t('structure.optimade_load_failed', { error: String(err) })
    }
    loading_providers = false
  }

  // API key handling
  async function save_api_key() {
    if (!api_key_input.trim()) {
      api_key_error = t('structure.api_key_required')
      return
    }

    api_key_validating = true
    api_key_error = null

    const is_valid = await validate_mp_api_key(api_key_input.trim())

    if (is_valid) {
      set_mp_api_key(api_key_input.trim())
      mp_has_key = true
      show_api_key_input = false
      api_key_input = ``
      // Re-run search to get full data
      if (search_results?.structures?.length) {
        fetch_mp_summaries()
      }
    } else {
      api_key_error = t('structure.api_key_invalid')
    }

    api_key_validating = false
  }

  function remove_api_key() {
    set_mp_api_key(``)
    mp_has_key = false
    mp_summaries = new Map()
    mp_summaries_by_key = new SvelteMap()
  }

  // Fetch MP summary data by material IDs from OPTIMADE results
  async function fetch_mp_summaries() {
    if (!mp_has_key || selected_provider !== `mp`) return
    if (!search_results?.structures?.length) return

    // Get material IDs from OPTIMADE results (they're mp-XXXXX format)
    const material_ids = search_results.structures.map(s => s.id)
    console.log(`[MP ENRICH] Fetching MP data for IDs:`, material_ids.slice(0, 5))

    try {
      // Fetch by specific material IDs
      const summaries = await search_mp_structures(
        undefined, // no elements filter
        undefined, // no formula filter
        material_ids.length,
        material_ids, // fetch these specific IDs
      )

      console.log(`[MP ENRICH] Got ${summaries.length} MP results for ${material_ids.length} requested IDs`)

      // Build map keyed by material_id + fallback map keyed by structure fingerprint
      const new_map = new SvelteMap<string, MPSummaryData>()
      const new_by_key = new SvelteMap<string, MPSummaryData>()
      for (const s of summaries) {
        new_map.set(s.material_id, s)
        const k = struct_key(s.formula_pretty, s.nsites, s.symmetry?.symbol)
        if (!new_by_key.has(k)) new_by_key.set(k, s)
      }

      // Log matching stats
      const matches = material_ids.filter(id => new_map.has(id))
      console.log(`[MP ENRICH] Matched ${matches.length}/${material_ids.length} structures by id; fingerprint map has ${new_by_key.size} entries`)
      if (summaries.length > 0) {
        console.log(`[MP ENRICH] Sample MP data:`, summaries[0])
      }

      mp_summaries = new_map
      mp_summaries_by_key = new_by_key

      // Re-sort current results by stability now that we have authoritative
      // numbers: energy_above_hull ascending (0 = on the hull), formation
      // energy per atom as the tiebreak; structures without data go last.
      if (search_results?.structures?.length) {
        const rank = (id: string): [number, number] => {
          const s = new_map.get(id)
          const hull = typeof s?.energy_above_hull === `number`
            ? s.energy_above_hull
            : Number.POSITIVE_INFINITY
          const form = typeof s?.formation_energy_per_atom === `number`
            ? s.formation_energy_per_atom
            : Number.POSITIVE_INFINITY
          return [hull, form]
        }
        const sorted = [...search_results.structures].sort((a, b) => {
          const [ha, fa] = rank(a.id)
          const [hb, fb] = rank(b.id)
          return ha !== hb ? ha - hb : fa - fb
        })
        search_results = { ...search_results, structures: sorted }
      }
    } catch (err) {
      console.warn(`[MP ENRICH] Failed to fetch MP data:`, err)
    }
  }

  // Compute symmetry, volume, density for search results that have structural data
  async function compute_structure_details(structures: OptimadeStructure[]) {
    computing_details = true
    const new_map = new SvelteMap<string, ComputedDetails>()

    for (const struct of structures) {
      const attrs = struct.attributes
      // Need lattice vectors and positions at minimum; species can come from
      // species_at_sites OR species array (parse_optimade_from_raw handles fallback)
      if (!attrs.lattice_vectors || !attrs.cartesian_site_positions) {
        console.warn(`[COMPUTE] ${struct.id}: missing lattice_vectors or positions, skipping`)
        continue
      }
      if (!attrs.species_at_sites && !attrs.species) {
        console.warn(`[COMPUTE] ${struct.id}: missing both species_at_sites and species, skipping`)
        continue
      }

      try {
        const pymatgen = optimade_to_pymatgen(struct)
        if (!pymatgen || !(`lattice` in pymatgen)) {
          console.warn(`[COMPUTE] ${struct.id}: optimade_to_pymatgen returned null`)
          continue
        }

        const details: ComputedDetails = {}

        // Volume from lattice vectors
        const [va, vb, vc] = attrs.lattice_vectors
        const cross = [
          vb[1] * vc[2] - vb[2] * vc[1],
          vb[2] * vc[0] - vb[0] * vc[2],
          vb[0] * vc[1] - vb[1] * vc[0],
        ]
        details.volume = Math.abs(va[0] * cross[0] + va[1] * cross[1] + va[2] * cross[2])

        // Density
        try {
          details.density = get_density(pymatgen)
        } catch (err) {
          console.warn(`[COMPUTE] ${struct.id}: density failed:`, err)
        }

        // Symmetry via moyo-wasm
        try {
          const sym = await analyze_structure_symmetry(pymatgen, {})
          details.spacegroup_number = sym.number
          details.spacegroup_symbol = sym.hm_symbol ?? `#${sym.number}`
          details.crystal_system = spacegroup_num_to_crystal_sys(sym.number) ?? undefined
        } catch (err) {
          console.warn(`[COMPUTE] ${struct.id}: symmetry failed:`, err)
        }

        new_map.set(struct.id, details)
        // Update progressively so the UI shows results as they come in
        computed_details = new Map(new_map)
      } catch (err) {
        console.warn(`[COMPUTE] ${struct.id}: parse failed:`, err)
      }
    }

    computed_details = new_map
    computing_details = false
  }

  async function do_search(page = 0) {
    const has_elements = selected_elements.length > 0 || search_elements.trim().length > 0
    const has_formula = search_formula.trim().length > 0
    if (search_mode === `formula` ? !has_formula : !has_elements) return

    // PubChem search path
    if (is_pubchem) {
      loading_search = true
      search_error = null
      pubchem_results = null
      selected_pubchem_result = null
      search_results = null
      current_page = page

      const offset = page * PAGE_SIZE

      try {
        const elements =
          selected_elements.length > 0
            ? selected_elements.slice()
            : search_elements
                .split(/[,\s]+/)
                .map((e) => e.trim())
                .filter((e) => e.length > 0)

        pubchem_results = await search_pubchem_compounds(
          search_mode === `formula` ? (search_formula || undefined) : undefined,
          search_mode !== `formula` && elements.length > 0 ? elements : undefined,
          PAGE_SIZE,
          offset,
        )

        if (pubchem_results.compounds.length === 0 && page === 0) {
          search_error = null
        }
      } catch (err) {
        search_error = t('structure.search_failed', { error: String(err) })
      }
      loading_search = false
      return
    }

    // OPTIMADE search path
    // Ensure providers are loaded
    if (providers.length === 0) {
      search_error = t('structure.providers_not_loaded')
      await load_providers()
      if (providers.length === 0) {
        search_error = t('structure.optimade_load_failed_short')
        return
      }
      search_error = null
    }

    // Make sure selected provider exists
    if (!providers.find((p) => p.id === selected_provider)) {
      // Fall back to first available provider
      if (providers.length > 0) {
        selected_provider = providers[0].id
        // If the fallback is PubChem, restart through the PubChem path —
        // we already started down the OPTIMADE branch but PubChem needs
        // a different request shape and a different message channel.
        // Without this re-entry the extension host receives an
        // `optimade_search` for provider=pubchem and errors out with
        // "Unknown provider: pubchem".
        if (selected_provider === `pubchem`) {
          loading_search = false
          return do_search(page)
        }
      } else {
        search_error = t('structure.no_providers')
        return
      }
    }

    loading_search = true
    search_error = null
    search_results = null
    selected_result = null
    pubchem_results = null
    computed_details = new Map()
    current_page = page

    const offset = page * PAGE_SIZE

    try {
      const elements =
        selected_elements.length > 0
          ? selected_elements.slice()
          : search_elements
              .split(/[,\s]+/)
              .map((e) => e.trim())
              .filter((e) => e.length > 0)

      const search_options =
        search_mode === `formula`
          ? { formula: search_formula || undefined, limit: PAGE_SIZE, offset }
          : search_mode === `only`
            ? {
                elements_only: elements.length > 0 ? elements : undefined,
                limit: PAGE_SIZE,
                offset,
              }
            : {
                elements: elements.length > 0 ? elements : undefined,
                limit: PAGE_SIZE,
                offset,
              }

      search_results = await search_optimade_structures(
        selected_provider,
        providers,
        search_options,
      )

      // If exact formula search returns no results on first page, try elements only
      if (
        search_mode === `formula` &&
        page === 0 &&
        search_results?.structures?.length === 0 &&
        search_formula &&
        /\d/.test(search_formula)
      ) {
        const formula_elements = search_formula.match(/[A-Z][a-z]?/g) || []
        if (formula_elements.length > 0) {
          search_results = await search_optimade_structures(selected_provider, providers, {
            elements: formula_elements,
            limit: PAGE_SIZE,
            offset,
          })
        }
      }

      // If we have an MP API key and searching MP, fetch full computed properties
      if (mp_has_key && selected_provider === `mp` && search_results?.structures?.length) {
        fetch_mp_summaries()
      }

      // Compute symmetry/volume/density locally for all results
      if (search_results?.structures?.length) {
        computed_details = new Map()
        compute_structure_details(search_results.structures)
      }

    } catch (err) {
      search_error = t('structure.search_failed', { error: String(err) })
      console.error(`[OPTIMADE DEBUG] Search error:`, err)
    }
    loading_search = false
  }

  function go_prev_page() {
    if (current_page > 0) do_search(current_page - 1)
  }

  function go_next_page() {
    if (is_pubchem) {
      if (pubchem_results?.has_more) do_search(current_page + 1)
    } else {
      if (search_results?.has_more) do_search(current_page + 1)
    }
  }

  async function handle_import(struct: OptimadeStructure) {
    loading_import = true
    selected_result = struct
    search_error = null

    try {
      const full_structure = await fetch_optimade_structure(
        struct.id,
        selected_provider,
        providers,
      )
      if (full_structure) {
        // Annotate with the resolved provider name so downstream previews
        // can show "Materials Project" / "Alexandria" etc. instead of the
        // generic "OPTIMADE" fallback. (OPTIMADE responses don't carry the
        // provider id in their attributes by spec.)
        const prov_obj = providers.find((p) => p.id === selected_provider)
        ;(full_structure.attributes as Record<string, unknown>).database_provider =
          prov_obj?.attributes?.name ?? selected_provider
        let pymatgen_structure = optimade_to_pymatgen(full_structure)
        if (pymatgen_structure) {
          // OPTIMADE APIs often return non-standard lattice orientations
          // (e.g. mp-825 RuO2 has a=3.11,b=4.48,c=4.48 instead of a=b=4.48,c=3.11).
          // Standardize to the conventional cell so Miller indices match user expectations.
          try {
            const sym = await analyze_structure_symmetry(pymatgen_structure as import('$lib/structure').Crystal, {})
            if (sym) {
              pymatgen_structure = get_conventional_cell(pymatgen_structure as import('$lib/structure').Crystal, sym) as PymatgenStructure
            }
          } catch (err) {
            console.warn(`[OPTIMADE] Conventional cell standardization failed, using raw structure:`, err)
          }

          // If onpreview is provided, call it instead of onimport
          if (onpreview) {
            // Prefer cached MP REST summary (richer surface than MP's OPTIMADE
            // adapter). Mirror the result-card lookup pattern: primary lookup
            // by struct.id, fallback to structure-fingerprint map for MP IDs
            // that have been renumbered between the OPTIMADE adapter and the
            // REST API. Last resort: fetch the single-record summary on
            // demand (handles the race where fetch_mp_summaries hasn't
            // resolved yet when the user clicks Import).
            let mp_summary: MPSummaryData | null = null
            if (selected_provider === `mp` && mp_has_key) {
              const attrs = struct.attributes ?? {}
              const prov = extract_provider_details(attrs as Record<string, unknown>)
              const comp = computed_details.get(struct.id)
              const fp_key = struct_key(
                attrs.chemical_formula_reduced,
                attrs.nsites ?? attrs.n_sites,
                prov.spacegroup_symbol ?? comp?.spacegroup_symbol,
              )
              mp_summary = mp_summaries.get(struct.id)
                ?? mp_summaries_by_key.get(fp_key)
                ?? null
              if (!mp_summary) {
                try {
                  mp_summary = await get_mp_structure_summary(struct.id)
                  if (mp_summary) mp_summaries.set(struct.id, mp_summary)
                } catch (err) {
                  console.warn(`[MP ENRICH] on-demand fetch failed for`, struct.id, err)
                }
              }
            }
            onpreview(full_structure, pymatgen_structure, mp_summary)
            // Keep modal open - don't call onclose()
          } else {
            // Fallback to direct import if no preview callback
            onimport(pymatgen_structure)
            onclose()
          }
        } else {
          search_error = t('structure.structure_parse_failed')
        }
      } else {
        search_error = t('structure.structure_fetch_failed', { provider: selected_provider })
      }
    } catch (err) {
      console.error(`Failed to import structure:`, err)
      const error_msg = err instanceof Error ? err.message : String(err)
      if (error_msg.includes(`503`) || error_msg.includes(`Service Unavailable`)) {
        search_error = t('structure.provider_unavailable_503', { provider: selected_provider })
      } else if (error_msg.includes(`CORS`) || error_msg.includes(`fetch`)) {
        search_error = t('structure.provider_network_error', { provider: selected_provider })
      } else {
        search_error = t('structure.structure_import_failed', { error: error_msg })
      }
    }
    loading_import = false
  }

  async function handle_pubchem_import(compound: PubChemSearchCompound) {
    loading_import = true
    selected_pubchem_result = compound
    search_error = null

    try {
      const pubchem_compound = await fetch_pubchem_compound(compound.cid)
      if (pubchem_compound) {
        const pymatgen_structure = pubchem_to_pymatgen(pubchem_compound)
        if (pymatgen_structure) {
          if (onpubchem_preview) {
            onpubchem_preview(pubchem_compound, compound, pymatgen_structure)
            // Keep modal open — parent decides whether to close on confirm.
          } else {
            onimport(pymatgen_structure)
            onclose()
          }
        } else {
          search_error = t('structure.structure_conversion_failed')
        }
      } else {
        search_error = t('structure.compound_fetch_failed')
      }
    } catch (err) {
      console.error(`Failed to import structure:`, err)
      search_error = t('structure.structure_import_failed', { error: String(err) })
    }
    loading_import = false
  }

  function handle_keydown(event: KeyboardEvent) {
    // Don't close during loading operations
    if (loading_providers || loading_search || loading_import) return
    if (visible && event.key === `Escape`) onclose()
  }

  function handle_click_outside(event: MouseEvent) {
    // Don't close during loading operations
    if (loading_providers || loading_search || loading_import) return
    if (!modal_element) return
    const target = event.target as HTMLElement
    if (!modal_element.contains(target)) onclose()
  }

  // Results count for display
  let results_count = $derived(
    is_pubchem
      ? (pubchem_results ? pubchem_results.compounds.length : null)
      : (search_results ? search_results.structures.length : null)
  )
  let has_results = $derived(results_count !== null && results_count > 0)
  let total_count = $derived(
    is_pubchem ? pubchem_results?.total_count : search_results?.total_count
  )
  let has_more = $derived(
    is_pubchem ? pubchem_results?.has_more : search_results?.has_more
  )
</script>

<svelte:window onkeydown={handle_keydown} />

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={handle_click_outside}>
    <div class="modal-content" bind:this={modal_element} role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>{t('structure.search_database')}</h2>
        <button class="close-btn" onclick={onclose}>×</button>
      </div>

      <div class="modal-body">
        <div class="mode-tabs" role="tablist" aria-label={t('structure.search_database')}>
          <button
            class="mode-tab"
            class:active={search_mode === `only`}
            role="tab"
            aria-selected={search_mode === `only`}
            onclick={() => (search_mode = `only`)}
          >
            {t('structure.only_elements')}
          </button>
          <button
            class="mode-tab"
            class:active={search_mode === `at_least`}
            role="tab"
            aria-selected={search_mode === `at_least`}
            onclick={() => (search_mode = `at_least`)}
          >
            {t('structure.at_least_elements')}
          </button>
          <button
            class="mode-tab"
            class:active={search_mode === `formula`}
            role="tab"
            aria-selected={search_mode === `formula`}
            onclick={() => (search_mode = `formula`)}
          >
            {t('structure.formula_label')}
          </button>
        </div>

        <!-- Periodic Table for element selection (hidden in Formula mode) -->
        {#if search_mode !== `formula`}
          <div class="periodic-table-section">
            <p class="pt-hint">
              {search_mode === `only`
                ? t('structure.select_only_elements')
                : t('structure.select_at_least_elements')}
              {#if selected_elements.length > 0}
                — {t('structure.selected_elements')} <strong>{selected_elements.join(`, `)}</strong>
                <button class="clear-link" onclick={clear_selected_elements}>{t('common.clear')}</button>
              {/if}
              <button class="clear-link" onclick={() => (pt_collapsed = !pt_collapsed)}>
                {pt_collapsed ? `Show table` : `Hide table`}
              </button>
            </p>
            {#if !pt_collapsed}
              <PeriodicTable
                active_elements={selected_elements as never}
                tile_props={{
                  onclick: ({ element }) => toggle_element(element.symbol),
                }}
                style="max-width: 100%; font-size: 0.55em;"
              />
            {/if}
          </div>
        {/if}

        <div class="provider-section">
          <label for="provider-select">{t('structure.database')}</label>
          {#if loading_providers}
            <span class="loading-text">{t('structure.loading_providers')}</span>
          {:else if providers_error && providers.length === 0}
            <span class="error-text">{providers_error}</span>
            <button class="retry-btn" onclick={load_providers}>{t('common.retry')}</button>
          {:else if providers.length === 0}
            <span class="loading-text">{t('structure.no_providers')}</span>
            <button class="retry-btn" onclick={load_providers}>{t('common.retry')}</button>
          {:else}
            <select id="provider-select" bind:value={selected_provider}>
              {#each providers as provider (provider.id)}
                <option value={provider.id}>{provider.attributes.name} ({provider.id})</option>
              {/each}
            </select>
          {/if}
        </div>

        {#if selected_provider === `mp`}
          <div class="api-key-section">
            {#if show_api_key_input}
              <div class="api-key-input-row">
                <input
                  type="password"
                  placeholder={t('structure.paste_mp_key')}
                  bind:value={api_key_input}
                  onkeydown={(e) => e.key === `Enter` && save_api_key()}
                />
                <button class="api-key-btn save" onclick={save_api_key} disabled={api_key_validating}>
                  {api_key_validating ? t('structure.validating') : t('common.save')}
                </button>
                <button class="api-key-btn cancel" onclick={() => { show_api_key_input = false; api_key_error = null }}>
                  {t('common.cancel')}
                </button>
              </div>
              {#if api_key_error}
                <span class="api-key-error">{api_key_error}</span>
              {/if}
              <span class="api-key-hint">
                {t('structure.get_mp_key')} <a href="https://materialsproject.org/api" target="_blank" rel="noopener">materialsproject.org/api</a>
              </span>
            {:else if mp_has_key}
              <span class="api-key-status success">{t('structure.api_key_configured')}</span>
              <button class="api-key-link" onclick={remove_api_key}>{t('structure.remove_key')}</button>
            {:else}
              <span class="api-key-status">{t('structure.basic_info_only')}</span>
              <button class="api-key-link" onclick={() => show_api_key_input = true}>
                {t('structure.add_api_key')}
              </button>
            {/if}
          </div>
        {/if}

        <!-- Search fields -->
        <div class="search-section">
          {#if search_mode === `formula`}
            <div class="search-field">
              <label for="formula-input">{is_pubchem ? t('structure.formula_name') : t('structure.formula_label')}</label>
              <input
                id="formula-input"
                type="text"
                placeholder={is_pubchem ? t('structure.pubchem_formula_hint') : t('structure.mp_formula_hint')}
                bind:value={search_formula}
                onkeydown={(e) => e.key === `Enter` && do_search()}
              />
            </div>
          {:else}
            <div class="search-field">
              <label for="elements-input">{t('structure.elements_label')}</label>
              <input
                id="elements-input"
                type="text"
                placeholder={t('structure.elements_hint')}
                bind:value={search_elements}
                onkeydown={(e) => e.key === `Enter` && do_search()}
              />
            </div>
          {/if}
          <button class="search-btn" onclick={() => do_search()} disabled={loading_search}>
            {#if loading_search}
              {t('structure.searching')}
            {:else}
              <Icon icon="Search" /> {t('common.search')}
            {/if}
          </button>
        </div>

        {#if search_error}
          <div class="error-message">{search_error}</div>
        {/if}

        <!-- Results -->
        <div class="results-section">
          <h3>{t('structure.results')} {results_count !== null ? `(${results_count})` : ``}</h3>

          {#if is_pubchem}
            <!-- PubChem results -->
            {#if pubchem_results}
              {#if pubchem_results.compounds.length === 0}
                <p class="no-results">{t('structure.no_compounds_found')}</p>
              {:else}
                <div class="results-list">
                  {#each pubchem_results.compounds as compound (compound.cid)}
                    {@const formula = compound.formula}
                    {@const name = compound.name}
                    <div class="result-item" class:selected={selected_pubchem_result?.cid === compound.cid}>
                      <div class="result-info">
                        <div class="result-header">
                          <span class="result-id">{t('structure.result_cid')}: {compound.cid}</span>
                          <span class="result-formula">{@html get_electro_neg_formula(formula)}</span>
                        </div>
                        {#if name}
                          <span class="result-name">{name}</span>
                        {/if}
                        <div class="result-details">
                          {#if compound.weight && typeof compound.weight === `number`}
                            <span class="result-detail" title={t('structure.molecular_weight')}>
                              <span class="detail-label">{t('structure.result_mw')}:</span> {compound.weight.toFixed(2)} g/mol
                            </span>
                          {:else if compound.weight}
                            <span class="result-detail" title={t('structure.molecular_weight')}>
                              <span class="detail-label">{t('structure.result_mw')}:</span> {compound.weight} g/mol
                            </span>
                          {/if}
                          {#if compound.HeavyAtomCount !== undefined}
                            <span class="result-detail" title={t('structure.heavy_atom_count')}>
                              <span class="detail-label">{t('structure.result_atoms')}:</span> {compound.HeavyAtomCount}
                            </span>
                          {/if}
                          {#if compound.XLogP !== undefined && compound.XLogP !== null}
                            <span class="result-detail" title={t('structure.xlogp_lipophilicity')}>
                              <span class="detail-label">XLogP:</span> {compound.XLogP}
                            </span>
                          {/if}
                          {#if compound.TPSA !== undefined && compound.TPSA !== null}
                            <span class="result-detail" title={t('structure.topological_polar_surface_area')}>
                              <span class="detail-label">TPSA:</span> {compound.TPSA} &#8491;&sup2;
                            </span>
                          {/if}
                          {#if compound.HBondDonorCount !== undefined}
                            <span class="result-detail" title={t('structure.hydrogen_bond_donor_count')}>
                              <span class="detail-label">{t('structure.result_h_don')}:</span> {compound.HBondDonorCount}
                            </span>
                          {/if}
                          {#if compound.HBondAcceptorCount !== undefined}
                            <span class="result-detail" title={t('structure.hydrogen_bond_acceptor_count')}>
                              <span class="detail-label">{t('structure.result_h_acc')}:</span> {compound.HBondAcceptorCount}
                            </span>
                          {/if}
                          {#if compound.RotatableBondCount !== undefined}
                            <span class="result-detail" title={t('structure.rotatable_bond_count')}>
                              <span class="detail-label">{t('structure.result_rot')}:</span> {compound.RotatableBondCount}
                            </span>
                          {/if}
                        </div>
                      </div>
                      {#if formula}
                        <Composition
                          composition={formula}
                          mode="pie"
                          style="height: 50px; width: 50px;"
                        />
                      {/if}
                      <button
                        class="import-btn"
                        onclick={() => handle_pubchem_import(compound)}
                        disabled={loading_import && selected_pubchem_result?.cid === compound.cid}
                      >
                        {#if loading_import && selected_pubchem_result?.cid === compound.cid}
                          {t('common.loading')}
                        {:else}
                          <Icon icon="Download" /> {t('common.import')}
                        {/if}
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            {:else if !loading_search}
              <p class="no-results">{t('structure.pubchem_search_hint')}</p>
            {/if}
          {:else}
            <!-- OPTIMADE results -->
            {#if search_results}
              {#if search_results.structures.length === 0}
                <p class="no-results">{t('structure.no_structures_found')}</p>
              {:else}
                <div class="results-list">
                  {#each search_results.structures as struct (struct.id)}
                    {@const attrs = struct.attributes}
                    {@const prov = extract_provider_details(attrs)}
                    {@const comp = computed_details.get(struct.id)}
                    {@const mp_data = mp_summaries.get(struct.id)
                      ?? mp_summaries_by_key.get(struct_key(attrs.chemical_formula_reduced, attrs.nsites ?? attrs.n_sites, prov.spacegroup_symbol ?? comp?.spacegroup_symbol))}
                    {@const formula = mp_data?.formula_pretty ?? attrs.chemical_formula_descriptive ?? attrs.chemical_formula_reduced ?? ``}
                    {@const n_sites = mp_data?.nsites ?? attrs.nsites ?? attrs.n_sites}
                    {@const n_elements = mp_data?.nelements ?? attrs.nelements}
                    {@const chem_system = attrs._mp_chemical_system ?? attrs._mp_chemsys}
                    {@const crystal_system = mp_data?.symmetry?.crystal_system ?? prov.crystal_system ?? comp?.crystal_system}
                    {@const spacegroup = mp_data?.symmetry?.symbol ?? prov.spacegroup_symbol ?? comp?.spacegroup_symbol}
                    {@const sg_number = prov.spacegroup_number ?? comp?.spacegroup_number}
                    {@const e_above_hull = mp_data?.energy_above_hull ?? prov.energy_above_hull}
                    {@const formation_energy = mp_data?.formation_energy_per_atom ?? prov.formation_energy ?? attrs._mp_formation_energy_per_atom}
                    {@const band_gap = mp_data?.band_gap ?? prov.band_gap ?? attrs._mp_band_gap ?? attrs._odbx_band_gap ?? attrs._exmpl_band_gap}
                    {@const is_metal = mp_data?.is_metal ?? prov.is_metal}
                    {@const efermi = mp_data?.efermi ?? prov.efermi}
                    {@const cbm = mp_data?.cbm ?? prov.cbm}
                    {@const vbm = mp_data?.vbm ?? prov.vbm}
                    {@const magnetic_ordering = mp_data?.ordering ?? prov.magnetic_ordering}
                    {@const has_dos = mp_data?.has_props?.dos ?? prov.has_dos}
                    {@const has_bandstructure = mp_data?.has_props?.bandstructure ?? prov.has_bandstructure}
                    {@const is_stable = mp_data?.is_stable ?? prov.is_stable}
                    {@const volume = comp?.volume}
                    {@const density = comp?.density}
                    <div class="result-item" class:selected={selected_result?.id === struct.id}>
                      <div class="result-info">
                        <div class="result-header">
                          <span class="result-id">{struct.id}</span>
                          <span class="result-formula">{@html get_electro_neg_formula(formula)}</span>
                        </div>
                        <div class="result-details">
                          {#if n_sites}
                            <span class="result-detail" title={t('structure.number_of_atomic_sites')}>
                              <span class="detail-label">{t('structure.result_sites')}:</span> {n_sites}
                            </span>
                          {/if}
                          {#if n_elements}
                            <span class="result-detail" title={t('structure.number_of_elements')}>
                              <span class="detail-label">{t('structure.result_elements')}:</span> {n_elements}
                            </span>
                          {/if}
                          {#if chem_system}
                            <span class="result-detail" title={t('structure.chemical_system')}>
                              <span class="detail-label">{t('structure.result_chem')}:</span> {chem_system}
                            </span>
                          {/if}
                          {#if crystal_system}
                            <span class="result-detail" title={t('structure.crystal_system')}>
                              <span class="detail-label">{t('structure.result_crystal')}:</span> {crystal_system}
                            </span>
                          {/if}
                          {#if spacegroup}
                            <span class="result-detail" title={t('structure.space_group_with_number', { number: sg_number ? ` (#${sg_number})` : `` })}>
                              <span class="detail-label">{t('structure.result_sg')}:</span> {spacegroup}
                            </span>
                          {/if}
                          {#if volume}
                            <span class="result-detail" title={t('structure.unit_cell_volume')}>
                              <span class="detail-label">{t('structure.result_vol')}:</span> {volume.toFixed(1)} &#x212B;&sup3;
                            </span>
                          {/if}
                          {#if density}
                            <span class="result-detail" title={t('structure.density_g_cm3')}>
                              <span class="detail-label">{t('structure.result_density')}:</span> {density.toFixed(2)} g/cm³
                            </span>
                          {/if}
                          {#if e_above_hull !== undefined && e_above_hull !== null}
                            <span class="result-detail" class:stable={is_stable || e_above_hull === 0} title={t('structure.energy_above_hull_ev_atom')}>
                              <span class="detail-label">E<sub>hull</sub>:</span> {e_above_hull.toFixed(3)} eV
                            </span>
                          {/if}
                          {#if typeof formation_energy === `number`}
                            <span class="result-detail" title={t('structure.formation_energy_per_atom_ev_atom')}>
                              <span class="detail-label">E<sub>form</sub>:</span> {formation_energy.toFixed(3)} eV/atom
                            </span>
                          {/if}
                          {#if band_gap !== undefined && band_gap !== null}
                            <span class="result-detail" title={t('structure.band_gap_ev')}>
                              <span class="detail-label">{t('structure.result_gap')}:</span> {band_gap.toFixed(2)} eV
                            </span>
                          {/if}
                          {#if is_metal === true}
                            <span class="result-detail" title={t('structure.preview_is_metal')}>
                              <span class="detail-label">{t('structure.preview_metallic')}</span>
                            </span>
                          {/if}
                          {#if typeof efermi === `number`}
                            <span class="result-detail" title={t('structure.preview_efermi')}>
                              <span class="detail-label">E<sub>F</sub>:</span> {efermi.toFixed(2)} eV
                            </span>
                          {/if}
                          {#if typeof cbm === `number`}
                            <span class="result-detail" title={t('structure.preview_cbm')}>
                              <span class="detail-label">CBM:</span> {cbm.toFixed(2)} eV
                            </span>
                          {/if}
                          {#if typeof vbm === `number`}
                            <span class="result-detail" title={t('structure.preview_vbm')}>
                              <span class="detail-label">VBM:</span> {vbm.toFixed(2)} eV
                            </span>
                          {/if}
                          {#if magnetic_ordering}
                            <span class="result-detail" title={t('structure.preview_magnetic_ordering')}>
                              <span class="detail-label">{t('structure.result_mag')}:</span> {magnetic_ordering}
                            </span>
                          {/if}
                          {#if has_dos === true}
                            <span class="result-detail" title={t('structure.preview_dos_available')}>
                              <span class="detail-label">DOS</span>
                            </span>
                          {/if}
                          {#if has_bandstructure === true}
                            <span class="result-detail" title={t('structure.preview_bands_available')}>
                              <span class="detail-label">{t('structure.result_bands')}</span>
                            </span>
                          {/if}
                          {#if !comp && computing_details}
                            <span class="result-detail computing" title={t('structure.computing_symmetry')}>
                              <span class="detail-label">...</span>
                            </span>
                          {/if}
                        </div>
                      </div>
                      {#if formula}
                        <Composition
                          composition={formula}
                          mode="pie"
                          style="height: 50px; width: 50px;"
                        />
                      {/if}
                      <button
                        class="import-btn"
                        onclick={() => handle_import(struct)}
                        disabled={loading_import && selected_result?.id === struct.id}
                      >
                        {#if loading_import && selected_result?.id === struct.id}
                          {t('common.loading')}
                        {:else}
                          <Icon icon="Download" /> {t('common.import')}
                        {/if}
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            {:else if !loading_search}
              <p class="no-results">{t('structure.search_hint')}</p>
            {/if}
          {/if}

          <!-- Pagination (shared for both) -->
          {#if has_results}
            <div class="pagination">
              <button class="page-btn" onclick={go_prev_page} disabled={current_page === 0 || loading_search}>
                &lsaquo; {t('common.prev')}
              </button>
              <span class="page-info">
                {t('common.page')} {current_page + 1}{total_count ? ` ${t('common.of')} ${is_pubchem ? `` : `~`}${Math.ceil(total_count / PAGE_SIZE)}` : ``}
                {#if total_count}
                  <span class="total-count">({total_count} {t('common.total')})</span>
                {/if}
              </span>
              <button class="page-btn" onclick={go_next_page} disabled={!has_more || loading_search}>
                {t('common.next')} &rsaquo;
              </button>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100000010;
    padding: 16px;
    overflow: auto;
    box-sizing: border-box;
  }
  .modal-content {
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: 8px;
    width: min(900px, calc(100vw - 32px));
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    box-sizing: border-box;
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color, #444);
    position: relative;
    z-index: 10;
    min-width: 0;
  }
  .modal-header h2 {
    margin: 0;
    font-size: 1.1rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close-btn {
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: inherit;
    font-size: 20px;
    cursor: pointer;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .close-btn:hover {
    background: var(--surface-bg-hover, #333);
  }
  .modal-body {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .mode-tabs {
    display: flex;
    gap: 6px;
    margin-bottom: 12px;
    padding: 4px;
    background: var(--surface-bg-hover, #2a2a2a);
    border-radius: 999px;
    border: 1px solid var(--border-color, #444);
    width: fit-content;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .mode-tab {
    padding: 6px 16px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--text-color-muted, #aaa);
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .mode-tab:hover:not(.active) {
    color: inherit;
    background: rgba(255, 255, 255, 0.05);
  }
  .mode-tab.active {
    background: var(--accent-color, #3b82f6);
    color: white;
    font-weight: 500;
  }
  .clear-link {
    margin-left: 6px;
    background: none;
    border: none;
    color: var(--accent-color, #3b82f6);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0;
    text-decoration: underline;
  }
  .periodic-table-section {
    margin-bottom: 16px;
    padding: 12px;
    border: 1px solid var(--border-color, #444);
    border-radius: 6px;
    background: var(--surface-bg-hover, #2a2a2a);
    position: relative;
    z-index: 1;
    overflow: hidden;
  }
  .periodic-table-section .pt-hint {
    margin: 0 0 10px;
    font-size: 0.9rem;
    color: var(--text-color-muted, #999);
  }
  .provider-section {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .provider-section select {
    flex: 1;
    max-width: 300px;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--surface-bg, #1e1e1e);
    color: inherit;
  }
  .loading-text {
    color: var(--text-color-muted, #999);
    font-size: 0.85rem;
  }
  .error-text {
    color: #ff6b6b;
    font-size: 0.85rem;
  }
  .retry-btn {
    padding: 4px 10px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--surface-bg, #1e1e1e);
    color: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .retry-btn:hover {
    background: var(--surface-bg-hover, #333);
  }
  .api-key-section {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding: 8px 12px;
    background: var(--surface-bg-hover, #2a2a2a);
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .api-key-input-row {
    display: flex;
    gap: 8px;
    width: 100%;
    min-width: 0;
  }
  .api-key-input-row input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--surface-bg, #1e1e1e);
    color: inherit;
    font-size: 0.85rem;
  }
  .api-key-btn {
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .api-key-btn.save {
    background: var(--accent-color, #0066cc);
    color: white;
  }
  .api-key-btn.cancel {
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    color: inherit;
  }
  .api-key-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .api-key-error {
    color: #ff6b6b;
    width: 100%;
  }
  .api-key-hint {
    color: var(--text-color-muted, #999);
    width: 100%;
  }
  .api-key-hint a {
    color: var(--accent-color, #0066cc);
  }
  .api-key-status {
    color: var(--text-color-muted, #999);
  }
  .api-key-status.success {
    color: #4ade80;
  }
  .api-key-link {
    background: none;
    border: none;
    color: var(--accent-color, #0066cc);
    cursor: pointer;
    padding: 0;
    font-size: 0.85rem;
    text-decoration: underline;
  }
  .api-key-link:hover {
    opacity: 0.8;
  }
  .search-section {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .search-field {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .search-field label {
    font-size: 0.9rem;
    white-space: nowrap;
  }
  .search-field input {
    padding: 6px 10px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--surface-bg, #1e1e1e);
    color: inherit;
    width: 150px;
    min-width: 0;
  }
  .search-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--accent-color, #0066cc);
    color: white;
    cursor: pointer;
  }
  .search-btn:hover:not(:disabled) {
    opacity: 0.9;
  }
  .search-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .error-message {
    color: #ff6b6b;
    margin-bottom: 12px;
  }
  .results-section {
    min-height: 300px;
    min-width: 0;
  }
  .results-section h3 {
    margin: 0 0 10px;
    font-size: 0.95rem;
  }
  .results-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .result-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: transparent;
  }
  .result-item:hover {
    background: var(--surface-bg-hover, #333);
  }
  .result-item.selected {
    border-color: var(--accent-color, #0066cc);
    background: var(--surface-bg-hover, #333);
  }
  .result-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .result-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  .result-id {
    font-family: monospace;
    font-size: 0.85rem;
    color: var(--text-color-muted, #999);
  }
  .result-formula {
    font-size: 1rem;
    font-weight: 500;
  }
  .result-name {
    font-size: 0.85rem;
    color: var(--text-color-muted, #aaa);
    font-style: italic;
  }
  .result-details {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    font-size: 0.8rem;
  }
  .result-detail {
    color: var(--text-color-muted, #999);
    white-space: nowrap;
  }
  .result-detail.stable {
    color: #4ade80;
  }
  .result-detail.computing {
    font-style: italic;
    opacity: 0.6;
  }
  .detail-label {
    color: var(--text-color-muted, #777);
  }
  .no-results {
    color: var(--text-color-muted, #999);
    text-align: center;
    padding: 20px;
  }
  .import-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    background: var(--accent-color, #0066cc);
    color: white;
    font-size: 0.85rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .import-btn:hover:not(:disabled) {
    opacity: 0.9;
  }
  .import-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 12px 0 4px;
    border-top: 1px solid var(--border-color, #444);
    margin-top: 8px;
  }
  .page-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--surface-bg, #1e1e1e);
    color: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .page-btn:hover:not(:disabled) {
    background: var(--surface-bg-hover, #333);
  }
  .page-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .page-info {
    font-size: 0.85rem;
    color: var(--text-color-muted, #999);
  }
  .total-count {
    font-size: 0.8rem;
    color: var(--text-color-muted, #777);
  }
</style>

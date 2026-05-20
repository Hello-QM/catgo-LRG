<script lang="ts">
  import { Icon, PeriodicTable } from '$lib'
  import type { PubChemSearchCompound, PubChemSearchResponse, PubChemCompound } from '$lib/api/pubchem'
  import {
    fetch_pubchem_compound,
    search_pubchem_compounds,
    autocomplete_pubchem,
  } from '$lib/api/pubchem'
  import { get_electro_neg_formula } from '$lib/composition/parse'
  import type { PymatgenStructure } from './index'
  import { pubchem_to_pymatgen } from './parse'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  interface Props {
    visible: boolean
    onclose: () => void
    onimport: (structure: PymatgenStructure) => void
    onpreview?: (
      compound: PubChemCompound,
      search_result: PubChemSearchCompound | null,
      structure: PymatgenStructure,
    ) => void
  }
  let { visible, onclose, onimport, onpreview }: Props = $props()

  // ── Search state ──────────────────────────────────────────
  let search_input = $state(``)
  let selected_elements = $state<string[]>([])
  let search_results = $state<PubChemSearchResponse | null>(null)
  let loading_search = $state(false)
  let loading_import = $state<number | null>(null) // CID being imported
  let search_error = $state<string | null>(null)
  let modal_element = $state<HTMLDivElement | null>(null)

  // ── Autocomplete state ────────────────────────────────────
  let autocomplete_list = $state<string[]>([])
  let show_autocomplete = $state(false)
  let autocomplete_timer: ReturnType<typeof setTimeout> | null = null
  let search_input_el = $state<HTMLInputElement | null>(null)

  // ── Periodic table toggle ─────────────────────────────────
  let show_periodic_table = $state(false)

  // ── Pagination ────────────────────────────────────────────
  const PAGE_SIZE = 20
  let current_page = $state(0)

  // Common elements for the quick-pick grid
  const COMMON_ELEMENTS = [
    `H`, `C`, `N`, `O`, `S`, `P`, `F`, `Cl`, `Br`, `I`,
    `Li`, `Na`, `K`, `Mg`, `Ca`, `Al`, `Si`, `Ti`, `Mn`, `Cr`,
    `Fe`, `Co`, `Ni`, `Cu`, `Zn`, `Mo`, `W`, `Ru`, `Pd`, `V`,
    `Pt`, `Au`, `Ag`, `Ir`, `Rh`, `Re`, `Os`, `Sn`, `Pb`, `Bi`,
  ]

  // ── Autocomplete logic ────────────────────────────────────
  function on_input(e: Event) {
    search_input = (e.target as HTMLInputElement).value
    if (autocomplete_timer) clearTimeout(autocomplete_timer)
    if (search_input.length < 2) {
      autocomplete_list = []
      show_autocomplete = false
      return
    }
    autocomplete_timer = setTimeout(async () => {
      autocomplete_list = await autocomplete_pubchem(search_input)
      show_autocomplete = autocomplete_list.length > 0
    }, 280)
  }

  function pick_autocomplete(term: string) {
    search_input = term
    show_autocomplete = false
    autocomplete_list = []
    do_search(0)
  }

  // ── Element helpers ───────────────────────────────────────
  function toggle_element(symbol: string) {
    if (selected_elements.includes(symbol)) {
      selected_elements = selected_elements.filter((e) => e !== symbol)
    } else {
      selected_elements = [...selected_elements, symbol]
    }
  }

  function clear_elements() {
    selected_elements = []
  }

  function formula_has_selected(formula: string): boolean {
    if (selected_elements.length === 0) return true
    const found = new Set(formula.match(/[A-Z][a-z]?/g) ?? [])
    return selected_elements.every((el) => found.has(el))
  }

  // ── Search ────────────────────────────────────────────────
  async function do_search(page = 0) {
    const has_text = search_input.trim().length > 0
    const has_elements = selected_elements.length > 0
    if (!has_text && !has_elements) return

    loading_search = true
    search_error = null
    search_results = null
    current_page = page
    show_autocomplete = false

    const offset = page * PAGE_SIZE

    try {
      const results = await search_pubchem_compounds(
        has_text ? search_input.trim() : undefined,
        has_elements ? selected_elements : undefined,
        PAGE_SIZE,
        offset,
      )

      // Client-side element filter when searching by text + elements
      if (has_text && has_elements) {
        results.compounds = results.compounds.filter((c) =>
          formula_has_selected(c.formula ?? ``),
        )
      }

      search_results = results
      if (results.compounds.length === 0 && page === 0) {
        const what = has_text ? `"${search_input}"` : selected_elements.join(`, `)
        search_error = `${t('structure.no_compounds_found')} ${what}`
      }
    } catch (err) {
      search_error = `Search failed: ${err instanceof Error ? err.message : String(err)}`
    }
    loading_search = false
  }

  async function handle_import(cid: number) {
    loading_import = cid
    search_error = null
    try {
      const compound = await fetch_pubchem_compound(cid)
      if (compound) {
        const structure = pubchem_to_pymatgen(compound)
        if (structure) {
          if (onpreview) {
            const search_result = search_results?.compounds.find((c) => c.cid === cid) ?? null
            onpreview(compound, search_result, structure)
            // Keep modal open; parent decides whether to close on confirm/cancel.
          } else {
            onimport(structure)
            onclose()
          }
          return
        }
      }
      search_error = `Failed to convert compound ${cid}`
    } catch (err) {
      search_error = `Import failed: ${err instanceof Error ? err.message : String(err)}`
    }
    loading_import = null
  }

  // ── Pagination ────────────────────────────────────────────
  function prev_page() {
    if (current_page > 0) do_search(current_page - 1)
  }
  function next_page() {
    if (search_results?.has_more) do_search(current_page + 1)
  }

  // ── Keyboard & click-outside ──────────────────────────────
  function handle_keydown(event: KeyboardEvent) {
    if (loading_search || loading_import !== null) return
    if (!visible) return
    if (event.key === `Escape`) {
      if (show_autocomplete) {
        show_autocomplete = false
        event.stopPropagation()
      } else {
        onclose()
      }
    }
  }

  function handle_overlay_click(event: MouseEvent) {
    if (loading_search || loading_import !== null) return
    if (modal_element && !modal_element.contains(event.target as HTMLElement)) onclose()
  }

  const total_pages = $derived(
    search_results?.total_count ? Math.ceil(search_results.total_count / PAGE_SIZE) : null,
  )
</script>

<svelte:window onkeydown={handle_keydown} />

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="overlay" onclick={handle_overlay_click}>
    <div class="modal" bind:this={modal_element} role="dialog" aria-modal="true">

      <!-- Header -->
      <div class="header">
        <h2>{t('structure.search_pubchem')}</h2>
        <button class="close-btn" onclick={onclose} aria-label={t('common.close')}>×</button>
      </div>

      <div class="body">

        <!-- Search bar -->
        <div class="search-row">
          <div class="search-wrap">
            <span class="search-icon"><Icon icon="Search" /></span>
            <input
              bind:this={search_input_el}
              class="search-input"
              type="text"
              placeholder={t('structure.pubchem_search_placeholder')}
              value={search_input}
              oninput={on_input}
              onkeydown={(e) => {
                if (e.key === `Enter`) do_search(0)
                if (e.key === `ArrowDown` && show_autocomplete) {
                  e.preventDefault()
                  ;(document.querySelector(`.autocomplete-item`) as HTMLElement)?.focus()
                }
              }}
              onfocus={() => { if (autocomplete_list.length) show_autocomplete = true }}
            />
            {#if search_input}
              <button class="clear-input" onclick={() => { search_input = ``; show_autocomplete = false }}>×</button>
            {/if}

            {#if show_autocomplete}
              <ul class="autocomplete-list" role="listbox">
                {#each autocomplete_list as suggestion}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <li
                    class="autocomplete-item"
                    role="option"
                    aria-selected="false"
                    tabindex="0"
                    onclick={() => pick_autocomplete(suggestion)}
                    onkeydown={(e) => e.key === `Enter` && pick_autocomplete(suggestion)}
                  >{suggestion}</li>
                {/each}
              </ul>
            {/if}
          </div>

          <button
            class="search-btn"
            onclick={() => do_search(0)}
            disabled={loading_search || (!search_input.trim() && selected_elements.length === 0)}
          >
            {loading_search ? `…` : t('common.search')}
          </button>
        </div>

        <!-- Element filter -->
        <div class="element-section">
          <div class="element-header">
            <span class="section-label">{t('structure.element_filter')}</span>
            {#if selected_elements.length > 0}
              <div class="selected-chips">
                {#each selected_elements as el}
                  <button class="chip selected" onclick={() => toggle_element(el)}>
                    {el} <span class="chip-x">×</span>
                  </button>
                {/each}
                <button class="clear-link" onclick={clear_elements}>{t('common.clear_all')}</button>
              </div>
            {/if}
          </div>

          <!-- Common element grid -->
          <div class="element-grid">
            {#each COMMON_ELEMENTS as el}
              <button
                class="el-btn"
                class:active={selected_elements.includes(el)}
                onclick={() => { toggle_element(el); if (!search_input.trim()) do_search(0) }}
                title={el}
              >{el}</button>
            {/each}
            <button
              class="el-btn more-btn"
              class:active={show_periodic_table}
              onclick={() => { show_periodic_table = !show_periodic_table }}
              title={t('structure.show_full_pt')}
            >···</button>
          </div>

          {#if show_periodic_table}
            <div class="periodic-wrap">
              <PeriodicTable
                tile_props={{
                  onclick: ({ element }) => {
                    toggle_element(element.symbol)
                    if (!search_input.trim()) do_search(0)
                  },
                }}
                style="max-width: 100%; font-size: 0.5em;"
              />
            </div>
          {/if}
        </div>

        <!-- Error -->
        {#if search_error}
          <div class="error">{search_error}</div>
        {/if}

        <!-- Results -->
        {#if search_results}
          <div class="results-header">
            <span class="results-count">
              {search_results.total_count ?? search_results.compounds.length} {t('structure.results_count_label')}
            </span>
            {#if total_pages && total_pages > 1}
              <div class="pagination">
                <button class="page-btn" onclick={prev_page} disabled={current_page === 0 || loading_search}>‹</button>
                <span class="page-label">{t('structure.page_of_total', { current: current_page + 1, total: total_pages ?? current_page + 1 })}</span>
                <button class="page-btn" onclick={next_page} disabled={!search_results.has_more || loading_search}>›</button>
              </div>
            {/if}
          </div>

          <div class="results-list">
            {#if search_results.compounds.length === 0}
              <p class="empty">{t('structure.no_compounds_found')}</p>
            {:else}
              {#each search_results.compounds as c (c.cid)}
                <div class="result-row">
                  <div class="result-main">
                    <div class="result-top">
                      <span class="result-formula">{@html get_electro_neg_formula(c.formula ?? ``)}</span>
                      {#if c.name}
                        <span class="result-name">{c.name}</span>
                      {/if}
                    </div>
                    <div class="result-meta">
                      <span class="meta-cid">CID {c.cid}</span>
                      {#if c.weight}
                        <span class="meta-item">{typeof c.weight === `number` ? c.weight.toFixed(2) : c.weight} g/mol</span>
                      {/if}
                      {#if c.HeavyAtomCount !== undefined}
                        <span class="meta-item">{c.HeavyAtomCount} {t('structure.atoms')}</span>
                      {/if}
                      {#if c.XLogP !== undefined && c.XLogP !== null}
                        <span class="meta-item" title={t('structure.lipophilicity')}>logP {c.XLogP}</span>
                      {/if}
                    </div>
                  </div>
                  <button
                    class="import-btn"
                    onclick={() => handle_import(c.cid)}
                    disabled={loading_import !== null}
                    title={t('structure.import_into_viewer')}
                  >
                    {#if loading_import === c.cid}
                      <span class="spinner"></span>
                    {:else}
                      <Icon icon="Download" />
                    {/if}
                  </button>
                </div>
              {/each}
            {/if}
          </div>

          <!-- Bottom pagination -->
          {#if search_results.compounds.length > 0 && (search_results.has_more || current_page > 0)}
            <div class="pagination bottom-pag">
              <button class="page-btn" onclick={prev_page} disabled={current_page === 0 || loading_search}>‹ {t('common.prev')}</button>
              <span class="page-label">{t('structure.page_of_total', { current: current_page + 1, total: total_pages ?? current_page + 1 })}</span>
              <button class="page-btn" onclick={next_page} disabled={!search_results.has_more || loading_search}>{t('common.next')} ›</button>
            </div>
          {/if}
        {:else if !loading_search}
          <p class="hint">{t('structure.type_name_formula')}</p>
        {:else}
          <div class="loading-state">
            <span class="spinner large"></span>
            <span>{t('structure.searching_pubchem')}</span>
          </div>
        {/if}

      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100000010;
  }

  .modal {
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #3a3a3a);
    border-radius: 10px;
    width: min(92vw, 820px);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color, #3a3a3a);
    flex-shrink: 0;
  }
  .header h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  .close-btn {
    width: 26px; height: 26px;
    border: none; background: transparent;
    color: inherit; font-size: 18px;
    cursor: pointer; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
  }
  .close-btn:hover { background: var(--surface-bg-hover, #333); }

  /* ── Body ── */
  .body {
    padding: 14px 16px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* ── Search row ── */
  .search-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .search-wrap {
    position: relative;
    flex: 1;
  }
  .search-icon {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    opacity: 0.4;
    pointer-events: none;
    font-size: 0.9em;
    display: flex;
  }
  .search-input {
    width: 100%;
    padding: 8px 32px 8px 34px;
    border: 1px solid var(--border-color, #3a3a3a);
    border-radius: 6px;
    background: var(--surface-bg-hover, #2a2a2a);
    color: inherit;
    font-size: 0.9rem;
    outline: none;
    box-sizing: border-box;
  }
  .search-input:focus { border-color: var(--accent-color, #0066cc); }
  .clear-input {
    position: absolute;
    right: 8px; top: 50%;
    transform: translateY(-50%);
    border: none; background: transparent;
    color: inherit; opacity: 0.4;
    cursor: pointer; font-size: 16px;
    padding: 0 2px;
  }
  .clear-input:hover { opacity: 0.8; }

  /* Autocomplete */
  .autocomplete-list {
    position: absolute;
    top: calc(100% + 4px);
    left: 0; right: 0;
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #3a3a3a);
    border-radius: 6px;
    list-style: none;
    margin: 0; padding: 4px 0;
    z-index: 10;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    max-height: 220px;
    overflow-y: auto;
  }
  .autocomplete-item {
    padding: 7px 12px;
    cursor: pointer;
    font-size: 0.88rem;
  }
  .autocomplete-item:hover,
  .autocomplete-item:focus {
    background: var(--surface-bg-hover, #333);
    outline: none;
  }

  .search-btn {
    padding: 8px 16px;
    border: 1px solid var(--accent-color, #0066cc);
    border-radius: 6px;
    background: var(--accent-color, #0066cc);
    color: white;
    font-size: 0.9rem;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .search-btn:hover:not(:disabled) { filter: brightness(1.12); }
  .search-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Element section ── */
  .element-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .element-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .section-label {
    font-size: 0.8rem;
    opacity: 0.55;
    white-space: nowrap;
  }
  .selected-chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    align-items: center;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 7px;
    border-radius: 12px;
    font-size: 0.78rem;
    font-weight: 500;
    border: 1px solid;
    cursor: pointer;
  }
  .chip.selected {
    background: rgba(0, 102, 204, 0.2);
    border-color: var(--accent-color, #0066cc);
    color: var(--accent-color, #4da6ff);
  }
  .chip-x { opacity: 0.6; font-size: 0.85em; }
  .clear-link {
    border: none; background: transparent;
    color: inherit; opacity: 0.45;
    font-size: 0.78rem; cursor: pointer;
    padding: 2px 4px;
  }
  .clear-link:hover { opacity: 0.8; }

  /* Element grid */
  .element-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .el-btn {
    min-width: 32px;
    padding: 3px 6px;
    border: 1px solid var(--border-color, #3a3a3a);
    border-radius: 4px;
    background: var(--surface-bg-hover, #2a2a2a);
    color: inherit;
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    text-align: center;
    transition: border-color 0.1s, background 0.1s;
  }
  .el-btn:hover { border-color: var(--accent-color, #0066cc); }
  .el-btn.active {
    background: rgba(0, 102, 204, 0.25);
    border-color: var(--accent-color, #0066cc);
    color: var(--accent-color, #4da6ff);
  }
  .more-btn { letter-spacing: 1px; opacity: 0.6; }
  .more-btn.active { opacity: 1; }

  .periodic-wrap {
    border: 1px solid var(--border-color, #3a3a3a);
    border-radius: 6px;
    padding: 8px;
    background: var(--surface-bg-hover, #2a2a2a);
    overflow: hidden;
  }

  /* ── Error ── */
  .error {
    padding: 8px 10px;
    border-radius: 5px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.25);
    color: #fca5a5;
    font-size: 0.85rem;
  }

  /* ── Results ── */
  .results-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .results-count {
    font-size: 0.82rem;
    opacity: 0.55;
  }

  .results-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .result-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border: 1px solid var(--border-color, #3a3a3a);
    border-radius: 6px;
    background: var(--surface-bg-hover, #252525);
    transition: border-color 0.1s;
  }
  .result-row:hover { border-color: rgba(255, 255, 255, 0.2); }
  .result-main { flex: 1; min-width: 0; }
  .result-top {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 3px;
  }
  .result-formula { font-size: 1rem; font-weight: 600; }
  .result-name {
    font-size: 0.82rem;
    opacity: 0.55;
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 280px;
  }
  .result-meta {
    display: flex;
    gap: 10px;
    font-size: 0.75rem;
    opacity: 0.45;
  }
  .meta-cid { font-family: monospace; }

  .import-btn {
    padding: 5px 10px;
    border: 1px solid var(--border-color, #3a3a3a);
    border-radius: 5px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.82rem;
    flex-shrink: 0;
    transition: border-color 0.1s, background 0.1s;
  }
  .import-btn:hover:not(:disabled) {
    border-color: var(--accent-color, #0066cc);
    background: rgba(0, 102, 204, 0.1);
  }
  .import-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Pagination ── */
  .pagination {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .bottom-pag {
    justify-content: center;
    padding-top: 8px;
    border-top: 1px solid var(--border-color, #3a3a3a);
  }
  .page-btn {
    padding: 4px 10px;
    border: 1px solid var(--border-color, #3a3a3a);
    border-radius: 4px;
    background: var(--surface-bg-hover, #2a2a2a);
    color: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .page-btn:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.3); }
  .page-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .page-label { font-size: 0.82rem; opacity: 0.5; }

  /* ── States ── */
  .hint {
    text-align: center;
    opacity: 0.35;
    font-size: 0.85rem;
    padding: 24px 0;
  }
  .empty {
    text-align: center;
    opacity: 0.45;
    font-size: 0.85rem;
    padding: 20px 0;
  }
  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px 0;
    opacity: 0.5;
    font-size: 0.85rem;
  }

  /* Spinner */
  .spinner {
    display: inline-block;
    width: 14px; height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: rgba(255, 255, 255, 0.7);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  .spinner.large { width: 20px; height: 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>

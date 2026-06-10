<!--
  ResultTablePanel -- Post-execution results comparison table for high-throughput screening.

  Displays the output of an Aggregate & Filter node as a sortable, filterable
  data table with inline bar charts. Users can toggle column visibility, apply
  live client-side filters, view individual structures in the 3D viewer, export
  results as CSV or JSON, and quickly compare candidates visually.

  Filtered-out candidates are shown in a grayed-out style, and failed branches
  can be toggled on/off. The sort_by column renders inline horizontal bars for
  at-a-glance comparison of numeric values.

  @example
  <ResultTablePanel
    bind:show={show_results}
    results={aggregate_output}
    on_view_structure={(json) => load_in_viewer(json)}
  />
-->
<script lang="ts">
  import '$lib/dialog-shared.css'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  /**
   * A single candidate result from the Aggregate node output.
   */
  export interface CandidateResult {
    /** 0-based index */
    index: number
    /** Human-readable label (e.g. "Cu-Ti") */
    label: string
    /** Whether this candidate passed the filter expression */
    passed_filter: boolean
    /** Whether this branch failed during execution */
    failed: boolean
    /** Computed properties keyed by name (energy_per_atom, band_gap, etc.) */
    properties: Record<string, number | string | null>
    /** Serialized structure JSON for 3D viewer */
    structure_json?: string
  }

  /**
   * Full aggregate result from the Aggregate & Filter node.
   */
  export interface AggregateResult {
    /** All candidate results (passed and filtered-out) */
    candidates: CandidateResult[]
    /** The filter expression that was applied (e.g. "band_gap > 1.5") */
    filter_expression: string
    /** Property used for sorting */
    sort_by: string
    /** Sort direction ("ascending" or "descending") */
    sort_order: string
    /** Total number of candidates before filtering */
    total_count: number
    /** Number of candidates that passed the filter */
    filtered_count: number
    /** Summary statistics per numeric property */
    summary: Record<string, { min: number; max: number; mean: number; std: number }>
  }

  /**
   * Props for ResultTablePanel.
   *
   * @prop show - Bindable boolean controlling panel visibility.
   * @prop results - The aggregate result data from the Aggregate node.
   * @prop on_view_structure - Callback when user clicks "[View]" on a candidate row.
   */
  let {
    show = $bindable(false),
    results,
    on_view_structure,
  }: {
    /** Controls panel visibility (bindable). */
    show: boolean
    /** Aggregate result data from the Aggregate & Filter node. */
    results: AggregateResult
    /** Called when user clicks View on a candidate to load its structure. */
    on_view_structure?: (structure_json: string) => void
  } = $props()

  // ─── Column management ───
  /** Discover all unique property keys across candidates */
  const all_property_keys = $derived.by(() => {
    const keys = new Set<string>()
    for (const c of results.candidates) {
      for (const k of Object.keys(c.properties)) {
        keys.add(k)
      }
    }
    return [...keys]
  })

  /** Which columns are currently visible (user can toggle) */
  let visible_columns = $state(new Set<string>())

  // Initialize visible columns when results change
  $effect(() => {
    // Show all columns by default
    visible_columns = new Set(all_property_keys)
  })

  /** Toggle column visibility */
  function toggle_column(key: string) {
    const next = new Set(visible_columns)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    visible_columns = next
  }

  // ─── Show/hide toggles ───
  let show_failed = $state(false)
  let show_filtered_out = $state(false)
  let show_columns_picker = $state(false)

  // ─── Client-side filter ───
  /** User-entered filter expression for live re-filtering */
  let filter_input = $state('')

  // ─── Sort state ───
  type SortCol = 'index' | 'label' | string
  let sort_col = $state<SortCol>('')
  let sort_asc = $state(true)

  // Initialize sort from results
  $effect(() => {
    sort_col = results.sort_by || 'index'
    sort_asc = results.sort_order === 'ascending'
  })

  /** Toggle sort on a column */
  function toggle_sort(col: SortCol) {
    if (sort_col === col) {
      sort_asc = !sort_asc
    } else {
      sort_col = col
      sort_asc = true
    }
  }

  /** Sort indicator */
  function sort_arrow(col: SortCol): string {
    if (sort_col !== col) return ''
    return sort_asc ? ' \u2191' : ' \u2193'
  }

  // ─── Derived: filtered + sorted candidates ───
  const display_candidates = $derived.by(() => {
    let arr = [...results.candidates]

    // Filter out failed unless toggled
    if (!show_failed) {
      arr = arr.filter(c => !c.failed)
    }

    // Filter out non-passing unless toggled
    if (!show_filtered_out) {
      arr = arr.filter(c => c.passed_filter || c.failed)
    }

    // Apply client-side filter expression
    if (filter_input.trim()) {
      arr = arr.filter(c => apply_client_filter(c, filter_input.trim()))
    }

    // Sort
    const dir = sort_asc ? 1 : -1
    arr.sort((a, b) => {
      if (sort_col === 'index') return (a.index - b.index) * dir
      if (sort_col === 'label') return a.label.localeCompare(b.label) * dir
      // Sort by property value
      const va = numeric_val(a.properties[sort_col])
      const vb = numeric_val(b.properties[sort_col])
      return (va - vb) * dir
    })

    return arr
  })

  /**
   * Apply a simple client-side filter expression.
   * Supports: "prop > N", "prop < N", "prop >= N", "prop <= N", "prop == N"
   * Multiple conditions can be joined with "and".
   */
  function apply_client_filter(c: CandidateResult, expr: string): boolean {
    const conditions = expr.split(/\s+and\s+/i)
    for (const cond of conditions) {
      const match = cond.trim().match(/^(\w+)\s*(>=|<=|>|<|==|!=)\s*(-?[\d.]+)$/)
      if (!match) continue
      const [, key, op, val_str] = match
      const prop_val = numeric_val(c.properties[key])
      const cmp_val = parseFloat(val_str)
      if (!isFinite(prop_val) || !isFinite(cmp_val)) return false
      switch (op) {
        case '>':  if (!(prop_val > cmp_val)) return false; break
        case '<':  if (!(prop_val < cmp_val)) return false; break
        case '>=': if (!(prop_val >= cmp_val)) return false; break
        case '<=': if (!(prop_val <= cmp_val)) return false; break
        case '==': if (!(Math.abs(prop_val - cmp_val) < 1e-9)) return false; break
        case '!=': if (!(Math.abs(prop_val - cmp_val) >= 1e-9)) return false; break
      }
    }
    return true
  }

  /** Extract numeric value or Infinity for non-numeric */
  function numeric_val(v: unknown): number {
    if (v == null) return Infinity
    if (typeof v === 'number') return v
    const n = parseFloat(String(v))
    return isFinite(n) ? n : Infinity
  }

  // ─── Bar chart helpers ───
  /** Range for the sort_by column to render inline bars */
  const bar_range = $derived.by(() => {
    let min = Infinity, max = -Infinity
    for (const c of results.candidates) {
      const v = numeric_val(c.properties[sort_col])
      if (isFinite(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    return { min, max, span: max - min || 1 }
  })

  /** Compute bar width percentage for a given value */
  function bar_width(val: unknown): number {
    const v = numeric_val(val)
    if (!isFinite(v)) return 0
    return Math.max(2, ((v - bar_range.min) / bar_range.span) * 100)
  }

  // ─── Formatting ───
  function fmt_prop(val: unknown): string {
    if (val == null) return '\u2014'
    if (typeof val === 'number') return val.toFixed(4)
    return String(val)
  }

  /** Human-readable column header */
  function col_label(key: string): string {
    return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }

  // ─── Export functions ───
  function export_csv() {
    const cols = all_property_keys.filter(k => visible_columns.has(k))
    const header = ['#', 'Label', 'Passed', ...cols.map(col_label)]
    const rows = display_candidates.map(c => [
      c.index.toString(),
      c.label,
      c.passed_filter ? 'yes' : 'no',
      ...cols.map(k => c.properties[k] != null ? String(c.properties[k]) : ''),
    ])
    const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    download_blob(csv, 'text/csv', 'results.csv')
  }

  function export_json() {
    const json = JSON.stringify({
      candidates: display_candidates,
      filter_expression: results.filter_expression,
      sort_by: results.sort_by,
      summary: results.summary,
    }, null, 2)
    download_blob(json, 'application/json', 'results.json')
  }

  /** Helper to trigger a download from a string blob */
  function download_blob(content: string, mime: string, filename: string) {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  /** Open top N structures in the viewer */
  function open_top_n(n: number) {
    const top = display_candidates.filter(c => c.structure_json).slice(0, n)
    for (const c of top) {
      on_view_structure?.(c.structure_json!)
    }
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="dialog-backdrop" onclick={(e: MouseEvent) => { if (e.target === e.currentTarget) show = false }}>
    <div class="dialog-modal result-panel" role="dialog" aria-label={t('workflow.result_panel_title')}>
      <!-- Header -->
      <div class="modal-header">
        <h2 class="modal-title">{t('workflow.result_panel_title')}</h2>
        <button class="close-btn" onclick={() => (show = false)}>&times;</button>
      </div>

      <!-- Summary line -->
      <div class="summary-section">
        <div class="summary-line">
          <span class="summary-total">{t('workflow.result_panel_candidates', { n: results.total_count })}</span>
          <span class="summary-arrow">&rarr;</span>
          <span class="summary-filtered">{t('workflow.result_panel_passed', { n: results.filtered_count })}</span>
          {#if results.filter_expression}
            <span class="summary-expr">({results.filter_expression})</span>
          {/if}
        </div>

        <!-- Toggles and filter -->
        <div class="controls-row">
          <label class="toggle-label">
            <input type="checkbox" bind:checked={show_failed} />
            {t('workflow.result_panel_show_failed')}
          </label>
          <label class="toggle-label">
            <input type="checkbox" bind:checked={show_filtered_out} />
            {t('workflow.result_panel_show_filtered_out')}
          </label>
          <button
            class="columns-btn"
            onclick={() => (show_columns_picker = !show_columns_picker)}
          >
            {t('workflow.result_panel_columns')} {show_columns_picker ? '\u25B2' : '\u25BC'}
          </button>
        </div>

        <!-- Column visibility picker (dropdown) -->
        {#if show_columns_picker}
          <div class="columns-picker">
            {#each all_property_keys as key}
              <label class="col-toggle">
                <input
                  type="checkbox"
                  checked={visible_columns.has(key)}
                  onchange={() => toggle_column(key)}
                />
                {col_label(key)}
              </label>
            {/each}
          </div>
        {/if}

        <!-- Filter input -->
        <div class="filter-row">
          <span class="filter-label">{t('workflow.result_panel_filter')}:</span>
          <input
            type="text"
            class="filter-input"
            placeholder={t('workflow.result_panel_filter_placeholder')}
            bind:value={filter_input}
          />
        </div>
      </div>

      <!-- Data table -->
      <div class="modal-body">
        <table class="result-table">
          <thead>
            <tr>
              <th class="sortable" onclick={() => toggle_sort('index')}>#{sort_arrow('index')}</th>
              <th class="sortable" onclick={() => toggle_sort('label')}>{t('common.label')}{sort_arrow('label')}</th>
              {#each all_property_keys.filter(k => visible_columns.has(k)) as key}
                <th class="sortable" onclick={() => toggle_sort(key)}>
                  {col_label(key)}{sort_arrow(key)}
                </th>
              {/each}
              <th class="col-action">{t('workflow.result_panel_view')}</th>
            </tr>
          </thead>
          <tbody>
            {#each display_candidates as cand (cand.index)}
              <tr
                class="result-row"
                class:filtered-out={!cand.passed_filter && !cand.failed}
                class:failed-row={cand.failed}
              >
                <td class="col-idx">{cand.index + 1}</td>
                <td class="col-lbl" title={cand.label}>{cand.label}</td>
                {#each all_property_keys.filter(k => visible_columns.has(k)) as key}
                  <td class="col-val">
                    <div class="val-cell">
                      <!-- Show inline bar for the sort column -->
                      {#if key === sort_col && typeof cand.properties[key] === 'number'}
                        <div class="bar-container">
                          <div
                            class="bar-fill"
                            class:bar-passed={cand.passed_filter}
                            class:bar-failed={cand.failed}
                            style:width="{bar_width(cand.properties[key])}%"
                          ></div>
                        </div>
                      {/if}
                      <span class="val-text">{fmt_prop(cand.properties[key])}</span>
                    </div>
                  </td>
                {/each}
                <td class="col-action">
                  {#if cand.structure_json && on_view_structure}
                    <button
                      class="view-btn"
                      onclick={() => on_view_structure?.(cand.structure_json!)}
                    >{t('workflow.result_panel_view')}</button>
                  {:else}
                    <span class="no-structure">\u2014</span>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if display_candidates.length === 0}
              <tr>
                <td colspan={all_property_keys.filter(k => visible_columns.has(k)).length + 3} class="empty-msg">
                  {t('workflow.result_panel_no_candidates')}
                </td>
              </tr>
            {/if}
          </tbody>
        </table>

        <!-- Inline bar chart section for sort column -->
        {#if results.summary[sort_col]}
          <div class="stats-section">
            <div class="stats-title">{t('workflow.result_panel_statistics', { column: col_label(sort_col) })}</div>
            <div class="stats-row">
              <span>Min: {results.summary[sort_col].min.toFixed(4)}</span>
              <span>Max: {results.summary[sort_col].max.toFixed(4)}</span>
              <span>Mean: {results.summary[sort_col].mean.toFixed(4)}</span>
              <span>Std: {results.summary[sort_col].std.toFixed(4)}</span>
            </div>
          </div>
        {/if}
      </div>

      <!-- Footer actions -->
      <div class="panel-footer">
        <button class="btn-action" onclick={export_csv}>{t('workflow.result_panel_export_csv')}</button>
        <button class="btn-action" onclick={export_json}>{t('workflow.result_panel_export_json')}</button>
        <button
          class="btn-action btn-primary-action"
          onclick={() => open_top_n(5)}
          disabled={display_candidates.filter(c => c.structure_json).length === 0}
        >
          {t('workflow.result_panel_open_top', { n: 5 })}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .result-panel {
    width: min(900px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    min-width: 0;
  }

  /* Summary section */
  .summary-section {
    padding: 12px 20px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    min-width: 0;
    flex-shrink: 0;
  }

  .summary-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    margin-bottom: 10px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .summary-total {
    font-weight: 600;
  }

  .summary-arrow {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }

  .summary-filtered {
    font-weight: 600;
    color: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
  }

  .summary-expr {
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .controls-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
  }

  .toggle-label input[type="checkbox"] {
    width: auto;
    margin: 0;
  }

  .columns-btn {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
    font-size: 11px;
    padding: 3px 8px;
    font-family: inherit;
  }
  .columns-btn:hover {
    color: var(--text-color, light-dark(#374151, #eee));
    background: var(--surface-bg-hover, light-dark(#e5e7eb, #3a3a3a));
  }

  .columns-picker {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    padding: 8px 0;
    border-bottom: 1px solid var(--dialog-border, light-dark(#e5e7eb, #2a2a2e));
    margin-bottom: 8px;
  }

  .col-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
  }

  .col-toggle input[type="checkbox"] {
    width: auto;
    margin: 0;
  }

  .filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .filter-label {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
  }

  .filter-input {
    flex: 1;
    min-width: 0;
    font-size: 12px;
  }

  .modal-body {
    overflow: auto;
  }

  /* Data table */
  .result-table {
    width: 100%;
    min-width: max-content;
    border-collapse: collapse;
    font-size: 12px;
  }

  .result-table thead {
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .result-table th {
    background: var(--dialog-bg, light-dark(#f3f4f6, #1c1d21));
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    text-align: left;
    padding: 6px 10px;
    white-space: nowrap;
  }

  .result-table th.sortable {
    cursor: pointer;
    user-select: none;
  }
  .result-table th.sortable:hover {
    color: var(--text-color, light-dark(#374151, #eee));
  }

  .result-table td {
    padding: 5px 10px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#e5e7eb, #2a2a2e));
    vertical-align: middle;
  }

  .result-row {
    transition: background 0.1s;
  }
  .result-row:nth-child(even) {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.015), rgba(255,255,255,0.02)));
  }
  .result-row:hover {
    background: var(--surface-bg-hover, light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.05)));
  }

  /* Filtered-out rows are dimmed */
  .result-row.filtered-out {
    opacity: 0.4;
  }
  .result-row.failed-row {
    opacity: 0.6;
    background: rgba(239, 68, 68, 0.04);
  }

  .col-idx {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    width: 36px;
    text-align: right;
  }

  .col-lbl {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .col-val {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .val-cell {
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-end;
  }

  /* Inline bar chart */
  .bar-container {
    width: 60px;
    height: 10px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.06)));
    border-radius: 3px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .bar-fill {
    height: 100%;
    border-radius: 3px;
    background: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    transition: width 0.2s ease;
  }

  .bar-fill.bar-passed {
    background: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
  }

  .bar-fill.bar-failed {
    background: #ef4444;
  }

  .val-text {
    min-width: 60px;
    text-align: right;
  }

  .col-action {
    width: 60px;
    text-align: center;
  }

  .view-btn {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    color: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
    cursor: pointer;
    font-size: 10px;
    font-family: inherit;
    padding: 2px 8px;
    transition: all 0.15s;
  }
  .view-btn:hover {
    background: color-mix(in srgb, var(--accent-color, cornflowerblue) 10%, transparent);
    border-color: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
  }

  .no-structure {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 11px;
  }

  .empty-msg {
    text-align: center;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    padding: 24px 10px !important;
    font-style: italic;
  }

  /* Summary statistics */
  .stats-section {
    padding: 12px 16px;
    border-top: 1px solid var(--dialog-border, light-dark(#e5e7eb, #2a2a2e));
    margin-top: 8px;
  }

  .stats-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    margin-bottom: 6px;
  }

  .stats-row {
    display: flex;
    gap: 16px;
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    flex-wrap: wrap;
  }

  /* Footer */
  .panel-footer {
    display: flex;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    justify-content: flex-end;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .btn-action {
    font-size: 12px;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1)));
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
  }
  .btn-action:hover {
    background: var(--btn-bg-hover, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.2)));
  }
  .btn-action:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn-primary-action {
    background: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
    border-color: transparent;
    color: #fff;
  }
  .btn-primary-action:hover {
    background: var(--accent-hover-color, light-dark(#3730a3, #3b82f6));
  }
</style>

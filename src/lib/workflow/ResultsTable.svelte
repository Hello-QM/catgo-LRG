<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { EnrichedResult } from '$lib/api/project'

  load_i18n_module(`workflow`)

  type SortDir = `asc` | `desc`
  type ColumnKey = keyof EnrichedResult

  interface ColumnDef {
    key: ColumnKey
    label: string
    width: string
    format?: (val: unknown) => string
    filterable?: boolean
  }

  let {
    results = [],
    on_view_structure,
    on_view_step,
    on_select_change,
  }: {
    results: EnrichedResult[]
    on_view_structure?: (result: EnrichedResult) => void
    on_view_step?: (workflow_id: string, step_id: string) => void
    on_select_change?: (selected: EnrichedResult[]) => void
  } = $props()

  let sort_key = $state<ColumnKey>(`energy_per_atom`)
  let sort_dir = $state<SortDir>(`asc`)
  let selected_keys = $state<Set<string>>(new Set())
  let page = $state(0)
  const PAGE_SIZE = 50
  let expanded_row_id = $state<string | null>(null)

  function row_key(result: EnrichedResult, index: number): string {
    return result.id != null ? String(result.id) : `__null_${index}`
  }

  // Node type helpers — DB stores unified types ("uvvis", "freq") but some paths use resolved ("orca_uvvis", "orca_freq")
  const UVVIS_TYPES = new Set([`orca_uvvis`, `uvvis`])
  const FREQ_TYPES = new Set([`orca_freq`, `freq`])
  const SP_TYPES = new Set([`orca_sp`, `single_point`])
  const OPT_TYPES = new Set([`orca_opt`, `geo_opt`])

  // Filters
  let filter_formula = $state(``)
  let filter_node_type = $state(``)
  let filter_workflow = $state(``)

  const columns: ColumnDef[] = [
    { key: `formula`, label: `workflow.results_col_formula`, width: `100px`, filterable: true },
    { key: `energy`, label: `workflow.results_col_energy`, width: `110px`, format: (v) => v != null ? Number(v).toFixed(4) : `\u2014` },
    { key: `energy_per_atom`, label: `workflow.results_col_energy_atom`, width: `110px`, format: (v) => v != null ? Number(v).toFixed(4) : `\u2014` },
    { key: `natoms`, label: `workflow.results_col_n_atoms`, width: `70px` },
    { key: `volume`, label: `workflow.results_col_volume`, width: `100px`, format: (v) => v != null ? Number(v).toFixed(2) : `\u2014` },
    { key: `node_type`, label: `workflow.results_col_node_type`, width: `110px`, filterable: true },
    { key: `workflow_name`, label: `workflow.results_col_workflow`, width: `130px`, filterable: true },
    { key: `step_label`, label: `workflow.results_col_step`, width: `110px` },
  ]

  const filtered_results = $derived.by(() => {
    let data = results
    if (filter_formula) {
      const f = filter_formula.toLowerCase()
      data = data.filter(r => (r.formula ?? ``).toLowerCase().includes(f))
    }
    if (filter_node_type) {
      const f = filter_node_type.toLowerCase()
      data = data.filter(r => r.node_type.toLowerCase().includes(f))
    }
    if (filter_workflow) {
      const f = filter_workflow.toLowerCase()
      data = data.filter(r => r.workflow_name.toLowerCase().includes(f))
    }
    return data
  })

  const sorted_results = $derived.by(() => {
    const data = [...filtered_results]
    data.sort((a, b) => {
      const va = a[sort_key]
      const vb = b[sort_key]
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === `string`) {
        return sort_dir === `asc` ? va.localeCompare(vb as string) : (vb as string).localeCompare(va)
      }
      return sort_dir === `asc` ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
    return data
  })

  const total_pages = $derived(Math.max(1, Math.ceil(sorted_results.length / PAGE_SIZE)))
  const paged_results = $derived(sorted_results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE))

  function toggle_sort(key: ColumnKey) {
    if (sort_key === key) {
      sort_dir = sort_dir === `asc` ? `desc` : `asc`
    } else {
      sort_key = key
      sort_dir = `asc`
    }
  }

  function selected_results(): EnrichedResult[] {
    return results.filter((r, i) => selected_keys.has(row_key(r, i)))
  }

  function toggle_select(key: string) {
    const next = new Set(selected_keys)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    selected_keys = next
    on_select_change?.(selected_results())
  }

  function select_all() {
    selected_keys = new Set(filtered_results.map((r, i) => row_key(r, i)))
    on_select_change?.(selected_results())
  }

  function clear_selection() {
    selected_keys = new Set()
    on_select_change?.([])
  }

  function export_csv() {
    const data = selected_keys.size > 0 ? selected_results() : sorted_results
    const headers = columns.map(c => t(c.label))
    const rows = data.map(r => columns.map(c => {
      const val = r[c.key]
      return val != null ? String(val) : ``
    }))
    const csv = [headers.join(`,`), ...rows.map(r => r.join(`,`))].join(`\n`)
    download_file(csv, `results.csv`, `text/csv`)
  }

  function export_json() {
    const data = selected_keys.size > 0 ? selected_results() : sorted_results
    const json = JSON.stringify(data, null, 2)
    download_file(json, `results.json`, `application/json`)
  }

  function download_file(content: string, filename: string, mime: string) {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement(`a`)
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
</script>

<div class="results-table">
  <!-- Toolbar -->
  <div class="toolbar">
    <div class="toolbar-left">
      <span class="result-count">
        {t(`workflow.results_count`, { n: filtered_results.length })}
        {#if selected_keys.size > 0}
          ({t(`workflow.results_selected`, { n: selected_keys.size })})
        {/if}
      </span>
      <button class="tool-btn" onclick={select_all} title={t(`workflow.select_all`)}>{t(`workflow.select_all`)}</button>
      <button class="tool-btn" onclick={clear_selection} title={t(`workflow.clear_selection`)} disabled={selected_keys.size === 0}>{t(`workflow.clear`)}</button>
    </div>
    <div class="toolbar-right">
      <button class="tool-btn" onclick={export_csv} title={t(`workflow.export_csv`)}>CSV</button>
      <button class="tool-btn" onclick={export_json} title={t(`workflow.export_json`)}>JSON</button>
    </div>
  </div>

  <!-- Table -->
  <div class="table-wrapper">
    <table>
      <thead>
        <!-- Filter row -->
        <tr class="filter-row">
          <th class="checkbox-col"></th>
          {#each columns as col}
            <th style="width: {col.width}">
              {#if col.filterable}
                <input
                  class="filter-input"
                  placeholder={t(`workflow.filter_placeholder`)}
                  oninput={(e) => {
                    const value = (e.currentTarget as HTMLInputElement).value
                    if (col.key === `formula`) filter_formula = value
                    else if (col.key === `node_type`) filter_node_type = value
                    else if (col.key === `workflow_name`) filter_workflow = value
                    page = 0
                  }}
                />
              {/if}
            </th>
          {/each}
          <th class="actions-col"></th>
        </tr>
        <!-- Header row -->
        <tr>
          <th class="checkbox-col">
            <input type="checkbox"
              checked={selected_keys.size > 0 && selected_keys.size === filtered_results.length}
              onchange={(e) => (e.currentTarget as HTMLInputElement).checked ? select_all() : clear_selection()}
            />
          </th>
          {#each columns as col}
            <th style="width: {col.width}" class="sortable" onclick={() => toggle_sort(col.key)}>
              {t(col.label)}
              {#if sort_key === col.key}
                <span class="sort-arrow">{sort_dir === `asc` ? `\u25B2` : `\u25BC`}</span>
              {/if}
            </th>
          {/each}
          <th class="actions-col">{t(`workflow.actions`)}</th>
        </tr>
      </thead>
      <tbody>
        {#each paged_results as row, ri}
          {@const key = row_key(row, page * PAGE_SIZE + ri)}
          <tr
            class:selected={selected_keys.has(key)}
            onclick={() => on_view_structure?.(row)}
          >
            <td class="checkbox-col" onclick={(e) => e.stopPropagation()}>
              <input type="checkbox"
                checked={selected_keys.has(key)}
                onchange={() => toggle_select(key)}
              />
            </td>
            {#each columns as col}
              <td style="width: {col.width}">
                {#if col.key === `node_type`}
                  <span class="node-badge">{row[col.key]}</span>
                {:else if col.key === `natoms` && FREQ_TYPES.has(row.node_type)}
                  <span class="meta-value" title={t(`workflow.vibrational_modes`)}>{t(`workflow.results_modes`, { n: row.frequencies?.length ?? 0 })}</span>
                {:else if col.key === `natoms` && UVVIS_TYPES.has(row.node_type)}
                  <span class="meta-value" title={t(`workflow.electronic_transitions`)}>{t(`workflow.results_states`, { n: row.absorption_states?.length ?? 0 })}</span>
                {:else if col.key === `volume` && FREQ_TYPES.has(row.node_type)}
                  <span class="meta-value" title={t(`workflow.imaginary_frequencies`)}>{t(`workflow.results_imag`, { n: row.num_imaginary ?? 0 })}</span>
                {:else if col.key === `volume` && UVVIS_TYPES.has(row.node_type)}
                  <span class="meta-value" title="Brightest transition">{row.brightest_wavelength_nm != null ? `\u03BB ${Number(row.brightest_wavelength_nm).toFixed(0)} nm` : `\u2014`}</span>
                {:else if col.key === `energy_per_atom` && (FREQ_TYPES.has(row.node_type) || UVVIS_TYPES.has(row.node_type) || SP_TYPES.has(row.node_type))}
                  {row.energy_eh != null ? `${Number(row.energy_eh).toFixed(4)} Eh` : `\u2014`}
                {:else if col.format}
                  {col.format(row[col.key])}
                {:else}
                  {row[col.key] ?? `\u2014`}
                {/if}
              </td>
            {/each}
            <td class="actions-col" onclick={(e) => e.stopPropagation()}>
              <button class="action-btn toggle-detail" onclick={(e) => {
                e.stopPropagation();
                expanded_row_id = expanded_row_id === row.step_id ? null : row.step_id;
              }} title={expanded_row_id === row.step_id ? t(`workflow.hide`) : t(`workflow.show_details`)}>
                {expanded_row_id === row.step_id ? '▼' : '▶'}
              </button>
              {#if on_view_step}
                <button class="action-btn" onclick={() => on_view_step(row.workflow_id, row.step_id)} title={t(`workflow.view_step`)}>
                  {t(`workflow.step`)}
                </button>
              {/if}
            </td>
          </tr>
          <!-- Detail row for plots -->
          {#if expanded_row_id === row.step_id}
            <tr class="detail-row">
              <td colspan={columns.length + 2}>
                <div class="detail-content">
                  {#if OPT_TYPES.has(row.node_type) && row.convergence_points?.length}
                    {@const conv_pts = row.convergence_points!}
                    {@const ts_idx = conv_pts.findIndex(p => (p as { is_ts?: boolean }).is_ts === true)}
                    {@const is_irc = ts_idx >= 0}
                    {@const e_min = Math.min(...conv_pts.map(p => p.energy || 0))}
                    {@const y_for = (e: number) => 100 - (e - e_min) * 50}
                    {@const x_for = (i: number) => 20 + i * 4}
                    {@const pt_color = (i: number) => is_irc
                      ? (i < ts_idx ? '#8b5cf6' : i > ts_idx ? '#10b981' : '#ef4444')
                      : '#3b82f6'}
                    <!-- Opt convergence energy plot -->
                    <div class="plot-container">
                      <h4>{is_irc ? t(`workflow.irc_reaction_coordinate`) : t(`workflow.optimization_progress`)}</h4>
                      <svg width="400" height="120" class="convergence-chart">
                        {#each conv_pts as pt, i}
                          <line x1={x_for(i)} y1="100" x2={x_for(i)} y2={y_for(pt.energy || 0)} stroke={pt_color(i)} stroke-width="2" />
                        {/each}
                        {#if conv_pts.length > 1 && is_irc}
                          <!-- Backward arm: indices 0..ts_idx (inclusive of TS) -->
                          <polyline points={conv_pts.slice(0, ts_idx + 1).map((pt, i) => `${x_for(i)},${y_for(pt.energy || 0)}`).join(' ')} fill="none" stroke="#8b5cf6" stroke-width="1.5" opacity="0.7" />
                          <!-- Forward arm: indices ts_idx..end (inclusive of TS) -->
                          <polyline points={conv_pts.slice(ts_idx).map((pt, i) => `${x_for(ts_idx + i)},${y_for(pt.energy || 0)}`).join(' ')} fill="none" stroke="#10b981" stroke-width="1.5" opacity="0.7" />
                        {:else if conv_pts.length > 1}
                          <polyline points={conv_pts.map((pt, i) => `${x_for(i)},${y_for(pt.energy || 0)}`).join(' ')} fill="none" stroke="#3b82f6" stroke-width="1" opacity="0.5" />
                        {/if}
                        {#if is_irc}
                          <!-- TS marker: red diamond -->
                          <circle cx={x_for(ts_idx)} cy={y_for(conv_pts[ts_idx].energy || 0)} r="4" fill="#ef4444" stroke="#dc2626" stroke-width="1" />
                          <!-- Legend -->
                          <circle cx="30" cy="13" r="4" fill="#8b5cf6" />
                          <text x="38" y="17" font-size="12" fill="#64748b">{t(`workflow.irc_backward`)}</text>
                          <circle cx="105" cy="13" r="4" fill="#ef4444" />
                          <text x="113" y="17" font-size="12" fill="#64748b">TS</text>
                          <circle cx="135" cy="13" r="4" fill="#10b981" />
                          <text x="143" y="17" font-size="12" fill="#64748b">{t(`workflow.irc_forward`)}</text>
                        {/if}
                        <line x1="20" y1="100" x2={x_for(conv_pts.length)} y2="100" stroke="#64748b" stroke-width="1" />
                        <text x="10" y="115" font-size="13" fill="#94a3b8">{t(`workflow.step`)}</text>
                      </svg>
                    </div>
                  {:else if FREQ_TYPES.has(row.node_type) && row.frequencies?.length}
                    <!-- Frequency table + spectrum -->
                    <div class="plot-container">
                      <h4>{t(`workflow.vibrational_frequencies_title`, { modes: row.frequencies.length, imaginary: row.num_imaginary || 0 })}</h4>
                      <div class="freq-table-wrapper">
                        <div class="freq-list">
                          {#each row.frequencies as freq}
                            {#if Math.abs(freq.frequency_cm) > 1.0}
                              <div class="freq-entry" class:freq-imag={freq.imaginary}>
                                <span class="freq-idx">{freq.index}:</span>
                                <span class="freq-val">{Math.abs(freq.frequency_cm).toFixed(2)} cm⁻¹{freq.imaginary ? ` (imag)` : ``}</span>
                              </div>
                            {/if}
                          {/each}
                        </div>
                      </div>
                      <svg width="500" height="100" class="spectrum-chart" style="margin-top: 8px">
                        {#each row.frequencies as freq, i}
                          <line x1={10 + (Math.abs(freq.frequency_cm) / 4000) * 480} y1="80" x2={10 + (Math.abs(freq.frequency_cm) / 4000) * 480} y2="10" stroke={freq.imaginary ? '#ef4444' : '#3b82f6'} stroke-width="1" opacity="0.7" />
                        {/each}
                        <line x1="10" y1="80" x2="490" y2="80" stroke="#64748b" stroke-width="1" />
                        <text x="10" y="95" font-size="13" fill="#94a3b8">0 cm⁻¹</text>
                        <text x="440" y="95" font-size="13" fill="#94a3b8">4000 cm⁻¹</text>
                      </svg>
                    </div>
                  {:else if UVVIS_TYPES.has(row.node_type) && row.absorption_states?.length}
                    <!-- UV-Vis absorption spectrum -->
                    <div class="plot-container">
                      <h4>{t(`workflow.absorption_spectrum`)}</h4>
                      <svg width="500" height="100" class="spectrum-chart">
                        {#each row.absorption_states as state, i}
                          <line x1={10 + (state.wavelength_nm || 300 - 200) / 300 * 480} y1="80" x2={10 + (state.wavelength_nm || 300 - 200) / 300 * 480} y2={80 - (state.oscillator_strength || 0) * 40} stroke="#8b5cf6" stroke-width="1.5" opacity="0.8" />
                        {/each}
                        <line x1="10" y1="80" x2="490" y2="80" stroke="#64748b" stroke-width="1" />
                        <text x="10" y="95" font-size="13" fill="#94a3b8">200 nm</text>
                        <text x="440" y="95" font-size="13" fill="#94a3b8">500 nm</text>
                      </svg>
                    </div>
                  {:else}
                    <span class="no-detail">{t(`workflow.no_plot_data`)}</span>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>

  <!-- Pagination -->
  {#if total_pages > 1}
    <div class="pagination">
      <button class="page-btn" disabled={page === 0} onclick={() => page--}>{t(`workflow.prev`)}</button>
      <span class="page-info">{t(`workflow.page_of`, { current: page + 1, total: total_pages })}</span>
      <button class="page-btn" disabled={page >= total_pages - 1} onclick={() => page++}>{t(`workflow.next`)}</button>
    </div>
  {/if}
</div>

<style>
  .results-table {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    margin-bottom: 8px;
    gap: 8px;
  }

  .toolbar-left,
  .toolbar-right {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .result-count {
    font-size: 12px;
    color: #94a3b8;
  }

  .tool-btn {
    padding: 4px 10px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    color: #94a3b8;
    font-size: 11px;
    cursor: pointer;
  }

  .tool-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .tool-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .table-wrapper {
    flex: 1;
    overflow: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  thead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: #0c1220;
  }

  th {
    padding: 6px 8px;
    text-align: left;
    font-weight: 600;
    color: #64748b;
    font-size: 11px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    white-space: nowrap;
  }

  th.sortable {
    cursor: pointer;
    user-select: none;
  }

  th.sortable:hover {
    color: #94a3b8;
  }

  .sort-arrow {
    font-size: 10px;
    margin-left: 4px;
  }

  .checkbox-col {
    width: 32px;
    text-align: center;
  }

  .actions-col {
    width: 60px;
    text-align: center;
  }

  td {
    padding: 6px 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    color: #cbd5e1;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }

  tr:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  tr.selected {
    background: rgba(59, 130, 246, 0.1);
  }

  .node-badge {
    display: inline-block;
    padding: 1px 6px;
    background: rgba(59, 130, 246, 0.15);
    border-radius: 8px;
    font-size: 10px;
    color: #60a5fa;
  }

  .filter-row th {
    padding: 4px 8px;
  }

  .filter-input {
    width: 100%;
    padding: 3px 6px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 3px;
    color: #cbd5e1;
    font-size: 11px;
    outline: none;
  }

  .filter-input:focus {
    border-color: rgba(59, 130, 246, 0.5);
  }

  .pagination {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
  }

  .page-btn {
    padding: 4px 12px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    color: #94a3b8;
    font-size: 11px;
    cursor: pointer;
  }

  .page-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .page-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .page-info {
    font-size: 12px;
    color: #64748b;
  }

  .action-btn {
    padding: 2px 8px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    color: #94a3b8;
    font-size: 10px;
    cursor: pointer;
  }

  .action-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #e2e8f0;
  }

  input[type="checkbox"] {
    accent-color: #3b82f6;
  }

  .toggle-detail {
    padding: 2px 6px;
    margin-right: 4px;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: #60a5fa;
  }

  .toggle-detail:hover {
    background: rgba(59, 130, 246, 0.2);
  }

  .detail-row {
    background: rgba(15, 23, 42, 0.5) !important;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .detail-content {
    padding: 12px 8px;
  }

  .plot-container {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 600px;
  }

  .plot-container h4 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: #cbd5e1;
  }

  .convergence-chart,
  .spectrum-chart {
    background: rgba(15, 23, 42, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 2px;
  }

  .no-detail {
    color: #94a3b8;
    font-size: 12px;
  }

  .meta-value {
    color: #94a3b8;
    font-size: 11px;
  }

  .freq-table-wrapper {
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    background: rgba(15, 23, 42, 0.5);
    padding: 6px 0;
  }

  .freq-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1px 12px;
    padding: 0 10px;
  }

  .freq-entry {
    display: flex;
    gap: 6px;
    font-size: 11px;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    color: #94a3b8;
    padding: 1px 0;
  }

  .freq-entry.freq-imag {
    color: #ef4444;
  }

  .freq-idx {
    min-width: 28px;
    text-align: right;
    color: #64748b;
  }

  .freq-val {
    color: inherit;
  }
</style>

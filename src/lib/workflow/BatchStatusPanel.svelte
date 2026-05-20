<script lang="ts">
  import { API_BASE } from '$lib/api/config'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('workflow')

  let {
    workflow_id,
    step_id,
    status,
  }: {
    workflow_id: string
    step_id: string
    status?: string
  } = $props()

  interface BatchSummary {
    total: number
    completed: number
    failed: number
    running: number
    pending: number
    energy_min?: number
    energy_max?: number
    energy_mean?: number
    energy_std?: number
  }

  interface BatchResult {
    subtask_index: number
    status: string
    energy?: number
    error_message?: string
  }

  let summary = $state<BatchSummary | null>(null)
  let results_page = $state.raw<{ items: BatchResult[]; total: number; page: number } | null>(null)
  let histogram = $state.raw<{ bins: number[]; counts: number[] } | null>(null)
  let active_tab = $state<'overview' | 'table' | 'failed'>('overview')
  let current_page = $state(1)
  let sort_field = $state('energy')
  let sort_order = $state<'asc' | 'desc'>('asc')
  let loading = $state(false)
  let retry_loading = $state(false)

  const API = $derived(`${API_BASE}/workflow/${workflow_id}/steps/${step_id}`)

  async function fetchSummary() {
    try {
      summary = await fetch(`${API}/batch-summary`).then(r => r.json())
    } catch {
      /* non-critical */
    }
  }

  async function fetchResults(page = 1) {
    loading = true
    try {
      results_page = await fetch(
        `${API}/batch-results?page=${page}&per_page=50&sort=${sort_field}&order=${sort_order}`
      ).then(r => r.json())
    } finally {
      loading = false
    }
  }

  async function fetchHistogram() {
    try {
      histogram = await fetch(`${API}/batch-histogram?bins=30`).then(r => r.json())
    } catch {
      /* non-critical */
    }
  }

  async function retryFailed() {
    retry_loading = true
    try {
      await fetch(`${API}/batch-retry`, { method: 'POST' })
      await fetchSummary()
    } finally {
      retry_loading = false
    }
  }

  function toggleSort(field: string) {
    if (sort_field === field) {
      sort_order = sort_order === 'asc' ? 'desc' : 'asc'
    } else {
      sort_field = field
      sort_order = 'asc'
    }
    fetchResults(current_page)
  }

  function goToPage(page: number) {
    current_page = page
    fetchResults(page)
  }

  // Auto-refresh when tab or params change
  $effect(() => {
    fetchSummary()
    if (active_tab === 'overview') fetchHistogram()
    if (active_tab === 'table') fetchResults(current_page)
  })

  // Poll while running
  $effect(() => {
    if (status !== 'running') return
    const timer = setInterval(fetchSummary, 5000)
    return () => clearInterval(timer)
  })

  const progress_pct = $derived(
    summary ? ((summary.completed + summary.failed) / Math.max(summary.total, 1)) * 100 : 0
  )

  const total_pages = $derived(
    results_page ? Math.ceil(results_page.total / 50) : 1
  )

  const failed_items = $derived(
    results_page?.items.filter(r => r.status === 'failed') ?? []
  )

  // Histogram drawing helpers
  const hist_width = 360
  const hist_height = 120
  const hist_pad = { top: 10, right: 10, bottom: 20, left: 40 }

  const hist_max_count = $derived(
    histogram ? Math.max(...histogram.counts, 1) : 1
  )
</script>

<div class="bp-root">
  <!-- Header -->
  <div class="bp-header">
    <div class="bp-title">{t('workflow.batch_status_title')}</div>
    {#if summary}
      <div class="bp-progress-label">
        {summary.completed.toLocaleString()} / {summary.total.toLocaleString()}
      </div>
    {/if}
  </div>

  <!-- Progress bar -->
  {#if summary}
    <div class="bp-progress-bar">
      <div class="bp-progress-fill" style="width:{progress_pct.toFixed(1)}%"></div>
    </div>
    <div class="bp-status-line">
      <span class="bp-stat bp-stat-completed">{t('workflow.batch_status_completed', { n: summary.completed })}</span>
      <span class="bp-stat bp-stat-running">{t('workflow.batch_status_running', { n: summary.running })}</span>
      <span class="bp-stat bp-stat-failed">{t('workflow.batch_status_failed', { n: summary.failed })}</span>
      <span class="bp-stat bp-stat-pending">{t('workflow.batch_status_pending', { n: summary.pending })}</span>
    </div>
  {/if}

  <!-- Tab buttons -->
  <div class="bp-tabs">
    <button
      class="bp-tab"
      class:bp-tab-active={active_tab === 'overview'}
      onclick={() => (active_tab = 'overview')}
    >{t('workflow.batch_status_overview')}</button>
    <button
      class="bp-tab"
      class:bp-tab-active={active_tab === 'table'}
      onclick={() => (active_tab = 'table')}
    >{t('workflow.batch_status_table')}</button>
    <button
      class="bp-tab"
      class:bp-tab-active={active_tab === 'failed'}
      onclick={() => (active_tab = 'failed')}
    >{t('workflow.batch_status_failed_tab')}</button>
  </div>

  <!-- Tab content -->
  <div class="bp-content">
    {#if active_tab === 'overview'}
      <!-- Overview tab -->
      {#if summary}
        <div class="bp-stats-grid">
          {#if summary.energy_min != null}
            <div class="bp-stats-row">
              <span class="bp-stats-label">{t('workflow.batch_status_energy_range')}</span>
              <span class="bp-stats-value">{summary.energy_min.toFixed(4)} ... {summary.energy_max?.toFixed(4)} eV</span>
            </div>
          {/if}
          {#if summary.energy_mean != null}
            <div class="bp-stats-row">
              <span class="bp-stats-label">{t('workflow.batch_status_mean')}</span>
              <span class="bp-stats-value">{summary.energy_mean.toFixed(4)} eV</span>
            </div>
          {/if}
          {#if summary.energy_std != null}
            <div class="bp-stats-row">
              <span class="bp-stats-label">{t('workflow.batch_status_std_dev')}</span>
              <span class="bp-stats-value">{summary.energy_std.toFixed(4)} eV</span>
            </div>
          {/if}
        </div>

        {#if histogram && histogram.bins.length > 1}
          <div class="bp-histogram">
            <div class="bp-section-title">{t('workflow.batch_status_energy_distribution')}</div>
            <svg
              viewBox="0 0 {hist_width} {hist_height}"
              class="bp-hist-svg"
            >
              {#each histogram.counts as count, i}
                {@const bar_w = (hist_width - hist_pad.left - hist_pad.right) / histogram.counts.length}
                {@const bar_h = (count / hist_max_count) * (hist_height - hist_pad.top - hist_pad.bottom)}
                {@const x = hist_pad.left + i * bar_w}
                {@const y = hist_height - hist_pad.bottom - bar_h}
                <rect
                  {x}
                  {y}
                  width={Math.max(bar_w - 1, 1)}
                  height={bar_h}
                  class="bp-hist-bar"
                />
              {/each}
              <!-- X axis -->
              <line
                x1={hist_pad.left}
                y1={hist_height - hist_pad.bottom}
                x2={hist_width - hist_pad.right}
                y2={hist_height - hist_pad.bottom}
                stroke="var(--bp-axis-color, #666)"
                stroke-width="1"
              />
              <!-- Min/Max labels -->
              {#if histogram.bins.length >= 2}
                <text
                  x={hist_pad.left}
                  y={hist_height - 4}
                  class="bp-hist-label"
                  text-anchor="start"
                >{histogram.bins[0].toFixed(2)}</text>
                <text
                  x={hist_width - hist_pad.right}
                  y={hist_height - 4}
                  class="bp-hist-label"
                  text-anchor="end"
                >{histogram.bins[histogram.bins.length - 1].toFixed(2)}</text>
              {/if}
            </svg>
          </div>
        {/if}
      {:else}
        <div class="bp-empty">{t('workflow.batch_status_no_summary_data')}</div>
      {/if}

    {:else if active_tab === 'table'}
      <!-- Table tab -->
      {#if loading}
        <div class="bp-loading">{t('workflow.batch_status_loading')}</div>
      {:else if results_page}
        <div class="bp-table-wrap">
          <table class="bp-table">
            <thead>
              <tr>
                <th class="bp-th bp-th-sortable" onclick={() => toggleSort('subtask_index')}>
                  # {sort_field === 'subtask_index' ? (sort_order === 'asc' ? '▲' : '▼') : ''}
                </th>
                <th class="bp-th bp-th-sortable" onclick={() => toggleSort('status')}>
                  {t('common.status')} {sort_field === 'status' ? (sort_order === 'asc' ? '▲' : '▼') : ''}
                </th>
                <th class="bp-th bp-th-sortable" onclick={() => toggleSort('energy')}>
                  {t('workflow.batch_status_energy_ev')} {sort_field === 'energy' ? (sort_order === 'asc' ? '▲' : '▼') : ''}
                </th>
              </tr>
            </thead>
            <tbody>
              {#each results_page.items as row (row.subtask_index)}
                <tr class="bp-tr" class:bp-tr-failed={row.status === 'failed'}>
                  <td class="bp-td">{row.subtask_index}</td>
                  <td class="bp-td">
                    <span class="bp-status-dot bp-status-{row.status}"></span>
                    {row.status}
                  </td>
                  <td class="bp-td mono">{row.energy?.toFixed(4) ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        {#if total_pages > 1}
          <div class="bp-pagination">
            <button
              class="bp-page-btn"
              disabled={current_page <= 1}
              onclick={() => goToPage(current_page - 1)}
            >{t('workflow.batch_status_prev')}</button>
            <span class="bp-page-info">{t('workflow.batch_status_page', { current: current_page, total: total_pages })}</span>
            <button
              class="bp-page-btn"
              disabled={current_page >= total_pages}
              onclick={() => goToPage(current_page + 1)}
            >{t('workflow.batch_status_next')}</button>
          </div>
        {/if}
      {:else}
        <div class="bp-empty">{t('workflow.batch_status_no_results_data')}</div>
      {/if}

    {:else if active_tab === 'failed'}
      <!-- Failed tab -->
      <div class="bp-failed-header">
        <button
          class="bp-retry-btn"
          disabled={retry_loading || !summary?.failed}
          onclick={retryFailed}
        >
          {retry_loading ? t('workflow.batch_status_retrying') : t('workflow.batch_status_retry_all_failed')}
        </button>
        {#if summary}
          <span class="bp-failed-count">{t('workflow.batch_status_failed_subtasks', { n: summary.failed, s: summary.failed !== 1 ? 's' : '' })}</span>
        {/if}
      </div>

      {#if results_page}
        <div class="bp-failed-list">
          {#each failed_items as row (row.subtask_index)}
            <div class="bp-failed-item">
              <div class="bp-failed-idx">#{row.subtask_index}</div>
              <div class="bp-failed-msg">{row.error_message ?? t('workflow.batch_status_unknown_error')}</div>
            </div>
          {:else}
            <div class="bp-empty">{t('workflow.batch_status_no_failed_subtasks_on_page')}</div>
          {/each}
        </div>
      {:else}
        <div class="bp-empty">{t('workflow.batch_status_loading_failed_results')}</div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .bp-root {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    font-size: 13px;
    color: var(--text-color, #e0e0e0);
  }

  .bp-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .bp-title {
    font-weight: 600;
    font-size: 14px;
  }

  .bp-progress-label {
    font-size: 13px;
    color: var(--text-muted, #aaa);
    font-variant-numeric: tabular-nums;
  }

  .bp-progress-bar {
    height: 6px;
    background: var(--bg-secondary, #2a2a2a);
    border-radius: 3px;
    overflow: hidden;
  }

  .bp-progress-fill {
    height: 100%;
    background: var(--accent-color, #4fc3f7);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .bp-status-line {
    display: flex;
    gap: 12px;
    font-size: 12px;
    flex-wrap: wrap;
  }

  .bp-stat-completed { color: #66bb6a; }
  .bp-stat-running { color: #42a5f5; }
  .bp-stat-failed { color: #ef5350; }
  .bp-stat-pending { color: #888; }

  .bp-tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border-color, #333);
    padding-bottom: 0;
  }

  .bp-tab {
    padding: 6px 14px;
    font-size: 12px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted, #aaa);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .bp-tab:hover {
    color: var(--text-color, #e0e0e0);
  }

  .bp-tab-active {
    color: var(--accent-color, #4fc3f7);
    border-bottom-color: var(--accent-color, #4fc3f7);
  }

  .bp-content {
    min-height: 100px;
  }

  /* Overview stats */
  .bp-stats-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }

  .bp-stats-row {
    display: flex;
    justify-content: space-between;
    padding: 2px 0;
  }

  .bp-stats-label {
    color: var(--text-muted, #aaa);
    font-size: 12px;
  }

  .bp-stats-value {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }

  .bp-section-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 6px;
    color: var(--text-muted, #aaa);
  }

  /* Histogram */
  .bp-histogram {
    margin-top: 4px;
  }

  .bp-hist-svg {
    width: 100%;
    max-width: 400px;
    height: auto;
  }

  .bp-hist-bar {
    fill: var(--accent-color, #4fc3f7);
    opacity: 0.8;
  }

  .bp-hist-bar:hover {
    opacity: 1;
  }

  .bp-hist-label {
    font-size: 9px;
    fill: var(--text-muted, #aaa);
  }

  /* Table */
  .bp-table-wrap {
    overflow-x: auto;
  }

  .bp-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .bp-th {
    text-align: left;
    padding: 6px 8px;
    font-weight: 600;
    border-bottom: 1px solid var(--border-color, #333);
    color: var(--text-muted, #aaa);
    white-space: nowrap;
  }

  .bp-th-sortable {
    cursor: pointer;
    user-select: none;
  }

  .bp-th-sortable:hover {
    color: var(--text-color, #e0e0e0);
  }

  .bp-td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--border-subtle, #222);
  }

  .bp-tr-failed {
    background: rgba(239, 83, 80, 0.08);
  }

  .bp-status-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
  }

  .bp-status-completed { background: #66bb6a; }
  .bp-status-running { background: #42a5f5; }
  .bp-status-failed { background: #ef5350; }
  .bp-status-pending { background: #888; }

  .mono {
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  /* Pagination */
  .bp-pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 8px;
  }

  .bp-page-btn {
    padding: 4px 12px;
    font-size: 12px;
    background: var(--bg-secondary, #2a2a2a);
    border: 1px solid var(--border-color, #333);
    border-radius: 4px;
    color: var(--text-color, #e0e0e0);
    cursor: pointer;
  }

  .bp-page-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .bp-page-btn:not(:disabled):hover {
    background: var(--bg-hover, #333);
  }

  .bp-page-info {
    font-size: 12px;
    color: var(--text-muted, #aaa);
    font-variant-numeric: tabular-nums;
  }

  /* Failed tab */
  .bp-failed-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }

  .bp-retry-btn {
    padding: 5px 14px;
    font-size: 12px;
    background: #ef5350;
    border: none;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
    font-weight: 500;
  }

  .bp-retry-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .bp-retry-btn:not(:disabled):hover {
    background: #e53935;
  }

  .bp-failed-count {
    font-size: 12px;
    color: var(--text-muted, #aaa);
  }

  .bp-failed-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .bp-failed-item {
    display: flex;
    gap: 8px;
    padding: 6px 8px;
    background: rgba(239, 83, 80, 0.06);
    border-radius: 4px;
    border-left: 3px solid #ef5350;
  }

  .bp-failed-idx {
    font-weight: 600;
    font-size: 12px;
    min-width: 40px;
    color: #ef5350;
  }

  .bp-failed-msg {
    font-size: 12px;
    color: var(--text-muted, #aaa);
    word-break: break-word;
  }

  /* Shared */
  .bp-empty {
    text-align: center;
    color: var(--text-muted, #888);
    padding: 24px 0;
    font-size: 12px;
  }

  .bp-loading {
    text-align: center;
    color: var(--text-muted, #888);
    padding: 16px 0;
    font-size: 12px;
  }
</style>

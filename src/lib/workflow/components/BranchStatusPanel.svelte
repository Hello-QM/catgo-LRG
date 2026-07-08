<!--
  BranchStatusPanel -- Real-time monitoring panel for parallel map execution.

  Shows a sortable data table of all branches spawned by a Map node, with live
  status updates (the parent component feeds reactive `branches` prop via
  WebSocket). Users can retry failed branches, abort all running branches,
  export intermediate results as CSV, and click any row to load that branch's
  structure in the 3D viewer.

  @example
  <BranchStatusPanel
    bind:show={show_branch_panel}
    workflow_id="wf-123"
    map_node_id="n1234-abcd"
    branches={branch_data}
    on_view_structure={(json) => load_in_viewer(json)}
    on_retry_failed={() => retry()}
    on_abort_all={() => abort()}
  />
-->
<script lang="ts">
  import '$lib/dialog-shared.css'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { download } from '$lib/io/fetch'

  load_i18n_module('common')
  load_i18n_module('workflow')

  /**
   * Status of a single parallel branch spawned by a Map node.
   */
  export interface BranchInfo {
    /** 0-based branch index */
    index: number
    /** Human-readable label (e.g. "Cu-Ti", "slab-111") */
    label: string
    /** Current execution status */
    status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
    /** Computed properties from this branch (available after completion) */
    result?: { energy_per_atom?: number; band_gap?: number; [key: string]: unknown }
    /** Error message if status is 'failed' */
    error?: string
    /** Serialized structure JSON for loading into the 3D viewer */
    structure_json?: string
  }

  /**
   * Props for BranchStatusPanel.
   *
   * @prop show - Bindable boolean controlling panel visibility.
   * @prop workflow_id - ID of the workflow containing the map node.
   * @prop map_node_id - ID of the map node whose branches are displayed.
   * @prop branches - Reactive array of branch statuses, updated by parent via WebSocket.
   * @prop on_view_structure - Callback when user clicks a branch row to view its structure.
   * @prop on_retry_failed - Callback when user clicks "Retry Failed" button.
   * @prop on_abort_all - Callback when user clicks "Abort All" button.
   */
  let {
    show = $bindable(false),
    workflow_id,
    map_node_id,
    branches = [],
    on_view_structure,
    on_retry_failed,
    on_abort_all,
  }: {
    /** Controls panel visibility (bindable). */
    show: boolean
    /** Workflow ID containing the map node. */
    workflow_id: string
    /** Map node ID whose branches are shown. */
    map_node_id: string
    /** Reactive array of branch statuses, updated by parent via WebSocket. */
    branches: BranchInfo[]
    /** Called when user clicks a row to view that branch's structure. */
    on_view_structure?: (structure_json: string) => void
    /** Called when user clicks "Retry Failed". */
    on_retry_failed?: () => void
    /** Called when user clicks "Abort All". */
    on_abort_all?: () => void
  } = $props()

  // ─── Sort state ───
  type SortCol = 'index' | 'label' | 'status' | 'result'
  let sort_col = $state<SortCol>('index')
  let sort_asc = $state(true)

  // ─── Expanded error rows ───
  /** Set of branch indices whose error messages are expanded */
  let expanded_errors = $state(new Set<number>())

  // ─── Derived: status counts ───
  const completed_count = $derived(branches.filter(b => b.status === 'completed').length)
  const running_count = $derived(branches.filter(b => b.status === 'running').length)
  const pending_count = $derived(branches.filter(b => b.status === 'pending' || b.status === 'queued').length)
  const failed_count = $derived(branches.filter(b => b.status === 'failed').length)
  const skipped_count = $derived(branches.filter(b => b.status === 'skipped').length)
  const total = $derived(branches.length)

  /** Progress fraction (0-1) based on completed + failed + skipped vs total */
  const progress_frac = $derived(
    total > 0 ? (completed_count + failed_count + skipped_count) / total : 0
  )
  const progress_pct = $derived(Math.round(progress_frac * 100))

  /** Number of finished branches (completed + failed + skipped) */
  const finished_count = $derived(completed_count + failed_count + skipped_count)

  // ─── Derived: detect the first numeric result key for the "Key Result" column ───
  const result_key = $derived.by(() => {
    // Prefer energy_per_atom, then band_gap, then first numeric key
    for (const b of branches) {
      if (!b.result) continue
      if (b.result.energy_per_atom != null) return 'energy_per_atom'
      if (b.result.band_gap != null) return 'band_gap'
      for (const [k, v] of Object.entries(b.result)) {
        if (typeof v === 'number') return k
      }
    }
    return 'energy_per_atom'
  })

  /** Human-readable label for the result key column header */
  const result_col_label = $derived(
    result_key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
  )

  // ─── Sorted branches ───
  const sorted_branches = $derived.by(() => {
    const arr = [...branches]
    const dir = sort_asc ? 1 : -1
    arr.sort((a, b) => {
      switch (sort_col) {
        case 'index': return (a.index - b.index) * dir
        case 'label': return a.label.localeCompare(b.label) * dir
        case 'status': return status_order(a.status).toString().localeCompare(status_order(b.status).toString()) * dir
        case 'result': {
          const va = a.result?.[result_key] as number ?? Infinity
          const vb = b.result?.[result_key] as number ?? Infinity
          return (va - vb) * dir
        }
        default: return 0
      }
    })
    return arr
  })

  /** Sort order weight for status values so running comes first, then pending, etc. */
  function status_order(s: string): number {
    const order: Record<string, number> = {
      running: 0, queued: 1, pending: 2, completed: 3, failed: 4, skipped: 5,
    }
    return order[s] ?? 9
  }

  function status_label(s: BranchInfo['status']): string {
    return t(`workflow.branch_status_status_${s}`)
  }

  /** Toggle sort column; if already active, flip direction */
  function toggle_sort(col: SortCol) {
    if (sort_col === col) {
      sort_asc = !sort_asc
    } else {
      sort_col = col
      sort_asc = true
    }
  }

  /** Sort indicator arrow for a given column */
  function sort_arrow(col: SortCol): string {
    if (sort_col !== col) return ''
    return sort_asc ? ' \u2191' : ' \u2193'
  }

  // ─── Status styling ───
  const STATUS_PILL_COLORS: Record<string, { bg: string; text: string }> = {
    pending:   { bg: 'rgba(71, 85, 105, 0.2)',  text: '#94a3b8' },
    queued:    { bg: 'rgba(167, 139, 250, 0.2)', text: '#a78bfa' },
    running:   { bg: 'rgba(59, 130, 246, 0.2)',  text: '#60a5fa' },
    completed: { bg: 'rgba(34, 197, 94, 0.2)',   text: '#4ade80' },
    failed:    { bg: 'rgba(239, 68, 68, 0.2)',   text: '#f87171' },
    skipped:   { bg: 'rgba(107, 114, 128, 0.2)', text: '#9ca3af' },
  }

  /** Toggle error expansion for a branch */
  function toggle_error(idx: number) {
    const next = new Set(expanded_errors)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    expanded_errors = next
  }

  /** Export current branch data as CSV and trigger browser download */
  function export_csv() {
    const header = ['#', 'Label', 'Status', result_key, 'Error']
    const rows = sorted_branches.map(b => [
      b.index.toString(),
      b.label,
      b.status,
      b.result?.[result_key] != null ? String(b.result[result_key]) : '',
      b.error ?? '',
    ])
    const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    download(csv, `branches_${workflow_id}_${map_node_id}.csv`, 'text/csv')
  }

  /** Format a numeric result value for display */
  function fmt(val: unknown): string {
    if (val == null) return '\u2014'
    if (typeof val === 'number') return val.toFixed(4)
    return String(val)
  }
</script>

{#if show}
  <div class="branch-panel" role="complementary" aria-label={t('workflow.branch_status_title')}>
    <!-- Header -->
    <div class="panel-header">
      <div class="panel-title">
        <span class="panel-icon">&#9889;</span>
        {t('workflow.branch_status_title')}
      </div>
      <button class="close-btn" onclick={() => (show = false)} title={t('workflow.branch_status_close_panel')}>&times;</button>
    </div>

    <!-- Progress section -->
    <div class="progress-section">
      <div class="progress-label">
        {t('workflow.branch_status_progress', { total, finished: finished_count, percent: progress_pct })}
      </div>
      <div class="progress-track" role="progressbar" aria-valuenow={progress_pct} aria-valuemin={0} aria-valuemax={100}>
        <div class="progress-fill" style:width="{progress_pct}%"></div>
      </div>
      <!-- Status summary counts -->
      <div class="status-counts">
        {#if completed_count > 0}
          <span class="count-chip completed" title={t('common.completed')}>&#10003; {completed_count}</span>
        {/if}
        {#if running_count > 0}
          <span class="count-chip running" title={t('common.running')}>&#x25B6; {running_count}</span>
        {/if}
        {#if pending_count > 0}
          <span class="count-chip pending" title={t('workflow.branch_status_pending_queued')}>&#x23F3; {pending_count}</span>
        {/if}
        {#if failed_count > 0}
          <span class="count-chip failed" title={t('common.failed')}>&#10007; {failed_count}</span>
        {/if}
        {#if skipped_count > 0}
          <span class="count-chip skipped" title={t('workflow.branch_status_skipped')}>&#x23ED; {skipped_count}</span>
        {/if}
      </div>
    </div>

    <!-- Data table -->
    <div class="table-scroll">
      <table class="branch-table">
        <thead>
          <tr>
            <th class="sortable" onclick={() => toggle_sort('index')}>#{sort_arrow('index')}</th>
            <th class="sortable" onclick={() => toggle_sort('label')}>{t('common.label')}{sort_arrow('label')}</th>
            <th class="sortable" onclick={() => toggle_sort('status')}>{t('common.status')}{sort_arrow('status')}</th>
            <th class="sortable" onclick={() => toggle_sort('result')}>{result_col_label}{sort_arrow('result')}</th>
          </tr>
        </thead>
        <tbody>
          {#each sorted_branches as branch (branch.index)}
            {@const pill = STATUS_PILL_COLORS[branch.status] ?? STATUS_PILL_COLORS.pending}
            <tr
              class="branch-row"
              class:clickable={!!branch.structure_json}
              onclick={() => {
                if (branch.structure_json && on_view_structure) {
                  on_view_structure(branch.structure_json)
                }
              }}
            >
              <td class="col-index">{branch.index + 1}</td>
              <td class="col-label" title={branch.label}>{branch.label}</td>
              <td class="col-status">
                <span
                  class="status-pill"
                  style:background={pill.bg}
                  style:color={pill.text}
                >{status_label(branch.status)}</span>
              </td>
              <td class="col-result">
                {#if branch.status === 'failed' && branch.error}
                  <button
                    class="error-toggle"
                    onclick={(e: MouseEvent) => { e.stopPropagation(); toggle_error(branch.index) }}
                    title={t('workflow.branch_status_show_error')}
                  >
                    {expanded_errors.has(branch.index) ? '\u25BC' : '\u25B6'} {t('common.error')}
                  </button>
                {:else}
                  {fmt(branch.result?.[result_key])}
                {/if}
              </td>
            </tr>
            {#if expanded_errors.has(branch.index) && branch.error}
              <tr class="error-row">
                <td colspan="4">
                  <pre class="error-log">{branch.error}</pre>
                </td>
              </tr>
            {/if}
          {/each}
          {#if branches.length === 0}
            <tr>
              <td colspan="4" class="empty-msg">{t('workflow.branch_status_no_branches')}</td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>

    <!-- Action buttons -->
    <div class="panel-actions">
      {#if failed_count > 0 && on_retry_failed}
        <button class="btn action-btn retry-btn" onclick={() => on_retry_failed?.()}>
          &#x21BB; {t('workflow.branch_status_retry_failed', { n: failed_count })}
        </button>
      {/if}
      {#if (running_count > 0 || pending_count > 0) && on_abort_all}
        <button class="btn action-btn abort-btn" onclick={() => on_abort_all?.()}>
          &#x26D4; {t('workflow.branch_status_abort_all')}
        </button>
      {/if}
      <button class="btn action-btn export-btn" onclick={export_csv} disabled={branches.length === 0}>
        &#x2913; {t('workflow.result_panel_export_csv')}
      </button>
    </div>
  </div>
{/if}

<style>
  .branch-panel {
    display: flex;
    flex-direction: column;
    width: 420px;
    max-height: 100%;
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
    border-left: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 13px;
    color: var(--text-color, light-dark(#374151, #eee));
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }

  .panel-title {
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .panel-icon {
    font-size: 16px;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    cursor: pointer;
    font-size: 18px;
    padding: 4px 8px;
    border-radius: 4px;
    line-height: 1;
  }
  .close-btn:hover {
    color: var(--text-color, light-dark(#374151, #eee));
    background: var(--surface-bg-hover, light-dark(#e5e7eb, #3a3a3a));
  }

  /* Progress section */
  .progress-section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }

  .progress-label {
    font-size: 12px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    margin-bottom: 8px;
  }

  .progress-track {
    height: 8px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08)));
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .status-counts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .count-chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
  }
  .count-chip.completed { background: rgba(34,197,94,0.15); color: #4ade80; }
  .count-chip.running   { background: rgba(59,130,246,0.15); color: #60a5fa; }
  .count-chip.pending   { background: rgba(71,85,105,0.15);  color: #94a3b8; }
  .count-chip.failed    { background: rgba(239,68,68,0.15);  color: #f87171; }
  .count-chip.skipped   { background: rgba(107,114,128,0.15); color: #9ca3af; }

  /* Table */
  .table-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .branch-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .branch-table thead {
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .branch-table th {
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

  .branch-table th.sortable {
    cursor: pointer;
    user-select: none;
  }
  .branch-table th.sortable:hover {
    color: var(--text-color, light-dark(#374151, #eee));
  }

  .branch-table td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#e5e7eb, #2a2a2e));
    vertical-align: middle;
  }

  .branch-row {
    transition: background 0.1s;
  }
  .branch-row:hover {
    background: var(--surface-bg-hover, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.04)));
  }
  .branch-row.clickable {
    cursor: pointer;
  }

  .col-index {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    width: 36px;
    text-align: right;
  }

  .col-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .col-status {
    width: 90px;
  }

  .status-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .col-result {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .error-toggle {
    background: none;
    border: none;
    color: #f87171;
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    font-family: inherit;
  }
  .error-toggle:hover {
    text-decoration: underline;
  }

  .error-row td {
    padding: 0 10px 8px;
    background: rgba(239, 68, 68, 0.05);
  }

  .error-log {
    margin: 0;
    padding: 8px;
    font-size: 11px;
    color: #f87171;
    background: rgba(239, 68, 68, 0.08);
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 120px;
    overflow-y: auto;
  }

  .empty-msg {
    text-align: center;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    padding: 24px 10px !important;
    font-style: italic;
  }

  /* Action buttons */
  .panel-actions {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    flex-wrap: wrap;
  }

  .action-btn {
    font-size: 11px;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1)));
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
  }
  .action-btn:hover {
    background: var(--btn-bg-hover, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.2)));
  }
  .action-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .retry-btn {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.3);
  }
  .retry-btn:hover {
    background: rgba(245, 158, 11, 0.1);
  }

  .abort-btn {
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.3);
  }
  .abort-btn:hover {
    background: rgba(239, 68, 68, 0.1);
  }
</style>

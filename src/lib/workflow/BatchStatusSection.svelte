<script lang="ts">
  /**
   * BatchStatusSection — elegant batch execution status display.
   *
   * Shows a summary bar + clickable structure list with per-structure details.
   * Polls running sub-steps for live energy/force from OSZICAR.
   * Embedded in NodeStatusPanel when sub-steps are detected.
   */
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { get_convergence, type ConvergencePoint } from '$lib/api/workflow'
  import { pending_open_structure } from './workflow-state.svelte'
  import { download } from '$lib/io/fetch'

  interface SubStep {
    index: number
    status: string
    label?: string
    composition?: string
    energy?: number
    max_force?: number
    job_id?: string
    work_dir?: string
    sub_step_id?: string  // DB step ID for convergence polling
    error?: string
    contcar?: string  // POSCAR/CONTCAR output string for viewing structure
  }

  interface Props {
    sub_steps: SubStep[]
    workflow_id?: string
    node_id?: string
    onview_file?: (work_dir: string) => void
  }

  let { sub_steps, workflow_id, node_id, onview_file }: Props = $props()

  load_i18n_module('workflow')

  let expanded_idx = $state<number | null>(null)
  let branch_files = $state<Record<number, string[]>>({})
  let file_preview = $state<{ name: string; content: string } | null>(null)

  // ─── Live convergence data for running sub-steps ───
  let live_data = $state<Record<number, { energy?: number; max_force?: number; step?: number }>>({})
  let live_polling = $state(false)
  let live_loading = $state(false)

  const has_running = $derived(sub_steps.some(s =>
    s.status === 'running' || s.status === 'queued' || s.status === 'submitting'
  ))

  // Poll only when user opts in (can be slow with many structures on HPC)
  $effect(() => {
    if (!live_polling || !workflow_id || !node_id || !has_running) return
    let cancelled = false
    const poll = async () => {
      live_loading = true
      const running = sub_steps.filter(s =>
        s.status === 'running' || s.status === 'queued' || s.status === 'submitting'
      )
      for (const s of running) {
        if (cancelled) break
        const sub_id = s.sub_step_id || `${node_id}__sub_${s.index}`
        try {
          const data = await get_convergence(workflow_id!, sub_id)
          if (cancelled) break
          const last = data.points?.[data.points.length - 1]
          if (last) {
            live_data = { ...live_data, [s.index]: { energy: last.energy, max_force: last.max_force, step: last.step } }
          }
        } catch { /* sub-step may not have OSZICAR yet */ }
      }
      if (!cancelled) live_loading = false
    }
    poll()
    const interval = setInterval(poll, 10_000)
    return () => { cancelled = true; clearInterval(interval) }
  })

  // ─── Summary stats ───
  const counts = $derived.by(() => {
    const c = { total: 0, completed: 0, running: 0, pending: 0, failed: 0 }
    for (const s of sub_steps) {
      c.total++
      if (s.status === 'completed') c.completed++
      else if (s.status === 'running' || s.status === 'queued' || s.status === 'submitting') c.running++
      else if (s.status === 'failed') c.failed++
      else c.pending++
    }
    return c
  })

  const progress_pct = $derived(counts.total > 0 ? Math.round(counts.completed / counts.total * 100) : 0)

  function status_icon(status: string): string {
    if (status === 'completed') return '✓'
    if (status === 'running' || status === 'queued' || status === 'submitting') return '◌'
    if (status === 'failed') return '✕'
    return '·'
  }

  function status_color(status: string): string {
    if (status === 'completed') return 'var(--bs-green, #22c55e)'
    if (status === 'running' || status === 'queued' || status === 'submitting') return 'var(--bs-blue, #3b82f6)'
    if (status === 'failed') return 'var(--bs-red, #ef4444)'
    return 'var(--bs-gray, #94a3b8)'
  }
</script>

<div class="batch-status">
  <!-- ═══ Summary ═══ -->
  <div class="bs-summary">
    <div class="bs-summary-row">
      {#if counts.completed > 0}<span class="bs-stat" style:color="var(--bs-green, #22c55e)">{t('workflow.batch_status_completed', { n: String(counts.completed) })}</span>{/if}
      {#if counts.running > 0}<span class="bs-stat" style:color="var(--bs-blue, #3b82f6)">{t('workflow.batch_status_running', { n: String(counts.running) })}</span>{/if}
      {#if counts.pending > 0}<span class="bs-stat" style:color="var(--bs-gray, #94a3b8)">{t('workflow.batch_status_pending', { n: String(counts.pending) })}</span>{/if}
      {#if counts.failed > 0}<span class="bs-stat" style:color="var(--bs-red, #ef4444)">{t('workflow.batch_status_failed', { n: String(counts.failed) })}</span>{/if}
    </div>
    <div class="bs-progress-track">
      {#if counts.completed > 0}
        <div class="bs-progress-bar bs-bar-completed" style:width="{counts.completed / counts.total * 100}%"></div>
      {/if}
      {#if counts.running > 0}
        <div class="bs-progress-bar bs-bar-running" style:width="{counts.running / counts.total * 100}%"></div>
      {/if}
      {#if counts.failed > 0}
        <div class="bs-progress-bar bs-bar-failed" style:width="{counts.failed / counts.total * 100}%"></div>
      {/if}
    </div>
    <div class="bs-pct-row">
      <span class="bs-pct">{t('workflow.batch_status_complete_pct', { n: String(progress_pct) })}</span>
      {#if has_running}
        <label class="bs-live-toggle" title={t('workflow.batch_status_live_polling_help')}>
          <input type="checkbox" bind:checked={live_polling} />
          <span>{t('workflow.batch_status_live')}{#if live_loading}...{/if}</span>
        </label>
      {/if}
    </div>
  </div>

  <!-- ═══ Structure list ═══ -->
  <div class="bs-list">
    {#each sub_steps as step (step.index)}
      {@const is_expanded = expanded_idx === step.index}
      <div class="bs-item" class:expanded={is_expanded}>
        <!-- Row: clickable header -->
        <button class="bs-item-header" onclick={() => expanded_idx = is_expanded ? null : step.index}>
          <span class="bs-icon" style:color={status_color(step.status)}>{status_icon(step.status)}</span>
          <span class="bs-idx">#{step.index + 1}</span>
          <span class="bs-label">{step.composition || step.label || t('workflow.batch_status_structure_fallback', { n: String(step.index + 1) })}</span>
          <span class="bs-metrics">
            {#if (live_data[step.index]?.energy ?? step.energy) != null}<span class="bs-energy">{(live_data[step.index]?.energy ?? step.energy)?.toFixed(3)} eV</span>{/if}
            {#if (live_data[step.index]?.max_force ?? step.max_force) != null}<span class="bs-force">{(live_data[step.index]?.max_force ?? step.max_force)?.toFixed(3)} eV/A</span>{/if}
            {#if live_data[step.index]?.step != null}<span class="bs-ionic-step">{t('workflow.batch_status_step', { n: String(live_data[step.index].step) })}</span>{/if}
          </span>
          <span class="bs-status-tag" style:color={status_color(step.status)}>{step.status}</span>
          <span class="bs-expand-icon" class:open={is_expanded}>▸</span>
        </button>

        <!-- Expanded detail -->
        {#if is_expanded}
          <div class="bs-detail">
            {#if step.job_id}
              <div class="bs-detail-row">
                <span class="bs-detail-key">{t('workflow.batch_status_job_id')}</span>
                <span class="bs-detail-val">{step.job_id}</span>
              </div>
            {/if}
            {#if step.work_dir}
              <div class="bs-detail-row">
                <span class="bs-detail-key">{t('workflow.batch_status_work_dir')}</span>
                <span class="bs-detail-val bs-mono">{step.work_dir}</span>
              </div>
            {/if}
            {#if (live_data[step.index]?.energy ?? step.energy) != null}
              <div class="bs-detail-row">
                <span class="bs-detail-key">{t('workflow.batch_status_energy')}</span>
                <span class="bs-detail-val">{(live_data[step.index]?.energy ?? step.energy)?.toFixed(6)} eV{#if live_data[step.index]} ({t('workflow.batch_status_live').toLowerCase()}){/if}</span>
              </div>
            {/if}
            {#if (live_data[step.index]?.max_force ?? step.max_force) != null}
              <div class="bs-detail-row">
                <span class="bs-detail-key">{t('workflow.batch_status_max_force')}</span>
                <span class="bs-detail-val">{(live_data[step.index]?.max_force ?? step.max_force)?.toFixed(6)} eV/A{#if live_data[step.index]} ({t('workflow.batch_status_live').toLowerCase()}){/if}</span>
              </div>
            {/if}
            {#if live_data[step.index]?.step != null}
              <div class="bs-detail-row">
                <span class="bs-detail-key">{t('workflow.batch_status_ionic_step')}</span>
                <span class="bs-detail-val">{live_data[step.index].step}</span>
              </div>
            {/if}
            {#if step.error}
              <div class="bs-detail-row bs-error">
                <span class="bs-detail-key">{t('workflow.batch_status_error')}</span>
                <span class="bs-detail-val">{step.error}</span>
              </div>
            {/if}
            <div style="display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap;">
              {#if step.contcar}
                <button class="bs-files-btn" onclick={async () => {
                  try {
                    const { parse_poscar } = await import('$lib/structure/parse')
                    const parsed = parse_poscar(step.contcar!)
                    if (parsed) {
                      pending_open_structure.structure = parsed
                      pending_open_structure.label = step.label ?? `Branch #${step.index + 1}`
                      pending_open_structure.seq++
                    }
                  } catch (err) {
                    console.error(`Failed to parse structure:`, err)
                  }
                }}>
                  {t('workflow.batch_status_open_structure_in_tab')}
                </button>
                <button class="bs-files-btn" onclick={() => {
                  download(step.contcar!, `${(step.label ?? `branch_${step.index}`).replace(/[^a-zA-Z0-9()-]/g, '_')}_CONTCAR`, 'text/plain')
                }}>
                  {t('workflow.batch_status_download_contcar')}
                </button>
              {/if}
              {#if step.work_dir}
                <button class="bs-files-btn" onclick={async () => {
                  try {
                    const { API_BASE } = await import('$lib/api/config')
                    const resp = await fetch(`${API_BASE}/hpc/files/list`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ session_id: '__local__', path: step.work_dir }),
                    })
                    if (resp.ok) {
                      const data = await resp.json()
                      const fileList = (data.files || [])
                        .filter((f: any) => f.name !== '.' && f.name !== '..')
                        .map((f: any) => f.name)
                      branch_files = { ...branch_files, [step.index]: fileList }
                    }
                  } catch (err) {
                    console.error(`Failed to list files:`, err)
                  }
                }}>
                  {t('workflow.batch_status_list_output_files')}
                </button>
              {/if}
            </div>
            {#if branch_files[step.index]}
              <div class="bs-file-list">
                {#each branch_files[step.index] as fname}
                  {@const is_text = /\.(log|py|txt|json|csv|yaml|yml)$/.test(fname) || ['CONTCAR', 'POSCAR', 'INCAR', 'KPOINTS', 'POTCAR', 'OUTCAR', 'OSZICAR'].includes(fname)}
                  {#if is_text}
                    <button class="bs-file-item" onclick={async () => {
                      try {
                        const { API_BASE } = await import('$lib/api/config')
                        const resp = await fetch(`${API_BASE}/hpc/files/read-content`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ session_id: '__local__', file_path: step.work_dir + '/' + fname }),
                        })
                        if (resp.ok) {
                          const data = await resp.json()
                          if (data.success && data.content != null) {
                            file_preview = { name: fname, content: data.content || t('workflow.batch_status_empty_file') }
                          }
                        }
                      } catch (err) {
                        console.error(`Failed to read ${fname}:`, err)
                      }
                    }}>
                      📄 {fname}
                    </button>
                  {:else}
                    <span class="bs-file-item" style="opacity: 0.5; cursor: default;" title={t('workflow.batch_status_binary_file')}>📦 {fname}</span>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

{#if file_preview}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="bs-file-overlay" onclick={() => file_preview = null}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="bs-file-modal" onclick={(e) => e.stopPropagation()}>
      <div class="bs-file-modal-header">
        <span>{file_preview.name}</span>
        <button onclick={() => file_preview = null}>✕</button>
      </div>
      <pre class="bs-file-modal-content">{file_preview.content}</pre>
    </div>
  </div>
{/if}

<style>
  .batch-status { display: flex; flex-direction: column; gap: 8px; }

  /* Summary */
  .bs-summary { display: flex; flex-direction: column; gap: 4px; }
  .bs-summary-row { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; }
  .bs-stat { font-weight: 500; }
  .bs-progress-track { height: 6px; border-radius: 3px; background: var(--input-bg, rgba(0,0,0,0.05)); display: flex; overflow: hidden; }
  .bs-progress-bar { height: 100%; transition: width 0.3s ease; }
  .bs-bar-completed { background: #22c55e; }
  .bs-bar-running { background: #3b82f6; animation: pulse 1.5s ease-in-out infinite; }
  .bs-bar-failed { background: #ef4444; }
  .bs-pct-row { display: flex; justify-content: space-between; align-items: center; }
  .bs-pct { font-size: 11px; color: var(--text-color-dim, #999); }
  .bs-live-toggle { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-color-dim, #999); cursor: pointer; }
  .bs-live-toggle input { accent-color: var(--accent-color, #3b82f6); width: 13px; height: 13px; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

  /* List */
  .bs-list { display: flex; flex-direction: column; border: 1px solid var(--dialog-border, rgba(0,0,0,0.06)); border-radius: 8px; overflow: hidden; }

  .bs-item { border-bottom: 1px solid var(--dialog-border, rgba(0,0,0,0.04)); }
  .bs-item:last-child { border-bottom: none; }
  .bs-item.expanded { background: color-mix(in srgb, var(--accent-color, #3b82f6) 4%, transparent); }

  .bs-item-header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; width: 100%; background: none; border: none; cursor: pointer; text-align: left; font-size: 12px; color: var(--text-color, #333); }
  .bs-item-header:hover { background: var(--input-bg, rgba(0,0,0,0.02)); }

  .bs-icon { font-size: 13px; font-weight: 700; width: 16px; text-align: center; flex-shrink: 0; }
  .bs-idx { color: var(--text-color-dim, #999); min-width: 24px; }
  .bs-label { font-family: monospace; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bs-metrics { display: flex; gap: 6px; flex-shrink: 0; }
  .bs-energy { font-family: monospace; font-size: 10px; color: var(--text-color-dim, #666); }
  .bs-force { font-family: monospace; font-size: 10px; color: var(--text-color-dim, #888); }
  .bs-ionic-step { font-size: 9px; color: var(--text-color-dim, #aaa); }
  .bs-status-tag { font-size: 10px; text-transform: uppercase; font-weight: 500; flex-shrink: 0; }
  .bs-expand-icon { font-size: 10px; color: var(--text-color-dim, #999); transition: transform 0.15s; }
  .bs-expand-icon.open { transform: rotate(90deg); }

  /* Detail */
  .bs-detail { padding: 4px 10px 8px 32px; display: flex; flex-direction: column; gap: 3px; }
  .bs-detail-row { display: flex; gap: 8px; font-size: 11px; }
  .bs-detail-key { color: var(--text-color-dim, #999); min-width: 60px; flex-shrink: 0; }
  .bs-detail-val { color: var(--text-color, #333); word-break: break-all; }
  .bs-mono { font-family: monospace; font-size: 10px; }
  .bs-error .bs-detail-val { color: #ef4444; }

  .bs-files-btn { margin-top: 4px; font-size: 11px; padding: 3px 10px; border: 1px solid var(--dialog-border, rgba(0,0,0,0.1)); border-radius: 4px; background: var(--input-bg, #f5f5f5); color: var(--text-color, #333); cursor: pointer; align-self: flex-start; }
  .bs-files-btn:hover { background: var(--dialog-border, rgba(0,0,0,0.06)); }

  .bs-file-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .bs-file-item { font-size: 10px; font-family: monospace; padding: 2px 8px; border: 1px solid var(--dialog-border, rgba(0,0,0,0.1)); border-radius: 3px; background: var(--input-bg, #f5f5f5); color: var(--text-color, #333); cursor: pointer; }
  .bs-file-item:hover { background: var(--dialog-border, rgba(0,0,0,0.06)); color: var(--accent-color, #3b82f6); }

  .bs-file-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 16px; overflow: auto; }
  .bs-file-modal { background: var(--pane-bg, #1a1a2e); border: 1px solid var(--dialog-border, #404040); border-radius: 8px; width: min(700px, calc(100vw - 32px)); max-height: calc(100vh - 32px); display: flex; flex-direction: column; overflow: hidden; }
  .bs-file-modal-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; padding: 8px 12px; border-bottom: 1px solid var(--dialog-border, #404040); font-size: 12px; font-weight: 600; color: var(--text-color, #eee); }
  .bs-file-modal-header span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .bs-file-modal-header button { background: none; border: none; color: var(--text-color-dim, #999); cursor: pointer; font-size: 14px; padding: 2px 6px; }
  .bs-file-modal-header button:hover { color: var(--text-color, #eee); }
  .bs-file-modal-content { padding: 12px; overflow: auto; font-size: 11px; font-family: monospace; color: var(--text-color, #ccc); white-space: pre-wrap; word-break: break-all; margin: 0; flex: 1; }
</style>

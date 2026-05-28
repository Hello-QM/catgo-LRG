<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { StepForces } from '$lib/api/workflow'
  import * as api from '$lib/api/workflow'

  load_i18n_module(`workflow`)

  let {
    workflow_id,
    node_id,
    total_steps = 0,
    onload_forces,
  }: {
    workflow_id: string
    node_id: string
    total_steps: number
    onload_forces?: (frames: StepForces[]) => void
  } = $props()

  let frame_input = $state(`-1`)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let status = $state<string | null>(null)

  /** Parse frame spec: -1, 5, 1-3, 1,3,5 */
  function parse_frames(input: string): number[] {
    const trimmed = input.trim()
    if (!trimmed) return []
    const steps: number[] = []
    for (const part of trimmed.split(`,`)) {
      const p = part.trim()
      if (!p) continue
      const range_match = p.match(/^(\d+)\s*-\s*(\d+)$/)
      if (range_match) {
        const start = parseInt(range_match[1])
        const end = parseInt(range_match[2])
        for (let i = start; i <= end; i++) steps.push(i)
      } else {
        const n = parseInt(p)
        if (!isNaN(n)) steps.push(n)
      }
    }
    return steps
  }

  async function load_forces() {
    const frames = parse_frames(frame_input)
    if (frames.length === 0) {
      error = t(`workflow.invalid_frame_input`)
      return
    }
    loading = true
    error = null
    status = t(`workflow.fetching_frames`, { n: frames.length })

    try {
      const results: StepForces[] = []
      for (let i = 0; i < frames.length; i++) {
        const ionic_step = frames[i] === -1 ? 0 : frames[i]
        if (frames.length > 1) {
          status = t(`workflow.fetching_frame_progress`, { current: i + 1, total: frames.length, step: frames[i] })
        }
        const data = await api.get_step_forces(workflow_id, node_id, ionic_step)
        if (!data.success) {
          error = data.message || (data as any).error || t(`workflow.failed_at_step`, { n: frames[i] })
          return
        }
        if (!data.forces?.length) {
          error = t(`workflow.no_force_data_step`, { n: frames[i] })
          return
        }
        if (data.total_steps > 0) total_steps = data.total_steps
        results.push(data)
      }

      status = t(`workflow.loading_3d_viewer`)
      await new Promise(r => setTimeout(r, 50))
      await onload_forces?.(results)
      if (results.length === 1) {
        status = t(`workflow.step_atoms`, { step: results[0].step, atoms: results[0].forces.length })
      } else {
        status = t(`workflow.frames_loaded_trajectory`, { n: results.length })
      }
    } catch (err) {
      error = String(err)
    } finally {
      loading = false
    }
  }
</script>

<div class="fv-controls">
  <div class="sp-section-title">{t(`workflow.force_visualization`)}</div>

  <div class="fv-frame-row">
    <label class="fv-label">
      {t(`workflow.step`)}
      <input
        type="text"
        class="fv-step-input"
        bind:value={frame_input}
        placeholder="-1"
        onkeydown={(e) => { if (e.key === `Enter`) load_forces() }}
      />
    </label>
    {#if total_steps > 0}
      <span class="fv-total">/ {total_steps}</span>
    {/if}
    <span class="fv-hint">-1=last, 3, 1-5</span>
  </div>

  <div class="fv-action-row">
    <button class="fv-load-btn" onclick={load_forces} disabled={loading}>
      {loading ? t(`workflow.loading`) : t(`workflow.load_forces`)}
    </button>
    {#if status}
      <span class="fv-status">{status}</span>
    {/if}
  </div>

  {#if error}
    <div class="fv-error">{error}</div>
  {/if}
</div>

<style>
  .fv-controls {
    padding: 0;
  }
  .fv-frame-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .fv-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    white-space: nowrap;
  }
  .fv-step-input {
    width: 72px;
    padding: 2px 4px;
    font-size: 11px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px;
    background: var(--input-bg, light-dark(#fff, #2a2b30));
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: inherit;
  }
  .fv-total {
    font-size: 11px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    white-space: nowrap;
  }
  .fv-hint {
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #6b7280));
    white-space: nowrap;
  }
  .fv-action-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .fv-load-btn {
    padding: 3px 10px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    background: var(--accent-color, #3b82f6);
    color: #fff;
    cursor: pointer;
    font-family: inherit;
  }
  .fv-load-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .fv-load-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .fv-status {
    font-size: 10px;
    color: #22c55e;
    font-weight: 500;
  }
  .fv-error {
    margin-top: 4px;
    padding: 4px 6px;
    font-size: 10px;
    color: #ef4444;
    background: rgba(239, 68, 68, 0.08);
    border-radius: 3px;
  }
</style>

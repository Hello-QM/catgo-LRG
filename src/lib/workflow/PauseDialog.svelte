<script lang="ts">
  import '$lib/dialog-shared.css'
  import { STATUS_COLORS } from './workflow-types'

  export interface PauseJob {
    step_id: string
    label: string
    status: string
    job_id: string
    host?: string
  }

  let {
    show = false,
    jobs = [],
    onpause,
    onclose,
  }: {
    show?: boolean
    jobs?: PauseJob[]
    onpause?: (cancel_step_ids: string[]) => void
    onclose?: () => void
  } = $props()

  let selected = $state(new Set<string>())

  // Auto-select all jobs when dialog opens
  $effect(() => {
    if (show) {
      selected = new Set(jobs.map(j => j.step_id))
    }
  })

  function toggle(step_id: string) {
    const s = new Set(selected)
    if (s.has(step_id)) s.delete(step_id)
    else s.add(step_id)
    selected = s
  }

  function select_all() {
    selected = new Set(jobs.map(j => j.step_id))
  }

  function select_none() {
    selected = new Set()
  }
</script>

{#if show}
  <div class="dialog-backdrop" onclick={onclose} onkeydown={e => e.key === `Escape` && onclose?.()}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dialog-modal pause-dialog" onclick={e => e.stopPropagation()}>
      <div class="modal-header">
        <h3 class="modal-title">Pause Workflow</h3>
        <button class="close-btn" onclick={onclose}>✕</button>
      </div>

      <div class="pd-body">
        {#if jobs.length === 0}
          <div class="pd-empty">No active HPC jobs</div>
        {:else}
          <div class="pd-desc">Select jobs to cancel. Unchecked jobs will continue running on the HPC.</div>
          <div class="pd-select-bar">
            <button class="pd-link" onclick={select_all}>Select All</button>
            <span class="pd-sep">|</span>
            <button class="pd-link" onclick={select_none}>Select None</button>
            <span class="pd-count">{selected.size}/{jobs.length} selected</span>
          </div>
          <div class="pd-list">
            {#each jobs as job (job.step_id)}
              {@const checked = selected.has(job.step_id)}
              {@const color = STATUS_COLORS[job.status] ?? `#888`}
              <label class="pd-job" class:checked>
                <input type="checkbox" checked={checked} onchange={() => toggle(job.step_id)} />
                <div class="pd-job-info">
                  <span class="pd-job-label">{job.label}</span>
                  <span class="pd-job-meta">
                    <span class="pd-status" style="color:{color}">{job.status}</span>
                    {#if job.job_id}
                      <span class="pd-jobid">#{job.job_id}</span>
                    {/if}
                    {#if job.host}
                      <span class="pd-host">{job.host}</span>
                    {/if}
                  </span>
                </div>
              </label>
            {/each}
          </div>
        {/if}
      </div>

      <div class="pd-footer">
        <button class="pd-btn secondary" onclick={onclose}>Cancel</button>
        <button class="pd-btn secondary" onclick={() => onpause?.([])}>
          Pause Only
        </button>
        <button class="pd-btn primary" onclick={() => onpause?.([...selected])}>
          {#if selected.size === 0}
            Pause Only
          {:else if selected.size === jobs.length}
            Cancel All & Pause
          {:else}
            Cancel {selected.size} & Pause
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .pause-dialog {
    width: 480px;
    max-width: 90vw;
  }

  .pd-body {
    padding: 16px 20px;
    overflow-y: auto;
    max-height: 60vh;
  }

  .pd-empty {
    text-align: center;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    padding: 24px 0;
  }

  .pd-desc {
    font-size: 12px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    margin-bottom: 12px;
  }

  .pd-select-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
    font-size: 11px;
  }

  .pd-link {
    background: none;
    border: none;
    color: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    text-decoration: underline;
  }

  .pd-link:hover {
    opacity: 0.8;
  }

  .pd-sep {
    color: var(--text-color-dim, light-dark(#d1d5db, #404040));
  }

  .pd-count {
    margin-left: auto;
    color: var(--text-color-dim, light-dark(#9ca3af, #6b7280));
  }

  .pd-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pd-job {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid var(--dialog-border, light-dark(#e5e7eb, #333));
    transition: background 0.15s;
  }

  .pd-job:hover {
    background: var(--surface-bg-hover, light-dark(#f3f4f6, #2a2a2a));
  }

  .pd-job.checked {
    background: light-dark(#fef2f2, #2a1a1a);
    border-color: light-dark(#fca5a5, #7f1d1d);
  }

  .pd-job input[type='checkbox'] {
    accent-color: #ef4444;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .pd-job-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .pd-job-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-color, light-dark(#1f2937, #eee));
  }

  .pd-job-meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
  }

  .pd-status {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .pd-jobid {
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    font-family: var(--font-mono, monospace);
  }

  .pd-host {
    color: var(--text-color-dim, light-dark(#9ca3af, #6b7280));
  }

  .pd-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }

  .pd-btn {
    padding: 7px 16px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid;
    transition: all 0.15s;
  }

  .pd-btn.secondary {
    background: var(--surface-bg, light-dark(#f9fafb, #2a2a2a));
    border-color: var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color, light-dark(#374151, #ccc));
  }

  .pd-btn.secondary:hover {
    background: var(--surface-bg-hover, light-dark(#f3f4f6, #333));
  }

  .pd-btn.primary {
    background: #ef4444;
    border-color: #dc2626;
    color: #fff;
  }

  .pd-btn.primary:hover {
    background: #dc2626;
  }
</style>

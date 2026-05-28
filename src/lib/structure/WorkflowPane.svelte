<script lang="ts">
  import { DraggablePane } from '$lib'
  import { API_BASE } from '$lib/api/config'
  import type { AnyStructure } from '$lib/structure'
  import type { Snippet } from 'svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')
  load_i18n_module('common')

  let {
    show = $bindable(false),
    max_height = '',
    children,
    structure,
    on_open_workflow_editor,
  }: {
    show?: boolean
    max_height?: string
    children?: Snippet
    structure?: AnyStructure
    /** Called to open a workflow in the full editor. Receives workflow_id. */
    on_open_workflow_editor?: (workflow_id: string) => void
  } = $props()

  // Live workflow status polling
  interface WorkflowStep {
    id: string
    node_type: string
    label: string
    status: string
    error_message?: string | null
    started_at?: string | null
    completed_at?: string | null
    result_json?: string | null
  }

  interface WorkflowInfo {
    id: string
    name: string
    status: string
    step_count: number
    completed_steps: number
  }

  let workflows = $state<WorkflowInfo[]>([])
  let active_workflow = $state<WorkflowInfo | null>(null)
  let active_steps = $state<WorkflowStep[]>([])
  let poll_timer: ReturnType<typeof setInterval> | undefined
  let creating = $state(false)
  let sending = $state(false)
  let error_msg = $state(``)

  async function fetch_workflows() {
    try {
      const resp = await fetch(`${API_BASE}/workflow/`)
      if (!resp.ok) return
      const data = await resp.json()
      workflows = (data as WorkflowInfo[]).sort((a, b) =>
        (b.id > a.id ? 1 : -1)
      )
      // Auto-select most recent running or latest workflow
      const running = workflows.find(w => w.status === `running`)
      const latest = workflows[0]
      if (running) {
        active_workflow = running
      } else if (!active_workflow || !workflows.find(w => w.id === active_workflow!.id)) {
        active_workflow = latest ?? null
      } else {
        // Update the active one
        active_workflow = workflows.find(w => w.id === active_workflow!.id) ?? latest ?? null
      }
    } catch {
      // silently skip — backend may not be running
    }
  }

  async function fetch_steps() {
    if (!active_workflow) {
      active_steps = []
      return
    }
    try {
      const resp = await fetch(`${API_BASE}/workflow/${active_workflow.id}/steps`)
      if (!resp.ok) return
      active_steps = await resp.json()
    } catch {
      // silently skip
    }
  }

  async function poll() {
    await fetch_workflows()
    await fetch_steps()
  }

  $effect(() => {
    if (show) {
      poll()
      poll_timer = setInterval(poll, 2000)
    }
    return () => {
      if (poll_timer) {
        clearInterval(poll_timer)
        poll_timer = undefined
      }
    }
  })

  function status_icon(status: string): string {
    switch (status) {
      case `completed`: return `\u2705`
      case `running`: return `\u23F3`
      case `failed`: return `\u274C`
      case `pending`: return `\u23F8`
      default: return `\u2022`
    }
  }

  function status_class(status: string): string {
    switch (status) {
      case `completed`: return `step-completed`
      case `running`: return `step-running`
      case `failed`: return `step-failed`
      default: return `step-pending`
    }
  }

  function format_duration(start?: string | null, end?: string | null): string {
    if (!start) return ``
    const s = new Date(start).getTime()
    const e = end ? new Date(end).getTime() : Date.now()
    const ms = e - s
    if (ms < 1000) return `<1s`
    if (ms < 60000) return `${Math.round(ms / 1000)}s`
    return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
  }

  function open_editor(workflow_id?: string) {
    const id = workflow_id ?? active_workflow?.id
    if (!id) return
    if (on_open_workflow_editor) {
      on_open_workflow_editor(id)
    } else {
      window.location.hash = `#workflow?id=${id}`
    }
    show = false
  }

  /** Fetch structure from viewer backend (authoritative) or fall back to prop */
  async function get_current_structure(): Promise<AnyStructure | null> {
    try {
      const resp = await fetch(`${API_BASE}/view/structure/current`)
      if (resp.ok) {
        const data: AnyStructure = await resp.json()
        if (data?.sites?.length) return data
      }
    } catch { /* fall through */ }
    return structure ?? null
  }

  async function create_workflow_with_structure() {
    if (creating) return
    creating = true
    error_msg = ``
    try {
      const current = await get_current_structure()
      // Build initial graph with structure_input node pre-loaded with current structure
      const ts = Date.now()
      const si_id = `n${ts}-si`
      const si_params: Record<string, unknown> = {}
      if (current) {
        si_params.structure_json = JSON.stringify(current)
      }
      const init_graph = {
        nodes: [{
          id: si_id,
          type: `structure_input`,
          x: 80,
          y: 200,
          params: si_params,
        }],
        edges: [],
      }
      const resp = await fetch(`${API_BASE}/workflow/`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({
          name: t('structure.workflow_new'),
          graph_json: JSON.stringify(init_graph),
        }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || t('structure.failed_create_workflow'))
      }
      const wf = await resp.json()
      // Open in editor
      open_editor(wf.id)
    } catch (err) {
      error_msg = String(err)
      console.error(`[WorkflowPane] create_workflow_with_structure:`, err)
    } finally {
      creating = false
    }
  }

  async function send_structure_to_workflow(wf_id: string) {
    if (sending) return
    sending = true
    error_msg = ``
    try {
      const current = await get_current_structure()
      if (!current?.sites?.length) {
        error_msg = t('structure.no_structure_loaded_in_viewer')
        return
      }

      // Fetch the workflow graph
      const resp = await fetch(`${API_BASE}/workflow/${wf_id}`)
      if (!resp.ok) throw new Error(t('structure.failed_load_workflow'))
      const wf = await resp.json()
      const graph = JSON.parse(wf.graph_json || `{"nodes":[],"edges":[]}`)
      const nodes = graph.nodes || []

      // Find the structure_input node
      const si_node = nodes.find((n: Record<string, unknown>) => n.type === `structure_input`)
      if (!si_node) throw new Error(t('structure.workflow_has_no_structure_input'))

      // Update its params with the current structure
      if (!si_node.params) si_node.params = {}
      si_node.params.structure_json = JSON.stringify(current)

      // Extract formula for display
      const sites = (current.sites || []) as Array<Record<string, unknown>>
      const counts: Record<string, number> = {}
      for (const site of sites) {
        const sp = site.species as Array<{ element: string }> | undefined
        const el = sp?.[0]?.element || (site.label as string) || `?`
        counts[el] = (counts[el] || 0) + 1
      }
      si_node.params.formula = Object.entries(counts).map(([el, n]) => n === 1 ? el : `${el}${n}`).join(``)
      si_node.params.n_atoms = sites.length

      // Save updated graph
      const update_resp = await fetch(`${API_BASE}/workflow/${wf_id}`, {
        method: `PUT`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({ graph_json: JSON.stringify(graph) }),
      })
      if (!update_resp.ok) throw new Error(t('structure.failed_update_workflow'))

      // Open in editor
      open_editor(wf_id)
    } catch (err) {
      error_msg = String(err)
      console.error(`[WorkflowPane] send_structure_to_workflow:`, err)
    } finally {
      sending = false
    }
  }

  async function delete_workflow(wf_id: string, wf_name: string) {
    if (!confirm(t('app.delete_item_confirm', { name: wf_name }))) return
    try {
      const resp = await fetch(`${API_BASE}/workflow/${wf_id}`, { method: `DELETE` })
      if (!resp.ok) {
        error_msg = t('structure.failed_delete_reason', { reason: resp.statusText })
        return
      }
      workflows = workflows.filter(w => w.id !== wf_id)
      if (active_workflow?.id === wf_id) {
        active_workflow = workflows[0] ?? null
        await fetch_steps()
      }
    } catch (err) {
      error_msg = t('structure.delete_failed_reason', { reason: String(err) })
      console.error(`[WorkflowPane] delete:`, err)
    }
  }
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="28em"
  max_height={max_height || ``}
  pane_props={{ class: 'workflow-pane' }}
>
  <h4 class="pane-title">{t('common.workflow')}</h4>
  <div class="pane-content">
    {#if children}
      {@render children()}
    {:else}
      <!-- ══ Section 1: New Workflow ══ -->
      <div class="section-box new-section">
        <button class="new-workflow-btn" onclick={create_workflow_with_structure} disabled={creating}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {creating ? t('structure.creating') : structure ? t('structure.workflow_new_with_structure') : t('structure.workflow_new')}
        </button>
      </div>

      {#if error_msg}
        <div class="error-msg">{error_msg}</div>
      {/if}

      <!-- ══ Section 2: Active Workflow ══ -->
      {#if active_workflow}
        <div class="section-box active-section">
          <div class="section-label">{t('structure.current')}</div>
          <div class="wf-header">
            <button class="wf-name-btn" onclick={() => open_editor()} title={t('structure.open_editor')}>
              {active_workflow.name}
            </button>
            <span class="wf-badge wf-badge-{active_workflow.status}">{active_workflow.status}</span>
          </div>

          {#if active_steps.length > 0}
            <div class="wf-progress">{active_workflow.completed_steps}/{t('common.steps_count', { n: active_workflow.step_count })}</div>
            <div class="steps-list">
              {#each active_steps as step (step.id)}
                <div class="step-row {status_class(step.status)}">
                  <span class="step-icon">{status_icon(step.status)}</span>
                  <div class="step-info">
                    <span class="step-type">{step.label || step.node_type}</span>
                    {#if step.status === `running`}
                      <span class="step-duration">{format_duration(step.started_at)}</span>
                    {:else if step.status === `completed` && step.started_at}
                      <span class="step-duration">{format_duration(step.started_at, step.completed_at)}</span>
                    {/if}
                    {#if step.status === `completed` && step.result_json}
                      {@const result = (() => { try { return JSON.parse(step.result_json) } catch { return null } })()}
                      {#if result?.energy != null}
                        <span class="step-result">E = {result.energy.toFixed(3)} eV</span>
                      {/if}
                    {/if}
                    {#if step.error_message}
                      <span class="step-error">{step.error_message}</span>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>

            {#if active_workflow?.status === `completed`}
              <div class="wf-done-banner">{t('common.completed')}</div>
            {:else if active_workflow?.status === `failed`}
              <div class="wf-done-banner wf-done-failed">{t('common.failed')}</div>
            {/if}
          {:else}
            <div class="wf-progress">{t('structure.no_steps_yet')}</div>
          {/if}

          <div class="section-actions">
            {#if structure}
              <button class="section-btn send-btn" onclick={() => send_structure_to_workflow(active_workflow!.id)} disabled={sending}>
                {sending ? t('structure.sending') : t('structure.send_structure')}
              </button>
            {/if}
            <button class="section-btn editor-btn" onclick={() => open_editor()}>
              {t('structure.open_editor')}
            </button>
          </div>
        </div>
      {/if}

      <!-- ══ Section 3: Previous Workflows ══ -->
      {#if workflows.length > (active_workflow ? 1 : 0)}
        <div class="section-box history-section">
          <div class="section-label">{t('structure.previous')}</div>
          <div class="wf-list">
            {#each workflows.filter(w => w.id !== active_workflow?.id) as wf (wf.id)}
              <div class="wf-list-item">
                <button class="wf-list-btn" onclick={() => { active_workflow = wf; fetch_steps() }}>
                  <span class="wf-list-name">{wf.name}</span>
                  <span class="wf-badge wf-badge-{wf.status}">{wf.status}</span>
                </button>
                <button class="wf-delete-btn" onclick={() => delete_workflow(wf.id, wf.name)} title={t('common.delete')}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            {/each}
          </div>
        </div>
      {:else if !active_workflow}
        <div class="section-box">
          <p class="hint">{t('structure.no_workflows_yet')}</p>
        </div>
      {/if}
    {/if}
  </div>
</DraggablePane>

<style>
  /* ─── Section boxes ─── */
  .section-box {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 8px;
    background: rgba(255, 255, 255, 0.02);
  }
  .section-label {
    font-size: 0.65em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #64748b;
    margin-bottom: 8px;
  }

  /* ─── New Workflow section ─── */
  .new-section {
    border-color: rgba(59, 130, 246, 0.2);
    background: rgba(59, 130, 246, 0.04);
  }
  .new-workflow-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 0.85em;
    font-weight: 600;
    cursor: pointer;
    background: rgba(59, 130, 246, 0.15);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: #60a5fa;
    transition: all 0.15s;
  }
  .new-workflow-btn:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.25);
    border-color: rgba(59, 130, 246, 0.5);
  }
  .new-workflow-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error-msg {
    font-size: 0.75em;
    color: #ef4444;
    padding: 4px 8px;
    margin-bottom: 8px;
    border-radius: 4px;
    background: rgba(239, 68, 68, 0.1);
  }

  /* ─── Active workflow section ─── */
  .active-section {
    border-color: rgba(255, 255, 255, 0.12);
  }
  .wf-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .wf-name-btn {
    font-weight: 600;
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: none;
    color: #e2e8f0;
    cursor: pointer;
    padding: 0;
    text-align: left;
  }
  .wf-name-btn:hover {
    color: #60a5fa;
  }
  .wf-badge {
    font-size: 0.6em;
    padding: 2px 7px;
    border-radius: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    flex-shrink: 0;
  }
  .wf-badge-running { background: rgba(234, 179, 8, 0.2); color: #eab308; }
  .wf-badge-completed { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
  .wf-badge-failed { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
  .wf-badge-draft { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }

  .wf-progress {
    font-size: 0.7em;
    color: #64748b;
    margin-bottom: 6px;
  }
  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 6px;
  }
  .step-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 5px 7px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.02);
    font-size: 0.8em;
  }
  .step-icon { flex-shrink: 0; font-size: 0.85em; line-height: 1.4; }
  .step-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .step-type { font-weight: 500; }
  .step-duration { font-size: 0.8em; color: #64748b; }
  .step-result { font-size: 0.8em; color: #22c55e; font-family: monospace; }
  .step-error { font-size: 0.8em; color: #ef4444; word-break: break-word; }
  .step-running { background: rgba(234, 179, 8, 0.06); border-left: 2px solid #eab308; }
  .step-completed { background: rgba(34, 197, 94, 0.04); border-left: 2px solid #22c55e; }
  .step-failed { background: rgba(239, 68, 68, 0.04); border-left: 2px solid #ef4444; }
  .step-pending { border-left: 2px solid #475569; opacity: 0.5; }

  .wf-done-banner {
    text-align: center;
    padding: 5px 10px;
    margin: 4px 0;
    border-radius: 5px;
    font-size: 0.75em;
    font-weight: 600;
    background: rgba(34, 197, 94, 0.12);
    color: #22c55e;
  }
  .wf-done-failed { background: rgba(239, 68, 68, 0.12); color: #ef4444; }

  .section-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .section-btn {
    flex: 1;
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 0.75em;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
  }
  .section-btn:hover { background: rgba(255, 255, 255, 0.08); }
  .send-btn {
    border-color: rgba(34, 197, 94, 0.25);
    color: #22c55e;
  }
  .send-btn:hover { background: rgba(34, 197, 94, 0.12); border-color: rgba(34, 197, 94, 0.4); }
  .editor-btn {
    border-color: rgba(59, 130, 246, 0.25);
    color: #60a5fa;
  }
  .editor-btn:hover { background: rgba(59, 130, 246, 0.12); border-color: rgba(59, 130, 246, 0.4); }

  /* ─── Previous workflows section ─── */
  .history-section {
    border-color: rgba(255, 255, 255, 0.06);
    background: transparent;
  }
  .wf-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 140px;
    overflow-y: auto;
  }
  .wf-list-item {
    display: flex;
    align-items: center;
    border-radius: 4px;
    transition: background 0.15s;
  }
  .wf-list-item:hover { background: rgba(255, 255, 255, 0.04); }
  .wf-list-item:hover .wf-delete-btn { opacity: 1; }
  .wf-list-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 0.75em;
    min-width: 0;
    text-align: left;
  }
  .wf-list-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wf-delete-btn {
    flex-shrink: 0;
    padding: 4px 6px;
    background: none;
    border: none;
    color: #475569;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s;
  }
  .wf-delete-btn:hover { color: #ef4444; }

  .hint {
    font-size: 0.75em;
    text-align: center;
    color: #64748b;
    padding: 8px 0;
  }
</style>

<script lang="ts">
  import { t } from '$lib/i18n/index.svelte'
  import { WorkflowEditor } from '$lib/workflow'
  import * as api from '$lib/api/workflow'
  import {
    delete_v2_workflow,
    delete_v2_workflows,
    list_v2_workflows,
    type V2WorkflowSummary,
  } from '$lib/api/workflow-v2'
  import type { WorkflowSummary, WorkflowTemplate } from '$lib/workflow/workflow-types'
  import ProjectListView from '$lib/workflow/ProjectListView.svelte'
  import ProjectDashboard from '$lib/workflow/ProjectDashboard.svelte'
  import WorkflowDAGViewer from '$lib/workflow/WorkflowDAGViewer.svelte'
  import EngineTaskEditor from '$lib/workflow/EngineTaskEditor.svelte'
  import { TerminalWindow } from '$lib/structure'
  import { ChatPane } from '$lib/chat'
  import { chat_position, set_chat_position } from '$lib/chat/chat-state.svelte'
  import { STATIC_ONLY } from '$lib/api/config'
  import StaticModeBanner from '$lib/StaticModeBanner.svelte'

  let {
    onclose,
    onpopout,
    onchange,
    ondbchange,
    standalone = false,
    initial_workflow_id,
    compact = false,
    tab_id,
  }: {
    onclose?: () => void
    onpopout?: () => void
    onchange?: () => void
    ondbchange?: () => void
    standalone?: boolean
    initial_workflow_id?: string // [2025-02] open specific workflow from sidebar
    /** Start editor with sidebars collapsed (AI-initiated). */
    compact?: boolean
    // Per-tab identifier forwarded to WorkflowEditor and ChatPane. Reserved
    // for Phase 2/3 of the tab-isolation refactor; unused in Phase 1.
    tab_id?: string
  } = $props()

  // --- Inline terminal state ---
  let show_terminal = $state(false)
  let terminal_height_pct = $state(35) // percentage of total height
  let is_resizing = $state(false)
  let container_el: HTMLDivElement | undefined = $state()

  // --- AI Chat state ---
  let show_chat = $state(false)
  let chat_right_size = $state(30) // percentage for right chat panel
  let is_chat_right_resizing = $state(false)

  // When both panels are open, use a larger default height
  const effective_height_pct = $derived(
    show_chat && chat_position.value === `bottom` && show_terminal
      ? Math.max(terminal_height_pct, 50)
      : terminal_height_pct
  )

  function start_chat_right_resize(event: PointerEvent) {
    event.preventDefault()
    is_chat_right_resizing = true
    const rect = container_el?.getBoundingClientRect()
    if (!rect) return

    document.body.style.cursor = `col-resize`
    document.body.style.userSelect = `none`

    function on_move(e: PointerEvent) {
      if (!rect) return
      const pct = 100 - ((e.clientX - rect.left) / rect.width) * 100
      chat_right_size = Math.max(15, Math.min(50, pct))
    }

    function on_up() {
      is_chat_right_resizing = false
      document.body.style.cursor = ``
      document.body.style.userSelect = ``
      window.removeEventListener(`pointermove`, on_move)
      window.removeEventListener(`pointerup`, on_up)
    }

    window.addEventListener(`pointermove`, on_move)
    window.addEventListener(`pointerup`, on_up)
  }

  async function popout_chat() {
    show_chat = false
    // Pass tab_id in the URL so the popout filters its BroadcastChannel
    // listener to only accept updates from this workflow tab.
    const popout_tab_id = encodeURIComponent(tab_id ?? `default`)
    const url = `${window.location.origin}${window.location.pathname}#chat?tab_id=${popout_tab_id}`
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      const chat_window = new WebviewWindow(`catgo-chat`, {
        title: t('chat.title') + ' - ' + t('chat.chat_tab'),
        url, width: 500, height: 700, center: true, resizable: true, decorations: true,
      })
      chat_window.once(`tauri://error`, () => {
        window.open(url, `catgo-chat`, `width=500,height=700,resizable=yes`)
      })
      return
    } catch { /* not Tauri */ }
    window.open(url, `catgo-chat`, `width=500,height=700,resizable=yes`)
  }

  function on_resize_start(e: MouseEvent) {
    e.preventDefault()
    is_resizing = true
    const start_y = e.clientY
    const start_pct = terminal_height_pct

    function on_move(ev: MouseEvent) {
      if (!container_el) return
      const rect = container_el.getBoundingClientRect()
      const delta_pct = ((start_y - ev.clientY) / rect.height) * 100
      terminal_height_pct = Math.max(15, Math.min(60, start_pct + delta_pct))
    }
    function on_up() {
      is_resizing = false
      window.removeEventListener(`mousemove`, on_move)
      window.removeEventListener(`mouseup`, on_up)
    }
    window.addEventListener(`mousemove`, on_move)
    window.addEventListener(`mouseup`, on_up)
  }

  type ViewState = `projects` | `project_detail` | `list` | `editor` | `v2_dag`

  let view = $state<ViewState>(`projects`)
  let v2_workflow_id = $state(``)
  let v2_selected_task = $state<string | null>(null)
  let workflows = $state<WorkflowSummary[]>([])
  let engine_workflows = $state<V2WorkflowSummary[]>([])
  let templates = $state<WorkflowTemplate[]>([])
  let active_workflow_id = $state(``)
  let active_project_id = $state(``)
  let is_loading = $state(false)
  let error = $state(``)
  let workflow_delete_error = $state(``)
  let workflow_delete_success = $state(``)
  let selected_workflow_ids = $state<Set<string>>(new Set())
  let deleting_workflows = $state(false)
  let selected_workflow_count = $derived(selected_workflow_ids.size)

  // Unified workflow list: merge GUI + engine workflows, sorted by created_at desc
  type UnifiedWorkflow = {
    id: string
    name: string
    status: string
    source: `GUI` | `Engine`
    task_count: number
    created_at: string
    step_count?: number
    completed_steps?: number
    has_gui: boolean
    has_engine: boolean
    engine_status?: string
    delete_blocked: boolean
    delete_block_reason?: string | null
  }

  const unified_workflows = $derived.by(() => {
    const gui: UnifiedWorkflow[] = workflows.map((wf) => ({
      id: wf.id,
      name: wf.name,
      status: wf.status,
      source: `GUI` as const,
      task_count: wf.step_count,
      created_at: wf.created_at,
      step_count: wf.step_count,
      completed_steps: wf.completed_steps,
      has_gui: true,
      has_engine: false,
      // A paused GUI workflow is inactive and may be removed.  A genuinely
      // running legacy workflow still needs to be stopped first.
      delete_blocked: [`running`, `resetting`].includes(String(wf.status).toLowerCase()),
    }))
    const engine: UnifiedWorkflow[] = engine_workflows.map((ewf) => ({
      id: ewf.id,
      name: ewf.name,
      status: ewf.display_status,
      source: `Engine` as const,
      task_count: ewf.task_count,
      created_at: ewf.created_at ?? ``,
      has_gui: false,
      has_engine: true,
      engine_status: ewf.status,
      delete_blocked: ewf.delete_blocked,
      delete_block_reason: ewf.delete_block_reason,
    }))
    // A uuid present in BOTH DBs (V1 graph_json skin + V2 tasks) is the SAME
    // workflow — dedup by id so it appears once. GUI is listed first so it wins
    // (it carries graph_json + step counts and loads in the editor). Without this
    // the keyed {#each ... (wf.id)} below throws each_key_duplicate and crashes the
    // "All Workflows" view.
    const by_id = new Map<string, UnifiedWorkflow>()
    for (const w of gui) by_id.set(w.id, w)
    for (const w of engine) {
      const existing = by_id.get(w.id)
      if (existing) {
        by_id.set(w.id, {
          ...existing,
          status: w.status,
          has_engine: true,
          engine_status: w.status,
          task_count: w.task_count,
          delete_blocked: w.delete_blocked,
          delete_block_reason: w.delete_block_reason,
        })
      } else {
        by_id.set(w.id, w)
      }
    }
    return [...by_id.values()].sort((a, b) => {
      if (!a.created_at && !b.created_at) return 0
      if (!a.created_at) return 1
      if (!b.created_at) return -1
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  })

  const deletable_workflows = $derived(
    unified_workflows.filter(wf => !is_workflow_delete_blocked(wf)),
  )

  // [2025-02] Open specific workflow from sidebar prop or URL hash (?id=xxx)
  $effect(() => {
    if (initial_workflow_id) {
      active_workflow_id = initial_workflow_id
      view = `editor`
      return
    }
    if (typeof window !== `undefined`) {
      const params = new URLSearchParams(window.location.hash.replace(/^#workflow\??/, ``))
      const id = params.get(`id`)
      if (id) {
        active_workflow_id = id
        view = `editor`
      }
    }
  })

  async function load_list() {
    is_loading = true
    error = ``
    try {
      // Use AbortController with 5s timeout to avoid hanging forever
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)

      const [wf_list, tmpl_list] = await Promise.all([
        fetch_with_signal(api.list_workflows, ctrl.signal),
        fetch_with_signal(api.list_templates, ctrl.signal),
      ])
      clearTimeout(timer)
      workflows = wf_list
      templates = tmpl_list
    } catch (err) {
      const msg = String(err)
      if (msg.includes(`abort`)) {
        error = t('app.cannot_connect_backend')
      } else {
        error = msg
      }
      console.error(`[Workflow] load_list error:`, err)
    } finally {
      is_loading = false
    }

    // Also fetch engine workflows (non-blocking — don't fail if engine unavailable)
    try {
      engine_workflows = await list_v2_workflows()
    } catch {
      engine_workflows = []
    }
    const live_ids = new Set(unified_workflows.map(wf => wf.id))
    selected_workflow_ids = new Set(
      [...selected_workflow_ids].filter(id => live_ids.has(id)),
    )
  }

  // Wrapper: calls an async function but respects AbortSignal for timeout
  async function fetch_with_signal<T>(fn: () => Promise<T>, _signal: AbortSignal): Promise<T> {
    // The API functions don't support signal yet, so race with abort
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        _signal.addEventListener(`abort`, () => reject(new Error(`Request aborted (timeout)`)))
      }),
    ])
  }

  async function create_new() {
    try {
      const graph_json = JSON.stringify({ nodes: [], edges: [] })
      const wf = await api.create_workflow(t('app.untitled_workflow'), graph_json)
      active_workflow_id = wf.id
      view = `editor`
      ondbchange?.()
    } catch (err) {
      error = String(err)
    }
  }

  async function create_from_template(tmpl: WorkflowTemplate) {
    try {
      const wf = await api.create_from_template(tmpl.id, `${tmpl.name} (copy)`)
      active_workflow_id = wf.id
      view = `editor`
      ondbchange?.()
    } catch (err) {
      error = String(err)
    }
  }

  function is_workflow_delete_blocked(workflow: UnifiedWorkflow): boolean {
    return workflow.delete_blocked
  }

  function set_workflow_selected(workflow_id: string, selected: boolean) {
    const next = new Set(selected_workflow_ids)
    if (selected) next.add(workflow_id)
    else next.delete(workflow_id)
    selected_workflow_ids = next
  }

  function toggle_all_deletable_workflows() {
    const ids = deletable_workflows.map(wf => wf.id)
    const select_all = ids.some(id => !selected_workflow_ids.has(id))
    selected_workflow_ids = select_all ? new Set(ids) : new Set()
  }

  async function delete_backing_workflow(workflow: UnifiedWorkflow) {
    // A workflow may have both a GUI graph row and an Engine execution row.
    // Delete both stores so a deduplicated card cannot reappear after refresh.
    if (workflow.has_engine) await delete_v2_workflow(workflow.id)
    if (workflow.has_gui) await api.delete_workflow(workflow.id)
  }

  async function delete_workflow(workflow: UnifiedWorkflow) {
    if (is_workflow_delete_blocked(workflow)) {
      workflow_delete_error = t('app.stop_workflow_before_delete')
      return
    }
    if (!confirm(`${t('app.confirm_delete_workflow')}\n${workflow.name}`)) return
    workflow_delete_error = ``
    workflow_delete_success = ``
    try {
      await delete_backing_workflow(workflow)
      set_workflow_selected(workflow.id, false)
      await load_list()
      workflow_delete_success = t('app.workflow_deleted', { name: workflow.name })
      ondbchange?.()
    } catch (err) {
      workflow_delete_error = err instanceof Error ? err.message : String(err)
    }
  }

  async function delete_selected_workflows() {
    if (deleting_workflows) return
    const selected = unified_workflows.filter(wf => selected_workflow_ids.has(wf.id))
    if (selected.length === 0) return
    if (selected.some(is_workflow_delete_blocked)) {
      workflow_delete_error = t('app.stop_workflow_before_delete')
      return
    }

    const preview_limit = 8
    const preview = selected.slice(0, preview_limit).map(wf => `• ${wf.name}`).join(`\n`)
    const remainder = selected.length > preview_limit
      ? `\n${t('app.and_more_workflows', { count: String(selected.length - preview_limit) })}`
      : ``
    const message = `${t('app.confirm_delete_workflows', { count: String(selected.length) })}\n\n${preview}${remainder}`
    if (!confirm(message)) return

    deleting_workflows = true
    workflow_delete_error = ``
    workflow_delete_success = ``
    let deleted = false
    try {
      const engine_ids = selected.filter(wf => wf.has_engine).map(wf => wf.id)
      if (engine_ids.length > 0) await delete_v2_workflows(engine_ids)
      for (const workflow of selected) {
        if (workflow.has_gui) await api.delete_workflow(workflow.id)
      }
      selected_workflow_ids = new Set()
      deleted = true
      ondbchange?.()
    } catch (err) {
      workflow_delete_error = err instanceof Error ? err.message : String(err)
    } finally {
      await load_list()
      deleting_workflows = false
    }
    if (deleted) {
      workflow_delete_success = t('app.workflows_deleted', { count: String(selected.length) })
    }
  }

  function back_to_projects() {
    view = `projects`
    active_project_id = ``
  }

  function open_project(project_id: string) {
    active_project_id = project_id
    view = `project_detail`
  }

  function open_workflow_from_project(workflow_id: string) {
    active_workflow_id = workflow_id
    view = `editor`
  }

  function back_from_editor() {
    // Return to project detail if we came from there, otherwise to projects
    if (active_project_id) {
      view = `project_detail`
    } else {
      view = `projects`
    }
    active_workflow_id = ``
  }

  // Notify parent when user enters the editor (has work to lose)
  $effect(() => {
    if (view === `editor`) onchange?.()
  })

  // Load list on mount (only when viewing the flat list)
  $effect(() => {
    if (view === `list`) load_list()
  })

  function format_date(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: `short`,
        day: `numeric`,
        hour: `2-digit`,
        minute: `2-digit`,
      })
    } catch {
      return iso
    }
  }
</script>

<div class="workflow-view" class:standalone class:has-bottom-panel={show_terminal || (show_chat && chat_position.value === `bottom`)} class:has-right-panel={show_chat && chat_position.value === `right`} class:resizing={is_resizing} class:resizing-right={is_chat_right_resizing} bind:this={container_el} style:--chat-right-size="{chat_right_size}%">
  <div class="workflow-content-area">
  {#if STATIC_ONLY}
    <div class="static-mode-banner-container">
      <StaticModeBanner
        title={t('app.static_mode_workflow_title')}
        message={t('app.static_mode_workflow_message')}
      />
    </div>
  {:else}
    <div class="workflow-main">
  {#if view === `editor`}
    <WorkflowEditor
      workflow_id={active_workflow_id}
      {compact}
      {tab_id}
      onclose={standalone ? undefined : back_from_editor}
      {onpopout}
      ontoggle_terminal={STATIC_ONLY ? undefined : () => { show_terminal = !show_terminal }}
      terminal_open={show_terminal}
      ontoggle_chat={STATIC_ONLY ? undefined : () => {
        if (chat_position.value === `popout`) set_chat_position(`bottom`)
        show_chat = !show_chat
      }}
      chat_open={show_chat}
    />
  {:else if view === `v2_dag`}
    <div class="v2-dag-layout">
      <div class="v2-dag-main">
        <div class="v2-dag-back">
          <button class="back-btn" onclick={() => { view = `list`; load_list() }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
            {t('common.workflows')}
          </button>
        </div>
        <WorkflowDAGViewer workflow_id={v2_workflow_id} onselect_task={(id) => { v2_selected_task = id }} />
      </div>
      <div class="v2-task-panel">
        <EngineTaskEditor
          task_id={v2_selected_task}
          workflow_id={v2_workflow_id}
          onclose={() => { v2_selected_task = null }}
        />
      </div>
    </div>
  {:else if view === `projects`}
    <ProjectListView
      onselect={open_project}
      on_all_workflows={() => { view = `list` }}
      {onclose}
      {ondbchange}
    />
  {:else if view === `project_detail`}
    <ProjectDashboard
      project_id={active_project_id}
      onback={back_to_projects}
      on_open_workflow={open_workflow_from_project}
      on_open_engine_workflow={(id) => { v2_workflow_id = id; v2_selected_task = null; view = `v2_dag` }}
      {onclose}
      {ondbchange}
    />
  {:else}
    <!-- All Workflows — unified list view -->
    <div class="workflow-dashboard">
      <div class="dashboard-header">
        <div class="tab-nav">
          <button class="tab-btn" onclick={back_to_projects}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
            {t('common.projects')}
          </button>
          <button class="tab-btn active">{t('common.workflows')}</button>
        </div>
        <div class="header-spacer"></div>
        {#if onclose}
          <button class="back-btn" onclick={onclose} title={t('app.close_workflow_view')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        {/if}
        <button class="new-btn" onclick={create_new}>{t('app.new_workflow')}</button>
      </div>

      {#if error}
        <div class="error-bar">{error}</div>
      {/if}

      <!-- Templates -->
      {#if templates.length > 0}
        <section class="section">
          <h3 class="section-title">{t('common.templates')}</h3>
          <div class="template-grid">
            {#each templates as tmpl (tmpl.id)}
              <button class="template-card" onclick={() => create_from_template(tmpl)}>
                <div class="template-name">{tmpl.name}</div>
                <div class="template-desc">{tmpl.description}</div>
                <div class="template-cat">{tmpl.category}</div>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Unified workflow list -->
      <section class="section">
        {#if is_loading}
          <div class="loading">{t('common.loading')}</div>
        {:else if unified_workflows.length === 0}
          <div class="empty-state">
            <p>{t('app.no_workflows_yet')}</p>
          </div>
        {:else}
          <div class="workflow-bulk-bar">
            <label class="workflow-select-all">
              <input
                type="checkbox"
                checked={deletable_workflows.length > 0 && deletable_workflows.every(wf => selected_workflow_ids.has(wf.id))}
                disabled={deleting_workflows || deletable_workflows.length === 0}
                onchange={toggle_all_deletable_workflows}
              />
              <span>{t('app.select_all_deletable_workflows')}</span>
            </label>
            <span class="workflow-selected-count">
              {t('app.workflows_selected', { count: String(selected_workflow_count) })}
            </span>
            {#if selected_workflow_count > 0}
              <button
                class="workflow-clear-selection"
                disabled={deleting_workflows}
                onclick={() => { selected_workflow_ids = new Set() }}
              >{t('app.clear_selection')}</button>
              <button
                class="workflow-delete-selected"
                disabled={deleting_workflows}
                onclick={delete_selected_workflows}
              >{deleting_workflows ? t('app.deleting_workflows') : t('app.delete_selected_workflows')}</button>
            {/if}
          </div>
          {#if workflow_delete_error}
            <div class="workflow-delete-feedback error" role="alert">{workflow_delete_error}</div>
          {:else if workflow_delete_success}
            <div class="workflow-delete-feedback success" role="status">{workflow_delete_success}</div>
          {/if}
          <div class="workflow-list">
            {#each unified_workflows as wf (wf.id)}
              <div class="workflow-card" class:selected={selected_workflow_ids.has(wf.id)}>
                <input
                  class="workflow-card-checkbox"
                  type="checkbox"
                  checked={selected_workflow_ids.has(wf.id)}
                  disabled={deleting_workflows || is_workflow_delete_blocked(wf)}
                  aria-label={t('app.select_workflow', { name: wf.name })}
                  title={is_workflow_delete_blocked(wf) ? t('app.stop_workflow_before_delete') : t('app.select_workflow', { name: wf.name })}
                  onclick={(e) => e.stopPropagation()}
                  onchange={(e) => set_workflow_selected(wf.id, (e.currentTarget as HTMLInputElement).checked)}
                />
                <button class="workflow-card-main" onclick={() => {
                  if (wf.source === `Engine`) {
                    v2_workflow_id = wf.id; v2_selected_task = null; view = `v2_dag`
                  } else {
                    active_workflow_id = wf.id; view = `editor`
                  }
                }}>
                  <div class="wf-name-row">
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span class="wf-name" onclick={(e) => e.stopPropagation()}>{wf.name}</span>
                    <span class="wf-source-tag {wf.source.toLowerCase()}">{wf.source}</span>
                  </div>
                  <div class="wf-meta">
                    <span class="wf-status {wf.status}">{wf.status.replace(/_/g, ` `)}</span>
                    <span class="wf-steps">
                      {#if wf.source === `GUI` && wf.completed_steps !== undefined}
                        {wf.completed_steps}/{t('common.steps_count', { n: wf.step_count ?? 0 })}
                      {:else}
                        {t('common.tasks_count', { n: wf.task_count })}
                      {/if}
                    </span>
                    {#if wf.created_at}
                      <span class="wf-date">{format_date(wf.created_at)}</span>
                    {/if}
                  </div>
                </button>
                <button
                  class="wf-delete"
                  disabled={deleting_workflows || is_workflow_delete_blocked(wf)}
                  onclick={() => delete_workflow(wf)}
                  title={is_workflow_delete_blocked(wf) ? t('app.stop_workflow_before_delete') : t('common.delete')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {/if}
  </div>
  {/if}

  {#if !STATIC_ONLY && (show_terminal || (show_chat && chat_position.value === `bottom`))}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="wf-terminal-resize-handle" onmousedown={on_resize_start}></div>
    <div class="wf-bottom-panels" style="flex-basis: {effective_height_pct}%">
      {#if show_chat && chat_position.value === `bottom`}
        <div class="wf-chat-panel">
          <ChatPane
            {tab_id}
            on_close={() => { show_chat = false }}
            on_popout={popout_chat}
          />
        </div>
      {/if}
      {#if show_terminal}
        <div class="wf-terminal-panel">
          <TerminalWindow
            onclose={() => { show_terminal = false }}
          />
        </div>
      {/if}
    </div>
  {/if}
  </div><!-- end workflow-content-area -->
  {#if !STATIC_ONLY && show_chat && chat_position.value === `right`}
    <div class="wf-chat-resize-handle-right" onpointerdown={start_chat_right_resize}></div>
    <div class="wf-chat-panel-right">
      <ChatPane
        {tab_id}
        on_close={() => { show_chat = false }}
        on_popout={popout_chat}
      />
    </div>
  {/if}

</div>

<style>
  .workflow-view {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--page-bg);
    color: var(--text-color, #eee);
    font-family: inherit;
  }

  .workflow-main {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .workflow-view.has-bottom-panel .workflow-main {
    flex: 1 1 60%;
    min-height: 200px;
  }

  .wf-terminal-resize-handle {
    height: 6px;
    background: rgba(255, 255, 255, 0.06);
    cursor: row-resize;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .wf-terminal-resize-handle:hover,
  .workflow-view.resizing .wf-terminal-resize-handle {
    background: var(--accent-color, #3b82f6);
  }
  .workflow-view.resizing {
    cursor: row-resize;
    user-select: none;
  }
  .workflow-view.resizing .workflow-main,
  .workflow-view.resizing .wf-terminal-panel {
    pointer-events: none;
  }

  .wf-bottom-panels {
    flex: 0 0 35%;
    min-height: 80px;
    max-height: 60%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    width: 100%;
  }

  .wf-chat-panel {
    flex: 1;
    min-height: 80px;
    display: flex;
    flex-direction: column;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }

  .wf-chat-panel > :global(*) {
    flex: 1;
    min-height: 0;
  }

  .wf-terminal-panel {
    flex: 1;
    min-height: 80px;
    display: flex;
    flex-direction: column;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }

  .wf-terminal-panel > :global(*) {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .workflow-view.standalone {
    position: fixed;
    inset: 0;
    z-index: 9999;
  }

  .v2-dag-layout {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .v2-dag-main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
  }

  .v2-dag-back {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 10;
    max-width: calc(100% - 16px);
  }

  .v2-task-panel {
    width: min(420px, 38vw);
    min-width: 280px;
    border-left: 1px solid var(--border-color, #333);
    background: var(--surface-bg, #111);
    flex-shrink: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .v2-task-panel > :global(*) {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .workflow-dashboard {
    flex: 1;
    overflow-y: auto;
    padding: 24px 32px;
    max-width: 900px;
    margin: 0 auto;
    width: 100%;
  }

  @media (max-width: 900px) {
    .v2-dag-layout {
      flex-direction: column;
    }

    .v2-task-panel {
      width: 100%;
      min-width: 0;
      min-height: 220px;
      max-height: 42%;
      border-left: none;
      border-top: 1px solid var(--border-color, #333);
    }
  }

  .dashboard-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }

  .header-spacer {
    flex: 1;
  }

  .tab-nav {
    display: flex;
    align-items: center;
    gap: 2px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 8px;
    padding: 3px;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--text-color-muted, #94a3b8);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .tab-btn:hover {
    color: var(--text-color, #eee);
    background: rgba(255, 255, 255, 0.06);
  }

  .tab-btn.active {
    background: var(--surface-bg, rgba(255, 255, 255, 0.08));
    color: var(--text-color, #eee);
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .back-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-color-muted, #94a3b8);
    font-size: 12px;
    cursor: pointer;
  }

  .back-btn:hover {
    background: var(--surface-bg-hover);
    color: var(--text-color, #eee);
  }

  .new-btn {
    padding: 8px 16px;
    background: var(--accent-color, #3b82f6);
    border: none;
    border-radius: 6px;
    color: white;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .new-btn:hover {
    filter: brightness(1.15);
  }

  .error-bar {
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    color: #ef4444;
    font-size: 12px;
    margin-bottom: 16px;
  }

  .section {
    margin-bottom: 24px;
  }

  .section-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 12px;
  }

  .template-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
  }

  .template-card {
    padding: 16px;
    background: var(--surface-bg);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: inherit;
    transition: all 0.2s;
  }

  .template-card:hover {
    background: var(--surface-bg-hover);
    border-color: var(--accent-color, #3b82f6);
  }

  .template-name {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .template-desc {
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
    line-height: 1.4;
    margin-bottom: 8px;
  }

  .template-cat {
    font-size: 10px;
    color: var(--text-color-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .loading,
  .empty-state {
    padding: 24px;
    text-align: center;
    color: var(--text-color-muted);
    font-size: 13px;
  }

  .workflow-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .workflow-bulk-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 34px;
    padding: 6px 10px;
    margin-bottom: 10px;
    border: 1px solid var(--border-color);
    border-radius: 7px;
    background: var(--surface-bg);
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
  }

  .workflow-delete-feedback {
    padding: 7px 10px;
    margin: -4px 0 10px;
    border-radius: 6px;
    font-size: 11px;
  }

  .workflow-delete-feedback.error {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .workflow-delete-feedback.success {
    color: #22c55e;
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .workflow-select-all {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .workflow-select-all input,
  .workflow-card-checkbox {
    width: 14px;
    height: 14px;
    margin: 0;
    accent-color: var(--accent-color, #3b82f6);
    cursor: pointer;
  }

  .workflow-select-all input:disabled,
  .workflow-card-checkbox:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .workflow-selected-count {
    flex: 1;
  }

  .workflow-clear-selection,
  .workflow-delete-selected {
    padding: 4px 8px;
    border-radius: 5px;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-color-muted, #94a3b8);
    font-size: 10px;
    cursor: pointer;
  }

  .workflow-delete-selected {
    border-color: rgba(239, 68, 68, 0.35);
    color: #ef4444;
  }

  .workflow-clear-selection:hover:not(:disabled) {
    background: var(--surface-bg-hover);
  }

  .workflow-delete-selected:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.1);
  }

  .workflow-card {
    display: flex;
    align-items: center;
    background: var(--surface-bg);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.2s;
  }

  .workflow-card:hover {
    border-color: var(--surface-bg-hover);
  }

  .workflow-card.selected {
    border-color: var(--accent-color, #3b82f6);
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 8%, var(--surface-bg));
  }

  .workflow-card-checkbox {
    flex: 0 0 14px;
    margin-left: 14px;
  }

  .workflow-card-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 16px;
    background: none;
    border: none;
    text-align: left;
    color: inherit;
    cursor: pointer;
  }

  .wf-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .wf-name {
    font-size: 14px;
    font-weight: 600;
    user-select: text;
    cursor: text;
  }

  .wf-source-tag {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .wf-source-tag.gui {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
  }

  .wf-source-tag.engine {
    background: rgba(168, 85, 247, 0.15);
    color: #c084fc;
  }

  .wf-meta {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--text-color-muted);
  }

  .wf-status {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
  }

  .wf-status.draft {
    background: rgba(71, 85, 105, 0.3);
    color: var(--text-color-muted, #94a3b8);
  }
  .wf-status.running {
    background: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
  }
  .wf-status.check {
    background: rgba(245, 158, 11, 0.2);
    color: #fbbf24;
  }
  .wf-status.completed {
    background: rgba(34, 197, 94, 0.2);
    color: #4ade80;
  }
  .wf-status.failed {
    background: rgba(239, 68, 68, 0.2);
    color: #f87171;
  }
  .wf-status.not_converged {
    background: rgba(245, 158, 11, 0.2);
    color: #fbbf24;
  }
  .wf-status.paused {
    background: rgba(148, 163, 184, 0.2);
    color: #94a3b8;
  }

  .wf-delete {
    padding: 12px;
    background: none;
    border: none;
    border-left: 1px solid var(--border-color);
    color: var(--text-color-muted);
    cursor: pointer;
  }

  .wf-delete:hover {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
  }

  .wf-delete:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .wf-delete:disabled:hover {
    color: var(--text-color-muted);
    background: none;
  }

  /* Content area wrapper (left column when right panel active) */
  .workflow-content-area {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  /* Right panel grid layout */
  .workflow-view.has-right-panel {
    display: grid;
    grid-template-columns: 1fr 5px var(--chat-right-size, 30%);
    grid-template-rows: 1fr;
  }

  .wf-chat-resize-handle-right {
    width: 5px;
    cursor: col-resize;
    background: rgba(255, 255, 255, 0.06);
    transition: background 0.15s;
  }
  .wf-chat-resize-handle-right:hover,
  .workflow-view.resizing-right .wf-chat-resize-handle-right {
    background: var(--accent-color, #3b82f6);
  }

  .workflow-view.resizing-right {
    cursor: col-resize;
    user-select: none;
  }
  .workflow-view.resizing-right .workflow-content-area,
  .workflow-view.resizing-right .wf-chat-panel-right {
    pointer-events: none;
  }

  .wf-chat-panel-right {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
    overflow: hidden;
    min-width: 0;
  }
  .wf-chat-panel-right > :global(*) {
    flex: 1;
    min-height: 0;
  }

</style>
e>

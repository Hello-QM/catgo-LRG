<script lang="ts">
  import { slide } from 'svelte/transition'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import DiagnosticsPanel from '$lib/DiagnosticsPanel.svelte'
  import { STATIC_ONLY } from '$lib/api/config'

  let show_diagnostics = $state(false)
  import { hpc_session_store, refresh_hpc_sessions, LOCAL_SESSION_ID } from '$lib/hpc-sessions.svelte'

  import FileTree from '$lib/structure/FileTree.svelte'
  import { load_from_url } from '$lib/io'
  import type { RemoteFile } from '$lib/api/hpc'
  import { create_hpc_browser_state } from './sidebar/hpc-browser.svelte'
  import { create_fs_browser_state } from './sidebar/fs-browser.svelte'
  import { create_rename_save_state } from './sidebar/rename-save-dialogs.svelte'
  import FilePickerModal from './components/FilePickerModal.svelte'
  import { create_cwd_sync_cleanup } from './sidebar/cwd-sync.svelte'
  import { open_context_menu, make_project_target, make_result_target, make_workflow_target } from './sidebar/sidebar-context-menus'
  import {
    list_projects,
    create_project,
    delete_project,
    update_project,
    get_result_structure,
    delete_result,
    drag_result_to_project,
    assign_workflow_to_project,
    get_current_db,
    create_new_db,
    open_db,
    save_db_as,
    browse_directory,
    read_file,
  } from '$lib/api/project'
  import type { ProjectSummary, DbInfo, BrowseResult, FileBrowseItem } from '$lib/api/project'
  import { get_workflow_results, get_workflow } from '$lib/api/workflow'
  import { NODE_DEFINITIONS } from '$lib/workflow/node-definitions'
  import {
    LAST_DB_KEY,
    type LocalFile, type DbWorkflow, type DbResult, type WfNodeInfo, type CtxTarget,
  } from './sidebar-data'
  import {
    is_structure_file, is_db_file, format_energy, format_file_size,
    get_file_icon, fs_get_breadcrumbs, fs_file_icon_class, make_files,
  } from './sidebar-utils'

  load_i18n_module('app')

  // ========== Props ==========
  // [2025-02] Default source changed to localdb
  let {
    collapsed = $bindable(false),
    width = $bindable(240),
    source = $bindable(`localdb`),
    hpc_path = $bindable(`~`),
    fs_path = $bindable(``),
    on_load_file,
    on_open_editor,
    on_load_trajectory,
    on_open_workflow, // [2025-02] open workflow editor from sidebar
    on_save_structure,
    on_save_workflow, // [2025-02] returns workflow_id if active pane is workflow editor
    on_before_db_switch, // [2025-02] prompt unsaved changes before DB switch
    on_preview_file,
    refresh_counter = 0,
  }: {
    collapsed?: boolean
    width?: number
    source?: string
    /** Bindable HPC current path (for export dialog) */
    hpc_path?: string
    /** Bindable local filesystem current dir (for export dialog) */
    fs_path?: string
    on_load_file: (content: string | ArrayBuffer, filename: string, file_path?: string, session_id?: string) => void
    on_open_editor?: (content: string, filename: string, file_path: string, session_id: string) => void
    on_load_trajectory?: (content: string, filename: string, meta?: { session_id: string; dir_path: string }) => void
    on_open_workflow?: (workflow_id: string) => void
    on_save_structure?: () => Record<string, unknown> | null
    on_save_workflow?: () => string | null
    on_before_db_switch?: () => Promise<boolean>
    on_preview_file?: (mode: string, filename: string, file_path: string, session_id: string, content?: string, binary_data?: string, mime_type?: string) => void
    refresh_counter?: number
  } = $props()

  // ========== Static file data ==========
  const raw_structures = import.meta.glob(`./../src/site/structures/*`, { eager: true, query: `?raw`, import: `default` }) as Record<string, string>
  const raw_molecules = import.meta.glob(`./../src/site/molecules/*.{json,xyz}`, { eager: true, query: `?raw`, import: `default` }) as Record<string, string>
  // Trajectories are large — use lazy ?url imports
  const traj_urls = import.meta.glob(`./../src/site/trajectories/*`, { eager: true, query: `?url`, import: `default` }) as Record<string, string>


  const structure_list = make_files(raw_structures, `raw`)
  const molecule_list = make_files(raw_molecules, `raw`)
  const trajectory_list = make_files(traj_urls, `url`)

  // ========== Section collapse state ==========
  let sections_open = $state({ structures: true, molecules: false, trajectories: false })

  // ========== HPC sessions ==========
  let hpc_sessions = $derived(hpc_session_store.sessions)

  // Refresh HPC sessions on mount
  $effect(() => {
    refresh_hpc_sessions()
  })

  // Cleanup HPC merge timer on unmount
  $effect(() => {
    return () => hpc.cleanup()
  })

  // CWD sync: listen for terminal directory changes via BroadcastChannel (cross-window)
  // AND CustomEvent (same-window, since BroadcastChannel doesn't deliver to sender's context)
  $effect(() => {
    return create_cwd_sync_cleanup(
      source,
      () => hpc.hpc_current_path,
      (path) => { hpc.hpc_current_path = path },
    )
  })

  // Path sync: when switching between HPC and localdb, sync current directory
  let prev_source = $state(source)
  $effect(() => {
    const cur = source
    if (cur === prev_source) return
    const from = prev_source
    prev_source = cur

    // HPC -> localdb: sync hpc_current_path to fs browser
    if (from && from !== `catgo` && from !== `localdb` && cur === `localdb`) {
      if (hpc.hpc_current_path.startsWith(`/`)) {
        fsb.fs_browse(hpc.hpc_current_path)
      }
    }
    // localdb -> HPC: sync fs_current_dir to hpc file tree
    if (from === `localdb` && cur && cur !== `catgo` && cur !== `localdb`) {
      if (fsb.fs_current_dir.startsWith(`/`)) {
        hpc.hpc_current_path = fsb.fs_current_dir
        hpc.hpc_file_tree_key++
      }
    }
  })

  // ========== Local DB state ==========

  let db_projects = $state<ProjectSummary[]>([])
  let db_workflows = $state<DbWorkflow[]>([])
  let db_workflow_results = $state<Record<string, DbResult[]>>({})
  let db_workflow_nodes = $state<Record<string, WfNodeInfo[]>>({})
  let db_expanded = $state<Set<string>>(new Set())  // expanded project IDs
  let db_expanded_workflows = $state<Set<string>>(new Set())
  let db_loading = $state(false)
  let db_error = $state(``)
  let db_loading_result = $state<number | null>(null)

  // Group projects by parent_id for recursive tree
  let children_of = $derived.by(() => {
    const map: Record<string, ProjectSummary[]> = { __root__: [] }
    const all_ids = new Set(db_projects.map(p => p.id))
    for (const p of db_projects) {
      // Orphaned projects (parent_id references non-existent project) go to root
      const key = (p.parent_id && all_ids.has(p.parent_id)) ? p.parent_id : `__root__`
      ;(map[key] ??= []).push(p)
    }
    return map
  })
  let root_projects = $derived(children_of[`__root__`] || [])

  // [2025-02] Group workflows by project_id so each project_node can show its workflows.
  // Workflows without a project_id land in __unassigned__ and render below the project tree.
  let project_workflows = $derived.by(() => {
    const map: Record<string, DbWorkflow[]> = {}
    for (const wf of db_workflows) {
      const key = wf.project_id || `__unassigned__`
      ;(map[key] ??= []).push(wf)
    }
    return map
  })
  let unassigned_workflows = $derived(project_workflows[`__unassigned__`] || [])

  // Section collapse state for the projects section
  let structures_section_open = $state(true)

  // Saved results per project
  let db_project_saved = $state<Record<string, DbResult[]>>({})

  // Context menu state — project, workflow, or result
  let ctx_menu = $state<{ x: number; y: number; target: CtxTarget } | null>(null)
  // [2025-02 bugfix] Snapshot of target at open time. Svelte 5 {@const} declarations
  // are reactive deriveds — when close_context_menu() nulls ctx_menu, the {@const}
  // re-evaluates before the {#if} block tears down, causing null dereference.
  // ctx_target_snapshot is never nulled on close (only overwritten on next open).
  let ctx_target_snapshot = $state<CtxTarget | null>(null)

  // Drag-and-drop state — 'workflow' type allows dragging workflows onto project folders
  let drag_data = $state<{ type: 'project' | 'result' | 'workflow'; id: string | number } | null>(null)
  let drop_target_id = $state<string | null>(null)

  // [2025-02] Database management state
  let current_db = $state<DbInfo | null>(null)
  const is_tauri = typeof window !== `undefined` && (`__TAURI__` in window || `__TAURI_INTERNALS__` in window)

  // Persist last-used DB path whenever current_db changes
  $effect(() => {
    if (current_db?.path) {
      localStorage.setItem(LAST_DB_KEY, current_db.path)
    }
  })

  // In-app file picker state
  let file_picker_visible = $state(false)
  let file_picker_mode = $state<'open' | 'new' | 'save-as'>(`open`)
  let file_picker_dir = $state(``)
  let file_picker_parent = $state(``)
  let file_picker_items = $state<BrowseResult['items']>([])
  let file_picker_loading = $state(false)
  let file_picker_filename = $state(``)  // for new/save-as

  // [2026-03] Filesystem browser — extracted to sidebar/fs-browser.svelte.ts
  const fsb = create_fs_browser_state({
    on_load_file,
    on_open_editor,
    on_load_trajectory,
    on_save_structure,
    on_preview_file,
    on_before_db_switch,
    on_open_db_file: async (path: string) => {
      current_db = await open_db(path)
      await load_db()
    },
    set_db_error: (msg: string) => { db_error = msg },
  })

  // Rename/save dialogs — extracted to sidebar/rename-save-dialogs.svelte.ts
  const rsd = create_rename_save_state({
    get_db_projects: () => db_projects,
    load_db,
    on_save_structure,
    on_save_workflow,
  })

  async function load_current_db_info() {
    try {
      current_db = await get_current_db()
    } catch { /* server not running */ }
  }

  async function open_file_picker(mode: 'open' | 'new' | 'save-as') {
    file_picker_mode = mode
    file_picker_visible = true
    file_picker_filename = mode === `new` ? `new_database.db`
      : mode === `save-as` ? `${current_db?.name || `database`}_copy.db`
      : ``
    // Start browsing from current DB's directory or home
    const db_path = current_db?.path
    const last_sep = db_path ? Math.max(db_path.lastIndexOf(`/`), db_path.lastIndexOf(`\\`)) : -1
    const start_dir = db_path && last_sep > 0 ? db_path.substring(0, last_sep) : `~`
    await browse_to(start_dir)
  }

  async function browse_to(dir: string) {
    file_picker_loading = true
    try {
      const result = await browse_directory(dir)
      file_picker_dir = result.dir
      file_picker_parent = result.parent
      file_picker_items = result.items
    } catch (e) {
      db_error = e instanceof Error ? e.message : t('app.failed_to_browse')
    } finally {
      file_picker_loading = false
    }
  }

  async function file_picker_confirm(selected_path?: string) {
    file_picker_visible = false
    try {
      if (file_picker_mode === `open` && selected_path) {
        current_db = await open_db(selected_path)
        await load_db() // [2025-02] refresh after open
      } else if (file_picker_mode === `new` && file_picker_filename) {
        const sep = file_picker_dir.includes(`\\`) ? `\\` : `/`
        const path = `${file_picker_dir}${sep}${file_picker_filename}`
        current_db = await create_new_db(path)
        await load_db() // [2025-02] refresh after new DB
      } else if (file_picker_mode === `save-as` && file_picker_filename) {
        const sep = file_picker_dir.includes(`\\`) ? `\\` : `/`
        const path = `${file_picker_dir}${sep}${file_picker_filename}`
        current_db = await save_db_as(path)
        await load_db() // [2025-02] refresh after save-as
      }
    } catch (e) {
      db_error = e instanceof Error ? e.message : t('app.operation_failed')
    }
  }

  async function handle_new_db() {
    if (on_before_db_switch && !(await on_before_db_switch())) return
    if (is_tauri) {
      try {
        const { save } = await import(`@tauri-apps/plugin-dialog`)
        const path = await save({
          defaultPath: `new_database.db`,
          filters: [{ name: `ASE Database`, extensions: [`db`] }],
        })
        if (!path) return
        current_db = await create_new_db(path)
        await load_db() // [2025-02] refresh after new DB (Tauri)
      } catch (e) {
        db_error = e instanceof Error ? e.message : t('app.failed_to_create_database')
      }
    } else {
      open_file_picker(`new`)
    }
  }

  async function handle_open_db() {
    if (on_before_db_switch && !(await on_before_db_switch())) return
    if (is_tauri) {
      try {
        const { open } = await import(`@tauri-apps/plugin-dialog`)
        const result = await open({
          multiple: false,
          filters: [{ name: `ASE Database`, extensions: [`db`] }, { name: `All Files`, extensions: [`*`] }],
        })
        if (!result || Array.isArray(result)) return
        current_db = await open_db(result)
        await load_db() // [2025-02] refresh after open (Tauri)
      } catch (e) {
        db_error = e instanceof Error ? e.message : t('app.failed_to_open_database')
      }
    } else {
      open_file_picker(`open`)
    }
  }

  async function handle_save_as_db() {
    if (on_before_db_switch && !(await on_before_db_switch())) return
    if (is_tauri) {
      try {
        const default_name = current_db ? `${current_db.name}_copy.db` : `database_copy.db`
        const { save } = await import(`@tauri-apps/plugin-dialog`)
        const path = await save({
          defaultPath: default_name,
          filters: [{ name: `ASE Database`, extensions: [`db`] }],
        })
        if (!path) return
        current_db = await save_db_as(path)
        await load_db() // [2025-02] refresh after save-as (Tauri)
      } catch (e) {
        db_error = e instanceof Error ? e.message : t('app.failed_to_save_database')
      }
    } else {
      open_file_picker(`save-as`)
    }
  }

  // Load projects + workflows in parallel when switching to localdb
  // On first load, restore the last-used database if available
  let db_restored = false
  $effect(() => {
    if (source === `localdb`) {
      if (!db_restored) {
        db_restored = true
        const last_path = localStorage.getItem(LAST_DB_KEY)
        if (last_path) {
          open_db(last_path)
            .then((info) => { current_db = info })
            .catch(() => { /* file gone or inaccessible, use default */ })
            .finally(() => load_db())
          return
        }
      }
      load_db()
    }
  })

  // [2025-02] Reload full sidebar tree when App signals a DB change
  // (save-on-close, right-click "Save to project", or workflow-side mutations)
  $effect(() => {
    if (refresh_counter > 0) {
      void refresh_counter
      load_db()
    }
  })

  // [2025-02] Full reload: projects, workflows, and all expanded results
  async function load_db() {
    db_loading = true
    db_error = ``
    try {
      const [projects, wfs] = await Promise.all([
        list_projects(),
        list_workflows_api(),
      ])
      load_current_db_info()  // fire-and-forget
      db_projects = projects
      db_workflows = wfs
      // Refresh results for all currently expanded projects
      for (const pid of db_expanded) {
        load_project_saved(pid)
      }
      // Refresh workflow nodes and results for expanded workflows
      for (const wid of db_expanded_workflows) {
        load_workflow_nodes(wid)
        load_workflow_results(wid)
      }
    } catch (e) {
      db_error = e instanceof Error ? e.message : (typeof e === `string` ? e : t('app.failed_to_load_database'))
    } finally {
      db_loading = false
    }
  }

  async function list_workflows_api(): Promise<DbWorkflow[]> {
    const { list_workflows } = await import(`$lib/api/workflow`)
    const wfs = await list_workflows()
    return wfs.map(w => ({
      id: w.id,
      name: w.name,
      status: w.status,
      project_id: w.project_id ?? null,
      step_count: w.step_count,
      completed_steps: w.completed_steps,
    }))
  }

  function toggle_project(project_id: string) {
    if (db_expanded.has(project_id)) {
      db_expanded = new Set([...db_expanded].filter(id => id !== project_id))
    } else {
      db_expanded = new Set([...db_expanded, project_id])
      if (!db_project_saved[project_id]) load_project_saved(project_id)
    }
  }

  async function load_project_saved(project_id: string) {
    try {
      const data = await get_workflow_results(project_id)
      db_project_saved[project_id] = (data.results || []).map((r: Record<string, unknown>) => ({
        id: r.id as number,
        formula: (r.formula as string) || `unknown`,
        label: (r.label as string) || ``,
        energy: (r.energy as number) ?? null,
        step_id: (r.step_id as string) || ``,
        node_type: (r.node_type as string) || ``,
      }))
    } catch {
      db_project_saved[project_id] = []
    }
  }

  // [2025-02] Extracted for reuse in load_db refresh
  async function load_workflow_results(workflow_id: string) {
    try {
      const data = await get_workflow_results(workflow_id)
      db_workflow_results[workflow_id] = (data.results || []).map((r: Record<string, unknown>) => ({
        id: r.id as number,
        formula: (r.formula as string) || `unknown`,
        label: (r.label as string) || ``,
        energy: (r.energy as number) ?? null,
        step_id: (r.step_id as string) || ``,
        node_type: (r.node_type as string) || ``,
      }))
    } catch {
      db_workflow_results[workflow_id] = []
    }
  }

  async function load_workflow_nodes(workflow_id: string) {
    try {
      const detail = await get_workflow(workflow_id)
      const graph = JSON.parse(detail.graph_json || `{}`)
      const nodes: WfNodeInfo[] = (graph.nodes || []).map((n: { id: string; type: string }) => {
        const def = NODE_DEFINITIONS[n.type]
        return {
          id: n.id,
          type: n.type,
          label: def?.label || n.type,
          icon: def?.icon || `\u{2B1C}`,
        }
      })
      db_workflow_nodes[workflow_id] = nodes
    } catch {
      db_workflow_nodes[workflow_id] = []
    }
  }

  async function toggle_workflow(workflow_id: string) {
    if (db_expanded_workflows.has(workflow_id)) {
      db_expanded_workflows = new Set([...db_expanded_workflows].filter(id => id !== workflow_id))
      return
    }
    db_expanded_workflows = new Set([...db_expanded_workflows, workflow_id])
    if (!db_workflow_nodes[workflow_id]) {
      load_workflow_nodes(workflow_id)
    }
    if (!db_workflow_results[workflow_id]) {
      await load_workflow_results(workflow_id)
    }
  }

  async function handle_result_click(row_id: number, formula: string) {
    db_loading_result = row_id
    try {
      const structure = await get_result_structure(row_id)
      on_load_file(JSON.stringify(structure), `${formula}.json`)
    } catch (e) {
      console.error(`Failed to load structure:`, e)
    } finally {
      db_loading_result = null
    }
  }

  async function handle_create_project(parent_id?: string) {
    const name = prompt(parent_id ? t('app.new_subfolder_name') : t('app.new_project_name'))
    if (!name?.trim()) return
    try {
      await create_project(name.trim(), ``, parent_id)
      await load_db() // [2025-02] refresh after create project
      if (parent_id) {
        db_expanded = new Set([...db_expanded, parent_id])
      }
    } catch (e) {
      console.error(`Failed to create project:`, e)
    }
  }

  async function handle_delete_project(project_id: string) {
    const project = db_projects.find(p => p.id === project_id)
    const sub_count = (children_of[project_id] || []).length
    const msg = sub_count > 0
      ? t('app.delete_project_and_subfolders', { name: project?.name ?? ``, count: String(sub_count) })
      : t('app.delete_project', { name: project?.name ?? `` })
    if (!confirm(msg)) return
    try {
      await delete_project(project_id)
      db_expanded = new Set([...db_expanded].filter(id => id !== project_id))
      await load_db() // [2025-02] refresh after delete project
    } catch (e) {
      console.error(`Failed to delete project:`, e)
    }
  }

  function handle_project_contextmenu(e: MouseEvent, project_id: string) {
    const target = make_project_target(project_id)
    ctx_menu = open_context_menu(e, target)
    ctx_target_snapshot = target
  }

  function handle_result_contextmenu(e: MouseEvent, result: DbResult, parent_id: string) {
    const target = make_result_target(result, parent_id)
    ctx_menu = open_context_menu(e, target)
    ctx_target_snapshot = target
  }

  function close_context_menu() {
    ctx_menu = null
    // [2025-02 bugfix] Do NOT null ctx_target_snapshot here.
    // Svelte 5 {@const} is reactive — nulling triggers re-evaluation before
    // the {#if ctx_menu} block is torn down -> null dereference on .result/.id.
    ctx_copy_submenu = false
    ctx_wf_copy_submenu = false  // workflow "Move to project" submenu
  }

  // --- Project rename (delegated to rsd) ---
  function start_rename_project(project_id: string) {
    rsd.start_rename_project(project_id)
    ctx_menu = null
  }

  async function finish_rename_project() {
    await rsd.finish_rename_project()
  }

  // --- Result rename (delegated to rsd) ---
  function start_rename_result(result: DbResult) {
    rsd.start_rename_result(result)
    ctx_menu = null
  }

  async function finish_rename_result() {
    await rsd.finish_rename_result()
  }

  // --- Result delete ---
  async function handle_delete_result(result: DbResult, parent_id: string) {
    ctx_menu = null
    if (!confirm(t('app.delete_result', { name: result.label || result.formula }))) return
    try {
      await delete_result(result.id)
      await load_db() // [2025-02] refresh after delete
    } catch (e) {
      console.error(`Failed to delete result:`, e)
    }
  }

  // [2025-02] Drag a workflow onto a project folder to assign it there.
  // Uses the same assign_workflow_to_project API as context menu "Move to project".
  async function handle_workflow_drop_on_project(project_id: string) {
    if (!drag_data || drag_data.type !== `workflow`) return
    const wf_id = drag_data.id as string
    drag_data = null
    drop_target_id = null
    try {
      await assign_workflow_to_project(wf_id, project_id)
      await load_db()
    } catch (e) {
      console.error(`Failed to assign workflow to project:`, e)
    }
  }

  // [2025-02] Context menu "Move to project..." submenu for workflows
  let ctx_wf_copy_submenu = $state(false)

  async function ctx_move_workflow_to_project(wf_id: string, project_id: string) {
    ctx_menu = null
    ctx_wf_copy_submenu = false
    try {
      await assign_workflow_to_project(wf_id, project_id)
      await load_db()
    } catch (e) {
      console.error(`Failed to move workflow to project:`, e)
    }
  }

  function ctx_new_subfolder(project_id: string) {
    ctx_menu = null
    handle_create_project(project_id)
  }

  function ctx_save_here(project_id: string) {
    ctx_menu = null
    rsd.do_save_current(project_id)
  }

  // --- Copy result to project (context menu) ---
  let ctx_copy_submenu = $state(false)

  async function ctx_copy_result_to(result_id: number, project_id: string) {
    ctx_menu = null
    ctx_copy_submenu = false
    try {
      await drag_result_to_project(result_id, project_id)
      // [2025-02] Full refresh after copy
      await load_db()
    } catch (e) {
      console.error(`Copy failed:`, e)
    }
  }

  // --- Drag-and-drop helpers ---
  function is_descendant_of(project_id: string, ancestor_id: string): boolean {
    // Walk up the parent chain from project_id to see if ancestor_id is found
    let current: string | null | undefined = project_id
    const visited = new Set<string>()
    while (current) {
      if (current === ancestor_id) return true
      if (visited.has(current)) return false  // prevent infinite loop
      visited.add(current)
      const proj = db_projects.find(p => p.id === current)
      current = proj?.parent_id
    }
    return false
  }

  function can_drop_on(target_id: string | null): boolean {
    if (!drag_data) return false
    if (drag_data.type === `project`) {
      const dragged_id = drag_data.id as string
      if (target_id === null) return true  // root is always valid
      if (target_id === dragged_id) return false  // can't drop on self
      if (is_descendant_of(target_id, dragged_id)) return false  // can't drop on descendant
      // Check current parent — don't drop on current parent (no-op)
      const proj = db_projects.find(p => p.id === dragged_id)
      if ((proj?.parent_id || null) === target_id) return false
      return true
    }
    if (drag_data.type === `workflow`) {
      // Workflows can be dropped on any project folder
      if (target_id === null) return false
      // Don't drop on current project (no-op)
      const wf = db_workflows.find(w => w.id === drag_data!.id)
      if (wf?.project_id === target_id) return false
      return true
    }
    // Results can be dropped on any project
    return target_id !== null
  }

  async function handle_drop(target_project_id: string | null) {
    if (!drag_data) return
    // [2025-02 bugfix] Capture drag_data into local var before any await.
    // ondragend fires during async operations and nulls the $state,
    // causing "Cannot read properties of null" in .some() callback.
    const dragged = { ...drag_data }
    drag_data = null
    drop_target_id = null
    try {
      if (dragged.type === `project`) {
        await update_project(dragged.id as string, { parent_id: target_project_id })
      } else if (dragged.type === `workflow` && target_project_id) {
        await assign_workflow_to_project(dragged.id as string, target_project_id)
      } else if (dragged.type === `result` && target_project_id) {
        const res = await drag_result_to_project(dragged.id as number, target_project_id)
        // If moved (not copied), refresh source project
        if (res.action === `moved`) {
          for (const pid of Object.keys(db_project_saved)) {
            if (db_project_saved[pid]?.some(r => r.id === dragged.id)) {
              await load_project_saved(pid)
              break
            }
          }
        }
      }
      await load_db() // [2025-02] refresh after drag-drop
      if (target_project_id) {
        await load_project_saved(target_project_id)
      }
    } catch (e) {
      console.error(`Drop failed:`, e)
    }
  }


  // ========== Open in Editor helpers ==========
  /** Catgo built-in files: open text content in editor (no save target) */
  function open_local_file_in_editor(file: LocalFile) {
    if (!on_open_editor) return
    const name = file.name.replace(/\.gz$/i, ``)
    if (file.content !== undefined) {
      on_open_editor(file.content, name, ``, ``)
    } else if (file.url) {
      load_from_url(file.url, (content) => {
        if (typeof content === `string`) {
          on_open_editor!(content, name, ``, ``)
        }
      }).catch(err => console.error(`Failed to fetch file for editor:`, err))
    }
  }

  /** DB result: load structure → serialize to CIF → open in editor */
  async function open_result_in_editor(row_id: number, formula: string) {
    if (!on_open_editor) return
    try {
      const structure = await get_result_structure(row_id)
      const json = JSON.stringify(structure, null, 2)
      on_open_editor(json, `${formula}.json`, ``, ``)
    } catch (e) {
      console.error(`Failed to load structure for editor:`, e)
    }
  }

  // ========== Catgo file context menu ==========
  let catgo_ctx = $state<{ x: number; y: number; file: LocalFile } | null>(null)

  // ========== Handlers ==========
  function handle_local_click(file: LocalFile) {
    // Strip .gz suffix — Vite plugin already decompressed .gz content at build time
    const name = file.name.replace(/\.gz$/i, ``)
    if (file.content !== undefined) {
      on_load_file(file.content, name)
    } else if (file.url) {
      // Use load_from_url for proper binary/gzip handling (h5, traj, xyz.gz, etc.)
      load_from_url(file.url, (content, url_name) => {
        // Prefer our cleaned name over the URL-derived name
        on_load_file(content, name || url_name)
      }).catch(err => console.error(`Failed to fetch trajectory:`, err))
    }
  }

  // ========== HPC file browser — extracted to sidebar/hpc-browser.svelte.ts ==========
  const hpc = create_hpc_browser_state({
    get_source: () => source,
    on_load_file,
    on_open_editor,
    on_load_trajectory,
    on_preview_file,
  })
  // Sync bindable props with internal path state
  $effect(() => { hpc_path = hpc.hpc_current_path })
  $effect(() => { fs_path = fsb.fs_current_dir })

</script>

<!-- [2025-02] indent param for depth-aware indentation; folder header = 8+depth*14,
     children = 22+depth*14, workflow sub-results = indent+14 -->
{#snippet result_item(result: DbResult, parent_id: string, indent: number = 22)}
  {#if rsd.renaming_result_id === result.id}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="file-item db-result-row" style:padding-left="{indent}px">
      <svg class="file-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="db-rename-input"
        bind:value={rsd.rename_value}
        onblur={finish_rename_result}
        onkeydown={(e) => { if (e.key === `Enter`) finish_rename_result(); if (e.key === `Escape`) rsd.renaming_result_id = null }}
        autofocus
      />
    </div>
  {:else}
    <button
      class="file-item db-result-row"
      style:padding-left="{indent}px"
      class:loading={db_loading_result === result.id}
      draggable={true}
      ondragstart={(e) => { drag_data = { type: `result`, id: result.id }; e.dataTransfer?.setData(`text/plain`, `result:${result.id}`) }}
      ondragend={() => { drag_data = null; drop_target_id = null }}
      onclick={() => handle_result_click(result.id, result.label || result.formula)}
      oncontextmenu={(e) => handle_result_contextmenu(e, result, parent_id)}
      title={result.label ? `${result.label} (${result.formula})` : result.formula}
    >
      <svg class="file-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
      <span class="file-name">{result.label || result.formula}</span>
      {#if result.energy !== null}
        <span class="db-energy-badge">{format_energy(result.energy)}</span>
      {/if}
    </button>
  {/if}
{/snippet}

{#snippet workflow_row(wf: DbWorkflow, indent: number = 22)}
  <!-- [2025-02] click=expand results, dblclick=open workflow editor -->
  <button
    class="file-item db-workflow-row"
    style:padding-left="{indent}px"
    draggable={true}
    ondragstart={(e) => { drag_data = { type: `workflow`, id: wf.id }; e.dataTransfer?.setData(`text/plain`, `workflow:${wf.id}`) }}
    ondragend={() => { drag_data = null; drop_target_id = null }}
    onclick={() => toggle_workflow(wf.id)}
    ondblclick={() => on_open_workflow?.(wf.id)}
    oncontextmenu={(e) => { const target = make_workflow_target(wf); ctx_menu = open_context_menu(e, target); ctx_target_snapshot = target }}
  >
    <svg class="chevron small" class:open={db_expanded_workflows.has(wf.id)} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M9 18l6-6-6-6" />
    </svg>
    <svg class="db-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
    <span class="file-name">{wf.name}</span>
    <span class="db-wf-status" class:completed={wf.status === `completed`} class:failed={wf.status === `failed`} class:running={wf.status === `running`}>
      {wf.status}
    </span>
  </button>
  {#if db_expanded_workflows.has(wf.id)}
    <div class="db-results" transition:slide={{ duration: 120 }}>
      <!-- Workflow nodes (graph steps) -->
      {#if db_workflow_nodes[wf.id]?.length}
        <div class="wf-nodes-section">
          <div class="wf-nodes-label" style:padding-left="{indent + 14}px">{t('app.steps')}</div>
          {#each db_workflow_nodes[wf.id] as node (node.id)}
            <div class="wf-node-item" style:padding-left="{indent + 20}px">
              <span class="wf-node-icon">{node.icon}</span>
              <span class="wf-node-name">{node.label}</span>
            </div>
          {/each}
        </div>
      {/if}
      <!-- Workflow results -->
      {#if db_workflow_results[wf.id]}
        {#if db_workflow_results[wf.id].length > 0}
          <div class="wf-nodes-label" style:padding-left="{indent + 14}px">{t('app.results')}</div>
        {/if}
        {#each db_workflow_results[wf.id] as result (result.id)}
          {@render result_item(result, wf.id, indent + 14)}
        {/each}
      {:else if !db_workflow_nodes[wf.id]}
        <div class="db-empty-small">{t('app.loading')}</div>
      {/if}
      {#if db_workflow_nodes[wf.id]?.length === 0 && db_workflow_results[wf.id]?.length === 0}
        <div class="db-empty-small">{t('app.empty_workflow')}</div>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet project_node(project: ProjectSummary, depth: number)}
  {@const sub_projects = children_of[project.id] || []}
  {@const saved = db_project_saved[project.id] || []}
  {@const wfs = project_workflows[project.id] || []}
  {@const has_workflows = wfs.length > 0}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="section-header db-project-row"
    class:is-project={has_workflows}
    class:drop-highlight={drop_target_id === project.id}
    style:padding-left="{8 + depth * 14}px"
    draggable={true}
    ondragstart={(e) => { drag_data = { type: `project`, id: project.id }; e.dataTransfer?.setData(`text/plain`, `project:${project.id}`) }}
    ondragend={() => { drag_data = null; drop_target_id = null }}
    ondragover={(e) => { if (can_drop_on(project.id)) { e.preventDefault(); drop_target_id = project.id } }}
    ondragleave={() => { if (drop_target_id === project.id) drop_target_id = null }}
    ondrop={(e) => { e.preventDefault(); drop_target_id = null; handle_drop(project.id) }}
    onclick={() => toggle_project(project.id)}
    oncontextmenu={(e) => handle_project_contextmenu(e, project.id)}
    role="button"
    tabindex="0"
    onkeydown={(e) => { if (e.key === `Enter` || e.key === ` `) toggle_project(project.id) }}
  >
    <svg class="chevron" class:open={db_expanded.has(project.id)} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M9 18l6-6-6-6" />
    </svg>
    {#if has_workflows}
      <svg class="db-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </svg>
    {:else}
      <svg class="db-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
    {/if}
    {#if rsd.renaming_project_id === project.id}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="db-rename-input"
        bind:value={rsd.rename_value}
        onblur={finish_rename_project}
        onkeydown={(e) => { e.stopPropagation(); if (e.key === `Enter`) finish_rename_project(); if (e.key === `Escape`) rsd.renaming_project_id = null }}
        onclick={(e) => e.stopPropagation()}
        autofocus
      />
    {:else}
      <span class="section-title" ondblclick={(e) => { e.stopPropagation(); start_rename_project(project.id) }}>{project.name}</span>
    {/if}
    {#if sub_projects.length > 0}
      <span class="section-badge" style="margin-left: auto; font-size: 9px">{sub_projects.length}</span>
    {/if}
  </div>

  {#if db_expanded.has(project.id)}
    <div class="section-files" transition:slide={{ duration: 150 }}>
      <!-- Sub-projects (recursive) -->
      {#each sub_projects as child (child.id)}
        {@render project_node(child, depth + 1)}
      {/each}
      <!-- Saved structures -->
      {#each saved as result (result.id)}
        {@render result_item(result, project.id, 22 + depth * 14)}
      {/each}
      <!-- Workflows assigned to this project -->
      {#each wfs as wf (wf.id)}
        {@render workflow_row(wf, 22 + depth * 14)}
      {/each}
      {#if sub_projects.length === 0 && saved.length === 0 && wfs.length === 0}
        <div class="db-empty-small">{t('app.empty')}</div>
      {/if}
    </div>
  {/if}
{/snippet}


<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:window onclick={close_context_menu} />

{#if collapsed}
  <!-- [2025-02] Collapsed sidebar: thin strip with expand arrow -->
  <div class="sidebar-collapsed">
    <button
      class="sidebar-expand-btn"
      onclick={() => collapsed = false}
      title={t('app.show_sidebar')}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  </div>
{:else}
  <div class="sidebar" style:width="{width}px">
    <!-- Source selector + collapse button in same row -->
    <div class="source-selector">
      <button
        class="sidebar-collapse-btn"
        onclick={() => collapsed = true}
        title={t('app.hide_sidebar')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <select bind:value={source}>
        <option value="catgo">{t('app.catgo_examples')}</option>
        {#if !STATIC_ONLY}
        <option value="localdb">{t('app.catgo_db')}</option>
        <option value={LOCAL_SESSION_ID}>Local Files</option>
        {#each hpc_sessions as session}
          <option value={session.session_id}>
            {session.username}@{session.host}
          </option>
        {/each}
        {/if}
      </select>
    </div>

    <!-- Content area -->
    <div class="sidebar-content">
      {#if source === `catgo`}
        <!-- Structures section -->
        <button class="section-header" onclick={() => sections_open.structures = !sections_open.structures}>
          <svg class="chevron" class:open={sections_open.structures} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
          <span class="section-title">{t('app.structures')}</span>
          <span class="section-badge">{structure_list.length}</span>
        </button>
        {#if sections_open.structures}
          <div class="section-files" transition:slide={{ duration: 150 }}>
            {#each structure_list as file}
              <button class="file-item" onclick={() => handle_local_click(file)} oncontextmenu={(e) => { if (!on_open_editor) return; e.preventDefault(); e.stopPropagation(); catgo_ctx = { x: e.clientX, y: e.clientY, file } }} title={file.name}>
                <svg class="file-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d={get_file_icon(file.name)} />
                </svg>
                <span class="file-name">{file.name}</span>
              </button>
            {/each}
          </div>
        {/if}

        <!-- Molecules section -->
        <button class="section-header" onclick={() => sections_open.molecules = !sections_open.molecules}>
          <svg class="chevron" class:open={sections_open.molecules} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
          <span class="section-title">{t('app.molecules')}</span>
          <span class="section-badge">{molecule_list.length}</span>
        </button>
        {#if sections_open.molecules}
          <div class="section-files" transition:slide={{ duration: 150 }}>
            {#each molecule_list as file}
              <button class="file-item" onclick={() => handle_local_click(file)} oncontextmenu={(e) => { if (!on_open_editor) return; e.preventDefault(); e.stopPropagation(); catgo_ctx = { x: e.clientX, y: e.clientY, file } }} title={file.name}>
                <svg class="file-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d={get_file_icon(file.name)} />
                </svg>
                <span class="file-name">{file.name}</span>
              </button>
            {/each}
          </div>
        {/if}

        <!-- Trajectories section -->
        <button class="section-header" onclick={() => sections_open.trajectories = !sections_open.trajectories}>
          <svg class="chevron" class:open={sections_open.trajectories} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
          <span class="section-title">{t('app.trajectories')}</span>
          <span class="section-badge">{trajectory_list.length}</span>
        </button>
        {#if sections_open.trajectories}
          <div class="section-files" transition:slide={{ duration: 150 }}>
            {#each trajectory_list as file}
              <button class="file-item" onclick={() => handle_local_click(file)} oncontextmenu={(e) => { if (!on_open_editor) return; e.preventDefault(); e.stopPropagation(); catgo_ctx = { x: e.clientX, y: e.clientY, file } }} title={file.name}>
                <svg class="file-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d={get_file_icon(file.name)} />
                </svg>
                <span class="file-name">{file.name}</span>
              </button>
            {/each}
          </div>
        {/if}

      {:else if source === `localdb`}
        <!-- [2025-02] Local DB browser with database management -->

        <!-- DB file toolbar -->
        <div class="db-file-toolbar">
          <span class="db-name" title={current_db?.path || `Default database`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
            {current_db?.name || `catgo_results`}
          </span>
          <div class="db-file-actions">
            <button class="db-file-btn" onclick={() => load_db()} title={t('app.refresh')} disabled={db_loading}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
              </svg>
            </button>
            <button class="db-file-btn" onclick={handle_new_db} title={t('app.new_database')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <line x1="9" y1="14" x2="15" y2="14" />
              </svg>
            </button>
            <button class="db-file-btn" onclick={handle_open_db} title={t('app.open_database')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
            </button>
            <button class="db-file-btn" onclick={handle_save_as_db} title={t('app.save_database_as')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
          </div>
        </div>

        <!-- [2026-03] Filesystem browser toggle + panel -->
        <div class="fs-toggle-bar">
          <button
            class="fs-toggle-btn"
            class:active={fsb.fs_browser_open}
            onclick={() => {
              fsb.fs_browser_open = !fsb.fs_browser_open
              if (fsb.fs_browser_open && !fsb.fs_current_dir) {
                const db_path = current_db?.path
                const last_sep = db_path ? Math.max(db_path.lastIndexOf(`/`), db_path.lastIndexOf(`\\`)) : -1
                fsb.fs_browse(db_path && last_sep > 0 ? db_path.substring(0, last_sep) : `~`)
              }
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
            {t('app.browse_files')}
            <svg class="chevron" class:open={fsb.fs_browser_open} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </div>

        {#if fsb.fs_browser_open}
          <div class="fs-browser" transition:slide={{ duration: 150 }}>
            <!-- Address bar -->
            <div class="fs-address-bar">
              <button class="fs-addr-btn" onclick={fsb.fs_go_up} title={t('app.go_up')} disabled={!fsb.fs_parent || fsb.fs_parent === fsb.fs_current_dir}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              {#if fsb.fs_path_editing}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="fs-addr-input"
                  type="text"
                  bind:value={fsb.fs_path_input}
                  autofocus
                  onkeydown={(e) => { if (e.key === `Enter`) fsb.fs_submit_path(); if (e.key === `Escape`) fsb.fs_path_editing = false }}
                  onblur={() => fsb.fs_path_editing = false}
                />
              {:else}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="fs-breadcrumbs"
                  ondblclick={() => { fsb.fs_path_editing = true; fsb.fs_path_input = fsb.fs_current_dir }}
                >
                  {#each fs_get_breadcrumbs(fsb.fs_current_dir) as crumb, i}
                    {#if i > 0}<span class="fs-sep">/</span>{/if}
                    <button class="fs-crumb" onclick={() => fsb.fs_browse(crumb.path)}>{crumb.label}</button>
                  {/each}
                </div>
              {/if}
              <button class="fs-addr-btn" onclick={() => fsb.fs_browse(fsb.fs_current_dir)} title={t('app.refresh')} disabled={fsb.fs_loading}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
                </svg>
              </button>
              <button class="fs-addr-btn" onclick={() => { fsb.fs_new_folder = true; fsb.fs_new_folder_name = t('app.new_folder') }} title={t('app.new_folder')}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
              </button>
            </div>

            {#if fsb.fs_error}
              <div class="fs-error">{fsb.fs_error}</div>
            {/if}

            {#if fsb.fs_new_folder}
              <div class="fs-new-folder-row">
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="fs-new-folder-input"
                  type="text"
                  bind:value={fsb.fs_new_folder_name}
                  autofocus
                  onkeydown={(e) => { if (e.key === `Enter`) fsb.fs_do_mkdir(); if (e.key === `Escape`) fsb.fs_new_folder = false }}
                  onblur={() => fsb.fs_new_folder = false}
                  placeholder={t('app.folder_name_placeholder')}
                />
              </div>
            {/if}

            {#if fsb.fs_clipboard}
              <div class="fs-clipboard-bar">
                <span class="fs-clip-op">{fsb.fs_clipboard.op === `copy` ? t('app.copied') : t('app.cut')}:</span>
                <span class="fs-clip-name">{fsb.fs_clipboard.item.name}</span>
                <button class="fs-clip-paste" onclick={fsb.fs_do_paste} disabled={fsb.fs_op_loading}>{t('app.paste')}</button>
                <button class="fs-clip-clear" onclick={() => fsb.fs_clipboard = null}>&#x2715;</button>
              </div>
            {/if}

            {#if fsb.fs_loading}
              <div class="fs-status">{t('app.loading')}</div>
            {:else}
              <div class="fs-file-list">
                {#each fsb.fs_items as item}
                  <button
                    class="fs-file-item {fs_file_icon_class(item)}"
                    onclick={() => fsb.fs_handle_click(item)}
                    oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); fsb.fs_ctx = { x: e.clientX, y: e.clientY, item } }}
                    title={item.path}
                    draggable={item.type === `file`}
                    ondragstart={(e) => {
                      if (item.type !== `file` || !e.dataTransfer) return
                      e.dataTransfer.setData(`application/x-catgo-filepath`, item.path)
                      e.dataTransfer.setData(`text/plain`, item.name)
                      e.dataTransfer.effectAllowed = `copy`
                    }}
                  >
                    {#if item.type === `dir`}
                      <svg class="fs-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                      </svg>
                    {:else if is_db_file(item.name)}
                      <svg class="fs-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <ellipse cx="12" cy="5" rx="9" ry="3" />
                        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                      </svg>
                    {:else if is_structure_file(item.name)}
                      <svg class="fs-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d={get_file_icon(item.name)} />
                      </svg>
                    {:else}
                      <svg class="fs-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    {/if}
                    <span class="fs-file-name">{item.name}</span>
                  </button>
                {/each}
                {#if fsb.fs_items.length === 0 && !fsb.fs_error}
                  <div class="fs-empty">{t('app.empty_directory')}</div>
                {/if}
              </div>
            {/if}

            <!-- Export current structure to this directory -->
            {#if on_save_structure}
              <div class="fs-export-bar">
                <input
                  class="fs-export-input"
                  type="text"
                  bind:value={fsb.fs_export_name}
                  placeholder={t('app.file_name_placeholder')}
                  onkeydown={(e) => { if (e.key === `Enter`) fsb.fs_export_current() }}
                />
                <button
                  class="fs-export-btn"
                  onclick={fsb.fs_export_current}
                  disabled={fsb.fs_exporting || !fsb.fs_export_name.trim()}
                  title={t('app.export_current_structure_to_directory')}
                >
                  {fsb.fs_exporting ? `...` : `Export`}
                </button>
              </div>
              {#if fsb.fs_export_msg}
                <div class="fs-export-msg" class:error={fsb.fs_export_msg.includes(`fail`) || fsb.fs_export_msg.includes(`No `)}>
                  {fsb.fs_export_msg}
                </div>
              {/if}
            {/if}
          </div>
        {/if}

        <!-- Save current structure or workflow -->
        {#if on_save_structure || on_save_workflow}
          <div class="db-toolbar">
            {#if rsd.show_save_dialog}
              <div class="db-save-picker">
                <span class="db-save-label">{t('app.save_to')}</span>
                <select class="db-save-select" bind:value={rsd.save_target_project}>
                  <option value={null}>{t('app.no_folder')}</option>
                  {#each db_projects as p}
                    <option value={p.id}>{p.name}</option>
                  {/each}
                </select>
                <div class="db-save-actions">
                  <button class="db-save-confirm" onclick={() => rsd.do_save_current(rsd.save_target_project)} disabled={rsd.saving}>
                    {rsd.saving ? `...` : t('common.save')}
                  </button>
                  <button class="db-save-cancel" onclick={() => rsd.show_save_dialog = false}>{t('common.cancel')}</button>
                </div>
              </div>
            {:else}
              <button class="db-save-btn" onclick={() => { rsd.show_save_dialog = true; rsd.save_target_project = db_projects[0]?.id || null }} disabled={rsd.saving}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                {rsd.saving ? t('common.saving') : t('app.save_current')}
              </button>
            {/if}
          </div>
        {/if}

        {#if db_loading}
          <div class="db-status">{t('app.loading')}</div>
        {:else if db_error}
          <div class="db-status db-error">{db_error}</div>
          <button class="db-retry-btn" onclick={load_db}>{t('app.retry')}</button>
        {:else}
          <!-- ===== Projects section (structures + workflows inside projects) ===== -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="section-header db-section-header"
            class:drop-highlight={drop_target_id === `__root__`}
            onclick={() => structures_section_open = !structures_section_open}
            ondragover={(e) => { if (can_drop_on(null)) { e.preventDefault(); drop_target_id = `__root__` } }}
            ondragleave={() => { if (drop_target_id === `__root__`) drop_target_id = null }}
            ondrop={(e) => { e.preventDefault(); drop_target_id = null; handle_drop(null) }}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === `Enter` || e.key === ` `) structures_section_open = !structures_section_open }}
          >
            <svg class="chevron" class:open={structures_section_open} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M9 18l6-6-6-6" />
            </svg>
            <span class="section-title">{t('app.projects')}</span>
            <span class="section-badge">{root_projects.length}</span>
            <button class="db-add-btn" onclick={(e) => { e.stopPropagation(); handle_create_project() }} title={t('app.new_project_folder')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>

          {#if structures_section_open}
            {#if root_projects.length === 0}
              <div class="db-empty">No project folders yet. Click + to create one.</div>
            {/if}

            <!-- Recursive project tree (structures + workflows inside projects) -->
            {#each root_projects as project (project.id)}
              {@render project_node(project, 0)}
            {/each}

            <!-- Unassigned workflows (not in any project) -->
            {#if unassigned_workflows.length > 0}
              <div class="section-header db-section-header" style="margin-top: 4px; padding-left: 22px">
                <span class="section-title" style="font-size: 10px; opacity: 0.7">Unassigned</span>
                <span class="section-badge">{unassigned_workflows.length}</span>
              </div>
              {#each unassigned_workflows as wf (wf.id)}
                {@render workflow_row(wf)}
              {/each}
            {/if}
          {/if}

        {/if}

      {:else if !STATIC_ONLY}
        <!-- HPC remote file browser -->
        <div class="hpc-tree-container">
          <!-- Upload toolbar -->
          <div class="hpc-toolbar">
            <label class="hpc-upload-btn">
              Upload
              <input type="file" onchange={hpc.hpc_upload} multiple hidden />
            </label>
            {#if hpc.hpc_upload_progress !== null}
              <div class="hpc-progress">
                <div class="hpc-progress-fill" style="width: {hpc.hpc_upload_progress}%"></div>
                <span class="hpc-progress-text">{hpc.hpc_upload_progress}%</span>
              </div>
            {/if}
          </div>
          {#if hpc.hpc_files_error}
            <div class="hpc-error">{hpc.hpc_files_error}</div>
          {/if}
          {#if hpc.hpc_loading_file}
            <div class="hpc-loading-bar">
              <div class="hpc-loading-bar-inner"></div>
              <span class="hpc-loading-text">Loading {hpc.hpc_loading_file.name}{hpc.hpc_loading_file.size ? ` (${format_file_size(hpc.hpc_loading_file.size)})` : ``}...</span>
            </div>
          {/if}
          {#key hpc.hpc_file_tree_key}
            <FileTree
              session_id={source}
              root_path={hpc.hpc_current_path}
              on_load_structure={hpc.hpc_load_structure}
              on_open_editor={on_open_editor ? hpc.hpc_open_editor : undefined}
              on_preview_file={on_preview_file ? (file, type) => hpc.hpc_open_preview(file, type) : undefined}
              on_load_trajectory={on_load_trajectory ? hpc.hpc_merge_trajectory : undefined}
              on_navigate={(path) => { hpc.hpc_current_path = path }}
              on_download={hpc.hpc_download}
              on_copy_path={hpc.hpc_copy_path}
              on_mkdir={async (parent_path, name) => {
                await hpc.hpc_do_mkdir(parent_path, name)
              }}
              on_delete={async (file) => {
                await hpc.hpc_do_delete(file)
              }}
              on_rename={async (file, new_name) => {
                await hpc.hpc_do_rename(file, new_name)
              }}
              on_copy_file={async (src, dest) => {
                await hpc.hpc_do_copy(src, dest)
              }}
              on_move_file={async (src, dest) => {
                await hpc.hpc_do_move(src, dest)
              }}
              on_upload={async (files, dest_path) => {
                await hpc.hpc_do_upload(files, dest_path)
              }}
              merging_dir={hpc.hpc_merging_dir}
              merge_status={hpc.hpc_merge_status}
            />
          {/key}
        </div>
      {/if}
    </div>

    <!-- System diagnostics toggle -->
    <div class="sidebar-footer">
      <button class="sidebar-status-btn" onclick={() => show_diagnostics = !show_diagnostics}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
        System
      </button>
    </div>
  </div>
{/if}

{#if show_diagnostics}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="diagnostics-overlay" onclick={() => show_diagnostics = false}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="diagnostics-overlay-content" onclick={(e) => e.stopPropagation()}>
      <div class="diagnostics-overlay-header">
        <span>System Diagnostics</span>
        <button class="diagnostics-close-btn" onclick={() => show_diagnostics = false}>&times;</button>
      </div>
      <DiagnosticsPanel />
    </div>
  </div>
{/if}

{#snippet copy_project_tree(result_id: number, projects: ProjectSummary[], depth: number)}
  {#each projects as p (p.id)}
    <button class="ctx-item ctx-sub" style:padding-left="{20 + depth * 12}px" onclick={() => ctx_copy_result_to(result_id, p.id)}>
      <svg class="ctx-folder-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
      {p.name}
    </button>
    {#if children_of[p.id]?.length}
      {@render copy_project_tree(result_id, children_of[p.id], depth + 1)}
    {/if}
  {/each}
{/snippet}

{#snippet move_wf_project_tree(wf_id: string, projects: ProjectSummary[], depth: number)}
  {#each projects as p (p.id)}
    <button class="ctx-item ctx-sub" style:padding-left="{20 + depth * 12}px" onclick={() => ctx_move_workflow_to_project(wf_id, p.id)}>
      <svg class="ctx-folder-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
      {p.name}
    </button>
    {#if children_of[p.id]?.length}
      {@render move_wf_project_tree(wf_id, children_of[p.id], depth + 1)}
    {/if}
  {/each}
{/snippet}

<!-- Context menu -->
{#if ctx_menu && ctx_target_snapshot}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ctx-menu" style:left="{ctx_menu.x}px" style:top="{ctx_menu.y}px" onclick={(e) => e.stopPropagation()}>
    {#if ctx_target_snapshot.type === `project`}
      {@const pid = ctx_target_snapshot.id}
      <button class="ctx-item" onclick={() => ctx_new_subfolder(pid)}>
        New subfolder
      </button>
      {#if on_save_structure}
        <button class="ctx-item" onclick={() => ctx_save_here(pid)}>
          Save structure here
        </button>
      {/if}
      <div class="ctx-divider"></div>
      <button class="ctx-item" onclick={() => start_rename_project(pid)}>
        Rename
      </button>
      <button class="ctx-item ctx-danger" onclick={() => { close_context_menu(); handle_delete_project(pid) }}>
        Delete
      </button>
    {:else if ctx_target_snapshot.type === `workflow`}
      {@const wf = ctx_target_snapshot.wf}
      <button class="ctx-item" onclick={() => { close_context_menu(); on_open_workflow?.(wf.id) }}>
        Open in editor
      </button>
      {#if db_projects.length > 0}
        <div class="ctx-divider"></div>
        <button class="ctx-item" onclick={(e) => { e.stopPropagation(); ctx_wf_copy_submenu = !ctx_wf_copy_submenu }}>
          Move to project...
        </button>
        {#if ctx_wf_copy_submenu}
          {@render move_wf_project_tree(wf.id, root_projects, 0)}
        {/if}
      {/if}
    {:else if ctx_target_snapshot.type === `result`}
      {@const result = ctx_target_snapshot.result}
      {@const parent = ctx_target_snapshot.parent_id}
      <button class="ctx-item" onclick={() => { close_context_menu(); handle_result_click(result.id, result.label || result.formula) }}>
        Load structure
      </button>
      {#if on_open_editor}
        <button class="ctx-item" onclick={() => { close_context_menu(); open_result_in_editor(result.id, result.label || result.formula) }}>
          Open in Editor
        </button>
      {/if}
      <div class="ctx-divider"></div>
      <!-- Copy to project submenu -->
      {#if db_projects.length > 0}
        <button class="ctx-item" onclick={(e) => { e.stopPropagation(); ctx_copy_submenu = !ctx_copy_submenu }}>
          Copy to...
        </button>
        {#if ctx_copy_submenu}
          {@render copy_project_tree(result.id, root_projects, 0)}
        {/if}
        <div class="ctx-divider"></div>
      {/if}
      <button class="ctx-item" onclick={() => start_rename_result(result)}>
        Rename
      </button>
      <button class="ctx-item ctx-danger" onclick={() => handle_delete_result(result, parent)}>
        Delete
      </button>
    {/if}
  </div>
{/if}

<!-- catgo built-in file context menu -->
{#if catgo_ctx}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="fs-ctx-overlay" onclick={() => catgo_ctx = null}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="fs-ctx-menu" style="left: {catgo_ctx.x}px; top: {catgo_ctx.y}px" onclick={(e) => e.stopPropagation()}>
      <button class="fs-ctx-item" onclick={() => { const f = catgo_ctx?.file; catgo_ctx = null; if (f) open_local_file_in_editor(f) }}>{t('app.open_in_editor')}</button>
      <button class="fs-ctx-item" onclick={() => { const f = catgo_ctx?.file; catgo_ctx = null; if (f) handle_local_click(f) }}>{t('app.load_structure')}</button>
    </div>
  </div>
{/if}

<!-- [2026-03] fs-browser context menu -->
{#if fsb.fs_ctx}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="fs-ctx-overlay" onclick={() => fsb.fs_ctx = null}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="fs-ctx-menu" style="left: {fsb.fs_ctx.x}px; top: {fsb.fs_ctx.y}px" onclick={(e) => e.stopPropagation()}>
      {#if fsb.fs_ctx.item.type === `dir`}
        <button class="fs-ctx-item" onclick={() => { fsb.fs_new_folder = true; fsb.fs_new_folder_name = t('app.new_folder'); fsb.fs_ctx = null }}>{t('app.new_folder')}</button>
      {:else if fsb.fs_ctx.item.type === `file`}
        {#if is_structure_file(fsb.fs_ctx.item.name)}
          <button class="fs-ctx-item" onclick={async () => { if (!fsb.fs_ctx) return; const item = fsb.fs_ctx.item; fsb.fs_ctx = null; try { const result = await read_file(item.path); on_load_file(result.content, result.name, item.path) } catch (e) { fsb.fs_error = e instanceof Error ? e.message : t('app.cannot_read_file') } }}>{t('app.load_structure')}</button>
        {/if}
        {#if on_open_editor}
          <button class="fs-ctx-item" onclick={async () => { if (!fsb.fs_ctx) return; const item = fsb.fs_ctx.item; fsb.fs_ctx = null; try { const result = await read_file(item.path); on_open_editor!(result.content, result.name, item.path, ``); } catch (e) { fsb.fs_error = e instanceof Error ? e.message : t('app.cannot_read_file') } }}>{t('app.open_in_editor')}</button>
        {/if}
        {#if on_preview_file && /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?)$/i.test(fsb.fs_ctx.item.name)}
          <button class="fs-ctx-item" onclick={async () => { if (!fsb.fs_ctx) return; const item = fsb.fs_ctx.item; fsb.fs_ctx = null; try { const { readFile } = await import(`@tauri-apps/plugin-fs`); const bytes = await readFile(item.path); const base64 = btoa(String.fromCharCode(...bytes)); const ext = item.name.toLowerCase().split(`.`).pop() || ``; on_preview_file!(`image`, item.name, item.path, ``, undefined, base64, `image/${ext === `jpg` ? `jpeg` : ext}`) } catch (e) { fsb.fs_error = e instanceof Error ? e.message : t('app.cannot_read_image') } }}>{t('app.preview_image')}</button>
        {/if}
        <button class="fs-ctx-item" onclick={async () => { if (!fsb.fs_ctx) return; const item = fsb.fs_ctx.item; fsb.fs_ctx = null; try { const { open } = await import(`@tauri-apps/plugin-shell`); await open(item.path) } catch (e) { fsb.fs_error = e instanceof Error ? e.message : t('app.cannot_open_file') } }}>{t('app.open_with_system_app')}</button>
      {/if}
      <button class="fs-ctx-item" onclick={() => { fsb.fs_renaming = fsb.fs_ctx?.item ?? null; fsb.fs_rename_val = fsb.fs_ctx?.item.name ?? ``; fsb.fs_ctx = null }}>{t('common.rename')}</button>
      <button class="fs-ctx-item" onclick={() => { if (fsb.fs_ctx) fsb.fs_clipboard = { item: fsb.fs_ctx.item, op: `copy` }; fsb.fs_ctx = null }}>{t('common.copy')}</button>
      <button class="fs-ctx-item" onclick={() => { if (fsb.fs_ctx) fsb.fs_clipboard = { item: fsb.fs_ctx.item, op: `cut` }; fsb.fs_ctx = null }}>{t('common.cut')}</button>
      <hr class="fs-ctx-divider" />
      <button class="fs-ctx-item danger" onclick={() => { fsb.fs_delete_confirm = fsb.fs_ctx?.item ?? null; fsb.fs_ctx = null }}>{t('common.delete')}</button>
    </div>
  </div>
{/if}

<!-- fs-browser delete confirm -->
{#if fsb.fs_delete_confirm}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="fs-ctx-overlay" onclick={() => fsb.fs_delete_confirm = null}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="fs-confirm-dialog" onclick={(e) => e.stopPropagation()}>
      <p>{t('app.delete_item_confirm', { name: fsb.fs_delete_confirm.name })}</p>
      <p class="fs-confirm-path">{fsb.fs_delete_confirm.path}</p>
      <div class="fs-confirm-actions">
        <button class="fs-confirm-btn cancel" onclick={() => fsb.fs_delete_confirm = null}>{t('common.cancel')}</button>
        <button class="fs-confirm-btn danger" disabled={fsb.fs_op_loading} onclick={fsb.fs_do_delete}>{fsb.fs_op_loading ? t('app.deleting') : t('common.delete')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- fs-browser rename dialog -->
{#if fsb.fs_renaming}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="fs-ctx-overlay" onclick={() => fsb.fs_renaming = null}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="fs-confirm-dialog" onclick={(e) => e.stopPropagation()}>
      <p>{t('app.rename_item', { name: fsb.fs_renaming.name })}</p>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="fs-rename-input" type="text" bind:value={fsb.fs_rename_val} autofocus
        onkeydown={(e) => { if (e.key === `Enter`) fsb.fs_do_rename(); if (e.key === `Escape`) fsb.fs_renaming = null }}
      />
      <div class="fs-confirm-actions">
        <button class="fs-confirm-btn cancel" onclick={() => fsb.fs_renaming = null}>{t('common.cancel')}</button>
        <button class="fs-confirm-btn confirm" disabled={fsb.fs_op_loading || !fsb.fs_rename_val.trim()} onclick={fsb.fs_do_rename}>{fsb.fs_op_loading ? t('app.renaming') : t('common.rename')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- [2025-02] In-app file picker modal -->
<FilePickerModal
  bind:visible={file_picker_visible}
  mode={file_picker_mode}
  bind:dir={file_picker_dir}
  bind:filename={file_picker_filename}
  items={file_picker_items}
  loading={file_picker_loading}
  parent={file_picker_parent}
  onbrowse={browse_to}
  onconfirm={file_picker_confirm}
/>

<style>
  /* [2025-02] Collapsed sidebar strip */
  .sidebar-collapsed {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 24px;
    height: 100%;
    background: var(--page-bg, #0f1520);
    border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
    flex-shrink: 0;
    padding-top: 6px;
  }

  .sidebar-expand-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: none;
    color: var(--text-color-muted, #6b7280);
    cursor: pointer;
    border-radius: 3px;
    transition: color 0.15s, background 0.15s;
  }

  .sidebar-expand-btn:hover {
    color: var(--text-color, #e2e8f0);
    background: rgba(128, 128, 128, 0.15);
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--page-bg, #0f1520);
    border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
    overflow: hidden;
    flex-shrink: 0;
  }

  /* [2025-02] Collapse button inline with source selector */
  .sidebar-collapse-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: transparent;
    border: none;
    color: var(--text-color-muted, #6b7280);
    cursor: pointer;
    border-radius: 3px;
    flex-shrink: 0;
    transition: color 0.15s, background 0.15s;
  }

  .sidebar-collapse-btn:hover {
    color: var(--text-color, #e2e8f0);
    background: rgba(128, 128, 128, 0.15);
  }

  .source-selector {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  }

  .source-selector select {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    font-size: 11px;
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
    color: var(--text-color, #374151);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 4px;
    cursor: pointer;
    outline: none;
  }

  .source-selector select option {
    background: var(--dialog-bg, #ffffff);
    color: var(--text-color, #374151);
  }

  .source-selector select:hover {
    border-color: var(--accent-color, #3b82f6);
  }

  .sidebar-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(128, 128, 128, 0.3) transparent;
  }

  /* Section headers */
  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.08));
    color: var(--text-color, #e2e8f0);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    cursor: pointer;
    transition: background 0.12s;
    text-align: left;
  }

  .section-header:hover {
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
  }

  .chevron {
    flex-shrink: 0;
    transition: transform 0.15s;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .section-title {
    flex: 1;
    min-width: 0;
  }

  .section-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 8px;
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    flex-shrink: 0;
  }

  /* File items */
  .section-files {
    padding: 2px 0;
  }

  .file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 8px 4px 22px;
    background: transparent;
    border: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
  }

  .file-item:hover {
    background: rgba(59, 130, 246, 0.08);
    color: var(--text-color, #e2e8f0);
  }

  .file-item:active {
    background: rgba(59, 130, 246, 0.15);
  }

  .file-icon {
    flex-shrink: 0;
    opacity: 0.5;
  }

  .file-item:hover .file-icon {
    opacity: 0.8;
  }

  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* HPC tree container */
  .hpc-tree-container {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
  }
  .hpc-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    flex-shrink: 0;
  }
  .hpc-upload-btn {
    font-size: 0.72em;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    background: light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08));
    border: 1px solid light-dark(rgba(0,0,0,0.1), rgba(255,255,255,0.12));
    color: var(--text-color-muted, #aaa);
  }
  .hpc-upload-btn:hover {
    background: light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.15));
    color: var(--text-color);
  }
  .hpc-progress {
    flex: 1;
    height: 12px;
    background: light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.06));
    border-radius: 6px;
    overflow: hidden;
    position: relative;
  }
  .hpc-progress-fill {
    height: 100%;
    background: var(--accent-color, #3b82f6);
    border-radius: 6px;
    transition: width 0.2s;
  }
  .hpc-progress-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6em;
    color: var(--text-color);
  }
  .hpc-error {
    padding: 4px 8px;
    font-size: 0.72em;
    color: var(--error-color);
    flex-shrink: 0;
  }

  .hpc-loading-bar {
    padding: 4px 8px;
    flex-shrink: 0;
    position: relative;
    overflow: hidden;
    background: rgba(59, 130, 246, 0.08);
    border-bottom: 1px solid var(--border-color, rgba(128,128,128,0.15));
  }
  .hpc-loading-bar-inner {
    position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, rgba(59,130,246,0.2), transparent);
    animation: hpc-loading-slide 1.5s ease-in-out infinite;
  }
  @keyframes hpc-loading-slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  .hpc-loading-text {
    position: relative; z-index: 1;
    font-size: 0.72em;
    color: var(--text-color-secondary, #94a3b8);
  }

  /* ========== Local DB styles ========== */

  /* [2025-02] DB file management toolbar */
  .db-file-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.08));
    gap: 4px;
  }

  .db-name {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--text-color-muted, #94a3b8);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .db-file-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }

  .db-file-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: transparent;
    border: none;
    color: var(--text-color-muted, #6b7280);
    cursor: pointer;
    border-radius: 3px;
    transition: color 0.15s, background 0.15s;
  }

  .db-file-btn:hover {
    color: var(--text-color, #e2e8f0);
    background: rgba(128, 128, 128, 0.15);
  }

  .db-toolbar {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.08));
  }

  .db-save-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 5px 8px;
    font-size: 11px;
    background: rgba(59, 130, 246, 0.12);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.25);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.12s;
  }

  .db-save-btn:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.2);
  }

  .db-save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .db-save-picker {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .db-save-label {
    font-size: 10px;
    color: var(--text-color-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .db-save-select {
    width: 100%;
    padding: 3px 4px;
    font-size: 11px;
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
    color: var(--text-color, #e2e8f0);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 3px;
    outline: none;
  }
  .db-save-select option {
    background: var(--dialog-bg, #1c1d21);
    color: var(--text-color, #e2e8f0);
  }

  .db-save-actions {
    display: flex;
    gap: 4px;
  }

  .db-save-confirm {
    flex: 1;
    padding: 3px 8px;
    font-size: 11px;
    background: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 3px;
    cursor: pointer;
  }

  .db-save-confirm:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.3);
  }

  .db-save-confirm:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .db-save-cancel {
    padding: 3px 8px;
    font-size: 11px;
    background: rgba(128, 128, 128, 0.1);
    color: var(--text-color-muted, #94a3b8);
    border: 1px solid rgba(128, 128, 128, 0.2);
    border-radius: 3px;
    cursor: pointer;
  }

  .db-save-cancel:hover {
    background: rgba(128, 128, 128, 0.2);
  }

  .db-status {
    padding: 12px 8px;
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
    text-align: center;
  }

  .db-error {
    color: #f87171;
  }

  .db-retry-btn {
    display: block;
    margin: 0 auto 8px;
    padding: 3px 12px;
    font-size: 10px;
    background: rgba(128, 128, 128, 0.1);
    color: var(--text-color-muted, #94a3b8);
    border: 1px solid rgba(128, 128, 128, 0.2);
    border-radius: 3px;
    cursor: pointer;
  }

  /* ========== Filesystem browser ========== */

  .fs-toggle-bar {
    padding: 2px 8px;
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.08));
  }

  .fs-toggle-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 4px 6px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    font-weight: 600;
    background: transparent;
    border: none;
    color: var(--text-color-muted, #94a3b8);
    cursor: pointer;
    border-radius: 3px;
    transition: color 0.12s, background 0.12s;
  }

  .fs-toggle-btn:hover {
    color: var(--text-color, #e2e8f0);
    background: rgba(128, 128, 128, 0.1);
  }

  .fs-toggle-btn.active {
    color: #60a5fa;
  }

  .fs-toggle-btn .chevron {
    margin-left: auto;
  }

  .fs-browser {
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.08));
  }

  .fs-address-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px 6px;
    background: rgba(0, 0, 0, 0.15);
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.08));
  }

  .fs-addr-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: var(--text-color-muted, #6b7280);
    cursor: pointer;
    border-radius: 3px;
    transition: color 0.12s, background 0.12s;
  }

  .fs-addr-btn:hover:not(:disabled) {
    color: var(--text-color, #e2e8f0);
    background: rgba(128, 128, 128, 0.15);
  }

  .fs-addr-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .fs-breadcrumbs {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    gap: 1px;
    padding: 0 2px;
    cursor: text;
  }

  .fs-breadcrumbs::-webkit-scrollbar {
    display: none;
  }

  .fs-sep {
    color: var(--text-color-muted, #6b7280);
    font-size: 9px;
    flex-shrink: 0;
  }

  .fs-crumb {
    background: none;
    border: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 10px;
    padding: 1px 3px;
    cursor: pointer;
    border-radius: 2px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .fs-crumb:hover {
    color: var(--text-color, #e2e8f0);
    background: rgba(128, 128, 128, 0.15);
  }

  .fs-crumb:last-child {
    color: var(--text-color, #e2e8f0);
    font-weight: 500;
  }

  .fs-addr-input {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    font-size: 10px;
    font-family: monospace;
    background: rgba(0, 0, 0, 0.3);
    color: var(--text-color, #e2e8f0);
    border: 1px solid rgba(59, 130, 246, 0.4);
    border-radius: 2px;
    outline: none;
  }

  .fs-file-list {
    max-height: 260px;
    overflow-y: auto;
    padding: 2px 0;
  }

  .fs-file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 10px;
    font-size: 11px;
    background: transparent;
    border: none;
    color: var(--text-color, #e2e8f0);
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  .fs-file-item:hover {
    background: rgba(128, 128, 128, 0.12);
  }

  .fs-file-item.fs-icon-dir {
    color: #fbbf24;
  }

  .fs-file-item.fs-icon-db {
    color: #60a5fa;
  }

  .fs-file-item.fs-icon-structure {
    color: #34d399;
  }

  .fs-file-item.fs-icon-file {
    color: var(--text-color-muted, #94a3b8);
  }

  .fs-icon {
    flex-shrink: 0;
    opacity: 0.8;
  }

  .fs-file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: var(--text-color, #e2e8f0);
  }

  .fs-error {
    padding: 6px 10px;
    font-size: 10px;
    color: #f87171;
  }

  .fs-status {
    padding: 8px 10px;
    font-size: 10px;
    color: var(--text-color-muted, #94a3b8);
    text-align: center;
  }

  .fs-empty {
    padding: 12px 10px;
    font-size: 10px;
    color: var(--text-color-muted, #6b7280);
    text-align: center;
    font-style: italic;
  }

  .fs-export-bar {
    display: flex;
    gap: 4px;
    padding: 4px 8px;
    border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.08));
  }

  .fs-export-input {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    font-size: 10px;
    background: rgba(0, 0, 0, 0.2);
    color: var(--text-color, #e2e8f0);
    border: 1px solid rgba(128, 128, 128, 0.2);
    border-radius: 3px;
    outline: none;
  }

  .fs-export-input:focus {
    border-color: rgba(59, 130, 246, 0.4);
  }

  .fs-export-btn {
    padding: 3px 10px;
    font-size: 10px;
    background: rgba(34, 197, 94, 0.15);
    color: #34d399;
    border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 3px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.12s;
  }

  .fs-export-btn:hover:not(:disabled) {
    background: rgba(34, 197, 94, 0.25);
  }

  .fs-export-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .fs-export-msg {
    padding: 2px 8px 4px;
    font-size: 9px;
    color: #34d399;
  }

  .fs-export-msg.error {
    color: #f87171;
  }

  .db-section-header {
    cursor: pointer;
    text-transform: uppercase;
    font-weight: 600;
  }

  .db-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: 1px solid rgba(128, 128, 128, 0.2);
    border-radius: 3px;
    color: var(--text-color-muted, #94a3b8);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.12s, color 0.12s;
  }

  .db-add-btn:hover {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    border-color: rgba(59, 130, 246, 0.3);
  }

  .db-empty {
    padding: 12px 8px;
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
    text-align: center;
    font-style: italic;
  }

  .db-empty-small {
    padding: 4px 8px 4px 40px;
    font-size: 10px;
    color: var(--text-color-muted, #94a3b8);
    font-style: italic;
  }

  .db-project-row {
    text-transform: none;
    font-weight: 500;
    letter-spacing: normal;
  }

  .db-project-row.is-project .db-icon {
    opacity: 0.8;
    color: var(--accent-color, #3b82f6);
  }

  .drop-highlight {
    background: rgba(59, 130, 246, 0.15) !important;
    outline: 1px dashed rgba(59, 130, 246, 0.5);
    outline-offset: -1px;
  }

  .db-icon {
    flex-shrink: 0;
    opacity: 0.6;
  }

  .db-rename-input {
    flex: 1;
    min-width: 0;
    padding: 1px 4px;
    font-size: 11px;
    background: rgba(128, 128, 128, 0.15);
    color: var(--text-color, #e2e8f0);
    border: 1px solid var(--accent-color, #3b82f6);
    border-radius: 2px;
    outline: none;
  }

  .db-workflow-row {
    gap: 5px;
  }

  .chevron.small {
    width: 10px;
    height: 10px;
  }

  .db-wf-status {
    font-size: 9px;
    padding: 0 4px;
    border-radius: 6px;
    background: rgba(128, 128, 128, 0.15);
    color: var(--text-color-muted, #94a3b8);
    flex-shrink: 0;
    text-transform: lowercase;
  }

  .db-wf-status.completed {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
  }

  .db-wf-status.failed {
    background: rgba(248, 113, 113, 0.15);
    color: #f87171;
  }

  .db-wf-status.running {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
  }

  .db-results {
    padding: 0;
  }

  .wf-nodes-section {
    padding-bottom: 2px;
  }

  .wf-nodes-label {
    font-size: 9px;
    font-weight: 600;
    color: var(--text-color-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 4px 0 2px;
  }

  .wf-node-item {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 0;
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
  }

  .wf-node-icon {
    font-size: 11px;
    flex-shrink: 0;
  }

  .wf-node-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .db-result-row {
    gap: 5px;
  }

  .db-result-row.loading {
    opacity: 0.5;
    pointer-events: none;
  }

  .db-energy-badge {
    font-size: 9px;
    padding: 0 4px;
    border-radius: 6px;
    background: rgba(168, 85, 247, 0.12);
    color: #c084fc;
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* Context menu */
  .ctx-menu {
    position: fixed;
    z-index: 9999;
    min-width: 140px;
    background: var(--page-bg, #1e293b);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    padding: 4px;
    overflow: hidden;
  }

  .ctx-item {
    display: block;
    width: 100%;
    padding: 5px 10px;
    font-size: 11px;
    background: transparent;
    border: none;
    color: var(--text-color, #e2e8f0);
    cursor: pointer;
    text-align: left;
    border-radius: 3px;
    transition: background 0.1s;
  }

  .ctx-item:hover {
    background: rgba(59, 130, 246, 0.12);
  }

  .ctx-divider {
    height: 1px;
    margin: 3px 6px;
    background: var(--border-color, rgba(128, 128, 128, 0.15));
  }

  .ctx-danger:hover {
    background: rgba(248, 113, 113, 0.12);
    color: #f87171;
  }

  .ctx-sub {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-left: 20px;
    font-size: 10px;
    color: var(--text-color-muted, #94a3b8);
  }

  .ctx-sub:hover {
    color: var(--text-color, #e2e8f0);
  }

  .ctx-folder-icon {
    flex-shrink: 0;
    opacity: 0.5;
  }


  /* [2026-03] fs-browser new folder, clipboard, context menu, dialogs */
  .fs-new-folder-row { padding: 3px 6px; }
  .fs-new-folder-input {
    width: 100%;
    padding: 3px 6px;
    font-size: 11px;
    background: var(--input-bg, rgba(0, 0, 0, 0.2));
    border: 1px solid var(--accent, #6366f1);
    border-radius: 4px;
    color: var(--text-color, #e5e7eb);
    outline: none;
  }

  .fs-clipboard-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    font-size: 10px;
    background: rgba(99, 102, 241, 0.12);
    border-bottom: 1px solid rgba(99, 102, 241, 0.2);
  }
  .fs-clip-op { font-weight: 600; color: #818cf8; }
  .fs-clip-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-color-muted); }
  .fs-clip-paste {
    padding: 1px 6px;
    font-size: 10px;
    background: rgba(99, 102, 241, 0.2);
    border: 1px solid rgba(99, 102, 241, 0.3);
    border-radius: 3px;
    color: #818cf8;
    cursor: pointer;
  }
  .fs-clip-paste:hover { background: rgba(99, 102, 241, 0.35); }
  .fs-clip-paste:disabled { opacity: 0.4; cursor: not-allowed; }
  .fs-clip-clear { background: none; border: none; color: var(--text-color-muted); cursor: pointer; font-size: 9px; padding: 0 2px; }

  .fs-ctx-overlay { position: fixed; inset: 0; z-index: 100000060; }
  .fs-ctx-menu {
    position: fixed;
    background: var(--dialog-bg, #1c1c2e);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 8px;
    padding: 4px 0;
    min-width: 120px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 100000061;
  }
  .fs-ctx-item {
    display: block;
    width: 100%;
    padding: 4px 12px;
    font-size: 12px;
    color: var(--text-color, #e5e7eb);
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
  }
  .fs-ctx-item:hover { background: rgba(99, 102, 241, 0.15); }
  .fs-ctx-item.danger { color: #ef4444; }
  .fs-ctx-item.danger:hover { background: rgba(239, 68, 68, 0.15); }
  .fs-ctx-divider { margin: 3px 0; border: none; border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.15)); }

  .fs-confirm-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: var(--dialog-bg, #1c1c2e);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 10px;
    padding: 16px 20px;
    min-width: 260px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    z-index: 100000062;
  }
  .fs-confirm-dialog p { margin: 0 0 8px; font-size: 13px; color: var(--text-color, #e5e7eb); }
  .fs-confirm-path { font-size: 11px; color: var(--text-color-muted); word-break: break-all; font-family: monospace; }
  .fs-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .fs-confirm-btn {
    padding: 4px 14px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  }
  .fs-confirm-btn.cancel { background: rgba(128, 128, 128, 0.1); color: var(--text-color); }
  .fs-confirm-btn.danger { background: rgba(239, 68, 68, 0.8); border-color: rgba(239, 68, 68, 0.6); color: white; }
  .fs-confirm-btn.danger:hover { background: rgba(239, 68, 68, 0.9); }
  .fs-confirm-btn.confirm { background: rgba(59, 130, 246, 0.2); border-color: rgba(59, 130, 246, 0.3); color: #60a5fa; }
  .fs-confirm-btn.confirm:hover { background: rgba(59, 130, 246, 0.35); }
  .fs-confirm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .fs-rename-input {
    width: 100%;
    padding: 5px 8px;
    font-size: 13px;
    background: var(--input-bg, rgba(0, 0, 0, 0.2));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
    border-radius: 6px;
    color: var(--text-color, #e5e7eb);
    outline: none;
    margin-bottom: 4px;
  }
  .fs-rename-input:focus { border-color: var(--accent, #6366f1); }

  /* ========== Sidebar footer / diagnostics ========== */
  .sidebar-footer {
    padding: 4px 8px;
    border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
    flex-shrink: 0;
  }
  .sidebar-status-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--text-secondary, #9ca3af);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
  }
  .sidebar-status-btn:hover {
    background: rgba(128, 128, 128, 0.1);
    color: var(--text-color, #e5e7eb);
  }
  .diagnostics-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .diagnostics-overlay-content {
    background: var(--bg-secondary, #1e1e2e);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 10px;
    width: min(600px, 90vw);
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  }
  .diagnostics-overlay-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color, #e5e7eb);
  }
  .diagnostics-close-btn {
    background: transparent;
    border: none;
    color: var(--text-secondary, #9ca3af);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .diagnostics-close-btn:hover {
    color: var(--text-color, #e5e7eb);
  }
</style>

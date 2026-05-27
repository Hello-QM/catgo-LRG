<script lang="ts">
  import { untrack, tick } from 'svelte'
  import { init_i18n, t, load_i18n_module } from '$lib/i18n/index.svelte'
  import LocaleSwitch from '$lib/i18n/LocaleSwitch.svelte'
  import { Structure, Trajectory } from '$lib'
  import { PathwayControls } from '$lib/trajectory'
  import type { AnyStructure } from '$lib'
  import { parse_cube_header, cube_atoms_to_molecule } from '$lib/cube'
  import { API_BASE, STATIC_ONLY } from '$lib/api/config'
  import { check_tauri, init_tauri, open_files as tauri_open_files, open_folder as tauri_open_folder, read_dropped_paths as tauri_read_dropped_paths } from '$lib/io/tauri'
  import { decompress_file } from '$lib/io/decompress'
  import { is_trajectory_file, parse_trajectory_data } from '$lib/trajectory/parse'
  import type { TrajectoryType } from '$lib/trajectory'
  import { parse_structure_file, is_structure_file } from '$lib/structure/parse'
  import '$lib/theme/themes.js'
  import StatusPopout from '$lib/workflow/StatusPopout.svelte'
  import { apply_theme_to_dom, get_theme_preference } from '$lib/theme'
  import ThemeControl from '$lib/theme/ThemeControl.svelte'
  import { readFile } from '@tauri-apps/plugin-fs'
  import WorkflowView from './WorkflowView.svelte'
  import { get_workflow_slice, iter_workflow_slices, pending_open_structure } from '$lib/workflow/workflow-state.svelte'
  import { TerminalWindow, DopingPTWindow } from '$lib/structure'
  import { ChatPane } from '$lib/chat'
  import { import_paper, get_chat_slice } from '$lib/chat/chat-state.svelte'
  import Toast from '$lib/Toast.svelte'
  import { show_toast } from '$lib/toast-state.svelte'
  import TabBar from './TabBar.svelte'
  import Sidebar from './Sidebar.svelte'
  import StructureLibrary from './StructureLibrary.svelte'
  import type { AppTab } from './TabBar.svelte'
  import OptimadeSearchModal from '$lib/structure/OptimadeSearchModal.svelte'
  import OptimadePreviewModal from '$lib/structure/OptimadePreviewModal.svelte'
  import PasteContentModal from '$lib/structure/PasteContentModal.svelte'
  import MonacoEditorPanel from '$lib/structure/MonacoEditorPanel.svelte'
  import FilePreviewPanel from '$lib/structure/FilePreviewPanel.svelte'
  import type { PymatgenStructure } from '$lib/structure'
  import { serialize_structure } from '$lib/api/project'
  import type { ProjectSummary } from '$lib/api/project'
  // @ts-ignore
  import water from '$site/molecules/water.json'
  // Extracted state modules
  import { sidebar } from './state/sidebar-state.svelte'
  import { exp } from './state/export-state.svelte'
  import { modal, type CloseAllEntry } from './state/modal-state.svelte'
  import { terminal } from './state/terminal-state.svelte'
  // Extracted pure utilities
  import {
    type PaneState, type LayoutType, type StructureTabState, type SampleStructure, type LibraryEntry,
    layout_panel_count, get_pane_label, create_empty_pane, pane_has_content,
    content_to_base64, create_tab_state, auto_name as _auto_name,
    find_import_target_pane, get_visible_panes, get_grid_style, get_pane_position,
    is_chgcar_file, NON_STRUCTURE_EXTS, update_export_format, format_from_ext,
    serialize_structure_content,
  } from './pane-utils'
  // Extracted tab manager (factory — must be called in component context)
  import { create_tab_manager } from './lib/tab-manager.svelte'
  // Extracted close-all helpers (pure functions)
  import { build_close_all_entries, execute_close_all_saves, close_all_structure_tabs } from './lib/close-all-helper'
  // Extracted keyboard shortcuts (pure function factory)
  import { create_handle_keydown } from './lib/keyboard-shortcuts'
  // Extracted popout manager
  import {
    load_popout_structure, popout_pane as _popout_pane,
    popout_workflow as _popout_workflow, popout_terminal as _popout_terminal,
    open_structure_in_new_window, parse_and_open_structure_window,
  } from './lib/popout-manager'
  // Extracted sidebar handlers
  import {
    handle_sidebar_load as _handle_sidebar_load,
    handle_sidebar_preview as _handle_sidebar_preview,
    handle_sidebar_open_editor as _handle_sidebar_open_editor,
    handle_sidebar_load_trajectory as _handle_sidebar_load_trajectory,
    handle_terminal_open_file as _handle_terminal_open_file,
    type SidebarHandlerDeps,
  } from './lib/sidebar-handlers'
  // Extracted pane manager
  import {
    handle_unload as _handle_unload,
    close_panel as _close_panel,
    load_close_save_projects,
    init_close_save_target,
    save_and_close_panel as _save_and_close_panel,
    type PaneManagerDeps,
  } from './lib/pane-manager'
  // Extracted layout manager
  import {
    handle_layout_change as _handle_layout_change,
    confirm_layout_change as _confirm_layout_change,
    type LayoutManagerDeps,
  } from './lib/layout-manager'
  // Extracted export handlers
  import {
    export_fs_browse, open_save_dialog as _open_save_dialog,
    open_export_to_hpc as _open_export_to_hpc,
    open_export_to_file as _open_export_to_file,
    do_export as _do_export,
    type ExportHandlerDeps,
  } from './lib/export-handlers'
  // Extracted drag-drop handlers
  import {
    handle_dragover as _handle_dragover,
    handle_dragleave as _handle_dragleave,
    handle_drop as _handle_drop,
    type DragDropDeps,
  } from './lib/drag-drop-handlers'
  // Extracted resize handlers
  import {
    on_divider_mousedown as _on_divider_mousedown,
    on_center_mousedown as _on_center_mousedown,
    type ResizeDeps,
  } from './lib/resize-handlers'
  // Extracted dialog sub-components
  import ExportSaveDialog from './components/ExportSaveDialog.svelte'
  import CloseAllModal from './components/CloseAllModal.svelte'

  init_i18n().then(() => load_i18n_module('app'))

  // ========== Tab Management (extracted to ./lib/tab-manager.svelte.ts) ==========
  const tm = create_tab_manager()
  // Destructure stable function references from the tab manager
  const { tab_states, get_active_ts, create_tab: open_tab, close_tab, request_close_tab, activate_tab, update_tab_label, switch_to_structure } = tm

  // ========== Popout / Sidebar / Pane / Layout / Export / DragDrop / Resize deps ==========
  let is_tauri = $state(false)
  let popout_chat_mode = $state(false)
  // Tab id the popout is mirroring. Parsed from the URL hash
  // (#chat?tab_id=structure-1). Used by ChatPane to filter BroadcastChannel
  // messages and to write incoming contexts into the correct slice.
  let popout_chat_tab_id = $state(`default`)
  let popout_status_mode = $state(false)
  let popout_doping_pt_mode = $state(false)
  let is_loading = $state(false)
  let loading_text = $state(``)
  let drag_target_pane = $state<number | null>(null)
  let is_panel_resizing = $state(false)
  let resize_axis = $state<'col' | 'row'>('col')

  // Dep objects wired to local $state
  const sidebar_deps: SidebarHandlerDeps = {
    get_active_ts,
    get_active_tab_id: () => tm.active_tab_id,
    get_active_tab_type: () => tm.active_tab_type,
    process_file_content,
    update_tab_label,
    get is_tauri() { return is_tauri },
    set_is_loading: (v) => { is_loading = v },
    set_loading_text: (v) => { loading_text = v },
    tab_states,
    get tabs() { return tm.tabs },
    set_active_tab_id: (id) => { tm.active_tab_id = id },
  }
  const pane_deps: PaneManagerDeps = {
    tab_states,
    update_tab_label,
    export_fs_browse: (dir) => export_fs_browse(dir),
  }
  const layout_deps: LayoutManagerDeps = {
    get_active_ts,
    get_active_tab_id: () => tm.active_tab_id,
    tab_states,
    update_tab_label,
    get_pending_layout_change: () => tm.pending_layout_change,
    set_pending_layout_change: (v) => { tm.pending_layout_change = v },
  }
  const export_deps: ExportHandlerDeps = {
    close_panel: (tab_id, pane_idx) => _close_panel(pane_deps, tab_id, pane_idx),
    load_close_save_projects,
  }
  const drag_deps: DragDropDeps = {
    get_active_ts,
    get_active_tab_type: () => tm.active_tab_type,
    get_active_tab_id: () => tm.active_tab_id,
    process_file_content,
    import_many,
    get_drag_target_pane: () => drag_target_pane,
    set_drag_target_pane: (v) => { drag_target_pane = v },
    set_is_loading: (v) => { is_loading = v },
  }
  const resize_deps: ResizeDeps = {
    tab_states,
    set_is_panel_resizing: (v) => { is_panel_resizing = v },
    set_resize_axis: (v) => { resize_axis = v },
  }

  // Thin wrappers that pass deps
  function popout_pane(tab_id: string, pane_idx: number) { return _popout_pane(tab_id, pane_idx, tab_states, is_tauri) }
  function popout_workflow() { return _popout_workflow(is_tauri, close_tab, switch_to_structure) }
  function popout_terminal() { return _popout_terminal(is_tauri, terminal, close_tab, switch_to_structure) }
  function handle_sidebar_load(content: string | ArrayBuffer, filename: string, file_path?: string, session_id?: string) { _handle_sidebar_load(sidebar_deps, content, filename, file_path, session_id) }
  function handle_sidebar_preview(mode: string, filename: string, file_path: string, session_id: string, content?: string, binary_data?: string, mime_type?: string) { _handle_sidebar_preview(sidebar_deps, mode, filename, file_path, session_id, content, binary_data, mime_type) }
  function handle_sidebar_open_editor(content: string, filename: string, file_path: string, session_id: string) { _handle_sidebar_open_editor(sidebar_deps, content, filename, file_path, session_id) }
  function handle_sidebar_load_trajectory(content: string, filename: string, _meta?: { session_id: string; dir_path: string }) { _handle_sidebar_load_trajectory(sidebar_deps, content, filename, _meta) }
  function handle_terminal_open_file(file_path: string, filename: string, session_id: string) { return _handle_terminal_open_file(sidebar_deps, file_path, filename, session_id) }
  function handle_unload(tab_id: string, pane_idx: number) { _handle_unload(pane_deps, tab_id, pane_idx) }
  function close_panel(tab_id: string, pane_idx: number) { _close_panel(pane_deps, tab_id, pane_idx) }
  function save_and_close_panel(tab_id: string, pane_idx: number) { return _save_and_close_panel(pane_deps, tab_id, pane_idx) }
  function handle_layout_change(new_layout: LayoutType) { _handle_layout_change(layout_deps, new_layout) }
  function confirm_layout_change() { _confirm_layout_change(layout_deps) }
  function open_save_dialog(structure: Record<string, unknown>) { _open_save_dialog(export_deps, structure) }
  function open_export_to_hpc(structure: Record<string, unknown>) { _open_export_to_hpc(structure) }
  function open_export_to_file(structure: Record<string, unknown>) { _open_export_to_file(structure) }
  function do_export() { return _do_export(export_deps) }
  function handle_dragover(event: DragEvent) { _handle_dragover(drag_deps, event) }
  function handle_dragleave(event: DragEvent) { _handle_dragleave(drag_deps, event) }
  function handle_drop(event: DragEvent) { return _handle_drop(drag_deps, event) }
  function on_divider_mousedown(e: MouseEvent, axis: 'col' | 'row', tab_id: string) { _on_divider_mousedown(resize_deps, e, axis, tab_id) }
  function on_center_mousedown(e: MouseEvent, tab_id: string) { _on_center_mousedown(resize_deps, e, tab_id) }

  // ========== Plugin Hub (via Structure.svelte counter prop) ==========

  function open_plugin_hub_on_active_pane() {
    const ts = get_active_ts()
    if (!ts) return
    const idx = ts.active_pane
    const pane = ts.panes[idx]
    if (!pane) return
    // If pane has no structure, load water so Structure mounts
    if (!pane.structure && !pane.trajectory && !pane.cube_file) {
      ts.panes[idx].structure = water as unknown as AnyStructure
      ts.panes[idx].initial_site_count = (water as any).sites?.length ?? 0
      ts.panes[idx].initial_structure_ref = water as unknown as AnyStructure
    }
    ts.panes[idx].open_plugin_hub = (ts.panes[idx].open_plugin_hub ?? 0) + 1
  }

  // ========== Close All Tabs (extracted to ./lib/close-all-helper.ts) ==========

  function open_close_all_dialog() {
    modal.close_all_entries = build_close_all_entries(tm.tabs, tab_states)
    modal.close_all_error = ``
    modal.close_all_visible = true
  }

  async function execute_close_all() {
    modal.close_all_saving = true
    modal.close_all_error = ``
    try {
      await execute_close_all_saves(modal.close_all_entries, tab_states)
      sidebar.refresh_counter++
      close_all_structure_tabs(tm.tabs, tab_states, close_tab)
      modal.close_all_visible = false
    } catch (e) {
      modal.close_all_error = e instanceof Error ? e.message : t('app.save_failed')
    } finally {
      modal.close_all_saving = false
    }
  }

  function close_all_without_saving() {
    close_all_structure_tabs(tm.tabs, tab_states, close_tab)
    modal.close_all_visible = false
  }

  // Build project tree for save dialogs
  let save_project_children = $derived.by(() => {
    const map: Record<string, ProjectSummary[]> = { __root__: [] }
    for (const p of exp.close_save_projects) {
      const key = p.parent_id || `__root__`
      ;(map[key] ??= []).push(p)
    }
    return map
  })
  let save_project_roots = $derived(save_project_children[`__root__`] || [])

  // ========== Hash Routing ==========
  $effect(() => {
    if (typeof window !== `undefined`) {
      const hash = window.location.hash
      untrack(() => {
        if (!STATIC_ONLY && hash.startsWith(`#chat`)) {
          popout_chat_mode = true
          // Parse tab_id from #chat?tab_id=structure-N so the popout can
          // filter broadcasts to only the tab it's mirroring.
          const q_idx = hash.indexOf(`?`)
          if (q_idx !== -1) {
            const params = new URLSearchParams(hash.slice(q_idx + 1))
            popout_chat_tab_id = params.get(`tab_id`) || `default`
          }
          return
        } else if (hash.startsWith(`#status`)) {
          popout_status_mode = true
          return
        } else if (hash.startsWith(`#doping-pt`)) {
          popout_doping_pt_mode = true
          return
        } else if (hash.startsWith(`#workflow`)) {
          open_tab(`workflow`)
        } else if (!STATIC_ONLY && hash.startsWith(`#terminal`)) {
          terminal.parse_hash(hash)
          if (!tm.tabs.find(t => t.type === `terminal`)) {
            tm.tabs = [...tm.tabs, { id: `terminal`, type: `terminal`, label: `Terminal`, closable: true }]
          }
          tm.active_tab_id = `terminal`
        } else if (hash.startsWith(`#structure`)) {
          load_popout_structure(hash, get_active_ts, tm.active_tab_id, update_tab_label)
        }
      })
      if (popout_chat_mode || popout_status_mode || popout_doping_pt_mode) return
      const on_hash = () => {
        if (window.location.hash.startsWith(`#workflow`)) {
          open_tab(`workflow`)
        } else if (!STATIC_ONLY && window.location.hash.startsWith(`#terminal`)) {
          terminal.parse_hash(window.location.hash)
          if (!tm.tabs.find(t => t.type === `terminal`)) {
            tm.tabs = [...tm.tabs, { id: `terminal`, type: `terminal`, label: `Terminal`, closable: true }]
          }
          tm.active_tab_id = `terminal`
        }
      }
      window.addEventListener(`hashchange`, on_hash)
      return () => window.removeEventListener(`hashchange`, on_hash)
    }
  })

  // ========== Sample Structures ==========
  const sample_structures: SampleStructure[] = [
    { name: `Water`, description: `H₂O molecule`, formula: `H₂O`, data: water as unknown as AnyStructure },
  ]

  $effect(() => {
    sidebar.persist()
  })

  /** Open the current structure in the text editor for direct editing. */
  async function open_edit_as_text(structure: Record<string, unknown>) {
    const ts = get_active_ts()
    if (!ts) return
    const pane = ts.panes[ts.active_pane]
    const filename = pane.source_filename || `structure.cif`

    // Determine format from filename
    const ext = filename.split(`.`).pop()?.toLowerCase() || ``
    let format = `cif`
    if ([`poscar`, `vasp`, `contcar`].includes(ext) || /^(POSCAR|CONTCAR)$/i.test(filename)) format = `poscar`
    else if (ext === `xyz`) format = `xyz`
    else if (ext === `extxyz`) format = `extxyz`
    else if (ext === `json`) format = `json`

    // Serialize: try Python backend first, fallback to frontend serializers
    let content = ``
    try {
      const result = await serialize_structure(structure, format)
      content = result.content
    } catch {
      // Frontend fallback
      const { structure_to_cif_str, structure_to_poscar_str, structure_to_xyz_str, structure_to_extxyz_str, structure_to_json_str } = await import(`$lib/structure/export`)
      const s = structure as AnyStructure
      if (format === `poscar`) content = structure_to_poscar_str(s)
      else if (format === `xyz`) content = structure_to_xyz_str(s)
      else if (format === `extxyz`) content = structure_to_extxyz_str(s)
      else if (format === `json`) content = structure_to_json_str(s)
      else content = structure_to_cif_str(s)
    }

    // Track which tab/pane this editor is tied to for applying changes back
    const target_tab_id = tm.active_tab_id
    const target_pane_idx = ts.active_pane

    sidebar.editor_content = content
    sidebar.editor_filename = filename
    sidebar.editor_file_path = ``
    sidebar.editor_session_id = ``
    sidebar.editor_local_path = pane.local_file_path || ``
    sidebar.editor_on_save = (new_content: string) => {
      // Parse text back into structure and update the pane
      try {
        const parsed = parse_structure_file(new_content, filename)
        if (parsed?.sites?.length) {
          const target_ts = tab_states[target_tab_id]
          if (target_ts) {
            target_ts.panes[target_pane_idx].structure = parsed
            target_ts.panes[target_pane_idx].initial_structure_ref = parsed
            target_ts.panes[target_pane_idx].initial_site_count = parsed.sites.length
            target_ts.panes[target_pane_idx].modified = false
            update_tab_label(target_tab_id)
          }
        }
      } catch (err) {
        console.error(`Failed to parse edited structure:`, err)
      }
    }
    sidebar.editor_open = true
  }

  // [2025-02] Open workflow editor from sidebar file tree
  function handle_sidebar_open_workflow(workflow_id: string, compact = false, target_tab_id?: string) {
    // Prefer opening into the tab that originated the MCP navigation, not
    // whichever tab happens to be active when the signal arrives. Falls back
    // to the active tab for sidebar clicks and other UI-initiated opens.
    const ts_tab_id = target_tab_id ?? tm.active_tab_id
    const ts = tm.tab_states[ts_tab_id]
    if (!ts) return
    // If this workflow is already open in a pane, switch to it and signal reload
    const existing = ts.panes.findIndex(p => p.mode === `workflow` && p.workflow_id === workflow_id)
    if (existing >= 0) {
      tm.active_tab_id = ts_tab_id
      ts.active_pane = existing
      // Signal WorkflowEditor to reload from DB (MCP may have added nodes)
      get_workflow_slice(ts_tab_id).workflow_reload_seq.seq++
      return
    }
    const pane_idx = ts.panes.findIndex(p => !pane_has_content(p))
    const target = pane_idx >= 0 ? pane_idx : ts.active_pane
    ts.panes[target] = { ...create_empty_pane(), mode: 'workflow', workflow_id, workflow_compact: compact }
    ts.panes = [...ts.panes]
    ts.active_pane = target
    tm.active_tab_id = ts_tab_id
    update_tab_label(ts_tab_id)
  }

  // Auto-navigate to workflow when AI creates one (compact mode — no sidebars).
  //
  // Phase 2: Each tab has its own `pending_navigate_workflow` signal (in its
  // WorkflowSlice). We fan in here by iterating every slice and handling
  // whichever one has a non-empty id. SvelteMap makes the iteration reactive,
  // and clearing the id after dispatch prevents re-firing.
  $effect(() => {
    for (const [slice_tab_id, slice] of iter_workflow_slices()) {
      const wf_id = slice.pending_navigate_workflow.id
      if (wf_id) {
        // untrack the clear so writing "" doesn't re-invalidate this same
        // effect (the read on `.id` is tracked above; the write would
        // otherwise schedule a second run that sees "" and does nothing
        // — harmless, but avoidable).
        untrack(() => { slice.pending_navigate_workflow.id = `` })
        handle_sidebar_open_workflow(wf_id, true, slice_tab_id)
        // The MCP / CatBot path that triggers this navigate signal is also
        // the one that just wrote a new workflow row (or extra nodes) to
        // the DB. The sidebar otherwise only refreshes on db-change /
        // close-all-save / pane operations, so a CatBot-built workflow
        // wouldn't appear in the list until the user reloaded the page.
        // Bumping the refresh counter here closes that gap.
        untrack(() => { sidebar.refresh_counter++ })
      }
    }
  })

  // Open workflow output structure in a new tab
  $effect(() => {
    if (pending_open_structure.seq < 1 || !pending_open_structure.structure) return
    const struct = pending_open_structure.structure
    const label = pending_open_structure.label
    pending_open_structure.structure = null
    pending_open_structure.seq = 0

    const prev_tab_id = tm.active_tab_id
    tm.create_tab(`structure`)
    const tab_id = tm.active_tab_id
    const ts = tm.tab_states[tab_id]
    if (!ts) return
    // Guard: if create_tab hit the 12-tab limit, active_tab didn't change —
    // don't silently overwrite the existing tab's structure
    if (tab_id === prev_tab_id && ts.panes[0].structure) {
      console.warn(`[App] Tab limit reached, cannot open structure in new tab`)
      return
    }
    ts.panes[0].structure = struct
    ts.panes[0].initial_structure_ref = struct
    ts.panes[0].initial_site_count = struct.sites?.length ?? 0
    ts.panes[0].modified = false
    // Set tab label — use tm.tabs (raw $state), not tabs_with_badges ($derived copy)
    const tab = tm.tabs.find(t => t.id === tab_id)
    if (tab && label) tab.label = label
    tm.update_tab_label(tab_id)
  })

  function get_current_structure(): Record<string, unknown> | null {
    const ts = get_active_ts()
    if (!ts) return null
    const pane = ts.panes[ts.active_pane]
    if (!pane?.structure) return null
    return pane.structure as unknown as Record<string, unknown>
  }

  /* [2025-02] Drag-to-collapse: drag divider below 80px threshold to auto-collapse */
  function on_sidebar_divider_mousedown(e: MouseEvent) {
    e.preventDefault()
    sidebar.is_resizing = true
    const start_x = e.clientX
    const start_w = sidebar.width

    function on_move(ev: MouseEvent) {
      const raw_w = start_w + (ev.clientX - start_x)
      if (raw_w < 80) {
        // Show visual hint that it will collapse
        sidebar.width = 160
      } else {
        sidebar.width = Math.max(160, Math.min(400, raw_w))
      }
    }
    function on_up(ev: MouseEvent) {
      sidebar.is_resizing = false
      const raw_w = start_w + (ev.clientX - start_x)
      if (raw_w < 80) {
        sidebar.collapsed = true
      }
      window.removeEventListener(`mousemove`, on_move)
      window.removeEventListener(`mouseup`, on_up)
    }
    window.addEventListener(`mousemove`, on_move)
    window.addEventListener(`mouseup`, on_up)
  }

  // Settings persistence is now handled by the settings controller
  // (src/lib/structure/controllers/settings.svelte.ts) using localStorage key 'catgo-viewer-settings'.
  // Each Structure component auto-loads/saves its own settings.

  // ========== Global Effects ==========
  $effect(() => {
    for (const ts of Object.values(tab_states)) {
      const cc = ts.panes.filter(p => pane_has_content(p)).length
      const current_count = layout_panel_count(ts.layout)
      if (cc > current_count) {
        ts.layout = cc <= 2 ? 'splitH' : 'quad'
      }
    }
  })

  $effect(() => {
    for (const ts of Object.values(tab_states)) {
      for (let i = 0; i < ts.panes.length; i++) {
        const pane = ts.panes[i]
        if (pane.structure && !pane.modified) {
          if (pane.initial_site_count > 0 && pane.structure.sites.length !== pane.initial_site_count) {
            ts.panes[i].modified = true
          }
        }
      }
    }
  })

  // ========== Initialization ==========

  async function load_file_from_path(file_path: string) {
    const filename = file_path.split(/[/\\]/).pop() || `unknown`
    const ts = get_active_ts()
    if (!ts) return
    is_loading = true
    try {
      const content = await readFile(file_path)
      const text = new TextDecoder().decode(content)
      const target_pane = ts.panes.findIndex(p => !pane_has_content(p))
      const pane_idx = target_pane >= 0 ? target_pane : ts.active_pane
      await process_file_content(tm.active_tab_id, text, filename, pane_idx, null, file_path)
    } catch (err) {
      console.error(`[Tauri] Error reading file:`, err)
    } finally {
      is_loading = false
    }
  }

  async function drain_opened_files() {
    try {
      const { invoke } = await import(`@tauri-apps/api/core`)
      const paths = await invoke<string[]>(`get_opened_files`)
      if (paths && paths.length > 0) {
        for (const file_path of paths) {
          await load_file_from_path(file_path)
        }
      }
    } catch (err) {
      console.error(`[Tauri] Failed to get opened files:`, err)
    }
  }

  async function setup_file_open_listener() {
    try {
      const { listen } = await import(`@tauri-apps/api/event`)
      await listen(`file-opened`, () => {
        drain_opened_files()
      })
    } catch (err) {
      console.error(`[Tauri] Failed to setup file open listener:`, err)
    }
  }

  $effect(() => {
    if (typeof window !== `undefined`) {
      apply_theme_to_dom(get_theme_preference())
      is_tauri = check_tauri()
      if (is_tauri) {
        init_tauri()
        setup_file_open_listener()
        drain_opened_files()
        setup_tauri_file_drop()
      }
    }
  })

  // ========== File Handling ==========
  let file_input_ref = $state<HTMLInputElement | undefined>()
  let folder_input_ref = $state<HTMLInputElement | undefined>()
  let file_input_target_tab = ``
  let file_input_target_pane = 0

  async function handle_open_file(tab_id: string, pane_idx: number) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.active_pane = pane_idx
    if (is_tauri) {
      try {
        const results = await tauri_open_files()
        if (results && results.length > 0) {
          await import_many(tab_id, results.map(r => ({ content: r.content, filename: r.filename, path: r.path })), pane_idx)
        }
      } catch (err) {
        console.error(err)
      }
    } else {
      file_input_target_tab = tab_id
      file_input_target_pane = pane_idx
      file_input_ref?.click()
    }
  }

  /** Open a folder and import every recognizable structure file inside it. */
  async function handle_open_folder(tab_id: string, pane_idx: number) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.active_pane = pane_idx
    const accept = (name: string) => is_structure_file(name) || is_trajectory_file(name) || is_chgcar_file(name)
    if (is_tauri) {
      try {
        const results = await tauri_open_folder(accept)
        if (results && results.length > 0) {
          await import_many(tab_id, results.map(r => ({ content: r.content, filename: r.filename, path: r.path })), pane_idx)
        }
      } catch (err) {
        console.error(err)
      }
    } else {
      file_input_target_tab = tab_id
      file_input_target_pane = pane_idx
      folder_input_ref?.click()
    }
  }

  async function handle_file_input(event: Event) {
    const input = event.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    if (files.length === 0) return
    try {
      await import_many(
        file_input_target_tab,
        files.map(f => ({ file: f, filename: f.name, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || null })),
        file_input_target_pane,
      )
    } catch (err) {
      console.error(err)
    } finally {
      input.value = ``
    }
  }

  /** Browser folder picker (webkitdirectory) — filters to structure files. */
  async function handle_folder_input(event: Event) {
    const input = event.target as HTMLInputElement
    const all = Array.from(input.files ?? [])
    const files = all.filter(f => is_structure_file(f.name) || is_trajectory_file(f.name) || is_chgcar_file(f.name))
    if (files.length === 0) { input.value = ``; return }
    try {
      await import_many(
        file_input_target_tab,
        files.map(f => ({ file: f, filename: f.name, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || null })),
        file_input_target_pane,
      )
    } catch (err) {
      console.error(err)
    } finally {
      input.value = ``
    }
  }

  function handle_database_import(imported: PymatgenStructure) {
    const ts = tab_states[modal.import_target_tab]
    if (!ts) return
    if (!imported?.sites?.length) return

    const target = modal.import_target_pane
    // Mutate the pane in-place so Svelte 5's deep $state proxy tracks the change
    const pane = ts.panes[target]
    pane.structure = imported as AnyStructure
    pane.initial_site_count = imported.sites.length
    pane.initial_structure_ref = imported as AnyStructure
    pane.modified = false
    pane.is_trajectory_mode = false
    pane.trajectory = null

    update_tab_label(modal.import_target_tab)
    modal.search_visible = false
    modal.paste_content_visible = false
    // Force canvas resize after DOM update
    tick().then(() => {
      window.dispatchEvent(new Event('resize'))
    })
  }

  function compute_lattice_params(lattice_vectors: number[][] | null | undefined) {
    if (!lattice_vectors || lattice_vectors.length !== 3) return null
    try {
      const [v1, v2, v3] = lattice_vectors
      const len = (v: number[]) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
      const a = len(v1)
      const b = len(v2)
      const c = len(v3)
      const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
      const alpha = (Math.acos(dot(v2, v3) / (b * c)) * 180) / Math.PI
      const beta = (Math.acos(dot(v1, v3) / (a * c)) * 180) / Math.PI
      const gamma = (Math.acos(dot(v1, v2) / (a * b)) * 180) / Math.PI
      return { a, b, c, alpha, beta, gamma }
    } catch {
      return null
    }
  }

  function handle_optimade_preview(optimade_struct: any, structure: PymatgenStructure) {
    modal.db_preview_pymatgen = structure
    const attrs = optimade_struct?.attributes ?? {}
    const provider = attrs.database_provider ?? `OPTIMADE`
    const formula =
      attrs.chemical_formula_descriptive ?? attrs.chemical_formula_reduced ?? `Unknown formula`
    const sites =
      attrs.n_sites ??
      (Array.isArray(attrs.cartesian_site_positions) ? attrs.cartesian_site_positions.length : 0)

    modal.db_preview_title = t('app.preview_structure_import')
    modal.db_preview_formula = formula
    modal.db_preview_lattice = compute_lattice_params(attrs.lattice_vectors)
    modal.db_preview_details = [
      { label: t('app.field_id'), value: String(optimade_struct?.id ?? ``), mono: true },
      { label: t('app.field_formula'), value: formula },
      { label: t('app.field_sites'), value: String(sites) },
      { label: t('app.field_database'), value: provider },
    ]
    modal.db_preview_visible = true
  }

  function handle_pubchem_preview(
    compound: any,
    search_result: any | null,
    structure: PymatgenStructure,
  ) {
    modal.db_preview_pymatgen = structure

    const cid = compound?.id?.id?.cid ?? search_result?.cid ?? ``
    const formula = search_result?.formula ?? ``
    const name = search_result?.name ?? ``
    const weight = search_result?.weight
    const heavy = search_result?.HeavyAtomCount
    const n_atoms = Array.isArray(compound?.atoms?.element)
      ? compound.atoms.element.length
      : (heavy ?? 0)

    const rows: Array<{ label: string; value: string; mono?: boolean }> = []
    if (cid) rows.push({ label: t('app.field_cid'), value: String(cid), mono: true })
    if (name) rows.push({ label: t('app.field_name'), value: name })
    if (formula) rows.push({ label: t('app.field_formula'), value: formula })
    if (n_atoms) rows.push({ label: t('app.field_atoms'), value: String(n_atoms) })
    if (typeof weight === `number`)
      rows.push({ label: t('app.field_weight'), value: `${weight.toFixed(2)} g/mol` })
    rows.push({ label: t('app.field_database'), value: `PubChem` })

    modal.db_preview_title = t('app.preview_compound_import')
    modal.db_preview_formula = formula
    modal.db_preview_lattice = null
    modal.db_preview_details = rows
    modal.db_preview_visible = true
  }

  function confirm_db_preview() {
    if (modal.db_preview_pymatgen) {
      handle_database_import(modal.db_preview_pymatgen as PymatgenStructure)
    }
    cancel_db_preview()
    modal.search_visible = false
  }

  function cancel_db_preview() {
    modal.db_preview_visible = false
    modal.db_preview_pymatgen = null
    modal.db_preview_details = []
    modal.db_preview_formula = ``
    modal.db_preview_lattice = null
  }

  // Result of parsing one file. 'skip' = ignore silently; 'editor' = not a
  // structure, open raw text in the editor; 'entry' = a library entry payload.
  type IngestOutcome =
    | { kind: 'entry'; entry: Omit<LibraryEntry, 'id'> }
    | { kind: 'skip' }
    | { kind: 'editor'; text: string }

  /**
   * Parse a single file into a LibraryEntry payload WITHOUT touching any pane.
   * Shared by the single-file path (process_file_content) and the batch path
   * (import_many) so the CIF / cube / CHGCAR / trajectory branching lives once.
   */
  async function ingest_one(content: string | ArrayBuffer, filename: string): Promise<IngestOutcome> {
    const text = typeof content === `string` ? content : new TextDecoder().decode(content)
    const ext = filename.replace(/\.(gz|bz2|xz|zst)$/i, ``).split(`.`).pop()?.toLowerCase() || ``

    // CHGCAR / CHGDIFF / LOCPOT etc. → convert to Gaussian cube via wasm.
    // chgdiff-wasm exposes `chgcar_to_cube(text)` and the package is already
    // bundled with the desktop frontend, so we don't hit the backend's
    // `/api/chgcar/convert-to-cube` endpoint (which shells out to the
    // Rust cube-processor binary that may not be present in a fresh
    // PyInstaller bundle).  Backend HTTP path is kept as a fallback so
    // dev setups with the binary present keep working unchanged.
    if (is_chgcar_file(filename)) {
      try {
        let cube_text: string
        try {
          const { chgcar_to_cube } = await import('$lib/electronic/chgdiff-wasm')
          cube_text = await chgcar_to_cube(text)
        } catch (wasm_err) {
          console.warn(`[CHGCAR] wasm path failed, falling back to backend:`, wasm_err)
          const blob = new Blob([text], { type: `application/octet-stream` })
          const form_data = new FormData()
          form_data.append(`file`, new File([blob], filename))
          const resp = await fetch(`${API_BASE}/chgcar/convert-to-cube`, {
            method: `POST`,
            body: form_data,
          })
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }))
            throw new Error(err.detail || `CHGCAR conversion failed: ${resp.statusText}`)
          }
          cube_text = await resp.text()
        }
        const cube_filename = filename.replace(/\.(gz|bz2|xz|zst)$/i, ``) + `.cube`
        let structure: AnyStructure | undefined
        try {
          const molecule = cube_atoms_to_molecule(parse_cube_header(cube_text))
          if (molecule.sites.length > 0) structure = { ...molecule, _aligned: true } as AnyStructure
        } catch (err) {
          console.error(`Failed to parse converted cube atoms:`, err)
        }
        const cube_file = new File([new Blob([cube_text], { type: `chemical/x-cube` })], cube_filename)
        return { kind: 'entry', entry: { filename, source_path: null, format: `cube`, structure, trajectory: undefined, is_trajectory: false, cube_file } }
      } catch (err) {
        console.error(`Failed to convert CHGCAR to cube:`, err)
        return { kind: 'skip' }
      }
    }

    if (/\.(cube|cub)$/i.test(filename)) {
      let structure: AnyStructure | undefined
      try {
        const molecule = cube_atoms_to_molecule(parse_cube_header(text))
        if (molecule.sites.length > 0) structure = { ...molecule, _aligned: true } as AnyStructure
      } catch (err) {
        console.error(`Failed to parse cube file atoms:`, err)
      }
      const cube_file = new File([new Blob([text], { type: `chemical/x-cube` })], filename)
      return { kind: 'entry', entry: { filename, source_path: null, format: `cube`, structure, trajectory: undefined, is_trajectory: false, cube_file } }
    }

    // Skip non-structure files (images, PDFs, spreadsheets, media, archives, binaries)
    if (NON_STRUCTURE_EXTS.test(filename)) {
      console.warn(`[ingest_one] Skipping non-structure file: ${filename}`)
      return { kind: 'skip' }
    }

    if (is_trajectory_file(filename, text)) {
      const trajectory = await parse_trajectory_data(content, filename)
      return {
        kind: 'entry',
        entry: {
          filename, source_path: null, format: ext, structure: undefined, trajectory,
          is_trajectory: true, cube_file: null,
          raw_traj_b64: content_to_base64(content),
          raw_traj_format: filename.split('.').pop()?.toLowerCase() || '',
        },
      }
    }

    const parsed = parse_structure_file(text, filename)
    if (parsed?.sites?.length) {
      return { kind: 'entry', entry: { filename, source_path: null, format: ext, structure: parsed, trajectory: undefined, is_trajectory: false, cube_file: null } }
    }
    // Can't parse as structure — fall back to the text editor
    return { kind: 'editor', text }
  }

  /** Write a library entry's parsed content into a pane (in-place — Svelte 5 deep proxy). */
  function apply_entry_to_pane(
    tab_id: string,
    ts: StructureTabState,
    target: number,
    e: LibraryEntry,
    remote_origin: { session_id: string; file_path: string } | null = null,
    local_file_path: string | null = null,
  ) {
    const p = ts.panes[target]
    if (e.cube_file) {
      p.structure = e.structure
      p.initial_site_count = e.structure?.sites?.length ?? 0
      p.initial_structure_ref = e.structure ?? null
      p.cube_file = e.cube_file
      p.is_trajectory_mode = false
      p.trajectory = null
    } else if (e.is_trajectory) {
      p.is_trajectory_mode = true
      p.structure = undefined
      p.trajectory = e.trajectory
      p.initial_site_count = 0
      p.initial_structure_ref = null
      p.cube_file = null
      p.raw_traj_b64 = e.raw_traj_b64 ?? ''
      p.raw_traj_format = e.raw_traj_format ?? ''
    } else {
      p.is_trajectory_mode = false
      p.trajectory = null
      p.structure = e.structure
      p.initial_site_count = e.structure?.sites?.length ?? 0
      p.initial_structure_ref = e.structure ?? null
      p.cube_file = null
    }
    p.selected_sites = []
    p.current_step_idx = 0
    p.modified = false
    p.remote_origin = remote_origin
    p.local_file_path = local_file_path
    p.source_filename = e.filename
    ts.active_pane = target
    update_tab_label(tab_id)
  }

  async function process_file_content(tab_id: string, content: string | ArrayBuffer, filename: string, pane_idx: number, remote_origin?: { session_id: string; file_path: string } | null, local_file_path?: string | null) {
    const ts = tab_states[tab_id]
    if (!ts) return
    let target = find_import_target_pane(ts, pane_idx)
    if (target === -1) {
      // All panes full — open a new tab and load there
      open_tab(`structure`)
      const new_ts = tab_states[tm.active_tab_id]
      if (!new_ts) return
      return process_file_content(tm.active_tab_id, content, filename, 0, remote_origin, local_file_path)
    }
    const outcome = await ingest_one(content, filename)
    if (outcome.kind === 'skip') return
    if (outcome.kind === 'editor') {
      const session = remote_origin?.session_id || ``
      const fp = remote_origin?.file_path || local_file_path || ``
      handle_sidebar_open_editor(outcome.text, filename, fp, session)
      return
    }
    const entry: LibraryEntry = { id: crypto.randomUUID(), ...outcome.entry, source_path: local_file_path ?? outcome.entry.source_path ?? null }
    ts.library.push(entry)
    ts.active_library_id = entry.id
    apply_entry_to_pane(tab_id, ts, target, entry, remote_origin ?? null, local_file_path ?? null)
  }

  /**
   * Import many files into a tab's structure library. Each file is parsed in
   * isolation (one bad file never aborts the batch); entries are appended to
   * the library and the first newly-added one is shown in the active pane.
   * `items` carry either pre-read `content` (Tauri) or a `File` (browser).
   */
  async function import_many(
    tab_id: string,
    items: Array<{ content?: string | ArrayBuffer; filename: string; file?: File; path?: string | null }>,
    pane_idx: number,
  ) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.active_pane = pane_idx
    is_loading = true
    const start = ts.library.length
    let failures = 0
    try {
      for (const it of items) {
        try {
          let content = it.content
          let filename = it.filename
          if (it.file) {
            const d = await decompress_file(it.file)
            content = d.content
            filename = d.filename
          }
          if (content == null) { failures++; continue }
          const outcome = await ingest_one(content, filename)
          if (outcome.kind !== 'entry') { failures++; continue }
          ts.library.push({ id: crypto.randomUUID(), ...outcome.entry, source_path: it.path ?? outcome.entry.source_path ?? null })
        } catch (err) {
          failures++
          console.warn(`[import_many] failed to import ${it.filename}:`, err)
        }
      }
      if (ts.library.length > start) {
        select_library_entry(tab_id, ts.library[start].id)
      }
    } finally {
      is_loading = false
    }
    if (failures > 0) console.warn(`[import_many] ${failures} file(s) skipped or failed`)
  }

  /** Show a library entry in the tab's active pane. */
  function select_library_entry(tab_id: string, id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    const entry = ts.library.find(e => e.id === id)
    if (!entry) return
    apply_entry_to_pane(tab_id, ts, ts.active_pane, entry)
    ts.active_library_id = id
    tick().then(() => window.dispatchEvent(new Event('resize')))
  }

  /** Remove one entry; if it was active, fall back to the first remaining (or clear the pane). */
  function remove_library_entry(tab_id: string, id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    const was_active = ts.active_library_id === id
    ts.library = ts.library.filter(e => e.id !== id)
    if (!was_active) return
    if (ts.library.length > 0) {
      select_library_entry(tab_id, ts.library[0].id)
    } else {
      ts.active_library_id = null
      ts.panes[ts.active_pane] = create_empty_pane()
      update_tab_label(tab_id)
    }
  }

  /** Empty the library list (does not clear what's currently shown in the pane). */
  function clear_library(tab_id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.library = []
    ts.active_library_id = null
  }

  function create_on_file_drop(tab_id: string, pane_idx: number) {
    return async (content: string | ArrayBuffer, filename: string) => {
      is_loading = true
      try {
        await process_file_content(tab_id, content, filename, pane_idx)
      } catch (err) {
        console.error(err)
      } finally {
        is_loading = false
      }
    }
  }

  function create_on_file_load(tab_id: string, pane_idx: number) {
    return (data: { structure?: AnyStructure; filename?: string; trajectory?: unknown }) => {
      const ts = tab_states[tab_id]
      if (!ts) return
      let target = find_import_target_pane(ts, pane_idx)
      if (target === -1) {
        // All panes full — open a new tab
        open_tab(`structure`)
        const new_ts = tab_states[tm.active_tab_id]
        if (!new_ts) return
        target = 0
        // Re-bind to new tab
        const new_panes = new_ts.panes
        if (data.structure) {
          new_panes[0].structure = data.structure
          new_panes[0].is_trajectory_mode = false
          new_panes[0].trajectory = null
          new_panes[0].initial_site_count = data.structure.sites?.length ?? 0
          new_panes[0].initial_structure_ref = data.structure
          new_panes[0].modified = false
          new_ts.panes = [...new_panes]
          update_tab_label(tm.active_tab_id)
        }
        return
      }
      if (data.structure) {
        ts.panes[target].structure = data.structure
        ts.panes[target].is_trajectory_mode = false
        ts.panes[target].trajectory = null
        ts.panes[target].initial_site_count = data.structure.sites?.length ?? 0
        ts.panes[target].initial_structure_ref = data.structure
        ts.panes[target].modified = false
      }
      if (data.trajectory) {
        const traj = data.trajectory as { frames?: unknown[]; metadata?: { source_format?: string } }
        if (traj.metadata?.source_format === `single_structure` && traj.frames?.length === 1) {
          const frame = traj.frames[0] as { structure?: AnyStructure }
          if (frame?.structure) {
            ts.panes[target].structure = frame.structure
            ts.panes[target].is_trajectory_mode = false
            ts.panes[target].trajectory = null
            ts.panes[target].initial_site_count = frame.structure.sites?.length ?? 0
            ts.panes[target].initial_structure_ref = frame.structure
            ts.panes[target].modified = false
            ts.panes[target].selected_sites = []
            ts.panes[target].current_step_idx = 0
            ts.active_pane = target
            update_tab_label(tab_id)
            return
          }
        }
        ts.panes[target].trajectory = data.trajectory
        ts.panes[target].is_trajectory_mode = true
        ts.panes[target].structure = undefined
        ts.panes[target].initial_site_count = 0
        ts.panes[target].modified = false
      }
      ts.panes[target].selected_sites = []
      ts.panes[target].current_step_idx = 0
      ts.active_pane = target
      update_tab_label(tab_id)
    }
  }

  // Pane management, close-save, and export functions are in ./lib/pane-manager.ts and ./lib/export-handlers.ts

  // Export / save dialog functions are in ./lib/export-handlers.ts


  // ========== Tauri File Drop ==========
  let last_drop_time = 0
  let last_drop_path = ``

  async function setup_tauri_file_drop() {
    try {
      const { getCurrentWebview } = await import(`@tauri-apps/api/webview`)
      const webview = getCurrentWebview()
      await webview.onDragDropEvent(async (event) => {
        if (event.payload.type === `drop`) {
          const paths = event.payload.paths
          console.log(`[Tauri Drop] received`, paths)
          if (paths && paths.length > 0) {
            const now = Date.now()
            // Dedupe on the whole batch (key off first path) so a single
            // multi-file drop doesn't double-fire.
            const batch_key = paths[0]
            if (batch_key === last_drop_path && now - last_drop_time < 500) return
            last_drop_time = now
            last_drop_path = batch_key

            // If a modal dialog with a drop zone is open, skip — let DOM handlers process it
            if (document.querySelector(`.dialog-backdrop`)) return

            // PDFs are never valid structure files — route each to paper import.
            // App-level drop (not scoped to a specific tab) — route to the
            // currently-active tab's chat slice so the loading spinner and
            // any error message surface there.
            const pdf_paths = paths.filter(p => /\.pdf$/i.test(p))
            const other_paths = paths.filter(p => !/\.pdf$/i.test(p))

            for (const pdf_path of pdf_paths) {
              const pdf_name = pdf_path.split(/[/\\]/).pop() || `unknown.pdf`
              const target_tab_id = tm.active_tab_id
              const chat_slice = get_chat_slice(target_tab_id)
              try {
                chat_slice.loading.value = true
                chat_slice.error.value = ``
                const content = await readFile(pdf_path)
                const file = new File([content], pdf_name, { type: `application/pdf` })
                await import_paper(file, target_tab_id)
              } catch (err) {
                chat_slice.error.value = err instanceof Error ? err.message : `Paper import failed`
              } finally {
                chat_slice.loading.value = false
              }
            }

            if (other_paths.length === 0) return

            const ts = get_active_ts()
            if (!ts) return
            is_loading = true
            try {
              const accept = (name: string) => is_structure_file(name) || is_trajectory_file(name) || is_chgcar_file(name)
              const files = await tauri_read_dropped_paths(other_paths, accept)
              const target_pane = ts.panes.findIndex(p => !pane_has_content(p))
              const pane_idx = target_pane >= 0 ? target_pane : ts.active_pane
              if (files.length > 0) {
                await import_many(tm.active_tab_id, files.map(f => ({ content: f.content, filename: f.filename, path: f.path })), pane_idx)
              } else {
                show_toast({ message: `Could not read any file from the drop`, variant: `warning` })
              }
            } catch (err) {
              console.error(`[Tauri Drop] Error reading file:`, err)
              show_toast({ message: `Drop failed: ${err instanceof Error ? err.message : String(err)}`, variant: `error` })
            } finally {
              is_loading = false
            }
          }
        }
      })
      console.log(`[Tauri] file-drop listener registered`)
    } catch (err) {
      console.error(`[Tauri] Failed to set up file drop:`, err)
    }
  }

  // ========== Keyboard Shortcuts (extracted to ./lib/keyboard-shortcuts.ts) ==========
  const handle_keydown = create_handle_keydown({
    get_tabs: () => tm.tabs,
    get_active_tab_id: () => tm.active_tab_id,
    set_active_tab_id: (id) => { tm.active_tab_id = id },
    toggle_sidebar: () => { sidebar.collapsed = !sidebar.collapsed },
    open_tab,
    get_active_ts,
    handle_open_file,
    handle_unload,
    request_close_tab,
    get_tab_close_confirm_id: () => tm.tab_close_confirm_id,
    set_tab_close_confirm_id: (v) => { tm.tab_close_confirm_id = v },
    get_pending_layout_change: () => tm.pending_layout_change,
    set_pending_layout_change: (_v) => { tm.pending_layout_change = null },
  })

  // Drag/drop, resize handlers are in ./lib/drag-drop-handlers.ts and ./lib/resize-handlers.ts

  let show_lab_link = $derived.by(() => {
    // Show only on the landing state of the *currently active* structure
    // tab. Using the first tab let the link bleed through to other tabs
    // that already had a structure loaded.
    const t = tm.active_tab
    if (!t || t.type !== `structure`) return false
    const ts = tab_states[t.id]
    if (!ts) return false
    return !pane_has_content(ts.panes[0])
  })

  // Global SSE listener for the External/MCP "default" panel.
  //
  // Lab claude (and any MCP client without an X-CatGo-Tab-Id header)
  // pushes structures into panel_id="default". This listener owns the
  // delivery — it can't rely on the External tab's <Structure> component
  // because that component is only mounted once a structure exists in
  // the pane (otherwise the empty-state landing cards render instead).
  //
  // Behavior:
  //   * If an External tab is open, write the structure directly into
  //     that tab's first pane (which causes <Structure> to mount with
  //     the data already present, skipping the empty-state cards).
  //   * If no External tab, show a toast inviting the user to open one.
  //   * `snapshot` events (replay-on-connect) inject silently — no toast
  //     so reconnects don't re-bug the user with the same push.
  //
  // Skipped in popout modes and STATIC_ONLY (no backend to subscribe to).
  $effect(() => {
    if (STATIC_ONLY || popout_chat_mode || popout_status_mode || popout_doping_pt_mode) return
    const es = new EventSource(`${API_BASE}/view/subscribe?panel_id=default`)

    function inject_into_external(struct: AnyStructure | null | undefined): boolean {
      if (!struct) return false
      const ts = tab_states[`default`]
      if (!ts || !ts.panes?.[0]) return false
      ts.panes[0].structure = struct
      update_tab_label(`default`)
      return true
    }

    es.addEventListener(`snapshot`, (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        inject_into_external(data.structure)
      } catch (err) {
        console.warn(`[CatGo] global SSE snapshot parse error:`, err)
      }
    })

    es.addEventListener(`structure`, (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        const struct = data.structure
        if (!struct) return
        if (inject_into_external(struct)) return
        // No External tab → toast prompts the user to open one.
        const n = struct.sites?.length ?? 0
        const elems: Record<string, number> = {}
        for (const s of (struct.sites ?? [])) {
          const el = Array.isArray(s.species) ? s.species[0]?.element : s.species
          if (el) elems[el] = (elems[el] || 0) + 1
        }
        const formula = Object.entries(elems).map(([el, k]) => k > 1 ? `${el}${k}` : el).join('') || '?'
        // Pass `struct` into the onclick closure so opening External shows
        // EXACTLY the structure the toast referred to — bypassing the
        // catch-up fetch (which can race against sample-card / heartbeat
        // overwrites of the panel cache).
        const captured = struct
        show_toast({
          message: t('app.external_structure_pushed', {
            formula,
            count: String(n),
            s: n === 1 ? `` : `s`,
          }),
          variant: `info`,
          action: { label: t('app.open_external_viewer'), onclick: () => open_external_tab(captured) },
          duration: 12000,
        })
      } catch (err) {
        console.warn(`[CatGo] global SSE structure parse error:`, err)
      }
    })

    function inject_trajectory_into_external(traj: TrajectoryType, raw: string, filename: string): boolean {
      const ts = tab_states[`default`]
      if (!ts || !ts.panes?.[0]) return false
      const pane = ts.panes[0]
      pane.trajectory = traj
      pane.structure = undefined  // mutually exclusive
      pane.is_trajectory_mode = true
      pane.source_filename = filename || null
      pane.raw_traj_b64 = btoa(unescape(encodeURIComponent(raw)))
      pane.raw_traj_format = (filename.toLowerCase().split(`.`).pop() || ``)
      update_tab_label(`default`)
      return true
    }

    es.addEventListener(`trajectory`, async (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        const { content, filename } = data
        if (!content) return
        const traj = await parse_trajectory_data(content, filename) as TrajectoryType
        if (inject_trajectory_into_external(traj, content, filename || ``)) return
        // No External tab → toast prompts the user to open one.
        const n_frames = traj?.frames?.length ?? `?`
        show_toast({
          message: t('app.external_trajectory_pushed', {
            name: filename || t('app.unnamed'),
            count: String(n_frames),
          }),
          variant: `info`,
          action: {
            label: t('app.open_external_viewer'),
            onclick: () => {
              tm.create_remote_tab()
              // After tab is created, inject (next macrotask)
              setTimeout(() => inject_trajectory_into_external(traj, content, filename || ``), 0)
            },
          },
          duration: 12000,
        })
      } catch (err) {
        console.warn(`[CatGo] global SSE trajectory error:`, err)
      }
    })

    es.onerror = (err) => console.debug(`[CatGo] global SSE issue (auto-reconnecting):`, err)
    return () => es.close()
  })

  // Tell the backend which tab the user is looking at, so asymmetric
  // reads (lab claude with no X-CatGo-Tab-Id header) return THIS panel
  // instead of whichever pane heartbeat-pushed last. Fires on every tab
  // switch — manual click, programmatic activation (open_external_tab),
  // popout return, etc.
  $effect(() => {
    if (STATIC_ONLY) return
    const id = tm.active_tab_id
    if (!id) return
    fetch(`${API_BASE}/view/active-panel?panel_id=${encodeURIComponent(id)}`, {
      method: `POST`,
    }).catch(err => console.debug(`[CatGo] active-panel push failed:`, err))
  })

  // Open (or focus) the External tab and seed it with a structure.
  //
  // Two callers:
  //   * Toast click: passes the struct from the SSE event verbatim →
  //     guaranteed to show the exact push that triggered the toast,
  //     even if the panel cache got polluted by another writer in the
  //     race window between event arrival and tab open.
  //   * External card on the empty landing page: calls without args →
  //     falls back to fetching the current cache (best-effort show
  //     "whatever External had last time").
  function open_external_tab(struct?: AnyStructure | null) {
    tm.create_remote_tab()
    if (struct?.sites?.length) {
      const ts = tab_states[`default`]
      if (ts?.panes?.[0]) {
        ts.panes[0].structure = struct
        update_tab_label(`default`)
      }
      return
    }
    // No struct in hand — try the cache.
    fetch(`${API_BASE}/view/structure/current?panel_id=default`)
      .then(r => r.ok ? r.json() : null)
      .then((cached: AnyStructure | null) => {
        if (!cached?.sites?.length) return
        const ts = tab_states[`default`]
        if (ts?.panes?.[0]) {
          ts.panes[0].structure = cached
          update_tab_label(`default`)
        }
      })
      .catch(err => console.debug(`[CatGo] External catch-up fetch failed:`, err))
  }
</script>

<svelte:window onkeydowncapture={handle_keydown} />
<svelte:document
  ondragover={handle_dragover}
  ondragleave={handle_dragleave}
  ondrop={handle_drop}
/>

{#if !STATIC_ONLY && popout_chat_mode}
<div class="standalone-chat">
  <ChatPane is_popout={true} tab_id={popout_chat_tab_id} />
</div>
{:else if popout_status_mode}
<StatusPopout />
{:else if popout_doping_pt_mode}
<DopingPTWindow />
{:else}
<div class="app-container">

<!-- Tab Bar -->
<TabBar
  tabs={tm.tabs_with_badges}
  active_tab_id={tm.active_tab_id}
  onactivate={activate_tab}
  onclose={request_close_tab}
  oncloseall={open_close_all_dialog}
  onadd={open_tab}
  layout={tm.active_layout}
  onlayoutchange={handle_layout_change}
>
  <!-- Sidebar toggle button -->
  <button
    class="sidebar-toggle"
    onclick={() => sidebar.collapsed = !sidebar.collapsed}
    title={sidebar.collapsed ? t('app.show_sidebar') : t('app.hide_sidebar')}
    style="display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: transparent; border: 1px solid var(--border-color, rgba(128,128,128,0.2)); border-radius: 4px; color: var(--text-color-muted, #6b7280); cursor: pointer; flex-shrink: 0; transition: color 0.15s, background 0.15s;"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      {#if sidebar.collapsed}
        <path d="M3 3h18v18H3zM9 3v18" />
      {:else}
        <path d="M3 3h18v18H3zM9 3v18" />
        <path d="M14 8l-3 4 3 4" />
      {/if}
    </svg>
  </button>
  <ThemeControl style="position: static; box-shadow: none; backdrop-filter: none;" />
  <LocaleSwitch style="position: static; box-shadow: none; backdrop-filter: none;" />
</TabBar>

<!-- Hidden file input (shared, multi-select) -->
<input
  bind:this={file_input_ref}
  type="file"
  multiple
  accept=".cif,.poscar,.vasp,.xyz,.json,.extxyz,.traj,.h5,.hdf5,.gz,.bz2,.xz,.zst,.cube,.cub,.xml,.data,.lammps,*"
  onchange={handle_file_input}
  hidden
/>
<!-- Hidden folder input (browser webkitdirectory) -->
<input
  bind:this={folder_input_ref}
  type="file"
  multiple
  webkitdirectory
  onchange={handle_folder_input}
  hidden
/>

<!-- Workspace: sidebar + divider + views -->
<div class="workspace" class:sidebar-resizing={sidebar.is_resizing}>
  <Sidebar
    bind:collapsed={sidebar.collapsed}
    bind:width={sidebar.width}
    bind:source={sidebar.source}
    bind:hpc_path={sidebar.hpc_path}
    bind:fs_path={sidebar.fs_path}
    on_load_file={handle_sidebar_load}
    on_open_editor={handle_sidebar_open_editor}
    on_preview_file={handle_sidebar_preview}
    on_load_trajectory={handle_sidebar_load_trajectory}
    on_open_workflow={handle_sidebar_open_workflow}
    on_save_structure={get_current_structure}
    on_save_workflow={() => {
      const ts = get_active_ts()
      if (!ts) return null
      const pane = ts.panes[ts.active_pane]
      return pane.mode === `workflow` ? (pane.workflow_id ?? null) : null
    }}
    refresh_counter={sidebar.refresh_counter}
  />

  {#if !sidebar.collapsed}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="sidebar-divider"
      class:active={sidebar.is_resizing}
      onmousedown={on_sidebar_divider_mousedown}
      ondblclick={() => sidebar.width = 240}
    ></div>
  {/if}

  <!-- View layers — one per tab -->
  <div class="view-container">
{#each tm.tabs as tab (tab.id)}
  {#if tab.id === tm.active_tab_id || tab.type === `structure` || tab.type === `workflow` || tab.type === `terminal`}
  <div class="view-layer" class:view-layer-hidden={tab.id !== tm.active_tab_id} inert={tab.id !== tm.active_tab_id || undefined}>

    {#if tab.type === `structure`}
      {@const ts = tab_states[tab.id]}
      {#if ts}
        {@const visible = get_visible_panes(ts)}
        {@const panel_count = layout_panel_count(ts.layout)}

        <div class="structure-workspace">
        {#if ts.library.length >= 2}
          <StructureLibrary
            entries={ts.library}
            active_id={ts.active_library_id}
            on_select={(id) => select_library_entry(tab.id, id)}
            on_remove={(id) => remove_library_entry(tab.id, id)}
            on_clear={() => clear_library(tab.id)}
          />
        {/if}
        <div class="grid-container" class:resizing={is_panel_resizing} style={get_grid_style(ts)}>
          {#each visible as idx (idx)}
            {@const pane = ts.panes[idx]}
            <div
              class="pane"
              class:active={ts.active_pane === idx}
              class:dragover={tab.id === tm.active_tab_id && drag_target_pane === idx}
              class:warn-glow={ts.close_confirm_pane === idx}
              data-pane={idx}
              style={get_pane_position(ts.layout, idx)}
              onclick={() => ts.active_pane = idx}
              role="button"
              tabindex="0"
            >
              <!-- Panel header bar -->
              {#if panel_count > 1}
                <div class="panel-header">
                  {#if pane_has_content(pane)}
                    <span class="panel-dot"></span>
                  {/if}
                  <span class="panel-label">{get_pane_label(pane)}</span>
                  {#if pane_has_content(pane)}
                    <button
                      class="panel-popout-btn"
                      onclick={(e) => { e.stopPropagation(); popout_pane(tab.id, idx) }}
                      title={t('app.open_in_new_window')}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                      </svg>
                    </button>
                  {/if}
                  <button
                    class="panel-close-btn"
                    onclick={(e) => { e.stopPropagation(); handle_unload(tab.id, idx) }}
                    title={t('app.close_panel')}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              {/if}

              <!-- Inline close confirmation banner -->
              {#if ts.close_confirm_pane === idx}
                <div class="panel-close-banner">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 9v2m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
                  </svg>
                  {#if ts.panes[idx].mode === 'workflow'}
                    <span>{t('app.workflow_will_be_closed')}</span>
                    <button class="banner-btn cancel" onclick={(e) => { e.stopPropagation(); ts.close_confirm_pane = null }}>{t('common.cancel')}</button>
                    <button class="banner-btn close" onclick={(e) => { e.stopPropagation(); close_panel(tab.id, idx) }}>{t('common.close')}</button>
                  {:else}
                    <span>{t('common.save_before_closing')}</span>
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <select class="banner-select target-select" bind:value={exp.close_save_target} onclick={(e) => e.stopPropagation()}>
                      <option value="local">{t('app.local')}</option>
                      {#if ts.panes[idx].remote_origin?.session_id}
                        <option value="hpc">{t('app.hpc')}</option>
                      {/if}
                      <option value="project">{t('app.catgo_db')}</option>
                    </select>
                    {#if exp.close_save_target === `project` && exp.close_save_projects.length > 0}
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <select class="banner-select" bind:value={exp.close_save_project_id} onclick={(e) => e.stopPropagation()}>
                        {#snippet banner_select_options(projects: ProjectSummary[], depth: number)}
                          {#each projects as p (p.id)}
                            <option value={p.id}>{`\u00A0\u00A0`.repeat(depth)}{p.name}</option>
                            {#if save_project_children[p.id]?.length}
                              {@render banner_select_options(save_project_children[p.id], depth + 1)}
                            {/if}
                          {/each}
                        {/snippet}
                        {@render banner_select_options(save_project_roots, 0)}
                      </select>
                    {/if}
                    {#if exp.close_save_target === `hpc`}
                      <span class="banner-path" title={ts.panes[idx].remote_origin?.file_path}>{ts.panes[idx].remote_origin?.file_path?.split(/[/\\]/).pop()}</span>
                    {/if}
                    <button class="banner-btn save" disabled={exp.close_saving} onclick={(e) => { e.stopPropagation(); save_and_close_panel(tab.id, idx) }}>
                      {exp.close_saving ? t('common.saving') : t('common.save_and_close')}
                    </button>
                    <button class="banner-btn close" onclick={(e) => { e.stopPropagation(); close_panel(tab.id, idx) }}>{t('common.close')}</button>
                    <button class="banner-btn cancel" onclick={(e) => { e.stopPropagation(); ts.close_confirm_pane = null }}>{t('common.cancel')}</button>
                  {/if}
                </div>
              {/if}

              <!-- Panel content -->
              <div class="panel-content">
              {#if pane.mode === 'workflow'}
                <WorkflowView
                  initial_workflow_id={pane.workflow_id}
                  compact={pane.workflow_compact ?? false}
                  tab_id={tab.id}
                  onclose={() => { ts.panes[idx] = create_empty_pane(); ts.panes = [...ts.panes]; update_tab_label(tab.id) }}
                  onchange={() => { ts.panes[idx].modified = true }}
                  ondbchange={() => { sidebar.refresh_counter++ }}
                />
              {:else if pane.is_trajectory_mode && pane.trajectory}
                <Trajectory
                  trajectory={pane.trajectory as any}
                  bind:selected_sites={ts.panes[idx].selected_sites}
                  bind:current_step_idx={ts.panes[idx].current_step_idx}
                  on_file_load={create_on_file_load(tab.id, idx)}
                  fullscreen_toggle={false}
                  allow_file_drop={false}
                  structure_props={{ fullscreen_toggle: false, hide_extra_tools: false, initial_traj_b64: pane.raw_traj_b64, initial_traj_format: pane.raw_traj_format, tab_id: tab.id }}
                  style="--struct-height: 100%; --struct-width: 100%; border-radius: 0;"
                >
                  {#snippet trajectory_controls({ trajectory: traj, current_step_idx: step, on_step_change })}
                    <PathwayControls
                      trajectory={traj}
                      current_step_idx={step}
                      {on_step_change}
                    />
                  {/snippet}
                </Trajectory>
              {:else if pane.structure}
                <Structure
                  tab_id={tab.id}
                  is_active={ts.active_pane === idx}
                  bind:structure={ts.panes[idx].structure}
                  bind:saveable_structure={ts.panes[idx].saveable_structure}
                  bind:selected_sites={ts.panes[idx].selected_sites}
                  bind:remote_origin={ts.panes[idx].remote_origin}
                  bind:open_plugin_hub={ts.panes[idx].open_plugin_hub}
                  cube_file={pane.cube_file}
                  initial_panel={pane.initial_panel}
                  on_file_load={create_on_file_load(tab.id, idx)}
                  on_file_drop={create_on_file_drop(tab.id, idx)}
                  on_structure_imported={() => update_tab_label(tab.id)}
                  on_save_to_project={open_save_dialog}
                  on_save_to_database={open_save_dialog}
                  on_clear_structure={() => {
                    ts.panes[idx] = create_empty_pane()
                    update_tab_label(tab.id)
                  }}
                  on_export_to_hpc={open_export_to_hpc}
                  on_export_to_file={open_export_to_file}
                  on_edit_as_text={open_edit_as_text}
                  on_open_file_overlay={(file_path: string, filename: string, session_id: string) => {
                    handle_terminal_open_file(file_path, filename, session_id)
                  }}
                  on_open_workflow_editor={(workflow_id: string) => {
                    handle_sidebar_open_workflow(workflow_id)
                  }}
                  fullscreen_toggle={false}
                  allow_file_drop={false}
                  show_controls={true}
                  style="--struct-height: 100%; --struct-width: 100%; border-radius: 0;"
                />
              {:else}
                <div class="landing-page" class:secondary-pane={idx > 0} class:quad-layout={ts.layout === 'quad'} class:stacked-layout={ts.layout === 'splitV'}>
                  {#if idx === 0}
                    <div class="samples-grid">
                      {#each sample_structures as sample}
                        <button
                          class="sample-card"
                          onclick={() => {
                            ts.panes[idx].structure = sample.data
                            ts.panes[idx].initial_site_count = sample.data.sites?.length ?? 0
                            ts.panes[idx].initial_structure_ref = sample.data
                            ts.panes[idx].modified = false
                            ts.active_pane = idx
                            update_tab_label(tab.id)
                          }}
                        >
                          <div class="sample-preview">
                            <!-- align_on_load="none" prevents auto principal-axes rotation that
                                 would flatten the water V-shape into the XY plane (invisible from -Y camera).
                                 Orthographic projection + zoom for consistent sizing in the preview card. -->
                            <Structure
                              structure={sample.data}
                              show_controls={false}
                              fullscreen_toggle={false}
                              allow_file_drop={false}
                              align_on_load="none"
                              persist_settings={false}
                              scene_props={{ atom_radius: 1.6, camera_projection: 'orthographic', initial_zoom: 100 } as any}
                              style="--struct-height: 100%; --struct-width: 100%; pointer-events: none;"
                            />
                          </div>
                          <div class="sample-info">
                            <span class="sample-name">{sample.name}</span>
                            <span class="sample-formula">{sample.formula}</span>
                          </div>
                        </button>
                      {/each}
                    </div>
                  {/if}

                  <div class="import-sidebar">
                    <button class="import-card add-own-card" onclick={() => handle_open_file(tab.id, idx)}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                      </svg>
                      <div class="import-text">
                        <span class="import-title">{t('common.open_file')}</span>
                        <span class="import-desc">{t('app.multi_select_or_drop')}</span>
                      </div>
                    </button>

                    <button class="import-card add-own-card" onclick={() => handle_open_folder(tab.id, idx)}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        <path d="M2 10h20"/>
                      </svg>
                      <div class="import-text">
                        <span class="import-title">{t('common.open_folder')}</span>
                        <span class="import-desc">{t('app.load_all_structures')}</span>
                      </div>
                    </button>

                    <button class="import-card database-card" onclick={() => { modal.import_target_tab = tab.id; modal.import_target_pane = idx; modal.optimade_search_element = ``; modal.search_provider = STATIC_ONLY ? `pubchem` : `mp`; modal.search_visible = true }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M12 3C7.58 3 4 4.79 4 7s3.58 4 8 4s8-1.79 8-4s-3.58-4-8-4M4 9v3c0 2.21 3.58 4 8 4s8-1.79 8-4V9M4 14v3c0 2.21 3.58 4 8 4s8-1.79 8-4v-3"/>
                      </svg>
                      <div class="import-text">
                        <span class="import-title">{t('app.search_database')}</span>
                        <span class="import-desc">{STATIC_ONLY ? t('app.pubchem_molecules') : t('app.optimade_pubchem')}</span>
                      </div>
                    </button>

                    <button class="import-card paste-card" onclick={() => { modal.import_target_tab = tab.id; modal.import_target_pane = idx; modal.paste_content_visible = true }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                        <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
                        <path d="M9 12h6M9 16h6"/>
                      </svg>
                      <div class="import-text">
                        <span class="import-title">{t('common.paste')}</span>
                        <span class="import-desc">POSCAR/CONTCAR</span>
                      </div>
                    </button>

                    {#if !STATIC_ONLY}
                    <button class="import-card workflow-card" onclick={() => { ts.panes[idx].mode = 'workflow'; ts.panes = [...ts.panes]; update_tab_label(tab.id) }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="2" y="3" width="6" height="5" rx="1" />
                        <rect x="16" y="3" width="6" height="5" rx="1" />
                        <rect x="9" y="16" width="6" height="5" rx="1" />
                        <path d="M5 8v3a2 2 0 002 2h10a2 2 0 002-2V8" />
                        <path d="M12 13v3" />
                      </svg>
                      <div class="import-text">
                        <span class="import-title">{t('common.workflow')}</span>
                        <span class="import-desc">{t('app.pipeline_editor')}</span>
                      </div>
                    </button>
                    {/if}

                    <button class="import-card builder-card" onclick={() => {
                      ts.panes[idx].structure = {
                        lattice: {
                          matrix: [[2.46, 0, 0], [1.23, 2.1304, 0], [0, 0, 20]] as [number[], number[], number[]],
                          a: 2.46, b: 2.46, c: 20,
                          alpha: 90, beta: 90, gamma: 120,
                          volume: 104.82,
                          pbc: [true, true, true] as [boolean, boolean, boolean],
                        },
                        sites: [
                          { species: [{ element: `C`, occu: 1, oxidation_state: 0 }], abc: [0, 0, 0.5], xyz: [0, 0, 10], label: `C`, properties: {} },
                          { species: [{ element: `C`, occu: 1, oxidation_state: 0 }], abc: [0.3333, 0.3333, 0.5], xyz: [1.23, 0.7101, 10], label: `C`, properties: {} },
                        ],
                      } as unknown as AnyStructure
                      ts.panes[idx].initial_site_count = 2
                      ts.panes[idx].initial_structure_ref = ts.panes[idx].structure
                      ts.panes[idx].modified = false
                      ts.active_pane = idx
                    }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="8" r="2.5"/>
                        <circle cx="6" cy="16" r="2.5"/>
                        <circle cx="18" cy="16" r="2.5"/>
                        <path d="M12 10.5v2.5l-4.5 3M12 13l4.5 3"/>
                      </svg>
                      <div class="import-text">
                        <span class="import-title">{t('app.build')}</span>
                        <span class="import-desc">{t('app.build_desc')}</span>
                      </div>
                    </button>

                    <!-- AI Chat: shown in STATIC_ONLY too — CatBot runs client-direct
                         in-browser (no backend) and can fetch/build structures from empty state. -->
                    <button class="import-card chat-card" onclick={() => {
                      console.log(`[CatGo:UI] Welcome card clicked: AI Chat → loading structure + opening Chat panel`)
                      ts.panes[idx].structure = water as unknown as AnyStructure
                      ts.panes[idx].initial_site_count = (water as any).sites?.length ?? 0
                      ts.panes[idx].initial_structure_ref = water as unknown as AnyStructure
                      ts.panes[idx].initial_panel = `chat`
                      ts.active_pane = idx
                      update_tab_label(tab.id)
                    }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                      </svg>
                      <div class="import-text">
                        <span class="import-title">{t('app.ai_chat')}</span>
                        <span class="import-desc">{t('app.ask_questions')}</span>
                      </div>
                    </button>

                    {#if !STATIC_ONLY}
                    <button class="import-card hpc-card" onclick={() => {
                      console.log(`[CatGo:UI] Welcome card clicked: HPC → loading structure + opening HPC panel`)
                      ts.panes[idx].structure = water as unknown as AnyStructure
                      ts.panes[idx].initial_site_count = (water as any).sites?.length ?? 0
                      ts.panes[idx].initial_structure_ref = water as unknown as AnyStructure
                      ts.panes[idx].initial_panel = `hpc`
                      ts.active_pane = idx
                      update_tab_label(tab.id)
                    }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
                      </svg>
                      <div class="import-text">
                        <span class="import-title">{t('app.hpc')}</span>
                        <span class="import-desc">{t('app.remote_connect')}</span>
                      </div>
                    </button>

                    <button class="import-card terminal-card" onclick={() => {
                      console.log(`[CatGo:UI] Welcome card clicked: Terminal → loading structure + opening Terminal panel`)
                      ts.panes[idx].structure = water as unknown as AnyStructure
                      ts.panes[idx].initial_site_count = (water as any).sites?.length ?? 0
                      ts.panes[idx].initial_structure_ref = water as unknown as AnyStructure
                      ts.panes[idx].initial_panel = `terminal`
                      ts.active_pane = idx
                      update_tab_label(tab.id)
                    }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                      </svg>
                      <div class="import-text">
                        <span class="import-title">{t('app.terminal')}</span>
                        <span class="import-desc">{t('app.local_shell')}</span>
                      </div>
                    </button>
                    {/if}

                    <!-- Plugins Card (only show on main pane, hide in static mode) -->
                    {#if !STATIC_ONLY && idx === 0}
                      <button class="import-card plugins-card" onclick={() => open_plugin_hub_on_active_pane()}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                          <path d="M2 17l10 5 10-5"/>
                          <path d="M2 12l10 5 10-5"/>
                        </svg>
                        <div class="import-text">
                          <span class="import-title">{t('app.plugins')}</span>
                          <span class="import-desc">{t('app.extend_catgo')}</span>
                        </div>
                      </button>

                      <!-- External Card — opens (or focuses) the 🤖 External tab.
                           Lab claude / external MCP pushes land here without
                           clobbering your working panes. Distinct from the HPC
                           card above (which is SSH/Slurm). -->
                      <button class="import-card external-card" onclick={() => open_external_tab()}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                          <circle cx="12" cy="12" r="2"/>
                          <path d="M16.24 7.76a6 6 0 0 1 0 8.49"/>
                          <path d="M7.76 16.25a6 6 0 0 1 0-8.49"/>
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                          <path d="M4.93 19.07a10 10 0 0 1 0-14.14"/>
                        </svg>
                        <div class="import-text">
                          <span class="import-title">{t('app.external')}</span>
                          <span class="import-desc">{t('app.receive_from_lab')}</span>
                        </div>
                      </button>
                    {/if}
                  </div>
                </div>
              {/if}

              </div><!-- end panel-content -->
            </div>
          {/each}

          <!-- Resize handles -->
          {#if ts.layout === 'splitH'}
            <div
              class="grid-divider grid-divider-col"
              class:active={is_panel_resizing && resize_axis === 'col'}
              style="grid-column: 2; grid-row: 1;"
              onmousedown={(e) => on_divider_mousedown(e, 'col', tab.id)}
              ondblclick={() => { ts.col_split = 50 }}
              role="separator"
              aria-orientation="vertical"
            ></div>
          {:else if ts.layout === 'splitV'}
            <div
              class="grid-divider grid-divider-row"
              class:active={is_panel_resizing && resize_axis === 'row'}
              style="grid-column: 1; grid-row: 2;"
              onmousedown={(e) => on_divider_mousedown(e, 'row', tab.id)}
              ondblclick={() => { ts.row_split = 50 }}
              role="separator"
              aria-orientation="horizontal"
            ></div>
          {:else if ts.layout === 'quad'}
            <div
              class="grid-divider grid-divider-col"
              class:active={is_panel_resizing && resize_axis === 'col'}
              style="grid-column: 2; grid-row: 1 / span 3;"
              onmousedown={(e) => on_divider_mousedown(e, 'col', tab.id)}
              ondblclick={() => { ts.col_split = 50 }}
              role="separator"
              aria-orientation="vertical"
            ></div>
            <div
              class="grid-divider grid-divider-row"
              class:active={is_panel_resizing && resize_axis === 'row'}
              style="grid-column: 1 / span 3; grid-row: 2;"
              onmousedown={(e) => on_divider_mousedown(e, 'row', tab.id)}
              ondblclick={() => { ts.row_split = 50 }}
              role="separator"
              aria-orientation="horizontal"
            ></div>
            <div
              class="grid-divider grid-divider-center"
              class:active={is_panel_resizing}
              style="grid-column: 2; grid-row: 2; z-index: 2;"
              onmousedown={(e) => on_center_mousedown(e, tab.id)}
              ondblclick={() => { ts.col_split = 50; ts.row_split = 50 }}
              role="separator"
            ></div>
          {/if}
        </div>
        </div><!-- end structure-workspace -->
      {/if}

    {:else if tab.type === `workflow`}
      <WorkflowView
        tab_id={tab.id}
        onclose={() => { close_tab(`workflow`); switch_to_structure() }}
        onpopout={popout_workflow}
      />

    {:else if !STATIC_ONLY && tab.type === `terminal`}
      <TerminalWindow
        initial_session_id={terminal.init_session_id}
        initial_host={terminal.init_host}
        initial_username={terminal.init_username}
        initial_sync_cwd={terminal.init_sync_cwd}
        onclose={() => { close_tab(`terminal`); switch_to_structure() }}
        onpopout={popout_terminal}
        on_open_file={async (file_path) => {
          const name = file_path.split(`/`).pop() || file_path
          await handle_terminal_open_file(file_path, name, terminal.init_session_id || ``)
        }}
      />
    {/if}

  </div>
  {/if}
{/each}
  </div><!-- End view-container -->
</div><!-- End workspace -->

<!-- Sidebar file editor overlay -->
{#if sidebar.editor_open}
  <div class="sidebar-editor-overlay">
    <MonacoEditorPanel
      content={sidebar.editor_content}
      filename={sidebar.editor_filename}
      file_path={sidebar.editor_file_path}
      session_id={sidebar.editor_session_id}
      local_file_path={sidebar.editor_local_path}
      onclose={() => { sidebar.editor_open = false; sidebar.editor_on_save = null }}
      onsave={sidebar.editor_on_save || undefined}
      onvisualize={(text, name) => {
        sidebar.editor_open = false
        sidebar.editor_on_save = null
        handle_sidebar_load(text, name, sidebar.editor_file_path || undefined, sidebar.editor_session_id || undefined)
      }}
    />
  </div>
{/if}

<!-- Sidebar file preview overlay (images, PDFs, markdown, csv, etc.) -->
{#if sidebar.preview_open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="sidebar-preview-backdrop" onclick={(e) => { if (e.target === e.currentTarget) sidebar.preview_open = false }}>
    <div class="sidebar-editor-overlay" style="display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.1));">
        <span style="font-weight: 500; font-size: 13px;">{sidebar.preview_filename}</span>
        <button onclick={() => sidebar.preview_open = false} style="background: none; border: none; cursor: pointer; font-size: 16px; color: light-dark(#666, #999); padding: 2px 6px;">✕</button>
      </div>
      <div style="flex: 1; min-height: 0; overflow: auto;">
        <FilePreviewPanel
          mode={sidebar.preview_mode}
          filename={sidebar.preview_filename}
          content={sidebar.preview_content}
          binary_data={sidebar.preview_binary_data}
          mime_type={sidebar.preview_mime_type}
          file_path={sidebar.preview_file_path}
          session_id={sidebar.preview_session_id}
          onclose={() => sidebar.preview_open = false}
        />
      </div>
    </div>
  </div>
{/if}

<!-- Lab link -->
{#if show_lab_link}
  <a
    href="https://wanlulilab.ucsd.edu"
    target="_blank"
    rel="noopener noreferrer"
    class="lab-link"
    title="Dr. Wanlu Li Lab @ UCSD"
  >
    Dr. Wanlu Li @UCSD
  </a>
{/if}

<!-- Database search modal (needs backend proxy) -->
{#if modal.search_visible}
  <OptimadeSearchModal
    visible={modal.search_visible}
    onclose={() => modal.search_visible = false}
    onimport={handle_database_import}
    onpreview={handle_optimade_preview}
    onpubchem_preview={handle_pubchem_preview}
    initial_elements={modal.optimade_search_element}
    initial_provider={modal.search_provider}
  />
{/if}

<!-- Database import preview (OPTIMADE / PubChem) -->
<OptimadePreviewModal
  visible={modal.db_preview_visible}
  onclose={cancel_db_preview}
  onconfirm={confirm_db_preview}
  pymatgen_structure={modal.db_preview_pymatgen as PymatgenStructure | null}
  title={modal.db_preview_title}
  formula={modal.db_preview_formula}
  details={modal.db_preview_details}
  lattice_params={modal.db_preview_lattice}
/>

{#if modal.paste_content_visible}
  <PasteContentModal
    visible={modal.paste_content_visible}
    onclose={() => modal.paste_content_visible = false}
    onimport={handle_database_import}
  />
{/if}

<!-- Tab close confirmation modal -->
{#if tm.tab_close_confirm_id}
  {@const confirm_tab = tm.tabs.find(t => t.id === tm.tab_close_confirm_id)}
  {@const confirm_ts = tab_states[tm.tab_close_confirm_id]}
  {#if confirm_tab && confirm_ts}
    {@const structure_count = confirm_ts.panes.slice(0, layout_panel_count(confirm_ts.layout)).filter(p => pane_has_content(p)).length}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={() => tm.tab_close_confirm_id = null}>
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="modal-dialog" onclick={(e) => e.stopPropagation()}>
        <h3>Close tab "{confirm_tab.label}"?</h3>
        <p>{structure_count} loaded structure{structure_count !== 1 ? 's' : ''} will be removed.</p>
        <div class="modal-actions">
          <button class="modal-btn cancel" onclick={() => tm.tab_close_confirm_id = null}>Cancel</button>
          <button class="modal-btn danger" onclick={() => close_tab(tm.tab_close_confirm_id!)}>Close Tab</button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<!-- Close All Tabs modal (extracted to CloseAllModal.svelte) -->
<CloseAllModal {execute_close_all} {close_all_without_saving} />

<!-- Layout change confirmation modal -->
{#if tm.pending_layout_change}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={() => tm.pending_layout_change = null}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="modal-dialog" onclick={(e) => e.stopPropagation()}>
      <h3>Change layout?</h3>
      <p>{tm.pending_layout_change.lost_count} structure{tm.pending_layout_change.lost_count !== 1 ? 's' : ''} will be removed.</p>
      <div class="modal-actions">
        <button class="modal-btn cancel" onclick={() => tm.pending_layout_change = null}>Cancel</button>
        <button class="modal-btn danger" onclick={confirm_layout_change}>Continue</button>
      </div>
    </div>
  </div>
{/if}

<!-- Unified Export / Save dialog (extracted to ExportSaveDialog.svelte) -->
<ExportSaveDialog
  {save_project_roots}
  {save_project_children}
  hpc_path={sidebar.hpc_path}
  {export_fs_browse}
  {do_export}
/>


<!-- Loading overlay -->
{#if is_loading}
  <div class="loading">
    {#if loading_text}
      <div class="loading-card">
        <div class="loading-progress-bar">
          <div class="loading-progress-fill"></div>
        </div>
        <div class="loading-label">{loading_text}</div>
      </div>
    {:else}
      <div class="spinner"></div>
    {/if}
  </div>
{/if}

</div><!-- End app-container -->
{/if}

<Toast />

<style>
  .sidebar-editor-overlay {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(80vw, 900px);
    height: min(80vh, 700px);
    z-index: 100;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.1));
    background: light-dark(#f8f8f8, #1e1e1e);
  }

  .sidebar-preview-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
    background: rgba(0, 0, 0, 0.4);
  }

  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :global(html), :global(body) {
    width: 100%;
    height: 100%;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
  }

  :global(body) {
    padding: 0;
  }

  :global(.trajectory .structure) {
    --struct-height: 100% !important;
    --struct-width: 100% !important;
  }

  :global(.structure .warn) {
    display: none;
  }

  .standalone-chat {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--page-bg);
    color: var(--text-color);
  }
  .standalone-chat > :global(*) {
    flex: 1;
    min-height: 0;
  }

  .app-container {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    background: var(--surface-bg, var(--page-bg));
  }

  .workspace {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .workspace.sidebar-resizing {
    user-select: none;
  }

  .workspace.sidebar-resizing .view-container {
    pointer-events: none;
  }

  .sidebar-divider {
    width: 4px;
    cursor: col-resize;
    background: var(--border-color, rgba(128, 128, 128, 0.15));
    transition: background 0.15s;
    flex-shrink: 0;
  }

  .sidebar-divider:hover,
  .sidebar-divider.active {
    background: var(--accent-color, #3b82f6);
  }

  .view-container {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .view-layer {
    position: absolute;
    inset: 0;
  }
  .view-layer-hidden {
    visibility: hidden;
    pointer-events: none;
    z-index: -1;
  }

  .structure-workspace {
    display: flex;
    width: 100%;
    height: 100%;
  }
  .structure-workspace > .grid-container {
    flex: 1;
    min-width: 0;
  }

  .grid-container {
    display: grid;
    width: 100%;
    height: 100%;
  }

  /* Resize dividers */
  .grid-divider {
    background: var(--border-color, rgba(128, 128, 128, 0.2));
    transition: background 0.15s;
    z-index: 1;
  }
  .grid-divider-col { cursor: col-resize; }
  .grid-divider-row { cursor: row-resize; }
  .grid-divider-center { cursor: move; }
  .grid-divider:hover, .grid-divider.active {
    background: var(--accent-color, #3b82f6);
  }
  .grid-container.resizing .pane { pointer-events: none; }
  .grid-container.resizing { user-select: none; }

  .pane {
    position: relative;
    overflow: hidden;
    background: var(--surface-bg, var(--page-bg));
    cursor: pointer;
    display: flex;
    flex-direction: column;
  }

  .pane.warn-glow {
    box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.5);
  }

  /* Panel header */
  .panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    min-height: 28px;
    background: var(--page-bg, #0f1520);
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
    font-size: 11px;
    user-select: none;
  }

  .panel-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    flex-shrink: 0;
  }

  .panel-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-color-muted, #6b7280);
    font-weight: 500;
  }

  .panel-popout-btn,
  .panel-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-color-dim, #9ca3af);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s, color 0.15s;
  }

  .pane:hover .panel-popout-btn,
  .pane:hover .panel-close-btn {
    opacity: 1;
  }

  .panel-popout-btn:hover {
    background: rgba(59, 130, 246, 0.5);
    color: white;
  }

  .panel-close-btn:hover {
    background: rgba(220, 38, 38, 0.5);
    color: white;
  }

  /* Panel content area */
  .panel-content {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
    /* Definite height base for percentage-based children (Three.js canvas) */
    height: 0;
  }

  /* Inline panel close confirmation banner */
  .panel-close-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: rgba(245, 158, 11, 0.1);
    border-bottom: 1px solid rgba(245, 158, 11, 0.3);
    font-size: 12px;
    color: var(--text-color, #374151);
    animation: banner-slide 0.15s ease-out;
  }

  .panel-close-banner svg {
    color: #f59e0b;
    flex-shrink: 0;
  }

  .panel-close-banner span {
    flex: 1;
    font-weight: 500;
  }

  .banner-btn {
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  }

  .banner-btn.cancel {
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
    color: var(--text-color, #374151);
  }

  .banner-btn.cancel:hover {
    background: var(--btn-bg-hover, rgba(128, 128, 128, 0.2));
  }

  .banner-btn.close {
    background: rgba(220, 38, 38, 0.7);
    border-color: rgba(220, 38, 38, 0.5);
    color: white;
  }

  .banner-btn.close:hover {
    background: rgba(220, 38, 38, 0.9);
  }

  .banner-btn.save {
    background: rgba(34, 197, 94, 0.7);
    border-color: rgba(34, 197, 94, 0.5);
    color: white;
  }

  .banner-btn.save:hover:not(:disabled) {
    background: rgba(34, 197, 94, 0.9);
  }

  .banner-btn.save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .banner-select {
    padding: 2px 4px;
    font-size: 11px;
    background: var(--btn-bg, rgba(128, 128, 128, 0.15));
    color: var(--text-color, #e2e8f0);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
    border-radius: 3px;
    outline: none;
    max-width: 120px;
  }
  .banner-select option {
    background: var(--dialog-bg, #1c1d21);
    color: var(--text-color, #e2e8f0);
  }
  .banner-select.target-select {
    max-width: 90px;
    font-weight: 600;
  }
  .banner-path {
    font-size: 11px;
    color: var(--text-muted, #94a3b8);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @keyframes banner-slide {
    from { opacity: 0; transform: translateY(-100%); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Modal dialogs (tab close, layout change) */
  .modal-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100000050;
    animation: fade-in 0.15s ease-out;
  }

  .modal-dialog {
    background: var(--dialog-bg, var(--surface-bg, #1c1c2e));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 12px;
    padding: 24px;
    min-width: 320px;
    max-width: 420px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
  }

  .modal-dialog h3 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-color, #374151);
    margin: 0 0 8px 0;
  }

  .modal-dialog p {
    font-size: 13px;
    color: var(--text-color-muted, #6b7280);
    margin: 0 0 20px 0;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .modal-btn {
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  }

  .modal-btn.cancel {
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
    color: var(--text-color, #374151);
  }

  .modal-btn.cancel:hover {
    background: var(--btn-bg-hover, rgba(128, 128, 128, 0.2));
  }

  .modal-btn.danger {
    background: rgba(220, 38, 38, 0.8);
    border-color: rgba(220, 38, 38, 0.6);
    color: white;
  }

  .modal-btn.danger:hover {
    background: rgba(220, 38, 38, 1);
  }

  .modal-btn.confirm {
    background: rgba(34, 197, 94, 0.8);
    border-color: rgba(34, 197, 94, 0.5);
    color: white;
  }

  .modal-btn.confirm:hover:not(:disabled) {
    background: rgba(34, 197, 94, 1);
  }

  .modal-btn.confirm:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .modal-btn.save {
    background: rgba(59, 130, 246, 0.8);
    border-color: rgba(59, 130, 246, 0.5);
    color: white;
  }

  .modal-btn.save:hover:not(:disabled) {
    background: rgba(59, 130, 246, 1);
  }

  .modal-btn.save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Close-all and export dialog styles are now in their sub-components */

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .pane.dragover::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 100000005;
    box-shadow: inset 0 0 0 3px #22c55e;
  }

  /* Original horizontal layout (restored) */
  .landing-page {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: safe center;
    justify-content: center;
    gap: 32px;
    padding: 16px;
    overflow-y: auto;
    background: var(--page-bg, linear-gradient(135deg, rgba(20, 25, 35, 0.98) 0%, rgba(10, 15, 25, 1) 100%));
  }

  .landing-page.secondary-pane {
    gap: 0;
  }

  .landing-page.secondary-pane .import-sidebar {
    width: auto;
    min-width: 280px;
  }

  .samples-grid {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 16px;
    flex: 1;
    max-width: 400px;
    height: 100%;
    max-height: 400px;
  }

  @media (max-width: 900px) {
    .landing-page {
      flex-direction: column;
      gap: 24px;
    }
    .samples-grid {
      max-height: 300px;
      max-width: 300px;
    }
    .import-sidebar {
      width: 100% !important;
      max-width: 500px !important;
    }
  }

  .sample-card {
    display: flex;
    flex-direction: column;
    background: var(--surface-bg, rgba(30, 41, 59, 0.6));
    border: 1px solid var(--text-color-muted, rgba(71, 85, 105, 0.4));
    border-radius: 12px;
    cursor: pointer;
    transition: all 0.25s ease;
    overflow: hidden;
    padding: 0;
    width: 100%;
    height: 100%;
    min-height: 280px;
  }

  .sample-card:hover {
    border-color: rgba(59, 130, 246, 0.6);
    transform: translateY(-4px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  }

  .sample-preview {
    flex: 1;
    min-height: 0;
    background: var(--surface-bg, rgba(15, 23, 42, 0.8));
    border-radius: 11px 11px 0 0;
    overflow: hidden;
  }

  .sample-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: var(--surface-bg, rgba(30, 41, 59, 0.8));
  }

  .sample-name {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-color, #f1f5f9);
  }

  .sample-formula {
    font-size: 0.8rem;
    font-weight: 500;
    color: #60a5fa;
  }

  .import-sidebar {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    width: 420px;
  }

  .import-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--surface-bg, rgba(30, 41, 59, 0.4));
    border: 1px solid var(--text-color-muted, rgba(71, 85, 105, 0.4));
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: var(--text-color-muted, rgba(148, 163, 184, 0.8));
  }

  .import-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
  }

  .import-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-color, #f1f5f9);
  }

  .import-desc {
    font-size: 0.75rem;
    color: var(--text-color-muted, rgba(148, 163, 184, 0.6));
  }

  .import-card:hover {
    transform: translateY(-2px);
    border-color: rgba(96, 165, 250, 0.5);
    background: rgba(96, 165, 250, 0.08);
  }

  .import-card:hover .import-title {
    color: #93c5fd;
  }

  .pane.dragover .import-card.add-own-card {
    border-color: #22c55e;
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .pane.dragover .import-card.add-own-card .import-title {
    color: #22c55e;
  }

  /* Quad layout responsive import */
  .landing-page.quad-layout {
    padding: 8px;
  }

  .landing-page.quad-layout .samples-grid {
    display: none;
  }

  .landing-page.quad-layout .import-sidebar {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    width: 100%;
    max-width: 280px;
  }

  .landing-page.quad-layout .import-card {
    padding: 6px 8px;
    gap: 6px;
  }

  .landing-page.quad-layout .import-card svg {
    width: 16px;
    height: 16px;
  }

  .landing-page.quad-layout .import-desc {
    display: none;
  }

  .landing-page.quad-layout .import-title {
    font-size: 0.8rem;
  }

  /* Stacked (splitV) layout — compact grid to avoid scrolling */
  .landing-page.stacked-layout {
    padding: 12px;
    overflow-y: hidden;
  }

  .landing-page.stacked-layout .samples-grid {
    display: none;
  }

  .landing-page.stacked-layout .import-sidebar {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    width: 100%;
    max-width: 520px;
  }

  .landing-page.stacked-layout .import-card {
    padding: 8px 10px;
    gap: 8px;
  }

  .landing-page.stacked-layout .import-card svg {
    width: 18px;
    height: 18px;
  }

  .landing-page.stacked-layout .import-desc {
    display: none;

  /* [2025-02] Alternative vertical layout — commented out for future reference
  .landing-page {
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 24px;
  }
  .samples-grid {
    width: 100%;
    max-width: 480px;
    height: 260px;
    align-items: stretch;
  }
  .sample-card { min-height: auto; }
  .import-sidebar {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: center;
    width: 100%;
    max-width: 480px;
  }
  .import-sidebar h2 { width: 100%; text-align: center; }
  .import-card { width: calc(50% - 5px); }
  .import-card:hover { transform: translateY(-2px); }
  */
  }

  .lab-link {
    position: fixed;
    bottom: 12px;
    right: 12px;
    padding: 6px 12px;
    background: var(--surface-bg, rgba(30, 41, 59, 0.8));
    border: 1px solid var(--text-color-muted, rgba(71, 85, 105, 0.4));
    border-radius: 6px;
    color: var(--text-color-muted, rgba(148, 163, 184, 0.9));
    font-size: 11px;
    text-decoration: none;
    z-index: 100;
    transition: all 0.2s ease;
  }

  .lab-link:hover {
    background: rgba(30, 41, 59, 0.95);
    border-color: rgba(59, 130, 246, 0.5);
    color: #60a5fa;
  }

  .loading {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: rgba(0, 0, 0, 0.4);
    z-index: 100;
  }
  .loading-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--dialog-bg, rgba(20, 20, 40, 0.95));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 10px;
    padding: 20px 28px;
    min-width: 280px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .loading-progress-bar {
    height: 6px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 3px;
    overflow: hidden;
  }
  .loading-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, transparent, var(--accent-color, #3b82f6), transparent);
    animation: loading-shimmer 1.5s ease-in-out infinite;
  }
  @keyframes loading-shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  .loading-label {
    color: rgba(255, 255, 255, 0.85);
    font-size: 13px;
    text-align: center;
  }

  .spinner {
    width: 44px;
    height: 44px;
    border: 3px solid rgba(255, 255, 255, 0.2);
    border-top-color: var(--accent-color, #3b82f6);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }



</style>

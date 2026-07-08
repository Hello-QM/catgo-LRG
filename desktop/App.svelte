<script lang="ts">
  import { untrack, tick } from 'svelte'
  import { init_i18n, t, load_i18n_module } from '$lib/i18n/index.svelte'
  import LocaleSwitch from '$lib/i18n/LocaleSwitch.svelte'
  import { Structure, Trajectory } from '$lib'
  import MolstarViewer from '$lib/structure/bio/MolstarViewer.svelte'
  import BioViewerToggle from '$lib/structure/bio/BioViewerToggle.svelte'
  import { PathwayControls } from '$lib/trajectory'
  import type { AnyStructure } from '$lib'
  import { parse_cube_header, cube_atoms_to_molecule } from '$lib/cube'
  import { API_BASE, STATIC_ONLY } from '$lib/api/config'
  import { isMobile } from '$lib/api/transport'
  import MobileWorkspace from '$lib/mobile/MobileWorkspace.svelte'
  import { check_tauri, init_tauri, read_dropped_paths as tauri_read_dropped_paths, pick_structure_paths as tauri_pick_structure_paths, pick_folder_paths as tauri_pick_folder_paths } from '$lib/io/tauri'
  import { decompress_file } from '$lib/io/decompress'
  import { is_trajectory_file, parse_trajectory_data } from '$lib/trajectory/parse'
  import type { TrajectoryType } from '$lib/trajectory'
  import { parse_structure_file, is_structure_file } from '$lib/structure/parse'
  import { detect_bio } from '$lib/structure/bio/detect'
  import '$lib/theme/themes.js'
  import StatusPopout from '$lib/workflow/StatusPopout.svelte'
  import DocViewer from '$lib/viewer/DocViewer.svelte'
  import { apply_theme_to_dom, get_theme_preference } from '$lib/theme'
  import ThemeControl from '$lib/theme/ThemeControl.svelte'
  import { readFile } from '@tauri-apps/plugin-fs'
  import WorkflowView from './WorkflowView.svelte'
  import { get_workflow_slice, iter_workflow_slices, pending_open_structure } from '$lib/workflow/workflow-state.svelte'
  import { TerminalWindow, DopingPTWindow } from '$lib/structure'
  import { open_target_state, resolve_open_target, type OpenTarget } from '$lib/state.svelte'
  import { plan_open } from './lib/open-dispatch'
  import { ChatPane } from '$lib/chat'
  import { import_paper, get_chat_slice } from '$lib/chat/chat-state.svelte'
  import Toast from '$lib/Toast.svelte'
  import DesktopDownloadModal from '$lib/DesktopDownloadModal.svelte'
  import UpdateBanner from '$lib/update/UpdateBanner.svelte'
  import { desktop_download } from '$lib/desktop-download.svelte'
  import { show_toast } from '$lib/toast-state.svelte'
  import TabBar from './TabBar.svelte'
  import Sidebar from './Sidebar.svelte'
  import StructureLibrary from './StructureLibrary.svelte'
  import type { AppTab } from './TabBar.svelte'
  import OptimadeSearchModal from '$lib/structure/OptimadeSearchModal.svelte'
  import OptimadePreviewModal from '$lib/structure/OptimadePreviewModal.svelte'
  import {
    electronic_props_from_mp,
    electronic_props_from_optimade,
    type ElectronicProps,
  } from '$lib/structure/electronic_preview'
  import { extract_provider_details } from '$lib/api/optimade'
  import type { MPSummaryData } from '$lib/api/materials-project'
  import PasteContentModal from '$lib/structure/PasteContentModal.svelte'
  import MonacoEditorPanel from '$lib/structure/MonacoEditorPanel.svelte'
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
    type PaneState, type StructureTabState, type SampleStructure, type LibraryEntry,
    get_pane_label, create_empty_pane, pane_has_content,
    content_to_base64, create_tab_state, auto_name as _auto_name,
    is_chgcar_file, NON_STRUCTURE_EXTS, update_export_format, format_from_ext,
    serialize_structure_content,
  } from './pane-utils'
  // Recursive pane tree (replaces the fixed single/splitH/splitV/quad grid)
  import PaneTree from './PaneTree.svelte'
  import { compute_pane_layout, position_alias } from './pane-layout'
  import {
    type LeafNode, type PresetId,
    leaves, leafCount, findLeafById, findFirstEmptyLeaf,
    escalateForImport, setRatio, create_empty_leaf, structurePane, splitLeaf,
    removeLeaf, setLeafContent, terminalState, type TerminalLeafState,
  } from './pane-tree'
  // Deep-clone structures on assignment into a pane so panes/tabs never alias
  // the same object (module-level samples, library entries, reused DB imports).
  import { clone_structure } from '$lib/structure/clone'
  import { clone_trajectory_for_pane } from '$lib/trajectory/clone'
  import { set_terminal_opener, get_active_terminal, type TerminalHandle } from '$lib/structure/terminal-registry.svelte'
  // SDK-agent visible-terminal bridge: global poller + approval card
  import {
    start_terminal_bridge_poller,
    approval as terminal_approval,
    approval_allow as terminal_approval_allow,
    approval_deny as terminal_approval_deny,
  } from './lib/terminal-bridge-poller.svelte'
  // Extracted tab manager (factory — must be called in component context)
  import { create_tab_manager } from './lib/tab-manager.svelte'
  // Extracted close-all helpers (pure functions)
  import { build_close_all_entries, execute_close_all_saves, close_all_structure_tabs } from './lib/close-all-helper'
  // Extracted keyboard shortcuts (pure function factory)
  import { create_handle_keydown } from './lib/keyboard-shortcuts'
  // Extracted popout manager
  import {
    load_popout_structure, popout_pane as _popout_pane,
    popout_workflow as _popout_workflow,
    popout_terminal_session as _popout_terminal_session,
    open_structure_in_new_window, parse_and_open_structure_window, open_path_in_new_window,
    prewarm_doc_window,
    open_chat_in_new_window,
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
  import {
    cancel_pending_library_removal,
    leaves_for_library_entry,
    prepare_library_entry_removal,
    sync_active_library_entry,
  } from './lib/library-pane-bindings'
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
    on_split_drag,
    type ResizeDepsMin,
  } from './lib/resize-handlers'
  // Extracted dialog sub-components
  import ExportSaveDialog from './components/ExportSaveDialog.svelte'
  import CloseAllModal from './components/CloseAllModal.svelte'
  import DownloadManager from './components/DownloadManager.svelte'

  init_i18n().then(() => {
    load_i18n_module(`app`)
    load_i18n_module(`structure`)
  })

  // ========== Tab Management (extracted to ./lib/tab-manager.svelte.ts) ==========
  const tm = create_tab_manager()
  // Destructure stable function references from the tab manager
  const { tab_states, get_active_ts, create_tab: open_tab, close_tab, request_close_tab, activate_tab, update_tab_label, switch_to_structure } = tm

  // ========== Popout / Sidebar / Pane / Layout / Export / DragDrop / Resize deps ==========
  let is_tauri = $state(false)
  let popout_chat_mode = $state(false)
  // Mobile (iOS/Android Tauri) gate. On mobile we render the purpose-built
  // MobileWorkspace (terminal-first; structure editor + russh SSH terminal +
  // remote files with switchable layouts), NOT the desktop tab/pane UI. The
  // editor still runs backend-free (the probe returns false on mobile) just like
  // the web build. Evaluated once at module load; desktop is unaffected.
  const is_mobile = isMobile()
  // Tab id the popout is mirroring. Parsed from the URL hash
  // (#chat?tab_id=structure-1). Used by ChatPane to filter BroadcastChannel
  // messages and to write incoming contexts into the correct slice.
  let popout_chat_tab_id = $state(`default`)
  let popout_status_mode = $state(false)
  let popout_doping_pt_mode = $state(false)
  let popout_docs_mode = $state(false)
  let is_loading = $state(false)
  let loading_text = $state(``)
  let drag_target_leaf = $state<string | null>(null)
  let is_panel_resizing = $state(false)
  let active_split_id = $state<string | null>(null)

  // Dep objects wired to local $state
  const sidebar_deps: SidebarHandlerDeps = {
    get_active_ts,
    get_active_tab_id: () => tm.active_tab_id,
    get_active_tab_type: () => tm.active_tab_type,
    get_open_target: () => open_target_state.value,
    process_file_content,
    place_single,
    update_tab_label,
    get is_tauri() { return is_tauri },
    set_is_loading: (v) => { is_loading = v },
    set_loading_text: (v) => { loading_text = v },
    tab_states,
    get tabs() { return tm.tabs },
    set_active_tab_id: (id) => { tm.active_tab_id = id },
    open_new_structure_tab,
  }
  const pane_deps: PaneManagerDeps = {
    tab_states,
    update_tab_label,
    export_fs_browse: (dir) => export_fs_browse(dir),
    reset_viewer: (tab_id, leaf_id) => {
      if (!STATIC_ONLY) {
        fetch(`${API_BASE}/view/reset?panel_id=${encodeURIComponent(`${tab_id}:${leaf_id}`)}`, { method: `POST` }).catch(() => {})
      }
    },
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
    close_panel: (tab_id, leaf_id) => close_panel(tab_id, leaf_id),
    load_close_save_projects,
  }
  const drag_deps: DragDropDeps = {
    get_active_ts,
    get_active_tab_type: () => tm.active_tab_type,
    get_active_tab_id: () => tm.active_tab_id,
    process_file_content,
    import_many,
    stream_trajectory: (path, filename) => stream_path_if_large(path, filename),
    stream_trajectory_file: (file) => stream_file_if_large(file),
    get_drag_target_pane: () => drag_target_leaf,
    set_drag_target_pane: (v) => { drag_target_leaf = v },
    set_is_loading: (v) => { is_loading = v },
    get_open_target: () => open_target_state.value,
    open_in_window: (content, filename, reuse) => parse_and_open_structure_window(content, filename, is_tauri, reuse),
    is_tauri,
  }
  const resize_deps_min: ResizeDepsMin = {
    tab_states,
    set_is_panel_resizing: (v) => { is_panel_resizing = v },
  }

  // Thin wrappers that pass deps
  function popout_pane(tab_id: string, leaf_id: string) { return _popout_pane(tab_id, leaf_id, tab_states, is_tauri) }
  function popout_workflow() { return _popout_workflow(is_tauri, close_tab, switch_to_structure) }
  function handle_sidebar_load(content: string | ArrayBuffer, filename: string, file_path?: string, session_id?: string) { _handle_sidebar_load(sidebar_deps, content, filename, file_path, session_id) }
  function handle_sidebar_preview(mode: string, filename: string, file_path: string, session_id: string, content?: string, binary_data?: string, mime_type?: string) { _handle_sidebar_preview(sidebar_deps, mode, filename, file_path, session_id, content, binary_data, mime_type) }
  function handle_sidebar_open_editor(content: string, filename: string, file_path: string, session_id: string) { _handle_sidebar_open_editor(sidebar_deps, content, filename, file_path, session_id) }
  function handle_sidebar_load_trajectory(content: string, filename: string, _meta?: { session_id: string; dir_path: string }) { _handle_sidebar_load_trajectory(sidebar_deps, content, filename, _meta) }
  // Backend-streamed trajectory: never reads the full file into the webview.
  // Builds a minimal indexed TrajectoryType (frames 0..9 + frame_loader) from
  // the backend index and drops it straight into a pane — no parse-all, no
  // base64. See src/lib/trajectory/remote-frame-loader.ts.
  async function handle_load_trajectory_stream(path: string, filename: string, force_local = false) {
    // "New window" setting → open the path in a fresh app window that streams it
    // there (can't serialize a multi-GB trajectory into a structure popout).
    // force_local=true is used by the #openpath handler so the new window itself
    // loads locally instead of recursively opening yet another window.
    const open_t = resolve_open_target(open_target_state.value, false)
    if (!force_local && open_t.kind === `window`) {
      open_path_in_new_window(path, filename, is_tauri)
      return
    }
    let tab_id = tm.active_tab_id
    let ts = tab_states[tab_id]
    if (!ts) return
    let target: string
    const plan = plan_open(ts.root, ts.active_leaf_id, open_t.kind === `window` ? { kind: `split`, mode: `new` } : open_t)
    if (plan.action === `new-tab`) {
      open_tab(`structure`)
      tab_id = tm.active_tab_id
      ts = tab_states[tab_id]
      if (!ts) return
      target = ts.active_leaf_id
    } else if (plan.action === `pane`) {
      ts.root = plan.root
      target = plan.leafId
    } else {
      return
    }
    try {
      const { load_remote_trajectory } = await import(`$lib/trajectory/remote-frame-loader`)
      const trajectory = await load_remote_trajectory(path, filename)
      apply_entry_to_pane(tab_id, ts, target, {
        id: `stream-${filename}-${Date.now()}`,
        filename,
        source_path: path,
        format: `xyz`,
        structure: undefined,
        trajectory,
        is_trajectory: true,
        cube_file: null,
        raw_traj_b64: ``,
        raw_traj_format: `xyz`,
      }, null, path)
    } catch (e) {
      console.error(`Streamed trajectory load failed for ${filename}:`, e)
    }
  }
  // Probe a local path; if it's a large multi-frame trajectory, load it via the
  // backend streamer and return true (caller then skips the in-memory read that
  // would otherwise freeze the webview). Shared by every path-based entry point.
  async function stream_path_if_large(path: string, filename: string): Promise<boolean> {
    try {
      const { probe_streamable_trajectory } = await import(`$lib/trajectory/remote-frame-loader`)
      const probe = await probe_streamable_trajectory(path, filename)
      if (probe?.stream) {
        await handle_load_trajectory_stream(path, filename)
        return true
      }
    } catch (e) {
      console.error(`stream probe failed for ${filename}:`, e)
    }
    return false
  }
  // Web-mode counterpart: a large browser File has no path, so upload it once
  // to the backend cache, then stream. Returns true if streamed.
  async function stream_file_if_large(file: File): Promise<boolean> {
    try {
      const { materialize_file_if_large } = await import(`$lib/trajectory/remote-frame-loader`)
      const local = await materialize_file_if_large(file)
      if (local) {
        await handle_load_trajectory_stream(local, file.name)
        return true
      }
    } catch (e) {
      console.error(`file stream failed for ${file.name}:`, e)
    }
    return false
  }
  function handle_terminal_open_file(file_path: string, filename: string, session_id: string) { return _handle_terminal_open_file(sidebar_deps, file_path, filename, session_id) }
  // Ctrl+click file-open from a terminal *leaf* — derive filename from the path and use
  // the session the click resolved against (threaded through from open_terminal_click,
  // the same session the directory-check used), falling back to the leaf's own session.
  function handle_terminal_leaf_open_file(file_path: string, term: TerminalLeafState, session_id?: string) {
    const name = file_path.split(`/`).pop() || file_path
    return handle_terminal_open_file(file_path, name, session_id || term.session_id || ``)
  }
  // Header label for a terminal leaf: remote host > shell > CWD basename > 'Terminal'.
  function terminalLabel(term: TerminalLeafState): string {
    return term.host ?? term.shell ?? (term.cwd ? term.cwd.split(/[/\\]/).pop() : undefined) ?? `Terminal`
  }
  // Close a terminal leaf: drop it from the tree (TerminalPanel's $effect cleanup kills
  // the PTY on unmount). If it was the sole leaf, reset to a fresh empty structure leaf.
  function close_terminal_leaf(tab_id: string, leaf_id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    if (leafCount(ts.root) <= 1) {
      ts.root = create_empty_leaf()
      ts.active_leaf_id = ts.root.id
    } else {
      ts.root = removeLeaf(ts.root, leaf_id)
      if (!findLeafById(ts.root, ts.active_leaf_id)) ts.active_leaf_id = leaves(ts.root)[0].id
    }
    if (ts.maximized_leaf_id && !findLeafById(ts.root, ts.maximized_leaf_id)) ts.maximized_leaf_id = null
    update_tab_label(tab_id)
  }
  // Toggle maximize/zoom for a leaf: fills the tab workspace, others stay warm at 0 size.
  function toggle_maximize(tab_id: string, leaf_id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.maximized_leaf_id = ts.maximized_leaf_id === leaf_id ? null : leaf_id
    if (ts.maximized_leaf_id) ts.active_leaf_id = leaf_id
  }
  // Switch a leaf's content type between 'structure', 'terminal', and 'empty'.
  // Both 'structure' and 'empty' yield a fresh empty structure leaf; the distinction
  // only matters for the menu label (empty explicitly resets, structure = same).
  let type_menu_leaf_id = $state<string | null>(null)

  function switch_leaf_type(tab_id: string, leaf_id: string, type: 'structure' | 'terminal' | 'empty') {
    const ts = tab_states[tab_id]
    if (!ts) return
    const content = type === 'terminal'
      ? { type: 'terminal' as const, term: { sync_cwd: false } }
      : { type: 'structure' as const, pane: create_empty_pane() }
    ts.root = setLeafContent(ts.root, leaf_id, content)
    ts.active_leaf_id = leaf_id
    if (ts.maximized_leaf_id && !findLeafById(ts.root, ts.maximized_leaf_id)) ts.maximized_leaf_id = null
    type_menu_leaf_id = null
    update_tab_label(tab_id)
  }

  // Close type menu when clicking outside.
  $effect(() => {
    if (type_menu_leaf_id === null) return
    const close = () => { type_menu_leaf_id = null }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  })

  // Register the terminal opener for CatBot: when no terminal is active,
  // this spawns a local terminal leaf in the active tab and waits for its PTY.
  $effect(() => {
    set_terminal_opener(async (): Promise<TerminalHandle | null> => {
      const ts = get_active_ts()
      if (!ts) return null
      const r = escalateForImport(ts.root, ts.active_leaf_id)
      if (!r) return null
      ts.root = setLeafContent(r.root, r.leafId, { type: `terminal`, term: { sync_cwd: false } })
      ts.active_leaf_id = r.leafId
      // Wait (bounded) for the new TerminalPanel to spawn its PTY and register.
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 100))
        const h = get_active_terminal()
        if (h) return h
      }
      return null
    })
    return () => set_terminal_opener(null)
  })

  // Start the SDK-agent terminal bridge poller (per-window). It watches
  // /api/terminal/pending so backend MCP agents can drive the visible terminal.
  $effect(() => start_terminal_bridge_poller())

  // Pop a terminal leaf out into its own window, then drop it from the source tree.
  function popout_terminal_leaf(tab_id: string, leaf_id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    const leaf = findLeafById(ts.root, leaf_id)
    if (!leaf) return
    const term = terminalState(leaf)
    if (!term) return
    _popout_terminal_session(is_tauri, {
      init_session_id: term.session_id,
      init_host: term.host,
      init_username: term.username,
      init_sync_cwd: term.sync_cwd,
    })
    if (leafCount(ts.root) <= 1) {
      ts.root = create_empty_leaf()
      ts.active_leaf_id = ts.root.id
    } else {
      ts.root = removeLeaf(ts.root, leaf_id)
      if (!findLeafById(ts.root, ts.active_leaf_id)) ts.active_leaf_id = leaves(ts.root)[0].id
    }
    update_tab_label(tab_id)
  }
  function open_chat_beside(leaf: LeafNode) {
    const ts = get_active_ts()
    if (!ts) return
    // Reuse a free pane if one exists; otherwise open the chat in its own window
    // rather than cramming a split below the terminal. This covers 1+2 / 2+1
    // layouts (no empty leaf) and the full 4-pane case — and uses a Tauri
    // WebviewWindow, since a bare window.open is swallowed inside the WebView.
    const empty = findFirstEmptyLeaf(ts.root)
    if (!empty) {
      open_chat_in_new_window(is_tauri, tm.active_tab_id)
      return
    }
    const pane = structurePane(empty)
    if (pane) pane.initial_panel = `chat`
    ts.active_leaf_id = empty.id
  }
  function handle_unload(tab_id: string, leaf_id: string) { _handle_unload(pane_deps, tab_id, leaf_id) }
  function close_panel(tab_id: string, leaf_id: string) {
    _close_panel(pane_deps, tab_id, leaf_id)
  }
  function cancel_panel_close(tab_id: string, leaf_id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.close_confirm_leaf_id = null
    cancel_pending_library_removal(ts, leaf_id)
  }
  function cancel_export_dialog() {
    const close_after = exp.close_after
    exp.dialog = null
    exp.close_after = null
    if (!close_after) return
    const ts = tab_states[close_after.tab_id]
    if (ts) cancel_pending_library_removal(ts, close_after.leaf_id)
  }
  function save_and_close_panel(tab_id: string, leaf_id: string) { return _save_and_close_panel(pane_deps, tab_id, leaf_id) }
  function handle_layout_change(new_layout: PresetId) { _handle_layout_change(layout_deps, new_layout) }
  function confirm_layout_change() { _confirm_layout_change(layout_deps) }
  function open_save_dialog(structure: Record<string, unknown>) { _open_save_dialog(export_deps, structure) }
  function open_export_to_hpc(structure: Record<string, unknown>) { _open_export_to_hpc(structure) }
  function open_export_to_file(structure: Record<string, unknown>) { _open_export_to_file(structure) }
  function do_export() { return _do_export(export_deps) }
  function handle_dragover(event: DragEvent) { _handle_dragover(drag_deps, event) }
  function handle_dragleave(event: DragEvent) { _handle_dragleave(drag_deps, event) }
  function handle_drop(event: DragEvent) { return _handle_drop(drag_deps, event) }
  function start_split_resize(e: MouseEvent, split_id: string, dir: `h` | `v`, tab_id: string) {
    on_split_drag(resize_deps_min, e, split_id, dir, tab_id, () => active_split_id = split_id, () => active_split_id = null)
  }

  // ========== Plugin Hub (via Structure.svelte counter prop) ==========

  function open_plugin_hub_on_active_leaf() {
    const ts = get_active_ts()
    if (!ts) return
    const leaf = findLeafById(ts.root, ts.active_leaf_id)
    if (!leaf) return
    const pane = structurePane(leaf)
    if (!pane) return
    // If pane has no structure, load water so Structure mounts
    if (!pane.structure && !pane.trajectory && !pane.cube_file) {
      pane.structure = clone_structure(water as unknown as AnyStructure)
      pane.initial_site_count = (water as any).sites?.length ?? 0
      pane.initial_structure_ref = water as unknown as AnyStructure
    }
    pane.open_plugin_hub = (pane.open_plugin_hub ?? 0) + 1
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
      modal.close_all_error = e instanceof Error ? e.message : t(`app.save_failed`)
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
        } else if (hash.startsWith(`#docs`)) {
          popout_docs_mode = true
          return
        } else if (hash.startsWith(`#workflow`)) {
          open_tab(`workflow`)
        } else if (!STATIC_ONLY && hash.startsWith(`#terminal`)) {
          terminal.parse_hash(hash)
          tm.create_terminal_popout_tab({
            session_id: terminal.init_session_id,
            host: terminal.init_host,
            username: terminal.init_username,
            sync_cwd: terminal.init_sync_cwd,
          })
        } else if (hash.startsWith(`#structure`)) {
          load_popout_structure(hash, get_active_ts, tm.active_tab_id, update_tab_label)
          // Window + Overwrite reuses ONE popout (key catgo-popout-reuse): the
          // opener rewrites that payload key. Two delivery channels, because
          // each can fail alone: the DOM storage event (fires in every OTHER
          // same-origin window; the browser named-window path can't rely on
          // re-navigation — the reuse URL is identical so window.open skips it)
          // and the Tauri event from popout-manager. Whichever fires first
          // consumes the payload via removeItem; the other reads null and
          // no-ops. ONLY the reuse popout itself may register these listeners:
          // consuming the payload from any other #structure window (e.g. a
          // Window+New popout) steals it before the freshly created reuse
          // window boots — it then reads null and shows the landing page.
          const own_key = new URLSearchParams(hash.slice(hash.indexOf(`?`) + 1)).get(`key`)
          if (own_key === `catgo-popout-reuse`) {
            const reload_from_key = (k: string) =>
              load_popout_structure(
                `#structure?key=${encodeURIComponent(k)}`,
                get_active_ts,
                tm.active_tab_id,
                update_tab_label,
              )
            window.addEventListener(`storage`, (e) => {
              if (e.key === `catgo-popout-reuse` && e.newValue) reload_from_key(e.key)
            })
            if (is_tauri) {
              void import(`@tauri-apps/api/event`).then(({ listen }) =>
                listen<{ key: string }>(`catgo-reload-structure`, (e) => {
                  const k = e.payload?.key
                  if (k) reload_from_key(k)
                })
              ).catch(() => {})
            }
          }
        } else if (hash.startsWith(`#openpath`)) {
          // A "New window" file open: stream the path into THIS new window's tree.
          // force_local=true so it loads here instead of opening yet another window.
          const params = new URLSearchParams(hash.slice(hash.indexOf(`?`) + 1))
          const p = params.get(`path`)
          const n = params.get(`name`) || `trajectory`
          if (p) handle_load_trajectory_stream(p, n, true)
        }
      })
      if (popout_chat_mode || popout_status_mode || popout_doping_pt_mode || popout_docs_mode) return
      const on_hash = () => {
        if (window.location.hash.startsWith(`#workflow`)) {
          open_tab(`workflow`)
        } else if (!STATIC_ONLY && window.location.hash.startsWith(`#terminal`)) {
          terminal.parse_hash(window.location.hash)
          tm.create_terminal_popout_tab({
            session_id: terminal.init_session_id,
            host: terminal.init_host,
            username: terminal.init_username,
            sync_cwd: terminal.init_sync_cwd,
          })
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

  // Pre-warm the docs window after startup so the first file-open is near-instant.
  // Runs only in the real main window (not any popout route).
  $effect(() => {
    if (!is_tauri) return
    const h = window.location.hash
    if (h.startsWith(`#docs`) || h.startsWith(`#chat`) || h.startsWith(`#status`) || h.startsWith(`#doping-pt`) || h.startsWith(`#terminal`) || h.startsWith(`#workflow`) || h.startsWith(`#structure`) || h.startsWith(`#openpath`)) return
    const id = setTimeout(() => { void prewarm_doc_window(is_tauri) }, 2500)
    return () => clearTimeout(id)
  })

  /** Open the current structure in the text editor for direct editing. */
  async function open_edit_as_text(structure: Record<string, unknown>) {
    const ts = get_active_ts()
    if (!ts) return
    const active_leaf = findLeafById(ts.root, ts.active_leaf_id)
    if (!active_leaf) return
    const pane = structurePane(active_leaf)
    if (!pane) return
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

    // Track which tab/leaf this editor is tied to for applying changes back
    const target_tab_id = tm.active_tab_id
    const target_leaf_id = ts.active_leaf_id

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
          const leaf = target_ts ? findLeafById(target_ts.root, target_leaf_id) : null
          const p = leaf ? structurePane(leaf) : null
          if (target_ts && p) {
            p.structure = clone_structure(parsed)
            p.initial_structure_ref = parsed
            p.initial_site_count = parsed.sites.length
            p.modified = false
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
    const existing = leaves(ts.root).find(l => structurePane(l)?.mode === `workflow` && structurePane(l)?.workflow_id === workflow_id)
    if (existing) {
      tm.active_tab_id = ts_tab_id
      ts.active_leaf_id = existing.id
      // Signal WorkflowEditor to reload from DB (MCP may have added nodes)
      get_workflow_slice(ts_tab_id).workflow_reload_seq.seq++
      return
    }
    const target = findFirstEmptyLeaf(ts.root) ?? findLeafById(ts.root, ts.active_leaf_id)
    const target_pane = target ? structurePane(target) : null
    if (!target || !target_pane) return
    Object.assign(target_pane, { ...create_empty_pane(), mode: `workflow`, workflow_id, workflow_compact: compact })
    ts.active_leaf_id = target.id
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
    const leaf = leaves(ts.root)[0]
    const pane = leaf ? structurePane(leaf) : null
    if (!pane) return
    // Guard: if create_tab hit the 12-tab limit, active_tab didn't change —
    // don't silently overwrite the existing tab's structure
    if (tab_id === prev_tab_id && pane.structure) {
      console.warn(`[App] Tab limit reached, cannot open structure in new tab`)
      return
    }
    pane.structure = clone_structure(struct)
    pane.initial_structure_ref = struct
    pane.initial_site_count = struct.sites?.length ?? 0
    pane.modified = false
    // Set tab label — use tm.tabs (raw $state), not tabs_with_badges ($derived copy)
    const tab = tm.tabs.find(t => t.id === tab_id)
    if (tab && label) tab.label = label
    tm.update_tab_label(tab_id)
  })

  function get_current_structure(): Record<string, unknown> | null {
    const ts = get_active_ts()
    if (!ts) return null
    const active_leaf = findLeafById(ts.root, ts.active_leaf_id)
    const pane = active_leaf ? structurePane(active_leaf) : null
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
      for (const leaf of leaves(ts.root)) {
        const pane = structurePane(leaf)
        if (!pane) continue
        if (pane.structure && !pane.modified) {
          if (pane.initial_site_count > 0 && pane.structure.sites.length !== pane.initial_site_count) {
            pane.modified = true
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
      const empty = findFirstEmptyLeaf(ts.root)
      const leaf_id = empty ? empty.id : ts.active_leaf_id
      await process_file_content(tm.active_tab_id, text, filename, leaf_id, null, file_path)
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
  let file_input_target_leaf = ``

  async function handle_open_file(tab_id: string, leaf_id: string, shift = false) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.active_leaf_id = leaf_id
    const target = resolve_open_target(open_target_state.value, shift)
    if (is_tauri) {
      try {
        // Pick paths first; divert large trajectories to the backend streamer
        // before any 100s-of-MB read hits the webview.
        const paths = await tauri_pick_structure_paths()
        const read_paths: string[] = []
        for (const pth of paths) {
          const nm = pth.split(/[/\\]/).pop() || `unknown`
          if (await stream_path_if_large(pth, nm)) continue
          read_paths.push(pth)
        }
        if (read_paths.length > 0) {
          const accept = (name: string) => is_structure_file(name) || is_trajectory_file(name) || is_chgcar_file(name)
          const results = await tauri_read_dropped_paths(read_paths, accept)
          if (results.length > 0) {
            if (target.kind === `window` && results.length === 1) {
              await parse_and_open_structure_window(results[0].content as string, results[0].filename, is_tauri, target.mode === `overwrite`)
              return
            }
            const eff = target.kind === `window` ? { kind: `split`, mode: `new` } as OpenTarget : target
            const plan = plan_open(ts.root, leaf_id, eff)
            let dtab = tab_id, dleaf = leaf_id
            if (plan.action === `new-tab`) { const n = open_new_structure_tab(); dtab = n.tab_id; dleaf = n.leaf_id }
            else if (plan.action === `pane`) { ts.root = plan.root; dleaf = plan.leafId }
            await import_many(dtab, results.map(r => ({ content: r.content, filename: r.filename, path: r.path })), dleaf)
          }
        }
      } catch (err) {
        console.error(err)
      }
    } else {
      file_input_target_tab = tab_id
      file_input_target_leaf = leaf_id
      file_input_ref?.click()
    }
  }

  /** Open a folder and import every recognizable structure file inside it. */
  async function handle_open_folder(tab_id: string, leaf_id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.active_leaf_id = leaf_id
    const accept = (name: string) => is_structure_file(name) || is_trajectory_file(name) || is_chgcar_file(name)
    if (is_tauri) {
      try {
        // Path-first so a folder containing a huge trajectory streams instead
        // of reading the whole file into the webview.
        const paths = await tauri_pick_folder_paths(accept)
        const read_paths: string[] = []
        for (const pth of paths) {
          const nm = pth.split(/[/\\]/).pop() || `unknown`
          if (await stream_path_if_large(pth, nm)) continue
          read_paths.push(pth)
        }
        if (read_paths.length > 0) {
          const results = await tauri_read_dropped_paths(read_paths, accept)
          if (results.length > 0) {
            await import_many(tab_id, results.map(r => ({ content: r.content, filename: r.filename, path: r.path })), leaf_id)
          }
        }
      } catch (err) {
        console.error(err)
      }
    } else {
      file_input_target_tab = tab_id
      file_input_target_leaf = leaf_id
      folder_input_ref?.click()
    }
  }

  async function handle_file_input(event: Event) {
    const input = event.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    if (files.length === 0) return
    try {
      const to_import: File[] = []
      for (const f of files) {
        if (await stream_file_if_large(f)) continue
        to_import.push(f)
      }
      if (to_import.length > 0) {
        const target = resolve_open_target(open_target_state.value, false)
        const ts = tab_states[file_input_target_tab]
        let dtab = file_input_target_tab, dleaf = file_input_target_leaf
        if (ts) {
          const eff = target.kind === `window` ? { kind: `split`, mode: `new` } as OpenTarget : target
          const plan = plan_open(ts.root, file_input_target_leaf, eff)
          if (plan.action === `new-tab`) { const n = open_new_structure_tab(); dtab = n.tab_id; dleaf = n.leaf_id }
          else if (plan.action === `pane`) { ts.root = plan.root; dleaf = plan.leafId }
        }
        await import_many(
          dtab,
          to_import.map(f => ({ file: f, filename: f.name, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || null })),
          dleaf,
        )
      }
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
      const to_import: File[] = []
      for (const f of files) {
        if (await stream_file_if_large(f)) continue
        to_import.push(f)
      }
      if (to_import.length > 0) {
        await import_many(
          file_input_target_tab,
          to_import.map(f => ({ file: f, filename: f.name, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || null })),
          file_input_target_leaf,
        )
      }
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

    const leaf = findLeafById(ts.root, modal.import_target_leaf)
    if (!leaf) return
    // Mutate the pane in-place so Svelte 5's deep $state proxy tracks the change
    const pane = structurePane(leaf)
    if (!pane) return
    pane.structure = clone_structure(imported as AnyStructure)
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
      window.dispatchEvent(new Event(`resize`))
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

  function handle_optimade_preview(
    optimade_struct: any,
    structure: PymatgenStructure,
    mp_summary: MPSummaryData | null = null,
  ) {
    modal.db_preview_pymatgen = structure
    const attrs = optimade_struct?.attributes ?? {}
    const provider = attrs.database_provider ?? `OPTIMADE`
    const formula =
      attrs.chemical_formula_descriptive ?? attrs.chemical_formula_reduced ?? `Unknown formula`
    const sites =
      attrs.n_sites ??
      (Array.isArray(attrs.cartesian_site_positions) ? attrs.cartesian_site_positions.length : 0)

    // Build electronic-structure props: prefer the MP REST summary (rich
    // surface — cbm/vbm/efermi/has_props/ordering); otherwise extract whatever
    // the OPTIMADE adapter exposed under `_<provider>_*`.
    let elec: ElectronicProps
    if (mp_summary) {
      elec = electronic_props_from_mp(mp_summary)
    } else {
      const pd = extract_provider_details(attrs as Record<string, unknown>)
      elec = electronic_props_from_optimade(pd)
    }
    // Stash on the pending pymatgen so the metadata rides through Confirm
    // into the loaded structure (consumed by StructureInfoPane / overlays).
    ;(structure as AnyStructure)._electronic_props = elec

    modal.db_preview_title = t(`app.preview_structure_import`)
    modal.db_preview_formula = formula
    modal.db_preview_lattice = compute_lattice_params(attrs.lattice_vectors)
    modal.db_preview_details = [
      { label: t(`app.field_id`), value: String(optimade_struct?.id ?? ``), mono: true },
      { label: t(`app.field_formula`), value: formula },
      { label: t(`app.field_sites`), value: String(sites) },
      { label: t(`app.field_database`), value: provider },
    ]
    modal.db_preview_electronic = elec
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
    if (cid) rows.push({ label: t(`app.field_cid`), value: String(cid), mono: true })
    if (name) rows.push({ label: t(`app.field_name`), value: name })
    if (formula) rows.push({ label: t(`app.field_formula`), value: formula })
    if (n_atoms) rows.push({ label: t(`app.field_atoms`), value: String(n_atoms) })
    if (typeof weight === `number`)
      rows.push({ label: t(`app.field_weight`), value: `${weight.toFixed(2)} g/mol` })
    rows.push({ label: t(`app.field_database`), value: `PubChem` })

    modal.db_preview_title = t(`app.preview_compound_import`)
    modal.db_preview_formula = formula
    modal.db_preview_lattice = null
    modal.db_preview_details = rows
    modal.db_preview_electronic = null // PubChem is molecular — no band/Fermi
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
    modal.db_preview_electronic = null
    modal.db_preview_formula = ``
    modal.db_preview_lattice = null
  }

  // Result of parsing one file. 'skip' = ignore silently; 'editor' = not a
  // structure, open raw text in the editor; 'entry' = a library entry payload.
  type IngestOutcome =
    | { kind: `entry`; entry: Omit<LibraryEntry, `id`> }
    | { kind: `skip` }
    | { kind: `editor`; text: string }

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
          const { chgcar_to_cube } = await import(`$lib/electronic/chgdiff-wasm`)
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
          // CHGCAR-family is always periodic — derive the cell from the cube
          // grid so the slab renders with its unit-cell box + PBC bonds.
          const molecule = cube_atoms_to_molecule(parse_cube_header(cube_text), { periodic: true })
          if (molecule.sites.length > 0) structure = { ...molecule, _aligned: true } as AnyStructure
        } catch (err) {
          console.error(`Failed to parse converted cube atoms:`, err)
        }
        const cube_file = new File([new Blob([cube_text], { type: `chemical/x-cube` })], cube_filename)
        return { kind: `entry`, entry: { filename, source_path: null, format: `cube`, structure, trajectory: undefined, is_trajectory: false, cube_file } }
      } catch (err) {
        console.error(`Failed to convert CHGCAR to cube:`, err)
        return { kind: `skip` }
      }
    }

    if (/\.(cube|cub)$/i.test(filename)) {
      let structure: AnyStructure | undefined
      // Molecular Gaussian cubes are non-periodic; VASP-origin cubes
      // (CHGCAR_diff.cube / *.vasp.cube) carry a real cell — keep it.
      const cube_is_vasp = /chgcar|chgdiff|diffchg|aeccar|locpot|elfcar|parchg|\.vasp/i.test(filename)
      try {
        const molecule = cube_atoms_to_molecule(parse_cube_header(text), { periodic: cube_is_vasp })
        if (molecule.sites.length > 0) structure = { ...molecule, _aligned: true } as AnyStructure
      } catch (err) {
        console.error(`Failed to parse cube file atoms:`, err)
      }
      const cube_file = new File([new Blob([text], { type: `chemical/x-cube` })], filename)
      return { kind: `entry`, entry: { filename, source_path: null, format: `cube`, structure, trajectory: undefined, is_trajectory: false, cube_file } }
    }

    // Skip non-structure files (images, PDFs, spreadsheets, media, archives, binaries)
    if (NON_STRUCTURE_EXTS.test(filename)) {
      console.warn(`[ingest_one] Skipping non-structure file: ${filename}`)
      return { kind: `skip` }
    }

    if (is_trajectory_file(filename, text)) {
      const trajectory = await parse_trajectory_data(content, filename)
      return {
        kind: `entry`,
        entry: {
          filename, source_path: null, format: ext, structure: undefined, trajectory,
          is_trajectory: true, cube_file: null,
          raw_traj_b64: content_to_base64(content),
          raw_traj_format: filename.split(`.`).pop()?.toLowerCase() || ``,
        },
      }
    }

    // Biological macromolecule (protein / nucleic acid) → render in Mol*.
    // Bio files bypass pymatgen/ferrox entirely: handing Mol* the raw text
    // preserves residue/chain/secondary-structure and skips the (expensive,
    // metadata-lossy) native parse of large proteins.
    const bio = detect_bio(text, filename)
    if (bio.isBio && bio.format) {
      return {
        kind: `entry`,
        entry: {
          filename, source_path: null, format: ext, structure: undefined,
          trajectory: undefined, is_trajectory: false, cube_file: null,
          viewer_kind: `molstar`, bio_raw_content: text, bio_format: bio.format,
        },
      }
    }

    const parsed = parse_structure_file(text, filename)
    if (parsed?.sites?.length) {
      return { kind: `entry`, entry: { filename, source_path: null, format: ext, structure: parsed, trajectory: undefined, is_trajectory: false, cube_file: null } }
    }
    // Can't parse as structure — fall back to the text editor
    return { kind: `editor`, text }
  }

  /** Write a library entry's parsed content into a pane (in-place — Svelte 5 deep proxy). */
  function apply_entry_to_pane(
    tab_id: string,
    ts: StructureTabState,
    leaf_id: string,
    e: LibraryEntry,
    remote_origin: { session_id: string; file_path: string } | null = null,
    local_file_path: string | null = null,
  ) {
    const leaf = findLeafById(ts.root, leaf_id)
    if (!leaf) return
    const p = structurePane(leaf)
    if (!p) return
    if (e.viewer_kind === `molstar`) {
      // Bio file → Mol* pane; no parsed structure, raw text carried below.
      p.is_trajectory_mode = false
      p.trajectory = null
      p.structure = undefined
      p.cube_file = null
      p.initial_site_count = 0
      p.initial_structure_ref = null
    } else if (e.cube_file) {
      p.structure = clone_structure(e.structure)
      p.initial_site_count = e.structure?.sites?.length ?? 0
      p.initial_structure_ref = e.structure ?? null
      p.cube_file = e.cube_file
      p.is_trajectory_mode = false
      p.trajectory = null
    } else if (e.is_trajectory) {
      p.is_trajectory_mode = true
      p.structure = undefined
      p.trajectory = clone_trajectory_for_pane(e.trajectory as TrajectoryType)
      p.initial_site_count = 0
      p.initial_structure_ref = null
      p.cube_file = null
      p.raw_traj_b64 = e.raw_traj_b64 ?? ``
      p.raw_traj_format = e.raw_traj_format ?? ``
    } else {
      p.is_trajectory_mode = false
      p.trajectory = null
      p.structure = clone_structure(e.structure)
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
    p.library_entry_id = ts.library.some((entry) => entry.id === e.id) ? e.id : null
    p.viewer_kind = e.viewer_kind ?? `native`
    p.bio_raw_content = e.bio_raw_content
    p.bio_format = e.bio_format
    ts.active_leaf_id = leaf_id
    update_tab_label(tab_id)
  }

  /**
   * Flip a pane between Mol* and the native viewer (manual override).
   * Works for ANY loaded structure, not just auto-detected bio files: when a
   * pane has no bio raw text yet (a crystal, a built/fetched structure), we
   * serialize its current structure to a format Mol* reads (CIF when periodic
   * so the cell survives, else XYZ) and hand that to Mol*.
   */
  async function toggle_pane_viewer(p: PaneState) {
    if (p.viewer_kind === `molstar`) {
      // → native: parse the raw text on demand (lazy; only when overridden).
      if (p.bio_raw_content) {
        const parsed = parse_structure_file(p.bio_raw_content, p.source_filename || `bio`)
        if (parsed?.sites?.length) {
          p.structure = parsed
          p.initial_site_count = parsed.sites.length
          p.initial_structure_ref = parsed
        }
      }
      p.viewer_kind = `native`
    } else {
      // → Mol*: ensure we have raw text Mol* can parse.
      if (!p.bio_raw_content && p.structure?.sites?.length) {
        const { structure_to_cif_str, structure_to_xyz_str } = await import(`$lib/structure/export`)
        const periodic = !!(p.structure as { lattice?: { matrix?: unknown } })?.lattice?.matrix
        p.bio_raw_content = periodic
          ? structure_to_cif_str(p.structure)
          : structure_to_xyz_str(p.structure)
        p.bio_format = periodic ? `mmcif` : `xyz`
      }
      if (p.bio_raw_content) p.viewer_kind = `molstar`
    }
  }

  /** Open a fresh structure tab and report its id + initial empty leaf. */
  function open_new_structure_tab(): { tab_id: string; leaf_id: string } {
    open_tab(`structure`)
    const tid = tm.active_tab_id
    const nts = tab_states[tid]
    return { tab_id: tid, leaf_id: nts?.active_leaf_id ?? `` }
  }

  /**
   * Place one file's content according to the resolved open target (kind+mode).
   * Window → popout (reuse on overwrite); new-tab → fresh tab; pane → the leaf
   * chosen by plan_open (escalate-split for new, active leaf for overwrite).
   * ArrayBuffer content can't be serialized into a popout, so window falls back
   * to a split pane.
   */
  async function place_single(
    tab_id: string,
    leaf_id: string,
    content: string | ArrayBuffer,
    filename: string,
    target: OpenTarget,
    origin: { session_id: string; file_path: string } | null = null,
    local_path: string | null = null,
  ) {
    if (target.kind === `window` && typeof content === `string`) {
      await parse_and_open_structure_window(content, filename, is_tauri, target.mode === `overwrite`)
      return
    }
    const ts = tab_states[tab_id]
    if (!ts) return
    const eff = target.kind === `window` ? { kind: `split`, mode: `new` } as OpenTarget : target
    const plan = plan_open(ts.root, leaf_id, eff)
    if (plan.action === `new-tab`) {
      const n = open_new_structure_tab()
      await process_file_content(n.tab_id, content, filename, n.leaf_id, origin, local_path, true)
      return
    }
    if (plan.action === `pane`) {
      ts.root = plan.root
      ts.active_leaf_id = plan.leafId
      await process_file_content(tab_id, content, filename, plan.leafId, origin, local_path, true)
    }
  }

  async function process_file_content(tab_id: string, content: string | ArrayBuffer, filename: string, leaf_id: string, remote_origin?: { session_id: string; file_path: string } | null, local_file_path?: string | null, no_escalate = false) {
    const ts = tab_states[tab_id]
    if (!ts) return
    let target: string
    if (no_escalate) {
      // Caller (place_single) already chose the exact destination leaf.
      target = leaf_id
    } else {
      const r = escalateForImport(ts.root, leaf_id)
      if (!r) {
        // All panes full — open a new tab and load there
        open_tab(`structure`)
        const new_ts = tab_states[tm.active_tab_id]
        if (!new_ts) return
        return process_file_content(tm.active_tab_id, content, filename, new_ts.active_leaf_id, remote_origin, local_file_path)
      }
      ts.root = r.root
      target = r.leafId
    }
    const outcome = await ingest_one(content, filename)
    if (outcome.kind === `skip`) return
    if (outcome.kind === `editor`) {
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
    leaf_id: string,
  ) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.active_leaf_id = leaf_id
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
          if (outcome.kind !== `entry`) { failures++; continue }
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
    const bound = leaves_for_library_entry(ts, id)
    if (bound.length > 1) {
      console.warn(`[structure-library] entry ${id} is bound to multiple panes; refusing to guess`)
      return
    }
    if (bound.length === 1) {
      ts.active_leaf_id = bound[0].id
      ts.active_library_id = id
      tick().then(() => window.dispatchEvent(new Event(`resize`)))
      return
    }
    apply_entry_to_pane(tab_id, ts, ts.active_leaf_id, entry)
    ts.active_library_id = id
    tick().then(() => window.dispatchEvent(new Event(`resize`)))
  }

  /** Remove one exact entry instance and close only the pane bound to it. */
  function remove_library_entry(tab_id: string, id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    const request = prepare_library_entry_removal(ts, id)
    if (request.kind === `ambiguous`) {
      console.warn(`[structure-library] entry ${id} is bound to multiple panes; removal cancelled`)
      return
    }
    if (request.kind === `close`) handle_unload(tab_id, request.leaf_id)
  }

  /** Empty the library list (does not clear what's currently shown in the pane). */
  function clear_library(tab_id: string) {
    const ts = tab_states[tab_id]
    if (!ts) return
    ts.library = []
    ts.active_library_id = null
  }

  function create_on_file_drop(tab_id: string, leaf_id: string) {
    return async (content: string | ArrayBuffer, filename: string) => {
      is_loading = true
      try {
        await process_file_content(tab_id, content, filename, leaf_id)
      } catch (err) {
        console.error(err)
      } finally {
        is_loading = false
      }
    }
  }

  function create_on_file_load(tab_id: string, leaf_id: string) {
    return (data: { structure?: AnyStructure; filename?: string; trajectory?: unknown }) => {
      const ts = tab_states[tab_id]
      if (!ts) return
      const r = escalateForImport(ts.root, leaf_id)
      if (!r) {
        // All panes full — open a new tab
        open_tab(`structure`)
        const new_ts = tab_states[tm.active_tab_id]
        if (!new_ts) return
        const new_leaf = leaves(new_ts.root)[0]
        const p = new_leaf ? structurePane(new_leaf) : null
        if (data.structure && p) {
          p.structure = clone_structure(data.structure)
          p.is_trajectory_mode = false
          p.trajectory = null
          p.initial_site_count = data.structure.sites?.length ?? 0
          p.initial_structure_ref = data.structure
          p.modified = false
          new_ts.active_leaf_id = new_leaf.id
          update_tab_label(tm.active_tab_id)
        }
        return
      }
      ts.root = r.root
      const target_id = r.leafId
      const target_leaf = findLeafById(ts.root, target_id)
      if (!target_leaf) return
      const p = structurePane(target_leaf)
      if (!p) return
      if (data.structure) {
        p.structure = clone_structure(data.structure)
        p.is_trajectory_mode = false
        p.trajectory = null
        p.initial_site_count = data.structure.sites?.length ?? 0
        p.initial_structure_ref = data.structure
        p.modified = false
      }
      if (data.trajectory) {
        const traj = data.trajectory as { frames?: unknown[]; metadata?: { source_format?: string } }
        if (traj.metadata?.source_format === `single_structure` && traj.frames?.length === 1) {
          const frame = traj.frames[0] as { structure?: AnyStructure }
          if (frame?.structure) {
            p.structure = clone_structure(frame.structure)
            p.is_trajectory_mode = false
            p.trajectory = null
            p.initial_site_count = frame.structure.sites?.length ?? 0
            p.initial_structure_ref = frame.structure
            p.modified = false
            p.selected_sites = []
            p.current_step_idx = 0
            ts.active_leaf_id = target_id
            update_tab_label(tab_id)
            return
          }
        }
        p.trajectory = clone_trajectory_for_pane(data.trajectory as TrajectoryType)
        p.is_trajectory_mode = true
        p.structure = undefined
        p.initial_site_count = 0
        p.modified = false
      }
      p.selected_sites = []
      p.current_step_idx = 0
      ts.active_leaf_id = target_id
      update_tab_label(tab_id)
    }
  }

  // Open a terminal as a pane-tree LEAF (replaces the old Structure side-panel
  // terminal). Escalates the active leaf into a fresh pane (split up to CAP), or
  // opens a new tab when all panes are full, then converts that leaf to a
  // terminal. `term` carries an optional remote SSH session (HPC Connect →
  // Terminal); omitted = a local shell.
  function open_terminal_leaf(tab_id: string, leaf_id: string, term?: Partial<TerminalLeafState>) {
    const ts = tab_states[tab_id]
    if (!ts) return
    const t: TerminalLeafState = { sync_cwd: false, ...term }
    const r = escalateForImport(ts.root, leaf_id)
    if (!r) {
      // All panes full — open a new tab and convert its first leaf.
      open_tab(`structure`)
      const new_ts = tab_states[tm.active_tab_id]
      if (!new_ts) return
      const new_leaf = leaves(new_ts.root)[0]
      if (!new_leaf) return
      new_ts.root = setLeafContent(new_ts.root, new_leaf.id, { type: `terminal`, term: t })
      new_ts.active_leaf_id = new_leaf.id
      update_tab_label(tm.active_tab_id)
      return
    }
    ts.root = setLeafContent(r.root, r.leafId, { type: `terminal`, term: t })
    ts.active_leaf_id = r.leafId
    update_tab_label(tab_id)
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

            // Large on-disk trajectories: stream frame-by-frame from the
            // backend instead of reading the whole 100s-of-MB file into the
            // webview (which freezes it).
            const read_paths: string[] = []
            for (const pth of other_paths) {
              const nm = pth.split(/[/\\]/).pop() || `trajectory.xyz`
              if (await stream_path_if_large(pth, nm)) continue
              read_paths.push(pth)
            }
            if (read_paths.length === 0) return

            const ts = get_active_ts()
            if (!ts) return
            is_loading = true
            try {
              const accept = (name: string) => is_structure_file(name) || is_trajectory_file(name) || is_chgcar_file(name)
              const files = await tauri_read_dropped_paths(read_paths, accept)
              const empty = findFirstEmptyLeaf(ts.root)
              const leaf_id = empty ? empty.id : ts.active_leaf_id
              if (files.length > 0) {
                await import_many(tm.active_tab_id, files.map(f => ({ content: f.content, filename: f.filename, path: f.path })), leaf_id)
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
    if (STATIC_ONLY || popout_chat_mode || popout_status_mode || popout_doping_pt_mode || popout_docs_mode) return
    const es = new EventSource(`${API_BASE}/view/subscribe?panel_id=default`)

    function inject_into_external(struct: AnyStructure | null | undefined): boolean {
      if (!struct) return false
      const ts = tab_states[`default`]
      const first = ts ? leaves(ts.root)[0] : null
      const pane = first ? structurePane(first) : null
      if (!ts || !pane) return false
      pane.structure = clone_structure(struct)
      update_tab_label(`default`)
      return true
    }

    // Dedupe the "no External tab → open one" toast: a `snapshot` replays on
    // every SSE (re)connect, so without this a network blip would re-toast the
    // same pending push. Keyed by a cheap structure signature.
    let last_toast_sig = ``
    function _struct_sig(struct: AnyStructure): string {
      const sites = (struct.sites ?? []) as Array<{ species?: unknown }>
      const els = sites.map((s) => Array.isArray(s.species) ? (s.species[0] as { element?: string })?.element : s.species).join(``)
      return `${sites.length}|${els}|${JSON.stringify((struct as { lattice?: { matrix?: unknown } }).lattice?.matrix ?? ``)}`
    }
    // Surface a structure pushed to panel "default" when no External tab is open
    // to receive it (e.g. `catgo view` just launched a fresh window — the push
    // landed before any External tab existed). A 12s toast offers a one-click
    // open that seeds the EXACT pushed structure (bypassing the catch-up fetch,
    // which can race sample-card / heartbeat overwrites of the panel cache).
    function toast_external_push(struct: AnyStructure | null | undefined): void {
      if (!struct) return
      const sig = _struct_sig(struct)
      if (sig === last_toast_sig) return
      last_toast_sig = sig
      const n = struct.sites?.length ?? 0
      const elems: Record<string, number> = {}
      for (const s of (struct.sites ?? [])) {
        const el = Array.isArray(s.species) ? s.species[0]?.element : s.species
        if (el) elems[el] = (elems[el] || 0) + 1
      }
      const formula = Object.entries(elems).map(([el, k]) => k > 1 ? `${el}${k}` : el).join(``) || `?`
      const captured = struct
      show_toast({
        message: t(`app.external_structure_pushed`, {
          formula,
          count: String(n),
          s: n === 1 ? `` : `s`,
        }),
        variant: `info`,
        action: { label: t(`app.open_external_viewer`), onclick: () => open_external_tab(captured) },
        duration: 12000,
      })
    }

    es.addEventListener(`snapshot`, (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        // Replay-on-connect: inject if an External tab is already open;
        // otherwise (fresh `catgo view` window) fall back to the toast so the
        // push isn't silently lost. Deduped so reconnects don't re-bug.
        if (!inject_into_external(data.structure)) toast_external_push(data.structure)
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
        toast_external_push(struct)
      } catch (err) {
        console.warn(`[CatGo] global SSE structure parse error:`, err)
      }
    })

    function inject_trajectory_into_external(traj: TrajectoryType, raw: string, filename: string): boolean {
      const ts = tab_states[`default`]
      const first = ts ? leaves(ts.root)[0] : null
      const pane = first ? structurePane(first) : null
      if (!ts || !pane) return false
      pane.trajectory = clone_trajectory_for_pane(traj)
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
          message: t(`app.external_trajectory_pushed`, {
            name: filename || t(`app.unnamed`),
            count: String(n_frames),
          }),
          variant: `info`,
          action: {
            label: t(`app.open_external_viewer`),
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
    const tab_id = tm.active_tab_id
    const ts = tab_states[tab_id]
    const id = ts ? `${tab_id}:${ts.active_leaf_id}` : tab_id
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
      const first = ts ? leaves(ts.root)[0] : null
      const pane = first ? structurePane(first) : null
      if (pane) {
        pane.structure = clone_structure(struct)
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
        const first = ts ? leaves(ts.root)[0] : null
        const pane = first ? structurePane(first) : null
        if (pane) {
          pane.structure = clone_structure(cached)
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
{:else if popout_docs_mode}
<DocViewer />
{:else if is_mobile}
<MobileWorkspace />
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
    title={sidebar.collapsed ? t(`app.show_sidebar`) : t(`app.hide_sidebar`)}
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
    on_load_trajectory_stream={handle_load_trajectory_stream}
    on_open_workflow={handle_sidebar_open_workflow}
    on_save_structure={get_current_structure}
    on_save_workflow={() => {
      const ts = get_active_ts()
      if (!ts) return null
      const active_leaf = findLeafById(ts.root, ts.active_leaf_id)
      const pane = active_leaf ? structurePane(active_leaf) : null
      return pane?.mode === `workflow` ? (pane.workflow_id ?? null) : null
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

    {#if tab.type === `structure` || tab.type === `terminal`}
      {@const ts = tab_states[tab.id]}
      {#if ts}
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
        <PaneTree
          root={ts.root}
          multi={leafCount(ts.root) > 1}
          active_leaf_id={ts.active_leaf_id}
          drag_target_leaf={tab.id === tm.active_tab_id ? drag_target_leaf : null}
          close_confirm_leaf_id={ts.close_confirm_leaf_id}
          maximized_leaf_id={ts.maximized_leaf_id}
          {active_split_id}
          on_activate={(id) => { ts.active_leaf_id = id; sync_active_library_entry(ts) }}
          on_split_mousedown={(e, sid, dir) => start_split_resize(e, sid, dir, tab.id)}
          on_split_dblclick={(sid) => { ts.root = setRatio(ts.root, sid, 0.5) }}
          {leaf_body}
          {terminal_body}
          {header}
          {banner}
        />

        {#snippet header(leaf: LeafNode)}
          {@const pane = leaf.content.type === `structure` ? leaf.content.pane : undefined}
          {@const term = leaf.content.type === `terminal` ? leaf.content.term : undefined}
          {#if term}
            <span class="panel-label">{terminalLabel(term)}</span>
            <!-- Directory Sync / font / shell now live inside TerminalWindow (per tab). -->
            <button
              class="panel-popout-btn"
              onclick={(e) => { e.stopPropagation(); popout_terminal_leaf(tab.id, leaf.id) }}
              title={t(`app.open_in_new_window`)}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </button>
            <div class="panel-type-container">
              <button
                class="panel-type-btn"
                onclick={(e) => { e.stopPropagation(); type_menu_leaf_id = type_menu_leaf_id === leaf.id ? null : leaf.id }}
                title={t(`app.change_pane_type`)}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
              </button>
              {#if type_menu_leaf_id === leaf.id}
                <div class="panel-type-menu" role="menu">
                  <button role="menuitem" onclick={(e) => { e.stopPropagation(); switch_leaf_type(tab.id, leaf.id, 'structure') }}>{t(`app.type_structure`)}</button>
                  <button role="menuitem" onclick={(e) => { e.stopPropagation(); switch_leaf_type(tab.id, leaf.id, 'terminal') }}>{t(`app.type_terminal`)}</button>
                  <button role="menuitem" onclick={(e) => { e.stopPropagation(); switch_leaf_type(tab.id, leaf.id, 'empty') }}>{t(`app.type_empty`)}</button>
                </div>
              {/if}
            </div>
            <button
              class="panel-maximize-btn"
              onclick={(e) => { e.stopPropagation(); toggle_maximize(tab.id, leaf.id) }}
              title={ts.maximized_leaf_id === leaf.id ? t(`app.restore_pane`) : t(`app.maximize_pane`)}
            >
              {#if ts.maximized_leaf_id === leaf.id}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 9H5V5M15 9h4V5M9 15H5v4M15 15h4v4"/></svg>
              {:else}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/></svg>
              {/if}
            </button>
            <button
              class="panel-close-btn"
              onclick={(e) => { e.stopPropagation(); close_terminal_leaf(tab.id, leaf.id) }}
              title={t(`app.close_panel`)}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          {:else if pane}
            {#if pane_has_content(pane)}
              <span class="panel-dot"></span>
            {/if}
            <span class="panel-label">{get_pane_label(pane)}</span>
            {#if pane_has_content(pane)}
              <button
                class="panel-popout-btn"
                onclick={(e) => { e.stopPropagation(); popout_pane(tab.id, leaf.id) }}
                title={t(`app.open_in_new_window`)}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </button>
            {/if}
            <div class="panel-type-container">
              <button
                class="panel-type-btn"
                onclick={(e) => { e.stopPropagation(); type_menu_leaf_id = type_menu_leaf_id === leaf.id ? null : leaf.id }}
                title={t(`app.change_pane_type`)}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
              </button>
              {#if type_menu_leaf_id === leaf.id}
                <div class="panel-type-menu" role="menu">
                  <button role="menuitem" onclick={(e) => { e.stopPropagation(); switch_leaf_type(tab.id, leaf.id, 'structure') }}>{t(`app.type_structure`)}</button>
                  <button role="menuitem" onclick={(e) => { e.stopPropagation(); switch_leaf_type(tab.id, leaf.id, 'terminal') }}>{t(`app.type_terminal`)}</button>
                  <button role="menuitem" onclick={(e) => { e.stopPropagation(); switch_leaf_type(tab.id, leaf.id, 'empty') }}>{t(`app.type_empty`)}</button>
                </div>
              {/if}
            </div>
            <button
              class="panel-maximize-btn"
              onclick={(e) => { e.stopPropagation(); toggle_maximize(tab.id, leaf.id) }}
              title={ts.maximized_leaf_id === leaf.id ? t(`app.restore_pane`) : t(`app.maximize_pane`)}
            >
              {#if ts.maximized_leaf_id === leaf.id}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 9H5V5M15 9h4V5M9 15H5v4M15 15h4v4"/></svg>
              {:else}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/></svg>
              {/if}
            </button>
            <button
              class="panel-close-btn"
              onclick={(e) => { e.stopPropagation(); handle_unload(tab.id, leaf.id) }}
              title={t(`app.close_panel`)}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          {/if}
        {/snippet}

        {#snippet banner(leaf: LeafNode)}
          {@const pane = leaf.content.type === `structure` ? leaf.content.pane : undefined}
          {#if pane && ts.close_confirm_leaf_id === leaf.id}
            <div class="panel-close-banner">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 9v2m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
              </svg>
              {#if pane.mode === `workflow`}
                <span>{t(`app.workflow_will_be_closed`)}</span>
                <button class="banner-btn cancel" onclick={(e) => { e.stopPropagation(); cancel_panel_close(tab.id, leaf.id) }}>{t(`common.cancel`)}</button>
                <button class="banner-btn close" onclick={(e) => { e.stopPropagation(); close_panel(tab.id, leaf.id) }}>{t(`common.close`)}</button>
              {:else}
                <span>{t(`common.save_before_close`)}</span>
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <select class="banner-select target-select" bind:value={exp.close_save_target} onclick={(e) => e.stopPropagation()}>
                  <option value="local">{t(`app.local`)}</option>
                  {#if pane.remote_origin?.session_id}
                    <option value="hpc">{t(`app.hpc`)}</option>
                  {/if}
                  <option value="project">{t(`app.catgo_db`)}</option>
                </select>
                {#if exp.close_save_target === `project` && exp.close_save_projects.length > 0}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <select class="banner-select" bind:value={exp.close_save_project_id} onclick={(e) => e.stopPropagation()}>
                    {#snippet banner_select_options(projects: ProjectSummary[], depth: number)}
                      {#each projects as p (p.id)}
                        <option value={p.id}>{`  `.repeat(depth)}{p.name}</option>
                        {#if save_project_children[p.id]?.length}
                          {@render banner_select_options(save_project_children[p.id], depth + 1)}
                        {/if}
                      {/each}
                    {/snippet}
                    {@render banner_select_options(save_project_roots, 0)}
                  </select>
                {/if}
                {#if exp.close_save_target === `hpc`}
                  <span class="banner-path" title={pane.remote_origin?.file_path}>{pane.remote_origin?.file_path?.split(/[/\\]/).pop()}</span>
                {/if}
                <button class="banner-btn save" disabled={exp.close_saving} onclick={(e) => { e.stopPropagation(); save_and_close_panel(tab.id, leaf.id) }}>
                  {exp.close_saving ? t(`common.saving`) : t(`common.save_and_close`)}
                </button>
                <button class="banner-btn close" onclick={(e) => { e.stopPropagation(); close_panel(tab.id, leaf.id) }}>{t(`common.close`)}</button>
                <button class="banner-btn cancel" onclick={(e) => { e.stopPropagation(); cancel_panel_close(tab.id, leaf.id) }}>{t(`common.cancel`)}</button>
              {/if}
            </div>
          {/if}
        {/snippet}

        {#snippet leaf_body(leaf: LeafNode)}
          {@const pane = leaf.content.type === `structure` ? leaf.content.pane : undefined}
          {@const pane_layout = compute_pane_layout(ts.root, ts.maximized_leaf_id)}
          {@const pane_box = pane_layout.leaves.find((box) => box.leaf.id === leaf.id)}
          {@const visible_panes = pane_layout.leaves.filter((box) => box.rect.w > 0 && box.rect.h > 0)}
          {@const pane_number = pane_layout.leaves.findIndex((box) => box.leaf.id === leaf.id) + 1}
          {@const viewer_id = `${tab.id}:${leaf.id}`}
          {@const pane_position = pane_box ? position_alias(pane_box.rect, visible_panes.length) : `hidden`}
          {#if pane}
          {#if pane.mode === `workflow`}
            <WorkflowView
              initial_workflow_id={pane.workflow_id}
              compact={pane.workflow_compact ?? false}
              tab_id={tab.id}
              onclose={() => { Object.assign(pane, create_empty_pane()); update_tab_label(tab.id) }}
              onchange={() => { pane.modified = true }}
              ondbchange={() => { sidebar.refresh_counter++ }}
            />
          {:else if pane.is_trajectory_mode && pane.trajectory}
            <Trajectory
              trajectory={pane.trajectory as any}
              {viewer_id}
              tab_id={tab.id}
              leaf_id={leaf.id}
              pane_position={pane_position}
              {pane_number}
              filename={pane.source_filename}
              is_active={ts.active_leaf_id === leaf.id && tab.id === tm.active_tab_id}
              bind:selected_sites={pane.selected_sites}
              bind:current_step_idx={pane.current_step_idx}
              on_file_load={create_on_file_load(tab.id, leaf.id)}
              fullscreen_toggle={false}
              allow_file_drop={false}
              structure_props={{ fullscreen_toggle: false, hide_extra_tools: false, initial_traj_b64: pane.raw_traj_b64, initial_traj_format: pane.raw_traj_format }}
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
          {:else if pane.viewer_kind === `molstar` && pane.bio_raw_content}
            <div class="bio-pane-wrap">
              <div class="bio-toolbar">
                <BioViewerToggle is_molstar={true} on_toggle={() => toggle_pane_viewer(pane)} />
                <span class="bio-toolbar-name">{pane.source_filename ?? `structure`}</span>
              </div>
              <div class="bio-viewer-fill">
                {#key pane.bio_raw_content}
                  <MolstarViewer content={pane.bio_raw_content} format={pane.bio_format ?? `pdb`} label={pane.source_filename ?? `structure`} />
                {/key}
              </div>
            </div>
          {:else if pane.structure}
            <Structure
              tab_id={tab.id}
              {viewer_id}
              leaf_id={leaf.id}
              pane_position={pane_position}
              {pane_number}
              filename={pane.source_filename}
              is_active={ts.active_leaf_id === leaf.id && tab.id === tm.active_tab_id}
              bind:structure={pane.structure}
              bind:saveable_structure={pane.saveable_structure}
              bind:selected_sites={pane.selected_sites}
              bind:remote_origin={pane.remote_origin}
              bind:open_plugin_hub={pane.open_plugin_hub}
              cube_file={pane.cube_file}
              initial_panel={pane.initial_panel}
              on_file_load={create_on_file_load(tab.id, leaf.id)}
              on_file_drop={create_on_file_drop(tab.id, leaf.id)}
              on_structure_imported={() => update_tab_label(tab.id)}
              on_save_to_project={open_save_dialog}
              on_save_to_database={open_save_dialog}
              on_clear_structure={() => {
                Object.assign(pane, create_empty_pane())
                update_tab_label(tab.id)
              }}
              on_export_to_hpc={open_export_to_hpc}
              on_export_to_file={open_export_to_file}
              on_edit_as_text={open_edit_as_text}
              on_open_file_overlay={(file_path: string, filename: string, session_id: string) => {
                handle_terminal_open_file(file_path, filename, session_id)
              }}
              on_open_terminal={(term?: Partial<TerminalLeafState>) => {
                open_terminal_leaf(tab.id, leaf.id, term)
              }}
              on_open_workflow_editor={(workflow_id: string) => {
                handle_sidebar_open_workflow(workflow_id)
              }}
              on_open_in_molstar={() => toggle_pane_viewer(pane)}
              on_view_split_request={(struct) => {
                // Docked-chat "新pane": open CatBot's loaded structure (B) in a
                // NEW TAB, leaving this tab's viewer (A) untouched. A new tab gets
                // its own tab.id = its own panel_id, so the two structures don't
                // fight over a shared panel store — panes WITHIN one tab share
                // tab.id and would clobber each other (each pane's MCP bridge
                // pushes to the same panel, and the sibling's push gets applied).
                if (!struct?.sites?.length) return
                const prev_tab_id = tm.active_tab_id
                tm.create_tab(`structure`)
                const new_tab_id = tm.active_tab_id
                const nts = tm.tab_states[new_tab_id]
                if (!nts) return
                const nleaf = leaves(nts.root)[0]
                const np = nleaf ? structurePane(nleaf) : null
                if (!np) return
                // Guard: 12-tab limit didn't open a new tab → don't clobber.
                if (new_tab_id === prev_tab_id && np.structure) {
                  console.warn(`[App] Tab limit reached, cannot open structure in new tab`)
                  return
                }
                np.initial_panel = undefined
                np.structure = clone_structure(struct)
                np.initial_site_count = struct.sites.length
                np.initial_structure_ref = struct
                np.modified = false
                const ntab = tm.tabs.find(t => t.id === new_tab_id)
                if (ntab) ntab.label = `CatBot structure`
                tm.update_tab_label(new_tab_id)
              }}
              fullscreen_toggle={false}
              allow_file_drop={false}
              show_controls={true}
              style="--struct-height: 100%; --struct-width: 100%; border-radius: 0;"
            />
          {:else if pane.initial_panel === `chat`}
            <!-- Standalone CatBot pane (e.g. "Ask CatBot" from a terminal): no
                 structure needed — the chat drives the active terminal via the
                 global terminal registry. -->
            <div class="pane-chat-fill">
              <ChatPane
                tab_id={tab.id}
                is_pane={true}
                on_close={() => { Object.assign(pane, create_empty_pane()); update_tab_label(tab.id) }}
                on_popout={async () => {
                  // Tauri-aware popout (mirrors Structure.svelte popout_chat):
                  // plain window.open does not create a window in a Tauri
                  // WebView, so try the Tauri WebviewWindow API first and only
                  // fall back to window.open in a real browser.
                  const popout_tab_id = encodeURIComponent(tab.id ?? `default`)
                  const url = `${location.origin}${location.pathname}#chat?tab_id=${popout_tab_id}`
                  try {
                    const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
                    const w = new WebviewWindow(`catgo-chat`, {
                      title: `CatGo - AI Chat`,
                      url, width: 500, height: 700, center: true, resizable: true, decorations: true,
                    })
                    w.once(`tauri://error`, () => {
                      window.open(url, `catgo-chat`, `width=500,height=700,resizable=yes`)
                    })
                  } catch {
                    window.open(url, `catgo-chat`, `width=500,height=700,resizable=yes`)
                  }
                  Object.assign(pane, create_empty_pane())
                  update_tab_label(tab.id)
                }}
                on_view_split={(_panelId, struct) => {
                  // Split this chat leaf into: left = 3D structure viewer with
                  // the structure CatBot just loaded (carried in the load card),
                  // right = the chat (history kept — keyed by tab id).
                  const res = splitLeaf(ts.root, leaf.id, `h`)
                  if (!res) return
                  ts.root = res.root
                  const left = findLeafById(ts.root, leaf.id)
                  const lp = left ? structurePane(left) : null
                  if (lp) {
                    lp.initial_panel = undefined
                    if (struct?.sites?.length) {
                      lp.structure = clone_structure(struct)
                      lp.initial_site_count = struct.sites.length
                      lp.initial_structure_ref = struct
                      lp.modified = false
                    }
                  }
                  const right = findLeafById(ts.root, res.newLeafId)
                  const rp = right ? structurePane(right) : null
                  if (rp) rp.initial_panel = `chat`
                  ts.active_leaf_id = res.newLeafId
                  update_tab_label(tab.id)
                }}
                on_view_new_window={async (_panelId, struct) => {
                  try {
                    if (struct?.sites?.length) {
                      await open_structure_in_new_window(struct, `CatBot structure`, is_tauri)
                    }
                  } catch (e) {
                    console.warn(`[CatGo] open structure window failed:`, e)
                  }
                }}
                has_sibling_structure={leaves(ts.root).some(l => { if (l.id === leaf.id) return false; const p = structurePane(l); return !!p && pane_has_content(p) })}
                on_view_overwrite={(_panelId, struct) => {
                  // Overwrite the FIRST content-bearing sibling structure leaf
                  // with the structure CatBot just loaded for this tab (carried
                  // in the load card).
                  if (!struct?.sites?.length) return
                  const target = leaves(ts.root).find(l => { if (l.id === leaf.id) return false; const p = structurePane(l); return !!p && pane_has_content(p) })
                  const tp = target ? structurePane(target) : null
                  if (tp) { tp.structure = clone_structure(struct); tp.modified = false }
                }}
              />
            </div>
          {:else}
            {@const is_primary = leaf.id === leaves(ts.root)[0].id}
            <div class="landing-page" class:secondary-pane={!is_primary} class:compact={leafCount(ts.root) > 1}>
              {#if is_primary}
                <!-- Landing-only GitHub link — invites users to star the repo -->
                <a
                  class="github-star"
                  href="https://github.com/Hello-QM/catgo-LRG"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Star CatGo on GitHub"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
                  </svg>
                  <span class="github-star-text">Star on GitHub</span>
                  <svg class="github-star-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 17.27l5.18 3.13-1.37-5.9 4.59-3.97-6.04-.52L12 4.5 9.64 10l-6.04.52 4.59 3.97-1.37 5.9z"/>
                  </svg>
                </a>
                <!-- Lab link — same mode as the GitHub link above: an
                     absolutely-positioned pill inside the landing block (top-left,
                     mirroring GitHub at top-right). Landing-only by construction. -->
                <a
                  href="https://wanlulilab.ucsd.edu"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="lab-link"
                  title="Dr. Wanlu Li Lab @ UCSD"
                >
                  Dr. Wanlu Li @UCSD
                </a>
                {#if STATIC_ONLY}
                  <!-- Landing-only "Get the App" pill — same mode as the GitHub
                       star above (absolutely-positioned in the landing block,
                       bottom-right), not a fixed badge floating over the editor. -->
                  <button
                    class="get-app-pill"
                    onclick={() => desktop_download.open()}
                    title={t('app.desktop_get_app')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span>{t('app.desktop_get_app')}</span>
                  </button>
                {/if}
                <div class="samples-grid">
                  {#each sample_structures as sample}
                    <button
                      class="sample-card"
                      onclick={() => {
                        pane.structure = clone_structure(sample.data)
                        pane.initial_site_count = sample.data.sites?.length ?? 0
                        pane.initial_structure_ref = sample.data
                        pane.modified = false
                        ts.active_leaf_id = leaf.id
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
                          scene_props={{ atom_radius: 1.6, camera_projection: `orthographic`, initial_zoom: 100 } as any}
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
                <button class="import-card add-own-card" onclick={(e) => handle_open_file(tab.id, leaf.id, e.shiftKey)}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  <div class="import-text">
                    <span class="import-title">{t(`common.open_file`)}</span>
                    <span class="import-desc">{t(`app.multi_select_or_drop`)}</span>
                  </div>
                </button>

                <button class="import-card add-own-card" onclick={() => handle_open_folder(tab.id, leaf.id)}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    <path d="M2 10h20"/>
                  </svg>
                  <div class="import-text">
                    <span class="import-title">{t(`common.open_folder`)}</span>
                    <span class="import-desc">{t(`app.load_all_structures`)}</span>
                  </div>
                </button>

                <button class="import-card database-card" onclick={() => { modal.import_target_tab = tab.id; modal.import_target_leaf = leaf.id; modal.optimade_search_element = ``; modal.search_provider = STATIC_ONLY ? `pubchem` : `mp`; modal.search_visible = true }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M12 3C7.58 3 4 4.79 4 7s3.58 4 8 4s8-1.79 8-4s-3.58-4-8-4M4 9v3c0 2.21 3.58 4 8 4s8-1.79 8-4V9M4 14v3c0 2.21 3.58 4 8 4s8-1.79 8-4v-3"/>
                  </svg>
                  <div class="import-text">
                    <span class="import-title">{t(`app.search_database`)}</span>
                    <span class="import-desc">{STATIC_ONLY ? t(`app.pubchem_molecules`) : t(`app.optimade_pubchem`)}</span>
                  </div>
                </button>

                <button class="import-card paste-card" onclick={() => { modal.import_target_tab = tab.id; modal.import_target_leaf = leaf.id; modal.paste_content_visible = true }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                    <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
                    <path d="M9 12h6M9 16h6"/>
                  </svg>
                  <div class="import-text">
                    <span class="import-title">{t(`common.paste`)}</span>
                    <span class="import-desc">POSCAR/CONTCAR</span>
                  </div>
                </button>

                {#if !STATIC_ONLY}
                <button class="import-card workflow-card" onclick={() => { pane.mode = `workflow`; update_tab_label(tab.id) }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="2" y="3" width="6" height="5" rx="1" />
                    <rect x="16" y="3" width="6" height="5" rx="1" />
                    <rect x="9" y="16" width="6" height="5" rx="1" />
                    <path d="M5 8v3a2 2 0 002 2h10a2 2 0 002-2V8" />
                    <path d="M12 13v3" />
                  </svg>
                  <div class="import-text">
                    <span class="import-title">{t(`common.workflow`)}</span>
                    <span class="import-desc">{t(`app.pipeline_editor`)}</span>
                  </div>
                </button>
                {/if}

                <button class="import-card builder-card" onclick={() => {
                  pane.structure = {
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
                  pane.initial_site_count = 2
                  pane.initial_structure_ref = pane.structure
                  pane.modified = false
                  ts.active_leaf_id = leaf.id
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="8" r="2.5"/>
                    <circle cx="6" cy="16" r="2.5"/>
                    <circle cx="18" cy="16" r="2.5"/>
                    <path d="M12 10.5v2.5l-4.5 3M12 13l4.5 3"/>
                  </svg>
                  <div class="import-text">
                    <span class="import-title">{t(`app.build`)}</span>
                    <span class="import-desc">{t(`app.build_desc`)}</span>
                  </div>
                </button>

                <!-- AI Chat: shown in STATIC_ONLY too — CatBot runs client-direct
                     in-browser (no backend) and can fetch/build structures from empty state. -->
                <button class="import-card chat-card" onclick={() => {
                  // Open a full CatBot pane (no forced structure). CatBot runs
                  // client-direct and can fetch/build structures from empty state
                  // if asked; the standalone-chat leaf_body branch renders it.
                  pane.initial_panel = `chat`
                  ts.active_leaf_id = leaf.id
                  update_tab_label(tab.id)
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                  </svg>
                  <div class="import-text">
                    <span class="import-title">{t(`app.ai_chat`)}</span>
                    <span class="import-desc">{t(`app.ask_questions`)}</span>
                  </div>
                </button>

                {#if !STATIC_ONLY}
                <button class="import-card hpc-card" onclick={() => {
                  console.log(`[CatGo:UI] Welcome card clicked: HPC → loading structure + opening HPC panel`)
                  pane.structure = clone_structure(water as unknown as AnyStructure)
                  pane.initial_site_count = (water as any).sites?.length ?? 0
                  pane.initial_structure_ref = water as unknown as AnyStructure
                  pane.initial_panel = `hpc`
                  ts.active_leaf_id = leaf.id
                  update_tab_label(tab.id)
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
                  </svg>
                  <div class="import-text">
                    <span class="import-title">{t(`app.hpc`)}</span>
                    <span class="import-desc">{t(`app.remote_connect`)}</span>
                  </div>
                </button>

                <button class="import-card terminal-card" onclick={() => {
                  console.log(`[CatGo:UI] Welcome card clicked: Terminal → converting leaf to a terminal`)
                  ts.root = setLeafContent(ts.root, leaf.id, { type: `terminal`, term: { sync_cwd: false } })
                  ts.active_leaf_id = leaf.id
                  update_tab_label(tab.id)
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                  </svg>
                  <div class="import-text">
                    <span class="import-title">{t(`app.terminal`)}</span>
                    <span class="import-desc">{t(`app.local_shell`)}</span>
                  </div>
                </button>
                {/if}

                <!-- Plugins Card (only show on main pane, hide in static mode) -->
                {#if !STATIC_ONLY && is_primary}
                  <button class="import-card plugins-card" onclick={() => open_plugin_hub_on_active_leaf()}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                      <path d="M2 17l10 5 10-5"/>
                      <path d="M2 12l10 5 10-5"/>
                    </svg>
                    <div class="import-text">
                      <span class="import-title">{t(`app.plugins`)}</span>
                      <span class="import-desc">{t(`app.extend_catgo`)}</span>
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
                      <span class="import-title">{t(`app.external`)}</span>
                      <span class="import-desc">{t(`app.receive_from_lab`)}</span>
                    </div>
                  </button>
                {/if}
              </div>
            </div>
          {/if}
          {/if}
        {/snippet}

        {#snippet terminal_body(leaf: LeafNode)}
          {@const term = leaf.content.type === `terminal` ? leaf.content.term : undefined}
          {#if term}
            <!-- TerminalWindow provides the full terminal chrome inside the leaf:
                 internal tabs (multiple shells, "+"), per-tab shell picker, font
                 settings, and per-tab Directory Sync. The leaf header above only
                 carries the tree controls (type-switch / maximize / popout / close). -->
            <TerminalWindow
              initial_session_id={term.session_id}
              initial_host={term.host}
              initial_username={term.username}
              initial_sync_cwd={term.sync_cwd}
              onpopout={() => popout_terminal_leaf(tab.id, leaf.id)}
              onclose={() => close_terminal_leaf(tab.id, leaf.id)}
              on_open_file={(p, sid) => handle_terminal_leaf_open_file(p, term, sid)}
              on_ask_catbot={() => open_chat_beside(leaf)}
            />
          {/if}
        {/snippet}
        </div><!-- end structure-workspace -->
      {/if}

    {:else if tab.type === `workflow`}
      <WorkflowView
        tab_id={tab.id}
        onclose={() => { close_tab(`workflow`); switch_to_structure() }}
        onpopout={popout_workflow}
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
  electronic_props={modal.db_preview_electronic}
  electronic_labels={{
    band_gap: t(`structure.preview_band_gap`),
    is_metal: t(`structure.preview_is_metal`),
    efermi: t(`structure.preview_efermi`),
    cbm: t(`structure.preview_cbm`),
    vbm: t(`structure.preview_vbm`),
    dos_available: t(`structure.preview_dos_available`),
    bands_available: t(`structure.preview_bands_available`),
    magnetic_ordering: t(`structure.preview_magnetic_ordering`),
    yes: t(`structure.preview_yes`),
    no: t(`structure.preview_no`),
    available: t(`structure.preview_available`),
    not_available: t(`structure.preview_not_available`),
    metallic: t(`structure.preview_metallic`),
    missing: t(`structure.preview_missing`),
  }}
  electronic_heading={t(`structure.preview_electronic_heading`)}
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
    {@const structure_count = leaves(confirm_ts.root).filter(l => { const p = structurePane(l); return !!p && pane_has_content(p) }).length}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={() => tm.tab_close_confirm_id = null}>
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="modal-dialog" onclick={(e) => e.stopPropagation()}>
        <h3>{t(`app.confirm_close_tab`, { label: confirm_tab.label })}</h3>
        <p>{t(`app.structures_will_be_removed`, { count: structure_count })}</p>
        <div class="modal-actions">
          <button class="modal-btn cancel" onclick={() => tm.tab_close_confirm_id = null}>{t(`common.cancel`)}</button>
          <button class="modal-btn danger" onclick={() => close_tab(tm.tab_close_confirm_id!)}>{t(`app.close_tab`)}</button>
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
      <h3>{t(`app.change_layout`)}</h3>
      <p>{t(`app.structures_will_be_removed`, { count: tm.pending_layout_change.lost_count })}</p>
      <div class="modal-actions">
        <button class="modal-btn cancel" onclick={() => tm.pending_layout_change = null}>{t(`common.cancel`)}</button>
        <button class="modal-btn danger" onclick={confirm_layout_change}>{t(`app.continue`)}</button>
      </div>
    </div>
  </div>
{/if}

<!-- SDK-agent terminal command approval -->
{#if terminal_approval.pending}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={terminal_approval_deny}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="modal-dialog" onclick={(e) => e.stopPropagation()}>
      <h3>{t(`app.agent_terminal_approve_title`)}</h3>
      <p class="agent-term-detail">
        <span class="agent-term-action">{terminal_approval.pending.action}</span>
        <code>{terminal_approval.pending.detail}</code>
      </p>
      <label class="agent-term-autorun">
        <input type="checkbox" bind:checked={terminal_approval.auto_run} />
        {t(`app.agent_terminal_autorun`)}
      </label>
      <div class="modal-actions">
        <button class="modal-btn cancel" onclick={terminal_approval_deny}>{t(`common.cancel`)}</button>
        <button class="modal-btn danger" onclick={terminal_approval_allow}>{t(`app.allow`)}</button>
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
  oncancel={cancel_export_dialog}
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
<DownloadManager />
<DesktopDownloadModal />
<UpdateBanner />

<style>
  .bio-pane-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .bio-toolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border-color, #ddd);
    background: var(--panel-bg, rgba(0, 0, 0, 0.03));
  }
  .bio-toolbar-name {
    font-size: 0.78rem;
    color: var(--text-muted, #777);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bio-viewer-fill {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }
  .sidebar-editor-overlay {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(900px, calc(100vw - 32px));
    height: min(700px, calc(100vh - 32px));
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
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
    padding: 16px;
    overflow: auto;
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
  /* PaneTree renders its root (.split or .pane) as the direct child here;
     the split/pane/divider/content geometry now lives in PaneTree.svelte. */
  .structure-workspace > :global(.split),
  .structure-workspace > :global(.pane) {
    flex: 1;
    min-width: 0;
  }

  /* .panel-header flex container is PaneTree's element (styled there); the
     dot/label/buttons below render via App snippets so stay App-scoped. */

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
  .panel-maximize-btn,
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
  /* Hover-reveal lives in PaneTree.svelte (.pane:hover :global(.panel-*-btn))
     because .pane is rendered there while these buttons render in App's scope. */

  .panel-popout-btn:hover,
  .panel-maximize-btn:hover {
    background: rgba(59, 130, 246, 0.5);
    color: white;
  }

  .panel-close-btn:hover {
    background: rgba(220, 38, 38, 0.5);
    color: white;
  }

  .panel-type-container {
    position: relative;
    display: flex;
    align-items: center;
  }

  .panel-type-btn {
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

  .panel-type-btn:hover {
    background: rgba(59, 130, 246, 0.5);
    color: white;
  }

  .panel-type-menu {
    position: absolute;
    top: 20px;
    right: 0;
    z-index: 1000;
    background: var(--page-bg, #1c1d21);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 4px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    min-width: 120px;
    overflow: hidden;
  }

  .panel-type-menu button {
    padding: 6px 12px;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text-color, #e2e8f0);
    cursor: pointer;
    font-size: 12px;
    text-align: left;
    transition: background 0.1s;
    white-space: nowrap;
  }

  .panel-type-menu button:hover {
    background: rgba(59, 130, 246, 0.2);
  }

  /* .panel-content geometry lives in PaneTree.svelte (height:0 keep-warm base). */

  /* Inline panel close confirmation banner */
  .panel-close-banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    row-gap: 6px;
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
    white-space: nowrap;
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
    padding: 16px;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100000050;
    animation: fade-in 0.15s ease-out;
    overflow: auto;
  }

  .modal-dialog {
    background: var(--dialog-bg, var(--surface-bg, #1c1c2e));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 12px;
    padding: 24px;
    min-width: min(320px, calc(100vw - 32px));
    max-width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
    overflow: auto;
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
    flex-wrap: wrap;
    gap: 8px;
  }

  .agent-term-detail {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 12px 0 !important;
  }
  .agent-term-action {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-color-muted, #6b7280);
  }
  .agent-term-detail code {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 13px;
    color: var(--text-color, #111827);
    background: var(--surface-alt, rgba(0, 0, 0, 0.05));
    padding: 4px 8px;
    border-radius: 4px;
  }
  .agent-term-autorun {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-color-muted, #6b7280);
    margin: 0 0 18px 0;
    cursor: pointer;
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

  /* .pane.dragover glow + add-own-card highlight live in PaneTree.svelte
     (.pane is rendered there; cards render in App's scope via :global). */

  /* Standalone CatBot pane (full-pane chat, no structure viewer) */
  .pane-chat-fill {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Original horizontal layout (restored) */
  .landing-page {
    position: relative;
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

  /* Landing-only "Star on GitHub" link, pinned top-right of the welcome area */
  .github-star {
    position: absolute;
    top: 14px;
    right: 16px;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    text-decoration: none;
    color: var(--text-color-muted, #9ca3af);
    background: var(--surface-bg, rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.15s, background 0.15s, border-color 0.15s, transform 0.15s;
  }

  .github-star:hover {
    color: var(--text-color, #f3f4f6);
    background: var(--surface-bg-hover, rgba(255, 255, 255, 0.1));
    border-color: var(--accent-color, cornflowerblue);
    transform: translateY(-1px);
  }

  .github-star svg {
    flex-shrink: 0;
  }

  .github-star .github-star-icon {
    color: #f1c40f;
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

  /* .pane.dragover .import-card.add-own-card highlight lives in PaneTree.svelte. */

  /* Compact landing — any tab with more than one leaf (was quad/stacked layout):
     hide the samples grid + descriptions, grid the import cards to avoid scroll. */
  .landing-page.compact {
    padding: 8px;
    overflow-y: hidden;
  }

  .landing-page.compact .samples-grid {
    display: none;
  }

  .landing-page.compact .import-sidebar {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    width: 100%;
    max-width: 280px;
  }

  .landing-page.compact .import-card {
    padding: 6px 8px;
    gap: 6px;
  }

  .landing-page.compact .import-card svg {
    width: 16px;
    height: 16px;
  }

  .landing-page.compact .import-desc {
    display: none;
  }

  .landing-page.compact .import-title {
    font-size: 0.8rem;

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

  /* Same mode as .github-star: an absolutely-positioned pill in the landing
     corner (top-left, mirroring GitHub at top-right) — not a fixed badge. */
  .lab-link {
    position: absolute;
    top: 14px;
    left: 16px;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    text-decoration: none;
    color: var(--text-color-muted, #9ca3af);
    background: var(--surface-bg, rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.15s, background 0.15s, border-color 0.15s, transform 0.15s;
  }

  .lab-link:hover {
    color: var(--text-color, #f3f4f6);
    background: var(--surface-bg-hover, rgba(255, 255, 255, 0.1));
    border-color: var(--accent-color, cornflowerblue);
    transform: translateY(-1px);
  }

  /* Same mode as .github-star / .lab-link: an absolutely-positioned pill in the
     landing corner (bottom-right) — not a fixed badge over the editor. */
  .get-app-pill {
    position: absolute;
    bottom: 14px;
    right: 16px;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    text-decoration: none;
    color: var(--text-color-muted, #9ca3af);
    background: var(--surface-bg, rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.15s, background 0.15s, border-color 0.15s, transform 0.15s;
  }

  .get-app-pill:hover {
    color: var(--text-color, #f3f4f6);
    background: var(--surface-bg-hover, rgba(255, 255, 255, 0.1));
    border-color: var(--accent-color, cornflowerblue);
    transform: translateY(-1px);
  }

  .get-app-pill svg {
    flex-shrink: 0;
    color: var(--accent-color, cornflowerblue);
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

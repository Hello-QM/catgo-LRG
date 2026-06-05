<script lang="ts">
  import { untrack } from 'svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { NODE_DEFINITIONS, NODE_TYPE_MIGRATION, get_node_categories, get_sidebar_categories, load_plugin_nodes, UNIFIED_CALC_TYPES, CALC_TYPE_OPTIONS, UNIFIED_TOOL_TYPES, TOOL_TYPE_OPTIONS, UNIFIED_ANALYSIS_TYPES, ANALYSIS_TYPE_OPTIONS } from './node-definitions'
  import { load_dynamic_engines, all_engine_specs } from './node-defs/dynamic'
  import { STATUS_COLORS } from './workflow-types'
  import type { WorkflowRunConfig } from './workflow-types'
  import {
    sync_workflow_state,
    clear_workflow_state,
    get_workflow_slice,
  } from './workflow-state.svelte'
  import {
    register_workflow_action_handler,
    unregister_workflow_action_handler,
  } from '$lib/chat/workflow-tool-executor'
  import NodeConfigPanel from './NodeConfigPanel.svelte'
  import NodeStatusPanel from './NodeStatusPanel.svelte'
  import SlabGenPreview from './SlabGenPreview.svelte'
  import CalcStructurePreview from './CalcStructurePreview.svelte'
  import BatchPanel from './BatchPanel.svelte'
  import GestureProvider from '$lib/gesture/GestureProvider.svelte'
  import GestureOverlay from '$lib/gesture/GestureOverlay.svelte'
  import { WorkflowAdapter, type WorkflowGestureAPI } from '$lib/gesture/workflow-adapter'
  import { DEFAULT_GESTURE_CONFIG, type GestureEvent, type VoiceEvent, type GestureConfig } from '$lib/gesture/gesture-types'
  import EnergyDiagramPlot from './EnergyDiagramPlot.svelte'
  import EnergyDiagramModal from './EnergyDiagramModal.svelte'
  import RunConfigDialog from './RunConfigDialog.svelte'
  import PauseDialog from './PauseDialog.svelte'
  import * as api from '$lib/api/workflow'
  import type { StepForces } from '$lib/api/workflow'
  import { API_BASE } from '$lib/api/config'
  import { hpc_session_store, refresh_hpc_sessions } from '$lib/hpc-sessions.svelte'
  import ConnectDialog from '$lib/ConnectDialog.svelte'
  import { generateVASPInputs } from '$lib/api/compute'
  import StructureInputDialog from './StructureInputDialog.svelte'
  import StructureInputPanel from './StructureInputPanel.svelte'
  import StructureListInputPanel from './StructureListInputPanel.svelte'
  import AdsorbatePlacePanel from './AdsorbatePlacePanel.svelte'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import { get_current_structure } from '$lib/structure/current-structure.svelte'
  import JobScriptWorkplace from './JobScriptWorkplace.svelte'
  import VaspEditorModal from './components/VaspEditorModal.svelte'
  import ImportWorkflowDialog from './components/ImportWorkflowDialog.svelte'
  import InputEditorModal from './components/InputEditorModal.svelte'
  import FileBrowserModal from './components/FileBrowserModal.svelte'
  import StructureEditModal from './components/StructureEditModal.svelte'
  import DopingWorkflowModal from './components/DopingWorkflowModal.svelte'
  import CustomCommandWizard from './components/CustomCommandWizard.svelte'
  import { job_script_store } from './job-script-store.svelte'
  import { resizable } from './use-resize-panel'
  import { broadcast_status, broadcast_selection, write_pinned, listen_command } from './status-sync.svelte'
  import type { PymatgenStructure } from '$lib'
  import type { TrajectoryType } from '$lib/trajectory'
  import {
    type WfNode, type WfEdge,
    NW, NH, GRID, HANDLE_R, MM_W, MM_H,
    snap, uid, get_display_params, get_nh, get_handle_pos,
    bezier, point_on_bezier,
    dist_to_edge as _dist_to_edge,
    has_cycle as _has_cycle,
    would_create_cycle as _would_create_cycle,
    auto_layout, to_workflow_json,
    is_vasp_node, is_orca_node, is_cp2k_node, is_lammps_node,
    is_hpc_node, is_structure_node, has_structure_io,
    VASP_EXECUTABLES, get_vasp_calc_type, parse_kpoints_str, parse_slab_gen_params,
    resolve_input_structure as _resolve_input_structure,
    resolve_input_structures as _resolve_input_structures,
    TEMPLATES, TEMPLATE_GROUPS,
  } from './graph-model'
  import { create_workflow_action_handler, type WorkflowCommandState } from './workflow-commands'
  import { create_canvas_interaction } from './workflow-canvas-interaction.svelte'
  import { create_workflow_execution } from './workflow-execution.svelte'
  import { create_workflow_history } from './workflow-history.svelte'
  import { create_workflow_clipboard } from './workflow-clipboard.svelte'
  import { create_hpc_banner } from './workflow-hpc-banner.svelte'
  import { create_change_detection } from './workflow-change-detection.svelte'

  let {
    workflow_id = ``,
    onclose,
    onpopout,
    ontoggle_terminal,
    terminal_open = false,
    ontoggle_chat,
    chat_open = false,
    compact = false,
    tab_id,
  }: {
    workflow_id?: string
    onclose?: () => void
    onpopout?: () => void
    ontoggle_terminal?: () => void
    terminal_open?: boolean
    ontoggle_chat?: () => void
    chat_open?: boolean
    /** When true, start with sidebars collapsed and minimal toolbar (AI-initiated workflows). */
    compact?: boolean
    // Per-tab identifier reserved for Phase 2/3 of the tab-isolation refactor
    // (tab-keyed workflow slices, tab-keyed action_handler Map, MCP URL
    // routing). Accepted here so callers can pass it end-to-end; unused in
    // Phase 1.
    tab_id?: string
  } = $props()

  // Types (WfNode, WfEdge) and constants (NW, NH, GRID, etc.) imported from ./graph-model

  // ─── Extracted module instances ───
  // `tab_slice_id` is used as the tab_id for all per-tab workflow state
  // lookups within this editor instance. Falls back to "default" for
  // legacy contexts (standalone page, popout) that don't supply one.
  const tab_slice_id = tab_id ?? `default`
  const wf_slice = $derived(get_workflow_slice(tab_slice_id))

  const canvas = create_canvas_interaction()
  const exec = create_workflow_execution(tab_slice_id)
  const hist = create_workflow_history()
  const clip = create_workflow_clipboard()
  const hpc_banner = create_hpc_banner()
  const change_det = create_change_detection()

  // ─── Load workflow i18n module ───
  $effect(() => { load_i18n_module('workflow') })

  // ─── State ───
  // NOTE on reactivity for `nodes` / `edges`:
  //
  // We tried `$state.raw` here to avoid the deep-proxy overhead that caused
  // WebKitGTK to white-screen on 30+ node workflows. That regressed into a
  // WORSE failure: because several `$derived` values downstream (`selected_node`,
  // `orphan_set`, `workflow_json`, `mm_bounds`) destructure into individual
  // fields of node objects, `$state.raw` cannot track those field accesses.
  // Any `nodes = nodes.map(...)` then invalidated *every* derived and every
  // effect reading them, creating tight update loops that spun one WebKit
  // content process to 180% CPU / 15 GB RAM.
  //
  // Keep these as regular `$state` so deep proxies track fine-grained deps.
  // The white-screen cause (30-node batch append) must be solved by a
  // different mechanism — see the batch handler below for the actual fix.
  //
  // See `src/lib/workflow/CLAUDE.md` → "When to use $state.raw".
  let nodes = $state<WfNode[]>([])
  let edges = $state<WfEdge[]>([])
  let sel_nodes = $state(new Set<string>())
  let sel_edge = $state<string | null>(null)
  let show_templates = $state(false)
  type QuickRecipe = { id: string; label: string; node_count: number; edge_count: number }
  let quickbuild_recipes = $state<QuickRecipe[]>([])
  let quickbuild_loading = $state(false)
  let quickbuild_error = $state(``)

  async function fetch_quickbuild_recipes() {
    if (quickbuild_recipes.length > 0 || quickbuild_loading) return
    quickbuild_loading = true
    quickbuild_error = ``
    try {
      const resp = await fetch(`${API_BASE}/workflow/quickbuild/recipes`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      quickbuild_recipes = await resp.json()
    } catch (e) {
      quickbuild_error = e instanceof Error ? e.message : t('workflow.editor_quickbuild_load_failed')
    } finally {
      quickbuild_loading = false
    }
  }

  async function quickbuild_run(recipe_id: string) {
    quickbuild_error = ``
    try {
      const resp = await fetch(`${API_BASE}/workflow/quickbuild`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({ recipe: recipe_id }),
      })
      if (!resp.ok) {
        const txt = await resp.text().catch(() => String(resp.status))
        throw new Error(txt.slice(0, 200))
      }
      const data = await resp.json()
      show_templates = false
      const wf_id = data.workflow_id
      if (wf_id) {
        // The HTTP endpoint already calls _push_workflow_navigate server-side,
        // which posts to /view/structure/pending-update — the frontend poll
        // picks it up and App.svelte's pending_navigate_workflow effect opens
        // the editor. But that path is async (~1-2s); set the slice signal
        // directly here so the editor opens immediately in the originating
        // tab. We always set the id (even if same) and bump reload_seq so
        // the App.svelte effect re-fires.
        try {
          const wf_state = await import(`./workflow-state.svelte`)
          const slice = wf_state.get_workflow_slice(tab_slice_id)
          slice.pending_navigate_workflow.id = wf_id
          slice.workflow_reload_seq.seq++
        } catch { /* ignore */ }
      }
    } catch (e) {
      quickbuild_error = e instanceof Error ? e.message : t('workflow.editor_quickbuild_run_failed')
    }
  }

  $effect(() => {
    if (show_templates) fetch_quickbuild_recipes()
  })
  let editing_param = $state<string | null>(null)
  let edit_val = $state(``)
  let right_panel = $state<`props` | `batch` | `status`>(`props`)
  let sidebar_open = $state(!untrack(() => compact))
  let rpanel_open = $state(!untrack(() => compact))
  let rpanel_width = $state(280)
  let workflow_name = $state(t('workflow.editor_untitled_workflow'))
  let is_saving = $state(false)
  let save_flash = $state(false)
  let is_loaded = $state(false)
  let load_error = $state(``)
  let svg_el = $state<SVGSVGElement | null>(null)

  // UI dialog state (not extracted — tightly coupled to component)
  let show_job_script_workplace = $state(false)
  let show_import_dialog = $state(false)
  let show_custom_wizard = $state(false)
  let cycle_warning = $state<string | null>(null)
  let poll_timer: ReturnType<typeof setInterval> | null = null

  // ─── Reactive aliases for extracted module state (used by template) ───
  // Canvas interaction
  const drag = $derived(canvas.drag)
  const conn = $derived(canvas.conn)
  const mouse = $derived(canvas.mouse)
  const pan = $derived(canvas.pan)
  const zoom = $derived(canvas.zoom)
  const panning = $derived(canvas.panning)
  const box_sel = $derived(canvas.box_sel)

  // Execution
  const sim_running = $derived(exec.sim_running)
  const workflow_status = $derived(exec.workflow_status)
  const execution_error = $derived(exec.execution_error)
  const show_run_dialog = $derived(exec.show_run_dialog)
  const show_pause_dialog = $derived(exec.show_pause_dialog)
  const pause_jobs = $derived(exec.pause_jobs)
  const node_statuses = $derived(exec.node_statuses)
  const step_messages = $derived(exec.step_messages)
  const task_results = $derived(exec.task_results)
  const has_running_jobs = $derived(exec.has_running_jobs)

  // HPC banner
  // show_connect_dialog is kept local (writable) since ConnectDialog uses bind:show
  let show_connect_dialog = $state(false)
  const disconnected_hosts = $derived(hpc_banner.disconnected_hosts)
  const needed_hpc_hosts = $derived(hpc_banner.needed_hpc_hosts)

  // Change detection
  const known_updated_at = $derived(change_det.known_updated_at)
  const external_change_detected = $derived(change_det.external_change_detected)

  // ─── Gesture Control State ─────────────────────────────────
  let wf_gesture_active = $state(false)
  let wf_gesture_config = $state<GestureConfig>({ ...DEFAULT_GESTURE_CONFIG })
  let wf_gesture_adapter: WorkflowAdapter | null = null
  let wf_wrapper_el = $state<HTMLElement | null>(null)

  const wf_gesture_api: WorkflowGestureAPI = {
    pan(dx, dy) { canvas.set_pan({ x: canvas.pan.x + dx, y: canvas.pan.y + dy }) },
    zoom(delta) { canvas.set_zoom(Math.max(0.1, Math.min(4, canvas.zoom + delta))) },
    node_at(_sx, _sy) {
      // Simple: find the node closest to the screen point
      // Would need proper coordinate transform; for now return selected
      return null
    },
    set_hover(_id) { /* node hover is handled by SVG events */ },
    select_node(id) { sel_nodes = new Set([id]) },
    clear_selection() { sel_nodes = new Set() },
    canvas_size() { return { width: wf_wrapper_el?.clientWidth ?? 800, height: wf_wrapper_el?.clientHeight ?? 600 } },
  }

  function on_wf_gesture(event: GestureEvent): void {
    if (!wf_gesture_adapter) {
      wf_gesture_adapter = new WorkflowAdapter(wf_gesture_api, wf_gesture_config.sensitivity)
    }
    const w = wf_wrapper_el?.clientWidth ?? 800
    const h = wf_wrapper_el?.clientHeight ?? 600
    event.screen_pos = { x: event.screen_pos.x * w, y: event.screen_pos.y * h }
    wf_gesture_adapter.process(event)
  }

  function on_wf_voice(event: VoiceEvent): void {
    if (!wf_gesture_adapter) {
      wf_gesture_adapter = new WorkflowAdapter(wf_gesture_api, wf_gesture_config.sensitivity)
    }
    wf_gesture_adapter.process_voice(event)
    if (event.is_final && event.action.type === `mode` && event.action.command === `gesture_off`) {
      wf_gesture_active = false
      wf_gesture_config = { ...wf_gesture_config, enabled: false }
    }
  }

  // AI Chat state managed by parent via ontoggle_chat / chat_open props

  // Structure editing state
  let show_structure_dialog = $state(false)
  let structure_dialog_json = $state<string | null>(null)
  let structure_dialog_mode = $state<'import' | 'edit' | 'view'>('import')
  let structure_dialog_title = $state('Structure Input')
  let structure_dialog_node_id = $state<string | null>(null)

  // ─── Init job script store lazily ───
  $effect(() => {
    if (!job_script_store.initialized) job_script_store.init()
  })

  // ─── Plugin nodes & dynamic engines ───
  let _node_defs_version = $state(0)
  $effect(() => {
    Promise.all([
      load_plugin_nodes(API_BASE),
      load_dynamic_engines(API_BASE),
    ]).then(() => { _node_defs_version++ })
  })

  // ─── Derived ───
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  const categories = $derived.by(() => { void _node_defs_version; return get_node_categories() })
  const sidebar_cats = $derived.by(() => { void _node_defs_version; return get_sidebar_categories() })
  let collapsed_cats = $state<Set<string>>(new Set())

  // ─── Pointer-based palette drag (replaces HTML5 drag-and-drop which doesn't fire ondrop in Tauri/macOS) ───
  let palette_drag = $state<{ type: string; x: number; y: number } | null>(null)

  function on_palette_pointerdown(e: PointerEvent, type: string) {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    palette_drag = { type, x: e.clientX, y: e.clientY }
  }

  function on_palette_pointermove(e: PointerEvent) {
    if (!palette_drag) return
    palette_drag = { ...palette_drag, x: e.clientX, y: e.clientY }
  }

  function on_palette_pointerup(e: PointerEvent) {
    if (!palette_drag) return
    const type = palette_drag.type
    palette_drag = null
    if (!NODE_DEFINITIONS[type]) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const on_canvas = svg_el?.contains(el) || el === svg_el || wf_wrapper_el?.contains(el)
    if (!on_canvas) return
    const pt = canvas.get_svg_pt({ clientX: e.clientX, clientY: e.clientY } as MouseEvent, svg_el)
    const cfg = NODE_DEFINITIONS[type]
    const new_id = uid()
    nodes = [...nodes, {
      id: new_id, type, x: snap(pt.x - NW / 2), y: snap(pt.y - 30),
      params: cfg.default_params ? { ...cfg.default_params } : {},
    }]
    sel_nodes = new Set([new_id])
    sel_edge = null
    push_history()
    ensure_workflow()
    schedule_save()
    if (type === `structure_input`) {
      setTimeout(() => open_structure_dialog(new_id), 50)
    }
  }

  const selected_node = $derived(sel_nodes.size === 1 ? nodes.find(n => n.id === [...sel_nodes][0]) ?? null : null)
  const selected_edge = $derived(sel_edge ? edges.find(e => e.id === sel_edge) ?? null : null)
  const orphan_set = $derived.by(() => {
    const connected = new Set<string>()
    edges.forEach(e => { connected.add(e.from); connected.add(e.to) })
    return new Set(nodes.filter(n => !connected.has(n.id) && nodes.length > 1).map(n => n.id))
  })
  const workflow_json = $derived(to_workflow_json(nodes, edges))
  const mm_bounds = $derived.by(() => {
    if (!nodes.length) return { minX: 0, minY: 0, maxX: 1000, maxY: 600 }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    nodes.forEach(n => {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + NW); maxY = Math.max(maxY, n.y + get_nh(n))
    })
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1000, maxY: 600 }
    return { minX: minX - 100, minY: minY - 100, maxX: maxX + 100, maxY: maxY + 100 }
  })

  // Geometry helpers, templates imported from ./graph-model

  /** Wrapper: dist_to_edge needs current nodes array */
  function dist_to_edge(px: number, py: number, edge: WfEdge): number {
    return _dist_to_edge(px, py, edge, nodes)
  }

  // ─── History (delegates to workflow-history module) ───
  function push_history() {
    hist.push_history(nodes, edges)
  }

  function undo() {
    const result = hist.undo()
    if (result) { nodes = result.nodes; edges = result.edges }
  }

  function redo() {
    const result = hist.redo()
    if (result) { nodes = result.nodes; edges = result.edges }
  }

  // ─── Copy / Paste / Delete (delegates to workflow-clipboard module) ───
  function copy_selected() {
    clip.copy_selected(nodes, sel_nodes, edges)
  }

  function paste() {
    const result = clip.paste(nodes, edges)
    if (!result) return
    nodes = result.nodes
    edges = result.edges
    sel_nodes = result.new_sel
    push_history()
  }

  function delete_selected() {
    const result = clip.delete_selected(nodes, edges, sel_nodes, sel_edge)
    if (!result.changed) return
    nodes = result.nodes
    edges = result.edges
    sel_nodes = result.sel_nodes
    sel_edge = result.sel_edge
    push_history()
    schedule_save()
  }

  // ─── Auto layout (delegates to graph-model) ───
  function do_auto_layout() {
    nodes = auto_layout(nodes, edges)
    push_history()
  }

  // ─── Template ───
  function load_template(key: string) {
    const t = TEMPLATES[key]
    if (!t) return
    nodes = JSON.parse(JSON.stringify(t.nodes))
    edges = JSON.parse(JSON.stringify(t.edges))
    sel_nodes = new Set(); sel_edge = null
    exec.set_node_statuses({}); exec.set_sim_running(false)
    canvas.reset_view()
    push_history()
    show_templates = false
  }

  // ─── Import workflow (append imported nodes/edges to current graph) ───
  function handle_import(graph: { nodes: WfNode[]; edges: WfEdge[] }) {
    nodes = [...nodes, ...graph.nodes]
    edges = [...edges, ...graph.edges]
    sel_nodes = new Set(graph.nodes.map(n => n.id))
    sel_edge = null
    push_history()
    schedule_save()
  }

  // ─── DAG validation (wrappers around graph-model) ───
  function has_cycle(test_edges?: WfEdge[]): boolean {
    return _has_cycle(nodes, test_edges ?? edges)
  }

  function would_create_cycle(from_id: string, to_id: string): boolean {
    return _would_create_cycle(nodes, edges, from_id, to_id)
  }

  // ─── Execution (delegates to workflow-execution module) ───

  async function open_pause_dialog() {
    exec.open_pause_dialog(workflow_id, nodes)
  }

  function check_workflow_safety(workflow_nodes: WfNode[]): { level: string; warnings: string[] } {
    const warnings: string[] = []
    let max_level = 'safe'

    for (const spec of all_engine_specs()) {
      if (spec.safety === 'warn' || spec.safety === 'dangerous') {
        const uses = workflow_nodes.some(n => {
          const sw = (n.params as Record<string, unknown>)?.software
          return sw === spec.engine
        })
        if (uses) {
          if (spec.safety === 'dangerous') max_level = 'dangerous'
          else if (max_level !== 'dangerous') max_level = 'warn'
          warnings.push(`${spec.label}: runs custom commands on HPC`)
        }
      }
    }

    return { level: max_level, warnings }
  }

  function handle_run_click() {
    const safety = check_workflow_safety(nodes)
    if (safety.level === 'dangerous') {
      const confirmed = confirm(
        `⚠️ DANGEROUS: This workflow contains nodes that run potentially dangerous commands:\n\n` +
        safety.warnings.join('\n') +
        `\n\nAre you SURE you want to proceed?`
      )
      if (!confirmed) return
    } else if (safety.level === 'warn') {
      const confirmed = confirm(
        `⚠️ This workflow contains custom command nodes:\n\n` +
        safety.warnings.join('\n') +
        `\n\nProceed?`
      )
      if (!confirmed) return
    }
    exec.handle_run_click(
      workflow_id,
      nodes,
      has_cycle,
      do_save,
      (msg: string) => { cycle_warning = msg; setTimeout(() => cycle_warning = null, 5000) },
    )
  }

  async function handle_execute(config: WorkflowRunConfig) {
    await exec.handle_execute(config, workflow_id, nodes, resolve_input_structure, do_save, (updated: typeof nodes) => { nodes = updated })
  }

  async function handle_pause_confirm(cancel_step_ids: string[]) {
    await exec.handle_pause_confirm(cancel_step_ids, workflow_id, handle_reset)
  }

  async function handle_reset() {
    const has_active = Object.values(node_statuses).some(
      s => s === `running` || s === `queued` || s === `submitting`
    )
    const msg = has_active
      ? `There are active HPC jobs. Reset will cancel them and clear all results. Continue?`
      : `Reset all step statuses and results? This cannot be undone.`
    if (!confirm(msg)) return
    await exec.handle_reset(workflow_id)
  }

  function start_monitoring() {
    exec.start_monitoring(workflow_id, nodes)
  }

  function stop_monitoring() {
    exec.stop_monitoring()
  }

  // ─── Structure editing ───
  function open_structure_dialog(node_id: string) {
    const node = nodes.find(n => n.id === node_id)
    if (!node) return
    const def = NODE_DEFINITIONS[node.type]
    if (!def) return

    structure_dialog_node_id = node_id

    // Check if node already has a structure
    const existing = node.params.structure_json as string | undefined
    structure_dialog_json = existing || null

    if (node.type === 'structure_input') {
      structure_dialog_mode = existing ? 'edit' : 'import'
      structure_dialog_title = 'Structure Input'
    } else if (node.type === 'slab_gen') {
      structure_dialog_mode = 'view'
      structure_dialog_title = 'Slab Input Structure'
    } else if (node.type === 'adsorbate_place') {
      structure_dialog_mode = 'view'
      structure_dialog_title = 'Adsorbate Slab Structure'
    } else {
      structure_dialog_mode = 'view'
      structure_dialog_title = `${def.label} Structure`
    }

    show_structure_dialog = true
  }

  // ─── Freeze atom editing for freq nodes ───
  let freeze_edit_active = $state(false)
  let freeze_edit_node_id = $state<string | null>(null)
  let freeze_edit_frozen = $state<Set<number>>(new Set())

  function open_freeze_dialog(node_id: string) {
    const nd = nodes.find(n => n.id === node_id)
    if (!nd) return

    // Parse existing frozen indices
    const existing = String(nd.params.freeze_indices ?? ``)
    const frozen = new Set<number>()
    for (const part of existing.split(`,`)) {
      const trimmed = part.trim()
      if (!trimmed) continue
      if (trimmed.includes(`-`)) {
        const [a, b] = trimmed.split(`-`).map(Number)
        for (let i = a; i <= b; i++) frozen.add(i)
      } else {
        const n = parseInt(trimmed)
        if (!isNaN(n)) frozen.add(n)
      }
    }
    freeze_edit_node_id = node_id
    freeze_edit_frozen = frozen
    freeze_edit_active = true

    // Open the 3D editor with the upstream structure
    open_structure_edit_3d(node_id, `input`)
  }

  function handle_freeze_update(indices: number[]) {
    if (!freeze_edit_node_id) return
    freeze_edit_frozen = new Set(indices)
    const indices_str = indices.join(`,`)
    update_node_param(freeze_edit_node_id, `freeze_indices`, indices_str)
    schedule_save()
  }

  /** Apply freeze params to a structure JSON, setting selective_dynamics on sites */
  function apply_freeze_to_structure(struct_json: string | null, params: Record<string, unknown>): string | null {
    if (!struct_json) return null
    // Tolerate every spelling: explicit freeze_mode, or a bare frozen_layers /
    // freeze_layers / freeze_n_layers (the geo_opt/slab convention) which implies
    // bottom-layer freezing. Mirrors the backend's _freeze_n_bottom_layers.
    const n_bottom = Number(params.frozen_layers ?? params.freeze_layers ?? params.freeze_n_layers ?? 0)
    let mode = params.freeze_mode as string
    if ((!mode || mode === `none`) && n_bottom > 0) mode = `layers`
    if (!mode || mode === `none`) return struct_json

    try {
      const struct = JSON.parse(struct_json)
      if (!struct.sites?.length) return struct_json
      const n = struct.sites.length
      const frozen = new Set<number>()

      if (mode === `z_range`) {
        const z_lo = Number(params.freeze_z_below ?? 0)
        for (let i = 0; i < n; i++) {
          const z = struct.sites[i].xyz?.[2] ?? 0
          if (z < z_lo) frozen.add(i)
        }
      } else if (mode === `element`) {
        const elems = new Set(String(params.freeze_elements ?? ``).split(`,`).map(s => s.trim()).filter(Boolean))
        for (let i = 0; i < n; i++) {
          const el = struct.sites[i].species?.[0]?.element ?? struct.sites[i].label ?? ``
          if (elems.has(el)) frozen.add(i)
        }
      } else if (mode === `indices` || mode === `manual`) {
        for (const part of String(params.freeze_indices ?? ``).split(`,`)) {
          const t = part.trim()
          if (!t) continue
          if (t.includes(`-`)) {
            const [a, b] = t.split(`-`).map(Number)
            for (let i = a; i <= b; i++) frozen.add(i)
          } else {
            const v = parseInt(t)
            if (!isNaN(v)) frozen.add(v)
          }
        }
      } else if (mode === `layers` || mode === `bottom`) {
        const n_layers = n_bottom > 0 ? n_bottom : Number(params.freeze_layers ?? 0)
        if (n_layers > 0) {
          const zs = ([...new Set(struct.sites.map((s: any) => Math.round((s.xyz?.[2] ?? 0) * 100) / 100))] as number[]).sort((a, b) => a - b)
          const threshold = n_layers < zs.length ? (zs[n_layers - 1] + zs[n_layers]) / 2 : zs[zs.length - 1] + 0.1
          for (let i = 0; i < n; i++) {
            if ((struct.sites[i].xyz?.[2] ?? 0) < threshold) frozen.add(i)
          }
        }
      }

      // Apply invert
      let final_frozen = frozen
      if (params.freeze_invert && mode !== `none`) {
        final_frozen = new Set(Array.from({ length: n }, (_, i) => i).filter(i => !frozen.has(i)))
      }

      // Set selective_dynamics on sites
      for (let i = 0; i < n; i++) {
        const free = !final_frozen.has(i)
        struct.sites[i].properties = {
          ...(struct.sites[i].properties ?? {}),
          selective_dynamics: [free, free, free],
        }
      }
      return JSON.stringify(struct)
    } catch {
      return struct_json
    }
  }

  // Non-reactive cache for trajectory objects (avoids Svelte reactivity + serialization overhead)
  const trajectory_cache = new Map<string, TrajectoryType>()

  function handle_structure_confirm(data: { structure_json: string; trajectory?: TrajectoryType; n_frames?: number }) {
    if (!structure_dialog_node_id) return
    const node_id = structure_dialog_node_id
    // Extract formula and atom count from structure JSON for display
    let formula = ``
    let n_atoms = 0
    try {
      const parsed = JSON.parse(data.structure_json)
      const sites = parsed?.sites || []
      n_atoms = sites.length
      const counts: Record<string, number> = {}
      for (const site of sites) {
        const el = site.species?.[0]?.element || site.label || `?`
        counts[el] = (counts[el] || 0) + 1
      }
      formula = Object.entries(counts).map(([el, n]) => n === 1 ? el : `${el}${n}`).join(``)
    } catch { /* ignore */ }
    // Keys that are only relevant to adsorbate nodes, not structure_input
    const ADSORBATE_PARAM_KEYS = new Set([`species`, `mode`, `height`, `site_id`, `_species_idx`, `_custom_species`])
    nodes = nodes.map(n => {
      if (n.id !== node_id) return n
      // When re-importing a structure, remove stale adsorbate params
      const cleaned_params: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(n.params)) {
        if (!ADSORBATE_PARAM_KEYS.has(k)) cleaned_params[k] = v
      }
      const updated_params: Record<string, unknown> = { ...cleaned_params, structure_json: data.structure_json }
      if (formula) updated_params.formula = formula
      if (n_atoms) updated_params.n_atoms = n_atoms
      if (data.trajectory) {
        // Store trajectory object in non-reactive cache (NOT in params — too large for reactivity/serialization)
        trajectory_cache.set(node_id, data.trajectory)
        updated_params.n_frames = data.n_frames ?? 0
      } else {
        trajectory_cache.delete(node_id)
        delete updated_params.n_frames
        delete updated_params.frame_selection
      }
      // Never store trajectory in params
      delete updated_params.trajectory_json
      return { ...n, params: updated_params }
    })
    push_history()
    schedule_save()
    show_structure_dialog = false
    structure_dialog_node_id = null
    structure_dialog_json = null
  }

  // Node classification (is_vasp_node, is_hpc_node, etc.) imported from ./graph-model

  /** Wrapper: resolve_input_structure needs current nodes/edges */
  function resolve_input_structure(node_id: string): string | null {
    return _resolve_input_structure(node_id, nodes, edges)
  }

  /** Wrapper: resolve multiple structures from upstream (for multi-structure preview) */
  function resolve_input_structures(node_id: string): string[] | null {
    return _resolve_input_structures(node_id, nodes, edges)
  }

  /** Update a single param on a node (for HPC settings) */
  function update_node_param(node_id: string, key: string, value: unknown) {
    nodes = nodes.map(n => {
      if (n.id !== node_id) return n
      const params = { ...n.params }
      if (value === undefined || value === ``) {
        delete params[key]
      } else {
        params[key] = value
      }
      return { ...n, params }
    })
    push_history()
    schedule_save()
  }

  // get_display_params imported from ./graph-model

  async function open_slab_preview_3d(node_id: string) {
    const upstream_json = resolve_input_structure(node_id)
    if (!upstream_json) return
    const node = nodes.find(n => n.id === node_id)
    if (!node) return
    try {
      const structure = JSON.parse(upstream_json) as PymatgenStructure
      const { miller, layers, vacuum, supercell, termination } = parse_slab_gen_params(node.params)

      const { wasm_generate_slab_layers, is_ok } = await import(`$lib/structure/ferrox-wasm`)
      const { matrix_to_params, ensure_right_handed } = await import(`$lib/structure/lattice-ops`)
      const { deduplicate_periodic_images } = await import(`$lib/structure/pbc`)

      const result = await wasm_generate_slab_layers(structure, miller, {
        num_layers: layers, termination_index: termination, vacuum, supercell,
      })
      if (!is_ok(result)) return

      let slab = result.ok as PymatgenStructure
      if (slab?.lattice?.matrix) {
        type V3 = [number, number, number]
        const { matrix: m, swapped } = ensure_right_handed(slab.lattice.matrix as [V3, V3, V3])
        const p = matrix_to_params(m)
        const [va, vb, vc] = m
        const cx = vb[1] * vc[2] - vb[2] * vc[1], cy = vb[2] * vc[0] - vb[0] * vc[2], cz = vb[0] * vc[1] - vb[1] * vc[0]
        const vol = Math.abs(va[0] * cx + va[1] * cy + va[2] * cz)
        const sites = swapped && slab.sites
          ? slab.sites.map((s: any) => ({ ...s, abc: s.abc ? [s.abc[1], s.abc[0], s.abc[2]] : s.abc }))
          : slab.sites
        slab = {
          ...slab, sites,
          lattice: { ...slab.lattice, matrix: m, a: p.a, b: p.b, c: p.c, alpha: p.alpha, beta: p.beta, gamma: p.gamma, volume: vol, pbc: [true, true, false] as [boolean, boolean, boolean] },
        }
        slab = deduplicate_periodic_images(slab as any) as PymatgenStructure
      }

      edit_3d_node_id = node_id
      edit_3d_label = `Slab Preview — (${miller.join(``)})`
      edit_3d_readonly = false
      edit_3d_structure = slab
      edit_3d_bulk = structure  // upstream bulk for passivation
      edit_3d_is_trajectory = false
      edit_3d_trajectory = undefined
      edit_3d_vibration = null
      edit_3d_scene_props = undefined
      show_structure_edit_3d = true
      if (!StructureEditorComponent) {
        const mod = await import(`$lib/structure/Structure.svelte`)
        StructureEditorComponent = mod.default
      }
    } catch (err) {
      console.error(`[slab-preview-3d]`, err)
    }
  }

  // ─── Structure 3D Edit Pane ───
  let show_structure_edit_3d = $state(false)
  let edit_3d_structure = $state.raw<PymatgenStructure | null>(null)
  let edit_3d_trajectory = $state.raw<import('$lib/trajectory').TrajectoryType | undefined>(undefined)
  let edit_3d_initial_generated = $state.raw<import('$lib/trajectory').TrajectoryType | undefined>(undefined)
  let edit_3d_is_trajectory = $state(false)
  let edit_3d_node_id = $state<string | null>(null)
  let edit_3d_label = $state(``)
  let edit_3d_readonly = $state(false)
  let edit_3d_vibration = $state.raw<{ eigenvector: number[][]; base_positions: number[][]; amplitude: number; playing: boolean } | null>(null)
  let edit_3d_scene_props = $state<Record<string, unknown> | undefined>(undefined)
  let edit_3d_bulk = $state.raw<PymatgenStructure | null>(null)
  let edit_3d_initial_panel = $state<`hpc` | `chat` | `terminal` | `doping` | undefined>(undefined)
  let edit_3d_adsorption_sites = $state.raw<import('$lib/structure/ferrox-wasm-types').AdsorptionSite[]>([])
  let edit_3d_on_site_picked = $state<((site_idx: number) => PymatgenStructure | null) | null>(null)
  let edit_3d_on_confirm = $state<((final_struct: PymatgenStructure) => void) | null>(null)
  let edit_3d_site_confirmed = $state(false)
  let edit_3d_preview_banner = $state(false)

  // Energy diagram modal state
  let show_energy_diagram = $state(false)
  let energy_diagram_node_id = $state<string | null>(null)
  let energy_diagram_pathways = $state.raw<any[]>([])

  function open_energy_diagram(node_id: string) {
    const node = nodes.find(n => n.id === node_id)
    if (!node) return
    try {
      energy_diagram_pathways = JSON.parse(node.params.pathways as string ?? `[]`)
    } catch { energy_diagram_pathways = [] }
    energy_diagram_node_id = node_id
    show_energy_diagram = true
  }

  // Dedicated doping modal state
  let show_doping_modal = $state(false)
  let doping_modal_structure = $state<any>(null)
  let doping_modal_node_id = $state<string | null>(null)
  let StructureEditorComponent = $state<typeof import('$lib/structure/Structure.svelte').default | null>(null)
  let TrajectoryEditorComponent = $state<typeof import('$lib/trajectory/Trajectory.svelte').default | null>(null)

  async function open_structure_edit_3d(node_id: string, source: `own` | `input` | `output` = `own`) {
    const node = nodes.find(n => n.id === node_id)
    if (!node) return

    let structure_json: string | null = null
    let is_readonly = false
    let label = (node.params.formula as string) || NODE_DEFINITIONS[node.type]?.label || `Structure`

    if (source === `own`) {
      structure_json = (node.params.structure_json as string) || null
      // Fallback: if no own structure, try resolving input structure (e.g. adsorbate_place before placement)
      if (!structure_json && has_structure_io(node.type)) {
        structure_json = resolve_input_structure(node_id)
        if (structure_json) {
          // Adsorbate nodes need editing (placement), not read-only view
          const editable_types = new Set([`adsorbate_place`, `slab_gen`])
          if (!editable_types.has(node.type)) {
            label += ` — Input`
            is_readonly = true
          }
        }
      }
    } else if (source === `input`) {
      structure_json = resolve_input_structure(node_id)
      label += ` — Input`
      is_readonly = true
    } else if (source === `output`) {
      if (!workflow_id) {
        alert(`View Output Structure: workflow not yet saved — cannot fetch results.`)
        return
      }
      console.info(`[view-output] resolving output structure for node ${node_id}`)

      // Helper: parse text payload (pymatgen JSON / XYZ / POSCAR) into structure_json
      const parse_text_to_struct_json = async (raw: string): Promise<string | null> => {
        const trimmed = raw.trim()
        if (!trimmed) return null
        // Already pymatgen JSON
        if (trimmed.startsWith(`{`) || trimmed.startsWith(`[`)) {
          try {
            const obj = JSON.parse(trimmed)
            if (obj && typeof obj === `object` && `sites` in obj) return trimmed
          } catch { /* fall through to text parsers */ }
        }
        // XYZ if first line is just an atom count; otherwise treat as POSCAR
        const first_line = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? ``
        const is_xyz = /^\d+$/.test(first_line)
        const { parse_xyz, parse_poscar } = await import(`$lib/structure/parse`)
        const parsed = is_xyz ? parse_xyz(trimmed) : parse_poscar(trimmed)
        return parsed ? JSON.stringify(parsed) : null
      }

      // Try 1: V1 step result_json (local nodes like doping_gen)
      try {
        const resp = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/steps`)
        if (resp.ok) {
          const steps: any[] = await resp.json()
          const step = steps.find((s: any) => s.id === node_id)
          if (step?.result_json) {
            const result = typeof step.result_json === `string` ? JSON.parse(step.result_json) : step.result_json
            if (result?.structure) {
              structure_json = typeof result.structure === `string`
                ? (await parse_text_to_struct_json(result.structure)) ?? result.structure
                : JSON.stringify(result.structure)
            } else if (result?.contcar) {
              structure_json = await parse_text_to_struct_json(result.contcar)
            }
          }
        }
      } catch (err) { console.error(`[view-output] V1 step fetch error:`, err) }

      // Try 2: V2 engine task result (NEB-TS converged XYZ lands in structure_json column).
      // V2 engine never writes to workflow_steps so Try 1 returns nothing for V2 tasks.
      if (!structure_json) {
        try {
          const resp = await fetch(
            `${API_BASE}/engine/tasks/${encodeURIComponent(`${workflow_id}:${node_id}`)}/result`
          )
          if (resp.ok) {
            const row: any = await resp.json()
            const raw = row?.structure_json
            if (typeof raw === `string` && raw.trim().length > 0) {
              structure_json = await parse_text_to_struct_json(raw)
              if (!structure_json) {
                console.error(`[view-output] V2 structure_json present (${raw.length} bytes) but parsers returned null`,
                  { preview: raw.slice(0, 200) })
              } else {
                console.info(`[view-output] resolved from V2 engine task result`)
              }
            }
            // Also check outputs_json for an inlined `structure` (forward-compat with future ORCA collectors)
            if (!structure_json && typeof row?.outputs_json === `string`) {
              try {
                const outputs = JSON.parse(row.outputs_json)
                if (outputs?.structure) {
                  structure_json = typeof outputs.structure === `string`
                    ? (await parse_text_to_struct_json(outputs.structure)) ?? outputs.structure
                    : JSON.stringify(outputs.structure)
                }
              } catch { /* malformed outputs_json */ }
            }
          }
        } catch (err) { console.error(`[view-output] V2 engine task result fetch error:`, err) }
      }

      // Try 3: Load CONTCAR from HPC work directory (VASP/MLP remote nodes)
      if (!structure_json) {
        try {
          const data = await api.get_step_output(workflow_id, node_id, `CONTCAR`)
          if (data?.content) {
            structure_json = await parse_text_to_struct_json(data.content)
          }
        } catch { /* CONTCAR not available */ }
      }

      label += ` — Output`
      is_readonly = true
    }

    if (!structure_json) {
      const msg = source === `output`
        ? `View Output Structure: no geometry available for this task.\n\nLikely cause: the calculation completed but the backend did not extract an output geometry (HPC connection may have dropped, or the converged file was not produced).\n\nCheck the task's work directory or rerun the task.`
        : `View Structure: no geometry data found for this node.`
      console.error(`[view-output] all resolution paths failed for node ${node_id} (source=${source})`)
      alert(msg)
      return
    }

    try {
      edit_3d_node_id = node_id
      edit_3d_label = label
      edit_3d_readonly = is_readonly
      edit_3d_is_trajectory = false
      edit_3d_trajectory = undefined
      edit_3d_initial_generated = undefined
      edit_3d_bulk = null
      edit_3d_structure = JSON.parse(structure_json)

      if (!StructureEditorComponent) {
        const mod = await import(`$lib/structure/Structure.svelte`)
        StructureEditorComponent = mod.default
      }

      // If there's a cached trajectory (from prior doping generation), pass it as initial_generated
      if (source === `own`) {
        const cached_traj = trajectory_cache.get(node_id)
        const n_frames = node.params.n_frames as number
        if (cached_traj && n_frames > 1) {
          edit_3d_initial_generated = cached_traj
          if (!TrajectoryEditorComponent) {
            const mod = await import(`$lib/trajectory/Trajectory.svelte`)
            TrajectoryEditorComponent = mod.default
          }
        }
      }

      // Show modal AFTER all state is ready
      show_structure_edit_3d = true
    } catch (err) {
      console.error(`[view-output] failed to open 3D editor:`, err, { structure_json_preview: structure_json?.slice(0, 200) })
      alert(`View Output Structure: failed to open the 3D editor — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function save_and_close_edit_3d(generated?: import('$lib/trajectory').TrajectoryType) {
    if (edit_3d_readonly) { close_edit_3d(); return }
    if (edit_3d_node_id) {
      structure_dialog_node_id = edit_3d_node_id
      // Save original structure (always preserved)
      const original_json = edit_3d_structure
        ? JSON.stringify(edit_3d_structure)
        : (nodes.find(n => n.id === edit_3d_node_id)?.params?.structure_json as string)
      // Use generated trajectory passed from modal, or fall back to edit_3d_trajectory
      const traj = generated ?? edit_3d_trajectory
      if (traj) {
        handle_structure_confirm({
          structure_json: original_json,
          trajectory: traj,
          n_frames: traj.total_frames ?? traj.frames?.length ?? 0,
        })
      } else if (original_json) {
        handle_structure_confirm({ structure_json: original_json })
      }
      // Lock slab nodes after manual edit to prevent auto-regeneration from overwriting
      const nd = nodes.find(n => n.id === edit_3d_node_id)
      if (nd?.type === `slab_gen`) {
        update_node_param(edit_3d_node_id, `slab_locked`, true)
      }
    }
    show_structure_edit_3d = false
    edit_3d_node_id = null
  }

  function close_edit_3d() {
    show_structure_edit_3d = false
    edit_3d_node_id = null
    edit_3d_readonly = false
    edit_3d_vibration = null
    edit_3d_scene_props = undefined
    edit_3d_initial_panel = undefined
    edit_3d_adsorption_sites = []
    edit_3d_on_site_picked = null
    edit_3d_on_confirm = null
    edit_3d_site_confirmed = false
    edit_3d_preview_banner = false
  }

  let show_vasp_editor = $state(false)
  let vasp_editor_tab = $state<`incar` | `kpoints` | `poscar`>(`incar`)
  let vasp_incar_content = $state(``)
  let vasp_kpoints_content = $state(``)
  let vasp_poscar_content = $state(``)
  let vasp_editor_node_id = $state<string | null>(null)
  let vasp_generating = $state(false)
  let vasp_error = $state(``)

  // get_vasp_calc_type, parse_kpoints_str imported from ./graph-model

  async function open_vasp_editor(node_id: string) {
    const node = nodes.find(n => n.id === node_id)
    if (!node) return
    vasp_editor_node_id = node_id
    vasp_generating = true
    vasp_error = ``
    show_vasp_editor = true
    vasp_editor_tab = `incar`

    // Check if user has custom INCAR content already
    if (node.params.custom_incar_text) {
      vasp_incar_content = node.params.custom_incar_text as string
      vasp_kpoints_content = (node.params.custom_kpoints_text as string) || ``
      vasp_poscar_content = ``
      vasp_generating = false
      return
    }

    // Try to find a parent structure for VASP generation
    let structure_json: string | null = null
    for (const edge of edges) {
      if (edge.to === node_id) {
        const parent = nodes.find(n => n.id === edge.from)
        if (parent?.params?.structure_json) {
          structure_json = parent.params.structure_json as string
          break
        }
      }
    }

    if (!structure_json) {
      // Generate INCAR text from params only (no POSCAR/KPOINTS without structure)
      const p = node.params
      const lines: string[] = [`# INCAR generated from workflow node params`, `# Node: ${NODE_DEFINITIONS[node.type]?.label || node.type}`, ``]
      const incar_keys = [`ENCUT`, `EDIFF`, `EDIFFG`, `ISIF`, `NSW`, `IBRION`, `ISMEAR`, `SIGMA`, `ISPIN`, `PREC`, `NCORE`, `LWAVE`, `LCHARG`, `LORBIT`, `NEDOS`, `NBANDS`, `ALGO`, `POTIM`, `TEBEG`, `TEEND`, `SMASS`, `NFREE`]
      for (const key of incar_keys) {
        if (p[key] !== undefined && p[key] !== null && p[key] !== ``) {
          lines.push(`${key} = ${p[key]}`)
        }
      }
      vasp_incar_content = lines.join(`\n`)
      vasp_kpoints_content = p.kpoints ? `Automatic mesh\n0\nGamma\n${String(p.kpoints).replace(/[×x,]/g, ` `)}\n0 0 0` : ``
      vasp_poscar_content = `# No input structure available.\n# Import a structure to the upstream structure_input node first.`
      vasp_generating = false
      return
    }

    try {
      const structure = JSON.parse(structure_json)
      const p = node.params
      const request: any = {
        structure,
        calculation_type: get_vasp_calc_type(node.type),
        encut: p.ENCUT ?? 520,
        ediff: typeof p.EDIFF === `string` ? parseFloat(p.EDIFF) : (p.EDIFF ?? 1e-5),
        ispin: p.ISPIN ?? undefined,
        ismear: p.ISMEAR ?? undefined,
        nsw: p.NSW ?? undefined,
        isif: p.ISIF ?? undefined,
        ibrion: p.IBRION ?? undefined,
        ediffg: p.EDIFFG ?? undefined,
        ncore: p.NCORE ?? undefined,
        lwave: p.LWAVE ?? undefined,
        lcharg: p.LCHARG ?? undefined,
        lorbit: p.LORBIT ?? undefined,
        kpoints: parse_kpoints_str(p.kpoints),
      }
      // Remove undefined values
      for (const key of Object.keys(request)) {
        if (request[key] === undefined) delete request[key]
      }
      const result = await generateVASPInputs(request)
      vasp_incar_content = result.incar
      vasp_kpoints_content = result.kpoints
      vasp_poscar_content = result.poscar
    } catch (err: any) {
      vasp_error = err?.message || String(err)
      vasp_incar_content = `# Error generating VASP inputs: ${vasp_error}`
      vasp_kpoints_content = ``
      vasp_poscar_content = ``
    } finally {
      vasp_generating = false
    }
  }

  function save_vasp_editor() {
    if (!vasp_editor_node_id) return
    // Save the current editor content as custom text override in node params
    // Also sync INCAR keys back to node.params so the canvas display updates
    const synced_params: Record<string, unknown> = {}
    const sync_keys = new Set([`ENCUT`, `EDIFF`, `EDIFFG`, `ISIF`, `NSW`, `IBRION`, `ISMEAR`, `SIGMA`, `ISPIN`, `NCORE`, `ALGO`, `PREC`, `LORBIT`, `NEDOS`, `NBANDS`, `IVDW`, `LWAVE`, `LCHARG`])
    for (const line of vasp_incar_content.split(`\n`)) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/)
      if (!m) continue
      const [, key, raw] = m
      if (!sync_keys.has(key)) continue
      // Parse .TRUE./.FALSE. as boolean, numbers as numbers, rest as string
      const lower = raw.toLowerCase()
      if (lower === `.true.` || lower === `true`) synced_params[key] = true
      else if (lower === `.false.` || lower === `false`) synced_params[key] = false
      else { const num = Number(raw); synced_params[key] = isNaN(num) ? raw : num }
    }
    nodes = nodes.map(n => {
      if (n.id !== vasp_editor_node_id) return n
      return { ...n, params: {
        ...n.params,
        ...synced_params,
        custom_incar_text: vasp_incar_content,
        custom_kpoints_text: vasp_kpoints_content || undefined,
      }}
    })
    push_history()
    schedule_save()
    show_vasp_editor = false
    vasp_editor_node_id = null
  }

  function close_vasp_editor() {
    show_vasp_editor = false
    vasp_editor_node_id = null
  }

  /** Minimal markdown → HTML for help text */
  function render_help(text: string): string {
    return text
      .replace(/&/g, `&amp;`).replace(/</g, `&lt;`).replace(/>/g, `&gt;`)
      .replace(/\*\*(.+?)\*\*/g, `<strong>$1</strong>`)
      .replace(/\*(.+?)\*/g, `<em>$1</em>`)
      .replace(/`(.+?)`/g, `<code>$1</code>`)
      .replace(/\n/g, `<br>`)
  }

  // ─── Calculation Type switcher ───
  let calc_help_visible = $state<string | null>(null)

  /** Change a unified calc node's type (e.g. geo_opt → single_point) */
  function change_calc_type(node_id: string, new_type: string) {
    const node = nodes.find(n => n.id === node_id)
    if (!node || node.type === new_type) return
    const new_def = NODE_DEFINITIONS[new_type]
    if (!new_def) return

    // Preserve shared params (software, system_type, HPC settings, etc.)
    const shared_keys = new Set([`software`, `system_type`, `hpc_session_id`, `job_script`, `job_script_id`, `vasp_executable`])
    const preserved: Record<string, unknown> = {}
    for (const k of shared_keys) {
      if (node.params[k] !== undefined) preserved[k] = node.params[k]
    }

    // Validate preserved software against new node's available options
    if (preserved.software && new_def.param_schema) {
      const sw_param = new_def.param_schema.find((p: any) => p.key === `software`)
      if (sw_param?.options) {
        const valid_sw = new Set(sw_param.options.map((o: any) => o.value))
        if (!valid_sw.has(preserved.software)) delete preserved.software
      }
    }

    // Merge: new defaults + preserved shared params
    const new_params = { ...(new_def.default_params ?? {}), ...preserved }

    // Update node type and params
    nodes = nodes.map(n => {
      if (n.id !== node_id) return n
      return { ...n, type: new_type, params: new_params }
    })

    // Remove edges whose handles no longer exist on the new definition
    const valid_inputs = new Set(new_def.inputs)
    const valid_outputs = new Set(new_def.outputs)
    edges = edges.filter(e => {
      if (e.to === node_id && e.toH && !valid_inputs.has(e.toH)) return false
      if (e.from === node_id && e.fromH && !valid_outputs.has(e.fromH)) return false
      return true
    })

    push_history()
    schedule_save()
  }

  // ─── Tool Type switcher ───
  let tool_help_visible = $state<string | null>(null)

  /** Change a unified tool node's type (e.g. slab_gen → adsorbate_place) */
  function change_tool_type(node_id: string, new_type: string) {
    const node = nodes.find(n => n.id === node_id)
    if (!node || node.type === new_type) return
    const new_def = NODE_DEFINITIONS[new_type]
    if (!new_def) return

    const new_params = { ...(new_def.default_params ?? {}) }

    nodes = nodes.map(n => {
      if (n.id !== node_id) return n
      return { ...n, type: new_type, params: new_params }
    })

    const valid_inputs = new Set(new_def.inputs)
    const valid_outputs = new Set(new_def.outputs)
    edges = edges.filter(e => {
      if (e.to === node_id && e.toH && !valid_inputs.has(e.toH)) return false
      if (e.from === node_id && e.fromH && !valid_outputs.has(e.fromH)) return false
      return true
    })

    push_history()
    schedule_save()
  }

  // ─── Analysis Type switcher ───
  let analysis_help_visible = $state<string | null>(null)

  /** Change a unified analysis node's type (e.g. dos_analysis → free_energy) */
  function change_analysis_type(node_id: string, new_type: string) {
    const node = nodes.find(n => n.id === node_id)
    if (!node || node.type === new_type) return
    const new_def = NODE_DEFINITIONS[new_type]
    if (!new_def) return

    const new_params = { ...(new_def.default_params ?? {}) }

    nodes = nodes.map(n => {
      if (n.id !== node_id) return n
      return { ...n, type: new_type, params: new_params }
    })

    // Remove edges whose handles no longer exist on the new definition
    const valid_inputs = new Set(new_def.inputs)
    const valid_outputs = new Set(new_def.outputs)
    edges = edges.filter(e => {
      if (e.to === node_id && e.toH && !valid_inputs.has(e.toH)) return false
      if (e.from === node_id && e.fromH && !valid_outputs.has(e.fromH)) return false
      return true
    })

    push_history()
    schedule_save()
  }

  // ─── Generic input file editor (ORCA, CP2K, LAMMPS) ───
  let show_input_editor = $state(false)
  let input_editor_content = $state(``)
  let input_editor_node_id = $state<string | null>(null)
  let input_editor_software = $state<string>(``)
  let input_editor_filename = $state<string>(``)
  let input_editor_generating = $state(false)
  let input_editor_error = $state(``)
  /** Incremented on every open so {#key} always recreates Monaco fresh. */
  let input_editor_open_count = $state(0)

  /** Map software to its input file name and param key */
  const INPUT_FILE_CONFIG: Record<string, { filename: string; param_key: string; label: string }> = {
    orca: { filename: `ORCA.inp`, param_key: `custom_inp_text`, label: `ORCA Input` },
    cp2k: { filename: `project.inp`, param_key: `custom_inp_text`, label: `CP2K Input` },
    lammps: { filename: `in.lammps`, param_key: `custom_input_text`, label: `LAMMPS Input Script` },
  }

  async function open_input_editor(node_id: string, software: string) {
    const node = nodes.find(n => n.id === node_id)
    if (!node) return
    const cfg = INPUT_FILE_CONFIG[software]
    if (!cfg) return

    input_editor_node_id = node_id
    input_editor_software = software
    input_editor_filename = cfg.filename
    input_editor_generating = true
    input_editor_error = ``
    // Reset content and bump counter so Monaco always gets a fresh instance with
    // up-to-date content, regardless of what was shown in previous opens.
    input_editor_content = ``
    input_editor_open_count += 1
    show_input_editor = true

    // Check if user already has custom text saved
    const existing = node.params[cfg.param_key] as string | undefined
    if (existing) {
      input_editor_content = existing
      input_editor_generating = false
      return
    }

    // Generate input file preview from params via backend API
    try {
      let structure_json: string | null = null
      let structure_product_json: string | null = null

      for (const edge of edges) {
        if (edge.to !== node_id) continue
        const parent = nodes.find(n => n.id === edge.from)
        if (!parent) continue

        // Try params first (structure_input nodes), then cached results, then fetch from backend
        let parent_struct: string | null = (parent.params?.structure_json as string | undefined)
          || task_results[parent.id]?.structure_json
          || null
        // If not cached, try fetching from backend (parent may have completed but results not yet polled)
        if (!parent_struct && workflow_id) {
          try {
            const result = await exec.fetch_task_results(workflow_id, parent.id)
            if (result?.structure_json) {
              parent_struct = result.structure_json
            }
          } catch { /* ignore — will show "no structure" fallback */ }
        }
        if (!parent_struct) continue

        // Use toH to distinguish reactant vs product input
        // in-1 = product structure (NEB/IRC); everything else (in-0, "structure", undefined) = primary
        if (edge.toH === 'in-1') {
          structure_product_json = parent_struct
        } else {
          if (!structure_json) {
            structure_json = parent_struct
          }
        }
      }

      const resp = await fetch(`${API_BASE}/workflow/preview-input`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({
          software,
          node_type: node.type,
          params: node.params,
          structure_json,
          structure_product_json,
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (resp.ok) {
        const data = await resp.json()
        const c = typeof data?.content === `string` ? data.content : ``
        if (c.trim().length === 0) {
          // Backend returned blank — show an informative fallback so Monaco is never empty.
          const pt = (node.params?.potential_type as string | undefined) ?? `unknown`
          input_editor_content = [
            `# Preview unavailable for ${node.type} (software: ${software})`,
            `# potential_type: ${pt}`,
            `#`,
            `# The backend returned an empty script. This can happen when no structure`,
            `# is connected to the node. You can edit this file manually and save it`,
            `# to the node — it will be used as-is during execution.`,
          ].join(`\n`) + `\n`
        } else {
          input_editor_content = c
        }
      } else {
        input_editor_content = `# ${cfg.label}\n# Edit this file directly. It will be used as-is during execution.\n`
      }
    } catch (err) {
      const msg = err instanceof DOMException && err.name === `TimeoutError`
        ? `Backend did not respond in time. Make sure the Python server is running.`
        : err instanceof TypeError
          ? `Could not connect to backend. Make sure the Python server is running.`
          : `Could not generate preview.`
      input_editor_content = `# ${cfg.label}\n# ${msg}\n# You can edit this file directly — it will be used as-is during execution.\n`
    } finally {
      input_editor_generating = false
    }
  }

  function save_input_editor() {
    if (!input_editor_node_id || !input_editor_software) return
    const cfg = INPUT_FILE_CONFIG[input_editor_software]
    if (!cfg) return
    nodes = nodes.map(n => {
      if (n.id !== input_editor_node_id) return n
      return { ...n, params: { ...n.params, [cfg.param_key]: input_editor_content } }
    })
    push_history()
    schedule_save()
    show_input_editor = false
    input_editor_node_id = null
  }

  function close_input_editor() {
    show_input_editor = false
    input_editor_node_id = null
  }

  // ─── File browser/editor for step output files ───
  let show_file_browser = $state(false)
  let file_browser_files = $state<Array<{ name: string; size: string; modified: string }>>([])
  let file_browser_work_dir = $state(``)
  let file_browser_node_id = $state<string | null>(null)
  let file_browser_session_id = $state(``)
  let file_browser_loading = $state(false)
  let file_browser_content = $state(``)
  let file_browser_filename = $state(``)
  let file_browser_file_path = $state(``)
  let file_browser_view = $state<`list` | `editor`>(`list`)

  async function open_file_browser(node_id: string) {
    if (!workflow_id) return
    file_browser_node_id = node_id
    file_browser_loading = true
    file_browser_view = `list`
    show_file_browser = true
    try {
      const data = await api.get_step_files(workflow_id, node_id)
      file_browser_files = data.files || []
      file_browser_work_dir = data.work_dir || ``
      // Get session ID from step info
      const steps = await api.list_steps(workflow_id)
      const step = steps.find((s: any) => s.id === node_id)
      file_browser_session_id = step?.hpc_session_id || ``
    } catch (err: any) {
      file_browser_files = []
      console.error(`[open_file_browser] Error loading files:`, err?.message || String(err))
    } finally {
      file_browser_loading = false
    }
  }

  async function open_file_in_editor(filename: string) {
    if (!workflow_id || !file_browser_node_id) return
    file_browser_loading = true
    try {
      const data = await api.get_step_output(workflow_id, file_browser_node_id, filename)
      file_browser_content = data.content || ``
      file_browser_filename = filename
      file_browser_file_path = file_browser_work_dir ? `${file_browser_work_dir}/${filename}` : ``
      file_browser_view = `editor`
    } catch (err: any) {
      cycle_warning = `Failed to read ${filename}: ${err?.message}`
      setTimeout(() => cycle_warning = null, 5000)
    } finally {
      file_browser_loading = false
    }
  }

  /** Load a structure file (CONTCAR/POSCAR/etc.) from step output into the 3D viewer. */
  async function handle_load_structure(node_id: string, filename: string) {
    try {
      const data = await api.get_step_output(workflow_id, node_id, filename)
      if (!data?.content) return
      const { parse_poscar } = await import(`$lib/structure/parse`)
      const parsed = parse_poscar(data.content)
      if (!parsed) return
      const nd = nodes.find(n => n.id === node_id)
      edit_3d_node_id = node_id
      edit_3d_label = `${nd?.params?.label ?? filename} — ${filename}`
      edit_3d_readonly = true
      edit_3d_is_trajectory = false
      edit_3d_trajectory = undefined
      edit_3d_structure = JSON.parse(JSON.stringify(parsed))
      show_structure_edit_3d = true
      if (!StructureEditorComponent) {
        const mod = await import(`$lib/structure/Structure.svelte`)
        StructureEditorComponent = mod.default
      }
    } catch (err: any) {
      cycle_warning = `Failed to load ${filename}: ${err?.message}`
      setTimeout(() => cycle_warning = null, 5000)
    }
  }

  /** Build a PymatgenStructure from StepForces data, injecting forces into site properties. */
  async function build_force_structure(data: StepForces): Promise<PymatgenStructure> {
    if (!data.forces?.length) throw new Error(`No force vectors in response`)
    let struct: PymatgenStructure | null = null
    if (data.structure_content) {
      const { parse_poscar } = await import(`$lib/structure/parse`)
      struct = parse_poscar(data.structure_content) as PymatgenStructure | null
    }
    if (!struct?.sites) throw new Error(`No structure file found (CONTCAR/POSCAR missing)`)
    // Deep clone to avoid shared references across frames
    struct = JSON.parse(JSON.stringify(struct))
    for (let i = 0; i < struct!.sites.length && i < data.forces.length; i++) {
      struct!.sites[i].properties = { ...struct!.sites[i].properties, force: data.forces[i] }
    }
    if (data.positions?.length === struct!.sites.length) {
      for (let i = 0; i < struct!.sites.length; i++) {
        struct!.sites[i].xyz = data.positions[i] as [number, number, number]
      }
    }
    return struct!
  }

  const FORCE_SCENE_PROPS = {
    show_force_vectors: true,
    force_scale: 20,
    force_shaft_radius: 0.06,
    force_arrow_head_radius: 0.15,
    force_arrow_head_length: 0.25,
  }

  /** Load forces into 3D viewer. Single frame → Structure, multi-frame → Trajectory. */
  async function handle_load_forces(frames: StepForces[]) {
    const nd = selected_node
    edit_3d_node_id = nd?.id ?? null
    edit_3d_readonly = true
    edit_3d_scene_props = FORCE_SCENE_PROPS

    if (frames.length === 1) {
      // Single frame: structure mode
      const struct = await build_force_structure(frames[0])
      edit_3d_label = `Forces — Step ${frames[0].step}`
      edit_3d_is_trajectory = false
      edit_3d_trajectory = undefined
      edit_3d_structure = struct
    } else {
      // Multi-frame: trajectory mode
      const traj_frames = await Promise.all(
        frames.map(async (f) => ({
          structure: await build_force_structure(f) as import('$lib').AnyStructure,
          step: f.step,
          metadata: { energy: 0 },
        }))
      )
      edit_3d_label = `Forces — Steps ${frames[0].step}-${frames[frames.length - 1].step}`
      edit_3d_is_trajectory = true
      edit_3d_trajectory = { frames: traj_frames, total_frames: traj_frames.length }
      edit_3d_structure = null
    }

    show_structure_edit_3d = true
    if (frames.length > 1) {
      if (!TrajectoryEditorComponent) {
        const mod = await import(`$lib/trajectory/Trajectory.svelte`)
        TrajectoryEditorComponent = mod.default
      }
    } else {
      if (!StructureEditorComponent) {
        const mod = await import(`$lib/structure/Structure.svelte`)
        StructureEditorComponent = mod.default
      }
    }
  }

  /** Export the current workflow graph as a JSON file. */
  function handle_export_json() {
    const payload = {
      name: workflow_name,
      nodes,
      edges,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: `application/json` })
    const url = URL.createObjectURL(blob)
    const a = document.createElement(`a`)
    a.href = url
    const safe_name = (workflow_name || `workflow`).replace(/[^a-z0-9_-]+/gi, `_`)
    a.download = `${safe_name}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  /** Download a file from step output via browser download. */
  async function handle_download_file(node_id: string, filename: string) {
    try {
      const data = await api.get_step_output(workflow_id, node_id, filename)
      if (!data?.content) return
      const blob = new Blob([data.content], { type: `text/plain` })
      const url = URL.createObjectURL(blob)
      const a = document.createElement(`a`)
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      cycle_warning = `Failed to download ${filename}: ${err?.message}`
      setTimeout(() => cycle_warning = null, 5000)
    }
  }

  /**
   * Open detached panel in a new window.
   * - No selection → follow mode (tracks whatever node the user clicks)
   * - Node selected → pinned mode (locked to that node; allows multiple windows)
   */
  async function popout_status() {
    if (!workflow_id) return
    const nd = selected_node
    const cfg = nd ? NODE_DEFINITIONS[nd.type] : null
    const params = new URLSearchParams()
    params.set(`wf`, workflow_id)
    params.set(`tab`, right_panel)
    let win_id: string
    let title: string
    if (nd) {
      // Pinned mode — write full context so popout can read on init
      const upstream = has_structure_io(nd.type) ? resolve_input_structure(nd.id) : null
      const ctx_data = {
        workflow_id,
        node_id: nd.id,
        node_type: nd.type,
        node_label: (nd.params?.label as string) || cfg?.label || nd.type,
        status: node_statuses[nd.id] ?? ``,
        node_params: nd.params ?? {},
        upstream_structure_json: upstream,
      }
      write_pinned(nd.id, ctx_data)
      params.set(`mode`, `pinned`)
      params.set(`node`, nd.id)
      title = (nd.params?.label as string) || cfg?.label || nd.type
      win_id = `popout-${nd.id.replace(/[^a-zA-Z0-9]/g, ``)}`
    } else {
      // Follow mode — reads last selection from localStorage on init
      params.set(`mode`, `follow`)
      title = `Workflow Panel`
      win_id = `catgo-popout-follow`
    }
    const url = `${window.location.origin}${window.location.pathname}#status?${params}`
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      // Verify Tauri runtime is actually available (not just the npm package)
      if (typeof (window as any).__TAURI_INTERNALS__ !== `undefined`) {
        new WebviewWindow(win_id, { url, title, width: 480, height: 680 })
      } else {
        window.open(url, win_id, `width=480,height=680,resizable=yes`)
      }
    } catch {
      window.open(url, win_id, `width=480,height=680,resizable=yes`)
    }
  }

  // Broadcast selection to popout whenever selected node changes
  $effect(() => {
    const nd = selected_node
    if (!nd || !workflow_id) return
    const cfg = NODE_DEFINITIONS[nd.type]
    const upstream = has_structure_io(nd.type) ? resolve_input_structure(nd.id) : null
    broadcast_selection({
      workflow_id,
      node_id: nd.id,
      node_type: nd.type,
      node_label: (nd.params?.label as string) || cfg?.label || nd.type,
      status: node_statuses[nd.id] ?? ``,
      node_params: nd.params ?? {},
      upstream_structure_json: upstream,
    })
  })

  // Broadcast status updates to popout whenever node_statuses change
  $effect(() => {
    if (!workflow_id) return
    const statuses = node_statuses
    for (const nd of nodes) {
      if (!statuses[nd.id]) continue
      const cfg = NODE_DEFINITIONS[nd.type]
      const upstream = has_structure_io(nd.type) ? resolve_input_structure(nd.id) : null
      broadcast_status({
        workflow_id,
        node_id: nd.id,
        node_type: nd.type,
        node_label: (nd.params?.label as string) || cfg?.label || nd.type,
        status: statuses[nd.id] ?? ``,
        node_params: nd.params ?? {},
        upstream_structure_json: upstream,
      })
    }
  })

  // Listen for commands from popout window (import structure, edit 3D, params change)
  $effect(() => {
    const stop = listen_command((cmd) => {
      if (cmd.type === `import`) {
        open_structure_dialog(cmd.node_id)
      } else if (cmd.type === `edit_3d`) {
        open_structure_edit_3d(cmd.node_id)
      } else if (cmd.type === `params_change` && cmd.params) {
        nodes = nodes.map(n => n.id === cmd.node_id ? { ...n, params: cmd.params! } : n)
        push_history()
        schedule_save()
      }
    })
    return stop
  })

  // Simulate run for testing (when no HPC sessions available)
  function simulate_run() {
    exec.simulate_run(nodes, edges)
  }

  // ─── Mouse: Node drag (delegates to canvas interaction module) ───
  function on_node_down(e: MouseEvent, id: string) {
    const result = canvas.on_node_down(e, id, nodes, sel_nodes, svg_el)
    sel_nodes = result.sel_nodes
    sel_edge = result.sel_edge
  }

  // ─── Mouse: Handle ───
  function on_handle_down(e: MouseEvent, node_id: string, handle_id: string, is_input: boolean) {
    const result = canvas.on_handle_down(e, node_id, handle_id, is_input, nodes, edges, svg_el)
    if (result.edges) edges = result.edges
  }

  // ─── Mouse: SVG canvas ───
  function on_svg_down(e: MouseEvent) {
    const result = canvas.on_svg_down(e, svg_el, edges, dist_to_edge)
    if (result.sel_nodes !== undefined) sel_nodes = result.sel_nodes
    if (result.sel_edge !== undefined) sel_edge = result.sel_edge
  }

  function on_svg_move(e: MouseEvent) {
    const result = canvas.on_svg_move(e, svg_el, nodes, sel_nodes)
    if (result.nodes) nodes = result.nodes
  }

  function on_svg_up(e: MouseEvent) {
    const result = canvas.on_svg_up(e, svg_el, nodes, edges, would_create_cycle, (msg) => {
      cycle_warning = msg
      setTimeout(() => cycle_warning = null, 3000)
    })
    if (result.sel_nodes !== undefined) sel_nodes = result.sel_nodes
    if (result.edges) edges = result.edges
    if (result.should_push_history) push_history()
    if (result.click_node_id) {
      setTimeout(() => open_structure_dialog(result.click_node_id!), 50)
    }
  }

  // ─── Drop from palette ───
  function on_drop(e: DragEvent) {
    e.preventDefault()
    const type = e.dataTransfer?.getData(`nodeType`)
    if (!type || !NODE_DEFINITIONS[type]) return
    const pt = canvas.get_svg_pt(e as unknown as MouseEvent, svg_el)
    const cfg = NODE_DEFINITIONS[type]
    const new_id = uid()
    nodes = [...nodes, {
      id: new_id, type, x: snap(pt.x - NW / 2), y: snap(pt.y - 30),
      params: cfg.default_params ? { ...cfg.default_params } : {},
    }]
    sel_nodes = new Set([new_id])
    sel_edge = null
    push_history()
    ensure_workflow()
    schedule_save()
    // Auto-open structure import dialog for structure_input nodes
    if (type === `structure_input`) {
      // Use tick to let the node render first
      setTimeout(() => open_structure_dialog(new_id), 50)
    }
  }

  // ─── Backend persistence ───
  let save_timeout: ReturnType<typeof setTimeout> | null = null
  function schedule_save() {
    if (!workflow_id) return
    if (save_timeout) clearTimeout(save_timeout)
    save_timeout = setTimeout(do_save, 1500)
  }

  async function do_save() {
    if (!workflow_id) return
    is_saving = true
    try {
      const result = await api.update_workflow(workflow_id, { name: workflow_name, graph_json: JSON.stringify({ nodes, edges }) })
      change_det.set_known_updated_at(result.updated_at)
      change_det.set_external_change_detected(false)
    } catch (err) {
      console.error(`Save failed:`, err)
    } finally {
      is_saving = false
    }
  }

  async function handle_manual_save() {
    await do_save()
    save_flash = true
    setTimeout(() => (save_flash = false), 800)
  }

  // After a (re)load, fill any structure_input node the backend could not
  // resolve. CatBot's set_params/add_node resolves structure_json via
  // mp_id or the backend viewer copy; in a full-screen Workflow editor the
  // backend viewer copy is wiped (structure pane closed), so the node
  // comes back empty. Inject the durable client-side structure here — the
  // user's "put the current structure into Structure Input" via CatBot then
  // actually lands. Conservative: only nodes with NO structure_json AND no
  // mp_id/structure_id (i.e. backend genuinely had nothing and there is no
  // Materials Project source to defer to). Persist via schedule_save so the
  // injection survives the next reload instead of being wiped again.
  function fill_empty_structure_inputs(): void {
    const cur = get_current_structure()
    if (!cur) return
    let changed = false
    nodes = nodes.map((n) => {
      if (n.type !== `structure_input`) return n
      const p = n.params ?? {}
      const has_struct = typeof p.structure_json === `string` && p.structure_json.length > 0
      const has_mp = !!(p.mp_id || p.structure_id)
      if (has_struct || has_mp) return n
      changed = true
      return { ...n, params: { ...p, structure_json: JSON.stringify(cur) } }
    })
    if (changed) schedule_save()
  }

  async function reload_from_server() {
    if (!workflow_id) return
    try {
      const wf = await api.get_workflow(workflow_id)
      workflow_name = wf.name
      change_det.set_known_updated_at(wf.updated_at)
      const graph = JSON.parse(wf.graph_json)
      nodes = (graph.nodes || []).map((n: WfNode) => {
        // Apply default_params from node definition
        const def = NODE_DEFINITIONS[n.type]
        const params = def?.default_params
          ? { ...def.default_params, ...n.params }
          : n.params

        return {
          ...n,
          params,
          x: Number.isFinite(n.x) ? n.x : 0,
          y: Number.isFinite(n.y) ? n.y : 0,
        }
      })
      // Ensure every loaded edge has a unique id — `to_workflow_json` does not
      // persist `id`, so round-tripped graphs would otherwise yield duplicate
      // `undefined` keys and crash the keyed {#each} (each_key_duplicate).
      edges = (graph.edges || []).map((e: Record<string, any>, i: number) => {
        // Normalize across graph dialects so any producer renders here, matching
        // the Tauri/db-wasm loader: legacy `source/target` + react-flow
        // `sourceHandle/targetHandle`, and `to_workflow_json`'s `fromHandle/toHandle`,
        // all map onto the editor's native `from/to/fromH/toH`.
        const from = e.from ?? e.source ?? ``
        const to = e.to ?? e.target ?? ``
        return {
          id: e.id ?? `e${i}-${from || `?`}-${to || `?`}`,
          from,
          to,
          fromH: e.fromH ?? e.fromHandle ?? e.sourceHandle ?? `out-0`,
          toH: e.toH ?? e.toHandle ?? e.targetHandle ?? `in-0`,
          ...(e.label ? { label: e.label } : {}),
        }
      })
      fill_empty_structure_inputs()
      push_history()
      change_det.set_external_change_detected(false)
    } catch (err) {
      console.error(`Reload failed:`, err)
    }
  }

  async function load_workflow() {
    if (is_loaded) return
    if (!workflow_id) { is_loaded = true; return }
    try {
      const wf = await api.get_workflow(workflow_id)
      workflow_name = wf.name
      change_det.set_known_updated_at(wf.updated_at)
      const graph = JSON.parse(wf.graph_json)
      nodes = (graph.nodes || []).map((n: WfNode) => {
        // Migrate old node types to unified types
        let node_type = n.type
        let params = n.params || {}

        const migration = NODE_TYPE_MIGRATION[n.type]
        if (migration) {
          node_type = migration.type
          params = { ...migration.defaults, ...params }
        }

        // Apply default_params from node definition for all nodes
        const def = NODE_DEFINITIONS[node_type]
        if (def?.default_params) {
          params = { ...def.default_params, ...params }
        }

        return {
          ...n,
          type: node_type,
          params,
          x: Number.isFinite(n.x) ? n.x : 0,
          y: Number.isFinite(n.y) ? n.y : 0,
        }
      })
      // Ensure every loaded edge has a unique id — `to_workflow_json` does not
      // persist `id`, so round-tripped graphs would otherwise yield duplicate
      // `undefined` keys and crash the keyed {#each} (each_key_duplicate).
      edges = (graph.edges || []).map((e: Record<string, any>, i: number) => {
        // Normalize across graph dialects so any producer renders here, matching
        // the Tauri/db-wasm loader: legacy `source/target` + react-flow
        // `sourceHandle/targetHandle`, and `to_workflow_json`'s `fromHandle/toHandle`,
        // all map onto the editor's native `from/to/fromH/toH`.
        const from = e.from ?? e.source ?? ``
        const to = e.to ?? e.target ?? ``
        return {
          id: e.id ?? `e${i}-${from || `?`}-${to || `?`}`,
          from,
          to,
          fromH: e.fromH ?? e.fromHandle ?? e.sourceHandle ?? `out-0`,
          toH: e.toH ?? e.toHandle ?? e.targetHandle ?? `in-0`,
          ...(e.label ? { label: e.label } : {}),
        }
      })
      is_loaded = true
      fill_empty_structure_inputs()
      // Auto-layout if any nodes were missing coordinates
      if (nodes.length > 0 && (graph.nodes || []).some((n: WfNode) => !Number.isFinite(n.x) || !Number.isFinite(n.y))) {
        do_auto_layout()
      } else {
        push_history()
      }
      // Always check run-status via HTTP — WASM status is stale during execution
      try {
        const run_status = await api.get_run_status(workflow_id)
        // Check if any steps have non-pending statuses (handles V1/V2 DB status divergence)
        const has_step_activity = run_status.steps.some(
          s => s.status && s.status !== `pending`,
        )
        if (run_status.status !== `draft` || has_step_activity) {
          exec.set_workflow_status(run_status.status !== `draft` ? run_status.status : `running`)
          const st: Record<string, string> = {}
          for (const step of run_status.steps) st[step.id] = step.status
          exec.set_node_statuses(st)
          // Check if any tasks are still active — start monitoring regardless
          // of workflow-level status (it may be stale/incorrectly set).
          const has_active = run_status.steps.some(
            s => s.status === `running` || s.status === `queued` || s.status === `submitting` || (s.status as string) === `retrying` || s.status === `pending`,
          )
          if (run_status.status === `running` || (has_step_activity && has_active)) {
            exec.set_sim_running(true)
            start_monitoring()
          } else if (has_active) {
            // Workflow status is completed/failed/paused but tasks are still active —
            // start monitoring so scanner corrections are picked up
            start_monitoring()
          }
          // Auto-select the most relevant node and show Status tab
          const priority = [`running`, `queued`, `submitting`, `retrying`, `failed`, `paused`]
          let active_id = ``
          for (const p of priority) {
            const found = Object.entries(st).find(([, s]) => s === p)?.[0]
            if (found) { active_id = found; break }
          }
          if (!active_id) active_id = Object.entries(st).reverse().find(([, s]) => s === `completed`)?.[0] ?? ``
          if (active_id && nodes.some(n => n.id === active_id)) {
            sel_nodes = new Set([active_id])
            right_panel = `status`
            rpanel_open = true
          }
          // Collect unique HPC hosts used by this workflow's steps
          const hosts = new Set<string>()
          for (const step of run_status.steps) {
            if (step.hpc_host) hosts.add(step.hpc_host)
          }
          if (hosts.size > 0) {
            hpc_banner.set_needed_hpc_hosts([...hosts])
            hpc_banner.set_hpc_banner_dismissed(false)
            refresh_hpc_sessions()
          }
          // If no explicit hosts recorded but workflow has HPC node types, prompt generically
          if (hosts.size === 0 && nodes.some(n => is_hpc_node(n.type))) {
            hpc_banner.set_needed_hpc_hosts([`HPC`])
            hpc_banner.set_hpc_banner_dismissed(false)
            refresh_hpc_sessions()
          }
        }
      } catch {
        // run-status may fail if workflow was never fully executed (legacy/new workflows)
        if (wf.status && wf.status !== `draft`) {
          exec.set_workflow_status(wf.status)
        }
        // Even without run data, check if workflow has HPC nodes and prompt for connection
        if (nodes.some(n => is_hpc_node(n.type)) && hpc_session_store.sessions.length === 0) {
          hpc_banner.set_needed_hpc_hosts([`HPC`])
          hpc_banner.set_hpc_banner_dismissed(false)
          refresh_hpc_sessions()
        }
      }
    } catch (err) {
      console.error(`Failed to load workflow:`, err)
      load_error = `Failed to load workflow: ${err}`
      is_loaded = true
    }
  }

  async function ensure_workflow() {
    if (workflow_id) return
    try {
      const wf = await api.create_workflow(workflow_name, JSON.stringify({ nodes: [], edges: [] }))
      workflow_id = wf.id
    } catch (err) {
      console.error(`Failed to create workflow:`, err)
    }
  }

  // ─── Keyboard ───
  $effect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === `INPUT` || tag === `TEXTAREA` || tag === `SELECT`) return
      // Don't hijack Ctrl+C/V/A/Z when typing inside an embedded editor.
      // Monaco (INCAR/KPOINTS, ORCA/CP2K/LAMMPS input editors) uses the
      // EditContext API, so its focused element is a <div>, not a <textarea> —
      // without this the canvas shortcuts swallow native paste/undo/select.
      if (target?.closest(`.monaco-editor, .native-edit-context, [contenteditable=""], [contenteditable="true"]`)) return
      if ((e.metaKey || e.ctrlKey) && e.key === `z` && !e.shiftKey) { e.preventDefault(); undo() }
      if ((e.metaKey || e.ctrlKey) && e.key === `z` && e.shiftKey) { e.preventDefault(); redo() }
      if ((e.metaKey || e.ctrlKey) && e.key === `y`) { e.preventDefault(); redo() }
      if ((e.metaKey || e.ctrlKey) && e.key === `c`) { e.preventDefault(); copy_selected() }
      if ((e.metaKey || e.ctrlKey) && e.key === `v`) { e.preventDefault(); paste() }
      if ((e.metaKey || e.ctrlKey) && e.key === `a`) { e.preventDefault(); sel_nodes = new Set(nodes.map(n => n.id)) }
      if (e.key === `Delete` || e.key === `Backspace`) delete_selected()
      if (e.key === `Escape`) { sel_nodes = new Set(); sel_edge = null; canvas.set_conn(null) }
    }
    window.addEventListener(`keydown`, handler)
    return () => window.removeEventListener(`keydown`, handler)
  })

  // ─── Wheel zoom (delegates to canvas interaction module) ───
  $effect(() => {
    const el = svg_el
    if (!el) return
    function handler(e: WheelEvent) {
      canvas.handle_wheel(e, el!)
    }
    el.addEventListener(`wheel`, handler, { passive: false })
    return () => el.removeEventListener(`wheel`, handler)
  })

  // ─── Init ───
  $effect(() => { load_workflow() })

  // Cleanup monitoring on unmount
  $effect(() => {
    return () => { stop_monitoring() }
  })

  // ─── Periodic HPC session refresh (detect stale/dead connections) ───
  $effect(() => {
    if (!is_loaded || !nodes.some(n => is_hpc_node(n.type))) return
    const timer = setInterval(() => refresh_hpc_sessions(), 60_000)
    return () => clearInterval(timer)
  })

  // ─── Poll for external graph changes (MCP / other tabs) ───
  $effect(() => {
    if (!workflow_id || !is_loaded) return
    poll_timer = setInterval(async () => {
      if (is_saving || !known_updated_at) return
      try {
        const wf = await api.get_workflow(workflow_id)
        if (wf.updated_at !== known_updated_at) {
          // Auto-reload from server (MCP tools build the graph incrementally)
          await reload_from_server()
          do_auto_layout()
        }
      } catch { /* ignore poll errors */ }
    }, 2000)
    return () => { if (poll_timer) clearInterval(poll_timer) }
  })

  // ─── Force-reload when MCP pushes updates to an already-open workflow ───
  //
  // Trigger source: chat-state.svelte.ts bumps workflow_reload_seq on every
  // workflow-related tool_end event during a CatBot session. A single ORR-
  // style generation fires many tool_ends spread over ~60 s. Without a
  // debounce, each bump runs a full reload_from_server() that rebuilds N
  // deep-$state node proxies, re-runs every downstream $derived
  // (workflow_json, orphan_set, mm_bounds, sync_workflow_state), and
  // rebuilds the ChatPane workflow context — stacked across microtasks,
  // this saturates the main thread and freezes the UI. (Scroll still
  // works because it lives on the compositor thread.)
  //
  // 250 ms trailing-edge debounce: rapid bumps collapse into one reload
  // 250 ms after the last one. The editor lags at most a quarter second
  // behind the final mutation, and big graphs rebuild once instead of N
  // times. Single-mutation cases pay the 250 ms delay, which is under
  // perceptual threshold.
  let last_reload_seq = 0
  let reload_debounce_timer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    const seq = wf_slice.workflow_reload_seq.seq
    // `last_reload_seq` is advanced INSIDE the timer (i.e. only once the
    // reload actually runs), NOT here at schedule time. If this effect
    // re-runs for an unrelated reason before the 250 ms elapses, the
    // guard below is still true, so we just re-arm the debounce rather
    // than dropping the reload. Previously last_reload_seq was bumped at
    // schedule time and the cleanup cancelled the pending timer on every
    // re-run — a single isolated bump (exactly the rename case: one MCP
    // tool call → one seq++) was silently lost, while multi-bump big
    // generations survived by luck. See the rename-not-reflected fix.
    if (seq > last_reload_seq && is_loaded) {
      if (reload_debounce_timer) clearTimeout(reload_debounce_timer)
      reload_debounce_timer = setTimeout(() => {
        reload_debounce_timer = null
        last_reload_seq = seq
        reload_from_server().then(() => do_auto_layout())
      }, 250)
    }
  })
  // Teardown-only cleanup: no tracked deps, so the cleanup fires solely
  // on component destroy — an unrelated re-run of the effect above can no
  // longer cancel a valid pending reload.
  $effect(() => () => {
    if (reload_debounce_timer) {
      clearTimeout(reload_debounce_timer)
      reload_debounce_timer = null
    }
  })

  // ─── Chat integration: sync state to shared workflow state ───
  $effect(() => {
    const wf_nodes = nodes.map(n => {
      const def = NODE_DEFINITIONS[n.type]
      return { id: n.id, type: n.type, label: def?.label ?? n.type, params: n.params }
    })
    const wf_edges = edges.map(e => ({ id: e.id, from: e.from, to: e.to }))
    sync_workflow_state(tab_slice_id, {
      id: workflow_id,
      name: workflow_name,
      status: workflow_status,
      nodes: wf_nodes,
      edges: wf_edges,
      node_statuses: { ...node_statuses },
      error: execution_error,
    })
  })

  // ─── Chat integration: register action handler for AI tool calls ───
  $effect(() => {
    const cmd_state: WorkflowCommandState = {
      get_nodes: () => nodes,
      get_edges: () => edges,
      set_nodes: (ns) => { nodes = ns },
      set_edges: (es) => { edges = es },
      push_history,
      schedule_save,
      ensure_workflow,
      show_run_dialog: () => { exec.set_show_run_dialog(true) },
      handle_pause: open_pause_dialog,
      clear_selection: () => { sel_nodes = new Set() },
    }
    const handler = create_workflow_action_handler(cmd_state)

    register_workflow_action_handler(tab_slice_id, handler)
    return () => { unregister_workflow_action_handler(tab_slice_id) }
  })

  // ─── Chat integration: cleanup shared state on unmount ───
  $effect(() => {
    return () => { clear_workflow_state(tab_slice_id) }
  })

  $effect(() => {
    load_i18n_module('workflow')
  })
</script>

<div class="wf-root"
  onpointermove={on_palette_pointermove}
  onpointerup={on_palette_pointerup}>
  {#if palette_drag}
    {@const ghost_cfg = NODE_DEFINITIONS[palette_drag.type]}
    <div class="palette-ghost" style="left:{palette_drag.x}px; top:{palette_drag.y}px; --nc:{ghost_cfg?.color ?? '#888'}">
      <span>{ghost_cfg?.icon ?? ''}</span>
      <span>{ghost_cfg?.label ?? palette_drag.type}</span>
    </div>
  {/if}
  <!-- LEFT: Palette -->
  <div class="sidebar" class:collapsed={!sidebar_open}>
    {#if sidebar_open}
      <div class="side-title">⬡ CatGo Flow</div>
      <div class="palette-scroll">
        {#each sidebar_cats as cat}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="cat-header" onclick={() => {
            const next = new Set(collapsed_cats)
            next.has(cat.id) ? next.delete(cat.id) : next.add(cat.id)
            collapsed_cats = next
          }}>
            <span class="cat-chevron" class:collapsed={collapsed_cats.has(cat.id)}>▾</span>
            <span class="cat-icon">{cat.icon}</span>
            <span class="cat-title">{cat.label}</span>
          </div>
          {#if !collapsed_cats.has(cat.id)}
            {#if cat.subcategories && cat.subcategories.length > 0}
              {#each cat.subcategories as sub}
                <div class="sub-label">{sub.label}</div>
                <div class="cat-nodes">
                  {#each sub.nodes as def}
                    <div class="palette-node"
                      onpointerdown={(e) => on_palette_pointerdown(e, def.type)}
                      style="--nc: {def.color}">
                      <span class="p-icon">{def.icon}</span>
                      <span class="p-label">{def.label}</span>
                    </div>
                  {/each}
                </div>
              {/each}
            {/if}
            {#if cat.nodes && cat.nodes.length > 0}
              <div class="cat-nodes">
                {#each cat.nodes as def}
                  <div class="palette-node"
                    onpointerdown={(e) => on_palette_pointerdown(e, def.type)}
                    style="--nc: {def.color}">
                    <span class="p-icon">{def.icon}</span>
                    <span class="p-label">{def.label}</span>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        {/each}
      </div>
      <div class="sidebar-foot">
        <button class="tbtn" class:active={show_templates} onclick={() => show_templates = !show_templates}>📋 Templates</button>
        <button class="tbtn" onclick={() => show_custom_wizard = true} title="Create a custom command workflow node">+ Custom Command</button>
      </div>
    {/if}
    <button class="panel-toggle left" onclick={() => sidebar_open = !sidebar_open} title={sidebar_open ? `Hide palette` : `Show palette`}>
      {sidebar_open ? `◂` : `▸`}
    </button>
  </div>

  <!-- CENTER: Canvas -->
  <div class="center" bind:this={wf_wrapper_el}>
    <div class="toolbar">
      {#if onclose}<button class="tbtn" onclick={onclose}>{t('workflow.we_back') || '← Back'}</button><div class="tsep"></div>{/if}
      <input class="name-input" bind:value={workflow_name} oninput={schedule_save} />
      <div class="tsep"></div>
      <button class="tbtn" onclick={undo} title="Ctrl+Z">↩</button>
      <button class="tbtn" onclick={redo} title="Ctrl+Shift+Z">↪</button>
      <div class="tsep"></div>
      <button class="tbtn" onclick={copy_selected}>📋</button>
      <button class="tbtn" onclick={paste}>📌</button>
      <button class="tbtn danger" onclick={delete_selected}>🗑</button>
      <div class="tsep"></div>
      <button class="tbtn" onclick={do_auto_layout}>{t('workflow.we_layout') || '🔀 Layout'}</button>
      <button class="tbtn" onclick={() => { canvas.reset_view() }}>{t('workflow.we_reset') || '⊙ Reset'}</button>
      <span class="toolbar-tooltip-wrap">
        <button class="tbtn" onclick={() => show_import_dialog = true}>{t('workflow.we_import') || '📥 Import'}</button>
        <span class="toolbar-tooltip" role="tooltip">{t('workflow.we_import_title') || "Import workflow from template or file"}</span>
      </span>
      <span class="toolbar-tooltip-wrap">
        <button class="tbtn" onclick={handle_export_json}>{t('workflow.we_export') || '📤 Export'}</button>
        <span class="toolbar-tooltip" role="tooltip">{t('workflow.we_export_title') || "Export workflow as JSON"}</span>
      </span>
      <span class="toolbar-tooltip-wrap">
        <button class="tbtn" onclick={handle_manual_save} disabled={is_saving}>
          {#if save_flash}✓{:else if is_saving}...{:else}💾{/if}
        </button>
        <span class="toolbar-tooltip" role="tooltip">{t('workflow.we_save_title') || "Save workflow"}</span>
      </span>
      <div class="tsep"></div>
      <span class="toolbar-tooltip-wrap">
        <button class="tbtn" onclick={() => show_job_script_workplace = true}>{t('workflow.we_scripts') || '📝 Scripts'}</button>
        <span class="toolbar-tooltip" role="tooltip">{t('workflow.we_scripts_title') || "Manage job scripts"}</span>
      </span>
      <div class="tsep"></div>
      <span class="toolbar-tooltip-wrap">
        <button class="tbtn" onclick={() => show_connect_dialog = true}>
          {t('workflow.we_connect') || '🔌 Connect'}
          {#if hpc_session_store.sessions.length > 0}
            <span class="conn-badge">{hpc_session_store.sessions.length}</span>
          {/if}
        </button>
        <span class="toolbar-tooltip" role="tooltip">{t('workflow.we_connect_title') || "Connect to HPC server"}</span>
      </span>
      {#if workflow_status === `paused` && has_running_jobs}
        <button class="tbtn sim-stop" onclick={open_pause_dialog}>{t('workflow.we_cancel_jobs') || '⏸ Cancel Jobs'}</button>
        <button class="tbtn sim-go" onclick={handle_run_click}>{t('workflow.we_resume') || '▶ Resume'}</button>
      {:else}
        <button class="tbtn" class:sim-go={workflow_status !== `running`} class:sim-stop={workflow_status === `running`} onclick={handle_run_click}>
          {#if sim_running || workflow_status === `running`}{t('workflow.we_pause') || '⏸ Pause'}{:else if workflow_status === `paused`}{t('workflow.we_resume') || '▶ Resume'}{:else}{t('workflow.we_run') || '▶ Run'}{/if}
        </button>
      {/if}
      {#if sim_running || workflow_status === `running`}
        <button class="tbtn danger" onclick={async () => {
          if (!workflow_id) return
          try {
            await api.pause_workflow(workflow_id, { cancel_step_ids: undefined })
            exec.set_sim_running(false)
            exec.set_workflow_status(`failed`)
          } catch (e) { console.warn(`Stop failed:`, e) }
          await handle_reset()
        }} title={t('workflow.we_stop_title') || "Force stop all tasks"}>{t('workflow.we_stop') || '⏹ Stop'}</button>
      {/if}
      {#if workflow_status !== `draft` && !sim_running && workflow_status !== `running`}
        <button class="tbtn danger" onclick={handle_reset} title={t('workflow.we_reset_title') || "Reset workflow status"}>{t('workflow.we_reset') || '⟲ Reset'}</button>
      {/if}
      {#if workflow_status !== `draft`}
        <span class="toolbar-tooltip-wrap">
          <button class="tbtn" onclick={async (e) => {
            const btn = e.currentTarget as HTMLButtonElement
            btn.textContent = `⏳`
            btn.disabled = true
            try {
              const result = await api.recheck_jobs(workflow_id)
              btn.textContent = result.updated > 0 ? `✅ ${result.updated}` : `🔄 0`
              console.log(`[Workflow] Recheck:`, result)
              setTimeout(() => { btn.textContent = `🔄`; btn.disabled = false }, 3000)
            } catch (err) {
              btn.textContent = `❌`
              console.error(`Recheck failed:`, err)
              setTimeout(() => { btn.textContent = `🔄`; btn.disabled = false }, 3000)
            }
          }}>{t('workflow.we_recheck') || '🔄'}</button>
          <span class="toolbar-tooltip" role="tooltip">{t('workflow.we_recheck_title') || "Check HPC job status"}</span>
        </span>
      {/if}
      <span class="toolbar-tooltip-wrap">
        <button class="tbtn" onclick={simulate_run}>{t('workflow.we_simulate') || '🧪'}</button>
        <span class="toolbar-tooltip" role="tooltip">{t('workflow.we_simulate_title') || "Simulate (test without HPC)"}</span>
      </span>
      {#if ontoggle_terminal}
        <span class="toolbar-tooltip-wrap">
          <button class="tbtn" class:active={terminal_open} onclick={ontoggle_terminal}>
            {t('workflow.we_terminal') || '⌘ Terminal'}
          </button>
          <span class="toolbar-tooltip" role="tooltip">{terminal_open ? (t('workflow.we_terminal_open') || 'Close terminal') : (t('workflow.we_terminal_close') || 'Open terminal')}</span>
        </span>
      {/if}
      {#if ontoggle_chat}
        <span class="toolbar-tooltip-wrap">
          <button class="tbtn" class:active={chat_open} onclick={ontoggle_chat}>
            {t('workflow.we_ai') || '💬 AI'}
          </button>
          <span class="toolbar-tooltip" role="tooltip">{chat_open ? (t('workflow.we_ai_open') || 'Close AI chat') : (t('workflow.we_ai_close') || 'Open AI chat')}</span>
        </span>
      {/if}
      <span class="toolbar-tooltip-wrap">
        <button
          class="tbtn gesture-btn"
          class:active={wf_gesture_active}
          onclick={() => {
            wf_gesture_active = !wf_gesture_active
            wf_gesture_config = { ...wf_gesture_config, enabled: wf_gesture_active }
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
            <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
            <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
            <path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
          </svg>
        </button>
        <span class="toolbar-tooltip" role="tooltip">{wf_gesture_active ? (t('workflow.we_disable_gesture') || 'Disable gesture control') : (t('workflow.we_enable_gesture') || 'Enable gesture control')}</span>
      </span>
      {#if onpopout}<button class="tbtn" onclick={onpopout}>⧉</button>{/if}
      {#if workflow_status !== `draft`}
        <div class="wf-status-badge" style="
          background: color-mix(in srgb, {STATUS_COLORS[workflow_status] || '#888'} 15%, transparent);
          border-color: color-mix(in srgb, {STATUS_COLORS[workflow_status] || '#888'} 40%, transparent);
          color: {STATUS_COLORS[workflow_status] || '#888'};
        ">
          <span class="wf-status-dot" class:wf-running={workflow_status === `running`} style="background:{STATUS_COLORS[workflow_status] || '#888'}"></span>
          {workflow_status.replace(/_/g, ` `).toUpperCase()}
          {#if workflow_status === `running`}
            {@const completed_count = Object.values(node_statuses).filter(s => s === `completed` || s === `not_converged`).length}
            <span class="wf-progress-info">{completed_count}/{nodes.length}</span>
          {:else if workflow_status === `paused`}
            {@const still_running = Object.values(node_statuses).filter(s => s === `running`).length}
            {#if still_running > 0}
              <span class="wf-progress-info">{t('workflow.we_job_still_running', { n: still_running, s: still_running > 1 ? 's' : '' }) || `(${still_running} job${still_running > 1 ? 's' : ''} still running)`}</span>
            {/if}
          {/if}
        </div>
      {/if}
      <span class="tinfo">
        {Math.round(zoom * 100)}% • {nodes.length}{t('workflow.we_nodes') || 'N'} {edges.length}{t('workflow.we_edges') || 'E'}
      </span>
    </div>
    {#if cycle_warning}
      <div class="cycle-warning">{cycle_warning}</div>
    {/if}
    {#if load_error}
      <div class="load-error-bar">{load_error}</div>
    {/if}
    {#if execution_error}
      <div class="execution-error">
        <span>{execution_error}</span>
        <button class="error-dismiss" onclick={() => exec.set_execution_error(null)}>x</button>
      </div>
    {/if}
    {#if external_change_detected}
      <div class="external-change-bar">
        <span>{t('workflow.we_modified_externally') || 'Workflow modified externally (MCP / another tab).'}</span>
        <button onclick={reload_from_server}>{t('workflow.we_reload') || 'Reload'}</button>
        <button onclick={() => { change_det.set_external_change_detected(false); do_save() }}>{t('workflow.we_overwrite') || 'Overwrite'}</button>
        <button class="error-dismiss" onclick={() => change_det.set_external_change_detected(false)}>x</button>
      </div>
    {/if}
    {#if disconnected_hosts.length > 0}
      <div class="hpc-banner">
        <span>
          {#if disconnected_hosts.length === 1 && disconnected_hosts[0] === `HPC`}
            {t('workflow.we_hpc_nodes_warn') || 'This workflow has HPC computation nodes. Connect to an HPC server to run.'}
          {:else}
            {t('workflow.we_hpc_nodes_req', { host_count: disconnected_hosts.length }) || `This workflow requires HPC ${disconnected_hosts.length === 1 ? 'server' : 'servers'} not currently connected:`}
            {#each disconnected_hosts as host, i}
              <strong>{host}</strong>{#if i < disconnected_hosts.length - 1}, {/if}
            {/each}
          {/if}
        </span>
        <button class="hpc-banner-connect" onclick={() => show_connect_dialog = true}>{t('workflow.we_connect') || 'Connect'}</button>
        <button class="error-dismiss" onclick={() => hpc_banner.set_hpc_banner_dismissed(true)}>x</button>
      </div>
    {/if}

    {#if show_templates}
      <div class="tmpl-overlay">
        <div class="tmpl-title">{t('workflow.we_quick_recipes') || '⚡ Quick Recipes (zero LLM, ~200\u00A0ms)'}</div>
        {#if quickbuild_error}
          <div class="tmpl-quick-error">{quickbuild_error}</div>
        {/if}
        {#if quickbuild_loading}
          <div class="tmpl-quick-hint">{t('workflow.we_loading_recipes') || 'Loading recipes…'}</div>
        {:else}
          <div class="tmpl-quick-strip">
            {#each quickbuild_recipes as r (r.id)}
              <button class="tmpl-quick-btn" onclick={() => quickbuild_run(r.id)} title={r.label}>
                <span class="tmpl-quick-id">{r.id}</span>
                <span class="tmpl-quick-meta">{r.node_count}N · {r.edge_count}E</span>
              </button>
            {/each}
          </div>
        {/if}
        <div class="tmpl-title" style="margin-top: 12px">{t('workflow.we_workflow_templates') || 'Workflow Templates'}</div>
        {#each TEMPLATE_GROUPS as group}
          <div class="tmpl-group-header">{group.label}</div>
          {#each group.keys as key}
            {@const t = TEMPLATES[key]}
            {#if t}
              <button class="tmpl-card" onclick={() => load_template(key)}>
                <div class="tmpl-name">{t.name}</div>
                <div class="tmpl-desc">{t.desc}</div>
                <div class="tmpl-meta">{t.nodes.length} nodes • {t.edges.length} edges</div>
              </button>
            {/if}
          {/each}
        {/each}
      </div>
    {/if}

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <svg bind:this={svg_el} class="canvas"
      style="cursor: {panning ? 'grabbing' : 'default'}"
      onmousedown={on_svg_down} onmousemove={on_svg_move} onmouseup={on_svg_up}
      ondragover={(e) => e.preventDefault()} ondrop={on_drop}>
      <defs>
        <pattern id="grid-dots" width={GRID} height={GRID} patternUnits="userSpaceOnUse"
          patternTransform="translate({pan.x % (GRID * zoom)} {pan.y % (GRID * zoom)}) scale({zoom})">
          <circle cx={GRID / 2} cy={GRID / 2} r={0.4} fill="var(--border-color, #141e30)" />
        </pattern>
        <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <rect data-bg="true" width="100%" height="100%" fill="url(#grid-dots)" />
      <g transform="translate({pan.x},{pan.y}) scale({zoom})">
        {#each edges as edge (edge.id)}
          {@const fn = nodes.find(n => n.id === edge.from)}
          {@const tn = nodes.find(n => n.id === edge.to)}
          {#if fn && tn}
            {@const fp = get_handle_pos(fn, edge.fromH, false)}
            {@const tp = get_handle_pos(tn, edge.toH, true)}
            {@const path = bezier(fp.x, fp.y, tp.x, tp.y)}
            {@const is_sel = sel_edge === edge.id}
            {@const cfg = NODE_DEFINITIONS[fn.type]}
            {@const out_idx = parseInt((edge.fromH ?? ``).split(`-`)[1]) || 0}
            {@const ecolor = is_sel ? `var(--accent-color, #60a5fa)` : cfg?.is_condition ? (out_idx === 0 ? `#22c55e` : `#ef4444`) : (cfg?.color || `#475569`) + `80`}
            {@const mid = point_on_bezier(fp.x, fp.y, tp.x, tp.y, 0.5)}
            <g>
              <path d={path} fill="none" stroke="transparent" stroke-width={16} style="cursor:pointer"
                onclick={(ev) => { ev.stopPropagation(); sel_edge = edge.id; sel_nodes = new Set() }} />
              <path d={path} fill="none" stroke={ecolor} stroke-width={is_sel ? 2.5 : 1.8}
                opacity={is_sel ? 1 : 0.7} filter={is_sel ? `url(#glow)` : undefined} />
              {#if !sim_running}
                <circle r={2.5} fill={ecolor} opacity={0.8}>
                  <animateMotion dur="2.5s" repeatCount="indefinite" path={path} />
                </circle>
              {/if}
              {#if edge.label}
                <g transform="translate({mid.x},{mid.y})">
                  <rect x={-38} y={-9} width={76} height={18} rx={4} fill="var(--surface-bg, #080c14)" stroke={ecolor} stroke-width={0.8} />
                  <text x={0} y={4} fill={ecolor} font-size="9" text-anchor="middle" class="mono">{edge.label}</text>
                </g>
              {/if}
            </g>
          {/if}
        {/each}

        {#if conn}
          <path d={bezier(conn.sx, conn.sy, mouse.x, mouse.y)} fill="none" stroke="var(--accent-color, #60a5fa)" stroke-width={2} stroke-dasharray="6,3" opacity={0.9} />
        {/if}

        {#if box_sel}
          <rect x={Math.min(box_sel.x1, box_sel.x2)} y={Math.min(box_sel.y1, box_sel.y2)}
            width={Math.abs(box_sel.x2 - box_sel.x1)} height={Math.abs(box_sel.y2 - box_sel.y1)}
            fill="color-mix(in srgb, var(--accent-color, #3b82f6) 6%, transparent)" stroke="var(--accent-color, #3b82f6)" stroke-width={1} stroke-dasharray="4,2" rx={2} />
        {/if}

        {#each nodes as node (node.id)}
          {@const cfg = NODE_DEFINITIONS[node.type]}
          {#if cfg && Number.isFinite(node.x) && Number.isFinite(node.y)}
            {@const nh = get_nh(node)}
            {@const is_sel = sel_nodes.has(node.id)}
            {@const is_orphan = orphan_set.has(node.id)}
            {@const status = node_statuses[node.id]}
            {@const scolor = status ? STATUS_COLORS[status] || null : null}
            {@const inputs = cfg.inputs || []}
            {@const outputs = cfg.outputs || []}
            {@const custom_label = (node.params?.label as string) || ``}
            {@const node_formula = (node.params?.formula as string) || ``}
            {@const display_title = custom_label || (node.type === `structure_input` && node_formula ? node_formula : cfg.label)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <g transform="translate({node.x},{node.y})" onmousedown={(e) => on_node_down(e, node.id)} ondblclick={(e) => {
                e.stopPropagation()
                if (is_structure_node(node.type)) open_structure_dialog(node.id)
                else if (is_vasp_node(node.type, node.params)) open_vasp_editor(node.id)
                else if (is_orca_node(node.type, node.params)) open_input_editor(node.id, 'orca')
                else if (is_cp2k_node(node.type, node.params)) open_input_editor(node.id, 'cp2k')
                else if (is_lammps_node(node.type, node.params)) open_input_editor(node.id, 'lammps')
              }} style="cursor:grab">
              {#if status === `running`}
                <rect x={-4} y={-4} width={NW + 8} height={nh + 8} rx={14} fill="none" stroke={scolor} stroke-width={2} opacity={0.5}>
                  <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.2s" repeatCount="indefinite" />
                </rect>
              {/if}
              <rect x={2} y={2} width={NW} height={nh} rx={10} fill="rgba(0,0,0,0.25)" />
              <rect width={NW} height={nh} rx={10} fill="var(--surface-bg, #111827)"
                stroke={is_sel ? `var(--accent-color, #60a5fa)` : scolor || (is_orphan ? `#f59e0b50` : cfg.color + `40`)}
                stroke-width={is_sel ? 2.5 : 1.5} />
              <rect width={NW} height={30} rx={10} fill={scolor || cfg.color} opacity={0.85} />
              <rect y={16} width={NW} height={14} fill={scolor || cfg.color} opacity={0.85} />
              <text x={12} y={20} fill="#fff" font-size="12" font-weight="600" class="mono">{cfg.icon} {display_title}</text>
              {#if status}
                <g transform="translate({NW - 10}, 15)">
                  <circle r={4} fill={scolor} />
                  {#if status === `running`}
                    <circle r={4} fill={scolor}><animate attributeName="r" values="4;7;4" dur="1s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite" /></circle>
                  {/if}
                </g>
              {/if}
              {#if node.type === `structure_list_input`}
                {@const sli_count = (node.params.count as number) ?? 0}
                <text x={NW / 2} y={46} fill={sli_count > 0 ? `#10b981` : `var(--accent-color, #60a5fa)`} font-size="10" text-anchor="middle" class="mono" opacity="0.8">{sli_count > 0 ? `${sli_count} structure${sli_count !== 1 ? `s` : ``}` : (t('workflow.we_no_structures') || 'No structures')}</text>
              {:else if node.type === `structure_input` && !node.params.structure_json}
                <text x={NW / 2} y={46} fill="var(--accent-color, #60a5fa)" font-size="10" text-anchor="middle" class="mono" opacity="0.8">{t('workflow.we_click_to_import') || 'Click to import'}</text>
              {:else}
                {@const formula_sub = node.type === `structure_input` && !!custom_label && !!node_formula}
                {@const y_offset = formula_sub ? 14 : 0}
                {#if formula_sub}
                  <text x={NW / 2} y={44} fill="var(--text-color-dim, #8a9aba)" font-size="10" text-anchor="middle" class="mono" font-style="italic">{node_formula}</text>
                {/if}
                {#each get_display_params(node.params) as [k, v], i}
                  {@const ptext = `${k}=${String(v)}`}
                  <text x={NW / 2} y={44 + y_offset + i * 14} fill="var(--text-color-dim, #5a7a9a)" font-size="9.5" text-anchor="middle" class="mono">{ptext.length > 32 ? ptext.slice(0, 30) + `\u2026` : ptext}</text>
                {/each}
                {#if Object.keys(node.params || {}).length > get_display_params(node.params).length}
                  <text x={NW / 2} y={44 + y_offset + get_display_params(node.params).length * 14} fill="var(--text-color-dim, #3a5a7a)" font-size="9" text-anchor="middle" class="mono">{t('workflow.we_more_params', { n: Object.keys(node.params).length - get_display_params(node.params).length }) || `+${Object.keys(node.params).length - get_display_params(node.params).length} more`}</text>
                {/if}
              {/if}
              {#each { length: Math.max(inputs.length, 1) } as _, i}
                {@const sp = nh / (Math.max(inputs.length, 1) + 1)}
                {@const hy = sp * (i + 1)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <g onmousedown={(e) => { e.stopPropagation(); on_handle_down(e, node.id, `in-${i}`, true) }} style="cursor:crosshair">
                  <circle cx={0} cy={hy} r={HANDLE_R} fill="var(--page-bg, #1a2540)" stroke="var(--accent-color, #4080c0)" stroke-width={1.5} />
                  {#if inputs[i]}<text x={12} y={hy + 3} fill="var(--text-color-dim, #3a5a7a)" font-size="7" opacity="0.7" class="mono">{inputs[i]}</text>{/if}
                </g>
              {/each}
              {#each { length: Math.max(outputs.length, 1) } as _, i}
                {@const sp = nh / (Math.max(outputs.length, 1) + 1)}
                {@const hy = sp * (i + 1)}
                {@const hc = cfg.is_condition ? (i === 0 ? `#22c55e` : `#ef4444`) : cfg.color}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <g onmousedown={(e) => { e.stopPropagation(); on_handle_down(e, node.id, `out-${i}`, false) }} style="cursor:crosshair">
                  <circle cx={NW} cy={hy} r={HANDLE_R} fill="var(--page-bg, #1a2540)" stroke={hc} stroke-width={1.5} />
                  {#if outputs[i]}<text x={NW - 12} y={hy + 3} fill="var(--text-color-dim, #3a5a7a)" font-size="7" opacity="0.7" text-anchor="end" class="mono">{cfg.is_condition ? (i === 0 ? `TRUE` : `FALSE`) : outputs[i]}</text>{/if}
                </g>
              {/each}
              {#if is_orphan && !sim_running}
                <text x={NW / 2} y={nh + 14} fill="#f59e0b" font-size="9" text-anchor="middle" class="mono">{t('workflow.we_not_connected') || '⚡ not connected'}</text>
              {/if}
            </g>
          {/if}
        {/each}
      </g>
    </svg>

    <div class="minimap">
      <svg width={MM_W} height={MM_H}>
        {#each nodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y)) as n (n.id)}
          {@const cfg = NODE_DEFINITIONS[n.type]}
          {@const rx = ((n.x - mm_bounds.minX) / (mm_bounds.maxX - mm_bounds.minX)) * MM_W}
          {@const ry = ((n.y - mm_bounds.minY) / (mm_bounds.maxY - mm_bounds.minY)) * MM_H}
          {@const rw = (NW / (mm_bounds.maxX - mm_bounds.minX)) * MM_W}
          {@const rh = (get_nh(n) / (mm_bounds.maxY - mm_bounds.minY)) * MM_H}
          {@const st = node_statuses[n.id]}
          <rect x={rx} y={ry} width={Math.max(rw, 3)} height={Math.max(rh, 2)} rx={1}
            fill={st ? (STATUS_COLORS[st] || cfg?.color || `#475569`) : (cfg?.color || `#475569`)} opacity={0.7} />
        {/each}
      </svg>
    </div>
    <div class="help">{t('workflow.we_help') || 'Scroll=Zoom • Drag=Pan • Shift+Drag=Select • ⌫=Delete • Ctrl+Z=Undo • Ctrl+C/V=Copy/Paste'}</div>

    <!-- Gesture Control Overlay -->
    {#if wf_gesture_active}
      <GestureProvider
        config={wf_gesture_config}
        ongesture={on_wf_gesture}
        onvoice={on_wf_voice}
      >
        <GestureOverlay container_el={wf_wrapper_el ?? undefined} />
      </GestureProvider>
    {/if}
  </div>

  <!-- RIGHT: Properties -->
  <div class="rpanel" class:collapsed={!rpanel_open}
    use:resizable={{ side: 'left', min: 220, max: 600, onresize: (w) => rpanel_width = w }}>
    <button class="panel-toggle right" onclick={() => rpanel_open = !rpanel_open} title={rpanel_open ? (t('workflow.we_hide_properties') || `Hide properties`) : (t('workflow.we_show_properties') || `Show properties`)}>
      {rpanel_open ? `▸` : `◂`}
    </button>
    {#if rpanel_open}
    {@const _sel_for_tabs = selected_node}
    {@const _batch_structures = _sel_for_tabs && has_structure_io(_sel_for_tabs.type) ? resolve_input_structures(_sel_for_tabs.id) : null}
    {@const _show_batch_tab = _batch_structures && _batch_structures.length > 1}
    <div class="ptabs">
      <button class="ptab" class:active={right_panel === `props`} onclick={() => right_panel = `props`}>{t('workflow.editor_props_tab') || 'Properties'}</button>
      {#if _show_batch_tab}
        <button class="ptab" class:active={right_panel === `batch`} onclick={() => right_panel = `batch`}>
          {t('workflow.editor_batch_tab') || 'Batch'}<span class="ptab-badge">{_batch_structures.length}</span>
        </button>
      {/if}
      <button class="ptab" class:active={right_panel === `status`} onclick={() => right_panel = `status`}>{t('workflow.editor_status_tab') || 'Status'}</button>
      <button class="ptab-popout" onclick={popout_status} title={t('workflow.we_detach_panel') || "Detach panel to new window (follows selection)"}>⧉</button>
    </div>
    <div class="pcontent">
      {#if right_panel === `batch`}
        {#if selected_node}
          {@const nd = selected_node}
          {@const batch_structs = resolve_input_structures(nd.id)}
          {#if batch_structs && batch_structs.length > 1}
            <BatchPanel
              structures_json={batch_structs}
              node_params={nd.params}
              onparams_change={(params) => {
                nodes = nodes.map(n => n.id === nd.id ? { ...n, params } : n)
                push_history()
                schedule_save()
              }}
              on_edit_incar={(frame_idx) => {
                // Store which frame is being edited, then open VASP editor
                update_node_param(nd.id, '_editing_frame', frame_idx)
                open_vasp_editor(nd.id)
              }}
            />
          {:else}
            <div style="padding: 16px; color: var(--text-color-dim); font-size: 13px;">
              No multi-structure input detected. Connect a Doping Gen or Structure List Input node upstream.
            </div>
          {/if}
        {/if}
      {:else if right_panel === `status`}
        {#if selected_node && workflow_id}
          {@const nd = selected_node}
          {@const cfg = NODE_DEFINITIONS[nd.type]}
          <NodeStatusPanel
            node_id={nd.id}
            node_type={nd.type}
            node_label={cfg?.label ?? nd.type}
            {workflow_id}
            status={node_statuses[nd.id]}
            step_message={step_messages[nd.id]}
            {task_results}
            node_params={nd.params}
            {node_statuses}
            onview_file={(nid, filename) => {
              file_browser_node_id = nid
              show_file_browser = true
              open_file_in_editor(filename)
            }}
            onload_structure={handle_load_structure}
            ondownload={handle_download_file}
            onload_forces={handle_load_forces}
            onplay_vibration={async (data) => {
              // Auto-open 3D viewer with CONTCAR if not already open
              if (!show_structure_edit_3d && nd?.id) {
                await handle_load_structure(nd.id, `CONTCAR`)
              }
              edit_3d_vibration = { ...data, playing: true }
            }}
            onstop_vibration={() => {
              edit_3d_vibration = null
            }}
            onstatus_sync={(nid, db_status) => {
              // Sync status to UI + persist to DB
              if (node_statuses[nid] !== db_status) {
                exec.set_node_statuses({ ...node_statuses, [nid]: db_status })
                api.update_step(workflow_id, nid, { status: db_status }).catch((e) => {
                  console.error(`[WorkflowEditor] Failed to persist step status for ${nid}:`, e)
                })
                // If all steps are now terminal, update workflow status too
                const TERMINAL = new Set([`completed`, `not_converged`, `failed`, `skipped`])
                const all_done = Object.values(node_statuses).every(s => TERMINAL.has(s))
                if (all_done && workflow_status !== `draft`) {
                  const has_failed = Object.values(node_statuses).some(s => s === `failed`)
                  const has_not_converged = Object.values(node_statuses).some(s => s === `not_converged`)
                  const new_wf_status = has_failed ? `failed` : has_not_converged ? `not_converged` : `completed`
                  if (workflow_status !== new_wf_status) {
                    exec.set_workflow_status(new_wf_status)
                    exec.set_sim_running(false)
                    api.update_workflow(workflow_id, { status: new_wf_status }).catch((e) => {
                      console.error(`[WorkflowEditor] Failed to persist workflow status:`, e)
                    })
                  }
                }
              }
            }}
          />
        {:else}
          <div class="empty-sel">
            <div class="empty-icon">📊</div>
            <div class="empty-title">{t('workflow.editor_no_node_selected') || 'No node selected'}</div>
            <div class="empty-hint">{t('workflow.editor_select_node_hint') || 'Select a node to view its execution status'}</div>
          </div>
        {/if}
      {:else if selected_node}
        {@const nd = selected_node}
        {@const cfg = NODE_DEFINITIONS[nd.type]}
        {@const status = node_statuses[nd.id]}
        {#if cfg}
          {#if nd.type === `structure_input`}
            <StructureInputPanel
              node={nd}
              definition={cfg}
              {status}
              onparams_change={(params) => {
                nodes = nodes.map(n => n.id === nd.id ? { ...n, params } : n)
                push_history()
                schedule_save()
              }}
              onimport={() => open_structure_dialog(nd.id)}
              onedit_3d={() => open_structure_edit_3d(nd.id)}
            />
          {:else if nd.type === `structure_list_input`}
            <StructureListInputPanel
              node={nd}
              definition={cfg}
              {status}
              onparams_change={(params) => {
                nodes = nodes.map(n => n.id === nd.id ? { ...n, params } : n)
                push_history()
                schedule_save()
              }}
            />
          {:else}
            <!-- Tool Type selector for unified tool nodes -->
            {#if UNIFIED_TOOL_TYPES.has(nd.type)}
              {@const show_thelp = tool_help_visible === nd.id}
              <div class="calc-type-row">
                <label class="calc-type-label">{t('workflow.editor_tool_type_label')}</label>
                <div class="calc-type-controls">
                  <select class="calc-type-select"
                    value={nd.type}
                    onchange={(e) => change_tool_type(nd.id, (e.target as HTMLSelectElement).value)}
                  >
                    {#each TOOL_TYPE_OPTIONS as opt}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                  <button class="calc-help-btn" onclick={() => tool_help_visible = show_thelp ? null : nd.id}
                    title="About this tool type">?</button>
                </div>
              </div>
              {#if show_thelp && cfg?.help_text}
                <div class="calc-help-box">{@html render_help(cfg.help_text)}</div>
              {/if}
            {/if}
            <!-- Doping: dedicated UI replaces param panel -->
            {#if nd.type === `doping_gen`}
              <div class="doping-panel">
                <div class="doping-actions">
                  <button class="doping-action-btn select-sites-btn" onclick={() => {
                    const input_json = resolve_input_structure(nd.id)
                    if (!input_json) return
                    try {
                      doping_modal_structure = JSON.parse(input_json)
                      doping_modal_node_id = nd.id
                      show_doping_modal = true
                    } catch { /* invalid JSON */ }
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4m10-10h-4M6 12H2"/>
                    </svg>
                    {t('workflow.doping_open_editor')}
                  </button>
                  <button class="doping-action-btn screen-sites-btn" onclick={() => {
                    nodes = nodes.map(n => n.id !== nd.id ? n : {
                      ...n, params: { ...n.params, enumerate: true, count: 1, max_configs: 200 }
                    })
                    push_history()
                    schedule_save()
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 6h18M3 12h18M3 18h18"/>
                    </svg>
                    {t('workflow.doping_screen_all_sites')}
                  </button>
                </div>
                <!-- Summary of current config -->
                <div class="doping-summary">
                  {#if nd.params.dopant && nd.params.mode !== 'combinatorial'}
                    <div class="doping-summary-row">
                      <span class="doping-summary-label">{t('workflow.doping_dopant')}</span>
                      <span class="doping-summary-value">{nd.params.dopant}</span>
                    </div>
                  {/if}
                  {#if nd.params.target_element}
                    <div class="doping-summary-row">
                      <span class="doping-summary-label">{t('workflow.doping_host')}</span>
                      <span class="doping-summary-value">{nd.params.target_element}</span>
                    </div>
                  {/if}
                  {#if nd.params.enumerate}
                    <div class="doping-summary-row">
                      <span class="doping-summary-label">{t('workflow.mode')}</span>
                      <span class="doping-summary-value">{t('workflow.doping_enumerate_max', { n: Number(nd.params.max_configs ?? 50) })}</span>
                    </div>
                  {/if}
                  {#if nd.params.mode === 'combinatorial' && nd.params.groups}
                    {@const grps = (() => { try { return JSON.parse(typeof nd.params.groups === 'string' ? nd.params.groups : '[]') } catch { return [] } })()}
                    {#if grps.length > 0}
                      {#each grps as g, i}
                        <div class="doping-summary-row">
                          <span class="doping-summary-label">{t('workflow.doping_group_n', { n: i + 1 })}</span>
                          <span class="doping-summary-value">{g.target || '?'} → {(g.replacements || []).join(', ') || t('workflow.none')}</span>
                        </div>
                      {/each}
                    {/if}
                  {/if}
                </div>
                <!-- Doping Gen: read-only preview with carousel (selection is done on the downstream calc node) -->
                {#if nd.params.generated_structures_json}
                  {@const gen_structs = (() => { try { return JSON.parse(typeof nd.params.generated_structures_json === 'string' ? nd.params.generated_structures_json : '[]') as string[] } catch { return [] } })()}
                  {#if gen_structs.length > 1}
                    <div style="margin-top: 6px; font-size: 11px; color: var(--text-color-dim);">
                      {t('workflow.doping_preview_variants', { n: gen_structs.length })}
                    </div>
                    <CalcStructurePreview
                      upstream_structure_json={gen_structs[0]}
                      upstream_structures_json={gen_structs}
                      readonly_selection
                      on_expand={() => open_structure_edit_3d(nd.id, `input`)}
                    />
                  {/if}
                {/if}
              </div>
            {/if}
            <!-- Calculation Type selector for unified calc nodes -->
            {#if UNIFIED_CALC_TYPES.has(nd.type)}
              {@const show_help = calc_help_visible === nd.id}
              <div class="calc-type-row">
                <label class="calc-type-label">{t('workflow.editor_calc_type_label')}</label>
                <div class="calc-type-controls">
                  <select class="calc-type-select"
                    value={nd.type}
                    onchange={(e) => change_calc_type(nd.id, (e.target as HTMLSelectElement).value)}
                  >
                    {#each CALC_TYPE_OPTIONS as opt}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                  <button class="calc-help-btn" onclick={() => calc_help_visible = show_help ? null : nd.id}
                    title="About this calculation type">?</button>
                </div>
              </div>
              {#if show_help && cfg?.help_text}
                <div class="calc-help-box">{@html render_help(cfg.help_text)}</div>
              {/if}
            {/if}
            <!-- Analysis Type selector for unified analysis nodes -->
            {#if UNIFIED_ANALYSIS_TYPES.has(nd.type)}
              {@const show_ahelp = analysis_help_visible === nd.id}
              <div class="calc-type-row">
                <label class="calc-type-label">{t('workflow.editor_analysis_type_label')}</label>
                <div class="calc-type-controls">
                  <select class="calc-type-select"
                    value={nd.type}
                    onchange={(e) => change_analysis_type(nd.id, (e.target as HTMLSelectElement).value)}
                  >
                    {#each ANALYSIS_TYPE_OPTIONS as opt}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                  <button class="calc-help-btn" onclick={() => analysis_help_visible = show_ahelp ? null : nd.id}
                    title="About this analysis type">?</button>
                </div>
              </div>
              {#if show_ahelp && cfg?.help_text}
                <div class="calc-help-box">{@html render_help(cfg.help_text)}</div>
              {/if}
            {/if}
            <!-- ═══ Custom panels that replace NodeConfigPanel ═══ -->
            <!-- Key on nd.id so Svelte tears down + remounts the panel when
                 the user clicks between two same-typed nodes (e.g. ads_OH →
                 ads_O). Without this, the panel component instance is
                 reused and its internal `$state` locals (species_idx,
                 site_strategy, manual_position, …) keep the previous
                 node's values — the canonical "click another node, then
                 back" workaround the user was hitting. -->
            {#key nd.id}
            {#if nd.type === `doping_gen`}
              <!-- Doping uses dedicated modal — no NodeConfigPanel needed -->
            {:else if nd.type === `adsorbate_place`}
              {@const _ads_upstream_structs = resolve_input_structures(nd.id)}
              <AdsorbatePlacePanel
                node={nd}
                definition={cfg}
                {status}
                onparams_change={(params) => {
                  nodes = nodes.map(n => n.id === nd.id ? { ...n, params } : n)
                  push_history()
                  schedule_save()
                }}
                onedit_3d={(preview_struct, adsorption_sites, on_site_picked, on_confirm) => {
                  if (preview_struct) {
                    // Capture node id now — nd may be stale when on_confirm fires later
                    const captured_node_id = nd.id
                    edit_3d_node_id = captured_node_id
                    // Self-define mode: no site picker → editable + confirm visible
                    const is_self_define = !on_site_picked && !!on_confirm
                    edit_3d_label = is_self_define
                      ? `${(nd.params.label as string) || `Adsorbate`} — Edit Molecule`
                      : `${(nd.params.label as string) || `Adsorbate`} — Pick Site`
                    edit_3d_readonly = !is_self_define
                    edit_3d_is_trajectory = false
                    edit_3d_trajectory = undefined
                    edit_3d_structure = preview_struct
                    edit_3d_vibration = null
                    edit_3d_scene_props = undefined
                    edit_3d_adsorption_sites = adsorption_sites ?? []
                    edit_3d_on_site_picked = on_site_picked ?? null
                    edit_3d_on_confirm = on_confirm ?? null
                    edit_3d_site_confirmed = is_self_define
                    edit_3d_preview_banner = false
                    show_structure_edit_3d = true
                    if (!StructureEditorComponent) {
                      import(`$lib/structure/Structure.svelte`).then(mod => { StructureEditorComponent = mod.default })
                    }
                  } else {
                    edit_3d_adsorption_sites = []
                    edit_3d_on_site_picked = null
                    edit_3d_on_confirm = null
                    edit_3d_preview_banner = true
                    open_structure_edit_3d(nd.id)
                  }
                }}
                upstream_structure_json={resolve_input_structure(nd.id)}
                upstream_structures_json={_ads_upstream_structs && _ads_upstream_structs.length > 1 ? _ads_upstream_structs : null}
              />
            {:else}
            <NodeConfigPanel
              node={nd}
              definition={cfg}
              {status}
              {workflow_id}
              onfreeze_edit={() => open_freeze_dialog(nd.id)}
              onparams_change={(params) => {
                nodes = nodes.map(n => n.id === nd.id ? { ...n, params } : n)
                push_history()
                schedule_save()
              }}
            >
              <!-- ═══ Slab Gen preview ═══ -->
              {#if nd.type === `slab_gen`}
                <SlabGenPreview
                  node_params={nd.params}
                  upstream_structure_json={resolve_input_structure(nd.id)}
                  on_expand={() => open_slab_preview_3d(nd.id)}
                  onparam_update={(key, value) => update_node_param(nd.id, key, value)}
                  onstructure_generated={(json) => {
                    const cur = nd.params.structure_json as string | undefined
                    // Use == to treat null and undefined as equal (both mean "no structure")
                    if (json == cur) return
                    if (json !== cur) {
                      nodes = nodes.map(n => n.id === nd.id ? { ...n, params: { ...n.params, structure_json: json ?? undefined } } : n)
                      schedule_save()
                    }
                  }}
                />
              {/if}
              <!-- ═══ Computation node structure preview ═══ -->
              {#if !is_structure_node(nd.type) && has_structure_io(nd.type)}
                {@const _def = NODE_DEFINITIONS[nd.type]}
                {@const _has_input = _def?.inputs.includes(`structure`)}
                {@const _has_output = _def?.outputs.includes(`structure`)}
                {@const _is_completed = node_statuses[nd.id] === `completed`}
                {#if _has_input}
                  {@const _upstream_structures = resolve_input_structures(nd.id)}
                  {@const _raw_struct = resolve_input_structure(nd.id)}
                  {@const _preview_struct = (nd.type === `freq` || nd.type === `geo_opt` || nd.type === `slab_gen`) ? apply_freeze_to_structure(_raw_struct, nd.params) : _raw_struct}
                  <CalcStructurePreview
                    upstream_structure_json={_preview_struct}
                    upstream_structures_json={_upstream_structures && _upstream_structures.length > 1 ? _upstream_structures : null}
                    initial_selected={nd.params.selected_structures as number[] | undefined}
                    on_expand={() => nd.type === `freq` ? open_freeze_dialog(nd.id) : open_structure_edit_3d(nd.id, `input`)}
                    on_multi_selection_change={(selected) => {
                      update_node_param(nd.id, `selected_structures`, [...selected])
                    }}
                  />
                {/if}
                {#if _has_output && _is_completed}
                  <button
                    class="tbtn"
                    onclick={() => open_structure_edit_3d(nd.id, `output`)}
                    style="margin-top: 4px; width: 100%; justify-content: center; background: color-mix(in srgb, #22c55e 15%, transparent); border-color: color-mix(in srgb, #22c55e 30%, transparent);"
                  >
                     {t('workflow.editor_view_output_structure')}
                  </button>
                {/if}
              {/if}
              <!-- ═══ Preview Input buttons ═══ -->
              {#if is_vasp_node(nd.type, nd.params)}
                <button class="tbtn vasp-btn" onclick={() => open_vasp_editor(nd.id)}
                  style="margin: 4px 12px; justify-content: center;">
                  {nd.params.custom_incar_text ? '✏️ Edit INCAR / KPOINTS' : '📄 Preview INCAR / KPOINTS'}
                </button>
                {#if nd.params.custom_incar_text}
                  <div class="structure-preview-badge" style="color: var(--accent-color); margin: 0 12px;">{t('workflow.editor_custom_incar_saved')}</div>
                {/if}
              {/if}
              {#if is_orca_node(nd.type, nd.params)}
                <button class="tbtn vasp-btn" onclick={() => open_input_editor(nd.id, 'orca')}
                  style="margin: 4px 12px; justify-content: center;">
                  {nd.params.custom_inp_text ? '✏️ Edit ORCA.inp' : '📄 Preview ORCA.inp'}
                </button>
                {#if nd.params.custom_inp_text}
                  <div class="structure-preview-badge" style="color: var(--accent-color); margin: 0 12px;">{t('workflow.editor_custom_orca_saved')}</div>
                {/if}
              {/if}
              {#if is_cp2k_node(nd.type, nd.params)}
                <button class="tbtn vasp-btn" onclick={() => open_input_editor(nd.id, 'cp2k')}
                  style="margin: 4px 12px; justify-content: center;">
                  {nd.params.custom_inp_text ? '✏️ Edit project.inp' : '📄 Preview project.inp'}
                </button>
                {#if nd.params.custom_inp_text}
                  <div class="structure-preview-badge" style="color: var(--accent-color); margin: 0 12px;">{t('workflow.editor_custom_cp2k_saved')}</div>
                {/if}
              {/if}
              {#if is_lammps_node(nd.type, nd.params)}
                <button class="tbtn vasp-btn" onclick={() => open_input_editor(nd.id, 'lammps')}
                  style="margin: 4px 12px; justify-content: center;">
                  {nd.params.custom_input_text ? '✏️ Edit in.lammps' : '📄 Preview in.lammps'}
                </button>
                {#if nd.params.custom_input_text}
                  <div class="structure-preview-badge" style="color: var(--accent-color); margin: 0 12px;">{t('workflow.editor_custom_lammps_saved')}</div>
                {/if}
              {/if}
              <!-- ═══ Free Energy Diagram ═══ -->
              {#if nd.type === `free_energy`}
                <button
                  class="tbtn"
                  style="margin: 4px 12px; width: calc(100% - 24px); justify-content: center; background: color-mix(in srgb, var(--accent-color, #3b82f6) 12%, transparent); border-color: color-mix(in srgb, var(--accent-color, #3b82f6) 30%, transparent);"
                  onclick={() => open_energy_diagram(nd.id)}
                >
                  {t('workflow.editor_open_diagram')}
                </button>
              {/if}
            </NodeConfigPanel>
            {/if}
            {/key}
            {#if is_structure_node(nd.type) && nd.type !== `slab_gen` && nd.type !== `adsorbate_place`}
              <button
                class="tbtn structure-btn"
                onclick={() => open_structure_dialog(nd.id)}
                style="margin-top: 8px; width: 100%; justify-content: center;"
              >
                {nd.params.structure_json ? t('workflow.editor_edit_structure') : t('workflow.editor_import_structure')}
              </button>
              {#if nd.params.structure_json}
                <button
                  class="tbtn"
                  onclick={() => open_structure_edit_3d(nd.id, `own`)}
                  style="margin-top: 4px; width: 100%; justify-content: center; background: color-mix(in srgb, var(--accent-color) 15%, transparent); border-color: color-mix(in srgb, var(--accent-color) 30%, transparent);"
                >
                  {t('workflow.editor_edit_3d')}
                </button>
              {/if}
            {/if}
          {/if}
          <!-- ═══ HPC Settings per-node (right after ADVANCED params) ═══ -->
          {#if is_hpc_node(nd.type)}
            {@const hpc_sessions = hpc_session_store.sessions}
            <div class="hpc-section">
              <button class="hpc-header" onclick={() => {
                const el = document.getElementById(`hpc-body-${nd.id}`)
                if (el) el.classList.toggle('collapsed')
              }}>
                <span class="hpc-header-label">{t('workflow.editor_hpc_settings')}</span>
                {#if nd.params.hpc_session_id}
                  {@const s = hpc_sessions.find(ss => ss.session_id === nd.params.hpc_session_id)}
                  <span class="hpc-badge">{s ? `${s.username}@${s.host}` : `configured`}</span>
                {/if}
              </button>
              <div id="hpc-body-{nd.id}" class="hpc-body">
                <!-- Cluster -->
                <label class="hpc-label">{t('workflow.editor_cluster')}</label>
                <select class="hpc-input hpc-select"
                  value={nd.params.hpc_session_id ?? ``}
                  onchange={(e) => update_node_param(nd.id, `hpc_session_id`, (e.target as HTMLSelectElement).value || undefined)}
                >
                  <option value="">{t('workflow.editor_use_default_cluster')}</option>
                  {#each hpc_sessions as s}
                    <option value={s.session_id}>{s.username}@{s.host}</option>
                  {/each}
                </select>

                {#if is_vasp_node(nd.type, nd.params)}
                  <!-- VASP executable -->
                  <label class="hpc-label">{t('workflow.editor_vasp_executable')}</label>
                  <select class="hpc-input hpc-select"
                    value={nd.params.vasp_executable ?? `vasp_std`}
                    onchange={(e) => update_node_param(nd.id, `vasp_executable`, (e.target as HTMLSelectElement).value)}
                  >
                    {#each VASP_EXECUTABLES as exe}
                      <option value={exe}>{exe}</option>
                    {/each}
                  </select>

                  <!-- Sort structure toggle -->
                  <label class="hpc-checkbox-row">
                    <input type="checkbox"
                      checked={(nd.params.sort_structure as any) ?? false}
                      onchange={(e) => update_node_param(nd.id, `sort_structure`, (e.target as HTMLInputElement).checked)}
                    />
                    <span>{t('workflow.editor_sort_poscar')}</span>
                  </label>
                {/if}

                <!-- Job params grid -->
                <div class="hpc-params-grid">
                  <div class="hpc-field hpc-field-wide">
                    <label class="hpc-label">--partition</label>
                    <input class="hpc-input" type="text"
                      value={nd.params.job_partition ?? ``}
                      placeholder="e.g. shared"
                      onchange={(e) => update_node_param(nd.id, `job_partition`, e.currentTarget.value || undefined)} />
                  </div>
                  <div class="hpc-field hpc-field-wide">
                    <label class="hpc-label">--job-name</label>
                    <input class="hpc-input" type="text"
                      value={nd.params.job_name ?? ``}
                      placeholder={(nd as any).label || nd.type}
                      onchange={(e) => update_node_param(nd.id, `job_name`, e.currentTarget.value || undefined)} />
                  </div>
                  <div class="hpc-field">
                    <label class="hpc-label">--nodes</label>
                    <input class="hpc-input" type="number" min={1}
                      value={nd.params.job_nodes ?? ``}
                      placeholder="1"
                      onchange={(e) => update_node_param(nd.id, `job_nodes`, e.currentTarget.valueAsNumber || undefined)} />
                  </div>
                  <div class="hpc-field">
                    <label class="hpc-label">--ntasks-per-node</label>
                    <input class="hpc-input" type="number" min={1}
                      value={nd.params.job_ntasks ?? ``}
                      placeholder="96"
                      onchange={(e) => update_node_param(nd.id, `job_ntasks`, e.currentTarget.valueAsNumber || undefined)} />
                  </div>
                  <div class="hpc-field">
                    <label class="hpc-label">--cpus-per-task</label>
                    <input class="hpc-input" type="number" min={1}
                      value={nd.params.job_cpus_per_task ?? ``}
                      placeholder="2"
                      onchange={(e) => update_node_param(nd.id, `job_cpus_per_task`, e.currentTarget.valueAsNumber || undefined)} />
                  </div>
                  <div class="hpc-field">
                    <label class="hpc-label">--time</label>
                    <input class="hpc-input" type="text"
                      value={nd.params.job_walltime ?? ``}
                      placeholder="24:00:00"
                      onchange={(e) => update_node_param(nd.id, `job_walltime`, e.currentTarget.value || undefined)} />
                  </div>
                  <div class="hpc-field hpc-field-wide">
                    <label class="hpc-label">--account</label>
                    <input class="hpc-input" type="text"
                      value={nd.params.job_account ?? ``}
                      placeholder="e.g. sdp126"
                      onchange={(e) => update_node_param(nd.id, `job_account`, e.currentTarget.value || undefined)} />
                  </div>
                </div>

                <!-- Job script selector + editor -->
                <label class="hpc-label">{t('workflow.editor_job_script')}</label>
                <div class="hpc-script-row">
                  <select class="hpc-input hpc-select"
                    value={nd.params.job_script_id ?? ``}
                    onchange={(e) => {
                      const id = (e.target as HTMLSelectElement).value
                      if (id) {
                        const script = job_script_store.find(id)
                        if (script) {
                          update_node_param(nd.id, `job_script_id`, id)
                          update_node_param(nd.id, `job_script`, script.template)
                        }
                      } else {
                        update_node_param(nd.id, `job_script_id`, undefined)
                        update_node_param(nd.id, `job_script`, undefined)
                      }
                    }}
                  >
                    <option value="">{t('workflow.editor_cluster_default')}</option>
                    {#each job_script_store.get_for_node(nd.type) as script}
                      <option value={script.id}>{script.name}</option>
                    {/each}
                  </select>
                  <button class="hpc-script-btn" onclick={() => show_job_script_workplace = true}
                    title="Manage job scripts">...</button>
                </div>
                <textarea class="hpc-input hpc-textarea" rows={6}
                  value={(nd.params.job_script as string) ?? ``}
                  placeholder="Select a script above or edit directly..."
                  onchange={(e) => {
                    update_node_param(nd.id, `job_script`, e.currentTarget.value || undefined)
                    // Clear script ID reference when user edits directly
                    if (nd.params.job_script_id) update_node_param(nd.id, `job_script_id`, undefined)
                  }}
                ></textarea>
              </div>
            </div>
          {/if}


          {#if (status === 'completed' || status === 'running' || status === 'failed') && workflow_id}
            <button
              class="tbtn output-btn"
              onclick={() => open_file_browser(nd.id)}
              style="margin-top: 4px; width: 100%; justify-content: center;"
            >
              {t('workflow.editor_browse_files')}
            </button>
          {/if}
        {/if}
      {:else if selected_edge}
        {@const ed = selected_edge}
        {@const fn = nodes.find(n => n.id === ed.from)}
        {@const tn = nodes.find(n => n.id === ed.to)}
        <div class="props">
          <div class="prop-lbl">{t('workflow.editor_edge')}</div>
          <div class="edge-info">
            <div>{t('workflow.editor_edge_from')} {fn ? NODE_DEFINITIONS[fn.type]?.icon + ` ` + NODE_DEFINITIONS[fn.type]?.label : `?`} ({ed.fromH})</div>
            <div>{t('workflow.editor_edge_to')} {tn ? NODE_DEFINITIONS[tn.type]?.icon + ` ` + NODE_DEFINITIONS[tn.type]?.label : `?`} ({ed.toH})</div>
          </div>
          <div style="margin-top:10px">
            <label class="sec-label" style="font-size:9px">{t('workflow.editor_edge_label')}</label>
            <input class="param-input full" value={ed.label || ``}
              oninput={(e) => { edges = edges.map(edge => edge.id === ed.id ? { ...edge, label: e.currentTarget.value } : edge) }}
              onblur={() => push_history()} />
          </div>
          <button class="tbtn danger full" style="margin-top:12px" onclick={() => { edges = edges.filter(e => e.id !== ed.id); sel_edge = null; push_history() }}>{t('workflow.editor_delete_edge')}</button>
        </div>
      {:else}
        <div class="empty-sel">
          <div class="empty-icon">⬡</div>
          <div class="empty-title">{t('workflow.editor_no_selection')}</div>
          <div class="empty-hint">{t('workflow.editor_select_hint')}</div>
          <div class="qs">
            <div class="qs-title">{t('workflow.editor_quickstart')}</div>
            <div>{t('workflow.editor_qs_1')}</div>
            <div>{t('workflow.editor_qs_2')}</div>
            <div>{t('workflow.editor_qs_3')}</div>
            <div>{t('workflow.editor_qs_4')}</div>
          </div>
        </div>
      {/if}
    </div>
    {/if}
  </div>

</div>

<ImportWorkflowDialog bind:show={show_import_dialog} onimport={handle_import} />

<ConnectDialog bind:show={show_connect_dialog} />

<RunConfigDialog
  show={show_run_dialog}
  sessions={hpc_session_store.sessions.map(s => ({ id: s.session_id, host: s.host, username: s.username, conda_activate: s.conda_activate }))}
  workflow_nodes={nodes}
  onrun={handle_execute}
  onclose={() => exec.set_show_run_dialog(false)}
  onconnect={() => { exec.set_show_run_dialog(false); show_connect_dialog = true }}
/>

<PauseDialog
  show={show_pause_dialog}
  jobs={pause_jobs}
  onpause={handle_pause_confirm}
  onclose={() => exec.set_show_pause_dialog(false)}
/>

<JobScriptWorkplace
  show={show_job_script_workplace}
  onclose={() => show_job_script_workplace = false}
/>

<StructureInputDialog
  bind:show={show_structure_dialog}
  bind:structure_json={structure_dialog_json}
  mode={structure_dialog_mode}
  title={structure_dialog_title}
  onconfirm={handle_structure_confirm}
  onclose={() => { show_structure_dialog = false; structure_dialog_node_id = null; structure_dialog_json = null }}
/>

<!-- Structure 3D Edit Pane -->
<!-- Energy Diagram full-screen editor -->
<EnergyDiagramModal
  bind:show={show_energy_diagram}
  initial_pathways={energy_diagram_pathways}
  onsave={(pathways) => {
    if (energy_diagram_node_id) {
      update_node_param(energy_diagram_node_id, `pathways`, JSON.stringify(pathways))
    }
  }}
/>

<StructureEditModal
  bind:show={show_structure_edit_3d}
  label={edit_3d_label}
  readonly={edit_3d_readonly}
  bind:is_trajectory={edit_3d_is_trajectory}
  bind:trajectory={edit_3d_trajectory}
  bind:structure={edit_3d_structure}
  initial_generated={edit_3d_initial_generated}
  scene_props={edit_3d_scene_props}
  vibration={edit_3d_vibration}
  initial_bulk={edit_3d_bulk}
  initial_panel={edit_3d_initial_panel}
  adsorption_sites={edit_3d_adsorption_sites}
  on_adsorption_site_click={edit_3d_on_site_picked ? (site_idx) => {
    const placed = edit_3d_on_site_picked!(site_idx)
    if (placed) {
      edit_3d_structure = placed
      edit_3d_adsorption_sites = []
      edit_3d_readonly = false
      edit_3d_label = edit_3d_label.replace(`Pick Site`, `Adjust & Confirm`)
      edit_3d_site_confirmed = true
    }
  } : undefined}
  show_confirm={edit_3d_site_confirmed}
  preview_banner={edit_3d_preview_banner}
  onconfirm={() => {
    if (edit_3d_on_confirm && edit_3d_structure) {
      edit_3d_on_confirm(edit_3d_structure)
    }
    close_edit_3d()
  }}
  {StructureEditorComponent}
  {TrajectoryEditorComponent}
  freeze_mode={freeze_edit_active}
  frozen_indices={freeze_edit_frozen}
  onfreeze_save={handle_freeze_update}
  onclose={() => { freeze_edit_active = false; freeze_edit_node_id = null; close_edit_3d() }}
  onsave={(gen) => { freeze_edit_active = false; freeze_edit_node_id = null; save_and_close_edit_3d(gen) }}
  onload_trajectory={async (traj) => {
    if (!TrajectoryEditorComponent) {
      const mod = await import('$lib/trajectory/Trajectory.svelte')
      TrajectoryEditorComponent = mod.default
    }
  }}
/>

<!-- Doping Workflow Modal (dedicated side-by-side editor) -->
<DopingWorkflowModal
  bind:show={show_doping_modal}
  bind:structure={doping_modal_structure}
  onclose={() => { show_doping_modal = false }}
  onsave={(data) => {
    if (doping_modal_node_id) {
      structure_dialog_node_id = doping_modal_node_id
      handle_structure_confirm(data)
      // Store all generated variants for MultiStructurePreview
      if (data.trajectory?.frames?.length) {
        const structs = data.trajectory.frames.map((f: any) => JSON.stringify(f.structure))
        update_node_param(doping_modal_node_id, 'generated_structures_json', JSON.stringify(structs))
      }
    }
    show_doping_modal = false
  }}
/>

<!-- Custom Command Wizard -->
{#if show_custom_wizard}
  <CustomCommandWizard
    api_base={API_BASE}
    onclose={() => { show_custom_wizard = false }}
    oncreated={(_engine_key) => {
      show_custom_wizard = false
      load_dynamic_engines(API_BASE).then(() => { _node_defs_version++ })
    }}
  />
{/if}

<!-- VASP file editor modal -->
<VaspEditorModal
  bind:show={show_vasp_editor}
  bind:vasp_editor_tab={vasp_editor_tab}
  {vasp_generating}
  vasp_error={vasp_error}
  bind:vasp_incar_content={vasp_incar_content}
  bind:vasp_kpoints_content={vasp_kpoints_content}
  bind:vasp_poscar_content={vasp_poscar_content}
  onsave={save_vasp_editor}
  onclose={close_vasp_editor}
/>

<!-- Generic input file editor modal (ORCA, CP2K, LAMMPS) -->
<InputEditorModal
  bind:show={show_input_editor}
  label={INPUT_FILE_CONFIG[input_editor_software]?.label ?? 'Input File'}
  filename={input_editor_filename}
  generating={input_editor_generating}
  error={input_editor_error}
  bind:content={input_editor_content}
  open_count={input_editor_open_count}
  onsave={save_input_editor}
  onclose={close_input_editor}
/>

<!-- File browser modal for step output/input files -->
<FileBrowserModal
  bind:show={show_file_browser}
  view={file_browser_view}
  loading={file_browser_loading}
  filename={file_browser_filename}
  work_dir={file_browser_work_dir}
  files={file_browser_files}
  content={file_browser_content}
  file_path={file_browser_file_path}
  session_id={file_browser_session_id}
  onopen_file={open_file_in_editor}
  onback_to_list={() => { file_browser_view = 'list' }}
  onclose={() => { show_file_browser = false; file_browser_node_id = null }}
/>

<style>
  .wf-root {
    width: 100%; height: 100%; display: flex;
    background: var(--page-bg); color: var(--text-color);
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 13px; overflow: hidden;
  }
  .mono { font-family: inherit; }
  .sidebar {
    width: 210px; background: var(--surface-bg); border-right: 1px solid var(--border-color);
    display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden;
    position: relative; transition: width 0.15s ease;
  }
  .sidebar.collapsed {
    width: 24px;
  }
  .side-title {
    padding: 14px 14px 6px; font-size: 10px; font-weight: 700;
    letter-spacing: 1.2px; color: var(--text-color-muted); text-transform: uppercase;
  }
  .palette-scroll { padding: 4px 10px; flex: 1; overflow-y: auto; }
  .cat-header {
    display: flex; align-items: center; gap: 4px; padding: 6px 2px 3px;
    margin-top: 8px; cursor: pointer; user-select: none;
    font-size: 10px; font-weight: 700; color: var(--text-color-muted);
    text-transform: uppercase; letter-spacing: 1px;
  }
  .cat-header:hover { color: var(--text-color); }
  .cat-chevron {
    font-size: 10px; transition: transform 0.15s ease; display: inline-block;
  }
  .cat-chevron.collapsed { transform: rotate(-90deg); }
  .cat-icon { font-size: 12px; }
  .cat-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub-label {
    font-size: 9px; font-weight: 600; color: var(--text-color-muted); opacity: 0.7;
    padding-left: 16px; margin-top: 6px; margin-bottom: 2px;
    letter-spacing: 0.5px;
  }
  .cat-nodes { display: flex; flex-direction: column; gap: 3px; padding-left: 4px; }
  .palette-node {
    display: flex; align-items: center; gap: 6px; padding: 6px 8px;
    background: color-mix(in srgb, var(--nc) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--nc) 12%, transparent);
    border-radius: 6px; cursor: grab; font-size: 11px; color: var(--text-color-muted);
    user-select: none; transition: all 0.12s;
  }
  .palette-ghost {
    position: fixed; pointer-events: none; z-index: 9999;
    transform: translate(-50%, -50%);
    display: flex; align-items: center; gap: 6px; padding: 6px 10px;
    background: color-mix(in srgb, var(--nc) 20%, var(--surface-bg, #1e293b));
    border: 1.5px solid color-mix(in srgb, var(--nc) 50%, transparent);
    border-radius: 6px; font-size: 11px; color: var(--text-color, #e2e8f0);
    opacity: 0.85; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .palette-node:hover {
    background: color-mix(in srgb, var(--nc) 14%, transparent);
    border-color: color-mix(in srgb, var(--nc) 30%, transparent);
  }
  .p-icon { font-size: 14px; }
  .p-label { font-weight: 500; font-size: 11px; }
  .sidebar-foot { padding: 8px; border-top: 1px solid var(--border-color); }
  .center { flex: 1; position: relative; display: flex; flex-direction: column; min-width: 0; }
  .toolbar {
    display: flex; align-items: center; gap: 4px; padding: 6px 8px;
    background: var(--surface-bg); border-bottom: 1px solid var(--border-color); flex-shrink: 0;
    flex-wrap: wrap; z-index: 10;
  }
  .tbtn {
    padding: 4px 8px; background: var(--surface-bg); border: 1px solid var(--border-color);
    border-radius: 5px; color: var(--text-color-muted); font-size: 11px; cursor: pointer;
    display: flex; align-items: center; gap: 4px; white-space: nowrap;
    font-family: inherit;
  }
  .toolbar-tooltip-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .toolbar-tooltip {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    transform: translateX(-50%) translateY(4px);
    padding: 6px 9px;
    border-radius: 7px;
    border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
    background: var(--surface-bg-hover, light-dark(#ffffff, #20232b));
    color: var(--text-color);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22);
    font-size: 10px;
    line-height: 1.25;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    z-index: 30;
    transition: opacity 0.14s ease, transform 0.14s ease, visibility 0.14s ease;
  }
  .toolbar-tooltip-wrap:hover .toolbar-tooltip,
  .toolbar-tooltip-wrap:focus-within .toolbar-tooltip {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0);
  }
  .toolbar-tooltip::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 100%;
    width: 8px;
    height: 8px;
    background: inherit;
    border-right: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
    transform: translate(-50%, -50%) rotate(45deg);
  }
  .tbtn:hover { background: var(--surface-bg-hover); border-color: var(--accent-hover-color, light-dark(#3730a3, #2563eb)); color: var(--text-color); }
  .tbtn.active { background: var(--surface-bg-hover); border-color: var(--accent-hover-color, light-dark(#3730a3, #2563eb)); color: var(--text-color); }
  .gesture-btn.active { border-color: #00fff7; color: #00fff7; background: rgba(0, 255, 247, 0.1); box-shadow: 0 0 6px rgba(0, 255, 247, 0.3); }
  .tbtn.danger { color: var(--error-color); }
  .tbtn.danger:hover { background: color-mix(in srgb, var(--error-color) 15%, transparent); border-color: color-mix(in srgb, var(--error-color) 40%, transparent); }
  .tbtn.sim-go { background: color-mix(in srgb, var(--success-color) 12%, transparent); border-color: color-mix(in srgb, var(--success-color) 30%, transparent); color: var(--success-color); }
  .tbtn.sim-stop { background: color-mix(in srgb, var(--error-color) 15%, transparent); border-color: color-mix(in srgb, var(--error-color) 40%, transparent); color: var(--error-color); }
  .tbtn.full { width: 100%; justify-content: center; margin-top: 6px; }
  .tbtn:disabled { opacity: 0.5; cursor: default; }
  /* ─── Computation Node Placeholder ─── */
  .inline-struct-placeholder {
    display: flex; align-items: center; gap: 6px;
    padding: 12px; margin: 8px 0 4px;
    border: 1px dashed var(--border-color, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    font-size: 11px;
    color: var(--text-color-dim, light-dark(#9ca3af, #666));
  }
  .placeholder-icon { font-size: 14px; opacity: 0.6; }
  .tsep { width: 1px; height: 20px; background: var(--border-color); flex-shrink: 0; }
  .conn-badge {
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6)); color: #fff;
    border-radius: 8px; font-size: 9px; padding: 1px 5px; font-weight: 700; min-width: 14px; text-align: center;
  }
  .tinfo { margin-left: auto; font-size: 10px; color: var(--text-color-muted); white-space: nowrap; }
  .wf-status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 10px; border-radius: 4px; font-size: 10px; font-weight: 700;
    border: 1px solid; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;
  }
  .wf-status-dot {
    width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  }
  .wf-status-dot.wf-running {
    animation: wf-pulse 1.5s ease-in-out infinite;
  }
  @keyframes wf-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .wf-progress-info { font-size: 9px; opacity: 0.8; margin-left: 2px; }
  .cycle-warning {
    position: absolute; top: 44px; left: 50%; transform: translateX(-50%);
    background: color-mix(in srgb, var(--error-color) 85%, var(--surface-bg)); color: light-dark(#dc2626, #fca5a5); padding: 6px 16px; border-radius: 6px;
    font-size: 11px; z-index: 20; pointer-events: none;
    animation: wf-fade-in 0.2s ease;
  }
  .load-error-bar {
    padding: 8px 16px;
    background: rgba(239, 68, 68, 0.15);
    border-bottom: 1px solid rgba(239, 68, 68, 0.3);
    color: #ef4444;
    font-size: 12px;
    text-align: center;
  }
  .execution-error {
    position: absolute; top: 44px; left: 50%; transform: translateX(-50%);
    background: color-mix(in srgb, var(--error-color) 85%, var(--surface-bg)); color: light-dark(#dc2626, #fca5a5); padding: 6px 16px; border-radius: 6px;
    font-size: 11px; z-index: 20; display: flex; align-items: center; gap: 10px;
    max-width: 80%; animation: wf-fade-in 0.2s ease;
  }
  .error-dismiss {
    background: none; border: none; color: light-dark(#dc2626, #fca5a5); cursor: pointer;
    font-size: 14px; padding: 0 2px; line-height: 1; opacity: 0.7;
  }
  .error-dismiss:hover { opacity: 1; }
  .external-change-bar {
    position: absolute; top: 44px; left: 50%; transform: translateX(-50%);
    background: color-mix(in srgb, #2563eb 15%, var(--surface-bg)); color: light-dark(#1d4ed8, #93c5fd);
    padding: 6px 16px; border-radius: 6px; font-size: 11px; z-index: 20;
    display: flex; align-items: center; gap: 8px; animation: wf-fade-in 0.2s ease;
    border: 1px solid color-mix(in srgb, #2563eb 30%, transparent);
  }
  .external-change-bar button {
    background: color-mix(in srgb, #2563eb 20%, transparent); border: 1px solid color-mix(in srgb, #2563eb 40%, transparent);
    color: inherit; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 10px;
  }
  .external-change-bar button:hover { background: color-mix(in srgb, #2563eb 35%, transparent); }
  .hpc-banner {
    position: absolute; top: 44px; left: 50%; transform: translateX(-50%);
    background: color-mix(in srgb, #f59e0b 12%, var(--surface-bg)); color: light-dark(#92400e, #fbbf24);
    padding: 6px 16px; border-radius: 6px; font-size: 11px; z-index: 20;
    display: flex; align-items: center; gap: 8px; animation: wf-fade-in 0.2s ease;
    border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
    max-width: 90%;
  }
  .hpc-banner strong { color: light-dark(#78350f, #fde68a); }
  .hpc-banner-connect {
    background: color-mix(in srgb, #f59e0b 20%, transparent); border: 1px solid color-mix(in srgb, #f59e0b 40%, transparent);
    color: inherit; padding: 2px 10px; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: 600;
    white-space: nowrap;
  }
  .hpc-banner-connect:hover { background: color-mix(in srgb, #f59e0b 35%, transparent); }
  @keyframes wf-fade-in { from { opacity: 0; transform: translateX(-50%) translateY(-8px); } }
  .name-input {
    background: none; border: 1px solid transparent; color: var(--text-color);
    font-size: 13px; font-weight: 600; padding: 3px 6px; outline: none;
    font-family: inherit; min-width: 120px; max-width: 200px; border-radius: 4px;
  }
  .name-input:focus { border-color: var(--border-color); background: var(--page-bg); }
  .tmpl-overlay {
    position: absolute; left: 10px; top: 50px; z-index: 30;
    background: var(--surface-bg); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 12px; width: 300px; backdrop-filter: blur(8px);
    max-height: calc(100vh - 120px); overflow-y: auto;
  }
  .tmpl-title { font-size: 10px; font-weight: 700; color: var(--text-color-muted); text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 8px; }
  .tmpl-group-header { font-size: 9px; font-weight: 700; color: var(--text-color-muted); text-transform: uppercase; letter-spacing: 1px; margin: 10px 0 4px; padding-top: 6px; border-top: 1px solid var(--border-color); }
  .tmpl-group-header:first-child { margin-top: 0; padding-top: 0; border-top: none; }
  .tmpl-card {
    display: block; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 4px;
    background: var(--page-bg); border: 1px solid var(--border-color); border-radius: 6px;
    cursor: pointer; color: inherit; font-family: inherit; transition: all 0.12s;
  }
  .tmpl-card:hover { background: var(--surface-bg-hover); border-color: var(--text-color-muted); }
  .tmpl-name { font-size: 12px; font-weight: 600; color: var(--text-color-muted); }
  .tmpl-desc { font-size: 10px; color: var(--text-color-muted); margin-top: 2px; }
  .tmpl-meta { font-size: 9px; color: var(--text-color-muted); margin-top: 2px; }
  .tmpl-quick-strip {
    display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px;
  }
  .tmpl-quick-btn {
    display: inline-flex; flex-direction: column; align-items: center;
    padding: 6px 10px; min-width: 64px;
    background: linear-gradient(135deg, rgba(96,165,250,0.18), rgba(168,85,247,0.18));
    border: 1px solid rgba(96,165,250,0.4); border-radius: 6px;
    cursor: pointer; color: inherit; font-family: inherit;
    transition: all 0.12s;
  }
  .tmpl-quick-btn:hover {
    border-color: rgba(96,165,250,0.8);
    background: linear-gradient(135deg, rgba(96,165,250,0.32), rgba(168,85,247,0.32));
  }
  .tmpl-quick-id { font-size: 11px; font-weight: 700; }
  .tmpl-quick-meta { font-size: 8px; opacity: 0.7; margin-top: 2px; }
  .tmpl-quick-error { font-size: 10px; color: #ef4444; margin-bottom: 6px; padding: 4px 6px; background: rgba(239,68,68,0.1); border-radius: 4px; }
  .tmpl-quick-hint { font-size: 10px; color: var(--text-color-muted); padding: 4px; }
  .canvas { flex: 1; width: 100%; user-select: none; -webkit-user-select: none; }
  .minimap {
    position: absolute; bottom: 10px; left: 10px; width: 180px; height: 110px;
    background: var(--page-bg); border: 1px solid var(--border-color); border-radius: 6px;
    overflow: hidden; z-index: 10;
  }
  .help {
    position: absolute; bottom: 10px; right: 290px; font-size: 9px;
    color: var(--border-color); z-index: 5; text-align: right; line-height: 1.6;
  }
  .rpanel {
    width: 280px; background: var(--surface-bg); border-left: 1px solid var(--border-color);
    display: flex; flex-direction: column; flex-shrink: 0;
    position: relative; overflow: hidden;
  }
  .rpanel.collapsed { width: 24px !important; }
  .panel-toggle {
    position: absolute; top: 50%; transform: translateY(-50%);
    background: var(--surface-bg); border: 1px solid var(--border-color);
    color: var(--text-color-muted); cursor: pointer; z-index: 5;
    width: 20px; height: 40px; display: flex; align-items: center; justify-content: center;
    font-size: 10px; padding: 0; font-family: inherit; border-radius: 4px;
    transition: all 0.15s;
  }
  .panel-toggle:hover {
    color: var(--text-color); background: var(--surface-bg-hover);
    border-color: var(--accent-color, #3b82f6);
  }
  .panel-toggle.left { right: 0; border-right: none; border-radius: 4px 0 0 4px; }
  .panel-toggle.right { left: 0; border-left: none; border-radius: 0 4px 4px 0; }
  .ptabs { display: flex; border-bottom: 1px solid var(--border-color); }
  .ptab {
    flex: 1; padding: 10px 0; background: transparent; border: none;
    border-bottom: 2px solid transparent; color: var(--text-color-muted); font-size: 10px;
    font-weight: 600; cursor: pointer; font-family: inherit;
    text-transform: uppercase; letter-spacing: 1.2px;
  }
  .ptab.active { background: var(--page-bg); border-bottom-color: var(--accent-color, #3b82f6); color: var(--text-color-muted); }
  .ptab-popout {
    padding: 6px 8px; background: transparent; border: none; cursor: pointer;
    color: var(--text-color-dim, #9ca3af); font-size: 14px; line-height: 1;
    display: flex; align-items: center; transition: color 0.15s;
  }
  .ptab-popout:hover { color: var(--accent-color, #3b82f6); }
  .ptab-badge { font-size: 10px; background: var(--accent-color, #3b82f6); color: white; border-radius: 8px; padding: 0 5px; margin-left: 4px; min-width: 16px; text-align: center; display: inline-block; }
  .pcontent { flex: 1; overflow-y: auto; padding: 12px; }
  /* Override dialog-modal and component-scoped height/overflow for all panels inside rpanel —
     the rpanel's .pcontent handles scrolling, not the individual panels */
  .pcontent :global(.config-panel.dialog-modal),
  .pcontent :global(.config-panel) { max-height: none !important; height: auto !important; overflow: visible !important; }
  .props { display: flex; flex-direction: column; }
  .prop-lbl { font-size: 13px; font-weight: 600; color: var(--text-color); }
  .sec-label {
    font-size: 9px; font-weight: 700; color: var(--text-color-muted); text-transform: uppercase;
    letter-spacing: 1.2px; margin-bottom: 6px;
  }
  .param-input {
    flex: 1; padding: 3px 6px; background: var(--page-bg); border: 1px solid var(--border-color);
    border-radius: 4px; color: var(--text-color-muted); font-size: 10px; font-family: inherit;
    outline: none; min-width: 0;
  }
  .param-input.full { width: 100%; margin-top: 4px; }
  .edge-info { font-size: 10px; color: var(--text-color-dim); line-height: 1.8; margin-top: 8px; }
  .empty-sel { color: var(--text-color-muted); font-size: 11px; line-height: 1.8; padding-top: 20px; text-align: center; }
  .empty-icon { font-size: 28px; margin-bottom: 8px; opacity: 0.3; }
  .empty-title { font-weight: 600; color: var(--text-color-muted); margin-bottom: 4px; }
  .empty-hint { font-size: 10px; }
  .qs { margin-top: 20px; text-align: left; font-size: 10px; color: var(--border-color); line-height: 2; }
  .qs-title { font-weight: 600; color: var(--text-color-muted); margin-bottom: 4px; }
  .structure-btn { background: var(--surface-bg); border-color: color-mix(in srgb, var(--success-color) 30%, transparent); color: var(--success-color); }
  .structure-btn:hover { background: var(--surface-bg-hover); border-color: color-mix(in srgb, var(--success-color) 50%, transparent); }
  .structure-preview-badge {
    padding: 3px 8px; margin-top: 4px; background: color-mix(in srgb, var(--success-color) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--success-color) 20%, transparent); border-radius: 4px;
    font-size: 10px; color: var(--success-color); text-align: center;
  }
  .output-btn { background: var(--surface-bg); border-color: var(--border-color); color: var(--accent-color); }
  .output-btn:hover { background: var(--surface-bg-hover); border-color: var(--accent-hover-color, light-dark(#3730a3, #2563eb)); }
  .vasp-btn { background: var(--surface-bg); border-color: var(--border-color); color: light-dark(#7c3aed, #a78bfa); }
  .vasp-btn:hover { background: var(--surface-bg-hover); border-color: light-dark(#6d28d9, #7c3aed); }
  /* Calculation Type selector */
  /* ─── Doping action buttons ─── */
  .doping-actions {
    display: flex; gap: 6px; padding: 8px 12px;
  }
  .doping-action-btn {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px;
    padding: 7px 8px; border-radius: 6px; font-size: 11px; font-weight: 500;
    cursor: pointer; font-family: inherit; transition: all 0.15s;
    border: 1px solid var(--border-color); background: var(--surface-bg); color: var(--text-color-muted);
  }
  .doping-action-btn:hover { background: var(--surface-bg-hover); color: var(--text-color); }
  .select-sites-btn { border-color: rgba(59, 130, 246, 0.3); color: #60a5fa; }
  .select-sites-btn:hover { background: rgba(59, 130, 246, 0.1); }
  .screen-sites-btn { border-color: rgba(5, 150, 105, 0.3); color: #10b981; }
  .screen-sites-btn:hover { background: rgba(5, 150, 105, 0.1); }
  .doping-panel { padding: 0 12px 8px; }
  .doping-summary {
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 6px;
    background: rgba(255,255,255,0.02);
    display: flex; flex-direction: column; gap: 3px;
  }
  .doping-summary:empty { display: none; }
  .doping-summary-row {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 10px;
  }
  .doping-summary-label { color: #64748b; }
  .doping-summary-value { color: #e2e8f0; font-weight: 500; font-family: 'SF Mono', monospace; }
  .calc-type-row { padding: 8px 12px 4px; }
  .calc-type-label { display: block; font-size: 11px; font-weight: 600; color: var(--text-muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .calc-type-controls { display: flex; gap: 4px; align-items: center; }
  .calc-type-select { flex: 1; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--surface-bg); color: var(--text-color); font-size: 13px; font-weight: 500; }
  .calc-type-select:focus { outline: none; border-color: var(--accent-color); }
  .calc-help-btn { width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--border-color); background: var(--surface-bg); color: var(--text-muted); font-size: 13px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .calc-help-btn:hover { background: var(--surface-bg-hover); color: var(--accent-color); border-color: var(--accent-color); }
  .calc-help-box { margin: 4px 12px 8px; padding: 8px 10px; border-radius: 6px; background: color-mix(in srgb, var(--accent-color) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent-color) 20%, transparent); font-size: 12px; line-height: 1.5; color: var(--text-color); white-space: pre-line; }
  /* ── HPC Settings per-node ── */
  .hpc-section {
    margin-top: 12px; border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden;
  }
  .hpc-header {
    display: flex; align-items: center; gap: 6px; width: 100%; padding: 8px 10px;
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 6%, var(--surface-bg));
    border: none; cursor: pointer; color: var(--text-color-muted); font-family: inherit;
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
  }
  .hpc-header:hover { background: color-mix(in srgb, var(--accent-color, #3b82f6) 12%, var(--surface-bg)); }
  .hpc-header-label { flex: 1; text-align: left; }
  .hpc-badge {
    font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 8px;
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 18%, transparent);
    color: var(--accent-color, #3b82f6); letter-spacing: 0; text-transform: none;
  }
  .hpc-body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
  .hpc-label {
    font-size: 9px; font-weight: 600; color: var(--text-color-muted); text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 1px;
  }
  .hpc-input {
    width: 100%; padding: 4px 7px; background: var(--page-bg); border: 1px solid var(--border-color);
    border-radius: 4px; color: var(--text-color-muted); font-size: 11px; font-family: inherit;
    outline: none; box-sizing: border-box;
  }
  .hpc-input:focus { border-color: var(--accent-color, #3b82f6); }
  .hpc-select { cursor: pointer; }
  .hpc-script-row { display: flex; gap: 4px; }
  .hpc-script-row .hpc-select { flex: 1; }
  .hpc-script-btn {
    padding: 4px 8px; background: var(--page-bg); border: 1px solid var(--border-color);
    border-radius: 4px; color: var(--text-color-muted); font-size: 12px; cursor: pointer;
    font-family: inherit; flex-shrink: 0; line-height: 1;
  }
  .hpc-script-btn:hover { border-color: var(--accent-color, #3b82f6); color: var(--text-color); }
  .hpc-params-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .hpc-field { display: flex; flex-direction: column; }
  .hpc-field-wide { grid-column: 1 / -1; }
  .hpc-checkbox-row {
    display: flex; align-items: center; gap: 6px; margin: 4px 0;
    font-size: 11px; color: var(--text-color-muted, #8b949e); cursor: pointer;
  }
  .hpc-checkbox-row input[type="checkbox"] { margin: 0; cursor: pointer; }
  .hpc-textarea {
    resize: vertical; min-height: 80px; line-height: 1.4;
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace; font-size: 10px;
  }

</style>

<script lang="ts">
  import type { AnyStructure, ElementSymbol, PymatgenMolecule, Site, Vec3 } from '$lib'
  import { AtomManager, type AtomFastOps } from './atoms/atom-manager.svelte'
  import { ContextMenu, Icon, Spinner, toggle_fullscreen } from '$lib'
  import { type ColorSchemeName, element_color_schemes } from '$lib/colors'
  import { decompress_file, load_from_url, check_tauri } from '$lib/io'
  import { DosAnalysisPane, DosPlot, CohpAnalysisPane, CohpPlot, BandAnalysisPane, BandPlot, FreqAnalysisPane, ChargeAnalysisPane } from '$lib/electronic'
  import type { DOSSessionInfo, DosViewState, CohpViewState, BandViewState } from '$lib/electronic'
  import { API_BASE } from '$lib/api/config'
  import { elem_symbols } from '$lib/labels'

  import { DEFAULTS, type ShowBonds } from '$lib/settings'
  import type { BondingStrategy } from './bonding'
  import { create_trajectory_bond_cache, wire_trajectory_bond_cache } from './trajectory-bond-cache.svelte'
  import { colors, atom_clipboard, terminal_font_state } from '$lib/state.svelte'
  import type { PymatgenStructure } from '$lib/structure'
  import {
    align_to_principal_axes,
    get_elem_amounts,
  } from '$lib/structure'
  import { parse_supercell_scaling } from '$lib/structure/supercell'
  import { WyckoffTable, wyckoff_positions_from_moyo, spacegroup_to_crystal_sys } from '$lib/symmetry'
  import type { Crystal } from '$lib/structure'
  import type { MoyoDataset } from '@spglib/moyo-wasm'
  import { Canvas } from '@threlte/core'
  import GestureProvider from '$lib/gesture/GestureProvider.svelte'
  import GestureOverlay from '$lib/gesture/GestureOverlay.svelte'
  import { StructureAdapter, type StructureGestureAPI } from '$lib/gesture/structure-adapter'
  import { AtomArt, type AtomArtAPI } from '$lib/gesture/atom-art'
  import { type GestureEvent, type GestureAction, type VoiceEvent, type GestureConfig } from '$lib/gesture/gesture-types'
  import { load_gesture_config, save_gesture_config } from '$lib/gesture/gesture-config-store'
  import GestureSettingsPane from '$lib/gesture/GestureSettingsPane.svelte'
  import type { ComponentProps, Snippet } from 'svelte'
  import { tick, untrack } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { prewarm_bond_worker } from './workers/bond-worker-api'
  import { click_outside, tooltip } from 'svelte-multiselect'
  import type { HTMLAttributes } from 'svelte/elements'
  import type { StructureHandlerData, Measurement } from './index'
  import {
    AtomLegend,
    CellSelect,
    StructureControls,
    StructureExportPane,
    StructureInfoPane,
    StructureLegend,
    StructureScene,
    LatticePane,
    MillerSlabCutterPane,
    OptimizationPane,
    AdsorptionSitePane,
    AdsorbatePlacementPane,
    CubePanel,
    WaterLayerPane,
    PseudoHydrogenPane,
    MoirePane,
    NanotubePane,
    NanoscrollPane,
    HeterostructurePane,
    DopingPane,
    DopingPTPanel,
    PathwayBuilderPane,
    BuildPane,
    AnalysisPane,
    WorkflowPane,
    IOPane,
    ServerPane,
    JobDetailPane,
    PluginHubPane,
  } from './index'
  import LargeSystemOverlay from './gpu/LargeSystemOverlay.svelte'
  import { ChatPane, get_display_text } from '$lib/chat'
  import { send_message, get_chat_slice, chat_position } from '$lib/chat/chat-state.svelte'
  import { build_structure_context } from '$lib/chat/context'
  import { analysis_sessions, get_analysis_session, get_session_blob } from '$lib/chat/analysis-session-store.svelte'
  import { start_mcp_bridge, type McpBridgeDeps } from './controllers/tool-handler'
  import { set_current_structure } from './current-structure.svelte'
  import { molecular_fragments, type MolecularFragment } from './controllers/fragments'
  import { create_xrd_controller, format_hkl } from './controllers/xrd-state.svelte'
  import { create_build_tools_controller } from './controllers/build-tools.svelte'
  import { create_file_handlers, content_to_base64 } from './controllers/file-handlers'
  import { create_context_menu_actions } from './controllers/context-menu-actions'
  import { analyze_mof, get_isolated_node_atoms, normalize_sbu_type, compute_rac, compute_wl_hashes, replace_mof_caps } from './mof-analysis'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { MofClusters, MofAnalysisResult, RacResult, WlHashResult, FunctionalGroup } from './mof-analysis'
  import { create_interaction_controller, type InteractionDeps } from './controllers/interaction.svelte'
  import { create_pencil_mode_controller } from './controllers/pencil-mode.svelte'
  import { create_analysis_controller } from './controllers/analysis.svelte'
  import { create_settings_controller } from './controllers/settings.svelte'
  import { create_transform_controller } from './controllers/transform-controller.svelte'
  import { create_viewer_controller } from './controllers/viewer-controller.svelte'

  load_i18n_module('structure')
  load_i18n_module('common')
  import { create_selection_state } from './state/selection-state.svelte'
  import { create_charge_labels_state } from './state/charge-labels-state.svelte'
  import { create_measurement_state } from './state/measurement-state.svelte'
  import {
    is_image_atom as _is_image_atom,
    has_original_atoms as _has_original_atoms,
    get_original_atoms_only as _get_original_atoms_only,
    get_import_position_outside,
    apply_charges,
  } from './controllers/transform-controller'
  import {
    prune_measurements,
    compute_unique_elements,
    prune_charge_labels,
  } from './controllers/analysis-controller'
  import {
    build_constraints_section,
    build_charge_label_section,
    validate_bond_edits,
  } from './controllers/viewer-controller'
  // tool-controller.svelte.ts exists but is not yet wired (template bind: compatibility)
  import StructureToolbar from './StructureToolbar.svelte'
  import { MdAnalysisPane, MdPlot } from '$lib/md'
  import SlowGrowthPane from '$lib/structure/SlowGrowthPane.svelte'
  import ScaleBar from '$lib/structure/ScaleBar.svelte'

  import type { AtomColorConfig } from './atom-properties'
  import { get_orig_site_idx } from './atom-properties'
  import { toggle_site_selection } from './scene/picking'

  import { delete_atoms, move_atom, move_atoms_by_displacement, concatenate_structures, merge_structures } from './atom-manipulation'
  import OptimadeSearchModal from './OptimadeSearchModal.svelte'
  import OptimadePreviewModal from './OptimadePreviewModal.svelte'
  import PasteContentModal from './PasteContentModal.svelte'
  import VacuumBoxModal from './VacuumBoxModal.svelte'
  import { translate_sites } from './manipulation'
  import { MAX_SELECTED_SITES } from './measure'
  import { is_acf_dat, parse_acf_dat } from './parse-charges'
  import { SlicePanel } from '$lib/cube'
  import TerminalPanel from './TerminalPanel.svelte'
  import MonacoEditorPanel from './MonacoEditorPanel.svelte'
  import FilePreviewPanel from './FilePreviewPanel.svelte'
  import type { SliceResult, AtomSliceInfo } from '$lib/cube/slice'
  import { in_plane_basis, rodrigues_rotate, normalize as vec3_normalize } from '$lib/cube/slice'
  import { parse_any_structure, pubchem_to_pymatgen } from './parse'
  import { PeriodicTable } from '$lib/periodic-table'
  import { element_data } from '$lib/element'
  import { parse_structure_file } from './parse'
  import { Euler, Quaternion, Spherical, Vector3 } from 'three'
  import { format_value } from '$lib/labels'
  import type { BarHandlerProps } from '$lib/plot'
  import { BarPlot } from '$lib/plot'
  import type { Hkl } from '$lib/xrd'

  // Type alias for event handlers to reduce verbosity
  type EventHandler = (data: StructureHandlerData) => void

  // Detect macOS for platform-specific keybindings
  const is_mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)

  // Check if box selection modifier is pressed (Cmd on Mac, Ctrl on Windows/Linux)
  function is_box_select_modifier(event: MouseEvent | KeyboardEvent): boolean {
    return is_mac ? event.metaKey : event.ctrlKey
  }

  // Controllers are initialized after $props() — see below line ~815
  // (closures over `structure`, `wrapper`, etc. require them to be declared first)
  let settings: ReturnType<typeof create_settings_controller>
  let build = $state<ReturnType<typeof create_build_tools_controller>>(undefined as any)
  let analysis = $state<ReturnType<typeof create_analysis_controller>>(undefined as any)
  let transform: ReturnType<typeof create_transform_controller>
  let viewer: ReturnType<typeof create_viewer_controller>
  let scene_props = $state<ReturnType<typeof create_settings_controller>['scene_props']>(undefined as any)
  let lattice_props = $state<ReturnType<typeof create_settings_controller>['lattice_props']>(undefined as any)

  let center_camera_trigger = $state(0) // Increment to trigger camera centering on new structure
  let reset_camera_up_trigger = $state(0) // Increment to reset camera.up to [0,1,0] after slab cut

  // Phase X5: atom-delete fast-path, bound from <StructureScene>. StructureScene
  // owns atom_manager + bond_state + bond_manager and publishes this hook; we
  // call it in `delete_selected()` (below) BEFORE mutating `structure` so the
  // bond-pipeline fingerprints are pre-bumped to the post-delete sites — the
  // subsequent `structure = delete_atoms(...)` then reconciles as a no-op diff
  // rather than triggering a full WASM bond recompute. Null until the scene's
  // $effect populates it; also null when USE_NEW_ATOM_SYSTEM is off (the hook
  // short-circuits internally in that case).
  let scene_atom_fast_ops = $state<AtomFastOps | null>(null)

  // Plan v3 Phase 1: lift atom_manager from StructureScene to Structure.svelte
  // via $bindable. Trajectory.svelte (parent of Structure.svelte) does not
  // render Structure directly — it forwards trajectory_frame_positions as a
  // prop. The position-write loop (Phase 2) lives in Structure.svelte and
  // writes to scene_atom_manager. The $bindable contract: StructureScene's
  // default `new AtomManager()` is overwritten by this $state value at mount,
  // so the second allocation is discarded (small one-time cost).
  let scene_atom_manager = $state(new AtomManager())

  // WebGPU overlay bridge: bound from StructureScene. Returns the live
  // per-displayed-atom current-frame position array (3 × n_displayed) the
  // WebGL atoms/bonds render at (StructureScene.atom_positions_buffer:
  // displayed-topology base overlaid with the manager's per-frame positions).
  // The overlay calls this so its positions match the WebGL view atom-for-atom
  // instead of re-deriving from base-only trajectory data. Null until mount.
  let scene_get_displayed_frame_positions = $state<(() => Float32Array) | null>(null)

  // ── Extracted state modules (state/*.svelte.ts) ──
  const sel_state = create_selection_state()
  const charge_state = create_charge_labels_state()
  const meas_state = create_measurement_state()

  // ── 交互控制器 (拖拽/旋转/框选/裁剪/键盘操作 — 详见 controllers/interaction.svelte.ts) ──
  // interaction controller 在下方 wiring 区域初始化，因为需要依赖 pencil/bond 等后定义的状态

  // ── 铅笔/键编辑控制器 (铅笔画原子/片段 + 键编辑 — 详见 controllers/pencil-mode.svelte.ts) ──
  // pencil controller 在下方 wiring 区域初始化，因为需要依赖 interaction controller

  // ─── Gesture Control State ───────────────────────────────────
  let gesture_active = $state(false)
  let gesture_art_mode = $state(false)
  let gesture_config = $state<GestureConfig>(load_gesture_config())
  let show_gesture_settings = $state(false)
  let gesture_adapter: StructureAdapter | null = null
  let gesture_hovered_idx = $state<number | undefined>(undefined)

  // Auto-save gesture config to localStorage when it changes
  $effect(() => {
    // Access all config fields to track changes
    const _ = JSON.stringify(gesture_config)
    save_gesture_config(gesture_config)
  })

  // Gesture API: bridges gestures to the structure viewer
  const gesture_api: StructureGestureAPI = {
    rotate(axis, angle) {
      if (orbit_controls && camera) {
        const cam = (orbit_controls as any).object
        const target = (orbit_controls as any).target as Vector3
        const ctrl = orbit_controls as any

        // Always orbit around the SCENE CENTER (structure's center of mass).
        // Rotate BOTH camera and target around it, preserving their relative
        // offset (the pan displacement). This guarantees the structure always
        // rotates around its own center, regardless of panning.
        const pivot = rotation_target_ref
          ? new Vector3(...rotation_target_ref)
          : new Vector3(0, 0, 0)

        cam.updateMatrixWorld(true)

        // Build rotation quaternion
        const q = new Quaternion()
        if (axis === `y`) {
          // Yaw: rotate around world Y (turntable)
          q.setFromAxisAngle(new Vector3(0, 1, 0), angle)
        } else if (axis === `x`) {
          // Pitch: rotate around camera's local right axis
          const right = new Vector3()
          cam.matrixWorld.extractBasis(right, new Vector3(), new Vector3())
          right.normalize()
          q.setFromAxisAngle(right, angle)
        }

        // Rotate camera position around pivot
        const cam_off = cam.position.clone().sub(pivot)
        cam_off.applyQuaternion(q)
        cam.position.copy(pivot).add(cam_off)

        // Rotate target around same pivot (preserves pan offset)
        const tgt_off = target.clone().sub(pivot)
        tgt_off.applyQuaternion(q)
        target.copy(pivot).add(tgt_off)

        // Rotate up vector so camera stays oriented correctly
        cam.up.applyQuaternion(q)
        cam.lookAt(target)
        cam.updateMatrixWorld(true)

        // Sync TrackballControls internal state
        ctrl._lastAngle = 0
        if (ctrl._lastAxis) ctrl._lastAxis.set(0, 0, 0)
        if (ctrl._target0) ctrl._target0.copy(target)
        if (ctrl._eye0) ctrl._eye0.subVectors(cam.position, target)
        if (ctrl._up0) ctrl._up0.copy(cam.up)
      } else {
        // Fallback: rotate the scene directly
        const r = [...scene_props.rotation] as Vec3
        if (axis === `x`) r[0] += angle
        else if (axis === `y`) r[1] += angle
        else r[2] += angle
        scene_props.rotation = r
      }
    },
    zoom(delta) {
      if (orbit_controls) {
        const cam = (orbit_controls as any).object
        const target = (orbit_controls as any).target as Vector3
        const cam_dist = cam.position.distanceTo(target)
        const dir = new Vector3().subVectors(cam.position, target).normalize()
        cam.position.addScaledVector(dir, -delta)
        cam.updateMatrixWorld(true)

        const ctrl = orbit_controls as any
        if (ctrl._eye0) ctrl._eye0.subVectors(cam.position, target)
      }
    },
    pan(dx, dy) {
      if (orbit_controls) {
        const cam = (orbit_controls as any).object
        const target = (orbit_controls as any).target as Vector3
        const ctrl = orbit_controls as any
        const cam_dist = cam.position.distanceTo(target)
        const canvas_h = height ?? 600

        // Convert pixel delta to world units using camera FOV
        const fov_rad = (cam.fov ?? 50) * Math.PI / 180
        const world_per_pixel = (2 * cam_dist * Math.tan(fov_rad / 2)) / canvas_h
        const s = world_per_pixel * 0.35

        // Ensure matrixWorld reflects latest rotation
        cam.updateMatrixWorld(true)

        // Use camera's right/up vectors so pan is screen-aligned at any viewing angle
        const right = new Vector3()
        const up = new Vector3()
        cam.matrixWorld.extractBasis(right, up, new Vector3())
        right.normalize()
        up.normalize()

        const shift = new Vector3()
          .addScaledVector(right, dx * s)
          .addScaledVector(up, -dy * s)

        // Move camera AND target together (pure translation, no rotation)
        cam.position.add(shift)
        target.add(shift)

        // Hard clamp: keep target within visible frustum
        const origin = rotation_target_ref
          ? new Vector3(...rotation_target_ref)
          : new Vector3(0, 0, 0)
        const visible_h = 2 * cam_dist * Math.tan(fov_rad / 2)
        const max_drift = visible_h * 0.3
        const drift = target.distanceTo(origin)
        if (drift > max_drift) {
          const excess = new Vector3().subVectors(target, origin)
          excess.setLength(max_drift)
          const clamped_target = origin.clone().add(excess)
          const correction = new Vector3().subVectors(clamped_target, target)
          cam.position.add(correction)
          target.add(correction)
        }

        cam.updateMatrixWorld(true)

        // Sync ALL TrackballControls internal state — do NOT call ctrl.update()
        ctrl._lastAngle = 0
        if (ctrl._lastAxis) ctrl._lastAxis.set(0, 0, 0)
        if (ctrl._target0) ctrl._target0.copy(target)
        if (ctrl._eye0) ctrl._eye0.subVectors(cam.position, target)
        if (ctrl._up0) ctrl._up0.copy(cam.up)
      }
    },
    atom_at(sx, sy) {
      // Project all atom positions to screen space and find closest to (sx, sy)
      if (!structure || !camera) return gesture_hovered_idx ?? null
      const cam = camera as any
      cam.updateMatrixWorld?.(true)

      const w = width ?? 800
      const h = height ?? 600
      const threshold = 30  // pixels
      let best_idx: number | null = null
      let best_dist = threshold

      const v = new Vector3()
      for (let i = 0; i < structure.sites.length; i++) {
        const pos = structure.sites[i].xyz
        v.set(pos[0], pos[1], pos[2])
        v.project(cam)
        const screen_x = (v.x * 0.5 + 0.5) * w
        const screen_y = (-v.y * 0.5 + 0.5) * h
        const dist = Math.hypot(screen_x - sx, screen_y - sy)
        if (dist < best_dist) {
          best_dist = dist
          best_idx = i
        }
      }
      return best_idx
    },
    set_hover(idx) {
      gesture_hovered_idx = idx ?? undefined
    },
    toggle_select(idx) {
      if (selected_sites.includes(idx)) {
        selected_sites = selected_sites.filter(i => i !== idx)
      } else {
        selected_sites = [...selected_sites, idx]
      }
    },
    reset_camera() {
      scene_props.rotation = [...lattice_alignment_rotation] as Vec3
    },
    select_all() {
      if (structure) {
        selected_sites = Array.from({ length: structure.sites.length }, (_, i) => i)
      }
    },
    clear_selection() {
      selected_sites = []
    },
    delete_selected() {
      if (selected_sites.length > 0 && structure) {
        const original_indices = get_original_atoms_only(selected_sites)
        if (original_indices.length > 0) {
          // Sparse atom-kind undo (same path as keyboard Delete / context menu)
          // — avoids an O(N) structure snapshot on large structures.
          const sorted_indices = [...original_indices].sort((a, b) => a - b)
          const removed_sites = sorted_indices.map((idx) => structure!.sites[idx])
          const prev_overrides = sel_state.atom_opacity_overrides
          const removed_atom_opacity_entries: Array<[number, number]> = []
          for (const idx of sorted_indices) {
            const v = prev_overrides.get(idx)
            if (v !== undefined) removed_atom_opacity_entries.push([idx, v])
          }
          sel_state.push_atom_entry({
            removed_sites,
            removed_indices: sorted_indices,
            removed_atom_opacity_entries,
          })
          pencil.push_bond_undo()
          if (removed_atom_opacity_entries.length > 0) {
            const next = new Map(prev_overrides)
            for (const idx of sorted_indices) next.delete(idx)
            sel_state.atom_opacity_overrides = next
          }
          // Phase X5: fire the direct-to-manager fast path BEFORE the canonical
          // sites mutation below. Order is load-bearing (see plan X5): the hook
          // pre-bumps last_bond_fingerprint / last_elem_fingerprint to match
          // `next_sites`, so when `structure = delete_atoms(...)` triggers
          // reactivity the next tick, `compute_bond_connectivity` sees no
          // fingerprint change and skips the full WASM recompute. Reversing
          // these two steps would run the expensive path and lose the win.
          // No-ops when USE_NEW_ATOM_SYSTEM is false — the hook short-circuits.
          const deleted_set = new Set(sorted_indices)
          const next_sites: Site[] = structure.sites.filter((_, i) => !deleted_set.has(i))
          scene_atom_fast_ops?.try_delete(sorted_indices, next_sites)
          structure = delete_atoms(structure, sorted_indices)
          selected_sites = []
        }
      }
    },
    undo() {
      if (sel_state.can_undo) undo()
    },
    canvas_size() {
      return { width: width ?? 800, height: height ?? 600 }
    },
  }

  let prev_gesture_action: GestureAction = `idle`

  // Grab-and-follow state: absolute position tracking for pan
  // Records hand + camera positions at grab start, then moves camera
  // by exactly the hand's displacement — true 1:1 "stuck to hand" feel.
  let grab_hand: { x: number; y: number } | null = null
  let grab_cam_pos: Vector3 | null = null
  let grab_target_pos: Vector3 | null = null

  function on_gesture(event: GestureEvent): void {
    if (!gesture_adapter) {
      gesture_adapter = new StructureAdapter(gesture_api, gesture_config.sensitivity)
    }

    // On every gesture action change, force-sync TrackballControls
    if (event.action !== prev_gesture_action && orbit_controls && camera) {
      const ctrl = orbit_controls as any
      const target = ctrl.target as Vector3
      ctrl._lastAngle = 0
      if (ctrl._lastAxis) ctrl._lastAxis.set(0, 0, 0)
      if (ctrl._target0) ctrl._target0.copy(target)
      if (ctrl._eye0) ctrl._eye0.subVectors(camera.position, target)
      if (ctrl._up0) ctrl._up0.copy(camera.up)
      if (ctrl._panStart && ctrl._panEnd) ctrl._panStart.copy(ctrl._panEnd)
      if (ctrl._rotateStart && ctrl._rotateEnd) ctrl._rotateStart.copy(ctrl._rotateEnd)

      // Reset grab state when leaving or entering pan
      grab_hand = null
      grab_cam_pos = null
      grab_target_pos = null
    }
    prev_gesture_action = event.action

    // ── Grab-and-follow: absolute position pan ────────────────────
    // Bypasses the delta-based pipeline entirely for pan.
    // The structure is locked to the hand's displacement from the grab point.
    if (event.action === `pan` && orbit_controls && camera) {
      const cam = (orbit_controls as any).object
      const target = (orbit_controls as any).target as Vector3
      const ctrl = orbit_controls as any

      // First pan frame: record grab origin
      if (!grab_hand) {
        grab_hand = { ...event.hands[0].center }
        grab_cam_pos = cam.position.clone()
        grab_target_pos = target.clone()
        return
      }

      // Compute hand displacement from grab point (normalized 0-1)
      const hand_pos = event.hands[0].center
      const disp_x = hand_pos.x - grab_hand.x
      const disp_y = hand_pos.y - grab_hand.y

      // Convert to world units using camera FOV.
      // PAN_GAIN < 1 reduces sensitivity so small hand movements don't fling
      // the structure off-screen. 0.35 means full hand sweep = 35% of visible area.
      const PAN_GAIN = 0.35
      const cam_dist = grab_cam_pos!.distanceTo(grab_target_pos!)
      const canvas_h = height ?? 600
      const canvas_w = width ?? 800
      const fov_rad = (cam.fov ?? 50) * Math.PI / 180
      const world_per_norm_y = 2 * cam_dist * Math.tan(fov_rad / 2) * PAN_GAIN
      const world_per_norm_x = world_per_norm_y * (canvas_w / canvas_h)

      // Get camera-aligned directions
      cam.updateMatrixWorld(true)
      const right = new Vector3()
      const up = new Vector3()
      cam.matrixWorld.extractBasis(right, up, new Vector3())
      right.normalize()
      up.normalize()

      // Map hand displacement to world-space: structure follows the on-screen hand.
      // Camera+target moving LEFT makes structure appear to shift RIGHT on screen,
      // so we negate disp_x. MediaPipe y increases downward, and camera moving DOWN
      // makes structure appear UP, so +disp_y (negative when hand goes up) is correct.
      const world_shift = new Vector3()
        .addScaledVector(right, -disp_x * world_per_norm_x)
        .addScaledVector(up, disp_y * world_per_norm_y)

      // Set absolute positions (not additive — no drift accumulation)
      cam.position.copy(grab_cam_pos!).add(world_shift)
      target.copy(grab_target_pos!).add(world_shift)

      // Clamp: keep target within visible frustum
      const origin = rotation_target_ref
        ? new Vector3(...rotation_target_ref)
        : new Vector3(0, 0, 0)
      // max_drift uses the un-gained visible height to set an absolute screen limit
      const visible_h = 2 * cam_dist * Math.tan(fov_rad / 2)
      const max_drift = visible_h * 0.25
      const drift = target.distanceTo(origin)
      if (drift > max_drift) {
        const excess = new Vector3().subVectors(target, origin)
        excess.setLength(max_drift)
        const clamped = origin.clone().add(excess)
        const correction = new Vector3().subVectors(clamped, target)
        cam.position.add(correction)
        target.add(correction)
      }

      cam.updateMatrixWorld(true)

      // Sync TrackballControls
      ctrl._lastAngle = 0
      if (ctrl._lastAxis) ctrl._lastAxis.set(0, 0, 0)
      if (ctrl._target0) ctrl._target0.copy(target)
      if (ctrl._eye0) ctrl._eye0.subVectors(cam.position, target)
      if (ctrl._up0) ctrl._up0.copy(cam.up)
      return
    }

    // Scale screen_pos from normalized (0-1) to actual pixels
    const w = width ?? 800
    const h = height ?? 600
    event.screen_pos = { x: event.screen_pos.x * w, y: event.screen_pos.y * h }
    gesture_adapter.process(event)
  }

  function on_voice(event: VoiceEvent): void {
    if (!gesture_adapter) {
      gesture_adapter = new StructureAdapter(gesture_api, gesture_config.sensitivity)
    }

    // Skip direct command processing for AI queries (handled by GestureProvider)
    if (event.action.type === `ai_query`) return

    gesture_adapter.process_voice(event)

    // Handle element selection for art mode
    if (event.is_final && event.action.type === `element`) {
      selected_add_element = event.action.symbol as ElementSymbol
    }
    // Handle mode toggles
    if (event.is_final && event.action.type === `mode`) {
      if (event.action.command === `art_on`) gesture_art_mode = true
      else if (event.action.command === `art_off`) gesture_art_mode = false
      else if (event.action.command === `gesture_off`) {
        gesture_active = false
        gesture_config = { ...gesture_config, enabled: false }
      }
    }
  }

  /** Route voice input to the AI chat system. Returns response text for TTS. */
  async function on_voice_ai_query(text: string): Promise<string> {
    try {
      // Pick this Structure's tab slice so the voice query lands in the
      // correct tab's chat thread and reads the right context string.
      const voice_tab_id = tab_id ?? `default`
      const slice = get_chat_slice(voice_tab_id)

      // Ensure structure context is fresh (ChatPane might not be open)
      slice.structure_context.value = build_structure_context({
        structure,
        symmetry_data,
        selected_sites,
      })

      const prev_count = slice.messages.list.length
      await send_message(text, undefined, voice_tab_id)

      // Extract last assistant response text
      for (let i = slice.messages.list.length - 1; i >= prev_count; i--) {
        if (slice.messages.list[i].role === `assistant`) {
          const display = get_display_text(slice.messages.list[i].content)
          if (display) return display
        }
      }
      return `Done.`
    } catch (err) {
      console.error(`[Gesture AI]`, err)
      return `Sorry, I encountered an error.`
    }
  }

  // 铅笔模式的当前选中片段（分子片段数据已抽取到 controllers/fragments.ts）
  let selected_fragment = $state<MolecularFragment>(molecular_fragments[0])

  // Context menu state for atom manipulation
  let context_menu_visible = $state(false)
  let context_menu_position = $state({ x: 0, y: 0 })
  let context_menu_3d_position = $state<[number, number, number] | null>(null)
  let clip_center = $state<[number, number, number] | null>(null)
  let mof_clusters = $state<MofClusters | null>(null)
  let mof_analysis_result = $state<MofAnalysisResult | null>(null)
  let isolated_node_atoms = $state<Set<number> | null>(null)
  let mof_loading = $state(false)
  let mof_error = $state<string | null>(null)
  let rac_result = $state<RacResult | null>(null)
  let rac_loading = $state(false)
  let wl_hashes = $state.raw<WlHashResult[] | null>(null)
  let cap_replace_smiles = $state('')
  let cap_replace_loading = $state(false)
  let cap_replace_error = $state<string | null>(null)

  // Clear MOF results when structure changes
  $effect(() => {
    void structure
    mof_clusters = null
    mof_analysis_result = null
    isolated_node_atoms = null
    mof_error = null
    rac_result = null
    wl_hashes = null
    cap_replace_error = null
  })

  async function run_mof_analysis() {
    // Analyze the BASE structure (not displayed_structure which has image atoms).
    // selected_sites uses base indices — StructureScene maps to images via orig_site_idx.
    const struct = structure
    if (!struct?.sites?.length) return
    mof_loading = true
    mof_error = null
    rac_result = null
    wl_hashes = null
    try {
      mof_analysis_result = await analyze_mof(struct)
      mof_clusters = mof_analysis_result?.clusters ?? null
      isolated_node_atoms = null
      // Auto-compute WL hashes if MOF detected
      if (mof_analysis_result && mof_clusters?.is_mof) {
        wl_hashes = await compute_wl_hashes(struct, mof_analysis_result.bonds_json, mof_clusters)
      }
    } catch (err) {
      mof_error = err instanceof Error ? err.message : String(err)
      mof_clusters = null
      mof_analysis_result = null
    } finally {
      mof_loading = false
    }
  }
  let selected_add_element = $state<ElementSymbol>(`C`) // Default element to add
  let context_menu_target_site = $state<number | null>(null) // Site index for replace/delete operations
  // Selection state — delegated to state/selection-state.svelte.ts (sel_state)
  // Bond editing state — 由 pencil controller 管理 (controllers/pencil-mode.svelte.ts)
  // Ghost atom indices — atoms marked as "ghost" (rendered transparent, excluded from export)
  let ghost_atom_indices = $state(new Set<number>())
  // 右键菜单"缺陷原子"区块的 toggle 标签文字
  let ghost_toggle_label = $derived.by(() => {
    const targets = context_menu_target_site !== null
      ? [context_menu_target_site]
      : selected_sites
    const all_ghosted = targets.length > 0 && targets.every((idx) => ghost_atom_indices.has(idx))
    const count = targets.length
    if (all_ghosted) return count > 1 ? `Unmark ${count} as ghost` : `Unmark as ghost`
    return count > 1 ? `Mark ${count} as ghost` : `Mark as ghost`
  })
  // Bond edit history — 由 pencil controller 管理 (pencil.push_bond_undo / pencil.pop_bond_undo)
  let molecule_import_input: HTMLInputElement | null = $state(null) // Hidden file input for molecule import
  let charges_import_input: HTMLInputElement | null = $state(null) // Hidden file input for charge data import
  let color_picker_input: HTMLInputElement | null = $state(null) // Hidden color input for per-atom color override
  // Per-atom charge label state — delegated to state/charge-labels-state.svelte.ts (charge_state)
  let molecule_import_position: [number, number, number] | null = $state(null) // Position to place imported molecule
  let optimade_import_position: [number, number, number] | null = $state(null) // Position to place OPTIMADE imported structure
  let optimade_modal_visible = $state(false) // OPTIMADE search modal visibility
  let optimade_preview_visible = $state(false) // OPTIMADE preview modal visibility
  let optimade_pending_structure = $state<any>(null) // Pending OPTIMADE structure for preview
  let optimade_pending_pymatgen = $state<PymatgenStructure | null>(null) // Pending PymatgenStructure for preview
  let optimade_pending_provider = $state<string | null>(null) // Provider name for preview
  let optimade_preview_details = $state<Array<{ label: string; value: string; mono?: boolean }>>([])
  let optimade_preview_formula = $state<string>('')
  let optimade_preview_lattice = $state<{ a: number; b: number; c: number; alpha: number; beta: number; gamma: number } | null>(null)
  let optimade_preview_title = $state<string>('Preview Structure Import')
  let pubchem_import_position: [number, number, number] | null = $state(null) // Position to place PubChem imported structure
  let paste_content_modal_visible = $state(false) // Paste content modal visibility
  let vacuum_box_modal_visible = $state(false) // Vacuum box modal visibility
  let pending_tool_after_wrap = $state<'slab_cutter' | 'lattice_pane' | 'adsorption_pane' | 'vasp_export' | null>(null)
  let periodic_table_visible = $state(false) // Periodic table modal for element selection
  // Structure loading stage
  let {
    structure = $bindable(undefined),
    scene_props: scene_props_in = $bindable(undefined),
    lattice_props: lattice_props_in = $bindable(undefined),
    controls_open = $bindable(false),
    info_pane_open = $bindable(false),
    enable_measure_mode = $bindable(true),
    background_color = $bindable(undefined),
    background_opacity = $bindable(0.1),
    show_controls = 0,
    fullscreen = false,
    wrapper = $bindable(undefined),
    width = $bindable(0),
    height = $bindable(0),
    reset_text = `Reset camera (or double-click)`,
    color_scheme = $bindable(`Vesta`),
    hovered = $bindable(false),
    dragover = $bindable(false),
    allow_file_drop = true,
    enable_info_pane = true,
    png_dpi = $bindable(150),
    show_image_atoms = $bindable(true),
    image_atom_opacity = $bindable(1.0),
    periodic_repeats = $bindable<Vec3>([0, 0, 0]),
    supercell_scaling = $bindable(`1x1x1`),
    fullscreen_toggle = DEFAULTS.structure.fullscreen_toggle,
    hidden_toolbar_items = [] as string[],
    bottom_left,
    data_url,
    structure_string,
    on_file_drop,
    spinner_props = {},
    loading = $bindable(false),
    error_msg = $bindable(undefined),
    performance_mode = $bindable(`quality`),
    // expose selected site indices for external control/highlighting
    selected_sites = $bindable<number[]>([]),
    // expose measured site indices for overlays/labels
    measured_sites = $bindable<number[]>([]),
    // expose the displayed structure (with image atoms and supercell) for external use
    displayed_structure = $bindable<AnyStructure | undefined>(undefined),
    // expose the saveable structure (supercell without PBC images) for save/export
    saveable_structure = $bindable<AnyStructure | undefined>(undefined),
    // Track hidden elements across component lifecycle
    hidden_elements = $bindable(new Set<ElementSymbol>()),
    // Track hidden individual sites (by site index)
    hidden_sites = $bindable(new Set<number>()),
    // Per-element-pair bond distance filter rules
    bond_distance_rules = $bindable<import('./index').BondDistanceRule[]>([]),
    // Track hidden property values (e.g. Wyckoff positions, coordination numbers)
    hidden_prop_vals = $bindable(new Set<number | string>()),
    // Per-element radius overrides (absolute values in Angstroms)
    element_radius_overrides = $bindable<Partial<Record<ElementSymbol, number>>>({}),
    // Per-site radius overrides (absolute values in Angstroms)
    site_radius_overrides = $bindable<SvelteMap<number, number>>(new SvelteMap()),
    // Per-site color overrides (hex strings, take precedence over element/property colors)
    site_color_overrides = $bindable<SvelteMap<number, string>>(new SvelteMap()),
    // Atom color configuration
    atom_color_config = $bindable<Partial<AtomColorConfig>>({
      mode: DEFAULTS.structure.atom_color_mode,
      scale: DEFAULTS.structure.atom_color_scale as any,
      scale_type: DEFAULTS.structure.atom_color_scale_type,
    }),
    // Map element symbols to different elements
    element_mapping = $bindable<Partial<Record<ElementSymbol, ElementSymbol>>>(),
    // Cell type: original, conventional, or primitive
    cell_type = $bindable<`original` | `conventional` | `primitive`>(`original`),
    // Symmetry analysis data (bindable for external access)
    symmetry_data = $bindable<MoyoDataset | null>(null),
    // Auto-align structure on load using principal axes
    align_on_load = $bindable<'none' | 'principal_axes'>('principal_axes'),
    // Remote file origin for "save structure back" feature
    remote_origin = $bindable<{ session_id: string; file_path: string } | null>(null),
    cube_file = null,
    children,
    on_file_load,
    on_error,
    on_fullscreen_change,
    on_camera_move,
    on_camera_reset,
    on_structure_imported,
    on_atoms_manipulated,
    on_atom_added,
    on_atoms_deleted,
    on_atom_replaced,
    on_save_to_project,
    on_save_to_database,
    on_clear_structure,
    on_export_to_hpc,
    on_export_to_file,
    on_edit_as_text,
    on_open_file_overlay,
    on_open_workflow_editor,
    hide_extra_tools = false,
    persist_settings = true,
    initial_panel,
    open_plugin_hub = $bindable(0),
    trajectory_context,
    trajectory_frame_positions = null,
    trajectory_frame_forces = null as Float32Array | null,
    trajectory_step_idx = -1,
    trajectory_positions_version = { v: 0, all: false },
    get_trajectory_frame_positions = null as ((i: number) => Float32Array | null) | null,
    initial_traj_b64 = ``,
    initial_traj_format = ``,
    vibration_data = null as { eigenvector: number[][]; base_positions: number[][]; amplitude: number; playing: boolean } | null,
    initial_bulk = null as PymatgenStructure | null,
    tab_id,
    ...rest
  }:
    & {
      structure?: AnyStructure
      scene_props?: ComponentProps<typeof StructureScene>
      // only show the buttons when hovering over the canvas on desktop screens
      // mobile screens don't have hover, so by default the buttons are always
      // shown on a canvas of width below 500px
      show_controls?: boolean | number
      fullscreen?: boolean
      // bindable width of the canvas
      width?: number
      // bindable height of the canvas
      height?: number
      // Canvas wrapper element (for export pane)
      wrapper?: HTMLDivElement
      // PNG export DPI setting
      png_dpi?: number
      reset_text?: string
      hovered?: boolean
      dragover?: boolean
      allow_file_drop?: boolean
      enable_info_pane?: boolean
      enable_measure_mode?: boolean
      info_pane_open?: boolean
      fullscreen_toggle?: Snippet<[]> | boolean
      hidden_toolbar_items?: string[]
      bottom_left?: Snippet<[{ structure?: AnyStructure }]>
      data_url?: string // URL to load structure from (alternative to providing structure directly)
      // Generic callback for when files are dropped - receives raw content and filename
      on_file_drop?: (content: string | ArrayBuffer, filename: string) => void
      // spinner props (passed to Spinner component)
      spinner_props?: ComponentProps<typeof Spinner>
      loading?: boolean
      error_msg?: string
      // Performance mode: 'quality' (default) or 'speed' for large structures
      performance_mode?: `quality` | `speed`
      // allow parent components to control highlighted/selected site indices
      selected_sites?: number[]
      // explicit measured sites for distance/angle overlays
      measured_sites?: number[]
      // expose the displayed structure (with image atoms and/or supercell) for external use
      displayed_structure?: AnyStructure
      // expose the saveable structure (supercell without PBC images) for save/export
      saveable_structure?: AnyStructure
      // Track which elements are hidden (bindable across frames in trajectories)
      hidden_elements?: Set<ElementSymbol>
      // Track hidden individual sites (by site index)
      hidden_sites?: Set<number>
      // Track hidden property values (e.g. Wyckoff positions, coordination numbers)
      hidden_prop_vals?: Set<number | string>
      // Per-element radius overrides
      element_radius_overrides?: Partial<Record<ElementSymbol, number>>
      // Per-site radius overrides
      site_radius_overrides?: SvelteMap<number, number>
      // Per-site color overrides
      site_color_overrides?: SvelteMap<number, string>
      // Atom color configuration
      atom_color_config?: Partial<AtomColorConfig>
      // Element symbol remapping
      element_mapping?: Partial<Record<ElementSymbol, ElementSymbol>>
      // Cell type: original, conventional, or primitive
      cell_type?: `original` | `conventional` | `primitive`
      // Symmetry analysis data (bindable for external access)
      symmetry_data?: MoyoDataset | null
      // Auto-align structure on load using principal axes
      align_on_load?: 'none' | 'principal_axes'
      // Remote file origin for "save structure back" feature
      remote_origin?: { session_id: string; file_path: string } | null
      // Bulk reference for pseudo-hydrogen passivation (auto-set from slab cutter, or passed externally)
      initial_bulk?: PymatgenStructure | null
      // Raw cube file for isosurface processing (passed from desktop app when .cube file is opened)
      cube_file?: File | null
      // structure content as string (alternative to providing structure directly or via data_url)
      structure_string?: string
      children?: Snippet<[{ structure?: AnyStructure }]>
      on_file_load?: EventHandler
      on_error?: EventHandler
      on_fullscreen_change?: EventHandler
      on_camera_move?: EventHandler
      on_camera_reset?: EventHandler
      // Notify the parent that a structure was imported/merged into this pane (e.g. so a
      // multi-pane host can refresh the tab label). Notification only — the structure itself
      // is already applied via the bound `structure` prop.
      on_structure_imported?: () => void
      // Callback fired after atoms are committed from manipulation (drag, keyboard move, rotation).
      // Reports per-atom displacement vectors for cross-frame editing in trajectories.
      on_atoms_manipulated?: (event: import('./index').AtomManipulationEvent) => void
      // Callback fired after a single atom is added (pencil or context menu).
      // Used by Trajectory to replicate the addition across frames.
      on_atom_added?: (event: { element: ElementSymbol; position: Vec3 }) => void
      // Callback fired after atoms are deleted. Used by Trajectory for cross-frame editing.
      on_atoms_deleted?: (event: { site_indices: number[] }) => void
      // Callback fired after atoms are replaced. Used by Trajectory for cross-frame editing.
      on_atom_replaced?: (event: { site_indices: number[]; new_element: ElementSymbol }) => void
      // Callback to save current structure to a project (desktop app). Receives the structure to save.
      on_save_to_project?: (structure: Record<string, unknown>) => void
      // Callback to quick-save structure directly to CatGo database (no project dialog).
      on_save_to_database?: (structure: Record<string, unknown>) => void
      // Callback to clear the current structure (return to empty/landing state). Used by desktop multi-pane.
      on_clear_structure?: () => void
      // Callback to export current structure to HPC remote filesystem. Receives the structure to export.
      on_export_to_hpc?: (structure: Record<string, unknown>) => void
      // Callback to export current structure to local filesystem. Receives the structure to export.
      on_export_to_file?: (structure: Record<string, unknown>) => void
      // Callback to open structure in text editor (Monaco). Receives the structure to serialize.
      on_edit_as_text?: (structure: Record<string, unknown>) => void
      // Callback to open a remote file in a floating overlay (editor/preview). Called from terminal Ctrl+click.
      // Parent handles reading + file type routing (binary vs text, preview vs editor).
      on_open_file_overlay?: (file_path: string, filename: string, session_id: string) => void
      // Callback to open a workflow in the full editor. Receives workflow_id.
      on_open_workflow_editor?: (workflow_id: string) => void
      // Hide extra toolbar buttons (Build, Analysis, Workflow, IO, Server) — used in trajectory view
      hide_extra_tools?: boolean
      /** Set false for preview/readonly instances to prevent writing settings to localStorage. */
      persist_settings?: boolean
      // Auto-open a panel on mount: 'hpc' | 'chat' | 'terminal' | 'doping' | 'slab' | 'adsorbate'
      initial_panel?: `hpc` | `chat` | `terminal` | `doping` | `slab` | `adsorbate`
      // Counter prop: increment to open the Plugin Hub pane from outside
      open_plugin_hub?: number
      // Trajectory context for multi-frame export in ExportPane
      trajectory_context?: { total_frames: number; on_step: (idx: number) => void | Promise<void> }
      // Trajectory fast-path: flat Float32Array of positions (x,y,z triples) for current frame
      // When set, AtomImpostors updates only position buffers, skipping full atom_data re-derive
      trajectory_frame_positions?: Float32Array | null
      // Trajectory fast-path: flat Float32Array of forces (fx,fy,fz triples) for current frame
      trajectory_frame_forces?: Float32Array | null
      // Active trajectory frame index (for per-frame bond cache).
      trajectory_step_idx?: number
      // Bumps when the current trajectory frame's positions change in place
      // (atom edit). Drives a bond recompute the step-idx guard would skip.
      trajectory_positions_version?: { v: number; all: boolean }
      // Random-access lookup into the trajectory's position cache. When provided,
      // the bond cache can prefetch ±N neighbour frames and recompute connectivity
      // off the main thread.
      get_trajectory_frame_positions?: ((i: number) => Float32Array | null) | null
      // External trajectory data (base64) for MD analysis — set when embedded in Trajectory viewer
      initial_traj_b64?: string
      initial_traj_format?: string
      // Vibration mode animation data (from freq analysis)
      vibration_data?: { eigenvector: number[][]; base_positions: number[][]; amplitude: number; playing: boolean } | null
      // Stable per-tab identifier used as MCP panel_id so viewer pushes
      // (structure, selection, screenshots) from CatBot land in the
      // correct tab instead of colliding on a single "default" panel.
      // Defaults to "default" for callers that don't supply one.
      tab_id?: string
    }
    & Omit<ComponentProps<typeof StructureControls>, `children` | `onclose`>
    & Omit<HTMLAttributes<HTMLDivElement>, `children`> = $props()

  // ── Initialize Controllers (must be after $props() so closures can capture structure, wrapper, etc.) ──
  settings = create_settings_controller({
    get_structure: () => structure,
    get_wrapper: () => wrapper,
    get_background_color: () => background_color,
    get_background_opacity: () => background_opacity,
    get_performance_mode: () => performance_mode,
    persist: persist_settings,
  })
  scene_props = settings.scene_props
  lattice_props = settings.lattice_props

  transform = create_transform_controller({
    get_structure: () => structure,
    get_symmetry_data: () => symmetry_data,
    get_cell_type: () => cell_type,
    get_supercell_scaling: () => supercell_scaling,
    get_show_image_atoms: () => show_image_atoms,
    get_periodic_repeats: () => periodic_repeats,
    // Phase 1: when the GPU overlay instances the supercell, the CPU keeps the
    // base cell (no N× Site objects) — gates the supercell + PBC-image effects.
    get_gpu_supercell_active: () => gpu_supercell_active,
    set_displayed_structure: (s) => { displayed_structure = s },
    set_saveable_structure: (s) => { saveable_structure = s },
  })

  viewer = create_viewer_controller({
    get_structure: () => structure,
    get_atom_color_config: () => atom_color_config,
    get_scene_props_bonding_strategy: () => scene_props.bonding_strategy,
    get_symmetry_data: () => symmetry_data,
  })

  build = create_build_tools_controller({
    get_structure: () => structure,
    set_structure: (s) => { structure = s as typeof structure },
    get_supercell_scaling: () => supercell_scaling,
    set_supercell_scaling: (s) => { supercell_scaling = s },
    push_to_undo: () => push_to_undo(),
    inc_center_camera: () => { center_camera_trigger++ },
    inc_reset_camera_up: () => { reset_camera_up_trigger++ },
    align_view_to_lattice: () => align_view_to_lattice(),
    initial_bulk,
  })

  analysis = create_analysis_controller({
    get_structure: () => structure,
    get_symmetry_data: () => symmetry_data,
    set_symmetry_data: (v) => { symmetry_data = v },
  })

  // Initialize models from incoming props; mutations come from UI controls; we mirror into local dicts (NOTE only doing shallow merge)
  $effect.pre(() => {
    settings.apply_scene_props(scene_props_in)
    settings.apply_lattice_props(lattice_props_in)
  })

  // Load structure from URL when data_url is provided
  $effect(() => {
    if (data_url && !structure) {
      loading = true
      error_msg = undefined

      load_from_url(data_url, (content, filename) => {
        if (on_file_drop) on_file_drop(content, filename)
        else {
          // Parse structure internally when no handler provided
          try {
            const text_content = content instanceof ArrayBuffer
              ? new TextDecoder().decode(content)
              : content
            const parsed_structure = parse_any_structure(text_content, filename)
            if (parsed_structure) {
              center_camera_trigger++ // Trigger camera centering on new structure
              structure = parsed_structure
              // Capture for MD analysis
              imported_traj_b64 = content_to_base64(content instanceof ArrayBuffer ? content : content)
              imported_traj_format = filename.split(`.`).pop()?.toLowerCase() || ``
              // Emit file load event
              on_file_load?.({
                structure,
                filename,
                file_size: new Blob([content]).size,
                total_atoms: structure.sites?.length || 0,
              })
            } else {
              error_msg = `Failed to parse structure from ${filename}`
              on_error?.({ error_msg, filename })
            }
          } catch (error) {
            error_msg = `Failed to parse structure: ${
              error instanceof Error ? error.message : String(error)
            }`
            on_error?.({ error_msg, filename })
          }
        }
      })
        .then(() => loading = false)
        .catch((error: Error) => {
          console.error(`Failed to load structure from URL:`, error)
          error_msg = `Failed to load structure: ${error.message}`
          loading = false
          on_error?.({ error_msg, filename: data_url })
        })
    }
  })

  $effect(() => { // Parse structure from string when structure_string is provided
    if (!structure_string || data_url) return
    loading = true
    error_msg = undefined
    try {
      const parsed = parse_any_structure(structure_string, `string`)
      if (parsed) {
        center_camera_trigger++ // Trigger camera centering on new structure
        structure = parsed
        // Capture for MD analysis
        imported_traj_b64 = content_to_base64(structure_string)
        imported_traj_format = `xyz`
        untrack(() => file_handlers.emit_file_load(parsed, `string`, structure_string))
      } else {
        throw new Error(`Failed to parse structure from string`)
      }
    } catch (err) {
      error_msg = `Failed to parse structure from string: ${
        err instanceof Error ? err.message : String(err)
      }`
      untrack(() => on_error?.({ error_msg, filename: `string` }))
    } finally {
      loading = false
    }
  })

  // Clean up bond editing data when structure changes significantly
  let prev_site_count = $state<number | undefined>(undefined)
  $effect(() => {
    const count = structure?.sites?.length ?? 0
    if (prev_site_count !== undefined && count !== prev_site_count) {
      const result = validate_bond_edits(pencil.manual_bonds, pencil.deleted_bond_keys, count)
      if (result.manual_bonds) pencil.manual_bonds = result.manual_bonds
      if (result.deleted_bond_keys) pencil.deleted_bond_keys = result.deleted_bond_keys
      // Clear selection state
      pencil.selected_bonds = []
      pencil.bond_first_atom = null
    }
    prev_site_count = count
  })

  // Prune charge labels when structure changes (remove stale indices)
  $effect(() => {
    if (!structure?.sites) return
    // Read label sets without creating reactive dependency (only structure triggers this)
    const current_labels = untrack(() => charge_state.visible_charge_labels)
    const current_offsets = untrack(() => charge_state.charge_label_offsets)
    const pruned = prune_charge_labels(structure, current_labels)
    if (pruned) {
      charge_state.visible_charge_labels = pruned
      const new_offsets = new SvelteMap<number, [number, number]>()
      for (const [idx, offset] of current_offsets) {
        if (pruned.has(idx)) new_offsets.set(idx, offset)
      }
      charge_state.charge_label_offsets = new_offsets
    }
  })

  // Force vectors auto-enable and performance optimization effects are in settings controller

  $effect(() => {
    colors.element = element_color_schemes[color_scheme as ColorSchemeName]
  })

  let unique_elements = $derived(compute_unique_elements(structure))

  // Property colors are computed by the viewer controller (controllers/viewer-controller.svelte.ts)
  let property_colors = $derived(viewer.property_colors)
  let coordination_computing = $derived(viewer.coordination_computing)

  // Track if structure has been aligned to prevent re-alignment
  let structure_aligned_id = $state<string | null>(null)
  let trajectory_active = $derived(trajectory_frame_positions != null)
  // Per-frame bond cache lives below — needs supercell_structure ($derived
  // declared further down) in its driver effect. Declared placeholder so
  // template references still resolve before the real binding initializes.
  let trajectory_bond_connectivity_for_frame: Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }> | null = $state(null)

  // T5 pause writeback (search "T5 pause writeback" in src/lib/trajectory/Trajectory.svelte):
  // a $effect lived here that watched trajectory_active (= trajectory_frame_positions
  // != null) crossing true→false and wrote frame positions back into current_structure.
  // It NEVER fired correctly: that edge fires only on trajectory unload, and
  // Trajectory.svelte's frame $effect (search "current_structure = undefined" there)
  // nulls current_structure in the SAME atomic update — so the inner
  // `if (current_structure?.sites)` block short-circuited every time.
  // Refined 2026-04-27 (commit 931e79c7). DO NOT restore this $effect — it cannot
  // work for the structural reason above.

  // Plan v3 Phase 2: position-write loop. Writes trajectory positions
  // directly into scene_atom_manager per frame, parallel to the existing
  // X2 shadow sync's trajectory_only fast-path. Both writers produce the
  // same positions; set_position is no-op-safe on Math.fround-equal values
  // (atom-manager.svelte.ts), so whichever fires first does the GPU upload
  // and the second is no-op.
  //
  // Drag-precedence (W4 §6 + plan v3 spec): if a slot's site_id is in the
  // realtime_position_overrides map, skip — the user's drag wins over the
  // trajectory frame. The X2 shadow sync's positions_only branch already
  // honors realtime_position_overrides via the same precedence rule.
  //
  // Supercell scope (W6 OQ1): the loop bounds at min(mgr.count, traj/3)
  // — supercell-extra atoms (slots beyond traj coverage) retain whatever
  // positions the structure pipeline put there. A dev warning fires once
  // per trajectory_active edge to surface the limitation.
  //
  // Phase 2 is ADDITIVE — current_structure writes still active.
  // W1 must remain LOUD (Test 5.3 baseline: atom_data_fires > 10). Silence
  // here means an accidental Phase 4 leak into Phase 2.
  let __traj_write_warned_supercell = false
  $effect(() => {
    // This effect writes the current frame's xyz into the WebGL atom_manager
    // (a plain typed-array scatter — no GPU paint by itself; Threlte 8 is
    // render-on-demand and autoRender is off while the overlay is active). It
    // runs in BOTH modes on purpose:
    //   - WebGL active: drives the WebGL atoms/bonds per frame as before.
    //   - WebGPU overlay active (`webgl_suspended`): the EXPENSIVE WebGL
    //     pipelines (X2 full diff, bond-pair rebuild, bond worker) stay gated
    //     in StructureScene, but we still keep the manager's positions current
    //     so StructureScene's `atom_positions_buffer` resolves the live frame.
    //     That buffer is the SINGLE SOURCE OF TRUTH the overlay now consumes
    //     (via get_displayed_frame_positions) so its atoms/bonds match the
    //     WebGL view atom-for-atom — including the supercell base-block /
    //     replica-static behaviour, which is decided HERE (max_slot bound) and
    //     reused rather than re-guessed in the overlay.
    // We do NOT early-return on webgl_suspended: the cheap manager write is
    // what makes the overlay's positions identical to the WebGL resolver.
    const traj = trajectory_frame_positions
    if (!traj) {
      __traj_write_warned_supercell = false
      return
    }
    const mgr = scene_atom_manager
    if (!mgr || mgr.count === 0) return
    const overrides = interaction.realtime_position_overrides
    const max_slot = Math.min(mgr.count, Math.floor(traj.length / 3))
    if (
      import.meta.env?.DEV
      && !__traj_write_warned_supercell
      && mgr.count > max_slot
    ) {
      __traj_write_warned_supercell = true
      console.warn(
        `[trajectory] Supercell + trajectory: ${mgr.count} atom slots but ` +
        `position cache covers only ${max_slot} base atoms. ` +
        `Supercell-extra atoms frozen at topology-load positions.`,
      )
    }
    for (let slot = 0; slot < max_slot; slot++) {
      const sid = mgr.site_ids_buffer[slot]
      if (overrides?.has(sid)) continue // drag wins
      const base = sid * 3
      mgr.set_position(slot, traj[base], traj[base + 1], traj[base + 2])
    }
  })

  // Auto-align structure to principal axes on load
  // Skip alignment when cube_file is present - atom positions must match the volumetric grid
  $effect(() => {
    if (align_on_load !== 'principal_axes' || !structure || !structure.sites || structure.sites.length === 0 || cube_file || pencil.pencil_mode_active || build.build_pane_open || trajectory_active) {
      return
    }

    // Create a unique ID for this structure based on site count and first/last positions
    const first_xyz = structure.sites[0]?.xyz?.join(',') ?? ''
    const last_xyz = structure.sites[structure.sites.length - 1]?.xyz?.join(',') ?? ''
    const structure_id = `${structure.sites.length}-${first_xyz}-${last_xyz}`

    // Skip if already aligned this exact structure
    if (structure_aligned_id === structure_id) {
      return
    }

    // Skip if structure has _aligned marker (already processed)
    if ((structure as any)._aligned) {
      structure_aligned_id = structure_id
      return
    }

    // Perform alignment
    if (import.meta.env?.DEV) {
      const g = globalThis as { __catgo_align_on_load_fires?: number }
      g.__catgo_align_on_load_fires = (g.__catgo_align_on_load_fires ?? 0) + 1
    }
    untrack(() => {
      const aligned = align_to_principal_axes(structure!)
      structure = { ...aligned, _aligned: true } as any as typeof structure
      structure_aligned_id = structure_id
    })
  })

  // Measurement state — delegated to state/measurement-state.svelte.ts (meas_state)
  let export_pane_open = $state(false)

  let optimization_pane_open = $state(false)  // Structure optimization pane

  // MD trajectory data — captured from file import for MD analysis
  let imported_traj_b64: string = $state(``)
  let imported_traj_format: string = $state(``)

  // Sync external trajectory data (from Trajectory viewer) into MD state
  $effect(() => {
    if (initial_traj_b64) {
      imported_traj_b64 = initial_traj_b64
      imported_traj_format = initial_traj_format || ``
    }
  })

  // MD plot state
  let md_plot_data: { traces: any[]; title: string; x_label: string; y_label: string; layout_overrides?: Record<string, any> } | null = $state(null)
  let md_layout = $state<`horizontal` | `vertical`>(`horizontal`)
  let show_md_panel = $derived(md_plot_data !== null)
  // User-editable plot settings (initialized from plot data, can be overridden)
  let md_x_label: string = $state(``)
  let md_y_label: string = $state(``)
  let md_show_gridlines: boolean = $state(true)
  let md_show_legend: boolean = $state(true)
  let md_settings_open: boolean = $state(false)

  // DOS analysis state
  let dos_session = $state<DOSSessionInfo | null>(null)
  let dos_state: DosViewState = $state({
    dos_result: null,
    dband_result: null,
    show_fermi_line: true,
    show_fill: false,
    show_spin_down: true,
    orientation: `vertical`,
    x_range: null,
    y_range: null,
    show_dband_line: false,
    line_styles: {},
    show_gridlines: true,
    show_axis_lines: true,
    axis_line_width: 1,
    tick_length: 5,
    tick_width: 1,
    legend_visible: true,
    hidden_series: [],
  })
  let dos_layout = $state<`horizontal` | `vertical`>(`horizontal`)
  let dos_plot_ref: DosPlot | undefined = $state()
  let show_dos_panel = $derived(dos_state.dos_result !== null)
  let dband_center_for_plot = $derived(
    dos_state.show_dband_line && dos_state.dband_result ? dos_state.dband_result.center_rel : null
  )

  // Band structure state
  let band_state: BandViewState = $state({
    band_data: null,
    projections: null,
    show_fermi_line: true,
    show_band_gap: true,
    show_spin_down: true,
    energy_range: [-8, 6] as [number, number],
    fat_band_scale: 10,
    show_gridlines: true,
    show_axis_lines: true,
    axis_line_width: 1,
    tick_length: 5,
    tick_width: 1,
    legend_visible: true,
  })
  let band_layout = $state<`horizontal` | `vertical`>(`horizontal`)
  let band_plot_ref: BandPlot | undefined = $state()
  let show_band_panel = $derived(band_state.band_data !== null)

  // COHP analysis state
  let electronic_sub_tab = $state<`dos` | `cohp` | `bands` | `charge`>(`dos`)
  let cohp_state: CohpViewState = $state({
    cohp_result: null,
    icohp_entries: null,
    show_fermi_line: true,
    show_fill: false,
    fill_opacity: 0.15,
    show_spin_down: true,
    spin_mode: `separate`,
    orientation: `horizontal`,
    x_range: null,
    y_range: null,
    invert_cohp: true,
    show_gridlines: true,
    show_axis_lines: true,
    axis_line_width: 1,
    tick_length: 5,
    tick_width: 1,
    legend_visible: true,
    hidden_series: [],
    line_styles: {},
  })
  let cohp_layout = $state<`horizontal` | `vertical`>(`horizontal`)
  let cohp_plot_ref: CohpPlot | undefined = $state()
  let show_cohp_panel = $derived(cohp_state.cohp_result !== null)
  let workflow_pane_open = $state(false)  // Workflow pane
  let slow_growth_pane_open = $state(false)  // Slow-growth post-processing
  let io_pane_open = $state(false)  // IO (import/export) pane
  let server_pane_open = $state(false)  // Server (HPC) pane
  let plugin_hub_open = $state(false)  // Plugin Hub pane
  // Open Plugin Hub when external counter prop is incremented
  $effect(() => {
    if (open_plugin_hub > 0) {
      plugin_hub_open = true
    }
  })
  let chat_pane_open = $state(false)
  let chat_panel_size = $state(28) // percentage of total width for chat panel (right mode)
  let chat_bottom_size = $state(35) // percentage of total height for chat panel (bottom mode)
  let is_chat_resizing = $state(false)
  let job_detail_open = $state(false)  // Job detail pane
  let job_detail_session_id = $state(``)
  let job_detail_job_id = $state(``)

  // --- Terminal split-view state ---
  let show_terminal = $state(false)
  let terminal_layout = $state<`horizontal` | `vertical`>(`horizontal`)
  let terminal_session_id = $state<string | undefined>()
  let terminal_host = $state(``)
  let terminal_username = $state(``)
  let terminal_sync_cwd = $state(false)
  let terminal_popped_out = $state(false)
  let terminal_popped_sync_cwd = $state(false)
  let server_nav_path = $state<string | undefined>()
  let side_panel_size = $state(50) // percentage of total space for side panel
  let side_panel_minimized = $state(false)
  let is_side_resizing = $state(false)

  // Auto-open panel when initial_panel prop is set (e.g. from welcome page cards)
  // untrack: intentional one-time read of initial_panel at mount time
  untrack(() => {
    if (initial_panel) {
      if (initial_panel === `hpc`) {
        server_pane_open = true
      } else if (initial_panel === `chat`) {
        chat_pane_open = true
      } else if (initial_panel === `terminal`) {
        show_terminal = true
        side_panel_minimized = false
      } else if (initial_panel === `doping`) {
        build.build_pane_open = true
        build.active_build_tab = `doping`
      } else if (initial_panel === `slab`) {
        build.build_pane_open = true
        build.active_build_tab = `slab_cutter`
      } else if (initial_panel === `adsorbate`) {
        build.build_pane_open = true
        build.active_build_tab = `adsorbate`
      }
    }
  })

  // Listen for CWD changes from popped-out terminal via BroadcastChannel.
  // Uses sequence counter + debounce to avoid stale/out-of-order updates.
  let _last_cwd_seq = 0
  let _cwd_debounce_timer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    if (!terminal_popped_out || !terminal_popped_sync_cwd) return
    const bc = new BroadcastChannel(`catgo-terminal-cwd`)
    bc.onmessage = (event: MessageEvent) => {
      const { path, seq } = event.data
      if (!path) return
      if (typeof seq === `number` && seq <= _last_cwd_seq) return
      if (typeof seq === `number`) _last_cwd_seq = seq
      if (_cwd_debounce_timer) clearTimeout(_cwd_debounce_timer)
      _cwd_debounce_timer = setTimeout(() => {
        server_nav_path = path
        _cwd_debounce_timer = null
      }, 150)
    }
    return () => {
      bc.close()
      if (_cwd_debounce_timer) clearTimeout(_cwd_debounce_timer)
    }
  })

  function start_side_resize(event: PointerEvent) {
    event.preventDefault()
    is_side_resizing = true
    const is_vertical = show_terminal && !show_editor && !show_preview && terminal_layout === `vertical`
    const rect = wrapper?.getBoundingClientRect()
    if (!rect) return

    document.body.style.cursor = is_vertical ? `row-resize` : `col-resize`
    document.body.style.userSelect = `none`

    function on_move(e: PointerEvent) {
      if (!rect) return
      let pct: number
      if (is_vertical) {
        const offset = e.clientY - rect.top
        pct = 100 - (offset / rect.height) * 100
      } else {
        const offset = e.clientX - rect.left
        pct = 100 - (offset / rect.width) * 100
      }
      side_panel_size = Math.max(15, Math.min(80, pct))
    }

    function on_up() {
      is_side_resizing = false
      document.body.style.cursor = ``
      document.body.style.userSelect = ``
      window.removeEventListener(`pointermove`, on_move)
      window.removeEventListener(`pointerup`, on_up)
    }

    window.addEventListener(`pointermove`, on_move)
    window.addEventListener(`pointerup`, on_up)
  }

  function start_chat_resize(event: PointerEvent) {
    event.preventDefault()
    is_chat_resizing = true
    const rect = wrapper?.getBoundingClientRect()
    if (!rect) return

    document.body.style.cursor = `col-resize`
    document.body.style.userSelect = `none`

    function on_move(e: PointerEvent) {
      if (!rect) return
      const pct = 100 - ((e.clientX - rect.left) / rect.width) * 100
      chat_panel_size = Math.max(15, Math.min(50, pct))
    }

    function on_up() {
      is_chat_resizing = false
      document.body.style.cursor = ``
      document.body.style.userSelect = ``
      window.removeEventListener(`pointermove`, on_move)
      window.removeEventListener(`pointerup`, on_up)
    }

    window.addEventListener(`pointermove`, on_move)
    window.addEventListener(`pointerup`, on_up)
  }

  function start_chat_bottom_resize(event: PointerEvent) {
    event.preventDefault()
    is_chat_resizing = true
    const rect = wrapper?.getBoundingClientRect()
    if (!rect) return

    document.body.style.cursor = `row-resize`
    document.body.style.userSelect = `none`

    function on_move(e: PointerEvent) {
      if (!rect) return
      const pct = 100 - ((e.clientY - rect.top) / rect.height) * 100
      chat_bottom_size = Math.max(15, Math.min(50, pct))
    }

    function on_up() {
      is_chat_resizing = false
      document.body.style.cursor = ``
      document.body.style.userSelect = ``
      window.removeEventListener(`pointermove`, on_move)
      window.removeEventListener(`pointerup`, on_up)
    }

    window.addEventListener(`pointermove`, on_move)
    window.addEventListener(`pointerup`, on_up)
  }

  async function popout_chat() {
    chat_pane_open = false
    // Pass tab_id in the URL so the popout knows which source tab's
    // broadcasts to trust. Without it, the popout can't filter by
    // source_tab_id and its context gets overwritten whenever any
    // other tab in the main window updates its structure/workflow.
    const popout_tab_id = encodeURIComponent(tab_id ?? `default`)
    const url = `${window.location.origin}${window.location.pathname}#chat?tab_id=${popout_tab_id}`
    if (typeof window !== `undefined`) {
      try {
        const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
        const chat_window = new WebviewWindow(`catgo-chat`, {
          title: `CatGo - AI Chat`,
          url, width: 500, height: 700, center: true, resizable: true, decorations: true,
        })
        chat_window.once(`tauri://error`, () => {
          window.open(url, `catgo-chat`, `width=500,height=700,resizable=yes`)
        })
        return
      } catch { /* not Tauri */ }
    }
    window.open(url, `catgo-chat`, `width=500,height=700,resizable=yes`)
  }

  // --- Monaco editor split-view state ---
  let show_editor = $state(false)
  let editor_content = $state(``)
  let editor_filename = $state(``)
  let editor_file_path = $state(``)
  let editor_session_id = $state(``)

  // --- File preview split-view state ---
  let show_preview = $state(false)
  let preview_mode = $state<'image' | 'pdf' | 'markdown' | 'csv' | 'excel' | 'text'>(`text`)
  let preview_content = $state(``)
  let preview_binary_data = $state(``)
  let preview_mime_type = $state(``)
  let preview_filename = $state(``)
  let preview_file_path = $state(``)
  let preview_session_id = $state(``)

  // --- Remote structure origin (for push-back) --- (now a $bindable prop, see props block)

  // --- XRD 状态控制器 (controllers/xrd-state.svelte.ts) ---
  // XRD 计算、固定图谱、柱状图数据等全部由独立模块管理
  const xrd = create_xrd_controller({
    get_structure: () => structure,
    get_analysis_open: () => analysis.analysis_pane_open,
    get_active_tab: () => analysis.active_analysis_tab,
  })

  let cube_pane_open = $state(!!untrack(() => cube_file))  // Cube file isosurface panel

  let is_molecule = $derived(!!structure && !('lattice' in structure && (structure as any).lattice))

  // Context menu sections — delegated to pure functions in controllers/viewer-controller.ts
  let ctx_constraints_section = $derived(build_constraints_section({
    has_vacuum: build.has_vacuum,
    context_menu_target_site,
    selected_sites,
    displayed_structure,
    structure,
  }))

  let ctx_charge_label_section = $derived(build_charge_label_section({
    context_menu_target_site,
    displayed_structure,
    structure,
    visible_charge_labels: charge_state.visible_charge_labels,
  }))

  // Cube file isosurface state
  let cube_positive_mesh = $state<import('$lib/cube').CubeMesh | null>(null)
  let cube_negative_mesh = $state<import('$lib/cube').CubeMesh | null>(null)
  let cube_atoms_data = $state<import('$lib/cube').CubeAtom[]>([])
  let cube_state_data = $state<import('$lib/cube').CubeState>({
    filepath: ``,
    header: null,
    isovalue: 0.05,
    dual: true,
    decimate: 0,
    show_positive: true,
    show_negative: true,
    positive_color: `#3b82f6`,
    negative_color: `#ef4444`,
    opacity: 0.6,
    wireframe: false,
    slice_plane: {
      mode: `z` as `x` | `y` | `z` | `custom`,
      position: 0.5,
      offset: 0,
      selected_atoms: [],
      normal: [0, 0, 1] as [number, number, number],
      center: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      show_plane: false,
      plane_color: `#ffcc00`,
      colormap: `RdBu`,
    },
    loading: false,
    error: null,
  })

  // ── WebGPU overlay selection bridge ────────────────────────────────────────
  // The overlay renders displayed_structure.sites in order, so its picked index
  // and its highlight buffer are DISPLAYED-site indices. The app's selection
  // model (selected_sites) is BASE-site indices (matching the WebGL path). Map
  // between the two: the overlay highlights every displayed site whose base index
  // (orig_site_idx) is currently selected, and an overlay pick is mapped back to
  // its base index before toggling selected_sites (exactly like the WebGL
  // handle_atom_click → toggle_selection(atom.site_idx) path).
  let overlay_selected_displayed = $derived.by(() => {
    const sites = displayed_structure?.sites
    if (!sites || selected_sites.length === 0) return [] as number[]
    const sel = new Set(selected_sites)
    const out: number[] = []
    for (let i = 0; i < sites.length; i++) {
      if (sel.has(get_orig_site_idx(sites[i], i))) out.push(i)
    }
    return out
  })

  /** Handle an atom pick from the WebGPU overlay. `displayed_idx` is the picked
   *  displayed-site index, or -1 for empty space. Maps to the base index and
   *  toggles selected_sites the same way the WebGL click path does; a background
   *  click (-1) clears the selection (mirroring clicking empty space). */
  function handle_overlay_pick(displayed_idx: number): void {
    if (displayed_idx < 0) {
      // Empty-space pick ⇒ would clear the selection. But the overlay watches
      // window pointerup and classifies click-vs-drag purely by movement
      // distance (it can't see the Cmd/Ctrl box-select modifier). A small/dense
      // box-select drag is therefore misclassified as a background click and its
      // async pick (GPU readback) resolves AFTER the WebGL box-select already set
      // selected_sites — clearing here would wipe the box result one frame later
      // (the flash). Suppress this clear if a box-select committed in the last
      // ~400ms (covers the pick readback latency without swallowing a genuine
      // later empty-space click). Box-select set persists.
      const now = (typeof performance !== `undefined` ? performance.now() : Date.now())
      if (now - interaction.last_box_select_commit_ms < 400) return
      if (selected_sites.length > 0) selected_sites = []
      return
    }
    const sites = displayed_structure?.sites
    const site = sites?.[displayed_idx]
    if (!site) return
    const base_idx = get_orig_site_idx(site, displayed_idx)
    const result = toggle_site_selection(base_idx, selected_sites)
    if (result) selected_sites = result
  }

  // Slice split-view state
  let slice_result = $state<SliceResult | null>(null)
  let slice_atoms_info = $state.raw<AtomSliceInfo[] | null>(null)
  let show_slice_panel = $derived(slice_result !== null)
  let slice_layout = $state<`horizontal` | `vertical`>(`horizontal`)

  // Compute cube grid extent for slice plane sizing
  let cube_slice_plane_size = $derived.by(() => {
    const h = cube_state_data.header
    if (!h) return 20
    const v = h.voxel_axes
    const d = h.dims
    // Compute full extent along each grid axis
    const ext0 = Math.hypot(d[0] * v[0][0], d[0] * v[0][1], d[0] * v[0][2])
    const ext1 = Math.hypot(d[1] * v[1][0], d[1] * v[1][1], d[1] * v[1][2])
    const ext2 = Math.hypot(d[2] * v[2][0], d[2] * v[2][1], d[2] * v[2][2])
    return Math.max(ext0, ext1, ext2) * 1.2
  })
  // Compute effective slice center (base center + offset along rotated normal for custom mode)
  let cube_slice_effective_center = $derived.by(() => {
    const sp = cube_state_data.slice_plane
    const c = sp.center
    if (sp.mode !== `custom` || sp.offset === 0) return c
    // Use Rodrigues' rotation around local U, V, N axes
    const rn = cube_slice_effective_normal
    const s = sp.offset
    return [c[0] + rn[0] * s, c[1] + rn[1] * s, c[2] + rn[2] * s] as [number, number, number]
  })
  // Compute effective slice normal (Rodrigues' rotation around local U/V/N for custom mode)
  let cube_slice_effective_normal = $derived.by(() => {
    const sp = cube_state_data.slice_plane
    if (sp.mode !== `custom`) return sp.normal
    const base_normal = vec3_normalize(sp.normal)
    const [u_axis, v_axis] = in_plane_basis(base_normal)
    const [ru, rv, rn] = sp.rotation.map((d: number) => (d * Math.PI) / 180)
    let n: [number, number, number] = base_normal
    if (Math.abs(ru) > 1e-10) n = rodrigues_rotate(n, u_axis, ru)
    if (Math.abs(rv) > 1e-10) n = rodrigues_rotate(n, v_axis, rv)
    if (Math.abs(rn) > 1e-10) n = rodrigues_rotate(n, base_normal, rn)
    return vec3_normalize(n)
  })
  // Measurements — delegated to state/measurement-state.svelte.ts (meas_state)

  // One-time conversion of legacy measured_sites prop to measurements format
  // untrack: intentional one-time read at mount
  untrack(() => {
    if (measured_sites.length > 0) {
      meas_state.measurements = [...meas_state.measurements, {
        id: `legacy-${Date.now()}`,
        type: meas_state.measure_mode,
        sites: [...measured_sites]
      }]
    }
  })

  // Independent improvement I1: prewarm bond worker WASM at mount so the first
  // user-triggered structure edit pays ~5ms instead of ~150ms WASM init.
  // Idempotent — guarded inside prewarm_bond_worker() via worker_ready /
  // worker_failed / worker_init_promise checks.
  untrack(() => { prewarm_bond_worker() })

  // Helper to delete a measurement and keep measured_sites in sync
  function delete_measurement(id: string) {
    meas_state.delete_measurement(id, (sites) => { measured_sites = sites })
  }

  let visible_buttons = $derived(
    show_controls === true ||
      (typeof show_controls === `number` && width > show_controls),
  )

  // ── Transform pipeline (cell type -> supercell -> PBC images -> displayed_structure) ──
  // Managed by transform controller (controllers/transform-controller.svelte.ts)
  // Reactive aliases for template/child-component access:
  let supercell_structure = $derived(transform.supercell_structure)
  let supercell_loading = $derived(transform.supercell_loading)

  // Per-frame bond cache for trajectory playback. Effects (clear / drive /
  // push) live in trajectory-bond-cache.svelte.ts to keep this file lean.
  const trajectory_bond_cache = create_trajectory_bond_cache()
  wire_trajectory_bond_cache(trajectory_bond_cache, {
    get_structure: () => structure,
    get_base: () => supercell_structure ?? structure,
    get_step_idx: () => trajectory_step_idx,
    get_positions_version: () => trajectory_positions_version.v,
    get_positions_invalidate_all: () => trajectory_positions_version.all,
    get_trajectory_active: () => trajectory_active,
    get_positions: () => get_trajectory_frame_positions,
    get_strategy: () => (scene_props?.bonding_strategy ?? `electroneg_ratio`) as BondingStrategy,
    get_options: () => (scene_props?.bonding_options ?? {}) as Record<string, number>,
    set_connectivity: (v) => { trajectory_bond_connectivity_for_frame = v },
    get_connectivity: () => trajectory_bond_connectivity_for_frame,
    // WebGPU overlay active ⇒ suspend the per-frame async bond recompute. The
    // overlay computes its own GPU bonds and does not read
    // trajectory_bond_connectivity_for_frame. Read reactively inside the driver
    // effect so toggle-OFF re-primes the current frame's connectivity.
    get_suspended: () => webgl_suspended,
  })

  // Track selection to restore after atom movement
  let saved_selection: number[] | null = null
  let last_normalized_selection = $state<number[]>([])

  // NOTE: Removed auto-remap $effect that was causing selection to jump from
  // image atoms to original atoms. Now image atoms stay selected visually,
  // but manipulation is only allowed on original atoms (like ASE GUI behavior).

  // Image atom helpers — delegate to pure functions in controllers/transform-controller.ts
  function is_image_atom(idx: number): boolean {
    return _is_image_atom(displayed_structure, idx)
  }

  function has_original_atoms(indices: number[]): boolean {
    return _has_original_atoms(displayed_structure, indices)
  }

  function get_original_atoms_only(indices: number[]): number[] {
    return _get_original_atoms_only(displayed_structure, structure, indices)
  }

  // Track previous site count to detect when a completely different structure is loaded
  let previous_site_count = $state<number | null>(null)

  // Clear selections when supercell/image_atoms/cell_type settings change (not when structure is modified)
  let first_run = true
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    ;[supercell_scaling, show_image_atoms, cell_type]
    if (first_run) {
      first_run = false
      return
    }
    untrack(() => {
      // Restore selection if we just moved atoms
      if (saved_selection !== null) {
        selected_sites = saved_selection
        saved_selection = null
        return
      }
      // Only clear when supercell/image_atoms settings change
      if (selected_sites.length > 0) {
        selected_sites = []
      }
      sel_state.selection_history = []
      // Don't clear measured_sites - measurements should persist
    })
  })

  // Separate effect: filter invalid indices when structure changes (e.g., atoms deleted)
  // This preserves valid selections while removing references to deleted atoms
  $effect(() => {
    const count = structure?.sites?.length ?? 0
    if (previous_site_count !== null && count !== previous_site_count) {
      // Site count changed - filter out invalid indices
      untrack(() => {
        selected_sites = selected_sites.filter(idx => idx < count)
        sel_state.selection_history = []
        meas_state.measurements = prune_measurements(meas_state.measurements, count - 1)

        // Clear index-keyed maps when atom count changes
        // Since atoms are identified by index, any add/delete/reorder operation
        // invalidates maps keyed by old indices. Without clearing, stale position
        // overrides can cause atoms to snap to wrong locations.
        interaction.clear_realtime_overrides()
        site_radius_overrides.clear()
        site_color_overrides.clear()
      })
    }
    previous_site_count = count
  })

  // PBC image atoms and displayed_structure are managed by the transform controller.
  // (See controllers/transform-controller.svelte.ts)

  // Sync sel_state.selection_opacity slider to per-atom/per-bond overrides
  // Uses untrack to read override maps without creating dependency (avoids infinite loop)
  // Debounces history: only pushes undo state on first change, not on every slider tick
  let opacity_history_debounce: ReturnType<typeof setTimeout> | null = null
  let opacity_history_saved = false
  $effect(() => {
    const opacity = sel_state.selection_opacity
    const sites = selected_sites
    const bonds = pencil.selected_bonds
    untrack(() => {
      let atoms_changed = false
      let bonds_changed = false
      if (sites.length > 0) {
        const old_map = sel_state.atom_opacity_overrides
        for (const idx of sites) {
          const current = old_map.get(idx)
          if (opacity < 1 && current !== opacity) { atoms_changed = true; break }
          if (opacity >= 1 && current !== undefined) { atoms_changed = true; break }
        }
      }
      if (bonds.length > 0) {
        const old_map = sel_state.bond_opacity_overrides
        for (const bond of bonds) {
          const current = old_map.get(bond.key)
          if (opacity < 1 && current !== opacity) { bonds_changed = true; break }
          if (opacity >= 1 && current !== undefined) { bonds_changed = true; break }
        }
      }
      if (atoms_changed || bonds_changed) {
        // Save pre-change state only on first change in a slider drag session
        if (!opacity_history_saved) {
          opacity_history_saved = true
          sel_state.opacity_history = [...sel_state.opacity_history, {
            atoms: new Map(sel_state.atom_opacity_overrides),
            bonds: new Map(sel_state.bond_opacity_overrides),
          }]
        }
        // Reset debounce timer - after 500ms of no changes, allow a new history push
        if (opacity_history_debounce) clearTimeout(opacity_history_debounce)
        opacity_history_debounce = setTimeout(() => { opacity_history_saved = false }, 500)

        if (atoms_changed) {
          const new_map = new Map(sel_state.atom_opacity_overrides)
          for (const idx of sites) {
            if (opacity < 1) new_map.set(idx, opacity)
            else new_map.delete(idx)
          }
          sel_state.atom_opacity_overrides = new_map
        }
        if (bonds_changed) {
          const new_map = new Map(sel_state.bond_opacity_overrides)
          for (const bond of bonds) {
            if (opacity < 1) new_map.set(bond.key, opacity)
            else new_map.delete(bond.key)
          }
          sel_state.bond_opacity_overrides = new_map
        }
      }
    })
  })

  // Clear selection when clicking outside the viewer
  $effect(() => {
    if (typeof window === 'undefined') return

    function handle_outside_click(event: MouseEvent) {
      // Check if click is on UI elements that shouldn't clear selection
      const target = event.target as Element
      if (
        target.closest('.context-menu') ||
        target.closest('.element-selector') ||
        target.closest('.common-molecules-menu') ||
        target.closest('.control-buttons') ||
        target.closest('.measure-mode-dropdown')
      ) {
        return
      }

      // Check if click is outside the wrapper element
      if (wrapper && !wrapper.contains(event.target as Node)) {
        // Clear selection to allow arrow keys to scroll the page again
        // Don't clear measured_sites - measurements should persist independently
        if (selected_sites.length > 0) {
          selected_sites = []
        }
        if (pencil.selected_bonds.length > 0) {
          pencil.selected_bonds = []
        }
        if (sel_state.selection_opacity !== 1.0) {
          sel_state.selection_opacity = 1.0
        }
      }
    }

    window.addEventListener('click', handle_outside_click)
    return () => {
      window.removeEventListener('click', handle_outside_click)
    }
  })

  // 全局事件监听器 (keydown/keyup/mousemove/mouseup/pointermove/blur/visibility)
  // 由 interaction controller 的 setup_global_listeners 统一管理
  $effect(() => interaction.setup_global_listeners())

  // ── Camera state — delegated to viewer controller (controllers/viewer-controller.svelte.ts) ──
  // Camera movement tracking effects are in the viewer controller.
  // These are direct access aliases for template bind: directives.
  let camera_has_moved = $state(false)
  let camera_is_moving = $state(false)
  let scene = $state<any>(undefined)
  let camera = $state<any>(undefined)
  // Task 9: experimental WebGPU large-system render path. Default OFF — when
  // off the overlay renders nothing and the WebGL viewer is unchanged.
  let large_system_mode = $state(false)
  // While the WebGPU overlay is active, the WebGL/Threlte path must do ZERO
  // per-frame work (not just zero painting): the overlay computes its own GPU
  // bonds/atoms, so any per-frame CPU recompute on the WebGL side is wasted and
  // defeats the perf win. `webgl_suspended` is read REACTIVELY inside the gated
  // effects so that flipping the overlay OFF (true→false) re-fires them and the
  // WebGL view fully resumes for the current frame. Default OFF ⇒ always false
  // ⇒ zero change to existing WebGL behavior.
  let webgl_suspended = $derived(large_system_mode)
  // ── GPU supercell instancing (Phase 1) ──────────────────────────────────────
  // Parsed [nx,ny,nz] from supercell_scaling. parse_supercell_scaling throws on
  // malformed input, so guard — a bad string falls back to [1,1,1] (no supercell).
  let gpu_supercell_factors = $derived.by((): Vec3 => {
    try {
      return parse_supercell_scaling(supercell_scaling)
    } catch {
      return [1, 1, 1]
    }
  })
  // GPU-supercell is ACTIVE only when the overlay is on AND a real (>1) supercell
  // is requested AND the structure carries a lattice (offsets need a,b,c). When
  // active, the CPU keeps the base cell (transform-controller gate) and the GPU
  // instances base_count × nx·ny·nz spheres. Off / overlay-off / 1×1×1 ⇒ false ⇒
  // identical CPU + shader behaviour to today.
  let gpu_supercell_active = $derived(
    large_system_mode &&
      gpu_supercell_factors[0] * gpu_supercell_factors[1] * gpu_supercell_factors[2] > 1 &&
      !!(structure as { lattice?: unknown } | undefined)?.lattice,
  )
  // One-shot repaint trigger for StructureScene. Bumped when large_system_mode
  // turns OFF so the WebGL view (whose autoRender was paused while the overlay
  // covered it) repaints once on the next frame and isn't left on a stale paint.
  let webgl_repaint_trigger = $state(0)
  let _last_large_system_mode = false
  $effect(() => {
    // Only act on the OFF transition (true → false). default-off ⇒ no-op at
    // mount; ON ⇒ no-op (autoRender pauses, overlay paints). On OFF, autoRender
    // flips back to true (the <Canvas> prop) and this bumps a repaint so the
    // resumed WebGL render loop paints the current scene immediately.
    const on = large_system_mode
    if (_last_large_system_mode && !on) webgl_repaint_trigger++
    _last_large_system_mode = on
  })
  let pixels_per_angstrom = $state(0)
  let orbit_controls = $state<any>(undefined)
  let rotation_target_ref = $state<[number, number, number] | undefined>(undefined)
  let initial_computed_zoom = $state<number | undefined>(undefined)
  let cached_rotation_target = $state<[number, number, number] | null>(null)

  // Custom toggle handlers for mutual exclusion
  function toggle_info() {
    if (info_pane_open) info_pane_open = false
    else [info_pane_open, controls_open] = [true, false]
  }

  // Reset tracking when structure changes
  $effect(() => {
    if (structure) camera_has_moved = false
  })
  // Set camera_has_moved to true when camera starts moving
  $effect(() =>
    untrack(() => {
      if (camera_is_moving) {
        camera_has_moved = true
      }
    })
  )

  // ── Lattice alignment — delegated to transform controller (controllers/transform-controller.svelte.ts) ──
  // compute_lattice_rotation() and the alignment math live in the transform controller.
  let lattice_align_trigger = $state(0)
  let lattice_alignment_rotation: Vec3 = $state([0, 0, 0])
  let _auto_aligned = false

  // Auto-align to lattice on first structure load (VESTA convention: view down c*)
  $effect(() => {
    if (_auto_aligned) return
    const mat = (structure as PymatgenStructure | null)?.lattice?.matrix
    if (!mat || mat.length < 3) return
    if (!orbit_controls || !camera) return
    // Defer to next tick so orbit controls are fully initialized
    let cancelled = false
    const handle = requestAnimationFrame(() => {
      if (cancelled) return
      _auto_aligned = true
      align_view_to_lattice()
    })
    return () => { cancelled = true; cancelAnimationFrame(handle) }
  })

  function align_view_to_lattice() {
    const rotation = transform.compute_alignment(structure)
    lattice_alignment_rotation = transform.lattice_alignment_rotation
    scene_props.rotation = rotation
    camera_has_moved = false
    lattice_align_trigger = transform.lattice_align_trigger
  }

  function reset_camera() {
    scene_props.camera_position = [0, 0, 0]
    camera_has_moved = false

    if (orbit_controls && camera) {
      if (orbit_controls.target && rotation_target_ref) {
        const [x, y, z] = rotation_target_ref
        orbit_controls.target.set(x, y, z)
      }
      if (`zoom` in camera && initial_computed_zoom !== undefined) {
        camera.zoom = initial_computed_zoom
        camera.updateProjectionMatrix()
      }
      if (typeof orbit_controls.update === `function`) {
        orbit_controls.update()
      }
    }

    on_camera_reset?.({ structure, camera_has_moved, camera_position: [0, 0, 0] })
  }

  // MCP polling bridge dependencies — viewer state accessors used by the
  // catgo MCP server (server-side, called via SDK agents) to round-trip
  // structure / selection / screenshot data to the frontend viewer.
  //
  // panel_id is derived from the tab_id prop so that each tab's viewer has
  // its own MCP push/pull channel. If no tab_id is supplied (preview cards,
  // standalone embeds), fall back to "default" — matching the pre-Phase-1
  // behavior for uninstrumented callers. Stable for the instance's lifetime
  // because the outer {#each} in App.svelte is keyed by tab.id.
  const panel_id = tab_id ?? `default`

  const mcp_bridge_deps: McpBridgeDeps = {
    panel_id,
    get_structure: () => structure,
    set_structure: (s) => { structure = s as typeof structure },
    inc_center_camera: () => { center_camera_trigger++ },
    align_view_to_lattice: () => align_view_to_lattice(),
    get_selected_sites: () => selected_sites,
    get_wrapper: () => wrapper,
  }

  // MCP bridge — screenshot loop + state push (50ms throttle, 5s heartbeat) + SSE subscription.
  //
  // Wrapped in `untrack` because we want this bridge to start exactly ONCE
  // per Structure-instance mount, never re-run on reactive reads. Without
  // untrack, any reactive read in start_mcp_bridge's sync entry path (even
  // transitively through captured getters like `deps.get_structure`) would
  // register as a dependency of this $effect and re-invalidate it — each
  // re-run fires `POST /view/reset` on the backend, wiping structures that
  // were JUST pushed by MCP tools. Symptom was: Tab 1 shows water from
  // PubChem for a frame, then goes blank because /view/reset cleared it.
  // Mirror the live structure into the durable module-level store so the
  // workflow "Capture from Viewer" button and CatBot's structure_input
  // resolution still find it after this pane is closed / unmounted (e.g.
  // full-screen Workflow editor). Only real structures with a tab_id are
  // recorded — preview/popup instances (no tab_id) must not clobber it.
  $effect(() => {
    if (tab_id === undefined) return
    if (structure) set_current_structure(structure)
  })

  let mcp_request_push: (() => void) | null = null
  $effect(() => {
    // Preview / popup Structures (sample cards, StructurePopup, Trajectory
    // mini-views) mount without a tab_id. Those instances must NOT start
    // the MCP bridge — otherwise they'd push their throwaway sample data
    // to panel_id="default" every 5s, silently overwriting whatever lab
    // claude pushed there. Only mount the bridge when tab_id was given.
    if (tab_id === undefined) return
    const bridge = untrack(() => start_mcp_bridge(mcp_bridge_deps))
    mcp_request_push = bridge.request_push
    return () => {
      mcp_request_push = null
      bridge.cleanup()
    }
  })

  // Push-on-edit: any structure mutation (add/delete/replace/drag/lattice)
  // triggers an immediate push so lab claude sees the new state within
  // ~30ms instead of waiting up to 5s for the heartbeat. JSON.stringify
  // forces deep traversal of the $state proxy so all nested mutations
  // (sites[i].species, sites[i].xyz, lattice.a, ...) get tracked. The
  // throttle inside push_loop coalesces rapid edits (e.g. atom drag at
  // 60fps) into ≤20 pushes/sec.
  $effect(() => {
    if (!structure) return
    void JSON.stringify(structure)
    mcp_request_push?.()
  })

  // --- 文件拖放/导入处理 (controllers/file-handlers.ts) ---
  // 拖放、Open File 对话框、HDF5 上传、cube 文件检测等全部由独立模块管理
  const file_handlers = create_file_handlers({
    get_structure: () => structure,
    set_structure: (s) => { structure = s as typeof structure },
    get_loading: () => loading,
    set_loading: (v) => { loading = v },
    get_error_msg: () => error_msg,
    set_error_msg: (v) => { error_msg = v },
    inc_center_camera: () => { center_camera_trigger++ },
    set_cube_file: (f) => { cube_file = f },
    set_cube_pane_open: (v) => { cube_pane_open = v },
    set_dos_session: (s) => { dos_session = s },
    set_analysis_open: (v) => { analysis.analysis_pane_open = v },
    set_analysis_tab: (tab) => { analysis.active_analysis_tab = tab as any },
    set_imported_traj: (b64, fmt) => { imported_traj_b64 = b64; imported_traj_format = fmt },
    set_dragover: (v) => { dragover = v },
    get_allow_file_drop: () => allow_file_drop,
    get_on_file_drop: () => on_file_drop,
    get_on_file_load: () => on_file_load as any,
    get_on_error: () => on_error as any,
    apply_charges: (content, filename) => apply_charges_to_structure(content, filename),
  })

  function undo() {
    if (!structure) return
    const entry = sel_state.pop_entry()
    if (!entry) return
    if (entry.kind === 'structure') {
      structure = entry.structure
      pencil.pop_bond_undo()
      return
    }
    if (entry.kind === 'atom') {
      // Sparse atom-delete undo: splice the removed Site objects back
      // into `structure.sites` at their original indices. Iterating
      // `removed_indices` ascending with direct indices is correct —
      // earlier inserts shift later indices into place. See the trace in
      // the A2 task notes: [1,3,5] removed from [a,b,c,d,e,f,g] restores
      // cleanly via ascending inserts.
      const inv = entry.atom_inverse
      const next_sites = [...structure.sites]
      for (let i = 0; i < inv.removed_indices.length; i++) {
        next_sites.splice(inv.removed_indices[i], 0, inv.removed_sites[i])
      }
      structure = { ...structure, sites: next_sites }
      // Restore atom_opacity_overrides entries the delete callsite pruned.
      // (site_color_overrides / site_radius_overrides are wholesale-cleared
      // by the site-count-change $effect on both delete and restore, so
      // there's nothing to restore here — matches structure-kind undo.)
      if (inv.removed_atom_opacity_entries.length > 0) {
        const next_map = new Map(sel_state.atom_opacity_overrides)
        for (const [idx, val] of inv.removed_atom_opacity_entries) next_map.set(idx, val)
        sel_state.atom_opacity_overrides = next_map
      }
      // Restore pencil's bond edit history snapshot, same as kind: 'structure'.
      // An atom delete triggers validate_bond_edits (~line 1046), which prunes
      // any manual_bonds / deleted_bond_keys referencing removed atoms. Without
      // this pop, those bonds would be permanently lost on undo.
      pencil.pop_bond_undo()
      return
    }
    // kind === 'bond': roll back the manager FIRST (sparse GPU upload via
    // BondUndoStack), then restore the bond arrays. Reversed order would
    // let the diff shadow sync race against the restored arrays and
    // double-add bonds. See Phase 5a commit for the original reasoning.
    pencil.bond_undo.undo()
    pencil.apply_bond_array_inverse(entry.array_inverse)
  }

  // Push current state to undo stack (used by slab cutter and other tools)
  function push_to_undo() {
    if (structure) {
      sel_state.push_structure_entry(structure)
      pencil.push_bond_undo()
    }
  }

  function push_selection_to_undo() {
    sel_state.selection_history = [...sel_state.selection_history, [...selected_sites]]
  }

  // Vacuum box modal helpers
  function open_vacuum_box_for_tool(tool: typeof pending_tool_after_wrap) {
    pending_tool_after_wrap = tool
    vacuum_box_modal_visible = true
  }

  async function handle_vacuum_box_wrap(wrapped: PymatgenStructure) {
    push_to_undo()
    structure = wrapped
    // Full camera reset: reposition + re-center on the new structure
    scene_props.camera_position = [0, 0, 0] // triggers auto-positioning at correct distance
    camera_has_moved = false
    vacuum_box_modal_visible = false
    await tick() // let displayed_structure derivation settle
    center_camera_trigger++ // re-center orbit target on structure
  }

  // Auto-open the tool that triggered vacuum box wrapping
  $effect(() => {
    if (pending_tool_after_wrap && structure && 'lattice' in structure) {
      const tool = pending_tool_after_wrap
      pending_tool_after_wrap = null
      if (tool === 'slab_cutter') build.open_build_tab('slab_cutter')
      else if (tool === 'lattice_pane') build.open_build_tab('lattice')
      else if (tool === 'adsorption_pane') build.open_build_tab('adsorption')
      // vasp_export: pane already open, guard passes automatically
    }
  })

  // ── 交互控制器 wiring ──
  const interaction = create_interaction_controller({
    get_structure: () => structure,
    set_structure: (s) => { structure = s as typeof structure },
    get_displayed_structure: () => displayed_structure,
    get_selected_sites: () => selected_sites,
    set_selected_sites: (s) => { selected_sites = s },
    get_camera: () => camera,
    get_wrapper: () => wrapper,
    get_orbit_controls: () => orbit_controls,
    get_scene_props: () => settings.scene_props,
    set_scene_props_rotation: (r) => { settings.scene_props.rotation = r },
    get_rotation_target_ref: () => rotation_target_ref,
    push_to_undo,
    push_atom_entry: (inv) => { sel_state.push_atom_entry(inv); pencil.push_bond_undo() },
    undo,
    push_selection_to_undo,
    get_structure_history_length: () => (sel_state.can_undo ? 1 : 0),
    get_opacity_history: () => sel_state.opacity_history,
    set_opacity_history: (h) => { sel_state.opacity_history = h },
    get_selection_history: () => sel_state.selection_history,
    set_selection_history: (h) => { sel_state.selection_history = h },
    get_atom_opacity_overrides: () => sel_state.atom_opacity_overrides,
    set_atom_opacity_overrides: (m) => { sel_state.atom_opacity_overrides = m },
    get_bond_opacity_overrides: () => sel_state.bond_opacity_overrides,
    set_bond_opacity_overrides: (m) => { sel_state.bond_opacity_overrides = m },
    get_selected_bonds: () => pencil.selected_bonds,
    set_selected_bonds: (b) => { pencil.selected_bonds = b },
    get_scene_bond_pairs: () => pencil.scene_bond_pairs,
    get_selection_opacity: () => sel_state.selection_opacity,
    set_selection_opacity: (v) => { sel_state.selection_opacity = v },
    get_chat_pane_open: () => chat_pane_open,
    set_chat_pane_open: (v) => { chat_pane_open = v },
    get_gesture_active: () => gesture_active,
    set_gesture_active: (v) => { gesture_active = v },
    get_gesture_config: () => gesture_config,
    set_gesture_config: (c) => { gesture_config = c },
    get_info_pane_open: () => info_pane_open,
    set_info_pane_open: (v) => { info_pane_open = v },
    get_controls_open: () => controls_open,
    set_controls_open: (v) => { controls_open = v },
    get_hovered: () => hovered,
    get_fullscreen_toggle: () => fullscreen_toggle,
    get_enable_info_pane: () => enable_info_pane,
    toggle_fullscreen_fn: () => toggle_fullscreen(wrapper),
    get_lattice_alignment_rotation: () => lattice_alignment_rotation,
    get_pencil_mode_active: () => pencil.pencil_mode_active,
    set_pencil_mode_active: (v) => { pencil.pencil_mode_active = v },
    get_pencil_drag_active: () => pencil.pencil_drag_active,
    set_pencil_drag_active: (v) => { pencil.pencil_drag_active = v },
    get_pencil_anchor_idx: () => pencil.pencil_anchor_idx,
    set_pencil_anchor_idx: (v) => { pencil.pencil_anchor_idx = v },
    get_pencil_ghost_atom: () => pencil.pencil_ghost_atom,
    set_pencil_ghost_atom: (v) => { pencil.pencil_ghost_atom = v },
    get_pencil_add_mode: () => pencil.pencil_add_mode,
    set_pencil_add_mode: (v) => { pencil.pencil_add_mode = v as any },
    complete_pencil_drag: () => pencil.complete_pencil_drag(),
    get_bond_first_atom: () => pencil.bond_first_atom,
    set_bond_first_atom: (v) => { pencil.bond_first_atom = v },
    get_bond_drag_active: () => pencil.bond_drag_active,
    reset_bond_drag: (clear) => pencil.reset_bond_drag(clear),
    delete_selected_bonds: () => pencil.delete_selected_bonds(),
    get_adsorbate_placement_mode_active: () => build.adsorbate_placement_mode_active,
    set_adsorbate_placement_mode_active: (v) => { build.adsorbate_placement_mode_active = v },
    get_selected_measurement_id: () => meas_state.selected_measurement_id,
    delete_measurement,
    get_measured_sites: () => measured_sites,
    set_measured_sites: (s) => { measured_sites = s },
    set_context_menu_position: (pos) => { context_menu_position = pos },
    set_context_menu_3d_position: (pos) => { context_menu_3d_position = pos },
    set_context_menu_target_site: (idx) => { context_menu_target_site = idx },
    set_context_menu_visible: (v) => { context_menu_visible = v },
    get_on_atoms_manipulated: () => on_atoms_manipulated,
    get_on_atoms_deleted: () => on_atoms_deleted,
    get_original_atoms_only,
    set_cached_rotation_target: (v) => { cached_rotation_target = v },
    set_saved_selection: (v) => { saved_selection = v },
    // Phase X6: expose the fast-path hook bound from <StructureScene>.
    get_atom_fast_ops: () => scene_atom_fast_ops,
  })

  // --- 铅笔/键编辑控制器 wiring (controllers/pencil-mode.svelte.ts) ---
  // 铅笔画原子/片段 + click-click/drag-to-connect 键创建 + ghost 预览 + undo 集成
  const pencil = create_pencil_mode_controller({
    get_structure: () => structure,
    set_structure: (s) => { structure = s as typeof structure },
    get_displayed_structure: () => displayed_structure,
    push_to_undo,
    push_bond_entry: (inv) => sel_state.push_bond_entry(inv),
    get_camera: () => camera,
    get_wrapper: () => wrapper,
    get_orbit_controls: () => orbit_controls,
    get_scene_props: () => scene_props,
    get_rotation_target_ref: () => rotation_target_ref ?? [0, 0, 0] as Vec3,
    local_to_world: (pos) => interaction.local_to_world(pos),
    get_3d_position_from_click: (...args: Parameters<typeof interaction.get_3d_position_from_click>) => interaction.get_3d_position_from_click(...args),
    get_selected_add_element: () => selected_add_element,
    get_selected_fragment: () => selected_fragment,
    get_on_atom_added: () => on_atom_added,
    // Phase X6: expose the fast-path hook bound from <StructureScene>.
    get_atom_fast_ops: () => scene_atom_fast_ops,
  })

  // (铅笔/键编辑 handler 函数已移到 pencil controller)

  // --- 右键菜单动作分发 (controllers/context-menu-actions.ts) ---
  // 右键菜单的所有动作（添加/删除/替换原子、选择、约束、颜色、电荷标签等）由独立模块管理
  const ctx_menu = create_context_menu_actions({
    get_structure: () => structure,
    set_structure: (s) => { structure = s as typeof structure },
    get_selected_sites: () => selected_sites,
    set_selected_sites: (s) => { selected_sites = s },
    get_displayed_structure: () => displayed_structure,
    get_context_menu_3d_position: () => context_menu_3d_position,
    get_context_menu_target_site: () => context_menu_target_site,
    get_context_menu_visible: () => context_menu_visible,
    set_context_menu_visible: (v) => { context_menu_visible = v },
    get_context_menu_position: () => context_menu_position,
    set_context_menu_position: (p) => { context_menu_position = p },
    get_selected_add_element: () => selected_add_element,
    get_site_color_overrides: () => site_color_overrides,
    get_color_picker_input: () => color_picker_input,
    set_color_picker_targets: (t) => { sel_state.color_picker_targets = t },
    get_visible_charge_labels: () => charge_state.visible_charge_labels,
    set_visible_charge_labels: (s) => { charge_state.visible_charge_labels = s },
    get_molecule_import_input: () => molecule_import_input,
    set_molecule_import_position: (p) => { molecule_import_position = p },
    get_charges_import_input: () => charges_import_input,
    get_hidden_sites: () => hidden_sites,
    set_hidden_sites: (s) => { hidden_sites = s },
    get_ghost_atom_indices: () => ghost_atom_indices,
    set_ghost_atom_indices: (s) => { ghost_atom_indices = s },
    push_to_undo,
    push_atom_entry: (inv) => { sel_state.push_atom_entry(inv); pencil.push_bond_undo() },
    get_atom_opacity_overrides: () => sel_state.atom_opacity_overrides,
    set_atom_opacity_overrides: (m) => { sel_state.atom_opacity_overrides = m },
    push_selection_to_undo,
    is_image_atom,
    get_original_atoms_only,
    get_on_atom_added: () => on_atom_added,
    get_on_atoms_deleted: () => on_atoms_deleted,
    get_on_atom_replaced: () => on_atom_replaced,
    get_on_save_to_project: () => on_save_to_project,
    get_on_save_to_database: () => on_save_to_database,
    get_on_export_to_hpc: () => on_export_to_hpc,
    get_on_export_to_file: () => on_export_to_file,
    get_on_edit_as_text: () => on_edit_as_text,
    get_supercell_structure: () => supercell_structure,
    // Phase X6: expose the fast-path hook bound from <StructureScene>.
    get_atom_fast_ops: () => scene_atom_fast_ops,
  })

  // Handle OPTIMADE / PubChem structure import.
  //   • empty pane  → load the imported structure (with a full camera reset)
  //   • loaded pane → merge the import into the current structure
  // Because `structure` is bound to the active pane, the write-back targets the
  // correct pane in multi-pane layouts — no parent routing required.
  function handle_optimade_import(imported_structure: PymatgenStructure) {
    if (!imported_structure?.sites?.length) {
      return
    }

    if (structure?.sites?.length) {
      // Save current state for undo, then merge the import outside the existing
      // structure (offset with padding).
      push_to_undo()
      const import_position = get_import_position_outside(structure, imported_structure)
      const merged = merge_structures(structure, imported_structure, import_position)
      // Mark _aligned so align_on_load doesn't re-rotate the merged structure,
      // which would shift the original atoms and cause overlap.
      structure = { ...merged, _aligned: true } as any as typeof structure
    } else {
      // Empty pane: load the import directly with a full camera reset.
      scene_props.camera_position = [0, 0, 0] // triggers auto-positioning at correct distance
      center_camera_trigger++ // re-center orbit target on structure
      camera_has_moved = false
      structure = imported_structure
    }

    selected_sites = []
    optimade_import_position = null
    optimade_modal_visible = false
    optimade_preview_visible = false

    // Notify the parent (multi-pane app) so it can refresh the tab label.
    on_structure_imported?.()
  }

  // get_import_position_outside — delegated to controllers/transform-controller.ts

  // Handle pasted content import.
  //   • empty pane  → load the pasted structure
  //   • loaded pane → merge it into the current structure
  function handle_paste_content_import(imported_structure: PymatgenStructure, filename: string) {
    if (!imported_structure?.sites?.length) return

    // Save current state for undo
    if (structure) {
      push_to_undo()
      // Merge the imported structure outside the existing structure (to the right with padding)
      const import_position = get_import_position_outside(structure, imported_structure)
      const merged = merge_structures(structure, imported_structure, import_position)
      // Mark as _aligned to prevent align_on_load from re-rotating the entire merged structure,
      // which would move the original atoms to different positions causing overlap
      structure = { ...merged, _aligned: true } as any as typeof structure
    } else {
      // No existing structure, just use the imported one
      scene_props.camera_position = [0, 0, 0] // triggers auto-positioning at correct distance
      center_camera_trigger++ // re-center orbit target on structure
      camera_has_moved = false
      structure = imported_structure
    }
    selected_sites = []
    paste_content_modal_visible = false

    // Capture for MD analysis (serialize structure since raw content isn't available)
    imported_traj_b64 = content_to_base64(JSON.stringify(imported_structure))
    imported_traj_format = filename.split(`.`).pop()?.toLowerCase() || ``

    // Emit file load event + notify parent to refresh the tab label
    on_file_load?.({ filename, file_size: 0 })
    on_structure_imported?.()
  }

  // Handle OPTIMADE structure preview
  function handle_optimade_preview(optimade_struct: any, pymatgen_struct: PymatgenStructure) {
    optimade_pending_structure = optimade_struct
    optimade_pending_pymatgen = pymatgen_struct

    const provider = optimade_struct.attributes?.database_provider ?? 'OPTIMADE'
    optimade_pending_provider = provider

    const attrs = optimade_struct.attributes ?? {}
    const formula =
      attrs.chemical_formula_descriptive ?? attrs.chemical_formula_reduced ?? 'Unknown formula'
    const sites =
      attrs.n_sites ??
      (Array.isArray(attrs.cartesian_site_positions) ? attrs.cartesian_site_positions.length : 0)

    optimade_preview_title = 'Preview Structure Import'
    optimade_preview_formula = formula
    optimade_preview_lattice = null // let modal compute from optimade_structure (legacy fallback)
    optimade_preview_details = [
      { label: 'ID:', value: String(optimade_struct.id ?? ''), mono: true },
      { label: 'Formula:', value: formula },
      { label: 'Sites:', value: String(sites) },
      { label: 'Database:', value: provider },
    ]

    optimade_preview_visible = true
  }

  // Handle PubChem compound preview (called from OptimadeSearchModal pubchem branch
  // and from any other pubchem entry point that opts into preview)
  function handle_pubchem_preview(
    compound: any,
    search_result: any | null,
    pymatgen_struct: PymatgenStructure,
  ) {
    optimade_pending_structure = null // not OPTIMADE
    optimade_pending_pymatgen = pymatgen_struct
    optimade_pending_provider = 'PubChem'

    const cid = compound?.id?.id?.cid ?? search_result?.cid ?? ''
    const formula = search_result?.formula ?? ''
    const name = search_result?.name ?? ''
    const weight = search_result?.weight
    const heavy = search_result?.HeavyAtomCount
    const n_atoms = Array.isArray(compound?.atoms?.element)
      ? compound.atoms.element.length
      : (heavy ?? 0)

    const rows: Array<{ label: string; value: string; mono?: boolean }> = []
    if (cid) rows.push({ label: 'CID:', value: String(cid), mono: true })
    if (name) rows.push({ label: 'Name:', value: name })
    if (formula) rows.push({ label: 'Formula:', value: formula })
    if (n_atoms) rows.push({ label: 'Atoms:', value: String(n_atoms) })
    if (typeof weight === 'number') rows.push({ label: 'Weight:', value: `${weight.toFixed(2)} g/mol` })
    rows.push({ label: 'Database:', value: 'PubChem' })

    optimade_preview_title = 'Preview Compound Import'
    optimade_preview_formula = formula
    optimade_preview_lattice = null // molecules — no crystallographic lattice
    optimade_preview_details = rows

    optimade_preview_visible = true
  }

  // Confirm and execute OPTIMADE / PubChem import
  function confirm_optimade_import() {
    if (optimade_pending_pymatgen) {
      handle_optimade_import(optimade_pending_pymatgen)

      // Close both modals and clear pending state
      optimade_preview_visible = false
      optimade_modal_visible = false
      optimade_pending_structure = null
      optimade_pending_pymatgen = null
      optimade_pending_provider = null
      optimade_preview_details = []
      optimade_preview_formula = ''
      optimade_preview_lattice = null
    }
  }

  // Cancel preview and return to search modal
  function cancel_optimade_import() {
    optimade_preview_visible = false
    optimade_pending_structure = null
    optimade_pending_pymatgen = null
    optimade_pending_provider = null
    optimade_preview_details = []
    optimade_preview_formula = ''
    optimade_preview_lattice = null
  }

  // Handle molecule import file selection
  async function handle_molecule_import(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !molecule_import_position || !structure) {
      input.value = '' // Reset input
      return
    }

    try {
      // Read and parse the file
      const { content, filename } = await decompress_file(file)
      const imported = parse_any_structure(content, filename)

      if (imported && imported.sites && imported.sites.length > 0) {
        // Save current state for undo
        push_to_undo()
        // Concatenate the structures (converts to molecule, no lattice)
        const concatenated = concatenate_structures(structure, imported, molecule_import_position)
        // Mark as _aligned to prevent re-alignment moving existing atoms
        structure = { ...concatenated, _aligned: true } as any as typeof structure
        // Clear selection after import
        selected_sites = []
      }
    } catch (error) {
      console.error('Failed to import molecule:', error)
    }

    // Reset state
    input.value = ''
    molecule_import_position = null
  }

  // Apply Bader charge data to the current structure (validation + pure transform)
  function apply_charges_to_structure(content: string, filename: string) {
    if (!structure) return
    if (!is_acf_dat(content, filename)) {
      error_msg = `File does not appear to be an ACF.dat file`
      return
    }
    const charges = parse_acf_dat(content)
    if (charges.length !== structure.sites.length) {
      error_msg = `Charge count (${charges.length}) doesn't match atom count (${structure.sites.length})`
      return
    }
    structure = apply_charges(structure, charges) as typeof structure
    atom_color_config = { ...atom_color_config, mode: `charge`, scale_type: `continuous` }
  }

  // Handle charge data file selection
  async function handle_charges_import(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !structure) { input.value = ``; return }
    try {
      const content = await file.text()
      apply_charges_to_structure(content, file.name)
    } catch (error) {
      error_msg = `Failed to load charges: ${error}`
    }
    input.value = ``
  }

  // Background color override effect is in settings controller

  $effect(() => { // react to 'fullscreen' state changes
    if (typeof window !== `undefined`) {
      if (fullscreen && !document.fullscreenElement && wrapper) {
        wrapper.requestFullscreen().catch(console.error)
      } else if (!fullscreen && document.fullscreenElement) document.exitFullscreen()
    }
  })
</script>

<svelte:document
  onfullscreenchange={() => {
    fullscreen = Boolean(document.fullscreenElement)
    on_fullscreen_change?.({ structure, is_fullscreen: fullscreen })
  }}
/>

<div
  class:dragover
  class:active={info_pane_open || controls_open || build.build_pane_open || optimization_pane_open || analysis.analysis_pane_open || workflow_pane_open || io_pane_open || server_pane_open || plugin_hub_open}
  class:axis-locked={interaction.axis_lock_key !== null}
  class:placement-mode={build.adsorbate_placement_mode_active}
  role="region"
  aria-label="Structure viewer"
  bind:this={wrapper}
  bind:clientWidth={width}
  bind:clientHeight={height}
  onmouseenter={() => (hovered = true)}
  onmouseleave={() => (hovered = false)}
  onpointerdowncapture={interaction.handleShiftClickCapture}
  onpointerupcapture={interaction.handlePointerUpCapture}
  oncontextmenu={(event) => {
    const target = event.target as HTMLElement
    if (target.closest(`.draggable-pane`) || target.closest(`.chat-panel`) || target.closest(`.structure-legend`) || target.closest(`.control-buttons`)) return
    interaction.oncontextmenu(event)
  }}
  ondblclick={(event) => {
    const target = event.target as HTMLElement
    // Don't handle if double-click was on UI controls/panes/legend
    if (
      target.closest(`.control-buttons`) ||
      target.closest(`.structure-legend`) ||
      target.closest(`.info-pane`) ||
      target.closest(`.export-pane`) ||
      target.closest(`.controls-pane`) ||
      target.tagName === `BUTTON` ||
      target.tagName === `INPUT` ||
      target.tagName === `SELECT`
    ) return
    // Double-click on 3D scene clears selection (use reset button to reset camera)
    if (selected_sites.length > 0) {
      selected_sites = []
    }
    if (pencil.selected_bonds.length > 0) {
      pencil.selected_bonds = []
    }
  }}
  onselectstart={(e) => e.preventDefault()}
  onpointerenter={(e) => { if (e.buttons > 0) window.getSelection()?.removeAllRanges() }}
  ondrop={file_handlers.handle_file_drop}
  ondragover={(event) => {
    if (!allow_file_drop) return // Let event bubble to parent handlers
    event.preventDefault()
    event.stopPropagation()
    dragover = true
  }}
  ondragleave={(event) => {
    if (!allow_file_drop) return // Let event bubble to parent handlers
    event.preventDefault()
    event.stopPropagation()
    dragover = false
  }}
  {...rest}
  class="structure {rest.class ?? ``}"
  class:pencil-mode-active={pencil.pencil_mode_active}
  class:crop-mode-active={interaction.crop_mode_active}
  class:md-split={show_md_panel}
  class:md-horizontal={show_md_panel && md_layout === `horizontal`}
  class:md-vertical={show_md_panel && md_layout === `vertical`}
  class:xrd-split={xrd.show_panel}
  class:xrd-horizontal={xrd.show_panel && xrd.layout === `horizontal`}
  class:xrd-vertical={xrd.show_panel && xrd.layout === `vertical`}
  class:dos-split={show_dos_panel || show_cohp_panel}
  class:dos-horizontal={(show_dos_panel || show_cohp_panel) && (show_dos_panel ? dos_layout : cohp_layout) === `horizontal`}
  class:dos-vertical={(show_dos_panel || show_cohp_panel) && (show_dos_panel ? dos_layout : cohp_layout) === `vertical`}
  class:slice-split={show_slice_panel}
  class:slice-horizontal={show_slice_panel && slice_layout === `horizontal`}
  class:slice-vertical={show_slice_panel && slice_layout === `vertical`}
  class:side-split={(show_terminal || show_editor || show_preview) && !chat_pane_open}
  class:side-horizontal={(show_terminal || show_editor || show_preview) && !chat_pane_open && !(show_terminal && !show_editor && !show_preview && terminal_layout === `vertical`)}
  class:side-vertical={show_terminal && !show_editor && !show_preview && !chat_pane_open && terminal_layout === `vertical`}
  class:side-minimized={side_panel_minimized && (show_terminal || show_editor || show_preview)}
  class:chat-split={chat_pane_open && chat_position.value === `right` && !(show_terminal || show_editor || show_preview)}
  class:chat-bottom={chat_pane_open && chat_position.value === `bottom` && !(show_terminal || show_editor || show_preview)}
  class:combined-split={chat_pane_open && chat_position.value === `right` && (show_terminal || show_editor || show_preview)}
  class:combined-bottom={chat_pane_open && chat_position.value === `bottom` && (show_terminal || show_editor || show_preview)}
  style:grid-template-columns={(chat_pane_open && chat_position.value === `right` && (show_terminal || show_editor || show_preview))
        || ((show_terminal || show_editor || show_preview) && !(show_terminal && !show_editor && !show_preview && terminal_layout === `vertical`))
      ? side_panel_minimized ? `1fr 0px 28px` : `1fr 4px ${side_panel_size}%`
      : chat_pane_open && chat_position.value === `right`
        ? `1fr 5px minmax(280px, ${chat_panel_size}%)`
        : undefined}
  style:grid-template-rows={chat_pane_open && chat_position.value === `bottom` && !(show_terminal || show_editor || show_preview)
      ? `1fr 5px ${chat_bottom_size}%`
      : chat_pane_open && chat_position.value === `bottom` && (show_terminal || show_editor || show_preview) && !side_panel_minimized
        ? `1fr 5px ${chat_bottom_size}%`
        : chat_pane_open && chat_position.value === `right` && (show_terminal || show_editor || show_preview) && !side_panel_minimized
          ? `1fr 1fr`
          : !chat_pane_open && (show_terminal || show_editor || show_preview) && (show_terminal && !show_editor && !show_preview && terminal_layout === `vertical`)
            ? side_panel_minimized ? `1fr 0px 28px` : `1fr 4px ${side_panel_size}%`
            : undefined}
>
  <div class="structure-main">
  <!-- Box selection overlay - uses transform for GPU-accelerated positioning -->
  {#if interaction.is_box_selecting && interaction.box_select_start && interaction.box_select_end}
    <div
      class="selection-box"
      style="
        position: absolute;
        left: 0;
        top: 0;
        width: {Math.abs(interaction.box_select_end.x - interaction.box_select_start.x)}px;
        height: {Math.abs(interaction.box_select_end.y - interaction.box_select_start.y)}px;
        transform: translate({Math.min(interaction.box_select_start.x, interaction.box_select_end.x)}px, {Math.min(interaction.box_select_start.y, interaction.box_select_end.y)}px);
        border: 2px dashed #6cf0ff;
        background: rgba(108, 240, 255, 0.1);
        pointer-events: none;
        z-index: 1000;
        will-change: transform, width, height;
        contain: layout style;
      "
    ></div>
  {/if}

  <!-- Rotation angle HUD -->
  {#if interaction.is_rotating_atoms && interaction.atom_rotation_angle_deg > 0.05}
    <div class="rotation-angle-hud">
      {interaction.atom_rotation_angle_deg.toFixed(1)}°
    </div>
  {/if}

  <!-- Crop drawing preview -->
  {#if interaction.crop_drawing && interaction.crop_draw_start && interaction.crop_draw_end}
    {@const cx = Math.min(interaction.crop_draw_start.x, interaction.crop_draw_end.x)}
    {@const cy = Math.min(interaction.crop_draw_start.y, interaction.crop_draw_end.y)}
    {@const cw = Math.abs(interaction.crop_draw_end.x - interaction.crop_draw_start.x)}
    {@const ch = Math.abs(interaction.crop_draw_end.y - interaction.crop_draw_start.y)}
    <div
      style="
        position: absolute; left: 0; top: 0;
        width: {cw}px; height: {ch}px;
        transform: translate({cx}px, {cy}px);
        border: 2px dashed #ff9800;
        background: rgba(255, 152, 0, 0.1);
        pointer-events: none; z-index: 1001;
      "
    ></div>
  {:else if interaction.crop_region && !interaction.crop_drawing}
    <!-- Persistent crop region overlay -->
    <div
      style="
        position: absolute; left: 0; top: 0;
        width: {interaction.crop_region.width}px; height: {interaction.crop_region.height}px;
        transform: translate({interaction.crop_region.x}px, {interaction.crop_region.y}px);
        border: 2px solid #ff9800;
        background: rgba(255, 152, 0, 0.08);
        pointer-events: none; z-index: 1001;
      "
    ></div>
  {/if}

  {@render children?.({ structure })}
  {#if loading}
    <Spinner text="Loading structure..." {...spinner_props} />
  {:else if error_msg}
    <div class="error-state">
      <p class="error">{error_msg}</p>
      <button onclick={() => (error_msg = undefined)}>{t('common.dismiss')}</button>
    </div>
  {:else if (structure?.sites?.length ?? 0) > 0}
    <StructureToolbar
      {camera_has_moved}
      {visible_buttons}
      {hide_extra_tools}
      {enable_measure_mode}
      {fullscreen_toggle}
      {hidden_toolbar_items}
      {remote_origin}
      {structure}
      {molecular_fragments}
      {reset_text}
      {wrapper}
      {pencil}
      bind:fullscreen
      bind:gesture_active
      bind:gesture_config
      bind:gesture_art_mode
      bind:show_gesture_settings
      bind:selected_add_element
      bind:periodic_table_visible
      bind:selected_fragment
      bind:build_pane_open={build.build_pane_open}
      bind:analysis_pane_open={analysis.analysis_pane_open}
      bind:workflow_pane_open
      bind:io_pane_open
      bind:server_pane_open
      bind:plugin_hub_open
      bind:large_system_mode
      bind:chat_pane_open
      on_popout_chat={popout_chat}
      bind:show_terminal
      bind:side_panel_minimized
      bind:terminal_popped_out
      bind:terminal_popped_sync_cwd
      bind:measure_mode={meas_state.measure_mode}
      bind:measure_mode_active={meas_state.measure_mode_active}
      bind:measure_menu_open={meas_state.measure_menu_open}
      bind:measurements={meas_state.measurements}
      bind:measured_sites
      bind:selected_measurement_id={meas_state.selected_measurement_id}
      bind:selected_sites
      bind:current_continuous_measurement_sites={meas_state.current_continuous_measurement_sites}
      {reset_camera}
      {delete_measurement}
    >
      {#if !hide_extra_tools}
        <BuildPane
          bind:show={build.build_pane_open}
          bind:active_tab={build.active_build_tab}
          disabled_tabs={build.has_vacuum ? [] : [
            { id: 'adsorption', reason: 'Add vacuum to enable' },
            { id: 'adsorbate', reason: 'Add vacuum to enable' },
            { id: 'water_layer', reason: 'Add vacuum to enable' },
          ]}
        >
          {#if build.active_build_tab === 'lattice' && structure}
            <LatticePane
              embedded={true}
              bind:structure
              pane_open={true}
              bind:center_camera_trigger
              bind:supercell_scaling
              {large_system_mode}
              on_structure_change={(new_struct) => build.handle_structure_replace(new_struct)}
              on_push_undo={push_to_undo}
              on_reset_view={() => align_view_to_lattice()}
            />
          {:else if build.active_build_tab === 'slab_cutter' && structure && 'lattice' in structure}
            <MillerSlabCutterPane
              embedded={true}
              bind:structure={structure as PymatgenStructure}
              bulk_structure={build.slab_cutter_bulk}
              pane_open={true}
              bind:cutting_active={build.cutting_active}
              bind:plane_normal={build.cutting_plane_normal}
              bind:plane_offset={build.cutting_plane_offset}
              bind:plane_thickness={build.cutting_plane_thickness}
              bind:atom_visibility={build.cutting_atom_visibility}
              bind:flash_intensity={build.cutting_flash_intensity}
              bind:animation_phase={build.cutting_animation_phase}
              bind:miller_label={build.cutting_miller_label}
              bind:slab_preview={build.cutting_slab_preview}
              bind:preview_mode={build.cutting_preview_mode}
              bind:show_bonds_in_preview={build.cutting_show_bonds}
              on_push_undo={push_to_undo}
              on_camera_transition={() => build.handle_slab_camera_transition(scene_props)}
              {symmetry_data}
              {cell_type}
              on_symmetry_data_change={(data) => { symmetry_data = data }}
              on_structure_change={(new_struct) => build.handle_slab_structure_change(new_struct)}
              on_reset_view={() => align_view_to_lattice()}
            />
          {:else if build.active_build_tab === 'adsorption' && structure && 'lattice' in structure}
            <AdsorptionSitePane
              embedded={true}
              structure={structure as PymatgenStructure}
              pane_open={true}
              bind:adsorption_sites={build.adsorption_sites}
              bind:show_sites={build.show_adsorption_sites}
              bind:selected_site_idx={build.selected_adsorption_site_idx}
              bind:delete_site_ref={build.delete_adsorption_site_fn}
            />
          {:else if build.active_build_tab === 'adsorbate' && structure && 'lattice' in structure}
            <AdsorbatePlacementPane
              embedded={true}
              bind:this={build.adsorbate_placement_ref}
              bind:structure
              pane_open={true}
              adsorption_sites={build.adsorption_sites}
              bind:placement_mode_active={build.adsorbate_placement_mode_active}
              bind:last_placed_adsorbate_indices={build.last_placed_adsorbate_indices}
              on_push_undo={push_to_undo}
              on_structure_change={(new_struct) => build.handle_structure_modify(new_struct)}
              on_placement_mode_change={(active) => {
                build.adsorbate_placement_mode_active = active
              }}
              on_open_optimizer={(mobile_indices) => {
                selected_sites = mobile_indices
                optimization_pane_open = true
              }}
            />
          {:else if build.active_build_tab === 'water_layer' && structure && 'lattice' in structure}
            <WaterLayerPane
              embedded={true}
              bind:structure={structure as PymatgenStructure}
              pane_open={true}
              on_push_undo={push_to_undo}
              on_structure_change={(new_struct) => {
                console.log(`[Structure.svelte water on_structure_change] new_struct.sites: ${new_struct?.sites?.length}, O: ${new_struct?.sites?.filter((s: any) => s.species?.[0]?.element === 'O').length}`)
                build.handle_structure_modify(new_struct)
                console.log(`[Structure.svelte water] after assignment, structure.sites: ${structure?.sites?.length}`)
              }}
            />
          {:else if build.active_build_tab === 'pseudo_h' && structure && 'lattice' in structure}
            <PseudoHydrogenPane
              embedded={true}
              bind:structure={structure as PymatgenStructure}
              pane_open={true}
              selected_sites={selected_sites}
              parent_bulk={build.slab_cutter_bulk}
              on_push_undo={push_to_undo}
              on_structure_change={(new_struct) => build.handle_structure_modify(new_struct)}
              on_pseudo_h_added={(result, n_slab_atoms) => {
                // Auto-assign distinct colors for pseudo-H atoms by charge type
                const charge_colors: Record<number, string> = {}
                const palette = [`#ff69b4`, `#00ced1`, `#ffa500`, `#9370db`, `#32cd32`, `#ff6347`, `#4169e1`, `#ffd700`]
                let color_idx = 0
                // Group by vasp_charge and assign colors
                for (const h of result.pseudo_h_list) {
                  if (!(h.vasp_charge in charge_colors)) {
                    charge_colors[h.vasp_charge] = palette[color_idx % palette.length]
                    color_idx++
                  }
                }
                // Pseudo-H atoms are appended after original slab atoms, grouped by charge
                const charge_groups: Record<number, typeof result.pseudo_h_list> = {}
                for (const h of result.pseudo_h_list) {
                  ;(charge_groups[h.vasp_charge] ??= []).push(h)
                }
                let idx = n_slab_atoms
                for (const charge of Object.keys(charge_groups).map(Number).sort()) {
                  for (const _h of charge_groups[charge]) {
                    site_color_overrides.set(idx, charge_colors[charge])
                    idx++
                  }
                }
              }}
            />
          {:else if build.active_build_tab === 'moire'}
            <MoirePane
              embedded={true}
              bind:structure={structure as PymatgenStructure}
              pane_open={true}
              bind:atom_color_config
              on_push_undo={push_to_undo}
              on_structure_change={(new_struct) => build.handle_structure_replace(new_struct)}
            />
          {:else if build.active_build_tab === 'nanotube'}
            <NanotubePane
              embedded={true}
              bind:structure={structure as PymatgenStructure}
              pane_open={true}
              on_push_undo={push_to_undo}
              on_structure_change={(new_struct) => build.handle_structure_replace(new_struct)}
            />
          {:else if build.active_build_tab === 'nanoscroll'}
            <NanoscrollPane
              embedded={true}
              bind:structure={structure as PymatgenStructure}
              pane_open={true}
              on_push_undo={push_to_undo}
              on_structure_change={(new_struct) => build.handle_structure_replace(new_struct)}
            />
          {:else if build.active_build_tab === 'heterostructure'}
            <HeterostructurePane
              embedded={true}
              bind:structure={structure as PymatgenStructure}
              pane_open={true}
              on_push_undo={push_to_undo}
              on_structure_change={(new_struct) => build.handle_structure_replace(new_struct)}
              {on_save_to_database}
              {on_export_to_hpc}
            />
          {:else if build.active_build_tab === 'doping' && structure && 'lattice' in structure}
            <DopingPane
              bind:this={build.doping_pane_ref}
              bind:structure={structure as PymatgenStructure}
              selected_sites={selected_sites}
              on_push_undo={push_to_undo}
              on_trajectory_created={(traj) => {
                on_file_load?.({ trajectory: traj, filename: `doping_substitution.json` } as any)
              }}
              bind:pt_highlight_symbols={build.doping_pt_symbols}
              bind:pt_group_label={build.doping_group_label}
              pt_window_open={build.doping_pt_window_open}
              on_reopen_pt={() => build.doping_pt_panel_ref?.open_pt_window()}
            />
          {:else if build.active_build_tab === 'pathway' && structure && 'lattice' in structure}
            <PathwayBuilderPane
              bind:structure={structure as PymatgenStructure}
              selected_sites={selected_sites}
              on_push_undo={push_to_undo}
              on_trajectory_created={(traj) => {
                on_file_load?.({ trajectory: traj, filename: `reaction_pathway.json` } as any)
              }}
            />
          {:else if structure && !('lattice' in structure && (structure as any).lattice) && ['slab_cutter', 'adsorption', 'adsorbate', 'water_layer', 'pseudo_h', 'doping', 'pathway'].includes(build.active_build_tab)}
            <p class="needs-lattice-hint">{t('structure.requires_periodic_lattice', { tab: t('structure.lattice_tab') })}</p>
          {/if}
        </BuildPane>
        {/if}

        {#if structure}
          <OptimizationPane
            bind:structure
            bind:pane_open={optimization_pane_open}
            on_push_undo={push_to_undo}
            on_structure_change={(new_struct) => {
              structure = new_struct
            }}
            selected_indices={get_original_atoms_only(selected_sites)}
          />
        {/if}

        {#if !hide_extra_tools}
          <AnalysisPane
            bind:show={analysis.analysis_pane_open}
            bind:active_tab={analysis.active_analysis_tab}
            {structure}
            bind:xrd_radiation={xrd.radiation}
            xrd_pattern={xrd.pattern}
            xrd_loading={xrd.loading}
            xrd_error={xrd.error}
            pinned_xrd_patterns={xrd.pinned_patterns}
            on_pin_current={xrd.pin_current}
            on_unpin={xrd.unpin}
            on_toggle_pinned={xrd.toggle_pinned_visibility}
            on_structure_import={(s) => { center_camera_trigger++; structure = s }}
          >
            {#if analysis.active_analysis_tab ==='md'}
              <MdAnalysisPane
                trajectory_b64={imported_traj_b64}
                trajectory_format={imported_traj_format}
                on_plot={(data) => {
                  md_plot_data = data
                  if (data) {
                    md_x_label = data.x_label || ``
                    md_y_label = data.y_label || ``
                  }
                }}
              />
              <!-- Slow-Growth inline trigger -->
              <section class="sg-section">
                <h5 class="sg-section-title">{t('structure.slow_growth_post_processing')}</h5>
                <div class="sg-upload-row">
                  <label class="sg-upload-btn">
                    {t('structure.upload_report')}
                    <input type="file" accept="*" onchange={(e) => {
                      slow_growth_pane_open = true
                      const input = e.target as HTMLInputElement
                      const file = input.files?.[0]
                      if (file) {
                        window.dispatchEvent(new CustomEvent(`catgo-sg-upload`, { detail: { file } }))
                      }
                      input.value = ``
                    }} hidden />
                  </label>
                  <button class="sg-upload-btn" onclick={() => {
                    slow_growth_pane_open = true
                    window.dispatchEvent(new CustomEvent(`catgo-sg-paste`))
                  }}>{t('structure.paste_report')}</button>
                  <button class="sg-upload-btn" onclick={() => {
                    slow_growth_pane_open = true
                    window.dispatchEvent(new CustomEvent(`catgo-sg-detect-report`))
                  }} title={t('structure.detect_report_title')}>{t('structure.detect_report')}</button>
                  {#if slow_growth_pane_open}
                    <button class="sg-upload-btn sg-close" onclick={() => slow_growth_pane_open = false}>{t('common.close')}</button>
                  {/if}
                </div>
              </section>
            {:else if analysis.active_analysis_tab ==='electronic'}
              <div class="electronic-sub-tabs">
                <button
                  class:active={electronic_sub_tab === `dos`}
                  onclick={() => electronic_sub_tab = `dos`}
                >DOS</button>
                <button
                  class:active={electronic_sub_tab === `cohp`}
                  onclick={() => electronic_sub_tab = `cohp`}
                >COHP</button>
                <button
                  class:active={electronic_sub_tab === `bands`}
                  onclick={() => electronic_sub_tab = `bands`}
                >{t('structure.bands')}</button>
                <button
                  class:active={electronic_sub_tab === `charge`}
                  onclick={() => electronic_sub_tab = `charge`}
                >{t('structure.charge')}</button>
              </div>
              {#if electronic_sub_tab === `dos`}
                <DosAnalysisPane
                  on_structure_loaded={(s) => { center_camera_trigger++; structure = s }}
                  initial_session={dos_session}
                  bind:dos_state
                />
              {:else if electronic_sub_tab === `cohp`}
                <CohpAnalysisPane bind:cohp_state />
              {:else if electronic_sub_tab === `bands`}
                <BandAnalysisPane
                  on_structure_loaded={(s) => { center_camera_trigger++; structure = s }}
                  bind:band_state
                />
              {:else if electronic_sub_tab === `charge`}
                <ChargeAnalysisPane
                  on_load_chgcar={async (file) => {
                    const is_cube = /\.(cube|cub)$/i.test(file.name)
                    // VASP grid file variants — CHGCAR diff outputs are named
                    // CHGDIFF / CHGCAR_diff / DIFFCHG / CHGCAR.diff in the wild;
                    // they share the CHGCAR file format and route through the
                    // same backend cube-conversion endpoint.
                    const is_chgcar = !is_cube && /CHGCAR|CHGDIFF|DIFFCHG|AECCAR|LOCPOT|ELFCAR|PARCHG/i.test(file.name)
                    if (is_chgcar) {
                      // Convert CHGCAR-family files (CHGCAR, CHGDIFF, LOCPOT,
                      // ELFCAR, PARCHG, …) to Gaussian cube text in the
                      // browser via chgdiff-wasm.  Was a `/api/chgcar/convert-to-cube`
                      // round-trip to the Python backend; that endpoint
                      // shells out to a Rust `cube-processor` binary which
                      // isn't bundled in the PyInstaller image, so a fresh
                      // .deb / .AppImage couldn't render CHGDIFF at all.
                      // The WASM path also makes the VS Code extension
                      // independent of the bundled sidecar for this feature.
                      // Falls back to the HTTP endpoint if WASM init fails
                      // (older browsers, broken pkg) so existing dev setups
                      // keep working.
                      try {
                        const text = await file.text()
                        let cube_text: string
                        try {
                          const { chgcar_to_cube } = await import('$lib/electronic/chgdiff-wasm')
                          cube_text = await chgcar_to_cube(text)
                        } catch (wasm_err) {
                          console.warn(`[CHGCAR] WASM path failed, falling back to backend:`, wasm_err)
                          const form = new FormData()
                          form.append(`file`, file)
                          const resp = await fetch(`${API_BASE}/chgcar/convert-to-cube`, {
                            method: `POST`,
                            body: form,
                          })
                          if (!resp.ok) throw new Error(`Conversion failed: ${resp.statusText}`)
                          cube_text = await resp.text()
                        }
                        const cube_filename = file.name + `.cube`
                        const { parse_cube_header, cube_atoms_to_molecule } = await import('$lib/cube/parse-cube')
                        const header = parse_cube_header(cube_text)
                        const molecule = cube_atoms_to_molecule(header)
                        if (molecule.sites.length > 0) {
                          structure = { ...molecule, _aligned: true } as any
                          center_camera_trigger++
                        }
                        const blob = new Blob([cube_text], { type: `chemical/x-cube` })
                        cube_file = new File([blob], cube_filename)
                        cube_pane_open = true
                      } catch (err) {
                        console.error(`CHGCAR conversion failed:`, err)
                      }
                    } else {
                      // .cube file — parse header to update structure
                      try {
                        const text = await file.text()
                        const { parse_cube_header, cube_atoms_to_molecule } = await import('$lib/cube/parse-cube')
                        const header = parse_cube_header(text)
                        const molecule = cube_atoms_to_molecule(header)
                        if (molecule.sites.length > 0) {
                          structure = { ...molecule, _aligned: true } as any
                          center_camera_trigger++
                        }
                      } catch (err) {
                        console.error(`Cube header parse failed:`, err)
                      }
                      cube_file = file
                      cube_pane_open = true
                    }
                  }}
                  on_load_bader={(content, filename) => {
                    apply_charges_to_structure(content, filename)
                  }}
                />
              {/if}
            {:else if analysis.active_analysis_tab ==='phase'}
              <section class="module-placeholder">
                <h5>{t('structure.phase_analysis')}</h5>
                <ul>
                  <li>{t('structure.phase_diagram')}</li>
                  <li>{t('structure.convex_hull')}</li>
                  <li>{t('structure.stability_analysis')}</li>
                  <li>{t('structure.formation_energy')}</li>
                </ul>
              </section>
            {:else if analysis.active_analysis_tab ==='structure_analysis'}
              <section class="symmetry-analysis-section">
                {#if !structure || !(`lattice` in structure)}
                  <p class="sym-hint">{t('structure.load_periodic_for_symmetry')}</p>
                {:else}
                  <h5 class="sym-heading">{t('structure.symmetry')}</h5>
                  <div class="sym-controls">
                    <label class="sym-control-row">
                      <span>{t('structure.precision')}</span>
                      <input
                        type="number"
                        step="1e-5"
                        value={analysis.symmetry_settings.symprec}
                        onchange={(e) => {
                          const v = parseFloat(e.currentTarget.value)
                          if (Number.isFinite(v)) analysis.symmetry_settings = { ...analysis.symmetry_settings, symprec: v }
                        }}
                      />
                    </label>
                    <label class="sym-control-row">
                      <span>{t('structure.algorithm')}</span>
                      <select
                        value={analysis.symmetry_settings.algo}
                        onchange={(e) => analysis.symmetry_settings = { ...analysis.symmetry_settings, algo: e.currentTarget.value as 'Moyo' | 'Spglib' }}
                      >
                        <option value="Moyo">Moyo</option>
                        <option value="Spglib">Spglib</option>
                      </select>
                    </label>
                  </div>
                  <button class="sym-analyze-btn" onclick={analysis.run_symmetry_analysis} disabled={analysis.symmetry_loading}>
                    {analysis.symmetry_loading ? t('structure.analyzing') : t('structure.analyze')}
                  </button>
                  {#if analysis.symmetry_error}
                    <p class="sym-error">{analysis.symmetry_error}</p>
                  {/if}
                  {#if symmetry_data}
                    <div class="sym-results">
                      <div>{t('structure.space_group')} <strong>{symmetry_data.number} ({symmetry_data.hm_symbol ?? '?'})</strong></div>
                      <div>{t('structure.crystal_system')} <strong>{spacegroup_to_crystal_sys(symmetry_data.number)}</strong></div>
                      <div>{t('structure.hall_number_label')} <strong>{symmetry_data.hall_number}</strong></div>
                      <div>{t('structure.pearson_label')} <strong>{symmetry_data.pearson_symbol}</strong></div>
                      <div>{t('structure.sym_ops_label')} <strong>{symmetry_data.operations.length}</strong></div>
                    </div>
                    {@const wyckoff_positions = wyckoff_positions_from_moyo(symmetry_data, structure)}
                    {#if wyckoff_positions.length > 0}
                      <WyckoffTable
                        {wyckoff_positions}
                        on_hover={(indices) => { if (indices) selected_sites = indices; else selected_sites = [] }}
                        on_click={(indices) => { if (indices) selected_sites = indices; else selected_sites = [] }}
                      />
                    {/if}
                  {/if}

                  <!-- MOF Topology Analysis -->
                  <hr class="section-divider" />
                  <h5 class="sym-heading">{t('structure.mof_topology')}</h5>
                  <button class="sym-analyze-btn" onclick={run_mof_analysis} disabled={mof_loading}>
                    {mof_loading ? t('structure.analyzing') : t('structure.analyze')}
                  </button>
                  {#if mof_error}
                    <p class="sym-error">{mof_error}</p>
                  {/if}
                  {#if mof_clusters !== null}
                    {#if !mof_clusters.is_mof}
                      <p class="sym-hint">{t('structure.not_mof_structure')}</p>
                    {:else}
                      {@const nodes = mof_clusters.sbus.map((s, i) => ({...s, _idx: i})).filter(s => normalize_sbu_type(s.sbu_type) === 'Node')}
                      {@const linkers = mof_clusters.sbus.map((s, i) => ({...s, _idx: i})).filter(s => normalize_sbu_type(s.sbu_type) === 'Linker')}
                      {@const ligands = mof_clusters.sbus.map((s, i) => ({...s, _idx: i})).filter(s => normalize_sbu_type(s.sbu_type) === 'Ligand')}
                      <div class="sym-results">
                        <div>{t('structure.mof_nodes')} <strong>{nodes.length}</strong></div>
                        <div>{t('structure.mof_linkers')} <strong>{linkers.length}</strong></div>
                        {#if ligands.length > 0}
                          <div>{t('structure.mof_caps')} <strong>{ligands.length}</strong></div>
                        {/if}
                      </div>
                      <div class="mof-sbu-list">
                        {#each nodes as sbu}
                          {@const sbu_hash = wl_hashes?.find(h => h.sbu_index === sbu._idx)}
                          <button class="mof-sbu-row" onclick={() => { selected_sites = [...sbu.atom_indices] }}
                            title={t('structure.click_highlight_atoms', { n: sbu.atom_indices.length })}>
                            <span class="mof-sbu-badge node">{t('structure.node')}</span>
                            <span>{sbu.formula || t('common.atoms_count', { n: sbu.atom_indices.length })}</span>
                            {#if sbu_hash}
                              <span class="mof-wl-hash">#{sbu_hash.hash.toString(16).slice(0, 8)}</span>
                            {/if}
                          </button>
                        {/each}
                        {#each linkers as sbu}
                          {@const sbu_hash = wl_hashes?.find(h => h.sbu_index === sbu._idx)}
                          <button class="mof-sbu-row" onclick={() => { selected_sites = [...sbu.atom_indices] }}
                            title={t('structure.click_highlight_atoms', { n: sbu.atom_indices.length })}>
                            <span class="mof-sbu-badge linker">{t('structure.linker')}</span>
                            <span>{sbu.formula || t('common.atoms_count', { n: sbu.atom_indices.length })}</span>
                            {#if sbu_hash}
                              <span class="mof-wl-hash">#{sbu_hash.hash.toString(16).slice(0, 8)}</span>
                            {/if}
                          </button>
                        {/each}
                        {#each ligands as sbu}
                          {@const sbu_hash = wl_hashes?.find(h => h.sbu_index === sbu._idx)}
                          <button class="mof-sbu-row" onclick={() => { selected_sites = [...sbu.atom_indices] }}
                            title={t('structure.click_highlight_atoms', { n: sbu.atom_indices.length })}>
                            <span class="mof-sbu-badge cap">{t('structure.cap')}</span>
                            <span>{sbu.formula || t('common.atoms_count', { n: sbu.atom_indices.length })}</span>
                            {#if sbu_hash}
                              <span class="mof-wl-hash">#{sbu_hash.hash.toString(16).slice(0, 8)}</span>
                            {/if}
                          </button>
                        {/each}
                      </div>

                      <!-- Functional Groups -->
                      {@const func_groups = mof_clusters?.functional_groups ?? []}
                      {#if func_groups.length > 0}
                        <div style="margin-top: 6px">
                          <div style="font-size: 0.8rem; font-weight: 600; margin-bottom: 3px">{t('structure.functional_groups')}</div>
                          {#each func_groups as fg}
                            <button class="mof-sbu-row" onclick={() => { selected_sites = [...fg.atom_indices] }}
                              title={t('structure.click_highlight')}>
                              <span class="mof-sbu-badge func">-{fg.name}</span>
                              <span style="font-size: 0.75rem">{t('structure.on_sbu', { n: fg.parent_sbu })}</span>
                            </button>
                          {/each}
                        </div>
                      {/if}

                      <!-- RAC Descriptors -->
                      <div style="margin-top: 8px">
                        <button class="sym-analyze-btn" onclick={async () => {
                          if (!mof_analysis_result || !mof_clusters || !structure) return
                          rac_loading = true
                          try {
                            rac_result = await compute_rac(structure, mof_analysis_result.bonds_json, mof_clusters)
                          } catch (err) {
                            console.warn('[MOF] RAC failed:', err)
                          } finally {
                            rac_loading = false
                          }
                        }} disabled={rac_loading || !mof_clusters?.is_mof}>
                          {rac_loading ? t('structure.computing_rac') : t('structure.compute_rac')}
                        </button>
                        {#if rac_result}
                          <div class="rac-table-container">
                            <table class="rac-table">
                              <thead><tr><th>{t('common.name')}</th><th>{t('structure.value')}</th></tr></thead>
                              <tbody>
                                {#each rac_result.descriptors.slice(0, 20) as d}
                                  <tr><td>{d.name}</td><td>{d.value.toFixed(4)}</td></tr>
                                {/each}
                              </tbody>
                            </table>
                            {#if rac_result.descriptors.length > 20}
                              <p class="sym-hint">{t('structure.total_descriptors_first20', { n: rac_result.descriptors.length })}</p>
                            {/if}
                            <button class="sym-analyze-btn" style="margin-top: 4px" onclick={() => {
                              if (!rac_result) return
                              const csv = ['name,value', ...rac_result.descriptors.map(d => `${d.name},${d.value}`)].join('\n')
                              const blob = new Blob([csv], { type: 'text/csv' })
                              const url = URL.createObjectURL(blob)
                              const a = document.createElement('a')
                              a.href = url; a.download = 'rac_descriptors.csv'; a.click()
                              URL.revokeObjectURL(url)
                            }}>{t('structure.export_csv')}</button>
                          </div>
                        {/if}
                      </div>

                      <!-- Cap Replacement -->
                      {#if ligands.length > 0}
                        <div style="margin-top: 8px">
                          <div style="font-size: 0.8rem; font-weight: 600; margin-bottom: 3px">{t('structure.replace_caps')}</div>
                          <div style="display: flex; gap: 4px">
                            <input
                              type="text"
                              bind:value={cap_replace_smiles}
                              placeholder={t('structure.smiles_placeholder')}
                              class="mof-smiles-input"
                            />
                            <button class="sym-analyze-btn" disabled={cap_replace_loading || !cap_replace_smiles.trim()}
                              onclick={async () => {
                                if (!mof_analysis_result || !mof_clusters || !structure) return
                                cap_replace_loading = true
                                cap_replace_error = null
                                try {
                                  const resp = await fetch(`${API_BASE}/structure-ops/smiles-to-xyz`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ smiles: cap_replace_smiles }),
                                  })
                                  if (!resp.ok) throw new Error(await resp.text())
                                  const fragment = await resp.json()
                                  const new_struct = await replace_mof_caps(
                                    structure, mof_analysis_result.bonds_json, mof_clusters, fragment,
                                  )
                                  if (new_struct) {
                                    structure = new_struct
                                  } else {
                                    cap_replace_error = t('structure.cap_replacement_failed')
                                  }
                                } catch (err) {
                                  cap_replace_error = err instanceof Error ? err.message : String(err)
                                } finally {
                                  cap_replace_loading = false
                                }
                              }}>
                              {cap_replace_loading ? '...' : t('common.apply')}
                            </button>
                          </div>
                          {#if cap_replace_error}
                            <p class="sym-error">{cap_replace_error}</p>
                          {/if}
                        </div>
                      {/if}
                    {/if}
                  {/if}
                {/if}
              </section>
            {:else if analysis.active_analysis_tab === 'vibration'}
              <FreqAnalysisPane
                on_play_vibration={(data) => {
                  vibration_data = { ...data, playing: true }
                }}
                on_stop_vibration={() => {
                  vibration_data = null
                }}
              />
            {/if}
          </AnalysisPane>

          <WorkflowPane
            bind:show={workflow_pane_open}
            structure={saveable_structure ?? structure}
            {on_open_workflow_editor}
          />

          <IOPane
            bind:show={io_pane_open}
            on_open_file={() => { file_handlers.handle_import_file(); io_pane_open = false }}
            on_paste_content={() => { paste_content_modal_visible = true; io_pane_open = false }}
            on_search_database={() => { optimade_modal_visible = true; io_pane_open = false }}
            {structure}
            {wrapper}
            {scene}
            {camera}
            selected_indices={selected_sites}
            on_request_vacuum_box={() => open_vacuum_box_for_tool('vasp_export')}
            bind:crop_mode_active={interaction.crop_mode_active}
            bind:crop_region={interaction.crop_region}
            {trajectory_context}
            {gpu_supercell_active}
            {gpu_supercell_factors}
            gpu_supercell_base={displayed_structure}
          />

          <ServerPane
            bind:show={server_pane_open}
            bind:external_navigate_path={server_nav_path}
            on_select_job={(sid, jid) => {
              job_detail_session_id = sid
              job_detail_job_id = jid
              job_detail_open = true
            }}
            on_open_terminal={(sid, host, user) => {
              terminal_session_id = sid
              terminal_host = host
              terminal_username = user
              show_terminal = true
              terminal_popped_out = false
              terminal_popped_sync_cwd = false
            }}
            on_load_structure={(content, filename, file_path, sid) => {
              const parsed = parse_any_structure(content, filename)
              if (parsed) {
                structure = parsed
                remote_origin = (file_path && sid) ? { session_id: sid, file_path } : null
                // Close editor/preview panels so the 3D structure is immediately visible
                show_editor = false
                show_preview = false
              }
            }}
            on_open_editor={(content, filename, file_path, sid) => {
              editor_content = content
              editor_filename = filename
              editor_file_path = file_path
              editor_session_id = sid
              show_editor = true
              show_preview = false
            }}
            on_preview_file={(mode, filename, file_path, sid, content, binary_data, mime_type) => {
              preview_mode = mode as typeof preview_mode
              preview_filename = filename
              preview_file_path = file_path
              preview_session_id = sid
              preview_content = content ?? ``
              preview_binary_data = binary_data ?? ``
              preview_mime_type = mime_type ?? ``
              show_preview = true
              show_editor = false
            }}
            on_analyze_report={(content, filename) => {
              // Open SlowGrowthPane and send REPORT content
              slow_growth_pane_open = true
              // Switch to MD analysis tab
              analysis.active_analysis_tab = `md`
              // Dispatch event to SlowGrowthPane with the text content
              window.dispatchEvent(new CustomEvent(`catgo-sg-upload-text`, { detail: { content } }))
            }}
            on_load_trajectory={async (content, filename, remote_origin) => {
              // Route through on_file_load so App.svelte can open in Trajectory viewer
              try {
                const { parse_trajectory_data } = await import('$lib/trajectory/parse')
                const trajectory = await parse_trajectory_data(content, filename)
                if (trajectory && on_file_load) {
                  if (remote_origin) {
                    trajectory.metadata = { ...(trajectory.metadata || {}), remote_origin }
                  }
                  on_file_load({ trajectory, filename } as any)
                } else {
                  // Fallback: parse as structure (last frame only)
                  const parsed = parse_any_structure(content, filename)
                  if (parsed) structure = parsed
                }
              } catch {
                // Fallback: parse as structure
                const parsed = parse_any_structure(content, filename)
                if (parsed) structure = parsed
              }
            }}
          />

          {#if job_detail_session_id && job_detail_job_id}
            <JobDetailPane
              bind:show={job_detail_open}
              session_id={job_detail_session_id}
              job_id={job_detail_job_id}
              on_load_structure={(s) => { structure = s }}
              current_structure={structure}
            />
          {/if}

          <PluginHubPane bind:show={plugin_hub_open} />
        {/if}

        {#if cube_file || cube_state_data.filepath}
          <CubePanel
            bind:pane_open={cube_pane_open}
            {cube_file}
            bind:positive_mesh={cube_positive_mesh}
            bind:negative_mesh={cube_negative_mesh}
            bind:cube_atoms={cube_atoms_data}
            {selected_sites}
            bind:cube_state={cube_state_data}
            onslice_data={(result, atoms) => { slice_result = result; slice_atoms_info = atoms }}
          />
        {/if}

        <!-- === Info / Export / Settings === -->
        {#if enable_info_pane && structure}
          <StructureInfoPane
            {structure}
            bind:pane_open={info_pane_open}
            {selected_sites}
            {symmetry_data}
            {@attach tooltip({ content: `Structure info pane` })}
          />
        {/if}

        <!-- ExportPane is now embedded inside IOPane -->

        <StructureControls
          bind:controls_open
          bind:scene_props
          bind:lattice_props
          bind:show_image_atoms
          bind:image_atom_opacity
          bind:periodic_repeats
          bind:supercell_scaling
          bind:background_color
          bind:background_opacity
          bind:color_scheme
          bind:selection_opacity={sel_state.selection_opacity}
          bind:atom_opacity_overrides={sel_state.atom_opacity_overrides}
          bind:bond_opacity_overrides={sel_state.bond_opacity_overrides}
          {selected_sites}
          selected_bonds={pencil.selected_bonds}
          {structure}
          bind:bond_distance_rules
          bind:large_system_mode
          {supercell_loading}
          closed_icon="Sliders"
        />
    </StructureToolbar>

    <AtomLegend
      bind:atom_color_config
      {property_colors}
      {coordination_computing}
      elements={get_elem_amounts(supercell_structure ?? structure!)}
      {hidden_elements}
      on_hidden_elements_change={(set) => { hidden_elements = set }}
      bind:hidden_prop_vals
      bind:element_mapping
      bind:element_radius_overrides
      bind:site_radius_overrides
      {selected_sites}
      structure={displayed_structure}
      sym_data={symmetry_data}
    >
      {#if structure && `lattice` in structure}
        <CellSelect
          bind:supercell_scaling
          bind:cell_type
          sym_data={symmetry_data}
          loading={supercell_loading}
          direction="up"
          {large_system_mode}
          base_site_count={structure?.sites?.length ?? 0}
        />
      {/if}
    </AtomLegend>

    <!-- prevent from rendering in vitest runner since WebGLRenderingContext not available -->
    {#if typeof WebGLRenderingContext !== `undefined`}
      <!-- Gesture control overlay -->
      {#if gesture_active}
        <GestureProvider
          config={gesture_config}
          art_mode={gesture_art_mode}
          ongesture={on_gesture}
          onvoice={on_voice}
          on_ai_query={on_voice_ai_query}
          ondisable={() => { gesture_active = false; gesture_config = { ...gesture_config, enabled: false } }}
        >
          <GestureOverlay container_el={wrapper} />
        </GestureProvider>
      {/if}

      <!-- prevent HTML labels from rendering outside of the canvas -->
      <div style="overflow: hidden; height: 100%; position: relative; z-index: 0; pointer-events: none">
        <div style="width: 100%; height: 100%; pointer-events: auto; position: relative">
        <!--
          autoRender is paused while large-system mode is ON: the WebGPU overlay
          fully covers this WebGL canvas, so letting Threlte keep repainting the
          whole scene every invalidate (each trajectory frame) just doubles GPU
          load → lag. autoRender=false stops the WebGL PAINTS only; OrbitControls
          still update the shared camera object the overlay reads, so camera
          interaction keeps working under the overlay. Toggling the mode OFF
          restores autoRender=true and an $effect below nudges a one-shot repaint
          so the WebGL view isn't left on a stale/blank frame.
        -->
        <Canvas autoRender={!large_system_mode} {...{ rendererParameters: { antialias: true, powerPreference: `high-performance` } } as any}>
          <!--
            show_image_atoms is a separate bindable from scene_props.show_image_atoms
            (the UI checkbox binds to the local one). It must be passed AFTER the
            scene_props spread so the user's toggle actually reaches sites_to_draw
            in the bond renderer; otherwise scene_props' default true overrides it
            and orphan cross-cell bond stubs render with image atoms off.
          -->
          <StructureScene
            structure={displayed_structure}
            bond_input_structure={supercell_structure ?? structure}
            {webgl_suspended}
            {trajectory_frame_positions}
            {trajectory_frame_forces}
            trajectory_bond_connectivity={trajectory_bond_connectivity_for_frame}
            {...scene_props}
            {show_image_atoms}
            {clip_center}
            {mof_clusters}
            {isolated_node_atoms}
            background_color={background_color}
            {background_opacity}
            {element_radius_overrides}
            {site_radius_overrides}
            {site_color_overrides}
            {lattice_props}
            bind:camera_is_moving
            bind:selected_sites
            bind:measured_sites
            measurements={meas_state.measurements}
            bind:selected_measurement_id={meas_state.selected_measurement_id}
            bind:scene
            bind:camera
            bind:pixels_per_angstrom
            bind:orbit_controls
            bind:rotation_target_ref
            bind:initial_computed_zoom
            {hidden_elements}
            {hidden_sites}
            {bond_distance_rules}
            measure_mode={meas_state.measure_mode}
            measure_mode_active={meas_state.measure_mode_active}
            on_continuous_measure_click={(site_idx: number) => {
              // Add site to continuous measurement
              if (!meas_state.current_continuous_measurement_sites.includes(site_idx)) {
                meas_state.current_continuous_measurement_sites = [...meas_state.current_continuous_measurement_sites, site_idx]
                // Auto-create measurement when we have enough sites
                const min_sites = meas_state.measure_mode === 'dihedral' ? 4 : meas_state.measure_mode === 'angle' ? 3 : 2
                if (meas_state.current_continuous_measurement_sites.length >= min_sites) {
                  const new_measurement: Measurement = {
                    id: `meas_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    type: meas_state.measure_mode,
                    sites: [...meas_state.current_continuous_measurement_sites]
                  }
                  meas_state.measurements = [...meas_state.measurements, new_measurement]
                  // Completely reset for fresh measurement (no chaining)
                  meas_state.current_continuous_measurement_sites = []
                }
              } else {
                // Clicking same site removes it
                meas_state.current_continuous_measurement_sites = meas_state.current_continuous_measurement_sites.filter(idx => idx !== site_idx)
              }
            }}
            {width}
            {height}
            axis_lock_active={interaction.axis_lock_key !== null}
            {hovered}
            frozen_rotation_target={cached_rotation_target}
            {center_camera_trigger}
            bind:lattice_align_trigger
            {reset_camera_up_trigger}
            repaint_trigger={webgl_repaint_trigger}
            external_dragging={interaction.is_dragging_atom || interaction.is_rotating_atoms}
            is_box_selecting={interaction.is_box_selecting}
            is_rotating_atoms={interaction.is_rotating_atoms}
            is_dragging_atom={interaction.is_dragging_atom}
            atom_rotation_center={interaction.atom_rotation_center}
            atom_rotation_axis={interaction.atom_rotation_axis}
            atom_rotation_angle_deg={interaction.atom_rotation_angle_deg}
            realtime_position_overrides={interaction.realtime_position_overrides}
            on_reset_rotation={() => {
              scene_props.rotation = [...lattice_alignment_rotation] as Vec3
            }}
            on_atom_context_menu={interaction.on_atom_context_menu}
            active_sites={meas_state.measure_mode_active ? meas_state.current_continuous_measurement_sites : []}
            cutting_active={build.cutting_active}
            cutting_plane_normal={build.cutting_plane_normal}
            cutting_plane_offset={build.cutting_plane_offset}
            cutting_plane_thickness={build.cutting_plane_thickness}
            cutting_atom_visibility={build.cutting_atom_visibility}
            cutting_flash_intensity={build.cutting_flash_intensity}
            cutting_miller_label={build.cutting_miller_label}
            cutting_slab_preview={build.cutting_slab_preview}
            cutting_preview_mode={build.cutting_preview_mode}
            cutting_show_bonds={build.cutting_show_bonds}
            {property_colors}
            {hidden_prop_vals}
            adsorption_sites={build.adsorption_sites}
            show_adsorption_sites={build.show_adsorption_sites}
            bind:selected_adsorption_site_idx={build.selected_adsorption_site_idx}
            on_delete_adsorption_site={build.delete_adsorption_site_fn}
            adsorption_site_placement_mode={build.adsorbate_placement_mode_active}
            on_adsorption_site_click={build.adsorbate_placement_mode_active
              ? (idx) => {
                  const site = build.adsorption_sites[idx]
                  if (site) build.adsorbate_placement_ref?.handle_site_click(site)
                }
              : undefined}
            pencil_mode_active={pencil.pencil_mode_active}
            pencil_ghost_atom={pencil.pencil_ghost_atom}
            on_pencil_atom_click={pencil.pencil_add_mode === 'bonds' ? undefined : pencil.handle_pencil_atom_click}
            bond_mode_active={pencil.pencil_mode_active && pencil.pencil_add_mode === 'bonds'}
            manual_bonds={pencil.manual_bonds}
            bond_manager={pencil.bond_manager}
            bind:atom_fast_ops={scene_atom_fast_ops}
            bind:atom_manager={scene_atom_manager}
            bind:get_displayed_frame_positions={scene_get_displayed_frame_positions}
            deleted_bond_keys={pencil.deleted_bond_keys}
            bind:selected_bonds={pencil.selected_bonds}
            bond_first_atom={pencil.bond_first_atom}
            on_bond_atom_click={pencil.handle_bond_atom_click}
            on_bond_drag_start={pencil.handle_bond_drag_start}
            on_bond_drag_end={pencil.handle_bond_drag_end}
            bond_drag_active={pencil.bond_drag_active}
            bond_ghost_end={pencil.bond_ghost_end}
            on_bond_select={pencil.handle_bond_select}
            bind:filtered_bond_pairs_out={pencil.scene_bond_pairs}

            bind:selection_opacity={sel_state.selection_opacity}
            atom_opacity_overrides={sel_state.atom_opacity_overrides}
            bond_opacity_overrides={sel_state.bond_opacity_overrides}
            {image_atom_opacity}
            num_original_sites={(displayed_structure as AnyStructure & { num_original_sites?: number })?.num_original_sites}
            image_to_original_map={(displayed_structure as AnyStructure & { image_to_original_map?: number[] })?.image_to_original_map}
            visible_charge_labels={charge_state.visible_charge_labels}
            show_charge_labels={atom_color_config.mode === `charge` || charge_state.visible_charge_labels.size > 0}
            charge_label_offsets={charge_state.charge_label_offsets}
            charge_label_colors={charge_state.charge_label_colors}
            on_charge_label_offset_change={(idx, offset) => {
              charge_state.charge_label_offsets.set(idx, offset)
            }}
            on_charge_value_edit={(idx, value) => {
              if (!structure) return
              push_to_undo()
              const new_sites = structure.sites.map((site, i) => {
                if (i === idx) return { ...site, properties: { ...site.properties, bader_charge: value } }
                return site
              })
              structure = { ...structure, sites: new_sites }
            }}
            on_charge_label_remove={(idx) => {
              charge_state.visible_charge_labels = new Set([...charge_state.visible_charge_labels].filter(i => i !== idx))
            }}
            on_charge_label_contextmenu={(idx, x, y) => {
              charge_state.charge_color_menu = { idx, x, y }
            }}
            {vibration_data}
            cube_positive_mesh={cube_positive_mesh}
            cube_negative_mesh={cube_negative_mesh}
            cube_show_positive={cube_state_data.show_positive}
            cube_show_negative={cube_state_data.show_negative}
            cube_positive_color={cube_state_data.positive_color}
            cube_negative_color={cube_state_data.negative_color}
            cube_opacity={cube_state_data.opacity}
            cube_wireframe={cube_state_data.wireframe}
            cube_slice_normal={cube_slice_effective_normal}
            cube_slice_center={cube_slice_effective_center}
            cube_show_slice_plane={cube_state_data.slice_plane.show_plane}
            {cube_slice_plane_size}
            cube_slice_color={cube_state_data.slice_plane.plane_color}
          />
        </Canvas>
        <!--
          Task 9: WebGPU large-system render overlay. A plain DOM canvas sibling
          of the Threlte <Canvas> (NOT inside it). Gated by large_system_mode —
          when off, {#if enabled} renders nothing and the WebGL path is untouched.
          When on, it's absolutely positioned over the Canvas (z-index 1) and its
          opaque clear pass covers the WebGL canvas underneath.
        -->
        <div style="position: absolute; inset: 0; z-index: 1; pointer-events: none">
          <LargeSystemOverlay
            enabled={large_system_mode}
            {camera}
            structure={displayed_structure}
            supercell={gpu_supercell_active ? gpu_supercell_factors : [1, 1, 1]}
            {show_image_atoms}
            element_colors={colors.element}
            atom_radius={scene_props.atom_radius}
            same_size_atoms={scene_props.same_size_atoms}
            {element_radius_overrides}
            {site_radius_overrides}
            bonding_options={(scene_props.bonding_options ?? {}) as Record<string, number>}
            {bond_distance_rules}
            show_bonds={scene_props.show_bonds}
            {background_color}
            {background_opacity}
            show_cell={scene_props.show_cell}
            cell_edge_color={scene_props.cell_edge_color}
            {trajectory_positions_version}
            {trajectory_step_idx}
            get_displayed_frame_positions={scene_get_displayed_frame_positions}
            selected_sites={overlay_selected_displayed}
            on_pick={handle_overlay_pick}
            on_fallback={(reason) => {
              large_system_mode = false
              console.warn(`[CatGO] large-system mode: ${reason}`)
            }}
          />
        </div>
        </div>
        <ScaleBar {pixels_per_angstrom} show={scene_props.show_scale_bar ?? false} />
      </div>
    {/if}

    <div class="bottom-left">
      {@render bottom_left?.({ structure: displayed_structure })}
    </div>

    {#if interaction.axis_lock_key}
      {@const axis_colors = { x: 'red', y: 'green', z: 'blue' }}
      <div class="axis-lock-indicator" style:color={axis_colors[interaction.axis_lock_key]}>
        Rotating on {interaction.axis_lock_key.toUpperCase()}-axis
      </div>
    {/if}

    {#if atom_clipboard.sites}
      <div class="clipboard-indicator">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1"/>
        </svg>
        <span>{atom_clipboard.sites.length} atoms copied</span>
        <button class="clipboard-dismiss" onclick={() => { atom_clipboard.sites = null; atom_clipboard.paste_count = 0 }} title={t('structure.clear_clipboard')}>&times;</button>
      </div>
    {/if}

    {#if analysis.symmetry_error}
      <div class="symmetry-error">
        <span>{analysis.symmetry_error}</span>
        <button onclick={analysis.dismiss_symmetry_error} aria-label="Dismiss">
          ×
        </button>
      </div>
    {/if}

    <!-- Context Menu for atom manipulation (inside structure div so it's positioned relative to viewer) -->
    <ContextMenu
      visible={context_menu_visible}
      position={context_menu_position}
      on_close={() => {
        context_menu_visible = false
      }}
      on_select={(section: string, option: { value: string }) => {
        if (option.value === `clip_here` && context_menu_target_site !== null) {
          const site = displayed_structure?.sites[context_menu_target_site]
          if (site?.xyz) {
            clip_center = site.xyz as [number, number, number]
            scene_props.clip_active = true
          }
          context_menu_visible = false
          return
        }
        if (option.value === `clip_clear`) {
          scene_props.clip_active = false
          clip_center = null
          context_menu_visible = false
          return
        }
        if (option.value === `isolate_node` && context_menu_target_site !== null && mof_clusters) {
          isolated_node_atoms = get_isolated_node_atoms(
            context_menu_target_site, mof_clusters, pencil.scene_bond_pairs ?? [],
          )
          context_menu_visible = false
          return
        }
        if (option.value === `clear_isolation`) {
          isolated_node_atoms = null
          context_menu_visible = false
          return
        }
        ctx_menu.handle_select(section, option)
      }}
      sections={[
        {
          id: `Add Atom`,
          title: t('structure.add_atom_section'),
          options: [
            {
              value: `add`,
              label: t('structure.add_atom_label', { elem: selected_add_element }),
              icon: `Atom`,
              disabled: !context_menu_3d_position,
            },
          ],
        },
        {
          id: `Selection`,
          title: t('structure.selection_section'),
          options: [
            ...unique_elements.map((el) => ({
              value: `select_element_${el}`,
              label: t('structure.select_all_elem', { elem: el }),
            })),
            {
              value: 'select_all',
              label: t('common.select_all'),
              disabled: !structure?.sites?.length,
            },
            {
              value: 'Invert',
              label: t('structure.invert_selection'),
              icon: 'Reset',
              disabled: !structure?.sites?.length,
            },
            {
              value: 'clear',
              label: t('structure.clear_selection'),
              disabled: selected_sites.length === 0,
            },
          ],
        },
        {
          id: `Edit Atoms`,
          title: t('structure.edit_atoms'),
          options: [
            {
              value: `replace`,
              label: context_menu_target_site !== null
                ? t('structure.replace_with_elem', { elem: selected_add_element })
                : selected_sites.length > 0
                ? t('structure.replace_selected_with_elem', { n: selected_sites.length, elem: selected_add_element })
                : t('structure.replace_with_elem', { elem: selected_add_element }),
              icon: `Reset`,
              disabled: context_menu_target_site === null && selected_sites.length === 0,
            },
            {
              value: `delete`,
              label: context_menu_target_site !== null
                ? t('structure.delete_atom')
                : selected_sites.length > 0
                ? t('structure.delete_selected', { n: selected_sites.length })
                : t('structure.delete_atom'),
              icon: `Close`,
              disabled: context_menu_target_site === null &&
                selected_sites.length === 0,
            },
            {
              value: `hide`,
              label: context_menu_target_site !== null
                ? t('structure.hide_atom')
                : selected_sites.length > 0
                ? t('structure.hide_selected', { n: selected_sites.length })
                : t('structure.hide_atom'),
              disabled: context_menu_target_site === null &&
                selected_sites.length === 0,
            },
            {
              value: `show_all`,
              label: t('structure.show_all_atoms'),
              disabled: hidden_sites.size === 0,
            },
          ],
        },
        ...ctx_constraints_section,
        ...ctx_charge_label_section,
        {
          id: `Atom Color`,
          title: t('structure.atom_color'),
          options: [
            {
              value: `set_color`,
              label: context_menu_target_site !== null
                ? t('structure.set_color')
                : selected_sites.length > 0
                ? t('structure.set_color_selected', { n: selected_sites.length })
                : t('structure.set_color'),
              disabled: context_menu_target_site === null && selected_sites.length === 0,
            },
            {
              value: `reset_color`,
              label: context_menu_target_site !== null
                ? t('structure.reset_color')
                : selected_sites.length > 0
                ? t('structure.reset_color_selected', { n: selected_sites.length })
                : t('structure.reset_color'),
              disabled: context_menu_target_site === null && selected_sites.length === 0,
            },
            {
              value: `reset_all_colors`,
              label: t('structure.reset_all_colors'),
              disabled: site_color_overrides.size === 0,
            },
          ],
        },
        {
          id: `Defect Atom`,
          title: t('structure.defect_atom'),
          options: [
            {
              value: `toggle_ghost`,
              label: ghost_toggle_label,
              disabled: context_menu_target_site === null && selected_sites.length === 0,
            },
            {
              value: `clear_all_ghosts`,
              label: t('structure.clear_all_ghosts'),
              disabled: ghost_atom_indices.size === 0,
            },
          ],
        },
        {
          id: `Import`,
          title: t('common.import'),
          options: [
            {
              value: 'import_molecule',
              label: t('structure.import_molecule_here'),
              icon: 'Plus',
              disabled: !context_menu_3d_position || !structure,
            },
            {
              value: 'load_charges',
              label: t('structure.load_charges_acf'),
              disabled: !structure,
            },
          ],
        },
        {
          title: t('structure.clipping'),
          options: [
            {
              value: `clip_here`,
              label: t('structure.clip_around_atom'),
              disabled: context_menu_target_site === null,
            },
            {
              value: `clip_clear`,
              label: t('structure.clear_clipping'),
              disabled: !scene_props.clip_active,
            },
          ],
        },
        ...(mof_clusters?.is_mof ? [{
          title: `MOF`,
          options: [
            {
              value: `isolate_node`,
              label: t('structure.isolate_node'),
              disabled: context_menu_target_site === null,
            },
            {
              value: `clear_isolation`,
              label: t('structure.clear_isolation'),
              disabled: !isolated_node_atoms,
            },
          ],
        }] : []),
        // [2025-02] "Save to project" section — only shown when desktop app provides callback
        ...((on_save_to_project || on_save_to_database || on_export_to_hpc || on_export_to_file || on_edit_as_text) ? [{ // Save / Export section
          title: t('structure.save_export'),
          options: [
            ...(on_save_to_database ?? on_save_to_project ? [{
              value: on_save_to_database ? 'save_to_database' : 'save_to_project',
              label: t('structure.save_to_catgo_database'),
              disabled: !structure,
            }] : []),
            ...(on_export_to_hpc ? [{
              value: 'export_to_hpc',
              label: t('structure.export_to_hpc'),
              disabled: !structure,
            }] : []),
            ...(on_export_to_file ? [{
              value: 'export_to_file',
              label: t('structure.export_to_local_computer'),
              disabled: !structure,
            }] : []),
            ...(on_edit_as_text ? [{
              value: 'edit_as_text',
              label: t('structure.edit_as_text'),
              disabled: !structure,
            }] : []),
          ],
        }] : []),
      ]}
    />

    <!-- Element selector for add/replace operations -->
    {#if context_menu_visible}
      {@const selector_top = `${context_menu_position.y}px`}
      {@const selector_left = `${context_menu_position.x + 180}px`}
      <div class="element-selector" style:top={selector_top} style:left={selector_left}>
        <div class="element-selector-header">{t('structure.select_element')}</div>
        <div class="element-grid">
          {#each elem_symbols as element}
            <button
              class="element-btn"
              class:selected={element === selected_add_element}
              onclick={() => {
                selected_add_element = element
              }}
            >
              {element}
            </button>
          {/each}
        </div>
      </div>
    {/if}

  {:else if structure}
    <div class="empty-structure-state">
      <p>{t('structure.no_atoms_in_structure')}</p>
      <div class="empty-actions">
        <button class="empty-action-btn" onclick={() => { if (on_clear_structure) on_clear_structure(); else structure = undefined }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          {t('structure.import_new')}
        </button>
        <button class="empty-action-btn" onclick={() => undo()} disabled={!sel_state.can_undo}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 10h13a4 4 0 010 8H7"/>
            <path d="M3 10l4-4M3 10l4 4"/>
          </svg>
          {t('common.undo')}
        </button>
      </div>
    </div>
  {:else}
    <p class="warn">{t('structure.no_structure_provided')}</p>
  {/if}

  <!-- Hidden file input for molecule import -->
  <input
    type="file"
    accept=".poscar,.vasp,.xyz,.cif,.json,.yaml,.yml,.gz,.xz,.bz2,.cube,.cub,.data,.lammps"
    style="display: none;"
    bind:this={molecule_import_input}
    onchange={handle_molecule_import}
  />

  <!-- Hidden file input for charge data import -->
  <input
    type="file"
    accept=".dat"
    style="display: none;"
    bind:this={charges_import_input}
    onchange={handle_charges_import}
  />

  <!-- Color input for per-atom color override. Must satisfy 3 constraints
       to actually open the native picker via programmatic .click():
       1. NOT display:none — picker refuses to open on hidden inputs
       2. NOT off-viewport (e.g. left:-9999px) — Tauri webview / Chromium
          refuses to open native picker for off-screen elements (this was
          the bug: input was at -9999px so .click() returned without
          opening the picker)
       3. Stays visually invisible to the user
       Solution: position fixed at viewport corner with 1px size and
       opacity 0. Element is "on-screen" enough for the browser/webview
       to allow the picker dialog, but invisible to the user. -->
  <input
    type="color"
    style="position: fixed; opacity: 0; width: 1px; height: 1px; left: 0; top: 0; border: 0; padding: 0; margin: 0; z-index: -1;"
    aria-hidden="true"
    tabindex="-1"
    bind:this={color_picker_input}
    oninput={(e) => {
      // `input` event fires continuously as user drags the picker
      // slider — gives live preview while the dialog is still open.
      // Some webviews (Tauri / WebKit) only fire `change` on dismiss,
      // so without this the user sees no feedback during selection.
      const hex = (e.target as HTMLInputElement).value
      console.log(`[Color picker input]`, hex, `targets=`, [...sel_state.color_picker_targets])
      for (const idx of sel_state.color_picker_targets) {
        site_color_overrides.set(idx, hex)
      }
    }}
    onchange={(e) => {
      const hex = (e.target as HTMLInputElement).value
      console.log(`[Color picker change]`, hex, `targets=`, [...sel_state.color_picker_targets])
      for (const idx of sel_state.color_picker_targets) {
        site_color_overrides.set(idx, hex)
      }
      sel_state.color_picker_targets = []
    }}
  />

  <!-- OPTIMADE search modal -->
  <OptimadeSearchModal
    visible={optimade_modal_visible}
    onclose={() => (optimade_modal_visible = false)}
    onimport={handle_optimade_import}
    onpreview={handle_optimade_preview}
    onpubchem_preview={handle_pubchem_preview}
  />

  <!-- Database import preview modal (OPTIMADE / PubChem / etc.) -->
  <OptimadePreviewModal
    visible={optimade_preview_visible}
    onclose={cancel_optimade_import}
    onconfirm={confirm_optimade_import}
    pymatgen_structure={optimade_pending_pymatgen}
    title={optimade_preview_title}
    formula={optimade_preview_formula}
    details={optimade_preview_details}
    lattice_params={optimade_preview_lattice}
  />

  <!-- Paste content modal -->
  <PasteContentModal
    visible={paste_content_modal_visible}
    onclose={() => (paste_content_modal_visible = false)}
    onimport={handle_paste_content_import}
  />

  <!-- Vacuum box modal -->
  <VacuumBoxModal
    visible={vacuum_box_modal_visible}
    molecule={is_molecule ? structure as PymatgenMolecule : null}
    onclose={() => { vacuum_box_modal_visible = false; pending_tool_after_wrap = null }}
    onwrap={handle_vacuum_box_wrap}
  />

  <!-- Periodic table modal for element selection in pencil mode -->
  {#if periodic_table_visible}
    <div class="periodic-table-modal-overlay" onclick={() => periodic_table_visible = false}>
      <div class="periodic-table-modal" onclick={(e) => e.stopPropagation()}>
        <div class="periodic-table-modal-header">
          <h3>{t('structure.select_element')}</h3>
          <button
            type="button"
            class="close-btn"
            onclick={() => periodic_table_visible = false}
            aria-label="Close"
          >
            <Icon icon="Close" />
          </button>
        </div>
        <div class="periodic-table-modal-content">
          <PeriodicTable
            active_element={element_data.find(el => el.symbol === selected_add_element) ?? null}
            tile_props={{
              show_name: false,
              show_number: true,
              onclick: ({ element }) => {
                selected_add_element = element.symbol as ElementSymbol
                periodic_table_visible = false
              }
            }}
            show_color_bar={false}
            onenter={(element) => {
              selected_add_element = element.symbol as ElementSymbol
              periodic_table_visible = false
            }}
          />
        </div>
        <div class="periodic-table-modal-footer">
          <span class="selected-element-display">
            {t('structure.selected_elem', { elem: selected_add_element })}
          </span>
        </div>
      </div>
    </div>
  {/if}
  <!-- Charge label color picker popup (right-click on a charge label) -->
  {#if charge_state.charge_color_menu}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="charge-color-overlay" onclick={() => charge_state.charge_color_menu = null}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="charge-color-popup"
        style:left="{charge_state.charge_color_menu.x}px"
        style:top="{charge_state.charge_color_menu.y}px"
        onclick={(e) => e.stopPropagation()}
      >
        <div class="charge-color-row">
          <span class="charge-color-label">{t('structure.text')}</span>
          <input
            type="color"
            value={(charge_state.charge_label_colors.get(charge_state.charge_color_menu.idx) ?? {}).text || `#9e9e9e`}
            oninput={(e) => {
              const val = (e.target as HTMLInputElement).value
              const idx = charge_state.charge_color_menu!.idx
              const updated = new Map(charge_state.charge_label_colors)
              updated.set(idx, { ...updated.get(idx), text: val })
              charge_state.charge_label_colors = updated
            }}
          />
        </div>
        <div class="charge-color-row">
          <span class="charge-color-label">{t('structure.background_label')}</span>
          <input
            type="color"
            value={(charge_state.charge_label_colors.get(charge_state.charge_color_menu.idx) ?? {}).bg || `#14141e`}
            oninput={(e) => {
              const val = (e.target as HTMLInputElement).value
              const idx = charge_state.charge_color_menu!.idx
              const updated = new Map(charge_state.charge_label_colors)
              updated.set(idx, { ...updated.get(idx), bg: val })
              charge_state.charge_label_colors = updated
            }}
          />
        </div>
        <button
          class="charge-color-reset"
          onclick={() => {
            const idx = charge_state.charge_color_menu!.idx
            const updated = new Map(charge_state.charge_label_colors)
            updated.delete(idx)
            charge_state.charge_label_colors = updated
            charge_state.charge_color_menu = null
          }}
        >{t('structure.reset_colors')}</button>
        <button
          class="charge-color-reset charge-color-remove"
          onclick={() => {
            const idx = charge_state.charge_color_menu!.idx
            charge_state.visible_charge_labels = new Set([...charge_state.visible_charge_labels].filter(i => i !== idx))
            const updated = new Map(charge_state.charge_label_colors)
            updated.delete(idx)
            charge_state.charge_label_colors = updated
            charge_state.charge_color_menu = null
          }}
        >{t('structure.remove_label')}</button>
      </div>
    </div>
  {/if}

  </div><!-- .structure-main -->

  <!-- Voice & Gesture settings (outside structure-main to avoid overflow clip in split views) -->
  {#if gesture_active}
    <GestureSettingsPane bind:config={gesture_config} bind:pane_open={show_gesture_settings} />
  {/if}

  <!-- AI Chat Panel (split view) -->
  {#if chat_pane_open && chat_position.value === `right`}
    <div
      class="chat-resize-handle"
      class:active={is_chat_resizing}
      onpointerdown={start_chat_resize}
    ></div>
    <ChatPane
      {tab_id}
      {structure}
      {symmetry_data}
      {selected_sites}
      on_close={() => { chat_pane_open = false }}
      on_popout={popout_chat}
    />
  {:else if chat_pane_open && chat_position.value === `bottom`}
    <div
      class="chat-resize-handle-bottom"
      class:active={is_chat_resizing}
      onpointerdown={start_chat_bottom_resize}
    ></div>
    <ChatPane
      {tab_id}
      {structure}
      {symmetry_data}
      {selected_sites}
      on_close={() => { chat_pane_open = false }}
      on_popout={popout_chat}
    />
  {/if}

  <!-- MD Plot Panel (split view) -->
  {#if show_md_panel}
    <div class="md-panel">
      <div class="md-panel-header">
        <span class="md-panel-title">{md_plot_data?.title || t('structure.md_analysis')}</span>
        <div class="md-panel-controls">
          <button
            class="md-settings-btn"
            class:active={md_settings_open}
            title={t('structure.plot_settings')}
            onclick={() => md_settings_open = !md_settings_open}
          >&#9881;</button>
          <button
            class="md-layout-btn"
            title={t('structure.toggle_hv_layout')}
            onclick={() => md_layout = md_layout === `horizontal` ? `vertical` : `horizontal`}
          >
            {md_layout === `horizontal` ? `\u2194` : `\u2195`}
          </button>
          <button
            class="md-close-btn"
            title={t('structure.close_panel_label', { name: 'MD' })}
            onclick={() => md_plot_data = null}
          >&times;</button>
        </div>
      </div>
      {#if md_settings_open}
        <div class="md-settings-bar">
          <label class="md-setting">
            <span>X</span>
            <input type="text" bind:value={md_x_label} placeholder={t('structure.x_label')} />
          </label>
          <label class="md-setting">
            <span>Y</span>
            <input type="text" bind:value={md_y_label} placeholder={t('structure.y_label')} />
          </label>
          <label class="md-setting md-checkbox">
            <input type="checkbox" bind:checked={md_show_gridlines} />
            <span>{t('structure.grid')}</span>
          </label>
          <label class="md-setting md-checkbox">
            <input type="checkbox" bind:checked={md_show_legend} />
            <span>{t('structure.legend')}</span>
          </label>
        </div>
      {/if}
      <div class="md-plot-area">
        <MdPlot
          traces={md_plot_data?.traces || []}
          title=""
          x_label={md_x_label}
          y_label={md_y_label}
          show_gridlines={md_show_gridlines}
          legend_visible={md_show_legend}
          layout_overrides={md_plot_data?.layout_overrides || {}}
        />
      </div>
    </div>
  {/if}

  <!-- DOS Plot Panel (split view, like Trajectory layout) -->
  {#if show_dos_panel && dos_state.dos_result}
    <div class="dos-panel">
      <div class="dos-panel-header">
        <span class="dos-panel-title">DOS</span>
        <div class="dos-panel-controls">
          <button
            class="dos-layout-btn"
            title={t('structure.toggle_hv_layout')}
            onclick={() => dos_layout = dos_layout === `horizontal` ? `vertical` : `horizontal`}
          >
            {dos_layout === `horizontal` ? `\u2194` : `\u2195`}
          </button>
          <button class="dos-export-btn" onclick={async () => { if (dos_plot_ref) { const url = await dos_plot_ref.export_image(`png`); if (url) { const a = document.createElement(`a`); a.href = url; a.download = `dos_plot.png`; a.click() } } }}>PNG</button>
          <button class="dos-export-btn" onclick={async () => { if (dos_plot_ref) { const url = await dos_plot_ref.export_image(`svg`); if (url) { const a = document.createElement(`a`); a.href = url; a.download = `dos_plot.svg`; a.click() } } }}>SVG</button>
          <button class="dos-export-btn" onclick={() => { if (dos_plot_ref) { const csv = dos_plot_ref.export_csv(); if (csv) { const blob = new Blob([csv], { type: `text/csv` }); const url = URL.createObjectURL(blob); const a = document.createElement(`a`); a.href = url; a.download = `dos_data.csv`; a.click(); URL.revokeObjectURL(url) } } }}>CSV</button>
          <button
            class="dos-close-btn"
            title={t('structure.close_panel_label', { name: 'DOS' })}
            onclick={() => { dos_state.dos_result = null; dos_state.dband_result = null }}
          >&times;</button>
        </div>
      </div>
      <div class="dos-plot-area">
        <DosPlot
          bind:this={dos_plot_ref}
          grid={dos_state.dos_result.grid}
          series={dos_state.dos_result.series}
          efermi={dos_state.dos_result.efermi}
          show_fermi_line={dos_state.show_fermi_line}
          show_fill={dos_state.show_fill}
          show_spin_down={dos_state.show_spin_down}
          orientation={dos_state.orientation}
          x_range={dos_state.x_range}
          y_range={dos_state.y_range}
          dband_center_line={dband_center_for_plot}
          line_styles={dos_state.line_styles}
          show_gridlines={dos_state.show_gridlines}
          show_axis_lines={dos_state.show_axis_lines}
          axis_line_width={dos_state.axis_line_width}
          tick_length={dos_state.tick_length}
          tick_width={dos_state.tick_width}
          legend_visible={dos_state.legend_visible}
          hidden_series={dos_state.hidden_series}
        />
      </div>
    </div>
  {/if}

  {#if xrd.show_panel}
    <div class="xrd-panel" class:vertical={xrd.layout === `vertical`}>
      <div class="xrd-panel-header">
        <span class="xrd-panel-title">{xrd.pinned_patterns.length > 0 ? t('structure.xrd_pattern_series', { n: xrd.bar_series.length }) : t('structure.xrd_pattern')}</span>
        <div class="xrd-panel-actions">
          <button
            class="xrd-layout-btn"
            onclick={xrd.toggle_layout}
            title={t('structure.toggle_hv_layout')}
          >
            {xrd.layout === `horizontal` ? `\u2B82` : `\u2B81`}
          </button>
          <button
            class="xrd-close-btn"
            onclick={() => { analysis.active_analysis_tab = `electronic` }}
            title={t('structure.close_panel_label', { name: 'XRD' })}
          >
            <Icon icon="Close" />
          </button>
        </div>
      </div>
      <div class="xrd-plot-area">
        {#snippet tooltip(info: BarHandlerProps)}
          {@const series_label = info.metadata?.series_label as string | undefined}
          {@const hkls = info.metadata?.hkls as Hkl[] | undefined}
          {@const d = info.metadata?.d as number | undefined}
          {#if series_label}<strong>{series_label}</strong><br />{/if}
          2&#952;: {format_value(info.x, `.2f`)}°<br />
          Intensity: {format_value(info.y, `.1f`)}
          {#if hkls && hkls.length > 0}<br />hkl: {hkls.map(format_hkl).join(`, `)}{/if}
          {#if d != null}<br />d: {format_value(d, `.3f`)} &#197;{/if}
        {/snippet}

        <BarPlot
          series={xrd.bar_series}
          x_axis={{
            label: t('structure.two_theta_degrees'),
            label_shift: { y: 12 },
            range: xrd.angle_range,
          }}
          y_axis={{
            label: t('structure.intensity_au'),
            label_shift: { x: 2 },
            range: [0, 100],
          }}
          {tooltip}
          show_controls={false}
          show_legend={false}
          style="height: 100%; width: 100%; overflow: visible; --barplot-min-height: 0;"
        />
      </div>
    </div>
  {/if}

  <!-- COHP Plot Panel (split view, same pattern as DOS) -->
  {#if show_cohp_panel && cohp_state.cohp_result}
    <div class="dos-panel">
      <div class="dos-panel-header">
        <span class="dos-panel-title">COHP</span>
        <div class="dos-panel-controls">
          <button
            class="dos-layout-btn"
            title={t('structure.toggle_hv_layout')}
            onclick={() => cohp_layout = cohp_layout === `horizontal` ? `vertical` : `horizontal`}
          >
            {cohp_layout === `horizontal` ? `\u2194` : `\u2195`}
          </button>
          <button class="dos-export-btn" onclick={async () => { if (cohp_plot_ref) { const url = await cohp_plot_ref.export_image(`png`); if (url) { const a = document.createElement(`a`); a.href = url; a.download = `cohp_plot.png`; a.click() } } }}>PNG</button>
          <button class="dos-export-btn" onclick={async () => { if (cohp_plot_ref) { const url = await cohp_plot_ref.export_image(`svg`); if (url) { const a = document.createElement(`a`); a.href = url; a.download = `cohp_plot.svg`; a.click() } } }}>SVG</button>
          <button class="dos-export-btn" onclick={() => { if (cohp_plot_ref) { const csv = cohp_plot_ref.export_csv(); if (csv) { const blob = new Blob([csv], { type: `text/csv` }); const url = URL.createObjectURL(blob); const a = document.createElement(`a`); a.href = url; a.download = `cohp_data.csv`; a.click(); URL.revokeObjectURL(url) } } }}>CSV</button>
          <button
            class="dos-close-btn"
            title={t('structure.close_panel_label', { name: 'COHP' })}
            onclick={() => { cohp_state.cohp_result = null }}
          >&times;</button>
        </div>
      </div>
      <div class="dos-plot-area">
        <CohpPlot
          bind:this={cohp_plot_ref}
          energies={cohp_state.cohp_result.energies}
          series={cohp_state.cohp_result.series}
          efermi={cohp_state.cohp_result.efermi}
          show_fermi_line={cohp_state.show_fermi_line}
          show_fill={cohp_state.show_fill}
          fill_opacity={cohp_state.fill_opacity}
          show_spin_down={cohp_state.show_spin_down}
          spin_mode={cohp_state.spin_mode}
          orientation={cohp_state.orientation}
          x_range={cohp_state.x_range}
          y_range={cohp_state.y_range}
          invert_cohp={cohp_state.invert_cohp}
          line_styles={cohp_state.line_styles}
          show_gridlines={cohp_state.show_gridlines}
          show_axis_lines={cohp_state.show_axis_lines}
          axis_line_width={cohp_state.axis_line_width}
          tick_length={cohp_state.tick_length}
          tick_width={cohp_state.tick_width}
          legend_visible={cohp_state.legend_visible}
          hidden_series={cohp_state.hidden_series}
        />
      </div>
    </div>
  {/if}

  <!-- Band Structure Plot Panel (split view, same pattern as DOS/COHP) -->
  {#if show_band_panel && band_state.band_data}
    <div class="dos-panel">
      <div class="dos-panel-header">
        <span class="dos-panel-title">{t('structure.bands')}</span>
        <div class="dos-panel-controls">
          <button
            class="dos-layout-btn"
            title={t('structure.toggle_hv_layout')}
            onclick={() => band_layout = band_layout === `horizontal` ? `vertical` : `horizontal`}
          >
            {band_layout === `horizontal` ? `\u2194` : `\u2195`}
          </button>
          <button class="dos-export-btn" onclick={async () => { if (band_plot_ref) { const url = await band_plot_ref.export_image(`png`); if (url) { const a = document.createElement(`a`); a.href = url; a.download = `band_plot.png`; a.click() } } }}>PNG</button>
          <button class="dos-export-btn" onclick={async () => { if (band_plot_ref) { const url = await band_plot_ref.export_image(`svg`); if (url) { const a = document.createElement(`a`); a.href = url; a.download = `band_plot.svg`; a.click() } } }}>SVG</button>
          <button class="dos-export-btn" onclick={() => { if (band_plot_ref) { const csv = band_plot_ref.export_csv(); if (csv) { const blob = new Blob([csv], { type: `text/csv` }); const url = URL.createObjectURL(blob); const a = document.createElement(`a`); a.href = url; a.download = `band_data.csv`; a.click(); URL.revokeObjectURL(url) } } }}>CSV</button>
          <button
            class="dos-close-btn"
            title={t('structure.close_panel_label', { name: t('structure.bands') })}
            onclick={() => { band_state.band_data = null; band_state.projections = null }}
          >&times;</button>
        </div>
      </div>
      <div class="dos-plot-area">
        <BandPlot
          bind:this={band_plot_ref}
          distance={band_state.band_data.distance}
          band_series={band_state.band_data.band_series}
          projections={band_state.projections}
          tick_labels={band_state.band_data.tick_labels}
          tick_positions={band_state.band_data.tick_positions}
          efermi={band_state.band_data.efermi}
          is_metal={band_state.band_data.is_metal}
          band_gap={band_state.band_data.band_gap}
          show_fermi_line={band_state.show_fermi_line}
          show_band_gap={band_state.show_band_gap}
          show_spin_down={band_state.show_spin_down}
          energy_range={band_state.energy_range}
          fat_band_scale={band_state.fat_band_scale}
          show_gridlines={band_state.show_gridlines}
          show_axis_lines={band_state.show_axis_lines}
          axis_line_width={band_state.axis_line_width}
          tick_length={band_state.tick_length}
          tick_width={band_state.tick_width}
          legend_visible={band_state.legend_visible}
        />
      </div>
    </div>
  {/if}


  <!-- Slice Panel (split view, same pattern as DOS/COHP) -->
  {#if show_slice_panel && slice_result}
    <SlicePanel
      {slice_result}
      atoms_info={slice_atoms_info}
      colormap={cube_state_data.slice_plane.colormap}
      on_close={() => { slice_result = null; slice_atoms_info = null }}
      on_layout_toggle={() => slice_layout = slice_layout === `horizontal` ? `vertical` : `horizontal`}
    />
  {/if}

  <!-- Side panels: terminal + editor (stacked when both visible) -->
  {#if show_terminal || show_editor || show_preview}
    {#if !side_panel_minimized}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="resize-handle" onpointerdown={start_side_resize}></div>
    {/if}
    <div class="side-panels" class:side-panels-minimized={side_panel_minimized}>
      {#if side_panel_minimized}
        <button
          class="side-panel-restore-btn"
          title={t('structure.restore_panel')}
          onclick={() => { side_panel_minimized = false }}
        >
          {(show_terminal && !show_editor && !show_preview && terminal_layout === `vertical`) ? `\u25B4` : `\u25C2`}
        </button>
      {:else}
        {#if show_editor}
          <MonacoEditorPanel
            content={editor_content}
            filename={editor_filename}
            file_path={editor_file_path}
            session_id={editor_session_id}
            onclose={() => { show_editor = false }}
            onvisualize={async (text, name) => {
              show_editor = false
              try {
                const { is_trajectory_file } = await import(`$lib/trajectory/parse`)
                if (is_trajectory_file(name, text)) {
                  const { parse_trajectory_data } = await import(`$lib/trajectory/parse`)
                  const traj = await parse_trajectory_data(text, name)
                  if (traj && on_file_load) { on_file_load({ trajectory: traj, filename: name } as any); return }
                }
                const parsed = parse_structure_file(text, name)
                if (parsed) {
                  structure = parsed as AnyStructure
                } else {
                  error_msg = `Failed to parse structure from ${name}`
                }
              } catch (err) {
                error_msg = `Failed to visualize ${name}: ${err}`
                console.error(`[onvisualize]`, err)
              }
            }}
          />
        {/if}
        {#if show_preview}
          <FilePreviewPanel
            mode={preview_mode}
            content={preview_content}
            binary_data={preview_binary_data}
            mime_type={preview_mime_type}
            filename={preview_filename}
            file_path={preview_file_path}
            session_id={preview_session_id}
            onclose={() => { show_preview = false }}
          />
        {/if}
      {/if}
      <!-- Terminal persists outside minimize conditional — hidden via CSS, PTY stays alive -->
      {#if show_terminal}
        <div class="terminal-wrapper" style:display={side_panel_minimized ? 'none' : null}>
          {#key terminal_session_id}
          <TerminalPanel
            layout={terminal_layout}
            session_id={terminal_session_id}
            host={terminal_host}
            username={terminal_username}
            font_size={terminal_font_state.font_size}
            font_family={terminal_font_state.font_family}
            bind:sync_cwd={terminal_sync_cwd}
            on_cwd_change={(path) => { server_nav_path = path }}
            on_open_file={async (file_path) => {
              if (!terminal_session_id) return
              const name = file_path.split(`/`).pop() || file_path
              // Delegate to parent overlay handler if available (App.svelte handles reading + routing)
              if (on_open_file_overlay) {
                on_open_file_overlay(file_path, name, terminal_session_id)
                return
              }
              // Internal fallback: detect file type and route to correct panel
              const lower = name.toLowerCase()
              const is_img = /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?)$/i.test(lower)
              const is_pdf_f = /\.pdf$/i.test(lower)
              const is_excel_f = /\.(xlsx?|xlsm|xlsb|ods)$/i.test(lower)
              const is_csv = /\.(csv|tsv)$/i.test(lower)
              const is_md = /\.(md|rst)$/i.test(lower)
              const is_binary = is_img || is_pdf_f || is_excel_f
              try {
                // Structure files → load directly into this viewer
                const { is_structure_file } = await import(`$lib/structure/parse`)
                const { is_trajectory_file } = await import(`$lib/trajectory/parse`)
                if (is_structure_file(name) || is_trajectory_file(name)) {
                  const { readRemoteFile } = await import(`$lib/api/hpc`)
                  const result = await readRemoteFile(terminal_session_id, file_path)
                  if (result.success && result.content !== undefined) {
                    const { parse_structure_file } = await import(`$lib/structure/parse`)
                    const parsed = parse_structure_file(result.content, name)
                    if (parsed) {
                      structure = parsed as AnyStructure
                    }
                  }
                  return
                }
                if (is_binary) {
                  const { readRemoteBinaryFile } = await import(`$lib/api/hpc`)
                  const result = await readRemoteBinaryFile(terminal_session_id, file_path)
                  if (result.success) {
                    preview_mode = is_img ? `image` : is_pdf_f ? `pdf` : `excel`
                    preview_filename = name
                    preview_content = ``
                    preview_binary_data = result.data
                    preview_mime_type = result.mime_type
                    preview_file_path = file_path
                    preview_session_id = terminal_session_id
                    show_preview = true
                    show_editor = false
                  }
                } else {
                  const { readRemoteFile } = await import(`$lib/api/hpc`)
                  const result = await readRemoteFile(terminal_session_id, file_path)
                  if (result.success && result.content !== undefined) {
                    if (is_csv || is_md) {
                      preview_mode = is_csv ? `csv` : `markdown`
                      preview_filename = name
                      preview_content = result.content
                      preview_binary_data = ``
                      preview_mime_type = ``
                      preview_file_path = file_path
                      preview_session_id = terminal_session_id
                      show_preview = true
                      show_editor = false
                    } else {
                      editor_content = result.content
                      editor_filename = name
                      editor_file_path = file_path
                      editor_session_id = terminal_session_id
                      show_editor = true
                      show_preview = false
                    }
                  }
                }
              } catch (e) {
                console.error(`Failed to open file from terminal:`, e)
              }
            }}
            onclose={() => { side_panel_minimized = true }}
            ondisconnect={() => {
              show_terminal = false
              terminal_session_id = undefined
              terminal_host = ``
              terminal_username = ``
            }}
            onlayout_toggle={() => terminal_layout = terminal_layout === `horizontal` ? `vertical` : `horizontal`}
            onpopout={() => {
              const params = new URLSearchParams()
              if (terminal_session_id) params.set(`session_id`, terminal_session_id)
              if (terminal_host) params.set(`host`, terminal_host)
              if (terminal_username) params.set(`username`, terminal_username)
              if (terminal_sync_cwd) params.set(`sync_cwd`, `true`)
              const qs = params.toString()
              const url = `${window.location.origin}${window.location.pathname}#terminal${qs ? `?${qs}` : ``}`
              const win_id = `terminal-${Date.now()}`
              if (check_tauri()) {
                import(`@tauri-apps/api/webviewWindow`).then(({ WebviewWindow }) => {
                  new WebviewWindow(win_id, {
                    title: terminal_host ? `${terminal_username}@${terminal_host}` : `CatGo - Terminal`,
                    url,
                    width: 900,
                    height: 600,
                    center: true,
                    resizable: true,
                    decorations: true,
                  })
                }).catch(() => {
                  window.open(url, win_id, `width=900,height=600,resizable=yes`)  // Tauri unavailable — fall back to browser window
                })
              } else {
                window.open(url, win_id, `width=900,height=600,resizable=yes`)
              }
              terminal_popped_out = true
              terminal_popped_sync_cwd = terminal_sync_cwd
              // Keep the inline terminal running — don't destroy it on popout
            }}
          />
          {/key}
        </div>
      {/if}
    </div>
  {/if}
  <!-- Slow-Growth Analysis — top-level floating pane, resizable, not constrained by AnalysisPane -->
  <SlowGrowthPane bind:show={slow_growth_pane_open} />
</div>

<!-- Doping Periodic Table — headless bridge, opens separate window -->
{#if build.show_doping_pt}
  <DopingPTPanel
    bind:this={build.doping_pt_panel_ref}
    highlight_symbols={build.doping_pt_symbols}
    group_label={build.doping_group_label}
    bind:window_open={build.doping_pt_window_open}
    on_toggle={(sym) => build.doping_pane_ref?.toggle_element(sym)}
    on_add={(sym) => build.doping_pane_ref?.add_element(sym)}
  />
{/if}

<style>
  .structure {
    position: relative;
    container-type: size; /* enable cqh/cqw for internal panes */
    height: var(--struct-height, 500px);
    width: var(--struct-width, 100%);
    max-width: var(--struct-max-width, 100%);
    min-width: var(--struct-min-width, 300px);
    border-radius: var(--struct-border-radius, 3pt);
    background: var(--struct-bg-override, var(--struct-bg));
    color: var(--struct-text-color);
    /* Isolate stacking context to prevent z-index bleed to other panes */
    isolation: isolate;
    overflow: hidden;
  }

  /* DOS split-view grid layout (like Trajectory) */
  .structure.dos-split {
    display: grid;
  }
  .structure.dos-horizontal {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr;
  }
  .structure.dos-vertical {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  /* Default: display: contents makes this wrapper invisible in layout.
     Children render as if directly inside .structure (same as before wrapper was added). */
  .structure-main {
    display: contents;
  }
  /* In DOS split-view, .structure-main must be a real grid item */
  .structure.dos-split > .structure-main {
    display: block;
    position: relative;
    min-height: 0;
    min-width: 0;
  }
  /* Chat split-view grid layout */
  .structure.chat-split {
    display: grid;
    grid-template-rows: 1fr;
  }
  .structure.chat-split > .structure-main {
    display: block;
    position: relative;
    min-height: 0;
    min-width: 0;
  }
  .structure.chat-split > .chat-resize-handle {
    width: 5px;
    cursor: col-resize;
    background: transparent;
    transition: background 0.15s;
    z-index: 2;
  }
  .structure.chat-split > .chat-resize-handle:hover,
  .structure.chat-split > .chat-resize-handle.active {
    background: var(--accent-color, #3b82f6);
  }

  /* Chat bottom split-view grid layout */
  .structure.chat-bottom {
    display: grid;
    grid-template-columns: 1fr;
  }
  .structure.chat-bottom > .structure-main {
    display: block;
    position: relative;
    min-height: 0;
    min-width: 0;
  }
  .structure.chat-bottom > .chat-resize-handle-bottom {
    height: 5px;
    cursor: row-resize;
    background: transparent;
    transition: background 0.15s;
    z-index: 2;
  }
  .structure.chat-bottom > .chat-resize-handle-bottom:hover,
  .structure.chat-bottom > .chat-resize-handle-bottom.active {
    background: var(--accent-color, #3b82f6);
  }
  .structure.chat-bottom > :global(.chat-panel) {
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    border-left: none;
  }

  .dos-panel {
    display: flex;
    flex-direction: column;
    background: light-dark(rgba(240, 240, 245, 0.95), rgba(20, 20, 30, 0.95));
    border-left: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .structure.dos-vertical .dos-panel {
    border-left: none;
    border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
  }
  .dos-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.04));
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06));
    flex-shrink: 0;
  }
  .dos-panel-title {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--struct-text-color, #ccc);
  }
  .dos-panel-controls {
    display: flex;
    gap: 3px;
    align-items: center;
  }
  .dos-layout-btn, .dos-export-btn, .dos-close-btn {
    padding: 2px 6px;
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.12));
    border-radius: 3px;
    color: var(--struct-text-color, #ccc);
    cursor: pointer;
    font-size: 0.75em;
  }
  .dos-layout-btn:hover, .dos-export-btn:hover { background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15)); }
  .dos-close-btn { color: var(--error-color, #f55); }
  .dos-close-btn:hover { background: rgba(255, 60, 60, 0.2); }
  .dos-plot-area {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* Electronic sub-tabs (DOS / COHP) inside Analysis pane */
  .sg-section {
    margin-top: 8px;
    padding: 8px;
    background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.04));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.1));
    border-radius: 6px;
  }
  .sg-section-title {
    margin: 0 0 6px;
    font-size: 0.82em;
    font-weight: 600;
    color: var(--text-color, #fff);
  }
  .sg-upload-row {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .sg-upload-btn {
    padding: 4px 10px;
    font-size: 0.78em;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.18));
    border-radius: 4px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    color: var(--text-color, #fff);
    cursor: pointer;
  }
  .sg-upload-btn:hover {
    background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.14));
  }
  .sg-close {
    color: var(--error-color, #f55);
    margin-left: auto;
  }
  .electronic-sub-tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 6px;
  }
  .electronic-sub-tabs button {
    flex: 1;
    padding: 4px 8px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.1));
    border-radius: 4px;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.5));
    cursor: pointer;
    font-size: 0.82em;
    font-weight: 500;
    transition: background 0.15s;
  }
  .electronic-sub-tabs button:hover {
    background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.12));
  }
  .electronic-sub-tabs button.active {
    background: var(--accent-color, #007acc);
    color: white;
    border-color: transparent;
  }

  .structure.active {
    z-index: var(--struct-active-z-index, 2);
  }
  /* --- XRD split-view layout --- */
  .structure-main {
    display: contents;
  }
  .structure.xrd-split {
    display: grid;
  }
  .structure.xrd-horizontal {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr;
  }
  .structure.xrd-vertical {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .structure.xrd-split > .structure-main {
    display: block;
    position: relative;
    min-height: 0;
    min-width: 0;
  }
  .xrd-panel {
    display: flex;
    flex-direction: column;
    background: light-dark(rgba(240, 240, 245, 0.95), rgba(20, 20, 30, 0.95));
    border-left: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .xrd-panel.vertical {
    border-left: none;
    border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
  }
  .xrd-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.3));
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06));
    flex-shrink: 0;
  }
  .xrd-panel-title {
    font-size: 0.82em;
    font-weight: 600;
    color: var(--text-color, #fff);
  }
  .xrd-panel-actions {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .xrd-layout-btn,
  .xrd-close-btn {
    background: transparent;
    border: none;
    color: var(--text-color, rgba(255, 255, 255, 0.7));
    cursor: pointer;
    padding: 2px 5px;
    font-size: 0.9em;
    border-radius: 3px;
    display: flex;
    align-items: center;
  }
  .xrd-layout-btn:hover,
  .xrd-close-btn:hover {
    background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.1));
    color: var(--text-color);
  }
  .xrd-plot-area {
    flex: 1;
    min-height: 0;
    padding: 8px;
    overflow: hidden;
  }

  /* --- Slice split-view layout --- */
  .structure.slice-split {
    display: grid;
  }
  .structure.slice-horizontal {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr;
  }
  .structure.slice-vertical {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .structure.slice-split > .structure-main {
    display: block;
    position: relative;
    min-height: 0;
    min-width: 0;
  }

  /* --- Side-panel split-view layout (terminal / editor / both) --- */
  .structure.side-split {
    display: grid;
  }
  .structure.side-horizontal {
    grid-template-columns: 1fr 4px 50%;
    grid-template-rows: 1fr;
  }
  .structure.side-vertical {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 4px 50%;
  }
  .structure.side-split > .structure-main {
    display: block;
    position: relative;
    min-height: 0;
    min-width: 0;
  }
  .structure.side-vertical :global(.terminal-panel) {
    border-left: none;
    border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
  }

  /* --- Combined split-view layout (chat top-right + terminal/editor bottom-right) --- */
  .structure.combined-split {
    display: grid;
  }
  .structure.combined-split > .structure-main {
    grid-column: 1;
    grid-row: 1 / -1;
    display: block;
    position: relative;
    min-height: 0;
    min-width: 0;
  }
  .structure.combined-split > .chat-resize-handle {
    display: none;
  }
  .structure.combined-split > :global(.chat-panel) {
    grid-column: 3;
    grid-row: 1;
    min-height: 0;
    overflow: hidden;
  }
  .structure.combined-split > .resize-handle {
    grid-column: 2;
    grid-row: 1 / -1;
    width: 4px;
    cursor: col-resize;
  }
  .structure.combined-split > .side-panels {
    grid-column: 3;
    grid-row: 2;
    border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
  }
  /* When minimized in combined mode, hide chat and let side-panels span full right column */
  .structure.combined-split.side-minimized > :global(.chat-panel) {
    display: none !important;
  }
  .structure.combined-split.side-minimized > .side-panels {
    grid-row: 1 / -1;
  }

  /* --- Combined layout: chat bottom + terminal/editor right --- */
  .structure.combined-bottom {
    display: grid;
  }
  .structure.combined-bottom > .structure-main {
    grid-column: 1;
    grid-row: 1;
    display: block;
    position: relative;
    min-height: 0;
    min-width: 0;
  }
  .structure.combined-bottom > .chat-resize-handle-bottom {
    grid-column: 1;
    grid-row: 2;
    height: 5px;
    cursor: row-resize;
    background: transparent;
    transition: background 0.15s;
    z-index: 2;
  }
  .structure.combined-bottom > .chat-resize-handle-bottom:hover,
  .structure.combined-bottom > .chat-resize-handle-bottom.active {
    background: var(--accent-color, #3b82f6);
  }
  .structure.combined-bottom > :global(.chat-panel) {
    grid-column: 1;
    grid-row: 3;
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    border-left: none;
  }
  .structure.combined-bottom > .resize-handle {
    grid-column: 2;
    grid-row: 1 / -1;
    width: 4px;
    cursor: col-resize;
  }
  .structure.combined-bottom > .side-panels {
    grid-column: 3;
    grid-row: 1 / -1;
  }
  .structure.combined-bottom.side-minimized > :global(.chat-panel) {
    grid-column: 1 / 2;
  }
  .structure.combined-bottom.side-minimized > .side-panels {
    grid-row: 1 / -1;
  }

  /* Resize handle between main viewer and side panel */
  .resize-handle {
    background: transparent;
    z-index: 5;
    transition: background 0.15s;
  }
  .resize-handle:hover,
  .resize-handle:active {
    background: var(--accent-color, cornflowerblue);
  }
  .structure.side-horizontal > .resize-handle {
    width: 4px;
    cursor: col-resize;
  }
  .structure.side-vertical > .resize-handle {
    height: 4px;
    cursor: row-resize;
  }

  .side-panels {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    position: relative;
  }
  .side-panels > :global(*) {
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .side-panels > .terminal-wrapper {
    display: flex;
    flex-direction: column;
  }
  .side-panels > .terminal-wrapper > :global(*) {
    flex: 1;
    min-height: 0;
  }

  /* Restore button (minimize button removed — terminal header has its own close) */
  .side-panel-restore-btn {
    position: absolute;
    z-index: 6;
    background: var(--pane-btn-bg);
    color: var(--text-color-dim, #ccc);
    border: var(--pane-border);
    font-size: 12px;
    line-height: 1;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .side-panel-restore-btn:hover {
    background: var(--pane-btn-bg-hover);
    color: var(--text-color);
  }
  /* Minimized state: restore button fills the collapsed bar */
  .side-panels-minimized {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .side-panels-minimized .side-panel-restore-btn {
    position: static;
    width: 100%;
    height: 100%;
    border: none;
    border-radius: 0;
    color: var(--accent-color, #3b82f6);
    font-size: 14px;
  }
  .structure.side-horizontal .side-panels-minimized .side-panel-restore-btn {
    border-left: 2px solid var(--accent-color, #3b82f6);
  }
  .structure.side-vertical .side-panels-minimized .side-panel-restore-btn {
    border-top: 2px solid var(--accent-color, #3b82f6);
  }

  /* --- Push-back button highlight --- */
  .push-back-btn {
    color: var(--success-color, #51cf66) !important;
    font-size: 1.1em;
  }
  .needs-lattice-hint {
    color: var(--warning-color, #f59e0b);
    padding: 1em;
    background: rgba(245, 158, 11, 0.1);
    border-radius: 4px;
    font-size: 0.9em;
    line-height: 1.5;
  }
  .needs-lattice-hint .link-btn {
    background: none;
    border: none;
    color: var(--accent-color, #007acc);
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
    font: inherit;
  }

  .structure:fullscreen {
    background: var(--struct-bg-fullscreen, var(--struct-bg));
  }
  .structure:fullscreen :global(canvas) {
    height: 100vh !important;
    width: 100vw !important;
  }
  .structure.dragover {
    background: var(--struct-dragover-bg, var(--dragover-bg));
    border: var(--struct-dragover-border, var(--dragover-border));
  }
  /* Avoid accidental text selection while interacting with the viewer */
  .structure {
    user-select: none;
  }
  div.bottom-left {
    position: absolute;
    bottom: 0;
    left: 0;
    font-size: var(--struct-bottom-left-font-size, 1.2em);
    padding: var(--struct-bottom-left-padding, 1pt 5pt);
    z-index: 10;
    pointer-events: auto;
  }
  .bottom-right-controls {
    position: absolute;
    bottom: var(--struct-legend-bottom, clamp(4pt, 3cqmin, 8pt));
    right: var(--struct-legend-right, clamp(4pt, 3cqmin, 8pt));
    display: flex;
    align-items: center;
    gap: var(--struct-legend-gap, clamp(3pt, 2cqmin, 7pt));
    z-index: var(--struct-legend-z-index, 1);
  }
  .bottom-right-controls :global(.structure-legend) {
    position: static;
    bottom: auto;
    right: auto;
  }
  .axis-lock-indicator {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.7);
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 1.5em;
    font-weight: bold;
    pointer-events: none;
    z-index: 100000001;
    text-shadow: 0 0 10px currentColor;
    border: 2px solid currentColor;
  }
  .clipboard-indicator {
    position: absolute;
    bottom: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    background: rgba(34, 197, 94, 0.9);
    border-radius: 6px;
    color: white;
    font-size: 12px;
    pointer-events: auto;
    z-index: 10;
  }
  .clipboard-dismiss {
    background: none;
    border: none;
    color: white;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 0 0 4px;
    opacity: 0.7;
  }
  .clipboard-dismiss:hover {
    opacity: 1;
  }
  .empty-structure-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 16px;
    color: #888;
  }
  .empty-structure-state p {
    margin: 0;
    font-size: 14px;
  }
  .empty-actions {
    display: flex;
    gap: 10px;
  }
  .empty-action-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    background: #f0f0f0;
    border: 1px solid #ddd;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    color: #555;
    transition: background 0.15s;
  }
  .empty-action-btn:hover:not(:disabled) {
    background: #e4e4e4;
  }
  .empty-action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .structure.axis-locked {
    cursor: grab;
  }
  .structure.axis-locked:active {
    cursor: grabbing;
  }
  .structure.placement-mode,
  .structure.crop-mode-active {
    cursor: crosshair;
  }
  /* 工具栏按钮和测量模式 CSS 已移至 StructureToolbar.svelte (Phase 6 重构) */

  /* Pencil mode cursor — SVG pencil icon with tip at bottom-left as hotspot.
     Uses dark stroke + white outline for visibility on both light and dark backgrounds. */
  .structure.pencil-mode-active {
    cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' stroke='white' stroke-width='4'/%3E%3Cpath d='m15 5 4 4' stroke='white' stroke-width='4'/%3E%3Cpath d='M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' stroke='%23333' stroke-width='2'/%3E%3Cpath d='m15 5 4 4' stroke='%23333' stroke-width='2'/%3E%3C/svg%3E") 2 22, crosshair;
  }
  .structure.pencil-mode-active :global(canvas) {
    cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' stroke='white' stroke-width='4'/%3E%3Cpath d='m15 5 4 4' stroke='white' stroke-width='4'/%3E%3Cpath d='M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' stroke='%23333' stroke-width='2'/%3E%3Cpath d='m15 5 4 4' stroke='%23333' stroke-width='2'/%3E%3C/svg%3E") 2 22, crosshair !important;
  }

  /* Charge label color picker popup */
  .charge-color-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 200;
  }
  .charge-color-popup {
    position: fixed;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--surface-bg, #1e2230);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    font-size: 11px;
    color: var(--text-color, #e2e8f0);
    z-index: 201;
    min-width: 130px;
  }
  .charge-color-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .charge-color-label {
    flex: 1;
  }
  .charge-color-row input[type="color"] {
    width: 28px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
    border-radius: 3px;
    cursor: pointer;
    background: none;
  }
  .charge-color-reset {
    padding: 4px 8px;
    background: none;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
    border-radius: 4px;
    color: var(--text-color-muted, #94a3b8);
    font-size: 10px;
    cursor: pointer;
    margin-top: 2px;
  }
  .charge-color-reset:hover {
    background: rgba(128, 128, 128, 0.15);
    color: var(--text-color, #e2e8f0);
  }
  .charge-color-remove {
    color: #ef5350;
    border-color: rgba(239, 83, 80, 0.3);
  }
  .charge-color-remove:hover {
    background: rgba(239, 83, 80, 0.15);
    color: #ef5350;
  }

  /* Periodic table modal styles */
  .periodic-table-modal-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100000002;
  }
  .periodic-table-modal {
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: 8px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    max-width: 95vw;
    max-height: 90vh;
    overflow: auto;
  }
  .periodic-table-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color, #444);
  }
  .periodic-table-modal-header h3 {
    margin: 0;
    font-size: 1.1em;
    font-weight: 600;
  }
  .periodic-table-modal-header .close-btn {
    background: transparent;
    border: none;
    padding: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    color: inherit;
  }
  .periodic-table-modal-header .close-btn:hover {
    background: color-mix(in srgb, currentColor 15%, transparent);
  }
  .periodic-table-modal-content {
    padding: 16px;
    min-width: 700px;
  }
  .periodic-table-modal-content :global(.periodic-table) {
    font-size: 0.75em;
  }
  .periodic-table-modal-footer {
    padding: 12px 16px;
    border-top: 1px solid var(--border-color, #444);
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
  .selected-element-display {
    font-size: 0.9em;
    color: var(--text-color-muted, #aaa);
  }
  .selected-element-display strong {
    color: var(--accent-color, #007acc);
    font-size: 1.1em;
  }

  /* Position builder panes (Moiré/Nanotube) at top-right */
  :global(.moire-pane.draggable-pane),
  :global(.nanotube-pane.draggable-pane),
  :global(.heterostructure-pane.draggable-pane) {
    left: auto !important;
    right: var(--struct-buttons-right, var(--ctrl-btn-right, 1ex));
    top: calc(var(--struct-buttons-top, var(--ctrl-btn-top, 1ex)) + 2.5em) !important;
  }
  p.warn {
    text-align: center;
  }
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: var(--struct-height, 500px);
    padding: 2rem;
    text-align: center;
    box-sizing: border-box;
  }
  .error-state p {
    color: var(--error-color);
    margin: 0 0 1rem;
  }
  .error-state button {
    padding: 0.5rem 1rem;
    background: var(--error-color);
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .error-state button:hover {
    background: var(--error-color-hover, #ff5252);
  }
  .symmetry-error {
    position: absolute;
    bottom: 1rem;
    right: 1rem;
    background: rgba(255, 165, 0, 0.95);
    color: #000;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    display: flex;
    gap: 1rem;
    max-width: min(90%, 400px);
    font-size: 0.9rem;
    z-index: 1000;
  }
  .symmetry-error span {
    flex: 1;
  }
  .symmetry-error button {
    background: transparent;
    border: none;
    font-size: 1.5rem;
    line-height: 1;
    padding: 0;
    cursor: pointer;
    opacity: 0.7;
  }
  .symmetry-error button:hover {
    opacity: 1;
  }
  .element-selector {
    position: fixed;
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: var(--border-radius, 4px);
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3), 0 4px 8px -2px rgba(0, 0, 0, 0.1);
    padding: 8px;
    z-index: 100000002;
    max-width: 300px;
    max-height: 400px;
    overflow-y: auto;
  }
  .element-selector-header {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--text-color-muted, #999);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
    padding: 2px 4px;
  }
  .element-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 4px;
  }
  .element-btn {
    padding: 6px 4px;
    background: var(--surface-bg-hover, #2a2a2a);
    border: 1px solid var(--border-color, #444);
    border-radius: 3px;
    font-size: 0.7rem;
    font-weight: 600;
    color: inherit;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: center;
  }
  .element-btn:hover {
    background: var(--accent-color, #0066cc);
    color: inherit;
    transform: scale(1.05);
  }
  .element-btn.selected {
    background: var(--accent-color, #0066cc);
    color: white;
    border-color: var(--accent-color, #0066cc);
  }

  .common-molecules-menu {
    position: absolute;
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: var(--border-radius, 4px);
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3), 0 4px 8px -2px rgba(0, 0, 0, 0.1);
    padding: 8px;
    z-index: 100000002;
    max-width: 200px;
  }

  /* When opened from UI dropdown (top-right positioning) */
  .common-molecules-menu.common-molecules-ui {
    top: 48px;
    right: 8px;
  }

  .molecules-header {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--text-color-muted, #999);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
    padding: 2px 4px;
  }

  .molecules-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 4px;
  }

  .molecule-btn {
    padding: 8px 12px;
    background: var(--surface-bg-hover, #2a2a2a);
    border: 1px solid var(--border-color, #444);
    border-radius: 3px;
    font-size: 0.8rem;
    color: inherit;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
    font-family: monospace;
    white-space: nowrap;
  }

  .molecule-btn:hover {
    background: var(--accent-color, #0066cc);
    color: white;
    border-color: var(--accent-color, #0066cc);
  }

  /* MD split-view grid layout */
  .structure.md-split {
    display: grid;
  }
  .structure.md-horizontal {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr;
  }
  .structure.md-vertical {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .structure.md-split > .structure-main {
    display: block;
    position: relative;
    min-height: 0;
    min-width: 0;
  }
  .md-panel {
    display: flex;
    flex-direction: column;
    background: var(--pane-bg);
    border-left: var(--pane-border);
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .structure.md-vertical .md-panel {
    border-left: none;
    border-top: var(--pane-border);
  }
  .md-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    background: var(--pane-tabs-bg, var(--surface-bg));
    border-bottom: var(--pane-border);
    flex-shrink: 0;
  }
  .md-panel-title {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--struct-text-color, #ccc);
  }
  .md-panel-controls {
    display: flex;
    gap: 3px;
    align-items: center;
  }
  .md-layout-btn, .md-close-btn, .md-settings-btn {
    padding: 2px 6px;
    background: var(--pane-btn-bg);
    border: 1px solid var(--border-color);
    border-radius: 3px;
    color: var(--struct-text-color, #ccc);
    cursor: pointer;
    font-size: 0.75em;
  }
  .md-settings-btn.active { background: var(--pane-btn-bg-hover); }
  .md-settings-btn:hover, .md-layout-btn:hover { background: var(--pane-btn-bg-hover); }
  .md-close-btn { color: var(--error-color, #f55); }
  .md-close-btn:hover { background: color-mix(in srgb, var(--error-color) 15%, transparent); }
  .md-settings-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px;
    background: var(--pane-card-bg);
    border-bottom: var(--pane-border);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .md-setting {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.72em;
    color: var(--struct-text-color, #ccc);
  }
  .md-setting input[type="text"] {
    width: 90px;
    padding: 1px 4px;
    background: var(--pane-input-bg);
    border: 1px solid var(--pane-input-border);
    border-radius: 3px;
    color: var(--struct-text-color, #ccc);
    font-size: 1em;
  }
  .md-setting input[type="text"]:focus {
    outline: none;
    border-color: var(--accent-color, #007acc);
  }
  .md-checkbox {
    gap: 3px;
    cursor: pointer;
  }
  .md-checkbox input[type="checkbox"] {
    accent-color: var(--accent-color, #007acc);
    cursor: pointer;
  }
  .md-plot-area {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .symmetry-analysis-section {
    padding: 8px;
    background: var(--pane-card-bg, rgba(255, 255, 255, 0.04));
    border-radius: 6px;
    font-size: 0.85em;
  }
  .sym-heading {
    margin: 0 0 8px;
    font-size: 1em;
    font-weight: 600;
    color: var(--text-color, #fff);
  }
  .sym-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 8px;
  }
  .sym-control-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--text-color, #fff);
  }
  .sym-control-row input {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    border-radius: 4px;
    border: 1px solid var(--pane-input-border);
    background: var(--pane-input-bg);
    color: var(--text-color);
    font-size: 0.9em;
  }
  .sym-control-row select {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    border-radius: 4px;
    border: 1px solid var(--pane-input-border);
    background: var(--pane-input-bg);
    color: var(--text-color);
    font-size: 0.9em;
  }
  .sym-analyze-btn {
    width: 100%;
    padding: 6px 12px;
    border: 1px solid var(--border-color);
    background: var(--pane-btn-bg);
    color: var(--text-color);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 500;
    transition: background 0.15s;
  }
  .sym-analyze-btn:hover:not(:disabled) {
    background: var(--pane-btn-bg-hover);
  }
  .sym-analyze-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .sym-results {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 10px 0;
    padding: 8px;
    background: var(--pane-card-bg);
    border-radius: 4px;
  }
  .sym-results div {
    display: flex;
    justify-content: space-between;
    color: var(--text-color, #fff);
  }
  .sym-results strong {
    font-weight: 600;
  }
  .symmetry-analysis-section :global(.wyckoff-table) {
    margin-top: 8px;
    width: 100%;
    font-size: 0.9em;
  }
  .sym-hint {
    font-size: 0.85em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
    margin: 8px 0;
  }
  .sym-error {
    font-size: 0.85em;
    color: var(--error-color, #ef4444);
    margin: 8px 0;
  }
  .section-divider {
    border: none;
    border-top: var(--pane-border);
    margin: 12px 0;
  }
  .mof-sbu-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 6px;
    max-height: 240px;
    overflow-y: auto;
  }
  .mof-sbu-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: transparent;
    color: var(--text-color);
    cursor: pointer;
    font-size: 0.85em;
    text-align: left;
    width: 100%;
  }
  .mof-sbu-row:hover {
    background: var(--pane-bg-hover);
  }
  .mof-sbu-badge {
    font-size: 0.75em;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
    white-space: nowrap;
  }
  .mof-sbu-badge.node { background: #3b82f6; color: #fff; }
  .mof-sbu-badge.linker { background: #22c55e; color: #fff; }
  .mof-sbu-badge.cap { background: #f59e0b; color: #fff; }
  .mof-sbu-badge.func { background: #8b5cf6; color: #fff; }
  .mof-smiles-input {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid var(--pane-input-border);
    border-radius: 4px;
    background: var(--pane-input-bg);
    color: inherit;
    font-size: 0.8rem;
    min-width: 0;
  }
  .rac-table-container {
    margin-top: 6px;
    max-height: 200px;
    overflow-y: auto;
  }
  .rac-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }
  .rac-table th, .rac-table td {
    padding: 2px 6px;
    text-align: left;
    border-bottom: var(--pane-border);
  }
  .rac-table th { font-weight: 600; }
  .mof-wl-hash {
    font-size: 0.65rem;
    color: var(--text-color-muted);
    font-family: monospace;
  }

  .rotation-angle-hud {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.7);
    color: #ffcc00;
    font-size: 15px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 4px 14px;
    border-radius: 8px;
    pointer-events: none;
    z-index: 1000;
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    backdrop-filter: blur(4px);
    border: 1px solid rgba(255, 204, 0, 0.3);
  }
</style>

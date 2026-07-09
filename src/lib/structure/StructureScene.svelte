<script lang="ts">
  import type { AnyStructure, BondPair, ElementSymbol, HBondConnectivity, Site, Vec3 } from '$lib'
  import type { Crystal } from './index'
  import { atomic_radii, axis_colors, element_data, neg_axis_colors } from '$lib'
  import { resolve_css_var } from '$lib/css-utils'
  import { format_num } from '$lib/labels'
  import * as math from '$lib/math'
  import { type CameraProjection, DEFAULTS, type LightingProfile, type RenderStyle, type ShowBonds } from '$lib/settings'
  import { colors } from '$lib/state.svelte'
  import { Arrow, Cylinder, get_rotation_center, Lattice } from '$lib/structure'
  import * as measure from '$lib/structure/measure'
  import { T, useThrelte, useTask } from '@threlte/core'
  import * as extras from '@threlte/extras'
  import type { ComponentProps } from 'svelte'
  import { type Snippet, untrack } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import type { Camera, Scene, InstancedMesh as ThreeInstancedMesh } from 'three'
  import { BufferGeometry, Color, CylinderGeometry, Euler, InstancedBufferAttribute, MeshBasicMaterial, Matrix4, Mesh, MeshStandardMaterial, Quaternion, ShaderMaterial, SphereGeometry, Vector3 } from 'three'
  import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
  import AdsorptionSiteMarkers from './AdsorptionSiteMarkers.svelte'
  import SceneLighting from './SceneLighting.svelte'
  import DashedBond from './DashedBond.svelte'
  import BondEditingIndicators from './BondEditingIndicators.svelte'
  import CubeIsosurface from './CubeIsosurface.svelte'
  import FrozenAtomIndicators from './FrozenAtomIndicators.svelte'
  import PencilModeOverlay from './PencilModeOverlay.svelte'
  import AtomImpostors from './AtomImpostors.svelte'
  import SlabPreview from './SlabPreview.svelte'
  import {
    build_cutting_visibility_map,
    compute_show_bulk_atoms,
    get_lattice as get_lattice_pure,
    compute_structure_size,
    get_frozen_info,
    desaturate_color,
    compute_force_data,
    compute_magmom_data,
    get_majority_color,
    toggle_site_selection,
    clean_measured_sites,
  } from './scene'

  // Extend Three.js prototypes with BVH acceleration (only once)
  if (typeof window !== 'undefined' && !(BufferGeometry.prototype as any).computeBoundsTree) {
    BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
    BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
    Mesh.prototype.raycast = acceleratedRaycast
  }
  import { type BondingStrategy, compute_bond_transform, get_bond_key } from './bonding'
  import { type AromaticRing, perceive_adsorbate } from './bonding/bond-orders'
  import { compute_bonds_sync } from './workers/bond-worker-api'
  import { apply_bond_distance_rules } from './bond-distance-rules'
  import type { BondKind } from './bonding/bond-manager.svelte'
  import { BOND_KIND } from './bonding/bond-manager.svelte'
  import { BondManager } from './bonding/bond-manager.svelte'
  import BondManagerInstances from './bonding/BondManagerInstances.svelte'
  import AromaticRingOverlay from './bonding/AromaticRingOverlay.svelte'
  import {
    build_image_atom_layout,
    empty_image_atom_layout,
    type ImageAtomLayout,
  } from './bonding/image-atom-layout'
  import {
    build_sites_to_draw,
    make_image_site_key,
    type ImageSiteEntry,
    type ImageSiteKey,
  } from './pbc-image-atoms'
  import type { PartnerDrawnLookup } from './bonding/bond-instanced-renderer'
  import {
    AtomManager,
    element_to_atomic_number,
    type AtomAddSpec,
    type AtomFastOps,
    type AtomMoveSpec,
    type AtomReplaceSpec,
  } from './atoms/atom-manager.svelte'
  import AtomManagerInstances from './atoms/AtomManagerInstances.svelte'
  import { USE_NEW_ATOM_SYSTEM } from './atoms/feature-flag'
  import { get_orig_site_idx, type AtomPropertyColors } from './atom-properties'
  import CoordinationPolyhedra from './CoordinationPolyhedra.svelte'
  import {
    compute_polyhedra_from_bonds,
    merge_polyhedra_geometry,
    get_polyhedra_hidden_atoms,
    get_polyhedra_hidden_bond_keys,
    type MergedPolyhedraGeometry,
    type PolyhedronData,
  } from './polyhedra'
  import type { MofClusters } from './mof-analysis'
  import { CanvasTooltip } from './index'
  import ScaleBar from './ScaleBar.svelte'
  import { pluginManager } from '$lib/plugins'
  import {
    LARGE_STRUCTURE_THRESHOLD,
    create_gpu_picker,
    setup_hover_detection as setup_hover_detection_impl,
    find_hit_atom_from_event as find_hit_atom_impl,
    is_atom_pickable as is_atom_pickable_external,
    update_gpu_picker as update_gpu_picker_impl,
    type GpuPickerDeps,
  } from './gpu-picker-integration.svelte'
  import { on_ferrox_wasm_ready } from './ferrox-wasm'
  import {
    create_bond_state,
    compute_bond_connectivity,
    invalidate_bonds_for_recompute,
    compute_bond_connectivity_for_frame,
    clear_trajectory_bond_frame_cache,
    build_bond_pairs,
    build_trajectory_bond_pairs,
    create_hbond_state,
    compute_hbond_connectivity,
    build_hbond_pairs,
    apply_atom_delete_incremental,
    apply_atom_add_incremental,
    apply_atom_replace_incremental,
    apply_atom_move_incremental,
  } from './bond-computation-controller.svelte'
  import {
    compute_charge_label_entries,
    setup_charge_label_drag,
  } from './charge-label-rendering.svelte'
  import {
    type RollDragState,
    handle_scene_roll_start as roll_start,
    handle_scene_roll_move as roll_move,
    handle_scene_roll_end as roll_end,
    handle_keyboard_rotation as kbd_rotation,
  } from './interaction-handlers'
  // depth-cue-helpers was used by the per-mesh highlight {#each} block
  // here; R7 moved that consumer into SelectionHighlights.svelte. No
  // direct callers remain in this file.
  import SelectionHighlights from './SelectionHighlights.svelte'

  // R6: selection-highlight pulse. The original (pre-c4155f44) opacity
  // pulse animated the wireframe spheres around selected/active atoms.
  // c4155f44 dropped the opacity binding from the highlight materials but
  // left the rAF loop in place — that became R3.1's dead-render-loop bug.
  //
  // This restoration:
  //   - $state value `__pulse_opacity` is bound to each highlight
  //     `<T.MeshBasicMaterial>`'s `opacity` prop. Threlte's prop-watcher
  //     auto-invalidates on each change → one paint per pulse frame.
  //   - The rAF loop runs ONLY when something actually pulses (selection
  //     or active-group has at least one atom). Cleanup cancels on
  //     deselect, so idle CPU returns to 0 paints/sec.
  //   - Uses real wall-clock time (`performance.now()`) so the phase
  //     doesn't drift if a frame is skipped.
  //
  // Why JS opacity not a shader uniform: each highlight mesh has its own
  // depth-tinted color, which would require either per-mesh ShaderMaterial
  // (defeats uniform sharing) or per-mesh onBeforeCompile (more code than
  // the pulse is worth). N highlight meshes is small (typical <10), so
  // N material.opacity writes per frame is negligible.
  let __pulse_opacity = $state(1)
  $effect(() => {
    const has_selection = (selected_sites?.length ?? 0) + (active_sites?.length ?? 0) > 0
    if (!has_selection) {
      __pulse_opacity = 1
      return
    }
    let raf_id = 0
    const tick = () => {
      // ~1.6s pulse period (sin frequency = 4 rad/s → period = π/2 s).
      // Range 0.45–0.95 — visible-but-not-flashy.
      __pulse_opacity = 0.7 + 0.25 * Math.sin(performance.now() / 1000 * 4)
      raf_id = requestAnimationFrame(tick)
    }
    raf_id = requestAnimationFrame(tick)
    return () => { if (raf_id) cancelAnimationFrame(raf_id) }
  })

  // --- GPU Picker for O(1) hover/click detection ---
  const picker = create_gpu_picker()

  // Check if an atom is pickable (not hidden by cutting plane)
  function is_atom_pickable(site_idx: number): boolean {
    return is_atom_pickable_external(site_idx, cutting_active, cutting_visibility_map)
  }

  // Check if a bond is pickable (both atoms must be inside the slab)
  function is_bond_pickable(bond: BondPair): boolean {
    return is_atom_pickable(bond.site_idx_1) && is_atom_pickable(bond.site_idx_2)
  }

  function find_hit_atom_from_event(event: PointerEvent | MouseEvent): { site_idx: number; position: Vec3 } | null {
    return find_hit_atom_impl(
      event, threlte, structure, atom_data, rotation, rotation_target,
      realtime_position_overrides, cutting_active, cutting_visibility_map,
    )
  }

  // Hover detection deps (getters read reactive values at call-time)
  const gpu_picker_deps: GpuPickerDeps = {
    get_threlte: () => threlte,
    get_atom_data: () => atom_data,
    get_filtered_bond_pairs: () => filtered_bond_pairs,
    get_bond_thickness: () => bond_thickness,
    get_external_dragging: () => external_dragging,
    get_is_rotating_atoms: () => is_rotating_atoms,
    get_is_box_selecting: () => is_box_selecting,
    get_camera_is_moving: () => camera_is_moving,
    get_show_bulk_atoms: () => show_bulk_atoms,
    get_is_large_structure: () => is_large_structure,
    get_cutting_active: () => cutting_active,
    get_cutting_visibility_map: () => cutting_visibility_map,
    get_rotation: () => rotation,
    get_rotation_target: () => rotation_target,
    get_realtime_position_overrides: () => realtime_position_overrides,
    get_structure: () => structure,
    set_hovered_idx: (v) => { hovered_idx = v },
    get_hovered_idx: () => hovered_idx,
    set_active_tooltip: (v) => { active_tooltip = v },
    find_hit_atom_from_event,
    get_lattice_matrix: () => bond_lattice_matrix,
    get_incomplete_edge: () => ({
      mode: incomplete_periodic_edge_mode,
      scale: incomplete_edge_length_scale,
      hide_incomplete: hide_incomplete_bonds,
    }),
    // Phase 7e — image-atom decorator picker integration. Layout +
    // partner-drawn predicate mirror the renderer's contract so the
    // picker geometry matches what's on screen; slot_to_filtered_idx
    // routes decorator hits back to the same `filtered_bond_pairs` index
    // a cell-internal half would resolve to, keeping selection logic
    // unified.
    get_image_atom_layout: () => image_atom_layout,
    get_bond_manager: () => bond_manager,
    get_partner_drawn_lookup: () => partner_drawn_lookup,
    get_slot_to_filtered_idx: () => slot_to_filtered_idx,
  }

  function setup_hover_detection() {
    return setup_hover_detection_impl(gpu_picker_deps, picker)
  }

  // --- Atom interaction mesh: invisible InstancedMesh with custom raycast ---
  // Uses Threlte's event system (onclick, onpointerdown, etc.) just like the old
  // extras.Instance approach. The mesh geometry is never rendered (visible=false)
  // but provides analytic ray-sphere intersection via a custom raycast method.
  let atom_interaction_mesh: ThreeInstancedMesh | undefined = $state()
  const atom_interaction_geometry = new SphereGeometry(0.5, 8, 6) // Low-poly but enough for click detection
  // MeshBasicMaterial({ visible: false }) doesn't reliably prevent rendering
  // in Three.js r181.  Use fully transparent + no depth writes instead.
  const atom_interaction_material = new MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
  })


  // Fixed initial capacity — prevents Threlte from recreating the mesh on every
  // atom count change (args change). ensure_instance_capacity() handles growth.
  const INITIAL_MESH_CAPACITY = 64

  // Maximum rendered covalent bond length (Å). The longest real single bonds
  // (e.g. heavy-metal–metal) are ~3.5 Å; 4 Å leaves headroom while still
  // discarding bonds stretched across the cell by a PBC/image rendering
  // artifact (the minimum-image distance is short, but a raw straight-line
  // draw spans the whole cell).
  const MAX_BOND_LENGTH = 4.0

  // Shared empty positions buffer for BondManagerInstances when the new bond
  // system is disabled or the structure has no sites.
  const EMPTY_POSITIONS = new Float32Array(0)
  const EMPTY_COLORS = new Float32Array(0)

  // Hex → linear RGB conversion (matches Bond.svelte's color pipeline).
  // Cached so repeated lookups of the same hex string avoid re-parsing.
  const __bond_color_tmp = new Color()
  const __bond_color_cache = new Map<string, [number, number, number]>()
  function __hex_to_linear_rgb(hex: string): [number, number, number] {
    const cached = __bond_color_cache.get(hex)
    if (cached !== undefined) return cached
    // Color.set(hex) already converts sRGB→linear (three ColorManagement is on
    // by default), so .r/.g/.b are LINEAR. An extra .convertSRGBToLinear() here
    // double-darkened every colour — mid-tones like Fe gold turned muddy brown.
    __bond_color_tmp.set(hex)
    const out: [number, number, number] = [__bond_color_tmp.r, __bond_color_tmp.g, __bond_color_tmp.b]
    __bond_color_cache.set(hex, out)
    return out
  }

  // Grow an InstancedMesh's instanceMatrix buffer when count exceeds its current
  // capacity. Three.js allocates instanceMatrix at construction time with a fixed
  // size. If instance count later exceeds that, WebGL reads out-of-bounds from the
  // buffer, which silently fails the draw call on most GPU drivers.
  const identity_matrix = new Matrix4()
  function ensure_instance_capacity(mesh: ThreeInstancedMesh, needed: number) {
    const capacity = mesh.instanceMatrix.array.length / 16
    if (needed <= capacity) return
    const new_capacity = Math.max(needed, Math.ceil(capacity * 2))
    const new_array = new Float32Array(new_capacity * 16)
    for (let idx = 0; idx < new_capacity; idx++) {
      identity_matrix.toArray(new_array, idx * 16)
    }
    mesh.instanceMatrix = new InstancedBufferAttribute(new_array, 16)
    mesh.instanceMatrix.needsUpdate = true
  }

  // Update atom interaction mesh: set instance transforms to match atom positions/radii
  // and install custom raycast for analytic ray-sphere intersection.
  // Skipped during drag — users don't click atoms while dragging, and positions
  // are approximate anyway. Rebuilds on drag-end when external_dragging becomes false.
  $effect(() => {
    if (!atom_interaction_mesh) return
    if (external_dragging || is_rotating_atoms) return // Skip during drag
    const data = atom_data
    const overrides = realtime_position_overrides
    const mesh = atom_interaction_mesh
    const mat = new Matrix4()
    // Access cutting_visibility_map to track it as a dependency
    const _vis_map = cutting_visibility_map

    ensure_instance_capacity(mesh, data.length)
    mesh.count = data.length
    for (let i = 0; i < data.length; i++) {
      const atom = data[i]
      const pos = overrides?.get(atom.site_idx) ?? atom.position
      // Set scale to 0 for atoms hidden by cutting plane so Threlte raycasting skips them
      const r = is_atom_pickable(atom.site_idx) ? atom.radius : 0
      mat.makeScale(r, r, r)
      mat.setPosition(pos[0], pos[1], pos[2])
      mesh.setMatrixAt(i, mat)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.boundingSphere) mesh.computeBoundingSphere()
    // mark_dirty: imperative mesh.count + setMatrixAt + instanceMatrix.needsUpdate writes bypass <T.> prop chain
    mark_dirty()
  })

  // Atom interaction event handlers (dispatched by Threlte's interactivity system)
  function handle_atom_interaction_click(event: any) {
    const instance_id = event.instanceId
    if (instance_id === undefined || instance_id >= atom_data.length) return
    const atom = atom_data[instance_id]
    if (!is_atom_pickable(atom.site_idx)) return // Skip atoms hidden by cutting plane
    event.stopPropagation()

    if (bond_mode_active && on_bond_atom_click) {
      on_bond_atom_click(atom.site_idx)
      return
    }
    if (pencil_mode_active && on_pencil_atom_click) {
      on_pencil_atom_click(atom.site_idx, atom.position, event.nativeEvent ?? event)
      return
    }
    if (measure_mode_active && on_continuous_measure_click) {
      on_continuous_measure_click(atom.site_idx)
      return
    }
    toggle_selection(atom.site_idx, event)
  }

  function handle_atom_interaction_pointerdown(event: any) {
    const instance_id = event.instanceId
    if (instance_id === undefined || instance_id >= atom_data.length) return
    const atom = atom_data[instance_id]
    if (!is_atom_pickable(atom.site_idx)) return // Skip atoms hidden by cutting plane
    event.stopPropagation()

    if (bond_mode_active && on_bond_drag_start) {
      on_bond_drag_start(atom.site_idx, event.nativeEvent ?? event)
    }
    if (pencil_mode_active && on_pencil_atom_click) {
      on_pencil_atom_click(atom.site_idx, atom.position, event.nativeEvent ?? event)
    }
  }

  function handle_atom_interaction_pointerup(event: any) {
    if (bond_mode_active && on_bond_drag_end) {
      const instance_id = event.instanceId
      if (instance_id !== undefined && instance_id < atom_data.length) {
        const atom = atom_data[instance_id]
        if (!is_atom_pickable(atom.site_idx)) return // Skip atoms hidden by cutting plane
        event.stopPropagation()
        on_bond_drag_end(atom.site_idx)
      }
    }
  }

  function handle_atom_interaction_contextmenu(event: any) {
    const instance_id = event.instanceId
    if (instance_id === undefined || instance_id >= atom_data.length) return
    const atom = atom_data[instance_id]
    if (!is_atom_pickable(atom.site_idx)) return // Skip atoms hidden by cutting plane
    event.stopPropagation()
    if (event.nativeEvent?.cancelable) event.nativeEvent.preventDefault()
    on_atom_context_menu?.(atom.site_idx, atom.position, event.nativeEvent ?? event)
  }

  // @ts-ignore - structure is declared later via $props() but $derived is reactive
  let is_large_structure = $derived((structure?.sites?.length ?? 0) > LARGE_STRUCTURE_THRESHOLD)

  // Global pointerdown listener to handle measurement label selection.
  // Uses pointerdown instead of click because Threlte's interactivity system
  // captures click events on the canvas before they reach portaled HTML elements.
  // Capture phase ensures we intercept before anything else.
  $effect(() => {
    function on_label_pointerdown(event: Event) {
      const target = event.target as HTMLElement
      const label = target.closest?.(`.measure-label[data-measurement-id]`) as HTMLElement | null
      if (!label) return
      const id = label.dataset.measurementId
      if (!id) return
      event.stopPropagation()
      event.preventDefault()
      // Toggle selection
      selected_measurement_id = selected_measurement_id === id ? null : id
    }
    document.addEventListener(`pointerdown`, on_label_pointerdown, true)
    return () => document.removeEventListener(`pointerdown`, on_label_pointerdown, true)
  })

  // Charge label drag handler (document-level, capture phase)
  $effect(() => {
    return setup_charge_label_drag(charge_label_offsets, on_charge_label_offset_change)
  })

  let {
    structure = undefined,
    atom_radius = DEFAULTS.structure.atom_radius,
    same_size_atoms = false,
    element_radius_overrides = {} as Partial<Record<ElementSymbol, number>>,
    site_radius_overrides = new SvelteMap<number, number>(),
    site_color_overrides = new SvelteMap<number, string>(),
    camera_position = DEFAULTS.structure.camera_position,
    camera_projection = DEFAULTS.structure.camera_projection,
    rotation_damping = DEFAULTS.structure.rotation_damping,
    max_zoom = DEFAULTS.structure.max_zoom,
    min_zoom = DEFAULTS.structure.min_zoom,
    rotate_speed = DEFAULTS.structure.rotate_speed,
    zoom_speed = DEFAULTS.structure.zoom_speed,
    pan_speed = DEFAULTS.structure.pan_speed,
    zoom_to_cursor = DEFAULTS.structure.zoom_to_cursor,
    show_atoms = DEFAULTS.structure.show_atoms,
    show_cell = DEFAULTS.structure.show_cell,
    show_scale_bar = DEFAULTS.structure.show_scale_bar,
    show_bonds = DEFAULTS.structure.show_bonds,
    show_site_labels = DEFAULTS.structure.show_site_labels,
    show_site_indices = DEFAULTS.structure.show_site_indices,
    site_label_size = DEFAULTS.structure.site_label_size,
    site_label_offset = $bindable(DEFAULTS.structure.site_label_offset),
    site_label_bg_color = `var(--struct-label-bg, rgba(255, 255, 255, 0.85))`,
    site_label_color = `var(--struct-label-color, #1a1a1a)`,
    site_label_padding = 3,
    show_force_vectors = DEFAULTS.structure.show_force_vectors,
    force_scale = DEFAULTS.structure.force_scale,
    show_magmom_vectors = DEFAULTS.structure.show_magmom_vectors,
    magmom_scale = DEFAULTS.structure.magmom_scale,
    magmom_up_color = DEFAULTS.structure.magmom_up_color,
    magmom_down_color = DEFAULTS.structure.magmom_down_color,
    force_color = DEFAULTS.structure.force_color,
    force_display_mode = DEFAULTS.structure.force_display_mode,
    force_color_mode = DEFAULTS.structure.force_color_mode,
    force_range_min = DEFAULTS.structure.force_range_min,
    force_range_max = DEFAULTS.structure.force_range_max,
    gizmo = DEFAULTS.structure.show_gizmo,
    hovered_idx = $bindable(null),
    hovered_site = $bindable(null),
    float_fmt = `.3~f`,
    auto_rotate = DEFAULTS.structure.auto_rotate,
    bond_thickness = DEFAULTS.structure.bond_thickness,
    bond_color = DEFAULTS.structure.bond_color,
    incomplete_periodic_edge_mode = DEFAULTS.structure.incomplete_periodic_edge_mode,
    incomplete_edge_length_scale = DEFAULTS.structure.incomplete_edge_length_scale,
    hide_incomplete_bonds = DEFAULTS.structure.hide_incomplete_bonds,
    show_image_atoms = false,
    bonding_strategy = DEFAULTS.structure.bonding_strategy,
    bonding_options = {},
    bond_order_perception = DEFAULTS.structure.bond_order_perception,
    bond_scale = DEFAULTS.structure.bond_scale,
    show_hydrogen_bonds = DEFAULTS.structure.show_hydrogen_bonds,
    hbond_distance_cutoff = DEFAULTS.structure.hbond_distance_cutoff,
    hbond_angle_cutoff = DEFAULTS.structure.hbond_angle_cutoff,
    hbond_thickness = DEFAULTS.structure.hbond_thickness,
    property_colors = null as AtomPropertyColors | null,
    fov = DEFAULTS.structure.fov,
    initial_zoom = DEFAULTS.structure.initial_zoom,
    ambient_light = DEFAULTS.structure.ambient_light,
    directional_light = DEFAULTS.structure.directional_light,
    depth_cueing = DEFAULTS.structure.depth_cueing,
    depth_cue_start = DEFAULTS.structure.depth_cue_start,
    depth_cue_end = DEFAULTS.structure.depth_cue_end,
    atom_outline_strength = DEFAULTS.structure.atom_outline_strength,
    bond_outline_strength = DEFAULTS.structure.bond_outline_strength,
    render_style = DEFAULTS.structure.render_style,
    matcap_preset = DEFAULTS.structure.matcap_preset,
    light_azimuth = DEFAULTS.structure.light_azimuth,
    light_elevation = DEFAULTS.structure.light_elevation,
    highlight_strength = DEFAULTS.structure.highlight_strength,
    lighting_profiles = DEFAULTS.structure.lighting_profiles,
    background_color = undefined as string | undefined,
    background_opacity = DEFAULTS.background_opacity,
    sphere_segments = DEFAULTS.structure.sphere_segments,
    lattice_props = {},
    atom_label,
    camera_is_moving = $bindable(false),
    pixels_per_angstrom = $bindable(0),
    width = 0,
    height = 0,
    measure_mode = `distance`,
    measure_mode_active = false,
    on_continuous_measure_click,
    selected_sites = $bindable([]),
    measured_sites = $bindable([]),
    measurements = [],
    selected_measurement_id = $bindable<string | null>(null),
    on_measurement_select,
    selection_highlight_color = `#6cf0ff`,
    // Active highlight group with different color
    active_sites = $bindable([]),
    active_highlight_color = resolve_css_var('--struct-active-highlight-color', '#2563eb'),
    rotation = DEFAULTS.structure.rotation,
    scene = $bindable(undefined),
    camera = $bindable(undefined),
    orbit_controls = $bindable(undefined),
    rotation_target_ref = $bindable<Vec3 | undefined>(undefined),
    initial_computed_zoom = $bindable<number | undefined>(undefined),
    hidden_elements = $bindable(new Set<ElementSymbol>()),
    hidden_sites = $bindable(new Set<number>()),
    hidden_prop_vals = $bindable(new Set<number | string>()),
    axis_lock_active = false,
    hovered = false,
    frozen_rotation_target = null,
    center_camera_trigger = $bindable(0), // Increment this to trigger camera centering
    lattice_align_trigger = $bindable(0), // Increment to align camera with lattice a×b normal
    reset_camera_up_trigger = 0, // Increment to reset camera.up to [0,0,1] (Z-up) after slab cut
    repaint_trigger = 0, // Increment to force ONE WebGL repaint (no side effects) — used when the large-system overlay closes and autoRender resumes
    external_dragging = false,
    is_box_selecting = false,
    is_rotating_atoms = false,
    is_dragging_atom = false,
    atom_rotation_center = null as Vec3 | null,
    atom_rotation_axis = null as Vec3 | null,
    atom_rotation_angle_deg = 0,
    // Realtime position overrides for drag/rotate - bypasses structure updates for performance
    realtime_position_overrides = null as Map<number, Vec3> | null,
    // Active trajectory frame index (>= 0 when a trajectory is loaded; -1
    // otherwise). Used as the "we are rendering a trajectory frame" signal for
    // the slow-path bond effect — variable-N trajectories have no
    // `trajectory_frame_positions` fast-path, so this is the only reliable
    // trajectory indicator there.
    trajectory_step_idx = -1,
    // Trajectory fast-path: flat Float32Array of positions for current frame
    trajectory_frame_positions = null as Float32Array | null,
    // Trajectory fast-path: flat Float32Array of forces (fx,fy,fz) for current frame
    trajectory_frame_forces = null as Float32Array | null,
    // Per-frame bond connectivity from the async trajectory bond cache. When
    // null (cache miss), we fall back to `bond_state.bond_connectivity`
    // (frame-0 static).
    trajectory_bond_connectivity = null as Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }> | null,
    webgl_suspended = false,
    on_reset_rotation,
    on_atom_context_menu,
    // Cutting plane visualization
    cutting_active = false,
    cutting_plane_normal = [0, 0, 1] as Vec3,
    cutting_plane_offset = 0,
    cutting_plane_thickness = 0,
    cutting_atom_visibility = [] as { site_idx: number; inside_slab: boolean; opacity: number; saturation: number }[],
    cutting_flash_intensity = 0,
    cutting_miller_label = '(001)',
    cutting_slab_preview = null,
    cutting_preview_mode = 'slab' as const,
    cutting_show_bonds = true,
    // Adsorption site visualization
    adsorption_sites = [],
    show_adsorption_sites = true,
    selected_adsorption_site_idx = $bindable(null),
    adsorption_site_radius = 0.3,
    adsorption_site_opacity = 0.7,
    on_delete_adsorption_site,
    adsorption_site_placement_mode = false,
    on_adsorption_site_click,
    // Pencil/draw mode props
    pencil_mode_active = false,
    pencil_ghost_atom = null,
    on_pencil_atom_click,
    // Bond editing mode props
    bond_mode_active = false,
    manual_bonds = [] as import('./index').ManualBond[],
    bond_manager = new BondManager(),
    // Phase X5: atom-delete fast-path hook. StructureScene owns atom_manager +
    // bond_state; Structure binds to this so its delete_selected() can drive
    // the manager directly before mutating structure.sites. Null when the
    // USE_NEW_ATOM_SYSTEM flag is off (the callsite no-ops through this).
    atom_fast_ops = $bindable<AtomFastOps | null>(null),
    // Plan v3 Phase 1: lift atom_manager via $bindable so Structure.svelte's
    // position-write loop (Phase 2) can drive it directly. The default value
    // creates a transient AtomManager that is overwritten by the parent's
    // $state at mount via $bindable semantics — small one-time cost.
    // Without the parent binding, this default keeps StructureScene self-
    // contained for any test harness that mounts it directly.
    atom_manager = $bindable<AtomManager>(new AtomManager()),
    // WebGPU large-system overlay bridge: a getter the parent can call to read
    // the AUTHORITATIVE per-displayed-atom current-frame position array the
    // WebGL atoms/bonds are drawn at — `atom_positions_buffer` (topology base
    // overlaid with the manager's per-frame positions via site_ids_buffer,
    // indexed by displayed site index, 3 × n_displayed). The overlay consumes
    // this instead of re-deriving from base-only trajectory data, so the two
    // views match atom-for-atom (incl. supercell base-block / replica-static
    // behaviour). Bound out as a function so the parent always reads the LIVE
    // $derived value, not a stale snapshot.
    get_displayed_frame_positions = $bindable<(() => Float32Array) | null>(null),
    deleted_bond_keys = new Set<string>(),
    selected_bonds = $bindable([] as import('./index').SelectedBond[]),
    bond_first_atom = null as number | null,
    on_bond_atom_click,
    on_bond_select,
    on_bond_drag_start = undefined as ((site_idx: number, event: PointerEvent) => void) | undefined,
    on_bond_drag_end = undefined as ((site_idx: number) => void) | undefined,
    bond_drag_active = false,
    bond_ghost_end = null as Vec3 | null,
    // Per-element-pair bond distance filter rules
    bond_distance_rules = [] as import('./index').BondDistanceRule[],
    // Expose filtered bond pairs to parent for box selection
    filtered_bond_pairs_out = $bindable([] as import('./index').BondPair[]),
    // Selection opacity: controls transparency of selected atoms/bonds
    selection_opacity = $bindable(1),
    // Per-atom opacity overrides (persists after deselection)
    atom_opacity_overrides = new Map<number, number>(),
    // Per-bond opacity overrides (persists after deselection)
    bond_opacity_overrides = new Map<string, number>(),
    // Image atom opacity (0-1, controls transparency of PBC image atoms)
    image_atom_opacity = 1,
    // Image atom mapping (for displaying correct labels on periodic images)
    num_original_sites = undefined as number | undefined,
    image_to_original_map = undefined as number[] | undefined,
    // Per-atom charge labels
    visible_charge_labels = new Set<number>(),
    show_charge_labels = true,
    charge_label_offsets = new SvelteMap<number, [number, number]>(),
    charge_label_colors = new Map<number, { text?: string; bg?: string }>(),
    on_charge_label_offset_change = undefined as ((idx: number, offset: [number, number]) => void) | undefined,
    on_charge_value_edit = undefined as ((idx: number, value: number) => void) | undefined,
    on_charge_label_remove = undefined as ((idx: number) => void) | undefined,
    on_charge_label_contextmenu = undefined as ((idx: number, x: number, y: number) => void) | undefined,
    // Polyhedra visualization
    show_polyhedra = false,
    polyhedra_center_elements = [] as string[],
    polyhedra_min_coordination = 3,
    polyhedra_max_neighbors = 8,
    polyhedra_bond_scale = DEFAULTS.structure.polyhedra_bond_scale,
    polyhedra_metals_only = true,
    polyhedra_style = `flat` as import('$lib/settings').PolyhedraStyle,
    polyhedra_color_mode = `vertex` as import('$lib/settings').PolyhedraColorMode,
    polyhedra_color = `#4a90d9`,
    polyhedra_show_edges = true,
    polyhedra_opacity_mode = `uniform` as import('$lib/settings').PolyhedraOpacityMode,
    polyhedra_opacity = 0.4,
    polyhedra_opacity_near = 0.6,
    polyhedra_opacity_far = 0.1,
    polyhedra_edge_opacity = 0.8,
    polyhedra_edge_color = `#333333`,
    polyhedra_edge_width = 1.5,
    polyhedra_color_overrides = {} as Record<string, string>,
    hide_polyhedra_center_atoms = true,
    hide_polyhedra_internal_bonds = true,
    // MOF analysis
    mof_clusters = null as MofClusters | null,
    isolated_node_atoms = null as Set<number> | null,
    isolation_outside_opacity = 0.1,
    // Sphere clipping
    clip_active = false,
    clip_center = null as Vec3 | null,
    clip_radius = 8,
    clip_outside_mode = `transparent` as `hide` | `transparent`,
    clip_outside_opacity = 0.1,
    // Cube file isosurface overlay
    cube_positive_mesh = null,
    cube_negative_mesh = null,
    cube_show_positive = true,
    cube_show_negative = true,
    cube_positive_color = `#3366cc`,
    cube_negative_color = `#cc3333`,
    cube_opacity = 0.7,
    cube_wireframe = false,
    // Cube slice plane preview
    cube_slice_normal = null as [number, number, number] | null,
    cube_slice_center = null as [number, number, number] | null,
    cube_show_slice_plane = false,
    cube_slice_plane_size = 20,
    cube_slice_color = `#ffcc00`,
    // Vibration animation data
    vibration_data = null as { eigenvector: number[][]; base_positions: number[][]; amplitude: number; playing: boolean } | null,
    // Pre-ghost structure used for bond detection (Phase 5 PBC half-bond
    // refactor). When undefined, falls back to `structure`. Atom rendering
    // still uses `structure` (with ghosts) — only the bond-input path is
    // diverted so WASM detection runs on the original cell with PBC enabled
    // and emits cross-cell bonds with their `image` field populated.
    bond_input_structure = undefined as AnyStructure | undefined,
  }: {
    structure?: AnyStructure
    bond_input_structure?: AnyStructure
    atom_radius?: number // scale factor for atomic radii
    same_size_atoms?: boolean // whether to use the same radius for all atoms. if not, the radius will be
    // determined by the atomic radius of the element
    element_radius_overrides?: Partial<Record<ElementSymbol, number>> // per-element radius overrides
    site_radius_overrides?: Map<number, number> | SvelteMap<number, number> // per-site radius overrides (takes precedence over element overrides)
    site_color_overrides?: Map<number, string> | SvelteMap<number, string> // per-site color overrides (takes precedence over element/property colors)
    camera_position?: [x: number, y: number, z: number] // initial camera position from which to render the scene
    camera_projection?: CameraProjection // camera projection type
    rotation_damping?: number // rotation damping factor (how quickly the rotation comes to rest after mouse release)
    // zoom level of the camera
    max_zoom?: number
    min_zoom?: number
    rotate_speed?: number // rotation speed. set to 0 to disable rotation.
    zoom_speed?: number // zoom speed. set to 0 to disable zooming.
    pan_speed?: number // pan speed. set to 0 to disable panning.
    zoom_to_cursor?: boolean // zoom toward cursor position instead of scene center
    show_atoms?: boolean
    show_cell?: boolean
    show_scale_bar?: boolean
    show_bonds?: ShowBonds
    show_site_labels?: boolean
    show_site_indices?: boolean
    show_force_vectors?: boolean
    force_scale?: number
    show_magmom_vectors?: boolean
    magmom_scale?: number
    magmom_up_color?: string
    magmom_down_color?: string
    force_color?: string
    force_display_mode?: `all` | `max_only` | `range`
    force_color_mode?: `element` | `custom`
    force_range_min?: number
    force_range_max?: number
    gizmo?: boolean | ComponentProps<typeof extras.Gizmo>
    hovered_idx?: number | null
    hovered_site?: Site | null
    float_fmt?: string
    auto_rotate?: number
    initial_zoom?: number
    bond_thickness?: number
    incomplete_periodic_edge_mode?: boolean
    incomplete_edge_length_scale?: number
    hide_incomplete_bonds?: boolean
    show_image_atoms?: boolean
    bond_color?: string
    bonding_strategy?: BondingStrategy
    bonding_options?: Record<string, unknown>
    bond_order_perception?: boolean
    bond_scale?: number
    show_hydrogen_bonds?: boolean
    hbond_distance_cutoff?: number
    hbond_angle_cutoff?: number
    hbond_thickness?: number
    property_colors?: AtomPropertyColors | null
    fov?: number
    ambient_light?: number
    directional_light?: number
    depth_cueing?: number
    depth_cue_start?: number
    depth_cue_end?: number
    atom_outline_strength?: number
    bond_outline_strength?: number
    render_style?: RenderStyle // material/shading style for atoms (glossy | matte | toon)
    matcap_preset?: string // matcap variant (only used when render_style === 'matcap')
    light_azimuth?: number // headlamp azimuth in degrees (view-space) — legacy flat fallback seed
    light_elevation?: number // headlamp elevation in degrees (view-space) — legacy flat fallback seed
    highlight_strength?: number // specular highlight multiplier (uSpecStrength) — legacy flat fallback seed
    // Per-render-style lighting profiles — source of truth for the 5 lighting
    // params (active profile = lighting_profiles[render_style]). The flat
    // light_*/…/highlight_strength props above are only the fallback seed.
    lighting_profiles?: Record<RenderStyle, LightingProfile>
    background_color?: string | undefined
    background_opacity?: number
    sphere_segments?: number
    lattice_props?: ComponentProps<typeof Lattice>
    atom_label?: Snippet<[Site, number]>
    site_label_size?: number
    site_label_offset?: Vec3
    site_label_bg_color?: string
    site_label_color?: string
    site_label_padding?: number
    camera_is_moving?: boolean // used to prevent tooltip from showing while camera is moving
    pixels_per_angstrom?: number // scale bar: Å-to-pixel ratio, updated per frame
    width?: number // Viewer dimensions for responsive zoom
    height?: number
    // measurement props
    measure_mode?: `distance` | `angle` | `dihedral`
    measure_mode_active?: boolean // Continuous measurement mode
    on_continuous_measure_click?: (site_idx: number) => void // Callback for continuous measurement clicks
    selected_sites?: number[]
    measured_sites?: number[]
    // Multiple independent measurements
    measurements?: { id: string; type: 'distance' | 'angle' | 'dihedral'; sites: number[] }[]
    selected_measurement_id?: string | null
    on_measurement_select?: (id: string | null) => void
    selection_highlight_color?: string
    // Support for active highlight group with different color
    active_sites?: number[]
    active_highlight_color?: string
    rotation?: Vec3 // rotation control prop
    // Expose scene and camera for external use (e.g., export pane)
    scene?: Scene
    camera?: Camera
    orbit_controls?: any // OrbitControls or TrackballControls instance
    rotation_target_ref?: Vec3 // Expose rotation target for reset
    initial_computed_zoom?: number // Expose initial zoom for reset
    center_camera_trigger?: number // Increment this to trigger camera centering
    lattice_align_trigger?: number // Increment to align camera with lattice a×b normal
    reset_camera_up_trigger?: number // Increment to reset camera.up to [0,0,1] (Z-up) after slab cut
    repaint_trigger?: number // Increment to force ONE WebGL repaint (no side effects)
    hidden_elements?: Set<ElementSymbol>
    hidden_sites?: Set<number> // Track hidden individual sites (by site index)
    hidden_prop_vals?: Set<number | string> // Track hidden property values (e.g. coordination numbers, Wyckoff positions, charges)
    axis_lock_active?: boolean // Disable OrbitControls when axis-locked rotation is active
    external_dragging?: boolean // External dragging state (from parent component)
    on_reset_rotation?: () => void // Called when gizmo clicked to reset structure rotation
    on_atom_context_menu?: (
      site_idx: number,
      position: [number, number, number],
      event: MouseEvent,
    ) => void // Handler for right-click on atoms
    frozen_rotation_target?: Vec3 | null // Frozen rotation target during atom dragging
    hovered?: boolean // Whether the viewer is hovered
    is_box_selecting?: boolean // Whether box selection is in progress
    is_rotating_atoms?: boolean // Whether atoms are being rotated around center of mass
    is_dragging_atom?: boolean // Whether atoms are being dragged
    atom_rotation_center?: Vec3 | null // Rotation pivot point (centroid of selected atoms)
    atom_rotation_axis?: Vec3 | null // Current rotation axis (unit vector)
    atom_rotation_angle_deg?: number // Current cumulative rotation angle in degrees
    // Realtime position overrides for drag/rotate - bypasses structure updates for performance
    realtime_position_overrides?: Map<number, Vec3> | null
    // Active trajectory frame index (>= 0 when a trajectory is loaded; -1
    // otherwise). The "rendering a trajectory frame" signal for the slow-path
    // bond effect — variable-N trajectories have no `trajectory_frame_positions`.
    trajectory_step_idx?: number
    // Trajectory fast-path: flat Float32Array of positions (x,y,z triples) for current frame
    // When set, only position buffers are updated in AtomImpostors and bonds
    trajectory_frame_positions?: Float32Array | null
    // Trajectory fast-path: flat Float32Array of forces (fx,fy,fz) per atom
    trajectory_frame_forces?: Float32Array | null
    // Per-frame bond connectivity (from trajectory bond cache). Null = fall back to static.
    trajectory_bond_connectivity?: Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }> | null
    /** WebGPU large-system overlay active. When true the WebGL scene is fully
     *  covered by the overlay and `autoRender` is off, so this scene must do
     *  ZERO per-frame work: the trajectory bond-pair rebuild is skipped. Read
     *  reactively in the gated effect so toggle-OFF re-fires it and the scene
     *  resumes correctly. Default false ⇒ unchanged WebGL behavior. */
    webgl_suspended?: boolean
    // Cutting plane visualization for Miller slab cutter
    cutting_active?: boolean
    cutting_plane_normal?: Vec3
    cutting_plane_offset?: number
    cutting_plane_thickness?: number
    cutting_atom_visibility?: { site_idx: number; inside_slab: boolean; opacity: number; saturation: number }[]
    cutting_flash_intensity?: number
    cutting_miller_label?: string
    // WYSIWYG slab preview
    cutting_slab_preview?: import('./miller-slab').SlabPreviewStructure | null
    cutting_preview_mode?: 'slab'
    cutting_show_bonds?: boolean
    // Adsorption site visualization
    adsorption_sites?: import('./ferrox-wasm-types').AdsorptionSite[]
    show_adsorption_sites?: boolean
    selected_adsorption_site_idx?: number | null
    adsorption_site_radius?: number
    adsorption_site_opacity?: number
    on_delete_adsorption_site?: (site_id: number) => void
    adsorption_site_placement_mode?: boolean
    on_adsorption_site_click?: (site_idx: number) => void
    // Pencil/draw mode props
    pencil_mode_active?: boolean
    pencil_ghost_atom?: {
      element: ElementSymbol
      position: Vec3
      visible: boolean
      anchor_position: Vec3 | null
      anchor_idx: number | null
    } | null
    on_pencil_atom_click?: (site_idx: number, position: Vec3, event: PointerEvent) => void
    // Bond editing mode props
    bond_mode_active?: boolean
    manual_bonds?: import('./index').ManualBond[]
    bond_manager?: BondManager
    /** Atom-delete fast-path hook populated by StructureScene (phase X5). */
    atom_fast_ops?: AtomFastOps | null
    /** Plan v3 Phase 1: atom_manager $bindable for parent-driven position writes. */
    atom_manager?: AtomManager
    /** WebGPU overlay bridge: getter returning the live per-displayed-atom
     *  current-frame position array (3 × n_displayed) the WebGL view renders. */
    get_displayed_frame_positions?: (() => Float32Array) | null
    deleted_bond_keys?: Set<string>
    selected_bonds?: import('./index').SelectedBond[]
    bond_first_atom?: number | null
    on_bond_atom_click?: (site_idx: number) => void
    on_bond_select?: (bond: import('./index').SelectedBond | null) => void
    on_bond_drag_start?: (site_idx: number, event: PointerEvent) => void
    on_bond_drag_end?: (site_idx: number) => void
    bond_drag_active?: boolean
    bond_ghost_end?: Vec3 | null
    bond_distance_rules?: import('./index').BondDistanceRule[]
    filtered_bond_pairs_out?: import('./index').BondPair[]
    selection_opacity?: number
    atom_opacity_overrides?: Map<number, number>
    bond_opacity_overrides?: Map<string, number>
    image_atom_opacity?: number
    // Image atom mapping (for displaying correct labels on periodic images)
    num_original_sites?: number
    image_to_original_map?: number[]
    // Per-atom charge labels
    visible_charge_labels?: Set<number>
    show_charge_labels?: boolean
    charge_label_offsets?: SvelteMap<number, [number, number]>
    charge_label_colors?: Map<number, { text?: string; bg?: string }>
    on_charge_label_offset_change?: (idx: number, offset: [number, number]) => void
    on_charge_value_edit?: (idx: number, value: number) => void
    on_charge_label_remove?: (idx: number) => void
    on_charge_label_contextmenu?: (idx: number, x: number, y: number) => void
    // Polyhedra visualization
    show_polyhedra?: boolean
    polyhedra_center_elements?: string[]
    polyhedra_min_coordination?: number
    polyhedra_max_neighbors?: number
    polyhedra_bond_scale?: number
    polyhedra_metals_only?: boolean
    polyhedra_style?: import('$lib/settings').PolyhedraStyle
    polyhedra_color_mode?: import('$lib/settings').PolyhedraColorMode
    polyhedra_color?: string
    polyhedra_show_edges?: boolean
    polyhedra_opacity_mode?: import('$lib/settings').PolyhedraOpacityMode
    polyhedra_opacity?: number
    polyhedra_opacity_near?: number
    polyhedra_opacity_far?: number
    polyhedra_edge_opacity?: number
    polyhedra_edge_color?: string
    polyhedra_edge_width?: number
    polyhedra_color_overrides?: Record<string, string>
    hide_polyhedra_center_atoms?: boolean
    hide_polyhedra_internal_bonds?: boolean
    // MOF analysis
    mof_clusters?: MofClusters | null
    isolated_node_atoms?: Set<number> | null
    isolation_outside_opacity?: number
    // Sphere clipping
    clip_active?: boolean
    clip_center?: Vec3 | null
    clip_radius?: number
    clip_outside_mode?: `hide` | `transparent`
    clip_outside_opacity?: number
    // Cube file isosurface overlay
    cube_positive_mesh?: import('$lib/cube').CubeMesh | null
    cube_negative_mesh?: import('$lib/cube').CubeMesh | null
    cube_show_positive?: boolean
    cube_show_negative?: boolean
    cube_positive_color?: string
    cube_negative_color?: string
    cube_opacity?: number
    cube_wireframe?: boolean
    // Cube slice plane preview
    cube_slice_normal?: [number, number, number] | null
    cube_slice_center?: [number, number, number] | null
    cube_show_slice_plane?: boolean
    cube_slice_plane_size?: number
    cube_slice_color?: string
    // Vibration mode animation
    vibration_data?: { eigenvector: number[][]; base_positions: number[][]; amplitude: number; playing: boolean } | null
  } = $props()

  const threlte = useThrelte()

  // ─── Render-loop refactor (R2): single point of canvas-paint truth ───
  // All scene-mutating callsites in this file (and its controllers) MUST
  // route through `mark_dirty()` instead of `threlte.invalidate()`. This
  // gives us:
  //   - One place to add observability (the DEV counter below).
  //   - One symbol to grep for when auditing "where do we ask for paint?"
  //   - A future hook point for batching / scheduler-aware invalidation
  //     without re-touching every callsite.
  // `threlte.invalidate()` is already idempotent within a frame
  // (node_modules/@threlte/core/dist/scheduler.svelte.js: `frameInvalidated
  // = true`), so no microtask coalescer is needed.
  //
  // Tests assert `globalThis.__invalidate_count` to verify exact paints
  // per user mutation. Reset between assertions via
  // `globalThis.__reset_invalidate_count()`.
  function mark_dirty(): void {
    threlte.invalidate()
    if (import.meta.env?.DEV) {
      const g = globalThis as unknown as { __invalidate_count?: number }
      g.__invalidate_count = (g.__invalidate_count ?? 0) + 1
    }
  }
  if (import.meta.env?.DEV) {
    const g = globalThis as unknown as {
      __invalidate_count?: number
      __reset_invalidate_count?: () => void
    }
    g.__invalidate_count ??= 0
    g.__reset_invalidate_count = () => { g.__invalidate_count = 0 }
  }

  $effect(() => {
    scene = threlte.scene
    camera = threlte.camera.current
    if (threlte.scene) {
      threlte.scene.background = null
    }
    if (threlte.renderer) {
      // Also expose scene/camera on the canvas (alongside __renderer) so
      // export helpers can take the reliable gl.readPixels render path even
      // when a caller doesn't thread scene/camera through props (e.g. the
      // trajectory export pane). Without these, exports fall back to
      // canvas.toBlob() on a non-preserveDrawingBuffer WebGL canvas and
      // produce blank/transparent output.
      Object.assign(threlte.renderer.domElement, {
        __renderer: threlte.renderer,
        __scene: threlte.scene,
        __camera: threlte.camera.current,
      })
    }
  })

  // Explicitly release WebGL context on unmount.
  // Threlte's onDestroy calls renderer.dispose() but that may not fire reliably
  // in Svelte 5 conditional blocks ({#if}). Using $effect cleanup ensures the
  // WebGL context is freed, preventing "too many active WebGL contexts" errors
  // when workflow node panels are switched frequently.
  $effect(() => {
    const renderer = threlte.renderer
    if (!renderer) return
    return () => {
      renderer.dispose()
      const gl = renderer.domElement.getContext(`webgl2`) ?? renderer.domElement.getContext(`webgl`)
      gl?.getExtension(`WEBGL_lose_context`)?.loseContext()
    }
  })

  // Sync renderer clear color with the effective CSS background.
  // Canvas uses alpha:false (opaque) to avoid compositing glitches caused by
  // the Gizmo's multi-pass rendering toggling autoClear on a transparent canvas.
  // Walk DOM to resolve theme background (alpha >= 0.5 wins).
  function find_theme_bg(): Color {
    const r = threlte.renderer
    const canvas = r?.domElement
    let el: HTMLElement | null = canvas ?? null
    while (el) {
      const bg = getComputedStyle(el).backgroundColor
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
      if (m) {
        const a = m[4] !== undefined ? parseFloat(m[4]) : 1
        if (a >= 0.5) {
          return new Color(+m[1] / 255, +m[2] / 255, +m[3] / 255)
        }
      }
      el = el.parentElement
    }
    return new Color(0x000000)
  }

  // Resolve the visible canvas background. Both sync_clear_color and the fog
  // uniform must produce the same color so depth-cued atoms truly fade INTO
  // the painted bg. Treat unset background_color as #000000 (matches the
  // default <input type="color"> swatch) so the opacity slider is always live.
  function compute_canvas_bg(target: Color): Color {
    const picked = new Color(background_color ?? `#000000`)
    const t = Math.max(0, Math.min(1, background_opacity))
    if (t >= 0.999) return target.copy(picked)
    if (t <= 0.001) return target.copy(find_theme_bg())
    return target.copy(find_theme_bg()).lerp(picked, t)
  }

  // Sync renderer clear color with background_color/opacity. Canvas is
  // alpha:false (opaque) so `background_opacity` is treated as override
  // strength: 0 → theme bg, 1 → picked, mid → lerp.
  const __scratch_bg = new Color()
  function sync_clear_color() {
    const r = threlte.renderer
    if (!r) return
    compute_canvas_bg(__scratch_bg)
    r.setClearColor(__scratch_bg, 1)
    // Keep fog target in lockstep — same color object computation, no
    // dependency on effect ordering between sync_clear_color and the fog
    // uniform updater.
    depth_cue_uniforms.uDepthCueBgColor.value.copy(__scratch_bg)
    mark_dirty()
  }

  // Re-run when background_color or background_opacity prop changes
  $effect(() => {
    void background_color; void background_opacity
    sync_clear_color()
  })

  // One-shot WebGL repaint on demand. The large-system overlay pauses this
  // canvas's autoRender while it covers the view; when the overlay closes the
  // parent bumps repaint_trigger so the resumed (on-demand) render loop paints
  // the current scene once. mark_dirty() = threlte.invalidate(); no other side
  // effects (no camera move). Default 0 ⇒ this never fires unless bumped.
  let _last_repaint_trigger = repaint_trigger
  $effect(() => {
    if (repaint_trigger === _last_repaint_trigger) return
    _last_repaint_trigger = repaint_trigger
    mark_dirty()
  })

  $effect(() => {
    const r = threlte.renderer
    if (!r) return

    sync_clear_color()

    // Re-sync when theme changes (class/attribute changes on html or body)
    const observer = new MutationObserver(() => {
      requestAnimationFrame(() => sync_clear_color())
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [`class`, `data-theme`, `style`] })
    observer.observe(document.body, { attributes: true, attributeFilter: [`class`, `data-theme`, `style`] })

    return () => observer.disconnect()
  })

  let locked_rotation_pivot = $state<Vec3>([0, 0, 0])

  function copy_vec3(v: Vec3 | undefined | null): Vec3 {
    return v ? [v[0], v[1], v[2]] : [0, 0, 0]
  }

  function vector_to_vec3(v: Vector3): Vec3 {
    return [v.x, v.y, v.z] as Vec3
  }

  function clear_trackball_rotation_inertia() {
    const ctrl = orbit_controls as any
    if (!ctrl) return
    ctrl._lastAngle = 0
    if (ctrl._lastAxis) ctrl._lastAxis.set(0, 0, 0)
  }

  function sync_trackball_reset_refs() {
    if (!orbit_controls || !camera) return
    const ctrl = orbit_controls as any
    if (ctrl._target0 && orbit_controls.target) ctrl._target0.copy(orbit_controls.target)
    if (ctrl._eye0 && orbit_controls.target) {
      ctrl._eye0.subVectors(camera.position, orbit_controls.target)
    }
    if (ctrl._up0) ctrl._up0.copy(camera.up)
  }

  function sync_current_camera_target_from_controls() {
    if (!orbit_controls?.target) return
    current_camera_target = vector_to_vec3(orbit_controls.target)
  }

  function finish_camera_change(next_target?: Vec3 | null) {
    if (next_target) current_camera_target = copy_vec3(next_target)
    else sync_current_camera_target_from_controls()
    snapshot_view()
    clear_trackball_rotation_inertia()
    sync_trackball_reset_refs()
    mark_dirty()
  }

  function get_locked_rotation_pivot_vector(): Vector3 {
    return new Vector3(...locked_rotation_pivot)
  }

  function apply_camera_rotation_about_locked_pivot(q: Quaternion) {
    if (!camera || !orbit_controls?.target) return
    const pivot = get_locked_rotation_pivot_vector()
    const target = orbit_controls.target as Vector3

    const camera_offset = camera.position.clone().sub(pivot).applyQuaternion(q)
    camera.position.copy(pivot).add(camera_offset)

    const target_offset = target.clone().sub(pivot).applyQuaternion(q)
    target.copy(pivot).add(target_offset)

    camera.up.applyQuaternion(q).normalize()
    camera.lookAt(target)
    camera.updateMatrixWorld(true)
    finish_camera_change(vector_to_vec3(target))
  }

  type TrackballViewState = {
    position: Vector3
    target: Vector3
    up: Vector3
  }

  let trackball_view_state: TrackballViewState | null = null

  const TRACKBALL_STATE_NONE = -1
  const TRACKBALL_STATE_ROTATE = 0
  const TRACKBALL_STATE_TOUCH_ROTATE = 3

  function capture_trackball_view_state() {
    if (!camera || !orbit_controls?.target) return
    trackball_view_state = {
      position: camera.position.clone(),
      target: orbit_controls.target.clone(),
      up: camera.up.clone(),
    }
  }

  function trackball_is_rotating() {
    const ctrl = orbit_controls as any
    if (!ctrl) return false
    const key_state = ctrl.keyState ?? TRACKBALL_STATE_NONE
    const state = key_state !== TRACKBALL_STATE_NONE
      ? key_state
      : (ctrl.state ?? TRACKBALL_STATE_NONE)
    return state === TRACKBALL_STATE_ROTATE ||
      state === TRACKBALL_STATE_TOUCH_ROTATE ||
      (state === TRACKBALL_STATE_NONE && Math.abs(ctrl._lastAngle ?? 0) > 1e-7)
  }

  // Full view-frame orientation (eye direction + up), so the recovered rotation
  // includes the roll component TrackballControls produces on curved drags.
  // A two-vector minimal-arc quaternion (setFromUnitVectors on eye alone) would
  // silently drop that roll and the rebased view would drift from the user's drag.
  function view_frame_quaternion(eye: Vector3, up: Vector3): Quaternion | null {
    const z_axis = eye.clone().normalize()
    const x_axis = new Vector3().crossVectors(up, z_axis)
    if (x_axis.lengthSq() < 1e-10) return null // up parallel to eye — degenerate frame
    x_axis.normalize()
    const y_axis = new Vector3().crossVectors(z_axis, x_axis)
    return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x_axis, y_axis, z_axis))
  }

  function rebase_trackball_rotation_to_locked_pivot() {
    if (!camera || !orbit_controls?.target || !trackball_view_state) return
    if (!trackball_is_rotating()) return

    const prev_eye = trackball_view_state.position.clone().sub(trackball_view_state.target)
    const next_eye = camera.position.clone().sub(orbit_controls.target)
    if (prev_eye.lengthSq() < 1e-10 || next_eye.lengthSq() < 1e-10) return

    const q_prev = view_frame_quaternion(prev_eye, trackball_view_state.up)
    const q_next = view_frame_quaternion(next_eye, camera.up)
    if (!q_prev || !q_next) return
    // World-frame rotation that carries the previous view frame onto the new one.
    const q = q_next.multiply(q_prev.invert())
    const pivot = get_locked_rotation_pivot_vector()
    const target = orbit_controls.target as Vector3

    const corrected_target = pivot.clone()
      .add(trackball_view_state.target.clone().sub(pivot).applyQuaternion(q))
    const corrected_position = pivot.clone()
      .add(trackball_view_state.position.clone().sub(pivot).applyQuaternion(q))

    target.copy(corrected_target)
    camera.position.copy(corrected_position)
    camera.up.copy(trackball_view_state.up.clone().applyQuaternion(q)).normalize()
    camera.lookAt(target)
    camera.updateMatrixWorld(true)

    const ctrl = orbit_controls as any
    if (ctrl._eye) ctrl._eye.subVectors(camera.position, target)
  }

  function handle_trackball_change() {
    rebase_trackball_rotation_to_locked_pivot()
    sync_current_camera_target_from_controls()
    snapshot_view()
    sync_trackball_reset_refs()
    capture_trackball_view_state()
  }

  // Expose the stable rotation pivot for external reset/gesture handlers.
  $effect(() => {
    rotation_target_ref = locked_rotation_pivot
  })

  // Track the last trigger value to detect changes
  let last_center_trigger = $state(0)
  // Track whether initial camera target has been set
  let initial_target_set = $state(false)
  // Current camera look-at point. It can drift away from the structure pivot when the user pans.
  let current_camera_target = $state<Vec3>([0, 0, 0])

  function get_atom_bounds_center(structure: AnyStructure | undefined): Vec3 | null {
    if (!structure?.sites?.length) return null
    let min_x = Infinity, max_x = -Infinity
    let min_y = Infinity, max_y = -Infinity
    let min_z = Infinity, max_z = -Infinity
    for (const site of structure.sites) {
      const [x, y, z] = site.xyz
      if (x < min_x) min_x = x; if (x > max_x) max_x = x
      if (y < min_y) min_y = y; if (y > max_y) max_y = y
      if (z < min_z) min_z = z; if (z > max_z) max_z = z
    }
    return [(min_x + max_x) / 2, (min_y + max_y) / 2, (min_z + max_z) / 2]
  }

  function get_camera_fit_target(): Vec3 {
    return get_atom_bounds_center(structure) ?? rotation_target ?? [0, 0, 0]
  }

  // Apply target to orbit controls imperatively (outside reactive tracking).
  // Uses untrack to avoid Svelte proxy reads on Three.js internals causing
  // cascading reactive updates that freeze the app.
  function apply_orbit_target(target: Vec3) {
    untrack(() => {
      if (!orbit_controls?.target) return
      orbit_controls.target.set(...target)
      current_camera_target = copy_vec3(target)
      clear_trackball_rotation_inertia()
      sync_trackball_reset_refs()
      orbit_controls.update?.()
      // mark_dirty: imperative orbit_controls.target.set + .update() bypasses <T.> prop chain
      mark_dirty()
    })
  }

  // Set camera.up to Z-axis once camera + controls are both ready.
  // MUST be declared BEFORE the orbit target effect below — Svelte 5 fires effects
  // in declaration order, and orbit_controls.update() calls camera.lookAt() which
  // needs the correct up vector already set.
  let _initial_up_set = false
  $effect(() => {
    if (_initial_up_set || !camera || !orbit_controls) return
    _initial_up_set = true
    camera.up.set(0, 0, 1)
    const ctrl = orbit_controls as any
    if (ctrl._up0) ctrl._up0.set(0, 0, 1)
    orbit_controls.update?.()
  })

  // Lock the rotation pivot on initial structure load or explicit recenter.
  // Regular structure edits do not move this pivot, so adding/removing atoms does
  // not make the camera rotation center jump.
  $effect(() => {
    const base_target = structure ? structure_rotation_center : [0, 0, 0] as Vec3
    // Track orbit_controls to re-run when it becomes available
    const controls_ready = !!orbit_controls?.target

    if (!structure) {
      locked_rotation_pivot = [0, 0, 0]
      current_camera_target = [0, 0, 0]
      initial_target_set = false
      _did_initial_structure_fit = false
      last_center_trigger = center_camera_trigger
      if (controls_ready) apply_orbit_target([0, 0, 0])
      return
    }

    if (!initial_target_set) {
      locked_rotation_pivot = copy_vec3(base_target)
      current_camera_target = get_camera_fit_target()
      last_center_trigger = center_camera_trigger
      if (controls_ready) {
        apply_orbit_target(current_camera_target)
        initial_target_set = true
      }
      return
    }

    if (center_camera_trigger === last_center_trigger) return
    last_center_trigger = center_camera_trigger
    locked_rotation_pivot = copy_vec3(base_target)
    apply_orbit_target(get_camera_fit_target())
  })

  // Reset camera to default +Z viewing direction when lattice_align_trigger changes.
  let last_align_trigger = $state(0)
  $effect(() => {
    if (lattice_align_trigger === last_align_trigger) return
    last_align_trigger = lattice_align_trigger

    requestAnimationFrame(() => {
      if (!camera || !orbit_controls) return

      const center = new Vector3(...(structure_rotation_center || [0, 0, 0]))
      const dist = camera.position.distanceTo(orbit_controls.target || new Vector3())
      const cam_distance = Math.max(dist, 1)
      const cam_pos = center.clone().add(new Vector3(0, 0, cam_distance))

      camera.position.copy(cam_pos)
      camera.up.set(0, 1, 0)
      camera.lookAt(center)

      orbit_controls.target.copy(center)
      if ((orbit_controls as any)._target0) {
        ;(orbit_controls as any)._target0.copy(center)
      }
      if ((orbit_controls as any)._eye0) {
        ;(orbit_controls as any)._eye0.copy(new Vector3(0, 0, cam_distance))
      }
      if ((orbit_controls as any)._up0) {
        ;(orbit_controls as any)._up0.set(0, 1, 0)
      }
      const ctrl = orbit_controls as any
      if (ctrl._lastAxis) ctrl._lastAxis.set(0, 0, 0)
      ctrl._lastAngle = 0
      orbit_controls.update()

      locked_rotation_pivot = vector_to_vec3(center)
      current_camera_target = vector_to_vec3(center)
      last_center_trigger = center_camera_trigger
      // mark_dirty: imperative camera.position/up/lookAt + orbit_controls.update() bypass <T.> prop chain
      mark_dirty()
    })
  })

  // Restore the view when the projection type changes. The {#if camera_projection}
  // block fully remounts the camera + TrackballControls, so the new controls lose
  // the orbit target (reset to origin) and the camera lands on the stale
  // `camera_position` prop — the structure jumps off-centre, rescales, and tilts,
  // and switching back doesn't undo it. We re-centre on the structure, re-fit the
  // distance, and preserve the user's current view direction + up (snapshotted on
  // the previous camera before the swap).
  // Capture the live camera view BEFORE a projection change remounts the camera.
  // $effect.pre runs prior to DOM mutations, so `camera`/`orbit_controls` are still
  // the OLD instances here and reflect the user's current orientation/zoom — even
  // if they never moved the camera (onchange/onend wouldn't have fired).
  //
  // These _view_* are declared HERE, ABOVE the $effect.pre that calls
  // snapshot_view(). An $effect.pre's body can run during component init before
  // the script reaches a later `let` (notably under HMR re-init), so keeping the
  // declarations after the effect caused a temporal-dead-zone crash:
  // "Cannot access '_view_dir' before initialization". snapshot_view() (a
  // function declaration) hoists fine; only these `let`s needed moving up.
  let _view_dir = new Vector3(0, -1, 0)
  let _view_up = new Vector3(0, 0, 1)
  let _view_target: Vector3 | null = null
  let _view_vheight = 0  // visible world-height at the target plane (projection-independent)
  $effect.pre(() => {
    void camera_projection // dependency: re-run whenever the projection is about to change
    untrack(() => snapshot_view())
  })

  let _last_projection: typeof camera_projection | undefined
  $effect(() => {
    const proj = camera_projection
    if (_last_projection === undefined) { _last_projection = proj; return }  // skip initial mount
    if (proj === _last_projection) return
    _last_projection = proj
    // Two rAFs: the first lets the new camera + TrackballControls finish mounting
    // (bind:ref updates), the second applies the restored view after Threlte has
    // written its declarative props, so our imperative values win.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!camera || !orbit_controls?.target) return
      const cam = camera as any
      // Preserve the user's pan (look-at point) if they moved; else re-centre on the structure.
      const center = _view_target ? _view_target.clone() : new Vector3(...(current_camera_target || rotation_target || [0, 0, 0]))
      const dir = (_view_dir.lengthSq() > 1e-6 ? _view_dir.clone() : new Vector3(0, -1, 0)).normalize()

      if (cam.isPerspectiveCamera) {
        // Match the previous apparent size: distance = vheight / (2·tan(fov/2)).
        const fov_rad = (cam.fov || fov) * Math.PI / 180
        const dist = _view_vheight > 0
          ? _view_vheight / (2 * Math.tan(fov_rad / 2))
          : Math.max(1, structure_size) * (60 / fov)
        camera.position.copy(center).addScaledVector(dir, dist)
      } else if (cam.isOrthographicCamera) {
        // Distance is irrelevant to ortho scale; keep a stable viewpoint and set
        // zoom to reproduce the previous apparent size.
        camera.position.copy(center).addScaledVector(dir, Math.max(1, structure_size) * 2)
        if (_view_vheight > 0 && (cam.top - cam.bottom) !== 0) {
          cam.zoom = (cam.top - cam.bottom) / _view_vheight
          cam.updateProjectionMatrix()
        }
      }
      camera.up.copy(_view_up).normalize()
      camera.lookAt(center)
      orbit_controls.target.copy(center)
      current_camera_target = vector_to_vec3(center)
      const ctrl = orbit_controls as any
      ctrl._target0?.copy(center)
      ctrl._eye0?.copy(new Vector3().subVectors(camera.position, center))
      ctrl._up0?.copy(camera.up)
      // Clear any pending TrackballControls rotation so update() doesn't re-apply
      // a leftover delta and nudge the camera off the exact axis (the "not true y"
      // gap on round-trip).
      if (ctrl._lastAxis) ctrl._lastAxis.set(0, 0, 0)
      ctrl._lastAngle = 0
      orbit_controls.update?.()
      // mark_dirty: imperative camera + orbit_controls writes bypass the <T.> prop chain
      mark_dirty()
    }))
  })

  // Re-apply orbit target when component becomes visible again (tab switch).
  let prev_canvas_visible = $state(false)
  $effect(() => {
    const is_visible = width > 0 && height > 0
    const was_hidden = !prev_canvas_visible
    prev_canvas_visible = is_visible
    if (was_hidden && is_visible && orbit_controls && current_camera_target) {
      apply_orbit_target(current_camera_target)
    }
  })

  // Do not auto-recenter when the look-at target drifts from the structure pivot:
  // that drift is exactly the user's pan offset (current_camera_target now tracks
  // panning via the TrackballControls onchange handler, so the old divergence
  // check would undo any pan larger than 2 Å). Explicit recenter/reset paths
  // update both current_camera_target and locked_rotation_pivot above.

  // Keep TrackballControls reset points (_target0, _eye0, _up0) synchronized with current state
  // This prevents the camera from snapping back to an outdated position on any reset-like operation
  // (e.g., when user Ctrl+clicks after panning the view)
  $effect(() => {
    if (!orbit_controls) return
    sync_trackball_reset_refs()
  })

  // Reset camera.up to [0,0,1] (Z-up) when triggered (e.g., after slab cut reorients the structure).
  // Done here in StructureScene where camera/orbit_controls are direct Three.js refs,
  // not Svelte proxies (which can't call .set() on Vector3).
  let _last_up_trigger = 0
  $effect(() => {
    if (reset_camera_up_trigger === _last_up_trigger) return
    _last_up_trigger = reset_camera_up_trigger
    if (!camera || !orbit_controls) return
    camera.up.set(0, 0, 1)
    const ctrl = orbit_controls as any
    if (ctrl._up0) ctrl._up0.set(0, 0, 1)
    if (ctrl._lastAxis) ctrl._lastAxis.set(0, 0, 0)
    ctrl._lastAngle = 0
    if (ctrl.target) camera.lookAt(ctrl.target)
    if (typeof ctrl.update === `function`) ctrl.update()
    // mark_dirty: imperative camera.up + camera.lookAt + orbit_controls.update() bypass <T.> prop chain
    mark_dirty()
  })

  // Track initial computed zoom for reset
  let stored_initial_zoom = $state<number | undefined>(undefined)
  $effect(() => {
    if (stored_initial_zoom === undefined && computed_zoom > 0) {
      stored_initial_zoom = computed_zoom
    }
    initial_computed_zoom = stored_initial_zoom
  })

  let bond_pairs: BondPair[] = $state([])
  let active_tooltip = $state<`atom` | `bond` | null>(null)
  let hovered_bond_key = $state<string | null>(null)

  // Clear stale hovered_bond_key when the bond disappears from filtered_bond_pairs
  $effect(() => {
    if (hovered_bond_key && !filtered_bond_pairs.some(b =>
      get_bond_key(b.site_idx_1, b.site_idx_2) === hovered_bond_key
    )) {
      hovered_bond_key = null
    }
  })

  // Frozen atom ring rotation - updated each frame in pencil mode to face camera.
  // Compensates for structure rotation so rings always face camera in world coordinates.
  let frozen_ring_rotation: [number, number, number] = $state([Math.PI / 2, 0, 0])

  // R3.4: ring rotation tracks camera in real time via per-frame useTask.
  // Gated on pencil_mode_active so the body is a no-op when pencil mode is
  // off. Reusable scratch objects + equality guard mean: zero allocations
  // per frame, zero $state writes when camera is still.
  const __ring_cam_dir = new Vector3()
  const __ring_up = new Vector3(0, 0, 1)
  const __ring_face_quat = new Quaternion()
  const __ring_struct_euler = new Euler()
  const __ring_struct_quat = new Quaternion()
  const __ring_inverse_struct_quat = new Quaternion()
  const __ring_local_quat = new Quaternion()
  const __ring_out_euler = new Euler()
  let __ring_last_x = NaN
  let __ring_last_y = NaN
  let __ring_last_z = NaN
  const __RING_EPS = 1e-6
  useTask(() => {
    if (!pencil_mode_active) return
    const cam = threlte.camera.current
    if (!cam) return
    // Calculate world-space rotation to face camera
    __ring_cam_dir.copy(cam.position).normalize()
    __ring_face_quat.setFromUnitVectors(__ring_up, __ring_cam_dir)
    // Compensate for structure rotation (rings are inside rotated T.Group)
    // R_local = R_structure^-1 * R_world
    __ring_struct_euler.set(rotation[0], rotation[1], rotation[2], 'XYZ')
    __ring_struct_quat.setFromEuler(__ring_struct_euler)
    __ring_inverse_struct_quat.copy(__ring_struct_quat).invert()
    __ring_local_quat.copy(__ring_inverse_struct_quat).multiply(__ring_face_quat)
    __ring_out_euler.setFromQuaternion(__ring_local_quat)
    const ex = __ring_out_euler.x
    const ey = __ring_out_euler.y
    const ez = __ring_out_euler.z
    if (
      Number.isNaN(__ring_last_x) ||
      Math.abs(ex - __ring_last_x) > __RING_EPS ||
      Math.abs(ey - __ring_last_y) > __RING_EPS ||
      Math.abs(ez - __ring_last_z) > __RING_EPS
    ) {
      frozen_ring_rotation = [ex, ey, ez]
      __ring_last_x = ex
      __ring_last_y = ey
      __ring_last_z = ez
    }
  }, { autoInvalidate: false })

  // Keyboard rotation controls - screen-relative axes (trackball-style)
  function handle_keyboard_rotation(event: KeyboardEvent) {
    const next_target = kbd_rotation(
      event,
      camera,
      orbit_controls,
      selected_sites,
      hovered,
      current_camera_target,
      locked_rotation_pivot,
    )
    if (next_target) finish_camera_change(next_target)
  }

  // Add keyboard listener
  $effect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('keydown', handle_keyboard_rotation)
    return () => {
      window.removeEventListener('keydown', handle_keyboard_rotation)
    }
  })

  // Right-drag roll rotation state
  let roll_drag_state: RollDragState = { is_right_dragging: false, right_drag_prev_x: 0, right_drag_suppress_context: false }

  function handle_scene_roll_start(event: PointerEvent) {
    roll_start(event, roll_drag_state, selected_sites, hovered)
  }
  function handle_scene_roll_move(event: PointerEvent) {
    const next_target = roll_move(
      event,
      roll_drag_state,
      camera,
      orbit_controls,
      current_camera_target,
      locked_rotation_pivot,
    )
    if (next_target) finish_camera_change(next_target)
  }
  function handle_scene_roll_end() {
    roll_end(roll_drag_state)
  }

  // Add right-drag listeners
  $effect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('pointerdown', handle_scene_roll_start)
    window.addEventListener('pointermove', handle_scene_roll_move)
    window.addEventListener('pointerup', handle_scene_roll_end)
    return () => {
      window.removeEventListener('pointerdown', handle_scene_roll_start)
      window.removeEventListener('pointermove', handle_scene_roll_move)
      window.removeEventListener('pointerup', handle_scene_roll_end)
    }
  })

  // Suppress context menu after right-drag roll
  $effect(() => {
    if (typeof window === 'undefined') return
    function suppress_context_menu(event: MouseEvent) {
      if (roll_drag_state.right_drag_suppress_context) {
        event.preventDefault()
        roll_drag_state.right_drag_suppress_context = false
      }
    }
    window.addEventListener('contextmenu', suppress_context_menu)
    return () => window.removeEventListener('contextmenu', suppress_context_menu)
  })

  // Handle gizmo axis alignment to ensure orthogonal view
  // Aligns camera to absolute world XYZ axes and resets structure rotation
  function handle_gizmo_end() {
    if (!camera || !orbit_controls) return

    // Reset structure rotation to absolute coordinates
    on_reset_rotation?.()

    // Use current_camera_target to maintain consistency with user's view
    const target_pos = new Vector3(...current_camera_target)
    const camera_direction = camera.position.clone().sub(target_pos).normalize()

    // Determine which world axis is closest to camera direction
    const abs_x = Math.abs(camera_direction.x)
    const abs_y = Math.abs(camera_direction.y)
    const abs_z = Math.abs(camera_direction.z)

    // Snap to the dominant axis
    let aligned_direction = new Vector3()
    let aligned_up = new Vector3()

    if (abs_x > abs_y && abs_x > abs_z) {
      // X-axis dominant
      aligned_direction.set(Math.sign(camera_direction.x) || 1, 0, 0)
      aligned_up.set(0, 1, 0)
    } else if (abs_y > abs_z) {
      // Y-axis dominant
      aligned_direction.set(0, Math.sign(camera_direction.y) || 1, 0)
      aligned_up.set(0, 0, Math.sign(camera_direction.y) > 0 ? -1 : 1)
    } else {
      // Z-axis dominant
      aligned_direction.set(0, 0, Math.sign(camera_direction.z) || 1)
      aligned_up.set(0, 1, 0)
    }

    // Calculate new camera position
    const distance = camera.position.distanceTo(target_pos)
    const new_camera_pos = aligned_direction.multiplyScalar(distance).add(target_pos)

    // Update camera
    camera.position.copy(new_camera_pos)
    camera.up.copy(aligned_up).normalize()
    camera.lookAt(target_pos)

    // Update controls - use stored target, not reactive rotation_target
    if (orbit_controls.target) {
      orbit_controls.target.set(...current_camera_target)
    }
    if (orbit_controls.update) {
      orbit_controls.update()
    }
    // R3.4: ring rotation now updates per-frame in pencil mode via useTask;
    // no explicit kick needed here.
  }

  function toggle_selection(site_index: number, evt?: Event) {
    // Prevent camera rotation/movement when clicking on atoms
    evt?.stopPropagation?.()

    // WebGPU large-system overlay active: the overlay (pointer-events:none) is the
    // sole selection authority. The same click also reaches the WebGL canvas
    // underneath; if we let the WebGL atom-pick run, it would toggle the site the
    // overlay just selected back OFF (set→toggle-off race) → highlight flashes for
    // one frame then clears. Suppress the WebGL click→selection mutation while
    // suspended. Reactive: toggle-OFF restores normal click selection.
    if (webgl_suspended) return

    const result = toggle_site_selection(site_index, selected_sites)
    if (result === null) {
      console.warn(
        `Selection size limit reached (${measure.MAX_SELECTED_SITES}). Deselect some sites first.`,
      )
      return
    }
    selected_sites = result
  }
  $effect(() => {
    const count = structure?.sites?.length ?? 0
    untrack(() => {
      measured_sites = clean_measured_sites(measured_sites, count)
    })
  })

  // Optimize interactivity: only return the closest hit to reduce processing
  extras.interactivity({
    filter: (hits) => hits.slice(0, 1)
  })
  // Canvas-level hover detection (pointermove only — clicks use Threlte interaction mesh)
  $effect(() => setup_hover_detection())
  $effect.pre(() => {
    hovered_site = structure?.sites?.[hovered_idx ?? -1] ?? null
  })

  let lattice = $derived.by(() => get_lattice_pure(structure))

  let structure_rotation_center = $derived.by(() => (
    structure
      ? get_rotation_center(structure)
      : [0, 0, 0] as Vec3
  ))

  let rotation_target = $derived.by(() => frozen_rotation_target || (
    initial_target_set ? locked_rotation_pivot : structure_rotation_center
  ))



  // Calculate structure size from lattice parameters or matrix
  let structure_size = $derived.by(() => compute_structure_size(lattice))

  // Depth-based color helpers imported from depth-cue-helpers.ts

  // Base camera clipping planes from structure size (used as initial/fallback values)
  let camera_near = $state(0.1)
  let camera_far = $state(1000)

  // Initialize from structure size
  $effect(() => {
    camera_near = Math.max(0.1, structure_size * 0.02)
    camera_far = Math.max(1000, structure_size * 100)
  })

  // Dynamic near/far adjustment based on camera distance to scene center.
  // Maintains a consistent ~1000:1 far/near ratio at any zoom level, preventing
  // depth buffer precision issues that cause atom blinking/Z-fighting when zoomed in.
  useTask(() => {
    const cam = threlte.camera.current
    // 3Dmol-style fog + silhouette outline: track camera distance every
    // frame so fog near/far follow zoom without manual sliders. Runs in
    // both perspective and orthographic mode.
    if (depth_cueing > 0 || atom_outline_strength > 0 || bond_outline_strength > 0) update_depth_cue_uniforms()

    if (!cam || !(cam as any).isPerspectiveCamera) return

    const target = rotation_target ?? [0, 0, 0]
    const dist = Math.hypot(
      cam.position.x - target[0],
      cam.position.y - target[1],
      cam.position.z - target[2],
    )

    // Scale near with distance: 2% of camera distance, minimum 0.1
    const new_near = Math.max(0.1, dist * 0.02)
    // Far must cover the entire structure from any viewpoint
    const new_far = Math.max(dist * 100, structure_size * 20, 100)

    // Only update if values changed meaningfully (avoids unnecessary projection matrix rebuild)
    if (Math.abs((cam as any).near - new_near) / new_near > 0.05 ||
        Math.abs((cam as any).far - new_far) / new_far > 0.05) {
      ;(cam as any).near = new_near
      ;(cam as any).far = new_far
      ;(cam as any).updateProjectionMatrix()
    }

    // Update scale bar projection (camera is mutable, so we do this per-frame)
    if (show_scale_bar && width > 0) {
      const center = rotation_target ?? [0, 0, 0]
      const p1 = new Vector3(...center).project(cam)
      const p2 = new Vector3(center[0] + 1, center[1], center[2]).project(cam)
      const new_ppa = Math.abs(p2.x - p1.x) * width / 2
      // R3.3: equality guard — $state write feeds <ScaleBar> prop chain.
      if (Math.abs(new_ppa - pixels_per_angstrom) > 0.01) {
        pixels_per_angstrom = new_ppa
      }
    }
  }, { autoInvalidate: false })

  // Per-atom charge label rendering
  let editing_charge_site_idx = $state<number | null>(null)
  function auto_focus_charge(node: HTMLInputElement) {
    requestAnimationFrame(() => { node.focus(); node.select() })
  }
  let charge_label_entries = $derived.by(() => {
    // WebGPU overlay active: scene not painting + overlay draws no charge
    // labels → skip the per-frame label recompute (it reads
    // trajectory_frame_positions directly, which the parent still updates each
    // frame). Read suspend reactively so toggle-OFF re-derives for the current
    // frame. Default false ⇒ unchanged.
    if (webgl_suspended) return []
    // Plan v3 follow-up I5: subscribe to atom_manager.version so labels
    // re-derive on per-frame trajectory writes. Under Architecture P
    // structure.sites is frozen at trajectory-load; without this
    // subscription, charge label positions freeze too. Reading from
    // trajectory_frame_positions and atom_manager (in the function's
    // priority chain) ensures labels follow the rendered atoms.
    void atom_manager.version
    return compute_charge_label_entries(
      structure, visible_charge_labels, show_charge_labels,
      num_original_sites, image_to_original_map, realtime_position_overrides,
      trajectory_frame_positions,
      atom_manager,
    )
  })

  // Depth cueing: fade distant atoms/bonds toward background color (VESTA-style).
  // Uses shared uniform objects so updating .value instantly propagates to all patched materials
  // with zero shader recompilation — just a GPU uniform upload per frame.
  const depth_cue_uniforms = {
    uDepthCueing: { value: 0 },
    uDepthNear: { value: 0 },
    uDepthFar: { value: 10 },
    uDepthCueBgColor: { value: new Color(0xffffff) },
    uOutlineStrength: { value: 0 },         // atom shader reads this
    uBondOutlineStrength: { value: 0 },     // bond / dashed-bond shaders read this
  }

  // Patch a MeshStandardMaterial to apply VESTA-style depth cueing in its fragment shader.
  // Called once per material via oncreate; the shared uniforms keep it in sync per-frame.
  function apply_depth_cueing_to_material(mat: MeshStandardMaterial) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDepthCueing = depth_cue_uniforms.uDepthCueing
      shader.uniforms.uDepthNear = depth_cue_uniforms.uDepthNear
      shader.uniforms.uDepthFar = depth_cue_uniforms.uDepthFar
      shader.uniforms.uDepthCueBgColor = depth_cue_uniforms.uDepthCueBgColor
      shader.uniforms.uOutlineStrength = depth_cue_uniforms.uOutlineStrength

      // Vertex: pass view-space depth + view-space normal/position for outline
      shader.vertexShader = shader.vertexShader.replace(
        `#include <common>`,
        `#include <common>
        varying float vDepthCueZ;
        varying vec3 vDepthCueViewPos;
        varying vec3 vDepthCueViewNormal;`,
      )
      shader.vertexShader = shader.vertexShader.replace(
        `#include <fog_vertex>`,
        `#include <fog_vertex>
        vDepthCueZ = -mvPosition.z;
        vDepthCueViewPos = mvPosition.xyz;
        vDepthCueViewNormal = normalize(normalMatrix * objectNormal);`,
      )

      // Fragment: fade toward background color based on depth + silhouette outline.
      // gl_FragColor.rgb at <dithering_fragment> is already sRGB-encoded
      // (colorspace_fragment chunk ran). uDepthCueBgColor is linear (Three.js
      // Color); encode it to sRGB before mixing or fog target won't match
      // the canvas-painted bg color.
      shader.fragmentShader = shader.fragmentShader.replace(
        `#include <common>`,
        `#include <common>
        uniform float uDepthCueing;
        uniform float uDepthNear;
        uniform float uDepthFar;
        uniform vec3 uDepthCueBgColor;
        uniform float uOutlineStrength;
        varying float vDepthCueZ;
        varying vec3 vDepthCueViewPos;
        varying vec3 vDepthCueViewNormal;
        vec3 catgoLinearTosRGB(vec3 c) {
          return vec3(
            c.r <= 0.0031308 ? c.r * 12.92 : 1.055 * pow(c.r, 1.0/2.4) - 0.055,
            c.g <= 0.0031308 ? c.g * 12.92 : 1.055 * pow(c.g, 1.0/2.4) - 0.055,
            c.b <= 0.0031308 ? c.b * 12.92 : 1.055 * pow(c.b, 1.0/2.4) - 0.055
          );
        }`,
      )
      shader.fragmentShader = shader.fragmentShader.replace(
        `#include <dithering_fragment>`,
        `#include <dithering_fragment>
        if (uDepthCueing > 0.0) {
          float fade = clamp((vDepthCueZ - uDepthNear) / max(uDepthFar - uDepthNear, 0.01), 0.0, 1.0) * uDepthCueing;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, catgoLinearTosRGB(uDepthCueBgColor), fade);
        }
        if (uOutlineStrength > 0.0) {
          vec3 viewDir = normalize(-vDepthCueViewPos);
          float NdotV = max(dot(normalize(vDepthCueViewNormal), viewDir), 0.0);
          float silhouette = smoothstep(0.55, 1.0, 1.0 - NdotV);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), silhouette * uOutlineStrength);
        }`,
      )
    }
    mat.needsUpdate = true
  }

  // ── Toon (cel) shading ───────────────────────────────────────────────────
  // Custom 3-band ShaderMaterial ported from AtomCanvas ToonHighlightMaterial
  // (MIT). Adapted to CatGo's NON-instanced per-mesh atom path: the reference
  // folds instanceMatrix/instanceColor/instanceAlpha — none of that applies
  // here, so per-mesh `uColor` + the standard modelViewMatrix path are used.
  // Because swapping away from MeshStandardMaterial drops the onBeforeCompile
  // patch, the silhouette/rim outline AND VESTA depth-cue fade from
  // apply_depth_cueing_to_material are folded directly into the fragment shader
  // and wired to the SAME shared depth_cue_uniforms object, so
  // atom_outline_strength + depth cueing keep driving toon atoms. Self-lit from
  // a view-space headlamp (uLightDir), matching Bond.svelte; scene lights are
  // ignored (matches AtomCanvas Lighting.tsx → null for cartoon). GLSL1-safe.
  const toon_vertex_shader = `
    varying vec3 vNormal;
    varying vec3 vDepthCueViewPos;
    varying float vDepthCueZ;
    void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vDepthCueViewPos = mvPosition.xyz;
      vDepthCueZ = -mvPosition.z;
      gl_Position = projectionMatrix * mvPosition;
    }
  `
  const toon_fragment_shader = `
    uniform vec3 uColor;             // per-mesh atom color (linear)
    uniform vec3 uLightDir;          // view-space headlamp (normalized)
    uniform float uShadowThreshold;
    uniform float uHighlightThreshold;
    uniform float uShadowBrightness;
    uniform float uOpacity;
    uniform float uDepthCueing;
    uniform float uDepthNear;
    uniform float uDepthFar;
    uniform vec3 uDepthCueBgColor;
    uniform float uOutlineStrength;
    varying vec3 vNormal;
    varying vec3 vDepthCueViewPos;
    varying float vDepthCueZ;

    vec3 catgoLinearTosRGB(vec3 c) {
      return vec3(
        c.r <= 0.0031308 ? c.r * 12.92 : 1.055 * pow(c.r, 1.0/2.4) - 0.055,
        c.g <= 0.0031308 ? c.g * 12.92 : 1.055 * pow(c.g, 1.0/2.4) - 0.055,
        c.b <= 0.0031308 ? c.b * 12.92 : 1.055 * pow(c.b, 1.0/2.4) - 0.055
      );
    }

    void main() {
      vec3 normal = normalize(vNormal);
      vec3 lightDir = normalize(uLightDir);
      float diffuse = dot(normal, lightDir);

      // 3-band cel shading (AtomCanvas ToonHighlightMaterial)
      vec3 finalColor;
      if (diffuse > uHighlightThreshold) {
        finalColor = vec3(1.0, 1.0, 1.0);
      } else if (diffuse > uShadowThreshold) {
        finalColor = uColor;
      } else {
        finalColor = uColor * uShadowBrightness;
      }

      // Encode to sRGB so toon atoms match the sRGB-encoded glossy/bond paths.
      gl_FragColor = vec4(catgoLinearTosRGB(finalColor), uOpacity);

      // VESTA depth cueing — folded from apply_depth_cueing_to_material. Bg
      // color is linear (Three.js Color); encode before mixing in sRGB space.
      if (uDepthCueing > 0.0) {
        float fade = clamp((vDepthCueZ - uDepthNear) / max(uDepthFar - uDepthNear, 0.01), 0.0, 1.0) * uDepthCueing;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, catgoLinearTosRGB(uDepthCueBgColor), fade);
      }

      // Silhouette/rim outline — folded from apply_depth_cueing_to_material,
      // driven by the shared uOutlineStrength (= atom_outline_strength).
      if (uOutlineStrength > 0.0) {
        vec3 viewDir = normalize(-vDepthCueViewPos);
        float NdotV = max(dot(normal, viewDir), 0.0);
        float silhouette = smoothstep(0.55, 1.0, 1.0 - NdotV);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), silhouette * uOutlineStrength);
      }
    }
  `

  // Toon ShaderMaterials for the partial-occupancy snippet path (the bulk atom
  // impostor path branches on a uniform instead — see AtomImpostors /
  // AtomManagerInstances `uRenderStyle`). Materials are MEMOIZED per
  // (color, opacity, transparent, double_sided): the snippet re-runs on every
  // cutting-plane drag / desaturation change, and constructing a fresh
  // ShaderMaterial each time leaked the orphaned GPU program (Threlte's `<T is>`
  // swaps the object but never disposes the old one). The arg tuple fully
  // determines the material — depth_cue_uniforms are shared by reference and
  // update in place — so the cache stays small (a handful of partial-occupancy
  // atoms × cutting states) and is disposed wholesale on teardown.
  // ─── Per-render-style lighting profiles ───
  // The 5 lighting params (light_azimuth/elevation, directional/ambient_light,
  // highlight_strength) are PER render_style. lighting_profiles[render_style]
  // is the active profile and the SOURCE OF TRUTH for the values fed to the
  // shaders. Switching render_style reactively swaps the active profile, so the
  // render updates with no extra wiring. The flat light_*/…/highlight_strength
  // props are only a fallback seed (e.g. old persisted settings without a
  // profile map, or non-Structure callers passing flat props).
  const active_lighting = $derived(
    lighting_profiles?.[render_style] ?? {
      light_azimuth,
      light_elevation,
      directional_light,
      ambient_light,
      highlight_strength,
    },
  )
  const active_light_azimuth = $derived(active_lighting.light_azimuth)
  const active_light_elevation = $derived(active_lighting.light_elevation)
  const active_directional_light = $derived(active_lighting.directional_light)
  const active_ambient_light = $derived(active_lighting.ambient_light)
  const active_highlight_strength = $derived(active_lighting.highlight_strength)

  // View-space headlamp direction derived from the ACTIVE profile's azimuth/
  // elevation. Convention: x=right, y=up, z=toward camera.
  //   dir = (cos(el)·sin(az), sin(el), cos(el)·cos(az))   (az,el in radians)
  // Default az=35°, el=45° → ≈ (0.405, 0.707, 0.579), i.e. the legacy fixed
  // headlamp (Vector3(0.4,0.7,0.6).normalize()). This Vector3 is threaded into
  // the atom/bond shader components and copied into the live uLightDir uniform
  // of make_toon_material.
  const light_dir = $derived.by(() => {
    const az = (active_light_azimuth * Math.PI) / 180
    const el = (active_light_elevation * Math.PI) / 180
    return new Vector3(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ).normalize()
  })

  const _toon_tmp_color = new Color()
  const _toon_material_cache = new Map<string, ShaderMaterial>()
  function make_toon_material(
    color_hex: string,
    opacity: number,
    transparent: boolean,
    double_sided: boolean,
  ): ShaderMaterial {
    const key = `${color_hex}|${opacity}|${transparent ? 1 : 0}|${double_sided ? 1 : 0}`
    const cached = _toon_material_cache.get(key)
    if (cached) return cached
    _toon_tmp_color.set(color_hex) // .set already sRGB→linear (ColorManagement on)
    const mat = new ShaderMaterial({
      vertexShader: toon_vertex_shader,
      fragmentShader: toon_fragment_shader,
      transparent,
      depthWrite: !transparent,
      side: double_sided ? 2 : 0,
      uniforms: {
        uColor: { value: _toon_tmp_color.clone() },
        // Headlamp in view space, driven by the light_azimuth/elevation
        // sliders (default reproduces the legacy top-front headlamp). Each
        // cached material's uLightDir is kept live by the $effect below.
        uLightDir: { value: light_dir.clone() },
        uShadowThreshold: { value: 0.3 },
        uHighlightThreshold: { value: 0.97 },
        uShadowBrightness: { value: 0.5 },
        uOpacity: { value: opacity },
        // Share the same uniform objects the depth-cue/outline effect writes to.
        uDepthCueing: depth_cue_uniforms.uDepthCueing,
        uDepthNear: depth_cue_uniforms.uDepthNear,
        uDepthFar: depth_cue_uniforms.uDepthFar,
        uDepthCueBgColor: depth_cue_uniforms.uDepthCueBgColor,
        uOutlineStrength: depth_cue_uniforms.uOutlineStrength,
      },
    })
    _toon_material_cache.set(key, mat)
    return mat
  }
  // Dispose the whole toon-material cache when the scene unmounts.
  $effect(() => () => {
    for (const mat of _toon_material_cache.values()) mat.dispose()
    _toon_material_cache.clear()
  })

  // LIVE light-direction update for the partial-occupancy toon path. The
  // cached toon materials are built once per (color|opacity|…) key, so the
  // creation-time uLightDir would never move when the slider changes — copy
  // the derived view-space direction into every cached material's uniform
  // whenever light_dir changes. (Newly-created materials read light_dir at
  // build time, so they're already correct.)
  $effect(() => {
    for (const mat of _toon_material_cache.values()) {
      mat.uniforms.uLightDir.value.copy(light_dir)
    }
    // imperative uniform write bypasses the <T.> prop chain — request a paint
    mark_dirty()
  })

  // Update depth cueing uniforms reactively — pure uniform updates, no recompilation.
  // Also called per-frame via useTask below to track camera distance changes.
  function update_depth_cue_uniforms() {
    depth_cue_uniforms.uDepthCueing.value = Math.max(0, Math.min(1, depth_cueing))
    depth_cue_uniforms.uOutlineStrength.value = Math.max(0, Math.min(1, atom_outline_strength))
    depth_cue_uniforms.uBondOutlineStrength.value = Math.max(0, Math.min(1, bond_outline_strength))
    // uDepthCueBgColor is written ONLY by sync_clear_color (the bg-tracking
    // effect). Don't re-write here — it would race with sync_clear_color
    // when both fire on the same frame, and risks reading stale closure
    // values when invoked from the per-frame useTask.
    if (depth_cueing > 0) {
      const cam = threlte.camera.current
      if (cam) {
        const center = new Vector3(...(rotation_target ?? [0, 0, 0]))
        const cam_dist = cam.position.distanceTo(center)
        const half_range = Math.max(structure_size, 2) * 0.5
        const front = cam_dist - half_range
        const back = cam_dist + half_range
        const full_depth = back - front
        // Map user-facing start/end (0-1 fraction of structure extent) to world depth
        depth_cue_uniforms.uDepthNear.value = front + depth_cue_start * full_depth
        depth_cue_uniforms.uDepthFar.value = front + depth_cue_end * full_depth
      }
    }
  }
  $effect(() => {
    // Track reactive dependencies
    void depth_cueing; void depth_cue_start; void depth_cue_end; void background_color
    void atom_outline_strength; void bond_outline_strength
    update_depth_cue_uniforms()
    mark_dirty()
  })

  let computed_zoom = $state<number>(untrack(() => initial_zoom))
  // Last container size this effect actually fit to, so we can tell a real
  // resize (pane close/relayout grows the slot) apart from a re-run that did
  // NOT change the box (layout-preset switch, sidebar toggle that only touch
  // unrelated reactive deps). Tracked untracked — must not re-trigger the effect.
  let _last_fit_w = untrack(() => width)
  let _last_fit_h = untrack(() => height)
  // Latch: a trajectory's first frame arrives async, AFTER the scene mounts, so
  // the one-shot camera placement ran against an empty structure. Recenter+refit
  // once when the structure first becomes present; the latch stops playback
  // frame-steps (which rewrite `structure` on the slow path) from recentering
  // every frame and fighting the user's pan/zoom.
  let _did_initial_structure_fit = false
  $effect(() => {
    if (!(width > 0) || !(height > 0)) return
    // Did the container box itself actually change since the last fit? A pane
    // close reflows the surviving pane via CSS %, so width/height genuinely grow
    // and the old ortho zoom (sized for the smaller pane) leaves the model
    // off-frame. A real size delta MUST re-fit even after the user zoomed.
    const size_changed = untrack(() =>
      Math.abs(width - _last_fit_w) > 0.5 || Math.abs(height - _last_fit_h) > 0.5)
    // Once the user zooms (TrackballControls writes camera.zoom directly, so it
    // drifts from the last computed_zoom we applied), stop auto-recomputing:
    // re-running on a pane resize WITHOUT a box change (layout switch, sidebar
    // toggle) would clobber their zoom level and visibly rescale the view. Read
    // untracked — camera mutations must not re-trigger this effect.
    const user_zoomed = untrack(() => {
      const cam = camera as any
      return cam?.isOrthographicCamera && Math.abs(cam.zoom - computed_zoom) > 1e-3
    })
    // Preserve the user's zoom only for non-resize re-runs. On a real size
    // change we always re-fit (and recenter below) so the model stays framed.
    if (user_zoomed && !size_changed) return
    untrack(() => { _last_fit_w = width; _last_fit_h = height })
    const structure_max_dim = Math.max(1, structure_size)
    const viewer_min_dim = Math.min(width, height)
    // Size the view from the atom bounding box when it is tighter than the cell
    // average — molecules have no lattice and would otherwise fall back to the
    // 10 A placeholder and render tiny.
    let fit_size = structure_max_dim
    if (structure?.sites?.length) {
      let min_x = Infinity, max_x = -Infinity
      let min_y = Infinity, max_y = -Infinity
      let min_z = Infinity, max_z = -Infinity
      for (const s of structure.sites) {
        const [x, y, z] = s.xyz
        if (x < min_x) min_x = x; if (x > max_x) max_x = x
        if (y < min_y) min_y = y; if (y > max_y) max_y = y
        if (z < min_z) min_z = z; if (z > max_z) max_z = z
      }
      // +2 A: atom centers ignore the rendered sphere radii (~1 A per side),
      // which dominate the visual extent of small molecules.
      const extent = Math.max(max_x - min_x, max_y - min_y, max_z - min_z, 1) + 2
      fit_size = Math.min(structure_max_dim, extent * 1.2)
    }
    // Fit the whole structure into the viewport's short axis with a 25% margin
    // (the margin absorbs the longest cell axis exceeding the average, atom
    // radii, and boundary image atoms).
    // initial_zoom acts as a relative knob: at its default the structure just
    // fits; larger values zoom in proportionally. (The previous fixed 30 px/Å
    // density cropped any structure wider than viewer_min_dim/30 Å — e.g.
    // LiFePO4's 10.3 Å axis in a half-width side-by-side pane.)
    const fit_zoom = viewer_min_dim / (Math.max(1, fit_size) * 1.25)
    let new_zoom = fit_zoom * (initial_zoom / DEFAULTS.structure.initial_zoom)
    if (min_zoom && min_zoom > 0) new_zoom = Math.max(min_zoom, new_zoom)
    if (max_zoom && max_zoom > 0) new_zoom = Math.min(max_zoom, new_zoom)
    computed_zoom = new_zoom
    // Recenter when (a) the container box changed (pane close/relayout), or
    // (b) the structure first becomes available — trajectories load their first
    // frame async, after mount, so the one-shot placement targeted an empty
    // structure and left the model off-frame. Latch (b) so slow-path frame-steps
    // don't recenter every frame.
    const structure_present = !!structure?.sites?.length
    const first_structure_fit = structure_present && !_did_initial_structure_fit
    if ((size_changed || first_structure_fit) && structure) {
      apply_orbit_target(get_camera_fit_target())
    }
    if (structure_present) _did_initial_structure_fit = true
  })

  // Live camera view snapshot: direction (target→camera) and up vector, refreshed
  // on every camera movement. Used to preserve the user's orientation across a
  // projection switch, which fully remounts the camera + TrackballControls and
  // would otherwise reset the view (see the camera_projection $effect below).
  // (The _view_* state is declared earlier, above the snapshot_view $effect.pre,
  // to avoid a temporal-dead-zone crash on early effect runs / HMR re-init.)
  function snapshot_view() {
    if (!camera || !orbit_controls?.target) return
    const cam = camera as any
    const d = new Vector3().subVectors(camera.position, orbit_controls.target)
    const dist = d.length()
    if (dist > 1e-6) _view_dir = d.clone().normalize()
    _view_up = camera.up.clone()
    _view_target = orbit_controls.target.clone()
    // Record the apparent size so it can be matched after a projection switch:
    // perspective frames by distance+fov, orthographic by zoom — different maths,
    // same on-screen height = (this value).
    if (cam.isPerspectiveCamera) {
      _view_vheight = 2 * dist * Math.tan((cam.fov * Math.PI / 180) / 2)
    } else if (cam.isOrthographicCamera && cam.zoom) {
      _view_vheight = (cam.top - cam.bottom) / cam.zoom
    }
  }

  // Pixels-per-Angstrom for scale bar — updated per-frame in useTask

  $effect.pre(() => { // Simple initial camera auto-position: Z-up, looking along +Y
    if (camera_position.every((v) => v === 0) && structure) {
      // Use atom bounding box extent (not lattice size) for initial camera distance.
      // Large unit cells (e.g. ZIF-8: 38×57×58 Å) push the camera too far away,
      // making small atoms (H) only a few pixels across where the rim darkening
      // creates visible dark outlines.  The atom extent is usually much smaller.
      let view_size = structure_size
      if (structure.sites?.length) {
        let min_x = Infinity, max_x = -Infinity
        let min_y = Infinity, max_y = -Infinity
        let min_z = Infinity, max_z = -Infinity
        for (const s of structure.sites) {
          const [x, y, z] = s.xyz
          if (x < min_x) min_x = x; if (x > max_x) max_x = x
          if (y < min_y) min_y = y; if (y > max_y) max_y = y
          if (z < min_z) min_z = z; if (z > max_z) max_z = z
        }
        const extent = Math.max(max_x - min_x, max_y - min_y, max_z - min_z, 1)
        view_size = Math.min(structure_size, extent * 1.2)
      }
      const distance = Math.max(1, view_size) * (60 / fov)
      // Camera on -Y axis looking into +Y, so Z is up and Y goes into screen
      const center = get_camera_fit_target()
      camera_position = [
        center[0],
        center[1] - distance,
        center[2],
      ]
    }
  })
  // Bond computation state (extracted to bond-computation-controller.svelte.ts)
  const bond_state = create_bond_state()
  const hbond_state = create_hbond_state()

  // Bond connectivity computation — runs as $effect.pre to update bond state BEFORE
  // the DOM is patched.
  //
  // Plan v3 Phase 6: trajectory_active argument and freeze-on-position-change
  // logic deleted. Under Architecture P, trajectory playback bypasses this
  // function entirely — bond_pairs updates flow through the trajectory branch
  // in build_bond_pairs $effect.pre (Phase 3), and X2's gate (Phase 5.5)
  // prevents the structure-cascade from reaching this effect during playback.
  // Phase 5: bonds are computed against the pre-ghost structure. When the
  // parent (Structure.svelte) provides `bond_input_structure`, it is the
  // supercell_structure (or cell_transformed_structure) BEFORE PBC image
  // atom expansion. WASM detection runs with PBC enabled and emits
  // cross-cell bonds with `image` populated; the renderer paints two
  // halves anchored at the original atoms.
  let bond_input = $derived(bond_input_structure ?? structure)
  // Merge the user-tunable `bond_scale` into the strategy options. atom_radii
  // reads `scale` (bond iff dist ≤ scale·Σr); electroneg/solid_angle ignore it.
  let bonding_options_eff = $derived({
    ...(bonding_options as Record<string, unknown>),
    scale: bond_scale,
  })
  $effect.pre(() => {
    // `trajectory_step_idx >= 0` is the trajectory-active signal: variable-N
    // trajectories drive this slow path per frame (no fast-path positions), so
    // it triggers the extension-only solid_angle -> atom_radii downgrade inside
    // compute_bond_connectivity. Static structures keep step_idx === -1 → false.
    compute_bond_connectivity(
      bond_state, (pairs) => { bond_pairs = pairs },
      bond_input, show_bonds, lattice, bonding_strategy,
      bonding_options_eff, external_dragging, trajectory_step_idx >= 0,
    )
  })

  // The first bond computation can run before the ferrox WASM finishes loading
  // (a popout window loads its structure at mount; mobile cold-starts are slow).
  // compute_bonds_sync then falls back to the pure-JS path, which emits NO
  // cross-cell PBC bonds. When WASM finishes, recompute ONCE with the real
  // (PBC-aware) detector. Done imperatively + untracked so it can't entangle
  // with the reactive bond effect above (that would loop on bond_state writes).
  $effect(() => on_ferrox_wasm_ready(() => untrack(() => {
    invalidate_bonds_for_recompute(bond_state, bond_input)
    compute_bond_connectivity(
      bond_state, (pairs) => { bond_pairs = pairs },
      bond_input, show_bonds, lattice, bonding_strategy,
      bonding_options_eff, external_dragging,
    )
  })))

  // Phase 7 — image-atom decorator layout. Enumerates the crystaltoolkit /
  // VESTA-style boundary-atom set: every site whose fractional coords are
  // within `edge_tolerance` of a face/edge/corner gets duplicated to the
  // matching opposite faces so cross-cell bonds can visibly terminate at a
  // partner sphere. Matches Materials Project's `draw_image_atoms=true`
  // default. Empty layout for molecules (no lattice), structures with no
  // boundary atoms, or when `bond_input` hasn't been computed yet — the
  // renderer's decorator pass becomes a no-op in those cases.
  //
  // Previously gated on `num_original_sites !== undefined` (only ran when
  // the parent had pre-expanded ghost atoms), which meant trajectory frames
  // and many other contexts never saw image atoms — leaving cross-cell
  // bonds rendered as paired stubs into vacuum. The gate is now just
  // "lattice exists," matching MP's behavior.
  let sites_to_draw = $derived.by((): Map<ImageSiteKey, ImageSiteEntry> | null => {
    if (!bond_input) return null
    const has_lattice = !!(bond_input as { lattice?: unknown }).lattice
    if (!has_lattice) return null
    // Must match the user's "Show image atoms" toggle: when OFF, sites_to_draw
    // contains only home-cell entries → partner_drawn_lookup returns false for
    // cross-cell partners → hide_incomplete_bonds collapses both stubs.
    // Mismatch (e.g. hardcoded true) leaves orphaned stubs visible.
    return build_sites_to_draw(
      bond_input,
      bond_state.bond_connectivity,
      {
        draw_image_atoms: show_image_atoms,
        // Disabled: enabling this populated `sites_to_draw` with bond-driven
        // image entries that drove the decorator pass to render bonds, but
        // the *atom* renderer reads from `displayed_structure.sites` (which
        // is built by find_pbc_images_fast / get_pbc_image_sites — a
        // separate pipeline that doesn't walk bond connectivity). The
        // mismatch produced bonds going to invisible image-atom positions
        // — visible "floating bond" spikes. Unifying the two paths
        // (displayed_structure following sites_to_draw, or vice-versa) is
        // tracked as follow-up. For now, boundary-tolerance images are the
        // only source — atoms with cross-cell bond partners > edge_tolerance
        // from a face look slightly under-bonded but no spikes.
        bonded_sites_outside_unit_cell: false,
        edge_tolerance: 0.05,
      },
    )
  })
  let image_atom_layout = $derived.by((): ImageAtomLayout => {
    if (sites_to_draw === null) return empty_image_atom_layout()
    void bond_manager.version
    return build_image_atom_layout(sites_to_draw, bond_manager)
  })
  // Phase 7d partner-drawn predicate. Closes over `sites_to_draw` so the
  // renderer can dispatch decorator instances to incomplete-edge stubs when
  // a bond's partner image atom is not in the drawn set. Predicate identity
  // changes with sites_to_draw → triggers `force_full_resync` via the
  // existing layout-change $effect in BondManagerInstances.
  let partner_drawn_lookup = $derived.by((): PartnerDrawnLookup | null => {
    const std = sites_to_draw
    if (std === null) return null
    return (idx, jx, jy, jz) => std.has(make_image_site_key(idx, [jx, jy, jz]))
  })

  // Bond position update effect — runs as $effect.pre (before DOM patch).
  //
  // Memoization guard: Svelte 5's $effect.pre can re-fire on sibling-effect
  // cascades within the same micro-flush even when our own tracked deps have
  // identical identity. Reads at the top of the effect still establish
  // subscriptions, so legitimate dep changes still fire. We just skip the
  // ~8ms recompute when nothing actually changed.
  //
  // For the override Map (a $state Map with deep tracking), we additionally
  // snapshot `.size` so a meaningful drag mutation (size 0 → N) still triggers
  // a rebuild even if the Map reference is unchanged.
  //
  // ─── W1 cascade regression detector counter declarations ─────────────────
  // Plain `let` (NOT $state) — increments are invisible to Svelte's dependency
  // tracker. Declared here (before the bbp $effect.pre and X2 $effect) to
  // avoid TDZ ReferenceError when those effects fire on the initial flush.
  // Increments are gated on import.meta.env?.DEV so production tree-shakes
  // them. See plans/W1-cascade-detector-design.md.
  //
  // W1.2 BASELINE READING — 2026-04-26, commit 2a3ac13f, 878-atom trajectory,
  // 5-second playback window (15 frames advanced ≈ 3fps in this test):
  //   atom_data_fires: 15 / meaningful: 0  (fast-path absorbs ALL — patches work)
  //   atom_data_fast_path_fires: 15
  //   bbp_fires: 17 / meaningful: 15       (design predicted meaningful=0;
  //                                        actual=15. The stable memo guard
  //                                        does NOT absorb trajectory because
  //                                        struct_ref changes per frame →
  //                                        build_bond_pairs IS called every
  //                                        frame, ~5-6ms each. Plan v3
  //                                        success criterion must be
  //                                        bbp_meaningful=0, not just bbp_fires=0)
  //   x2_fires: 30 / traj_fast_path: 15 / slow_meaningful: 0
  //                                       (X2 fires twice per traj advance —
  //                                        once for traj_positions change, once
  //                                        for structure ref cascade. Both go
  //                                        to fast-path or no-op, never slow.)
  //   apb_fires: 15 / meaningful: 15      (Float32Array allocated per frame —
  //                                        confirms the W3-audit-missed
  //                                        consumer is a real regression
  //                                        indicator. Plan v3 must drop this
  //                                        to 0 after Phase 4.)
  //   acb_fires: 15 / meaningful: 15      (same as apb — color buffer also
  //                                        allocated fresh per frame)
  //   nhsi_fires: 15 / meaningful: 15     (full O(N) site iteration per frame)
  //
  // Phase 4 success criterion (Architecture P): all _fires and _meaningful
  // counters drop to 0 during a sustained playback window EXCEPT
  // x2_traj_fast_path_fires (which only drops to 0 after Phase 5.5 X2 gate).
  let __probe_atom_data_fires = 0
  let __probe_atom_data_meaningful = 0
  let __probe_bbp_fires = 0
  let __probe_bbp_meaningful = 0
  let __probe_x2_fires = 0
  let __probe_x2_traj_fast_path_fires = 0
  let __probe_x2_slow_meaningful = 0
  let __probe_apb_fires = 0
  let __probe_apb_meaningful = 0
  let __probe_acb_fires = 0
  let __probe_acb_meaningful = 0
  let __probe_nhsi_fires = 0
  let __probe_nhsi_meaningful = 0

  let __bbp_prev_conn: unknown = null
  let __bbp_prev_lbs: unknown = null
  let __bbp_prev_struct: unknown = null
  let __bbp_prev_overrides: unknown = null
  let __bbp_prev_drag = false
  let __bbp_prev_sel: unknown = null
  let __bbp_prev_overrides_size = -1 // -1 = uninitialized; first run always builds
  // Plan v3 Phase 3: track trajectory_frame_positions identity for the
  // stable-memo guard. Without this, after Phase 4 stops the per-frame
  // current_structure cascade (struct_ref becomes stable), the existing
  // memo would treat all inputs as unchanged → return early → bond_pairs
  // never updated → bonds visually freeze (Reviewer 2 HIGH).
  let __bbp_prev_traj: unknown = null
  let __bbp_skips = 0
  let __bbp_was_suspended = false
  $effect.pre(() => {
    // WebGPU overlay active: this WebGL scene is covered and not painting, and
    // the overlay computes its own GPU bonds — so skip the per-frame trajectory
    // bond-pair rebuild (compute_bond_connectivity_for_frame +
    // build_trajectory_bond_pairs). Read suspend FIRST (reactive) so toggle-OFF
    // (true→false) re-fires this effect; the resume branch then bypasses the
    // memo so bonds rebuild for the current frame even if positions advanced
    // (under the overlay) without `trajectory_frame_positions` identity having
    // changed since the last build before suspension.
    const __suspended = webgl_suspended
    if (__suspended) { __bbp_was_suspended = true; return }
    const __resuming_bbp = __bbp_was_suspended
    __bbp_was_suspended = false
    if (import.meta.env?.DEV) __probe_bbp_fires++
    const __t0 = (import.meta.env?.DEV) ? performance.now() : 0
    // Read all deps up front so Svelte subscribes correctly.
    const conn_state = bond_state.bond_connectivity
    const lbs = bond_state.last_bond_structure
    const struct_ref = structure
    const overrides = realtime_position_overrides
    const drag = external_dragging
    const sel = selected_sites
    const overrides_size = overrides?.size ?? 0
    const traj_positions = trajectory_frame_positions

    // Plan v3 Phase 3 trajectory fast-path: when a trajectory is active,
    // bypass the slow build_bond_pairs path and use position-indexed
    // lookups via build_trajectory_bond_pairs. The branch returns BEFORE
    // the slow path, so bbp_meaningful drops to 0 during playback (the
    // Phase 3 success criterion).
    if (traj_positions != null) {
      // Layer 1 stale-bond fix: refresh connectivity for the current frame.
      // Cache hits return synchronously; cache misses on small structures
      // run sync detection; large-structure misses dispatch async (latest-wins
      // throttle) and return the previous frame's connectivity in the
      // meantime. NEVER reassigns bond_state.bond_connectivity synchronously,
      // so this does not cause an infinite re-fire of this $effect.pre.
      const traj_conn = compute_bond_connectivity_for_frame(
        bond_state, traj_positions, bond_input,
        show_bonds, lattice, bonding_strategy, bonding_options,
      )
      // Skip if no inputs changed since last fire. `drag` and `sel` must be
      // in the memo so drag-filter and selection highlights still update
      // during trajectory playback when conn/lbs/traj are stable.
      if (
        !__resuming_bbp
        && traj_conn === __bbp_prev_conn
        && lbs === __bbp_prev_lbs
        && traj_positions === __bbp_prev_traj
        && overrides === __bbp_prev_overrides
        && overrides_size === __bbp_prev_overrides_size
        && drag === __bbp_prev_drag
        && sel === __bbp_prev_sel
      ) {
        if (import.meta.env?.DEV) {
          __bbp_skips++
          if (__bbp_skips % 100 === 0) console.log(`[probe] build_bond_pairs: skipped ${__bbp_skips} no-op fires`)
        }
        return
      }
      __bbp_prev_conn = traj_conn
      __bbp_prev_lbs = lbs
      __bbp_prev_struct = struct_ref
      __bbp_prev_overrides = overrides
      __bbp_prev_drag = drag
      __bbp_prev_sel = sel
      __bbp_prev_overrides_size = overrides_size
      __bbp_prev_traj = traj_positions
      const __traj_tol = (() => {
        const raw = (bonding_options as Record<string, unknown> | undefined)?.tolerance
        return typeof raw === `number` && raw > 0 ? raw : undefined
      })()
      bond_pairs = build_trajectory_bond_pairs(
        traj_conn,
        traj_positions,
        overrides as unknown as Map<number, Vec3> | null,
        atom_manager,
        (bond_input as { lattice?: { matrix?: number[][] } } | undefined)?.lattice?.matrix ?? null,
        (bond_input as { sites?: ReadonlyArray<Site> } | undefined)?.sites ?? null,
        __traj_tol,
      )
      if (import.meta.env?.DEV) {
        const __dt = performance.now() - __t0
        if (__dt > 5) console.log(`[probe] build_trajectory_bond_pairs: ${__dt.toFixed(1)}ms (${bond_pairs.length} pairs)`)
      }
      return
    }
    // Trajectory ended → atomic teardown. clear_trajectory_bond_frame_cache
    // drops the cache, bumps the traj generation counter (so any in-flight
    // async resolve drops its result instead of leaking into post-trajectory
    // state), and resets throttle slots.
    if (__bbp_prev_traj != null && traj_positions == null) {
      clear_trajectory_bond_frame_cache(bond_state)
    }
    // Re-bind for the non-trajectory path's memo + build below.
    const conn = conn_state

    const stable =
      !__resuming_bbp
      && __bbp_prev_overrides_size !== -1
      && conn === __bbp_prev_conn
      && lbs === __bbp_prev_lbs
      && struct_ref === __bbp_prev_struct
      && overrides === __bbp_prev_overrides
      && drag === __bbp_prev_drag
      && sel === __bbp_prev_sel
      && overrides_size === __bbp_prev_overrides_size
      && traj_positions === __bbp_prev_traj
    if (stable) {
      if (import.meta.env?.DEV) {
        __bbp_skips++
        if (__bbp_skips % 100 === 0) console.log(`[probe] build_bond_pairs: skipped ${__bbp_skips} no-op fires`)
      }
      return
    }
    __bbp_prev_conn = conn
    __bbp_prev_lbs = lbs
    __bbp_prev_struct = struct_ref
    __bbp_prev_overrides = overrides
    __bbp_prev_drag = drag
    __bbp_prev_sel = sel
    __bbp_prev_overrides_size = overrides_size
    __bbp_prev_traj = traj_positions

    if (import.meta.env?.DEV) __probe_bbp_meaningful++
    bond_pairs = build_bond_pairs(conn, lbs, struct_ref, overrides, drag, sel)
    if (import.meta.env?.DEV) {
      const __dt = performance.now() - __t0
      if (__dt > 5) console.log(`[probe] build_bond_pairs: ${__dt.toFixed(1)}ms (${bond_pairs.length} pairs)`)
    }
  })

  // Orphan-atom diagnosis. Exposes a globalThis function the user can call
  // from DevTools to walk the live bond_pairs and log atoms with zero bonds.
  // Bypasses the click pathway (Architecture P stale-positions). The $effect
  // re-binds the function on every bond_pairs / structure update so each
  // call captures the latest frame's data. Logs once the first time it
  // runs so HMR readiness can be verified.
  let __orphan_dump_ready = false
  $effect(() => {
    void bond_pairs
    void structure
    ;(globalThis as { __catgo_dump_orphans_now?: (max_bonds?: number) => void }).__catgo_dump_orphans_now = (max_bonds = 1) => {
      if (!structure?.sites) {
        console.log(`[orphan-dump] no structure available`)
        return
      }
      const counts = new Map<number, number>()
      for (const bp of bond_pairs) {
        counts.set(bp.site_idx_1, (counts.get(bp.site_idx_1) ?? 0) + 1)
        counts.set(bp.site_idx_2, (counts.get(bp.site_idx_2) ?? 0) + 1)
      }
      const std = sites_to_draw
      const n = structure.sites.length
      const low_bond_sites: Array<{ site_idx: number; bond_count: number }> = []
      for (let i = 0; i < n; i++) {
        const c = counts.get(i) ?? 0
        if (c <= max_bonds) low_bond_sites.push({ site_idx: i, bond_count: c })
      }
      console.log(`[orphan-dump] ${low_bond_sites.length}/${n} atoms with ≤${max_bonds} bonds (${bond_pairs.length} bonds in frame)`)
      for (const { site_idx, bond_count } of low_bond_sites) {
        const site = structure.sites[site_idx]
        const species = site.species?.map((s: { element: string }) => s.element).join(`,`) ?? `?`
        const mm = (site as { properties?: { move_mask?: boolean } })?.properties?.move_mask
        // Find this site's bonds
        const my_bonds = bond_pairs.filter((bp) =>
          bp.site_idx_1 === site_idx || bp.site_idx_2 === site_idx
        )
        const bond_details = my_bonds.map((bp) => {
          const is_a = bp.site_idx_1 === site_idx
          const partner_idx = is_a ? bp.site_idx_2 : bp.site_idx_1
          const partner_ji: [number, number, number] = is_a
            ? [bp.jimage[0], bp.jimage[1], bp.jimage[2]]
            : [-bp.jimage[0], -bp.jimage[1], -bp.jimage[2]]
          const cross_cell = partner_ji[0] !== 0 || partner_ji[1] !== 0 || partner_ji[2] !== 0
          const partner_key = `${partner_idx}-${partner_ji[0]},${partner_ji[1]},${partner_ji[2]}` as const
          const partner_in_set = std !== null ? std.has(partner_key as never) : null
          const partner_species = structure.sites[partner_idx]?.species?.map((s: { element: string }) => s.element).join(`,`) ?? `?`
          return `${partner_species}#${partner_idx}${cross_cell ? `[${partner_ji.join(`,`)}]` : ``}${cross_cell && partner_in_set === false ? ` (partner-NOT-drawn)` : ``}`
        })
        console.log(
          `  site=${site_idx} ${species} bonds=${bond_count}` +
          ` xyz=(${site.xyz[0].toFixed(2)}, ${site.xyz[1].toFixed(2)}, ${site.xyz[2].toFixed(2)})` +
          ` abc=(${site.abc[0].toFixed(3)}, ${site.abc[1].toFixed(3)}, ${site.abc[2].toFixed(3)})` +
          ` move_mask=${mm === undefined ? `?` : mm}` +
          ` -> [${bond_details.join(`, `)}]`,
        )
      }
    }
    if (!__orphan_dump_ready) {
      __orphan_dump_ready = true
      console.log(`[orphan-dump] ready — call globalThis.__catgo_dump_orphans_now() from DevTools`)
    }
  })

  // Hydrogen bond detection (Phase 5: same pre-ghost structure as covalent
  // bond detection — HBondConnectivity site indices must align with the
  // covalent bond_connectivity space).
  $effect.pre(() => {
    compute_hbond_connectivity(
      hbond_state, show_hydrogen_bonds, bond_input, bond_pairs,
      bonding_strategy, bonding_options, hbond_distance_cutoff, hbond_angle_cutoff,
    )
  })

  // H-bond pairs: derived from connectivity + current positions.
  let h_bond_pairs: BondPair[] = $derived.by(() =>
    build_hbond_pairs(
      hbond_state.h_bond_connectivity, bond_state.last_bond_structure,
      structure, realtime_position_overrides, external_dragging, selected_sites,
    )
  )

  // Vibration mode animation — drives realtime_position_overrides via requestAnimationFrame
  $effect(() => {
    // Plan v3 Phase 2 mutex (Reviewer 3 HIGH, plans/W6-review-completeness.md
    // Finding #1): trajectory and vibration cannot both drive positions
    // simultaneously. Without this gate, the vibration effect writes
    // realtime_position_overrides for every atom per rAF tick → Structure.svelte's
    // position-write loop sees overrides for ALL slots and skips ALL trajectory
    // writes (drag-precedence guard) → atoms display vibration positions, NOT
    // trajectory positions. Silent wrong behavior. Trajectory wins.
    if (trajectory_frame_positions != null) return
    const vib = vibration_data
    if (!vib?.playing) {
      // Stop: clear overrides (untrack to avoid reactive dependency on drag/rotation writes)
      if (untrack(() => realtime_position_overrides)) {
        realtime_position_overrides = null
      }
      return
    }
    const { eigenvector, base_positions, amplitude } = vib
    if (!eigenvector?.length || !base_positions?.length) return

    let frame_id: number
    function tick() {
      const phase = Math.sin(performance.now() / 500 * Math.PI)
      const overrides = new Map<number, Vec3>()
      for (let i = 0; i < base_positions.length; i++) {
        const ev = eigenvector[i]
        const bp = base_positions[i]
        if (!ev || !bp) continue
        overrides.set(i, [
          bp[0] + ev[0] * amplitude * phase,
          bp[1] + ev[1] * amplitude * phase,
          bp[2] + ev[2] * amplitude * phase,
        ])
      }
      realtime_position_overrides = overrides
      frame_id = requestAnimationFrame(tick)
    }
    frame_id = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame_id)
      realtime_position_overrides = null
    }
  })

  // H-bond instanced groups — groups of dashed cylinder instances for DashedBond.
  // H-bonds stay on the legacy Bond-like render path because DashedBond has
  // its own instanced mesh and there's no SoA-store integration for them.
  let instanced_hbond_groups = $derived.by(() => {
    // Same fallback as filtered_bond_pairs (see comment there): when
    // last_bond_structure is null, fall back to the current `structure` so
    // H-bonds don't briefly disappear during async-compute transitions.
    const bond_struct = bond_state.last_bond_structure ?? structure
    if (!bond_struct?.sites || h_bond_pairs.length === 0) return []

    const instances: { matrix: Float32Array; color_start: string; color_end: string }[] = []

    // Subscribe to override-map mutations so this $derived re-runs when
    // the right-click "Set Color" picker updates a hydrogen-bonded atom.
    const _sco_size_hbond = site_color_overrides?.size ?? 0
    void _sco_size_hbond

    for (const bond_data of h_bond_pairs) {
      const site_a = bond_struct.sites[bond_data.site_idx_1]
      const site_b = bond_struct.sites[bond_data.site_idx_2]

      if (
        !bond_data.transform_matrix ||
        bond_data.transform_matrix.some((val) => !Number.isFinite(val))
      ) continue

      // Per-site override wins over element-default color (matches the
      // covalent-bond path in atom_colors_buffer below).
      const color_start = site_color_overrides?.get(bond_data.site_idx_1)
        ?? get_majority_color(site_a, colors.element, bond_color)
      const color_end = site_color_overrides?.get(bond_data.site_idx_2)
        ?? get_majority_color(site_b, colors.element, bond_color)
      instances.push({
        matrix: bond_data.transform_matrix,
        color_start,
        color_end,
      })
    }

    if (instances.length === 0) return []
    return [{
      thickness: hbond_thickness,
      ambient_light: active_ambient_light,
      directional_light: active_directional_light,
      opacity: 1,
      instances,
    }]
  })

  // Cutting visibility lookup map for fast access
  let cutting_visibility_map = $derived.by(() =>
    build_cutting_visibility_map(cutting_active, cutting_atom_visibility)
  )

  // In slab preview mode, hide bulk atoms to show only the slab preview
  let show_bulk_atoms = $derived.by(() => compute_show_bulk_atoms(show_atoms, cutting_active, cutting_preview_mode))

  // desaturate_color is imported from ./scene/render-data

  // Bridge hidden_elements prop to local state — $derived doesn't track Set prop changes reliably
  let _hidden_elements = $state(new Set<ElementSymbol>())
  $effect(() => {
    _hidden_elements = new Set(hidden_elements ?? [])
  })
  let _hidden_sites = $state(new Set<number>())
  $effect(() => {
    _hidden_sites = new Set(hidden_sites ?? [])
  })
  // Set-prop bridge (see CLAUDE.md [2026-03-04]): $derived.by() doesn't track
  // Set prop reassignment reliably across component boundaries, but $effect does.
  // Without this, a bond undo that only mutates deleted_bond_keys never wakes
  // filtered_bond_pairs, and the shadow sync removes the just-restored bond.
  let _deleted_bond_keys = $state(new Set<string>())
  $effect(() => {
    _deleted_bond_keys = new Set(deleted_bond_keys ?? [])
  })
  // Same pattern for hidden_prop_vals — read inside atom_data and filtered_bond_pairs
  // $derived.by() blocks. Without this bridge, toggling property-value visibility
  // (e.g. hide CN=6) silently fails to refresh derivations.
  let _hidden_prop_vals = $state(new Set<number | string>())
  $effect(() => {
    _hidden_prop_vals = new Set(hidden_prop_vals ?? [])
  })

  // ═══ Hidden-site id set for the Phase X3 atom renderer ═══
  // Only evaluated when USE_NEW_ATOM_SYSTEM is true — the legacy AtomImpostors
  // path applies its own filtering inside `atom_data`, so computing a second
  // Set when the flag is off would be wasted work.
  //
  // Mirrors the legacy `atom_data` filter at L1766: a site is hidden iff its
  // own `site_idx` OR its `orig_site_idx` (the PBC-image parent) is in the
  // hidden set. Without the orig_idx check, hiding an original atom would
  // leave its PBC images visible — regression flagged in post-X7 review.
  let new_atom_hidden_site_ids = $derived.by(() => {
    if (import.meta.env?.DEV) __probe_nhsi_fires++
    if (!USE_NEW_ATOM_SYSTEM) return undefined
    if (!structure?.sites) return new Set<number>()
    if (import.meta.env?.DEV) __probe_nhsi_meaningful++
    const out = new Set<number>()
    // Walk every site once — cheaper than two loops for structures with
    // PBC images (which double the atom count). Each site is classified
    // based on its own site_idx AND its orig_site_idx for inherited hides.
    const has_element_hide = _hidden_elements.size > 0
    const has_prop_hide = _hidden_prop_vals.size > 0
    const has_site_hide = _hidden_sites.size > 0
    for (let site_idx = 0; site_idx < structure.sites.length; site_idx++) {
      const site = structure.sites[site_idx]
      const orig_idx = get_orig_site_idx(site, site_idx)
      // Per-site explicit hide, inheriting parent for image atoms.
      if (has_site_hide && (_hidden_sites.has(site_idx) || _hidden_sites.has(orig_idx))) {
        out.add(site_idx)
        continue
      }
      // Element-level hide — first species is the representative (matches
      // the X2 shadow sync's first-species-only manager model).
      if (has_element_hide) {
        const first_el = site.species[0]?.element
        if (first_el !== undefined && _hidden_elements.has(first_el)) {
          out.add(site_idx)
          continue
        }
      }
      // Property-value hide.
      if (has_prop_hide) {
        const prop_val = property_colors?.values[orig_idx]
        if (prop_val !== undefined && _hidden_prop_vals.has(prop_val)) {
          out.add(site_idx)
        }
      }
    }
    return out
  })

  // --- Polyhedra computation (bond-graph: uses filtered_bond_pairs) ---
  let polyhedra_data = $derived.by(() => {
    if (!show_polyhedra || !structure?.sites) return []
    try {
      // Compute on the UNIT-CELL structure only. When image atoms are shown,
      // `structure.sites` is expanded with boundary image copies appended after
      // `num_original_sites`; feeding those to the bond graph double-counts each
      // vertex (a center bonds to both the original neighbour and its coincident
      // image-atom site), producing duplicate coincident vertices that degenerate
      // the convex hull into a half-shell. PBC closure across cell boundaries is
      // already handled by the bond jimage shift, and image-atom polyhedra are
      // added separately in `polyhedra_data_with_images`.
      const base_structure =
        num_original_sites !== undefined && num_original_sites < structure.sites.length
          ? { ...structure, sites: structure.sites.slice(0, num_original_sites) }
          : structure
      // Polyhedra need coordination-complete bonds, independent of the user's
      // render bond mode (solid_angle under-coordinates octahedra). Compute
      // atom_radii bonds (PBC-aware via WASM) just for polyhedra, with their own
      // scale knob; fall back to the rendered bonds if the sync path is
      // unavailable (large cell / no WASM).
      const poly_bonds_raw =
        compute_bonds_sync(base_structure, `atom_radii`, { scale: polyhedra_bond_scale }) ??
        visible_bond_pairs
      // Honour per-pair distance rules in polyhedra too, so a ruled pair's
      // coordination shell matches the rendered bonds (generate + filter).
      const base_lat_m = (base_structure as { lattice?: { matrix?: unknown } }).lattice?.matrix
      const base_lat = (Array.isArray(base_lat_m) && base_lat_m.length === 3)
        ? base_lat_m as [Vec3, Vec3, Vec3]
        : null
      const poly_bonds = apply_bond_distance_rules(
        base_structure, base_lat, poly_bonds_raw, bond_distance_rules ?? [],
      )
      return compute_polyhedra_from_bonds(base_structure, poly_bonds, {
        center_elements: polyhedra_center_elements ?? [],
        min_coordination: polyhedra_min_coordination ?? 4,
        max_neighbors: polyhedra_max_neighbors ?? 8,
        metals_only: polyhedra_metals_only ?? false,
      })
    } catch (err) {
      console.warn(`[CatGo] Polyhedra computation failed:`, err)
      return []
    }
  })

  // Extend unit-cell polyhedra with copies for rendered image atoms.
  // Hidden-atom/bond derivations stay on `polyhedra_data` (unit-cell only) so
  // the same center_idx is not processed twice there. Only the geometry
  // consumer (merge_polyhedra_geometry) needs the extended list.
  let polyhedra_data_with_images = $derived.by((): PolyhedronData[] => {
    if (!show_polyhedra || !show_image_atoms || !polyhedra_data.length) return polyhedra_data
    const layout = image_atom_layout
    if (!layout.n_image_atoms) return polyhedra_data
    const mat = lattice?.matrix
    if (!mat) return polyhedra_data
    const center_set = new Set(polyhedra_data.map((p) => p.center_idx))
    const extras: PolyhedronData[] = []
    for (let img = 0; img < layout.n_image_atoms; img++) {
      const orig_idx = layout.orig_site_indices[img]
      if (!center_set.has(orig_idx)) continue
      const jx = layout.jimage_offsets[img * 3]
      const jy = layout.jimage_offsets[img * 3 + 1]
      const jz = layout.jimage_offsets[img * 3 + 2]
      // shift = jx*row0 + jy*row1 + jz*row2
      const sx = jx * mat[0][0] + jy * mat[1][0] + jz * mat[2][0]
      const sy = jx * mat[0][1] + jy * mat[1][1] + jz * mat[2][1]
      const sz = jx * mat[0][2] + jy * mat[1][2] + jz * mat[2][2]
      const proto = polyhedra_data.find((p) => p.center_idx === orig_idx)!
      extras.push({
        center_idx: proto.center_idx,
        center_element: proto.center_element,
        neighbor_indices: proto.neighbor_indices,
        vertices: proto.vertices.map(([vx, vy, vz]) => [vx + sx, vy + sy, vz + sz]),
      })
    }
    if (!extras.length) return polyhedra_data
    return [...polyhedra_data, ...extras]
  })

  const EMPTY_POLYHEDRA_GEOM: MergedPolyhedraGeometry = {
    face_positions: new Float32Array(0), face_normals: new Float32Array(0),
    face_colors: new Float32Array(0),
    face_polyhedron_ids: new Float32Array(0), face_count: 0,
    edge_positions: new Float32Array(0), edge_count: 0,
  }

  // Color of a structure site: per-element override > property color (coordination/
  // Wyckoff modes) > element color > gray fallback. Mirrors catgo's atom-color path.
  const polyhedra_site_color = (site_idx: number): string => {
    const site = structure?.sites[site_idx]
    const element = site?.species?.[0]?.element ?? ``
    const override = polyhedra_color_overrides?.[element]
    if (override) return override
    const orig_idx = get_orig_site_idx(site, site_idx)
    return property_colors?.colors[orig_idx] ??
      (element && colors.element?.[element]) ?? `#808080`
  }

  let polyhedra_geometry = $derived.by(() => {
    if (!polyhedra_data_with_images.length) return EMPTY_POLYHEDRA_GEOM
    // Resolve each hull corner's color per the active color mode. neighbor_indices
    // is parallel to vertices; -1 marks a PBC image -> fall back to the center color.
    const get_vertex_color = (poly: PolyhedronData, vertex_local_idx: number): string => {
      if (polyhedra_color_mode === `uniform`) return polyhedra_color
      if (polyhedra_color_mode === `center`) return polyhedra_site_color(poly.center_idx)
      const site_idx = poly.neighbor_indices[vertex_local_idx]
      return site_idx >= 0 ? polyhedra_site_color(site_idx) : polyhedra_site_color(poly.center_idx)
    }
    try {
      return merge_polyhedra_geometry(polyhedra_data_with_images, get_vertex_color)
    } catch (err) {
      console.warn(`[CatGo] Polyhedra geometry merge failed:`, err)
      return EMPTY_POLYHEDRA_GEOM
    }
  })

  let polyhedra_hidden_atoms = $derived.by(() => {
    if (!show_polyhedra || !polyhedra_data.length || !hide_polyhedra_center_atoms) return new Map<number, number>()
    return get_polyhedra_hidden_atoms(polyhedra_data, true)
  })

  let polyhedra_hidden_bond_keys = $derived.by(() => {
    if (!show_polyhedra || !polyhedra_data.length || !hide_polyhedra_internal_bonds) return new Set<string>()
    return get_polyhedra_hidden_bond_keys(polyhedra_data)
  })

  // --- Sphere clipping opacity ---
  // If no clip_center set, use structure centroid as default center
  let effective_clip_center = $derived.by(() => {
    if (clip_center) return clip_center
    if (!structure?.sites?.length) return null
    let cx = 0, cy = 0, cz = 0
    for (const site of structure.sites) {
      cx += site.xyz[0]; cy += site.xyz[1]; cz += site.xyz[2]
    }
    const n = structure.sites.length
    return [cx / n, cy / n, cz / n] as Vec3
  })

  let clip_opacity_overrides = $derived.by(() => {
    if (!clip_active || !effective_clip_center || !structure?.sites) return new Map<number, number>()
    const overrides = new Map<number, number>()
    const r2 = clip_radius * clip_radius
    const outside_op = clip_outside_mode === `hide` ? 0 : clip_outside_opacity
    const cx = effective_clip_center[0], cy = effective_clip_center[1], cz = effective_clip_center[2]
    for (let i = 0; i < structure.sites.length; i++) {
      const pos = structure.sites[i].xyz
      const dx = pos[0] - cx, dy = pos[1] - cy, dz = pos[2] - cz
      if (dx * dx + dy * dy + dz * dz > r2) {
        overrides.set(i, outside_op)
      }
    }
    return overrides
  })

  // --- Node Isolator opacity ---
  let isolation_opacity_overrides = $derived.by(() => {
    if (!isolated_node_atoms || !structure?.sites) return new Map<number, number>()
    const overrides = new Map<number, number>()
    for (let i = 0; i < structure.sites.length; i++) {
      if (!isolated_node_atoms.has(i)) overrides.set(i, isolation_outside_opacity)
    }
    return overrides
  })

  let merged_atom_opacity_overrides = $derived.by(() => {
    const merged = new Map(atom_opacity_overrides)
    for (const [idx, op] of polyhedra_hidden_atoms) merged.set(idx, op)
    for (const [idx, op] of clip_opacity_overrides) merged.set(idx, Math.min(merged.get(idx) ?? 1, op))
    for (const [idx, op] of isolation_opacity_overrides) merged.set(idx, Math.min(merged.get(idx) ?? 1, op))
    return merged
  })

  // Camera position for polyhedra depth-gradient opacity
  let _polyhedra_camera_pos = $state<[number, number, number]>([0, 0, 50])
  let _polyhedra_depth_range = $state<[number, number]>([0, 100])

  // Plan v3 Phase 6: __atom_data_cache_* state and atom_data trajectory
  // fast-path block deleted. Under Architecture P, atom_data does not
  // re-run during trajectory playback (cascade is silent — verified by
  // W7 Test 5.3 atom_data_fires === 0). The fast-path was a patch over a
  // cascade that no longer exists; deleting it removes ~50 lines.
  // The probe counter __atom_data_fast_count is retained as a `let` (not
  // const) so the probe surface's reset() can still write to it. Always 0
  // post-Phase-6.
  let __atom_data_fast_count = 0

  let atom_data = $derived.by(() => { // Pre-compute atom data for performance (site_idx, element, occupancy, position, radius, color, ...)
    if (!show_atoms || !structure?.sites) return []
    if (import.meta.env?.DEV) __probe_atom_data_fires++
    // R8.7 PROBE — load-cascade timing.
    const __t0 = (import.meta.env?.DEV) ? performance.now() : 0
    // Force reactivity on override sources (cheaper than JSON.stringify)
    const _ero_keys = Object.keys(element_radius_overrides ?? {})
    const site_overrides_size = site_radius_overrides?.size ?? 0
    const color_overrides_size = site_color_overrides?.size ?? 0
    const _hidden_size = _hidden_elements?.size ?? 0
    const _hidden_sites_size = _hidden_sites?.size ?? 0
    const _hpv_size = _hidden_prop_vals.size ?? 0
    // Force reactivity on plugin hooks
    const _hookCount = pluginManager.structureHooks.get('atomColors')?.length ?? 0
    const _enabledPluginCount = pluginManager.enabledPlugins.length // Trigger re-derive when plugins enable/disable

    // Plan v3 Phase 6: trajectory fast-path block deleted. atom_data does
    // not re-run during trajectory playback under Architecture P; the
    // fast-path's reason for existing is gone.
    if (import.meta.env?.DEV) __probe_atom_data_meaningful++
    // First pass: compute initial colors for all sites (used by plugin hooks)
    const initialColors: (string | null)[] = structure.sites.map((site, site_idx) => {
      const orig_idx = typeof site.properties?.orig_unit_cell_idx === `number`
        ? site.properties.orig_unit_cell_idx
        : typeof site.properties?.orig_site_idx === `number`
        ? site.properties.orig_site_idx
        : site_idx
      const site_property_color = property_colors?.colors[orig_idx]
      const firstElement = site.species[0]?.element
      return site_property_color ?? colors.element?.[firstElement] ?? null
    })

    // Apply plugin atomColors hooks
    const pluginColors = pluginManager.applyAtomColorsHooks(structure.sites, initialColors)

    const result = structure.sites.flatMap((site, site_idx) => {
      // Site-level override takes priority over element-level override
      const site_override = site_radius_overrides?.get(site_idx)
      const radius = site_override !== undefined
        ? site_override * atom_radius
        : same_size_atoms
          ? atom_radius
          : site.species.reduce(
              (sum, spec) => sum + spec.occu * (element_radius_overrides?.[spec.element] ?? atomic_radii[spec.element] ?? 1),
              0,
            ) * atom_radius

      // Get original site index for property color lookup (handles supercell and image atoms)
      const orig_idx = get_orig_site_idx(site, site_idx)

      // Skip individually hidden sites (also hide image atoms whose parent is hidden)
      if (_hidden_sites.has(site_idx) || _hidden_sites.has(orig_idx)) return []

      // Skip sites with hidden property values
      const prop_val = property_colors?.values[orig_idx]
      if (prop_val !== undefined && _hidden_prop_vals.has(prop_val)) return []

      // Use property color if available (coordination/wyckoff/charge mode), otherwise element color
      const site_property_color = property_colors?.colors[orig_idx]
      // Per-site color override takes highest priority
      const site_color_override = site_color_overrides?.get(site_idx)
      // Use plugin color if provided
      const pluginColor = pluginColors[site_idx]

      let start_angle = 0
      return site.species
        .filter(({ element }) => !_hidden_elements?.has(element))
        .map(({ element, occu }) => ({
          site_idx,
          element,
          occupancy: occu,
          position: site.xyz,
          radius,
          color: site_color_override ?? pluginColor ?? site_property_color ?? colors.element?.[element],
          has_partial_occupancy: occu < 1,
          start_phi: 2 * Math.PI * start_angle,
          end_phi: 2 * Math.PI * (start_angle += occu),
        }))
    })
    // Plan v3 Phase 6: cache-snapshot writes deleted (no consumer).

    if (import.meta.env?.DEV) {
      const __dt = performance.now() - __t0
      if (__dt > 5) console.log(`[probe] atom_data $derived (slow): ${__dt.toFixed(1)}ms (${structure.sites.length} sites, ${result.length} entries)`)
    }
    return result
  })

  // Mark GPU picker as dirty when atom data, bonds, or cutting visibility change.
  // Use bond_pairs.length (cheap $state) instead of filtered_bond_pairs.length
  // ($derived) to avoid forcing an expensive early evaluation of the bond
  // rendering chain before bond_pairs has been updated in the current tick.
  $effect(() => {
    const _a = atom_data.length
    const _b = bond_pairs.length
    const _c = cutting_visibility_map.size
    // Lattice changes shift cross-cell bond endpoints (b_eff). Force the
    // picker scene to rebuild so half-bond transforms stay in sync with
    // the live renderer.
    const _l = bond_lattice_matrix
    // Stub-mode toggles change which half-bond instances are visible.
    const _m = incomplete_periodic_edge_mode
    const _s = incomplete_edge_length_scale
    // Phase 7e — image-atom decorator scene also rebuilds with the picker.
    const _ial = image_atom_layout
    const _pdl = partner_drawn_lookup
    const _stf = slot_to_filtered_idx
    void _l; void _m; void _s; void _ial; void _pdl; void _stf
    picker.picker_dirty = true
  })

  // Track which bonds are manual (for visual feedback)
  let manual_bond_keys = $derived.by(() => new Set(manual_bonds.map(b => get_bond_key(b.site_idx_1, b.site_idx_2))))

  let visible_bond_pairs = $derived.by(() => {
    // Use last_bond_structure for site lookups — bond indices reference the
    // structure bonds were computed against. This also avoids a redundant
    // cascade (filtered → instanced → GPU) every time structure changes.
    //
    // Fallback to `structure` when `last_bond_structure` is null. The async
    // bond compute path (bond-computation-controller.svelte.ts:336-337) and
    // a couple of edge-case state transitions briefly set
    // `last_bond_structure = null`. Without a fallback the user sees every
    // bond disappear during that window — specifically reproducible when
    // deleting an atom while the async path was mid-flight: the fast-delete
    // reindexes bond_state.bond_connectivity correctly, but this $derived
    // returns [] because last_bond_structure happened to be null at that
    // instant. Post-delete `structure.sites` and `last_bond_structure.sites`
    // share the same index space (apply_atom_delete_incremental keeps them
    // in lockstep), so falling back to `structure` is safe.
    const bond_struct = bond_state.last_bond_structure ?? structure
    if (!bond_struct?.sites) return []
    // Force reactivity — hidden_elements/hidden_sites/bond_distance_rules/deleted_bond_keys are read inside nested callbacks
    const _hidden_size = _hidden_elements?.size ?? 0
    const _hs_size = _hidden_sites?.size ?? 0
    const _hs_prop_size = hidden_sites?.size ?? 0 // Also read prop directly for reliable reactivity
    const _hpv_size = _hidden_prop_vals.size ?? 0
    const _rules_len = bond_distance_rules?.length ?? 0
    const _deleted_size = _deleted_bond_keys.size

    // Apply per-element-pair distance rules. For a ruled pair this REPLACES the
    // strategy bonds with every PBC pair within [min,max] (so it both removes
    // over-long bonds and ADDS missing in-range bonds the strategy didn't find);
    // pairs without a rule keep their strategy bonds untouched.
    const lat_m = (bond_struct as { lattice?: { matrix?: unknown } }).lattice?.matrix
    const lat_matrix = (Array.isArray(lat_m) && lat_m.length === 3)
      ? lat_m as [Vec3, Vec3, Vec3]
      : null
    // During trajectory playback `bond_struct.sites[].xyz` are the loaded
    // frame, not the one on screen. Pass the animated frame positions so ruled
    // bonds track the trajectory instead of freezing at frame 0.
    const ruled_bonds = apply_bond_distance_rules(
      bond_struct, lat_matrix, bond_pairs, bond_distance_rules ?? [],
      trajectory_frame_positions ?? null,
    )

    const is_site_visible = (site_idx: number) => {
      const site = bond_struct.sites[site_idx]
      const orig_idx = get_orig_site_idx(site, site_idx)
      if (_hidden_sites.has(site_idx) || _hidden_sites.has(orig_idx)) return false
      const has_visible_element = site?.species.some(({ element }: { element: ElementSymbol }) =>
        !_hidden_elements.has(element)
      )
      const prop_val = property_colors?.values[orig_idx]
      const prop_visible = prop_val === undefined || !_hidden_prop_vals.has(prop_val)
      return has_visible_element && prop_visible
    }

    // Start from the rule-aware bonds; filter out deleted, hidden, and invalid transforms
    let result = ruled_bonds.filter((bond) => {
      if (!bond.transform_matrix || bond.transform_matrix.some((v) => !Number.isFinite(v))) return false
      // Hard cap on rendered bond length. No real covalent bond exceeds this;
      // anything longer is a PBC/image rendering artifact (e.g. a bond drawn
      // straight across the cell instead of via the minimum image), so drop it.
      if (bond.bond_length > MAX_BOND_LENGTH) return false
      const key = get_bond_key(bond.site_idx_1, bond.site_idx_2)
      if (_deleted_bond_keys.has(key)) return false
      if (!is_site_visible(bond.site_idx_1) || !is_site_visible(bond.site_idx_2)) return false
      return true
    })

    // Append manual bonds (that aren't already in auto-detected set)
    const auto_keys = new Set(result.map(b => get_bond_key(b.site_idx_1, b.site_idx_2)))
    for (const mb of manual_bonds) {
      const key = get_bond_key(mb.site_idx_1, mb.site_idx_2)
      if (auto_keys.has(key)) continue // Already present via auto-detection
      const pos_1 = bond_struct.sites[mb.site_idx_1]?.xyz
      const pos_2 = bond_struct.sites[mb.site_idx_2]?.xyz
      if (!pos_1 || !pos_2) continue
      const diff = math.subtract(pos_2, pos_1)
      const bond_length = Math.hypot(diff[0], diff[1], diff[2])
      result.push({
        pos_1,
        pos_2,
        site_idx_1: mb.site_idx_1,
        site_idx_2: mb.site_idx_2,
        bond_length,
        strength: 1.0,
        transform_matrix: compute_bond_transform(pos_1, pos_2),
        jimage: [0, 0, 0],
      })
    }

    return result
  })

  // Bonds as actually rendered: visible_bond_pairs minus polyhedra-internal bonds
  // (the polyhedron face covers them) and sphere-clip culling. Kept DOWNSTREAM of
  // visible_bond_pairs so polyhedra_data (which consumes visible_bond_pairs) does
  // NOT depend on polyhedra_hidden_bond_keys — that closes a derived cycle
  // (polyhedra_data → bonds → polyhedra_hidden_bond_keys → polyhedra_data).
  let filtered_bond_pairs = $derived.by(() => {
    let result = visible_bond_pairs
    // Filter bonds hidden by polyhedra
    if (polyhedra_hidden_bond_keys.size > 0) {
      result = result.filter((bond) => {
        const key = get_bond_key(bond.site_idx_1, bond.site_idx_2)
        return !polyhedra_hidden_bond_keys.has(key)
      })
    }
    // Filter bonds outside sphere clipping radius
    if (clip_active && effective_clip_center && structure?.sites) {
      const r2 = clip_radius * clip_radius
      const cx = effective_clip_center[0], cy = effective_clip_center[1], cz = effective_clip_center[2]
      const is_inside = (idx: number) => {
        const pos = structure.sites[idx]?.xyz
        if (!pos) return false
        const dx = pos[0] - cx, dy = pos[1] - cy, dz = pos[2] - cz
        return dx * dx + dy * dy + dz * dz <= r2
      }
      // Hide bonds where BOTH endpoints are outside the clip radius
      result = result.filter((bond) => is_inside(bond.site_idx_1) || is_inside(bond.site_idx_2))
    }
    return result
  })

  // ═══ Adsorbate bond-order perception (default-OFF) ═══
  // When OFF, return a SHARED empty map and never invoke perceive_* — zero CPU,
  // and the shadow-sync order pass below is skipped (orders_buffer stays null →
  // GPU bytes byte-identical to today). When ON, perceive double/triple/aromatic
  // orders on small organic adsorbate fragments only; the slab stays order 1.
  // Keyed by get_bond_key(a, b, jimage), matching the shadow-sync diff key.
  const EMPTY_ORDER_MAP: ReadonlyMap<string, number> = new Map()
  const EMPTY_RINGS: AromaticRing[] = []
  // Single perception pass → both the per-bond order map (drives the multi-
  // cylinder renderer) AND the aromatic rings (drive the dashed-circle
  // overlay). When OFF, return shared empties; perceive_* never runs (zero
  // CPU) and the order/overlay paths stay byte-identical to today.
  let adsorbate_perception = $derived.by(() => {
    if (!bond_order_perception || !structure) {
      return { orders: EMPTY_ORDER_MAP, aromatic_rings: EMPTY_RINGS }
    }
    return perceive_adsorbate(filtered_bond_pairs, structure)
  })
  let adsorbate_bond_orders = $derived(adsorbate_perception.orders)
  let aromatic_rings = $derived(adsorbate_perception.aromatic_rings)

  // Sync filtered_bond_pairs to parent for box selection
  $effect(() => {
    filtered_bond_pairs_out = filtered_bond_pairs
  })

  // Phase 7e/7f — slot → filtered_bond_pairs index map. Decorator picker /
  // hitbox hits walk the layout to recover the BondManager slot, then this
  // table resolves it to the same `filtered_bond_pairs` index that
  // cell-internal hits use, so selection / hover code paths converge.
  // Built in O(count + N) per derive: single pass over BondManager seeds a
  // content-keyed table, then each filtered pair looks up its slot.
  // Orphans (entry not yet shadow-synced) leave the slot at -1 — decorator
  // hits on those return null (degraded but harmless).
  let slot_to_filtered_idx = $derived.by((): Int32Array => {
    void bond_manager.version
    const count = bond_manager.count
    const out = new Int32Array(count)
    out.fill(-1)
    if (count === 0 || filtered_bond_pairs.length === 0) return out
    const pairs = bond_manager.pairs_buffer
    const jimg = bond_manager.jimages_buffer
    const key_to_slot = new Map<string, number>()
    for (let s = 0; s < count; s++) {
      const a = pairs[s * 2]
      const b = pairs[s * 2 + 1]
      const jx = jimg[s * 3]
      const jy = jimg[s * 3 + 1]
      const jz = jimg[s * 3 + 2]
      key_to_slot.set(`${a},${b},${jx},${jy},${jz}`, s)
    }
    for (let i = 0; i < filtered_bond_pairs.length; i++) {
      const bp = filtered_bond_pairs[i]
      const ji = bp.jimage ?? [0, 0, 0]
      const direct = `${bp.site_idx_1},${bp.site_idx_2},${ji[0]},${ji[1]},${ji[2]}`
      let slot = key_to_slot.get(direct)
      if (slot === undefined) {
        // Stored as (b, a, -jimage) — direction-aware swap mirrors
        // BondManager.find_slot_by_pair semantics.
        const swapped = `${bp.site_idx_2},${bp.site_idx_1},${-ji[0]},${-ji[1]},${-ji[2]}`
        slot = key_to_slot.get(swapped)
      }
      if (slot !== undefined) out[slot] = i
    }
    return out
  })

  // ═══ Shadow sync: mirror filtered_bond_pairs into bond_manager (diff-based) ═══
  // Flag-gated. Computes the delta between filtered_bond_pairs and the current
  // bond_manager contents, then issues only add_bonds / remove_bonds for the
  // change. Unchanged bonds stay in their slots with clean dirty state, so the
  // renderer uploads only what actually changed.
  //
  // When the delete path writes directly to bond_manager (Phase 4a), it skips
  // the old arrays — filtered_bond_pairs doesn't re-derive, this effect doesn't
  // fire, no conflict. When a manual bond is added via pencil (which DOES
  // update manual_bonds), this effect sees a new entry in filtered_bond_pairs
  // and adds it incrementally — sparse dirty_slots, fast GPU sync.
  $effect(() => {
    const mgr = bond_manager

    const pairs_list = filtered_bond_pairs
    const manual_keys = manual_bond_keys  // track

    // Build a key → (site_idx_1, site_idx_2, kind, jimage) map for the DESIRED
    // state. The key includes jimage so two bonds with the same atom pair but
    // different lattice translations (e.g. (3, 7, [0,0,0]) vs (3, 7, [1,0,0]))
    // are kept as separate slots — failing to disambiguate would let the
    // shadow sync collapse them into one and silently drop the other.
    const desired = new Map<string, {
      a: number
      b: number
      k: BondKind
      jx: number
      jy: number
      jz: number
    }>()
    for (let i = 0; i < pairs_list.length; i++) {
      const bp = pairs_list[i]
      const ji = bp.jimage
      const jx = ji[0] | 0
      const jy = ji[1] | 0
      const jz = ji[2] | 0
      // Canonical key: sort atom indices, negate jimage when swapping to keep
      // (a, b, [+1,0,0]) ≡ (b, a, [-1,0,0]) as one entry.
      const swap = bp.site_idx_1 >= bp.site_idx_2
      const lo = swap ? bp.site_idx_2 : bp.site_idx_1
      const hi = swap ? bp.site_idx_1 : bp.site_idx_2
      const cdx = swap ? -jx : jx
      const cdy = swap ? -jy : jy
      const cdz = swap ? -jz : jz
      const key = `${lo}-${hi}-${cdx},${cdy},${cdz}`
      desired.set(key, {
        a: bp.site_idx_1,
        b: bp.site_idx_2,
        k: manual_keys.has(get_bond_key(bp.site_idx_1, bp.site_idx_2)) ? BOND_KIND.MANUAL : BOND_KIND.AUTO,
        jx,
        jy,
        jz,
      })
    }

    // Scan bond_manager's current state. For each live slot:
    //  - If its (atom-pair + jimage) key is in `desired`, the bond stays;
    //    delete from `desired` so what remains is the set to add.
    //  - Otherwise schedule the slot for removal.
    // We collect slots to remove rather than removing in-line because
    // swap-and-pop reorders live slots during iteration; collect-first then
    // bulk-remove keeps indices stable.
    const pairs_buf = mgr.pairs_buffer
    const kinds_buf = mgr.kinds_buffer
    const jimages_buf = mgr.jimages_buffer
    const count = mgr.count
    const slots_to_remove: number[] = []
    for (let slot = 0; slot < count; slot++) {
      const a = pairs_buf[slot * 2]
      const b = pairs_buf[slot * 2 + 1]
      const sjx = jimages_buf[slot * 3]
      const sjy = jimages_buf[slot * 3 + 1]
      const sjz = jimages_buf[slot * 3 + 2]
      const swap = a >= b
      const lo = swap ? b : a
      const hi = swap ? a : b
      const cdx = swap ? -sjx : sjx
      const cdy = swap ? -sjy : sjy
      const cdz = swap ? -sjz : sjz
      const key = `${lo}-${hi}-${cdx},${cdy},${cdz}`
      const want = desired.get(key)
      if (want !== undefined) {
        // Bond is in both sets. If kind drifted, patch it.
        if (kinds_buf[slot] !== want.k) mgr.set_kind(slot, want.k)
        desired.delete(key)
      } else {
        slots_to_remove.push(slot)
      }
    }

    // Apply removals first, then adds.
    if (slots_to_remove.length > 0) mgr.remove_bonds(slots_to_remove)

    if (desired.size > 0) {
      const n_add = desired.size
      const add_pairs = new Uint32Array(n_add * 2)
      const add_kinds = new Uint8Array(n_add)
      const add_jimages = new Int8Array(n_add * 3)
      let idx = 0
      for (const { a, b, k, jx, jy, jz } of desired.values()) {
        add_pairs[idx * 2] = a
        add_pairs[idx * 2 + 1] = b
        add_kinds[idx] = k
        add_jimages[idx * 3] = jx
        add_jimages[idx * 3 + 1] = jy
        add_jimages[idx * 3 + 2] = jz
        idx++
      }
      mgr.add_bonds(add_pairs, add_kinds, add_jimages)
    }

    // ── Adsorbate bond-order pass (default-OFF) ──────────────────────────
    // When bond_order_perception is OFF, `adsorbate_bond_orders` is a shared
    // EMPTY_MAP and perceive_* never runs (zero CPU); we also skip the write
    // pass entirely so ensure_orders() is never called and orders_buffer stays
    // null — byte-identical GPU bytes to today. When ON, write each live slot's
    // perceived order (default 1), keyed by the same get_bond_key the diff uses.
    const order_map = adsorbate_bond_orders
    // Run the write pass whenever the buffer is (or needs to be) live — not
    // only when the new map is non-empty. Once orders_buffer exists
    // (mgr.has_orders), a transition to an EMPTY map (e.g. the only
    // double/triple bond relaxed to single during a geo-opt/drag/trajectory
    // tick) must still re-walk every slot and clear stale 2.0/3.0/1.5 back to
    // 1; otherwise the instanced renderer keeps drawing a phantom multi-bond.
    if (order_map.size > 0 || mgr.has_orders) {
      const n_now = mgr.count
      const pb = mgr.pairs_buffer
      const jb = mgr.jimages_buffer
      mgr.begin_orders_batch()
      // Lazy first allocation stays gated on a non-empty map; once the buffer
      // exists the has_orders branch keeps it in sync.
      if (order_map.size > 0) mgr.ensure_orders()
      try {
        for (let slot = 0; slot < n_now; slot++) {
          const a = pb[slot * 2]
          const b = pb[slot * 2 + 1]
          const sjx = jb[slot * 3]
          const sjy = jb[slot * 3 + 1]
          const sjz = jb[slot * 3 + 2]
          const ord = order_map.get(get_bond_key(a, b, [sjx, sjy, sjz])) ?? 1
          mgr.set_order(slot, ord)
        }
      } finally {
        mgr.commit_orders_batch()
      }
    }
  })

  // ═══ AtomManager SoA shadow store ═══
  // Phase X2 of the atom refactor. The manager is a lazy mirror of
  // `structure.sites`; the renderer migration is X3, flag-gated.
  // Plan v3 Phase 1: atom_manager is now a $bindable prop (declared in the
  // props block above). Structure.svelte binds to it via bind:atom_manager,
  // enabling Phase 2's position-write loop to drive the manager directly
  // from outside StructureScene without going through the X2 shadow sync.

  // Reused buffers for the shadow-sync `add_atoms` call. Typed-array
  // allocation dominates the cost for large adds; keeping them around
  // between runs means we only pay for growth, not for the common
  // incremental-edit case where a handful of atoms change.
  let __atom_sync_site_ids = new Uint32Array(0)
  let __atom_sync_positions = new Float32Array(0)
  let __atom_sync_elements = new Uint8Array(0)
  let __atom_sync_radii = new Float32Array(0)

  // ═══ Shadow sync: mirror structure.sites + visual overrides into atom_manager (diff-based) ═══
  // Flag stays false through X2 — nothing reads the manager in hot paths yet.
  // Unlike `atom_data` (which is render-oriented and skips hidden sites/elements),
  // the manager is the raw pre-filter mirror of `structure.sites`. The X3 renderer
  // will handle visibility separately via the dirty masks. Mirroring pre-filter
  // means visibility toggles (hide elements, hide property-values) don't churn the
  // manager — they only affect the downstream renderer's visibility mask.
  //
  // Diff shape mirrors the bond shadow sync: build a `desired` Map keyed by
  // `site_id` (the `structure.sites` index), scan live slots to classify as
  // KEEP-and-update or REMOVE, then bulk-remove + bulk-add what's left.
  //
  // DO NOT read `atom_manager.version` here — mutations on the manager bump it
  // and would re-fire this $effect in an infinite loop. We intentionally track
  // only the upstream inputs (sites, override maps, property_colors, plugin
  // color contributions, radius params).
  // Memo + trajectory-fast-path state for the X2 shadow sync.
  // Identity snapshots used to (a) skip pure no-op fires (Svelte 5 over-fires
  // are absorbed) and (b) detect "trajectory frame advanced, nothing else
  // changed" so we can absorb Svelte over-fires for non-trajectory operations.
  // Plan v3 Phase 6: __x2_prev_traj and __x2_fast_path_count deleted (the
  // trajectory_only / positions_only branches that used them are gone — the
  // Phase 5.5 gate prevents X2 from running during playback).
  let __x2_prev_struct: unknown = null
  let __x2_prev_prop_colors: unknown = null
  let __x2_prev_sro: unknown = null
  let __x2_prev_sco: unknown = null
  let __x2_prev_sro_sig = ``
  let __x2_prev_sco_sig = ``
  let __x2_prev_ero: unknown = null
  let __x2_prev_same_size = false
  let __x2_prev_atom_radius = -1
  let __x2_prev_hook_count = -1
  let __x2_prev_plugin_count = -1
  let __x2_prev_color_hash = ``
  let __x2_initialized = false
  let __x2_skips = 0

  $effect(() => {
    // Plan v3 Phase 5.5 gate (HARD precondition for C6 patch deletion):
    // Trajectory positions are written by Structure.svelte's position-write
    // loop (Phase 2) directly into atom_manager. X2 has no work to do during
    // playback ONCE the manager is populated. Without this gate, Phase 6's
    // deletion of the trajectory_only branch (lines ~2406-2422) would cause
    // X2 to fall through to the ~15-30ms slow-path full diff on every frame
    // — the entire performance regression the bypass refactor exists to
    // prevent (W6 Reviewer 2 CRITICAL).
    //
    // Gate condition (refined): traj active AND manager count matches the
    // current sites. Without the count-match check, the gate would block
    // X2's initial topology sync when atom_manager.count is still 0 — the
    // Phase 2 loop's max_slot would be 0 → manager never populates → atoms
    // never appear. The count-mismatch path (initial mount, structure swap,
    // supercell toggle) still runs X2's full sync.
    //
    // Reactive subscription note: this read of trajectory_frame_positions
    // establishes the dependency. When playback ends, traj_positions becomes
    // null, this gate returns false, and the effect runs the full sync once
    // (the topology-recompute-on-stop). Correct.
    //
    // Implementation note: route through a local const so TypeScript doesn't
    // narrow `trajectory_frame_positions` to `null` in the rest of the
    // function — the (now-dead) trajectory_only / positions_only branches
    // below still reference it, and Phase 6 will delete those branches.
    //
    // Counter increment moves BELOW the gate so x2_fires goes to 0 during
    // playback — Test 8.3 acceptance.
    const __ph55_gate_traj: Float32Array | null = trajectory_frame_positions
    const __ph55_gate_sites = structure?.sites
    if (
      __ph55_gate_traj != null
      && __ph55_gate_sites != null
      && atom_manager.count === __ph55_gate_sites.length
    ) return
    if (import.meta.env?.DEV) __probe_x2_fires++
    // R8.7 PROBE — load-cascade timing.
    const __sync_t0 = (import.meta.env?.DEV) ? performance.now() : 0
    const mgr = atom_manager
    // Track structure identity too, not just `.sites` — if `structure` is
    // swapped to a new wrapper that happens to reuse the same sites array,
    // we still want the sync to re-fire.
    void structure
    const sites = structure?.sites
    if (!sites) {
      if (mgr.count > 0) mgr.clear()
      return
    }

    // Track the reactive inputs we need the sync to re-fire on. Mirrors
    // what `atom_data` reads for radius/color resolution.
    const _ero_keys = Object.keys(element_radius_overrides ?? {})
    const _site_r_size = site_radius_overrides?.size ?? 0
    const _site_c_size = site_color_overrides?.size ?? 0
    const _prop_colors_ref = property_colors // whole-object reassign triggers
    const _same_size = same_size_atoms
    const _atom_radius = atom_radius
    // Force plugin reactivity (same pattern as atom_data)
    const _hook_count = pluginManager.structureHooks.get('atomColors')?.length ?? 0
    const _enabled_plugin_count = pluginManager.enabledPlugins.length
    // Trajectory fast-path input: read identity now so Svelte subscribes.
    const traj_positions = trajectory_frame_positions
    // Per-element color hash. Reads colors.element entries for the elements
    // present in this structure, joined into a single string. When the user
    // recolors element X in the legend, this hash changes and the gate below
    // recognizes it as a meaningful update — without this, the manager's
    // shadow sync skipped recoloring (atom_data ref-equality didn't fire).
    let _color_hash = ``
    {
      const seen = new Set<string>()
      for (let i = 0; i < sites.length; i++) {
        const el = sites[i]?.species?.[0]?.element as string | undefined
        if (!el || seen.has(el)) continue
        seen.add(el)
        _color_hash += `${el}=${(colors.element as Record<string, string>)?.[el] ?? ``};`
      }
    }
    void _ero_keys; void _site_r_size; void _site_c_size; void _prop_colors_ref
    void _same_size; void _atom_radius; void _hook_count; void _enabled_plugin_count
    void _color_hash

    // ── Memoization & trajectory fast-path branch ──────────────────────
    // Plan v3 Phase 6: trajectory_only and positions_only fast-path branches
    // deleted. The Phase 5.5 gate at the top of this effect ensures X2 never
    // runs during trajectory playback (when atom_manager is in sync). The
    // remaining "Nothing changed" early-return absorbs Svelte over-fires for
    // non-trajectory operations (drag, topology, selection) — preserved as
    // protection against unnecessary slow-path runs.
    // Build content signatures for the reactive Maps. SvelteMap.set()
    // mutates in place, so a `!==` ref comparison would always be false
    // when the user changes per-site colors via the right-click picker
    // — the gate below would short-circuit and the GPU instance colors
    // would never repaint. The signature captures both size AND every
    // key=value pair so any add / remove / change of a value triggers
    // a sync, while ref-stable no-op fires still get filtered out.
    let _sco_sig = ``
    if (site_color_overrides && site_color_overrides.size > 0) {
      for (const [k, v] of site_color_overrides) _sco_sig += `${k}=${v};`
    }
    let _sro_sig = ``
    if (site_radius_overrides && site_radius_overrides.size > 0) {
      for (const [k, v] of site_radius_overrides) _sro_sig += `${k}=${v};`
    }

    if (__x2_initialized) {
      const struct_changed = structure !== __x2_prev_struct
      const prop_changed = _prop_colors_ref !== __x2_prev_prop_colors
      const sro_changed = _sro_sig !== __x2_prev_sro_sig
      const sco_changed = _sco_sig !== __x2_prev_sco_sig
      const ero_changed = element_radius_overrides !== __x2_prev_ero
      const same_size_changed = _same_size !== __x2_prev_same_size
      const radius_changed = _atom_radius !== __x2_prev_atom_radius
      const hooks_changed = _hook_count !== __x2_prev_hook_count
      const plugins_changed = _enabled_plugin_count !== __x2_prev_plugin_count
      const colors_changed = _color_hash !== __x2_prev_color_hash

      const anything_changed =
        struct_changed || prop_changed || sro_changed
        || sco_changed || ero_changed || same_size_changed
        || radius_changed || hooks_changed || plugins_changed
        || colors_changed

      if (!anything_changed) {
        if (import.meta.env?.DEV) {
          __x2_skips++
          if (__x2_skips % 100 === 0) console.log(`[probe] X2 shadow sync: skipped ${__x2_skips} no-op fires`)
        }
        return
      }
    }
    // Slow path: full diff. Reached only for non-trajectory operations
    // (drag commits, topology mutations, selection updates).
    if (import.meta.env?.DEV) __probe_x2_slow_meaningful++
    __x2_initialized = true
    __x2_prev_struct = structure
    __x2_prev_prop_colors = _prop_colors_ref
    __x2_prev_sro = site_radius_overrides
    __x2_prev_sco = site_color_overrides
    __x2_prev_sro_sig = _sro_sig
    __x2_prev_sco_sig = _sco_sig
    __x2_prev_ero = element_radius_overrides
    __x2_prev_same_size = _same_size
    __x2_prev_atom_radius = _atom_radius
    __x2_prev_hook_count = _hook_count
    __x2_prev_plugin_count = _enabled_plugin_count
    __x2_prev_color_hash = _color_hash

    // --- Build initialColors + pluginColors mirror (same chain as atom_data) ---
    // Used for the color priority chain below. This must match atom_data's
    // fallback order to keep the manager parity-correct with what the old
    // renderer draws. Uses `get_orig_site_idx` (not the inline ternary in
    // atom_data's initial-colors block) — same behavior, one source of truth
    // so the two paths can't drift.
    const initial_colors: (string | null)[] = sites.map((site, site_idx) => {
      const orig_idx = get_orig_site_idx(site, site_idx)
      const site_property_color = property_colors?.colors[orig_idx]
      const first_element = site.species[0]?.element
      return site_property_color ?? colors.element?.[first_element] ?? null
    })
    const plugin_colors = pluginManager.applyAtomColorsHooks(sites, initial_colors)

    // --- Build `desired` map: site_id → attributes ---
    type DesiredRow = {
      x: number; y: number; z: number
      atomic_number: number
      radius: number
      r: number; g: number; b: number
    }
    const desired = new Map<number, DesiredRow>()
    for (let site_idx = 0; site_idx < sites.length; site_idx++) {
      const site = sites[site_idx]
      // Partial-occupancy handling: manager stores one atom per site. Use the
      // first species as the representative (full species handling is out of
      // scope for X2 — the existing `atom_data` path renders wedges, the new
      // system will address multi-species when X6 lands).
      const first_species = site.species[0]
      const element = first_species?.element as ElementSymbol | undefined
      if (!element) continue
      const atomic_number = element_to_atomic_number(element)

      // Radius chain matches atom_data exactly:
      //   site-level override > same_size_atoms > occu-weighted element radii
      const site_override_r = site_radius_overrides?.get(site_idx)
      const radius = site_override_r !== undefined
        ? site_override_r * atom_radius
        : same_size_atoms
          ? atom_radius
          : site.species.reduce(
              (sum, spec) => sum + spec.occu * (element_radius_overrides?.[spec.element] ?? atomic_radii[spec.element] ?? 1),
              0,
            ) * atom_radius

      // Color priority (matches atom_data's chain): site_override > plugin >
      // property_color > element. NOTE: we do NOT filter by hidden_* here —
      // the manager is the raw pre-filter mirror.
      const orig_idx = get_orig_site_idx(site, site_idx)
      const site_property_color = property_colors?.colors[orig_idx]
      const site_color_override = site_color_overrides?.get(site_idx)
      const plugin_color = plugin_colors[site_idx]
      const color_hex = site_color_override ?? plugin_color ?? site_property_color ?? colors.element?.[element] ?? `#ffffff`
      const [r, g, bl] = __hex_to_linear_rgb(color_hex)

      const xyz = site.xyz
      desired.set(site_idx, {
        x: xyz[0], y: xyz[1], z: xyz[2],
        atomic_number,
        radius,
        r, g: g, b: bl,
      })
    }

    // --- Scan live slots: classify as keep-update or remove ---
    const live_count = mgr.count
    const slots_to_remove: number[] = []
    for (let slot = 0; slot < live_count; slot++) {
      const sid = mgr.site_ids_buffer[slot]
      const row = desired.get(sid)
      if (row === undefined) {
        slots_to_remove.push(slot)
        continue
      }
      // KEEP. Apply per-attribute setters — they no-op on unchanged values
      // (Math.fround comparison), so unconditional calls don't falsely dirty
      // anything. Batch colors so a single slot update bumps version only
      // once for colors regardless of rgb triple identity.
      mgr.set_position(slot, row.x, row.y, row.z)
      mgr.set_radius(slot, row.radius)
      mgr.set_element(slot, row.atomic_number)
      mgr.set_color(slot, row.r, row.g, row.b)
      desired.delete(sid)
    }

    // --- Apply removals, then adds ---
    if (slots_to_remove.length > 0) mgr.remove_atoms(slots_to_remove)

    if (desired.size > 0) {
      const n = desired.size
      // Grow reusable scratch buffers if needed (grow-only — typical edit
      // is small so reuse is the common case).
      if (__atom_sync_site_ids.length < n) __atom_sync_site_ids = new Uint32Array(n)
      if (__atom_sync_positions.length < n * 3) __atom_sync_positions = new Float32Array(n * 3)
      if (__atom_sync_elements.length < n) __atom_sync_elements = new Uint8Array(n)
      if (__atom_sync_radii.length < n) __atom_sync_radii = new Float32Array(n)
      const sid_buf = __atom_sync_site_ids.subarray(0, n)
      const pos_buf = __atom_sync_positions.subarray(0, n * 3)
      const elem_buf = __atom_sync_elements.subarray(0, n)
      const rad_buf = __atom_sync_radii.subarray(0, n)

      // Collect new-slot colors separately so we can batch a single version
      // bump for all of them after add_atoms.
      const new_colors: Array<[number, number, number]> = new Array(n)
      const new_sids: number[] = new Array(n)
      let i = 0
      for (const [sid, row] of desired) {
        sid_buf[i] = sid
        pos_buf[i * 3] = row.x
        pos_buf[i * 3 + 1] = row.y
        pos_buf[i * 3 + 2] = row.z
        elem_buf[i] = row.atomic_number
        rad_buf[i] = row.radius
        new_colors[i] = [row.r, row.g, row.b]
        new_sids[i] = sid
        i++
      }
      mgr.add_atoms(sid_buf, pos_buf, elem_buf, rad_buf)

      // Populate colors for the freshly-added slots. Batch so it's one
      // version bump for the whole group.
      mgr.begin_colors_batch()
      for (let j = 0; j < n; j++) {
        const slot = mgr.find_slot_by_site_id(new_sids[j])
        if (slot < 0) continue
        const [cr, cg, cb] = new_colors[j]
        mgr.set_color(slot, cr, cg, cb)
      }
      mgr.commit_colors_batch()
    }

    // --- DEV parity assertion ---
    // Confirms the manager is a faithful mirror of `structure.sites` after
    // every sync. Guarded so it can never break rendering; drift is logged,
    // not thrown. This is the "dev-mode parity assertion" called out as an
    // X2 risk mitigation in plans/atom-soa-refactor.md.
    if (import.meta.env?.DEV) {
      try {
        const n_expected = sites.length
        if (mgr.count !== n_expected) {
          console.warn('[atom-shadow-sync] parity drift: count mismatch', {
            mgr_count: mgr.count, sites_length: n_expected,
          })
        }
        const EPS = 1e-4
        // Sample up to 64 slots to keep the check cheap on large structures.
        const stride = Math.max(1, Math.floor(mgr.count / 64))
        for (let slot = 0; slot < mgr.count; slot += stride) {
          const sid = mgr.get_site_id(slot)
          if (sid === undefined || sid >= n_expected) {
            console.warn('[atom-shadow-sync] parity drift: bad site_id at slot', { slot, sid, n_expected })
            break
          }
          const site = sites[sid]
          const expected_element = element_to_atomic_number(site.species[0]?.element as ElementSymbol)
          if (mgr.get_element(slot) !== (expected_element & 0xff)) {
            console.warn('[atom-shadow-sync] parity drift: element mismatch', {
              slot, sid, mgr_element: mgr.get_element(slot), expected_element,
            })
            break
          }
          const dx = Math.abs(mgr.get_x(slot) - site.xyz[0])
          const dy = Math.abs(mgr.get_y(slot) - site.xyz[1])
          const dz = Math.abs(mgr.get_z(slot) - site.xyz[2])
          if (dx > EPS || dy > EPS || dz > EPS) {
            console.warn('[atom-shadow-sync] parity drift: position mismatch', {
              slot, sid, mgr_xyz: [mgr.get_x(slot), mgr.get_y(slot), mgr.get_z(slot)], expected: site.xyz,
            })
            break
          }
        }
      } catch (err) {
        // Never let the parity check break rendering.
        console.warn('[atom-shadow-sync] parity check threw:', err)
      }
    }
    if (import.meta.env?.DEV) {
      const __dt = performance.now() - __sync_t0
      if (__dt > 5) console.log(`[probe] X2 shadow sync: ${__dt.toFixed(1)}ms (${sites.length} sites, mgr.count=${mgr.count})`)
    }
  })

  // ═══ Phase X5/X6: expose atom mutation fast-paths to the parent ═══
  // StructureScene owns `atom_manager` (local), `bond_state` (local) and
  // receives `bond_manager` as a prop. The parent (Structure.svelte) can't
  // run the fast path directly — none of those are in its scope. Instead we
  // publish hooks here and bind them out. Callers invoke `try_X` BEFORE
  // mutating `structure.sites` so bond-state fingerprints get bumped to the
  // post-mutation state; the next tick's `compute_bond_connectivity` then
  // sees "nothing changed" and skips the expensive WASM recompute.
  //
  // Flag-off: returns false, caller falls through to the legacy round-trip.
  //
  // Color/radius resolution at the hook (X6 simplification):
  //   - Radius uses the atom_data chain (site_override > same_size_atoms >
  //     occu-weighted). For add the site has only one species; replace
  //     recomputes from the NEW element.
  //   - Color uses `colors.element[element]` as an initial estimate. The
  //     X2 shadow sync overwrites on the next tick with the full priority
  //     chain (site_color_override > plugin > property_color > element).
  //     `set_color` no-ops on unchanged values, so this doesn't churn the
  //     GPU. Documented in plans/atom-soa-refactor.md X6.
  function __resolve_radius_for_element(element: ElementSymbol, site_id: number): number {
    const site_override_r = site_radius_overrides?.get(site_id)
    if (site_override_r !== undefined) return site_override_r * atom_radius
    if (same_size_atoms) return atom_radius
    // Single-species fast-path (new atoms always have occu=1 single species;
    // replace keeps partial occupancy as-is but the shadow sync will re-run
    // the full chain — we just seed with the primary element here).
    const base = element_radius_overrides?.[element] ?? atomic_radii[element] ?? 1
    return base * atom_radius
  }
  function __resolve_color_for_element(element: ElementSymbol): [number, number, number] {
    const hex = colors.element?.[element] ?? `#ffffff`
    return __hex_to_linear_rgb(hex)
  }

  $effect(() => {
    atom_fast_ops = {
      try_delete: (deleted_site_ids: readonly number[], new_sites: readonly Site[]): boolean => {
        if (!USE_NEW_ATOM_SYSTEM) return false
        if (deleted_site_ids.length === 0) return false
        const t0 = import.meta.env?.DEV ? performance.now() : 0
        // Order matters — see plan X5 "Ordering":
        //  1. AtomManager compaction + site_id reindex.
        //  2. Bond-state: drop+reindex bond_connectivity AND pre-emptively
        //     bump last_bond_fingerprint / last_elem_fingerprint to the
        //     post-delete sites. Without step 2, the next tick's bond
        //     fingerprint check would fail and trigger a full recompute.
        atom_manager.apply_atom_delete(deleted_site_ids)
        apply_atom_delete_incremental(bond_state, deleted_site_ids, bond_manager, new_sites as Site[])
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.log(`[atoms-X5] fast delete: ${deleted_site_ids.length} atom(s), ${(performance.now() - t0).toFixed(2)}ms`)
        }
        return true
      },
      try_add: (added: readonly AtomAddSpec[], new_sites: readonly Site[]): boolean => {
        if (!USE_NEW_ATOM_SYSTEM) return false
        if (added.length === 0) return false
        if (!structure) return false
        // Bail out if any incoming site_id collides with an existing slot in
        // the manager. Pencil/fragment adds compute site_id from the
        // **un-imaged** structure length, but the manager mirrors the
        // **imaged** structure — so PBC image atoms already occupy sids in
        // the [num_original, num_original + n_images) range that collides
        // with the next pencil sid. add_atoms would overwrite the existing
        // map entry, shadow sync would then remove the new slot during its
        // diff (consuming the desired entry first, leaving the tail slot
        // unmatched), and the final remove_atoms .delete(sid) call would
        // wipe the surviving slot's map entry — leaving the buffer with the
        // sid but find_slot_by_site_id returning -1. Caller falls back to
        // canonical set_structure → shadow sync path which handles this
        // correctly. See issue #33.
        for (let i = 0; i < added.length; i++) {
          if (atom_manager.find_slot_by_site_id(added[i].site_id) >= 0) {
            return false
          }
        }
        const t0 = import.meta.env?.DEV ? performance.now() : 0
        // AtomManager: bulk-add the new slots, then set initial colors in a
        // batch. Typed-array construction per-call is fine for the small
        // number of atoms added interactively (drag/pencil/context menu).
        const n = added.length
        const site_ids = new Uint32Array(n)
        const positions = new Float32Array(n * 3)
        const atomic_numbers = new Uint8Array(n)
        const radii = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          const a = added[i]
          site_ids[i] = a.site_id
          positions[i * 3] = a.position[0]
          positions[i * 3 + 1] = a.position[1]
          positions[i * 3 + 2] = a.position[2]
          atomic_numbers[i] = element_to_atomic_number(a.element) & 0xff
          radii[i] = __resolve_radius_for_element(a.element, a.site_id)
        }
        atom_manager.add_atoms(site_ids, positions, atomic_numbers, radii)
        atom_manager.begin_colors_batch()
        for (let i = 0; i < n; i++) {
          const slot = atom_manager.find_slot_by_site_id(added[i].site_id)
          if (slot < 0) continue
          const [r, g, b] = __resolve_color_for_element(added[i].element)
          atom_manager.set_color(slot, r, g, b)
        }
        atom_manager.commit_colors_batch()
        // Bond state: delta-add new bonds and bump fingerprints. Returns
        // false on large-structure fallback — in that case the next tick's
        // compute_bond_connectivity will do the full recompute (same
        // behavior as flag-off), which is still correct but slower.
        const ok = apply_atom_add_incremental(
          bond_state, added, bond_manager, new_sites as Site[],
          structure, bonding_strategy, bonding_options_eff,
        )
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.log(`[atoms-X6] fast add: ${n} atom(s) (${ok ? 'incremental' : 'bond-fallback'}), ${(performance.now() - t0).toFixed(2)}ms`)
        }
        // Return true regardless of `ok` — the AtomManager-side happened
        // either way, and the delta-vs-fallback bond path is invisible to
        // the caller (the only observable difference is the next-tick
        // recompute happening or not).
        return true
      },
      try_replace: (replacements: readonly AtomReplaceSpec[], new_sites: readonly Site[]): boolean => {
        if (!USE_NEW_ATOM_SYSTEM) return false
        if (replacements.length === 0) return false
        if (!structure) return false
        const t0 = import.meta.env?.DEV ? performance.now() : 0
        // AtomManager: per-slot element, radius, and (initial) color update.
        atom_manager.begin_colors_batch()
        for (const r of replacements) {
          const slot = atom_manager.find_slot_by_site_id(r.site_id)
          if (slot < 0) continue
          atom_manager.set_element(slot, element_to_atomic_number(r.new_element))
          atom_manager.set_radius(slot, __resolve_radius_for_element(r.new_element, r.site_id))
          const [cr, cg, cb] = __resolve_color_for_element(r.new_element)
          atom_manager.set_color(slot, cr, cg, cb)
        }
        atom_manager.commit_colors_batch()
        // Bond state: full recompute-and-diff (topology can change on
        // element change — covalent radius shifts).
        const ok = apply_atom_replace_incremental(
          bond_state, replacements, bond_manager, new_sites as Site[],
          structure, bonding_strategy, bonding_options_eff,
        )
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.log(`[atoms-X6] fast replace: ${replacements.length} atom(s) (${ok ? 'incremental' : 'bond-fallback'}), ${(performance.now() - t0).toFixed(2)}ms`)
        }
        return true
      },
      try_move: (moved: readonly AtomMoveSpec[], new_sites: readonly Site[]): boolean => {
        if (!USE_NEW_ATOM_SYSTEM) return false
        if (moved.length === 0) return false
        if (!structure) return false
        const t0 = import.meta.env?.DEV ? performance.now() : 0
        // AtomManager: per-slot position update. set_position is no-op-safe
        // on unchanged xyz (Math.fround equality guard).
        for (const m of moved) {
          const slot = atom_manager.find_slot_by_site_id(m.site_id)
          if (slot < 0) continue
          atom_manager.set_position(slot, m.new_position[0], m.new_position[1], m.new_position[2])
        }
        // Bond state: full recompute-and-diff (topology can change on
        // position change — distances shift). See the X6b note inside
        // apply_atom_move_incremental about the drag fast-path.
        const ok = apply_atom_move_incremental(
          bond_state, moved, bond_manager, new_sites as Site[],
          structure, bonding_strategy, bonding_options_eff,
        )
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.log(`[atoms-X6] fast move: ${moved.length} atom(s) (${ok ? 'incremental' : 'bond-fallback'}), ${(performance.now() - t0).toFixed(2)}ms`)
        }
        return true
      },
    }
    return () => { atom_fast_ops = null }
  })

  // Flat xyz positions buffer for BondManagerInstances. Returns an empty
  // buffer when no sites are present so the component can still construct
  // (it tracks identity for force_full_resync).
  //
  // Plan v3 Phase 1 (Reviewer 1 H2 fix): subscribe to atom_manager.version
  // and overlay manager positions over structure.sites. Without this, after
  // Phase 4 stops the per-frame current_structure cascade, structure.sites
  // freezes → atom_positions_buffer freezes → bonds visually freeze while
  // atoms (rendered via atom_manager directly) animate. The overlay picks
  // up Phase 2's per-frame set_position calls, so bonds follow.
  // Under the current baseline (pre-Phase-4), structure.sites still cascades
  // per frame and atom_manager mirrors it — both produce the same positions,
  // overlay is idempotent.
  let atom_positions_buffer = $derived.by(() => {
    if (import.meta.env?.DEV) __probe_apb_fires++
    const mgr = atom_manager
    void mgr.version // subscribe to per-slot position writes
    const sites = structure?.sites
    if (!sites || sites.length === 0) return EMPTY_POSITIONS
    if (import.meta.env?.DEV) __probe_apb_meaningful++
    // Buffer is indexed by site_idx (bond_connectivity uses site_idx).
    // Initial fill from sites covers the mount window before X2 shadow sync
    // populates the manager.
    const buf = new Float32Array(sites.length * 3)
    for (let i = 0; i < sites.length; i++) {
      const xyz = sites[i].xyz
      buf[i * 3]     = xyz[0]
      buf[i * 3 + 1] = xyz[1]
      buf[i * 3 + 2] = xyz[2]
    }
    // Overlay manager positions (slot → site_idx via site_ids_buffer). After
    // Phase 4 this is the only path that updates per-frame.
    for (let slot = 0; slot < mgr.count; slot++) {
      const sid = mgr.site_ids_buffer[slot]
      if (sid >= sites.length) continue // supercell-extra: leave at sites pos
      buf[sid * 3]     = mgr.get_x(slot)
      buf[sid * 3 + 1] = mgr.get_y(slot)
      buf[sid * 3 + 2] = mgr.get_z(slot)
    }
    return buf
  })

  // WebGPU overlay bridge: expose `atom_positions_buffer` to the parent as a
  // getter. The overlay calls this in its per-frame refresh to source the
  // SAME resolved per-displayed-atom positions the WebGL bonds/atoms use —
  // no independent re-derivation from base-only trajectory data. Reading the
  // $derived inside the returned closure (not capturing a snapshot) means each
  // call yields the live current-frame array. Assigned via $effect so the
  // binding survives prop reassignment churn.
  $effect(() => {
    get_displayed_frame_positions = () => atom_positions_buffer
    return () => { get_displayed_frame_positions = null }
  })

  // Flat row-major Float64Array(9) for BondManagerInstances. Rows are the
  // lattice vectors a, b, c (pymatgen convention) — used to compute
  // `b_eff = pos_b + lattice·jimage` per bond when rendering cross-cell
  // halves. `null` for non-periodic structures (molecules); bonds in that
  // case must all have jimage = [0,0,0].
  let bond_lattice_matrix = $derived.by((): Float64Array | null => {
    const lat = (structure as { lattice?: { matrix?: number[][] } })?.lattice
    const m = lat?.matrix
    if (!m || m.length !== 3) return null
    const out = new Float64Array(9)
    out[0] = m[0][0]; out[1] = m[0][1]; out[2] = m[0][2]
    out[3] = m[1][0]; out[4] = m[1][1]; out[5] = m[1][2]
    out[6] = m[2][0]; out[7] = m[2][1]; out[8] = m[2][2]
    return out
  })

  // Flat linear-RGB buffer for BondManagerInstances' gradient shader.
  // One xyz triple per site; bonds look up colors by site_idx at render time.
  // Per-site color overrides (from the right-click "Set Color" picker)
  // take priority over the element-default color so that recoloring an
  // atom also recolors the bond halves incident to it. The `.size` read
  // subscribes this $derived to SvelteMap changes (set/delete/clear).
  let atom_colors_buffer = $derived.by(() => {
    if (import.meta.env?.DEV) __probe_acb_fires++
    const sites = structure?.sites
    if (!sites || sites.length === 0) return EMPTY_COLORS
    if (import.meta.env?.DEV) __probe_acb_meaningful++
    // Subscribe to override-map mutations. `.size` is the cheapest read
    // that reactively tracks adds/removes; SvelteMap.set on an existing
    // key also triggers per-key .get() subscribers below.
    const _sco_size = site_color_overrides?.size ?? 0
    void _sco_size
    const out = new Float32Array(sites.length * 3)
    for (let i = 0; i < sites.length; i++) {
      const override_hex = site_color_overrides?.get(i)
      const hex = override_hex ?? get_majority_color(sites[i], colors.element, bond_color)
      const [r, g, b] = __hex_to_linear_rgb(hex)
      out[i * 3]     = r
      out[i * 3 + 1] = g
      out[i * 3 + 2] = b
    }
    return out
  })

  // Build a set for fast selected_bonds lookup
  let selected_bond_keys = $derived.by(() => new Set(selected_bonds.map(b => b.key)))

  // Bond hitbox batching: single InstancedMesh for all bond hitboxes
  let bond_hitbox_mesh: ThreeInstancedMesh | undefined = $state()
  // Phase 7f — per-bond-hitbox-instance map back to a filtered_bond_pairs
  // index. Cell-internal halves get `i >>> 1`; decorator halves resolve
  // through `slot_to_filtered_idx`. Click / hover handlers read this
  // instead of the legacy `>>> 1` shorthand. `-1` entries (orphan slots)
  // are treated as null hits.
  let bond_hitbox_instance_to_filtered_idx: Int32Array = $state(new Int32Array(0))
  const bond_hitbox_geometry = new CylinderGeometry(1, 1, 1, 6)
  const bond_hitbox_material = new MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
  })

  // ─── Bond halo (fresnel) — visually unifies with atom selection halo ───
  // Open-ended cylinder so end-on view doesn't get a solid cap; radial
  // segments 24 for a clean silhouette. Geometry rebuilds when bond_thickness
  // changes (rare). The bond's own transform_matrix scales height to bond
  // length and leaves radius scale at 1, so a unit cylinder at our chosen
  // radius produces a sleeve of that radius.
  const bond_halo_uniforms = {
    uOpacity: { value: 0 },
    uColor: { value: new Color(0xffff66) },
  }
  let bond_halo_geometry = $derived(
    new CylinderGeometry(bond_thickness * 2.1, bond_thickness * 2.1, 1, 24, 1, true),
  )
  const bond_halo_material = new ShaderMaterial({
    vertexShader: `
      varying vec3 vViewNormal;
      varying vec3 vViewPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      uniform vec3 uColor;
      varying vec3 vViewNormal;
      varying vec3 vViewPos;
      void main() {
        vec3 viewDir = normalize(-vViewPos);
        float NdotV = abs(dot(normalize(vViewNormal), viewDir));
        // Cylinder silhouette is a thin band along the side; without a
        // soft exponent + boost it disappears at typical zooms and on
        // light themes. Match the atom halo (exp 1.2, boost 1.5).
        float fresnel = pow(1.0 - NdotV, 1.2);
        float a = clamp(fresnel * uOpacity * 1.5, 0.0, 1.0);
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    uniforms: bond_halo_uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  })
  $effect(() => {
    bond_halo_uniforms.uOpacity.value = __pulse_opacity
    bond_halo_uniforms.uColor.value.set(selection_highlight_color)
    mark_dirty()
  })

  // Per-entry mesh refs (paired with the {#each entry, i} block below).
  // The matrix-sync $effect is declared after bond_halo_entries to avoid
  // TDZ when reading the $derived.
  let bond_halo_meshes: (Mesh | undefined)[] = $state([])

  // Bonds that should render a halo: union of hovered + selected (deduped).
  let bond_halo_entries = $derived.by(() => {
    const out: Array<{ key: string; matrix: number[] | Float32Array }> = []
    const seen = new Set<string>()
    if (hovered_bond_key) {
      const b = filtered_bond_pairs.find(
        (x) => get_bond_key(x.site_idx_1, x.site_idx_2) === hovered_bond_key,
      )
      if (b) {
        out.push({ key: hovered_bond_key, matrix: b.transform_matrix })
        seen.add(hovered_bond_key)
      }
    }
    for (const sb of selected_bonds) {
      if (seen.has(sb.key)) continue
      const b = filtered_bond_pairs.find(
        (x) => get_bond_key(x.site_idx_1, x.site_idx_2) === sb.key,
      )
      if (b) {
        out.push({ key: sb.key, matrix: b.transform_matrix })
        seen.add(sb.key)
      }
    }
    return out
  })

  // Reactive matrix sync: the {#each bond_halo_entries} block is keyed by
  // entry.key, so meshes persist across move/rotate ticks. We must
  // imperatively rewrite each ref's local matrix whenever entry.matrix
  // changes (driven by realtime_position_overrides → bond_pairs →
  // filtered_bond_pairs → bond_halo_entries).
  $effect(() => {
    const entries = bond_halo_entries
    for (let i = 0; i < entries.length; i++) {
      const m = bond_halo_meshes[i]
      const e = entries[i]
      if (!m || !e?.matrix) continue
      m.matrix.fromArray(e.matrix)
      m.matrixWorldNeedsUpdate = true
    }
    mark_dirty()
  })

  // Batch-update bond hitbox matrices.
  //
  // Each logical bond emits TWO hitbox instances mirroring the paired-stub
  // renderer geometry (Phase 4 + Phase 5):
  //   - intra-cell (jimage == 0): two halves meeting at midpoint
  //   - cross-cell (jimage != 0): two independent stubs anchored at each
  //     atom's CELL-INTERNAL position, pointing toward the cell boundary
  //
  // handle_bond_hitbox_click decodes `instanceId >>> 1` to bond index, so
  // clicking either stub resolves to the same logical bond.
  $effect(() => {
    if (!bond_hitbox_mesh) return
    const bonds = filtered_bond_pairs
    const layout = image_atom_layout
    const partner_drawn = partner_drawn_lookup
    const slot_lookup = slot_to_filtered_idx
    const cell_inst = bonds.length * 2
    const decorator_inst =
      layout !== null && bond_manager.count > 0 ? layout.bonds_csr.length * 2 : 0
    const total_inst = cell_inst + decorator_inst
    ensure_instance_capacity(bond_hitbox_mesh, total_inst)
    const inst_to_filtered = new Int32Array(total_inst)
    inst_to_filtered.fill(-1)
    const matrix = new Matrix4()
    const scale_matrix = new Matrix4()
    // Zero-scale matrix for suppressed hitboxes: a degenerate cylinder casts
    // no rays, so the hover picker can't catch it. Mirrors the visible
    // renderer's ZERO_MATRIX (bond-instanced-renderer.ts:54). Without this,
    // cross-cell bonds whose partners aren't drawn produce ghost-highlights
    // on empty space — visible mesh hidden, hitbox still hittable.
    const zero_matrix = new Matrix4().makeScale(0, 0, 0)
    const radius = bond_thickness * 1.5
    const lattice = bond_lattice_matrix
    const stub_scale = incomplete_periodic_edge_mode ? incomplete_edge_length_scale : 0.5
    const up_y = new Vector3(0, 1, 0)
    const v_dir = new Vector3()
    const v_mid = new Vector3()
    const v_scale = new Vector3()
    const q_rot = new Quaternion()

    for (let i = 0; i < bonds.length; i++) {
      const bond = bonds[i]
      const ji = bond.jimage ?? [0, 0, 0]
      const ax = bond.pos_1[0], ay = bond.pos_1[1], az = bond.pos_1[2]
      const bx_base = bond.pos_2[0], by_base = bond.pos_2[1], bz_base = bond.pos_2[2]
      const dx = ji[0], dy = ji[1], dz = ji[2]
      let bx = bx_base, by = by_base, bz = bz_base
      const is_periodic = (dx | dy | dz) !== 0
      if (is_periodic && lattice) {
        bx += dx * lattice[0] + dy * lattice[3] + dz * lattice[6]
        by += dx * lattice[1] + dy * lattice[4] + dz * lattice[7]
        bz += dx * lattice[2] + dy * lattice[5] + dz * lattice[8]
      }

      // Mirror the renderer's cell-internal cross-cell suppression: when
      // hide_incomplete_bonds is on, the cell-internal pass owns NONE of
      // the cross-cell visualisation (the bond-instanced renderer's
      // #write_slot collapses to ZERO_MATRIX, and the Phase 7f
      // image-atom decorator hitboxes below handle cross-cell click
      // targets via the partner-image side). Falling through here would
      // leave invisible hitbox stubs that catch hover events for bonds
      // the user can't see.
      if (is_periodic && hide_incomplete_bonds) {
        bond_hitbox_mesh.setMatrixAt(i * 2, zero_matrix)
        bond_hitbox_mesh.setMatrixAt(i * 2 + 1, zero_matrix)
        continue
      }

      const fx = bx - ax, fy = by - ay, fz = bz - az
      const length = Math.hypot(fx, fy, fz)
      if (length < 1e-8 || !Number.isFinite(length)) {
        bond_hitbox_mesh.setMatrixAt(i * 2, matrix.identity())
        bond_hitbox_mesh.setMatrixAt(i * 2 + 1, matrix.identity())
        continue
      }
      v_dir.set(fx / length, fy / length, fz / length)
      q_rot.setFromUnitVectors(up_y, v_dir)
      const half_length = length * 0.5

      if (is_periodic) {
        // Two stubs anchored at cell-internal pos_a and pos_b.
        const stub_len = half_length // mirrors renderer when stub mode off
        const half_stub = stub_len * 0.5
        v_scale.set(radius, stub_len, radius)

        v_mid.set(ax + v_dir.x * half_stub, ay + v_dir.y * half_stub, az + v_dir.z * half_stub)
        matrix.compose(v_mid, q_rot, v_scale)
        bond_hitbox_mesh.setMatrixAt(i * 2, matrix)

        v_mid.set(bx_base - v_dir.x * half_stub, by_base - v_dir.y * half_stub, bz_base - v_dir.z * half_stub)
        matrix.compose(v_mid, q_rot, v_scale)
        bond_hitbox_mesh.setMatrixAt(i * 2 + 1, matrix)
      } else {
        // Intra-cell: two halves meeting at midpoint.
        const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5
        v_scale.set(radius, half_length, radius)

        v_mid.set((ax + mx) * 0.5, (ay + my) * 0.5, (az + mz) * 0.5)
        matrix.compose(v_mid, q_rot, v_scale)
        bond_hitbox_mesh.setMatrixAt(i * 2, matrix)

        v_mid.set((mx + bx) * 0.5, (my + by) * 0.5, (mz + bz) * 0.5)
        matrix.compose(v_mid, q_rot, v_scale)
        bond_hitbox_mesh.setMatrixAt(i * 2 + 1, matrix)
      }
      inst_to_filtered[i * 2] = i
      inst_to_filtered[i * 2 + 1] = i
    }

    // Phase 7f — image-atom decorator hitboxes. Mirrors the renderer's
    // #write_image_slot geometry: anchor + partner offset under the
    // image-atom jimage, full bond when partner drawn, anchor stub
    // otherwise. Decorator hits resolve to the underlying logical bond
    // via slot_to_filtered_idx (-1 if the slot hasn't been shadow-synced
    // into filtered_bond_pairs).
    if (decorator_inst > 0 && layout !== null) {
      const pairs = bond_manager.pairs_buffer
      const jimg = bond_manager.jimages_buffer
      // Build a site_idx → world position lookup off atom_data so we can
      // shift either endpoint under the image-atom offset.
      const pos_by_site = new Map<number, Vec3>()
      for (let k = 0; k < atom_data.length; k++) {
        pos_by_site.set(atom_data[k].site_idx, atom_data[k].position)
      }
      let dec_inst_idx = cell_inst
      for (let img = 0; img < layout.n_image_atoms; img++) {
        const orig_idx = layout.orig_site_indices[img]
        const jx = layout.jimage_offsets[img * 3]
        const jy = layout.jimage_offsets[img * 3 + 1]
        const jz = layout.jimage_offsets[img * 3 + 2]
        const csr_lo = layout.row_offsets[img]
        const csr_hi = layout.row_offsets[img + 1]
        for (let k = csr_lo; k < csr_hi; k++) {
          const slot = layout.bonds_csr[k]
          const a = pairs[slot * 2]
          const b = pairs[slot * 2 + 1]
          const ji_b = slot * 3
          const bdx = jimg[ji_b]
          const bdy = jimg[ji_b + 1]
          const bdz = jimg[ji_b + 2]
          const anchor_is_a = a === (orig_idx >>> 0)
          const partner_idx = anchor_is_a ? b : a
          const pjx = anchor_is_a ? jx + bdx : jx - bdx
          const pjy = anchor_is_a ? jy + bdy : jy - bdy
          const pjz = anchor_is_a ? jz + bdz : jz - bdz
          const is_partner_drawn =
            partner_drawn === null || partner_drawn(partner_idx, pjx, pjy, pjz)

          const oax = anchor_is_a ? jx : jx - bdx
          const oay = anchor_is_a ? jy : jy - bdy
          const oaz = anchor_is_a ? jz : jz - bdz
          const obx = anchor_is_a ? jx + bdx : jx
          const oby = anchor_is_a ? jy + bdy : jy
          const obz = anchor_is_a ? jz + bdz : jz

          const pa = pos_by_site.get(a)
          const pb = pos_by_site.get(b)
          if (!pa || !pb) {
            bond_hitbox_mesh.setMatrixAt(dec_inst_idx, matrix.identity())
            bond_hitbox_mesh.setMatrixAt(dec_inst_idx + 1, matrix.identity())
            dec_inst_idx += 2
            continue
          }
          let dax = pa[0], day = pa[1], daz = pa[2]
          let dbx = pb[0], dby = pb[1], dbz = pb[2]
          if (lattice) {
            if ((oax | oay | oaz) !== 0) {
              dax += oax * lattice[0] + oay * lattice[3] + oaz * lattice[6]
              day += oax * lattice[1] + oay * lattice[4] + oaz * lattice[7]
              daz += oax * lattice[2] + oay * lattice[5] + oaz * lattice[8]
            }
            if ((obx | oby | obz) !== 0) {
              dbx += obx * lattice[0] + oby * lattice[3] + obz * lattice[6]
              dby += obx * lattice[1] + oby * lattice[4] + obz * lattice[7]
              dbz += obx * lattice[2] + oby * lattice[5] + obz * lattice[8]
            }
          }
          const dfx = dbx - dax, dfy = dby - day, dfz = dbz - daz
          const dlen = Math.hypot(dfx, dfy, dfz)
          if (dlen < 1e-8 || !Number.isFinite(dlen)) {
            bond_hitbox_mesh.setMatrixAt(dec_inst_idx, matrix.identity())
            bond_hitbox_mesh.setMatrixAt(dec_inst_idx + 1, matrix.identity())
            dec_inst_idx += 2
            continue
          }
          v_dir.set(dfx / dlen, dfy / dlen, dfz / dlen)
          q_rot.setFromUnitVectors(up_y, v_dir)
          const dhalf = dlen * 0.5
          const fidx =
            slot_lookup !== null && slot < slot_lookup.length ? slot_lookup[slot] : -1

          if (is_partner_drawn) {
            const dmx = (dax + dbx) * 0.5
            const dmy = (day + dby) * 0.5
            const dmz = (daz + dbz) * 0.5
            v_scale.set(radius, dhalf, radius)
            v_mid.set((dax + dmx) * 0.5, (day + dmy) * 0.5, (daz + dmz) * 0.5)
            matrix.compose(v_mid, q_rot, v_scale)
            bond_hitbox_mesh.setMatrixAt(dec_inst_idx, matrix)
            v_mid.set((dmx + dbx) * 0.5, (dmy + dby) * 0.5, (dmz + dbz) * 0.5)
            matrix.compose(v_mid, q_rot, v_scale)
            bond_hitbox_mesh.setMatrixAt(dec_inst_idx + 1, matrix)
            inst_to_filtered[dec_inst_idx] = fidx
            inst_to_filtered[dec_inst_idx + 1] = fidx
          } else {
            const stub_len = dhalf * stub_scale
            const half_stub = stub_len * 0.5
            v_scale.set(radius, stub_len, radius)
            if (anchor_is_a) {
              v_mid.set(
                dax + v_dir.x * half_stub,
                day + v_dir.y * half_stub,
                daz + v_dir.z * half_stub,
              )
              matrix.compose(v_mid, q_rot, v_scale)
              bond_hitbox_mesh.setMatrixAt(dec_inst_idx, matrix)
              bond_hitbox_mesh.setMatrixAt(dec_inst_idx + 1, matrix.identity())
              inst_to_filtered[dec_inst_idx] = fidx
            } else {
              bond_hitbox_mesh.setMatrixAt(dec_inst_idx, matrix.identity())
              v_mid.set(
                dbx - v_dir.x * half_stub,
                dby - v_dir.y * half_stub,
                dbz - v_dir.z * half_stub,
              )
              matrix.compose(v_mid, q_rot, v_scale)
              bond_hitbox_mesh.setMatrixAt(dec_inst_idx + 1, matrix)
              inst_to_filtered[dec_inst_idx + 1] = fidx
            }
          }
          dec_inst_idx += 2
        }
      }
    }

    void scale_matrix
    bond_hitbox_mesh.count = total_inst
    bond_hitbox_mesh.instanceMatrix.needsUpdate = true
    bond_hitbox_instance_to_filtered_idx = inst_to_filtered
    // mark_dirty: imperative mesh.count + setMatrixAt + instanceMatrix.needsUpdate writes bypass <T.> prop chain
    mark_dirty()
  })

  // Clear hovered bond when external dragging starts to prevent stale highlights
  $effect(() => {
    if (external_dragging) hovered_bond_key = null
  })

  // Bond hitbox interaction handlers using instanceId.
  // Each logical bond emits 2 hitbox instances (paired stubs / two halves);
  // decode `instanceId >>> 1` to the bond index. Hovering / clicking either
  // half resolves to the same bond.
  function handle_bond_hitbox_click(event: any) {
    if (bond_drag_active || external_dragging) return
    const instance_id = event.instanceId
    if (instance_id === undefined) return
    // Phase 7f — per-instance map handles both cell-internal (`>>> 1`-style)
    // and decorator hits. -1 entries (orphan decorator slots) are no-ops.
    const map = bond_hitbox_instance_to_filtered_idx
    const bond_idx = instance_id < map.length
      ? map[instance_id]
      : (instance_id >>> 1)
    if (bond_idx < 0 || bond_idx >= filtered_bond_pairs.length) return
    const bond = filtered_bond_pairs[bond_idx]
    if (!is_bond_pickable(bond)) return // Skip bonds hidden by cutting plane
    event.stopPropagation()
    const bond_key = get_bond_key(bond.site_idx_1, bond.site_idx_2)
    const bond_type = manual_bond_keys.has(bond_key) ? `manual` as const : `auto` as const
    const bond_info = {
      type: bond_type,
      site_idx_1: bond.site_idx_1,
      site_idx_2: bond.site_idx_2,
      key: bond_key,
    }
    if (bond_mode_active) {
      on_bond_select?.(bond_info)
    } else {
      const exists = selected_bonds.some(b => b.key === bond_key)
      selected_bonds = exists
        ? selected_bonds.filter(b => b.key !== bond_key)
        : [...selected_bonds, bond_info]
    }
    hovered_bond_key = null
  }

  function handle_bond_hitbox_pointer_enter(event: any) {
    // Suppress hover during orbit/zoom so brushing past bonds while
    // rotating doesn't flash highlight rings.
    if (bond_drag_active || external_dragging || camera_is_moving) return
    const instance_id = event.instanceId
    if (instance_id === undefined) return
    // Phase 7f — per-instance map handles both cell-internal and decorator hits.
    const map = bond_hitbox_instance_to_filtered_idx
    const bond_idx = instance_id < map.length
      ? map[instance_id]
      : (instance_id >>> 1)
    if (bond_idx < 0 || bond_idx >= filtered_bond_pairs.length) return
    const bond = filtered_bond_pairs[bond_idx]
    if (!is_bond_pickable(bond)) return // Skip bonds hidden by cutting plane
    hovered_bond_key = get_bond_key(bond.site_idx_1, bond.site_idx_2)
  }

  function handle_bond_hitbox_pointer_leave() {
    if (!bond_drag_active) hovered_bond_key = null
  }

  // Merged single-pass derivation: radius + position + unique atoms from atom_data.
  // Uses plain Map (not SvelteMap) since these are rebuilt from scratch each time.
  //
  // Plan v3 follow-up: subscribe to atom_manager.version so position_map
  // re-derives on per-frame trajectory writes. Without this, under Architecture
  // P (post-Phase-4), atom_data is silenced (re-derives only at topology load)
  // → position_map freezes at frame-0 positions → selection highlights drift
  // off the rendered atoms (visually: highlight wireframe sticks to frame-0
  // while the atom moves with the trajectory). Same fix shape as the I5
  // charge-label position fix at compute_charge_label_entries.
  //
  // Position priority chain (mirrors charge label & build_trajectory_bond_pairs):
  //   1. realtime_position_overrides.get(site_idx)   — drag wins
  //   2. trajectory_frame_positions[site_idx*3..]    — live trajectory
  //   3. atom_manager slot lookup                    — supercell-extra
  //   4. atom.position from atom_data                — load-time fallback
  let atom_derived_maps = $derived.by(() => {
    // WebGPU overlay active: scene not painting → these maps (selection
    // highlight / label positions) aren't rendered. Skip the per-frame rebuild
    // (this derived reads trajectory_frame_positions directly, which the parent
    // still bumps each frame). Read suspend reactively so toggle-OFF re-derives
    // the full maps for the current frame. Default false ⇒ unchanged.
    if (webgl_suspended) return { radius_map: new Map<number, number>(), position_map: new Map<number, Vec3>(), unique: [] as typeof atom_data }
    // R8.7 PROBE — load-cascade timing.
    const __t0 = (import.meta.env?.DEV) ? performance.now() : 0
    void atom_manager.version // subscribe to per-slot position writes
    const traj = trajectory_frame_positions
    const traj_max_site = traj ? Math.floor(traj.length / 3) : 0
    const radius_map = new Map<number, number>()
    const position_map = new Map<number, Vec3>()
    const unique: typeof atom_data = []

    for (const atom of atom_data) {
      if (!radius_map.has(atom.site_idx)) {
        radius_map.set(atom.site_idx, atom.radius)
        const sid = atom.site_idx
        let pos = realtime_position_overrides?.get(sid)
        if (pos === undefined && traj && sid < traj_max_site) {
          const base = sid * 3
          pos = [traj[base], traj[base + 1], traj[base + 2]]
        }
        if (pos === undefined) {
          const slot = atom_manager.find_slot_by_site_id(sid)
          if (slot >= 0) {
            pos = [
              atom_manager.get_x(slot),
              atom_manager.get_y(slot),
              atom_manager.get_z(slot),
            ]
          }
        }
        position_map.set(sid, pos ?? atom.position)
        if (!atom.has_partial_occupancy) unique.push(atom)
      }
    }

    if (import.meta.env?.DEV) {
      const __dt = performance.now() - __t0
      if (__dt > 5) console.log(`[probe] atom_derived_maps: ${__dt.toFixed(1)}ms (${atom_data.length} atoms)`)
    }
    return { radius_map, position_map, unique }
  })

  let radius_by_site_idx = $derived(atom_derived_maps.radius_map)
  let position_by_site_idx = $derived(atom_derived_maps.position_map)

  // Radius for ALL sites (including hidden elements) - used for frozen atoms overlay
  let all_radii_by_site_idx = $derived.by(() => {
    const map = new Map<number, number>()
    if (!structure?.sites) return map
    // Force reactivity on override sources (cheaper than JSON.stringify)
    const _ero_keys = Object.keys(element_radius_overrides ?? {})
    const site_overrides_size = site_radius_overrides?.size ?? 0
    for (let site_idx = 0; site_idx < structure.sites.length; site_idx++) {
      const site = structure.sites[site_idx]
      // Site-level override takes priority over element-level override
      const site_override = site_radius_overrides?.get(site_idx)
      const radius = site_override !== undefined
        ? site_override * atom_radius
        : same_size_atoms
          ? atom_radius
          : site.species.reduce(
              (sum, spec) => sum + spec.occu * (element_radius_overrides?.[spec.element] ?? atomic_radii[spec.element] ?? 1),
              0,
            ) * atom_radius
      map.set(site_idx, radius)
    }
    return map
  })

  let force_data = $derived.by(() => {
    // WebGPU overlay active: scene not painting + overlay renders no force
    // vectors → skip the per-frame compute_force_data rebuild. Read suspend
    // reactively so toggle-OFF re-derives for the current frame.
    if (webgl_suspended) return []
    if (!show_force_vectors || !structure?.sites) return []
    // Override forces from trajectory Float32Array (positions are already
    // correct in structure.sites since the unified single-path always updates structure)
    const traj_forces = trajectory_frame_forces
    if (traj_forces) {
      const override_sites = structure.sites.map((site, i) => ({
        ...site,
        properties: {
          ...site.properties,
          force: [traj_forces[i * 3], traj_forces[i * 3 + 1], traj_forces[i * 3 + 2]] as Vec3,
        },
      }))
      return compute_force_data(
        override_sites, force_scale, force_color, force_color_mode,
        force_display_mode, colors.element, force_range_min, force_range_max,
      )
    }
    return compute_force_data(
      structure.sites, force_scale, force_color, force_color_mode,
      force_display_mode, colors.element, force_range_min, force_range_max,
    )
  })

  let magmom_data = $derived.by(() => {
    if (webgl_suspended) return []
    if (!show_magmom_vectors || !structure?.sites) return []
    // Magnetic moments come from the per-site `magmom` property (scalar collinear
    // or 3-vector non-collinear) — see compute_magmom_data.
    return compute_magmom_data(
      structure.sites, magmom_scale, magmom_up_color, magmom_down_color,
    )
  })

  // Build a set for fast selected_sites lookup
  let selected_sites_set = $derived.by(() => new Set(selected_sites))

  // Unique instanced atoms: one entry per site_idx (full-occupancy only), for site labels.
  const SITE_LABEL_LIMIT = 2000
  let unique_instanced_atoms = $derived(atom_derived_maps.unique)
  let site_labels_capped = $derived(unique_instanced_atoms.length > SITE_LABEL_LIMIT)
  let site_label_atoms = $derived(
    site_labels_capped ? unique_instanced_atoms.slice(0, SITE_LABEL_LIMIT) : unique_instanced_atoms
  )

  // ═══ Batched Site Label Projection ═══
  // Instead of creating one extras.HTML per atom (which creates N Three.js Groups,
  // N DOM portals, N per-frame render tasks, and ~28N reactive primitives),
  // we use a single overlay div with manual batch projection.
  let site_label_overlay_ref = $state<HTMLDivElement | null>(null)

  // Portal the overlay to the Threlte DOM container (same target as extras.HTML)
  function site_label_portal(el: HTMLDivElement) {
    const target = threlte.dom
    if (!target) return
    target.append(el)
    return { destroy: () => el.remove() }
  }

  // Trigger a frame when label visibility changes, so the site-label
  // useTask can project the overlay DOM positions on its next run.
  $effect(() => {
    if (show_site_labels || show_site_indices) {
      // The first invalidate this $effect used to fire was redundant —
      // toggling show_site_labels flows through the {#if} block below
      // which already triggers a paint via the <T.> prop chain. We need
      // ONE rAF-deferred invalidate so the projection useTask runs after
      // Svelte has had a chance to mount the overlay <div>.
      requestAnimationFrame(() => mark_dirty())
    }
  })

  // Reusable temporaries for projection (avoid GC pressure)
  const _proj_v3 = new Vector3()
  const _proj_quat = new Quaternion()
  const _proj_euler = new Euler()

  // Per-frame batch projection of all site label positions to 2D screen coordinates.
  // Replaces N individual extras.HTML render tasks with one O(N) loop.
  function project_labels_to_overlay(
    overlay: HTMLDivElement,
    atoms: typeof site_label_atoms,
    use_data_pos = false,
  ) {
    const cam = threlte.camera.current
    const canvas = threlte.renderer?.domElement
    if (!cam || !canvas) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return

    cam.updateMatrixWorld()
    const rt = rotation_target ?? [0, 0, 0] as Vec3
    _proj_euler.set(rotation[0], rotation[1], rotation[2])
    _proj_quat.setFromEuler(_proj_euler)
    const offset = site_label_offset ?? [0, 0, 0]
    const overrides = realtime_position_overrides

    const children = overlay.children
    const n = use_data_pos ? children.length : Math.min(children.length, atoms.length)
    for (let i = 0; i < n; i++) {
      const el = children[i] as HTMLElement
      let px: number, py: number, pz: number
      if (use_data_pos) {
        const raw = el.dataset.pos
        if (!raw) continue
        const parts = raw.split(`,`)
        px = +parts[0]; py = +parts[1]; pz = +parts[2]
      } else {
        const atom = atoms[i]
        const pos = overrides?.get(atom.site_idx) ?? atom.position
        px = pos[0]; py = pos[1]; pz = pos[2]
      }

      // Apply parent group transforms: translate to origin → rotate → translate back
      _proj_v3.set(px + offset[0] - rt[0], py + offset[1] - rt[1], pz + offset[2] - rt[2])
      _proj_v3.applyQuaternion(_proj_quat)
      _proj_v3.x += rt[0]
      _proj_v3.y += rt[1]
      _proj_v3.z += rt[2]

      // Project to NDC then to screen pixels
      _proj_v3.project(cam)
      const sx = (0.5 + _proj_v3.x * 0.5) * w
      const sy = (0.5 - _proj_v3.y * 0.5) * h
      const behind = _proj_v3.z > 1

      if (behind) {
        el.style.display = `none`
      } else {
        el.style.display = `block`
        el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`
      }
    }
  }

  useTask(() => {
    if (!show_site_labels && !show_site_indices) return
    if (!show_bulk_atoms) return
    if (site_label_overlay_ref) {
      project_labels_to_overlay(site_label_overlay_ref, site_label_atoms)
    }
    if (partial_label_overlay_ref && partial_label_overlay_ref.children.length > 0) {
      project_labels_to_overlay(partial_label_overlay_ref, site_label_atoms, true)
    }
  }, { autoInvalidate: false })

  // Update camera position for polyhedra depth-gradient opacity
  const _cam_pos_v3 = new Vector3()
  // R3.2: equality guard — $state write triggers prop-chain invalidate; skip when nothing changed.
  let __prev_polyhedra_cam_x = NaN
  let __prev_polyhedra_cam_y = NaN
  let __prev_polyhedra_cam_z = NaN
  let __prev_polyhedra_depth_min = NaN
  let __prev_polyhedra_depth_max = NaN
  const __POLYHEDRA_EPS = 1e-4
  useTask(() => {
    if (!show_polyhedra || polyhedra_geometry.face_count === 0) return
    const cam = threlte.camera.current
    if (!cam) return
    cam.getWorldPosition(_cam_pos_v3)
    const cx = _cam_pos_v3.x
    const cy = _cam_pos_v3.y
    const cz = _cam_pos_v3.z
    if (
      Math.abs(cx - __prev_polyhedra_cam_x) > __POLYHEDRA_EPS ||
      Math.abs(cy - __prev_polyhedra_cam_y) > __POLYHEDRA_EPS ||
      Math.abs(cz - __prev_polyhedra_cam_z) > __POLYHEDRA_EPS ||
      Number.isNaN(__prev_polyhedra_cam_x)
    ) {
      _polyhedra_camera_pos = [cx, cy, cz]
      __prev_polyhedra_cam_x = cx
      __prev_polyhedra_cam_y = cy
      __prev_polyhedra_cam_z = cz
    }
    // Compute depth range from face positions
    const positions = polyhedra_geometry.face_positions
    let min_d = Infinity, max_d = 0
    for (let i = 0; i < positions.length; i += 3) {
      const dx = positions[i] - cx
      const dy = positions[i + 1] - cy
      const dz = positions[i + 2] - cz
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d < min_d) min_d = d
      if (d > max_d) max_d = d
    }
    if (min_d < Infinity) {
      if (
        Math.abs(min_d - __prev_polyhedra_depth_min) > __POLYHEDRA_EPS ||
        Math.abs(max_d - __prev_polyhedra_depth_max) > __POLYHEDRA_EPS ||
        Number.isNaN(__prev_polyhedra_depth_min)
      ) {
        _polyhedra_depth_range = [min_d, max_d]
        __prev_polyhedra_depth_min = min_d
        __prev_polyhedra_depth_max = max_d
      }
    }
  }, { autoInvalidate: false })

  let partial_label_overlay_ref = $state<HTMLDivElement | null>(null)

  let gizmo_props = $derived.by(() => {
    const axis_options = Object.fromEntries(
      [...axis_colors, ...neg_axis_colors].map(([axis, color, hover_color]) => [
        axis,
        {
          color,
          labelColor: `#111`,
          opacity: axis.startsWith(`n`) ? 0.9 : 0.8,
          hover: {
            color: hover_color,
            labelColor: `#222222`,
            opacity: axis.startsWith(`n`) ? 1 : 0.9,
          },
        },
      ]),
    )
    return {
      background: { enabled: false },
      className: `responsive-gizmo`,
      ...axis_options,
      ...(typeof gizmo === `boolean` ? {} : gizmo),
      offset: { left: 5, bottom: 5 },
      onend: handle_gizmo_end,
    }
  })

  // Orthographic pan-speed normalization (applied per-drag in `onstart` below).
  // TrackballControls._panCamera scales on-screen pan by `_eye.length()` (the
  // camera→target distance). With ortho, the 1/zoom term cancels against the
  // projection's ×zoom, but eye.length has NO such cancellation — so the same drag
  // pans little when the camera sits close (small molecule) and a lot when it sits
  // far (large cell). We can't use structure_size as a proxy: compute_structure_size
  // returns a flat 10 for non-periodic systems (no lattice), so it doesn't track the
  // real distance. Instead we read the true eye length at drag start and set panSpeed
  // = pan_speed × PAN_REF_EYE / eye, which makes on-screen pan ∝ pan_speed for every
  // structure. PAN_REF_EYE is the eye length at which the user's pan_speed is left
  // unchanged. Perspective pan already tracks the cursor 1:1, so it's left alone.
  const PAN_REF_EYE = 50
  let trackball_controls_props = $derived.by(() => ({
    rotateSpeed: rotate_speed,
    zoomSpeed: camera_projection === `orthographic` ? zoom_speed * 2 : zoom_speed,
    panSpeed: pan_speed,
    // Disable camera rotation when:
    // - rotate_speed is 0 (disabled by user)
    // - axis_lock_active (X/Y/Z key pressed for axis-locked rotation)
    // - external_dragging (atom dragging in progress)
    // - is_box_selecting (box selection in progress)
    // - is_rotating_atoms (atom rotation via Shift+drag in progress)
    noRotate: rotate_speed === 0 || axis_lock_active ||
      external_dragging || is_box_selecting || is_rotating_atoms,
    noZoom: zoom_speed === 0 || axis_lock_active || external_dragging,
    // Disable pan when atom operations are in progress
    noPan: pan_speed === 0 || axis_lock_active || external_dragging ||
      is_box_selecting || is_rotating_atoms,
    staticMoving: !Boolean(rotation_damping), // Opposite of damping
    dynamicDampingFactor: rotation_damping || 0.2,
    minDistance: min_zoom,
    maxDistance: max_zoom,
    // NOTE: We intentionally do NOT include 'target' here!
    // Including target in props causes it to be re-applied whenever props change,
    // which resets the camera to an old position after user pans.
    // The target is managed programmatically in the $effect blocks above.
    onstart: () => {
      camera_is_moving = true
      // Normalize ortho pan to the true camera→target distance so a drag pans the
      // same on-screen amount regardless of structure size (see PAN_REF_EYE note).
      if (camera && orbit_controls?.target && camera_projection === `orthographic`) {
        const eye = (camera as any).position.distanceTo(orbit_controls.target)
        ;(orbit_controls as any).panSpeed = pan_speed * PAN_REF_EYE / Math.max(0.001, eye)
      }
      capture_trackball_view_state()
      if (!trackball_is_rotating()) clear_trackball_rotation_inertia()
      // Don't clear hovered_idx here - let it stay so rotation stays disabled on atoms.
      // Don't clear hovered_bond_key either: TrackballControls fires onstart on
      // mousedown even if no movement follows, so clearing here would erase
      // the click-time hover ring before the click handler runs and the user
      // would see no feedback. The pointer_enter `camera_is_moving` gate
      // already prevents NEW hovers from kicking in during actual orbit.
    },
    onend: () => {
      camera_is_moving = false
      sync_current_camera_target_from_controls()
      snapshot_view()
      // Sync reset reference points with current state after every camera operation
      // This prevents Ctrl+click or any other operation from snapping back to an old position
      // TrackballControls uses _target0, _eye0, and _up0 as reset reference points
      sync_trackball_reset_refs()
      capture_trackball_view_state()
    },
    onchange: () => {
      handle_trackball_change()
    },
  }))

  // Configure mouse buttons for TrackballControls
  // LEFT: rotate (blocked on atoms by Structure.svelte stopPropagation)
  // MIDDLE: pan
  // RIGHT: disabled (context menu/right-drag roll handled separately)
  $effect(() => {
    if (orbit_controls) {
      orbit_controls.mouseButtons = {
        LEFT: 0,
        MIDDLE: 2,
        RIGHT: -1 as any,
      }
      // Disable keyboard controls to prevent Ctrl+click from panning/resetting
      // TrackballControls by default has keys for A=rotate, S=zoom, D=pan
      // We disable these to prevent unexpected behavior with modifier keys
      if ((orbit_controls as any).keys) {
        (orbit_controls as any).keys = { KeyA: -1, KeyS: -1, KeyD: -1 }
      }
      // Also disable internal key handlers by overriding them with no-ops
      if (typeof (orbit_controls as any).handleKeyDown === 'function') {
        (orbit_controls as any).handleKeyDown = () => {}
      }
      if (typeof (orbit_controls as any).keydown === 'function') {
        (orbit_controls as any).keydown = () => {}
      }
      if (typeof (orbit_controls as any).keyup === 'function') {
        (orbit_controls as any).keyup = () => {}
      }
      // Override reset() method to prevent any reset behavior
      // TrackballControls reset() snaps to _target0/_eye0/_up0
      if (typeof (orbit_controls as any).reset === 'function') {
        (orbit_controls as any).reset = () => {}
      }

      // Note: staticMoving and dynamicDampingFactor are configured via
      // trackball_controls_props based on the rotation_damping setting.
    }
  })

  // Disable TrackballControls when Ctrl key is held
  // This prevents Ctrl+click from triggering any camera behavior
  // Box selection (Ctrl+drag) is handled by Structure.svelte and doesn't need TrackballControls
  $effect(() => {
    if (!orbit_controls) return

    const handle_keydown = (event: KeyboardEvent) => {
      if (event.key === 'Control' && orbit_controls) {
        orbit_controls.enabled = false
      }
    }

    const handle_keyup = (event: KeyboardEvent) => {
      if (event.key === 'Control' && orbit_controls) {
        orbit_controls.enabled = true
      }
    }

    // Re-enable controls when window loses focus — keyup events are lost when
    // focus moves to a dialog, another window, or the browser's address bar.
    // Without this, Ctrl+click followed by a focus change permanently disables rotation.
    const handle_focus_recovery = () => {
      if (orbit_controls) orbit_controls.enabled = true
    }

    window.addEventListener('keydown', handle_keydown)
    window.addEventListener('keyup', handle_keyup)
    window.addEventListener('blur', handle_focus_recovery)
    document.addEventListener('visibilitychange', handle_focus_recovery)

    return () => {
      window.removeEventListener('keydown', handle_keydown)
      window.removeEventListener('keyup', handle_keyup)
      window.removeEventListener('blur', handle_focus_recovery)
      document.removeEventListener('visibilitychange', handle_focus_recovery)
    }
  })

  // Kill TrackballControls rotation inertia during scroll wheel zoom.
  // TrackballControls (unlike OrbitControls) couples rotation and zoom through
  // a shared update() loop: _rotateCamera() applies _lastAngle inertia on every
  // frame, even during zoom. Clear it on wheel events so scroll only produces zoom.
  // Also implements zoom-to-cursor (TrackballControls doesn't support it natively).
  $effect(() => {
    if (!orbit_controls) return
    const canvas = threlte.renderer?.domElement
    if (!canvas) return

    const handle_wheel = () => {
      const ctrl = orbit_controls as any
      ctrl._lastAngle = 0
      if (ctrl._lastAxis) ctrl._lastAxis.set(0, 0, 0)
    }

    canvas.addEventListener('wheel', handle_wheel, { passive: true })
    return () => canvas.removeEventListener('wheel', handle_wheel)
  })

  // Auto-rotation effect - continuously rotate camera around structure
  $effect(() => {
    if (!auto_rotate || auto_rotate <= 0) return
    if (!orbit_controls || !camera) return

    let frame_id = 0
    let last_time = performance.now()

    const animate = () => {
      const now = performance.now()
      const delta = (now - last_time) / 1000 // Convert to seconds
      last_time = now

      // Rotate camera around the Y axis at the locked structure pivot.
      // auto_rotate is the speed (radians per second)
      const angle = auto_rotate * delta
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle)
      apply_camera_rotation_about_locked_pivot(q)

      frame_id = requestAnimationFrame(animate)
    }

    frame_id = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame_id)
  })

  let measure_line_color = $derived.by(() => {
    if (typeof window === `undefined`) return
    const root_styles = getComputedStyle(document.documentElement)
    const text_color = root_styles.getPropertyValue(`--text-color`).trim()
    return text_color || `#808080`
  })

  // ─── W1 cascade detector — globalThis.__catgo_probe surface ─────────────
  // Exposes snapshot()/reset() for trajectory cascade regression testing.
  // Also exposes test-only getters (get_atom_x, bond_pairs_count, etc.) used
  // by the W7 Playwright suite at /tests/playwright/structure-trajectory.test.ts.
  // DEV-only; tree-shaken from production via import.meta.env?.DEV gating.
  // Counters are read at call time (not at $effect mount time) so plain-`let`
  // values are captured by reference. See plans/W1-cascade-detector-design.md.
  $effect(() => {
    if (!import.meta.env?.DEV) return
    if (typeof globalThis === `undefined`) return
    const probe = {
      snapshot: () => ({
        atom_data_fires: __probe_atom_data_fires,
        atom_data_meaningful: __probe_atom_data_meaningful,
        atom_data_fast_path_fires: __atom_data_fast_count,
        bbp_fires: __probe_bbp_fires,
        bbp_meaningful: __probe_bbp_meaningful,
        x2_fires: __probe_x2_fires,
        x2_traj_fast_path_fires: __probe_x2_traj_fast_path_fires,
        x2_slow_meaningful: __probe_x2_slow_meaningful,
        apb_fires: __probe_apb_fires,
        apb_meaningful: __probe_apb_meaningful,
        acb_fires: __probe_acb_fires,
        acb_meaningful: __probe_acb_meaningful,
        nhsi_fires: __probe_nhsi_fires,
        nhsi_meaningful: __probe_nhsi_meaningful,
      }),
      // ─── W7 test-only getters ──────────────────────────────────────────
      // Read GPU-side state directly for assertion in Playwright tests.
      // Position is read from atom_manager.positions_buffer (the live SOA
      // buffer that trajectory writes flow through), site_id is mapped via
      // site_ids_buffer.
      get_atom_x: (site_id: number): number | null => {
        const mgr = atom_manager
        for (let slot = 0; slot < mgr.count; slot++) {
          if (mgr.site_ids_buffer[slot] === site_id) return mgr.get_x(slot)
        }
        return null
      },
      get_atom_xyz: (site_id: number): [number, number, number] | null => {
        const mgr = atom_manager
        for (let slot = 0; slot < mgr.count; slot++) {
          if (mgr.site_ids_buffer[slot] === site_id) {
            return [mgr.get_x(slot), mgr.get_y(slot), mgr.get_z(slot)]
          }
        }
        return null
      },
      get atom_count(): number { return atom_manager.count },
      get atom_manager_capacity(): number { return atom_manager.capacity },
      get bond_pairs_count(): number { return bond_pairs.length },
      get filtered_bond_pairs_count(): number { return filtered_bond_pairs.length },
      get charge_label_entries_count(): number { return charge_label_entries.length },
      get h_bond_pairs_count(): number { return h_bond_pairs.length },
      // Camera matrices + canvas dims for pixel-projection helpers in
      // Playwright. Tests 2.1, 2.5, 7.4 need to compute "click here"
      // coordinates from atom xyz: ndc = projection · view · world,
      // then [px, py] = (ndc.xy * 0.5 + 0.5) * [width, height].
      // Matrix4.elements is column-major (Three.js convention) — the
      // helper must transpose or apply column-by-column accordingly.
      get_camera_matrices: () => {
        const cam = camera as { projectionMatrix?: { elements: ArrayLike<number> }; matrixWorldInverse?: { elements: ArrayLike<number> } } | undefined
        const canvas = (threlte?.renderer as { domElement?: HTMLCanvasElement } | undefined)?.domElement
        if (!cam?.projectionMatrix || !cam?.matrixWorldInverse || !canvas) return null
        return {
          projection: Array.from(cam.projectionMatrix.elements),
          view: Array.from(cam.matrixWorldInverse.elements),
          width: canvas.clientWidth,
          height: canvas.clientHeight,
        }
      },
      get_rotation_pivot: (): Vec3 => copy_vec3(locked_rotation_pivot),
      get_orbit_target: (): Vec3 | null => {
        const target = orbit_controls?.target as Vector3 | undefined
        return target ? vector_to_vec3(target) : null
      },
      get override_size(): number { return realtime_position_overrides?.size ?? 0 },
      get vibration_active(): boolean { return vibration_data?.playing === true },
      get is_playing(): boolean {
        return (globalThis as { __catgo_traj_is_playing?: boolean })
          .__catgo_traj_is_playing === true
      },
      // W8 gate verification: counts how many times the align_on_load
      // $effect reached the alignment step (past all early-returns including
      // the trajectory_active gate at Structure.svelte:1216). Test 6.6
      // asserts this counter does NOT advance during trajectory playback.
      get align_on_load_fires(): number {
        return (globalThis as { __catgo_align_on_load_fires?: number })
          .__catgo_align_on_load_fires ?? 0
      },
      // Read xyz[0] from the live `structure` prop's site at site_idx — distinct
      // from get_atom_x (atom_manager / GPU). Used by Test 4.4 to verify W2 T5
      // writeback (structure = { ...structure, sites: ... }) propagated through
      // the $bindable chain back into the reactive structure tree.
      get_structure_site_x: (site_idx: number): number | null => {
        const site = structure?.sites?.[site_idx]
        const x = site?.xyz?.[0]
        return typeof x === `number` ? x : null
      },
      // W7 Tests 2.1 and 2.5 (click-to-select / right-click correct atom at
      // paused frame): exposes the most-recently-selected site_idx so the
      // test can assert that a synthesized click at projected pixel
      // coordinates landed on the expected atom. Returns the LAST element
      // of `selected_sites` (the selection model toggles via push/filter),
      // or null if empty. site_idx == site_id for the H2O fixture
      // (atom_manager site_ids map 1:1 to structure.sites indices).
      get selected_site_id(): number | null {
        const sel = selected_sites
        return sel && sel.length > 0 ? sel[sel.length - 1] : null
      },
      reset: () => {
        __probe_atom_data_fires = 0
        __probe_atom_data_meaningful = 0
        __atom_data_fast_count = 0
        __probe_bbp_fires = 0
        __probe_bbp_meaningful = 0
        __probe_x2_fires = 0
        __probe_x2_traj_fast_path_fires = 0
        __probe_x2_slow_meaningful = 0
        __probe_apb_fires = 0
        __probe_apb_meaningful = 0
        __probe_acb_fires = 0
        __probe_acb_meaningful = 0
        __probe_nhsi_fires = 0
        __probe_nhsi_meaningful = 0
        ;(globalThis as { __catgo_align_on_load_fires?: number })
          .__catgo_align_on_load_fires = 0
      },
    }
    ;(globalThis as unknown as { __catgo_probe?: typeof probe }).__catgo_probe = probe
    return () => {
      delete (globalThis as { __catgo_probe?: unknown }).__catgo_probe
    }
  })
</script>


{#snippet site_label_content(site: Site, site_idx: number)}
  {@const is_image = num_original_sites !== undefined && site_idx >= num_original_sites}
  {@const display_idx = is_image && image_to_original_map
    ? image_to_original_map[site_idx - num_original_sites!] + 1
    : site_idx + 1}
  {#if atom_label}
    {@render atom_label(site, site_idx)}
  {:else}
    {#if show_site_labels && show_site_indices}
      {#if site.species.length === 1}
        {site.species[0].element}-{display_idx}
      {:else}
        {@html       site.species.map((spec) =>
    `${spec.element}<sub>${
      format_num(spec.occu, `.3~`).replace(`0.`, `.`)
    }</sub>`
  ).join(``)}-{
          display_idx
        }
      {/if}
    {:else if show_site_labels}
      {#if site.species.length === 1}
        {site.species[0].element}
      {:else}
        {@html       site.species.map((spec) =>
    `${spec.element}<sub>${
      format_num(spec.occu, `.3~`).replace(`0.`, `.`)
    }</sub>`
  ).join(``)}
      {/if}
    {:else if show_site_indices}
      {display_idx}
    {/if}
  {/if}
{/snippet}

{#if camera_projection === `perspective`}
  <T.PerspectiveCamera
    makeDefault
    position={camera_position}
    up={[0, 0, 1]}
    {fov}
    near={camera_near}
    far={camera_far}
  >
    <extras.TrackballControls bind:ref={orbit_controls} {...trackball_controls_props}>
      {#if gizmo}<extras.Gizmo {...gizmo_props} />{/if}
    </extras.TrackballControls>
  </T.PerspectiveCamera>
{:else}
  <T.OrthographicCamera
    makeDefault
    position={camera_position}
    up={[0, 0, 1]}
    zoom={computed_zoom}
    near={-100}
    far={camera_far}
  >
    <extras.TrackballControls bind:ref={orbit_controls} {...trackball_controls_props}>
      {#if gizmo}<extras.Gizmo {...gizmo_props} />{/if}
    </extras.TrackballControls>
  </T.OrthographicCamera>
{/if}

<SceneLighting directional={active_directional_light} ambient={active_ambient_light} />

<!-- Invisible background mesh to catch clicks on empty space -->
<T.Mesh
  position={[0, 0, -1000]}
  onclick={() => {
    // WebGPU overlay active: overlay owns selection; ignore empty-space WebGL clicks.
    if (webgl_suspended) return
    // Bond mode: clicking empty space clears bond selection (skip during drag)
    if (bond_mode_active && on_bond_select && !bond_drag_active) {
      on_bond_select(null)
    }
  }}
  ondblclick={(event: MouseEvent) => {
    // WebGPU overlay active: overlay owns selection; do not clear from WebGL.
    if (webgl_suspended) return
    // Only double-click clears selection - single click and drag do not
    // Clear selection when double-clicking empty space
    selected_sites = []
    selected_bonds = []
    selection_opacity = 1
    // Clear selected measurement when double-clicking empty space
    if (selected_measurement_id) {
      selected_measurement_id = null
    }
  }}
>
  <T.PlaneGeometry args={[10000, 10000]} />
  <T.MeshBasicMaterial visible={false} />
</T.Mesh>

<!-- Apply manual rotation around center: translate to origin, rotate, translate back -->
<T.Group position={rotation_target}>
  <T.Group {rotation}>
    <T.Group position={math.scale(rotation_target, -1)}>
      {#if show_bulk_atoms}
        {#if USE_NEW_ATOM_SYSTEM}
          <!-- Phase X6b renderer. Mirrors AtomImpostors for cutting / drag /
               image-atom opacity / per-atom overrides. Remaining regressions
               (partial-occupancy wedges; selection highlight overlays) are
               documented in AtomManagerInstances.svelte's header comment. -->
          <AtomManagerInstances
            {atom_manager}
            hidden_site_ids={new_atom_hidden_site_ids}
            {realtime_position_overrides}
            {cutting_active}
            {cutting_visibility_map}
            atom_opacity_overrides={merged_atom_opacity_overrides}
            {num_original_sites}
            {image_atom_opacity}
            {image_to_original_map}
            {depth_cue_uniforms}
            ambient_light={active_ambient_light}
            directional_light={active_directional_light}
            {render_style}
            {matcap_preset}
            {light_dir}
            highlight_strength={active_highlight_strength}
          />
        {:else}
          <!-- Impostor-based atom rendering: billboard quads with ray-sphere fragment shader -->
          <AtomImpostors
            {atom_data}
            {realtime_position_overrides}
            {cutting_active}
            {cutting_visibility_map}
            atom_opacity_overrides={merged_atom_opacity_overrides}
            {num_original_sites}
            {image_atom_opacity}
            {image_to_original_map}
            {depth_cue_uniforms}
            ambient_light={active_ambient_light}
            directional_light={active_directional_light}
            {render_style}
            {light_dir}
            highlight_strength={active_highlight_strength}
          />
        {/if}

        {#if show_polyhedra && polyhedra_geometry.face_count > 0}
          <CoordinationPolyhedra
            geometry={polyhedra_geometry}
            render_style={polyhedra_style}
            opacity_mode={polyhedra_opacity_mode}
            opacity={polyhedra_opacity}
            opacity_near={polyhedra_opacity_near}
            opacity_far={polyhedra_opacity_far}
            edge_color={polyhedra_edge_color}
            edge_opacity={polyhedra_edge_opacity}
            edge_width={polyhedra_edge_width}
            show_edges={polyhedra_show_edges}
            camera_position={_polyhedra_camera_pos}
            depth_range={_polyhedra_depth_range}
          />
        {/if}

        <!-- Invisible atom interaction mesh: Threlte event system handles click/selection -->
        <!-- Uses actual SphereGeometry(0.5) for raycasting, matching old extras.Instance behavior -->
        {#if atom_data.length > 0 && show_bulk_atoms}
          <T.InstancedMesh
            args={[atom_interaction_geometry, atom_interaction_material, INITIAL_MESH_CAPACITY]}
            bind:ref={atom_interaction_mesh}
            frustumCulled={false}
            onclick={handle_atom_interaction_click}
            onpointerdown={handle_atom_interaction_pointerdown}
            onpointerup={handle_atom_interaction_pointerup}
            oncontextmenu={handle_atom_interaction_contextmenu}
          />
        {/if}

        <!-- Per-atom material snippet — honors render_style (glossy | matte | toon).
             Glossy is byte-identical to legacy (MeshStandardMaterial, roughness/
             metalness UNSET = Three defaults, depth-cue/outline via oncreate patch).
             Matte adds roughness 1 / metalness 0 / envMapIntensity 0 on the same
             material+patch. Toon swaps to the self-lit cel ShaderMaterial which
             folds depth-cue + outline internally via the shared depth_cue_uniforms. -->
        {#snippet atom_material(color: string, double_sided: boolean, is_cut: boolean, cut_op: number)}
          {#if render_style === `toon`}
            <T is={make_toon_material(color, is_cut ? cut_op : 1, is_cut, double_sided)} />
          {:else if render_style === `matte` || render_style === `soft` || render_style === `flat`}
            {#if is_cut}
              <T.MeshStandardMaterial
                color={color}
                roughness={1}
                metalness={0}
                envMapIntensity={0}
                side={2}
                transparent
                opacity={cut_op}
                depthWrite={double_sided ? undefined : false}
                oncreate={apply_depth_cueing_to_material}
              />
            {:else}
              <T.MeshStandardMaterial
                color={color}
                roughness={1}
                metalness={0}
                envMapIntensity={0}
                side={double_sided ? 2 : 0}
                oncreate={apply_depth_cueing_to_material}
              />
            {/if}
          {:else}
            {#if is_cut}
              <T.MeshStandardMaterial
                color={color}
                side={2}
                transparent
                opacity={cut_op}
                depthWrite={double_sided ? undefined : false}
                oncreate={apply_depth_cueing_to_material}
              />
            {:else}
              <T.MeshStandardMaterial
                color={color}
                side={double_sided ? 2 : 0}
                oncreate={apply_depth_cueing_to_material}
              />
            {/if}
          {/if}
        {/snippet}

        <!-- Regular rendering for partial occupancy atoms (wedge geometry, typically <10 atoms) -->
        {#each atom_data.filter((atom) => atom.has_partial_occupancy) as
          atom
          (atom.site_idx + atom.element + atom.occupancy)
        }
          {@const cutting_vis = cutting_active ? cutting_visibility_map.get(atom.site_idx) : undefined}
          {@const is_outside = cutting_vis ? !cutting_vis.inside : false}
          {@const cut_opacity = cutting_vis?.opacity ?? 1}
          {@const cut_saturation = cutting_vis?.saturation ?? 1}
          {@const display_color = is_outside ? desaturate_color(atom.color, cut_saturation) : atom.color}
          {@const override_pos = realtime_position_overrides?.get(atom.site_idx)}
          <T.Group
            position={override_pos ?? atom.position}
            scale={atom.radius}
          >
            <T.Mesh>
              <T.SphereGeometry
                args={[
                  0.5,
                  sphere_segments,
                  sphere_segments,
                  atom.start_phi,
                  2 * Math.PI * atom.occupancy,
                ]}
              />
              {@render atom_material(display_color, false, is_outside && cut_opacity < 1, cut_opacity)}
            </T.Mesh>

            {#if atom.has_partial_occupancy}
              <T.Mesh rotation={[0, atom.start_phi, 0]}>
                <T.CircleGeometry args={[0.5, sphere_segments]} />
                {@render atom_material(display_color, true, is_outside && cut_opacity < 1, cut_opacity)}
              </T.Mesh>
              <T.Mesh rotation={[0, atom.end_phi, 0]}>
                <T.CircleGeometry args={[0.5, sphere_segments]} />
                {@render atom_material(display_color, true, is_outside && cut_opacity < 1, cut_opacity)}
              </T.Mesh>
            {/if}
          </T.Group>

        {/each}

        <!-- Site labels are rendered via a batched portal overlay below (not extras.HTML) -->
      {/if}

      {#if force_data.length > 0}
        {#each force_data as force (force.position.join(`,`) + force.vector.join(`,`))}
          <Arrow {...force} />
        {/each}
      {/if}

      {#if magmom_data.length > 0}
        {#each magmom_data as magmom (magmom.position.join(`,`) + magmom.vector.join(`,`))}
          <Arrow {...magmom} />
        {/each}
      {/if}

      <!-- Instanced bond rendering -->
      {#if show_bulk_atoms}
        <BondManagerInstances
          {bond_manager}
          atom_positions={atom_positions_buffer}
          atom_colors={atom_colors_buffer}
          bond_radius={bond_thickness}
          {bond_opacity_overrides}
          periodic_bond_opacity={image_atom_opacity}
          lattice_matrix={bond_lattice_matrix}
          {incomplete_periodic_edge_mode}
          {incomplete_edge_length_scale}
          {hide_incomplete_bonds}
          {image_atom_layout}
          {partner_drawn_lookup}
          multibond_enabled={bond_order_perception}
          {depth_cue_uniforms}
          {light_dir}
          highlight_strength={active_highlight_strength}
        />
      {/if}

      <!-- Aromatic ring overlay — one dashed circle inside each aromatic ring.
           Gated by the SAME bond_order_perception toggle: when OFF,
           `aromatic_rings` is the shared empty array → nothing drawn. -->
      {#if show_bulk_atoms && bond_order_perception && aromatic_rings.length > 0}
        <AromaticRingOverlay rings={aromatic_rings} />
      {/if}

      <!-- Hydrogen bond rendering (dashed cylinders) -->
      {#if instanced_hbond_groups.length > 0 && show_bulk_atoms}
        {#each instanced_hbond_groups as group}
          <DashedBond {group} {depth_cue_uniforms} />
        {/each}
      {/if}

      <!-- Batched invisible hitbox for all bonds (single InstancedMesh) -->
      {#if filtered_bond_pairs.length > 0 && show_bulk_atoms}
        <T.InstancedMesh
          args={[bond_hitbox_geometry, bond_hitbox_material, INITIAL_MESH_CAPACITY]}
          bind:ref={bond_hitbox_mesh}
          frustumCulled={false}
          onclick={handle_bond_hitbox_click}
          onpointerenter={handle_bond_hitbox_pointer_enter}
          onpointerleave={handle_bond_hitbox_pointer_leave}
        />
        <!-- Bond halo (fresnel silhouette glow) — unified visual language
             with the atom selection halo. Renders for hovered + selected
             bonds; deduped via bond_halo_entries. depthTest:true so atoms
             in front correctly occlude; depthWrite:false so halo doesn't
             write into z-buffer.
             Matrix is updated reactively via the $effect below — using
             `oncreate` only would freeze the halo in place when atoms
             move/rotate (entry.matrix changes but the mesh isn't recreated
             since its `entry.key` is stable across drags). -->
        {#each bond_halo_entries as entry, i (entry.key)}
          <T.Mesh
            matrixAutoUpdate={false}
            geometry={bond_halo_geometry}
            material={bond_halo_material}
            raycast={null}
            renderOrder={1}
            bind:ref={bond_halo_meshes[i]}
          />
        {/each}
      {/if}

      <BondEditingIndicators
        {bond_mode_active}
        selected_bonds={selected_bonds}
        {hovered_bond_key}
        {bond_first_atom}
        {filtered_bond_pairs}
        {position_by_site_idx}
        {radius_by_site_idx}
        {atom_radius}
        {bond_thickness}
        structure_sites={structure?.sites}
        {bond_ghost_end}
      />

      <!-- Hover indication is handled by cursor change + tooltip overlay
           (see hover_label / hovered_site bindings). No 3D halo: layering an
           extra mesh on top of the atom impostor inevitably either obscures
           the atom (opaque), invisibly clamps to background (additive), or
           low-contrasts against one of the themes (normal blend). The
           cursor + tooltip combo is what professional viewers (ChimeraX,
           PyMOL, VESTA) use — clean and theme-independent. -->

      <!-- R7: instanced selection-highlight mesh (replaces the per-atom
           {#each} ... <T.Mesh> block). One geometry, one material, one
           draw call regardless of selection size. See SelectionHighlights
           for the per-instance matrix + color rebuild logic. -->
      <SelectionHighlights
        {structure}
        selected_sites={selected_sites ?? []}
        active_sites={active_sites ?? []}
        hovered_site_idx={camera_is_moving ? null : hovered_idx}
        {selection_highlight_color}
        {active_highlight_color}
        pulse_opacity={__pulse_opacity}
        {realtime_position_overrides}
        {position_by_site_idx}
        {radius_by_site_idx}
        {atom_radius}
        {camera}
        {is_rotating_atoms}
        {is_dragging_atom}
        {mark_dirty}
      />

      <!-- Rotation axis indicator line (inline mesh with MeshBasicMaterial for guaranteed visibility) -->
      {#if is_rotating_atoms && atom_rotation_center && atom_rotation_axis}
        {@const axis_len = Math.max((structure_size ?? 5) * 0.8, 5)}
        {@const ax = atom_rotation_axis}
        {@const c = atom_rotation_center}
        {@const axis_dir = new Vector3(ax[0], ax[1], ax[2])}
        {@const axis_quat = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axis_dir)}
        {@const axis_euler = new Euler().setFromQuaternion(axis_quat)}
        <T.Mesh
          position={c}
          rotation={[axis_euler.x, axis_euler.y, axis_euler.z]}
          raycast={null}
          renderOrder={999}
        >
          <T.CylinderGeometry args={[0.03, 0.03, axis_len * 2, 8]} />
          <T.MeshBasicMaterial
            color="#ffcc00"
            transparent
            opacity={0.6}
            depthTest={false}
            depthWrite={false}
          />
        </T.Mesh>
      {/if}

      <PencilModeOverlay
        {pencil_mode_active}
        {pencil_ghost_atom}
        {atom_radius}
        {sphere_segments}
        {bond_thickness}
        {frozen_ring_rotation}
        {all_radii_by_site_idx}
        element_colors={colors.element}
      />

      {#if structure?.sites}
        <FrozenAtomIndicators sites={structure.sites} {all_radii_by_site_idx} {atom_radius} />
      {/if}

      <!-- NOTE: Removed selection order labels (1, 2, 3, ...) for measured sites per user request -->
      <!-- Measurements now show distance/angle values directly without index labels -->

      <!-- hovered site tooltip -->
      {#if hovered_site?.xyz && hovered_site.species?.length && !camera_is_moving && active_tooltip === `atom`}
        {@const         abc = hovered_site.abc?.map((x) => format_num(x, float_fmt)).join(`, `)}
        {@const         xyz = hovered_site.xyz.map((x) => format_num(x, float_fmt)).join(`, `)}
        {@const hov_is_image = hovered_idx != null && num_original_sites !== undefined && hovered_idx >= num_original_sites}
        {@const hov_display_idx = (hov_is_image && image_to_original_map)
          ? image_to_original_map[(hovered_idx as number) - num_original_sites!] + 1
          : ((hovered_idx ?? -1) + 1)}
        {@const sel_dyn_hovered = hovered_site.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined}
        {@const is_fully_frozen = sel_dyn_hovered && !sel_dyn_hovered[0] && !sel_dyn_hovered[1] && !sel_dyn_hovered[2]}
        {@const is_partially_frozen = sel_dyn_hovered && !is_fully_frozen && (!sel_dyn_hovered[0] || !sel_dyn_hovered[1] || !sel_dyn_hovered[2])}
        {@const frozen_axes = sel_dyn_hovered ? ['x', 'y', 'z'].filter((_, i) => !sel_dyn_hovered[i]).join(', ') : ''}
        <CanvasTooltip position={hovered_site.xyz}>
          <!-- Element symbols with occupancies for disordered sites -->
          <div class="elements">
            {#each hovered_site.species as
              { element, occu, oxidation_state: oxi_state },
              idx
              (idx)
            }
              {@const             oxi_str = (oxi_state != null && oxi_state !== 0)
              ? `<sup>${Math.abs(oxi_state)}${
                oxi_state > 0 ? `+` : `−`
              }</sup>`
              : ``}
              {@const             element_name = element_data.find((elem) =>
              elem.symbol === element
            )?.name ??
              ``}
              {#if idx > 0}&thinsp;{/if}
              {#if occu !== 1}<span class="occupancy">{
                  format_num(occu, `.3~f`)
                }</span>{/if}
              <strong>{element}{@html oxi_str}</strong>
              {#if element_name}<span class="elem-name">{element_name}</span>{/if}
            {/each}
            {#if is_fully_frozen}
              <span class="frozen-badge" title="Atom is frozen (selective dynamics: F F F)">🔒</span>
            {:else if is_partially_frozen}
              <span class="frozen-badge partial" title="Atom frozen on {frozen_axes} axis">🔓</span>
            {/if}
          </div>
          {#if hov_display_idx > 0}
            <div class="site-idx">site #{hov_display_idx}{hov_is_image ? ` (image)` : ``}</div>
          {/if}
          {#if abc}
            <div class="coordinates fractional">abc: ({abc})</div>
          {/if}
          <div class="coordinates cartesian">xyz: ({xyz}) Å</div>
          {#if is_fully_frozen}
            <div class="frozen-status">Frozen (all axes)</div>
          {:else if is_partially_frozen}
            <div class="frozen-status partial">Frozen: {frozen_axes}</div>
          {/if}
        </CanvasTooltip>
      {/if}

      {#if lattice && show_cell && show_bulk_atoms}
        <Lattice matrix={lattice.matrix} {...lattice_props} />
      {/if}

      <!-- Miller Slab Cutting - WYSIWYG Slab Preview -->
      {#if cutting_active && cutting_slab_preview}
        <SlabPreview
          {cutting_slab_preview}
          {cutting_show_bonds}
          {bonding_strategy}
          bonding_options={bonding_options_eff}
          {bond_thickness}
          {bond_color}
          ambient_light={active_ambient_light}
          directional_light={active_directional_light}
          {element_radius_overrides}
          {atom_radius}
          {sphere_segments}
          {bond_distance_rules}
          {float_fmt}
          {camera_is_moving}
        />
      {/if}

      {#if show_bulk_atoms}
        <AdsorptionSiteMarkers
          {adsorption_sites}
          {show_adsorption_sites}
          bind:selected_adsorption_site_idx
          {on_adsorption_site_click}
          {on_delete_adsorption_site}
          {camera_is_moving}
          {external_dragging}
          {is_rotating_atoms}
          {is_box_selecting}
          on_hover_change={(hovered) => {
            if (hovered) {
              active_tooltip = null
            }
          }}
        />
      {/if}

      <CubeIsosurface
        positive_mesh={cube_positive_mesh}
        negative_mesh={cube_negative_mesh}
        show_positive={cube_show_positive}
        show_negative={cube_show_negative}
        positive_color={cube_positive_color}
        negative_color={cube_negative_color}
        opacity={cube_opacity}
        wireframe={cube_wireframe}
        slice_normal={cube_slice_normal}
        slice_center={cube_slice_center}
        show_slice_plane={cube_show_slice_plane}
        slice_plane_size={cube_slice_plane_size}
        slice_color={cube_slice_color}
      />

      <!-- Measurement overlays - render from measurements array (multiple independent measurements) -->
      {#if structure?.sites && measurements.length > 0}
        {#each measurements as measurement (measurement.id)}
          {@const is_selected = selected_measurement_id === measurement.id}
          {#if measurement.type === 'distance' && measurement.sites.length >= 2}
            <!-- Render all pairs for distance measurement -->
            {#each measurement.sites as idx_i, loop_idx (idx_i)}
              {#each measurement.sites.slice(loop_idx + 1) as idx_j (`${measurement.id}-${idx_i}-${idx_j}`)}
                {@const site_i = structure.sites[idx_i]}
                {@const site_j = structure.sites[idx_j]}
                {#if site_i && site_j}
                  {@const pos_i = realtime_position_overrides?.get(idx_i) ?? site_i.xyz}
                  {@const pos_j = realtime_position_overrides?.get(idx_j) ?? site_j.xyz}
                  <Cylinder
                    from={pos_i}
                    to={pos_j}
                    thickness={is_selected ? 0.15 : 0.12}
                    color={is_selected ? '#ffcc00' : measure_line_color}
                  />
                  {@const midpoint = [
                    (pos_i[0] + pos_j[0]) / 2,
                    (pos_i[1] + pos_j[1]) / 2,
                    (pos_i[2] + pos_j[2]) / 2,
                  ] as Vec3}
                  {@const direct = math.euclidean_dist(pos_i, pos_j)}
                  {@const pbc = lattice
                    ? measure.distance_pbc(pos_i, pos_j, lattice.matrix)
                    : direct}
                  {@const differ = lattice ? Math.abs(pbc - direct) > 1e-6 : false}
                  <extras.HTML center position={midpoint}>
                    <span
                      class="measure-label"
                      class:selected={is_selected}
                      data-measurement-id={measurement.id}
                    >
                      {#if differ}
                        PBC: {format_num(pbc, float_fmt)} Å<br /><small>
                          Direct: {format_num(direct, float_fmt)} Å</small>
                      {:else}
                        {format_num(pbc, float_fmt)} Å
                      {/if}
                    </span>
                  </extras.HTML>
                {/if}
              {/each}
            {/each}
          {:else if measurement.type === 'angle' && measurement.sites.length >= 3}
            <!-- Render all angle combinations — grouped under one measurement ID -->
            {#each measurement.sites as idx_center (`${measurement.id}-center-${idx_center}`)}
              {@const center = structure.sites[idx_center]}
              {#if center}
                {@const center_pos = realtime_position_overrides?.get(idx_center) ?? center.xyz}
                {#each measurement.sites.filter((x) => x !== idx_center) as idx_a, loop_idx (`${measurement.id}-${idx_center}-${idx_a}`)}
                  {#each measurement.sites.filter((x) => x !== idx_center).slice(loop_idx + 1) as idx_b (`${measurement.id}-${idx_center}-${idx_a}-${idx_b}`)}
                    {@const site_a = structure.sites[idx_a]}
                    {@const site_b = structure.sites[idx_b]}
                    {#if site_a && site_b}
                      {@const pos_a = realtime_position_overrides?.get(idx_a) ?? site_a.xyz}
                      {@const pos_b = realtime_position_overrides?.get(idx_b) ?? site_b.xyz}
                      {@const v1 = measure.displacement_pbc(center_pos, pos_a, lattice?.matrix)}
                      {@const v2 = measure.displacement_pbc(center_pos, pos_b, lattice?.matrix)}
                      {@const n1 = Math.hypot(v1[0], v1[1], v1[2])}
                      {@const n2 = Math.hypot(v2[0], v2[1], v2[2])}
                      {@const angle_deg = measure.angle_between_vectors(v1, v2, `degrees`)}
                      {#if n1 > math.EPS && n2 > math.EPS}
                        <Cylinder
                          from={center_pos}
                          to={pos_a}
                          thickness={is_selected ? 0.07 : 0.05}
                          color={is_selected ? '#ffcc00' : measure_line_color}
                        />
                        <Cylinder
                          from={center_pos}
                          to={pos_b}
                          thickness={is_selected ? 0.07 : 0.05}
                          color={is_selected ? '#ffcc00' : measure_line_color}
                        />
                        {@const bisector = math.add(math.scale(v1, 1 / n1), math.scale(v2, 1 / n2))}
                        {@const bis_norm = Math.hypot(...bisector) || 1}
                        {@const offset_dir = math.scale(bisector, 1 / bis_norm)}
                        {@const label_pos = math.add(center_pos, math.scale(offset_dir, 0.6))}
                        <extras.HTML center position={label_pos}>
                          <span
                            class="measure-label"
                            class:selected={is_selected}
                            data-measurement-id={measurement.id}
                          >
                            {format_num(angle_deg, float_fmt)}°
                          </span>
                        </extras.HTML>
                      {/if}
                    {/if}
                  {/each}
                {/each}
              {/if}
            {/each}
          {:else if measurement.type === 'dihedral' && measurement.sites.length >= 4}
            <!-- Dihedral angle: 4 atoms A-B-C-D, angle between planes ABC and BCD -->
            {@const [idx_a, idx_b, idx_c, idx_d] = measurement.sites}
            {@const site_a = structure.sites[idx_a]}
            {@const site_b = structure.sites[idx_b]}
            {@const site_c = structure.sites[idx_c]}
            {@const site_d = structure.sites[idx_d]}
            {#if site_a && site_b && site_c && site_d}
              {@const pos_a = realtime_position_overrides?.get(idx_a) ?? site_a.xyz}
              {@const pos_b = realtime_position_overrides?.get(idx_b) ?? site_b.xyz}
              {@const pos_c = realtime_position_overrides?.get(idx_c) ?? site_c.xyz}
              {@const pos_d = realtime_position_overrides?.get(idx_d) ?? site_d.xyz}
              {@const dihedral_deg = measure.dihedral_angle(pos_a, pos_b, pos_c, pos_d, `degrees`)}
              <!-- Lines connecting A-B, B-C, C-D -->
              <Cylinder
                from={pos_a} to={pos_b}
                thickness={is_selected ? 0.07 : 0.05}
                color={is_selected ? '#ffcc00' : measure_line_color}
              />
              <Cylinder
                from={pos_b} to={pos_c}
                thickness={is_selected ? 0.10 : 0.08}
                color={is_selected ? '#ffcc00' : '#8b5cf6'}
              />
              <Cylinder
                from={pos_c} to={pos_d}
                thickness={is_selected ? 0.07 : 0.05}
                color={is_selected ? '#ffcc00' : measure_line_color}
              />
              <!-- Label at midpoint of B-C (the central bond) -->
              {@const label_pos = [
                (pos_b[0] + pos_c[0]) / 2,
                (pos_b[1] + pos_c[1]) / 2,
                (pos_b[2] + pos_c[2]) / 2,
              ] as Vec3}
              <extras.HTML center position={label_pos}>
                <span
                  class="measure-label"
                  class:selected={is_selected}
                  data-measurement-id={measurement.id}
                >
                  {format_num(dihedral_deg, float_fmt)}°
                </span>
              </extras.HTML>
            {/if}
          {/if}
        {/each}
      {/if}

      <!-- Per-atom charge labels -->
      {#each charge_label_entries as entry (entry.site_idx)}
        {@const offset = charge_label_offsets.get(entry.original_idx) ?? [0, 0]}
        {@const label_top = offset[1] - 24}
        <extras.HTML center position={entry.position}>
          {#if editing_charge_site_idx === entry.original_idx}
            <input
              class="charge-label-input"
              type="number"
              step="any"
              value={entry.charge.toFixed(4)}
              style:left="{offset[0]}px"
              style:top="{label_top}px"
              use:auto_focus_charge
              onblur={(e) => {
                const val = parseFloat((e.target as HTMLInputElement).value)
                if (!isNaN(val)) on_charge_value_edit?.(entry.original_idx, val)
                editing_charge_site_idx = null
              }}
              onkeydown={(e) => {
                if (e.key === `Enter`) {
                  (e.target as HTMLInputElement).blur()
                } else if (e.key === `Escape`) {
                  editing_charge_site_idx = null
                }
                e.stopPropagation()
              }}
              onclick={(e) => e.stopPropagation()}
              onpointerdown={(e) => e.stopPropagation()}
            />
          {:else}
            {@const custom_color = charge_label_colors.get(entry.original_idx)}
            <span
              class="charge-label"
              class:charge-positive={entry.charge > 0 && !custom_color?.text}
              class:charge-negative={entry.charge < 0 && !custom_color?.text}
              role="button"
              tabindex="-1"
              data-charge-site-idx={entry.original_idx}
              style:left="{offset[0]}px"
              style:top="{label_top}px"
              style:color={custom_color?.text || null}
              style:background={custom_color?.bg || null}
              ondblclick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                editing_charge_site_idx = entry.original_idx
              }}
              oncontextmenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                on_charge_label_contextmenu?.(entry.original_idx, e.clientX, e.clientY)
              }}
            >
              {format_num(entry.charge, float_fmt)} e
            </span>
          {/if}
        </extras.HTML>
      {/each}

    </T.Group>
  </T.Group>
</T.Group>

<!-- ═══ Batched Site Label Overlay ═══ -->
<!-- Portaled to the Threlte DOM container. Positions updated per-frame via useTask. -->
<!-- This replaces per-atom extras.HTML, avoiding N Three.js Groups + N reactive graphs. -->
{#if (show_site_labels || show_site_indices) && show_bulk_atoms && structure?.sites}
  <!-- Partial-occupancy atom labels (typically < 10, rendered separately) -->
  {@const partial_atoms = atom_data.filter(
    (a) => a.has_partial_occupancy && a.element === structure!.sites[a.site_idx]?.species[0]?.element
  )}
  {#if partial_atoms.length > 0}
    <div
      use:site_label_portal
      bind:this={partial_label_overlay_ref}
      style:position="absolute"
      style:top="0"
      style:left="0"
      style:width="100%"
      style:height="100%"
      style:pointer-events="none"
      style:overflow="hidden"
    >
      {#each partial_atoms as atom (atom.site_idx)}
        <span
          class="atom-label site-label-batch"
          data-pos="{atom.position[0]},{atom.position[1]},{atom.position[2]}"
          style:font-size="{site_label_size * 0.85}em"
          style:padding="{site_label_padding}px"
          style:color={site_label_color}
          style:background={site_label_bg_color}
        >
          {@render site_label_content(structure!.sites[atom.site_idx], atom.site_idx)}
        </span>
      {/each}
    </div>
  {/if}

  <!-- Full-occupancy atom labels (batched, can be hundreds) -->
  <div
    use:site_label_portal
    bind:this={site_label_overlay_ref}
    style:position="absolute"
    style:top="0"
    style:left="0"
    style:width="100%"
    style:height="100%"
    style:pointer-events="none"
    style:overflow="hidden"
  >
    {#each site_label_atoms as atom (atom.site_idx)}
      <span
        class="atom-label site-label-batch"
        style:font-size="{site_label_size * 0.85}em"
        style:padding="{site_label_padding}px"
        style:color={site_label_color}
        style:background={site_label_bg_color}
      >
        {@render site_label_content(structure!.sites[atom.site_idx], atom.site_idx)}
      </span>
    {/each}
    {#if site_labels_capped}
      <span class="label-cap-warning" style:position="fixed" style:bottom="8px" style:left="50%" style:transform="translateX(-50%)">
        Showing {SITE_LABEL_LIMIT} / {unique_instanced_atoms.length} labels
      </span>
    {/if}
  </div>
{/if}

<style>
  :global(.structure .responsive-gizmo) {
    width: clamp(70px, 18cqmin, 100px) !important;
    height: clamp(70px, 18cqmin, 100px) !important;
  }
  /* Force all Threlte HTML wrappers for labels to not block pointer events
     and prevent text selection when dragging from outside (e.g. sidebar) */
  :global(.structure canvas + div) {
    pointer-events: none !important;
    user-select: none !important;
  }
  :global(.structure canvas + div *) {
    pointer-events: none !important;
    user-select: none !important;
  }
  /* But allow measure labels to be clickable */
  :global(.structure .measure-label) {
    pointer-events: auto !important;
  }
  /* Allow charge labels to be interactive */
  :global(.structure .charge-label),
  :global(.structure .charge-label-input) {
    pointer-events: auto !important;
  }
  /* But allow gizmo to be clickable */
  :global(.structure .responsive-gizmo),
  :global(.structure .responsive-gizmo *) {
    pointer-events: auto !important;
  }
  .atom-label {
    color: var(--struct-label-color, #1a1a1a);
    background: var(--struct-label-bg, rgba(255, 255, 255, 0.85));
    border-radius: var(--struct-atom-label-border-radius, 3pt);
    padding: var(--struct-atom-label-padding, 0 3px);
    white-space: nowrap;
    pointer-events: none; /* Don't block hover on atoms */
  }
  /* Batched labels positioned absolutely inside the portal overlay.
     Scoped class works because Svelte adds hash to the element at compile time. */
  .site-label-batch {
    position: absolute;
    left: 0;
    top: 0;
    will-change: transform;
    display: none; /* hidden until first frame projects them */
  }
  .label-cap-warning {
    color: #f59e0b;
    background: rgba(0, 0, 0, 0.75);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 0.75em;
    white-space: nowrap;
    pointer-events: none;
  }
  .elements {
    margin-bottom: var(--canvas-tooltip-elements-margin);
  }
  .occupancy {
    font-size: var(--canvas-tooltip-occu-font-size);
    opacity: var(--canvas-tooltip-occu-opacity);
    margin-right: var(--canvas-tooltip-occu-margin);
  }
  .elem-name {
    font-size: var(--canvas-tooltip-elem-name-font-size, 0.85em);
    opacity: var(--canvas-tooltip-elem-name-opacity, 0.7);
    margin: var(--canvas-tooltip-elem-name-margin, 0 0 0 0.3em);
    font-weight: var(--canvas-tooltip-elem-name-font-weight, normal);
  }
  .coordinates {
    font-size: var(--canvas-tooltip-coords-font-size);
    margin: var(--canvas-tooltip-coords-margin);
  }
  .frozen-badge {
    margin-left: 0.3em;
  }
  .frozen-badge.partial {
    opacity: 0.7;
  }
  .frozen-status {
    font-size: 0.9em;
    color: #ff6b6b;
    margin-top: 2px;
    font-weight: 500;
  }
  .frozen-status.partial {
    color: #ffa94d;
  }
  .measure-label {
    background: var(--measure-label-bg, var(--surface-bg));
    color: var(--measure-label-color, var(--text-color));
    border-radius: 4px;
    padding: 2px 6px;
    user-select: none;
    white-space: pre;
    display: grid;
    place-items: center;
    line-height: 1.2;
    font-size: var(--canvas-tooltip-font-size, clamp(8pt, 2cqmin, 18pt));
    box-shadow: var(--measure-label-shadow, 0 1px 6px rgba(0, 0, 0, 0.2));
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
    pointer-events: auto;
    position: relative;
    z-index: 10;
  }
  .measure-label:active {
    transform: scale(0.95);
  }
  .measure-label:hover {
    background: var(--measure-label-hover-bg, rgba(255, 204, 0, 0.2));
  }
  .measure-label.selected {
    background: var(--measure-label-selected-bg, rgba(255, 204, 0, 0.4));
    border: 2px solid #ffcc00;
    box-shadow: 0 0 8px rgba(255, 204, 0, 0.5);
  }
  .charge-label {
    background: rgba(20, 20, 30, 0.85);
    color: #9e9e9e;
    border-radius: 3px;
    padding: 1px 3px;
    user-select: none;
    white-space: nowrap;
    font-size: clamp(7pt, 1.5cqmin, 11pt);
    line-height: 1.2;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    cursor: grab;
    pointer-events: auto;
    position: absolute;
    z-index: 10;
    transition: background 0.15s, color 0.15s;
  }
  .charge-label.charge-positive {
    color: #ef5350;
  }
  .charge-label.charge-negative {
    color: #42a5f5;
  }
  .charge-label:hover {
    background: rgba(30, 40, 60, 0.95);
  }
  .charge-label-input {
    background: rgba(20, 20, 30, 0.95);
    color: #4fc3f7;
    border: 1px solid #4fc3f7;
    border-radius: 3px;
    padding: 1px 3px;
    font-size: clamp(7pt, 1.5cqmin, 11pt);
    width: 6em;
    pointer-events: auto;
    position: absolute;
    z-index: 11;
    outline: none;
  }
</style>

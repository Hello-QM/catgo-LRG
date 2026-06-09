/**
 * Build Tools Controller — extracted from Structure.svelte (P2-1)
 *
 * Manages state and logic for all structure build tools:
 * - Build pane open/close and active tab
 * - Slab cutter bulk structure preservation
 * - Slab cutter visualization state (cutting plane, atom visibility, etc.)
 * - Vacuum detection
 * - Adsorption/adsorbate placement state
 * - Doping split-view state
 * - Structure change handlers (with supercell_scaling reset for tools that replace structure)
 *
 * Uses .svelte.ts suffix because internal state uses $state/$derived/$effect runes.
 *
 * Dependencies:
 * - structure, supercell_scaling accessed via getter/setter deps
 */

import type { AnyStructure, Vec3 } from '$lib'
import type { PymatgenStructure } from '$lib/structure'
type BuildTab = 'lattice' | 'slab_cutter' | 'adsorption' | 'adsorbate' | 'water_layer' | 'pseudo_h' | 'moire' | 'nanotube' | 'nanoscroll' | 'heterostructure' | 'doping' | 'pathway' | 'reticular'
import type { AtomVisibility, SlabPreviewStructure } from '../miller-slab'
import type { AdsorptionSite } from '../ferrox-wasm-types'
import { matrix_inverse_3x3 } from '$lib/math'

// ─── Types ───

/** Dependencies interface — access parent component state via getter/setter closures */
export interface BuildToolsDeps {
  // ── Core structure ──
  get_structure: () => AnyStructure | undefined
  set_structure: (s: AnyStructure) => void

  // ── Supercell scaling (bindable prop in parent) ──
  get_supercell_scaling: () => string
  set_supercell_scaling: (s: string) => void

  // ── Undo ──
  push_to_undo: () => void

  // ── Camera triggers ──
  inc_center_camera: () => void
  inc_reset_camera_up: () => void
  reset_camera_position: () => void
  align_view_to_lattice: () => void

  // ── Optional: bulk structure for passivation when opening a slab directly ──
  initial_bulk?: PymatgenStructure | null
}

// ─── Factory ───

/**
 * Create build tools controller — manages all build tool state and callbacks.
 *
 * Usage:
 * ```ts
 * const build = create_build_tools_controller({
 *   get_structure: () => structure,
 *   set_structure: (s) => { structure = s },
 *   get_supercell_scaling: () => supercell_scaling,
 *   set_supercell_scaling: (s) => { supercell_scaling = s },
 *   push_to_undo: () => push_to_undo(),
 *   inc_center_camera: () => { center_camera_trigger++ },
 *   inc_reset_camera_up: () => { reset_camera_up_trigger++ },
 *   reset_camera_position: () => { scene_props.camera_position = [0, 0, 0] },
 *   align_view_to_lattice: () => align_view_to_lattice(),
 * })
 * ```
 */
export function create_build_tools_controller(deps: BuildToolsDeps) {
  // ═══ Build Pane State ═══

  let build_pane_open = $state(false)
  let active_build_tab = $state<BuildTab>(`lattice`)

  // ═══ Slab Cutter Bulk Preservation ═══
  // Preserve original bulk structure for slab cutter.
  // Skips slabs (pbc[2] === false) so the original bulk is preserved after slab cut.

  let slab_cutter_bulk = $state<PymatgenStructure | null>(deps.initial_bulk ?? null)

  $effect(() => {
    const structure = deps.get_structure()
    if (structure && `lattice` in structure) {
      const s = structure as PymatgenStructure
      const pbc = s.lattice?.pbc
      if (!pbc || pbc[2] !== false) {
        try {
          slab_cutter_bulk = $state.snapshot(s) as PymatgenStructure
        } catch {
          slab_cutter_bulk = s
        }
      }
    } else {
      slab_cutter_bulk = null
    }
  })

  // ═══ Slab Cutter Visualization State ═══

  let cutting_active = $state(false)
  let cutting_plane_normal = $state<Vec3>([0, 0, 1])
  let cutting_plane_offset = $state(0)
  let cutting_plane_thickness = $state(5)
  let cutting_atom_visibility = $state<AtomVisibility[]>([])
  let cutting_flash_intensity = $state(0)
  let cutting_animation_phase = $state<`idle` | `preview` | `applying` | `transitioning`>(`idle`)
  let cutting_miller_label = $state(`(001)`)
  let cutting_slab_preview = $state<SlabPreviewStructure | null>(null)
  let cutting_preview_mode = $state<`slab`>(`slab`)
  let cutting_show_bonds = $state(true)

  // ═══ Vacuum Detection ═══
  // Structure has a lattice and at least one axis has a fractional coordinate gap >= 30%

  const has_vacuum = $derived.by(() => {
    const structure = deps.get_structure()
    if (!structure || !(`lattice` in structure) || !(structure as any).lattice?.matrix || !structure.sites?.length) return false
    const mat = (structure as PymatgenStructure).lattice.matrix
    const inv = matrix_inverse_3x3(mat)
    for (let axis = 0; axis < 3; axis++) {
      const fracs = structure.sites.map((s) => {
        const cart = s.xyz ?? [0, 0, 0]
        const f = inv[0][axis] * cart[0] + inv[1][axis] * cart[1] + inv[2][axis] * cart[2]
        return ((f % 1) + 1) % 1
      }).sort((a, b) => a - b)
      let max_gap = fracs[0] + 1 - fracs[fracs.length - 1]
      for (let i = 1; i < fracs.length; i++) {
        max_gap = Math.max(max_gap, fracs[i] - fracs[i - 1])
      }
      if (max_gap >= 0.3) {
        return true
      }
    }
    return false
  })

  // ═══ Adsorption / Adsorbate State ═══

  let adsorption_sites = $state<AdsorptionSite[]>([])
  let show_adsorption_sites = $state(true)
  let selected_adsorption_site_idx = $state<number | null>(null)
  let delete_adsorption_site_fn = $state<((site_id: number) => void) | undefined>(undefined)
  let adsorbate_placement_mode_active = $state(false)
  let adsorbate_placement_ref = $state<any>(undefined)
  let last_placed_adsorbate_indices = $state<number[]>([])

  // ═══ Doping State ═══

  let doping_pane_ref: any = $state()
  let doping_pt_panel_ref: any = $state()
  let doping_pt_window_open: boolean = $state(false)
  let doping_pt_symbols: string[] = $state([])
  let doping_group_label: string = $state(``)
  let show_doping_pt = $derived(
    active_build_tab === `doping` && build_pane_open,
  )

  // ═══ Tab Switch Cleanup Effects ═══

  $effect(() => {
    if (!build_pane_open || active_build_tab !== `slab_cutter`) {
      cutting_active = false
    }
  })
  $effect(() => {
    if (!build_pane_open || active_build_tab !== `adsorbate`) {
      adsorbate_placement_mode_active = false
    }
  })

  // ═══ Functions ═══

  function open_build_tab(tab: BuildTab) {
    build_pane_open = true
    active_build_tab = tab
  }

  /**
   * Handle structure change from build tools that REPLACE the base structure.
   * Resets supercell_scaling to '1x1x1' to prevent compounding.
   */
  function handle_structure_replace(new_struct: AnyStructure) {
    deps.set_structure(new_struct)
    deps.set_supercell_scaling(`1x1x1`)
  }

  /**
   * Handle structure replacement and refit the camera to the new geometry.
   * Useful for tools that can greatly change the bounding box, such as nanoscrolls.
   */
  function handle_structure_replace_and_fit(new_struct: AnyStructure) {
    handle_structure_replace(new_struct)
    deps.reset_camera_position()
    deps.inc_center_camera()
  }

  /**
   * Handle structure change from slab cutter (also resets camera).
   */
  function handle_slab_structure_change(new_struct: AnyStructure) {
    deps.set_structure(new_struct)
    deps.set_supercell_scaling(`1x1x1`)
    deps.inc_center_camera()
    deps.inc_reset_camera_up()
  }

  /**
   * Handle structure change from build tools that ADD atoms (don't reset supercell).
   */
  function handle_structure_modify(new_struct: AnyStructure) {
    deps.set_structure(new_struct)
  }

  /**
   * Handle slab cutter camera transition — preserve bulk, reset rotation.
   */
  function handle_slab_camera_transition(scene_props: { rotation: Vec3; camera_position: Vec3 }) {
    const structure = deps.get_structure()
    if (structure && `lattice` in structure) {
      const pbc = (structure as PymatgenStructure).lattice?.pbc
      if (!pbc || pbc[2] !== false) {
        try {
          slab_cutter_bulk = JSON.parse(JSON.stringify(structure)) as PymatgenStructure
        } catch {
          // Clone failed, keep existing bulk reference
        }
      }
    }
    scene_props.rotation = [0, 0, 0]
    scene_props.camera_position = [0, 0, 0]
  }

  // ═══ Public Interface ═══

  return {
    // ── Build pane state ──
    get build_pane_open() { return build_pane_open },
    set build_pane_open(v: boolean) { build_pane_open = v },
    get active_build_tab() { return active_build_tab },
    set active_build_tab(v: BuildTab) { active_build_tab = v },

    // ── Slab cutter bulk ──
    get slab_cutter_bulk() { return slab_cutter_bulk },

    // ── Slab cutter visualization ──
    get cutting_active() { return cutting_active },
    set cutting_active(v: boolean) { cutting_active = v },
    get cutting_plane_normal() { return cutting_plane_normal },
    set cutting_plane_normal(v: Vec3) { cutting_plane_normal = v },
    get cutting_plane_offset() { return cutting_plane_offset },
    set cutting_plane_offset(v: number) { cutting_plane_offset = v },
    get cutting_plane_thickness() { return cutting_plane_thickness },
    set cutting_plane_thickness(v: number) { cutting_plane_thickness = v },
    get cutting_atom_visibility() { return cutting_atom_visibility },
    set cutting_atom_visibility(v: AtomVisibility[]) { cutting_atom_visibility = v },
    get cutting_flash_intensity() { return cutting_flash_intensity },
    set cutting_flash_intensity(v: number) { cutting_flash_intensity = v },
    get cutting_animation_phase() { return cutting_animation_phase },
    set cutting_animation_phase(v: typeof cutting_animation_phase) { cutting_animation_phase = v },
    get cutting_miller_label() { return cutting_miller_label },
    set cutting_miller_label(v: string) { cutting_miller_label = v },
    get cutting_slab_preview() { return cutting_slab_preview },
    set cutting_slab_preview(v: SlabPreviewStructure | null) { cutting_slab_preview = v },
    get cutting_preview_mode() { return cutting_preview_mode },
    set cutting_preview_mode(v: typeof cutting_preview_mode) { cutting_preview_mode = v },
    get cutting_show_bonds() { return cutting_show_bonds },
    set cutting_show_bonds(v: boolean) { cutting_show_bonds = v },

    // ── Vacuum ──
    get has_vacuum() { return has_vacuum },

    // ── Adsorption / Adsorbate ──
    get adsorption_sites() { return adsorption_sites },
    set adsorption_sites(v: AdsorptionSite[]) { adsorption_sites = v },
    get show_adsorption_sites() { return show_adsorption_sites },
    set show_adsorption_sites(v: boolean) { show_adsorption_sites = v },
    get selected_adsorption_site_idx() { return selected_adsorption_site_idx },
    set selected_adsorption_site_idx(v: number | null) { selected_adsorption_site_idx = v },
    get delete_adsorption_site_fn() { return delete_adsorption_site_fn },
    set delete_adsorption_site_fn(v: ((site_id: number) => void) | undefined) { delete_adsorption_site_fn = v },
    get adsorbate_placement_mode_active() { return adsorbate_placement_mode_active },
    set adsorbate_placement_mode_active(v: boolean) { adsorbate_placement_mode_active = v },
    get adsorbate_placement_ref() { return adsorbate_placement_ref },
    set adsorbate_placement_ref(v: any) { adsorbate_placement_ref = v },
    get last_placed_adsorbate_indices() { return last_placed_adsorbate_indices },
    set last_placed_adsorbate_indices(v: number[]) { last_placed_adsorbate_indices = v },

    // ── Doping ──
    get doping_pane_ref() { return doping_pane_ref },
    set doping_pane_ref(v: any) { doping_pane_ref = v },
    get doping_pt_panel_ref() { return doping_pt_panel_ref },
    set doping_pt_panel_ref(v: any) { doping_pt_panel_ref = v },
    get doping_pt_window_open() { return doping_pt_window_open },
    set doping_pt_window_open(v: boolean) { doping_pt_window_open = v },
    get doping_pt_symbols() { return doping_pt_symbols },
    set doping_pt_symbols(v: string[]) { doping_pt_symbols = v },
    get doping_group_label() { return doping_group_label },
    set doping_group_label(v: string) { doping_group_label = v },
    get show_doping_pt() { return show_doping_pt },

    // ── Functions ──
    open_build_tab,
    handle_structure_replace,
    handle_structure_replace_and_fit,
    handle_slab_structure_change,
    handle_structure_modify,
    handle_slab_camera_transition,
  }
}

/** Return type for the build tools controller */
export type BuildToolsController = ReturnType<typeof create_build_tools_controller>

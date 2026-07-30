<script lang="ts">
  import type { HudSafeArea } from '$lib/structure/rendering/gizmo'

  let {
    hud_safe,
    camera_is_moving = $bindable(),
    selected_sites = $bindable(),
    measured_sites = $bindable(),
    selected_measurement_id = $bindable(),
    scene = $bindable(),
    camera = $bindable(),
    pixels_per_angstrom = $bindable(),
    orbit_controls = $bindable(),
    rotation_target_ref = $bindable(),
    initial_computed_zoom = $bindable(),
    lattice_align_trigger = $bindable(),
    selected_adsorption_site_idx = $bindable(),
    atom_fast_ops = $bindable(),
    atom_manager = $bindable(),
    visual_state_source = $bindable(),
    selected_bonds = $bindable(),
    filtered_bond_pairs_out = $bindable(),
    selection_opacity = $bindable(),
  }: {
    hud_safe: HudSafeArea
    camera_is_moving?: unknown
    selected_sites?: unknown
    measured_sites?: unknown
    selected_measurement_id?: unknown
    scene?: unknown
    camera?: unknown
    pixels_per_angstrom?: unknown
    orbit_controls?: unknown
    rotation_target_ref?: unknown
    initial_computed_zoom?: unknown
    lattice_align_trigger?: unknown
    selected_adsorption_site_idx?: unknown
    atom_fast_ops?: unknown
    atom_manager?: unknown
    visual_state_source?: unknown
    selected_bonds?: unknown
    filtered_bond_pairs_out?: unknown
    selection_opacity?: unknown
  } = $props()
</script>

<div
  data-testid="structure-scene-hud-capture"
  data-left={hud_safe.l}
  data-right={hud_safe.r}
  data-top={hud_safe.t}
  data-bottom={hud_safe.b}
></div>

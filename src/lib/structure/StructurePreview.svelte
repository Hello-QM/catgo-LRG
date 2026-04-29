<script lang="ts">
  import type { PymatgenStructure, ElementSymbol } from '$lib'
  import type { AdsorptionSite } from './ferrox-wasm-types'
  import { DEFAULTS } from '$lib/settings'
  import { Canvas } from '@threlte/core'
  import { SvelteMap } from 'svelte/reactivity'
  import StructureScene from './StructureScene.svelte'
  import { get_pbc_image_sites } from './pbc'

  interface Props {
    structure: PymatgenStructure | null
    onselect?: (index: number) => void
    adsorption_sites?: AdsorptionSite[]
    on_adsorption_site_click?: (site_idx: number) => void
  }

  let { structure, onselect, adsorption_sites = [], on_adsorption_site_click }: Props = $props()

  // Compute structure with PBC image atoms for preview display
  const display_structure = $derived.by(() => {
    if (!structure?.sites?.length || !structure.lattice) return structure
    try {
      return get_pbc_image_sites(structure as any) as unknown as PymatgenStructure
    } catch {
      return structure
    }
  })

  // Initialize scene props - disable auto rotation and damping to prevent drift
  // Destructure out keys from DEFAULTS.structure that are not StructureScene props
  const {
    show_image_atoms: _show_image_atoms,
    atom_color_mode: _atom_color_mode,
    atom_color_scale: _atom_color_scale,
    atom_color_scale_type: _atom_color_scale_type,
    show_gizmo: _show_gizmo,
    show_cell: _show_cell,
    show_cell_vectors: _show_cell_vectors,
    cell_edge_opacity: _cell_edge_opacity,
    cell_surface_opacity: _cell_surface_opacity,
    cell_edge_color: _cell_edge_color,
    cell_surface_color: _cell_surface_color,
    cell_edge_width: _cell_edge_width,
    fullscreen_toggle: _fullscreen_toggle,
    keyboard_movement_step: _keyboard_movement_step,
    frozen_atom_indicator: _frozen_atom_indicator,
    force_shaft_radius: _force_shaft_radius,
    force_arrow_head_radius: _force_arrow_head_radius,
    force_arrow_head_length: _force_arrow_head_length,
    ...scene_defaults
  } = DEFAULTS.structure
  let scene_props = $state({
    ...scene_defaults,
    auto_rotate: 0,
    rotation_damping: 0,
  })
  let lattice_props = $state({
    cell_edge_opacity: DEFAULTS.structure.cell_edge_opacity,
    cell_surface_opacity: DEFAULTS.structure.cell_surface_opacity,
    cell_edge_color: DEFAULTS.structure.cell_edge_color,
    cell_surface_color: DEFAULTS.structure.cell_surface_color,
    cell_edge_width: DEFAULTS.structure.cell_edge_width,
    show_cell_vectors: DEFAULTS.structure.show_cell_vectors,
  })

  let element_radius_overrides = $state<Partial<Record<ElementSymbol, number>>>({})
  let site_radius_overrides = $state(new SvelteMap<number, number>())

  let selected_sites = $state<number[]>([])
  let measured_sites = $state<number[]>([])
  let hidden_elements: any = $state(new Set<string>())

  // Notify parent when a site is clicked
  $effect(() => {
    if (selected_sites.length > 0 && onselect) {
      onselect(selected_sites[selected_sites.length - 1])
      selected_sites = []
    }
  })
  let camera_is_moving = $state(false)
  let hovered_idx = $state<number | null>(null)
  let scene = $state<any>(undefined)
  let camera = $state<any>(undefined)
  let orbit_controls = $state<any>(undefined)
  let rotation_target_ref = $state<[number, number, number] | undefined>(undefined)
  let initial_computed_zoom = $state<number | undefined>(undefined)

  let measurements = $state<Array<{ id: string; type: 'distance' | 'angle'; sites: number[] }>>([])
  let selected_measurement_id = $state<string | null>(null)

  let width = $state(0)
  let height = $state(0)
  let container: HTMLDivElement | undefined = $state()
</script>

{#if display_structure?.sites && display_structure.sites.length > 0}
  {#if typeof WebGLRenderingContext !== 'undefined'}
    <div
      bind:this={container}
      bind:clientWidth={width}
      bind:clientHeight={height}
      class="structure-canvas-container"
    >
      <Canvas {...{rendererParameters: { alpha: true, antialias: true }} as any}>
        <StructureScene
          structure={display_structure}
          {...scene_props}
          {lattice_props}
          {element_radius_overrides}
          {site_radius_overrides}
          {width}
          {height}
          {measurements}
          {adsorption_sites}
          show_adsorption_sites={adsorption_sites.length > 0}
          {on_adsorption_site_click}
          bind:selected_sites
          bind:measured_sites
          bind:hidden_elements
          bind:camera_is_moving
          bind:hovered_idx
          bind:selected_measurement_id
          bind:scene
          bind:camera
          bind:orbit_controls
          bind:rotation_target_ref
          bind:initial_computed_zoom
        />
      </Canvas>
    </div>
  {/if}
{:else}
  <div class="no-structure">
    <p>No structure data available</p>
  </div>
{/if}

<style>
  .structure-canvas-container {
    width: 100% !important;
    height: 100% !important;
    position: relative !important;
    overflow: hidden !important;
    margin: 0 !important;
    padding: 0 !important;
  }

  :global(.structure-canvas-container canvas) {
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    width: 100% !important;
    height: 100% !important;
    display: block !important;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
  }

  .no-structure {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1a1a1a;
    color: #999;
    border-radius: 4px;
  }

  .no-structure p {
    margin: 0;
    font-size: 0.9rem;
  }
</style>

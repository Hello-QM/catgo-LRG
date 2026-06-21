<script lang="ts">
  import type { PymatgenStructure, ElementSymbol } from '$lib'
  import type { AdsorptionSite } from './ferrox-wasm-types'
  import { DEFAULTS } from '$lib/settings'
  import { Canvas } from '@threlte/core'
  import { SvelteMap } from 'svelte/reactivity'
  import StructureScene from './StructureScene.svelte'
  import ElectronicInfoPanel from './ElectronicInfoPanel.svelte'
  import type { ElectronicProps, ElectronicLabels } from './electronic_preview'

  interface Props {
    structure: PymatgenStructure | null
    onselect?: (index: number) => void
    adsorption_sites?: AdsorptionSite[]
    on_adsorption_site_click?: (site_idx: number) => void
    // Optional electronic-structure metadata. If omitted, falls back to
    // `structure._electronic_props` (stashed by import handlers); pass
    // `null` explicitly to suppress the overlay even when stashed data
    // would otherwise show.
    electronic_props?: ElectronicProps | null
    electronic_labels?: Partial<ElectronicLabels>
    /** Corner position of the overlay; set to `none` to hide. */
    electronic_overlay?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'none'
  }

  let {
    structure,
    onselect,
    adsorption_sites = [],
    on_adsorption_site_click,
    electronic_props,
    electronic_labels = {},
    electronic_overlay = 'none',
  }: Props = $props()

  // Prefer explicit prop; fall back to anything stashed on the structure at import.
  let resolved_electronic = $derived(
    electronic_props === null
      ? null
      : (electronic_props
        ?? (structure as unknown as { _electronic_props?: ElectronicProps } | null)
          ?._electronic_props
        ?? null),
  )

  // Pass the structure through as-is. Previously this called
  // `get_pbc_image_sites()` unconditionally to add PBC image atoms,
  // which made boundary atoms render outside the cell in the database
  // preview modal even though the modal's scene defaults have
  // `show_image_atoms = false`. The main viewer (`Structure.svelte`)
  // gates the same expansion on `show_image_atoms`; preview now
  // matches.
  const display_structure = $derived(structure)

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
      {#if resolved_electronic && electronic_overlay !== 'none'}
        <div class="electronic-overlay" data-corner={electronic_overlay}>
          <ElectronicInfoPanel
            props={resolved_electronic}
            labels={electronic_labels}
            heading={null}
            compact={true}
          />
        </div>
      {/if}
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

  .electronic-overlay {
    position: absolute;
    z-index: 5;
    pointer-events: none;
    max-width: 220px;
    padding: 6px 10px;
    border-radius: 6px;
    background: rgba(20, 20, 20, 0.75);
    color: #eee;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 0.75rem;
  }
  .electronic-overlay[data-corner='top-left'] { top: 8px; left: 8px; }
  .electronic-overlay[data-corner='top-right'] { top: 8px; right: 8px; }
  .electronic-overlay[data-corner='bottom-left'] { bottom: 8px; left: 8px; }
  .electronic-overlay[data-corner='bottom-right'] { bottom: 8px; right: 8px; }

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

<script lang="ts">
  import type { ElementSymbol, Vec3 } from '$lib'
  import { atomic_radii } from '$lib'
  import { T } from '@threlte/core'
  import * as extras from '@threlte/extras'
  import type { SvelteMap } from 'svelte/reactivity'
  import { Cylinder } from './index'

  let {
    pencil_mode_active = false,
    pencil_ghost_atom = null,
    atom_radius = 1,
    sphere_segments = 32,
    bond_thickness = 0.15,
    frozen_ring_rotation = [Math.PI / 2, 0, 0] as [number, number, number],
    all_radii_by_site_idx,
    element_colors = {},
  }: {
    pencil_mode_active?: boolean
    pencil_ghost_atom?: {
      element: ElementSymbol
      position: Vec3
      visible: boolean
      anchor_position: Vec3 | null
      anchor_idx: number | null
    } | null
    atom_radius?: number
    sphere_segments?: number
    bond_thickness?: number
    frozen_ring_rotation?: [number, number, number]
    all_radii_by_site_idx?: Map<number, number> | SvelteMap<number, number>
    element_colors?: Record<string, string>
  } = $props()
</script>

<!-- Anchor atom highlight for pencil/draw mode (shows immediately on click, even before ghost) -->
{#if pencil_mode_active && pencil_ghost_atom?.anchor_idx !== null && pencil_ghost_atom?.anchor_idx !== undefined && pencil_ghost_atom?.anchor_position}
  {@const anchor_radius = all_radii_by_site_idx?.get(pencil_ghost_atom.anchor_idx) ?? atom_radius}
  <!-- Glowing ring around anchor atom -->
  <T.Mesh position={pencil_ghost_atom.anchor_position} rotation={frozen_ring_rotation} raycast={null}>
    <T.TorusGeometry args={[anchor_radius * 1.3, 0.05, 8, 32]} />
    <T.MeshBasicMaterial
      color="#00aaff"
      transparent
      opacity={0.7}
      depthTest={false}

    />
  </T.Mesh>
  <!-- Subtle pulsing outer glow -->
  <T.Mesh position={pencil_ghost_atom.anchor_position} rotation={frozen_ring_rotation} raycast={null}>
    <T.TorusGeometry args={[anchor_radius * 1.5, 0.03, 8, 32]} />
    <T.MeshBasicMaterial
      color="#00aaff"
      transparent
      opacity={0.3}
      depthTest={false}

    />
  </T.Mesh>
{/if}

<!-- Ghost atom for pencil/draw mode -->
{#if pencil_mode_active && pencil_ghost_atom?.visible}
  {@const ghost_color = element_colors[pencil_ghost_atom.element] ?? '#888888'}
  {@const ghost_radius = (atomic_radii[pencil_ghost_atom.element] ?? 1) * atom_radius}
  <!-- Ghost atom sphere (semi-transparent) -->
  <T.Mesh position={pencil_ghost_atom.position} raycast={null} frustumCulled={false}>
    <T.SphereGeometry args={[ghost_radius, sphere_segments, sphere_segments]} />
    <T.MeshStandardMaterial
      color={ghost_color}
      transparent
      opacity={0.5}
      depthWrite={false}
      depthTest={false}
    />
  </T.Mesh>
  <!-- Bond preview line from anchor to ghost -->
  {#if pencil_ghost_atom.anchor_position}
    {@const anchor = pencil_ghost_atom.anchor_position}
    {@const ghost = pencil_ghost_atom.position}
    {@const bond_vec = [ghost[0] - anchor[0], ghost[1] - anchor[1], ghost[2] - anchor[2]] as Vec3}
    {@const bond_length = Math.sqrt(bond_vec[0]**2 + bond_vec[1]**2 + bond_vec[2]**2)}
    {@const midpoint = [(anchor[0] + ghost[0])/2, (anchor[1] + ghost[1])/2, (anchor[2] + ghost[2])/2] as Vec3}
    <!-- Cylinder bond preview -->
    {#if bond_length > 0.01}
      <Cylinder
        from={anchor}
        to={pencil_ghost_atom.position}
        thickness={bond_thickness}
        color="#888888"
        transparent
        opacity={0.5}
        depthTest={false}
      />
    {/if}
    <!-- Distance label -->
    <extras.HTML center position={midpoint} pointerEvents="none">
      <span
        class="pencil-distance-label"
        style="
          background: rgba(0, 0, 0, 0.75);
          color: white;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 0.85em;
          font-weight: 600;
          white-space: nowrap;
        "
      >
        {bond_length.toFixed(2)} Å
      </span>
    </extras.HTML>
  {/if}
{/if}

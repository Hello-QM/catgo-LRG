<script lang="ts">
  import type { BondPair, Site, Vec3 } from '$lib'
  import type { SelectedBond } from './index'
  import { get_bond_key } from './bonding'
  import { T } from '@threlte/core'
  import Bond from './Bond.svelte'
  import { Cylinder } from './index'
  import { colors } from '$lib/state.svelte'
  import type { SvelteMap } from 'svelte/reactivity'

  let {
    bond_mode_active = false,
    selected_bonds = [] as SelectedBond[],
    hovered_bond_key = null,
    bond_first_atom = null,
    filtered_bond_pairs = [],
    position_by_site_idx,
    radius_by_site_idx,
    atom_radius = 1,
    bond_thickness = 0.15,
    structure_sites,
    bond_ghost_end = null,
  }: {
    bond_mode_active?: boolean
    selected_bonds?: SelectedBond[]
    hovered_bond_key?: string | null
    bond_first_atom?: number | null
    filtered_bond_pairs?: BondPair[]
    position_by_site_idx?: Map<number, Vec3> | SvelteMap<number, Vec3>
    radius_by_site_idx?: Map<number, number> | SvelteMap<number, number>
    atom_radius?: number
    bond_thickness?: number
    structure_sites?: Site[]
    bond_ghost_end?: Vec3 | null
  } = $props()

  // Get element color of the first selected atom for ghost bond
  let first_atom_color = $derived.by(() => {
    if (bond_first_atom === null || !structure_sites?.[bond_first_atom]) return `#888888`
    const element = structure_sites[bond_first_atom].species?.[0]?.element
    return (element && colors.element?.[element]) || `#888888`
  })

  // Compute highlight groups for selected bonds (safe $derived - never throws)
  let highlight_groups = $derived.by(() => {
    const groups: { thickness: number; ambient_light?: number; directional_light?: number; polygon_offset?: boolean; render_order?: number; instances: { matrix: Float32Array; color_start: string; color_end: string }[] }[] = []
    for (const sel_bond of selected_bonds ?? []) {
      const bond_data = filtered_bond_pairs.find(b =>
        get_bond_key(b.site_idx_1, b.site_idx_2) === sel_bond.key
      )
      if (!bond_data?.transform_matrix) continue
      groups.push({
        thickness: bond_thickness * 2,
        ambient_light: 1.0,
        directional_light: 0.0,
        polygon_offset: true,
        render_order: 1,
        instances: [{
          matrix: bond_data.transform_matrix,
          color_start: `#fff176`,
          color_end: `#fff176`,
        }],
      })
    }
    return groups
  })

  // Compute hover group (safe $derived - returns null when bond not found)
  let hover_group = $derived.by(() => {
    if (!hovered_bond_key) return null
    if ((selected_bonds ?? []).some(b => b.key === hovered_bond_key)) return null
    const bond_data = filtered_bond_pairs.find(b =>
      get_bond_key(b.site_idx_1, b.site_idx_2) === hovered_bond_key
    )
    if (!bond_data?.transform_matrix) return null
    return {
      thickness: bond_thickness * 2,
      ambient_light: 1.0,
      directional_light: 0.0,
      polygon_offset: true,
      render_order: 1,
      instances: [{
        matrix: bond_data.transform_matrix,
        color_start: `#fff176`,
        color_end: `#fff176`,
      }],
    }
  })
</script>

<!-- Bond editing visuals are only relevant in bond_mode_active. The
     non-editing selection visual is now the fresnel halo in
     StructureScene (bond_halo_entries) — drawing the heavy yellow
     overlay here would compete with it. -->
{#if bond_mode_active}
  {#each highlight_groups as group}
    <Bond {group} />
  {/each}
  <!-- Hovered bond highlight: light blue semi-transparent bond -->
  {#if hover_group}
    <Bond group={hover_group} />
  {/if}

  <!-- First atom indicator: green torus ring -->
  {#if bond_first_atom !== null}
    {@const first_pos = position_by_site_idx?.get(bond_first_atom) ?? structure_sites?.[bond_first_atom]?.xyz}
    {@const first_radius = radius_by_site_idx?.get(bond_first_atom) ?? atom_radius}
    {#if first_pos}
      <T.Mesh position={first_pos} scale={first_radius * 1.4} raycast={null}>
        <T.TorusGeometry args={[0.5, 0.08, 8, 32]} />
        <T.MeshBasicMaterial
          color="#4ade80"
          transparent
          opacity={0.8}
          depthTest={false}
          depthWrite={false}
                 />
      </T.Mesh>
    {/if}
  {/if}

  <!-- Ghost bond line during drag -->
  {#if bond_first_atom !== null && bond_ghost_end}
    {@const ghost_start = position_by_site_idx?.get(bond_first_atom) ?? structure_sites?.[bond_first_atom]?.xyz}
    {#if ghost_start}
      {@const cap_radius = bond_thickness}
      <Cylinder
        from={ghost_start}
        to={bond_ghost_end}
        thickness={Math.sqrt(bond_thickness)}
        color={first_atom_color}
        transparent
        opacity={0.6}
        depthTest={false}
      />
      <!-- Rounded end caps -->
      {#each [ghost_start, bond_ghost_end] as cap_pos}
        <T.Mesh position={cap_pos} raycast={null}>
          <T.SphereGeometry args={[cap_radius, 8, 8]} />
          <T.MeshStandardMaterial
            color={first_atom_color}
            transparent
            opacity={0.6}
            depthTest={false}
            depthWrite={false}
          />
        </T.Mesh>
      {/each}
    {/if}
  {/if}
{/if}

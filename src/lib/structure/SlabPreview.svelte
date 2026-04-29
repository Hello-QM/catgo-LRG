<script lang="ts">
  import type { ElementSymbol, Vec3 } from '$lib'
  import { atomic_radii, element_data } from '$lib'
  import * as math from '$lib/math'
  import { colors } from '$lib/state.svelte'
  import { T } from '@threlte/core'
  import * as extras from '@threlte/extras'
  import type { SlabPreviewStructure } from './miller-slab'
  import type { BondDistanceRule, Site } from './index'
  import { BONDING_STRATEGIES, type BondingStrategy } from './bonding'
  import Bond from './Bond.svelte'
  import { Cylinder, Lattice } from './index'
  import CanvasTooltip from './CanvasTooltip.svelte'
  import { format_num } from '$lib/labels'

  let {
    cutting_slab_preview = null,
    cutting_show_bonds = true,
    bonding_strategy = 'max_dist' as BondingStrategy,
    bonding_options = {},
    bond_thickness = 0.15,
    bond_color = `#ffffff`,
    ambient_light = 0.5,
    directional_light = 0.5,
    element_radius_overrides = {} as Partial<Record<ElementSymbol, number>>,
    atom_radius = 1,
    sphere_segments = 32,
    bond_distance_rules = [] as BondDistanceRule[],
    float_fmt = `.3~f`,
    camera_is_moving = false,
  }: {
    cutting_slab_preview?: SlabPreviewStructure | null
    cutting_show_bonds?: boolean
    bonding_strategy?: BondingStrategy
    bonding_options?: Record<string, unknown>
    bond_thickness?: number
    bond_color?: string
    ambient_light?: number
    directional_light?: number
    element_radius_overrides?: Partial<Record<ElementSymbol, number>>
    atom_radius?: number
    sphere_segments?: number
    bond_distance_rules?: BondDistanceRule[]
    float_fmt?: string
    camera_is_moving?: boolean
  } = $props()

  // Hover state for preview atoms
  let hovered_site: Site | null = $state(null)

  // Selection state for measurement
  let selected_indices: number[] = $state([])

  function handle_atom_click(idx: number, event: any) {
    event.stopPropagation()
    if (selected_indices.includes(idx)) {
      selected_indices = selected_indices.filter(i => i !== idx)
    } else {
      selected_indices = [...selected_indices, idx]
    }
  }

  // Clear selection when preview structure changes
  $effect(() => {
    if (cutting_slab_preview) {
      const _len = cutting_slab_preview.structure.sites.length
    }
    selected_indices = []
  })

  // Step 1: Compute raw bonds (depends on structure + bonding strategy only)
  let raw_slab_bonds = $derived.by(() => {
    if (!cutting_slab_preview || !cutting_show_bonds) return []
    const preview_struct = cutting_slab_preview.structure
    if (!preview_struct?.sites || preview_struct.sites.length < 2) return []
    if (preview_struct.sites.length > 200) return []
    try {
      return BONDING_STRATEGIES[bonding_strategy](preview_struct, bonding_options)
    } catch (err) {
      console.error('[slab_preview_bonds] Error:', err)
      return []
    }
  })

  // Step 2: Apply bond distance rules via $effect (tracks deep prop mutations reliably)
  let slab_preview_bonds: ReturnType<typeof BONDING_STRATEGIES[keyof typeof BONDING_STRATEGIES]> = $state([])

  $effect(() => {
    const bonds = raw_slab_bonds
    const rules_json = JSON.stringify(bond_distance_rules)
    const rules: BondDistanceRule[] = JSON.parse(rules_json)
    if (!bonds.length || !rules.length) {
      slab_preview_bonds = bonds
      return
    }

    const preview_struct = cutting_slab_preview?.structure
    if (!preview_struct?.sites) {
      slab_preview_bonds = bonds
      return
    }

    const rule_map = new Map<string, { min: number; max: number }>()
    for (const r of rules) {
      rule_map.set([r.element_1, r.element_2].sort().join(`-`), { min: r.min_dist, max: r.max_dist })
    }

    slab_preview_bonds = bonds.filter((bond) => {
      const el1 = preview_struct.sites[bond.site_idx_1]?.species[0]?.element
      const el2 = preview_struct.sites[bond.site_idx_2]?.species[0]?.element
      if (el1 && el2) {
        const rule = rule_map.get([el1, el2].sort().join(`-`))
        if (rule && (bond.bond_length < rule.min || bond.bond_length > rule.max)) return false
      }
      return true
    })
  })

  // Convert slab preview bonds to instanced bond group format
  let slab_preview_bond_group = $derived.by(() => {
    if (!cutting_slab_preview || slab_preview_bonds.length === 0) return null
    const preview_sites = cutting_slab_preview.structure.sites

    const instances: { matrix: Float32Array; color_start: string; color_end: string }[] = []
    for (const bond_data of slab_preview_bonds) {
      // Skip bonds with invalid transform matrices
      if (
        !bond_data.transform_matrix ||
        bond_data.transform_matrix.some((val: number) => !Number.isFinite(val))
      ) {
        continue
      }

      const site_a = preview_sites[bond_data.site_idx_1]
      const site_b = preview_sites[bond_data.site_idx_2]
      if (!site_a || !site_b) continue

      const get_majority_color = (site: typeof site_a) => {
        if (!site?.species || site.species.length === 0) return bond_color
        const majority_species = site.species.reduce((max, spec) =>
          spec.occu > max.occu ? spec : max
        )
        return colors.element?.[majority_species.element] || bond_color
      }

      instances.push({
        matrix: bond_data.transform_matrix,
        color_start: get_majority_color(site_a),
        color_end: get_majority_color(site_b),
      })
    }

    if (instances.length === 0) return null

    return {
      thickness: bond_thickness,
      ambient_light,
      directional_light,
      instances,
    }
  })

  function get_atom_radius(site: Site): number {
    return site.species.reduce(
      (sum, spec) => sum + spec.occu * (element_radius_overrides?.[spec.element] ?? atomic_radii[spec.element] ?? 1),
      0,
    ) * atom_radius * 0.5
  }
</script>

{#if cutting_slab_preview}
  {@const preview_struct = cutting_slab_preview.structure}
  {@const preview_lattice = preview_struct.lattice.matrix}
  {@const preview_sites = preview_struct.sites}

  <!-- Slab cell with distinct styling -->
  <Lattice
    matrix={preview_lattice}
    cell_edge_color="#00ddff"
    cell_edge_opacity={1.0}
    cell_surface_opacity={0.05}
    cell_surface_color="#00ddff"
    cell_edge_width={2}
  />

  <!-- Slab atoms - interactive for hover and selection -->
  {#each preview_sites as site, idx (idx)}
    {@const element = site.species[0]?.element}
    {@const elem_color = colors.element?.[element] ?? '#888888'}
    {@const radius = get_atom_radius(site)}
    {@const is_selected = selected_indices.includes(idx)}
    <T.Mesh
      position={site.xyz}
      onpointerenter={() => { hovered_site = site }}
      onpointerleave={() => { if (hovered_site === site) hovered_site = null }}
      onclick={(e: any) => handle_atom_click(idx, e)}
    >
      <T.SphereGeometry args={[radius, sphere_segments, sphere_segments]} />
      <T.MeshMatcapMaterial color={elem_color} />
    </T.Mesh>
    <!-- Selection highlight wireframe (matches main scene style) -->
    {#if is_selected}
      <T.Mesh position={site.xyz} scale={1.3 * radius / 0.5} raycast={null}>
        <T.SphereGeometry args={[0.5, 16, 16]} />
        <T.MeshBasicMaterial color="#ffcc00" wireframe />
      </T.Mesh>
    {/if}
  {/each}

  <!-- Slab bonds (using same bonding strategy as main structure) -->
  {#if slab_preview_bond_group}
    <Bond group={slab_preview_bond_group} />
  {/if}

  <!-- Measurement lines between selected atoms -->
  {#if selected_indices.length >= 2}
    {#each selected_indices as idx_i, loop_idx}
      {#each selected_indices.slice(loop_idx + 1) as idx_j}
        {@const site_i = preview_sites[idx_i]}
        {@const site_j = preview_sites[idx_j]}
        {#if site_i && site_j}
          {@const pos_i = site_i.xyz}
          {@const pos_j = site_j.xyz}
          <Cylinder
            from={pos_i}
            to={pos_j}
            thickness={0.12}
            color="#ffcc00"
          />
          {@const midpoint = [
            (pos_i[0] + pos_j[0]) / 2,
            (pos_i[1] + pos_j[1]) / 2,
            (pos_i[2] + pos_j[2]) / 2,
          ] as Vec3}
          {@const dist = math.euclidean_dist(pos_i, pos_j)}
          <extras.HTML center position={midpoint}>
            <span class="measure-label">
              {format_num(dist, float_fmt)} Å
            </span>
          </extras.HTML>
        {/if}
      {/each}
    {/each}
  {/if}

  <!-- Atom hover tooltip -->
  {#if hovered_site?.xyz && hovered_site.species?.length && !camera_is_moving}
    {@const abc = hovered_site.abc?.map((x) => format_num(x, float_fmt)).join(`, `)}
    {@const xyz = hovered_site.xyz.map((x) => format_num(x, float_fmt)).join(`, `)}
    <CanvasTooltip position={hovered_site.xyz}>
      <div class="elements">
        {#each hovered_site.species as { element, occu, oxidation_state: oxi_state }, idx (idx)}
          {@const oxi_str = (oxi_state != null && oxi_state !== 0)
            ? `<sup>${Math.abs(oxi_state)}${oxi_state > 0 ? `+` : `−`}</sup>`
            : ``}
          {@const element_name = element_data.find((elem) => elem.symbol === element)?.name ?? ``}
          {#if idx > 0}&thinsp;{/if}
          {#if occu !== 1}<span class="occupancy">{format_num(occu, `.3~f`)}</span>{/if}
          <strong>{element}{@html oxi_str}</strong>
          {#if element_name}<span class="elem-name">{element_name}</span>{/if}
        {/each}
      </div>
      {#if abc}
        <div class="coordinates fractional">abc: ({abc})</div>
      {/if}
      <div class="coordinates cartesian">xyz: ({xyz}) Å</div>
    </CanvasTooltip>
  {/if}

  <!-- Surface plane indicator (more visible) -->
  {@const min_z = cutting_slab_preview.bounds.min_z}
  {@const cell_a = preview_lattice[0]}
  {@const cell_b = preview_lattice[1]}
  {@const plane_center = [(cell_a[0] + cell_b[0]) / 2, (cell_a[1] + cell_b[1]) / 2, min_z] as [number, number, number]}
  {@const plane_size_a = Math.hypot(cell_a[0], cell_a[1], cell_a[2]) * 1.1}
  {@const plane_size_b = Math.hypot(cell_b[0], cell_b[1], cell_b[2]) * 1.1}
  <T.Mesh position={plane_center} raycast={null}>
    <T.PlaneGeometry args={[plane_size_a, plane_size_b]} />
    <T.MeshBasicMaterial color="#ffcc00" transparent opacity={0.35} side={2} />
  </T.Mesh>
{/if}

<style>
  .elements {
    margin-bottom: var(--canvas-tooltip-elements-margin, 0);
  }
  .occupancy {
    font-size: var(--canvas-tooltip-occupancy-font-size, 0.8em);
    opacity: var(--canvas-tooltip-occupancy-opacity, 0.7);
    margin-right: var(--canvas-tooltip-occupancy-margin-right, 0.15em);
  }
  .elem-name {
    font-size: 0.85em;
    opacity: 0.7;
    margin-left: 0.3em;
  }
  .coordinates {
    margin-top: var(--canvas-tooltip-coordinates-margin, 0);
    font-size: var(--canvas-tooltip-coordinates-font-size, 0.9em);
  }
  .measure-label {
    background: rgba(0, 0, 0, 0.75);
    color: #ffcc00;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: clamp(8pt, 3cqmin, 14pt);
    font-weight: 600;
    white-space: nowrap;
    pointer-events: none;
  }
</style>

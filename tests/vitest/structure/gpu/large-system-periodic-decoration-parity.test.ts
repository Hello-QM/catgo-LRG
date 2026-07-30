import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AnyStructure, PymatgenStructure } from '$lib/structure'
import { parse_cif } from '$lib/structure/parsers/cif'
import { get_pbc_image_sites } from '$lib/structure/pbc'
import {
  build_sites_to_draw,
  image_sites_to_instance_table,
  merge_image_instances_into_sites_to_draw,
} from '$lib/structure/pbc-image-atoms'
import {
  build_periodic_decoration_snapshot,
  build_periodic_image_centers,
  BOUNDARY_BOND_MODE,
  displayed_image_atoms_to_instance_table,
  expand_ordinary_image_table,
  type PeriodicDecorationSource,
} from '$lib/structure/scene/periodic-decoration-snapshot'
import { create_render_packet_builder } from '$lib/structure/scene/render-packet-builder'
import type { ImageInstanceTable } from '$lib/structure/scene/render-packet'

type Vec3 = readonly [number, number, number]

const DIMS = [1, 1, 1] as const
const LATTICE = [
  [4.2, 0.3, 0.1],
  [1.1, 3.7, 0.4],
  [0.2, 1.2, 5.1],
] as const

function cartesian(abc: Vec3): [number, number, number] {
  return [
    abc[0] * LATTICE[0][0] + abc[1] * LATTICE[1][0] + abc[2] * LATTICE[2][0],
    abc[0] * LATTICE[0][1] + abc[1] * LATTICE[1][1] + abc[2] * LATTICE[2][1],
    abc[0] * LATTICE[0][2] + abc[1] * LATTICE[1][2] + abc[2] * LATTICE[2][2],
  ]
}

function make_structure(): AnyStructure {
  const fractional: Vec3[] = [
    [0, 0.25, 0.25], // +x face image (A side of the cross-cell bond)
    [1, 0.35, 0.25], // -x face image (B side of the cross-cell bond)
    [0.25, 0, 0], // +y, +z, and +y+z edge images
    [0.35, 0, 0], // matching edge images complete the decorators
    [0.98, 0.98, 0.98], // seven -face/-edge/-corner images
    [1, 1, 1], // matching corner images complete the decorators
  ]
  return {
    sites: fractional.map((abc) => ({
      species: [{ element: `C`, occu: 1 }],
      abc: [...abc],
      xyz: cartesian(abc),
      properties: {},
    })),
    lattice: {
      matrix: LATTICE.map((row) => [...row]),
      pbc: [true, true, true],
      a: Math.hypot(...LATTICE[0]),
      b: Math.hypot(...LATTICE[1]),
      c: Math.hypot(...LATTICE[2]),
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: 1,
    },
  } as unknown as AnyStructure
}

function append_displayed_images(
  structure: AnyStructure,
  table: ImageInstanceTable,
): AnyStructure & {
  num_original_sites: number
  image_to_original_map: number[]
} {
  const num_original_sites = structure.sites.length
  const image_to_original_map = Array.from(table.base_sites)
  const appended = Array.from({ length: table.count }, (_, image_idx) => {
    const base_site = table.base_sites[image_idx]
    const base = structure.sites[base_site]
    const offset = image_idx * 3
    const abc: [number, number, number] = [
      base.abc[0] + table.jimages[offset],
      base.abc[1] + table.jimages[offset + 1],
      base.abc[2] + table.jimages[offset + 2],
    ]
    // The real PBC generator nudges boundary coordinates by a tiny epsilon.
    // Exercise rounded fractional-delta recovery on one displayed row.
    if (image_idx === 0) abc[0] -= 1e-9
    return {
      ...base,
      abc,
      xyz: cartesian(abc),
      properties: { ...base.properties, orig_site_idx: base_site },
    }
  })
  return {
    ...structure,
    sites: [...structure.sites, ...appended],
    num_original_sites,
    image_to_original_map,
  } as unknown as AnyStructure & {
    num_original_sites: number
    image_to_original_map: number[]
  }
}

function image_keys(table: ImageInstanceTable): string[] {
  const keys: string[] = []
  for (let idx = 0; idx < table.count; idx++) {
    const offset = idx * 3
    keys.push(
      `${table.base_sites[idx]}@${table.jimages[offset]},` +
        `${table.jimages[offset + 1]},${table.jimages[offset + 2]}`,
    )
  }
  return keys.sort()
}

function point_key(point: ArrayLike<number>, offset: number): string {
  const fixed = (value: number) =>
    (Math.abs(value) < 0.5e-5 ? 0 : value).toFixed(5)
  return `${fixed(point[offset])},${fixed(point[offset + 1])},` +
    `${fixed(point[offset + 2])}`
}

function center_keys(centers: Float32Array): string[] {
  const keys: string[] = []
  for (let offset = 0; offset < centers.length; offset += 3) {
    keys.push(point_key(centers, offset))
  }
  return keys.sort()
}

function segment_key(a: ArrayLike<number>, b: ArrayLike<number>): string {
  const a_key = point_key(a, 0)
  const b_key = point_key(b, 0)
  return a_key < b_key ? `${a_key}|${b_key}` : `${b_key}|${a_key}`
}

function ordinary_segment_keys(
  snapshot: ReturnType<typeof build_periodic_decoration_snapshot>,
): string[] {
  const { boundary_segments: segments } = snapshot
  const keys = new Set<string>()
  for (let idx = 0; idx < segments.count; idx++) {
    if (segments.modes[idx] === BOUNDARY_BOND_MODE.HIDDEN) continue
    const offset = idx * 3
    const start = segments.draw_starts.subarray(offset, offset + 3)
    const end = segments.draw_ends.subarray(offset, offset + 3)
    if (point_key(start, 0) !== point_key(end, 0)) {
      keys.add(segment_key(start, end))
    }
  }
  return [...keys].sort()
}

describe(`ordinary vs large-system periodic decoration parity`, () => {
  it(`publishes the real LiFePO4 final 19/19 boundary set`, () => {
    const structure = parse_cif(
      readFileSync(resolve(`src/site/structures/LiFePO4.cif`), `utf8`),
    ) as PymatgenStructure
    const displayed = get_pbc_image_sites(structure, false)
    const atom_images = displayed_image_atoms_to_instance_table(
      displayed.sites,
      displayed.num_original_sites,
      displayed.image_to_original_map,
    )
    const sites_to_draw = build_sites_to_draw(structure, [], {
      draw_image_atoms: true,
      bonded_sites_outside_unit_cell: false,
      edge_tolerance: 0.05,
    })
    const raw_decoration_images = image_sites_to_instance_table(
      sites_to_draw.values(),
      DIMS,
    )

    expect(structure.sites).toHaveLength(28)
    expect(atom_images.count).toBe(19)
    expect(raw_decoration_images.count).toBe(16)
    expect(image_keys(atom_images)).toEqual(expect.arrayContaining(
      image_keys(raw_decoration_images),
    ))
    // Ordinary appended atoms include these mixed-sign edge/corner images;
    // ordinary sites_to_draw deliberately does not. Large mode must therefore
    // preserve the two streams independently instead of dropping the spheres
    // or inventing extra decorator bonds.
    expect(
      image_keys(atom_images).filter(
        (key) => !new Set(image_keys(raw_decoration_images)).has(key),
      ),
    ).toEqual([
      `4@-1,1,-1`,
      `4@-1,1,0`,
      `4@0,1,-1`,
    ])
    const final_decoration_images = image_sites_to_instance_table(
      merge_image_instances_into_sites_to_draw(
        sites_to_draw,
        atom_images,
      ).values(),
      DIMS,
    )
    // Both renderers consume this same final ordinary boundary contract.
    expect(final_decoration_images.count).toBe(19)
    expect(image_keys(final_decoration_images)).toEqual(image_keys(atom_images))
    const expanded_atoms = expand_ordinary_image_table(
      atom_images,
      [3, 3, 3],
    )
    const expanded_decorators = expand_ordinary_image_table(
      final_decoration_images,
      [3, 3, 3],
    )
    expect(image_keys(expanded_decorators)).toEqual(image_keys(expanded_atoms))
    expect(image_keys(expanded_atoms)).toEqual(expect.arrayContaining([
      `4@-1,3,-1`,
      `4@-1,3,0`,
      `4@-1,3,1`,
      `4@-1,3,2`,
      `4@0,3,-1`,
      `4@1,3,-1`,
      `4@2,3,-1`,
    ]))
    // The raw 16-row set is retained only as fixture sanity.
    expect(raw_decoration_images.count).toBe(16)
    expect(atom_images.count).toBe(19)
  })

  it(`retains face, edge, corner, and both directed boundary sides`, () => {
    const structure = make_structure()
    const connectivity = [
      { site_idx_1: 0, site_idx_2: 1, jimage: [-1, 0, 0] as const },
      { site_idx_1: 2, site_idx_2: 3, jimage: [0, 0, 0] as const },
      { site_idx_1: 4, site_idx_2: 5, jimage: [0, 0, 0] as const },
    ]
    const packet = create_render_packet_builder().build({
      structure,
      bond_connectivity: connectivity,
      dims: DIMS,
      boundary_policy: `ghost-images`,
    })
    const graph = packet.topology.bond_graph
    expect(graph).toBeDefined()

    // Ordinary bond decorators are selected by sites_to_draw.
    const sites_to_draw = build_sites_to_draw(structure, connectivity, {
      draw_image_atoms: true,
      bonded_sites_outside_unit_cell: false,
      edge_tolerance: 0.05,
    })
    const raw_decoration_images = image_sites_to_instance_table(
      sites_to_draw.values(),
      DIMS,
    )
    // Ordinary atoms are rendered from the independently appended rows on
    // displayed_structure. Recover that ACTUAL table through the production
    // bridge, including its boundary epsilon.
    const displayed = append_displayed_images(structure, raw_decoration_images)
    const atom_images = displayed_image_atoms_to_instance_table(
      displayed.sites,
      displayed.num_original_sites,
      displayed.image_to_original_map,
    )
    const decoration_images = image_sites_to_instance_table(
      merge_image_instances_into_sites_to_draw(
        sites_to_draw,
        atom_images,
      ).values(),
      DIMS,
    )
    const source: PeriodicDecorationSource = {
      graph: graph!,
      owner_id: 1,
      atom_count: structure.sites.length,
      atom_images,
      images: decoration_images,
    }
    const ordinary = build_periodic_decoration_snapshot({
      graph: graph!,
      frame: packet.frame,
      images: decoration_images,
      dims: DIMS,
      policy: `ghost-images`,
    })

    // Fixture sanity: both directed ±x sides plus face/edge/corner ownership
    // reach the aligned atom/decorator bridge lanes.
    expect(atom_images).not.toBe(decoration_images)
    expect(atom_images.count).toBe(22)
    expect(decoration_images.count).toBe(22)
    expect(image_keys(atom_images)).toEqual(expect.arrayContaining([
      `0@1,0,0`,
      `1@-1,0,0`,
      `2@0,1,0`,
      `2@0,1,1`,
      `4@-1,-1,-1`,
    ]))
    expect(image_keys(source.atom_images)).toEqual(image_keys(atom_images))
    expect(image_keys(source.images)).toEqual(image_keys(decoration_images))
    expect(ordinary.boundary_segments.count).toBe(22)
    expect(ordinary.boundary_segments.visible_count).toBe(22)

    // The large-system data bridge now receives the exact ordinary atom lane
    // and exact decorator lane instead of rebuilding either from the graph.
    const bridged_atom_centers = build_periodic_image_centers(
      source.atom_images,
      packet.frame.positions,
      packet.frame.lattice,
    )
    const bridged_decorators = build_periodic_decoration_snapshot({
      graph: source.graph,
      frame: packet.frame,
      images: source.images,
      dims: packet.replicas.dims,
      policy: packet.replicas.boundary_policy,
    })

    const ordinary_atom_centers = displayed.sites
      .slice(displayed.num_original_sites)
      .map((site) => point_key(site.xyz, 0))
      .sort()
    expect(center_keys(bridged_atom_centers)).toEqual(ordinary_atom_centers)
    expect(ordinary_segment_keys(bridged_decorators)).toEqual(
      ordinary_segment_keys(ordinary),
    )
  })
})

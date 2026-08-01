import type { PymatgenStructure } from '$lib/structure'
import {
  build_physical_supercell_render_source,
  map_physical_periodic_decoration_to_base,
  physical_supercell_render_source_for,
  register_physical_supercell_render_source,
} from '$lib/structure/scene/physical-supercell-render-source'
import type { PeriodicDecorationSource } from '$lib/structure/scene/periodic-decoration-snapshot'
import { build_periodic_decoration_snapshot } from '$lib/structure/scene/periodic-decoration-snapshot'
import {
  execute_supercell_op_sync,
  type IntMatrix3,
} from '$lib/structure/supercell-operation'
import { describe, expect, test } from 'vitest'

function structure(): PymatgenStructure {
  return {
    lattice: {
      matrix: [[4, 0, 0], [0, 5, 0], [0, 0, 6]],
      pbc: [true, true, true],
      volume: 120,
      a: 4,
      b: 5,
      c: 6,
      alpha: 90,
      beta: 90,
      gamma: 90,
    },
    sites: [
      {
        species: [{ element: `Na`, occu: 1 }],
        abc: [0, 0, 0],
        xyz: [0, 0, 0],
        label: `Na`,
        properties: {},
      },
      {
        species: [{ element: `Cl`, occu: 1 }],
        abc: [0.5, 0.5, 0.5],
        xyz: [2, 2.5, 3],
        label: `Cl`,
        properties: {},
      },
    ],
    charge: 0,
  }
}

function execute(matrix: IntMatrix3) {
  return execute_supercell_op_sync(structure(), {
    kind: `supercell`,
    matrix,
    reorient: true,
  })
}

function segment_keys(
  snapshot: ReturnType<typeof build_periodic_decoration_snapshot>,
): string[] {
  const keys: string[] = []
  const fixed = (value: number) =>
    (Math.abs(value) < 0.5e-5 ? 0 : value).toFixed(5)
  for (let idx = 0; idx < snapshot.boundary_segments.count; idx++) {
    const offset = idx * 3
    const start = Array.from(
      snapshot.boundary_segments.draw_starts.subarray(offset, offset + 3),
      fixed,
    ).join(`,`)
    const end = Array.from(
      snapshot.boundary_segments.draw_ends.subarray(offset, offset + 3),
      fixed,
    ).join(`,`)
    if (start === end) continue
    keys.push(start < end ? `${start}|${end}` : `${end}|${start}`)
  }
  return keys.sort()
}

describe(`physical true-supercell render source`, () => {
  test(`recovers the reoriented base cell and reorders ids to GPU x-fast order`, () => {
    const execution = execute([[2, 0, 0], [0, 2, 0], [0, 0, 1]])
    const source = build_physical_supercell_render_source(execution)

    expect(source).not.toBeNull()
    expect(source!.dims).toEqual([2, 2, 1])
    expect(source!.base_structure.sites).toHaveLength(2)
    expect(source!.base_structure.lattice.a).toBeCloseTo(4)
    expect(source!.base_structure.lattice.b).toBeCloseTo(5)
    expect(source!.base_structure.lattice.c).toBeCloseTo(6)
    // Executor cell order is y-fastest; ReplicaLayout is x-fastest.
    expect([...source!.physical_site_map]).toEqual([0, 1, 4, 5, 2, 3, 6, 7])

    const [a, b, c] = source!.base_structure.lattice.matrix
    const [nx, ny] = source!.dims
    for (let cell_index = 0; cell_index < 4; cell_index++) {
      const ix = cell_index % nx
      const iy = Math.floor(cell_index / nx) % ny
      const iz = Math.floor(cell_index / (nx * ny))
      for (let base_site = 0; base_site < 2; base_site++) {
        const rendered = source!.base_structure.sites[base_site].xyz.map(
          (value, axis) =>
            value + ix * a[axis] + iy * b[axis] + iz * c[axis],
        )
        const physical =
          execution.structure.sites[source!.physical_site_map[cell_index * 2 + base_site]].xyz
        expect(rendered[0]).toBeCloseTo(physical[0], 8)
        expect(rendered[1]).toBeCloseTo(physical[1], 8)
        expect(rendered[2]).toBeCloseTo(physical[2], 8)
      }
    }
  })

  test(`falls back for a general shear that ReplicaLayout cannot represent`, () => {
    const execution = execute([[1, 1, 0], [-1, 1, 0], [0, 0, 1]])
    expect(build_physical_supercell_render_source(execution)).toBeNull()
  })

  test(`maps materialized ordinary boundary atoms and bonds onto base replicas`, () => {
    const execution = execute([[2, 0, 0], [0, 2, 0], [0, 0, 1]])
    const render_source = build_physical_supercell_render_source(execution)!
    const boundary = {
      count: 2,
      base_sites: Uint32Array.from([4, 0]),
      jimages: Int8Array.from([
        1, 0, 0,
        -1, 0, 0,
      ]),
    }
    const ordinary_source: PeriodicDecorationSource = {
      owner_id: 7,
      atom_count: execution.structure.sites.length,
      graph: {
        version: 3,
        pairs: Uint32Array.from([
          0, 1,
          4, 5,
          1, 4,
          5, 0,
        ]),
        jimages: Int8Array.from([
          0, 0, 0,
          0, 0, 0,
          0, 0, 0,
          1, 0, 0,
        ]),
        kinds: Uint8Array.from([0, 0, 0, 0]),
        strengths: Float32Array.from([1, 1, 1, 1]),
      },
      atom_images: boundary,
      images: boundary,
    }

    const mapped = map_physical_periodic_decoration_to_base(
      ordinary_source,
      render_source.physical_site_map,
      render_source.dims,
      render_source.base_structure.sites.length,
    )

    expect(mapped).not.toBeNull()
    expect([...mapped!.graph.pairs]).toEqual([0, 1, 0, 1])
    expect([...mapped!.graph.jimages]).toEqual([
      0, 0, 0,
      -1, 0, 0,
    ])
    expect([...mapped!.atom_images.base_sites]).toEqual([0, 0])
    expect([...mapped!.atom_images.jimages]).toEqual([
      3, 0, 0,
      -2, 0, 0,
    ])
    expect(mapped!.images).toStrictEqual(mapped!.atom_images)

    // The representation changes, but the two image centers do not.
    const base_lattice = render_source.base_structure.lattice.matrix
    for (let idx = 0; idx < boundary.count; idx++) {
      const physical_site = boundary.base_sites[idx]
      const ordinary_xyz = execution.structure.sites[physical_site].xyz.map(
        (value, axis) =>
          value +
          boundary.jimages[idx * 3] *
            execution.structure.lattice.matrix[0][axis] +
          boundary.jimages[idx * 3 + 1] *
            execution.structure.lattice.matrix[1][axis] +
          boundary.jimages[idx * 3 + 2] *
            execution.structure.lattice.matrix[2][axis],
      )
      const base_site = mapped!.atom_images.base_sites[idx]
      const mapped_xyz = render_source.base_structure.sites[base_site].xyz.map(
        (value, axis) =>
          value +
          mapped!.atom_images.jimages[idx * 3] * base_lattice[0][axis] +
          mapped!.atom_images.jimages[idx * 3 + 1] * base_lattice[1][axis] +
          mapped!.atom_images.jimages[idx * 3 + 2] * base_lattice[2][axis],
      )
      expect(mapped_xyz[0]).toBeCloseTo(ordinary_xyz[0], 8)
      expect(mapped_xyz[1]).toBeCloseTo(ordinary_xyz[1], 8)
      expect(mapped_xyz[2]).toBeCloseTo(ordinary_xyz[2], 8)
    }

    const ordinary_snapshot = build_periodic_decoration_snapshot({
      graph: ordinary_source.graph,
      frame: {
        owner: execution.structure,
        frame_idx: -1,
        positions_version: 1,
        positions: Float32Array.from(
          execution.structure.sites.flatMap((site) => site.xyz),
        ),
        lattice: Float32Array.from(execution.structure.lattice.matrix.flat()),
      },
      images: ordinary_source.images,
      dims: [1, 1, 1],
      policy: `ghost-images`,
    })
    const mapped_snapshot = build_periodic_decoration_snapshot({
      graph: mapped!.graph,
      frame: {
        owner: render_source.base_structure,
        frame_idx: -1,
        positions_version: 1,
        positions: Float32Array.from(
          render_source.base_structure.sites.flatMap((site) => site.xyz),
        ),
        lattice: Float32Array.from(base_lattice.flat()),
      },
      images: mapped!.images,
      dims: render_source.dims,
      policy: `ghost-images`,
    })
    expect(segment_keys(mapped_snapshot)).toEqual(
      segment_keys(ordinary_snapshot),
    )
  })

  test(`keeps render-only provenance out of the exported structure object`, () => {
    const execution = execute([[2, 0, 0], [0, 1, 0], [0, 0, 1]])
    const source = build_physical_supercell_render_source(execution)!

    register_physical_supercell_render_source(execution.structure, source)
    expect(physical_supercell_render_source_for(execution.structure)).toBe(source)
    expect(Object.keys(execution.structure)).not.toContain(`supercell_provenance`)
  })
})

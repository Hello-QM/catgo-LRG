import { describe, expect, test } from 'vitest'
import {
  BOUNDARY_BOND_ANCHOR,
  BOUNDARY_BOND_MODE,
  build_boundary_bond_endpoint_layout,
  build_periodic_decoration_snapshot,
  build_periodic_image_centers,
  expand_ordinary_image_table,
} from '$lib/structure/scene/periodic-decoration-snapshot'
import type {
  BaseBondGraph,
  FrameGeometry,
  ImageInstanceTable,
} from '$lib/structure/scene/render-packet'

function graph(
  pairs: number[],
  jimages: number[],
): BaseBondGraph {
  const count = pairs.length / 2
  return {
    version: 7,
    pairs: Uint32Array.from(pairs),
    jimages: Int8Array.from(jimages),
    kinds: new Uint8Array(count),
    strengths: new Float32Array(count).fill(1),
  }
}

function images(
  entries: Array<readonly [number, number, number, number]>,
): ImageInstanceTable {
  return {
    count: entries.length,
    base_sites: Uint32Array.from(entries.map((entry) => entry[0])),
    jimages: Int8Array.from(entries.flatMap((entry) => entry.slice(1))),
  }
}

const CUBIC_10 = Float32Array.from([
  10, 0, 0,
  0, 10, 0,
  0, 0, 10,
])

describe(`ordinary periodic image centers`, () => {
  test(`uses the current row-major skew lattice for face, edge, and corner images`, () => {
    const table = images([
      [0, 1, 0, 0],
      [0, 1, 1, 0],
      [0, 1, 1, 1],
    ])
    const positions = Float32Array.from([0.25, 0.5, 0.75])
    // a=(4,0,0), b=(1,3,0), c=(0.5,0.25,5)
    const lattice = Float32Array.from([
      4, 0, 0,
      1, 3, 0,
      0.5, 0.25, 5,
    ])

    expect([...build_periodic_image_centers(table, positions, lattice)]).toEqual([
      4.25, 0.5, 0.75,
      5.25, 3.5, 0.75,
      5.75, 3.75, 5.75,
    ])
  })

  test(`moves 1x face/edge images to the outer surface of visual replicas`, () => {
    const source = images([
      [0, 1, 0, 0],
      [1, 1, -1, 0],
    ])
    const expanded = expand_ordinary_image_table(source, [2, 3, 1])

    expect([...expanded.base_sites]).toEqual([
      0, 0, 0,
      1,
    ])
    expect([...expanded.jimages]).toEqual([
      2, 0, 0,
      2, 1, 0,
      2, 2, 0,
      2, -1, 0,
    ])
    // The ordinary 1× stream remains identity-stable.
    expect(expand_ordinary_image_table(source, [1, 1, 1])).toBe(source)
  })
})

describe(`ordinary boundary bond endpoint layout`, () => {
  test(`reproduces A- and B-anchor cell arithmetic on both periodic sides`, () => {
    // A0=9 and B0=1 with B jimage +1: the physical bond is length 2 across x.
    const layout = build_boundary_bond_endpoint_layout(
      graph([0, 1], [1, 0, 0]),
      images([
        [0, -1, 0, 0],
        [1, 1, 0, 0],
      ]),
      Float32Array.from([9, 0, 0, 1, 0, 0]),
      CUBIC_10,
      { policy: `ghost-images` },
    )

    expect(layout.count).toBe(2)
    expect(layout.visible_count).toBe(2)
    expect([...layout.anchor_sides]).toEqual([
      BOUNDARY_BOND_ANCHOR.A,
      BOUNDARY_BOND_ANCHOR.B,
    ])
    expect([...layout.modes]).toEqual([
      BOUNDARY_BOND_MODE.FULL,
      BOUNDARY_BOND_MODE.FULL,
    ])
    expect([...layout.a_cells]).toEqual([-1, 0, 0, 0, 0, 0])
    expect([...layout.b_cells]).toEqual([0, 0, 0, 1, 0, 0])
    expect([...layout.a_positions]).toEqual([-1, 0, 0, 9, 0, 0])
    expect([...layout.b_positions]).toEqual([1, 0, 0, 11, 0, 0])
    expect([...layout.draw_starts]).toEqual([-1, 0, 0, 9, 0, 0])
    expect([...layout.draw_ends]).toEqual([1, 0, 0, 11, 0, 0])
  })

  test(`keeps one full decorator per image anchor when both image partners exist`, () => {
    const layout = build_boundary_bond_endpoint_layout(
      graph([0, 1], [0, 0, 0]),
      images([
        [0, 1, 0, 0],
        [1, 1, 0, 0],
      ]),
      Float32Array.from([0, 0, 0, 2, 0, 0]),
      CUBIC_10,
    )

    // Ordinary build_image_atom_layout does not deduplicate this overlap:
    // each image atom owns one decorator for the same graph slot.
    expect(layout.count).toBe(2)
    expect([...layout.bond_indices]).toEqual([0, 0])
    expect([...layout.image_indices]).toEqual([0, 1])
    expect([...layout.modes]).toEqual([
      BOUNDARY_BOND_MODE.FULL,
      BOUNDARY_BOND_MODE.FULL,
    ])
    expect([...layout.draw_starts]).toEqual([10, 0, 0, 10, 0, 0])
    expect([...layout.draw_ends]).toEqual([12, 0, 0, 12, 0, 0])
  })

  test(`draws missing A- and B-anchor partners as ordinary half-length-scaled stubs`, () => {
    const layout = build_boundary_bond_endpoint_layout(
      graph([0, 1], [0, 0, 0]),
      images([
        [0, 1, 0, 0],
        [1, -1, 0, 0],
      ]),
      Float32Array.from([0, 0, 0, 2, 0, 0]),
      CUBIC_10,
      { policy: `stub`, stub_scale: 0.5 },
    )

    expect([...layout.anchor_sides]).toEqual([
      BOUNDARY_BOND_ANCHOR.A,
      BOUNDARY_BOND_ANCHOR.B,
    ])
    expect([...layout.modes]).toEqual([
      BOUNDARY_BOND_MODE.STUB,
      BOUNDARY_BOND_MODE.STUB,
    ])
    // Full bond length=2, ordinary stub length=(length/2)*0.5=0.5.
    expect([...layout.draw_starts]).toEqual([10, 0, 0, -8, 0, 0])
    expect([...layout.draw_ends]).toEqual([10.5, 0, 0, -8.5, 0, 0])
  })

  test(`retains but collapses missing-partner rows under hide`, () => {
    const layout = build_boundary_bond_endpoint_layout(
      graph([0, 1], [0, 0, 0]),
      images([[0, 1, 0, 0]]),
      Float32Array.from([0, 0, 0, 2, 0, 0]),
      CUBIC_10,
      { policy: `hide` },
    )

    expect(layout.count).toBe(1)
    expect(layout.visible_count).toBe(0)
    expect([...layout.modes]).toEqual([BOUNDARY_BOND_MODE.HIDDEN])
    expect([...layout.draw_starts]).toEqual([10, 0, 0])
    expect([...layout.draw_ends]).toEqual([10, 0, 0])
  })

  test(`treats graph self-images as A-anchored exactly once`, () => {
    const layout = build_boundary_bond_endpoint_layout(
      graph([0, 0], [1, 0, 0]),
      images([[0, -1, 0, 0]]),
      Float32Array.from([9, 0, 0]),
      CUBIC_10,
    )

    expect(layout.count).toBe(1)
    expect([...layout.anchor_sides]).toEqual([BOUNDARY_BOND_ANCHOR.A])
    expect([...layout.a_cells]).toEqual([-1, 0, 0])
    expect([...layout.b_cells]).toEqual([0, 0, 0])
    expect([...layout.modes]).toEqual([BOUNDARY_BOND_MODE.FULL])
    expect([...layout.draw_starts]).toEqual([-1, 0, 0])
    expect([...layout.draw_ends]).toEqual([9, 0, 0])
  })

  test(`uses real cells inside dims as drawn partners`, () => {
    const layout = build_boundary_bond_endpoint_layout(
      graph([0, 1], [1, 0, 0]),
      images([[0, -1, 1, 0]]),
      Float32Array.from([9, 0, 0, 1, 0, 0]),
      CUBIC_10,
      { dims: [2, 2, 1], policy: `hide` },
    )

    // A@[-1,1,0] anchors B@[0,1,0], a real replica cell, so hide must not
    // suppress it. This also exercises an edge image with a transverse cell.
    expect([...layout.modes]).toEqual([BOUNDARY_BOND_MODE.FULL])
    expect([...layout.a_cells]).toEqual([-1, 1, 0])
    expect([...layout.b_cells]).toEqual([0, 1, 0])
  })
})

describe(`ordinary periodic decoration snapshot`, () => {
  test(`keeps authoritative graph/frame/image identities and bundles derived layout`, () => {
    const authoritative_graph = graph([0, 1], [1, 0, 0])
    const authoritative_images = images([
      [0, -1, 0, 0],
      [1, 1, 0, 0],
    ])
    const frame: FrameGeometry = {
      owner: {},
      frame_idx: 12,
      positions_version: 34,
      positions: Float32Array.from([9, 0, 0, 1, 0, 0]),
      lattice: CUBIC_10,
    }

    const snapshot = build_periodic_decoration_snapshot({
      graph: authoritative_graph,
      frame,
      images: authoritative_images,
      policy: `ghost-images`,
    })

    expect(snapshot.graph).toBe(authoritative_graph)
    expect(snapshot.frame).toBe(frame)
    expect(snapshot.images).toBe(authoritative_images)
    expect(snapshot.dims).toEqual([1, 1, 1])
    expect([...snapshot.image_centers]).toEqual([-1, 0, 0, 11, 0, 0])
    expect(snapshot.boundary_segments.count).toBe(2)
    expect([...snapshot.boundary_segments.modes]).toEqual([
      BOUNDARY_BOND_MODE.FULL,
      BOUNDARY_BOND_MODE.FULL,
    ])
  })
})

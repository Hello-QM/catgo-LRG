import { describe, expect, it } from 'vitest'
import { build_bond_adjacency, compute_polyhedra_from_bonds } from '$lib/structure/polyhedra'
import type { AnyStructure, BondPair, Site, Vec3 } from '$lib/structure'

function bond(
  i: number,
  j: number,
  pos_i: Vec3,
  pos_j: Vec3,
  jimage: [number, number, number] = [0, 0, 0],
): BondPair {
  const len = Math.hypot(pos_j[0] - pos_i[0], pos_j[1] - pos_i[1], pos_j[2] - pos_i[2])
  return {
    pos_1: pos_i,
    pos_2: pos_j,
    site_idx_1: i,
    site_idx_2: j,
    bond_length: len,
    strength: 1,
    transform_matrix: new Float32Array(16),
    jimage,
  } as BondPair
}

describe(`build_bond_adjacency`, () => {
  it(`links both directions with neighbour positions from bond endpoints`, () => {
    const bonds = [
      bond(0, 1, [0, 0, 0], [2, 0, 0]),
      bond(0, 2, [0, 0, 0], [0, 2, 0]),
    ]
    const adj = build_bond_adjacency(bonds)
    expect(adj.get(0)?.map((n) => n.idx).sort()).toEqual([1, 2])
    expect(adj.get(1)?.[0]).toEqual({ idx: 0, pos: [0, 0, 0] })
    expect(adj.get(0)?.find((n) => n.idx === 1)?.pos).toEqual([2, 0, 0])
  })

  it(`skips self-bonds`, () => {
    const adj = build_bond_adjacency([bond(0, 0, [0, 0, 0], [0, 0, 0])])
    expect(adj.get(0)).toBeUndefined()
  })
})

function site(element: string, xyz: Vec3): Site {
  return {
    species: [{ element, occu: 1, oxidation_state: 0 }],
    xyz,
    abc: xyz,
    label: element,
    properties: {},
  } as unknown as Site
}

function struct(sites: Site[]): AnyStructure {
  return { sites } as unknown as AnyStructure
}

// Ti at origin (idx 0) octahedrally coordinated by 6 O at ±2 Å (idx 1..6)
const OCTA_OFFSETS: Vec3[] = [
  [2, 0, 0], [-2, 0, 0], [0, 2, 0], [0, -2, 0], [0, 0, 2], [0, 0, -2],
]
function octahedron_sites(): Site[] {
  return [site(`Ti`, [0, 0, 0]), ...OCTA_OFFSETS.map((o) => site(`O`, o))]
}
function octahedron_bonds(): BondPair[] {
  return OCTA_OFFSETS.map((o, k) => bond(0, k + 1, [0, 0, 0], o))
}

describe(`compute_polyhedra_from_bonds — core`, () => {
  it(`forms one CN-6 octahedron around a metal center`, () => {
    const polys = compute_polyhedra_from_bonds(
      struct(octahedron_sites()),
      octahedron_bonds(),
    )
    expect(polys).toHaveLength(1)
    expect(polys[0].center_element).toBe(`Ti`)
    expect(polys[0].center_idx).toBe(0)
    expect(polys[0].neighbor_indices).toHaveLength(6)
  })

  it(`keeps the polyhedron when one neighbour is non-anion (per-vertex, not per-poly veto)`, () => {
    // add a 7th neighbour Na (idx 7) bonded to Ti — non-anion, dropped per-vertex
    const sites = [...octahedron_sites(), site(`Na`, [3, 0, 0])]
    const bonds = [...octahedron_bonds(), bond(0, 7, [0, 0, 0], [3, 0, 0])]
    const polys = compute_polyhedra_from_bonds(struct(sites), bonds)
    expect(polys).toHaveLength(1)
    expect(polys[0].neighbor_indices).toHaveLength(6) // Na excluded, 6 O kept
  })

  it(`drops centers below min_coordination`, () => {
    const sites = [site(`Ti`, [0, 0, 0]), site(`O`, [2, 0, 0]), site(`O`, [0, 2, 0])]
    const bonds = [bond(0, 1, [0, 0, 0], [2, 0, 0]), bond(0, 2, [0, 0, 0], [0, 2, 0])]
    expect(compute_polyhedra_from_bonds(struct(sites), bonds)).toHaveLength(0) // CN 2 < 4
  })

  it(`closes across PBC using image positions carried on the bond`, () => {
    // Ti at a corner; 6 O reached only via image bonds (pos_2 already image-shifted)
    const polys = compute_polyhedra_from_bonds(
      struct(octahedron_sites()),
      OCTA_OFFSETS.map((o, k) => bond(0, k + 1, [0, 0, 0], o, [1, 0, 0])),
    )
    expect(polys[0].neighbor_indices).toHaveLength(6)
  })
})

describe(`compute_polyhedra_from_bonds — distance trim`, () => {
  it(`trims an over-long 7th bond relative to the shortest`, () => {
    // 6 O at 2 Å + 1 O at 3.5 Å (idx 7); factor 0.3 -> cutoff 2.6, so the long one drops
    const sites = [...octahedron_sites(), site(`O`, [3.5, 0, 0])]
    const bonds = [...octahedron_bonds(), bond(0, 7, [0, 0, 0], [3.5, 0, 0])]
    const polys = compute_polyhedra_from_bonds(struct(sites), bonds)
    expect(polys[0].neighbor_indices).toHaveLength(6)
    expect(polys[0].neighbor_indices).not.toContain(7)
  })
})

// Two independent octahedra: Ti (framework) at origin, Ba (spectator A-site) far
// away, EACH with its own 6 O at 2 Å so both clear the trim + CN gates and only
// apply_framework_filters can hide Ba.
function two_octahedra(): { sites: Site[]; bonds: BondPair[] } {
  const BA: Vec3 = [20, 0, 0]
  const ba_o: Vec3[] = OCTA_OFFSETS.map((o) => [o[0] + 20, o[1], o[2]] as Vec3)
  const sites = [
    site(`Ti`, [0, 0, 0]), // 0
    ...OCTA_OFFSETS.map((o) => site(`O`, o)), // 1..6
    site(`Ba`, BA), // 7
    ...ba_o.map((o) => site(`O`, o)), // 8..13
  ]
  const bonds = [
    ...OCTA_OFFSETS.map((o, k) => bond(0, k + 1, [0, 0, 0], o)),
    ...ba_o.map((o, k) => bond(7, k + 8, BA, o)),
  ]
  return { sites, bonds }
}

describe(`compute_polyhedra_from_bonds — framework filters`, () => {
  it(`hides spectator Ba but keeps Ti (auto mode runs apply_framework_filters)`, () => {
    const { sites, bonds } = two_octahedra()
    const polys = compute_polyhedra_from_bonds(struct(sites), bonds)
    const elems = polys.map((p) => p.center_element)
    expect(elems).toContain(`Ti`)
    expect(elems).not.toContain(`Ba`)
  })

  it(`explicit center_elements bypasses the framework filter (Ba kept)`, () => {
    const { sites, bonds } = two_octahedra()
    const polys = compute_polyhedra_from_bonds(struct(sites), bonds, {
      center_elements: [`Ba`],
    })
    expect(polys.map((p) => p.center_element)).toContain(`Ba`)
  })
})

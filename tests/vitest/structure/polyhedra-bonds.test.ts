import { describe, expect, it } from 'vitest'
import { build_bond_adjacency } from '$lib/structure/polyhedra'
import type { BondPair, Vec3 } from '$lib/structure'

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

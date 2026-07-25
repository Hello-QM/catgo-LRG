import { describe, expect, test } from 'vitest'
import type { BondPair } from '$lib'
import type { BaseBondGraph } from '$lib/structure/scene/render-packet'
import {
  bond_pairs_to_base_bond_graph,
  hash_base_bond_graph,
  typed_table_to_base_bond_graph,
} from '$lib/structure/trajectory-bond-graph'
import type { TypedBondTable } from '$lib/structure/workers/bond-worker-runtime'

function bond(
  site_idx_1: number,
  site_idx_2: number,
  jimage: [number, number, number],
  strength = 1,
): BondPair {
  return {
    pos_1: [0, 0, 0],
    pos_2: [1, 0, 0],
    site_idx_1,
    site_idx_2,
    bond_length: 1,
    strength,
    transform_matrix: new Float32Array(16),
    jimage,
  }
}

function graph(
  pairs: number[],
  jimages: number[],
  strengths: number[],
  kinds = new Array(strengths.length).fill(0),
): BaseBondGraph {
  return {
    version: 1,
    pairs: Uint32Array.from(pairs),
    jimages: Int8Array.from(jimages),
    kinds: Uint8Array.from(kinds),
    strengths: Float32Array.from(strengths),
  }
}

describe(`typed_table_to_base_bond_graph`, () => {
  test(`preserves typed worker arrays and allocates auto-bond kinds`, () => {
    const table: TypedBondTable = {
      pairs: Uint32Array.from([2, 5, 7, 7]),
      images: Int8Array.from([1, -2, 0, -1, 0, 0]),
      lengths: Float32Array.from([1.25, 2.5]),
      strengths: Float32Array.from([0.75, 0.5]),
    }

    const result = typed_table_to_base_bond_graph(table, 41)

    expect(result.version).toBe(41)
    expect(result.pairs).toBe(table.pairs)
    expect(result.jimages).toBe(table.images)
    expect(result.strengths).toBe(table.strengths)
    expect([...result.kinds]).toEqual([0, 0])
  })

  test.each([
    {
      name: `odd pair length`,
      table: {
        pairs: Uint32Array.from([0]),
        images: new Int8Array(),
        lengths: new Float32Array(),
        strengths: new Float32Array(),
      },
    },
    {
      name: `mismatched image length`,
      table: {
        pairs: Uint32Array.from([0, 1]),
        images: Int8Array.from([0, 0]),
        lengths: Float32Array.from([1]),
        strengths: Float32Array.from([1]),
      },
    },
    {
      name: `mismatched lengths length`,
      table: {
        pairs: Uint32Array.from([0, 1]),
        images: Int8Array.from([0, 0, 0]),
        lengths: new Float32Array(),
        strengths: Float32Array.from([1]),
      },
    },
    {
      name: `mismatched strengths length`,
      table: {
        pairs: Uint32Array.from([0, 1]),
        images: Int8Array.from([0, 0, 0]),
        lengths: Float32Array.from([1]),
        strengths: new Float32Array(),
      },
    },
  ])(`rejects $name`, ({ table }) => {
    expect(() => typed_table_to_base_bond_graph(table, 1)).toThrow(/length/i)
  })
})

describe(`bond_pairs_to_base_bond_graph`, () => {
  test(`maps periodic images, self-image edges, and strengths without filtering`, () => {
    const result = bond_pairs_to_base_bond_graph([
      bond(3, 8, [1, -1, 0], 0.6),
      bond(4, 4, [-1, 0, 0], 0.9),
    ], 12)

    expect(result.version).toBe(12)
    expect([...result.pairs]).toEqual([3, 8, 4, 4])
    expect([...result.jimages]).toEqual([1, -1, 0, -1, 0, 0])
    expect([...result.kinds]).toEqual([0, 0])
    expect([...result.strengths]).toEqual([
      Math.fround(0.6),
      Math.fround(0.9),
    ])
  })

  test(`rejects malformed runtime bond records`, () => {
    const malformed = {
      ...bond(0, 1, [0, 0, 0]),
      jimage: [0, 0],
    } as unknown as BondPair
    expect(() => bond_pairs_to_base_bond_graph([malformed], 1)).toThrow(/jimage/i)
  })
})

describe(`hash_base_bond_graph`, () => {
  test(`is independent of edge order and endpoint direction`, () => {
    const reference = graph(
      [1, 4, 2, 2],
      [1, -2, 0, -1, 0, 0],
      [0.25, 0.75],
      [0, 3],
    )
    const permuted_and_reversed = graph(
      [2, 2, 4, 1],
      [1, 0, 0, -1, 2, 0],
      [0.75, 0.25],
      [3, 0],
    )

    expect(hash_base_bond_graph(permuted_and_reversed)).toBe(
      hash_base_bond_graph(reference),
    )
  })

  test(`changes when edge identity, image, kind, or strength changes`, () => {
    const reference = graph([1, 4], [1, -2, 0], [0.25], [2])
    const hash = hash_base_bond_graph(reference)
    const variants = [
      graph([1, 5], [1, -2, 0], [0.25], [2]),
      graph([1, 4], [1, -1, 0], [0.25], [2]),
      graph([1, 4], [1, -2, 0], [0.25], [3]),
      graph([1, 4], [1, -2, 0], [0.5], [2]),
    ]

    for (const variant of variants) {
      expect(hash_base_bond_graph(variant)).not.toBe(hash)
    }
  })

  test(`canonicalizes opposite periodic self-image directions`, () => {
    const positive = graph([5, 5], [1, -2, 0], [1])
    const negative = graph([5, 5], [-1, 2, 0], [1])
    expect(hash_base_bond_graph(positive)).toBe(hash_base_bond_graph(negative))
  })

  test(`rejects malformed graph array lengths`, () => {
    const malformed: BaseBondGraph = {
      version: 1,
      pairs: Uint32Array.from([0, 1]),
      jimages: Int8Array.from([0, 0]),
      kinds: Uint8Array.from([0]),
      strengths: Float32Array.from([1]),
    }
    expect(() => hash_base_bond_graph(malformed)).toThrow(/jimage/i)
  })
})

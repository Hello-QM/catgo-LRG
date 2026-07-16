import { describe, expect, test } from 'vitest'
import {
  create_replica_id_codec,
  decode_replica_pick_id,
  encode_replica_atom_id,
  encode_replica_bond_id,
  encode_replica_ghost_id,
  logical_site_for_replica_pick_id,
  REPLICA_PICK_MAX_ID,
  REPLICA_PICK_MISS_ID,
} from '$lib/structure/gpu/webgl2/replica-id-picker'
import type {
  ImageInstanceTable,
  ReplicaLayout,
} from '$lib/structure/scene/render-packet'

const EMPTY_IMAGES: ImageInstanceTable = {
  count: 0,
  base_sites: new Uint32Array(0),
  jimages: new Int8Array(0),
}

function visual_layout(
  dims: readonly [number, number, number] = [2, 1, 1],
): ReplicaLayout {
  return {
    version: 1,
    dims,
    boundary_policy: 'ghost-images',
    semantics: 'visual-shared-base',
  }
}

describe('replica integer pick ID codec', () => {
  test('same base atom in different visual cells has one logical site', () => {
    const replicas = visual_layout()
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })

    const cell_0_id = encode_replica_atom_id(codec, 1)
    const cell_1_id = encode_replica_atom_id(codec, 3)
    expect(cell_0_id).not.toBe(cell_1_id)
    expect(decode_replica_pick_id(cell_0_id, codec, replicas, EMPTY_IMAGES)).toEqual({
      kind: 'atom',
      base_site: 1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(decode_replica_pick_id(cell_1_id, codec, replicas, EMPTY_IMAGES)).toEqual({
      kind: 'atom',
      base_site: 1,
      cell: [1, 0, 0],
      ghost: false,
    })
    expect(
      logical_site_for_replica_pick_id(cell_0_id, codec, replicas, EMPTY_IMAGES),
    ).toBe(1)
    expect(
      logical_site_for_replica_pick_id(cell_1_id, codec, replicas, EMPTY_IMAGES),
    ).toBe(1)
  })

  test('ghost IDs map through the sparse image table to the base atom', () => {
    const replicas = visual_layout([1, 1, 1])
    const images: ImageInstanceTable = {
      count: 1,
      base_sites: Uint32Array.from([2]),
      jimages: Int8Array.from([-1, 1, 0]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 3,
      base_bond_count: 1,
      replicas,
      ghost_count: images.count,
    })
    const id = encode_replica_ghost_id(codec, 0)

    expect(decode_replica_pick_id(id, codec, replicas, images)).toEqual({
      kind: 'atom',
      base_site: 2,
      cell: [-1, 1, 0],
      ghost: true,
    })
    expect(logical_site_for_replica_pick_id(id, codec, replicas, images)).toBe(2)
  })

  test('physical-distinct semantics resolve through physical_site_map', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })

    const first = encode_replica_atom_id(codec, 1)
    const second = encode_replica_atom_id(codec, 3)
    expect(logical_site_for_replica_pick_id(first, codec, replicas, EMPTY_IMAGES)).toBe(
      11,
    )
    expect(logical_site_for_replica_pick_id(second, codec, replicas, EMPTY_IMAGES)).toBe(
      21,
    )
  })

  test('same-dims malformed physical map returns a safe miss', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const malformed: ReplicaLayout = {
      ...replicas,
      physical_site_map: Uint32Array.from([30, 31, 40]),
    }

    expect(decode_replica_pick_id(id, codec, malformed, EMPTY_IMAGES)).toEqual({
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, malformed, EMPTY_IMAGES)).toBe(-1)
  })

  test('same-dims physical layout missing its map returns a safe miss', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const missing: ReplicaLayout = {
      version: 2,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
    }

    expect(decode_replica_pick_id(id, codec, missing, EMPTY_IMAGES)).toEqual({
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, missing, EMPTY_IMAGES)).toBe(-1)
  })

  test('same-dims semantics mismatch returns a safe miss', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const visual = visual_layout()

    expect(decode_replica_pick_id(id, codec, visual, EMPTY_IMAGES)).toEqual({
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, visual, EMPTY_IMAGES)).toBe(-1)
  })

  test('visual-shared layouts reject an incompatible physical map', () => {
    const replicas = visual_layout()
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const incompatible: ReplicaLayout = {
      ...replicas,
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }

    expect(decode_replica_pick_id(id, codec, incompatible, EMPTY_IMAGES)).toEqual({
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, incompatible, EMPTY_IMAGES)).toBe(
      -1,
    )
  })

  test('same-length replacement physical map remains valid', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const replacement: ReplicaLayout = {
      ...replicas,
      version: 2,
      physical_site_map: Uint32Array.from([30, 31, 40, 41]),
    }

    expect(decode_replica_pick_id(id, codec, replacement, EMPTY_IMAGES)).toEqual({
      kind: 'atom',
      base_site: 1,
      cell: [1, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, replacement, EMPTY_IMAGES)).toBe(
      41,
    )
  })

  test('bond IDs preserve the base graph index and cell without atom mapping', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([100, 101, 200, 201]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 3,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_bond_id(codec, 5)

    expect(decode_replica_pick_id(id, codec, replicas, EMPTY_IMAGES)).toEqual({
      kind: 'bond',
      base_site: 2,
      cell: [1, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, replicas, EMPTY_IMAGES)).toBe(2)
  })

  test('miss and malformed integer IDs fail safely', () => {
    const replicas = visual_layout()
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 1,
      replicas,
      ghost_count: 1,
    })
    const miss = {
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    }

    expect(decode_replica_pick_id(REPLICA_PICK_MISS_ID, codec, replicas)).toEqual(miss)
    expect(decode_replica_pick_id(-1, codec, replicas)).toEqual(miss)
    expect(decode_replica_pick_id(1.5, codec, replicas)).toEqual(miss)
    expect(decode_replica_pick_id(Number.NaN, codec, replicas)).toEqual(miss)
    expect(decode_replica_pick_id(codec.max_id + 1, codec, replicas)).toEqual(miss)
    expect(
      decode_replica_pick_id(
        encode_replica_ghost_id(codec, 0),
        codec,
        replicas,
        EMPTY_IMAGES,
      ),
    ).toEqual(miss)
    expect(
      decode_replica_pick_id(
        encode_replica_atom_id(codec, 0),
        codec,
        visual_layout([1, 2, 1]),
        EMPTY_IMAGES,
      ),
    ).toEqual(miss)
  })

  test('kind ranges are collision-free and reject out-of-range indices', () => {
    const replicas = visual_layout()
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 3,
      replicas,
      ghost_count: 2,
    })
    const ids = [
      ...Array.from(
        { length: codec.atom_instance_count },
        (_, index) => encode_replica_atom_id(codec, index),
      ),
      ...Array.from(
        { length: codec.bond_instance_count },
        (_, index) => encode_replica_bond_id(codec, index),
      ),
      ...Array.from(
        { length: codec.ghost_count },
        (_, index) => encode_replica_ghost_id(codec, index),
      ),
    ]

    expect(ids).not.toContain(REPLICA_PICK_MISS_ID)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Math.max(...ids)).toBe(codec.max_id)
    expect(() => encode_replica_atom_id(codec, codec.atom_instance_count)).toThrow(
      RangeError,
    )
    expect(() => encode_replica_bond_id(codec, -1)).toThrow(RangeError)
    expect(() => encode_replica_ghost_id(codec, 0.5)).toThrow(RangeError)
  })

  test('validates uint32 capacity without constructing N x cell tables', () => {
    const replicas = visual_layout([2, 2, 2])
    const codec = create_replica_id_codec({
      base_atom_count: 20_000,
      base_bond_count: 50_000,
      replicas,
      ghost_count: 7,
    })

    expect(codec.atom_instance_count).toBe(160_000)
    expect(codec.bond_instance_count).toBe(400_000)
    expect(codec.max_id).toBe(560_007)
    expect(codec.semantics).toBe('visual-shared-base')
    expect(Object.values(codec).every((value) => typeof value !== 'object')).toBe(true)
    expect(Object.isFrozen(codec)).toBe(true)

    const edge = create_replica_id_codec({
      base_atom_count: REPLICA_PICK_MAX_ID,
      base_bond_count: 0,
      replicas: visual_layout([1, 1, 1]),
      ghost_count: 0,
    })
    expect(encode_replica_atom_id(edge, REPLICA_PICK_MAX_ID - 1)).toBe(
      REPLICA_PICK_MAX_ID,
    )

    expect(() =>
      create_replica_id_codec({
        base_atom_count: REPLICA_PICK_MAX_ID,
        base_bond_count: 1,
        replicas: visual_layout([1, 1, 1]),
        ghost_count: 0,
      })
    ).toThrow(/uint32 capacity/)
    expect(() =>
      create_replica_id_codec({
        base_atom_count: 1,
        base_bond_count: 0,
        replicas: visual_layout([2, 1, 1]),
        ghost_count: REPLICA_PICK_MAX_ID,
      })
    ).toThrow(/uint32 capacity/)
  })

  test('rejects invalid counts, dimensions, and physical maps explicitly', () => {
    expect(() =>
      create_replica_id_codec({
        base_atom_count: -1,
        base_bond_count: 0,
        replicas: visual_layout(),
        ghost_count: 0,
      })
    ).toThrow(/base_atom_count/)
    expect(() =>
      create_replica_id_codec({
        base_atom_count: 1,
        base_bond_count: 0,
        replicas: visual_layout([0, 1, 1]),
        ghost_count: 0,
      })
    ).toThrow(/replica dims/)
    expect(() =>
      create_replica_id_codec({
        base_atom_count: 2,
        base_bond_count: 0,
        replicas: {
          version: 1,
          dims: [2, 1, 1],
          boundary_policy: 'stub',
          semantics: 'physical-distinct-sites',
          physical_site_map: Uint32Array.from([10, 11]),
        },
        ghost_count: 0,
      })
    ).toThrow(/physical_site_map/)
    expect(() =>
      create_replica_id_codec({
        base_atom_count: 2,
        base_bond_count: 0,
        replicas: {
          ...visual_layout(),
          physical_site_map: Uint32Array.from([10, 11, 20, 21]),
        },
        ghost_count: 0,
      })
    ).toThrow(/visual-shared-base/)
  })
})

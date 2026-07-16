import { describe, expect, test } from 'vitest'
import {
  build_image_instance_table,
  decode_replica_instance,
  encode_cell_index,
  logical_site_for_pick,
  replica_translation,
  resolve_periodic_edge,
} from '$lib/structure/scene/replica-layout'
import type { ResolvedEdgeState } from '$lib/structure/scene/replica-layout'
import type { BaseBondGraph, ReplicaLayout } from '$lib/structure/scene/render-packet'

// --- decode_replica_instance --------------------------------------------

describe(`decode_replica_instance (atom-major: inst = atom + base_count·cell)`, () => {
  test(`decodes a 1D tiling with 2 base atoms`, () => {
    const dims = [2, 1, 1] as const
    // inst = atom + 2·cell_index, cell_index runs x-fastest
    expect(decode_replica_instance(0, 2, dims)).toEqual({
      atom_index: 0,
      cell: [0, 0, 0],
      cell_index: 0,
    })
    expect(decode_replica_instance(1, 2, dims)).toEqual({
      atom_index: 1,
      cell: [0, 0, 0],
      cell_index: 0,
    })
    expect(decode_replica_instance(2, 2, dims)).toEqual({
      atom_index: 0,
      cell: [1, 0, 0],
      cell_index: 1,
    })
    expect(decode_replica_instance(3, 2, dims)).toEqual({
      atom_index: 1,
      cell: [1, 0, 0],
      cell_index: 1,
    })
  })

  test(`decodes a 3D tiling with 1 base atom (x-fastest, then y, then z)`, () => {
    const dims = [2, 2, 2] as const
    expect(decode_replica_instance(0, 1, dims).cell).toEqual([0, 0, 0])
    expect(decode_replica_instance(1, 1, dims).cell).toEqual([1, 0, 0])
    expect(decode_replica_instance(2, 1, dims).cell).toEqual([0, 1, 0])
    expect(decode_replica_instance(3, 1, dims).cell).toEqual([1, 1, 0])
    expect(decode_replica_instance(4, 1, dims).cell).toEqual([0, 0, 1])
    expect(decode_replica_instance(7, 1, dims).cell).toEqual([1, 1, 1])
  })

  test(`round-trips against the atom-major encode formula`, () => {
    const dims = [3, 2, 2] as const
    const base_count = 4
    const total = base_count * dims[0] * dims[1] * dims[2]
    for (let inst = 0; inst < total; inst++) {
      const d = decode_replica_instance(inst, base_count, dims)
      const cell_index = d.cell[0] + dims[0] * (d.cell[1] + dims[1] * d.cell[2])
      expect(d.atom_index + base_count * cell_index).toBe(inst)
    }
  })

  test(`writes into a caller-provided out record (allocation-free hot path)`, () => {
    const dims = [2, 1, 1] as const
    const out = {
      atom_index: -1,
      cell: [9, 9, 9] as [number, number, number],
      cell_index: -1,
    }
    const cell_ref = out.cell
    const ret = decode_replica_instance(3, 2, dims, out)
    expect(ret).toBe(out)
    expect(out.cell).toBe(cell_ref) // inner tuple reused, not replaced
    expect(out).toEqual({ atom_index: 1, cell: [1, 0, 0], cell_index: 1 })
    // reuse the same record for a second decode
    expect(decode_replica_instance(0, 2, dims, out)).toBe(out)
    expect(out).toEqual({ atom_index: 0, cell: [0, 0, 0], cell_index: 0 })
  })
})

// --- encode_cell_index ----------------------------------------------------

describe(`encode_cell_index (range-guarded: -1 for cells outside [0,dims))`, () => {
  const dims = [3, 2, 1] as const

  test(`encodes in-range cells x-fastest, then y, then z`, () => {
    expect(encode_cell_index([0, 0, 0], dims)).toBe(0)
    expect(encode_cell_index([2, 0, 0], dims)).toBe(2)
    expect(encode_cell_index([0, 1, 0], dims)).toBe(3)
    expect(encode_cell_index([2, 1, 0], dims)).toBe(5)
  })

  test(`returns -1 for out-of-range cells instead of aliasing another replica`, () => {
    // pre-fix these aliased: [-1,1,0] ⇒ 2, [3,0,0] ⇒ 3, [0,0,1] ⇒ 6
    expect(encode_cell_index([-1, 1, 0], dims)).toBe(-1)
    expect(encode_cell_index([3, 0, 0], dims)).toBe(-1)
    expect(encode_cell_index([0, 2, 0], dims)).toBe(-1)
    expect(encode_cell_index([0, 0, 1], dims)).toBe(-1)
    expect(encode_cell_index([0, 0, -1], dims)).toBe(-1)
  })
})

// --- replica_translation ------------------------------------------------

describe(`replica_translation (uses the CURRENT frame lattice)`, () => {
  const ortho = Float32Array.from([10, 0, 0, 0, 10, 0, 0, 0, 10])

  test(`computes ix·a + iy·b + iz·c`, () => {
    expect(replica_translation([1, 0, 0], ortho)).toEqual([10, 0, 0])
    expect(replica_translation([0, 1, 0], ortho)).toEqual([0, 10, 0])
    expect(replica_translation([1, 1, 1], ortho)).toEqual([10, 10, 10])
    expect(replica_translation([0, 0, 0], ortho)).toEqual([0, 0, 0])
  })

  test(`handles a non-orthogonal (row-major a,b,c) lattice`, () => {
    // a=(4,0,0) b=(1,4,0) c=(0,0,5)
    const tri = Float32Array.from([4, 0, 0, 1, 4, 0, 0, 0, 5])
    expect(replica_translation([1, 1, 0], tri)).toEqual([5, 4, 0])
    expect(replica_translation([2, 0, 1], tri)).toEqual([8, 0, 5])
  })

  test(`variable-cell: same cell, grown frame lattice ⇒ scaled translation`, () => {
    const base = Float32Array.from([10, 0, 0, 0, 10, 0, 0, 0, 10])
    const grown = Float32Array.from([20, 0, 0, 0, 20, 0, 0, 0, 20])
    expect(replica_translation([1, 0, 0], base)).toEqual([10, 0, 0])
    expect(replica_translation([1, 0, 0], grown)).toEqual([20, 0, 0])
  })

  test(`writes into a caller-provided out tuple (allocation-free)`, () => {
    const out: [number, number, number] = [0, 0, 0]
    const ret = replica_translation([1, 1, 0], ortho, out)
    expect(ret).toBe(out)
    expect(out).toEqual([10, 10, 0])
  })
})

// --- resolve_periodic_edge ----------------------------------------------

describe(`resolve_periodic_edge (four boundary outcomes on cell + jimage)`, () => {
  const dims = [1, 1, 1] as const

  test(`inside supercell ⇒ complete bond to real replica`, () => {
    const big: readonly [number, number, number] = [2, 1, 1]
    const bond = { a: 0, b: 1, jimage: [1, 0, 0] as const }
    const r = resolve_periodic_edge(bond, [0, 0, 0], big, `stub`)
    expect(r.kind).toBe(`complete`)
    if (r.kind === `complete`) {
      expect(r.a_cell).toEqual([0, 0, 0])
      expect(r.b_cell).toEqual([1, 0, 0])
      expect(r.ghost).toBe(false)
    }
  })

  test(`outside + 'stub' ⇒ stub edge`, () => {
    const bond = { a: 0, b: 1, jimage: [1, 0, 0] as const }
    const r = resolve_periodic_edge(bond, [0, 0, 0], dims, `stub`)
    expect(r.kind).toBe(`stub`)
    if (r.kind === `stub`) {
      expect(r.b_cell).toEqual([1, 0, 0])
      expect(r.ghost).toBe(false)
    }
  })

  test(`outside + 'hide' ⇒ omit`, () => {
    const bond = { a: 0, b: 1, jimage: [1, 0, 0] as const }
    const r = resolve_periodic_edge(bond, [0, 0, 0], dims, `hide`)
    expect(r.kind).toBe(`omit`)
  })

  test(`outside + 'ghost-images' ⇒ ghost instance + complete bond to ghost`, () => {
    const bond = { a: 0, b: 1, jimage: [1, 0, 0] as const }
    const r = resolve_periodic_edge(bond, [0, 0, 0], dims, `ghost-images`)
    expect(r.kind).toBe(`ghost`)
    if (r.kind === `ghost`) {
      expect(r.b_cell).toEqual([1, 0, 0])
      expect(r.ghost).toBe(true)
    }
  })

  test(`negative jimage below origin is outside ⇒ policy applies`, () => {
    const bond = { a: 0, b: 1, jimage: [-1, 0, 0] as const }
    const r = resolve_periodic_edge(bond, [0, 0, 0], dims, `stub`)
    expect(r.kind).toBe(`stub`)
    if (r.kind === `stub`) expect(r.b_cell).toEqual([-1, 0, 0])
  })
})

describe(`resolve_periodic_edge — periodic self-image edges are VALID`, () => {
  test(`a === b with non-zero jimage landing inside ⇒ complete, not filtered`, () => {
    const bond = { a: 0, b: 0, jimage: [1, 0, 0] as const }
    const r = resolve_periodic_edge(bond, [0, 0, 0], [2, 1, 1], `hide`)
    expect(r.kind).toBe(`complete`)
    if (r.kind === `complete`) expect(r.b_cell).toEqual([1, 0, 0])
  })

  test(`single-atom primitive cell self-image (dims 1,1,1) is processed by policy`, () => {
    const bond = { a: 0, b: 0, jimage: [1, 0, 0] as const }
    // not silently filtered as a "self bond": stub policy yields a stub
    expect(resolve_periodic_edge(bond, [0, 0, 0], [1, 1, 1], `stub`).kind).toBe(`stub`)
    expect(resolve_periodic_edge(bond, [0, 0, 0], [1, 1, 1], `hide`).kind).toBe(`omit`)
  })
})

describe(`resolve_periodic_edge — out-param form (allocation-free hot path)`, () => {
  test(`writes into a caller-provided ResolvedEdgeState and reuses its tuples`, () => {
    const out: ResolvedEdgeState = {
      kind: `omit`,
      a_cell: [0, 0, 0],
      b_cell: [0, 0, 0],
      ghost: false,
    }
    const a_ref = out.a_cell
    const b_ref = out.b_cell
    const bond = { a: 0, b: 1, jimage: [1, 0, 0] as const }
    const ret = resolve_periodic_edge(bond, [0, 0, 0], [2, 1, 1], `stub`, out)
    expect(ret).toBe(out)
    expect(out.kind).toBe(`complete`)
    expect(out.a_cell).toBe(a_ref)
    expect(out.b_cell).toBe(b_ref)
    expect(out.a_cell).toEqual([0, 0, 0])
    expect(out.b_cell).toEqual([1, 0, 0])
    expect(out.ghost).toBe(false)
  })

  test(`reusing the record across omit / ghost outcomes updates every field`, () => {
    const out: ResolvedEdgeState = {
      kind: `omit`,
      a_cell: [0, 0, 0],
      b_cell: [0, 0, 0],
      ghost: false,
    }
    const bond = { a: 0, b: 1, jimage: [1, 0, 0] as const }
    expect(resolve_periodic_edge(bond, [1, 0, 0], [2, 1, 1], `hide`, out)).toBe(out)
    expect(out.kind).toBe(`omit`)
    expect(resolve_periodic_edge(bond, [1, 0, 0], [2, 1, 1], `ghost-images`, out)).toBe(
      out,
    )
    expect(out.kind).toBe(`ghost`)
    expect(out.ghost).toBe(true)
    expect(out.b_cell).toEqual([2, 0, 0])
  })
})

// --- build_image_instance_table -----------------------------------------

describe(`build_image_instance_table (sparse, deduplicated ghost table)`, () => {
  test(`returns an empty table for non-ghost policies`, () => {
    const bg: BaseBondGraph = {
      version: 1,
      pairs: Uint32Array.from([0, 1]),
      jimages: Int8Array.from([1, 0, 0]),
      kinds: Uint8Array.from([0]),
      strengths: Float32Array.from([1]),
    }
    const table = build_image_instance_table(bg, [1, 1, 1], `stub`)
    expect(table.count).toBe(0)
    expect(table.base_sites.length).toBe(0)
    expect(table.jimages.length).toBe(0)
  })

  test(`collects out-of-cell neighbors as (base_site, jimage) ghosts`, () => {
    // one bond 0->1 with jimage +x; dims 1x1x1 ⇒ target [1,0,0] is a ghost of site 1
    const bg: BaseBondGraph = {
      version: 1,
      pairs: Uint32Array.from([0, 1]),
      jimages: Int8Array.from([1, 0, 0]),
      kinds: Uint8Array.from([0]),
      strengths: Float32Array.from([1]),
    }
    const table = build_image_instance_table(bg, [1, 1, 1], `ghost-images`)
    expect(table.count).toBe(1)
    expect(Array.from(table.base_sites)).toEqual([1])
    expect(Array.from(table.jimages)).toEqual([1, 0, 0])
  })

  test(`deduplicates ghosts requested by multiple cells / bonds`, () => {
    // dims 2x1x1: bond 0->1 jimage +x. cell [1,0,0] ⇒ target [2,0,0] (ghost).
    // cell [0,0,0] ⇒ target [1,0,0] (inside, no ghost). Second identical bond
    // must not create a duplicate ghost.
    const bg: BaseBondGraph = {
      version: 1,
      pairs: Uint32Array.from([0, 1, 0, 1]),
      jimages: Int8Array.from([1, 0, 0, 1, 0, 0]),
      kinds: Uint8Array.from([0, 0]),
      strengths: Float32Array.from([1, 1]),
    }
    const table = build_image_instance_table(bg, [2, 1, 1], `ghost-images`)
    expect(table.count).toBe(1)
    expect(Array.from(table.base_sites)).toEqual([1])
    expect(Array.from(table.jimages)).toEqual([2, 0, 0])
  })

  test(`single-atom self-image bond (a === b, jimage ≠ 0) produces its ghost`, () => {
    // The design's flagship case: 1-atom primitive cell, bond 0->0 jimage +x.
    const bg: BaseBondGraph = {
      version: 1,
      pairs: Uint32Array.from([0, 0]),
      jimages: Int8Array.from([1, 0, 0]),
      kinds: Uint8Array.from([0]),
      strengths: Float32Array.from([1]),
    }
    // dims 1x1x1: cell [0,0,0] ⇒ target [1,0,0] outside ⇒ ghost of site 0
    const t1 = build_image_instance_table(bg, [1, 1, 1], `ghost-images`)
    expect(t1.count).toBe(1)
    expect(Array.from(t1.base_sites)).toEqual([0])
    expect(Array.from(t1.jimages)).toEqual([1, 0, 0])
    // dims 2x1x1: only cell [1,0,0] spills ⇒ single ghost at [2,0,0]
    const t2 = build_image_instance_table(bg, [2, 1, 1], `ghost-images`)
    expect(t2.count).toBe(1)
    expect(Array.from(t2.base_sites)).toEqual([0])
    expect(Array.from(t2.jimages)).toEqual([2, 0, 0])
  })

  test(`numeric-key dedup matches the string-key reference (dupes + self-image)`, () => {
    // Reference implementation of the ORIGINAL string-key dedup, same iteration
    // order (bond-major, then z,y,x cells). The production numeric-key path
    // must reproduce it exactly, including insertion order.
    const reference = (bg: BaseBondGraph, dims: readonly [number, number, number]) => {
      const [nx, ny, nz] = dims
      const seen = new Set<string>()
      const sites: number[] = []
      const images: number[] = []
      for (let bi = 0; bi < bg.pairs.length / 2; bi++) {
        const b = bg.pairs[bi * 2 + 1]
        const [jx, jy, jz] = [
          bg.jimages[bi * 3],
          bg.jimages[bi * 3 + 1],
          bg.jimages[bi * 3 + 2],
        ]
        for (let iz = 0; iz < nz; iz++) {
          for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
              const [tx, ty, tz] = [ix + jx, iy + jy, iz + jz]
              if (tx >= 0 && tx < nx && ty >= 0 && ty < ny && tz >= 0 && tz < nz) continue
              const key = `${b}|${tx},${ty},${tz}`
              if (seen.has(key)) continue
              seen.add(key)
              sites.push(b)
              images.push(tx, ty, tz)
            }
          }
        }
      }
      return { sites, images }
    }
    const bg: BaseBondGraph = {
      version: 1,
      // bond0: 0->0 self-image +x, bond1: duplicate of bond0,
      // bond2: 1->0 jimage -x, bond3: 0->1 jimage [1,-1,0]
      pairs: Uint32Array.from([0, 0, 0, 0, 1, 0, 0, 1]),
      jimages: Int8Array.from([1, 0, 0, 1, 0, 0, -1, 0, 0, 1, -1, 0]),
      kinds: Uint8Array.from([0, 0, 0, 0]),
      strengths: Float32Array.from([1, 1, 1, 1]),
    }
    const dims = [2, 2, 1] as const
    const expected = reference(bg, dims)
    const table = build_image_instance_table(bg, dims, `ghost-images`)
    expect(table.count).toBe(expected.sites.length)
    expect(Array.from(table.base_sites)).toEqual(expected.sites)
    expect(Array.from(table.jimages)).toEqual(expected.images)
  })
})

// --- logical_site_for_pick ----------------------------------------------

describe(`logical_site_for_pick (logical vs physical resolution)`, () => {
  test(`visual-shared-base ⇒ any replica maps to its base site`, () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: `stub`,
      semantics: `visual-shared-base`,
    }
    expect(
      logical_site_for_pick(
        { kind: `atom`, base_site: 3, cell: [1, 0, 0], ghost: false },
        replicas,
      ),
    ).toBe(3)
    // a ghost pick also folds back to the base site
    expect(
      logical_site_for_pick(
        { kind: `atom`, base_site: 3, cell: [1, 0, 0], ghost: true },
        replicas,
      ),
    ).toBe(3)
  })

  test(`physical-distinct-sites ⇒ resolves the unique physical site via the map`, () => {
    // base_count = map.length / (nx·ny·nz) = 4 / 2 = 2
    // instance_index = base_site + base_count·cell_index
    // physical_site_map indexed atom-major by instance_index.
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: `stub`,
      semantics: `physical-distinct-sites`,
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    // base_site 0, cell [0,0,0] ⇒ inst 0 ⇒ 10
    expect(
      logical_site_for_pick(
        { kind: `atom`, base_site: 0, cell: [0, 0, 0], ghost: false },
        replicas,
      ),
    ).toBe(10)
    // base_site 1, cell [1,0,0] ⇒ inst 1 + 2·1 = 3 ⇒ 21
    expect(
      logical_site_for_pick(
        { kind: `atom`, base_site: 1, cell: [1, 0, 0], ghost: false },
        replicas,
      ),
    ).toBe(21)
  })

  test(`a miss resolves to -1`, () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [1, 1, 1],
      boundary_policy: `stub`,
      semantics: `visual-shared-base`,
    }
    expect(
      logical_site_for_pick(
        { kind: `miss`, base_site: -1, cell: [0, 0, 0], ghost: false },
        replicas,
      ),
    ).toBe(-1)
  })

  test(`bond picks return the bond graph index, never consulting the map`, () => {
    // base_site carries the BOND GRAPH index for kind 'bond' — feeding it into
    // physical_site_map would silently return an unrelated atom's site id.
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: `stub`,
      semantics: `physical-distinct-sites`,
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    expect(
      logical_site_for_pick(
        { kind: `bond`, base_site: 1, cell: [1, 0, 0], ghost: false },
        replicas,
      ),
    ).toBe(1)
    // also under visual-shared-base
    const shared: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: `stub`,
      semantics: `visual-shared-base`,
    }
    expect(
      logical_site_for_pick(
        { kind: `bond`, base_site: 7, cell: [0, 0, 0], ghost: false },
        shared,
      ),
    ).toBe(7)
  })

  test(`ghost picks under visual-shared-base fold to base_site even off-grid`, () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: `ghost-images`,
      semantics: `visual-shared-base`,
    }
    expect(
      logical_site_for_pick(
        { kind: `atom`, base_site: 3, cell: [-1, 0, 0], ghost: true },
        replicas,
      ),
    ).toBe(3)
  })

  test(`ghost picks under physical-distinct-sites wrap into the supercell`, () => {
    // dims [3,2,1], 1 base atom ⇒ 6 physical sites, map inst -> 100+inst.
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [3, 2, 1],
      boundary_policy: `ghost-images`,
      semantics: `physical-distinct-sites`,
      physical_site_map: Uint32Array.from([100, 101, 102, 103, 104, 105]),
    }
    // ghost at cell [-1,1,0]: true-modulo wrap ⇒ [2,1,0] ⇒ cell_index 5 ⇒ 105.
    // (pre-fix, encode aliased [-1,1,0] to cell_index 2 ⇒ WRONG site 102)
    expect(
      logical_site_for_pick(
        { kind: `atom`, base_site: 0, cell: [-1, 1, 0], ghost: true },
        replicas,
      ),
    ).toBe(105)
    // ghost beyond the upper face: [3,1,0] wraps to [0,1,0] ⇒ cell_index 3 ⇒ 103
    expect(
      logical_site_for_pick(
        { kind: `atom`, base_site: 0, cell: [3, 1, 0], ghost: true },
        replicas,
      ),
    ).toBe(103)
    // a ghost more than one period out still wraps: [-4,0,0] ⇒ [2,0,0] ⇒ 102
    expect(
      logical_site_for_pick(
        { kind: `atom`, base_site: 0, cell: [-4, 0, 0], ghost: true },
        replicas,
      ),
    ).toBe(102)
  })

  test(`malformed non-ghost out-of-range cell falls back to base_site`, () => {
    // encode_cell_index returns -1 for non-ghost off-grid cells; the pick
    // resolver treats that as malformed input and falls back to the base site.
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: `stub`,
      semantics: `physical-distinct-sites`,
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    expect(
      logical_site_for_pick(
        { kind: `atom`, base_site: 1, cell: [2, 0, 0], ghost: false },
        replicas,
      ),
    ).toBe(1)
  })
})

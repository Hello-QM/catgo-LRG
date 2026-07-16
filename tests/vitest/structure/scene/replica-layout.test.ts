import { describe, expect, test } from 'vitest'
import {
  build_image_instance_table,
  decode_replica_instance,
  logical_site_for_pick,
  replica_translation,
  resolve_periodic_edge,
} from '$lib/structure/scene/replica-layout'
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
})

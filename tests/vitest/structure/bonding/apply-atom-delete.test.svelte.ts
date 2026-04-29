/**
 * Unit tests for incremental atom-delete on the bond side (phase X4).
 *
 * Covers:
 *   - `BondManager.apply_atom_delete` — filter + reindex on the SoA.
 *   - `apply_atom_delete_incremental` — controller helper that drives the
 *     manager AND the `bond_connectivity` / fingerprint state.
 *
 * Runs all reactive work inside `$effect.root` so `#version` (a $state number)
 * is observable as a plain number.
 */

import { describe, expect, it } from 'vitest'
import { BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import {
  apply_atom_delete_incremental,
  create_bond_state,
} from '$lib/structure/bond-computation-controller.svelte'
import type { Site } from '$lib'

// --- helpers ----------------------------------------------------------------

function make_manager(initial_capacity?: number) {
  let mgr!: BondManager
  const stop = $effect.root(() => {
    mgr = new BondManager(initial_capacity)
  })
  return { mgr, stop }
}

function snapshot_pairs(mgr: BondManager): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const buf = mgr.pairs_buffer
  for (let s = 0; s < mgr.count; s++) {
    out.push([buf[s * 2], buf[s * 2 + 1]])
  }
  return out
}

function fake_site(el: string, xyz: [number, number, number]): Site {
  return {
    species: [{ element: el as any, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: el,
    properties: {},
  } as unknown as Site
}

// --- BondManager.apply_atom_delete ------------------------------------------

describe(`BondManager.apply_atom_delete — no-ops`, () => {
  it(`returns without version bump on empty input (array)`, () => {
    const { mgr, stop } = make_manager()
    try {
      mgr.add_bond(0, 1)
      const v = mgr.version
      mgr.apply_atom_delete([])
      expect(mgr.version).toBe(v)
      expect(mgr.count).toBe(1)
    } finally { stop() }
  })

  it(`returns without version bump on empty input (Set)`, () => {
    const { mgr, stop } = make_manager()
    try {
      mgr.add_bond(0, 1)
      const v = mgr.version
      mgr.apply_atom_delete(new Set<number>())
      expect(mgr.version).toBe(v)
      expect(mgr.count).toBe(1)
    } finally { stop() }
  })

  it(`returns without version bump when manager is empty`, () => {
    const { mgr, stop } = make_manager()
    try {
      const v = mgr.version
      mgr.apply_atom_delete([2, 5, 7])
      expect(mgr.version).toBe(v)
      expect(mgr.count).toBe(0)
    } finally { stop() }
  })

  it(`no-op when no bonds touch deleted AND no reindex needed`, () => {
    const { mgr, stop } = make_manager()
    try {
      mgr.add_bond(0, 1)
      mgr.add_bond(2, 3)
      const v = mgr.version
      // Delete indices strictly greater than every endpoint → no drops, no shift.
      mgr.apply_atom_delete([10, 11])
      expect(mgr.version).toBe(v)
      expect(mgr.count).toBe(2)
      expect(snapshot_pairs(mgr)).toEqual([[0, 1], [2, 3]])
    } finally { stop() }
  })
})

describe(`BondManager.apply_atom_delete — reindex only`, () => {
  it(`only reindex when no bonds touch deleted atoms`, () => {
    const { mgr, stop } = make_manager()
    try {
      // atoms exist at indices 0..10; bonds are (5,8) and (7,9).
      mgr.add_bond(5, 8)
      mgr.add_bond(7, 9)
      const v0 = mgr.version
      // Delete atom 0 (lower than every endpoint). Every endpoint shifts by 1.
      mgr.apply_atom_delete([0])
      expect(mgr.version).toBe(v0 + 1)
      expect(mgr.count).toBe(2)
      expect(snapshot_pairs(mgr)).toEqual([[4, 7], [6, 8]])
    } finally { stop() }
  })
})

describe(`BondManager.apply_atom_delete — drop only`, () => {
  it(`empties the manager when every bond touches a deleted atom`, () => {
    const { mgr, stop } = make_manager()
    try {
      mgr.add_bond(0, 1)
      mgr.add_bond(1, 2)
      mgr.add_bond(2, 3)
      const v0 = mgr.version
      mgr.apply_atom_delete([1, 2])
      expect(mgr.version).toBe(v0 + 1)
      expect(mgr.count).toBe(0)
    } finally { stop() }
  })
})

describe(`BondManager.apply_atom_delete — mixed + reindex math`, () => {
  it(`correctly filters + reindexes with deletes [2, 5, 7]`, () => {
    const { mgr, stop } = make_manager()
    try {
      // Input bonds designed per the brief:
      //   (3, 8) -> (2, 5)
      //   (6, 9) -> (4, 6)
      //   (1, 4) -> (1, 3)
      // Plus some bonds that should be dropped:
      //   (2, 9) dropped (touches 2)
      //   (5, 6) dropped (touches 5)
      //   (7, 8) dropped (touches 7)
      mgr.add_bond(3, 8)
      mgr.add_bond(2, 9)
      mgr.add_bond(6, 9)
      mgr.add_bond(5, 6)
      mgr.add_bond(1, 4)
      mgr.add_bond(7, 8)
      const v0 = mgr.version
      mgr.apply_atom_delete([2, 5, 7])
      expect(mgr.version).toBe(v0 + 1)
      expect(mgr.count).toBe(3)
      // Preserve original relative order of surviving bonds.
      expect(snapshot_pairs(mgr)).toEqual([[2, 5], [4, 6], [1, 3]])
    } finally { stop() }
  })

  it(`handles duplicate deleted indices (idempotent)`, () => {
    const { mgr, stop } = make_manager()
    try {
      mgr.add_bond(3, 8)
      mgr.add_bond(6, 9)
      mgr.add_bond(1, 4)
      const v0 = mgr.version
      // Deliberate duplicates; result must match the [2,5,7] case.
      mgr.apply_atom_delete([2, 5, 7, 2, 5, 7, 5])
      expect(mgr.version).toBe(v0 + 1)
      expect(snapshot_pairs(mgr)).toEqual([[2, 5], [4, 6], [1, 3]])
    } finally { stop() }
  })

  it(`migrates colors_start/colors_end/opacity with compaction`, () => {
    const { mgr, stop } = make_manager()
    try {
      // Three bonds, each with distinctive colors + opacity.
      mgr.add_bond(3, 8)
      mgr.add_bond(2, 9)  // will be dropped
      mgr.add_bond(6, 9)
      mgr.set_colors(0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6)
      mgr.set_colors(1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6)
      mgr.set_colors(2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6)
      mgr.set_opacity(0, 0.25)
      mgr.set_opacity(1, 0.5)
      mgr.set_opacity(2, 0.75)
      mgr.apply_atom_delete([2, 5, 7])
      expect(mgr.count).toBe(2)
      expect(snapshot_pairs(mgr)).toEqual([[2, 5], [4, 6]])
      const cs = mgr.colors_start_buffer!
      const ce = mgr.colors_end_buffer!
      const op = mgr.opacity_buffer!
      // slot 0 kept its own colors; slot 1 inherited from read-slot 2.
      // Float32 stored values — use per-element toBeCloseTo rather than toEqual.
      const expect_close = (arr: Float32Array, expected: number[]) => {
        expect(arr.length).toBe(expected.length)
        for (let i = 0; i < expected.length; i++) expect(arr[i]).toBeCloseTo(expected[i], 5)
      }
      expect_close(cs.subarray(0, 6) as Float32Array, [0.1, 0.2, 0.3, 2.1, 2.2, 2.3])
      expect_close(ce.subarray(0, 6) as Float32Array, [0.4, 0.5, 0.6, 2.4, 2.5, 2.6])
      expect(op[0]).toBeCloseTo(0.25)
      expect(op[1]).toBeCloseTo(0.75)
    } finally { stop() }
  })
})

describe(`BondManager.apply_atom_delete — dirty tracking`, () => {
  it(`leaves dirty_slots sparse when the changed span is small relative to count`, () => {
    const { mgr, stop } = make_manager()
    try {
      // 200 chained bonds: (i, i+1) for i in 0..199. Atoms 0..200 are used.
      for (let i = 0; i < 200; i++) mgr.add_bond(i, i + 1)
      mgr.clear_dirty()
      // Delete atom 195 — drops bond slots 194 (194,195) and 195 (195,196).
      // Slots 0..193 are unchanged (no reindex — every endpoint <= 194).
      // Slots 196..199 reindex by 1 and compact down to 194..197.
      mgr.apply_atom_delete([195])
      expect(mgr.count).toBe(198)
      // Small change span (~4 slots) vs large count → stays sparse.
      expect(mgr.dirty_all).toBe(false)
      expect(mgr.dirty_slots.size).toBeGreaterThan(0)
      expect(mgr.dirty_slots.size).toBeLessThan(20)
      // Slots 198..199 are out-of-range post-compaction; purge_dead_dirty_slots
      // removed them.
      expect(mgr.dirty_slots.has(198)).toBe(false)
      expect(mgr.dirty_slots.has(199)).toBe(false)
    } finally { stop() }
  })

  it(`promotes dirty_all when the changed range is large`, () => {
    const { mgr, stop } = make_manager()
    try {
      // 10_000 bonds, every one touches a deleted atom. Every slot changes.
      const N = 10_000
      for (let i = 0; i < N; i++) mgr.add_bond(i, i + 1)
      mgr.clear_dirty()
      // Delete atom 0 — touches bond slot 0, reindexes every surviving bond.
      mgr.apply_atom_delete([0])
      expect(mgr.count).toBe(N - 1)
      // Huge change range -> dirty_all must be promoted.
      expect(mgr.dirty_all).toBe(true)
      expect(mgr.dirty_slots.size).toBe(0)
    } finally { stop() }
  })
})

// --- controller helper: apply_atom_delete_incremental -----------------------

describe(`apply_atom_delete_incremental`, () => {
  function setup() {
    let bond_state!: ReturnType<typeof create_bond_state>
    let mgr!: BondManager
    const stop = $effect.root(() => {
      bond_state = create_bond_state()
      mgr = new BondManager()
    })
    return { bond_state, mgr, stop }
  }

  it(`filters + reindexes bond_connectivity and updates fingerprints`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      mgr.add_bond(3, 8)
      mgr.add_bond(2, 9)
      mgr.add_bond(6, 9)
      mgr.add_bond(5, 6)
      mgr.add_bond(1, 4)
      mgr.add_bond(7, 8)
      bond_state.bond_connectivity = [
        { site_idx_1: 3, site_idx_2: 8, strength: 0.9 },
        { site_idx_1: 2, site_idx_2: 9, strength: 0.8 },
        { site_idx_1: 6, site_idx_2: 9, strength: 0.7 },
        { site_idx_1: 5, site_idx_2: 6, strength: 0.6 },
        { site_idx_1: 1, site_idx_2: 4, strength: 0.5 },
        { site_idx_1: 7, site_idx_2: 8, strength: 0.4 },
      ]
      // Pre-state: fingerprints are unset.
      bond_state.last_bond_fingerprint = ''
      bond_state.last_elem_fingerprint = ''
      bond_state.last_bond_strategy = 'atom_radii-{}'

      // Simulate a sites array of length 10 pre-delete; post-delete = 7.
      const all_sites: Site[] = []
      for (let i = 0; i < 10; i++) {
        all_sites.push(fake_site(i % 2 === 0 ? 'C' : 'H', [i, i, i]))
      }
      const deleted = [2, 5, 7]
      const new_sites = all_sites.filter((_, i) => !deleted.includes(i))

      apply_atom_delete_incremental(bond_state, deleted, mgr, new_sites)

      // bond_connectivity matches the brief.
      expect(bond_state.bond_connectivity.length).toBe(3)
      expect(bond_state.bond_connectivity.map((c: { site_idx_1: number; site_idx_2: number }) => [c.site_idx_1, c.site_idx_2])).toEqual([
        [2, 5],
        [4, 6],
        [1, 3],
      ])
      // Strengths preserved in original order.
      expect(bond_state.bond_connectivity[0].strength).toBeCloseTo(0.9)
      expect(bond_state.bond_connectivity[1].strength).toBeCloseTo(0.7)
      expect(bond_state.bond_connectivity[2].strength).toBeCloseTo(0.5)

      // Manager was also updated.
      expect(mgr.count).toBe(3)
      expect(snapshot_pairs(mgr)).toEqual([[2, 5], [4, 6], [1, 3]])

      // Fingerprints now reflect the post-delete sites.
      expect(bond_state.last_elem_fingerprint).not.toBe('')
      expect(bond_state.last_bond_fingerprint).toContain('|')
      // Strategy untouched.
      expect(bond_state.last_bond_strategy).toBe('atom_radii-{}')
    } finally { stop() }
  })

  it(`no-op on empty deleted_site_ids`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      mgr.add_bond(0, 1)
      bond_state.bond_connectivity = [{ site_idx_1: 0, site_idx_2: 1, strength: 1 }]
      const v0 = mgr.version
      const conn_before = bond_state.bond_connectivity
      apply_atom_delete_incremental(bond_state, [], mgr, [])
      expect(mgr.version).toBe(v0)
      // Reference unchanged — no-op short-circuit.
      expect(bond_state.bond_connectivity).toBe(conn_before)
    } finally { stop() }
  })

  it(`tolerates a null bond_manager (only touches bond_state)`, () => {
    const { bond_state, stop } = setup()
    try {
      bond_state.bond_connectivity = [
        { site_idx_1: 3, site_idx_2: 8, strength: 1 },
        { site_idx_1: 2, site_idx_2: 9, strength: 1 },
      ]
      const sites: Site[] = []
      for (let i = 0; i < 10; i++) sites.push(fake_site('C', [i, 0, 0]))
      const new_sites = sites.filter((_, i) => i !== 2 && i !== 5 && i !== 7)
      apply_atom_delete_incremental(bond_state, new Set([2, 5, 7]), null, new_sites)
      expect(bond_state.bond_connectivity.length).toBe(1)
      expect(bond_state.bond_connectivity[0]).toEqual({ site_idx_1: 2, site_idx_2: 5, strength: 1, jimage: [0, 0, 0] })
    } finally { stop() }
  })

  it(`refreshes last_bond_structure.sites when it was populated`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      const old_sites: Site[] = []
      for (let i = 0; i < 5; i++) old_sites.push(fake_site('H', [i, 0, 0]))
      // Pretend a prior computation set last_bond_structure.
      bond_state.last_bond_structure = {
        sites: old_sites,
        lattice: { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], pbc: [true, true, true] },
      } as any
      bond_state.bond_connectivity = [{ site_idx_1: 0, site_idx_2: 3, strength: 1 }]

      const new_sites = old_sites.filter((_, i) => i !== 1)
      apply_atom_delete_incremental(bond_state, [1], mgr, new_sites)

      expect(bond_state.last_bond_structure).not.toBeNull()
      // Svelte $state may proxy-wrap the stored object, so compare structurally.
      expect(bond_state.last_bond_structure!.sites.length).toBe(new_sites.length)
      expect(bond_state.last_bond_structure!.sites.length).toBe(4)
      // lattice preserved via shallow merge.
      expect((bond_state.last_bond_structure as any).lattice).toBeDefined()
      expect((bond_state.last_bond_structure as any).lattice.matrix).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    } finally { stop() }
  })
})

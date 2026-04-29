/**
 * Unit tests for the X6 bond-side controller helpers:
 *   - apply_atom_add_incremental
 *   - apply_atom_replace_incremental
 *   - apply_atom_move_incremental
 *
 * Mocks `compute_bonds_sync` from the worker API so the tests can prescribe
 * the "fresh" bond list and verify the diff-and-apply path. This mirrors the
 * design in bond-computation-controller.svelte.ts where the helpers delegate
 * fresh computation to that same entry point.
 *
 * Runs all reactive work inside `$effect.root` so `$state` reads are
 * observable as plain numbers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock MUST be hoisted before any import that transitively pulls the real
// module. The bond-computation-controller uses it internally.
vi.mock(`$lib/structure/workers/bond-worker-api`, () => ({
  compute_bonds_sync: vi.fn(() => [] as any[]),
  compute_bonds_async: vi.fn(() => Promise.resolve([])),
  compute_hbonds_worker: vi.fn(() => Promise.resolve(null)),
}))

import { BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import {
  apply_atom_add_incremental,
  apply_atom_move_incremental,
  apply_atom_replace_incremental,
  create_bond_state,
} from '$lib/structure/bond-computation-controller.svelte'
import { compute_bonds_sync } from '$lib/structure/workers/bond-worker-api'
import type { AnyStructure, Site } from '$lib'

// --- helpers ----------------------------------------------------------------

function setup() {
  let bond_state!: ReturnType<typeof create_bond_state>
  let mgr!: BondManager
  const stop = $effect.root(() => {
    bond_state = create_bond_state()
    mgr = new BondManager()
  })
  return { bond_state, mgr, stop }
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

function fake_structure(sites: Site[]): AnyStructure {
  return { sites } as unknown as AnyStructure
}

function fake_bond(a: number, b: number, strength = 1) {
  return {
    site_idx_1: a,
    site_idx_2: b,
    strength,
    pos_1: [0, 0, 0],
    pos_2: [0, 0, 0],
    bond_length: 1,
    transform_matrix: new Array(16).fill(0),
  }
}

function pair_set(mgr: BondManager): Set<string> {
  const s = new Set<string>()
  const buf = mgr.pairs_buffer
  for (let i = 0; i < mgr.count; i++) {
    const a = buf[i * 2]
    const b = buf[i * 2 + 1]
    s.add(`${Math.min(a, b)}-${Math.max(a, b)}`)
  }
  return s
}

beforeEach(() => {
  vi.mocked(compute_bonds_sync).mockReset()
})

// --- apply_atom_add_incremental ---------------------------------------------

describe(`apply_atom_add_incremental`, () => {
  it(`appends only the NEW bonds discovered post-add, keeps existing ones`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      // Pre-add: 3 atoms, bonds (0,1) and (1,2).
      bond_state.bond_connectivity = [
        { site_idx_1: 0, site_idx_2: 1, strength: 1 },
        { site_idx_1: 1, site_idx_2: 2, strength: 1 },
      ]
      mgr.add_bond(0, 1)
      mgr.add_bond(1, 2)
      const v0 = mgr.version
      const conn_len0 = bond_state.bond_connectivity.length

      // Post-add: atom 3 is new, bonded to 2. `fresh` returned by the mock
      // includes the existing pair + the new pair.
      vi.mocked(compute_bonds_sync).mockReturnValue([
        fake_bond(0, 1),
        fake_bond(1, 2),
        fake_bond(2, 3),
      ] as any)

      const new_sites = [
        fake_site('C', [0, 0, 0]),
        fake_site('C', [1, 0, 0]),
        fake_site('C', [2, 0, 0]),
        fake_site('C', [3, 0, 0]),
      ]
      const ok = apply_atom_add_incremental(
        bond_state,
        [{ site_id: 3 }],
        mgr,
        new_sites,
        fake_structure(new_sites),
        `atom_radii` as any,
        {},
      )
      expect(ok).toBe(true)
      // +1 bond appended.
      expect(bond_state.bond_connectivity.length).toBe(conn_len0 + 1)
      expect(bond_state.bond_connectivity.map((c: { site_idx_1: number; site_idx_2: number }) => [c.site_idx_1, c.site_idx_2])).toEqual([
        [0, 1],
        [1, 2],
        [2, 3],
      ])
      // Manager got the new pair too.
      expect(mgr.count).toBe(3)
      expect(pair_set(mgr).has('2-3')).toBe(true)
      // Version bumped (add_bonds is a mutation).
      expect(mgr.version).toBeGreaterThan(v0)
      // Fingerprints bumped.
      expect(bond_state.last_bond_fingerprint).toContain('|')
    } finally { stop() }
  })

  it(`falls back (returns false) above the small-structure threshold`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      const big_sites: Site[] = []
      for (let i = 0; i < 250; i++) big_sites.push(fake_site('C', [i, 0, 0]))
      const ok = apply_atom_add_incremental(
        bond_state,
        [{ site_id: 249 }],
        mgr,
        big_sites,
        fake_structure(big_sites),
        `atom_radii` as any,
        {},
      )
      expect(ok).toBe(false)
      // compute_bonds_sync was NOT called — we bailed before.
      expect(compute_bonds_sync).not.toHaveBeenCalled()
    } finally { stop() }
  })

  it(`no-op on empty added array — returns true without calling compute`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      const sites = [fake_site('C', [0, 0, 0])]
      const ok = apply_atom_add_incremental(
        bond_state,
        [],
        mgr,
        sites,
        fake_structure(sites),
        `atom_radii` as any,
        {},
      )
      expect(ok).toBe(true)
      expect(compute_bonds_sync).not.toHaveBeenCalled()
    } finally { stop() }
  })
})

// --- apply_atom_replace_incremental -----------------------------------------

describe(`apply_atom_replace_incremental`, () => {
  it(`adds new bonds and removes bonds no longer in fresh`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      // Pre-replace: bonds (0,1) and (1,2).
      bond_state.bond_connectivity = [
        { site_idx_1: 0, site_idx_2: 1, strength: 1 },
        { site_idx_1: 1, site_idx_2: 2, strength: 1 },
      ]
      mgr.add_bond(0, 1)
      mgr.add_bond(1, 2)

      // Post-replace (say we changed site 1's element so it no longer bonds to
      // atom 0 but now bonds to 3): fresh = [(1,2), (1,3)]. Bond (0,1) drops.
      vi.mocked(compute_bonds_sync).mockReturnValue([
        fake_bond(1, 2),
        fake_bond(1, 3),
      ] as any)

      const sites = [
        fake_site('C', [0, 0, 0]),
        fake_site('N', [1, 0, 0]),
        fake_site('C', [2, 0, 0]),
        fake_site('C', [3, 0, 0]),
      ]
      const ok = apply_atom_replace_incremental(
        bond_state,
        [{ site_id: 1 }],
        mgr,
        sites,
        fake_structure(sites),
        `atom_radii` as any,
        {},
      )
      expect(ok).toBe(true)

      // bond_connectivity overwritten to match fresh.
      expect(bond_state.bond_connectivity.length).toBe(2)
      const keys = bond_state.bond_connectivity.map((c: { site_idx_1: number; site_idx_2: number }) => `${Math.min(c.site_idx_1, c.site_idx_2)}-${Math.max(c.site_idx_1, c.site_idx_2)}`)
      expect(keys.sort()).toEqual(['1-2', '1-3'])

      // Manager: (0,1) gone, (1,2) kept, (1,3) added.
      expect(mgr.count).toBe(2)
      const mgr_keys = pair_set(mgr)
      expect(mgr_keys.has('0-1')).toBe(false)
      expect(mgr_keys.has('1-2')).toBe(true)
      expect(mgr_keys.has('1-3')).toBe(true)
    } finally { stop() }
  })

  it(`empties both sides when fresh is empty`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      bond_state.bond_connectivity = [
        { site_idx_1: 0, site_idx_2: 1, strength: 1 },
      ]
      mgr.add_bond(0, 1)

      vi.mocked(compute_bonds_sync).mockReturnValue([] as any)
      const sites = [fake_site('C', [0, 0, 0]), fake_site('C', [99, 0, 0])]
      const ok = apply_atom_replace_incremental(
        bond_state,
        [{ site_id: 1 }],
        mgr,
        sites,
        fake_structure(sites),
        `atom_radii` as any,
        {},
      )
      expect(ok).toBe(true)
      expect(bond_state.bond_connectivity.length).toBe(0)
      expect(mgr.count).toBe(0)
    } finally { stop() }
  })
})

// --- apply_atom_move_incremental --------------------------------------------

describe(`apply_atom_move_incremental`, () => {
  it(`adds bonds formed by the move and keeps unaffected bonds`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      bond_state.bond_connectivity = [
        { site_idx_1: 0, site_idx_2: 1, strength: 1 },
      ]
      mgr.add_bond(0, 1)

      // Atom 2 was moved close to 1; fresh now contains (0,1) + (1,2).
      vi.mocked(compute_bonds_sync).mockReturnValue([
        fake_bond(0, 1),
        fake_bond(1, 2),
      ] as any)

      const sites = [
        fake_site('C', [0, 0, 0]),
        fake_site('C', [1, 0, 0]),
        fake_site('C', [1.5, 0, 0]),
      ]
      const ok = apply_atom_move_incremental(
        bond_state,
        [{ site_id: 2 }],
        mgr,
        sites,
        fake_structure(sites),
        `atom_radii` as any,
        {},
      )
      expect(ok).toBe(true)
      expect(bond_state.bond_connectivity.length).toBe(2)
      expect(mgr.count).toBe(2)
      expect(pair_set(mgr).has('1-2')).toBe(true)
      expect(pair_set(mgr).has('0-1')).toBe(true)
    } finally { stop() }
  })

  it(`drops bonds broken by the move`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      bond_state.bond_connectivity = [
        { site_idx_1: 0, site_idx_2: 1, strength: 1 },
        { site_idx_1: 1, site_idx_2: 2, strength: 1 },
      ]
      mgr.add_bond(0, 1)
      mgr.add_bond(1, 2)

      // Atom 2 moved far away; fresh = [(0,1)] only.
      vi.mocked(compute_bonds_sync).mockReturnValue([
        fake_bond(0, 1),
      ] as any)

      const sites = [
        fake_site('C', [0, 0, 0]),
        fake_site('C', [1, 0, 0]),
        fake_site('C', [100, 0, 0]),
      ]
      const ok = apply_atom_move_incremental(
        bond_state,
        [{ site_id: 2 }],
        mgr,
        sites,
        fake_structure(sites),
        `atom_radii` as any,
        {},
      )
      expect(ok).toBe(true)
      expect(bond_state.bond_connectivity.length).toBe(1)
      expect(bond_state.bond_connectivity[0]).toMatchObject({ site_idx_1: 0, site_idx_2: 1 })
      expect(mgr.count).toBe(1)
      expect(pair_set(mgr).has('0-1')).toBe(true)
    } finally { stop() }
  })

  it(`falls back over the threshold`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      const big_sites: Site[] = []
      for (let i = 0; i < 250; i++) big_sites.push(fake_site('C', [i, 0, 0]))
      const ok = apply_atom_move_incremental(
        bond_state,
        [{ site_id: 0 }],
        mgr,
        big_sites,
        fake_structure(big_sites),
        `atom_radii` as any,
        {},
      )
      expect(ok).toBe(false)
    } finally { stop() }
  })
})

// --- fingerprint-bump parity across all three helpers ------------------------

describe(`X6 helpers — fingerprint + last_bond_structure refresh`, () => {
  it(`add: fingerprints + last_bond_structure.sites updated on success`, () => {
    const { bond_state, mgr, stop } = setup()
    try {
      bond_state.last_bond_structure = {
        sites: [fake_site('C', [0, 0, 0])],
        lattice: { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], pbc: [true, true, true] },
      } as any
      vi.mocked(compute_bonds_sync).mockReturnValue([] as any)
      const sites = [
        fake_site('C', [0, 0, 0]),
        fake_site('H', [1, 0, 0]),
      ]
      apply_atom_add_incremental(
        bond_state,
        [{ site_id: 1 }],
        mgr,
        sites,
        fake_structure(sites),
        `atom_radii` as any,
        {},
      )
      expect(bond_state.last_bond_structure).not.toBeNull()
      expect(bond_state.last_bond_structure!.sites.length).toBe(2)
      // lattice preserved through shallow merge.
      expect((bond_state.last_bond_structure as any).lattice).toBeDefined()
      expect(bond_state.last_bond_fingerprint).toContain('|')
      expect(bond_state.last_elem_fingerprint).not.toBe('')
    } finally { stop() }
  })

  it(`replace: tolerates null bond_manager (only touches bond_state)`, () => {
    const { bond_state, stop } = setup()
    try {
      bond_state.bond_connectivity = [
        { site_idx_1: 0, site_idx_2: 1, strength: 1 },
      ]
      vi.mocked(compute_bonds_sync).mockReturnValue([] as any)
      const sites = [
        fake_site('C', [0, 0, 0]),
        fake_site('N', [1, 0, 0]),
      ]
      const ok = apply_atom_replace_incremental(
        bond_state,
        [{ site_id: 1 }],
        null,
        sites,
        fake_structure(sites),
        `atom_radii` as any,
        {},
      )
      expect(ok).toBe(true)
      expect(bond_state.bond_connectivity.length).toBe(0)
    } finally { stop() }
  })
})

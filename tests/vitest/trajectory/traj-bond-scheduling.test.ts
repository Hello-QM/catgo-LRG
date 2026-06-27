// Trajectory bond scheduling + frame-cache sizing (fix #2).
//
// #2: the frame-keyed connectivity LRU cache must hold a full typical
//     trajectory (>32 frames) so loops/scrubs are O(1) hits, not recomputes.
//
// Trajectory frames run on the zero-latency sync path for ALL strategies at
// small N. (A #3 experiment that routed solid_angle to the async worker was
// reverted: it regressed desktop/web with a one-frame-stale render and was
// redundant with the extension-only solid_angle -> atom_radii downgrade.) The
// throttled async dispatch remains the fallback for large structures or when
// the sync WASM is not yet ready.
//
// The worker API is mocked so the routing is observable without WASM.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/structure/workers/bond-worker-api', () => ({
  compute_bonds_sync: vi.fn(() => null),
  compute_bonds_async: vi.fn(() => Promise.resolve([])),
  compute_hbonds_worker: vi.fn(() => Promise.resolve([])),
}))

import {
  compute_bonds_async,
  compute_bonds_sync,
} from '$lib/structure/workers/bond-worker-api'
import {
  clear_trajectory_bond_frame_cache,
  compute_bond_connectivity_for_frame,
  create_bond_state,
} from '$lib/structure/bond-computation-controller.svelte'
import type { AnyStructure, BondPair, Site } from '$lib'

const sync_mock = vi.mocked(compute_bonds_sync)
const async_mock = vi.mocked(compute_bonds_async)

function fake_site(el: string, x: number): Site {
  return {
    species: [{ element: el, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz: [x, 0, 0],
    label: el,
    properties: {},
  } as unknown as Site
}

// Small, non-periodic structure (no lattice → pbc-less, like the diagnosed file).
function make_structure(n: number): AnyStructure {
  const sites: Site[] = []
  for (let i = 0; i < n; i++) sites.push(fake_site(i % 2 === 0 ? 'C' : 'H', i))
  return { sites } as unknown as AnyStructure
}

function make_frame(n: number): Float32Array {
  const f = new Float32Array(n * 3)
  for (let i = 0; i < f.length; i++) f[i] = Math.random()
  return f
}

function fake_bond(i: number, j: number): BondPair {
  return {
    pos_1: [0, 0, 0],
    pos_2: [0, 0, 0],
    site_idx_1: i,
    site_idx_2: j,
    bond_length: 1,
    strength: 1,
    transform_matrix: new Float32Array(16),
    jimage: [0, 0, 0],
  }
}

beforeEach(() => {
  clear_trajectory_bond_frame_cache()
  sync_mock.mockReset()
  async_mock.mockReset()
  sync_mock.mockReturnValue([fake_bond(0, 1)])
  async_mock.mockImplementation(() => new Promise<BondPair[]>(() => {})) // pending
})

describe('fix #2 — trajectory frame cache holds a full trajectory (>32 frames)', () => {
  it('keeps >32 frames so an early frame is a cache HIT after 64 distinct frames', () => {
    const st = create_bond_state()
    const structure = make_structure(4)
    const frames = Array.from({ length: 64 }, () => make_frame(4))

    const first = frames.map((f) =>
      compute_bond_connectivity_for_frame(st, f, structure, 'always', null, 'atom_radii', {})
    )
    expect(sync_mock).toHaveBeenCalledTimes(64)

    sync_mock.mockClear()
    // Re-request frame 0. At the old cap of 32 it would have been evicted by the
    // 63 newer frames (perpetual miss → recompute). At 512 it is still cached.
    const again = compute_bond_connectivity_for_frame(
      st, frames[0], structure, 'always', null, 'atom_radii', {},
    )
    expect(sync_mock).not.toHaveBeenCalled() // cache hit, no recompute
    expect(again).toBe(first[0]) // same array reference (the cached connectivity)
  })

  it('still bounds the cache (eviction past the 512 cap)', () => {
    const st = create_bond_state()
    const structure = make_structure(4)
    const frames = Array.from({ length: 600 }, () => make_frame(4))
    for (const f of frames) {
      compute_bond_connectivity_for_frame(st, f, structure, 'always', null, 'atom_radii', {})
    }
    sync_mock.mockClear()
    // frame 0 was inserted first; after 599 newer frames (>512) it is evicted →
    // miss → one recompute. Proves the LRU eviction still bounds memory.
    compute_bond_connectivity_for_frame(st, frames[0], structure, 'always', null, 'atom_radii', {})
    expect(sync_mock).toHaveBeenCalledTimes(1)
  })
})

describe('trajectory frames run on the zero-latency sync path at small N', () => {
  it.each(['atom_radii', 'electroneg_ratio', 'solid_angle'] as const)(
    'strategy %s uses the sync path (no async worker) for a small frame',
    (strat) => {
      const st = create_bond_state()
      const structure = make_structure(4)
      const frame = make_frame(4)

      const result = compute_bond_connectivity_for_frame(
        st, frame, structure, 'always', null, strat, {},
      )

      // The #3 async routing for solid_angle was reverted: every strategy now
      // runs synchronously at small N (desktop/web were already smooth there).
      expect(sync_mock).toHaveBeenCalledTimes(1)
      expect(sync_mock.mock.calls[0][1]).toBe(strat)
      expect(async_mock).not.toHaveBeenCalled()
      expect(result.length).toBe(1)
    },
  )

  it('falls back to the throttled async dispatch (latest-wins) when sync WASM is unavailable', () => {
    const st = create_bond_state()
    sync_mock.mockReturnValue(null) // WASM not ready → sync path can't resolve
    const structure = make_structure(4)
    const frame_a = make_frame(4)
    const frame_b = make_frame(4)

    compute_bond_connectivity_for_frame(st, frame_a, structure, 'always', null, 'solid_angle', {})
    compute_bond_connectivity_for_frame(st, frame_b, structure, 'always', null, 'solid_angle', {})

    expect(async_mock).toHaveBeenCalledTimes(1) // only one in-flight dispatch
    expect(st.traj_in_flight_frame).toBe(frame_a)
    expect(st.traj_pending_frame).toBe(frame_b)
  })
})

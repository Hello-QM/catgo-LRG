// Fix #4 — never-gate on the trajectory bond driver.
//
// wire_trajectory_bond_cache installs a driver $effect that, for every
// trajectory frame, calls cache.on_frame_change -> compute_bonds_async (+ ±5
// prefetch) plus per-frame build_frame_structure clones. It was gated only on
// the WebGPU-suspend flag, so it kept running the heavy solid_angle detector
// every frame even when bonds are 'never' — yet its output prop is unread while
// hidden. Fix #4 folds show_bonds==='never' into the suspend path so no per-frame
// bond compute is dispatched while bonds are hidden, and re-primes on un-hide.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/structure/workers/bond-worker-api', () => ({
  compute_bonds_sync: vi.fn(() => null),
  compute_bonds_async: vi.fn(() => Promise.resolve([])),
  compute_hbonds_worker: vi.fn(() => Promise.resolve([])),
}))

import { create_trajectory_bond_cache } from '$lib/structure/trajectory-bond-cache.svelte'
import { make_wire_harness } from './wire-never-harness.svelte'
import type { AnyStructure, Site } from '$lib'

function make_structure(n: number): AnyStructure {
  const sites: Site[] = []
  for (let i = 0; i < n; i++) {
    sites.push({
      species: [{ element: i % 2 === 0 ? 'C' : 'H', occu: 1, oxidation_state: 0 }],
      abc: [0, 0, 0],
      xyz: [i, 0, 0],
      label: 'X',
      properties: {},
    } as unknown as Site)
  }
  return { sites } as unknown as AnyStructure
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fix #4 — never-gate', () => {
  it('does NOT dispatch per-frame bond compute when show_bonds is never', () => {
    const cache = create_trajectory_bond_cache()
    const spy = vi.spyOn(cache, 'on_frame_change').mockImplementation(() => {})
    const h = make_wire_harness(cache, { structure: make_structure(4), show: 'never' })
    try {
      h.set_step(1)
      h.flush()
      h.set_step(2)
      h.flush()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      h.stop()
    }
  })

  it('DOES dispatch per-frame bond compute when show_bonds is always (regression)', () => {
    const cache = create_trajectory_bond_cache()
    const spy = vi.spyOn(cache, 'on_frame_change').mockImplementation(() => {})
    const h = make_wire_harness(cache, { structure: make_structure(4), show: 'always' })
    try {
      h.set_step(1)
      h.flush()
      expect(spy).toHaveBeenCalled()
    } finally {
      h.stop()
    }
  })

  it('re-primes the landing frame after un-hiding bonds (never -> always)', () => {
    const cache = create_trajectory_bond_cache()
    const spy = vi.spyOn(cache, 'on_frame_change').mockImplementation(() => {})
    const h = make_wire_harness(cache, { structure: make_structure(4), show: 'never' })
    try {
      h.set_step(1)
      h.flush()
      h.set_step(2)
      h.flush()
      expect(spy).not.toHaveBeenCalled()
      h.set_show('always')
      h.flush()
      expect(spy).toHaveBeenCalled()
    } finally {
      h.stop()
    }
  })
})

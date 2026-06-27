// Fix #E — extension-only, trajectory-only solid_angle -> atom_radii downgrade.
//
// In the VS Code webview the WASM runtime runs solid_angle too slowly for
// smooth playback, so compute_bond_connectivity_for_frame transparently
// downgrades trajectory-frame bonding to the cheap atom_radii strategy when the
// build-time token __CATGO_VSCODE_EXTENSION__ is true. Desktop/web (token
// undefined) must be byte-identical, and the STATIC bond path (the separate
// compute_bond_connectivity) must keep honoring the user's saved solid_angle
// even inside the extension.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  compute_bond_connectivity,
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

function make_structure(n: number): AnyStructure {
  const sites: Site[] = []
  for (let i = 0; i < n; i++) sites.push(fake_site(i % 2 === 0 ? 'C' : 'H', i))
  return { sites } as unknown as AnyStructure
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

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__CATGO_VSCODE_EXTENSION__
})

describe('fix #E — VS Code extension trajectory downgrade', () => {
  it('downgrades solid_angle -> atom_radii for trajectory frames in the extension', () => {
    ;(globalThis as Record<string, unknown>).__CATGO_VSCODE_EXTENSION__ = true
    const st = create_bond_state()
    const structure = make_structure(4)
    const frame = new Float32Array(12)

    compute_bond_connectivity_for_frame(st, frame, structure, 'always', null, 'solid_angle', {})

    // Downgraded to the cheap atom_radii, which stays on the sync path.
    expect(sync_mock).toHaveBeenCalledTimes(1)
    expect(sync_mock.mock.calls[0][1]).toBe('atom_radii')
    expect(sync_mock.mock.calls[0][2]).toEqual({})
    expect(async_mock).not.toHaveBeenCalled()
  })

  it('desktop/web (token undefined) keep solid_angle for trajectory frames', () => {
    // No token set → typeof guard short-circuits → no downgrade. With the #3
    // async-routing experiment reverted, solid_angle now runs on the
    // zero-latency sync path at small N (desktop/web were already smooth there),
    // byte-identical to the pre-round-1 behavior.
    const st = create_bond_state()
    const structure = make_structure(4)
    const frame = new Float32Array(12)

    compute_bond_connectivity_for_frame(st, frame, structure, 'always', null, 'solid_angle', {})

    expect(sync_mock).toHaveBeenCalledTimes(1)
    expect(sync_mock.mock.calls[0][1]).toBe('solid_angle')
    expect(async_mock).not.toHaveBeenCalled()
  })

  it('static (non-trajectory) bonds in the extension still honor solid_angle', () => {
    ;(globalThis as Record<string, unknown>).__CATGO_VSCODE_EXTENSION__ = true
    const st = create_bond_state()
    const structure = make_structure(4)

    compute_bond_connectivity(
      st,
      () => {}, // bond_pairs_setter (no-op)
      structure,
      'always',
      null,
      'solid_angle',
      {},
      false,
    )

    // The static path is a different function/cache; the downgrade must not
    // reach it — the user's saved solid_angle is preserved.
    expect(sync_mock).toHaveBeenCalledTimes(1)
    expect(sync_mock.mock.calls[0][1]).toBe('solid_angle')
  })
})

// Fix B — the SLOW path (compute_bond_connectivity) is what variable-N
// trajectories (no constant atom count → no position_cache → no
// trajectory_frame_positions fast-path) drive once per frame. The same
// extension-only solid_angle -> atom_radii downgrade must apply there, but ONLY
// when the caller signals a trajectory frame (is_trajectory_frame=true).
describe('fix B — slow-path (compute_bond_connectivity) trajectory downgrade', () => {
  it('extension + is_trajectory_frame=true downgrades solid_angle -> atom_radii (no main-thread solid_angle)', () => {
    ;(globalThis as Record<string, unknown>).__CATGO_VSCODE_EXTENSION__ = true
    const st = create_bond_state()
    const structure = make_structure(4)

    compute_bond_connectivity(
      st, () => {}, structure, 'always', null, 'solid_angle', {}, false, true,
    )

    expect(sync_mock).toHaveBeenCalledTimes(1)
    expect(sync_mock.mock.calls[0][1]).toBe('atom_radii')
    expect(sync_mock.mock.calls[0][2]).toEqual({})
  })

  it('extension + is_trajectory_frame=false keeps the user solid_angle (static structures)', () => {
    ;(globalThis as Record<string, unknown>).__CATGO_VSCODE_EXTENSION__ = true
    const st = create_bond_state()
    const structure = make_structure(4)

    compute_bond_connectivity(
      st, () => {}, structure, 'always', null, 'solid_angle', {}, false, false,
    )

    expect(sync_mock).toHaveBeenCalledTimes(1)
    expect(sync_mock.mock.calls[0][1]).toBe('solid_angle')
  })

  it('desktop (token undefined) keeps solid_angle for BOTH is_trajectory_frame values', () => {
    // is_trajectory_frame=true — but no token, so no downgrade.
    sync_mock.mockClear()
    compute_bond_connectivity(
      create_bond_state(), () => {}, make_structure(4), 'always', null, 'solid_angle', {}, false, true,
    )
    expect(sync_mock).toHaveBeenCalledTimes(1)
    expect(sync_mock.mock.calls[0][1]).toBe('solid_angle')

    // is_trajectory_frame=false — likewise keeps solid_angle.
    sync_mock.mockClear()
    compute_bond_connectivity(
      create_bond_state(), () => {}, make_structure(5), 'always', null, 'solid_angle', {}, false, false,
    )
    expect(sync_mock).toHaveBeenCalledTimes(1)
    expect(sync_mock.mock.calls[0][1]).toBe('solid_angle')
  })
})

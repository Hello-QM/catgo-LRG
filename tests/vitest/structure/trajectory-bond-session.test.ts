import { describe, expect, test } from 'vitest'
import {
  assert_trajectory_bond_frame_length,
  same_trajectory_bond_topology,
  TrajectoryBondFrameLengthError,
  trajectory_bond_topology_fingerprint,
  type TrajectoryBondSessionDescriptor,
} from '$lib/structure/trajectory-bond-session'

function descriptor(
  overrides: Partial<TrajectoryBondSessionDescriptor> = {},
): TrajectoryBondSessionDescriptor {
  return {
    atomic_numbers: Uint8Array.from([6, 8]),
    site_ids: Uint32Array.from([17, 29]),
    pbc: [true, false, true],
    strategy: `atom_radii`,
    options: { tolerance: 1.1, min_dist: 0.01 },
    rules_version: `rules-v3`,
    ...overrides,
  }
}

describe(`trajectory bond topology identity`, () => {
  test(`copied equal descriptor data has one topology fingerprint`, () => {
    const left = descriptor()
    const right = descriptor({
      atomic_numbers: left.atomic_numbers.slice(),
      site_ids: left.site_ids?.slice() ?? null,
      pbc: left.pbc ? [...left.pbc] : null,
      options: { min_dist: 0.01, tolerance: 1.1 },
    })

    expect(same_trajectory_bond_topology(left, right)).toBe(true)
    expect(trajectory_bond_topology_fingerprint(left)).toBe(
      trajectory_bond_topology_fingerprint(right),
    )
  })

  test(`changes to every topology field produce a distinct identity`, () => {
    const base = descriptor()
    const changes = [
      descriptor({ atomic_numbers: Uint8Array.from([6, 8, 1]) }),
      descriptor({ atomic_numbers: Uint8Array.from([6, 7]) }),
      descriptor({ site_ids: Uint32Array.from([17, 31]) }),
      descriptor({ site_ids: null }),
      descriptor({ pbc: [true, true, true] }),
      descriptor({ options: { tolerance: 1.2, min_dist: 0.01 } }),
      descriptor({ rules_version: `rules-v4` }),
    ]
    const fingerprint = trajectory_bond_topology_fingerprint(base)

    for (const changed of changes) {
      expect(same_trajectory_bond_topology(base, changed)).toBe(false)
      expect(trajectory_bond_topology_fingerprint(changed)).not.toBe(
        fingerprint,
      )
    }
  })

  test(`a missing stable-ID sequence is distinct from available IDs`, () => {
    const unavailable = descriptor({ site_ids: null })
    const available = descriptor({ site_ids: Uint32Array.from([0, 1]) })

    expect(same_trajectory_bond_topology(unavailable, available)).toBe(false)
    expect(trajectory_bond_topology_fingerprint(unavailable)).not.toBe(
      trajectory_bond_topology_fingerprint(available),
    )
  })

  test(`same-count motion cannot affect an identity without stable IDs`, () => {
    const topology = descriptor({ site_ids: null })
    const before = trajectory_bond_topology_fingerprint(topology)
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0])
    positions.set([9, 8, 7, 6, 5, 4])

    expect(trajectory_bond_topology_fingerprint(topology)).toBe(before)
  })
})

describe(`trajectory bond frame length validation`, () => {
  test(`throws a typed error with complete frame and session details`, () => {
    let failure: unknown
    try {
      assert_trajectory_bond_frame_length(41, 2, 9, 12)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(TrajectoryBondFrameLengthError)
    expect(failure).toMatchObject({
      name: `TrajectoryBondFrameLengthError`,
      session_id: 41,
      expected_atom_count: 2,
      expected_float_count: 6,
      actual_float_count: 9,
      frame_idx: 12,
    })
    expect((failure as Error).message).toContain(
      `trajectory bond session 41 frame 12`,
    )
  })

  test(`accepts exact xyz triples and normalizes an omitted frame index`, () => {
    expect(() =>
      assert_trajectory_bond_frame_length(1, 2, 6)
    ).not.toThrow()

    let failure: unknown
    try {
      assert_trajectory_bond_frame_length(1, 2, 3)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ frame_idx: null })
  })
})

import { describe, expect, it } from 'vitest'
import type { RenderPacket } from '$lib/structure/scene/render-packet'
import { matching_trajectory_bond_graph } from '$lib/structure/gpu/trajectory-bond-snapshot'

function packet(
  positions: Float32Array,
  frame_idx = 7,
  atom_count = 2,
): RenderPacket {
  return {
    topology: {
      version: 1,
      atom_count,
      site_ids: new Uint32Array(atom_count),
      atomic_numbers: new Uint8Array(atom_count),
      colors: new Float32Array(atom_count * 3),
      radii: new Float32Array(atom_count),
      bond_graph: {
        version: 9,
        pairs: new Uint32Array([0, 1]),
        jimages: new Int8Array([0, 0, 0]),
        kinds: new Uint8Array([0]),
        strengths: new Float32Array([1]),
      },
    },
    frame: {
      owner: {},
      frame_idx,
      positions_version: 3,
      positions,
      lattice: new Float32Array(9),
    },
    replicas: {
      version: 1,
      dims: [1, 1, 1],
      boundary_policy: `stub`,
      semantics: `visual-shared-base`,
    },
  }
}

describe(`large-system trajectory bond snapshot`, () => {
  it(`accepts the graph paired with the exact presented position buffer`, () => {
    const positions = new Float32Array(6)
    const prepared = packet(positions)

    expect(matching_trajectory_bond_graph(prepared, positions, 7, 2))
      .toBe(prepared.topology.bond_graph)
  })

  it(`rejects a previous-frame graph even when shape and frame index look valid`, () => {
    const prepared = packet(new Float32Array(6))
    const current_positions = new Float32Array(6)

    expect(matching_trajectory_bond_graph(
      prepared,
      current_positions,
      7,
      2,
    )).toBeNull()
  })

  it(`rejects frame-index and topology-owner shape mismatches`, () => {
    const positions = new Float32Array(6)
    const prepared = packet(positions)

    expect(matching_trajectory_bond_graph(prepared, positions, 8, 2))
      .toBeNull()
    expect(matching_trajectory_bond_graph(prepared, positions, 7, 3))
      .toBeNull()
  })
})

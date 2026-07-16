import { describe, expect, test } from 'vitest'
import {
  assert_render_packet,
  diff_render_packet,
} from '$lib/structure/scene/render-packet'
import type {
  BaseBondGraph,
  BaseTopology,
  FrameGeometry,
  RenderPacket,
  ReplicaLayout,
} from '$lib/structure/scene/render-packet'

// --- fixtures ------------------------------------------------------------

function make_topology(
  atom_count = 2,
  version = 1,
  bond_graph?: BaseBondGraph,
): BaseTopology {
  return {
    version,
    atom_count,
    site_ids: Uint32Array.from({ length: atom_count }, (_, i) => i),
    atomic_numbers: Uint8Array.from({ length: atom_count }, () => 6),
    radii: Float32Array.from({ length: atom_count }, () => 0.7),
    colors: Float32Array.from({ length: atom_count * 3 }, () => 0.5),
    bond_graph,
  }
}

function make_bond_graph(version = 1): BaseBondGraph {
  return {
    version,
    pairs: Uint32Array.from([0, 1]),
    jimages: Int8Array.from([0, 0, 0]),
    kinds: Uint8Array.from([0]),
    strengths: Float32Array.from([1]),
  }
}

function make_frame(
  atom_count = 2,
  frame_idx = 0,
  positions_version = 1,
  owner: object = { id: `scene` },
): FrameGeometry {
  return {
    owner,
    frame_idx,
    positions_version,
    positions: Float32Array.from({ length: atom_count * 3 }, () => 0),
    lattice: Float32Array.from([10, 0, 0, 0, 10, 0, 0, 0, 10]),
  }
}

function make_replicas(version = 1): ReplicaLayout {
  return {
    version,
    dims: [1, 1, 1],
    boundary_policy: `stub`,
    semantics: `visual-shared-base`,
  }
}

function make_packet(overrides: Partial<RenderPacket> = {}): RenderPacket {
  return {
    topology: make_topology(),
    frame: make_frame(),
    replicas: make_replicas(),
    ...overrides,
  }
}

// --- assert_render_packet ------------------------------------------------

describe(`assert_render_packet`, () => {
  test(`accepts a valid packet`, () => {
    expect(() => assert_render_packet(make_packet())).not.toThrow()
  })

  test(`rejects positions.length !== 3 × atom_count (3N validation)`, () => {
    const packet = make_packet({
      frame: {
        ...make_frame(),
        // 2 atoms wants 6 floats; give 5
        positions: Float32Array.from([0, 0, 0, 0, 0]),
      },
    })
    expect(() => assert_render_packet(packet)).toThrow(/positions/)
  })

  test(`rejects a bond graph with mismatched pair/kind/jimage lengths`, () => {
    const bad_bond_graph: BaseBondGraph = {
      version: 1,
      pairs: Uint32Array.from([0, 1, 1, 0]), // 2 bonds
      jimages: Int8Array.from([0, 0, 0]), // only 1 bond's worth
      kinds: Uint8Array.from([0, 0]),
      strengths: Float32Array.from([1, 1]),
    }
    const packet = make_packet({ topology: make_topology(2, 1, bad_bond_graph) })
    expect(() => assert_render_packet(packet)).toThrow(/jimage/)
  })

  test(`rejects a lattice that is not 9 floats`, () => {
    const packet = make_packet({
      frame: { ...make_frame(), lattice: Float32Array.from([1, 0, 0]) },
    })
    expect(() => assert_render_packet(packet)).toThrow(/lattice/)
  })

  test(`rejects replica dims below 1`, () => {
    const packet = make_packet({ replicas: { ...make_replicas(), dims: [0, 1, 1] } })
    expect(() => assert_render_packet(packet)).toThrow(/dims/)
  })

  test(`accepts a valid packet carrying a bond graph`, () => {
    const packet = make_packet({
      topology: make_topology(2, 1, make_bond_graph()),
    })
    expect(() => assert_render_packet(packet)).not.toThrow()
  })
})

// --- diff_render_packet --------------------------------------------------

describe(`diff_render_packet`, () => {
  test(`a replica-only change is distinguishable and does NOT invalidate bonds`, () => {
    const prev = make_packet({
      topology: make_topology(2, 7, make_bond_graph(3)),
      replicas: make_replicas(1),
    })
    const next = make_packet({
      topology: make_topology(2, 7, make_bond_graph(3)),
      replicas: make_replicas(2), // only the replica version bumped
      frame: prev.frame, // same frame
    })
    const diff = diff_render_packet(prev, next)
    expect(diff.replica_changed).toBe(true)
    expect(diff.topology_changed).toBe(false)
    expect(diff.bond_graph_changed).toBe(false)
    expect(diff.frame_changed).toBe(false)
  })

  test(`a topology version bump is reported`, () => {
    const prev = make_packet({ topology: make_topology(2, 1) })
    const next = make_packet({ topology: make_topology(2, 2), frame: prev.frame })
    const diff = diff_render_packet(prev, next)
    expect(diff.topology_changed).toBe(true)
  })

  test(`a bond-graph version bump is reported separately from topology`, () => {
    const prev = make_packet({ topology: make_topology(2, 5, make_bond_graph(1)) })
    const next = make_packet({
      topology: make_topology(2, 5, make_bond_graph(2)),
      frame: prev.frame,
    })
    const diff = diff_render_packet(prev, next)
    expect(diff.bond_graph_changed).toBe(true)
    expect(diff.topology_changed).toBe(false)
  })

  test(`a plain frame advance is reported as frame_changed only`, () => {
    const prev = make_packet()
    const next = make_packet({
      frame: make_frame(2, 1, 2), // frame_idx + positions_version bumped
    })
    const diff = diff_render_packet(prev, next)
    expect(diff.frame_changed).toBe(true)
    expect(diff.topology_changed).toBe(false)
    expect(diff.replica_changed).toBe(false)
    expect(diff.bond_graph_changed).toBe(false)
  })
})

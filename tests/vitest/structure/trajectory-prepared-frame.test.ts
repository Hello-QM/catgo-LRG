import { describe, expect, test } from 'vitest'
import type {
  BaseBondGraph,
  RenderPacket,
} from '$lib/structure/scene/render-packet'
import {
  prepared_frame_byte_size,
  same_prepared_frame_key,
  type PreparedFrameKey,
  type PreparedTrajectoryFrame,
} from '$lib/structure/trajectory-prepared-frame'

const owner = { id: `trajectory` }

function make_graph(): BaseBondGraph {
  return {
    version: 4,
    pairs: Uint32Array.from([0, 1]),
    jimages: Int8Array.from([1, 0, 0]),
    kinds: Uint8Array.from([0]),
    strengths: Float32Array.from([0.8]),
  }
}

function make_packet(graph = make_graph()): RenderPacket {
  return {
    topology: {
      version: 3,
      atom_count: 2,
      site_ids: Uint32Array.from([0, 1]),
      atomic_numbers: Uint8Array.from([6, 8]),
      radii: Float32Array.from([0.7, 0.6]),
      colors: Float32Array.from([1, 0, 0, 0, 0, 1]),
      bond_graph: graph,
    },
    frame: {
      owner,
      frame_idx: 7,
      positions_version: 9,
      positions: Float32Array.from([0, 0, 0, 1, 0, 0]),
      lattice: Float32Array.from([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    },
    replicas: {
      version: 2,
      dims: [1, 1, 1],
      boundary_policy: `stub`,
      semantics: `visual-shared-base`,
    },
  }
}

function make_key(overrides: Partial<PreparedFrameKey> = {}): PreparedFrameKey {
  return {
    owner,
    frame_idx: 7,
    positions_version: 9,
    topology_version: 3,
    rules_version: `atom-radii:1.1`,
    ...overrides,
  }
}

describe(`same_prepared_frame_key`, () => {
  test(`requires owner identity and every version field to match`, () => {
    const key = make_key()
    expect(same_prepared_frame_key(key, make_key())).toBe(true)

    const changes: PreparedFrameKey[] = [
      make_key({ owner: { id: `trajectory` } }),
      make_key({ frame_idx: 8 }),
      make_key({ positions_version: 10 }),
      make_key({ topology_version: 4 }),
      make_key({ rules_version: `atom-radii:1.2` }),
    ]
    for (const changed of changes) {
      expect(same_prepared_frame_key(key, changed)).toBe(false)
    }
  })
})

describe(`prepared_frame_byte_size`, () => {
  test(`counts retained packet, graph, lattice, and RGBA arrays exactly once`, () => {
    const packet = make_packet()
    const rgba = new Float32Array(8)

    // positions 24 + rgba 32 + lattice 36 + site_ids 8 +
    // atomic_numbers 2 + radii 8 + colors 24 + bond graph 16 = 150 bytes.
    expect(prepared_frame_byte_size(packet, rgba, null)).toBe(150)
  })

  test(`adds optional force and physical-site-map storage`, () => {
    const packet = make_packet()
    packet.replicas = {
      ...packet.replicas,
      dims: [2, 1, 1],
      semantics: `physical-distinct-sites`,
      physical_site_map: Uint32Array.from([0, 1, 2, 3]),
    }
    const rgba = new Float32Array(8)
    const forces = new Float32Array(6)

    expect(prepared_frame_byte_size(packet, rgba, forces)).toBe(190)
  })

  test(`does not count aliased graph arrays twice`, () => {
    const packet = make_packet()
    const rgba = new Float32Array(8)
    const forces = new Float32Array(6)
    const prepared: PreparedTrajectoryFrame = {
      key: make_key(),
      packet,
      graph: packet.topology.bond_graph!,
      gpu_positions_rgba: rgba,
      forces,
      graph_hash: `hash`,
      byte_size: prepared_frame_byte_size(packet, rgba, forces),
      compute_ms: 3.5,
    }

    expect(prepared.graph).toBe(prepared.packet.topology.bond_graph)
    expect(prepared.byte_size).toBe(174)
  })
})

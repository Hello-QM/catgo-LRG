import { describe, expect, test, vi } from 'vitest'
import type { RenderPacket } from '$lib/structure/scene/render-packet'
import {
  create_prepared_frame_pipeline,
  prepared_frame_byte_size,
  type PreparedFrameKey,
  type PreparedTrajectoryFrame,
} from '$lib/structure/trajectory-prepared-frame'

function key(owner: object, frame_idx: number): PreparedFrameKey {
  return {
    owner,
    frame_idx,
    positions_version: 1,
    topology_version: 1,
    rules_version: `exact`,
  }
}

function prepared(frame_key: PreparedFrameKey): PreparedTrajectoryFrame {
  const positions = new Float32Array([frame_key.frame_idx, 0, 0])
  const graph = {
    version: frame_key.frame_idx + 1,
    pairs: new Uint32Array([0, 0]),
    jimages: new Int8Array([frame_key.frame_idx + 1, 0, 0]),
    kinds: new Uint8Array([0]),
    strengths: new Float32Array([1]),
  }
  const packet: RenderPacket = {
    topology: {
      version: 1,
      atom_count: 1,
      site_ids: new Uint32Array([0]),
      atomic_numbers: new Uint8Array([1]),
      radii: new Float32Array([1]),
      colors: new Float32Array([1, 1, 1]),
      bond_graph: graph,
    },
    frame: {
      owner: frame_key.owner,
      frame_idx: frame_key.frame_idx,
      positions_version: 1,
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
  const rgba = new Float32Array([frame_key.frame_idx, 0, 0, 1])
  return {
    key: frame_key,
    packet,
    graph,
    gpu_positions_rgba: rgba,
    forces: null,
    graph_hash: `${frame_key.frame_idx}`,
    byte_size: prepared_frame_byte_size(packet, rgba, null),
    compute_ms: 1,
  }
}

describe(`exact trajectory scheduling`, () => {
  test(`64 distinct requested frames cause 64 exact computes`, async () => {
    const owner = {}
    const pipeline = create_prepared_frame_pipeline({
      max_frames: 64,
      max_bytes: 1_000_000,
    })
    const compute = vi.fn(async (frame_key: PreparedFrameKey) =>
      prepared(frame_key)
    )
    for (let frame_idx = 0; frame_idx < 64; frame_idx++) {
      const frame_key = key(owner, frame_idx)
      const generation = pipeline.begin_request(frame_key)
      const outcome = await pipeline.request({
        key: frame_key,
        priority: `current`,
        estimated_bytes: 128,
        prepare: () => compute(frame_key),
      }, generation)
      expect(outcome.status).toBe(`ready`)
      if (outcome.status === `ready`) {
        expect(outcome.value.packet.frame.frame_idx).toBe(frame_idx)
        expect(outcome.value.graph.jimages[0]).toBe(frame_idx + 1)
      }
    }
    expect(compute).toHaveBeenCalledTimes(64)

    const first_key = key(owner, 0)
    const outcome = await pipeline.request({
      key: first_key,
      priority: `current`,
      estimated_bytes: 128,
      prepare: () => compute(first_key),
    }, pipeline.begin_request(first_key))
    expect(outcome).toMatchObject({ status: `ready`, cache_hit: true })
    expect(compute).toHaveBeenCalledTimes(64)
  })

  test(`a stale seek result never replaces the requested frame graph`, async () => {
    const owner = {}
    const pipeline = create_prepared_frame_pipeline()
    let resolve_old!: (value: PreparedTrajectoryFrame) => void
    const old_key = key(owner, 4)
    const old_generation = pipeline.begin_request(old_key)
    const old = pipeline.request({
      key: old_key,
      priority: `current`,
      estimated_bytes: 128,
      prepare: () => new Promise((resolve) => {
        resolve_old = resolve
      }),
    }, old_generation)

    const new_key = key(owner, 19)
    const new_generation = pipeline.begin_request(new_key)
    resolve_old(prepared(old_key))
    expect(await old).toEqual({ status: `stale` })

    const current = await pipeline.request({
      key: new_key,
      priority: `current`,
      estimated_bytes: 128,
      prepare: async () => prepared(new_key),
    }, new_generation)
    expect(current.status).toBe(`ready`)
    if (current.status === `ready`) {
      expect(current.value.packet.frame.frame_idx).toBe(19)
      expect(current.value.graph.jimages[0]).toBe(20)
    }
    expect(pipeline.peek(old_key)).toBeNull()
  })
})

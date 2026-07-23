import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  BaseBondGraph,
  RenderPacket,
} from '$lib/structure/scene/render-packet'
import {
  create_prepared_frame_pipeline,
  prepared_frame_byte_size,
  same_prepared_frame_key,
  type PreparedFrameKey,
  type PreparedFrameOutcome,
  type PreparedTrajectoryFrame,
} from '$lib/structure/trajectory-prepared-frame'
import { trajectory_render_diagnostics } from '$lib/structure/trajectory-render-diagnostics'

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

function make_prepared(
  key: PreparedFrameKey,
  byte_size = 64,
): PreparedTrajectoryFrame {
  const packet = make_packet()
  packet.frame = {
    ...packet.frame,
    owner: key.owner,
    frame_idx: key.frame_idx,
    positions_version: key.positions_version,
  }
  packet.topology = {
    ...packet.topology,
    version: key.topology_version,
  }
  return {
    key,
    packet,
    graph: packet.topology.bond_graph!,
    gpu_positions_rgba: new Float32Array(8),
    forces: null,
    graph_hash: `frame-${key.frame_idx}`,
    byte_size,
    compute_ms: 1,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe(`create_prepared_frame_pipeline`, () => {
  beforeEach(() => {
    trajectory_render_diagnostics.reset()
  })

  test(`deduplicates identical queued or in-flight keys onto one promise`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const key = make_key()
    const generation = pipeline.begin_request(key)
    const work = deferred<PreparedTrajectoryFrame>()
    const prepare = vi.fn(() => work.promise)
    const request = {
      key,
      priority: `current` as const,
      estimated_bytes: 64,
      prepare,
    }

    const first = pipeline.request(request, generation)
    const second = pipeline.request(request, generation)
    expect(first).toBe(second)
    expect(prepare).toHaveBeenCalledTimes(1)

    work.resolve(make_prepared(key))
    await expect(first).resolves.toMatchObject({
      status: `ready`,
      cache_hit: false,
    })
  })

  test(`runs a newly queued current request before older queued prefetch`, async () => {
    const pipeline = create_prepared_frame_pipeline({ max_in_flight: 1 })
    const current = make_key({ frame_idx: 0 })
    const generation = pipeline.begin_request(current)
    const first_prefetch = make_key({ frame_idx: 1 })
    const second_prefetch = make_key({ frame_idx: 2 })
    const blocker = deferred<PreparedTrajectoryFrame>()
    const order: number[] = []

    const first = pipeline.request({
      key: first_prefetch,
      priority: `prefetch`,
      estimated_bytes: 10,
      prepare: () => {
        order.push(1)
        return blocker.promise
      },
    }, generation)
    const second = pipeline.request({
      key: second_prefetch,
      priority: `prefetch`,
      estimated_bytes: 10,
      prepare: async () => {
        order.push(2)
        return make_prepared(second_prefetch)
      },
    }, generation)
    const requested = pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 10,
      prepare: async () => {
        order.push(0)
        return make_prepared(current)
      },
    }, generation)

    expect(order).toEqual([1])
    blocker.resolve(make_prepared(first_prefetch))
    await Promise.all([first, requested, second])
    expect(order).toEqual([1, 0, 2])
  })

  test(`keeps sequential frames in one generation and invalidates seeks or versions`, () => {
    const pipeline = create_prepared_frame_pipeline()
    const first = pipeline.begin_request(make_key({ frame_idx: 2 }))
    expect(pipeline.begin_request(make_key({ frame_idx: 3 }))).toBe(first)
    expect(pipeline.begin_request(make_key({ frame_idx: 3 }))).toBe(first)

    const seek = pipeline.begin_request(make_key({ frame_idx: 8 }))
    expect(seek).toBeGreaterThan(first)
    const reverse = pipeline.begin_request(make_key({ frame_idx: 7 }))
    expect(reverse).toBeGreaterThan(seek)
    const owner_change = pipeline.begin_request(make_key({
      frame_idx: 8,
      owner: { id: `other` },
    }))
    expect(owner_change).toBeGreaterThan(reverse)
    const positions_change = pipeline.begin_request(make_key({
      frame_idx: 9,
      owner: pipeline.stats,
      positions_version: 10,
    }))
    expect(positions_change).toBeGreaterThan(owner_change)
    const topology_change = pipeline.begin_request(make_key({
      frame_idx: 10,
      owner: pipeline.stats,
      positions_version: 10,
      topology_version: 4,
    }))
    expect(topology_change).toBeGreaterThan(positions_change)
    const rules_change = pipeline.begin_request(make_key({
      frame_idx: 11,
      owner: pipeline.stats,
      positions_version: 10,
      topology_version: 4,
      rules_version: `changed`,
    }))
    expect(rules_change).toBeGreaterThan(topology_change)
  })

  test(`resolves queued old-generation work stale immediately and discards in-flight results`, async () => {
    const pipeline = create_prepared_frame_pipeline({ max_in_flight: 1 })
    const first_key = make_key({ frame_idx: 0 })
    const old_generation = pipeline.begin_request(first_key)
    const running_key = make_key({ frame_idx: 1 })
    const queued_key = make_key({ frame_idx: 2 })
    const running_work = deferred<PreparedTrajectoryFrame>()
    const running = pipeline.request({
      key: running_key,
      priority: `prefetch`,
      estimated_bytes: 10,
      prepare: () => running_work.promise,
    }, old_generation)
    const queued = pipeline.request({
      key: queued_key,
      priority: `prefetch`,
      estimated_bytes: 10,
      prepare: async () => make_prepared(queued_key),
    }, old_generation)

    const seek_key = make_key({ frame_idx: 20 })
    const new_generation = pipeline.begin_request(seek_key)
    await expect(queued).resolves.toEqual({ status: `stale` })
    const current = pipeline.request({
      key: seek_key,
      priority: `current`,
      estimated_bytes: 10,
      prepare: async () => make_prepared(seek_key),
    }, new_generation)
    running_work.resolve(make_prepared(running_key))

    await expect(running).resolves.toEqual({ status: `stale` })
    await expect(current).resolves.toMatchObject({ status: `ready` })
    expect(pipeline.peek(running_key)).toBeNull()
    expect(pipeline.stats().stale_results).toBe(2)
  })

  test(`enforces frame LRU while retaining frames nearest the playhead`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_frames: 8,
      max_bytes: 10_000,
    })
    const current = make_key({ frame_idx: 0 })
    const generation = pipeline.begin_request(current)

    for (let frame_idx = 1; frame_idx <= 10; frame_idx++) {
      const key = make_key({ frame_idx })
      await pipeline.request({
        key,
        priority: `prefetch`,
        estimated_bytes: 20,
        prepare: async () => make_prepared(key, 20),
      }, generation)
    }

    expect(pipeline.stats().cached_frames).toBe(8)
    expect(pipeline.stats().evictions).toBe(2)
    expect(pipeline.peek(make_key({ frame_idx: 1 }))).not.toBeNull()
    expect(pipeline.peek(make_key({ frame_idx: 8 }))).not.toBeNull()
    expect(pipeline.peek(make_key({ frame_idx: 9 }))).toBeNull()
    expect(pipeline.peek(make_key({ frame_idx: 10 }))).toBeNull()
  })

  test(`lets a current frame exceed the byte budget but refuses prefetch first`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_frames: 8,
      max_bytes: 100,
    })
    const current = make_key({ frame_idx: 0 })
    const generation = pipeline.begin_request(current)
    await expect(pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 150,
      prepare: async () => make_prepared(current, 150),
    }, generation)).resolves.toMatchObject({ status: `ready` })

    const prefetch = make_key({ frame_idx: 1 })
    await expect(pipeline.request({
      key: prefetch,
      priority: `prefetch`,
      estimated_bytes: 10,
      prepare: async () => make_prepared(prefetch, 10),
    }, generation)).resolves.toMatchObject({ status: `failed` })
    expect(pipeline.stats()).toMatchObject({
      cached_frames: 1,
      cached_bytes: 150,
      retained_bytes: 150,
    })
  })

  test(`reports queued, in-flight, and retained byte estimates`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_in_flight: 1,
      max_bytes: 1_000,
    })
    const current = make_key({ frame_idx: 0 })
    const generation = pipeline.begin_request(current)
    const blocker = deferred<PreparedTrajectoryFrame>()
    const running = pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 20,
      prepare: () => blocker.promise,
    }, generation)
    const queued_key = make_key({ frame_idx: 1 })
    const queued = pipeline.request({
      key: queued_key,
      priority: `prefetch`,
      estimated_bytes: 30,
      prepare: async () => make_prepared(queued_key, 30),
    }, generation)

    expect(pipeline.stats()).toMatchObject({
      queued_bytes: 30,
      in_flight_bytes: 20,
      retained_bytes: 50,
    })
    blocker.resolve(make_prepared(current, 20))
    await Promise.all([running, queued])
    expect(pipeline.stats()).toMatchObject({
      queued_bytes: 0,
      in_flight_bytes: 0,
      cached_bytes: 50,
      retained_bytes: 50,
    })
  })

  test(`protects the requested current frame before evicting prefetch`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_frames: 1,
      max_bytes: 1_000,
    })
    const current = make_key({ frame_idx: 4 })
    const generation = pipeline.begin_request(current)
    await pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 20,
      prepare: async () => make_prepared(current, 20),
    }, generation)
    const prefetch = make_key({ frame_idx: 5 })
    await pipeline.request({
      key: prefetch,
      priority: `prefetch`,
      estimated_bytes: 20,
      prepare: async () => make_prepared(prefetch, 20),
    }, generation)

    expect(pipeline.peek(current)).not.toBeNull()
    expect(pipeline.peek(prefetch)).toBeNull()
  })

  test(`counts only the contiguous ready warmup prefix`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const keys = [0, 1, 2, 3].map((frame_idx) => make_key({ frame_idx }))
    const generation = pipeline.begin_request(keys[0])
    for (const key of [keys[0], keys[1], keys[2]]) {
      await pipeline.request({
        key,
        priority: key === keys[0] ? `current` : `prefetch`,
        estimated_bytes: 10,
        prepare: async () => make_prepared(key, 10),
      }, generation)
    }
    expect(pipeline.ready_count(keys)).toBe(3)
    expect(pipeline.ready_count([keys[0], keys[3], keys[2]])).toBe(1)
  })

  test(`returns failure and continues draining the queue`, async () => {
    const pipeline = create_prepared_frame_pipeline({ max_in_flight: 1 })
    const current = make_key({ frame_idx: 0 })
    const next = make_key({ frame_idx: 1 })
    const generation = pipeline.begin_request(current)
    const failed = pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 10,
      prepare: async () => {
        throw new Error(`boom`)
      },
    }, generation)
    const ready = pipeline.request({
      key: next,
      priority: `prefetch`,
      estimated_bytes: 10,
      prepare: async () => make_prepared(next, 10),
    }, generation)

    await expect(failed).resolves.toMatchObject({
      status: `failed`,
      error: expect.objectContaining({ message: `boom` }),
    })
    await expect(ready).resolves.toMatchObject({ status: `ready` })
  })

  test(`defaults to one in-flight preparation`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const current = make_key({ frame_idx: 0 })
    const next = make_key({ frame_idx: 1 })
    const generation = pipeline.begin_request(current)
    const first = deferred<PreparedTrajectoryFrame>()
    const started: number[] = []
    const first_outcome = pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 10,
      prepare: () => {
        started.push(0)
        return first.promise
      },
    }, generation)
    const second_outcome = pipeline.request({
      key: next,
      priority: `prefetch`,
      estimated_bytes: 10,
      prepare: async () => {
        started.push(1)
        return make_prepared(next, 10)
      },
    }, generation)

    expect(started).toEqual([0])
    first.resolve(make_prepared(current, 10))
    await Promise.all([first_outcome, second_outcome])
    expect(started).toEqual([0, 1])
  })

  test(`rejects a prepared value whose key does not match its request`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const key = make_key()
    const generation = pipeline.begin_request(key)
    const outcome: PreparedFrameOutcome = await pipeline.request({
      key,
      priority: `current`,
      estimated_bytes: 10,
      prepare: async () => make_prepared(make_key({ frame_idx: 99 }), 10),
    }, generation)
    expect(outcome).toMatchObject({ status: `failed` })
    expect(pipeline.peek(key)).toBeNull()
  })
})

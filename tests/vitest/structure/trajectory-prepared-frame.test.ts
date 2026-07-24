import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  BaseBondGraph,
  RenderPacket,
} from '$lib/structure/scene/render-packet'
import {
  create_prepared_frame_pipeline,
  prepared_frame_byte_size,
  same_prepared_frame_key,
  type DeferredFrameAdmission,
  type PreparedFrameKey,
  type PreparedFrameOutcome,
  type PreparedTrajectoryFrame,
} from '$lib/structure/trajectory-prepared-frame'
import * as trajectory_prepared_frame from '$lib/structure/trajectory-prepared-frame'
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
    topology_fingerprint: `topology:base`,
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
      make_key({ topology_fingerprint: `topology:changed` }),
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

  test(`keeps the last-to-first playback wrap in the current generation`, () => {
    const pipeline = create_prepared_frame_pipeline()
    const first = pipeline.begin_request(make_key({ frame_idx: 98 }), 100)
    expect(pipeline.begin_request(make_key({ frame_idx: 99 }), 100)).toBe(first)
    expect(pipeline.begin_request(make_key({ frame_idx: 0 }), 100)).toBe(first)
    expect(pipeline.begin_request(make_key({ frame_idx: 1 }), 100)).toBe(first)

    const seek = pipeline.begin_request(make_key({ frame_idx: 50 }), 100)
    expect(seek).toBeGreaterThan(first)
  })

  test(`starts a new generation when a sequential frame changes position revision`, () => {
    const pipeline = create_prepared_frame_pipeline()
    const first = pipeline.begin_request(make_key({
      frame_idx: 0,
      positions_version: 1,
    }), 100)
    const changed = pipeline.begin_request(make_key({
      frame_idx: 1,
      positions_version: 2,
    }), 100)

    expect(changed).toBeGreaterThan(first)
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

  test(`discards an old topology fingerprint that resolves after a segment transition`, async () => {
    const pipeline = create_prepared_frame_pipeline({ max_in_flight: 1 })
    const old_key = make_key({
      frame_idx: 0,
      topology_fingerprint: `topology:old`,
    })
    const old_generation = pipeline.begin_request(old_key)
    const old_work = deferred<PreparedTrajectoryFrame>()
    const old_outcome = pipeline.request({
      key: old_key,
      priority: `current`,
      estimated_bytes: 10,
      prepare: () => old_work.promise,
    }, old_generation)

    const new_key = make_key({
      frame_idx: 0,
      topology_fingerprint: `topology:new`,
    })
    const new_generation = pipeline.begin_request(new_key)
    const new_outcome = pipeline.request({
      key: new_key,
      priority: `current`,
      estimated_bytes: 10,
      prepare: async () => make_prepared(new_key, 10),
    }, new_generation)

    old_work.resolve(make_prepared(old_key, 10))

    await expect(old_outcome).resolves.toEqual({ status: `stale` })
    await expect(new_outcome).resolves.toMatchObject({
      status: `ready`,
      value: { key: new_key },
    })
    expect(pipeline.peek(old_key)).toBeNull()
    expect(pipeline.peek(new_key)?.key).toBe(new_key)
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

  test(`refuses deferred prefetch before invoking its decoder when the byte budget is full`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_bytes: 100,
    })
    const current = make_key({ frame_idx: 0 })
    const generation = pipeline.begin_request(current)
    await pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 100,
      prepare: async () => make_prepared(current, 100),
    }, generation)
    const prefetch = make_key({ frame_idx: 1 })
    const admit = vi.fn(async (): Promise<DeferredFrameAdmission> => ({
      key: prefetch,
      retained_source_bytes: 20,
      prepare: async () => make_prepared(prefetch, 20),
    }))

    const outcome = await pipeline.request_deferred({
      key: prefetch,
      priority: `prefetch`,
      estimated_bytes: 20,
      admit,
    }, generation)

    expect(outcome).toMatchObject({
      status: `failed`,
      error: { name: `PreparedFrameBudgetRefusalError` },
    })
    const is_budget_refusal = (
      trajectory_prepared_frame as unknown as {
        is_prepared_frame_budget_refusal: (error: unknown) => boolean
      }
    ).is_prepared_frame_budget_refusal
    const trajectory_buffer_error = vi.fn()
    if (
      outcome.status === `failed` &&
      !is_budget_refusal(outcome.error)
    ) {
      trajectory_buffer_error(outcome.error)
    }
    expect(admit).not.toHaveBeenCalled()
    expect(trajectory_buffer_error).not.toHaveBeenCalled()
    expect(trajectory_render_diagnostics.snapshot().failed_frames).toBe(0)
    expect(pipeline.stats()).toMatchObject({
      cached_bytes: 100,
      queued_bytes: 0,
      in_flight_bytes: 0,
      retained_bytes: 100,
    })
  })

  test(`evicts a safe old frame before admitting a prospective decode reservation`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_bytes: 100,
      max_frames: 8,
    })
    const current = make_key({ frame_idx: 0 })
    const old_safe = make_key({ frame_idx: 5 })
    const incoming = make_key({ frame_idx: 1 })
    const generation = pipeline.begin_request(current, 10)
    await pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 40,
      prepare: async () => make_prepared(current, 40),
    }, generation)
    await pipeline.request({
      key: old_safe,
      priority: `prefetch`,
      estimated_bytes: 60,
      prepare: async () => make_prepared(old_safe, 60),
    }, generation)
    const admit = vi.fn(async (): Promise<DeferredFrameAdmission> => ({
      key: incoming,
      retained_source_bytes: 8,
      prepare: async () => make_prepared(incoming, 20),
    }))

    await expect(pipeline.request_deferred({
      key: incoming,
      priority: `prefetch`,
      estimated_bytes: 20,
      admit,
    }, generation)).resolves.toMatchObject({ status: `ready` })

    expect(admit).toHaveBeenCalledOnce()
    expect(pipeline.peek(current)).not.toBeNull()
    expect(pipeline.peek(old_safe)).toBeNull()
    expect(pipeline.peek(incoming)).not.toBeNull()
    expect(pipeline.stats()).toMatchObject({
      cached_bytes: 60,
      retained_bytes: 60,
      evictions: 1,
    })
  })

  test(`does not evict the protected current frame for an unsafe reservation`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_bytes: 50,
    })
    const current = make_key({ frame_idx: 0 })
    const incoming = make_key({ frame_idx: 1 })
    const generation = pipeline.begin_request(current)
    await pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 40,
      prepare: async () => make_prepared(current, 40),
    }, generation)
    const admit = vi.fn(async (): Promise<DeferredFrameAdmission> => ({
      key: incoming,
      retained_source_bytes: 8,
      prepare: async () => make_prepared(incoming, 20),
    }))

    await expect(pipeline.request_deferred({
      key: incoming,
      priority: `prefetch`,
      estimated_bytes: 20,
      admit,
    }, generation)).resolves.toMatchObject({
      status: `failed`,
      error: { name: `PreparedFrameBudgetRefusalError` },
    })

    expect(admit).not.toHaveBeenCalled()
    expect(pipeline.peek(current)).not.toBeNull()
    expect(pipeline.stats()).toMatchObject({
      cached_frames: 1,
      cached_bytes: 40,
      evictions: 0,
    })
  })

  test(`overlaps one decoder with one preparation without running two decoders`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const first_key = make_key({ frame_idx: 0 })
    const second_key = make_key({ frame_idx: 1 })
    const third_key = make_key({ frame_idx: 2 })
    const generation = pipeline.begin_request(first_key)
    const first_prepare = deferred<PreparedTrajectoryFrame>()
    const second_decode = deferred<DeferredFrameAdmission>()
    const third_decode = deferred<DeferredFrameAdmission>()
    let active_decoders = 0
    let maximum_active_decoders = 0
    const decoder = (
      admission: Promise<DeferredFrameAdmission>,
    ) => async (): Promise<DeferredFrameAdmission> => {
      active_decoders++
      maximum_active_decoders = Math.max(
        maximum_active_decoders,
        active_decoders,
      )
      try {
        return await admission
      } finally {
        active_decoders--
      }
    }
    const first_prepare_spy = vi.fn(() => first_prepare.promise)
    const first = pipeline.request_deferred({
      key: first_key,
      priority: `current`,
      estimated_bytes: 20,
      admit: decoder(Promise.resolve({
        key: first_key,
        retained_source_bytes: 8,
        prepare: first_prepare_spy,
      })),
    }, generation)
    const second = pipeline.request_deferred({
      key: second_key,
      priority: `prefetch`,
      estimated_bytes: 20,
      admit: decoder(second_decode.promise),
    }, generation)
    const third = pipeline.request_deferred({
      key: third_key,
      priority: `prefetch`,
      estimated_bytes: 20,
      admit: decoder(third_decode.promise),
    }, generation)

    await Promise.resolve()
    await Promise.resolve()
    expect(first_prepare_spy).toHaveBeenCalledOnce()
    expect(active_decoders).toBe(1)
    expect(maximum_active_decoders).toBe(1)

    second_decode.resolve({
      key: second_key,
      retained_source_bytes: 8,
      prepare: async () => make_prepared(second_key, 20),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(active_decoders).toBe(1)
    expect(maximum_active_decoders).toBe(1)

    third_decode.resolve({
      key: third_key,
      retained_source_bytes: 8,
      prepare: async () => make_prepared(third_key, 20),
    })
    first_prepare.resolve(make_prepared(first_key, 20))
    await Promise.all([first, second, third])
    expect(maximum_active_decoders).toBe(1)
  })

  test(`keeps one full reservation across decode, preparation queue, preparation, and cache`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_bytes: 1_000,
    })
    const current = make_key({ frame_idx: 0 })
    const deferred_key = make_key({ frame_idx: 1 })
    const generation = pipeline.begin_request(current)
    const current_prepare = deferred<PreparedTrajectoryFrame>()
    const current_outcome = pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 10,
      prepare: () => current_prepare.promise,
    }, generation)
    const decode = deferred<DeferredFrameAdmission>()
    let retained_when_decoder_started = 0
    let retained_when_prepare_started = 0
    const deferred_outcome = pipeline.request_deferred({
      key: deferred_key,
      priority: `prefetch`,
      estimated_bytes: 70,
      admit: () => {
        retained_when_decoder_started = pipeline.stats().retained_bytes
        return decode.promise
      },
    }, generation)

    expect(retained_when_decoder_started).toBe(80)
    expect(pipeline.stats()).toMatchObject({
      queued_bytes: 0,
      in_flight_bytes: 80,
      retained_bytes: 80,
    })
    decode.resolve({
      key: deferred_key,
      retained_source_bytes: 30,
      prepare: async () => {
        retained_when_prepare_started = pipeline.stats().retained_bytes
        return make_prepared(deferred_key, 70)
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(pipeline.stats()).toMatchObject({
      queued_bytes: 70,
      in_flight_bytes: 10,
      retained_bytes: 80,
    })

    current_prepare.resolve(make_prepared(current, 10))
    await Promise.resolve()
    await Promise.resolve()
    expect(retained_when_prepare_started).toBe(80)
    expect(pipeline.stats().retained_bytes).toBe(80)

    await Promise.all([current_outcome, deferred_outcome])
    expect(pipeline.stats()).toMatchObject({
      cached_bytes: 80,
      queued_bytes: 0,
      in_flight_bytes: 0,
      retained_bytes: 80,
    })
  })

  test(`invalidates queued deferred decode and discards a late active decode after a seek`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const current = make_key({ frame_idx: 0 })
    const active_key = make_key({ frame_idx: 1 })
    const queued_key = make_key({ frame_idx: 2 })
    const generation = pipeline.begin_request(current)
    const active_decode = deferred<DeferredFrameAdmission>()
    const active_prepare = vi.fn(async () => make_prepared(active_key, 20))
    const queued_admit = vi.fn(async (): Promise<DeferredFrameAdmission> => ({
      key: queued_key,
      retained_source_bytes: 8,
      prepare: async () => make_prepared(queued_key, 20),
    }))
    const active = pipeline.request_deferred({
      key: active_key,
      priority: `prefetch`,
      estimated_bytes: 20,
      admit: () => active_decode.promise,
    }, generation)
    const queued = pipeline.request_deferred({
      key: queued_key,
      priority: `prefetch`,
      estimated_bytes: 20,
      admit: queued_admit,
    }, generation)

    pipeline.begin_request(make_key({ frame_idx: 20 }))
    await expect(queued).resolves.toEqual({ status: `stale` })
    expect(queued_admit).not.toHaveBeenCalled()
    active_decode.resolve({
      key: active_key,
      retained_source_bytes: 8,
      prepare: active_prepare,
    })
    await expect(active).resolves.toEqual({ status: `stale` })

    expect(active_prepare).not.toHaveBeenCalled()
    expect(pipeline.peek(active_key)).toBeNull()
    expect(pipeline.peek(queued_key)).toBeNull()
    expect(pipeline.stats()).toMatchObject({
      queued_bytes: 0,
      in_flight_bytes: 0,
      retained_bytes: 0,
      stale_results: 2,
    })
  })

  test(`rejects a deferred admission whose decoded full key changed`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const provisional_key = make_key({ frame_idx: 0 })
    const decoded_key = make_key({
      frame_idx: 0,
      positions_version: provisional_key.positions_version + 1,
    })
    const generation = pipeline.begin_request(provisional_key)
    const prepare = vi.fn(async () => make_prepared(decoded_key, 20))

    await expect(pipeline.request_deferred({
      key: provisional_key,
      priority: `current`,
      estimated_bytes: 20,
      admit: async () => ({
        key: decoded_key,
        retained_source_bytes: 8,
        prepare,
      }),
    }, generation)).resolves.toMatchObject({
      status: `failed`,
      error: expect.objectContaining({
        message: expect.stringContaining(`decoded key`),
      }),
    })

    expect(prepare).not.toHaveBeenCalled()
    expect(pipeline.peek(provisional_key)).toBeNull()
    expect(pipeline.peek(decoded_key)).toBeNull()
    expect(pipeline.stats().retained_bytes).toBe(0)
  })

  test(`deduplicates deferred keys and drains the next decoder after failure`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const first_key = make_key({ frame_idx: 0 })
    const next_key = make_key({ frame_idx: 1 })
    const generation = pipeline.begin_request(first_key)
    const first_decode = deferred<DeferredFrameAdmission>()
    const first_admit = vi.fn(() => first_decode.promise)
    const first_request = {
      key: first_key,
      priority: `current` as const,
      estimated_bytes: 20,
      admit: first_admit,
    }
    const first = pipeline.request_deferred(first_request, generation)
    const duplicate = pipeline.request_deferred(first_request, generation)
    const next_admit = vi.fn(async (): Promise<DeferredFrameAdmission> => ({
      key: next_key,
      retained_source_bytes: 8,
      prepare: async () => make_prepared(next_key, 20),
    }))
    const next = pipeline.request_deferred({
      key: next_key,
      priority: `prefetch`,
      estimated_bytes: 20,
      admit: next_admit,
    }, generation)

    expect(duplicate).toBe(first)
    expect(first_admit).toHaveBeenCalledOnce()
    expect(next_admit).not.toHaveBeenCalled()
    first_decode.reject(new Error(`decode failed`))

    await expect(first).resolves.toMatchObject({
      status: `failed`,
      error: expect.objectContaining({ message: `decode failed` }),
    })
    await expect(next).resolves.toMatchObject({ status: `ready` })
    expect(next_admit).toHaveBeenCalledOnce()
  })

  test(`expands a current reservation when decoded source bytes exceed its estimate`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_bytes: 20,
    })
    const key = make_key({ frame_idx: 0 })
    const generation = pipeline.begin_request(key)
    const prepare = deferred<PreparedTrajectoryFrame>()
    const outcome = pipeline.request_deferred({
      key,
      priority: `current`,
      estimated_bytes: 10,
      admit: async () => ({
        key,
        retained_source_bytes: 30,
        prepare: () => prepare.promise,
      }),
    }, generation)

    await Promise.resolve()
    await Promise.resolve()
    expect(pipeline.stats()).toMatchObject({
      in_flight_bytes: 30,
      retained_bytes: 30,
    })

    prepare.resolve(make_prepared(key, 30))
    await expect(outcome).resolves.toMatchObject({ status: `ready` })
    expect(pipeline.stats().retained_bytes).toBe(30)
  })

  test(`promotes a duplicate deferred key when it becomes current`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const playhead = make_key({ frame_idx: 0 })
    const blocker_key = make_key({ frame_idx: 9 })
    const older_prefetch_key = make_key({ frame_idx: 2 })
    const promoted_key = make_key({ frame_idx: 1 })
    const generation = pipeline.begin_request(playhead)
    const blocker = deferred<DeferredFrameAdmission>()
    const decode_order: number[] = []
    const blocked = pipeline.request_deferred({
      key: blocker_key,
      priority: `prefetch`,
      estimated_bytes: 10,
      admit: () => {
        decode_order.push(blocker_key.frame_idx)
        return blocker.promise
      },
    }, generation)
    const older_prefetch = pipeline.request_deferred({
      key: older_prefetch_key,
      priority: `prefetch`,
      estimated_bytes: 10,
      admit: async () => {
        decode_order.push(older_prefetch_key.frame_idx)
        return {
          key: older_prefetch_key,
          retained_source_bytes: 4,
          prepare: async () => make_prepared(older_prefetch_key, 10),
        }
      },
    }, generation)
    const promoted = pipeline.request_deferred({
      key: promoted_key,
      priority: `prefetch`,
      estimated_bytes: 10,
      admit: async () => {
        decode_order.push(promoted_key.frame_idx)
        return {
          key: promoted_key,
          retained_source_bytes: 4,
          prepare: async () => make_prepared(promoted_key, 10),
        }
      },
    }, generation)
    const current_duplicate = pipeline.request_deferred({
      key: promoted_key,
      priority: `current`,
      estimated_bytes: 10,
      admit: async () => {
        throw new Error(`deduplicated current decoder must not run`)
      },
    }, generation)

    expect(current_duplicate).toBe(promoted)
    blocker.resolve({
      key: blocker_key,
      retained_source_bytes: 4,
      prepare: async () => make_prepared(blocker_key, 10),
    })
    await Promise.all([blocked, older_prefetch, promoted])

    expect(decode_order).toEqual([9, 1, 2])
  })

  test(`starts same-key replacement after clear cancels active owner work`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const current_owner = { id: `current` }
    const cleared_owner = { id: `cleared` }
    const current = make_key({ owner: current_owner, frame_idx: 0 })
    const target = make_key({ owner: cleared_owner, frame_idx: 1 })
    const generation = pipeline.begin_request(current)
    const obsolete_prepare = deferred<PreparedTrajectoryFrame>()
    const obsolete = pipeline.request({
      key: target,
      priority: `prefetch`,
      estimated_bytes: 10,
      prepare: () => obsolete_prepare.promise,
    }, generation)
    pipeline.clear(cleared_owner)
    const replacement_prepare = vi.fn(
      async () => make_prepared(target, 10),
    )
    const replacement = pipeline.request({
      key: target,
      priority: `prefetch`,
      estimated_bytes: 10,
      prepare: replacement_prepare,
    }, generation)

    expect(replacement).not.toBe(obsolete)
    obsolete_prepare.resolve(make_prepared(target, 10))
    await expect(obsolete).resolves.toEqual({ status: `stale` })
    await expect(replacement).resolves.toMatchObject({ status: `ready` })
    expect(replacement_prepare).toHaveBeenCalledOnce()
  })

  test(`counts deferred prepared frames in warmup when synchronous getters stay empty`, async () => {
    const window_key = (
      trajectory_prepared_frame as unknown as {
        prepared_frame_window_key?: (
          current_key: PreparedFrameKey,
          frame_idx: number,
          decoded_key: PreparedFrameKey | null,
          fixed_topology: boolean,
        ) => PreparedFrameKey | null
      }
    ).prepared_frame_window_key
    expect(window_key).toBeTypeOf(`function`)

    const pipeline = create_prepared_frame_pipeline()
    const current = make_key({ frame_idx: 0 })
    const generation = pipeline.begin_request(current, 10)
    const keys = [0, 1, 2].map((frame_idx) => make_key({ frame_idx }))
    await pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 10,
      prepare: async () => make_prepared(current, 10),
    }, generation)
    await Promise.all(keys.slice(1).map((key) =>
      pipeline.request_deferred({
        key,
        priority: `prefetch`,
        estimated_bytes: 10,
        admit: async () => ({
          key,
          retained_source_bytes: 4,
          prepare: async () => make_prepared(key, 10),
        }),
      }, generation)
    ))
    const getter = vi.fn((_frame_idx: number): PreparedFrameKey | null => null)
    const warmup_keys = keys.map((key) =>
      window_key!(current, key.frame_idx, getter(key.frame_idx), true)
    ).filter((key): key is PreparedFrameKey => key !== null)

    expect(getter).toHaveBeenCalledTimes(3)
    expect(warmup_keys).toEqual(keys)
    expect(pipeline.ready_count(warmup_keys)).toBe(3)
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

  test(`demotes past current frames so a seek can rebuild its contiguous window`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_frames: 8,
      max_bytes: 10_000,
    })
    for (let frame_idx = 6; frame_idx <= 15; frame_idx++) {
      const key = make_key({ frame_idx })
      const generation = pipeline.begin_request(key)
      await pipeline.request({
        key,
        priority: `current`,
        estimated_bytes: 20,
        prepare: async () => make_prepared(key, 20),
      }, generation)
    }

    const current = make_key({ frame_idx: 1 })
    const generation = pipeline.begin_request(current)
    await pipeline.request({
      key: current,
      priority: `current`,
      estimated_bytes: 20,
      prepare: async () => make_prepared(current, 20),
    }, generation)
    const window = [current]
    for (let frame_idx = 2; frame_idx <= 8; frame_idx++) {
      const key = make_key({ frame_idx })
      window.push(key)
      await pipeline.request({
        key,
        priority: `prefetch`,
        estimated_bytes: 20,
        prepare: async () => make_prepared(key, 20),
      }, generation)
    }

    // Once the new current frame completes it owns the displayed protection,
    // releasing the old displayed cache slot for the seventh ahead frame.
    expect(pipeline.ready_count(window)).toBe(8)
  })

  test(`computes only one new ahead frame per cached sequential advance`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_frames: 8,
      max_bytes: 10_000,
    })
    let computes = 0
    const request = (
      key: PreparedFrameKey,
      priority: `current` | `prefetch`,
      generation: number,
    ) =>
      pipeline.request({
        key,
        priority,
        estimated_bytes: 20,
        prepare: async () => {
          computes++
          return make_prepared(key, 20)
        },
      }, generation)

    let generation = pipeline.begin_request(make_key({ frame_idx: 0 }), 100)
    await Promise.all(Array.from({ length: 8 }, (_, frame_idx) =>
      request(
        make_key({ frame_idx }),
        frame_idx === 0 ? `current` : `prefetch`,
        generation,
      )
    ))

    for (let frame_idx = 1; frame_idx <= 5; frame_idx++) {
      const current = make_key({ frame_idx })
      generation = pipeline.begin_request(current, 100)
      await request(current, `current`, generation)
      await Promise.all(Array.from({ length: 7 }, (_, offset) =>
        request(
          make_key({ frame_idx: frame_idx + offset + 1 }),
          `prefetch`,
          generation,
        )
      ))
    }

    expect(computes).toBe(13)
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

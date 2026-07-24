import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('$lib/structure/workers/bond-worker-api', () => ({
  compute_trajectory_frame_typed: vi.fn(),
  compute_bonds_exact_async: vi.fn(),
  pack_trajectory_positions_worker: vi.fn(),
  LARGE_SYSTEM_MIN_ATOMS: 4096,
}))

import type { AnyStructure, BondPair, Site } from '$lib'
import type { RenderPacket } from '$lib/structure/scene/render-packet'
import { position_texture_shape } from '$lib/structure/gpu/position-texture-layout'
import {
  compute_bonds_exact_async,
  compute_trajectory_frame_typed,
  pack_trajectory_positions_worker,
} from '$lib/structure/workers/bond-worker-api'
import {
  prepare_exact_trajectory_frame,
  type ExactFramePrepareInput,
  type TrajectoryFrameSource,
} from '$lib/structure/trajectory-frame-preparer'
import * as trajectory_frame_preparer from '$lib/structure/trajectory-frame-preparer'
import {
  create_prepared_frame_pipeline,
  type PreparedFrameKey,
} from '$lib/structure/trajectory-prepared-frame'
import { trajectory_render_diagnostics } from '$lib/structure/trajectory-render-diagnostics'

const typed_mock = vi.mocked(compute_trajectory_frame_typed)
const object_mock = vi.mocked(compute_bonds_exact_async)
const pack_mock = vi.mocked(pack_trajectory_positions_worker)

type SafeSourceRequest = (
  requester: ((frame_idx: number) => Promise<TrajectoryFrameSource | null>)
    | null,
  frame_idx: number,
  on_error: (error: Error) => void,
) => Promise<TrajectoryFrameSource | null>

type CurrentSourceRequestToken = object

type CurrentSourceRequestGuard = {
  begin: (owner: object, frame_idx: number) => CurrentSourceRequestToken
  settle: (token: CurrentSourceRequestToken) => boolean
  invalidate: () => void
}

function safe_source_request(): SafeSourceRequest | undefined {
  return (
    trajectory_frame_preparer as unknown as {
      request_trajectory_frame_source_safely?: SafeSourceRequest
    }
  ).request_trajectory_frame_source_safely
}

function current_source_request_guard(): CurrentSourceRequestGuard | undefined {
  const create_guard = (
    trajectory_frame_preparer as unknown as {
      create_current_trajectory_source_request_guard?:
        () => CurrentSourceRequestGuard
    }
  ).create_current_trajectory_source_request_guard
  return create_guard?.()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve_promise, reject_promise) => {
    resolve = resolve_promise
    reject = reject_promise
  })
  return { promise, resolve, reject }
}

function site(element: string, xyz: [number, number, number]): Site {
  return {
    species: [{ element, occu: 1, oxidation_state: 0 }],
    abc: xyz,
    xyz,
    label: element,
    properties: {},
  } as unknown as Site
}

function fixture(): {
  packet: RenderPacket
  structure: AnyStructure
  positions: Float32Array
  lattice: number[][]
} {
  const owner = {}
  const lattice = [[4, 0, 0], [0, 5, 0], [1, 0, 6]]
  const positions = new Float32Array([0.2, 0, 0, 3.8, 0, 0])
  const structure = {
    sites: [site(`C`, [0, 0, 0]), site(`H`, [1, 0, 0])],
    lattice: { matrix: lattice, pbc: [true, false, true] },
  } as unknown as AnyStructure
  const packet: RenderPacket = {
    topology: {
      version: 11,
      atom_count: 2,
      site_ids: new Uint32Array([7, 9]),
      atomic_numbers: new Uint8Array([6, 1]),
      radii: new Float32Array([0.76, 0.31]),
      colors: new Float32Array(6),
    },
    frame: {
      owner,
      frame_idx: 0,
      positions_version: 1,
      positions: new Float32Array(6),
      lattice: new Float32Array(9),
    },
    replicas: {
      version: 3,
      dims: [1, 1, 1],
      boundary_policy: `stub`,
      semantics: `visual-shared-base`,
    },
  }
  return { packet, structure, positions, lattice }
}

function input(
  overrides: Partial<ExactFramePrepareInput> = {},
): ExactFramePrepareInput {
  const { packet, structure, positions, lattice } = fixture()
  return {
    packet,
    structure,
    source: {
      frame_idx: 5,
      positions,
      forces: new Float32Array([1, 2, 3, 4, 5, 6]),
      lattice,
      positions_version: 13,
      topology_stable: true,
      stable_site_ids: Uint32Array.from([7, 9]),
    },
    strategy: `atom_radii`,
    options: { tolerance: 0.1, max_bond_dist: 4, min_dist: 0.01 },
    pbc: [true, false, true],
    distance_rules: [],
    rules_version: `rules-v2`,
    graph_version: 17,
    ...overrides,
  }
}

function bond(
  a: number,
  b: number,
  jimage: [number, number, number],
): BondPair {
  return {
    pos_1: [0, 0, 0],
    pos_2: [1, 0, 0],
    site_idx_1: a,
    site_idx_2: b,
    bond_length: 1,
    strength: 0.75,
    transform_matrix: new Float32Array(16),
    jimage,
  }
}

function scalar_session_diagnostics() {
  return {
    thread_count: 1,
    session_initializations: 1,
    frame_count: 1,
    grid_cache_hits: 0,
    grid_rebuilds: 1,
    capacity_growths: 2,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  trajectory_render_diagnostics.reset()
})

describe(`prepare_exact_trajectory_frame`, () => {
  test(`atom-radii fast path publishes one exact typed snapshot`, async () => {
    const gpu = new Float32Array([0.2, 0, 0, 1, 3.8, 0, 0, 1])
    const session_diagnostics = {
      thread_count: 4,
      session_initializations: 1,
      frame_count: 7,
      grid_cache_hits: 6,
      grid_rebuilds: 1,
      capacity_growths: 2,
    }
    const record_bond_session = vi.spyOn(
      trajectory_render_diagnostics,
      `record_bond_session`,
    )
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-threads`,
      threading_expected: true,
      session_diagnostics,
      elapsed_ms: 2,
      table: {
        pairs: new Uint32Array([0, 1, 0, 0]),
        images: new Int8Array([-1, 0, 0, 1, 0, 0]),
        lengths: new Float32Array([0.4, 4]),
        strengths: new Float32Array([0.9, 0.4]),
      },
      gpu_positions_rgba: gpu,
    })
    const request = input()

    const prepared = await prepare_exact_trajectory_frame(request)

    expect(typed_mock).toHaveBeenCalledOnce()
    expect(object_mock).not.toHaveBeenCalled()
    expect(pack_mock).not.toHaveBeenCalled()
    expect(typed_mock).toHaveBeenCalledWith(expect.objectContaining({
      positions: request.source.positions,
      lattice_matrix: request.source.lattice,
      session: expect.objectContaining({
        atomic_numbers: request.packet.topology.atomic_numbers,
        stable_site_ids: request.source.stable_site_ids,
        pbc: request.pbc,
        options: request.options,
      }),
    }))
    expect(prepared.packet.frame).toMatchObject({
      owner: request.packet.frame.owner,
      frame_idx: 5,
      positions_version: 13,
      positions: request.source.positions,
    })
    expect([...prepared.packet.frame.lattice]).toEqual(request.source.lattice?.flat())
    expect(prepared.graph).toBe(prepared.packet.topology.bond_graph)
    expect([...prepared.graph.pairs]).toEqual([0, 1, 0, 0])
    expect([...prepared.graph.jimages]).toEqual([-1, 0, 0, 1, 0, 0])
    expect(prepared.graph.version).toBe(17)
    expect(prepared.gpu_positions_rgba).toBe(gpu)
    expect(prepared.forces).toBe(request.source.forces)
    expect(prepared.key).toEqual({
      owner: request.packet.frame.owner,
      frame_idx: 5,
      positions_version: 13,
      topology_version: 11,
      topology_fingerprint: expect.any(String),
      rules_version: `rules-v2`,
    })
    expect(prepared.graph_hash).toHaveLength(40)
    expect(prepared.byte_size).toBeGreaterThan(gpu.byteLength)
    expect(record_bond_session).toHaveBeenCalledOnce()
    expect(record_bond_session).toHaveBeenCalledWith(
      `rust-wasm-threads`,
      true,
      session_diagnostics,
    )
    expect(trajectory_render_diagnostics.snapshot()).toMatchObject({
      bond_backend: `rust-wasm-threads`,
      bond_threading_expected: true,
      bond_thread_count: 4,
      bond_session_initializations: 1,
      bond_session_frames: 7,
      bond_grid_cache_hits: 6,
      bond_grid_rebuilds: 1,
      bond_capacity_growths: 2,
    })
    record_bond_session.mockRestore()
  })

  test(`allocates different typed-worker sessions for different trajectory owners`, async () => {
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-scalar`,
      threading_expected: false,
      session_diagnostics: scalar_session_diagnostics(),
      elapsed_ms: 1,
      table: {
        pairs: new Uint32Array(0),
        images: new Int8Array(0),
        lengths: new Float32Array(0),
        strengths: new Float32Array(0),
      },
      gpu_positions_rgba: new Float32Array(8),
    })
    const first = input()
    const second = input()

    await prepare_exact_trajectory_frame(first)
    await prepare_exact_trajectory_frame(second)

    const session_ids = typed_mock.mock.calls.map(
      ([call]) => call.session.id,
    )
    expect(first.packet.frame.owner).not.toBe(second.packet.frame.owner)
    expect(session_ids[0]).not.toBe(session_ids[1])
  })

  test(`segments sessions by complete topology data and reuses copied equal data`, async () => {
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-scalar`,
      threading_expected: false,
      session_diagnostics: scalar_session_diagnostics(),
      elapsed_ms: 1,
      table: {
        pairs: new Uint32Array(0),
        images: new Int8Array(0),
        lengths: new Float32Array(0),
        strengths: new Float32Array(0),
      },
      gpu_positions_rgba: new Float32Array(8),
    })
    const first = input()
    const copied = input()
    copied.packet.frame.owner = first.packet.frame.owner
    copied.packet.topology.atomic_numbers =
      first.packet.topology.atomic_numbers.slice()
    copied.source.stable_site_ids = first.source.stable_site_ids?.slice()
    copied.options = { ...first.options }
    const changed_numbers = input()
    changed_numbers.packet.frame.owner = first.packet.frame.owner
    changed_numbers.packet.topology.atomic_numbers = Uint8Array.from([6, 8])
    changed_numbers.source.stable_site_ids =
      first.source.stable_site_ids?.slice()
    const changed_site_ids = input()
    changed_site_ids.packet.frame.owner = first.packet.frame.owner
    changed_site_ids.packet.topology.atomic_numbers =
      first.packet.topology.atomic_numbers.slice()
    changed_site_ids.source.stable_site_ids = Uint32Array.from([7, 10])

    const prepared = await Promise.all([
      prepare_exact_trajectory_frame(first),
      prepare_exact_trajectory_frame(copied),
      prepare_exact_trajectory_frame(changed_numbers),
      prepare_exact_trajectory_frame(changed_site_ids),
    ])

    const sessions = typed_mock.mock.calls.map(([call]) => call.session)
    expect(sessions[1].id).toBe(sessions[0].id)
    expect(sessions[1].topology_fingerprint).toBe(
      sessions[0].topology_fingerprint,
    )
    expect(prepared[1].key.topology_fingerprint).toBe(
      prepared[0].key.topology_fingerprint,
    )
    for (const idx of [2, 3]) {
      expect(sessions[idx].id).not.toBe(sessions[0].id)
      expect(sessions[idx].topology_fingerprint).not.toBe(
        sessions[0].topology_fingerprint,
      )
      expect(prepared[idx].key.topology_fingerprint).toBe(
        sessions[idx].topology_fingerprint,
      )
    }
  })

  test(`snapshots mutable topology inputs before session reuse`, async () => {
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-scalar`,
      threading_expected: false,
      session_diagnostics: scalar_session_diagnostics(),
      elapsed_ms: 1,
      table: {
        pairs: new Uint32Array(0),
        images: new Int8Array(0),
        lengths: new Float32Array(0),
        strengths: new Float32Array(0),
      },
      gpu_positions_rgba: new Float32Array(8),
    })
    const first = input()
    await prepare_exact_trajectory_frame(first)
    const first_session_id = typed_mock.mock.calls[0][0].session.id

    first.packet.topology.atomic_numbers[0] = 1
    first.source.stable_site_ids![0] = 999
    first.options.tolerance = 9
    const copied_original = input()
    copied_original.packet.frame.owner = first.packet.frame.owner

    await prepare_exact_trajectory_frame(copied_original)

    expect(typed_mock.mock.calls[1][0].session.id).toBe(first_session_id)
  })

  test(`publishes a cold async source under its loader-derived fingerprint`, async () => {
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-scalar`,
      threading_expected: false,
      session_diagnostics: scalar_session_diagnostics(),
      elapsed_ms: 1,
      table: {
        pairs: new Uint32Array(0),
        images: new Int8Array(0),
        lengths: new Float32Array(0),
        strengths: new Float32Array(0),
      },
      gpu_positions_rgba: new Float32Array(8),
    })
    const request = input()
    const loader_source = {
      ...request.source,
      stable_site_ids: Uint32Array.from([101, 202]),
    }
    const load_source = vi.fn(async () => loader_source)
    const source = await load_source()
    request.source = source
    const key_builder = (
      trajectory_frame_preparer as unknown as {
        trajectory_prepared_frame_key?: (
          input: ExactFramePrepareInput,
        ) => PreparedFrameKey
      }
    ).trajectory_prepared_frame_key

    expect(key_builder).toBeTypeOf(`function`)
    const key = key_builder!(request)
    const pipeline = create_prepared_frame_pipeline()
    const generation = pipeline.begin_request(key)
    const outcome = await pipeline.request({
      key,
      priority: `current`,
      estimated_bytes: 64,
      prepare: () => prepare_exact_trajectory_frame(request),
    }, generation)

    expect(load_source).toHaveBeenCalledOnce()
    expect(outcome).toMatchObject({
      status: `ready`,
      value: { key: { topology_fingerprint: key.topology_fingerprint } },
    })
    expect(pipeline.peek(key)?.key.topology_fingerprint).toBe(
      key.topology_fingerprint,
    )
    expect(typed_mock.mock.calls[0][0].session.stable_site_ids).toEqual(
      loader_source.stable_site_ids,
    )
  })

  test(`prefetches a different topology segment under its own source key`, async () => {
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-scalar`,
      threading_expected: false,
      session_diagnostics: scalar_session_diagnostics(),
      elapsed_ms: 1,
      table: {
        pairs: new Uint32Array(0),
        images: new Int8Array(0),
        lengths: new Float32Array(0),
        strengths: new Float32Array(0),
      },
      gpu_positions_rgba: new Float32Array(8),
    })
    const current = input()
    current.source.frame_idx = 0
    current.source.stable_site_ids = Uint32Array.from([7, 9])
    const prefetched = input()
    prefetched.packet.frame.owner = current.packet.frame.owner
    prefetched.source.frame_idx = 1
    prefetched.source.stable_site_ids = Uint32Array.from([70, 90])
    const key_builder = (
      trajectory_frame_preparer as unknown as {
        trajectory_prepared_frame_key?: (
          input: ExactFramePrepareInput,
        ) => PreparedFrameKey
      }
    ).trajectory_prepared_frame_key

    expect(key_builder).toBeTypeOf(`function`)
    const current_key = key_builder!(current)
    const prefetch_key = key_builder!(prefetched)
    expect(prefetch_key.topology_fingerprint).not.toBe(
      current_key.topology_fingerprint,
    )
    const pipeline = create_prepared_frame_pipeline()
    const generation = pipeline.begin_request(current_key, 2)
    await pipeline.request({
      key: current_key,
      priority: `current`,
      estimated_bytes: 64,
      prepare: () => prepare_exact_trajectory_frame(current),
    }, generation)
    const prefetched_outcome = await pipeline.request({
      key: prefetch_key,
      priority: `prefetch`,
      estimated_bytes: 64,
      prepare: () => prepare_exact_trajectory_frame(prefetched),
    }, generation)

    expect(prefetched_outcome).toMatchObject({ status: `ready` })
    expect(pipeline.peek(prefetch_key)?.key).toEqual(prefetch_key)
    const transitioned_generation = pipeline.begin_request(prefetch_key, 2)
    const recompute = vi.fn(() => prepare_exact_trajectory_frame(prefetched))
    const transitioned = await pipeline.request({
      key: prefetch_key,
      priority: `current`,
      estimated_bytes: 64,
      prepare: recompute,
    }, transitioned_generation)
    expect(transitioned).toMatchObject({ status: `ready`, cache_hit: true })
    expect(recompute).not.toHaveBeenCalled()
  })

  test(`reports a cold current loader rejection without losing the last complete frame`, async () => {
    const request_source = safe_source_request()
    expect(request_source).toBeTypeOf(`function`)
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-scalar`,
      threading_expected: false,
      session_diagnostics: scalar_session_diagnostics(),
      elapsed_ms: 1,
      table: {
        pairs: new Uint32Array(0),
        images: new Int8Array(0),
        lengths: new Float32Array(0),
        strengths: new Float32Array(0),
      },
      gpu_positions_rgba: new Float32Array(8),
    })
    const complete = input()
    complete.source.frame_idx = 0
    const key_builder = (
      trajectory_frame_preparer as unknown as {
        trajectory_prepared_frame_key: (
          input: ExactFramePrepareInput,
        ) => PreparedFrameKey
      }
    ).trajectory_prepared_frame_key
    const complete_key = key_builder(complete)
    const pipeline = create_prepared_frame_pipeline()
    const generation = pipeline.begin_request(complete_key, 2)
    const complete_outcome = await pipeline.request({
      key: complete_key,
      priority: `current`,
      estimated_bytes: 64,
      prepare: () => prepare_exact_trajectory_frame(complete),
    }, generation)
    expect(complete_outcome).toMatchObject({ status: `ready` })
    const last_complete = pipeline.peek(complete_key)
    const report_error = vi.fn()
    const requester = vi.fn(async () => {
      throw new Error(`current source decode failed`)
    })

    await expect(
      request_source!(requester, 1, report_error),
    ).resolves.toBeNull()
    await Promise.resolve()

    expect(report_error).toHaveBeenCalledOnce()
    expect(report_error.mock.calls[0][0]).toMatchObject({
      name: `Error`,
      message: `current source decode failed`,
    })
    expect(pipeline.peek(complete_key)).toBe(last_complete)
    expect(pipeline.stats()).toMatchObject({
      cached_frames: 1,
      queued: 0,
      in_flight: 0,
    })

    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const current_block = scene.slice(
      scene.indexOf(`if (!current_source) {`),
      scene.indexOf(`const key_for_source =`),
    )
    expect(current_block).toContain(
      `request_trajectory_frame_source_safely(`,
    )
    expect(current_block).toContain(`report_prepared_failure(error)`)
  })

  test(`keeps the newer same-frame cold load authoritative when the older load rejects`, async () => {
    const request_source = safe_source_request()
    const request_guard = current_source_request_guard()
    expect(request_source).toBeTypeOf(`function`)
    expect(request_guard).toBeDefined()
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-scalar`,
      threading_expected: false,
      session_diagnostics: scalar_session_diagnostics(),
      elapsed_ms: 1,
      table: {
        pairs: new Uint32Array(0),
        images: new Int8Array(0),
        lengths: new Float32Array(0),
        strengths: new Float32Array(0),
      },
      gpu_positions_rgba: new Float32Array(8),
    })

    const owner = {}
    const frame_idx = 4
    const request_a = input()
    request_a.packet.frame.owner = owner
    request_a.packet.frame.frame_idx = frame_idx
    request_a.source.frame_idx = frame_idx
    request_a.source.positions_version = 41
    const request_b = input()
    request_b.packet.frame.owner = owner
    request_b.packet.frame.frame_idx = frame_idx
    request_b.source.frame_idx = frame_idx
    request_b.source.positions_version = 42
    request_b.source.positions = new Float32Array([
      0.4, 0, 0, 3.6, 0, 0,
    ])
    const key_builder = (
      trajectory_frame_preparer as unknown as {
        trajectory_prepared_frame_key: (
          input: ExactFramePrepareInput,
        ) => PreparedFrameKey
      }
    ).trajectory_prepared_frame_key
    const pipeline = create_prepared_frame_pipeline()
    const source_a = deferred<TrajectoryFrameSource | null>()
    const source_b = deferred<TrajectoryFrameSource | null>()
    const failure_buffer_event = vi.fn()
    let prepared_error: string | null = null
    let displayed_packet: RenderPacket | null = null

    const load_current = async (
      token: CurrentSourceRequestToken,
      pending: Promise<TrajectoryFrameSource | null>,
      request: ExactFramePrepareInput,
    ) => {
      const source = await request_source!(
        () => pending,
        frame_idx,
        (error) => {
          if (!request_guard!.settle(token)) return
          prepared_error = error.message
          failure_buffer_event(error)
        },
      )
      if (!request_guard!.settle(token) || !source) return
      request.source = source
      const key = key_builder(request)
      const generation = pipeline.begin_request(key, 5)
      const outcome = await pipeline.request({
        key,
        priority: `current`,
        estimated_bytes: 64,
        prepare: () => prepare_exact_trajectory_frame(request),
      }, generation)
      if (outcome.status !== `ready`) return
      displayed_packet = outcome.value.packet
      prepared_error = null
    }

    const token_a = request_guard!.begin(owner, frame_idx)
    const load_a = load_current(token_a, source_a.promise, request_a)
    const token_b = request_guard!.begin(owner, frame_idx)
    const load_b = load_current(token_b, source_b.promise, request_b)

    source_b.resolve(request_b.source)
    await load_b
    const key_b = key_builder(request_b)
    const displayed_b = displayed_packet
    expect(displayed_b).toBe(pipeline.peek(key_b)?.packet)

    source_a.reject(new Error(`stale current source decode failed`))
    await load_a

    expect(displayed_packet).toBe(displayed_b)
    expect(pipeline.peek(key_b)?.packet).toBe(displayed_b)
    expect(prepared_error).toBeNull()
    expect(failure_buffer_event).not.toHaveBeenCalled()

    const stale_success = request_guard!.begin(owner, frame_idx)
    const newer_success = request_guard!.begin(owner, frame_idx)
    let published = `B`
    if (request_guard!.settle(newer_success)) published = `newer`
    if (request_guard!.settle(stale_success)) published = `stale`
    expect(published).toBe(`newer`)
    expect(stale_success).not.toHaveProperty(`source`)
    expect(newer_success).not.toHaveProperty(`source`)

    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const current_block = scene.slice(
      scene.indexOf(`if (!current_source) {`),
      scene.indexOf(`const key_for_source =`),
    )
    expect(current_block).toContain(
      `current_source_request_guard.begin(`,
    )
    expect(
      current_block.match(/current_source_request_guard\.settle\(/g),
    ).toHaveLength(2)
  })

  test(`reports a prefetch loader rejection without cache or publication mutation`, async () => {
    const request_source = safe_source_request()
    expect(request_source).toBeTypeOf(`function`)
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-scalar`,
      threading_expected: false,
      session_diagnostics: scalar_session_diagnostics(),
      elapsed_ms: 1,
      table: {
        pairs: new Uint32Array(0),
        images: new Int8Array(0),
        lengths: new Float32Array(0),
        strengths: new Float32Array(0),
      },
      gpu_positions_rgba: new Float32Array(8),
    })
    const complete = input()
    complete.source.frame_idx = 0
    const key_builder = (
      trajectory_frame_preparer as unknown as {
        trajectory_prepared_frame_key: (
          input: ExactFramePrepareInput,
        ) => PreparedFrameKey
      }
    ).trajectory_prepared_frame_key
    const complete_key = key_builder(complete)
    const pipeline = create_prepared_frame_pipeline()
    const generation = pipeline.begin_request(complete_key, 2)
    await pipeline.request({
      key: complete_key,
      priority: `current`,
      estimated_bytes: 64,
      prepare: () => prepare_exact_trajectory_frame(complete),
    }, generation)
    const before = pipeline.stats()
    const publication = vi.fn()
    const report_error = vi.fn()
    const requester = vi.fn(async () => {
      throw new Error(`prefetch source decode failed`)
    })

    const source = await request_source!(requester, 1, report_error)
    if (source) publication(source)
    await Promise.resolve()

    expect(report_error).toHaveBeenCalledOnce()
    expect(report_error.mock.calls[0][0]).toMatchObject({
      name: `Error`,
      message: `prefetch source decode failed`,
    })
    expect(publication).not.toHaveBeenCalled()
    expect(pipeline.peek(complete_key)).not.toBeNull()
    expect(pipeline.stats()).toEqual(before)

    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const prefetch_block = scene.slice(
      scene.indexOf(`const prefetch_idx =`),
      scene.indexOf(`  })\n\n  $effect.pre`),
    )
    expect(prefetch_block).toContain(
      `request_trajectory_frame_source_safely(`,
    )
    expect(prefetch_block).toContain(`report_buffer_failure(error)`)
    const safe_request_start = prefetch_block.indexOf(
      `request_trajectory_frame_source_safely(`,
    )
    const source_guard = prefetch_block.indexOf(
      `if (!source?.topology_stable)`,
      safe_request_start,
    )
    expect(
      prefetch_block.slice(safe_request_start, source_guard),
    ).not.toContain(`getter?.(prefetch_idx)`)
  })

  test(`admits unknown prefetch decode with a current-key-derived provisional key`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const prefetch_block = scene.slice(
      scene.indexOf(`const prefetch_idx =`),
      scene.indexOf(`  })\n\n  $effect.pre`),
    )
    const deferred_request = prefetch_block.indexOf(
      `prepared_pipeline.request_deferred({`,
    )
    const decoder_request = prefetch_block.indexOf(
      `request_trajectory_frame_source_safely(`,
    )

    expect(deferred_request).toBeGreaterThanOrEqual(0)
    expect(decoder_request).toBeGreaterThan(deferred_request)
    expect(prefetch_block).toMatch(
      /const provisional_key: PreparedFrameKey = \{\s*\.\.\.current_key,\s*frame_idx: prefetch_idx,\s*\}/,
    )
    expect(prefetch_block).toContain(`key: provisional_key`)
    expect(prefetch_block).toContain(
      `if (!same_prepared_frame_key(decoded_key, provisional_key))`,
    )
    expect(prefetch_block).toContain(`retained_source_bytes:`)
  })

  test(`counts deferred warmup keys and treats budget refusal as buffer refresh`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const report_block = scene.slice(
      scene.indexOf(`const report_buffer =`),
      scene.indexOf(`report_buffer(true)`),
    )
    const prefetch_block = scene.slice(
      scene.indexOf(`const prefetch_idx =`),
      scene.indexOf(`  })\n\n  $effect.pre`),
    )

    expect(report_block).toContain(`prepared_frame_window_key(`)
    expect(report_block).not.toContain(`if (!buffered_source) break`)
    expect(prefetch_block).toContain(`report_prefetch_outcome`)
    expect(prefetch_block.match(/report_prefetch_outcome\(/g)).toHaveLength(2)
    expect(scene).toContain(
      `!is_prepared_frame_budget_refusal(outcome.error)`,
    )
    expect(scene).toContain(`report_buffer(false)`)
  })

  test(`custom rules use object detection, full override, and worker packing`, async () => {
    const request = input({
      distance_rules: [{
        element_1: `C`,
        element_2: `H`,
        min_dist: 0.3,
        max_dist: 0.5,
      }],
    })
    object_mock.mockResolvedValue([bond(0, 1, [0, 0, 0])])
    const packed = new Float32Array([0.2, 0, 0, 1, 3.8, 0, 0, 1])
    pack_mock.mockResolvedValue(packed)

    const prepared = await prepare_exact_trajectory_frame(request)

    expect(typed_mock).not.toHaveBeenCalled()
    expect(object_mock).toHaveBeenCalledOnce()
    const overlay = object_mock.mock.calls[0][0]
    expect(overlay.sites[0].xyz[0]).toBeCloseTo(0.2)
    expect(overlay.sites[1].xyz[0]).toBeCloseTo(3.8)
    expect((overlay as { lattice?: { matrix?: number[][] } }).lattice?.matrix)
      .toBe(request.source.lattice)
    expect(pack_mock).toHaveBeenCalledWith(request.source.positions)
    // The strategy bond at image 0 is outside the rule. The full override
    // regenerates the exact cross-cell contact and preserves its jimage.
    expect([...prepared.graph.pairs]).toEqual([0, 1])
    expect([...prepared.graph.jimages]).toEqual([-1, 0, 0])
    expect(prepared.gpu_positions_rgba).toBe(packed)
    expect(trajectory_render_diagnostics.snapshot()).toMatchObject({
      bond_backend: null,
      bond_session_frames: 0,
    })
  })

  test(`non-atom-radii and topology-changing sources never use typed fast path`, async () => {
    object_mock.mockResolvedValue([])
    pack_mock.mockResolvedValue(new Float32Array(8))

    await prepare_exact_trajectory_frame(input({ strategy: `solid_angle` }))
    await prepare_exact_trajectory_frame(input({
      source: { ...input().source, topology_stable: false },
    }))

    expect(typed_mock).not.toHaveBeenCalled()
    expect(object_mock).toHaveBeenCalledTimes(2)
    expect(pack_mock).toHaveBeenCalledTimes(2)
  })

  test(`small typed-worker failure uses the exact object backend and local packing`, async () => {
    typed_mock.mockRejectedValue(new Error(`typed worker unavailable`))
    object_mock.mockResolvedValue([bond(0, 1, [0, 0, 0])])
    pack_mock.mockRejectedValue(new Error(`packing worker unavailable`))
    const request = input()

    const prepared = await prepare_exact_trajectory_frame(request)

    expect(typed_mock).toHaveBeenCalledOnce()
    expect(object_mock).toHaveBeenCalledOnce()
    expect(pack_mock).toHaveBeenCalledOnce()
    expect([...prepared.graph.pairs]).toEqual([0, 1])
    expect([...prepared.gpu_positions_rgba]).toEqual([
      request.source.positions[0], 0, 0, 1,
      request.source.positions[3], 0, 0, 1,
    ])
  })

  test(`large typed-worker failure rejects without an object or main-thread fallback`, async () => {
    const request = input()
    const atom_count = 4096
    request.packet = {
      ...request.packet,
      topology: {
        ...request.packet.topology,
        atom_count,
        site_ids: new Uint32Array(atom_count),
        atomic_numbers: new Uint8Array(atom_count).fill(6),
        radii: new Float32Array(atom_count),
        colors: new Float32Array(atom_count * 3),
      },
    }
    request.structure = {
      ...request.structure,
      sites: Array.from(
        { length: atom_count },
        (_, idx) => site(`C`, [idx, 0, 0]),
      ),
    } as AnyStructure
    request.source = {
      ...request.source,
      positions: new Float32Array(atom_count * 3),
    }
    const failure = new Error(`typed worker unavailable`)
    typed_mock.mockRejectedValue(failure)

    await expect(prepare_exact_trajectory_frame(request)).rejects.toBe(failure)
    expect(object_mock).not.toHaveBeenCalled()
    expect(pack_mock).not.toHaveBeenCalled()
  })

  test(`atom-only frames bypass all bond workers and present packed positions`, async () => {
    const request = input({
      features: {
        strategy: `atom_radii`,
        atom_count: 2,
        show_bonds: false,
        topology_stable: true,
        atomic_numbers_complete: true,
        distance_rule_count: 0,
        site_radius_override_count: 0,
        manual_bond_count: 0,
        deleted_bond_count: 0,
        hidden_bond_features: false,
        hydrogen_bonds: false,
        bond_orders: false,
        clipping: false,
        polyhedra: false,
        drag_overrides: false,
      },
    })

    const prepared = await prepare_exact_trajectory_frame(request)

    expect(typed_mock).not.toHaveBeenCalled()
    expect(object_mock).not.toHaveBeenCalled()
    expect(pack_mock).not.toHaveBeenCalled()
    expect(prepared.graph.pairs).toHaveLength(0)
    expect([...prepared.gpu_positions_rgba]).toEqual([
      request.source.positions[0], 0, 0, 1,
      request.source.positions[3], 0, 0, 1,
    ])
    expect(trajectory_render_diagnostics.snapshot()).toMatchObject({
      bond_backend: null,
      bond_session_frames: 0,
    })
  })

  test(`pads atom-only positions to the complete 2D texture allocation`, async () => {
    const atom_count = 2_049
    const request = input()
    request.packet = {
      ...request.packet,
      topology: {
        ...request.packet.topology,
        atom_count,
        site_ids: new Uint32Array(atom_count),
        atomic_numbers: new Uint8Array(atom_count).fill(6),
        radii: new Float32Array(atom_count),
        colors: new Float32Array(atom_count * 3),
      },
    }
    request.source = {
      ...request.source,
      positions: new Float32Array(atom_count * 3),
    }
    request.features = {
      strategy: `atom_radii`,
      atom_count,
      show_bonds: false,
      topology_stable: true,
      atomic_numbers_complete: true,
      distance_rule_count: 0,
      site_radius_override_count: 0,
      manual_bond_count: 0,
      deleted_bond_count: 0,
      hidden_bond_features: false,
      hydrogen_bonds: false,
      bond_orders: false,
      clipping: false,
      polyhedra: false,
      drag_overrides: false,
    }

    const prepared = await prepare_exact_trajectory_frame(request)

    expect(prepared.gpu_positions_rgba).toHaveLength(
      position_texture_shape(atom_count).float_count,
    )
  })
})

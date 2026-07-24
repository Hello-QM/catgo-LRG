import type {
  BaseBondGraph,
  RenderPacket,
} from './scene/render-packet'
import { trajectory_render_diagnostics } from './trajectory-render-diagnostics'

export type PreparedFrameKey = {
  owner: object
  frame_idx: number
  positions_version: number
  topology_version: number
  topology_fingerprint: string
  rules_version: string
}

export type PreparedTrajectoryFrame = {
  key: PreparedFrameKey
  packet: RenderPacket
  graph: BaseBondGraph
  gpu_positions_rgba: Float32Array
  forces: Float32Array | null
  graph_hash: string
  byte_size: number
  compute_ms: number
}

export type PreparedFrameOutcome =
  | { status: 'ready'; value: PreparedTrajectoryFrame; cache_hit: boolean }
  | { status: 'stale' }
  | { status: 'failed'; error: Error }

export function same_prepared_frame_key(
  a: PreparedFrameKey,
  b: PreparedFrameKey,
): boolean {
  return a.owner === b.owner &&
    a.frame_idx === b.frame_idx &&
    a.positions_version === b.positions_version &&
    a.topology_version === b.topology_version &&
    a.topology_fingerprint === b.topology_fingerprint &&
    a.rules_version === b.rules_version
}

export function prepared_frame_byte_size(
  packet: RenderPacket,
  rgba: Float32Array,
  forces: Float32Array | null,
): number {
  const { topology, frame, replicas } = packet
  const graph = topology.bond_graph
  let bytes = frame.positions.byteLength +
    frame.lattice.byteLength +
    rgba.byteLength +
    (forces?.byteLength ?? 0) +
    topology.site_ids.byteLength +
    topology.atomic_numbers.byteLength +
    topology.radii.byteLength +
    topology.colors.byteLength +
    (replicas.physical_site_map?.byteLength ?? 0)

  if (graph) {
    bytes += graph.pairs.byteLength +
      graph.jimages.byteLength +
      graph.kinds.byteLength +
      graph.strengths.byteLength
  }
  return bytes
}

export type PrepareFrameRequest = {
  key: PreparedFrameKey
  priority: 'current' | 'prefetch'
  estimated_bytes: number
  prepare: () => Promise<PreparedTrajectoryFrame>
}

export type PreparedFramePipelineStats = {
  generation: number
  queued: number
  in_flight: number
  cached_frames: number
  cached_bytes: number
  queued_bytes: number
  in_flight_bytes: number
  retained_bytes: number
  cache_hits: number
  cache_misses: number
  evictions: number
  stale_results: number
}

export type PreparedFramePipeline = {
  begin_request(key: PreparedFrameKey, frame_count?: number): number
  request(
    request: PrepareFrameRequest,
    generation: number,
  ): Promise<PreparedFrameOutcome>
  peek(key: PreparedFrameKey): PreparedTrajectoryFrame | null
  ready_count(keys: readonly PreparedFrameKey[]): number
  stats(): PreparedFramePipelineStats
  clear(owner?: object): void
}

type QueueRecord = {
  request: PrepareFrameRequest
  generation: number
  sequence: number
  promise: Promise<PreparedFrameOutcome>
  resolve: (outcome: PreparedFrameOutcome) => void
  canceled: boolean
}

type CacheRecord = {
  value: PreparedTrajectoryFrame
  last_used: number
  priority: 'current' | 'prefetch'
}

function error_from_unknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function create_prepared_frame_pipeline(options: {
  max_frames?: number
  max_bytes?: number
  max_in_flight?: number
} = {}): PreparedFramePipeline {
  const max_frames = Math.max(1, options.max_frames ?? 8)
  const max_bytes = Math.max(1, options.max_bytes ?? 96 * 1024 * 1024)
  const max_in_flight = Math.max(1, options.max_in_flight ?? 1)
  let generation = 0
  let sequence = 0
  let usage_clock = 0
  let current_key: PreparedFrameKey | null = null
  let displayed_key: PreparedFrameKey | null = null
  let previous_request_key: PreparedFrameKey | null = null
  let stream_frame_count: number | null = null
  let cache_hits = 0
  let cache_misses = 0
  let evictions = 0
  let stale_results = 0
  let cache: CacheRecord[] = []
  let queue: QueueRecord[] = []
  let in_flight: QueueRecord[] = []

  const cached_bytes = (): number =>
    cache.reduce((sum, record) => sum + record.value.byte_size, 0)
  const queued_bytes = (): number =>
    queue.reduce((sum, record) => sum + record.request.estimated_bytes, 0)
  const in_flight_bytes = (): number =>
    in_flight.reduce((sum, record) => sum + record.request.estimated_bytes, 0)

  function update_diagnostics(): void {
    const cache_byte_count = cached_bytes()
    const queued_byte_count = queued_bytes()
    const in_flight_byte_count = in_flight_bytes()
    trajectory_render_diagnostics.update_retained({
      cache_frames: cache.length,
      cache_bytes: cache_byte_count,
      queued_bytes: queued_byte_count,
      in_flight_bytes: in_flight_byte_count,
      retained_bytes: cache_byte_count + queued_byte_count + in_flight_byte_count,
    })
  }

  function is_protected(record: CacheRecord): boolean {
    return (current_key !== null &&
        same_prepared_frame_key(record.value.key, current_key)) ||
      (displayed_key !== null &&
        same_prepared_frame_key(record.value.key, displayed_key))
  }

  function evict_to_limits(): void {
    while (cache.length > max_frames || cached_bytes() > max_bytes) {
      const available = cache.filter((record) => !is_protected(record))
      if (available.length === 0) break
      const prefetched = available.filter((record) =>
        record.priority === `prefetch`
      )
      const candidates = prefetched.length > 0 ? prefetched : available
      const playhead = current_key?.frame_idx ?? 0
      candidates.sort((left, right) => {
        const left_distance = stream_frame_count
          ? (
            left.value.key.frame_idx - playhead + stream_frame_count
          ) % stream_frame_count
          : Math.abs(left.value.key.frame_idx - playhead)
        const right_distance = stream_frame_count
          ? (
            right.value.key.frame_idx - playhead + stream_frame_count
          ) % stream_frame_count
          : Math.abs(right.value.key.frame_idx - playhead)
        if (left_distance !== right_distance) {
          return right_distance - left_distance
        }
        return left.last_used - right.last_used
      })
      const victim = candidates[0]
      cache = cache.filter((record) => record !== victim)
      evictions++
    }
  }

  function find_pending(
    key: PreparedFrameKey,
    request_generation: number,
  ): QueueRecord | null {
    return queue.find((record) =>
      record.generation === request_generation &&
      same_prepared_frame_key(record.request.key, key)
    ) ?? in_flight.find((record) =>
      record.generation === request_generation &&
      same_prepared_frame_key(record.request.key, key)
    ) ?? null
  }

  function finish_stale(record: QueueRecord): void {
    stale_results++
    trajectory_render_diagnostics.record(
      `stale`,
      record.request.key.frame_idx,
      undefined,
      record.request.key.positions_version,
    )
    record.resolve({ status: `stale` })
  }

  function complete(
    record: QueueRecord,
    value: PreparedTrajectoryFrame,
  ): void {
    in_flight = in_flight.filter((candidate) => candidate !== record)
    if (record.canceled || record.generation !== generation) {
      finish_stale(record)
      update_diagnostics()
      pump()
      return
    }
    if (!same_prepared_frame_key(record.request.key, value.key)) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[trajectory-prepared] frame ${record.request.key.frame_idx} failed: ` +
          `prepared key does not match request`,
        )
      }
      trajectory_render_diagnostics.record(
        `failed`,
        record.request.key.frame_idx,
        undefined,
        record.request.key.positions_version,
      )
      record.resolve({
        status: `failed`,
        error: new Error(
          `Prepared frame key does not match request for frame ` +
            `${record.request.key.frame_idx}`,
        ),
      })
      update_diagnostics()
      pump()
      return
    }

    cache = cache.filter((candidate) =>
      !same_prepared_frame_key(candidate.value.key, value.key)
    )
    cache.push({
      value,
      last_used: ++usage_clock,
      priority: current_key !== null &&
          same_prepared_frame_key(value.key, current_key)
        ? `current`
        : record.request.priority,
    })
    if (
      current_key !== null &&
      same_prepared_frame_key(value.key, current_key)
    ) {
      // The visible packet retains its own immutable snapshot. Once the new
      // current snapshot is complete, cache protection can move forward and
      // release the former displayed slot for the seventh ahead frame.
      displayed_key = value.key
    }
    trajectory_render_diagnostics.record_prepared(
      value.key.frame_idx,
      value.graph_hash,
      value.graph.pairs.length / 2,
      value.compute_ms,
    )
    evict_to_limits()
    record.resolve({ status: `ready`, value, cache_hit: false })
    update_diagnostics()
    pump()
  }

  function fail(record: QueueRecord, error: unknown): void {
    in_flight = in_flight.filter((candidate) => candidate !== record)
    if (record.canceled || record.generation !== generation) {
      finish_stale(record)
    } else {
      if (import.meta.env?.DEV) {
        console.warn(
          `[trajectory-prepared] frame ${record.request.key.frame_idx} failed:`,
          error_from_unknown(error).message,
        )
      }
      trajectory_render_diagnostics.record(
        `failed`,
        record.request.key.frame_idx,
        undefined,
        record.request.key.positions_version,
      )
      record.resolve({ status: `failed`, error: error_from_unknown(error) })
    }
    update_diagnostics()
    pump()
  }

  function pump(): void {
    while (in_flight.length < max_in_flight && queue.length > 0) {
      queue.sort((left, right) => {
        if (left.request.priority !== right.request.priority) {
          return left.request.priority === `current` ? -1 : 1
        }
        return left.sequence - right.sequence
      })
      const record = queue.shift()!
      if (record.canceled || record.generation !== generation) {
        finish_stale(record)
        continue
      }
      in_flight.push(record)
      update_diagnostics()
      try {
        Promise.resolve(record.request.prepare()).then(
          (value) => complete(record, value),
          (error) => fail(record, error),
        )
      } catch (error) {
        fail(record, error)
      }
    }
    update_diagnostics()
  }

  function begin_request(
    key: PreparedFrameKey,
    frame_count?: number,
  ): number {
    stream_frame_count = frame_count !== undefined && frame_count > 0
      ? frame_count
      : stream_frame_count
    const previous = previous_request_key
    const same_stream = previous !== null &&
      previous.owner === key.owner &&
      previous.positions_version === key.positions_version &&
      previous.topology_version === key.topology_version &&
      previous.topology_fingerprint === key.topology_fingerprint &&
      previous.rules_version === key.rules_version
    const sequential = previous !== null &&
      (key.frame_idx === previous.frame_idx ||
        key.frame_idx === previous.frame_idx + 1 ||
        (
          frame_count !== undefined &&
          frame_count > 1 &&
          previous.frame_idx === frame_count - 1 &&
          key.frame_idx === 0
        ))
    const owner_changed = previous !== null && previous.owner !== key.owner
    const current_frame_edited = (
      previous !== null &&
      previous.owner === key.owner &&
      previous.frame_idx === key.frame_idx &&
      previous.positions_version !== key.positions_version
    ) || cache.some((record) =>
      record.value.key.owner === key.owner &&
      record.value.key.frame_idx === key.frame_idx &&
      record.value.key.positions_version !== key.positions_version
    )

    if (!same_stream || !sequential || current_frame_edited) {
      generation++
      const stale_queue = queue.filter((record) =>
        record.generation !== generation
      )
      queue = queue.filter((record) => record.generation === generation)
      for (const record of stale_queue) finish_stale(record)
    }

    if (owner_changed) {
      cache = cache.filter((record) => record.value.key.owner !== previous.owner)
      displayed_key = null
    } else {
      displayed_key = current_key
      if (current_frame_edited) {
        // A position edit is frame-scoped even though it starts a fresh seek
        // generation. Preserve other completed frames; only the obsolete
        // revisions of the edited frame can no longer be presented.
        cache = cache.filter((record) =>
          record.value.key.owner !== key.owner ||
          record.value.key.frame_idx !== key.frame_idx ||
          record.value.key.positions_version === key.positions_version
        )
      } else if (previous !== null && !same_stream) {
        cache = cache.filter((record) =>
          record.value.key.owner !== key.owner ||
          (
            record.value.key.topology_version === key.topology_version &&
            record.value.key.topology_fingerprint ===
              key.topology_fingerprint &&
            record.value.key.rules_version === key.rules_version
          )
        )
      }
    }
    current_key = key
    previous_request_key = key
    // `current` is a property of the present playhead, not a lifetime cache
    // rank. Without demotion, every frame ever displayed remains current and
    // a post-seek prefetch evicts itself before those distant old frames.
    for (const record of cache) {
      record.priority = same_prepared_frame_key(record.value.key, key)
        ? `current`
        : `prefetch`
    }
    const cached = cache.find((record) =>
      same_prepared_frame_key(record.value.key, key)
    )
    if (cached) {
      cached.priority = `current`
      cached.last_used = ++usage_clock
      // A cached current request resolves in the same microtask and the old
      // visible packet is retained outside this cache. Move protection now so
      // current + seven ahead frames fit without recomputing the tail.
      displayed_key = cached.value.key
    }
    evict_to_limits()
    update_diagnostics()
    pump()
    return generation
  }

  function request(
    frame_request: PrepareFrameRequest,
    request_generation: number,
  ): Promise<PreparedFrameOutcome> {
    trajectory_render_diagnostics.record(
      `requested`,
      frame_request.key.frame_idx,
      undefined,
      frame_request.key.positions_version,
    )
    if (request_generation !== generation) {
      stale_results++
      trajectory_render_diagnostics.record(
        `stale`,
        frame_request.key.frame_idx,
        undefined,
        frame_request.key.positions_version,
      )
      return Promise.resolve({ status: `stale` })
    }

    const cached = cache.find((record) =>
      same_prepared_frame_key(record.value.key, frame_request.key)
    )
    if (cached) {
      cache_hits++
      cached.last_used = ++usage_clock
      if (frame_request.priority === `current`) cached.priority = `current`
      trajectory_render_diagnostics.record(
        `cached`,
        frame_request.key.frame_idx,
        undefined,
        frame_request.key.positions_version,
      )
      return Promise.resolve({
        status: `ready`,
        value: cached.value,
        cache_hit: true,
      })
    }

    const pending = find_pending(frame_request.key, request_generation)
    if (pending) return pending.promise
    cache_misses++

    const retained = cached_bytes() + queued_bytes() + in_flight_bytes()
    if (
      frame_request.priority === `prefetch` &&
      retained + frame_request.estimated_bytes > max_bytes
    ) {
      const error = new Error(
        `Prepared-frame prefetch exceeds byte budget of ${max_bytes}`,
      )
      if (import.meta.env?.DEV) {
        console.warn(
          `[trajectory-prepared] frame ${frame_request.key.frame_idx} failed:`,
          error.message,
        )
      }
      trajectory_render_diagnostics.record(
        `failed`,
        frame_request.key.frame_idx,
        undefined,
        frame_request.key.positions_version,
      )
      return Promise.resolve({ status: `failed`, error })
    }

    let resolve!: (outcome: PreparedFrameOutcome) => void
    const promise = new Promise<PreparedFrameOutcome>((done) => {
      resolve = done
    })
    const record: QueueRecord = {
      request: frame_request,
      generation: request_generation,
      sequence: sequence++,
      promise,
      resolve,
      canceled: false,
    }
    queue.push(record)
    update_diagnostics()
    pump()
    return promise
  }

  function peek(key: PreparedFrameKey): PreparedTrajectoryFrame | null {
    const record = cache.find((candidate) =>
      same_prepared_frame_key(candidate.value.key, key)
    )
    if (!record) return null
    record.last_used = ++usage_clock
    return record.value
  }

  function ready_count(keys: readonly PreparedFrameKey[]): number {
    let count = 0
    for (const key of keys) {
      if (!cache.some((record) =>
        same_prepared_frame_key(record.value.key, key)
      )) break
      count++
    }
    return count
  }

  function stats(): PreparedFramePipelineStats {
    const cache_byte_count = cached_bytes()
    const queued_byte_count = queued_bytes()
    const in_flight_byte_count = in_flight_bytes()
    return {
      generation,
      queued: queue.length,
      in_flight: in_flight.length,
      cached_frames: cache.length,
      cached_bytes: cache_byte_count,
      queued_bytes: queued_byte_count,
      in_flight_bytes: in_flight_byte_count,
      retained_bytes: cache_byte_count + queued_byte_count + in_flight_byte_count,
      cache_hits,
      cache_misses,
      evictions,
      stale_results,
    }
  }

  function clear(owner?: object): void {
    const matches = (key: PreparedFrameKey): boolean =>
      owner === undefined || key.owner === owner
    cache = cache.filter((record) => !matches(record.value.key))
    const canceled_queue = queue.filter((record) => matches(record.request.key))
    queue = queue.filter((record) => !matches(record.request.key))
    for (const record of canceled_queue) {
      record.canceled = true
      finish_stale(record)
    }
    for (const record of in_flight) {
      if (matches(record.request.key)) record.canceled = true
    }
    if (
      owner === undefined ||
      (current_key !== null && current_key.owner === owner)
    ) {
      generation++
      current_key = null
      displayed_key = null
      previous_request_key = null
      stream_frame_count = null
    }
    update_diagnostics()
    pump()
  }

  return { begin_request, request, peek, ready_count, stats, clear }
}

export type TrajectoryRenderEvent =
  | 'requested'
  | 'prepared'
  | 'cached'
  | 'stale'
  | 'failed'
  | 'presented'

export type TrajectoryRetainedState = {
  cache_frames: number
  cache_bytes: number
  queued_bytes: number
  in_flight_bytes: number
  retained_bytes: number
}

export type TrajectoryRenderDiagnostics = TrajectoryRetainedState & {
  requested_frames: number
  prepared_frames: number
  cache_hits: number
  stale_results: number
  failed_frames: number
  presented_frames: number
  unique_presented_frames: number
  last_requested_frame: number | null
  last_prepared_frame: number | null
  last_presented_frame: number | null
  renderer_installed_frames: number
  last_renderer_installed_frame: number | null
  graph_hash_by_frame: Record<number, string>
  bond_count_by_frame: Record<number, number>
  renderer_graph_hash_by_frame: Record<number, string>
  renderer_bond_count_by_frame: Record<number, number>
  bond_compute_ms: number[]
  cold_first_frame_ms: number | null
  warmup_ms: number | null
  frame_time_p95_ms: number | null
  main_thread_long_tasks: number
  position_uploads: number
  position_upload_bytes: number
  topology_uploads: number
  topology_upload_bytes: number
  bond_main_topology_uploads: number
  bond_main_topology_upload_bytes: number
  bond_main_topology_uploaded_bonds: number
  picker_position_uploads: number
  presentation_latency_ms: number[]
  unique_frame_fps: number
}

export type TrajectoryRenderDiagnosticsRecorder = {
  begin_owner(owner: object, timestamp_ms?: number): void
  record(
    event: TrajectoryRenderEvent,
    frame_idx: number,
    timestamp_ms?: number,
    positions_version?: number,
  ): void
  record_prepared(
    frame_idx: number,
    graph_hash: string,
    bond_count: number,
    compute_ms: number,
  ): void
  record_presented(
    frame_idx: number,
    positions_version: number,
    graph_hash: string,
    bond_count: number,
    timestamp_ms?: number,
  ): void
  record_renderer_installed(
    frame_idx: number,
    positions_version: number,
    graph_hash: string,
    bond_count: number,
    timestamp_ms?: number,
  ): void
  record_position_upload(bytes: number): void
  record_topology_upload(bytes: number): void
  record_bond_main_topology_upload(bond_count: number, bytes: number): void
  record_picker_position_upload(): void
  record_long_task(): void
  update_retained(state: TrajectoryRetainedState): void
  snapshot(): TrajectoryRenderDiagnostics
  reset(): void
}

declare global {
  // Development/test-only browser contract consumed by Playwright gates.
  // eslint-disable-next-line no-var
  var __catgoTrajectoryDiagnostics:
    | (() => TrajectoryRenderDiagnostics)
    | undefined
  // eslint-disable-next-line no-var
  var __catgoTrajectoryDiagnosticsReset: (() => void) | undefined
  // eslint-disable-next-line no-var
  var __catgoTrajectoryExactReference:
    | (() => Promise<{
      graph_hash_by_frame: Record<number, string>
      bond_count_by_frame: Record<number, number>
      elapsed_ms: number
    }>)
    | undefined
}

const RING_CAPACITY = 256

class NumberRing {
  readonly #values = new Float64Array(RING_CAPACITY)
  #start = 0
  #count = 0

  push(value: number): void {
    if (!Number.isFinite(value)) return
    if (this.#count < RING_CAPACITY) {
      this.#values[(this.#start + this.#count) % RING_CAPACITY] = value
      this.#count++
      return
    }
    this.#values[this.#start] = value
    this.#start = (this.#start + 1) % RING_CAPACITY
  }

  to_array(): number[] {
    const result = new Array<number>(this.#count)
    for (let idx = 0; idx < this.#count; idx++) {
      result[idx] = this.#values[(this.#start + idx) % RING_CAPACITY]
    }
    return result
  }
}

type MutableDiagnostics = Omit<
  TrajectoryRenderDiagnostics,
  | 'bond_compute_ms'
  | 'frame_time_p95_ms'
  | 'presentation_latency_ms'
  | 'unique_frame_fps'
>

function initial_state(): MutableDiagnostics {
  return {
    requested_frames: 0,
    prepared_frames: 0,
    cache_hits: 0,
    stale_results: 0,
    failed_frames: 0,
    presented_frames: 0,
    unique_presented_frames: 0,
    last_requested_frame: null,
    last_prepared_frame: null,
    last_presented_frame: null,
    renderer_installed_frames: 0,
    last_renderer_installed_frame: null,
    graph_hash_by_frame: {},
    bond_count_by_frame: {},
    renderer_graph_hash_by_frame: {},
    renderer_bond_count_by_frame: {},
    cold_first_frame_ms: null,
    warmup_ms: null,
    main_thread_long_tasks: 0,
    cache_frames: 0,
    cache_bytes: 0,
    queued_bytes: 0,
    in_flight_bytes: 0,
    retained_bytes: 0,
    position_uploads: 0,
    position_upload_bytes: 0,
    topology_uploads: 0,
    topology_upload_bytes: 0,
    bond_main_topology_uploads: 0,
    bond_main_topology_upload_bytes: 0,
    bond_main_topology_uploaded_bonds: 0,
    picker_position_uploads: 0,
  }
}

function percentile_95(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

function event_key(frame_idx: number, positions_version: number): string {
  return `${frame_idx}:${positions_version}`
}

function renderer_event_key(
  frame_idx: number,
  positions_version: number,
  graph_hash: string,
  bond_count: number,
): string {
  return `${event_key(frame_idx, positions_version)}:${bond_count}:${graph_hash}`
}

export function create_trajectory_render_diagnostics():
  TrajectoryRenderDiagnosticsRecorder {
  let state = initial_state()
  let owner: object | null = null
  let owner_started_ms: number | null = null
  let last_unique_identity: string | null = null
  let last_renderer_identity: string | null = null
  let last_unique_timestamp_ms: number | null = null
  let requested_at = new Map<string, number>()
  let bond_compute = new NumberRing()
  let presentation_latency = new NumberRing()
  let unique_timestamps = new NumberRing()
  let frame_times = new NumberRing()

  const reset_state = (): void => {
    state = initial_state()
    owner_started_ms = null
    last_unique_identity = null
    last_renderer_identity = null
    last_unique_timestamp_ms = null
    requested_at = new Map()
    bond_compute = new NumberRing()
    presentation_latency = new NumberRing()
    unique_timestamps = new NumberRing()
    frame_times = new NumberRing()
  }

  const recorder: TrajectoryRenderDiagnosticsRecorder = {
    begin_owner(next_owner, timestamp_ms = performance.now()) {
      if (owner === next_owner) return
      owner = next_owner
      reset_state()
      owner_started_ms = timestamp_ms
    },
    record(
      event,
      frame_idx,
      timestamp_ms = performance.now(),
      positions_version = 0,
    ) {
      const key = event_key(frame_idx, positions_version)
      if (event === `requested`) {
        state.requested_frames++
        state.last_requested_frame = frame_idx
        if (!requested_at.has(key)) requested_at.set(key, timestamp_ms)
      } else if (event === `prepared`) {
        state.prepared_frames++
        state.last_prepared_frame = frame_idx
      } else if (event === `cached`) {
        state.cache_hits++
      } else if (event === `stale`) {
        state.stale_results++
      } else if (event === `failed`) {
        state.failed_frames++
      } else {
        state.presented_frames++
        state.last_presented_frame = frame_idx
        const requested_ms = requested_at.get(key)
        if (requested_ms !== undefined) {
          presentation_latency.push(Math.max(0, timestamp_ms - requested_ms))
          requested_at.delete(key)
        }
        if (last_unique_identity === key) return
        last_unique_identity = key
        state.unique_presented_frames++
        unique_timestamps.push(timestamp_ms)
        if (owner_started_ms === null) owner_started_ms = timestamp_ms
        if (state.cold_first_frame_ms === null) {
          state.cold_first_frame_ms = Math.max(0, timestamp_ms - owner_started_ms)
        }
        if (last_unique_timestamp_ms !== null) {
          frame_times.push(Math.max(0, timestamp_ms - last_unique_timestamp_ms))
        }
        last_unique_timestamp_ms = timestamp_ms
        if (
          state.unique_presented_frames === 3 &&
          state.warmup_ms === null
        ) {
          state.warmup_ms = Math.max(0, timestamp_ms - owner_started_ms)
        }
      }
    },
    record_prepared(frame_idx, graph_hash, bond_count, compute_ms) {
      state.prepared_frames++
      state.last_prepared_frame = frame_idx
      bond_compute.push(compute_ms)
    },
    record_presented(
      frame_idx,
      positions_version,
      graph_hash,
      bond_count,
      timestamp_ms = performance.now(),
    ) {
      // These maps are display evidence, not prefetch evidence. Record them
      // only at the same commit point that publishes the matching packet and
      // manager graph to the renderer.
      state.graph_hash_by_frame[frame_idx] = graph_hash
      state.bond_count_by_frame[frame_idx] = bond_count
      recorder.record(
        `presented`,
        frame_idx,
        timestamp_ms,
        positions_version,
      )
    },
    record_renderer_installed(
      frame_idx,
      positions_version,
      graph_hash,
      bond_count,
      timestamp_ms = performance.now(),
    ) {
      const key = renderer_event_key(
        frame_idx,
        positions_version,
        graph_hash,
        bond_count,
      )
      if (last_renderer_identity === key) return
      last_renderer_identity = key
      state.renderer_installed_frames++
      state.last_renderer_installed_frame = frame_idx
      state.renderer_graph_hash_by_frame[frame_idx] = graph_hash
      state.renderer_bond_count_by_frame[frame_idx] = bond_count
      recorder.record_presented(
        frame_idx,
        positions_version,
        graph_hash,
        bond_count,
        timestamp_ms,
      )
    },
    record_position_upload(bytes) {
      state.position_uploads++
      state.position_upload_bytes += Math.max(0, bytes)
    },
    record_topology_upload(bytes) {
      state.topology_uploads++
      state.topology_upload_bytes += Math.max(0, bytes)
    },
    record_bond_main_topology_upload(bond_count, bytes) {
      state.bond_main_topology_uploads++
      state.bond_main_topology_upload_bytes += Math.max(0, bytes)
      state.bond_main_topology_uploaded_bonds += Math.max(0, bond_count)
    },
    record_picker_position_upload() {
      state.picker_position_uploads++
    },
    record_long_task() {
      state.main_thread_long_tasks++
    },
    update_retained(retained) {
      // Preserve peaks: the browser gate must be able to prove that no
      // transient queue/cache state crossed either configured memory bound.
      state.cache_frames = Math.max(state.cache_frames, retained.cache_frames)
      state.cache_bytes = Math.max(state.cache_bytes, retained.cache_bytes)
      state.queued_bytes = Math.max(state.queued_bytes, retained.queued_bytes)
      state.in_flight_bytes = Math.max(
        state.in_flight_bytes,
        retained.in_flight_bytes,
      )
      state.retained_bytes = Math.max(state.retained_bytes, retained.retained_bytes)
      if (
        state.warmup_ms === null &&
        retained.cache_frames >= 3 &&
        owner_started_ms !== null
      ) {
        state.warmup_ms = Math.max(0, performance.now() - owner_started_ms)
      }
    },
    snapshot() {
      const compute_values = bond_compute.to_array()
      const latency_values = presentation_latency.to_array()
      const timestamp_values = unique_timestamps.to_array()
      const elapsed = timestamp_values.length > 1
        ? timestamp_values.at(-1)! - timestamp_values[0]
        : 0
      const unique_frame_fps = elapsed > 0
        ? (timestamp_values.length - 1) * 1_000 / elapsed
        : 0
      return {
        ...state,
        graph_hash_by_frame: { ...state.graph_hash_by_frame },
        bond_count_by_frame: { ...state.bond_count_by_frame },
        renderer_graph_hash_by_frame: {
          ...state.renderer_graph_hash_by_frame,
        },
        renderer_bond_count_by_frame: {
          ...state.renderer_bond_count_by_frame,
        },
        bond_compute_ms: compute_values,
        frame_time_p95_ms: percentile_95(frame_times.to_array()),
        presentation_latency_ms: latency_values,
        unique_frame_fps,
      }
    },
    reset() {
      reset_state()
      owner_started_ms = performance.now()
    },
  }
  return recorder
}

export const trajectory_render_diagnostics =
  create_trajectory_render_diagnostics()

if (import.meta.env?.DEV || import.meta.env?.MODE === `test`) {
  globalThis.__catgoTrajectoryDiagnostics =
    trajectory_render_diagnostics.snapshot
  globalThis.__catgoTrajectoryDiagnosticsReset =
    trajectory_render_diagnostics.reset
}

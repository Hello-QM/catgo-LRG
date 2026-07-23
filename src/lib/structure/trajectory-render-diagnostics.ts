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
  last_requested_frame: number | null
  last_prepared_frame: number | null
  last_presented_frame: number | null
}

export type TrajectoryRenderDiagnosticsRecorder = {
  record(event: TrajectoryRenderEvent, frame_idx: number): void
  update_retained(state: TrajectoryRetainedState): void
  snapshot(): TrajectoryRenderDiagnostics
  reset(): void
}

function initial_state(): TrajectoryRenderDiagnostics {
  return {
    requested_frames: 0,
    prepared_frames: 0,
    cache_hits: 0,
    stale_results: 0,
    failed_frames: 0,
    presented_frames: 0,
    last_requested_frame: null,
    last_prepared_frame: null,
    last_presented_frame: null,
    cache_frames: 0,
    cache_bytes: 0,
    queued_bytes: 0,
    in_flight_bytes: 0,
    retained_bytes: 0,
  }
}

export function create_trajectory_render_diagnostics():
  TrajectoryRenderDiagnosticsRecorder {
  let state = initial_state()
  return {
    record(event, frame_idx) {
      if (event === `requested`) {
        state.requested_frames++
        state.last_requested_frame = frame_idx
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
      }
    },
    update_retained(retained) {
      state.cache_frames = retained.cache_frames
      state.cache_bytes = retained.cache_bytes
      state.queued_bytes = retained.queued_bytes
      state.in_flight_bytes = retained.in_flight_bytes
      state.retained_bytes = retained.retained_bytes
    },
    snapshot() {
      return { ...state }
    },
    reset() {
      state = initial_state()
    },
  }
}

export const trajectory_render_diagnostics =
  create_trajectory_render_diagnostics()

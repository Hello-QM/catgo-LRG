export type PreparedPlaybackState = {
  requested_idx: number
  presented_idx: number
  generation: number
}

export function request_playback_frame(
  state: PreparedPlaybackState,
  frame_idx: number,
): PreparedPlaybackState {
  if (frame_idx === state.requested_idx) return state
  const sequential = frame_idx === state.requested_idx + 1
  return {
    requested_idx: frame_idx,
    presented_idx: state.presented_idx,
    generation: state.generation + (sequential ? 0 : 1),
  }
}

export function acknowledge_playback_frame(
  state: PreparedPlaybackState,
  frame_idx: number,
): PreparedPlaybackState {
  if (frame_idx !== state.requested_idx || frame_idx === state.presented_idx) {
    return state
  }
  return { ...state, presented_idx: frame_idx }
}

export function may_advance_playback(state: PreparedPlaybackState): boolean {
  return state.requested_idx === state.presented_idx
}

export function may_start_prepared_playback(
  ready_frames: number,
  total_frames: number,
): boolean {
  return ready_frames >= Math.min(3, Math.max(1, total_frames))
}

export function playback_poll_interval_ms(rate_ms: number): number {
  return Math.min(8, Math.max(1, rate_ms))
}

export function advance_playback_deadline(
  previous_deadline_ms: number,
  now_ms: number,
  rate_ms: number,
): number {
  return Math.max(previous_deadline_ms + rate_ms, now_ms)
}

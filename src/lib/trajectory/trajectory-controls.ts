// Pure TypeScript helpers for trajectory playback and animation state management
import type { TrajectoryType, TrajHandlerData } from './index'

/**
 * Clamp an FPS value to a given range.
 */
export function clamp_fps(fps: number, fps_range: [number, number]): number {
  if (fps < fps_range[0]) return fps_range[0]
  if (fps > fps_range[1]) return fps_range[1]
  return fps
}

/**
 * Handle keyboard shortcuts for trajectory navigation.
 * Returns an action descriptor or null if no action matched.
 */
export type KeyAction =
  | { type: `toggle_play` }
  | { type: `prev_step` }
  | { type: `next_step` }
  | { type: `go_to_step`; idx: number }
  | { type: `fullscreen` }
  | { type: `fps_change`; delta: number }
  | { type: `close_dropdown` }
  | { type: `exit_fullscreen` }
  | null

export function get_keyboard_action(
  event: KeyboardEvent,
  opts: {
    total_frames: number
    current_step_idx: number
    is_playing: boolean
    has_fullscreen_toggle: boolean
    view_mode_dropdown_open: boolean
    fps_range: [number, number]
    fps: number
  },
): KeyAction {
  const is_cmd_or_ctrl = event.metaKey || event.ctrlKey

  if (event.key === ` `) return { type: `toggle_play` }

  if (event.key === `a` || event.key === `A`) {
    if (is_cmd_or_ctrl) return { type: `go_to_step`, idx: 0 }
    return { type: `prev_step` }
  }
  if (event.key === `d` || event.key === `D`) {
    if (is_cmd_or_ctrl) return { type: `go_to_step`, idx: opts.total_frames - 1 }
    return { type: `next_step` }
  }

  if (event.key === `Home`) return { type: `go_to_step`, idx: 0 }
  if (event.key === `End`) return { type: `go_to_step`, idx: opts.total_frames - 1 }

  if (event.key === `j`) {
    return { type: `go_to_step`, idx: Math.max(0, opts.current_step_idx - 10) }
  }
  if (event.key === `l`) {
    return { type: `go_to_step`, idx: Math.min(opts.total_frames - 1, opts.current_step_idx + 10) }
  }

  if (event.key === `PageUp`) {
    return { type: `go_to_step`, idx: Math.max(0, opts.current_step_idx - 25) }
  }
  if (event.key === `PageDown`) {
    return { type: `go_to_step`, idx: Math.min(opts.total_frames - 1, opts.current_step_idx + 25) }
  }

  if (event.key === `f` && opts.has_fullscreen_toggle) return { type: `fullscreen` }

  if ((event.key === `=` || event.key === `+`) && opts.is_playing) {
    return { type: `fps_change`, delta: 0.2 }
  }
  if (event.key === `-` && opts.is_playing) {
    return { type: `fps_change`, delta: -0.2 }
  }

  if (event.key === `Escape`) {
    if (document.fullscreenElement) return { type: `exit_fullscreen` }
    if (opts.view_mode_dropdown_open) return { type: `close_dropdown` }
  }

  // Number keys 0-9 - jump to percentage of trajectory
  if (event.key >= `0` && event.key <= `9`) {
    return {
      type: `go_to_step`,
      idx: Math.floor((parseInt(event.key, 10) / 10) * (opts.total_frames - 1)),
    }
  }

  return null
}

/**
 * Build the callback data object for trajectory event handlers.
 */
export function build_handler_data(
  trajectory: TrajectoryType | undefined,
  overrides: Partial<TrajHandlerData> = {},
): TrajHandlerData {
  return {
    trajectory,
    ...overrides,
  }
}

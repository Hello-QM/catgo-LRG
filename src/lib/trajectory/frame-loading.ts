import type { TrajectoryFrame, TrajectoryType } from './index'

export type FrameRequestOutcome =
  | { status: `loaded`; frame: TrajectoryFrame }
  | { status: `failed`; frame: TrajectoryFrame | null; error: Error }
  | { status: `stale` }

export interface FrameRequestLoader {
  invalidate(): void
  is_current(
    outcome: FrameRequestOutcome,
    trajectory: TrajectoryType | undefined,
  ): boolean
  load(
    trajectory: TrajectoryType,
    frame_idx: number,
    previous: TrajectoryFrame | null,
    fallback_source: string | ArrayBuffer | null,
  ): Promise<FrameRequestOutcome>
}

export function select_in_memory_frame(
  next: TrajectoryFrame | null | undefined,
  previous: TrajectoryFrame | null,
  frame_idx: number,
): Exclude<FrameRequestOutcome, { status: `stale` }> {
  return next?.structure
    ? { status: `loaded`, frame: next }
    : {
        status: `failed`,
        frame: previous,
        error: new Error(`Failed to load frame ${frame_idx}`),
      }
}

export function select_displayed_frame_idx(
  outcome: FrameRequestOutcome,
  requested_frame_idx: number,
  previous_frame_idx: number | null,
): number | null {
  return outcome.status === `loaded`
    ? requested_frame_idx
    : previous_frame_idx
}

export function select_pending_frame_publication(
  displayed_frame_idx: number | null,
  positions: Float32Array | null,
  forces: Float32Array | null,
): { positions: Float32Array | null; forces: Float32Array | null } | null {
  return displayed_frame_idx === null ? { positions, forces } : null
}

export function create_frame_request_loader(): FrameRequestLoader {
  let latest_request = 0
  let latest_outcome: FrameRequestOutcome | null = null
  let latest_trajectory: TrajectoryType | null = null
  return {
    invalidate: () => {
      latest_request += 1
      latest_outcome = null
      latest_trajectory = null
    },
    is_current: (outcome, trajectory) =>
      outcome === latest_outcome && trajectory === latest_trajectory,
    async load(
      trajectory: TrajectoryType,
      frame_idx: number,
      previous: TrajectoryFrame | null,
      fallback_source: string | ArrayBuffer | null,
    ): Promise<FrameRequestOutcome> {
      const request = ++latest_request
      latest_outcome = null
      latest_trajectory = trajectory
      const finish = (outcome: FrameRequestOutcome) => {
        if (request === latest_request) latest_outcome = outcome
        return outcome
      }
      const loader = trajectory.frame_loader
      if (!loader) {
        return finish({ status: `failed`, frame: previous, error: new Error(`No loader for frame ${frame_idx}`) })
      }
      try {
        const source = trajectory.frame_source_data ?? fallback_source ?? ``
        const frame = await loader.load_frame(source, frame_idx)
        if (request !== latest_request) return { status: `stale` }
        if (!frame?.structure) {
          return finish({ status: `failed`, frame: previous, error: new Error(`Failed to load frame ${frame_idx}`) })
        }
        return finish({ status: `loaded`, frame })
      } catch (cause) {
        if (request !== latest_request) return { status: `stale` }
        const detail = cause instanceof Error ? cause.message : String(cause)
        return finish({
          status: `failed`,
          frame: previous,
          error: new Error(`Failed to load frame ${frame_idx}: ${detail}`),
        })
      }
    },
  }
}

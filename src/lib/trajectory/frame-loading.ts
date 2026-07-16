import type { TrajectoryFrame, TrajectoryType } from './index'

export type FrameRequestOutcome =
  | { status: `loaded`; frame: TrajectoryFrame }
  | { status: `failed`; frame: TrajectoryFrame | null; error: Error }
  | { status: `stale` }

export interface FrameRequestLoader {
  invalidate(): void
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

export function create_frame_request_loader(): FrameRequestLoader {
  let latest_request = 0
  return {
    invalidate: () => { latest_request += 1 },
    async load(
      trajectory: TrajectoryType,
      frame_idx: number,
      previous: TrajectoryFrame | null,
      fallback_source: string | ArrayBuffer | null,
    ): Promise<FrameRequestOutcome> {
      const request = ++latest_request
      const loader = trajectory.frame_loader
      if (!loader) {
        return { status: `failed`, frame: previous, error: new Error(`No loader for frame ${frame_idx}`) }
      }
      try {
        const source = trajectory.frame_source_data ?? fallback_source ?? ``
        const frame = await loader.load_frame(source, frame_idx)
        if (request !== latest_request) return { status: `stale` }
        if (!frame?.structure) {
          return { status: `failed`, frame: previous, error: new Error(`Failed to load frame ${frame_idx}`) }
        }
        return { status: `loaded`, frame }
      } catch (cause) {
        if (request !== latest_request) return { status: `stale` }
        const detail = cause instanceof Error ? cause.message : String(cause)
        return {
          status: `failed`,
          frame: previous,
          error: new Error(`Failed to load frame ${frame_idx}: ${detail}`),
        }
      }
    },
  }
}

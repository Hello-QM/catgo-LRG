import type { TrajectoryFrame, TrajectoryType } from './index'

export type FrameRequestOutcome =
  | { status: `loaded`; frame: TrajectoryFrame }
  | { status: `failed`; frame: TrajectoryFrame | null; error: Error }
  | { status: `stale` }

export interface DisplayedFrameOwner {
  trajectory: TrajectoryType
  frame_idx: number
}

export interface DisplayedFrameRemoteOrigin {
  session_id: string
  dir_path: string
}

export interface FrameRequestLoader {
  invalidate(): void
  reject_out_of_bounds(
    frame_idx: number,
    frame_count: number,
    previous: TrajectoryFrame | null,
  ): Extract<FrameRequestOutcome, { status: `failed` }>
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

export function select_displayed_frame_owner(
  outcome: FrameRequestOutcome,
  requested_trajectory: TrajectoryType,
  requested_frame_idx: number,
  previous: DisplayedFrameOwner | null,
): DisplayedFrameOwner | null {
  return outcome.status === `loaded`
    ? { trajectory: requested_trajectory, frame_idx: requested_frame_idx }
    : previous
}

export function select_displayed_frame_remote_origin(
  active_trajectory: TrajectoryType | undefined,
  displayed_owner: DisplayedFrameOwner | null,
): DisplayedFrameRemoteOrigin | undefined {
  if (!active_trajectory || displayed_owner?.trajectory !== active_trajectory) {
    return undefined
  }
  return active_trajectory.metadata?.remote_origin as
    | DisplayedFrameRemoteOrigin
    | undefined
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
  const invalidate = () => {
    latest_request += 1
    latest_outcome = null
    latest_trajectory = null
  }
  return {
    invalidate,
    reject_out_of_bounds: (frame_idx, frame_count, previous) => {
      invalidate()
      const bounds = frame_count > 0 ? `0-${frame_count - 1}` : `empty`
      return {
        status: `failed`,
        frame: previous,
        error: new Error(
          `Failed to load frame ${frame_idx}: index outside trajectory bounds ${bounds}`,
        ),
      }
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
        // Streamed constant-topology playback only needs flat coordinates.
        // Prefer that compact path while no edit operation targets this frame;
        // topology-changing packets and edited frames fall through to the
        // fully materialized resolver path below.
        const has_matching_ops =
          (trajectory.operation_ledger?.active_entries_for_frame(frame_idx)
            .length ?? 0) > 0
        if (loader.load_frame_positions && !has_matching_ops) {
          try {
            const position_data = await loader.load_frame_positions(source, frame_idx)
            if (request !== latest_request) return { status: `stale` }
            const topology_frame = trajectory.frames[0] ?? previous
            if (
              position_data && !position_data.topology_changed &&
              topology_frame?.structure
            ) {
              return finish({
                status: `loaded`,
                frame: {
                  structure: topology_frame.structure,
                  step: position_data.step,
                  metadata: position_data.metadata,
                  position_data,
                },
              })
            }
          } catch {
            // The full-frame path below remains the correctness fallback.
          }
        }
        // §9.3: all frame consumers use the one effective-frame resolver. The
        // raw loader supplies the immutable base frame; the pane's active
        // ledger entries are applied (and cached by ledger revision) inside
        // the resolver. Trajectories without a resolver (not pane-cloned)
        // fall back to the raw loader — they cannot carry ledger ops.
        const resolver = trajectory.effective_frames
        const frame = resolver
          ? await resolver.resolve(frame_idx, (idx) => loader.load_frame(source, idx))
          : await loader.load_frame(source, frame_idx)
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

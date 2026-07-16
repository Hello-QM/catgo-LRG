import type {
  BaseFrameProvider,
  EffectiveFrameResolver,
} from './effective-frame-resolver'

export interface EffectiveFrameExportOptions {
  resolver: EffectiveFrameResolver
  load_base: BaseFrameProvider
  /** Inclusive first frame index. */
  start_frame: number
  /** Inclusive last frame index. */
  end_frame: number
  signal?: AbortSignal
}

function* frame_indices(
  start_frame: number,
  end_frame: number,
  signal?: AbortSignal,
): Generator<number> {
  for (let frame_idx = start_frame; frame_idx <= end_frame; frame_idx += 1) {
    if (signal?.aborted) return
    yield frame_idx
  }
}

/** Lazily yield resolver-effective frames for an inclusive export range. */
export async function* iterate_effective_frames({
  resolver,
  load_base,
  start_frame,
  end_frame,
  signal,
}: EffectiveFrameExportOptions) {
  for await (
    const effective of resolver.iterate(
      frame_indices(start_frame, end_frame, signal),
      load_base,
    )
  ) {
    if (signal?.aborted) return
    yield effective
  }
}

/**
 * The ONLY effective-frame resolver (design §9.3).
 *
 * Every consumer of streamed/indexed trajectory frames — viewer, warmup,
 * bonding, save, export — must resolve frames through this API instead of
 * reading raw loader frames, so a pane's ledger operations are never missed
 * or double-applied.
 *
 * Decoded base frames are immutable: when the pane ledger has active entries
 * matching a frame, the base is cloned ONCE and the entries are applied to
 * the clone in `seq` order (a current-only op A followed by an all-frame op B
 * yields A→B on the target frame and B alone on every other frame).
 * Transformed results are cached by `(frame_idx, ledger_revision)` with
 * bounded LRU eviction, so re-resolving after undo/redo or a new op always
 * restarts from the pristine base — never from an already transformed frame.
 * Zero-op frames are returned straight through and never retained, matching
 * the historical no-transformation path's memory behavior.
 */
import { clone_frame } from './clone'
import type { TrajectoryFrame } from './index'
import type { OperationLedger } from './operation-ledger'
import { apply_trajectory_edit_op_to_frame } from './operations'

/** Supplies the immutable decoded base frame for an index (e.g. a forked loader). */
export type BaseFrameProvider = (
  frame_idx: number,
) => Promise<TrajectoryFrame | null> | TrajectoryFrame | null

export interface EffectiveFrameResolver {
  /** Resolve one effective frame: base frame + active matching ledger entries. */
  resolve(
    frame_idx: number,
    load_base: BaseFrameProvider,
  ): Promise<TrajectoryFrame | null>
  /** Resolve a sequence of frames in order (save/export/warmup walks). */
  iterate(
    frame_indices: Iterable<number>,
    load_base: BaseFrameProvider,
  ): AsyncGenerator<{ frame_idx: number; frame: TrajectoryFrame | null }>
  /** Drop one frame's cached effective frame. */
  invalidate(frame_idx: number): void
  /** Drop every cached effective frame. */
  clear(): void
}

/** Bounded LRU capacity for cached effective frames (§9.4 effective-frame LRU). */
export const EFFECTIVE_FRAME_CACHE_CAPACITY = 64

export function create_effective_frame_resolver(
  ledger: OperationLedger,
  capacity: number = EFFECTIVE_FRAME_CACHE_CAPACITY,
): EffectiveFrameResolver {
  const cache = new Map<number, { revision: number; frame: TrajectoryFrame }>()
  const pending = new Map<string, Promise<TrajectoryFrame | null>>()
  let clear_generation = 0
  const frame_generation = new Map<number, number>()

  async function compute(
    frame_idx: number,
    load_base: BaseFrameProvider,
    revision: number,
    captured_clear_generation: number,
    captured_frame_generation: number,
  ): Promise<TrajectoryFrame | null> {
    const is_current = () =>
      clear_generation === captured_clear_generation &&
      (frame_generation.get(frame_idx) ?? 0) === captured_frame_generation
    // Snapshot matching entries synchronously, at the SAME revision the result
    // is cached under — a mid-flight append must not leak newer ops into an
    // older cache key (its bumped revision recomputes on the next resolve).
    const entries = ledger.active_entries_for_frame(frame_idx)
    const base = await load_base(frame_idx)
    if (!is_current() || !base?.structure) return null
    let frame = base
    if (entries.length > 0) {
      // With-ops path: clone the decoded base ONCE, then apply entries in seq
      // order. The base frame itself is never mutated, so a later re-resolve
      // starts from the pristine source — no double transform. The transformed
      // result is LRU-cached by (frame_idx, revision) to amortize the
      // clone+apply cost (~70 ms for 20k sites) across repeat resolves.
      frame = clone_frame(base)
      for (const entry of entries) {
        frame = apply_trajectory_edit_op_to_frame(frame, entry.op)
      }
      if (!is_current()) return null
      cache.delete(frame_idx)
      cache.set(frame_idx, { revision, frame })
      while (cache.size > capacity) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
    } else {
      // Zero-op path: return the immutable base straight through and retain
      // NOTHING — there is no transform work to amortize (`pending` already
      // dedupes concurrent resolves), and caching here would pin up to
      // `capacity` decoded frames per pane that the historical
      // no-transformation path released after render. Also drop any stale
      // transformed result from an earlier revision (ops since undone or
      // deactivated) so the frame frees its LRU slot.
      cache.delete(frame_idx)
    }
    return frame
  }

  function resolve(
    frame_idx: number,
    load_base: BaseFrameProvider,
  ): Promise<TrajectoryFrame | null> {
    const revision = ledger.revision
    const captured_clear_generation = clear_generation
    const captured_frame_generation = frame_generation.get(frame_idx) ?? 0
    const cached = cache.get(frame_idx)
    if (cached && cached.revision === revision) {
      cache.delete(frame_idx) // refresh LRU recency
      cache.set(frame_idx, cached)
      return Promise.resolve(cached.frame)
    }
    // Deduplicate concurrent resolves of the same (frame_idx, revision) so a
    // display request and a warmup walk share one decode + transform.
    const key = `${frame_idx}@${revision}@${captured_clear_generation}.${captured_frame_generation}`
    const in_flight = pending.get(key)
    if (in_flight) return in_flight
    const request = compute(
      frame_idx,
      load_base,
      revision,
      captured_clear_generation,
      captured_frame_generation,
    ).finally(() => {
      if (pending.get(key) === request) pending.delete(key)
    })
    pending.set(key, request)
    return request
  }

  return {
    resolve,
    async *iterate(frame_indices, load_base) {
      for (const frame_idx of frame_indices) {
        yield { frame_idx, frame: await resolve(frame_idx, load_base) }
      }
    },
    invalidate: (frame_idx) => {
      cache.delete(frame_idx)
      frame_generation.set(frame_idx, (frame_generation.get(frame_idx) ?? 0) + 1)
    },
    clear: () => {
      cache.clear()
      clear_generation += 1
    },
  }
}

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
 * yields A→B on the target frame and B alone on every other frame). Results
 * are cached by `(frame_idx, ledger_revision)` with bounded LRU eviction, so
 * re-resolving after undo/redo or a new op always restarts from the pristine
 * base — never from an already transformed frame.
 */
import { clone_frame } from './clone'
import type { TrajectoryFrame } from './index'
import type { OperationLedger } from './operation-ledger'
import { apply_trajectory_edit_op } from './operations'

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

  async function compute(
    frame_idx: number,
    load_base: BaseFrameProvider,
    revision: number,
  ): Promise<TrajectoryFrame | null> {
    // Snapshot matching entries synchronously, at the SAME revision the result
    // is cached under — a mid-flight append must not leak newer ops into an
    // older cache key (its bumped revision recomputes on the next resolve).
    const entries = ledger.active_entries_for_frame(frame_idx)
    const base = await load_base(frame_idx)
    if (!base?.structure) return null
    let frame = base
    if (entries.length > 0) {
      // Clone the decoded base ONCE, then apply entries in seq order. The base
      // frame itself is never mutated, so a later re-resolve starts from the
      // pristine source — no double transform. With zero matching entries the
      // clone is pure overhead (~70 ms for 20k sites) and the immutable base
      // is returned as-is, matching the historical no-transformation path.
      frame = clone_frame(base)
      let structure = frame.structure
      for (const entry of entries) {
        structure = apply_trajectory_edit_op(structure, entry.op)
      }
      frame = { ...frame, structure }
    }
    cache.delete(frame_idx)
    cache.set(frame_idx, { revision, frame })
    while (cache.size > capacity) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return frame
  }

  function resolve(
    frame_idx: number,
    load_base: BaseFrameProvider,
  ): Promise<TrajectoryFrame | null> {
    const revision = ledger.revision
    const cached = cache.get(frame_idx)
    if (cached && cached.revision === revision) {
      cache.delete(frame_idx) // refresh LRU recency
      cache.set(frame_idx, cached)
      return Promise.resolve(cached.frame)
    }
    // Deduplicate concurrent resolves of the same (frame_idx, revision) so a
    // display request and a warmup walk share one decode + transform.
    const key = `${frame_idx}@${revision}`
    const in_flight = pending.get(key)
    if (in_flight) return in_flight
    const request = compute(frame_idx, load_base, revision)
      .finally(() => pending.delete(key))
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
    invalidate: (frame_idx) => void cache.delete(frame_idx),
    clear: () => cache.clear(),
  }
}

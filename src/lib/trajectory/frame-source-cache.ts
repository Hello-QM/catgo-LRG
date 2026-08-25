import type { TrajectoryFrameSource } from '$lib/structure/trajectory-frame-preparer'

export const FRAME_SOURCE_CACHE_MAX_FRAMES = 16
export const FRAME_SOURCE_CACHE_MAX_BYTES = 32 * 1024 * 1024

type CacheEntry = {
  source: TrajectoryFrameSource
  bytes: number
}

function retained_bytes(source: TrajectoryFrameSource): number {
  return source.positions.byteLength +
    (source.forces?.byteLength ?? 0) +
    (source.stable_site_ids?.byteLength ?? 0) +
    (source.lattice?.reduce(
      (bytes, row) => bytes + row.length * Float64Array.BYTES_PER_ELEMENT,
      0,
    ) ?? 0)
}

/**
 * Small LRU for compact sources decoded by an asynchronous frame loader.
 *
 * The prepared-frame pipeline acknowledges a frame after its compact packet
 * has rendered. LargeSystemOverlay then asks for that same packet through the
 * synchronous frame-source getter. Indexed trajectories only materialize a
 * short prefix in `trajectory.frames`, so the async result must survive that
 * hand-off without retaining an unbounded trajectory.
 */
export function create_frame_source_cache(
  max_frames = FRAME_SOURCE_CACHE_MAX_FRAMES,
  max_bytes = FRAME_SOURCE_CACHE_MAX_BYTES,
) {
  const entries = new Map<number, CacheEntry>()
  let active_owner: object | null = null
  let active_version = -1
  let total_bytes = 0

  function clear(): void {
    entries.clear()
    active_owner = null
    active_version = -1
    total_bytes = 0
  }

  function select(owner: object, positions_version: number): void {
    if (active_owner === owner && active_version === positions_version) return
    clear()
    active_owner = owner
    active_version = positions_version
  }

  function get(
    owner: object,
    positions_version: number,
    frame_idx: number,
  ): TrajectoryFrameSource | null {
    select(owner, positions_version)
    const entry = entries.get(frame_idx)
    if (!entry) return null
    entries.delete(frame_idx)
    entries.set(frame_idx, entry)
    return entry.source
  }

  function set(
    owner: object,
    positions_version: number,
    source: TrajectoryFrameSource,
  ): TrajectoryFrameSource {
    select(owner, positions_version)
    const existing = entries.get(source.frame_idx)
    if (existing) total_bytes -= existing.bytes
    const bytes = retained_bytes(source)
    entries.delete(source.frame_idx)
    entries.set(source.frame_idx, { source, bytes })
    total_bytes += bytes

    while (
      entries.size > 1 &&
      (entries.size > Math.max(1, max_frames) || total_bytes > Math.max(1, max_bytes))
    ) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      const evicted = entries.get(oldest)
      entries.delete(oldest)
      total_bytes -= evicted?.bytes ?? 0
    }
    return source
  }

  return {
    get,
    set,
    clear,
    size: () => entries.size,
    retained_bytes: () => total_bytes,
  }
}

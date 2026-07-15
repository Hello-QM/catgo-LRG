/**
 * Transient per-frame position/force arrays for indexed/streaming
 * trajectories (the ones that get no `position_cache` in Trajectory.svelte).
 *
 * Entries are memoized per frame index so the Float32Array REFERENCE stays
 * stable across revisits: the bond frame-connectivity cache in
 * `bond-computation-controller.svelte.ts` keys on that reference
 * (`frame_conn_cache.get(traj_positions)`), so scrub-back and looped
 * playback hit the connectivity cache instead of re-dispatching detection.
 * LRU-capped — 512 frames of a 1600-atom trajectory is ~10 MB.
 */

export const FRAME_POS_CACHE_MAX = 512

export interface FramePositionEntry {
  positions: Float32Array
  forces: Float32Array | null
}

interface SiteLike {
  xyz: readonly number[]
  properties?: Record<string, unknown>
}

export function create_frame_position_cache(max: number = FRAME_POS_CACHE_MAX) {
  const cache = new Map<number, FramePositionEntry>()

  function get(frame_idx: number, sites: ReadonlyArray<SiteLike>): FramePositionEntry {
    const hit = cache.get(frame_idx)
    if (hit && hit.positions.length === sites.length * 3) {
      // LRU touch: Map preserves insertion order; re-insert to move to back.
      cache.delete(frame_idx)
      cache.set(frame_idx, hit)
      return hit
    }
    const n_sites = sites.length
    const positions = new Float32Array(n_sites * 3)
    let forces: Float32Array | null = null
    for (let idx = 0; idx < n_sites; idx++) {
      const xyz = sites[idx].xyz
      positions[idx * 3] = xyz[0]
      positions[idx * 3 + 1] = xyz[1]
      positions[idx * 3 + 2] = xyz[2]
      const force = sites[idx].properties?.force as number[] | undefined
      if (force && force.length === 3) {
        forces ??= new Float32Array(n_sites * 3)
        forces[idx * 3] = force[0]
        forces[idx * 3 + 1] = force[1]
        forces[idx * 3 + 2] = force[2]
      }
    }
    const entry: FramePositionEntry = { positions, forces }
    cache.set(frame_idx, entry)
    while (cache.size > max) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return entry
  }

  return {
    get,
    clear: () => cache.clear(),
    size: () => cache.size,
  }
}

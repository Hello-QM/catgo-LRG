import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { create_frame_source_cache } from '$lib/trajectory/frame-source-cache'
import type { TrajectoryFrameSource } from '$lib/structure/trajectory-frame-preparer'

function source(frame_idx: number, floats = 3): TrajectoryFrameSource {
  return {
    frame_idx,
    positions: new Float32Array(floats).fill(frame_idx),
    forces: null,
    lattice: null,
    positions_version: 0,
    topology_stable: true,
  }
}

describe(`indexed trajectory frame-source cache`, () => {
  test(`hands an asynchronously decoded packet back to the synchronous getter`, () => {
    const cache = create_frame_source_cache()
    const owner = {}
    const decoded = source(7)

    expect(cache.get(owner, 0, 7)).toBeNull()
    cache.set(owner, 0, decoded)
    expect(cache.get(owner, 0, 7)).toBe(decoded)
  })

  test(`invalidates packets when the trajectory owner or position version changes`, () => {
    const cache = create_frame_source_cache()
    const first_owner = {}
    const second_owner = {}

    cache.set(first_owner, 0, source(4))
    expect(cache.get(first_owner, 1, 4)).toBeNull()
    cache.set(first_owner, 1, source(4))
    expect(cache.get(second_owner, 1, 4)).toBeNull()
  })

  test(`bounds retained compact packets by recency and byte budget`, () => {
    const owner = {}
    const frame_limited = create_frame_source_cache(2, 1024)
    frame_limited.set(owner, 0, source(0))
    frame_limited.set(owner, 0, source(1))
    frame_limited.get(owner, 0, 0)
    frame_limited.set(owner, 0, source(2))
    expect(frame_limited.get(owner, 0, 1)).toBeNull()
    expect(frame_limited.get(owner, 0, 0)?.frame_idx).toBe(0)

    const byte_limited = create_frame_source_cache(16, 16)
    byte_limited.set(owner, 0, source(0, 3))
    byte_limited.set(owner, 0, source(1, 3))
    expect(byte_limited.size()).toBe(1)
    expect(byte_limited.retained_bytes()).toBe(12)
  })

  test(`indexed loader results cross the async-to-sync overlay hand-off`, () => {
    const trajectory_source = readFileSync(
      `src/lib/trajectory/Trajectory.svelte`,
      `utf8`,
    )
    const structure_source = readFileSync(
      `src/lib/structure/Structure.svelte`,
      `utf8`,
    )

    expect(trajectory_source).toContain(`requested_frame_sources.get(`)
    expect(trajectory_source).toContain(
      `return requested_frame_sources.set(owner, positions_version, {`,
    )
    expect(structure_source).toContain(
      `? presented_frame_source?.positions ?? null`,
    )
  })
})

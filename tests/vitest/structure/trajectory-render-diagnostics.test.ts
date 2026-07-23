import { beforeEach, describe, expect, test } from 'vitest'
import { trajectory_render_diagnostics } from '$lib/structure/trajectory-render-diagnostics'

describe(`trajectory render diagnostics`, () => {
  beforeEach(() => {
    trajectory_render_diagnostics.reset()
  })

  test(`distinguishes every frame lifecycle outcome`, () => {
    trajectory_render_diagnostics.record(`requested`, 1)
    trajectory_render_diagnostics.record(`prepared`, 1)
    trajectory_render_diagnostics.record(`cached`, 1)
    trajectory_render_diagnostics.record(`stale`, 2)
    trajectory_render_diagnostics.record(`failed`, 3)
    trajectory_render_diagnostics.record(`presented`, 1)

    expect(trajectory_render_diagnostics.snapshot()).toMatchObject({
      requested_frames: 1,
      prepared_frames: 1,
      cache_hits: 1,
      stale_results: 1,
      failed_frames: 1,
      presented_frames: 1,
      last_requested_frame: 1,
      last_prepared_frame: 1,
      last_presented_frame: 1,
    })
  })

  test(`tracks retained byte state without retaining frame buffers`, () => {
    const positions = new Float32Array(30)
    trajectory_render_diagnostics.update_retained({
      cache_frames: 3,
      cache_bytes: positions.byteLength,
      queued_bytes: 40,
      in_flight_bytes: 20,
      retained_bytes: positions.byteLength + 60,
    })
    const snapshot = trajectory_render_diagnostics.snapshot()

    expect(snapshot).toMatchObject({
      cache_frames: 3,
      cache_bytes: 120,
      queued_bytes: 40,
      in_flight_bytes: 20,
      retained_bytes: 180,
    })
    expect(JSON.stringify(snapshot)).not.toContain(`positions`)
    expect(
      Object.values(snapshot).some((value) => ArrayBuffer.isView(value)),
    ).toBe(false)
  })
})

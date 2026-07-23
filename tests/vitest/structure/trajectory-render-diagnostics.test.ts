import { beforeEach, describe, expect, test } from 'vitest'
import {
  create_trajectory_render_diagnostics,
  trajectory_render_diagnostics,
} from '$lib/structure/trajectory-render-diagnostics'

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

  test(`records exact graph identities, uploads, latency, and unique presentation FPS`, () => {
    const diagnostics = create_trajectory_render_diagnostics()
    diagnostics.begin_owner({}, 1_000)
    diagnostics.record(`requested`, 0, 1_010, 7)
    diagnostics.record_prepared(0, `hash-0`, 26_001, 18)
    diagnostics.record_position_upload(19_968 * 16)
    diagnostics.record_topology_upload(26_001 * 18)
    diagnostics.record_presented(0, 7, `hash-0`, 26_001, 1_050)
    // A duplicate publication is a presentation event, but not a new
    // trajectory frame and therefore cannot inflate trajectory FPS.
    diagnostics.record_presented(0, 7, `hash-0`, 26_001, 1_060)

    diagnostics.record(`requested`, 1, 1_070, 8)
    diagnostics.record_prepared(1, `hash-1`, 26_010, 20)
    diagnostics.record_position_upload(19_968 * 16)
    diagnostics.record_topology_upload(26_010 * 18)
    diagnostics.record_presented(1, 8, `hash-1`, 26_010, 1_090)
    diagnostics.record(`requested`, 2, 1_100, 9)
    diagnostics.record_prepared(2, `hash-2`, 25_999, 19)
    diagnostics.record_presented(2, 9, `hash-2`, 25_999, 1_130)
    // Prefetch-only work must never be reported as displayed exactness.
    diagnostics.record_prepared(99, `prefetched-only`, 10, 1)
    diagnostics.record_long_task()

    expect(diagnostics.snapshot()).toMatchObject({
      presented_frames: 4,
      unique_presented_frames: 3,
      graph_hash_by_frame: {
        0: `hash-0`,
        1: `hash-1`,
        2: `hash-2`,
      },
      bond_count_by_frame: {
        0: 26_001,
        1: 26_010,
        2: 25_999,
      },
      bond_compute_ms: [18, 20, 19, 1],
      cold_first_frame_ms: 50,
      warmup_ms: 130,
      frame_time_p95_ms: 40,
      main_thread_long_tasks: 1,
      position_uploads: 2,
      position_upload_bytes: 2 * 19_968 * 16,
      topology_uploads: 2,
      topology_upload_bytes: (26_001 + 26_010) * 18,
      picker_position_uploads: 0,
      presentation_latency_ms: [40, 20, 30],
      unique_frame_fps: 25,
    })
  })

  test(`uses bounded latency rings and resets when trajectory owner changes`, () => {
    const diagnostics = create_trajectory_render_diagnostics()
    const first_owner = {}
    diagnostics.begin_owner(first_owner, 0)
    for (let idx = 0; idx < 300; idx++) {
      diagnostics.record(`requested`, idx, idx * 2, idx)
      diagnostics.record(`presented`, idx, idx * 2 + 1, idx)
    }
    expect(diagnostics.snapshot().presentation_latency_ms.length)
      .toBeLessThanOrEqual(256)

    diagnostics.begin_owner({}, 1_000)
    expect(diagnostics.snapshot()).toMatchObject({
      requested_frames: 0,
      prepared_frames: 0,
      presented_frames: 0,
      unique_presented_frames: 0,
      graph_hash_by_frame: {},
      bond_count_by_frame: {},
      position_uploads: 0,
    })
  })

  test(`installs a development/test browser snapshot without exposing buffers`, () => {
    expect(globalThis.__catgoTrajectoryDiagnostics).toBe(
      trajectory_render_diagnostics.snapshot,
    )
    expect(globalThis.__catgoTrajectoryDiagnostics?.()).toEqual(
      trajectory_render_diagnostics.snapshot(),
    )
  })
})

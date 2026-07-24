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

  test(`keeps the latest monotonic bond-session evidence as scalar metadata`, () => {
    const diagnostics = create_trajectory_render_diagnostics()
    const owner = {}
    diagnostics.begin_owner(owner, 1_000)
    diagnostics.record_bond_session(`rust-wasm-threads`, true, {
      thread_count: 4,
      session_initializations: 1,
      frame_count: 3,
      grid_cache_hits: 2,
      grid_rebuilds: 1,
      capacity_growths: 2,
    })
    diagnostics.record_bond_session(`rust-wasm-threads`, true, {
      thread_count: 4,
      session_initializations: 1,
      frame_count: 5,
      grid_cache_hits: 4,
      grid_rebuilds: 1,
      capacity_growths: 3,
    })
    // An out-of-order cumulative snapshot must not reduce or double-count
    // the latest values for the current trajectory owner.
    diagnostics.record_bond_session(`rust-wasm-threads`, true, {
      thread_count: 4,
      session_initializations: 1,
      frame_count: 4,
      grid_cache_hits: 3,
      grid_rebuilds: 1,
      capacity_growths: 2,
    })

    const snapshot = diagnostics.snapshot()
    expect(snapshot).toMatchObject({
      bond_backend: `rust-wasm-threads`,
      bond_threading_expected: true,
      bond_thread_count: 4,
      bond_session_initializations: 1,
      bond_session_frames: 5,
      bond_grid_cache_hits: 4,
      bond_grid_rebuilds: 1,
      bond_capacity_growths: 3,
    })
    expect(snapshot).not.toHaveProperty(`session`)
    expect(snapshot).not.toHaveProperty(`session_diagnostics`)
    expect(
      Object.values(snapshot).some((value) => ArrayBuffer.isView(value)),
    ).toBe(false)

    diagnostics.begin_owner({}, 2_000)
    expect(diagnostics.snapshot()).toMatchObject({
      bond_backend: null,
      bond_threading_expected: false,
      bond_thread_count: 0,
      bond_session_initializations: 0,
      bond_session_frames: 0,
      bond_grid_cache_hits: 0,
      bond_grid_rebuilds: 0,
      bond_capacity_growths: 0,
    })
  })

  test(`keeps bounded scalar worker phase timings and clears them by owner`, () => {
    const diagnostics = create_trajectory_render_diagnostics()
    diagnostics.begin_owner({}, 1_000)
    for (let idx = 0; idx < 300; idx++) {
      diagnostics.record_bond_worker_timings(
        idx,
        idx + 0.25,
        idx + 0.5,
        idx + 0.75,
        idx + 1,
      )
    }

    const snapshot = diagnostics.snapshot()
    expect(snapshot.bond_worker_wasm_ms).toHaveLength(256)
    expect(snapshot.bond_worker_position_pack_ms).toHaveLength(256)
    expect(snapshot.bond_worker_table_copy_ms).toHaveLength(256)
    expect(snapshot.bond_worker_total_ms).toHaveLength(256)
    expect(snapshot.bond_worker_roundtrip_ms).toHaveLength(256)
    expect(snapshot.bond_worker_wasm_ms[0]).toBe(44)
    expect(snapshot.bond_worker_roundtrip_ms.at(-1)).toBe(300)
    expect(
      Object.values(snapshot).some((value) => ArrayBuffer.isView(value)),
    ).toBe(false)
    expect(snapshot).not.toHaveProperty(`worker_timings`)

    diagnostics.begin_owner({}, 2_000)
    expect(diagnostics.snapshot()).toMatchObject({
      bond_worker_wasm_ms: [],
      bond_worker_position_pack_ms: [],
      bond_worker_table_copy_ms: [],
      bond_worker_total_ms: [],
      bond_worker_roundtrip_ms: [],
    })
  })

  test(`keeps bounded main-thread trajectory phase timings and clears them by owner`, () => {
    const diagnostics = create_trajectory_render_diagnostics()
    diagnostics.begin_owner({}, 1_000)
    for (let idx = 0; idx < 300; idx++) {
      diagnostics.record_bond_renderer_timings(
        idx,
        idx + 0.25,
        idx + 0.5,
      )
      diagnostics.record_bond_manager_replace(idx + 0.75)
      diagnostics.record_typed_direct_sync(idx + 1)
      diagnostics.record_prepared_to_renderer_sync(idx + 1.25)
    }

    const snapshot = diagnostics.snapshot()
    expect(snapshot.bond_renderer_update_ms).toHaveLength(256)
    expect(snapshot.bond_renderer_main_attrs_ms).toHaveLength(256)
    expect(snapshot.bond_renderer_ghosts_ms).toHaveLength(256)
    expect(snapshot.bond_manager_replace_ms).toHaveLength(256)
    expect(snapshot.typed_direct_sync_ms).toHaveLength(256)
    expect(snapshot.prepared_to_renderer_sync_ms).toHaveLength(256)
    expect(snapshot.bond_renderer_update_ms[0]).toBe(44)
    expect(snapshot.prepared_to_renderer_sync_ms.at(-1)).toBe(300.25)
    expect(
      Object.values(snapshot).some((value) => ArrayBuffer.isView(value)),
    ).toBe(false)

    diagnostics.begin_owner({}, 2_000)
    expect(diagnostics.snapshot()).toMatchObject({
      bond_renderer_update_ms: [],
      bond_renderer_main_attrs_ms: [],
      bond_renderer_ghosts_ms: [],
      bond_manager_replace_ms: [],
      typed_direct_sync_ms: [],
      prepared_to_renderer_sync_ms: [],
    })
  })

  test(`records exact graph identities, uploads, latency, and unique presentation FPS`, () => {
    const diagnostics = create_trajectory_render_diagnostics()
    diagnostics.begin_owner({}, 1_000)
    diagnostics.record(`requested`, 0, 1_010, 7)
    diagnostics.record_prepared(0, `hash-0`, 26_001, 18)
    diagnostics.record_position_upload(19_968 * 16)
    diagnostics.record_topology_upload(26_001 * 18)
    diagnostics.record_bond_main_topology_upload(26_001, 26_001 * 11)
    diagnostics.record_renderer_installed(0, 7, `hash-0`, 26_001, 1_050)
    // Renderer re-sync of the same packet is not a second presentation.
    diagnostics.record_renderer_installed(0, 7, `hash-0`, 26_001, 1_060)
    // A same-frame rules/topology recompute is distinct renderer evidence,
    // even when the position buffer identity is unchanged.
    diagnostics.record_renderer_installed(
      0,
      7,
      `hash-0-recomputed`,
      26_005,
      1_065,
    )

    diagnostics.record(`requested`, 1, 1_070, 8)
    diagnostics.record_prepared(1, `hash-1`, 26_010, 20)
    diagnostics.record_position_upload(19_968 * 16)
    diagnostics.record_topology_upload(26_010 * 18)
    diagnostics.record_bond_main_topology_upload(26_010, 26_010 * 11)
    diagnostics.record_renderer_installed(1, 8, `hash-1`, 26_010, 1_090)
    diagnostics.record(`requested`, 2, 1_100, 9)
    diagnostics.record_prepared(2, `hash-2`, 25_999, 19)
    diagnostics.record_renderer_installed(2, 9, `hash-2`, 25_999, 1_130)
    // Prefetch-only work must never be reported as displayed exactness.
    diagnostics.record_prepared(99, `prefetched-only`, 10, 1)
    diagnostics.record_long_task()

    expect(diagnostics.snapshot()).toMatchObject({
      presented_frames: 4,
      unique_presented_frames: 3,
      renderer_installed_frames: 4,
      last_renderer_installed_frame: 2,
      graph_hash_by_frame: {
        0: `hash-0-recomputed`,
        1: `hash-1`,
        2: `hash-2`,
      },
      bond_count_by_frame: {
        0: 26_005,
        1: 26_010,
        2: 25_999,
      },
      renderer_graph_hash_by_frame: {
        0: `hash-0-recomputed`,
        1: `hash-1`,
        2: `hash-2`,
      },
      renderer_bond_count_by_frame: {
        0: 26_005,
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
      bond_main_topology_uploads: 2,
      bond_main_topology_upload_bytes: (26_001 + 26_010) * 11,
      bond_main_topology_uploaded_bonds: 26_001 + 26_010,
      picker_position_uploads: 0,
      presentation_latency_ms: [40, 20, 30],
      unique_frame_fps: 25,
    })
  })

  test(`keeps direct presentation separate from renderer-installed evidence`, () => {
    const diagnostics = create_trajectory_render_diagnostics()
    diagnostics.begin_owner({}, 100)
    diagnostics.record_presented(4, 14, `direct-hash`, 12, 120)

    expect(diagnostics.snapshot()).toMatchObject({
      presented_frames: 1,
      last_presented_frame: 4,
      graph_hash_by_frame: { 4: `direct-hash` },
      bond_count_by_frame: { 4: 12 },
      renderer_installed_frames: 0,
      last_renderer_installed_frame: null,
      renderer_graph_hash_by_frame: {},
      renderer_bond_count_by_frame: {},
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
      renderer_installed_frames: 0,
      last_renderer_installed_frame: null,
      graph_hash_by_frame: {},
      bond_count_by_frame: {},
      renderer_graph_hash_by_frame: {},
      renderer_bond_count_by_frame: {},
      position_uploads: 0,
      bond_main_topology_uploads: 0,
      bond_main_topology_upload_bytes: 0,
      bond_main_topology_uploaded_bonds: 0,
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

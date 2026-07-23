import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe(`exact prepared trajectory ownership`, () => {
  test(`retires cadence, stale publication, and object-frame cache symbols`, () => {
    const controller = readFileSync(
      `src/lib/structure/bond-computation-controller.svelte.ts`,
      `utf8`,
    )
    expect(controller).not.toContain(`TRAJ_BOND_REFRESH_EVERY`)
    expect(controller).not.toContain(`should_refresh_large_trajectory_bonds`)
    expect(controller).not.toContain(`compute_bond_connectivity_for_frame`)
    expect(controller).not.toContain(`traj_pending_frame`)
    expect(controller).not.toContain(`traj_in_flight_frame`)
    expect(controller).not.toContain(`frame_conn_cache`)
  })

  test(`scene has one bounded exact pipeline and no failure fallback`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    expect(scene).toContain(`create_prepared_frame_pipeline({`)
    expect(scene).toContain(`max_frames: 8`)
    expect(scene).toContain(`max_bytes: 96 * 1024 * 1024`)
    expect(scene).toContain(`max_in_flight: 1`)
    expect(scene).toContain(`prepared_render_packet = prepared.packet`)
    expect(scene).not.toMatch(/catch[\\s\\S]{0,300}trajectory_pipeline=legacy/)
  })
})

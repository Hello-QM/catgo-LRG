import {
  should_refresh_large_trajectory_bonds,
} from '$lib/structure/bond-computation-controller.svelte'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe(`large trajectory bond refresh budget`, () => {
  test(`reuses compatible connectivity between periodic refresh frames`, () => {
    expect(should_refresh_large_trajectory_bonds(1, 19_968, true)).toBe(false)
    expect(should_refresh_large_trajectory_bonds(7, 19_968, true)).toBe(false)
    expect(should_refresh_large_trajectory_bonds(8, 19_968, true)).toBe(true)
    expect(should_refresh_large_trajectory_bonds(1, 19_968, false)).toBe(true)
    expect(should_refresh_large_trajectory_bonds(1, 500, true)).toBe(true)
  })

  test(`bounds cached connectivity by total retained bonds`, () => {
    const source = readFileSync(
      `src/lib/structure/bond-computation-controller.svelte.ts`,
      `utf8`,
    )
    expect(source).toContain(`TRAJ_BOND_REFRESH_EVERY = 8`)
    expect(source).toContain(`TRAJ_FRAME_CACHE_BOND_BUDGET`)
    expect(source).toContain(`frame_cache_bond_count`)
    expect(source).toContain(`bond_state.traj_last_seen_frame`)
  })
})

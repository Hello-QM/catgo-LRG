import { describe, expect, it } from 'vitest'
import {
  BOND_COMPUTE_DIRECT_WGSL,
  BOND_COMPUTE_WGSL,
} from '$lib/structure/gpu/bond-compute.wgsl'

describe(`BOND_COMPUTE_WGSL`, () => {
  it(`is a non-empty WGSL string with the expected entry points`, () => {
    expect(typeof BOND_COMPUTE_WGSL).toBe(`string`)
    expect(BOND_COMPUTE_WGSL).toContain(`@compute`)
    expect(BOND_COMPUTE_WGSL).toContain(`fn detect_bonds`)
    expect(BOND_COMPUTE_WGSL).toContain(`atomicAdd`)
  })

  it(`large-n shader path contains no all-pairs loop`, () => {
    // The large-N grid shader must never contain the O(N²) all-pairs loop, and
    // no runtime use_grid switch may route back to it: routing is decided
    // CPU-side by plan_bond_dispatch, and periodic thin cells go to Rust WASM
    // (design §8.2), never to an all-pairs × 27-image shader.
    expect(BOND_COMPUTE_WGSL).not.toContain(`use_grid`)
    expect(BOND_COMPUTE_WGSL).not.toMatch(/j < P\.n_atoms/)
    // cell_stride is a UNIFORM so overflow retries can grow the per-cell
    // capacity and rerun without a shader rebuild.
    expect(BOND_COMPUTE_WGSL).toContain(`cell_stride`)
    // bin_atoms records the max observed cell occupancy so the CPU can detect
    // cell overflow losslessly (occupancy > stride ⇒ grow + rerun).
    expect(BOND_COMPUTE_WGSL).toContain(`atomicMax`)
    // The all-pairs loop lives ONLY in the separate small-N direct shader.
    expect(BOND_COMPUTE_DIRECT_WGSL).toMatch(/j < P\.n_atoms/)
    expect(BOND_COMPUTE_DIRECT_WGSL).toContain(`fn detect_bonds`)
  })

  it(`shares Rust's multiplicative atom-radii predicate across both shader paths`, () => {
    for (const source of [BOND_COMPUTE_WGSL, BOND_COMPUTE_DIRECT_WGSL]) {
      expect(source).toContain(`min_bond_dist: f32`)
      expect(source).toContain(`d <= (ri + radii[j]) * P.scale`)
      expect(source).not.toContain(`P.tolerance`)
      expect(source).not.toContain(`P.min_dist`)
    }
  })
})

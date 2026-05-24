import { describe, it, expect } from 'vitest'
import { BOND_COMPUTE_WGSL } from '$lib/structure/gpu/bond-compute.wgsl'

describe(`BOND_COMPUTE_WGSL`, () => {
  it(`is a non-empty WGSL string with the expected entry points`, () => {
    expect(typeof BOND_COMPUTE_WGSL).toBe(`string`)
    expect(BOND_COMPUTE_WGSL).toContain(`@compute`)
    expect(BOND_COMPUTE_WGSL).toContain(`fn detect_bonds`)
    expect(BOND_COMPUTE_WGSL).toContain(`atomicAdd`)
  })
})

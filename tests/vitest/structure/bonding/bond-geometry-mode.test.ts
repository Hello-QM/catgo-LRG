import { bond_geometry_mode } from '$lib/structure/bonding/bond-geometry-mode'
import { describe, expect, test } from 'vitest'

describe(`bond_geometry_mode`, () => {
  test(`gpu_active selects impostor regardless of size`, () => {
    expect(bond_geometry_mode(true, 20000, true)).toBe(`impostor`)
    expect(bond_geometry_mode(true, 100, true)).toBe(`impostor`)
  })
  test(`not gpu_active selects cylinder (static / ineligible)`, () => {
    expect(bond_geometry_mode(false, 20000, true)).toBe(`cylinder`)
    expect(bond_geometry_mode(false, 20000, false)).toBe(`cylinder`)
  })
})

/**
 * Unit tests for the "defer connectivity for very large structures" gate.
 *
 * Covers the pure decision helper `should_defer_bonds(atom_count, user_requested)`
 * and the `DEFER_BONDS_ABOVE_ATOMS` threshold. Runtime wiring (state + banner)
 * lives in StructureScene and is not unit-tested here.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFER_BONDS_ABOVE_ATOMS,
  should_defer_bonds,
} from '$lib/structure/bond-computation-controller.svelte'

describe(`should_defer_bonds`, () => {
  it(`is conservative: threshold sits well above the sync/GPU thresholds`, () => {
    // Must be far above the 1000-atom sync threshold and 2000-atom GPU threshold
    // so normal structures never defer.
    expect(DEFER_BONDS_ABOVE_ATOMS).toBe(8000)
    expect(DEFER_BONDS_ABOVE_ATOMS).toBeGreaterThan(2000)
  })

  it(`does NOT defer normal-size structures`, () => {
    expect(should_defer_bonds(0, false)).toBe(false)
    expect(should_defer_bonds(100, false)).toBe(false)
    expect(should_defer_bonds(2000, false)).toBe(false)
    expect(should_defer_bonds(DEFER_BONDS_ABOVE_ATOMS, false)).toBe(false) // boundary: exactly at threshold is NOT deferred
  })

  it(`defers a genuinely huge structure that the user has not acted on`, () => {
    expect(should_defer_bonds(DEFER_BONDS_ABOVE_ATOMS + 1, false)).toBe(true)
    expect(should_defer_bonds(11000, false)).toBe(true) // the kerogen case
  })

  it(`un-defers once the user requests bonds, regardless of size`, () => {
    expect(should_defer_bonds(11000, true)).toBe(false)
    expect(should_defer_bonds(DEFER_BONDS_ABOVE_ATOMS + 1, true)).toBe(false)
  })

  it(`user request has no effect below the threshold (already non-deferred)`, () => {
    expect(should_defer_bonds(500, true)).toBe(false)
    expect(should_defer_bonds(500, false)).toBe(false)
  })
})

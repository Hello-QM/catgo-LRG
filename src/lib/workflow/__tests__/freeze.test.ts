import { describe, it, expect } from 'vitest'
import { apply_freeze_to_structure } from '../freeze'

/**
 * Behavior-lock tests for apply_freeze_to_structure (issue #222).
 *
 * The function writes pymatgen-style selective_dynamics onto every site:
 *   true  = free   → [true, true, true]
 *   frozen        → [false, false, false]
 * It must mirror the backend's bottom-layer freezing semantics and preserve
 * all the modes (z_range / element / indices|manual / layers|bottom + invert).
 *
 * These tests exist so the extraction from WorkflowEditor.svelte into freeze.ts
 * does not silently change behavior, and so the "freeze drops at the Adsorbate
 * node" leak stays fixed.
 */

describe(`freeze_mode adsorbate`, () => {
  function tagged(): string {
    return JSON.stringify({
      lattice: { matrix: [[5, 0, 0], [0, 5, 0], [0, 0, 20]] },
      sites: [
        { species: [{ element: `Pt`, occu: 1 }], xyz: [0, 0, 0], label: `Pt`, properties: { is_adsorbate: false } },
        { species: [{ element: `Pt`, occu: 1 }], xyz: [0, 0, 1], label: `Pt`, properties: { is_adsorbate: false } },
        { species: [{ element: `O`, occu: 1 }], xyz: [0, 0, 3], label: `O`, properties: { is_adsorbate: true } },
      ],
    })
  }

  it(`fixes non-adsorbate atoms, frees adsorbate`, () => {
    const out = JSON.parse(apply_freeze_to_structure(tagged(), { freeze_mode: `adsorbate` })!)
    expect(out.sites[0].properties.selective_dynamics).toEqual([false, false, false])
    expect(out.sites[1].properties.selective_dynamics).toEqual([false, false, false])
    expect(out.sites[2].properties.selective_dynamics).toEqual([true, true, true])
  })

  it(`freezes nothing when no atom is tagged`, () => {
    const untagged = JSON.parse(tagged())
    untagged.sites.forEach((s: { properties: Record<string, unknown> }) => { s.properties = {} })
    const out = JSON.parse(apply_freeze_to_structure(JSON.stringify(untagged), { freeze_mode: `adsorbate` })!)
    for (const s of out.sites) expect(s.properties.selective_dynamics).toEqual([true, true, true])
  })
})

/** A 4-atom slab spread across 4 distinct z-layers (z = 0, 1, 2, 3). */
function make_slab(): string {
  return JSON.stringify({
    lattice: { matrix: [[5, 0, 0], [0, 5, 0], [0, 0, 20]] },
    sites: [
      { species: [{ element: `Cu`, occu: 1 }], abc: [0, 0, 0.0], xyz: [0, 0, 0], label: `Cu`, properties: {} },
      { species: [{ element: `Cu`, occu: 1 }], abc: [0, 0, 0.05], xyz: [0, 0, 1], label: `Cu`, properties: {} },
      { species: [{ element: `Cu`, occu: 1 }], abc: [0, 0, 0.10], xyz: [0, 0, 2], label: `Cu`, properties: {} },
      { species: [{ element: `Au`, occu: 1 }], abc: [0, 0, 0.15], xyz: [0, 0, 3], label: `Au`, properties: {} },
    ],
  })
}

function sd(json: string): boolean[][] {
  return JSON.parse(json).sites.map((s: any) => s.properties.selective_dynamics)
}

describe(`apply_freeze_to_structure`, () => {
  it(`freezes the bottom layer for frozen_layers=1 (free elsewhere)`, () => {
    const out = apply_freeze_to_structure(make_slab(), { frozen_layers: 1 })
    expect(out).not.toBeNull()
    const flags = sd(out!)
    // Bottom layer (z=0) frozen → all-false
    expect(flags[0]).toEqual([false, false, false])
    // Everything above is free → all-true
    expect(flags[1]).toEqual([true, true, true])
    expect(flags[2]).toEqual([true, true, true])
    expect(flags[3]).toEqual([true, true, true])
  })

  it(`freezes the two bottom layers for frozen_layers=2`, () => {
    const out = apply_freeze_to_structure(make_slab(), { frozen_layers: 2 })
    const flags = sd(out!)
    expect(flags[0]).toEqual([false, false, false])
    expect(flags[1]).toEqual([false, false, false])
    expect(flags[2]).toEqual([true, true, true])
    expect(flags[3]).toEqual([true, true, true])
  })

  it(`returns the input unchanged when no freeze params are given`, () => {
    const input = make_slab()
    const out = apply_freeze_to_structure(input, {})
    // No mode → returns input verbatim (no selective_dynamics added)
    expect(out).toBe(input)
  })

  it(`returns null for a null input`, () => {
    expect(apply_freeze_to_structure(null, { frozen_layers: 1 })).toBeNull()
  })

  it(`freezes by element`, () => {
    const out = apply_freeze_to_structure(make_slab(), { freeze_mode: `element`, freeze_elements: `Au` })
    const flags = sd(out!)
    expect(flags[0]).toEqual([true, true, true])
    expect(flags[1]).toEqual([true, true, true])
    expect(flags[2]).toEqual([true, true, true])
    expect(flags[3]).toEqual([false, false, false]) // the lone Au
  })

  it(`freezes by explicit indices (incl. ranges)`, () => {
    const out = apply_freeze_to_structure(make_slab(), { freeze_mode: `indices`, freeze_indices: `0,2-3` })
    const flags = sd(out!)
    expect(flags[0]).toEqual([false, false, false])
    expect(flags[1]).toEqual([true, true, true])
    expect(flags[2]).toEqual([false, false, false])
    expect(flags[3]).toEqual([false, false, false])
  })

  it(`freezes by z_range (below threshold)`, () => {
    const out = apply_freeze_to_structure(make_slab(), { freeze_mode: `z_range`, freeze_z_below: 1.5 })
    const flags = sd(out!)
    expect(flags[0]).toEqual([false, false, false]) // z=0
    expect(flags[1]).toEqual([false, false, false]) // z=1
    expect(flags[2]).toEqual([true, true, true])    // z=2
    expect(flags[3]).toEqual([true, true, true])    // z=3
  })

  it(`inverts the frozen set when freeze_invert is set`, () => {
    const out = apply_freeze_to_structure(make_slab(), { frozen_layers: 1, freeze_invert: true })
    const flags = sd(out!)
    // Inverted: bottom layer now free, everything else frozen
    expect(flags[0]).toEqual([true, true, true])
    expect(flags[1]).toEqual([false, false, false])
    expect(flags[2]).toEqual([false, false, false])
    expect(flags[3]).toEqual([false, false, false])
  })
})

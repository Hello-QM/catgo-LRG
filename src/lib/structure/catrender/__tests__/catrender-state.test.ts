import { describe, expect, it } from 'vitest'
import {
  build_overrides, prune_atom_idx, KNOB_KEYS,
  type Knob, type KnobName,
} from '../catrender-state.svelte'

// Build a full knob record with every knob off at its default value.
function blank_knobs(): Record<KnobName, Knob<number | boolean | string>> {
  const k = {} as Record<KnobName, Knob<number | boolean | string>>
  for (const name of Object.keys(KNOB_KEYS) as KnobName[]) {
    k[name] = { on: false, v: 0 }
  }
  return k
}

describe(`build_overrides`, () => {
  it(`emits nothing when no knob is on and advanced is empty`, () => {
    const { map, err } = build_overrides(blank_knobs(), ``)
    expect(map).toEqual({})
    expect(err).toBe(``)
  })

  it(`only emits knobs whose .on is true, under the mapped key`, () => {
    const k = blank_knobs()
    k.k_atom_scale = { on: true, v: 3.5 }
    k.k_bond_width = { on: false, v: 99 } // off → excluded
    k.k_gradient = { on: true, v: false }
    const { map } = build_overrides(k, ``)
    expect(map).toEqual({ atom_scale: 3.5, gradient: false })
    expect(map).not.toHaveProperty(`bond_width`)
  })

  it(`merges advanced JSON LAST, overriding dedicated knobs`, () => {
    const k = blank_knobs()
    k.k_atom_scale = { on: true, v: 2 }
    const { map, err } = build_overrides(
      k,
      `{ "atom_scale": 9, "vdw_opacity": 0.4 }`,
    )
    expect(err).toBe(``)
    expect(map).toEqual({ atom_scale: 9, vdw_opacity: 0.4 })
  })

  it(`reports parse error and keeps last-good dedicated map`, () => {
    const k = blank_knobs()
    k.k_bond_width = { on: true, v: 12 }
    const { map, err } = build_overrides(k, `{ not valid`)
    expect(err).toMatch(/advanced JSON:/)
    expect(map).toEqual({ bond_width: 12 })
  })

  it(`rejects non-object advanced JSON`, () => {
    const { map, err } = build_overrides(blank_knobs(), `[1,2,3]`)
    expect(err).toBe(`advanced JSON must be an object`)
    expect(map).toEqual({})
  })
})

describe(`prune_atom_idx`, () => {
  it(`keeps in-range, truncates, rejects out-of-range / non-finite`, () => {
    expect(prune_atom_idx(0, 3)).toBe(0)
    expect(prune_atom_idx(2.9, 3)).toBe(2)
    expect(prune_atom_idx(3, 3)).toBeNull()
    expect(prune_atom_idx(-1, 3)).toBeNull()
    expect(prune_atom_idx(NaN, 3)).toBeNull()
  })
})

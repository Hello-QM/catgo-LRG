import { describe, expect, it } from 'vitest'
import {
  type AtomOverride,
  merge_atoms,
  prune_atom_overrides,
} from '../atom-merge'

describe(`atom-merge`, () => {
  it(`empty overrides → empty hidden + recolor (passthrough)`, () => {
    const { hidden, recolor } = merge_atoms(5, [])
    expect(hidden.size).toBe(0)
    expect(recolor.size).toBe(0)
  })

  it(`hide drops the atom (added to hidden set)`, () => {
    const ov: AtomOverride[] = [{ op: `hide`, idx: 2 }]
    const { hidden, recolor } = merge_atoms(5, ov)
    expect([...hidden]).toEqual([2])
    expect(recolor.size).toBe(0)
  })

  it(`recolor sets per-idx hex`, () => {
    const ov: AtomOverride[] = [{ op: `recolor`, idx: 1, hex: `#ff0000` }]
    const { hidden, recolor } = merge_atoms(5, ov)
    expect(hidden.size).toBe(0)
    expect(recolor.get(1)).toBe(`#ff0000`)
  })

  it(`duplicate op on same idx → last wins`, () => {
    const ov: AtomOverride[] = [
      { op: `recolor`, idx: 3, hex: `#111111` },
      { op: `recolor`, idx: 3, hex: `#222222` },
    ]
    const { recolor } = merge_atoms(5, ov)
    expect(recolor.get(3)).toBe(`#222222`)
  })

  it(`hide + recolor on same idx coexist (atom hidden, recolor still tracked)`, () => {
    const ov: AtomOverride[] = [
      { op: `recolor`, idx: 4, hex: `#abcdef` },
      { op: `hide`, idx: 4 },
    ]
    const { hidden, recolor } = merge_atoms(5, ov)
    expect(hidden.has(4)).toBe(true)
    // recolor map still carries the override (moot while hidden, but normalised)
    expect(recolor.get(4)).toBe(`#abcdef`)
  })

  it(`merge_atoms prunes out-of-range idx (idx >= n_atoms)`, () => {
    const ov: AtomOverride[] = [
      { op: `hide`, idx: 9 },
      { op: `recolor`, idx: 1, hex: `#0f0f0f` },
    ]
    const { hidden, recolor } = merge_atoms(3, ov)
    expect(hidden.has(9)).toBe(false)
    expect(recolor.get(1)).toBe(`#0f0f0f`)
  })

  it(`prune_atom_overrides drops idx >= n_atoms, keeps in-range`, () => {
    const ov: AtomOverride[] = [
      { op: `hide`, idx: 0 },
      { op: `recolor`, idx: 7, hex: `#fff` },
      { op: `recolor`, idx: 2, hex: `#000` },
    ]
    const kept = prune_atom_overrides(ov, 3)
    expect(kept).toEqual([
      { op: `hide`, idx: 0 },
      { op: `recolor`, idx: 2, hex: `#000` },
    ])
  })

  it(`prune_atom_overrides empty passthrough`, () => {
    expect(prune_atom_overrides([], 5)).toEqual([])
  })
})

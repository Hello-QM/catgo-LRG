import { describe, expect, it } from 'vitest'
import { merge_bonds, type Bond, type BondOverride } from './bond-merge'

const base: Bond[] = [
  { i: 0, j: 1, order: 1 },
  { i: 1, j: 2, order: 1 },
]

describe(`merge_bonds`, () => {
  it(`returns base bonds when no overrides`, () => {
    expect(merge_bonds(base, [])).toEqual(base)
  })

  it(`add override inserts a new bond`, () => {
    const ov: BondOverride[] = [{ op: `add`, i: 2, j: 3, order: 1 }]
    const out = merge_bonds(base, ov)
    expect(out).toContainEqual({ i: 2, j: 3, order: 1 })
    expect(out).toHaveLength(3)
  })

  it(`remove override drops a bond regardless of i/j order`, () => {
    const ov: BondOverride[] = [{ op: `remove`, i: 1, j: 0 }]
    const out = merge_bonds(base, ov)
    expect(out).toHaveLength(1)
    expect(out).toContainEqual({ i: 1, j: 2, order: 1 })
  })

  it(`setorder override changes the bond order`, () => {
    const ov: BondOverride[] = [{ op: `setorder`, i: 0, j: 1, order: 2 }]
    const out = merge_bonds(base, ov)
    expect(out).toContainEqual({ i: 0, j: 1, order: 2 })
  })

  it(`prune_overrides drops overrides referencing deleted atoms`, async () => {
    const { prune_overrides } = await import(`./bond-merge`)
    const ov: BondOverride[] = [
      { op: `add`, i: 2, j: 9, order: 1 },
      { op: `setorder`, i: 0, j: 1, order: 2 },
    ]
    expect(prune_overrides(ov, 3)).toEqual([
      { op: `setorder`, i: 0, j: 1, order: 2 },
    ])
  })
})

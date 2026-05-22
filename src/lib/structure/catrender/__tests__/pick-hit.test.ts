import { describe, expect, it } from 'vitest'
import { nearest_atom, nearest_bond, type PickAtom } from '../pick-hit'

describe(`nearest_atom`, () => {
  const atoms: PickAtom[] = [
    { x: 0, y: 0, r: 10 },
    { x: 50, y: 0, r: 10 },
    { x: 0, y: 50, r: 5 },
  ]

  it(`picks the atom whose circle contains the click`, () => {
    expect(nearest_atom(48, 2, atoms)).toBe(1)
  })

  it(`returns null when the click misses every atom (outside r+slack)`, () => {
    expect(nearest_atom(200, 200, atoms)).toBeNull()
  })

  it(`picks the nearest atom within the forgiving slack band`, () => {
    // 4px outside atom 2's r=5 (dist 9 ≤ 5+6 slack) — a near-miss still hits.
    expect(nearest_atom(0, 59, atoms)).toBe(2)
  })

  it(`resolves an exact tie deterministically to the lowest index`, () => {
    const tied: PickAtom[] = [
      { x: 0, y: 0, r: 10 },
      { x: 0, y: 0, r: 10 },
    ]
    expect(nearest_atom(3, 4, tied)).toBe(0)
  })

  it(`returns null for an empty atom list`, () => {
    expect(nearest_atom(0, 0, [])).toBeNull()
  })

  it(`prefers an inside-circle hit over a closer-centre near-miss`, () => {
    // a: click is INSIDE (dist 9 ≤ r 10). b: centre closer (dist 3) but
    // click is OUTSIDE its tiny r=1 (near-band). Inside wins.
    const mix: PickAtom[] = [
      { x: 0, y: 0, r: 10 },
      { x: 12, y: 0, r: 1 },
    ]
    expect(nearest_atom(9, 0, mix)).toBe(0)
  })
})

describe(`nearest_bond`, () => {
  const atoms = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]
  const bonds: [number, number][] = [
    [0, 1],
    [1, 2],
  ]

  it(`hits a bond when the click is near its segment`, () => {
    expect(nearest_bond(50, 3, bonds, atoms, 8)).toEqual([0, 1])
  })

  it(`does NOT hit when the click is beyond an endpoint (segment, not line)`, () => {
    // On the infinite line through [0,1] (y≈0) but x=-50, far past atom 0.
    // Distance to the SEGMENT = 50 (to endpoint) > thresh ⇒ null.
    expect(nearest_bond(-50, 0, bonds, atoms, 8)).toBeNull()
  })

  it(`returns null when the closest bond is outside thresh`, () => {
    expect(nearest_bond(50, 40, bonds, atoms, 8)).toBeNull()
  })

  it(`returns null for an empty bond list`, () => {
    expect(nearest_bond(50, 0, [], atoms, 8)).toBeNull()
  })

  it(`picks the closer of two candidate bonds`, () => {
    // Near the [1,2] vertical segment (x≈100), far from [0,1].
    expect(nearest_bond(98, 50, bonds, atoms, 8)).toEqual([1, 2])
  })

  it(`skips bonds referencing a missing atom index`, () => {
    expect(nearest_bond(50, 0, [[0, 9]], atoms, 8)).toBeNull()
  })
})

import { stable_frame_lattice } from '$lib/trajectory/trajectory-utils'
import { describe, expect, test } from 'vitest'

const MAT = [
  [10, 0, 0],
  [0, 10, 0],
  [0, 0, 10],
]

describe(`stable_frame_lattice`, () => {
  test(`returns null for missing or malformed lattice`, () => {
    expect(stable_frame_lattice(null, null)).toBeNull()
    expect(stable_frame_lattice(null, undefined)).toBeNull()
    expect(stable_frame_lattice(MAT, [[1, 0, 0]])).toBeNull()
  })

  test(`first adoption snapshots the matrix (new plain copy, not the input ref)`, () => {
    const out = stable_frame_lattice(null, MAT)
    expect(out).not.toBe(MAT)
    expect(out).toEqual(MAT)
    // Snapshot is detached: mutating the source must not leak through.
    const src = MAT.map((row) => [...row])
    const snap = stable_frame_lattice(null, src)!
    src[1][1] = 99
    expect(snap[1][1]).toBe(10)
  })

  test(`fixed cell keeps the previous reference across frames`, () => {
    const prev = stable_frame_lattice(null, MAT)!
    // A different array object with the same nine numbers (each materialized
    // frame carries its own matrix arrays) must NOT produce a new identity.
    const same_values = MAT.map((row) => [...row])
    expect(stable_frame_lattice(prev, same_values)).toBe(prev)
  })

  test(`variable cell produces a new snapshot when any entry changes`, () => {
    const prev = stable_frame_lattice(null, MAT)!
    const grown = MAT.map((row) => [...row])
    grown[2][2] = 10.05 // NPT c-axis breathing
    const next = stable_frame_lattice(prev, grown)
    expect(next).not.toBe(prev)
    expect(next![2][2]).toBe(10.05)
    // And a return to the original values re-snapshots (prev no longer matches)
    const back = stable_frame_lattice(next, MAT)
    expect(back).not.toBe(next)
    expect(back).toEqual(MAT)
  })

  test(`off-diagonal (tilt) changes are detected`, () => {
    const prev = stable_frame_lattice(null, MAT)!
    const tilted = MAT.map((row) => [...row])
    tilted[1][0] = 0.2
    expect(stable_frame_lattice(prev, tilted)).not.toBe(prev)
  })
})

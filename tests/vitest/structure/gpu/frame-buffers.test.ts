import { describe, it, expect } from 'vitest'
import {
  apply_position_overrides,
  pack_lattice,
  pack_positions,
} from '$lib/structure/gpu/frame-buffers'
import type { Site, PymatgenLattice } from '$lib/structure'

function site(xyz: [number, number, number]): Site {
  return { species: [{ element: `C`, occu: 1 } as never], abc: [0, 0, 0], xyz } as Site
}

describe(`pack_positions`, () => {
  it(`packs site xyz into a flat Float32Array(3N)`, () => {
    const out = pack_positions([site([1, 2, 3]), site([4, 5, 6])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6])
  })
  it(`returns a raw Float32Array frame unchanged (already 3N)`, () => {
    const frame = new Float32Array([7, 8, 9])
    expect(pack_positions(frame)).toBe(frame)
  })
})

describe(`apply_position_overrides`, () => {
  it(`preserves the zero-copy frame when no interaction preview is active`, () => {
    const frame = new Float32Array([1, 2, 3])
    expect(apply_position_overrides(frame, null)).toBe(frame)
    expect(apply_position_overrides(frame, new Map())).toBe(frame)
  })

  it(`clones the frame and replaces only valid base-site positions`, () => {
    const frame = new Float32Array([1, 2, 3, 4, 5, 6])
    const out = apply_position_overrides(frame, new Map([
      [1, [7, 8, 9] as const],
      [4, [10, 11, 12] as const],
    ]))
    expect(out).not.toBe(frame)
    expect(Array.from(out)).toEqual([1, 2, 3, 7, 8, 9])
    expect(Array.from(frame)).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe(`pack_lattice`, () => {
  it(`flattens a 3x3 lattice matrix row-major into Float32Array(9)`, () => {
    const lat: PymatgenLattice = { matrix: [[1, 0, 0], [0, 2, 0], [0, 0, 3]] } as PymatgenLattice
    expect(Array.from(pack_lattice(lat))).toEqual([1, 0, 0, 0, 2, 0, 0, 0, 3])
  })
  it(`returns a zero matrix for a non-periodic (no-lattice) structure`, () => {
    expect(Array.from(pack_lattice(undefined))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
  })
})

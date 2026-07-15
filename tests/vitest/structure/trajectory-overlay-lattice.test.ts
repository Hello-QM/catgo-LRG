import { build_trajectory_overlay_structure } from '$lib/structure/bond-computation-controller.svelte'
import type { AnyStructure } from '$lib/structure'
import { describe, expect, test } from 'vitest'

// 2-atom cubic cell, a = 10 Å. Frame lattice grows the cell to 20 Å —
// the abc recompute and the overlay's lattice must both use the FRAME cell,
// not the frozen base cell (variable-cell / NPT trajectories).
const BASE_MATRIX = [
  [10, 0, 0],
  [0, 10, 0],
  [0, 0, 10],
]
const FRAME_MATRIX = [
  [20, 0, 0],
  [0, 20, 0],
  [0, 0, 20],
]

function make_structure(): AnyStructure {
  return {
    lattice: {
      matrix: BASE_MATRIX,
      pbc: [true, true, true],
      a: 10,
      b: 10,
      c: 10,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: 1000,
    },
    sites: [
      {
        species: [{ element: `Na`, occu: 1, oxidation_state: 0 }],
        abc: [0, 0, 0],
        xyz: [0, 0, 0],
        label: `Na1`,
        properties: {},
      },
      {
        species: [{ element: `Cl`, occu: 1, oxidation_state: 0 }],
        abc: [0.5, 0.5, 0.5],
        xyz: [5, 5, 5],
        label: `Cl1`,
        properties: {},
      },
    ],
  } as unknown as AnyStructure
}

describe(`build_trajectory_overlay_structure — variable-cell frame lattice`, () => {
  const traj = new Float32Array([0, 0, 0, 10, 10, 10]) // Cl moved to frame-cell center

  test(`without frame_lattice: abc from the base cell, lattice untouched`, () => {
    const base = make_structure()
    const overlay = build_trajectory_overlay_structure(base, traj) as unknown as {
      lattice: { matrix: number[][] }
      sites: { abc: number[]; xyz: number[] }[]
    }
    expect(overlay.lattice.matrix).toBe(BASE_MATRIX)
    // xyz (10,10,10) in the 10 Å base cell → abc (1,1,1)
    expect(overlay.sites[1].abc[0]).toBeCloseTo(1, 10)
    expect(overlay.sites[1].abc[1]).toBeCloseTo(1, 10)
    expect(overlay.sites[1].abc[2]).toBeCloseTo(1, 10)
  })

  test(`with frame_lattice: abc from the frame cell AND overlay carries it`, () => {
    const base = make_structure()
    const overlay = build_trajectory_overlay_structure(
      base,
      traj,
      FRAME_MATRIX,
    ) as unknown as {
      lattice: { matrix: number[][]; pbc: boolean[] }
      sites: { abc: number[]; xyz: number[] }[]
    }
    // Overlay must detect PBC images in the frame's cell.
    expect(overlay.lattice.matrix).toBe(FRAME_MATRIX)
    // Non-matrix lattice fields survive the copy (pbc drives the detector).
    expect(overlay.lattice.pbc).toEqual([true, true, true])
    // xyz (10,10,10) in the 20 Å frame cell → abc (0.5,0.5,0.5)
    expect(overlay.sites[1].abc[0]).toBeCloseTo(0.5, 10)
    expect(overlay.sites[1].abc[1]).toBeCloseTo(0.5, 10)
    expect(overlay.sites[1].abc[2]).toBeCloseTo(0.5, 10)
    expect(overlay.sites[1].xyz).toEqual([10, 10, 10])
  })

  test(`input structure is never mutated`, () => {
    const base = make_structure()
    build_trajectory_overlay_structure(base, traj, FRAME_MATRIX)
    const b = base as unknown as {
      lattice: { matrix: number[][] }
      sites: { xyz: number[] }[]
    }
    expect(b.lattice.matrix).toBe(BASE_MATRIX)
    expect(b.sites[1].xyz).toEqual([5, 5, 5])
  })

  test(`frame_lattice identical to the base matrix reference skips the lattice copy`, () => {
    const base = make_structure()
    const overlay = build_trajectory_overlay_structure(
      base,
      traj,
      BASE_MATRIX,
    ) as unknown as { lattice: { matrix: number[][] } }
    expect(overlay.lattice).toBe(
      (base as unknown as { lattice: unknown }).lattice,
    )
  })
})

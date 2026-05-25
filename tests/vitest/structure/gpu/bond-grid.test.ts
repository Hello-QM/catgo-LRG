import { describe, it, expect } from 'vitest'
import {
  MAX_PER_CELL,
  MIN_GRID_DIM,
  periodic_grid_dims,
  compute_aabb,
  aabb_grid_dims,
  plan_grid,
} from '$lib/structure/gpu/bond-grid'

const ortho = (a: number, b: number, c: number) =>
  new Float32Array([a, 0, 0, 0, b, 0, 0, 0, c])

describe(`periodic_grid_dims`, () => {
  it(`dim = floor(|v| / h) per axis`, () => {
    // 12 / 3 = 4; 9 / 3 = 3; 30 / 3 = 10
    expect(periodic_grid_dims(ortho(12, 9, 30), 3)).toEqual([4, 3, 10])
  })

  it(`clamps each dim to at least 1`, () => {
    // 2 / 3 = 0.66 → floor 0 → clamped to 1
    expect(periodic_grid_dims(ortho(2, 2, 2), 3)).toEqual([1, 1, 1])
  })

  it(`uses lattice VECTOR LENGTHS (works for non-orthogonal rows)`, () => {
    // row a = (3,4,0) ⇒ |a| = 5 ⇒ 5/2.5 = 2; row b = (0,10,0) ⇒ 10/2.5 = 4;
    // row c = (0,0,10) ⇒ 4.
    const lat = new Float32Array([3, 4, 0, 0, 10, 0, 0, 0, 10])
    expect(periodic_grid_dims(lat, 2.5)).toEqual([2, 4, 4])
  })

  it(`h <= 0 collapses to all-ones`, () => {
    expect(periodic_grid_dims(ortho(12, 12, 12), 0)).toEqual([1, 1, 1])
  })
})

describe(`compute_aabb`, () => {
  it(`finds the min/max corner over interleaved xyz`, () => {
    const p = new Float32Array([1, 2, 3, -4, 5, -6, 0, 0, 9])
    const { min, max } = compute_aabb(p, 3)
    expect(min).toEqual([-4, 0, -6])
    expect(max).toEqual([1, 5, 9])
  })

  it(`n = 0 returns a zero box`, () => {
    expect(compute_aabb(new Float32Array(0), 0)).toEqual({
      min: [0, 0, 0],
      max: [0, 0, 0],
    })
  })
})

describe(`aabb_grid_dims`, () => {
  it(`dim = ceil(extent / h), at least 1`, () => {
    // extents 10,3,0 with h=3 ⇒ ceil(10/3)=4, ceil(3/3)=1, ceil(0/3)=0→1
    expect(aabb_grid_dims([0, 0, 0], [10, 3, 0], 3)).toEqual([4, 1, 1])
  })
})

describe(`plan_grid`, () => {
  it(`periodic large cell ⇒ use_grid true, dims ≥ ${MIN_GRID_DIM}`, () => {
    const plan = plan_grid({
      periodic: true,
      lattice: ortho(12, 12, 12),
      max_bond_dist: 3,
      positions: new Float32Array(0),
      n: 0,
    })
    expect(plan.use_grid).toBe(true)
    expect(plan.dims).toEqual([4, 4, 4])
    expect(plan.n_cells).toBe(64)
    expect(plan.aabb_min).toEqual([0, 0, 0])
    expect(plan.max_per_cell).toBe(MAX_PER_CELL)
    expect(plan.inv_h).toBeCloseTo(1 / 3, 6)
  })

  it(`periodic SMALL cell (any dim < 3) ⇒ use_grid false (O(N²) fallback)`, () => {
    // 12 / 3 = 4, but 5 / 3 = 1 < 3 ⇒ fall back.
    const plan = plan_grid({
      periodic: true,
      lattice: ortho(12, 5, 12),
      max_bond_dist: 3,
      positions: new Float32Array(0),
      n: 0,
    })
    expect(plan.use_grid).toBe(false)
    expect(plan.dims).toEqual([4, 1, 4])
  })

  it(`non-periodic ⇒ use_grid always true, dims from AABB`, () => {
    // atoms span x:[0,9], y:[0,0], z:[0,6]; h=3 ⇒ ceil(9/3)=3, 1, ceil(6/3)=2.
    const positions = new Float32Array([0, 0, 0, 9, 0, 6])
    const plan = plan_grid({
      periodic: false,
      lattice: new Float32Array(9),
      max_bond_dist: 3,
      positions,
      n: 2,
    })
    expect(plan.use_grid).toBe(true)
    expect(plan.dims).toEqual([3, 1, 2])
    expect(plan.n_cells).toBe(6)
    expect(plan.aabb_min).toEqual([0, 0, 0])
  })
})

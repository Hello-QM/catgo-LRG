import { describe, expect, it } from 'vitest'
import {
  apply_view_transform_to_lattice,
  apply_view_transform_to_origin,
  apply_view_transform_to_positions,
  resolve_view_transform,
} from '$lib/structure/rendering/view-transform'

const close_array = (actual: ArrayLike<number>, expected: readonly number[]) => {
  expect(Array.from(actual)).toHaveLength(expected.length)
  expected.forEach((value, idx) => expect(actual[idx]).toBeCloseTo(value, 6))
}

describe(`shared view transform`, () => {
  it(`keeps identity positions and lattice zero-copy`, () => {
    const transform = resolve_view_transform([0, 0, 0], [4, -2, 1])
    const positions = new Float32Array([1, 2, 3, 4, 5, 6])
    const lattice = new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 3])

    expect(apply_view_transform_to_positions(positions, transform)).toBe(positions)
    expect(apply_view_transform_to_lattice(lattice, transform)).toBe(lattice)
    expect(apply_view_transform_to_origin(transform)).toEqual([0, 0, 0])
  })

  it(`applies T(target) · R · T(-target) to positions around a non-zero pivot`, () => {
    const transform = resolve_view_transform([0, 0, Math.PI / 2], [1, 1, 0])
    const positions = new Float32Array([
      2, 1, 0,
      1, 2, 0,
    ])

    close_array(
      apply_view_transform_to_positions(positions, transform),
      [1, 2, 0, 0, 1, 0],
    )
  })

  it(`rotates lattice vectors and translates the cell origin consistently`, () => {
    const transform = resolve_view_transform([0, 0, Math.PI / 2], [1, 1, 0])
    const lattice = new Float32Array([
      1, 0, 0,
      0, 2, 0,
      0, 0, 3,
    ])

    close_array(
      apply_view_transform_to_lattice(lattice, transform),
      [0, 1, 0, -2, 0, 0, 0, 0, 3],
    )
    close_array(apply_view_transform_to_origin(transform), [2, 0, 0])
  })
})

import { describe, expect, it } from 'vitest'
import {
  resolve_bond_color_span,
  sample_bond_color,
} from '$lib/structure/rendering/bond-colors'

const RED = [1, 0, 0] as const
const BLUE = [0, 0, 1] as const

describe(`shared bond color semantics`, () => {
  it(`uses two solid endpoint-colored halves with a fixed B-side midpoint`, () => {
    const full = resolve_bond_color_span(RED, BLUE, `full`, 0)

    expect(sample_bond_color(full, 0.49)).toEqual(RED)
    expect(sample_bond_color(full, 0.5)).toEqual(BLUE)
    expect(sample_bond_color(full, 0.51)).toEqual(BLUE)
  })

  it(`keeps boundary stubs monochrome on their endpoint side`, () => {
    const stub_a = resolve_bond_color_span(RED, BLUE, `boundary-stub`, 0)
    const stub_b = resolve_bond_color_span(RED, BLUE, `boundary-stub`, 1)

    expect([stub_a.start, stub_a.end, stub_b.start, stub_b.end]).toEqual([
      RED,
      RED,
      BLUE,
      BLUE,
    ])
  })
})

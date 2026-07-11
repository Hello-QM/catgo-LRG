import { describe, expect, it } from 'vitest'
import { polyline_points } from '../ir-utils'

describe('polyline_points', () => {
  it('maps data to padded SVG space with flipped y', () => {
    const pts = polyline_points([0, 1, 2], [0, 10, 0], 100, 50, 5)
    const pairs = pts.split(' ').map((p) => p.split(',').map(Number))
    expect(pairs[0]).toEqual([5, 45]) // x-min → left pad, y=0 → bottom
    expect(pairs[1]).toEqual([50, 5]) // midpoint, peak → top pad
    expect(pairs[2]).toEqual([95, 45])
  })

  it('handles flat data without dividing by zero', () => {
    const pts = polyline_points([0, 1], [3, 3], 100, 50, 5)
    expect(pts).not.toContain('NaN')
  })
})

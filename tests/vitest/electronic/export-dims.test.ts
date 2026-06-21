import { describe, it, expect } from 'vitest'
import { compute_export_px, DPI_MAX } from '$lib/electronic/export-dims'

describe('compute_export_px', () => {
  it('maps mm + dpi to pixels (180mm @ 300dpi -> 2126)', () => {
    expect(compute_export_px(180, 300, 0.5).width).toBe(2126)
  })

  it('preserves aspect ratio in height', () => {
    const d = compute_export_px(180, 300, 0.625)
    expect(d.height).toBe(Math.round(d.width * 0.625))
  })

  it('clamps dpi to the max', () => {
    expect(compute_export_px(100, 99999, 1).width).toBe(
      compute_export_px(100, DPI_MAX, 1).width,
    )
  })
})

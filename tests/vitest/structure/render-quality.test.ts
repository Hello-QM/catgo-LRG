import { describe, expect, test } from 'vitest'
import {
  QUALITY_PIXEL_BUDGET,
  QUALITY_TARGET_DPR,
  resolve_render_dpr,
} from '$lib/structure/render-quality'

describe(`structure render quality`, () => {
  const base = {
    device_dpr: 1,
    width: 1200,
    height: 800,
    quality: true,
    moving: false,
    playing: false,
    suspended: false,
  }

  test(`paused quality mode supersamples analytic atom-bond intersections`, () => {
    expect(resolve_render_dpr(base)).toBe(QUALITY_TARGET_DPR)
  })

  test.each([
    [`camera motion`, { moving: true }],
    [`trajectory playback`, { playing: true }],
    [`large-system overlay`, { suspended: true }],
    [`speed mode`, { quality: false }],
  ])(`uses native DPR during %s`, (_label, change) => {
    expect(resolve_render_dpr({ ...base, ...change, device_dpr: 1.5 })).toBe(1.5)
  })

  test(`caps supersampling by drawing-buffer pixel budget`, () => {
    const dpr = resolve_render_dpr({ ...base, width: 3000, height: 2000 })
    expect(dpr).toBeCloseTo(Math.sqrt(QUALITY_PIXEL_BUDGET / 6_000_000))
  })

  test(`never undersamples a high-DPI display`, () => {
    expect(resolve_render_dpr({
      ...base,
      device_dpr: 3,
      width: 4000,
      height: 3000,
    })).toBe(3)
  })
})

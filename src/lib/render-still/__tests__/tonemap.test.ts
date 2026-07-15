import { describe, expect, test } from 'vitest'
import {
  aces_filmic_tonemap,
  float_rgba_to_srgb_pixels,
  linear_to_srgb,
} from '../tonemap'

describe(`linear_to_srgb`, () => {
  test(`endpoints and clamping`, () => {
    expect(linear_to_srgb(0)).toBe(0)
    expect(linear_to_srgb(1)).toBe(1)
    expect(linear_to_srgb(-0.5)).toBe(0)
    expect(linear_to_srgb(2)).toBe(1)
  })

  test(`linear segment boundary matches the OETF pieces`, () => {
    expect(linear_to_srgb(0.0031308)).toBeCloseTo(0.0031308 * 12.92, 10)
    // reference value for mid-gray
    expect(linear_to_srgb(0.5)).toBeCloseTo(0.7353569, 5)
  })

  test(`monotonic`, () => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const v = linear_to_srgb(i / 100)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe(`aces_filmic_tonemap`, () => {
  test(`black stays black, bright white saturates to 1`, () => {
    expect(aces_filmic_tonemap(0, 0, 0)).toEqual([0, 0, 0])
    const [r, g, b] = aces_filmic_tonemap(20, 20, 20)
    expect(r).toBeCloseTo(1, 3)
    expect(g).toBeCloseTo(1, 3)
    expect(b).toBeCloseTo(1, 3)
  })

  test(`neutral input stays (near-)neutral`, () => {
    // the fitted ACES matrices are not perfectly row-normalized (same in
    // three's GLSL) — allow the ~1e-5 channel drift they produce
    const [r, g, b] = aces_filmic_tonemap(0.18, 0.18, 0.18)
    expect(r).toBeCloseTo(g, 4)
    expect(g).toBeCloseTo(b, 4)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(1)
  })

  test(`monotonic in exposure and value`, () => {
    const lo = aces_filmic_tonemap(0.25, 0.25, 0.25)[0]
    const hi = aces_filmic_tonemap(0.5, 0.5, 0.5)[0]
    expect(hi).toBeGreaterThan(lo)
    const exposed = aces_filmic_tonemap(0.25, 0.25, 0.25, 2)[0]
    expect(exposed).toBeGreaterThan(lo)
  })

  test(`output always clamped to [0, 1]`, () => {
    // strongly saturated input can push the output matrix negative pre-clamp
    const [r, g, b] = aces_filmic_tonemap(0, 0, 5)
    for (const c of [r, g, b]) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(1)
    }
  })
})

describe(`float_rgba_to_srgb_pixels`, () => {
  test(`flips vertically (GL bottom-left → canvas top-left)`, () => {
    // 1×2: source row 0 (bottom) = red, row 1 (top) = blue
    const data = new Float32Array([
      1, 0, 0, 1, // bottom row
      0, 0, 1, 1, // top row
    ])
    const out = float_rgba_to_srgb_pixels(data, 1, 2, 1)
    expect(out.length).toBe(8)
    // output row 0 must be the TOP source row (blue-dominant)
    expect(out[2]).toBeGreaterThan(out[0])
    // output row 1 must be the bottom source row (red-dominant)
    expect(out[4]).toBeGreaterThan(out[6])
    // alpha forced opaque
    expect(out[3]).toBe(255)
    expect(out[7]).toBe(255)
  })

  test(`un-premultiplies partial alpha`, () => {
    const premult = new Float32Array([0.5, 0, 0, 0.5])
    const full = new Float32Array([1, 0, 0, 1])
    const a = float_rgba_to_srgb_pixels(premult, 1, 1, 1)
    const b = float_rgba_to_srgb_pixels(full, 1, 1, 1)
    expect(a[0]).toBe(b[0])
    expect(a[1]).toBe(b[1])
    expect(a[2]).toBe(b[2])
  })

  test(`zero alpha leaves color untouched (no divide-by-zero)`, () => {
    const data = new Float32Array([0.5, 0.5, 0.5, 0])
    const out = float_rgba_to_srgb_pixels(data, 1, 1, 1)
    expect(Number.isNaN(out[0])).toBe(false)
    expect(out[3]).toBe(255)
  })
})

import { describe, expect, it } from 'vitest'
import { compute_export_render_plan, fit_plan_to_drawing_buffer } from '../export'

describe(`fit_plan_to_drawing_buffer`, () => {
  it(`returns the plan unchanged when it already fits the buffer`, () => {
    const plan = compute_export_render_plan(1676, 905, 3352, 1810, 32768)
    const fitted = fit_plan_to_drawing_buffer(plan, 7838, 4232)
    expect(fitted).toBe(plan) // same reference — no scaling
    expect(fitted.render_width).toBe(3352)
    expect(fitted.render_height).toBe(1810)
  })

  it(`scales the plan down to the clamped drawing buffer, preserving aspect`, () => {
    // High-DPI export requests 12000 wide but the browser clamps the buffer.
    const plan = compute_export_render_plan(1676, 905, 12000, 6480, 32768)
    expect(plan.render_width).toBe(12000)
    const fitted = fit_plan_to_drawing_buffer(plan, 7838, 4232)
    // Render must now fit inside the real buffer (the whole point of the fix).
    expect(fitted.render_width).toBeLessThanOrEqual(7838)
    expect(fitted.render_height).toBeLessThanOrEqual(4232)
    // Aspect is preserved (12000/6480 ≈ 1.852).
    const orig_aspect = 12000 / 6480
    const new_aspect = fitted.render_width / fitted.render_height
    expect(Math.abs(new_aspect - orig_aspect)).toBeLessThan(0.01)
    // full_* scale by the same factor.
    expect(fitted.full_width).toBeLessThanOrEqual(7838)
  })

  it(`scales the crop view_offset by the same factor`, () => {
    const crop = { x: 100, y: 50, width: 800, height: 400 }
    const plan = compute_export_render_plan(1676, 905, 16760, 9050, 32768, crop)
    expect(plan.view_offset).toBeDefined()
    const fitted = fit_plan_to_drawing_buffer(plan, 7838, 4232)
    expect(fitted.render_width).toBeLessThanOrEqual(7838)
    expect(fitted.view_offset).toBeDefined()
    // The offset window must stay inside its (scaled) full frame.
    const vo = fitted.view_offset!
    expect(vo.x + vo.width).toBeLessThanOrEqual(vo.full_width + 1)
    expect(vo.y + vo.height).toBeLessThanOrEqual(vo.full_height + 1)
  })

  it(`never returns a zero or negative dimension`, () => {
    const plan = compute_export_render_plan(1676, 905, 40000, 21600, 32768)
    const fitted = fit_plan_to_drawing_buffer(plan, 1, 1)
    expect(fitted.render_width).toBeGreaterThanOrEqual(1)
    expect(fitted.render_height).toBeGreaterThanOrEqual(1)
  })
})

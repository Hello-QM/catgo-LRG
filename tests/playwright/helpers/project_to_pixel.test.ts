// Unit tests for project_to_pixel. Authored as Playwright tests so they
// live alongside the rest of the W7 suite, but they don't open a page —
// they exercise the math against known matrices in pure-TS.
//
// The matrices follow Three.js convention: `Matrix4.elements` is
// COLUMN-MAJOR — the helper must apply column-by-column. The first test
// uses identity projection + identity view; xyz (0, 0, -1) should land at
// the canvas center because:
//   view * (0, 0, -1, 1) = (0, 0, -1, 1)
//   projection * (0, 0, -1, 1) = (0, 0, -1, 1)
//   ndc = (0, 0)
//   px = (0 * 0.5 + 0.5) * width = width/2
//   py = (1 - (0 * 0.5 + 0.5)) * height = height/2
//
// The second test verifies the Y-flip with an off-axis world point.

import { expect, test } from '@playwright/test'
import { project_to_pixel } from './project_to_pixel'

// Column-major 4x4 identity matrix flat array (Three.js layout).
const IDENTITY_4: number[] = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]

test.describe(`project_to_pixel helper`, () => {
  test(`identity matrices: (0, 0, -1) lands at canvas center`, () => {
    const matrices = {
      projection: [...IDENTITY_4],
      view: [...IDENTITY_4],
      width: 800,
      height: 600,
    }
    const pixel = project_to_pixel(matrices, [0, 0, -1])
    // Identity projection produces clip = view-space = (0, 0, -1, 1) →
    // ndc = (0, 0) → px = width/2, py = height/2.
    expect(pixel).not.toBeNull()
    expect(pixel!.x).toBeCloseTo(400, 4)
    expect(pixel!.y).toBeCloseTo(300, 4)
  })

  test(`Y-flip: world +Y maps to canvas top half (smaller y)`, () => {
    // Identity matrices, world point at (0, +0.5, -1):
    //   ndc = (0, +0.5) — top half in NDC (y points up).
    //   px = width/2 = 400.
    //   py = (1 - (0.5 * 0.5 + 0.5)) * height = (1 - 0.75) * 600 = 150.
    // 150 < 300 (canvas center) → the +Y world point lands ABOVE center
    // in screen space, which is what we expect.
    const matrices = {
      projection: [...IDENTITY_4],
      view: [...IDENTITY_4],
      width: 800,
      height: 600,
    }
    const pixel = project_to_pixel(matrices, [0, 0.5, -1])
    expect(pixel).not.toBeNull()
    expect(pixel!.x).toBeCloseTo(400, 4)
    expect(pixel!.y).toBeCloseTo(150, 4)
    // Sanity: top half means y < height/2.
    expect(pixel!.y).toBeLessThan(300)
  })

  test(`returns null for points behind camera (w <= 0)`, () => {
    // With identity view + identity projection, w in clip-space equals
    // the input's w (= 1) regardless of position — there's no real "behind
    // camera" in the identity case. Build a minimal perspective-style
    // projection that produces wc = -z so a positive z lands behind.
    //
    // Three.js perspective puts -1 in m[11] (column 2, row 3) so that
    // wc = -z_view. Build that minimal matrix in column-major.
    const persp_like: number[] = [
      1, 0, 0, 0, // col 0
      0, 1, 0, 0, // col 1
      0, 0, -1, -1, // col 2 — m[11] = -1 makes wc = -z_view
      0, 0, 0, 0, // col 3
    ]
    const matrices = {
      projection: persp_like,
      view: [...IDENTITY_4],
      width: 800,
      height: 600,
    }
    // World point at z = +1 → view-space z = +1 → wc = -(+1) = -1 → null.
    const behind = project_to_pixel(matrices, [0, 0, 1])
    expect(behind).toBeNull()
  })

  test(`returns null when matrices missing`, () => {
    expect(project_to_pixel(null, [0, 0, 0])).toBeNull()
  })

  test(`returns null when matrices have wrong length`, () => {
    const bad = {
      projection: [1, 0, 0, 0],
      view: [...IDENTITY_4],
      width: 800,
      height: 600,
    }
    expect(project_to_pixel(bad, [0, 0, -1])).toBeNull()
  })
})

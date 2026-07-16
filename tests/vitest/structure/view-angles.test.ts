/**
 * View-angle Euler math (view-angles.ts) — basis construction and the
 * angles ⇄ view round-trip, including gimbal-lock (±90° pitch) cases.
 */
import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import {
  camera_basis,
  view_angles_from_basis,
  view_from_angles,
} from '$lib/structure/view-angles'

type Vec3 = [number, number, number]

// Rebuild the camera basis exactly the way Structure.svelte does after a
// set_view_angles: camera sits at target - dir·dist, so backward = -dir.
function angles_to_basis(angles: Vec3) {
  const { dir, up } = view_from_angles(angles)
  const backward = new Vector3(-dir[0], -dir[1], -dir[2])
  const basis = camera_basis(backward, new Vector3(...up))
  expect(basis).not.toBeNull()
  return { dir, up, basis: basis! }
}

// Signed angular distance in degrees, modulo 360 (180 ≡ -180).
const wrap_diff = (a: number, b: number) => Math.abs(((a - b) % 360 + 540) % 360 - 180)

describe(`view-angles euler math`, () => {
  it(`default view decomposes to (0,0,0)`, () => {
    const basis = camera_basis(new Vector3(0, -1, 0), new Vector3(0, 0, 1))
    expect(basis).not.toBeNull()
    expect(view_angles_from_basis(basis!)).toEqual([0, 0, 0])
  })

  it(`(0,0,0) maps to the default view direction (+Y into screen, Z up)`, () => {
    const { dir, up } = view_from_angles([0, 0, 0])
    expect(dir[0]).toBeCloseTo(0, 6)
    expect(dir[1]).toBeCloseTo(1, 6)
    expect(dir[2]).toBeCloseTo(0, 6)
    expect(up[0]).toBeCloseTo(0, 6)
    expect(up[1]).toBeCloseTo(0, 6)
    expect(up[2]).toBeCloseTo(1, 6)
  })

  it.each<[Vec3]>([
    [[30, 45, 60]],
    [[10, -20, 150]],
    [[-75, 12.5, 3]],
    [[180, 0, 0]],
    [[0, 0, -135]],
    [[45.3, -67.2, 12.8]],
  ])(`angle round-trip %j (non-gimbal)`, (angles) => {
    const { basis } = angles_to_basis(angles)
    const out = view_angles_from_basis(basis)
    for (let idx = 0; idx < 3; idx++) {
      expect(wrap_diff(out[idx], angles[idx]), `axis ${idx}`).toBeLessThan(0.11)
    }
  })

  // At ±90° pitch (XYZ order: the Y angle) the euler triple is not unique —
  // the recovered triple may differ, but it must describe the SAME view.
  it.each<[Vec3]>([
    [[0, 90, 0]],
    [[0, -90, 0]],
    [[30, 90, 0]],
    [[0, -90, 45]],
    [[15, 89.9, -30]],
  ])(`±90° pitch round-trip preserves the view %j`, (angles) => {
    const first = view_from_angles(angles)
    const backward = new Vector3(-first.dir[0], -first.dir[1], -first.dir[2])
    const basis = camera_basis(backward, new Vector3(...first.up))
    expect(basis).not.toBeNull()
    const second = view_from_angles(view_angles_from_basis(basis!))
    for (let idx = 0; idx < 3; idx++) {
      expect(second.dir[idx]).toBeCloseTo(first.dir[idx], 2)
      expect(second.up[idx]).toBeCloseTo(first.up[idx], 2)
    }
  })

  it(`camera_basis rejects degenerate input`, () => {
    // zero camera-target offset
    expect(camera_basis(new Vector3(0, 0, 0), new Vector3(0, 0, 1))).toBeNull()
    // up parallel to the view axis
    expect(camera_basis(new Vector3(0, 0, 2), new Vector3(0, 0, 1))).toBeNull()
    expect(camera_basis(new Vector3(0, 0, 2), new Vector3(0, 0, -3))).toBeNull()
  })

  it(`camera_basis does not mutate its inputs`, () => {
    const backward = new Vector3(0, -2, 0)
    const up = new Vector3(0, 0, 5)
    camera_basis(backward, up)
    expect(backward.toArray()).toEqual([0, -2, 0])
    expect(up.toArray()).toEqual([0, 0, 5])
  })

  it(`view_from_angles treats non-numeric entries as 0`, () => {
    const bad = view_from_angles([Number.NaN, 0, 0] as Vec3)
    const zero = view_from_angles([0, 0, 0])
    expect(bad.dir[1]).toBeCloseTo(zero.dir[1], 6)
    expect(bad.up[2]).toBeCloseTo(zero.up[2], 6)
  })
})

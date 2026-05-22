import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { screen_frame_from_camera, pick_locked_axis } from '$lib/structure/rotation-math'

describe('screen_frame_from_camera', () => {
  it('identity camera: x toward viewer, y right, z up', () => {
    const frame = screen_frame_from_camera(new Quaternion())
    expect(frame.x.toArray()).toEqual([0, 0, 1])
    expect(frame.y.toArray()).toEqual([1, 0, 0])
    expect(frame.z.toArray()).toEqual([0, 1, 0])
  })
  it('all axes are unit length and mutually orthogonal', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7)
    const f = screen_frame_from_camera(q)
    for (const v of [f.x, f.y, f.z]) expect(v.length()).toBeCloseTo(1, 6)
    expect(f.x.dot(f.y)).toBeCloseTo(0, 6)
    expect(f.y.dot(f.z)).toBeCloseTo(0, 6)
    expect(f.x.dot(f.z)).toBeCloseTo(0, 6)
  })
})

describe('pick_locked_axis', () => {
  const dz = 4
  it('returns null inside the dead zone', () => {
    expect(pick_locked_axis(2, 2, dz)).toBeNull()
  })
  it('horizontal-dominant drag locks z (yaw)', () => {
    expect(pick_locked_axis(10, 1, dz)).toBe('z')
  })
  it('vertical-dominant drag locks y (pitch)', () => {
    expect(pick_locked_axis(1, 10, dz)).toBe('y')
  })
  it('ties favor horizontal (z)', () => {
    expect(pick_locked_axis(5, 5, dz)).toBe('z')
  })
})

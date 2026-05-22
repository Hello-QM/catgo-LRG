import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { screen_frame_from_camera } from '$lib/structure/rotation-math'

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

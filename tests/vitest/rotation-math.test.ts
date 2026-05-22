import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  screen_frame_from_camera,
  pick_locked_axis,
  rotate_points,
  drag_delta_for_axis,
} from '$lib/structure/rotation-math'

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
  it('is right-handed (x cross y ≈ z)', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 1, 0).normalize(), 0.9)
    const f = screen_frame_from_camera(q)
    const cross = f.x.clone().cross(f.y)
    expect(cross.x).toBeCloseTo(f.z.x, 6)
    expect(cross.y).toBeCloseTo(f.z.y, 6)
    expect(cross.z).toBeCloseTo(f.z.z, 6)
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

describe('rotate_points', () => {
  it('90° about z maps (1,0,0)+center back to center+(0,1,0)', () => {
    const center: [number, number, number] = [5, 5, 5]
    const pts: Array<[number, number, number]> = [[6, 5, 5]]
    const out = rotate_points(pts, center, new Vector3(0, 0, 1), Math.PI / 2)
    expect(out[0][0]).toBeCloseTo(5, 6)
    expect(out[0][1]).toBeCloseTo(6, 6)
    expect(out[0][2]).toBeCloseTo(5, 6)
  })
  it('zero angle is identity', () => {
    const out = rotate_points([[1, 2, 3]], [0, 0, 0], new Vector3(0, 1, 0), 0)
    expect(out[0][0]).toBeCloseTo(1, 6)
    expect(out[0][1]).toBeCloseTo(2, 6)
    expect(out[0][2]).toBeCloseTo(3, 6)
  })
})

describe('drag_delta_for_axis', () => {
  it('pitch (y) reads vertical delta', () => {
    expect(drag_delta_for_axis('y', 3, 9)).toBe(9)
  })
  it('yaw (z) and roll (x) read horizontal delta', () => {
    expect(drag_delta_for_axis('z', 3, 9)).toBe(3)
    expect(drag_delta_for_axis('x', 3, 9)).toBe(3)
  })
})

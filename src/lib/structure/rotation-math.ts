import { Quaternion, Vector3 } from 'three'
import type { Vec3 } from '$lib/math'

/** Screen-aligned orthonormal frame. Origin is the selection centroid
 *  (supplied separately). x = screen normal toward viewer, y = screen
 *  right, z = screen up. Screen plane = YZ plane. */
export interface ScreenFrame {
  x: Vector3
  y: Vector3
  z: Vector3
}

/** Normalize signed-zero components to +0 so the frame is canonical
 *  (three.js quaternion math can emit -0 for axis-aligned inputs).
 *  Mutates `v` in place (only ever called on throwaway vectors). */
function clean_zeros(v: Vector3): Vector3 {
  const fix = (n: number): number => (n === 0 ? 0 : n)
  return v.set(fix(v.x), fix(v.y), fix(v.z))
}

/** Build the fixed screen frame from the camera quaternion captured at
 *  gesture start. */
export function screen_frame_from_camera(cam_quat: Quaternion): ScreenFrame {
  const right = clean_zeros(new Vector3(1, 0, 0).applyQuaternion(cam_quat).normalize())
  const up = clean_zeros(new Vector3(0, 1, 0).applyQuaternion(cam_quat).normalize())
  // +Z in camera space points toward the viewer (three.js camera looks
  // down -Z), so the screen normal is +Z transformed by the quaternion.
  const toward_viewer = clean_zeros(
    new Vector3(0, 0, 1).applyQuaternion(cam_quat).normalize(),
  )
  return { x: toward_viewer, y: right, z: up }
}

export type LockAxis = 'x' | 'y' | 'z'

/** Decide which axis a left-button drag locks onto, from the total
 *  displacement since mousedown. Returns null until the dead zone is
 *  exceeded. Horizontal-dominant → z (yaw); vertical-dominant → y (pitch).
 *  Ties favor horizontal. */
export function pick_locked_axis(
  total_dx: number,
  total_dy: number,
  deadzone_px: number,
): 'y' | 'z' | null {
  if (Math.hypot(total_dx, total_dy) < deadzone_px) return null
  return Math.abs(total_dx) >= Math.abs(total_dy) ? 'z' : 'y'
}

/** Rotate each point about `center` by `angle` radians around `axis`.
 *  Pure: inputs are tuples, output is fresh tuples. */
export function rotate_points(
  points: ReadonlyArray<Vec3>,
  center: Vec3,
  axis: Vector3,
  angle: number,
): Vec3[] {
  const quat = new Quaternion().setFromAxisAngle(axis.clone().normalize(), angle)
  const c = new Vector3(center[0], center[1], center[2])
  return points.map((p) => {
    const v = new Vector3(p[0], p[1], p[2]).sub(c).applyQuaternion(quat).add(c)
    return [v.x, v.y, v.z] as Vec3
  })
}

/** Map the locked axis to the relevant pointer-displacement component.
 *  Pitch (y) uses vertical drag; yaw (z) and roll (x) use horizontal drag. */
export function drag_delta_for_axis(
  axis: LockAxis,
  total_dx: number,
  total_dy: number,
): number {
  return axis === 'y' ? total_dy : total_dx
}

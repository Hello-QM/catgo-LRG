/**
 * Camera/controls objects are mutable Three.js instances, so Svelte cannot see
 * their internal writes.  Capture the complete view pose before an imperative
 * mutation and publish one semantic revision only after the final pose lands.
 */

type Vec3Like = {
  x: number
  y: number
  z: number
}

type QuaternionLike = {
  x: number
  y: number
  z: number
  w: number
}

type CameraPoseLike = {
  position: Vec3Like
  up: Vec3Like
  quaternion: QuaternionLike
  zoom?: number
}

export type CameraPoseSnapshot = readonly (number | null)[]

const CAMERA_POSE_EPSILON = 1e-10

export function capture_camera_pose(
  camera: CameraPoseLike | null | undefined,
  target: Vec3Like | null | undefined,
): CameraPoseSnapshot {
  return [
    camera?.position.x ?? null,
    camera?.position.y ?? null,
    camera?.position.z ?? null,
    camera?.up.x ?? null,
    camera?.up.y ?? null,
    camera?.up.z ?? null,
    camera?.quaternion.x ?? null,
    camera?.quaternion.y ?? null,
    camera?.quaternion.z ?? null,
    camera?.quaternion.w ?? null,
    Number.isFinite(camera?.zoom) ? camera!.zoom! : null,
    target?.x ?? null,
    target?.y ?? null,
    target?.z ?? null,
  ]
}

export function camera_pose_changed(
  before: CameraPoseSnapshot,
  camera: CameraPoseLike | null | undefined,
  target: Vec3Like | null | undefined,
): boolean {
  const after = capture_camera_pose(camera, target)
  if (before.length !== after.length) return true
  return after.some((value, idx) => {
    const previous = before[idx]
    if (value === null || previous === null) return value !== previous
    return Math.abs(value - previous) > CAMERA_POSE_EPSILON
  })
}

export function notify_camera_pose_change(
  before: CameraPoseSnapshot,
  camera: CameraPoseLike | null | undefined,
  target: Vec3Like | null | undefined,
  notify: () => void,
): boolean {
  if (!camera_pose_changed(before, camera, target)) return false
  notify()
  return true
}

export function mutate_camera_pose(
  camera: CameraPoseLike | null | undefined,
  target: Vec3Like | null | undefined,
  mutate: () => void,
  notify: () => void,
): boolean {
  const before = capture_camera_pose(camera, target)
  mutate()
  return notify_camera_pose_change(before, camera, target, notify)
}

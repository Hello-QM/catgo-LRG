// Pure depth-cueing helper functions extracted from StructureScene.svelte.
// Used for wireframe depth coloring during atom manipulation (drag/rotate).

import type { Vec3 } from '$lib'
import type { Camera } from 'three'
import { Vector3, Color } from 'three'

// Reusable scratch objects (module-level to avoid per-call allocation)
const _depth_vec = new Vector3()
const _near_col = new Color()
const _far_col = new Color()
const _mix_col = new Color()

/**
 * Compute the depth range (min/max camera-space Z) for a set of sites.
 * Used to normalize depth-based coloring across the selected group.
 */
export function compute_depth_range(
  sites: number[],
  overrides: Map<number, Vec3> | null | undefined,
  struct: { sites?: { xyz?: Vec3 }[] } | null | undefined,
  cam: Camera,
): [number, number] {
  let min_d = Infinity, max_d = -Infinity
  for (const idx of sites) {
    const pos = overrides?.get(idx) ?? struct?.sites?.[idx]?.xyz
    if (!pos) continue
    _depth_vec.set(pos[0], pos[1], pos[2]).applyMatrix4(cam.matrixWorldInverse)
    const d = -_depth_vec.z
    if (d < min_d) min_d = d
    if (d > max_d) max_d = d
  }
  return [min_d, max_d]
}

/**
 * Compute a depth-attenuated color for a single position.
 * Fades from `base_color` at the near plane to 15% brightness at the far plane.
 */
export function get_depth_color(
  pos: Vec3,
  cam: Camera,
  range: [number, number],
  base_color: string,
): string {
  const [min_d, max_d] = range
  if (max_d - min_d < 0.1) return base_color
  _depth_vec.set(pos[0], pos[1], pos[2]).applyMatrix4(cam.matrixWorldInverse)
  const t = Math.max(0, Math.min(1, (-_depth_vec.z - min_d) / (max_d - min_d)))
  _near_col.set(base_color)
  _far_col.set(base_color).multiplyScalar(0.15) // far = 15% brightness
  _mix_col.copy(_near_col).lerp(_far_col, t)
  return '#' + _mix_col.getHexString()
}

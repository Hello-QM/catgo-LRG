/**
 * View-angle math for the VESTA-style orientation panel — pure functions
 * extracted from Structure.svelte so the Euler round-trip is unit-testable.
 *
 * The view is expressed as XYZ Euler angles (degrees) of the rotation that
 * carries the default camera frame (camera on -Y looking along +Y, Z up)
 * onto the current one. Identity (0,0,0) = the default view.
 */
import { Euler, Matrix4, Vector3 } from 'three'

// Default camera frame: right = +X, up = +Z, backward = -Y (looks along +Y).
const DEFAULT_CAM_BASIS = new Matrix4().makeBasis(
  new Vector3(1, 0, 0), // camera right
  new Vector3(0, 0, 1), // camera up
  new Vector3(0, -1, 0), // camera backward (looks along +Y)
)

/**
 * Orthonormal camera basis from the camera→target geometry: `backward` is the
 * (camera position − orbit target) offset, `up_hint` the camera up vector.
 * Returns null for degenerate input (zero offset, up parallel to view axis).
 */
export function camera_basis(backward_in: Vector3, up_hint: Vector3): Matrix4 | null {
  if (backward_in.lengthSq() < 1e-12) return null
  const backward = backward_in.clone().normalize()
  const right = new Vector3().crossVectors(up_hint, backward)
  if (right.lengthSq() < 1e-10) return null
  right.normalize()
  const up = new Vector3().crossVectors(backward, right)
  return new Matrix4().makeBasis(right, up, backward)
}

/** XYZ Euler angles (deg, rounded to 0.1°) carrying DEFAULT_CAM_BASIS onto `basis`. */
export function view_angles_from_basis(basis: Matrix4): [number, number, number] {
  const rot = basis.clone().multiply(DEFAULT_CAM_BASIS.clone().invert())
  const euler = new Euler().setFromRotationMatrix(rot, `XYZ`)
  const deg = (rad: number) => {
    const val = Math.round(rad * (180 / Math.PI) * 10) / 10
    return val === 0 ? 0 : val // normalize -0
  }
  return [deg(euler.x), deg(euler.y), deg(euler.z)]
}

/**
 * View direction (into the screen) + up vector for the given XYZ Euler angles
 * (degrees). Non-numeric entries are treated as 0.
 */
export function view_from_angles(
  angles: [number, number, number],
): { dir: [number, number, number]; up: [number, number, number] } {
  const rad = (d: number) => (Number(d) || 0) * (Math.PI / 180)
  const rot = new Matrix4().makeRotationFromEuler(
    new Euler(rad(angles[0]), rad(angles[1]), rad(angles[2]), `XYZ`),
  )
  const backward = new Vector3(0, -1, 0).applyMatrix4(rot)
  const up = new Vector3(0, 0, 1).applyMatrix4(rot)
  return {
    dir: [-backward.x, -backward.y, -backward.z],
    up: [up.x, up.y, up.z],
  }
}

import { Euler, Vector3 } from 'three'

export type ViewVec3Like =
  | readonly [number, number, number]
  | { x?: number; y?: number; z?: number }
  | null
  | undefined

export type ResolvedViewTransform = Readonly<{
  rotation: readonly [number, number, number]
  target: readonly [number, number, number]
  identity: boolean
  signature: string
}>

const finite_or = (value: number | undefined, fallback: number): number =>
  typeof value === `number` && Number.isFinite(value) ? value : fallback

function normalize_vec3(
  value: ViewVec3Like,
  fallback: readonly [number, number, number],
): [number, number, number] {
  if (Array.isArray(value)) {
    return [
      finite_or(value[0], fallback[0]),
      finite_or(value[1], fallback[1]),
      finite_or(value[2], fallback[2]),
    ]
  }
  if (value && typeof value === `object`) {
    const object_value = value as { x?: number; y?: number; z?: number }
    return [
      finite_or(object_value.x, fallback[0]),
      finite_or(object_value.y, fallback[1]),
      finite_or(object_value.z, fallback[2]),
    ]
  }
  return [fallback[0], fallback[1], fallback[2]]
}

/** Resolve the exact Three.js group transform used by StructureScene:
 *  T(target) · Rxyz(rotation) · T(-target). */
export function resolve_view_transform(
  rotation: ViewVec3Like,
  target: ViewVec3Like,
): ResolvedViewTransform {
  const resolved_rotation = normalize_vec3(rotation, [0, 0, 0])
  const resolved_target = normalize_vec3(target, [0, 0, 0])
  const identity = resolved_rotation.every((value) => Math.abs(value) < 1e-12)
  return {
    rotation: resolved_rotation,
    target: resolved_target,
    identity,
    signature:
      `${resolved_rotation[0]},${resolved_rotation[1]},${resolved_rotation[2]}` +
      `@${resolved_target[0]},${resolved_target[1]},${resolved_target[2]}`,
  }
}

function euler_for(transform: ResolvedViewTransform): Euler {
  return new Euler(
    transform.rotation[0],
    transform.rotation[1],
    transform.rotation[2],
    `XYZ`,
  )
}

export function apply_view_transform_to_positions(
  input: Float32Array,
  transform: ResolvedViewTransform,
): Float32Array {
  if (transform.identity) return input
  const out = new Float32Array(input.length)
  const euler = euler_for(transform)
  const point = new Vector3()
  const [tx, ty, tz] = transform.target
  for (let idx = 0; idx + 2 < input.length; idx += 3) {
    point
      .set(input[idx] - tx, input[idx + 1] - ty, input[idx + 2] - tz)
      .applyEuler(euler)
    out[idx] = point.x + tx
    out[idx + 1] = point.y + ty
    out[idx + 2] = point.z + tz
  }
  return out
}

/** Lattice rows are direction vectors, so only R applies (no pivot translation). */
export function apply_view_transform_to_lattice(
  input: Float32Array,
  transform: ResolvedViewTransform,
): Float32Array {
  if (transform.identity) return input
  const out = new Float32Array(input.length)
  const euler = euler_for(transform)
  const vector = new Vector3()
  for (let idx = 0; idx + 2 < Math.min(input.length, 9); idx += 3) {
    vector.set(input[idx], input[idx + 1], input[idx + 2]).applyEuler(euler)
    out[idx] = vector.x
    out[idx + 1] = vector.y
    out[idx + 2] = vector.z
  }
  return out
}

/** Transform the scientific cell origin [0,0,0] with the same pivoted group. */
export function apply_view_transform_to_origin(
  transform: ResolvedViewTransform,
): [number, number, number] {
  if (transform.identity) return [0, 0, 0]
  const [tx, ty, tz] = transform.target
  const origin = new Vector3(-tx, -ty, -tz).applyEuler(euler_for(transform))
  return [origin.x + tx, origin.y + ty, origin.z + tz]
}

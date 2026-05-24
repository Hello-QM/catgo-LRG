import { Matrix4 } from 'three'
import type { Camera } from 'three'

const _vp = new Matrix4()

/** Pack proj * view (column-major, WebGPU-ready) followed by camera world
 *  position (vec3 + pad) into Float32Array(20). Three stores matrices
 *  column-major, so .elements is uploaded directly. Caller must have called
 *  camera.updateMatrixWorld() so matrixWorldInverse is current. */
export function pack_camera_uniform(camera: Camera): Float32Array {
  _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const out = new Float32Array(20)
  out.set(_vp.elements, 0)
  out[16] = camera.position.x
  out[17] = camera.position.y
  out[18] = camera.position.z
  out[19] = 0
  return out
}

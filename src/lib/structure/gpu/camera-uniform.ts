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

/** Pack view and projection matrices SEPARATELY (impostor spheres need both:
 *  view for the view-space billboard + ray-sphere, proj for clip-space depth).
 *  Layout (36 floats = 144 bytes, column-major, WebGPU-ready):
 *    [0..15]  view (camera.matrixWorldInverse.elements)
 *    [16..31] proj (camera.projectionMatrix.elements)
 *    [32..34] camera world position (vec3)
 *    [35]     pad
 *  Three stores matrices column-major, so .elements uploads directly. Caller
 *  must have called camera.updateMatrixWorld() so matrixWorldInverse is current. */
export function pack_camera_full(camera: Camera): Float32Array {
  const out = new Float32Array(36)
  out.set(camera.matrixWorldInverse.elements, 0)
  out.set(camera.projectionMatrix.elements, 16)
  out[32] = camera.position.x
  out[33] = camera.position.y
  out[34] = camera.position.z
  out[35] = 0
  return out
}

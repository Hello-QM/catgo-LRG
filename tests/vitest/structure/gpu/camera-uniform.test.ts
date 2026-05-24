import { describe, it, expect } from 'vitest'
import { PerspectiveCamera, Matrix4 } from 'three'
import { pack_camera_uniform } from '$lib/structure/gpu/camera-uniform'

describe(`pack_camera_uniform`, () => {
  it(`packs proj*view (16 floats) then camera world position (vec3 + pad) = 20 floats`, () => {
    const cam = new PerspectiveCamera(50, 1.5, 0.1, 1000)
    cam.position.set(1, 2, 3)
    cam.updateMatrixWorld(true) // refreshes matrixWorldInverse
    const out = pack_camera_uniform(cam)
    expect(out).toBeInstanceOf(Float32Array)
    expect(out.length).toBe(20)
    // last vec3 = camera world position
    expect(out[16]).toBeCloseTo(1)
    expect(out[17]).toBeCloseTo(2)
    expect(out[18]).toBeCloseTo(3)
    expect(out[19]).toBe(0) // pad
    // all matrix entries finite
    for (let i = 0; i < 16; i++) expect(Number.isFinite(out[i])).toBe(true)
  })

  it(`first 16 floats equal projectionMatrix * matrixWorldInverse (column-major)`, () => {
    const cam = new PerspectiveCamera(50, 1.5, 0.1, 1000)
    cam.position.set(5, 0, 10)
    cam.updateMatrixWorld(true)
    const out = pack_camera_uniform(cam)
    // recompute expected with three (column-major .elements)
    const vp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(vp.elements[i])
  })
})

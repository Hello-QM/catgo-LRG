import { describe, it, expect } from 'vitest'
import { PerspectiveCamera, Matrix4 } from 'three'
import { pack_camera_uniform, pack_camera_full } from '$lib/structure/gpu/camera-uniform'

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

describe(`pack_camera_full`, () => {
  it(`packs view (16) + proj (16) + cam_pos (vec3 + pad) = 36 floats`, () => {
    const cam = new PerspectiveCamera(50, 1.5, 0.1, 1000)
    cam.position.set(1, 2, 3)
    cam.updateMatrixWorld(true)
    const out = pack_camera_full(cam)
    expect(out).toBeInstanceOf(Float32Array)
    expect(out.length).toBe(36)
    // view block == matrixWorldInverse.elements (column-major)
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(cam.matrixWorldInverse.elements[i])
    // proj block == projectionMatrix.elements
    for (let i = 0; i < 16; i++) expect(out[16 + i]).toBeCloseTo(cam.projectionMatrix.elements[i])
    // cam_pos
    expect(out[32]).toBeCloseTo(1)
    expect(out[33]).toBeCloseTo(2)
    expect(out[34]).toBeCloseTo(3)
    expect(out[35]).toBe(0) // pad
  })

  it(`view and proj blocks are distinct (not the multiplied product)`, () => {
    const cam = new PerspectiveCamera(60, 2, 0.5, 500)
    cam.position.set(0, 0, 8)
    cam.updateMatrixWorld(true)
    const out = pack_camera_full(cam)
    const vp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    // the separated view block should NOT equal the combined proj*view product
    let differs = false
    for (let i = 0; i < 16; i++) if (Math.abs(out[i] - vp.elements[i]) > 1e-4) differs = true
    expect(differs).toBe(true)
  })
})

import { describe, expect, test, vi } from 'vitest'
import { SharedAtomColorTexture } from '$lib/structure/gpu/webgl2/shared-atom-color-texture'

describe(`SharedAtomColorTexture`, () => {
  test(`packs RGB into exact RGBA32F texels and skips identical topology`, () => {
    const colors = Float32Array.from([0.1, 0.2, 0.3, 0.7, 0.8, 0.9])
    const topology = { version: 4, atom_count: 2, colors }
    const resource = new SharedAtomColorTexture()

    expect(resource.update(topology)).toBe(true)
    expect([...(resource.texture.image.data as Float32Array).slice(0, 8)])
      .toEqual([colors[0], colors[1], colors[2], 1, colors[3], colors[4], colors[5], 1])
    expect(resource.update({ ...topology })).toBe(false)
    expect(resource.stats()).toMatchObject({
      uploads: 1,
      skipped_same_topology: 1,
    })
    resource.dispose()
  })

  test(`preserves supplied RGBA texels without quantization`, () => {
    const colors = Float32Array.from([0.1, 0.2, 0.3, 0.4])
    const resource = new SharedAtomColorTexture()

    resource.update({ version: 2, atom_count: 1, colors })

    expect([...(resource.texture.image.data as Float32Array).slice(0, 4)])
      .toEqual([...colors])
    resource.dispose()
  })

  test(`uploads a new color array even when the numeric version is reused`, () => {
    const resource = new SharedAtomColorTexture()
    resource.update({
      version: 1,
      atom_count: 1,
      colors: Float32Array.from([1, 0, 0]),
    })

    expect(resource.update({
      version: 1,
      atom_count: 1,
      colors: Float32Array.from([0, 1, 0]),
    })).toBe(true)
    expect(resource.stats().uploads).toBe(2)
    resource.dispose()
  })

  test(`rejects malformed RGB and RGBA color payloads`, () => {
    const resource = new SharedAtomColorTexture()

    expect(() => resource.update({
      version: 1,
      atom_count: 2,
      colors: new Float32Array(5),
    })).toThrow(RangeError)
    expect(() => resource.update({
      version: 2,
      atom_count: 2,
      colors: new Float32Array(9),
    })).toThrow(RangeError)
    expect(() => resource.update({
      version: 3,
      atom_count: 0,
      colors: new Float32Array(1),
    })).toThrow(RangeError)
    resource.dispose()
  })

  test(`restores the uploaded texture after context restoration`, () => {
    const resource = new SharedAtomColorTexture()

    expect(resource.restore()).toBe(false)
    resource.update({
      version: 1,
      atom_count: 1,
      colors: Float32Array.from([1, 0, 0]),
    })

    expect(resource.restore()).toBe(true)
    expect(resource.stats()).toMatchObject({ uploads: 1, restores: 1 })
    resource.dispose()
  })

  test(`disposes the texture only once`, () => {
    const resource = new SharedAtomColorTexture()
    const dispose = vi.spyOn(resource.texture, `dispose`)

    resource.dispose()
    resource.dispose()

    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

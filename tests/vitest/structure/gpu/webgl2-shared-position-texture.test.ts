import { describe, expect, test, vi } from 'vitest'
import type { FrameGeometry } from '$lib/structure/scene/render-packet'
import { SharedPositionTexture } from '$lib/structure/gpu/webgl2/shared-position-texture'

const owner = {}

function frame(
  frame_idx: number,
  positions_version: number,
  positions = new Float32Array([1, 2, 3, 4, 5, 6]),
): FrameGeometry {
  return {
    owner,
    frame_idx,
    positions_version,
    positions,
    lattice: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  }
}

describe(`SharedPositionTexture`, () => {
  test(`uploads each owner/frame/version identity exactly once`, () => {
    const shared = new SharedPositionTexture()
    const first = frame(0, 1)

    expect(shared.update(first)).toBe(true)
    expect(shared.update(first)).toBe(false)
    expect(shared.update({ ...first })).toBe(false)
    expect(shared.stats()).toMatchObject({
      uploads: 1,
      skipped_same_frame: 2,
    })

    expect(shared.update(frame(0, 2))).toBe(true)
    expect(shared.stats().uploads).toBe(2)
    shared.dispose()
  })

  test(`installs worker-packed RGBA without repacking`, () => {
    const shared = new SharedPositionTexture()
    const rgba = new Float32Array([1, 2, 3, 1, 4, 5, 6, 1])

    shared.update(frame(7, 1), rgba)

    expect(shared.texture.image.data).toBe(rgba)
    expect(shared.texture.image.width).toBe(2)
    expect(shared.texture.image.height).toBe(1)
    shared.dispose()
  })

  test(`compatibility path packs RGB positions into RGBA texels`, () => {
    const shared = new SharedPositionTexture()

    shared.update(frame(3, 1))

    expect(Array.from(shared.texture.image.data as Float32Array)).toEqual([
      1,
      2,
      3,
      1,
      4,
      5,
      6,
      1,
    ])
    shared.dispose()
  })

  test(`registers all consumers against the same texture identity`, () => {
    const shared = new SharedPositionTexture()
    const texture = shared.texture
    const release_atom = shared.register(`atom`)
    const release_bond = shared.register(`bond`)
    const release_picker = shared.register(`picker`)

    expect(shared.texture).toBe(texture)
    expect(shared.stats()).toMatchObject({
      atom_consumers: 1,
      bond_consumers: 1,
      picker_consumers: 1,
    })

    release_atom()
    release_atom()
    release_bond()
    release_picker()
    expect(shared.stats()).toMatchObject({
      atom_consumers: 0,
      bond_consumers: 0,
      picker_consumers: 0,
    })
    shared.dispose()
  })

  test(`dispose is idempotent`, () => {
    const shared = new SharedPositionTexture()
    const dispose = vi.spyOn(shared.texture, `dispose`)

    shared.dispose()
    shared.dispose()

    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

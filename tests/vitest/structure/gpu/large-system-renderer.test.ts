import { describe, it, expect } from 'vitest'
import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'
import {
  BOND_RENDER_WGSL,
  create_large_system_renderer,
} from '$lib/structure/gpu/large-system-renderer'

describe(`large-system bond render shader`, () => {
  it(`does not use show_image_atoms as a blanket full-bond promotion switch`, () => {
    expect(BOND_RENDER_WGSL).not.toContain(`image_full =`)
    expect(BOND_RENDER_WGSL).not.toContain(`supercell.lat0.w > 0.5`)
    expect(BOND_RENDER_WGSL).toContain(`let is_full = inside;`)
  })

  it(`reads the standard viewer's periodic-edge bond style`, () => {
    expect(BOND_RENDER_WGSL).toContain(`bond.radius_color.y > 0.5`)
    expect(BOND_RENDER_WGSL).toContain(`bond.radius_color.w > 0.5`)
    expect(BOND_RENDER_WGSL).toContain(`bond.style_extra.x`)
  })
})

// Device-gated: SKIPS in node (no navigator.gpu). Runs only where a real
// WebGPU device is available (e.g. a browser test runner with WebGPU enabled).
describe.skipIf(!globalThis.navigator?.gpu)(`create_large_system_renderer`, () => {
  it(`constructs, uploads a camera uniform, renders a clear pass without throwing`, async () => {
    const device = await acquire_webgpu_device()
    expect(device).not.toBeNull()
    if (!device) return

    const canvas = (typeof OffscreenCanvas !== `undefined`
      ? new OffscreenCanvas(64, 64)
      : document.createElement(`canvas`)) as unknown as HTMLCanvasElement

    const renderer = create_large_system_renderer(device, canvas)
    expect(() => {
      renderer.resize(64, 64)
      renderer.set_camera(new Float32Array(20))
      renderer.render()
      renderer.destroy()
    }).not.toThrow()
  })
})

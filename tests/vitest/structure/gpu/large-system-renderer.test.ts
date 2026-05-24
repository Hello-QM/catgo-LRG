import { describe, it, expect } from 'vitest'
import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'
import { create_large_system_renderer } from '$lib/structure/gpu/large-system-renderer'

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

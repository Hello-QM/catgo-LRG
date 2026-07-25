import { describe, it, expect } from 'vitest'
import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'
import {
  create_large_system_renderer,
  GIZMO_AXIS_HEX,
  GIZMO_NEG_AXIS_HEX,
  GIZMO_WGSL,
} from '$lib/structure/gpu/large-system-renderer'
import { axis_colors, neg_axis_colors } from '$lib/colors'

// The gizmo colors are HARDCODED in the GPU module (importing $lib/colors there
// would drag d3 + the palette JSONs into the lean renderer). These tests are the
// lockstep guarantee: if the app's axis colors change, they fail and point here.
describe(`gizmo color parity with $lib/colors`, () => {
  it(`GIZMO_AXIS_HEX matches axis_colors`, () => {
    expect(GIZMO_AXIS_HEX).toEqual(axis_colors.map(([, color]) => color))
  })
  it(`GIZMO_NEG_AXIS_HEX matches neg_axis_colors`, () => {
    expect(GIZMO_NEG_AXIS_HEX).toEqual(neg_axis_colors.map(([, color]) => color))
  })
  it(`the WGSL float literals match the hex constants`, () => {
    // Pull the two 3×vec3 color tables out of the shader source and compare each
    // channel to the hex value (display-space, so a plain /255 — no gamma).
    const tables = { AXIS_COLORS: GIZMO_AXIS_HEX, NEG_AXIS_COLORS: GIZMO_NEG_AXIS_HEX }
    for (const [table, hexes] of Object.entries(tables)) {
      const block = GIZMO_WGSL.match(
        new RegExp(`const ${table}[^;]*?\\(([\\s\\S]*?)\\);`),
      )?.[1]
      expect(block, `${table} present in GIZMO_WGSL`).toBeTruthy()
      const triples = [...(block as string).matchAll(
        /vec3<f32>\(([\d.]+), ([\d.]+), ([\d.]+)\)/g,
      )]
      expect(triples.length).toBe(3)
      triples.forEach((m, i) => {
        const hex = hexes[i]
        for (let ch = 0; ch < 3; ch++) {
          const expected = parseInt(hex.slice(1 + ch * 2, 3 + ch * 2), 16) / 255
          expect(
            Math.abs(parseFloat(m[1 + ch]) - expected),
            `${table}[${i}] channel ${ch} vs ${hex}`,
          ).toBeLessThan(0.002)
        }
      })
    }
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

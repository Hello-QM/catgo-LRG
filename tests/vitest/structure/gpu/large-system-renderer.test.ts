import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

// ── Mock-device tests (run in node): exercise the renderer's bond dirty-kind
// state machine without a GPU. The mock records nothing — assertions go
// through debug_bond_state(), whose counters the renderer maintains itself. ──

/** Minimal GPUDevice stand-in: every factory returns an inert object; the
 *  validation readback maps immediately and reads back zeros (raw_count 0,
 *  occupancy 0 ⇒ a complete candidate ⇒ publish). */
const make_mock_device = () => ({
  limits: { maxStorageBufferBindingSize: 1 << 27 },
  createBuffer: (desc: { size: number; label?: string }) => ({
    label: desc.label,
    size: desc.size,
    destroy: () => {},
    mapAsync: () => Promise.resolve(),
    getMappedRange: () => new ArrayBuffer(Math.max(desc.size, 8)),
    unmap: () => {},
  }),
  createTexture: (desc: { size: { width: number; height: number } }) => ({
    width: desc.size.width,
    height: desc.size.height,
    createView: () => ({}),
    destroy: () => {},
  }),
  createShaderModule: () => ({}),
  createBindGroupLayout: () => ({}),
  createPipelineLayout: () => ({}),
  createRenderPipeline: () => ({}),
  createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
  createBindGroup: () => ({}),
  createCommandEncoder: () => ({
    beginComputePass: () => ({
      setPipeline: () => {},
      setBindGroup: () => {},
      dispatchWorkgroups: () => {},
      end: () => {},
    }),
    beginRenderPass: () => ({
      setPipeline: () => {},
      setBindGroup: () => {},
      draw: () => {},
      drawIndirect: () => {},
      end: () => {},
    }),
    copyBufferToBuffer: () => {},
    copyTextureToBuffer: () => {},
    finish: () => ({}),
  }),
  queue: { writeBuffer: () => {}, submit: () => {} },
})

const make_mock_canvas = () => ({
  width: 8,
  height: 8,
  getContext: () => ({
    configure: () => {},
    unconfigure: () => {},
    getCurrentTexture: () => ({ createView: () => ({}) }),
  }),
})

/** Let the mapAsync-then-observe microtask/timer chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe(`large-system renderer bond dirty-kind split (mock device)`, () => {
  beforeAll(() => {
    vi.stubGlobal(`navigator`, {
      gpu: { getPreferredCanvasFormat: () => `bgra8unorm` },
    })
    vi.stubGlobal(`GPUShaderStage`, { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
    vi.stubGlobal(`GPUBufferUsage`, {
      MAP_READ: 1,
      MAP_WRITE: 2,
      COPY_SRC: 4,
      COPY_DST: 8,
      INDEX: 16,
      VERTEX: 32,
      UNIFORM: 64,
      STORAGE: 128,
      INDIRECT: 256,
      QUERY_RESOLVE: 512,
    })
    vi.stubGlobal(`GPUTextureUsage`, {
      COPY_SRC: 1,
      COPY_DST: 2,
      TEXTURE_BINDING: 4,
      STORAGE_BINDING: 8,
      RENDER_ATTACHMENT: 16,
    })
    vi.stubGlobal(`GPUMapMode`, { READ: 1, WRITE: 2 })
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it(`supercell changes only replica state`, async () => {
    const device = make_mock_device() as unknown as GPUDevice
    const canvas = make_mock_canvas() as unknown as HTMLCanvasElement
    const renderer = create_large_system_renderer(device, canvas)

    const n = 8
    const positions = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      positions[i * 3] = (i % 2) * 2.4
      positions[i * 3 + 1] = (Math.floor(i / 2) % 2) * 2.4
      positions[i * 3 + 2] = Math.floor(i / 4) * 2.4
    }
    const radii = new Float32Array(n).fill(0.5)
    const colors = new Float32Array(n * 3).fill(0.5)
    const covalent = new Float32Array(n).fill(0.76)
    const lattice = new Float32Array([20, 0, 0, 0, 20, 0, 0, 0, 20])
    const opts = { tolerance: 0.45, max_bond_dist: 3, min_dist: 0.1 }

    renderer.set_atoms(positions, radii, colors, n)
    renderer.set_bond_data(covalent, lattice, opts, true)
    renderer.render() // dispatches the candidate bond compute
    expect(renderer.debug_bond_state().dispatches.detect).toBe(1)

    await flush() // validation resolves complete ⇒ candidate publishes
    renderer.render() // publication frame: swap + indirect rebuild, NO re-detect
    const published = renderer.debug_bond_state()
    expect(published.graph_version).toBe(1)
    expect(published.dispatches.detect).toBe(1)

    // ── Replica-only change: GPU-supercell tiling must NOT invalidate the base
    // bond graph, and must NOT trigger a bond dispatch (design §8.2 item 4). ──
    renderer.set_supercell([2, 2, 2], lattice)
    renderer.render()
    await flush()
    expect(renderer.debug_bond_state().dispatches.detect).toBe(1)
    expect(renderer.debug_bond_state().graph_version).toBe(1)

    // ── A genuine graph change (positions) still re-dispatches. ──
    renderer.set_positions(positions, n)
    renderer.render()
    expect(renderer.debug_bond_state().dispatches.detect).toBe(2)

    renderer.destroy()
  })
})

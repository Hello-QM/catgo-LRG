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
 *  occupancy 0 ⇒ a complete candidate ⇒ publish) unless `validation_reads`
 *  injects per-map [raw_count, max_observed_occupancy] words (consumed in
 *  order; exhausted queue ⇒ zeros), letting tests drive the overflow-retry
 *  and allocation-limit paths the real shader would produce. */
const make_mock_device = (
  opts?: { validation_reads?: [number, number][] },
) => {
  // Observation counter: the renderer (re)builds its bond bind groups when it
  // SWAPS a published candidate in as the active graph, so a jump across one
  // render() call proves the publication swap actually ran.
  const counters = { bind_group: 0 }
  return {
    counters,
    limits: { maxStorageBufferBindingSize: 1 << 27 },
  createBuffer: (desc: { size: number; label?: string }) => ({
    label: desc.label,
    size: desc.size,
    destroy: () => {},
    mapAsync: () => Promise.resolve(),
    getMappedRange: () => {
      const buf = new ArrayBuffer(Math.max(desc.size, 8))
      if (desc.label === `large-system-bond-validation`) {
        const next = opts?.validation_reads?.shift()
        if (next) new Uint32Array(buf).set(next)
      }
      return buf
    },
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
  createBindGroup: () => {
    counters.bind_group += 1
    return {}
  },
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
  }
}

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

/** Upload the standard 8-atom cubic test scene (atoms + bond inputs) so a
 *  render() dispatches a candidate bond compute. */
const load_scene = (renderer: {
  set_atoms: (p: Float32Array, r: Float32Array, c: Float32Array, n: number) => void
  set_bond_data: (
    cov: Float32Array,
    lat: Float32Array,
    opts: { tolerance: number; max_bond_dist: number; min_dist: number },
    periodic: boolean,
  ) => void
}) => {
  const n = 8
  const positions = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    positions[i * 3] = (i % 2) * 2.4
    positions[i * 3 + 1] = (Math.floor(i / 2) % 2) * 2.4
    positions[i * 3 + 2] = Math.floor(i / 4) * 2.4
  }
  renderer.set_atoms(
    positions,
    new Float32Array(n).fill(0.5),
    new Float32Array(n * 3).fill(0.5),
    n,
  )
  renderer.set_bond_data(
    new Float32Array(n).fill(0.76),
    new Float32Array([20, 0, 0, 0, 20, 0, 0, 0, 20]),
    { tolerance: 0.45, max_bond_dist: 3, min_dist: 0.1 },
    true,
  )
}

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

  it(`packet replica-only version change preserves the published graph + capacity`, async () => {
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
    const lattice = new Float32Array([20, 0, 0, 0, 20, 0, 0, 0, 20])
    const topology = {
      version: 1,
      atom_count: n,
      site_ids: Uint32Array.from({ length: n }, (_, i) => i),
      atomic_numbers: new Uint8Array(n).fill(6),
      radii: new Float32Array(n).fill(0.5),
      colors: new Float32Array(n * 3).fill(0.5),
    }
    const frame = { owner: { tag: `t` }, frame_idx: 0, positions_version: 0, positions, lattice }
    const empty_images = {
      count: 0,
      base_sites: new Uint32Array(0),
      jimages: new Int8Array(0),
    }

    // Packet path for atoms/frame; GPU bond DETECTION still owns the graph
    // (no packet bond_graph) — set_bond_data provides the compute inputs.
    renderer.set_packet({
      topology,
      frame,
      replicas: {
        version: 1,
        dims: [1, 1, 1] as const,
        boundary_policy: `stub` as const,
        semantics: `visual-shared-base` as const,
      },
    }, empty_images)
    renderer.set_bond_data(
      new Float32Array(n).fill(0.76),
      lattice,
      { tolerance: 0.45, max_bond_dist: 3, min_dist: 0.1 },
      true,
    )
    renderer.render() // dispatches the candidate bond compute
    expect(renderer.debug_bond_state().dispatches.detect).toBe(1)
    await flush()
    renderer.render() // publication frame
    const published = renderer.debug_bond_state()
    expect(published.graph_version).toBe(1)
    const capacity = published.pairs.capacity
    const stride = published.grid.cell_stride

    // ── 2×2×2 replica-version bump: indirect refresh ONLY. The published
    // graph, its pair capacity, and the grid stride all survive untouched —
    // no bond dispatch (design §5 / §8.2 item 4). ──
    renderer.set_packet({
      topology,
      frame,
      replicas: {
        version: 2,
        dims: [2, 2, 2] as const,
        boundary_policy: `stub` as const,
        semantics: `visual-shared-base` as const,
      },
    }, empty_images)
    renderer.render()
    await flush()
    const after = renderer.debug_bond_state()
    expect(after.dispatches.detect).toBe(1)
    expect(after.graph_version).toBe(1)
    expect(after.pairs.capacity).toBe(capacity)
    expect(after.grid.cell_stride).toBe(stride)
    expect(renderer.get_diagnostics().ncells).toBe(8)

    // A genuine frame-version packet still re-detects.
    renderer.set_packet({
      topology,
      frame: { ...frame, frame_idx: 1, positions_version: 1 },
      replicas: {
        version: 2,
        dims: [2, 2, 2] as const,
        boundary_policy: `stub` as const,
        semantics: `visual-shared-base` as const,
      },
    }, empty_images)
    renderer.render()
    expect(renderer.debug_bond_state().dispatches.detect).toBe(2)

    renderer.destroy()
  })

  // ── Host wake signal (on_bond_work): a dirty-gated host suspends its rAF
  // loop on stable frames, but candidate publication / overflow retries
  // resolve ASYNC after the dispatching render — without a notification the
  // host would never call render() again on a static scene and the graph
  // would starve until the next camera move. ──

  it(`notifies host when a validated candidate awaits publication`, async () => {
    const raw_device = make_mock_device()
    const device = raw_device as unknown as GPUDevice
    const canvas = make_mock_canvas() as unknown as HTMLCanvasElement
    const renderer = create_large_system_renderer(device, canvas)
    const on_work = vi.fn()
    renderer.on_bond_work(on_work)

    load_scene(renderer)
    renderer.render() // dispatches the candidate; validation is now in flight
    expect(on_work).not.toHaveBeenCalled() // nothing resolved yet — no signal

    await flush() // zeros readback ⇒ complete candidate accepted ⇒ publish pends
    expect(on_work).toHaveBeenCalledTimes(1)
    expect(renderer.debug_bond_state().graph_version).toBe(1) // accepted…

    // …but the buffer swap runs in the WOKEN render: the bond bind groups are
    // re-pointed at the newly active graph (rebuild observed on the mock).
    const before_swap = raw_device.counters.bind_group
    renderer.render()
    expect(raw_device.counters.bind_group).toBeGreaterThan(before_swap)

    // Published + nothing pending ⇒ a further render swaps nothing.
    const settled = raw_device.counters.bind_group
    renderer.render()
    expect(raw_device.counters.bind_group).toBe(settled)

    renderer.destroy()
  })

  it(`fires the callback when an overflow retry re-arms the graph`, async () => {
    // First run overflows the 1024-pair capacity (raw 3000), the rerun with the
    // grown capacity completes (raw 500). Occupancy 0 = the direct (gridless)
    // path an 8-atom scene routes to.
    const device = make_mock_device({
      validation_reads: [[3000, 0], [500, 0]],
    }) as unknown as GPUDevice
    const canvas = make_mock_canvas() as unknown as HTMLCanvasElement
    const renderer = create_large_system_renderer(device, canvas)
    const on_work = vi.fn()
    renderer.on_bond_work(on_work)

    load_scene(renderer)
    renderer.render() // dispatch #1
    await flush() // raw 3000 > capacity 1024 ⇒ retry armed ⇒ host must rerun
    expect(on_work).toHaveBeenCalledTimes(1)
    const after_retry = renderer.debug_bond_state()
    expect(after_retry.overflow.pairs).toBe(true)
    expect(after_retry.pairs.capacity).toBe(4096) // nextPow2(3000)
    expect(after_retry.graph_version).toBe(0) // incomplete run never published

    renderer.render() // the woken frame reruns with the grown capacity
    expect(renderer.debug_bond_state().dispatches.detect).toBe(2)
    await flush() // complete this time ⇒ publication pends ⇒ notify again
    expect(on_work).toHaveBeenCalledTimes(2)

    renderer.render() // publication frame
    expect(renderer.debug_bond_state().graph_version).toBe(1)

    renderer.destroy()
  })

  it(`fires the callback on the allocation-limit terminal state`, async () => {
    // nextPow2(20M) pairs exceeds maxStorageBufferBindingSize/12 ⇒ terminal:
    // the active graph is kept, but the host still gets one settling wake.
    const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
    const device = make_mock_device({
      validation_reads: [[20_000_000, 0]],
    }) as unknown as GPUDevice
    const canvas = make_mock_canvas() as unknown as HTMLCanvasElement
    const renderer = create_large_system_renderer(device, canvas)
    const on_work = vi.fn()
    renderer.on_bond_work(on_work)

    load_scene(renderer)
    renderer.render()
    await flush()
    expect(on_work).toHaveBeenCalledTimes(1)
    expect(renderer.debug_bond_state().graph_version).toBe(0)
    expect(warn).toHaveBeenCalledOnce()

    renderer.render() // settling frame: nothing pends, nothing re-dispatches
    await flush()
    expect(on_work).toHaveBeenCalledTimes(1)
    expect(renderer.debug_bond_state().dispatches.detect).toBe(1)

    renderer.destroy()
    warn.mockRestore()
  })

  it(`does not storm the callback when idle`, async () => {
    const device = make_mock_device() as unknown as GPUDevice
    const canvas = make_mock_canvas() as unknown as HTMLCanvasElement
    const renderer = create_large_system_renderer(device, canvas)
    const on_work = vi.fn()
    renderer.on_bond_work(on_work)

    load_scene(renderer)
    renderer.render() // dispatch
    await flush() // validation ⇒ publication pends ⇒ one signal
    renderer.render() // publish
    expect(on_work).toHaveBeenCalledTimes(1)

    // A published graph with nothing pending must NOT keep a host loop awake:
    // repeated renders fire no callback and dispatch no compute.
    for (let i = 0; i < 5; i++) renderer.render()
    await flush()
    expect(on_work).toHaveBeenCalledTimes(1)
    expect(renderer.debug_bond_state().dispatches.detect).toBe(1)

    renderer.destroy()
  })
})

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'
import {
  BOND_RENDER_BYTES,
  CELL_BYTES,
  create_large_system_renderer,
  GIZMO_AXIS_HEX,
  GIZMO_NEG_AXIS_HEX,
  GIZMO_WGSL,
  normalize_bond_style,
  pack_bond_render_uniform,
  pack_cell_uniform,
  LATTICE_VECTOR_BYTES,
  pack_lattice_vector_uniform,
} from '$lib/structure/gpu/large-system-renderer'
import { srgb_channel_to_linear } from '$lib/structure/rendering/background'
import type { ResolvedVisualShading } from '$lib/structure/rendering/visual-state'
import { axis_colors, neg_axis_colors } from '$lib/colors'
import type { TypedBondInput } from '$lib/structure/workers/bond-worker-runtime'

describe(`large-system bond visual-style helpers`, () => {
  it(`normalizes viewer style inputs at the adapter boundary`, () => {
    expect(normalize_bond_style({
      radius: 0.09,
      incomplete_edge_mode: true,
      incomplete_edge_length_scale: 0.15,
      hide_incomplete_bonds: true,
      periodic_bond_opacity: 0.35,
    })).toEqual({
      radius: 0.09,
      incomplete_edge_mode: true,
      incomplete_edge_length_scale: 0.15,
      hide_incomplete_bonds: true,
      periodic_bond_opacity: 0.35,
    })

    expect(normalize_bond_style({
      radius: Number.NaN,
      incomplete_edge_length_scale: -4,
      periodic_bond_opacity: 7,
    })).toEqual({
      radius: 0.07,
      incomplete_edge_mode: false,
      incomplete_edge_length_scale: 0.05,
      hide_incomplete_bonds: false,
      periodic_bond_opacity: 1,
    })
  })

  it(`keeps the 80-byte bond ABI while reserving the obsolete color lanes`, () => {
    const packed = pack_bond_render_uniform(
      new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      normalize_bond_style({
        radius: 0.09,
        incomplete_edge_mode: true,
        incomplete_edge_length_scale: 0.15,
        hide_incomplete_bonds: true,
        periodic_bond_opacity: 0.35,
      }),
    )
    expect(packed.byteLength).toBe(BOND_RENDER_BYTES)
    const expected = [
      1, 2, 3, 0,
      4, 5, 6, 0,
      7, 8, 9, 0,
      0.09, 1, 0.15, 1,
      0.35, 0, 0, 0,
    ]
    expected.forEach((value, idx) => expect(packed[idx]).toBeCloseTo(value))
  })
})

describe(`large-system cell transform packing`, () => {
  it(`packs rotated lattice, transformed origin, then color`, () => {
    const packed = pack_cell_uniform(
      new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      [10, 11, 12],
      [0.2, 0.3, 0.4],
    )
    expect(packed.byteLength).toBe(CELL_BYTES)
    const expected = [
      1, 2, 3, 0,
      4, 5, 6, 0,
      7, 8, 9, 0,
      10, 11, 12, 0,
      0.2, 0.3, 0.4, 1,
    ]
    expected.forEach((value, idx) => expect(packed[idx]).toBeCloseTo(value))
  })

  it(`packs ordinary lattice-vector origin, colors, and geometry scale`, () => {
    const packed = pack_lattice_vector_uniform(
      [10, 11, 12],
      [[1, 0, 0], [0, 0.2158605, 0], [0, 0, 1]],
      2,
    )
    expect(packed.byteLength).toBe(LATTICE_VECTOR_BYTES)
    const expected = [
      10, 11, 12, 0,
      1, 0, 0, 1,
      0, 0.2158605, 0, 1,
      0, 0, 1, 1,
      0.1, 0.35, 0.5, 0.85,
    ]
    expected.forEach((value, idx) => expect(packed[idx]).toBeCloseTo(value))
  })
})

// The lean shared gizmo module owns the palette and generates the GPU literals;
// these assertions retain compatibility coverage for the renderer's old exports.
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

  it(`mirrors the ordinary sphere gizmo endpoint, line, and back-face semantics`, () => {
    expect(GIZMO_WGSL).toContain(`const HEAD_DIST : f32 = 1.3;`)
    expect(GIZMO_WGSL).toContain(`const LINE_DIST : f32 = HEAD_DIST - POS_R;`)
    expect(GIZMO_WGSL).toContain(`acc = over(acc, AXIS_COLORS[i], cov(d));`)
    expect(GIZMO_WGSL).toContain(`let positive_front = depth[i] >= 0.0;`)
    expect(GIZMO_WGSL).toContain(
      `let negative_alpha = select(NEG_ALPHA, NEG_ALPHA * 0.5, positive_front);`,
    )
    expect(GIZMO_WGSL).toContain(
      `acc = over(acc, sprite_color, alpha * ball_cov);`,
    )
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
  // Observation counters: bind_group jumps prove a publication swap ran;
  // submits/writes count EVERY queue command so the device-loss tests can
  // assert the renderer submits NOTHING after `lost` resolves.
  const counters = { bind_group: 0, submits: 0, writes: 0 }
  const buffers = new Map<string, {
    label?: string
    size: number
    destroy_calls: number
    destroy: () => void
    mapAsync: () => Promise<void>
    getMappedRange: () => ArrayBuffer
    unmap: () => void
  }>()
  const write_records: {
    label?: string
    buffer_offset: number
    bytes: Uint8Array
  }[] = []
  const render_pipeline_descs: GPURenderPipelineDescriptor[] = []
  const render_pipeline_labels: string[] = []
  const clear_values: { r: number; g: number; b: number; a: number }[] = []
  // Controllable device-loss promise, mirroring GPUDevice.lost. Resolving it
  // drives the renderer's one-per-lease loss subscription.
  let resolve_lost: (info: { reason: string }) => void = () => {}
  const lost = new Promise<{ reason: string }>((resolve) => {
    resolve_lost = resolve
  })
  return {
    counters,
    buffers,
    write_records,
    render_pipeline_descs,
    render_pipeline_labels,
    clear_values,
    lost,
    resolve_lost,
    limits: { maxStorageBufferBindingSize: 1 << 27 },
  createBuffer: (desc: { size: number; label?: string }) => {
    const buffer = {
      label: desc.label,
      size: desc.size,
      destroy_calls: 0,
      destroy: () => {
        buffer.destroy_calls += 1
      },
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
    }
    if (desc.label) buffers.set(desc.label, buffer)
    return buffer
  },
  createTexture: (desc: { size: { width: number; height: number } }) => ({
    width: desc.size.width,
    height: desc.size.height,
    createView: () => ({}),
    destroy: () => {},
  }),
  createShaderModule: () => ({}),
  createBindGroupLayout: () => ({}),
  createPipelineLayout: () => ({}),
  createRenderPipeline: (desc: GPURenderPipelineDescriptor) => {
    render_pipeline_descs.push(desc)
    return { label: desc.label }
  },
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
    beginRenderPass: (desc?: {
      colorAttachments?: {
        clearValue?: { r: number; g: number; b: number; a: number }
      }[]
    }) => {
      const clear = desc?.colorAttachments?.[0]?.clearValue
      if (clear) clear_values.push({ ...clear })
      return {
        setPipeline: (pipeline: { label?: string }) => {
          if (pipeline.label) render_pipeline_labels.push(pipeline.label)
        },
        setBindGroup: () => {},
        draw: () => {},
        drawIndirect: () => {},
        end: () => {},
      }
    },
    copyBufferToBuffer: () => {},
    copyTextureToBuffer: () => {},
    finish: () => ({}),
  }),
  queue: {
    writeBuffer: (
      buffer: { label?: string },
      buffer_offset: number,
      data: ArrayBuffer | ArrayBufferView,
      data_offset = 0,
      size?: number,
    ) => {
      counters.writes += 1
      const data_buffer = ArrayBuffer.isView(data) ? data.buffer : data
      const view_offset = ArrayBuffer.isView(data) ? data.byteOffset : 0
      const available = ArrayBuffer.isView(data) ? data.byteLength : data.byteLength
      const byte_length = size ?? (available - data_offset)
      write_records.push({
        label: buffer.label,
        buffer_offset,
        bytes: Uint8Array.from(
          new Uint8Array(data_buffer, view_offset + data_offset, byte_length),
        ),
      })
    },
    submit: () => {
      counters.submits += 1
    },
  },
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
    opts: { tolerance: number; max_bond_dist: number; min_bond_dist: number },
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
    { tolerance: 0.45, max_bond_dist: 3, min_bond_dist: 0.1 },
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

  it(`encodes a linear background exactly once into the render-pass clear value`, () => {
    const device = make_mock_device()
    const renderer = create_large_system_renderer(
      device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const display_mid = 128 / 255
    const linear_mid = srgb_channel_to_linear(display_mid)

    renderer.set_background([linear_mid, linear_mid, linear_mid])
    renderer.render()

    expect(device.clear_values).toHaveLength(1)
    const clear = device.clear_values[0]
    expect(clear.r).toBeCloseTo(display_mid, 6)
    expect(clear.g).toBeCloseTo(display_mid, 6)
    expect(clear.b).toBeCloseTo(display_mid, 6)
    expect(clear.a).toBe(1)
    // Missing clear-value encoding would leave the much darker linear value;
    // a second encoding would be brighter than display_mid. The exact display
    // assertion above therefore locks both failure modes.
    expect(clear.r).not.toBeCloseTo(linear_mid, 3)

    renderer.destroy()
  })

  it(`uses 4x coverage without stippled A2C for atoms and bonds`, () => {
    const device = make_mock_device()
    const renderer = create_large_system_renderer(
      device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )

    for (const label of [
      `large-system-impostor-pipeline`,
      `large-system-bond-render-pipeline`,
      `large-system-bond-decorator-pipeline`,
    ]) {
      const desc = device.render_pipeline_descs.find((entry) => entry.label === label)
      expect(desc, `${label} exists`).toBeDefined()
      expect(desc?.multisample?.count).toBe(4)
      expect(desc?.multisample?.alphaToCoverageEnabled).toBe(false)
      const target = Array.from(desc?.fragment?.targets ?? [])[0]
      expect(target?.blend?.color).toEqual({
        srcFactor: `src-alpha`,
        dstFactor: `one-minus-src-alpha`,
        operation: `add`,
      })
    }
    const decorator = device.render_pipeline_descs.find(
      (entry) => entry.label === `large-system-bond-decorator-pipeline`,
    )
    expect(decorator?.depthStencil?.depthWriteEnabled).toBe(true)
    expect(decorator?.depthStencil?.depthCompare).toBe(`less`)

    renderer.destroy()
  })

  it(`draws ordinary-style lattice vector arrows through their own world-space pipeline`, () => {
    const device = make_mock_device()
    const renderer = create_large_system_renderer(
      device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    renderer.set_cell(
      new Float32Array([10, 0, 0, 0, 11, 0, 0, 0, 12]),
      true,
      [0.2, 0.3, 0.4],
      [1, 2, 3],
      {
        show: true,
        width_scale: 2,
        colors: [[1, 0, 0], [0, 0.2158605, 0], [0, 0, 1]],
      },
    )
    renderer.render()

    expect(device.render_pipeline_labels).toContain(
      `large-system-lattice-vector-pipeline`,
    )
    const vector_write = device.write_records.find(
      ({ label }) => label === `large-system-lattice-vector-uniform`,
    )
    expect(vector_write?.bytes.byteLength).toBe(LATTICE_VECTOR_BYTES)
    const vector_pipeline = device.render_pipeline_descs.find(
      ({ label }) => label === `large-system-lattice-vector-pipeline`,
    )
    expect(vector_pipeline?.primitive?.topology).toBe(`triangle-list`)
    expect(vector_pipeline?.depthStencil).toMatchObject({
      depthWriteEnabled: true,
      depthCompare: `less`,
    })

    renderer.destroy()
  })

  it(`packs all 24 shared shading floats and skips structurally equal uploads`, () => {
    const device = make_mock_device()
    const renderer = create_large_system_renderer(
      device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const shading: ResolvedVisualShading = {
      light_dir: [0.11, -0.22, 0.33],
      is_ortho: true,
      ambient: 0.44,
      directional: 1.55,
      spec_strength: 0.66,
      roughness: 0.77,
      metalness: 0.88,
      render_style: 2,
      outline: 0.99,
      bond_outline: 0.57,
      depth_cueing: 0.12,
      depth_near: 3.25,
      depth_far: 47.5,
      depth_bg: [0.14, 0.25, 0.36],
      toon_shadow_threshold: 0.31,
      toon_highlight_threshold: 0.82,
      toon_shadow_brightness: 0.43,
    }

    // Ignore constructor seeding and observe only the explicit shared-state upload.
    device.write_records.length = 0
    expect(renderer.set_shading(shading)).toBe(true)
    const shading_writes = device.write_records.filter(
      ({ label }) => label === `large-system-shading`,
    )
    expect(shading_writes).toHaveLength(1)
    expect(shading_writes[0].buffer_offset).toBe(0)
    const payload = new Float32Array(
      shading_writes[0].bytes.buffer,
      shading_writes[0].bytes.byteOffset,
      shading_writes[0].bytes.byteLength / 4,
    )
    const expected = [
      0.11, -0.22, 0.33, 1,
      0.44, 1.55, 0.66, 0.77,
      0.88, 2, 0.99, 0.12,
      3.25, 47.5, 0.57, 0,
      0.14, 0.25, 0.36, 0,
      0.31, 0.82, 0.43, 0,
    ]
    expect(payload).toHaveLength(24)
    expected.forEach((value, index) => expect(payload[index]).toBeCloseTo(value))

    const equal_copy: ResolvedVisualShading = {
      ...shading,
      light_dir: [...shading.light_dir],
      depth_bg: [...shading.depth_bg],
    }
    expect(renderer.set_shading(equal_copy)).toBe(false)
    expect(device.write_records.filter(
      ({ label }) => label === `large-system-shading`,
    )).toHaveLength(1)

    const changed_background: ResolvedVisualShading = {
      ...equal_copy,
      depth_bg: [equal_copy.depth_bg[0], equal_copy.depth_bg[1], 0.37],
    }
    expect(renderer.set_shading(changed_background)).toBe(true)
    expect(device.write_records.filter(
      ({ label }) => label === `large-system-shading`,
    )).toHaveLength(2)

    renderer.destroy()
    renderer.destroy()
    expect(device.buffers.get(`large-system-shading`)?.destroy_calls).toBe(1)
    expect(device.buffers.get(`large-system-supercell`)?.destroy_calls).toBe(1)
  })

  it(`detects in-place caller tuple mutations without breaking equal no-ops`, () => {
    const device = make_mock_device()
    const renderer = create_large_system_renderer(
      device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const shading: ResolvedVisualShading = {
      light_dir: [0.11, -0.22, 0.33],
      is_ortho: false,
      ambient: 0.44,
      directional: 1.55,
      spec_strength: 0.66,
      roughness: 0.77,
      metalness: 0.88,
      render_style: 2,
      outline: 0.99,
      bond_outline: 0.57,
      depth_cueing: 0.12,
      depth_near: 3.25,
      depth_far: 47.5,
      depth_bg: [0.14, 0.25, 0.36],
      toon_shadow_threshold: 0.31,
      toon_highlight_threshold: 0.82,
      toon_shadow_brightness: 0.43,
    }

    device.write_records.length = 0
    expect(renderer.set_shading(shading)).toBe(true)
    expect(renderer.set_shading(shading)).toBe(false)

    shading.light_dir[0] = 0.51
    shading.depth_bg[2] = 0.71
    expect(renderer.set_shading(shading)).toBe(true)

    const shading_writes = device.write_records.filter(
      ({ label }) => label === `large-system-shading`,
    )
    expect(shading_writes).toHaveLength(2)
    const payload = new Float32Array(
      shading_writes[1].bytes.buffer,
      shading_writes[1].bytes.byteOffset,
      shading_writes[1].bytes.byteLength / 4,
    )
    expect(payload[0]).toBeCloseTo(0.51)
    expect(payload[14]).toBeCloseTo(0.57)
    expect(payload[18]).toBeCloseTo(0.71)

    expect(renderer.set_shading({
      ...shading,
      light_dir: [...shading.light_dir],
      depth_bg: [...shading.depth_bg],
    })).toBe(false)
    expect(device.write_records.filter(
      ({ label }) => label === `large-system-shading`,
    )).toHaveLength(2)

    renderer.destroy()
  })

  it(`destroys renderer-owned uniforms exactly once after device loss`, async () => {
    const device = make_mock_device()
    const renderer = create_large_system_renderer(
      device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )

    device.resolve_lost({ reason: `destroyed` })
    await flush()
    expect(renderer.get_diagnostics().device_lost).toBe(true)

    renderer.destroy()
    renderer.destroy()
    expect(device.buffers.get(`large-system-shading`)?.destroy_calls).toBe(1)
    expect(device.buffers.get(`large-system-supercell`)?.destroy_calls).toBe(1)
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
    const opts = { tolerance: 0.45, max_bond_dist: 3, min_bond_dist: 0.1 }

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
      { tolerance: 0.45, max_bond_dist: 3, min_bond_dist: 0.1 },
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

  it(`clears an old active graph and rejects its in-flight result on a topology owner swap`, async () => {
    const raw = make_mock_device({
      validation_reads: [[2, 0], [3, 0], [4, 0]],
    })
    const renderer = create_large_system_renderer(
      raw as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
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
    const owner_a = { tag: `owner-a` }
    const owner_b = { tag: `owner-b` }
    const replicas = {
      version: 1,
      dims: [1, 1, 1] as const,
      boundary_policy: `stub` as const,
      semantics: `visual-shared-base` as const,
    }
    const empty_images = {
      count: 0,
      base_sites: new Uint32Array(0),
      jimages: new Int8Array(0),
    }
    const set_bond_data = () => renderer.set_bond_data(
      new Float32Array(n).fill(0.76),
      lattice,
      { tolerance: 0.45, max_bond_dist: 3, min_bond_dist: 0.1 },
      true,
    )

    renderer.set_packet({
      topology,
      frame: {
        owner: owner_a,
        frame_idx: 0,
        positions_version: 0,
        positions,
        lattice,
      },
      replicas,
    }, empty_images)
    set_bond_data()
    renderer.render()
    await flush()
    renderer.render()
    expect(renderer.get_diagnostics().active_bond_count).toBe(2)
    expect(renderer.debug_bond_state().graph_version).toBe(1)

    // Start another A-owned candidate, then replace the topology before its
    // validation microtask resolves.
    renderer.set_packet({
      topology,
      frame: {
        owner: owner_a,
        frame_idx: 1,
        positions_version: 1,
        positions,
        lattice,
      },
      replicas,
    }, empty_images)
    renderer.render()
    expect(renderer.debug_bond_state().dispatches.detect).toBe(2)

    renderer.set_packet({
      topology: { ...topology, version: 2 },
      frame: {
        owner: owner_b,
        frame_idx: 0,
        positions_version: 0,
        positions,
        lattice,
      },
      replicas,
    }, empty_images)
    set_bond_data()

    // The Build-style owner swap must blank the old index graph immediately;
    // waiting for B's async candidate is preferable to drawing G(A) @ frame B.
    expect(renderer.get_diagnostics().active_bond_count).toBe(0)
    await flush()
    expect(renderer.debug_bond_state().graph_version).toBe(1)

    renderer.render()
    expect(renderer.debug_bond_state().dispatches.detect).toBe(3)
    await flush()
    renderer.render()
    expect(renderer.get_diagnostics().active_bond_count).toBe(4)
    expect(renderer.debug_bond_state().graph_version).toBe(2)

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

  // ── Bonds T6: transactional device loss + rust-wasm routing ──────────────

  it(`submits no commands after device loss`, async () => {
    const raw = make_mock_device()
    const device = raw as unknown as GPUDevice
    const canvas = make_mock_canvas() as unknown as HTMLCanvasElement
    const renderer = create_large_system_renderer(device, canvas)

    load_scene(renderer)
    renderer.render() // dispatch
    await flush() // validation ⇒ publication pends
    renderer.render() // publish
    expect(raw.counters.submits).toBeGreaterThan(0)

    raw.resolve_lost({ reason: `destroyed` })
    await flush()
    const submits = raw.counters.submits
    const writes = raw.counters.writes

    // EVERY channel is gated after loss: draws, per-frame uploads, replica
    // changes, selection, camera, resize — and picks resolve as a miss without
    // ever encoding a pass.
    renderer.render()
    renderer.set_positions(new Float32Array(24), 8)
    renderer.set_supercell([2, 2, 2], new Float32Array(9))
    renderer.set_selection([1, 2])
    renderer.set_camera_full(new Float32Array(36))
    renderer.resize(32, 32)
    const pick = await renderer.pick(1, 1)
    renderer.render()
    await flush()

    expect(pick.kind).toBe(`miss`)
    expect(raw.counters.submits).toBe(submits)
    expect(raw.counters.writes).toBe(writes)
    expect(renderer.get_diagnostics().device_lost).toBe(true)

    renderer.destroy()
  })

  it(`notifies fallback exactly once`, async () => {
    const raw = make_mock_device()
    const canvas = make_mock_canvas() as unknown as HTMLCanvasElement
    const renderer = create_large_system_renderer(
      raw as unknown as GPUDevice,
      canvas,
    )
    const on_lost = vi.fn()
    renderer.on_device_lost(on_lost)

    load_scene(renderer)
    renderer.render()
    expect(on_lost).not.toHaveBeenCalled() // healthy device — no signal

    raw.resolve_lost({ reason: `destroyed` })
    await flush()
    expect(on_lost).toHaveBeenCalledTimes(1)

    // Later renders / flushes never re-notify.
    renderer.render()
    renderer.render()
    await flush()
    expect(on_lost).toHaveBeenCalledTimes(1)

    // The one notification slot is consumed: a handler registered after the
    // notification fired must not produce a second fallback.
    const late = vi.fn()
    renderer.on_device_lost(late)
    await flush()
    expect(late).not.toHaveBeenCalled()
    renderer.destroy()

    // If NO handler was registered when the device died, the first
    // registration is notified immediately — still exactly once in total.
    const raw2 = make_mock_device()
    const r2 = create_large_system_renderer(
      raw2 as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    raw2.resolve_lost({ reason: `destroyed` })
    await flush()
    const cb2 = vi.fn()
    r2.on_device_lost(cb2)
    expect(cb2).toHaveBeenCalledTimes(1)
    r2.on_device_lost(cb2) // re-registration: already consumed, no double-fire
    await flush()
    expect(cb2).toHaveBeenCalledTimes(1)
    r2.destroy()
  })

  it(`retains the last valid graph owner during fallback`, async () => {
    const raw = make_mock_device()
    const canvas = make_mock_canvas() as unknown as HTMLCanvasElement
    const renderer = create_large_system_renderer(
      raw as unknown as GPUDevice,
      canvas,
    )

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
    const frame = {
      owner: { tag: `t` },
      frame_idx: 0,
      positions_version: 0,
      positions,
      lattice,
    }
    const replicas = {
      version: 1,
      dims: [2, 2, 2] as const,
      boundary_policy: `stub` as const,
      semantics: `visual-shared-base` as const,
    }
    const empty_images = {
      count: 0,
      base_sites: new Uint32Array(0),
      jimages: new Int8Array(0),
    }
    // PACKET-supplied bond graph ⇒ the packet producer owns the draw graph.
    const bond_graph = {
      version: 3,
      pairs: Uint32Array.from([0, 1, 2, 3]),
      jimages: new Int8Array(6),
      kinds: new Uint8Array(2),
      strengths: new Float32Array([1, 1]),
    }
    renderer.set_packet(
      { topology: { ...topology, bond_graph }, frame, replicas },
      empty_images,
    )
    renderer.render()
    await flush()
    const before = renderer.get_diagnostics()
    expect(before.ownership).toBe(`packet`)
    expect(before.packet_graph_active).toBe(true)
    expect(before.active_bond_count).toBe(2)

    raw.resolve_lost({ reason: `destroyed` })
    await flush()

    // Loss stops submissions but RETAINS the owner + scene data — the
    // WebGL2+WASM fallback takes over the SAME packet source; nothing here may
    // clear it mid-swap.
    const after = renderer.get_diagnostics()
    expect(after.device_lost).toBe(true)
    expect(after.ownership).toBe(`packet`)
    expect(after.packet_graph_active).toBe(true)
    expect(after.active_bond_count).toBe(2)
    expect(after.packet_versions).toEqual(before.packet_versions)
    expect(after.base_count).toBe(n)
    expect(after.ncells).toBe(8)

    // Post-loss channel writes must not clear the retained owner either: a
    // graphless packet (which would normally EXIT packet-graph mode) and a
    // legacy setter (which would normally claim legacy ownership) are both
    // gated during fallback.
    renderer.set_packet(
      { topology: { ...topology, version: 2 }, frame, replicas },
      empty_images,
    )
    renderer.set_atoms(
      positions,
      new Float32Array(n).fill(0.5),
      new Float32Array(n * 3).fill(0.5),
      n,
    )
    const still = renderer.get_diagnostics()
    expect(still.ownership).toBe(`packet`)
    expect(still.packet_graph_active).toBe(true)
    expect(still.active_bond_count).toBe(2)
    expect(still.packet_versions).toEqual(before.packet_versions)

    renderer.destroy()
  })

  it(`routes policy-refused dispatches through compute_bonds_typed without changing the graph owner`, async () => {
    const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
    const raw = make_mock_device()
    const fake = vi.fn((_input: TypedBondInput) =>
      Promise.resolve({
        backend: `rust-wasm-scalar` as const,
        elapsed_ms: 1,
        table: {
          pairs: Uint32Array.from([0, 1]),
          images: Int8Array.from([0, 0, 1]),
          lengths: Float32Array.from([2.4]),
          strengths: Float32Array.from([1]),
        },
      })
    )
    const renderer = create_large_system_renderer(
      raw as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
      { compute_bonds_typed: fake },
    )
    const on_work = vi.fn()
    renderer.on_bond_work(on_work)

    // 2000 atoms (> the 1024 direct cap) in a PERIODIC THIN cell (b-axis 2 Å <
    // max_bond_dist 3 Å ⇒ grid dim 1 < 3 ⇒ plan refuses the GPU grid) — the
    // Task-1 policy demands the rust-wasm backend for this shape.
    const n = 2000
    const positions = new Float32Array(n * 3)
    const thin = new Float32Array([40, 0, 0, 0, 2, 0, 0, 0, 40])
    const topology = {
      version: 1,
      atom_count: n,
      site_ids: Uint32Array.from({ length: n }, (_, i) => i),
      atomic_numbers: new Uint8Array(n).fill(14),
      radii: new Float32Array(n).fill(0.5),
      colors: new Float32Array(n * 3).fill(0.5),
    }
    renderer.set_packet({
      topology,
      frame: {
        owner: { tag: `t` },
        frame_idx: 0,
        positions_version: 0,
        positions,
        lattice: thin,
      },
      replicas: {
        version: 1,
        dims: [1, 1, 1] as const,
        boundary_policy: `stub` as const,
        semantics: `visual-shared-base` as const,
      },
    }, {
      count: 0,
      base_sites: new Uint32Array(0),
      jimages: new Int8Array(0),
    })
    renderer.set_bond_data(
      new Float32Array(n).fill(0.76),
      thin,
      { tolerance: 0.45, max_bond_dist: 3, min_bond_dist: 0.1 },
      true,
    )
    renderer.render()

    // The GPU compute never dispatched; the typed worker got the exact inputs.
    expect(renderer.debug_bond_state().dispatches.detect).toBe(0)
    expect(renderer.get_diagnostics().required_backend).toBe(`periodic-thin-cell`)
    expect(fake).toHaveBeenCalledTimes(1)
    const input = fake.mock.calls[0][0]
    expect(input.atomic_numbers).toBe(topology.atomic_numbers)
    expect(input.positions.length).toBe(n * 3)
    expect(input.pbc).toEqual([true, true, true])
    expect(input.lattice_matrix).toEqual([[40, 0, 0], [0, 2, 0], [0, 0, 40]])
    expect(input.options).toEqual({
      tolerance: 0.45,
      max_bond_dist: 3,
      min_bond_dist: 0.1,
    })

    await flush() // typed table resolves ⇒ ACTIVE graph upload + host wake
    expect(on_work).toHaveBeenCalled()
    const diag = renderer.get_diagnostics()
    expect(diag.active_bond_count).toBe(1) // typed graph IS the draw graph now
    expect(diag.ownership).toBe(`packet`) // owner unchanged…
    expect(diag.packet_graph_active).toBe(false) // …and NOT a packet graph

    // A woken render is an indirect refresh only — still no GPU detect, and no
    // second worker dispatch for an unchanged graph.
    renderer.render()
    await flush()
    expect(renderer.debug_bond_state().dispatches.detect).toBe(0)
    expect(fake).toHaveBeenCalledTimes(1)

    renderer.destroy()
    warn.mockRestore()
  })
})

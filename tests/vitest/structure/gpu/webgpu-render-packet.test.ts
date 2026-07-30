import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AnyStructure } from '$lib'
import {
  BOND_RENDER_BYTES,
  create_large_system_renderer,
} from '$lib/structure/gpu/large-system-renderer'
import { build_logical_radii } from '$lib/structure/gpu/radius-lut'
import { VISUAL_RADIUS_SCALE } from '$lib/structure/rendering/visual-state'
import { create_render_packet_builder } from '$lib/structure/scene/render-packet-builder'
import type {
  BaseBondGraph,
  ImageInstanceTable,
  RenderPacket,
} from '$lib/structure/scene/render-packet'

// ── Recording mock device ────────────────────────────────────────────────────
// Extends the pattern of large-system-renderer.test.ts's mock with observable
// side channels: every queue.writeBuffer is recorded (label + a byte copy), all
// render-pass draw/drawIndirect calls are recorded per pass, compute passes are
// recorded by label, and the pick readback consumes injectable ids — so the
// packet upload paths can be asserted byte-for-byte without a GPU.

type Write = { label: string; bytes: Uint8Array }
type RenderPipelineDescriptor = {
  label?: string
  vertex?: { constants?: Record<string, number | boolean> }
  fragment?: {
    targets?: {
      blend?: {
        color: { srcFactor: string; dstFactor: string; operation: string }
        alpha: { srcFactor: string; dstFactor: string; operation: string }
      }
    }[]
  }
  depthStencil?: {
    depthWriteEnabled?: boolean
    depthCompare?: string
  }
  multisample?: {
    count?: number
    alphaToCoverageEnabled?: boolean
  }
}
type RenderCommand =
  | {
      kind: `draw`
      pipeline?: string
      vertex_count: number
      instance_count: number
      first_vertex: number
      first_instance: number
    }
  | { kind: `drawIndirect`; pipeline?: string }
type Pass = {
  label: string
  draws: [number, number][]
  indirect: number
  commands: RenderCommand[]
}
type RecordedLayout = {
  label?: string
  entries: readonly {
    binding: number
    visibility: number
    buffer?: { type?: string }
  }[]
}
type RecordedBindGroup = {
  label?: string
  entries: readonly {
    binding: number
    resource: { buffer?: { label?: string; size?: number } }
  }[]
}

const to_bytes = (
  data: ArrayBuffer | ArrayBufferView,
  offset = 0,
  size?: number,
): Uint8Array => {
  if (data instanceof ArrayBuffer) {
    const len = size ?? data.byteLength - offset
    return new Uint8Array(data.slice(offset, offset + len))
  }
  const view = data as ArrayBufferView & { BYTES_PER_ELEMENT?: number }
  const bpe = view.BYTES_PER_ELEMENT ?? 1
  const start = view.byteOffset + offset * bpe
  const len = size !== undefined ? size * bpe : view.byteLength - offset * bpe
  return new Uint8Array(view.buffer.slice(start, start + len))
}

const make_recording_device = (opts?: {
  pick_reads?: number[]
  validation_reads?: [number, number][]
  validation_maps?: Promise<void>[]
  graph_reads?: number[][]
}) => {
  const writes: Write[] = []
  const passes: Pass[] = []
  const compute_passes: string[] = []
  const created: string[] = []
  const shader_sources: Record<string, string> = {}
  const bind_group_layouts: RecordedLayout[] = []
  const bind_groups: RecordedBindGroup[] = []
  const render_pipelines: RenderPipelineDescriptor[] = []
  const device = {
    limits: { maxStorageBufferBindingSize: 1 << 27 },
    createBuffer: (desc: { size: number; label?: string }) => {
      created.push(desc.label ?? `?`)
      return {
        label: desc.label,
        size: desc.size,
        destroy: () => {},
        mapAsync: () => {
          if (desc.label === `large-system-bond-validation`) {
            return opts?.validation_maps?.shift() ?? Promise.resolve()
          }
          return Promise.resolve()
        },
        getMappedRange: () => {
          const buf = new ArrayBuffer(Math.max(desc.size, 8))
          if (desc.label === `large-system-pick-readback`) {
            const next = opts?.pick_reads?.shift()
            if (next !== undefined) new Uint32Array(buf)[0] = next
          } else if (desc.label === `large-system-bond-validation`) {
            const next = opts?.validation_reads?.shift()
            if (next) new Uint32Array(buf).set(next)
          } else if (desc.label === `large-system-bond-graph-readback`) {
            const next = opts?.graph_reads?.shift()
            if (next) new Uint32Array(buf).set(next)
          }
          return buf
        },
        unmap: () => {},
      }
    },
    createTexture: (desc: { size: { width: number; height: number } }) => ({
      width: desc.size.width,
      height: desc.size.height,
      createView: () => ({}),
      destroy: () => {},
    }),
    createShaderModule: (desc: { label?: string; code?: string }) => {
      if (desc.label && desc.code) shader_sources[desc.label] = desc.code
      return {}
    },
    createBindGroupLayout: (desc: RecordedLayout) => {
      bind_group_layouts.push(desc)
      return {}
    },
    createPipelineLayout: () => ({}),
    createRenderPipeline: (desc: RenderPipelineDescriptor) => {
      render_pipelines.push(desc)
      return { label: desc.label }
    },
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: (desc: RecordedBindGroup) => {
      bind_groups.push(desc)
      return {}
    },
    createCommandEncoder: () => ({
      beginComputePass: (desc?: { label?: string }) => {
        compute_passes.push(desc?.label ?? `?`)
        return {
          setPipeline: () => {},
          setBindGroup: () => {},
          dispatchWorkgroups: () => {},
          end: () => {},
        }
      },
      beginRenderPass: (desc?: { label?: string }) => {
        const pass: Pass = {
          label: desc?.label ?? `frame`,
          draws: [],
          indirect: 0,
          commands: [],
        }
        passes.push(pass)
        let pipeline: string | undefined
        return {
          setPipeline: (next: { label?: string }) => {
            pipeline = next.label
          },
          setBindGroup: () => {},
          draw: (
            verts: number,
            instances = 1,
            first_vertex = 0,
            first_instance = 0,
          ) => {
            pass.draws.push([verts, instances])
            pass.commands.push({
              kind: `draw`,
              pipeline,
              vertex_count: verts,
              instance_count: instances,
              first_vertex,
              first_instance,
            })
          },
          drawIndirect: () => {
            pass.indirect += 1
            pass.commands.push({ kind: `drawIndirect`, pipeline })
          },
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
        _buffer_offset: number,
        data: ArrayBuffer | ArrayBufferView,
        data_offset?: number,
        size?: number,
      ) => {
        writes.push({ label: buffer.label ?? `?`, bytes: to_bytes(data, data_offset ?? 0, size) })
      },
      submit: () => {},
    },
  }
  const clear = () => {
    writes.length = 0
    passes.length = 0
    compute_passes.length = 0
    created.length = 0
    bind_groups.length = 0
  }
  return {
    device,
    writes,
    passes,
    compute_passes,
    created,
    shader_sources,
    bind_group_layouts,
    bind_groups,
    render_pipelines,
    clear,
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

const writes_to = (writes: Write[], label: string) => writes.filter((w) => w.label === label)
const flush = () => new Promise((resolve_flush) => setTimeout(resolve_flush, 0))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// ── Packet fixtures ──────────────────────────────────────────────────────────

const N = 8

const make_positions = (shift = 0): Float32Array => {
  const positions = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) {
    positions[i * 3] = (i % 2) * 2.4 + shift
    positions[i * 3 + 1] = (Math.floor(i / 2) % 2) * 2.4
    positions[i * 3 + 2] = Math.floor(i / 4) * 2.4
  }
  return positions
}

const make_topology = (bond_graph?: BaseBondGraph): RenderPacket[`topology`] => ({
  version: 1,
  atom_count: N,
  site_ids: Uint32Array.from({ length: N }, (_, i) => i),
  atomic_numbers: new Uint8Array(N).fill(6),
  radii: new Float32Array(N).fill(0.5),
  colors: new Float32Array(N * 3).fill(0.5),
  bond_graph,
})

const OWNER = { tag: `packet-owner` }

const make_base_structure = (n = N, a = 20) => ({
  sites: Array.from({ length: n }, (_, idx) => ({
    species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
    abc: [idx / Math.max(n, 1), 0, 0],
    xyz: [idx * 1.4, 0, 0],
    label: `C`,
    properties: {},
  })),
  lattice: {
    matrix: [[a, 0, 0], [0, a, 0], [0, 0, a]],
    pbc: [true, true, true],
    a,
    b: a,
    c: a,
    alpha: 90,
    beta: 90,
    gamma: 90,
    volume: a ** 3,
  },
})

const make_frame = (
  over?: Partial<RenderPacket[`frame`]>,
): RenderPacket[`frame`] => ({
  owner: OWNER,
  frame_idx: 0,
  positions_version: 0,
  positions: make_positions(),
  lattice: new Float32Array([20, 0, 0, 0, 20, 0, 0, 0, 20]),
  ...over,
})

const make_replicas = (
  over?: Partial<RenderPacket[`replicas`]>,
): RenderPacket[`replicas`] => ({
  version: 1,
  dims: [1, 1, 1],
  boundary_policy: `stub`,
  semantics: `visual-shared-base`,
  ...over,
})

const EMPTY_IMAGES: ImageInstanceTable = {
  count: 0,
  base_sites: new Uint32Array(0),
  jimages: new Int8Array(0),
}

const make_images = (
  rows: readonly (readonly [number, number, number, number])[],
): ImageInstanceTable => ({
  count: rows.length,
  base_sites: Uint32Array.from(rows, ([site]) => site),
  jimages: Int8Array.from(rows.flatMap(([, jx, jy, jz]) => [jx, jy, jz])),
})

const pack_signed_jimage = (jx: number, jy: number, jz: number) =>
  (jx + 128) | ((jy + 128) << 8) | ((jz + 128) << 16)

describe(`webgpu renderer consumes render packets (mock device)`, () => {
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

  it(`uploads normalized bond style once without invalidating graph ownership`, () => {
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const before = renderer.get_diagnostics()
    rec.clear()

    renderer.set_bond_style({
      radius: 0.09,
      incomplete_edge_mode: true,
      incomplete_edge_length_scale: 0.15,
      hide_incomplete_bonds: true,
      periodic_bond_opacity: 0.35,
    })

    const writes = writes_to(rec.writes, `large-system-bond-render-uniform`)
    expect(writes).toHaveLength(1)
    expect(writes[0].bytes.byteLength).toBe(BOND_RENDER_BYTES)
    const style_words = new Float32Array(writes[0].bytes.buffer).slice(12)
    const expected_style_words = [
      0.09, 1, 0.15, 1,
      0.35, 0, 0, 0,
    ]
    expected_style_words.forEach(
      (value, idx) => expect(style_words[idx]).toBeCloseTo(value),
    )
    expect(renderer.get_diagnostics().ownership).toBe(before.ownership)
    expect(renderer.debug_bond_state().dispatches).toEqual(before.bonds.dispatches)

    rec.clear()
    renderer.set_bond_style({
      radius: 0.09,
      incomplete_edge_mode: true,
      incomplete_edge_length_scale: 0.15,
      hide_incomplete_bonds: true,
      periodic_bond_opacity: 0.35,
    })
    expect(writes_to(rec.writes, `large-system-bond-render-uniform`)).toHaveLength(0)

    renderer.destroy()
  })

  it(`stores clamped ghost opacity only in the spare supercell lane`, () => {
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const before = renderer.get_diagnostics()
    rec.clear()

    renderer.set_ghost_opacity(0.35)
    expect(rec.writes.map(({ label }) => label)).toEqual([
      `large-system-supercell`,
    ])
    let rows = new Float32Array(rec.writes[0].bytes.buffer, 16, 12)
    expect(rows[3]).toBe(0) // lat0.w remains the boundary policy
    expect(rows[7]).toBeCloseTo(0.35) // lat1.w is the spare ghost-opacity lane
    expect(renderer.get_diagnostics().ownership).toBe(before.ownership)
    expect(renderer.debug_bond_state().dispatches).toEqual(
      before.bonds.dispatches,
    )

    rec.clear()
    renderer.set_ghost_opacity(0.35)
    renderer.set_ghost_opacity(Number.NaN)
    expect(rec.writes).toHaveLength(0)

    renderer.set_ghost_opacity(9)
    rows = new Float32Array(rec.writes[0].bytes.buffer, 16, 12)
    expect(rows[7]).toBe(1)

    rec.clear()
    renderer.set_ghost_opacity(-4)
    rows = new Float32Array(rec.writes[0].bytes.buffer, 16, 12)
    expect(rows[7]).toBe(0)

    rec.clear()
    renderer.set_shading({
      light_dir: [0, 0, 1],
      is_ortho: false,
      ambient: 0.61,
      directional: 2.2,
      spec_strength: 1,
      roughness: 0.2,
      metalness: 0,
      render_style: 0,
      outline: 0,
      bond_outline: 0,
      depth_cueing: 0,
      depth_near: 0,
      depth_far: 10,
      depth_bg: [0, 0, 0],
      toon_shadow_threshold: 0.3,
      toon_highlight_threshold: 0.97,
      toon_shadow_brightness: 0.5,
    })
    expect(writes_to(rec.writes, `large-system-shading`)[0]?.bytes.byteLength).toBe(96)

    renderer.destroy()
  })

  it(`draws sparse ghosts and ghost-complete bonds through translucent passes`, () => {
    const graph: BaseBondGraph = {
      version: 1,
      pairs: new Uint32Array([0, 0]),
      jimages: new Int8Array([1, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    renderer.set_packet({
      topology: make_topology(graph),
      frame: make_frame(),
      replicas: make_replicas({ boundary_policy: `ghost-images` }),
    }, make_images([[0, 1, 0, 0]]))
    renderer.set_ghost_opacity(0.25)
    renderer.set_bond_style({ periodic_bond_opacity: 0.25 })
    renderer.render()

    const atom_ghost = rec.render_pipelines.find(
      ({ label }) => label === `large-system-impostor-ghost-pipeline`,
    )
    expect(atom_ghost?.fragment?.targets?.[0]?.blend).toEqual({
      color: {
        srcFactor: `src-alpha`,
        dstFactor: `one-minus-src-alpha`,
        operation: `add`,
      },
      alpha: {
        srcFactor: `one`,
        dstFactor: `one-minus-src-alpha`,
        operation: `add`,
      },
    })
    expect(atom_ghost?.depthStencil).toMatchObject({
      depthWriteEnabled: false,
      depthCompare: `less`,
    })
    expect(atom_ghost?.multisample).toEqual({
      count: 4,
      alphaToCoverageEnabled: false,
    })

    const bond_ghost = rec.render_pipelines.find(
      ({ label }) => label === `large-system-bond-render-ghost-pipeline`,
    )
    expect(bond_ghost?.fragment?.targets?.[0]?.blend).toEqual(
      atom_ghost?.fragment?.targets?.[0]?.blend,
    )
    expect(bond_ghost?.depthStencil).toMatchObject({
      depthWriteEnabled: false,
      depthCompare: `less`,
    })
    expect(bond_ghost?.multisample).toEqual({
      count: 4,
      alphaToCoverageEnabled: false,
    })
    expect(bond_ghost?.vertex?.constants).toMatchObject({ ghost_pass: 1 })
    expect(
      rec.render_pipelines.find(
        ({ label }) => label === `large-system-bond-render-pipeline`,
      )?.vertex?.constants,
    ).toMatchObject({ ghost_pass: 0 })

    const atom_shader = rec.shader_sources[`large-system-impostor`]
    expect(atom_shader).toContain(
      `let alpha = coverage * in.opacity;`,
    )
    expect(atom_shader).toContain(`out.color = vec4<f32>(rgb, alpha);`)
    expect(atom_shader).toContain(
      `if (!(coverage > 0.0))`,
    )
    expect(atom_shader).not.toContain(`d <= r`)
    expect(atom_shader).toContain(
      `if (!(ndc_depth >= 0.0 && ndc_depth <= 1.0))`,
    )
    const bond_shader = rec.shader_sources[`large-system-bond-render`]
    expect(bond_shader).toContain(`override ghost_pass : u32 = 0u;`)
    expect(bond_shader).toContain(
      `let wrong_pass = (ghost_pass != 0u) != ghost_complete;`,
    )
    expect(bond_shader).toContain(
      `effective_inside,
  );`,
    )
    expect(bond_shader).toContain(
      `let is_ortho = shading.light_dir.w > 0.5;`,
    )
    expect(bond_shader).toContain(`let rc = ro - pa;`)
    expect(bond_shader).toContain(`let n_raw = cross(rd, cylinder_axis);`)
    expect(bond_shader).toContain(`let side_distance = abs(dot(rc, n));`)
    expect(bond_shader).toContain(`fn cylinder_coverage(radius : f32, distance : f32)`)
    expect(bond_shader).toContain(`let fw_raw = fwidth(distance);`)
    expect(bond_shader).toContain(`let body_coverage = cylinder_coverage(r, body_edge_distance);`)
    expect(bond_shader).toContain(`let cap_coverage = cylinder_coverage(r, cap_edge_distance);`)
    expect(bond_shader).toContain(`@location(5) vpos : vec3<f32>`)
    expect(bond_shader).not.toContain(`@interpolate(perspective, sample)`)
    expect(bond_shader).not.toContain(`qb * qb - 4.0 * qa * qc`)
    expect(bond_shader).not.toContain(`if (!found)`)
    expect(bond_shader).toContain(`let alpha = coverage * in.opacity;`)
    expect(bond_shader).toContain(`if (!(alpha > 0.0))`)
    expect(bond_shader).toContain(
      `if (!(depth >= 0.0 && depth <= 1.0))`,
    )
    expect(bond_shader).not.toContain(`fwidth(measure)`)
    expect(bond_shader).not.toContain(`let oc = -pa;`)

    const pick_shader = rec.shader_sources[`large-system-pick`]
    expect(pick_shader).toContain(
      `let is_ortho = camera.cam_pos.w > 0.5;`,
    )
    expect(pick_shader).toContain(`vec3<f32>(in.vpos.xy, 0.0)`)
    expect(pick_shader).toContain(`vec3<f32>(0.0, 0.0, -1.0)`)

    const frame = rec.passes.find(({ label }) => label === `frame`)
    expect(frame?.commands).toEqual([
      {
        kind: `drawIndirect`,
        pipeline: `large-system-bond-render-pipeline`,
      },
      {
        kind: `draw`,
        pipeline: `large-system-bond-decorator-pipeline`,
        vertex_count: 6,
        instance_count: 1,
        first_vertex: 0,
        first_instance: 0,
      },
      {
        kind: `draw`,
        pipeline: `large-system-impostor-pipeline`,
        vertex_count: 4,
        instance_count: N,
        first_vertex: 0,
        first_instance: 0,
      },
      {
        kind: `drawIndirect`,
        pipeline: `large-system-bond-render-ghost-pipeline`,
      },
      {
        kind: `draw`,
        pipeline: `large-system-impostor-ghost-pipeline`,
        vertex_count: 4,
        instance_count: 1,
        first_vertex: 0,
        first_instance: N,
      },
      {
        kind: `draw`,
        pipeline: `large-system-gizmo-pipeline`,
        vertex_count: 4,
        instance_count: 1,
        first_vertex: 0,
        first_instance: 0,
      },
    ])
    expect(frame?.indirect).toBe(2)

    renderer.destroy()
  })

  it(`binds authoritative atom colors to the bond vertex stage`, () => {
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )

    const layout = rec.bind_group_layouts.find(
      ({ label }) => label === `large-system-bond-render-bgl`,
    )
    expect(layout).toBeDefined()
    expect(layout?.entries.find(({ binding }) => binding === 6)).toMatchObject({
      binding: 6,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: `uniform` },
    })
    expect(layout?.entries.find(({ binding }) => binding === 7)).toMatchObject({
      binding: 7,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: `read-only-storage` },
    })

    renderer.destroy()
  })

  it(`rebinds bond endpoint colors after authoritative color-buffer growth`, () => {
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const graph: BaseBondGraph = {
      version: 1,
      pairs: new Uint32Array([0, 1]),
      jimages: new Int8Array([0, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    const packet = {
      topology: {
        ...make_topology(graph),
        atom_count: 2,
        site_ids: new Uint32Array([0, 1]),
        atomic_numbers: new Uint8Array([6, 8]),
        radii: new Float32Array([0.5, 0.6]),
        colors: new Float32Array([1, 0, 0, 0, 0, 1]),
      },
      frame: make_frame({
        positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      }),
      replicas: make_replicas(),
    } satisfies RenderPacket
    renderer.set_packet(packet, EMPTY_IMAGES)
    renderer.set_bond_data(
      new Float32Array([0.76, 0.66]),
      packet.frame.lattice,
      { tolerance: 0.45, min_bond_dist: 0.1, max_bond_dist: 3 },
      true,
    )

    const first_group = rec.bind_groups.filter(
      ({ label }) => label === `large-system-bond-render-bg`,
    ).at(-1)
    const first_colors = first_group?.entries.find(
      ({ binding }) => binding === 7,
    )?.resource.buffer
    expect(first_colors?.label).toBe(`large-system-colors`)

    rec.clear()
    const grown_count = 20
    const grown_colors = Float32Array.from(
      { length: grown_count * 3 },
      (_, idx) => (idx + 1) / 100,
    )
    const grown: RenderPacket = {
      topology: {
        version: 2,
        atom_count: grown_count,
        site_ids: Uint32Array.from({ length: grown_count }, (_, idx) => idx),
        atomic_numbers: new Uint8Array(grown_count).fill(6),
        radii: new Float32Array(grown_count).fill(0.5),
        colors: grown_colors,
        bond_graph: graph,
      },
      frame: make_frame({
        positions_version: 2,
        positions: new Float32Array(grown_count * 3),
      }),
      replicas: make_replicas(),
    }
    renderer.set_packet(grown, EMPTY_IMAGES)

    const second_group = rec.bind_groups.filter(
      ({ label }) => label === `large-system-bond-render-bg`,
    ).at(-1)
    const second_colors = second_group?.entries.find(
      ({ binding }) => binding === 7,
    )?.resource.buffer
    expect(second_colors?.label).toBe(`large-system-colors`)
    expect(second_colors).not.toBe(first_colors)
    expect(second_colors?.size).toBeGreaterThanOrEqual(grown_colors.byteLength)
    const uploads = writes_to(rec.writes, `large-system-colors`)
    expect(uploads).toHaveLength(1)
    expect(Array.from(new Float32Array(uploads[0].bytes.buffer))).toEqual(
      Array.from(grown_colors),
    )

    renderer.destroy()
  })

  it(`uses hard endpoint halves and the WebGL bond studio-lighting contract`, () => {
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const shader = rec.shader_sources[`large-system-bond-render`]
    expect(shader).toContain(
      `@group(0) @binding(7) var<storage, read> colors : array<f32>;`,
    )
    expect(shader).toContain(`fn atom_color(i : u32) -> vec3<f32>`)
    expect(shader).toContain(`let color_a = atom_color(a);`)
    expect(shader).toContain(`let color_b = atom_color(b);`)
    expect(shader).toContain(
      `var color_start = select(color_b, color_a, half == 0u);`,
    )
    expect(shader).toContain(`var color_end = color_start;`)
    expect(shader).toContain(`if (is_full) {`)
    expect(shader).toContain(
      `color_end = select(color_a, color_b, half == 0u);`,
    )
    expect(shader).toContain(
      `let base_color = select(
    in.color_end,
    in.color_start,
    axial < 0.5,
  );`,
    )
    expect(shader).not.toContain(
      `mix(in.color_start, in.color_end, axial)`,
    )
    expect(shader).not.toContain(`bond.style1.yzw`)

    expect(shader).toContain(`fn studio_env(n : vec3<f32>, key_dir : vec3<f32>)`)
    expect(shader).toContain(`fn aces_tonemap(x : vec3<f32>)`)
    expect(shader).toContain(`64.0`)
    expect(shader).toContain(`pow(1.0 - NdotV, 5.0)`)
    expect(shader).toContain(`mix(vec3<f32>(1.0), base_color, 0.55)`)
    expect(shader).toContain(`let ambient_intensity = 0.8;`)
    expect(shader).toContain(`let directional_intensity = 0.3;`)
    expect(shader).toContain(
      `let exposure = ambient_intensity + directional_intensity * 0.5; // fixed 0.95`,
    )
    expect(shader).toContain(`final_color = aces_tonemap(final_color);`)

    const aces = shader.indexOf(`final_color = aces_tonemap(final_color);`)
    const srgb = shader.indexOf(`var rgb = linear_to_srgb(final_color);`)
    const fog = shader.indexOf(`if (shading.params1.w > 0.0)`)
    expect(aces).toBeGreaterThan(-1)
    expect(srgb).toBeGreaterThan(aces)
    expect(fog).toBeGreaterThan(srgb)

    renderer.destroy()
  })

  it(`keeps logical radii in RenderPacket until a renderer adapter boundary`, () => {
    const structure = make_base_structure(3, 10) as unknown as AnyStructure
    const logical = build_logical_radii(structure.sites, { atom_radius: 1.5 })
    const packet = create_render_packet_builder().build({
      structure,
      radii: logical,
    })

    expect(packet.topology.radii).toBe(logical)
    expect(Array.from(packet.topology.radii)).toEqual(Array.from(logical))
    for (let idx = 0; idx < logical.length; idx++) {
      expect(logical[idx] * VISUAL_RADIUS_SCALE).toBeLessThan(logical[idx])
    }
  })

  it(`replica-only packet change updates indirect counts without a bond dispatch`, () => {
    const bond_graph: BaseBondGraph = {
      version: 1,
      pairs: new Uint32Array([0, 1]),
      jimages: new Int8Array([0, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const base: RenderPacket = {
      topology: make_topology(bond_graph),
      frame: make_frame(),
      replicas: make_replicas(),
    }
    renderer.set_packet(base, EMPTY_IMAGES)
    renderer.render()
    // Packet-supplied graph: the indirect-args build runs, the bond-detect
    // compute NEVER dispatches.
    expect(rec.compute_passes).toContain(`large-system-bond-indirect`)
    expect(rec.compute_passes).not.toContain(`large-system-bond-compute`)

    rec.clear()
    // Replica-only version bump: 2×2×2 tiling. Same topology/frame objects.
    renderer.set_packet(
      { ...base, replicas: make_replicas({ version: 2, dims: [2, 2, 2] }) },
      EMPTY_IMAGES,
    )
    renderer.render()
    expect(rec.compute_passes).toContain(`large-system-bond-indirect`)
    expect(rec.compute_passes).not.toContain(`large-system-bond-compute`)
    // No frame re-upload on a replica-only change.
    expect(writes_to(rec.writes, `large-system-positions`)).toHaveLength(0)
    // The supercell uniform carries the new dims (+ base_count).
    const sc = writes_to(rec.writes, `large-system-supercell`).at(-1)
    expect(sc).toBeDefined()
    const dims = new Uint32Array(sc!.bytes.buffer, 0, 4)
    expect([...dims]).toEqual([2, 2, 2, N])
    // The indirect cfg's ncells slot moved to 8 (the whole replica cost).
    const cfg = writes_to(rec.writes, `large-system-indirect-cfg`).at(-1)
    expect(cfg).toBeDefined()
    expect(new Uint32Array(cfg!.bytes.buffer)[2]).toBe(8)
    // The atom draw covers all replicas.
    const frame_pass = rec.passes.find((p) => p.label === `frame`)
    expect(frame_pass?.draws[0]).toEqual([4, N * 8])

    expect(renderer.get_diagnostics().ncells).toBe(8)
    renderer.destroy()
  })

  it(`frame-version packet uploads only base positions and the current lattice`, () => {
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const topology = make_topology()
    const replicas = make_replicas()
    renderer.set_packet({ topology, frame: make_frame(), replicas }, EMPTY_IMAGES)

    rec.clear()
    // Variable-cell frame advance: new positions + a new lattice.
    const moved = new Float32Array([21, 0, 0, 0, 20, 0, 0, 0, 20])
    renderer.set_packet({
      topology,
      frame: make_frame({
        frame_idx: 1,
        positions_version: 1,
        positions: make_positions(0.1),
        lattice: moved,
      }),
      replicas,
    }, EMPTY_IMAGES)

    // Base positions upload: exactly 3N floats.
    const pos = writes_to(rec.writes, `large-system-positions`)
    expect(pos).toHaveLength(1)
    expect(pos[0].bytes.byteLength).toBe(N * 3 * 4)
    // The CURRENT frame lattice reaches the replica-offset uniform. Rows pack
    // as vec3 + pad, so the diagonal lands at padded indices 0 / 5 / 10.
    const sc = writes_to(rec.writes, `large-system-supercell`).at(-1)
    expect(sc).toBeDefined()
    const rows = new Float32Array(sc!.bytes.buffer, 16, 12)
    expect(rows[0]).toBe(21)
    expect(rows[5]).toBe(20)
    expect(rows[10]).toBe(20)
    // Topology buffers are untouched on a frame-only change.
    expect(writes_to(rec.writes, `large-system-radii`)).toHaveLength(0)
    expect(writes_to(rec.writes, `large-system-colors`)).toHaveLength(0)
    // No atom-buffer reallocation either.
    expect(rec.created).not.toContain(`large-system-positions`)

    rec.clear()
    // Fixed-cell frame advance: ONLY the positions upload — no lattice churn.
    renderer.set_packet({
      topology,
      frame: make_frame({
        frame_idx: 2,
        positions_version: 2,
        positions: make_positions(0.2),
        lattice: new Float32Array(moved),
      }),
      replicas,
    }, EMPTY_IMAGES)
    expect(writes_to(rec.writes, `large-system-positions`)).toHaveLength(1)
    expect(writes_to(rec.writes, `large-system-supercell`)).toHaveLength(0)
    expect(writes_to(rec.writes, `large-system-radii`)).toHaveLength(0)
    expect(writes_to(rec.writes, `large-system-colors`)).toHaveLength(0)

    renderer.destroy()
  })

  it(`uses the ordinary packet image table instead of graph-derived ghosts`, () => {
    const graph: BaseBondGraph = {
      version: 1,
      // Site 4 can sit anywhere in the base cell: the graph, not decorative
      // boundary metadata, proves its +a self-image endpoint needs a ghost.
      pairs: new Uint32Array([4, 4]),
      jimages: new Int8Array([1, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    const decorative_images = make_images([[4, 1, 0, 0]])
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    renderer.set_packet({
      topology: make_topology(graph),
      frame: make_frame(),
      replicas: make_replicas({ boundary_policy: `ghost-images` }),
    }, decorative_images)

    const sites = writes_to(rec.writes, `large-system-ghost-sites`)
    expect(sites).toHaveLength(1)
    expect([...new Uint32Array(sites[0].bytes.buffer)]).toEqual([4])
    const imgs = writes_to(rec.writes, `large-system-ghost-images`)
    expect(imgs).toHaveLength(1)
    expect([...new Uint32Array(imgs[0].bytes.buffer)]).toEqual([
      pack_signed_jimage(1, 0, 0),
    ])

    renderer.render()
    const frame_pass = rec.passes.find((p) => p.label === `frame`)
    expect(frame_pass?.commands).toContainEqual({
      kind: `draw`,
      pipeline: `large-system-impostor-pipeline`,
      vertex_count: 4,
      instance_count: N,
      first_vertex: 0,
      first_instance: 0,
    })
    expect(frame_pass?.commands).toContainEqual({
      kind: `draw`,
      pipeline: `large-system-impostor-ghost-pipeline`,
      vertex_count: 4,
      instance_count: 1,
      first_vertex: 0,
      first_instance: N,
    })
    expect(renderer.get_diagnostics().ghost_count).toBe(1)

    renderer.destroy()
  })

  it(`preserves full signed packet jimages and draws self-image edges`, () => {
    const bond_graph: BaseBondGraph = {
      version: 1,
      // Int8 is the declared graph range. +2 and negative self-images must not
      // silently collapse to +/-1; the plain bond pins the zero lane too.
      pairs: new Uint32Array([0, 0, 1, 1, 0, 1]),
      jimages: new Int8Array([2, -3, 0, -1, 0, 0, 0, 0, 0]),
      kinds: new Uint8Array(3),
      strengths: new Float32Array([1, 1, 1]),
    }
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    renderer.set_packet({
      topology: make_topology(bond_graph),
      frame: make_frame(),
      replicas: make_replicas(),
    }, EMPTY_IMAGES)

    const pairs = writes_to(rec.writes, `large-system-bond-pairs-active`)
    expect(pairs).toHaveLength(1)
    expect([...new Uint32Array(pairs[0].bytes.buffer)]).toEqual([
      0,
      0,
      pack_signed_jimage(2, -3, 0) | (1 << 24),
      1,
      1,
      pack_signed_jimage(-1, 0, 0) | (1 << 24),
      0,
      1,
      pack_signed_jimage(0, 0, 0),
    ])
    const count = writes_to(rec.writes, `large-system-bond-count-active`).at(-1)
    expect(count).toBeDefined()
    expect(new Uint32Array(count!.bytes.buffer)[0]).toBe(3)
    const bond_shader = rec.shader_sources[`large-system-bond-render`]
    expect(bond_shader).toContain(`jp & 255u`)
    expect(bond_shader).toContain(`jp >> 8u`)
    expect(bond_shader).toContain(`jp >> 16u`)
    expect(bond_shader).toContain(`let boundary_flags = jp >> 24u;`)
    expect(bond_shader).not.toContain(`jp & 3u`)

    renderer.render()
    expect(rec.compute_passes).toContain(`large-system-bond-indirect`)
    expect(rec.compute_passes).not.toContain(`large-system-bond-compute`)
    const frame_pass = rec.passes.find((p) => p.label === `frame`)
    expect(frame_pass?.indirect).toBe(1)

    renderer.destroy()
  })

  it(`keeps base frame inputs independent from displayed replicas`, () => {
    // Behavioral lock for the packet inputs: even if the WebGL
    // displayed structure has appended images, the packet owner/topology is
    // the 3-site BASE structure, positions stay 3N under 2×2×2, and the live
    // variable-cell frame lattice wins over the base/displayed lattice.
    const base = make_base_structure(3, 10)
    const displayed_with_images = {
      ...base,
      sites: [...base.sites, ...base.sites, ...base.sites],
    }
    expect(displayed_with_images.sites).toHaveLength(9) // explicitly NOT consumed
    const builder = create_render_packet_builder()
    const frame_positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])
    const packet = builder.build({
      structure: base as unknown as AnyStructure,
      frame_positions,
      frame_lattice: [[12, 0, 0], [0, 13, 0], [0, 0, 14]],
      frame_idx: 4,
      positions_version: 7,
      dims: [2, 2, 2],
    })
    expect(packet.topology.atom_count).toBe(3)
    expect(packet.frame.positions).toBe(frame_positions)
    expect(packet.frame.positions).toHaveLength(9)
    expect([...packet.frame.lattice]).toEqual([12, 0, 0, 0, 13, 0, 0, 0, 14])
  })

  it(`wires one manager-ready trajectory packet through the production scene`, () => {
    const structure_source = readFileSync(
      resolve(process.cwd(), `src/lib/structure/Structure.svelte`),
      `utf8`,
    )
    const scene_source = readFileSync(
      resolve(process.cwd(), `src/lib/structure/StructureScene.svelte`),
      `utf8`,
    )

    expect(structure_source).not.toContain(`void render_packet`)
    expect(structure_source).toMatch(
      /<StructureScene[\s\S]*?\{render_packet\}[\s\S]*?\/>/,
    )
    expect(scene_source).toContain(
      `render_packet = null as RenderPacket | null`,
    )
    expect(
      scene_source.match(/packet=\{manager_render_packet\}/g),
    ).toHaveLength(1)
    expect(
      scene_source.match(/render_packet=\{combined_packet_renderer_owned/g),
    ).toHaveLength(2)

    expect(structure_source).toContain(`dims: gpu_supercell_factors`)
    expect(structure_source).not.toContain(
      `dims: gpu_supercell_active ? gpu_supercell_factors : [1, 1, 1]`,
    )
    expect(structure_source).toMatch(
      /show_image_atoms\s*\?\s*`ghost-images`\s*:\s*scene_props\.hide_incomplete_bonds\s*\?\s*`hide`\s*:\s*`stub`/,
    )
    expect(structure_source).toMatch(
      /let large_overlay_structure = \$derived\([\s\S]*?physical_supercell_render\?\.base_structure\s*\?\?[\s\S]*?trajectory_packet_active[\s\S]*?transform\.base_structure \?\? structure/,
    )
    expect(structure_source).toContain(
      `structure={large_overlay_structure}`,
    )
    expect(structure_source).toContain(
      `packet_owner_id={large_overlay_owner_id}`,
    )
    expect(structure_source).toContain(
      `replica_semantics={physical_supercell_render`,
    )
    expect(structure_source).toContain(
      `physical_site_map={physical_supercell_render?.physical_site_map}`,
    )

    expect(scene_source).toContain(`colors: atom_colors_buffer`)
    expect(scene_source).toContain(`radii: manager_logical_radii`)
    expect(scene_source).toContain(
      `const bond_graph = packet_owned_graph ?? manager_bond_graph`,
    )
    expect(scene_source).toContain(`bond_graph,`)
    expect(scene_source).toContain(
      `pairs: manager.pairs_buffer.slice(0, count * 2)`,
    )
    expect(scene_source).toContain(
      `jimages: manager.jimages_buffer.slice(0, count * 3)`,
    )
    expect(scene_source).toContain(
      `kinds: manager.kinds_buffer.slice(0, count)`,
    )
  })

  it(`legacy overwrite invalidates packet ownership so the same packet fully restores`, () => {
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const images: ImageInstanceTable = {
      count: 1,
      base_sites: new Uint32Array([2]),
      jimages: new Int8Array([2, 0, 0]),
    }
    const graph: BaseBondGraph = {
      version: 1,
      pairs: new Uint32Array([0, 2]),
      jimages: new Int8Array([1, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    const packet: RenderPacket = {
      topology: make_topology(graph),
      frame: make_frame(),
      replicas: make_replicas({
        version: 3,
        dims: [2, 1, 1],
        boundary_policy: `ghost-images`,
      }),
    }
    renderer.set_packet(packet, images)

    // Legacy code overwrites every shared state family. It must invalidate the
    // packet cache even though packet's version numbers/object are unchanged.
    renderer.set_atoms(
      make_positions(9),
      new Float32Array(N).fill(9),
      new Float32Array(N * 3).fill(9),
      N,
    )
    renderer.set_supercell([1, 1, 1], make_frame().lattice)
    renderer.set_show_images(false)
    expect((renderer.get_diagnostics() as { ownership?: string }).ownership).toBe(`legacy`)

    rec.clear()
    renderer.set_packet(packet, images) // SAME object + SAME versions
    expect(writes_to(rec.writes, `large-system-positions`)).toHaveLength(1)
    expect(writes_to(rec.writes, `large-system-radii`)).toHaveLength(1)
    expect(writes_to(rec.writes, `large-system-colors`)).toHaveLength(1)
    expect(writes_to(rec.writes, `large-system-supercell`).length).toBeGreaterThan(0)
    expect(writes_to(rec.writes, `large-system-ghost-sites`)).toHaveLength(1)
    const diag = renderer.get_diagnostics() as ReturnType<typeof renderer.get_diagnostics> & {
      ownership?: string
    }
    expect(diag.ownership).toBe(`packet`)
    expect(diag.dims).toEqual([2, 1, 1])
    expect(diag.boundary_policy).toBe(`ghost-images`)
    expect(diag.ghost_count).toBe(1)

    renderer.destroy()
  })

  it(`keeps packet render lattice isolated from detector data across same-packet replay`, () => {
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const packet: RenderPacket = {
      topology: make_topology(),
      frame: make_frame(),
      replicas: make_replicas(),
    }
    renderer.set_packet(packet, EMPTY_IMAGES)
    const packet_uniform = writes_to(rec.writes, `large-system-bond-render-uniform`).at(-1)
    expect(packet_uniform).toBeDefined()
    expect(new Float32Array(packet_uniform!.bytes.buffer)[0]).toBe(20)

    rec.clear()
    renderer.set_bond_data(
      new Float32Array(N).fill(0.76),
      new Float32Array([9, 0, 0, 0, 9, 0, 0, 0, 9]),
      { tolerance: 0.45, max_bond_dist: 3, min_bond_dist: 0.1 },
      true,
    )
    renderer.set_packet(packet, EMPTY_IMAGES) // SAME object + versions

    // set_bond_data owns detector inputs only in packet mode. It must never
    // overwrite the packet-owned bond render lattice and leave split state.
    expect(writes_to(rec.writes, `large-system-bond-render-uniform`)).toHaveLength(0)
    expect(renderer.get_diagnostics().ownership).toBe(`packet`)

    renderer.destroy()
  })

  it(`encodes hide vs ghost boundary policy and completes multi-cell ghost bonds`, () => {
    const self_graph: BaseBondGraph = {
      version: 1,
      pairs: new Uint32Array([0, 0]),
      jimages: new Int8Array([1, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const topology = make_topology(self_graph)
    const frame = make_frame()

    renderer.set_packet({
      topology,
      frame,
      replicas: make_replicas({
        version: 1,
        dims: [2, 1, 1],
        boundary_policy: `hide`,
      }),
    }, EMPTY_IMAGES)
    let sc = writes_to(rec.writes, `large-system-supercell`).at(-1)
    expect(sc).toBeDefined()
    let policy_rows = new Float32Array(sc!.bytes.buffer, 16, 12)
    expect(policy_rows[3]).toBe(1) // stub=0, hide=1, ghost-images=2
    renderer.render()
    let frame_pass = rec.passes.find((p) => p.label === `frame`)
    expect(frame_pass?.commands).toContainEqual({
      kind: `draw`,
      pipeline: `large-system-impostor-pipeline`,
      vertex_count: 4,
      instance_count: N * 2,
      first_vertex: 0,
      first_instance: 0,
    }) // hide never draws ghosts
    expect(frame_pass?.indirect).toBe(1)
    expect(rec.compute_passes).not.toContain(`large-system-bond-compute`)

    rec.clear()
    renderer.set_packet({
      topology,
      frame,
      replicas: make_replicas({
        version: 2,
        dims: [2, 1, 1],
        boundary_policy: `ghost-images`,
      }),
    }, make_images([[0, 2, 0, 0]]))
    sc = writes_to(rec.writes, `large-system-supercell`).at(-1)
    expect(sc).toBeDefined()
    policy_rows = new Float32Array(sc!.bytes.buffer, 16, 12)
    expect(policy_rows[3]).toBe(2)
    renderer.render()
    frame_pass = rec.passes.find((p) => p.label === `frame`)
    expect(frame_pass?.commands).toContainEqual({
      kind: `draw`,
      pipeline: `large-system-impostor-pipeline`,
      vertex_count: 4,
      instance_count: N * 2,
      first_vertex: 0,
      first_instance: 0,
    })
    expect(frame_pass?.commands).toContainEqual({
      kind: `draw`,
      pipeline: `large-system-impostor-ghost-pipeline`,
      vertex_count: 4,
      instance_count: 1,
      first_vertex: 0,
      first_instance: N * 2,
    })
    expect(frame_pass?.indirect).toBe(2)
    expect(rec.compute_passes).toContain(`large-system-bond-indirect`)
    expect(rec.compute_passes).not.toContain(`large-system-bond-compute`)

    // Mock devices cannot execute WGSL, so source-lock the policy branches:
    // hide collapses outside edges; ghost completes them for ANY dims. The old
    // `ncells == 1u && show_images` limitation must be absent.
    const bond_shader = rec.shader_sources[`large-system-bond-render`]
    expect(bond_shader).toContain(`let hide_outside`)
    expect(bond_shader).toContain(`let ghost_complete`)
    expect(bond_shader).not.toContain(`ncells == 1u && show_images`)

    renderer.destroy()
  })

  it(`publishes GPU-detected multi-cell ghosts from the validated base graph`, async () => {
    const rec = make_recording_device({
      validation_reads: [[1, 0]],
      graph_reads: [[0, 1, pack_signed_jimage(1, 0, 0)]],
    })
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    renderer.set_packet({
      topology: make_topology(),
      frame: make_frame(),
      replicas: make_replicas({
        dims: [2, 2, 1],
        boundary_policy: `ghost-images`,
      }),
    }, EMPTY_IMAGES)
    renderer.set_bond_data(
      new Float32Array(N).fill(0.76),
      make_frame().lattice,
      { tolerance: 0.45, max_bond_dist: 3, min_bond_dist: 0.1 },
      true,
    )

    renderer.render() // candidate dispatch + count validation
    await flush() // graph readback + publication become ready
    rec.clear()
    renderer.render() // publish the validated graph and its derived ghost stream

    const sites = writes_to(rec.writes, `large-system-ghost-sites`)
    expect(sites).toHaveLength(1)
    expect([...new Uint32Array(sites[0].bytes.buffer)]).toEqual([1, 1])
    const images = writes_to(rec.writes, `large-system-ghost-images`)
    expect(images).toHaveLength(1)
    expect([...new Uint32Array(images[0].bytes.buffer)]).toEqual([
      pack_signed_jimage(2, 0, 0),
      pack_signed_jimage(2, 1, 0),
    ])
    expect(renderer.get_diagnostics().ghost_count).toBe(2)
    const frame_pass = rec.passes.find((p) => p.label === `frame`)
    expect(frame_pass?.draws[0]).toEqual([4, N * 4])
    expect(frame_pass?.commands).toContainEqual({
      kind: `draw`,
      pipeline: `large-system-impostor-ghost-pipeline`,
      vertex_count: 4,
      instance_count: 2,
      first_vertex: 0,
      first_instance: N * 4,
    })

    renderer.destroy()
  })

  it(`discards an async candidate across packet graph enter then exit`, async () => {
    const validation = deferred()
    const rec = make_recording_device({
      validation_reads: [[0, 0]],
      validation_maps: [validation.promise],
    })
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const on_work = vi.fn()
    renderer.on_bond_work(on_work)

    // Start a legacy GPU-detect candidate whose validation remains unresolved.
    renderer.set_atoms(
      make_positions(),
      new Float32Array(N).fill(0.5),
      new Float32Array(N * 3).fill(0.5),
      N,
    )
    renderer.set_bond_data(
      new Float32Array(N).fill(0.76),
      make_frame().lattice,
      { tolerance: 0.45, max_bond_dist: 3, min_bond_dist: 0.1 },
      true,
    )
    renderer.render()
    expect(renderer.debug_bond_state().dispatches.detect).toBe(1)

    // Ownership changes twice while the old candidate is in flight: install a
    // packet graph, then remove it. Both transitions bump graph generation.
    const packet_graph: BaseBondGraph = {
      version: 4,
      pairs: new Uint32Array([0, 0]),
      jimages: new Int8Array([1, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    const packet_with_graph: RenderPacket = {
      topology: make_topology(packet_graph),
      frame: make_frame(),
      replicas: make_replicas(),
    }
    renderer.set_packet(packet_with_graph, EMPTY_IMAGES)
    renderer.set_packet({
      ...packet_with_graph,
      topology: make_topology(undefined),
    }, EMPTY_IMAGES)

    validation.resolve()
    await flush()
    // The old candidate must not reach bond_run.observe()/publication.
    expect(renderer.debug_bond_state().graph_version).toBe(0)
    expect(on_work).toHaveBeenCalledTimes(1) // wake to run the re-armed fresh graph

    rec.clear()
    renderer.render()
    expect(renderer.debug_bond_state().graph_version).toBe(0)
    expect(renderer.debug_bond_state().dispatches.detect).toBe(2)
    expect(rec.compute_passes).toContain(`large-system-bond-compute`)

    renderer.destroy()
  })

  it(`pick decodes replica cells and ghost instances`, async () => {
    // dims [2,1,1] ⇒ real instance range [0, 16). Injected ids:
    //   12 → g=11 → atom 3, cell [1,0,0]   (11 = 3 + 8·1)
    //   17 → g=16 → ghost 0 → base 5, absolute image [-1,0,0]
    //    0 → background miss
    const rec = make_recording_device({ pick_reads: [12, 17, 0] })
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const graph: BaseBondGraph = {
      version: 1,
      pairs: new Uint32Array([0, 5]),
      jimages: new Int8Array([-1, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    renderer.set_packet({
      topology: make_topology(graph),
      frame: make_frame(),
      replicas: make_replicas({ dims: [2, 1, 1], boundary_policy: `ghost-images` }),
    }, make_images([[5, -1, 0, 0]]))

    const replica = await renderer.pick(2, 2)
    expect(replica).toEqual({ kind: `atom`, base_site: 3, cell: [1, 0, 0], ghost: false })
    const ghost = await renderer.pick(2, 2)
    expect(ghost).toEqual({ kind: `atom`, base_site: 5, cell: [-1, 0, 0], ghost: true })
    const miss = await renderer.pick(2, 2)
    expect(miss).toEqual({ kind: `miss`, base_site: -1, cell: [0, 0, 0], ghost: false })

    // The pick pass drew every replica AND the ordinary-view ghost (16 + 1).
    const pick_pass = rec.passes.find((p) => p.label === `large-system-pick-pass`)
    expect(pick_pass?.draws[0]).toEqual([4, 17])

    renderer.destroy()
  })
})

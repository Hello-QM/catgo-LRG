import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AnyStructure } from '$lib'
import { create_large_system_renderer } from '$lib/structure/gpu/large-system-renderer'
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
type Pass = { label: string; draws: [number, number][]; indirect: number }

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
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
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
        const pass: Pass = { label: desc?.label ?? `frame`, draws: [], indirect: 0 }
        passes.push(pass)
        return {
          setPipeline: () => {},
          setBindGroup: () => {},
          draw: (verts: number, instances = 1) => {
            pass.draws.push([verts, instances])
          },
          drawIndirect: () => {
            pass.indirect += 1
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
  }
  return { device, writes, passes, compute_passes, created, shader_sources, clear }
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

  it(`derives sparse packet ghosts from the same graph, including a center self-image`, () => {
    const graph: BaseBondGraph = {
      version: 1,
      // Site 4 can sit anywhere in the base cell: the graph, not decorative
      // boundary metadata, proves its +a self-image endpoint needs a ghost.
      pairs: new Uint32Array([4, 4]),
      jimages: new Int8Array([1, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    const decorative_images: ImageInstanceTable = {
      count: 1,
      base_sites: new Uint32Array([7]),
      jimages: new Int8Array([0, 0, 0]),
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
    expect(frame_pass?.draws[0]).toEqual([4, N + 1])
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
      pack_signed_jimage(2, -3, 0),
      1,
      1,
      pack_signed_jimage(-1, 0, 0),
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
    expect(bond_shader).not.toContain(`jp & 3u`)

    renderer.render()
    expect(rec.compute_passes).toContain(`large-system-bond-indirect`)
    expect(rec.compute_passes).not.toContain(`large-system-bond-compute`)
    const frame_pass = rec.passes.find((p) => p.label === `frame`)
    expect(frame_pass?.indirect).toBe(1)

    renderer.destroy()
  })

  it(`Structure wires the overlay from base frame inputs, never WebGL reverse-read data`, () => {
    const structure_source = readFileSync(
      resolve(process.cwd(), `src/lib/structure/Structure.svelte`),
      `utf8`,
    )
    const overlay_source = readFileSync(
      resolve(process.cwd(), `src/lib/structure/gpu/LargeSystemOverlay.svelte`),
      `utf8`,
    )
    const scene_source = readFileSync(
      resolve(process.cwd(), `src/lib/structure/StructureScene.svelte`),
      `utf8`,
    )
    expect(structure_source).not.toContain(`scene_get_displayed_frame_positions`)
    expect(structure_source).toContain(`structure={structure}`)
    expect(structure_source).toContain(`frame_positions={trajectory_frame_positions}`)
    expect(structure_source).toContain(`frame_lattice={trajectory_frame_lattice}`)
    expect(overlay_source).not.toContain(`get_displayed_frame_positions`)
    expect(scene_source).not.toContain(`get_displayed_frame_positions`)

    // Behavioral lock for the inputs Structure must pass: even if the WebGL
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
      { tolerance: 0.45, max_bond_dist: 3, min_dist: 0.1 },
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
    expect(frame_pass?.draws[0]).toEqual([4, N * 2]) // hide never draws ghosts
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
    }, EMPTY_IMAGES)
    sc = writes_to(rec.writes, `large-system-supercell`).at(-1)
    expect(sc).toBeDefined()
    policy_rows = new Float32Array(sc!.bytes.buffer, 16, 12)
    expect(policy_rows[3]).toBe(2)
    renderer.render()
    frame_pass = rec.passes.find((p) => p.label === `frame`)
    expect(frame_pass?.draws[0]).toEqual([4, N * 2 + 1])
    expect(frame_pass?.indirect).toBe(1)
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
      { tolerance: 0.45, max_bond_dist: 3, min_dist: 0.1 },
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
    expect(frame_pass?.draws[0]).toEqual([4, N * 4 + 2])

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
      { tolerance: 0.45, max_bond_dist: 3, min_dist: 0.1 },
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
    }, EMPTY_IMAGES)

    const replica = await renderer.pick(2, 2)
    expect(replica).toEqual({ kind: `atom`, base_site: 3, cell: [1, 0, 0], ghost: false })
    const ghost = await renderer.pick(2, 2)
    expect(ghost).toEqual({ kind: `atom`, base_site: 5, cell: [-1, 0, 0], ghost: true })
    const miss = await renderer.pick(2, 2)
    expect(miss).toEqual({ kind: `miss`, base_site: -1, cell: [0, 0, 0], ghost: false })

    // The pick pass drew every replica AND the graph-derived ghost (16 + 1).
    const pick_pass = rec.passes.find((p) => p.label === `large-system-pick-pass`)
    expect(pick_pass?.draws[0]).toEqual([4, 17])

    renderer.destroy()
  })
})

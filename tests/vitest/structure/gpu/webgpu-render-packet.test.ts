import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { create_large_system_renderer } from '$lib/structure/gpu/large-system-renderer'
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

const make_recording_device = (opts?: { pick_reads?: number[] }) => {
  const writes: Write[] = []
  const passes: Pass[] = []
  const compute_passes: string[] = []
  const created: string[] = []
  const device = {
    limits: { maxStorageBufferBindingSize: 1 << 27 },
    createBuffer: (desc: { size: number; label?: string }) => {
      created.push(desc.label ?? `?`)
      return {
        label: desc.label,
        size: desc.size,
        destroy: () => {},
        mapAsync: () => Promise.resolve(),
        getMappedRange: () => {
          const buf = new ArrayBuffer(Math.max(desc.size, 8))
          if (desc.label === `large-system-pick-readback`) {
            const next = opts?.pick_reads?.shift()
            if (next !== undefined) new Uint32Array(buf)[0] = next
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
    createShaderModule: () => ({}),
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
  return { device, writes, passes, compute_passes, created, clear }
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

  it(`ghost image instances upload sparsely and extend the atom draw`, () => {
    const rec = make_recording_device()
    const renderer = create_large_system_renderer(
      rec.device as unknown as GPUDevice,
      make_mock_canvas() as unknown as HTMLCanvasElement,
    )
    const images: ImageInstanceTable = {
      count: 3,
      base_sites: new Uint32Array([1, 2, 3]),
      jimages: new Int8Array([-1, 0, 0, 2, 0, 0, 0, 0, 2]),
    }
    renderer.set_packet({
      topology: make_topology(),
      frame: make_frame(),
      replicas: make_replicas({ dims: [2, 2, 2], boundary_policy: `ghost-images` }),
    }, images)

    // Sparse: 3 ghosts ⇒ 3 u32 sites + 3 packed images — NOT N×ncells-sized.
    const sites = writes_to(rec.writes, `large-system-ghost-sites`)
    expect(sites).toHaveLength(1)
    expect(sites[0].bytes.byteLength).toBe(3 * 4)
    expect([...new Uint32Array(sites[0].bytes.buffer)]).toEqual([1, 2, 3])
    const imgs = writes_to(rec.writes, `large-system-ghost-images`)
    expect(imgs).toHaveLength(1)
    expect(imgs[0].bytes.byteLength).toBe(3 * 4)
    // Packed (j+128) lanes: [-1,0,0] → 127 | 128<<8 | 128<<16.
    const packed = new Uint32Array(imgs[0].bytes.buffer)
    expect(packed[0]).toBe(127 | (128 << 8) | (128 << 16))
    expect(packed[1]).toBe(130 | (128 << 8) | (128 << 16))
    expect(packed[2]).toBe(128 | (128 << 8) | (130 << 16))

    renderer.render()
    const frame_pass = rec.passes.find((p) => p.label === `frame`)
    // 8 atoms × 8 cells + 3 ghost instances.
    expect(frame_pass?.draws[0]).toEqual([4, N * 8 + 3])
    expect(renderer.get_diagnostics().ghost_count).toBe(3)

    renderer.destroy()
  })

  it(`periodic self-image edges reach the bond draw`, () => {
    const bond_graph: BaseBondGraph = {
      version: 1,
      // Self-image edge (0—0 across +a) plus a plain intra-cell bond.
      pairs: new Uint32Array([0, 0, 0, 1]),
      jimages: new Int8Array([1, 0, 0, 0, 0, 0]),
      kinds: new Uint8Array(2),
      strengths: new Float32Array([1, 1]),
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

    // The packed active pairs retain the self-edge 1:1 (a === b, jimage ≠ 0
    // packs to (1+1)|((0+1)<<2)|((0+1)<<4) = 22; jimage 0 packs to 21).
    const pairs = writes_to(rec.writes, `large-system-bond-pairs-active`)
    expect(pairs).toHaveLength(1)
    expect([...new Uint32Array(pairs[0].bytes.buffer)]).toEqual([0, 0, 22, 0, 1, 21])
    const count = writes_to(rec.writes, `large-system-bond-count-active`).at(-1)
    expect(count).toBeDefined()
    expect(new Uint32Array(count!.bytes.buffer)[0]).toBe(2)

    renderer.render()
    // The indirect-args build ran (count → draw args) and the bond draw was
    // issued — the self-edge is inside the drawn instance range.
    expect(rec.compute_passes).toContain(`large-system-bond-indirect`)
    expect(rec.compute_passes).not.toContain(`large-system-bond-compute`)
    const frame_pass = rec.passes.find((p) => p.label === `frame`)
    expect(frame_pass?.indirect).toBe(1)

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
    const images: ImageInstanceTable = {
      count: 2,
      base_sites: new Uint32Array([5, 2]),
      jimages: new Int8Array([-1, 0, 0, 2, 0, 1]),
    }
    renderer.set_packet({
      topology: make_topology(),
      frame: make_frame(),
      replicas: make_replicas({ dims: [2, 1, 1], boundary_policy: `ghost-images` }),
    }, images)

    const replica = await renderer.pick(2, 2)
    expect(replica).toEqual({ kind: `atom`, base_site: 3, cell: [1, 0, 0], ghost: false })
    const ghost = await renderer.pick(2, 2)
    expect(ghost).toEqual({ kind: `atom`, base_site: 5, cell: [-1, 0, 0], ghost: true })
    const miss = await renderer.pick(2, 2)
    expect(miss).toEqual({ kind: `miss`, base_site: -1, cell: [0, 0, 0], ghost: false })

    // The pick pass drew every replica AND ghost instance (16 + 2).
    const pick_pass = rec.passes.find((p) => p.label === `large-system-pick-pass`)
    expect(pick_pass?.draws[0]).toEqual([4, 18])

    renderer.destroy()
  })
})

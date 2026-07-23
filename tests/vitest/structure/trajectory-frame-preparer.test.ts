import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('$lib/structure/workers/bond-worker-api', () => ({
  compute_trajectory_frame_typed: vi.fn(),
  compute_bonds_exact_async: vi.fn(),
  pack_trajectory_positions_worker: vi.fn(),
  LARGE_SYSTEM_MIN_ATOMS: 4096,
}))

import type { AnyStructure, BondPair, Site } from '$lib'
import type { RenderPacket } from '$lib/structure/scene/render-packet'
import {
  compute_bonds_exact_async,
  compute_trajectory_frame_typed,
  pack_trajectory_positions_worker,
} from '$lib/structure/workers/bond-worker-api'
import {
  prepare_exact_trajectory_frame,
  type ExactFramePrepareInput,
} from '$lib/structure/trajectory-frame-preparer'

const typed_mock = vi.mocked(compute_trajectory_frame_typed)
const object_mock = vi.mocked(compute_bonds_exact_async)
const pack_mock = vi.mocked(pack_trajectory_positions_worker)

function site(element: string, xyz: [number, number, number]): Site {
  return {
    species: [{ element, occu: 1, oxidation_state: 0 }],
    abc: xyz,
    xyz,
    label: element,
    properties: {},
  } as unknown as Site
}

function fixture(): {
  packet: RenderPacket
  structure: AnyStructure
  positions: Float32Array
  lattice: number[][]
} {
  const owner = {}
  const lattice = [[4, 0, 0], [0, 5, 0], [1, 0, 6]]
  const positions = new Float32Array([0.2, 0, 0, 3.8, 0, 0])
  const structure = {
    sites: [site(`C`, [0, 0, 0]), site(`H`, [1, 0, 0])],
    lattice: { matrix: lattice, pbc: [true, false, true] },
  } as unknown as AnyStructure
  const packet: RenderPacket = {
    topology: {
      version: 11,
      atom_count: 2,
      site_ids: new Uint32Array([7, 9]),
      atomic_numbers: new Uint8Array([6, 1]),
      radii: new Float32Array([0.76, 0.31]),
      colors: new Float32Array(6),
    },
    frame: {
      owner,
      frame_idx: 0,
      positions_version: 1,
      positions: new Float32Array(6),
      lattice: new Float32Array(9),
    },
    replicas: {
      version: 3,
      dims: [1, 1, 1],
      boundary_policy: `stub`,
      semantics: `visual-shared-base`,
    },
  }
  return { packet, structure, positions, lattice }
}

function input(
  overrides: Partial<ExactFramePrepareInput> = {},
): ExactFramePrepareInput {
  const { packet, structure, positions, lattice } = fixture()
  return {
    packet,
    structure,
    source: {
      frame_idx: 5,
      positions,
      forces: new Float32Array([1, 2, 3, 4, 5, 6]),
      lattice,
      positions_version: 13,
      topology_stable: true,
    },
    strategy: `atom_radii`,
    options: { tolerance: 0.1, max_bond_dist: 4, min_dist: 0.01 },
    pbc: [true, false, true],
    distance_rules: [],
    rules_version: `rules-v2`,
    graph_version: 17,
    ...overrides,
  }
}

function bond(
  a: number,
  b: number,
  jimage: [number, number, number],
): BondPair {
  return {
    pos_1: [0, 0, 0],
    pos_2: [1, 0, 0],
    site_idx_1: a,
    site_idx_2: b,
    bond_length: 1,
    strength: 0.75,
    transform_matrix: new Float32Array(16),
    jimage,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe(`prepare_exact_trajectory_frame`, () => {
  test(`atom-radii fast path publishes one exact typed snapshot`, async () => {
    const gpu = new Float32Array([0.2, 0, 0, 1, 3.8, 0, 0, 1])
    typed_mock.mockResolvedValue({
      backend: `rust-wasm-threads`,
      elapsed_ms: 2,
      table: {
        pairs: new Uint32Array([0, 1, 0, 0]),
        images: new Int8Array([-1, 0, 0, 1, 0, 0]),
        lengths: new Float32Array([0.4, 4]),
        strengths: new Float32Array([0.9, 0.4]),
      },
      gpu_positions_rgba: gpu,
    })
    const request = input()

    const prepared = await prepare_exact_trajectory_frame(request)

    expect(typed_mock).toHaveBeenCalledOnce()
    expect(object_mock).not.toHaveBeenCalled()
    expect(pack_mock).not.toHaveBeenCalled()
    expect(typed_mock).toHaveBeenCalledWith(expect.objectContaining({
      positions: request.source.positions,
      lattice_matrix: request.source.lattice,
      session: expect.objectContaining({
        atomic_numbers: request.packet.topology.atomic_numbers,
        pbc: request.pbc,
        options: request.options,
      }),
    }))
    expect(prepared.packet.frame).toMatchObject({
      owner: request.packet.frame.owner,
      frame_idx: 5,
      positions_version: 13,
      positions: request.source.positions,
    })
    expect([...prepared.packet.frame.lattice]).toEqual(request.source.lattice?.flat())
    expect(prepared.graph).toBe(prepared.packet.topology.bond_graph)
    expect([...prepared.graph.pairs]).toEqual([0, 1, 0, 0])
    expect([...prepared.graph.jimages]).toEqual([-1, 0, 0, 1, 0, 0])
    expect(prepared.graph.version).toBe(17)
    expect(prepared.gpu_positions_rgba).toBe(gpu)
    expect(prepared.forces).toBe(request.source.forces)
    expect(prepared.key).toEqual({
      owner: request.packet.frame.owner,
      frame_idx: 5,
      positions_version: 13,
      topology_version: 11,
      rules_version: `rules-v2`,
    })
    expect(prepared.graph_hash).toHaveLength(40)
    expect(prepared.byte_size).toBeGreaterThan(gpu.byteLength)
  })

  test(`custom rules use object detection, full override, and worker packing`, async () => {
    const request = input({
      distance_rules: [{
        element_1: `C`,
        element_2: `H`,
        min_dist: 0.3,
        max_dist: 0.5,
      }],
    })
    object_mock.mockResolvedValue([bond(0, 1, [0, 0, 0])])
    const packed = new Float32Array([0.2, 0, 0, 1, 3.8, 0, 0, 1])
    pack_mock.mockResolvedValue(packed)

    const prepared = await prepare_exact_trajectory_frame(request)

    expect(typed_mock).not.toHaveBeenCalled()
    expect(object_mock).toHaveBeenCalledOnce()
    const overlay = object_mock.mock.calls[0][0]
    expect(overlay.sites[0].xyz[0]).toBeCloseTo(0.2)
    expect(overlay.sites[1].xyz[0]).toBeCloseTo(3.8)
    expect((overlay as { lattice?: { matrix?: number[][] } }).lattice?.matrix)
      .toBe(request.source.lattice)
    expect(pack_mock).toHaveBeenCalledWith(request.source.positions)
    // The strategy bond at image 0 is outside the rule. The full override
    // regenerates the exact cross-cell contact and preserves its jimage.
    expect([...prepared.graph.pairs]).toEqual([0, 1])
    expect([...prepared.graph.jimages]).toEqual([-1, 0, 0])
    expect(prepared.gpu_positions_rgba).toBe(packed)
  })

  test(`non-atom-radii and topology-changing sources never use typed fast path`, async () => {
    object_mock.mockResolvedValue([])
    pack_mock.mockResolvedValue(new Float32Array(8))

    await prepare_exact_trajectory_frame(input({ strategy: `solid_angle` }))
    await prepare_exact_trajectory_frame(input({
      source: { ...input().source, topology_stable: false },
    }))

    expect(typed_mock).not.toHaveBeenCalled()
    expect(object_mock).toHaveBeenCalledTimes(2)
    expect(pack_mock).toHaveBeenCalledTimes(2)
  })

  test(`small typed-worker failure uses the exact object backend and local packing`, async () => {
    typed_mock.mockRejectedValue(new Error(`typed worker unavailable`))
    object_mock.mockResolvedValue([bond(0, 1, [0, 0, 0])])
    pack_mock.mockRejectedValue(new Error(`packing worker unavailable`))
    const request = input()

    const prepared = await prepare_exact_trajectory_frame(request)

    expect(typed_mock).toHaveBeenCalledOnce()
    expect(object_mock).toHaveBeenCalledOnce()
    expect(pack_mock).toHaveBeenCalledOnce()
    expect([...prepared.graph.pairs]).toEqual([0, 1])
    expect([...prepared.gpu_positions_rgba]).toEqual([
      request.source.positions[0], 0, 0, 1,
      request.source.positions[3], 0, 0, 1,
    ])
  })

  test(`large typed-worker failure rejects without an object or main-thread fallback`, async () => {
    const request = input()
    const atom_count = 4096
    request.packet = {
      ...request.packet,
      topology: {
        ...request.packet.topology,
        atom_count,
        site_ids: new Uint32Array(atom_count),
        atomic_numbers: new Uint8Array(atom_count).fill(6),
        radii: new Float32Array(atom_count),
        colors: new Float32Array(atom_count * 3),
      },
    }
    request.structure = {
      ...request.structure,
      sites: Array.from(
        { length: atom_count },
        (_, idx) => site(`C`, [idx, 0, 0]),
      ),
    } as AnyStructure
    request.source = {
      ...request.source,
      positions: new Float32Array(atom_count * 3),
    }
    const failure = new Error(`typed worker unavailable`)
    typed_mock.mockRejectedValue(failure)

    await expect(prepare_exact_trajectory_frame(request)).rejects.toBe(failure)
    expect(object_mock).not.toHaveBeenCalled()
    expect(pack_mock).not.toHaveBeenCalled()
  })

  test(`atom-only frames bypass all bond workers and present packed positions`, async () => {
    const request = input({
      features: {
        strategy: `atom_radii`,
        atom_count: 2,
        show_bonds: false,
        topology_stable: true,
        atomic_numbers_complete: true,
        distance_rule_count: 0,
        site_radius_override_count: 0,
        manual_bond_count: 0,
        deleted_bond_count: 0,
        hidden_bond_features: false,
        hydrogen_bonds: false,
        bond_orders: false,
        clipping: false,
        polyhedra: false,
        drag_overrides: false,
      },
    })

    const prepared = await prepare_exact_trajectory_frame(request)

    expect(typed_mock).not.toHaveBeenCalled()
    expect(object_mock).not.toHaveBeenCalled()
    expect(pack_mock).not.toHaveBeenCalled()
    expect(prepared.graph.pairs).toHaveLength(0)
    expect([...prepared.gpu_positions_rgba]).toEqual([
      request.source.positions[0], 0, 0, 1,
      request.source.positions[3], 0, 0, 1,
    ])
  })
})

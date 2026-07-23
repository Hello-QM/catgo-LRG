import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  compute_trajectory_frame_typed,
  pack_trajectory_positions_worker,
  RealBondWorkerHandle,
  set_bond_worker_runtime_for_tests,
} from '$lib/structure/workers/bond-worker-api'
import {
  type BondWorkerHandle,
  create_bond_worker_runtime,
  type TrajectoryTypedBondInput,
} from '$lib/structure/workers/bond-worker-runtime'
import {
  POSITION_TEXTURE_ROW_ATOMS,
  position_texture_shape,
} from '$lib/structure/gpu/position-texture-layout'
import {
  install_bond_worker,
  type BondWorkerGlue,
  type BondWorkerScope,
} from '$lib/structure/workers/bond-worker'

const capabilities = {
  cross_origin_isolated: false,
  shared_array_buffer: false,
  wasm_atomics: false,
  hardware_concurrency: 8,
}

function trajectory_input(
  session_id = 1,
  positions = Float32Array.from([1, 2, 3, 4, 5, 6]),
): TrajectoryTypedBondInput {
  return {
    session: {
      id: session_id,
      atomic_numbers: Uint8Array.from([6, 8]),
      pbc: [true, false, true],
      options: { tolerance: 1.1 },
    },
    positions,
    lattice_matrix: [
      [10, 0, 0],
      [0, 11, 0],
      [0, 0, 12],
    ],
  }
}

afterEach(() => {
  set_bond_worker_runtime_for_tests(null)
})

describe(`position texture layout`, () => {
  test(`uses a bounded 2D layout with zero-addressable padding`, () => {
    expect(position_texture_shape(0)).toEqual({
      width: 1,
      height: 1,
      float_count: 4,
    })
    expect(position_texture_shape(POSITION_TEXTURE_ROW_ATOMS + 1)).toEqual({
      width: POSITION_TEXTURE_ROW_ATOMS,
      height: 2,
      float_count: POSITION_TEXTURE_ROW_ATOMS * 2 * 4,
    })
  })
})

describe(`trajectory messages in the worker`, () => {
  test(`returns an exact typed graph and padded RGBA positions through transfers`, async () => {
    const posted: Array<{ msg: Record<string, unknown>; transfer: Transferable[] }> = []
    const scope: BondWorkerScope = {
      onmessage: null,
      postMessage: (msg, transfer = []) => {
        posted.push({ msg: msg as Record<string, unknown>, transfer })
      },
    }
    const free = vi.fn()
    const detect = vi.fn(() => ({
      pairs: Uint32Array.from([0, 1]),
      images: Int8Array.from([1, 0, 0]),
      lengths: Float32Array.from([1.5]),
      strengths: Float32Array.from([0.75]),
      free,
    }))
    const glue = {
      initSync: vi.fn(),
      detect_bonds_radii_typed: detect,
      detect_bonds_radii: vi.fn(),
      detect_bonds_electronegativity: vi.fn(),
      detect_bonds_solid_angle: vi.fn(),
      detect_hydrogen_bonds: vi.fn(),
    } as unknown as BondWorkerGlue
    install_bond_worker(scope, glue)

    await scope.onmessage!({
      data: { id: -1, type: `init`, module: {}, thread_count: 1 },
    } as MessageEvent)
    const atom_count = POSITION_TEXTURE_ROW_ATOMS + 1
    const atomic_numbers = new Uint8Array(atom_count).fill(6)
    await scope.onmessage!({
      data: {
        id: 0,
        type: `trajectory_session_init`,
        session_id: 7,
        atomic_numbers,
        pbc: Uint8Array.from([1, 0, 1]),
        options_json: `{"tolerance":1.1}`,
      },
    } as MessageEvent)
    const positions = new Float32Array(atom_count * 3)
    positions.set([1, 2, 3], 0)
    positions.set([7, 8, 9], (atom_count - 1) * 3)
    await scope.onmessage!({
      data: {
        id: 1,
        type: `trajectory_frame_typed`,
        session_id: 7,
        positions,
        lattice: new Float64Array(9),
      },
    } as MessageEvent)

    const response = posted.at(-1)!
    const rgba = response.msg.gpu_positions_rgba as Float32Array
    const shape = position_texture_shape(atom_count)
    expect(detect).toHaveBeenCalledWith(
      positions,
      atomic_numbers,
      expect.any(Float64Array),
      expect.any(Uint8Array),
      `{"tolerance":1.1}`,
    )
    expect([...rgba.slice(0, 4)]).toEqual([1, 2, 3, 1])
    expect([
      ...rgba.slice((atom_count - 1) * 4, atom_count * 4),
    ]).toEqual([7, 8, 9, 1])
    expect(rgba.length).toBe(shape.float_count)
    expect([...rgba.slice(atom_count * 4)]).toEqual(
      new Array(shape.float_count - atom_count * 4).fill(0),
    )
    expect(response.transfer).toEqual([
      (response.msg.pairs as Uint32Array).buffer,
      (response.msg.images as Int8Array).buffer,
      (response.msg.lengths as Float32Array).buffer,
      (response.msg.strengths as Float32Array).buffer,
      rgba.buffer,
    ])
    expect(free).toHaveBeenCalledTimes(1)
  })

  test(`packs exact object-path positions without invoking bond detection`, async () => {
    const posted: Array<{ msg: Record<string, unknown>; transfer: Transferable[] }> = []
    const scope: BondWorkerScope = {
      onmessage: null,
      postMessage: (msg, transfer = []) => {
        posted.push({ msg: msg as Record<string, unknown>, transfer })
      },
    }
    const detect = vi.fn()
    const glue = {
      initSync: vi.fn(),
      detect_bonds_radii_typed: detect,
      detect_bonds_radii: vi.fn(),
      detect_bonds_electronegativity: vi.fn(),
      detect_bonds_solid_angle: vi.fn(),
      detect_hydrogen_bonds: vi.fn(),
    } as unknown as BondWorkerGlue
    install_bond_worker(scope, glue)

    await scope.onmessage!({
      data: { id: -1, type: `init`, module: {}, thread_count: 1 },
    } as MessageEvent)
    await scope.onmessage!({
      data: {
        id: 2,
        type: `trajectory_positions_rgba`,
        positions: Float32Array.from([2, 3, 4]),
      },
    } as MessageEvent)

    const response = posted.at(-1)!
    expect([...(response.msg.gpu_positions_rgba as Float32Array)]).toEqual([
      2, 3, 4, 1,
    ])
    expect(response.transfer).toEqual([
      (response.msg.gpu_positions_rgba as Float32Array).buffer,
    ])
    expect(detect).not.toHaveBeenCalled()
  })
})

describe(`RealBondWorkerHandle trajectory sessions`, () => {
  class ReplyingWorker {
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: ErrorEvent) => void) | null = null
    posted: Array<{ data: Record<string, unknown>; transfer: Transferable[] }> = []
    terminated = false

    postMessage(
      data: Record<string, unknown>,
      transfer: Transferable[] = [],
    ): void {
      this.posted.push({ data, transfer })
      const { id, type } = data
      queueMicrotask(() => {
        if (type === `trajectory_session_init`) {
          this.onmessage?.({
            data: { id, type: `trajectory_session_ready` },
          } as MessageEvent)
          return
        }
        if (type === `trajectory_frame_typed`) {
          this.onmessage?.({
            data: {
              id,
              pairs: Uint32Array.from([0, 1]),
              images: Int8Array.from([0, 0, 0]),
              lengths: Float32Array.from([1]),
              strengths: Float32Array.from([0.5]),
              gpu_positions_rgba: Float32Array.from([
                1, 2, 3, 1, 4, 5, 6, 1,
              ]),
              dt: `4.2`,
            },
          } as MessageEvent)
          return
        }
        if (type === `trajectory_positions_rgba`) {
          this.onmessage?.({
            data: {
              id,
              gpu_positions_rgba: Float32Array.from([9, 8, 7, 1]),
            },
          } as MessageEvent)
        }
      })
    }

    terminate(): void {
      this.terminated = true
    }
  }

  test(`initializes immutable session data once and transfers frame-only copies`, async () => {
    const worker = new ReplyingWorker()
    const handle = new RealBondWorkerHandle(
      worker as unknown as Worker,
      vi.fn(),
      `scalar`,
    )
    const first = trajectory_input()
    const original_positions_bytes = first.positions.byteLength
    const original_numbers_bytes = first.session.atomic_numbers.byteLength

    const result = await handle.compute_trajectory_frame_typed(first)
    await handle.compute_trajectory_frame_typed(
      trajectory_input(1, Float32Array.from([7, 8, 9, 10, 11, 12])),
    )

    expect(first.positions.byteLength).toBe(original_positions_bytes)
    expect(first.session.atomic_numbers.byteLength).toBe(original_numbers_bytes)
    expect(result.table.pairs).toEqual(Uint32Array.from([0, 1]))
    expect([...result.gpu_positions_rgba]).toEqual([
      1, 2, 3, 1, 4, 5, 6, 1,
    ])
    expect(worker.posted.map((entry) => entry.data.type)).toEqual([
      `trajectory_session_init`,
      `trajectory_frame_typed`,
      `trajectory_frame_typed`,
    ])
    const init = worker.posted[0]
    expect(init.data.atomic_numbers).not.toBe(first.session.atomic_numbers)
    expect(init.transfer).toContain(
      (init.data.atomic_numbers as Uint8Array).buffer,
    )
    const frame = worker.posted[1]
    expect(frame.data).not.toHaveProperty(`atomic_numbers`)
    expect(frame.data).not.toHaveProperty(`pbc`)
    expect(frame.data).not.toHaveProperty(`options_json`)
    expect(frame.data.positions).not.toBe(first.positions)
    expect(frame.transfer).toEqual([
      (frame.data.positions as Float32Array).buffer,
      (frame.data.lattice as Float64Array).buffer,
    ])
  })

  test(`reinitializes a changed session before its first frame`, async () => {
    const worker = new ReplyingWorker()
    const handle = new RealBondWorkerHandle(
      worker as unknown as Worker,
      vi.fn(),
      `scalar`,
    )
    await handle.compute_trajectory_frame_typed(trajectory_input(1))
    await handle.compute_trajectory_frame_typed(trajectory_input(2))

    expect(worker.posted.map((entry) => [
      entry.data.type,
      entry.data.session_id,
    ])).toEqual([
      [`trajectory_session_init`, 1],
      [`trajectory_frame_typed`, 1],
      [`trajectory_session_init`, 2],
      [`trajectory_frame_typed`, 2],
    ])
  })

  test(`packs positions on the worker without detaching the caller array`, async () => {
    const worker = new ReplyingWorker()
    const handle = new RealBondWorkerHandle(
      worker as unknown as Worker,
      vi.fn(),
      `scalar`,
    )
    const positions = Float32Array.from([9, 8, 7])
    const result = await handle.pack_trajectory_positions(positions)
    expect([...result]).toEqual([9, 8, 7, 1])
    expect(positions.byteLength).toBe(12)
    expect(worker.posted[0].data.positions).not.toBe(positions)
  })
})

describe(`trajectory runtime API`, () => {
  test(`preserves backend/elapsed reporting and never falls back on rejection`, async () => {
    let clock = 10
    const handle: BondWorkerHandle = {
      compute_typed: vi.fn(),
      compute_trajectory_frame_typed: vi.fn(async () => ({
        table: {
          pairs: Uint32Array.from([0, 1]),
          images: Int8Array.from([0, 0, 0]),
          lengths: Float32Array.from([1]),
          strengths: Float32Array.from([0.8]),
        },
        gpu_positions_rgba: Float32Array.from([
          1, 2, 3, 1, 4, 5, 6, 1,
        ]),
      })),
      pack_trajectory_positions: vi.fn(async () =>
        Float32Array.from([1, 2, 3, 1])
      ),
      terminate: vi.fn(),
    }
    const runtime = create_bond_worker_runtime({
      detect_capabilities: () => capabilities,
      create_threaded_worker: vi.fn(),
      create_scalar_worker: vi.fn(async () => handle),
      now: () => {
        const value = clock
        clock += 5
        return value
      },
    })
    set_bond_worker_runtime_for_tests(runtime)

    const result = await compute_trajectory_frame_typed(trajectory_input())
    expect(result.backend).toBe(`rust-wasm-scalar`)
    expect(result.elapsed_ms).toBe(5)
    expect([...result.gpu_positions_rgba]).toEqual([
      1, 2, 3, 1, 4, 5, 6, 1,
    ])
    expect(await pack_trajectory_positions_worker(
      Float32Array.from([1, 2, 3]),
    )).toEqual(Float32Array.from([1, 2, 3, 1]))

    vi.mocked(handle.compute_trajectory_frame_typed).mockRejectedValueOnce(
      new Error(`worker rejected`),
    )
    await expect(
      compute_trajectory_frame_typed(trajectory_input()),
    ).rejects.toThrow(`worker rejected`)
  })
})

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
  type BondWorkerTrajectorySessionGlue,
} from '$lib/structure/workers/bond-worker'
import {
  TrajectoryBondFrameLengthError,
} from '$lib/structure/trajectory-bond-session'

const capabilities = {
  cross_origin_isolated: false,
  shared_array_buffer: false,
  wasm_atomics: false,
  hardware_concurrency: 8,
}

function fake_trajectory_session(
  overrides: Partial<BondWorkerTrajectorySessionGlue> = {},
): BondWorkerTrajectorySessionGlue {
  return {
    compute_frame: vi.fn(() => ({
      pairs: Uint32Array.from([0, 1]),
      images: Int8Array.from([1, 0, 0]),
      lengths: Float32Array.from([1.5]),
      strengths: Float32Array.from([0.75]),
      free: vi.fn(),
    })),
    diagnostics_json: vi.fn(() => JSON.stringify({
      frame_count: 1,
      grid_cache_hits: 0,
      grid_rebuilds: 1,
      capacity_growths: 2,
    })),
    free: vi.fn(),
    ...overrides,
  }
}

function fake_glue(
  create_trajectory_bond_session: BondWorkerGlue[
    `create_trajectory_bond_session`
  ],
): BondWorkerGlue {
  return {
    initSync: vi.fn(),
    create_trajectory_bond_session,
    detect_bonds_radii_typed: vi.fn(),
    detect_bonds_radii: vi.fn(),
    detect_bonds_electronegativity: vi.fn(),
    detect_bonds_solid_angle: vi.fn(),
    detect_hydrogen_bonds: vi.fn(),
  }
}

function trajectory_input(
  session_id = 1,
  positions = Float32Array.from([1, 2, 3, 4, 5, 6]),
): TrajectoryTypedBondInput {
  return {
    session: {
      id: session_id,
      topology_fingerprint: `topology:${session_id}`,
      atomic_numbers: Uint8Array.from([6, 8]),
      stable_site_ids: Uint32Array.from([17, 29]),
      pbc: [true, false, true],
      options: { tolerance: 1.1 },
    },
    frame_idx: 12,
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
  test(`uses one Rust session for repeated exact frames and publishes diagnostics`, async () => {
    const posted: Array<{ msg: Record<string, unknown>; transfer: Transferable[] }> = []
    const scope: BondWorkerScope = {
      onmessage: null,
      postMessage: (msg, transfer = []) => {
        posted.push({ msg: msg as Record<string, unknown>, transfer })
      },
    }
    let frame_count = 0
    const table_free = vi.fn()
    const compute_frame = vi.fn(() => {
      frame_count += 1
      return {
        pairs: Uint32Array.from([0, 1]),
        images: Int8Array.from([1, 0, 0]),
        lengths: Float32Array.from([1.5]),
        strengths: Float32Array.from([0.75]),
        free: table_free,
      }
    })
    const rust = fake_trajectory_session({
      compute_frame,
      diagnostics_json: vi.fn(() => JSON.stringify({
        frame_count,
        grid_cache_hits: frame_count - 1,
        grid_rebuilds: 1,
        capacity_growths: 2,
      })),
    })
    const create_session = vi.fn(() => rust)
    const glue = fake_glue(create_session)
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
        topology_fingerprint: `topology:7`,
        atomic_numbers,
        stable_site_ids: null,
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
        topology_fingerprint: `topology:7`,
        frame_idx: 4,
        positions,
        lattice: new Float64Array(9),
      },
    } as MessageEvent)
    await scope.onmessage!({
      data: {
        id: 2,
        type: `trajectory_frame_typed`,
        session_id: 7,
        topology_fingerprint: `topology:7`,
        frame_idx: 5,
        positions,
        lattice: new Float64Array(9),
      },
    } as MessageEvent)

    const response = posted.at(-1)!
    const rgba = response.msg.gpu_positions_rgba as Float32Array
    const shape = position_texture_shape(atom_count)
    expect(create_session).toHaveBeenCalledTimes(1)
    expect(create_session).toHaveBeenCalledWith(
      7,
      atomic_numbers,
      expect.any(Uint8Array),
      `{"tolerance":1.1}`,
    )
    expect(compute_frame).toHaveBeenCalledTimes(2)
    expect(compute_frame).toHaveBeenLastCalledWith(
      positions,
      expect.any(Float64Array),
      5,
    )
    expect(glue.detect_bonds_radii_typed).not.toHaveBeenCalled()
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
    expect(response.msg.session_diagnostics).toEqual({
      frame_count: 2,
      grid_cache_hits: 1,
      grid_rebuilds: 1,
      capacity_growths: 2,
      session_initializations: 1,
      thread_count: 1,
    })
    expect(table_free).toHaveBeenCalledTimes(2)
  })

  test(`frees the old Rust session before creating its replacement`, async () => {
    const order: string[] = []
    const first = fake_trajectory_session({
      free: vi.fn(() => order.push(`free:1`)),
    })
    const second = fake_trajectory_session()
    const create_session = vi.fn((session_id: number) => {
      order.push(`create:${session_id}`)
      return session_id === 1 ? first : second
    })
    const scope: BondWorkerScope = {
      onmessage: null,
      postMessage: vi.fn(),
    }
    install_bond_worker(scope, fake_glue(create_session))
    await scope.onmessage!({
      data: { id: -1, type: `init`, module: {}, thread_count: 1 },
    } as MessageEvent)
    for (const session_id of [1, 2]) {
      await scope.onmessage!({
        data: {
          id: session_id,
          type: `trajectory_session_init`,
          session_id,
          topology_fingerprint: `topology:${session_id}`,
          atomic_numbers: Uint8Array.from([6, 8]),
          stable_site_ids: null,
          pbc: Uint8Array.from([1, 1, 1]),
          options_json: `{}`,
        },
      } as MessageEvent)
    }

    expect(order).toEqual([`create:1`, `free:1`, `create:2`])
    expect(create_session).toHaveBeenCalledTimes(2)
    expect(first.free).toHaveBeenCalledTimes(1)
  })

  test(`each replacement worker initializes exactly one new Rust session`, async () => {
    const create_session = vi.fn(() => fake_trajectory_session())
    for (let worker_idx = 0; worker_idx < 2; worker_idx++) {
      const scope: BondWorkerScope = {
        onmessage: null,
        postMessage: vi.fn(),
      }
      install_bond_worker(scope, fake_glue(create_session))
      await scope.onmessage!({
        data: { id: -1, type: `init`, module: {}, thread_count: 1 },
      } as MessageEvent)
      await scope.onmessage!({
        data: {
          id: worker_idx,
          type: `trajectory_session_init`,
          session_id: 7,
          topology_fingerprint: `topology:7`,
          atomic_numbers: Uint8Array.from([6, 8]),
          stable_site_ids: null,
          pbc: Uint8Array.from([1, 0, 1]),
          options_json: `{}`,
        },
      } as MessageEvent)
    }

    expect(create_session).toHaveBeenCalledTimes(2)
  })

  test(`surfaces a typed Rust frame error without publishing frame arrays`, async () => {
    const rust_error = Object.assign(new Error(
      `trajectory bond session 7 frame 4: positions length 3 != expected 6`,
    ), {
      name: `TrajectoryBondFrameLengthError`,
      session_id: 7,
      expected_atom_count: 2,
      expected_float_count: 6,
      actual_float_count: 3,
      frame_idx: 4,
    })
    const compute_frame = vi.fn(() => {
      throw rust_error
    })
    const rust = fake_trajectory_session({ compute_frame })
    const posted: Array<Record<string, unknown>> = []
    const scope: BondWorkerScope = {
      onmessage: null,
      postMessage: (message) => posted.push(
        message as Record<string, unknown>,
      ),
    }
    install_bond_worker(scope, fake_glue(vi.fn(() => rust)))
    await scope.onmessage!({
      data: { id: -1, type: `init`, module: {}, thread_count: 1 },
    } as MessageEvent)
    await scope.onmessage!({
      data: {
        id: 0,
        type: `trajectory_session_init`,
        session_id: 7,
        topology_fingerprint: `topology:7`,
        atomic_numbers: Uint8Array.from([6, 8]),
        stable_site_ids: null,
        pbc: Uint8Array.from([1, 0, 1]),
        options_json: `{}`,
      },
    } as MessageEvent)
    posted.length = 0
    await scope.onmessage!({
      data: {
        id: 1,
        type: `trajectory_frame_typed`,
        session_id: 7,
        topology_fingerprint: `topology:7`,
        frame_idx: 4,
        // Keep the JavaScript guard valid so this malformed-frame failure is
        // the Rust session's final defense, not a duplicate JS rejection.
        positions: new Float32Array(6),
        lattice: new Float64Array(9),
      },
    } as MessageEvent)

    expect(compute_frame).toHaveBeenCalledTimes(1)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      id: 1,
      error_name: `TrajectoryBondFrameLengthError`,
      session_id: 7,
      expected_atom_count: 2,
      expected_float_count: 6,
      actual_float_count: 3,
      frame_idx: 4,
    })
    expect(posted[0]).not.toHaveProperty(`pairs`)
    expect(posted[0]).not.toHaveProperty(`gpu_positions_rgba`)
  })

  test(`packs exact object-path positions without invoking bond detection`, async () => {
    const posted: Array<{ msg: Record<string, unknown>; transfer: Transferable[] }> = []
    const scope: BondWorkerScope = {
      onmessage: null,
      postMessage: (msg, transfer = []) => {
        posted.push({ msg: msg as Record<string, unknown>, transfer })
      },
    }
    const glue = fake_glue(vi.fn(() => fake_trajectory_session()))
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
    expect(glue.detect_bonds_radii_typed).not.toHaveBeenCalled()
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
              session_diagnostics: {
                thread_count: 99,
                session_initializations: 1,
                frame_count: 1,
                grid_cache_hits: 0,
                grid_rebuilds: 1,
                capacity_growths: 2,
              },
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
      `threaded`,
      4,
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
    expect(result.session_diagnostics).toEqual({
      thread_count: 4,
      session_initializations: 1,
      frame_count: 1,
      grid_cache_hits: 0,
      grid_rebuilds: 1,
      capacity_growths: 2,
    })
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
    expect(frame.data.frame_idx).toBe(first.frame_idx)
    expect(frame.data.topology_fingerprint).toBe(
      first.session.topology_fingerprint,
    )
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

  test(`reinitializes when the topology fingerprint changes under one session ID`, async () => {
    const worker = new ReplyingWorker()
    const handle = new RealBondWorkerHandle(
      worker as unknown as Worker,
      vi.fn(),
      `scalar`,
    )
    await handle.compute_trajectory_frame_typed(trajectory_input(1))
    const changed = trajectory_input(1)
    changed.session.topology_fingerprint = `topology:changed`
    await handle.compute_trajectory_frame_typed(changed)

    expect(worker.posted.map((entry) => entry.data.type)).toEqual([
      `trajectory_session_init`,
      `trajectory_frame_typed`,
      `trajectory_session_init`,
      `trajectory_frame_typed`,
    ])
  })

  test.each([3, 9])(
    `rejects %i position floats before posting any worker message`,
    async (float_count) => {
      const worker = new ReplyingWorker()
      const handle = new RealBondWorkerHandle(
        worker as unknown as Worker,
        vi.fn(),
        `scalar`,
      )

      await expect(handle.compute_trajectory_frame_typed(
        trajectory_input(1, new Float32Array(float_count)),
      )).rejects.toBeInstanceOf(TrajectoryBondFrameLengthError)
      expect(worker.posted).toHaveLength(0)
    },
  )

  test(`serializes each session init with its frame across concurrent callers`, async () => {
    const worker = new ReplyingWorker()
    const handle = new RealBondWorkerHandle(
      worker as unknown as Worker,
      vi.fn(),
      `scalar`,
    )

    await Promise.all([
      handle.compute_trajectory_frame_typed(trajectory_input(1)),
      handle.compute_trajectory_frame_typed(trajectory_input(2)),
    ])

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

describe(`trajectory frame length validation inside the worker`, () => {
  test.each([3, 9])(
    `rejects %i position floats before WASM or frame publication`,
    async (float_count) => {
      const posted: Array<{
        msg: Record<string, unknown>
        transfer: Transferable[]
      }> = []
      const scope: BondWorkerScope = {
        onmessage: null,
        postMessage: (msg, transfer = []) => {
          posted.push({ msg: msg as Record<string, unknown>, transfer })
        },
      }
      const compute_frame = vi.fn()
      const glue = fake_glue(vi.fn(() =>
        fake_trajectory_session({ compute_frame })
      ))
      install_bond_worker(scope, glue)
      await scope.onmessage!({
        data: { id: -1, type: `init`, module: {}, thread_count: 1 },
      } as MessageEvent)
      await scope.onmessage!({
        data: {
          id: 0,
          type: `trajectory_session_init`,
          session_id: 7,
          topology_fingerprint: `topology:7`,
          atomic_numbers: Uint8Array.from([6, 8]),
          stable_site_ids: null,
          pbc: Uint8Array.from([1, 0, 1]),
          options_json: `{}`,
        },
      } as MessageEvent)
      posted.length = 0

      await scope.onmessage!({
        data: {
          id: 1,
          type: `trajectory_frame_typed`,
          session_id: 7,
          topology_fingerprint: `topology:7`,
          frame_idx: 33,
          positions: new Float32Array(float_count),
          lattice: new Float64Array(9),
        },
      } as MessageEvent)

      expect(compute_frame).not.toHaveBeenCalled()
      expect(posted).toHaveLength(1)
      expect(posted[0].msg).toMatchObject({
        id: 1,
        error_name: `TrajectoryBondFrameLengthError`,
        session_id: 7,
        expected_atom_count: 2,
        expected_float_count: 6,
        actual_float_count: float_count,
        frame_idx: 33,
        error: expect.stringContaining(
          `trajectory bond session 7 frame 33`,
        ),
      })
      expect(posted[0].msg.error).toContain(
        `expected 2 atoms (6 position floats), received ${float_count}`,
      )
      expect(posted[0].transfer).toEqual([])
    },
  )

  test(`preserves typed frame-length details through RealBondWorkerHandle`, async () => {
    const replies: Array<Record<string, unknown>> = []
    const compute_frame = vi.fn()
    const glue = fake_glue(vi.fn(() =>
      fake_trajectory_session({ compute_frame })
    ))

    class LoopbackWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      terminated = false
      scope: BondWorkerScope = {
        onmessage: null,
        postMessage: (message) => {
          replies.push(message as Record<string, unknown>)
          queueMicrotask(() => {
            this.onmessage?.({ data: message } as MessageEvent)
          })
        },
      }

      constructor() {
        install_bond_worker(this.scope, glue)
      }

      async initialize(): Promise<void> {
        await this.scope.onmessage!({
          data: { id: -1, type: `init`, module: {}, thread_count: 1 },
        } as MessageEvent)
        await Promise.resolve()
        replies.length = 0
      }

      postMessage(data: Record<string, unknown>): void {
        const delivered = data.type === `trajectory_frame_typed`
          ? { ...data, positions: new Float32Array(3) }
          : data
        void this.scope.onmessage!({ data: delivered } as MessageEvent)
      }

      terminate(): void {
        this.terminated = true
      }
    }

    const worker = new LoopbackWorker()
    await worker.initialize()
    const handle = new RealBondWorkerHandle(
      worker as unknown as Worker,
      vi.fn(),
      `scalar`,
    )

    let failure: unknown
    try {
      await handle.compute_trajectory_frame_typed(trajectory_input())
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(TrajectoryBondFrameLengthError)
    expect(failure).toMatchObject({
      name: `TrajectoryBondFrameLengthError`,
      session_id: 1,
      expected_atom_count: 2,
      expected_float_count: 6,
      actual_float_count: 3,
      frame_idx: 12,
    })
    expect(compute_frame).not.toHaveBeenCalled()
    expect(replies.at(-1)).not.toHaveProperty(`pairs`)
    expect(replies.at(-1)).not.toHaveProperty(`gpu_positions_rgba`)
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
        session_diagnostics: {
          thread_count: 1,
          session_initializations: 1,
          frame_count: 1,
          grid_cache_hits: 0,
          grid_rebuilds: 1,
          capacity_growths: 2,
        },
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
    expect(result.threading_expected).toBe(false)
    expect(result.elapsed_ms).toBe(5)
    expect(result.session_diagnostics).toEqual({
      thread_count: 1,
      session_initializations: 1,
      frame_count: 1,
      grid_cache_hits: 0,
      grid_rebuilds: 1,
      capacity_growths: 2,
    })
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

  test(`retains threading-expected evidence after a scalar fallback`, async () => {
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
        session_diagnostics: {
          thread_count: 1,
          session_initializations: 1,
          frame_count: 1,
          grid_cache_hits: 0,
          grid_rebuilds: 1,
          capacity_growths: 2,
        },
      })),
      pack_trajectory_positions: vi.fn(async () => new Float32Array(0)),
      terminate: vi.fn(),
    }
    const runtime = create_bond_worker_runtime({
      detect_capabilities: () => ({
        cross_origin_isolated: true,
        shared_array_buffer: true,
        wasm_atomics: true,
        hardware_concurrency: 8,
      }),
      create_threaded_worker: vi.fn(async () => {
        throw new Error(`threaded init failed`)
      }),
      create_scalar_worker: vi.fn(async () => handle),
    })

    const result = await runtime.compute_trajectory_frame_typed(
      trajectory_input(),
    )
    expect(result.backend).toBe(`rust-wasm-scalar`)
    expect(result.threading_expected).toBe(true)
    expect(result.session_diagnostics.thread_count).toBe(1)
  })
})

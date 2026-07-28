import type { AnyStructure } from '$lib'
import type { IntMatrix3 } from '$lib/structure/supercell-operation'
import type { TrajectoryFrame } from '$lib/trajectory'
import type { BaseFrameProvider } from '$lib/trajectory/effective-frame-resolver'
import { create_effective_frame_resolver } from '$lib/trajectory/effective-frame-resolver'
import { iterate_effective_frames } from '$lib/trajectory/effective-frame-export'
import { OperationLedger } from '$lib/trajectory/operation-ledger'
import type { TrajectoryEditOp } from '$lib/trajectory/operations'
import { describe, expect, it } from 'vitest'

const cubic = (n: number, a: number): AnyStructure =>
  ({
    sites: Array.from({ length: n }, (_, idx) => ({
      species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
      abc: [idx / n, 0, 0],
      xyz: [(idx / n) * a, 0, 0],
      label: `C${idx + 1}`,
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
  }) as unknown as AnyStructure

const frame = (structure: AnyStructure, step: number): TrajectoryFrame => ({
  structure,
  step,
})

const make_source = (frames: (TrajectoryFrame | null)[]) => {
  const loads: number[] = []
  const load_base: BaseFrameProvider = (frame_idx) => {
    loads.push(frame_idx)
    return frames[frame_idx] ?? null
  }
  return { loads, load_base }
}

const scale = (factor: number): TrajectoryEditOp => ({ kind: `scale_geometry`, factor })
const supercell = (matrix: IntMatrix3): TrajectoryEditOp => ({
  kind: `supercell`,
  matrix,
  reorient: false,
})

const lattice_a = (fr: TrajectoryFrame | null) =>
  (fr?.structure as unknown as { lattice: { matrix: number[][] } }).lattice.matrix[0][0]

describe(`effective frame export iterator`, () => {
  it(`resolves only the requested range, one frame per pull`, async () => {
    const resolver = create_effective_frame_resolver(new OperationLedger())
    const { loads, load_base } = make_source([
      frame(cubic(1, 1), 0),
      frame(cubic(1, 2), 1),
      frame(cubic(1, 3), 2),
      frame(cubic(1, 4), 3),
    ])
    const iterator = iterate_effective_frames({
      resolver,
      load_base,
      start_frame: 1,
      end_frame: 3,
    })

    expect(loads).toEqual([])
    expect((await iterator.next()).value?.frame_idx).toBe(1)
    expect(loads).toEqual([1])
    expect((await iterator.next()).value?.frame_idx).toBe(2)
    expect(loads).toEqual([1, 2])
    await iterator.return(undefined)
    expect(loads).toEqual([1, 2])
  })

  it(`exports a current-scope operation on only its matching frame`, async () => {
    const ledger = new OperationLedger()
    ledger.append({ kind: `frame`, frame_idx: 1 }, scale(2))
    const resolver = create_effective_frame_resolver(ledger)
    const { loads, load_base } = make_source([
      frame(cubic(2, 2), 0),
      frame(cubic(2, 2), 1),
      frame(cubic(2, 2), 2),
    ])

    const exported: TrajectoryFrame[] = []
    for await (
      const { frame: effective } of iterate_effective_frames({
        resolver,
        load_base,
        start_frame: 0,
        end_frame: 2,
      })
    ) {
      if (effective) exported.push(effective)
    }

    expect(exported.map((fr) => fr.structure.sites[1].xyz[0])).toEqual([1, 2, 1])
    expect(loads).toEqual([0, 1, 2])
  })

  it(`preserves mixed all/current operation order in exported effective frames`, async () => {
    const ledger = new OperationLedger()
    ledger.append(
      { kind: `all` },
      { kind: `add`, element: `H`, position: [1, 0, 0] },
    )
    ledger.append({ kind: `frame`, frame_idx: 1 }, scale(2))
    const resolver = create_effective_frame_resolver(ledger)
    const { loads, load_base } = make_source([
      frame(cubic(1, 2), 10),
      frame(cubic(1, 2), 20),
    ])

    const exported: { frame_idx: number; frame: TrajectoryFrame | null }[] = []
    for await (
      const effective of iterate_effective_frames({
        resolver,
        load_base,
        start_frame: 0,
        end_frame: 1,
      })
    ) exported.push(effective)

    expect(exported.map(({ frame_idx }) => frame_idx)).toEqual([0, 1])
    expect(exported.map(({ frame: fr }) => fr?.step)).toEqual([10, 20])
    expect(exported.map(({ frame: fr }) => fr?.structure.sites.length)).toEqual([2, 2])
    expect(exported.map(({ frame: fr }) => lattice_a(fr))).toEqual([2, 4])
    expect(exported.map(({ frame: fr }) => fr?.structure.sites[1].xyz)).toEqual([
      [1, 0, 0],
      [2, 0, 0],
    ])
    expect(loads).toEqual([0, 1])
  })

  it(`exports all-scope variable-N and variable-cell frames from their own bases`, async () => {
    const ledger = new OperationLedger()
    ledger.append(
      { kind: `all` },
      supercell([[2, 0, 0], [0, 1, 0], [0, 0, 1]]),
    )
    const resolver = create_effective_frame_resolver(ledger)
    const { loads, load_base } = make_source([
      frame(cubic(2, 2), 10),
      frame(cubic(3, 4), 20),
    ])

    const exported: TrajectoryFrame[] = []
    for await (
      const { frame: effective } of iterate_effective_frames({
        resolver,
        load_base,
        start_frame: 0,
        end_frame: 1,
      })
    ) {
      if (effective) exported.push(effective)
    }

    expect(exported.map((fr) => fr.structure.sites.length)).toEqual([4, 6])
    expect(exported.map(lattice_a)).toEqual([4, 8])
    expect(exported.map((fr) => fr.step)).toEqual([10, 20])
    expect(loads).toEqual([0, 1])
  })

  it(`does not load or yield when the signal is already aborted`, async () => {
    const resolver = create_effective_frame_resolver(new OperationLedger())
    const { loads, load_base } = make_source([frame(cubic(1, 1), 0)])
    const controller = new AbortController()
    controller.abort()
    const iterator = iterate_effective_frames({
      resolver,
      load_base,
      start_frame: 0,
      end_frame: 0,
      signal: controller.signal,
    })

    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(loads).toEqual([])
  })

  it(`stops before loading or yielding the next frame after abort`, async () => {
    const resolver = create_effective_frame_resolver(new OperationLedger())
    const { loads, load_base } = make_source([
      frame(cubic(1, 1), 0),
      frame(cubic(1, 1), 1),
    ])
    const controller = new AbortController()
    const iterator = iterate_effective_frames({
      resolver,
      load_base,
      start_frame: 0,
      end_frame: 1,
      signal: controller.signal,
    })

    expect((await iterator.next()).value?.frame_idx).toBe(0)
    controller.abort()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(loads).toEqual([0])
  })

  it(`suppresses a frame resolved after abort and never loads a later index`, async () => {
    const resolver = create_effective_frame_resolver(new OperationLedger())
    const loads: number[] = []
    let release!: (value: TrajectoryFrame) => void
    let mark_started!: () => void
    const started = new Promise<void>((resolve) => { mark_started = resolve })
    const load_base: BaseFrameProvider = (frame_idx) => {
      loads.push(frame_idx)
      mark_started()
      return new Promise<TrajectoryFrame>((resolve) => { release = resolve })
    }
    const controller = new AbortController()
    const iterator = iterate_effective_frames({
      resolver,
      load_base,
      start_frame: 0,
      end_frame: 1,
      signal: controller.signal,
    })

    const pending = iterator.next()
    await started
    controller.abort()
    release(frame(cubic(1, 1), 0))

    expect(await pending).toEqual({ done: true, value: undefined })
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(loads).toEqual([0])
  })

  it(`propagates resolver failures`, async () => {
    const ledger = new OperationLedger()
    ledger.append(
      { kind: `all` },
      supercell([[2, 0, 0], [0, 1, 0], [0, 0, 1]]),
    )
    const resolver = create_effective_frame_resolver(ledger)
    const molecule = frame({ sites: cubic(2, 2).sites } as AnyStructure, 0)
    const { loads, load_base } = make_source([molecule])
    const iterator = iterate_effective_frames({
      resolver,
      load_base,
      start_frame: 0,
      end_frame: 0,
    })

    await expect(iterator.next()).rejects.toThrow(/Supercell rejected/)
    expect(loads).toEqual([0])
  })
})

import type { AnyStructure } from '$lib'
import type { IntMatrix3 } from '$lib/structure/supercell-operation'
import type { TrajectoryFrame } from '$lib/trajectory'
import type { BaseFrameProvider } from '$lib/trajectory/effective-frame-resolver'
import { create_effective_frame_resolver } from '$lib/trajectory/effective-frame-resolver'
import { OperationLedger } from '$lib/trajectory/operation-ledger'
import type { TrajectoryEditOp } from '$lib/trajectory/operations'
import { describe, expect, it } from 'vitest'

/** Cubic structure with `n` sites and lattice parameter `a`. */
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

const lattice_of = (fr: TrajectoryFrame | null) =>
  (fr?.structure as unknown as { lattice: { matrix: number[][] } }).lattice

/** Base-frame provider over an in-test frame array, counting loads. */
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

describe(`effective-frame resolver`, () => {
  it(`applies current-only A then all-frame B on the target frame, B alone elsewhere`, async () => {
    const ledger = new OperationLedger()
    ledger.append({ kind: `frame`, frame_idx: 1 }, supercell([[2, 0, 0], [0, 1, 0], [0, 0, 1]]))
    ledger.append({ kind: `all` }, scale(2))
    const resolver = create_effective_frame_resolver(ledger)
    const { load_base } = make_source([frame(cubic(2, 2), 0), frame(cubic(2, 2), 1)])

    const f1 = await resolver.resolve(1, load_base)
    expect(f1?.structure.sites).toHaveLength(4) // supercell applied on frame 1
    expect(lattice_of(f1).matrix[0][0]).toBeCloseTo(8) // 2 (base) ×2 (supercell) ×2 (scale)

    const f0 = await resolver.resolve(0, load_base)
    expect(f0?.structure.sites).toHaveLength(2) // B alone on every other frame
    expect(lattice_of(f0).matrix[0][0]).toBeCloseTo(4) // 2 (base) ×2 (scale)
    expect(f0?.structure.sites[1].xyz[0]).toBeCloseTo(2)
  })

  it(`applies non-commuting entries strictly in seq order`, async () => {
    // Two det-1 shears: M2·(M1·L) ≠ M1·(M2·L), so the lattice reveals order.
    const ledger = new OperationLedger()
    ledger.append(
      { kind: `frame`, frame_idx: 0 },
      supercell([[1, 1, 0], [0, 1, 0], [0, 0, 1]]),
    )
    ledger.append({ kind: `all` }, supercell([[1, 0, 0], [1, 1, 0], [0, 0, 1]]))
    const resolver = create_effective_frame_resolver(ledger)
    const { load_base } = make_source([frame(cubic(1, 2), 0), frame(cubic(1, 2), 1)])

    const f0 = await resolver.resolve(0, load_base)
    expect(f0?.structure.sites).toHaveLength(1) // both dets are 1
    // A then B: M2·(M1·L). Reversed order would give [[4,2,0],[2,2,0],[0,0,2]].
    expect(lattice_of(f0).matrix).toEqual([[2, 2, 0], [2, 4, 0], [0, 0, 2]])

    const f1 = await resolver.resolve(1, load_base)
    expect(lattice_of(f1).matrix).toEqual([[2, 0, 0], [2, 2, 0], [0, 0, 2]])
  })

  it(`skips inactive entries and reactivates without double-applying`, async () => {
    const ledger = new OperationLedger()
    const entry = ledger.append({ kind: `all` }, scale(2))
    const resolver = create_effective_frame_resolver(ledger)
    const { load_base } = make_source([frame(cubic(2, 2), 0)])

    const scaled = await resolver.resolve(0, load_base)
    expect(scaled?.structure.sites[1].xyz[0]).toBeCloseTo(2)

    ledger.set_active(entry.id, false)
    const restored = await resolver.resolve(0, load_base)
    expect(restored?.structure.sites[1].xyz[0]).toBeCloseTo(1)
    expect(lattice_of(restored).matrix[0][0]).toBeCloseTo(2)

    ledger.set_active(entry.id, true)
    const reapplied = await resolver.resolve(0, load_base)
    expect(reapplied?.structure.sites[1].xyz[0]).toBeCloseTo(2) // exactly ×2, never ×4
    expect(lattice_of(reapplied).matrix[0][0]).toBeCloseTo(4)
  })

  it(`resolves variable N and variable cell frames from each frame's own base`, async () => {
    const ledger = new OperationLedger()
    ledger.append({ kind: `all` }, supercell([[2, 0, 0], [0, 1, 0], [0, 0, 1]]))
    const resolver = create_effective_frame_resolver(ledger)
    const { load_base } = make_source([frame(cubic(2, 2), 0), frame(cubic(3, 4), 1)])

    const f0 = await resolver.resolve(0, load_base)
    expect(f0?.structure.sites).toHaveLength(4)
    expect(lattice_of(f0).matrix[0][0]).toBeCloseTo(4)

    const f1 = await resolver.resolve(1, load_base)
    expect(f1?.structure.sites).toHaveLength(6)
    expect(lattice_of(f1).matrix[0][0]).toBeCloseTo(8)
  })

  it(`never mutates the decoded base frame`, async () => {
    const ledger = new OperationLedger()
    ledger.append({ kind: `all` }, supercell([[2, 0, 0], [0, 1, 0], [0, 0, 1]]))
    ledger.append({ kind: `all` }, scale(2))
    const resolver = create_effective_frame_resolver(ledger)
    const base = frame(cubic(2, 2), 0)
    const before = JSON.stringify(base)
    const { load_base } = make_source([base])

    const effective = await resolver.resolve(0, load_base)
    expect(effective).not.toBe(base)
    expect(effective?.structure).not.toBe(base.structure)
    expect(JSON.stringify(base)).toBe(before)
  })

  it(`re-resolves from the pristine base — no double transform`, async () => {
    const ledger = new OperationLedger()
    ledger.append({ kind: `all` }, scale(2))
    const resolver = create_effective_frame_resolver(ledger)
    const { loads, load_base } = make_source([frame(cubic(2, 2), 0)])

    const first = await resolver.resolve(0, load_base)
    resolver.invalidate(0)
    const second = await resolver.resolve(0, load_base)
    expect(loads).toEqual([0, 0])
    expect(second?.structure.sites[1].xyz[0]).toBeCloseTo(2)
    expect(second?.structure.sites[1].xyz[0])
      .toBeCloseTo(first?.structure.sites[1].xyz[0] as number)

    resolver.clear()
    const third = await resolver.resolve(0, load_base)
    expect(loads).toEqual([0, 0, 0])
    expect(third?.structure.sites[1].xyz[0]).toBeCloseTo(2)
  })

  it(`caches by (frame_idx, ledger_revision)`, async () => {
    const ledger = new OperationLedger()
    ledger.append({ kind: `all` }, scale(2))
    const resolver = create_effective_frame_resolver(ledger)
    const { loads, load_base } = make_source([frame(cubic(2, 2), 0), frame(cubic(2, 2), 1)])

    const first = await resolver.resolve(0, load_base)
    const cached = await resolver.resolve(0, load_base)
    expect(cached).toBe(first) // same revision → cached object, no recompute
    expect(loads).toEqual([0])

    await resolver.resolve(1, load_base) // separate frame → separate cache key
    expect(loads).toEqual([0, 1])

    ledger.append({ kind: `all` }, scale(3)) // revision bump invalidates
    const recomputed = await resolver.resolve(0, load_base)
    expect(recomputed).not.toBe(first)
    expect(loads).toEqual([0, 1, 0])
    expect(recomputed?.structure.sites[1].xyz[0]).toBeCloseTo(6)
  })

  it(`does not retain zero-op frames in the cache`, async () => {
    const ledger = new OperationLedger()
    ledger.append({ kind: `frame`, frame_idx: 1 }, scale(2)) // matches only frame 1
    const resolver = create_effective_frame_resolver(ledger)
    const { loads, load_base } = make_source([frame(cubic(2, 2), 0), frame(cubic(2, 2), 1)])

    const first = await resolver.resolve(0, load_base) // zero matching entries
    const again = await resolver.resolve(0, load_base)
    expect(first?.structure.sites[1].xyz[0]).toBeCloseTo(1) // untransformed base
    expect(again?.structure.sites[1].xyz[0]).toBeCloseTo(1)
    expect(loads).toEqual([0, 0]) // base re-loaded — nothing pinned in the LRU

    const with_ops = await resolver.resolve(1, load_base) // with-ops path still caches
    const cached = await resolver.resolve(1, load_base)
    expect(cached).toBe(with_ops) // same revision → cached object, no recompute
    expect(loads).toEqual([0, 0, 1])
  })

  it(`iterate yields effective frames for the requested indices in order`, async () => {
    const ledger = new OperationLedger()
    ledger.append({ kind: `all` }, scale(2))
    const resolver = create_effective_frame_resolver(ledger)
    const { loads, load_base } = make_source([frame(cubic(2, 2), 0), frame(cubic(3, 4), 1)])

    const seen: { frame_idx: number; x: number | undefined }[] = []
    for await (const { frame_idx, frame: fr } of resolver.iterate([0, 1], load_base)) {
      seen.push({ frame_idx, x: fr?.structure.sites[1].xyz[0] })
    }
    expect(seen.map((s) => s.frame_idx)).toEqual([0, 1])
    expect(seen[0].x).toBeCloseTo(2)
    expect(seen[1].x).toBeCloseTo(8 / 3)
    expect(loads).toEqual([0, 1])
  })

  it.each([`invalidate`, `clear`] as const)(
    `%s drops an already in-flight resolve instead of publishing its stale frame`,
    async (method) => {
      const ledger = new OperationLedger()
      ledger.append({ kind: `all` }, scale(2))
      const resolver = create_effective_frame_resolver(ledger)
      let finish!: (value: TrajectoryFrame) => void
      const pending = resolver.resolve(
        0,
        () => new Promise<TrajectoryFrame>((resolve) => { finish = resolve }),
      )

      if (method === `invalidate`) resolver.invalidate(0)
      else resolver.clear()
      finish(frame(cubic(2, 2), 0))

      expect(await pending).toBeNull()
    },
  )

  it(`propagates executor failures without caching a partial result`, async () => {
    const ledger = new OperationLedger()
    const entry = ledger.append(
      { kind: `all` },
      supercell([[2, 0, 0], [0, 1, 0], [0, 0, 1]]),
    )
    const resolver = create_effective_frame_resolver(ledger)
    const molecule = { structure: { sites: cubic(2, 2).sites } as AnyStructure, step: 0 }
    const { load_base } = make_source([molecule])

    await expect(resolver.resolve(0, load_base)).rejects.toThrow(/Supercell rejected/)

    ledger.set_active(entry.id, false)
    const base = await resolver.resolve(0, load_base)
    expect(base?.structure.sites).toHaveLength(2)
  })
})

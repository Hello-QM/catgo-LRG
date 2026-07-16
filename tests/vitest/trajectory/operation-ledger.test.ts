import type { OpScope } from '$lib/trajectory/operation-ledger'
import { OperationLedger } from '$lib/trajectory/operation-ledger'
import type { TrajectoryEditOp } from '$lib/trajectory/operations'
import { describe, expect, it } from 'vitest'

const scale = (factor: number): TrajectoryEditOp => ({ kind: `scale_geometry`, factor })
const all: OpScope = { kind: `all` }
const frame = (frame_idx: number): OpScope => ({ kind: `frame`, frame_idx })

describe(`OperationLedger`, () => {
  it(`appends entries with monotonically increasing seq and bumps revision`, () => {
    const ledger = new OperationLedger()
    expect(ledger.revision).toBe(0)
    const a = ledger.append(frame(1), scale(2))
    const b = ledger.append(all, scale(3))
    expect(a.seq).toBeLessThan(b.seq)
    expect(a.active && b.active).toBe(true)
    expect(a.id).not.toBe(b.id)
    expect(ledger.revision).toBe(2)
    expect(ledger.entries.map((entry) => entry.seq)).toEqual([a.seq, b.seq])
  })

  it(`matches all-scope entries to every frame, frame-scope entries to theirs only`, () => {
    const ledger = new OperationLedger()
    const a = ledger.append(frame(1), scale(2))
    const b = ledger.append(all, scale(3))
    expect(ledger.active_entries_for_frame(1).map((entry) => entry.id))
      .toEqual([a.id, b.id])
    expect(ledger.active_entries_for_frame(0).map((entry) => entry.id))
      .toEqual([b.id])
  })

  it(`skips inactive entries without renumbering seq`, () => {
    const ledger = new OperationLedger()
    const a = ledger.append(all, scale(2))
    const b = ledger.append(all, scale(3))
    const revision = ledger.revision
    expect(ledger.set_active(a.id, false)).toBe(true)
    expect(ledger.revision).toBe(revision + 1)
    expect(ledger.active_entries_for_frame(0).map((entry) => entry.id))
      .toEqual([b.id])
    // The undone entry keeps its seq — no renumbering while inactive.
    expect(ledger.entries.map((entry) => entry.seq)).toEqual([a.seq, b.seq])
    ledger.set_active(a.id, true)
    expect(ledger.active_entries_for_frame(0).map((entry) => entry.seq))
      .toEqual([a.seq, b.seq])
  })

  it(`ignores no-op set_active and unknown ids without bumping revision`, () => {
    const ledger = new OperationLedger()
    const a = ledger.append(all, scale(2))
    const revision = ledger.revision
    expect(ledger.set_active(a.id, true)).toBe(true)
    expect(ledger.revision).toBe(revision)
    expect(ledger.set_active(`missing`, false)).toBe(false)
    expect(ledger.revision).toBe(revision)
  })

  it(`clones independently for pane isolation`, () => {
    const source = new OperationLedger()
    const a = source.append(all, scale(2))
    const copy = source.clone()
    expect(copy.entries.map((entry) => entry.id)).toEqual([a.id])
    copy.append(frame(0), scale(3))
    copy.set_active(a.id, false)
    expect(source.entries).toHaveLength(1)
    expect(source.entries[0].active).toBe(true)
    expect(source.active_entries_for_frame(0)).toHaveLength(1)
  })
})

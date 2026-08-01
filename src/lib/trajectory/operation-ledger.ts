/**
 * Ordered, scoped operation ledger (design §9.3).
 *
 * Each trajectory pane owns ONE ledger over its immutable base frame source.
 * Entries are ordered by `seq` (assigned at append, never renumbered) and are
 * either `all`-scoped or scoped to a single frame. Undo does not remove an
 * entry — it flips `active` off, so redo restores it at its original position
 * in the sequence. Every logical change bumps `revision`, which is the cache
 * key half of the effective-frame resolver's `(frame_idx, ledger_revision)`.
 */
import type { TrajectoryEditOp } from './operations'

/** Where a ledger entry applies (design §9.2/§9.3). */
export type OpScope = { kind: `all` } | { kind: `frame`; frame_idx: number }

export type LedgerEntry = {
  id: string
  seq: number
  scope: OpScope
  op: TrajectoryEditOp
  active: boolean
}

function clone_op(op: TrajectoryEditOp): TrajectoryEditOp {
  switch (op.kind) {
    case `supercell`:
      return {
        ...op,
        matrix: [
          [op.matrix[0][0], op.matrix[0][1], op.matrix[0][2]],
          [op.matrix[1][0], op.matrix[1][1], op.matrix[1][2]],
          [op.matrix[2][0], op.matrix[2][1], op.matrix[2][2]],
        ],
      }
    case `delete`:
      return { ...op, site_indices: [...op.site_indices] }
    case `add`:
      return { ...op, position: [...op.position] }
    case `replace`:
      return { ...op, site_indices: [...op.site_indices] }
    case `manipulate`:
      return {
        ...op,
        displacements: new Map(
          [...op.displacements].map(([idx, delta]) => [idx, [...delta]]),
        ),
      }
    case `set_selective_dynamics`:
      return {
        ...op,
        values: op.values.map((value) => value ? [...value] : null),
      }
    case `scale_geometry`:
      return { ...op }
  }
}

/** True when `scope` covers `frame_idx`. */
export function scope_matches_frame(scope: OpScope, frame_idx: number): boolean {
  return scope.kind === `all` || scope.frame_idx === frame_idx
}

export class OperationLedger {
  #entries: LedgerEntry[] = []
  #next_seq = 0
  #revision = 0

  /** Monotonic revision — bumped by append and by any effective activity change. */
  get revision(): number {
    return this.#revision
  }

  /** All entries (active and inactive) in `seq` order. Treat as read-only. */
  get entries(): readonly LedgerEntry[] {
    return this.#entries
  }

  /** Record an operation. New entries are active and ordered after all others. */
  append(scope: OpScope, op: TrajectoryEditOp): LedgerEntry {
    const entry: LedgerEntry = {
      id: `op-${this.#next_seq}`,
      seq: this.#next_seq,
      scope,
      op,
      active: true,
    }
    this.#next_seq += 1
    this.#entries.push(entry)
    this.#revision += 1
    return entry
  }

  /**
   * Toggle an entry active/inactive (undo/redo, design §9.5) without
   * renumbering `seq`. Returns false for unknown ids; bumps `revision` only
   * when the activity actually changes.
   */
  set_active(id: string, active: boolean): boolean {
    const idx = this.#entries.findIndex((entry) => entry.id === id)
    if (idx < 0) return false
    if (this.#entries[idx].active !== active) {
      this.#entries[idx] = { ...this.#entries[idx], active }
      this.#revision += 1
    }
    return true
  }

  /** Active entries matching `frame_idx`, in `seq` order. */
  active_entries_for_frame(frame_idx: number): LedgerEntry[] {
    return this.#entries.filter(
      (entry) => entry.active && scope_matches_frame(entry.scope, frame_idx),
    )
  }

  /** Independent copy for pane duplication — appends/toggles stay pane-local. */
  clone(): OperationLedger {
    const copy = new OperationLedger()
    copy.#entries = this.#entries.map((entry) => ({
      ...entry,
      scope: { ...entry.scope },
      op: clone_op(entry.op),
    }))
    copy.#next_seq = this.#next_seq
    copy.#revision = this.#revision
    return copy
  }
}

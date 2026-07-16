import type { PymatgenStructure } from '$lib'
import type { IntMatrix3, SupercellOp } from '$lib/structure/supercell-operation'
import { execute_supercell_op_sync } from '$lib/structure/supercell-operation'
import type { TrajectoryFrame, TrajectoryType } from '$lib/trajectory'
import { create_effective_frame_resolver } from '$lib/trajectory/effective-frame-resolver'
import { OperationLedger, type OpScope } from '$lib/trajectory/operation-ledger'
import {
  commit_supercell_transaction,
  toggle_supercell_history_entry,
  type SupercellTransactionCommitHooks,
  type TrajectoryEditMode,
} from '$lib/trajectory/supercell-transactions'
import { describe, expect, it, vi } from 'vitest'

const DOUBLE_X: IntMatrix3 = [[2, 0, 0], [0, 1, 0], [0, 0, 1]]
const OP: SupercellOp = { kind: `supercell`, matrix: DOUBLE_X, reorient: false }

function structure(a: number, elements: string[] = [`H`]): PymatgenStructure {
  return {
    id: `cell-${a}-${elements.join(``)}`,
    lattice: {
      matrix: [[a, 0, 0], [0, a, 0], [0, 0, a]],
      pbc: [true, true, true],
      volume: a ** 3,
      a,
      b: a,
      c: a,
      alpha: 90,
      beta: 90,
      gamma: 90,
    },
    sites: elements.map((element, idx) => ({
      species: [{ element, occu: 1, oxidation_state: 0 }],
      abc: [idx / Math.max(1, elements.length), 0, 0],
      xyz: [idx * a / Math.max(1, elements.length), 0, 0],
      label: element,
      properties: {},
    })),
    charge: 0,
  } as PymatgenStructure
}

function frame(step: number, a = 2, elements?: string[]): TrajectoryFrame {
  return { step, structure: structure(a, elements) }
}

function trajectory(frames = [frame(0), frame(1, 3)]): TrajectoryType {
  const operation_ledger = new OperationLedger()
  return {
    frames,
    operation_ledger,
    effective_frames: create_effective_frame_resolver(operation_ledger),
  }
}

/** Trajectory-shaped commit/toggle hooks: replace/publish mutate in-memory
 * frames, effective-frame invalidation reaches the real resolver, every other
 * derived-cache hook is a spy. */
function txn_hooks(owner: TrajectoryType, ledger: OperationLedger) {
  const hooks = {
    ledger,
    replace_frame: vi.fn((idx: number, next: TrajectoryFrame) => {
      if (owner.frame_loader) return
      owner.frames[idx] = next
    }),
    publish_captured_frame: vi.fn(),
    clear_position_cache: vi.fn(),
    clear_force_cache: vi.fn(),
    invalidate_effective_frames: vi.fn((scope: OpScope) => {
      if (scope.kind === `all`) owner.effective_frames?.clear()
      else owner.effective_frames?.invalidate(scope.frame_idx)
    }),
    clear_typed_frame_buffers: vi.fn(),
    reset_topology: vi.fn(),
    invalidate_bond_caches: vi.fn(),
    invalidate_warmup: vi.fn(),
    bump_position_version: vi.fn(),
    bump_topology_version: vi.fn(),
    history_token: (entry: { id: string }) => `trajectory-supercell-${entry.id}`,
  } satisfies SupercellTransactionCommitHooks & Record<string, unknown>
  return hooks
}

function commit(
  owner: TrajectoryType,
  ledger: OperationLedger,
  mode: TrajectoryEditMode,
  frame_idx: number,
  hooks: SupercellTransactionCommitHooks,
): string {
  const captured = owner.frames[frame_idx]
  const execution = execute_supercell_op_sync(
    captured.structure as PymatgenStructure,
    OP,
  )
  return commit_supercell_transaction({
    token: {
      owner,
      frame_idx,
      frame: captured,
      mode,
      ledger,
      ledger_revision: ledger.revision,
      request_id: 1,
    },
    op: OP,
    execution,
  }, hooks)
}

describe(`trajectory supercell external history (Build T5)`, () => {
  it(`indexed undo flips the ledger entry inactive; redo re-activates it`, async () => {
    const ledger = new OperationLedger()
    const resolver = create_effective_frame_resolver(ledger)
    const base = frame(0)
    const owner: TrajectoryType = {
      frames: [base],
      frame_loader: {} as never,
      operation_ledger: ledger,
      effective_frames: resolver,
    }
    const hooks = txn_hooks(owner, ledger)

    const token = commit(owner, ledger, `edit-all`, 0, hooks)
    expect(token).toBe(`trajectory-supercell-op-0`)
    expect(ledger.entries[0].active).toBe(true)
    const applied = await resolver.resolve(0, () => base)
    expect(applied?.structure.sites).toHaveLength(2)

    const revision_before = ledger.revision
    const undone_ok = toggle_supercell_history_entry(
      { entry_id: `op-0`, active: false, scope: { kind: `all` } },
      hooks,
    )
    expect(undone_ok).toBe(true)
    expect(ledger.entries[0].active).toBe(false)
    expect(ledger.revision).toBeGreaterThan(revision_before)
    const undone = await resolver.resolve(0, () => base)
    expect(undone?.structure.sites).toHaveLength(1)

    const redone_ok = toggle_supercell_history_entry(
      { entry_id: `op-0`, active: true, scope: { kind: `all` } },
      hooks,
    )
    expect(redone_ok).toBe(true)
    expect(ledger.entries[0].active).toBe(true)
    const redone = await resolver.resolve(0, () => base)
    expect(redone?.structure.sites).toHaveLength(2)
  })

  it(`returns false for an unknown entry id without touching any cache`, () => {
    const owner = trajectory()
    const ledger = owner.operation_ledger!
    const hooks = txn_hooks(owner, ledger)

    const ok = toggle_supercell_history_entry(
      { entry_id: `op-99`, active: false, scope: { kind: `all` } },
      hooks,
    )

    expect(ok).toBe(false)
    expect(hooks.clear_position_cache).not.toHaveBeenCalled()
    expect(hooks.invalidate_effective_frames).not.toHaveBeenCalled()
    expect(hooks.bump_position_version).not.toHaveBeenCalled()
    expect(hooks.bump_topology_version).not.toHaveBeenCalled()
    expect(hooks.publish_captured_frame).not.toHaveBeenCalled()
  })

  it(`undo restores the captured in-memory frame reference (current scope)`, () => {
    const owner = trajectory()
    const ledger = owner.operation_ledger!
    const base_ref = owner.frames[0]
    const hooks = txn_hooks(owner, ledger)

    commit(owner, ledger, `edit-current`, 0, hooks)
    expect(owner.frames[0]).not.toBe(base_ref)
    expect(owner.frames[0].structure.sites).toHaveLength(2)

    const restore = vi.fn(() => {
      owner.frames[0] = base_ref
      return { frame_idx: 0, frame: base_ref }
    })
    const ok = toggle_supercell_history_entry(
      {
        entry_id: ledger.entries[0].id,
        active: false,
        scope: { kind: `frame`, frame_idx: 0 },
        restore,
      },
      hooks,
    )

    expect(ok).toBe(true)
    expect(restore).toHaveBeenCalledOnce()
    // The exact pre-op immutable frame reference is back — no rebuilt copy.
    expect(owner.frames[0]).toBe(base_ref)
    expect(owner.frames[1].structure.sites).toHaveLength(1)
    expect(hooks.publish_captured_frame).toHaveBeenLastCalledWith(0, base_ref)
  })

  it(`undo restores every in-memory frame reference (all scope); redo re-applies`, async () => {
    const owner = trajectory([frame(0, 2, [`H`]), frame(1, 3, [`O`, `O`])])
    const ledger = owner.operation_ledger!
    const base_refs = [...owner.frames]
    const hooks = txn_hooks(owner, ledger)

    commit(owner, ledger, `edit-all`, 0, hooks)
    // Materialize the non-captured frame the way scrubbing would.
    const materialized = await owner.effective_frames!.resolve(1, () => base_refs[1])
    owner.frames[1] = materialized!
    expect(owner.frames[0].structure.sites).toHaveLength(2)
    expect(owner.frames[1].structure.sites).toHaveLength(4)

    const restore = () => {
      for (let idx = 0; idx < base_refs.length; idx++) owner.frames[idx] = base_refs[idx]
      return { frame_idx: 0, frame: base_refs[0] }
    }
    const entry_id = ledger.entries[0].id

    expect(toggle_supercell_history_entry(
      { entry_id, active: false, scope: { kind: `all` }, restore },
      hooks,
    )).toBe(true)
    expect(owner.frames[0]).toBe(base_refs[0])
    expect(owner.frames[1]).toBe(base_refs[1])
    const undone = await owner.effective_frames!.resolve(1, () => base_refs[1])
    expect(undone?.structure.sites).toHaveLength(2)

    expect(toggle_supercell_history_entry(
      { entry_id, active: true, scope: { kind: `all` }, restore },
      hooks,
    )).toBe(true)
    const redone = await owner.effective_frames!.resolve(1, () => base_refs[1])
    expect(redone?.structure.sites).toHaveLength(4)
    expect((redone?.structure as PymatgenStructure).lattice.a).toBe(6)
  })

  it(`invalidates every derived cache and bumps both versions on undo AND redo`, () => {
    const owner = trajectory()
    const ledger = owner.operation_ledger!
    const hooks = txn_hooks(owner, ledger)
    commit(owner, ledger, `edit-all`, 0, hooks)
    vi.clearAllMocks()

    const scope: OpScope = { kind: `all` }
    toggle_supercell_history_entry(
      { entry_id: ledger.entries[0].id, active: false, scope },
      hooks,
    )
    for (
      const hook of [
        hooks.clear_position_cache,
        hooks.clear_force_cache,
        hooks.clear_typed_frame_buffers,
        hooks.reset_topology,
        hooks.invalidate_warmup,
        hooks.bump_topology_version,
      ]
    ) expect(hook).toHaveBeenCalledOnce()
    expect(hooks.invalidate_effective_frames).toHaveBeenCalledWith(scope)
    expect(hooks.invalidate_bond_caches).toHaveBeenCalledWith(scope)
    expect(hooks.bump_position_version).toHaveBeenCalledWith(scope)
    // No restore hook (indexed-style toggle): nothing publishes synchronously.
    expect(hooks.publish_captured_frame).not.toHaveBeenCalled()

    toggle_supercell_history_entry(
      { entry_id: ledger.entries[0].id, active: true, scope },
      hooks,
    )
    expect(hooks.clear_position_cache).toHaveBeenCalledTimes(2)
    expect(hooks.bump_position_version).toHaveBeenCalledTimes(2)
    expect(hooks.bump_topology_version).toHaveBeenCalledTimes(2)
  })
})

import type { PymatgenStructure } from '$lib'
import type {
  IntMatrix3,
  SupercellExecution,
  SupercellOp,
} from '$lib/structure/supercell-operation'
import { execute_supercell_op_sync } from '$lib/structure/supercell-operation'
import type { TrajectoryFrame, TrajectoryType } from '$lib/trajectory'
import { create_effective_frame_resolver } from '$lib/trajectory/effective-frame-resolver'
import { OperationLedger } from '$lib/trajectory/operation-ledger'
import { apply_trajectory_edit_op_to_frame } from '$lib/trajectory/operations'
import {
  commit_supercell_transaction,
  create_trajectory_supercell_request_handler,
  frame_with_supercell_execution,
  SUPER_CELL_PROVENANCE_METADATA_KEY,
  type SupercellTransactionCommitHooks,
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

function deferred_execution() {
  let resolve!: (execution: SupercellExecution) => void
  const promise = new Promise<SupercellExecution>((done) => (resolve = done))
  return { promise, resolve }
}

function commit_hooks(
  owner: TrajectoryType,
  ledger: OperationLedger,
  displayed_idx: () => number,
): SupercellTransactionCommitHooks {
  return {
    ledger,
    replace_frame: (idx, next) => {
      owner.frames[idx] = next
    },
    publish_captured_frame: (idx, next) => {
      if (displayed_idx() === idx) owner.frames[idx] = next
    },
    clear_position_cache: vi.fn(),
    clear_force_cache: vi.fn(),
    invalidate_effective_frames: vi.fn(),
    clear_typed_frame_buffers: vi.fn(),
    reset_topology: vi.fn(),
    invalidate_bond_caches: vi.fn(),
    invalidate_warmup: vi.fn(),
    bump_position_version: vi.fn(),
    bump_topology_version: vi.fn(),
    history_token: (entry) => `history-${entry.id}`,
  }
}

describe(`trajectory supercell transactions`, () => {
  it(`rejects true Build in view scope without staging or history`, async () => {
    const owner = trajectory()
    const execute = vi.fn()
    const commit = vi.fn()
    const handler = create_trajectory_supercell_request_handler({
      capture: () => ({
        owner,
        frame_idx: 0,
        frame: owner.frames[0],
        mode: `view`,
        ledger: owner.operation_ledger!,
      }),
      get_active_owner: () => owner,
      get_mode: () => `view`,
      execute,
      commit,
    })

    const result = await handler(OP)

    expect(result.status).toBe(`rejected`)
    if (result.status === `rejected`) {
      expect(result.message).toMatch(/bottom-right.*visual replication/i)
    }
    expect(execute).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(owner.operation_ledger!.entries).toHaveLength(0)
  })

  it(`commits edit-current to the captured frame after the user scrubs away`, async () => {
    const owner = trajectory()
    const ledger = owner.operation_ledger!
    let displayed_idx = 0
    const staged = deferred_execution()
    const hooks = commit_hooks(owner, ledger, () => displayed_idx)
    const handler = create_trajectory_supercell_request_handler({
      capture: () => ({
        owner,
        frame_idx: displayed_idx,
        frame: owner.frames[displayed_idx],
        mode: `edit-current`,
        ledger,
      }),
      get_active_owner: () => owner,
      get_mode: () => `edit-current`,
      execute: () => staged.promise,
      commit: (publication) => commit_supercell_transaction(publication, hooks),
    })

    const pending = handler(OP)
    displayed_idx = 1
    staged.resolve(execute_supercell_op_sync(structure(2), OP))

    expect(await pending).toEqual({ status: `applied`, history_token: `history-op-0` })
    expect(owner.frames[0].structure.sites).toHaveLength(2)
    expect(owner.frames[1].structure.sites).toHaveLength(1)
    expect(ledger.entries[0].scope).toEqual({ kind: `frame`, frame_idx: 0 })
  })

  it(`applies edit-all lazily with every frame's own cell, species, and count`, async () => {
    const owner = trajectory([
      frame(0, 2, [`H`]),
      frame(1, 3, [`O`, `O`]),
    ])
    const ledger = owner.operation_ledger!
    const hooks = commit_hooks(owner, ledger, () => 0)
    const handler = create_trajectory_supercell_request_handler({
      capture: () => ({
        owner,
        frame_idx: 0,
        frame: owner.frames[0],
        mode: `edit-all`,
        ledger,
      }),
      get_active_owner: () => owner,
      get_mode: () => `edit-all`,
      commit: (publication) => commit_supercell_transaction(publication, hooks),
    })
    const other_base = owner.frames[1]

    expect((await handler(OP)).status).toBe(`applied`)
    const other = await owner.effective_frames!.resolve(1, () => other_base)

    expect(owner.frames[0].structure.sites).toHaveLength(2)
    expect((owner.frames[0].structure as PymatgenStructure).lattice.a).toBe(4)
    expect(other?.structure.sites).toHaveLength(4)
    expect((other?.structure as PymatgenStructure).lattice.a).toBe(6)
    expect(other?.structure.sites.every((site) => site.label === `O`)).toBe(true)
  })

  it(`drops a stale completion and retains the last complete frame and history`, async () => {
    const owner = trajectory()
    const ledger = owner.operation_ledger!
    const before = owner.frames[0]
    const staged = deferred_execution()
    const commit = vi.fn()
    const handler = create_trajectory_supercell_request_handler({
      capture: () => ({
        owner,
        frame_idx: 0,
        frame: owner.frames[0],
        mode: `edit-current`,
        ledger,
      }),
      get_active_owner: () => owner,
      get_mode: () => `edit-current`,
      execute: () => staged.promise,
      commit,
    })

    const pending = handler(OP)
    ledger.append({ kind: `all` }, { kind: `scale_geometry`, factor: 1.1 })
    staged.resolve(execute_supercell_op_sync(structure(2), OP))

    expect(await pending).toEqual({ status: `stale` })
    expect(owner.frames[0]).toBe(before)
    expect(ledger.entries).toHaveLength(1)
    expect(commit).not.toHaveBeenCalled()
  })

  it(`drops completion when the captured frame was replaced without a ledger append`, async () => {
    const owner = trajectory()
    const ledger = owner.operation_ledger!
    const staged = deferred_execution()
    const commit = vi.fn()
    const handler = create_trajectory_supercell_request_handler({
      capture: () => ({
        owner,
        frame_idx: 0,
        frame: owner.frames[0],
        mode: `edit-current`,
        ledger,
      }),
      get_active_owner: () => owner,
      get_mode: () => `edit-current`,
      is_captured_frame_current: (token) =>
        owner.frames[token.frame_idx] === token.frame,
      execute: () => staged.promise,
      commit,
    })

    const pending = handler(OP)
    owner.frames[0] = frame(99)
    staged.resolve(execute_supercell_op_sync(structure(2), OP))

    expect(await pending).toEqual({ status: `stale` })
    expect(commit).not.toHaveBeenCalled()
  })

  it(`invalidates every derived cache and bumps both versions in one commit`, () => {
    const owner = trajectory()
    const ledger = owner.operation_ledger!
    const hooks = commit_hooks(owner, ledger, () => 0)
    const execution = execute_supercell_op_sync(structure(2), OP)

    commit_supercell_transaction({
      token: {
        owner,
        frame_idx: 0,
        frame: owner.frames[0],
        mode: `edit-all`,
        ledger,
        ledger_revision: 0,
        request_id: 1,
      },
      op: OP,
      execution,
    }, hooks)

    expect(hooks.clear_position_cache).toHaveBeenCalledOnce()
    expect(hooks.clear_force_cache).toHaveBeenCalledOnce()
    expect(hooks.invalidate_effective_frames).toHaveBeenCalledWith({ kind: `all` })
    expect(hooks.clear_typed_frame_buffers).toHaveBeenCalledOnce()
    expect(hooks.reset_topology).toHaveBeenCalledOnce()
    expect(hooks.invalidate_bond_caches).toHaveBeenCalledWith({ kind: `all` })
    expect(hooks.invalidate_warmup).toHaveBeenCalledOnce()
    expect(hooks.bump_position_version).toHaveBeenCalledWith({ kind: `all` })
    expect(hooks.bump_topology_version).toHaveBeenCalledOnce()
  })

  it(`records provenance then breaks it before a symmetry-breaking physical-site edit`, () => {
    const source = frame(0)
    const built = frame_with_supercell_execution(
      source,
      execute_supercell_op_sync(source.structure as PymatgenStructure, OP),
    )
    expect(built.metadata?.[SUPER_CELL_PROVENANCE_METADATA_KEY]).toBeDefined()

    const edited = apply_trajectory_edit_op_to_frame(built, {
      kind: `delete`,
      site_indices: [0],
    })

    expect(edited.metadata?.[SUPER_CELL_PROVENANCE_METADATA_KEY]).toBeUndefined()
    expect(edited.structure.sites).toHaveLength(1)
  })

  it(`preserves sequence order between current-only physical edits and all-frame supercells`, async () => {
    const ledger = new OperationLedger()
    ledger.append(
      { kind: `frame`, frame_idx: 0 },
      { kind: `add`, element: `He`, position: [1, 0, 0] },
    )
    ledger.append({ kind: `all` }, OP)
    const resolver = create_effective_frame_resolver(ledger)

    const target = await resolver.resolve(0, () => frame(0))
    const other = await resolver.resolve(1, () => frame(1))

    expect(target?.structure.sites).toHaveLength(4)
    expect(other?.structure.sites).toHaveLength(2)
    expect(target?.structure.sites.filter((site) => site.label === `He`)).toHaveLength(2)
    expect(other?.structure.sites.some((site) => site.label === `He`)).toBe(false)
  })

  it.each([false, true])(
    `keeps true-edit scope independent of large_system_mode=%s`,
    async (large_system_mode) => {
      const owner = trajectory()
      const ledger = owner.operation_ledger!
      const hooks = commit_hooks(owner, ledger, () => 0)
      const handler = create_trajectory_supercell_request_handler({
        capture: () => ({
          owner,
          frame_idx: 0,
          frame: owner.frames[0],
          mode: `edit-current`,
          ledger,
        }),
        get_active_owner: () => owner,
        get_mode: () => `edit-current`,
        commit: (publication) => commit_supercell_transaction(publication, hooks),
      })

      expect(large_system_mode).toBeTypeOf(`boolean`)
      expect((await handler(OP)).status).toBe(`applied`)
      expect(owner.frames[0].structure.sites).toHaveLength(2)
      expect(ledger.entries[0].op).toEqual(OP)
    },
  )
})

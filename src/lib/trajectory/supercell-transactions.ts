import type { PymatgenStructure } from '$lib/structure'
import type {
  SupercellExecution,
  SupercellOp,
  SupercellProvenance,
  SupercellRequestResult,
} from '$lib/structure/supercell-operation'
import {
  SupercellExecutor,
  type SupercellExecuteOptions,
} from '$lib/structure/workers/supercell-worker-api'
import type { TrajectoryFrame, TrajectoryType } from './index'
import type { LedgerEntry, OpScope } from './operation-ledger'
import type { OperationLedger } from './operation-ledger'

export type TrajectoryEditMode = `view` | `edit-current` | `edit-all`

export const SUPER_CELL_PROVENANCE_METADATA_KEY = `supercell_provenance`

export const VIEW_SUPERCELL_REJECTION =
  `True supercell Build is disabled in view mode. ` +
  `Use the bottom-right visual replication control for view-only copies.`

export type TrajectorySupercellCapture = {
  owner: TrajectoryType
  frame_idx: number
  frame: TrajectoryFrame
  mode: TrajectoryEditMode
  ledger: OperationLedger
}

export type TrajectorySupercellToken = TrajectorySupercellCapture & {
  ledger_revision: number
  request_id: number
}

export type SupercellTransactionPublication = {
  token: TrajectorySupercellToken
  op: SupercellOp
  execution: SupercellExecution
}

export type SupercellTransactionCommitHooks = {
  ledger: OperationLedger
  replace_frame: (frame_idx: number, frame: TrajectoryFrame) => void
  publish_captured_frame: (frame_idx: number, frame: TrajectoryFrame) => void
  clear_position_cache: () => void
  clear_force_cache: () => void
  invalidate_effective_frames: (scope: OpScope) => void
  clear_typed_frame_buffers: () => void
  reset_topology: () => void
  invalidate_bond_caches: (scope: OpScope) => void
  invalidate_warmup: () => void
  bump_position_version: (scope: OpScope) => void
  bump_topology_version: () => void
  history_token?: (entry: LedgerEntry) => string
}

export type TrajectorySupercellRequestHooks = {
  capture: () => TrajectorySupercellCapture | null
  get_active_owner: () => TrajectoryType | undefined
  get_mode: () => TrajectoryEditMode
  is_captured_frame_current?: (token: TrajectorySupercellToken) => boolean
  snapshot?: (structure: PymatgenStructure) => PymatgenStructure
  prepare_current_topology_edit?: () => void
  execute?: (
    structure: PymatgenStructure,
    op: SupercellOp,
    options: SupercellExecuteOptions,
  ) => Promise<SupercellExecution>
  commit: (publication: SupercellTransactionPublication) => string
}

function rejection_message(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Supercell rejected:\s*/, ``)
}

export function frame_with_supercell_execution(
  frame: TrajectoryFrame,
  execution: SupercellExecution,
): TrajectoryFrame {
  return {
    ...frame,
    structure: execution.structure,
    // The compact coordinate packet belongs to the pre-supercell topology.
    // Derived typed buffers are rebuilt from execution.structure after commit.
    position_data: undefined,
    metadata: {
      ...frame.metadata,
      [SUPER_CELL_PROVENANCE_METADATA_KEY]: execution.provenance,
    },
  }
}

export function frame_supercell_provenance(
  frame: TrajectoryFrame,
): SupercellProvenance | undefined {
  return frame.metadata?.[SUPER_CELL_PROVENANCE_METADATA_KEY] as
    | SupercellProvenance
    | undefined
}

export function break_frame_supercell_provenance(
  frame: TrajectoryFrame,
): TrajectoryFrame {
  if (!frame_supercell_provenance(frame)) return frame
  const metadata = { ...frame.metadata }
  delete metadata[SUPER_CELL_PROVENANCE_METADATA_KEY]
  return { ...frame, metadata }
}

/**
 * The transaction's shared derived-cache invalidation + republish + version
 * cascade. Order matches the original commit sequence exactly; the optional
 * `publish` republishes a synchronously-available frame (in-memory paths) —
 * indexed paths omit it and re-resolve through the effective-frame resolver
 * after the version bumps re-run the display pipeline.
 */
function run_supercell_invalidation(
  scope: OpScope,
  hooks: SupercellTransactionCommitHooks,
  publish?: { frame_idx: number; frame: TrajectoryFrame },
): void {
  hooks.clear_position_cache()
  hooks.clear_force_cache()
  hooks.invalidate_effective_frames(scope)
  hooks.clear_typed_frame_buffers()
  hooks.reset_topology()
  hooks.invalidate_bond_caches(scope)
  hooks.invalidate_warmup()
  if (publish) hooks.publish_captured_frame(publish.frame_idx, publish.frame)
  hooks.bump_position_version(scope)
  hooks.bump_topology_version()
}

/**
 * Publish a staged supercell as one synchronous trajectory transaction.
 * Validation and allocation have already completed, so no partial structure is
 * visible before this function starts. The ledger append, captured-frame
 * replacement, every derived-cache invalidation, republish, and both version
 * bumps occur without an async boundary.
 */
export function commit_supercell_transaction(
  publication: SupercellTransactionPublication,
  hooks: SupercellTransactionCommitHooks,
): string {
  const { token, op, execution } = publication
  const scope: OpScope = token.mode === `edit-all`
    ? { kind: `all` }
    : { kind: `frame`, frame_idx: token.frame_idx }
  const staged_frame = frame_with_supercell_execution(token.frame, execution)
  const entry = hooks.ledger.append(scope, op)

  hooks.replace_frame(token.frame_idx, staged_frame)
  run_supercell_invalidation(scope, hooks, {
    frame_idx: token.frame_idx,
    frame: staged_frame,
  })

  return hooks.history_token?.(entry) ?? `trajectory-supercell-${entry.id}`
}

/** One external undo/redo toggle of a committed supercell ledger entry. */
export type SupercellHistoryToggle = {
  /** Ledger entry id recorded at commit time. */
  entry_id: string
  /** false = undo (deactivate), true = redo (re-activate). */
  active: boolean
  /** The entry's scope, driving targeted vs whole-trajectory invalidation. */
  scope: OpScope
  /**
   * In-memory owners: restore the immutable pre-op frame references (and
   * materialization cursors) captured at commit time, then return the frame
   * to republish at the displayed index. Runs AFTER the activity flip so any
   * re-materialization sees the toggled active set. Indexed owners omit it —
   * the effective-frame resolver re-resolves from the bumped ledger revision.
   */
  restore?: () => { frame_idx: number; frame: TrajectoryFrame } | undefined
}

/**
 * Undo/redo a committed supercell by flipping its ledger entry's active flag
 * (design §9.5 — `seq` is never renumbered, so redo restores the entry at its
 * original position). Runs the SAME invalidation + republish cascade as
 * `commit_supercell_transaction`, synchronously. Returns false for an unknown
 * entry id without touching any cache.
 */
export function toggle_supercell_history_entry(
  toggle: SupercellHistoryToggle,
  hooks: SupercellTransactionCommitHooks,
): boolean {
  if (!hooks.ledger.set_active(toggle.entry_id, toggle.active)) return false
  run_supercell_invalidation(toggle.scope, hooks, toggle.restore?.())
  return true
}

/**
 * Stage a true-supercell request against the owner/frame/scope captured at
 * request time. A scrub does not invalidate or retarget edit-current. Owner,
 * mode, ledger revision, and latest request id must still match at publication;
 * otherwise the completion is stale and the last complete scene/history stay
 * untouched.
 */
export function create_trajectory_supercell_request_handler(
  hooks: TrajectorySupercellRequestHooks,
): (op: SupercellOp) => Promise<SupercellRequestResult> {
  let next_request_id = 0
  let inflight: AbortController | null = null

  return async function handle_trajectory_supercell_request(op) {
    inflight?.abort()
    const controller = new AbortController()
    inflight = controller
    const request_id = ++next_request_id
    const captured = hooks.capture()

    if (!captured) {
      if (inflight === controller) inflight = null
      return { status: `rejected`, message: `No displayed trajectory frame to transform` }
    }
    if (captured.mode === `view`) {
      if (inflight === controller) inflight = null
      return { status: `rejected`, message: VIEW_SUPERCELL_REJECTION }
    }

    const token: TrajectorySupercellToken = {
      ...captured,
      ledger_revision: captured.ledger.revision,
      request_id,
    }
    if (captured.mode === `edit-current`) {
      hooks.prepare_current_topology_edit?.()
    }

    try {
      const source = hooks.snapshot
        ? hooks.snapshot(captured.frame.structure as PymatgenStructure)
        : captured.frame.structure as PymatgenStructure
      const execute = hooks.execute ?? SupercellExecutor.execute
      const execution = await execute(source, op, {
        signal: controller.signal,
        source_frame_id: source.id ?? `trajectory-frame-${captured.frame_idx}`,
      })
      const stale = controller.signal.aborted || request_id !== next_request_id ||
        hooks.get_active_owner() !== captured.owner ||
        hooks.get_mode() !== captured.mode ||
        captured.ledger.revision !== token.ledger_revision ||
        hooks.is_captured_frame_current?.(token) === false
      if (stale) return { status: `stale` }

      return {
        status: `applied`,
        history_token: hooks.commit({ token, op, execution }),
      }
    } catch (error) {
      if (error instanceof Error && error.name === `AbortError`) {
        return { status: `stale` }
      }
      return { status: `rejected`, message: rejection_message(error) }
    } finally {
      if (inflight === controller) inflight = null
    }
  }
}

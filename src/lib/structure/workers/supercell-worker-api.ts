// Staged TRUE-supercell execution API (trajectory-supercell design §9.4).
//
// `SupercellExecutor.execute(structure, op, opts)` validates the request
// cheaply on the calling thread, then materializes the supercell either
// synchronously (small predicted output) or in a Web Worker (large output),
// and resolves with the new structure + immutable provenance. The result is
// STAGED — nothing is published here: the caller replaces its structure
// exactly once on success, and on rejection/abort/timeout nothing changed,
// so the last complete scene and history are always retained.
//
// Worker creation follows the bond-worker pattern (`?worker&inline` so Vite
// bundles the worker script and its imports into an inline blob, bypassing
// SvelteKit's IIFE worker.format override). Environments without a Worker
// global (vitest/happy-dom, node) run the same executor on the calling
// thread — behaviour is identical, only the thread differs.

import type { AnyStructure, PymatgenStructure } from '../index'
import {
  type SupercellExecution,
  type SupercellOp,
  type SupercellProvenance,
  type SupercellRequestResult,
  TRUE_SUPERCELL_MAX_ATOMS,
  validate_supercell_op,
  execute_supercell_op_sync,
} from '../supercell-operation'

/**
 * Predicted output-atom count at or below which the transform runs
 * synchronously on the calling thread. Materializing ≤10k sites costs on the
 * order of 10ms (see supercell-performance.test.ts) — cheaper and simpler
 * than a structured-clone round trip through a Worker. Larger transforms are
 * staged in the Worker so the main thread never freezes.
 */
export const SUPERCELL_SYNC_ATOM_LIMIT = 10_000

/**
 * Hard deadline for one staged worker execution. Materializing even the
 * TRUE_SUPERCELL_MAX_ATOMS ceiling fits comfortably; past this the worker is
 * treated as wedged: it is terminated (recreated on the next request) and the
 * request rejects, so the caller keeps its last complete scene.
 */
export const SUPERCELL_WORKER_TIMEOUT_MS = 60_000

export type SupercellExecuteOptions = {
  /**
   * Identity of the frame this transform was requested against, stamped into
   * provenance. Trajectory scopes use it to verify a completion is not stale.
   * Omitted ⇒ provenance falls back to the structure's own `id` (or null).
   */
  source_frame_id?: string | null
  /** Abort staging: a rejected/aborted execution publishes nothing. */
  signal?: AbortSignal
  /** Override the predicted-output-atom ceiling (default TRUE_SUPERCELL_MAX_ATOMS). */
  max_atoms?: number
}

// ─── Worker lifecycle ───

type WorkerReply = {
  id: number
  structure?: PymatgenStructure
  provenance?: SupercellProvenance
  error?: string
}

let worker: Worker | null = null
let worker_failed = false
let worker_init_promise: Promise<Worker | null> | null = null
const pending = new Map<
  number,
  { resolve: (v: WorkerReply) => void; reject: (e: Error) => void }
>()
let next_id = 0

/** Lazily create the worker. Returns null when the environment has no Worker
 *  (vitest/node) or creation failed — callers then run on the calling thread. */
function get_worker(): Promise<Worker | null> {
  if (worker) return Promise.resolve(worker)
  if (worker_failed || typeof Worker === `undefined`) return Promise.resolve(null)
  if (!worker_init_promise) {
    worker_init_promise = (async () => {
      const { default: SupercellWorker } = await import(
        `./supercell-worker.ts?worker&inline`
      )
      const w: Worker = new SupercellWorker()
      w.onmessage = (e: MessageEvent) => {
        const reply = e.data as WorkerReply
        const p = pending.get(reply.id)
        if (!p) return // aborted or timed out — a stale completion publishes nothing
        pending.delete(reply.id)
        if (reply.error) p.reject(new Error(reply.error))
        else p.resolve(reply)
      }
      // Load/eval failure: mark permanently failed so later requests go
      // straight to the calling-thread path instead of retrying a broken bundle.
      w.onerror = () => {
        worker_failed = true
        reset_worker(`Supercell worker failed`)
      }
      worker = w
      return w
    })().catch((err) => {
      worker_failed = true
      worker_init_promise = null
      console.warn(`[supercell] Worker init failed — calling-thread fallback:`, err)
      return null
    })
  }
  return worker_init_promise
}

/** Terminate a wedged/dead worker and reject its in-flight requests. Does NOT
 *  set worker_failed — a timeout on one huge transform must not permanently
 *  disable staging; the next request recreates the worker. */
function reset_worker(reason: string): void {
  try {
    worker?.terminate()
  } catch {
    /* already dead */
  }
  worker = null
  worker_init_promise = null
  const err = new Error(reason)
  for (const [, p] of pending) p.reject(err)
  pending.clear()
}

function abort_error(): Error {
  const err = new Error(`Supercell execution aborted`)
  err.name = `AbortError`
  return err
}

/** Run one transform in the worker. Resolves null when the worker path is
 *  unavailable (no Worker global, init failure, or a non-cloneable structure
 *  such as a reactive proxy) — the caller then executes on its own thread. */
function worker_execute(
  structure: PymatgenStructure,
  op: SupercellOp,
  max_atoms: number,
  signal?: AbortSignal,
): Promise<SupercellExecution | null> {
  return get_worker().then((w) => {
    if (!w) return null
    if (signal?.aborted) throw abort_error()
    const id = next_id++
    return new Promise<SupercellExecution | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        signal?.removeEventListener(`abort`, on_abort)
        reject(
          new Error(
            `Supercell worker timed out after ${SUPERCELL_WORKER_TIMEOUT_MS}ms — ` +
              `terminating worker; the last complete structure is retained`,
          ),
        )
        reset_worker(`Supercell worker timed out`)
      }, SUPERCELL_WORKER_TIMEOUT_MS)
      const on_abort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        clearTimeout(timer)
        // The worker may keep computing; its eventual reply finds no pending
        // entry and is dropped — a stale completion never publishes.
        reject(abort_error())
      }
      signal?.addEventListener(`abort`, on_abort, { once: true })
      pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer)
          signal?.removeEventListener(`abort`, on_abort)
          resolve({
            structure: reply.structure as PymatgenStructure,
            provenance: reply.provenance as SupercellProvenance,
          })
        },
        reject: (err) => {
          clearTimeout(timer)
          signal?.removeEventListener(`abort`, on_abort)
          reject(err)
        },
      })
      try {
        w.postMessage({ id, structure, op, max_atoms })
      } catch (err) {
        // e.g. DataCloneError on a reactive proxy — the sync executor can
        // still read it, so fall back instead of failing the request.
        pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener(`abort`, on_abort)
        console.warn(`[supercell] postMessage failed — calling-thread fallback:`, err)
        resolve(null)
      }
    })
  })
}

// ─── Public API ───

/**
 * Staged executor for the explicit supercell operation channel (§9.1/§9.4).
 *
 * Resolution contract:
 * - resolves with `{ structure, provenance }` — the caller publishes it
 *   atomically (one structure replacement, one history entry);
 * - rejects on validation failure, abort, worker failure, or timeout — the
 *   caller must publish NOTHING (no mutation, no undo entry).
 *
 * The input structure is never mutated (execute_supercell_op_sync guarantee).
 */
export const SupercellExecutor = {
  async execute(
    structure: PymatgenStructure,
    op: SupercellOp,
    opts: SupercellExecuteOptions = {},
  ): Promise<SupercellExecution> {
    const max_atoms = opts.max_atoms ?? TRUE_SUPERCELL_MAX_ATOMS
    // Validate BEFORE any staging or allocation: a rejected op never reaches
    // a worker and never touches the input.
    const validation = validate_supercell_op(structure, op, max_atoms)
    if (!validation.ok) throw new Error(`Supercell rejected: ${validation.message}`)
    if (opts.signal?.aborted) throw abort_error()

    let execution: SupercellExecution | null = null
    if (validation.predicted_count > SUPERCELL_SYNC_ATOM_LIMIT) {
      execution = await worker_execute(structure, op, max_atoms, opts.signal)
    }
    if (!execution) {
      // Small transform, or the worker path is unavailable in this
      // environment: run the same canonical executor on the calling thread.
      execution = execute_supercell_op_sync(structure, op, max_atoms)
    }
    // A completion that arrives after abort is stale — publish nothing.
    if (opts.signal?.aborted) throw abort_error()

    if (opts.source_frame_id !== undefined) {
      execution = {
        structure: execution.structure,
        provenance: { ...execution.provenance, source_frame_id: opts.source_frame_id },
      }
    }
    return execution
  },
}

// ─── Shared staged publish (§9.1 call-site wrapper) ───

/** Strip the executor's `Supercell rejected: ` prefix so callers that prefix
 *  their own log/report line exactly once never produce
 *  "Supercell rejected: Supercell rejected: …". */
function rejection_message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Supercell rejected:\s*/, ``)
}

export type SupercellRequestHandler = (
  op: SupercellOp,
) => Promise<SupercellRequestResult>

export type SupercellRequestHooks = {
  /**
   * Read the LIVE structure (Svelte call sites: the current prop/state value).
   * Called at stage time — the returned reference doubles as the staleness
   * token — and again at completion: if the reference moved (an intervening
   * edit from any other surface), the completion is stale and publishes
   * nothing.
   */
  get_structure: () => AnyStructure | undefined
  /**
   * Deep plain-object copy of the live structure for the executor (the worker
   * path structured-clones, and reactive $state proxies are not cloneable).
   * Svelte call sites pass `$state.snapshot`; plain-data callers may omit it.
   */
  snapshot?: (live: PymatgenStructure) => PymatgenStructure
  /** Record the pre-op state in history — invoked immediately before publish,
   *  never on rejection/abort/stale. */
  push_undo?: () => void
  /** Replace the structure exactly once with the staged result. */
  publish: (execution: SupercellExecution) => void
  /** History-correlation token stamped into the 'applied' result. */
  history_token: () => string
  /**
   * §9.1 delegation: read the host callback (if any) at request time. When
   * present, the op is forwarded there untouched and nothing runs locally; a
   * throwing host counts as a rejection (nothing mutated either way).
   */
  delegate?: () => SupercellRequestHandler | undefined
  /** Extra executor options for the local path (`signal` is owned here). */
  executor_options?: Omit<SupercellExecuteOptions, 'signal'>
}

/**
 * Create the staged-execute-then-publish handler both supercell call sites
 * share (LatticePane's bare-pane local path and Structure's §9.1 handler).
 *
 * Guarantees:
 * - Delegation-first: with a host callback, the op is forwarded untouched
 *   BEFORE any local mutation or undo push; its result passes through as-is,
 *   and a throwing host surfaces as `{ status: 'rejected' }`.
 * - Atomic publish: `push_undo` (pre-op state) + one `publish`, only after
 *   execution succeeded; on rejection nothing changed.
 * - Staleness guard: the live structure reference is captured at stage time;
 *   if it moved during the async window (an edit from any other surface won),
 *   the completion is dropped with `{ status: 'stale' }`.
 * - Supersede: the handler owns an AbortController — a new request aborts the
 *   in-flight one (the executor receives the signal), which resolves
 *   `{ status: 'stale' }`. The latest request wins.
 */
export function create_supercell_request_handler(
  hooks: SupercellRequestHooks,
): SupercellRequestHandler {
  let inflight: AbortController | null = null

  return async function handle_supercell_request(op) {
    const delegate = hooks.delegate?.()
    if (delegate) {
      try {
        return await delegate(op)
      } catch (err) {
        return { status: `rejected`, message: rejection_message(err) }
      }
    }

    const live = hooks.get_structure()
    if (!live || !(`lattice` in live)) {
      return { status: `rejected`, message: `No periodic structure to transform` }
    }

    // A new request supersedes any in-flight one: abort it so its eventual
    // completion (computed against an older structure) publishes nothing.
    inflight?.abort()
    const controller = new AbortController()
    inflight = controller
    try {
      const source = hooks.snapshot ? hooks.snapshot(live) : live
      const execution = await SupercellExecutor.execute(source, op, {
        ...hooks.executor_options,
        signal: controller.signal,
      })
      // Superseded while completing, or the structure was replaced by another
      // surface during the async window — this completion is stale; the newer
      // state wins and nothing publishes.
      if (controller.signal.aborted || hooks.get_structure() !== live) {
        return { status: `stale` }
      }
      hooks.push_undo?.()
      hooks.publish(execution)
      return { status: `applied`, history_token: hooks.history_token() }
    } catch (err) {
      if (err instanceof Error && err.name === `AbortError`) return { status: `stale` }
      return { status: `rejected`, message: rejection_message(err) }
    } finally {
      if (inflight === controller) inflight = null
    }
  }
}

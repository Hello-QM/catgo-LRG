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

import type { PymatgenStructure } from '../index'
import {
  type SupercellExecution,
  type SupercellOp,
  type SupercellProvenance,
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

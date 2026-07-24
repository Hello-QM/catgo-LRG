/** Rust-WASM bond backend orchestration (design §6.3, §8.3).
 *
 *  This module owns WHICH rust worker serves bond detection and what happens
 *  when workers die. It is deliberately pure over injected dependencies — the
 *  capability probe and the two worker factories are passed in, so the whole
 *  selection / retry / disable state machine is unit-testable in Node without
 *  a real Worker or WASM artifact (`bond-worker-api.ts` supplies the real
 *  factories).
 *
 *  State machine:
 *   - First compute runs `select_rust_bond_backend` over the probed
 *     capabilities. Threads are attempted only when COI + SAB + wasm atomics +
 *     ≥2 logical cores all hold; the Rayon pool is sized
 *     `clamp(hardware_concurrency - 1, 2, 8)` (§8.3 — one core reserved for
 *     the UI, and a 1-thread pool would only add scheduling overhead over the
 *     scalar artifact).
 *   - A threaded init failure retries the scalar artifact EXACTLY once, and
 *     the threaded attempt is never repeated for this runtime (`disabled` /
 *     scalar are sticky outcomes of the init sequence).
 *   - When BOTH inits fail the runtime is permanently `disabled` and every
 *     compute rejects with `BondBackendUnavailableError`. There is NO
 *     main-thread fallback here by construction: this module never imports the
 *     JS bonding strategies or the sync WASM entry points. Large systems
 *     (≥ LARGE_SYSTEM_MIN_ATOMS) must surface that error; small systems may be
 *     mapped to legacy fallbacks by the caller (`bond-worker-api.ts`).
 *   - `reset(handle)` drops a live-but-wedged worker (request timeout / crash)
 *     so the next compute re-initializes. That is NOT an init failure and does
 *     not trip the disabled state. */

import {
  type BondBackendCapabilities,
  type BondBackendKind,
  select_rust_bond_backend,
} from './bond-backend-policy'
import { MAX_BOND_THREADS } from './wasm-thread-capability'

/** Systems at or above this size must never run main-thread JavaScript (or
 *  synchronous main-thread WASM) bond detection — the rust workers are the
 *  only permitted backends, and when they all fail bonds are disabled with an
 *  actionable error (design §8.3). */
export const LARGE_SYSTEM_MIN_ATOMS = 4096

/** Floor on the Rayon pool size: a 1-thread pool costs pool scheduling without
 *  buying parallelism, so a threaded init always requests at least 2 (§8.3:
 *  pool = clamp(hardware_concurrency - 1, 2, MAX_BOND_THREADS)). */
export const MIN_RAYON_POOL_THREADS = 2

/** Terminal failure of the rust bond backends. For large systems this must
 *  reach the UI as "bonds disabled" — it must NOT be silently converted into a
 *  main-thread fallback. */
export class BondBackendUnavailableError extends Error {
  override name = `BondBackendUnavailableError`
}

/** Flat typed-array bond table returned by the typed worker path. Layouts:
 *  pairs [i0,j0, i1,j1, ...], images [x0,y0,z0, x1,...] (periodic image
 *  offsets), lengths/strengths one per bond. */
export interface TypedBondTable {
  pairs: Uint32Array
  images: Int8Array
  lengths: Float32Array
  strengths: Float32Array
}

/** One typed bond-detection request (atom_radii strategy). Positions are
 *  cartesian xyz triples; `lattice_matrix` rows are the a/b/c vectors. */
export interface TypedBondInput {
  positions: Float32Array
  atomic_numbers: Uint8Array
  lattice_matrix: number[][] | null
  pbc: [boolean, boolean, boolean] | null
  options: Record<string, number>
}

export interface TrajectoryTypedBondInput {
  session: {
    id: number
    topology_fingerprint: string
    atomic_numbers: Uint8Array
    stable_site_ids: Uint32Array | null
    pbc: [boolean, boolean, boolean] | null
    options: Record<string, number>
  }
  frame_idx: number
  positions: Float32Array
  lattice_matrix: number[][] | null
}

export type TrajectoryBondSessionDiagnostics = {
  thread_count: number
  session_initializations: number
  frame_count: number
  grid_cache_hits: number
  grid_rebuilds: number
  capacity_growths: number
}

export interface TrajectoryFrameWorkerResult {
  table: TypedBondTable
  gpu_positions_rgba: Float32Array
  session_diagnostics: TrajectoryBondSessionDiagnostics
}

/** A live, initialized bond worker. `compute_typed` is the hot path both
 *  artifacts share; `request_json` is the legacy JSON message channel the real
 *  worker also serves (optional so test fakes only implement the hot path). */
export interface BondWorkerHandle {
  compute_typed(input: TypedBondInput): Promise<TypedBondTable>
  compute_trajectory_frame_typed(
    input: TrajectoryTypedBondInput,
  ): Promise<TrajectoryFrameWorkerResult>
  pack_trajectory_positions(positions: Float32Array): Promise<Float32Array>
  request_json?(
    data: Record<string, unknown>,
    timeout_ms?: number,
  ): Promise<{ result: string; dt: string }>
  terminate(): void
}

/** Creates AND fully initializes one worker (wasm init + ready handshake +
 *  Rayon pool for the threaded artifact). Rejection — including a handshake
 *  timeout — is an init failure. */
export type BondWorkerFactory = (thread_count: number) => Promise<BondWorkerHandle>

export interface BondWorkerRuntimeDeps {
  detect_capabilities: () => BondBackendCapabilities
  create_threaded_worker: BondWorkerFactory
  create_scalar_worker: BondWorkerFactory
  /** Clock for elapsed_ms; defaults to performance.now. */
  now?: () => number
}

/** What `compute_bonds_typed` resolves to — `backend` is UI-reportable. */
export interface ComputeBondsTypedResult {
  backend: BondBackendKind
  table: TypedBondTable
  elapsed_ms: number
}

export interface ComputeTrajectoryFrameTypedResult
  extends ComputeBondsTypedResult {
  gpu_positions_rgba: Float32Array
  session_diagnostics: TrajectoryBondSessionDiagnostics
  threading_expected: boolean
}

export interface BondWorkerRuntime {
  compute_bonds_typed(input: TypedBondInput): Promise<ComputeBondsTypedResult>
  compute_trajectory_frame_typed(
    input: TrajectoryTypedBondInput,
  ): Promise<ComputeTrajectoryFrameTypedResult>
  /** The initialized worker + which backend it is; init runs at most once at a
   *  time and its outcome is memoized. Throws BondBackendUnavailableError once
   *  disabled. Used by the JSON call path in bond-worker-api. */
  acquire(atom_count: number): Promise<{
    handle: BondWorkerHandle
    kind: 'rust-wasm-threads' | 'rust-wasm-scalar'
  }>
  /** 'disabled' once both inits failed; null before the first successful init
   *  or after a reset; otherwise the live backend kind. */
  active_backend(): BondBackendKind | null
  /** Drop a wedged worker so the next compute re-initializes. No-op when
   *  `handle` is given and is not the active one (stale death notification),
   *  and never clears the disabled state. */
  reset(handle?: BondWorkerHandle): void
}

export function create_bond_worker_runtime(
  deps: BondWorkerRuntimeDeps,
): BondWorkerRuntime {
  const now = deps.now ?? (() => performance.now())

  type Active = { handle: BondWorkerHandle; kind: 'rust-wasm-threads' | 'rust-wasm-scalar' }
  let active: Active | null = null
  let init_promise: Promise<Active> | null = null
  // Sticky init outcomes: one threaded attempt ever, one scalar retry ever.
  let threaded_init_failed = false
  let disabled_reason: string | null = null
  let initial_threading_expected: boolean | null = null

  const err_msg = (err: unknown): string =>
    err instanceof Error ? err.message : String(err)

  async function init_backend(atom_count: number): Promise<Active> {
    const caps = deps.detect_capabilities()
    const selection = select_rust_bond_backend(caps, atom_count)
    if (initial_threading_expected === null) {
      initial_threading_expected = selection.kind === `rust-wasm-threads`
    }

    if (selection.kind === `rust-wasm-threads` && !threaded_init_failed) {
      const pool = Math.min(
        MAX_BOND_THREADS,
        Math.max(MIN_RAYON_POOL_THREADS, selection.thread_count),
      )
      try {
        const handle = await deps.create_threaded_worker(pool)
        return { handle, kind: `rust-wasm-threads` }
      } catch (err) {
        // Design §8.3: retry the scalar artifact exactly once.
        threaded_init_failed = true
        console.warn(
          `[bonds] threaded wasm worker init failed — retrying scalar once:`,
          err_msg(err),
        )
      }
    }

    try {
      const handle = await deps.create_scalar_worker(1)
      return { handle, kind: `rust-wasm-scalar` }
    } catch (err) {
      disabled_reason = `rust wasm bond workers unavailable — ` +
        (threaded_init_failed ? `threaded and scalar init both failed` : `scalar init failed`) +
        ` (${err_msg(err)})`
      throw new BondBackendUnavailableError(disabled_reason)
    }
  }

  function acquire(atom_count: number): Promise<Active> {
    if (disabled_reason !== null) {
      return Promise.reject(new BondBackendUnavailableError(disabled_reason))
    }
    if (active) return Promise.resolve(active)
    if (!init_promise) {
      init_promise = init_backend(atom_count).then(
        (backend) => {
          active = backend
          init_promise = null
          return backend
        },
        (err) => {
          init_promise = null
          throw err
        },
      )
    }
    return init_promise
  }

  async function compute_bonds_typed(
    input: TypedBondInput,
  ): Promise<ComputeBondsTypedResult> {
    const { handle, kind } = await acquire(input.atomic_numbers.length)
    const t0 = now()
    const table = await handle.compute_typed(input)
    return { backend: kind, table, elapsed_ms: now() - t0 }
  }

  async function compute_trajectory_frame_typed(
    input: TrajectoryTypedBondInput,
  ): Promise<ComputeTrajectoryFrameTypedResult> {
    const { handle, kind } = await acquire(input.session.atomic_numbers.length)
    const t0 = now()
    const result = await handle.compute_trajectory_frame_typed(input)
    return {
      backend: kind,
      table: result.table,
      gpu_positions_rgba: result.gpu_positions_rgba,
      session_diagnostics: result.session_diagnostics,
      threading_expected: initial_threading_expected ?? false,
      elapsed_ms: now() - t0,
    }
  }

  function reset(handle?: BondWorkerHandle): void {
    if (handle !== undefined && active?.handle !== handle) return
    try {
      active?.handle.terminate()
    } catch {
      /* already dead */
    }
    active = null
  }

  function active_backend(): BondBackendKind | null {
    if (disabled_reason !== null) return `disabled`
    return active?.kind ?? null
  }

  return {
    compute_bonds_typed,
    compute_trajectory_frame_typed,
    acquire,
    active_backend,
    reset,
  }
}

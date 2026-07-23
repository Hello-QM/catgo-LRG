// Bond computation API — delegates to Web Worker (WASM off main thread).
//
// Architecture:
//   1. Main thread initializes WASM via ensure_ferrox_wasm_ready, capturing
//      the WebAssembly.Module via instantiate interception
//   2. The bond-worker RUNTIME (bond-worker-runtime.ts) picks the artifact:
//      threaded (COI + SAB + wasm atomics + ≥2 cores) or scalar, retrying
//      scalar exactly once after a threaded init failure (design §6.3/§8.3)
//   3. The worker entry (bond-worker-threaded.ts / bond-worker-scalar.ts) is
//      created via Vite ?worker&inline (bundles deps into the Worker)
//   4. The compiled WebAssembly.Module is sent to the Worker via postMessage;
//      the Worker calls initSync({ module }) — no WASM fetch in the Worker —
//      and, for the threaded artifact, awaits initThreadPool(thread_count)
//      before signalling ready
//   5. Bond detection runs entirely off main thread
//
// Priority chain (small systems, < LARGE_SYSTEM_MIN_ATOMS):
//   1. Rust worker (threaded or scalar)  (non-blocking, best performance)
//   2. Main-thread WASM                  (blocks briefly, still fast)
//   3. Main-thread JS                    (blocks, O(n²) with spatial grid)
//
// Large systems (≥ LARGE_SYSTEM_MIN_ATOMS) get the rust workers ONLY: when
// both fail, bond detection rejects with BondBackendUnavailableError — it
// never runs synchronous main-thread WASM or the JavaScript fallback
// (design §8.3).

import type { AnyStructure, BondPair, Crystal } from '$lib'
import { BONDING_STRATEGIES, type BondingStrategy, compute_bond_transform } from '../bonding'
import { compile_wasm_module, ensure_ferrox_wasm_ready, get_ferrox_wasm_sync } from '../ferrox-wasm'
import type { WasmBond } from '../ferrox-wasm-types'
import {
  BondBackendUnavailableError,
  type BondWorkerHandle,
  type BondWorkerRuntime,
  type ComputeBondsTypedResult,
  type ComputeTrajectoryFrameTypedResult,
  create_bond_worker_runtime,
  LARGE_SYSTEM_MIN_ATOMS,
  type TrajectoryFrameWorkerResult,
  type TrajectoryTypedBondInput,
  type TypedBondInput,
  type TypedBondTable,
} from './bond-worker-runtime'
import { detect_bond_backend_capabilities } from './wasm-thread-capability'

export { BondBackendUnavailableError, LARGE_SYSTEM_MIN_ATOMS }
export type {
  ComputeBondsTypedResult,
  ComputeTrajectoryFrameTypedResult,
  TrajectoryTypedBondInput,
  TypedBondInput,
  TypedBondTable,
}

/** Threshold below which bonds are computed synchronously via JS.
 *  Spatial grid optimization keeps JS fast (~30-80ms for 1000 atoms).
 *  Synchronous computation ensures bonds and atoms appear in the same
 *  render frame — async Worker causes visible timing gaps during
 *  trajectory playback. Note: PBC image atoms can add 200-400 extra
 *  atoms to the displayed structure, so this must be well above the
 *  base atom count to stay on the sync path. */
const JS_SYNC_FALLBACK_THRESHOLD = 1000

// ─── Web Worker management ───

/** Init-handshake deadline for ONE worker: script eval + wasm initSync +
 *  (threaded) Rayon pool spawn. Deliberately a single generous bound — a
 *  worker that hasn't signalled ready by then is treated as an init FAILURE,
 *  which the runtime maps to the one-shot scalar retry / disabled state. */
const WORKER_INIT_TIMEOUT_MS = 15_000

/** A live worker: owns the message channel, pending-request map, and
 *  per-request deadlines. On a request timeout or a worker error the handle
 *  terminates itself and reports back through `on_dead`, so the runtime can
 *  drop it and re-initialize on the next request (NOT a permanent failure).
 *  Exported for unit tests (fake wedged-Worker injection); production
 *  construction happens only in create_rust_worker. */
export class RealBondWorkerHandle implements BondWorkerHandle {
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private next_id = 0
  private trajectory_session_id: number | null = null

  constructor(
    private worker: Worker,
    private on_dead: (handle: RealBondWorkerHandle, reason: string) => void,
    /** Artifact kind — names the backend in timeout/error messages. */
    private kind: 'scalar' | 'threaded',
  ) {
    worker.onmessage = (e: MessageEvent) => {
      const { id, type: msg_type, error } = e.data
      if (msg_type === `ready`) return
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      if (error) {
        p.reject(new Error(error))
      } else {
        // Resolve the whole payload — JSON replies carry {result, dt},
        // typed replies carry {pairs, images, lengths, strengths, dt}.
        p.resolve(e.data)
      }
    }
    worker.onerror = () => this.die(`Worker failed`)
  }

  private die(reason: string): void {
    try {
      this.worker.terminate()
    } catch {
      /* already dead */
    }
    for (const [, p] of this.pending) p.reject(new Error(reason))
    this.pending.clear()
    this.on_dead(this, reason)
  }

  request<T>(
    data: Record<string, unknown>,
    timeout_ms = 20_000,
    transfer?: Transferable[],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.next_id++
      // Without a deadline, a wedged worker (e.g. solid_angle on 10k+ atoms in
      // WebKitGTK, whose WASM tier is far slower than Chrome's) hangs this
      // promise FOREVER. Kill the worker on timeout so the caller's fallback
      // chain runs; the runtime re-initializes on the next request.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        const msg =
          `rust wasm bond worker (${this.kind}) request timed out after ${timeout_ms}ms — ` +
          `worker terminated, falling back; the runtime re-initializes on the next request`
        console.warn(`[bonds] ${msg}`)
        // Do NOT delete this entry before die(): die() rejects every entry
        // still in `pending` — including this one — which is what settles the
        // timed-out caller's promise so its fallback chain runs. (Deleting
        // first orphaned the promise forever — the wedged-worker hang this
        // deadline exists to prevent.) No double-reject is possible: die()
        // clears the map right after rejecting, so no later path (worker
        // reply, terminate(), a second die()) can reach this entry again.
        this.die(msg)
      }, timeout_ms)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.worker.postMessage({ ...data, id }, transfer ?? [])
    })
  }

  /** Typed-array hot path (atom_radii): no JSON, transfer lists both ways.
   *  `positions`/`atomic_numbers` are copied before transfer — the caller
   *  keeps ownership (frame positions are also the render source). */
  async compute_typed(input: TypedBondInput): Promise<TypedBondTable> {
    const pos_copy = input.positions.slice()
    const z_copy = input.atomic_numbers.slice()
    const lm = input.lattice_matrix
    const lattice = lm && lm.length === 3
      ? new Float64Array([...lm[0], ...lm[1], ...lm[2]])
      : new Float64Array(0)
    const pbc_arr = input.pbc
      ? new Uint8Array([input.pbc[0] ? 1 : 0, input.pbc[1] ? 1 : 0, input.pbc[2] ? 1 : 0])
      : new Uint8Array(0)
    const n_sites = input.atomic_numbers.length
    // Generous size-scaled deadline: big systems are legitimately slower, but
    // past this the worker is treated as wedged.
    const timeout_ms = Math.max(20_000, n_sites * 4)
    const resp = await this.request<TypedBondTable & { dt: string }>(
      {
        type: `bonds_typed`,
        positions: pos_copy,
        atomic_numbers: z_copy,
        lattice,
        pbc: pbc_arr,
        options_json: JSON.stringify(input.options),
      },
      timeout_ms,
      [pos_copy.buffer, z_copy.buffer, lattice.buffer, pbc_arr.buffer],
    )
    if (import.meta.env?.DEV) {
      console.log(
        `[bonds] Worker typed | atom_radii | ${n_sites} atoms | ${
          resp.pairs.length / 2
        } bonds | wasm ${resp.dt}ms`,
      )
    }
    return {
      pairs: resp.pairs,
      images: resp.images,
      lengths: resp.lengths,
      strengths: resp.strengths,
    }
  }

  private flatten_lattice(lattice_matrix: number[][] | null): Float64Array {
    return lattice_matrix?.length === 3
      ? new Float64Array([
        ...lattice_matrix[0],
        ...lattice_matrix[1],
        ...lattice_matrix[2],
      ])
      : new Float64Array(0)
  }

  private async ensure_trajectory_session(
    session: TrajectoryTypedBondInput[`session`],
  ): Promise<void> {
    if (this.trajectory_session_id === session.id) return
    const atomic_numbers = session.atomic_numbers.slice()
    const pbc = session.pbc
      ? new Uint8Array([
        session.pbc[0] ? 1 : 0,
        session.pbc[1] ? 1 : 0,
        session.pbc[2] ? 1 : 0,
      ])
      : new Uint8Array(0)
    await this.request<{ type: 'trajectory_session_ready' }>(
      {
        type: `trajectory_session_init`,
        session_id: session.id,
        atomic_numbers,
        pbc,
        options_json: JSON.stringify(session.options),
      },
      20_000,
      [atomic_numbers.buffer, pbc.buffer],
    )
    this.trajectory_session_id = session.id
  }

  async compute_trajectory_frame_typed(
    input: TrajectoryTypedBondInput,
  ): Promise<TrajectoryFrameWorkerResult> {
    await this.ensure_trajectory_session(input.session)
    const positions = input.positions.slice()
    const lattice = this.flatten_lattice(input.lattice_matrix)
    const atom_count = input.session.atomic_numbers.length
    const timeout_ms = Math.max(20_000, atom_count * 4)
    const response = await this.request<
      TypedBondTable & { gpu_positions_rgba: Float32Array; dt: string }
    >(
      {
        type: `trajectory_frame_typed`,
        session_id: input.session.id,
        positions,
        lattice,
      },
      timeout_ms,
      [positions.buffer, lattice.buffer],
    )
    return {
      table: {
        pairs: response.pairs,
        images: response.images,
        lengths: response.lengths,
        strengths: response.strengths,
      },
      gpu_positions_rgba: response.gpu_positions_rgba,
    }
  }

  async pack_trajectory_positions(
    input: Float32Array,
  ): Promise<Float32Array> {
    const positions = input.slice()
    const response = await this.request<{ gpu_positions_rgba: Float32Array }>(
      { type: `trajectory_positions_rgba`, positions },
      Math.max(20_000, positions.length),
      [positions.buffer],
    )
    return response.gpu_positions_rgba
  }

  request_json(
    data: Record<string, unknown>,
    timeout_ms?: number,
  ): Promise<{ result: string; dt: string }> {
    return this.request<{ result: string; dt: string }>(data, timeout_ms)
  }

  terminate(): void {
    try {
      this.worker.terminate()
    } catch {
      /* already dead */
    }
    for (const [, p] of this.pending) p.reject(new Error(`Worker terminated`))
    this.pending.clear()
  }
}

/** Create + fully initialize one rust bond worker: compile the artifact's
 *  wasm on the main thread, spawn the ?worker&inline entry, then run the init
 *  handshake ({type:'init', module, thread_count} → 'ready'). Any rejection —
 *  load/eval error, initSync failure, initThreadPool failure, or the
 *  WORKER_INIT_TIMEOUT_MS deadline — is an INIT failure for the runtime. */
async function create_rust_worker(
  kind: 'scalar' | 'threaded',
  thread_count: number,
): Promise<RealBondWorkerHandle> {
  const wasm_module = await compile_wasm_module(kind)

  const { default: WorkerCtor } = kind === `threaded`
    ? await import(`./bond-worker-threaded.ts?worker&inline`)
    : await import(`./bond-worker-scalar.ts?worker&inline`)
  const w: Worker = new WorkerCtor()

  try {
    await new Promise<void>((resolve, reject) => {
      const init_id = -1
      const cleanup = () => {
        clearTimeout(timeout)
        w.onmessage = null
        w.onerror = null
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(
          `Worker init timeout — no 'ready' within ${WORKER_INIT_TIMEOUT_MS}ms. The ` +
            `worker script loaded but never replied (slow first-time bundle/WASM ` +
            `init, a failed thread-pool spawn, or a blocked message).`,
        ))
      }, WORKER_INIT_TIMEOUT_MS)

      w.onmessage = (e: MessageEvent) => {
        if (e.data.id === init_id && e.data.type === `ready`) {
          cleanup()
          resolve()
        } else if (e.data.id === init_id && e.data.error) {
          cleanup()
          reject(new Error(`Worker init error: ${e.data.error}`))
        }
      }

      // A worker that fails to LOAD/eval (import failure, COI-blocked, syntax
      // error) fires `error` and never processes `init` — surface THAT as the
      // real cause instead of a generic timeout.
      w.onerror = (ev: ErrorEvent) => {
        cleanup()
        const where = ev?.filename ? ` (${ev.filename}:${ev.lineno}:${ev.colno})` : ``
        reject(new Error(`Worker load/eval error: ${ev?.message || `unknown`}${where}`))
      }

      w.postMessage({ type: `init`, id: init_id, module: wasm_module, thread_count })
    })
  } catch (err) {
    try {
      w.terminate()
    } catch {
      /* already dead */
    }
    throw err
  }

  console.log(`[bonds] Worker WASM initialized (${kind}, ${thread_count} thread(s))`)
  return new RealBondWorkerHandle(w, (handle) => runtime?.reset(handle), kind)
}

let runtime: BondWorkerRuntime | null = null

function get_runtime(): BondWorkerRuntime {
  if (!runtime) {
    runtime = create_bond_worker_runtime({
      detect_capabilities: () => detect_bond_backend_capabilities(),
      create_threaded_worker: (thread_count) => create_rust_worker(`threaded`, thread_count),
      create_scalar_worker: (thread_count) => create_rust_worker(`scalar`, thread_count),
    })
  }
  return runtime
}

/** Test seam — inject a runtime built on fake worker factories (pass null to
 *  restore the default lazily-created one). Mirrors the policy/capability
 *  injection pattern of bond-backend-policy / wasm-thread-capability. */
export function set_bond_worker_runtime_for_tests(rt: BondWorkerRuntime | null): void {
  runtime = rt
}

// ─── Public API ───

/** True when a rust bond worker is initialized and can accept requests
 *  immediately (no initialization latency). False until the first bond
 *  request (or prewarm) kicks off init and it completes. */
export function is_bond_worker_ready(): boolean {
  const backend = runtime?.active_backend() ?? null
  return backend === `rust-wasm-threads` || backend === `rust-wasm-scalar`
}

/** Kick off Worker initialization without blocking. Safe to call repeatedly —
 *  init is memoized and the disabled state short-circuits. Use this to warm
 *  the worker so a later bond request has no init latency. */
export function prewarm_bond_worker(): void {
  get_runtime().acquire(0).catch(() => {/* logged inside the runtime */})
  // Also kick off main-thread WASM init so compute_bonds_sync can use the
  // sync WASM path (which emits the `image` field needed for cross-cell
  // bond rendering). Without this, sync calls would fall through to the
  // pure-JS strategies that never produce non-zero jimage values.
  ensure_ferrox_wasm_ready().catch(() => {/* error already logged inside */})
}

/** Synchronous bond computation. Used by the bond effect to avoid microtask
 *  delay when WASM hasn't loaded yet, and as the small-structure fast path.
 *
 *  Priority chain:
 *    1. Main-thread Rust WASM (sync once initialized) — emits the `image`
 *       field needed for cross-cell half-bond rendering.
 *    2. Pure-JS BONDING_STRATEGIES — Cartesian-only, never produces
 *       cross-cell bonds (jimage stays [0,0,0]). Last-resort fallback.
 *  Returns null if the structure is too large for sync computation. */
export function compute_bonds_sync(
  structure: AnyStructure,
  strategy: BondingStrategy,
  options: Record<string, number>,
): BondPair[] | null {
  const n_sites = structure?.sites?.length ?? 0
  if (n_sites > JS_SYNC_FALLBACK_THRESHOLD) return null

  // Sync WASM path: initialized at app startup, so this is the common case
  // for user-loaded structures. Critical for cross-cell bond detection —
  // only Rust knows the lattice and emits proper `image` vectors.
  const mod = get_ferrox_wasm_sync()
  if (mod !== null) {
    try {
      const t0 = performance.now()
      const json = JSON.stringify(structure)
      const options_json = JSON.stringify(options)
      let result_json: string
      if (strategy === `atom_radii`) {
        result_json = mod.detect_bonds_radii(json, options_json) as unknown as string
      } else if (strategy === `electroneg_ratio`) {
        result_json = mod.detect_bonds_electronegativity(json, options_json) as unknown as string
      } else if (strategy === `solid_angle`) {
        result_json = mod.detect_bonds_solid_angle(json, options_json) as unknown as string
      } else {
        return null
      }
      const wasm_bonds: WasmBond[] = JSON.parse(result_json)
      const pairs = wasm_bonds_to_pairs(wasm_bonds, structure)
      const dt = (performance.now() - t0).toFixed(1)
      console.log(`[bonds] Sync WASM | ${strategy} | ${n_sites} atoms | ${pairs.length} bonds | ${dt}ms`)
      return pairs
    } catch (e) {
      console.warn(`[bonds] Sync WASM failed, falling back to JS:`, e)
      // fall through to JS path
    }
  }

  // Pure-JS fallback: never produces cross-cell bonds.
  try {
    const t0 = performance.now()
    const result = BONDING_STRATEGIES[strategy](structure, options)
    const dt = (performance.now() - t0).toFixed(1)
    console.log(`[bonds] JS sync | ${strategy} | ${n_sites} atoms | ${result.length} bonds | ${dt}ms`)
    return result
  } catch {
    return null
  }
}

/** Convert WasmBond[] → BondPair[] by adding positions and transform matrices.
 *  Exported for test purposes; not part of the runtime public API. */
export function wasm_bonds_to_pairs(wasm_bonds: WasmBond[], structure: AnyStructure): BondPair[] {
  const sites = structure.sites
  // Periodic self-image bonds (a==b, jimage != [0,0,0]) are VALID and pass
  // through unfiltered — FCC/BCC primitive metals (1-atom cells) have ONLY
  // such bonds. Whether/how they render (stub vs hide vs ghost image) is a
  // boundary-policy decision made downstream, not a detection-time filter
  // (gpu-impostor design §7.2).
  return wasm_bonds.map(wb => {
    const pos_1 = sites[wb.site_idx_1]?.xyz
    const pos_2 = sites[wb.site_idx_2]?.xyz
    if (!pos_1 || !pos_2) return null
    const pair: BondPair = {
      pos_1,
      pos_2,
      site_idx_1: wb.site_idx_1,
      site_idx_2: wb.site_idx_2,
      bond_length: wb.bond_length,
      strength: wb.strength,
      transform_matrix: compute_bond_transform(pos_1, pos_2),
      jimage: (wb.image ?? [0, 0, 0]) as [number, number, number],
    }
    return pair
  }).filter((b): b is BondPair => b !== null)
}

/** Try computing bonds via the runtime-selected rust worker (completely off
 *  main thread). Returns null when the worker is unavailable or errors — the
 *  caller decides whether a fallback is permitted (small systems only). */
async function try_worker_bonds(
  structure: AnyStructure,
  strategy: BondingStrategy,
  options: Record<string, number>,
): Promise<BondPair[] | null> {
  const n_sites = structure?.sites?.length ?? 0
  let handle: BondWorkerHandle
  try {
    // Lazy: the first call triggers artifact selection + worker init.
    ;({ handle } = await get_runtime().acquire(n_sites))
  } catch (err) {
    console.warn(
      `[bonds] worker unavailable:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
  if (typeof handle.request_json !== `function`) return null
  try {
    const structure_json = JSON.stringify(structure)
    const options_json = JSON.stringify(options)
    // Generous size-scaled deadline: big systems are legitimately slower, but
    // past this the worker is treated as wedged and the fallback chain runs.
    const timeout_ms = Math.max(20_000, n_sites * 4)
    const { result, dt } = await handle.request_json({
      type: `bonds`,
      structure_json,
      strategy,
      options_json,
    }, timeout_ms)
    const wasm_bonds: WasmBond[] = JSON.parse(result)
    const pairs = wasm_bonds_to_pairs(wasm_bonds, structure)
    console.log(`[bonds] Worker WASM | ${strategy} | ${n_sites} atoms | ${pairs.length} bonds | ${dt}ms`)
    return pairs
  } catch (err) {
    console.warn(`[bonds] worker path failed:`, err instanceof Error ? err.message : err)
    return null
  }
}

/** Try main-thread WASM bonding. Returns null if WASM unavailable. */
async function try_main_thread_wasm(
  structure: AnyStructure,
  strategy: BondingStrategy,
  options: Record<string, number>,
): Promise<BondPair[] | null> {
  try {
    const {
      detect_bonds_radii,
      detect_bonds_electronegativity,
      detect_bonds_solid_angle,
      is_ok,
    } = await import(`../ferrox-wasm`)
    const crystal = structure as Crystal

    const n_sites = structure?.sites?.length ?? 0
    const t0 = performance.now()
    let result
    if (strategy === `atom_radii`) {
      result = await detect_bonds_radii(crystal, options as any)
    } else if (strategy === `electroneg_ratio`) {
      result = await detect_bonds_electronegativity(crystal, options as any)
    } else if (strategy === `solid_angle`) {
      result = await detect_bonds_solid_angle(crystal, options as any)
    } else {
      return null
    }

    if (!is_ok(result)) return null
    const pairs = wasm_bonds_to_pairs(result.ok, structure)
    const dt = (performance.now() - t0).toFixed(1)
    console.log(`[bonds] Main WASM | ${strategy} | ${n_sites} atoms | ${pairs.length} bonds | ${dt}ms`)
    return pairs
  } catch {
    return null
  }
}

/** Compute bonds asynchronously. Priority: rust worker → main WASM → JS
 *  fallback — the last two for SMALL systems only (see module header). */
// solid_angle is O(neighborhood³)-ish and grinds for minutes on 10k+ atom
// systems (worst on WebKitGTK, whose WASM tier is far slower than Chrome) —
// the user sees "no bonds, ever". Above this size, silently compute with
// atom_radii instead: on force-field-scale systems the two agree closely
// (kerogen 11k: atom_radii found 12,668 bonds vs 12,648 in the file's own
// topology). Same precedent as the VS Code extension's trajectory downgrade.
const SOLID_ANGLE_MAX_ATOMS = 8000
let solid_angle_downgrade_logged = false

export function effective_strategy(strategy: BondingStrategy, n_sites: number): BondingStrategy {
  if (strategy === `solid_angle` && n_sites > SOLID_ANGLE_MAX_ATOMS) {
    if (!solid_angle_downgrade_logged) {
      solid_angle_downgrade_logged = true
      console.warn(
        `[bonds] solid_angle downgraded to atom_radii for ${n_sites} atoms ` +
          `(> ${SOLID_ANGLE_MAX_ATOMS}) — solid_angle is too slow at this size`,
      )
    }
    return `atom_radii`
  }
  return strategy
}

export function compute_bonds_async(
  structure: AnyStructure,
  strategy: BondingStrategy,
  options: Record<string, number>,
): Promise<BondPair[]> {
  strategy = effective_strategy(strategy, structure?.sites?.length ?? 0)
  // 1. Try the rust worker (non-blocking)
  return try_worker_bonds(structure, strategy, options).then(worker_result => {
    if (worker_result) return worker_result

    const n_sites = structure?.sites?.length ?? 0
    // HARD LINE (design §8.3): at this size the rust workers are the only
    // permitted backends. When they fail, bond detection is DISABLED with an
    // actionable error — never synchronous main-thread WASM, never the
    // main-thread JavaScript fallback. Callers must keep the last complete
    // graph on rejection.
    if (n_sites >= LARGE_SYSTEM_MIN_ATOMS) {
      return Promise.reject(new BondBackendUnavailableError(
        `bond detection disabled for ${n_sites} atoms — rust wasm bond workers ` +
          `unavailable, and main-thread fallbacks are forbidden at this size`,
      ))
    }

    // 2. Try main-thread WASM (blocks briefly)
    return try_main_thread_wasm(structure, strategy, options).then(wasm_result => {
      if (wasm_result) return wasm_result

      // 3. JS fallback (blocks) — small systems only
      console.warn(`[bonds] WASM unavailable, falling back to JS | ${strategy}`)

      // Small structure: compute directly
      if (n_sites <= JS_SYNC_FALLBACK_THRESHOLD) {
        try {
          const t0 = performance.now()
          const bonds = BONDING_STRATEGIES[strategy](structure, options)
          const dt = (performance.now() - t0).toFixed(1)
          console.log(`[bonds] JS async-fallback | ${strategy} | ${n_sites} atoms | ${bonds.length} bonds | ${dt}ms`)
          return bonds
        } catch (err) {
          return Promise.reject(err) as any
        }
      }

      // Mid-size structure (< LARGE_SYSTEM_MIN_ATOMS): schedule with
      // requestIdleCallback to avoid blocking interaction
      return new Promise((resolve, reject) => {
        const compute = () => {
          try {
            const t0 = performance.now()
            const bonds = BONDING_STRATEGIES[strategy](structure, options)
            const dt = (performance.now() - t0).toFixed(1)
            console.log(`[bonds] JS idle-callback | ${strategy} | ${n_sites} atoms | ${bonds.length} bonds | ${dt}ms`)
            resolve(bonds)
          } catch (err) {
            reject(err)
          }
        }
        if (typeof requestIdleCallback === `function`) {
          requestIdleCallback(() => compute(), { timeout: 500 })
        } else {
          setTimeout(compute, 0)
        }
      })
    })
  })
}

/** Orchestrated typed-array bond computation (atom_radii strategy) — the new
 *  primary entry. Selection, single scalar retry, and the disabled state live
 *  in bond-worker-runtime.ts; `backend` reports the artifact that served the
 *  request so the UI can surface it. Rejects with BondBackendUnavailableError
 *  once both rust workers have failed. */
export function compute_bonds_typed(
  input: TypedBondInput,
): Promise<ComputeBondsTypedResult> {
  return get_runtime().compute_bonds_typed(input)
}

export function compute_trajectory_frame_typed(
  input: TrajectoryTypedBondInput,
): Promise<ComputeTrajectoryFrameTypedResult> {
  return get_runtime().compute_trajectory_frame_typed(input)
}

export async function pack_trajectory_positions_worker(
  positions: Float32Array,
): Promise<Float32Array> {
  const { handle } = await get_runtime().acquire(positions.length / 3)
  return handle.pack_trajectory_positions(positions)
}

/** Typed-array bond computation via the rust worker (atom_radii strategy
 *  only) — no JSON, no structure objects, transfer lists both directions.
 *  Built for per-frame trajectory bonding at 10k+ atoms where JSON
 *  serialization of a 20k-site structure costs more than the detection.
 *
 *  Compatibility wrapper over compute_bonds_typed: returns null when the
 *  worker is unavailable or errors; callers fall back to the JSON path, whose
 *  compute_bonds_async enforces the large-system no-main-thread rule. */
export async function compute_bonds_typed_worker(
  positions: Float32Array,
  atomic_numbers: Uint8Array,
  lattice_matrix: number[][] | null,
  pbc: [boolean, boolean, boolean] | null,
  options: Record<string, number>,
): Promise<TypedBondTable | null> {
  try {
    const t0 = performance.now()
    const { table, backend } = await compute_bonds_typed({
      positions,
      atomic_numbers,
      lattice_matrix,
      pbc,
      options,
    })
    if (import.meta.env?.DEV) {
      const total = (performance.now() - t0).toFixed(1)
      console.log(
        `[bonds] ${backend} typed | atom_radii | ${atomic_numbers.length} atoms | ${
          table.pairs.length / 2
        } bonds | total ${total}ms`,
      )
    }
    return table
  } catch (err) {
    console.warn(
      `[bonds] typed worker path failed — falling back to JSON path:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/** Compute hydrogen bonds via the rust worker.
 *  Returns null if worker unavailable. */
export async function compute_hbonds_worker(
  structure: AnyStructure,
  covalent_bonds: Array<{ site_idx_1: number; site_idx_2: number; bond_length: number; strength: number }>,
  options: Record<string, number>,
): Promise<any[] | null> {
  try {
    const n_sites = structure?.sites?.length ?? 0
    const { handle } = await get_runtime().acquire(n_sites)
    if (typeof handle.request_json !== `function`) return null

    const structure_json = JSON.stringify(structure)
    const covalent_bonds_json = JSON.stringify(
      covalent_bonds.map(b => ({
        site_idx_1: b.site_idx_1,
        site_idx_2: b.site_idx_2,
        bond_length: b.bond_length,
        strength: b.strength,
        image: [0, 0, 0],
      })),
    )
    const options_json = JSON.stringify(options)
    const { result, dt } = await handle.request_json({
      type: `hbonds`,
      structure_json,
      covalent_bonds_json,
      options_json,
    })
    const hbonds = JSON.parse(result)
    console.log(`[h-bonds] Worker WASM | ${n_sites} atoms | ${hbonds.length} h-bonds | ${dt}ms`)
    return hbonds
  } catch {
    return null
  }
}

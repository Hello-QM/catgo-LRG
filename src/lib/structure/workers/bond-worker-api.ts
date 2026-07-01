// Bond computation API — delegates to Web Worker (WASM off main thread).
// Falls back to main-thread WASM/JS only if Worker is unavailable.
//
// Architecture:
//   1. Main thread initializes WASM via ensure_ferrox_wasm_ready, capturing
//      the WebAssembly.Module via instantiate interception
//   2. Worker is created via Vite ?worker&inline (bundles deps into the Worker)
//   3. WebAssembly.Module is sent to Worker via postMessage (structured-cloneable)
//   4. Worker calls initSync({ module }) — no WASM fetch needed in Worker
//   5. Bond detection runs entirely off main thread
//
// Priority chain:
//   1. Web Worker + WASM  (non-blocking, best performance)
//   2. Main-thread WASM   (blocks briefly, still fast)
//   3. Main-thread JS     (blocks, O(n²) with spatial grid)

import type { AnyStructure, BondPair, Crystal } from '$lib'
import { BONDING_STRATEGIES, type BondingStrategy, compute_bond_transform } from '../bonding'
import { compile_wasm_module, ensure_ferrox_wasm_ready, get_ferrox_wasm_sync } from '../ferrox-wasm'
import type { WasmBond } from '../ferrox-wasm-types'

/** Threshold below which bonds are computed synchronously via JS.
 *  Spatial grid optimization keeps JS fast (~30-80ms for 1000 atoms).
 *  Synchronous computation ensures bonds and atoms appear in the same
 *  render frame — async Worker causes visible timing gaps during
 *  trajectory playback. Note: PBC image atoms can add 200-400 extra
 *  atoms to the displayed structure, so this must be well above the
 *  base atom count to stay on the sync path. */
const JS_SYNC_FALLBACK_THRESHOLD = 1000

// ─── Web Worker management ───

let worker: Worker | null = null
let worker_ready = false
let worker_failed = false
let worker_init_promise: Promise<void> | null = null
let pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
let next_id = 0

/** Initialize the Worker with the compiled WASM module. */
async function init_worker(): Promise<void> {
  if (worker_ready) return
  if (worker_failed) throw new Error(`Worker permanently failed`)
  if (worker_init_promise) return worker_init_promise

  worker_init_promise = (async () => {
    try {
      // 1. Get compiled WASM Module (captured during ensure_ferrox_wasm_ready init)
      const wasm_module = await compile_wasm_module()

      // 2. Create Worker via ?worker&inline — Vite bundles bond-worker.ts and all
      //    its imports (including @catgo/ferrox-wasm JS glue) into an inline blob.
      //    This bypasses SvelteKit's IIFE worker.format override.
      const { default: BondWorker } = await import(`./bond-worker.ts?worker&inline`)
      const w: Worker = new BondWorker()

      // 3. Set up message handler for ongoing communication
      w.onmessage = (e: MessageEvent) => {
        const { id, type: msg_type, result, error, dt } = e.data
        if (msg_type === `ready`) {
          return
        }
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        if (error) {
          p.reject(new Error(error))
        } else {
          p.resolve({ result, dt })
        }
      }

      w.onerror = () => {
        worker_failed = true
        worker = null
        worker_ready = false
        for (const [, p] of pending) p.reject(new Error(`Worker failed`))
        pending.clear()
      }

      // 4. Send compiled WebAssembly.Module to Worker for initSync
      const init_id = next_id++
      const original_onmessage = w.onmessage
      const original_onerror = w.onerror
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout)
          w.onmessage = original_onmessage
          w.onerror = original_onerror
        }
        const timeout = setTimeout(() => {
          cleanup()
          reject(new Error(
            `Worker init timeout — no 'ready' within 10s. The worker script ` +
            `loaded but never replied (slow first-time bundle/WASM init, or a ` +
            `blocked message).`,
          ))
        }, 10_000)

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
        // real cause instead of a generic 10s timeout.
        w.onerror = (ev: ErrorEvent) => {
          cleanup()
          const where = ev?.filename ? ` (${ev.filename}:${ev.lineno}:${ev.colno})` : ``
          reject(new Error(`Worker load/eval error: ${ev?.message || `unknown`}${where}`))
        }

        w.postMessage({ type: `init`, id: init_id, module: wasm_module })
      })

      worker = w
      worker_ready = true
      console.log(`[bonds] Worker WASM initialized`)
    } catch (err) {
      worker_failed = true
      worker_init_promise = null
      console.warn(`[bonds] Worker init failed, falling back to main thread:`, err)
      throw err
    }
  })()

  return worker_init_promise
}

function worker_request(data: Record<string, unknown>): Promise<{ result: string; dt: string }> {
  return new Promise((resolve, reject) => {
    if (!worker || !worker_ready) { reject(new Error(`Worker unavailable`)); return }
    const id = next_id++
    pending.set(id, { resolve, reject })
    worker.postMessage({ ...data, id })
  })
}

// ─── Public API ───

/** True when the Worker has finished init and can accept bond requests
 *  immediately (no initialization latency). False until the first
 *  `compute_bonds_async` call kicks off init and it completes. */
export function is_bond_worker_ready(): boolean {
  return worker_ready && !worker_failed
}

/** Kick off Worker initialization without blocking. Safe to call repeatedly —
 *  it's a no-op once the worker is ready or has permanently failed. Use this
 *  to warm the worker so a later `compute_bonds_async` call has no init
 *  latency. */
export function prewarm_bond_worker(): void {
  if (worker_ready || worker_failed || worker_init_promise) return
  init_worker().catch(() => { /* logged inside init_worker */ })
  // Also kick off main-thread WASM init so compute_bonds_sync can use the
  // sync WASM path (which emits the `image` field needed for cross-cell
  // bond rendering). Without this, sync calls would fall through to the
  // pure-JS strategies that never produce non-zero jimage values.
  ensure_ferrox_wasm_ready().catch(() => { /* error already logged inside */ })
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
  // Filter out cross-cell self-image bonds (a==b, jimage != [0,0,0]). These
  // are the "metal-metal" bonds Rust emits for adjacent cells of the same
  // atom (e.g. Sr→Sr_image at 4 Å in a perovskite unit cell). Visually they
  // clutter the scene as a starburst of stubs around every atom that touches
  // a cell face, so we drop them by default. FCC/BCC primitive metals
  // (1-atom cells) lose all their bonds with this filter — they should opt
  // back in once we add a UI toggle.
  wasm_bonds = wasm_bonds.filter(b => {
    if (b.site_idx_1 !== b.site_idx_2) return true
    const img = (b as { image?: [number, number, number] }).image
    return !img || (img[0] | img[1] | img[2]) === 0
  })
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

/** Try computing bonds via Web Worker (completely off main thread). */
async function try_worker_bonds(
  structure: AnyStructure,
  strategy: BondingStrategy,
  options: Record<string, number>,
): Promise<BondPair[] | null> {
  if (worker_failed) return null
  try {
    // Ensure Worker is initialized (lazy, first call triggers compilation + init)
    await init_worker()

    const structure_json = JSON.stringify(structure)
    const options_json = JSON.stringify(options)
    const { result, dt } = await worker_request({
      type: `bonds`,
      structure_json,
      strategy,
      options_json,
    })
    const wasm_bonds: WasmBond[] = JSON.parse(result)
    const n_sites = structure?.sites?.length ?? 0
    const pairs = wasm_bonds_to_pairs(wasm_bonds, structure)
    console.log(`[bonds] Worker WASM | ${strategy} | ${n_sites} atoms | ${pairs.length} bonds | ${dt}ms`)
    return pairs
  } catch {
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

/** Compute bonds asynchronously. Priority: Worker WASM → Main WASM → JS fallback. */
export function compute_bonds_async(
  structure: AnyStructure,
  strategy: BondingStrategy,
  options: Record<string, number>,
): Promise<BondPair[]> {
  // 1. Try Web Worker (non-blocking)
  return try_worker_bonds(structure, strategy, options).then(worker_result => {
    if (worker_result) return worker_result

    // 2. Try main-thread WASM (blocks briefly)
    return try_main_thread_wasm(structure, strategy, options).then(wasm_result => {
      if (wasm_result) return wasm_result

      // 3. JS fallback (blocks)
      console.warn(`[bonds] WASM unavailable, falling back to JS | ${strategy}`)
      const n_sites = structure?.sites?.length ?? 0

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

      // Large structure: schedule with requestIdleCallback to avoid blocking interaction
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

/** Compute hydrogen bonds via Web Worker.
 *  Returns null if worker unavailable. */
export async function compute_hbonds_worker(
  structure: AnyStructure,
  covalent_bonds: Array<{ site_idx_1: number; site_idx_2: number; bond_length: number; strength: number }>,
  options: Record<string, number>,
): Promise<any[] | null> {
  if (worker_failed) return null
  try {
    await init_worker()

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
    const { result, dt } = await worker_request({
      type: `hbonds`,
      structure_json,
      covalent_bonds_json,
      options_json,
    })
    const n_sites = structure?.sites?.length ?? 0
    const hbonds = JSON.parse(result)
    console.log(`[h-bonds] Worker WASM | ${n_sites} atoms | ${hbonds.length} h-bonds | ${dt}ms`)
    return hbonds
  } catch {
    return null
  }
}

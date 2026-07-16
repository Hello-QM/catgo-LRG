/** Pure detection of the browser capabilities that gate the threaded Rust-WASM
 *  bond backend (see design §6.3). This module has NO side effects and touches no
 *  worker/GPU/wasm runtime — it only reads globals so the dispatch policy
 *  (`bond-backend-policy.ts`) stays a pure, deterministic decision.
 *
 *  The threaded ferrox artifact (`wasm-bindgen-rayon` + SharedArrayBuffer +
 *  wasm threads/atomics) is only loadable when the page is cross-origin isolated
 *  AND SharedArrayBuffer AND wasm atomics are all present. Otherwise CatGo must
 *  fall back to the scalar SIMD artifact. */

import type { BondBackendCapabilities } from './bond-backend-policy'

/** Max worker threads in the Rayon pool. One logical core is always reserved for
 *  the UI thread, and the pool is capped here to avoid oversubscription on
 *  many-core machines (design §8.3). */
export const MAX_BOND_THREADS = 8

/** True when `crossOriginIsolated` is set. Required for SharedArrayBuffer, which
 *  the Rayon thread pool needs to share the wasm linear memory across workers. */
export function detect_cross_origin_isolated(
  scope: { crossOriginIsolated?: boolean } = globalThis,
): boolean {
  return scope.crossOriginIsolated === true
}

/** True when the `SharedArrayBuffer` constructor is available in this realm. */
export function detect_shared_array_buffer(
  scope: { SharedArrayBuffer?: unknown } = globalThis,
): boolean {
  return typeof scope.SharedArrayBuffer === `function`
}

/** True when this engine supports WebAssembly threads/atomics. We probe for the
 *  `Atomics` global together with `SharedArrayBuffer`; both are prerequisites for
 *  `wasm-bindgen-rayon`. The exact bytecode-feature probe (a `shared` memory
 *  validation) belongs to the artifact loader, not this pure gate. */
export function detect_wasm_atomics(
  scope: { Atomics?: unknown; SharedArrayBuffer?: unknown } = globalThis,
): boolean {
  return typeof scope.Atomics === `object` && scope.Atomics !== null &&
    typeof scope.SharedArrayBuffer === `function`
}

/** Logical core count, defaulting to 1 when the browser hides it. */
export function detect_hardware_concurrency(
  scope: { navigator?: { hardwareConcurrency?: number } } = globalThis,
): number {
  const hc = scope.navigator?.hardwareConcurrency
  return typeof hc === `number` && hc >= 1 ? Math.floor(hc) : 1
}

/** Snapshot every capability the dispatch policy needs, read once from the
 *  current global scope. Pure aside from reading globals; the returned record is
 *  what `select_rust_bond_backend` consumes. */
export function detect_bond_backend_capabilities(
  scope: typeof globalThis = globalThis,
): BondBackendCapabilities {
  return {
    cross_origin_isolated: detect_cross_origin_isolated(scope),
    shared_array_buffer: detect_shared_array_buffer(scope),
    wasm_atomics: detect_wasm_atomics(scope),
    hardware_concurrency: detect_hardware_concurrency(scope),
  }
}

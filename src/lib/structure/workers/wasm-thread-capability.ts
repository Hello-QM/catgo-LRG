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

/** Encodes `(module (memory 1 1 shared))` — the smallest wasm module whose
 *  memory limits flag (0x03 = max-present | shared) requires the threads/atomics
 *  feature. Engines without wasm threads reject it as malformed, so
 *  `WebAssembly.validate` on these bytes is the standard synchronous feature
 *  probe (same approach as wasm-feature-detect's `threads()`). */
const WASM_SHARED_MEMORY_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // `\0asm` magic
  0x01, 0x00, 0x00, 0x00, // binary format version 1
  0x05, 0x04, // memory section (id 5), 4 bytes long
  0x01, // one memory entry
  0x03, 0x01, 0x01, // limits: flags 0x03 (shared + has max), min 1, max 1
])

/** True when this engine supports WebAssembly threads/atomics — a prerequisite
 *  for `wasm-bindgen-rayon`. Probed by validating a tiny shared-memory wasm
 *  module (see above); the JS `Atomics`/`SharedArrayBuffer` globals are NOT a
 *  proxy for this, since an engine can expose both while rejecting threaded
 *  wasm. Pure and synchronous; `false` when `WebAssembly` is absent or
 *  `validate` is missing/throws. */
export function detect_wasm_atomics(
  scope: {
    WebAssembly?: { validate?: (bytes: BufferSource) => boolean }
  } = globalThis,
): boolean {
  try {
    return scope.WebAssembly?.validate?.(WASM_SHARED_MEMORY_MODULE) === true
  } catch {
    return false
  }
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

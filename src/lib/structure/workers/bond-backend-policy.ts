/** Pure bond-backend dispatch policy (design §6, §8).
 *
 *  This module is a deterministic decision layer only — it does NOT touch the
 *  GPU, spawn a worker, or load a wasm artifact. Given the same inputs it always
 *  returns the same plan, so it is trivially unit-testable and safe to call on
 *  the hot path before any device work.
 *
 *  Two independent decisions:
 *   1. `plan_bond_dispatch` — which COMPUTE path a bond-detection request takes:
 *        direct all-pairs (tiny N), the WebGPU uniform-grid, or Rust WASM.
 *   2. `select_rust_bond_backend` — when the request lands on Rust WASM, whether
 *        the threaded (Rayon) or scalar SIMD artifact is used and how many worker
 *        threads the pool gets.
 *
 *  Hard invariants enforced here:
 *   - Direct all-pairs is allowed ONLY for `atom_count <= MAX_DIRECT_ATOMS`
 *     (1024). A large system can never be routed to an all-pairs shader, so it
 *     can never enter an O(N²) × 27-image path.
 *   - A large periodic thin cell (grid dim 1 or 2 ⇒ `plan_grid` reports
 *     `use_grid: false`) routes to Rust WASM, NOT the old all-pairs GPU fallback.
 *   - A grid whose fixed-capacity storage would exceed the caller's budget routes
 *     to Rust WASM rather than silently overflowing. */

import { type GridInput, type GridPlan, plan_grid } from '$lib/structure/gpu/bond-grid'
import { MAX_BOND_THREADS } from './wasm-thread-capability'

/** The concrete bond backends a request can be served by. `disabled` is the
 *  terminal state when every backend fails for a large system (design §8.3) — the
 *  policy never falls back to main-thread JavaScript bond detection. */
export type BondBackendKind =
  | 'webgpu-grid'
  | 'rust-wasm-threads'
  | 'rust-wasm-scalar'
  | 'disabled'

/** The compute path chosen for one bond-detection request.
 *  - `direct`: GPU all-pairs, only for tiny systems (`small-n`).
 *  - `gpu-grid`: WebGPU uniform-grid compute over the supplied `GridPlan`.
 *  - `rust-wasm`: hand off to a ferrox WASM artifact, either because a periodic
 *    thin cell makes the grid unusable, or because the grid's fixed-capacity
 *    storage would exceed the caller's budget. */
export type BondDispatchPlan =
  | { kind: 'direct'; reason: 'small-n' }
  | { kind: 'gpu-grid'; grid: GridPlan }
  | { kind: 'rust-wasm'; reason: 'periodic-thin-cell' | 'grid-storage-limit' }

/** Browser capabilities that gate the threaded Rust-WASM backend (design §6.3).
 *  Produced by `detect_bond_backend_capabilities` in wasm-thread-capability.ts. */
export interface BondBackendCapabilities {
  cross_origin_isolated: boolean
  shared_array_buffer: boolean
  wasm_atomics: boolean
  hardware_concurrency: number
}

/** Upper bound on atoms served by the direct all-pairs path. Above this a system
 *  must use the grid or Rust WASM — never an O(N²) shader. Kept well below the
 *  4096-atom "never on the main thread" line so direct stays a genuinely small-N
 *  convenience. */
export const MAX_DIRECT_ATOMS = 1024

/** Bytes the fixed-capacity uniform grid would allocate for `grid`:
 *  one u32 atom slot per cell·capacity plus one u32 counter per cell. Used to
 *  keep a pathological grid (e.g. a huge sparse AABB) from exceeding the device's
 *  storage-buffer budget — such a request routes to Rust WASM instead. */
export function grid_storage_bytes(grid: GridPlan): number {
  return grid.n_cells * (grid.max_per_cell + 1) * 4
}

/** Decide the compute path for one bond-detection request. Pure over its inputs.
 *
 *  Order of precedence:
 *   1. tiny system (`atom_count <= min(direct_limit, MAX_DIRECT_ATOMS)`) → direct;
 *   2. periodic thin cell (`plan_grid` ⇒ `use_grid: false`) → rust-wasm;
 *   3. grid storage over budget → rust-wasm;
 *   4. otherwise → the WebGPU uniform grid. */
export function plan_bond_dispatch(
  input: GridInput & {
    atom_count: number
    direct_limit: number
    max_storage_bytes: number
  },
): BondDispatchPlan {
  const { atom_count, direct_limit, max_storage_bytes } = input

  // Direct all-pairs is a small-N convenience only. The 1024 hard cap wins even
  // if the caller passes a larger direct_limit, so a big system is never routed
  // to an all-pairs shader.
  const direct_ceiling = Math.min(direct_limit, MAX_DIRECT_ATOMS)
  if (atom_count <= direct_ceiling) {
    return { kind: `direct`, reason: `small-n` }
  }

  const grid = plan_grid(input)

  // A periodic thin cell (any dim < MIN_GRID_DIM) leaves the 27-cell grid unable
  // to capture all images. Rather than the old O(N²) all-pairs GPU fallback, a
  // large system routes to Rust WASM.
  if (!grid.use_grid) {
    return { kind: `rust-wasm`, reason: `periodic-thin-cell` }
  }

  // A grid whose fixed-capacity buffers would blow the storage budget hands off
  // to Rust WASM instead of silently overflowing / dropping bonds.
  if (grid_storage_bytes(grid) > max_storage_bytes) {
    return { kind: `rust-wasm`, reason: `grid-storage-limit` }
  }

  return { kind: `gpu-grid`, grid }
}

/** Pick the Rust-WASM artifact + thread-pool size once a request has been routed
 *  to Rust (design §6.3, §8.3). Pure over its inputs.
 *
 *  Threads are chosen ONLY when the page is cross-origin isolated AND
 *  SharedArrayBuffer AND wasm atomics are available AND there are at least two
 *  logical cores. Otherwise the scalar SIMD artifact is used.
 *
 *  When threaded, `thread_count = clamp(hardware_concurrency - 1, 1, 8)`: one
 *  logical core is always reserved for the UI, and the pool is capped at
 *  `MAX_BOND_THREADS` to avoid oversubscription. The scalar backend reports
 *  `thread_count: 1`. `atom_count` is surfaced in the diagnostic `reason`. */
export function select_rust_bond_backend(
  caps: BondBackendCapabilities,
  atom_count: number,
): {
  kind: 'rust-wasm-threads' | 'rust-wasm-scalar'
  thread_count: number
  reason: string
} {
  if (!caps.cross_origin_isolated) {
    return {
      kind: `rust-wasm-scalar`,
      thread_count: 1,
      reason: `scalar: not cross-origin isolated`,
    }
  }
  if (!caps.shared_array_buffer) {
    return {
      kind: `rust-wasm-scalar`,
      thread_count: 1,
      reason: `scalar: SharedArrayBuffer unavailable`,
    }
  }
  if (!caps.wasm_atomics) {
    return {
      kind: `rust-wasm-scalar`,
      thread_count: 1,
      reason: `scalar: wasm atomics unsupported`,
    }
  }
  if (caps.hardware_concurrency < 2) {
    return {
      kind: `rust-wasm-scalar`,
      thread_count: 1,
      reason: `scalar: only ${caps.hardware_concurrency} logical core(s)`,
    }
  }

  const thread_count = Math.min(
    MAX_BOND_THREADS,
    Math.max(1, caps.hardware_concurrency - 1),
  )
  return {
    kind: `rust-wasm-threads`,
    thread_count,
    reason:
      `threads: ${thread_count} worker(s), 1 core reserved for UI (${atom_count} atoms)`,
  }
}

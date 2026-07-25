/** Lossless overflow publication + dirty-kind split for the GPU bond pipeline
 *  (design §8.2).
 *
 *  This module is PURE state: it never touches the GPU. The renderer feeds it
 *  dispatch records and readback observations; it answers, deterministically,
 *  whether a candidate bond graph is COMPLETE (publishable) or must grow its
 *  sizing and rerun. Two invariants:
 *
 *   1. An incomplete candidate (cell or pair overflow ⇒ atoms/bonds dropped)
 *      is NEVER published — grow to nextPow2 and rerun, within bounded limits.
 *   2. Hitting an allocation limit reports an error WITHOUT replacing the
 *      active graph — the last complete graph stays on screen.
 */

/** What one scene change invalidates (design §8.2 items 4-6):
 *  - `graph`: the base bond graph must be re-detected (positions, lattice,
 *    topology, distance rules, bond options).
 *  - `replica`: only the replica/indirect draw state must refresh (supercell
 *    tiling, PBC image policy) — the base graph is REUSED, no bond dispatch.
 *  - `visual`: nothing bond-related reruns (camera, background, selection,
 *    hover). */
export type BondDirtyKind = 'graph' | 'replica' | 'visual'

/** Scene-change sources, mapped onto the three dirty kinds by
 *  `classify_bond_dirty`. */
export type BondInvalidationSource =
  | 'positions'
  | 'lattice'
  | 'topology'
  | 'rules'
  | 'options'
  | 'supercell'
  | 'image-policy'
  | 'camera'
  | 'background'
  | 'selection'
  | 'hover'

/** Map a scene-change source to the state it invalidates. Pure + total. */
export function classify_bond_dirty(source: BondInvalidationSource): BondDirtyKind {
  switch (source) {
    case `positions`:
    case `lattice`:
    case `topology`:
    case `rules`:
    case `options`:
      return `graph`
    case `supercell`:
    case `image-policy`:
      return `replica`
    default:
      return `visual`
  }
}

/** Deterministic diagnostics snapshot of the GPU bond pipeline, exposed by the
 *  renderer's `debug_bond_state()`. */
export interface BondGpuDiagnostics {
  graph_version: number
  dispatches: { clear: number; bin: number; detect: number }
  grid: {
    dims: [number, number, number]
    cell_stride: number
    max_observed_occupancy: number
  }
  pairs: { raw: number; capacity: number }
  overflow: { cells: boolean; pairs: boolean; retries: number }
  timing_ms?: { clear: number; bin: number; detect: number; draw: number }
}

/** Bounded allocation limits for overflow growth. Exceeding any of them turns
 *  a retry into an allocation-limit error (the active graph is preserved). */
export interface BondOverflowLimits {
  /** Max pairs the pair buffer may grow to (buffer bytes = capacity · 12). */
  max_pair_capacity: number
  /** Max per-cell atom stride the grid may grow to. */
  max_cell_stride: number
  /** Max grow-and-rerun cycles for one graph before giving up. */
  max_retries: number
}

export const DEFAULT_BOND_OVERFLOW_LIMITS: BondOverflowLimits = {
  max_pair_capacity: 1 << 22, // 4M pairs = 48 MB — far above any real system
  max_cell_stride: 1 << 11, // 2048 atoms in one 3Å cell would be unphysical
  max_retries: 8,
}

/** Smallest power of two ≥ n (exact at powers of two; n ≤ 1 ⇒ 1). */
export function next_pow2(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}

/** One run's readback: the shader's unclamped atomic pair count plus the
 *  maximum per-cell occupancy bin_atoms observed (0 on the direct path). */
export type BondRunObservation = {
  raw_count: number
  max_observed_occupancy: number
}

/** The controller's verdict on one completed run. */
export type BondRunDecision =
  | { action: 'publish' }
  | { action: 'retry'; cell_stride: number; pair_capacity: number }
  | { action: 'allocation-limit'; message: string }

export interface BondRunController {
  /** Per-cell stride the NEXT dispatch must size its cell_atoms buffer with. */
  cell_stride(): number
  /** Pair capacity the NEXT dispatch must size its pairs buffer with. */
  pair_capacity(): number
  /** Raise the pair capacity floor (e.g. the n_atoms·16 heuristic). Never
   *  shrinks. */
  ensure_pair_capacity(min_capacity: number): void
  /** A FRESH graph invalidation chain starts (NOT a retry): resets the retry
   *  counter and overflow flags. */
  begin_graph(): void
  /** Record the compute passes one dispatch encoded (+ the grid dims used;
   *  omit dims on the gridless direct path). */
  record_dispatch(
    passes: { clear?: boolean; bin?: boolean; detect?: boolean },
    dims?: [number, number, number],
  ): void
  /** Feed one run's readback; decide publish / grow-and-retry / limit error.
   *  Publishing bumps graph_version. A retry mutates the controller's sizing
   *  (visible via cell_stride/pair_capacity) so the rerun uses it. */
  observe(obs: BondRunObservation): BondRunDecision
  /** Deterministic snapshot (fresh object every call). */
  diagnostics(): BondGpuDiagnostics
}

export function create_bond_run_controller(cfg: {
  cell_stride: number
  pair_capacity: number
  limits?: Partial<BondOverflowLimits>
}): BondRunController {
  const limits: BondOverflowLimits = { ...DEFAULT_BOND_OVERFLOW_LIMITS, ...cfg.limits }
  let cell_stride = Math.max(1, cfg.cell_stride)
  let pair_capacity = Math.max(1, cfg.pair_capacity)
  let graph_version = 0
  let retries = 0
  const dispatches = { clear: 0, bin: 0, detect: 0 }
  let grid_dims: [number, number, number] = [0, 0, 0]
  let last_occupancy = 0
  let last_raw = 0
  let cells_over = false
  let pairs_over = false

  return {
    cell_stride: () => cell_stride,
    pair_capacity: () => pair_capacity,
    ensure_pair_capacity(min_capacity: number): void {
      if (min_capacity > pair_capacity) pair_capacity = min_capacity
    },
    begin_graph(): void {
      retries = 0
      cells_over = false
      pairs_over = false
    },
    record_dispatch(
      passes: { clear?: boolean; bin?: boolean; detect?: boolean },
      dims?: [number, number, number],
    ): void {
      if (passes.clear) dispatches.clear += 1
      if (passes.bin) dispatches.bin += 1
      if (passes.detect) dispatches.detect += 1
      grid_dims = dims ? [dims[0], dims[1], dims[2]] : [0, 0, 0]
    },
    observe(obs: BondRunObservation): BondRunDecision {
      last_occupancy = obs.max_observed_occupancy
      last_raw = obs.raw_count
      cells_over = obs.max_observed_occupancy > cell_stride
      pairs_over = obs.raw_count > pair_capacity
      if (!cells_over && !pairs_over) {
        // Complete candidate: nothing was dropped. Publish.
        graph_version += 1
        return { action: `publish` }
      }
      const next_stride = cells_over ? next_pow2(obs.max_observed_occupancy) : cell_stride
      const next_capacity = pairs_over ? next_pow2(obs.raw_count) : pair_capacity
      if (retries >= limits.max_retries) {
        return {
          action: `allocation-limit`,
          message: `bond compute did not converge after ${limits.max_retries} ` +
            `retries — keeping the last complete graph`,
        }
      }
      if (next_stride > limits.max_cell_stride) {
        return {
          action: `allocation-limit`,
          message: `grid cell stride ${next_stride} exceeds the allocation limit ` +
            `${limits.max_cell_stride} — keeping the last complete graph`,
        }
      }
      if (next_capacity > limits.max_pair_capacity) {
        return {
          action: `allocation-limit`,
          message: `pair capacity ${next_capacity} exceeds the allocation limit ` +
            `${limits.max_pair_capacity} — keeping the last complete graph`,
        }
      }
      retries += 1
      cell_stride = next_stride
      pair_capacity = next_capacity
      return { action: `retry`, cell_stride, pair_capacity }
    },
    diagnostics(): BondGpuDiagnostics {
      return {
        graph_version,
        dispatches: { ...dispatches },
        grid: {
          dims: [grid_dims[0], grid_dims[1], grid_dims[2]],
          cell_stride,
          max_observed_occupancy: last_occupancy,
        },
        pairs: { raw: last_raw, capacity: pair_capacity },
        overflow: { cells: cells_over, pairs: pairs_over, retries },
      }
    },
  }
}

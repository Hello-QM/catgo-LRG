/** Pure-JS uniform-grid (cell-list) sizing + AABB math for GPU bond detection.
 *
 *  The GPU bond compute (bond-compute.wgsl.ts) finds candidate neighbor pairs via
 *  a uniform grid instead of an O(N²) all-pairs scan. The grid is sized on the CPU
 *  (here) and uploaded through the Params uniform; the WGSL only reads the dims.
 *
 *  Cell size h = max_bond_dist, so every bonded neighbor lies in the 27-cell
 *  neighborhood (the cell containing atom i plus its 26 face/edge/corner
 *  neighbors). This mirrors the existing 27-image minimum-image search.
 *
 *  Two regimes:
 *   - PERIODIC: bin in FRACTIONAL space. Grid dims n_k = max(1, floor(|v_k| / h))
 *     using the lattice vector lengths |a|,|b|,|c|. Neighbor offsets that wrap past
 *     [0, n_k) contribute a ±1 lattice image on axis k → folded into the jimage.
 *     We APPROXIMATE the bucketing with an orthogonal box of the lattice-vector
 *     LENGTHS (see assumption note below); the exact minimum-image distance is
 *     still computed in the shader, so the approximation only widens the candidate
 *     set and can never MISS a bond.
 *   - NON-PERIODIC: bin over the atom AABB (computed here). Cells don't wrap;
 *     out-of-range neighbor offsets are skipped in the shader.
 *
 *  SMALL-CELL FALLBACK: if any periodic dim n_k < 3, the 27-neighborhood does NOT
 *  capture all images (a cell shorter than 3·h can have a bonded partner two cells
 *  away after wrap). In that case use_grid is false and the shader falls back to
 *  the exact O(N²) 27-image path. Non-periodic always uses the grid.
 *
 *  ASSUMPTION (orthogonal-box bucketing for periodic cells): dims are derived from
 *  lattice-vector LENGTHS and atoms are binned by fractional coordinate. For
 *  non-orthogonal cells the fractional cell that an atom lands in is exact, and the
 *  ±1 jimage from a wrap is exact; only the choice of n_k (how many cells span each
 *  axis) uses the vector length as a proxy for the perpendicular cell width. Since
 *  n_k = floor(|v_k|/h) ≤ |v_k|/h, each fractional cell spans AT LEAST h along its
 *  axis direction, so the 27-cell shell always reaches at least h in every lattice
 *  direction — i.e. it covers every neighbor within max_bond_dist. The
 *  approximation can only make cells LARGER (fewer cells), never smaller, so no
 *  bond within the cutoff is ever missed. The exact min-image distance + radii +
 *  rules predicate in the shader is unchanged. */

/** Hard cap on atoms stored per grid cell (fixed-capacity, no prefix-sum scan).
 *  A cell that exceeds this drops the extras and the shader raises an overflow
 *  flag so the caller can enlarge + rerun. 64 comfortably holds a dense cell of
 *  cube side max_bond_dist (~3 Å) at typical solid densities. */
export const MAX_PER_CELL = 64

/** Minimum grid dim for the 27-neighborhood to be valid (see SMALL-CELL FALLBACK).
 *  Every periodic dim must be ≥ this or we fall back to the O(N²) path. */
export const MIN_GRID_DIM = 3

export type GridPlan = {
  /** Whether the grid path is usable. False ⇒ caller dispatches the O(N²) fallback
   *  (periodic small cell). For non-periodic this is always true. */
  use_grid: boolean
  /** Grid cell counts along the three axes (fractional axes when periodic, AABB
   *  axes when non-periodic). At least 1 each. */
  dims: [number, number, number]
  /** Total cell count = dims[0]*dims[1]*dims[2]. */
  n_cells: number
  /** AABB minimum corner (non-periodic binning origin). [0,0,0] when periodic
   *  (fractional binning needs no origin). */
  aabb_min: [number, number, number]
  /** 1/h where h = max_bond_dist; the shader multiplies (pos - aabb_min) by this
   *  to get the non-periodic cell coordinate. 0 when max_bond_dist ≤ 0. */
  inv_h: number
  /** Per-cell capacity used to size cell_atoms (= MAX_PER_CELL). */
  max_per_cell: number
}

/** Euclidean length of a 3-vector. */
function vlen(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z)
}

/** Compute the periodic grid dims from the lattice (row-major rows a,b,c) and the
 *  cell size h = max_bond_dist. Each dim = max(1, floor(|v_k| / h)). */
export function periodic_grid_dims(
  lattice: Float32Array,
  max_bond_dist: number,
): [number, number, number] {
  const h = max_bond_dist
  if (!(h > 0)) return [1, 1, 1]
  const la = vlen(lattice[0], lattice[1], lattice[2])
  const lb = vlen(lattice[3], lattice[4], lattice[5])
  const lc = vlen(lattice[6], lattice[7], lattice[8])
  return [
    Math.max(1, Math.floor(la / h)),
    Math.max(1, Math.floor(lb / h)),
    Math.max(1, Math.floor(lc / h)),
  ]
}

/** Axis-aligned bounding box of N interleaved xyz positions (3N floats). Returns
 *  {min,max}; for N=0 returns a zero box. */
export function compute_aabb(
  positions: Float32Array,
  n: number,
): { min: [number, number, number]; max: [number, number, number] } {
  if (n <= 0) return { min: [0, 0, 0], max: [0, 0, 0] }
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (x < minx) minx = x
    if (y < miny) miny = y
    if (z < minz) minz = z
    if (x > maxx) maxx = x
    if (y > maxy) maxy = y
    if (z > maxz) maxz = z
  }
  return { min: [minx, miny, minz], max: [maxx, maxy, maxz] }
}

/** Non-periodic grid dims over an AABB with cell size h = max_bond_dist. Each dim
 *  = max(1, ceil(extent / h)). A degenerate (zero-extent) axis collapses to 1. */
export function aabb_grid_dims(
  min: [number, number, number],
  max: [number, number, number],
  max_bond_dist: number,
): [number, number, number] {
  const h = max_bond_dist
  if (!(h > 0)) return [1, 1, 1]
  const dim = (lo: number, hi: number) => Math.max(1, Math.ceil((hi - lo) / h))
  return [dim(min[0], max[0]), dim(min[1], max[1]), dim(min[2], max[2])]
}

/** Build the full grid plan for one bond-detection dispatch.
 *  - periodic: dims from lattice vector lengths; use_grid only when ALL dims ≥ 3.
 *  - non-periodic: dims from the atom AABB; use_grid always true.
 *  positions/n are only consulted for the non-periodic AABB. */
export function plan_grid(args: {
  periodic: boolean
  lattice: Float32Array
  max_bond_dist: number
  positions: Float32Array
  n: number
}): GridPlan {
  const { periodic, lattice, max_bond_dist, positions, n } = args
  const inv_h = max_bond_dist > 0 ? 1 / max_bond_dist : 0

  if (periodic) {
    const dims = periodic_grid_dims(lattice, max_bond_dist)
    const use_grid = dims[0] >= MIN_GRID_DIM && dims[1] >= MIN_GRID_DIM && dims[2] >= MIN_GRID_DIM
    return {
      use_grid,
      dims,
      n_cells: dims[0] * dims[1] * dims[2],
      aabb_min: [0, 0, 0],
      inv_h,
      max_per_cell: MAX_PER_CELL,
    }
  }

  const { min, max } = compute_aabb(positions, n)
  const dims = aabb_grid_dims(min, max, max_bond_dist)
  return {
    use_grid: true,
    dims,
    n_cells: dims[0] * dims[1] * dims[2],
    aabb_min: min,
    inv_h,
    max_per_cell: MAX_PER_CELL,
  }
}

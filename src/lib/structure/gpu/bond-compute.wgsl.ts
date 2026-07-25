/** WGSL compute for atom_radii bond detection with minimum-image PBC.
 *
 *  TWO shader modules share one Params layout + predicate (design §8.2):
 *
 *  - `BOND_COMPUTE_WGSL` — the large-N GRID shader. Candidate enumeration is a
 *    uniform grid (cell-list), O(N). It contains NO all-pairs loop and no
 *    runtime path switch: routing is decided CPU-side by `plan_bond_dispatch`
 *    (bond-backend-policy.ts). A periodic thin cell (grid dim < 3) routes to
 *    Rust WASM — a large system may never enter an all-pairs × 27-image shader.
 *
 *  - `BOND_COMPUTE_DIRECT_WGSL` — the small-N DIRECT shader: exact O(N²)
 *    all-pairs 27-image search. Dispatched only for tiny systems
 *    (≤ MAX_DIRECT_ATOMS), where the grid would cost more than it saves and
 *    thin periodic cells still need exact treatment.
 *
 *  Shared bindings (the grid module adds 7/8/9):
 *   0: positions   storage<read>       array<f32>  (3N, xyz interleaved)
 *   1: radii       storage<read>       array<f32>  (N)
 *   2: params      uniform             Params
 *   3: out_pairs   storage<read_write> array<u32>  (capacity*3: a, b, jimage_packed)
 *   4: out_count   storage<read_write> atomic<u32>
 *   5: elem_ids    storage<read>       array<u32>  (N, per-atom element id)
 *   6: rules       storage<read>       array<f32>  (rule_count*4: id_a,id_b,min,max)
 *  Bindings 5/6 carry the per-element-pair bond_distance_rules POST-FILTER
 *  (matches src/lib/structure/scene/visibility.ts). After a candidate pair (i,j)
 *  PASSES the atom_radii test, the sorted element-id pair (lo,hi) is looked up
 *  against `rules` (linear scan, P.rule_count entries): if a rule matches, the
 *  bond is emitted only when min ≤ d ≤ max, else it is SKIPPED; if no rule
 *  matches, the bond is emitted (the strategy decides). Rules only REMOVE
 *  detected bonds, never add. P.rule_count == 0 ⇒ no filtering (identical to no
 *  rules). The id stored in `rules` is an integer bit-cast to f32; the shader
 *  reads it back exactly via the small-int round-trip (u32(id_f32)).
 *  jimage_packed uses three biased u8 lanes: (na+128) | ((nb+128)<<8) |
 *  ((nc+128)<<16). GPU detection emits {-1,0,1}, while the shared render format
 *  preserves the full signed Int8 range accepted by BaseBondGraph.
 *  jimage convention matches bond-detect-reference.ts: offset applied to atom b/j,
 *  displacement = (pos_j - pos_i) + jimage·L. Precondition: max_bond_dist < half the
 *  shortest cell dimension (27-image search only).
 *
 *  GRID MODULE — three compute entry points run in order in one submit:
 *    1. clear_grid : zero cell_count over n_cells + reset grid_meta.
 *    2. bin_atoms  : per atom → cell index → atomicAdd into cell_count; record
 *                    the observed occupancy via atomicMax into grid_meta[0]; if
 *                    the slot < cell_stride write the atom into cell_atoms.
 *    3. detect_bonds : per atom i → its cell → loop the 27 neighbor cells → for
 *                      each atom j in that cell run the shared predicate
 *                      (atom_radii + rules_keep) + jimage pack + i<j dedup.
 *  Cell size h = max_bond_dist, so all bonded neighbors are within the 27-cell
 *  shell. Periodic: bin in FRACTIONAL space (cell = floor(frac*n) mod n); a
 *  neighbor offset that wraps past [0,n) contributes a ±1 lattice image on that
 *  axis, folded into the same jimage used for the min-image distance.
 *  Non-periodic: bin over the atom AABB (origin P.aabb_min, scale P.inv_h);
 *  neighbor offsets that leave [0,n) are skipped (no wrap).
 *
 *  LOSSLESS OVERFLOW (design §8.2): a cell that exceeds P.cell_stride drops the
 *  extras BUT grid_meta[0] still records the true max occupancy, and out_count
 *  keeps the true (unclamped) pair count — so the CPU can always detect an
 *  incomplete run (occupancy > stride, or raw count > capacity), grow the
 *  sizing to the next power of two, and RERUN. An incomplete candidate is
 *  never published. cell_stride is a UNIFORM precisely so that growth needs no
 *  shader rebuild. Grid sizing (dims, AABB) is computed on the CPU in
 *  bond-grid.ts and passed through Params. */

/** Params struct + shared bindings 0-6 + the shared min-image/predicate/emit
 *  helpers. Prepended to BOTH shader modules so the predicate can never
 *  diverge between the grid and direct paths. */
const BOND_COMPUTE_COMMON_WGSL = /* wgsl */ `
struct Params {
  n_atoms: u32,
  capacity: u32,
  periodic: u32,
  _pad0: u32,
  tolerance: f32,
  max_bond_dist: f32,
  min_dist: f32,
  rule_count: u32,   // number of element-pair distance rules in the rules buffer
  lattice: mat3x3<f32>, // columns a,b,c (caller uploads transposed)
  // ── Uniform-grid (cell-list) params (computed CPU-side in bond-grid.ts) ──
  grid_dims: vec3<u32>, // cells along each axis (frac axes / AABB axes)
  _routing: u32,        // CPU routing diagnostic (plan_bond_dispatch decides the
                        // path on the CPU; no shader ever branches on this)
  aabb_min: vec3<f32>,  // non-periodic binning origin ([0,0,0] when periodic)
  cell_stride: u32,     // per-cell capacity (cell_atoms stride) — a UNIFORM so
                        // overflow retries can grow it without a shader rebuild
  inv_h: f32,           // 1 / max_bond_dist (non-periodic cell scale)
  _pad2: u32,
  _pad3: u32,
  _pad4: u32,
};

@group(0) @binding(0) var<storage, read> positions: array<f32>;
@group(0) @binding(1) var<storage, read> radii: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read_write> out_pairs: array<u32>;
@group(0) @binding(4) var<storage, read_write> out_count: atomic<u32>;
@group(0) @binding(5) var<storage, read> elem_ids: array<u32>;
@group(0) @binding(6) var<storage, read> rules: array<f32>;

fn pos(i: u32) -> vec3<f32> {
  return vec3<f32>(positions[i*3u], positions[i*3u+1u], positions[i*3u+2u]);
}

// Per-element-pair distance-rule post-filter. Mirrors visibility.ts:
//   sorted key (lo,hi) → if a rule matches, keep only when min ≤ d ≤ max;
//   if NO rule matches the pair, keep (strategy decides). rule_count 0 ⇒ keep.
// Returns true to KEEP the bond, false to SKIP it.
fn rules_keep(ea: u32, eb: u32, d: f32) -> bool {
  if (P.rule_count == 0u) { return true; }
  let lo = min(ea, eb);
  let hi = max(ea, eb);
  for (var r: u32 = 0u; r < P.rule_count; r = r + 1u) {
    let id_a = u32(rules[r*4u + 0u]);
    let id_b = u32(rules[r*4u + 1u]);
    if (id_a == lo && id_b == hi) {
      let rmin = rules[r*4u + 2u];
      let rmax = rules[r*4u + 3u];
      return d >= rmin && d <= rmax;
    }
  }
  return true;
}

fn pack_jimage(na: i32, nb: i32, nc: i32) -> u32 {
  return u32(na + 128) | (u32(nb + 128) << 8u) | (u32(nc + 128) << 16u);
}

// Shared min-image + predicate + emit for a candidate ordered pair (i<j). Runs
// the SAME exact 27-image minimum-image search, atom_radii predicate, rules_keep
// post-filter, and jimage pack on both paths — only the candidate enumeration
// differs. out_count is atomically incremented BEFORE the capacity check, so
// its final value is the true raw pair count even when the buffer overflows —
// the caller detects raw > capacity, grows, and reruns (never clamps).
fn try_emit(i: u32, j: u32, pi: vec3<f32>, ri: f32) {
  let dvec = pos(j) - pi;
  var best_d2 = 1e30;
  var bi: i32 = 0; var bj: i32 = 0; var bk: i32 = 0;
  if (P.periodic == 1u) {
    for (var na: i32 = -1; na <= 1; na = na + 1) {
      for (var nb: i32 = -1; nb <= 1; nb = nb + 1) {
        for (var nc: i32 = -1; nc <= 1; nc = nc + 1) {
          let shift = f32(na)*P.lattice[0] + f32(nb)*P.lattice[1] + f32(nc)*P.lattice[2];
          let e = dvec + shift;
          let d2 = dot(e, e);
          if (d2 < best_d2) { best_d2 = d2; bi = na; bj = nb; bk = nc; }
        }
      }
    }
  } else {
    best_d2 = dot(dvec, dvec);
  }
  let d = sqrt(best_d2);
  if (d < P.min_dist || d > P.max_bond_dist) { return; }
  if (d <= ri + radii[j] + P.tolerance) {
    // Per-element-pair rule post-filter (matches visibility.ts). Applied only
    // AFTER the atom_radii test passes; can only remove a detected bond.
    if (!rules_keep(elem_ids[i], elem_ids[j], d)) { return; }
    let slot = atomicAdd(&out_count, 1u);
    if (slot < P.capacity) {
      out_pairs[slot*3u + 0u] = i;
      out_pairs[slot*3u + 1u] = j;
      out_pairs[slot*3u + 2u] = pack_jimage(bi, bj, bk);
    }
  }
}
`

/** Large-N GRID shader: uniform-grid candidate enumeration ONLY. Contains no
 *  all-pairs loop — thin-cell / over-budget systems are routed away on the CPU
 *  (plan_bond_dispatch) and must never reach this module as a fallback. */
export const BOND_COMPUTE_WGSL: string = BOND_COMPUTE_COMMON_WGSL + /* wgsl */ `
// Grid storage: cell_count is the per-cell atom tally (atomic, sized n_cells);
// cell_atoms holds up to cell_stride atom indices per cell (sized
// n_cells*stride); grid_meta[0] records the MAX OBSERVED per-cell occupancy
// (atomicMax'd by bin_atoms). The CPU compares it against cell_stride after the
// run: occupancy > stride ⇒ atoms were dropped ⇒ the candidate is incomplete
// and must be rerun with a grown stride — never published.
@group(0) @binding(7) var<storage, read_write> cell_count: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> cell_atoms: array<u32>;
@group(0) @binding(9) var<storage, read_write> grid_meta: array<atomic<u32>>;

// Total grid cell count = product of the three dims (>=1 each, CPU-validated).
fn n_cells() -> u32 {
  return P.grid_dims.x * P.grid_dims.y * P.grid_dims.z;
}

// Linear cell index from integer cell coords (already folded into [0,n)).
fn cell_linear(cx: u32, cy: u32, cz: u32) -> u32 {
  return (cz * P.grid_dims.y + cy) * P.grid_dims.x + cx;
}

// Fractional coordinate of atom i: solve lattice * frac = pos. P.lattice columns
// are a,b,c (transposed upload), so its inverse maps Cartesian → fractional. We
// only need frac mod 1 for binning, but the raw value's floor also drives the
// integer cell, so return the raw fractional coord (may be outside [0,1)).
fn frac_coord(p: vec3<f32>) -> vec3<f32> {
  // inverse of the 3x3 lattice (columns a,b,c).
  let m = P.lattice;
  let a = m[0]; let b = m[1]; let c = m[2];
  let det = dot(a, cross(b, c));
  // det is nonzero for any real periodic cell; guard against a degenerate one.
  if (abs(det) < 1e-20) { return vec3<f32>(0.0, 0.0, 0.0); }
  let inv_det = 1.0 / det;
  // Rows of the inverse are the reciprocal-lattice vectors / det.
  let r0 = cross(b, c) * inv_det;
  let r1 = cross(c, a) * inv_det;
  let r2 = cross(a, b) * inv_det;
  return vec3<f32>(dot(r0, p), dot(r1, p), dot(r2, p));
}

// Integer cell coordinate (per axis) for the cell that atom at position p lives in.
fn atom_cell(p: vec3<f32>) -> vec3<u32> {
  if (P.periodic == 1u) {
    let f = frac_coord(p);
    let nx = i32(P.grid_dims.x);
    let ny = i32(P.grid_dims.y);
    let nz = i32(P.grid_dims.z);
    // floor(frac * n) mod n, with a positive modulo (frac can be negative).
    let cx = ((i32(floor(f.x * f32(nx))) % nx) + nx) % nx;
    let cy = ((i32(floor(f.y * f32(ny))) % ny) + ny) % ny;
    let cz = ((i32(floor(f.z * f32(nz))) % nz) + nz) % nz;
    return vec3<u32>(u32(cx), u32(cy), u32(cz));
  }
  // Non-periodic: AABB binning. (pos - aabb_min) / h, clamped into [0, n-1].
  let g = (p - P.aabb_min) * P.inv_h;
  let cx = clamp(i32(floor(g.x)), 0, i32(P.grid_dims.x) - 1);
  let cy = clamp(i32(floor(g.y)), 0, i32(P.grid_dims.y) - 1);
  let cz = clamp(i32(floor(g.z)), 0, i32(P.grid_dims.z) - 1);
  return vec3<u32>(u32(cx), u32(cy), u32(cz));
}

// ── Pass 1: clear the per-cell counts (dispatched over n_cells). ──────────────
@compute @workgroup_size(64)
fn clear_grid(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= n_cells()) { return; }
  atomicStore(&cell_count[c], 0u);
  // Reset the occupancy record once (cheapest to fold into cell 0's clear).
  if (c == 0u) { atomicStore(&grid_meta[0], 0u); }
}

// ── Pass 2: bin each atom into its cell. ──────────────────────────────────────
@compute @workgroup_size(64)
fn bin_atoms(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n_atoms) { return; }
  let cc = atom_cell(pos(i));
  let cell = cell_linear(cc.x, cc.y, cc.z);
  let slot = atomicAdd(&cell_count[cell], 1u);
  // ALWAYS record the observed occupancy — even past the stride — so the CPU
  // can grow to nextPow2(occupancy) in ONE rerun instead of doubling blindly.
  atomicMax(&grid_meta[0], slot + 1u);
  if (slot < P.cell_stride) {
    cell_atoms[cell * P.cell_stride + slot] = i;
  }
}

// ── Pass 3: detect bonds via the 27-neighbor-cell candidate search. ───────────
@compute @workgroup_size(64)
fn detect_bonds(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n_atoms) { return; }
  let pi = pos(i);
  let ri = radii[i];

  // Visit the 27 neighbor cells of atom i's cell. For each atom j in those
  // cells, enforce the i<j dedup (each unordered pair is emitted once), then
  // run the shared min-image predicate (which handles PBC images / jimage
  // exactly, the same as the reference). The grid only narrows WHICH j we test.
  let cc = atom_cell(pi);
  let nx = i32(P.grid_dims.x);
  let ny = i32(P.grid_dims.y);
  let nz = i32(P.grid_dims.z);
  for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      for (var dz: i32 = -1; dz <= 1; dz = dz + 1) {
        var cx = i32(cc.x) + dx;
        var cy = i32(cc.y) + dy;
        var cz = i32(cc.z) + dz;
        if (P.periodic == 1u) {
          // Wrap into [0,n); the ±1 lattice image is recovered by try_emit's full
          // 27-image search, so we don't need to track it explicitly here.
          cx = ((cx % nx) + nx) % nx;
          cy = ((cy % ny) + ny) % ny;
          cz = ((cz % nz) + nz) % nz;
        } else {
          // No wrap: skip neighbor cells outside the AABB grid.
          if (cx < 0 || cx >= nx || cy < 0 || cy >= ny || cz < 0 || cz >= nz) { continue; }
        }
        let cell = cell_linear(u32(cx), u32(cy), u32(cz));
        let count = min(atomicLoad(&cell_count[cell]), P.cell_stride);
        for (var s: u32 = 0u; s < count; s = s + 1u) {
          let j = cell_atoms[cell * P.cell_stride + s];
          // i<j dedup: each unordered pair handled once. (Self i==j excluded.)
          if (j <= i) { continue; }
          try_emit(i, j, pi, ri);
        }
      }
    }
  }
}
`

/** Small-N DIRECT shader: exact O(N²) all-pairs 27-image search. Dispatched
 *  ONLY when plan_bond_dispatch returns kind 'direct' (atom_count ≤
 *  MAX_DIRECT_ATOMS) — a large system is never routed here. Declares only
 *  bindings 0-6; the grid buffers are never touched. */
export const BOND_COMPUTE_DIRECT_WGSL: string = BOND_COMPUTE_COMMON_WGSL +
  /* wgsl */ `
@compute @workgroup_size(64)
fn detect_bonds(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n_atoms) { return; }
  let pi = pos(i);
  let ri = radii[i];
  for (var j: u32 = i + 1u; j < P.n_atoms; j = j + 1u) {
    try_emit(i, j, pi, ri);
  }
}
`

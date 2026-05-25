/** WGSL compute for atom_radii bond detection with minimum-image PBC.
 *  Bindings:
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
 *  jimage_packed: (na+1) | ((nb+1)<<2) | ((nc+1)<<4), each in {0,1,2} for {-1,0,1}.
 *  jimage convention matches bond-detect-reference.ts: offset applied to atom b/j,
 *  displacement = (pos_j - pos_i) + jimage·L. Precondition: max_bond_dist < half the
 *  shortest cell dimension (27-image search only). v1 is O(N) per atom (all j>i);
 *  a uniform-grid candidate list is layered in later without changing this predicate. */
export const BOND_COMPUTE_WGSL = /* wgsl */ `
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
  return u32(na+1) | (u32(nb+1) << 2u) | (u32(nc+1) << 4u);
}

@compute @workgroup_size(64)
fn detect_bonds(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n_atoms) { return; }
  let pi = pos(i);
  let ri = radii[i];
  for (var j: u32 = i + 1u; j < P.n_atoms; j = j + 1u) {
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
    if (d < P.min_dist || d > P.max_bond_dist) { continue; }
    if (d <= ri + radii[j] + P.tolerance) {
      // Per-element-pair rule post-filter (matches visibility.ts). Applied only
      // AFTER the atom_radii test passes; can only remove a detected bond.
      if (!rules_keep(elem_ids[i], elem_ids[j], d)) { continue; }
      let slot = atomicAdd(&out_count, 1u);
      if (slot < P.capacity) {
        out_pairs[slot*3u + 0u] = i;
        out_pairs[slot*3u + 1u] = j;
        out_pairs[slot*3u + 2u] = pack_jimage(bi, bj, bk);
      }
    }
  }
}
`

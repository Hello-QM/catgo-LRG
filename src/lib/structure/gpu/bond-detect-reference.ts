export type RefBondOptions = { tolerance: number; max_bond_dist: number; min_dist: number }
export type RefBond = { a: number; b: number; dist: number; jimage: [number, number, number] }

/** Reference atom_radii bond detector with minimum-image PBC. Matches the Rust
 *  detect_bonds_atom_radii predicate (extensions/rust/src/bonding.rs):
 *  bond between i<j iff minimum-image distance d satisfies
 *    min_dist <= d <= max_bond_dist  AND  d <= r_i + r_j + tolerance.
 *  This is the source-of-truth oracle the WGSL compute shader (Task 5/6) must
 *  match. O(N^2) — oracle/test + small structures only; the GPU path uses a
 *  uniform grid for scale.
 *
 *  jimage CONVENTION (the contract Tasks 5/6/8 inherit): jimage is the integer
 *  image offset (in lattice units) applied to atom b so that b + jimage*L lands
 *  in the minimum-image position relative to a. i.e. the realized displacement
 *  is (pos_b - pos_a) + jimage·L. For two atoms straddling a boundary where the
 *  short contact is "wrap b backward by one cell", jimage is [-1,0,0].
 *
 *  CORRECTNESS PRECONDITION (Tasks 5/6 inherit this): the 27-image search over
 *  the {-1,0,1}^3 shell is not merely a perf shortcut — it is only *correct* when
 *  the bond cutoff (max_bond_dist) is smaller than half the shortest cell
 *  dimension. For larger cutoffs, or highly skewed / very short lattices, the
 *  true minimum image can lie outside the {-1,0,1}^3 shell, so the closest image
 *  is missed and genuine bonds are silently dropped. Callers must keep cutoffs
 *  well inside half the minimum cell dimension. */
export function detect_bonds_reference(
  positions: Float32Array, // 3N
  lattice: Float32Array, // 9, row-major (rows a,b,c); all-zero => non-periodic
  radii: Float32Array, // N
  opts: RefBondOptions,
): RefBond[] {
  const n = radii.length
  const periodic = lattice.some((v) => v !== 0)
  const out: RefBond[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = positions[j * 3] - positions[i * 3]
      const dy = positions[j * 3 + 1] - positions[i * 3 + 1]
      const dz = positions[j * 3 + 2] - positions[i * 3 + 2]
      const mi = periodic
        ? minimum_image(dx, dy, dz, lattice)
        : { d2: dx * dx + dy * dy + dz * dz, jimage: [0, 0, 0] as [number, number, number] }
      const d = Math.sqrt(mi.d2)
      if (d < opts.min_dist || d > opts.max_bond_dist) continue
      if (d <= radii[i] + radii[j] + opts.tolerance) out.push({ a: i, b: j, dist: d, jimage: mi.jimage })
    }
  }
  return out
}

/** Minimum-image displacement searching the 27 nearest images (offsets in
 *  {-1,0,1}); returns the closest with the integer image applied to atom b.
 *  PRECONDITION (correctness, not just perf): valid only when the bond cutoff is
 *  smaller than half the shortest cell dimension. For larger cutoffs or highly
 *  skewed / short lattices the true minimum image can fall outside the
 *  {-1,0,1}^3 shell and the closest image would be missed. */
function minimum_image(
  dx: number,
  dy: number,
  dz: number,
  L: Float32Array,
): { d2: number; jimage: [number, number, number] } {
  let best = { d2: Infinity, jimage: [0, 0, 0] as [number, number, number] }
  for (let na = -1; na <= 1; na++) {
    for (let nb = -1; nb <= 1; nb++) {
      for (let nc = -1; nc <= 1; nc++) {
        const sx = na * L[0] + nb * L[3] + nc * L[6]
        const sy = na * L[1] + nb * L[4] + nc * L[7]
        const sz = na * L[2] + nb * L[5] + nc * L[8]
        const ex = dx + sx,
          ey = dy + sy,
          ez = dz + sz
        const d2 = ex * ex + ey * ey + ez * ez
        if (d2 < best.d2) best = { d2, jimage: [na, nb, nc] }
      }
    }
  }
  return best
}

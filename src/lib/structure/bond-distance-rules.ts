// Per-element-pair bond distance rules as a FULL bonding override.
//
// Unlike the legacy post-filter (which could only remove strategy-detected
// bonds), a rule here fully DEFINES the bonds for its element pair: every
// pair of sites of that element pair whose (PBC-aware) distance falls in
// [min,max] becomes a bond, and any strategy-detected bond of that pair is
// discarded (it is regenerated from the distance test). Pairs WITHOUT a rule
// keep their strategy-detected bonds untouched.
//
// Applied to both the rendered bond graph and the polyhedra bond graph so the
// two stay consistent.

import type { AnyStructure, BondPair, Vec3 } from '$lib/structure'
import { compute_bond_transform } from './bonding'

export type BondDistanceRuleLike = {
  element_1: string
  element_2: string
  min_dist: number
  max_dist: number
}

// p + (j·lattice); lattice rows are the lattice vectors a, b, c.
function shift_by_jimage(
  p: Vec3,
  j: [number, number, number],
  m: [Vec3, Vec3, Vec3] | null,
): Vec3 {
  if (!m || (j[0] === 0 && j[1] === 0 && j[2] === 0)) return p
  return [
    p[0] + j[0] * m[0][0] + j[1] * m[1][0] + j[2] * m[2][0],
    p[1] + j[0] * m[0][1] + j[1] * m[1][1] + j[2] * m[2][1],
    p[2] + j[0] * m[0][2] + j[1] * m[1][2] + j[2] * m[2][2],
  ]
}

function pair_key(a: string, b: string): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

function site_element(structure: AnyStructure, idx: number): string {
  return structure.sites[idx]?.species?.[0]?.element ?? ``
}

// How many cells to scan along each lattice vector to reach `max_dist`.
// Capped at 3 (a rule longer than 3 cells is unphysical for coordination).
function image_range(vec: Vec3, max_dist: number): number {
  const len = Math.hypot(vec[0], vec[1], vec[2])
  if (len <= 0) return 0
  return Math.min(3, Math.ceil(max_dist / len))
}

// Replace the bonds of every ruled element pair with distance-generated bonds,
// keeping all non-ruled bonds. `lattice` null ⇒ no PBC images (molecules).
export function apply_bond_distance_rules(
  structure: AnyStructure,
  lattice: [Vec3, Vec3, Vec3] | null,
  bonds: readonly BondPair[],
  rules: readonly BondDistanceRuleLike[],
  // Optional current-frame Cartesian positions (flat xyz). During trajectory
  // playback the structure's `sites[].xyz` are the loaded frame, not the one
  // on screen — pass the animated positions so ruled bonds track the frame
  // instead of freezing at frame 0. Ignored unless its length matches sites.
  frame_positions?: Float32Array | null,
): BondPair[] {
  if (!rules.length) return [...bonds]
  if (!structure?.sites?.length) return [...bonds]

  const use_frame = !!frame_positions
    && frame_positions.length === structure.sites.length * 3
  const pos_of = (idx: number): Vec3 =>
    use_frame
      ? [frame_positions![idx * 3], frame_positions![idx * 3 + 1], frame_positions![idx * 3 + 2]]
      : (structure.sites[idx].xyz as Vec3)

  const ruled = new Map<string, { min: number; max: number }>()
  for (const r of rules) {
    ruled.set(pair_key(r.element_1, r.element_2), { min: r.min_dist, max: r.max_dist })
  }

  // Keep strategy bonds whose element pair has NO rule.
  const out: BondPair[] = []
  for (const b of bonds) {
    const key = pair_key(
      site_element(structure, b.site_idx_1),
      site_element(structure, b.site_idx_2),
    )
    if (!ruled.has(key)) out.push(b)
  }

  // Generate bonds for ruled pairs within [min,max], PBC-aware.
  const sites = structure.sites
  const max_rule = Math.max(...[...ruled.values()].map((r) => r.max))
  const ra = lattice ? image_range(lattice[0], max_rule) : 0
  const rb = lattice ? image_range(lattice[1], max_rule) : 0
  const rc = lattice ? image_range(lattice[2], max_rule) : 0

  const seen = new Set<string>()
  for (let i = 0; i < sites.length; i++) {
    const ei = site_element(structure, i)
    if (!ei) continue
    const pi = pos_of(i)
    for (let j = i; j < sites.length; j++) {
      const ej = site_element(structure, j)
      const rule = ruled.get(pair_key(ei, ej))
      if (!rule) continue
      const pj = pos_of(j)
      for (let a = -ra; a <= ra; a++) {
        for (let b = -rb; b <= rb; b++) {
          for (let c = -rc; c <= rc; c++) {
            if (i === j && a === 0 && b === 0 && c === 0) continue
            // Self-pair across a boundary: keep one of (+image,-image).
            if (i === j && (a < 0 || (a === 0 && b < 0) || (a === 0 && b === 0 && c < 0))) {
              continue
            }
            const sp = shift_by_jimage(pj, [a, b, c], lattice)
            const dx = sp[0] - pi[0], dy = sp[1] - pi[1], dz = sp[2] - pi[2]
            const dist = Math.hypot(dx, dy, dz)
            if (dist < rule.min || dist > rule.max) continue
            const key = `${i}_${j}_${a}_${b}_${c}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({
              pos_1: pi,
              pos_2: pj,
              site_idx_1: i,
              site_idx_2: j,
              bond_length: dist,
              strength: 1.0,
              // Raw in-cell positions for the transform (matches WASM bonds);
              // the jimage drives cross-cell rendering downstream.
              transform_matrix: compute_bond_transform(pi, pj),
              // `+ 0` normalizes -0 (from `-ra` when ra===0) to +0.
              jimage: [a + 0, b + 0, c + 0],
            })
          }
        }
      }
    }
  }
  return out
}

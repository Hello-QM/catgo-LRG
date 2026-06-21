// Whole-structure bond-order perception — RDKit-free valence heuristic.
//
// A 1:1 TS port of atomcanvas' heuristics.py (ValencePropagator +
// EnhancedAromaticityDetector + SpecialStructureDetector), run per ORGANIC
// CONNECTED COMPONENT. RDKit/xyz2mol is unusable on CatGo systems (metal,
// periodic, no defined total charge), so we run a lightweight valence
// heuristic on each extracted organic component instead. Components range
// from a small adsorbate (CO / formate / benzene) to an extended periodic
// framework (graphene / C3N4 / h-BN / COF) that bonds to its own PBC image —
// ALL are perceived. Metals are excluded by the component extraction, so a
// Pt slab still gets only single sticks (no fake orders).
//
// Bond vectors are minimum-image-corrected via lattice·jimage so the
// carbonyl / length-table distance tests stay correct on a cross-cell
// component. Aromatic rings are detected in (atom, accumulated-image) space so
// every hexagon of a periodic sheet — closing through cross-cell bonds — is
// found, with its plane geometry computed from MIC-UNWRAPPED image positions.
// The best-fit-plane normal reuses get_principal_axes (Jacobi) from
// structure/index.ts — no new linalg dependency.
//
// Output orders snap to {1, 1.5, 2, 3}, keyed by the SAME get_bond_key the
// shadow-sync uses, so the result map is directly indexable by global bond
// identity. Bonds absent from the map render as order 1.
//
// Pure, headless, no wasm, no network.

import type { Matrix3x3, Vec3 } from '$lib/math'
import {
  mat3x3_vec3_multiply,
  matrix_inverse_3x3,
  transpose_3x3_matrix,
} from '$lib/math'
import type { AnyStructure, BondPair, Site } from '$lib/structure'
import { get_principal_axes } from '$lib/structure'
import { get_bond_key } from '$lib/structure/bonding'
import {
  type Fragment,
  isolate_adsorbate_fragments,
} from '$lib/structure/bonding/fragment'

// ---------------------------------------------------------------------------
// Ported tables (heuristics.py:9-44)
// ---------------------------------------------------------------------------

// Valence electrons / typical bonding capacity, sorted by preference.
const VALENCE_TABLE: Record<string, number[]> = {
  H: [1],
  He: [0],
  Li: [1],
  Be: [2],
  B: [3],
  C: [4, 2],
  N: [3, 4, 2],
  O: [2, 1],
  F: [1],
  Ne: [0],
  Na: [1],
  Mg: [2],
  Al: [3],
  Si: [4],
  P: [3, 5],
  S: [2, 4, 6],
  Cl: [1, 3, 5, 7],
  Ar: [0],
  K: [1],
  Ca: [2],
  Ga: [3],
  Ge: [4],
  As: [3, 5],
  Se: [2, 4, 6],
  Br: [1, 3, 5, 7],
  Kr: [0],
  I: [1, 3, 5, 7],
  Xe: [0, 2, 4, 6, 8],
}

// Bond-length table: pair-key -> {order: length(Å)}.
const BOND_LENGTH_TABLE: Record<string, Array<[number, number]>> = {
  'C|C': [[1.0, 1.54], [1.5, 1.40], [2.0, 1.34], [3.0, 1.20]],
  'C|N': [[1.0, 1.47], [1.5, 1.34], [2.0, 1.28], [3.0, 1.16]],
  'C|O': [[1.0, 1.43], [1.5, 1.28], [2.0, 1.22]],
  'N|N': [[1.0, 1.45], [2.0, 1.25], [3.0, 1.10]],
  'N|O': [[1.0, 1.40], [1.5, 1.30], [2.0, 1.20]],
  'O|O': [[1.0, 1.48], [2.0, 1.21]],
  'S|O': [[1.0, 1.58], [2.0, 1.43]],
  'P|O': [[1.0, 1.60], [2.0, 1.50]],
  'S|S': [[1.0, 2.05], [2.0, 1.89]],
}

function length_table_key(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`
}

// Aromatic rings are essentially flat; saturated chair rings pucker well
// beyond this tolerance (Å).
const AROMATIC_PLANARITY_TOL = 0.1

// ---------------------------------------------------------------------------
// Aromatic-ring overlay descriptor
// ---------------------------------------------------------------------------

/**
 * One detected aromatic ring, in world (Cartesian) coordinates, ready for the
 * dashed-circle overlay. `atom_indices` are the ordered GLOBAL site indices
 * forming the cycle; `centroid` / `normal` / `radius` describe the best-fit
 * ring plane (normal is unit length, radius is the mean centroid→atom
 * distance). All positions are MIC-unwrapped so a cross-cell ring is laid out
 * as a single contiguous loop rather than split across the periodic boundary.
 * For PERIODIC structures the `centroid` is then translated by an integer
 * lattice vector back into the unit cell so a boundary-straddling hexagon's
 * torus sits on the in-cell atoms (no floaters); `normal`/`radius` are
 * unchanged. Molecules (no lattice) keep their centroid exactly as is.
 */
export type AromaticRing = {
  atom_indices: number[]
  centroid: [number, number, number]
  normal: [number, number, number]
  radius: number
}

// ---------------------------------------------------------------------------
// catrender parity helpers (bonds.rs:128-180) — exported for the renderer & tests
// ---------------------------------------------------------------------------

/** Python round() — round-half-to-even (banker's rounding). */
export function round_half_even(x: number): number {
  const f = Math.floor(x)
  const diff = x - f
  if (diff < 0.5) return f
  if (diff > 0.5) return f + 1
  // exactly .5 → round to even
  return f % 2 === 0 ? f : f + 1
}

/** nb = max(1, round_half_even(bo)); disabled collapses to a single stick. */
export function nb_from_order(bo: number, bond_orders: boolean): number {
  const b = bond_orders ? bo : 1.0
  const nb = round_half_even(b)
  return Math.max(1, nb)
}

/** Multi-bond offset index sequence range(-nb+1, nb, 2). */
export function ib_seq(nb: number): number[] {
  const v: number[] = []
  for (let i = -nb + 1; i < nb; i += 2) v.push(i)
  return v
}

/** Aromatic window 1.3 < bo < 1.7 (bonds.rs:178). */
export function is_aromatic(bo: number): boolean {
  return 1.3 < bo && bo < 1.7
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2])
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// MIC-corrected vector center→neighbor: r = pos_n + lattice·jimage - pos_c
// (same convention as bond-instanced-renderer.ts #write_slot / atom-graph.ts).
function mic_vector(
  pos_c: Vec3,
  pos_n: Vec3,
  jimage: [number, number, number],
  lattice: Matrix3x3 | null,
): Vec3 {
  let nx = pos_n[0]
  let ny = pos_n[1]
  let nz = pos_n[2]
  if (lattice && (jimage[0] || jimage[1] || jimage[2])) {
    // rows of the lattice matrix are the lattice vectors a, b, c
    for (let k = 0; k < 3; k++) {
      nx += jimage[k] * lattice[k][0]
      ny += jimage[k] * lattice[k][1]
      nz += jimage[k] * lattice[k][2]
    }
  }
  return [nx - pos_c[0], ny - pos_c[1], nz - pos_c[2]]
}

// ---------------------------------------------------------------------------
// Compact per-fragment graph
// ---------------------------------------------------------------------------

type LocalGraph = {
  n: number
  symbols: string[]
  positions: Vec3[]
  // adjacency: for each local atom, list of {nb_local, jimage(center→nb), edge_idx}
  adj: Array<Array<{ nb: number; jimage: [number, number, number]; edge: number }>>
  // edges in declaration order: [a_local, b_local, jimage(a→b)]
  edges: Array<{ a: number; b: number; jimage: [number, number, number] }>
}

function build_local_graph(
  fragment: Fragment,
  sites: Site[],
  lattice: Matrix3x3 | null,
): LocalGraph {
  const n = fragment.site_indices.length
  const symbols: string[] = new Array(n)
  const positions: Vec3[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const g = fragment.site_indices[i]
    const site = sites[g]
    const species = site?.species ?? []
    let best = species[0]
    for (const s of species) if (s && s.occu > (best?.occu ?? -1)) best = s
    symbols[i] = best?.element ?? `X`
    positions[i] = (site?.xyz ?? [0, 0, 0]) as Vec3
  }
  const adj: LocalGraph['adj'] = Array.from({ length: n }, () => [])
  const edges: LocalGraph['edges'] = []
  fragment.local_bonds.forEach((e, idx) => {
    const a = e.a_local
    const b = e.b_local
    const j = e.jimage
    edges.push({ a, b, jimage: j })
    adj[a].push({ nb: b, jimage: j, edge: idx })
    // reverse edge: center b → a uses the negated translation
    adj[b].push({
      nb: a,
      jimage: [-j[0], -j[1], -j[2]] as [number, number, number],
      edge: idx,
    })
  })
  void lattice
  return { n, symbols, positions, adj, edges }
}

// Canonical local bond key (min,max) for the bond_orders map.
function lkey(u: number, v: number): string {
  return u < v ? `${u}-${v}` : `${v}-${u}`
}

// ---------------------------------------------------------------------------
// Aromaticity / special-structure / planarity detectors (ported)
// ---------------------------------------------------------------------------

function is_sp2_atom(g: LocalGraph, idx: number, lattice: Matrix3x3 | null): boolean {
  const sym = g.symbols[idx]
  if (sym !== `C` && sym !== `N` && sym !== `B`) return false
  const neighbors = g.adj[idx]
  if (!(neighbors.length >= 1 && neighbors.length <= 4)) return false

  let network_nb = 0
  for (const { nb } of neighbors) {
    const s = g.symbols[nb]
    if (s === `C` || s === `N` || s === `B`) network_nb++
  }
  if (network_nb < 1) return false

  const p_c = g.positions[idx]
  const vectors: Vec3[] = []
  for (const { nb, jimage } of neighbors) {
    const vec = mic_vector(p_c, g.positions[nb], jimage, lattice)
    const nrm = norm(vec)
    if (nrm < 1e-4) return false
    vectors.push([vec[0] / nrm, vec[1] / nrm, vec[2] / nrm])
  }
  if (vectors.length > 3) return false
  if (vectors.length < 3) return vectors.length >= 1

  // 3-coordinate: planarity via sum of the three pairwise angles > 350°.
  let angle_sum = 0
  for (let i = 0; i < 3; i++) {
    const v1 = vectors[i]
    const v2 = vectors[(i + 1) % 3]
    const d = Math.max(-1, Math.min(1, dot(v1, v2)))
    angle_sum += (Math.acos(d) * 180) / Math.PI
  }
  return angle_sum > 350.0
}

// One ordered ring as a cyclic walk in (atom, accumulated-image) space. Each
// member carries the lattice translation (jimage) of that atom RELATIVE to
// member[0], so a ring is well defined even when it closes through a PBC image
// (graphene/C3N4 hexagons) — including the degenerate case where the same
// atom index appears twice at different images (a hexagon in a tiny periodic
// cell). `atoms[i]` is a local atom index; `images[i]` is its [da,db,dc].
type Ring = {
  atoms: number[]
  images: Array<[number, number, number]>
}

const j_add = (
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

// Cartesian position of a ring member: raw xyz + lattice·image.
function ring_member_pos(
  g: LocalGraph,
  atom: number,
  image: [number, number, number],
  lattice: Matrix3x3 | null,
): Vec3 {
  const p = g.positions[atom]
  if (!lattice || (!image[0] && !image[1] && !image[2])) {
    return [p[0], p[1], p[2]]
  }
  let x = p[0]
  let y = p[1]
  let z = p[2]
  for (let k = 0; k < 3; k++) {
    x += image[k] * lattice[k][0]
    y += image[k] * lattice[k][1]
    z += image[k] * lattice[k][2]
  }
  return [x, y, z]
}

// Max out-of-plane deviation (Å) of ring atoms from their best-fit plane.
// Plane normal = smallest-eigenvalue eigenvector of the covariance matrix,
// obtained from get_principal_axes (sorted descending → last row is normal).
// Uses MIC-UNWRAPPED member positions so a cross-cell ring is laid flat.
function ring_max_plane_deviation(
  g: LocalGraph,
  ring: Ring,
  lattice: Matrix3x3 | null,
): number {
  const pts = ring.atoms.map((a, i) => ring_member_pos(g, a, ring.images[i], lattice))
  const c: Vec3 = [0, 0, 0]
  for (const p of pts) {
    c[0] += p[0]
    c[1] += p[1]
    c[2] += p[2]
  }
  c[0] /= pts.length
  c[1] /= pts.length
  c[2] /= pts.length
  const centered = pts.map((p) => sub(p, c))
  // covariance (3x3)
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const v of centered) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) cov[a][b] += v[a] * v[b]
    }
  }
  const axes = get_principal_axes(cov)
  const normal = axes[axes.length - 1] as unknown as Vec3 // smallest-eigenvalue dir
  let max_dev = 0
  for (const v of centered) max_dev = Math.max(max_dev, Math.abs(dot(v, normal)))
  return max_dev
}

function is_planar_ring(g: LocalGraph, ring: Ring, lattice: Matrix3x3 | null): boolean {
  if (ring.atoms.length < 3) return false
  return ring_max_plane_deviation(g, ring, lattice) <= AROMATIC_PLANARITY_TOL
}

// MIC-unwrapped Cartesian positions for an ordered ring. Each member's
// accumulated image is already known, so a cross-cell ring is laid out as one
// contiguous loop instead of jumping across the periodic boundary.
function unwrap_ring_positions(
  g: LocalGraph,
  ring: Ring,
  lattice: Matrix3x3 | null,
): Vec3[] | null {
  const n = ring.atoms.length
  if (n < 3) return null
  return ring.atoms.map((a, i) => ring_member_pos(g, a, ring.images[i], lattice))
}

// Wrap a Cartesian point back into the unit cell along every periodic axis.
// A periodic aromatic hexagon is laid out from MIC-UNWRAPPED image positions,
// so a hexagon straddling the cell boundary gets a centroid OUTSIDE the drawn
// cell — the torus would float in empty space while the in-cell copy (same
// hexagon via PBC) has the bonds but no ring. Translating the centroid by an
// integer lattice vector is geometrically exact (the hexagon is periodic), so
// the normal / radius are untouched and planarity is preserved. We go through
// fractional space using the SAME lattice convention as the MIC code (rows of
// `lattice` are the lattice vectors a, b, c → cart = Σ_i f_i · lattice[i],
// i.e. cart = transpose(lattice)·frac), wrap each fractional component into
// [0, 1) (f -= floor(f)), then map back. Non-periodic structures (lattice ===
// null) are returned unchanged — molecules like benzene must not move.
function wrap_centroid_into_cell(c: Vec3, lattice: Matrix3x3 | null): Vec3 {
  if (!lattice) return c
  // cart = transpose(lattice)·frac  ⇒  frac = inv(transpose(lattice))·cart
  const lat_t = transpose_3x3_matrix(lattice)
  const frac = mat3x3_vec3_multiply(matrix_inverse_3x3(lat_t), c)
  const wrapped: Vec3 = [
    frac[0] - Math.floor(frac[0]),
    frac[1] - Math.floor(frac[1]),
    frac[2] - Math.floor(frac[2]),
  ]
  return mat3x3_vec3_multiply(lat_t, wrapped)
}

// Compute the best-fit-plane geometry of a set of (already MIC-unwrapped) ring
// points: centroid, unit normal (smallest-eigenvalue eigenvector of the
// covariance), and mean centroid→atom radius. Reuses get_principal_axes — no
// new linalg dependency. For PERIODIC structures the centroid is wrapped back
// into the unit cell (by an integer lattice vector — orientation/size are
// unchanged) so a boundary-straddling hexagon's ring lands on the in-cell
// atoms instead of floating outside the drawn cell.
function ring_plane_geometry(
  pts: Vec3[],
  lattice: Matrix3x3 | null,
): { centroid: Vec3; normal: Vec3; radius: number } {
  const c: Vec3 = [0, 0, 0]
  for (const p of pts) {
    c[0] += p[0]
    c[1] += p[1]
    c[2] += p[2]
  }
  c[0] /= pts.length
  c[1] /= pts.length
  c[2] /= pts.length

  const centered = pts.map((p) => sub(p, c))
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const v of centered) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) cov[a][b] += v[a] * v[b]
    }
  }
  const axes = get_principal_axes(cov)
  const nax = axes[axes.length - 1] as unknown as Vec3 // smallest-eigenvalue dir
  const nl = norm(nax) || 1
  const normal: Vec3 = [nax[0] / nl, nax[1] / nl, nax[2] / nl]

  let radius = 0
  for (const v of centered) radius += norm(v)
  radius /= pts.length

  // Only the centroid is translated into the cell; the normal (translation-
  // invariant) and the radius (computed from the unwrapped centered points)
  // are untouched, so the ring keeps its exact plane, orientation and size.
  return { centroid: wrap_centroid_into_cell(c, lattice), normal, radius }
}

// Canonical dedup key for a ring, INVARIANT under lattice translation and
// walk-direction/start rotation. Two hexagons that are the same hexagon modulo
// a PBC translation (a graphene sheet draws the "same" hexagon at every image)
// collapse to ONE key → one torus per distinct hexagon. We re-reference all
// member images to the LEXICOGRAPHICALLY SMALLEST (atom, image) member, sort
// the resulting (atom, Δimage) tuples, and join. The smallest-member anchor is
// canonical regardless of which atom the DFS happened to start from.
function ring_key(ring: Ring): string {
  const members = ring.atoms.map((a, i) => ({ atom: a, img: ring.images[i] }))
  // pick the lexicographically smallest (atom, image) member as the anchor
  let anchor = members[0]
  for (const m of members) {
    if (
      m.atom < anchor.atom ||
      (m.atom === anchor.atom &&
        (m.img[0] < anchor.img[0] ||
          (m.img[0] === anchor.img[0] &&
            (m.img[1] < anchor.img[1] ||
              (m.img[1] === anchor.img[1] && m.img[2] < anchor.img[2])))))
    ) {
      anchor = m
    }
  }
  const rel = members
    .map((m) =>
      [
        m.atom,
        m.img[0] - anchor.img[0],
        m.img[1] - anchor.img[1],
        m.img[2] - anchor.img[2],
      ] as [number, number, number, number]
    )
    .sort((p, q) =>
      p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]
    )
  return rel.map((r) => r.join(`,`)).join(`|`)
}

// Detect small rings (size <= max_size) without a graph lib — DFS cycle search
// in (atom, accumulated-image) space so rings that close through a PBC image
// (graphene / C3N4 hexagons in a small periodic cell) are found, even when the
// same atom index recurs at a different image. A ring closes when the walk
// returns to the START atom at the ZERO accumulated image (a true polygon, not
// a strand that merely lands on the same atom in a neighbouring cell).
// Deduped by ring_key so each distinct hexagon (modulo lattice translation)
// appears once.
function detect_small_rings(g: LocalGraph, max_size = 6): Ring[] {
  const found = new Map<string, Ring>()
  const ZERO: [number, number, number] = [0, 0, 0]

  function dfs(
    start: number,
    current: number,
    cur_img: [number, number, number],
    atoms: number[],
    images: Array<[number, number, number]>,
    depth: number,
  ) {
    if (depth > max_size) return
    for (const e of g.adj[current]) {
      const next = e.nb
      const next_img = j_add(cur_img, e.jimage)
      const at_zero = next_img[0] === 0 && next_img[1] === 0 && next_img[2] === 0
      // a ring closes ONLY when we return to the start atom at its ORIGINAL
      // (zero) image, after ≥3 members → a real polygon.
      if (next === start && at_zero) {
        if (atoms.length >= 3) {
          const ring: Ring = { atoms: [...atoms], images: [...images] }
          found.set(ring_key(ring), ring)
        }
        continue
      }
      // The start atom at a NON-zero image is a DISTINCT node in (atom, image)
      // space — a graphene/C3N4 hexagon in a small periodic cell passes THROUGH
      // the start atom at other images — so we must be able to walk through it.
      // skip only if this exact (atom, image) node is already on the path.
      let seen = false
      for (let k = 0; k < atoms.length; k++) {
        if (
          atoms[k] === next && images[k][0] === next_img[0] &&
          images[k][1] === next_img[1] && images[k][2] === next_img[2]
        ) {
          seen = true
          break
        }
      }
      if (seen) continue
      // only walk to atoms >= start to bound each cycle & avoid re-discovery
      if (next < start) continue
      dfs(start, next, next_img, [...atoms, next], [...images, next_img], depth + 1)
    }
  }

  for (let s = 0; s < g.n; s++) dfs(s, s, ZERO, [s], [ZERO], 1)
  return [...found.values()].filter((r) => r.atoms.length <= max_size)
}

// sp2-network bonds (graphene/h-BN) → 1.5; benzene fallback for planar pure-C
// 6-rings. Returns a set of local bond keys.
function detect_sp2_network(g: LocalGraph, lattice: Matrix3x3 | null): Set<string> {
  const sp2_temp = new Set<number>()
  for (let i = 0; i < g.n; i++) if (is_sp2_atom(g, i, lattice)) sp2_temp.add(i)

  const sp2_atoms = new Set<number>()
  for (const i of sp2_temp) {
    const sp2_neighbors = g.adj[i].filter((e) => sp2_temp.has(e.nb))
    if (sp2_neighbors.length >= 2) sp2_atoms.add(i)
  }

  if (sp2_atoms.size === 0) {
    const rings = detect_small_rings(g, 6)
    for (const ring of rings) {
      if (
        ring.atoms.length === 6 && ring.atoms.every((i) => g.symbols[i] === `C`)
      ) {
        if (is_planar_ring(g, ring, lattice)) {
          for (const i of ring.atoms) sp2_atoms.add(i)
        }
      }
    }
  }

  const network_bonds = new Set<string>()
  for (const e of g.edges) {
    if (sp2_atoms.has(e.a) && sp2_atoms.has(e.b)) network_bonds.add(lkey(e.a, e.b))
  }
  return network_bonds
}

// Detect borane B-H-B 3c-2e bridges → 0.5. Returns [B1,H,B2] local triples.
function detect_borane_bridges(
  g: LocalGraph,
  lattice: Matrix3x3 | null,
): Array<[number, number, number]> {
  const bridges: Array<[number, number, number]> = []
  for (let i = 0; i < g.n; i++) {
    if (g.symbols[i] !== `H`) continue
    const b_neighbors = g.adj[i].filter((e) => g.symbols[e.nb] === `B`)
    if (b_neighbors.length !== 2) continue
    const [n1, n2] = b_neighbors
    const v1 = mic_vector(g.positions[i], g.positions[n1.nb], n1.jimage, lattice)
    const v2 = mic_vector(g.positions[i], g.positions[n2.nb], n2.jimage, lattice)
    const d = dot(v1, v2) / (norm(v1) * norm(v2))
    const angle = (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
    if (angle > 70 && angle < 110) bridges.push([n1.nb, i, n2.nb])
  }
  return bridges
}

// Detect terminal carbonyl C=O (coord-1 O bonded to C, 1.15<d<1.35) → 2.0.
function detect_carbonyls(
  g: LocalGraph,
  lattice: Matrix3x3 | null,
): Array<[number, number]> {
  const carbonyls: Array<[number, number]> = []
  for (let i = 0; i < g.n; i++) {
    if (g.symbols[i] !== `O` || g.adj[i].length !== 1) continue
    const { nb, jimage } = g.adj[i][0]
    if (g.symbols[nb] !== `C`) continue
    const d = norm(mic_vector(g.positions[i], g.positions[nb], jimage, lattice))
    if (d > 1.15 && d < 1.35) carbonyls.push([nb, i]) // (C, O)
  }
  return carbonyls
}

// ---------------------------------------------------------------------------
// Valence propagator (heuristics.py:248-409)
// ---------------------------------------------------------------------------

function guess_order_by_length(
  g: LocalGraph,
  u: number,
  v: number,
  length: number,
): number {
  const key = length_table_key(g.symbols[u], g.symbols[v])
  const candidates = BOND_LENGTH_TABLE[key]
  if (!candidates) return 1.0
  let best_order = 1.0
  let min_diff = Infinity
  for (const [order, ref_len] of candidates) {
    const diff = Math.abs(length - ref_len)
    if (diff < min_diff) {
      min_diff = diff
      best_order = order
    }
  }
  return best_order
}

/** A detected aromatic ring in a fragment's LOCAL index space + geometry. */
type LocalAromaticRing = {
  local_indices: number[]
  centroid: Vec3
  normal: Vec3
  radius: number
}

/**
 * Perceive bond orders for one fragment.
 * @returns Map<localBondKey, order> where order ∈ {1, 1.5, 2, 3}.
 */
export function perceive_fragment_orders(
  fragment: Fragment,
  sites: Site[],
  lattice: Matrix3x3 | null,
): Map<string, number> {
  return perceive_fragment(fragment, sites, lattice).orders
}

/**
 * Internal: perceive both per-bond orders AND aromatic rings for one fragment.
 * The public `perceive_fragment_orders` keeps its Map-only signature by
 * projecting `.orders`.
 */
function perceive_fragment(
  fragment: Fragment,
  sites: Site[],
  lattice: Matrix3x3 | null,
): { orders: Map<string, number>; rings: LocalAromaticRing[] } {
  const g = build_local_graph(fragment, sites, lattice)
  const bond_orders = new Map<string, number>()
  const valence_used = new Array<number>(g.n).fill(0)

  // valence targets w/ hypervalency bump
  const valence_target = new Array<number>(g.n).fill(0)
  const coordination = g.adj.map((a) => a.length)
  for (let i = 0; i < g.n; i++) {
    const pref = VALENCE_TABLE[g.symbols[i]] ?? [0]
    let target = pref[0]
    if (pref.length > 1 && coordination[i] > pref[0]) {
      for (const vv of pref) {
        if (vv >= coordination[i]) {
          target = vv
          break
        }
      }
    }
    valence_target[i] = target
  }

  const setBond = (u: number, v: number, order: number) => {
    bond_orders.set(lkey(u, v), order)
  }

  // 0. seed special detectors
  for (const k of detect_sp2_network(g, lattice)) {
    bond_orders.set(k, 1.5)
    const [a, b] = k.split(`-`).map(Number)
    valence_used[a] += 1.5
    valence_used[b] += 1.5
  }
  for (const [b1, h, b2] of detect_borane_bridges(g, lattice)) {
    if (!bond_orders.has(lkey(b1, h))) {
      setBond(b1, h, 0.5)
      valence_used[b1] += 0.5
      valence_used[h] += 0.5
    }
    if (!bond_orders.has(lkey(h, b2))) {
      setBond(h, b2, 0.5)
      valence_used[b2] += 0.5
      valence_used[h] += 0.5
    }
  }
  // Terminal multiple-bond diatomics that valence alone under-counts: a
  // coordination-1 C triple-bonded to a coordination-1 O or N (free CO / CN
  // adsorbate end), or N≡N, at a short distance → order 3. This is the case
  // that carries the binding atom's dangling valence to the free end. Runs
  // BEFORE the carbonyl pass so a short free C≡O end is not mis-seeded as a
  // C=O carbonyl double.
  for (const e of g.edges) {
    if (bond_orders.has(lkey(e.a, e.b))) continue
    const sa = g.symbols[e.a]
    const sb = g.symbols[e.b]
    if (coordination[e.a] !== 1 || coordination[e.b] !== 1) continue
    const pair = new Set([sa, sb])
    const d = norm(mic_vector(g.positions[e.a], g.positions[e.b], e.jimage, lattice))
    const triple = (pair.has(`C`) && pair.has(`O`) && d < 1.20) ||
      (pair.has(`C`) && pair.has(`N`) && d < 1.22) ||
      (sa === `N` && sb === `N` && d < 1.18)
    if (triple) {
      bond_orders.set(lkey(e.a, e.b), 3.0)
      valence_used[e.a] += 3.0
      valence_used[e.b] += 3.0
    }
  }

  // Carbonyls / carboxylates. A carbon carrying TWO terminal carbonyl-range
  // oxygens is a carboxylate / carboxylate-like group: by resonance BOTH C-O
  // bonds are equivalent (~1.5), not one C=O + one C-O. A lone terminal
  // carbonyl O → a full C=O double (2.0).
  const carbonyls = detect_carbonyls(g, lattice)
  const carbonyl_by_c = new Map<number, number[]>()
  for (const [c, o] of carbonyls) {
    if (bond_orders.has(lkey(c, o))) continue // already a free C≡O end
    if (!carbonyl_by_c.has(c)) carbonyl_by_c.set(c, [])
    carbonyl_by_c.get(c)!.push(o)
  }
  for (const [c, oxygens] of carbonyl_by_c) {
    // Carboxylate resonance (1.5/1.5) applies ONLY to a true carboxylate
    // (formate / COOH): the carbon carries ≥2 carbonyl-range O AND at least
    // one OTHER neighbour (H or a different substituent). A bare CO2 carbon
    // (exactly its two terminal O, nothing else → coordination == #oxygens)
    // must instead fall through to two independent C=O doubles (2.0/2.0).
    const resonant = oxygens.length >= 2 && coordination[c] > oxygens.length
    for (const o of oxygens) {
      const key = lkey(c, o)
      if (bond_orders.has(key)) continue
      const order = resonant ? 1.5 : 2.0
      bond_orders.set(key, order)
      valence_used[c] += order
      valence_used[o] += order
    }
  }

  // 1. terminal (coordination-1) seed queue
  const queue: number[] = []
  for (let i = 0; i < g.n; i++) if (coordination[i] === 1) queue.push(i)

  // 2. BFS propagation
  while (queue.length) {
    const current = queue.shift()!
    const unassigned: number[] = []
    for (const { nb } of g.adj[current]) {
      if (!bond_orders.has(lkey(current, nb))) unassigned.push(nb)
    }
    if (unassigned.length !== 1) continue

    const nb = unassigned[0]
    const remaining = valence_target[current] - valence_used[current]
    // Cap by the neighbor's own remaining capacity so a high-valence terminal
    // (O target 2) can't force a multiple bond onto a saturated partner
    // (H max 1 → O-H stays single). max_valence = top valence preference.
    const nb_pref = VALENCE_TABLE[g.symbols[nb]] ?? [1]
    const nb_capacity = Math.max(1, (nb_pref[0] ?? 1) - valence_used[nb])
    const order = Math.max(1.0, Math.min(3.0, Math.min(remaining, nb_capacity)))
    setBond(current, nb, order)
    valence_used[current] += order
    valence_used[nb] += order
    queue.push(nb)
  }

  // 3. post-process: remaining unassigned via length table
  for (const e of g.edges) {
    const key = lkey(e.a, e.b)
    if (bond_orders.has(key)) continue
    const length = norm(mic_vector(g.positions[e.a], g.positions[e.b], e.jimage, lattice))
    bond_orders.set(key, guess_order_by_length(g, e.a, e.b, length))
  }

  // snap orders to {1, 1.5, 2, 3}
  for (const [k, v] of bond_orders) bond_orders.set(k, snap_order(v))

  const rings = detect_aromatic_rings(g, bond_orders, lattice)
  return { orders: bond_orders, rings }
}

// Detect aromatic rings for the dashed-circle overlay: a small cycle (3..6
// atoms) is aromatic iff EVERY consecutive ring bond carries a 1.5 order in
// the snapped order map AND the ring is planar. Returns each ring with its
// MIC-unwrapped plane geometry (centroid / unit normal / mean radius), in
// LOCAL index space. Non-ring 1.5 bonds (e.g. an open carboxylate resonance
// pair) are deliberately ignored here — only true rings get a circle.
function detect_aromatic_rings(
  g: LocalGraph,
  bond_orders: Map<string, number>,
  lattice: Matrix3x3 | null,
): LocalAromaticRing[] {
  const out: LocalAromaticRing[] = []
  const rings = detect_small_rings(g, 6)
  for (const ring of rings) {
    if (ring.atoms.length < 3) continue
    // every consecutive ring bond must be aromatic (1.5). The order map is
    // keyed by the local atom pair (jimage-agnostic), which is correct: a
    // graphene C-C bond and its cross-cell image share one order entry.
    let all_aromatic = true
    for (let i = 0; i < ring.atoms.length; i++) {
      const u = ring.atoms[i]
      const v = ring.atoms[(i + 1) % ring.atoms.length]
      if (bond_orders.get(lkey(u, v)) !== 1.5) {
        all_aromatic = false
        break
      }
    }
    if (!all_aromatic) continue
    if (!is_planar_ring(g, ring, lattice)) continue
    const pts = unwrap_ring_positions(g, ring, lattice)
    if (pts === null) continue
    const { centroid, normal, radius } = ring_plane_geometry(pts, lattice)
    out.push({ local_indices: [...ring.atoms], centroid, normal, radius })
  }
  return out
}

function snap_order(o: number): number {
  if (is_aromatic(o)) return 1.5
  if (o <= 1.25) return 1
  if (o < 1.75) return 1.5
  if (o < 2.5) return 2
  return 3
}

// ---------------------------------------------------------------------------
// Public entry — keyed by the shadow-sync's global get_bond_key
// ---------------------------------------------------------------------------

function lattice_of(structure: AnyStructure): Matrix3x3 | null {
  const lat = (structure as { lattice?: { matrix?: Matrix3x3 } }).lattice
  return lat?.matrix ?? null
}

/**
 * Combined perception result for a structure:
 *  - `orders`: per-bond order map keyed by get_bond_key(a, b, jimage). Bonds
 *    absent from the map = order 1 (slab sticks, binding bonds, single bonds).
 *  - `aromatic_rings`: one descriptor per detected aromatic ring (global atom
 *    indices + world-space plane geometry) for the dashed-circle overlay.
 */
export type AdsorbatePerception = {
  orders: Map<string, number>
  aromatic_rings: AromaticRing[]
}

/**
 * Perceive double/triple/aromatic orders AND aromatic rings across the WHOLE
 * structure — every organic connected component (small adsorbate, large or
 * periodic-spanning framework alike). Metals are excluded by the component
 * extraction, so a metal slab keeps single sticks. The order map is keyed by
 * the SAME get_bond_key(a, b, jimage) the shadow-sync uses. Aromatic rings —
 * including every hexagon of a periodic sheet, deduped to one per distinct
 * hexagon — carry the GLOBAL site indices + a MIC-unwrapped best-fit plane
 * (centroid/normal/radius) for the inner solid-torus ring.
 */
export function perceive_adsorbate(
  filtered_bond_pairs: BondPair[],
  structure: AnyStructure,
): AdsorbatePerception {
  const orders = new Map<string, number>()
  const aromatic_rings: AromaticRing[] = []
  if (!structure || !Array.isArray(filtered_bond_pairs)) {
    return { orders, aromatic_rings }
  }
  const sites = structure.sites ?? []
  const lattice = lattice_of(structure)

  const fragments = isolate_adsorbate_fragments(filtered_bond_pairs, sites, lattice)
  for (const fragment of fragments) {
    const { orders: local_orders, rings } = perceive_fragment(fragment, sites, lattice)
    for (const e of fragment.local_bonds) {
      const order = local_orders.get(lkey(e.a_local, e.b_local))
      if (order === undefined || order === 1) continue // order-1 stays implicit
      orders.set(get_bond_key(e.a_global, e.b_global, e.jimage), order)
    }
    // map each ring's local indices back to global site indices
    for (const ring of rings) {
      aromatic_rings.push({
        atom_indices: ring.local_indices.map((li) => fragment.site_indices[li]),
        centroid: [ring.centroid[0], ring.centroid[1], ring.centroid[2]],
        normal: [ring.normal[0], ring.normal[1], ring.normal[2]],
        radius: ring.radius,
      })
    }
  }
  return { orders, aromatic_rings }
}

/**
 * Backward-compatible thin wrapper: perceive only the per-bond order map.
 * Prefer `perceive_adsorbate` when the aromatic-ring overlay is also needed.
 */
export function perceive_adsorbate_orders(
  filtered_bond_pairs: BondPair[],
  structure: AnyStructure,
): Map<string, number> {
  return perceive_adsorbate(filtered_bond_pairs, structure).orders
}

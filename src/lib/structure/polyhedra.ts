// Coordination polyhedra computation for structure visualization.
//
// Bond-graph algorithm: vertices are bonded anion neighbours from the rendered
// bond graph (positions already PBC-correct via bond.pos_1/pos_2), classified
// per-vertex by is_anion_vertex. Crystal Toolkit electronegativity filter:
// polyhedra are drawn only around the LEAST electronegative site in each
// coordination cluster (i.e. metals/cations), preventing overlapping polyhedra
// in ionic/covalent structures.

import type { AnyStructure, BondPair, Vec3 } from '$lib'
import { element_data } from '$lib/element'
import { get_bond_key } from './bonding'
import qh from 'quickhull3d'

// --- Types ---

export interface PolyhedronData {
  center_idx: number
  center_element: string
  neighbor_indices: number[]     // site indices (may be -1 for periodic images), parallel to vertices
  vertices: number[][]           // [x, y, z][] — Cartesian positions of neighbors
}

export interface MergedPolyhedraGeometry {
  face_positions: Float32Array
  /** Per-vertex smooth normal (radial from the polyhedron centroid) — gives the
   *  faces a soft glassy gradient instead of hard flat facets. */
  face_normals: Float32Array
  face_colors: Float32Array
  face_polyhedron_ids: Float32Array
  face_count: number
  edge_positions: Float32Array
  edge_count: number
}

// --- Metal element detection ---

const METAL_ELEMENTS: Set<string> = new Set(
  element_data
    .filter((el) => el.metal === true)
    .map((el) => el.symbol as string),
)

export function is_metal(element: string): boolean {
  return METAL_ELEMENTS.has(element)
}

// --- Helper: get majority element ---

function get_site_element(structure: AnyStructure, site_idx: number): string {
  const site = structure.sites[site_idx]
  if (!site?.species?.length) return ``
  return site.species.reduce(
    (max, s) => (s.occu > max.occu ? s : max),
    site.species[0],
  ).element
}

// --- Electronegativity lookup ---

function get_electronegativity(element: string): number {
  const el = element_data.find((e) => e.symbol === element)
  return el?.electronegativity ?? 2.0  // default for unknowns
}

// --- Element-data helpers for VESTA-style center/vertex filtering (ported from matterviz) ---

const element_lookup = new Map(element_data.map((el) => [el.symbol as string, el]))

// Large low-valent A-site cations whose coordination polyhedra (CN 8-12) tend to
// obscure the structural framework. VESTA-style figures draw the framework
// (e.g. TiO6 in BaTiO3) and leave these as plain spheres. They still get polyhedra
// when they are the only qualifying cations (e.g. NaCl) or when force-included.
const SPECTATOR_CATEGORIES = new Set([`alkali metal`])
const HEAVY_ALKALINE_EARTHS = new Set([`Ca`, `Sr`, `Ba`, `Ra`])

export function is_spectator_center(element: string): boolean {
  return SPECTATOR_CATEGORIES.has(element_lookup.get(element)?.category ?? ``) ||
    HEAVY_ALKALINE_EARTHS.has(element)
}

function get_covalent_radius(element: string): number | null {
  return element_lookup.get(element)?.covalent_radius ?? null
}

// A neighbor counts as a polyhedron vertex only if it is an anion-former: a
// nonmetal/metalloid more electronegative than the center. Keeps spurious
// cation-cation bonds from contaminating coordination shells. Auto-detect only.
function is_anion_vertex(
  center_en: number,
  center_is_metal: boolean,
  neighbor_element: string,
  margin: number,
): boolean {
  if (!neighbor_element) return false
  const n_data = element_lookup.get(neighbor_element)
  if (n_data?.metal) return false
  const n_en = n_data?.electronegativity ?? null
  if (n_en !== null) return n_en > center_en + margin
  // EN data missing: only metal centers with nonmetal neighbors qualify
  return center_is_metal && n_data?.nonmetal === true
}

// --- Bond graph adjacency helper ---

// Apply lattice·jimage offset to a Cartesian position.
// m = lattice matrix rows [a, b, c]; only applied when jimage is non-zero and
// lattice is present. Mirrors bond-computation-controller.svelte.ts apply_jimage.
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

// Site index -> bonded neighbours with PBC-correct Cartesian positions.
// When lattice is supplied, cross-cell neighbours are shifted by lattice·jimage:
//   forward  (neighbour = site_idx_2): pos = shift(pos_2,  +jimage, lattice)
//   reverse  (neighbour = site_idx_1): pos = shift(pos_1,  -jimage, lattice)
// When lattice is null the base pos is used unchanged (molecules / jimage [0,0,0]).
export function build_bond_adjacency(
  bonds: readonly BondPair[],
  lattice: [Vec3, Vec3, Vec3] | null = null,
): Map<number, { idx: number; pos: Vec3 }[]> {
  const adj = new Map<number, { idx: number; pos: Vec3 }[]>()
  const link = (from: number, to: number, pos: Vec3) => {
    const list = adj.get(from)
    if (list) list.push({ idx: to, pos })
    else adj.set(from, [{ idx: to, pos }])
  }
  for (const b of bonds) {
    if (b.site_idx_1 === b.site_idx_2) continue
    const j = b.jimage ?? [0, 0, 0] as [number, number, number]
    const neg_j: [number, number, number] = [-j[0], -j[1], -j[2]]
    link(b.site_idx_1, b.site_idx_2, shift_by_jimage(b.pos_2, j, lattice))
    link(b.site_idx_2, b.site_idx_1, shift_by_jimage(b.pos_1, neg_j, lattice))
  }
  return adj
}

export interface PolyhedraBondOptions {
  center_elements?: string[] // allow-list of center elements (matterviz "Centers");
  // keeps anion-vertex selection + distance trim, but bypasses the CN cap and the
  // spectator/framework auto-hide so explicitly chosen elements always draw.
  min_coordination?: number // default 4
  max_neighbors?: number // skip CN above this (e.g. CN-12); default 8
  metals_only?: boolean // default true: only metal centers in auto mode
  distance_factor?: number // trim vertices beyond min_bond*(1+factor); default 0.3
}

// Bond-graph coordination polyhedra. Vertices are bonded anion neighbours taken
// straight from the rendered bond graph (positions already PBC-correct via
// bond.pos), classified per-vertex by is_anion_vertex.
export function compute_polyhedra_from_bonds(
  structure: AnyStructure,
  bonds: readonly BondPair[],
  options: PolyhedraBondOptions = {},
): PolyhedronData[] {
  const {
    center_elements = [],
    min_coordination = 4,
    max_neighbors = 8,
    metals_only = true,
    distance_factor = 0.3,
  } = options
  if (!structure?.sites?.length || bonds.length === 0) return []

  const explicit = center_elements.length > 0
  const allow = new Set(center_elements)
  const lattice = (structure as { lattice?: { matrix?: unknown } }).lattice?.matrix
  const lat = (Array.isArray(lattice) && lattice.length === 3)
    ? lattice as [Vec3, Vec3, Vec3]
    : null
  const adjacency = build_bond_adjacency(bonds, lat)
  const candidates: PolyhedronData[] = []

  for (const [center_idx, neighbors] of adjacency) {
    const c_element = get_site_element(structure, center_idx)
    if (!c_element) continue
    if (explicit) {
      if (!allow.has(c_element)) continue
    } else if (metals_only && !is_metal(c_element)) {
      continue
    }
    const c_pos = structure.sites[center_idx]?.xyz
    if (!c_pos) continue

    const c_en = get_electronegativity(c_element)
    const c_is_metal = is_metal(c_element)

    // collect anion vertices with distances
    const vtx: { idx: number; pos: Vec3; dist: number }[] = []
    let min_dist = Infinity
    for (const n of neighbors) {
      const n_el = get_site_element(structure, n.idx)
      // Anion-vertex selection applies in every mode (incl. explicit allow-list) so
      // chosen centers still get clean coordination shells, not cation-cation bonds.
      if (!is_anion_vertex(c_en, c_is_metal, n_el, 0)) continue
      const dist = Math.hypot(
        n.pos[0] - c_pos[0], n.pos[1] - c_pos[1], n.pos[2] - c_pos[2],
      )
      vtx.push({ idx: n.idx, pos: n.pos, dist })
      if (dist < min_dist) min_dist = dist
    }
    if (vtx.length < min_coordination) continue

    // VESTA-like local cutoff: drop bonds far longer than the shortest kept bond
    const cutoff = min_dist * (1 + distance_factor)
    const kept = vtx.filter((v) => v.dist <= cutoff)
    if (kept.length < min_coordination) continue
    if (!explicit && kept.length > max_neighbors) continue

    candidates.push({
      center_idx,
      center_element: c_element,
      neighbor_indices: kept.map((v) => v.idx),
      vertices: kept.map((v) => [v.pos[0], v.pos[1], v.pos[2]]),
    })
  }

  if (explicit) return candidates
  return apply_framework_filters(structure, candidates)
}


// Spectator + weak-bond hiding over the EN-passing candidates. Composition-based
// so boundary-truncated framework copies don't promote A-site clutter.
const WEAK_BOND_NORM = 1.15
function apply_framework_filters(
  structure: AnyStructure,
  candidates: PolyhedronData[],
): PolyhedronData[] {
  if (candidates.length === 0) return candidates

  // Framework potential test is composition-based (over ALL elements in the
  // structure, incl. anions) so the most-EN element is the anion: a non-spectator
  // cation less electronegative than it could coordinate the anions. Matches
  // matterviz; keeps e.g. Ba hidden in BaTiO3 (Ti < O) but Na visible in NaCl.
  const all_elements = [
    ...new Set(structure.sites.map((_, idx) => get_site_element(structure, idx)).filter(Boolean)),
  ]
  const max_en = Math.max(...all_elements.map((el) => get_electronegativity(el)))
  const has_framework_potential = all_elements.some((el) =>
    !is_spectator_center(el) && get_electronegativity(el) < max_en
  )

  // Per-species mean normalized bond distance (bond / covalent-radii sum)
  const norm_by_species = new Map<string, { sum: number; count: number }>()
  for (const poly of candidates) {
    const r_center = get_covalent_radius(poly.center_element)
    const c_pos = structure.sites[poly.center_idx]?.xyz
    if (r_center === null || !c_pos) continue
    let sum = 0, count = 0
    for (let i = 0; i < poly.vertices.length; i++) {
      const n_idx = poly.neighbor_indices[i]
      const n_el = n_idx >= 0 ? get_site_element(structure, n_idx) : ``
      const r_n = n_el ? get_covalent_radius(n_el) : null
      if (r_n === null) continue
      const v = poly.vertices[i]
      const dist = Math.hypot(v[0] - c_pos[0], v[1] - c_pos[1], v[2] - c_pos[2])
      sum += dist / (r_center + r_n)
      count++
    }
    if (count === 0) continue
    const entry = norm_by_species.get(poly.center_element) ?? { sum: 0, count: 0 }
    entry.sum += sum / count
    entry.count++
    norm_by_species.set(poly.center_element, entry)
  }
  const species_norm = (el: string): number | null => {
    const e = norm_by_species.get(el)
    return e ? e.sum / e.count : null
  }
  const has_strong_species = [...norm_by_species.keys()].some(
    (el) => (species_norm(el) ?? Infinity) <= WEAK_BOND_NORM && !is_spectator_center(el),
  )
  const is_weak_species = (el: string): boolean =>
    has_strong_species && (species_norm(el) ?? 0) > WEAK_BOND_NORM

  return candidates.filter((poly) => {
    const el = poly.center_element
    if (is_spectator_center(el) && has_framework_potential) return false
    return !is_weak_species(el)
  })
}

// --- Convex hull + geometry merging ---

function compute_hull_faces(
  vertices: number[][],
): { faces: number[][]; degenerate: boolean } {
  if (vertices.length < 4) {
    // Single flat triangle: non-manifold, edges drawn verbatim (no crease test)
    return { faces: [[0, 1, 2]], degenerate: true }
  }
  try {
    return { faces: qh(vertices as [number, number, number][]) as number[][], degenerate: false }
  } catch {
    // Degenerate (coplanar) — fan triangulation, non-manifold: draw all edges
    const faces: number[][] = []
    for (let i = 1; i < vertices.length - 1; i++) {
      faces.push([0, i, i + 1])
    }
    return { faces, degenerate: true }
  }
}

function hex_to_rgb(hex: string): [number, number, number] {
  const h = hex.replace(`#`, ``)
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ]
}

// Unit normal of a triangle from three Cartesian vertices.
function tri_normal(
  a: number[],
  b: number[],
  c: number[],
): [number, number, number] {
  let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1])
  let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2])
  let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const len = Math.hypot(nx, ny, nz)
  if (len > 0) {
    nx /= len
    ny /= len
    nz /= len
  }
  return [nx, ny, nz]
}

// Merge all polyhedra into single non-indexed position/color arrays. `get_vertex_color`
// resolves the color of each hull corner (vertex atom color, center color, or uniform)
// as a hex string. Crease detection omits coplanar quad diagonals (e.g. cube/octahedron
// faces) so only real creases + boundary edges are drawn; degenerate hulls keep all edges.
export function merge_polyhedra_geometry(
  polyhedra: PolyhedronData[],
  get_vertex_color: (poly: PolyhedronData, vertex_local_idx: number) => string,
): MergedPolyhedraGeometry {
  if (polyhedra.length === 0) {
    return {
      face_positions: new Float32Array(0),
      face_normals: new Float32Array(0),
      face_colors: new Float32Array(0),
      face_polyhedron_ids: new Float32Array(0),
      face_count: 0,
      edge_positions: new Float32Array(0),
      edge_count: 0,
    }
  }

  const hulls: { faces: number[][]; degenerate: boolean }[] = []
  let total_tris = 0
  let max_edges = 0

  for (const poly of polyhedra) {
    const { faces, degenerate } = compute_hull_faces(poly.vertices)
    hulls.push({ faces, degenerate })
    total_tris += faces.length
    max_edges += faces.length * 3  // upper bound; dedup + crease test only remove edges
  }

  const face_positions = new Float32Array(total_tris * 9)
  const face_normals = new Float32Array(total_tris * 9)
  const face_colors = new Float32Array(total_tris * 9)
  const face_polyhedron_ids = new Float32Array(total_tris * 3)
  const edge_positions = new Float32Array(max_edges * 6)
  const rgb_cache = new Map<string, [number, number, number]>()

  let tri_offset = 0
  let edge_offset = 0

  // Per-undirected-edge state for crease detection
  type EdgeEntry = {
    a: number
    b: number
    nx: number
    ny: number
    nz: number
    crease: boolean
    shared: boolean
  }

  for (let p = 0; p < polyhedra.length; p++) {
    const poly = polyhedra[p]
    const hull = hulls[p]

    // Vertex centroid — the radial direction (vertex − centroid) is a good smooth
    // outward normal for a convex coordination polyhedron, giving faces a soft
    // glassy gradient instead of hard flat facets.
    let cx = 0, cy = 0, cz = 0
    for (const vtx of poly.vertices) {
      cx += vtx[0]
      cy += vtx[1]
      cz += vtx[2]
    }
    const nv = poly.vertices.length || 1
    cx /= nv
    cy /= nv
    cz /= nv

    // Resolve per-hull-vertex colors once (closure indexes local vertex order)
    const vert_rgb = new Float32Array(poly.vertices.length * 3)
    for (let v = 0; v < poly.vertices.length; v++) {
      const color = get_vertex_color(poly, v)
      let channels = rgb_cache.get(color)
      if (!channels) {
        channels = color.startsWith(`#`) ? hex_to_rgb(color) : [0.5, 0.5, 0.5]
        rgb_cache.set(color, channels)
      }
      vert_rgb[v * 3] = channels[0]
      vert_rgb[v * 3 + 1] = channels[1]
      vert_rgb[v * 3 + 2] = channels[2]
    }

    const edge_map = new Map<string, EdgeEntry>()
    for (const face of hull.faces) {
      const va = poly.vertices[face[0]]
      const vb = poly.vertices[face[1]]
      const vc = poly.vertices[face[2]]
      const [nx, ny, nz] = tri_normal(va, vb, vc)

      for (let v = 0; v < 3; v++) {
        const local = face[v]
        const vert = poly.vertices[local]
        const base = tri_offset * 9 + v * 3
        face_positions[base] = vert[0]
        face_positions[base + 1] = vert[1]
        face_positions[base + 2] = vert[2]
        // Smooth outward normal: radial from the polyhedron centroid.
        let snx = vert[0] - cx
        let sny = vert[1] - cy
        let snz = vert[2] - cz
        const slen = Math.hypot(snx, sny, snz) || 1
        snx /= slen
        sny /= slen
        snz /= slen
        face_normals[base] = snx
        face_normals[base + 1] = sny
        face_normals[base + 2] = snz
        face_colors[base] = vert_rgb[local * 3]
        face_colors[base + 1] = vert_rgb[local * 3 + 1]
        face_colors[base + 2] = vert_rgb[local * 3 + 2]
        face_polyhedron_ids[tri_offset * 3 + v] = p
      }
      tri_offset++

      for (let i = 0; i < 3; i++) {
        const a = face[i]
        const b = face[(i + 1) % 3]
        const key = a < b ? `${a}-${b}` : `${b}-${a}`
        const entry = edge_map.get(key)
        if (entry) {
          entry.shared = true
          // Two faces sharing this edge: a crease only if their normals diverge
          entry.crease = nx * entry.nx + ny * entry.ny + nz * entry.nz < 1 - 1e-3
        } else {
          edge_map.set(key, { a, b, nx, ny, nz, crease: false, shared: false })
        }
      }
    }

    // Emit edges: on degenerate (non-manifold) hulls draw all; otherwise drop
    // diagonals interior to coplanar face groups (quad diagonals on a cube)
    for (const entry of edge_map.values()) {
      if (!hull.degenerate && entry.shared && !entry.crease) continue
      const va = poly.vertices[entry.a]
      const vb = poly.vertices[entry.b]
      const base = edge_offset * 6
      edge_positions[base] = va[0]
      edge_positions[base + 1] = va[1]
      edge_positions[base + 2] = va[2]
      edge_positions[base + 3] = vb[0]
      edge_positions[base + 4] = vb[1]
      edge_positions[base + 5] = vb[2]
      edge_offset++
    }
  }

  return {
    face_positions,
    face_normals,
    face_colors,
    face_polyhedron_ids,
    face_count: total_tris,
    edge_positions: edge_positions.slice(0, edge_offset * 6),
    edge_count: edge_offset,
  }
}

// --- Visibility helpers ---

export function get_polyhedra_hidden_atoms(
  polyhedra: PolyhedronData[],
  hide_center: boolean,
): Map<number, number> {
  const overrides = new Map<number, number>()
  for (const poly of polyhedra) {
    if (hide_center) {
      overrides.set(poly.center_idx, 0)
    }
  }
  return overrides
}

export function get_polyhedra_hidden_bond_keys(
  polyhedra: PolyhedronData[],
): Set<string> {
  const keys = new Set<string>()
  for (const poly of polyhedra) {
    for (const n of poly.neighbor_indices) {
      if (n >= 0) keys.add(get_bond_key(poly.center_idx, n))
    }
    for (let i = 0; i < poly.neighbor_indices.length; i++) {
      for (let j = i + 1; j < poly.neighbor_indices.length; j++) {
        const ni = poly.neighbor_indices[i]
        const nj = poly.neighbor_indices[j]
        if (ni >= 0 && nj >= 0) keys.add(get_bond_key(ni, nj))
      }
    }
  }
  return keys
}

export function get_metals_in_structure(structure: AnyStructure | undefined): string[] {
  if (!structure?.sites) return []
  const metals = new Set<string>()
  for (const site of structure.sites) {
    const el = site.species?.[0]?.element
    if (el && is_metal(el)) metals.add(el)
  }
  return [...metals].sort()
}

/** Map a polyhedra render style to the face shader's u_style int. */
export function polyhedra_style_to_int(
  style: import('$lib/settings').PolyhedraStyle,
): 0 | 1 | 2 {
  return style === `glass` ? 2 : style === `matte` ? 1 : 0
}

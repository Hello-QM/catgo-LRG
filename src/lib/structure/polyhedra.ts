// Coordination polyhedra computation for structure visualization.
//
// Two algorithms available:
//   1. CrystalNN (Voronoi + solid angle + electronegativity) — default, via Rust WASM
//   2. Distance cutoff (3.5 Å) — synchronous fallback
//
// Crystal Toolkit electronegativity filter: polyhedra are drawn only around
// the LEAST electronegative site in each coordination cluster (i.e. metals/cations),
// preventing overlapping polyhedra in ionic/covalent structures.

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

// --- Lattice math ---

function get_lattice_vectors(structure: AnyStructure): [Vec3, Vec3, Vec3] | null {
  const lat = (structure as any).lattice
  if (!lat?.matrix) return null
  const m = lat.matrix
  return [
    [m[0][0], m[0][1], m[0][2]],
    [m[1][0], m[1][1], m[1][2]],
    [m[2][0], m[2][1], m[2][2]],
  ]
}

function add_v3(a: number[], b: Vec3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function dist_sq(a: number[], b: number[]): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]
  return dx * dx + dy * dy + dz * dz
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

// --- Fast polyhedra: distance cutoff + Crystal Toolkit electronegativity filter ---

/**
 * Compute polyhedra using distance-based neighbor search + electronegativity filter.
 *
 * Fast (synchronous, no WASM) — uses the same 3.5Å cutoff as before,
 * plus Crystal Toolkit's rule: polyhedra only around the least electronegative
 * site in each coordination cluster (prevents overlapping polyhedra).
 */
export function compute_polyhedra_fast(
  structure: AnyStructure,
  center_elements: string[],
  min_coordination: number,
  metals_only: boolean = true,
  max_bond_length: number = 3.5,
  max_neighbors: number = 8,
): PolyhedronData[] {
  // Get raw distance-based polyhedra (fast, synchronous). center_elements acts as
  // a force-include allow-list: when non-empty it bypasses the EN/metals/spectator
  // filters AND the max_neighbors cap (matches catgo's documented bypass at 107).
  const explicit = center_elements.length > 0
  const raw = compute_polyhedra_with_pbc(
    structure, center_elements, min_coordination, max_bond_length, max_neighbors, explicit,
  )

  // If user explicitly selected elements, skip electronegativity/spectator filters
  if (explicit) return raw

  // Apply Crystal Toolkit electronegativity filter + metals_only (catgo's primary gate)
  const en_filtered = raw.filter((poly) => {
    if (metals_only && !is_metal(poly.center_element)) return false

    // All neighbors must be strictly more electronegative than the center
    const c_en = get_electronegativity(poly.center_element)
    const neighbor_elements = poly.neighbor_indices.map((idx) =>
      idx >= 0 ? get_site_element(structure, idx) : ``,
    )
    const all_more_en = neighbor_elements.every((el) => {
      if (!el) return true
      return get_electronegativity(el) > c_en
    })
    const all_same = neighbor_elements.every((el) => el === poly.center_element)
    return all_more_en && !all_same
  })

  // Additive VESTA-style passes (ported from matterviz), layered after the EN gate:
  // (1) hide spectator A-site cations (alkali, heavy alkaline-earth) when a
  //     non-spectator framework cation exists; purely-ionic binaries (NaCl) keep them.
  // (2) hide weakly-bound species (mean bond dist / covalent-radii sum > weak_bond_norm)
  //     when a strong non-spectator framework species exists (e.g. lone-pair Bi3+).
  return apply_framework_filters(structure, en_filtered)
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

// --- Distance-based fallback (legacy) ---
// For each center atom, search all atoms in 27 cells (3x3x3 neighborhood)
// to find neighbors within a distance cutoff. This is independent of bond detection.

export function compute_polyhedra_with_pbc(
  structure: AnyStructure,
  center_elements: string[],
  min_coordination: number,
  max_bond_length: number = 3.5,  // Å — typical max coordination bond length
  max_neighbors: number = 8,      // skip centers with CN above this (clutter cap)
  explicit: boolean = false,      // center_elements force-included: bypass anion-vertex filter + cap
): PolyhedronData[] {
  if (!structure?.sites?.length) return []

  const lattice = get_lattice_vectors(structure)
  const is_periodic = !!lattice

  // Determine which elements are centers
  const target_elements = center_elements.length > 0
    ? new Set(center_elements)
    : new Set(
        structure.sites
          .map((_, idx) => get_site_element(structure, idx))
          .filter((el) => el && is_metal(el)),
      )

  if (target_elements.size === 0) return []

  const max_dist_sq = max_bond_length * max_bond_length
  const polyhedra: PolyhedronData[] = []

  // For each potential center atom
  for (let c = 0; c < structure.sites.length; c++) {
    const c_element = get_site_element(structure, c)
    if (!target_elements.has(c_element)) continue

    const c_pos = structure.sites[c].xyz

    // Per-vertex anion filter (auto-detect only): a neighbor qualifies as a hull
    // vertex only if it is an anion-former (nonmetal/metalloid more EN than center).
    // Force-included (explicit) centers keep every neighbor within cutoff.
    const c_en = get_electronegativity(c_element)
    const c_is_metal = is_metal(c_element)
    const accept_vertex = (v_idx: number): boolean =>
      explicit || is_anion_vertex(c_en, c_is_metal, get_site_element(structure, v_idx), 0)

    // Search for neighbor atoms within distance cutoff
    // Include periodic images by shifting through 27 cells
    const neighbor_indices: number[] = []
    const neighbor_positions: number[][] = []

    for (let v = 0; v < structure.sites.length; v++) {
      if (v === c) continue  // Skip self
      if (!accept_vertex(v)) continue
      const v_pos = structure.sites[v].xyz

      if (is_periodic && lattice) {
        // Check 27 periodic images (da, db, dc ∈ {-1, 0, 1})
        for (let da = -1; da <= 1; da++) {
          for (let db = -1; db <= 1; db++) {
            for (let dc = -1; dc <= 1; dc++) {
              const shifted: [number, number, number] = [
                v_pos[0] + da * lattice[0][0] + db * lattice[1][0] + dc * lattice[2][0],
                v_pos[1] + da * lattice[0][1] + db * lattice[1][1] + dc * lattice[2][1],
                v_pos[2] + da * lattice[0][2] + db * lattice[1][2] + dc * lattice[2][2],
              ]
              const d2 = dist_sq(c_pos, shifted)
              if (d2 > 0.01 && d2 <= max_dist_sq) {
                neighbor_indices.push(v)
                neighbor_positions.push(shifted)
              }
            }
          }
        }
      } else {
        // Non-periodic: simple distance check
        const d2 = dist_sq(c_pos, v_pos)
        if (d2 > 0.01 && d2 <= max_dist_sq) {
          neighbor_indices.push(v)
          neighbor_positions.push([v_pos[0], v_pos[1], v_pos[2]])
        }
      }
    }

    if (neighbor_positions.length < min_coordination) continue
    // CN cap (clutter heuristic) — force-included centers bypass it
    if (!explicit && neighbor_positions.length > max_neighbors) continue

    polyhedra.push({
      center_idx: c,
      center_element: c_element,
      neighbor_indices,
      vertices: neighbor_positions,
    })
  }

  return polyhedra
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

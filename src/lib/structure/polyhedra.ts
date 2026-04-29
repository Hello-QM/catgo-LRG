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
import { colors as global_colors } from '$lib/state.svelte'
import qh from 'quickhull3d'

// --- Types ---

export interface PolyhedronData {
  center_idx: number
  center_element: string
  neighbor_indices: number[]     // site indices (may be -1 for periodic images)
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
): PolyhedronData[] {
  // Get raw distance-based polyhedra (fast, synchronous)
  const raw = compute_polyhedra_with_pbc(structure, center_elements, min_coordination, max_bond_length)

  // If user explicitly selected elements, skip electronegativity filter
  if (center_elements.length > 0) return raw

  // Apply Crystal Toolkit electronegativity filter + metals_only
  return raw.filter((poly) => {
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
}

// --- Distance-based fallback (legacy) ---
// For each center atom, search all atoms in 27 cells (3x3x3 neighborhood)
// to find neighbors within a distance cutoff. This is independent of bond detection.

export function compute_polyhedra_with_pbc(
  structure: AnyStructure,
  center_elements: string[],
  min_coordination: number,
  max_bond_length: number = 3.5,  // Å — typical max coordination bond length
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

    // Search for neighbor atoms within distance cutoff
    // Include periodic images by shifting through 27 cells
    const neighbor_indices: number[] = []
    const neighbor_positions: number[][] = []

    for (let v = 0; v < structure.sites.length; v++) {
      if (v === c) continue  // Skip self
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

function compute_hull_faces(vertices: number[][]): number[][] {
  if (vertices.length < 4) {
    return [[0, 1, 2]]
  }
  try {
    return qh(vertices as [number, number, number][]) as number[][]
  } catch {
    // Degenerate (coplanar) — fan triangulation
    const faces: number[][] = []
    for (let i = 1; i < vertices.length - 1; i++) {
      faces.push([0, i, i + 1])
    }
    return faces
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

export function merge_polyhedra_geometry(
  polyhedra: PolyhedronData[],
  color_overrides: Record<string, string>,
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

  const hulls: { faces: number[][]; edge_set: Set<string> }[] = []
  let total_tris = 0
  let total_edges = 0

  for (const poly of polyhedra) {
    const faces = compute_hull_faces(poly.vertices)
    const edge_set = new Set<string>()
    for (const face of faces) {
      for (let i = 0; i < face.length; i++) {
        const a = face[i]
        const b = face[(i + 1) % face.length]
        const key = a < b ? `${a}-${b}` : `${b}-${a}`
        edge_set.add(key)
      }
    }
    hulls.push({ faces, edge_set })
    total_tris += faces.length
    total_edges += edge_set.size
  }

  const face_positions = new Float32Array(total_tris * 9)
  const face_colors = new Float32Array(total_tris * 9)
  const face_polyhedron_ids = new Float32Array(total_tris * 3)
  const edge_positions = new Float32Array(total_edges * 6)

  let tri_offset = 0
  let edge_offset = 0

  for (let p = 0; p < polyhedra.length; p++) {
    const poly = polyhedra[p]
    const hull = hulls[p]

    let color: [number, number, number]
    if (color_overrides[poly.center_element]) {
      color = hex_to_rgb(color_overrides[poly.center_element])
    } else {
      const el_color = global_colors.element?.[poly.center_element]
      if (el_color) {
        color = hex_to_rgb(el_color)
      } else {
        color = [0, 0.7, 0.9]
      }
    }

    for (const face of hull.faces) {
      for (let v = 0; v < 3; v++) {
        const vert = poly.vertices[face[v]]
        const base = tri_offset * 9 + v * 3
        face_positions[base] = vert[0]
        face_positions[base + 1] = vert[1]
        face_positions[base + 2] = vert[2]
        face_colors[base] = color[0]
        face_colors[base + 1] = color[1]
        face_colors[base + 2] = color[2]
        face_polyhedron_ids[tri_offset * 3 + v] = p
      }
      tri_offset++
    }

    for (const edge_key of hull.edge_set) {
      const [a_str, b_str] = edge_key.split(`-`)
      const a = parseInt(a_str)
      const b = parseInt(b_str)
      const va = poly.vertices[a]
      const vb = poly.vertices[b]
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
    edge_positions,
    edge_count: total_edges,
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

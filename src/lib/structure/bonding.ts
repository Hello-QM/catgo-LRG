// Bonding algorithms for structure visualization

import type { AnyStructure, BondPair, HBondOptions, Site, Vec3 } from '$lib'
import { element_data } from '$lib/element'
import covalent_radii_data from '$lib/element/single_bond_covalent_radii.json'
import * as math from '$lib/math'

// Canonical bond key for deduplication and lookup (smaller index first).
//
// `jimage` is optional: omit (or pass undefined) to get the legacy
// atom-pair-only key — every caller pre-Phase-3 used this shape, and
// keeping it as the default preserves existing behaviour (manual bonds
// are intra-cell, deleted_bond_keys, polyhedra bond filtering, etc.).
//
// When `jimage` is supplied, the key includes a canonicalized lattice
// translation. `(a, b, [+1,0,0])` and `(b, a, [-1,0,0])` describe the
// same physical bond and produce the same key — direction is negated
// when the atom pair is swapped during canonicalization.
export function get_bond_key(
  idx1: number,
  idx2: number,
  jimage?: [number, number, number] | null,
): string {
  const lo = Math.min(idx1, idx2)
  const hi = Math.max(idx1, idx2)
  if (jimage === undefined || jimage === null) return `${lo}-${hi}`
  const swap = idx1 >= idx2
  const dx = swap ? -jimage[0] : jimage[0]
  const dy = swap ? -jimage[1] : jimage[1]
  const dz = swap ? -jimage[2] : jimage[2]
  return `${lo}-${hi}-${dx},${dy},${dz}`
}

type SpatialGrid = Map<string, number[]>

const element_lookup = new Map(element_data.map((el) => [el.symbol, el]))
const covalent_radii: Map<string, number> = new Map(
  element_data.filter((el) => el.covalent_radius !== null).map((
    el,
  ) => [el.symbol, el.covalent_radius as number]),
)

// Get the species with highest occupancy from a site.
function get_majority_species(site: Site) {
  return (site.species ?? []).reduce(
    (max, spec) => (spec.occu > max.occu ? spec : max),
    site.species?.[0] ?? { element: ``, occu: -1 },
  )
}

// Compute 4x4 transformation matrix for bond cylinder between two positions.
// Uses Y-up, right-handed coordinate system convention for Three.js compatibility.
export function compute_bond_transform(pos_1: Vec3, pos_2: Vec3): Float32Array {
  const [dx, dy, dz] = math.subtract(pos_2, pos_1)
  const height = Math.hypot(dx, dy, dz)

  if (height < 1e-10) {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  }

  const [dir_x, dir_y, dir_z] = [dx / height, dy / height, dz / height]
  let [m00, m01, m02, m10, m11, m12, m20, m21, m22] = [0, 0, 0, 0, 0, 0, 0, 0, 0]

  // Special case: bond pointing straight up (+Y)
  if (Math.abs(dir_y - 1.0) < 1e-10) {
    ;[m00, m01, m02, m10, m11, m12, m20, m21, m22] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  } else if (Math.abs(dir_y + 1.0) < 1e-10) {
    // Special case: bond pointing straight down (-Y)
    ;[m00, m01, m02, m10, m11, m12, m20, m21, m22] = [1, 0, 0, 0, -1, 0, 0, 0, 1]
  } else {
    // General case: construct orthonormal basis (right, dir, up)
    // Right vector: perpendicular to dir in XZ plane
    const [rx, rz] = [-dir_z, dir_x]
    const r_len = Math.hypot(rx, rz)
    const [right_x, right_z] = [rx / r_len, rz / r_len]
    // Up vector: cross product of dir and right
    const [up_x, up_y, up_z] = [
      dir_y * right_z,
      dir_z * right_x - dir_x * right_z,
      -dir_y * right_x,
    ]
    ;[m00, m01, m02, m10, m11, m12, m20, m21, m22] = [
      right_x,
      dir_x,
      up_x,
      0,
      dir_y,
      up_y,
      right_z,
      dir_z,
      up_z,
    ]
  }

  // Position at midpoint between the two atoms
  const [px, py, pz] = [
    (pos_1[0] + pos_2[0]) / 2,
    (pos_1[1] + pos_2[1]) / 2,
    (pos_1[2] + pos_2[2]) / 2,
  ]

  return new Float32Array([ // Return flattened column-major 4x4 matrix for Three.js
    ...[m00, m10, m20, 0],
    ...[m01 * height, m11 * height, m21 * height, 0],
    ...[m02, m12, m22, 0],
    ...[px, py, pz, 1],
  ])
}

// Update bond positions based on current atom positions without recalculating connectivity.
// This is a fast O(B) operation where B is the number of bonds, used during atom manipulation.
export function update_bond_positions(
  existing_bonds: BondPair[],
  sites: Site[],
): BondPair[] {
  return existing_bonds.map((bond) => {
    const pos_1 = sites[bond.site_idx_1]?.xyz
    const pos_2 = sites[bond.site_idx_2]?.xyz
    if (!pos_1 || !pos_2) return bond // Keep original if sites don't exist

    const diff = math.subtract(pos_2, pos_1)
    const bond_length = Math.hypot(diff[0], diff[1], diff[2])
    return {
      ...bond,
      pos_1,
      pos_2,
      bond_length,
      transform_matrix: compute_bond_transform(pos_1, pos_2),
    }
  })
}

// Build spatial grid by dividing 3D space into cubic cells.
function build_spatial_grid(sites: Site[], cell_size: number): SpatialGrid {
  const grid: SpatialGrid = new Map()
  for (let idx = 0; idx < sites.length; idx++) {
    const [x, y, z] = sites[idx].xyz.map((coord) => Math.floor(coord / cell_size))
    const key = `${x},${y},${z}`
    const cell = grid.get(key)
    if (cell) cell.push(idx)
    else grid.set(key, [idx])
  }
  return grid
}

// Get all site indices in 3x3x3 cube of cells around position.
function get_neighbors_from_grid(
  pos: Vec3,
  grid: SpatialGrid,
  cell_size: number,
): number[] {
  const [cx, cy, cz] = [
    Math.floor(pos[0] / cell_size),
    Math.floor(pos[1] / cell_size),
    Math.floor(pos[2] / cell_size),
  ]
  const neighbors: number[] = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cell = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
        if (cell) neighbors.push(...cell)
      }
    }
  }
  return neighbors
}

// Setup spatial decomposition for structures with >50 atoms.
function setup_spatial_grid(sites: Site[], cutoff: number) {
  const use_grid = sites.length > 50
  return use_grid ? { grid: build_spatial_grid(sites, cutoff), cell_size: cutoff } : null
}

// Get candidate neighbor indices using spatial grid or all sites.
function get_candidates(
  pos: Vec3,
  sites: Site[],
  spatial: ReturnType<typeof setup_spatial_grid>,
): number[] {
  return spatial
    ? get_neighbors_from_grid(pos, spatial.grid, spatial.cell_size)
    : Array.from({ length: sites.length }, (_, idx) => idx)
}

export const BONDING_STRATEGIES = { electroneg_ratio, solid_angle, atom_radii } as const
export type BondingStrategy = keyof typeof BONDING_STRATEGIES
export type BondingAlgo = (typeof BONDING_STRATEGIES)[BondingStrategy]

// Electronegativity-based bonding with chemical preferences.
// This algorithm considers electronegativity differences between atoms, metal/nonmetal
// properties, and distance to determine bond strength. Bonds are only created if the
// computed strength exceeds the strength_threshold parameter (default: 0.3).
export function electroneg_ratio(
  structure: AnyStructure,
  {
    electronegativity_threshold = 1.7, // Max electronegativity difference for bonding
    max_distance_ratio = 2.0, // Max distance as multiple of sum of covalent radii
    min_bond_dist = 0.4, // Minimum bond distance in Angstroms
    metal_metal_penalty = 0.7, // Strength penalty for metal-metal bonds
    metal_nonmetal_bonus = 1.5, // Strength bonus for metal-nonmetal bonds
    similar_electronegativity_bonus = 1.2, // Bonus for similar electronegativity
    same_species_penalty = 0.75, // Penalty for bonds between same element (increased from 0.5 to better detect chains)
    strength_threshold = 0.2, // Minimum bond strength to include in results (lowered from 0.3 for robustness)
  } = {},
): BondPair[] {
  const { sites } = structure
  if (sites.length < 2) return []

  const bonds: BondPair[] = []
  const min_dist_sq = min_bond_dist ** 2
  const closest = new Map<number, number>()

  const props = sites.map((site) => {
    const majority = get_majority_species(site)
    const elem = majority.element
    const data = element_lookup.get(elem)
    return {
      element: elem,
      electroneg: data?.electronegativity ?? 2.0,
      is_metal: data?.metal ?? false,
      is_nonmetal: data?.nonmetal ?? false,
      radius: elem ? covalent_radii.get(elem) : undefined,
    }
  })

  let max_radius = 0
  for (const radius of covalent_radii.values()) {
    if (radius > max_radius) max_radius = radius
  }
  const max_cutoff = max_radius * 2 * max_distance_ratio
  const spatial = setup_spatial_grid(sites, max_cutoff)

  for (let idx_a = 0; idx_a < sites.length - 1; idx_a++) {
    const [x1, y1, z1] = sites[idx_a].xyz
    const pa = props[idx_a]

    for (const idx_b of get_candidates(sites[idx_a].xyz, sites, spatial)) {
      if (idx_b <= idx_a) continue

      const [x2, y2, z2] = sites[idx_b].xyz
      const pb = props[idx_b]

      const [dx, dy, dz] = [x2 - x1, y2 - y1, z2 - z1]
      const dist_sq = dx * dx + dy * dy + dz * dz
      const dist = Math.sqrt(dist_sq)

      if (dist_sq < min_dist_sq || !pa.radius || !pb.radius) continue

      const expected = pa.radius + pb.radius
      if (dist > expected * max_distance_ratio) continue

      const en_diff = Math.abs(pa.electroneg - pb.electroneg)
      const en_ratio = en_diff / (pa.electroneg + pb.electroneg)

      let bond_strength = 1.0
      if (pa.is_metal && pb.is_metal) {
        bond_strength *= metal_metal_penalty
      } else if ((pa.is_metal && pb.is_nonmetal) || (pa.is_nonmetal && pb.is_metal)) {
        bond_strength *= metal_nonmetal_bonus
        if (en_diff > electronegativity_threshold) bond_strength *= 1.3
      } else if (en_diff < 0.5) {
        bond_strength *= similar_electronegativity_bonus
      }

      const dist_weight = Math.exp(-((dist / expected - 1) ** 2) / 0.18)
      const en_weight = 1.0 - 0.3 * en_ratio
      let strength = bond_strength * dist_weight * en_weight

      if (pa.element === pb.element) strength *= same_species_penalty

      const ca = closest.get(idx_a) ?? Infinity
      const cb = closest.get(idx_b) ?? Infinity
      if (dist > ca) strength *= Math.exp(-(dist / ca - 1) / 0.5)
      if (dist > cb) strength *= Math.exp(-(dist / cb - 1) / 0.5)

      if (strength > strength_threshold) {
        bonds.push({
          pos_1: sites[idx_a].xyz,
          pos_2: sites[idx_b].xyz,
          site_idx_1: idx_a,
          site_idx_2: idx_b,
          bond_length: dist,
          strength,
          transform_matrix: compute_bond_transform(sites[idx_a].xyz, sites[idx_b].xyz),
          jimage: [0, 0, 0],
        })
        if (dist < ca) closest.set(idx_a, dist)
        if (dist < cb) closest.set(idx_b, dist)
      }
    }
  }
  return bonds
}

// Solid angle-based bonding using geometric proximity heuristics.
// Inspired by Voronoi tessellation without having to actually compute Voronoi cells.
// This algorithm computes bond strength based on the solid angle subtended by atoms
// and their distance penalty. Bonds are only created if the computed strength exceeds
// the strength_threshold parameter.
export function solid_angle(
  structure: AnyStructure,
  {
    min_solid_angle = 0.01,
    min_face_area = 0.05,
    max_distance = 5.0,
    min_bond_dist = 0.4,
    strength_threshold = 0.05,
  } = {},
): BondPair[] {
  const { sites } = structure
  if (sites.length < 2) return []

  const bonds: BondPair[] = []
  const min_dist_sq = min_bond_dist ** 2
  const max_dist_sq = max_distance ** 2
  const spatial = setup_spatial_grid(sites, max_distance)

  for (let idx_a = 0; idx_a < sites.length - 1; idx_a++) {
    const [x1, y1, z1] = sites[idx_a].xyz
    const majority_a = get_majority_species(sites[idx_a])
    const ra = majority_a.element ? covalent_radii.get(majority_a.element) : undefined

    for (const idx_b of get_candidates(sites[idx_a].xyz, sites, spatial)) {
      if (idx_b <= idx_a) continue

      const [x2, y2, z2] = sites[idx_b].xyz
      const majority_b = get_majority_species(sites[idx_b])
      const rb = majority_b.element ? covalent_radii.get(majority_b.element) : undefined

      const [dx, dy, dz] = [x2 - x1, y2 - y1, z2 - z1]
      const dist_sq = dx * dx + dy * dy + dz * dz
      const dist = Math.sqrt(dist_sq)

      if (dist_sq < min_dist_sq || dist_sq > max_dist_sq || !ra || !rb) continue

      const avg_r = (ra + rb) / 2.0
      const face_area = Math.PI * avg_r * avg_r
      const solid_angle = face_area / dist_sq

      if (solid_angle < min_solid_angle || face_area < min_face_area) continue

      const dist_penalty = Math.exp(-((dist / (ra + rb) - 1) ** 2) / 0.4)
      const angle_strength = Math.min(solid_angle / (4.0 * Math.PI), 1.0)
      const strength = angle_strength * dist_penalty

      if (strength > strength_threshold) {
        bonds.push({
          pos_1: sites[idx_a].xyz,
          pos_2: sites[idx_b].xyz,
          site_idx_1: idx_a,
          site_idx_2: idx_b,
          bond_length: dist,
          strength,
          transform_matrix: compute_bond_transform(sites[idx_a].xyz, sites[idx_b].xyz),
          jimage: [0, 0, 0],
        })
      }
    }
  }
  return bonds
}

export function atom_radii(
  structure: AnyStructure,
  {
    max_distance = 5.0,
    min_bond_dist = 0.4,
    tolerance = 0.3, // Tolerance in Angstroms for bond distance (increased from 0.05 for better detection)
  } = {},
): BondPair[] {
  const { sites } = structure
  if (sites.length < 2) return []

  const bonds: BondPair[] = [] // Store results here
  const min_dist_sq = min_bond_dist ** 2
  const max_dist_sq = max_distance ** 2
  const spatial = setup_spatial_grid(sites, max_distance)

  for (let idx_a = 0; idx_a < sites.length - 1; idx_a++) {
    const [x1, y1, z1] = sites[idx_a].xyz
    const majority_a = get_majority_species(sites[idx_a])
    const covalent_radius_a = majority_a.element
      ? covalent_radii_data[majority_a.element]?.covalent_radius_pm / 100
      : undefined

    for (const idx_b of get_candidates(sites[idx_a].xyz, sites, spatial)) {
      if (idx_b <= idx_a) continue

      const [x2, y2, z2] = sites[idx_b].xyz
      const majority_b = get_majority_species(sites[idx_b])
      const covalent_radius_b = majority_b.element
        ? covalent_radii_data[majority_b.element]?.covalent_radius_pm / 100
        : undefined

      // Skip if either radius is undefined
      if (!covalent_radius_a || !covalent_radius_b) continue

      const [dx, dy, dz] = [x2 - x1, y2 - y1, z2 - z1]
      const dist_sq = dx * dx + dy * dy + dz * dz
      const dist = Math.sqrt(dist_sq)

      // Check basic distance constraints
      if (dist_sq < min_dist_sq || dist_sq > max_dist_sq) continue

      const expected = covalent_radius_a + covalent_radius_b
      const lower_bound = expected - tolerance
      const upper_bound = expected + tolerance

      if (dist >= lower_bound && dist <= upper_bound) {
        bonds.push({
          pos_1: sites[idx_a].xyz,
          pos_2: sites[idx_b].xyz,
          site_idx_1: idx_a,
          site_idx_2: idx_b,
          bond_length: dist,
          strength: 1.0,
          transform_matrix: compute_bond_transform(sites[idx_a].xyz, sites[idx_b].xyz),
          jimage: [0, 0, 0],
        })
      }
    }
  }
  return bonds
}

// --- Hydrogen bond detection (Baker-Hubbard criteria) ---

/** Elements that can act as H-bond donors or acceptors */
const HBOND_ATOMS = new Set([`N`, `O`, `F`, `S`, `Cl`])

/**
 * Detect hydrogen bonds using Baker-Hubbard criteria:
 * - D-H···A pattern where D and A are electronegative atoms (N, O, F, S, Cl)
 * - H···A distance < max_ha_distance (default 2.5 Å)
 * - D···A distance < max_da_distance (default 3.5 Å)
 * - D-H···A angle > min_angle (default 120°)
 *
 * @param structure - The structure to analyze
 * @param covalent_bonds - Pre-computed covalent bonds (needed to identify D-H pairs)
 * @param options - H-bond detection thresholds
 * @returns Array of BondPair with bond_type: 'hydrogen'
 */
export function detect_hydrogen_bonds(
  structure: AnyStructure,
  covalent_bonds: BondPair[],
  { max_ha_distance = 2.5, max_da_distance = 3.5, min_angle = 120 }: HBondOptions = {},
): BondPair[] {
  const sites = structure?.sites
  if (!sites || sites.length === 0) return []

  // Build map: H atom index → donor atom index (from covalent bonds)
  // A hydrogen can be bonded to multiple atoms in rare cases; we track all.
  const h_donor_map = new Map<number, number[]>()
  for (const bond of covalent_bonds) {
    const elem_1 = get_majority_species(sites[bond.site_idx_1])?.element
    const elem_2 = get_majority_species(sites[bond.site_idx_2])?.element
    if (!elem_1 || !elem_2) continue

    if (elem_1 === `H` && HBOND_ATOMS.has(elem_2)) {
      const donors = h_donor_map.get(bond.site_idx_1) ?? []
      donors.push(bond.site_idx_2)
      h_donor_map.set(bond.site_idx_1, donors)
    } else if (elem_2 === `H` && HBOND_ATOMS.has(elem_1)) {
      const donors = h_donor_map.get(bond.site_idx_2) ?? []
      donors.push(bond.site_idx_1)
      h_donor_map.set(bond.site_idx_2, donors)
    }
  }

  if (h_donor_map.size === 0) return []

  // Find all acceptor atom indices
  const acceptor_indices: number[] = []
  for (let idx = 0; idx < sites.length; idx++) {
    const elem = get_majority_species(sites[idx])?.element
    if (elem && HBOND_ATOMS.has(elem)) acceptor_indices.push(idx)
  }

  if (acceptor_indices.length === 0) return []

  // Build spatial grid for acceptor atoms (cell size = max_da_distance)
  const cell_size = max_da_distance
  const inv_cell = 1.0 / cell_size
  const grid = new Map<string, number[]>()

  for (const idx of acceptor_indices) {
    const [x, y, z] = sites[idx].xyz
    const key = `${Math.floor(x * inv_cell)},${Math.floor(y * inv_cell)},${Math.floor(z * inv_cell)}`
    const cell = grid.get(key) ?? []
    cell.push(idx)
    grid.set(key, cell)
  }

  const max_ha_sq = max_ha_distance * max_ha_distance
  const max_da_sq = max_da_distance * max_da_distance
  const min_angle_rad = (min_angle * Math.PI) / 180

  const hbonds: BondPair[] = []
  // Track unique H-bond pairs to avoid duplicates
  const seen = new Set<string>()

  for (const [h_idx, donor_indices] of h_donor_map) {
    const h_pos = sites[h_idx].xyz
    const [hx, hy, hz] = h_pos

    // Search neighboring cells around the H atom
    const cx = Math.floor(hx * inv_cell)
    const cy = Math.floor(hy * inv_cell)
    const cz = Math.floor(hz * inv_cell)

    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          const cell = grid.get(`${cx + di},${cy + dj},${cz + dk}`)
          if (!cell) continue

          for (const a_idx of cell) {
            // Acceptor must not be the H itself or any of its donors
            if (a_idx === h_idx || donor_indices.includes(a_idx)) continue

            const a_pos = sites[a_idx].xyz
            const [ax, ay, az] = a_pos

            // H···A distance check
            const ha_dx = ax - hx, ha_dy = ay - hy, ha_dz = az - hz
            const ha_dist_sq = ha_dx * ha_dx + ha_dy * ha_dy + ha_dz * ha_dz
            if (ha_dist_sq > max_ha_sq) continue

            // Check each donor for this H
            for (const d_idx of donor_indices) {
              const d_pos = sites[d_idx].xyz
              const [ddx, ddy, ddz] = d_pos

              // D···A distance check
              const da_dx = ax - ddx, da_dy = ay - ddy, da_dz = az - ddz
              const da_dist_sq = da_dx * da_dx + da_dy * da_dy + da_dz * da_dz
              if (da_dist_sq > max_da_sq) continue

              // D-H···A angle check (angle at H)
              // Vector H→D and H→A
              const hd_x = ddx - hx, hd_y = ddy - hy, hd_z = ddz - hz
              const ha_len = Math.sqrt(ha_dist_sq)
              const hd_len = Math.sqrt(hd_x * hd_x + hd_y * hd_y + hd_z * hd_z)
              if (ha_len < 1e-8 || hd_len < 1e-8) continue

              const cos_angle = (hd_x * ha_dx + hd_y * ha_dy + hd_z * ha_dz) / (hd_len * ha_len)
              const angle = Math.acos(Math.max(-1, Math.min(1, cos_angle)))

              if (angle < min_angle_rad) continue

              // Deduplicate: use H-A pair (not D-A) so two H atoms on the
              // same donor can each form their own H-bond with the same acceptor
              const pair_key = h_idx < a_idx ? `${h_idx}-${a_idx}` : `${a_idx}-${h_idx}`
              if (seen.has(pair_key)) continue
              seen.add(pair_key)

              const da_dist = Math.sqrt(da_dist_sq)

              // Draw dashed line from H to A (not D to A) — the covalent
              // D-H bond is already rendered as a regular bond
              hbonds.push({
                pos_1: h_pos,
                pos_2: a_pos,
                site_idx_1: h_idx,
                site_idx_2: a_idx,
                bond_length: da_dist,
                strength: 1.0 - (da_dist / max_da_distance), // quality metric
                transform_matrix: compute_bond_transform(h_pos, a_pos),
                bond_type: `hydrogen`,
                jimage: [0, 0, 0],
              })
            }
          }
        }
      }
    }
  }

  return hbonds
}

/**
 * Miller Slab Generation with Coordinate System Reorientation
 *
 * This module implements crystallographic operations to generate slab surfaces
 * from bulk crystals based on Miller indices (h, k, l).
 *
 * Key feature: The final slab coordinate system has:
 * - Z axis perpendicular to the (hkl) plane (surface normal)
 * - X, Y axes in the (hkl) plane (surface-parallel)
 * - Vacuum added in the Z direction
 */

import type { PymatgenStructure, Site, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import {
  cartesian_to_fractional,
  fractional_to_cartesian,
  matrix_to_params,
} from './lattice-ops'

export type MillerIndex = [number, number, number]

// Growth mode for slab thickness direction
export type GrowthMode = 'centered' | 'anchor_minus_z' | 'anchor_plus_z'

// Periodic layer information for infinite layer support
export interface PeriodicLayerInfo {
  detected_layers: AtomLayer[]
  repeat_period: number // Distance of one periodic repeat along normal
  base_layer_count: number // Number of layers in one period
  is_periodic: boolean // Whether periodicity was detected
}

// Atom with its visibility state for animation
export interface AtomVisibility {
  site_idx: number
  inside_slab: boolean
  distance_to_plane: number // Signed distance to cutting plane center
  opacity: number // 0-1 for fade animation
  saturation: number // 0-1 for gray-out animation
}

// Cutting plane configuration
export interface CuttingPlaneConfig {
  miller_index: MillerIndex
  offset: number // Distance along normal from origin
  thickness: number // Slab thickness (0 = single plane cut)
  vacuum: number // Vacuum layer thickness
  growth_mode?: GrowthMode // How thickness grows from offset (default: 'centered')
}

// Preview info for UI display
export interface SlabPreview {
  normal: Vec3 // Surface normal in Cartesian coords
  d_spacing: number // Interplanar spacing
  plane_center: Vec3 // Center point of cutting plane
  lower_bound: number // Lower cutting distance
  upper_bound: number // Upper cutting distance
  atoms_inside: number // Count of atoms inside slab
  atoms_outside: number // Count of atoms outside slab
  surface_area: number // Surface area of cutting plane
  atom_visibility: AtomVisibility[] // Per-atom visibility info
}

// ============================================================================
// Core Crystallography Functions
// ============================================================================

/**
 * Compute greatest common divisor
 */
function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a))
  b = Math.abs(Math.round(b))
  while (b !== 0) {
    const t = b
    b = a % b
    a = t
  }
  return a || 1
}

/**
 * Normalize Miller indices by GCD
 */
export function normalize_miller(hkl: MillerIndex): MillerIndex {
  const [h, k, l] = hkl
  if (h === 0 && k === 0 && l === 0) return [0, 0, 1] // Default to (001)
  const divisor = gcd(gcd(Math.abs(h), Math.abs(k)), Math.abs(l))
  return [h / divisor, k / divisor, l / divisor]
}

/**
 * Validate Miller index
 */
export function validate_miller(hkl: MillerIndex): boolean {
  return !(hkl[0] === 0 && hkl[1] === 0 && hkl[2] === 0)
}

/**
 * Compute reciprocal lattice vectors (crystallographic convention, no 2π)
 *
 * a* = (b × c) / V
 * b* = (c × a) / V
 * c* = (a × b) / V
 *
 * Note: This is internal to miller-slab. For general use, import from '$lib/brillouin'.
 */
function reciprocal_lattice(lattice: Matrix3x3): Matrix3x3 {
  const [a, b, c] = lattice

  const b_cross_c = math.cross_3d(b, c)
  const volume = math.dot(a, b_cross_c) as number

  if (Math.abs(volume) < math.EPS) {
    throw new Error('Lattice has zero volume')
  }

  const c_cross_a = math.cross_3d(c, a)
  const a_cross_b = math.cross_3d(a, b)

  return [
    math.scale(b_cross_c, 1 / volume),
    math.scale(c_cross_a, 1 / volume),
    math.scale(a_cross_b, 1 / volume),
  ]
}

/**
 * Convert Miller index to surface normal (unit vector in Cartesian coords)
 *
 * G_hkl = h*a* + k*b* + l*c*
 */
export function miller_to_normal(hkl: MillerIndex, lattice: Matrix3x3): Vec3 {
  const [h, k, l] = hkl
  const [a_star, b_star, c_star] = reciprocal_lattice(lattice)

  const G: Vec3 = [
    h * a_star[0] + k * b_star[0] + l * c_star[0],
    h * a_star[1] + k * b_star[1] + l * c_star[1],
    h * a_star[2] + k * b_star[2] + l * c_star[2],
  ]

  const len = Math.hypot(...G)
  if (len < math.EPS) return [0, 0, 1]

  return [G[0] / len, G[1] / len, G[2] / len]
}

/**
 * Compute d-spacing for Miller index: d_hkl = 1 / |G_hkl|
 */
export function compute_d_spacing(hkl: MillerIndex, lattice: Matrix3x3): number {
  const [h, k, l] = hkl
  const [a_star, b_star, c_star] = reciprocal_lattice(lattice)

  const G: Vec3 = [
    h * a_star[0] + k * b_star[0] + l * c_star[0],
    h * a_star[1] + k * b_star[1] + l * c_star[1],
    h * a_star[2] + k * b_star[2] + l * c_star[2],
  ]

  const len = Math.hypot(...G)
  return len > math.EPS ? 1 / len : Infinity
}

/**
 * Get structure bounds along a direction
 */
export function get_bounds_along_normal(
  structure: PymatgenStructure,
  normal: Vec3,
): [number, number] {
  if (!structure?.sites?.length) return [0, 0]

  let min = Infinity
  let max = -Infinity

  for (const site of structure.sites) {
    const dist = site.xyz[0] * normal[0] + site.xyz[1] * normal[1] +
      site.xyz[2] * normal[2]
    if (dist < min) min = dist
    if (dist > max) max = dist
  }

  return [min, max]
}

// ============================================================================
// Cutting Plane & Atom Visibility
// ============================================================================

/**
 * Compute lower and upper bounds based on growth mode
 *
 * - anchor_minus_z (default): upper = offset, lower = offset - thickness
 *   (surface stays fixed at offset, slab grows into -Z direction)
 * - anchor_plus_z: lower = offset, upper = offset + thickness
 *   (bottom stays fixed at offset, slab grows into +Z direction)
 * - centered: lower = offset - thickness/2, upper = offset + thickness/2
 *   (slab grows symmetrically from center)
 */
export function compute_slab_bounds(
  offset: number,
  thickness: number,
  growth_mode: GrowthMode = 'centered',
): { lower: number; upper: number } {
  switch (growth_mode) {
    case 'anchor_minus_z':
      return { lower: offset - thickness, upper: offset }
    case 'anchor_plus_z':
      return { lower: offset, upper: offset + thickness }
    case 'centered':
    default:
      return { lower: offset - thickness / 2, upper: offset + thickness / 2 }
  }
}

/**
 * Calculate signed distance from point to plane
 */
export function signed_distance_to_plane(
  point: Vec3,
  normal: Vec3,
  plane_offset: number,
): number {
  return point[0] * normal[0] + point[1] * normal[1] + point[2] * normal[2] - plane_offset
}

/**
 * Compute atom visibility for cutting preview
 */
export function compute_atom_visibility(
  structure: PymatgenStructure,
  normal: Vec3,
  offset: number,
  thickness: number,
  growth_mode: GrowthMode = 'centered',
): AtomVisibility[] {
  if (!structure?.sites) return []

  // Lower and upper bounds of slab region based on growth mode
  const { lower, upper } = compute_slab_bounds(offset, thickness, growth_mode)

  return structure.sites.map((site, idx) => {
    const dist = site.xyz[0] * normal[0] + site.xyz[1] * normal[1] +
      site.xyz[2] * normal[2]

    const inside = thickness > 0 ? (dist >= lower && dist <= upper) : dist >= offset // Single plane: keep atoms above offset

    return {
      site_idx: idx,
      inside_slab: inside,
      distance_to_plane: dist - offset,
      opacity: inside ? 1.0 : 1.0, // Will be animated by UI
      saturation: inside ? 1.0 : 1.0,
    }
  })
}

/**
 * Compute full slab preview info
 */
export function compute_slab_preview(
  structure: PymatgenStructure,
  config: CuttingPlaneConfig,
): SlabPreview {
  const lattice = structure.lattice.matrix as Matrix3x3
  const normal = miller_to_normal(config.miller_index, lattice)
  const d_spacing = compute_d_spacing(config.miller_index, lattice)
  const growth_mode = config.growth_mode ?? 'centered'

  // Get structure bounds
  const [min_dist, max_dist] = get_bounds_along_normal(structure, normal)

  // Compute plane center position
  const plane_center: Vec3 = [
    normal[0] * config.offset,
    normal[1] * config.offset,
    normal[2] * config.offset,
  ]

  // Cutting bounds based on growth mode
  const { lower, upper } = compute_slab_bounds(
    config.offset,
    config.thickness,
    growth_mode,
  )

  // Compute atom visibility
  const atom_visibility = compute_atom_visibility(
    structure,
    normal,
    config.offset,
    config.thickness,
    growth_mode,
  )

  const atoms_inside = atom_visibility.filter((a) => a.inside_slab).length
  const atoms_outside = atom_visibility.length - atoms_inside

  // Compute surface area (approximation using lattice vectors projected onto plane)
  const surface_area = compute_surface_area(lattice, normal)

  return {
    normal,
    d_spacing,
    plane_center,
    lower_bound: lower,
    upper_bound: upper,
    atoms_inside,
    atoms_outside,
    surface_area,
    atom_visibility,
  }
}

/**
 * Compute surface area of cutting plane
 */
function compute_surface_area(lattice: Matrix3x3, normal: Vec3): number {
  const [a, b, c] = lattice

  // Project lattice vectors onto plane
  const project = (v: Vec3): Vec3 => {
    const dot = v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2]
    return [
      v[0] - dot * normal[0],
      v[1] - dot * normal[1],
      v[2] - dot * normal[2],
    ]
  }

  const projections = [
    { vec: project(a), len: 0 },
    { vec: project(b), len: 0 },
    { vec: project(c), len: 0 },
  ]

  for (const p of projections) {
    p.len = Math.hypot(...p.vec)
  }

  projections.sort((x, y) => y.len - x.len)

  if (projections[0].len < math.EPS) return 0

  const v1 = projections[0].vec
  const v2 = projections[1].len > math.EPS ? projections[1].vec : projections[2].vec

  const cross = math.cross_3d(v1, v2)
  return Math.hypot(...cross)
}

// ============================================================================
// Coordinate System Transformation
// ============================================================================

/**
 * Find two linearly independent in-plane lattice vectors for a Miller index.
 * These vectors lie in the (hkl) plane and span the 2D surface lattice.
 */
export function find_in_plane_vectors(
  hkl: MillerIndex,
  lattice: Matrix3x3,
): [Vec3, Vec3] {
  const [h, k, l] = hkl
  const [a, b, c] = lattice

  // Search for lattice vectors that lie in the plane
  // A vector R = n1*a + n2*b + n3*c lies in (hkl) plane if h*n1 + k*n2 + l*n3 = 0

  const candidates: { vec: Vec3; len: number; n: [number, number, number] }[] = []

  // Search range for integer combinations
  const max_n = 3

  for (let n1 = -max_n; n1 <= max_n; n1++) {
    for (let n2 = -max_n; n2 <= max_n; n2++) {
      for (let n3 = -max_n; n3 <= max_n; n3++) {
        if (n1 === 0 && n2 === 0 && n3 === 0) continue

        // Check if this vector lies in the plane
        if (h * n1 + k * n2 + l * n3 !== 0) continue

        const vec: Vec3 = [
          n1 * a[0] + n2 * b[0] + n3 * c[0],
          n1 * a[1] + n2 * b[1] + n3 * c[1],
          n1 * a[2] + n2 * b[2] + n3 * c[2],
        ]

        const len = Math.hypot(...vec)
        if (len > math.EPS) {
          candidates.push({ vec, len, n: [n1, n2, n3] })
        }
      }
    }
  }

  // Sort by length
  candidates.sort((x, y) => x.len - y.len)

  // Find two linearly independent vectors
  if (candidates.length < 2) {
    // Fallback: use orthogonal vectors if no lattice vectors found
    const normal = miller_to_normal(hkl, lattice)
    return find_orthogonal_basis(normal)
  }

  const v1 = candidates[0].vec

  // Find second vector that's not parallel to v1
  for (let i = 1; i < candidates.length; i++) {
    const v2 = candidates[i].vec
    const cross = math.cross_3d(v1, v2)
    const cross_len = Math.hypot(...cross)

    if (cross_len > math.EPS * candidates[0].len * candidates[i].len) {
      return [v1, v2]
    }
  }

  // Fallback
  const normal = miller_to_normal(hkl, lattice)
  return find_orthogonal_basis(normal)
}

/**
 * Find two orthogonal vectors perpendicular to the given normal
 */
function find_orthogonal_basis(normal: Vec3): [Vec3, Vec3] {
  // Find a vector not parallel to normal
  let seed: Vec3 = [1, 0, 0]
  if (Math.abs(normal[0]) > 0.9) {
    seed = [0, 1, 0]
  }

  // v1 = seed - (seed · normal) * normal
  const dot = seed[0] * normal[0] + seed[1] * normal[1] + seed[2] * normal[2]
  const v1: Vec3 = [
    seed[0] - dot * normal[0],
    seed[1] - dot * normal[1],
    seed[2] - dot * normal[2],
  ]
  const len1 = Math.hypot(...v1)
  if (len1 < math.EPS) {
    // Fallback: return standard basis vectors
    console.warn('[miller-slab] find_orthogonal_basis: v1 has zero length')
    return [[1, 0, 0], [0, 1, 0]]
  }
  const v1_norm: Vec3 = [v1[0] / len1, v1[1] / len1, v1[2] / len1]

  // v2 = normal × v1
  const v2 = math.cross_3d(normal, v1_norm)
  const len2 = Math.hypot(...v2)
  if (len2 < math.EPS) {
    console.warn('[miller-slab] find_orthogonal_basis: v2 has zero length')
    return [v1_norm, [0, 0, 1]]
  }

  return [v1_norm, v2]
}

/**
 * Apply Gaussian lattice reduction to get shorter, more orthogonal basis vectors
 */
export function gaussian_reduce_2d(v1: Vec3, v2: Vec3): [Vec3, Vec3] {
  let a = [...v1] as Vec3
  let b = [...v2] as Vec3

  for (let iter = 0; iter < 100; iter++) {
    const len_a = Math.hypot(...a)
    const len_b = Math.hypot(...b)

    // Ensure |a| <= |b|
    if (len_a > len_b) {
      ;[a, b] = [b, a]
    }

    // Reduce b by a
    const dot_ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const dot_aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2]

    if (dot_aa < math.EPS) break

    const mu = Math.round(dot_ab / dot_aa)
    if (mu === 0) break

    b = [b[0] - mu * a[0], b[1] - mu * a[1], b[2] - mu * a[2]]
  }

  return [a, b]
}

/**
 * Build rotation matrix that transforms coordinates so that:
 * - New Z axis is the surface normal (perpendicular to hkl plane)
 * - New X, Y axes are in the hkl plane
 *
 * Returns a 3x3 rotation matrix R where R * old_coords = new_coords
 */
export function build_slab_rotation_matrix(
  hkl: MillerIndex,
  lattice: Matrix3x3,
): Matrix3x3 {
  const normal = miller_to_normal(hkl, lattice)

  // Find in-plane vectors
  let [v1, v2] = find_in_plane_vectors(hkl, lattice) // Reduce to get better basis
  ;[v1, v2] = gaussian_reduce_2d(v1, v2)

  // Normalize v1 as new X axis
  const len1 = Math.hypot(...v1)
  if (len1 < math.EPS) {
    // Fallback: v1 is zero, use standard basis
    console.warn('[miller-slab] v1 has zero length, using fallback basis')
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  }
  const new_x: Vec3 = [v1[0] / len1, v1[1] / len1, v1[2] / len1]

  // new_y = normal × new_x (ensures right-handed system)
  const new_y = math.cross_3d(normal, new_x)
  const len_y = Math.hypot(...new_y)
  if (len_y < math.EPS) {
    // Fallback: cross product is zero (normal parallel to new_x)
    console.warn('[miller-slab] new_y has zero length, using fallback')
    // Find alternative perpendicular vector
    const alt_seed: Vec3 = Math.abs(new_x[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0]
    const alt_y = math.cross_3d(normal, alt_seed)
    const alt_len = Math.hypot(...alt_y)
    if (alt_len < math.EPS) {
      return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    }
    const new_y_norm: Vec3 = [alt_y[0] / alt_len, alt_y[1] / alt_len, alt_y[2] / alt_len]
    return [new_x, new_y_norm, normal]
  }
  const new_y_norm: Vec3 = [new_y[0] / len_y, new_y[1] / len_y, new_y[2] / len_y]

  // Rotation matrix: rows are the new basis vectors expressed in old coords
  // To transform a point: R * point = point in new coords
  return [new_x, new_y_norm, normal]
}

/**
 * Ensure slab in-plane vectors form a right-handed coordinate system with +z.
 * For a slab where c points along +z, checks that (a × b) · z > 0.
 * If left-handed, negates b to restore right-handedness.
 * @returns [corrected_b, was_flipped] tuple
 */
export function ensure_slab_right_handed(a: Vec3, b: Vec3): [Vec3, boolean] {
  const cross_z = a[0] * b[1] - a[1] * b[0]
  if (cross_z < 0) {
    return [[-b[0], -b[1], -b[2]], true]
  }
  return [b, false]
}

// ============================================================================
// Slab Generation - Core Helper Functions
// ============================================================================

/**
 * Wrap a value to [0, 1) range
 */
function wrap_to_unit(x: number): number {
  const wrapped = x - Math.floor(x)
  // Handle floating point edge case where x is exactly 1.0
  return wrapped >= 1.0 ? 0.0 : wrapped
}

/**
 * Rotate a point by a rotation matrix
 */
function rotate_point(p: Vec3, R: Matrix3x3): Vec3 {
  return [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2],
  ]
}

/**
 * 2D fractional coordinate conversion (only XY plane)
 * Converts Cartesian XY coordinates to fractional coordinates in the a-b plane
 */
function cartesian_to_fractional_2d(xyz: Vec3, a: Vec3, b: Vec3): [number, number] {
  // 2x2 matrix inversion for XY plane
  const det = a[0] * b[1] - a[1] * b[0]
  if (Math.abs(det) < 1e-10) {
    return [0, 0]
  }
  const frac_x = (xyz[0] * b[1] - xyz[1] * b[0]) / det
  const frac_y = (-xyz[0] * a[1] + xyz[1] * a[0]) / det
  return [frac_x, frac_y]
}

/**
 * Reduce in-plane lattice to primitive 2D surface cell.
 *
 * Same algorithm as the Rust reduce_slab_in_plane_primitive:
 * 1. Group atoms by z-layer, pick the largest layer
 * 2. Compute inter-atomic translation vectors (candidate primitive lattice vectors)
 * 3. Find the shortest pair with minimal area that tiles the original cell
 * 4. Verify all layer atoms are integer combinations of the new basis (Cramer's rule)
 * 5. Remap all atoms into the new cell
 */
function reduce_in_plane_primitive<
  T extends { abc: Vec3; xyz: Vec3; species?: Array<{ element?: string }> },
>(
  sites: T[], a: Vec3, b: Vec3,
): { new_a: Vec3; new_b: Vec3; sites: T[] } | null {
  const cross_z = a[0] * b[1] - a[1] * b[0]
  const orig_area = Math.abs(cross_z)
  if (orig_area < 1e-10) return null

  // Group by z-layer
  const z_tol = 0.01
  const layers: number[][] = []
  for (let i = 0; i < sites.length; i++) {
    const z = sites[i].abc[2]
    let found = false
    for (const layer of layers) {
      const lz = sites[layer[0]].abc[2]
      if (Math.abs(z - lz) < z_tol || Math.abs(z - lz - 1) < z_tol || Math.abs(z - lz + 1) < z_tol) {
        layer.push(i)
        found = true
        break
      }
    }
    if (!found) layers.push([i])
  }

  // Pick layer with most atoms; break ties by lowest z (stable across layer count changes)
  const largest = layers.reduce((best, l) => {
    if (l.length > best.length) return l
    if (l.length === best.length && sites[l[0]].abc[2] < sites[best[0]].abc[2]) return l
    return best
  }, layers[0])
  if (largest.length < 2) return null

  // Collect candidate vectors from inter-atomic distances
  const ref = sites[largest[0]]
  const candidates: Vec3[] = []
  for (let k = 1; k < largest.length; k++) {
    const s = sites[largest[k]]
    let da = s.abc[0] - ref.abc[0]
    let db = s.abc[1] - ref.abc[1]
    da -= Math.round(da)
    db -= Math.round(db)
    const cx = a[0] * da + b[0] * db
    const cy = a[1] * da + b[1] * db
    if (Math.abs(cx) > 1e-6 || Math.abs(cy) > 1e-6) {
      candidates.push([cx, cy, 0])
    }
  }
  // Add original vectors and combinations
  for (const v of [a, b, [-a[0],-a[1],0] as Vec3, [-b[0],-b[1],0] as Vec3,
    [a[0]+b[0],a[1]+b[1],0] as Vec3, [a[0]-b[0],a[1]-b[1],0] as Vec3]) {
    candidates.push(v)
  }
  // Periodic images
  const base_len = candidates.length
  for (let i = 0; i < base_len; i++) {
    const v = candidates[i]
    for (const s of [a, [-a[0],-a[1],0] as Vec3, b, [-b[0],-b[1],0] as Vec3,
      [a[0]+b[0],a[1]+b[1],0] as Vec3, [a[0]-b[0],a[1]-b[1],0] as Vec3]) {
      const shifted: Vec3 = [v[0]+s[0], v[1]+s[1], 0]
      if (Math.hypot(shifted[0], shifted[1]) > 1e-6) candidates.push(shifted)
    }
  }

  // Sort by length, deduplicate
  candidates.sort((x, y) => Math.hypot(x[0],x[1]) - Math.hypot(y[0],y[1]))
  const unique: Vec3[] = []
  for (const v of candidates) {
    if (!unique.some(u => Math.hypot(v[0]-u[0], v[1]-u[1]) < 1e-4)) unique.push(v)
  }

  // A candidate in-plane vector is only a real surface lattice translation if
  // shifting every atom by it lands on an atom of the SAME species. Geometry
  // alone is not enough: in e.g. rocksalt (110) a glide of c/2 maps the cation
  // sublattice onto the anion sublattice, which is a position-preserving but
  // species-swapping operation. Accepting it would halve the cell and then the
  // remap dedup would delete one whole species (all-cation/all-anion slab).
  const det_ab = a[0]*b[1] - a[1]*b[0]
  const el_of = (s: T) => s.species?.[0]?.element ?? ''
  const FRAC_TOL = 2e-3
  const is_lattice_translation = (t: Vec3): boolean => {
    if (Math.abs(det_ab) < 1e-12) return false
    for (const s of sites) {
      const sx = a[0]*s.abc[0] + b[0]*s.abc[1] + t[0]
      const sy = a[1]*s.abc[0] + b[1]*s.abc[1] + t[1]
      let fa = (sx*b[1] - sy*b[0]) / det_ab
      let fb = (-sx*a[1] + sy*a[0]) / det_ab
      fa -= Math.floor(fa); fb -= Math.floor(fb)
      const el = el_of(s), z = s.abc[2]
      const matched = sites.some((o) => {
        if (el_of(o) !== el) return false
        if (Math.abs(o.abc[2] - z) > 0.01) return false
        const oa = o.abc[0] - Math.floor(o.abc[0])
        const ob = o.abc[1] - Math.floor(o.abc[1])
        const da = Math.abs(fa - oa), db = Math.abs(fb - ob)
        return Math.min(da, 1 - da) < FRAC_TOL && Math.min(db, 1 - db) < FRAC_TOL
      })
      if (!matched) return false
    }
    return true
  }
  const trans_memo = new Map<string, boolean>()
  const is_translation = (v: Vec3): boolean => {
    const key = `${v[0].toFixed(4)},${v[1].toFixed(4)}`
    let r = trans_memo.get(key)
    if (r === undefined) { r = is_lattice_translation(v); trans_memo.set(key, r) }
    return r
  }

  // Find shortest pair with minimal area
  let best_a = a, best_b = b, best_area = orig_area, found = false
  const limit = Math.min(unique.length, 80)
  for (let i = 0; i < limit; i++) {
    const va = unique[i]
    if (!is_translation(va)) continue
    for (let j = i + 1; j < limit; j++) {
      const vb = unique[j]
      const area = Math.abs(va[0]*vb[1] - va[1]*vb[0])
      if (area < 1e-10 || area >= best_area - 1e-10) continue
      const ratio = orig_area / area
      if (Math.abs(ratio - Math.round(ratio)) > 0.1) continue
      if (!is_translation(vb)) continue
      // Verify all layer atoms are integer combos of (va, vb)
      const va2 = va[0]*va[0]+va[1]*va[1], vab = va[0]*vb[0]+va[1]*vb[1], vb2 = vb[0]*vb[0]+vb[1]*vb[1]
      const det = va2*vb2 - vab*vab
      if (Math.abs(det) < 1e-20) continue
      let valid = true
      for (let k = 1; k < largest.length; k++) {
        const s = sites[largest[k]]
        let da = s.abc[0] - ref.abc[0], db = s.abc[1] - ref.abc[1]
        da -= Math.round(da); db -= Math.round(db)
        const tx = a[0]*da + b[0]*db, ty = a[1]*da + b[1]*db
        const tdva = tx*va[0]+ty*va[1], tdvb = tx*vb[0]+ty*vb[1]
        const n1 = (tdva*vb2 - tdvb*vab)/det, n2 = (va2*tdvb - vab*tdva)/det
        if (Math.abs(n1-Math.round(n1)) > 0.05 || Math.abs(n2-Math.round(n2)) > 0.05) { valid = false; break }
      }
      if (valid) { best_a = va; best_b = vb; best_area = area; found = true }
    }
  }

  if (!found) return null

  // Standardize basis: ensure right-handed (a × b > 0) and a is the shorter vector
  // pointing closest to +x. This makes the result deterministic regardless of
  // which layer or atom set was used for discovery.
  let cross_ab = best_a[0] * best_b[1] - best_a[1] * best_b[0]
  if (cross_ab < 0) {
    // Swap to make right-handed
    ;[best_a, best_b] = [best_b, best_a]
    cross_ab = -cross_ab
  }
  // Ensure a is shorter
  if (Math.hypot(best_a[0], best_a[1]) > Math.hypot(best_b[0], best_b[1]) + 1e-6) {
    ;[best_a, best_b] = [best_b, best_a]
    // Fix handedness again
    if (best_a[0] * best_b[1] - best_a[1] * best_b[0] < 0) {
      best_b = [-best_b[0], -best_b[1], 0]
    }
  }
  // Ensure a points into +x half-plane (deterministic direction)
  if (best_a[0] < -1e-6 || (Math.abs(best_a[0]) < 1e-6 && best_a[1] < 0)) {
    best_a = [-best_a[0], -best_a[1], 0]
    best_b = [-best_b[0], -best_b[1], 0]
  }

  // Remap atoms into primitive cell
  // Inverse of 2x2 [best_a, best_b] for xy → fractional conversion
  const det2 = best_a[0]*best_b[1] - best_a[1]*best_b[0]
  if (Math.abs(det2) < 1e-10) return null

  const new_sites: T[] = []
  for (const site of sites) {
    // Cartesian xy from old fractional
    const cx = a[0]*site.abc[0] + b[0]*site.abc[1]
    const cy = a[1]*site.abc[0] + b[1]*site.abc[1]
    // New fractional
    let nfa = (cx*best_b[1] - cy*best_b[0]) / det2
    let nfb = (-cx*best_a[1] + cy*best_a[0]) / det2
    nfa = nfa - Math.floor(nfa); nfb = nfb - Math.floor(nfb)
    if (nfa >= 1 - 1e-6) nfa = 0; if (nfb >= 1 - 1e-6) nfb = 0
    const nfc = site.abc[2]
    // Deduplicate (same position AND same species — never merge across species)
    const tol = 1e-3
    const dup = new_sites.some(e => {
      if (el_of(e) !== el_of(site)) return false
      const da = Math.abs(nfa - e.abc[0]), db = Math.abs(nfb - e.abc[1]), dc = Math.abs(nfc - e.abc[2])
      return Math.min(da, 1-da) < tol && Math.min(db, 1-db) < tol && dc < tol
    })
    if (!dup) {
      const new_xyz: Vec3 = [
        nfa*best_a[0] + nfb*best_b[0],
        nfa*best_a[1] + nfb*best_b[1],
        site.xyz[2],
      ]
      new_sites.push({ ...site, abc: [nfa, nfb, nfc] as Vec3, xyz: new_xyz })
    }
  }

  return { new_a: best_a, new_b: best_b, sites: new_sites }
}

/**
 * Compute slab window boundaries based on growth mode
 */
function compute_slab_window(
  offset: number,
  thickness: number,
  growth_mode: GrowthMode,
  _layers: AtomLayer[],
): { lower: number; upper: number; surface_z: number } {
  switch (growth_mode) {
    case 'anchor_minus_z':
      // Surface at offset, grow downward (-Z direction)
      return {
        lower: offset - thickness,
        upper: offset,
        surface_z: offset,
      }
    case 'anchor_plus_z':
      // Bottom at offset, grow upward (+Z direction)
      return {
        lower: offset,
        upper: offset + thickness,
        surface_z: offset + thickness,
      }
    case 'centered':
    default:
      return {
        lower: offset - thickness / 2,
        upper: offset + thickness / 2,
        surface_z: offset,
      }
  }
}

/**
 * Ensure sufficient layer coverage through lazy bulk replication
 * If current layers are insufficient, replicate the bulk along the normal direction
 */
function ensure_layer_coverage(
  structure: PymatgenStructure,
  rotated_a: Vec3,
  rotated_b: Vec3,
  current_layers: AtomLayer[],
  target_layers: number,
): { structure: PymatgenStructure; replication_count: number } {
  if (current_layers.length >= target_layers) {
    return { structure, replication_count: 1 }
  }

  // Calculate required replication count
  const replication_count = Math.ceil(target_layers / current_layers.length)

  // Estimate z-period from layer structure
  const sorted_layers = [...current_layers].sort((a, b) => a.distance - b.distance)
  const layer_span = sorted_layers.length > 1
    ? sorted_layers[sorted_layers.length - 1].distance - sorted_layers[0].distance
    : 0
  const avg_spacing = current_layers.length > 1
    ? layer_span / (current_layers.length - 1)
    : 2.0
  const z_period = layer_span + avg_spacing

  // Replicate sites along z direction
  const new_sites: Site[] = []
  for (let i = 0; i < replication_count; i++) {
    for (const site of structure.sites) {
      new_sites.push({
        ...site,
        xyz: [site.xyz[0], site.xyz[1], site.xyz[2] + i * z_period] as Vec3,
      })
    }
  }

  return {
    structure: { ...structure, sites: new_sites },
    replication_count,
  }
}

// Extended site with fractional XY information
interface SiteWithFracXY extends Site {
  frac_xy?: [number, number]
}

/**
 * Unified Slab Generation Pipeline
 * Both Preview and Apply use this function to ensure consistency
 *
 * Crystallographically correct pipeline:
 * 1. Build a supercell that covers the needed slab region along the normal
 * 2. Find in-plane surface lattice vectors (a_surf, b_surf)
 * 3. Build rotation matrix to align normal with +Z
 * 4. Rotate all atoms to slab coordinate frame
 * 5. Select atoms within the thickness window
 * 6. Wrap XY to surface unit cell [0,1)
 * 7. Remove duplicate atoms (same position after wrapping)
 * 8. Center slab with vacuum
 * 9. Build final slab lattice
 */
export function generate_slab_pipeline(
  structure: PymatgenStructure,
  config: CuttingPlaneConfig & {
    supercell?: [number, number]
    layer_mode?: boolean
    target_layers?: number
  },
): PymatgenStructure | null {
  const { miller_index, offset, thickness, vacuum, growth_mode = 'centered' } = config
  const [na, nb] = config.supercell ?? [1, 1]
  const old_lattice = structure.lattice.matrix as Matrix3x3
  const [a, b, c] = old_lattice

  // ========================================
  // Step 1: Build supercell to ensure complete slab coverage
  // ========================================
  // For any Miller plane, we need to replicate the bulk enough to capture
  // all atoms that should be in the slab. The replication factor depends on
  // the Miller indices and the desired thickness.

  const normal = miller_to_normal(miller_index, old_lattice)
  const d_spacing = compute_d_spacing(miller_index, old_lattice)

  // Calculate how many unit cell repeats we need along each direction
  // to cover the slab thickness plus some margin
  const required_thickness = thickness + d_spacing * 2 // Add margin

  // Project each lattice vector onto the normal to see how they contribute
  const a_proj = Math.abs(math.dot(a, normal) as number)
  const b_proj = Math.abs(math.dot(b, normal) as number)
  const c_proj = Math.abs(math.dot(c, normal) as number)

  // Determine replication factors (minimum of 1)
  const rep_a = a_proj > 0.1 ? Math.ceil(required_thickness / a_proj) + 1 : 1
  const rep_b = b_proj > 0.1 ? Math.ceil(required_thickness / b_proj) + 1 : 1
  const rep_c = c_proj > 0.1 ? Math.ceil(required_thickness / c_proj) + 1 : 1

  // Generate supercell atoms (include negative indices for complete coverage)
  const supercell_sites: Site[] = []
  for (let ia = -rep_a; ia <= rep_a; ia++) {
    for (let ib = -rep_b; ib <= rep_b; ib++) {
      for (let ic = -rep_c; ic <= rep_c; ic++) {
        for (const site of structure.sites) {
          const shift: Vec3 = [
            ia * a[0] + ib * b[0] + ic * c[0],
            ia * a[1] + ib * b[1] + ic * c[1],
            ia * a[2] + ib * b[2] + ic * c[2],
          ]
          const new_xyz: Vec3 = [
            site.xyz[0] + shift[0],
            site.xyz[1] + shift[1],
            site.xyz[2] + shift[2],
          ]
          supercell_sites.push({
            ...site,
            xyz: new_xyz,
          })
        }
      }
    }
  }

  // ========================================
  // Step 2: Find in-plane surface lattice vectors
  // ========================================
  let [v1, v2] = find_in_plane_vectors(miller_index, old_lattice)
  ;[v1, v2] = gaussian_reduce_2d(v1, v2)

  // ========================================
  // Step 3: Build rotation matrix (normal → +Z)
  // ========================================
  const R = build_slab_rotation_matrix(miller_index, old_lattice)

  // ========================================
  // Step 4: Rotate all atoms to slab frame
  // ========================================
  // In the slab frame: Z is normal to the Miller plane
  const rotated_sites = supercell_sites.map((site) => ({
    ...site,
    xyz: rotate_point(site.xyz, R),
  }))

  // Compute surface unit cell vectors in slab frame (should have Z≈0)
  const rotated_a_raw = rotate_point(v1, R)
  const rotated_b_raw = rotate_point(v2, R)

  // Explicitly set Z=0 for in-plane vectors
  const surf_a: Vec3 = [rotated_a_raw[0], rotated_a_raw[1], 0]
  let surf_b: Vec3 = [rotated_b_raw[0], rotated_b_raw[1], 0]

  // Ensure right-handed coordinate system: (surf_a × surf_b) · ẑ > 0
  ;[surf_b] = ensure_slab_right_handed(surf_a, surf_b)

  // ========================================
  // Step 5: Select atoms within thickness window
  // ========================================
  // Compute slab bounds based on growth mode
  const { lower, upper } = compute_slab_bounds(offset, thickness, growth_mode)

  const selected_sites = rotated_sites.filter((site) => {
    const z = site.xyz[2]
    return z >= lower - 0.01 && z <= upper + 0.01 // Small tolerance
  })

  if (selected_sites.length === 0) {
    console.warn('[miller-slab] No atoms in slab window [', lower, ',', upper, ']')
    return null
  }

  // ========================================
  // Step 6: Wrap XY to surface unit cell [0,1)
  // ========================================
  interface SiteWithFrac extends Site {
    frac_xy: [number, number]
  }

  const wrapped_sites: SiteWithFrac[] = selected_sites.map((site) => {
    const frac = cartesian_to_fractional_2d(site.xyz, surf_a, surf_b)
    const wrapped_frac_x = wrap_to_unit(frac[0])
    const wrapped_frac_y = wrap_to_unit(frac[1])

    // Compute wrapped Cartesian XY
    const wrapped_x = wrapped_frac_x * surf_a[0] + wrapped_frac_y * surf_b[0]
    const wrapped_y = wrapped_frac_x * surf_a[1] + wrapped_frac_y * surf_b[1]

    return {
      ...site,
      xyz: [wrapped_x, wrapped_y, site.xyz[2]] as Vec3,
      frac_xy: [wrapped_frac_x, wrapped_frac_y] as [number, number],
    }
  })

  // ========================================
  // Step 7: Remove duplicate atoms
  // ========================================
  // After wrapping, atoms from different image cells may overlap
  const DUPLICATE_TOL = 0.01 // Angstroms
  const unique_sites: SiteWithFrac[] = []

  for (const site of wrapped_sites) {
    let is_duplicate = false
    for (const existing of unique_sites) {
      const dx = Math.abs(site.xyz[0] - existing.xyz[0])
      const dy = Math.abs(site.xyz[1] - existing.xyz[1])
      const dz = Math.abs(site.xyz[2] - existing.xyz[2])
      // Also check if same element
      const same_element = site.species[0]?.element === existing.species[0]?.element
      if (
        dx < DUPLICATE_TOL && dy < DUPLICATE_TOL && dz < DUPLICATE_TOL && same_element
      ) {
        is_duplicate = true
        break
      }
    }
    if (!is_duplicate) {
      unique_sites.push(site)
    }
  }

  if (unique_sites.length === 0) {
    console.warn('[miller-slab] No unique atoms after duplicate removal')
    return null
  }

  // ========================================
  // Step 8: Center slab with vacuum
  // ========================================
  let min_z = Infinity, max_z = -Infinity
  for (const site of unique_sites) {
    if (site.xyz[2] < min_z) min_z = site.xyz[2]
    if (site.xyz[2] > max_z) max_z = site.xyz[2]
  }

  const slab_thickness_actual = max_z - min_z

  // Shift atoms: put bottom at z=vacuum/2
  const z_shift = -min_z + vacuum / 2

  const shifted_sites = unique_sites.map((site) => ({
    ...site,
    xyz: [site.xyz[0], site.xyz[1], site.xyz[2] + z_shift] as Vec3,
  }))

  // ========================================
  // Step 9: Build 1×1 slab, reduce to primitive, then apply supercell
  // ========================================
  const total_z = slab_thickness_actual + vacuum

  // Build 1×1 surface cell first
  const cell_1x1_a: Vec3 = [surf_a[0], surf_a[1], 0]
  const cell_1x1_b: Vec3 = [surf_b[0], surf_b[1], 0]
  const cell_1x1_c: Vec3 = [0, 0, total_z]
  const matrix_1x1: Matrix3x3 = [cell_1x1_a, cell_1x1_b, cell_1x1_c]

  let sites_1x1: (typeof shifted_sites[0] & { abc: Vec3 })[] = shifted_sites.map(site => ({
    ...site,
    abc: [site.frac_xy[0], site.frac_xy[1], wrap_to_unit(site.xyz[2] / total_z)] as Vec3,
  }))

  // Primitive reduction: find shortest in-plane translation vectors.
  // Only accept the reduction if the new vectors preserve the original
  // directions (both prim_a ∥ surf_a and prim_b ∥ surf_b within tolerance).
  // Reductions that rotate the lattice (e.g. rutile 001 → 45° primitive cell)
  // are rejected to keep the preview visually consistent with the cutting plane.
  const pre_cx = sites_1x1.reduce((s, p) => s + p.xyz[0], 0) / sites_1x1.length
  const pre_cy = sites_1x1.reduce((s, p) => s + p.xyz[1], 0) / sites_1x1.length

  let prim_a = cell_1x1_a
  let prim_b = cell_1x1_b
  const reduced = reduce_in_plane_primitive(sites_1x1, cell_1x1_a, cell_1x1_b)
  if (reduced) {
    // Check if reduced vectors preserve direction of original surface vectors.
    // Two vectors are "parallel" if the angle between them is < 15°.
    const cos_angle_2d = (u: Vec3, v: Vec3) => {
      const dot = u[0] * v[0] + u[1] * v[1]
      const lu = Math.hypot(u[0], u[1])
      const lv = Math.hypot(v[0], v[1])
      return lu > 1e-10 && lv > 1e-10 ? Math.abs(dot) / (lu * lv) : 0
    }
    const COS_15 = Math.cos(15 * Math.PI / 180) // ~0.966
    const a_parallel = cos_angle_2d(reduced.new_a, cell_1x1_a) > COS_15
    const b_parallel = cos_angle_2d(reduced.new_b, cell_1x1_b) > COS_15

    if (a_parallel && b_parallel) {
      prim_a = reduced.new_a
      prim_b = reduced.new_b
      sites_1x1 = reduced.sites

      // Re-center: shift primitive cell so xy center matches pre-reduction center
      const post_cx = sites_1x1.reduce((s, p) => s + p.xyz[0], 0) / sites_1x1.length
      const post_cy = sites_1x1.reduce((s, p) => s + p.xyz[1], 0) / sites_1x1.length
      const dx = pre_cx - post_cx
      const dy = pre_cy - post_cy
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        for (const site of sites_1x1) {
          site.xyz = [site.xyz[0] + dx, site.xyz[1] + dy, site.xyz[2]]
        }
      }
    }
    // else: reduction rotates the lattice — skip it to preserve visual consistency
  }

  // Now apply supercell expansion on the primitive cell
  const new_a: Vec3 = [prim_a[0] * na, prim_a[1] * na, 0]
  const new_b: Vec3 = [prim_b[0] * nb, prim_b[1] * nb, 0]
  const new_c: Vec3 = [0, 0, total_z]
  const new_matrix: Matrix3x3 = [new_a, new_b, new_c]

  const final_sites: Site[] = []
  let site_counter = 0
  for (const site of sites_1x1) {
    for (let ia = 0; ia < na; ia++) {
      for (let ib = 0; ib < nb; ib++) {
        const super_frac_a = (site.abc[0] + ia) / na
        const super_frac_b = (site.abc[1] + ib) / nb
        const super_frac_c = site.abc[2]

        const new_abc: Vec3 = [super_frac_a, super_frac_b, super_frac_c]
        const new_xyz = fractional_to_cartesian(new_abc, new_matrix)

        const { frac_xy: _unused, abc: _unused2, ...site_without_frac } = site
        const element = site.species[0]?.element || 'X'
        site_counter++

        final_sites.push({
          ...site_without_frac,
          xyz: new_xyz,
          abc: new_abc,
          label: `${element}${site_counter}`,
        })
      }
    }
  }

  const new_params = matrix_to_params(new_matrix)

  // Calculate volume from the new matrix (scalar triple product: a · (b × c))
  const [va, vb, vc] = new_matrix
  const cross_bc: Vec3 = [
    vb[1] * vc[2] - vb[2] * vc[1],
    vb[2] * vc[0] - vb[0] * vc[2],
    vb[0] * vc[1] - vb[1] * vc[0],
  ]
  const volume = Math.abs(va[0] * cross_bc[0] + va[1] * cross_bc[1] + va[2] * cross_bc[2])

  return {
    ...structure,
    lattice: {
      ...structure.lattice,
      matrix: new_matrix,
      a: new_params.a,
      b: new_params.b,
      c: new_params.c,
      alpha: new_params.alpha,
      beta: new_params.beta,
      gamma: new_params.gamma,
      volume,
      pbc: [true, true, false],
    },
    sites: final_sites,
  }
}

/**
 * Generate a slab from bulk crystal with proper coordinate reorientation
 * Uses the unified pipeline for consistency with preview
 *
 * The resulting slab has:
 * - Z axis perpendicular to (hkl) plane
 * - Atoms within the specified thickness range
 * - Vacuum layer added in Z direction
 * - In-plane coordinates properly wrapped to unit cell
 */
export function generate_slab(
  structure: PymatgenStructure,
  config: CuttingPlaneConfig & { supercell?: [number, number] },
): PymatgenStructure {
  const result = generate_slab_pipeline(structure, config)
  return result ?? structure
}

// ============================================================================
// Layer Detection
// ============================================================================

export interface AtomLayer {
  layer_idx: number
  distance: number // Distance from reference point along normal
  site_indices: number[] // Indices of atoms in this layer
  thickness: number // Layer thickness (distance to next layer or 0)
}

/**
 * Tolerance for grouping atoms into layers (Angstroms)
 */
const LAYER_TOLERANCE = 0.1

/**
 * Detect atomic layers along a given normal direction
 * Groups atoms by their distance along the normal with a tolerance
 */
export function detect_layers(
  structure: PymatgenStructure,
  normal: Vec3,
  tolerance: number = LAYER_TOLERANCE,
): AtomLayer[] {
  if (!structure?.sites?.length) return []

  // Compute distance for each atom along the normal
  const atom_distances: { site_idx: number; dist: number }[] = structure.sites.map((
    site,
    idx,
  ) => ({
    site_idx: idx,
    dist: site.xyz[0] * normal[0] + site.xyz[1] * normal[1] + site.xyz[2] * normal[2],
  }))

  // Sort by distance
  atom_distances.sort((a, b) => a.dist - b.dist)

  // Group into layers
  const layers: AtomLayer[] = []
  let current_layer: { site_indices: number[]; distances: number[] } | null = null

  for (const { site_idx, dist } of atom_distances) {
    if (!current_layer) {
      current_layer = { site_indices: [site_idx], distances: [dist] }
    } else {
      // Compare to FIRST atom in layer (not rolling average) to prevent drift
      // that merges adjacent layers. Matches Rust implementation in slab.rs.
      const first_dist = current_layer.distances[0]
      if (Math.abs(dist - first_dist) <= tolerance) {
        // Same layer
        current_layer.site_indices.push(site_idx)
        current_layer.distances.push(dist)
      } else {
        // New layer - save current and start new
        const layer_dist = current_layer.distances.reduce((a, b) => a + b, 0) /
          current_layer.distances.length
        layers.push({
          layer_idx: layers.length,
          distance: layer_dist,
          site_indices: current_layer.site_indices,
          thickness: 0, // Will be computed later
        })
        current_layer = { site_indices: [site_idx], distances: [dist] }
      }
    }
  }

  // Don't forget the last layer
  if (current_layer && current_layer.site_indices.length > 0) {
    const layer_dist = current_layer.distances.reduce((a, b) => a + b, 0) /
      current_layer.distances.length
    layers.push({
      layer_idx: layers.length,
      distance: layer_dist,
      site_indices: current_layer.site_indices,
      thickness: 0,
    })
  }

  // Compute layer thicknesses (distance to next layer)
  for (let i = 0; i < layers.length - 1; i++) {
    layers[i].thickness = layers[i + 1].distance - layers[i].distance
  }

  return layers
}

/**
 * Get the thickness needed to include N layers starting from a given offset
 */
export function thickness_for_layers(
  layers: AtomLayer[],
  start_offset: number,
  num_layers: number,
): { thickness: number; included_layers: AtomLayer[] } {
  if (layers.length === 0 || num_layers <= 0) {
    return { thickness: 0, included_layers: [] }
  }

  // Find layers whose center is at or after start_offset
  const sorted_layers = [...layers].sort((a, b) => a.distance - b.distance)

  // Find first layer at or after start_offset
  let start_idx = sorted_layers.findIndex((l) =>
    l.distance >= start_offset - LAYER_TOLERANCE
  )
  if (start_idx === -1) start_idx = 0

  // Get the requested number of layers
  const end_idx = Math.min(start_idx + num_layers, sorted_layers.length)
  const included = sorted_layers.slice(start_idx, end_idx)

  if (included.length === 0) {
    return { thickness: 0, included_layers: [] }
  }

  // Thickness is from first included layer to last included layer
  // Add some padding for atom radii
  const first_dist = included[0].distance
  const last_dist = included[included.length - 1].distance
  const padding = 1.0 // Approximate atom radius padding

  return {
    thickness: (last_dist - first_dist) + padding * 2,
    included_layers: included,
  }
}

/**
 * Compute the number of layers within a thickness range
 */
export function layers_in_range(
  layers: AtomLayer[],
  offset: number,
  thickness: number,
): AtomLayer[] {
  const lower = offset - thickness / 2
  const upper = offset + thickness / 2

  return layers.filter((l) => l.distance >= lower && l.distance <= upper)
}

/**
 * Compute slab preview with layer information
 */
export function compute_slab_preview_with_layers(
  structure: PymatgenStructure,
  config: CuttingPlaneConfig,
): SlabPreview & { layers: AtomLayer[]; included_layers: AtomLayer[] } {
  const preview = compute_slab_preview(structure, config)
  const layers = detect_layers(structure, preview.normal)
  const included_layers = layers_in_range(layers, config.offset, config.thickness)

  return {
    ...preview,
    layers,
    included_layers,
  }
}

// ============================================================================
// Animation Helpers
// ============================================================================

/**
 * Interpolate atom visibility for animation
 * Returns updated visibility with animated opacity/saturation
 */
export function animate_visibility(
  visibility: AtomVisibility[],
  progress: number, // 0-1, where 0=full color, 1=gray+faded
): AtomVisibility[] {
  return visibility.map((v) => {
    if (v.inside_slab) {
      return { ...v, opacity: 1.0, saturation: 1.0 }
    }

    // Atoms outside: first gray out (0-0.5), then fade (0.5-1.0)
    const gray_progress = Math.min(1, progress * 2) // 0-1 during first half
    const fade_progress = Math.max(0, (progress - 0.5) * 2) // 0-1 during second half

    return {
      ...v,
      saturation: 1.0 - 0.7 * gray_progress, // 1.0 -> 0.3
      opacity: 1.0 - 0.8 * fade_progress, // 1.0 -> 0.2
    }
  })
}

// ============================================================================
// WYSIWYG Slab Preview
// ============================================================================

export interface SlabPreviewStructure {
  structure: PymatgenStructure // The preview slab structure
  bounds: {
    min_z: number
    max_z: number
    slab_thickness: number
    vacuum_above: number
    vacuum_below: number
  }
  transform: {
    rotation_matrix: Matrix3x3 // Rotation to align Z with normal
    translation: Vec3 // Translation to position slab
  }
}

/**
 * Generate a preview slab structure for WYSIWYG display
 * Uses the same unified pipeline as generate_slab for consistency
 */
export function generate_preview_slab(
  structure: PymatgenStructure,
  config: CuttingPlaneConfig & { supercell?: [number, number] },
): SlabPreviewStructure | null {
  if (!structure?.sites || structure.sites.length === 0) return null

  // Use unified pipeline - use provided supercell or default to 1×1
  const supercell = config.supercell ?? [1, 1]
  const preview_config = { ...config, supercell: supercell as [number, number] }
  const result = generate_slab_pipeline(structure, preview_config)

  if (!result) return null

  // Compute bounds info from the result
  let min_z = Infinity, max_z = -Infinity
  for (const site of result.sites) {
    if (site.xyz[2] < min_z) min_z = site.xyz[2]
    if (site.xyz[2] > max_z) max_z = site.xyz[2]
  }

  const slab_thickness_actual = max_z - min_z
  const R = build_slab_rotation_matrix(
    config.miller_index,
    structure.lattice.matrix as Matrix3x3,
  )

  return {
    structure: result,
    bounds: {
      min_z,
      max_z,
      slab_thickness: slab_thickness_actual,
      vacuum_above: config.vacuum / 2,
      vacuum_below: config.vacuum / 2,
    },
    transform: {
      rotation_matrix: R,
      translation: [0, 0, min_z],
    },
  }
}

// ============================================================================
// Periodic Layer Detection & Virtual Layers
// ============================================================================

/**
 * Detect periodic repeat pattern in layer structure
 * Analyzes layer spacings to find the fundamental repeat period
 */
export function detect_periodic_repeat(
  structure: PymatgenStructure,
  normal: Vec3,
  d_spacing: number,
): PeriodicLayerInfo {
  const layers = detect_layers(structure, normal)

  if (layers.length < 2) {
    return {
      detected_layers: layers,
      repeat_period: d_spacing,
      base_layer_count: layers.length,
      is_periodic: false,
    }
  }

  // Calculate layer spacings (distances between consecutive layers)
  const spacings: number[] = []
  for (let i = 0; i < layers.length - 1; i++) {
    spacings.push(layers[i + 1].distance - layers[i].distance)
  }

  // Try to find a repeating pattern in spacings
  // The repeat period is the sum of spacings in one cycle
  // For simple structures, this is often just d_spacing

  // Calculate total span of detected layers
  const total_span = layers[layers.length - 1].distance - layers[0].distance

  // Use d_spacing as the fundamental repeat period
  // This is more reliable than trying to detect patterns in spacings
  const repeat_period = d_spacing > 0
    ? d_spacing
    : total_span / Math.max(1, layers.length - 1)

  return {
    detected_layers: layers,
    repeat_period,
    base_layer_count: layers.length,
    is_periodic: true,
  }
}

/**
 * Generate virtual layers beyond the detected physical layers
 * Uses the periodic repeat to extend layer list indefinitely
 */
export function generate_virtual_layers(
  periodic_info: PeriodicLayerInfo,
  target_layer_count: number,
  reference_offset: number,
): AtomLayer[] {
  const { detected_layers, repeat_period, base_layer_count } = periodic_info

  if (detected_layers.length === 0 || target_layer_count <= 0) {
    return []
  }

  // If we have enough physical layers, just return them
  if (target_layer_count <= detected_layers.length) {
    return detected_layers.slice(0, target_layer_count)
  }

  // We need to generate virtual layers
  // Calculate the average layer spacing from detected layers
  let avg_spacing = repeat_period / Math.max(1, base_layer_count)
  if (detected_layers.length > 1) {
    const total_spacing = detected_layers[detected_layers.length - 1].distance -
      detected_layers[0].distance
    avg_spacing = total_spacing / (detected_layers.length - 1)
  }

  // Start with physical layers
  const result: AtomLayer[] = [...detected_layers]

  // Add virtual layers by repeating the pattern
  const last_physical_layer = detected_layers[detected_layers.length - 1]
  let current_distance = last_physical_layer.distance

  for (let i = detected_layers.length; i < target_layer_count; i++) {
    current_distance += avg_spacing
    result.push({
      layer_idx: i,
      distance: current_distance,
      site_indices: [], // Virtual layers have no physical atoms yet
      thickness: avg_spacing,
    })
  }

  return result
}

/**
 * Get the thickness needed to include N layers using physical replication
 * (no virtual layers - actually replicates the bulk if needed)
 */
export function thickness_for_layers_physical(
  structure: PymatgenStructure,
  miller_index: MillerIndex,
  start_offset: number,
  num_layers: number,
  growth_mode: GrowthMode = 'centered',
): {
  thickness: number
  replication_count: number
  total_available_layers: number
  included_layers: AtomLayer[]
} {
  if (!structure?.lattice || num_layers <= 0) {
    return {
      thickness: 0,
      replication_count: 1,
      total_available_layers: 0,
      included_layers: [],
    }
  }

  const lattice = structure.lattice.matrix as Matrix3x3
  const normal = miller_to_normal(miller_index, lattice)

  // Detect initial layers
  let layers = detect_layers(structure, normal)

  if (layers.length === 0) {
    return {
      thickness: 0,
      replication_count: 1,
      total_available_layers: 0,
      included_layers: [],
    }
  }

  // Calculate replication count if needed
  let replication_count = 1
  if (num_layers > layers.length) {
    replication_count = Math.ceil(num_layers / layers.length)

    // Simulate replication effect on layer count
    // In reality, we expand the layer list by replication
    const sorted_layers = [...layers].sort((a, b) => a.distance - b.distance)
    const layer_span = sorted_layers.length > 1
      ? sorted_layers[sorted_layers.length - 1].distance - sorted_layers[0].distance
      : 0
    const avg_spacing = layers.length > 1 ? layer_span / (layers.length - 1) : 2.0
    const z_period = layer_span + avg_spacing

    // Create expanded layer list
    const expanded_layers: AtomLayer[] = []
    for (let rep = 0; rep < replication_count; rep++) {
      for (const layer of layers) {
        expanded_layers.push({
          ...layer,
          layer_idx: expanded_layers.length,
          distance: layer.distance + rep * z_period,
          // Note: site_indices won't be accurate for replicated layers
          // but that's fine for thickness calculation
        })
      }
    }
    layers = expanded_layers
  }

  const total_available_layers = layers.length

  // Sort layers by distance
  const sorted_layers = [...layers].sort((a, b) => a.distance - b.distance)

  // Find layers based on growth mode
  let start_idx: number
  const tolerance = 0.1 // LAYER_TOLERANCE

  if (growth_mode === 'anchor_minus_z') {
    // Surface at offset, grow into -Z (select layers below offset)
    // Find the layer closest to start_offset
    let closest_idx = 0
    let min_dist = Math.abs(sorted_layers[0].distance - start_offset)
    for (let i = 1; i < sorted_layers.length; i++) {
      const dist = Math.abs(sorted_layers[i].distance - start_offset)
      if (dist < min_dist) {
        min_dist = dist
        closest_idx = i
      }
    }
    // Start from closest layer and go backward
    start_idx = Math.max(0, closest_idx - num_layers + 1)
  } else if (growth_mode === 'anchor_plus_z') {
    // Bottom at offset, grow into +Z
    start_idx = sorted_layers.findIndex((l) => l.distance >= start_offset - tolerance)
    if (start_idx === -1) start_idx = 0
  } else {
    // Centered
    const mid_idx = sorted_layers.findIndex((l) => l.distance >= start_offset - tolerance)
    start_idx = Math.max(0, (mid_idx === -1 ? 0 : mid_idx) - Math.floor(num_layers / 2))
  }

  // Get included layers
  const end_idx = Math.min(start_idx + num_layers, sorted_layers.length)
  const included_layers = sorted_layers.slice(start_idx, end_idx)

  if (included_layers.length === 0) {
    return {
      thickness: 0,
      replication_count,
      total_available_layers,
      included_layers: [],
    }
  }

  // Calculate thickness
  const first_dist = included_layers[0].distance
  const last_dist = included_layers[included_layers.length - 1].distance
  const padding = 1.0 // Padding to ensure boundary layers are fully captured

  return {
    thickness: (last_dist - first_dist) + padding * 2,
    replication_count,
    total_available_layers,
    included_layers,
  }
}

/**
 * Get the thickness needed to include N layers starting from a given offset,
 * with support for virtual layers beyond the detected physical layers
 * @deprecated Use thickness_for_layers_physical instead for proper layer replication
 */
export function thickness_for_layers_extended(
  layers: AtomLayer[],
  periodic_info: PeriodicLayerInfo,
  start_offset: number,
  num_layers: number,
  growth_mode: GrowthMode = 'centered',
): { thickness: number; included_layers: AtomLayer[]; has_virtual: boolean } {
  if (num_layers <= 0) {
    return { thickness: 0, included_layers: [], has_virtual: false }
  }

  // Generate enough virtual layers
  const extended_layers = generate_virtual_layers(
    periodic_info,
    num_layers * 2,
    start_offset,
  )

  if (extended_layers.length === 0) {
    return { thickness: 0, included_layers: [], has_virtual: false }
  }

  // Sort by distance
  const sorted_layers = [...extended_layers].sort((a, b) => a.distance - b.distance)

  // Find first layer at or near start_offset based on growth mode
  let start_idx: number
  if (growth_mode === 'anchor_minus_z') {
    // Surface at offset, grow into -Z (include layers below offset)
    start_idx = sorted_layers.findIndex((l) =>
      l.distance <= start_offset + LAYER_TOLERANCE
    )
    if (start_idx === -1) start_idx = 0
    // Adjust to get layers ending at offset
    start_idx = Math.max(0, sorted_layers.length - num_layers)
  } else if (growth_mode === 'anchor_plus_z') {
    // Bottom at offset, grow into +Z
    start_idx = sorted_layers.findIndex((l) =>
      l.distance >= start_offset - LAYER_TOLERANCE
    )
    if (start_idx === -1) start_idx = 0
  } else {
    // Centered growth - find layers around offset
    const mid_idx = sorted_layers.findIndex((l) =>
      l.distance >= start_offset - LAYER_TOLERANCE
    )
    start_idx = Math.max(0, mid_idx - Math.floor(num_layers / 2))
  }

  // Get the requested number of layers
  const end_idx = Math.min(start_idx + num_layers, sorted_layers.length)
  const included = sorted_layers.slice(start_idx, end_idx)

  if (included.length === 0) {
    return { thickness: 0, included_layers: [], has_virtual: false }
  }

  // Check if any included layers are virtual (no site_indices)
  const has_virtual = included.some((l) => l.site_indices.length === 0)

  // Thickness is from first included layer to last included layer
  const first_dist = included[0].distance
  const last_dist = included[included.length - 1].distance
  const padding = 0.5 // Small padding for atom radii

  return {
    thickness: (last_dist - first_dist) + padding * 2,
    included_layers: included,
    has_virtual,
  }
}

// ============================================================================
// Presets
// ============================================================================

export const MILLER_PRESETS: { label: string; hkl: MillerIndex }[] = [
  { label: '(001)', hkl: [0, 0, 1] },
  { label: '(100)', hkl: [1, 0, 0] },
  { label: '(110)', hkl: [1, 1, 0] },
  { label: '(111)', hkl: [1, 1, 1] },
  { label: '(210)', hkl: [2, 1, 0] },
  { label: '(211)', hkl: [2, 1, 1] },
]

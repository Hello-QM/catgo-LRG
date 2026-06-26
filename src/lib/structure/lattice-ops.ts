/**
 * Lattice operations: parameter editing, transformation, and vacuum layer addition
 */
import type { PymatgenMolecule, PymatgenStructure, Vec3 } from '$lib'

export interface LatticeParams {
  a: number
  b: number
  c: number
  alpha: number // degrees
  beta: number // degrees
  gamma: number // degrees
}

/**
 * Convert lattice parameters to a 3x3 matrix
 * Uses the standard crystallographic convention where:
 * - a is along x
 * - b is in the xy plane
 * - c is determined by alpha, beta, gamma
 */
export function params_to_matrix(params: LatticeParams): [Vec3, Vec3, Vec3] {
  const { a, b, c, alpha, beta, gamma } = params

  // Convert angles to radians
  const alpha_rad = (alpha * Math.PI) / 180
  const beta_rad = (beta * Math.PI) / 180
  const gamma_rad = (gamma * Math.PI) / 180

  // Calculate lattice vectors
  // a vector along x-axis
  const ax = a
  const ay = 0
  const az = 0

  // b vector in xy plane
  const bx = b * Math.cos(gamma_rad)
  const by = b * Math.sin(gamma_rad)
  const bz = 0

  // c vector
  const cx = c * Math.cos(beta_rad)
  const cy = c * (Math.cos(alpha_rad) - Math.cos(beta_rad) * Math.cos(gamma_rad)) /
    Math.sin(gamma_rad)
  const cz = Math.sqrt(c * c - cx * cx - cy * cy)

  return [
    [ax, ay, az],
    [bx, by, bz],
    [cx, cy, cz],
  ]
}

/**
 * Extract lattice parameters from a 3x3 matrix
 */
export function matrix_to_params(matrix: [Vec3, Vec3, Vec3]): LatticeParams {
  const [va, vb, vc] = matrix

  // Check for NaN or undefined values in input matrix
  const hasInvalidValue = (v: Vec3) => v.some((x) => !Number.isFinite(x))
  if (hasInvalidValue(va) || hasInvalidValue(vb) || hasInvalidValue(vc)) {
    console.warn('[lattice-ops] matrix_to_params: invalid matrix values detected')
    return { a: 0, b: 0, c: 0, alpha: 90, beta: 90, gamma: 90 }
  }

  // Calculate lengths
  const a = Math.sqrt(va[0] ** 2 + va[1] ** 2 + va[2] ** 2)
  const b = Math.sqrt(vb[0] ** 2 + vb[1] ** 2 + vb[2] ** 2)
  const c = Math.sqrt(vc[0] ** 2 + vc[1] ** 2 + vc[2] ** 2)

  // Guard against zero-length vectors (would cause division by zero in angle calculation)
  const EPS = 1e-10
  if (a < EPS || b < EPS || c < EPS) {
    console.warn('[lattice-ops] matrix_to_params: zero-length lattice vector detected')
    return { a, b, c, alpha: 90, beta: 90, gamma: 90 }
  }

  // Calculate angles using dot products
  const dot_bc = vb[0] * vc[0] + vb[1] * vc[1] + vb[2] * vc[2]
  const dot_ac = va[0] * vc[0] + va[1] * vc[1] + va[2] * vc[2]
  const dot_ab = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]

  // Clamp cosine values to [-1, 1] to avoid NaN from acos due to floating point errors
  const clamp = (x: number) => Math.max(-1, Math.min(1, x))
  const alpha = Math.acos(clamp(dot_bc / (b * c))) * (180 / Math.PI)
  const beta = Math.acos(clamp(dot_ac / (a * c))) * (180 / Math.PI)
  const gamma = Math.acos(clamp(dot_ab / (a * b))) * (180 / Math.PI)

  return { a, b, c, alpha, beta, gamma }
}

/**
 * Ensure lattice matrix has positive determinant (right-handed coordinate system).
 * VASP and other DFT codes require det(lattice) > 0.
 * If negative, swaps a and b vectors to flip the sign.
 * Returns { matrix, swapped } where swapped indicates if a/b were swapped.
 */
export function ensure_right_handed(
  matrix: [Vec3, Vec3, Vec3],
): { matrix: [Vec3, Vec3, Vec3]; swapped: boolean } {
  const [a, b, c] = matrix
  // det = a · (b × c)
  const bxc: Vec3 = [
    b[1] * c[2] - b[2] * c[1],
    b[2] * c[0] - b[0] * c[2],
    b[0] * c[1] - b[1] * c[0],
  ]
  const det = a[0] * bxc[0] + a[1] * bxc[1] + a[2] * bxc[2]
  if (det < 0) {
    // Swap a and b to make determinant positive
    return { matrix: [b, a, c], swapped: true }
  }
  return { matrix, swapped: false }
}

/**
 * Apply a 3x3 transformation matrix to a lattice
 * new_lattice = old_lattice * transform
 */
export function transform_lattice(
  matrix: [Vec3, Vec3, Vec3],
  transform: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ],
): [Vec3, Vec3, Vec3] {
  const result: [Vec3, Vec3, Vec3] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      result[i][j] = matrix[i][0] * transform[0][j] +
        matrix[i][1] * transform[1][j] +
        matrix[i][2] * transform[2][j]
    }
  }

  return result
}

/**
 * Convert Cartesian coordinates to fractional coordinates
 */
export function cartesian_to_fractional(
  xyz: Vec3,
  matrix: [Vec3, Vec3, Vec3],
): Vec3 {
  // Compute inverse of lattice matrix
  const [a, b, c] = matrix

  // Calculate determinant
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0])

  if (Math.abs(det) < 1e-10) {
    console.warn('Singular lattice matrix')
    return [0, 0, 0]
  }

  // Inverse matrix elements
  const inv: [Vec3, Vec3, Vec3] = [
    [
      (b[1] * c[2] - b[2] * c[1]) / det,
      (a[2] * c[1] - a[1] * c[2]) / det,
      (a[1] * b[2] - a[2] * b[1]) / det,
    ],
    [
      (b[2] * c[0] - b[0] * c[2]) / det,
      (a[0] * c[2] - a[2] * c[0]) / det,
      (a[2] * b[0] - a[0] * b[2]) / det,
    ],
    [
      (b[0] * c[1] - b[1] * c[0]) / det,
      (a[1] * c[0] - a[0] * c[1]) / det,
      (a[0] * b[1] - a[1] * b[0]) / det,
    ],
  ]

  // Multiply xyz by inverse matrix
  return [
    xyz[0] * inv[0][0] + xyz[1] * inv[1][0] + xyz[2] * inv[2][0],
    xyz[0] * inv[0][1] + xyz[1] * inv[1][1] + xyz[2] * inv[2][1],
    xyz[0] * inv[0][2] + xyz[1] * inv[1][2] + xyz[2] * inv[2][2],
  ]
}

/**
 * Convert fractional coordinates to Cartesian coordinates
 */
export function fractional_to_cartesian(
  abc: Vec3,
  matrix: [Vec3, Vec3, Vec3],
): Vec3 {
  const [va, vb, vc] = matrix
  return [
    abc[0] * va[0] + abc[1] * vb[0] + abc[2] * vc[0],
    abc[0] * va[1] + abc[1] * vb[1] + abc[2] * vc[1],
    abc[0] * va[2] + abc[1] * vb[2] + abc[2] * vc[2],
  ]
}

/**
 * Add vacuum layer to a structure in a specified direction
 * @param structure - PymatgenStructure with lattice
 * @param direction - Direction to add vacuum ('x', 'y', or 'z')
 * @param thickness - Vacuum thickness in Angstroms
 * @param center_structure - Whether to center the structure in the new cell
 * @returns New structure with expanded lattice
 */
export function add_vacuum_layer(
  structure: PymatgenStructure,
  direction: 'x' | 'y' | 'z',
  thickness: number,
  center_structure: boolean = true,
): PymatgenStructure {
  if (!structure.lattice?.matrix) return structure
  if (!Number.isFinite(thickness) || thickness <= 0) return structure

  const old_matrix = structure.lattice.matrix as [Vec3, Vec3, Vec3]
  const dir_idx = direction === 'x' ? 0 : direction === 'y' ? 1 : 2

  // Calculate the unit vector in the specified direction
  const vec = old_matrix[dir_idx]
  const vec_length = Math.sqrt(vec[0] ** 2 + vec[1] ** 2 + vec[2] ** 2)
  const unit_vec: Vec3 = [vec[0] / vec_length, vec[1] / vec_length, vec[2] / vec_length]

  // Create new lattice matrix with extended vector
  const new_length = vec_length + thickness
  const new_matrix: [Vec3, Vec3, Vec3] = [
    [...old_matrix[0]] as Vec3,
    [...old_matrix[1]] as Vec3,
    [...old_matrix[2]] as Vec3,
  ]
  new_matrix[dir_idx] = [
    unit_vec[0] * new_length,
    unit_vec[1] * new_length,
    unit_vec[2] * new_length,
  ]

  // Calculate new lattice parameters
  const new_params = matrix_to_params(new_matrix)

  // Collect fractional coordinates for all sites
  const scale_factor = vec_length / new_length
  const site_fracs = structure.sites.map((site) => {
    let abc = site.abc
    if (!abc) {
      abc = cartesian_to_fractional(site.xyz, old_matrix)
    }
    return abc
  })

  // Compute centering shift based on the geometric center of the structure
  let shift = 0
  if (center_structure && site_fracs.length > 0) {
    const avg_frac =
      site_fracs.reduce((sum, abc) => sum + abc[dir_idx], 0) / site_fracs.length
    // After scaling, the center would be at avg_frac * scale_factor
    // We want it at 0.5 in the new cell
    shift = 0.5 - avg_frac * scale_factor
  }

  // Update sites with new fractional coordinates
  const new_sites = structure.sites.map((site, i) => {
    const abc = site_fracs[i]
    const new_abc: Vec3 = [...abc] as Vec3

    new_abc[dir_idx] = abc[dir_idx] * scale_factor + shift

    // Convert back to Cartesian
    const new_xyz = fractional_to_cartesian(new_abc, new_matrix)

    return {
      ...site,
      xyz: new_xyz,
      abc: new_abc,
    }
  })

  // Calculate volume from new matrix: det = a · (b × c)
  const [va, vb, vc] = new_matrix
  const volume = Math.abs(
    va[0] * (vb[1] * vc[2] - vb[2] * vc[1]) -
    va[1] * (vb[0] * vc[2] - vb[2] * vc[0]) +
    va[2] * (vb[0] * vc[1] - vb[1] * vc[0]),
  )

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
    },
    sites: new_sites,
  }
}

/**
 * Update structure with new lattice parameters
 * Recalculates Cartesian coordinates from fractional coordinates
 */
export function update_lattice_params(
  structure: PymatgenStructure,
  new_params: LatticeParams,
): PymatgenStructure {
  if (!structure.lattice?.matrix) return structure

  const old_matrix = structure.lattice.matrix as [Vec3, Vec3, Vec3]
  const new_matrix = params_to_matrix(new_params)

  // Update sites: convert fractional to new Cartesian
  const new_sites = structure.sites.map((site) => {
    let abc = site.abc
    if (!abc) {
      abc = cartesian_to_fractional(site.xyz, old_matrix)
    }
    const new_xyz = fractional_to_cartesian(abc, new_matrix)

    return {
      ...site,
      xyz: new_xyz,
      abc: abc,
    }
  })

  // Calculate volume from new matrix
  const [va, vb, vc] = new_matrix
  const volume = Math.abs(
    va[0] * (vb[1] * vc[2] - vb[2] * vc[1]) -
    va[1] * (vb[0] * vc[2] - vb[2] * vc[0]) +
    va[2] * (vb[0] * vc[1] - vb[1] * vc[0]),
  )

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
    },
    sites: new_sites,
  }
}

/**
 * Re-orient a lattice into the standard crystallographic convention:
 * - a vector along the positive x-axis: (|a|, 0, 0)
 * - b vector in the xy plane with positive y component: (bx, by, 0)
 * - c vector with positive z component
 *
 * Cartesian coordinates (xyz) are preserved; fractional coords (abc) are
 * recomputed for the new lattice and wrapped to [0, 1). This keeps the
 * physical atom positions unchanged — only the lattice box is redrawn in
 * standard orientation (matching pymatgen's convention).
 */
/**
 * Compute the rotation matrix that aligns vec1 to vec2.
 * Rodrigues' rotation formula (same as ASE/trans.py).
 */
function rotation_matrix_from_vectors(
  vec1: Vec3,
  vec2: Vec3,
): [Vec3, Vec3, Vec3] {
  const norm = (v: Vec3) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
  const n1 = norm(vec1)
  const n2 = norm(vec2)
  if (n1 < 1e-12 || n2 < 1e-12) {
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  }
  const a: Vec3 = [vec1[0] / n1, vec1[1] / n1, vec1[2] / n1]
  const b: Vec3 = [vec2[0] / n2, vec2[1] / n2, vec2[2] / n2]

  const cross: Vec3 = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

  // Already aligned
  if (Math.abs(dot - 1.0) < 1e-10) {
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  }

  // Anti-parallel: 180° rotation
  if (Math.abs(dot + 1.0) < 1e-10) {
    let axis: Vec3 = [1, 0, 0]
    const d = Math.sqrt((a[0] - axis[0]) ** 2 + (a[1] - axis[1]) ** 2 + (a[2] - axis[2]) ** 2)
    const d2 = Math.sqrt((a[0] + axis[0]) ** 2 + (a[1] + axis[1]) ** 2 + (a[2] + axis[2]) ** 2)
    if (d < 1e-6 || d2 < 1e-6) axis = [0, 1, 0]
    const proj = a[0] * axis[0] + a[1] * axis[1] + a[2] * axis[2]
    axis = [axis[0] - proj * a[0], axis[1] - proj * a[1], axis[2] - proj * a[2]]
    const an = norm(axis)
    axis = [axis[0] / an, axis[1] / an, axis[2] / an]
    // K = skew-symmetric matrix of axis
    // R = I + 2*K*K
    const K: [Vec3, Vec3, Vec3] = [
      [0, -axis[2], axis[1]],
      [axis[2], 0, -axis[0]],
      [-axis[1], axis[0], 0],
    ]
    const KK = mat3_mul(K, K)
    return [
      [1 + 2 * KK[0][0], 2 * KK[0][1], 2 * KK[0][2]],
      [2 * KK[1][0], 1 + 2 * KK[1][1], 2 * KK[1][2]],
      [2 * KK[2][0], 2 * KK[2][1], 1 + 2 * KK[2][2]],
    ]
  }

  // General case: Rodrigues' formula R = I + K + K² * (1-dot)/s²
  const s = norm(cross)
  const K: [Vec3, Vec3, Vec3] = [
    [0, -cross[2], cross[1]],
    [cross[2], 0, -cross[0]],
    [-cross[1], cross[0], 0],
  ]
  const KK = mat3_mul(K, K)
  const factor = (1 - dot) / (s * s)
  return [
    [1 + K[0][0] + KK[0][0] * factor, K[0][1] + KK[0][1] * factor, K[0][2] + KK[0][2] * factor],
    [K[1][0] + KK[1][0] * factor, 1 + K[1][1] + KK[1][1] * factor, K[1][2] + KK[1][2] * factor],
    [K[2][0] + KK[2][0] * factor, K[2][1] + KK[2][1] * factor, 1 + K[2][2] + KK[2][2] * factor],
  ]
}

/** 3x3 matrix multiply (row-major) */
function mat3_mul(A: [Vec3, Vec3, Vec3], B: [Vec3, Vec3, Vec3]): [Vec3, Vec3, Vec3] {
  const r: [Vec3, Vec3, Vec3] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]
    }
  }
  return r
}

/** Transpose 3x3 matrix */
function mat3_T(M: [Vec3, Vec3, Vec3]): [Vec3, Vec3, Vec3] {
  return [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]],
  ]
}

/**
 * Reorient lattice so a1 is along x-axis and a3 is in the xz-plane.
 * Uses Rodrigues' rotation following ASE's convention:
 * 1. Rotate a1 → x-axis
 * 2. Rotate around x-axis to put a3 in xz-plane
 * Fractional coords are invariant under rigid rotation of both cell and positions.
 */
export function reorient_lattice(structure: PymatgenStructure): PymatgenStructure {
  if (!structure.lattice?.matrix) return structure

  const M = structure.lattice.matrix as [Vec3, Vec3, Vec3]

  // Step 1: R1 aligns a1 to x-axis
  const a1 = M[0]
  const R1 = rotation_matrix_from_vectors(a1, [1, 0, 0])

  // Apply R1: M_new = M * R1^T (rotates each row vector by R1)
  const R1T = mat3_T(R1)
  const M1 = mat3_mul(M, R1T)

  // Step 2: Rotate around x-axis to put a3 in xz-plane
  const a3_y = M1[2][1]
  const a3_z = M1[2][2]
  const theta = Math.atan2(a3_y, a3_z)
  const cos_t = Math.cos(-theta)
  const sin_t = Math.sin(-theta)
  const R2: [Vec3, Vec3, Vec3] = [
    [1, 0, 0],
    [0, cos_t, -sin_t],
    [0, sin_t, cos_t],
  ]

  // Apply R2: M_final = M1 * R2^T
  const R2T = mat3_T(R2)
  const new_matrix = mat3_mul(M1, R2T)

  // Wrap fractional coordinates to [0, 1)
  const new_sites = structure.sites.map((site) => {
    let abc = site.abc
    if (!abc) {
      abc = cartesian_to_fractional(site.xyz, M)
    }
    const wrapped_abc: Vec3 = [
      abc[0] - Math.floor(abc[0]),
      abc[1] - Math.floor(abc[1]),
      abc[2] - Math.floor(abc[2]),
    ]
    for (let i = 0; i < 3; i++) {
      if (Math.abs(wrapped_abc[i] - 1.0) < 1e-10) wrapped_abc[i] = 0
    }
    const new_xyz = fractional_to_cartesian(wrapped_abc, new_matrix)
    return { ...site, xyz: new_xyz, abc: wrapped_abc }
  })

  // Compute volume and params from new matrix
  const params = matrix_to_params(new_matrix)
  const [va, vb, vc] = new_matrix
  const volume = Math.abs(
    va[0] * (vb[1] * vc[2] - vb[2] * vc[1]) -
    va[1] * (vb[0] * vc[2] - vb[2] * vc[0]) +
    va[2] * (vb[0] * vc[1] - vb[1] * vc[0]),
  )

  return {
    ...structure,
    lattice: {
      ...structure.lattice,
      matrix: new_matrix,
      a: params.a,
      b: params.b,
      c: params.c,
      alpha: params.alpha,
      beta: params.beta,
      gamma: params.gamma,
      volume,
    },
    sites: new_sites,
  }
}

/**
 * Apply a transformation matrix to a structure
 * Updates both the lattice and atom positions
 * Note: This only changes the lattice, atoms are NOT replicated
 */
export function apply_transform_matrix(
  structure: PymatgenStructure,
  transform: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ],
): PymatgenStructure {
  if (!structure.lattice?.matrix) return structure

  const old_matrix = structure.lattice.matrix as [Vec3, Vec3, Vec3]
  const raw_matrix = transform_lattice(old_matrix, transform)

  // Ensure right-handed lattice (positive determinant) for VASP compatibility
  const { matrix: new_matrix, swapped } = ensure_right_handed(raw_matrix)
  const new_params = matrix_to_params(new_matrix)

  // Update sites: fractional coordinates stay the same, Cartesian changes
  // If a/b were swapped, also swap fractional a/b coordinates
  const new_sites = structure.sites.map((site) => {
    let abc = site.abc
    if (!abc) {
      abc = cartesian_to_fractional(site.xyz, old_matrix)
    }
    if (swapped) {
      abc = [abc[1], abc[0], abc[2]] as Vec3
    }
    const new_xyz = fractional_to_cartesian(abc, new_matrix)

    return {
      ...site,
      xyz: new_xyz,
      abc: abc,
    }
  })

  // Calculate volume from new matrix
  const [va, vb, vc] = new_matrix
  const volume = Math.abs(
    va[0] * (vb[1] * vc[2] - vb[2] * vc[1]) -
    va[1] * (vb[0] * vc[2] - vb[2] * vc[0]) +
    va[2] * (vb[0] * vc[1] - vb[1] * vc[0]),
  )

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
    },
    sites: new_sites,
  }
}

/**
 * Compute 3x3 matrix inverse
 */
function matrix_inverse_3x3(
  m: [[number, number, number], [number, number, number], [number, number, number]],
): [[number, number, number], [number, number, number], [number, number, number]] | null {
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])

  if (Math.abs(det) < 1e-10) return null

  const invDet = 1 / det
  return [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invDet,
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet,
    ],
    [
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet,
    ],
    [
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invDet,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invDet,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invDet,
    ],
  ]
}

/**
 * Multiply a 3x3 matrix by a vector
 */
function mat_vec_multiply(
  m: [[number, number, number], [number, number, number], [number, number, number]],
  v: Vec3,
): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ]
}

/**
 * Apply a transformation matrix to create a supercell
 * This properly replicates atoms when the transformation expands the cell
 * For a transformation matrix T with determinant D > 1, creates D times more atoms
 */
export function apply_transform_matrix_supercell(
  structure: PymatgenStructure,
  transform: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ],
): PymatgenStructure {
  if (!structure.lattice?.matrix) return structure

  const old_matrix = structure.lattice.matrix as [Vec3, Vec3, Vec3]
  const raw_matrix = transform_lattice(old_matrix, transform)

  // Ensure right-handed lattice (positive determinant) for VASP compatibility
  const { matrix: new_matrix, swapped } = ensure_right_handed(raw_matrix)
  const new_params = matrix_to_params(new_matrix)

  // Calculate determinant to know how many lattice points we need
  const det = Math.round(
    transform[0][0] *
        (transform[1][1] * transform[2][2] - transform[1][2] * transform[2][1]) -
      transform[0][1] *
        (transform[1][0] * transform[2][2] - transform[1][2] * transform[2][0]) +
      transform[0][2] *
        (transform[1][0] * transform[2][1] - transform[1][1] * transform[2][0]),
  )

  // If determinant is 1 or less, just do a regular transform
  if (Math.abs(det) <= 1) {
    return apply_transform_matrix(structure, transform)
  }

  // Find the inverse of the transformation matrix
  const transform_inv = matrix_inverse_3x3(transform)
  if (!transform_inv) {
    console.warn('Singular transformation matrix')
    return apply_transform_matrix(structure, transform)
  }

  // Find all lattice points that fall within the new supercell
  // We need to search in a range based on the maximum elements of the transform matrix
  const max_range = Math.ceil(Math.max(
    ...transform.flat().map(Math.abs),
  )) + 1

  const lattice_points: Vec3[] = []

  for (let i = -max_range; i <= max_range * 2; i++) {
    for (let j = -max_range; j <= max_range * 2; j++) {
      for (let k = -max_range; k <= max_range * 2; k++) {
        // Transform the integer lattice point to fractional coordinates in the new cell
        const frac_new = mat_vec_multiply(transform_inv, [i, j, k])

        // Check if this point is within the unit cell [0, 1)^3
        const eps = 1e-8
        if (
          frac_new[0] >= -eps && frac_new[0] < 1 - eps &&
          frac_new[1] >= -eps && frac_new[1] < 1 - eps &&
          frac_new[2] >= -eps && frac_new[2] < 1 - eps
        ) {
          lattice_points.push([i, j, k])
        }
      }
    }
  }

  // Generate new sites by replicating atoms at each lattice point
  const new_sites = []
  const n_points = lattice_points.length

  for (const lp of lattice_points) {
    for (const site of structure.sites) {
      // Get fractional coordinates in old cell
      let abc = site.abc
      if (!abc) {
        abc = cartesian_to_fractional(site.xyz, old_matrix)
      }

      // New fractional coordinates in old cell = original + lattice point offset
      const old_frac_shifted: Vec3 = [
        abc[0] + lp[0],
        abc[1] + lp[1],
        abc[2] + lp[2],
      ]

      // Convert old fractional to Cartesian using old lattice
      const xyz_old = fractional_to_cartesian(old_frac_shifted, old_matrix)

      // Convert Cartesian to new fractional using new lattice
      const new_abc = cartesian_to_fractional(xyz_old, new_matrix)

      // If a/b were swapped for right-handedness, swap fractional a/b
      const adj_abc = swapped ? [new_abc[1], new_abc[0], new_abc[2]] as Vec3 : new_abc

      // Wrap to [0, 1) if needed
      const wrapped_abc: Vec3 = [
        ((adj_abc[0] % 1) + 1) % 1,
        ((adj_abc[1] % 1) + 1) % 1,
        ((adj_abc[2] % 1) + 1) % 1,
      ]

      // Convert back to Cartesian
      const new_xyz = fractional_to_cartesian(wrapped_abc, new_matrix)

      // Create label suffix for supercell
      const label_suffix = n_points > 1 ? `_${lp[0]}${lp[1]}${lp[2]}` : ''

      new_sites.push({
        ...site,
        xyz: new_xyz,
        abc: wrapped_abc,
        label: n_points > 1 ? `${site.label}${label_suffix}` : site.label,
      })
    }
  }

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
    },
    sites: new_sites,
  }
}

/**
 * Wrap a molecule (no lattice) in an orthorhombic vacuum box
 * so it can be used with periodic codes like VASP.
 * @param molecule - PymatgenMolecule without a lattice
 * @param padding - Vacuum padding in Angstroms on each side (default 10)
 * @returns PymatgenStructure with an orthorhombic lattice
 */
export function wrap_molecule_in_box(
  molecule: PymatgenMolecule,
  padding: number = 10,
): PymatgenStructure {
  if (!Number.isFinite(padding) || padding < 0) padding = 10
  const sites = molecule.sites
  if (sites.length === 0) {
    const box_size = Math.max(2 * padding, 1.0)
    const matrix: [Vec3, Vec3, Vec3] = [[box_size, 0, 0], [0, box_size, 0], [0, 0, box_size]]
    const params = matrix_to_params(matrix)
    return {
      ...molecule,
      lattice: {
        matrix,
        a: params.a,
        b: params.b,
        c: params.c,
        alpha: params.alpha,
        beta: params.beta,
        gamma: params.gamma,
        volume: box_size ** 3,
        pbc: [true, true, true],
      },
      sites: [],
    }
  }

  // Find bounding box of all atom positions
  let min_x = Infinity, min_y = Infinity, min_z = Infinity
  let max_x = -Infinity, max_y = -Infinity, max_z = -Infinity

  for (const site of sites) {
    const [x, y, z] = site.xyz
    if (x < min_x) min_x = x
    if (y < min_y) min_y = y
    if (z < min_z) min_z = z
    if (x > max_x) max_x = x
    if (y > max_y) max_y = y
    if (z > max_z) max_z = z
  }

  // Box dimensions: span + 2*padding, minimum 1 Å per axis
  const box_x = Math.max(max_x - min_x + 2 * padding, 1.0)
  const box_y = Math.max(max_y - min_y + 2 * padding, 1.0)
  const box_z = Math.max(max_z - min_z + 2 * padding, 1.0)

  // Orthorhombic lattice matrix (diagonal)
  const matrix: [Vec3, Vec3, Vec3] = [[box_x, 0, 0], [0, box_y, 0], [0, 0, box_z]]
  const params = matrix_to_params(matrix)

  // Offset to center molecule in box (shift so min atom is at padding)
  const offset_x = padding - min_x
  const offset_y = padding - min_y
  const offset_z = padding - min_z

  // Create new sites with shifted xyz and computed fractional coords
  const new_sites = sites.map((site) => {
    const new_xyz: Vec3 = [
      site.xyz[0] + offset_x,
      site.xyz[1] + offset_y,
      site.xyz[2] + offset_z,
    ]
    const new_abc: Vec3 = [
      new_xyz[0] / box_x,
      new_xyz[1] / box_y,
      new_xyz[2] / box_z,
    ]
    return {
      ...site,
      xyz: new_xyz,
      abc: new_abc,
    }
  })

  return {
    ...molecule,
    lattice: {
      matrix,
      a: params.a,
      b: params.b,
      c: params.c,
      alpha: params.alpha,
      beta: params.beta,
      gamma: params.gamma,
      volume: box_x * box_y * box_z,
      pbc: [true, true, true],
    },
    sites: new_sites,
  }
}

/**
 * Wrap a molecule in a user-specified periodic lattice while preserving its
 * Cartesian geometry. The molecule is translated so its Cartesian centroid
 * sits at the center of the new cell, and each site's fractional coordinates
 * are recomputed from the shifted Cartesian coordinates.
 */
export function wrap_molecule_with_lattice_params(
  molecule: PymatgenMolecule,
  params: LatticeParams,
): PymatgenStructure {
  const matrix = params_to_matrix(params)
  const extracted = matrix_to_params(matrix)

  const [va, vb, vc] = matrix
  const volume = Math.abs(
    va[0] * (vb[1] * vc[2] - vb[2] * vc[1]) -
    va[1] * (vb[0] * vc[2] - vb[2] * vc[0]) +
    va[2] * (vb[0] * vc[1] - vb[1] * vc[0]),
  )

  const lattice = {
    matrix,
    a: extracted.a,
    b: extracted.b,
    c: extracted.c,
    alpha: extracted.alpha,
    beta: extracted.beta,
    gamma: extracted.gamma,
    volume,
    pbc: [true, true, true] as [boolean, boolean, boolean],
  }

  const sites = molecule.sites ?? []
  if (sites.length === 0) {
    return {
      ...molecule,
      lattice,
      sites: [],
    }
  }

  let cx = 0, cy = 0, cz = 0
  const coords = sites.map((site) => {
    const xyz = site.xyz ?? site.abc ?? [0, 0, 0]
    cx += xyz[0]; cy += xyz[1]; cz += xyz[2]
    return xyz as Vec3
  })
  cx /= sites.length; cy /= sites.length; cz /= sites.length

  const cell_center = fractional_to_cartesian([0.5, 0.5, 0.5], matrix)
  const shift: Vec3 = [
    cell_center[0] - cx,
    cell_center[1] - cy,
    cell_center[2] - cz,
  ]

  const new_sites = sites.map((site, idx) => {
    const xyz = coords[idx]
    const new_xyz: Vec3 = [
      xyz[0] + shift[0],
      xyz[1] + shift[1],
      xyz[2] + shift[2],
    ]
    return {
      ...site,
      xyz: new_xyz,
      abc: cartesian_to_fractional(new_xyz, matrix),
    }
  })

  return {
    ...molecule,
    lattice,
    sites: new_sites,
  }
}

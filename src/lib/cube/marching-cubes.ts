/**
 * Marching Cubes isosurface extraction — TypeScript port of
 * tools/cube-processor/src/marching_cubes.rs
 *
 * Features:
 * - Gradient-based vertex normals for smooth Phong shading
 * - Vertex welding (hash-based deduplication) for smaller meshes
 * - Works entirely client-side (no server required)
 */

import type { VolumetricGrid } from './parse-cube'

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

// ── Grid helpers ──────────────────────────────────────────────────────────────

/** Get voxel value at grid indices. */
function get_voxel(
  data: Float32Array,
  dims: [number, number, number],
  ix: number,
  iy: number,
  iz: number,
): number {
  return data[ix * dims[1] * dims[2] + iy * dims[2] + iz]
}

/** Convert grid indices (fractional) to Cartesian coordinates (Angstroms). */
function grid_to_cart(
  origin: [number, number, number],
  voxel_axes: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ],
  ix: number,
  iy: number,
  iz: number,
): [number, number, number] {
  return [
    origin[0] + ix * voxel_axes[0][0] + iy * voxel_axes[1][0] + iz * voxel_axes[2][0],
    origin[1] + ix * voxel_axes[0][1] + iy * voxel_axes[1][1] + iz * voxel_axes[2][1],
    origin[2] + ix * voxel_axes[0][2] + iy * voxel_axes[1][2] + iz * voxel_axes[2][2],
  ]
}

/** Compute gradient at a grid point using central differences. */
function compute_gradient(
  data: Float32Array,
  dims: [number, number, number],
  ix: number,
  iy: number,
  iz: number,
): [number, number, number] {
  const [nx, ny, nz] = dims

  let gx: number
  if (ix > 0 && ix < nx - 1) {
    gx = (get_voxel(data, dims, ix + 1, iy, iz) - get_voxel(data, dims, ix - 1, iy, iz)) * 0.5
  } else if (ix === 0) {
    gx = get_voxel(data, dims, 1, iy, iz) - get_voxel(data, dims, 0, iy, iz)
  } else {
    gx = get_voxel(data, dims, nx - 1, iy, iz) - get_voxel(data, dims, nx - 2, iy, iz)
  }

  let gy: number
  if (iy > 0 && iy < ny - 1) {
    gy = (get_voxel(data, dims, ix, iy + 1, iz) - get_voxel(data, dims, ix, iy - 1, iz)) * 0.5
  } else if (iy === 0) {
    gy = get_voxel(data, dims, ix, 1, iz) - get_voxel(data, dims, ix, 0, iz)
  } else {
    gy = get_voxel(data, dims, ix, ny - 1, iz) - get_voxel(data, dims, ix, ny - 2, iz)
  }

  let gz: number
  if (iz > 0 && iz < nz - 1) {
    gz = (get_voxel(data, dims, ix, iy, iz + 1) - get_voxel(data, dims, ix, iy, iz - 1)) * 0.5
  } else if (iz === 0) {
    gz = get_voxel(data, dims, ix, iy, 1) - get_voxel(data, dims, ix, iy, 0)
  } else {
    gz = get_voxel(data, dims, ix, iy, nz - 1) - get_voxel(data, dims, ix, iy, nz - 2)
  }

  // Negate: normal points from high to low density
  return [-gx, -gy, -gz]
}

// ── Vertex welding ────────────────────────────────────────────────────────────

/** Quantize a float to ~0.001 Å precision for deduplication key. */
function quantize(v: number): number {
  return Math.round(v * 1000)
}

/** Build collision-free key for vertex deduplication. */
function vertex_key(x: number, y: number, z: number): string {
  return `${quantize(x)},${quantize(y)},${quantize(z)}`
}

/** Add a vertex with welding (deduplication). Returns vertex index. */
function add_vertex_welded(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  positions: number[],
  normals: number[],
  vertex_map: Map<string, number>,
): number {
  const key = vertex_key(x, y, z)
  const existing = vertex_map.get(key)
  if (existing !== undefined) {
    // Accumulate normals for shared vertices (smoother shading)
    const base = existing * 3
    normals[base] += nx
    normals[base + 1] += ny
    normals[base + 2] += nz
    return existing
  }

  const idx = (positions.length / 3) | 0
  positions.push(x, y, z)
  normals.push(nx, ny, nz)
  vertex_map.set(key, idx)
  return idx
}

// ── Core marching cubes ───────────────────────────────────────────────────────

// Edge endpoints: each edge connects two of the 8 cube corners
const EDGE_ENDPOINTS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

// Corner offsets: [dx, dy, dz] for each of the 8 cube corners
const CORNER_OFFSETS: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
]

/**
 * Compute the inverse-transpose of the 3x3 voxel axes matrix.
 * Used to transform gradients from grid-index space to Cartesian space:
 *   normal_cart = M^(-T) * normal_grid
 */
function compute_inv_transpose(
  voxel_axes: [[number, number, number], [number, number, number], [number, number, number]],
): [[number, number, number], [number, number, number], [number, number, number]] {
  // voxel_axes[i] is the Cartesian vector for axis i
  // M = [voxel_axes[0], voxel_axes[1], voxel_axes[2]] as rows → M maps grid to cart
  const a = voxel_axes
  // Compute determinant
  const det =
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  if (Math.abs(det) < 1e-30) {
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]] // fallback to identity
  }
  const inv_det = 1.0 / det
  // Inverse matrix (row-major)
  const inv: [[number, number, number], [number, number, number], [number, number, number]] = [
    [
      (a[1][1] * a[2][2] - a[1][2] * a[2][1]) * inv_det,
      (a[0][2] * a[2][1] - a[0][1] * a[2][2]) * inv_det,
      (a[0][1] * a[1][2] - a[0][2] * a[1][1]) * inv_det,
    ],
    [
      (a[1][2] * a[2][0] - a[1][0] * a[2][2]) * inv_det,
      (a[0][0] * a[2][2] - a[0][2] * a[2][0]) * inv_det,
      (a[0][2] * a[1][0] - a[0][0] * a[1][2]) * inv_det,
    ],
    [
      (a[1][0] * a[2][1] - a[1][1] * a[2][0]) * inv_det,
      (a[0][1] * a[2][0] - a[0][0] * a[2][1]) * inv_det,
      (a[0][0] * a[1][1] - a[0][1] * a[1][0]) * inv_det,
    ],
  ]
  // Return transpose of inverse = inv^T (columns become rows)
  return [
    [inv[0][0], inv[1][0], inv[2][0]],
    [inv[0][1], inv[1][1], inv[2][1]],
    [inv[0][2], inv[1][2], inv[2][2]],
  ]
}

// ── Post-processing: Laplacian smoothing ──────────────────────────────────────

/**
 * Laplacian mesh smoothing: moves each vertex toward the average of its
 * neighbors to reduce staircase artifacts from marching cubes.
 * Uses Taubin smoothing (alternating λ/μ) to prevent mesh shrinkage.
 */
function smooth_mesh(
  positions: Float32Array,
  indices: Uint32Array,
  iterations: number,
): void {
  const n_verts = (positions.length / 3) | 0
  if (n_verts === 0 || iterations <= 0) return

  // Build adjacency list from triangles
  const neighbors: Set<number>[] = new Array(n_verts)
  for (let i = 0; i < n_verts; i++) neighbors[i] = new Set()
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2]
    neighbors[a].add(b); neighbors[a].add(c)
    neighbors[b].add(a); neighbors[b].add(c)
    neighbors[c].add(a); neighbors[c].add(b)
  }

  // Taubin smoothing: λ = 0.5, μ = -0.53 (prevents shrinkage)
  const lambda = 0.5
  const mu = -0.53
  const temp = new Float32Array(positions.length)

  for (let iter = 0; iter < iterations; iter++) {
    // Forward pass (λ)
    laplacian_pass(positions, neighbors, n_verts, lambda, temp)
    // Backward pass (μ)
    laplacian_pass(positions, neighbors, n_verts, mu, temp)
  }
}

function laplacian_pass(
  positions: Float32Array,
  neighbors: Set<number>[],
  n_verts: number,
  factor: number,
  temp: Float32Array,
): void {
  temp.set(positions)
  for (let i = 0; i < n_verts; i++) {
    const nbrs = neighbors[i]
    if (nbrs.size === 0) continue
    let ax = 0, ay = 0, az = 0
    for (const j of nbrs) {
      ax += temp[j * 3]
      ay += temp[j * 3 + 1]
      az += temp[j * 3 + 2]
    }
    const inv = 1 / nbrs.size
    ax *= inv; ay *= inv; az *= inv
    const b = i * 3
    positions[b] += factor * (ax - temp[b])
    positions[b + 1] += factor * (ay - temp[b + 1])
    positions[b + 2] += factor * (az - temp[b + 2])
  }
}

/**
 * Recompute smooth vertex normals from triangle face normals.
 * Area-weighted: larger faces contribute more to the vertex normal.
 */
function recompute_normals(
  positions: Float32Array,
  indices: Uint32Array,
  normals: Float32Array,
): void {
  normals.fill(0)
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i], ib = indices[i + 1], ic = indices[i + 2]
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2]
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2]
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2]
    // Cross product (b-a) × (c-a) — magnitude = 2 * triangle area
    const ex1 = bx - ax, ey1 = by - ay, ez1 = bz - az
    const ex2 = cx - ax, ey2 = cy - ay, ez2 = cz - az
    const fnx = ey1 * ez2 - ez1 * ey2
    const fny = ez1 * ex2 - ex1 * ez2
    const fnz = ex1 * ey2 - ey1 * ex2
    // Accumulate (area-weighted by default since we don't normalize face normal)
    normals[ia * 3] += fnx; normals[ia * 3 + 1] += fny; normals[ia * 3 + 2] += fnz
    normals[ib * 3] += fnx; normals[ib * 3 + 1] += fny; normals[ib * 3 + 2] += fnz
    normals[ic * 3] += fnx; normals[ic * 3 + 1] += fny; normals[ic * 3 + 2] += fnz
  }
  // Normalize
  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2]
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len > 1e-8) {
      normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len
    }
  }
}

/**
 * Extract an isosurface from volumetric grid data at the given isovalue.
 * Returns vertex positions, normals, and triangle indices.
 * Applies Taubin smoothing (2 iterations) to reduce marching cubes staircase artifacts.
 */
export function extract_isosurface(grid: VolumetricGrid, isovalue: number): MeshData {
  const { data, dims, origin, voxel_axes } = grid
  const [nx, ny, nz] = dims

  // Precompute inverse-transpose for transforming normals from grid to Cartesian space
  const inv_t = compute_inv_transpose(voxel_axes)

  // Use regular arrays for dynamic growth, convert to typed at end
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const vertex_map = new Map<string, number>()

  // For each voxel cube
  for (let ix = 0; ix < nx - 1; ix++) {
    for (let iy = 0; iy < ny - 1; iy++) {
      for (let iz = 0; iz < nz - 1; iz++) {
        // Get 8 corner values
        const vals: number[] = new Array(8)
        for (let c = 0; c < 8; c++) {
          vals[c] = get_voxel(
            data,
            dims,
            ix + CORNER_OFFSETS[c][0],
            iy + CORNER_OFFSETS[c][1],
            iz + CORNER_OFFSETS[c][2],
          )
        }

        // Compute cube index
        let cube_index = 0
        for (let c = 0; c < 8; c++) {
          if (vals[c] >= isovalue) cube_index |= 1 << c
        }

        // Skip if entirely inside or outside
        const edge_bits = EDGE_TABLE[cube_index]
        if (edge_bits === 0) continue

        // Compute corner grid positions
        const corners: [number, number, number][] = new Array(8)
        for (let c = 0; c < 8; c++) {
          corners[c] = [
            ix + CORNER_OFFSETS[c][0],
            iy + CORNER_OFFSETS[c][1],
            iz + CORNER_OFFSETS[c][2],
          ]
        }

        // Compute gradients at corners
        const grads: [number, number, number][] = new Array(8)
        for (let c = 0; c < 8; c++) {
          grads[c] = compute_gradient(data, dims, corners[c][0], corners[c][1], corners[c][2])
        }

        // Compute edge vertices
        const edge_verts: number[] = new Array(12).fill(0)
        for (let e = 0; e < 12; e++) {
          if ((edge_bits & (1 << e)) === 0) continue

          const [a, b] = EDGE_ENDPOINTS[e]
          const va = vals[a]
          const vb = vals[b]

          // Linear interpolation parameter
          const diff = vb - va
          const t = Math.abs(diff) < 1e-12 ? 0.5 : Math.max(0, Math.min(1, (isovalue - va) / diff))

          // Interpolate grid position
          const gx = corners[a][0] + t * (corners[b][0] - corners[a][0])
          const gy = corners[a][1] + t * (corners[b][1] - corners[a][1])
          const gz = corners[a][2] + t * (corners[b][2] - corners[a][2])

          // Convert to Cartesian
          const cart = grid_to_cart(origin, voxel_axes, gx, gy, gz)

          // Interpolate gradient in grid space
          const gnx = grads[a][0] + t * (grads[b][0] - grads[a][0])
          const gny = grads[a][1] + t * (grads[b][1] - grads[a][1])
          const gnz = grads[a][2] + t * (grads[b][2] - grads[a][2])

          // Transform normal from grid-index space to Cartesian space: n_cart = M^(-T) * n_grid
          let enx = inv_t[0][0] * gnx + inv_t[0][1] * gny + inv_t[0][2] * gnz
          let eny = inv_t[1][0] * gnx + inv_t[1][1] * gny + inv_t[1][2] * gnz
          let enz = inv_t[2][0] * gnx + inv_t[2][1] * gny + inv_t[2][2] * gnz

          // Normalize
          const len = Math.sqrt(enx * enx + eny * eny + enz * enz)
          if (len > 1e-8) {
            enx /= len
            eny /= len
            enz /= len
          } else {
            enx = 0
            eny = 1
            enz = 0
          }

          edge_verts[e] = add_vertex_welded(
            cart[0],
            cart[1],
            cart[2],
            enx,
            eny,
            enz,
            positions,
            normals,
            vertex_map,
          )
        }

        // Generate triangles from lookup table
        const tri_row = TRI_TABLE[cube_index]
        let t = 0
        while (t < 16 && tri_row[t] !== -1) {
          indices.push(edge_verts[tri_row[t]])
          indices.push(edge_verts[tri_row[t + 1]])
          indices.push(edge_verts[tri_row[t + 2]])
          t += 3
        }
      }
    }
  }

  const pos_out = new Float32Array(positions)
  const norm_out = new Float32Array(normals)
  const idx_out = new Uint32Array(indices)

  // Taubin smoothing: 2 iterations reduces staircase artifacts without over-smoothing
  smooth_mesh(pos_out, idx_out, 2)

  // Recompute normals from face geometry after smoothing (more accurate than
  // gradient-based normals for smoothed meshes)
  recompute_normals(pos_out, idx_out, norm_out)

  return {
    positions: pos_out,
    normals: norm_out,
    indices: idx_out,
  }
}

// ── Marching Cubes Lookup Tables ──────────────────────────────────────────────
// Standard tables from Paul Bourke's implementation
// Copied from tools/cube-processor/src/marching_cubes.rs

/** Edge table: for each of 256 cube configurations, which edges are intersected */
// prettier-ignore
const EDGE_TABLE: number[] = [
  0x000, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c, 0x80c, 0x905, 0xa0f, 0xb06, 0xc0a,
  0xd03, 0xe09, 0xf00, 0x190, 0x099, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c, 0x99c, 0x895,
  0xb9f, 0xa96, 0xd9a, 0xc93, 0xf99, 0xe90, 0x230, 0x339, 0x033, 0x13a, 0x636, 0x73f, 0x435,
  0x53c, 0xa3c, 0xb35, 0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30, 0x3a0, 0x2a9, 0x1a3, 0x0aa,
  0x7a6, 0x6af, 0x5a5, 0x4ac, 0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0, 0x460,
  0x569, 0x663, 0x76a, 0x066, 0x16f, 0x265, 0x36c, 0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963,
  0xa69, 0xb60, 0x5f0, 0x4f9, 0x7f3, 0x6fa, 0x1f6, 0x0ff, 0x3f5, 0x2fc, 0xdfc, 0xcf5, 0xfff,
  0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0, 0x650, 0x759, 0x453, 0x55a, 0x256, 0x35f, 0x055, 0x15c,
  0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950, 0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6,
  0x2cf, 0x1c5, 0x0cc, 0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3, 0x9c9, 0x8c0, 0x8c0, 0x9c9,
  0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc, 0x0cc, 0x1c5, 0x2cf, 0x3c6, 0x4ca, 0x5c3, 0x6c9,
  0x7c0, 0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c, 0x15c, 0x055, 0x35f, 0x256,
  0x55a, 0x453, 0x759, 0x650, 0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc, 0x2fc,
  0x3f5, 0x0ff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0, 0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f,
  0xd65, 0xc6c, 0x36c, 0x265, 0x16f, 0x066, 0x76a, 0x663, 0x569, 0x460, 0xca0, 0xda9, 0xea3,
  0xfaa, 0x8a6, 0x9af, 0xaa5, 0xbac, 0x4ac, 0x5a5, 0x6af, 0x7a6, 0x0aa, 0x1a3, 0x2a9, 0x3a0,
  0xd30, 0xc39, 0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c, 0x53c, 0x435, 0x73f, 0x636, 0x13a,
  0x033, 0x339, 0x230, 0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c, 0x69c, 0x795,
  0x49f, 0x596, 0x29a, 0x393, 0x099, 0x190, 0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905,
  0x80c, 0x70c, 0x605, 0x50f, 0x406, 0x30a, 0x203, 0x109, 0x000,
]

/** Triangle table: for each cube configuration, list of edge indices forming triangles. -1 terminates. */
// prettier-ignore
const TRI_TABLE: number[][] = [
  [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,1,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,8,3,9,8,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,2,10,0,2,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,8,3,2,10,8,10,9,8,-1,-1,-1,-1,-1,-1,-1],
  [3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,11,2,8,11,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,9,0,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,11,2,1,9,11,9,8,11,-1,-1,-1,-1,-1,-1,-1],
  [3,10,1,11,10,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,10,1,0,8,10,8,11,10,-1,-1,-1,-1,-1,-1,-1],
  [3,9,0,3,11,9,11,10,9,-1,-1,-1,-1,-1,-1,-1],
  [9,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,3,0,7,3,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,1,9,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,1,9,4,7,1,7,3,1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,4,7,3,0,4,1,2,10,-1,-1,-1,-1,-1,-1,-1],
  [9,2,10,9,0,2,8,4,7,-1,-1,-1,-1,-1,-1,-1],
  [2,10,9,2,9,7,2,7,3,7,9,4,-1,-1,-1,-1],
  [8,4,7,3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [11,4,7,11,2,4,2,0,4,-1,-1,-1,-1,-1,-1,-1],
  [9,0,1,8,4,7,2,3,11,-1,-1,-1,-1,-1,-1,-1],
  [4,7,11,9,4,11,9,11,2,9,2,1,-1,-1,-1,-1],
  [3,10,1,3,11,10,7,8,4,-1,-1,-1,-1,-1,-1,-1],
  [1,11,10,1,4,11,1,0,4,7,11,4,-1,-1,-1,-1],
  [4,7,8,9,0,11,9,11,10,11,0,3,-1,-1,-1,-1],
  [4,7,11,4,11,9,9,11,10,-1,-1,-1,-1,-1,-1,-1],
  [9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,5,4,0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,5,4,1,5,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [8,5,4,8,3,5,3,1,5,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,0,8,1,2,10,4,9,5,-1,-1,-1,-1,-1,-1,-1],
  [5,2,10,5,4,2,4,0,2,-1,-1,-1,-1,-1,-1,-1],
  [2,10,5,3,2,5,3,5,4,3,4,8,-1,-1,-1,-1],
  [9,5,4,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,11,2,0,8,11,4,9,5,-1,-1,-1,-1,-1,-1,-1],
  [0,5,4,0,1,5,2,3,11,-1,-1,-1,-1,-1,-1,-1],
  [2,1,5,2,5,8,2,8,11,4,8,5,-1,-1,-1,-1],
  [10,3,11,10,1,3,9,5,4,-1,-1,-1,-1,-1,-1,-1],
  [4,9,5,0,8,1,8,10,1,8,11,10,-1,-1,-1,-1],
  [5,4,0,5,0,11,5,11,10,11,0,3,-1,-1,-1,-1],
  [5,4,8,5,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1],
  [9,7,8,5,7,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,3,0,9,5,3,5,7,3,-1,-1,-1,-1,-1,-1,-1],
  [0,7,8,0,1,7,1,5,7,-1,-1,-1,-1,-1,-1,-1],
  [1,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,7,8,9,5,7,10,1,2,-1,-1,-1,-1,-1,-1,-1],
  [10,1,2,9,5,0,5,3,0,5,7,3,-1,-1,-1,-1],
  [8,0,2,8,2,5,8,5,7,10,5,2,-1,-1,-1,-1],
  [2,10,5,2,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1],
  [7,9,5,7,8,9,3,11,2,-1,-1,-1,-1,-1,-1,-1],
  [9,5,7,9,7,2,9,2,0,2,7,11,-1,-1,-1,-1],
  [2,3,11,0,1,8,1,7,8,1,5,7,-1,-1,-1,-1],
  [11,2,1,11,1,7,7,1,5,-1,-1,-1,-1,-1,-1,-1],
  [9,5,8,8,5,7,10,1,3,10,3,11,-1,-1,-1,-1],
  [5,7,0,5,0,9,7,11,0,1,0,10,11,10,0,-1],
  [11,10,0,11,0,3,10,5,0,8,0,7,5,7,0,-1],
  [11,10,5,7,11,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,0,1,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,8,3,1,9,8,5,10,6,-1,-1,-1,-1,-1,-1,-1],
  [1,6,5,2,6,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,6,5,1,2,6,3,0,8,-1,-1,-1,-1,-1,-1,-1],
  [9,6,5,9,0,6,0,2,6,-1,-1,-1,-1,-1,-1,-1],
  [5,9,8,5,8,2,5,2,6,3,2,8,-1,-1,-1,-1],
  [2,3,11,10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [11,0,8,11,2,0,10,6,5,-1,-1,-1,-1,-1,-1,-1],
  [0,1,9,2,3,11,5,10,6,-1,-1,-1,-1,-1,-1,-1],
  [5,10,6,1,9,2,9,11,2,9,8,11,-1,-1,-1,-1],
  [6,3,11,6,5,3,5,1,3,-1,-1,-1,-1,-1,-1,-1],
  [0,8,11,0,11,5,0,5,1,5,11,6,-1,-1,-1,-1],
  [3,11,6,0,3,6,0,6,5,0,5,9,-1,-1,-1,-1],
  [6,5,9,6,9,11,11,9,8,-1,-1,-1,-1,-1,-1,-1],
  [5,10,6,4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,3,0,4,7,3,6,5,10,-1,-1,-1,-1,-1,-1,-1],
  [1,9,0,5,10,6,8,4,7,-1,-1,-1,-1,-1,-1,-1],
  [10,6,5,1,9,7,1,7,3,7,9,4,-1,-1,-1,-1],
  [6,1,2,6,5,1,4,7,8,-1,-1,-1,-1,-1,-1,-1],
  [1,2,5,5,2,6,3,0,4,3,4,7,-1,-1,-1,-1],
  [8,4,7,9,0,5,0,6,5,0,2,6,-1,-1,-1,-1],
  [7,3,9,7,9,4,3,2,9,5,9,6,2,6,9,-1],
  [3,11,2,7,8,4,10,6,5,-1,-1,-1,-1,-1,-1,-1],
  [5,10,6,4,7,2,4,2,0,2,7,11,-1,-1,-1,-1],
  [0,1,9,4,7,8,2,3,11,5,10,6,-1,-1,-1,-1],
  [9,2,1,9,11,2,9,4,11,7,11,4,5,10,6,-1],
  [8,4,7,3,11,5,3,5,1,5,11,6,-1,-1,-1,-1],
  [5,1,11,5,11,6,1,0,11,7,11,4,0,4,11,-1],
  [0,5,9,0,6,5,0,3,6,11,6,3,8,4,7,-1],
  [6,5,9,6,9,11,4,7,9,7,11,9,-1,-1,-1,-1],
  [10,4,9,6,4,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,10,6,4,9,10,0,8,3,-1,-1,-1,-1,-1,-1,-1],
  [10,0,1,10,6,0,6,4,0,-1,-1,-1,-1,-1,-1,-1],
  [8,3,1,8,1,6,8,6,4,6,1,10,-1,-1,-1,-1],
  [1,4,9,1,2,4,2,6,4,-1,-1,-1,-1,-1,-1,-1],
  [3,0,8,1,2,9,2,4,9,2,6,4,-1,-1,-1,-1],
  [0,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [8,3,2,8,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1],
  [10,4,9,10,6,4,11,2,3,-1,-1,-1,-1,-1,-1,-1],
  [0,8,2,2,8,11,4,9,10,4,10,6,-1,-1,-1,-1],
  [3,11,2,0,1,6,0,6,4,6,1,10,-1,-1,-1,-1],
  [6,4,1,6,1,10,4,8,1,2,1,11,8,11,1,-1],
  [9,6,4,9,3,6,9,1,3,11,6,3,-1,-1,-1,-1],
  [8,11,1,8,1,0,11,6,1,9,1,4,6,4,1,-1],
  [3,11,6,3,6,0,0,6,4,-1,-1,-1,-1,-1,-1,-1],
  [6,4,8,11,6,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [7,10,6,7,8,10,8,9,10,-1,-1,-1,-1,-1,-1,-1],
  [0,7,3,0,10,7,0,9,10,6,7,10,-1,-1,-1,-1],
  [10,6,7,1,10,7,1,7,8,1,8,0,-1,-1,-1,-1],
  [10,6,7,10,7,1,1,7,3,-1,-1,-1,-1,-1,-1,-1],
  [1,2,6,1,6,8,1,8,9,8,6,7,-1,-1,-1,-1],
  [2,6,9,2,9,1,6,7,9,0,9,3,7,3,9,-1],
  [7,8,0,7,0,6,6,0,2,-1,-1,-1,-1,-1,-1,-1],
  [7,3,2,6,7,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,3,11,10,6,8,10,8,9,8,6,7,-1,-1,-1,-1],
  [2,0,7,2,7,11,0,9,7,6,7,10,9,10,7,-1],
  [1,8,0,1,7,8,1,10,7,6,7,10,2,3,11,-1],
  [11,2,1,11,1,7,10,6,1,6,7,1,-1,-1,-1,-1],
  [8,9,6,8,6,7,9,1,6,11,6,3,1,3,6,-1],
  [0,9,1,11,6,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [7,8,0,7,0,6,3,11,0,11,6,0,-1,-1,-1,-1],
  [7,11,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,0,8,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,1,9,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [8,1,9,8,3,1,11,7,6,-1,-1,-1,-1,-1,-1,-1],
  [10,1,2,6,11,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,3,0,8,6,11,7,-1,-1,-1,-1,-1,-1,-1],
  [2,9,0,2,10,9,6,11,7,-1,-1,-1,-1,-1,-1,-1],
  [6,11,7,2,10,3,10,8,3,10,9,8,-1,-1,-1,-1],
  [7,2,3,6,2,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [7,0,8,7,6,0,6,2,0,-1,-1,-1,-1,-1,-1,-1],
  [2,7,6,2,3,7,0,1,9,-1,-1,-1,-1,-1,-1,-1],
  [1,6,2,1,8,6,1,9,8,8,7,6,-1,-1,-1,-1],
  [10,7,6,10,1,7,1,3,7,-1,-1,-1,-1,-1,-1,-1],
  [10,7,6,1,7,10,1,8,7,1,0,8,-1,-1,-1,-1],
  [0,3,7,0,7,10,0,10,9,6,10,7,-1,-1,-1,-1],
  [7,6,10,7,10,8,8,10,9,-1,-1,-1,-1,-1,-1,-1],
  [6,8,4,11,8,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,6,11,3,0,6,0,4,6,-1,-1,-1,-1,-1,-1,-1],
  [8,6,11,8,4,6,9,0,1,-1,-1,-1,-1,-1,-1,-1],
  [9,4,6,9,6,3,9,3,1,11,3,6,-1,-1,-1,-1],
  [6,8,4,6,11,8,2,10,1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,3,0,11,0,6,11,0,4,6,-1,-1,-1,-1],
  [4,11,8,4,6,11,0,2,9,2,10,9,-1,-1,-1,-1],
  [10,9,3,10,3,2,9,4,3,11,3,6,4,6,3,-1],
  [8,2,3,8,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1],
  [0,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,9,0,2,3,4,2,4,6,4,3,8,-1,-1,-1,-1],
  [1,9,4,1,4,2,2,4,6,-1,-1,-1,-1,-1,-1,-1],
  [8,1,3,8,6,1,8,4,6,6,10,1,-1,-1,-1,-1],
  [10,1,0,10,0,6,6,0,4,-1,-1,-1,-1,-1,-1,-1],
  [4,6,3,4,3,8,6,10,3,0,3,9,10,9,3,-1],
  [10,9,4,6,10,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,9,5,7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,4,9,5,11,7,6,-1,-1,-1,-1,-1,-1,-1],
  [5,0,1,5,4,0,7,6,11,-1,-1,-1,-1,-1,-1,-1],
  [11,7,6,8,3,4,3,5,4,3,1,5,-1,-1,-1,-1],
  [9,5,4,10,1,2,7,6,11,-1,-1,-1,-1,-1,-1,-1],
  [6,11,7,1,2,10,0,8,3,4,9,5,-1,-1,-1,-1],
  [7,6,11,5,4,10,4,2,10,4,0,2,-1,-1,-1,-1],
  [3,4,8,3,5,4,3,2,5,10,5,2,11,7,6,-1],
  [7,2,3,7,6,2,5,4,9,-1,-1,-1,-1,-1,-1,-1],
  [9,5,4,0,8,6,0,6,2,6,8,7,-1,-1,-1,-1],
  [3,6,2,3,7,6,1,5,0,5,4,0,-1,-1,-1,-1],
  [6,2,8,6,8,7,2,1,8,4,8,5,1,5,8,-1],
  [9,5,4,10,1,6,1,7,6,1,3,7,-1,-1,-1,-1],
  [1,6,10,1,7,6,1,0,7,8,7,0,9,5,4,-1],
  [4,0,10,4,10,5,0,3,10,6,10,7,3,7,10,-1],
  [7,6,10,7,10,8,5,4,10,4,8,10,-1,-1,-1,-1],
  [6,9,5,6,11,9,11,8,9,-1,-1,-1,-1,-1,-1,-1],
  [3,6,11,0,6,3,0,5,6,0,9,5,-1,-1,-1,-1],
  [0,11,8,0,5,11,0,1,5,5,6,11,-1,-1,-1,-1],
  [6,11,3,6,3,5,5,3,1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,9,5,11,9,11,8,11,5,6,-1,-1,-1,-1],
  [0,11,3,0,6,11,0,9,6,5,6,9,1,2,10,-1],
  [11,8,5,11,5,6,8,0,5,10,5,2,0,2,5,-1],
  [6,11,3,6,3,5,2,10,3,10,5,3,-1,-1,-1,-1],
  [5,8,9,5,2,8,5,6,2,3,8,2,-1,-1,-1,-1],
  [9,5,6,9,6,0,0,6,2,-1,-1,-1,-1,-1,-1,-1],
  [1,5,8,1,8,0,5,6,8,3,8,2,6,2,8,-1],
  [1,5,6,2,1,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,3,6,1,6,10,3,8,6,5,6,9,8,9,6,-1],
  [10,1,0,10,0,6,9,5,0,5,6,0,-1,-1,-1,-1],
  [0,3,8,5,6,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [10,5,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [11,5,10,7,5,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [11,5,10,11,7,5,8,3,0,-1,-1,-1,-1,-1,-1,-1],
  [5,11,7,5,10,11,1,9,0,-1,-1,-1,-1,-1,-1,-1],
  [10,7,5,10,11,7,9,8,1,8,3,1,-1,-1,-1,-1],
  [11,1,2,11,7,1,7,5,1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,1,2,7,1,7,5,7,2,11,-1,-1,-1,-1],
  [9,7,5,9,2,7,9,0,2,2,11,7,-1,-1,-1,-1],
  [7,5,2,7,2,11,5,9,2,3,2,8,9,8,2,-1],
  [2,5,10,2,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1],
  [8,2,0,8,5,2,8,7,5,10,2,5,-1,-1,-1,-1],
  [9,0,1,5,10,3,5,3,7,3,10,2,-1,-1,-1,-1],
  [9,8,2,9,2,1,8,7,2,10,2,5,7,5,2,-1],
  [1,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,7,0,7,1,1,7,5,-1,-1,-1,-1,-1,-1,-1],
  [9,0,3,9,3,5,5,3,7,-1,-1,-1,-1,-1,-1,-1],
  [9,8,7,5,9,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [5,8,4,5,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1],
  [5,0,4,5,11,0,5,10,11,11,3,0,-1,-1,-1,-1],
  [0,1,9,8,4,10,8,10,11,10,4,5,-1,-1,-1,-1],
  [10,11,4,10,4,5,11,3,4,9,4,1,3,1,4,-1],
  [2,5,1,2,8,5,2,11,8,4,5,8,-1,-1,-1,-1],
  [0,4,11,0,11,3,4,5,11,2,11,1,5,1,11,-1],
  [0,2,5,0,5,9,2,11,5,4,5,8,11,8,5,-1],
  [9,4,5,2,11,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,5,10,3,5,2,3,4,5,3,8,4,-1,-1,-1,-1],
  [5,10,2,5,2,4,4,2,0,-1,-1,-1,-1,-1,-1,-1],
  [3,10,2,3,5,10,3,8,5,4,5,8,0,1,9,-1],
  [5,10,2,5,2,4,1,9,2,9,4,2,-1,-1,-1,-1],
  [8,4,5,8,5,3,3,5,1,-1,-1,-1,-1,-1,-1,-1],
  [0,4,5,1,0,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [8,4,5,8,5,3,9,0,5,0,3,5,-1,-1,-1,-1],
  [9,4,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,11,7,4,9,11,9,10,11,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,4,9,7,9,11,7,9,10,11,-1,-1,-1,-1],
  [1,10,11,1,11,4,1,4,0,7,4,11,-1,-1,-1,-1],
  [3,1,4,3,4,8,1,10,4,7,4,11,10,11,4,-1],
  [4,11,7,9,11,4,9,2,11,9,1,2,-1,-1,-1,-1],
  [9,7,4,9,11,7,9,1,11,2,11,1,0,8,3,-1],
  [11,7,4,11,4,2,2,4,0,-1,-1,-1,-1,-1,-1,-1],
  [11,7,4,11,4,2,8,3,4,3,2,4,-1,-1,-1,-1],
  [2,9,10,2,7,9,2,3,7,7,4,9,-1,-1,-1,-1],
  [9,10,7,9,7,4,10,2,7,8,7,0,2,0,7,-1],
  [3,7,10,3,10,2,7,4,10,1,10,0,4,0,10,-1],
  [1,10,2,8,7,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,9,1,4,1,7,7,1,3,-1,-1,-1,-1,-1,-1,-1],
  [4,9,1,4,1,7,0,8,1,8,7,1,-1,-1,-1,-1],
  [4,0,3,7,4,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,8,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,0,9,3,9,11,11,9,10,-1,-1,-1,-1,-1,-1,-1],
  [0,1,10,0,10,8,8,10,11,-1,-1,-1,-1,-1,-1,-1],
  [3,1,10,11,3,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,11,1,11,9,9,11,8,-1,-1,-1,-1,-1,-1,-1],
  [3,0,9,3,9,11,1,2,9,2,11,9,-1,-1,-1,-1],
  [0,2,11,8,0,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,2,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,3,8,2,8,10,10,8,9,-1,-1,-1,-1,-1,-1,-1],
  [9,10,2,0,9,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,3,8,2,8,10,0,1,8,1,10,8,-1,-1,-1,-1],
  [1,10,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,3,8,9,1,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,9,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,3,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
]

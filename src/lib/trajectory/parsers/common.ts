// Common constants, interfaces, and utilities for trajectory parsers
import type { AnyStructure, ElementSymbol, Pbc, Vec3 } from '$lib'
import { atomic_number_to_symbol } from '$lib/composition/parse'
import { COMPRESSION_EXTENSIONS_REGEX } from '$lib/constants'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { TrajectoryFrame } from '../index'

// Constants for large file handling
export const MAX_SAFE_STRING_LENGTH = 0x1fffffe8 * 0.5 // 50% of JS max string length as safety
export const MAX_METADATA_SIZE = 50 * 1024 * 1024 // 50MB limit for metadata
export const LARGE_FILE_THRESHOLD = 400 * 1024 * 1024 // 400MB
export const INDEX_SAMPLE_RATE = 100 // Default sample rate for frame indexing
export const MAX_BIN_FILE_SIZE = 100 * 1024 * 1024 // 100MB default for ArrayBuffer files
export const MAX_TEXT_FILE_SIZE = 50 * 1024 * 1024 // 50MB default for string files

// Common interfaces

export interface LoadingOptions {
  use_indexing?: boolean
  buffer_size?: number
  index_sample_rate?: number
  extract_plot_metadata?: boolean
  bin_file_threshold?: number // Threshold in bytes for ArrayBuffer files (default: MAX_BIN_FILE_SIZE)
  text_file_threshold?: number // Threshold in bytes for string files (default: MAX_TEXT_FILE_SIZE)
}

// Cache for optimization
const matrix_cache = new WeakMap<Matrix3x3, Matrix3x3>()
export const get_inverse_matrix = (matrix: Matrix3x3): Matrix3x3 => {
  const cached = matrix_cache.get(matrix)
  if (cached) return cached
  const inverse = math.matrix_inverse_3x3(matrix)
  matrix_cache.set(matrix, inverse)
  return inverse
}

// Unified utilities
export const convert_atomic_numbers = (numbers: number[]): ElementSymbol[] =>
  numbers.map((num) => atomic_number_to_symbol[num] || `X`)

export const create_structure = (
  positions: number[][],
  elements: ElementSymbol[],
  lattice_matrix?: Matrix3x3,
  pbc?: Pbc,
  force_data?: number[][],
  move_mask?: boolean[],
): AnyStructure => {
  // extxyz/pymatgen lattice rows = a,b,c ⇒ cart = Mᵀ·frac ⇒ frac = inv(Mᵀ)·cart.
  // inv(M) here silently breaks only non-orthogonal cells (M ≠ Mᵀ); matches pbc.ts.
  const lattice_T = lattice_matrix ? math.transpose_3x3_matrix(lattice_matrix) : null
  const inv_matrix = lattice_T ? math.matrix_inverse_3x3(lattice_T) : null
  // Pre-compute fractional coords for all atoms so the wrap-decision pass
  // can do a near-neighbor check in raw Cartesian without re-deriving abc.
  const initial_abcs: Vec3[] = positions.map((pos) =>
    inv_matrix
      ? math.mat3x3_vec3_multiply(inv_matrix, pos as Vec3)
      : [0, 0, 0] as Vec3
  )
  // Threshold for the heuristic-wrap near-neighbor check. Conservative
  // covalent bond max (Å). Larger than typical bond lengths; smaller than
  // half a typical lattice parameter for molecular crystals.
  const NEAR_NEIGHBOR_BOND_DIST_SQ = 2.0 * 2.0
  const sites = positions.map((pos, idx) => {
    let xyz = pos as Vec3
    let abc = initial_abcs[idx]
    // When fractional coords land outside [0, 1), wrap into the canonical
    // cell. There are two scenarios where this matters:
    //   (1) Frozen atoms (move_mask === false) placed at boundary-adjacent
    //       fractional coords like -0.012 or 1.034 by the simulation
    //       setup. Chemically identical to 0.988 or 0.034 but the bonder's
    //       spatial grid mishandles negative coords → visual orphans.
    //   (2) Movable atoms (move_mask !== false) whose wrapped position
    //       sits within bond distance of another atom in raw Cartesian.
    //       These are atoms whose simulation file represented them just
    //       outside the cell despite their bonded partner sitting inside;
    //       wrap brings them next to the partner where they belong. The
    //       "raw Cartesian" check is critical: it correctly distinguishes
    //       this case from a molecule straddling PBC (e.g., water with O
    //       inside and H unwrapped just outside — H's wrapped position
    //       lands far from O in raw Cartesian, so we DON'T wrap H,
    //       preserving molecule continuity). See the trajectory-bond
    //       handoff report (2026-05-02) for the failure case this avoids.
    const outside_cell = lattice_matrix && (
      abc[0] < 0 || abc[0] >= 1 ||
      abc[1] < 0 || abc[1] >= 1 ||
      abc[2] < 0 || abc[2] >= 1
    )
    let should_wrap = false
    if (outside_cell) {
      if (move_mask?.[idx] === false) {
        should_wrap = true // explicit frozen atom: always wrap
      } else {
        // Heuristic for movable / unspecified atoms: wrap iff the wrapped
        // Cartesian position has a near neighbor in raw (un-PBC'd) Cartesian.
        const wa = abc[0] - Math.floor(abc[0])
        const wb = abc[1] - Math.floor(abc[1])
        const wc = abc[2] - Math.floor(abc[2])
        const lm = lattice_matrix as Matrix3x3
        const wx = wa * lm[0][0] + wb * lm[1][0] + wc * lm[2][0]
        const wy = wa * lm[0][1] + wb * lm[1][1] + wc * lm[2][1]
        const wz = wa * lm[0][2] + wb * lm[1][2] + wc * lm[2][2]
        for (let j = 0; j < positions.length; j++) {
          if (j === idx) continue
          const other = positions[j]
          const dx = wx - other[0]
          const dy = wy - other[1]
          const dz = wz - other[2]
          if (dx * dx + dy * dy + dz * dz < NEAR_NEIGHBOR_BOND_DIST_SQ) {
            should_wrap = true
            break
          }
        }
      }
    }
    if (should_wrap && lattice_matrix) {
      const new_abc: Vec3 = [
        abc[0] - Math.floor(abc[0]),
        abc[1] - Math.floor(abc[1]),
        abc[2] - Math.floor(abc[2]),
      ]
      abc = new_abc
      // frac→cart for rows=a,b,c is Mᵀ·frac (same as the inline near-neighbor
      // check above and pbc.ts:219).
      xyz = math.mat3x3_vec3_multiply(lattice_T as Matrix3x3, new_abc)
    }
    const properties: Record<string, unknown> = force_data?.[idx]
      ? { force: force_data[idx] as Vec3 }
      : {}
    if (move_mask) properties.move_mask = move_mask[idx]
    return {
      species: [{ element: elements[idx], occu: 1, oxidation_state: 0 }],
      abc,
      xyz,
      label: `${elements[idx]}${idx + 1}`,
      properties,
    }
  })

  return lattice_matrix
    ? {
      sites,
      lattice: {
        matrix: lattice_matrix,
        ...math.calc_lattice_params(lattice_matrix),
        pbc: pbc || [true, true, true] satisfies Pbc,
      },
    }
    : { sites }
}

export const create_trajectory_frame = (
  positions: number[][],
  elements: ElementSymbol[],
  lattice_matrix: Matrix3x3 | undefined,
  pbc: Pbc | undefined,
  step: number,
  metadata: Record<string, unknown> = {},
  force_data?: number[][],
  move_mask?: boolean[],
): TrajectoryFrame => ({
  structure: create_structure(
    positions,
    elements,
    lattice_matrix,
    pbc,
    force_data,
    move_mask,
  ),
  step,
  metadata,
})

// Shared utility to read ndarray data from binary format
export const read_ndarray_from_view = (
  view: DataView,
  ref: { ndarray: unknown[] },
): number[][] => {
  const [shape, dtype, array_offset] = ref.ndarray as [number[], string, number]
  const total = shape.reduce((a, b) => a * b, 1)
  const data: number[] = []
  let pos = array_offset

  const readers = {
    int64: () => {
      const v = Number(view.getBigInt64(pos, true))
      pos += 8
      return v
    },
    int32: () => {
      const v = view.getInt32(pos, true)
      pos += 4
      return v
    },
    float64: () => {
      const v = view.getFloat64(pos, true)
      pos += 8
      return v
    },
    float32: () => {
      const v = view.getFloat32(pos, true)
      pos += 4
      return v
    },
  }

  const reader = readers[dtype as keyof typeof readers]
  if (!reader) throw new Error(`Unsupported dtype: ${dtype}`)

  for (let i = 0; i < total; i++) data.push(reader())

  return shape.length === 1
    ? [data]
    : shape.length === 2
    ? Array.from({ length: shape[0] }, (_, idx) =>
      data.slice(idx * shape[1], (idx + 1) * shape[1]))
    : (() => {
      throw new Error(`Unsupported shape`)
    })()
}

// Unified frame counting for XYZ
export function count_xyz_frames(data: string): number {
  if (!data || typeof data !== `string`) return 0
  const lines = data.trim().split(/\r?\n/)
  let frame_count = 0
  let line_idx = 0

  while (line_idx < lines.length) {
    if (!lines[line_idx]?.trim()) {
      line_idx++
      continue
    }

    const num_atoms = parseInt(lines[line_idx].trim(), 10)
    if (isNaN(num_atoms) || num_atoms <= 0 || line_idx + num_atoms + 1 >= lines.length) {
      line_idx++
      continue
    }

    // Quick validation of first few atom lines
    let valid_coords = 0
    for (let idx = 0; idx < Math.min(num_atoms, 3); idx++) {
      const parts = lines[line_idx + 2 + idx]?.trim().split(/\s+/)
      if (parts?.length >= 4 && isNaN(parseInt(parts[0])) && parts[0].length <= 3) {
        if (parts.slice(1, 4).every((coord) => !isNaN(parseFloat(coord)))) valid_coords++
      }
    }

    if (valid_coords >= Math.min(num_atoms, 3)) {
      frame_count++
      line_idx += 2 + num_atoms
    } else {
      line_idx++
    }
  }

  return frame_count
}

// Strip compression extensions from a filename for format detection
export function strip_compression(filename: string): string {
  let base = filename.toLowerCase()
  while (COMPRESSION_EXTENSIONS_REGEX.test(base)) {
    base = base.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
  }
  return base
}

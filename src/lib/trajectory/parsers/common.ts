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
): AnyStructure => {
  const inv_matrix = lattice_matrix ? get_inverse_matrix(lattice_matrix) : null
  const sites = positions.map((pos, idx) => {
    const xyz = pos as Vec3
    const abc = inv_matrix
      ? math.mat3x3_vec3_multiply(inv_matrix, xyz)
      : [0, 0, 0] as Vec3
    const properties = force_data?.[idx] ? { force: force_data[idx] as Vec3 } : {}
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
): TrajectoryFrame => ({
  structure: create_structure(positions, elements, lattice_matrix, pbc),
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

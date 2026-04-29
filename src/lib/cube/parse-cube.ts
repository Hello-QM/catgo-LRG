/**
 * Client-side cube file parser.
 * Parses atom positions and volumetric grid data from Gaussian .cube files.
 * Converts to PymatgenMolecule-compatible structures for the Structure viewer.
 */

import { elem_symbols } from '$lib/labels'
import type { ElementSymbol } from '$lib'
import type { CubeHeader } from './api'

const BOHR_TO_ANGSTROM = 0.529177210903

interface CubeAtomRaw {
  atomic_number: number
  charge: number
  position: [number, number, number] // Angstrom
}

export interface ParsedCubeHeader {
  atoms: CubeAtomRaw[]
  n_atoms: number
  origin: [number, number, number]
  dims: [number, number, number]
  is_angstrom: boolean
}

export interface VolumetricGrid {
  data: Float32Array // flat [nx][ny][nz] row-major
  dims: [number, number, number]
  origin: [number, number, number] // Angstroms
  voxel_axes: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ]
  data_min: number
  data_max: number
}

export interface ParsedCubeData {
  header: CubeHeader
  grid: VolumetricGrid
}

/**
 * Parse the header of a Gaussian cube file to extract atom data.
 * Only parses the header (comments + atoms), not the volumetric data.
 */
export function parse_cube_header(text: string): ParsedCubeHeader {
  const lines = text.split(`\n`)
  if (lines.length < 6) throw new Error(`Invalid cube file: too few lines`)

  // Lines 0-1: comments
  // Line 2: n_atoms, origin_x, origin_y, origin_z
  const line2 = lines[2].trim().split(/\s+/)
  const raw_n_atoms = parseInt(line2[0])
  const is_angstrom = raw_n_atoms < 0
  const n_atoms = Math.abs(raw_n_atoms)

  const scale = is_angstrom ? 1.0 : BOHR_TO_ANGSTROM

  const origin: [number, number, number] = [
    parseFloat(line2[1]) * scale,
    parseFloat(line2[2]) * scale,
    parseFloat(line2[3]) * scale,
  ]

  // Lines 3-5: voxel axes (N, dx, dy, dz)
  const dims: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const parts = lines[3 + i].trim().split(/\s+/)
    dims[i] = parseInt(parts[0])
  }

  // Lines 6 to 6+n_atoms-1: atoms
  const atoms: CubeAtomRaw[] = []
  for (let i = 0; i < n_atoms; i++) {
    const line_idx = 6 + i
    if (line_idx >= lines.length) break
    const parts = lines[line_idx].trim().split(/\s+/)
    if (parts.length < 5) continue
    atoms.push({
      atomic_number: parseInt(parts[0]),
      charge: parseFloat(parts[1]),
      position: [
        parseFloat(parts[2]) * scale,
        parseFloat(parts[3]) * scale,
        parseFloat(parts[4]) * scale,
      ],
    })
  }

  return { atoms, n_atoms, origin, dims, is_angstrom }
}

/**
 * Convert grid indices (fractional) to Cartesian coordinates (Angstroms).
 * Matches Rust CubeFile::grid_to_cart.
 */
export function grid_to_cart(
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

/**
 * Parse a complete Gaussian cube file including volumetric data.
 * Returns a CubeHeader (matching the server API type) and a VolumetricGrid.
 */
export function parse_cube_full(text: string): ParsedCubeData {
  const lines = text.split(`\n`)
  if (lines.length < 6) throw new Error(`Invalid cube file: too few lines`)

  // Lines 0-1: comments
  const comment1 = lines[0].trim()
  const comment2 = lines[1].trim()

  // Line 2: n_atoms, origin
  const line2 = lines[2].trim().split(/\s+/)
  const raw_n_atoms = parseInt(line2[0])
  const is_angstrom = raw_n_atoms < 0
  const n_atoms = Math.abs(raw_n_atoms)
  const scale = is_angstrom ? 1.0 : BOHR_TO_ANGSTROM

  const origin: [number, number, number] = [
    parseFloat(line2[1]) * scale,
    parseFloat(line2[2]) * scale,
    parseFloat(line2[3]) * scale,
  ]

  // Lines 3-5: dims + voxel_axes
  const dims: [number, number, number] = [0, 0, 0]
  const voxel_axes: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < 3; i++) {
    const parts = lines[3 + i].trim().split(/\s+/)
    dims[i] = parseInt(parts[0])
    voxel_axes[i] = [
      parseFloat(parts[1]) * scale,
      parseFloat(parts[2]) * scale,
      parseFloat(parts[3]) * scale,
    ]
  }

  // Lines 6..6+n_atoms: atoms
  const atoms: { atomic_number: number; charge: number; position: [number, number, number] }[] =
    []
  for (let i = 0; i < n_atoms; i++) {
    const line_idx = 6 + i
    if (line_idx >= lines.length) break
    const parts = lines[line_idx].trim().split(/\s+/)
    if (parts.length < 5) continue
    atoms.push({
      atomic_number: parseInt(parts[0]),
      charge: parseFloat(parts[1]),
      position: [
        parseFloat(parts[2]) * scale,
        parseFloat(parts[3]) * scale,
        parseFloat(parts[4]) * scale,
      ],
    })
  }

  // Volumetric data: remaining lines after header + atoms
  const data_start_line = 6 + n_atoms
  const total_voxels = dims[0] * dims[1] * dims[2]
  const data = new Float32Array(total_voxels)
  let data_idx = 0
  let data_min = Infinity
  let data_max = -Infinity

  for (let li = data_start_line; li < lines.length && data_idx < total_voxels; li++) {
    const line = lines[li]
    if (!line.trim()) continue
    const tokens = line.trim().split(/\s+/)
    for (let ti = 0; ti < tokens.length && data_idx < total_voxels; ti++) {
      const val = parseFloat(tokens[ti])
      if (isNaN(val)) continue
      data[data_idx++] = val
      if (val < data_min) data_min = val
      if (val > data_max) data_max = val
    }
  }

  if (data_idx !== total_voxels) {
    throw new Error(`Expected ${total_voxels} voxels but got ${data_idx}`)
  }

  const header: CubeHeader = {
    comment1,
    comment2,
    n_atoms,
    origin,
    dims,
    voxel_axes,
    atoms,
  }

  return {
    header,
    grid: { data, dims, origin, voxel_axes, data_min, data_max },
  }
}

/**
 * Convert parsed cube atoms to a PymatgenMolecule-compatible structure.
 */
export function cube_atoms_to_molecule(header: ParsedCubeHeader) {
  const sites = header.atoms.map((atom) => {
    const symbol = (
      atom.atomic_number > 0 && atom.atomic_number <= elem_symbols.length
        ? elem_symbols[atom.atomic_number - 1]
        : `X`
    ) as ElementSymbol

    return {
      species: [{ element: symbol, occu: 1, oxidation_state: 0 }],
      xyz: atom.position as [number, number, number],
      abc: [0, 0, 0] as [number, number, number],
      label: symbol,
      properties: {} as Record<string, unknown>,
    }
  })

  return { sites }
}

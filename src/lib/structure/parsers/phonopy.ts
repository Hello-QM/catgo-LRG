import type { Site, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import { load as yaml_load } from 'js-yaml'
import {
  type ParsedStructure,
  validate_element_symbol,
} from './common'

export interface PhonopyCell {
  lattice: number[][]
  points: {
    symbol: string
    coordinates: number[]
    mass: number
    reduced_to?: number
  }[]
  reciprocal_lattice?: number[][]
}

export interface PhonopyData {
  phono3py?: {
    version: string
    [key: string]: unknown
  }
  phonopy?: {
    version: string
    [key: string]: unknown
  }
  space_group?: {
    type: string
    number: number
    Hall_symbol: string
  }
  primitive_cell?: PhonopyCell
  unit_cell?: PhonopyCell
  supercell?: PhonopyCell
  phonon_primitive_cell?: PhonopyCell
  phonon_supercell?: PhonopyCell
  phonon_displacements?: unknown[] // Ignored for performance
  [key: string]: unknown
}

export type CellType =
  | `primitive_cell`
  | `unit_cell`
  | `supercell`
  | `phonon_primitive_cell`
  | `phonon_supercell`
  | `auto`

// Convert phonopy cell to ParsedStructure
function convert_phonopy_cell(cell: PhonopyCell): ParsedStructure {
  const sites: Site[] = []
  // Phonopy stores lattice vectors as rows, use them directly
  const lattice_matrix = cell.lattice as Matrix3x3

  // Process each atomic site
  for (const point of cell.points) {
    const element = validate_element_symbol(point.symbol, sites.length)
    const abc: Vec3 = [
      point.coordinates[0],
      point.coordinates[1],
      point.coordinates[2],
    ]

    // Convert fractional to Cartesian coordinates
    const xyz = math.mat3x3_vec3_multiply(
      math.transpose_3x3_matrix(lattice_matrix),
      abc,
    )

    const properties = {
      mass: point.mass,
      ...(point.reduced_to !== undefined && { reduced_to: point.reduced_to }),
    }
    const species = [{ element, occu: 1.0, oxidation_state: 0 }]
    const site: Site = { species, abc, xyz, label: point.symbol, properties }
    sites.push(site)
  }

  // Calculate lattice parameters
  const calculated_lattice_params = math.calc_lattice_params(lattice_matrix)

  return { sites, lattice: { matrix: lattice_matrix, ...calculated_lattice_params } }
}

// Parse phonopy YAML file and return the requested cell type (or preferred single structure)
export function parse_phonopy_yaml(
  content: string,
  cell_type?: CellType,
): ParsedStructure | null {
  try {
    // Parse YAML content but exclude large phonon_displacements array for performance
    const lines = content.split(`\n`)
    const filtered_lines = []
    let skip_displacements = false

    for (const line of lines) {
      // Skip phonon_displacements section for performance
      if (line.trim().startsWith(`phonon_displacements:`)) {
        skip_displacements = true
        continue
      }

      // Check if we're still in the phonon_displacements section
      if (skip_displacements) {
        if (line.match(/^[a-zA-Z_]/)) {
          // New top-level key, stop skipping
          skip_displacements = false
        } else continue // Still in phonon_displacements, skip this line
      }

      filtered_lines.push(line)
    }

    const filtered_content = filtered_lines.join(`\n`)
    const data = yaml_load(filtered_content) as PhonopyData

    if (!data) {
      console.error(`Failed to parse phonopy YAML`)
      return null
    }

    // If specific cell type requested, parse only that one
    if (cell_type && cell_type !== `auto`) {
      const cell = data[cell_type]
      if (cell) return convert_phonopy_cell(cell)
      else {
        console.error(`Requested cell type '${cell_type}' not found in phonopy YAML`)
        return null
      }
    }

    // Auto mode: return preferred structure in order of preference
    // 1. supercell (most detailed)
    // 2. phonon_supercell
    // 3. unit_cell
    // 4. phonon_primitive_cell
    // 5. primitive_cell

    if (data.supercell) return convert_phonopy_cell(data.supercell)
    else if (data.phonon_supercell) return convert_phonopy_cell(data.phonon_supercell)
    else if (data.unit_cell) return convert_phonopy_cell(data.unit_cell)
    else if (data.phonon_primitive_cell) {
      return convert_phonopy_cell(data.phonon_primitive_cell)
    } else if (data.primitive_cell) return convert_phonopy_cell(data.primitive_cell)

    console.error(`No valid cells found in phonopy YAML`)
    return null
  } catch (error) {
    console.error(`Error parsing phonopy YAML:`, error)
    return null
  }
}

import type { Site, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import {
  type ParsedStructure,
  parse_coordinate,
  validate_element_symbol,
} from './common'

// Parse extended XYZ Properties field to determine column layout
// Format: Properties="species:S:1:pos:R:3:forces:R:3" or Properties="species:S:1 pos:R:3 forces:R:3"
function parse_extxyz_properties(properties_str: string): {
  columns: { name: string; type: string; count: number }[]
  force_start?: number
  energy?: number
} {
  const columns: { name: string; type: string; count: number }[] = []

  // Split by colon, handling both "name:type:count:name:type:count" and space-separated formats
  const normalized = properties_str.replace(/\s+/g, `:`)
  const parts = normalized.split(`:`)

  let idx = 0
  while (idx < parts.length - 2) {
    const name = parts[idx].toLowerCase()
    const type = parts[idx + 1]
    const count = parseInt(parts[idx + 2])

    if (!isNaN(count) && count > 0) {
      columns.push({ name, type, count })
      idx += 3
    } else {
      idx++
    }
  }

  // Calculate where forces column starts (if present)
  let col_offset = 0
  let force_start: number | undefined

  for (const col of columns) {
    if (col.name === `forces` || col.name === `force`) {
      force_start = col_offset
      break
    }
    col_offset += col.count
  }

  return { columns, force_start }
}

// Parse XYZ file format. Supports both standard XYZ and extended XYZ formats with multi-frame support
export function parse_xyz(content: string): ParsedStructure | null {
  try {
    const normalized_content = content.trim()
    if (!normalized_content) {
      console.error(`Empty XYZ file`)
      return null
    }

    // Split into frames by reading the atom count and slicing lines
    const all_lines = normalized_content.split(/\r?\n/)
    const frames: string[] = []
    let line_idx = 0

    while (line_idx < all_lines.length) {
      const numAtoms = parseInt(all_lines[line_idx].trim(), 10)
      if (
        !isNaN(numAtoms) &&
        numAtoms > 0 &&
        line_idx + numAtoms + 1 < all_lines.length
      ) {
        const frameLines = all_lines.slice(line_idx, line_idx + numAtoms + 2)
        frames.push(frameLines.join(`\n`))
        line_idx += numAtoms + 2
      } else line_idx++
    }

    // If no frames found, try simple parsing
    if (frames.length === 0) frames.push(normalized_content)

    // Parse the last frame (or only frame)
    const frame_content = frames[frames.length - 1]
    const lines = frame_content.trim().split(/\r?\n/)

    if (lines.length < 2) {
      console.error(`XYZ frame too short`)
      return null
    }

    // Parse number of atoms (line 1)
    const num_atoms = parseInt(lines[0].trim())
    if (isNaN(num_atoms) || num_atoms <= 0) {
      console.error(`Invalid number of atoms in XYZ file`)
      return null
    }

    // Parse comment line (line 2) - may contain lattice info and Properties for extended XYZ
    const comment_line = lines[1]
    let lattice: ParsedStructure[`lattice`] | undefined
    let force_col_start: number | undefined
    let structure_energy: number | undefined

    // Check for extended XYZ lattice information in comment line
    const lattice_match = comment_line.match(/Lattice="([^"]+)"/)
    if (lattice_match) {
      const lattice_values = lattice_match[1].split(/\s+/).map(parse_coordinate)
      if (lattice_values.length === 9) {
        const lattice_vectors: Matrix3x3 = [
          [lattice_values[0], lattice_values[1], lattice_values[2]],
          [lattice_values[3], lattice_values[4], lattice_values[5]],
          [lattice_values[6], lattice_values[7], lattice_values[8]],
        ]

        const lattice_params = math.calc_lattice_params(lattice_vectors)
        lattice = { matrix: lattice_vectors, ...lattice_params }
      }
    }

    // Check for Properties field (extended XYZ column specification)
    const properties_match = comment_line.match(/Properties="([^"]+)"/i)
    if (properties_match) {
      const parsed_props = parse_extxyz_properties(properties_match[1])
      force_col_start = parsed_props.force_start
    }

    // Check for energy in comment line (common formats: energy=X, Energy=X, E=X)
    const energy_match = comment_line.match(/(?:energy|E)\s*=\s*([-\d.eE+]+)/i)
    if (energy_match) {
      structure_energy = parseFloat(energy_match[1])
      if (isNaN(structure_energy)) structure_energy = undefined
    }

    // Parse atomic coordinates (starting from line 3)
    const sites: Site[] = []

    for (let atom_idx = 0; atom_idx < num_atoms; atom_idx++) {
      const line_idx = atom_idx + 2
      if (line_idx >= lines.length) {
        console.error(`Not enough coordinate lines in XYZ file`)
        return null
      }

      const parts = lines[line_idx].trim().split(/\s+/)
      if (parts.length < 4) {
        console.error(`Invalid coordinate line in XYZ file`)
        return null
      }

      const element = validate_element_symbol(parts[0], atom_idx)
      const coords = [
        parse_coordinate(parts[1]),
        parse_coordinate(parts[2]),
        parse_coordinate(parts[3]),
      ]

      // For XYZ files, coordinates are typically in Cartesian
      const xyz: Vec3 = [coords[0], coords[1], coords[2]]

      // Calculate fractional coordinates if lattice is available
      let abc: Vec3 = [0, 0, 0]
      if (lattice) {
        // Calculate fractional coordinates using proper matrix inversion
        // Note: Our lattice matrix is stored as row vectors, but for coordinate conversion
        // we need column vectors, so we transpose before inversion
        try {
          const lattice_transposed = math.transpose_3x3_matrix(lattice.matrix)
          const lattice_inv = math.matrix_inverse_3x3(lattice_transposed)
          abc = math.mat3x3_vec3_multiply(lattice_inv, xyz)
        } catch {
          // Fallback to simplified method if matrix is singular
          abc = [xyz[0] / lattice.a, xyz[1] / lattice.b, xyz[2] / lattice.c]
        }

        // Wrap fractional coordinates into [0, 1) for internal consistency
        // but DO NOT recompute xyz from wrapped abc - this would move atoms
        // near cell boundaries to incorrect positions (e.g., z=0.99 -> z=0.0)
        abc = [
          abc[0] - Math.floor(abc[0]),
          abc[1] - Math.floor(abc[1]),
          abc[2] - Math.floor(abc[2]),
        ]
        // Note: xyz is kept as original Cartesian coordinates from the file
      }

      // Extract force data if Properties field specifies forces
      const properties: Record<string, unknown> = {}
      if (force_col_start !== undefined) {
        // Force columns start after species(1) + pos(3) = 4, plus offset from Properties
        // But Properties includes species and pos, so force_col_start is the absolute offset
        // In the parts array: [species, x, y, z, fx, fy, fz, ...]
        // force_col_start from Properties is column index (species=0, pos starts at 1)
        // So in parts array, forces start at index force_col_start
        const fx_idx = force_col_start
        if (parts.length > fx_idx + 2) {
          const fx = parse_coordinate(parts[fx_idx])
          const fy = parse_coordinate(parts[fx_idx + 1])
          const fz = parse_coordinate(parts[fx_idx + 2])
          if (!isNaN(fx) && !isNaN(fy) && !isNaN(fz)) {
            properties.force = [fx, fy, fz]
          }
        }
      } else if (parts.length >= 7) {
        // Fallback: if no Properties field but we have 7+ columns, assume last 3 are forces
        // This handles simple extxyz files without explicit Properties specification
        const fx = parseFloat(parts[parts.length - 3])
        const fy = parseFloat(parts[parts.length - 2])
        const fz = parseFloat(parts[parts.length - 1])
        // Only treat as forces if they look like force values (reasonable magnitude)
        if (!isNaN(fx) && !isNaN(fy) && !isNaN(fz)) {
          const fmag = Math.sqrt(fx * fx + fy * fy + fz * fz)
          // Force magnitudes typically < 100 eV/Å, skip if looks like something else
          if (fmag < 100) {
            properties.force = [fx, fy, fz]
          }
        }
      }

      const species = [{ element, occu: 1, oxidation_state: 0 }]
      const label = `${element}${atom_idx + 1}`
      const site: Site = { species, abc, xyz, label, properties }

      sites.push(site)
    }

    const structure: ParsedStructure & { energy?: number } = {
      sites,
      ...(lattice && { lattice }),
      ...(structure_energy !== undefined && { energy: structure_energy }),
    }

    return structure
  } catch (error) {
    console.error(`Error parsing XYZ file:`, error)
    return null
  }
}

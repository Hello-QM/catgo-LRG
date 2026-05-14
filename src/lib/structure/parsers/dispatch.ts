import {
  COMPRESSION_EXTENSIONS_REGEX,
  CONFIG_DIRS_REGEX,
  STRUCT_KEYWORDS_REGEX,
  STRUCT_KEYWORDS_STRICT_REGEX,
  STRUCTURE_EXTENSIONS_REGEX,
  TRAJ_KEYWORDS_REGEX,
  VASP_FILES_REGEX,
  XYZ_EXTXYZ_REGEX,
} from '$lib/constants'
import type { AnyStructure } from '$lib/structure'
import type { ParsedStructure } from './common'
import { parse_poscar, parse_vasprun_xml } from './vasp'
import { parse_xyz } from './xyz'
import { parse_cif } from './cif'
import { parse_pdb } from './pdb'
import { parse_mol2 } from './mol2'
import { parse_lammps_data } from './lammps'
import { parse_cp2k } from './cp2k'
import { parse_phonopy_yaml } from './phonopy'
import {
  is_optimade_raw,
  parse_optimade_from_raw,
  parse_pubchem_json,
  find_structure_in_json,
} from './json-formats'

// Auto-detect file format and parse accordingly
export function parse_structure_file(
  content: string,
  filename?: string,
): ParsedStructure | null {
  // If a filename is provided, try to detect format by file extension first
  if (filename) {
    // Handle compressed files by removing compression extensions
    let base_filename = filename.toLowerCase()
    while (COMPRESSION_EXTENSIONS_REGEX.test(base_filename)) {
      base_filename = base_filename.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
    }

    const ext = base_filename.split(`.`).pop()

    // Try to detect format by file extension
    if (ext === `xyz` || ext === `extxyz`) return parse_xyz(content)

    // LAMMPS data files
    if (ext === `data` || ext === `lammps` || ext === `lmp`) return parse_lammps_data(content)

    // CIF files
    if (ext === `cif`) return parse_cif(content)

    // MOL2 files
    if (ext === `mol2`) return parse_mol2(content)

    // PDB files
    if (ext === `pdb`) return parse_pdb(content)

    // JSON files - try OPTIMADE, PubChem, then pymatgen
    if (ext === `json`) {
      try {
        // Parse once, reuse for detection and parsing
        const parsed = JSON.parse(content)
        if (is_optimade_raw(parsed)) {
          const result = parse_optimade_from_raw(parsed)
          if (result) return result
        }
        // Try PubChem JSON format
        const pubchem = parse_pubchem_json(parsed)
        if (pubchem) return pubchem
        // Otherwise, try to parse as pymatgen/nested structure JSON
        const structure = find_structure_in_json(parsed)
        if (structure) return structure
        console.error(`JSON file does not contain a valid structure format`)
        return null
      } catch (error) {
        console.error(`Error parsing JSON file:`, error)
        return null
      }
    }

    // YAML files (phonopy)
    if (ext === `yaml` || ext === `yml`) return parse_phonopy_yaml(content)

    // CP2K input/restart files
    if (ext === `inp` || ext === `restart`) return parse_cp2k(content)

    // VASP vasprun.xml
    if (ext === `xml`) return parse_vasprun_xml(content)

    // POSCAR files may not have extensions or have various names
    if (ext === `poscar` || base_filename.includes(`poscar`)) {
      return parse_poscar(content)
    }
  }

  // Try to auto-detect based on content
  const lines = content.trim().split(/\r?\n/)

  if (lines.length < 2) {
    console.error(`File too short to determine format`)
    return null
  }

  // LAMMPS data file detection: look for header keywords
  // Typical LAMMPS data files have "atoms", "atom types", and xlo/xhi type lines
  const has_lammps_keywords =
    content.includes(`atoms`) &&
    content.includes(`atom types`) &&
    content.toLowerCase().includes(`xlo`) &&
    content.toLowerCase().includes(`xhi`)

  if (has_lammps_keywords) {
    // Double check by looking for specific LAMMPS sections
    const has_lammps_sections =
      content.includes(`Masses`) || content.includes(`Atoms`) || content.includes(`Bonds`)
    if (has_lammps_sections) {
      return parse_lammps_data(content)
    }
  }

  // vasprun.xml detection: look for <modeling> root tag
  if (content.trimStart().startsWith(`<?xml`) || content.trimStart().startsWith(`<modeling`)) {
    const result = parse_vasprun_xml(content)
    if (result) return result
  }

  // JSON format detection: try to parse as JSON first
  try {
    const parsed = JSON.parse(content)
    if (is_optimade_raw(parsed)) {
      const result = parse_optimade_from_raw(parsed)
      if (result) return result
    }
    // Try PubChem JSON
    const pubchem = parse_pubchem_json(parsed)
    if (pubchem) return pubchem
    // Otherwise try parsing as regular JSON structure
    const structure = find_structure_in_json(parsed)
    if (structure) {
      return structure
    }
  } catch {
    // Not JSON, continue with other format detection
  }

  // XYZ format detection: first line should be a number, second line is comment
  const first_line_number = parseInt(lines[0].trim())
  if (!isNaN(first_line_number) && first_line_number > 0) {
    // Check if this looks like XYZ format
    if (lines.length >= first_line_number + 2) {
      // Try to parse a coordinate line to see if it looks like XYZ
      const coord_line_idx = 2 // First coordinate line in XYZ
      if (coord_line_idx < lines.length) {
        const parts = lines[coord_line_idx].trim().split(/\s+/)
        // XYZ format: element symbol followed by 3 coordinates
        if (parts.length >= 4) {
          const first_token = parts[0]
          const coords = parts.slice(1, 4)

          // Check if first token looks like an element symbol (not a number)
          // and the next 3 tokens look like coordinates (numbers)
          const is_element_symbol = isNaN(parseInt(first_token)) &&
            first_token.length <= 3
          const are_coordinates = coords.every(
            (coord) => !isNaN(parseFloat(coord)),
          )

          if (is_element_symbol && are_coordinates) {
            // First token is likely an element symbol, likely XYZ
            return parse_xyz(content)
          }
        }
      }
    }
  }

  // POSCAR format detection: look for typical structure
  if (lines.length >= 8) {
    const second_line_number = parseFloat(lines[1].trim())
    // Second line is a number (scale factor), likely POSCAR
    if (!isNaN(second_line_number)) return parse_poscar(content)
  }

  // CIF format detection: look for CIF-specific keywords
  const has_cif_keywords = lines.some(
    (line) =>
      line.startsWith(`data_`) ||
      line.includes(`_cell_length_`) ||
      line.includes(`_atom_site_`) ||
      line.trim() === `loop_`,
  )
  if (has_cif_keywords) return parse_cif(content)

  // YAML format detection: look for phonopy-specific keywords
  const has_phonopy_keywords = lines.some(
    (line) =>
      line.includes(`phono3py:`) ||
      line.includes(`phonopy:`) ||
      line.includes(`primitive_cell:`) ||
      line.includes(`supercell:`) ||
      line.includes(`phonon_supercell:`),
  )
  if (has_phonopy_keywords) return parse_phonopy_yaml(content)

  // CP2K: detect &CELL + &COORD blocks
  if (lines.some((l) => /^\s*&(CELL|COORD)\b/i.test(l))) return parse_cp2k(content)

  console.error(`Unable to determine file format`)
  return null
}

// Universal parser that handles JSON and structure files
export function parse_any_structure(
  content: string,
  filename: string,
): AnyStructure | null {
  // Try JSON first, but handle nested structures properly
  try {
    const parsed = JSON.parse(content)

    // Check if it's already a valid structure
    if (parsed.sites && Array.isArray(parsed.sites)) return parsed
    // If not, use parse_structure_file to find nested structures
    const structure = parse_structure_file(content, filename)

    if (structure) {
      return {
        sites: structure.sites,
        charge: 0,
        ...(structure.lattice && {
          lattice: { ...structure.lattice, pbc: [true, true, true] },
        }),
      }
    } else return null
  } catch {
    // Try structure file formats
    const parsed = parse_structure_file(content, filename)
    if (parsed) {
      return {
        sites: parsed.sites,
        charge: 0,
        ...(parsed.lattice && {
          lattice: { ...parsed.lattice, pbc: [true, true, true] },
        }),
      }
    } else return null
  }
}

// Check if filename indicates a structure file
export function is_structure_file(filename: string): boolean {
  const name = filename.toLowerCase()

  // Trajectory-only formats (can't be structures)
  if (/\.(traj|xtc|h5|hdf5)$/i.test(name) || /xdatcar/i.test(name)) return false

  // Always structure formats
  if (STRUCTURE_EXTENSIONS_REGEX.test(name)) return true
  if (VASP_FILES_REGEX.test(name)) return true
  // CHGCAR/AECCAR/LOCPOT/ELFCAR/PARCHG — VASP volumetric data (handled as cube conversion)
  if (/\.(cube|cub)$/i.test(name)) return true
  const basename = name.replace(/\.(gz|bz2|xz|zst)$/i, ``)
  if (/^(chgcar|chgdiff|diffchg|aeccar[012]|locpot|elfcar|parchg)$/i.test(basename)) return true
  if (/chgcar|chgdiff|diffchg|aeccar|locpot|elfcar|parchg/i.test(basename)) return true

  // .xyz/.extxyz files: structure unless they have trajectory keywords
  if (/\.(xyz|extxyz)$/i.test(name)) return !TRAJ_KEYWORDS_REGEX.test(name)

  // VASP vasprun.xml
  if (/vasprun.*\.xml$/i.test(name) || (/\.xml$/i.test(name) && /vasp/i.test(name))) return true

  // Keyword-based detection for YAML/XML
  if (/\.(yaml|yml|xml)$/i.test(name) && STRUCT_KEYWORDS_REGEX.test(name)) return true

  // More restrictive keyword detection for JSON files
  if (
    /\.json$/i.test(name) && STRUCT_KEYWORDS_STRICT_REGEX.test(name) &&
    !TRAJ_KEYWORDS_REGEX.test(name) && !CONFIG_DIRS_REGEX.test(name)
  ) return true

  // Compressed files - check base filename recursively
  if (COMPRESSION_EXTENSIONS_REGEX.test(name)) {
    return is_structure_file(name.replace(COMPRESSION_EXTENSIONS_REGEX, ``))
  }

  return false
}

export const detect_structure_type = (
  filename: string,
  content: string,
): `crystal` | `molecule` | `unknown` => {
  const lower_filename = filename.toLowerCase()

  // Normalize compressed suffixes (gz, gzip, zip, xz, bz2) for detection parity
  let name_to_check = lower_filename
  while (COMPRESSION_EXTENSIONS_REGEX.test(name_to_check)) {
    name_to_check = name_to_check.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
  }

  if (name_to_check.endsWith(`.json`)) {
    try {
      const parsed = JSON.parse(content)
      // Check for crystal indicators: lattice, lattice_vectors, or periodic dimensions
      const dims = parsed.data?.attributes?.dimension_types
      if (
        parsed.lattice ||
        parsed.data?.attributes?.lattice_vectors ||
        (Array.isArray(dims) && dims.some((dim: number) => dim > 0)) ||
        parsed.data?.attributes?.nperiodic_dimensions > 0
      ) {
        return `crystal`
      }
      return `molecule`
    } catch {
      return `unknown`
    }
  }

  if (name_to_check.endsWith(`.cif`)) return `crystal`
  if (name_to_check.includes(`poscar`)) return `crystal`
  if (name_to_check.endsWith(`.data`) || name_to_check.endsWith(`.lammps`) || name_to_check.endsWith(`.lmp`)) return `crystal`

  if (name_to_check.endsWith(`.yaml`) || name_to_check.endsWith(`.yml`)) {
    const lower_content = content.toLowerCase()
    return lower_content.includes(`phono3py:`) || lower_content.includes(`phonopy:`)
      ? `crystal`
      : `unknown`
  }

  if (XYZ_EXTXYZ_REGEX.test(name_to_check)) {
    const lines = content.trim().split(/\r?\n/)
    return lines.length >= 2 && lines[1].includes(`Lattice=`) ? `crystal` : `molecule`
  }

  return `unknown`
}

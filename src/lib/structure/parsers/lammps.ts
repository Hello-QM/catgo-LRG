import type { ElementSymbol, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import {
  type ParsedStructure,
} from './common'

// Detect LAMMPS atom format by analyzing column values
// Returns indices for type, x, y, z columns
function detect_lammps_atom_format(
  parts: string[],
): { type_idx: number; x_idx: number; y_idx: number; z_idx: number } | null {
  const n = parts.length

  // Helper to check if a value looks like a coordinate (larger magnitude, typically > 0.1)
  const looks_like_coord = (val: number): boolean => Math.abs(val) > 0.1 || val === 0

  // Helper to check if a value looks like an integer type/ID (small positive integer)
  const looks_like_int_id = (val: number): boolean => {
    const int_val = Math.abs(val)
    return Number.isInteger(val) && int_val >= 0 && int_val <= 100000
  }

  // Helper to check if a value looks like a charge (typically |q| < 10, often has decimals)
  const looks_like_charge = (val: number): boolean => Math.abs(val) < 10 && !Number.isInteger(val)

  // Common LAMMPS atom format patterns:
  // - atom_id type x y z (5 columns) -> [0, ?, 2, 3, 4]
  // - atom_id type molecule_id x y z (6 columns) -> [0, 1, ?, 3, 4, 5]
  // - atom_id molecule_id type x y z (6 columns) -> [0, ?, 1, 3, 4, 5]
  // - atom_id type q x y z (6 columns) -> [0, 1, ?, 3, 4, 5]
  // - atom_id molecule_id type q x y z (7 columns) -> [0, ?, 1, ?, 4, 5, 6]

  // Parse all values as numbers for analysis
  const values = parts.map((p) => parseFloat(p))

  if (n === 5) {
    // atom_id type x y z
    return { type_idx: 1, x_idx: 2, y_idx: 3, z_idx: 4 }
  }

  if (n === 6) {
    // Two common 6-column formats:
    // 1. atom_id type molecule_id x y z
    // 2. atom_id molecule_id type x y z
    // 3. atom_id type q x y z (with charge)

    // Check indices 1, 2, and 3 for type/molecule/charge
    const idx1 = values[1]
    const idx2 = values[2]
    const idx3 = values[3]

    // Coordinates are always the last 3 columns (indices 3, 4, 5)
    const x_idx = 3
    const y_idx = 4
    const z_idx = 5

    // Detect which of indices 1 and 2 is the type
    // In molecular formats, type is usually the second small integer
    // In charge formats, the charge is often a small decimal

    if (looks_like_charge(idx2)) {
      // Index 2 looks like a charge, so index 1 is the type
      // Format: atom_id type q x y z
      return { type_idx: 1, x_idx, y_idx, z_idx }
    }

    // If both indices 1 and 2 look like integer IDs:
    // - If idx1 < idx2 typically: idx1 is type, idx2 is molecule_id (format: atom_id type molecule_id x y z)
    // - If idx2 < idx1 typically: idx2 is type, idx1 is molecule_id (format: atom_id molecule_id type x y z)
    // However, this isn't always reliable, so use coordinate magnitude as a tiebreaker

    // For poly[n]catenane data files, the common format is atom_id molecule_id type x y z
    // where coordinates are typically larger (> 0.1)
    // Let's verify idx3 is a coordinate
    if (looks_like_coord(idx3)) {
      // idx3 is definitely a coordinate, so we need to check idx1 and idx2
      // Default to atom_id molecule_id type x y z (more common for polymer melts)
      if (looks_like_int_id(idx2)) {
        return { type_idx: 2, x_idx, y_idx, z_idx }
      }
      // Fall back to atom_id type molecule_id x y z
      return { type_idx: 1, x_idx, y_idx, z_idx }
    }

    // Default fallback: assume atom_id molecule_id type x y z
    return { type_idx: 2, x_idx, y_idx, z_idx }
  }

  if (n >= 7) {
    // For 7+ columns, search for the type column
    // The coordinates are always the last 3 columns
    const z_idx = n - 1
    const y_idx = n - 2
    const x_idx = n - 3

    // Search for type in columns 1 to x_idx - 1
    // Type is usually a small positive integer (1-120 for element-like types)
    for (let j = 1; j < x_idx; j++) {
      const val = values[j]
      if (looks_like_int_id(val) && val > 0 && val <= 120) {
        return { type_idx: j, x_idx, y_idx, z_idx }
      }
    }

    // Fallback: assume column 2 is type (common in many formats)
    return { type_idx: 2, x_idx, y_idx, z_idx }
  }

  return null
}

// Map atomic mass to approximate element symbol
function mass_to_element(mass: number): string {
  // Simplified mass-to-element mapping
  const mass_thresholds: [number, string][] = [
    [1.1, `H`],
    [4.1, `He`],
    [6.5, `Li`],
    [9.1, `Be`],
    [10.9, `B`],
    [12.1, `C`],
    [14.1, `N`],
    [16.1, `O`],
    [19.1, `F`],
    [20.3, `Ne`],
    [23.1, `Na`],
    [24.4, `Mg`],
    [27.1, `Al`],
    [28.2, `Si`],
    [31.1, `P`],
    [32.2, `S`],
    [35.6, `Cl`],
    [39.2, `Ar`],
    [40.2, `K`],
    [45.1, `Ca`],
    [48.1, `Ti`],
    [51.1, `V`],
    [52.1, `Cr`],
    [55.0, `Mn`],
    [56.1, `Fe`],
    [58.8, `Co`],
    [58.8, `Ni`],
    [63.6, `Cu`],
    [65.5, `Zn`],
    [70.1, `Ga`],
    [73.1, `Ge`],
    [75.1, `As`],
    [79.1, `Se`],
    [80.2, `Br`],
    [83.9, `Kr`],
    [85.6, `Rb`],
    [87.7, `Sr`],
    [88.5, `Y`],
    [91.3, `Zr`],
    [92.9, `Nb`],
    [96.0, `Mo`],
    [101.2, `Ru`],
    [102.9, `Rh`],
    [106.5, `Pd`],
    [107.9, `Ag`],
    [112.5, `Cd`],
    [114.9, `In`],
    [118.8, `Sn`],
    [121.8, `Sb`],
    [127.7, `Te`],
    [126.6, `I`],
    [131.4, `Xe`],
    [137.4, `Ba`],
    [138.9, `La`],
    [140.2, `Ce`],
    [144.3, `Nd`],
    [150.4, `Sm`],
    [157.3, `Gd`],
    [162.6, `Dy`],
    [167.3, `Er`],
    [168.9, `Tm`],
    [173.1, `Yb`],
    [174.9, `Lu`],
    [178.6, `Hf`],
    [180.9, `Ta`],
    [183.9, `W`],
    [186.3, `Re`],
    [190.3, `Os`],
    [192.3, `Ir`],
    [195.1, `Pt`],
    [197.1, `Au`],
    [200.7, `Hg`],
    [204.4, `Tl`],
    [207.3, `Pb`],
    [209.0, `Bi`],
  ]

  for (const [threshold, element] of mass_thresholds) {
    if (mass < threshold) return element
  }

  return `C` // Default to carbon for unknown masses
}

// Parse LAMMPS data file format
export function parse_lammps_data(content: string): ParsedStructure | null {
  try {
    const lines = content.trim().split(/\r?\n/)
    const sites: import('$lib').Site[] = []
    let xlo = 0,
      xhi = 0,
      ylo = 0,
      yhi = 0,
      zlo = 0,
      zhi = 0
    let xy = 0,
      xz = 0,
      yz = 0
    let natoms = 0
    let atom_types: Map<number, string> = new Map()
    let has_box = false
    let tilt_factors = false

    // Parse header sections
    let current_section = ``
    let atom_start_idx = -1
    let masses_start_idx = -1
    let atom_section_name = `Atoms`

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Detect section headers
      if (line === `Masses` || line === `Masses #` || line.startsWith(`Masses`)) {
        masses_start_idx = i
        current_section = `Masses`
        continue
      } else if (
        line === `Atoms` ||
        line === `Atoms #` ||
        line.startsWith(`Atoms`) ||
        line === `Atoms # atomic` ||
        line.startsWith(`Atoms `)
      ) {
        atom_start_idx = i + 2 // Skip section header and possible blank line
        atom_section_name = line
        current_section = `Atoms`
        continue
      } else if (line === `Bonds` || line.startsWith(`Bonds`)) {
        break // Stop parsing when we hit bonds section
      } else if (line === `Angles` || line.startsWith(`Angles`)) {
        break
      } else if (line === `Dihedrals` || line.startsWith(`Dihedrals`)) {
        break
      } else if (line === `Impropers` || line.startsWith(`Impropers`)) {
        break
      } else if (/^[A-Z][A-Za-z]*( [A-Za-z]+)*( #.*)?$/.test(line)) {
        // Any OTHER section header (Pair Coeffs, Bond Coeffs, Velocities, …)
        // ends the current section. Without this, `Pair Coeffs` lines kept
        // feeding the Masses parser: the LJ sigma column overwrote every
        // atom mass (σ ≈ 3.5 → He), so an 11k-atom kerogen rendered as
        // He₁₀₄₆₄Te₂₁₆Sb₂₁₆… instead of C/H/O/N.
        current_section = ``
        continue
      }

      // Parse atom count
      const atoms_match = line.match(/^(\d+)\s+atoms/)
      if (atoms_match) {
        natoms = parseInt(atoms_match[1])
        continue
      }

      // Parse atom types count
      const types_match = line.match(/^(\d+)\s+atom\s+types/)
      if (types_match) {
        // Will parse types from Masses section
        continue
      }

      // Parse box dimensions
      const xbox_match = line.match(/^(-?\d+\.?\d*[eE+-]?\d*)\s+(-?\d+\.?\d*[eE+-]?\d*)\s+xlo\s+xhi/i)
      if (xbox_match) {
        xlo = parseFloat(xbox_match[1])
        xhi = parseFloat(xbox_match[2])
        has_box = true
        continue
      }

      const ybox_match = line.match(/^(-?\d+\.?\d*[eE+-]?\d*)\s+(-?\d+\.?\d*[eE+-]?\d*)\s+ylo\s+yhi/i)
      if (ybox_match) {
        ylo = parseFloat(ybox_match[1])
        yhi = parseFloat(ybox_match[2])
        continue
      }

      const zbox_match = line.match(/^(-?\d+\.?\d*[eE+-]?\d*)\s+(-?\d+\.?\d*[eE+-]?\d*)\s+zlo\s+zhi/i)
      if (zbox_match) {
        zlo = parseFloat(zbox_match[1])
        zhi = parseFloat(zbox_match[2])
        continue
      }

      // Parse tilt factors (for triclinic boxes): xy_val xz_val yz_val xy xz yz
      const tilt_match = line.match(/^(-?\d+\.?\d*[eE+-]?\d*)\s+(-?\d+\.?\d*[eE+-]?\d*)\s+(-?\d+\.?\d*[eE+-]?\d*)\s+xy\s+xz\s+yz/i)
      if (tilt_match) {
        xy = parseFloat(tilt_match[1])
        xz = parseFloat(tilt_match[2])
        yz = parseFloat(tilt_match[3])
        tilt_factors = true
        continue
      }

      // Parse masses section
      if (current_section === `Masses` && masses_start_idx >= 0) {
        if (i > masses_start_idx && line && !line.startsWith(`#`)) {
          const parts = line.split(/\s+/)
          if (parts.length >= 2) {
            const type_id = parseInt(parts[0])
            const mass = parseFloat(parts[parts.length - 1]) // Mass is last value
            // Map mass to approximate element (simplified)
            const element = mass_to_element(mass)
            atom_types.set(type_id, element)
          }
        }
      }
    }

    // Parse atoms section
    if (atom_start_idx >= 0) {
      // Column layout per documented atom_style (`write_data` always annotates
      // the section header, e.g. "Atoms # full"). Trust the annotation before
      // any heuristics — guessing mis-detected 10-column `full` lines
      // (id mol type q x y z nx ny nz) and read the trailing image flags as
      // coordinates, collapsing every atom onto the origin.
      const STYLE_COLUMNS: Record<
        string,
        { type_idx: number; x_idx: number; y_idx: number; z_idx: number }
      > = {
        atomic: { type_idx: 1, x_idx: 2, y_idx: 3, z_idx: 4 },
        charge: { type_idx: 1, x_idx: 3, y_idx: 4, z_idx: 5 },
        molecular: { type_idx: 2, x_idx: 3, y_idx: 4, z_idx: 5 },
        angle: { type_idx: 2, x_idx: 3, y_idx: 4, z_idx: 5 },
        bond: { type_idx: 2, x_idx: 3, y_idx: 4, z_idx: 5 },
        full: { type_idx: 2, x_idx: 4, y_idx: 5, z_idx: 6 },
        sphere: { type_idx: 1, x_idx: 4, y_idx: 5, z_idx: 6 },
      }
      const style_match = atom_section_name.match(/#\s*([a-z]+)/i)
      const style_format = style_match ? STYLE_COLUMNS[style_match[1].toLowerCase()] ?? null : null

      // Trailing per-atom image flags (nx ny nz) are three pure integers after
      // the coordinates — strip them before HEURISTIC detection so they can't
      // be mistaken for the coordinate columns. (The style table above indexes
      // from the front, so it is unaffected either way.)
      const strip_image_flags = (parts: string[]): string[] => {
        if (parts.length >= 8 && parts.slice(-3).every((p) => /^-?\d+$/.test(p))) {
          return parts.slice(0, -3)
        }
        return parts
      }

      // Fall back to sampling-based detection only when the header carries no
      // (recognized) style annotation.
      let detected_format: {
        type_idx: number
        x_idx: number
        y_idx: number
        z_idx: number
      } | null = style_format

      for (let i = atom_start_idx; i < lines.length && !detected_format; i++) {
        const line = lines[i].trim()
        if (!line || line.startsWith(`#`)) continue
        if (line.match(/^[A-Za-z]/)) break

        const parts = strip_image_flags(line.split(/\s+/))
        if (parts.length < 5) continue

        detected_format = detect_lammps_atom_format(parts)
      }

      // Now parse all atoms using the detected format
      for (let i = atom_start_idx; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line || line.startsWith(`#`)) continue
        if (line.match(/^[A-Za-z]/)) break

        const parts = line.split(/\s+/)
        if (parts.length < 5) continue

        const format = detected_format || detect_lammps_atom_format(strip_image_flags(parts))
        if (!format) continue

        const atom_type = parseInt(parts[format.type_idx])
        const x = parseFloat(parts[format.x_idx])
        const y = parseFloat(parts[format.y_idx])
        const z = parseFloat(parts[format.z_idx])

        if (isNaN(x) || isNaN(y) || isNaN(z)) continue

        const element = (atom_types.get(atom_type) || `C`) as ElementSymbol

        sites.push({
          species: [{ element, occu: 1, oxidation_state: 0 }],
          abc: [0, 0, 0] as Vec3,
          xyz: [x, y, z] as Vec3,
          label: element,
          properties: {},
        })
      }
    }

    if (sites.length === 0) {
      console.error(`No atoms found in LAMMPS data file`)
      return null
    }

    console.log(`[LAMMPS] Parsed ${sites.length} atoms`)

    // Build lattice matrix
    const lattice: ParsedStructure[`lattice`] = undefined
    if (has_box) {
      const lx = xhi - xlo
      const ly = yhi - ylo
      const lz = zhi - zlo

      let matrix: Matrix3x3

      if (tilt_factors) {
        // Triclinic box
        matrix = [
          [lx, 0, 0],
          [xy, ly, 0],
          [xz, yz, lz],
        ]
      } else {
        // Orthogonal box
        matrix = [
          [lx, 0, 0],
          [0, ly, 0],
          [0, 0, lz],
        ]
      }

      const { a, b, c, alpha, beta, gamma, volume } = math.calc_lattice_params(matrix)

      // Convert Cartesian xyz to fractional abc coordinates. LAMMPS boxes
      // need not start at the origin (xlo/ylo/zlo can be negative — e.g. a
      // box spanning [-19.9, 239.4]); CatGo draws the cell at the origin, so
      // shift the atoms by the box origin first. Without this, abc is offset
      // by origin/length and atoms render outside the drawn cell.
      const inv_lattice = math.matrix_inverse_3x3(
        math.transpose_3x3_matrix(matrix),
      )
      for (const site of sites) {
        site.xyz = [site.xyz[0] - xlo, site.xyz[1] - ylo, site.xyz[2] - zlo]
        site.abc = math.mat3x3_vec3_multiply(inv_lattice, site.xyz)
      }

      return {
        sites,
        lattice: { matrix, a, b, c, alpha, beta, gamma, volume },
      }
    }

    return { sites }
  } catch (error) {
    console.error(`Error parsing LAMMPS data file:`, error)
    return null
  }
}

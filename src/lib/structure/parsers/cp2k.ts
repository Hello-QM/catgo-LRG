import { elem_symbols, type ElementSymbol, type Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import {
  type ParsedStructure,
  parse_coordinate,
} from './common'

// Parse CP2K .inp / .restart files
// Extracts &CELL and &COORD blocks to build a ParsedStructure
export function parse_cp2k(content: string): ParsedStructure | null {
  try {
    // Strip # and ! comments (but not inside strings)
    const lines = content.split(/\r?\n/).map((line) => {
      // Remove comments: everything after # or ! (outside quotes)
      const comment_idx = Math.min(
        ...[line.indexOf(`#`), line.indexOf(`!`)].filter((i) => i >= 0),
      )
      return Number.isFinite(comment_idx) ? line.slice(0, comment_idx) : line
    })

    // Find &CELL ... &END block (handles &END CELL or bare &END)
    let cell_lines: string[] = []
    let coord_lines: string[] = []
    let in_cell = false
    let in_coord = false
    let cell_depth = 0
    let coord_depth = 0

    // Track &CONSTRAINT > &FIXED_ATOMS blocks
    let in_constraint = false
    let constraint_depth = 0
    let in_fixed_atoms = false
    let fixed_atoms_depth = 0
    interface FixedAtomsBlock {
      components: string
      list: number[]
    }
    const fixed_atoms_blocks: FixedAtomsBlock[] = []
    let current_fixed_block: FixedAtomsBlock | null = null

    for (const line of lines) {
      const trimmed = line.trim().toUpperCase()
      if (!trimmed) continue

      // Track &FIXED_ATOMS inside &CONSTRAINT (innermost)
      if (in_fixed_atoms) {
        if (/^&\w/.test(trimmed) && !trimmed.startsWith(`&END`)) {
          fixed_atoms_depth++
        } else if (/^&END\b/.test(trimmed)) {
          if (fixed_atoms_depth > 0) {
            fixed_atoms_depth--
          } else {
            if (current_fixed_block && current_fixed_block.list.length > 0) {
              fixed_atoms_blocks.push(current_fixed_block)
            }
            current_fixed_block = null
            in_fixed_atoms = false
          }
        } else if (fixed_atoms_depth === 0 && current_fixed_block) {
          const tokens = trimmed.split(/\s+/)
          if (tokens[0] === `COMPONENTS_TO_FIX` && tokens.length >= 2) {
            current_fixed_block.components = tokens[1]
          } else if (tokens[0] === `LIST`) {
            for (const tok of tokens.slice(1)) {
              const range_match = tok.match(/^(\d+)\.\.(\d+)$/)
              if (range_match) {
                const lo = parseInt(range_match[1])
                const hi = parseInt(range_match[2])
                for (let i = lo; i <= hi; i++) current_fixed_block.list.push(i)
              } else {
                const num = parseInt(tok)
                if (!isNaN(num)) current_fixed_block.list.push(num)
              }
            }
          }
        }
        continue
      }

      // Track &CONSTRAINT block
      if (in_constraint) {
        if (/^&FIXED_ATOMS\b/.test(trimmed)) {
          in_fixed_atoms = true
          fixed_atoms_depth = 0
          current_fixed_block = { components: `XYZ`, list: [] }
        } else if (/^&\w/.test(trimmed) && !trimmed.startsWith(`&END`)) {
          constraint_depth++
        } else if (/^&END\b/.test(trimmed)) {
          if (constraint_depth > 0) {
            constraint_depth--
          } else {
            in_constraint = false
          }
        }
        continue
      }

      // Track &CELL block (handle nested blocks)
      if (in_cell) {
        if (/^&\w/.test(trimmed) && !trimmed.startsWith(`&END`)) {
          cell_depth++
        } else if (/^&END\b/.test(trimmed)) {
          if (cell_depth > 0) {
            cell_depth--
          } else {
            in_cell = false
            continue
          }
        }
        if (cell_depth === 0) cell_lines.push(line)
        continue
      }

      // Track &COORD block (handle nested blocks)
      if (in_coord) {
        if (/^&\w/.test(trimmed) && !trimmed.startsWith(`&END`)) {
          coord_depth++
        } else if (/^&END\b/.test(trimmed)) {
          if (coord_depth > 0) {
            coord_depth--
          } else {
            in_coord = false
            continue
          }
        }
        if (coord_depth === 0) coord_lines.push(line)
        continue
      }

      if (/^&CONSTRAINT\b/.test(trimmed)) {
        in_constraint = true
        constraint_depth = 0
        continue
      }
      if (/^&CELL\b/.test(trimmed)) {
        in_cell = true
        cell_depth = 0
        continue
      }
      if (/^&COORD\b/.test(trimmed)) {
        in_coord = true
        coord_depth = 0
        continue
      }
    }

    if (coord_lines.length === 0) {
      console.error(`CP2K: no &COORD block found`)
      return null
    }

    // --- Parse cell ---
    let lattice_matrix: Matrix3x3 | undefined
    let a_vec: Vec3 | undefined
    let b_vec: Vec3 | undefined
    let c_vec: Vec3 | undefined
    let abc_vals: [number, number, number] | undefined
    let angles: [number, number, number] = [90, 90, 90]

    for (const cl of cell_lines) {
      const tokens = cl.trim().split(/\s+/)
      const key = tokens[0].toUpperCase()

      // Filter out [unit] annotations to get only numeric tokens
      const nums = tokens.slice(1).filter((t) => !t.startsWith(`[`))

      if (key === `A` && nums.length >= 3) {
        a_vec = nums.slice(0, 3).map((s) => parse_coordinate(s)) as Vec3
      } else if (key === `B` && nums.length >= 3) {
        b_vec = nums.slice(0, 3).map((s) => parse_coordinate(s)) as Vec3
      } else if (key === `C` && nums.length >= 3) {
        // Distinguish C vector from C element: vectors have 3 numeric values
        const first_three = nums.slice(0, 3)
        if (first_three.every((t) => !isNaN(parseFloat(t)))) {
          c_vec = first_three.map((s) => parse_coordinate(s)) as Vec3
        }
      } else if (key === `ABC`) {
        abc_vals = nums.slice(0, 3).map((s) => parse_coordinate(s)) as [
          number,
          number,
          number,
        ]
      } else if (key === `ALPHA_BETA_GAMMA`) {
        angles = nums.slice(0, 3).map((s) => parse_coordinate(s)) as [
          number,
          number,
          number,
        ]
      }
    }

    if (a_vec && b_vec && c_vec) {
      lattice_matrix = [a_vec, b_vec, c_vec]
    } else if (abc_vals) {
      lattice_matrix = math.cell_to_lattice_matrix(
        abc_vals[0],
        abc_vals[1],
        abc_vals[2],
        angles[0],
        angles[1],
        angles[2],
      )
    }

    // --- Parse coordinates ---
    let is_scaled = false
    const sites: import('$lib').Site[] = []

    // Check for SCALED keyword
    for (const cl of coord_lines) {
      const trimmed = cl.trim().toUpperCase()
      if (/^SCALED\b/.test(trimmed)) {
        // SCALED T, SCALED (bare), but not SCALED F
        const rest = trimmed.slice(6).trim()
        is_scaled = rest === `` || rest === `T`
        break
      }
    }

    // Pre-compute inverse of transposed matrix for abc calculation
    // Lattice is stored as row vectors; xyz = M^T * abc, so abc = inv(M^T) * xyz
    const lattice_invT = lattice_matrix
      ? math.matrix_inverse_3x3(math.transpose_3x3_matrix(lattice_matrix))
      : undefined

    let atom_idx = 0
    for (const cl of coord_lines) {
      const trimmed = cl.trim()
      if (!trimmed) continue
      const upper = trimmed.toUpperCase()

      // Skip non-coordinate lines
      if (
        /^(SCALED|UNIT)\b/i.test(upper) ||
        /^(PERIODIC|MULTIPLE_UNIT_CELL)\b/i.test(upper)
      ) {
        continue
      }

      const tokens = trimmed.split(/\s+/)
      if (tokens.length < 4) continue

      // Format: Element x y z (or with optional extra columns)
      const element_str = tokens[0]
      // Validate element symbol: starts with letter, 1-3 chars
      if (!/^[A-Za-z]{1,3}$/.test(element_str)) continue

      const element = (element_str.charAt(0).toUpperCase() +
        element_str.slice(1).toLowerCase()) as ElementSymbol

      if (!elem_symbols.includes(element)) continue

      let xyz: Vec3
      let abc: Vec3 = [0, 0, 0]
      try {
        xyz = [
          parse_coordinate(tokens[1]),
          parse_coordinate(tokens[2]),
          parse_coordinate(tokens[3]),
        ]
      } catch {
        continue
      }

      if (is_scaled && lattice_matrix) {
        // xyz currently holds fractional coords, convert to Cartesian
        abc = [...xyz] as Vec3
        const [a_v, b_v, c_v] = lattice_matrix
        xyz = [
          abc[0] * a_v[0] + abc[1] * b_v[0] + abc[2] * c_v[0],
          abc[0] * a_v[1] + abc[1] * b_v[1] + abc[2] * c_v[1],
          abc[0] * a_v[2] + abc[1] * b_v[2] + abc[2] * c_v[2],
        ]
      } else if (lattice_invT) {
        // Cartesian coords: compute fractional from inverse transposed matrix
        abc = math.mat3x3_vec3_multiply(lattice_invT, xyz)
      }

      atom_idx++
      sites.push({
        species: [{ element, occu: 1, oxidation_state: 0 }],
        abc,
        xyz,
        label: `${element}${atom_idx}`,
        properties: {},
      })
    }

    if (sites.length === 0) {
      console.error(`CP2K: no valid coordinates found in &COORD block`)
      return null
    }

    // Apply FIXED_ATOMS constraints as selective_dynamics
    if (fixed_atoms_blocks.length > 0) {
      for (const block of fixed_atoms_blocks) {
        // Convert COMPONENTS_TO_FIX to selective_dynamics (true=free, false=fixed)
        const comp = block.components.toUpperCase()
        const sd: [boolean, boolean, boolean] = [
          !comp.includes(`X`),
          !comp.includes(`Y`),
          !comp.includes(`Z`),
        ]
        for (const atom_1based of block.list) {
          const idx = atom_1based - 1
          if (idx >= 0 && idx < sites.length) {
            const existing = sites[idx].properties?.selective_dynamics as
              | [boolean, boolean, boolean]
              | undefined
            if (existing) {
              // Merge: keep the more restrictive (false wins)
              sites[idx].properties!.selective_dynamics = [
                existing[0] && sd[0],
                existing[1] && sd[1],
                existing[2] && sd[2],
              ]
            } else {
              sites[idx].properties = {
                ...sites[idx].properties,
                selective_dynamics: [...sd],
              }
            }
          }
        }
      }
    }

    // Build lattice info if we have a matrix
    let lattice: ParsedStructure[`lattice`]
    if (lattice_matrix) {
      const params = math.calc_lattice_params(lattice_matrix)
      lattice = { matrix: lattice_matrix, ...params }
    }

    return { sites, lattice }
  } catch (error) {
    console.error(`Error parsing CP2K file:`, error)
    return null
  }
}

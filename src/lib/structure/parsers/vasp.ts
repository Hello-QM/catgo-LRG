import type { Site, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import {
  type ParsedStructure,
  parse_coordinate,
  parse_coordinate_line,
  validate_element_symbol,
} from './common'

// Parse VASP POSCAR file format
export function parse_poscar(content: string): ParsedStructure | null {
  try {
    const lines = content.replace(/^\s+/, ``).split(/\r?\n/)

    if (lines.length < 8) {
      console.error(`POSCAR file too short`)
      return null
    }

    // Parse scaling factor (line 2)
    let scale_factor = parseFloat(lines[1])
    if (isNaN(scale_factor)) {
      console.error(`Invalid scaling factor in POSCAR`)
      return null
    }

    // Parse lattice vectors (lines 3-5)
    const parse_vector = (line: string, line_num: number): Vec3 => {
      const coords = line.trim().split(/\s+/).map(parse_coordinate)
      if (coords.length !== 3) {
        throw new Error(
          `Invalid lattice vector on line ${line_num}: expected 3 coordinates, got ${coords.length}`,
        )
      }
      return coords as Vec3
    }

    const lattice_vecs: Matrix3x3 = [
      parse_vector(lines[2], 3),
      parse_vector(lines[3], 4),
      parse_vector(lines[4], 5),
    ]

    // Handle negative scale factor (volume-based scaling)
    if (scale_factor < 0) {
      const volume = Math.abs(math.det_3x3(lattice_vecs))
      scale_factor = Math.pow(-scale_factor / volume, 1 / 3)
    }

    // Scale lattice vectors
    const scaled_lattice: Matrix3x3 = [
      math.scale(lattice_vecs[0], scale_factor),
      math.scale(lattice_vecs[1], scale_factor),
      math.scale(lattice_vecs[2], scale_factor),
    ]

    // Parse element symbols and atom counts (may span multiple lines)
    let line_index = 5
    let element_symbols: string[] = []
    let atom_counts: number[] = []

    // Detect if this is VASP 5+ format (has element symbols)
    // Try to parse the first token as a number - if it succeeds, it's VASP 4 format
    const first_token = lines[line_index].trim().split(/\s+/)[0]
    const first_token_as_number = parseInt(first_token)
    const has_element_symbols = isNaN(first_token_as_number)

    if (has_element_symbols) {
      // VASP 5+ format - parse element symbols (may span multiple lines)
      let symbol_lines = 1

      // Look ahead to find where numbers start (atom counts)
      for (let lookahead_idx = 1; lookahead_idx < 10; lookahead_idx++) {
        if (line_index + lookahead_idx >= lines.length) break
        const next_line_first_token = lines[line_index + lookahead_idx]
          .trim()
          .split(/\s+/)[0]
        const next_token_as_number = parseInt(next_line_first_token)
        if (!isNaN(next_token_as_number)) {
          symbol_lines = lookahead_idx
          break
        }
      }

      // Collect all element symbols from the symbol lines
      for (
        let symbol_line_idx = 0;
        symbol_line_idx < symbol_lines;
        symbol_line_idx++
      ) {
        if (line_index + symbol_line_idx < lines.length) {
          element_symbols.push(
            ...lines[line_index + symbol_line_idx].trim().split(/\s+/),
          )
        }
      }

      // Parse atom counts (may span multiple lines)
      for (
        let count_line_idx = 0;
        count_line_idx < symbol_lines;
        count_line_idx++
      ) {
        if (line_index + symbol_lines + count_line_idx < lines.length) {
          const counts = lines[line_index + symbol_lines + count_line_idx]
            .trim()
            .split(/\s+/)
            .map(Number)
          atom_counts.push(...counts)
        }
      }

      line_index += 2 * symbol_lines
    } else {
      // VASP 4 format - only atom counts, generate default element symbols
      atom_counts = lines[line_index].trim().split(/\s+/).map(Number)
      element_symbols = atom_counts.map((_, idx) =>
        validate_element_symbol(`Element${idx}`, idx)
      )
      line_index += 1
    }

    if (element_symbols.length !== atom_counts.length) {
      console.error(`Mismatch between element symbols and atom counts`)
      return null
    }

    // Check for selective dynamics
    let has_selective_dynamics = false
    if (line_index < lines.length) {
      let coordinate_mode = lines[line_index].trim().toUpperCase()

      if (coordinate_mode.startsWith(`S`)) {
        has_selective_dynamics = true
        line_index += 1
        if (line_index < lines.length) {
          coordinate_mode = lines[line_index].trim().toUpperCase()
        } else {
          console.error(`Missing coordinate mode after selective dynamics`)
          return null
        }
      }

      // Determine coordinate mode
      const is_direct = coordinate_mode.startsWith(`D`)
      const is_cartesian = coordinate_mode.startsWith(`C`) ||
        coordinate_mode.startsWith(`K`)

      if (!is_direct && !is_cartesian) {
        console.error(`Unknown coordinate mode in POSCAR: ${coordinate_mode}`)
        return null
      }

      // Parse atomic positions
      const sites: Site[] = []
      let atom_index = 0

      for (let elem_idx = 0; elem_idx < element_symbols.length; elem_idx++) {
        const element = validate_element_symbol(
          element_symbols[elem_idx],
          elem_idx,
        )
        const count = atom_counts[elem_idx]

        for (let atom_count_idx = 0; atom_count_idx < count; atom_count_idx++) {
          const coord_line_idx = line_index + 1 + atom_index + atom_count_idx
          if (coord_line_idx >= lines.length) {
            console.error(`Not enough coordinate lines in POSCAR`)
            return null
          }

          const coords = parse_coordinate_line(lines[coord_line_idx])

          // Parse selective dynamics if present
          let selective_dynamics: [boolean, boolean, boolean] | undefined
          if (has_selective_dynamics) {
            const tokens = lines[coord_line_idx].trim().split(/\s+/)
            if (tokens.length >= 6) {
              selective_dynamics = [
                tokens[3] === `T`,
                tokens[4] === `T`,
                tokens[5] === `T`,
              ]
            }
          }
          let xyz: Vec3
          let abc: Vec3
          const [x, y, z] = coords

          if (is_direct) {
            // Store fractional coordinates, wrapping to [0, 1) range
            abc = [x - Math.floor(x), y - Math.floor(y), z - Math.floor(z)]
            // Convert fractional to Cartesian coordinates
            const lattice_transposed = math.transpose_3x3_matrix(scaled_lattice)
            xyz = math.mat3x3_vec3_multiply(lattice_transposed, abc)
          } else { // Already Cartesian, scale if needed
            xyz = math.scale([x, y, z], scale_factor)
            // Calculate fractional coordinates using proper matrix inversion
            // Note: Our lattice matrix is stored as row vectors, but for coordinate conversion
            // we need column vectors, so we transpose before inversion
            let raw_abc: Vec3
            try {
              const lattice_transposed = math.transpose_3x3_matrix(scaled_lattice)
              const lattice_inv = math.matrix_inverse_3x3(lattice_transposed)
              raw_abc = math.mat3x3_vec3_multiply(lattice_inv, xyz)
            } catch {
              // Fallback to simplified method if matrix is singular
              raw_abc = [
                xyz[0] / scaled_lattice[0][0],
                xyz[1] / scaled_lattice[1][1],
                xyz[2] / scaled_lattice[2][2],
              ]
            }
            // Wrap fractional coordinates to [0, 1) range
            abc = [
              raw_abc[0] - Math.floor(raw_abc[0]),
              raw_abc[1] - Math.floor(raw_abc[1]),
              raw_abc[2] - Math.floor(raw_abc[2]),
            ]
          }

          const raw_symbol = element_symbols[elem_idx]
          const is_pseudo_h = element === `H` && raw_symbol !== `H` && /^H[\d.]/.test(raw_symbol)
          const props: Record<string, unknown> = {}
          if (selective_dynamics) props.selective_dynamics = selective_dynamics
          if (is_pseudo_h) {
            props.pseudo_h_potcar = raw_symbol
            props.pseudo_h_charge = parseFloat(raw_symbol.slice(1)) || 1.0
          }

          const site: Site = {
            species: [{ element, occu: 1 }],
            abc,
            xyz,
            label: is_pseudo_h ? raw_symbol : `${element}${atom_index + atom_count_idx + 1}`,
            properties: props,
          }

          sites.push(site)
        }

        atom_index += count
      }

      const lattice_params = math.calc_lattice_params(scaled_lattice)
      const structure: ParsedStructure = {
        sites,
        lattice: { matrix: scaled_lattice, ...lattice_params },
      }

      return structure
    } else {
      console.error(`Missing coordinate mode line in POSCAR`)
      return null
    }
  } catch (error) {
    console.error(`Error parsing POSCAR file:`, error)
    return null
  }
}

// Parse VASP vasprun.xml — extract the final (or only) structure
export function parse_vasprun_xml(content: string): ParsedStructure | null {
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(content, `text/xml`)
    if (doc.querySelector(`parsererror`)) return null

    // Verify it's a VASP XML (root tag = <modeling> or contains <generator><i name="program">vasp</i>)
    const root = doc.documentElement
    if (root.tagName !== `modeling`) return null

    // ── Extract element list from <atominfo> ──
    const atominfo = doc.querySelector(`atominfo`)
    if (!atominfo) return null
    const elements: string[] = []
    const atom_array = atominfo.querySelector(`array[name="atoms"]`)
    if (atom_array) {
      for (const rc of atom_array.querySelectorAll(`set > rc`)) {
        const first_c = rc.querySelector(`c`)
        if (first_c?.textContent) elements.push(first_c.textContent.trim())
      }
    }
    if (elements.length === 0) return null

    // ── Helper: parse a <structure> element ──
    function parse_structure_el(el: Element): ParsedStructure | null {
      const crystal = el.querySelector(`crystal`)
      if (!crystal) return null

      // Lattice basis vectors
      const basis_varray = crystal.querySelector(`varray[name="basis"]`)
      if (!basis_varray) return null
      const basis_vs = basis_varray.querySelectorAll(`v`)
      if (basis_vs.length < 3) return null
      const matrix: Vec3[] = []
      for (let i = 0; i < 3; i++) {
        const nums = basis_vs[i].textContent!.trim().split(/\s+/).map(Number)
        if (nums.length < 3 || nums.some(isNaN)) return null
        matrix.push(nums as unknown as Vec3)
      }

      // Fractional positions
      const pos_varray = el.querySelector(`varray[name="positions"]`)
      if (!pos_varray) return null
      const pos_vs = pos_varray.querySelectorAll(`v`)
      if (pos_vs.length !== elements.length) return null

      const sites: Site[] = []
      for (let i = 0; i < elements.length; i++) {
        const frac = pos_vs[i].textContent!.trim().split(/\s+/).map(Number)
        if (frac.length < 3 || frac.some(isNaN)) return null
        const abc = frac as unknown as Vec3
        const xyz: Vec3 = [
          abc[0] * matrix[0][0] + abc[1] * matrix[1][0] + abc[2] * matrix[2][0],
          abc[0] * matrix[0][1] + abc[1] * matrix[1][1] + abc[2] * matrix[2][1],
          abc[0] * matrix[0][2] + abc[1] * matrix[1][2] + abc[2] * matrix[2][2],
        ]
        const el = validate_element_symbol(elements[i], i)
        sites.push({
          species: [{ element: el, occu: 1 }],
          abc,
          xyz,
          label: elements[i],
          properties: {},
        })
      }

      const mat = matrix as unknown as Matrix3x3
      const { a, b, c, alpha, beta, gamma, volume } = math.calc_lattice_params(mat)
      return {
        lattice: { matrix: mat, a, b, c, alpha, beta, gamma, volume },
        sites,
      }
    }

    // ── Try finalpos → last calculation → initialpos ──
    const finalpos = doc.querySelector(`structure[name="finalpos"]`)
    if (finalpos) {
      const result = parse_structure_el(finalpos)
      if (result) return result
    }
    // Fallback: last <calculation>/<structure>
    const calcs = doc.querySelectorAll(`calculation > structure`)
    if (calcs.length > 0) {
      const result = parse_structure_el(calcs[calcs.length - 1])
      if (result) return result
    }
    // Fallback: initialpos
    const initialpos = doc.querySelector(`structure[name="initialpos"]`)
    if (initialpos) return parse_structure_el(initialpos)

    return null
  } catch (error) {
    console.error(`Error parsing vasprun.xml:`, error)
    return null
  }
}

// Count ionic steps in vasprun.xml (for trajectory detection)
export function count_vasprun_ionic_steps(content: string): number {
  let count = 0
  let idx = 0
  while (true) {
    idx = content.indexOf(`<calculation>`, idx)
    if (idx === -1) break
    count++
    idx += 13
  }
  return count
}

/** Direct children of `el` with the given lowercase tag name (XML is case-sensitive). */
function direct_children(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag)
}

/** First direct child matching tag (+ optional name="…"), or null. */
function direct_child(el: Element, tag: string, name?: string): Element | null {
  for (const c of direct_children(el, tag)) {
    if (name === undefined || c.getAttribute(`name`) === name) return c
  }
  return null
}

// Parse all frames from vasprun.xml as a multi-frame extended-XYZ string for the
// trajectory player. Unlike a bare position dump, each frame carries the ionic
// energy (`energy=` in the comment → energy curve), per-atom forces
// (`forces:R:3` columns → force curve + arrows), and — when the run used
// selective dynamics — a `move_mask:L:1` column (T=free, F=fully fixed) so the
// viewer can exclude constrained atoms from the max-force display. vasprun.xml is
// the one file that carries positions + forces + constraints + energy together.
export function parse_vasprun_trajectory(content: string): string | null {
  try {
    // Strip the `<?xml … encoding="ISO-8859-1"?>` prolog + any BOM before parsing.
    // The JS string is already Unicode, so WebKitGTK's DOMParser can reject the
    // (now-false) byte-encoding declaration with a parsererror — jsdom ignores it.
    // We only need the element tree, so the prolog is safe to drop.
    const xml = content.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/i, ``)
    const parser = new DOMParser()
    const doc = parser.parseFromString(xml, `text/xml`)
    if (doc.querySelector(`parsererror`)) return null
    if (doc.documentElement.tagName !== `modeling`) return null

    // Extract elements
    const elements: string[] = []
    const atom_array = doc.querySelector(`atominfo array[name="atoms"]`)
    if (atom_array) {
      for (const rc of atom_array.querySelectorAll(`set > rc`)) {
        const first_c = rc.querySelector(`c`)
        if (first_c?.textContent) elements.push(first_c.textContent.trim())
      }
    }
    if (elements.length === 0) return null
    const n = elements.length

    // Selective dynamics (constant across frames) lives on the initial structure.
    // move_mask token: T when the atom can move in ANY direction (not fully fixed),
    // F when constrained in all three — matching the "exclude only F F F" rule.
    let move_mask: string[] | null = null
    const init_struct = doc.querySelector(`structure[name="initialpos"]`)
      ?? doc.querySelector(`structure[name="initial_positions"]`)
    const sel_varray = init_struct
      ? direct_child(init_struct, `varray`, `selective`)
      : null
    if (sel_varray) {
      const flags = direct_children(sel_varray, `v`)
      if (flags.length === n) {
        move_mask = flags.map((v) => {
          const toks = (v.textContent ?? ``).trim().split(/\s+/)
          return toks.some((tkn) => tkn.toUpperCase().startsWith(`T`)) ? `T` : `F`
        })
      }
    }

    const calcs = Array.from(doc.querySelectorAll(`calculation`))
    if (calcs.length < 2) return null

    const props = `species:S:1:pos:R:3:forces:R:3` + (move_mask ? `:move_mask:L:1` : ``)
    const frames: string[] = []

    for (const calc of calcs) {
      const struct_el = direct_child(calc, `structure`)
      if (!struct_el) continue
      const crystal = direct_child(struct_el, `crystal`)
      const basis_varray = crystal ? direct_child(crystal, `varray`, `basis`) : null
      if (!basis_varray) continue
      const basis_vs = direct_children(basis_varray, `v`)
      if (basis_vs.length < 3) continue
      const matrix = basis_vs.slice(0, 3).map((v) =>
        (v.textContent ?? ``).trim().split(/\s+/).map(Number)
      )

      const pos_varray = direct_child(struct_el, `varray`, `positions`)
      const pos_vs = pos_varray ? direct_children(pos_varray, `v`) : []
      if (pos_vs.length !== n) continue

      // Forces (Cartesian, eV/Å) for this ionic step.
      const force_varray = direct_child(calc, `varray`, `forces`)
      const force_vs = force_varray ? direct_children(force_varray, `v`) : []
      const forces = force_vs.length === n
        ? force_vs.map((v) => (v.textContent ?? ``).trim().split(/\s+/).map(Number))
        : null

      // Ionic energy: prefer free energy (matches OSZICAR F / TOTEN), then E(sigma→0).
      const energy_el = direct_child(calc, `energy`)
      let energy: number | null = null
      if (energy_el) {
        for (const key of [`e_fr_energy`, `e_0_energy`, `e_wo_entrp`]) {
          const i_el = direct_child(energy_el, `i`, key)
          const val = i_el ? Number((i_el.textContent ?? ``).trim()) : NaN
          if (Number.isFinite(val)) { energy = val; break }
        }
      }

      const lat = matrix.flat().map((v) => v.toFixed(8)).join(` `)
      const energy_tag = energy !== null ? ` energy=${energy}` : ``
      const frame_lines: string[] = [
        String(n),
        `Lattice="${lat}" Properties=${props}${energy_tag} pbc="T T T"`,
      ]
      for (let i = 0; i < n; i++) {
        const abc = (pos_vs[i].textContent ?? ``).trim().split(/\s+/).map(Number)
        const x = abc[0] * matrix[0][0] + abc[1] * matrix[1][0] + abc[2] * matrix[2][0]
        const y = abc[0] * matrix[0][1] + abc[1] * matrix[1][1] + abc[2] * matrix[2][1]
        const z = abc[0] * matrix[0][2] + abc[1] * matrix[1][2] + abc[2] * matrix[2][2]
        const f = forces?.[i] ?? [0, 0, 0]
        const cols = [
          elements[i],
          x.toFixed(8), y.toFixed(8), z.toFixed(8),
          f[0].toFixed(8), f[1].toFixed(8), f[2].toFixed(8),
        ]
        if (move_mask) cols.push(move_mask[i])
        frame_lines.push(cols.join(`  `))
      }
      frames.push(frame_lines.join(`\n`))
    }

    return frames.length >= 2 ? frames.join(`\n`) : null
  } catch {
    return null
  }
}

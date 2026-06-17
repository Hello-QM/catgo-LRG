import type { Site, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import {
  type ParsedStructure,
  validate_element_symbol,
} from './common'

// Apply symmetry operations to generate equivalent positions
const apply_symmetry_ops = (
  atom: CifAtom,
  symmetry_ops: string[],
  wrap_frac: boolean,
): CifAtom[] => {
  if (symmetry_ops.length === 0) return [atom]

  const equivalent_atoms: CifAtom[] = []
  const seen = new Set<string>()
  const wrap = (
    v: Vec3,
  ): Vec3 => (wrap_frac ? v.map((c) => c - Math.floor(c)) as Vec3 : v)
  // Dedup at 3-decimal precision (~0.001). This is the crystallographic
  // standard for "same position". CIFs commonly truncate 1/3 to `0.3333`;
  // applying different symmetry ops to it yields 0.6666 (= 0.3333-0.6667+1)
  // and 0.6667 (= -0.3333+1) — same Wyckoff position differing only by
  // input-precision artifacts. The previous `toFixed(12)` key kept all of
  // them as distinct atoms; 0.001 tolerance collapses them correctly.
  const key = (v: Vec3): string =>
    `${v[0].toFixed(3)},${v[1].toFixed(3)},${v[2].toFixed(3)}`

  // Always include base atom (optionally wrapped)
  const base_coords = wrap(atom.coords as Vec3)
  seen.add(key(base_coords))
  equivalent_atoms.push({ ...atom, coords: base_coords })

  for (const operation of symmetry_ops) {
    const operation_match = operation.match(/['"]([^'"]+)['"]/)
    const expr_str = operation_match ? operation_match[1] : operation.trim()
    const parts = expr_str.split(`,`).map((part) => part.trim())
    if (parts.length !== 3) continue

    const new_coords: Vec3 = [0, 0, 0]

    for (let dim = 0; dim < 3; dim++) {
      const part = parts[dim]
      let expr = part.replace(/\s+/g, ``)
      if (!expr) continue

      // Tokenize the expression into signed terms. Each term is either
      // a variable (x/y/z, optionally signed) or a numeric constant
      // (integer / decimal / fraction, optionally signed). This handles
      // arbitrary CIF symmetry-op forms — single-variable ("x", "x+1/2"),
      // multi-variable ("x-y", "-x+y", "x-y+1/2"), and numeric-only
      // ("1/4", "-0.5"). The previous one-shot regex only captured the
      // first variable and silently dropped the rest, so hexagonal /
      // trigonal CIFs (P6/mmm, P-3m1, etc.) with `x-y` style ops
      // generated wrong atom positions.
      //
      // Normalize so every term carries an explicit leading + or - sign,
      // then split on signed boundaries.
      if (expr[0] !== `+` && expr[0] !== `-`) expr = `+` + expr
      const terms = expr.match(/[+-][^+-]*/g) ?? []

      let coord = 0
      let translation = 0
      for (const term of terms) {
        const sign = term[0] === `-` ? -1 : 1
        const body = term.slice(1)
        if (!body) continue
        if (body === `x` || body === `y` || body === `z`) {
          const var_idx = body === `x` ? 0 : body === `y` ? 1 : 2
          coord += sign * atom.coords[var_idx]
        } else if (body.includes(`/`)) {
          const [num_str, den_str] = body.split(`/`)
          const numerator = parseFloat(num_str)
          const denominator = parseFloat(den_str)
          if (isNaN(numerator) || isNaN(denominator)) {
            console.warn(`Malformed fraction in symmetry operation: ${body}`)
          } else if (denominator === 0) {
            console.warn(`Division by zero in symmetry operation: ${body}`)
          } else translation += sign * (numerator / denominator)
        } else {
          const val = parseFloat(body)
          if (isNaN(val)) {
            console.warn(`Malformed numeric value in symmetry operation: ${body}`)
          } else translation += sign * val
        }
      }

      new_coords[dim] = coord + translation
    }

    // Wrap and deduplicate transformed coordinates
    const wrapped = wrap(new_coords)
    const k = key(wrapped)
    if (seen.has(k)) continue
    seen.add(k)

    equivalent_atoms.push({
      ...atom,
      coords: wrapped,
      id: `${atom.id}_${equivalent_atoms.length}`,
    })
  }

  return equivalent_atoms
}

const extract_cif_cell_parameters = (
  text: string,
  type: string,
  strict = true,
): number[] =>
  text
    .split(`\n`)
    .filter((line) => line.startsWith(`_${type}`))
    .map((line) => {
      const tokens = line.split(/\s+/).filter((token) => token.length > 0)
      if (tokens.length < 2) {
        if (strict) throw new Error(`Invalid CIF cell parameter line format: ${line}`)
        return null
      }
      const value = parseFloat(tokens[tokens.length - 1].split(`(`)[0])
      if (isNaN(value)) {
        if (strict) throw new Error(`Invalid CIF cell parameter in line: ${line}`)
        return null // Return null for invalid values in non-strict mode
      }
      return value
    })
    .filter((v): v is number => v !== null)

// build header index mapping for atom site data (supports fract and Cartn coordinates)
const build_cif_atom_site_header_indices = (
  headers: string[],
): Record<string, number> => {
  const indices: Record<string, number> = {}
  const mappings = [
    [`_atom_site_label`, `label`],
    [`_atom_site_type_symbol`, `symbol`],
    [`_atom_site_fract_x`, `x`],
    [`_atom_site_fract_y`, `y`],
    [`_atom_site_fract_z`, `z`],
    [`_atom_site_cartn_x`, `cart_x`],
    [`_atom_site_cartn_y`, `cart_y`],
    [`_atom_site_cartn_z`, `cart_z`],
    [`_atom_site_occupancy`, `occupancy`],
    [`_atom_site_disorder_group`, `disorder`],
  ]

  headers.forEach((header, idx) => {
    const lower = header.trim().toLowerCase()
    const mapping = mappings.find(([suffix]) => lower.endsWith(suffix))
    if (mapping) indices[mapping[1]] = idx
  })

  return indices
}

type CifAtom = {
  id: string
  element: string
  coords: Vec3
  coords_type: `fract` | `cart`
  occupancy: number
}

// Parse atom data from CIF with robust error handling
const parse_cif_atom_data = (
  raw_data: string[],
  indices: Record<string, number>,
  coords_type: `fract` | `cart`,
): CifAtom => {
  const { label = 0, symbol = -1, occupancy = -1 } = indices
  const coord_indices = coords_type === `fract`
    ? [indices.x, indices.y, indices.z]
    : [indices.cart_x, indices.cart_y, indices.cart_z]

  if (coord_indices.some((idx) => idx === undefined)) {
    throw new Error(`Missing coordinate indices`)
  }

  const coords_triplet = coord_indices.map((idx) => {
    if (idx === undefined) throw new Error(`Invalid coordinate index`)
    const coord_str = raw_data[idx]
    if (!coord_str) throw new Error(`Missing coordinate at index ${idx}`)
    const coord = parseFloat(coord_str.split(`(`)[0])
    if (isNaN(coord)) throw new Error(`Invalid coordinate: ${coord_str}`)
    return coord
  }) as Vec3

  const occu = occupancy >= 0 && raw_data[occupancy]
    ? parseFloat(raw_data[occupancy].split(`(`)[0]) || 1.0
    : 1.0

  const element_symbol =
    (symbol >= 0 && raw_data[symbol]?.match(/^([A-Z][a-z]*)/)?.[1]) ||
    raw_data[label]?.match(/([A-Z][a-z]*)/g)?.[0] ||
    (() => {
      throw new Error(`Could not extract element symbol from: ${raw_data.join(` `)}`)
    })()

  return {
    id: raw_data[label],
    element: element_symbol,
    coords: coords_triplet,
    coords_type,
    occupancy: occu,
  }
}

// Parse CIF (Crystallographic Information File) format
export function parse_cif(
  content: string,
  wrap_frac: boolean = true,
  strict: boolean = true,
): ParsedStructure | null {
  try {
    const text = content.trim()
    if (!text) {
      console.error(`CIF file is empty`)
      return null
    }

    // Find atom site loop that actually contains coordinates (fract or Cartn)
    const lines = text.split(`\n`)
    let atom_headers: string[] = []
    const atom_data_lines: string[] = []
    const symmetry_ops: string[] = []

    for (let ii = 0; ii < lines.length; ii++) {
      if (lines[ii].trim() !== `loop_`) continue

      let jj = ii + 1
      const headers: string[] = []

      // Collect headers for this loop
      while (jj < lines.length && lines[jj].trim().startsWith(`_`)) {
        headers.push(lines[jj].trim())
        jj++
      }

      // Check if this is a symmetry operations loop
      if (
        headers.some((h) =>
          h.includes(`_symmetry_equiv_pos_as_xyz`) ||
          h.includes(`_space_group_symop_operation_xyz`)
        )
      ) {
        // Collect symmetry operations
        while (jj < lines.length) {
          const line = lines[jj].trim()
          if (line === `loop_` || line.startsWith(`data_`)) break
          if (line && !line.startsWith(`#`) && !line.startsWith(`;`)) {
            symmetry_ops.push(line)
          }
          jj++
        }
        continue
      }

      // Not an atom-site loop → continue search
      if (!headers.some((h) => h.includes(`_atom_site_`))) continue

      // Check if this loop contains coordinate headers
      const indices_preview = build_cif_atom_site_header_indices(headers)
      const has_coords =
        (indices_preview.x !== undefined && indices_preview.y !== undefined &&
          indices_preview.z !== undefined) ||
        (indices_preview.cart_x !== undefined && indices_preview.cart_y !== undefined &&
          indices_preview.cart_z !== undefined)

      if (!has_coords) {
        ii = jj - 1
        continue
      }

      // This is the desired atom-site loop with coordinates: collect data lines
      atom_headers = headers
      while (jj < lines.length) {
        const line = lines[jj].trim()
        if (line === `loop_` || line.startsWith(`data_`)) break
        if (line && !line.startsWith(`#`)) {
          if (line.startsWith(`;`)) {
            let multi_line_data = ``
            while (jj < lines.length && !lines[jj].trim().endsWith(`;`)) {
              multi_line_data += lines[jj] + `\n`
              jj++
            }
            multi_line_data += lines[jj]
            atom_data_lines.push(multi_line_data.trim())
          } else {
            atom_data_lines.push(line)
          }
        }
        jj++
      }
      if (atom_data_lines.length > 0) break
    }

    if (!atom_headers.length || !atom_data_lines.length) {
      console.error(`No valid atom site loop found in CIF file`)
      return null
    }

    // Parse atom data with error handling
    const header_indices = build_cif_atom_site_header_indices(atom_headers)

    // Determine available coordinate type
    const coords_type: `fract` | `cart` | null =
      header_indices.x !== undefined && header_indices.y !== undefined &&
        header_indices.z !== undefined
        ? `fract`
        : header_indices.cart_x !== undefined && header_indices.cart_y !== undefined &&
            header_indices.cart_z !== undefined
        ? `cart`
        : null

    if (!coords_type) {
      console.error(`CIF atom site loop missing coordinates (fract or Cartn)`)
      return null
    }

    // Collect required coordinate indices
    const required_indices = coords_type === `fract`
      ? [header_indices.x, header_indices.y, header_indices.z]
      : [header_indices.cart_x, header_indices.cart_y, header_indices.cart_z]

    const atoms = atom_data_lines
      .map((line) => {
        // Handle quoted multi-word values by splitting only on whitespace
        // that is not inside quotes.
        const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
        return tokens.map((token) => token.replace(/['"]/g, ``))
      })
      .filter((tokens) => {
        const { disorder } = header_indices
        const max_required_idx = Math.max(...required_indices)
        return (
          !(disorder !== undefined && tokens[disorder] === `2`) &&
          tokens.length > max_required_idx
        )
      })
      .map((tokens) => {
        try {
          return parse_cif_atom_data(tokens, header_indices, coords_type)
        } catch (error) {
          console.warn(`Skipping invalid atom data: ${error}`)
          return null
        }
      })
      .filter((atom): atom is NonNullable<typeof atom> => atom !== null)

    if (!atoms.length) {
      console.error(`No valid atoms found in CIF file`)
      return null
    }

    // Extract cell parameters and build lattice
    let lengths = extract_cif_cell_parameters(text, `cell_length`, strict)
    let angles = extract_cif_cell_parameters(text, `cell_angle`, strict)

    if (lengths.length < 3 || angles.length < 3) {
      // Some CIFs (e.g. a CatGo export that dropped the lattice) carry
      // fractional coordinates with no unit cell. Rather than refuse to load,
      // fall back to a default cubic cell so the structure is still viewable.
      // Geometry is approximate — re-export with a real cell for accuracy.
      if (coords_type === `fract`) {
        console.warn(`CIF has no unit cell; using a default 10 Å cubic cell (geometry approximate)`)
        lengths = [10, 10, 10]
        angles = [90, 90, 90]
      } else {
        // Cartesian coordinates with NO unit cell → an isolated molecule /
        // cluster. Build a lattice-free structure directly from the parsed
        // Cartesian positions (mirroring the XYZ molecule parser shape) so
        // the 3D viewer can render it. No symmetry/centering machinery — CIF
        // molecules carry no symmetry ops.
        const molecule_sites: Site[] = atoms.map((atom, idx) => {
          const element = validate_element_symbol(atom.element, idx)
          const xyz: Vec3 = [atom.coords[0], atom.coords[1], atom.coords[2]]
          return {
            species: [{ element, occu: atom.occupancy, oxidation_state: 0 }],
            abc: [xyz[0], xyz[1], xyz[2]] as Vec3,
            xyz,
            label: atom.id || `${element}${idx + 1}`,
            properties: {},
          }
        })
        return { sites: molecule_sites }
      }
    }

    // Build lattice and create sites
    const [a, b, c] = lengths
    const [alpha, beta, gamma] = angles
    const lattice_matrix = math.cell_to_lattice_matrix(a, b, c, alpha, beta, gamma)
    const lattice_params = math.calc_lattice_params(lattice_matrix)
    const lattice_T = math.transpose_3x3_matrix(lattice_matrix)
    let lattice_invT: Matrix3x3 | null = null
    try {
      lattice_invT = math.matrix_inverse_3x3(lattice_T)
    } catch {
      lattice_invT = null
    }

    // Create sites with coordinate conversion and symmetry operations
    const wrap_vec3 = (v: Vec3): Vec3 =>
      wrap_frac ? v.map((coord) => coord - Math.floor(coord)) as Vec3 : v

    // Apply symmetry operations to generate all equivalent positions
    const all_sites: Site[] = []

    // Normalize symmetry operations (trim/strip quotes) but preserve duplicates; we deduplicate positions later
    const normalized_ops = symmetry_ops
      .map((op) => op.match(/['\"]([^'\"]+)['\"]/)?.[1] || op.trim())
      .map((op) => op.replace(/\s+/g, ``))

    // Rely on symmetry operations list for all centering/translations to avoid double-counting
    // TODO: Support conventional cells with centering by discovering centering from space group metadata
    // when present (e.g., P, I, F, C, R centering types)
    const centering_vectors: Vec3[] = [[0, 0, 0]]

    // Inspect optional _atom_type_number_in_cell loop to see if atom sites are already expanded
    const atom_type_counts: Record<string, number> = (() => {
      const map: Record<string, number> = {}
      const text_lines = text.split(`\n`)
      for (let li = 0; li < text_lines.length; li++) {
        if (text_lines[li].trim() !== `loop_`) {
          continue
        }
        let lj = li + 1
        const hdrs: string[] = []
        while (lj < text_lines.length && text_lines[lj].trim().startsWith(`_`)) {
          hdrs.push(text_lines[lj].trim().toLowerCase())
          lj++
        }
        const sym_idx = hdrs.findIndex((h) => h.endsWith(`_atom_type_symbol`))
        const num_idx = hdrs.findIndex((h) => h.endsWith(`_atom_type_number_in_cell`))
        if (sym_idx !== -1 && num_idx !== -1) {
          while (lj < text_lines.length) {
            const line = text_lines[lj].trim()
            if (!line || line === `loop_` || line.startsWith(`data_`)) break
            if (line.startsWith(`#`)) {
              lj++
              continue
            }
            const toks = (line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((t) =>
              t.replace(/['"]/g, ``)
            )
            if (toks.length > Math.max(sym_idx, num_idx)) {
              // Normalize type symbol to bare element (e.g., 'Sn2+' -> 'Sn')
              const match = toks[sym_idx]?.match(/^([A-Z][a-z]*)/)
              const sym = match ? match[1] : toks[sym_idx]
              const num = parseInt(toks[num_idx])
              if (sym && !Number.isNaN(num)) map[sym] = num
            }
            lj++
          }
          break
        }
      }
      return map
    })()

    const observed_counts: Record<string, number> = {}
    for (const a of atoms) {
      observed_counts[a.element] = (observed_counts[a.element] || 0) + 1
    }

    const has_expected_counts = Object.keys(atom_type_counts).length > 0
    const already_enumerated = has_expected_counts &&
      Object.entries(atom_type_counts).every(([el, exp]) =>
        (observed_counts[el] || 0) >= exp
      )

    const ops_to_use = already_enumerated ? [] : normalized_ops

    // Global deduplication of final sites (per element + coordinates + label).
    // 3-decimal precision matches the per-op dedup above; see comment there.
    const seen_site_keys = new Set<string>()
    const site_key = (element: string, abc: Vec3, label: string): string =>
      `${element}|${label}|${abc[0].toFixed(3)},${abc[1].toFixed(3)},${
        abc[2].toFixed(3)
      }`

    for (const atom of atoms) {
      const element = validate_element_symbol(atom.element, all_sites.length)

      // Convert to fractional coordinates if needed
      let fract_atom: CifAtom
      if (atom.coords_type === `fract`) {
        fract_atom = {
          ...atom,
          coords: wrap_vec3(atom.coords as Vec3),
          coords_type: `fract`,
        }
      } else {
        const xyz_base: Vec3 = [atom.coords[0], atom.coords[1], atom.coords[2]]
        let atom_abc: Vec3
        if (lattice_invT) {
          const raw = math.mat3x3_vec3_multiply(lattice_invT, xyz_base)
          atom_abc = wrap_vec3(raw as Vec3)
        } else atom_abc = wrap_vec3([xyz_base[0] / a, xyz_base[1] / b, xyz_base[2] / c])
        fract_atom = { ...atom, coords: atom_abc, coords_type: `fract` }
      }

      // First apply symmetry operations in fractional space
      const equiv_atoms = apply_symmetry_ops(fract_atom, ops_to_use, wrap_frac)

      // Then apply lattice centering shifts to each equivalent position
      for (const equiv_atom of equiv_atoms) {
        for (const cv of centering_vectors) {
          const abc = wrap_vec3([
            equiv_atom.coords[0] + cv[0],
            equiv_atom.coords[1] + cv[1],
            equiv_atom.coords[2] + cv[2],
          ] as Vec3)
          const key = site_key(element, abc, equiv_atom.id)
          if (seen_site_keys.has(key)) continue
          seen_site_keys.add(key)
          const xyz = math.mat3x3_vec3_multiply(lattice_T, abc)
          all_sites.push({
            species: [{ element, occu: equiv_atom.occupancy, oxidation_state: 0 }],
            abc,
            xyz,
            label: equiv_atom.id,
            properties: {},
          })
        }
      }
    }

    const sites = all_sites
    return { sites, lattice: { matrix: lattice_matrix, ...lattice_params } }
  } catch (error) {
    console.error(`Error parsing CIF file:`, error)
    return null
  }
}

// VASP OUTCAR parser — extracts the final (last) ionic step as a single structure.
// Lattice from the last "direct lattice vectors" block, positions from the last
// "POSITION ... TOTAL-FORCE" block. Written from the OUTCAR text layout.

import type { Matrix3x3 } from '$lib/math'
import type { Site, Vec3 } from '$lib'
import { type ParsedStructure, validate_element_symbol } from './common'
import { cart_to_frac, make_site, periodic_lattice } from './dft-common'

function species_order(lines: string[]): string[] {
  const species: string[] = []
  for (const line of lines) {
    const m = line.match(/VRHFIN\s*=\s*([A-Za-z]+)/)
    if (m) species.push(m[1])
  }
  if (species.length > 0) return species
  // Fallback: POTCAR title lines, deduped consecutively.
  for (const line of lines) {
    const m = line.match(/^\s*POTCAR:\s+\S+\s+([A-Za-z]+)/)
    if (m && species[species.length - 1] !== m[1]) species.push(m[1])
  }
  return species
}

function atom_counts(lines: string[]): number[] {
  for (const line of lines) {
    const m = line.match(/ions per type\s*=\s*(.+)$/)
    if (m) {
      return m[1].trim().split(/\s+/).map(Number).filter((n) => !isNaN(n))
    }
  }
  return []
}

function ordered_elements(lines: string[]): string[] {
  const species = species_order(lines)
  const counts = atom_counts(lines)
  if (species.length === 0 || counts.length !== species.length) return []
  const out: string[] = []
  for (let i = 0; i < species.length; i++) {
    for (let n = 0; n < counts[i]; n++) out.push(species[i])
  }
  return out
}

function last_lattice(lines: string[]): Matrix3x3 | null {
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`direct lattice vectors`)) found = i
  }
  if (found < 0) return null
  const vecs: Vec3[] = []
  for (let i = found + 1; i < lines.length && vecs.length < 3; i++) {
    const nums = lines[i].trim().split(/\s+/).map(Number)
    if (nums.length >= 3 && nums.slice(0, 3).every((n) => !isNaN(n))) {
      vecs.push([nums[0], nums[1], nums[2]])
    } else break
  }
  return vecs.length === 3 ? (vecs as Matrix3x3) : null
}

function last_positions(lines: string[], n_atoms: number): Vec3[] | null {
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`POSITION`) && lines[i].includes(`TOTAL-FORCE`)) found = i
  }
  if (found < 0) return null
  const out: Vec3[] = []
  // Skip the dashed separator line after the header.
  for (let i = found + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith(`---`) || line === ``) {
      if (out.length === 0) continue // leading dashes
      break // trailing dashes end the block
    }
    const nums = line.split(/\s+/).map(Number)
    if (nums.length < 3 || nums.slice(0, 3).some(isNaN)) break
    out.push([nums[0], nums[1], nums[2]])
    if (n_atoms > 0 && out.length === n_atoms) break
  }
  return out.length > 0 ? out : null
}

// Per-atom magnetic moments from the LAST "magnetization (axis)" table.
// Layout:  magnetization (x) \n \n # of ion  s  p  d  tot \n ---- \n
//          <ion> <s> <p> <d> <tot> ... \n ---- \n tot  ...
// The per-ion `tot` column (last number) is that atom's moment along `axis`.
function magnetization_block(
  lines: string[],
  axis: `x` | `y` | `z`,
  n_atoms: number,
): number[] | null {
  const marker = `magnetization (${axis})`
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) found = i
  }
  if (found < 0) return null
  const vals: number[] = []
  let in_rows = false
  for (let i = found + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith(`# of ion`)) continue
    if (line.startsWith(`---`)) {
      if (!in_rows) { in_rows = true; continue } // header separator → rows begin
      break // trailing separator → block ends
    }
    if (!in_rows || line === ``) continue
    const nums = line.split(/\s+/).map(Number)
    // Stop at the trailing "tot" summary row (non-numeric first column).
    if (nums.length < 2 || Number.isNaN(nums[0])) break
    vals.push(nums[nums.length - 1])
    if (n_atoms > 0 && vals.length === n_atoms) break
  }
  return vals.length > 0 ? vals : null
}

/** Per-atom magmom: scalar (collinear, only the x table) or [mx,my,mz]
 *  (non-collinear, all three tables present). */
function last_magnetization(
  lines: string[],
  n_atoms: number,
): (number | Vec3)[] | null {
  const mx = magnetization_block(lines, `x`, n_atoms)
  if (!mx) return null
  const my = magnetization_block(lines, `y`, n_atoms)
  const mz = magnetization_block(lines, `z`, n_atoms)
  if (my && mz && my.length === mx.length && mz.length === mx.length) {
    return mx.map((x, i) => [x, my[i], mz[i]] as Vec3)
  }
  return mx
}

export function parse_outcar(content: string): ParsedStructure | null {
  try {
    const lines = content.split(/\r?\n/)
    const matrix = last_lattice(lines)
    if (!matrix) return null

    const elements = ordered_elements(lines)
    const positions = last_positions(lines, elements.length)
    if (!positions) return null

    const sites: Site[] = []
    const counters: Record<string, number> = {}
    for (let i = 0; i < positions.length; i++) {
      const symbol = elements[i] ?? `X`
      const element = validate_element_symbol(symbol, i)
      counters[element] = (counters[element] ?? 0) + 1
      const xyz = positions[i]
      sites.push(make_site(element, xyz, cart_to_frac(xyz, matrix), `${element}${counters[element]}`))
    }

    if (sites.length === 0) return null

    // Attach per-atom magnetic moments (spin-polarised runs only) so the viewer
    // can draw magmom arrows without any extra setup.
    const magmoms = last_magnetization(lines, sites.length)
    if (magmoms && magmoms.length === sites.length) {
      for (let i = 0; i < sites.length; i++) {
        sites[i].properties = { ...(sites[i].properties ?? {}), magmom: magmoms[i] }
      }
    }

    return { sites, lattice: periodic_lattice(matrix) }
  } catch (error) {
    console.error(`Error parsing OUTCAR file:`, error)
    return null
  }
}

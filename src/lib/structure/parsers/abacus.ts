// ABACUS STRU parser.
// Reads ATOMIC_SPECIES, LATTICE_CONSTANT (bohr), LATTICE_VECTORS, and
// ATOMIC_POSITIONS (Direct / Cartesian / Cartesian_angstrom). Written from the
// ABACUS STRU format spec.

import type { Matrix3x3 } from '$lib/math'
import type { Site, Vec3 } from '$lib'
import { type ParsedStructure, validate_element_symbol } from './common'
import {
  BOHR_TO_ANG,
  cart_to_frac,
  frac_to_cart,
  make_site,
  periodic_lattice,
  strip_comment,
} from './dft-common'

const SECTIONS = [
  `ATOMIC_SPECIES`,
  `NUMERICAL_ORBITAL`,
  `LATTICE_CONSTANT`,
  `LATTICE_VECTORS`,
  `ATOMIC_POSITIONS`,
  `PAW_FILES`,
]

// Split a STRU file into its named sections (header line → following lines).
function sections(content: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  let current: string | null = null
  for (const raw of content.split(/\r?\n/)) {
    const line = strip_comment(raw)
    if (!line) continue
    const head = line.split(/\s+/)[0].toUpperCase()
    if (SECTIONS.includes(head)) {
      current = head
      map.set(current, [])
      continue
    }
    if (current) map.get(current)!.push(line)
  }
  return map
}

export function parse_abacus_stru(content: string): ParsedStructure | null {
  try {
    const sec = sections(content)
    const lat_vec = sec.get(`LATTICE_VECTORS`)
    const pos = sec.get(`ATOMIC_POSITIONS`)
    if (!lat_vec || lat_vec.length < 3 || !pos || pos.length === 0) return null

    // LATTICE_CONSTANT is in bohr; convert the whole cell to Å.
    const lc_raw = Number(sec.get(`LATTICE_CONSTANT`)?.[0]?.split(/\s+/)[0] ?? `1`)
    const lc = (isNaN(lc_raw) ? 1 : lc_raw) * BOHR_TO_ANG

    const matrix = lat_vec.slice(0, 3).map((r) => {
      const v = r.trim().split(/\s+/).map(Number)
      return [v[0] * lc, v[1] * lc, v[2] * lc] as Vec3
    }) as Matrix3x3
    if (matrix.some((v) => v.some(isNaN))) return null

    // ATOMIC_POSITIONS: first line is the coordinate mode, then per-species blocks:
    //   <element>\n<magnetism>\n<natom>\n<natom coordinate lines>
    const mode = pos[0].trim().toLowerCase()
    const is_direct = mode.startsWith(`direct`)
    const is_cart_ang = mode.startsWith(`cartesian_angstrom`)
    // plain "cartesian" is in units of the lattice constant (Å here).
    const cart_scale = is_cart_ang ? 1 : lc

    const sites: Site[] = []
    const counters: Record<string, number> = {}
    let i = 1
    while (i < pos.length) {
      const element = validate_element_symbol(pos[i].trim().split(/\s+/)[0], sites.length)
      i++ // magnetism line
      if (i >= pos.length) break
      i++ // count line
      if (i >= pos.length) break
      const count = parseInt(pos[i].trim().split(/\s+/)[0], 10)
      i++
      if (!Number.isInteger(count)) break
      for (let k = 0; k < count && i < pos.length; k++, i++) {
        const tok = pos[i].trim().split(/\s+/)
        const raw = [Number(tok[0]), Number(tok[1]), Number(tok[2])] as Vec3
        if (raw.some(isNaN)) continue
        counters[element] = (counters[element] ?? 0) + 1
        let xyz: Vec3
        let abc: Vec3
        if (is_direct) {
          abc = raw
          xyz = frac_to_cart(abc, matrix)
        } else {
          xyz = [raw[0] * cart_scale, raw[1] * cart_scale, raw[2] * cart_scale]
          abc = cart_to_frac(xyz, matrix)
        }
        sites.push(make_site(element, xyz, abc, `${element}${counters[element]}`))
      }
    }

    if (sites.length === 0) return null
    return { sites, lattice: periodic_lattice(matrix) }
  } catch (error) {
    console.error(`Error parsing ABACUS STRU file:`, error)
    return null
  }
}

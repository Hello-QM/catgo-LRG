// OpenMX input (.dat) parser.
// Reads Atoms.UnitVectors + Atoms.SpeciesAndCoordinates with Ang/AU/FRAC units.
// Written from the OpenMX input keyword spec.

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

// OpenMX blocks: `<Name` ... `Name>`
function extract_block(lines: string[], name: string): string[] | null {
  const lower = name.toLowerCase()
  let inside = false
  const out: string[] = []
  for (const raw of lines) {
    const line = strip_comment(raw)
    if (!line) continue
    if (!inside) {
      if (line.toLowerCase() === `<${lower}`) inside = true
      continue
    }
    if (line.toLowerCase() === `${lower}>`) return out
    out.push(line)
  }
  return inside ? out : null
}

function scalar(lines: string[], key: string): string | null {
  const lower = key.toLowerCase()
  for (const raw of lines) {
    const line = strip_comment(raw)
    const tok = line.split(/\s+/)
    if (tok[0]?.toLowerCase() === lower && tok.length >= 2) return tok.slice(1).join(` `)
  }
  return null
}

export function parse_openmx(content: string): ParsedStructure | null {
  try {
    const lines = content.split(/\r?\n/)

    const cell_unit = (scalar(lines, `Atoms.UnitVectors.Unit`) ?? `ang`).toLowerCase()
    const cell_scale = cell_unit.startsWith(`au`) ? BOHR_TO_ANG : 1
    const cell_block = extract_block(lines, `Atoms.UnitVectors`)
    if (!cell_block || cell_block.length < 3) return null
    const matrix = cell_block.slice(0, 3).map((r) => {
      const v = r.trim().split(/\s+/).map(Number)
      return [v[0] * cell_scale, v[1] * cell_scale, v[2] * cell_scale] as Vec3
    }) as Matrix3x3
    if (matrix.some((v) => v.some(isNaN))) return null

    const coord_unit = (scalar(lines, `Atoms.SpeciesAndCoordinates.Unit`) ?? `ang`).toLowerCase()
    const coord_block = extract_block(lines, `Atoms.SpeciesAndCoordinates`)
    if (!coord_block) return null

    const sites: Site[] = []
    const counters: Record<string, number> = {}
    for (const line of coord_block) {
      // index Species x y z [spin up] [spin down] ...
      const tok = line.trim().split(/\s+/)
      if (tok.length < 5) continue
      const element = validate_element_symbol(tok[1], sites.length)
      const raw = [Number(tok[2]), Number(tok[3]), Number(tok[4])] as Vec3
      if (raw.some(isNaN)) continue
      counters[element] = (counters[element] ?? 0) + 1

      let xyz: Vec3
      let abc: Vec3
      if (coord_unit.startsWith(`frac`)) {
        abc = raw
        xyz = frac_to_cart(abc, matrix)
      } else {
        const s = coord_unit.startsWith(`au`) ? BOHR_TO_ANG : 1
        xyz = [raw[0] * s, raw[1] * s, raw[2] * s]
        abc = cart_to_frac(xyz, matrix)
      }
      sites.push(make_site(element, xyz, abc, `${element}${counters[element]}`))
    }

    if (sites.length === 0) return null
    return { sites, lattice: periodic_lattice(matrix) }
  } catch (error) {
    console.error(`Error parsing OpenMX input:`, error)
    return null
  }
}

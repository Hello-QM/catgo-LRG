// Quantum ESPRESSO (pw.x) input parser.
// Scope: ibrav=0 with an explicit CELL_PARAMETERS card. Handles ATOMIC_POSITIONS
// in alat/bohr/angstrom/crystal. Written from the pw.x input description.

import type { Matrix3x3 } from '$lib/math'
import type { Site, Vec3 } from '$lib'
import {
  type ParsedStructure,
  normalize_scientific_notation,
  validate_element_symbol,
} from './common'
import {
  BOHR_TO_ANG,
  cart_to_frac,
  frac_to_cart,
  make_site,
  periodic_lattice,
  strip_comment,
} from './dft-common'

const CARD_HEADERS = new Set([
  `ATOMIC_SPECIES`,
  `ATOMIC_POSITIONS`,
  `K_POINTS`,
  `CELL_PARAMETERS`,
  `OCCUPATIONS`,
  `CONSTRAINTS`,
  `ATOMIC_FORCES`,
  `ADDITIONAL_K_POINTS`,
  `HUBBARD`,
  `SOLVENTS`,
])

function scalar(content: string, re: RegExp): string | null {
  const m = content.match(re)
  return m ? m[1] : null
}

function unit_token(header_line: string): string {
  const m = header_line.match(/[({]?\s*([a-zA-Z_]+)\s*[)}]?\s*$/)
  return m ? m[1].toLowerCase() : ``
}

function is_card_header(line: string): boolean {
  const first = line.trim().split(/\s+/)[0]?.toUpperCase() ?? ``
  return CARD_HEADERS.has(first)
}

export function parse_qe(content: string): ParsedStructure | null {
  try {
    // ibrav must be 0 for this parser (explicit CELL_PARAMETERS).
    const ibrav_str = scalar(content, /ibrav\s*=\s*(-?\d+)/i)
    if (ibrav_str !== null && Number(ibrav_str) !== 0) {
      console.warn(`QE parser: ibrav=${ibrav_str} not supported (only ibrav=0).`)
      return null
    }

    // alat in Å: prefer `A` (Å), else celldm(1) (bohr).
    const a_ang = scalar(content, /(?:^|[\s,&])A\s*=\s*([\d.eEdD+-]+)/im)
    const celldm1 = scalar(content, /celldm\(1\)\s*=\s*([\d.eEdD+-]+)/i)
    let alat: number | null = null
    if (a_ang) alat = parseFloat(normalize_scientific_notation(a_ang))
    else if (celldm1) alat = parseFloat(normalize_scientific_notation(celldm1)) * BOHR_TO_ANG

    const lines = content.split(/\r?\n/).map(strip_comment)

    // ── CELL_PARAMETERS ──
    let matrix: Matrix3x3 | null = null
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toUpperCase().startsWith(`CELL_PARAMETERS`)) {
        const unit = unit_token(lines[i]) || (alat ? `alat` : `bohr`)
        const vecs: Vec3[] = []
        for (let j = i + 1; j < lines.length && vecs.length < 3; j++) {
          if (!lines[j]) continue
          const v = lines[j].trim().split(/\s+/).map((t) =>
            parseFloat(normalize_scientific_notation(t))
          )
          if (v.length < 3 || v.slice(0, 3).some(isNaN)) break
          vecs.push([v[0], v[1], v[2]])
        }
        if (vecs.length < 3) return null
        let scale = 1
        if (unit === `bohr`) scale = BOHR_TO_ANG
        else if (unit === `alat`) {
          if (!alat) return null
          scale = alat
        } // angstrom → 1
        matrix = vecs.map((v) => [v[0] * scale, v[1] * scale, v[2] * scale] as Vec3) as Matrix3x3
        break
      }
    }
    if (!matrix) return null

    // ── ATOMIC_POSITIONS ──
    const sites: Site[] = []
    const counters: Record<string, number> = {}
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toUpperCase().startsWith(`ATOMIC_POSITIONS`)) continue
      const unit = unit_token(lines[i]) || `alat`
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]
        if (!line) continue
        if (is_card_header(line) || line.startsWith(`&`) || line === `/`) break
        const tok = line.trim().split(/\s+/)
        if (tok.length < 4) continue
        const nums = tok.slice(1, 4).map((t) => parseFloat(normalize_scientific_notation(t)))
        if (nums.some(isNaN)) break
        const element = validate_element_symbol(tok[0], sites.length)
        counters[element] = (counters[element] ?? 0) + 1

        let xyz: Vec3
        let abc: Vec3
        const raw = nums as Vec3
        if (unit === `crystal` || unit === `crystal_sg`) {
          abc = raw
          xyz = frac_to_cart(abc, matrix)
        } else {
          let scale = 1
          if (unit === `bohr`) scale = BOHR_TO_ANG
          else if (unit === `alat`) scale = alat ?? 1
          xyz = [raw[0] * scale, raw[1] * scale, raw[2] * scale]
          abc = cart_to_frac(xyz, matrix)
        }
        sites.push(make_site(element, xyz, abc, `${element}${counters[element]}`))
      }
      break
    }

    if (sites.length === 0) return null
    return { sites, lattice: periodic_lattice(matrix) }
  } catch (error) {
    console.error(`Error parsing Quantum ESPRESSO input:`, error)
    return null
  }
}

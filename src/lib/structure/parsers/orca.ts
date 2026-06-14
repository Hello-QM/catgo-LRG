// ORCA input geometry parser (molecule, no lattice).
// Supports:
//   * xyz <charge> <mult> ... *           (inline Cartesian block)
//   %coords ... CTyp xyz ... Coords ... <atoms> end ... end
// `* xyzfile ...` / `* int ...` (external file / internal coords) return null.
// Written from the ORCA input format.

import type { Site, Vec3 } from '$lib'
import { type ParsedStructure, validate_element_symbol } from './common'
import { make_site, strip_comment } from './dft-common'
import { type ZRow, zmatrix_to_sites } from './zmatrix'

// ORCA internal coords: `El r1 r2 r3 bond angle dihedral` (refs 1-based, 0 = none).
function internal_to_sites(lines: string[], start: number): Site[] | null {
  const rows: ZRow[] = []
  for (let i = start; i < lines.length; i++) {
    const line = strip_comment(lines[i])
    if (!line) continue
    if (line.startsWith(`*`)) break
    const t = line.split(/\s+/)
    if (t.length < 7) continue
    const [r1, r2, r3] = [Number(t[1]), Number(t[2]), Number(t[3])]
    const [bond, angle, dih] = [Number(t[4]), Number(t[5]), Number(t[6])]
    const row: ZRow = { el: t[0] }
    if (r1 > 0) { row.r1 = r1; row.bond = bond }
    if (r2 > 0) { row.r2 = r2; row.angle = angle }
    if (r3 > 0) { row.r3 = r3; row.dih = dih }
    rows.push(row)
  }
  return rows.length > 0 ? zmatrix_to_sites(rows) : null
}

function atoms_from_lines(lines: string[], start: number, stop: (l: string) => boolean): Site[] {
  const sites: Site[] = []
  const counters: Record<string, number> = {}
  for (let i = start; i < lines.length; i++) {
    const line = strip_comment(lines[i])
    if (!line) continue
    if (stop(line)) break
    const tok = line.split(/\s+/)
    if (tok.length < 4) continue
    const nums = tok.slice(1, 4).map(Number)
    if (nums.some(isNaN)) continue
    const element = validate_element_symbol(tok[0], sites.length)
    counters[element] = (counters[element] ?? 0) + 1
    sites.push(make_site(element, nums as Vec3, [0, 0, 0], `${element}${counters[element]}`))
  }
  return sites
}

export function parse_orca(content: string): ParsedStructure | null {
  try {
    const lines = content.split(/\r?\n/)

    // Form 1: `* xyz charge mult` … `*`
    for (let i = 0; i < lines.length; i++) {
      const line = strip_comment(lines[i])
      const m = line.match(/^\*\s*(\w+)/)
      if (!m) continue
      const kind = m[1].toLowerCase()
      if (kind === `xyz`) {
        const sites = atoms_from_lines(lines, i + 1, (l) => l.startsWith(`*`))
        return sites.length > 0 ? { sites } : null
      }
      if (kind === `int` || kind === `internal`) {
        const sites = internal_to_sites(lines, i + 1)
        return sites && sites.length > 0 ? { sites } : null
      }
      break // `* xyzfile` (external) → null
    }

    // Form 2: `%coords … Coords … end … end`
    const coords_open = lines.findIndex((l) => /^%coords\b/i.test(strip_comment(l)))
    if (coords_open >= 0) {
      const ctyp = lines.slice(coords_open).find((l) => /^\s*CTyp\s+/i.test(l))
      if (ctyp && !/xyz/i.test(ctyp)) return null // internal coords
      const block_start = lines.findIndex((l, idx) => idx > coords_open && /^\s*Coords\b/i.test(strip_comment(l)))
      if (block_start >= 0) {
        const sites = atoms_from_lines(lines, block_start + 1, (l) => /^end$/i.test(l))
        return sites.length > 0 ? { sites } : null
      }
    }

    return null
  } catch (error) {
    console.error(`Error parsing ORCA input:`, error)
    return null
  }
}

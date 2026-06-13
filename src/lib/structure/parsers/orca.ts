// ORCA input geometry parser (molecule, no lattice).
// Supports:
//   * xyz <charge> <mult> ... *           (inline Cartesian block)
//   %coords ... CTyp xyz ... Coords ... <atoms> end ... end
// `* xyzfile ...` / `* int ...` (external file / internal coords) return null.
// Written from the ORCA input format.

import type { Site, Vec3 } from '$lib'
import { type ParsedStructure, validate_element_symbol } from './common'
import { make_site, strip_comment } from './dft-common'

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
      if (m[1].toLowerCase() === `xyz`) {
        const sites = atoms_from_lines(lines, i + 1, (l) => l.startsWith(`*`))
        return sites.length > 0 ? { sites } : null
      }
      break // `* xyzfile` / `* int` etc. → not inline Cartesian
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

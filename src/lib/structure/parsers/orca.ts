// ORCA input geometry parser (molecule, no lattice).
// Supports the `* xyz <charge> <mult> ... *` Cartesian block. `* xyzfile ...`
// (external coords) and internal-coordinate (`* int`) blocks return null.
// Written from the ORCA input format.

import type { Site, Vec3 } from '$lib'
import { type ParsedStructure, validate_element_symbol } from './common'
import { make_site, strip_comment } from './dft-common'

export function parse_orca(content: string): ParsedStructure | null {
  try {
    const lines = content.split(/\r?\n/)
    // Find the coordinate block opener: `* xyz charge mult`
    let start = -1
    let cartesian = false
    for (let i = 0; i < lines.length; i++) {
      const line = strip_comment(lines[i])
      const m = line.match(/^\*\s*(\w+)/)
      if (m) {
        const kind = m[1].toLowerCase()
        if (kind === `xyz`) {
          start = i
          cartesian = true
        }
        break // first geometry block only
      }
      // `%coords` block alternative
      const c = line.match(/^%coords/i)
      if (c) break // not supported here → null below
    }
    if (start < 0 || !cartesian) return null

    const sites: Site[] = []
    const counters: Record<string, number> = {}
    for (let i = start + 1; i < lines.length; i++) {
      const line = strip_comment(lines[i])
      if (!line) continue
      if (line.startsWith(`*`)) break // block terminator
      const tok = line.split(/\s+/)
      if (tok.length < 4) continue
      const nums = tok.slice(1, 4).map(Number)
      if (nums.some(isNaN)) continue
      const element = validate_element_symbol(tok[0], sites.length)
      counters[element] = (counters[element] ?? 0) + 1
      sites.push(make_site(element, nums as Vec3, [0, 0, 0], `${element}${counters[element]}`))
    }

    if (sites.length === 0) return null
    return { sites }
  } catch (error) {
    console.error(`Error parsing ORCA input:`, error)
    return null
  }
}

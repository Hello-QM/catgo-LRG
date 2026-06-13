// Gaussian input (.gjf / .com) parser (molecule, no lattice).
// Layout: Link0 (%...) → route (#...) → blank → title → blank → "charge mult"
// → Cartesian atom lines → blank. Z-matrix / internal coords return null.
// Written from the Gaussian input file structure.

import type { Site, Vec3 } from '$lib'
import { type ParsedStructure, validate_element_symbol } from './common'
import { make_site } from './dft-common'

// "C", "C1", "6", "C(Iso=13)", "C-C3" → element symbol
function element_token(tok: string): string {
  const m = tok.match(/^([A-Za-z]{1,2})/)
  if (m) return m[1]
  return tok
}

export function parse_gaussian_input(content: string): ParsedStructure | null {
  try {
    // Sections are separated by blank lines. Drop Link0/route, keep through coords.
    const raw_lines = content.split(/\r?\n/).map((l) => l.replace(/!.*$/, ``).trimEnd())

    // Locate the route section (line starting with #), then skip: blank, title,
    // blank, charge/mult line — the atoms follow.
    let i = 0
    while (i < raw_lines.length && !raw_lines[i].trim().startsWith(`#`)) i++
    if (i >= raw_lines.length) return null
    // advance past route (may span multiple lines until a blank)
    while (i < raw_lines.length && raw_lines[i].trim() !== ``) i++
    i++ // blank after route
    // title (until blank)
    while (i < raw_lines.length && raw_lines[i].trim() !== ``) i++
    i++ // blank after title
    // charge / multiplicity line
    const cm = raw_lines[i]?.trim().split(/\s+/)
    if (!cm || cm.length < 2 || cm.some((t) => isNaN(Number(t)))) return null
    i++

    const sites: Site[] = []
    const counters: Record<string, number> = {}
    for (; i < raw_lines.length; i++) {
      const line = raw_lines[i].trim()
      if (line === ``) break
      const tok = line.split(/\s+/)
      // Cartesian forms: "El x y z" or "El freeze x y z". Need the last 3 numeric.
      const nums = tok.slice(-3).map(Number)
      if (tok.length < 4 || nums.some(isNaN)) {
        // Not Cartesian (likely a Z-matrix) → unsupported.
        return sites.length > 0 ? finalize(sites) : null
      }
      const element = validate_element_symbol(element_token(tok[0]), sites.length)
      counters[element] = (counters[element] ?? 0) + 1
      sites.push(make_site(element, nums as Vec3, [0, 0, 0], `${element}${counters[element]}`))
    }

    return sites.length > 0 ? finalize(sites) : null
  } catch (error) {
    console.error(`Error parsing Gaussian input:`, error)
    return null
  }
}

function finalize(sites: Site[]): ParsedStructure {
  return { sites }
}

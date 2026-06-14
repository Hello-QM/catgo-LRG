// Gaussian input (.gjf / .com) parser (molecule, no lattice).
// Layout: Link0 (%...) → route (#...) → blank → title → blank → "charge mult"
// → geometry (Cartesian OR Z-matrix) → blank → optional variables.
// Written from the Gaussian input file structure.

import type { Site, Vec3 } from '$lib'
import { type ParsedStructure, validate_element_symbol } from './common'
import { make_site } from './dft-common'
import { parse_zmatrix } from './zmatrix'

// "C", "C1", "6", "C(Iso=13)", "C-C3" → element symbol
function element_token(tok: string): string {
  const m = tok.match(/^([A-Za-z]{1,2})/)
  return m ? m[1] : tok
}

const is_num = (s: string) => s !== `` && !isNaN(Number(s))

export function parse_gaussian_input(content: string): ParsedStructure | null {
  try {
    const lines = content.split(/\r?\n/).map((l) => l.replace(/!.*$/, ``).trimEnd())

    // route (#...) → blank → title → blank → charge/mult
    let i = 0
    while (i < lines.length && !lines[i].trim().startsWith(`#`)) i++
    if (i >= lines.length) return null
    while (i < lines.length && lines[i].trim() !== ``) i++ // end of route
    i++
    while (i < lines.length && lines[i].trim() !== ``) i++ // end of title
    i++
    const cm = lines[i]?.trim().split(/\s+/)
    if (!cm || cm.length < 2 || cm.some((t) => isNaN(Number(t)))) return null
    i++

    // geometry block (until blank)
    const geom: string[] = []
    for (; i < lines.length && lines[i].trim() !== ``; i++) geom.push(lines[i].trim())
    if (geom.length === 0) return null

    // optional variable block (after the blank): "name value" or "name= value"
    const vars = new Map<string, number>()
    i++ // blank
    for (; i < lines.length && lines[i].trim() !== ``; i++) {
      const t = lines[i].trim().replace(/=/, ` `).split(/\s+/)
      if (t.length >= 2 && is_num(t[1])) vars.set(t[0].toLowerCase(), Number(t[1]))
    }

    // Cartesian if every line is `El x y z` (last 3 numeric, ≥4 tokens).
    const cartesian = geom.every((l) => {
      const tk = l.split(/\s+/)
      return tk.length >= 4 && tk.slice(-3).every(is_num)
    })

    if (cartesian) {
      const sites: Site[] = []
      const counters: Record<string, number> = {}
      for (const l of geom) {
        const tk = l.split(/\s+/)
        const nums = tk.slice(-3).map(Number) as Vec3
        const element = validate_element_symbol(element_token(tk[0]), sites.length)
        counters[element] = (counters[element] ?? 0) + 1
        sites.push(make_site(element, nums, [0, 0, 0], `${element}${counters[element]}`))
      }
      return sites.length > 0 ? { sites } : null
    }

    // Otherwise treat as a Z-matrix.
    const sites = parse_zmatrix(geom, vars)
    return sites && sites.length > 0 ? { sites } : null
  } catch (error) {
    console.error(`Error parsing Gaussian input:`, error)
    return null
  }
}

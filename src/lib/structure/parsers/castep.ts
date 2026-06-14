// CASTEP .cell parser.
// Supports LATTICE_CART / LATTICE_ABC and POSITIONS_FRAC / POSITIONS_ABS blocks,
// with optional `ang` / `bohr` unit lines. Written from the CASTEP cell-file spec.

import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
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

const UNIT_KEYWORDS = new Set([`ang`, `angstrom`, `bohr`, `a0`, `nm`, `m`, `cm`])

function unit_scale(token: string): number | null {
  const u = token.toLowerCase()
  if (u === `ang` || u === `angstrom`) return 1
  if (u === `bohr` || u === `a0`) return BOHR_TO_ANG
  if (u === `nm`) return 10
  if (UNIT_KEYWORDS.has(u)) return 1 // unhandled exotic unit → treat as Å
  return null
}

interface Block {
  name: string
  lines: string[]
}

function extract_blocks(content: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>()
  const lines = content.split(/\r?\n/)
  let current: Block | null = null
  for (const raw of lines) {
    const line = strip_comment(raw)
    if (!line) continue
    const start = line.match(/^%block\s+(\S+)/i)
    if (start) {
      current = { name: start[1].toLowerCase(), lines: [] }
      continue
    }
    const end = line.match(/^%endblock\s+(\S+)/i)
    if (end) {
      if (current) blocks.set(current.name, current.lines)
      current = null
      continue
    }
    if (current) current.lines.push(line)
  }
  return blocks
}

function parse_lattice(blocks: Map<string, string[]>): Matrix3x3 | null {
  const cart = blocks.get(`lattice_cart`)
  if (cart) {
    let rows = cart
    let scale = 1
    const maybe_unit = unit_scale(rows[0].split(/\s+/)[0])
    if (rows[0].trim().split(/\s+/).length === 1 && maybe_unit !== null) {
      scale = maybe_unit
      rows = rows.slice(1)
    }
    if (rows.length < 3) return null
    const m = rows.slice(0, 3).map((r) => {
      const v = r.trim().split(/\s+/).map(Number)
      return [v[0] * scale, v[1] * scale, v[2] * scale] as Vec3
    })
    if (m.some((v) => v.some(isNaN))) return null
    return m as Matrix3x3
  }

  const abc = blocks.get(`lattice_abc`)
  if (abc) {
    let rows = abc
    let scale = 1
    const maybe_unit = unit_scale(rows[0].split(/\s+/)[0])
    if (rows[0].trim().split(/\s+/).length === 1 && maybe_unit !== null) {
      scale = maybe_unit
      rows = rows.slice(1)
    }
    if (rows.length < 2) return null
    const lengths = rows[0].trim().split(/\s+/).map(Number)
    const angles = rows[1].trim().split(/\s+/).map(Number)
    if (lengths.length < 3 || angles.length < 3) return null
    return math.cell_to_lattice_matrix(
      lengths[0] * scale,
      lengths[1] * scale,
      lengths[2] * scale,
      angles[0],
      angles[1],
      angles[2],
    )
  }
  return null
}

export function parse_castep_cell(content: string): ParsedStructure | null {
  try {
    const blocks = extract_blocks(content)
    const matrix = parse_lattice(blocks)
    if (!matrix) return null

    const sites: Site[] = []
    const frac = blocks.get(`positions_frac`)
    const abs = blocks.get(`positions_abs`)

    const counters: Record<string, number> = {}
    const label_for = (el: string): string => {
      counters[el] = (counters[el] ?? 0) + 1
      return `${el}${counters[el]}`
    }

    if (frac) {
      for (const line of frac) {
        const tok = line.trim().split(/\s+/)
        if (tok.length < 4) continue
        const element = validate_element_symbol(tok[0], sites.length)
        const a = [Number(tok[1]), Number(tok[2]), Number(tok[3])] as Vec3
        if (a.some(isNaN)) continue
        sites.push(make_site(element, frac_to_cart(a, matrix), a, label_for(element)))
      }
    } else if (abs) {
      let rows = abs
      let scale = 1
      const maybe_unit = unit_scale(rows[0].split(/\s+/)[0])
      if (rows[0].trim().split(/\s+/).length === 1 && maybe_unit !== null) {
        scale = maybe_unit
        rows = rows.slice(1)
      }
      for (const line of rows) {
        const tok = line.trim().split(/\s+/)
        if (tok.length < 4) continue
        const element = validate_element_symbol(tok[0], sites.length)
        const xyz = [
          Number(tok[1]) * scale,
          Number(tok[2]) * scale,
          Number(tok[3]) * scale,
        ] as Vec3
        if (xyz.some(isNaN)) continue
        sites.push(make_site(element, xyz, cart_to_frac(xyz, matrix), label_for(element)))
      }
    } else {
      return null
    }

    if (sites.length === 0) return null
    return { sites, lattice: periodic_lattice(matrix) }
  } catch (error) {
    console.error(`Error parsing CASTEP .cell file:`, error)
    return null
  }
}

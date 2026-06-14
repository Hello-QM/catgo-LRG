// SIESTA .fdf parser.
// Handles LatticeConstant + LatticeVectors, ChemicalSpeciesLabel, and
// AtomicCoordinatesAndAtomicSpecies with the common AtomicCoordinatesFormat
// modes. Written from the SIESTA fdf format spec.

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

// fdf keys are case-insensitive and ignore '-', '_', '.'
function norm_key(k: string): string {
  return k.toLowerCase().replace(/[-_.]/g, ``)
}

interface Fdf {
  scalars: Map<string, string>
  blocks: Map<string, string[]>
}

function parse_fdf(content: string): Fdf {
  const scalars = new Map<string, string>()
  const blocks = new Map<string, string[]>()
  const lines = content.split(/\r?\n/)
  let block: { name: string; lines: string[] } | null = null
  for (const raw of lines) {
    const line = strip_comment(raw)
    if (!line) continue
    const start = line.match(/^%block\s+(\S+)/i)
    if (start) {
      block = { name: norm_key(start[1]), lines: [] }
      continue
    }
    const end = line.match(/^%endblock\s+(\S+)/i)
    if (end) {
      if (block) blocks.set(block.name, block.lines)
      block = null
      continue
    }
    if (block) {
      block.lines.push(line)
      continue
    }
    const tok = line.split(/\s+/)
    if (tok.length >= 2) scalars.set(norm_key(tok[0]), tok.slice(1).join(` `))
  }
  return { scalars, blocks }
}

export function parse_siesta_fdf(content: string): ParsedStructure | null {
  try {
    const { scalars, blocks } = parse_fdf(content)

    // ── Lattice constant (Å) ──
    let lattice_const = 1
    const lc = scalars.get(`latticeconstant`)
    if (lc) {
      const [val, unit] = lc.trim().split(/\s+/)
      lattice_const = Number(val)
      if ((unit ?? `bohr`).toLowerCase().startsWith(`bohr`)) {
        lattice_const *= BOHR_TO_ANG
      }
      if (isNaN(lattice_const)) return null
    }

    const lv = blocks.get(`latticevectors`)
    if (!lv || lv.length < 3) return null
    const matrix = lv.slice(0, 3).map((r) => {
      const v = r.trim().split(/\s+/).map(Number)
      return [v[0] * lattice_const, v[1] * lattice_const, v[2] * lattice_const] as Vec3
    }) as Matrix3x3
    if (matrix.some((v) => v.some(isNaN))) return null

    // ── species index → element ──
    const species_map = new Map<number, string>()
    const csl = blocks.get(`chemicalspecieslabel`)
    if (csl) {
      for (const line of csl) {
        const tok = line.trim().split(/\s+/)
        if (tok.length >= 3) species_map.set(Number(tok[0]), tok[2])
      }
    }

    // ── coordinate format ──
    const fmt = (scalars.get(`atomiccoordinatesformat`) ?? `bohr`).toLowerCase()
    const is_frac = fmt.includes(`fractional`) || fmt.includes(`scaledbylatticevectors`)
    const is_scaled_cart = fmt === `scaledcartesian`
    const is_ang = fmt.includes(`ang`)
    const cart_scale = is_scaled_cart ? lattice_const : is_ang ? 1 : BOHR_TO_ANG

    const coords = blocks.get(`atomiccoordinatesandatomicspecies`)
    if (!coords) return null

    const sites: Site[] = []
    const counters: Record<string, number> = {}
    for (const line of coords) {
      const tok = line.trim().split(/\s+/)
      if (tok.length < 4) continue
      const xyz_raw = [Number(tok[0]), Number(tok[1]), Number(tok[2])] as Vec3
      const sp_idx = Number(tok[3])
      if (xyz_raw.some(isNaN)) continue
      const label_sym = species_map.get(sp_idx) ?? `X`
      const element = validate_element_symbol(label_sym, sites.length)
      counters[element] = (counters[element] ?? 0) + 1

      let xyz: Vec3
      let abc: Vec3
      if (is_frac) {
        abc = xyz_raw
        xyz = frac_to_cart(abc, matrix)
      } else {
        xyz = [xyz_raw[0] * cart_scale, xyz_raw[1] * cart_scale, xyz_raw[2] * cart_scale]
        abc = cart_to_frac(xyz, matrix)
      }
      sites.push(make_site(element, xyz, abc, `${element}${counters[element]}`))
    }

    if (sites.length === 0) return null
    return { sites, lattice: periodic_lattice(matrix) }
  } catch (error) {
    console.error(`Error parsing SIESTA .fdf file:`, error)
    return null
  }
}

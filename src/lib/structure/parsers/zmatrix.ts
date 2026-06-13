// Z-matrix (internal coordinates) → Cartesian, via NeRF placement.
// Used by the Gaussian input parser for molecules given as a Z-matrix.
// Angles/dihedrals are in degrees (Gaussian convention).

import type { Site, Vec3 } from '$lib'
import { validate_element_symbol } from './common'
import { make_site } from './dft-common'

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scl = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
function unit(a: Vec3): Vec3 {
  const n = Math.hypot(a[0], a[1], a[2])
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0]
}
const DEG = Math.PI / 180

interface ZRow {
  el: string
  r1?: number // 1-based ref
  bond?: number
  r2?: number
  angle?: number
  r3?: number
  dih?: number
}

function resolve(tok: string, vars: Map<string, number>): number | null {
  const neg = tok.startsWith(`-`)
  const key = (neg ? tok.slice(1) : tok).toLowerCase()
  const direct = parseFloat(tok)
  if (!isNaN(direct) && /^[-+]?[\d.eE]+$/.test(tok)) return direct
  if (vars.has(key)) return (neg ? -1 : 1) * vars.get(key)!
  return null
}

/** Place an atom by bond/angle/dihedral relative to C(r1), B(r2), A(r3). */
function place(C: Vec3, B: Vec3, A: Vec3, bond: number, angle: number, dih: number): Vec3 {
  const bc = unit(sub(C, B))
  const n = unit(cross(sub(B, A), bc))
  const nbc = cross(n, bc)
  const d2: Vec3 = [
    -bond * Math.cos(angle),
    bond * Math.cos(dih) * Math.sin(angle),
    bond * Math.sin(dih) * Math.sin(angle),
  ]
  return add(C, [
    bc[0] * d2[0] + nbc[0] * d2[1] + n[0] * d2[2],
    bc[1] * d2[0] + nbc[1] * d2[1] + n[1] * d2[2],
    bc[2] * d2[0] + nbc[2] * d2[1] + n[2] * d2[2],
  ])
}

export function zmatrix_to_sites(rows: ZRow[]): Site[] | null {
  const pos: Vec3[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (i === 0) {
      pos.push([0, 0, 0])
    } else if (i === 1) {
      if (r.r1 === undefined || r.bond === undefined) return null
      pos.push([r.bond, 0, 0])
    } else if (i === 2) {
      if (r.r1 === undefined || r.bond === undefined || r.r2 === undefined || r.angle === undefined) {
        return null
      }
      const C = pos[r.r1 - 1]
      const B = pos[r.r2 - 1]
      const u = unit(sub(B, C))
      // perpendicular to u
      let ref: Vec3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
      const w = unit(cross(u, ref))
      const ang = r.angle * DEG
      pos.push(add(C, scl(add(scl(u, Math.cos(ang)), scl(w, Math.sin(ang))), r.bond)))
    } else {
      if (
        r.r1 === undefined || r.bond === undefined || r.r2 === undefined ||
        r.angle === undefined || r.r3 === undefined || r.dih === undefined
      ) return null
      pos.push(place(pos[r.r1 - 1], pos[r.r2 - 1], pos[r.r3 - 1], r.bond, r.angle * DEG, r.dih * DEG))
    }
  }

  const sites: Site[] = []
  const counters: Record<string, number> = {}
  for (let i = 0; i < rows.length; i++) {
    const element = validate_element_symbol(rows[i].el, i)
    counters[element] = (counters[element] ?? 0) + 1
    sites.push(make_site(element, pos[i], [0, 0, 0], `${element}${counters[element]}`))
  }
  return sites
}

/** Parse Z-matrix text lines (no blanks) + a variable map into rows. */
export function parse_zmatrix(geom: string[], vars: Map<string, number>): Site[] | null {
  const rows: ZRow[] = []
  for (let i = 0; i < geom.length; i++) {
    const tok = geom[i].trim().split(/\s+/)
    if (tok.length === 0 || !tok[0]) continue
    const row: ZRow = { el: tok[0] }
    if (i >= 1) {
      row.r1 = parseInt(tok[1], 10)
      const b = resolve(tok[2], vars)
      if (b === null) return null
      row.bond = b
    }
    if (i >= 2) {
      row.r2 = parseInt(tok[3], 10)
      const a = resolve(tok[4], vars)
      if (a === null) return null
      row.angle = a
    }
    if (i >= 3) {
      row.r3 = parseInt(tok[5], 10)
      const d = resolve(tok[6], vars)
      if (d === null) return null
      row.dih = d
    }
    if (
      (i >= 1 && (isNaN(row.r1!) || row.bond === undefined)) ||
      (i >= 2 && isNaN(row.r2!)) ||
      (i >= 3 && isNaN(row.r3!))
    ) return null
    rows.push(row)
  }
  if (rows.length === 0) return null
  return zmatrix_to_sites(rows)
}

/**
 * Pure (worker-safe) supercell EXPANSION + serialization.
 *
 * This module has NO DOM / Svelte / WASM / three.js dependencies so it can be
 * imported from a Web Worker (see `supercell-export.worker.ts`) AND unit-tested
 * in plain vitest. It expands a BASE cell × (nx,ny,nz) into the real supercell
 * by replicating sites with cell translations and scaling the lattice matrix,
 * then serializes the result to a structure file string.
 *
 * Why a separate module? With the WebGPU large-system overlay ON, the CPU keeps
 * only the BASE cell (the GPU instances it) — so `saveable_structure` is the
 * base cell, not the logical supercell. Export must reconstruct the full
 * supercell. Doing the N× replication + string build on the MAIN thread freezes
 * the UI for large factors, so the worker runs this off-thread.
 */

// ─── Minimal structure POJO shapes (mirrors the pymatgen-style dict) ─────────

export interface CoreSpecies {
  element: string
  occu?: number
  oxidation_state?: number
}

export interface CoreSite {
  species: CoreSpecies[]
  xyz: [number, number, number]
  abc?: [number, number, number]
  label?: string
  properties?: Record<string, unknown>
}

export interface CoreLattice {
  matrix: [[number, number, number], [number, number, number], [number, number, number]]
  pbc?: [boolean, boolean, boolean]
}

export interface CoreStructure {
  lattice?: CoreLattice
  sites: CoreSite[]
  charge?: number
  id?: string
  formula?: string
}

export type Vec3 = [number, number, number]
export type Mat3 = [Vec3, Vec3, Vec3]

// Formats that route through the worker expansion path. POSCAR + (ext)xyz are
// the common large-structure formats and have fully pure serializers here.
export type SupercellExportFormat = `poscar` | `xyz` | `extxyz`

// Threshold (in EXPANDED atom count) beyond which serializing to a single
// string risks exhausting memory even in a worker (~tens of bytes/atom × N).
// Above this the UI asks the user to confirm before kicking off the worker.
// A 20M-atom POSCAR is already ~1 GB of text; 100M would be multi-GB.
export const EXPORT_ATOM_CONFIRM_THRESHOLD = 20_000_000

// ─── Pure 3×3 math (kept local so the worker pulls in no other modules) ──────

function transpose(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ]
}

// matrix · vector (matrix rows dotted with the vector)
function mat_vec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ]
}

function inverse_3x3(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-15) throw new Error(`Singular lattice matrix`)
  const inv = 1 / det
  return [
    [(e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv],
    [(f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv],
    [(d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ]
}

// ─── Expansion ───────────────────────────────────────────────────────────────

// Number of atoms the expanded supercell will contain. Cheap (no allocation) so
// callers can guard / show a count before paying for the full build.
export function expanded_atom_count(base: CoreStructure, factors: Vec3): number {
  const [nx, ny, nz] = factors
  return base.sites.length * nx * ny * nz
}

/**
 * Replicate `base` sites across the (nx,ny,nz) cell grid and scale the lattice.
 *
 * Mirrors `make_supercell` (src/lib/structure/supercell.ts) but in plain TS with
 * NO `to_unit_cell` wrap — for export we keep the natural expanded Cartesian
 * lattice so each replica sits at `site.xyz + ix·a + iy·b + iz·c` and the new
 * fractional coords land in [0,1) of the SCALED cell by construction.
 */
export function expand_supercell(base: CoreStructure, factors: Vec3): CoreStructure {
  if (!base.lattice?.matrix) {
    throw new Error(`Cannot expand supercell: structure has no lattice`)
  }
  const [nx, ny, nz] = factors
  if (![nx, ny, nz].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error(`Supercell factors must be positive integers: ${factors}`)
  }
  const det = nx * ny * nz

  const orig_matrix = base.lattice.matrix
  const new_matrix: Mat3 = [
    [orig_matrix[0][0] * nx, orig_matrix[0][1] * nx, orig_matrix[0][2] * nx],
    [orig_matrix[1][0] * ny, orig_matrix[1][1] * ny, orig_matrix[1][2] * ny],
    [orig_matrix[2][0] * nz, orig_matrix[2][1] * nz, orig_matrix[2][2] * nz],
  ]

  // Pre-compute transposes/inverse once (constant for every replica).
  const orig_T = transpose(orig_matrix)
  const new_T = transpose(new_matrix)
  const new_T_inv = inverse_3x3(new_T)

  const new_sites: CoreSite[] = new Array(base.sites.length * det)
  let out = 0
  for (let kk = 0; kk < nz; kk++) {
    for (let jj = 0; jj < ny; jj++) {
      for (let ii = 0; ii < nx; ii++) {
        const translation = mat_vec(orig_T, [ii, jj, kk])
        const suffix = det > 1 ? `_${ii}${jj}${kk}` : ``
        for (const site of base.sites) {
          const cart: Vec3 = [
            site.xyz[0] + translation[0],
            site.xyz[1] + translation[1],
            site.xyz[2] + translation[2],
          ]
          const frac = mat_vec(new_T_inv, cart)
          new_sites[out++] = {
            species: site.species,
            xyz: cart,
            abc: frac,
            label: suffix && site.label ? `${site.label}${suffix}` : site.label,
            properties: site.properties,
          }
        }
      }
    }
  }

  return {
    ...base,
    lattice: { ...base.lattice, matrix: new_matrix },
    sites: new_sites,
    charge: base.charge ? base.charge * det : base.charge,
  }
}

// ─── Pure serializers (no DOM) ───────────────────────────────────────────────

function element_of(site: CoreSite): string {
  return site.species?.[0]?.element || `X`
}

function fmt(n: number, digits: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(digits)
}

// VASP POSCAR (Direct/fractional coords, element groups in first-appearance
// order, optional Selective dynamics). Pure equivalent of structure_to_poscar_str.
export function serialize_poscar(structure: CoreStructure, comment = `CatGo supercell export`): string {
  if (!structure.lattice?.matrix) throw new Error(`POSCAR requires a lattice`)
  const matrix = structure.lattice.matrix
  const inv = inverse_3x3(transpose(matrix as Mat3))

  const lines: string[] = [structure.id || structure.formula || comment, `1.0`]
  for (const row of matrix) {
    lines.push(`  ${row.map((v) => fmt(v, 10).padStart(20)).join(``)}`)
  }

  // Count elements preserving first-appearance order.
  const order: string[] = []
  const counts: Record<string, number> = {}
  for (const site of structure.sites) {
    const el = element_of(site)
    if (!(el in counts)) {
      order.push(el)
      counts[el] = 0
    }
    counts[el]++
  }
  lines.push(order.join(`  `))
  lines.push(order.map((el) => counts[el]).join(`  `))

  const has_sel_dyn = structure.sites.some((s) => s.properties?.selective_dynamics)
  if (has_sel_dyn) lines.push(`Selective dynamics`)
  lines.push(`Direct`)

  for (const el of order) {
    for (const site of structure.sites) {
      if (element_of(site) !== el) continue
      const frac = site.abc ?? mat_vec(inv, site.xyz)
      let line = `  ${frac.map((v) => fmt(v, 10).padStart(20)).join(``)}`
      if (has_sel_dyn) {
        const sd = (site.properties?.selective_dynamics ?? [true, true, true]) as boolean[]
        line += ` ${sd[0] ? `T` : `F`} ${sd[1] ? `T` : `F`} ${sd[2] ? `T` : `F`}`
      }
      lines.push(line)
    }
  }
  return lines.join(`\n`) + `\n`
}

// (extended) XYZ. With `include_forces`/lattice this matches structure_to_xyz_str's
// extxyz comment line; plain XYZ omits the lattice/Properties header extras.
export function serialize_xyz(structure: CoreStructure, include_forces = false): string {
  const lines: string[] = [String(structure.sites.length)]

  const has_forces = include_forces &&
    structure.sites.some((s) => Array.isArray(s.properties?.force))

  if (include_forces) {
    const comment_parts: string[] = []
    if (structure.lattice?.matrix?.length === 3) {
      const lat = structure.lattice.matrix.flat().map((v) => fmt(v, 8)).join(` `)
      comment_parts.push(`Lattice="${lat}"`)
    }
    const cols = [`species:S:1`, `pos:R:3`]
    if (has_forces) cols.push(`forces:R:3`)
    comment_parts.push(`Properties="${cols.join(`:`)}"`)
    if (structure.lattice?.pbc) {
      comment_parts.push(`pbc="${structure.lattice.pbc.map((v) => (v ? `T` : `F`)).join(` `)}"`)
    }
    lines.push(comment_parts.join(` `))
  } else {
    lines.push(structure.id || structure.formula || `CatGo supercell export`)
  }

  for (const site of structure.sites) {
    const el = element_of(site)
    const [x, y, z] = site.xyz
    let line = `${el} ${fmt(x, 8)} ${fmt(y, 8)} ${fmt(z, 8)}`
    if (has_forces) {
      const f = site.properties?.force as number[] | undefined
      line += f && f.length >= 3
        ? ` ${fmt(f[0], 8)} ${fmt(f[1], 8)} ${fmt(f[2], 8)}`
        : ` 0.00000000 0.00000000 0.00000000`
    }
    lines.push(line)
  }
  return lines.join(`\n`) + `\n`
}

// ─── Combined expand + serialize (the worker's core unit of work) ────────────

export function expand_and_serialize(
  base: CoreStructure,
  factors: Vec3,
  format: SupercellExportFormat,
): string {
  const expanded = expand_supercell(base, factors)
  switch (format) {
    case `poscar`:
      return serialize_poscar(expanded)
    case `xyz`:
      return serialize_xyz(expanded, false)
    case `extxyz`:
      return serialize_xyz(expanded, true)
    default:
      throw new Error(`Unsupported supercell export format: ${format}`)
  }
}

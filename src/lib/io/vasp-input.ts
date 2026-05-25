// VASP INCAR + KPOINTS generation — client-side port of the server's
// interactive generator (server/catgo/utils/vasp_input.py, "Path A").
//
// Scope: opt (relax) and scf (static) calculation types. Output matches the
// server semantically (INCAR key->value) and byte-exact for KPOINTS. Acceptance
// is verified against pymatgen-derived fixtures in tests/vitest/io/vasp-input.test.ts.
//
// This does NOT implement MP*Set semantics (MAGMOM auto-init, LDAU rules, POTCAR
// functional selection) — the server does not implement them either; those are a
// separate future epic. POTCAR files are never generated or distributed.

import type { AnyStructure } from '$lib'

export type VaspCalcType = `opt` | `scf` | `freq` | `dos` | `bader`

export interface VaspRequest {
  calculation_type: VaspCalcType
  encut?: number
  prec?: string
  gga?: string
  ediff?: number
  ispin?: number
  /** Ionic convergence (eV/Ang), opt only. */
  ediffg?: number
  /** vdW correction flag (0 none, 11 D3, 12 D3-BJ). */
  ivdw?: number
  /** MAGMOM string (passthrough, verbatim). */
  magmom?: string
  // KPOINTS controls
  kspacing?: number
  /** Explicit Monkhorst mesh [kx, ky, kz]. */
  kmesh?: [number, number, number]
}

/** Calc types this client-side generator supports (others require the backend). */
export const SUPPORTED_CALC_TYPES: VaspCalcType[] = [`opt`, `scf`, `freq`, `dos`, `bader`]

type IncarValue = number | string | boolean
type IncarParams = Record<string, IncarValue>

// ---------- Python-faithful value formatting ----------

// Keys whose numeric values are floats in pymatgen (rendered like Python str(float)).
// Everything else numeric is an int (no `.0`).
const FLOAT_KEYS = new Set([`ENCUT`, `EDIFF`, `EDIFFG`, `SIGMA`, `POTIM`, `AMIX`, `BMIX`, `AMIX_MAG`, `BMIX_MAG`])
// Keys whose string values pymatgen's Incar capitalizes (first upper, rest lower).
const STRING_KEYS = new Set([`SYSTEM`, `PREC`, `GGA`, `ALGO`, `LREAL`])

const capitalize = (s: string): string => (s.length ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s)

// Reproduce Python's str(float): integer-valued floats keep `.0`; magnitudes with
// decimal exponent < -4 or >= 16 use scientific notation with a >=2-digit exponent.
export function py_float(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return `${x}.0`
  const exp = x === 0 ? 0 : Math.floor(Math.log10(Math.abs(x)))
  if (x !== 0 && (exp < -4 || exp >= 16)) {
    const [mantissa, e] = x.toExponential().split(`e`)
    const sign = e[0] === `-` ? `-` : `+`
    const digits = e.replace(/[+-]/, ``).padStart(2, `0`)
    return `${mantissa}e${sign}${digits}`
  }
  return String(x)
}

function fmt_value(key: string, val: IncarValue): string {
  if (typeof val === `boolean`) return val ? `  .TRUE.` : `  .FALSE.`
  if (typeof val === `string`) return STRING_KEYS.has(key) ? capitalize(val) : val
  return FLOAT_KEYS.has(key) ? py_float(val) : String(val)
}

// ---------- INCAR ----------

// Grouped section layout, mirroring _INCAR_SECTIONS in vasp_input.py. Within-section
// key order here is fixed (the server's is set-iteration order, i.e. non-deterministic,
// so we choose a stable order — INCAR is order-independent for VASP).
const INCAR_SECTIONS: Array<[string, string[]]> = [
  [`General`, [`SYSTEM`, `PREC`, `ENCUT`, `GGA`, `ALGO`, `LREAL`, `ISYM`, `ADDGRID`]],
  [`Electronic convergence`, [`EDIFF`, `NELM`, `NELMIN`, `NELMDL`, `ICHARG`, `ISTART`, `AMIX`, `BMIX`, `AMIX_MAG`, `BMIX_MAG`, `LMAXMIX`]],
  [`Smearing`, [`ISMEAR`, `SIGMA`]],
  [`Spin`, [`ISPIN`, `MAGMOM`]],
  [`Ionic relaxation / MD`, [`IBRION`, `NSW`, `ISIF`, `EDIFFG`, `POTIM`, `NFREE`]],
  [`Output`, [`LWAVE`, `LCHARG`, `LORBIT`, `LELF`, `LAECHG`, `NWRITE`, `NEDOS`, `NBANDS`]],
  [`vdW correction`, [`IVDW`]],
  [`Parallelization`, [`NCORE`, `NPAR`]],
]

export function format_incar(params: IncarParams): string {
  const remaining: IncarParams = { ...params }
  const lines: string[] = []
  for (const [section, keys] of INCAR_SECTIONS) {
    const present = keys.filter((k) => k in remaining)
    if (present.length === 0) continue
    lines.push(`# ${section}`)
    for (const key of present) {
      lines.push(`${key.padEnd(20)} = ${fmt_value(key, remaining[key])}`)
      delete remaining[key]
    }
    lines.push(``)
  }
  const leftover = Object.keys(remaining)
  if (leftover.length) {
    lines.push(`# Other`)
    for (const key of leftover) lines.push(`${key.padEnd(20)} = ${fmt_value(key, remaining[key])}`)
    lines.push(``)
  }
  return lines.join(`\n`)
}

const COMMON_DEFAULTS: IncarParams = {
  ALGO: `Fast`, LREAL: `Auto`, NELM: 150, NELMIN: 6, ICHARG: 1, ISYM: -1, IVDW: 12, LORBIT: 11,
}

export function build_incar_params(req: VaspRequest): IncarParams {
  const encut = req.encut ?? 450.0
  const prec = req.prec ?? `Accurate`
  const gga = req.gga ?? `PE`
  const ediff = req.ediff ?? 1e-5
  const ispin = req.ispin ?? 2
  // PREC/ENCUT/GGA/EDIFF/ISPIN are applied as overrides last by the server too,
  // so the resolved request value always wins (e.g. freq's "Normal" preset is
  // overridden by request.prec). Using the resolved values here matches that.
  const base: IncarParams = { ALGO: `Fast`, PREC: prec, ENCUT: encut, GGA: gga, EDIFF: ediff, ISPIN: ispin }

  let params: IncarParams
  if (req.calculation_type === `opt`) {
    params = { ...base, ISMEAR: 0, SIGMA: 0.05, IBRION: 2, ISIF: 3, NSW: 100,
      EDIFFG: req.ediffg ?? -0.05, LWAVE: false, LCHARG: true, NCORE: 24 }
  } else if (req.calculation_type === `freq`) {
    params = { ...base, ISMEAR: 0, SIGMA: 0.05, IBRION: 5, NFREE: 2, POTIM: 0.015,
      NWRITE: 3, NSW: 0, LWAVE: false, LCHARG: true, NPAR: 1 } // NPAR (not NCORE) required for IBRION=5
  } else if (req.calculation_type === `dos`) {
    params = { ...base, ISMEAR: -5, SIGMA: 0.05, NSW: 0, IBRION: -1, NEDOS: 3001,
      LWAVE: false, LCHARG: true, NCORE: 24 }
  } else if (req.calculation_type === `bader`) {
    params = { ...base, ISMEAR: 0, SIGMA: 0.05, NSW: 0, IBRION: -1,
      LCHARG: true, LAECHG: true, LWAVE: false, NCORE: 24 }
  } else { // scf
    params = { ...base, ISMEAR: 0, SIGMA: 0.05, NSW: 0, IBRION: -1,
      LWAVE: true, LCHARG: true, NCORE: 24 }
  }
  // Server spreads common_defaults (minus NCORE) last, so ALGO resolves to "Fast".
  for (const [k, v] of Object.entries(COMMON_DEFAULTS)) if (k !== `NCORE`) params[k] = v
  // UI overrides (mirror the server's "Apply user-provided overrides" tail).
  if (req.ivdw != null) params.IVDW = req.ivdw
  if (req.magmom) params.MAGMOM = req.magmom
  return params
}

export function generate_incar_str(req: VaspRequest): string {
  return format_incar(build_incar_params(req))
}

// ---------- KPOINTS ----------

const TWO_PI = 2 * Math.PI

function det3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

function lengths_of(m: number[][]): [number, number, number] {
  return [Math.hypot(...m[0]), Math.hypot(...m[1]), Math.hypot(...m[2])] as [number, number, number]
}

function angles_of(m: number[][]): [number, number, number] {
  const L = lengths_of(m)
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const deg = (r: number) => (r * 180) / Math.PI
  const ang = (i: number, j: number) => deg(Math.acos(Math.max(-1, Math.min(1, dot(m[i], m[j]) / (L[i] * L[j])))))
  // alpha (b,c), beta (a,c), gamma (a,b)
  return [ang(1, 2), ang(0, 2), ang(0, 1)]
}

// pymatgen Lattice.is_hexagonal(hex_angle_tol=5, hex_length_tol=0.01)
export function is_hexagonal(matrix: number[][], hex_angle_tol = 5, hex_length_tol = 0.01): boolean {
  const L = lengths_of(matrix)
  const A = angles_of(matrix)
  const right = [0, 1, 2].filter((i) => Math.abs(A[i] - 90) < hex_angle_tol)
  const hex = [0, 1, 2].filter((i) => Math.abs(A[i] - 60) < hex_angle_tol || Math.abs(A[i] - 120) < hex_angle_tol)
  return right.length === 2 && hex.length === 1 && Math.abs(L[right[0]] - L[right[1]]) < hex_length_tol
}

export interface KpointsFlags {
  isHexagonal?: boolean
  isFaceCentered?: boolean
  forceGamma?: boolean
}

// Port of pymatgen Kpoints.automatic_density + automatic_density_by_vol.
export function automatic_density_by_vol(
  matrix: number[][],
  natoms: number,
  kppvol: number,
  flags: KpointsFlags = {},
): string {
  const vol = (TWO_PI ** 3) / Math.abs(det3(matrix)) // reciprocal-lattice volume (incl. 2*pi)
  let kppa = kppvol * vol * natoms
  const comment = `pymatgen with grid density = ${Math.round(kppa)} / number of atoms`
  if (Math.abs(Math.floor(Math.cbrt(kppa) + 0.5) ** 3 - kppa) < 1) kppa += kppa * 0.01
  const L = lengths_of(matrix)
  const ngrid = kppa / natoms
  const mult = (ngrid * L[0] * L[1] * L[2]) ** (1 / 3)
  const num_div = L.map((len) => {
    const n = Math.floor(Math.max(mult / len, 1))
    return Number.isFinite(n) && n >= 1 ? n : 1 // guard natoms<1 / degenerate cell (NaN -> 1)
  })
  const has_odd = num_div.some((n) => n % 2 === 1)
  const use_gamma =
    has_odd || (flags.isHexagonal ?? is_hexagonal(matrix)) || (flags.isFaceCentered ?? false) || (flags.forceGamma ?? false)
  const style = use_gamma ? `Gamma` : `Monkhorst`
  return `${comment}\n0\n${style}\n${num_div.join(` `)}\n`
}

function monkhorst_str(mesh: [number, number, number]): string {
  return `Automatic kpoint scheme\n0\nMonkhorst\n${mesh[0]} ${mesh[1]} ${mesh[2]}\n`
}

function gamma_str(mesh: [number, number, number]): string {
  return `Automatic kpoint scheme\n0\nGamma\n${mesh[0]} ${mesh[1]} ${mesh[2]}\n`
}

function inv3(m: number[][]): number[][] {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2]
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

/** Lengths of the 2*pi reciprocal-lattice vectors (matches pymatgen reciprocal_lattice.abc). */
function reciprocal_lengths(m: number[][]): [number, number, number] {
  const inv = inv3(m)
  const col_norm = (j: number) => Math.hypot(inv[0][j], inv[1][j], inv[2][j])
  return [TWO_PI * col_norm(0), TWO_PI * col_norm(1), TWO_PI * col_norm(2)]
}

function mat_natoms(structure: AnyStructure): { matrix: number[][]; natoms: number; cvec: number } {
  const lattice = (`lattice` in structure ? structure.lattice : undefined) as { matrix?: number[][] } | undefined
  if (!lattice?.matrix || lattice.matrix.length < 3) throw new Error(`No lattice matrix for KPOINTS`)
  const matrix = lattice.matrix
  const cvec = Math.hypot(...matrix[2])
  return { matrix, natoms: structure.sites?.length ?? 0, cvec }
}

// High-level KPOINTS for a frontend structure. Mirrors generate_kpoints in vasp_input.py:
// explicit mesh, or kspacing, or default automatic_density_by_vol(1000); slab clamp (c>15 -> kz=1).
export function generate_kpoints_str(
  structure: AnyStructure,
  req: VaspRequest = { calculation_type: `scf` },
  flags: KpointsFlags = {},
): string {
  const { matrix, natoms, cvec } = mat_natoms(structure)
  const is_slab = cvec > 15

  if (req.kmesh) {
    // Clamp each division to a positive integer (VASP requires >= 1).
    const mesh = req.kmesh.map((n) => Math.max(1, Math.round(n) || 1)) as [number, number, number]
    if (is_slab && mesh[2] > 1) mesh[2] = 1
    return monkhorst_str(mesh)
  }
  if (req.kspacing != null && req.kspacing > 0) {
    // KSPACING (Å^-1, VASP semantics): N_i = max(1, ceil(|b_i| / kspacing)).
    const blen = reciprocal_lengths(matrix)
    const mesh = blen.map((bi) => Math.max(1, Math.ceil(bi / req.kspacing!))) as [number, number, number]
    if (is_slab && mesh[2] > 1) mesh[2] = 1
    return gamma_str(mesh)
  }
  // Default: automatic density (kppvol = 1000).
  const kpts = automatic_density_by_vol(matrix, natoms, 1000, flags)
  if (is_slab) {
    const parts = kpts.split(`\n`)
    const mesh = parts[3].split(/\s+/).map(Number) as [number, number, number]
    if (mesh.length === 3 && mesh[2] > 1) {
      mesh[2] = 1
      return monkhorst_str(mesh)
    }
  }
  return kpts
}

// Optional: compute is_face_centered from symmetry (moyo-wasm). Face-centered space
// groups (international symbol starts with "F") -> Gamma-centered mesh in pymatgen.
const FACE_CENTERED_SG = new Set([196, 202, 203, 209, 210, 216, 219, 225, 226, 227, 228])
export async function face_centered_from_symmetry(structure: AnyStructure): Promise<boolean> {
  const { analyze_structure_symmetry } = await import(`$lib/symmetry`)
  const data = await analyze_structure_symmetry(structure, {})
  const num = (data as { number?: number }).number
  return typeof num === `number` && FACE_CENTERED_SG.has(num)
}

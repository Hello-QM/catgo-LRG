import {
  automatic_density_by_vol,
  build_incar_params,
  format_incar,
  generate_incar_str,
  generate_kpoints_str,
  py_float,
} from '$lib/io/vasp-input'
import { describe, expect, it } from 'vitest'

// Reference output captured from the actual server generator
// (server/catgo/utils/vasp_input.py via pymatgen, lit311 env) for the NaCl cubic
// conventional cell (src/site/structures/NaCl-cubic.poscar). INCAR is compared
// semantically (key->value, order-independent); KPOINTS is byte-exact.

const NACL_A = 5.6903014761756712
const NACL_MATRIX = [[NACL_A, 0, 0], [0, NACL_A, 0], [0, 0, NACL_A]]
const NACL_NATOMS = 8

const REF_INCAR_OPT: Record<string, string> = {
  ENCUT: `450.0`, GGA: `Pe`, PREC: `Accurate`, LREAL: `Auto`, ALGO: `Fast`, ISYM: `-1`,
  ICHARG: `1`, NELM: `150`, NELMIN: `6`, EDIFF: `1e-05`, ISMEAR: `0`, SIGMA: `0.05`,
  ISPIN: `2`, IBRION: `2`, EDIFFG: `-0.05`, ISIF: `3`, NSW: `100`, LWAVE: `.FALSE.`,
  LORBIT: `11`, LCHARG: `.TRUE.`, IVDW: `12`, NCORE: `24`,
}
const REF_INCAR_SCF: Record<string, string> = {
  ENCUT: `450.0`, GGA: `Pe`, PREC: `Accurate`, LREAL: `Auto`, ALGO: `Fast`, ISYM: `-1`,
  ICHARG: `1`, NELM: `150`, NELMIN: `6`, EDIFF: `1e-05`, ISMEAR: `0`, SIGMA: `0.05`,
  ISPIN: `2`, IBRION: `-1`, NSW: `0`, LWAVE: `.TRUE.`, LORBIT: `11`,
  LCHARG: `.TRUE.`, IVDW: `12`, NCORE: `24`,
}
const REF_INCAR_FREQ: Record<string, string> = {
  PREC: `Accurate`, ENCUT: `450.0`, GGA: `Pe`, ALGO: `Fast`, LREAL: `Auto`, ISYM: `-1`,
  EDIFF: `1e-05`, NELM: `150`, NELMIN: `6`, ICHARG: `1`, ISMEAR: `0`, SIGMA: `0.05`,
  ISPIN: `2`, IBRION: `5`, NSW: `0`, POTIM: `0.015`, NFREE: `2`, LWAVE: `.FALSE.`,
  LCHARG: `.TRUE.`, LORBIT: `11`, NWRITE: `3`, IVDW: `12`, NPAR: `1`,
}
const REF_INCAR_DOS: Record<string, string> = {
  PREC: `Accurate`, ENCUT: `450.0`, GGA: `Pe`, ALGO: `Fast`, LREAL: `Auto`, ISYM: `-1`,
  EDIFF: `1e-05`, NELM: `150`, NELMIN: `6`, ICHARG: `1`, ISMEAR: `-5`, SIGMA: `0.05`,
  ISPIN: `2`, IBRION: `-1`, NSW: `0`, LWAVE: `.FALSE.`, LCHARG: `.TRUE.`, LORBIT: `11`,
  NEDOS: `3001`, IVDW: `12`, NCORE: `24`,
}
const REF_INCAR_BADER: Record<string, string> = {
  PREC: `Accurate`, ENCUT: `450.0`, GGA: `Pe`, ALGO: `Fast`, LREAL: `Auto`, ISYM: `-1`,
  EDIFF: `1e-05`, NELM: `150`, NELMIN: `6`, ICHARG: `1`, ISMEAR: `0`, SIGMA: `0.05`,
  ISPIN: `2`, IBRION: `-1`, NSW: `0`, LWAVE: `.FALSE.`, LCHARG: `.TRUE.`, LORBIT: `11`,
  LAECHG: `.TRUE.`, IVDW: `12`, NCORE: `24`,
}
const REF_KPOINTS = `pymatgen with grid density = 10770 / number of atoms\n0\nGamma\n11 11 11\n`

// Parse a generated INCAR string into a trimmed key->value map (drops comments/blanks).
function parse_incar(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(`\n`)) {
    if (!line.trim() || line.trim().startsWith(`#`)) continue
    const idx = line.indexOf(` = `)
    if (idx < 0) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 3).trim()
  }
  return out
}

describe(`py_float (Python str(float) parity)`, () => {
  it(`keeps .0 on integer floats`, () => {
    expect(py_float(450.0)).toBe(`450.0`)
    expect(py_float(1000.0)).toBe(`1000.0`)
  })
  it(`uses scientific notation for tiny values`, () => {
    expect(py_float(1e-5)).toBe(`1e-05`)
    expect(py_float(1e-6)).toBe(`1e-06`)
    expect(py_float(1e-7)).toBe(`1e-07`)
  })
  it(`keeps decimal otherwise`, () => {
    expect(py_float(1e-4)).toBe(`0.0001`)
    expect(py_float(0.05)).toBe(`0.05`)
    expect(py_float(-0.05)).toBe(`-0.05`)
  })
})

describe(`INCAR semantic equivalence vs pymatgen`, () => {
  it(`opt (relax) matches the server`, () => {
    expect(parse_incar(generate_incar_str({ calculation_type: `opt` }))).toEqual(REF_INCAR_OPT)
  })
  it(`scf (static) matches the server`, () => {
    expect(parse_incar(generate_incar_str({ calculation_type: `scf` }))).toEqual(REF_INCAR_SCF)
  })
  it(`freq matches the server`, () => {
    expect(parse_incar(generate_incar_str({ calculation_type: `freq` }))).toEqual(REF_INCAR_FREQ)
  })
  it(`dos matches the server`, () => {
    expect(parse_incar(generate_incar_str({ calculation_type: `dos` }))).toEqual(REF_INCAR_DOS)
  })
  it(`bader matches the server`, () => {
    expect(parse_incar(generate_incar_str({ calculation_type: `bader` }))).toEqual(REF_INCAR_BADER)
  })
  it(`capitalizes string values like pymatgen Incar (PE -> Pe)`, () => {
    const p = build_incar_params({ calculation_type: `scf`, gga: `PE` })
    expect(format_incar(p)).toContain(`GGA                  = Pe`)
  })
})

describe(`KPOINTS byte-exact vs pymatgen`, () => {
  it(`automatic_density_by_vol(NaCl, 1000) is Gamma 11x11x11`, () => {
    // NaCl is FCC, but the 11-divisions odd mesh already forces Gamma.
    expect(automatic_density_by_vol(NACL_MATRIX, NACL_NATOMS, 1000, { isFaceCentered: true })).toBe(REF_KPOINTS)
  })
  it(`high-level generate_kpoints_str on a structure matches`, () => {
    const structure = {
      lattice: { matrix: NACL_MATRIX },
      sites: Array.from({ length: NACL_NATOMS }, () => ({ species: [{ element: `Na` }], xyz: [0, 0, 0] })),
    } as never
    expect(generate_kpoints_str(structure, { calculation_type: `scf` }, { isFaceCentered: true })).toBe(REF_KPOINTS)
  })
  it(`KSPACING uses true VASP semantics N_i = ceil(|b_i| / kspacing)`, () => {
    const structure = {
      lattice: { matrix: NACL_MATRIX },
      sites: Array.from({ length: NACL_NATOMS }, () => ({ species: [{ element: `Na` }] })),
    } as never
    // NaCl |b_i| = 1.1042 1/Ang: 0.5 -> ceil(2.21)=3, 0.3 -> ceil(3.68)=4 (Gamma-centered)
    expect(generate_kpoints_str(structure, { calculation_type: `scf`, kspacing: 0.5 }))
      .toBe(`Automatic kpoint scheme\n0\nGamma\n3 3 3\n`)
    expect(generate_kpoints_str(structure, { calculation_type: `scf`, kspacing: 0.3 }))
      .toBe(`Automatic kpoint scheme\n0\nGamma\n4 4 4\n`)
  })
})

// Edge-case guards (found via multi-CIF stress testing): degenerate inputs must
// still yield a valid mesh (every division a positive integer), never NaN /
// Infinity / 0 / negative.
describe(`KPOINTS edge-case guards`, () => {
  const GM = [[5, 0, 0], [0, 5, 0], [0, 0, 5]]
  const struct = (n: number) => ({
    lattice: { matrix: GM },
    sites: Array.from({ length: n }, () => ({ species: [{ element: `Si` }] })),
  } as never)
  const mesh_of = (s: string) => s.split(`\n`)[3].split(/\s+/).map(Number)
  const valid = (s: string) => { const m = mesh_of(s); return m.length === 3 && m.every((x) => Number.isInteger(x) && x >= 1) }

  it(`empty structure (natoms=0) yields a valid mesh, not NaN`, () => {
    expect(valid(generate_kpoints_str(struct(0), { calculation_type: `scf` }))).toBe(true)
  })
  it(`non-positive kspacing falls back to a valid mesh`, () => {
    expect(valid(generate_kpoints_str(struct(2), { calculation_type: `scf`, kspacing: 0 }))).toBe(true)
    expect(valid(generate_kpoints_str(struct(2), { calculation_type: `scf`, kspacing: -0.3 }))).toBe(true)
  })
  it(`zero / NaN kmesh components clamp to >= 1`, () => {
    expect(generate_kpoints_str(struct(2), { calculation_type: `scf`, kmesh: [0, 0, 0] })).toContain(`\n1 1 1\n`)
    expect(valid(generate_kpoints_str(struct(2), { calculation_type: `scf`, kmesh: [NaN, 2, 2] }))).toBe(true)
  })
})

import { gen_abacus_input } from '$lib/structure/export/abacus-export'
import type { AbacusParams } from '$lib/structure/export/abacus-export'
import type { FixAtomParams } from '$lib/structure/export/common-export'
import { describe, expect, it } from 'vitest'

// Contract / smoke tests for the client-side ABACUS generator. gen_abacus_input is
// fully client-side and returns a Record<string, string> with keys INPUT, STRU, KPT.
// These tests guard that every calculation type still produces all three well-formed
// files and exercise the main branches (pw vs lcao, relax/cell-relax extras, md block).

const A = 4.065 // fcc Al lattice constant (Å)
const M = [[A, 0, 0], [0, A, 0], [0, 0, A]]
function nacl_cubic() {
  const frac = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0], [0.5, 0.5, 0.5], [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5]]
  const el = [`Na`, `Na`, `Na`, `Na`, `Cl`, `Cl`, `Cl`, `Cl`]
  return {
    lattice: { matrix: M },
    sites: frac.map((f, i) => ({
      species: [{ element: el[i] }],
      abc: f,
      xyz: [0, 1, 2].map((c) => f[0] * M[0][c] + f[1] * M[1][c] + f[2] * M[2][c]),
    })),
  }
}

const BASE: AbacusParams = {
  prefix: `nacl`,
  calculation: `scf`,
  basis_type: `pw`,
  ecutwfc: 100,
  kpoints_auto: true,
  kpoints: [4, 4, 4],
  kspacing: 0.1,
  scf_nmax: 100,
  scf_thr: 1e-7,
  smearing_method: `gauss`,
  smearing_sigma: 0.015,
  nspin: 1,
  dft_functional: `PBE`,
  mixing_type: `pulay`,
  mixing_beta: 0.4,
  force_thr: 1e-3,
  stress_thr: 0.5,
  relax_nmax: 50,
  symmetry: 1,
  cal_force: true,
  cal_stress: true,
  out_chg: false,
  out_band: false,
  pseudo_dir: `./`,
  orbital_dir: `./`,
  pseudopotentials: {},
  orbitals: {},
  md_type: `nvt`,
  md_nstep: 1000,
  md_dt: 1.0,
  md_temp: 300,
  unique_elements: [`Na`, `Cl`],
}

const FIX: FixAtomParams = {
  fix_mode: `none`,
  fix_z_threshold: 5,
  selected_indices: [],
  constrained_atoms_info: { count: 0, details: [] },
}

const gen = (over: Partial<AbacusParams>) =>
  gen_abacus_input(nacl_cubic() as never, { ...BASE, ...over }, FIX as never)

describe(`gen_abacus_input produces three well-formed ABACUS files`, () => {
  it(`returns INPUT, STRU, and KPT keys`, () => {
    const files = gen({})
    expect(Object.keys(files).sort()).toEqual([`INPUT`, `KPT`, `STRU`])
  })

  const CALC_TYPES: AbacusParams[`calculation`][] = [`scf`, `relax`, `cell-relax`, `nscf`, `md`]
  for (const calc of CALC_TYPES) {
    it(`${calc} → INPUT contains required keys`, () => {
      const { INPUT } = gen({ calculation: calc })
      expect(INPUT).toContain(`calculation`)
      expect(INPUT).toContain(`ecutwfc`)
      expect(INPUT).toContain(`basis_type`)
      expect(INPUT).toContain(`scf_thr`)
      expect(INPUT).toContain(`scf_nmax`)
      expect(INPUT).toContain(calc)
    })
  }

  it(`scf INPUT contains scalar fields`, () => {
    const { INPUT } = gen({ calculation: `scf` })
    expect(INPUT).toContain(`INPUT_PARAMETERS`)
    expect(INPUT).toContain(`ntype`)
    expect(INPUT).toContain(`smearing_method`)
    expect(INPUT).toContain(`mixing_type`)
    expect(INPUT).toContain(`nspin`)
    expect(INPUT).toContain(`dft_functional`)
    expect(INPUT).toContain(`pseudo_dir`)
  })

  it(`relax INPUT emits relax_nmax and force_thr`, () => {
    const { INPUT } = gen({ calculation: `relax` })
    expect(INPUT).toContain(`relax_nmax`)
    expect(INPUT).toContain(`force_thr`)
    expect(INPUT).not.toContain(`stress_thr`)
  })

  it(`cell-relax INPUT emits relax_nmax, force_thr, and stress_thr`, () => {
    const { INPUT } = gen({ calculation: `cell-relax` })
    expect(INPUT).toContain(`relax_nmax`)
    expect(INPUT).toContain(`force_thr`)
    expect(INPUT).toContain(`stress_thr`)
  })

  it(`md INPUT emits md block`, () => {
    const { INPUT } = gen({ calculation: `md`, md_type: `nvt`, md_nstep: 500, md_dt: 2.0, md_temp: 400 })
    expect(INPUT).toContain(`md_type`)
    expect(INPUT).toContain(`md_nstep`)
    expect(INPUT).toContain(`md_dt`)
    expect(INPUT).toContain(`md_tfirst`)
    expect(INPUT).toContain(`md_tlast`)
    // nvt maps to nhc in ABACUS
    expect(INPUT).toContain(`nhc`)
  })

  it(`STRU contains ATOMIC_SPECIES block with both elements`, () => {
    const { STRU } = gen({})
    expect(STRU).toContain(`ATOMIC_SPECIES`)
    expect(STRU).toContain(`Na`)
    expect(STRU).toContain(`Cl`)
  })

  it(`STRU contains LATTICE_CONSTANT and LATTICE_VECTORS`, () => {
    const { STRU } = gen({})
    expect(STRU).toContain(`LATTICE_CONSTANT`)
    expect(STRU).toContain(`LATTICE_VECTORS`)
  })

  it(`STRU contains ATOMIC_POSITIONS in Direct mode`, () => {
    const { STRU } = gen({})
    expect(STRU).toContain(`ATOMIC_POSITIONS`)
    expect(STRU).toContain(`Direct`)
  })

  it(`STRU LATTICE_VECTORS are in Bohr (scaled from Å)`, () => {
    const { STRU } = gen({})
    // A=4.065 Å × 1.8897259886 ≈ 7.686…
    expect(STRU).toContain(`7.6`)
  })

  it(`KPT contains K_POINTS header and a grid line`, () => {
    const { KPT } = gen({})
    expect(KPT).toContain(`K_POINTS`)
    expect(KPT).toContain(`Gamma`)
    // kpoints_auto=true → 4 4 4
    expect(KPT).toContain(`4 4 4`)
  })

  it(`kpoints_auto=false uses explicit kpoints and emits kspacing in INPUT`, () => {
    const { INPUT, KPT } = gen({ kpoints_auto: false, kpoints: [2, 3, 5], kspacing: 0.2 })
    expect(INPUT).toContain(`kspacing`)
    expect(KPT).toContain(`2 3 5`)
  })

  it(`lcao basis_type emits orbital_dir in INPUT and NUMERICAL_ORBITAL in STRU`, () => {
    const { INPUT, STRU } = gen({ basis_type: `lcao` })
    expect(INPUT).toContain(`orbital_dir`)
    expect(STRU).toContain(`NUMERICAL_ORBITAL`)
  })

  it(`pw basis_type does NOT emit orbital_dir or NUMERICAL_ORBITAL`, () => {
    const { INPUT, STRU } = gen({ basis_type: `pw` })
    expect(INPUT).not.toContain(`orbital_dir`)
    expect(STRU).not.toContain(`NUMERICAL_ORBITAL`)
  })

  it(`out_chg=true emits out_chg in INPUT`, () => {
    expect(gen({ out_chg: true }).INPUT).toContain(`out_chg`)
    expect(gen({ out_chg: false }).INPUT).not.toContain(`out_chg`)
  })

  it(`out_band=true emits out_band in INPUT`, () => {
    expect(gen({ out_band: true }).INPUT).toContain(`out_band`)
    expect(gen({ out_band: false }).INPUT).not.toContain(`out_band`)
  })

  it(`custom pseudopotentials appear in STRU ATOMIC_SPECIES block`, () => {
    const { STRU } = gen({ pseudopotentials: { Na: `Na_custom.upf`, Cl: `Cl_custom.upf` } })
    expect(STRU).toContain(`Na_custom.upf`)
    expect(STRU).toContain(`Cl_custom.upf`)
  })

  it(`default pseudopotentials fall back to ONCV_PBE naming`, () => {
    const { STRU } = gen({ pseudopotentials: {} })
    expect(STRU).toContain(`Na_ONCV_PBE-1.0.upf`)
    expect(STRU).toContain(`Cl_ONCV_PBE-1.0.upf`)
  })

  it(`returns empty object when structure is falsy`, () => {
    const files = gen_abacus_input(null as never, BASE, FIX)
    expect(files).toEqual({})
  })
})

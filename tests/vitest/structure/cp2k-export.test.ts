import { CP2K_VALENCE, gen_cp2k_local } from '$lib/structure/export/cp2k-export'
import type { CP2KParams } from '$lib/structure/export/cp2k-export'
import { describe, expect, it } from 'vitest'

// Contract / smoke tests for the client-side CP2K generator. gen_cp2k_local is an
// independent implementation that produces valid CP2K (it does NOT byte-match the
// server generate_cp2k_input — formatting and some defaults differ). These tests
// guard that every run type still produces a well-formed input and exercise the
// main branches, so the offline export path can be relied on.

const A = 5.6903014761756712
const M = [[A, 0, 0], [0, A, 0], [0, 0, A]]
function nacl() {
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

const BASE: CP2KParams = {
  prefix: `structure`, run_type: `geo_opt`, functional: `PBE`, basis_set: `DZVP-MOLOPT-SR-GTH`,
  cutoff: 400, rel_cutoff: 50, scf_method: `OT`, scf_eps: 1e-5, max_scf: 300,
  ot_precond: `FULL_KINETIC`, ot_minimizer: `DIIS`, outer_scf: true, outer_max_scf: 20, outer_eps: 1e-5,
  smearing: false, smearing_method: `FERMI_DIRAC`, electronic_temperature: 300, added_mos: 50,
  vdw: `DFTD3(BJ)`, periodic: `XYZ`, charge: 0, multiplicity: 1, uks: false,
  kpoints_enabled: false, kpoints_nx: 1, kpoints_ny: 1, kpoints_nz: 1,
  dftpu_enabled: false, dftpu_settings: {}, fix_elements: [], fix_indices_str: ``,
  cell_rep_x: 1, cell_rep_y: 1, cell_rep_z: 1, fine_grid_xc: false,
  print_level: `LOW`, print_moments: false, print_orbital_energies: false,
  output_overlap_csr: false, output_ks_csr: false, epr_hyperfine: false,
  efield_enabled: false, efield_x: 0, efield_y: 0, efield_z: 0, magnetization: {},
  center_coords: false, coord_from_file: false, coord_file_name: ``,
  geo_optimizer: `BFGS`, geo_max_force: 4.5e-4, geo_max_iter: 200,
  cell_opt_max_iter: 100, cell_opt_pressure: 0,
  md_ensemble: `NVT`, md_steps: 1000, md_timestep: 0.5, md_temperature: 300, md_thermostat: `CSVR`, md_timecon: 100,
  cdft_enabled: false, lrigpw: false, ls_scf: false, poisson_solver: `PERIODIC`, surf_dipole: `NONE`,
  unique_elements: [`Na`, `Cl`],
}
const FIX = { fix_mode: `none` as const, fix_z_threshold: 5, selected_indices: [] as number[], constrained_atoms_info: { count: 0, details: [] } }

const gen = (over: Partial<CP2KParams>) => gen_cp2k_local(nacl() as never, { ...BASE, ...over }, FIX as never)

describe(`gen_cp2k_local produces valid CP2K`, () => {
  const RUN_TYPES: Array<[CP2KParams[`run_type`], string]> = [
    [`energy`, `ENERGY`], [`energy_force`, `ENERGY_FORCE`], [`geo_opt`, `GEO_OPT`],
    [`cell_opt`, `CELL_OPT`], [`md`, `MD`], [`vibrational_analysis`, `VIBRATIONAL_ANALYSIS`],
    [`linear_response`, `LINEAR_RESPONSE`],
  ]
  for (const [rt, label] of RUN_TYPES) {
    it(`${rt} → well-formed input`, () => {
      const inp = gen({ run_type: rt })
      expect(inp).toContain(`&GLOBAL`)
      expect(inp).toContain(`&END GLOBAL`)
      expect(inp).toContain(`&FORCE_EVAL`)
      expect(inp).toContain(`&END FORCE_EVAL`)
      expect(inp).toContain(`&SUBSYS`)
      expect(inp).toContain(`&KIND Na`)
      expect(inp).toContain(`&KIND Cl`)
      expect(inp).toContain(`RUN_TYPE ${label}`)
      // every opened section (&X, excluding &END) is closed (&END X)
      const opens = (inp.match(/^\s*&(?!END\b)/gm) || []).length
      const ends = (inp.match(/^\s*&END\b/gm) || []).length
      expect(opens).toBe(ends)
    })
  }

  it(`OT path emits &OT and &OUTER_SCF`, () => {
    const inp = gen({ scf_method: `OT` })
    expect(inp).toContain(`&OT`)
    expect(inp).toContain(`&OUTER_SCF`)
  })
  it(`DIAG + smearing emits &SMEAR`, () => {
    const inp = gen({ scf_method: `DIAG`, smearing: true })
    expect(inp).toContain(`&SMEAR`)
    expect(inp).toContain(`METHOD FERMI_DIRAC`)
  })
  it(`PBE0 emits &HF with FRACTION`, () => {
    const inp = gen({ functional: `PBE0` })
    expect(inp).toContain(`&HF`)
    expect(inp).toContain(`FRACTION 0.25`)
  })
  it(`vdW DFTD3(BJ) emits &VDW_POTENTIAL; none omits it`, () => {
    expect(gen({ vdw: `DFTD3(BJ)` })).toContain(`&VDW_POTENTIAL`)
    expect(gen({ vdw: `none` })).not.toContain(`&VDW_POTENTIAL`)
  })
  it(`MD run emits &MOTION/&MD with the ensemble`, () => {
    const inp = gen({ run_type: `md`, md_ensemble: `NVT` })
    expect(inp).toContain(`&MD`)
    expect(inp).toContain(`ENSEMBLE NVT`)
  })
  it(`KIND potentials use the GTH valence (Na q9, Cl q7)`, () => {
    expect(CP2K_VALENCE.Na).toBe(9)
    expect(CP2K_VALENCE.Cl).toBe(7)
    const inp = gen({ run_type: `energy` })
    expect(inp).toContain(`GTH-PBE-q9`)
    expect(inp).toContain(`GTH-PBE-q7`)
  })
})

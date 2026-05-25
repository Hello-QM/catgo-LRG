import { gen_lammps_local } from '$lib/structure/export/lammps-export'
import type { LammpsLocalParams } from '$lib/structure/export/lammps-export'
import { describe, expect, it } from 'vitest'

// Contract / smoke tests for the client-side LAMMPS generator. gen_lammps_local is an
// independent implementation that produces valid LAMMPS data + input files (it does NOT
// byte-match the server generate_lammps_input — formatting and some defaults differ).
// These tests guard that every simulation_type still produces well-formed output and
// exercise the main branches so the offline export path can be relied on.

const A = 4.05
const M = [[A, 0, 0], [0, A, 0], [0, 0, A]]
function fcc_al() {
  const frac = [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]]
  return {
    lattice: { matrix: M },
    sites: frac.map((f) => ({
      species: [{ element: `Al` }],
      abc: f,
      xyz: [0, 1, 2].map((c) => f[0] * M[0][c] + f[1] * M[1][c] + f[2] * M[2][c]),
    })),
  }
}

const BASE: LammpsLocalParams = {
  prefix: `structure`,
  units: `metal`,
  atom_style: `atomic`,
  boundary: `p p p`,
  simulation_type: `minimize`,
  pair_style: `eam/alloy`,
  pair_coeff: ``,
  min_style: `cg`,
  etol: 1e-8,
  ftol: 1e-8,
  maxiter: 10000,
  timestep: 0.001,
  temperature: 300,
  pressure: 0,
  run_steps: 10000,
  tdamp: 0.1,
  pdamp: 1.0,
  thermo_freq: 100,
  dump_freq: 1000,
  unique_elements: [`Al`],
}
const FIX = { fix_mode: `none` as const, fix_z_threshold: 5, selected_indices: [] as number[], constrained_atoms_info: { count: 0, details: [] } }

const gen = (over: Partial<LammpsLocalParams>) =>
  gen_lammps_local(fcc_al() as never, { ...BASE, ...over }, FIX as never)

describe(`gen_lammps_local produces valid LAMMPS`, () => {
  const SIM_TYPES: Array<LammpsLocalParams[`simulation_type`]> = [`minimize`, `nve`, `nvt`, `npt`]

  for (const sim of SIM_TYPES) {
    it(`${sim} → well-formed data file and input script`, () => {
      const { data, input } = gen({ simulation_type: sim })

      // data file checks
      expect(data).toBeTruthy()
      expect(data).toContain(`atoms`)
      expect(data).toContain(`atom types`)
      expect(data).toContain(`xlo xhi`)
      expect(data).toContain(`ylo yhi`)
      expect(data).toContain(`zlo zhi`)
      expect(data).toContain(`Masses`)
      expect(data).toContain(`Atoms`)

      // input script checks
      expect(input).toBeTruthy()
      expect(input).toContain(`units metal`)
      expect(input).toContain(`atom_style atomic`)
      expect(input).toContain(`boundary p p p`)
      expect(input).toContain(`read_data`)
      expect(input).toContain(`pair_style eam/alloy`)
      expect(input).toContain(`thermo`)
    })
  }

  it(`minimize → emits min_style and minimize command, no run`, () => {
    const { input } = gen({ simulation_type: `minimize` })
    expect(input).toContain(`min_style cg`)
    expect(input).toContain(`minimize`)
    expect(input).not.toContain(`run `)
  })

  it(`nve → emits run, no velocity create, no thermostat fix`, () => {
    const { input } = gen({ simulation_type: `nve` })
    expect(input).toContain(`run `)
    expect(input).toContain(`fix 1 all nve`)
    expect(input).not.toContain(`velocity all create`)
  })

  it(`nvt → emits velocity create, nvt thermostat fix, and run`, () => {
    const { input } = gen({ simulation_type: `nvt`, temperature: 500, tdamp: 0.1 })
    expect(input).toContain(`velocity all create 500`)
    expect(input).toContain(`nvt temp 500 500`)
    expect(input).toContain(`run `)
  })

  it(`npt → emits velocity create, npt fix with iso pressure, and run`, () => {
    const { input } = gen({ simulation_type: `npt`, temperature: 300, pressure: 1.0, tdamp: 0.1, pdamp: 1.0 })
    expect(input).toContain(`velocity all create 300`)
    expect(input).toContain(`npt temp 300 300`)
    expect(input).toContain(`iso 1`)
    expect(input).toContain(`run `)
  })

  it(`data file atom count matches structure site count`, () => {
    const { data } = gen({ simulation_type: `minimize` })
    expect(data).toContain(`4 atoms`)
  })

  it(`data file Masses section contains element with atomic weight`, () => {
    const { data } = gen({ simulation_type: `minimize` })
    expect(data).toContain(`Masses`)
    expect(data).toContain(`# Al`)
  })

  it(`data file Atoms section has correct number of atom lines`, () => {
    const { data } = gen({ simulation_type: `minimize` })
    const atoms_section = data.split(`Atoms`)[1] || ``
    // 4 sites → 4 lines with atom-id type x y z
    const atom_lines = atoms_section.trim().split(`\n`).filter((l) => l.trim().match(/^\d+\s+\d+\s+/))
    expect(atom_lines.length).toBe(4)
  })

  it(`write_data footer is emitted for every mode`, () => {
    for (const sim of SIM_TYPES) {
      const { input } = gen({ simulation_type: sim })
      expect(input).toContain(`write_data`)
    }
  })

  it(`two-element structure produces correct type mapping in data file`, () => {
    const frac = [[0, 0, 0], [0.5, 0.5, 0.5]]
    const cscl = {
      lattice: { matrix: M },
      sites: [
        { species: [{ element: `Cs` }], abc: frac[0], xyz: [0, 0, 0] },
        { species: [{ element: `Cl` }], abc: frac[1], xyz: [A / 2, A / 2, A / 2] },
      ],
    }
    const { data, input } = gen_lammps_local(
      cscl as never,
      { ...BASE, unique_elements: [`Cs`, `Cl`] },
      FIX as never,
    )
    expect(data).toContain(`2 atom types`)
    expect(data).toContain(`# Cs`)
    expect(data).toContain(`# Cl`)
    expect(input).toContain(`pair_coeff * * <POTENTIAL> Cs Cl`)
  })

  it(`pair_coeff is written verbatim when provided`, () => {
    const { input } = gen({ pair_coeff: `* * Al99.eam.alloy Al` })
    expect(input).toContain(`pair_coeff * * Al99.eam.alloy Al`)
  })

  it(`prefix appears in data header and write_data footer`, () => {
    const { data, input } = gen({ prefix: `myrun` })
    expect(data).toContain(`myrun`)
    expect(input).toContain(`myrun`)
    expect(input).toContain(`read_data myrun.data`)
    expect(input).toContain(`write_data myrun_final.data`)
  })
})

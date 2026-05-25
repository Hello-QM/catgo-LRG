import { generate_gromacs_input, apply_gmx_preset } from '$lib/structure/export/gromacs-export'
import type { GromacsParams, GromacsPreset } from '$lib/structure/export/gromacs-export'
import { describe, expect, it } from 'vitest'

// Contract / smoke tests for the client-side GROMACS generator. generate_gromacs_input
// is fully client-side and returns a Record<string, string> of {mdp, gro, top} file
// contents. These tests guard that every sim_type/preset produces well-formed output
// so the offline export path can be relied on.

const A = 4.0
const M = [[A, 0, 0], [0, A, 0], [0, 0, A]]
function nacl_small() {
  // 2-atom NaCl unit cell (minimal periodic box)
  const frac = [[0, 0, 0], [0.5, 0.5, 0.5]]
  const el = [`Na`, `Cl`]
  return {
    lattice: { matrix: M },
    sites: frac.map((f, i) => ({
      species: [{ element: el[i] }],
      abc: f,
      xyz: [0, 1, 2].map((c) => f[0] * M[0][c] + f[1] * M[1][c] + f[2] * M[2][c]),
    })),
  }
}

// Shared base params — filled with sensible defaults; tests override per-preset as needed.
const BASE: GromacsParams = {
  prefix: `structure`,
  sim_type: `em`,
  dt: 0.002,
  nsteps: 50000,
  nsteps_display: `100 ps`,
  emtol: 1000,
  emstep: 0.01,
  tcoupl: `V-rescale`,
  ref_t: 300,
  tau_t: 0.1,
  pcoupl: `no`,
  pcoupltype: `isotropic`,
  ref_p: 1.0,
  tau_p: 2.0,
  coulombtype: `PME`,
  rcoulomb: 1.0,
  rvdw: 1.0,
  pbc: `xyz`,
  dispcorr: `EnerPres`,
  nstlog: 1000,
  nstenergy: 1000,
  nstxout_compressed: 5000,
  constraints: `none`,
  gen_vel: `no`,
  gen_temp: 300,
  posres: false,
  anneal_time: `0 100`,
  anneal_temp: `0 298.15`,
}

const gen = (over: Partial<GromacsParams>) =>
  generate_gromacs_input(nacl_small() as never, { ...BASE, ...over })

describe(`generate_gromacs_input produces well-formed output`, () => {
  it(`returns mdp, gro, and top files`, () => {
    const out = gen({})
    expect(Object.keys(out)).toContain(`structure.mdp`)
    expect(Object.keys(out)).toContain(`structure.gro`)
    expect(Object.keys(out)).toContain(`structure.top`)
  })

  it(`custom prefix is reflected in returned file names`, () => {
    const out = gen({ prefix: `my_run` })
    expect(Object.keys(out)).toContain(`my_run.mdp`)
    expect(Object.keys(out)).toContain(`my_run.gro`)
    expect(Object.keys(out)).toContain(`my_run.top`)
  })

  describe(`energy minimisation (em)`, () => {
    it(`uses steep integrator`, () => {
      const { [`structure.mdp`]: mdp } = gen({ sim_type: `em` })
      expect(mdp).toContain(`integrator  = steep`)
    })
    it(`emits emtol and emstep`, () => {
      const { [`structure.mdp`]: mdp } = gen({ sim_type: `em`, emtol: 500, emstep: 0.005 })
      expect(mdp).toContain(`emtol       = 500`)
      expect(mdp).toContain(`emstep      = 0.005`)
    })
    it(`emits nsteps`, () => {
      const { [`structure.mdp`]: mdp } = gen({ sim_type: `em`, nsteps: 20000 })
      expect(mdp).toContain(`nsteps      = 20000`)
    })
    it(`does NOT emit tcoupl section`, () => {
      const { [`structure.mdp`]: mdp } = gen({ sim_type: `em` })
      expect(mdp).not.toContain(`Temperature coupling`)
    })
  })

  describe(`NVT equilibration (eq_nvt)`, () => {
    const nvt_params = apply_gmx_preset(`eq_nvt`)
    it(`uses md integrator`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...nvt_params })
      expect(mdp).toContain(`integrator  = md`)
    })
    it(`emits dt and nsteps`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...nvt_params })
      expect(mdp).toContain(`dt          = 0.002`)
      expect(mdp).toContain(`nsteps      = 50000`)
    })
    it(`emits tcoupl section`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...nvt_params })
      expect(mdp).toContain(`tcoupl  = V-rescale`)
      expect(mdp).toContain(`ref_t   = 300`)
      expect(mdp).toContain(`tau_t   = 0.1`)
    })
    it(`pcoupl is no (no pressure section)`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...nvt_params })
      expect(mdp).not.toContain(`Pressure coupling`)
    })
    it(`emits velocity generation`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...nvt_params })
      expect(mdp).toContain(`gen_vel  = yes`)
      expect(mdp).toContain(`gen_temp = 300`)
    })
    it(`emits POSRES define when posres=true`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...nvt_params, posres: true })
      expect(mdp).toContain(`define = -DPOSRES`)
    })
  })

  describe(`NPT equilibration (eq_npt)`, () => {
    const npt_params = apply_gmx_preset(`eq_npt`)
    it(`emits tcoupl`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...npt_params })
      expect(mdp).toContain(`tcoupl  = V-rescale`)
    })
    it(`emits pcoupl section`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...npt_params })
      expect(mdp).toContain(`pcoupl      = parrinello-rahman`)
      expect(mdp).toContain(`pcoupltype  = isotropic`)
      expect(mdp).toContain(`ref_p       = 1`)
      expect(mdp).toContain(`tau_p       = 2`)
      expect(mdp).toContain(`compressibility = 4.5e-5`)
    })
    it(`gen_vel is no`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...npt_params })
      expect(mdp).not.toContain(`gen_vel  = yes`)
    })
  })

  describe(`production NPT (prod_npt)`, () => {
    const prod_params = apply_gmx_preset(`prod_npt`)
    it(`runs long nsteps`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...prod_params })
      expect(mdp).toContain(`nsteps      = 1000000`)
    })
    it(`emits pcoupl`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...prod_params })
      expect(mdp).toContain(`pcoupl      = parrinello-rahman`)
    })
    it(`no POSRES when posres=false`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...prod_params, posres: false })
      expect(mdp).not.toContain(`-DPOSRES`)
    })
  })

  describe(`simulated annealing / heat_npt`, () => {
    const heat_params = apply_gmx_preset(`heat_npt`)
    it(`emits annealing section`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...heat_params })
      expect(mdp).toContain(`annealing       = single`)
      expect(mdp).toContain(`annealing-time  = 0 100`)
      expect(mdp).toContain(`annealing-temp  = 0 298.15`)
    })
    it(`annealing-npoints matches token count in anneal_time`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...heat_params, anneal_time: `0 50 100`, anneal_temp: `0 150 298` })
      expect(mdp).toContain(`annealing-npoints = 3`)
    })
    it(`emits velocity generation from 0 K`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...heat_params })
      expect(mdp).toContain(`gen_vel  = yes`)
      expect(mdp).toContain(`gen_temp = 0`)
    })
  })

  describe(`gas phase`, () => {
    const gas_params = apply_gmx_preset(`gas_phase`)
    it(`pbc = no`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...gas_params })
      expect(mdp).toContain(`pbc         = no`)
    })
    it(`coulombtype = Cut-off`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...gas_params })
      expect(mdp).toContain(`coulombtype = Cut-off`)
    })
    it(`constraints = none (omits constraints section)`, () => {
      const { [`structure.mdp`]: mdp } = gen({ ...gas_params })
      expect(mdp).not.toContain(`constraint-algorithm`)
    })
  })

  describe(`.gro coordinate file`, () => {
    it(`header contains atom count`, () => {
      const { [`structure.gro`]: gro } = gen({})
      const lines = gro.split(`\n`)
      expect(lines[1].trim()).toBe(`2`)
    })
    it(`atom lines contain element symbols`, () => {
      const { [`structure.gro`]: gro } = gen({})
      expect(gro).toContain(`Na`)
      expect(gro).toContain(`Cl`)
    })
    it(`box vectors line present at end (nm conversion)`, () => {
      const { [`structure.gro`]: gro } = gen({})
      // Box in nm: A=4.0 Å → 0.40000 nm
      expect(gro).toContain(`0.40000`)
    })
  })

  describe(`.top topology file`, () => {
    it(`contains [ defaults ] section`, () => {
      const { [`structure.top`]: top } = gen({})
      expect(top).toContain(`[ defaults ]`)
    })
    it(`contains [ atomtypes ] with Na and Cl entries`, () => {
      const { [`structure.top`]: top } = gen({})
      expect(top).toContain(`[ atomtypes ]`)
      expect(top).toContain(`Na`)
      expect(top).toContain(`Cl`)
    })
    it(`contains [ moleculetype ] and [ atoms ]`, () => {
      const { [`structure.top`]: top } = gen({})
      expect(top).toContain(`[ moleculetype ]`)
      expect(top).toContain(`[ atoms ]`)
    })
    it(`contains [ system ] and [ molecules ]`, () => {
      const { [`structure.top`]: top } = gen({})
      expect(top).toContain(`[ system ]`)
      expect(top).toContain(`[ molecules ]`)
      expect(top).toContain(`MOL       1`)
    })
    it(`system name matches prefix`, () => {
      const { [`my_sim.top`]: top } = gen({ prefix: `my_sim` })
      expect(top).toContain(`my_sim`)
    })
  })

  describe(`output control fields`, () => {
    it(`nstlog, nstenergy, nstxout-compressed appear in mdp`, () => {
      const { [`structure.mdp`]: mdp } = gen({ nstlog: 500, nstenergy: 500, nstxout_compressed: 2500 })
      expect(mdp).toContain(`nstlog              = 500`)
      expect(mdp).toContain(`nstenergy           = 500`)
      expect(mdp).toContain(`nstxout-compressed  = 2500`)
    })
    it(`electrostatics fields appear in mdp`, () => {
      const { [`structure.mdp`]: mdp } = gen({ coulombtype: `PME`, rcoulomb: 1.2, rvdw: 1.2 })
      expect(mdp).toContain(`coulombtype = PME`)
      expect(mdp).toContain(`rcoulomb    = 1.2`)
      expect(mdp).toContain(`rvdw        = 1.2`)
    })
  })

  describe(`apply_gmx_preset returns correct partial params`, () => {
    const PRESETS: GromacsPreset[] = [`em`, `eq_nvt`, `eq_npt`, `prod_npt`, `heat_npt`, `gas_phase`]
    for (const preset of PRESETS) {
      it(`${preset} → has sim_type`, () => {
        const p = apply_gmx_preset(preset)
        expect(p.sim_type).toBe(preset)
      })
    }
    it(`em preset sets emtol = 1000`, () => {
      expect(apply_gmx_preset(`em`).emtol).toBe(1000)
    })
    it(`eq_nvt preset sets posres = true`, () => {
      expect(apply_gmx_preset(`eq_nvt`).posres).toBe(true)
    })
    it(`prod_npt preset sets posres = false`, () => {
      expect(apply_gmx_preset(`prod_npt`).posres).toBe(false)
    })
  })
})

import { gen_qe_local, gen_dos_input } from '$lib/structure/export/qe-export'
import type { QEParams, QEDosParams } from '$lib/structure/export/qe-export'
import { ATOMIC_WEIGHTS_SMALL } from '$lib/structure/export/common-export'
import { describe, expect, it } from 'vitest'

// Contract / smoke tests for the client-side QE generator. gen_qe_local is an
// independent implementation that produces valid Quantum ESPRESSO input (it does
// NOT byte-match the server generate_qe_input — formatting and some defaults
// differ). These tests guard that every calculation type still produces a
// well-formed input and exercise the main branches, so the offline export path
// can be relied on.

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

const BASE: QEParams = {
  calculation: `scf`,
  prefix: `structure`,
  ecutwfc: 60,
  ecutrho: 480,
  kpoints_auto: false,
  kpoints: [4, 4, 4],
  kspacing: 0.04,
  degauss: 0.01,
  conv_thr: 1e-8,
  forc_conv_thr: 1e-4,
  press: 0,
  coord_type: `crystal`,
  pseudo_dir: `./`,
  pseudopotentials: { Na: `Na.upf`, Cl: `Cl.upf` },
  disk_io: `low`,
  wf_collect: false,
  tprnfor: true,
  tstress: true,
  unique_elements: [`Na`, `Cl`],
}

const FIX = { fix_mode: `none` as const, fix_z_threshold: 5, selected_indices: [] as number[], constrained_atoms_info: { count: 0, details: [] } }

const gen = (over: Partial<QEParams>) => gen_qe_local(nacl() as never, { ...BASE, ...over }, FIX as never)

describe(`gen_qe_local produces valid Quantum ESPRESSO input`, () => {
  const CALC_MODES: Array<[QEParams[`calculation`], string]> = [
    [`scf`, `scf`],
    [`relax`, `relax`],
    [`vc-relax`, `vc-relax`],
    [`nscf`, `nscf`],
    [`bands`, `bands`],
  ]

  for (const [mode, label] of CALC_MODES) {
    it(`${mode} → well-formed input with mandatory namelists`, () => {
      const inp = gen({ calculation: mode })
      // Core namelists always present
      expect(inp).toContain(`&CONTROL`)
      expect(inp).toContain(`&SYSTEM`)
      expect(inp).toContain(`&ELECTRONS`)
      // calculation keyword matches the mode
      expect(inp).toContain(`calculation = '${label}'`)
      // mandatory cards
      expect(inp).toContain(`ATOMIC_SPECIES`)
      expect(inp).toContain(`ATOMIC_POSITIONS`)
      expect(inp).toContain(`K_POINTS`)
      // both elements are present in ATOMIC_SPECIES
      expect(inp).toContain(`Na `)
      expect(inp).toContain(`Cl `)
    })
  }

  it(`scf does NOT emit &IONS or &CELL`, () => {
    const inp = gen({ calculation: `scf` })
    expect(inp).not.toContain(`&IONS`)
    expect(inp).not.toContain(`&CELL`)
  })

  it(`relax emits &IONS but NOT &CELL`, () => {
    const inp = gen({ calculation: `relax` })
    expect(inp).toContain(`&IONS`)
    expect(inp).toContain(`ion_dynamics`)
    expect(inp).not.toContain(`&CELL`)
  })

  it(`vc-relax emits both &IONS and &CELL`, () => {
    const inp = gen({ calculation: `vc-relax` })
    expect(inp).toContain(`&IONS`)
    expect(inp).toContain(`&CELL`)
    expect(inp).toContain(`cell_dynamics`)
  })

  it(`relax and vc-relax include forc_conv_thr`, () => {
    expect(gen({ calculation: `relax` })).toContain(`forc_conv_thr`)
    expect(gen({ calculation: `vc-relax` })).toContain(`forc_conv_thr`)
    expect(gen({ calculation: `scf` })).not.toContain(`forc_conv_thr`)
  })

  it(`CELL_PARAMETERS block is emitted for a periodic structure`, () => {
    const inp = gen({ calculation: `scf` })
    expect(inp).toContain(`CELL_PARAMETERS`)
    // lattice vector entries — a in angstrom
    expect(inp).toContain(`5.6903014762`)
  })

  it(`crystal coord_type emits fractional positions`, () => {
    const inp = gen({ calculation: `scf`, coord_type: `crystal` })
    expect(inp).toContain(`ATOMIC_POSITIONS {crystal}`)
  })

  it(`angstrom coord_type emits cartesian positions`, () => {
    const inp = gen({ calculation: `scf`, coord_type: `angstrom` })
    expect(inp).toContain(`ATOMIC_POSITIONS {angstrom}`)
  })

  it(`kpoints_auto uses 4 4 4 grid regardless of kpoints setting`, () => {
    const inp = gen({ kpoints_auto: true, kpoints: [1, 1, 1] })
    expect(inp).toContain(`K_POINTS automatic`)
    expect(inp).toContain(`4 4 4`)
  })

  it(`kpoints_auto false uses the provided kpoints`, () => {
    const inp = gen({ kpoints_auto: false, kpoints: [6, 6, 6] })
    expect(inp).toContain(`K_POINTS automatic`)
    expect(inp).toContain(`6 6 6`)
  })

  it(`wf_collect=true emits wf_collect = .true.`, () => {
    expect(gen({ wf_collect: true })).toContain(`wf_collect = .true.`)
    expect(gen({ wf_collect: false })).not.toContain(`wf_collect`)
  })

  it(`tprnfor and tstress flags are written`, () => {
    const inp = gen({ tprnfor: true, tstress: false })
    expect(inp).toContain(`tprnfor = .true.`)
    expect(inp).toContain(`tstress = .false.`)
  })

  it(`pseudopotentials appear in ATOMIC_SPECIES block`, () => {
    const inp = gen({ pseudopotentials: { Na: `Na_ONCV.upf`, Cl: `Cl_ONCV.upf` } })
    expect(inp).toContain(`Na_ONCV.upf`)
    expect(inp).toContain(`Cl_ONCV.upf`)
  })

  it(`fallback pseudopotential placeholder used for unknown element`, () => {
    // Mg has no entry in pseudopotentials dict — generator should emit <Mg.upf>
    const inp = gen_qe_local(nacl() as never, {
      ...BASE,
      unique_elements: [`Na`, `Cl`, `Mg`],
      pseudopotentials: { Na: `Na.upf`, Cl: `Cl.upf` },
    }, FIX as never)
    expect(inp).toContain(`<Mg.upf>`)
  })

  it(`output is non-empty and contains at least 10 lines`, () => {
    const inp = gen({ calculation: `scf` })
    expect(inp.length).toBeGreaterThan(100)
    expect(inp.split(`\n`).length).toBeGreaterThan(10)
  })

  it(`nat equals number of sites, ntyp equals unique_elements.length`, () => {
    const inp = gen({ calculation: `scf` })
    expect(inp).toContain(`nat = 8`)
    expect(inp).toContain(`ntyp = 2`)
  })

  it(`ecutwfc and ecutrho are written to &SYSTEM`, () => {
    const inp = gen({ ecutwfc: 80, ecutrho: 640 })
    expect(inp).toContain(`ecutwfc = 80`)
    expect(inp).toContain(`ecutrho = 640`)
  })
})

describe(`gen_dos_input produces valid DOS namelist`, () => {
  const DOS_BASE: QEDosParams = {
    prefix: `structure`,
    emin: -10,
    emax: 10,
    deltae: 0.01,
  }

  it(`emits &DOS namelist with all required fields`, () => {
    const inp = gen_dos_input(DOS_BASE)
    expect(inp).toContain(`&DOS`)
    expect(inp).toContain(`prefix = 'structure'`)
    expect(inp).toContain(`fildos =`)
    expect(inp).toContain(`emin =`)
    expect(inp).toContain(`emax =`)
    expect(inp).toContain(`deltae =`)
    expect(inp).toContain(`/`)
  })

  it(`numeric values are reflected in output`, () => {
    const inp = gen_dos_input({ ...DOS_BASE, emin: -20, emax: 20, deltae: 0.05 })
    expect(inp).toContain(`-20`)
    expect(inp).toContain(`20`)
    expect(inp).toContain(`0.05`)
  })
})

// Regression for the ATOMIC_WEIGHTS_SMALL gap that gave QE/LAMMPS a placeholder
// mass of 1.000 for any element outside a 10-element stub (found via multi-CIF
// stress testing). The map is now backed by the full ATOMIC_MASSES table.
describe(`ATOMIC_WEIGHTS_SMALL coverage (QE/LAMMPS mass regression)`, () => {
  it(`has correct masses for less-common elements, not the 1.000 placeholder`, () => {
    const expected: Record<string, number> = {
      Li: 6.941, F: 18.998, Mg: 24.305, P: 30.974, S: 32.065, Ti: 47.867,
      Co: 58.933, Ni: 58.693, Ge: 72.630, Ru: 101.07, Zr: 91.224,
    }
    for (const [el, mass] of Object.entries(expected)) {
      expect(ATOMIC_WEIGHTS_SMALL[el], `${el} missing from ATOMIC_WEIGHTS_SMALL`).toBeDefined()
      expect(ATOMIC_WEIGHTS_SMALL[el]).toBeCloseTo(mass, 1)
    }
  })
})

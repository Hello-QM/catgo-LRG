import { generate_gaussian_input, apply_gaussian_preset } from '$lib/structure/export/gaussian-export'
import type { GaussianParams } from '$lib/structure/export/gaussian-export'
import { describe, expect, it } from 'vitest'

// Contract / smoke tests for the client-side Gaussian generator.
// Gaussian is a molecular code — no periodic lattice is needed; the generator
// only reads structure.sites (species[].element and xyz). We use a minimal
// water molecule (H2O) throughout.

function water() {
  return {
    sites: [
      { species: [{ element: `O` }], xyz: [0.0, 0.0, 0.119748] },
      { species: [{ element: `H` }], xyz: [0.0, 0.756950, -0.478993] },
      { species: [{ element: `H` }], xyz: [0.0, -0.756950, -0.478993] },
    ],
  }
}

const BASE: GaussianParams = {
  prefix: `water`,
  job_type: `opt`,
  method: `B3LYP`,
  basis: `6-31G*`,
  charge: 0,
  multiplicity: 1,
  nproc: 4,
  mem: `2GB`,
  chk: false,
  dispersion: `none`,
  solvation: `none`,
  solvent: `Water`,
  td_nstates: 10,
  pop: `none`,
  nosymm: false,
  out_wfn: `none`,
  title: `water test`,
  extra_keywords: ``,
}

const gen = (over: Partial<GaussianParams>) => {
  const files = generate_gaussian_input(water() as never, { ...BASE, ...over })
  return Object.values(files)[0]
}

describe(`generate_gaussian_input produces valid Gaussian input`, () => {
  const JOB_TYPES: Array<[GaussianParams[`job_type`], string]> = [
    [`sp`, `SP`],
    [`opt`, `Opt`],
    [`opt_freq`, `Opt Freq`],
    [`freq`, `Freq`],
    [`td`, `TD(NStates=10)`],
    [`ts`, `Opt=(CalcFC,TS,NoEigen)`],
  ]
  for (const [jt, kw] of JOB_TYPES) {
    it(`job_type=${jt} → route contains ${kw}`, () => {
      const inp = gen({ job_type: jt })
      expect(inp).toContain(`#p B3LYP/6-31G*`)
      expect(inp).toContain(kw)
    })
  }

  it(`output file is named prefix.gjf`, () => {
    const files = generate_gaussian_input(water() as never, BASE)
    expect(Object.keys(files)).toEqual([`water.gjf`])
  })

  it(`contains title, charge/multiplicity line, and atom block`, () => {
    const inp = gen({})
    expect(inp).toContain(`water test`)
    expect(inp).toContain(`0 1`)
    expect(inp).toContain(`O`)
    expect(inp).toContain(`H`)
  })

  it(`atom block has element + x y z with 8 decimal places`, () => {
    const inp = gen({})
    // each atom line: element padded then three fixed-point coords
    expect(inp).toMatch(/O\s+[\d. -]+\s+[\d. -]+\s+[\d. -]+/)
    expect(inp).toMatch(/H\s+[\d. -]+\s+[\d. -]+\s+[\d. -]+/)
    expect(inp).toContain(`0.11974800`)
    expect(inp).toContain(`0.75695000`)
  })

  it(`nproc and mem directives are present`, () => {
    const inp = gen({ nproc: 8, mem: `4GB` })
    expect(inp).toContain(`%nproc=8`)
    expect(inp).toContain(`%mem=4GB`)
  })

  it(`chk=true adds %chk line`, () => {
    expect(gen({ chk: true })).toContain(`%chk=water.chk`)
    expect(gen({ chk: false })).not.toContain(`%chk=`)
  })

  it(`dispersion keyword is appended when not none`, () => {
    const inp = gen({ dispersion: `EmpiricalDispersion=GD3BJ` })
    expect(inp).toContain(`EmpiricalDispersion=GD3BJ`)
  })

  it(`dispersion is skipped for wB97XD method`, () => {
    const inp = gen({ method: `wB97XD`, dispersion: `EmpiricalDispersion=GD3BJ` })
    expect(inp).not.toContain(`EmpiricalDispersion=GD3BJ`)
  })

  it(`solvation=scrf adds SCRF keyword with solvent`, () => {
    const inp = gen({ solvation: `scrf`, solvent: `Ethanol` })
    expect(inp).toContain(`SCRF=(SMD,Solvent=Ethanol)`)
  })

  it(`pop keyword is added when not none`, () => {
    const inp = gen({ pop: `Full` })
    expect(inp).toContain(`pop=Full`)
  })

  it(`nosymm adds nosymm keyword`, () => {
    const inp = gen({ nosymm: true })
    expect(inp).toContain(`nosymm`)
  })

  it(`out_wfn adds output keyword and wfn filename block`, () => {
    const inp = gen({ out_wfn: `wfn` })
    expect(inp).toContain(`output=wfn`)
    expect(inp).toContain(`water.wfn`)
  })

  it(`extra_keywords are appended to route`, () => {
    const inp = gen({ extra_keywords: `scf=tight` })
    expect(inp).toContain(`scf=tight`)
  })
})

describe(`apply_gaussian_preset returns correct overrides`, () => {
  it(`quick_opt → B3LYP/6-31G* Opt`, () => {
    const p = apply_gaussian_preset(`quick_opt`)
    expect(p.job_type).toBe(`opt`)
    expect(p.method).toBe(`B3LYP`)
    expect(p.basis).toBe(`6-31G*`)
    const inp = gen({ ...p })
    expect(inp).toContain(`B3LYP/6-31G*`)
    expect(inp).toContain(`Opt`)
  })

  it(`accurate → B3LYP/6-311+G(d,p) Opt Freq + D3BJ`, () => {
    const p = apply_gaussian_preset(`accurate`)
    expect(p.job_type).toBe(`opt_freq`)
    expect(p.basis).toBe(`6-311+G(d,p)`)
    const inp = gen({ ...p })
    expect(inp).toContain(`6-311+G(d,p)`)
    expect(inp).toContain(`Opt Freq`)
    expect(inp).toContain(`EmpiricalDispersion=GD3BJ`)
  })

  it(`td_dft → TD-DFT with NStates`, () => {
    const p = apply_gaussian_preset(`td_dft`)
    expect(p.job_type).toBe(`td`)
    expect(p.td_nstates).toBe(10)
    const inp = gen({ ...p })
    expect(inp).toContain(`TD(NStates=10)`)
  })

  it(`freq_thermo → Freq job with D3BJ`, () => {
    const p = apply_gaussian_preset(`freq_thermo`)
    expect(p.job_type).toBe(`freq`)
    const inp = gen({ ...p })
    expect(inp).toContain(`Freq`)
    expect(inp).toContain(`EmpiricalDispersion=GD3BJ`)
  })

  it(`solvation → scrf with Water solvent`, () => {
    const p = apply_gaussian_preset(`solvation`)
    expect(p.solvation).toBe(`scrf`)
    expect(p.solvent).toBe(`Water`)
    const inp = gen({ ...p })
    expect(inp).toContain(`SCRF=(SMD,Solvent=Water)`)
  })

  it(`ts_search → TS optimization keywords`, () => {
    const p = apply_gaussian_preset(`ts_search`)
    expect(p.job_type).toBe(`ts`)
    const inp = gen({ ...p })
    expect(inp).toContain(`Opt=(CalcFC,TS,NoEigen)`)
  })
})

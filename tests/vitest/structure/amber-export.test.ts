import { apply_amber_preset, generate_amber_mdin } from '$lib/structure/export/amber-export'
import type { AmberParams, AmberPreset } from '$lib/structure/export/amber-export'
import { describe, expect, it } from 'vitest'

// Contract / smoke tests for the client-side AMBER mdin generator.
// generate_amber_mdin is pure-frontend: no structure object needed — AMBER
// .mdin files are parameter-only; topology and coords are external files.
// These tests guard that every preset/stage produces a well-formed namelist.

const BASE: AmberParams = {
  title: `AMBER mdin test`,
  job_type: `md`,
  nstlim: 10000,
  dt: 0.002,
  maxcyc: 1000,
  ncyc: 500,
  drms: 0.01,
  irest: 0,
  ntt: 0,
  temp0: 300,
  tempi: 0,
  gamma_ln: 2.0,
  ntb: 1,
  cut: 10.0,
  ntc: 2,
  ntf: 2,
  ntpr: 1000,
  ntwe: 1000,
  ntwx: 1000,
  ntwv: 0,
  ntwr: 1000,
  ioutfm: 1,
  ntxo: 2,
  ntp: 0,
  barostat: 2,
  pres0: 1.0,
  use_mlp: false,
  mlp_model: `macepol_l`,
  animask: ``,
  mlp_shake: 0,
  gpu_id: 0,
  mlp_embedding: 0,
  mlp_multipole: 0,
  mlp_polar: 0,
  adjust_q: 1,
  extra_cntrl: ``,
  extra_mlp: ``,
}

const gen = (over: Partial<AmberParams>) => generate_amber_mdin({ ...BASE, ...over })

describe(`generate_amber_mdin produces valid AMBER mdin`, () => {
  it(`MD mode → well-formed &cntrl with imin=0, nstlim, dt`, () => {
    const out = gen({ job_type: `md`, nstlim: 50000, dt: 0.002 })
    expect(out).toContain(` &cntrl`)
    expect(out).toContain(` /`)
    expect(out).toContain(`imin = 0,`)
    expect(out).toContain(`nstlim = 50000,`)
    expect(out).toContain(`dt = 0.002,`)
    expect(out).toContain(`ntb = 1,`)
    expect(out).toContain(`cut = 10,`)
  })

  it(`minimize mode → well-formed &cntrl with imin=1, maxcyc, ncyc`, () => {
    const out = gen({ job_type: `minimize`, maxcyc: 2000, ncyc: 1000, drms: 0.005 })
    expect(out).toContain(` &cntrl`)
    expect(out).toContain(` /`)
    expect(out).toContain(`imin = 1,`)
    expect(out).toContain(`maxcyc = 2000,`)
    expect(out).toContain(`ncyc = 1000,`)
    expect(out).toContain(`drms = 0.005,`)
    // MD-only keys must not appear
    expect(out).not.toContain(`nstlim`)
    expect(out).not.toContain(`dt =`)
  })

  it(`irest=1 sets ntx=5; irest=0 sets ntx=1`, () => {
    expect(gen({ irest: 1 })).toContain(`ntx = 5,`)
    expect(gen({ irest: 0 })).toContain(`ntx = 1,`)
  })

  it(`ntt=3 (Langevin) emits temp0, tempi, gamma_ln`, () => {
    const out = gen({ ntt: 3, temp0: 300, tempi: 100, gamma_ln: 5.0 })
    expect(out).toContain(`ntt = 3,`)
    expect(out).toContain(`temp0 = 300,`)
    expect(out).toContain(`tempi = 100,`)
    expect(out).toContain(`gamma_ln = 5,`)
  })

  it(`ntt=0 omits temp0/tempi/gamma_ln`, () => {
    const out = gen({ ntt: 0 })
    expect(out).toContain(`ntt = 0,`)
    expect(out).not.toContain(`temp0`)
    expect(out).not.toContain(`tempi`)
    expect(out).not.toContain(`gamma_ln`)
  })

  it(`ntp>0 emits barostat and pres0`, () => {
    const out = gen({ ntp: 1, barostat: 2, pres0: 1.0 })
    expect(out).toContain(`ntp = 1,`)
    expect(out).toContain(`barostat = 2,`)
    expect(out).toContain(`pres0 = 1,`)
  })

  it(`ntp=0 omits barostat block`, () => {
    const out = gen({ ntp: 0 })
    expect(out).not.toContain(`ntp =`)
    expect(out).not.toContain(`barostat`)
    expect(out).not.toContain(`pres0`)
  })

  it(`use_mlp=true emits ifmlp=1 and &mlp namelist`, () => {
    const out = gen({ use_mlp: true, mlp_model: `macepol_l`, animask: ``, mlp_shake: 0, gpu_id: 0, mlp_embedding: 0, mlp_multipole: 0, mlp_polar: 0, adjust_q: 1 })
    expect(out).toContain(`ifmlp = 1,`)
    expect(out).toContain(`&mlp`)
    expect(out).toContain(`mlp_model='macepol_l',`)
    expect(out).toContain(`adjust_q=1,`)
    // &mlp block ends with /
    const mlp_idx = out.indexOf(`&mlp`)
    const slash_after = out.indexOf(`/`, mlp_idx)
    expect(slash_after).toBeGreaterThan(mlp_idx)
  })

  it(`use_mlp=false omits &mlp namelist and ifmlp`, () => {
    const out = gen({ use_mlp: false })
    expect(out).not.toContain(`ifmlp`)
    expect(out).not.toContain(`&mlp`)
  })

  it(`animask is quoted in &mlp when non-empty`, () => {
    const out = gen({ use_mlp: true, animask: `:1-100` })
    expect(out).toContain(`animask=":1-100",`)
  })

  it(`extra_cntrl lines are appended inside &cntrl`, () => {
    const out = gen({ extra_cntrl: `nmropt = 1` })
    expect(out).toContain(`nmropt = 1,`)
    const cntrl_end = out.indexOf(` /`)
    expect(out.lastIndexOf(`nmropt`, cntrl_end)).toBeGreaterThan(-1)
  })

  it(`output ends with a trailing newline`, () => {
    expect(gen({})).toMatch(/\n$/)
  })

  it(`title line is the first line`, () => {
    const out = gen({ title: `My test run` })
    expect(out.split(`\n`)[0]).toBe(`My test run`)
  })
})

describe(`apply_amber_preset returns correct params`, () => {
  const PRESETS: AmberPreset[] = [`mlmm_md`, `mlmm_min`, `classical_md`, `classical_min`, `nvt_langevin`, `npt_langevin`]

  for (const preset of PRESETS) {
    it(`${preset} → non-empty partial`, () => {
      const p = apply_amber_preset(preset)
      expect(Object.keys(p).length).toBeGreaterThan(0)
    })
  }

  it(`mlmm_md → MD, use_mlp=true, ntb=0, large cut`, () => {
    const p = apply_amber_preset(`mlmm_md`)
    expect(p.job_type).toBe(`md`)
    expect(p.use_mlp).toBe(true)
    expect(p.ntb).toBe(0)
    expect(p.cut).toBeGreaterThan(100)
  })

  it(`mlmm_min → minimize, use_mlp=true, ntb=0`, () => {
    const p = apply_amber_preset(`mlmm_min`)
    expect(p.job_type).toBe(`minimize`)
    expect(p.use_mlp).toBe(true)
    expect(p.ntb).toBe(0)
  })

  it(`classical_md → MD, use_mlp=false, ntt=3, periodic`, () => {
    const p = apply_amber_preset(`classical_md`)
    expect(p.job_type).toBe(`md`)
    expect(p.use_mlp).toBe(false)
    expect(p.ntt).toBe(3)
    expect(p.ntb).toBe(1)
  })

  it(`classical_min → minimize, use_mlp=false, periodic`, () => {
    const p = apply_amber_preset(`classical_min`)
    expect(p.job_type).toBe(`minimize`)
    expect(p.use_mlp).toBe(false)
    expect(p.ntb).toBe(1)
  })

  it(`nvt_langevin → MD, ntp=0 (NVT), ntt=3`, () => {
    const p = apply_amber_preset(`nvt_langevin`)
    expect(p.job_type).toBe(`md`)
    expect(p.ntp).toBe(0)
    expect(p.ntt).toBe(3)
  })

  it(`npt_langevin → MD, ntp=1, barostat=2, pres0=1`, () => {
    const p = apply_amber_preset(`npt_langevin`)
    expect(p.job_type).toBe(`md`)
    expect(p.ntp).toBe(1)
    expect(p.barostat).toBe(2)
    expect(p.pres0).toBe(1.0)
  })

  it(`preset applied over BASE produces valid mdin for each preset`, () => {
    for (const preset of PRESETS) {
      const p = apply_amber_preset(preset)
      const out = gen(p)
      expect(out).toContain(` &cntrl`)
      expect(out).toContain(` /`)
      const is_min = p.job_type === `minimize`
      expect(out).toContain(is_min ? `imin = 1,` : `imin = 0,`)
    }
  })
})

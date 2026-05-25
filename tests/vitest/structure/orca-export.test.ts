import { gen_orca_input } from '$lib/structure/export/orca-export'
import type { OrcaParams } from '$lib/structure/export/orca-export'
import { describe, expect, it } from 'vitest'

// Contract / smoke tests for the client-side ORCA generator. ORCA is a molecular
// code, so we use a minimal water molecule (no periodic lattice). gen_orca_input
// produces a well-formed ORCA input with a `!` keyword line, an optional %block
// section, and a `* xyz charge mult` coordinate block closed by `*`.

function water() {
  return {
    sites: [
      { species: [{ element: `O` }], xyz: [0.000000, 0.000000, 0.119748] },
      { species: [{ element: `H` }], xyz: [0.000000, 0.756950, -0.478993] },
      { species: [{ element: `H` }], xyz: [0.000000, -0.756950, -0.478993] },
    ],
  }
}

const BASE: OrcaParams = {
  run_type: `SP`,
  method: `DFT`,
  functional: `PBE`,
  functional_custom: ``,
  wavefunction: ``,
  uno_enabled: false,
  uco_enabled: false,
  basis: `def2-SVP`,
  charge: 0,
  multiplicity: 1,
  opt_convergence: `Opt`,
  use_cartesian: false,
  frozen_mode: `none`,
  frozen_z: 0,
  md_initvel: 300,
  md_run: 500,
  cim_method: `DLPNO-CCSD(T)`,
  cim_thresh: 1e-4,
  selected_indices: [],
}

const gen = (over: Partial<OrcaParams>) =>
  gen_orca_input(water() as never, { ...BASE, ...over })

describe(`gen_orca_input produces valid ORCA input`, () => {
  const RUN_TYPES: Array<[string, string]> = [
    [`SP`, `SP`],
    [`Opt`, `Opt`],
    [`Freq`, `Freq`],
    [`MD`, `MD`],
    [`CIM`, `CIM`],
  ]

  for (const [rt, label] of RUN_TYPES) {
    it(`${rt} → well-formed input`, () => {
      const inp = gen({ run_type: rt })
      // keyword line always starts with `!`
      expect(inp).toContain(`! `)
      expect(inp).toContain(label)
      // coordinate block opened with `* xyz <charge> <mult>`
      expect(inp).toContain(`* xyz 0 1`)
      // each element appears in the coord block
      expect(inp).toContain(`O    `)
      expect(inp).toContain(`H    `)
      // coordinate block closed by bare `*`
      const lines = inp.split(`\n`)
      expect(lines.some((l) => l === `*`)).toBe(true)
    })
  }

  it(`DFT run includes functional on keyword line`, () => {
    const inp = gen({ run_type: `SP`, method: `DFT`, functional: `PBE` })
    const kw_line = inp.split(`\n`)[0]
    expect(kw_line).toContain(`PBE`)
    expect(kw_line).toContain(`def2-SVP`)
  })

  it(`DFT with custom functional uses functional_custom`, () => {
    const inp = gen({ method: `DFT`, functional: `other`, functional_custom: `wB97X-D4` })
    expect(inp.split(`\n`)[0]).toContain(`wB97X-D4`)
  })

  it(`non-DFT method (MP2) uses method name directly`, () => {
    const inp = gen({ run_type: `SP`, method: `MP2`, basis: `cc-pVDZ` })
    const kw_line = inp.split(`\n`)[0]
    expect(kw_line).toContain(`MP2`)
    expect(kw_line).toContain(`cc-pVDZ`)
  })

  it(`wavefunction keyword appears on keyword line when set`, () => {
    const inp = gen({ wavefunction: `RIJCOSX` })
    expect(inp.split(`\n`)[0]).toContain(`RIJCOSX`)
  })

  it(`UNO and UCO flags appear when enabled`, () => {
    const inp = gen({ uno_enabled: true, uco_enabled: true })
    const kw_line = inp.split(`\n`)[0]
    expect(kw_line).toContain(`UNO`)
    expect(kw_line).toContain(`UCO`)
  })

  it(`Opt with non-default convergence adds convergence keyword`, () => {
    const inp = gen({ run_type: `Opt`, opt_convergence: `TightOpt` })
    expect(inp.split(`\n`)[0]).toContain(`TightOpt`)
  })

  it(`Opt with use_cartesian adds COpt`, () => {
    const inp = gen({ run_type: `Opt`, use_cartesian: true })
    expect(inp.split(`\n`)[0]).toContain(`COpt`)
  })

  it(`MD run emits %md block with Initvel and Run`, () => {
    const inp = gen({ run_type: `MD`, md_initvel: 300, md_run: 500 })
    expect(inp).toContain(`%md`)
    expect(inp).toContain(`Initvel 300_K`)
    expect(inp).toContain(`Run 500`)
    expect(inp).toContain(`end`)
  })

  it(`CIM run emits %cim block with CIMTHRESH and cc-pVDZ basis`, () => {
    const inp = gen({ run_type: `CIM`, cim_method: `DLPNO-CCSD(T)`, cim_thresh: 1e-4 })
    expect(inp).toContain(`DLPNO-CCSD(T)`)
    expect(inp).toContain(`cc-pVDZ`)
    expect(inp).toContain(`%cim`)
    expect(inp).toContain(`CIMTHRESH`)
    expect(inp).toContain(`end`)
  })

  it(`charge and multiplicity appear in coordinate block header`, () => {
    const inp = gen_orca_input(water() as never, { ...BASE, charge: -1, multiplicity: 2 })
    expect(inp).toContain(`* xyz -1 2`)
  })

  it(`Opt with frozen selected_indices emits Constraints block`, () => {
    const inp = gen({
      run_type: `Opt`,
      frozen_mode: `selected`,
      selected_indices: [0, 2],
    })
    expect(inp).toContain(`> Constraints`)
    expect(inp).toContain(`{ C 0 C }`)
    expect(inp).toContain(`{ C 2 C }`)
  })

  it(`Opt with frozen_mode none omits Constraints block`, () => {
    const inp = gen({ run_type: `Opt`, frozen_mode: `none` })
    expect(inp).not.toContain(`> Constraints`)
  })

  it(`empty structure returns empty string`, () => {
    expect(gen_orca_input(null as never, BASE)).toBe(``)
  })

  it(`coordinate values are formatted to 6 decimal places`, () => {
    const inp = gen({ run_type: `SP` })
    // O atom has z=0.119748 — check it appears formatted
    expect(inp).toContain(`0.119748`)
  })
})

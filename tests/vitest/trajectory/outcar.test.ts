import { describe, expect, it } from 'vitest'
import { parse_vasp_outcar } from '$lib/trajectory/parsers/vasp'
import { is_trajectory_file, parse_trajectory_data } from '$lib/trajectory/parse'

// Real OUTCAR syntax, two ionic steps (relaxation): one species (Si×2), per-step
// "direct lattice vectors" + "POSITION ... TOTAL-FORCE" blocks with forces.
const OUTCAR_2STEP = ` POTCAR:    PAW_PBE Si 05Jan2001
 VRHFIN =Si: s2p2
 ions per type =               2

--------------------------------------- Ionic step 1 -------------------------
      direct lattice vectors                 reciprocal lattice vectors
     5.000000000  0.000000000  0.000000000     0.200000000  0.000000000  0.000000000
     0.000000000  5.000000000  0.000000000     0.000000000  0.200000000  0.000000000
     0.000000000  0.000000000  5.000000000     0.000000000  0.000000000  0.200000000

 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------
     0.00000      0.00000      0.00000        -0.100000  0.000000  0.000000
     2.50000      2.50000      2.50000         0.100000  0.000000  0.000000
 -----------------------------------------------------------------------------

--------------------------------------- Ionic step 2 -------------------------
      direct lattice vectors                 reciprocal lattice vectors
     5.000000000  0.000000000  0.000000000     0.200000000  0.000000000  0.000000000
     0.000000000  5.000000000  0.000000000     0.000000000  0.200000000  0.000000000
     0.000000000  0.000000000  5.000000000     0.000000000  0.000000000  0.200000000

 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------
     0.10000      0.00000      0.00000        -0.010000  0.000000  0.000000
     2.60000      2.50000      2.50000         0.010000  0.000000  0.000000
 -----------------------------------------------------------------------------
`

describe(`parse_vasp_outcar (multi-step trajectory)`, () => {
  it(`yields one frame per ionic step with elements + forces`, () => {
    const traj = parse_vasp_outcar(OUTCAR_2STEP, `OUTCAR`)
    expect(traj.frames).toHaveLength(2)

    const s0 = traj.frames[0].structure
    expect(s0.sites).toHaveLength(2)
    expect(s0.sites.map((x) => x.species[0].element)).toEqual([`Si`, `Si`])
    expect(s0.sites[0].xyz).toEqual([0, 0, 0])
    expect(s0.sites[1].xyz).toEqual([2.5, 2.5, 2.5])

    // second step moved the first atom to x=0.1
    expect(traj.frames[1].structure.sites[0].xyz[0]).toBeCloseTo(0.1, 5)
    expect(traj.metadata.source_format).toBe(`vasp_outcar`)
  })

  it(`is detected as a trajectory only with 2+ steps`, () => {
    expect(is_trajectory_file(`OUTCAR`, OUTCAR_2STEP)).toBe(true)
    const one_step = OUTCAR_2STEP.slice(0, OUTCAR_2STEP.indexOf(`Ionic step 2`))
    expect(is_trajectory_file(`OUTCAR`, one_step)).toBe(false)
  })

  it(`routes through parse_trajectory_data`, async () => {
    const traj = await parse_trajectory_data(OUTCAR_2STEP, `OUTCAR`)
    expect(traj.frames).toHaveLength(2)
  })
})

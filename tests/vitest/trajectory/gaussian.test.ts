import { parse_gaussian_output } from '$lib/trajectory/parsers/gaussian'
import { describe, expect, it } from 'vitest'

const orientation_block = (name: string, x: number) => ` ${name}:
 ---------------------------------------------------------------------
 Center     Atomic      Atomic             Coordinates (Angstroms)
 Number     Number       Type             X           Y           Z
 ---------------------------------------------------------------------
      1          6           0        ${x.toFixed(6)}    0.000000    0.000000
 ---------------------------------------------------------------------
`

const scf_energy = (energy: number) =>
  ` SCF Done:  E(RB3LYP) =  ${energy.toFixed(8)}     A.U. after   10 cycles\n`

const point = (point_number: number, path_number: number) =>
  ` Point Number: ${point_number} Path Number: ${path_number}\n`

const irc_summary = ` Summary of reaction path following
 --------------------------------------------------------------------------
                         Energy    RxCoord
   1                   -0.40000  -2.00000
   2                   -0.30000  -1.00000
   3                    0.00000   0.00000
   4                   -0.10000   1.00000
   5                   -0.20000   2.00000
 --------------------------------------------------------------------------
 Total number of points: 4
`

describe(`parse_gaussian_output`, () => {
  it(`prefers Standard orientation without recording Input orientation twice`, () => {
    const content =
      orientation_block(`Input orientation`, 1) + orientation_block(`Standard orientation`, 2)

    const trajectory = parse_gaussian_output(content)

    expect(trajectory.frames).toHaveLength(1)
    expect(trajectory.frames[0].structure.sites[0].xyz).toEqual([2, 0, 0])
  })

  it(`falls back to Input orientation when Standard orientation is absent`, () => {
    const trajectory = parse_gaussian_output(orientation_block(`Input orientation`, 1))

    expect(trajectory.frames).toHaveLength(1)
    expect(trajectory.frames[0].structure.sites[0].xyz).toEqual([1, 0, 0])
  })

  it(`orders a bidirectional IRC as Path 2 reversed, TS, then Path 1`, () => {
    const content = ` IRC-IRC-IRC-IRC-IRC-
 Redundant internal coordinates found in file.  (old form).
 C,0,0.000000,0.000000,0.000000
 Recover connectivity data from disk.
 Energy From Chk = -10.00000000
${point(0, 1)}${orientation_block(`Input orientation`, 1)}${scf_energy(-10.1)}
${point(1, 1)}${orientation_block(`Input orientation`, 2)}${scf_energy(-10.2)}
${point(2, 1)}${orientation_block(`Input orientation`, 3)}${scf_energy(-10.3)}
${point(1, 2)}${orientation_block(`Input orientation`, 4)}${scf_energy(-10.4)}
${point(2, 2)}${irc_summary}
${orientation_block(`Input orientation`, 4)}
`

    const trajectory = parse_gaussian_output(content)

    expect(trajectory.frames).toHaveLength(5)
    expect(trajectory.frames.map((frame) => frame.structure.sites[0].xyz[0])).toEqual([
      4,
      3,
      0,
      1,
      2,
    ])
    expect(trajectory.frames.map((frame) => frame.metadata?.reaction_coordinate)).toEqual([
      -2,
      -1,
      0,
      1,
      2,
    ])
    expect(trajectory.frames[2].metadata?.is_transition_state).toBe(true)
    expect(trajectory.frames[2].metadata?.energy).toBeCloseTo(-10 * 27.211386245988)
  })

  it(`keeps an IRC transition state already present in a non-checkpoint output`, () => {
    const content = ` IRC-IRC-IRC-IRC-IRC-
${point(0, 1)}${orientation_block(`Input orientation`, 0)}${scf_energy(-10)}
${point(1, 1)}${orientation_block(`Input orientation`, 1)}${scf_energy(-10.1)}
${point(2, 1)}${orientation_block(`Input orientation`, 2)}${scf_energy(-10.2)}
${point(1, 2)}${orientation_block(`Input orientation`, 3)}${scf_energy(-10.3)}
${point(2, 2)}${orientation_block(`Input orientation`, 4)}${scf_energy(-10.4)}
${irc_summary}
${orientation_block(`Input orientation`, 4)}
`

    const trajectory = parse_gaussian_output(content)

    expect(trajectory.frames.map((frame) => frame.structure.sites[0].xyz[0])).toEqual([
      4,
      3,
      0,
      1,
      2,
    ])
    expect(trajectory.frames[2].metadata?.is_transition_state).toBe(true)
  })
})

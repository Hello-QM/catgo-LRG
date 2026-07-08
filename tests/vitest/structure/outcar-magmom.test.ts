import { describe, expect, test } from 'vitest'
import { parse_outcar } from '$lib/structure/parsers/outcar'

// Minimal OUTCAR: 2 Fe atoms + a collinear "magnetization (x)" table (AFM: +3/-3).
const OUTCAR_COLLINEAR = ` VRHFIN =Fe: s2p2
 ions per type =               2

      direct lattice vectors
     2.870000000  0.000000000  0.000000000
     0.000000000  2.870000000  0.000000000
     0.000000000  0.000000000  2.870000000

 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------
     0.00000      0.00000      0.00000         0.000000  0.000000  0.000000
     1.43500      1.43500      1.43500         0.000000  0.000000  0.000000
 -----------------------------------------------------------------------------

 magnetization (x)

# of ion       s       p       d       tot
------------------------------------------
    1        0.010   0.020   2.970   3.000
    2       -0.010  -0.020  -2.970  -3.000
--------------------------------------------------
tot          0.000   0.000   0.000   0.000
`

// Same but non-collinear: (x)/(y)/(z) tables → a 3-vector moment per atom.
const OUTCAR_NONCOLLINEAR = OUTCAR_COLLINEAR
  + `
 magnetization (y)

# of ion       s       p       d       tot
------------------------------------------
    1        0.000   0.000   1.000   1.000
    2        0.000   0.000  -1.000  -1.000
--------------------------------------------------
tot          0.000   0.000   0.000   0.000

 magnetization (z)

# of ion       s       p       d       tot
------------------------------------------
    1        0.000   0.000   0.500   0.500
    2        0.000   0.000  -0.500  -0.500
--------------------------------------------------
tot          0.000   0.000   0.000   0.000
`

describe(`parse_outcar magmom`, () => {
  test(`collinear: scalar magmom per atom (tot column)`, () => {
    const s = parse_outcar(OUTCAR_COLLINEAR)
    expect(s).not.toBeNull()
    expect(s!.sites).toHaveLength(2)
    expect(s!.sites[0].properties?.magmom).toBe(3)
    expect(s!.sites[1].properties?.magmom).toBe(-3)
  })

  test(`non-collinear: [mx,my,mz] vector per atom`, () => {
    const s = parse_outcar(OUTCAR_NONCOLLINEAR)
    expect(s).not.toBeNull()
    expect(s!.sites[0].properties?.magmom).toEqual([3, 1, 0.5])
    expect(s!.sites[1].properties?.magmom).toEqual([-3, -1, -0.5])
  })
})

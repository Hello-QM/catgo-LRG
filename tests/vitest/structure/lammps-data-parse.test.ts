// Regression: an `Atoms # full` data file (id mol type q x y z nx ny nz, as
// written by `write_data`) was mis-detected by the column heuristics — the
// trailing image flags were read as coordinates, collapsing all atoms onto
// the origin. Downstream that exploded PBC images 8× and OOM'd the bond
// search, freezing the viewer on drag-in. The style annotation in the
// section header is authoritative and must win over guessing.
import { describe, expect, test } from 'vitest'
import { parse_lammps_data } from '../../../src/lib/structure/parsers/lammps'

const FULL_WITH_IMAGE_FLAGS = `LAMMPS data file via write_data, version 10 Dec 2025, units = real

4 atoms
2 atom types

-20 240 xlo xhi
0 52 ylo yhi
-16 122 zlo zhi

Masses

1 15.9994
2 12.0112

Pair Coeffs # lj/cut/coul/long

1 0.066 3.5
2 0.07 3.55

Atoms # full

1 1 1 -0.2 -17.36 6.16 -13.12 0 0 0
2 1 2 0.1 -16.57 5.86 -12.58 0 1 0
3 1 2 0.1 100.25 26.0 50.0 -1 0 0
4 1 1 -0.2 239.0 51.5 121.0 0 0 0
`

const ATOMIC_NO_FLAGS = `LAMMPS data file

2 atoms
1 atom types

0 10 xlo xhi
0 10 ylo yhi
0 10 zlo zhi

Masses

1 12.0112

Atoms # atomic

1 1 1.0 2.0 3.0
2 1 4.0 5.0 6.0
`

describe(`parse_lammps_data atom_style handling`, () => {
  test(`full style with image flags reads real coordinates (origin-shifted)`, () => {
    const s = parse_lammps_data(FULL_WITH_IMAGE_FLAGS)!
    expect(s.sites).toHaveLength(4)
    // xyz shifted by the box origin (xlo=-20, ylo=0, zlo=-16)
    expect(s.sites[0].xyz[0]).toBeCloseTo(-17.36 + 20, 6)
    expect(s.sites[0].xyz[2]).toBeCloseTo(-13.12 + 16, 6)
    // element from mass table via type column (col 3, NOT col 2 = molecule id).
    // The Pair Coeffs section above must NOT bleed into the Masses parse —
    // its sigma column (3.5) once overwrote the masses and mapped types to He.
    expect(s.sites[0].species[0].element).toBe(`O`)
    expect(s.sites[1].species[0].element).toBe(`C`)
    // abc in [0,1] for in-box atoms — the old bug left every abc at 0
    for (const site of s.sites) {
      for (let d = 0; d < 3; d++) {
        expect(site.abc[d]).toBeGreaterThanOrEqual(0)
        expect(site.abc[d]).toBeLessThanOrEqual(1)
      }
    }
    // distinct positions (the bug collapsed everything onto one point)
    expect(s.sites[0].xyz).not.toEqual(s.sites[3].xyz)
  })

  test(`atomic style without flags still parses`, () => {
    const s = parse_lammps_data(ATOMIC_NO_FLAGS)!
    expect(s.sites).toHaveLength(2)
    expect(s.sites[0].xyz).toEqual([1, 2, 3])
    expect(s.sites[1].abc[0]).toBeCloseTo(0.4, 6)
  })
})

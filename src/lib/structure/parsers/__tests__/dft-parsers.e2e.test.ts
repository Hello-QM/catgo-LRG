// End-to-end validation against REAL files:
//   - QE (.pwi) and CASTEP (.cell) written by ASE 3.27
//   - SIESTA (.fdf) in real fdf syntax, same ASE structures
//   - a real VASP OUTCAR (ASE's bundled test fixture, Ni18, ~160KB)
// Ground truth (cell, symbols, fractional coords) is ASE's own reading of each
// file, stored in fixtures/expected.json. The TS parser must reproduce it.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse_structure_file } from '../dispatch'
import type { ParsedStructure } from '../common'

// vitest root is the repo root, so resolve fixtures from cwd.
const FIX_DIR = resolve(`src/lib/structure/parsers/__tests__/fixtures`)
const fx = (name: string) => readFileSync(resolve(FIX_DIR, name), `utf8`)
const expected: Record<
  string,
  { cell: number[][]; symbols: string[]; frac: number[][] }
> = JSON.parse(fx(`expected.json`))

// Periodic distance between two fractional coords on each axis (handles wrap).
function frac_close(a: number[], b: number[], tol = 1e-3): boolean {
  return a.every((_, i) => {
    let d = Math.abs(((a[i] % 1) + 1) % 1 - ((b[i] % 1) + 1) % 1)
    d = Math.min(d, 1 - d)
    return d < tol
  })
}

function check(file: string, parsed: ParsedStructure | null) {
  const exp = expected[file]
  expect(parsed, `${file} failed to parse`).not.toBeNull()
  const s = parsed!

  // atom count
  expect(s.sites.length, `${file} atom count`).toBe(exp.symbols.length)

  // species multiset
  const got = s.sites.map((x) => x.species[0].element).sort()
  expect(got, `${file} species`).toEqual([...exp.symbols].sort())

  // lattice vectors (row-wise, Å)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      expect(
        Math.abs(s.lattice!.matrix[i][j] - exp.cell[i][j]),
        `${file} cell[${i}][${j}]`,
      ).toBeLessThan(1e-3)
    }
  }

  // every expected fractional site must be matched (set match, periodic-aware)
  const remaining = s.sites.map((x) => x.abc as number[])
  for (const want of exp.frac) {
    const idx = remaining.findIndex((have) => frac_close(have, want))
    expect(idx, `${file}: no parsed atom matches frac ${want.map((v) => v.toFixed(3))}`)
      .toBeGreaterThanOrEqual(0)
    remaining.splice(idx, 1)
  }
}

describe(`DFT parsers vs real files (ASE ground truth)`, () => {
  it(`QE input — Si diamond (.pwi)`, () => check(`si.pwi`, parse_structure_file(fx(`si.pwi`), `si.pwi`)))
  it(`QE input — triclinic H2O, cartesian Å (.pwi)`, () =>
    check(`tri.pwi`, parse_structure_file(fx(`tri.pwi`), `tri.pwi`)))
  it(`CASTEP — Si diamond (.cell)`, () => check(`si.cell`, parse_structure_file(fx(`si.cell`), `si.cell`)))
  it(`CASTEP — triclinic H2O, POSITIONS_ABS (.cell)`, () =>
    check(`tri.cell`, parse_structure_file(fx(`tri.cell`), `tri.cell`)))
  it(`SIESTA — Si diamond (.fdf)`, () => check(`si.fdf`, parse_structure_file(fx(`si.fdf`), `si.fdf`)))
  it(`SIESTA — triclinic H2O (.fdf)`, () => check(`tri.fdf`, parse_structure_file(fx(`tri.fdf`), `tri.fdf`)))
  it(`OUTCAR — real VASP relaxation, last frame (Ni18)`, () =>
    check(`OUTCAR`, parse_structure_file(fx(`OUTCAR`), `OUTCAR`)))
})

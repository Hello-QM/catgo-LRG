// Phase 2/3 parsers, validated against authoritative references:
//   - Gaussian (.gjf) written by ASE 3.27 (real file)
//   - ORCA (.orcainp) — real `* xyz` syntax, same ASE molecule
//   - OpenMX (.dat) / ABACUS (.stru) — real syntax built from ASE structures
//   - QE ibrav≠0 — checked by convention-independent lattice invariants
// Periodic/molecule ground truth (cell/symbols/frac or cart) from ASE.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse_structure_file } from '../dispatch'
import type { ParsedStructure } from '../common'

const FIX = resolve(`src/lib/structure/parsers/__tests__/fixtures`)
const fx = (n: string) => readFileSync(resolve(FIX, n), `utf8`)
const expected: Record<string, {
  periodic: boolean
  cell?: number[][]
  symbols: string[]
  frac?: number[][]
  cart?: number[][]
}> = JSON.parse(fx(`expected-p23.json`))

const BOHR = 0.52917721090

function frac_close(a: number[], b: number[], tol = 1e-3) {
  return a.every((_, i) => {
    let d = Math.abs(((a[i] % 1) + 1) % 1 - ((b[i] % 1) + 1) % 1)
    d = Math.min(d, 1 - d)
    return d < tol
  })
}
const xyz_close = (a: number[], b: number[], tol = 1e-3) => a.every((_, i) => Math.abs(a[i] - b[i]) < tol)

function set_match(got: number[][], want: number[][], cmp: (a: number[], b: number[]) => boolean, label: string) {
  const rem = [...got]
  for (const w of want) {
    const idx = rem.findIndex((g) => cmp(g, w))
    expect(idx, `${label}: unmatched ${w.map((v) => v.toFixed(3))}`).toBeGreaterThanOrEqual(0)
    rem.splice(idx, 1)
  }
}

function check(file: string, parsed: ParsedStructure | null) {
  const exp = expected[file]
  expect(parsed, `${file} failed to parse`).not.toBeNull()
  const s = parsed!
  expect(s.sites.length, `${file} count`).toBe(exp.symbols.length)
  expect(s.sites.map((x) => x.species[0].element).sort(), `${file} species`).toEqual([...exp.symbols].sort())

  if (exp.periodic) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(Math.abs(s.lattice!.matrix[i][j] - exp.cell![i][j]), `${file} cell[${i}][${j}]`).toBeLessThan(1e-3)
      }
    }
    set_match(s.sites.map((x) => x.abc as number[]), exp.frac!, frac_close, `${file} frac`)
  } else {
    expect(s.lattice, `${file} should have no lattice`).toBeUndefined()
    set_match(s.sites.map((x) => x.xyz as number[]), exp.cart!, xyz_close, `${file} cart`)
  }
}

describe(`Phase 2/3 parsers vs references`, () => {
  it(`Gaussian .gjf (ASE-written H2O)`, () => check(`h2o.gjf`, parse_structure_file(fx(`h2o.gjf`), `h2o.gjf`)))
  it(`ORCA .orcainp (real * xyz, H2O)`, () => check(`h2o.orcainp`, parse_structure_file(fx(`h2o.orcainp`), `h2o.orcainp`)))
  it(`OpenMX .dat — triclinic`, () => check(`tri.dat`, parse_structure_file(fx(`tri.dat`), `tri.dat`)))
  it(`OpenMX .dat — Si`, () => check(`si.dat`, parse_structure_file(fx(`si.dat`), `si.dat`)))
  it(`ABACUS STRU — triclinic`, () => check(`tri.stru`, parse_structure_file(fx(`tri.stru`), `tri.stru`)))
  it(`ABACUS STRU — Si`, () => check(`si.stru`, parse_structure_file(fx(`si.stru`), `si.stru`)))

  it(`QE ibrav=2 (fcc) — lattice invariants`, () => {
    const s = parse_structure_file(fx(`ibrav2.in`), `ibrav2.in`)!
    expect(s).not.toBeNull()
    expect(s.sites).toHaveLength(1)
    const a = 7.6 * BOHR // celldm(1) in bohr → Å
    const L = s.lattice!
    expect(Math.abs(L.volume - a ** 3 / 4)).toBeLessThan(1e-2) // fcc primitive volume = a³/4
    for (const len of [L.a, L.b, L.c]) expect(Math.abs(len - a / Math.SQRT2)).toBeLessThan(1e-3)
    for (const ang of [L.alpha, L.beta, L.gamma]) expect(Math.abs(ang - 60)).toBeLessThan(0.5)
  })

  it(`QE ibrav=4 (hex) — lattice invariants`, () => {
    const s = parse_structure_file(fx(`ibrav4.in`), `ibrav4.in`)!
    expect(s).not.toBeNull()
    const a = 5.0 * BOHR
    const c = 1.6 * a
    const L = s.lattice!
    expect(Math.abs(L.a - a)).toBeLessThan(1e-3)
    expect(Math.abs(L.b - a)).toBeLessThan(1e-3)
    expect(Math.abs(L.c - c)).toBeLessThan(1e-3)
    expect(Math.abs(L.gamma - 120)).toBeLessThan(0.5) // angle between the two a-vectors
  })
})

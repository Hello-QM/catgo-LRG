import { describe, expect, it } from 'vitest'
import { parse_qe } from '../qe'
import { parse_orca } from '../orca'
import { parse_gaussian_input } from '../gaussian-input'
import type { Site } from '$lib'

const BOHR = 0.52917721090
const dist = (a: Site, b: Site) =>
  Math.hypot(a.xyz[0] - b.xyz[0], a.xyz[1] - b.xyz[1], a.xyz[2] - b.xyz[2])
const angle = (a: Site, v: Site, b: Site) => {
  const u = [a.xyz[0] - v.xyz[0], a.xyz[1] - v.xyz[1], a.xyz[2] - v.xyz[2]]
  const w = [b.xyz[0] - v.xyz[0], b.xyz[1] - v.xyz[1], b.xyz[2] - v.xyz[2]]
  const d = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) /
    (Math.hypot(...u) * Math.hypot(...w))
  return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI
}
const qe = (ibrav: number, extra: string, pos = `crystal\nAl 0 0 0`) =>
  `&SYSTEM\n  ibrav = ${ibrav}\n${extra}\n/\nATOMIC_POSITIONS ${pos}\n`

describe(`QE full ibrav table (lattice invariants)`, () => {
  it(`ibrav=3 (bcc): volume a³/2, |v|=a√3/2`, () => {
    const a = 5 * BOHR
    const L = parse_qe(qe(3, `  celldm(1) = 5`))!.lattice!
    expect(L.volume).toBeCloseTo(a ** 3 / 2, 3)
    for (const len of [L.a, L.b, L.c]) expect(len).toBeCloseTo((a * Math.sqrt(3)) / 2, 4)
  })

  it(`ibrav=5 (trigonal): equal lengths a, equal angles arccos(cd4)`, () => {
    const a = 6 * BOHR
    const L = parse_qe(qe(5, `  celldm(1) = 6\n  celldm(4) = 0.5`))!.lattice!
    for (const len of [L.a, L.b, L.c]) expect(len).toBeCloseTo(a, 4)
    for (const ang of [L.alpha, L.beta, L.gamma]) expect(ang).toBeCloseTo(60, 2) // arccos(0.5)
  })

  it(`ibrav=7 (bct): volume a²c/2`, () => {
    const a = 5 * BOHR, c = 1.5 * a
    const L = parse_qe(qe(7, `  celldm(1) = 5\n  celldm(3) = 1.5`))!.lattice!
    expect(L.volume).toBeCloseTo((a * a * c) / 2, 3)
  })

  it(`ibrav=12 (monoclinic): a,b,c + gamma=arccos(cd4)`, () => {
    const a = 5 * BOHR
    const L = parse_qe(qe(12, `  celldm(1) = 5\n  celldm(2) = 1.2\n  celldm(3) = 1.5\n  celldm(4) = 0.3`))!.lattice!
    expect(L.a).toBeCloseTo(a, 4)
    expect(L.b).toBeCloseTo(1.2 * a, 4)
    expect(L.c).toBeCloseTo(1.5 * a, 4)
    expect(L.gamma).toBeCloseTo(Math.acos(0.3) * 180 / Math.PI, 2)
    expect(L.alpha).toBeCloseTo(90, 2)
  })

  it(`ibrav=14 (triclinic): angles match cosBC/cosAC/cosAB`, () => {
    const L = parse_qe(qe(14,
      `  celldm(1) = 5\n  celldm(2) = 1.1\n  celldm(3) = 1.3\n  celldm(4) = 0.2\n  celldm(5) = 0.15\n  celldm(6) = 0.25`))!.lattice!
    expect(L.alpha).toBeCloseTo(Math.acos(0.2) * 180 / Math.PI, 2)
    expect(L.beta).toBeCloseTo(Math.acos(0.15) * 180 / Math.PI, 2)
    expect(L.gamma).toBeCloseTo(Math.acos(0.25) * 180 / Math.PI, 2)
  })
})

describe(`Gaussian Z-matrix → Cartesian`, () => {
  it(`methane: 4 C–H = 1.089 Å, H–C–H = 109.471°`, () => {
    const gjf = `#P\n\nmethane\n\n0 1\nC\nH 1 1.089\nH 1 1.089 2 109.471\nH 1 1.089 2 109.471 3 120.0\nH 1 1.089 2 109.471 3 -120.0\n\n`
    const s = parse_gaussian_input(gjf)!
    expect(s.sites).toHaveLength(5)
    const [C, ...H] = s.sites
    for (const h of H) expect(dist(C, h)).toBeCloseTo(1.089, 3)
    for (const h of H) expect(angle(H[0], C, h === H[0] ? H[1] : h)).toBeCloseTo(109.471, 1)
  })

  it(`water with variables`, () => {
    const gjf = `#\n\nwater\n\n0 1\nO\nH 1 R\nH 1 R 2 A\n\nR 0.96\nA 104.5\n`
    const s = parse_gaussian_input(gjf)!
    expect(s.sites).toHaveLength(3)
    expect(dist(s.sites[0], s.sites[1])).toBeCloseTo(0.96, 4)
    expect(dist(s.sites[0], s.sites[2])).toBeCloseTo(0.96, 4)
    expect(angle(s.sites[1], s.sites[0], s.sites[2])).toBeCloseTo(104.5, 2)
  })
})

describe(`ORCA %coords block`, () => {
  it(`parses Coords ... end`, () => {
    const inp = `! B3LYP\n%coords\n  CTyp xyz\n  Charge 0\n  Mult 1\n  Coords\n    O 0.0 0.0 0.0\n    H 0.0 0.0 0.96\n  end\nend\n`
    const s = parse_orca(inp)!
    expect(s.sites).toHaveLength(2)
    expect(s.sites.map((x) => x.species[0].element)).toEqual([`O`, `H`])
    expect(s.sites[1].xyz[2]).toBeCloseTo(0.96, 5)
  })

  it(`returns null for xyzfile (external)`, () => {
    expect(parse_orca(`! B3LYP\n* xyzfile 0 1 mol.xyz\n`)).toBeNull()
  })
})

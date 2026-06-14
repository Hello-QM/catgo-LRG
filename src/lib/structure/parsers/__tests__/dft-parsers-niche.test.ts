import { describe, expect, it } from 'vitest'
import { parse_qe } from '../qe'
import { parse_orca } from '../orca'
import type { Site } from '$lib'

const BOHR = 0.52917721090
const dist = (a: Site, b: Site) =>
  Math.hypot(a.xyz[0] - b.xyz[0], a.xyz[1] - b.xyz[1], a.xyz[2] - b.xyz[2])
const angle = (a: Site, v: Site, b: Site) => {
  const u = [a.xyz[0] - v.xyz[0], a.xyz[1] - v.xyz[1], a.xyz[2] - v.xyz[2]]
  const w = [b.xyz[0] - v.xyz[0], b.xyz[1] - v.xyz[1], b.xyz[2] - v.xyz[2]]
  const d = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w))
  return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI
}

describe(`QE niche ibrav`, () => {
  it(`ibrav=-5 (trigonal, 3-fold ‖ z): equal lengths a, equal angles arccos(cd4)`, () => {
    const a = 6 * BOHR
    const L = parse_qe(`&SYSTEM\n ibrav = -5\n celldm(1) = 6\n celldm(4) = 0.4\n/\nATOMIC_POSITIONS crystal\nAl 0 0 0\n`)!.lattice!
    for (const len of [L.a, L.b, L.c]) expect(len).toBeCloseTo(a, 4)
    const target = Math.acos(0.4) * 180 / Math.PI
    for (const ang of [L.alpha, L.beta, L.gamma]) expect(ang).toBeCloseTo(target, 1)
  })

  it(`ibrav=-13 (base-centered monoclinic, axis b): volume a·b·c·sinβ/2`, () => {
    const a = 5 * BOHR, boa = 1.2, coa = 1.4, cb = 0.25
    const L = parse_qe(
      `&SYSTEM\n ibrav = -13\n celldm(1) = 5\n celldm(2) = 1.2\n celldm(3) = 1.4\n celldm(5) = 0.25\n/\nATOMIC_POSITIONS crystal\nAl 0 0 0\n`,
    )!.lattice!
    const vol = a * (boa * a) * (coa * a) * Math.sqrt(1 - cb * cb) / 2
    expect(L.volume).toBeCloseTo(vol, 3)
  })
})

describe(`ORCA internal coordinates (* int)`, () => {
  it(`water: O–H = 0.96 Å, H–O–H = 104.5°`, () => {
    const inp = `! B3LYP\n* int 0 1\n  O  0 0 0  0.0   0.0   0.0\n  H  1 0 0  0.96  0.0   0.0\n  H  1 2 0  0.96  104.5 0.0\n*\n`
    const s = parse_orca(inp)!
    expect(s.sites).toHaveLength(3)
    expect(s.sites.map((x) => x.species[0].element)).toEqual([`O`, `H`, `H`])
    expect(dist(s.sites[0], s.sites[1])).toBeCloseTo(0.96, 4)
    expect(dist(s.sites[0], s.sites[2])).toBeCloseTo(0.96, 4)
    expect(angle(s.sites[1], s.sites[0], s.sites[2])).toBeCloseTo(104.5, 2)
  })
})

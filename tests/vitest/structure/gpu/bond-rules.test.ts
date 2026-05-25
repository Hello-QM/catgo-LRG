import { describe, it, expect } from 'vitest'
import { encode_bond_rules, type BondDistanceRuleLike } from '$lib/structure/gpu/bond-rules'
import type { Site } from '$lib/structure'

// Minimal Site factory: only species[0].element is read by encode_bond_rules.
const site = (element: string): Site =>
  ({ species: [{ element, occu: 1, oxidation_state: 0 }], xyz: [0, 0, 0], abc: [0, 0, 0], label: element }) as unknown as Site

describe(`encode_bond_rules`, () => {
  it(`no rules ⇒ rule_count 0 and an empty rules buffer (no filtering)`, () => {
    const out = encode_bond_rules([site(`Ti`), site(`O`)], [])
    expect(out.rule_count).toBe(0)
    expect(out.rules.length).toBe(0)
    // One element id per site.
    expect(out.elem_ids.length).toBe(2)
  })

  it(`per-atom ids share the mapping with the rule ids`, () => {
    const sites = [site(`Ti`), site(`O`), site(`Ti`)]
    const rules: BondDistanceRuleLike[] = [
      { element_1: `O`, element_2: `Ti`, min_dist: 1.5, max_dist: 2.2 },
    ]
    const out = encode_bond_rules(sites, rules)
    // Ti and O each get a stable id; the two Ti sites share one id.
    expect(out.elem_ids[0]).toBe(out.elem_ids[2]) // both Ti
    expect(out.elem_ids[0]).not.toBe(out.elem_ids[1]) // Ti != O
    expect(out.rule_count).toBe(1)
    // Rule pair is SORTED (id_a ≤ id_b), matching [e1,e2].sort() in visibility.ts.
    const id_a = out.rules[0]
    const id_b = out.rules[1]
    expect(id_a).toBeLessThanOrEqual(id_b)
    // The two rule ids are exactly the Ti and O atom ids (order-independent).
    const ti = out.elem_ids[0]
    const o = out.elem_ids[1]
    expect(new Set([id_a, id_b])).toEqual(new Set([ti, o]))
    // min/max preserved.
    expect(out.rules[2]).toBeCloseTo(1.5, 6)
    expect(out.rules[3]).toBeCloseTo(2.2, 6)
  })

  it(`sorts the pair regardless of element_1/element_2 order`, () => {
    const sites = [site(`Ti`), site(`O`)]
    const fwd = encode_bond_rules(sites, [
      { element_1: `Ti`, element_2: `O`, min_dist: 1, max_dist: 2 },
    ])
    const rev = encode_bond_rules(sites, [
      { element_1: `O`, element_2: `Ti`, min_dist: 1, max_dist: 2 },
    ])
    // Same site order ⇒ same id mapping ⇒ identical sorted (id_a,id_b).
    expect([fwd.rules[0], fwd.rules[1]]).toEqual([rev.rules[0], rev.rules[1]])
    expect(fwd.rules[0]).toBeLessThanOrEqual(fwd.rules[1])
  })

  it(`a rule element absent from the structure still encodes (just never matches)`, () => {
    const out = encode_bond_rules([site(`Ti`), site(`O`)], [
      { element_1: `Fe`, element_2: `O`, min_dist: 1, max_dist: 2 },
    ])
    expect(out.rule_count).toBe(1)
    // Fe gets an id; since no atom carries it, the rule's id pair contains an id
    // that's NOT among the per-atom ids ⇒ no atom pair ever keys to this rule.
    const atom_ids = new Set(out.elem_ids)
    const rule_ids = [out.rules[0], out.rules[1]]
    expect(rule_ids.some((id) => !atom_ids.has(id))).toBe(true)
    expect(out.elem_ids.length).toBe(2)
  })
})

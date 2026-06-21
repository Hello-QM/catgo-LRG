// Headless unit tests for adsorbate bond-order perception.
//
// STEP 1 (TDD): these are written against the public API of two pure modules
// that do not exist yet — they must fail to compile/run until the modules in
// src/lib/structure/bonding/{fragment,bond-orders}.ts are implemented (STEP 2).
//
// DOMAIN: CatGo structures are a metal slab + a small organic adsorbate. Bond
// orders must be perceived ONLY on the extracted molecular fragment; the slab
// stays single sticks, and metal-adsorbate binding bonds are never ordered.

import type { BondPair, ElementSymbol, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import type { PymatgenStructure, Site } from '$lib/structure'
import { get_bond_key } from '$lib/structure/bonding'
import { isolate_adsorbate_fragments } from '$lib/structure/bonding/fragment'
import {
  ib_seq,
  is_aromatic,
  nb_from_order,
  perceive_adsorbate_orders,
  round_half_even,
} from '$lib/structure/bonding/bond-orders'
import { describe, expect, test } from 'vitest'

// --- test helpers -----------------------------------------------------------

function make_site(xyz: Vec3, element: string): Site {
  return {
    xyz,
    abc: [0, 0, 0],
    species: [{ element: element as ElementSymbol, occu: 1, oxidation_state: 0 }],
    label: element,
    properties: {},
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

// Build a BondPair from two site indices, reading positions from `sites`.
// jimage defaults to the intra-cell [0,0,0].
function bond(
  sites: Site[],
  i: number,
  j: number,
  jimage: [number, number, number] = [0, 0, 0],
): BondPair {
  return {
    pos_1: sites[i].xyz,
    pos_2: sites[j].xyz,
    site_idx_1: i,
    site_idx_2: j,
    bond_length: dist(sites[i].xyz, sites[j].xyz),
    strength: 1,
    transform_matrix: new Float32Array(16),
    jimage,
  }
}

const NO_LATTICE: Matrix3x3 | null = null

function as_structure(
  sites: Site[],
  lattice: Matrix3x3 | null = null,
): PymatgenStructure {
  const base = { sites, charge: 0 }
  if (lattice === null) {
    // a molecule has no lattice; cast for the test (perceive_* tolerates it)
    return base as unknown as PymatgenStructure
  }
  return {
    ...base,
    lattice: {
      matrix: lattice,
      pbc: [true, true, true],
      a: lattice[0][0],
      b: lattice[1][1],
      c: lattice[2][2],
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: lattice[0][0] * lattice[1][1] * lattice[2][2],
    },
  }
}

// Order lookup for a bond, keyed exactly like the renderer's shadow-sync.
function order_of(
  orders: Map<string, number>,
  i: number,
  j: number,
  jimage: [number, number, number] = [0, 0, 0],
): number {
  return orders.get(get_bond_key(i, j, jimage)) ?? 1
}

// --- catrender parity (nb_from_order / ib_seq / aromatic window) ------------

describe(`catrender parity helpers`, () => {
  test(`round_half_even (banker's rounding)`, () => {
    expect(round_half_even(0.5)).toBe(0)
    expect(round_half_even(1.5)).toBe(2)
    expect(round_half_even(2.5)).toBe(2)
    expect(round_half_even(3.5)).toBe(4)
    expect(round_half_even(2.4)).toBe(2)
    expect(round_half_even(2.6)).toBe(3)
  })

  test(`nb_from_order = max(1, round_half_even(bo)) when enabled`, () => {
    expect(nb_from_order(1.0, true)).toBe(1)
    expect(nb_from_order(1.5, true)).toBe(2) // round half→even
    expect(nb_from_order(2.0, true)).toBe(2)
    expect(nb_from_order(3.0, true)).toBe(3)
    // disabled collapses everything to a single stick
    expect(nb_from_order(3.0, false)).toBe(1)
  })

  test(`ib_seq = range(-nb+1, nb, 2)`, () => {
    expect(ib_seq(1)).toEqual([0])
    expect(ib_seq(2)).toEqual([-1, 1])
    expect(ib_seq(3)).toEqual([-2, 0, 2])
  })

  test(`aromatic window 1.3 < bo < 1.7`, () => {
    expect(is_aromatic(1.5)).toBe(true)
    expect(is_aromatic(1.3)).toBe(false)
    expect(is_aromatic(1.7)).toBe(false)
    expect(is_aromatic(2.0)).toBe(false)
  })
})

// --- perception on isolated gas-phase fragments -----------------------------

describe(`perceive_adsorbate_orders — gas-phase molecules`, () => {
  test(`CO is a triple bond`, () => {
    const sites = [
      make_site([0, 0, 0], `C`),
      make_site([1.13, 0, 0], `O`),
    ]
    const pairs = [bond(sites, 0, 1)]
    const orders = perceive_adsorbate_orders(pairs, as_structure(sites, NO_LATTICE))
    expect(order_of(orders, 0, 1)).toBe(3)
  })

  test(`OH is a single bond`, () => {
    const sites = [
      make_site([0, 0, 0], `O`),
      make_site([0.97, 0, 0], `H`),
    ]
    const pairs = [bond(sites, 0, 1)]
    const orders = perceive_adsorbate_orders(pairs, as_structure(sites, NO_LATTICE))
    expect(order_of(orders, 0, 1)).toBe(1)
  })

  test(`CH3 — all C-H single bonds`, () => {
    // pyramidal-ish methyl
    const sites = [
      make_site([0, 0, 0], `C`),
      make_site([1.09, 0, 0], `H`),
      make_site([-0.36, 1.03, 0], `H`),
      make_site([-0.36, -0.51, 0.89], `H`),
    ]
    const pairs = [bond(sites, 0, 1), bond(sites, 0, 2), bond(sites, 0, 3)]
    const orders = perceive_adsorbate_orders(pairs, as_structure(sites, NO_LATTICE))
    expect(order_of(orders, 0, 1)).toBe(1)
    expect(order_of(orders, 0, 2)).toBe(1)
    expect(order_of(orders, 0, 3)).toBe(1)
  })

  test(`formate HCOO — one C=O (~2) and one resonant C-O (~1.5)`, () => {
    // C at origin; two oxygens at carboxylate-ish lengths; one H on C.
    // O1 short (carbonyl-ish 1.25), O2 longer (1.30) — both terminal.
    const sites = [
      make_site([0, 0, 0], `C`), // 0
      make_site([1.10, 0, 0], `H`), // 1
      make_site([-0.70, 1.05, 0], `O`), // 2  ~1.26 Å
      make_site([-0.70, -1.10, 0], `O`), // 3  ~1.30 Å
    ]
    const pairs = [bond(sites, 0, 1), bond(sites, 0, 2), bond(sites, 0, 3)]
    const orders = perceive_adsorbate_orders(pairs, as_structure(sites, NO_LATTICE))
    // C-H stays single
    expect(order_of(orders, 0, 1)).toBe(1)
    // the two C-O orders: one double (carbonyl) + one resonant/single.
    const co1 = order_of(orders, 0, 2)
    const co2 = order_of(orders, 0, 3)
    const co_orders = [co1, co2].sort((a, b) => a - b)
    // at least one C=O perceived (order >= 2 once)
    expect(co_orders[1]).toBeGreaterThanOrEqual(1.5)
    // not both triple — carboxylate carbon can't carry two triples
    expect(co_orders[1]).toBeLessThanOrEqual(2)
    // the lower of the two is a single/resonant C-O
    expect(co_orders[0]).toBeGreaterThanOrEqual(1)
    expect(co_orders[0]).toBeLessThanOrEqual(1.5)
  })

  test(`CO2 (O=C=O) — two clean C=O doubles, not carboxylate resonance`, () => {
    // linear CO2, C-O ~1.16 Å each. The carbon has ONLY the two terminal
    // oxygens as neighbours (no H / other substituent), so the carboxylate
    // resonance rule must NOT fire — both bonds are full doubles.
    const sites = [
      make_site([0, 0, 0], `C`), // 0
      make_site([1.16, 0, 0], `O`), // 1
      make_site([-1.16, 0, 0], `O`), // 2
    ]
    const pairs = [bond(sites, 0, 1), bond(sites, 0, 2)]
    const orders = perceive_adsorbate_orders(pairs, as_structure(sites, NO_LATTICE))
    expect(order_of(orders, 0, 1)).toBe(2.0)
    expect(order_of(orders, 0, 2)).toBe(2.0)
  })

  test(`formate HCOO- regression — carboxylate carbon stays resonant 1.5/1.5`, () => {
    // C bonded to two carbonyl-range O + one H → true carboxylate: the carbon
    // bears a non-carbonyl neighbour (H), so resonance DOES apply → 1.5/1.5.
    const sites = [
      make_site([0, 0, 0], `C`), // 0
      make_site([1.10, 0, 0], `H`), // 1
      make_site([-0.70, 1.05, 0], `O`), // 2  ~1.26 Å
      make_site([-0.70, -1.05, 0], `O`), // 3  ~1.26 Å
    ]
    const pairs = [bond(sites, 0, 1), bond(sites, 0, 2), bond(sites, 0, 3)]
    const orders = perceive_adsorbate_orders(pairs, as_structure(sites, NO_LATTICE))
    expect(order_of(orders, 0, 1)).toBe(1) // C-H single
    expect(order_of(orders, 0, 2)).toBe(1.5) // resonant C-O
    expect(order_of(orders, 0, 3)).toBe(1.5) // resonant C-O
  })

  test(`formic acid HCOOH — carbonyl C=O double, hydroxyl C-O single`, () => {
    // C(0)=O(2) carbonyl ~1.21; C(0)-O(3)-H(4) hydroxyl ~1.34; H(1) on C.
    const sites = [
      make_site([0, 0, 0], `C`), // 0
      make_site([1.09, 0, 0], `H`), // 1
      make_site([-0.60, 1.05, 0], `O`), // 2 carbonyl, terminal ~1.21
      make_site([-0.65, -1.18, 0], `O`), // 3 hydroxyl ~1.35
      make_site([0.10, -1.85, 0], `H`), // 4 on O3
    ]
    const pairs = [
      bond(sites, 0, 1),
      bond(sites, 0, 2),
      bond(sites, 0, 3),
      bond(sites, 3, 4),
    ]
    const orders = perceive_adsorbate_orders(pairs, as_structure(sites, NO_LATTICE))
    expect(order_of(orders, 0, 1)).toBe(1) // C-H
    expect(order_of(orders, 0, 2)).toBe(2) // carbonyl C=O (terminal O)
    expect(order_of(orders, 0, 3)).toBe(1) // hydroxyl C-O
    expect(order_of(orders, 3, 4)).toBe(1) // O-H
  })

  test(`benzene — all six ring bonds aromatic (1.5, within window)`, () => {
    // planar hexagon, C-C ~1.39, plus 6 C-H spokes
    const R = 1.39
    const ring: Site[] = []
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k
      ring.push(make_site([R * Math.cos(a), R * Math.sin(a), 0], `C`))
    }
    const hs: Site[] = []
    const Rh = R + 1.08
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k
      hs.push(make_site([Rh * Math.cos(a), Rh * Math.sin(a), 0], `H`))
    }
    const sites = [...ring, ...hs] // 0..5 ring, 6..11 H
    const pairs: BondPair[] = []
    for (let k = 0; k < 6; k++) pairs.push(bond(sites, k, (k + 1) % 6)) // ring
    for (let k = 0; k < 6; k++) pairs.push(bond(sites, k, 6 + k)) // C-H
    const orders = perceive_adsorbate_orders(pairs, as_structure(sites, NO_LATTICE))
    for (let k = 0; k < 6; k++) {
      const o = order_of(orders, k, (k + 1) % 6)
      expect(is_aromatic(o)).toBe(true)
      expect(o).toBeCloseTo(1.5, 5)
    }
    // C-H spokes single
    for (let k = 0; k < 6; k++) expect(order_of(orders, k, 6 + k)).toBe(1)
  })
})

// --- fragment extraction ----------------------------------------------------

describe(`isolate_adsorbate_fragments`, () => {
  const lattice: Matrix3x3 = [[12, 0, 0], [0, 12, 0], [0, 0, 20]]

  test(`CO adsorbate on a small Pt cluster extracts only C,O (metal excluded)`, () => {
    // 4 Pt atoms forming a tiny cluster near z=0; C bound on top, O above C.
    const sites = [
      make_site([0, 0, 0], `Pt`), // 0
      make_site([2.7, 0, 0], `Pt`), // 1
      make_site([1.35, 2.3, 0], `Pt`), // 2
      make_site([1.35, 0.8, 2.2], `Pt`), // 3
      make_site([1.35, 0.8, 4.1], `C`), // 4  C bound to Pt3
      make_site([1.35, 0.8, 5.25], `O`), // 5  O above C (~1.15)
    ]
    const pairs = [
      bond(sites, 0, 1), // Pt-Pt
      bond(sites, 0, 2),
      bond(sites, 1, 2),
      bond(sites, 0, 3),
      bond(sites, 1, 3),
      bond(sites, 2, 3),
      bond(sites, 3, 4), // Pt-C binding bond (metal-adsorbate, must be cut)
      bond(sites, 4, 5), // C-O adsorbate bond
    ]
    const frags = isolate_adsorbate_fragments(pairs, sites, lattice)
    expect(frags.length).toBe(1)
    const f = frags[0]
    expect(new Set(f.site_indices)).toEqual(new Set([4, 5]))
    // exactly the one organic-organic edge, no Pt-C
    expect(f.local_bonds.length).toBe(1)
    const e = f.local_bonds[0]
    expect(new Set([e.a_global, e.b_global])).toEqual(new Set([4, 5]))

    // and order perception leaves Pt-C at 1, gives C-O triple
    const orders = perceive_adsorbate_orders(pairs, as_structure(sites, lattice))
    expect(order_of(orders, 3, 4)).toBe(1) // Pt-C binding stays single stick
    expect(order_of(orders, 4, 5)).toBe(3) // free C-O end → triple
  })

  test(`two separate adsorbates → two fragments`, () => {
    // an OH and a CO far apart, both on the same (implicit) slab
    const sites = [
      make_site([0, 0, 0], `O`), // 0
      make_site([0.97, 0, 0], `H`), // 1
      make_site([6, 6, 0], `C`), // 2
      make_site([6, 6, 1.13], `O`), // 3
    ]
    const pairs = [bond(sites, 0, 1), bond(sites, 2, 3)]
    const frags = isolate_adsorbate_fragments(pairs, sites, lattice)
    expect(frags.length).toBe(2)
    const sets = frags.map((f) => new Set(f.site_indices))
    expect(sets).toContainEqual(new Set([0, 1]))
    expect(sets).toContainEqual(new Set([2, 3]))
  })

  test(`gas-phase molecule (no lattice) → one whole fragment`, () => {
    const sites = [
      make_site([0, 0, 0], `C`),
      make_site([1.13, 0, 0], `O`),
    ]
    const pairs = [bond(sites, 0, 1)]
    const frags = isolate_adsorbate_fragments(pairs, sites, null)
    expect(frags.length).toBe(1)
    expect(new Set(frags[0].site_indices)).toEqual(new Set([0, 1]))
  })

  test(`graphene flake — periodic-spanning large sheet excluded as slab`, () => {
    // Build a periodic carbon honeycomb chain that wraps across the cell with
    // cross-cell (jimage != 0) edges and exceeds MAX_FRAGMENT_ATOMS (64).
    const small: Matrix3x3 = [[2.46, 0, 0], [0, 2.46, 0], [0, 0, 20]]
    const sites: Site[] = []
    const N = 80
    for (let k = 0; k < N; k++) {
      sites.push(make_site([(k % 4) * 0.6, (k % 3) * 0.6, 0], `C`))
    }
    const pairs: BondPair[] = []
    for (let k = 0; k < N - 1; k++) pairs.push(bond(sites, k, k + 1))
    // wrap-around cross-cell edge to close the periodic sheet
    pairs.push(bond(sites, N - 1, 0, [1, 0, 0]))
    const frags = isolate_adsorbate_fragments(pairs, sites, small)
    expect(frags.length).toBe(0) // too big + periodic-spanning → not a molecule
  })
})

// --- robustness -------------------------------------------------------------

describe(`malformed / empty input guard`, () => {
  test(`empty bond list does not throw and yields no fragments / empty orders`, () => {
    const sites = [make_site([0, 0, 0], `C`)]
    expect(() => isolate_adsorbate_fragments([], sites, null)).not.toThrow()
    expect(isolate_adsorbate_fragments([], sites, null)).toEqual([])
    const orders = perceive_adsorbate_orders([], as_structure(sites, null))
    expect(orders.size).toBe(0)
  })

  test(`bond referencing an out-of-range / missing site is ignored, no throw`, () => {
    const sites = [make_site([0, 0, 0], `C`), make_site([1.13, 0, 0], `O`)]
    const bad: BondPair = {
      pos_1: [0, 0, 0],
      pos_2: [0, 0, 0],
      site_idx_1: 0,
      site_idx_2: 99, // missing
      bond_length: 1,
      strength: 1,
      transform_matrix: new Float32Array(16),
      jimage: [0, 0, 0],
    }
    expect(() => perceive_adsorbate_orders([bad], as_structure(sites, null))).not
      .toThrow()
  })

  test(`a fully metallic structure yields no fragments`, () => {
    const sites = [
      make_site([0, 0, 0], `Pt`),
      make_site([2.7, 0, 0], `Pt`),
    ]
    const pairs = [bond(sites, 0, 1)]
    expect(isolate_adsorbate_fragments(pairs, sites, [[12, 0, 0], [0, 12, 0], [
      0,
      0,
      12,
    ]])).toEqual([])
  })
})

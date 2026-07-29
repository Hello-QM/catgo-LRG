import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { detect_bonds_reference, type RefBondOptions } from '$lib/structure/gpu/bond-detect-reference'
import { compute_bonds_sync } from '$lib/structure/workers/bond-worker-api'
import { pack_positions, pack_lattice } from '$lib/structure/gpu/frame-buffers'
import { build_atom_radii } from '$lib/structure/gpu/radius-lut'
import { parse_cif } from '$lib/structure/parsers/cif'
import type { PymatgenStructure } from '$lib/structure'

const OPTS: RefBondOptions = {
  tolerance: 0.45,
  max_bond_dist: 3.0,
  min_bond_dist: 0.1,
}

describe(`detect_bonds_reference`, () => {
  it(`finds a single bond between two close atoms (non-periodic)`, () => {
    const pos = new Float32Array([0, 0, 0, 1.0, 0, 0])
    const radii = new Float32Array([0.76, 0.76])
    const bonds = detect_bonds_reference(pos, new Float32Array(9), radii, OPTS)
    expect(bonds).toHaveLength(1)
    expect(bonds[0]).toMatchObject({ a: 0, b: 1, jimage: [0, 0, 0] })
  })

  it(`rejects atoms beyond the covalent-radii sum plus tolerance`, () => {
    const pos = new Float32Array([0, 0, 0, 2.0, 0, 0])
    const radii = new Float32Array([0.76, 0.76])
    expect(detect_bonds_reference(pos, new Float32Array(9), radii, OPTS)).toHaveLength(0)
  })

  it(`uses a fixed absolute tolerance rather than multiplicative scale`, () => {
    const pos = new Float32Array([0, 0, 0, 1.4, 0, 0])
    const radii = new Float32Array([0.5, 0.5])
    // Fixed-pad keeps this contact: 1.4 Å < 0.5 + 0.5 + 0.45 = 1.45 Å.
    // A 1.2 multiplicative scale would incorrectly reject it at 1.2 Å.
    expect(detect_bonds_reference(pos, new Float32Array(9), radii, OPTS)).toHaveLength(1)
  })

  it(`rejects beyond max_bond_dist even if within radius sum`, () => {
    const pos = new Float32Array([0, 0, 0, 2.9, 0, 0])
    const radii = new Float32Array([2.0, 2.0])
    const opts = { ...OPTS, max_bond_dist: 2.0 }
    expect(detect_bonds_reference(pos, new Float32Array(9), radii, opts)).toHaveLength(0)
  })

  it(`finds a minimum-image bond across a periodic boundary`, () => {
    // cubic 5 Å cell; x=0.2 and x=4.9 are 4.7 apart direct, 0.3 across boundary
    const pos = new Float32Array([0.2, 0, 0, 4.9, 0, 0])
    const radii = new Float32Array([0.76, 0.76])
    const lat = new Float32Array([5, 0, 0, 0, 5, 0, 0, 0, 5])
    const bonds = detect_bonds_reference(pos, lat, radii, {
      ...OPTS,
      max_bond_dist: 3,
      min_bond_dist: 0.1,
    })
    expect(bonds).toHaveLength(1)
    // Convention: jimage applied to b (b + jimage·L) reaches the min image of a.
    // b at 4.9, a at 0.2: dx = b-a = 4.7; shifting b by -a (na=-1 -> -5) gives
    // displacement -0.3, the shortest. So jimage = [-1,0,0].
    expect(bonds[0].jimage).toEqual([-1, 0, 0])
    // Lock the minimum-image distance the WGSL shader must reproduce: 5 - 4.7 = 0.3 Å.
    expect(bonds[0].dist).toBeCloseTo(0.3)
  })

  it(`drops coincident atoms (below min_bond_dist)`, () => {
    const pos = new Float32Array([0, 0, 0, 0.01, 0, 0])
    const radii = new Float32Array([0.76, 0.76])
    expect(detect_bonds_reference(pos, new Float32Array(9), radii, OPTS)).toHaveLength(0)
  })

  it(`matches the production CPU detector on a small periodic structure (oracle cross-check)`, () => {
    // Cubic 6 Å cell with a few common (C/H/O/N) atoms so build_atom_radii's
    // 1.0 Å fallback never triggers (which would diverge from the CPU path).
    const struct = make_test_structure()

    const cpu = compute_bonds_sync(struct, `atom_radii`, {
      tolerance: 0.45,
      max_bond_dist: 3,
      min_bond_dist: 0.1,
    })
    // compute_bonds_sync returns null when Rust WASM is not initialized in the
    // vitest env. Skip the comparison but keep the test in place.
    if (cpu == null) return

    const ref = detect_bonds_reference(
      pack_positions(struct.sites),
      pack_lattice(struct.lattice),
      build_atom_radii(struct.sites),
      OPTS,
    )
    const key = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`
    const cpu_set = new Set(cpu.map((b) => key(b.site_idx_1, b.site_idx_2)))
    const ref_set = new Set(ref.map((b) => key(b.a, b.b)))

    expect([...ref_set].sort()).toEqual([...cpu_set].sort())
  })

  it(`preserves LiFePO4 octahedral Fe–O coordination from the pre-change viewer`, () => {
    const structure = parse_cif(
      readFileSync(resolve(`src/site/structures/LiFePO4.cif`), `utf8`),
    ) as PymatgenStructure
    const bonds = detect_bonds_reference(
      pack_positions(structure.sites),
      pack_lattice(structure.lattice),
      build_atom_radii(structure.sites),
      OPTS,
    )
    const fe_o = bonds.filter(({ a, b }) => {
      const pair = [
        structure.sites[a].species[0]?.element,
        structure.sites[b].species[0]?.element,
      ].sort().join(`-`)
      return pair === `Fe-O`
    })
    const fe_degree = new Map<number, number>()
    for (const bond of fe_o) {
      const fe_idx = structure.sites[bond.a].species[0]?.element === `Fe`
        ? bond.a
        : bond.b
      fe_degree.set(fe_idx, (fe_degree.get(fe_idx) ?? 0) + 1)
    }

    expect(bonds).toHaveLength(72)
    expect(fe_o).toHaveLength(24)
    expect([...fe_degree.values()].sort()).toEqual([6, 6, 6, 6])
  })
})

function make_test_structure(): PymatgenStructure {
  const a = 6
  const matrix: [[number, number, number], [number, number, number], [number, number, number]] = [
    [a, 0, 0],
    [0, a, 0],
    [0, 0, a],
  ]
  // A small molecule-like cluster (C, O, two H, N) with realistic bond lengths.
  const coords: Array<{ el: string; xyz: [number, number, number] }> = [
    { el: `C`, xyz: [1.0, 1.0, 1.0] },
    { el: `O`, xyz: [2.2, 1.0, 1.0] }, // C-O ~1.2
    { el: `H`, xyz: [1.0, 2.0, 1.0] }, // C-H ~1.0 (close to C)
    { el: `N`, xyz: [1.0, 1.0, 2.45] }, // C-N ~1.45
  ]
  const sites = coords.map(({ el, xyz }) => ({
    species: [{ element: el as never, occu: 1 }],
    abc: [xyz[0] / a, xyz[1] / a, xyz[2] / a] as [number, number, number],
    xyz,
    label: el,
    properties: {},
  }))
  return {
    lattice: {
      matrix,
      pbc: [true, true, true],
      volume: a * a * a,
      a,
      b: a,
      c: a,
      alpha: 90,
      beta: 90,
      gamma: 90,
    },
    sites,
  } as PymatgenStructure
}

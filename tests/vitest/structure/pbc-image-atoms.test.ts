/**
 * Unit tests for `build_sites_to_draw` — Phase 7a.
 *
 * Mirrors the cases from `crystal_toolkit/renderables/structuregraph.py`
 * `_get_sites_to_draw` so that a reader familiar with the reference can
 * cross-check expectations.
 */

import { describe, expect, it } from 'vitest'
import {
	build_sites_to_draw,
	make_image_site_key,
	type BondConnectivityEntry,
} from '$lib/structure/pbc-image-atoms'
import type { AnyStructure, PymatgenLattice, Site } from '$lib'

function fake_site(abc: [number, number, number]): Site {
	return {
		species: [{ element: 'X' as any, occu: 1, oxidation_state: 0 }],
		abc,
		xyz: [0, 0, 0],
		label: 'X',
		properties: {},
	} as unknown as Site
}

function cubic_lattice(a: number = 1.0): PymatgenLattice {
	return {
		matrix: [
			[a, 0, 0],
			[0, a, 0],
			[0, 0, a],
		],
		pbc: [true, true, true],
		volume: a * a * a,
		a,
		b: a,
		c: a,
		alpha: 90,
		beta: 90,
		gamma: 90,
	} as unknown as PymatgenLattice
}

function periodic_structure(
	abc_list: ReadonlyArray<[number, number, number]>,
): AnyStructure {
	return {
		sites: abc_list.map(fake_site),
		lattice: cubic_lattice(),
	} as unknown as AnyStructure
}

function molecule_structure(
	abc_list: ReadonlyArray<[number, number, number]>,
): AnyStructure {
	return { sites: abc_list.map(fake_site) } as unknown as AnyStructure
}

describe(`build_sites_to_draw`, () => {
	it(`seeds the home cell for every site even without expansions`, () => {
		const structure = periodic_structure([
			[0.5, 0.5, 0.5],
			[0.25, 0.25, 0.25],
		])
		const out = build_sites_to_draw(structure, [], {
			draw_image_atoms: false,
			bonded_sites_outside_unit_cell: false,
		})
		expect(out.size).toBe(2)
		expect(out.has(make_image_site_key(0, [0, 0, 0]))).toBe(true)
		expect(out.has(make_image_site_key(1, [0, 0, 0]))).toBe(true)
	})

	it(`emits 8 entries for a single corner atom at the origin (7 images + home)`, () => {
		const structure = periodic_structure([[0, 0, 0]])
		const out = build_sites_to_draw(structure, [], {
			draw_image_atoms: true,
		})
		expect(out.size).toBe(8)
		const expected: Array<[number, number, number]> = [
			[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
			[1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
		]
		for (const j of expected) {
			expect(out.has(make_image_site_key(0, j))).toBe(true)
		}
	})

	it(`emits 8 entries for a single corner atom at (1, 1, 1) — all in -1 direction`, () => {
		const structure = periodic_structure([[1, 1, 1]])
		const out = build_sites_to_draw(structure, [], {
			draw_image_atoms: true,
		})
		expect(out.size).toBe(8)
		expect(out.has(make_image_site_key(0, [0, 0, 0]))).toBe(true)
		expect(out.has(make_image_site_key(0, [-1, -1, -1]))).toBe(true)
		expect(out.has(make_image_site_key(0, [-1, 0, 0]))).toBe(true)
	})

	it(`yields only the home entry for a body-centered atom (no boundary axes)`, () => {
		const structure = periodic_structure([[0.5, 0.5, 0.5]])
		const out = build_sites_to_draw(structure, [], {
			draw_image_atoms: true,
		})
		expect(out.size).toBe(1)
		expect(out.has(make_image_site_key(0, [0, 0, 0]))).toBe(true)
	})

	it(`yields 2 entries for a face atom with one boundary axis`, () => {
		// frac (0, 0.5, 0.5): only axis 0 is on the boundary.
		const structure = periodic_structure([[0, 0.5, 0.5]])
		const out = build_sites_to_draw(structure, [], {
			draw_image_atoms: true,
		})
		expect(out.size).toBe(2)
		expect(out.has(make_image_site_key(0, [0, 0, 0]))).toBe(true)
		expect(out.has(make_image_site_key(0, [1, 0, 0]))).toBe(true)
	})

	it(`yields 4 entries for an edge atom with two boundary axes (non-empty subsets of size 1, 2)`, () => {
		// frac (0, 0, 0.5): axes 0, 1 near zero — 3 image entries (subsets of size 1, 1, 2).
		const structure = periodic_structure([[0, 0, 0.5]])
		const out = build_sites_to_draw(structure, [], {
			draw_image_atoms: true,
		})
		expect(out.size).toBe(4)
		expect(out.has(make_image_site_key(0, [0, 0, 0]))).toBe(true)
		expect(out.has(make_image_site_key(0, [1, 0, 0]))).toBe(true)
		expect(out.has(make_image_site_key(0, [0, 1, 0]))).toBe(true)
		expect(out.has(make_image_site_key(0, [1, 1, 0]))).toBe(true)
	})

	it(`mixes +1 and -1 expansions on different axes`, () => {
		// frac (0, 1, 0.5): axis 0 near zero (+1), axis 1 near one (-1), axis 2 mid.
		// Expected: home + (1,0,0) + (0,-1,0). Crystaltoolkit does NOT mix +1 and -1
		// directions in the same image (no (1,-1,0)) — verify we match.
		const structure = periodic_structure([[0, 1, 0.5]])
		const out = build_sites_to_draw(structure, [], {
			draw_image_atoms: true,
		})
		expect(out.size).toBe(3)
		expect(out.has(make_image_site_key(0, [0, 0, 0]))).toBe(true)
		expect(out.has(make_image_site_key(0, [1, 0, 0]))).toBe(true)
		expect(out.has(make_image_site_key(0, [0, -1, 0]))).toBe(true)
		expect(out.has(make_image_site_key(0, [1, -1, 0]))).toBe(false)
	})

	it(`respects edge_tolerance`, () => {
		const structure = periodic_structure([[0.04, 0.5, 0.5]])
		// Tight tolerance: 0.04 outside 0.01 → no images.
		const tight = build_sites_to_draw(structure, [], {
			draw_image_atoms: true,
			edge_tolerance: 0.01,
		})
		expect(tight.size).toBe(1)
		// Loose tolerance: 0.04 within 0.05 → +1 image on axis 0.
		const loose = build_sites_to_draw(structure, [], {
			draw_image_atoms: true,
			edge_tolerance: 0.05,
		})
		expect(loose.size).toBe(2)
	})

	it(`molecule (no lattice) yields only home entries even with draw_image_atoms=true`, () => {
		const mol = molecule_structure([[0, 0, 0], [0.1, 0.2, 0.3]])
		const out = build_sites_to_draw(mol, [], {
			draw_image_atoms: true,
			bonded_sites_outside_unit_cell: true,
		})
		expect(out.size).toBe(2)
		expect(out.has(make_image_site_key(0, [0, 0, 0]))).toBe(true)
		expect(out.has(make_image_site_key(1, [0, 0, 0]))).toBe(true)
	})

	describe(`bonded_sites_outside_unit_cell`, () => {
		it(`adds the cross-cell partner from each home-cell entry`, () => {
			// 2-atom cell with one cross-cell bond.
			const structure = periodic_structure([
				[0.5, 0.5, 0.5],
				[0.5, 0.5, 0.5],
			])
			const bonds: BondConnectivityEntry[] = [
				{ site_idx_1: 0, site_idx_2: 1, jimage: [1, 0, 0] },
			]
			const out = build_sites_to_draw(structure, bonds, {
				draw_image_atoms: false,
				bonded_sites_outside_unit_cell: true,
			})
			// Home: (0, [0,0,0]), (1, [0,0,0]).
			// From (0, [0,0,0]) walking bond → adds (1, [+1,0,0]).
			// From (1, [0,0,0]) walking bond (atom B path) → adds (0, [-1,0,0]).
			expect(out.size).toBe(4)
			expect(out.has(make_image_site_key(1, [1, 0, 0]))).toBe(true)
			expect(out.has(make_image_site_key(0, [-1, 0, 0]))).toBe(true)
		})

		it(`is a no-op when bond list is empty`, () => {
			const structure = periodic_structure([[0.5, 0.5, 0.5]])
			const out = build_sites_to_draw(structure, [], {
				draw_image_atoms: false,
				bonded_sites_outside_unit_cell: true,
			})
			expect(out.size).toBe(1)
		})

		it(`works in combination with image-atom expansion`, () => {
			// Atom 0 at corner → 7 image atoms + home = 8 entries.
			// Atom 1 at body center → 1 entry.
			// Bond (0, 1, [0,0,0]) — cell-internal.
			// From entries at (0, [+1,0,0]) etc., we'd add partner (1, [+1,0,0]) etc.
			const structure = periodic_structure([
				[0, 0, 0],
				[0.5, 0.5, 0.5],
			])
			const bonds: BondConnectivityEntry[] = [
				{ site_idx_1: 0, site_idx_2: 1, jimage: [0, 0, 0] },
			]
			const out = build_sites_to_draw(structure, bonds, {
				draw_image_atoms: true,
				bonded_sites_outside_unit_cell: true,
			})
			// Atom 0 has 8 entries (home + 7 images). Atom 1 starts with home.
			// Each of atom 0's 8 entries contributes one partner: (1, [jimage_of_entry]).
			// That's 8 distinct image atoms for atom 1 (one per atom-0 image).
			// Atom 1's home entry walks the bond back to atom 0 at [0,0,0] — already there.
			// Total: 8 (atom 0) + 8 (atom 1, one per atom-0 image) = 16.
			expect(out.size).toBe(16)
			expect(out.has(make_image_site_key(1, [1, 1, 1]))).toBe(true)
			expect(out.has(make_image_site_key(1, [0, 0, 0]))).toBe(true)
		})

		it(`handles asymmetric bond direction (entry on B side negates jimage)`, () => {
			// Bond is stored as (a=0, b=1, jimage=[+1,0,0]). When iterating from
			// the entry whose site_idx is atom 1, the partner (atom 0) lives in
			// the OPPOSITE cell — jimage must be negated.
			const structure = periodic_structure([
				[0.5, 0.5, 0.5],
				[0.5, 0.5, 0.5],
			])
			const bonds: BondConnectivityEntry[] = [
				{ site_idx_1: 0, site_idx_2: 1, jimage: [1, 0, 0] },
			]
			const out = build_sites_to_draw(structure, bonds, {
				draw_image_atoms: false,
				bonded_sites_outside_unit_cell: true,
			})
			expect(out.has(make_image_site_key(0, [-1, 0, 0]))).toBe(true)
			expect(out.has(make_image_site_key(0, [1, 0, 0]))).toBe(false)
		})

		it(`is one-shot (does not walk newly-added entries)`, () => {
			// Two cross-cell bonds chained: (0, 1, [+1,0,0]), (1, 0, [+1,0,0]).
			// Naively walking would extend recursively; we should snapshot and
			// stop after one round.
			const structure = periodic_structure([
				[0.5, 0.5, 0.5],
				[0.5, 0.5, 0.5],
			])
			const bonds: BondConnectivityEntry[] = [
				{ site_idx_1: 0, site_idx_2: 1, jimage: [1, 0, 0] },
				{ site_idx_1: 1, site_idx_2: 0, jimage: [1, 0, 0] },
			]
			const out = build_sites_to_draw(structure, bonds, {
				draw_image_atoms: false,
				bonded_sites_outside_unit_cell: true,
			})
			// Snapshot is just home cells (2 entries).
			// From (0, [0,0,0]):
			//   bond 0: (0,1,[+1,0,0]) → adds (1, [+1,0,0]).
			//   bond 1: (1,0,[+1,0,0]) — atom 0 is on the B side → adds (1, [-1,0,0]).
			// From (1, [0,0,0]):
			//   bond 0: atom 1 on B side → adds (0, [-1,0,0]).
			//   bond 1: (1,0,[+1,0,0]) → adds (0, [+1,0,0]).
			// Total: 6 entries.
			expect(out.size).toBe(6)
			// Newly added (1, [+1,0,0]) does NOT cause expansion to (0, [+2,0,0]).
			expect(out.has(make_image_site_key(0, [2, 0, 0]))).toBe(false)
		})
	})
})

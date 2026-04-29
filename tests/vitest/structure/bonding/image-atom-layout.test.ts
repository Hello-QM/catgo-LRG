/**
 * Unit tests for `build_image_atom_layout` — Phase 7b.
 *
 * The layout is a CSR mapping: `image_atom_i → [slot indices touching its
 * orig_idx]`. Home-cell entries (jimage_img = [0,0,0]) must be skipped to
 * avoid double-counting cell-internal bonds (Phase 4 already paints those).
 */

import { describe, expect, it } from 'vitest'
import {
	build_image_atom_layout,
	empty_image_atom_layout,
	image_atom_decorator_instance_count,
} from '$lib/structure/bonding/image-atom-layout'
import { BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import {
	make_image_site_key,
	type ImageSiteEntry,
	type ImageSiteKey,
} from '$lib/structure/pbc-image-atoms'

function home_only_sites(n_sites: number): Map<ImageSiteKey, ImageSiteEntry> {
	const m = new Map<ImageSiteKey, ImageSiteEntry>()
	for (let i = 0; i < n_sites; i++) {
		const j: [number, number, number] = [0, 0, 0]
		m.set(make_image_site_key(i, j), { site_idx: i, jimage_img: j })
	}
	return m
}

function add_image(
	m: Map<ImageSiteKey, ImageSiteEntry>,
	site_idx: number,
	jimage: [number, number, number],
): void {
	m.set(make_image_site_key(site_idx, jimage), {
		site_idx,
		jimage_img: jimage,
	})
}

describe(`build_image_atom_layout`, () => {
	it(`returns the empty layout when sites_to_draw has only home cells`, () => {
		const mgr = new BondManager()
		mgr.add_bond(0, 1)
		const out = build_image_atom_layout(home_only_sites(2), mgr)
		expect(out.n_image_atoms).toBe(0)
		expect(out.bonds_csr.length).toBe(0)
		expect(image_atom_decorator_instance_count(out)).toBe(0)
	})

	it(`returns the empty layout when bond manager is empty`, () => {
		const mgr = new BondManager()
		const sites = home_only_sites(2)
		add_image(sites, 0, [1, 0, 0])
		const out = build_image_atom_layout(sites, mgr)
		expect(out.n_image_atoms).toBe(1)
		expect(out.bonds_csr.length).toBe(0)
		expect(out.row_offsets[0]).toBe(0)
		expect(out.row_offsets[1]).toBe(0)
	})

	it(`emits a CSR slice per image atom listing its incident bond slots`, () => {
		// Atoms 0, 1, 2. Bonds: (0,1) at slot 0, (0,2) at slot 1.
		// Image atom for atom 0 at jimage [+1,0,0] should list slots [0, 1].
		const mgr = new BondManager()
		mgr.add_bond(0, 1)
		mgr.add_bond(0, 2)
		const sites = home_only_sites(3)
		add_image(sites, 0, [1, 0, 0])
		const out = build_image_atom_layout(sites, mgr)
		expect(out.n_image_atoms).toBe(1)
		expect(Array.from(out.orig_site_indices)).toEqual([0])
		expect(Array.from(out.jimage_offsets)).toEqual([1, 0, 0])
		expect(out.row_offsets[0]).toBe(0)
		expect(out.row_offsets[1]).toBe(2)
		expect(Array.from(out.bonds_csr).sort()).toEqual([0, 1])
		expect(image_atom_decorator_instance_count(out)).toBe(4)
	})

	it(`partitions multiple image atoms correctly`, () => {
		// Bonds: (0,1) at slot 0, (0,2) at slot 1, (1,2) at slot 2.
		// Image atom 0 → [+1,0,0]: bonds 0, 1.
		// Image atom 1 → [+1,0,0]: bonds 0, 2.
		const mgr = new BondManager()
		mgr.add_bond(0, 1)
		mgr.add_bond(0, 2)
		mgr.add_bond(1, 2)
		const sites = home_only_sites(3)
		add_image(sites, 0, [1, 0, 0])
		add_image(sites, 1, [1, 0, 0])
		const out = build_image_atom_layout(sites, mgr)
		expect(out.n_image_atoms).toBe(2)
		expect(out.row_offsets[0]).toBe(0)
		expect(out.row_offsets[1]).toBe(2)
		expect(out.row_offsets[2]).toBe(4)
		const slice_0 = Array.from(
			out.bonds_csr.subarray(out.row_offsets[0], out.row_offsets[1]),
		).sort()
		const slice_1 = Array.from(
			out.bonds_csr.subarray(out.row_offsets[1], out.row_offsets[2]),
		).sort()
		expect(slice_0).toEqual([0, 1])
		expect(slice_1).toEqual([0, 2])
	})

	it(`emits an empty CSR slice for an image atom of an unbonded site`, () => {
		// Atom 1 has no bonds; an image atom for site 1 should have row_offsets[1]==row_offsets[0].
		const mgr = new BondManager()
		mgr.add_bond(0, 2)
		const sites = home_only_sites(3)
		add_image(sites, 1, [1, 0, 0])
		const out = build_image_atom_layout(sites, mgr)
		expect(out.n_image_atoms).toBe(1)
		expect(out.row_offsets[0]).toBe(0)
		expect(out.row_offsets[1]).toBe(0)
		expect(out.bonds_csr.length).toBe(0)
	})

	it(`skips home-cell entries (jimage_img = [0,0,0]) to avoid double counting`, () => {
		const mgr = new BondManager()
		mgr.add_bond(0, 1)
		const sites = home_only_sites(2)
		add_image(sites, 0, [1, 0, 0])
		const out = build_image_atom_layout(sites, mgr)
		// Only the explicit non-home entry contributes a layout slot.
		expect(out.n_image_atoms).toBe(1)
		expect(Array.from(out.orig_site_indices)).toEqual([0])
	})

	it(`does not double-count self-bonds (a == b) in the inverted index`, () => {
		// Self-bond is unusual but should be incident to the atom exactly once.
		const mgr = new BondManager()
		mgr.add_bond(0, 0)
		const sites = home_only_sites(1)
		add_image(sites, 0, [1, 0, 0])
		const out = build_image_atom_layout(sites, mgr)
		expect(out.n_image_atoms).toBe(1)
		expect(out.row_offsets[1] - out.row_offsets[0]).toBe(1)
		expect(out.bonds_csr[0]).toBe(0)
	})

	it(`empty_image_atom_layout returns a singleton with valid invariants`, () => {
		const a = empty_image_atom_layout()
		const b = empty_image_atom_layout()
		expect(a).toBe(b)
		expect(a.n_image_atoms).toBe(0)
		expect(a.row_offsets.length).toBe(1)
		expect(a.row_offsets[0]).toBe(0)
		expect(a.bonds_csr.length).toBe(0)
	})

	it(`stays consistent across BondManager mutations (rebuild required)`, () => {
		const mgr = new BondManager()
		mgr.add_bond(0, 1)
		const sites = home_only_sites(3)
		add_image(sites, 0, [1, 0, 0])
		const out_before = build_image_atom_layout(sites, mgr)
		expect(out_before.bonds_csr.length).toBe(1)

		// Add a new bond touching atom 0.
		mgr.add_bond(0, 2)
		const out_after = build_image_atom_layout(sites, mgr)
		expect(out_after.bonds_csr.length).toBe(2)
		expect(Array.from(out_after.bonds_csr).sort()).toEqual([0, 1])
	})
})

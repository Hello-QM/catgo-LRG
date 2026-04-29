/**
 * Per-image-atom decorator layout for the bond renderer (Phase 7b).
 *
 * Built from the Phase-7a `sites_to_draw` set × a `BondManager`. Stored as
 * compressed-sparse-row: for each non-home image atom, the layout records
 * its anchor offset and a slice of `bonds_csr` listing every BondManager
 * slot touching its anchor atom. The renderer (Phase 7c) writes one
 * decorator instance per (image atom × incident bond) — anchored at
 * `pos_anchor + lattice·jimage_img` and oriented along the bond direction
 * after applying both the image-atom and the bond's jimage offsets.
 *
 * Home-cell entries (`jimage_img = [0, 0, 0]`) are NOT included — those are
 * rendered by the Phase 4 cell-internal pass; including them would
 * duplicate every intra-cell bond (plan §4.9). An image atom for a site
 * with zero bonds contributes a layout slot with an empty CSR slice
 * (zero decorator instances).
 *
 * Cost of build: O(bond_count + n_image_atoms × bonds_per_atom_avg). The
 * inverted bond index (atom_idx → slots) is rebuilt per call; callers
 * should memoize on `(BondManager.version, sites_to_draw ref)`.
 */

import type { BondManager } from './bond-manager.svelte'
import type { ImageSiteEntry, ImageSiteKey } from '../pbc-image-atoms'

export interface ImageAtomLayout {
	/** Number of non-home-cell image atoms in this layout. */
	n_image_atoms: number
	/**
	 * Lattice offset per image atom, interleaved as Int8 for cache efficiency:
	 * `[dx0, dy0, dz0, dx1, dy1, dz1, ...]`. Length = `3 * n_image_atoms`.
	 */
	jimage_offsets: Int8Array
	/** Anchor atom index per image atom in pre-ghost site space. Length = `n_image_atoms`. */
	orig_site_indices: Uint32Array
	/**
	 * CSR row offsets. `bonds_csr.subarray(row_offsets[i], row_offsets[i+1])`
	 * is the slice of bond slot indices for image atom `i`. Length =
	 * `n_image_atoms + 1`. `row_offsets[n_image_atoms]` equals
	 * `bonds_csr.length`.
	 */
	row_offsets: Uint32Array
	/** Flat array of BondManager slot indices, partitioned by `row_offsets`. */
	bonds_csr: Uint32Array
}

const EMPTY_LAYOUT: ImageAtomLayout = Object.freeze({
	n_image_atoms: 0,
	jimage_offsets: new Int8Array(0),
	orig_site_indices: new Uint32Array(0),
	row_offsets: new Uint32Array(1),
	bonds_csr: new Uint32Array(0),
}) as ImageAtomLayout

/** Singleton empty layout for the molecule / no-image-atoms path. */
export function empty_image_atom_layout(): ImageAtomLayout {
	return EMPTY_LAYOUT
}

export function build_image_atom_layout(
	sites_to_draw: ReadonlyMap<ImageSiteKey, ImageSiteEntry>,
	bond_manager: BondManager,
): ImageAtomLayout {
	const count = bond_manager.count
	const pairs = bond_manager.pairs_buffer

	// Inverted bond index: atom_idx → slots touching it. Self-bonds
	// (a == b) appear only once per slot in the bucket.
	const slots_by_atom = new Map<number, number[]>()
	for (let slot = 0; slot < count; slot++) {
		const a = pairs[slot * 2]
		const b = pairs[slot * 2 + 1]
		let bucket_a = slots_by_atom.get(a)
		if (bucket_a === undefined) {
			bucket_a = []
			slots_by_atom.set(a, bucket_a)
		}
		bucket_a.push(slot)
		if (a !== b) {
			let bucket_b = slots_by_atom.get(b)
			if (bucket_b === undefined) {
				bucket_b = []
				slots_by_atom.set(b, bucket_b)
			}
			bucket_b.push(slot)
		}
	}

	let n = 0
	let total_csr_len = 0
	for (const entry of sites_to_draw.values()) {
		const j = entry.jimage_img
		if (j[0] === 0 && j[1] === 0 && j[2] === 0) continue
		n++
		const slots = slots_by_atom.get(entry.site_idx)
		if (slots !== undefined) total_csr_len += slots.length
	}

	if (n === 0) return EMPTY_LAYOUT

	const jimage_offsets = new Int8Array(3 * n)
	const orig_site_indices = new Uint32Array(n)
	const row_offsets = new Uint32Array(n + 1)
	const bonds_csr = new Uint32Array(total_csr_len)

	let i = 0
	let csr_cursor = 0
	for (const entry of sites_to_draw.values()) {
		const j = entry.jimage_img
		if (j[0] === 0 && j[1] === 0 && j[2] === 0) continue
		jimage_offsets[i * 3] = j[0]
		jimage_offsets[i * 3 + 1] = j[1]
		jimage_offsets[i * 3 + 2] = j[2]
		orig_site_indices[i] = entry.site_idx >>> 0
		row_offsets[i] = csr_cursor
		const slots = slots_by_atom.get(entry.site_idx)
		if (slots !== undefined) {
			for (const slot of slots) {
				bonds_csr[csr_cursor++] = slot >>> 0
			}
		}
		i++
	}
	row_offsets[n] = csr_cursor

	return {
		n_image_atoms: n,
		jimage_offsets,
		orig_site_indices,
		row_offsets,
		bonds_csr,
	}
}

/**
 * Total decorator instance count for a layout. Each (image atom × incident
 * bond) contributes 2 mesh instances (one per half), matching the
 * cell-internal half-bond contract from Phase 4.
 *
 * The renderer's mesh.count math is then:
 *   `mesh.count = 2 * bond_manager.count + image_atom_decorator_instance_count(layout)`.
 */
export function image_atom_decorator_instance_count(
	layout: ImageAtomLayout,
): number {
	return layout.bonds_csr.length * 2
}

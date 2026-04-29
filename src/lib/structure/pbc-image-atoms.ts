/**
 * Crystaltoolkit-style image-atom enumeration for PBC visualization.
 *
 * Phase 7 of the PBC half-bond refactor. Mirrors
 * `crystal_toolkit/renderables/structuregraph.py:_get_sites_to_draw` so that
 * decorative image atoms get rendered with their full bond environment, not
 * as orphaned spheres.
 *
 * Two independent expansions, both off the home cell `(idx, [0,0,0])`:
 *   1. Edge-atom reflection (`draw_image_atoms`):
 *      For each cell-edge atom (frac coord ≈ 0 or ≈ 1 within `edge_tolerance`),
 *      enumerate non-empty subsets of the boundary axes and emit a +1 image
 *      (axes near 0) or a -1 image (axes near 1). A corner atom at frac
 *      (0, 0, 0) yields 7 images (one per non-empty subset of {0, 1, 2}).
 *   2. Bond-following (`bonded_sites_outside_unit_cell`):
 *      For each entry currently in the set, walk `bond_connectivity` and add
 *      each bond's partner at its resolved jimage. The check is one-shot —
 *      no recursion — matching crystaltoolkit's `for n, jimage in list(...)`
 *      snapshot semantics.
 *
 * Output is a Map keyed by `${site_idx}-${jx},${jy},${jz}` so callers can
 * test `(idx, jimage_img) ∈ sites_to_draw` in O(1).
 *
 * Pure function — no Svelte rune dependencies. Caller is responsible for
 * caching by `(structure ref, bond_connectivity ref, config)` and invalidating
 * on input change.
 */

import type { AnyStructure, PymatgenStructure } from './index'

export type ImageSiteKey = `${number}-${number},${number},${number}`

export interface ImageSiteEntry {
	/** Original site index in the pre-ghost structure (BondManager site space). */
	site_idx: number
	/** Lattice translation: image atom sits at `pos_orig + lattice·jimage_img`. */
	jimage_img: [number, number, number]
}

/**
 * Bond-connectivity entry shape used by `bond-computation-controller`. The
 * `strength` field is unused here but kept in the type so callers can pass
 * `bond_connectivity` directly without remapping.
 */
export interface BondConnectivityEntry {
	site_idx_1: number
	site_idx_2: number
	jimage: [number, number, number]
	strength?: number
}

export interface SitesToDrawConfig {
	/**
	 * When true, enumerate image atoms by reflecting cell-edge atoms across
	 * boundaries (corner/edge/face replication, VESTA / crystaltoolkit / MP
	 * convention). Has no effect on molecules (no lattice).
	 */
	draw_image_atoms: boolean
	/**
	 * When true, follow bonds out of the unit cell from every existing entry
	 * and add the partner at its resolved jimage. Useful for "complete first
	 * coordination shell" style visualizations.
	 */
	bonded_sites_outside_unit_cell: boolean
	/** Frac-coord proximity to 0 or 1 considered "on the boundary". */
	edge_tolerance: number
}

const DEFAULT_CONFIG: SitesToDrawConfig = {
	draw_image_atoms: true,
	bonded_sites_outside_unit_cell: false,
	edge_tolerance: 0.05,
}

export function make_image_site_key(
	site_idx: number,
	jimage: readonly [number, number, number],
): ImageSiteKey {
	return `${site_idx}-${jimage[0]},${jimage[1]},${jimage[2]}` as ImageSiteKey
}

function has_lattice(s: AnyStructure): s is PymatgenStructure {
	return 'lattice' in s && (s as PymatgenStructure).lattice !== undefined
}

/**
 * Build the crystaltoolkit-style sites_to_draw set for a structure.
 *
 * Returns a Map keyed by `${site_idx}-${jx},${jy},${jz}`. Always contains the
 * home-cell entry `(idx, [0,0,0])` for every site, even when both expansions
 * are disabled — callers can iterate the Map to drive both home-cell and
 * image-atom rendering uniformly.
 */
export function build_sites_to_draw(
	structure: AnyStructure,
	bond_connectivity: ReadonlyArray<BondConnectivityEntry>,
	config: Partial<SitesToDrawConfig> = {},
): Map<ImageSiteKey, ImageSiteEntry> {
	const cfg: SitesToDrawConfig = { ...DEFAULT_CONFIG, ...config }
	const out = new Map<ImageSiteKey, ImageSiteEntry>()

	const sites = structure.sites
	const n_sites = sites.length

	for (let idx = 0; idx < n_sites; idx++) {
		const j: [number, number, number] = [0, 0, 0]
		out.set(make_image_site_key(idx, j), { site_idx: idx, jimage_img: j })
	}

	const lattice_present = has_lattice(structure)

	if (cfg.draw_image_atoms && lattice_present) {
		const tol = cfg.edge_tolerance
		for (let idx = 0; idx < n_sites; idx++) {
			const abc = sites[idx].abc
			const zero_axes: number[] = []
			const one_axes: number[] = []
			for (let axis = 0; axis < 3; axis++) {
				const f = abc[axis]
				if (Math.abs(f) <= tol) zero_axes.push(axis)
				if (Math.abs(f - 1) <= tol) one_axes.push(axis)
			}
			for (const subset of non_empty_subsets(zero_axes)) {
				const j: [number, number, number] = [
					subset.includes(0) ? 1 : 0,
					subset.includes(1) ? 1 : 0,
					subset.includes(2) ? 1 : 0,
				]
				const key = make_image_site_key(idx, j)
				if (!out.has(key)) out.set(key, { site_idx: idx, jimage_img: j })
			}
			for (const subset of non_empty_subsets(one_axes)) {
				const j: [number, number, number] = [
					subset.includes(0) ? -1 : 0,
					subset.includes(1) ? -1 : 0,
					subset.includes(2) ? -1 : 0,
				]
				const key = make_image_site_key(idx, j)
				if (!out.has(key)) out.set(key, { site_idx: idx, jimage_img: j })
			}
		}
	}

	if (cfg.bonded_sites_outside_unit_cell) {
		// Snapshot before iteration — matches crystaltoolkit's `list(sites_to_draw)`.
		// One-shot expansion only; do NOT walk newly-added entries.
		const snapshot = Array.from(out.values())
		for (const entry of snapshot) {
			for (const bond of bond_connectivity) {
				let partner_idx: number
				let dj: [number, number, number]
				if (bond.site_idx_1 === entry.site_idx) {
					partner_idx = bond.site_idx_2
					dj = bond.jimage
				} else if (bond.site_idx_2 === entry.site_idx) {
					partner_idx = bond.site_idx_1
					// Stored bond convention: partner B sits at pos_b + lattice·jimage
					// relative to atom A. When entry is atom B, the A image is on the
					// opposite side — negate the jimage.
					dj = [-bond.jimage[0], -bond.jimage[1], -bond.jimage[2]]
				} else {
					continue
				}
				const partner_jimage: [number, number, number] = [
					entry.jimage_img[0] + dj[0],
					entry.jimage_img[1] + dj[1],
					entry.jimage_img[2] + dj[2],
				]
				const key = make_image_site_key(partner_idx, partner_jimage)
				if (!out.has(key)) {
					out.set(key, {
						site_idx: partner_idx,
						jimage_img: partner_jimage,
					})
				}
			}
		}
	}

	return out
}

/**
 * Enumerate every non-empty subset of `elements` as an array of arrays.
 * For 3-element inputs (the only relevant case here — 3 lattice axes) this
 * is at most 7 subsets, so the eager allocation has no measurable cost.
 */
function non_empty_subsets(elements: ReadonlyArray<number>): number[][] {
	const n = elements.length
	if (n === 0) return []
	const out: number[][] = []
	for (let mask = 1; mask < 1 << n; mask++) {
		const subset: number[] = []
		for (let i = 0; i < n; i++) {
			if (mask & (1 << i)) subset.push(elements[i])
		}
		out.push(subset)
	}
	return out
}

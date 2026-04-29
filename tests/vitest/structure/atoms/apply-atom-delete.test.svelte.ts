/**
 * Unit tests for `AtomManager.apply_atom_delete` — phase X5.
 *
 * Mirrors the coverage of `tests/vitest/structure/bonding/apply-atom-delete.test.svelte.ts`
 * (X4) and adds atom-specific cases:
 *   - site_id reindex parity (new_sid = old_sid - shift) + reverse-map rebuild
 *   - interaction with the lazy visual buffers (colors / opacities / saturations)
 *   - post-delete `add_atom` continues to append correctly (compaction left no gaps)
 *
 * Runs all reactive work inside `$effect.root` so `#version` (a $state number)
 * is observable as a plain number.
 */

import { describe, expect, it } from 'vitest'
import { AtomManager } from '$lib/structure/atoms/atom-manager.svelte'

// --- helpers ----------------------------------------------------------------

function make_manager(initial_capacity?: number) {
	let mgr!: AtomManager
	const stop = $effect.root(() => {
		mgr = new AtomManager(initial_capacity)
	})
	return { mgr, stop }
}

/** Pushes atoms 0..n-1 in, one per site_id, all carbon, at positions (i, i, i). */
function fill_sequential(mgr: AtomManager, n: number): void {
	for (let i = 0; i < n; i++) {
		mgr.add_atom(i, i, i, i, 6, 0.5)
	}
}

function snapshot_site_ids(mgr: AtomManager): number[] {
	const out: number[] = []
	for (let s = 0; s < mgr.count; s++) out.push(mgr.site_ids_buffer[s])
	return out
}

// --- no-ops -----------------------------------------------------------------

describe(`AtomManager.apply_atom_delete — no-ops`, () => {
	it(`returns without version bump on empty input (array)`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(0, 0, 0, 0, 6, 0.5)
			const v = mgr.version
			mgr.apply_atom_delete([])
			expect(mgr.version).toBe(v)
			expect(mgr.count).toBe(1)
		} finally { stop() }
	})

	it(`returns without version bump on empty input (Set)`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(0, 0, 0, 0, 6, 0.5)
			const v = mgr.version
			mgr.apply_atom_delete(new Set<number>())
			expect(mgr.version).toBe(v)
			expect(mgr.count).toBe(1)
		} finally { stop() }
	})

	it(`returns without version bump when manager is empty`, () => {
		const { mgr, stop } = make_manager()
		try {
			const v = mgr.version
			mgr.apply_atom_delete([2, 5, 7])
			expect(mgr.version).toBe(v)
			expect(mgr.count).toBe(0)
		} finally { stop() }
	})

	it(`no-op when deleted ids don't match any live slot AND no shift needed`, () => {
		const { mgr, stop } = make_manager()
		try {
			fill_sequential(mgr, 3) // site_ids 0,1,2
			const v = mgr.version
			// Every "deleted" id is greater than every live site_id — no drops, no shift.
			mgr.apply_atom_delete([10, 11])
			expect(mgr.version).toBe(v)
			expect(snapshot_site_ids(mgr)).toEqual([0, 1, 2])
		} finally { stop() }
	})
})

// --- reindex only -----------------------------------------------------------

describe(`AtomManager.apply_atom_delete — reindex only`, () => {
	it(`shifts every surviving site_id down when a smaller id is deleted`, () => {
		const { mgr, stop } = make_manager()
		try {
			// Live slots: site_ids 5, 7, 9 (none at site_id 0).
			mgr.add_atom(5, 0, 0, 0, 6, 0.5)
			mgr.add_atom(7, 0, 0, 0, 6, 0.5)
			mgr.add_atom(9, 0, 0, 0, 6, 0.5)
			const v0 = mgr.version
			mgr.apply_atom_delete([0])
			expect(mgr.version).toBe(v0 + 1)
			expect(mgr.count).toBe(3)
			expect(snapshot_site_ids(mgr)).toEqual([4, 6, 8])
		} finally { stop() }
	})

	it(`reverse map is rebuilt so find_slot_by_site_id uses NEW ids`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(5, 0, 0, 0, 6, 0.5)
			mgr.add_atom(7, 0, 0, 0, 6, 0.5)
			mgr.add_atom(9, 0, 0, 0, 6, 0.5)
			mgr.apply_atom_delete([0])
			// New site_ids are 4, 6, 8. Old ids should no longer resolve.
			expect(mgr.find_slot_by_site_id(4)).toBe(0)
			expect(mgr.find_slot_by_site_id(6)).toBe(1)
			expect(mgr.find_slot_by_site_id(8)).toBe(2)
			expect(mgr.find_slot_by_site_id(5)).toBe(-1)
			expect(mgr.find_slot_by_site_id(7)).toBe(-1)
			expect(mgr.find_slot_by_site_id(9)).toBe(-1)
		} finally { stop() }
	})
})

// --- drop only --------------------------------------------------------------

describe(`AtomManager.apply_atom_delete — drop only`, () => {
	it(`empties the manager when every live site_id is deleted`, () => {
		const { mgr, stop } = make_manager()
		try {
			fill_sequential(mgr, 3) // site_ids 0, 1, 2
			const v0 = mgr.version
			mgr.apply_atom_delete([0, 1, 2])
			expect(mgr.version).toBe(v0 + 1)
			expect(mgr.count).toBe(0)
			// Reverse map fully cleared.
			expect(mgr.find_slot_by_site_id(0)).toBe(-1)
			expect(mgr.find_slot_by_site_id(2)).toBe(-1)
		} finally { stop() }
	})
})

// --- mixed drop + reindex (the classic X4 math case, ported) ----------------

describe(`AtomManager.apply_atom_delete — mixed drop + reindex`, () => {
	it(`correctly drops + reindexes with deleted site_ids [2, 5, 7]`, () => {
		const { mgr, stop } = make_manager()
		try {
			// Populate 10 atoms at site_ids 0..9.
			fill_sequential(mgr, 10)
			const v0 = mgr.version
			mgr.apply_atom_delete([2, 5, 7])
			expect(mgr.version).toBe(v0 + 1)
			expect(mgr.count).toBe(7)
			// Survivors in original order: 0,1,3,4,6,8,9.
			// Their shifts: 0→0, 1→1, 3→2, 4→3, 6→4, 8→5, 9→6.
			expect(snapshot_site_ids(mgr)).toEqual([0, 1, 2, 3, 4, 5, 6])
			// Reverse map reflects new ids.
			expect(mgr.find_slot_by_site_id(0)).toBe(0)
			expect(mgr.find_slot_by_site_id(1)).toBe(1)
			expect(mgr.find_slot_by_site_id(2)).toBe(2) // was site_id 3
			expect(mgr.find_slot_by_site_id(6)).toBe(6) // was site_id 9
			// Deleted ids are gone.
			expect(mgr.find_slot_by_site_id(7)).toBe(-1)
			expect(mgr.find_slot_by_site_id(8)).toBe(-1)
			expect(mgr.find_slot_by_site_id(9)).toBe(-1)
		} finally { stop() }
	})

	it(`preserves position/element/radius of each survivor`, () => {
		const { mgr, stop } = make_manager()
		try {
			// site_id i stored as (i+0.1, i+0.2, i+0.3), element = 6+i, radius = 0.5+i/10.
			for (let i = 0; i < 6; i++) {
				mgr.add_atom(i, i + 0.1, i + 0.2, i + 0.3, 6 + i, 0.5 + i / 10)
			}
			mgr.apply_atom_delete([1, 3])
			// Survivors: 0, 2, 4, 5 with new ids 0, 1, 2, 3.
			expect(mgr.count).toBe(4)
			// Survivor at new slot 0: originally site_id 0 (unchanged id).
			expect(mgr.get_x(0)).toBeCloseTo(0.1)
			expect(mgr.get_element(0)).toBe(6)
			// Survivor at new slot 1: originally site_id 2 → new id 1.
			expect(mgr.get_site_id(1)).toBe(1)
			expect(mgr.get_x(1)).toBeCloseTo(2.1)
			expect(mgr.get_element(1)).toBe(8) // 6+2
			// Survivor at new slot 3: originally site_id 5 → new id 3.
			expect(mgr.get_site_id(3)).toBe(3)
			expect(mgr.get_x(3)).toBeCloseTo(5.1)
			expect(mgr.get_element(3)).toBe(11) // 6+5
			expect(mgr.get_radius(3)).toBeCloseTo(1.0)
		} finally { stop() }
	})

	it(`handles duplicate deleted ids (idempotent)`, () => {
		const { mgr, stop } = make_manager()
		try {
			fill_sequential(mgr, 10)
			const v0 = mgr.version
			mgr.apply_atom_delete([2, 5, 7, 2, 5, 7, 5])
			expect(mgr.version).toBe(v0 + 1)
			expect(mgr.count).toBe(7)
			expect(snapshot_site_ids(mgr)).toEqual([0, 1, 2, 3, 4, 5, 6])
		} finally { stop() }
	})
})

// --- dirty tracking ---------------------------------------------------------

describe(`AtomManager.apply_atom_delete — dirty tracking`, () => {
	it(`leaves dirty sparse when the changed span is small relative to count`, () => {
		const { mgr, stop } = make_manager()
		try {
			// 400 atoms at site_ids 0..399.
			fill_sequential(mgr, 400)
			mgr.clear_dirty()
			// Delete site_id 398 — compacts slot 398 (drop) + reindexes slot 399.
			// first_change = 398; last_change = 398 (only slot 398 gets rewrite after drop).
			mgr.apply_atom_delete([398])
			expect(mgr.count).toBe(399)
			// Small change span vs large count → stays sparse.
			expect(mgr.dirty_all_positions).toBe(false)
			expect(mgr.dirty_positions.size).toBeGreaterThan(0)
			expect(mgr.dirty_positions.size).toBeLessThan(20)
			// Slot 399 is past the live count; must have been purged.
			expect(mgr.dirty_positions.has(399)).toBe(false)
		} finally { stop() }
	})

	it(`promotes dirty_all_* when the changed range is large`, () => {
		const { mgr, stop } = make_manager()
		try {
			const N = 10_000
			fill_sequential(mgr, N)
			mgr.clear_dirty()
			// Delete site_id 0 — every survivor reindexes → write range spans all slots.
			mgr.apply_atom_delete([0])
			expect(mgr.count).toBe(N - 1)
			expect(mgr.dirty_all_positions).toBe(true)
			expect(mgr.dirty_positions.size).toBe(0)
			expect(mgr.dirty_all_elements).toBe(true)
			expect(mgr.dirty_all_radii).toBe(true)
		} finally { stop() }
	})
})

// --- interactions with visual buffers --------------------------------------

describe(`AtomManager.apply_atom_delete — visual buffers`, () => {
	it(`compacts colors buffer correctly after delete`, () => {
		const { mgr, stop } = make_manager()
		try {
			// Atoms at site_ids 0..4 with distinctive colors.
			for (let i = 0; i < 5; i++) {
				mgr.add_atom(i, 0, 0, 0, 6, 0.5)
				mgr.set_color(i, i * 0.1, i * 0.1 + 0.01, i * 0.1 + 0.02)
			}
			mgr.apply_atom_delete([1, 3])
			expect(mgr.count).toBe(3)
			// Survivors: site_ids now 0, 1, 2 (were 0, 2, 4).
			const c = mgr.colors_buffer!
			// slot 0: was slot 0 — color (0.0, 0.01, 0.02)
			expect(c[0]).toBeCloseTo(0.0, 5)
			expect(c[1]).toBeCloseTo(0.01, 5)
			expect(c[2]).toBeCloseTo(0.02, 5)
			// slot 1: was slot 2 — color (0.2, 0.21, 0.22)
			expect(c[3]).toBeCloseTo(0.2, 5)
			expect(c[4]).toBeCloseTo(0.21, 5)
			expect(c[5]).toBeCloseTo(0.22, 5)
			// slot 2: was slot 4 — color (0.4, 0.41, 0.42)
			expect(c[6]).toBeCloseTo(0.4, 5)
			expect(c[7]).toBeCloseTo(0.41, 5)
			expect(c[8]).toBeCloseTo(0.42, 5)
		} finally { stop() }
	})

	it(`compacts opacities + saturations buffers together`, () => {
		const { mgr, stop } = make_manager()
		try {
			for (let i = 0; i < 5; i++) {
				mgr.add_atom(i, 0, 0, 0, 6, 0.5)
				mgr.set_opacity(i, 0.1 * (i + 1))
				mgr.set_saturation(i, 0.2 * (i + 1))
			}
			mgr.apply_atom_delete([0, 2])
			expect(mgr.count).toBe(3)
			// Survivors: slots (was 1, 3, 4) with opacity (0.2, 0.4, 0.5) and saturation (0.4, 0.8, 1.0).
			const op = mgr.opacities_buffer!
			const sat = mgr.saturations_buffer!
			expect(op[0]).toBeCloseTo(0.2, 5)
			expect(op[1]).toBeCloseTo(0.4, 5)
			expect(op[2]).toBeCloseTo(0.5, 5)
			expect(sat[0]).toBeCloseTo(0.4, 5)
			expect(sat[1]).toBeCloseTo(0.8, 5)
			expect(sat[2]).toBeCloseTo(1.0, 5)
		} finally { stop() }
	})
})

// --- post-delete add_atom continues to work --------------------------------

describe(`AtomManager.apply_atom_delete — post-delete mutations`, () => {
	it(`add_atom after a delete appends to the compacted end`, () => {
		const { mgr, stop } = make_manager()
		try {
			fill_sequential(mgr, 5) // site_ids 0..4
			mgr.apply_atom_delete([1, 3]) // survivors: new ids 0, 1, 2 (3 atoms)
			expect(mgr.count).toBe(3)
			// Append a new atom at site_id 3 (the next post-delete index).
			const slot = mgr.add_atom(3, 9.0, 9.0, 9.0, 7, 0.6)
			expect(slot).toBe(3)
			expect(mgr.count).toBe(4)
			expect(mgr.get_site_id(3)).toBe(3)
			expect(mgr.get_x(3)).toBeCloseTo(9.0)
			expect(mgr.get_element(3)).toBe(7)
			// Reverse map resolves both old survivors + the new append.
			expect(mgr.find_slot_by_site_id(0)).toBe(0)
			expect(mgr.find_slot_by_site_id(2)).toBe(2)
			expect(mgr.find_slot_by_site_id(3)).toBe(3)
		} finally { stop() }
	})

	it(`set_position after a delete updates the correct (new) slot`, () => {
		const { mgr, stop } = make_manager()
		try {
			fill_sequential(mgr, 5)
			mgr.apply_atom_delete([0]) // survivors now at new ids 0..3
			// The new site_id 2 was originally site_id 3.
			const slot = mgr.find_slot_by_site_id(2)
			expect(slot).toBe(2)
			mgr.set_position(slot, 42, 43, 44)
			expect(mgr.get_x(slot)).toBeCloseTo(42)
			expect(mgr.get_y(slot)).toBeCloseTo(43)
			expect(mgr.get_z(slot)).toBeCloseTo(44)
		} finally { stop() }
	})
})

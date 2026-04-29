/**
 * Unit tests for `AtomManager` — scaffolding phase X1.
 *
 * Uses `$effect.root` to run runes outside a component. Mirrors the shape
 * of bond-manager tests where they exist; designed to be easy to extend
 * as new behaviours land in phases X2–X6.
 */

import { describe, expect, it } from 'vitest'
import {
	AtomManager,
	atomic_number_to_element,
	element_to_atomic_number,
} from '$lib/structure/atoms/atom-manager.svelte'

// Helper: creates a manager and runs body inside a $effect.root so version
// is a live reactive value we can observe. Returns { mgr, stop }.
function make_manager(initial_capacity?: number) {
	let mgr!: AtomManager
	const stop = $effect.root(() => {
		mgr = new AtomManager(initial_capacity)
	})
	return { mgr, stop }
}

describe(`element ↔ atomic-number helpers`, () => {
	it(`maps common element symbols to atomic numbers`, () => {
		expect(element_to_atomic_number(`H`)).toBe(1)
		expect(element_to_atomic_number(`C`)).toBe(6)
		expect(element_to_atomic_number(`O`)).toBe(8)
		expect(element_to_atomic_number(`Fe`)).toBe(26)
	})

	it(`maps atomic numbers back to symbols`, () => {
		expect(atomic_number_to_element(1)).toBe(`H`)
		expect(atomic_number_to_element(6)).toBe(`C`)
		expect(atomic_number_to_element(26)).toBe(`Fe`)
	})

	it(`returns 0 / undefined for unknown inputs`, () => {
		expect(element_to_atomic_number(`Xx` as any)).toBe(0)
		expect(atomic_number_to_element(200)).toBeUndefined()
	})
})

describe(`AtomManager — construction and invariants`, () => {
	it(`starts empty with correct capacity`, () => {
		const { mgr, stop } = make_manager()
		try {
			expect(mgr.count).toBe(0)
			expect(mgr.capacity).toBeGreaterThanOrEqual(1)
			expect(mgr.version).toBe(0)
			expect(mgr.has_colors).toBe(false)
			expect(mgr.has_opacities).toBe(false)
			expect(mgr.has_saturations).toBe(false)
		} finally { stop() }
	})

	it(`honours explicit initial capacity`, () => {
		const { mgr, stop } = make_manager(64)
		try {
			expect(mgr.capacity).toBeGreaterThanOrEqual(64)
		} finally { stop() }
	})

	it(`clamps initial capacity to at least 1`, () => {
		const { mgr, stop } = make_manager(0)
		try {
			expect(mgr.capacity).toBeGreaterThanOrEqual(1)
		} finally { stop() }
	})
})

describe(`AtomManager — add_atom`, () => {
	it(`stores data correctly and bumps version`, () => {
		const { mgr, stop } = make_manager()
		try {
			const v0 = mgr.version
			const slot = mgr.add_atom(42, 1.5, 2.5, 3.5, 6, 0.7) // site 42, carbon
			expect(slot).toBe(0)
			expect(mgr.count).toBe(1)
			expect(mgr.version).toBeGreaterThan(v0)
			expect(mgr.get_x(0)).toBeCloseTo(1.5)
			expect(mgr.get_y(0)).toBeCloseTo(2.5)
			expect(mgr.get_z(0)).toBeCloseTo(3.5)
			expect(mgr.get_element(0)).toBe(6)
			expect(mgr.get_radius(0)).toBeCloseTo(0.7)
			expect(mgr.get_site_id(0)).toBe(42)
			expect(mgr.find_slot_by_site_id(42)).toBe(0)
		} finally { stop() }
	})

	it(`dirties position/radius/element on add`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 0, 0, 0, 6, 0.5)
			expect(mgr.dirty_positions.has(0)).toBe(true)
			expect(mgr.dirty_radii.has(0)).toBe(true)
			expect(mgr.dirty_elements.has(0)).toBe(true)
		} finally { stop() }
	})
})

describe(`AtomManager — add_atoms (bulk)`, () => {
	it(`adds multiple atoms and maintains reverse lookup`, () => {
		const { mgr, stop } = make_manager()
		try {
			const first = mgr.add_atoms(
				Uint32Array.of(10, 20, 30),
				Float32Array.of(1, 1, 1, 2, 2, 2, 3, 3, 3),
				Uint8Array.of(6, 8, 1),
				Float32Array.of(0.5, 0.6, 0.3),
			)
			expect(first).toBe(0)
			expect(mgr.count).toBe(3)
			expect(mgr.find_slot_by_site_id(10)).toBe(0)
			expect(mgr.find_slot_by_site_id(20)).toBe(1)
			expect(mgr.find_slot_by_site_id(30)).toBe(2)
			expect(mgr.get_x(1)).toBeCloseTo(2)
			expect(mgr.get_element(2)).toBe(1)
		} finally { stop() }
	})

	it(`throws on length mismatch`, () => {
		const { mgr, stop } = make_manager()
		try {
			expect(() => mgr.add_atoms(
				Uint32Array.of(1, 2),
				Float32Array.of(1, 1, 1), // wrong length
				Uint8Array.of(6, 8),
				Float32Array.of(0.5, 0.6),
			)).toThrow()
		} finally { stop() }
	})

	it(`no-op on empty input`, () => {
		const { mgr, stop } = make_manager()
		try {
			const v0 = mgr.version
			const first = mgr.add_atoms(
				Uint32Array.of(),
				Float32Array.of(),
				Uint8Array.of(),
				Float32Array.of(),
			)
			expect(first).toBe(0)
			expect(mgr.count).toBe(0)
			expect(mgr.version).toBe(v0)
		} finally { stop() }
	})
})

describe(`AtomManager — remove_atom (swap-and-pop)`, () => {
	it(`removes the last slot without swapping`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 1, 1, 1, 6, 0.5)
			mgr.add_atom(2, 2, 2, 2, 8, 0.6)
			mgr.remove_atom(1) // remove last
			expect(mgr.count).toBe(1)
			expect(mgr.find_slot_by_site_id(2)).toBe(-1)
			expect(mgr.find_slot_by_site_id(1)).toBe(0)
		} finally { stop() }
	})

	it(`swap-and-pops for non-last removal`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 1, 1, 1, 6, 0.5)
			mgr.add_atom(2, 2, 2, 2, 8, 0.6)
			mgr.add_atom(3, 3, 3, 3, 1, 0.3)
			mgr.remove_atom(0) // remove first; last should move to slot 0
			expect(mgr.count).toBe(2)
			expect(mgr.find_slot_by_site_id(1)).toBe(-1) // gone
			expect(mgr.find_slot_by_site_id(3)).toBe(0)  // moved to slot 0
			expect(mgr.find_slot_by_site_id(2)).toBe(1)  // unchanged
			expect(mgr.get_element(0)).toBe(1) // was atom 3 (H)
		} finally { stop() }
	})

	it(`silently no-ops out-of-range slot`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 0, 0, 0, 6, 0.5)
			const v0 = mgr.version
			mgr.remove_atom(99)
			mgr.remove_atom(-1)
			expect(mgr.version).toBe(v0)
			expect(mgr.count).toBe(1)
		} finally { stop() }
	})
})

describe(`AtomManager — remove_atoms (bulk)`, () => {
	it(`deduplicates slot indices`, () => {
		const { mgr, stop } = make_manager()
		try {
			for (let i = 0; i < 5; i++) mgr.add_atom(i, i, i, i, 6, 0.5)
			mgr.remove_atoms([1, 1, 1]) // triple duplicate
			expect(mgr.count).toBe(4) // only one actually removed
		} finally { stop() }
	})

	it(`removes multiple slots and leaves reverse map consistent`, () => {
		const { mgr, stop } = make_manager()
		try {
			for (let i = 0; i < 5; i++) mgr.add_atom(100 + i, i, i, i, 6, 0.5)
			mgr.remove_atoms([0, 2, 4])
			expect(mgr.count).toBe(2)
			expect(mgr.find_slot_by_site_id(100)).toBe(-1)
			expect(mgr.find_slot_by_site_id(102)).toBe(-1)
			expect(mgr.find_slot_by_site_id(104)).toBe(-1)
			expect(mgr.find_slot_by_site_id(101)).toBeGreaterThanOrEqual(0)
			expect(mgr.find_slot_by_site_id(103)).toBeGreaterThanOrEqual(0)
		} finally { stop() }
	})
})

describe(`AtomManager — per-attribute dirty tracking`, () => {
	it(`set_color only dirties colors, not positions/radii`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 1, 1, 1, 6, 0.5)
			mgr.clear_dirty()
			mgr.set_color(0, 0.1, 0.2, 0.3)
			expect(mgr.dirty_colors.has(0)).toBe(true)
			expect(mgr.dirty_positions.has(0)).toBe(false)
			expect(mgr.dirty_radii.has(0)).toBe(false)
			expect(mgr.dirty_elements.has(0)).toBe(false)
		} finally { stop() }
	})

	it(`set_opacity only dirties opacities`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 1, 1, 1, 6, 0.5)
			mgr.clear_dirty()
			mgr.set_opacity(0, 0.4)
			expect(mgr.dirty_opacities.has(0)).toBe(true)
			expect(mgr.dirty_positions.has(0)).toBe(false)
			expect(mgr.dirty_colors.has(0)).toBe(false)
		} finally { stop() }
	})

	it(`set_position only dirties positions`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 1, 1, 1, 6, 0.5)
			mgr.clear_dirty()
			mgr.set_position(0, 5, 6, 7)
			expect(mgr.dirty_positions.has(0)).toBe(true)
			expect(mgr.dirty_radii.has(0)).toBe(false)
			expect(mgr.dirty_colors.has(0)).toBe(false)
		} finally { stop() }
	})
})

describe(`AtomManager — no-op detection`, () => {
	it(`set_position is a no-op when coords unchanged`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 1.5, 2.5, 3.5, 6, 0.5)
			mgr.clear_dirty()
			const v0 = mgr.version
			mgr.set_position(0, 1.5, 2.5, 3.5)
			expect(mgr.version).toBe(v0)
			expect(mgr.dirty_positions.size).toBe(0)
		} finally { stop() }
	})

	it(`set_color is a no-op when rgb unchanged`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 0, 0, 0, 6, 0.5)
			mgr.set_color(0, 0.1, 0.2, 0.3)
			mgr.clear_dirty()
			const v0 = mgr.version
			mgr.set_color(0, 0.1, 0.2, 0.3)
			expect(mgr.version).toBe(v0)
			expect(mgr.dirty_colors.size).toBe(0)
		} finally { stop() }
	})
})

describe(`AtomManager — batches`, () => {
	it(`color batch bumps version once at commit`, () => {
		const { mgr, stop } = make_manager()
		try {
			for (let i = 0; i < 5; i++) mgr.add_atom(i, i, i, i, 6, 0.5)
			mgr.clear_dirty()
			const v0 = mgr.version

			mgr.begin_colors_batch()
			// Non-zero colors so every write actually changes the freshly-zeroed
			// buffer (otherwise slot 0 at (0,0,0) would be a legitimate no-op).
			for (let i = 0; i < 5; i++) mgr.set_color(i, 0.1 + i * 0.1, 0.3, 0.5)
			expect(mgr.version).toBe(v0) // batch suppresses individual bumps
			mgr.commit_colors_batch()
			expect(mgr.version).toBeGreaterThan(v0) // single bump at commit
			for (let i = 0; i < 5; i++) expect(mgr.dirty_colors.has(i)).toBe(true)
		} finally { stop() }
	})

	it(`nested color batches flatten`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 0, 0, 0, 6, 0.5)
			mgr.clear_dirty()
			const v0 = mgr.version

			mgr.begin_colors_batch()
			mgr.begin_colors_batch()
			mgr.set_color(0, 1, 0, 0)
			mgr.commit_colors_batch()
			expect(mgr.version).toBe(v0) // outer still open
			mgr.commit_colors_batch()
			expect(mgr.version).toBeGreaterThan(v0)
		} finally { stop() }
	})
})

describe(`AtomManager — lazy visual buffers`, () => {
	it(`colors_buffer is null until set_color or ensure_colors called`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 0, 0, 0, 6, 0.5)
			expect(mgr.colors_buffer).toBeNull()
			mgr.set_color(0, 0.5, 0.5, 0.5)
			expect(mgr.colors_buffer).not.toBeNull()
			expect(mgr.has_colors).toBe(true)
		} finally { stop() }
	})

	it(`ensure_opacities initialises to 1.0`, () => {
		const { mgr, stop } = make_manager()
		try {
			mgr.add_atom(1, 0, 0, 0, 6, 0.5)
			mgr.ensure_opacities()
			const buf = mgr.opacities_buffer!
			expect(buf[0]).toBeCloseTo(1)
		} finally { stop() }
	})
})

describe(`AtomManager — capacity growth`, () => {
	it(`auto-grows when exceeding initial capacity`, () => {
		const { mgr, stop } = make_manager(4)
		try {
			for (let i = 0; i < 10; i++) mgr.add_atom(i, i, i, i, 6, 0.5)
			expect(mgr.count).toBe(10)
			expect(mgr.capacity).toBeGreaterThanOrEqual(10)
		} finally { stop() }
	})
})

describe(`AtomManager — clear`, () => {
	it(`resets count and reverse map`, () => {
		const { mgr, stop } = make_manager()
		try {
			for (let i = 0; i < 3; i++) mgr.add_atom(i, i, i, i, 6, 0.5)
			mgr.clear()
			expect(mgr.count).toBe(0)
			expect(mgr.find_slot_by_site_id(0)).toBe(-1)
		} finally { stop() }
	})
})

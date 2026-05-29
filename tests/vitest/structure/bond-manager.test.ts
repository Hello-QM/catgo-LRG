import {
	BOND_KIND,
	BOND_MANAGER_SCHEMA_VERSION,
	BondManager,
} from '$lib/structure/bonding/bond-manager.svelte'
import { describe, expect, test } from 'vitest'

describe(`BondManager schema version`, () => {
	test(`Phase 3 bumps schema to 2`, () => {
		expect(BOND_MANAGER_SCHEMA_VERSION).toBe(2)
	})
})

describe(`BondManager jimage column`, () => {
	test(`fresh manager exposes a zeroed jimages_buffer`, () => {
		const mgr = new BondManager(8)
		expect(mgr.jimages_buffer).toBeInstanceOf(Int8Array)
		expect(mgr.jimages_buffer.length).toBe(8 * 3)
		// Empty manager → no live data, but the backing buffer is zero-filled.
		for (let i = 0; i < mgr.jimages_buffer.length; i++) {
			expect(mgr.jimages_buffer[i]).toBe(0)
		}
	})

	test(`add_bond stores jimage and get_jimage reads it back`, () => {
		const mgr = new BondManager()
		const slot = mgr.add_bond(3, 7, BOND_KIND.AUTO, [1, -1, 2])
		expect(slot).toBe(0)
		expect(mgr.get_jimage(slot)).toEqual([1, -1, 2])
	})

	test(`add_bond defaults jimage to [0,0,0] when omitted`, () => {
		const mgr = new BondManager()
		const slot = mgr.add_bond(3, 7)
		expect(mgr.get_jimage(slot)).toEqual([0, 0, 0])
	})

	test(`add_bonds bulk-inserts jimages_src`, () => {
		const mgr = new BondManager()
		const pairs = new Uint32Array([0, 1, 2, 3, 4, 5])
		const kinds = new Uint8Array([
			BOND_KIND.AUTO,
			BOND_KIND.MANUAL,
			BOND_KIND.AUTO,
		])
		const jimages = new Int8Array([0, 0, 0, 1, 0, 0, -1, 2, -3])
		mgr.add_bonds(pairs, kinds, jimages)
		expect(mgr.count).toBe(3)
		expect(mgr.get_jimage(0)).toEqual([0, 0, 0])
		expect(mgr.get_jimage(1)).toEqual([1, 0, 0])
		expect(mgr.get_jimage(2)).toEqual([-1, 2, -3])
	})

	test(`add_bonds zero-fills jimages when omitted`, () => {
		const mgr = new BondManager()
		// Pre-populate so backing buffer has non-zero leftover data.
		mgr.add_bond(0, 1, BOND_KIND.AUTO, [1, 2, 3])
		mgr.add_bond(2, 3, BOND_KIND.AUTO, [-1, -2, -3])
		mgr.remove_bond(0)
		mgr.remove_bond(0)
		expect(mgr.count).toBe(0)
		// Now add via add_bonds without jimages.
		mgr.add_bonds(new Uint32Array([4, 5]), new Uint8Array([BOND_KIND.AUTO]))
		expect(mgr.get_jimage(0)).toEqual([0, 0, 0])
	})

	test(`add_bonds rejects mismatched jimages length`, () => {
		const mgr = new BondManager()
		expect(() =>
			mgr.add_bonds(
				new Uint32Array([0, 1]),
				new Uint8Array([BOND_KIND.AUTO]),
				new Int8Array([0, 0]), // length 2, expected 3
			)
		).toThrow(/jimages_src/)
	})

	test(`set_jimage updates the column and bumps version`, () => {
		const mgr = new BondManager()
		const slot = mgr.add_bond(0, 1, BOND_KIND.AUTO, [0, 0, 0])
		const v0 = mgr.version
		mgr.set_jimage(slot, 1, -2, 3)
		expect(mgr.version).toBeGreaterThan(v0)
		expect(mgr.get_jimage(slot)).toEqual([1, -2, 3])
	})

	test(`set_jimage is a no-op for unchanged values`, () => {
		const mgr = new BondManager()
		const slot = mgr.add_bond(0, 1, BOND_KIND.AUTO, [1, 2, 3])
		const v0 = mgr.version
		mgr.set_jimage(slot, 1, 2, 3)
		expect(mgr.version).toBe(v0)
	})
})

describe(`BondManager find_slot_by_pair with jimage`, () => {
	test(`distinguishes (3, 7, [0,0,0]) from (3, 7, [1,0,0])`, () => {
		const mgr = new BondManager()
		const s_zero = mgr.add_bond(3, 7, BOND_KIND.AUTO, [0, 0, 0])
		const s_one = mgr.add_bond(3, 7, BOND_KIND.AUTO, [1, 0, 0])
		expect(mgr.find_slot_by_pair(3, 7, [0, 0, 0])).toBe(s_zero)
		expect(mgr.find_slot_by_pair(3, 7, [1, 0, 0])).toBe(s_one)
		// Without a jimage filter, returns the first match.
		expect(mgr.find_slot_by_pair(3, 7)).toBe(s_zero)
	})

	test(`(a, b, [+1,0,0]) matches stored (b, a, [-1,0,0])`, () => {
		const mgr = new BondManager()
		const slot = mgr.add_bond(7, 3, BOND_KIND.AUTO, [-1, 0, 0])
		// Same physical bond, queried with swapped atom order.
		expect(mgr.find_slot_by_pair(3, 7, [1, 0, 0])).toBe(slot)
	})

	test(`returns -1 when atoms match but jimage doesn't`, () => {
		const mgr = new BondManager()
		mgr.add_bond(3, 7, BOND_KIND.AUTO, [0, 0, 0])
		expect(mgr.find_slot_by_pair(3, 7, [1, 0, 0])).toBe(-1)
	})
})

describe(`BondManager remove preserves jimage column`, () => {
	test(`remove_bond swap-and-pop carries jimage`, () => {
		const mgr = new BondManager()
		mgr.add_bond(0, 1, BOND_KIND.AUTO, [0, 0, 0])
		mgr.add_bond(2, 3, BOND_KIND.AUTO, [1, 1, 1])
		mgr.add_bond(4, 5, BOND_KIND.AUTO, [-2, 0, 0])
		// Remove slot 0 — slot 2 swaps into slot 0, dropping count to 2.
		mgr.remove_bond(0)
		expect(mgr.count).toBe(2)
		// The new slot 0 should be the bond that used to be at slot 2.
		expect(mgr.get_a(0)).toBe(4)
		expect(mgr.get_b(0)).toBe(5)
		expect(mgr.get_jimage(0)).toEqual([-2, 0, 0])
		// Slot 1 untouched.
		expect(mgr.get_jimage(1)).toEqual([1, 1, 1])
	})

	test(`remove_bonds with multiple slots preserves jimages of survivors`, () => {
		const mgr = new BondManager()
		mgr.add_bond(0, 1, BOND_KIND.AUTO, [0, 0, 0])
		mgr.add_bond(2, 3, BOND_KIND.AUTO, [1, 0, 0])
		mgr.add_bond(4, 5, BOND_KIND.AUTO, [0, 1, 0])
		mgr.add_bond(6, 7, BOND_KIND.AUTO, [0, 0, 1])
		// Drop slots 1 and 2; expect slots 0 and the bond originally at slot 3.
		mgr.remove_bonds([1, 2])
		expect(mgr.count).toBe(2)
		// Survivor jimages — slot 0 unchanged, the other is [0, 0, 1].
		const survivor_jimages = new Set([
			mgr.get_jimage(0).join(`,`),
			mgr.get_jimage(1).join(`,`),
		])
		expect(survivor_jimages).toContain(`0,0,0`)
		expect(survivor_jimages).toContain(`0,0,1`)
	})

	test(`remove_where keeps jimages aligned with kept bonds`, () => {
		const mgr = new BondManager()
		mgr.add_bond(0, 1, BOND_KIND.AUTO, [1, 1, 1])
		mgr.add_bond(2, 3, BOND_KIND.MANUAL, [2, 2, 2])
		mgr.add_bond(4, 5, BOND_KIND.AUTO, [3, 3, 3])
		// Remove all AUTO bonds — only the MANUAL bond remains.
		const removed = mgr.remove_where((_a, _b, k) => k === BOND_KIND.AUTO)
		expect(removed).toBe(2)
		expect(mgr.count).toBe(1)
		expect(mgr.get_a(0)).toBe(2)
		expect(mgr.get_b(0)).toBe(3)
		expect(mgr.get_jimage(0)).toEqual([2, 2, 2])
	})

	test(`apply_atom_delete keeps each survivor's own jimage after compaction`, () => {
		const mgr = new BondManager()
		// Distinct jimages so a clobber is detectable per-slot.
		mgr.add_bond(0, 1, BOND_KIND.AUTO, [0, 0, 0]) // slot 0 — survives, no shift
		mgr.add_bond(2, 3, BOND_KIND.AUTO, [1, 0, 0]) // slot 1 — DROPPED (atom 2 deleted)
		mgr.add_bond(4, 5, BOND_KIND.AUTO, [0, 0, 0]) // slot 2 — survives, compacts to slot 1
		mgr.add_bond(6, 7, BOND_KIND.AUTO, [0, 1, 0]) // slot 3 — survives, compacts to slot 2
		// Delete atom 2: drops the (2,3) bond and forces slots 2,3 to compact
		// down into slots 1,2 (and reindexes endpoints above index 2).
		mgr.apply_atom_delete([2])
		expect(mgr.count).toBe(3)
		// Slot 0 unchanged.
		expect(mgr.get_jimage(0)).toEqual([0, 0, 0])
		// Survivor originally at slot 2 (atoms 4,5 -> 3,4) now in slot 1 — must
		// keep ITS jimage [0,0,0], not inherit the dropped bond's stale [1,0,0].
		expect(mgr.get_a(1)).toBe(3)
		expect(mgr.get_b(1)).toBe(4)
		expect(mgr.get_jimage(1)).toEqual([0, 0, 0])
		// Survivor originally at slot 3 (atoms 6,7 -> 5,6) now in slot 2 — must
		// keep its own jimage [0,1,0], not the prior slot-2 occupant's [0,0,0].
		expect(mgr.get_a(2)).toBe(5)
		expect(mgr.get_b(2)).toBe(6)
		expect(mgr.get_jimage(2)).toEqual([0, 1, 0])
	})
})

describe(`BondManager capacity grow preserves jimages`, () => {
	test(`expanding past initial capacity copies jimages forward`, () => {
		const mgr = new BondManager(2)
		mgr.add_bond(0, 1, BOND_KIND.AUTO, [1, 2, 3])
		mgr.add_bond(2, 3, BOND_KIND.AUTO, [-1, -2, -3])
		expect(mgr.capacity).toBe(2)
		// Trigger a grow.
		mgr.add_bond(4, 5, BOND_KIND.AUTO, [4, 5, 6])
		expect(mgr.capacity).toBeGreaterThanOrEqual(3)
		expect(mgr.get_jimage(0)).toEqual([1, 2, 3])
		expect(mgr.get_jimage(1)).toEqual([-1, -2, -3])
		expect(mgr.get_jimage(2)).toEqual([4, 5, 6])
	})

	test(`shrink_to_fit copies live jimages into the smaller buffer`, () => {
		const mgr = new BondManager()
		mgr.add_bond(0, 1, BOND_KIND.AUTO, [1, 0, 0])
		mgr.add_bond(2, 3, BOND_KIND.AUTO, [0, 1, 0])
		// Default INITIAL_CAPACITY is 16384; shrink_to_fit will hit the floor.
		mgr.shrink_to_fit(0)
		expect(mgr.get_jimage(0)).toEqual([1, 0, 0])
		expect(mgr.get_jimage(1)).toEqual([0, 1, 0])
	})
})

describe(`BondManager replace_auto_bonds with jimages`, () => {
	test(`accepts jimages_src and writes them to AUTO slots`, () => {
		const mgr = new BondManager()
		mgr.add_bond(0, 1, BOND_KIND.MANUAL, [9, 9, 9]) // survives replace
		mgr.add_bond(2, 3, BOND_KIND.AUTO, [1, 0, 0]) // replaced
		mgr.replace_auto_bonds(
			new Uint32Array([4, 5, 6, 7]),
			2,
			new Int8Array([-1, 0, 0, 0, -1, 0]),
		)
		expect(mgr.count).toBe(3)
		// Manual bond first (survived).
		expect(mgr.get_kind(0)).toBe(BOND_KIND.MANUAL)
		expect(mgr.get_jimage(0)).toEqual([9, 9, 9])
		// Two new AUTO bonds with the supplied jimages.
		expect(mgr.get_jimage(1)).toEqual([-1, 0, 0])
		expect(mgr.get_jimage(2)).toEqual([0, -1, 0])
	})

	test(`zero-fills new AUTO jimages when jimages_src omitted`, () => {
		const mgr = new BondManager()
		// Pre-populate then remove so leftover non-zero data exists in buffer.
		mgr.add_bond(0, 1, BOND_KIND.AUTO, [1, 1, 1])
		mgr.add_bond(2, 3, BOND_KIND.AUTO, [2, 2, 2])
		mgr.replace_auto_bonds(new Uint32Array([4, 5]), 1)
		expect(mgr.count).toBe(1)
		expect(mgr.get_jimage(0)).toEqual([0, 0, 0])
	})
})

import { BOND_KIND, BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import { BondUndoStack } from '$lib/structure/bonding/bond-undo-stack'
import { describe, expect, test } from 'vitest'

function snapshot(mgr: BondManager): Array<{
	a: number
	b: number
	k: number
	ji: [number, number, number]
}> {
	const out: Array<{ a: number; b: number; k: number; ji: [number, number, number] }> = []
	for (let i = 0; i < mgr.count; i++) {
		out.push({
			a: mgr.get_a(i),
			b: mgr.get_b(i),
			k: mgr.get_kind(i),
			ji: mgr.get_jimage(i),
		})
	}
	// Sort by canonical (lo, hi, kind, jimage) for stable comparison since
	// swap-and-pop reorders slots.
	out.sort((x, y) => {
		const xlo = Math.min(x.a, x.b)
		const ylo = Math.min(y.a, y.b)
		if (xlo !== ylo) return xlo - ylo
		const xhi = Math.max(x.a, x.b)
		const yhi = Math.max(y.a, y.b)
		if (xhi !== yhi) return xhi - yhi
		if (x.k !== y.k) return x.k - y.k
		return x.ji.join(`,`).localeCompare(y.ji.join(`,`))
	})
	return out
}

describe(`BondUndoStack jimage round-trips`, () => {
	test(`add → undo → redo restores correct jimage`, () => {
		const mgr = new BondManager()
		const undo = new BondUndoStack(mgr)
		undo.add_bond(3, 7, BOND_KIND.MANUAL, [1, 0, 0])
		expect(mgr.count).toBe(1)
		expect(mgr.get_jimage(0)).toEqual([1, 0, 0])
		expect(undo.undo()).toBe(true)
		expect(mgr.count).toBe(0)
		expect(undo.redo()).toBe(true)
		expect(mgr.count).toBe(1)
		expect(mgr.get_jimage(0)).toEqual([1, 0, 0])
	})

	test(`remove → undo restores jimage of cross-cell bond`, () => {
		const mgr = new BondManager()
		mgr.add_bond(0, 1, BOND_KIND.AUTO, [0, 0, 0])
		const slot = mgr.add_bond(2, 5, BOND_KIND.AUTO, [-1, 1, 0])
		const undo = new BondUndoStack(mgr)
		undo.remove_bond(slot)
		expect(mgr.count).toBe(1)
		expect(undo.undo()).toBe(true)
		expect(mgr.count).toBe(2)
		const restored = snapshot(mgr).find(b => b.a === 2 || b.b === 2)
		expect(restored).toBeDefined()
		expect(restored!.ji).toEqual([-1, 1, 0])
	})

	test(`bulk add_bonds with jimages → undo → redo`, () => {
		const mgr = new BondManager()
		const undo = new BondUndoStack(mgr)
		undo.add_bonds(
			new Uint32Array([0, 1, 2, 3]),
			new Uint8Array([BOND_KIND.AUTO, BOND_KIND.MANUAL]),
			new Int8Array([0, 0, 0, 1, -1, 0]),
		)
		expect(mgr.count).toBe(2)
		const before = snapshot(mgr)

		expect(undo.undo()).toBe(true)
		expect(mgr.count).toBe(0)

		expect(undo.redo()).toBe(true)
		expect(mgr.count).toBe(2)
		expect(snapshot(mgr)).toEqual(before)
	})
})

describe(`BondUndoStack handles same-atom-pair distinct jimages`, () => {
	test(`two bonds (3, 7, [0,0,0]) and (3, 7, [1,0,0]) are not collapsed on undo`, () => {
		const mgr = new BondManager()
		const undo = new BondUndoStack(mgr)
		undo.transaction(() => {
			undo.add_bond(3, 7, BOND_KIND.AUTO, [0, 0, 0])
			undo.add_bond(3, 7, BOND_KIND.AUTO, [1, 0, 0])
		})
		expect(mgr.count).toBe(2)
		const before = snapshot(mgr)
		expect(before.map(b => b.ji.join(`,`)).sort()).toEqual([`0,0,0`, `1,0,0`])

		// Undo the entire transaction; both bonds should disappear.
		expect(undo.undo()).toBe(true)
		expect(mgr.count).toBe(0)

		// Redo restores both — and crucially does NOT collapse them into one.
		expect(undo.redo()).toBe(true)
		expect(mgr.count).toBe(2)
		expect(snapshot(mgr)).toEqual(before)
	})

	test(`removing one of two same-atom bonds preserves the other's jimage`, () => {
		const mgr = new BondManager()
		const slot_zero = mgr.add_bond(3, 7, BOND_KIND.AUTO, [0, 0, 0])
		const slot_one = mgr.add_bond(3, 7, BOND_KIND.AUTO, [1, 0, 0])
		const undo = new BondUndoStack(mgr)
		// Remove the [1,0,0] slot only.
		undo.remove_bond(slot_one)
		expect(mgr.count).toBe(1)
		// Whichever slot the survivor lives at, its jimage must be [0,0,0].
		expect(mgr.get_jimage(0)).toEqual([0, 0, 0])

		// Undo restores the [1,0,0] bond with its correct jimage.
		expect(undo.undo()).toBe(true)
		expect(mgr.count).toBe(2)
		const post_undo = snapshot(mgr)
		expect(post_undo.map(b => b.ji.join(`,`)).sort()).toEqual([`0,0,0`, `1,0,0`])
		void slot_zero
	})
})

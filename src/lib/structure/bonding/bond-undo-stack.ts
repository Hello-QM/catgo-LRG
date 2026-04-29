/**
 * Command-pattern undo/redo for `BondManager` mutations.
 *
 * Each recorded op stores the INVERSE operation as raw bond data (pair + kind),
 * so undo cost is O(edit_size), not O(structure_size). No snapshots, no deep
 * clones.
 *
 * ## Slot instability
 *
 * `BondManager` uses swap-and-pop for O(1) removal, which means slot indices
 * are NOT stable across mutations. A slot that held bond (3, 7) before a
 * `remove_bond` call may now hold some other bond, or may be past the live
 * count entirely. Therefore this stack NEVER stores slot indices — inverse
 * ops identify bonds by `(min(a,b), max(a,b), kind)` content instead.
 *
 * On undo of an "add bonds" operation we locate the bonds to delete by
 * canonicalized pair + kind match, which is order-insensitive on the atom
 * pair and exact on the kind byte. Duplicates (the same (a, b, kind) tuple
 * added multiple times) are handled via a remaining-count map, so N
 * duplicate adds require N matching deletions.
 *
 * ## Usage
 *
 * Use this stack's mutation methods (`add_bond`, `add_bonds`, `remove_bond`,
 * `remove_bonds`) for user-driven edits that should be undoable. Bypass the
 * stack (call the manager directly) for derived mutations like WASM auto-bond
 * recomputes that shouldn't clutter the undo history.
 *
 * Group related edits with `transaction(fn)` so a single undo reverses them
 * as one unit. Nested transactions flatten into the outermost batch.
 */

import {
	BOND_KIND,
	BOND_MANAGER_SCHEMA_VERSION,
	type BondKind,
	type BondManager,
} from './bond-manager.svelte';

export interface UndoOptions {
	/** Hard cap on undo history length. 0 = unbounded. Default 500. */
	max_entries?: number;
}

type RestoreOp = {
	kind: 'restore';
	pairs: Uint32Array;
	kinds: Uint8Array;
	jimages: Int8Array;
};

type DeletePairsOp = {
	kind: 'delete_pairs';
	pairs: Uint32Array;
	kinds: Uint8Array;
	jimages: Int8Array;
};

type BatchOp = {
	kind: 'batch';
	ops: UndoOp[];
};

type UndoOp = RestoreOp | DeletePairsOp | BatchOp;

const DEFAULT_MAX_ENTRIES = 500;

/**
 * Canonical key for a bond identified by atom pair, kind byte, AND jimage.
 * Two bonds with the same atom pair but different jimages (e.g. (3, 7,
 * [0,0,0]) vs (3, 7, [1,0,0])) are distinct physical bonds and must NOT
 * collapse into the same undo entry. Atom-pair order is canonicalized to
 * (min, max) — and when the pair is swapped, the jimage direction is
 * negated so that (a, b, [+1,0,0]) and (b, a, [-1,0,0]) hash to the same
 * key (they describe the same physical bond).
 */
function pair_kind_jimage_key(
	a: number,
	b: number,
	k: number,
	dx: number,
	dy: number,
	dz: number,
): string {
	const swap = a >= b;
	const lo = swap ? b : a;
	const hi = swap ? a : b;
	const cdx = swap ? -dx : dx;
	const cdy = swap ? -dy : dy;
	const cdz = swap ? -dz : dz;
	return `${lo}-${hi}-${k}-${cdx},${cdy},${cdz}`;
}

function build_pair_kind_jimage_map(
	pairs: Uint32Array,
	kinds: Uint8Array,
	jimages: Int8Array,
): Map<string, number> {
	const m = new Map<string, number>();
	for (let i = 0; i < kinds.length; i++) {
		const key = pair_kind_jimage_key(
			pairs[i * 2],
			pairs[i * 2 + 1],
			kinds[i],
			jimages[i * 3],
			jimages[i * 3 + 1],
			jimages[i * 3 + 2],
		);
		m.set(key, (m.get(key) ?? 0) + 1);
	}
	return m;
}

export class BondUndoStack {
	#mgr: BondManager;
	#max: number;
	#schema_version: number;

	#undo_stack: UndoOp[] = [];
	#redo_stack: UndoOp[] = [];

	#tx_depth = 0;
	#tx_ops: UndoOp[] = [];

	constructor(manager: BondManager, opts?: UndoOptions) {
		this.#mgr = manager;
		const max = opts?.max_entries;
		this.#max = max === undefined ? DEFAULT_MAX_ENTRIES : Math.max(0, max | 0);
		this.#schema_version = BOND_MANAGER_SCHEMA_VERSION;
	}

	/**
	 * Schema version this stack was constructed with. Currently informational —
	 * the stack lives only in memory, so versioned migration is not required.
	 * Phase 3 introduced jimage in version 2; bumping further should `clear()`
	 * the stacks if any in-flight ops are present.
	 */
	get schema_version(): number {
		return this.#schema_version;
	}

	get can_undo(): boolean {
		return this.#undo_stack.length > 0;
	}

	get can_redo(): boolean {
		return this.#redo_stack.length > 0;
	}

	get undo_depth(): number {
		return this.#undo_stack.length;
	}

	get redo_depth(): number {
		return this.#redo_stack.length;
	}

	/**
	 * Run `fn` and group every recorded op inside into a single undoable batch.
	 * Nested transactions flatten into the outermost batch. If `fn` throws,
	 * any ops recorded before the throw are still committed as a batch (the
	 * mutations already happened and must be undoable) and the error is
	 * rethrown.
	 */
	transaction<T>(fn: () => T): T {
		this.#tx_depth++;
		const start = this.#tx_ops.length;
		try {
			return fn();
		} finally {
			this.#tx_depth--;
			if (this.#tx_depth === 0) {
				const ops = this.#tx_ops.splice(start);
				if (ops.length === 1) {
					this.#push_to_undo(ops[0]);
				} else if (ops.length > 1) {
					this.#push_to_undo({ kind: 'batch', ops });
				}
			}
		}
	}

	/** Add a single bond and record its inverse. */
	add_bond(
		a: number,
		b: number,
		kind: BondKind = BOND_KIND.AUTO,
		jimage: [number, number, number] | null = null,
	): number {
		const slot = this.#mgr.add_bond(a, b, kind, jimage);
		const dx = jimage ? jimage[0] : 0;
		const dy = jimage ? jimage[1] : 0;
		const dz = jimage ? jimage[2] : 0;
		this.#record({
			kind: 'delete_pairs',
			pairs: Uint32Array.of(a >>> 0, b >>> 0),
			kinds: Uint8Array.of(kind),
			jimages: Int8Array.of(dx, dy, dz),
		});
		return slot;
	}

	/**
	 * Bulk-add bonds. The manager is called first; if it throws (length
	 * mismatch), nothing is recorded. Input arrays are copied into fresh
	 * typed arrays so caller-owned buffers can be safely mutated afterward.
	 *
	 * `jimages_src` is optional; when omitted, the recorded inverse op uses
	 * `[0, 0, 0]` for every bond. When supplied, length must equal `3 * n`.
	 */
	add_bonds(
		pairs_src: ArrayLike<number>,
		kinds_src: ArrayLike<number>,
		jimages_src?: ArrayLike<number> | null,
	): number {
		const first = this.#mgr.add_bonds(pairs_src, kinds_src, jimages_src ?? null);
		const n = kinds_src.length;
		if (n === 0) return first;
		const pairs_copy = new Uint32Array(2 * n);
		for (let i = 0; i < 2 * n; i++) pairs_copy[i] = pairs_src[i] >>> 0;
		const kinds_copy = new Uint8Array(n);
		for (let i = 0; i < n; i++) kinds_copy[i] = kinds_src[i];
		const jimages_copy = new Int8Array(3 * n);
		if (jimages_src !== undefined && jimages_src !== null) {
			for (let i = 0; i < 3 * n; i++) jimages_copy[i] = (jimages_src[i] | 0) << 24 >> 24;
		}
		// Else: zero-filled by Int8Array constructor.
		this.#record({
			kind: 'delete_pairs',
			pairs: pairs_copy,
			kinds: kinds_copy,
			jimages: jimages_copy,
		});
		return first;
	}

	/** Remove a single bond and record a restore op carrying its data. */
	remove_bond(slot: number): void {
		if (slot < 0 || slot >= this.#mgr.count) return;
		const a = this.#mgr.get_a(slot);
		const b = this.#mgr.get_b(slot);
		const k = this.#mgr.get_kind(slot);
		const ji = this.#mgr.get_jimage(slot);
		this.#mgr.remove_bond(slot);
		this.#record({
			kind: 'restore',
			pairs: Uint32Array.of(a, b),
			kinds: Uint8Array.of(k),
			jimages: Int8Array.of(ji[0], ji[1], ji[2]),
		});
	}

	/**
	 * Remove multiple bonds. Captures bond data for all in-range slots BEFORE
	 * calling the manager (data is unreadable after removal). Out-of-range
	 * slots are skipped silently, matching `BondManager.remove_bonds`.
	 */
	remove_bonds(slots: ArrayLike<number>): void {
		const n = slots.length;
		if (n === 0) return;
		const count = this.#mgr.count;
		// Deduplicate slots so duplicates in the input don't produce phantom
		// restore entries. The manager deduplicates internally; we must match.
		const seen = new Set<number>();
		const captured_pairs: number[] = [];
		const captured_kinds: number[] = [];
		const captured_jimages: number[] = [];
		for (let i = 0; i < n; i++) {
			const s = slots[i];
			if (s < 0 || s >= count) continue;
			if (seen.has(s)) continue;
			seen.add(s);
			captured_pairs.push(this.#mgr.get_a(s), this.#mgr.get_b(s));
			captured_kinds.push(this.#mgr.get_kind(s));
			const ji = this.#mgr.get_jimage(s);
			captured_jimages.push(ji[0], ji[1], ji[2]);
		}
		this.#mgr.remove_bonds(slots);
		if (captured_kinds.length === 0) return;
		this.#record({
			kind: 'restore',
			pairs: new Uint32Array(captured_pairs),
			kinds: new Uint8Array(captured_kinds),
			jimages: new Int8Array(captured_jimages),
		});
	}

	/** Apply the most recent undo-stack op. Returns true if something was undone. */
	undo(): boolean {
		if (this.#undo_stack.length === 0) return false;
		const op = this.#undo_stack.pop()!;
		const inverse = this.#apply_inverse(op);
		this.#redo_stack.push(inverse);
		return true;
	}

	/** Apply the most recent redo-stack op. Returns true if something was redone. */
	redo(): boolean {
		if (this.#redo_stack.length === 0) return false;
		const op = this.#redo_stack.pop()!;
		const inverse = this.#apply_inverse(op);
		this.#undo_stack.push(inverse);
		return true;
	}

	/** Clear both undo and redo stacks. Does not touch the manager. */
	clear(): void {
		this.#undo_stack.length = 0;
		this.#redo_stack.length = 0;
	}

	#apply_inverse(op: UndoOp): UndoOp {
		switch (op.kind) {
			case 'restore': {
				this.#mgr.add_bonds(op.pairs, op.kinds, op.jimages);
				return { kind: 'delete_pairs', pairs: op.pairs, kinds: op.kinds, jimages: op.jimages };
			}
			case 'delete_pairs': {
				const remaining = build_pair_kind_jimage_map(op.pairs, op.kinds, op.jimages);
				const matched_pairs: number[] = [];
				const matched_kinds: number[] = [];
				const matched_jimages: number[] = [];
				const mgr = this.#mgr;
				// `remove_where` invokes pred with the bond's pre-compaction slot
				// index. Read the jimage at that slot to disambiguate same-atom-pair
				// bonds with different lattice translations.
				mgr.remove_where((a, b, k, slot) => {
					const ji = mgr.get_jimage(slot);
					const key = pair_kind_jimage_key(a, b, k, ji[0], ji[1], ji[2]);
					const count = remaining.get(key) ?? 0;
					if (count > 0) {
						remaining.set(key, count - 1);
						matched_pairs.push(a, b);
						matched_kinds.push(k);
						matched_jimages.push(ji[0], ji[1], ji[2]);
						return true;
					}
					return false;
				});
				return {
					kind: 'restore',
					pairs: new Uint32Array(matched_pairs),
					kinds: new Uint8Array(matched_kinds),
					jimages: new Int8Array(matched_jimages),
				};
			}
			case 'batch': {
				// Original ops were applied in order [0, 1, ..., n-1]. To undo,
				// we must apply inverses in REVERSE order: [inv(n-1), ..., inv(0)].
				// We collect those inverses as we go; the resulting array is
				// already in the correct order for the inverse batch, because
				// replaying this batch via #apply_inverse will again iterate
				// from the last index down, yielding the original forward order.
				const inverses: UndoOp[] = [];
				for (let i = op.ops.length - 1; i >= 0; i--) {
					inverses.push(this.#apply_inverse(op.ops[i]));
				}
				return { kind: 'batch', ops: inverses };
			}
		}
	}

	#record(op: UndoOp): void {
		if (this.#tx_depth > 0) {
			this.#tx_ops.push(op);
		} else {
			this.#push_to_undo(op);
		}
	}

	#push_to_undo(op: UndoOp): void {
		this.#undo_stack.push(op);
		this.#redo_stack.length = 0;
		if (this.#max > 0 && this.#undo_stack.length > this.#max) {
			this.#undo_stack.shift();
		}
	}
}

/**
 * Structure-of-Arrays bond storage for the molecular viewer.
 *
 * Layout:
 *   - pairs: Uint32Array of length 2 * capacity, interleaved [a0, b0, a1, b1, ...]
 *   - kinds: Uint8Array of length capacity, one BOND_KIND byte per slot
 *   - jimages: Int8Array of length 3 * capacity, interleaved [dx0, dy0, dz0, ...]
 *     The lattice translation applied to atom B for this bond. `[0, 0, 0]` for
 *     intra-cell bonds, manual bonds, and bonds in molecules. Cross-cell bonds
 *     carry the Rust-side `image` field (typically values in [-2, 2]).
 *     Convention (matches Rust): partner B sits at `pos_b + lattice·jimage`.
 *   - count: number of live slots (0 <= count <= capacity)
 *
 * The typed arrays are deliberately NOT wrapped in $state — reads must be raw
 * numeric accesses, not proxy traps. The single reactive surface is a
 * `#version` counter (a $state number) that is incremented exactly once per
 * successful public mutation. Renderers should `$effect` on `version` and
 * consume `dirty_slots` / `dirty_all` to know what changed since their last
 * `clear_dirty()` call.
 *
 * Removals use swap-and-pop for O(1) behaviour; slot identity is therefore
 * not stable across remove operations.
 */

export const BOND_KIND = {
	AUTO: 0,
	MANUAL: 1,
	HBOND: 2,
	HALO: 3,
} as const;

export type BondKind = (typeof BOND_KIND)[keyof typeof BOND_KIND];

/**
 * Schema version for `BondManager` and the undo-stack ops it produces.
 * Bumped to 2 in Phase 3 of the PBC half-bond refactor when `jimages` was
 * added as a per-slot column. The undo stack uses this to discard any
 * in-memory entries written under a previous schema (no localStorage
 * persistence — this is a safety net for future extensions).
 */
export const BOND_MANAGER_SCHEMA_VERSION = 2;

const INITIAL_CAPACITY = 16_384;
const GROWTH_FACTOR = 2;
const DIRTY_ALL_SPAN_THRESHOLD = 4096;
const DIRTY_ALL_FRACTION = 0.5;

export class BondManager {
	#pairs: Uint32Array;
	#kinds: Uint8Array;
	#jimages: Int8Array;
	#capacity: number;
	#count = 0;

	#version = $state(0);

	#dirty_slots: Set<number> = new Set();
	#dirty_all = false;

	#colors_start: Float32Array | null = null;
	#colors_end: Float32Array | null = null;

	#colors_batch_depth = 0;
	#colors_batch_changed = false;

	#opacity_buffer: Float32Array | null = null;
	#opacity_batch_depth = 0;
	#opacity_batch_changed = false;

	constructor(initial_capacity: number = INITIAL_CAPACITY) {
		const cap = Math.max(1, initial_capacity | 0);
		this.#capacity = cap;
		this.#pairs = new Uint32Array(cap * 2);
		this.#kinds = new Uint8Array(cap);
		// Int8 is sufficient for jimage entries — Rust pbc.rs::compute_search_range
		// can in extreme cases emit ±5, well within Int8 range. 3 × cap × 1 byte.
		this.#jimages = new Int8Array(cap * 3);
	}

	get version(): number {
		return this.#version;
	}

	get count(): number {
		return this.#count;
	}

	get capacity(): number {
		return this.#capacity;
	}

	get pairs_buffer(): Uint32Array {
		return this.#pairs;
	}

	get kinds_buffer(): Uint8Array {
		return this.#kinds;
	}

	/**
	 * Backing buffer of length `3 * capacity`, interleaved [dx, dy, dz] per slot.
	 * Only entries `[0, 3 * count)` are live data. Buffer identity changes
	 * across `#ensure_capacity` / `shrink_to_fit` — consumers that cache the
	 * reference must re-read on `version` change.
	 */
	get jimages_buffer(): Int8Array {
		return this.#jimages;
	}

	get dirty_all(): boolean {
		return this.#dirty_all;
	}

	get dirty_slots(): ReadonlySet<number> {
		return this.#dirty_slots;
	}

	clear_dirty(): void {
		this.#dirty_slots.clear();
		this.#dirty_all = false;
	}

	#touch(slot: number): void {
		if (this.#dirty_all) return;
		this.#dirty_slots.add(slot);
	}

	#touch_range(lo: number, hi_inclusive: number): void {
		if (this.#dirty_all) return;
		const span = hi_inclusive - lo + 1;
		if (span <= 0) return;
		const count = this.#count;
		const promote =
			span >= DIRTY_ALL_SPAN_THRESHOLD ||
			(count > 0 && span >= count * DIRTY_ALL_FRACTION);
		if (promote) {
			this.#dirty_all = true;
			this.#dirty_slots.clear();
			return;
		}
		for (let i = lo; i <= hi_inclusive; i++) {
			this.#dirty_slots.add(i);
		}
	}

	#ensure_capacity(needed: number): void {
		if (needed <= this.#capacity) return;
		let new_cap = this.#capacity;
		while (new_cap < needed) {
			new_cap = Math.max(new_cap * GROWTH_FACTOR, needed);
		}
		const new_pairs = new Uint32Array(new_cap * 2);
		const new_kinds = new Uint8Array(new_cap);
		const new_jimages = new Int8Array(new_cap * 3);
		new_pairs.set(this.#pairs.subarray(0, this.#count * 2));
		new_kinds.set(this.#kinds.subarray(0, this.#count));
		new_jimages.set(this.#jimages.subarray(0, this.#count * 3));
		this.#pairs = new_pairs;
		this.#kinds = new_kinds;
		this.#jimages = new_jimages;
		if (this.#colors_start !== null) {
			const new_colors_start = new Float32Array(new_cap * 3);
			new_colors_start.set(this.#colors_start.subarray(0, this.#count * 3));
			this.#colors_start = new_colors_start;
		}
		if (this.#colors_end !== null) {
			const new_colors_end = new Float32Array(new_cap * 3);
			new_colors_end.set(this.#colors_end.subarray(0, this.#count * 3));
			this.#colors_end = new_colors_end;
		}
		if (this.#opacity_buffer !== null) {
			const new_opacity = new Float32Array(new_cap);
			new_opacity.fill(1);
			new_opacity.set(this.#opacity_buffer.subarray(0, this.#count));
			this.#opacity_buffer = new_opacity;
		}
		this.#capacity = new_cap;
	}

	/** Pre-grow backing arrays to hold at least `n` bonds; no dirty marking. */
	reserve(n: number): void {
		if (n <= this.#capacity) return;
		this.#ensure_capacity(n);
	}

	/** Shrink backing arrays; forces dirty_all because buffer identity changed. */
	shrink_to_fit(slack: number = 0): void {
		const target = Math.max(INITIAL_CAPACITY, this.#count + Math.max(0, slack | 0));
		if (target >= this.#capacity) return;
		const new_pairs = new Uint32Array(target * 2);
		const new_kinds = new Uint8Array(target);
		const new_jimages = new Int8Array(target * 3);
		new_pairs.set(this.#pairs.subarray(0, this.#count * 2));
		new_kinds.set(this.#kinds.subarray(0, this.#count));
		new_jimages.set(this.#jimages.subarray(0, this.#count * 3));
		this.#pairs = new_pairs;
		this.#kinds = new_kinds;
		this.#jimages = new_jimages;
		if (this.#colors_start !== null) {
			const new_colors_start = new Float32Array(target * 3);
			new_colors_start.set(this.#colors_start.subarray(0, this.#count * 3));
			this.#colors_start = new_colors_start;
		}
		if (this.#colors_end !== null) {
			const new_colors_end = new Float32Array(target * 3);
			new_colors_end.set(this.#colors_end.subarray(0, this.#count * 3));
			this.#colors_end = new_colors_end;
		}
		if (this.#opacity_buffer !== null) {
			const new_opacity = new Float32Array(target);
			new_opacity.fill(1);
			new_opacity.set(this.#opacity_buffer.subarray(0, this.#count));
			this.#opacity_buffer = new_opacity;
		}
		this.#capacity = target;
		this.#dirty_all = true;
		this.#dirty_slots.clear();
		this.#version++;
	}

	get_a(slot: number): number {
		return this.#pairs[slot * 2];
	}

	get_b(slot: number): number {
		return this.#pairs[slot * 2 + 1];
	}

	get_kind(slot: number): BondKind {
		return this.#kinds[slot] as BondKind;
	}

	/**
	 * Read the lattice translation for atom B of `slot` as `[dx, dy, dz]`.
	 * Returns `[0, 0, 0]` for any slot whose jimage was never explicitly set
	 * (default-initialized buffer is zero-filled).
	 */
	get_jimage(slot: number): [number, number, number] {
		const i = slot * 3;
		return [this.#jimages[i], this.#jimages[i + 1], this.#jimages[i + 2]];
	}

	/**
	 * Write the lattice translation for atom B of `slot`. Caller is responsible
	 * for keeping values in Int8 range; values outside [-128, 127] silently wrap.
	 * No-op for out-of-range slots.
	 */
	set_jimage(slot: number, dx: number, dy: number, dz: number): void {
		if (slot < 0 || slot >= this.#count) return;
		const i = slot * 3;
		const j = this.#jimages;
		const cdx = (dx | 0) << 24 >> 24;
		const cdy = (dy | 0) << 24 >> 24;
		const cdz = (dz | 0) << 24 >> 24;
		if (j[i] === cdx && j[i + 1] === cdy && j[i + 2] === cdz) return;
		j[i] = cdx;
		j[i + 1] = cdy;
		j[i + 2] = cdz;
		this.#touch(slot);
		this.#version++;
	}

	/**
	 * Lookup a slot by atom-pair content (order-insensitive on the pair).
	 * Returns -1 if no match. O(count) — don't call in tight loops.
	 *
	 * If `jimage` is supplied, the match is exact: a query of `(3, 7, [1,0,0])`
	 * does NOT match a stored bond `(3, 7, [0,0,0])` even though the atom pair
	 * coincides. The jimage axis is direction-aware: when the atom pair is
	 * stored swapped (e.g. stored as `(7, 3)`), the stored jimage must be the
	 * negation of the queried one — `(3, 7, [+1,0,0]) ≡ (7, 3, [-1,0,0])`.
	 *
	 * When `jimage` is omitted (legacy callers, e.g. pencil mode lookup),
	 * the match is jimage-agnostic — the first slot with a matching atom pair
	 * is returned. Cross-cell bonds are still findable, but cannot be
	 * disambiguated this way.
	 */
	find_slot_by_pair(
		a: number,
		b: number,
		jimage?: [number, number, number] | null,
	): number {
		const au = a >>> 0;
		const bu = b >>> 0;
		const pairs = this.#pairs;
		const jimages = this.#jimages;
		const n = this.#count;
		const want_ji = jimage !== undefined && jimage !== null;
		const dx = want_ji ? (jimage![0] | 0) : 0;
		const dy = want_ji ? (jimage![1] | 0) : 0;
		const dz = want_ji ? (jimage![2] | 0) : 0;
		for (let slot = 0; slot < n; slot++) {
			const p0 = pairs[slot * 2];
			const p1 = pairs[slot * 2 + 1];
			const direct = p0 === au && p1 === bu;
			const swapped = p0 === bu && p1 === au;
			if (!direct && !swapped) continue;
			if (!want_ji) return slot;
			const i = slot * 3;
			const sjx = jimages[i];
			const sjy = jimages[i + 1];
			const sjz = jimages[i + 2];
			if (direct) {
				if (sjx === dx && sjy === dy && sjz === dz) return slot;
			} else {
				// Stored as (b, a); jimage direction must be negated.
				if (sjx === -dx && sjy === -dy && sjz === -dz) return slot;
			}
		}
		return -1;
	}

	/**
	 * Bulk variant of find_slot_by_pair. Input is a flat [a0,b0, a1,b1, ...] buffer.
	 * Returns an Int32Array of the same bond-count length; each entry is the matching
	 * slot or -1. O(count × queries) — suitable for a few dozen lookups, not thousands.
	 */
	find_slots_by_pairs(pairs_src: ArrayLike<number>): Int32Array {
		const n_queries = pairs_src.length >>> 1;
		const out = new Int32Array(n_queries);
		for (let i = 0; i < n_queries; i++) {
			out[i] = this.find_slot_by_pair(pairs_src[i * 2], pairs_src[i * 2 + 1]);
		}
		return out;
	}

	add_bond(
		a: number,
		b: number,
		kind: BondKind = BOND_KIND.AUTO,
		jimage: [number, number, number] | null = null,
	): number {
		const slot = this.#count;
		this.#ensure_capacity(slot + 1);
		this.#pairs[slot * 2] = a >>> 0;
		this.#pairs[slot * 2 + 1] = b >>> 0;
		this.#kinds[slot] = kind;
		const j = this.#jimages;
		const i = slot * 3;
		if (jimage !== null) {
			j[i] = (jimage[0] | 0) << 24 >> 24;
			j[i + 1] = (jimage[1] | 0) << 24 >> 24;
			j[i + 2] = (jimage[2] | 0) << 24 >> 24;
		} else {
			j[i] = 0;
			j[i + 1] = 0;
			j[i + 2] = 0;
		}
		this.#count = slot + 1;
		this.#touch(slot);
		this.#version++;
		return slot;
	}

	/**
	 * Bulk append. `pairs_src` length must equal `2 * kinds_src.length`.
	 * If `jimages_src` is provided, its length must equal `3 * kinds_src.length`
	 * (interleaved [dx0, dy0, dz0, dx1, dy1, dz1, ...]). When omitted, every
	 * appended slot's jimage is zeroed.
	 * Returns the slot index of the first appended bond.
	 */
	add_bonds(
		pairs_src: Uint32Array | ArrayLike<number>,
		kinds_src: Uint8Array | ArrayLike<number>,
		jimages_src?: Int8Array | ArrayLike<number> | null,
	): number {
		const n = kinds_src.length;
		if (pairs_src.length !== 2 * n) {
			throw new Error(
				`add_bonds: pairs_src.length (${pairs_src.length}) must equal 2 * kinds_src.length (${2 * n})`,
			);
		}
		if (jimages_src !== undefined && jimages_src !== null && jimages_src.length !== 3 * n) {
			throw new Error(
				`add_bonds: jimages_src.length (${jimages_src.length}) must equal 3 * kinds_src.length (${3 * n})`,
			);
		}
		const first = this.#count;
		if (n === 0) return first;
		this.#ensure_capacity(first + n);
		if (pairs_src instanceof Uint32Array) {
			this.#pairs.set(pairs_src, first * 2);
		} else {
			for (let i = 0; i < pairs_src.length; i++) {
				this.#pairs[first * 2 + i] = pairs_src[i] >>> 0;
			}
		}
		if (kinds_src instanceof Uint8Array) {
			this.#kinds.set(kinds_src, first);
		} else {
			for (let i = 0; i < n; i++) {
				this.#kinds[first + i] = kinds_src[i];
			}
		}
		if (jimages_src !== undefined && jimages_src !== null) {
			if (jimages_src instanceof Int8Array) {
				this.#jimages.set(jimages_src, first * 3);
			} else {
				for (let i = 0; i < 3 * n; i++) {
					this.#jimages[first * 3 + i] = (jimages_src[i] | 0) << 24 >> 24;
				}
			}
		} else {
			// Explicitly zero the jimage span (capacity-grown segments are
			// already zero, but reused capacity may carry leftover values).
			this.#jimages.fill(0, first * 3, (first + n) * 3);
		}
		this.#count = first + n;
		this.#touch_range(first, first + n - 1);
		this.#version++;
		return first;
	}

	remove_bond(slot: number): void {
		if (slot < 0 || slot >= this.#count) return;
		const last = this.#count - 1;
		if (slot !== last) {
			this.#pairs[slot * 2] = this.#pairs[last * 2];
			this.#pairs[slot * 2 + 1] = this.#pairs[last * 2 + 1];
			this.#kinds[slot] = this.#kinds[last];
			this.#jimages[slot * 3] = this.#jimages[last * 3];
			this.#jimages[slot * 3 + 1] = this.#jimages[last * 3 + 1];
			this.#jimages[slot * 3 + 2] = this.#jimages[last * 3 + 2];
			if (this.#colors_start !== null) {
				this.#colors_start[slot * 3] = this.#colors_start[last * 3];
				this.#colors_start[slot * 3 + 1] = this.#colors_start[last * 3 + 1];
				this.#colors_start[slot * 3 + 2] = this.#colors_start[last * 3 + 2];
			}
			if (this.#colors_end !== null) {
				this.#colors_end[slot * 3] = this.#colors_end[last * 3];
				this.#colors_end[slot * 3 + 1] = this.#colors_end[last * 3 + 1];
				this.#colors_end[slot * 3 + 2] = this.#colors_end[last * 3 + 2];
			}
			if (this.#opacity_buffer !== null) {
				this.#opacity_buffer[slot] = this.#opacity_buffer[last];
			}
			this.#touch(slot);
		}
		this.#count = last;
		if (!this.#dirty_all) this.#dirty_slots.delete(last);
		this.#version++;
	}

	remove_bonds(slots: ArrayLike<number>): void {
		const n = slots.length;
		if (n === 0) return;
		const sorted: number[] = [];
		for (let i = 0; i < n; i++) sorted.push(slots[i]);
		sorted.sort((a, b) => a - b);
		let prev = -1;
		let removed_any = false;
		for (let i = sorted.length - 1; i >= 0; i--) {
			const s = sorted[i];
			if (s === prev) continue;
			prev = s;
			if (s < 0 || s >= this.#count) continue;
			const last = this.#count - 1;
			if (s !== last) {
				this.#pairs[s * 2] = this.#pairs[last * 2];
				this.#pairs[s * 2 + 1] = this.#pairs[last * 2 + 1];
				this.#kinds[s] = this.#kinds[last];
				this.#jimages[s * 3] = this.#jimages[last * 3];
				this.#jimages[s * 3 + 1] = this.#jimages[last * 3 + 1];
				this.#jimages[s * 3 + 2] = this.#jimages[last * 3 + 2];
				if (this.#colors_start !== null) {
					this.#colors_start[s * 3] = this.#colors_start[last * 3];
					this.#colors_start[s * 3 + 1] = this.#colors_start[last * 3 + 1];
					this.#colors_start[s * 3 + 2] = this.#colors_start[last * 3 + 2];
				}
				if (this.#colors_end !== null) {
					this.#colors_end[s * 3] = this.#colors_end[last * 3];
					this.#colors_end[s * 3 + 1] = this.#colors_end[last * 3 + 1];
					this.#colors_end[s * 3 + 2] = this.#colors_end[last * 3 + 2];
				}
				if (this.#opacity_buffer !== null) {
					this.#opacity_buffer[s] = this.#opacity_buffer[last];
				}
				this.#touch(s);
			}
			this.#count = last;
			if (!this.#dirty_all) this.#dirty_slots.delete(last);
			removed_any = true;
		}
		if (removed_any) this.#version++;
	}

	/**
	 * Compacting removal. Single read/write cursor pass.
	 * The `slot` argument passed to `pred` is the pre-compaction position
	 * during iteration — do NOT cache it for later use; kept bonds move
	 * to a lower slot after this call returns.
	 * Returns the number of bonds removed.
	 */
	remove_where(pred: (a: number, b: number, kind: BondKind, slot: number) => boolean): number {
		const old_count = this.#count;
		let write = 0;
		let first_change = -1;
		let last_change = -1;
		for (let read = 0; read < old_count; read++) {
			const a = this.#pairs[read * 2];
			const b = this.#pairs[read * 2 + 1];
			const k = this.#kinds[read] as BondKind;
			if (pred(a, b, k, read)) {
				if (first_change === -1) first_change = write;
				last_change = read;
				continue;
			}
			if (write !== read) {
				this.#pairs[write * 2] = a;
				this.#pairs[write * 2 + 1] = b;
				this.#kinds[write] = k;
				this.#jimages[write * 3] = this.#jimages[read * 3];
				this.#jimages[write * 3 + 1] = this.#jimages[read * 3 + 1];
				this.#jimages[write * 3 + 2] = this.#jimages[read * 3 + 2];
				if (this.#colors_start !== null) {
					this.#colors_start[write * 3] = this.#colors_start[read * 3];
					this.#colors_start[write * 3 + 1] = this.#colors_start[read * 3 + 1];
					this.#colors_start[write * 3 + 2] = this.#colors_start[read * 3 + 2];
				}
				if (this.#colors_end !== null) {
					this.#colors_end[write * 3] = this.#colors_end[read * 3];
					this.#colors_end[write * 3 + 1] = this.#colors_end[read * 3 + 1];
					this.#colors_end[write * 3 + 2] = this.#colors_end[read * 3 + 2];
				}
				if (this.#opacity_buffer !== null) {
					this.#opacity_buffer[write] = this.#opacity_buffer[read];
				}
				if (first_change === -1) first_change = write;
				last_change = read;
			}
			write++;
		}
		const removed = old_count - write;
		if (removed === 0) return 0;
		this.#count = write;
		if (first_change !== -1) {
			const hi = Math.min(last_change, write - 1);
			if (hi >= first_change) {
				this.#touch_range(first_change, hi);
			}
		}
		this.#purge_dead_dirty_slots(write);
		this.#version++;
		return removed;
	}

	/**
	 * Apply an atom-delete to the bond graph: drop any bond whose endpoint
	 * was deleted and reindex surviving endpoints down to the post-delete
	 * atom-index space. Single linear compacting-removal pass.
	 *
	 * Cost is O(count + k·log k) where k = deleted_site_ids.size — versus
	 * a full bond re-detection which is O(count) geometry work plus
	 * typically tens of ms of WASM / JS allocation churn. No-op when the
	 * input is empty or the manager is already empty.
	 *
	 * No-op on empty input and on empty manager — no version bump in those
	 * cases.
	 */
	apply_atom_delete(deleted_site_ids: readonly number[] | ReadonlySet<number>): void {
		// Normalize input to (Set, sorted-ascending array). Always clone; do
		// not mutate caller's Set.
		const deleted_set = new Set<number>();
		if (deleted_site_ids instanceof Set) {
			for (const v of deleted_site_ids) deleted_set.add(v >>> 0);
		} else {
			const arr = deleted_site_ids as readonly number[];
			for (let i = 0; i < arr.length; i++) deleted_set.add(arr[i] >>> 0);
		}
		if (deleted_set.size === 0) return;
		if (this.#count === 0) return;

		const sorted_deleted: number[] = Array.from(deleted_set);
		sorted_deleted.sort((a, b) => a - b);

		// Binary search: count of entries in sorted_deleted strictly less than target.
		const shift_for = (idx: number): number => {
			let lo = 0;
			let hi = sorted_deleted.length;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (sorted_deleted[mid] < idx) lo = mid + 1;
				else hi = mid;
			}
			return lo;
		};

		const old_count = this.#count;
		const pairs = this.#pairs;
		const kinds = this.#kinds;
		const jimages = this.#jimages;
		const colors_start = this.#colors_start;
		const colors_end = this.#colors_end;
		const opacity = this.#opacity_buffer;
		let write = 0;
		let first_change = -1;
		let last_change = -1;

		for (let read = 0; read < old_count; read++) {
			const a = pairs[read * 2];
			const b = pairs[read * 2 + 1];
			const k = kinds[read] as BondKind;
			if (deleted_set.has(a) || deleted_set.has(b)) {
				// Drop this bond. Mark the write cursor as the first change if we
				// haven't already — subsequent compactions will extend the range.
				// Don't set `last_change` here: a drop doesn't dirty any write-slot
				// itself; if later compactions happen they update last_change then.
				if (first_change === -1) first_change = write;
				continue;
			}
			const new_a = a - shift_for(a);
			const new_b = b - shift_for(b);
			const content_reindexed = new_a !== a || new_b !== b;
			const compacted = write !== read;
			if (compacted || content_reindexed) {
				pairs[write * 2] = new_a >>> 0;
				pairs[write * 2 + 1] = new_b >>> 0;
				if (compacted) {
					kinds[write] = k;
					if (colors_start !== null) {
						colors_start[write * 3] = colors_start[read * 3];
						colors_start[write * 3 + 1] = colors_start[read * 3 + 1];
						colors_start[write * 3 + 2] = colors_start[read * 3 + 2];
					}
					if (colors_end !== null) {
						colors_end[write * 3] = colors_end[read * 3];
						colors_end[write * 3 + 1] = colors_end[read * 3 + 1];
						colors_end[write * 3 + 2] = colors_end[read * 3 + 2];
					}
					if (opacity !== null) {
						opacity[write] = opacity[read];
					}
					jimages[write * 3] = jimages[read * 3];
					jimages[write * 3 + 1] = jimages[read * 3 + 1];
					jimages[write * 3 + 2] = jimages[read * 3 + 2];
				}
				if (first_change === -1) first_change = write;
				last_change = read;
			}
			write++;
		}

		const removed = old_count - write;
		const anything_changed = removed > 0 || first_change !== -1;
		if (!anything_changed) return;

		this.#count = write;
		if (first_change !== -1) {
			const hi = Math.min(last_change, write - 1);
			if (hi >= first_change) {
				this.#touch_range(first_change, hi);
			}
		}
		this.#purge_dead_dirty_slots(write);
		this.#version++;
	}

	/**
	 * Remove dirty-slot entries that are now past the live count.
	 * Collects targets into an array first to avoid mutating the Set
	 * during iteration (spec-safe under any JS engine).
	 */
	#purge_dead_dirty_slots(live_count: number): void {
		if (this.#dirty_all) return;
		let to_remove: number[] | null = null;
		for (const s of this.#dirty_slots) {
			if (s >= live_count) {
				if (to_remove === null) to_remove = [];
				to_remove.push(s);
			}
		}
		if (to_remove !== null) {
			for (const s of to_remove) this.#dirty_slots.delete(s);
		}
	}

	set_kind(slot: number, kind: BondKind): void {
		if (slot < 0 || slot >= this.#count) return;
		if (this.#kinds[slot] === kind) return;
		this.#kinds[slot] = kind;
		this.#touch(slot);
		this.#version++;
	}

	set_pair(slot: number, a: number, b: number): void {
		if (slot < 0 || slot >= this.#count) return;
		const au = a >>> 0;
		const bu = b >>> 0;
		if (this.#pairs[slot * 2] === au && this.#pairs[slot * 2 + 1] === bu) return;
		this.#pairs[slot * 2] = au;
		this.#pairs[slot * 2 + 1] = bu;
		this.#touch(slot);
		this.#version++;
	}

	// -----------------------------------------------------------------
	// Optional per-bond gradient colors (linear RGB, 3 floats per endpoint).
	// Buffers are lazy-allocated: callers that don't set colors pay zero
	// memory cost. Allocated length tracks #capacity * 3.
	//
	// NOTE: As of the bond-color-write merge into BondInstancedRenderer's
	// sync loop, the standard render path no longer uses this API —
	// BondManagerInstances passes a per-atom color accessor to the renderer,
	// which derives each half-bond's color in the same loop as the matrix
	// write (eliminating the matrix↔color staleness race). The methods below
	// remain available for callers that want to override bond colors
	// independently of atom colors; they have no effect on the default path.
	//
	// FOOTGUN: writing through `set_colors` / `set_colors_start` /
	// `set_colors_end` will appear to succeed (buffers update, version bumps)
	// but will NOT change rendered bond colors — the renderer reads from
	// `atom_colors[a*3..]` / `atom_colors[b*3..]` directly and ignores the
	// manager's color buffers entirely. To restore manager-driven colors,
	// either route writes through the per-atom buffer or extend the renderer
	// to fall back to manager colors when an override flag is set.
	// -----------------------------------------------------------------

	/** True once color buffers have been allocated. Until then, color getters return null. */
	get has_colors(): boolean {
		return this.#colors_start !== null;
	}

	/** Backing color buffer; only slots [0, 3*count) are valid. Null if colors never initialized. */
	get colors_start_buffer(): Float32Array | null {
		return this.#colors_start;
	}

	/** Backing color buffer; only slots [0, 3*count) are valid. Null if colors never initialized. */
	get colors_end_buffer(): Float32Array | null {
		return this.#colors_end;
	}

	/**
	 * Allocate color buffers if not yet allocated. Idempotent.
	 * Initial values are zeros (black). Marks all live slots dirty so the
	 * renderer uploads the fresh buffer.
	 */
	ensure_colors(): void {
		if (this.#colors_start !== null && this.#colors_end !== null) return;
		if (this.#colors_start === null) {
			this.#colors_start = new Float32Array(this.#capacity * 3);
		}
		if (this.#colors_end === null) {
			this.#colors_end = new Float32Array(this.#capacity * 3);
		}
		if (this.#count > 0) {
			this.#touch_range(0, this.#count - 1);
			if (this.#colors_batch_depth > 0) {
				this.#colors_batch_changed = true;
			} else {
				this.#version++;
			}
		}
	}

	/**
	 * Write one bond's gradient colors. Lazy-allocates the buffers if needed.
	 * No-op if slot out of range OR all six components match stored values.
	 * Otherwise touches the slot and bumps #version (unless inside a batch).
	 */
	set_colors(
		slot: number,
		sr: number,
		sg: number,
		sb: number,
		er: number,
		eg: number,
		eb: number,
	): void {
		if (slot < 0 || slot >= this.#count) return;
		if (this.#colors_start === null || this.#colors_end === null) {
			this.#colors_start = new Float32Array(this.#capacity * 3);
			this.#colors_end = new Float32Array(this.#capacity * 3);
		}
		const cs = this.#colors_start;
		const ce = this.#colors_end;
		const i = slot * 3;
		if (
			cs[i] === sr &&
			cs[i + 1] === sg &&
			cs[i + 2] === sb &&
			ce[i] === er &&
			ce[i + 1] === eg &&
			ce[i + 2] === eb
		) {
			return;
		}
		cs[i] = sr;
		cs[i + 1] = sg;
		cs[i + 2] = sb;
		ce[i] = er;
		ce[i + 1] = eg;
		ce[i + 2] = eb;
		this.#touch(slot);
		if (this.#colors_batch_depth > 0) {
			this.#colors_batch_changed = true;
		} else {
			this.#version++;
		}
	}

	/**
	 * Begin a batched color update. Inside a batch, set_colors writes and
	 * touches slots but does NOT bump #version; commit_colors_batch() bumps
	 * once at the end if anything changed. Nested batches flatten.
	 */
	begin_colors_batch(): void {
		this.#colors_batch_depth++;
	}

	/**
	 * End a batched color update. Bumps #version once if any change occurred
	 * in the outermost batch. Safe to call on a no-op batch.
	 */
	commit_colors_batch(): void {
		if (this.#colors_batch_depth === 0) return;
		this.#colors_batch_depth--;
		if (this.#colors_batch_depth === 0 && this.#colors_batch_changed) {
			this.#colors_batch_changed = false;
			this.#version++;
		}
	}

	// -----------------------------------------------------------------
	// Optional per-bond opacity (1 float per bond). Buffer is lazy-allocated:
	// callers that don't set opacity pay zero memory cost. Default value for
	// every allocated slot is 1.0 (fully opaque). Allocated length tracks
	// #capacity.
	// -----------------------------------------------------------------

	/** True once opacity buffer has been allocated. */
	get has_opacity(): boolean {
		return this.#opacity_buffer !== null;
	}

	/** Backing opacity buffer; valid range [0, count). Null if never initialized. */
	get opacity_buffer(): Float32Array | null {
		return this.#opacity_buffer;
	}

	/**
	 * Allocate opacity buffer if not yet allocated. Idempotent.
	 * Initial value is 1.0 for every slot (fully opaque).
	 * When first allocated with live bonds, marks all live slots dirty.
	 */
	ensure_opacity(): void {
		if (this.#opacity_buffer !== null) return;
		this.#opacity_buffer = new Float32Array(this.#capacity);
		this.#opacity_buffer.fill(1);
		if (this.#count > 0) {
			this.#touch_range(0, this.#count - 1);
			if (this.#opacity_batch_depth > 0) {
				this.#opacity_batch_changed = true;
			} else {
				this.#version++;
			}
		}
	}

	/**
	 * Write one bond's opacity. Lazy-allocates the buffer if needed.
	 * No-op when slot out of range OR value matches stored value.
	 * Otherwise touches the slot and bumps #version (unless inside a batch).
	 */
	set_opacity(slot: number, value: number): void {
		if (slot < 0 || slot >= this.#count) return;
		if (this.#opacity_buffer === null) this.ensure_opacity();
		const buf = this.#opacity_buffer!;
		if (buf[slot] === value) return;
		buf[slot] = value;
		this.#touch(slot);
		if (this.#opacity_batch_depth > 0) {
			this.#opacity_batch_changed = true;
		} else {
			this.#version++;
		}
	}

	/**
	 * Begin a batched opacity update. Inside a batch, set_opacity writes and
	 * touches slots but does NOT bump #version; commit_opacity_batch() bumps
	 * once at the end if anything changed. Nested batches flatten.
	 */
	begin_opacity_batch(): void {
		this.#opacity_batch_depth++;
	}

	/**
	 * End a batched opacity update. Bumps #version once if any change occurred
	 * in the outermost batch. Safe to call on a no-op batch.
	 */
	commit_opacity_batch(): void {
		if (this.#opacity_batch_depth === 0) return;
		this.#opacity_batch_depth--;
		if (this.#opacity_batch_depth === 0 && this.#opacity_batch_changed) {
			this.#opacity_batch_changed = false;
			this.#version++;
		}
	}

	/**
	 * Replace all AUTO bonds with a fresh set. `pairs_src` must contain
	 * at least `2 * n_bonds` entries; new bonds are all tagged AUTO.
	 * If `jimages_src` is provided, it must contain at least `3 * n_bonds`
	 * entries (interleaved [dx, dy, dz]). When omitted, every replaced slot
	 * gets `[0, 0, 0]`.
	 * Single version bump for the whole operation.
	 */
	replace_auto_bonds(
		pairs_src: Uint32Array | ArrayLike<number>,
		n_bonds: number,
		jimages_src?: Int8Array | ArrayLike<number> | null,
	): void {
		if (pairs_src.length < 2 * n_bonds) {
			throw new Error(
				`replace_auto_bonds: pairs_src.length (${pairs_src.length}) < 2 * n_bonds (${2 * n_bonds})`,
			);
		}
		if (jimages_src !== undefined && jimages_src !== null && jimages_src.length < 3 * n_bonds) {
			throw new Error(
				`replace_auto_bonds: jimages_src.length (${jimages_src.length}) < 3 * n_bonds (${3 * n_bonds})`,
			);
		}

		// Compacting removal of AUTO bonds, inlined so we can do a single
		// version bump for the whole replace operation.
		const old_count = this.#count;
		let write = 0;
		let first_change = -1;
		let last_change = -1;
		for (let read = 0; read < old_count; read++) {
			const k = this.#kinds[read] as BondKind;
			if (k === BOND_KIND.AUTO) {
				if (first_change === -1) first_change = write;
				last_change = read;
				continue;
			}
			if (write !== read) {
				this.#pairs[write * 2] = this.#pairs[read * 2];
				this.#pairs[write * 2 + 1] = this.#pairs[read * 2 + 1];
				this.#kinds[write] = k;
				this.#jimages[write * 3] = this.#jimages[read * 3];
				this.#jimages[write * 3 + 1] = this.#jimages[read * 3 + 1];
				this.#jimages[write * 3 + 2] = this.#jimages[read * 3 + 2];
				if (this.#colors_start !== null) {
					this.#colors_start[write * 3] = this.#colors_start[read * 3];
					this.#colors_start[write * 3 + 1] = this.#colors_start[read * 3 + 1];
					this.#colors_start[write * 3 + 2] = this.#colors_start[read * 3 + 2];
				}
				if (this.#colors_end !== null) {
					this.#colors_end[write * 3] = this.#colors_end[read * 3];
					this.#colors_end[write * 3 + 1] = this.#colors_end[read * 3 + 1];
					this.#colors_end[write * 3 + 2] = this.#colors_end[read * 3 + 2];
				}
				if (this.#opacity_buffer !== null) {
					this.#opacity_buffer[write] = this.#opacity_buffer[read];
				}
				if (first_change === -1) first_change = write;
				last_change = read;
			}
			write++;
		}
		const removed = old_count - write;
		this.#count = write;

		if (removed === 0 && n_bonds === 0) {
			// Nothing to do.
			return;
		}

		if (removed > 0) {
			if (first_change !== -1) {
				const hi = Math.min(last_change, write - 1);
				if (hi >= first_change) this.#touch_range(first_change, hi);
			}
			this.#purge_dead_dirty_slots(write);
		}

		if (n_bonds > 0) {
			const first = this.#count;
			this.#ensure_capacity(first + n_bonds);
			if (pairs_src instanceof Uint32Array) {
				this.#pairs.set(pairs_src.subarray(0, 2 * n_bonds), first * 2);
			} else {
				for (let i = 0; i < 2 * n_bonds; i++) {
					this.#pairs[first * 2 + i] = pairs_src[i] >>> 0;
				}
			}
			this.#kinds.fill(BOND_KIND.AUTO, first, first + n_bonds);
			if (jimages_src !== undefined && jimages_src !== null) {
				if (jimages_src instanceof Int8Array) {
					this.#jimages.set(jimages_src.subarray(0, 3 * n_bonds), first * 3);
				} else {
					for (let i = 0; i < 3 * n_bonds; i++) {
						this.#jimages[first * 3 + i] = (jimages_src[i] | 0) << 24 >> 24;
					}
				}
			} else {
				this.#jimages.fill(0, first * 3, (first + n_bonds) * 3);
			}
			this.#count = first + n_bonds;
			this.#touch_range(first, first + n_bonds - 1);
		}

		this.#version++;
	}

	clear(): void {
		if (this.#count === 0) return;
		this.#count = 0;
		this.#dirty_all = true;
		this.#dirty_slots.clear();
		this.#version++;
	}
}

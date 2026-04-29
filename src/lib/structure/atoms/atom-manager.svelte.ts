/**
 * Structure-of-Arrays atom storage for the molecular viewer.
 *
 * Layout:
 *   - site_ids : Uint32Array  (length = capacity)      slot → structure.sites[i] index
 *   - positions: Float32Array (length = capacity * 3)  interleaved [x0,y0,z0, x1,y1,z1, ...]
 *   - radii    : Float32Array (length = capacity)      visual radius per atom
 *   - elements : Uint8Array   (length = capacity)      atomic number (1..118)
 *   - colors     (lazy): Float32Array (length = capacity * 3)  rgb per atom
 *   - opacities  (lazy): Float32Array (length = capacity)      [0..1]
 *   - saturations(lazy): Float32Array (length = capacity)      [0..1]
 *   - count    : number of live slots (0 <= count <= capacity)
 *
 * The typed arrays are deliberately NOT wrapped in `$state` — reads must be
 * raw numeric accesses, not proxy traps. The single reactive surface is a
 * `#version` counter (a `$state` number) that is incremented exactly once
 * per successful public mutation. Renderers `$effect` on `version` and
 * consume per-attribute `dirty_<attr>` / `dirty_all_<attr>` sets/flags to
 * know which attribute buffers changed since their last `clear_dirty()`.
 *
 * Why per-attribute dirty tracking (vs one shared set like `BondManager`):
 * atom mutations come in three very different patterns — structural edits
 * (delete/add) change positions+radii+elements; color-picker edits change
 * only colors; opacity-slider edits change only opacities. Per-attribute
 * tracking lets each GPU attribute upload only when *its* data actually
 * changed — e.g. picking a color on one atom re-uploads ONE float per
 * color channel, not the whole position/radius/opacity/saturation stack.
 *
 * Removals use swap-and-pop for O(1) behaviour; slot identity is therefore
 * not stable across remove operations. Callers that need a stable reference
 * go through `site_id` (the original `structure.sites[i]` index) and look
 * up the current slot via `find_slot_by_site_id()`.
 */

import type { ElementSymbol, Site } from '$lib'
import element_data from '$lib/element/data'

/**
 * Specs passed to the X6 mutation fast-paths. The callsite supplies only what
 * it already has in scope (site_id + element symbol/atomic_number + the new
 * position). The hook inside `StructureScene` resolves radius + color from its
 * own scene state (atom_radius, element_radius_overrides, colors.element,
 * property_colors) — keeping the callsite free of GPU-visual concerns.
 *
 * NOTE: for add/replace the initial color is an "element color fallback" —
 * the X2 shadow sync will overwrite with the full priority chain
 * (site_color_override > plugin > property_color > element) on the next tick.
 * `set_color` no-ops on unchanged values, so this costs a single branch, no
 * extra GPU upload. See plan X6 "Color/radius resolution at callsite".
 */
export interface AtomAddSpec {
	site_id: number
	position: readonly [number, number, number]
	element: ElementSymbol
}

export interface AtomReplaceSpec {
	site_id: number
	new_element: ElementSymbol
}

export interface AtomMoveSpec {
	site_id: number
	new_position: readonly [number, number, number]
}

/**
 * Fast-path hook surface exposed by `StructureScene` to `Structure` so atom
 * mutation callsites can write directly to `atom_manager` / `bond_state` /
 * `bond_manager` BEFORE mutating `structure.sites`. See phases X5–X6 in
 * plans/atom-soa-refactor.md.
 *
 * All methods return true when the fast path succeeded (caller falls through
 * to the canonical `set_structure()` mutation without triggering a full WASM
 * recompute on the next tick), false when the flag is off or the input is
 * empty. The caller is always responsible for the canonical structure update
 * — the manager now just holds the post-mutation state, so the X2 shadow sync
 * reconciles as a no-op diff.
 */
export interface AtomFastOps {
	/**
	 * Run the direct-to-manager delete fast path. See phase X5.
	 *
	 * `deleted_site_ids` are the indices into the PRE-delete `structure.sites`
	 * that the caller is about to remove. `new_sites` is the compacted
	 * post-delete `sites` array used to pre-emptively bump bond-state
	 * fingerprints so the next tick's `compute_bond_connectivity` skips a
	 * full WASM/JS recompute.
	 */
	try_delete: (deleted_site_ids: readonly number[], new_sites: readonly Site[]) => boolean

	/**
	 * Run the direct-to-manager add fast path. See phase X6.
	 *
	 * `added` describes the atoms appended to `structure.sites` — each
	 * `site_id` is the post-add index (i.e. `old_sites.length + i` for the
	 * i-th atom being added). `new_sites` is the full post-add sites array.
	 */
	try_add: (added: readonly AtomAddSpec[], new_sites: readonly Site[]) => boolean

	/**
	 * Run the direct-to-manager replace fast path. See phase X6.
	 *
	 * `replacements` names existing site_ids whose species changed. Bond
	 * topology is re-derived from the post-replace structure (small-structure
	 * simplification — above a threshold the hook falls back to the legacy
	 * full recompute by returning false). `new_sites` is the full post-replace
	 * sites array.
	 */
	try_replace: (replacements: readonly AtomReplaceSpec[], new_sites: readonly Site[]) => boolean

	/**
	 * Run the direct-to-manager move fast path. See phase X6.
	 *
	 * `moved` names existing site_ids whose position changed. Bond topology
	 * is re-derived (positions can create/break bonds); same small-structure
	 * simplification as `try_replace`. `new_sites` is the full post-move
	 * sites array.
	 */
	try_move: (moved: readonly AtomMoveSpec[], new_sites: readonly Site[]) => boolean
}

// ─── Element ↔ atomic-number maps ───
// Built once at module load.

const ATOMIC_NUMBER_BY_SYMBOL = new Map<string, number>(
	element_data.map((e) => [e.symbol as string, e.number]),
)
const SYMBOL_BY_ATOMIC_NUMBER = new Map<number, string>(
	element_data.map((e) => [e.number, e.symbol as string]),
)

/** Element symbol → atomic number. Returns 0 for unknown symbols (no throw). */
export function element_to_atomic_number(symbol: ElementSymbol | string): number {
	return ATOMIC_NUMBER_BY_SYMBOL.get(symbol) ?? 0
}

/** Atomic number → element symbol. Returns undefined for unknown atomic numbers. */
export function atomic_number_to_element(n: number): ElementSymbol | undefined {
	return SYMBOL_BY_ATOMIC_NUMBER.get(n) as ElementSymbol | undefined
}

// ─── Constants ───

const INITIAL_CAPACITY = 1024
const GROWTH_FACTOR = 2

/** When a single touch-range covers >= this many slots, promote to `dirty_all`
 *  (cheaper than tracking thousands of individual slot indices). */
const DIRTY_ALL_SPAN_THRESHOLD = 4096

/** Promote to `dirty_all` when a touch-range covers more than this fraction
 *  of live slots (full rewrite is cheaper than sparse updates above this). */
const DIRTY_ALL_FRACTION = 0.5

// ─── AtomManager ───

export class AtomManager {
	// Identity & core attributes (always allocated)
	#site_ids: Uint32Array
	#positions: Float32Array
	#radii: Float32Array
	#elements: Uint8Array

	// Visual attributes (lazy allocation — components that don't need them pay zero)
	#colors: Float32Array | null = null
	#opacities: Float32Array | null = null
	#saturations: Float32Array | null = null

	#capacity: number
	#count = 0

	// Reactive surface. Mutating methods bump this exactly once.
	#version = $state(0)

	// Per-attribute dirty tracking.
	#dirty_positions: Set<number> = new Set()
	#dirty_all_positions = false
	#dirty_radii: Set<number> = new Set()
	#dirty_all_radii = false
	#dirty_elements: Set<number> = new Set()
	#dirty_all_elements = false
	#dirty_colors: Set<number> = new Set()
	#dirty_all_colors = false
	#dirty_opacities: Set<number> = new Set()
	#dirty_all_opacities = false
	#dirty_saturations: Set<number> = new Set()
	#dirty_all_saturations = false

	// Reverse lookup for shadow-sync consumers that need to find a slot by
	// the original `structure.sites[i]` index. Kept in sync on add/remove.
	#site_id_to_slot: Map<number, number> = new Map()

	// Batch-depth trackers (same pattern as BondManager). Inside a batch,
	// `set_<attr>` records changes without bumping `#version`; the outermost
	// `commit_<attr>_batch()` call bumps once at the end if anything changed.
	#colors_batch_depth = 0
	#colors_batch_changed = false
	#opacities_batch_depth = 0
	#opacities_batch_changed = false
	#saturations_batch_depth = 0
	#saturations_batch_changed = false

	constructor(initial_capacity: number = INITIAL_CAPACITY) {
		const cap = Math.max(1, initial_capacity | 0)
		this.#capacity = cap
		this.#site_ids = new Uint32Array(cap)
		this.#positions = new Float32Array(cap * 3)
		this.#radii = new Float32Array(cap)
		this.#elements = new Uint8Array(cap)
	}

	// ─────────────────────────────────────────────────────────────────
	// Reactive surface & raw-buffer accessors
	// ─────────────────────────────────────────────────────────────────

	get version(): number { return this.#version }
	get count(): number { return this.#count }
	get capacity(): number { return this.#capacity }

	get site_ids_buffer(): Uint32Array { return this.#site_ids }
	get positions_buffer(): Float32Array { return this.#positions }
	get radii_buffer(): Float32Array { return this.#radii }
	get elements_buffer(): Uint8Array { return this.#elements }
	get colors_buffer(): Float32Array | null { return this.#colors }
	get opacities_buffer(): Float32Array | null { return this.#opacities }
	get saturations_buffer(): Float32Array | null { return this.#saturations }

	get has_colors(): boolean { return this.#colors !== null }
	get has_opacities(): boolean { return this.#opacities !== null }
	get has_saturations(): boolean { return this.#saturations !== null }

	// ─────────────────────────────────────────────────────────────────
	// Per-attribute dirty tracking accessors
	// ─────────────────────────────────────────────────────────────────

	get dirty_positions(): ReadonlySet<number> { return this.#dirty_positions }
	get dirty_all_positions(): boolean { return this.#dirty_all_positions }
	get dirty_radii(): ReadonlySet<number> { return this.#dirty_radii }
	get dirty_all_radii(): boolean { return this.#dirty_all_radii }
	get dirty_elements(): ReadonlySet<number> { return this.#dirty_elements }
	get dirty_all_elements(): boolean { return this.#dirty_all_elements }
	get dirty_colors(): ReadonlySet<number> { return this.#dirty_colors }
	get dirty_all_colors(): boolean { return this.#dirty_all_colors }
	get dirty_opacities(): ReadonlySet<number> { return this.#dirty_opacities }
	get dirty_all_opacities(): boolean { return this.#dirty_all_opacities }
	get dirty_saturations(): ReadonlySet<number> { return this.#dirty_saturations }
	get dirty_all_saturations(): boolean { return this.#dirty_all_saturations }

	/** Clear ALL per-attribute dirty state. Renderers call this after
	 *  successfully uploading changes to the GPU. */
	clear_dirty(): void {
		this.#dirty_positions.clear();           this.#dirty_all_positions = false
		this.#dirty_radii.clear();               this.#dirty_all_radii = false
		this.#dirty_elements.clear();            this.#dirty_all_elements = false
		this.#dirty_colors.clear();              this.#dirty_all_colors = false
		this.#dirty_opacities.clear();           this.#dirty_all_opacities = false
		this.#dirty_saturations.clear();         this.#dirty_all_saturations = false
	}

	// ─────────────────────────────────────────────────────────────────
	// Dirty-tracking internals
	// ─────────────────────────────────────────────────────────────────

	#touch_position(slot: number): void {
		if (this.#dirty_all_positions) return
		this.#dirty_positions.add(slot)
	}
	#touch_radius(slot: number): void {
		if (this.#dirty_all_radii) return
		this.#dirty_radii.add(slot)
	}
	#touch_element(slot: number): void {
		if (this.#dirty_all_elements) return
		this.#dirty_elements.add(slot)
	}
	#touch_color(slot: number): void {
		if (this.#dirty_all_colors) return
		this.#dirty_colors.add(slot)
	}
	#touch_opacity(slot: number): void {
		if (this.#dirty_all_opacities) return
		this.#dirty_opacities.add(slot)
	}
	#touch_saturation(slot: number): void {
		if (this.#dirty_all_saturations) return
		this.#dirty_saturations.add(slot)
	}

	/** Mark a slot dirty across ALL attributes (add/replace/structural edit). */
	#touch_all_attrs_for_slot(slot: number): void {
		this.#touch_position(slot)
		this.#touch_radius(slot)
		this.#touch_element(slot)
		if (this.#colors !== null) this.#touch_color(slot)
		if (this.#opacities !== null) this.#touch_opacity(slot)
		if (this.#saturations !== null) this.#touch_saturation(slot)
	}

	/** Mark a range of slots dirty for CORE attributes (position/radius/element).
	 *  Promotes to `dirty_all_<attr>` on large ranges to avoid tracking
	 *  thousands of individual slots. */
	#touch_range_core(lo: number, hi_inclusive: number): void {
		const span = hi_inclusive - lo + 1
		if (span <= 0) return
		const count = this.#count
		const promote =
			span >= DIRTY_ALL_SPAN_THRESHOLD ||
			(count > 0 && span >= count * DIRTY_ALL_FRACTION)
		if (promote) {
			this.#dirty_all_positions = true
			this.#dirty_positions.clear()
			this.#dirty_all_radii = true
			this.#dirty_radii.clear()
			this.#dirty_all_elements = true
			this.#dirty_elements.clear()
			return
		}
		for (let i = lo; i <= hi_inclusive; i++) {
			if (!this.#dirty_all_positions) this.#dirty_positions.add(i)
			if (!this.#dirty_all_radii) this.#dirty_radii.add(i)
			if (!this.#dirty_all_elements) this.#dirty_elements.add(i)
		}
	}

	// ─────────────────────────────────────────────────────────────────
	// Capacity management
	// ─────────────────────────────────────────────────────────────────

	#ensure_capacity(needed: number): void {
		if (needed <= this.#capacity) return
		let new_cap = this.#capacity
		while (new_cap < needed) new_cap = Math.max(new_cap * GROWTH_FACTOR, needed)

		const new_site_ids = new Uint32Array(new_cap)
		const new_positions = new Float32Array(new_cap * 3)
		const new_radii = new Float32Array(new_cap)
		const new_elements = new Uint8Array(new_cap)
		new_site_ids.set(this.#site_ids.subarray(0, this.#count))
		new_positions.set(this.#positions.subarray(0, this.#count * 3))
		new_radii.set(this.#radii.subarray(0, this.#count))
		new_elements.set(this.#elements.subarray(0, this.#count))
		this.#site_ids = new_site_ids
		this.#positions = new_positions
		this.#radii = new_radii
		this.#elements = new_elements

		if (this.#colors !== null) {
			const next = new Float32Array(new_cap * 3)
			next.set(this.#colors.subarray(0, this.#count * 3))
			this.#colors = next
		}
		if (this.#opacities !== null) {
			const next = new Float32Array(new_cap)
			next.fill(1)
			next.set(this.#opacities.subarray(0, this.#count))
			this.#opacities = next
		}
		if (this.#saturations !== null) {
			const next = new Float32Array(new_cap)
			next.fill(1)
			next.set(this.#saturations.subarray(0, this.#count))
			this.#saturations = next
		}

		this.#capacity = new_cap
	}

	/** Pre-grow backing arrays to hold at least `n` atoms; no dirty marking. */
	reserve(n: number): void {
		if (n > this.#capacity) this.#ensure_capacity(n)
	}

	/** Shrink backing arrays; forces every `dirty_all_*` because buffer identity changed. */
	shrink_to_fit(slack: number = 0): void {
		const target = Math.max(INITIAL_CAPACITY, this.#count + Math.max(0, slack | 0))
		if (target >= this.#capacity) return

		const new_site_ids = new Uint32Array(target)
		const new_positions = new Float32Array(target * 3)
		const new_radii = new Float32Array(target)
		const new_elements = new Uint8Array(target)
		new_site_ids.set(this.#site_ids.subarray(0, this.#count))
		new_positions.set(this.#positions.subarray(0, this.#count * 3))
		new_radii.set(this.#radii.subarray(0, this.#count))
		new_elements.set(this.#elements.subarray(0, this.#count))
		this.#site_ids = new_site_ids
		this.#positions = new_positions
		this.#radii = new_radii
		this.#elements = new_elements

		if (this.#colors !== null) {
			const next = new Float32Array(target * 3)
			next.set(this.#colors.subarray(0, this.#count * 3))
			this.#colors = next
		}
		if (this.#opacities !== null) {
			const next = new Float32Array(target)
			next.fill(1)
			next.set(this.#opacities.subarray(0, this.#count))
			this.#opacities = next
		}
		if (this.#saturations !== null) {
			const next = new Float32Array(target)
			next.fill(1)
			next.set(this.#saturations.subarray(0, this.#count))
			this.#saturations = next
		}

		this.#capacity = target
		// Buffer identity changed ⇒ everything is effectively dirty.
		this.#dirty_all_positions = true;   this.#dirty_positions.clear()
		this.#dirty_all_radii = true;       this.#dirty_radii.clear()
		this.#dirty_all_elements = true;    this.#dirty_elements.clear()
		if (this.#colors !== null)       { this.#dirty_all_colors = true;      this.#dirty_colors.clear() }
		if (this.#opacities !== null)    { this.#dirty_all_opacities = true;   this.#dirty_opacities.clear() }
		if (this.#saturations !== null)  { this.#dirty_all_saturations = true; this.#dirty_saturations.clear() }
		this.#version++
	}

	// ─────────────────────────────────────────────────────────────────
	// Add / remove
	// ─────────────────────────────────────────────────────────────────

	/** Add one atom. Returns the slot it landed in. */
	add_atom(
		site_id: number,
		x: number,
		y: number,
		z: number,
		atomic_number: number,
		radius: number,
	): number {
		this.#ensure_capacity(this.#count + 1)
		const slot = this.#count
		this.#site_ids[slot] = site_id >>> 0
		this.#positions[slot * 3] = x
		this.#positions[slot * 3 + 1] = y
		this.#positions[slot * 3 + 2] = z
		this.#radii[slot] = radius
		this.#elements[slot] = atomic_number & 0xff
		this.#site_id_to_slot.set(site_id, slot)
		this.#count = slot + 1
		this.#touch_all_attrs_for_slot(slot)
		this.#version++
		return slot
	}

	/** Bulk-add atoms. All input arrays must match `n = site_ids.length`.
	 *  Returns the slot index of the first added atom. */
	add_atoms(
		site_ids_src: ArrayLike<number>,
		positions_src: ArrayLike<number>, // interleaved xyz
		atomic_numbers_src: ArrayLike<number>,
		radii_src: ArrayLike<number>,
	): number {
		const n = site_ids_src.length
		if (positions_src.length !== 3 * n) {
			throw new Error(
				`add_atoms: positions_src.length (${positions_src.length}) must equal 3 * site_ids.length (${3 * n})`,
			)
		}
		if (atomic_numbers_src.length !== n) {
			throw new Error(
				`add_atoms: atomic_numbers_src.length (${atomic_numbers_src.length}) must equal site_ids.length (${n})`,
			)
		}
		if (radii_src.length !== n) {
			throw new Error(
				`add_atoms: radii_src.length (${radii_src.length}) must equal site_ids.length (${n})`,
			)
		}
		const first = this.#count
		if (n === 0) return first
		this.#ensure_capacity(first + n)

		for (let i = 0; i < n; i++) {
			const slot = first + i
			const sid = site_ids_src[i] >>> 0
			this.#site_ids[slot] = sid
			this.#site_id_to_slot.set(sid, slot)
			this.#positions[slot * 3] = positions_src[i * 3]
			this.#positions[slot * 3 + 1] = positions_src[i * 3 + 1]
			this.#positions[slot * 3 + 2] = positions_src[i * 3 + 2]
			this.#radii[slot] = radii_src[i]
			this.#elements[slot] = atomic_numbers_src[i] & 0xff
		}
		this.#count = first + n
		this.#touch_range_core(first, first + n - 1)
		// Visual attrs on new slots: default-fill if allocated (1.0 for opacity/saturation)
		if (this.#colors !== null || this.#opacities !== null || this.#saturations !== null) {
			for (let slot = first; slot < first + n; slot++) {
				if (this.#colors !== null) this.#touch_color(slot)
				if (this.#opacities !== null) {
					this.#opacities[slot] = 1
					this.#touch_opacity(slot)
				}
				if (this.#saturations !== null) {
					this.#saturations[slot] = 1
					this.#touch_saturation(slot)
				}
			}
		}
		this.#version++
		return first
	}

	/** Remove the atom at `slot` (swap-and-pop). Invalidates other slot
	 *  indices. Returns silently if slot is out of range. */
	remove_atom(slot: number): void {
		if (slot < 0 || slot >= this.#count) return
		const last = this.#count - 1

		// Clean up reverse-lookup for the slot being removed.
		const removed_sid = this.#site_ids[slot]
		this.#site_id_to_slot.delete(removed_sid)

		if (slot !== last) {
			// Move last slot's data into `slot`.
			const last_sid = this.#site_ids[last]
			this.#site_ids[slot] = last_sid
			this.#positions[slot * 3]     = this.#positions[last * 3]
			this.#positions[slot * 3 + 1] = this.#positions[last * 3 + 1]
			this.#positions[slot * 3 + 2] = this.#positions[last * 3 + 2]
			this.#radii[slot] = this.#radii[last]
			this.#elements[slot] = this.#elements[last]
			if (this.#colors !== null) {
				this.#colors[slot * 3]     = this.#colors[last * 3]
				this.#colors[slot * 3 + 1] = this.#colors[last * 3 + 1]
				this.#colors[slot * 3 + 2] = this.#colors[last * 3 + 2]
			}
			if (this.#opacities !== null) this.#opacities[slot] = this.#opacities[last]
			if (this.#saturations !== null) this.#saturations[slot] = this.#saturations[last]
			this.#site_id_to_slot.set(last_sid, slot)
			this.#touch_all_attrs_for_slot(slot)
		}

		this.#count = last
		// Last slot's data is now considered "not live". Dirty-track the
		// eviction so the renderer knows to truncate its instance count.
		if (!this.#dirty_all_positions) this.#dirty_positions.delete(last)
		if (!this.#dirty_all_radii)     this.#dirty_radii.delete(last)
		if (!this.#dirty_all_elements)  this.#dirty_elements.delete(last)
		if (!this.#dirty_all_colors)    this.#dirty_colors.delete(last)
		if (!this.#dirty_all_opacities) this.#dirty_opacities.delete(last)
		if (!this.#dirty_all_saturations) this.#dirty_saturations.delete(last)
		this.#version++
	}

	/** Remove multiple atoms in one mutation. Slot indices in `slots` must
	 *  be valid at the time the call begins. Duplicate slot values are
	 *  tolerated (deduplicated). Bumps version once. */
	remove_atoms(slots: ArrayLike<number>): void {
		const n = slots.length
		if (n === 0) return
		// Dedupe and sort descending so swap-and-pop on earlier slots doesn't
		// disturb later ones.
		const seen = new Set<number>()
		const sorted: number[] = []
		for (let i = 0; i < n; i++) {
			const s = slots[i]
			if (s < 0 || s >= this.#count || seen.has(s)) continue
			seen.add(s)
			sorted.push(s)
		}
		sorted.sort((a, b) => b - a)

		let removed_any = false
		for (const slot of sorted) {
			const last = this.#count - 1
			if (slot < 0 || slot >= this.#count) continue

			const removed_sid = this.#site_ids[slot]
			this.#site_id_to_slot.delete(removed_sid)

			if (slot !== last) {
				const last_sid = this.#site_ids[last]
				this.#site_ids[slot] = last_sid
				this.#positions[slot * 3]     = this.#positions[last * 3]
				this.#positions[slot * 3 + 1] = this.#positions[last * 3 + 1]
				this.#positions[slot * 3 + 2] = this.#positions[last * 3 + 2]
				this.#radii[slot] = this.#radii[last]
				this.#elements[slot] = this.#elements[last]
				if (this.#colors !== null) {
					this.#colors[slot * 3]     = this.#colors[last * 3]
					this.#colors[slot * 3 + 1] = this.#colors[last * 3 + 1]
					this.#colors[slot * 3 + 2] = this.#colors[last * 3 + 2]
				}
				if (this.#opacities !== null)   this.#opacities[slot] = this.#opacities[last]
				if (this.#saturations !== null) this.#saturations[slot] = this.#saturations[last]
				this.#site_id_to_slot.set(last_sid, slot)
				this.#touch_all_attrs_for_slot(slot)
			}

			this.#count = last
			if (!this.#dirty_all_positions) this.#dirty_positions.delete(last)
			if (!this.#dirty_all_radii)     this.#dirty_radii.delete(last)
			if (!this.#dirty_all_elements)  this.#dirty_elements.delete(last)
			if (!this.#dirty_all_colors)    this.#dirty_colors.delete(last)
			if (!this.#dirty_all_opacities) this.#dirty_opacities.delete(last)
			if (!this.#dirty_all_saturations) this.#dirty_saturations.delete(last)
			removed_any = true
		}
		if (removed_any) this.#version++
	}

	/**
	 * Apply an atom-delete to the manager: drop slots whose `site_id` is in
	 * `deleted_site_ids`, then reindex every surviving slot's `site_id` down
	 * into the post-delete `structure.sites` index space (the pymatgen
	 * compaction convention — `structure.sites.filter(i ∉ deleted)` renumbers
	 * indices from 0..N-1-k).
	 *
	 * Cost: O(count + k·log k) where k = deleted_site_ids.size — single
	 * forward compacting pass over all live slots; binary-search shift
	 * lookup per surviving slot. No geometry work, no WASM.
	 *
	 * No-op on empty input and on empty manager — no version bump in those
	 * cases. Bumps `#version` exactly once when any slot was dropped or any
	 * `site_id` was rewritten.
	 *
	 * Mirrors `BondManager.apply_atom_delete` (X4) with two extra pieces of
	 * per-slot work: (1) copy the richer atom-attribute stack (positions×3,
	 * radii, elements, + lazy colors×3, opacities, saturations) on compaction,
	 * and (2) rewrite `site_id` on survivors whose index shifted.
	 * `#site_id_to_slot` is rebuilt from scratch at the end of the pass — the
	 * incremental updates required during the pass would force second-level
	 * bookkeeping (old→new site_id) that's not worth the code.
	 */
	apply_atom_delete(deleted_site_ids: readonly number[] | ReadonlySet<number>): void {
		// Normalize input to a Set; always clone — never mutate caller's Set.
		const deleted_set = new Set<number>()
		if (deleted_site_ids instanceof Set) {
			for (const v of deleted_site_ids) deleted_set.add(v >>> 0)
		} else {
			const arr = deleted_site_ids as readonly number[]
			for (let i = 0; i < arr.length; i++) deleted_set.add(arr[i] >>> 0)
		}
		if (deleted_set.size === 0) return
		if (this.#count === 0) return

		const sorted_deleted: number[] = Array.from(deleted_set)
		sorted_deleted.sort((a, b) => a - b)

		// Binary search: count of entries in sorted_deleted strictly less than target.
		const shift_for = (sid: number): number => {
			let lo = 0
			let hi = sorted_deleted.length
			while (lo < hi) {
				const mid = (lo + hi) >>> 1
				if (sorted_deleted[mid] < sid) lo = mid + 1
				else hi = mid
			}
			return lo
		}

		const old_count = this.#count
		const site_ids = this.#site_ids
		const positions = this.#positions
		const radii = this.#radii
		const elements = this.#elements
		const colors = this.#colors
		const opacities = this.#opacities
		const saturations = this.#saturations

		let write = 0
		// Tracks where COMPACTIONS occurred in the write-indexed buffer —
		// these are the only slots whose GPU-observable attributes (position,
		// radius, element, color, opacity, saturation) changed. Reindex-only
		// slots (write===read, shift>0) had their site_id rewritten in place;
		// site_id isn't a GPU attribute, so we deliberately don't dirty-mark
		// them — the renderer would otherwise re-upload unchanged values.
		let first_compact = -1
		let last_compact = -1
		// Tracks whether ANY site_id was rewritten (including reindex-only
		// slots). We need this separate from the compaction range because
		// site_id rewrites force a `#site_id_to_slot` rebuild even when the
		// GPU-observable dirty range is empty.
		let any_sid_change = false

		for (let read = 0; read < old_count; read++) {
			const old_sid = site_ids[read]
			if (deleted_set.has(old_sid)) {
				// Drop this slot. Later compactions will set last_compact; if
				// nothing follows (delete at the tail only), the compact range
				// stays empty — nothing to GPU-dirty beyond `mesh.count` shrink.
				if (first_compact === -1) first_compact = write
				continue
			}
			const shift = shift_for(old_sid)
			const new_sid = old_sid - shift
			const content_reindexed = shift !== 0
			const compacted = write !== read

			if (compacted || content_reindexed) {
				site_ids[write] = new_sid >>> 0
				any_sid_change = true
				if (compacted) {
					positions[write * 3]     = positions[read * 3]
					positions[write * 3 + 1] = positions[read * 3 + 1]
					positions[write * 3 + 2] = positions[read * 3 + 2]
					radii[write] = radii[read]
					elements[write] = elements[read]
					if (colors !== null) {
						colors[write * 3]     = colors[read * 3]
						colors[write * 3 + 1] = colors[read * 3 + 1]
						colors[write * 3 + 2] = colors[read * 3 + 2]
					}
					if (opacities !== null) opacities[write] = opacities[read]
					if (saturations !== null) saturations[write] = saturations[read]
					if (first_compact === -1) first_compact = write
					last_compact = write
				}
			}
			write++
		}

		const removed = old_count - write
		if (!any_sid_change && removed === 0) return

		this.#count = write

		// Rebuild reverse map from scratch. Cheaper + simpler than maintaining
		// it incrementally, since every surviving site_id potentially changed.
		this.#site_id_to_slot.clear()
		for (let slot = 0; slot < write; slot++) {
			this.#site_id_to_slot.set(site_ids[slot], slot)
		}

		// Dirty-track the range we touched. `#touch_range_core` handles
		// promote-to-all for large spans; we still need to hit the lazy
		// visual buffers manually since they aren't part of the core set.
		if (first_compact !== -1 && last_compact !== -1) {
			const hi = Math.min(last_compact, write - 1)
			if (hi >= first_compact) {
				this.#touch_range_core(first_compact, hi)
				if (colors !== null || opacities !== null || saturations !== null) {
					// `#touch_range_core` may have promoted to `dirty_all_*` for the
					// core attrs; the `#touch_<visual>` helpers are `dirty_all`-safe
					// but colors/opacities/saturations have their OWN dirty_all flags
					// we must set directly (core's promote doesn't cascade to them).
					const span = hi - first_compact + 1
					const should_promote =
						span >= DIRTY_ALL_SPAN_THRESHOLD ||
						(this.#count > 0 && span >= this.#count * DIRTY_ALL_FRACTION)
					if (should_promote) {
						if (colors !== null) { this.#dirty_all_colors = true; this.#dirty_colors.clear() }
						if (opacities !== null) { this.#dirty_all_opacities = true; this.#dirty_opacities.clear() }
						if (saturations !== null) { this.#dirty_all_saturations = true; this.#dirty_saturations.clear() }
					} else {
						for (let s = first_compact; s <= hi; s++) {
							if (colors !== null) this.#touch_color(s)
							if (opacities !== null) this.#touch_opacity(s)
							if (saturations !== null) this.#touch_saturation(s)
						}
					}
				}
			}
		}

		// Purge any dirty-slot entries that are now past the live count.
		this.#purge_dead_dirty_slots_after_compact(write)

		this.#version++
	}

	/** After a compacting removal, remove any dirty-slot entries >= `live_count`
	 *  across every attribute. Parallels BondManager's `#purge_dead_dirty_slots`
	 *  but fans out across all six per-attribute sets. `dirty_all_*` sets are
	 *  skipped (they're already "everything"). */
	#purge_dead_dirty_slots_after_compact(live_count: number): void {
		const purge = (set: Set<number>): void => {
			let to_remove: number[] | null = null
			for (const s of set) {
				if (s >= live_count) {
					if (to_remove === null) to_remove = []
					to_remove.push(s)
				}
			}
			if (to_remove !== null) for (const s of to_remove) set.delete(s)
		}
		if (!this.#dirty_all_positions) purge(this.#dirty_positions)
		if (!this.#dirty_all_radii) purge(this.#dirty_radii)
		if (!this.#dirty_all_elements) purge(this.#dirty_elements)
		if (!this.#dirty_all_colors) purge(this.#dirty_colors)
		if (!this.#dirty_all_opacities) purge(this.#dirty_opacities)
		if (!this.#dirty_all_saturations) purge(this.#dirty_saturations)
	}

	/** Remove every slot for which `pred` returns true, in a single linear pass.
	 *  Returns the number of atoms removed. */
	remove_where(pred: (site_id: number, slot: number) => boolean): number {
		const old_count = this.#count
		let write = 0
		let first_change = -1
		let last_change = -1
		for (let read = 0; read < old_count; read++) {
			const sid = this.#site_ids[read]
			if (pred(sid, read)) {
				// drop — clean up reverse map
				this.#site_id_to_slot.delete(sid)
				if (first_change < 0) first_change = write
				continue
			}
			if (read !== write) {
				this.#site_ids[write] = sid
				this.#positions[write * 3]     = this.#positions[read * 3]
				this.#positions[write * 3 + 1] = this.#positions[read * 3 + 1]
				this.#positions[write * 3 + 2] = this.#positions[read * 3 + 2]
				this.#radii[write] = this.#radii[read]
				this.#elements[write] = this.#elements[read]
				if (this.#colors !== null) {
					this.#colors[write * 3]     = this.#colors[read * 3]
					this.#colors[write * 3 + 1] = this.#colors[read * 3 + 1]
					this.#colors[write * 3 + 2] = this.#colors[read * 3 + 2]
				}
				if (this.#opacities !== null)   this.#opacities[write] = this.#opacities[read]
				if (this.#saturations !== null) this.#saturations[write] = this.#saturations[read]
				this.#site_id_to_slot.set(sid, write)
				last_change = write
			}
			write++
		}
		const removed = old_count - write
		this.#count = write
		if (removed > 0) {
			if (first_change >= 0) {
				this.#touch_range_core(first_change, Math.max(first_change, last_change))
				if (this.#colors !== null || this.#opacities !== null || this.#saturations !== null) {
					const hi = Math.max(first_change, last_change)
					for (let s = first_change; s <= hi; s++) {
						if (this.#colors !== null) this.#touch_color(s)
						if (this.#opacities !== null) this.#touch_opacity(s)
						if (this.#saturations !== null) this.#touch_saturation(s)
					}
				}
			}
			this.#version++
		}
		return removed
	}

	// ─────────────────────────────────────────────────────────────────
	// Per-attribute setters (single atom)
	// ─────────────────────────────────────────────────────────────────

	/** Update position of a single slot. No-op if x/y/z already equal current.
	 *  Uses `Math.fround` for precise float32 equality — without it, writing
	 *  `0.1` to a Float32Array and reading back doesn't equal `0.1` due to
	 *  precision loss, and every write would falsely register as a change. */
	set_position(slot: number, x: number, y: number, z: number): void {
		if (slot < 0 || slot >= this.#count) return
		const base = slot * 3
		const fx = Math.fround(x), fy = Math.fround(y), fz = Math.fround(z)
		if (
			this.#positions[base]     === fx &&
			this.#positions[base + 1] === fy &&
			this.#positions[base + 2] === fz
		) return
		this.#positions[base]     = fx
		this.#positions[base + 1] = fy
		this.#positions[base + 2] = fz
		this.#touch_position(slot)
		this.#version++
	}

	set_radius(slot: number, radius: number): void {
		if (slot < 0 || slot >= this.#count) return
		const fr = Math.fround(radius)
		if (this.#radii[slot] === fr) return
		this.#radii[slot] = fr
		this.#touch_radius(slot)
		this.#version++
	}

	/** Update element atomic number for a slot. Does NOT update radius or
	 *  color — caller must call `set_radius` and `set_color` separately if
	 *  the element change implies visual changes (usually yes: radius and
	 *  element color track the element). See X6 `try_replace` hook. */
	set_element(slot: number, atomic_number: number): void {
		if (slot < 0 || slot >= this.#count) return
		const v = atomic_number & 0xff
		if (this.#elements[slot] === v) return
		this.#elements[slot] = v
		this.#touch_element(slot)
		this.#version++
	}

	// ─────────────────────────────────────────────────────────────────
	// Optional color buffer (lazy, 3 floats per atom)
	// ─────────────────────────────────────────────────────────────────

	/** Allocate color buffer if not yet allocated. Initial values are zero. */
	ensure_colors(): void {
		if (this.#colors !== null) return
		this.#colors = new Float32Array(this.#capacity * 3)
		if (this.#count > 0) {
			this.#dirty_all_colors = true
			this.#dirty_colors.clear()
			if (this.#colors_batch_depth > 0) this.#colors_batch_changed = true
			else this.#version++
		}
	}

	/** Set color for a single slot. No-op if already equal. */
	set_color(slot: number, r: number, g: number, b: number): void {
		if (slot < 0 || slot >= this.#count) return
		if (this.#colors === null) {
			this.#colors = new Float32Array(this.#capacity * 3)
		}
		const base = slot * 3
		const c = this.#colors
		const fr = Math.fround(r), fg = Math.fround(g), fb = Math.fround(b)
		if (c[base] === fr && c[base + 1] === fg && c[base + 2] === fb) return
		c[base]     = fr
		c[base + 1] = fg
		c[base + 2] = fb
		this.#touch_color(slot)
		if (this.#colors_batch_depth > 0) this.#colors_batch_changed = true
		else this.#version++
	}

	begin_colors_batch(): void {
		this.#colors_batch_depth++
	}
	commit_colors_batch(): void {
		if (this.#colors_batch_depth === 0) return
		this.#colors_batch_depth--
		if (this.#colors_batch_depth === 0 && this.#colors_batch_changed) {
			this.#colors_batch_changed = false
			this.#version++
		}
	}

	// ─────────────────────────────────────────────────────────────────
	// Optional opacity buffer (lazy, 1 float per atom, default 1.0)
	// ─────────────────────────────────────────────────────────────────

	ensure_opacities(): void {
		if (this.#opacities !== null) return
		this.#opacities = new Float32Array(this.#capacity)
		this.#opacities.fill(1)
		if (this.#count > 0) {
			this.#dirty_all_opacities = true
			this.#dirty_opacities.clear()
			if (this.#opacities_batch_depth > 0) this.#opacities_batch_changed = true
			else this.#version++
		}
	}

	set_opacity(slot: number, value: number): void {
		if (slot < 0 || slot >= this.#count) return
		if (this.#opacities === null) {
			this.#opacities = new Float32Array(this.#capacity)
			this.#opacities.fill(1)
		}
		const fv = Math.fround(value)
		if (this.#opacities[slot] === fv) return
		this.#opacities[slot] = fv
		this.#touch_opacity(slot)
		if (this.#opacities_batch_depth > 0) this.#opacities_batch_changed = true
		else this.#version++
	}

	begin_opacity_batch(): void {
		this.#opacities_batch_depth++
	}
	commit_opacity_batch(): void {
		if (this.#opacities_batch_depth === 0) return
		this.#opacities_batch_depth--
		if (this.#opacities_batch_depth === 0 && this.#opacities_batch_changed) {
			this.#opacities_batch_changed = false
			this.#version++
		}
	}

	// ─────────────────────────────────────────────────────────────────
	// Optional saturation buffer (lazy, 1 float per atom, default 1.0)
	// ─────────────────────────────────────────────────────────────────

	ensure_saturations(): void {
		if (this.#saturations !== null) return
		this.#saturations = new Float32Array(this.#capacity)
		this.#saturations.fill(1)
		if (this.#count > 0) {
			this.#dirty_all_saturations = true
			this.#dirty_saturations.clear()
			if (this.#saturations_batch_depth > 0) this.#saturations_batch_changed = true
			else this.#version++
		}
	}

	set_saturation(slot: number, value: number): void {
		if (slot < 0 || slot >= this.#count) return
		if (this.#saturations === null) {
			this.#saturations = new Float32Array(this.#capacity)
			this.#saturations.fill(1)
		}
		const fv = Math.fround(value)
		if (this.#saturations[slot] === fv) return
		this.#saturations[slot] = fv
		this.#touch_saturation(slot)
		if (this.#saturations_batch_depth > 0) this.#saturations_batch_changed = true
		else this.#version++
	}

	begin_saturation_batch(): void {
		this.#saturations_batch_depth++
	}
	commit_saturation_batch(): void {
		if (this.#saturations_batch_depth === 0) return
		this.#saturations_batch_depth--
		if (this.#saturations_batch_depth === 0 && this.#saturations_batch_changed) {
			this.#saturations_batch_changed = false
			this.#version++
		}
	}

	// ─────────────────────────────────────────────────────────────────
	// Queries
	// ─────────────────────────────────────────────────────────────────

	/** Returns the slot currently holding `site_id`, or -1 if not present. O(1). */
	find_slot_by_site_id(site_id: number): number {
		return this.#site_id_to_slot.get(site_id) ?? -1
	}

	/** Bulk variant of find_slot_by_site_id. Returns an Int32Array aligned
	 *  with the input; entries are -1 when the site_id is not present. */
	find_slots_by_site_ids(site_ids: ArrayLike<number>): Int32Array {
		const n = site_ids.length
		const out = new Int32Array(n)
		for (let i = 0; i < n; i++) out[i] = this.find_slot_by_site_id(site_ids[i])
		return out
	}

	/** Returns the site_id associated with `slot`, or undefined if slot is not live. */
	get_site_id(slot: number): number | undefined {
		if (slot < 0 || slot >= this.#count) return undefined
		return this.#site_ids[slot]
	}

	get_x(slot: number): number { return this.#positions[slot * 3] }
	get_y(slot: number): number { return this.#positions[slot * 3 + 1] }
	get_z(slot: number): number { return this.#positions[slot * 3 + 2] }
	get_radius(slot: number): number { return this.#radii[slot] }
	get_element(slot: number): number { return this.#elements[slot] }

	// ─────────────────────────────────────────────────────────────────
	// Lifecycle
	// ─────────────────────────────────────────────────────────────────

	/** Discard all atoms but keep buffer capacity. Single version bump. */
	clear(): void {
		if (this.#count === 0) return
		this.#count = 0
		this.#site_id_to_slot.clear()
		this.#dirty_all_positions = true;   this.#dirty_positions.clear()
		this.#dirty_all_radii = true;       this.#dirty_radii.clear()
		this.#dirty_all_elements = true;    this.#dirty_elements.clear()
		if (this.#colors !== null)       { this.#dirty_all_colors = true;      this.#dirty_colors.clear() }
		if (this.#opacities !== null)    { this.#dirty_all_opacities = true;   this.#dirty_opacities.clear() }
		if (this.#saturations !== null)  { this.#dirty_all_saturations = true; this.#dirty_saturations.clear() }
		this.#version++
	}
}

/**
 * Command-pattern undo/redo for `AtomManager` mutations.
 *
 * Each recorded op stores the INVERSE operation as raw atom data, so undo
 * cost is O(edit_size), not O(structure_size). No snapshots, no deep clones.
 *
 * ## Why not `AtomArrayInverse` (the earlier atom-undo payload)?
 *
 * The existing atom-kind undo entry (`AtomArrayInverse` in
 * `selection-state.svelte.ts`) captures `removed_sites: Site[]` +
 * `removed_indices: number[]`. That works when undo re-splices into
 * `structure.sites` — the canonical pymatgen-shaped data. This
 * command stack is a *different* layer: it tracks manager-slot mutations
 * so they can be replayed incrementally without round-tripping through
 * `structure.sites`. They coexist; Phase X7 wires the two stacks so an
 * atom-kind undo entry pops both payloads atomically.
 *
 * ## Slot instability
 *
 * `AtomManager` uses swap-and-pop for O(1) removal, which means slot
 * indices are NOT stable across mutations. This stack therefore identifies
 * atoms by `site_id` (the original `structure.sites[i]` index), not by
 * manager slot. On undo we look up the current slot via
 * `manager.find_slot_by_site_id()` before applying the inverse.
 *
 * ## Usage
 *
 * Use this stack's mutation methods for user-driven edits that should be
 * undoable. Bypass the stack (call the manager directly) for derived
 * mutations like shadow-sync that shouldn't clutter the undo history.
 *
 * Group related edits with `transaction(fn)` so a single undo reverses
 * them as one unit. Nested transactions flatten into the outermost batch.
 */

import type { AtomManager } from './atom-manager.svelte'

export interface UndoOptions {
	/** Hard cap on undo history length. 0 = unbounded. Default 500. */
	max_entries?: number
}

// ─── Op types ───
//
// Each op stores whatever is needed to reverse a single logical atom
// mutation. All ops identify atoms by `site_id`, never by slot.

/** Undo-data for "delete atoms" — restore the deleted atoms with their
 *  original positions / elements / radii. Visual attrs (color / opacity /
 *  saturation) are NOT captured by default — they're view-state concerns
 *  that get re-derived on restore. */
type RestoreAtomsOp = {
	kind: 'restore_atoms'
	site_ids: Uint32Array
	positions: Float32Array // interleaved xyz per atom
	elements: Uint8Array
	radii: Float32Array
}

/** Undo-data for "add atoms" — delete the newly-added atoms by site_id. */
type DeleteAtomsOp = {
	kind: 'delete_atoms'
	site_ids: Uint32Array
}

/** Undo-data for element replacement — restore the previous atomic number. */
type RevertElementsOp = {
	kind: 'revert_elements'
	site_ids: Uint32Array
	elements: Uint8Array
}

/** Undo-data for position change — restore prior positions. */
type RevertPositionsOp = {
	kind: 'revert_positions'
	site_ids: Uint32Array
	positions: Float32Array // interleaved xyz
}

type BatchOp = {
	kind: 'batch'
	ops: UndoOp[]
}

type UndoOp =
	| RestoreAtomsOp
	| DeleteAtomsOp
	| RevertElementsOp
	| RevertPositionsOp
	| BatchOp

const DEFAULT_MAX_ENTRIES = 500

// ─── Stack ───

export class AtomCommandStack {
	#mgr: AtomManager
	#max: number

	#undo_stack: UndoOp[] = []
	#redo_stack: UndoOp[] = []

	#tx_depth = 0
	#tx_ops: UndoOp[] = []

	constructor(manager: AtomManager, opts?: UndoOptions) {
		this.#mgr = manager
		const max = opts?.max_entries
		this.#max = max === undefined ? DEFAULT_MAX_ENTRIES : Math.max(0, max | 0)
	}

	get can_undo(): boolean { return this.#undo_stack.length > 0 }
	get can_redo(): boolean { return this.#redo_stack.length > 0 }
	get undo_depth(): number { return this.#undo_stack.length }
	get redo_depth(): number { return this.#redo_stack.length }

	/** Run `fn` and group every recorded op inside into a single undoable
	 *  batch. Nested transactions flatten into the outermost batch. */
	transaction<T>(fn: () => T): T {
		this.#tx_depth++
		const start = this.#tx_ops.length
		try {
			return fn()
		} finally {
			this.#tx_depth--
			if (this.#tx_depth === 0) {
				const ops = this.#tx_ops.splice(start)
				if (ops.length === 1) this.#push_to_undo(ops[0])
				else if (ops.length > 1) this.#push_to_undo({ kind: 'batch', ops })
			}
		}
	}

	// ─── Recording methods ───
	//
	// These are the stack's public mutation API. They delegate to the
	// manager and record the inverse op. The corresponding redo is recorded
	// implicitly by `apply_inverse` when `undo()` / `redo()` are called.

	/** Delete atoms identified by `site_ids`. Records a restore op
	 *  carrying the deleted atoms' data so undo can re-add them. */
	delete_by_site_ids(site_ids: ArrayLike<number>): void {
		const n = site_ids.length
		if (n === 0) return
		const mgr = this.#mgr

		// Capture pre-delete data for the inverse BEFORE mutating.
		const captured_site_ids: number[] = []
		const captured_positions: number[] = []
		const captured_elements: number[] = []
		const captured_radii: number[] = []
		const slots_to_remove: number[] = []

		for (let i = 0; i < n; i++) {
			const sid = site_ids[i]
			const slot = mgr.find_slot_by_site_id(sid)
			if (slot < 0) continue
			captured_site_ids.push(sid)
			captured_positions.push(mgr.get_x(slot), mgr.get_y(slot), mgr.get_z(slot))
			captured_elements.push(mgr.get_element(slot))
			captured_radii.push(mgr.get_radius(slot))
			slots_to_remove.push(slot)
		}

		if (slots_to_remove.length === 0) return
		mgr.remove_atoms(slots_to_remove)

		this.#record({
			kind: 'restore_atoms',
			site_ids: new Uint32Array(captured_site_ids),
			positions: new Float32Array(captured_positions),
			elements: new Uint8Array(captured_elements),
			radii: new Float32Array(captured_radii),
		})
	}

	/** Add one atom; records the inverse. Returns the new slot index
	 *  (caller may use it immediately — stable until next mutation). */
	add_atom(
		site_id: number,
		x: number,
		y: number,
		z: number,
		atomic_number: number,
		radius: number,
	): number {
		const slot = this.#mgr.add_atom(site_id, x, y, z, atomic_number, radius)
		this.#record({
			kind: 'delete_atoms',
			site_ids: Uint32Array.of(site_id),
		})
		return slot
	}

	/** Replace element for atoms; records revert-op for undo. */
	replace_elements(
		site_ids: ArrayLike<number>,
		new_atomic_numbers: ArrayLike<number>,
	): void {
		const n = site_ids.length
		if (n === 0) return
		if (new_atomic_numbers.length !== n) {
			throw new Error(
				`replace_elements: new_atomic_numbers.length (${new_atomic_numbers.length}) must equal site_ids.length (${n})`,
			)
		}
		const mgr = this.#mgr
		const captured_site_ids: number[] = []
		const captured_elements: number[] = []

		for (let i = 0; i < n; i++) {
			const sid = site_ids[i]
			const slot = mgr.find_slot_by_site_id(sid)
			if (slot < 0) continue
			const old = mgr.get_element(slot)
			if (old === (new_atomic_numbers[i] & 0xff)) continue
			captured_site_ids.push(sid)
			captured_elements.push(old)
			mgr.set_element(slot, new_atomic_numbers[i])
		}

		if (captured_site_ids.length === 0) return
		this.#record({
			kind: 'revert_elements',
			site_ids: new Uint32Array(captured_site_ids),
			elements: new Uint8Array(captured_elements),
		})
	}

	/** Move atoms to absolute positions; records revert-op for undo. */
	move_atoms(
		site_ids: ArrayLike<number>,
		positions: ArrayLike<number>, // interleaved xyz
	): void {
		const n = site_ids.length
		if (n === 0) return
		if (positions.length !== 3 * n) {
			throw new Error(
				`move_atoms: positions.length (${positions.length}) must equal 3 * site_ids.length (${3 * n})`,
			)
		}
		const mgr = this.#mgr
		const captured_site_ids: number[] = []
		const captured_positions: number[] = []

		for (let i = 0; i < n; i++) {
			const sid = site_ids[i]
			const slot = mgr.find_slot_by_site_id(sid)
			if (slot < 0) continue
			const ox = mgr.get_x(slot), oy = mgr.get_y(slot), oz = mgr.get_z(slot)
			const nx = positions[i * 3], ny = positions[i * 3 + 1], nz = positions[i * 3 + 2]
			if (ox === nx && oy === ny && oz === nz) continue
			captured_site_ids.push(sid)
			captured_positions.push(ox, oy, oz)
			mgr.set_position(slot, nx, ny, nz)
		}

		if (captured_site_ids.length === 0) return
		this.#record({
			kind: 'revert_positions',
			site_ids: new Uint32Array(captured_site_ids),
			positions: new Float32Array(captured_positions),
		})
	}

	// ─── Undo / redo ───

	/** Apply the most recent undo-stack op. Returns true if something was undone. */
	undo(): boolean {
		if (this.#undo_stack.length === 0) return false
		const op = this.#undo_stack.pop()!
		const inverse = this.#apply_inverse(op)
		this.#redo_stack.push(inverse)
		return true
	}

	/** Apply the most recent redo-stack op. Returns true if something was redone. */
	redo(): boolean {
		if (this.#redo_stack.length === 0) return false
		const op = this.#redo_stack.pop()!
		const inverse = this.#apply_inverse(op)
		this.#undo_stack.push(inverse)
		return true
	}

	/** Clear both undo and redo stacks. Does not touch the manager. */
	clear(): void {
		this.#undo_stack.length = 0
		this.#redo_stack.length = 0
	}

	// ─── Internals ───

	#apply_inverse(op: UndoOp): UndoOp {
		const mgr = this.#mgr
		switch (op.kind) {
			case 'restore_atoms': {
				// Re-add the atoms that were deleted.
				mgr.add_atoms(op.site_ids, op.positions, op.elements, op.radii)
				return { kind: 'delete_atoms', site_ids: op.site_ids }
			}
			case 'delete_atoms': {
				// Capture data of atoms about to be deleted for the inverse restore op.
				const captured_positions: number[] = []
				const captured_elements: number[] = []
				const captured_radii: number[] = []
				const slots_to_remove: number[] = []
				const matched_site_ids: number[] = []
				for (let i = 0; i < op.site_ids.length; i++) {
					const sid = op.site_ids[i]
					const slot = mgr.find_slot_by_site_id(sid)
					if (slot < 0) continue
					matched_site_ids.push(sid)
					captured_positions.push(mgr.get_x(slot), mgr.get_y(slot), mgr.get_z(slot))
					captured_elements.push(mgr.get_element(slot))
					captured_radii.push(mgr.get_radius(slot))
					slots_to_remove.push(slot)
				}
				mgr.remove_atoms(slots_to_remove)
				return {
					kind: 'restore_atoms',
					site_ids: new Uint32Array(matched_site_ids),
					positions: new Float32Array(captured_positions),
					elements: new Uint8Array(captured_elements),
					radii: new Float32Array(captured_radii),
				}
			}
			case 'revert_elements': {
				const captured: number[] = []
				const matched: number[] = []
				for (let i = 0; i < op.site_ids.length; i++) {
					const sid = op.site_ids[i]
					const slot = mgr.find_slot_by_site_id(sid)
					if (slot < 0) continue
					matched.push(sid)
					captured.push(mgr.get_element(slot))
					mgr.set_element(slot, op.elements[i])
				}
				return {
					kind: 'revert_elements',
					site_ids: new Uint32Array(matched),
					elements: new Uint8Array(captured),
				}
			}
			case 'revert_positions': {
				const captured: number[] = []
				const matched: number[] = []
				for (let i = 0; i < op.site_ids.length; i++) {
					const sid = op.site_ids[i]
					const slot = mgr.find_slot_by_site_id(sid)
					if (slot < 0) continue
					matched.push(sid)
					captured.push(mgr.get_x(slot), mgr.get_y(slot), mgr.get_z(slot))
					mgr.set_position(slot, op.positions[i * 3], op.positions[i * 3 + 1], op.positions[i * 3 + 2])
				}
				return {
					kind: 'revert_positions',
					site_ids: new Uint32Array(matched),
					positions: new Float32Array(captured),
				}
			}
			case 'batch': {
				// Same iteration pattern as BondUndoStack: apply inverses in
				// REVERSE order (last-in-first-out) so composite mutations
				// unwind correctly. Result array is already in order for the
				// next replay (which will again iterate backwards).
				const inverses: UndoOp[] = []
				for (let i = op.ops.length - 1; i >= 0; i--) {
					inverses.push(this.#apply_inverse(op.ops[i]))
				}
				return { kind: 'batch', ops: inverses }
			}
			default: {
				// Exhaustiveness guard: any new UndoOp kind added to the union
				// without a matching case here will fail to compile.
				const _exhaustive: never = op
				throw new Error(`AtomCommandStack.apply_inverse: unhandled op ${JSON.stringify(_exhaustive)}`)
			}
		}
	}

	#record(op: UndoOp): void {
		if (this.#tx_depth > 0) this.#tx_ops.push(op)
		else this.#push_to_undo(op)
	}

	#push_to_undo(op: UndoOp): void {
		this.#undo_stack.push(op)
		this.#redo_stack.length = 0
		if (this.#max > 0 && this.#undo_stack.length > this.#max) {
			this.#undo_stack.shift()
		}
	}
}

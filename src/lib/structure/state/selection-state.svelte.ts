/**
 * Selection State — extracted from Structure.svelte
 *
 * Manages atom/bond selection state, opacity overrides, undo history,
 * and per-atom color picker targets.
 *
 * Uses factory function pattern because $state must be created in component context.
 *
 * ## Undo history (tagged union)
 *
 * The undo stack holds `UndoEntry` values. Each entry carries the minimum
 * data needed to roll back one user-visible action:
 *
 * - `kind: 'structure'` — snapshot of the full structure. Used for any
 *   edit that changes atoms/lattice (atom move, slab cut, adsorbate, etc).
 *   The pencil controller's own `bond_edit_history` runs in lockstep
 *   with these entries to also snapshot bond-array state.
 *
 * - `kind: 'bond'` — an `array_inverse` describing how to roll back
 *   the `manual_bonds` / `deleted_bond_keys` mutation performed by
 *   `delete_selected_bonds` (flag-on path). Manager state is rolled
 *   back separately via `BondUndoStack.undo()` in the dispatcher.
 *
 * - `kind: 'atom'` — an `atom_inverse` describing how to roll back a
 *   sparse atom-delete mutation: the removed Site objects plus the
 *   indices they occupied. Used instead of a full structure snapshot
 *   on Delete keystrokes to avoid O(N) cloning for large structures.
 *
 * - `kind: 'external'` — a `history_token` correlating an edit that an
 *   OUTSIDE owner (the trajectory pane's supercell transaction system)
 *   applied and knows how to reverse. Deliberately carries NO structure
 *   snapshot: the owner toggles its own ledger entry / restores its own
 *   immutable frame references and republishes. Undo/redo of these
 *   entries round-trips the token through `on_external_history_toggle`.
 *
 * On Ctrl+Z the dispatcher in `Structure.svelte` pops the top entry
 * and routes to the appropriate restore path based on `kind`.
 *
 * NOTE: The opacity sync $effect (which applies selection_opacity to per-atom/per-bond
 * overrides) remains in Structure.svelte because it depends on selected_sites and
 * pencil.selected_bonds which are owned externally. Moving it here would require
 * getter deps that add complexity without benefit.
 */

import type { AnyStructure, ManualBond, Site } from '$lib'

// ─── Undo types ───

/**
 * Rollback data for a `delete_selected_bonds` mutation on the
 * `manual_bonds` / `deleted_bond_keys` arrays. Captured BEFORE the
 * mutation runs, so it describes how to reverse it.
 */
export type BondArrayInverse = {
  /** Manual bonds the delete removed; re-add them on undo. */
  restore_manual_bonds: ManualBond[]
  /** Keys the delete newly added to `deleted_bond_keys` (i.e. not already present); remove them on undo. */
  remove_deleted_keys: string[]
}

/**
 * Rollback data for a sparse atom-delete mutation on `structure.sites`.
 * Captured BEFORE the mutation runs. Reinsertion iterates `removed_indices`
 * ascending and inserts each `removed_sites[i]` at `removed_indices[i]` —
 * earlier inserts correctly shift later target indices, reproducing the
 * pre-delete sites array.
 *
 * Site-indexed overrides like `site_color_overrides` / `site_radius_overrides`
 * are not captured here because the site-count-change `$effect` in
 * `Structure.svelte` clears them wholesale on any atom add/delete (this is
 * an existing limitation shared with `kind: 'structure'` undo, not new to
 * atom-kind).
 *
 * `removed_atom_opacity_entries` carries any `atom_opacity_overrides`
 * entries the delete callsite pruned (atom_opacity_overrides is NOT
 * wholesale-cleared by the site-count $effect, so these can be restored
 * faithfully).
 */
export type AtomArrayInverse = {
  /** The deleted Site objects in their original order (parallel to `removed_indices`). */
  removed_sites: Site[]
  /** Indices the Sites were deleted from, sorted ascending. */
  removed_indices: number[]
  /**
   * atom_opacity_overrides entries the delete pruned. Restored on undo.
   * Empty if no overrides were pruned.
   */
  removed_atom_opacity_entries: Array<[number, number]>
}

export type UndoEntry =
  | { kind: 'structure'; structure: AnyStructure }
  | { kind: 'bond'; array_inverse: BondArrayInverse }
  | { kind: 'atom'; atom_inverse: AtomArrayInverse }
  | { kind: 'external'; history_token: string }

/**
 * Redo stack entries. `structure` wraps a forward snapshot (the state the
 * user undid FROM — legacy geometry redo); `external` re-applies an
 * owner-side edit by token, holding no snapshot at all.
 */
export type RedoEntry =
  | { kind: 'structure'; structure: AnyStructure }
  | { kind: 'external'; history_token: string }

// ─── Factory ───

export function create_selection_state() {
  // Tagged undo history (see module-level doc)
  let undo_history: UndoEntry[] = $state([])
  // Redo stack (tagged union, see RedoEntry). Structure-kind entries are
  // forward snapshots captured by undo() (the state the user undid FROM) so
  // redo() can restore them: covers all geometry edits (slab/supercell/
  // lattice/substitute/atom add·move·delete); manual pencil bond edits are
  // not part of redo. External-kind entries carry only the owner's
  // history_token. Any fresh edit (push_*_entry) invalidates the redo branch.
  let redo_history: RedoEntry[] = $state([])
  let selection_history: number[][] = $state([])

  // Selection opacity slider value
  let selection_opacity = $state(1.0)

  // Per-atom and per-bond opacity overrides (persist after deselection)
  let atom_opacity_overrides = $state(new Map<number, number>())
  let bond_opacity_overrides = $state(new Map<string, number>())

  // Opacity undo history stack
  let opacity_history: { atoms: Map<number, number>; bonds: Map<string, number> }[] = $state([])

  // Color picker targets (site indices to apply color to)
  let color_picker_targets: number[] = $state([])

  // ── Undo helpers ──

  const MAX_UNDO_HISTORY = 50

  function trim(next: UndoEntry[]): UndoEntry[] {
    return next.length > MAX_UNDO_HISTORY ? next.slice(-MAX_UNDO_HISTORY) : next
  }

  // `clear_redo` is true for genuine edits (a new action invalidates any
  // redo branch) and false when redo() itself re-pushes an undo entry.
  function push_structure_entry(structure: AnyStructure, clear_redo = true): void {
    const snapshot = $state.snapshot(structure) as AnyStructure
    undo_history = trim([...undo_history, { kind: 'structure', structure: snapshot }])
    if (clear_redo) redo_history = []
  }

  function push_bond_entry(array_inverse: BondArrayInverse): void {
    undo_history = trim([...undo_history, { kind: 'bond', array_inverse }])
    redo_history = []
  }

  function push_atom_entry(atom_inverse: AtomArrayInverse): void {
    undo_history = trim([...undo_history, { kind: 'atom', atom_inverse }])
    redo_history = []
  }

  // External (owner-managed) edit: record only the correlation token — never
  // a structure snapshot. `clear_redo` mirrors push_structure_entry: true for
  // a genuine new edit, false when redo() re-pushes its own undo entry.
  function push_external_entry(history_token: string, clear_redo = true): void {
    undo_history = trim([...undo_history, { kind: 'external', history_token }])
    if (clear_redo) redo_history = []
  }

  /** Pop the most recent entry, or null if empty. Caller dispatches on `kind`. */
  function pop_entry(): UndoEntry | null {
    if (undo_history.length === 0) return null
    const entry = undo_history[undo_history.length - 1]
    undo_history = undo_history.slice(0, -1)
    return entry
  }

  function push_redo_entry(entry: RedoEntry): void {
    redo_history = redo_history.length >= MAX_UNDO_HISTORY
      ? [...redo_history.slice(1), entry]
      : [...redo_history, entry]
  }

  /** Push a forward structure snapshot onto the redo stack (called by undo()). */
  function push_redo(structure: AnyStructure): void {
    const snapshot = $state.snapshot(structure) as AnyStructure
    push_redo_entry({ kind: 'structure', structure: snapshot })
  }

  /** Push an external redo token onto the redo stack (undo() of an external entry). */
  function push_external_redo(history_token: string): void {
    push_redo_entry({ kind: 'external', history_token })
  }

  /** Pop the most recent redo entry, or null. Caller dispatches on `kind`. */
  function pop_redo_entry(): RedoEntry | null {
    if (redo_history.length === 0) return null
    const entry = redo_history[redo_history.length - 1]
    redo_history = redo_history.slice(0, -1)
    return entry
  }

  /** Legacy snapshot-only pop: returns the structure of a structure-kind
   * entry, or null (an external entry is consumed but yields no snapshot).
   * Production dispatch uses pop_redo_entry. */
  function pop_redo(): AnyStructure | null {
    const entry = pop_redo_entry()
    return entry?.kind === 'structure' ? entry.structure : null
  }

  function push_selection_to_undo(selected_sites: number[]) {
    selection_history = [...selection_history, [...selected_sites]]
  }

  return {
    get undo_history() { return undo_history },
    set undo_history(v: UndoEntry[]) { undo_history = v },

    get can_undo(): boolean { return undo_history.length > 0 },
    get can_redo(): boolean { return redo_history.length > 0 },

    /** Oldest 'structure' snapshot, or null. Used as a baseline for diff ops (e.g. PubChem-atom detection). */
    get first_structure_snapshot(): AnyStructure | null {
      for (const e of undo_history) if (e.kind === 'structure') return e.structure
      return null
    },

    get selection_history() { return selection_history },
    set selection_history(v: number[][]) { selection_history = v },

    get selection_opacity() { return selection_opacity },
    set selection_opacity(v: number) { selection_opacity = v },

    get atom_opacity_overrides() { return atom_opacity_overrides },
    set atom_opacity_overrides(v: Map<number, number>) { atom_opacity_overrides = v },

    get bond_opacity_overrides() { return bond_opacity_overrides },
    set bond_opacity_overrides(v: Map<string, number>) { bond_opacity_overrides = v },

    get opacity_history() { return opacity_history },
    set opacity_history(v: { atoms: Map<number, number>; bonds: Map<string, number> }[]) { opacity_history = v },

    get color_picker_targets() { return color_picker_targets },
    set color_picker_targets(v: number[]) { color_picker_targets = v },

    push_structure_entry,
    push_bond_entry,
    push_atom_entry,
    push_external_entry,
    pop_entry,
    push_redo,
    push_external_redo,
    pop_redo,
    pop_redo_entry,
    push_selection_to_undo,
    MAX_UNDO_HISTORY,
  }
}

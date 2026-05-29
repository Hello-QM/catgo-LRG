/**
 * Viewer Controller — pure function helpers for viewer presentation.
 *
 * These complement the reactive viewer-controller.svelte.ts with stateless utilities
 * for context menu section builders, visibility toggles, and rendering helpers.
 *
 * All functions are pure: they take data in and return results without side effects.
 */

import type { AnyStructure } from '$lib/structure'
import type { ManualBond } from '../index'
import { is_image_atom } from './transform-controller'

// ─── Types ───

interface ContextMenuOption {
  value: string
  label: string
  icon?: string
  checked?: boolean
  inline?: boolean
  disabled?: boolean
}

interface ContextMenuSection {
  title: string
  options: ContextMenuOption[]
}

// ─── Context Menu Section Builders ───

/**
 * Build the "Constraints" section for the atom context menu.
 * Handles selective dynamics (freeze/unfreeze per-axis) for periodic structures.
 */
export function build_constraints_section(params: {
  has_vacuum: boolean
  context_menu_target_site: number | null
  selected_sites: number[]
  displayed_structure: AnyStructure | undefined
  structure: AnyStructure | undefined
}): ContextMenuSection[] {
  const { has_vacuum, context_menu_target_site, selected_sites, displayed_structure, structure } = params

  if (!has_vacuum) {
    return [{
      title: 'Constraints',
      options: [{
        value: '_vacuum_hint',
        label: 'Add vacuum to enable freeze',
        disabled: true,
      }],
    }]
  }

  let target_idx = context_menu_target_site ?? (selected_sites.length > 0 ? selected_sites[0] : null)
  if (target_idx !== null && is_image_atom(displayed_structure, target_idx) && (displayed_structure as any)?.image_to_original_map) {
    const num_orig = (displayed_structure as any).num_original_sites ?? 0
    target_idx = (displayed_structure as any).image_to_original_map[target_idx - num_orig] ?? target_idx
  }
  const sd = target_idx !== null && structure
    ? (structure.sites[target_idx]?.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined) ?? [true, true, true]
    : [true, true, true]
  const has_target = context_menu_target_site !== null || selected_sites.length > 0

  return [{
    title: 'Constraints',
    options: [
      { value: 'toggle_freeze_x', label: 'X', checked: !sd[0], inline: true, disabled: !has_target },
      { value: 'toggle_freeze_y', label: 'Y', checked: !sd[1], inline: true, disabled: !has_target },
      { value: 'toggle_freeze_z', label: 'Z', checked: !sd[2], inline: true, disabled: !has_target },
      { value: 'freeze_all', label: 'Freeze all axes', icon: 'Lock', disabled: !has_target },
      { value: 'unfreeze_selected', label: 'Unfreeze selected', icon: 'Unlock', disabled: !has_target },
      { value: 'unfreeze_all', label: 'Unfreeze all', icon: 'Unlock', disabled: !structure?.sites?.length },
    ],
  }]
}

/**
 * Build the "Charge Label" section for the atom context menu.
 */
export function build_charge_label_section(params: {
  context_menu_target_site: number | null
  displayed_structure: AnyStructure | undefined
  structure: AnyStructure | undefined
  visible_charge_labels: Set<number>
}): ContextMenuSection[] {
  const { context_menu_target_site, displayed_structure, structure, visible_charge_labels } = params

  let charge_target_idx = context_menu_target_site
  if (charge_target_idx !== null && is_image_atom(displayed_structure, charge_target_idx) && (displayed_structure as any)?.image_to_original_map) {
    const num_orig = (displayed_structure as any).num_original_sites ?? 0
    charge_target_idx = (displayed_structure as any).image_to_original_map[charge_target_idx - num_orig] ?? charge_target_idx
  }
  const has_charge = charge_target_idx !== null && structure
    ? typeof structure.sites[charge_target_idx]?.properties?.bader_charge === 'number'
    : false
  const any_charges = structure?.sites?.some((s) => typeof s.properties?.bader_charge === 'number') ?? false

  return [{
    title: 'Charge Label',
    options: [
      {
        value: 'toggle_charge_label',
        label: visible_charge_labels.has(charge_target_idx ?? -1) ? 'Hide charge label' : 'Show charge label',
        checked: visible_charge_labels.has(charge_target_idx ?? -1),
        disabled: charge_target_idx === null || !has_charge,
      },
      {
        value: 'set_charge_value',
        label: 'Set charge value...',
        disabled: charge_target_idx === null || !structure,
      },
      {
        value: 'show_all_charge_labels',
        label: 'Show all charge labels',
        disabled: !any_charges,
      },
      {
        value: 'hide_all_charge_labels',
        label: 'Hide all charge labels',
        disabled: visible_charge_labels.size === 0,
      },
    ],
  }]
}

// ─── Bond Editing Helpers ───

/**
 * Validate manual bonds and deleted bond keys after structure site count changes.
 * Returns cleaned versions, or null if no cleaning was needed.
 */
export function validate_bond_edits(
  manual_bonds: ManualBond[],
  deleted_bond_keys: Set<string>,
  new_site_count: number,
): {
  manual_bonds: ManualBond[] | null
  deleted_bond_keys: Set<string> | null
} {
  const max_idx = new_site_count - 1

  const valid_manual = manual_bonds.filter(
    (b) => b.site_idx_1 <= max_idx && b.site_idx_2 <= max_idx,
  )
  const manual_changed = valid_manual.length !== manual_bonds.length

  const valid_deleted = new Set(
    [...deleted_bond_keys].filter((key) => {
      const [a, b] = key.split('-').map(Number)
      return a <= max_idx && b <= max_idx
    }),
  )
  const deleted_changed = valid_deleted.size !== deleted_bond_keys.size

  return {
    manual_bonds: manual_changed ? valid_manual : null,
    deleted_bond_keys: deleted_changed ? valid_deleted : null,
  }
}

/** Count of deleted indices strictly below `idx` (binary search on a sorted
 *  ascending array). This is the amount a surviving atom at `idx` shifts down
 *  when the deleted atoms are removed. */
function count_deleted_below(sorted_deleted: readonly number[], idx: number): number {
  let lo = 0
  let hi = sorted_deleted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted_deleted[mid] < idx) lo = mid + 1
    else hi = mid
  }
  return lo
}

function to_sorted_deleted(deleted_indices: readonly number[] | ReadonlySet<number>): number[] {
  const arr = deleted_indices instanceof Set ? [...deleted_indices] : [...(deleted_indices as readonly number[])]
  return arr.sort((a, b) => a - b)
}

/**
 * Reindex manual bonds + deleted-bond keys after atom INDICES are deleted.
 *
 * Deleting atoms RENUMBERS survivors: a surviving atom at old index `i` moves
 * to `i - (count of deleted indices below i)`. Bond-edit state keyed by atom
 * index must follow that shift, NOT merely be pruned (which is all
 * `validate_bond_edits` does). Without the shift, a survivor bond's renumbered
 * pair can collide with a STALE deleted-bond key and get filtered out of the
 * render — the "delete one atom, an unrelated bond vanishes" bug.
 *
 * Entries referencing a deleted atom are dropped. Pure: no WASM, no recompute.
 */
export function reindex_bond_edits(
  manual_bonds: ManualBond[],
  deleted_bond_keys: Set<string>,
  deleted_indices: readonly number[] | ReadonlySet<number>,
): { manual_bonds: ManualBond[]; deleted_bond_keys: Set<string> } {
  const deleted = deleted_indices instanceof Set ? deleted_indices : new Set(deleted_indices)
  const sorted = to_sorted_deleted(deleted)
  const shift = (idx: number): number => count_deleted_below(sorted, idx)

  const next_manual: ManualBond[] = []
  for (const b of manual_bonds) {
    if (deleted.has(b.site_idx_1) || deleted.has(b.site_idx_2)) continue
    next_manual.push({ ...b, site_idx_1: b.site_idx_1 - shift(b.site_idx_1), site_idx_2: b.site_idx_2 - shift(b.site_idx_2) })
  }

  const next_keys = new Set<string>()
  for (const key of deleted_bond_keys) {
    // `lo-hi` (home cell) or `lo-hi-dx,dy,dz` (cross-cell jimage; dx may be negative).
    const m = key.match(/^(\d+)-(\d+)(?:-(.*))?$/)
    if (!m) { next_keys.add(key); continue } // unrecognized format — leave verbatim
    const a = Number(m[1])
    const b = Number(m[2])
    const suffix = m[3]
    if (deleted.has(a) || deleted.has(b)) continue
    const na = a - shift(a)
    const nb = b - shift(b)
    const lo = Math.min(na, nb)
    const hi = Math.max(na, nb)
    next_keys.add(suffix === undefined ? `${lo}-${hi}` : `${lo}-${hi}-${suffix}`)
  }

  return { manual_bonds: next_manual, deleted_bond_keys: next_keys }
}

/**
 * Reindex a Set of site indices (e.g. `hidden_sites`, selection) after atom
 * deletion: shift survivors down by the count of deleted indices below them;
 * drop any index that was itself deleted. Keeps per-site UI state attached to
 * the same physical atom after renumbering.
 */
export function reindex_site_indices(
  indices: ReadonlySet<number>,
  deleted_indices: readonly number[] | ReadonlySet<number>,
): Set<number> {
  const deleted = deleted_indices instanceof Set ? deleted_indices : new Set(deleted_indices)
  const sorted = to_sorted_deleted(deleted)
  const next = new Set<number>()
  for (const idx of indices) {
    if (deleted.has(idx)) continue
    next.add(idx - count_deleted_below(sorted, idx))
  }
  return next
}

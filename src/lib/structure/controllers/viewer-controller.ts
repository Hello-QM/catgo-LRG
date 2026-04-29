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

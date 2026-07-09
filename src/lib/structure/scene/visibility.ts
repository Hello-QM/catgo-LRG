/**
 * Pure visibility and filtering functions extracted from StructureScene.svelte.
 * No Svelte or Threlte imports — only data in, data out.
 */

import type { AnyStructure, BondPair, PymatgenLattice, Site } from '$lib/structure'
import type { ElementSymbol } from '$lib'
import type { ShowBonds } from '$lib/settings'
import type { Vec3 } from '$lib/math'
import type { AtomPropertyColors } from '../atom-properties'
import { get_orig_site_idx } from '../atom-properties'

/** Determine whether bonds should be shown based on the show_bonds setting and lattice. */
export function should_show_bonds(
  show_bonds: ShowBonds,
  lattice: PymatgenLattice | null,
): boolean {
  return (
    show_bonds === `always` ||
    (show_bonds === `crystals` && lattice !== null) ||
    (show_bonds === `molecules` && lattice === null)
  )
}

/** During drag, filter out cross-bonds (one atom selected, one not). */
export function filter_bonds_during_drag<T extends { site_idx_1: number; site_idx_2: number }>(
  bonds: T[],
  selected_sites: number[],
): T[] {
  const selected_set = new Set(selected_sites)
  return bonds.filter((bond) => {
    const atom1_selected = selected_set.has(bond.site_idx_1)
    const atom2_selected = selected_set.has(bond.site_idx_2)
    return atom1_selected === atom2_selected
  })
}

/**
 * Filter bond pairs by hidden elements, hidden sites, hidden property values,
 * deleted bonds, invalid transforms, and element-pair distance rules.
 */
export function filter_bond_pairs(opts: {
  bond_pairs: BondPair[]
  bond_struct_sites: Site[]
  hidden_elements: Set<ElementSymbol>
  hidden_sites: Set<number>
  hidden_prop_vals: Set<number | string>
  deleted_bond_keys: Set<string>
  bond_distance_rules: { element_1: string; element_2: string; min_dist: number; max_dist: number }[]
  property_colors: AtomPropertyColors | null
  get_bond_key: (a: number, b: number) => string
}): BondPair[] {
  const {
    bond_pairs,
    bond_struct_sites,
    hidden_elements,
    hidden_sites,
    hidden_prop_vals,
    deleted_bond_keys,
    bond_distance_rules,
    property_colors,
    get_bond_key,
  } = opts

  // Build element-pair distance rule lookup map
  const rule_map = new Map<string, { min: number; max: number }>()
  for (const r of bond_distance_rules) {
    const key = [r.element_1, r.element_2].sort().join(`-`)
    rule_map.set(key, { min: r.min_dist, max: r.max_dist })
  }

  const is_site_visible = (site_idx: number): boolean => {
    const site = bond_struct_sites[site_idx]
    const orig_idx = get_orig_site_idx(site, site_idx)
    if (hidden_sites.has(site_idx) || hidden_sites.has(orig_idx)) return false
    const has_visible_element = site?.species.some(
      ({ element }: { element: ElementSymbol }) => !hidden_elements.has(element),
    )
    const prop_val = property_colors?.values[orig_idx]
    const prop_visible = prop_val === undefined || !hidden_prop_vals.has(prop_val)
    return !!has_visible_element && prop_visible
  }

  return bond_pairs.filter((bond) => {
    if (!bond.transform_matrix || bond.transform_matrix.some((v) => !Number.isFinite(v)))
      return false
    const key = get_bond_key(bond.site_idx_1, bond.site_idx_2)
    if (deleted_bond_keys.has(key)) return false
    if (!is_site_visible(bond.site_idx_1) || !is_site_visible(bond.site_idx_2)) return false
    // Per-element-pair distance rule filtering
    if (rule_map.size > 0) {
      const el1 = bond_struct_sites[bond.site_idx_1]?.species[0]?.element
      const el2 = bond_struct_sites[bond.site_idx_2]?.species[0]?.element
      if (el1 && el2) {
        const pair_key = [el1, el2].sort().join(`-`)
        const rule = rule_map.get(pair_key)
        if (rule && (bond.bond_length < rule.min || bond.bond_length > rule.max)) return false
      }
    }
    return true
  })
}

/** Build the cutting visibility lookup map. */
export function build_cutting_visibility_map(
  cutting_active: boolean,
  cutting_atom_visibility: {
    site_idx: number
    inside_slab: boolean
    opacity: number
    saturation: number
  }[],
): Map<number, { inside: boolean; opacity: number; saturation: number }> {
  const map = new Map<number, { inside: boolean; opacity: number; saturation: number }>()
  if (cutting_active && cutting_atom_visibility.length > 0) {
    for (const v of cutting_atom_visibility) {
      map.set(v.site_idx, {
        inside: v.inside_slab,
        opacity: v.opacity ?? 1,
        saturation: v.saturation ?? 1,
      })
    }
  }
  return map
}

/** Whether to show bulk atoms (hidden in slab preview mode). */
export function compute_show_bulk_atoms(
  show_atoms: boolean,
  cutting_active: boolean,
  cutting_preview_mode: string,
): boolean {
  return show_atoms && !(cutting_active && cutting_preview_mode === 'slab')
}

/** Extract lattice from a structure if it has one. */
export function get_lattice(
  structure: AnyStructure | undefined,
): PymatgenLattice | null {
  return structure && `lattice` in structure ? structure.lattice : null
}

/** Compute structure size from lattice parameters or matrix. */
export function compute_structure_size(lattice: PymatgenLattice | null): number {
  if (!lattice) return 10
  // Try direct parameters first
  if (lattice.a !== undefined && lattice.b !== undefined && lattice.c !== undefined) {
    return (lattice.a + lattice.b + lattice.c) / 2
  }
  // Fall back to calculating from matrix
  if (lattice.matrix) {
    const [a_vec, b_vec, c_vec] = lattice.matrix
    const a_len = Math.hypot(a_vec[0], a_vec[1], a_vec[2])
    const b_len = Math.hypot(b_vec[0], b_vec[1], b_vec[2])
    const c_len = Math.hypot(c_vec[0], c_vec[1], c_vec[2])
    return (a_len + b_len + c_len) / 2
  }
  return 10
}

/**
 * Half of the largest atom bounding-box axis (world Å) — the REAL extent of the
 * drawn atoms, independent of any vacuum padding in the lattice. `compute_
 * structure_size` measures the cell, so a molecule dropped in a big vacuum box
 * reports a large size even though the atoms occupy a tiny region; using that
 * for depth-cue fog puts the whole molecule inside the fog interval and washes
 * it uniformly toward the background. Fog range should use THIS instead.
 * Returns null when there are no atoms.
 */
export function compute_atom_span_radius(
  structure: AnyStructure | undefined,
): number | null {
  if (!structure?.sites?.length) return null
  let min_x = Infinity, max_x = -Infinity
  let min_y = Infinity, max_y = -Infinity
  let min_z = Infinity, max_z = -Infinity
  for (const site of structure.sites) {
    const [x, y, z] = site.xyz
    if (x < min_x) min_x = x
    if (x > max_x) max_x = x
    if (y < min_y) min_y = y
    if (y > max_y) max_y = y
    if (z < min_z) min_z = z
    if (z > max_z) max_z = z
  }
  return Math.max(max_x - min_x, max_y - min_y, max_z - min_z) / 2
}

/**
 * Get frozen atom info from a site's selective_dynamics property.
 * Returns null if no selective_dynamics, or an object describing the frozen state.
 */
export function get_frozen_info(
  site: Site,
): {
  is_fully_frozen: boolean
  is_partially_frozen: boolean
  frozen_axes: string
} | null {
  const sel_dyn = site.properties?.selective_dynamics as
    | [boolean, boolean, boolean]
    | undefined
  if (!sel_dyn) return null
  const is_fully_frozen = !sel_dyn[0] && !sel_dyn[1] && !sel_dyn[2]
  const is_partially_frozen =
    !is_fully_frozen && (!sel_dyn[0] || !sel_dyn[1] || !sel_dyn[2])
  const frozen_axes = ['x', 'y', 'z'].filter((_, i) => !sel_dyn[i]).join(', ')
  return { is_fully_frozen, is_partially_frozen, frozen_axes }
}

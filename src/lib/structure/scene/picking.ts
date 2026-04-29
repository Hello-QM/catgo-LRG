/**
 * Pure picking and selection helper functions extracted from StructureScene.svelte.
 * No Svelte or Threlte imports — only data in, data out.
 */

import type { Site } from '$lib/structure'
import type { Vec3 } from '$lib/math'
import * as measure from '$lib/structure/measure'

/**
 * Toggle a site index in the selected_sites array.
 * Returns the new selected_sites array, or null if the selection limit was reached.
 */
export function toggle_site_selection(
  site_index: number,
  selected_sites: number[],
): number[] | null {
  // Check selection limit
  if (
    !selected_sites.includes(site_index) &&
    selected_sites.length >= measure.MAX_SELECTED_SITES
  ) {
    return null // Limit reached
  }

  const was_selected = selected_sites.includes(site_index)
  return was_selected
    ? selected_sites.filter((idx) => idx !== site_index)
    : [...selected_sites, site_index]
}

/**
 * Clean measured_sites by removing indices that are out of bounds.
 * Returns the cleaned array.
 */
export function clean_measured_sites(
  measured_sites: number[],
  site_count: number,
): number[] {
  if (site_count <= 0) return []
  return measured_sites.filter((idx) => idx >= 0 && idx < site_count)
}

/**
 * Check if an atom is pickable (not hidden by cutting plane).
 */
export function is_atom_pickable(
  site_idx: number,
  cutting_active: boolean,
  cutting_visibility_map: Map<number, { inside: boolean; opacity: number; saturation: number }>,
): boolean {
  if (!cutting_active || cutting_visibility_map.size === 0) return true
  const vis = cutting_visibility_map.get(site_idx)
  if (!vis) return true
  return vis.inside
}

/**
 * Build highlight entries for selected and active sites.
 */
export function build_highlight_entries(
  selected_sites: number[],
  active_sites: number[],
  structure_sites: Site[] | undefined,
  pulse_opacity: number,
  selection_highlight_color: string,
  active_highlight_color: string,
): {
  kind: string
  site: Site | null
  site_idx: number
  opacity: number
  color: string
}[] {
  return [
    ...(selected_sites ?? []).map((idx) => ({
      kind: `selected`,
      site: structure_sites?.[idx] ?? null,
      site_idx: idx,
      opacity: pulse_opacity,
      color: selection_highlight_color,
    })),
    ...(active_sites ?? []).map((idx) => ({
      kind: `active`,
      site: structure_sites?.[idx] ?? null,
      site_idx: idx,
      opacity: pulse_opacity,
      color: active_highlight_color,
    })),
  ]
}

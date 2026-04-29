/**
 * Analysis Controller — pure function helpers for structure analysis.
 *
 * These complement the reactive analysis.svelte.ts with stateless utilities
 * for measurement management and structure element queries.
 *
 * All functions are pure: they take data in and return results without side effects.
 */

import type { AnyStructure } from '$lib/structure'
import type { Measurement } from '../index'

// ─── Measurement Helpers ───

/**
 * Delete a measurement by ID from the measurements array.
 * Returns the filtered array and whether the legacy measured_sites should be cleared.
 */
export function delete_measurement_from_list(
  measurements: Measurement[],
  id: string,
): { measurements: Measurement[]; clear_legacy: boolean } {
  if (!measurements.some((m) => m.id === id)) {
    return { measurements, clear_legacy: false }
  }
  return {
    measurements: measurements.filter((m) => m.id !== id),
    clear_legacy: id.startsWith('legacy-'),
  }
}

/**
 * Filter measurements to remove references to deleted atom indices.
 * Removes measurements that have no remaining valid sites.
 */
export function prune_measurements(
  measurements: Measurement[],
  max_valid_index: number,
): Measurement[] {
  return measurements
    .map((m) => ({
      ...m,
      sites: m.sites.filter((idx) => idx <= max_valid_index),
    }))
    .filter((m) => m.sites.length > 0)
}

// ─── Element Queries ───

/**
 * Compute sorted unique element symbols from a structure.
 * Returns empty array if structure is undefined or has no sites.
 */
export function compute_unique_elements(structure: AnyStructure | undefined): string[] {
  if (!structure?.sites) return []
  const elements = new Set<string>()
  for (const site of structure.sites) {
    const el = site.species?.[0]?.element
    if (el) elements.add(el)
  }
  return [...elements].sort()
}

// ─── Charge Validation ───

/**
 * Check if a structure has any Bader charge data in site properties.
 */
export function has_any_charges(structure: AnyStructure | undefined): boolean {
  return (
    structure?.sites?.some(
      (s) => typeof s.properties?.bader_charge === 'number',
    ) ?? false
  )
}

/**
 * Check if a specific site has Bader charge data.
 */
export function site_has_charge(
  structure: AnyStructure | undefined,
  site_idx: number | null,
): boolean {
  if (site_idx === null || !structure) return false
  return typeof structure.sites[site_idx]?.properties?.bader_charge === 'number'
}

/**
 * Prune visible charge labels when structure changes.
 * Removes labels for indices that no longer exist or no longer have charge data.
 *
 * @returns Pruned set, or null if no pruning was needed.
 */
export function prune_charge_labels(
  structure: AnyStructure,
  visible_labels: Set<number>,
): Set<number> | null {
  const max_idx = structure.sites.length - 1
  const pruned = new Set(
    [...visible_labels].filter(
      (idx) =>
        idx <= max_idx &&
        typeof structure.sites[idx]?.properties?.bader_charge === 'number',
    ),
  )
  if (pruned.size !== visible_labels.size) {
    return pruned
  }
  return null
}

/**
 * Transform Controller — pure function helpers for structure transformation pipeline.
 *
 * These complement the reactive transform-controller.svelte.ts with stateless utilities
 * for image atom index mapping, import positioning, and charge application.
 *
 * All functions are pure: they take data in and return results without side effects.
 */

import type { AnyStructure } from '$lib/structure'
import type { Vec3 } from '$lib/math'
import { get_center_of_mass } from '$lib/structure'

// ─── Image Atom Helpers ───

/**
 * Check if a site index refers to an image atom (PBC-expanded, not part of original cell).
 * Returns false if the structure has no image atom metadata.
 */
export function is_image_atom(
  displayed_structure: AnyStructure | undefined,
  idx: number,
): boolean {
  const num_original = (displayed_structure as any)?.num_original_sites
  if (!num_original) return false
  // Image atoms occupy [num_original, displayed_structure.sites.length).
  // Indices beyond that range refer to atoms added after displayed_structure
  // was last derived (e.g. newly placed atoms not yet PBC-expanded) — treat
  // them as originals so drag/move/select operations include them.
  const displayed_count = displayed_structure?.sites?.length ?? 0
  return idx >= num_original && idx < displayed_count
}

/**
 * Check if a selection contains any original (non-image) atoms.
 */
export function has_original_atoms(
  displayed_structure: AnyStructure | undefined,
  indices: number[],
): boolean {
  return indices.some((idx) => !is_image_atom(displayed_structure, idx))
}

/**
 * Map selected indices to original atom indices.
 * Image atoms are mapped to their corresponding original via image_to_original_map.
 * Result is deduplicated and filtered to valid indices.
 */
export function get_original_atoms_only(
  displayed_structure: AnyStructure | undefined,
  structure: AnyStructure | undefined,
  indices: number[],
): number[] {
  const num_original = (displayed_structure as any)?.num_original_sites
  const image_map = (displayed_structure as any)?.image_to_original_map
  const max_idx = structure?.sites?.length ?? 0

  // Stale-expansion guard for the image_to_original_map fallback below: that map
  // is only meaningful while the PBC expansion still matches the base structure
  // (num_original_sites == base count at derivation time). Once the base count
  // diverges (atom added/removed after expansion) a freshly added atom's base
  // index can collide with the stale image range and be mis-mapped, so the
  // fallback is skipped and the raw index passes through.
  const expansion_consistent = num_original === max_idx

  const mapped = indices.map((idx) => {
    // Primary: each displayed site self-describes its base-cell origin —
    // supercell replicas carry orig_unit_cell_idx (= base index), PBC images
    // carry orig_site_idx. This is what makes editing work in a supercell,
    // where displayed_structure is a separate expansion larger than the
    // editable base: every replica/image of one base atom collapses to a
    // single base index, so deleting any replica removes the atom from all
    // mirrored cells (and from the 1x1x1 view once it re-derives).
    const props = (displayed_structure as any)?.sites?.[idx]?.properties
    if (typeof props?.orig_unit_cell_idx === `number`) return props.orig_unit_cell_idx
    if (typeof props?.orig_site_idx === `number`) return props.orig_site_idx
    // Fallback: legacy PBC expansions that recorded only image_to_original_map
    // (no per-site origin property) still map under the consistency guard.
    if (expansion_consistent && num_original && image_map && idx >= num_original) {
      return image_map[idx - num_original] ?? idx
    }
    return idx
  })
  return [...new Set(mapped.filter((idx) => idx < max_idx))]
}

// ─── Import Positioning ───

/**
 * Calculate a position outside the existing structure's bounding box for importing.
 * Places the import above (+z) with padding to avoid overlap.
 *
 * @param existing - The current structure in the viewer
 * @param imported - The structure being imported
 * @param padding - Distance in Angstroms between structures (default 3.0)
 * @returns World-space position [x, y, z] for the imported structure's center of mass
 */
export function get_import_position_outside(
  existing: AnyStructure,
  imported: AnyStructure,
  padding: number = 3.0,
): [number, number, number] {
  // Calculate bounding box of existing structure
  let existing_max_z = -Infinity
  let existing_center_x = 0
  let existing_center_y = 0
  for (const site of existing.sites) {
    existing_max_z = Math.max(existing_max_z, site.xyz[2])
    existing_center_x += site.xyz[0]
    existing_center_y += site.xyz[1]
  }
  existing_center_x /= existing.sites.length
  existing_center_y /= existing.sites.length

  // Calculate bounding box of imported structure
  let imported_min_z = Infinity
  let imported_center_x = 0
  let imported_center_y = 0
  for (const site of imported.sites) {
    imported_min_z = Math.min(imported_min_z, site.xyz[2])
    imported_center_x += site.xyz[0]
    imported_center_y += site.xyz[1]
  }
  imported_center_x /= imported.sites.length
  imported_center_y /= imported.sites.length

  // Position: center of mass offset computation
  const imported_com = get_center_of_mass(imported)
  const offset_from_min_z = imported_com[2] - imported_min_z

  return [
    existing_center_x + (imported_com[0] - imported_center_x),
    existing_center_y + (imported_com[1] - imported_center_y),
    existing_max_z + padding + offset_from_min_z,
  ]
}

// ─── Charge Application ───

/**
 * Apply Bader charge data from an ACF.dat file to a structure.
 * Returns a new structure with bader_charge in site properties, or an error string.
 *
 * @param structure - The structure to apply charges to
 * @param charges - Parsed charge values (one per site)
 * @returns New structure with charges applied
 */
export function apply_charges(
  structure: AnyStructure,
  charges: number[],
): AnyStructure {
  return {
    ...structure,
    sites: structure.sites.map((site, idx) => ({
      ...site,
      properties: { ...site.properties, bader_charge: charges[idx] },
    })),
  }
}

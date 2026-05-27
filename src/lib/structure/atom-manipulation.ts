import type { AnyStructure, ElementSymbol, Site, Vec3 } from '$lib'
import type { ClipboardSite } from '$lib/state.svelte'
import type { PymatgenMolecule, PymatgenStructure } from '$lib/structure'
import { mat3x3_vec3_multiply, matrix_inverse_3x3, transpose_3x3_matrix, type Matrix3x3 } from '$lib/math'
import covalent_radii_data from '$lib/element/single_bond_covalent_radii.json'
import bond_lengths_data from '$lib/element/bond_lengths.json'

// Type for bond length database entries
type BondLengthEntry = {
  single?: number
  double?: number
  triple?: number
  aromatic?: number
}
type BondLengthDatabase = Record<string, BondLengthEntry>

/**
 * Get the bond length between two elements from the database or covalent radii.
 * Returns value in Angstroms.
 *
 * @param element1 - First element symbol
 * @param element2 - Second element symbol (defaults to element1 if not provided)
 * @param bond_order - Bond order: 'single', 'double', 'triple', or 'aromatic' (default: 'single')
 * @returns Bond length in Angstroms, or 1.5 as fallback
 */
export function get_default_bond_length(
  element1: ElementSymbol,
  element2?: ElementSymbol,
  bond_order: 'single' | 'double' | 'triple' | 'aromatic' = 'single',
): number {
  const e2_resolved = element2 ?? element1

  // Create alphabetically sorted key for lookup (e.g., "C-H" not "H-C")
  const [first, second] = [element1, e2_resolved].sort()
  const bond_key = `${first}-${second}`

  // First, try to find in the bond lengths database
  const bond_data = (bond_lengths_data as BondLengthDatabase)[bond_key]
  if (bond_data) {
    // Try requested bond order, then fall back to single
    const length = bond_data[bond_order] ?? bond_data.single
    if (length !== undefined) {
      return length
    }
  }

  // Fall back to sum of covalent radii
  const e1_key = element1 as keyof typeof covalent_radii_data
  const e2_key = e2_resolved as keyof typeof covalent_radii_data

  const radius1 = covalent_radii_data[e1_key]?.covalent_radius_pm
  const radius2 = covalent_radii_data[e2_key]?.covalent_radius_pm

  if (radius1 !== undefined && radius2 !== undefined) {
    // Convert from pm to Angstroms (divide by 100)
    return (radius1 + radius2) / 100
  }

  // Fallback to a reasonable default bond length
  return 1.5
}

/**
 * Get all available bond lengths for a pair of elements.
 * Useful for UI to show available bond orders.
 */
export function get_available_bond_lengths(
  element1: ElementSymbol,
  element2?: ElementSymbol,
): BondLengthEntry | null {
  const e2_resolved = element2 ?? element1
  const [first, second] = [element1, e2_resolved].sort()
  const bond_key = `${first}-${second}`

  return (bond_lengths_data as BondLengthDatabase)[bond_key] ?? null
}

/**
 * Concatenate two structures, placing the incoming structure at a specified position.
 * The result is converted to a molecule (no lattice).
 *
 * @param base - The existing structure
 * @param incoming - The structure to add
 * @param position - Where to place the center of the incoming structure [x, y, z]
 * @returns New molecule with combined atoms
 */
export function concatenate_structures(
  base: AnyStructure,
  incoming: AnyStructure,
  position: Vec3,
): PymatgenMolecule {
  if (!base?.sites || !incoming?.sites) {
    return { sites: base?.sites || incoming?.sites || [], charge: 0 }
  }

  // Calculate the geometric center of the incoming structure
  const incoming_center: Vec3 = [0, 0, 0]
  for (const site of incoming.sites) {
    incoming_center[0] += site.xyz[0]
    incoming_center[1] += site.xyz[1]
    incoming_center[2] += site.xyz[2]
  }
  incoming_center[0] /= incoming.sites.length
  incoming_center[1] /= incoming.sites.length
  incoming_center[2] /= incoming.sites.length

  // Calculate offset to move incoming structure's center to the target position
  const offset: Vec3 = [
    position[0] - incoming_center[0],
    position[1] - incoming_center[1],
    position[2] - incoming_center[2],
  ]

  // Add incoming sites with offset applied
  const incoming_sites: Site[] = incoming.sites.map((site, idx) => ({
    ...site,
    xyz: [
      site.xyz[0] + offset[0],
      site.xyz[1] + offset[1],
      site.xyz[2] + offset[2],
    ] as Vec3,
    abc: [
      site.xyz[0] + offset[0],
      site.xyz[1] + offset[1],
      site.xyz[2] + offset[2],
    ] as Vec3, // For molecules, abc = xyz
    label: site.label || `${site.species[0]?.element || 'X'}${idx + 1}`,
  }))

  // Combine sites - base sites keep their xyz, just clear abc to match xyz
  const base_sites: Site[] = base.sites.map((site) => ({
    ...site,
    abc: site.xyz, // For molecules, abc = xyz
  }))

  // Return as molecule (no lattice)
  return {
    sites: [...base_sites, ...incoming_sites],
    charge: (base.charge || 0) + (incoming.charge || 0),
  }
}

/**
 * Merge two structures, preserving the base structure's lattice.
 * The incoming structure's atoms are placed at the specified position.
 *
 * @param base - The existing structure (lattice is preserved from this)
 * @param incoming - The structure to add
 * @param position - Where to place the center of the incoming structure [x, y, z] in Cartesian coords
 * @returns New structure with combined atoms and base's lattice
 */
export function merge_structures(
  base: AnyStructure,
  incoming: AnyStructure,
  position: Vec3,
): AnyStructure {
  if (!base?.sites || !incoming?.sites) {
    return base || incoming || { sites: [] }
  }

  // Calculate the geometric center of the incoming structure
  const incoming_center: Vec3 = [0, 0, 0]
  for (const site of incoming.sites) {
    incoming_center[0] += site.xyz[0]
    incoming_center[1] += site.xyz[1]
    incoming_center[2] += site.xyz[2]
  }
  incoming_center[0] /= incoming.sites.length
  incoming_center[1] /= incoming.sites.length
  incoming_center[2] /= incoming.sites.length

  // Calculate offset to move incoming structure's center to the target position
  const offset: Vec3 = [
    position[0] - incoming_center[0],
    position[1] - incoming_center[1],
    position[2] - incoming_center[2],
  ]

  // Pick the lattice for the merged result. Prefer the base's lattice; but if
  // the base is lattice-less (a molecule) while the incoming structure is a
  // periodic crystal, ADOPT the incoming lattice — otherwise merging a crystal
  // onto a molecule silently drops the crystal's cell and demotes it to a
  // molecule (the TiO2-becomes-molecular bug).
  const base_lattice = (base as PymatgenStructure).lattice
  const incoming_lattice = (incoming as PymatgenStructure).lattice
  const merged_lattice = base_lattice?.matrix
    ? base_lattice
    : (incoming_lattice?.matrix ? incoming_lattice : null)
  // True when we took the incoming lattice because base had none — base sites'
  // abc are then cartesian placeholders and must be recomputed below.
  const adopted_incoming_lattice = !base_lattice?.matrix && !!merged_lattice?.matrix

  // Calculate inverse lattice matrix for converting xyz to abc
  let inv_matrix: Matrix3x3 | null = null
  if (merged_lattice?.matrix) {
    inv_matrix = matrix_inverse_3x3(transpose_3x3_matrix(merged_lattice.matrix))
  }

  // Add incoming sites with offset applied
  const incoming_sites: Site[] = incoming.sites.map((site, idx) => {
    const new_xyz: Vec3 = [
      site.xyz[0] + offset[0],
      site.xyz[1] + offset[1],
      site.xyz[2] + offset[2],
    ]

    // Calculate fractional coordinates if we have a lattice
    let new_abc: Vec3 = new_xyz
    if (inv_matrix) {
      new_abc = mat3x3_vec3_multiply(inv_matrix, new_xyz)
    }

    return {
      ...site,
      xyz: new_xyz,
      abc: new_abc,
      label: site.label ||
        `${site.species[0]?.element || 'X'}${base.sites.length + idx + 1}`,
    }
  })

  // When we adopted the incoming lattice, the base sites' abc were cartesian
  // placeholders (base had no cell) — recompute them against the merged lattice.
  const base_sites: Site[] = (adopted_incoming_lattice && inv_matrix)
    ? base.sites.map(site => ({ ...site, abc: mat3x3_vec3_multiply(inv_matrix!, site.xyz) }))
    : base.sites

  // Combine sites
  const combined_sites = [...base_sites, ...incoming_sites]

  // Return with the merged lattice (base's, or incoming's if base had none).
  if (merged_lattice?.matrix) {
    return {
      ...(base as PymatgenStructure),
      lattice: merged_lattice,
      sites: combined_sites,
      charge: (base.charge || 0) + (incoming.charge || 0),
    }
  }

  // Neither structure has a lattice - return as molecule
  return {
    sites: combined_sites,
    charge: (base.charge || 0) + (incoming.charge || 0),
  }
}

/**
 * Add a new atom to the structure at a specified position.
 *
 * @param structure - The structure to modify
 * @param element - Element symbol for the new atom
 * @param xyz_position - Cartesian coordinates [x, y, z] in Angstroms
 * @returns New structure with added atom
 */
export function add_atom(
  structure: AnyStructure,
  element: ElementSymbol,
  xyz_position: Vec3,
): AnyStructure {
  if (!structure?.sites) return structure

  // Calculate fractional coordinates for crystal structures
  let abc_position = xyz_position
  if ('lattice' in structure && structure.lattice) {
    const lattice = structure.lattice as PymatgenStructure['lattice']
    // Convert Cartesian coordinates to fractional coordinates
    // fractional = inverse(transpose(matrix)) · cartesian
    const lattice_transposed = transpose_3x3_matrix(lattice.matrix)
    const inv_matrix = matrix_inverse_3x3(lattice_transposed)
    abc_position = mat3x3_vec3_multiply(inv_matrix, xyz_position)
  }

  // Create new site — do NOT include oxidation_state: 0, it makes pymatgen
  // serialize as "C0+" instead of "C" in XYZ/CIF output
  const new_site: Site = {
    species: [
      {
        element,
        occu: 1,
      },
    ],
    abc: abc_position,
    xyz: xyz_position,
    label: element,
    properties: {},
  }

  // Add site to structure
  return {
    ...structure,
    sites: [...structure.sites, new_site],
  }
}

/**
 * Add multiple atoms to a structure at once (avoids N intermediate copies).
 */
export function add_atoms(
  structure: AnyStructure,
  atoms: { element: ElementSymbol; xyz: Vec3 }[],
): AnyStructure {
  if (!structure?.sites || atoms.length === 0) return structure

  // Pre-compute inverse matrix once for all atoms
  let inv_matrix: [Vec3, Vec3, Vec3] | null = null
  if ('lattice' in structure && structure.lattice) {
    const lattice = structure.lattice as PymatgenStructure['lattice']
    const lattice_transposed = transpose_3x3_matrix(lattice.matrix)
    inv_matrix = matrix_inverse_3x3(lattice_transposed)
  }

  const new_sites: Site[] = atoms.map(({ element, xyz }) => {
    const abc = inv_matrix ? mat3x3_vec3_multiply(inv_matrix, xyz) : xyz
    return {
      species: [{ element, occu: 1 }],
      abc,
      xyz,
      label: element,
      properties: {},
    }
  })

  return {
    ...structure,
    sites: [...structure.sites, ...new_sites],
  }
}

/**
 * Delete atoms from the structure by their indices.
 *
 * @param structure - The structure to modify
 * @param site_indices - Indices of sites to delete
 * @returns New structure with deleted atoms removed
 */
export function delete_atoms(
  structure: AnyStructure,
  site_indices: number[],
): AnyStructure {
  if (!structure?.sites || site_indices.length === 0) return structure

  // Create set for O(1) lookup
  const indices_set = new Set(site_indices)

  // Filter out sites at the specified indices
  const new_sites = structure.sites.filter((_, idx) => !indices_set.has(idx))

  return {
    ...structure,
    sites: new_sites,
  }
}

/**
 * Replace an atom at a specific index with a different element.
 *
 * @param structure - The structure to modify
 * @param site_index - Index of site to replace
 * @param new_element - New element symbol
 * @returns New structure with replaced atom
 */
export function replace_atom(
  structure: AnyStructure,
  site_index: number,
  new_element: ElementSymbol,
): AnyStructure {
  if (!structure?.sites || site_index < 0 || site_index >= structure.sites.length) {
    return structure
  }

  const new_sites = structure.sites.map((site, idx) => {
    if (idx !== site_index) return site

    return {
      ...site,
      species: [
        {
          element: new_element,
          occu: 1,
          oxidation_state: 0,
        },
      ],
      label: new_element,
    }
  })

  return {
    ...structure,
    sites: new_sites,
  }
}

/**
 * Move a single atom to a new position.
 *
 * @param structure - The structure to modify
 * @param site_index - Index of the atom to move
 * @param new_xyz_position - New absolute Cartesian coordinates [x, y, z] in Angstroms
 * @returns New structure with the moved atom
 */
export function move_atom(
  structure: AnyStructure,
  site_index: number,
  new_xyz_position: Vec3,
): AnyStructure {
  if (!structure?.sites || site_index < 0 || site_index >= structure.sites.length) {
    return structure
  }

  // Calculate fractional coordinates for crystal structures
  let new_abc_position = new_xyz_position
  if ('lattice' in structure && structure.lattice) {
    const lattice = structure.lattice as PymatgenStructure['lattice']
    const lattice_transposed = transpose_3x3_matrix(lattice.matrix)
    const inv_matrix = matrix_inverse_3x3(lattice_transposed)
    new_abc_position = mat3x3_vec3_multiply(inv_matrix, new_xyz_position)
  }

  const new_sites = structure.sites.map((site, idx) => {
    if (idx !== site_index) return site

    return {
      ...site,
      xyz: new_xyz_position,
      abc: new_abc_position,
    }
  })

  return {
    ...structure,
    sites: new_sites,
  }
}

/**
 * Move multiple atoms by applying a displacement vector to each.
 *
 * @param structure - The structure to modify
 * @param site_indices - Indices of atoms to move
 * @param displacement - [dx, dy, dz] displacement vector in Angstroms
 * @returns New structure with moved atoms
 */
export function move_atoms_by_displacement(
  structure: AnyStructure,
  site_indices: number[],
  displacement: Vec3,
): AnyStructure {
  if (!structure?.sites || site_indices.length === 0) return structure

  const indices_set = new Set(site_indices)

  // Calculate fractional displacement for crystal structures
  let abc_displacement = displacement
  if ('lattice' in structure && structure.lattice) {
    const lattice = structure.lattice as PymatgenStructure['lattice']
    const lattice_transposed = transpose_3x3_matrix(lattice.matrix)
    const inv_matrix = matrix_inverse_3x3(lattice_transposed)
    abc_displacement = mat3x3_vec3_multiply(inv_matrix, displacement)
  }

  const new_sites = structure.sites.map((site, idx) => {
    if (!indices_set.has(idx)) return site

    return {
      ...site,
      xyz: [
        site.xyz[0] + displacement[0],
        site.xyz[1] + displacement[1],
        site.xyz[2] + displacement[2],
      ] as Vec3,
      abc: [
        site.abc[0] + abc_displacement[0],
        site.abc[1] + abc_displacement[1],
        site.abc[2] + abc_displacement[2],
      ] as Vec3,
    }
  })

  return {
    ...structure,
    sites: new_sites,
  }
}

/**
 * Apply per-atom displacement vectors to a structure.
 * Each atom can have a different displacement (needed for rotations).
 *
 * @param structure - The structure to modify
 * @param displacements - Map from atom index to displacement vector [dx, dy, dz] in Angstroms
 * @returns New structure with displaced atoms
 */
export function apply_per_atom_displacements(
  structure: AnyStructure,
  displacements: Map<number, Vec3>,
): AnyStructure {
  if (!structure?.sites || displacements.size === 0) return structure

  // Precompute inverse lattice matrix if this is a crystal
  let inv_matrix: Matrix3x3 | null = null
  if ('lattice' in structure && structure.lattice) {
    const lattice = structure.lattice as PymatgenStructure['lattice']
    inv_matrix = matrix_inverse_3x3(transpose_3x3_matrix(lattice.matrix))
  }

  const new_sites = structure.sites.map((site, idx) => {
    const disp = displacements.get(idx)
    if (!disp) return site

    const new_xyz: Vec3 = [
      site.xyz[0] + disp[0],
      site.xyz[1] + disp[1],
      site.xyz[2] + disp[2],
    ]

    let new_abc: Vec3
    if (inv_matrix) {
      new_abc = mat3x3_vec3_multiply(inv_matrix, new_xyz)
    } else {
      new_abc = new_xyz
    }

    return {
      ...site,
      xyz: new_xyz,
      abc: new_abc,
    }
  })

  return {
    ...structure,
    sites: new_sites,
  }
}

/**
 * Deep-copy selected sites into clipboard format.
 * Normalizes species to array form, deep-copies xyz/label/properties.
 *
 * @param position_overrides - Optional map of index → visual xyz position.
 *   When atoms are being moved via keyboard/drag but haven't been committed to
 *   the structure yet, this map contains their current visual positions.
 *   Passing it avoids the need to "flush" pending moves before copying.
 */
export function extract_clipboard_sites(
  structure: AnyStructure,
  indices: number[],
  position_overrides?: Map<number, Vec3 | [number, number, number]>,
): ClipboardSite[] {
  if (!structure?.sites) return []

  return indices
    .filter(idx => idx >= 0 && idx < structure.sites.length)
    .map(idx => {
      const site = structure.sites[idx]
      const xyz = position_overrides?.get(idx) ?? site.xyz
      const species_arr = Array.isArray(site.species)
        ? site.species.map(s => ({
            element: s.element as string,
            occu: s.occu ?? 1,
            oxidation_state: s.oxidation_state ?? 0,
          }))
        : [{ element: site.species as unknown as string, occu: 1, oxidation_state: 0 }]

      return {
        species: species_arr,
        xyz: [...xyz] as Vec3,
        label: site.label || species_arr[0].element,
        properties: site.properties ? { ...site.properties } : {},
      }
    })
}

/**
 * Insert clipboard atoms into a structure with cumulative offset.
 * Recalculates abc from xyz using the target structure's lattice.
 *
 * @param offset_multiplier - Increases with each paste (1, 2, 3...) so atoms don't overlap
 */
export function insert_clipboard_sites(
  structure: AnyStructure,
  sites: ClipboardSite[],
  offset_multiplier: number = 1,
): { structure: AnyStructure; new_indices: number[] } {
  if (!structure?.sites || sites.length === 0) {
    return { structure, new_indices: [] }
  }

  const PASTE_OFFSET = 0.5
  const offset = PASTE_OFFSET * offset_multiplier

  // Pre-compute inverse lattice matrix for xyz→abc conversion
  let inv_matrix: [Vec3, Vec3, Vec3] | null = null
  if ('lattice' in structure && structure.lattice) {
    const lattice = structure.lattice as PymatgenStructure['lattice']
    inv_matrix = matrix_inverse_3x3(transpose_3x3_matrix(lattice.matrix))
  }

  const first_new_idx = structure.sites.length
  const new_sites: Site[] = sites.map(site => {
    const new_xyz: Vec3 = [
      site.xyz[0] + offset,
      site.xyz[1] + offset,
      site.xyz[2] + offset,
    ]
    const new_abc: Vec3 = inv_matrix
      ? mat3x3_vec3_multiply(inv_matrix, new_xyz)
      : new_xyz

    return {
      species: site.species as Site['species'],
      xyz: new_xyz,
      abc: new_abc,
      label: site.label || site.species[0]?.element || `X`,
      properties: site.properties || {},
    }
  })

  const new_indices = sites.map((_, i) => first_new_idx + i)

  return {
    structure: { ...structure, sites: [...structure.sites, ...new_sites] },
    new_indices,
  }
}

import { elem_symbols, type ElementSymbol, type Site, type Vec3 } from '$lib'
import type { OptimadeStructure } from '$lib/api/optimade'
import type { PubChemCompound } from '$lib/api/pubchem'
import { extract_atoms_from_pubchem } from '$lib/api/pubchem'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { PymatgenStructure } from '$lib/structure'
import { cartesian_to_fractional, params_to_matrix } from '$lib/structure/lattice-ops'
import {
  type ParsedStructure,
  validate_element_symbol,
} from './common'

// Recursively search for a valid structure object in nested JSON
function find_structure_in_json(
  obj: unknown,
  visited = new WeakSet(),
): ParsedStructure | null {
  // Check if current object is null or undefined
  if (obj === null || obj === undefined) {
    return null
  }

  // If it's not an object, skip it
  if (typeof obj !== `object`) {
    return null
  }

  // Check for circular references
  if (visited.has(obj)) return null
  visited.add(obj)

  // If it's an array, search through each element
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = find_structure_in_json(item, visited)
      if (result) return result
    }
    return null
  }

  // Check if this object looks like a valid structure
  const potential_structure = obj as Record<string, unknown>
  if (is_valid_structure_object(potential_structure)) {
    return normalize_json_structure(potential_structure)
  }

  // Otherwise, recursively search through all properties
  for (const value of Object.values(potential_structure)) {
    const result = find_structure_in_json(value, visited)
    if (result) return result
  }

  return null
}

// Check if an object looks like a valid structure
function is_valid_structure_object(obj: Record<string, unknown>): boolean {
  // Must have sites array
  if (!obj.sites || !Array.isArray(obj.sites)) {
    return false
  }

  // Sites array must not be empty and contain valid site objects
  if (obj.sites.length === 0) {
    return false
  }

  // Check if first site looks valid (has species and coordinates)
  const first_site = obj.sites[0] as Record<string, unknown>
  if (!first_site || typeof first_site !== `object`) {
    return false
  }

  // Must have species (array) or element (string), and either abc or xyz coordinates
  const has_species = Array.isArray(first_site.species) && first_site.species.length > 0
  const has_element = typeof first_site.element === `string` && first_site.element.length > 0
  const has_coordinates = Array.isArray(first_site.abc) || Array.isArray(first_site.xyz)

  return (has_species || has_element) && has_coordinates
}

// Normalize a JSON structure object into ParsedStructure format.
// Handles simplified formats where sites have "element" instead of "species",
// and lattice is given as {a,b,c,alpha,beta,gamma} without a matrix.
function normalize_json_structure(obj: Record<string, unknown>): ParsedStructure | null {
  const sites = obj.sites as Record<string, unknown>[]
  const first_site = sites[0]

  // If sites already have species array, it's standard pymatgen format — return as-is
  if (Array.isArray(first_site.species) && first_site.species.length > 0) {
    return obj as unknown as ParsedStructure
  }

  // Simplified format: sites have "element" string instead of "species" array
  // Convert to standard pymatgen format
  const lattice = obj.lattice as Record<string, unknown> | undefined
  let lattice_out = lattice

  // If lattice has params but no matrix, compute matrix from params
  if (lattice && !lattice.matrix && typeof lattice.a === `number`) {
    const mat = params_to_matrix({
      a: lattice.a as number, b: lattice.b as number, c: lattice.c as number,
      alpha: lattice.alpha as number, beta: lattice.beta as number, gamma: lattice.gamma as number,
    })
    lattice_out = { ...lattice, matrix: mat }
  }

  const normalized_sites = sites.map((site) => {
    if (Array.isArray(site.species) && (site.species as unknown[]).length > 0) return site
    const el = site.element as string
    return {
      ...site,
      species: [{ element: el, occu: 1 }],
    }
  })

  return { ...obj, lattice: lattice_out, sites: normalized_sites } as unknown as ParsedStructure
}

// Parse OPTIMADE JSON format
export function parse_optimade_json(content: string): ParsedStructure | null {
  try {
    const raw = JSON.parse(content) as unknown
    return parse_optimade_from_raw(raw)
  } catch (error) {
    console.error(`Error parsing OPTIMADE JSON:`, error)
    return null
  }
}

// Parse OPTIMADE from already-parsed JSON
export function parse_optimade_from_raw(raw: unknown): ParsedStructure | null {
  try {
    const structure = extract_optimade_structure_from_raw(raw)
    if (!structure) {
      console.error(`No valid OPTIMADE structure found in JSON`)
      return null
    }
    const attrs = structure.attributes

    console.log(`[OPTIMADE] Parsing structure:`, structure.id)
    console.log(`[OPTIMADE] species_at_sites:`, attrs.species_at_sites)
    console.log(`[OPTIMADE] species:`, attrs.species)

    // Inline validation for conciseness
    const positions_raw = (attrs as Record<string, unknown>).cartesian_site_positions
    let species_raw = (attrs as Record<string, unknown>).species_at_sites
    if (!Array.isArray(positions_raw)) {
      console.error(`OPTIMADE JSON missing required cartesian_site_positions`)
      return null
    }

    // Fallback: if species_at_sites is missing, try to build it from the species array.
    // Per OPTIMADE spec, species_at_sites entries are names that map to species[].name.
    // Some providers omit species_at_sites but provide species with one entry per site.
    if (!Array.isArray(species_raw)) {
      const species_objects = (attrs as Record<string, unknown>).species as
        | Array<{ name?: string; chemical_symbols?: string[] }>
        | undefined
      if (Array.isArray(species_objects)) {
        // If species array length matches positions, map name (or first chemical_symbol) per site
        if (species_objects.length === positions_raw.length) {
          species_raw = species_objects.map(
            (s) => s.name ?? s.chemical_symbols?.[0] ?? `X`,
          )
          console.log(`[OPTIMADE] Derived species_at_sites from species array (per-site)`)
        } else if (species_objects.length > 0) {
          // Species array is a lookup table; we can't derive per-site mapping without
          // species_at_sites. Try using species names if there's exactly one species.
          if (species_objects.length === 1 && species_objects[0].name) {
            species_raw = Array(positions_raw.length).fill(species_objects[0].name)
            console.log(`[OPTIMADE] Single species "${species_objects[0].name}" applied to all sites`)
          } else {
            console.error(`OPTIMADE JSON missing species_at_sites and species array doesn't match site count`)
            return null
          }
        }
      }
    }

    if (!Array.isArray(species_raw)) {
      console.error(`OPTIMADE JSON missing required species data (no species_at_sites or species fallback)`)
      return null
    }
    if (positions_raw.length !== species_raw.length) {
      console.error(`OPTIMADE JSON position/species count mismatch`)
      return null
    }
    const positions = positions_raw as number[][]
    const species_at_sites = species_raw as (string | number)[]

    // Optimade stores lattice vectors as rows, so use as is
    const lattice_matrix = attrs.lattice_vectors as Matrix3x3 | undefined
    const species_objects = (attrs as Record<string, unknown>).species as
      | Array<{ name?: string; chemical_symbols?: string[] }>
      | undefined

    // Parse atomic sites
    const sites: Site[] = []
    for (let idx = 0; idx < positions.length; idx++) {
      const pos = positions[idx]
      let element_symbol: string | undefined

      // Handle multiple formats:
      // 1. species_at_sites contains element symbols directly (e.g. "Fe")
      // 2. species_at_sites contains names referencing species[].name (OPTIMADE standard)
      // 3. species_at_sites contains numeric indices into species array
      const species_ref = species_at_sites[idx]

      if (typeof species_ref === 'string') {
        // First check if this is a name referencing the species array
        if (species_objects) {
          const match = species_objects.find(
            (s) => s.name === species_ref,
          )
          if (match?.chemical_symbols && match.chemical_symbols.length > 0) {
            element_symbol = match.chemical_symbols[0]
          }
        }
        // If no match in species array, treat as direct element symbol
        if (!element_symbol) {
          element_symbol = species_ref
        }
      } else if (typeof species_ref === 'number' && species_objects) {
        // Numeric index into species array
        const species_obj = species_objects[species_ref]
        if (species_obj?.chemical_symbols && species_obj.chemical_symbols.length > 0) {
          element_symbol = species_obj.chemical_symbols[0]
        }
      }

      if (!element_symbol) {
        console.error(`[OPTIMADE] Site ${idx}: No element symbol found!`)
      }

      if (!pos || pos.length < 3) {
        console.warn(`Invalid position data at site ${idx}`)
        continue
      }

      const element = validate_element_symbol(element_symbol || '', idx)
      const xyz: Vec3 = [pos[0], pos[1], pos[2]]

      // Calculate fractional coordinates if lattice is available
      let abc: Vec3 = [0, 0, 0]
      if (lattice_matrix) {
        try {
          // Pymatgen convention: xyz = abc @ M (row-vector × matrix)
          // Inverse: abc^T = (M^T)^(-1) · xyz^T
          const lattice_transposed = math.transpose_3x3_matrix(lattice_matrix)
          const lattice_inv = math.matrix_inverse_3x3(lattice_transposed)
          abc = math.mat3x3_vec3_multiply(lattice_inv, xyz)
        } catch {
          // Fallback if matrix inversion fails
          console.warn(
            `Failed to calculate fractional coordinates for OPTIMADE structure`,
          )
        }
      }

      const site: Site = {
        species: [{ element, occu: 1, oxidation_state: 0 }],
        abc,
        xyz,
        label: `${element}${idx + 1}`,
        properties: {},
      }

      sites.push(site)
    }

    if (sites.length === 0) {
      console.error(`No valid sites found in OPTIMADE JSON`)
      return null
    }

    // Create structure object
    let lattice: ParsedStructure[`lattice`] | undefined
    if (lattice_matrix) {
      const lattice_params = math.calc_lattice_params(lattice_matrix)
      lattice = { matrix: lattice_matrix, ...lattice_params }
    }

    const structure_result: ParsedStructure = {
      sites,
      ...(lattice && { lattice }),
    }

    return structure_result
  } catch (error) {
    console.error(`Error parsing OPTIMADE JSON:`, error)
    return null
  }
}

// Check if JSON content is OPTIMADE format by looking for structure attributes
export function is_optimade_json(content: string): boolean {
  try {
    const raw = JSON.parse(content) as unknown
    return is_optimade_raw(raw)
  } catch {
    return false
  }
}

// Check if already-parsed JSON is OPTIMADE-like
export function is_optimade_raw(raw: unknown): boolean {
  return Boolean(extract_optimade_structure_from_raw(raw))
}

// Shared helper to extract an OPTIMADE structure from raw JSON-like data
function extract_optimade_structure_from_raw(raw: unknown): OptimadeStructure | null {
  const payload = unwrap_data(raw)
  const candidate = Array.isArray(payload) ? payload[0] : payload
  if (!is_optimade_structure_object(candidate)) return null
  // Coerce numeric IDs to strings (some providers like OMDB use integer IDs)
  const struct = candidate as OptimadeStructure
  if (typeof (struct as { id: unknown }).id === `number`) {
    ;(struct as { id: string }).id = String((struct as { id: unknown }).id)
  }
  return struct
}

const unwrap_data = (value: unknown): unknown =>
  (value && typeof value === `object` && `data` in (value as Record<string, unknown>))
    ? (value as { data: unknown }).data
    : value

// Type guard: verify minimal OPTIMADE structure shape
function is_optimade_structure_object(value: unknown): value is OptimadeStructure {
  if (!value || typeof value !== `object`) return false
  const obj = value as { type?: unknown; id?: unknown; attributes?: unknown }
  // Accept both string and number IDs — some providers (e.g. OMDB) use numeric IDs
  return obj.type === `structures` && (typeof obj.id === `string` || typeof obj.id === `number`) &&
    typeof obj.attributes === `object` && obj.attributes !== null
}

// ─── PubChem JSON format ───────────────────────────────────────────────────────
// PubChem compound JSON from https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/
// Reuses PubChemCompound type and extract_atoms_from_pubchem from $lib/api/pubchem

export function parse_pubchem_json(raw: unknown): ParsedStructure | null {
  if (!raw || typeof raw !== `object`) return null

  // Detect PubChem format: wrapped in PC_Compounds or has atoms+coords at top level
  const obj = raw as Record<string, unknown>
  let compound: PubChemCompound | null = null
  if (Array.isArray(obj.PC_Compounds) && obj.PC_Compounds.length > 0) {
    compound = obj.PC_Compounds[0] as PubChemCompound
  } else if (obj.atoms && obj.coords) {
    compound = obj as unknown as PubChemCompound
  }
  if (!compound?.atoms?.element?.length) return null

  const { atoms } = extract_atoms_from_pubchem(compound)
  if (atoms.length === 0) return null

  const sites: Site[] = atoms.map((atom) => {
    const element_idx = Math.max(0, Math.min(atom.number - 1, elem_symbols.length - 1))
    const symbol = elem_symbols[element_idx] as ElementSymbol
    const xyz: Vec3 = [atom.x, atom.y, atom.z]
    return {
      species: [{ element: symbol, occu: 1 }],
      abc: [0, 0, 0] as Vec3,
      xyz,
      label: symbol,
      properties: {},
    }
  })

  return { sites, charge: 0 } as unknown as ParsedStructure
}

// ─── Conversion helpers ────────────────────────────────────────────────────────

/**
 * Convert ParsedStructure to PymatgenStructure format
 * Adds the pbc field (periodic boundary conditions) required by PymatgenStructure
 */
export function parsed_to_pymatgen(parsed: ParsedStructure): PymatgenStructure {
  if (parsed.lattice) {
    // Crystal structure: add pbc for all three dimensions
    return {
      sites: parsed.sites,
      lattice: {
        ...parsed.lattice,
        pbc: [true, true, true] as const,
      },
    } as PymatgenStructure
  } else {
    // Molecule (no lattice): return as-is, pbc is implicit [false, false, false]
    return parsed as unknown as PymatgenStructure
  }
}

/**
 * Convert OPTIMADE structure to Pymatgen format
 * Uses native file parsing logic via parse_optimade_from_raw
 */
export function optimade_to_pymatgen(
  optimade_structure: OptimadeStructure,
): PymatgenStructure | null {
  const parsed = parse_optimade_from_raw(optimade_structure)
  if (!parsed) {
    console.error(`[OPTIMADE] Failed to parse structure:`, optimade_structure.id)
    return null
  }
  const result = parsed_to_pymatgen(parsed)
  return {
    ...result,
    id: optimade_structure.id,
  }
}

/**
 * Convert PubChem compound to PymatgenMolecule format (no lattice)
 */
export function pubchem_to_pymatgen(compound: PubChemCompound): PymatgenStructure | null {
  if (!compound.atoms || !compound.atoms.element || compound.atoms.element.length === 0) {
    console.error(`No atoms found in PubChem compound`)
    return null
  }

  try {
    // Extract atoms with coordinates using helper function
    const { atoms: extracted_atoms } = extract_atoms_from_pubchem(compound)

    if (extracted_atoms.length === 0) {
      console.error(`Failed to extract atoms from PubChem compound`)
      return null
    }

    // Convert atoms to sites
    const sites: Site[] = extracted_atoms.map((atom, idx) => {
      // Convert atomic number to element symbol
      const atomic_num = atom.number
      const element_idx = Math.max(0, Math.min(atomic_num - 1, elem_symbols.length - 1))
      const element_symbol = elem_symbols[element_idx]
      const element = validate_element_symbol(element_symbol, idx)

      // Get cartesian coordinates (PubChem uses Angstroms)
      const xyz: Vec3 = [atom.x, atom.y, atom.z]

      // For molecules, fractional coordinates are same as cartesian (no lattice)
      const abc: Vec3 = xyz

      return {
        species: [{ element, occu: 1, oxidation_state: 0 }],
        abc,
        xyz,
        label: `${element}${idx + 1}`,
        properties: {},
      }
    })

    // For molecules without lattice, return as PymatgenMolecule
    // (no lattice property, so pbc is implicit [false, false, false])
    const cid = compound.id?.id?.cid
    return {
      sites,
      id: cid ? String(cid) : undefined,
    } as PymatgenStructure
  } catch (err) {
    console.error(`Error converting PubChem to Pymatgen format:`, err)
    return null
  }
}

// Re-export find_structure_in_json for use in dispatcher
export { find_structure_in_json }

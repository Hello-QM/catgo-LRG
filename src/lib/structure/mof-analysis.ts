// MOF topology analysis frontend module.
// Calls detect_mof_sbus WASM function and provides Node Isolator logic.
// Keeps all MOF-specific logic out of StructureScene.svelte.
//
// Two bond-detection backends:
//   1. CrystalNN (Voronoi + solid angle) — better for complex coordination, default
//   2. atom_radii (covalent radius cutoff) — fast fallback

import type { AnyStructure, BondPair } from '$lib'
import { ensure_ferrox_wasm_ready, crystal_nn_all } from './ferrox-wasm'

// --- Types (match Rust MofClusters output) ---

export type SbuType = `Node` | `Linker` | `Ligand` | `PointOfExtension`
  // Legacy aliases from old Rust serialization
  | `Inorganic` | `Organic`

export interface Sbu {
  atom_indices: number[]
  sbu_type: SbuType
  is_periodic: boolean
  formula: string
}

/** Normalize legacy SBU types to new names. */
export function normalize_sbu_type(t: SbuType): `Node` | `Linker` | `Ligand` | `PointOfExtension` {
  if (t === `Inorganic`) return `Node`
  if (t === `Organic`) return `Linker`
  return t as `Node` | `Linker` | `Ligand` | `PointOfExtension`
}

export interface MofClusters {
  sbus: Sbu[]
  attributions: number[]
  is_mof: boolean
  functional_groups?: FunctionalGroup[]
}

// --- Functional Group types ---
export interface FunctionalGroup {
  atom_indices: number[]
  name: string
  parent_sbu: number
  attachment_atom: number
}

// --- RAC types ---
export interface RacDescriptor {
  scope: string
  property: string
  depth: number
  op: string
  value: number
  name: string
}

export interface RacResult {
  descriptors: RacDescriptor[]
}

// --- WL Hash types ---
export interface WlHashResult {
  sbu_index: number
  hash: number
}

// --- Cap Replacement types ---
export interface MolecularFragment {
  elements: string[]
  cart_coords: [number, number, number][]
  bonding_atom_idx: number
}

// --- Combined analysis result ---
export interface MofAnalysisResult {
  clusters: MofClusters
  bonds_json: string
}

// --- Rust Bond type (with image offsets, unlike frontend BondPair) ---

interface RustBond {
  site_idx_1: number
  site_idx_2: number
  bond_length: number
  strength: number
  image: [number, number, number]
}

// --- Combined analysis: detect bonds + detect SBUs in one call ---

/** Full MOF analysis: detect bonds (covalent radii) → SBU detection.
 *
 *  Uses detect_bonds_radii (NOT CrystalNN) because CrystalNN's Voronoi
 *  approach can miss organic covalent bonds (C-C, C-P), fragmenting linkers/caps.
 *  Covalent radius cutoff reliably finds both coordination and covalent bonds. */
export async function analyze_mof(
  structure: AnyStructure,
): Promise<MofAnalysisResult | null> {
  try {
    const mod = await ensure_ferrox_wasm_ready()
    if (!mod.detect_mof_sbus || !mod.detect_bonds_radii) return null

    const structure_json = JSON.stringify(structure)

    // Step 1: Detect bonds via covalent radii WITH periodic images.
    // Default detect_bonds_radii skips PBC bonds (for visualization anti-aliasing),
    // but MOF topology requires bonds across periodic boundaries.
    const bonds_result = mod.detect_bonds_radii(
      structure_json, JSON.stringify({ include_periodic_images: true }),
    ) as unknown as string
    const bonds: RustBond[] = JSON.parse(bonds_result)
    if (!Array.isArray(bonds) || bonds.length === 0) return null

    // Step 2: Detect SBUs using those bonds
    const bonds_json = JSON.stringify(bonds)
    const result_json = mod.detect_mof_sbus(structure_json, bonds_json) as unknown as string
    const result = JSON.parse(result_json)
    if (result.error) {
      console.warn(`[MOF] detect_mof_sbus error:`, result.error)
      return null
    }
    return { clusters: result as MofClusters, bonds_json }
  } catch (err) {
    console.warn(`[MOF] analyze_mof failed:`, err)
    return null
  }
}

/** Convert CrystalNN neighbor lists to Bond[] for MOF analysis. */
async function bonds_from_crystal_nn(structure: AnyStructure): Promise<RustBond[]> {
  const nn = await crystal_nn_all(structure as any)
  const seen = new Set<string>()
  const bonds: RustBond[] = []

  for (const site of nn) {
    for (const nbr of site.neighbors) {
      // Deduplicate: (i, j, image) and (j, i, -image) are the same bond
      const [lo, hi] = site.site_idx < nbr.site_idx
        ? [site.site_idx, nbr.site_idx]
        : [nbr.site_idx, site.site_idx]
      const img = site.site_idx <= nbr.site_idx
        ? nbr.image
        : [-nbr.image[0], -nbr.image[1], -nbr.image[2]] as [number, number, number]
      const key = `${lo}-${hi}-${img[0]},${img[1]},${img[2]}`
      if (seen.has(key)) continue
      seen.add(key)

      bonds.push({
        site_idx_1: site.site_idx,
        site_idx_2: nbr.site_idx,
        bond_length: nbr.distance,
        strength: nbr.weight,
        image: nbr.image,
      })
    }
  }
  return bonds
}

// --- Low-level WASM call (for use with pre-computed bonds) ---

/** Detect MOF SBUs from structure + bonds via Rust WASM. */
export async function detect_mof_sbus_wasm(
  structure: AnyStructure,
  bonds: BondPair[],
): Promise<MofClusters | null> {
  try {
    const mod = await ensure_ferrox_wasm_ready()
    if (!mod.detect_mof_sbus) return null

    // Convert structure to JSON format expected by Rust
    const structure_json = JSON.stringify(structure)

    // Convert BondPair[] to Rust Bond[] format (needs image field)
    const rust_bonds = bonds.map((b) => ({
      site_idx_1: b.site_idx_1,
      site_idx_2: b.site_idx_2,
      bond_length: b.bond_length,
      strength: b.strength,
      image: (b as any).image ?? [0, 0, 0],
    }))
    const bonds_json = JSON.stringify(rust_bonds)

    const result_json = mod.detect_mof_sbus(structure_json, bonds_json) as unknown as string
    const result = JSON.parse(result_json)
    if (result.error) {
      console.warn(`[MOF] detect_mof_sbus error:`, result.error)
      return null
    }
    return result as MofClusters
  } catch (err) {
    console.warn(`[MOF] detect_mof_sbus failed:`, err)
    return null
  }
}

// --- Node Isolator logic ---

/** Given a clicked atom, find its SBU and all connected SBUs.
 *  Returns a Set of atom indices that should be fully visible. */
export function get_isolated_node_atoms(
  atom_idx: number,
  clusters: MofClusters,
  bonds: BondPair[],
): Set<number> {
  const visible = new Set<number>()

  const sbu_idx = clusters.attributions[atom_idx]
  if (sbu_idx === undefined || sbu_idx >= clusters.sbus.length) return visible

  // Add all atoms in the clicked SBU
  const target_sbu = clusters.sbus[sbu_idx]
  for (const a of target_sbu.atom_indices) visible.add(a)

  // Find connected SBUs (SBUs that share bonds with this one)
  const target_atoms = new Set(target_sbu.atom_indices)
  const connected_sbu_indices = new Set<number>()

  for (const bond of bonds) {
    const a_in = target_atoms.has(bond.site_idx_1)
    const b_in = target_atoms.has(bond.site_idx_2)
    if (a_in && !b_in) {
      connected_sbu_indices.add(clusters.attributions[bond.site_idx_2])
    } else if (!a_in && b_in) {
      connected_sbu_indices.add(clusters.attributions[bond.site_idx_1])
    }
  }

  // Add atoms from connected SBUs
  for (const ci of connected_sbu_indices) {
    if (ci < clusters.sbus.length) {
      for (const a of clusters.sbus[ci].atom_indices) visible.add(a)
    }
  }

  return visible
}

// --- Phase 2 WASM wrappers ---

/** Compute RAC (Revised Autocorrelation) descriptors for a MOF. */
export async function compute_rac(
  structure: AnyStructure,
  bonds_json: string,
  clusters: MofClusters,
): Promise<RacResult | null> {
  try {
    const mod = await ensure_ferrox_wasm_ready()
    if (!mod.compute_rac_descriptors) return null
    const result_json = mod.compute_rac_descriptors(
      JSON.stringify(structure), bonds_json, JSON.stringify(clusters),
    ) as unknown as string
    const result = JSON.parse(result_json)
    if (result.error) { console.warn(`[MOF] RAC error:`, result.error); return null }
    return result as RacResult
  } catch (err) {
    console.warn(`[MOF] compute_rac failed:`, err)
    return null
  }
}

/** Compute Weisfeiler-Leman graph hashes for each SBU. */
export async function compute_wl_hashes(
  structure: AnyStructure,
  bonds_json: string,
  clusters: MofClusters,
): Promise<WlHashResult[] | null> {
  try {
    const mod = await ensure_ferrox_wasm_ready()
    if (!mod.compute_wl_hashes) return null
    const result_json = mod.compute_wl_hashes(
      JSON.stringify(structure), bonds_json, JSON.stringify(clusters),
    ) as unknown as string
    const result = JSON.parse(result_json)
    if (result.error) { console.warn(`[MOF] WL hash error:`, result.error); return null }
    return result as WlHashResult[]
  } catch (err) {
    console.warn(`[MOF] compute_wl_hashes failed:`, err)
    return null
  }
}

/** Replace cap SBUs with a molecular fragment (from SMILES conversion). */
export async function replace_mof_caps(
  structure: AnyStructure,
  bonds_json: string,
  clusters: MofClusters,
  fragment: MolecularFragment,
): Promise<AnyStructure | null> {
  try {
    const mod = await ensure_ferrox_wasm_ready()
    if (!mod.replace_mof_caps) return null
    const result_json = mod.replace_mof_caps(
      JSON.stringify(structure), bonds_json, JSON.stringify(clusters), JSON.stringify(fragment),
    ) as unknown as string
    const result = JSON.parse(result_json)
    if (result.error) { console.warn(`[MOF] cap replace error:`, result.error); return null }
    return result as AnyStructure
  } catch (err) {
    console.warn(`[MOF] replace_mof_caps failed:`, err)
    return null
  }
}

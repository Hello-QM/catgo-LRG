// Pure type definitions and utility functions for ferrox-wasm results.
// This module has no WASM side effects, making it safe to import in tests
// without triggering WASM resolution.

// Result Type Utilities
// The WASM module returns discriminated unions: { ok: T } | { error: string }
export type WasmResult<T> = { ok: T } | { error: string }

// Type guard to check if result is successful
export function is_ok<T>(result: WasmResult<T>): result is { ok: T } {
  return `ok` in result
}

// Type guard to check if result is an error
export function is_error<T>(result: WasmResult<T>): result is { error: string } {
  return `error` in result
}

// Unwrap a successful result or throw an error
export function unwrap<T>(result: WasmResult<T>): T {
  if (is_ok(result)) return result.ok
  throw new Error(result.error)
}

// Unwrap with a default value on error
export function unwrap_or<T>(result: WasmResult<T>, default_value: T): T {
  return is_ok(result) ? result.ok : default_value
}

// Neighbor list result from WASM
export interface NeighborListResult {
  center_indices: number[]
  neighbor_indices: number[]
  image_offsets: [number, number, number][]
  distances: number[]
}

// Matcher configuration options
export interface MatcherOptions {
  latt_len_tol?: number
  site_pos_tol?: number
  angle_tol?: number
  primitive_cell?: boolean
  scale?: boolean
  element_only?: boolean
}

// Structure file format types
export type StructureFormat = `cif` | `poscar` | `json`

// Lattice reduction algorithm types
export type ReductionAlgorithm = `niggli` | `lll`

// Adsorption site types (Alpha Shape V7 algorithm)
export type AdsorptionSiteType = `top` | `bridge` | `hollow3` | `hollow4`

// A single adsorption site
export interface AdsorptionSite {
  /** Unique site ID */
  id: number
  /** Cartesian position [x, y, z] in Å */
  position: [number, number, number]
  /** Type of site */
  site_type: AdsorptionSiteType
  /** Surface normal (unit vector pointing outward) */
  normal: [number, number, number]
  /** Indices of neighboring atoms in the original unit cell */
  neighbor_indices: number[]
  /** Element symbols of neighboring atoms */
  neighbor_elements: string[]
  /** Environment signature (e.g., "Fe-Fe-O") */
  env_signature: string
  /** Height above the surface atoms (Å) */
  height: number
}

// Result from adsorption site finding (Alpha Shape V7)
export interface AdsorptionSiteResult {
  /** All found sites */
  sites: AdsorptionSite[]
  /** Number of top sites */
  n_top: number
  /** Number of bridge sites */
  n_bridge: number
  /** Number of 3-fold hollow sites */
  n_hollow3: number
  /** Number of 4-fold hollow sites */
  n_hollow4: number
}

// Parameters for WASM adsorption site finder (Alpha Shape V7)
export interface AdsorptionSiteFinderParams {
  /** Alpha parameter — circumradius cutoff (Å). Default: 2.7 */
  alpha?: number
  /** Height above surface for site placement (Å). Default: 1.5 */
  height?: number
  /** Distance gap ratio for neighbor detection. Default: 1.2 */
  gap_ratio?: number
  /** Blocking threshold for direct neighbor check. Default: 0.8 */
  blocking?: number
  /** Merge threshold — sites closer than this are merged (Å). 0 = no merge. Default: 1.0 */
  merge?: number
  /** Override PBC detection. null/undefined = auto-detect. */
  pbc?: boolean | null
  /** Keep bottom surface atoms. Default: false */
  keep_bottom?: boolean
  /** Fraction of slab Z range used as bottom cutoff. Default: 0.5 */
  bottom_fraction?: number
  /** Distance threshold for PBC boundary expansion (Å). Default: 3.0 */
  expansion_distance?: number
  /** Filter out internal (non-surface) sites. Default: true */
  filter_internal?: boolean
  /** Search radius for internal site filtering (Å). Default: 5.0 */
  filter_radius?: number
  /** Same-hemisphere ratio threshold for surface filtering. Default: 0.7 */
  filter_threshold?: number
}

// Slab generation types (WASM)
// Note: Prefixed with 'Wasm' to avoid conflicts with TypeScript types in miller-slab.ts
export type WasmGrowthMode = `centered` | `anchor_minus_z` | `anchor_plus_z`

export interface WasmSlabConfig {
  miller_index: [number, number, number]
  offset: number
  thickness: number
  vacuum: number
  growth_mode: WasmGrowthMode
  supercell: [number, number]
}

export interface WasmAtomLayer {
  layer_idx: number
  distance: number
  site_indices: number[]
  thickness: number
}

// Ewald summation types
export interface EwaldResult {
  total_energy: number
  real_energy: number
  recip_energy: number
  self_energy: number
  point_energy: number
}

export interface EwaldAutoResult extends EwaldResult {
  parameters: {
    eta: number
    real_cutoff: number
    recip_cutoff: number
  }
}

// Composition result type
export type CompositionResult = Record<string, number>

// Bond detection types
export interface WasmBond {
  site_idx_1: number
  site_idx_2: number
  bond_length: number
  strength: number
  image: [number, number, number]
}

export interface AtomRadiiBondingOptions {
  /** Tolerance factor for covalent radii sum (default: 0.45) */
  tolerance?: number
  /** Minimum bond distance in Angstroms (default: 0.4) */
  min_bond_dist?: number
  /** Maximum bond distance in Angstroms (default: 5.0) */
  max_bond_dist?: number
}

export interface ElectronegBondingOptions {
  /** Maximum electronegativity difference for bonding (default: 1.7) */
  electronegativity_threshold?: number
  /** Max distance as multiple of sum of covalent radii (default: 2.0) */
  max_distance_ratio?: number
  /** Minimum bond distance in Angstroms (default: 0.4) */
  min_bond_dist?: number
  /** Strength penalty for metal-metal bonds (default: 0.7) */
  metal_metal_penalty?: number
  /** Strength bonus for metal-nonmetal bonds (default: 1.5) */
  metal_nonmetal_bonus?: number
  /** Bonus for similar electronegativity (default: 1.2) */
  similar_electronegativity_bonus?: number
  /** Penalty for bonds between same element (default: 0.5) */
  same_species_penalty?: number
  /** Minimum bond strength to include in results (default: 0.3) */
  strength_threshold?: number
}

export interface SolidAngleBondingOptions {
  /** Minimum solid angle threshold (default: 0.01) */
  min_solid_angle?: number
  /** Minimum face area in Å² (default: 0.05) */
  min_face_area?: number
  /** Maximum search distance in Angstroms (default: 5.0) */
  max_distance?: number
  /** Minimum bond distance in Angstroms (default: 0.4) */
  min_bond_dist?: number
  /** Minimum bond strength to include (default: 0.05) */
  strength_threshold?: number
}

export interface WasmHBondOptions {
  /** Maximum H···A distance in Angstroms (default: 2.5) */
  max_ha_distance?: number
  /** Maximum D···A distance in Angstroms (default: 3.5) */
  max_da_distance?: number
  /** Minimum D-H···A angle in degrees (default: 120) */
  min_angle?: number
}

export interface WasmHydrogenBond {
  h_idx?: number
  donor_idx: number
  acceptor_idx: number
  da_distance: number
  strength: number
}

// =============================================================================
// Optimizer types (UFF/FIRE)
// =============================================================================

/** Configuration for the UFF optimizer */
export interface UFFOptimizerConfig {
  /** Maximum number of optimization steps (default: 100) */
  max_steps?: number
  /** Force convergence threshold in eV/Angstrom (default: 0.05) */
  fmax?: number
  /** Time step for FIRE algorithm (default: 0.1) */
  dt?: number
  /** Maximum atomic displacement per step in Angstrom (default: 0.2) */
  max_move?: number
  /** Cutoff distance for interactions in Angstrom (default: 8.0) */
  cutoff?: number
  /** Indices of atoms that are allowed to move (if undefined or empty, all atoms move) */
  mobile_indices?: number[]
  /** Interval for saving trajectory snapshots (1 = every step, 10 = every 10th step) */
  snapshot_interval?: number
}

/** Single optimization step result */
export interface OptimizationStep {
  step: number
  energy: number
  fmax: number
  converged: boolean
}

/** Full optimization result */
export interface UFFOptimizationResult {
  structure: unknown // Crystal structure
  converged: boolean
  final_energy: number
  final_fmax: number
  energy_terms: EnergyBreakdown
  iterations: number
  history: OptimizationStep[]
  trajectory: unknown[] // Array of pymatgen structures at snapshot intervals
}

/** Single step optimization result */
export interface UFFStepResult {
  structure: unknown // Crystal structure
  energy: number
  fmax: number
  converged: boolean
}

// =============================================================================
// VSEPR Optimizer types
// =============================================================================

/** Configuration for the VSEPR optimizer */
export interface VSEPROptimizerConfig {
  /** Maximum number of optimization iterations (default: 1500) */
  iterations?: number
  /** Force constant for VSEPR repulsion (default: 0.15) */
  force_constant?: number
  /** Indices of atoms that are allowed to move (if undefined or empty, all atoms move) */
  mobile_indices?: number[]
  /** Capture a trajectory snapshot every N iterations. 0 = only initial+final (default: 0) */
  snapshot_interval?: number
}

/** VSEPR optimization result */
export interface VSEPROptimizationResult {
  /** Optimized structure */
  structure: unknown
  /** Number of iterations performed */
  iterations: number
  /** Trajectory: initial + final structures */
  trajectory: unknown[]
}

// =============================================================================
// Updated UFF energy breakdown (from uff-relax)
// =============================================================================

/** Breakdown of UFF energy components */
export interface EnergyBreakdown {
  bond: number
  angle: number
  torsion: number
  non_bonded: number
  total: number
}

// =============================================================================
// Nanoscroll builder
// =============================================================================

/** Parameters controlling nanoscroll construction. All fields optional —
 *  the WASM core fills missing keys with its own defaults. */
export interface NanoscrollParams {
  /** Number of windings (turns). Default 6. */
  turns?: number
  /** Inner winding radius (Å). Default 25. */
  inner_radius?: number
  /** Scroll height along z (Å). Default 12. */
  length?: number
  /** Roll direction: which in-plane lattice vector is rolled. Default "a1". */
  roll_dir?: 'a1' | 'a2'
  /** Van-der-Waals interlayer gap between windings (Å). Default 3.3. */
  interlayer_gap?: number
  /** Local-strain threshold (fraction) above which a curvature warning fires. Default 0.15. */
  strain_warn_threshold?: number
}

/** Metadata describing a constructed nanoscroll. */
export interface NanoscrollInfo {
  turns: number
  inner_radius: number
  outer_radius: number
  length: number
  monolayer_thickness: number
  interlayer_gap: number
  arc_length: number
  /** Supercell tiling [nx, ny] used to cover the spiral. */
  supercell: [number, number]
  n_atoms: number
  /** Maximum local bending strain (fraction; ~thickness / (2·inner_radius)). */
  max_local_strain: number
  /** Curvature-strain warning, present only when the inner radius is too small. */
  warning?: string | null
}

import type { CompositionType, Lattice, StructureScene, Vec3 } from '$lib'
import type { ElementSymbol } from '$lib/labels'
export type { Vec3 } from '$lib/math'
export type { Matrix3x3 } from '$lib/math'
export type { ElementSymbol } from '$lib/labels'
import { atomic_weights } from '$lib/composition/parse'
import { element_data } from '$lib/element'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { ComponentProps } from 'svelte'
import type { Pbc } from './pbc'

export { default as Bond } from './Bond.svelte'
export * as bonding_strategies from './bonding'

export { default as Arrow } from './Arrow.svelte'
export * from './atom-manipulation'
export * from './atom-properties'
export { default as AtomLegend } from './AtomLegend.svelte'
export { default as CanvasTooltip } from './CanvasTooltip.svelte'
export { default as CellSelect } from './CellSelect.svelte'
export { default as Cylinder } from './Cylinder.svelte'
export { default as Lattice } from './Lattice.svelte'
export * from './pbc'
export { default as Structure } from './Structure.svelte'
export { default as StructureControls } from './StructureControls.svelte'
export { default as ExportPane } from './ExportPane.svelte'
export { default as StructureExportPane } from './ExportPane.svelte' // backwards compatibility
export { default as StructureInfoPane } from './StructureInfoPane.svelte'
export { default as StructureLegend } from './StructureLegend.svelte'
export { default as StructureScene } from './StructureScene.svelte'
export { default as LatticePane } from './LatticePane.svelte'
export { default as MillerSlabCutterPane } from './MillerSlabCutterPane.svelte'
export { default as CuttingPlaneVisualizer } from './CuttingPlaneVisualizer.svelte'
export { default as OptimizationPane } from './OptimizationPane.svelte'
export { default as AdsorptionSitePane } from './AdsorptionSitePane.svelte'
export { default as AdsorbatePlacementPane } from './AdsorbatePlacementPane.svelte'
export { default as CubePanel } from './CubePanel.svelte'
export { default as WaterLayerPane } from './WaterLayerPane.svelte'
export { default as PseudoHydrogenPane } from './PseudoHydrogenPane.svelte'
export { default as MoirePane } from './MoirePane.svelte'
export { default as NanotubePane } from './NanotubePane.svelte'
export { default as NanoparticlePane } from './NanoparticlePane.svelte'
export { default as NanoscrollPane } from './NanoscrollPane.svelte'
export { default as HeterostructurePane } from './HeterostructurePane.svelte'
export { default as BuildPane } from './BuildPane.svelte'
export { default as DopingPane } from './DopingPane.svelte'
export { default as DopingPTPanel } from './DopingPTPanel.svelte'
export { default as DopingPTWindow } from './DopingPTWindow.svelte'
export { default as PathwayBuilderPane } from './PathwayBuilderPane.svelte'
export * from './pathway-types'
export * from './pathway-presets'
export * from './pathway-builder'
export { default as AnalysisPane } from './AnalysisPane.svelte'
export { default as WorkflowPane } from './WorkflowPane.svelte'
export { default as IOPane } from './IOPane.svelte'
export { default as ServerPane } from './ServerPane.svelte'
export { default as JobDetailPane } from './JobDetailPane.svelte'
export { default as PluginHubPane } from './PluginHubPane.svelte'
export { default as TerminalPanel } from './TerminalPanel.svelte'
export { default as TerminalWindow } from './TerminalWindow.svelte'
export { default as MonacoEditorPanel } from './MonacoEditorPanel.svelte'
export { default as OptimadePreviewModal } from './OptimadePreviewModal.svelte'
export * from './ferrox-wasm'
export * from './parse-charges'
export * from './lattice-ops'
export * from './miller-slab'
export * from './supercell'
export {
  export_structure_as_cif,
  export_structure_as_extxyz,
  export_structure_as_json,
  export_structure_as_poscar,
  export_structure_as_xyz,
  structure_to_cif_str,
  structure_to_extxyz_str,
  structure_to_json_str,
  structure_to_poscar_str,
  structure_to_xyz_str,
} from './export'

export type Species = {
  element: ElementSymbol
  occu: number
  oxidation_state?: number
}

export type Site = {
  species: Species[]
  abc: Vec3
  xyz: Vec3
  label: string
  properties: Record<string, unknown>
}

export const lattice_param_keys = [
  `a`,
  `b`,
  `c`,
  `alpha`,
  `beta`,
  `gamma`,
] as const

export type LatticeParams = { [key in (typeof lattice_param_keys)[number]]: number }

export type PymatgenLattice = {
  matrix: Matrix3x3
  pbc: Pbc
  volume: number
} & LatticeParams

export type PymatgenMolecule = {
  sites: Site[]
  charge?: number
  id?: string
  properties?: Record<string, unknown>
  /** Session-local electronic-structure metadata stashed by database-import
   * handlers (band gap / efermi / cbm / vbm / magnetism / DOS+bands
   * availability) for the preview overlays. Off the pymatgen schema, so it does
   * NOT survive a backend round-trip — and must be cleared on structural edits
   * (it describes the originally-imported material). */
  _electronic_props?: import('./electronic_preview').ElectronicProps
}
export type PymatgenStructure = PymatgenMolecule & { lattice: PymatgenLattice }

export type Edge = { to_jimage: Vec3; id: number; key: number }

export type Graph = {
  directed: boolean
  multigraph: boolean
  graph: [
    [`edge_weight_name`, null] | [`edge_weight_units`, null] | [`name`, string],
  ]
  nodes: { id: number }[]
  adjacency: Edge[][]
}

export type StructureGraph = {
  '@module': string
  '@class': string
  structure: PymatgenStructure
  graphs: Graph[]
}

// Bond pair with position vectors, site indices, bond length, strength score, and transformation matrix
export type BondPair = {
  pos_1: Vec3
  pos_2: Vec3
  site_idx_1: number
  site_idx_2: number
  bond_length: number
  strength: number
  transform_matrix: Float32Array
  bond_type?: 'covalent' | 'hydrogen' // default 'covalent'
  /**
   * Lattice translation applied to the partner atom (site_idx_2) when this bond
   * is periodic. For intra-cell bonds this is `[0, 0, 0]`. For cross-cell bonds
   * the partner's effective position is `pos_2 + lattice·jimage` (rows of the
   * lattice matrix are the lattice vectors a, b, c). Required since Phase 2
   * of the PBC half-bond refactor — every BondPair must carry a jimage even
   * if it is the zero vector (molecules, intra-cell bonds, manual bonds).
   */
  jimage: [number, number, number]
  /**
   * Perceived bond order for adsorbate fragments: 1 (single, default), 1.5
   * (aromatic), 2 (double), 3 (triple). Purely additive — only the multi-bond
   * instanced renderer reads it, and only when `bond_order_perception` is on.
   * Absent / 1 renders as a plain single stick, byte-identical to today.
   */
  order?: number
}

// Topology-only hydrogen bond data (no positions or transforms).
// Written by the H-bond detection effect; consumed by a $derived that
// looks up live positions to produce full BondPair[] objects.
export type HBondConnectivity = {
  site_idx_1: number        // Rendered endpoint 1: hydrogen atom (or donor fallback)
  site_idx_2: number        // Rendered endpoint 2: acceptor atom
  strength: number          // Quality metric 0–1 (higher = stronger H-bond)
  donor_idx: number | null  // Donor heavy atom (D in D-H···A); null when JS path can't resolve it
  hydrogen_idx: number      // Hydrogen atom (H in D-H···A), same as site_idx_1
  acceptor_idx: number      // Acceptor atom (A in D-H···A), same as site_idx_2
}

// Options for hydrogen bond detection (Baker-Hubbard criteria)
export type HBondOptions = {
  max_ha_distance?: number // H···A distance threshold (default: 2.5 Å)
  max_da_distance?: number // D···A distance threshold (default: 3.5 Å)
  min_angle?: number       // D-H···A angle minimum in degrees (default: 120°)
}

// Per-element-pair bond distance filter rule
export interface BondDistanceRule {
  element_1: string   // e.g. "Ti"
  element_2: string   // e.g. "O"
  min_dist: number    // Å
  max_dist: number    // Å
}

// Manually added bond (via bond editing tool)
export type ManualBond = { site_idx_1: number; site_idx_2: number; id: string }
// Currently selected bond (for highlighting/deletion)
export type SelectedBond = { type: 'auto' | 'manual'; site_idx_1: number; site_idx_2: number; key: string }

export type IdStructure = PymatgenStructure & { id: string }
export type StructureWithGraph = IdStructure & { graph: Graph }

export type AnyStructure = PymatgenStructure | PymatgenMolecule

// Event fired when atoms are manipulated (drag, keyboard move, rotation)
export type AtomManipulationEvent = { displacements: Map<number, Vec3> }
export type AnyStructureGraph = AnyStructure & { graph: Graph }
export type Crystal = PymatgenStructure // Alias for ferrox-wasm compatibility

// Measurement type for multiple independent measurements
export type Measurement = {
  id: string
  type: 'distance' | 'angle' | 'dihedral'
  sites: number[] // [idx1, idx2] for distance, [idx1, center, idx2] for angle, 4 indices for dihedral
}

export function get_elem_amounts(structure: AnyStructure) {
  const elements: Partial<CompositionType> = {}
  for (const site of structure.sites) {
    for (const species of site.species) {
      const { element: elem, occu } = species
      elements[elem] = (elements[elem] ?? 0) + occu
    }
  }
  return elements
}

export function format_chemical_formula(
  structure: AnyStructure,
  sort_fn: (symbols: ElementSymbol[]) => ElementSymbol[],
): string {
  // concatenate elements in a pymatgen Structure followed by their amount
  const elements = get_elem_amounts(structure)
  const formula = []
  for (const el of sort_fn(Object.keys(elements) as ElementSymbol[])) {
    const amount = elements[el] ?? 0
    if (amount === 1) formula.push(el)
    else formula.push(`${el}<sub>${amount}</sub>`)
  }
  return formula.join(` `)
}

export function alphabetical_formula(structure: AnyStructure): string {
  // concatenate elements in a pymatgen Structure followed by their amount in alphabetical order
  return format_chemical_formula(structure, (symbols) => symbols.sort())
}

export function electro_neg_formula(structure: AnyStructure): string {
  // concatenate elements in a pymatgen Structure followed by their amount sorted by electronegativity
  return format_chemical_formula(structure, (symbols) => (symbols.sort((el1, el2) => {
    const elec_neg1 = element_data.find((el) => el.symbol === el1)?.electronegativity ??
      0
    const elec_neg2 = element_data.find((el) => el.symbol === el2)?.electronegativity ??
      0
    // Sort by electronegativity (ascending), then alphabetically for ties
    if (elec_neg1 !== elec_neg2) return elec_neg1 - elec_neg2
    return el1.localeCompare(el2)
  })))
}

export const atomic_radii: Partial<CompositionType> = Object.fromEntries(
  element_data.map((el) => [el.symbol, (el.covalent_radius ?? el.atomic_radius ?? 1) / 2]),
)

export function get_elements(structure: AnyStructure): ElementSymbol[] {
  const elems = structure.sites.flatMap((site) => site.species.map((sp) => sp.element))
  return [...new Set(elems)].sort() // unique elements
}

// unified atomic mass units (u) per cubic angstrom (Å^3)
// to grams per cubic centimeter (g/cm^3)
const uA3_to_gcm3 = 1.66053907

export function get_density(structure: PymatgenStructure): number {
  // calculate the density of a pymatgen Structure in g/cm³
  const elements = get_elem_amounts(structure)
  let mass = 0
  for (const [el, amt] of Object.entries(elements)) {
    const weight = atomic_weights.get(el as ElementSymbol)
    if (weight !== undefined) mass += amt * weight
  }
  return (uA3_to_gcm3 * mass) / structure.lattice.volume
}

/**
 * Atom centroid — arithmetic mean of Cartesian atom positions.
 *
 * Used where the physical center of the atoms matters:
 *  - Inertia tensor / principal axes alignment (index.ts:calculate_inertia_tensor)
 *  - Structure merge positioning — z-offset for stacking (Structure.svelte:handle_optimade_import)
 *  - Context menu 3D fallback position (interaction.svelte.ts)
 *
 * For the camera orbit pivot, use `get_rotation_center()` instead — it returns the
 * lattice center for periodic structures, which is visually more stable.
 *
 * @param max_sites  Optional cap on the number of sites to average. Used to exclude
 *                   PBC image atoms when computing centroid of displayed structures.
 */
export function get_center_of_mass(
  struct_or_mol: AnyStructure,
  max_sites?: number,
): Vec3 {
  if (!struct_or_mol.sites || struct_or_mol.sites.length === 0) {
    return [0, 0, 0]
  }
  const n = max_sites !== undefined
    ? Math.min(max_sites, struct_or_mol.sites.length)
    : struct_or_mol.sites.length
  if (n === 0) return [0, 0, 0]

  let center: Vec3 = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    center = math.add(center, struct_or_mol.sites[i].xyz)
  }

  return math.scale(center, 1 / n)
}

function site_mass(site: Site): number {
  let mass = 0
  let occu_sum = 0
  for (const spec of site.species) {
    occu_sum += spec.occu
    const atomic_mass = atomic_weights.get(spec.element as ElementSymbol)
    if (atomic_mass !== undefined) mass += atomic_mass * spec.occu
  }
  return mass > 0 ? mass : (occu_sum > 0 ? occu_sum : 1)
}

function get_molecular_rotation_center(
  struct_or_mol: AnyStructure,
  max_sites?: number,
): Vec3 {
  if (!struct_or_mol.sites || struct_or_mol.sites.length === 0) {
    return [0, 0, 0]
  }
  const n = max_sites !== undefined
    ? Math.min(max_sites, struct_or_mol.sites.length)
    : struct_or_mol.sites.length
  if (n === 0) return [0, 0, 0]

  let weighted_sum: Vec3 = [0, 0, 0]
  let total_mass = 0
  for (let i = 0; i < n; i++) {
    const site = struct_or_mol.sites[i]
    const mass = site_mass(site)
    weighted_sum = math.add(weighted_sum, math.scale(site.xyz, mass))
    total_mass += mass
  }

  return total_mass > 0
    ? math.scale(weighted_sum, 1 / total_mass)
    : get_center_of_mass(struct_or_mol, max_sites)
}

function has_periodic_lattice(struct_or_mol: AnyStructure): struct_or_mol is PymatgenStructure {
  if (!(`lattice` in struct_or_mol) || !struct_or_mol.lattice?.matrix) return false
  const pbc = struct_or_mol.lattice.pbc
  return !pbc || pbc.some(Boolean)
}

/**
 * Camera orbit pivot — the point the 3D scene rotates around.
 *
 * Periodic structures:  lattice center = 0.5 * (a + b + c)
 *   This matches the convention used by VESTA, Avogadro, and most crystallographic
 *   viewers. The lattice center is always the midpoint of the unit cell box regardless
 *   of where atoms sit inside it — stable across atom add/remove/doping operations.
 *
 *   Why not atom centroid? Structures like Cu FCC (mp-30) have a single atom at the
 *   origin (0,0,0). The atom centroid IS the origin, which is the corner of the lattice
 *   box — rotating around a corner looks wrong even though it's technically correct.
 *
 * Non-periodic (molecules):  mass-weighted molecular center of mass.
 *   No periodic lattice box exists, so use sum(m_i * r_i) / sum(m_i).
 *   H2 pivots at the bond midpoint; H2O pivots near the heavier oxygen atom.
 *
 * Consumers:
 *  - StructureScene.svelte: rotation_target $derived → orbit_controls.target
 *  - interaction.svelte.ts: raycasting plane center for atom placement
 */
export function get_rotation_center(
  struct_or_mol: AnyStructure,
  max_sites?: number,
): Vec3 {
  if (has_periodic_lattice(struct_or_mol)) {
    const [a, b, c] = struct_or_mol.lattice.matrix
    return math.scale(math.add(a, b, c), 0.5)
  }
  return get_molecular_rotation_center(struct_or_mol, max_sites)
}

export interface StructureHandlerData {
  structure?: AnyStructure
  filename?: string
  file_size?: number
  total_atoms?: number
  error_msg?: string
  is_fullscreen?: boolean
  camera_position?: Vec3
  camera_has_moved?: boolean
  color_scheme?: string
  performance_mode?: `quality` | `speed`
  scene_props?: ComponentProps<typeof StructureScene>
  lattice_props?: ComponentProps<typeof Lattice>
}

export interface BondInstance {
  matrix: Float32Array
  color_start: string
  color_end: string
}

export interface BondGroupWithGradients {
  thickness: number
  instances: BondInstance[]
  ambient_light?: number
  directional_light?: number
  opacity?: number
  render_order?: number       // Three.js renderOrder (higher = renders later)
  polygon_offset?: boolean    // Enable polygon offset to avoid Z-fighting with coplanar geometry
}

/**
 * Calculate the inertia tensor of a structure.
 * The inertia tensor is computed relative to the center of mass.
 */
export function calculate_inertia_tensor(structure: AnyStructure): number[][] {
  const center = get_center_of_mass(structure)

  // Initialize 3x3 inertia tensor
  const I: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]

  for (const site of structure.sites) {
    // Use occupancy as mass weight
    const m = site.species.reduce((sum, sp) => sum + sp.occu, 0)

    // Position relative to center of mass
    const rx = site.xyz[0] - center[0]
    const ry = site.xyz[1] - center[1]
    const rz = site.xyz[2] - center[2]

    const r_sq = rx * rx + ry * ry + rz * rz

    // Diagonal elements: I_ii = sum(m * (r^2 - r_i^2))
    I[0][0] += m * (r_sq - rx * rx)
    I[1][1] += m * (r_sq - ry * ry)
    I[2][2] += m * (r_sq - rz * rz)

    // Off-diagonal elements: I_ij = -sum(m * r_i * r_j)
    I[0][1] -= m * rx * ry
    I[0][2] -= m * rx * rz
    I[1][2] -= m * ry * rz
  }

  // Symmetric matrix
  I[1][0] = I[0][1]
  I[2][0] = I[0][2]
  I[2][1] = I[1][2]

  return I
}

/**
 * Jacobi algorithm for eigenvalue decomposition of a symmetric 3x3 matrix.
 * Returns the eigenvectors as columns (principal axes).
 */
export function get_principal_axes(inertia_tensor: number[][]): number[][] {
  // Copy the tensor
  const A = inertia_tensor.map((row) => [...row])

  // Initialize eigenvector matrix as identity
  const V: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]

  const n = 3
  const max_iterations = 50
  const tolerance = 1e-10

  for (let iter = 0; iter < max_iterations; iter++) {
    // Find the largest off-diagonal element
    let max_off = 0
    let p = 0, q = 1

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(A[i][j]) > max_off) {
          max_off = Math.abs(A[i][j])
          p = i
          q = j
        }
      }
    }

    // Check for convergence
    if (max_off < tolerance) break

    // Calculate rotation angle
    const theta = (A[q][q] - A[p][p]) / (2 * A[p][q])
    const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
    const c = 1 / Math.sqrt(t * t + 1)
    const s = t * c

    // Update matrix A
    const app = A[p][p]
    const aqq = A[q][q]
    const apq = A[p][q]

    A[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq
    A[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq
    A[p][q] = 0
    A[q][p] = 0

    for (let i = 0; i < n; i++) {
      if (i !== p && i !== q) {
        const aip = A[i][p]
        const aiq = A[i][q]
        A[i][p] = c * aip - s * aiq
        A[p][i] = A[i][p]
        A[i][q] = s * aip + c * aiq
        A[q][i] = A[i][q]
      }
    }

    // Update eigenvector matrix
    for (let i = 0; i < n; i++) {
      const vip = V[i][p]
      const viq = V[i][q]
      V[i][p] = c * vip - s * viq
      V[i][q] = s * vip + c * viq
    }
  }

  // Sort eigenvectors by eigenvalues (descending order of absolute eigenvalue)
  const eigenvalues = [A[0][0], A[1][1], A[2][2]]
  const indices = [0, 1, 2].sort((a, b) =>
    Math.abs(eigenvalues[b]) - Math.abs(eigenvalues[a])
  )

  // Return eigenvectors as rows (for easier use as rotation axes)
  const sorted_axes: number[][] = indices.map((idx) => [V[0][idx], V[1][idx], V[2][idx]])

  // Fix eigenvector sign ambiguity: ensure the dominant component of each
  // axis is positive, so the rotation preserves the general orientation
  // of the original coordinate system (prevents arbitrary Y/Z flips).
  for (let i = 0; i < sorted_axes.length; i++) {
    const axis = sorted_axes[i]
    let max_abs = 0, max_idx = 0
    for (let j = 0; j < 3; j++) {
      if (Math.abs(axis[j]) > max_abs) {
        max_abs = Math.abs(axis[j])
        max_idx = j
      }
    }
    if (axis[max_idx] < 0) {
      sorted_axes[i] = axis.map((x) => -x)
    }
  }

  // Ensure right-handed coordinate system
  const cross = [
    sorted_axes[0][1] * sorted_axes[1][2] - sorted_axes[0][2] * sorted_axes[1][1],
    sorted_axes[0][2] * sorted_axes[1][0] - sorted_axes[0][0] * sorted_axes[1][2],
    sorted_axes[0][0] * sorted_axes[1][1] - sorted_axes[0][1] * sorted_axes[1][0],
  ]
  const dot = cross[0] * sorted_axes[2][0] + cross[1] * sorted_axes[2][1] +
    cross[2] * sorted_axes[2][2]
  if (dot < 0) {
    sorted_axes[2] = sorted_axes[2].map((x) => -x)
  }

  return sorted_axes
}

/**
 * Align structure to its principal axes coordinate system.
 * This normalizes the structure orientation for consistent display.
 *
 * NOTE: Only applies to molecules (structures without a lattice).
 * For periodic structures (crystals), atoms must stay within the lattice,
 * so principal axes alignment is not appropriate.
 */
export function align_to_principal_axes(structure: AnyStructure): AnyStructure {
  // Skip alignment for periodic structures (crystals)
  // Atoms must stay within the lattice for periodic materials
  if ('lattice' in structure && structure.lattice) {
    return structure
  }

  // For molecules only: align to principal axes around center of mass
  const center = get_center_of_mass(structure)

  // Calculate inertia tensor and principal axes
  const inertia = calculate_inertia_tensor(structure)
  const axes = get_principal_axes(inertia)

  // Rotation matrix (transpose of axes matrix since axes are row vectors)
  const R = [
    [axes[0][0], axes[1][0], axes[2][0]],
    [axes[0][1], axes[1][1], axes[2][1]],
    [axes[0][2], axes[1][2], axes[2][2]],
  ]

  // Principal axes are sign-ambiguous — the eigenvector signs can turn the
  // molecule upside-down. If the original +z direction ends up pointing down,
  // rotate 180° about the new x-axis (still principal-axes aligned) so the
  // molecule keeps its input vertical orientation.
  if (R[2][2] < 0) {
    for (let j = 0; j < 3; j++) {
      R[1][j] = -R[1][j]
      R[2][j] = -R[2][j]
    }
  }

  // Transform each site (molecules only - no lattice)
  const new_sites = structure.sites.map((site) => {
    // Translate to center of mass
    const x = site.xyz[0] - center[0]
    const y = site.xyz[1] - center[1]
    const z = site.xyz[2] - center[2]

    // Apply rotation
    const new_xyz: Vec3 = [
      R[0][0] * x + R[0][1] * y + R[0][2] * z,
      R[1][0] * x + R[1][1] * y + R[1][2] * z,
      R[2][0] * x + R[2][1] * y + R[2][2] * z,
    ]

    return {
      ...site,
      xyz: new_xyz,
    }
  })

  return {
    ...structure,
    sites: new_sites,
  }
}

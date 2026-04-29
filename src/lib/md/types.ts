/**
 * TypeScript types for the MD trajectory analysis backend API.
 *
 * These types mirror the Pydantic models defined in the server/routers/md_*.py
 * files. All distance values are in Angstroms unless otherwise noted.
 */

// ============================================================================
// View state for the MD analysis pane
// ============================================================================

export interface MdViewState {
  trajectory_b64: string | null
  trajectory_format: string
  topology_b64: string | null
  topology_format: string
  n_frames: number
  n_atoms: number
  /** Current active sub-tab */
  active_sub_tab: MdSubTab
}

export type MdSubTab = `rdf` | `dynamics` | `density` | `hbonds` | `clustering`

// ============================================================================
// Distance analysis (md_distances.py)
// ============================================================================

/** Defines one side of an RDF pair selection. */
export interface AtomSelection {
  /** Explicit atom indices (0-indexed). Mutually exclusive with element. */
  indices?: number[] | null
  /** Element symbol to select (e.g. 'O', 'Cu'). Mutually exclusive with indices. */
  element?: string | null
}

export interface PairwiseDistancesRequest {
  trajectory_b64: string
  format: string
  /** List of atom index pairs [[i, j], ...] (0-indexed) */
  atom_pairs: number[][]
  periodic?: boolean
}

export interface PairwiseDistancesResponse {
  /** Distance matrix (n_frames x n_pairs) in Angstroms */
  distances: number[][]
  /** Frame indices [0, 1, ..., n_frames-1] */
  frame_indices: number[]
  n_frames: number
  n_pairs: number
}

export interface NeighborsRequest {
  trajectory_b64: string
  format: string
  /** Atom indices to find neighbors for (0-indexed) */
  query_indices: number[]
  /** Cutoff radius in Angstroms */
  cutoff: number
  /** Atom indices to search among. If null, all atoms are candidates. */
  haystack_indices?: number[] | null
  /** Specific frame to analyze (0-indexed). If null, all frames are analyzed. */
  frame_index?: number | null
}

export interface FrameNeighborEntry {
  frame: number
  /** Mapping from query atom index (as string key) to list of neighbor atom indices */
  neighbors: Record<string, number[]>
  /** Mapping from query atom index (as string key) to list of distances in Angstroms */
  distances: Record<string, number[]>
}

export interface NeighborsResponse {
  frames: FrameNeighborEntry[]
  cutoff_angstrom: number
  n_query_atoms: number
}

export interface CenterOfMassRequest {
  trajectory_b64: string
  format: string
  /** Atom indices defining the group (0-indexed) */
  atom_indices: number[]
}

export interface CenterOfMassResponse {
  /** Center-of-mass positions per frame (n_frames x 3) in Angstroms */
  positions: number[][]
  frame_indices: number[]
  n_frames: number
}

export interface RdfRequest {
  trajectory_b64: string
  format: string
  /** First atom selection for RDF pairs */
  selection_1: AtomSelection
  /** Second atom selection for RDF pairs */
  selection_2: AtomSelection
  /** [r_min, r_max] in Angstroms */
  r_range?: [number, number]
  /** Number of histogram bins */
  n_bins?: number
  periodic?: boolean
}

export interface RdfResponse {
  /** Bin center positions in Angstroms */
  r: number[]
  /** g(r) values */
  g_r: number[]
  /** Running coordination number (cumulative integral of g(r)) */
  coordination_number: number[]
  /** Number of atom pairs used */
  n_pairs: number
}

// ============================================================================
// Angle analysis (md_angles.py)
// ============================================================================

export interface AngleRequest {
  trajectory_b64: string
  format: string
  /** Base64-encoded topology file (required for xtc/trr/dcd formats) */
  topology_b64?: string | null
  topology_format?: string
  /** List of atom index triplets [[i, j, k], ...] where j is the vertex (0-based) */
  atom_triplets: number[][]
  periodic?: boolean
}

export interface AngleResponse {
  /** Angles in degrees, shape (n_frames, n_angles) */
  angles_deg: number[][]
  frame_indices: number[]
  n_frames: number
  n_angles: number
  /** Echo of input atom triplets */
  atom_triplets: number[][]
}

export interface DihedralRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string
  /** List of atom index quartets [[i, j, k, l], ...] (0-based) */
  atom_quartets: number[][]
  periodic?: boolean
}

export interface DihedralResponse {
  /** Dihedral angles in degrees, shape (n_frames, n_dihedrals). Range [-180, 180]. */
  dihedrals_deg: number[][]
  frame_indices: number[]
  n_frames: number
  n_dihedrals: number
  /** Echo of input atom quartets */
  atom_quartets: number[][]
}

// ============================================================================
// RMSD/RMSF analysis (md_rmsd.py)
// ============================================================================

export interface RMSDRequest {
  trajectory_b64: string
  format: string
  /** Index of the reference frame for RMSD calculation (0-indexed) */
  ref_frame?: number
  /** Atom indices to include (0-indexed). If null, all atoms are used. */
  atom_indices?: number[] | null
  /** If true, assume coordinates are already centered at the origin */
  precentered?: boolean
}

export interface RMSDResponse {
  /** RMSD values per frame in Angstroms */
  rmsd_angstroms: number[]
  frame_indices: number[]
  ref_frame: number
  n_frames: number
  n_atoms_used: number
}

export interface RMSFRequest {
  trajectory_b64: string
  format: string
  /** Atom indices to include (0-indexed). If null, all atoms are used. */
  atom_indices?: number[] | null
  /** Reference frame index. If null, the average structure is used. */
  ref_frame?: number | null
}

export interface RMSFResponse {
  /** RMSF values per atom in Angstroms */
  rmsf_angstroms: number[]
  atom_indices: number[]
  n_frames: number
  n_atoms: number
  /** Description of the reference: 'average' or 'frame:<N>' */
  reference: string
}

// ============================================================================
// Density analysis (md_density.py)
// ============================================================================

export interface DensityProfileRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string | null
  /** Cartesian axis along which to compute the density profile */
  axis: `x` | `y` | `z`
  n_bins?: number
  /** Type of density: 'number' (atoms/A^3) or 'mass' (g/cm^3) */
  density_type?: `number` | `mass`
  /** Atom indices to include (0-based). If null, all atoms are used. */
  atom_indices?: number[] | null
  /** Frame range [start, end] (inclusive). If null, all frames are used. */
  frame_range?: [number, number] | null
}

export interface DensityProfileResponse {
  /** Bin center positions along the axis (Angstroms) */
  bin_centers: number[]
  /** Density values in each bin (atoms/A^3 or g/cm^3) */
  density: number[]
  density_type: string
  axis: string
  /** Human-readable axis label with units */
  axis_label: string
  /** Human-readable density label with units */
  density_label: string
  total_frames: number
  n_atoms_selected: number
  /** Width of each bin (Angstroms) */
  bin_width: number
}

export interface PlanarDensityRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string | null
  /** Projection plane for the 2D density map */
  plane: `xy` | `xz` | `yz`
  /** Number of bins [nx, ny] for the 2D histogram */
  n_bins?: [number, number]
  /** Atom indices to include (0-based). If null, all atoms are used. */
  atom_indices?: number[] | null
  /** Range [min, max] in Angstroms along the axis perpendicular to the plane for filtering */
  z_range?: [number, number] | null
  /** Frame range [start, end] (inclusive). If null, all frames are used. */
  frame_range?: [number, number] | null
}

export interface PlanarDensityResponse {
  /** 2D density array (n_bins_x x n_bins_y), units: atoms/A^3 */
  density: number[][]
  /** Bin edges along the first axis of the plane (Angstroms) */
  x_edges: number[]
  /** Bin edges along the second axis of the plane (Angstroms) */
  y_edges: number[]
  x_label: string
  y_label: string
  plane: string
  total_frames: number
  n_atoms_selected: number
  /** Axis perpendicular to the plane */
  perp_axis: string
}

// ============================================================================
// Hydrogen bond analysis (md_hbonds.py)
// ============================================================================

/** A single hydrogen bond defined by donor, hydrogen, and acceptor atom indices. */
export interface HBondTriplet {
  donor_idx: number
  hydrogen_idx: number
  acceptor_idx: number
}

export interface HBondDetectRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string | null
  /** H-bond detection method: 'baker_hubbard' or 'wernet_nilsson' */
  method?: string
  /** H...Acceptor distance cutoff in Angstroms */
  distance_cutoff?: number
  /** Donor-H...Acceptor angle cutoff in degrees */
  angle_cutoff?: number
  /** Frequency cutoff for baker_hubbard */
  freq?: number
  /** Whether to exclude water-water H-bonds */
  exclude_water?: boolean
  /** Optional list of donor atom indices to restrict detection to */
  donor_indices?: number[] | null
  /** Optional list of acceptor atom indices to restrict detection to */
  acceptor_indices?: number[] | null
  periodic?: boolean
}

export interface HBondDetectResponse {
  /** Per-frame list of H-bond triplets */
  hbonds_per_frame: HBondTriplet[][]
  /** Number of H-bonds detected in each frame */
  count_per_frame: number[]
  /** Unique H-bond triplets observed across the entire trajectory */
  unique_hbonds: HBondTriplet[]
  n_unique: number
  n_frames: number
  method: string
}

export interface HBondLifetimeRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string | null
  /** H...Acceptor distance cutoff in Angstroms */
  distance_cutoff?: number
  /** Donor-H...Acceptor angle cutoff in degrees */
  angle_cutoff?: number
  exclude_water?: boolean
  periodic?: boolean
  /** Specific donor-acceptor pairs as [[donor_idx, acceptor_idx], ...] to track */
  donor_acceptor_pairs?: number[][] | null
  /** Time between frames in picoseconds */
  time_step?: number
  /** Maximum lag as a fraction of total trajectory length for autocorrelation */
  max_lag_fraction?: number
}

export interface HBondLifetimeResponse {
  /** Normalized autocorrelation function C(t) of H-bond existence */
  autocorrelation: number[]
  /** Time values in picoseconds corresponding to autocorrelation */
  time_ps: number[]
  /** Estimated average H-bond lifetime in picoseconds */
  average_lifetime_ps: number
  /** Number of unique H-bond pairs used in the autocorrelation */
  n_hbonds_sampled: number
  n_frames: number
}

export interface HBondDensityRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string | null
  /** [z_min, z_max] in Angstroms defining the region of interest along z-axis */
  z_range: [number, number]
  /** H...Acceptor distance cutoff in Angstroms */
  distance_cutoff?: number
  /** Donor-H...Acceptor angle cutoff in degrees */
  angle_cutoff?: number
  exclude_water?: boolean
  periodic?: boolean
}

export interface HBondDensityResponse {
  /** Number of H-bonds within the z-range for each frame */
  h_bond_count_per_frame: number[]
  /** Average H-bond density in H-bonds per cubic Angstrom */
  average_density: number
  /** The [z_min, z_max] range used (Angstroms) */
  z_range: [number, number]
  n_frames: number
  /** Average number of H-bonds per frame in the region */
  average_count: number
  /** Volume of the selected region in cubic Angstroms */
  region_volume_ang3: number
}

// ============================================================================
// Clustering and dimensionality reduction (md_clustering.py)
// ============================================================================

export interface RMSDMatrixRequest {
  trajectory_b64: string
  format: string
  /** Atom indices for RMSD calculation (0-indexed). If null, all atoms are used. */
  atom_indices?: number[] | null
  /** Stride for subsampling frames */
  stride?: number | null
}

export interface RMSDMatrixResponse {
  /** NxN pairwise RMSD distance matrix in Angstroms */
  distance_matrix: number[][]
  /** Original frame indices corresponding to each row/column */
  frame_indices: number[]
  n_frames: number
}

export interface RMSDClusterRequest {
  trajectory_b64: string
  format: string
  method: `dbscan` | `hierarchical` | `kmeans`
  atom_indices?: number[] | null
  stride?: number | null
  /** DBSCAN: maximum distance (Angstroms) between samples in a cluster */
  eps?: number
  /** DBSCAN: minimum number of samples in a neighborhood */
  min_samples?: number
  /** Number of clusters for hierarchical and KMeans */
  n_clusters?: number
  /** Hierarchical clustering linkage criterion */
  linkage?: `average` | `complete` | `ward`
}

export interface RMSDClusterResponse {
  /** Cluster assignment for each frame (-1 = noise for DBSCAN) */
  labels: number[]
  n_clusters_found: number
  /** Number of frames in each cluster (keys are cluster labels) */
  cluster_sizes: Record<string, number>
  /** Nx2 PCA embedding of the RMSD distance matrix for scatter plot */
  pca_2d: number[][]
  /** Explained variance ratio for the first 2 PCA components */
  pca_explained_variance: number[]
  frame_indices: number[]
  /** Representative frame index for each cluster (medoid) */
  representative_frames: Record<string, number>
}

/** Parameters for collective variable extraction. */
export interface CVParams {
  /** For 'distances' CV: list of atom index pairs [[i, j], ...] */
  atom_pairs?: number[][] | null
  /** For 'angles' CV: list of atom index triplets [[i, j, k], ...] */
  atom_triplets?: number[][] | null
  /** For 'dihedrals' CV: list of atom index quartets [[i, j, k, l], ...] */
  atom_quartets?: number[][] | null
  /** For 'contacts' CV: contact scheme */
  scheme?: `closest-heavy` | `ca` | null
  /** For 'contacts' CV: distance cutoff in Angstroms */
  cutoff?: number | null
}

export interface CVClusterRequest {
  trajectory_b64: string
  format: string
  cv_type: `distances` | `angles` | `dihedrals` | `contacts` | `mixed`
  cv_params?: CVParams
  clustering_method?: `dbscan` | `kmeans` | `hierarchical`
  eps?: number
  min_samples?: number
  n_clusters?: number
  linkage?: `ward` | `average` | `complete`
  stride?: number | null
}

export interface CVClusterResponse {
  labels: number[]
  n_clusters_found: number
  cluster_sizes: Record<string, number>
  /** Nx2 PCA embedding of the CV feature space for scatter plot */
  pca_2d: number[][]
  /** Human-readable labels for each CV dimension */
  cv_names: string[]
  /** NxM CV feature matrix (N frames, M collective variables) */
  cv_values: number[][]
  pca_explained_variance: number[]
  frame_indices: number[]
}

/** Optional clustering parameters to apply after dimensionality reduction. */
export interface DimReduceClusteringParams {
  method: `dbscan` | `kmeans` | `hierarchical`
  eps?: number
  min_samples?: number
  n_clusters?: number
  linkage?: `ward` | `average` | `complete`
}

export interface DimReduceRequest {
  trajectory_b64: string
  format: string
  method: `pca` | `tsne` | `umap`
  /** Number of output dimensions (2 or 3) */
  n_components?: number
  /** Feature source for dimensionality reduction */
  feature_type?: `coordinates` | `rmsd_matrix` | `custom_cv`
  atom_indices?: number[] | null
  stride?: number | null
  /** CV type (required if feature_type='custom_cv') */
  cv_type?: `distances` | `angles` | `dihedrals` | `contacts` | `mixed` | null
  /** CV parameters (required if feature_type='custom_cv') */
  cv_params?: CVParams | null
  /** t-SNE: perplexity (related to number of nearest neighbors) */
  perplexity?: number
  /** t-SNE: learning rate */
  learning_rate?: number | `auto`
  /** t-SNE: maximum number of iterations */
  n_iter?: number
  /** UMAP: number of nearest neighbors for manifold approximation */
  n_neighbors?: number
  /** UMAP: minimum distance between embedded points */
  min_dist?: number
  /** Optional clustering on the embedding */
  clustering?: DimReduceClusteringParams | null
}

export interface DimReduceResponse {
  /** Nx2 or Nx3 embedding coordinates for scatter plot */
  embedding: number[][]
  /** Cluster labels (if clustering was requested), else null */
  labels: number[] | null
  method: string
  /** Explained variance ratio per component (PCA only, else null) */
  explained_variance: number[] | null
  frame_indices: number[]
}

// ============================================================================
// MSD / diffusion coefficient (md_dynamics router)
// ============================================================================

export interface MSDRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string | null
  atom_indices?: number[] | null
  /** Element symbol filter; overrides atom_indices when set (e.g. 'O') */
  element?: string | null
  /** Time step between consecutive frames in picoseconds */
  timestep_ps?: number
  /** Maximum lag in frames (default: n_frames/2) */
  max_tau_frames?: number | null
  directions?: `xyz` | `xy` | `z` | `x` | `y`
  unwrap_pbc?: boolean
  /** [tau_min, tau_max] in ps for Einstein fit */
  fit_range_ps?: [number, number] | null
}

export interface MSDResponse {
  tau_ps: number[]
  msd_angstrom2: number[]
  n_atoms_used: number
  n_frames: number
  directions: string
  dimensionality: number
  diffusion_coefficient_cm2_s: number | null
  diffusion_coefficient_ang2_ps: number | null
  fit_slope_ang2_per_ps: number | null
  fit_intercept_ang2: number | null
  fit_r_squared: number | null
  fit_tau_range_ps: [number, number] | null
}

export interface VACFRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string | null
  atom_indices?: number[] | null
  element?: string | null
  timestep_ps?: number
  max_tau_frames?: number | null
}

export interface VACFResponse {
  tau_ps: number[]
  vacf: number[]
  n_atoms_used: number
  n_frames: number
}

// ============================================================================
// Water orientation order parameter (md_orientation router)
// ============================================================================

export interface WaterOrientationRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string | null
  axis?: `x` | `y` | `z`
  n_bins?: number
  z_range?: [number, number] | null
  frame_range?: [number, number] | null
  oh_cutoff_angstrom?: number
  periodic?: boolean
  compute_p2?: boolean
}

export interface WaterOrientationResponse {
  axis: string
  bin_centers_angstrom: number[]
  /** <cos phi>(z); NaN where a bin has zero water samples */
  cos_phi_mean: number[]
  /** <P2(cos phi)>(z), or null when compute_p2 = false */
  p2_cos_phi_mean: number[] | null
  counts: number[]
  n_frames_used: number
  n_waters_mean: number
}

// ============================================================================
// LCW cavitation free energy (md_cavitation router)
// ============================================================================

export interface CavitationRequest {
  trajectory_b64: string
  format: string
  topology_b64?: string | null
  topology_format?: string | null
  solvent_element?: string
  probe_radii_angstrom?: number[]
  axis?: `x` | `y` | `z`
  n_z_bins?: number
  z_range?: [number, number] | null
  grid_spacing_angstrom?: number
  frame_stride?: number
  temperature_K?: number
  ihp_z_range?: [number, number] | null
  stern_z_range?: [number, number] | null
  periodic?: boolean
}

export interface LCWRegion {
  region: string
  z_range_angstrom: [number, number]
  probe_radii_angstrom: number[]
  cavity_volume_angstrom3: number[]
  delta_g_cav_eV: number[]
  linear_fit_slope_eV_per_A3: number | null
  linear_fit_intercept_eV: number | null
  linear_fit_r_squared: number | null
}

export interface CavitationResponse {
  axis: string
  probe_radii_angstrom: number[]
  z_bin_centers_angstrom: number[]
  /** P0(R, z); rows = probe radii, cols = z bins */
  p0: number[][]
  /** ΔG_cav(R, z) in eV; NaN where P0 = 0 within the sampling */
  delta_g_cav_eV: number[][]
  sampling_lower_bound_eV: number[][]
  n_samples: number[][]
  temperature_K: number
  n_frames_used: number
  n_solvent_atoms: number
  lcw_ihp: LCWRegion | null
  lcw_stern: LCWRegion | null
  /** ΔG_cav(R) = ΔG_IHP - ΔG_Stern per probe radius */
  migration_descriptor_eV: number[] | null
}

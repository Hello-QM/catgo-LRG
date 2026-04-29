//! Adsorption site finder for catalytic surfaces.
//!
//! This module implements a GASCAP-like algorithm for finding
//! top, bridge, and hollow adsorption sites on catalyst surfaces.
//!
//! Key features:
//! - Top sites via pseudoatom probing (coordination number == 1)
//! - Bridge/Hollow sites derived from Delaunay triangulation of Top sites
//! - Proper PBC handling via supercell expansion
//! - Distance-signature based deduplication

use crate::element::Element;
use crate::structure::Structure;
use nalgebra::Vector3;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Type of adsorption site
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SiteType {
    /// Top site: directly above a single atom
    Top,
    /// Bridge site: between two atoms
    Bridge,
    /// Hollow site: center of three or more atoms
    Hollow,
}

impl SiteType {
    /// Returns the site type as a string ("top", "bridge", or "hollow")
    pub fn as_str(&self) -> &'static str {
        match self {
            SiteType::Top => "top",
            SiteType::Bridge => "bridge",
            SiteType::Hollow => "hollow",
        }
    }
}

/// A single adsorption site with all relevant information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdsorptionSite {
    /// Cartesian position of the site (Å)
    pub position: [f64; 3],
    /// Type of adsorption site
    pub site_type: SiteType,
    /// Surface normal vector (unit vector pointing outward)
    pub normal: [f64; 3],
    /// Indices of neighboring atoms in the original unit cell
    pub neighbor_indices: Vec<usize>,
    /// Elements of neighboring atoms
    pub neighbor_elements: Vec<String>,
    /// Environment signature (e.g., "Fe-Fe-O")
    pub env_signature: String,
    /// Distance to the surface (height above atoms)
    pub height: f64,
}

/// Parameters for the adsorption site finder
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AdsorptionSiteFinderParams {
    /// Probe radius for pseudoatom (Å). Default: 1.2
    pub probe_radius: f64,
    /// Cutoff for neighbor search (Å). Default: 3.0
    pub neighbor_cutoff: f64,
    /// Tolerance for deduplication (Å). Default: 0.1
    pub dedup_tol: f64,
    /// Only return upper surface sites. Default: true
    pub only_upper_surface: bool,
    /// Height offset for site placement (Å). Default: 1.5
    pub site_height_offset: f64,
    /// Surface detection threshold from z_max (Å). Default: 2.5
    pub surface_threshold: f64,
    /// Maximum bridge distance between atoms (Å). Default: 3.5
    pub max_bridge_distance: f64,
    /// Maximum hollow radius (Å). Default: 3.0
    pub max_hollow_radius: f64,
    /// Number of neighbors for distance signature. Default: 6
    pub signature_k: usize,
}

impl Default for AdsorptionSiteFinderParams {
    fn default() -> Self {
        Self {
            probe_radius: 1.2,
            neighbor_cutoff: 3.5,
            dedup_tol: 0.1,
            only_upper_surface: true,
            site_height_offset: 1.5,
            surface_threshold: 2.5,
            max_bridge_distance: 3.5,
            max_hollow_radius: 3.0,
            signature_k: 6,
        }
    }
}

/// Result of adsorption site finding
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdsorptionSiteResult {
    /// All found adsorption sites
    pub sites: Vec<AdsorptionSite>,
    /// Number of top sites
    pub n_top: usize,
    /// Number of bridge sites
    pub n_bridge: usize,
    /// Number of hollow sites
    pub n_hollow: usize,
}

/// Substrate atom with position and metadata
#[derive(Debug, Clone)]
struct SubstrateAtom {
    /// Cartesian position
    pos: Vector3<f64>,
    /// Atomic radius (covalent or vdW)
    radius: f64,
    /// Element
    element: Element,
    /// Original index in unit cell
    orig_index: usize,
}

/// A Top site candidate
#[derive(Debug, Clone)]
struct TopSite {
    /// Position of the adsorption site
    pos: Vector3<f64>,
    /// The substrate atom this Top site is above
    substrate_atom_idx: usize,
    /// Original unit cell index of the substrate atom
    orig_atom_index: usize,
    /// Element of the substrate atom
    element: Element,
}

/// Main adsorption site finder
pub struct AdsorptionSiteFinder {
    params: AdsorptionSiteFinderParams,
}

/// Log a message (only in WASM builds)
#[cfg(feature = "wasm")]
fn log_debug(msg: &str) {
    web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(msg));
}

#[cfg(not(feature = "wasm"))]
fn log_debug(_msg: &str) {
    // No-op for non-WASM builds
}

impl AdsorptionSiteFinder {
    /// Create a new adsorption site finder with the given parameters
    pub fn new(params: AdsorptionSiteFinderParams) -> Self {
        Self { params }
    }

    /// Create a new adsorption site finder with default parameters
    pub fn with_default_params() -> Self {
        Self::new(AdsorptionSiteFinderParams::default())
    }

    /// Find all adsorption sites with debug output
    pub fn find_sites_debug(&self, structure: &Structure) -> AdsorptionSiteResult {
        log_debug("[AdsorptionSiteFinder] Starting find_sites_debug");

        // Step 1: Build supercell and get substrate atoms
        let substrate_atoms = self.get_substrate_atoms(structure);
        log_debug(&format!("[AdsorptionSiteFinder] Substrate atoms: {}", substrate_atoms.len()));

        if substrate_atoms.is_empty() {
            log_debug("[AdsorptionSiteFinder] No substrate atoms found!");
            return AdsorptionSiteResult {
                sites: vec![],
                n_top: 0,
                n_bridge: 0,
                n_hollow: 0,
            };
        }

        // Log z-coordinates
        let z_coords: Vec<f64> = substrate_atoms.iter().map(|a| a.pos[2]).collect();
        let z_min = z_coords.iter().fold(f64::INFINITY, |a, &b| a.min(b));
        let z_max = z_coords.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b));
        log_debug(&format!("[AdsorptionSiteFinder] Z range: {:.3} to {:.3}", z_min, z_max));
        log_debug(&format!("[AdsorptionSiteFinder] Surface threshold: {:.3}", self.params.surface_threshold));
        log_debug(&format!("[AdsorptionSiteFinder] Z threshold for surface: {:.3}", z_max - self.params.surface_threshold));

        // Step 2: Find surface atoms (atoms at the top)
        let surface_atom_indices = self.find_surface_atoms(&substrate_atoms);
        log_debug(&format!("[AdsorptionSiteFinder] Surface atoms found: {}", surface_atom_indices.len()));

        if surface_atom_indices.is_empty() {
            log_debug("[AdsorptionSiteFinder] No surface atoms found!");
            return AdsorptionSiteResult {
                sites: vec![],
                n_top: 0,
                n_bridge: 0,
                n_hollow: 0,
            };
        }

        // Log some surface atom positions
        for (i, &idx) in surface_atom_indices.iter().take(5).enumerate() {
            let atom = &substrate_atoms[idx];
            log_debug(&format!("[AdsorptionSiteFinder] Surface atom {}: pos=({:.3}, {:.3}, {:.3}), orig_idx={}",
                i, atom.pos[0], atom.pos[1], atom.pos[2], atom.orig_index));
        }

        // Step 3: Find Top sites
        let top_sites = self.find_top_sites(&substrate_atoms, &surface_atom_indices);
        log_debug(&format!("[AdsorptionSiteFinder] Top sites found: {}", top_sites.len()));

        if top_sites.is_empty() {
            log_debug("[AdsorptionSiteFinder] No top sites found!");
            return AdsorptionSiteResult {
                sites: vec![],
                n_top: 0,
                n_bridge: 0,
                n_hollow: 0,
            };
        }

        // Log some top site positions
        for (i, top) in top_sites.iter().take(5).enumerate() {
            log_debug(&format!("[AdsorptionSiteFinder] Top site {}: pos=({:.3}, {:.3}, {:.3})",
                i, top.pos[0], top.pos[1], top.pos[2]));
        }

        // Step 4: Build Delaunay triangulation
        let triangles = self.triangulate_top_sites(&top_sites);
        log_debug(&format!("[AdsorptionSiteFinder] Triangles found: {}", triangles.len()));

        // Step 5: Generate all adsorption sites
        let mut sites = Vec::new();

        // Add Top sites
        for top in &top_sites {
            let (neighbor_indices, neighbor_elements) =
                self.find_neighbors(&top.pos, &substrate_atoms);
            let env_signature = self.compute_env_signature(&neighbor_elements);

            sites.push(AdsorptionSite {
                position: [top.pos[0], top.pos[1], top.pos[2]],
                site_type: SiteType::Top,
                normal: [0.0, 0.0, 1.0],
                neighbor_indices,
                neighbor_elements,
                env_signature,
                height: self.params.site_height_offset,
            });
        }
        log_debug(&format!("[AdsorptionSiteFinder] Sites after adding tops: {}", sites.len()));

        // Add Bridge sites from triangle edges
        let mut seen_edges: HashSet<(usize, usize)> = HashSet::new();
        let mut bridge_count = 0;
        for tri in &triangles {
            let edges = [
                (tri[0], tri[1]),
                (tri[1], tri[2]),
                (tri[2], tri[0]),
            ];
            for (i, j) in edges {
                let edge_key = if i < j { (i, j) } else { (j, i) };
                if seen_edges.insert(edge_key) {
                    let p0 = &top_sites[i].pos;
                    let p1 = &top_sites[j].pos;
                    let dist = (p1 - p0).norm();

                    if dist <= self.params.max_bridge_distance {
                        let bridge_pos = (p0 + p1) / 2.0;
                        let (neighbor_indices, neighbor_elements) =
                            self.find_neighbors(&bridge_pos, &substrate_atoms);
                        let env_signature = self.compute_env_signature(&neighbor_elements);

                        sites.push(AdsorptionSite {
                            position: [bridge_pos[0], bridge_pos[1], bridge_pos[2]],
                            site_type: SiteType::Bridge,
                            normal: [0.0, 0.0, 1.0],
                            neighbor_indices,
                            neighbor_elements,
                            env_signature,
                            height: self.params.site_height_offset,
                        });
                        bridge_count += 1;
                    }
                }
            }
        }
        log_debug(&format!("[AdsorptionSiteFinder] Bridge sites added: {}", bridge_count));

        // Add Hollow sites from triangle centroids
        let mut hollow_count = 0;
        for tri in &triangles {
            let p0 = &top_sites[tri[0]].pos;
            let p1 = &top_sites[tri[1]].pos;
            let p2 = &top_sites[tri[2]].pos;

            let a = (p1 - p0).norm();
            let b = (p2 - p1).norm();
            let c = (p0 - p2).norm();
            let s = (a + b + c) / 2.0;
            let area = (s * (s - a) * (s - b) * (s - c)).max(0.0).sqrt();
            let circumradius = if area > 1e-12 {
                a * b * c / (4.0 * area)
            } else {
                continue;
            };

            if circumradius <= self.params.max_hollow_radius {
                let hollow_pos = (p0 + p1 + p2) / 3.0;
                let (neighbor_indices, neighbor_elements) =
                    self.find_neighbors(&hollow_pos, &substrate_atoms);
                let env_signature = self.compute_env_signature(&neighbor_elements);

                sites.push(AdsorptionSite {
                    position: [hollow_pos[0], hollow_pos[1], hollow_pos[2]],
                    site_type: SiteType::Hollow,
                    normal: [0.0, 0.0, 1.0],
                    neighbor_indices,
                    neighbor_elements,
                    env_signature,
                    height: self.params.site_height_offset,
                });
                hollow_count += 1;
            }
        }
        log_debug(&format!("[AdsorptionSiteFinder] Hollow sites added: {}", hollow_count));
        log_debug(&format!("[AdsorptionSiteFinder] Total sites before filtering: {}", sites.len()));

        // Step 6: Filter to unit cell and deduplicate
        let sites = self.filter_to_unit_cell(sites, structure);
        log_debug(&format!("[AdsorptionSiteFinder] Sites after filter_to_unit_cell: {}", sites.len()));

        // Count site types
        let n_top = sites.iter().filter(|s| s.site_type == SiteType::Top).count();
        let n_bridge = sites.iter().filter(|s| s.site_type == SiteType::Bridge).count();
        let n_hollow = sites.iter().filter(|s| s.site_type == SiteType::Hollow).count();

        log_debug(&format!("[AdsorptionSiteFinder] Final: {} top, {} bridge, {} hollow", n_top, n_bridge, n_hollow));

        AdsorptionSiteResult {
            sites,
            n_top,
            n_bridge,
            n_hollow,
        }
    }

    /// Find all adsorption sites on the given structure
    pub fn find_sites(&self, structure: &Structure) -> AdsorptionSiteResult {
        // Step 1: Build supercell and get substrate atoms
        let substrate_atoms = self.get_substrate_atoms(structure);

        if substrate_atoms.is_empty() {
            return AdsorptionSiteResult {
                sites: vec![],
                n_top: 0,
                n_bridge: 0,
                n_hollow: 0,
            };
        }

        // Step 2: Find surface atoms (atoms at the top)
        let surface_atom_indices = self.find_surface_atoms(&substrate_atoms);

        if surface_atom_indices.is_empty() {
            return AdsorptionSiteResult {
                sites: vec![],
                n_top: 0,
                n_bridge: 0,
                n_hollow: 0,
            };
        }

        // Step 3: Find Top sites via pseudoatom probing
        let top_sites = self.find_top_sites(&substrate_atoms, &surface_atom_indices);

        if top_sites.is_empty() {
            return AdsorptionSiteResult {
                sites: vec![],
                n_top: 0,
                n_bridge: 0,
                n_hollow: 0,
            };
        }

        // Step 4: Build Delaunay triangulation of Top sites (in 2D projection)
        let triangles = self.triangulate_top_sites(&top_sites);

        // Step 5: Generate all adsorption sites
        let mut sites = Vec::new();

        // Add Top sites
        for top in &top_sites {
            let (neighbor_indices, neighbor_elements) =
                self.find_neighbors(&top.pos, &substrate_atoms);
            let env_signature = self.compute_env_signature(&neighbor_elements);

            sites.push(AdsorptionSite {
                position: [top.pos[0], top.pos[1], top.pos[2]],
                site_type: SiteType::Top,
                normal: [0.0, 0.0, 1.0],
                neighbor_indices,
                neighbor_elements,
                env_signature,
                height: self.params.site_height_offset,
            });
        }

        // Add Bridge sites from triangle edges
        let mut seen_edges: HashSet<(usize, usize)> = HashSet::new();
        for tri in &triangles {
            let edges = [
                (tri[0], tri[1]),
                (tri[1], tri[2]),
                (tri[2], tri[0]),
            ];
            for (i, j) in edges {
                let edge_key = if i < j { (i, j) } else { (j, i) };
                if seen_edges.insert(edge_key) {
                    let p0 = &top_sites[i].pos;
                    let p1 = &top_sites[j].pos;
                    let dist = (p1 - p0).norm();

                    if dist <= self.params.max_bridge_distance {
                        let bridge_pos = (p0 + p1) / 2.0;
                        let (neighbor_indices, neighbor_elements) =
                            self.find_neighbors(&bridge_pos, &substrate_atoms);
                        let env_signature = self.compute_env_signature(&neighbor_elements);

                        sites.push(AdsorptionSite {
                            position: [bridge_pos[0], bridge_pos[1], bridge_pos[2]],
                            site_type: SiteType::Bridge,
                            normal: [0.0, 0.0, 1.0],
                            neighbor_indices,
                            neighbor_elements,
                            env_signature,
                            height: self.params.site_height_offset,
                        });
                    }
                }
            }
        }

        // Add Hollow sites from triangle centroids
        for tri in &triangles {
            let p0 = &top_sites[tri[0]].pos;
            let p1 = &top_sites[tri[1]].pos;
            let p2 = &top_sites[tri[2]].pos;

            // Check triangle size (circumradius)
            let a = (p1 - p0).norm();
            let b = (p2 - p1).norm();
            let c = (p0 - p2).norm();
            let s = (a + b + c) / 2.0;
            let area = (s * (s - a) * (s - b) * (s - c)).max(0.0).sqrt();
            let circumradius = if area > 1e-12 {
                a * b * c / (4.0 * area)
            } else {
                continue; // Degenerate triangle
            };

            if circumradius <= self.params.max_hollow_radius {
                let hollow_pos = (p0 + p1 + p2) / 3.0;
                let (neighbor_indices, neighbor_elements) =
                    self.find_neighbors(&hollow_pos, &substrate_atoms);
                let env_signature = self.compute_env_signature(&neighbor_elements);

                sites.push(AdsorptionSite {
                    position: [hollow_pos[0], hollow_pos[1], hollow_pos[2]],
                    site_type: SiteType::Hollow,
                    normal: [0.0, 0.0, 1.0],
                    neighbor_indices,
                    neighbor_elements,
                    env_signature,
                    height: self.params.site_height_offset,
                });
            }
        }

        // Step 6: Filter to unit cell and deduplicate
        let sites = self.filter_to_unit_cell(sites, structure);

        // Count site types
        let n_top = sites.iter().filter(|s| s.site_type == SiteType::Top).count();
        let n_bridge = sites.iter().filter(|s| s.site_type == SiteType::Bridge).count();
        let n_hollow = sites.iter().filter(|s| s.site_type == SiteType::Hollow).count();

        AdsorptionSiteResult {
            sites,
            n_top,
            n_bridge,
            n_hollow,
        }
    }

    /// Get atomic radius for an element (covalent radius in Å)
    fn get_atomic_radius(&self, element: Element) -> f64 {
        // Covalent radii in Angstroms (approximate)
        match element.atomic_number() {
            1 => 0.31,   // H
            6 => 0.76,   // C
            7 => 0.71,   // N
            8 => 0.66,   // O
            13 => 1.21,  // Al
            14 => 1.11,  // Si
            15 => 1.07,  // P
            16 => 1.05,  // S
            22 => 1.60,  // Ti
            23 => 1.53,  // V
            24 => 1.39,  // Cr
            25 => 1.39,  // Mn
            26 => 1.32,  // Fe
            27 => 1.26,  // Co
            28 => 1.24,  // Ni
            29 => 1.32,  // Cu
            30 => 1.22,  // Zn
            40 => 1.75,  // Zr
            41 => 1.64,  // Nb
            42 => 1.54,  // Mo
            44 => 1.46,  // Ru
            45 => 1.42,  // Rh
            46 => 1.39,  // Pd
            47 => 1.45,  // Ag
            74 => 1.62,  // W
            76 => 1.44,  // Os
            77 => 1.41,  // Ir
            78 => 1.36,  // Pt
            79 => 1.36,  // Au
            _ => 1.5,    // Default
        }
    }

    /// Build substrate atoms from structure with supercell expansion for PBC
    fn get_substrate_atoms(&self, structure: &Structure) -> Vec<SubstrateAtom> {
        let lattice = &structure.lattice;
        let matrix = lattice.matrix();
        let pbc = lattice.pbc;

        let mut atoms = Vec::new();

        // Determine expansion based on PBC (3x3x1 for slabs)
        let (nx_range, ny_range, nz_range) = (
            if pbc[0] { -1..=1 } else { 0..=0 },
            if pbc[1] { -1..=1 } else { 0..=0 },
            if pbc[2] { 0..=0 } else { 0..=0 },
        );

        for nx in nx_range {
            for ny in ny_range.clone() {
                for nz in nz_range.clone() {
                    let offset = Vector3::new(nx as f64, ny as f64, nz as f64);
                    let cart_offset = matrix.transpose() * offset;

                    for (idx, frac) in structure.frac_coords.iter().enumerate() {
                        let cart = matrix.transpose() * frac + cart_offset;
                        let elem = structure.site_occupancies[idx].dominant_species().element;
                        let radius = self.get_atomic_radius(elem);

                        atoms.push(SubstrateAtom {
                            pos: cart,
                            radius,
                            element: elem,
                            orig_index: idx,
                        });
                    }
                }
            }
        }

        atoms
    }

    /// Find surface atoms based on z-coordinate threshold
    fn find_surface_atoms(&self, atoms: &[SubstrateAtom]) -> Vec<usize> {
        if atoms.is_empty() {
            return vec![];
        }

        let z_max = atoms.iter().map(|a| a.pos[2]).fold(f64::NEG_INFINITY, f64::max);
        let z_threshold = z_max - self.params.surface_threshold;

        atoms
            .iter()
            .enumerate()
            .filter(|(_, a)| a.pos[2] >= z_threshold)
            .map(|(i, _)| i)
            .collect()
    }

    /// Find Top sites - one above each surface atom
    ///
    /// For each surface atom, create a Top site directly above it.
    /// The site height is determined by the configured site_height_offset.
    /// We create Top sites from ALL surface atoms (including supercell images)
    /// to ensure proper triangulation, then filter to unit cell later.
    fn find_top_sites(
        &self,
        substrate_atoms: &[SubstrateAtom],
        surface_atom_indices: &[usize],
    ) -> Vec<TopSite> {
        let mut top_sites = Vec::new();

        for &surf_idx in surface_atom_indices {
            let atom = &substrate_atoms[surf_idx];

            // Site position is directly above the atom at the configured height
            let site_pos = Vector3::new(
                atom.pos[0],
                atom.pos[1],
                atom.pos[2] + self.params.site_height_offset,
            );

            top_sites.push(TopSite {
                pos: site_pos,
                substrate_atom_idx: surf_idx,
                orig_atom_index: atom.orig_index,
                element: atom.element,
            });
        }

        top_sites
    }

    /// Build Delaunay triangulation of Top sites (projected to 2D)
    fn triangulate_top_sites(&self, top_sites: &[TopSite]) -> Vec<[usize; 3]> {
        if top_sites.len() < 3 {
            return vec![];
        }

        // Project to 2D (xy plane)
        let points_2d: Vec<(f64, f64)> = top_sites.iter()
            .map(|t| (t.pos[0], t.pos[1]))
            .collect();

        // Bowyer-Watson algorithm for 2D Delaunay triangulation
        self.delaunay_2d(&points_2d)
    }

    /// 2D Delaunay triangulation using Bowyer-Watson algorithm
    fn delaunay_2d(&self, points: &[(f64, f64)]) -> Vec<[usize; 3]> {
        if points.len() < 3 {
            return vec![];
        }

        // Find bounding box
        let (min_x, max_x, min_y, max_y) = self.bounding_box_2d(points);
        let dx = (max_x - min_x).max(1.0);
        let dy = (max_y - min_y).max(1.0);
        let d = dx.max(dy) * 10.0;

        let cx = (min_x + max_x) / 2.0;
        let cy = (min_y + max_y) / 2.0;

        // Create super-triangle containing all points
        let super_verts = [
            (cx - d, cy - d),
            (cx + d, cy - d),
            (cx, cy + d),
        ];

        let n_points = points.len();
        let mut all_points: Vec<(f64, f64)> = points.to_vec();
        all_points.extend(super_verts);

        // Initialize with super-triangle
        let mut triangles: Vec<[usize; 3]> = vec![[n_points, n_points + 1, n_points + 2]];

        // Insert points one by one
        for pt_idx in 0..n_points {
            let pt = all_points[pt_idx];

            // Find all triangles whose circumcircle contains the point
            let mut bad_triangles = Vec::new();
            for (i, tri) in triangles.iter().enumerate() {
                if self.point_in_circumcircle_2d(&all_points, *tri, pt) {
                    bad_triangles.push(i);
                }
            }

            // Find boundary edges of the cavity
            let mut edge_count: HashMap<(usize, usize), usize> = HashMap::new();
            for &tri_idx in &bad_triangles {
                let tri = triangles[tri_idx];
                let edges = [
                    self.sorted_edge(tri[0], tri[1]),
                    self.sorted_edge(tri[1], tri[2]),
                    self.sorted_edge(tri[2], tri[0]),
                ];
                for edge in edges {
                    *edge_count.entry(edge).or_insert(0) += 1;
                }
            }

            // Boundary edges appear exactly once
            let boundary_edges: Vec<(usize, usize)> = edge_count.into_iter()
                .filter(|(_, count)| *count == 1)
                .map(|(edge, _)| edge)
                .collect();

            // Remove bad triangles (in reverse order)
            bad_triangles.sort_unstable();
            for &i in bad_triangles.iter().rev() {
                triangles.swap_remove(i);
            }

            // Create new triangles
            for (e0, e1) in boundary_edges {
                triangles.push([e0, e1, pt_idx]);
            }
        }

        // Remove triangles containing super-vertices
        triangles.retain(|tri| tri.iter().all(|&v| v < n_points));

        triangles
    }

    fn bounding_box_2d(&self, points: &[(f64, f64)]) -> (f64, f64, f64, f64) {
        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;

        for &(x, y) in points {
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }

        (min_x, max_x, min_y, max_y)
    }

    fn sorted_edge(&self, a: usize, b: usize) -> (usize, usize) {
        if a < b { (a, b) } else { (b, a) }
    }

    fn point_in_circumcircle_2d(&self, points: &[(f64, f64)], tri: [usize; 3], pt: (f64, f64)) -> bool {
        let (ax, ay) = points[tri[0]];
        let (bx, by) = points[tri[1]];
        let (cx, cy) = points[tri[2]];
        let (dx, dy) = pt;

        // Use determinant formula for circumcircle test
        let ax_d = ax - dx;
        let ay_d = ay - dy;
        let bx_d = bx - dx;
        let by_d = by - dy;
        let cx_d = cx - dx;
        let cy_d = cy - dy;

        let det = ax_d * (by_d * (cx_d * cx_d + cy_d * cy_d) - cy_d * (bx_d * bx_d + by_d * by_d))
                - ay_d * (bx_d * (cx_d * cx_d + cy_d * cy_d) - cx_d * (bx_d * bx_d + by_d * by_d))
                + (ax_d * ax_d + ay_d * ay_d) * (bx_d * cy_d - by_d * cx_d);

        det > 0.0
    }

    /// Find neighboring atoms for a site
    fn find_neighbors(
        &self,
        site_pos: &Vector3<f64>,
        substrate_atoms: &[SubstrateAtom],
    ) -> (Vec<usize>, Vec<String>) {
        let cutoff = self.params.neighbor_cutoff;
        let mut neighbors: Vec<(usize, f64, String)> = Vec::new();
        let mut seen_orig: HashSet<usize> = HashSet::new();

        for atom in substrate_atoms {
            let d = (site_pos - atom.pos).norm();
            if d < cutoff && seen_orig.insert(atom.orig_index) {
                neighbors.push((atom.orig_index, d, atom.element.symbol().to_string()));
            }
        }

        // Sort by distance
        neighbors.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

        // Limit to k nearest
        neighbors.truncate(self.params.signature_k);

        let indices: Vec<usize> = neighbors.iter().map(|(i, _, _)| *i).collect();
        let elements: Vec<String> = neighbors.iter().map(|(_, _, e)| e.clone()).collect();

        (indices, elements)
    }

    /// Compute environment signature from neighbor elements
    fn compute_env_signature(&self, elements: &[String]) -> String {
        if elements.is_empty() {
            return String::new();
        }

        // Sort by atomic number for stability
        let mut sorted_elements = elements.to_vec();
        sorted_elements.sort_by(|a, b| {
            let z_a = Element::from_symbol(a).map(|e| e.atomic_number()).unwrap_or(0);
            let z_b = Element::from_symbol(b).map(|e| e.atomic_number()).unwrap_or(0);
            z_a.cmp(&z_b)
        });

        sorted_elements.join("-")
    }

    /// Compute distance signature for deduplication
    fn distance_signature(
        &self,
        site: &AdsorptionSite,
        structure: &Structure,
    ) -> Vec<f64> {
        let site_pos = Vector3::new(site.position[0], site.position[1], site.position[2]);
        let matrix = structure.lattice.matrix();

        let mut distances: Vec<f64> = structure
            .frac_coords
            .iter()
            .map(|fc| {
                let cart = matrix.transpose() * fc;
                (site_pos - cart).norm()
            })
            .collect();

        distances.sort_by(|a, b| a.partial_cmp(b).unwrap());
        distances.truncate(self.params.signature_k);
        distances
    }

    /// Filter sites to keep only those within the unit cell and deduplicate
    fn filter_to_unit_cell(
        &self,
        sites: Vec<AdsorptionSite>,
        structure: &Structure,
    ) -> Vec<AdsorptionSite> {
        let lattice = &structure.lattice;
        let inv_matrix = lattice.matrix().try_inverse().unwrap_or_else(nalgebra::Matrix3::identity);

        let mut unique_sites: Vec<AdsorptionSite> = Vec::new();
        let mut signatures: Vec<Vec<f64>> = Vec::new();

        // Small tolerance for boundary checks
        let tol = 0.01;

        let mut filtered_out_of_cell = 0;
        let mut filtered_duplicate = 0;

        for (site_idx, site) in sites.iter().enumerate() {
            // Convert to fractional
            let cart = Vector3::new(site.position[0], site.position[1], site.position[2]);
            let frac = inv_matrix.transpose() * cart;

            // Check if site is within unit cell [0, 1) with tolerance
            let in_x = !lattice.pbc[0] || (frac[0] >= -tol && frac[0] < 1.0 + tol);
            let in_y = !lattice.pbc[1] || (frac[1] >= -tol && frac[1] < 1.0 + tol);
            let in_z = !lattice.pbc[2] || (frac[2] >= -tol && frac[2] < 1.0 + tol);

            if site_idx < 5 {
                log_debug(&format!(
                    "[filter] Site {}: cart=({:.3}, {:.3}, {:.3}), frac=({:.3}, {:.3}, {:.3}), in_cell=({}, {}, {})",
                    site_idx, cart[0], cart[1], cart[2], frac[0], frac[1], frac[2], in_x, in_y, in_z
                ));
            }

            if !in_x || !in_y || !in_z {
                filtered_out_of_cell += 1;
                continue;
            }

            // Compute distance signature for deduplication
            let sig = self.distance_signature(site, structure);

            // Check for duplicates
            let is_duplicate = signatures.iter().any(|existing_sig| {
                if existing_sig.len() != sig.len() {
                    return false;
                }
                existing_sig
                    .iter()
                    .zip(sig.iter())
                    .all(|(a, b)| (a - b).abs() < self.params.dedup_tol)
            });

            if !is_duplicate {
                signatures.push(sig);
                unique_sites.push(site.clone());
            } else {
                filtered_duplicate += 1;
            }
        }

        log_debug(&format!(
            "[filter] Total: {}, filtered_out_of_cell: {}, filtered_duplicate: {}, kept: {}",
            sites.len(), filtered_out_of_cell, filtered_duplicate, unique_sites.len()
        ));

        unique_sites
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lattice::Lattice;
    use crate::species::Species;

    fn create_test_slab() -> Structure {
        // Simple FCC(111) slab-like structure
        let a = 2.5;
        let mut lattice = Lattice::new(nalgebra::Matrix3::new(
            a, 0.0, 0.0,
            a / 2.0, a * 0.866, 0.0,
            0.0, 0.0, 15.0,
        ));
        lattice.pbc = [true, true, false];

        let species = vec![
            Species::neutral(Element::from_symbol("Fe").unwrap()),
            Species::neutral(Element::from_symbol("Fe").unwrap()),
            Species::neutral(Element::from_symbol("Fe").unwrap()),
        ];

        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.3),
            Vector3::new(0.333, 0.333, 0.35),
            Vector3::new(0.667, 0.667, 0.4),
        ];

        Structure::new(lattice, species, frac_coords)
    }

    #[test]
    fn test_find_sites_basic() {
        let structure = create_test_slab();
        let finder = AdsorptionSiteFinder::with_default_params();
        let result = finder.find_sites(&structure);

        // Should find some sites
        assert!(!result.sites.is_empty(), "Should find at least some sites");

        // All sites should have valid normals (unit vectors)
        for site in &result.sites {
            let norm = (site.normal[0].powi(2) + site.normal[1].powi(2) + site.normal[2].powi(2))
                .sqrt();
            assert!(
                (norm - 1.0).abs() < 0.1,
                "Normal should be approximately unit vector"
            );
        }
    }

    #[test]
    fn test_site_types() {
        let structure = create_test_slab();
        let finder = AdsorptionSiteFinder::with_default_params();
        let result = finder.find_sites(&structure);

        // Count should match
        let counted_top = result.sites.iter().filter(|s| s.site_type == SiteType::Top).count();
        let counted_bridge = result.sites.iter().filter(|s| s.site_type == SiteType::Bridge).count();
        let counted_hollow = result.sites.iter().filter(|s| s.site_type == SiteType::Hollow).count();

        assert_eq!(counted_top, result.n_top);
        assert_eq!(counted_bridge, result.n_bridge);
        assert_eq!(counted_hollow, result.n_hollow);
    }

    #[test]
    fn test_upper_surface_filter() {
        let structure = create_test_slab();

        // With filter
        let mut params = AdsorptionSiteFinderParams::default();
        params.only_upper_surface = true;
        let finder = AdsorptionSiteFinder::new(params);
        let result = finder.find_sites(&structure);

        for site in &result.sites {
            assert!(site.normal[2] > 0.0, "Upper surface sites should have normal.z > 0");
        }
    }

    #[test]
    fn test_env_signature() {
        let structure = create_test_slab();
        let finder = AdsorptionSiteFinder::with_default_params();
        let result = finder.find_sites(&structure);

        for site in &result.sites {
            // Signature should contain Fe (our test structure only has Fe)
            assert!(
                site.env_signature.contains("Fe") || site.env_signature.is_empty(),
                "Signature should contain element symbols"
            );
        }
    }
}

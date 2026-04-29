//! Alpha Shape algorithm for surface atom identification and adsorption site finding.
//!
//! Faithful port of `server/utils/alpha_shape.py` (V7).
//! Uses a Bowyer-Watson 3D Delaunay triangulation with circumradius filtering
//! to identify surface atoms, then computes Top, Bridge, Hollow3, and Hollow4
//! adsorption sites via a neighbor-graph analysis.
//!
//! Key advantage over simple Z-threshold approaches: handles nanoparticles on
//! supports and other curved surfaces correctly.

use nalgebra::Matrix3;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::structure::Structure;

// ==================== Section 1: Types ====================

/// Type of adsorption site found by the Alpha Shape algorithm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlphaSiteType {
    /// Top site: directly above a single surface atom.
    Top,
    /// Bridge site: midpoint above an edge between two surface atoms.
    Bridge,
    /// Hollow3 site: center of a triangular atom cycle.
    Hollow3,
    /// Hollow4 site: center of a quadrilateral atom cycle.
    Hollow4,
}

/// A single adsorption site with all relevant information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlphaAdsorptionSite {
    /// Cartesian position of the site (Å).
    pub position: [f64; 3],
    /// Type of adsorption site.
    pub site_type: AlphaSiteType,
    /// Surface normal vector (unit vector pointing outward).
    pub normal: [f64; 3],
    /// Indices of neighboring atoms (in the original, unexpanded structure).
    pub neighbor_indices: Vec<usize>,
    /// Element symbols of the neighboring atoms.
    pub neighbor_elements: Vec<String>,
    /// Environment signature, e.g. "Fe-Fe-O".
    pub env_signature: String,
    /// Height above the surface atoms (Å).
    pub height: f64,
}

/// Parameters for the V7 Alpha Shape adsorption site finder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlphaShapeParams {
    /// Alpha parameter (circumradius cutoff in Å). Default: 2.7.
    #[serde(default = "default_alpha")]
    pub alpha: f64,
    /// Height above surface for site placement (Å). Default: 1.5.
    #[serde(default = "default_height")]
    pub height: f64,
    /// Distance gap ratio for neighbor detection. Default: 1.2.
    #[serde(default = "default_gap_ratio")]
    pub gap_ratio: f64,
    /// Blocking threshold for direct-neighbor check. Default: 0.8.
    #[serde(default = "default_blocking")]
    pub blocking: f64,
    /// Distance threshold for merging close sites (Å). Default: 1.0.
    #[serde(default = "default_merge")]
    pub merge: f64,
    /// Override PBC detection. `None` = auto-detect.
    #[serde(default)]
    pub pbc: Option<bool>,
    /// If true, keep bottom-surface atoms as well. Default: false.
    #[serde(default)]
    pub keep_bottom: bool,
    /// Fraction of slab Z range used as bottom cutoff. Default: 0.5.
    #[serde(default = "default_bottom_fraction")]
    pub bottom_fraction: f64,
    /// Distance threshold for PBC boundary expansion (Å). Default: 3.0.
    #[serde(default = "default_expansion_distance")]
    pub expansion_distance: f64,
    /// Whether to filter out internal (non-surface) sites. Default: true.
    #[serde(default = "default_filter_internal")]
    pub filter_internal: bool,
    /// Search radius for internal site filtering. Default: 5.0.
    #[serde(default = "default_filter_radius")]
    pub filter_radius: f64,
    /// Same-hemisphere ratio threshold for surface filtering. Default: 0.7.
    #[serde(default = "default_filter_threshold")]
    pub filter_threshold: f64,
}

fn default_alpha() -> f64 {
    2.7
}
fn default_height() -> f64 {
    1.5
}
fn default_gap_ratio() -> f64 {
    1.2
}
fn default_blocking() -> f64 {
    0.8
}
fn default_merge() -> f64 {
    1.0
}
fn default_bottom_fraction() -> f64 {
    0.5
}
fn default_expansion_distance() -> f64 {
    3.0
}
fn default_filter_internal() -> bool {
    true
}
fn default_filter_radius() -> f64 {
    5.0
}
fn default_filter_threshold() -> f64 {
    0.7
}

impl Default for AlphaShapeParams {
    fn default() -> Self {
        Self {
            alpha: default_alpha(),
            height: default_height(),
            gap_ratio: default_gap_ratio(),
            blocking: default_blocking(),
            merge: default_merge(),
            pbc: None,
            keep_bottom: false,
            bottom_fraction: default_bottom_fraction(),
            expansion_distance: default_expansion_distance(),
            filter_internal: default_filter_internal(),
            filter_radius: default_filter_radius(),
            filter_threshold: default_filter_threshold(),
        }
    }
}

/// Result of the Alpha Shape adsorption site finding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlphaShapeResult {
    /// All found adsorption sites.
    pub sites: Vec<AlphaAdsorptionSite>,
    /// Number of top sites.
    pub n_top: usize,
    /// Number of bridge sites.
    pub n_bridge: usize,
    /// Number of hollow3 sites.
    pub n_hollow3: usize,
    /// Number of hollow4 sites.
    pub n_hollow4: usize,
}

// ==================== Section 2: 3D Delaunay (Bowyer-Watson) ====================

/// Sort three indices in ascending order.
#[inline]
fn sorted3(a: usize, b: usize, c: usize) -> [usize; 3] {
    let mut arr = [a, b, c];
    arr.sort_unstable();
    arr
}

/// Return the 4 faces of a tetrahedron, each as a sorted triple of indices.
fn tet_faces(tet: [usize; 4]) -> [[usize; 3]; 4] {
    [
        sorted3(tet[1], tet[2], tet[3]),
        sorted3(tet[0], tet[2], tet[3]),
        sorted3(tet[0], tet[1], tet[3]),
        sorted3(tet[0], tet[1], tet[2]),
    ]
}

/// Compute circumsphere (center, radius) of a tetrahedron defined by 4 points.
///
/// Returns `([0,0,0], 1e10)` for degenerate tetrahedra.
fn circumsphere_of(pts: &[[f64; 3]], tet: [usize; 4]) -> ([f64; 3], f64) {
    let a = pts[tet[0]];
    let b = pts[tet[1]];
    let c = pts[tet[2]];
    let d = pts[tet[3]];

    let bx = b[0] - a[0];
    let by = b[1] - a[1];
    let bz = b[2] - a[2];
    let cx = c[0] - a[0];
    let cy = c[1] - a[1];
    let cz = c[2] - a[2];
    let dx = d[0] - a[0];
    let dy = d[1] - a[1];
    let dz = d[2] - a[2];

    // det = b' · (c' × d')
    let cross_cd = [
        cy * dz - cz * dy,
        cz * dx - cx * dz,
        cx * dy - cy * dx,
    ];
    let det = bx * cross_cd[0] + by * cross_cd[1] + bz * cross_cd[2];
    if det.abs() < 1e-10 {
        return ([0.0, 0.0, 0.0], 1e10);
    }

    let b2 = (bx * bx + by * by + bz * bz) * 0.5;
    let c2 = (cx * cx + cy * cy + cz * cz) * 0.5;
    let d2 = (dx * dx + dy * dy + dz * dz) * 0.5;

    // Cramer's rule: M * u = rhs  where M rows are b', c', d'
    // u_x = det([[b2,by,bz],[c2,cy,cz],[d2,dy,dz]]) / det
    let det_x = b2 * (cy * dz - cz * dy) - by * (c2 * dz - cz * d2)
        + bz * (c2 * dy - cy * d2);
    let det_y = bx * (c2 * dz - cz * d2) - b2 * (cx * dz - cz * dx)
        + bz * (cx * d2 - c2 * dx);
    let det_z = bx * (cy * d2 - c2 * dy) - by * (cx * d2 - c2 * dx)
        + b2 * (cx * dy - cy * dx);

    let ux = det_x / det;
    let uy = det_y / det;
    let uz = det_z / det;

    let center = [a[0] + ux, a[1] + uy, a[2] + uz];
    let radius = (ux * ux + uy * uy + uz * uz).sqrt();
    (center, radius)
}

/// Bowyer-Watson 3D Delaunay triangulation.
///
/// Returns the set of tetrahedra (as index quadruples into `pts`) that make up
/// the Delaunay triangulation of the input point set.
fn bowyer_watson_3d(pts: &[[f64; 3]]) -> Vec<[usize; 4]> {
    let n = pts.len();
    if n < 4 {
        return vec![];
    }

    // Add small deterministic jitter to avoid degeneracies.
    let mut jittered: Vec<[f64; 3]> = pts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let h1 = (i.wrapping_mul(2_654_435_761)) as f64;
            let h2 = (i.wrapping_mul(1_013_904_223).wrapping_add(1_664_525)) as f64;
            let h3 = (i.wrapping_mul(22_695_477).wrapping_add(1)) as f64;
            [
                p[0] + h1.sin() * 1e-7,
                p[1] + h2.cos() * 1e-7,
                p[2] + h3.sin() * 1e-7,
            ]
        })
        .collect();

    // Compute bounding box and a super-tetrahedron.
    let mut min_x = jittered[0][0];
    let mut max_x = jittered[0][0];
    let mut min_y = jittered[0][1];
    let mut max_y = jittered[0][1];
    let mut min_z = jittered[0][2];
    let mut max_z = jittered[0][2];
    for p in jittered.iter() {
        min_x = min_x.min(p[0]);
        max_x = max_x.max(p[0]);
        min_y = min_y.min(p[1]);
        max_y = max_y.max(p[1]);
        min_z = min_z.min(p[2]);
        max_z = max_z.max(p[2]);
    }
    let cx = (min_x + max_x) * 0.5;
    let cy = (min_y + max_y) * 0.5;
    let cz = (min_z + max_z) * 0.5;
    let span_x = max_x - min_x;
    let span_y = max_y - min_y;
    let span_z = max_z - min_z;
    let s = (span_x.max(span_y).max(span_z).max(1.0)) * 3.0;

    // Super-tetrahedron vertices appended at indices n, n+1, n+2, n+3.
    let sv0 = [cx, cy + 3.0 * s, cz - s];
    let sv1 = [cx - 3.0 * s, cy - s, cz - s];
    let sv2 = [cx + 3.0 * s, cy - s, cz - s];
    let sv3 = [cx, cy, cz + 3.0 * s];
    jittered.push(sv0);
    jittered.push(sv1);
    jittered.push(sv2);
    jittered.push(sv3);

    // Start with just the super-tetrahedron.
    let mut tets: Vec<[usize; 4]> = vec![[n, n + 1, n + 2, n + 3]];

    // For each point, incrementally update the triangulation.
    for pt_idx in 0..n {
        let pt = jittered[pt_idx];

        // Find "bad" tetrahedra whose circumsphere contains the new point.
        let mut bad_tets: Vec<[usize; 4]> = Vec::new();
        let mut good_tets: Vec<[usize; 4]> = Vec::new();
        for &tet in &tets {
            let (center, radius) = circumsphere_of(&jittered, tet);
            let dx = pt[0] - center[0];
            let dy = pt[1] - center[1];
            let dz = pt[2] - center[2];
            let dist2 = dx * dx + dy * dy + dz * dz;
            if dist2 < radius * radius {
                bad_tets.push(tet);
            } else {
                good_tets.push(tet);
            }
        }

        // Find the boundary polygon: faces that appear in exactly one bad tet.
        let mut face_count: HashMap<[usize; 3], u32> = HashMap::new();
        for &tet in &bad_tets {
            for face in tet_faces(tet) {
                *face_count.entry(face).or_insert(0) += 1;
            }
        }
        let boundary_faces: Vec<[usize; 3]> = face_count
            .into_iter()
            .filter(|(_, count)| *count == 1)
            .map(|(face, _)| face)
            .collect();

        // Re-triangulate by connecting boundary faces to the new point.
        tets = good_tets;
        for face in boundary_faces {
            let new_tet = [face[0], face[1], face[2], pt_idx];
            tets.push(new_tet);
        }
    }

    // Remove any tetrahedron that shares a vertex with the super-tetrahedron.
    tets.retain(|tet| tet.iter().all(|&v| v < n));

    tets
}

// ==================== Section 3: Alpha Shape surface detection ====================

/// Identify surface atoms using the Alpha Shape algorithm.
///
/// Returns indices (into `coords`) of atoms that lie on the surface of the
/// alpha shape with the given `alpha` parameter (circumradius cutoff in Å).
pub fn find_surface_atoms_alpha(coords: &[[f64; 3]], alpha: f64) -> Vec<usize> {
    if coords.len() < 4 {
        // For very small structures, treat all atoms as surface atoms.
        return (0..coords.len()).collect();
    }

    let tets = bowyer_watson_3d(coords);
    if tets.is_empty() {
        return (0..coords.len()).collect();
    }

    // Keep tetrahedra with circumradius < alpha.
    let mut kept_tets: Vec<[usize; 4]> = Vec::new();
    for &tet in &tets {
        let (_center, radius) = circumsphere_of(coords, tet);
        if radius < alpha {
            kept_tets.push(tet);
        }
    }

    if kept_tets.is_empty() {
        // Fallback: return all atoms if no tetrahedra pass the filter.
        return (0..coords.len()).collect();
    }

    // Count face appearances among kept tetrahedra.
    let mut face_count: HashMap<[usize; 3], u32> = HashMap::new();
    for &tet in &kept_tets {
        for face in tet_faces(tet) {
            *face_count.entry(face).or_insert(0) += 1;
        }
    }

    // Surface atoms are on faces that appear exactly once (boundary faces).
    let mut surface_set: HashSet<usize> = HashSet::new();
    for (face, count) in face_count {
        if count == 1 {
            for v in face {
                surface_set.insert(v);
            }
        }
    }

    let mut result: Vec<usize> = surface_set.into_iter().collect();
    result.sort_unstable();
    result
}

// ==================== Section 4: PBC utilities ====================

/// Compute the inverse of a 3×3 matrix given as row-vectors.
fn mat3_inv(m: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    // Compute via cofactor matrix / determinant.
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-14 {
        // Degenerate — return identity.
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    let inv_det = 1.0 / det;
    [
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ]
}

/// Multiply a 3×3 matrix (row-vectors) by a column vector.
fn mat3_vec(m: &[[f64; 3]; 3], v: &[f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Extract lattice as a row-vector array from a `Matrix3<f64>`.
fn lattice_to_array(m: &Matrix3<f64>) -> [[f64; 3]; 3] {
    // nalgebra stores column-major; rows of `m` are lattice vectors.
    [
        [m[(0, 0)], m[(0, 1)], m[(0, 2)]],
        [m[(1, 0)], m[(1, 1)], m[(1, 2)]],
        [m[(2, 0)], m[(2, 1)], m[(2, 2)]],
    ]
}

/// Expand coordinates near cell boundaries for PBC handling.
///
/// Mirrors the Python `expand_coords_for_pbc` function exactly:
/// - Computes fractional coordinates.
/// - For atoms within `expansion_distance` of x/y boundaries: copies with ±cell[0], ±cell[1].
/// - For corner atoms (near both x and y boundaries): copies with ±cell[0]±cell[1].
///
/// Returns `(expanded_coords, original_indices)` where `original_indices[i]`
/// is the index into the *original* (unexpanded) `coords` that atom `i` came from.
/// The first `n` entries are identity (orig[0..n] == 0..n).
pub fn expand_coords_for_pbc(
    coords: &[[f64; 3]],
    cell: &[[f64; 3]; 3],
    expansion_distance: f64,
) -> (Vec<[f64; 3]>, Vec<usize>) {
    // cell_inv such that frac = cell_inv * cart  (Python: cell_inv = inv(cell.T))
    // cell.T transposes the row-matrix, so cell.T[j][i] = cell[i][j].
    // inv(cell.T): we need frac coords s.t. cart = frac @ cell  (row-vectors).
    // frac = cart @ cell^{-1}.  Treating cell as row-matrix:
    //   cart = frac @ cell  =>  frac = cart @ inv(cell)
    // The Python code: cell_inv = inv(cell.T), then frac = coords @ cell_inv
    // which equals: frac = coords @ inv(cell.T).
    // In row-vector notation: frac_i = dot(cart_i, col_j_of_inv(cell.T)).
    // We implement it correctly below.
    let cell_t: [[f64; 3]; 3] = [
        [cell[0][0], cell[1][0], cell[2][0]],
        [cell[0][1], cell[1][1], cell[2][1]],
        [cell[0][2], cell[1][2], cell[2][2]],
    ];
    let cell_inv = mat3_inv(&cell_t);

    // Row norms for cell[0] and cell[1].
    let norm0 = (cell[0][0] * cell[0][0] + cell[0][1] * cell[0][1] + cell[0][2] * cell[0][2])
        .sqrt()
        .max(1e-10);
    let norm1 = (cell[1][0] * cell[1][0] + cell[1][1] * cell[1][1] + cell[1][2] * cell[1][2])
        .sqrt()
        .max(1e-10);

    let threshold_x = expansion_distance / norm0;
    let threshold_y = expansion_distance / norm1;

    let mut expanded: Vec<[f64; 3]> = coords.to_vec();
    let mut orig_indices: Vec<usize> = (0..coords.len()).collect();

    for (i, coord) in coords.iter().enumerate() {
        let frac = mat3_vec(&cell_inv, coord);
        let fx = frac[0];
        let fy = frac[1];

        let near_x_min = fx < threshold_x;
        let near_x_max = fx > (1.0 - threshold_x);
        let near_y_min = fy < threshold_y;
        let near_y_max = fy > (1.0 - threshold_y);

        if near_x_min {
            expanded.push([
                coord[0] + cell[0][0],
                coord[1] + cell[0][1],
                coord[2] + cell[0][2],
            ]);
            orig_indices.push(i);
        }
        if near_x_max {
            expanded.push([
                coord[0] - cell[0][0],
                coord[1] - cell[0][1],
                coord[2] - cell[0][2],
            ]);
            orig_indices.push(i);
        }
        if near_y_min {
            expanded.push([
                coord[0] + cell[1][0],
                coord[1] + cell[1][1],
                coord[2] + cell[1][2],
            ]);
            orig_indices.push(i);
        }
        if near_y_max {
            expanded.push([
                coord[0] - cell[1][0],
                coord[1] - cell[1][1],
                coord[2] - cell[1][2],
            ]);
            orig_indices.push(i);
        }
        // Diagonal (corner) copies.
        if near_x_min && near_y_min {
            expanded.push([
                coord[0] + cell[0][0] + cell[1][0],
                coord[1] + cell[0][1] + cell[1][1],
                coord[2] + cell[0][2] + cell[1][2],
            ]);
            orig_indices.push(i);
        }
        if near_x_min && near_y_max {
            expanded.push([
                coord[0] + cell[0][0] - cell[1][0],
                coord[1] + cell[0][1] - cell[1][1],
                coord[2] + cell[0][2] - cell[1][2],
            ]);
            orig_indices.push(i);
        }
        if near_x_max && near_y_min {
            expanded.push([
                coord[0] - cell[0][0] + cell[1][0],
                coord[1] - cell[0][1] + cell[1][1],
                coord[2] - cell[0][2] + cell[1][2],
            ]);
            orig_indices.push(i);
        }
        if near_x_max && near_y_max {
            expanded.push([
                coord[0] - cell[0][0] - cell[1][0],
                coord[1] - cell[0][1] - cell[1][1],
                coord[2] - cell[0][2] - cell[1][2],
            ]);
            orig_indices.push(i);
        }
    }

    (expanded, orig_indices)
}

/// Filter sites to those whose fractional xy-coordinates lie in [-0.05, 1.05].
///
/// Returns indices (into `sites`) of the sites that pass the filter.
pub fn filter_sites_in_cell(sites: &[[f64; 3]], cell: &[[f64; 3]; 3]) -> Vec<usize> {
    if sites.is_empty() {
        return vec![];
    }
    let cell_t: [[f64; 3]; 3] = [
        [cell[0][0], cell[1][0], cell[2][0]],
        [cell[0][1], cell[1][1], cell[2][1]],
        [cell[0][2], cell[1][2], cell[2][2]],
    ];
    let cell_inv = mat3_inv(&cell_t);

    sites
        .iter()
        .enumerate()
        .filter_map(|(i, site)| {
            let frac = mat3_vec(&cell_inv, site);
            if (-0.05..=1.05).contains(&frac[0]) && (-0.05..=1.05).contains(&frac[1]) {
                Some(i)
            } else {
                None
            }
        })
        .collect()
}

/// Remove bottom-surface atoms.
///
/// Mirrors the Python `filter_upper_surface`: computes z_cutoff from all_coords,
/// then returns the indices (into `surface_coords`) of atoms at or above z_cutoff.
pub fn filter_upper_surface(
    surface_coords: &[[f64; 3]],
    all_coords: &[[f64; 3]],
    bottom_fraction: f64,
) -> Vec<usize> {
    if surface_coords.is_empty() || all_coords.is_empty() {
        return (0..surface_coords.len()).collect();
    }
    let z_min = all_coords.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
    let z_max = all_coords.iter().map(|p| p[2]).fold(f64::NEG_INFINITY, f64::max);
    let z_cutoff = z_min + bottom_fraction * (z_max - z_min);

    surface_coords
        .iter()
        .enumerate()
        .filter_map(|(i, p)| if p[2] >= z_cutoff { Some(i) } else { None })
        .collect()
}

// ==================== Section 5: Neighbor graph ====================

/// Euclidean distance between two 3D points.
#[inline]
fn dist3(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

/// Find "true" neighbors of `coords[atom_idx]` via distance-gap analysis.
///
/// Sorts all other atoms by distance, then takes the first neighbor and continues
/// while consecutive distances don't jump by more than `gap_ratio`. Caps at 12.
pub fn find_true_neighbors(coords: &[[f64; 3]], atom_idx: usize, gap_ratio: f64) -> Vec<usize> {
    if coords.len() <= 1 {
        return vec![];
    }

    // Collect (distance, index) pairs, excluding self.
    let center = &coords[atom_idx];
    let mut dists: Vec<(f64, usize)> = coords
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != atom_idx)
        .map(|(i, p)| (dist3(center, p), i))
        .collect();
    dists.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    dists.truncate(20); // match Python's k=20

    if dists.is_empty() {
        return vec![];
    }

    let mut neighbors = vec![dists[0].1];

    for i in 0..dists.len().saturating_sub(1) {
        let ratio = if dists[i].0 > 1e-10 {
            dists[i + 1].0 / dists[i].0
        } else {
            1.0 // treat coincident points as not a gap
        };
        if ratio > gap_ratio {
            break;
        }
        neighbors.push(dists[i + 1].1);
    }

    neighbors.truncate(12);
    neighbors
}

/// Check if atoms `i` and `j` are direct neighbors (no atom blocks the line-of-sight).
///
/// Returns `false` if any atom k has a perpendicular distance to the i→j line that is
/// less than `blocking * dist(i,j) / 2`.
pub fn is_direct_neighbor(
    coords: &[[f64; 3]],
    i: usize,
    j: usize,
    blocking: f64,
) -> bool {
    let pi = &coords[i];
    let pj = &coords[j];
    let ij_dist = dist3(pi, pj);
    if ij_dist < 1e-10 {
        return true;
    }
    let threshold = blocking * (ij_dist / 2.0);

    let dir = [
        (pj[0] - pi[0]) / ij_dist,
        (pj[1] - pi[1]) / ij_dist,
        (pj[2] - pi[2]) / ij_dist,
    ];

    for (k, pk) in coords.iter().enumerate() {
        if k == i || k == j {
            continue;
        }
        let vik = [pk[0] - pi[0], pk[1] - pi[1], pk[2] - pi[2]];
        let projection = vik[0] * dir[0] + vik[1] * dir[1] + vik[2] * dir[2];
        if projection > 0.0 && projection < ij_dist {
            let proj_pt = [
                pi[0] + projection * dir[0],
                pi[1] + projection * dir[1],
                pi[2] + projection * dir[2],
            ];
            let perp = [pk[0] - proj_pt[0], pk[1] - proj_pt[1], pk[2] - proj_pt[2]];
            let perp_dist = (perp[0] * perp[0] + perp[1] * perp[1] + perp[2] * perp[2]).sqrt();
            if perp_dist < threshold {
                return false;
            }
        }
    }
    true
}

/// Build the nearest-neighbor graph for a set of surface atoms.
///
/// Returns an adjacency list (index = atom index, value = sorted list of
/// neighbor indices) using the distance-gap + line-of-sight criteria.
pub fn build_neighbor_graph(
    coords: &[[f64; 3]],
    gap_ratio: f64,
    blocking: f64,
) -> Vec<Vec<usize>> {
    let n = coords.len();
    let mut graph: Vec<HashSet<usize>> = vec![HashSet::new(); n];

    for i in 0..n {
        let candidates = find_true_neighbors(coords, i, gap_ratio);
        for j in candidates {
            if is_direct_neighbor(coords, i, j, blocking) {
                graph[i].insert(j);
                graph[j].insert(i); // make symmetric
            }
        }
    }

    graph
        .into_iter()
        .map(|s| {
            let mut v: Vec<usize> = s.into_iter().collect();
            v.sort_unstable();
            v
        })
        .collect()
}

// ==================== Section 6: PCA normals ====================

/// Compute the surface normal for a single atom via PCA of its neighbor positions.
///
/// Mirrors the Python `get_atom_normal`:
/// - If < 3 neighbors: return normalized `fallback`.
/// - Otherwise: PCA of (neighbor_coords − center), smallest eigenvector = normal.
/// - Orient outward using the average vector from nearby atoms to center.
pub fn compute_atom_normal(
    atom_idx: usize,
    coords: &[[f64; 3]],
    neighbors: &[usize],
    all_coords: &[[f64; 3]],
    fallback: [f64; 3],
) -> [f64; 3] {
    let center = coords[atom_idx];

    if neighbors.len() < 3 {
        return normalize3(fallback);
    }

    // Build covariance matrix of relative neighbor positions.
    let mut rel: Vec<[f64; 3]> = neighbors
        .iter()
        .map(|&nb| {
            [
                coords[nb][0] - center[0],
                coords[nb][1] - center[1],
                coords[nb][2] - center[2],
            ]
        })
        .collect();

    // Mean-center the relative vectors.
    let n = rel.len() as f64;
    let mean = [
        rel.iter().map(|r| r[0]).sum::<f64>() / n,
        rel.iter().map(|r| r[1]).sum::<f64>() / n,
        rel.iter().map(|r| r[2]).sum::<f64>() / n,
    ];
    for r in rel.iter_mut() {
        r[0] -= mean[0];
        r[1] -= mean[1];
        r[2] -= mean[2];
    }

    // Symmetric 3×3 covariance matrix.
    let mut cov = [[0f64; 3]; 3];
    for r in &rel {
        for a in 0..3 {
            for b in 0..3 {
                cov[a][b] += r[a] * r[b];
            }
        }
    }
    for a in 0..3 {
        for b in 0..3 {
            cov[a][b] /= (n - 1.0).max(1.0);
        }
    }

    // Use nalgebra to find eigenvectors.
    let nalg_cov = Matrix3::new(
        cov[0][0], cov[0][1], cov[0][2],
        cov[1][0], cov[1][1], cov[1][2],
        cov[2][0], cov[2][1], cov[2][2],
    );
    let eig = nalg_cov.symmetric_eigen();
    // Find index of smallest eigenvalue.
    let min_idx = eig
        .eigenvalues
        .iter()
        .enumerate()
        .min_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i)
        .unwrap_or(0);
    let evec = eig.eigenvectors.column(min_idx);
    let mut normal = [evec[0], evec[1], evec[2]];

    // Orient normal outward: compute avg vector from nearby all_coords to center.
    let nearby: Vec<&[f64; 3]> = all_coords
        .iter()
        .filter(|p| {
            let d = dist3(p, &center);
            d > 0.5 && d < 5.0
        })
        .collect();

    if nearby.len() >= 3 {
        let mut avg = [0f64; 3];
        for p in &nearby {
            avg[0] += center[0] - p[0];
            avg[1] += center[1] - p[1];
            avg[2] += center[2] - p[2];
        }
        let dot = normal[0] * avg[0] + normal[1] * avg[1] + normal[2] * avg[2];
        if dot < 0.0 {
            normal[0] = -normal[0];
            normal[1] = -normal[1];
            normal[2] = -normal[2];
        }
    } else {
        // Fallback orientation.
        let dot = normal[0] * fallback[0] + normal[1] * fallback[1] + normal[2] * fallback[2];
        if dot < 0.0 {
            normal[0] = -normal[0];
            normal[1] = -normal[1];
            normal[2] = -normal[2];
        }
    }

    normalize3(normal)
}

// ==================== Section 7: Cycle finding ====================

/// Find all 3-cycles (triangles) in the neighbor graph.
///
/// Returns sorted triples `[i, j, k]` with i < j < k.
pub fn find_3cycles(graph: &[Vec<usize>]) -> Vec<[usize; 3]> {
    let n = graph.len();
    let mut cycles: HashSet<[usize; 3]> = HashSet::new();

    for i in 0..n {
        for &j in &graph[i] {
            if j <= i {
                continue;
            }
            for &k in &graph[j] {
                if k <= j {
                    continue;
                }
                // Check if k is also a neighbor of i.
                if graph[i].binary_search(&k).is_ok() {
                    cycles.insert([i, j, k]);
                }
            }
        }
    }

    let mut result: Vec<[usize; 3]> = cycles.into_iter().collect();
    result.sort_unstable();
    result
}

/// Normalize a 4-cycle by rotating so that the minimum element comes first.
fn normalize_4cycle(cycle: [usize; 4]) -> [usize; 4] {
    let min_pos = cycle
        .iter()
        .enumerate()
        .min_by_key(|&(_, &v)| v)
        .map(|(i, _)| i)
        .unwrap_or(0);
    [
        cycle[min_pos],
        cycle[(min_pos + 1) % 4],
        cycle[(min_pos + 2) % 4],
        cycle[(min_pos + 3) % 4],
    ]
}

/// Find all 4-cycles (quadrilaterals) in the neighbor graph.
///
/// Mirrors the Python algorithm: for edge (i,j), for k in graph[j] (k > i, k != i),
/// for l in graph[k] (l > i, l != j), if i in graph[l] and k not in graph[i] and
/// l not in graph[j]: emit cycle [i,j,k,l].
pub fn find_4cycles(graph: &[Vec<usize>]) -> Vec<[usize; 4]> {
    let n = graph.len();
    // Fast neighbor lookup.
    let neighbor_sets: Vec<HashSet<usize>> = graph
        .iter()
        .map(|v| v.iter().cloned().collect())
        .collect();

    let mut visited: HashSet<[usize; 4]> = HashSet::new();

    for node_i in 0..n {
        for &j in &graph[node_i] {
            if j <= node_i {
                continue;
            }
            for &k in &graph[j] {
                if k <= node_i || k == node_i {
                    continue;
                }
                for &l in &graph[k] {
                    if l <= node_i || l == j {
                        continue;
                    }
                    if neighbor_sets[node_i].contains(&l)
                        && !neighbor_sets[node_i].contains(&k)
                        && !neighbor_sets[j].contains(&l)
                    {
                        let normalized = normalize_4cycle([node_i, j, k, l]);
                        visited.insert(normalized);
                    }
                }
            }
        }
    }

    let mut result: Vec<[usize; 4]> = visited.into_iter().collect();
    result.sort_unstable();
    result
}

// ==================== Section 8: Site filtering ====================

/// Check whether a candidate site is on the surface (not inside the bulk).
///
/// Uses hemisphere analysis: computes unit vectors from nearby atoms to the site,
/// then checks whether more than `threshold` fraction of them point into the same
/// hemisphere as their mean direction.
pub fn is_surface_site(
    site: &[f64; 3],
    all_coords: &[[f64; 3]],
    radius: f64,
    threshold: f64,
) -> bool {
    // Collect nearby atoms (exclude self/coincident atoms).
    let nearby: Vec<[f64; 3]> = all_coords
        .iter()
        .filter_map(|p| {
            let d = dist3(p, site);
            if d > 0.5 && d < radius {
                Some(*p)
            } else {
                None
            }
        })
        .collect();

    if nearby.len() < 3 {
        return true;
    }

    // Unit vectors from atoms to site.
    let vectors: Vec<[f64; 3]> = nearby
        .iter()
        .filter_map(|atom| {
            let v = [site[0] - atom[0], site[1] - atom[1], site[2] - atom[2]];
            let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if len > 1e-9 {
                Some([v[0] / len, v[1] / len, v[2] / len])
            } else {
                None
            }
        })
        .collect();

    if vectors.len() < 3 {
        return true;
    }

    let n = vectors.len() as f64;
    let avg = [
        vectors.iter().map(|v| v[0]).sum::<f64>() / n,
        vectors.iter().map(|v| v[1]).sum::<f64>() / n,
        vectors.iter().map(|v| v[2]).sum::<f64>() / n,
    ];
    let avg_len = (avg[0] * avg[0] + avg[1] * avg[1] + avg[2] * avg[2]).sqrt();
    if avg_len < 1e-9 {
        return false;
    }
    let avg_dir = [avg[0] / avg_len, avg[1] / avg_len, avg[2] / avg_len];

    let same_hemisphere = vectors
        .iter()
        .filter(|v| v[0] * avg_dir[0] + v[1] * avg_dir[1] + v[2] * avg_dir[2] > 0.0)
        .count();

    (same_hemisphere as f64) / n > threshold
}

// ==================== Section 9: Site merging ====================

/// Merge sites that are closer than `threshold` using connected-component clustering.
///
/// Mirrors the Python `merge_close_sites`: builds a proximity graph, finds connected
/// components via DFS, then returns the centroid of each component.
/// If `threshold <= 0`, returns the input unchanged.
pub fn merge_close_sites(
    sites: &[[f64; 3]],
    normals: &[[f64; 3]],
    threshold: f64,
) -> (Vec<[f64; 3]>, Vec<[f64; 3]>) {
    if sites.is_empty() || threshold <= 0.0 {
        return (sites.to_vec(), normals.to_vec());
    }

    let n = sites.len();
    let threshold2 = threshold * threshold;

    // Build adjacency graph.
    let mut graph: Vec<Vec<usize>> = vec![Vec::new(); n];
    for i in 0..n {
        for j in (i + 1)..n {
            let dx = sites[i][0] - sites[j][0];
            let dy = sites[i][1] - sites[j][1];
            let dz = sites[i][2] - sites[j][2];
            if dx * dx + dy * dy + dz * dz <= threshold2 {
                graph[i].push(j);
                graph[j].push(i);
            }
        }
    }

    // DFS connected components.
    let mut visited = vec![false; n];
    let mut clusters: Vec<Vec<usize>> = Vec::new();

    fn dfs(node: usize, graph: &[Vec<usize>], visited: &mut Vec<bool>, cluster: &mut Vec<usize>) {
        visited[node] = true;
        cluster.push(node);
        for &nb in &graph[node] {
            if !visited[nb] {
                dfs(nb, graph, visited, cluster);
            }
        }
    }

    for i in 0..n {
        if !visited[i] {
            let mut cluster = Vec::new();
            dfs(i, &graph, &mut visited, &mut cluster);
            clusters.push(cluster);
        }
    }

    // Compute centroid sites and averaged normals for each cluster.
    let mut merged_sites: Vec<[f64; 3]> = Vec::with_capacity(clusters.len());
    let mut merged_normals: Vec<[f64; 3]> = Vec::with_capacity(clusters.len());

    for cluster in &clusters {
        let k = cluster.len() as f64;
        let centroid = [
            cluster.iter().map(|&i| sites[i][0]).sum::<f64>() / k,
            cluster.iter().map(|&i| sites[i][1]).sum::<f64>() / k,
            cluster.iter().map(|&i| sites[i][2]).sum::<f64>() / k,
        ];
        merged_sites.push(centroid);

        if !normals.is_empty() {
            let avg_n = [
                cluster.iter().map(|&i| normals[i][0]).sum::<f64>() / k,
                cluster.iter().map(|&i| normals[i][1]).sum::<f64>() / k,
                cluster.iter().map(|&i| normals[i][2]).sum::<f64>() / k,
            ];
            merged_normals.push(normalize3(avg_n));
        } else {
            merged_normals.push([0.0, 0.0, 1.0]);
        }
    }

    (merged_sites, merged_normals)
}

// ==================== Helper: vector normalization ====================

#[inline]
fn normalize3(v: [f64; 3]) -> [f64; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len < 1e-10 {
        [0.0, 0.0, 1.0]
    } else {
        [v[0] / len, v[1] / len, v[2] / len]
    }
}

/// Cross product of two 3D vectors.
#[inline]
fn cross3(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Orient a geometric normal outward using nearby atoms.
fn orient_normal_outward(
    normal: [f64; 3],
    center: &[f64; 3],
    all_coords: &[[f64; 3]],
    check_radius: f64,
) -> [f64; 3] {
    let nearby: Vec<[f64; 3]> = all_coords
        .iter()
        .filter_map(|p| {
            let d = dist3(p, center);
            if d > 0.5 && d < check_radius {
                Some(*p)
            } else {
                None
            }
        })
        .collect();

    if nearby.len() >= 3 {
        let k = nearby.len() as f64;
        let avg = [
            nearby.iter().map(|p| center[0] - p[0]).sum::<f64>() / k,
            nearby.iter().map(|p| center[1] - p[1]).sum::<f64>() / k,
            nearby.iter().map(|p| center[2] - p[2]).sum::<f64>() / k,
        ];
        let dot = normal[0] * avg[0] + normal[1] * avg[1] + normal[2] * avg[2];
        if dot < 0.0 {
            return [-normal[0], -normal[1], -normal[2]];
        }
    }
    normal
}

// ==================== Section 10: Main function ====================

/// Find adsorption sites using the V7 Alpha Shape algorithm.
///
/// This is the main entry point. It handles nanoparticles, flat slabs, and
/// other complex surface geometries correctly.
pub fn find_adsorption_sites_v7(
    structure: &Structure,
    params: &AlphaShapeParams,
) -> AlphaShapeResult {
    let n_orig = structure.frac_coords.len();
    if n_orig == 0 {
        return AlphaShapeResult {
            sites: vec![],
            n_top: 0,
            n_bridge: 0,
            n_hollow3: 0,
            n_hollow4: 0,
        };
    }

    // Step 1: Extract Cartesian coordinates and element symbols.
    let cart_vecs = structure.cart_coords();
    let cart_coords: Vec<[f64; 3]> = cart_vecs.iter().map(|v| [v[0], v[1], v[2]]).collect();

    let elements: Vec<String> = structure
        .site_occupancies
        .iter()
        .map(|so| so.dominant_species().element.symbol().to_string())
        .collect();

    // Step 2: Detect PBC.
    let has_pbc = match params.pbc {
        Some(b) => b,
        None => structure.pbc[0] || structure.pbc[1] || structure.pbc[2],
    };

    // Step 3: Get cell matrix.
    let cell = lattice_to_array(structure.lattice.matrix());

    // Step 4-7: Surface detection + PBC expansion.
    //
    // For PBC structures, mirror the Python backend exactly:
    //  (a) 3×3 grid expansion in XY for surface detection (robust for Delaunay)
    //  (b) Extract center-cell surface atom indices
    //  (c) Filter upper surface
    //  (d) expand_coords_for_pbc on surface coords AND all coords for site computation
    let (surface_coords, expanded_coords): (Vec<[f64; 3]>, Vec<[f64; 3]>) = if has_pbc {
        // (a) 3×3 grid expansion for surface detection
        let mut grid_coords: Vec<[f64; 3]> = Vec::with_capacity(n_orig * 9);
        for di in [-1i32, 0, 1] {
            for dj in [-1i32, 0, 1] {
                let shift = [
                    di as f64 * cell[0][0] + dj as f64 * cell[1][0],
                    di as f64 * cell[0][1] + dj as f64 * cell[1][1],
                    di as f64 * cell[0][2] + dj as f64 * cell[1][2],
                ];
                for p in &cart_coords {
                    grid_coords.push([p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]]);
                }
            }
        }
        let surface_raw = find_surface_atoms_alpha(&grid_coords, params.alpha);

        // (b) Extract indices belonging to center cell (index 4 in 3×3 = offset 4*n_orig)
        let center_start = 4 * n_orig;
        let center_end = 5 * n_orig;
        let mut surface_local: Vec<usize> = surface_raw
            .iter()
            .filter(|&&idx| idx >= center_start && idx < center_end)
            .map(|&idx| idx - center_start)
            .collect();
        surface_local.sort_unstable();
        surface_local.dedup();

        if surface_local.is_empty() {
            return AlphaShapeResult {
                sites: vec![],
                n_top: 0,
                n_bridge: 0,
                n_hollow3: 0,
                n_hollow4: 0,
            };
        }

        let mut surf_coords: Vec<[f64; 3]> = surface_local.iter().map(|&i| cart_coords[i]).collect();

        // (c) Filter upper surface
        if !params.keep_bottom {
            let kept = filter_upper_surface(&surf_coords, &cart_coords, params.bottom_fraction);
            surf_coords = kept.iter().map(|&k| surf_coords[k]).collect();
        }

        if surf_coords.is_empty() {
            return AlphaShapeResult {
                sites: vec![],
                n_top: 0,
                n_bridge: 0,
                n_hollow3: 0,
                n_hollow4: 0,
            };
        }

        // (d) Expand surface coords AND all coords for site computation
        let (exp_surface, _) = expand_coords_for_pbc(&surf_coords, &cell, params.expansion_distance);
        let (exp_all, _) = expand_coords_for_pbc(&cart_coords, &cell, params.expansion_distance);

        (exp_surface, exp_all)
    } else {
        // Non-PBC: use all atoms for surface detection directly
        let surface_raw = find_surface_atoms_alpha(&cart_coords, params.alpha);
        if surface_raw.is_empty() {
            return AlphaShapeResult {
                sites: vec![],
                n_top: 0,
                n_bridge: 0,
                n_hollow3: 0,
                n_hollow4: 0,
            };
        }
        let surf_coords: Vec<[f64; 3]> = surface_raw.iter().map(|&i| cart_coords[i]).collect();
        (surf_coords, cart_coords.clone())
    };

    // Step 8: Build neighbor graph.
    let graph = build_neighbor_graph(&surface_coords, params.gap_ratio, params.blocking);

    // Step 9: Compute normals for each surface atom.
    let fallback = [0.0f64, 0.0, 1.0];
    let normals: Vec<[f64; 3]> = (0..surface_coords.len())
        .map(|i| {
            let neighbors = &graph[i];
            compute_atom_normal(i, &surface_coords, neighbors, &expanded_coords, fallback)
        })
        .collect();

    // ---- Generate candidate sites ----
    let height = params.height;
    let check_radius = 5.0f64;

    // Top sites.
    let mut top_sites: Vec<[f64; 3]> = Vec::new();
    let mut top_normals: Vec<[f64; 3]> = Vec::new();
    for i in 0..surface_coords.len() {
        let n = normals[i];
        top_sites.push([
            surface_coords[i][0] + n[0] * height,
            surface_coords[i][1] + n[1] * height,
            surface_coords[i][2] + n[2] * height,
        ]);
        top_normals.push(n);
    }

    // Bridge sites.
    let mut bridge_sites: Vec<[f64; 3]> = Vec::new();
    let mut bridge_normals: Vec<[f64; 3]> = Vec::new();
    let mut visited_edges: HashSet<(usize, usize)> = HashSet::new();
    for i in 0..surface_coords.len() {
        for &j in &graph[i] {
            let edge = if i < j { (i, j) } else { (j, i) };
            if visited_edges.contains(&edge) {
                continue;
            }
            visited_edges.insert(edge);

            let mid = [
                (surface_coords[i][0] + surface_coords[j][0]) * 0.5,
                (surface_coords[i][1] + surface_coords[j][1]) * 0.5,
                (surface_coords[i][2] + surface_coords[j][2]) * 0.5,
            ];

            // Average normal from up to 6 nearest surface atoms to midpoint.
            let mut dists: Vec<(f64, usize)> = surface_coords
                .iter()
                .enumerate()
                .map(|(k, p)| (dist3(p, &mid), k))
                .collect();
            dists.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            dists.truncate(6);

            let k = dists.len() as f64;
            let avg_n = [
                dists.iter().map(|(_, idx)| normals[*idx][0]).sum::<f64>() / k,
                dists.iter().map(|(_, idx)| normals[*idx][1]).sum::<f64>() / k,
                dists.iter().map(|(_, idx)| normals[*idx][2]).sum::<f64>() / k,
            ];
            let avg_n = normalize3(avg_n);

            bridge_sites.push([
                mid[0] + avg_n[0] * height,
                mid[1] + avg_n[1] * height,
                mid[2] + avg_n[2] * height,
            ]);
            bridge_normals.push(avg_n);
        }
    }

    // Hollow3 sites (triangular cycles).
    let triangles = find_3cycles(&graph);
    let mut hollow3_sites: Vec<[f64; 3]> = Vec::new();
    let mut hollow3_normals: Vec<[f64; 3]> = Vec::new();

    for tri in &triangles {
        let center = [
            (surface_coords[tri[0]][0] + surface_coords[tri[1]][0] + surface_coords[tri[2]][0]) / 3.0,
            (surface_coords[tri[0]][1] + surface_coords[tri[1]][1] + surface_coords[tri[2]][1]) / 3.0,
            (surface_coords[tri[0]][2] + surface_coords[tri[1]][2] + surface_coords[tri[2]][2]) / 3.0,
        ];

        let v1 = [
            surface_coords[tri[1]][0] - surface_coords[tri[0]][0],
            surface_coords[tri[1]][1] - surface_coords[tri[0]][1],
            surface_coords[tri[1]][2] - surface_coords[tri[0]][2],
        ];
        let v2 = [
            surface_coords[tri[2]][0] - surface_coords[tri[0]][0],
            surface_coords[tri[2]][1] - surface_coords[tri[0]][1],
            surface_coords[tri[2]][2] - surface_coords[tri[0]][2],
        ];
        let geom_normal = normalize3(cross3(&v1, &v2));
        let geom_normal = orient_normal_outward(geom_normal, &center, &expanded_coords, check_radius);

        hollow3_sites.push([
            center[0] + geom_normal[0] * height,
            center[1] + geom_normal[1] * height,
            center[2] + geom_normal[2] * height,
        ]);
        hollow3_normals.push(geom_normal);
    }

    // Hollow4 sites (quadrilateral cycles).
    let quads = find_4cycles(&graph);
    let mut hollow4_sites: Vec<[f64; 3]> = Vec::new();
    let mut hollow4_normals: Vec<[f64; 3]> = Vec::new();

    for quad in &quads {
        let center = [
            (surface_coords[quad[0]][0]
                + surface_coords[quad[1]][0]
                + surface_coords[quad[2]][0]
                + surface_coords[quad[3]][0])
                / 4.0,
            (surface_coords[quad[0]][1]
                + surface_coords[quad[1]][1]
                + surface_coords[quad[2]][1]
                + surface_coords[quad[3]][1])
                / 4.0,
            (surface_coords[quad[0]][2]
                + surface_coords[quad[1]][2]
                + surface_coords[quad[2]][2]
                + surface_coords[quad[3]][2])
                / 4.0,
        ];

        // n1 = cross(v1, v2), n2 = cross(v3, v4), geom_normal = normalize(n1+n2).
        let v1 = [
            surface_coords[quad[1]][0] - surface_coords[quad[0]][0],
            surface_coords[quad[1]][1] - surface_coords[quad[0]][1],
            surface_coords[quad[1]][2] - surface_coords[quad[0]][2],
        ];
        let v2 = [
            surface_coords[quad[2]][0] - surface_coords[quad[0]][0],
            surface_coords[quad[2]][1] - surface_coords[quad[0]][1],
            surface_coords[quad[2]][2] - surface_coords[quad[0]][2],
        ];
        let v3 = [
            surface_coords[quad[2]][0] - surface_coords[quad[0]][0],
            surface_coords[quad[2]][1] - surface_coords[quad[0]][1],
            surface_coords[quad[2]][2] - surface_coords[quad[0]][2],
        ];
        let v4 = [
            surface_coords[quad[3]][0] - surface_coords[quad[0]][0],
            surface_coords[quad[3]][1] - surface_coords[quad[0]][1],
            surface_coords[quad[3]][2] - surface_coords[quad[0]][2],
        ];
        let n1 = cross3(&v1, &v2);
        let n2 = cross3(&v3, &v4);
        let geom_normal = normalize3([n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]]);
        let geom_normal = orient_normal_outward(geom_normal, &center, &expanded_coords, check_radius);

        hollow4_sites.push([
            center[0] + geom_normal[0] * height,
            center[1] + geom_normal[1] * height,
            center[2] + geom_normal[2] * height,
        ]);
        hollow4_normals.push(geom_normal);
    }

    // Step 14: Filter internal sites.
    if params.filter_internal {
        let filter_fn = |sites: Vec<[f64; 3]>, norms: Vec<[f64; 3]>| -> (Vec<[f64; 3]>, Vec<[f64; 3]>) {
            let mut fs = Vec::new();
            let mut fn_ = Vec::new();
            for (i, site) in sites.iter().enumerate() {
                if is_surface_site(site, &expanded_coords, params.filter_radius, params.filter_threshold) {
                    fs.push(*site);
                    fn_.push(norms[i]);
                }
            }
            (fs, fn_)
        };
        let (ts, tn) = filter_fn(top_sites, top_normals);
        top_sites = ts;
        top_normals = tn;
        let (bs, bn) = filter_fn(bridge_sites, bridge_normals);
        bridge_sites = bs;
        bridge_normals = bn;
        let (h3s, h3n) = filter_fn(hollow3_sites, hollow3_normals);
        hollow3_sites = h3s;
        hollow3_normals = h3n;
        let (h4s, h4n) = filter_fn(hollow4_sites, hollow4_normals);
        hollow4_sites = h4s;
        hollow4_normals = h4n;
    }

    // Step 15: Merge close sites.
    if params.merge > 0.0 {
        let (ts, tn) = merge_close_sites(&top_sites, &top_normals, params.merge);
        top_sites = ts;
        top_normals = tn;
        let (bs, bn) = merge_close_sites(&bridge_sites, &bridge_normals, params.merge);
        bridge_sites = bs;
        bridge_normals = bn;
        let (h3s, h3n) = merge_close_sites(&hollow3_sites, &hollow3_normals, params.merge);
        hollow3_sites = h3s;
        hollow3_normals = h3n;
        let (h4s, h4n) = merge_close_sites(&hollow4_sites, &hollow4_normals, params.merge);
        hollow4_sites = h4s;
        hollow4_normals = h4n;
    }

    // Step 16: Filter to unit cell if PBC.
    if has_pbc {
        let keep_cell_fn = |sites: Vec<[f64; 3]>, norms: Vec<[f64; 3]>| -> (Vec<[f64; 3]>, Vec<[f64; 3]>) {
            let kept = filter_sites_in_cell(&sites, &cell);
            let ks: Vec<[f64; 3]> = kept.iter().map(|&i| sites[i]).collect();
            let kn: Vec<[f64; 3]> = kept.iter().map(|&i| norms[i]).collect();
            (ks, kn)
        };
        let (ts, tn) = keep_cell_fn(top_sites, top_normals);
        top_sites = ts;
        top_normals = tn;
        let (bs, bn) = keep_cell_fn(bridge_sites, bridge_normals);
        bridge_sites = bs;
        bridge_normals = bn;
        let (h3s, h3n) = keep_cell_fn(hollow3_sites, hollow3_normals);
        hollow3_sites = h3s;
        hollow3_normals = h3n;
        let (h4s, h4n) = keep_cell_fn(hollow4_sites, hollow4_normals);
        hollow4_sites = h4s;
        hollow4_normals = h4n;
    }

    // Step 17-18: Build final AlphaAdsorptionSite list.
    // Use original cart_coords + cell for neighbor finding (with PBC minimum image convention).
    let neighbor_cutoff = 3.0f64;
    let max_neighbors = 6usize;

    let make_site = |pos: [f64; 3], normal: [f64; 3], site_type: AlphaSiteType| -> AlphaAdsorptionSite {
        // Find neighbors in original structure using minimum image convention.
        let mut nearby: Vec<(usize, f64)> = Vec::new();
        for (k, p) in cart_coords.iter().enumerate() {
            let mut diff = [pos[0] - p[0], pos[1] - p[1], pos[2] - p[2]];
            // Minimum image convention for PBC
            if has_pbc {
                let cell_t: [[f64; 3]; 3] = [
                    [cell[0][0], cell[1][0], cell[2][0]],
                    [cell[0][1], cell[1][1], cell[2][1]],
                    [cell[0][2], cell[1][2], cell[2][2]],
                ];
                let cell_inv = mat3_inv(&cell_t);
                let frac_diff = mat3_vec(&cell_inv, &diff);
                let wrapped = [
                    frac_diff[0] - frac_diff[0].round(),
                    frac_diff[1] - frac_diff[1].round(),
                    frac_diff[2] - frac_diff[2].round(),
                ];
                // Convert back to Cartesian: diff = wrapped @ cell
                diff = [
                    wrapped[0] * cell[0][0] + wrapped[1] * cell[1][0] + wrapped[2] * cell[2][0],
                    wrapped[0] * cell[0][1] + wrapped[1] * cell[1][1] + wrapped[2] * cell[2][1],
                    wrapped[0] * cell[0][2] + wrapped[1] * cell[1][2] + wrapped[2] * cell[2][2],
                ];
            }
            let d = (diff[0] * diff[0] + diff[1] * diff[1] + diff[2] * diff[2]).sqrt();
            if d < neighbor_cutoff {
                nearby.push((k, d));
            }
        }
        nearby.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        nearby.truncate(max_neighbors);

        let neighbor_indices: Vec<usize> = nearby.iter().map(|(i, _)| *i).collect();
        let neighbor_elements: Vec<String> = neighbor_indices
            .iter()
            .map(|&i| elements[i.min(elements.len() - 1)].clone())
            .collect();

        // Build env_signature: sorted unique elements joined by "-".
        let mut sig_elems: Vec<String> = neighbor_elements.clone();
        sig_elems.sort_unstable();
        sig_elems.dedup();
        let env_signature = sig_elems.join("-");

        AlphaAdsorptionSite {
            position: pos,
            site_type,
            normal,
            neighbor_indices,
            neighbor_elements,
            env_signature,
            height,
        }
    };

    let n_top = top_sites.len();
    let n_bridge = bridge_sites.len();
    let n_hollow3 = hollow3_sites.len();
    let n_hollow4 = hollow4_sites.len();

    let mut sites: Vec<AlphaAdsorptionSite> = Vec::new();
    for i in 0..n_top {
        sites.push(make_site(top_sites[i], top_normals[i], AlphaSiteType::Top));
    }
    for i in 0..n_bridge {
        sites.push(make_site(bridge_sites[i], bridge_normals[i], AlphaSiteType::Bridge));
    }
    for i in 0..n_hollow3 {
        sites.push(make_site(hollow3_sites[i], hollow3_normals[i], AlphaSiteType::Hollow3));
    }
    for i in 0..n_hollow4 {
        sites.push(make_site(hollow4_sites[i], hollow4_normals[i], AlphaSiteType::Hollow4));
    }

    AlphaShapeResult {
        sites,
        n_top,
        n_bridge,
        n_hollow3,
        n_hollow4,
    }
}

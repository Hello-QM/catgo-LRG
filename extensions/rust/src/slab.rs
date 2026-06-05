//! Slab and surface generation from Miller indices.
//!
//! This module provides functionality to generate slab structures from bulk crystals
//! based on Miller indices (h, k, l).
//!
//! Key features:
//! - Miller index to surface normal conversion
//! - D-spacing calculation
//! - In-plane lattice vector finding with Gaussian reduction
//! - Coordinate system transformation (normal → +Z)
//! - Slab generation with configurable thickness and vacuum

use crate::error::{FerroxError, Result};
use crate::lattice::Lattice;
use crate::structure::Structure;
use nalgebra::{Matrix3, Vector3};

/// Miller index type: (h, k, l)
pub type MillerIndex = [i32; 3];

/// Growth mode for slab thickness direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GrowthMode {
    /// Slab grows symmetrically from the center offset.
    #[default]
    Centered,
    /// Surface stays fixed at offset, slab grows into -Z direction.
    AnchorMinusZ,
    /// Bottom stays fixed at offset, slab grows into +Z direction.
    AnchorPlusZ,
}

/// Configuration for slab generation.
#[derive(Debug, Clone)]
pub struct SlabConfig {
    /// Miller index (h, k, l).
    pub miller_index: MillerIndex,
    /// Distance along normal from origin (in Angstroms).
    pub offset: f64,
    /// Slab thickness (in Angstroms).
    pub thickness: f64,
    /// Vacuum layer thickness (in Angstroms).
    pub vacuum: f64,
    /// How thickness grows from offset.
    pub growth_mode: GrowthMode,
    /// In-plane supercell factors (na, nb).
    pub supercell: [i32; 2],
}

impl Default for SlabConfig {
    fn default() -> Self {
        Self {
            miller_index: [0, 0, 1],
            offset: 0.0,
            thickness: 10.0,
            vacuum: 15.0,
            growth_mode: GrowthMode::default(),
            supercell: [1, 1],
        }
    }
}

/// Numerical tolerance for geometric operations.
const EPS: f64 = 1e-10;

/// Tolerance for layer grouping (Angstroms).
const LAYER_TOLERANCE: f64 = 0.1;

/// Tolerance for duplicate atom detection (Angstroms).
const DUPLICATE_TOL: f64 = 0.01;

// =============================================================================
// Core Crystallography Functions
// =============================================================================

/// Compute the greatest common divisor.
fn gcd(mut a: i32, mut b: i32) -> i32 {
    a = a.abs();
    b = b.abs();
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    if a == 0 { 1 } else { a }
}

/// Normalize Miller indices by their GCD.
pub fn normalize_miller(hkl: MillerIndex) -> MillerIndex {
    let [h, k, l] = hkl;
    if h == 0 && k == 0 && l == 0 {
        return [0, 0, 1]; // Default to (001)
    }
    let divisor = gcd(gcd(h.abs(), k.abs()), l.abs());
    [h / divisor, k / divisor, l / divisor]
}

/// Check if Miller index is valid (not all zeros).
pub fn is_valid_miller(hkl: MillerIndex) -> bool {
    !(hkl[0] == 0 && hkl[1] == 0 && hkl[2] == 0)
}

/// Compute the reciprocal lattice matrix (crystallographic convention, no 2π).
///
/// a* = (b × c) / V
/// b* = (c × a) / V
/// c* = (a × b) / V
fn reciprocal_lattice_cryst(lattice: &Lattice) -> Matrix3<f64> {
    let m = lattice.matrix();
    let a = m.row(0).transpose();
    let b = m.row(1).transpose();
    let c = m.row(2).transpose();

    let b_cross_c = b.cross(&c);
    let volume = a.dot(&b_cross_c);

    if volume.abs() < EPS {
        // Return identity for degenerate lattices
        return Matrix3::identity();
    }

    let c_cross_a = c.cross(&a);
    let a_cross_b = a.cross(&b);

    Matrix3::from_rows(&[
        (b_cross_c / volume).transpose(),
        (c_cross_a / volume).transpose(),
        (a_cross_b / volume).transpose(),
    ])
}

/// Convert Miller index to surface normal (unit vector in Cartesian coordinates).
///
/// G_hkl = h*a* + k*b* + l*c*
pub fn miller_to_normal(hkl: MillerIndex, lattice: &Lattice) -> Vector3<f64> {
    let [h, k, l] = hkl;
    let recip = reciprocal_lattice_cryst(lattice);

    let a_star = recip.row(0).transpose();
    let b_star = recip.row(1).transpose();
    let c_star = recip.row(2).transpose();

    let g = (h as f64) * a_star + (k as f64) * b_star + (l as f64) * c_star;

    let len = g.norm();
    if len < EPS {
        Vector3::z()
    } else {
        g / len
    }
}

/// Compute d-spacing for Miller index: d_hkl = 1 / |G_hkl|.
pub fn compute_d_spacing(hkl: MillerIndex, lattice: &Lattice) -> f64 {
    let [h, k, l] = hkl;
    let recip = reciprocal_lattice_cryst(lattice);

    let a_star = recip.row(0).transpose();
    let b_star = recip.row(1).transpose();
    let c_star = recip.row(2).transpose();

    let g = (h as f64) * a_star + (k as f64) * b_star + (l as f64) * c_star;

    let len = g.norm();
    if len > EPS {
        1.0 / len
    } else {
        f64::INFINITY
    }
}

/// Compute slab bounds based on growth mode.
pub fn compute_slab_bounds(offset: f64, thickness: f64, growth_mode: GrowthMode) -> (f64, f64) {
    match growth_mode {
        GrowthMode::AnchorMinusZ => (offset - thickness, offset),
        GrowthMode::AnchorPlusZ => (offset, offset + thickness),
        GrowthMode::Centered => (offset - thickness / 2.0, offset + thickness / 2.0),
    }
}

// =============================================================================
// In-Plane Vector Finding
// =============================================================================

/// Find two linearly independent in-plane lattice vectors for a Miller index.
/// These vectors lie in the (hkl) plane and span the 2D surface lattice.
pub fn find_in_plane_vectors(hkl: MillerIndex, lattice: &Lattice) -> (Vector3<f64>, Vector3<f64>) {
    let [h, k, l] = hkl;
    let m = lattice.matrix();
    let a = Vector3::new(m[(0, 0)], m[(0, 1)], m[(0, 2)]);
    let b = Vector3::new(m[(1, 0)], m[(1, 1)], m[(1, 2)]);
    let c = Vector3::new(m[(2, 0)], m[(2, 1)], m[(2, 2)]);

    // Search for lattice vectors that lie in the plane
    // A vector R = n1*a + n2*b + n3*c lies in (hkl) plane if h*n1 + k*n2 + l*n3 = 0

    let mut candidates: Vec<(Vector3<f64>, f64, [i32; 3])> = Vec::new();
    let max_n = 3;

    for n1 in -max_n..=max_n {
        for n2 in -max_n..=max_n {
            for n3 in -max_n..=max_n {
                if n1 == 0 && n2 == 0 && n3 == 0 {
                    continue;
                }

                // Check if this vector lies in the plane
                if h * n1 + k * n2 + l * n3 != 0 {
                    continue;
                }

                let vec = (n1 as f64) * a + (n2 as f64) * b + (n3 as f64) * c;
                let len = vec.norm();
                if len > EPS {
                    candidates.push((vec, len, [n1, n2, n3]));
                }
            }
        }
    }

    // Sort by length
    candidates.sort_by(|x, y| x.1.partial_cmp(&y.1).unwrap_or(std::cmp::Ordering::Equal));

    if candidates.len() < 2 {
        // Fallback: use orthogonal vectors
        let normal = miller_to_normal(hkl, lattice);
        return find_orthogonal_basis(&normal);
    }

    let v1 = candidates[0].0;

    // Find second vector that's not parallel to v1
    for i in 1..candidates.len() {
        let v2 = candidates[i].0;
        let cross = v1.cross(&v2);
        let cross_len = cross.norm();

        if cross_len > EPS * candidates[0].1 * candidates[i].1 {
            return (v1, v2);
        }
    }

    // Fallback
    let normal = miller_to_normal(hkl, lattice);
    find_orthogonal_basis(&normal)
}

/// Find two orthogonal vectors perpendicular to the given normal.
fn find_orthogonal_basis(normal: &Vector3<f64>) -> (Vector3<f64>, Vector3<f64>) {
    // Find a vector not parallel to normal
    let seed = if normal[0].abs() > 0.9 {
        Vector3::y()
    } else {
        Vector3::x()
    };

    // v1 = seed - (seed · normal) * normal
    let dot = seed.dot(normal);
    let v1 = seed - dot * normal;
    let v1_norm = v1.normalize();

    // v2 = normal × v1
    let v2 = normal.cross(&v1_norm);

    (v1_norm, v2)
}

/// Apply Gaussian lattice reduction to get shorter, more orthogonal basis vectors.
pub fn gaussian_reduce_2d(v1: Vector3<f64>, v2: Vector3<f64>) -> (Vector3<f64>, Vector3<f64>) {
    let mut a = v1;
    let mut b = v2;

    for _ in 0..100 {
        let len_a = a.norm();
        let len_b = b.norm();

        // Ensure |a| <= |b|
        if len_a > len_b {
            std::mem::swap(&mut a, &mut b);
        }

        // Reduce b by a
        let dot_ab = a.dot(&b);
        let dot_aa = a.dot(&a);

        if dot_aa < EPS {
            break;
        }

        let mu = (dot_ab / dot_aa).round() as i32;
        if mu == 0 {
            break;
        }

        b -= (mu as f64) * a;
    }

    (a, b)
}

// =============================================================================
// Rotation Matrix Construction
// =============================================================================

/// Build rotation matrix that transforms coordinates so that:
/// - New Z axis is the surface normal (perpendicular to hkl plane)
/// - New X, Y axes are in the hkl plane
///
/// Returns a 3x3 rotation matrix R where R * old_coords = new_coords.
pub fn build_slab_rotation_matrix(hkl: MillerIndex, lattice: &Lattice) -> Matrix3<f64> {
    let normal = miller_to_normal(hkl, lattice);

    // Find in-plane vectors
    let (v1, v2) = find_in_plane_vectors(hkl, lattice);
    let (v1_reduced, _v2_reduced) = gaussian_reduce_2d(v1, v2);

    // Normalize v1 as new X axis
    let new_x = v1_reduced.normalize();

    // new_y = normal × new_x (ensures right-handed system)
    let new_y = normal.cross(&new_x).normalize();

    // Rotation matrix: rows are the new basis vectors expressed in old coords
    Matrix3::from_rows(&[new_x.transpose(), new_y.transpose(), normal.transpose()])
}

// =============================================================================
// Slab Generation
// =============================================================================

/// Wrap a value to [0, 1) range.
fn wrap_to_unit(x: f64) -> f64 {
    let wrapped = x - x.floor();
    if wrapped >= 1.0 {
        0.0
    } else {
        wrapped
    }
}

/// Rotate a point by a rotation matrix.
fn rotate_point(p: &Vector3<f64>, r: &Matrix3<f64>) -> Vector3<f64> {
    r * p
}

/// 2D fractional coordinate conversion (only XY plane).
fn cartesian_to_fractional_2d(xyz: &Vector3<f64>, a: &Vector3<f64>, b: &Vector3<f64>) -> (f64, f64) {
    // 2x2 matrix inversion for XY plane
    let det = a[0] * b[1] - a[1] * b[0];
    if det.abs() < 1e-10 {
        return (0.0, 0.0);
    }
    let frac_x = (xyz[0] * b[1] - xyz[1] * b[0]) / det;
    let frac_y = (-xyz[0] * a[1] + xyz[1] * a[0]) / det;
    (frac_x, frac_y)
}

/// Generate a slab from a bulk crystal structure.
///
/// The resulting slab has:
/// - Z axis perpendicular to (hkl) plane
/// - Atoms within the specified thickness range
/// - Vacuum layer added in Z direction
/// - In-plane coordinates properly wrapped to unit cell
pub fn generate_slab(structure: &Structure, config: &SlabConfig) -> Result<Structure> {
    let SlabConfig {
        miller_index,
        offset,
        thickness,
        vacuum,
        growth_mode,
        supercell,
    } = config;

    if !is_valid_miller(*miller_index) {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "Miller index cannot be (0, 0, 0)".to_string(),
        });
    }

    if *thickness <= 0.0 {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: format!("Thickness must be positive, got {thickness}"),
        });
    }

    let [na, nb] = *supercell;
    if na <= 0 || nb <= 0 {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: format!("Supercell factors must be positive, got [{na}, {nb}]"),
        });
    }

    let d_spacing = compute_d_spacing(*miller_index, &structure.lattice);
    let required_thickness = thickness + d_spacing * 2.0;
    let rc = build_rotated_supercell(structure, *miller_index, required_thickness)?;

    // Select atoms within thickness window
    let (lower, upper) = compute_slab_bounds(*offset, *thickness, *growth_mode);

    let selected_sites: Vec<_> = rc.sites
        .iter()
        .filter(|(xyz, _)| xyz[2] >= lower - 0.01 && xyz[2] <= upper + 0.01)
        .cloned()
        .collect();

    if selected_sites.is_empty() {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: format!(
                "No atoms in slab window [{:.2}, {:.2}]. Try adjusting offset or thickness.",
                lower, upper
            ),
        });
    }

    finalize_slab(structure, &selected_sites, &rc.surf_a, &rc.surf_b, *vacuum, *supercell)
}

// =============================================================================
// Layer Detection
// =============================================================================

/// Information about a detected atomic layer.
#[derive(Debug, Clone)]
pub struct AtomLayer {
    /// Layer index (0-based).
    pub layer_idx: usize,
    /// Distance from reference point along normal (Angstroms).
    pub distance: f64,
    /// Indices of atoms in this layer.
    pub site_indices: Vec<usize>,
    /// Layer thickness (distance to next layer, or 0 for last).
    pub thickness: f64,
}

/// Detect atomic layers along a given normal direction.
pub fn detect_layers(structure: &Structure, normal: &Vector3<f64>) -> Vec<AtomLayer> {
    let cart_coords = structure.cart_coords();
    if cart_coords.is_empty() {
        return vec![];
    }

    // Compute distance for each atom along the normal
    let mut atom_distances: Vec<(usize, f64)> = cart_coords
        .iter()
        .enumerate()
        .map(|(idx, xyz)| (idx, xyz.dot(normal)))
        .collect();

    // Sort by distance
    atom_distances.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    // Group into layers
    let mut layers: Vec<AtomLayer> = Vec::new();
    let mut current_layer: Option<(Vec<usize>, Vec<f64>)> = None;

    for (site_idx, dist) in atom_distances {
        if let Some((ref mut indices, ref mut distances)) = current_layer {
            let avg_dist: f64 = distances.iter().sum::<f64>() / distances.len() as f64;
            if (dist - avg_dist).abs() <= LAYER_TOLERANCE {
                // Same layer
                indices.push(site_idx);
                distances.push(dist);
            } else {
                // New layer - save current and start new
                let layer_dist: f64 = distances.iter().sum::<f64>() / distances.len() as f64;
                layers.push(AtomLayer {
                    layer_idx: layers.len(),
                    distance: layer_dist,
                    site_indices: indices.clone(),
                    thickness: 0.0,
                });
                current_layer = Some((vec![site_idx], vec![dist]));
            }
        } else {
            current_layer = Some((vec![site_idx], vec![dist]));
        }
    }

    // Don't forget the last layer
    if let Some((indices, distances)) = current_layer {
        if !indices.is_empty() {
            let layer_dist: f64 = distances.iter().sum::<f64>() / distances.len() as f64;
            layers.push(AtomLayer {
                layer_idx: layers.len(),
                distance: layer_dist,
                site_indices: indices,
                thickness: 0.0,
            });
        }
    }

    // Compute layer thicknesses
    for i in 0..layers.len().saturating_sub(1) {
        layers[i].thickness = layers[i + 1].distance - layers[i].distance;
    }

    layers
}

/// Get the thickness needed to include N layers starting from a given offset.
pub fn thickness_for_layers(
    layers: &[AtomLayer],
    start_offset: f64,
    num_layers: usize,
) -> (f64, Vec<AtomLayer>) {
    if layers.is_empty() || num_layers == 0 {
        return (0.0, vec![]);
    }

    let mut sorted_layers: Vec<_> = layers.to_vec();
    sorted_layers.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap_or(std::cmp::Ordering::Equal));

    // Find first layer at or after start_offset
    let start_idx = sorted_layers
        .iter()
        .position(|l| l.distance >= start_offset - LAYER_TOLERANCE)
        .unwrap_or(0);

    let end_idx = std::cmp::min(start_idx + num_layers, sorted_layers.len());
    let included: Vec<_> = sorted_layers[start_idx..end_idx].to_vec();

    if included.is_empty() {
        return (0.0, vec![]);
    }

    let first_dist = included[0].distance;
    let last_dist = included[included.len() - 1].distance;
    let padding = 1.0; // Approximate atom radius padding

    ((last_dist - first_dist) + padding * 2.0, included)
}

// =============================================================================
// Rotated Supercell Builder (shared by generate_slab and generate_slab_layers)
// =============================================================================

/// Intermediate result of building a rotated supercell along a Miller normal.
struct RotatedSupercell {
    /// Atoms in the rotated frame: (cartesian_xyz, original_site_index)
    sites: Vec<(Vector3<f64>, usize)>,
    /// In-plane surface lattice vector a (Z=0)
    surf_a: Vector3<f64>,
    /// In-plane surface lattice vector b (Z=0)
    surf_b: Vector3<f64>,
    /// d-spacing for this Miller index
    d_spacing: f64,
}

/// Build a rotated supercell: replicate bulk, rotate so normal→+Z, find surface vectors.
/// This is steps 1–5 of generate_slab, extracted for reuse.
fn build_rotated_supercell(
    structure: &Structure,
    miller_index: MillerIndex,
    required_thickness: f64,
) -> Result<RotatedSupercell> {
    let old_lattice = &structure.lattice;
    let m = old_lattice.matrix();
    let a = Vector3::new(m[(0, 0)], m[(0, 1)], m[(0, 2)]);
    let b = Vector3::new(m[(1, 0)], m[(1, 1)], m[(1, 2)]);
    let c = Vector3::new(m[(2, 0)], m[(2, 1)], m[(2, 2)]);

    let normal = miller_to_normal(miller_index, old_lattice);
    let d_spacing = compute_d_spacing(miller_index, old_lattice);

    let a_proj = a.dot(&normal).abs();
    let b_proj = b.dot(&normal).abs();
    let c_proj = c.dot(&normal).abs();

    let rep_a = if a_proj > 0.1 { (required_thickness / a_proj).ceil() as i32 + 1 } else { 1 };
    let rep_b = if b_proj > 0.1 { (required_thickness / b_proj).ceil() as i32 + 1 } else { 1 };
    let rep_c = if c_proj > 0.1 { (required_thickness / c_proj).ceil() as i32 + 1 } else { 1 };

    // Generate supercell atoms
    let cart_coords = structure.cart_coords();
    let mut supercell_sites: Vec<(Vector3<f64>, usize)> = Vec::new();
    for ia in -rep_a..=rep_a {
        for ib in -rep_b..=rep_b {
            for ic in -rep_c..=rep_c {
                let shift = (ia as f64) * a + (ib as f64) * b + (ic as f64) * c;
                for (idx, xyz) in cart_coords.iter().enumerate() {
                    supercell_sites.push((*xyz + shift, idx));
                }
            }
        }
    }

    // Find in-plane surface lattice vectors
    let (v1, v2) = find_in_plane_vectors(miller_index, old_lattice);
    let (v1_reduced, v2_reduced) = gaussian_reduce_2d(v1, v2);

    // Rotate so normal → +Z
    let r = build_slab_rotation_matrix(miller_index, old_lattice);
    let rotated_sites: Vec<_> = supercell_sites
        .iter()
        .map(|(xyz, site_idx)| (rotate_point(xyz, &r), *site_idx))
        .collect();

    let rotated_a_raw = rotate_point(&v1_reduced, &r);
    let rotated_b_raw = rotate_point(&v2_reduced, &r);
    let surf_a = Vector3::new(rotated_a_raw[0], rotated_a_raw[1], 0.0);
    let surf_b = Vector3::new(rotated_b_raw[0], rotated_b_raw[1], 0.0);

    Ok(RotatedSupercell { sites: rotated_sites, surf_a, surf_b, d_spacing })
}

/// From rotated atoms, wrap XY, dedup, center with vacuum, build final Structure.
/// This is steps 7–11 of generate_slab, extracted for reuse.
fn finalize_slab(
    structure: &Structure,
    selected_sites: &[(Vector3<f64>, usize)],
    surf_a: &Vector3<f64>,
    surf_b: &Vector3<f64>,
    vacuum: f64,
    supercell: [i32; 2],
) -> Result<Structure> {
    let [na, nb] = supercell;

    // Wrap XY to surface unit cell [0, 1)
    let wrapped_sites: Vec<_> = selected_sites
        .iter()
        .map(|(xyz, site_idx)| {
            let (frac_x, frac_y) = cartesian_to_fractional_2d(xyz, surf_a, surf_b);
            let wrapped_frac_x = wrap_to_unit(frac_x);
            let wrapped_frac_y = wrap_to_unit(frac_y);
            let wrapped_x = wrapped_frac_x * surf_a[0] + wrapped_frac_y * surf_b[0];
            let wrapped_y = wrapped_frac_x * surf_a[1] + wrapped_frac_y * surf_b[1];
            (Vector3::new(wrapped_x, wrapped_y, xyz[2]), *site_idx, [wrapped_frac_x, wrapped_frac_y])
        })
        .collect();

    // Remove duplicate atoms
    let mut unique_sites: Vec<(Vector3<f64>, usize, [f64; 2])> = Vec::new();
    for (xyz, site_idx, frac_xy) in &wrapped_sites {
        let is_duplicate = unique_sites.iter().any(|(existing_xyz, existing_idx, _)| {
            let dx = (xyz[0] - existing_xyz[0]).abs();
            let dy = (xyz[1] - existing_xyz[1]).abs();
            let dz = (xyz[2] - existing_xyz[2]).abs();
            let same_element = structure.site_occupancies[*site_idx].dominant_species()
                == structure.site_occupancies[*existing_idx].dominant_species();
            dx < DUPLICATE_TOL && dy < DUPLICATE_TOL && dz < DUPLICATE_TOL && same_element
        });
        if !is_duplicate {
            unique_sites.push((*xyz, *site_idx, *frac_xy));
        }
    }

    if unique_sites.is_empty() {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "No unique atoms after duplicate removal".to_string(),
        });
    }

    // Center slab with vacuum
    let min_z = unique_sites.iter().map(|(xyz, _, _)| xyz[2]).fold(f64::INFINITY, f64::min);
    let max_z = unique_sites.iter().map(|(xyz, _, _)| xyz[2]).fold(f64::NEG_INFINITY, f64::max);
    let slab_thickness_actual = max_z - min_z;
    let z_shift = -min_z + vacuum / 2.0;

    let shifted_sites: Vec<_> = unique_sites
        .iter()
        .map(|(xyz, site_idx, frac_xy)| {
            (Vector3::new(xyz[0], xyz[1], xyz[2] + z_shift), *site_idx, *frac_xy)
        })
        .collect();

    // Build final slab lattice
    let total_z = slab_thickness_actual + vacuum;
    let new_a = Vector3::new(surf_a[0] * (na as f64), surf_a[1] * (na as f64), 0.0);
    let new_b = Vector3::new(surf_b[0] * (nb as f64), surf_b[1] * (nb as f64), 0.0);
    let new_c = Vector3::new(0.0, 0.0, total_z);

    let new_matrix = Matrix3::from_rows(&[new_a.transpose(), new_b.transpose(), new_c.transpose()]);
    let mut new_lattice = Lattice::new(new_matrix);
    new_lattice.pbc = [true, true, false];

    // Apply in-plane supercell expansion and build final structure
    let mut final_frac_coords = Vec::new();
    let mut final_site_occupancies = Vec::new();

    for (xyz, site_idx, frac_xy) in &shifted_sites {
        for ia in 0..na {
            for ib in 0..nb {
                let super_frac_a = (frac_xy[0] + ia as f64) / (na as f64);
                let super_frac_b = (frac_xy[1] + ib as f64) / (nb as f64);
                let super_frac_c = wrap_to_unit(xyz[2] / total_z);
                final_frac_coords.push(Vector3::new(super_frac_a, super_frac_b, super_frac_c));
                final_site_occupancies.push(structure.site_occupancies[*site_idx].clone());
            }
        }
    }

    // First build a 1×1 slab (ignoring supercell request)
    let mut slab_1x1_frac = Vec::new();
    let mut slab_1x1_occ = Vec::new();
    let lattice_1x1 = Lattice::new(Matrix3::from_rows(&[
        Vector3::new(surf_a[0], surf_a[1], 0.0).transpose(),
        Vector3::new(surf_b[0], surf_b[1], 0.0).transpose(),
        new_c.transpose(),
    ]));
    for (xyz, site_idx, frac_xy) in &shifted_sites {
        let frac_c = wrap_to_unit(xyz[2] / total_z);
        slab_1x1_frac.push(Vector3::new(frac_xy[0], frac_xy[1], frac_c));
        slab_1x1_occ.push(structure.site_occupancies[*site_idx].clone());
    }
    let mut slab_1x1 = Structure::try_new_from_occupancies(
        { let mut l = lattice_1x1; l.pbc = [true, true, false]; l },
        slab_1x1_occ, slab_1x1_frac,
    )?;

    // Reduce to primitive surface unit cell (e.g., FCC (111) 6 atoms/layer → 1).
    // Only accept the reduction if it is a pure in-plane sublattice change that
    // preserves the surface frame (in-plane vectors stay in the z≈0 plane and the
    // perpendicular stacking vector c is unchanged). See the inline note below.
    {
        let orig_c = new_c;
        match crate::structure::reduce_slab_in_plane_primitive(slab_1x1.clone(), 0.01) {
            Ok(reduced) => {
                let rm = reduced.lattice.matrix();
                let red_a = Vector3::new(rm[(0, 0)], rm[(0, 1)], rm[(0, 2)]);
                let red_b = Vector3::new(rm[(1, 0)], rm[(1, 1)], rm[(1, 2)]);
                let red_c = Vector3::new(rm[(2, 0)], rm[(2, 1)], rm[(2, 2)]);
                // Accept the primitive reduction iff it is a pure IN-PLANE
                // sublattice change that preserves the surface orientation: both
                // reduced surface vectors stay in the surface plane (z ≈ 0) and the
                // stacking vector c is unchanged (still perpendicular). Species- and
                // area-preservation are already enforced inside the reduction helper
                // (is_lattice_translation + integer area-ratio), so the only thing
                // left to guard here is the surface frame itself. This accepts the
                // FCC(111) primitive (whose surface basis rotates 60°/120° in-plane
                // but keeps c ⟂ surface) — the earlier slot-paired "parallel to the
                // original surf vector" test wrongly rejected it — while still
                // rejecting any reduction that tilts a vector out of the plane or
                // alters the perpendicular c.
                let in_plane = red_a.z.abs() < 1e-6 && red_b.z.abs() < 1e-6;
                let c_unchanged = (red_c - orig_c).norm() < 1e-6;
                if in_plane && c_unchanged {
                    slab_1x1 = reduced;
                }
                // else: reduction rotates/tilts the surface frame — skip it
            }
            Err(_) => {} // reduction failed — keep original
        }
    }

    // Apply in-plane supercell expansion with simple loop (fast)
    if na > 1 || nb > 1 {
        let prim_mat = *slab_1x1.lattice.matrix();
        let prim_a = Vector3::new(prim_mat[(0, 0)], prim_mat[(0, 1)], prim_mat[(0, 2)]);
        let prim_b = Vector3::new(prim_mat[(1, 0)], prim_mat[(1, 1)], prim_mat[(1, 2)]);
        let prim_c = Vector3::new(prim_mat[(2, 0)], prim_mat[(2, 1)], prim_mat[(2, 2)]);
        let super_a = prim_a * na as f64;
        let super_b = prim_b * nb as f64;
        let super_mat = Matrix3::from_rows(&[super_a.transpose(), super_b.transpose(), prim_c.transpose()]);
        let mut super_lattice = Lattice::new(super_mat);
        super_lattice.pbc = slab_1x1.lattice.pbc;

        let mut super_frac = Vec::new();
        let mut super_occ = Vec::new();
        for (fc, occ) in slab_1x1.frac_coords.iter().zip(slab_1x1.site_occupancies.iter()) {
            for ia in 0..na {
                for ib in 0..nb {
                    super_frac.push(Vector3::new(
                        (fc.x + ia as f64) / na as f64,
                        (fc.y + ib as f64) / nb as f64,
                        fc.z,
                    ));
                    super_occ.push(occ.clone());
                }
            }
        }
        slab_1x1 = Structure::try_new_from_occupancies(super_lattice, super_occ, super_frac)?;
    }

    Ok(slab_1x1)
}

// =============================================================================
// Layer-Counted Slab Generation with Termination Selection
// =============================================================================

/// Information about a surface termination.
#[derive(Clone, Debug)]
pub struct TerminationInfo {
    /// Z-height of this layer in the rotated frame (Å).
    pub height: f64,
    /// Element symbols present in this termination layer.
    pub elements: Vec<String>,
}

/// Detect layers in the rotated supercell by Z coordinate.
/// Returns layers sorted by Z, each with the Z-height, original site indices, and elements.
fn detect_layers_in_rotated(
    rotated_sites: &[(Vector3<f64>, usize)],
) -> Vec<(f64, Vec<usize>)> {
    if rotated_sites.is_empty() {
        return vec![];
    }

    // Sort by Z
    let mut by_z: Vec<(f64, usize)> = rotated_sites
        .iter()
        .enumerate()
        .map(|(i, (xyz, _))| (xyz[2], i))
        .collect();
    by_z.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Cluster by Z with tolerance.
    // Compare each atom to the FIRST atom in the current layer (NOT a rolling
    // average): a drifting average merges adjacent layers, so the average-based
    // clustering counted FEWER layers than the TS `detect_layers`
    // (miller-slab.ts) which compares to the first atom. That mismatch made the
    // layer-based slab cut produce fewer layers than the preview showed
    // (request 6 -> got 4). Keep this identical to the TS implementation.
    let mut layers: Vec<(f64, Vec<usize>)> = Vec::new();
    let mut cur_first_z = by_z[0].0;
    let mut cur_z_sum = by_z[0].0;
    let mut cur_indices = vec![by_z[0].1];
    let mut cur_count = 1usize;

    for &(z, idx) in &by_z[1..] {
        if (z - cur_first_z).abs() <= LAYER_TOLERANCE {
            cur_z_sum += z;
            cur_count += 1;
            cur_indices.push(idx);
        } else {
            layers.push((cur_z_sum / cur_count as f64, cur_indices));
            cur_first_z = z;
            cur_z_sum = z;
            cur_count = 1;
            cur_indices = vec![idx];
        }
    }
    layers.push((cur_z_sum / cur_count as f64, cur_indices));

    layers
}

/// Identify unique termination types within one d-spacing period.
///
/// Builds a rotated supercell, detects layers by Z, wraps + deduplicates
/// one d-spacing worth of layers, and returns element info for each.
pub fn get_terminations(
    structure: &Structure,
    miller_index: MillerIndex,
) -> Vec<TerminationInfo> {
    let d_spacing = compute_d_spacing(miller_index, &structure.lattice);
    // Build a supercell covering ~2 d-spacings (enough to see one full period)
    let rc = match build_rotated_supercell(structure, miller_index, d_spacing * 4.0) {
        Ok(rc) => rc,
        Err(_) => return vec![],
    };

    let all_layers = detect_layers_in_rotated(&rc.sites);
    if all_layers.is_empty() {
        return vec![];
    }

    // Take layers within one d-spacing period from the center
    let center_z = all_layers[all_layers.len() / 2].0;
    let period_layers: Vec<_> = all_layers
        .iter()
        .filter(|(z, _)| *z >= center_z && *z < center_z + d_spacing - LAYER_TOLERANCE)
        .collect();

    period_layers
        .iter()
        .map(|(z, atom_indices)| {
            let mut elements: Vec<String> = atom_indices
                .iter()
                .filter_map(|&ri| {
                    let (_, site_idx) = rc.sites[ri];
                    structure
                        .site_occupancies
                        .get(site_idx)
                        .map(|occ| occ.dominant_species().element.symbol().to_string())
                })
                .collect();
            elements.sort();
            elements.dedup();
            TerminationInfo { height: *z, elements }
        })
        .collect()
}

/// Generate a slab with exact layer counting and termination selection.
///
/// Builds a thick rotated supercell, detects layers by Z coordinate in the
/// rotated frame, selects exactly `num_layers` layers starting from the chosen
/// termination, then finalizes the slab.
pub fn generate_slab_layers(
    structure: &Structure,
    miller_index: MillerIndex,
    num_layers: usize,
    termination_index: usize,
    vacuum: f64,
    supercell: [i32; 2],
) -> Result<Structure> {
    if !is_valid_miller(miller_index) {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "Miller index cannot be (0, 0, 0)".to_string(),
        });
    }
    if num_layers == 0 {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "Number of layers must be positive".to_string(),
        });
    }

    let d_spacing = compute_d_spacing(miller_index, &structure.lattice);
    if !(d_spacing.is_finite() && d_spacing > EPS) {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "Degenerate d-spacing for Miller index".to_string(),
        });
    }
    // Build supercell thick enough: num_layers periods + margin on each side.
    let required = (num_layers as f64 + 4.0) * d_spacing;
    let rc = build_rotated_supercell(structure, miller_index, required)?;

    if rc.sites.is_empty() {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "No atoms in rotated supercell".to_string(),
        });
    }

    // ---------------------------------------------------------------------
    // D-spacing repeat-unit selection (ASE `surface()` convention).
    //
    // The previous implementation grouped atoms into individual atomic
    // z-planes and selected `num_layers` CONSECUTIVE planes. For rutile
    // oxides a stoichiometric repeat unit spans several unequally-spaced,
    // individually-non-stoichiometric planes ({M+O},{O},{O}), so slicing N
    // consecutive planes cut mid-repeat-unit and dropped O.
    //
    // Instead we quantise by the surface d-spacing: each atom gets a PERIOD
    // INDEX p = floor((z - z0)/d + tol), and we select `num_layers` COMPLETE
    // repeat units p ∈ [start, start+num_layers). For metals/rocksalt one
    // atomic plane spans one d-spacing, so this reduces to the old behaviour
    // (num_layers periods == num_layers planes). For FCC(111) each (111)
    // plane is one d-spacing apart → num_layers planes. For rutile it is
    // num_layers full {M,2O} units → stoichiometric, matching ASE.
    // ---------------------------------------------------------------------

    // Reference z near the center of the rotated stack.
    let mut zs: Vec<f64> = rc.sites.iter().map(|(xyz, _)| xyz[2]).collect();
    zs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let center_z = zs[zs.len() / 2];

    // Enumerate the distinct sub-period offsets (atomic z-plane positions
    // modulo one d-spacing). `termination_index` selects which of these
    // distinct in-period sub-planes the period origin sits on, i.e. which
    // termination is exposed. Offsets are taken relative to `center_z` so the
    // arithmetic is numerically stable regardless of absolute z.
    let frac_tol = LAYER_TOLERANCE / d_spacing; // plane tolerance as a fraction of a period
    let mut sub_offsets: Vec<f64> = Vec::new();
    for &z in &zs {
        // fractional position within the period, in [0, 1)
        let mut f = ((z - center_z) / d_spacing).rem_euclid(1.0);
        if f >= 1.0 - frac_tol {
            f = 0.0; // fold the near-1.0 plane onto 0.0
        }
        if !sub_offsets.iter().any(|&o| (o - f).abs() <= frac_tol) {
            sub_offsets.push(f);
        }
    }
    sub_offsets.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if sub_offsets.is_empty() {
        sub_offsets.push(0.0);
    }
    let n_sub = sub_offsets.len();

    // Shift the period origin so the cut lands on the chosen sub-plane. A small
    // negative epsilon keeps the chosen plane inside (not on the boundary of)
    // the period it opens.
    let term_offset = sub_offsets[termination_index % n_sub];
    let z0 = center_z + (term_offset - frac_tol) * d_spacing;

    // Assign every atom a period index relative to z0.
    let period_of = |z: f64| -> i64 { ((z - z0) / d_spacing + frac_tol).floor() as i64 };

    // Center the selection window on the supercell middle so every selected
    // repeat unit lies in the fully-populated interior. The supercell is built
    // symmetrically about z, so its XY coverage is ragged only near the top and
    // bottom; an off-center (grow-upward-only) window pushed the top period into
    // that ragged zone and under-populated its planes after the XY wrap+dedup,
    // breaking stoichiometry. Centering keeps both surfaces of the slab away
    // from the supercell edges.
    let center_p = period_of(center_z);
    let start_p = center_p - (num_layers as i64) / 2;
    let end_p = start_p + num_layers as i64; // exclusive

    let mut selected_sites: Vec<(Vector3<f64>, usize)> = rc
        .sites
        .iter()
        .filter(|(xyz, _)| {
            let p = period_of(xyz[2]);
            p >= start_p && p < end_p
        })
        .cloned()
        .collect();

    // In-plane registry nudge so no atom sits EXACTLY on the surface-cell
    // boundary when finalize_slab wraps XY into [0,1).
    //
    // finalize_slab folds each atom's in-plane fractional coords to [0,1) and
    // then de-duplicates by Cartesian proximity. An atom that lands at a cell
    // CORNER/EDGE (frac-XY component == 0.0 or 1.0) is degenerate: its periodic
    // images sit on BOTH opposing edges (0.0 and 1.0), a full surface vector
    // apart, so the dedup — which only merges atoms within DUPLICATE_TOL — keeps
    // them as DISTINCT atoms and double-counts that plane. Whether a plane hits
    // the boundary depends only on the supercell-origin phase relative to
    // (surf_a, surf_b): for glided facets (e.g. rutile (110)/(001), rocksalt
    // (110)) consecutive periods are laterally shifted, so some selected planes
    // land exactly on the cell boundary and some don't → asymmetric
    // double-counting that silently breaks stoichiometry (observed: a {M+O}
    // plane keeping 2× M but 1× O on RuO2(110)/(001) and NiO(110)).
    //
    // A single uniform in-plane translation of the whole selected set is a pure
    // PBC no-op (x,y are periodic), but it moves every atom off the exact
    // boundary into the cell interior, making the subsequent wrap+dedup
    // unambiguous for ALL planes at once. The shift is an irrational-ish
    // fraction of each surface vector so it never re-lands a different plane's
    // atoms onto the boundary. Metals/rocksalt/FCC(111) are unaffected in count
    // (their planes were already interior or are now cleanly deduped); rutile
    // now keeps full {M,2O} repeat units, matching ASE.
    {
        let nudge = 0.001_f64.mul_add(rc.surf_b[0], 0.0017 * rc.surf_a[0]);
        let nudge_y = 0.001_f64.mul_add(rc.surf_b[1], 0.0017 * rc.surf_a[1]);
        let shift = Vector3::new(nudge, nudge_y, 0.0);
        for (xyz, _) in selected_sites.iter_mut() {
            *xyz += shift;
        }
    }

    #[cfg(test)]
    if std::env::var("SLAB_DEBUG").is_ok() {
        use std::collections::BTreeMap;
        let mut per: BTreeMap<i64, BTreeMap<String, usize>> = BTreeMap::new();
        for (xyz, si) in &rc.sites {
            let p = period_of(xyz[2]);
            if p < start_p - 1 || p > end_p { continue; }
            let sym = structure.site_occupancies[*si].dominant_species().element.symbol().to_string();
            *per.entry(p).or_default().entry(sym).or_default() += 1;
        }
        eprintln!("DEBUG hkl={:?} d={:.4} center_z={:.4} z0={:.4} term_off={:.4} subs={:?} start_p={} end_p={}", miller_index, d_spacing, center_z, z0, term_offset, sub_offsets, start_p, end_p);
        for (p, m) in &per { eprintln!("  period {}: {:?}", p, m); }
        // distinct z-planes (rounded) in the selected set, with element composition
        let mut planes: BTreeMap<i64, BTreeMap<String, usize>> = BTreeMap::new();
        for (xyz, si) in &selected_sites {
            let key = (xyz[2] * 100.0).round() as i64;
            let sym = structure.site_occupancies[*si].dominant_species().element.symbol().to_string();
            *planes.entry(key).or_default().entry(sym).or_default() += 1;
        }
        eprintln!("  SELECTED distinct z-planes ({}):", planes.len());
        for (zk, m) in &planes { eprintln!("    z={:.2}: {:?}", *zk as f64 / 100.0, m); }
    }

    if selected_sites.is_empty() {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "No atoms in selected repeat units".to_string(),
        });
    }

    finalize_slab(structure, &selected_sites, &rc.surf_a, &rc.surf_b, vacuum, supercell)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::species::{SiteOccupancy, Species};

    fn create_fcc_cu() -> Structure {
        // FCC Cu with a = 3.6 Å
        let a = 3.6;
        let lattice = Lattice::cubic(a);

        // FCC positions: (0,0,0), (0.5,0.5,0), (0.5,0,0.5), (0,0.5,0.5)
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.5, 0.5, 0.0),
            Vector3::new(0.5, 0.0, 0.5),
            Vector3::new(0.0, 0.5, 0.5),
        ];

        let cu = Species::from_string("Cu").unwrap();
        let site_occupancies: Vec<_> = frac_coords.iter().map(|_| SiteOccupancy::ordered(cu)).collect();

        Structure::try_new_from_occupancies(lattice, site_occupancies, frac_coords).unwrap()
    }

    /// Generic rutile oxide MO2 (tetragonal P4_2/mnm), internal param u≈0.3053.
    /// M at (0,0,0),(.5,.5,.5); O at (u,u,0),(1-u,1-u,0),(.5+u,.5-u,.5),(.5-u,.5+u,.5).
    fn create_rutile(metal: &str, a: f64, c: f64) -> Structure {
        let lattice = Lattice::tetragonal(a, c);
        let u = 0.3053;
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),         // M
            Vector3::new(0.5, 0.5, 0.5),         // M
            Vector3::new(u, u, 0.0),             // O
            Vector3::new(1.0 - u, 1.0 - u, 0.0), // O
            Vector3::new(0.5 + u, 0.5 - u, 0.5), // O
            Vector3::new(0.5 - u, 0.5 + u, 0.5), // O
        ];
        let m = Species::from_string(metal).unwrap();
        let o = Species::from_string("O").unwrap();
        let occ = vec![
            SiteOccupancy::ordered(m),
            SiteOccupancy::ordered(m),
            SiteOccupancy::ordered(o),
            SiteOccupancy::ordered(o),
            SiteOccupancy::ordered(o),
            SiteOccupancy::ordered(o),
        ];
        Structure::try_new_from_occupancies(lattice, occ, frac_coords).unwrap()
    }

    fn create_rutile_ruo2() -> Structure {
        // Rutile RuO2: tetragonal P4_2/mnm, a=b=4.4919, c=3.1066, u≈0.3053
        create_rutile("Ru", 4.4919, 3.1066)
    }

    /// mp-1068212: cubic Fe2O3 (a=3.788512). Fe at corner+body-center, O at
    /// three face-edge centers. Repro fixture for the "(100)/(001) slab loses
    /// all oxygen" bug.
    fn fe2o3_cubic_mp1068212() -> Structure {
        let lattice = Lattice::cubic(3.788512);
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0), // Fe
            Vector3::new(0.5, 0.5, 0.5), // Fe
            Vector3::new(0.5, 0.0, 0.5), // O
            Vector3::new(0.0, 0.5, 0.5), // O
            Vector3::new(0.5, 0.5, 0.0), // O
        ];
        let fe = Species::from_string("Fe").unwrap();
        let o = Species::from_string("O").unwrap();
        let occ = vec![
            SiteOccupancy::ordered(fe),
            SiteOccupancy::ordered(fe),
            SiteOccupancy::ordered(o),
            SiteOccupancy::ordered(o),
            SiteOccupancy::ordered(o),
        ];
        Structure::try_new_from_occupancies(lattice, occ, frac_coords).unwrap()
    }

    /// Regression: cutting cubic Fe2O3 (mp-1068212) along (100)/(010)/(001)
    /// must keep BOTH species. A buggy in-plane primitive reduction used to map
    /// the cation sublattice onto the anion sublattice and delete all oxygen,
    /// yielding a pure-Fe slab (worst on (100)/(010); (001) was spared). Slabs
    /// are legitimately non-stoichiometric at the surface, so we only assert
    /// both species survive, not an exact 2:3 ratio.
    #[test]
    fn repro_fe2o3_cubic_slab_keeps_oxygen() {
        let structure = fe2o3_cubic_mp1068212();
        let fe = Species::from_string("Fe").unwrap();
        let o = Species::from_string("O").unwrap();
        for mi in [[1, 0, 0], [0, 1, 0], [0, 0, 1]] {
            let config = SlabConfig { miller_index: mi, ..Default::default() };
            let slab = generate_slab(&structure, &config).unwrap();
            let n_fe = slab.site_occupancies.iter().filter(|x| *x.dominant_species() == fe).count();
            let n_o = slab.site_occupancies.iter().filter(|x| *x.dominant_species() == o).count();
            assert!(
                n_fe > 0 && n_o > 0,
                "Miller {mi:?}: slab lost a species — Fe={n_fe} O={n_o} (bulk is Fe2O3)"
            );
        }
    }

    /// Count distinct atomic layers (by cartesian z) in a generated slab.
    fn count_z_layers(s: &Structure) -> usize {
        let mut zs: Vec<f64> = s.cart_coords().iter().map(|v| v.z).collect();
        zs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut layers = 0usize;
        let mut last = f64::NEG_INFINITY;
        for z in zs {
            if z - last > 0.5 {
                layers += 1;
                last = z;
            }
        }
        layers
    }

    #[test]
    fn ruo2_110_layer_count_matches_request() {
        let bulk = create_rutile_ruo2();
        let s4 = generate_slab_layers(&bulk, [1, 1, 0], 4, 0, 15.0, [1, 1]).unwrap();
        let s6 = generate_slab_layers(&bulk, [1, 1, 0], 6, 0, 15.0, [1, 1]).unwrap();
        let l4 = count_z_layers(&s4);
        let l6 = count_z_layers(&s6);
        eprintln!(
            "RuO2(110): num_layers=4 -> {} z-layers, {} atoms | num_layers=6 -> {} z-layers, {} atoms",
            l4, s4.num_sites(), l6, s6.num_sites()
        );
        assert!(
            l6 > l4 && s6.num_sites() > s4.num_sites(),
            "requesting 6 layers gave {} layers/{} atoms, not more than 4 layers ({}/{}) — clamped",
            l6, s6.num_sites(), l4, s4.num_sites()
        );
    }

    fn create_rocksalt_nio() -> Structure {
        // Rocksalt NiO conventional cubic cell, a = 4.13792322 Å (4 Ni + 4 O)
        let lattice = Lattice::cubic(4.13792322);
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0), // Ni
            Vector3::new(0.5, 0.5, 0.0), // Ni
            Vector3::new(0.5, 0.0, 0.5), // Ni
            Vector3::new(0.0, 0.5, 0.5), // Ni
            Vector3::new(0.0, 0.0, 0.5), // O
            Vector3::new(0.5, 0.0, 0.0), // O
            Vector3::new(0.0, 0.5, 0.0), // O
            Vector3::new(0.5, 0.5, 0.5), // O
        ];
        let ni = Species::from_string("Ni").unwrap();
        let o = Species::from_string("O").unwrap();
        let occ = vec![
            SiteOccupancy::ordered(ni), SiteOccupancy::ordered(ni),
            SiteOccupancy::ordered(ni), SiteOccupancy::ordered(ni),
            SiteOccupancy::ordered(o), SiteOccupancy::ordered(o),
            SiteOccupancy::ordered(o), SiteOccupancy::ordered(o),
        ];
        Structure::try_new_from_occupancies(lattice, occ, frac_coords).unwrap()
    }

    fn count_species(s: &Structure, sym: &str) -> usize {
        s.site_occupancies
            .iter()
            .filter(|o| o.dominant_species().element.symbol() == sym)
            .count()
    }

    /// Rocksalt (110) is a neutral, stoichiometric surface: every slab must keep
    /// Ni:O = 1:1. Regression test for the species-blind primitive reduction that
    /// accepted the c/2 cation→anion glide and deleted one whole species.
    #[test]
    fn nio_110_is_stoichiometric() {
        let bulk = create_rocksalt_nio();
        for n in [2usize, 3, 4] {
            let slab = generate_slab_layers(&bulk, [1, 1, 0], n, 0, 15.0, [1, 1]).unwrap();
            let ni = count_species(&slab, "Ni");
            let o = count_species(&slab, "O");
            eprintln!(
                "NiO(110) layers={n}: Ni={ni} O={o} total={}",
                slab.num_sites()
            );
            assert!(ni > 0 && o > 0, "layers={n}: a species was deleted (Ni={ni} O={o})");
            assert_eq!(ni, o, "layers={n}: non-stoichiometric Ni={ni} O={o}");
        }
    }

    /// FCC(111) cut from the conventional cubic cell must reduce to a clean
    /// primitive p(n×n) mesh: uniform atoms per layer (9 for n=3), correct total
    /// (45 for p(3×3)×5), and a surface-perpendicular c vector. Regression for
    /// the slot-paired acceptance guard rejecting the (correct) swapped-slot
    /// primitive reduction, leaving the 4-atom/layer conventional mesh.
    #[test]
    fn fcc111_primitive_p3x3_is_clean() {
        let bulk = create_fcc_cu();
        let slab = generate_slab_layers(&bulk, [1, 1, 1], 5, 0, 15.0, [3, 3]).unwrap();
        assert_eq!(slab.num_sites(), 45, "p(3x3)x5 FCC(111) must be 45 atoms");
        // uniform 9 atoms per z-layer
        let mut zs: Vec<f64> = slab.cart_coords().iter().map(|v| v.z).collect();
        zs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut groups: Vec<usize> = vec![];
        let mut i = 0;
        while i < zs.len() {
            let z0 = zs[i];
            let mut n = 0;
            while i < zs.len() && (zs[i] - z0).abs() < 0.5 {
                n += 1;
                i += 1;
            }
            groups.push(n);
        }
        assert!(groups.iter().all(|&n| n == 9), "every layer must have 9 atoms, got {:?}", groups);
        // c perpendicular to the surface plane
        let c = slab.lattice.matrix();
        assert!(
            c[(2, 0)].abs() < 1e-6 && c[(2, 1)].abs() < 1e-6,
            "c must be perpendicular to surface, got ({}, {})",
            c[(2, 0)],
            c[(2, 1)]
        );
    }

    /// Rutile RuO2(110) must stay stoichiometric (O/Ru == 2) for any layer
    /// count. ASE `surface()` stacks whole oriented unit cells → exact O:M=2.
    /// Cutting by atomic z-plane sliced mid-repeat-unit and dropped O.
    #[test]
    fn rutile_110_stoichiometric() {
        let bulk = create_rutile_ruo2();
        for n in [2usize, 3, 4] {
            let slab = generate_slab_layers(&bulk, [1, 1, 0], n, 0, 15.0, [1, 1]).unwrap();
            let ru = count_species(&slab, "Ru");
            let o = count_species(&slab, "O");
            if std::env::var("SLAB_DEBUG").is_ok() {
                use std::collections::BTreeMap;
                let mut planes: BTreeMap<i64, BTreeMap<String, usize>> = BTreeMap::new();
                for (xyz, occ) in slab.cart_coords().iter().zip(slab.site_occupancies.iter()) {
                    let key = (xyz.z * 100.0).round() as i64;
                    let sym = occ.dominant_species().element.symbol().to_string();
                    *planes.entry(key).or_default().entry(sym).or_default() += 1;
                }
                eprintln!("FINAL RuO2(110) n={n}: planes={}", planes.len());
                for (zk, m) in &planes { eprintln!("    z={:.2}: {:?}", *zk as f64 / 100.0, m); }
            }
            eprintln!("RuO2(110) layers={n}: Ru={ru} O={o} total={}", slab.num_sites());
            assert!(ru > 0 && o > 0, "layers={n}: a species was deleted (Ru={ru} O={o})");
            assert_eq!(o, 2 * ru, "layers={n}: non-stoichiometric O={o} Ru={ru} (want O=2*Ru)");
        }
    }

    /// Rutile RuO2(100) — same stoichiometry guarantee. The (100) repeat unit
    /// spans 6 unequally spaced atomic planes; consecutive-plane cuts drop O.
    #[test]
    fn rutile_100_stoichiometric() {
        let bulk = create_rutile_ruo2();
        for n in [2usize, 3, 4] {
            let slab = generate_slab_layers(&bulk, [1, 0, 0], n, 0, 15.0, [1, 1]).unwrap();
            let ru = count_species(&slab, "Ru");
            let o = count_species(&slab, "O");
            eprintln!("RuO2(100) layers={n}: Ru={ru} O={o} total={}", slab.num_sites());
            assert!(ru > 0 && o > 0, "layers={n}: a species was deleted (Ru={ru} O={o})");
            assert_eq!(o, 2 * ru, "layers={n}: non-stoichiometric O={o} Ru={ru} (want O=2*Ru)");
        }
    }

    /// Rutile RuO2(001) was already stoichiometric (each (001) d-spacing holds a
    /// full {M+2O} unit) — must not regress under the new period-based cut.
    #[test]
    fn rutile_001_still_stoichiometric() {
        let bulk = create_rutile_ruo2();
        for n in [2usize, 3, 4] {
            let slab = generate_slab_layers(&bulk, [0, 0, 1], n, 0, 15.0, [1, 1]).unwrap();
            let ru = count_species(&slab, "Ru");
            let o = count_species(&slab, "O");
            eprintln!("RuO2(001) layers={n}: Ru={ru} O={o} total={}", slab.num_sites());
            assert!(ru > 0 && o > 0, "layers={n}: a species was deleted (Ru={ru} O={o})");
            assert_eq!(o, 2 * ru, "layers={n}: non-stoichiometric O={o} Ru={ru} (want O=2*Ru)");
        }
    }

    /// Rocksalt NiO(100) is 1:1 on every plane — must stay Ni==O (metals/rocksalt
    /// are immune: one atomic plane per d-spacing period).
    #[test]
    fn rocksalt_100_stays_1to1() {
        let bulk = create_rocksalt_nio();
        for n in [2usize, 3, 4] {
            let slab = generate_slab_layers(&bulk, [1, 0, 0], n, 0, 15.0, [1, 1]).unwrap();
            let ni = count_species(&slab, "Ni");
            let o = count_species(&slab, "O");
            eprintln!("NiO(100) layers={n}: Ni={ni} O={o} total={}", slab.num_sites());
            assert!(ni > 0 && o > 0, "layers={n}: a species was deleted (Ni={ni} O={o})");
            assert_eq!(ni, o, "layers={n}: non-stoichiometric Ni={ni} O={o}");
        }
    }

    #[test]
    fn test_normalize_miller() {
        assert_eq!(normalize_miller([2, 4, 6]), [1, 2, 3]);
        assert_eq!(normalize_miller([0, 0, 0]), [0, 0, 1]);
        assert_eq!(normalize_miller([-2, 0, 2]), [-1, 0, 1]);
    }

    #[test]
    fn test_d_spacing_cubic() {
        let lattice = Lattice::cubic(4.0);

        // For cubic: d_hkl = a / sqrt(h² + k² + l²)
        let d_100 = compute_d_spacing([1, 0, 0], &lattice);
        assert!((d_100 - 4.0).abs() < 1e-10);

        let d_110 = compute_d_spacing([1, 1, 0], &lattice);
        assert!((d_110 - 4.0 / 2.0_f64.sqrt()).abs() < 1e-10);

        let d_111 = compute_d_spacing([1, 1, 1], &lattice);
        assert!((d_111 - 4.0 / 3.0_f64.sqrt()).abs() < 1e-10);
    }

    #[test]
    fn test_miller_to_normal() {
        let lattice = Lattice::cubic(4.0);

        // (001) should give +z
        let n_001 = miller_to_normal([0, 0, 1], &lattice);
        assert!((n_001[0]).abs() < 1e-10);
        assert!((n_001[1]).abs() < 1e-10);
        assert!((n_001[2] - 1.0).abs() < 1e-10);

        // (100) should give +x
        let n_100 = miller_to_normal([1, 0, 0], &lattice);
        assert!((n_100[0] - 1.0).abs() < 1e-10);
        assert!((n_100[1]).abs() < 1e-10);
        assert!((n_100[2]).abs() < 1e-10);
    }

    #[test]
    fn test_generate_slab_001() {
        let structure = create_fcc_cu();

        let config = SlabConfig {
            miller_index: [0, 0, 1],
            offset: 0.0,
            thickness: 5.0,
            vacuum: 10.0,
            growth_mode: GrowthMode::Centered,
            supercell: [1, 1],
        };

        let slab = generate_slab(&structure, &config).unwrap();

        // Slab should have atoms
        assert!(slab.num_sites() > 0);

        // Lattice should have non-periodic z
        assert!(!slab.lattice.pbc[2]);
    }

    #[test]
    fn test_detect_layers() {
        let structure = create_fcc_cu();
        let normal = Vector3::new(0.0, 0.0, 1.0);

        let layers = detect_layers(&structure, &normal);

        // FCC along [001] has 2 unique layer heights per unit cell
        assert!(layers.len() >= 2);
    }
}

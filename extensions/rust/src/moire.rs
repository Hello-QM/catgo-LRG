//! Moiré (twisted-bilayer) superlattice construction.
//!
//! Faithful Rust port of `server/catgo/utils/moire_algorithm.py`.
//!
//! Implements the coincidence lattice method for finding commensurate twist
//! angles and building bilayer superstructures. Based on the approach described
//! in the Twister package (S. Carr et al.) and coincidence lattice theory for
//! twisted 2D materials.
//!
//! The Python code uses `numpy` for linear algebra and ASE `Atoms` purely as a
//! container; here we use 2x2 row-major arrays and the crate's core
//! [`Structure`] type as the equivalent container.

use crate::element::Element;
use crate::lattice::Lattice;
use crate::species::{SiteOccupancy, Species};
use crate::structure::Structure;
use nalgebra::Vector3;
use std::collections::HashMap;

/// 2D vector `[x, y]`.
pub type Vec2 = [f64; 2];
/// 2x2 matrix with rows as the two lattice vectors `[[a1x, a1y], [a2x, a2y]]`.
pub type Mat2 = [[f64; 2]; 2];

/// Extracted layer data for Moiré construction (mirror of Python `LayerData`).
#[derive(Debug, Clone)]
pub struct LayerData {
    /// 2D lattice vectors (rows are vectors), Ångström.
    pub lattice_2d: Mat2,
    /// Element symbol per basis atom.
    pub elements: Vec<String>,
    /// Fractional `(a, b)` coordinate per basis atom.
    pub basis_frac: Vec<Vec2>,
}

impl LayerData {
    /// Number of basis atoms in the layer unit cell.
    pub fn n_basis(&self) -> usize {
        self.elements.len()
    }
}

/// A commensurate twist-angle candidate (mirror of Python `CandidateResult`).
#[derive(Debug, Clone)]
pub struct CandidateResult {
    /// Twist angle (degrees).
    pub angle: f64,
    /// Superlattice index m for layer A (first vector).
    pub m: i32,
    /// Superlattice index n for layer A (first vector).
    pub n: i32,
    /// Superlattice index p for layer B (first vector).
    pub p: i32,
    /// Superlattice index q for layer B (first vector).
    pub q: i32,
    /// Superlattice index m2 for layer A (second vector).
    pub m2: i32,
    /// Superlattice index n2 for layer A (second vector).
    pub n2: i32,
    /// Superlattice index p2 for layer B (second vector).
    pub p2: i32,
    /// Superlattice index q2 for layer B (second vector).
    pub q2: i32,
    /// Lattice mismatch (Å) — sum of the two coincidence-vector mismatches.
    pub mismatch: f64,
    /// Estimated total number of atoms in the bilayer supercell.
    pub n_atoms: i64,
    /// Area of supercell / area of unit cell.
    pub area_ratio: f64,
    /// Applied strain magnitude (%) if strain is computed.
    pub strain_percent: Option<f64>,
    /// 2x2 strain tensor if strain is computed.
    pub strain_tensor: Option<Mat2>,
}

/// Search parameters controlling the commensurate-angle search.
///
/// Mirrors `MoireAngleSearchParams` with the same defaults.
#[derive(Debug, Clone)]
pub struct MoireSearchParams {
    /// Minimum twist angle (degrees).
    pub angle_min: f64,
    /// Maximum twist angle (degrees).
    pub angle_max: f64,
    /// Angle step size (degrees).
    pub angle_step: f64,
    /// Maximum superlattice index (m, n, p, q).
    pub max_index: i32,
    /// Maximum allowed mismatch between coincidence lattice vectors (Å).
    pub mismatch_threshold: f64,
    /// Maximum number of atoms in the supercell.
    pub max_atoms: i64,
    /// Which layer to strain: "top", "bottom", or "both".
    pub strain_layer: String,
    /// Whether to compute the strain tensor.
    pub apply_strain: bool,
    /// Maximum allowed strain percentage (filters candidates). 0 disables filter.
    pub max_strain_percent: f64,
    /// Enable deep-search refinement around found candidates.
    pub deep_search: bool,
    /// Angular range (degrees) around each candidate for deep search.
    pub deep_search_range: f64,
    /// Step size (degrees) for deep search refinement.
    pub deep_search_step: f64,
    /// Final (tighter) mismatch threshold for deep search (Å).
    pub final_mismatch_threshold: f64,
    /// If true, search only at the fixed angle.
    pub fix_angle: bool,
    /// Fixed angle value (degrees) when `fix_angle` is true.
    pub fixed_angle_value: f64,
    /// Maximum number of candidates to return.
    pub max_results: usize,
}

impl Default for MoireSearchParams {
    fn default() -> Self {
        Self {
            angle_min: 0.0,
            angle_max: 60.0,
            angle_step: 0.01,
            max_index: 12,
            mismatch_threshold: 0.01,
            max_atoms: 2000,
            strain_layer: "both".to_string(),
            apply_strain: true,
            max_strain_percent: 5.0,
            deep_search: false,
            deep_search_range: 0.5,
            deep_search_step: 0.001,
            final_mismatch_threshold: 0.00001,
            fix_angle: false,
            fixed_angle_value: 60.0,
            max_results: 50,
        }
    }
}

/// Build parameters for assembling the Moiré bilayer.
#[derive(Debug, Clone)]
pub struct MoireBuildParams {
    /// Interlayer distance (Å).
    pub translate_z: f64,
    /// Vacuum thickness above the bilayer (Å).
    pub vacuum: f64,
    /// z-coordinate of layer A (Å).
    pub z_a: f64,
}

impl Default for MoireBuildParams {
    fn default() -> Self {
        Self {
            translate_z: 3.35,
            vacuum: 15.0,
            z_a: 0.0,
        }
    }
}

// === Linear algebra helpers (2D) ===

#[inline]
fn cross2(a: Vec2, b: Vec2) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

#[inline]
fn norm2(v: Vec2) -> f64 {
    (v[0] * v[0] + v[1] * v[1]).sqrt()
}

#[inline]
fn mat_row(m: Mat2, i: usize) -> Vec2 {
    m[i]
}

/// Solve `M x = b` for a 2x2 system. Returns `None` if singular.
fn solve2(m: Mat2, b: Vec2) -> Option<Vec2> {
    let det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    if det.abs() < 1e-300 {
        return None;
    }
    let inv_det = 1.0 / det;
    let x = (m[1][1] * b[0] - m[0][1] * b[1]) * inv_det;
    let y = (-m[1][0] * b[0] + m[0][0] * b[1]) * inv_det;
    Some([x, y])
}

/// Invert a 2x2 matrix. Returns `None` if singular.
fn inv2(m: Mat2) -> Option<Mat2> {
    let det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    if det.abs() < 1e-300 {
        return None;
    }
    let inv_det = 1.0 / det;
    Some([
        [m[1][1] * inv_det, -m[0][1] * inv_det],
        [-m[1][0] * inv_det, m[0][0] * inv_det],
    ])
}

/// Matrix-vector product `M @ v` for a 2x2 matrix and 2-vector.
fn matvec2(m: Mat2, v: Vec2) -> Vec2 {
    [
        m[0][0] * v[0] + m[0][1] * v[1],
        m[1][0] * v[0] + m[1][1] * v[1],
    ]
}

/// Matrix product `A @ B` of two 2x2 matrices.
fn matmul2(a: Mat2, b: Mat2) -> Mat2 {
    [
        [
            a[0][0] * b[0][0] + a[0][1] * b[1][0],
            a[0][0] * b[0][1] + a[0][1] * b[1][1],
        ],
        [
            a[1][0] * b[0][0] + a[1][1] * b[1][0],
            a[1][0] * b[0][1] + a[1][1] * b[1][1],
        ],
    ]
}

/// Apply linear map `F` to a set of row vectors given as a 2x2: `(F @ B.T).T`.
/// `B` rows are vectors; result rows are the mapped vectors.
fn apply_linear_rows(f: Mat2, b: Mat2) -> Mat2 {
    [matvec2(f, b[0]), matvec2(f, b[1])]
}

/// Round to `decimals` places (matching Python `round`, banker's-rounding-free
/// half-away semantics are close enough for our tolerances; Python uses
/// round-half-to-even but our compared values never sit exactly on a half-ulp).
fn round_to(x: f64, decimals: i32) -> f64 {
    let factor = 10f64.powi(decimals);
    (x * factor).round() / factor
}

/// Return a 2x2 rotation matrix for `theta_deg` (degrees).
pub fn rotation_matrix_2d(theta_deg: f64) -> Mat2 {
    let theta = theta_deg.to_radians();
    let (c, s) = (theta.cos(), theta.sin());
    [[c, -s], [s, c]]
}

/// Compute the strain tensor that makes two layers exactly commensurate.
///
/// Mirror of Python `compute_strain`. Returns `(strain_percent, strain_tensor)`.
pub fn compute_strain(
    s1_a: Vec2,
    s2_a: Vec2,
    s1_b: Vec2,
    s2_b: Vec2,
    strain_layer: &str,
) -> (f64, Mat2) {
    // Build matrices: columns are the superlattice vectors (np.column_stack).
    // M_A = [[s1_a.x, s2_a.x], [s1_a.y, s2_a.y]]
    let m_a: Mat2 = [[s1_a[0], s2_a[0]], [s1_a[1], s2_a[1]]];
    let m_b: Mat2 = [[s1_b[0], s2_b[0]], [s1_b[1], s2_b[1]]];

    let zero = [[0.0, 0.0], [0.0, 0.0]];
    let eye: Mat2 = [[1.0, 0.0], [0.0, 1.0]];

    let epsilon: Mat2 = match strain_layer {
        "top" => {
            // Strain B to match A: F = M_A @ M_B^{-1}; epsilon = F - I
            let Some(inv_b) = inv2(m_b) else {
                return (0.0, zero);
            };
            let f = matmul2(m_a, inv_b);
            sub2(f, eye)
        }
        "bottom" => {
            // Strain A to match B: F = M_B @ M_A^{-1}; epsilon = F - I
            let Some(inv_a) = inv2(m_a) else {
                return (0.0, zero);
            };
            let f = matmul2(m_b, inv_a);
            sub2(f, eye)
        }
        _ => {
            // Split strain equally: epsilon = (F - I) / 2 with F = M_A @ M_B^{-1}
            let Some(inv_b) = inv2(m_b) else {
                return (0.0, zero);
            };
            let f = matmul2(m_a, inv_b);
            let e = sub2(f, eye);
            [[e[0][0] / 2.0, e[0][1] / 2.0], [e[1][0] / 2.0, e[1][1] / 2.0]]
        }
    };

    // Frobenius norm * 100
    let frob = (epsilon[0][0] * epsilon[0][0]
        + epsilon[0][1] * epsilon[0][1]
        + epsilon[1][0] * epsilon[1][0]
        + epsilon[1][1] * epsilon[1][1])
        .sqrt();
    (frob * 100.0, epsilon)
}

fn sub2(a: Mat2, b: Mat2) -> Mat2 {
    [
        [a[0][0] - b[0][0], a[0][1] - b[0][1]],
        [a[1][0] - b[1][0], a[1][1] - b[1][1]],
    ]
}

fn add2(a: Mat2, b: Mat2) -> Mat2 {
    [
        [a[0][0] + b[0][0], a[0][1] + b[0][1]],
        [a[1][0] + b[1][0], a[1][1] + b[1][1]],
    ]
}

struct ValidPair {
    m: i32,
    n: i32,
    p: i32,
    q: i32,
    s_a: Vec2,
    s_b: Vec2,
    mismatch: f64,
}

/// Search for coincidence lattice vectors at a single (already-rotated) angle.
///
/// Mirror of Python `_search_coincidence_at_angle`.
#[allow(clippy::too_many_arguments)]
fn search_coincidence_at_angle(
    a: Mat2,
    b_rot: Mat2,
    theta: f64,
    max_index: i32,
    mismatch_threshold: f64,
    area_a: f64,
    n_basis_a: usize,
    n_basis_b: usize,
    max_atoms: i64,
    apply_strain: bool,
    strain_layer: &str,
) -> Vec<CandidateResult> {
    let mut results = Vec::new();

    // B_rot.T for solving (rows of B_rot are vectors; B_rot_T is the matrix
    // whose columns are those vectors, i.e. np.linalg.solve(B_rot.T, S_A)).
    let b_rot_t: Mat2 = [[b_rot[0][0], b_rot[1][0]], [b_rot[0][1], b_rot[1][1]]];

    let mut valid_pairs: Vec<ValidPair> = Vec::new();

    for m in -max_index..=max_index {
        for n in -max_index..=max_index {
            if m == 0 && n == 0 {
                continue;
            }

            let s_a: Vec2 = [
                (m as f64) * a[0][0] + (n as f64) * a[1][0],
                (m as f64) * a[0][1] + (n as f64) * a[1][1],
            ];

            let Some(pq_float) = solve2(b_rot_t, s_a) else {
                continue;
            };

            let p = pq_float[0].round() as i32;
            let q = pq_float[1].round() as i32;

            if p == 0 && q == 0 {
                continue;
            }

            let s_b: Vec2 = [
                (p as f64) * b_rot[0][0] + (q as f64) * b_rot[1][0],
                (p as f64) * b_rot[0][1] + (q as f64) * b_rot[1][1],
            ];

            let mismatch = norm2([s_a[0] - s_b[0], s_a[1] - s_b[1]]);
            if mismatch < mismatch_threshold {
                valid_pairs.push(ValidPair {
                    m,
                    n,
                    p,
                    q,
                    s_a,
                    s_b,
                    mismatch,
                });
            }
        }
    }

    let area_b = cross2(b_rot[0], b_rot[1]).abs();

    for i in 0..valid_pairs.len() {
        for j in 0..valid_pairs.len() {
            if j <= i {
                continue;
            }
            let pi = &valid_pairs[i];
            let pj = &valid_pairs[j];

            let cross = pi.s_a[0] * pj.s_a[1] - pi.s_a[1] * pj.s_a[0];
            if cross.abs() < 1e-8 {
                continue;
            }

            let sc_area = cross.abs();
            let area_ratio = sc_area / area_a;

            let n_atoms_a = (area_ratio * n_basis_a as f64).round() as i64;
            let cross_b = pi.s_b[0] * pj.s_b[1] - pi.s_b[1] * pj.s_b[0];
            let area_ratio_b = if area_b > 1e-10 {
                cross_b.abs() / area_b
            } else {
                area_ratio
            };
            let n_atoms_b = (area_ratio_b * n_basis_b as f64).round() as i64;
            let n_atoms = n_atoms_a + n_atoms_b;

            if n_atoms > max_atoms {
                continue;
            }

            let total_mismatch = pi.mismatch + pj.mismatch;

            let (strain_pct, strain_tensor) = if apply_strain {
                let (pct, tensor) =
                    compute_strain(pi.s_a, pj.s_a, pi.s_b, pj.s_b, strain_layer);
                (Some(round_to(pct, 6)), Some(tensor))
            } else {
                (None, None)
            };

            results.push(CandidateResult {
                angle: round_to(theta, 6),
                m: pi.m,
                n: pi.n,
                p: pi.p,
                q: pi.q,
                m2: pj.m,
                n2: pj.n,
                p2: pj.p,
                q2: pj.q,
                mismatch: round_to(total_mismatch, 8),
                n_atoms,
                area_ratio: round_to(area_ratio, 4),
                strain_percent: strain_pct,
                strain_tensor,
            });

            // Only keep the smallest supercell for this first vector.
            break;
        }
    }

    let _ = theta; // theta already used above
    results
}

/// Generate the angle sweep `np.arange(start, stop + step/2, step)`.
fn arange(start: f64, stop_inclusive: f64, step: f64) -> Vec<f64> {
    // numpy arange(start, stop, step) yields start + k*step while < stop.
    // Python passes stop = angle_max + step/2 so the endpoint is included.
    let stop = stop_inclusive + step / 2.0;
    let mut out = Vec::new();
    if step <= 0.0 {
        return out;
    }
    let n = ((stop - start) / step).ceil() as i64;
    for k in 0..n.max(0) {
        let v = start + (k as f64) * step;
        if v < stop {
            out.push(v);
        }
    }
    out
}

/// Find commensurate twist angles via the coincidence lattice method.
///
/// Mirror of Python `find_commensurate_angles`.
#[allow(clippy::too_many_arguments)]
pub fn find_commensurate_angles(
    a: Mat2,
    b: Mat2,
    n_basis_a: usize,
    n_basis_b: usize,
    angle_min: f64,
    angle_max: f64,
    angle_step: f64,
    max_index: i32,
    mismatch_threshold: f64,
    max_atoms: i64,
    apply_strain: bool,
    strain_layer: &str,
) -> Vec<CandidateResult> {
    let mut candidates = Vec::new();
    let area_a = cross2(a[0], a[1]).abs();
    let angles = arange(angle_min, angle_max, angle_step);

    for theta in angles {
        if theta.abs() < 1e-10 {
            continue;
        }
        let r = rotation_matrix_2d(theta);
        let b_rot = apply_linear_rows(r, b);

        let found = search_coincidence_at_angle(
            a,
            b_rot,
            theta,
            max_index,
            mismatch_threshold,
            area_a,
            n_basis_a,
            n_basis_b,
            max_atoms,
            apply_strain,
            strain_layer,
        );
        candidates.extend(found);
    }

    candidates
}

/// Refine around found candidates with finer angle resolution.
///
/// Mirror of Python `deep_search_refine`.
#[allow(clippy::too_many_arguments)]
pub fn deep_search_refine(
    a: Mat2,
    b: Mat2,
    n_basis_a: usize,
    n_basis_b: usize,
    candidates: &[CandidateResult],
    search_range: f64,
    search_step: f64,
    max_index: i32,
    mismatch_threshold: f64,
    max_atoms: i64,
    apply_strain: bool,
    strain_layer: &str,
) -> Vec<CandidateResult> {
    let mut refined = Vec::new();
    let mut searched_ranges: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let area_a = cross2(a[0], a[1]).abs();

    for cand in candidates {
        let range_key = (cand.angle / search_range).round() as i64;
        if searched_ranges.contains(&range_key) {
            continue;
        }
        searched_ranges.insert(range_key);

        let theta_min = (cand.angle - search_range).max(0.001);
        let theta_max = cand.angle + search_range;
        let angles = arange(theta_min, theta_max, search_step);

        for theta in angles {
            let r = rotation_matrix_2d(theta);
            let b_rot = apply_linear_rows(r, b);
            let found = search_coincidence_at_angle(
                a,
                b_rot,
                theta,
                max_index,
                mismatch_threshold,
                area_a,
                n_basis_a,
                n_basis_b,
                max_atoms,
                apply_strain,
                strain_layer,
            );
            refined.extend(found);
        }
    }

    refined
}

/// Remove duplicate candidates with similar angles and identical atom counts.
///
/// Mirror of Python `deduplicate_candidates`. Keeps the candidate with the
/// smallest mismatch per (angle, n_atoms) group (since input is pre-sorted by
/// (angle, mismatch)).
pub fn deduplicate_candidates(
    candidates: Vec<CandidateResult>,
    angle_tol: f64,
) -> Vec<CandidateResult> {
    if candidates.is_empty() {
        return Vec::new();
    }

    let mut sorted_cands = candidates;
    sorted_cands.sort_by(|x, y| {
        x.angle
            .partial_cmp(&y.angle)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                x.mismatch
                    .partial_cmp(&y.mismatch)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    let mut unique: Vec<CandidateResult> = Vec::new();
    for cand in sorted_cands {
        let mut is_dup = false;
        for existing in &unique {
            if (cand.angle - existing.angle).abs() < angle_tol && cand.n_atoms == existing.n_atoms {
                is_dup = true;
                break;
            }
        }
        if !is_dup {
            unique.push(cand);
        }
    }

    unique
}

/// Full search orchestration mirroring the `/moire/search` router endpoint:
/// initial sweep → optional deep search → strain filter → dedup → sort by
/// n_atoms → limit to `max_results`.
pub fn search_moire(
    layer_a: &LayerData,
    layer_b: &LayerData,
    params: &MoireSearchParams,
) -> Vec<CandidateResult> {
    let a = layer_a.lattice_2d;
    let b = layer_b.lattice_2d;

    let (search_min, search_max, search_step) = if params.fix_angle {
        (params.fixed_angle_value, params.fixed_angle_value, 1.0)
    } else {
        (params.angle_min, params.angle_max, params.angle_step)
    };

    let mut candidates = find_commensurate_angles(
        a,
        b,
        layer_a.n_basis(),
        layer_b.n_basis(),
        search_min,
        search_max,
        search_step,
        params.max_index,
        params.mismatch_threshold,
        params.max_atoms,
        params.apply_strain,
        &params.strain_layer,
    );

    if params.deep_search && !candidates.is_empty() {
        let refined = deep_search_refine(
            a,
            b,
            layer_a.n_basis(),
            layer_b.n_basis(),
            &candidates,
            params.deep_search_range,
            params.deep_search_step,
            params.max_index,
            params.final_mismatch_threshold,
            params.max_atoms,
            params.apply_strain,
            &params.strain_layer,
        );
        candidates.extend(refined);
    }

    if params.apply_strain && params.max_strain_percent > 0.0 {
        candidates.retain(|c| match c.strain_percent {
            Some(sp) => sp <= params.max_strain_percent,
            None => true,
        });
    }

    let mut candidates = deduplicate_candidates(candidates, 0.005);
    // Stable sort by n_atoms (Python list.sort is stable).
    candidates.sort_by_key(|c| c.n_atoms);

    if candidates.len() > params.max_results {
        candidates.truncate(params.max_results);
    }

    candidates
}

/// Check whether a fractional supercell coordinate is inside `[0, 1)`.
fn point_in_supercell(frac_sc: Vec2, tol: f64) -> bool {
    (-tol <= frac_sc[0] && frac_sc[0] < 1.0 - tol)
        && (-tol <= frac_sc[1] && frac_sc[1] < 1.0 - tol)
}

#[allow(clippy::too_many_arguments)]
fn tile_layer(
    a_unit: Mat2,
    layer: &LayerData,
    s1: Vec2,
    s2: Vec2,
    z: f64,
    positions: &mut Vec<[f64; 3]>,
    symbols: &mut Vec<String>,
    layers: &mut Vec<String>,
    layer_label: &str,
) {
    // S_mat rows are S1, S2.
    let s_mat: Mat2 = [s1, s2];

    // A_inv = inv(A_unit.T)
    let a_unit_t: Mat2 = [[a_unit[0][0], a_unit[1][0]], [a_unit[0][1], a_unit[1][1]]];
    let Some(a_inv) = inv2(a_unit_t) else {
        return;
    };

    let s1_frac = matvec2(a_inv, s1);
    let s2_frac = matvec2(a_inv, s2);

    let corners = [
        [0.0, 0.0],
        s1_frac,
        s2_frac,
        [s1_frac[0] + s2_frac[0], s1_frac[1] + s2_frac[1]],
    ];
    let mut min0 = f64::INFINITY;
    let mut max0 = f64::NEG_INFINITY;
    let mut min1 = f64::INFINITY;
    let mut max1 = f64::NEG_INFINITY;
    for c in &corners {
        min0 = min0.min(c[0]);
        max0 = max0.max(c[0]);
        min1 = min1.min(c[1]);
        max1 = max1.max(c[1]);
    }
    let i_min = min0.floor() as i64 - 1;
    let i_max = max0.ceil() as i64 + 1;
    let j_min = min1.floor() as i64 - 1;
    let j_max = max1.ceil() as i64 + 1;

    // S_inv = inv(S_mat.T)
    let s_mat_t: Mat2 = [[s_mat[0][0], s_mat[1][0]], [s_mat[0][1], s_mat[1][1]]];
    let Some(s_inv) = inv2(s_mat_t) else {
        return;
    };

    for i in i_min..=i_max {
        for j in j_min..=j_max {
            for (elem, frac) in layer.elements.iter().zip(layer.basis_frac.iter()) {
                let fi = i as f64 + frac[0];
                let fj = j as f64 + frac[1];
                let cart_2d: Vec2 = [
                    fi * a_unit[0][0] + fj * a_unit[1][0],
                    fi * a_unit[0][1] + fj * a_unit[1][1],
                ];
                let frac_sc = matvec2(s_inv, cart_2d);
                if point_in_supercell(frac_sc, 1e-4) {
                    positions.push([cart_2d[0], cart_2d[1], z]);
                    symbols.push(elem.clone());
                    layers.push(layer_label.to_string());
                }
            }
        }
    }
}

/// Result of building a Moiré bilayer.
pub struct MoireBuildOutput {
    /// The assembled bilayer structure. Sites carry a `"layer"` property
    /// ("A" / "B") and `pbc = [true, true, false]`.
    pub structure: Structure,
    /// Number of atoms in layer A.
    pub n_atoms_layer_a: usize,
    /// Number of atoms in layer B.
    pub n_atoms_layer_b: usize,
    /// Supercell area (Å²).
    pub supercell_area: f64,
    /// Whether strain was applied.
    pub strain_applied: bool,
}

/// Build the Moiré bilayer supercell from a candidate configuration.
///
/// Mirror of Python `build_moire_bilayer` + the `/moire/build` router glue
/// (layer labels, supercell area, strain decision: `apply_strain =
/// candidate.strain_tensor is not None`, `strain_layer = "both"`).
pub fn build_moire(
    layer_a: &LayerData,
    layer_b: &LayerData,
    candidate: &CandidateResult,
    params: &MoireBuildParams,
) -> Result<MoireBuildOutput, String> {
    // Router determines strain settings from the candidate.
    let has_strain = candidate.strain_tensor.is_some();
    let strain_layer = "both";

    let a = layer_a.lattice_2d;
    let b = layer_b.lattice_2d;

    // Superlattice vectors from layer A indices.
    let mut s1: Vec2 = [
        candidate.m as f64 * a[0][0] + candidate.n as f64 * a[1][0],
        candidate.m as f64 * a[0][1] + candidate.n as f64 * a[1][1],
    ];
    let mut s2: Vec2 = [
        candidate.m2 as f64 * a[0][0] + candidate.n2 as f64 * a[1][0],
        candidate.m2 as f64 * a[0][1] + candidate.n2 as f64 * a[1][1],
    ];

    // Rotate B.
    let r = rotation_matrix_2d(candidate.angle);
    let b_rot = apply_linear_rows(r, b);

    let eye: Mat2 = [[1.0, 0.0], [0.0, 1.0]];

    let (a_strained, b_strained) = if has_strain && candidate.strain_tensor.is_some() {
        let epsilon = candidate.strain_tensor.unwrap();
        match strain_layer {
            "top" => {
                let f = add2(eye, epsilon);
                (a, apply_linear_rows(f, b_rot))
            }
            "bottom" => {
                let f = add2(eye, epsilon);
                (apply_linear_rows(f, a), b_rot)
            }
            _ => {
                // Split: +epsilon on A, -epsilon on B (epsilon already halved).
                let f_a = add2(eye, epsilon);
                let f_b = sub2(eye, epsilon);
                (apply_linear_rows(f_a, a), apply_linear_rows(f_b, b_rot))
            }
        }
    } else {
        (a, b_rot)
    };

    // Recompute superlattice vectors using strained A (only when strain applied).
    if has_strain && candidate.strain_tensor.is_some() {
        s1 = [
            candidate.m as f64 * a_strained[0][0] + candidate.n as f64 * a_strained[1][0],
            candidate.m as f64 * a_strained[0][1] + candidate.n as f64 * a_strained[1][1],
        ];
        s2 = [
            candidate.m2 as f64 * a_strained[0][0] + candidate.n2 as f64 * a_strained[1][0],
            candidate.m2 as f64 * a_strained[0][1] + candidate.n2 as f64 * a_strained[1][1],
        ];
    }

    let z_b = params.z_a + params.translate_z;
    let total_z = z_b + params.vacuum;

    // 3D cell.
    let cell = [
        [s1[0], s1[1], 0.0],
        [s2[0], s2[1], 0.0],
        [0.0, 0.0, total_z],
    ];

    // B's own superlattice vectors for consistent boundary tiling.
    let s1_b: Vec2 = [
        candidate.p as f64 * b_strained[0][0] + candidate.q as f64 * b_strained[1][0],
        candidate.p as f64 * b_strained[0][1] + candidate.q as f64 * b_strained[1][1],
    ];
    let s2_b: Vec2 = [
        candidate.p2 as f64 * b_strained[0][0] + candidate.q2 as f64 * b_strained[1][0],
        candidate.p2 as f64 * b_strained[0][1] + candidate.q2 as f64 * b_strained[1][1],
    ];

    let mut positions: Vec<[f64; 3]> = Vec::new();
    let mut symbols: Vec<String> = Vec::new();
    let mut layer_labels: Vec<String> = Vec::new();

    let mut pos_a = Vec::new();
    let mut sym_a = Vec::new();
    let mut lab_a = Vec::new();
    tile_layer(
        a_strained, layer_a, s1, s2, params.z_a, &mut pos_a, &mut sym_a, &mut lab_a, "A",
    );

    let mut pos_b = Vec::new();
    let mut sym_b = Vec::new();
    let mut lab_b = Vec::new();
    tile_layer(
        b_strained, layer_b, s1_b, s2_b, z_b, &mut pos_b, &mut sym_b, &mut lab_b, "B",
    );

    let n_atoms_a = pos_a.len();
    let n_atoms_b = pos_b.len();

    positions.extend(pos_a);
    positions.extend(pos_b);
    symbols.extend(sym_a);
    symbols.extend(sym_b);
    layer_labels.extend(lab_a);
    layer_labels.extend(lab_b);

    // Supercell area.
    let sc_area = (s1[0] * s2[1] - s1[1] * s2[0]).abs();

    // Assemble the core Structure (the ASE Atoms container equivalent).
    // Cell rows are the lattice vectors; positions are Cartesian; convert to
    // fractional via inv(cell.T) @ xyz to match pymatgen site.abc.
    let lattice_matrix = nalgebra::Matrix3::new(
        cell[0][0], cell[0][1], cell[0][2], cell[1][0], cell[1][1], cell[1][2], cell[2][0],
        cell[2][1], cell[2][2],
    );
    let mut lattice = Lattice::new(lattice_matrix);
    lattice.pbc = [true, true, false];

    // cart -> frac: solve cell.T x = cart. cell.T columns are lattice vectors.
    let cell_t = lattice_matrix.transpose();
    let cell_t_inv = cell_t
        .try_inverse()
        .ok_or_else(|| "Singular Moiré supercell lattice".to_string())?;

    let mut site_occupancies = Vec::with_capacity(positions.len());
    let mut frac_coords = Vec::with_capacity(positions.len());

    for (idx, pos) in positions.iter().enumerate() {
        let element = Element::from_symbol(&symbols[idx])
            .ok_or_else(|| format!("Unknown element: {}", symbols[idx]))?;
        let species = Species::neutral(element);

        let mut props: HashMap<String, serde_json::Value> = HashMap::new();
        props.insert(
            "layer".to_string(),
            serde_json::Value::String(layer_labels[idx].clone()),
        );

        site_occupancies.push(SiteOccupancy {
            species: vec![(species, 1.0)],
            properties: props,
        });

        let cart = Vector3::new(pos[0], pos[1], pos[2]);
        let frac = cell_t_inv * cart;
        frac_coords.push(frac);
    }

    let structure = Structure::try_new_from_occupancies_with_properties(
        lattice,
        site_occupancies,
        frac_coords,
        HashMap::new(),
    )
    .map_err(|e| e.to_string())?;

    Ok(MoireBuildOutput {
        structure,
        n_atoms_layer_a: n_atoms_a,
        n_atoms_layer_b: n_atoms_b,
        supercell_area: round_to(sc_area, 4),
        strain_applied: has_strain,
    })
}

// === Layer extraction from a Structure (mirror of extract_layer_data) ===

/// Extract 2D layer data from a full 3D [`Structure`] (mirror of
/// `_extract_from_structure`): take the xy block of the lattice and the (a, b)
/// fractional coordinates of each site.
pub fn extract_layer_from_structure(structure: &Structure) -> LayerData {
    let mat = structure.lattice.matrix();
    let lattice_2d: Mat2 = [[mat[(0, 0)], mat[(0, 1)]], [mat[(1, 0)], mat[(1, 1)]]];

    let mut elements = Vec::new();
    let mut basis_frac = Vec::new();
    for (occ, frac) in structure
        .site_occupancies
        .iter()
        .zip(structure.frac_coords.iter())
    {
        // main species = max occupancy
        let mut best: Option<(&Species, f64)> = None;
        for (sp, o) in occ.species.iter() {
            match best {
                Some((_, bo)) if bo >= *o => {}
                _ => best = Some((sp, *o)),
            }
        }
        if let Some((sp, _)) = best {
            elements.push(sp.element.symbol().to_string());
            basis_frac.push([frac.x, frac.y]);
        }
    }

    LayerData {
        lattice_2d,
        elements,
        basis_frac,
    }
}

/// Build [`LayerData`] from raw 2D lattice vectors + basis (mirror of
/// `_extract_from_raw`): apply optional `celldm` component-wise scaling.
pub fn extract_layer_from_raw(
    lattice_vectors: Mat2,
    elements: Vec<String>,
    basis_coords: Vec<Vec2>,
    celldm: Option<&[f64]>,
) -> LayerData {
    let mut lattice_2d = lattice_vectors;
    if let Some(cdm) = celldm {
        if cdm.len() == 1 {
            for row in lattice_2d.iter_mut() {
                row[0] *= cdm[0];
                row[1] *= cdm[0];
            }
        } else if cdm.len() >= 2 {
            // Component-wise: x by celldm[0], y by celldm[1]. numpy broadcasts
            // (2,2) * (2,) over the last axis (columns).
            for row in lattice_2d.iter_mut() {
                row[0] *= cdm[0];
                row[1] *= cdm[1];
            }
        }
    }

    LayerData {
        lattice_2d,
        elements,
        basis_frac: basis_coords,
    }
}

// keep mat_row referenced to avoid dead-code warning if unused in some builds
#[allow(dead_code)]
fn _touch() {
    let _ = mat_row([[0.0, 0.0], [0.0, 0.0]], 0);
}

//! Nanotube construction algorithm.
//!
//! Faithful Rust port of `server/catgo/utils/nanotube_algorithm.py`.
//!
//! Generalizes the carbon-nanotube builder to work with any 2D material.
//! Given a 2D lattice (a1, a2) and basis atoms, constructs a nanotube
//! by specifying chiral indices (n, m) and tube length (NL unit cells).
//!
//! Algorithm:
//! 1. Compute chiral vector C = n*a1 + m*a2
//! 2. Find translational vector T (minimum lattice vector perpendicular to C)
//! 3. Generate a flat sheet large enough to cover the C x T rectangle
//! 4. Rotate the sheet so C aligns with x-axis
//! 5. Cut atoms inside the rectangle [0, |C|] x [0, NL*|T|]
//! 6. Roll up: x -> theta = x/R, then x_3d = R*sin(theta), z_3d = R*cos(theta)

use crate::element::Element;
use crate::lattice::Lattice;
use crate::species::Species;
use crate::structure::Structure;
use nalgebra::{Matrix3, Vector3};

/// A 2D vector (xy components of a lattice vector).
type Vec2 = [f64; 2];

fn norm2(v: Vec2) -> f64 {
    (v[0] * v[0] + v[1] * v[1]).sqrt()
}

fn dot2(a: Vec2, b: Vec2) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

fn add2(a: Vec2, b: Vec2) -> Vec2 {
    [a[0] + b[0], a[1] + b[1]]
}

fn scale2(s: f64, v: Vec2) -> Vec2 {
    [s * v[0], s * v[1]]
}

/// Definition of the 2D sheet to roll: lattice vectors (2D), basis.
#[derive(Debug, Clone)]
pub struct LayerInput {
    /// First 2D lattice vector (xy).
    pub a1: Vec2,
    /// Second 2D lattice vector (xy).
    pub a2: Vec2,
    /// Element symbol for each basis atom.
    pub elements: Vec<String>,
    /// Fractional [a, b] coordinates of each basis atom.
    pub basis_frac: Vec<Vec2>,
    /// Out-of-plane z offset (Å) of each basis atom.
    pub z_coords: Vec<f64>,
}

/// Computed nanotube geometry information (mirrors Python NanotubeInfo).
#[derive(Debug, Clone)]
pub struct NanotubeInfo {
    /// Chiral angle in degrees.
    pub chiral_angle_deg: f64,
    /// Circumference |C| in Å.
    pub circumference: f64,
    /// Diameter in Å.
    pub diameter: f64,
    /// Radius in Å.
    pub radius: f64,
    /// Translational vector length |T| in Å.
    pub trans_length: f64,
    /// Tube length (NL * |T|) in Å.
    pub tube_length: f64,
    /// Estimated/actual atom count.
    pub n_atoms: usize,
    /// Translational vector index t1.
    pub t1: i32,
    /// Translational vector index t2.
    pub t2: i32,
}

/// Per-wall info for multi-wall nanotubes.
#[derive(Debug, Clone)]
pub struct WallInfo {
    /// Chiral index n.
    pub n: i32,
    /// Chiral index m.
    pub m: i32,
    /// Wall radius in Å.
    pub radius: f64,
    /// Atom count in this wall.
    pub n_atoms: usize,
}

/// Result of building a (multi-wall) nanotube.
#[derive(Debug, Clone)]
pub struct NanotubeBuild {
    /// The rolled-up tube as a periodic Structure (periodic along y axis).
    pub structure: Structure,
    /// Total atom count.
    pub n_atoms: usize,
    /// Inner-wall geometry info.
    pub inner_info: NanotubeInfo,
    /// Common tube length (from inner wall) in Å.
    pub tube_length: f64,
    /// Per-wall info.
    pub walls: Vec<WallInfo>,
}

/// Find the shortest lattice vector perpendicular to the chiral vector.
///
/// Returns (T, t1, t2).
fn find_translational_vector(a1: Vec2, a2: Vec2, n: i32, m: i32, max_search: i32) -> (Vec2, i32, i32) {
    let nf = n as f64;
    let mf = m as f64;
    let c = add2(scale2(nf, a1), scale2(mf, a2));

    // Special case: if C is zero, return a2.
    if norm2(c) < 1e-10 {
        return (a2, 0, 1);
    }

    let c_len = norm2(c);

    // Metric tensor components
    let g11 = dot2(a1, a1);
    let g12 = dot2(a1, a2);
    let g22 = dot2(a2, a2);

    // C · T = 0 in lattice coordinates:
    // (n*g11 + m*g12)*t1 + (n*g12 + m*g22)*t2 = 0
    let p = nf * g11 + mf * g12;
    let q = nf * g12 + mf * g22;

    let perp_tol = 1e-3 * (p.abs() + q.abs());

    let mut best_t: Option<Vec2> = None;
    let mut best_score = f64::INFINITY;
    let mut best_t1 = 0i32;
    let mut best_t2 = 1i32;

    for t1 in -max_search..=max_search {
        for t2 in -max_search..=max_search {
            if t1 == 0 && t2 == 0 {
                continue;
            }
            let dot_val = (p * t1 as f64 + q * t2 as f64).abs();
            if dot_val > perp_tol {
                continue;
            }
            let t = add2(scale2(t1 as f64, a1), scale2(t2 as f64, a2));
            let t_len = norm2(t);

            let perp_error = if t_len > 1e-10 {
                dot_val / (c_len * t_len)
            } else {
                f64::INFINITY
            };
            let score = t_len + perp_error * 1000.0;

            if score < best_score {
                best_score = score;
                best_t = Some(t);
                best_t1 = t1;
                best_t2 = t2;
            }
        }
    }

    let mut best = match best_t {
        Some(t) => t,
        None => {
            // Fallback: component of a1 perpendicular to C.
            let c_hat = scale2(1.0 / c_len, c);
            let mut t_fallback = [a1[0] - dot2(a1, c_hat) * c_hat[0], a1[1] - dot2(a1, c_hat) * c_hat[1]];
            if norm2(t_fallback) < 1e-10 {
                t_fallback = [a2[0] - dot2(a2, c_hat) * c_hat[0], a2[1] - dot2(a2, c_hat) * c_hat[1]];
            }
            return (t_fallback, 1, 0);
        }
    };

    // Ensure T points so cross(C, T) > 0.
    let cross = c[0] * best[1] - c[1] * best[0];
    if cross < 0.0 {
        best = [-best[0], -best[1]];
        best_t1 = -best_t1;
        best_t2 = -best_t2;
    }

    (best, best_t1, best_t2)
}

/// Compute nanotube geometry from lattice vectors and chiral indices.
pub fn compute_nanotube_info(
    a1: Vec2,
    a2: Vec2,
    n: i32,
    m: i32,
    nl: i32,
    n_basis: usize,
) -> NanotubeInfo {
    let nf = n as f64;
    let mf = m as f64;
    let c = add2(scale2(nf, a1), scale2(mf, a2));
    let circumference = norm2(c);
    let diameter = circumference / std::f64::consts::PI;
    let radius = diameter / 2.0;

    let a1_len = norm2(a1);
    let chiral_angle = if a1_len > 0.0 && circumference > 0.0 {
        let cos_alpha = (dot2(c, a1) / (circumference * a1_len)).clamp(-1.0, 1.0);
        cos_alpha.acos().to_degrees()
    } else {
        0.0
    };

    let (t, t1, t2) = find_translational_vector(a1, a2, n, m, 200);
    let trans_length = norm2(t);
    let tube_length = nl as f64 * trans_length;

    let unit_cell_area = (a1[0] * a2[1] - a1[1] * a2[0]).abs();
    let n_unit_cells = if unit_cell_area > 1e-10 {
        (circumference * trans_length / unit_cell_area).round() as i64
    } else {
        0
    };
    let n_atoms = (n_unit_cells * nl as i64 * n_basis as i64).max(0) as usize;

    NanotubeInfo {
        chiral_angle_deg: chiral_angle,
        circumference,
        diameter,
        radius,
        trans_length,
        tube_length,
        n_atoms,
        t1,
        t2,
    }
}

/// Roll a single nanotube wall, returning positions centered at the tube axis.
///
/// Returns (cut_elements, positions_3d (Nx3), tube_length, info).
#[allow(clippy::type_complexity)]
fn roll_single_wall(
    layer: &LayerInput,
    n: i32,
    m: i32,
    nl: i32,
) -> Result<(Vec<String>, Vec<[f64; 3]>, f64, NanotubeInfo), String> {
    let a1 = layer.a1;
    let a2 = layer.a2;
    let nf = n as f64;
    let mf = m as f64;

    let c = add2(scale2(nf, a1), scale2(mf, a2));
    let circumference = norm2(c);
    let radius = circumference / (2.0 * std::f64::consts::PI);

    let (t, t1, t2) = find_translational_vector(a1, a2, n, m, 200);
    let t_len = norm2(t);

    let mut info = compute_nanotube_info(a1, a2, n, m, nl, layer.elements.len());

    if circumference < 1e-10 {
        return Err(format!("Chiral vector has zero length for (n={n}, m={m})"));
    }
    if t_len < 1e-10 {
        return Err("Translational vector has zero length".to_string());
    }

    // Estimate how many unit cells we need.
    let c_hat = scale2(1.0 / circumference, c);
    let t_hat = scale2(1.0 / t_len, t);

    let max_c_proj = dot2(a1, c_hat).abs().max(dot2(a2, c_hat).abs());
    let max_t_proj = dot2(a1, t_hat).abs().max(dot2(a2, t_hat).abs());
    let ni_c = if max_c_proj > 0.0 {
        (circumference / max_c_proj).ceil() as i32 + 2
    } else {
        5
    };
    let ni_t = if max_t_proj > 0.0 {
        (nl as f64 * t_len / max_t_proj).ceil() as i32 + 2
    } else {
        5
    };
    let ni_max = ni_c
        .max(ni_t)
        .max(n.abs() + m.abs() + 2)
        .max(nl * (t1.abs() + t2.abs()) + 2);

    // Generate sheet atoms.
    let mut sheet_elements: Vec<String> = Vec::new();
    let mut sheet_xy: Vec<Vec2> = Vec::new();
    let mut sheet_z: Vec<f64> = Vec::new();

    for i in -ni_max..=ni_max {
        for j in -ni_max..=ni_max {
            let origin = add2(scale2(i as f64, a1), scale2(j as f64, a2));
            for k in 0..layer.elements.len() {
                let frac = layer.basis_frac[k];
                let pos_2d = add2(origin, add2(scale2(frac[0], a1), scale2(frac[1], a2)));
                sheet_elements.push(layer.elements[k].clone());
                sheet_xy.push(pos_2d);
                sheet_z.push(layer.z_coords[k]);
            }
        }
    }

    // Rotate so C aligns with x-axis. R = [[cos(-a), -sin(-a)], [sin(-a), cos(-a)]]
    let alpha = c[1].atan2(c[0]);
    let cos_a = (-alpha).cos();
    let sin_a = (-alpha).sin();
    // rotated = R @ xy
    let rotate = |v: Vec2| -> Vec2 { [cos_a * v[0] - sin_a * v[1], sin_a * v[0] + cos_a * v[1]] };

    let t_rot = rotate(t);
    let t_rot_len = norm2(t_rot);
    let t_rot_hat = scale2(1.0 / t_rot_len, t_rot);

    let eps = 1e-4;
    let tube_length = nl as f64 * t_len;

    let mut cut_elements: Vec<String> = Vec::new();
    let mut cut_x: Vec<f64> = Vec::new();
    let mut cut_y: Vec<f64> = Vec::new();
    let mut cut_z: Vec<f64> = Vec::new();

    for idx in 0..sheet_xy.len() {
        let r = rotate(sheet_xy[idx]);
        let x_proj = r[0];
        let y_proj = dot2(r, t_rot_hat);
        if x_proj >= -eps
            && x_proj < circumference - eps
            && y_proj >= -eps
            && y_proj < tube_length - eps
        {
            cut_elements.push(sheet_elements[idx].clone());
            cut_x.push(x_proj);
            cut_y.push(y_proj);
            cut_z.push(sheet_z[idx]);
        }
    }

    let n_atoms = cut_elements.len();
    if n_atoms == 0 {
        return Err(format!(
            "No atoms found in the cut region for (n={n}, m={m}), NL={nl}. C={circumference:.2} Å, T={t_len:.2} Å"
        ));
    }

    // Roll up: positions centered at tube axis (origin).
    let mut positions_3d: Vec<[f64; 3]> = Vec::with_capacity(n_atoms);
    for i in 0..n_atoms {
        let theta = cut_x[i] / radius;
        let r_eff = radius + cut_z[i];
        positions_3d.push([r_eff * theta.sin(), cut_y[i], r_eff * theta.cos()]);
    }

    info.n_atoms = n_atoms;
    Ok((cut_elements, positions_3d, tube_length, info))
}

/// Find (n, m) chiral indices giving a tube radius closest to target_radius.
///
/// Mirrors Python `find_chiral_indices_for_radius`. Returns (n, m, actual_radius).
fn find_chiral_indices_for_radius(
    a1: Vec2,
    a2: Vec2,
    target_radius: f64,
    target_tube_length: Option<f64>,
    max_index: i32,
) -> (i32, i32, f64) {
    let two_pi = 2.0 * std::f64::consts::PI;
    let target_circ = two_pi * target_radius;
    let g11 = dot2(a1, a1);
    let g12 = dot2(a1, a2);
    let g22 = dot2(a2, a2);

    // (diff, n, m, c_len)
    let mut candidates: Vec<(f64, i32, i32, f64)> = Vec::new();
    for ni in 0..=max_index {
        for mi in 0..=ni {
            if ni == 0 && mi == 0 {
                continue;
            }
            let c_sq = (ni * ni) as f64 * g11
                + 2.0 * (ni * mi) as f64 * g12
                + (mi * mi) as f64 * g22;
            let c_len = c_sq.sqrt();
            let diff = (c_len - target_circ).abs();
            candidates.push((diff, ni, mi, c_len));
        }
    }

    // Stable sort by diff (then by n, m, c to match Python tuple ordering).
    candidates.sort_by(|x, y| {
        x.0.partial_cmp(&y.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(x.1.cmp(&y.1))
            .then(x.2.cmp(&y.2))
            .then(x.3.partial_cmp(&y.3).unwrap_or(std::cmp::Ordering::Equal))
    });

    if candidates.is_empty() {
        return (1, 0, g11.sqrt() / two_pi);
    }

    let target_tube_length = match target_tube_length {
        None => {
            let (_, bn, bm, bc) = candidates[0];
            return (bn, bm, bc / two_pi);
        }
        Some(l) => l,
    };

    let mut best_score = f64::INFINITY;
    let mut best_n = candidates[0].1;
    let mut best_m = candidates[0].2;
    let threshold = (candidates[0].0 * 5.0).max(target_circ * 0.05);

    for &(radius_diff, ni, mi, _c_len) in candidates.iter().take(80) {
        if radius_diff > threshold {
            break;
        }
        let (t, _, _) = find_translational_vector(a1, a2, ni, mi, 50);
        let t_len = norm2(t);
        if t_len < 1e-10 {
            continue;
        }
        let nl_needed = (target_tube_length / t_len).round().max(1.0);
        let actual_length = nl_needed * t_len;
        let length_mismatch = (actual_length - target_tube_length).abs() / target_tube_length;
        let rel_radius_diff = radius_diff / target_circ;
        let nl_penalty = (nl_needed - 5.0).max(0.0) * 0.05;
        let score = rel_radius_diff + length_mismatch * 0.5 + nl_penalty;
        if score < best_score {
            best_score = score;
            best_n = ni;
            best_m = mi;
        }
    }

    let actual_radius = ((best_n * best_n) as f64 * g11
        + 2.0 * (best_n * best_m) as f64 * g12
        + (best_m * best_m) as f64 * g22)
        .sqrt()
        / two_pi;
    (best_n, best_m, actual_radius)
}

/// Assemble combined positions + cell into a periodic Structure (periodic along y).
fn assemble_structure(
    elements: &[String],
    mut positions: Vec<[f64; 3]>,
    tube_length: f64,
    vacuum: f64,
) -> Result<Structure, String> {
    let n_atoms = positions.len();
    if n_atoms == 0 {
        return Err("No atoms to assemble".to_string());
    }

    let mut x_min = f64::INFINITY;
    let mut x_max = f64::NEG_INFINITY;
    let mut z_min = f64::INFINITY;
    let mut z_max = f64::NEG_INFINITY;
    for p in &positions {
        x_min = x_min.min(p[0]);
        x_max = x_max.max(p[0]);
        z_min = z_min.min(p[2]);
        z_max = z_max.max(p[2]);
    }

    for p in &mut positions {
        p[0] -= x_min - vacuum;
        p[2] -= z_min - vacuum;
    }

    let box_x = (x_max - x_min) + 2.0 * vacuum;
    let box_y = tube_length;
    let box_z = (z_max - z_min) + 2.0 * vacuum;

    // Lattice matrix with vectors as rows (matches pymatgen / JsCrystal convention).
    let matrix = Matrix3::new(
        box_x, 0.0, 0.0, //
        0.0, box_y, 0.0, //
        0.0, 0.0, box_z,
    );
    let mut lattice = Lattice::new(matrix);
    lattice.pbc = [false, true, false];

    // Fractional coords: frac = cart * cell_inv  (row-vector convention).
    // For an orthogonal cell this is just component / box length.
    let mut species: Vec<Species> = Vec::with_capacity(n_atoms);
    let mut frac_coords: Vec<Vector3<f64>> = Vec::with_capacity(n_atoms);
    for (i, p) in positions.iter().enumerate() {
        let el = Element::from_symbol(&elements[i])
            .ok_or_else(|| format!("Unknown element: {}", elements[i]))?;
        species.push(Species::neutral(el));
        frac_coords.push(Vector3::new(p[0] / box_x, p[1] / box_y, p[2] / box_z));
    }

    Structure::try_new(lattice, species, frac_coords).map_err(|e| e.to_string())
}

/// Build a single-wall nanotube from a 2D material.
pub fn build_single_wall(
    layer: &LayerInput,
    n: i32,
    m: i32,
    nl: i32,
    vacuum: f64,
) -> Result<NanotubeBuild, String> {
    let (elements, positions, tube_length, info) = roll_single_wall(layer, n, m, nl)?;
    let n_atoms = elements.len();
    let radius = info.radius;
    let structure = assemble_structure(&elements, positions, tube_length, vacuum)?;
    let walls = vec![WallInfo {
        n,
        m,
        radius,
        n_atoms,
    }];
    Ok(NanotubeBuild {
        structure,
        n_atoms,
        inner_info: info,
        tube_length,
        walls,
    })
}

/// Build a multi-wall nanotube.
pub fn build_mwnt(
    layer: &LayerInput,
    n: i32,
    m: i32,
    n_walls: i32,
    interlayer_spacing: f64,
    nl: i32,
    vacuum: f64,
) -> Result<NanotubeBuild, String> {
    // Inner wall.
    let (inner_elems, inner_pos, inner_tube_length, inner_info) = roll_single_wall(layer, n, m, nl)?;

    let mut all_elems: Vec<String> = inner_elems.clone();
    let mut all_pos: Vec<[f64; 3]> = inner_pos;
    let mut wall_infos: Vec<WallInfo> = vec![WallInfo {
        n,
        m,
        radius: inner_info.radius,
        n_atoms: inner_info.n_atoms,
    }];

    for w in 1..n_walls {
        let target_r = inner_info.radius + w as f64 * interlayer_spacing;
        let (wn, wm, _actual_r) =
            find_chiral_indices_for_radius(layer.a1, layer.a2, target_r, Some(inner_tube_length), 200);

        let (t_w, _, _) = find_translational_vector(layer.a1, layer.a2, wn, wm, 200);
        let t_w_len = norm2(t_w);
        if t_w_len < 1e-10 {
            continue;
        }
        let nl_w = (inner_tube_length / t_w_len).round().max(1.0) as i32;

        let (w_elems, w_pos, _w_tube_length, w_info) = roll_single_wall(layer, wn, wm, nl_w)?;

        all_elems.extend(w_elems);
        all_pos.extend(w_pos);
        wall_infos.push(WallInfo {
            n: wn,
            m: wm,
            radius: w_info.radius,
            n_atoms: w_info.n_atoms,
        });
    }

    let total_atoms = all_elems.len();
    let structure = assemble_structure(&all_elems, all_pos, inner_tube_length, vacuum)?;

    Ok(NanotubeBuild {
        structure,
        n_atoms: total_atoms,
        inner_info,
        tube_length: inner_tube_length,
        walls: wall_infos,
    })
}

/// Classify chirality from indices.
pub fn classify_chirality(n: i32, m: i32) -> &'static str {
    if m == 0 {
        "zigzag"
    } else if n == m {
        "armchair"
    } else {
        "chiral"
    }
}

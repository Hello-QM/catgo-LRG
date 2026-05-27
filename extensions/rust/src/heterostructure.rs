//! Heterostructure (coherent interface) builder — SLAB mode.
//!
//! Faithful Rust port of the SLAB-mode portion of
//! `server/catgo/utils/heterostructure_algorithm.py`:
//!   - `search_matches_slab`   -> [`search_matches_slab`]
//!   - `build_interface_slab`  -> [`build_interface_slab`]
//!   - `build_interface_manual`-> [`build_interface_manual`]
//!
//! The bulk mode (`search_matches` / `build_interface`, which need
//! pymatgen's `CoherentInterfaceBuilder` to cut slabs from bulk crystals
//! via Miller indices) and the intermat / lateral / grid-scan modes are
//! intentionally NOT ported here (see module-level docs in the spec).
//!
//! All matrix conventions match the crate's `Lattice` (rows = lattice
//! vectors) and pymatgen (`structure * T` -> `T @ matrix`).

use nalgebra::{Matrix2, Matrix3, Vector2, Vector3};

use crate::lattice::Lattice;
use crate::species::Species;
use crate::structure::Structure;
use crate::zsl::{vec_area, ZslGenerator, ZslMatch};

/// A ZSL match candidate, mirroring the Python `MatchCandidate` dataclass /
/// the `HeterostructureMatch` API model fields used by SLAB mode.
#[derive(Debug, Clone)]
pub struct MatchCandidate {
    /// Stable id (== index into the sorted match list).
    pub match_id: usize,
    /// Matched super-lattice area (Å²), from the film super-lattice vectors.
    pub match_area: f64,
    /// Integer 2x2 transform applied to the film unit cell.
    pub film_transformation: [[i64; 2]; 2],
    /// Integer 2x2 transform applied to the substrate unit cell.
    pub substrate_transformation: [[i64; 2]; 2],
    /// Film super-lattice vectors (3D, reduced).
    pub film_sl_vectors: [Vector3<f64>; 2],
    /// Substrate super-lattice vectors (3D, reduced).
    pub substrate_sl_vectors: [Vector3<f64>; 2],
    /// Von Mises strain (%) between film and substrate super-lattices.
    pub strain: f64,
    /// Substrate atom count after applying the supercell transform.
    pub n_atoms_substrate: usize,
    /// Film atom count after applying the supercell transform.
    pub n_atoms_film: usize,
}

/// Result of [`build_interface_slab`] / [`build_interface_manual`].
#[derive(Debug, Clone)]
pub struct BuildResult {
    /// The built interface structure.
    pub structure: Structure,
    /// Total atom count.
    pub n_atoms: usize,
    /// Substrate atom count.
    pub n_atoms_substrate: usize,
    /// Film atom count.
    pub n_atoms_film: usize,
    /// Interface in-plane area (Å²).
    pub match_area: f64,
    /// Von Mises strain (%).
    pub strain: f64,
}

/// Compute the Von Mises strain (%) between film and substrate super-lattice
/// vectors. Faithful port of Python `_compute_strain_percent`.
///
/// Solves `f_2d @ T = s_2d` (T = f_2d^-1 @ s_2d) using the (x, y) components,
/// where the rows of f_2d / s_2d are the two super-lattice vectors. Then
/// epsilon = (T + T^T)/2 - I, and von_mises = sqrt(e11^2 + e22^2 - e11 e22 + 3 e12^2).
pub fn compute_strain_percent(film_sl: &[Vector3<f64>; 2], sub_sl: &[Vector3<f64>; 2]) -> f64 {
    // numpy: f_2d rows are the vectors; np.linalg.solve(f_2d, s_2d) solves
    // f_2d @ T = s_2d.  With f_2d, s_2d as 2x2 (rows = vectors).
    let f = Matrix2::new(film_sl[0].x, film_sl[0].y, film_sl[1].x, film_sl[1].y);
    let s = Matrix2::new(sub_sl[0].x, sub_sl[0].y, sub_sl[1].x, sub_sl[1].y);

    let f_inv = match f.try_inverse() {
        Some(inv) => inv,
        None => return 0.0,
    };
    let t = f_inv * s;

    // epsilon = (T + T^T)/2 - I
    let e11 = (t[(0, 0)] + t[(0, 0)]) / 2.0 - 1.0;
    let e22 = (t[(1, 1)] + t[(1, 1)]) / 2.0 - 1.0;
    let e12 = (t[(0, 1)] + t[(1, 0)]) / 2.0;

    let von_mises = (e11 * e11 + e22 * e22 - e11 * e22 + 3.0 * e12 * e12).sqrt();
    von_mises * 100.0
}

/// Remove vacuum from a slab by compressing the c-axis. Faithful port of
/// Python `_strip_vacuum` (tol = 0.5 Å padding on each side).
///
/// Projects atoms onto the c-axis direction, finds the extent, and rebuilds
/// the cell with c shrunk to `thickness + 2*tol`, shifting atoms so the
/// bottom sits `tol` above the origin along c.
pub fn strip_vacuum(structure: &Structure, tol: f64) -> Structure {
    let mat = structure.lattice.matrix();
    let c_vec = Vector3::new(mat[(2, 0)], mat[(2, 1)], mat[(2, 2)]);
    let c_len = c_vec.norm();
    let c_unit = c_vec / c_len;

    let cart = structure.cart_coords();
    let projections: Vec<f64> = cart.iter().map(|p| p.dot(&c_unit)).collect();
    let z_min = projections.iter().cloned().fold(f64::INFINITY, f64::min);
    let z_max = projections.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mut thickness = z_max - z_min;
    if thickness < 0.1 {
        thickness = 0.1;
    }
    let new_c_len = thickness + 2.0 * tol;
    let shift = -z_min + tol;

    let a_vec = Vector3::new(mat[(0, 0)], mat[(0, 1)], mat[(0, 2)]);
    let b_vec = Vector3::new(mat[(1, 0)], mat[(1, 1)], mat[(1, 2)]);
    let new_c = c_unit * new_c_len;

    let new_matrix = Matrix3::new(
        a_vec.x, a_vec.y, a_vec.z, b_vec.x, b_vec.y, b_vec.z, new_c.x, new_c.y, new_c.z,
    );
    let new_lattice = Lattice::new(new_matrix);

    let new_cart: Vec<Vector3<f64>> = cart.iter().map(|p| p + c_unit * shift).collect();
    let new_frac = new_lattice.get_fractional_coords(&new_cart);

    let species: Vec<Species> = structure.species().into_iter().copied().collect();
    Structure::new(new_lattice, species, new_frac)
}

/// Apply a 2x2 in-plane transformation to create a supercell, preserving the
/// c-axis. Faithful port of Python `_make_supercell_2d` (`structure * T` with
/// T = [[m00, m01, 0],[m10, m11, 0],[0,0,1]]).
pub fn make_supercell_2d(
    structure: &Structure,
    transformation: &[[i64; 2]; 2],
) -> crate::error::Result<Structure> {
    let t = [
        [transformation[0][0] as i32, transformation[0][1] as i32, 0],
        [transformation[1][0] as i32, transformation[1][1] as i32, 0],
        [0, 0, 1],
    ];
    structure.make_supercell(t)
}

/// Compute the 2D Cartesian deformation gradient mapping film_sl -> sub_sl.
/// Faithful port of Python `_compute_deformation_2d`:
///   D = s_2d^T @ inv(f_2d^T)   (so D @ film_sl_vec_i ≈ sub_sl_vec_i)
fn compute_deformation_2d(film_sl: &[Vector3<f64>; 2], sub_sl: &[Vector3<f64>; 2]) -> Matrix2<f64> {
    // f, s rows = vectors. f^T has the vectors as columns.
    let f_t = Matrix2::new(film_sl[0].x, film_sl[1].x, film_sl[0].y, film_sl[1].y);
    let s_t = Matrix2::new(sub_sl[0].x, sub_sl[1].x, sub_sl[0].y, sub_sl[1].y);
    let f_t_inv = f_t.try_inverse().unwrap_or_else(Matrix2::identity);
    s_t * f_t_inv
}

/// Reorder substrate/film super-lattice vector pairs so that `sub_sl[0]`
/// aligns with the original substrate a-vector. Faithful port of
/// Python `_align_sl_vectors`.
fn align_sl_vectors(
    sub_sl: [Vector3<f64>; 2],
    film_sl: [Vector3<f64>; 2],
    original_sub_a: &Vector3<f64>,
) -> ([Vector3<f64>; 2], [Vector3<f64>; 2]) {
    let s0 = Vector2::new(sub_sl[0].x, sub_sl[0].y);
    let s1 = Vector2::new(sub_sl[1].x, sub_sl[1].y);
    let reff = Vector2::new(original_sub_a.x, original_sub_a.y);
    let ref_norm = reff.norm();
    if ref_norm < 1e-10 {
        return (sub_sl, film_sl);
    }
    let cos0 = (s0.dot(&reff)).abs() / (s0.norm() * ref_norm + 1e-10);
    let cos1 = (s1.dot(&reff)).abs() / (s1.norm() * ref_norm + 1e-10);
    if cos1 > cos0 {
        ([sub_sl[1], sub_sl[0]], [film_sl[1], film_sl[0]])
    } else {
        (sub_sl, film_sl)
    }
}

/// Stack `film` on top of `substrate` with the given gap and vacuum.
/// Faithful port of Python `_stack_slabs` (Cartesian deformation-gradient
/// path, `target_z=0`).
///
/// Both slabs must already be supercells. The film's in-plane lattice is
/// strained to match the substrate via the deformation gradient D computed
/// from the matched super-lattice vectors. `twist_angle` (degrees) rotates
/// the strained film in-plane around its centroid before stacking.
/// `xy_shift` is a fractional `(fa, fb)` in-plane shift of the film along the
/// interface a,b vectors (substrate sl_vectors when available, else raw
/// substrate vectors), applied after strain+twist, before vertical stacking.
/// The result is wrapped to [0,1).
#[allow(clippy::too_many_arguments)]
fn stack_slabs(
    substrate: &Structure,
    film: &Structure,
    gap: f64,
    vacuum: f64,
    twist_angle: f64,
    film_sl: Option<&[Vector3<f64>; 2]>,
    sub_sl: Option<&[Vector3<f64>; 2]>,
    xy_shift: (f64, f64),
) -> Structure {
    let sub_mat = substrate.lattice.matrix();
    let sub_cart = substrate.cart_coords();

    // Film cartesian after in-plane deformation.
    let mut film_cart = film.cart_coords();
    if let (Some(fsl), Some(ssl)) = (film_sl, sub_sl) {
        let d = compute_deformation_2d(fsl, ssl);
        for p in film_cart.iter_mut() {
            let xy = Vector2::new(p.x, p.y);
            let nxy = d * xy;
            p.x = nxy.x;
            p.y = nxy.y;
        }
    } else {
        // Legacy fractional mapping: build a lattice with substrate a,b and
        // film c, then re-express film fractional coords in it.
        let fm = film.lattice.matrix();
        let strained = Matrix3::new(
            sub_mat[(0, 0)],
            sub_mat[(0, 1)],
            sub_mat[(0, 2)],
            sub_mat[(1, 0)],
            sub_mat[(1, 1)],
            sub_mat[(1, 2)],
            fm[(2, 0)],
            fm[(2, 1)],
            fm[(2, 2)],
        );
        let strained_lat = Lattice::new(strained);
        film_cart = strained_lat.get_cartesian_coords(&film.frac_coords);
    }

    // Apply twist (rotation around c-axis) about the film centroid, in-plane.
    apply_twist(&mut film_cart, twist_angle);

    // Apply in-plane fractional shift along interface a,b vectors. Matches
    // Python `_stack_slabs`: shift_xy = fa*a_vec + fb*b_vec (full 3D vectors).
    let (fa, fb) = xy_shift;
    if fa.abs() > 1e-10 || fb.abs() > 1e-10 {
        let (a_vec, b_vec) = if let Some(ssl) = sub_sl {
            (ssl[0], ssl[1])
        } else {
            (
                Vector3::new(sub_mat[(0, 0)], sub_mat[(0, 1)], sub_mat[(0, 2)]),
                Vector3::new(sub_mat[(1, 0)], sub_mat[(1, 1)], sub_mat[(1, 2)]),
            )
        };
        let shift_xy = a_vec * fa + b_vec * fb;
        for p in film_cart.iter_mut() {
            *p += shift_xy;
        }
    }

    // Substrate c direction.
    let sub_c = Vector3::new(sub_mat[(2, 0)], sub_mat[(2, 1)], sub_mat[(2, 2)]);
    let sub_c_unit = sub_c / sub_c.norm();

    let sub_top = sub_cart
        .iter()
        .map(|p| p.dot(&sub_c_unit))
        .fold(f64::NEG_INFINITY, f64::max);

    let film_mat = film.lattice.matrix();
    let film_c = Vector3::new(film_mat[(2, 0)], film_mat[(2, 1)], film_mat[(2, 2)]);
    let film_c_unit = film_c / film_c.norm();
    let film_bottom = film_cart
        .iter()
        .map(|p| p.dot(&film_c_unit))
        .fold(f64::INFINITY, f64::min);

    // Shift film: bottom -> sub_top + gap along substrate c.
    let shift = sub_c_unit * (sub_top + gap - film_bottom);
    let film_cart_shifted: Vec<Vector3<f64>> = film_cart.iter().map(|p| p + shift).collect();

    let total_top = film_cart_shifted
        .iter()
        .map(|p| p.dot(&sub_c_unit))
        .fold(f64::NEG_INFINITY, f64::max);
    let new_c_len = total_top + vacuum;

    // Interface lattice: use sl_vectors for a,b when available.
    let (a_vec, b_vec) = if let Some(ssl) = sub_sl {
        (ssl[0], ssl[1])
    } else {
        (
            Vector3::new(sub_mat[(0, 0)], sub_mat[(0, 1)], sub_mat[(0, 2)]),
            Vector3::new(sub_mat[(1, 0)], sub_mat[(1, 1)], sub_mat[(1, 2)]),
        )
    };
    let new_c = sub_c_unit * new_c_len;
    let new_matrix = Matrix3::new(
        a_vec.x, a_vec.y, a_vec.z, b_vec.x, b_vec.y, b_vec.z, new_c.x, new_c.y, new_c.z,
    );
    let new_lattice = Lattice::new(new_matrix);

    // Merge atoms (substrate first, then film), convert to frac, wrap to [0,1).
    let mut all_cart = sub_cart;
    all_cart.extend(film_cart_shifted);

    let mut species: Vec<Species> = substrate.species().into_iter().copied().collect();
    species.extend(film.species().into_iter().copied());

    let frac = new_lattice.get_fractional_coords(&all_cart);
    let wrapped: Vec<Vector3<f64>> = frac
        .iter()
        .map(|f| Vector3::new(wrap01(f.x), wrap01(f.y), wrap01(f.z)))
        .collect();

    Structure::new(new_lattice, species, wrapped)
}

/// Rotate the in-plane (x, y) components of `cart` by `twist_angle` degrees
/// around the centroid of the points. Faithful port of the twist block in
/// Python `_stack_slabs` (z preserved, rotation about film-atom centroid).
fn apply_twist(cart: &mut [Vector3<f64>], twist_angle: f64) {
    if twist_angle.abs() <= 1e-10 || cart.is_empty() {
        return;
    }
    let theta = twist_angle.to_radians();
    let (cos_t, sin_t) = (theta.cos(), theta.sin());
    let n = cart.len() as f64;
    let cx = cart.iter().map(|p| p.x).sum::<f64>() / n;
    let cy = cart.iter().map(|p| p.y).sum::<f64>() / n;
    for p in cart.iter_mut() {
        let rx = p.x - cx;
        let ry = p.y - cy;
        p.x = rx * cos_t - ry * sin_t + cx;
        p.y = rx * sin_t + ry * cos_t + cy;
    }
}

/// Wrap a fractional coordinate into [0, 1) like numpy `% 1.0`.
#[inline]
fn wrap01(x: f64) -> f64 {
    let r = x - x.floor();
    if (r - 1.0).abs() < 1e-12 {
        0.0
    } else {
        r
    }
}

/// Extract the two in-plane (a, b) lattice vectors from a stripped slab.
fn inplane_vectors(structure: &Structure) -> [Vector3<f64>; 2] {
    let m = structure.lattice.matrix();
    [
        Vector3::new(m[(0, 0)], m[(0, 1)], m[(0, 2)]),
        Vector3::new(m[(1, 0)], m[(1, 1)], m[(1, 2)]),
    ]
}

/// Convert a [`ZslMatch`] into a [`MatchCandidate`] with strain and atom
/// counts, applying the a/b-alignment fix.  `n_sub_base` / `n_film_base` are
/// the stripped-slab atom counts.
fn match_candidate(
    idx: usize,
    zm: &ZslMatch,
    n_sub_base: usize,
    n_film_base: usize,
    original_sub_a: &Vector3<f64>,
) -> MatchCandidate {
    let (sub_sl, film_sl) =
        align_sl_vectors(zm.substrate_sl_vectors, zm.film_sl_vectors, original_sub_a);
    let strain = compute_strain_percent(&film_sl, &sub_sl);

    let sub_det = det2(&zm.substrate_transformation).abs();
    let film_det = det2(&zm.film_transformation).abs();

    MatchCandidate {
        match_id: idx,
        match_area: zm.match_area(),
        film_transformation: zm.film_transformation,
        substrate_transformation: zm.substrate_transformation,
        film_sl_vectors: film_sl,
        substrate_sl_vectors: sub_sl,
        strain: round4(strain),
        n_atoms_substrate: n_sub_base * sub_det.max(1) as usize,
        n_atoms_film: n_film_base * film_det.max(1) as usize,
    }
}

#[inline]
fn det2(m: &[[i64; 2]; 2]) -> i64 {
    m[0][0] * m[1][1] - m[0][1] * m[1][0]
}

#[inline]
fn round4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

#[inline]
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// SLAB-mode search: match two pre-existing slabs by their in-plane lattice
/// vectors. Faithful port of Python `search_matches_slab`.
///
/// Strips vacuum from both slabs, runs the ZSL generator on the a,b vectors,
/// builds candidates (capped at `max_results` in generation order), then
/// sorts by (match_area, strain).
#[allow(clippy::too_many_arguments)]
pub fn search_matches_slab(
    substrate_slab: &Structure,
    film_slab: &Structure,
    max_area: f64,
    max_area_ratio_tol: f64,
    max_length_tol: f64,
    max_angle_tol: f64,
    max_results: usize,
) -> Vec<MatchCandidate> {
    let sub = strip_vacuum(substrate_slab, 0.5);
    let film = strip_vacuum(film_slab, 0.5);

    let sub_vecs = inplane_vectors(&sub);
    let film_vecs = inplane_vectors(&film);
    let original_sub_a = sub_vecs[0];

    let zgen = ZslGenerator {
        max_area,
        max_area_ratio_tol,
        max_length_tol,
        max_angle_tol,
        bidirectional: false,
    };

    let n_sub_base = sub.num_sites();
    let n_film_base = film.num_sites();

    let zsl_matches = zgen.generate(&film_vecs, &sub_vecs);

    let mut matches: Vec<MatchCandidate> = zsl_matches
        .iter()
        .take(max_results)
        .enumerate()
        .map(|(idx, zm)| match_candidate(idx, zm, n_sub_base, n_film_base, &original_sub_a))
        .collect();

    // Sort by (match_area, strain). Stable sort to mirror Python's behavior.
    matches.sort_by(|a, b| {
        a.match_area
            .partial_cmp(&b.match_area)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.strain
                    .partial_cmp(&b.strain)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    matches
}

/// SLAB-mode build: build the heterostructure for the selected ZSL match.
/// Faithful port of Python `build_interface_slab`.
///
/// IMPORTANT: like the Python code, `match_index` indexes into the *raw,
/// unsorted* ZSL match list (generation order), NOT the area-sorted search
/// result. The search result's `match_id` is the generation-order index, so
/// pass that here.
#[allow(clippy::too_many_arguments)]
pub fn build_interface_slab(
    substrate_slab: &Structure,
    film_slab: &Structure,
    match_index: usize,
    gap: f64,
    vacuum: f64,
    twist_angle: f64,
    max_area: f64,
    max_area_ratio_tol: f64,
    max_length_tol: f64,
    max_angle_tol: f64,
) -> Result<BuildResult, String> {
    let sub = strip_vacuum(substrate_slab, 0.5);
    let film = strip_vacuum(film_slab, 0.5);

    let sub_vecs = inplane_vectors(&sub);
    let film_vecs = inplane_vectors(&film);

    let zgen = ZslGenerator {
        max_area,
        max_area_ratio_tol,
        max_length_tol,
        max_angle_tol,
        bidirectional: false,
    };

    let zsl_matches = zgen.generate(&film_vecs, &sub_vecs);
    if match_index >= zsl_matches.len() {
        return Err(format!(
            "Match index {match_index} out of range (have {} matches).",
            zsl_matches.len()
        ));
    }
    let selected = &zsl_matches[match_index];

    let sub_super =
        make_supercell_2d(&sub, &selected.substrate_transformation).map_err(|e| e.to_string())?;
    let film_super =
        make_supercell_2d(&film, &selected.film_transformation).map_err(|e| e.to_string())?;

    let film_sl = selected.film_sl_vectors;
    let sub_sl = selected.substrate_sl_vectors;

    let n_sub = sub_super.num_sites();
    let n_film = film_super.num_sites();

    let interface = stack_slabs(
        &sub_super,
        &film_super,
        gap,
        vacuum,
        twist_angle,
        Some(&film_sl),
        Some(&sub_sl),
        (0.0, 0.0),
    );

    let m = interface.lattice.matrix();
    let a = Vector3::new(m[(0, 0)], m[(0, 1)], m[(0, 2)]);
    let b = Vector3::new(m[(1, 0)], m[(1, 1)], m[(1, 2)]);
    let match_area = vec_area(&a, &b);

    let strain = compute_strain_percent(&selected.film_sl_vectors, &selected.substrate_sl_vectors);

    Ok(BuildResult {
        structure: interface,
        n_atoms: n_sub + n_film,
        n_atoms_substrate: n_sub,
        n_atoms_film: n_film,
        match_area: round2(match_area),
        strain: round4(strain),
    })
}

/// SLAB-mode manual build: apply user-specified 2x2 transforms and stack.
/// Faithful port of Python `build_interface_manual` (no ZSL search; legacy
/// fractional-coordinate strain path).
///
/// `xy_shift` is a fractional `(fa, fb)` in-plane shift of the film along the
/// raw substrate-supercell a,b vectors (sl_vectors are None in manual mode).
#[allow(clippy::too_many_arguments)]
pub fn build_interface_manual(
    substrate_slab: &Structure,
    film_slab: &Structure,
    substrate_transform: &[[i64; 2]; 2],
    film_transform: &[[i64; 2]; 2],
    gap: f64,
    vacuum: f64,
    xy_shift: (f64, f64),
) -> Result<BuildResult, String> {
    let sub = strip_vacuum(substrate_slab, 0.5);
    let film = strip_vacuum(film_slab, 0.5);

    let sub_super = make_supercell_2d(&sub, substrate_transform).map_err(|e| e.to_string())?;
    let film_super = make_supercell_2d(&film, film_transform).map_err(|e| e.to_string())?;

    let n_sub = sub_super.num_sites();
    let n_film = film_super.num_sites();

    // Manual mode uses the legacy fractional path (sl_vectors = None) and no
    // twist (matches the WASM manual build's default of twist_angle = 0.0).
    let interface =
        stack_slabs(&sub_super, &film_super, gap, vacuum, 0.0, None, None, xy_shift);

    let m = interface.lattice.matrix();
    let a = Vector3::new(m[(0, 0)], m[(0, 1)], m[(0, 2)]);
    let b = Vector3::new(m[(1, 0)], m[(1, 1)], m[(1, 2)]);
    let match_area = vec_area(&a, &b);

    // Strain from the raw supercell super-lattice vectors.
    let sub_sl = inplane_vectors(&sub_super);
    let film_sl = inplane_vectors(&film_super);
    let strain = compute_strain_percent(&film_sl, &sub_sl);

    Ok(BuildResult {
        structure: interface,
        n_atoms: n_sub + n_film,
        n_atoms_substrate: n_sub,
        n_atoms_film: n_film,
        match_area: round2(match_area),
        strain: round4(strain),
    })
}

// =====================================================================
// Lateral (in-plane) heterojunction — side-by-side stitching of two slabs.
// Faithful port of Python `search_lateral_matches` / `_join_lateral` /
// `build_lateral_interface`.
// =====================================================================

/// A 1D edge-match candidate for a lateral heterojunction. Mirrors the Python
/// `LateralMatchCandidate` dataclass.
#[derive(Debug, Clone)]
pub struct LateralMatchCandidate {
    /// Stable id (== index into the unsorted-then-sorted match list).
    pub match_id: usize,
    /// Supercell multiplier for slab A along the interface edge.
    pub n1: usize,
    /// Supercell multiplier for slab B along the interface edge.
    pub n2: usize,
    /// |n1 * edge_A| (Å), rounded to 4 dp.
    pub edge_length_a: f64,
    /// |n2 * edge_B| (Å), rounded to 4 dp.
    pub edge_length_b: f64,
    /// 1D mismatch percentage, rounded to 4 dp.
    pub strain_percent: f64,
    /// Slab A atom count after the supercell multiplier.
    pub n_atoms_a: usize,
    /// Slab B atom count after the supercell multiplier.
    pub n_atoms_b: usize,
}

/// Result of [`build_lateral_interface`].
#[derive(Debug, Clone)]
pub struct LateralBuildResult {
    /// The joined lateral heterojunction.
    pub structure: Structure,
    /// Total atom count.
    pub n_atoms: usize,
    /// Slab A atom count (× width_A).
    pub n_atoms_a: usize,
    /// Slab B atom count (× width_B).
    pub n_atoms_b: usize,
    /// Matched edge length (average of A and B), rounded to 4 dp.
    pub interface_length: f64,
    /// 1D mismatch percentage.
    pub strain: f64,
}

/// Find 1D edge-matched supercell pairs for a lateral heterojunction.
/// Faithful port of Python `search_lateral_matches`.
///
/// `interface_axis` is 0 (match along a) or 1 (match along b). Strips vacuum
/// from both slabs, enumerates `(n1, n2)` supercell multipliers whose matched
/// edge lengths fall within `max_length`/`max_strain`, then sorts by
/// (total atoms, strain) and truncates to `max_results`.
pub fn search_lateral_matches(
    slab_a: &Structure,
    slab_b: &Structure,
    interface_axis: usize,
    max_length: f64,
    max_strain: f64,
    max_results: usize,
) -> Vec<LateralMatchCandidate> {
    let stripped_a = strip_vacuum(slab_a, 0.5);
    let stripped_b = strip_vacuum(slab_b, 0.5);

    let ma = stripped_a.lattice.matrix();
    let mb = stripped_b.lattice.matrix();
    let axis_vec = |m: &Matrix3<f64>, ax: usize| {
        Vector3::new(m[(ax, 0)], m[(ax, 1)], m[(ax, 2)])
    };
    let len_a = axis_vec(&ma, interface_axis).norm();
    let len_b = axis_vec(&mb, interface_axis).norm();

    let n_atoms_a_base = stripped_a.num_sites();
    let n_atoms_b_base = stripped_b.num_sites();

    let n_max_a = ((max_length / len_a) as i64).max(1) as usize;
    let n_max_b = ((max_length / len_b) as i64).max(1) as usize;

    let mut matches: Vec<LateralMatchCandidate> = Vec::new();
    let mut match_id = 0usize;
    for n1 in 1..=n_max_a {
        let l_a = (n1 as f64) * len_a;
        if l_a > max_length {
            break;
        }
        for n2 in 1..=n_max_b {
            let l_b = (n2 as f64) * len_b;
            if l_b > max_length {
                break;
            }
            let avg = (l_a + l_b) / 2.0;
            let strain = (l_a - l_b).abs() / avg * 100.0;
            if strain > max_strain {
                continue;
            }
            matches.push(LateralMatchCandidate {
                match_id,
                n1,
                n2,
                edge_length_a: round4(l_a),
                edge_length_b: round4(l_b),
                strain_percent: round4(strain),
                n_atoms_a: n_atoms_a_base * n1,
                n_atoms_b: n_atoms_b_base * n2,
            });
            match_id += 1;
        }
    }

    // Sort by total atoms first, then strain (stable, mirrors Python).
    matches.sort_by(|a, b| {
        let ta = a.n_atoms_a + a.n_atoms_b;
        let tb = b.n_atoms_a + b.n_atoms_b;
        ta.cmp(&tb).then(
            a.strain_percent
                .partial_cmp(&b.strain_percent)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });

    matches.truncate(max_results);
    matches
}

/// Build a diagonal 3x3 supercell scaling matrix with `mult_interface` along
/// `interface_axis`, `mult_perp` along the perpendicular axis, and 1 along c.
fn lateral_supercell_matrix(
    interface_axis: usize,
    perp_axis: usize,
    mult_interface: usize,
    mult_perp: usize,
) -> [[i32; 3]; 3] {
    let mut t = [[0i32; 3]; 3];
    t[2][2] = 1;
    t[interface_axis][interface_axis] = mult_interface as i32;
    t[perp_axis][perp_axis] = mult_perp as i32;
    t
}

/// Join two slabs side-by-side to form a lateral heterojunction.
/// Faithful port of Python `_join_lateral`.
#[allow(clippy::too_many_arguments)]
fn join_lateral(
    slab_a: &Structure,
    slab_b: &Structure,
    n1: usize,
    n2: usize,
    interface_axis: usize,
    width_a: usize,
    width_b: usize,
    buffer: f64,
    vacuum: f64,
) -> crate::error::Result<Structure> {
    let stripped_a = strip_vacuum(slab_a, 0.5);
    let stripped_b = strip_vacuum(slab_b, 0.5);

    let perp_axis = 1 - interface_axis;

    let t_a = lateral_supercell_matrix(interface_axis, perp_axis, n1, width_a);
    let t_b = lateral_supercell_matrix(interface_axis, perp_axis, n2, width_b);
    let sc_a = stripped_a.make_supercell(t_a)?;
    let sc_b = stripped_b.make_supercell(t_b)?;

    let mat_a = *sc_a.lattice.matrix();
    let mat_b = *sc_b.lattice.matrix();
    let row = |m: &Matrix3<f64>, r: usize| Vector3::new(m[(r, 0)], m[(r, 1)], m[(r, 2)]);

    // Target interface edge length from slab A.
    let target_edge = row(&mat_a, interface_axis);

    // Strain B: replace its interface-axis vector with A's.
    let mut strained_b_mat = mat_b;
    strained_b_mat[(interface_axis, 0)] = target_edge.x;
    strained_b_mat[(interface_axis, 1)] = target_edge.y;
    strained_b_mat[(interface_axis, 2)] = target_edge.z;
    let strained_b_lattice = Lattice::new(strained_b_mat);
    let b_cart = strained_b_lattice.get_cartesian_coords(&sc_b.frac_coords);

    let a_cart = sc_a.cart_coords();

    // Perpendicular extent of slab A.
    let perp_vec_a = row(&mat_a, perp_axis);
    let perp_len_a = perp_vec_a.norm();
    let perp_unit = if perp_len_a > 1e-10 {
        perp_vec_a / perp_len_a
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };

    // Shift B atoms after A along the perpendicular direction.
    let shift_b = perp_vec_a + perp_unit * buffer;
    let b_cart_shifted: Vec<Vector3<f64>> = b_cart.iter().map(|p| p + shift_b).collect();

    // Combined perpendicular vector.
    let perp_vec_b = row(&strained_b_mat, perp_axis);
    let combined_perp = perp_vec_a + perp_unit * buffer + perp_vec_b;

    // c-axis: max thickness + vacuum, along A's c direction.
    let c_a_vec = row(&mat_a, 2);
    let c_a = c_a_vec.norm();
    let c_b = row(&strained_b_mat, 2).norm();
    let c_hat_a = if c_a > 1e-10 {
        c_a_vec / c_a
    } else {
        Vector3::new(0.0, 0.0, 1.0)
    };
    let new_c_len = c_a.max(c_b) + vacuum;
    let new_c_vec = c_hat_a * new_c_len;

    // Assemble the new lattice (rows by axis index).
    let mut new_mat = Matrix3::zeros();
    let set_row = |m: &mut Matrix3<f64>, r: usize, v: &Vector3<f64>| {
        m[(r, 0)] = v.x;
        m[(r, 1)] = v.y;
        m[(r, 2)] = v.z;
    };
    set_row(&mut new_mat, interface_axis, &target_edge);
    set_row(&mut new_mat, perp_axis, &combined_perp);
    set_row(&mut new_mat, 2, &new_c_vec);
    let new_lattice = Lattice::new(new_mat);

    let mut all_cart = a_cart;
    all_cart.extend(b_cart_shifted);
    let mut species: Vec<Species> = sc_a.species().into_iter().copied().collect();
    species.extend(sc_b.species().into_iter().copied());

    let frac = new_lattice.get_fractional_coords(&all_cart);
    Ok(Structure::new(new_lattice, species, frac))
}

/// Build a lateral heterojunction from two slabs. Faithful port of Python
/// `build_lateral_interface`: runs [`search_lateral_matches`], selects the
/// match at `match_index`, and joins the slabs side-by-side via [`join_lateral`].
#[allow(clippy::too_many_arguments)]
pub fn build_lateral_interface(
    slab_a: &Structure,
    slab_b: &Structure,
    match_index: usize,
    interface_axis: usize,
    width_a: usize,
    width_b: usize,
    buffer: f64,
    vacuum: f64,
    max_length: f64,
    max_strain: f64,
) -> Result<LateralBuildResult, String> {
    let matches = search_lateral_matches(
        slab_a,
        slab_b,
        interface_axis,
        max_length,
        max_strain,
        (match_index + 1).max(50),
    );

    if matches.is_empty() {
        return Err("No lateral matches found with given tolerances.".to_string());
    }
    if match_index >= matches.len() {
        return Err(format!(
            "match_index={match_index} out of range (found {} matches)",
            matches.len()
        ));
    }
    let m = &matches[match_index];

    let interface = join_lateral(
        slab_a,
        slab_b,
        m.n1,
        m.n2,
        interface_axis,
        width_a,
        width_b,
        buffer,
        vacuum,
    )
    .map_err(|e| e.to_string())?;

    let interface_length = (m.edge_length_a + m.edge_length_b) / 2.0;

    Ok(LateralBuildResult {
        structure: interface,
        n_atoms: m.n_atoms_a * width_a + m.n_atoms_b * width_b,
        n_atoms_a: m.n_atoms_a * width_a,
        n_atoms_b: m.n_atoms_b * width_b,
        interface_length: round4(interface_length),
        strain: m.strain_percent,
    })
}

/// One registry candidate: an interface built at a particular in-plane shift.
/// Mirrors the per-candidate dict returned by Python `build_registry_candidates`.
#[derive(Debug, Clone)]
pub struct RegistryCandidate {
    /// The built interface structure.
    pub structure: Structure,
    /// Fractional shift along interface a (rounded to 4 dp).
    pub shift_a: f64,
    /// Fractional shift along interface b (rounded to 4 dp).
    pub shift_b: f64,
    /// Candidate label (used for filenames).
    pub label: String,
    /// Total atom count.
    pub n_atoms: usize,
    /// Interface in-plane area (Å²).
    pub match_area: f64,
    /// Von Mises strain (%).
    pub strain: f64,
}

/// Extract unique surface atom xy positions (top-most layer) in Cartesian.
/// Faithful port of Python `_get_surface_sites_cart`.
///
/// Returns (x, y) for the top z-layer (within `tol` of the max c-projection),
/// deduplicated by Cartesian proximity (< 0.2 Å).
fn get_surface_sites_cart(structure: &Structure, tol: f64) -> Vec<(f64, f64)> {
    let mat = structure.lattice.matrix();
    let c_vec = Vector3::new(mat[(2, 0)], mat[(2, 1)], mat[(2, 2)]);
    let c_unit = c_vec / c_vec.norm();
    let cart = structure.cart_coords();
    let projections: Vec<f64> = cart.iter().map(|p| p.dot(&c_unit)).collect();
    let z_max = projections.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    let mut surface: Vec<(f64, f64)> = Vec::new();
    for (i, p) in cart.iter().enumerate() {
        if (projections[i] - z_max).abs() < tol {
            surface.push((p.x, p.y));
        }
    }

    let mut unique: Vec<(f64, f64)> = Vec::new();
    for (x, y) in surface {
        let mut is_dup = false;
        for &(ux, uy) in &unique {
            if (x - ux).abs() < 0.2 && (y - uy).abs() < 0.2 {
                is_dup = true;
                break;
            }
        }
        if !is_dup {
            unique.push((x, y));
        }
    }
    unique
}

/// Generate registry candidates for a selected ZSL match: build the SAME match
/// at a family of in-plane xy shifts. Faithful port of Python
/// `build_registry_candidates`.
///
/// Shift-grid priority (matches Python):
///   - `step_angstrom > 0`  →  regular grid stepping `step_angstrom` Å along
///                             each sl_vector; last partial step discarded.
///   - `n_shift > 0`        →  `n_shift × n_shift` uniform fractional grid.
///   - `n_shift == 0`       →  surface-atom-based shifts (baseline + each
///                             unique substrate surface site).
#[allow(clippy::too_many_arguments)]
pub fn build_registry_candidates(
    substrate_slab: &Structure,
    film_slab: &Structure,
    match_index: usize,
    n_shift: usize,
    gap: f64,
    vacuum: f64,
    max_area: f64,
    max_area_ratio_tol: f64,
    max_length_tol: f64,
    max_angle_tol: f64,
    step_angstrom: f64,
    target_z: f64,
) -> Result<Vec<RegistryCandidate>, String> {
    let sub = strip_vacuum(substrate_slab, 0.5);
    let film = strip_vacuum(film_slab, 0.5);

    let sub_vecs = inplane_vectors(&sub);
    let film_vecs = inplane_vectors(&film);
    let original_sub_a = sub_vecs[0];

    let zgen = ZslGenerator {
        max_area,
        max_area_ratio_tol,
        max_length_tol,
        max_angle_tol,
        bidirectional: false,
    };

    let zsl_matches = zgen.generate(&film_vecs, &sub_vecs);
    if match_index >= zsl_matches.len() {
        return Err(format!(
            "Match index {match_index} out of range (have {} matches).",
            zsl_matches.len()
        ));
    }
    let selected = &zsl_matches[match_index];

    let sub_super =
        make_supercell_2d(&sub, &selected.substrate_transformation).map_err(|e| e.to_string())?;
    let film_super =
        make_supercell_2d(&film, &selected.film_transformation).map_err(|e| e.to_string())?;

    // Normalize a/b ordering to match original substrate convention.
    let (sub_sl, film_sl) = align_sl_vectors(
        selected.substrate_sl_vectors,
        selected.film_sl_vectors,
        &original_sub_a,
    );

    let strain = compute_strain_percent(&film_sl, &sub_sl);

    // Determine shift grid: list of (fa, fb, label).
    let mut shifts: Vec<(f64, f64, String)> = Vec::new();
    if step_angstrom > 0.0 {
        let a_len = sub_sl[0].norm();
        let b_len = sub_sl[1].norm();
        let n_a = (a_len / step_angstrom).floor().max(1.0) as usize;
        let n_b = (b_len / step_angstrom).floor().max(1.0) as usize;
        for i in 0..n_a {
            for j in 0..n_b {
                let fa = (i as f64) * step_angstrom / a_len;
                let fb = (j as f64) * step_angstrom / b_len;
                let label = format!(
                    "s{:.2}_{:.2}",
                    (i as f64) * step_angstrom,
                    (j as f64) * step_angstrom
                );
                shifts.push((fa, fb, label));
            }
        }
    } else if n_shift > 0 {
        let n = n_shift as f64;
        for i in 0..n_shift {
            for j in 0..n_shift {
                let fa = (i as f64) / n;
                let fb = (j as f64) / n;
                let label = format!("s{fa:.2}_{fb:.2}");
                shifts.push((fa, fb, label));
            }
        }
    } else {
        // Surface-atom-based shifts: align film ref atom over each substrate
        // surface site. Cartesian → fractional in the interface (sl) lattice.
        let d = compute_deformation_2d(&film_sl, &sub_sl);
        let film_ref0 = film_super.cart_coords()[0];
        let film_ref_xy = d * Vector2::new(film_ref0.x, film_ref0.y);

        let surface_sites = get_surface_sites_cart(&sub_super, 0.5);

        // 2x2 inverse of [a_sl; b_sl]^T (columns = sl vectors).
        let a_sl = Vector2::new(sub_sl[0].x, sub_sl[0].y);
        let b_sl = Vector2::new(sub_sl[1].x, sub_sl[1].y);
        let m = Matrix2::new(a_sl.x, b_sl.x, a_sl.y, b_sl.y);
        let m_inv = m.try_inverse().unwrap_or_else(Matrix2::identity);

        // Baseline (0,0) is always first.
        shifts.push((0.0, 0.0, "baseline".to_string()));
        for (sx, sy) in surface_sites {
            let delta = Vector2::new(sx, sy) - film_ref_xy;
            let fab = m_inv * delta;
            let fa = wrap01(fab.x);
            let fb = wrap01(fab.y);
            // Dedup against existing shifts with periodic distance < 0.02.
            let mut is_dup = false;
            for (ea, eb, _) in &shifts {
                let da = (fa - ea).abs().min(1.0 - (fa - ea).abs());
                let db = (fb - eb).abs().min(1.0 - (fb - eb).abs());
                if da < 0.02 && db < 0.02 {
                    is_dup = true;
                    break;
                }
            }
            if !is_dup {
                let label = format!("site_{fa:.3}_{fb:.3}");
                shifts.push((fa, fb, label));
            }
        }
    }

    let mut candidates: Vec<RegistryCandidate> = Vec::with_capacity(shifts.len());
    for (fa, fb, label) in shifts {
        let interface = stack_slabs_target_z(
            &sub_super,
            &film_super,
            gap,
            vacuum,
            0.0,
            Some(&film_sl),
            Some(&sub_sl),
            (fa, fb),
            target_z,
        );

        let m = interface.lattice.matrix();
        let a = Vector3::new(m[(0, 0)], m[(0, 1)], m[(0, 2)]);
        let b = Vector3::new(m[(1, 0)], m[(1, 1)], m[(1, 2)]);
        let match_area = vec_area(&a, &b);
        let n_atoms = interface.num_sites();

        candidates.push(RegistryCandidate {
            structure: interface,
            shift_a: round4(fa),
            shift_b: round4(fb),
            label,
            n_atoms,
            match_area: round2(match_area),
            strain: round4(strain),
        });
    }

    Ok(candidates)
}

/// Like [`stack_slabs`] but with an explicit `target_z` (when `> 0`, the new
/// c-length is fixed to `target_z` instead of `total_top + vacuum`).
/// Used by [`build_registry_candidates`] (Python `_stack_slabs` `target_z`).
#[allow(clippy::too_many_arguments)]
fn stack_slabs_target_z(
    substrate: &Structure,
    film: &Structure,
    gap: f64,
    vacuum: f64,
    twist_angle: f64,
    film_sl: Option<&[Vector3<f64>; 2]>,
    sub_sl: Option<&[Vector3<f64>; 2]>,
    xy_shift: (f64, f64),
    target_z: f64,
) -> Structure {
    if target_z <= 0.0 {
        return stack_slabs(
            substrate, film, gap, vacuum, twist_angle, film_sl, sub_sl, xy_shift,
        );
    }
    // target_z path: replicate stack_slabs but override new_c_len.
    let sub_mat = substrate.lattice.matrix();
    let sub_cart = substrate.cart_coords();

    let mut film_cart = film.cart_coords();
    if let (Some(fsl), Some(ssl)) = (film_sl, sub_sl) {
        let d = compute_deformation_2d(fsl, ssl);
        for p in film_cart.iter_mut() {
            let xy = Vector2::new(p.x, p.y);
            let nxy = d * xy;
            p.x = nxy.x;
            p.y = nxy.y;
        }
    } else {
        let fm = film.lattice.matrix();
        let strained = Matrix3::new(
            sub_mat[(0, 0)], sub_mat[(0, 1)], sub_mat[(0, 2)],
            sub_mat[(1, 0)], sub_mat[(1, 1)], sub_mat[(1, 2)],
            fm[(2, 0)], fm[(2, 1)], fm[(2, 2)],
        );
        let strained_lat = Lattice::new(strained);
        film_cart = strained_lat.get_cartesian_coords(&film.frac_coords);
    }

    apply_twist(&mut film_cart, twist_angle);

    let (fa, fb) = xy_shift;
    if fa.abs() > 1e-10 || fb.abs() > 1e-10 {
        let (a_vec, b_vec) = if let Some(ssl) = sub_sl {
            (ssl[0], ssl[1])
        } else {
            (
                Vector3::new(sub_mat[(0, 0)], sub_mat[(0, 1)], sub_mat[(0, 2)]),
                Vector3::new(sub_mat[(1, 0)], sub_mat[(1, 1)], sub_mat[(1, 2)]),
            )
        };
        let shift_xy = a_vec * fa + b_vec * fb;
        for p in film_cart.iter_mut() {
            *p += shift_xy;
        }
    }

    let sub_c = Vector3::new(sub_mat[(2, 0)], sub_mat[(2, 1)], sub_mat[(2, 2)]);
    let sub_c_unit = sub_c / sub_c.norm();
    let sub_top = sub_cart
        .iter()
        .map(|p| p.dot(&sub_c_unit))
        .fold(f64::NEG_INFINITY, f64::max);

    let film_mat = film.lattice.matrix();
    let film_c = Vector3::new(film_mat[(2, 0)], film_mat[(2, 1)], film_mat[(2, 2)]);
    let film_c_unit = film_c / film_c.norm();
    let film_bottom = film_cart
        .iter()
        .map(|p| p.dot(&film_c_unit))
        .fold(f64::INFINITY, f64::min);

    let shift = sub_c_unit * (sub_top + gap - film_bottom);
    let film_cart_shifted: Vec<Vector3<f64>> = film_cart.iter().map(|p| p + shift).collect();

    let _ = vacuum; // vacuum unused on the target_z path (matches Python).
    let new_c_len = target_z;

    let (a_vec, b_vec) = if let Some(ssl) = sub_sl {
        (ssl[0], ssl[1])
    } else {
        (
            Vector3::new(sub_mat[(0, 0)], sub_mat[(0, 1)], sub_mat[(0, 2)]),
            Vector3::new(sub_mat[(1, 0)], sub_mat[(1, 1)], sub_mat[(1, 2)]),
        )
    };
    let new_c = sub_c_unit * new_c_len;
    let new_matrix = Matrix3::new(
        a_vec.x, a_vec.y, a_vec.z, b_vec.x, b_vec.y, b_vec.z, new_c.x, new_c.y, new_c.z,
    );
    let new_lattice = Lattice::new(new_matrix);

    let mut all_cart = sub_cart;
    all_cart.extend(film_cart_shifted);
    let mut species: Vec<Species> = substrate.species().into_iter().copied().collect();
    species.extend(film.species().into_iter().copied());

    let frac = new_lattice.get_fractional_coords(&all_cart);
    let wrapped: Vec<Vector3<f64>> = frac
        .iter()
        .map(|f| Vector3::new(wrap01(f.x), wrap01(f.y), wrap01(f.z)))
        .collect();

    Structure::new(new_lattice, species, wrapped)
}

/// A single grid-scan entry: an in-plane shift applied to the film atoms of an
/// already-built heterostructure. Mirrors Python `GridScanEntry`.
#[derive(Debug, Clone)]
pub struct GridScanEntry {
    /// Fractional (fx, fy) shift.
    pub shift_frac: (f64, f64),
    /// Cartesian (x, y, z) shift.
    pub shift_cart: (f64, f64, f64),
    /// The shifted structure.
    pub structure: Structure,
    /// Total atom count.
    pub n_atoms: usize,
    /// Substrate atom count.
    pub n_atoms_substrate: usize,
    /// Film atom count.
    pub n_atoms_film: usize,
}

/// Result of [`grid_scan`]: the shifted structures plus reduction metadata.
#[derive(Debug, Clone)]
pub struct GridScanResult {
    /// One entry per irreducible grid point.
    pub entries: Vec<GridScanEntry>,
    /// Fractional extent of the irreducible zone.
    pub zone_extent: (f64, f64),
    /// Number of in-plane symmetry operations found.
    pub n_symmetry_ops: usize,
}

/// Extract 2D in-plane symmetry operations from a slab. Faithful port of
/// Python `get_2d_symmetry_operations`: take all space-group operations
/// (fractional rotation + translation) and keep those acting purely in the
/// a-b plane (no z mixing, |R22|≈1, t_z≈0). Falls back to identity-only.
fn get_2d_symmetry_operations(
    slab: &Structure,
    symprec: f64,
) -> Vec<(Matrix2<f64>, Vector2<f64>)> {
    let ops = match slab.get_symmetry_operations(symprec) {
        Ok(o) => o,
        Err(_) => return vec![(Matrix2::identity(), Vector2::zeros())],
    };

    let tol = 1e-4;
    let mut ops_2d: Vec<(Matrix2<f64>, Vector2<f64>)> = Vec::new();
    for (rot, trans) in &ops {
        let r = |i: usize, j: usize| rot[i][j] as f64;
        if r(2, 0).abs() < tol
            && r(2, 1).abs() < tol
            && r(0, 2).abs() < tol
            && r(1, 2).abs() < tol
            && (r(2, 2).abs() - 1.0).abs() < tol
            && trans[2].abs() < tol
        {
            let rot_2d = Matrix2::new(r(0, 0), r(0, 1), r(1, 0), r(1, 1));
            let trans_2d = Vector2::new(trans[0], trans[1]);
            ops_2d.push((rot_2d, trans_2d));
        }
    }

    if ops_2d.is_empty() {
        ops_2d.push((Matrix2::identity(), Vector2::zeros()));
    }
    ops_2d
}

/// Determine the bounding box (fx_max, fy_max) of the irreducible wedge.
/// Faithful port of Python `get_irreducible_zone_extent` (N=120 fine grid,
/// canonical-point tuple ordering, +0.5/N boundary padding).
fn get_irreducible_zone_extent(
    sym_ops_2d: &[(Matrix2<f64>, Vector2<f64>)],
) -> (f64, f64) {
    const N: i64 = 120;
    let nf = N as f64;
    let mut seen: std::collections::HashSet<(i64, i64)> = std::collections::HashSet::new();

    for i in 0..N {
        for j in 0..N {
            let fx = (i as f64) / nf;
            let fy = (j as f64) / nf;
            let pt = Vector2::new(fx, fy);
            let mut canonical = (i, j);
            for (rot, trans) in sym_ops_2d {
                let transformed = rot * pt + trans;
                let wx = transformed.x - transformed.x.floor();
                let wy = transformed.y - transformed.y.floor();
                let ix = (((wx * nf).round() as i64) % N + N) % N;
                let iy = (((wy * nf).round() as i64) % N + N) % N;
                if (ix, iy) < canonical {
                    canonical = (ix, iy);
                }
            }
            seen.insert(canonical);
        }
    }

    if seen.is_empty() {
        return (1.0, 1.0);
    }

    let fx_max = seen.iter().map(|c| c.0).max().unwrap() as f64 / nf;
    let fy_max = seen.iter().map(|c| c.1).max().unwrap() as f64 / nf;
    let fx_max = (fx_max + 0.5 / nf).min(1.0);
    let fy_max = (fy_max + 0.5 / nf).min(1.0);
    (fx_max, fy_max)
}

/// Generate the uniform n_grid_x × n_grid_y grid within the irreducible zone.
/// Faithful port of Python `get_irreducible_grid_points` (count = nx*ny, no
/// reduction; symmetry sets the REGION, density is user-controlled).
fn get_irreducible_grid_points(
    sym_ops_2d: &[(Matrix2<f64>, Vector2<f64>)],
    n_grid_x: usize,
    n_grid_y: usize,
) -> (Vec<(f64, f64)>, (f64, f64)) {
    let (fx_max, fy_max) = get_irreducible_zone_extent(sym_ops_2d);
    let mut points = Vec::with_capacity(n_grid_x * n_grid_y);
    for i in 0..n_grid_x {
        for j in 0..n_grid_y {
            let fx = (i as f64) / (n_grid_x as f64) * fx_max;
            let fy = (j as f64) / (n_grid_y as f64) * fy_max;
            points.push((fx, fy));
        }
    }
    (points, (fx_max, fy_max))
}

/// Shift only the film atoms (indices >= n_atoms_substrate) in-plane for each
/// irreducible point. Faithful port of Python `generate_grid_scan_structures`:
/// the lattice, gap and vacuum are preserved as-is, z is untouched.
fn generate_grid_scan_structures(
    heterostructure: &Structure,
    n_atoms_substrate: usize,
    irreducible_points: &[(f64, f64)],
) -> Vec<GridScanEntry> {
    let n_total = heterostructure.num_sites();
    let n_film = n_total.saturating_sub(n_atoms_substrate);
    let mat = heterostructure.lattice.matrix();
    let a_vec = Vector3::new(mat[(0, 0)], mat[(0, 1)], mat[(0, 2)]);
    let b_vec = Vector3::new(mat[(1, 0)], mat[(1, 1)], mat[(1, 2)]);

    let base_cart = heterostructure.cart_coords();
    let species: Vec<Species> = heterostructure.species().into_iter().copied().collect();

    let mut entries = Vec::with_capacity(irreducible_points.len());
    for &(fx, fy) in irreducible_points {
        let shift_cart = a_vec * fx + b_vec * fy;
        let mut cart = base_cart.clone();
        for p in cart.iter_mut().skip(n_atoms_substrate) {
            p.x += shift_cart.x;
            p.y += shift_cart.y;
            // z unchanged.
        }
        let frac = heterostructure.lattice.get_fractional_coords(&cart);
        let shifted = Structure::new(heterostructure.lattice.clone(), species.clone(), frac);

        entries.push(GridScanEntry {
            shift_frac: (fx, fy),
            shift_cart: (shift_cart.x, shift_cart.y, shift_cart.z),
            structure: shifted,
            n_atoms: n_total,
            n_atoms_substrate,
            n_atoms_film: n_film,
        });
    }
    entries
}

/// Grid-scan an already-built heterostructure over the irreducible wedge of the
/// (vacuum-stripped) film slab. Faithful port of the Python `/grid-scan`
/// pipeline: 2D symmetry of the film → irreducible zone extent → uniform grid
/// → shift film atoms per point.
pub fn grid_scan(
    heterostructure: &Structure,
    film_slab: &Structure,
    n_atoms_substrate: usize,
    n_grid_x: usize,
    n_grid_y: usize,
    symprec: f64,
) -> GridScanResult {
    let film_stripped = strip_vacuum(film_slab, 0.5);
    let sym_ops_2d = get_2d_symmetry_operations(&film_stripped, symprec);
    let (irr_points, zone_extent) =
        get_irreducible_grid_points(&sym_ops_2d, n_grid_x, n_grid_y);
    let entries =
        generate_grid_scan_structures(heterostructure, n_atoms_substrate, &irr_points);

    GridScanResult {
        entries,
        zone_extent,
        n_symmetry_ops: sym_ops_2d.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square_slab(a: f64, c: f64, sym: &str, zs: &[f64]) -> Structure {
        let matrix = Matrix3::new(a, 0.0, 0.0, 0.0, a, 0.0, 0.0, 0.0, c);
        let lattice = Lattice::new(matrix);
        let el = crate::element::Element::from_symbol(sym).unwrap();
        let species: Vec<Species> = zs.iter().map(|_| Species::neutral(el)).collect();
        let frac: Vec<Vector3<f64>> = zs.iter().map(|z| Vector3::new(0.0, 0.0, z / c)).collect();
        Structure::new(lattice, species, frac)
    }

    #[test]
    fn search_finds_clean_match() {
        let sub = square_slab(3.0, 25.0, "Cu", &[10.0, 12.0]);
        let film = square_slab(3.15, 25.0, "Au", &[10.0, 12.0]);
        let matches = search_matches_slab(&sub, &film, 200.0, 0.09, 0.06, 0.02, 50);
        assert!(!matches.is_empty());
        // The clean 1x10 / 1x9 match (~89.3 Å², strain ~9.18%) should appear.
        let clean = matches
            .iter()
            .find(|m| (m.match_area - 89.3).abs() < 1.0 && (m.strain - 9.18).abs() < 0.5);
        assert!(clean.is_some(), "expected the ~9.18% strain match");
    }

    #[test]
    fn build_clean_match_atom_count() {
        let sub = square_slab(3.0, 25.0, "Cu", &[10.0, 12.0]);
        let film = square_slab(3.15, 25.0, "Au", &[10.0, 12.0]);
        // generation-order index of the clean match: find it via search first.
        let matches = search_matches_slab(&sub, &film, 200.0, 0.09, 0.06, 0.02, 50);
        let clean = matches
            .iter()
            .find(|m| (m.match_area - 89.3).abs() < 1.0 && (m.strain - 9.18).abs() < 0.5)
            .unwrap();
        let res = build_interface_slab(
            &sub,
            &film,
            clean.match_id,
            2.0,
            20.0,
            0.0,
            200.0,
            0.09,
            0.06,
            0.02,
        )
        .unwrap();
        assert_eq!(res.n_atoms, 38);
        assert_eq!(res.n_atoms_substrate, 20);
        assert_eq!(res.n_atoms_film, 18);
    }
}

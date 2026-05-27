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
/// path, no twist, no xy-shift, target_z=0).
///
/// Both slabs must already be supercells. The film's in-plane lattice is
/// strained to match the substrate via the deformation gradient D computed
/// from the matched super-lattice vectors. The result is wrapped to [0,1).
#[allow(clippy::too_many_arguments)]
fn stack_slabs(
    substrate: &Structure,
    film: &Structure,
    gap: f64,
    vacuum: f64,
    film_sl: Option<&[Vector3<f64>; 2]>,
    sub_sl: Option<&[Vector3<f64>; 2]>,
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
        Some(&film_sl),
        Some(&sub_sl),
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
#[allow(clippy::too_many_arguments)]
pub fn build_interface_manual(
    substrate_slab: &Structure,
    film_slab: &Structure,
    substrate_transform: &[[i64; 2]; 2],
    film_transform: &[[i64; 2]; 2],
    gap: f64,
    vacuum: f64,
) -> Result<BuildResult, String> {
    let sub = strip_vacuum(substrate_slab, 0.5);
    let film = strip_vacuum(film_slab, 0.5);

    let sub_super = make_supercell_2d(&sub, substrate_transform).map_err(|e| e.to_string())?;
    let film_super = make_supercell_2d(&film, film_transform).map_err(|e| e.to_string())?;

    let n_sub = sub_super.num_sites();
    let n_film = film_super.num_sites();

    // Manual mode uses the legacy fractional path (sl_vectors = None).
    let interface = stack_slabs(&sub_super, &film_super, gap, vacuum, None, None);

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

//! WASM bindings for the SLAB-mode heterostructure builder.
//!
//! JSON in/out mirrors `src/lib/api/heterostructure.ts` for the covered
//! endpoints (`/search` slab mode, `/build` slab mode, `/build-manual`).
//! The bulk, intermat, lateral and grid-scan endpoints are NOT covered here
//! and remain backend-only.

use nalgebra::Vector3;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::heterostructure::{
    build_interface_manual, build_interface_slab, build_registry_candidates, grid_scan,
    search_matches_slab, BuildResult, MatchCandidate,
};
use crate::wasm_types::{JsCrystal, WasmResult};

/// Search parameters (SLAB mode). Mirrors the SLAB-relevant subset of
/// `HeterostructureSearchParams` in the TS API.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(from_wasm_abi)]
pub struct JsHeteroSearchParams {
    /// Maximum super-lattice area (Å²).
    #[serde(default = "default_max_area")]
    pub max_area: f64,
    /// Area ratio tolerance.
    #[serde(default = "default_area_ratio_tol")]
    pub max_area_ratio_tol: f64,
    /// Length tolerance for vector matching.
    #[serde(default = "default_length_tol")]
    pub max_length_tol: f64,
    /// Angle tolerance for vector matching.
    #[serde(default = "default_angle_tol")]
    pub max_angle_tol: f64,
    /// Maximum matches to return.
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

fn default_max_area() -> f64 {
    400.0
}
fn default_area_ratio_tol() -> f64 {
    0.09
}
fn default_length_tol() -> f64 {
    0.03
}
fn default_angle_tol() -> f64 {
    0.01
}
fn default_max_results() -> usize {
    50
}

impl Default for JsHeteroSearchParams {
    fn default() -> Self {
        Self {
            max_area: default_max_area(),
            max_area_ratio_tol: default_area_ratio_tol(),
            max_length_tol: default_length_tol(),
            max_angle_tol: default_angle_tol(),
            max_results: default_max_results(),
        }
    }
}

/// One ZSL match in the search result. Field names match the TS
/// `HeterostructureMatch` interface (miller indices are echoed as [0,0,1]
/// for slab mode since no Miller cut is involved).
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsHeteroMatch {
    /// Stable id == generation-order index (used by build).
    pub match_id: usize,
    /// Matched super-lattice area (Å²).
    pub match_area: f64,
    /// Film Miller index (always [0,0,1] in slab mode).
    pub film_miller: [i32; 3],
    /// Substrate Miller index (always [0,0,1] in slab mode).
    pub substrate_miller: [i32; 3],
    /// Integer film transformation (2x2 -> nested arrays).
    pub film_transformation: Vec<Vec<i64>>,
    /// Integer substrate transformation (2x2 -> nested arrays).
    pub substrate_transformation: Vec<Vec<i64>>,
    /// Film super-lattice vectors (3D).
    pub film_sl_vectors: Vec<Vec<f64>>,
    /// Substrate super-lattice vectors (3D).
    pub substrate_sl_vectors: Vec<Vec<f64>>,
    /// Von Mises strain (%).
    pub strain: f64,
    /// Substrate atom count.
    pub n_atoms_substrate: usize,
    /// Film atom count.
    pub n_atoms_film: usize,
}

impl JsHeteroMatch {
    fn from_candidate(c: &MatchCandidate) -> Self {
        let v3 = |v: &Vector3<f64>| vec![v.x, v.y, v.z];
        let t2 = |t: &[[i64; 2]; 2]| {
            vec![vec![t[0][0], t[0][1]], vec![t[1][0], t[1][1]]]
        };
        Self {
            match_id: c.match_id,
            match_area: c.match_area,
            film_miller: [0, 0, 1],
            substrate_miller: [0, 0, 1],
            film_transformation: t2(&c.film_transformation),
            substrate_transformation: t2(&c.substrate_transformation),
            film_sl_vectors: c.film_sl_vectors.iter().map(v3).collect(),
            substrate_sl_vectors: c.substrate_sl_vectors.iter().map(v3).collect(),
            strain: c.strain,
            n_atoms_substrate: c.n_atoms_substrate,
            n_atoms_film: c.n_atoms_film,
        }
    }
}

/// Search result. Mirrors `HeterostructureSearchResult` (terminations are
/// empty in slab mode, as in the Python `search_matches_slab`).
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsHeteroSearchResult {
    /// Matches sorted by (area, strain).
    pub matches: Vec<JsHeteroMatch>,
    /// Termination pairs (always empty in slab mode).
    pub terminations: Vec<serde_json::Value>,
    /// Number of matches.
    pub n_matches: usize,
    /// Number of termination pairs.
    pub n_terminations: usize,
    /// Human-readable message.
    pub message: String,
}

/// Build result. Mirrors `HeterostructureBuildResult`.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsHeteroBuildResult {
    /// The built interface structure.
    pub structure: JsCrystal,
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
    /// Human-readable message.
    pub message: String,
}

fn build_result_to_js(r: BuildResult) -> JsHeteroBuildResult {
    let msg = format!(
        "Built interface: {} atoms ({} substrate + {} film), area={:.1} Å², strain={:.2}%",
        r.n_atoms, r.n_atoms_substrate, r.n_atoms_film, r.match_area, r.strain
    );
    JsHeteroBuildResult {
        structure: JsCrystal::from_structure(&r.structure),
        n_atoms: r.n_atoms,
        n_atoms_substrate: r.n_atoms_substrate,
        n_atoms_film: r.n_atoms_film,
        match_area: r.match_area,
        strain: r.strain,
        message: msg,
    }
}

/// SLAB-mode ZSL lattice-match search between two slabs.
///
/// Equivalent to `POST /api/heterostructure/search` with `params.mode = "slab"`.
#[wasm_bindgen]
pub fn hetero_search(
    substrate: JsCrystal,
    film: JsCrystal,
    params: JsHeteroSearchParams,
) -> WasmResult<JsHeteroSearchResult> {
    let result: Result<JsHeteroSearchResult, String> = (|| {
        let sub = substrate.to_structure()?;
        let flm = film.to_structure()?;

        let matches = search_matches_slab(
            &sub,
            &flm,
            params.max_area,
            params.max_area_ratio_tol,
            params.max_length_tol,
            params.max_angle_tol,
            params.max_results,
        );

        let js_matches: Vec<JsHeteroMatch> =
            matches.iter().map(JsHeteroMatch::from_candidate).collect();
        let n = js_matches.len();
        Ok(JsHeteroSearchResult {
            matches: js_matches,
            terminations: Vec::new(),
            n_matches: n,
            n_terminations: 0,
            message: format!("Found {n} lattice matches, 0 termination pairs"),
        })
    })();
    result.into()
}

/// SLAB-mode build for a selected ZSL match.
///
/// Equivalent to `POST /api/heterostructure/build` with
/// `search_params.mode = "slab"`. `match_id` is the generation-order index
/// from a [`hetero_search`] result (the `match_id` field).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn build_hetero(
    substrate: JsCrystal,
    film: JsCrystal,
    match_id: usize,
    gap: f64,
    vacuum: f64,
    params: JsHeteroSearchParams,
) -> WasmResult<JsHeteroBuildResult> {
    let result: Result<JsHeteroBuildResult, String> = (|| {
        let sub = substrate.to_structure()?;
        let flm = film.to_structure()?;

        let r = build_interface_slab(
            &sub,
            &flm,
            match_id,
            gap,
            vacuum,
            params.max_area,
            params.max_area_ratio_tol,
            params.max_length_tol,
            params.max_angle_tol,
        )?;
        Ok(build_result_to_js(r))
    })();
    result.into()
}

/// SLAB-mode manual build with user-specified 2x2 transforms (no ZSL search).
///
/// Equivalent to `POST /api/heterostructure/build-manual`. Each transform is
/// a 2x2 integer matrix as nested arrays. `xy_shift` is the fractional
/// `(fa, fb)` in-plane shift of the film along the substrate-supercell a,b
/// vectors (defaults to `(0, 0)` to match the no-shift manual build).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn build_hetero_manual(
    substrate: JsCrystal,
    film: JsCrystal,
    substrate_transform: Vec<i32>,
    film_transform: Vec<i32>,
    gap: f64,
    vacuum: f64,
    xy_shift_a: f64,
    xy_shift_b: f64,
) -> WasmResult<JsHeteroBuildResult> {
    let result: Result<JsHeteroBuildResult, String> = (|| {
        if substrate_transform.len() != 4 || film_transform.len() != 4 {
            return Err(
                "substrate_transform and film_transform must each be 4 ints (row-major 2x2)"
                    .to_string(),
            );
        }
        let sub = substrate.to_structure()?;
        let flm = film.to_structure()?;

        let st = [
            [substrate_transform[0] as i64, substrate_transform[1] as i64],
            [substrate_transform[2] as i64, substrate_transform[3] as i64],
        ];
        let ft = [
            [film_transform[0] as i64, film_transform[1] as i64],
            [film_transform[2] as i64, film_transform[3] as i64],
        ];

        let r = build_interface_manual(
            &sub,
            &flm,
            &st,
            &ft,
            gap,
            vacuum,
            (xy_shift_a, xy_shift_b),
        )?;
        Ok(build_result_to_js(r))
    })();
    result.into()
}

/// One registry candidate in the WASM result. Mirrors the per-candidate
/// manifest entry plus the built structure, so the TS side can assemble the
/// same zip archive the backend `/batch-build` returns.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsRegistryCandidate {
    /// The built interface structure.
    pub structure: JsCrystal,
    /// Fractional shift along interface a.
    pub shift_a: f64,
    /// Fractional shift along interface b.
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

/// Registry-candidate set result.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsRegistryResult {
    /// One entry per in-plane shift.
    pub candidates: Vec<JsRegistryCandidate>,
    /// Number of candidates.
    pub n_candidates: usize,
}

/// SLAB-mode registry candidates: build the SAME ZSL match at a family of
/// in-plane xy shifts.
///
/// Equivalent to `POST /api/heterostructure/batch-build` (minus the
/// zip-archive serialization, which the TS side performs from these
/// structures). `match_id` is the generation-order index.
///
/// Shift-grid priority: `step_angstrom > 0` → Å-step grid;
/// else `n_shift > 0` → n×n uniform grid; else surface-atom shifts.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn build_hetero_registry(
    substrate: JsCrystal,
    film: JsCrystal,
    match_id: usize,
    n_shift: usize,
    gap: f64,
    vacuum: f64,
    step_angstrom: f64,
    target_z: f64,
    params: JsHeteroSearchParams,
) -> WasmResult<JsRegistryResult> {
    let result: Result<JsRegistryResult, String> = (|| {
        let sub = substrate.to_structure()?;
        let flm = film.to_structure()?;

        let cands = build_registry_candidates(
            &sub,
            &flm,
            match_id,
            n_shift,
            gap,
            vacuum,
            params.max_area,
            params.max_area_ratio_tol,
            params.max_length_tol,
            params.max_angle_tol,
            step_angstrom,
            target_z,
        )?;

        let candidates: Vec<JsRegistryCandidate> = cands
            .iter()
            .map(|c| JsRegistryCandidate {
                structure: JsCrystal::from_structure(&c.structure),
                shift_a: c.shift_a,
                shift_b: c.shift_b,
                label: c.label.clone(),
                n_atoms: c.n_atoms,
                match_area: c.match_area,
                strain: c.strain,
            })
            .collect();
        let n = candidates.len();
        Ok(JsRegistryResult {
            candidates,
            n_candidates: n,
        })
    })();
    result.into()
}

/// One grid-scan entry: a shifted heterostructure. Mirrors the TS
/// `GridScanShiftEntry`.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsGridScanEntry {
    /// Fractional (fx, fy) shift.
    pub shift_frac: Vec<f64>,
    /// Cartesian (x, y, z) shift.
    pub shift_cart: Vec<f64>,
    /// The shifted structure.
    pub structure: JsCrystal,
    /// Total atom count.
    pub n_atoms: usize,
    /// Human-readable shift label.
    pub label: String,
}

/// Grid-scan result. Mirrors the TS `GridScanResult`.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsGridScanResult {
    /// One entry per irreducible grid point.
    pub entries: Vec<JsGridScanEntry>,
    /// Total grid points (== irreducible count; no reduction beyond the zone).
    pub n_total_grid: usize,
    /// Number of irreducible grid points.
    pub n_irreducible: usize,
    /// Number of in-plane symmetry operations found.
    pub n_symmetry_ops: usize,
    /// Reduction ratio (1 / zone-area-fraction).
    pub reduction_ratio: f64,
    /// Shifted structures (flat list, mirrors `structures`).
    pub structures: Vec<JsCrystal>,
    /// Labels (flat list, mirrors `labels`).
    pub labels: Vec<String>,
    /// Human-readable message.
    pub message: String,
}

/// SLAB-mode grid scan: shift the film atoms of an already-built
/// heterostructure across the irreducible wedge of the film slab.
///
/// Equivalent to `POST /api/heterostructure/grid-scan`. `n_atoms_substrate`
/// is the number of leading substrate atoms (the rest are film).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn build_hetero_grid_scan(
    heterostructure: JsCrystal,
    film: JsCrystal,
    n_atoms_substrate: usize,
    n_grid_x: usize,
    n_grid_y: usize,
    symprec: f64,
) -> WasmResult<JsGridScanResult> {
    let result: Result<JsGridScanResult, String> = (|| {
        let hetero = heterostructure.to_structure()?;
        let flm = film.to_structure()?;

        let r = grid_scan(&hetero, &flm, n_atoms_substrate, n_grid_x, n_grid_y, symprec);

        let mut entries: Vec<JsGridScanEntry> = Vec::with_capacity(r.entries.len());
        let mut structures: Vec<JsCrystal> = Vec::with_capacity(r.entries.len());
        let mut labels: Vec<String> = Vec::with_capacity(r.entries.len());
        for e in &r.entries {
            let label = format!("shift_({:.3},{:.3})", e.shift_frac.0, e.shift_frac.1);
            let js_struct = JsCrystal::from_structure(&e.structure);
            entries.push(JsGridScanEntry {
                shift_frac: vec![e.shift_frac.0, e.shift_frac.1],
                shift_cart: vec![e.shift_cart.0, e.shift_cart.1, e.shift_cart.2],
                structure: js_struct.clone(),
                n_atoms: e.n_atoms,
                label: label.clone(),
            });
            structures.push(js_struct);
            labels.push(label);
        }

        let n_points = entries.len();
        let zone_area = (r.zone_extent.0 * r.zone_extent.1).max(1e-6);
        let reduction_ratio = (1.0 / zone_area * 10.0).round() / 10.0;
        let message = format!(
            "{n_points} structures ({n_grid_x}×{n_grid_y} grid in irreducible zone \
             {:.1}%×{:.1}% of cell, {} sym ops)",
            r.zone_extent.0 * 100.0,
            r.zone_extent.1 * 100.0,
            r.n_symmetry_ops
        );

        Ok(JsGridScanResult {
            entries,
            n_total_grid: n_points,
            n_irreducible: n_points,
            n_symmetry_ops: r.n_symmetry_ops,
            reduction_ratio,
            structures,
            labels,
            message,
        })
    })();
    result.into()
}

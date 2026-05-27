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
    build_interface_manual, build_interface_slab, search_matches_slab, BuildResult, MatchCandidate,
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
/// a 2x2 integer matrix as nested arrays.
#[wasm_bindgen]
pub fn build_hetero_manual(
    substrate: JsCrystal,
    film: JsCrystal,
    substrate_transform: Vec<i32>,
    film_transform: Vec<i32>,
    gap: f64,
    vacuum: f64,
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

        let r = build_interface_manual(&sub, &flm, &st, &ft, gap, vacuum)?;
        Ok(build_result_to_js(r))
    })();
    result.into()
}

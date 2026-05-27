//! WASM bindings for Moiré (twisted-bilayer) construction.
//!
//! These exports mirror the `/api/moire/search` and `/api/moire/build`
//! backend endpoints so the TypeScript caller in `src/lib/api/moire.ts` can use
//! the wasm path as a drop-in replacement when no Python backend is available.
//!
//! Inputs/outputs are JSON strings whose shapes match the request/response
//! models in `src/lib/api/moire.ts` (`MoireLayerInput`, `MoireAngleSearchParams`,
//! `MoireCandidate`, `MoireBuildParams`, `MoireAngleSearchResult`,
//! `MoireBuildResult`).

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::moire::{
    self, CandidateResult, LayerData, MoireBuildParams, MoireSearchParams, Vec2,
};
use crate::wasm_types::{JsCrystal, WasmResult};

// === JSON request/response shapes (match moire.ts) ===

#[derive(Debug, Clone, Deserialize)]
struct JsMoireLayerInput {
    #[serde(default)]
    structure: Option<JsCrystal>,
    #[serde(default)]
    lattice_vectors: Option<Vec<Vec<f64>>>,
    #[serde(default)]
    elements: Option<Vec<String>>,
    #[serde(default)]
    basis_coords: Option<Vec<Vec<f64>>>,
    #[serde(default)]
    celldm: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct JsMoireSearchParams {
    angle_min: f64,
    angle_max: f64,
    angle_step: f64,
    max_index: i32,
    mismatch_threshold: f64,
    max_atoms: i64,
    strain_layer: String,
    apply_strain: bool,
    max_strain_percent: f64,
    deep_search: bool,
    deep_search_range: f64,
    deep_search_step: f64,
    final_mismatch_threshold: f64,
    fix_angle: bool,
    fixed_angle_value: f64,
    max_results: usize,
}

impl Default for JsMoireSearchParams {
    fn default() -> Self {
        let p = MoireSearchParams::default();
        Self {
            angle_min: p.angle_min,
            angle_max: p.angle_max,
            angle_step: p.angle_step,
            max_index: p.max_index,
            mismatch_threshold: p.mismatch_threshold,
            max_atoms: p.max_atoms,
            strain_layer: p.strain_layer,
            apply_strain: p.apply_strain,
            max_strain_percent: p.max_strain_percent,
            deep_search: p.deep_search,
            deep_search_range: p.deep_search_range,
            deep_search_step: p.deep_search_step,
            final_mismatch_threshold: p.final_mismatch_threshold,
            fix_angle: p.fix_angle,
            fixed_angle_value: p.fixed_angle_value,
            max_results: p.max_results,
        }
    }
}

impl From<JsMoireSearchParams> for MoireSearchParams {
    fn from(j: JsMoireSearchParams) -> Self {
        MoireSearchParams {
            angle_min: j.angle_min,
            angle_max: j.angle_max,
            angle_step: j.angle_step,
            max_index: j.max_index,
            mismatch_threshold: j.mismatch_threshold,
            max_atoms: j.max_atoms,
            strain_layer: j.strain_layer,
            apply_strain: j.apply_strain,
            max_strain_percent: j.max_strain_percent,
            deep_search: j.deep_search,
            deep_search_range: j.deep_search_range,
            deep_search_step: j.deep_search_step,
            final_mismatch_threshold: j.final_mismatch_threshold,
            fix_angle: j.fix_angle,
            fixed_angle_value: j.fixed_angle_value,
            max_results: j.max_results,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JsMoireCandidate {
    angle: f64,
    m: i32,
    n: i32,
    p: i32,
    q: i32,
    m2: i32,
    n2: i32,
    p2: i32,
    q2: i32,
    mismatch: f64,
    n_atoms: i64,
    area_ratio: f64,
    #[serde(default)]
    strain_percent: Option<f64>,
    #[serde(default)]
    strain_tensor: Option<Vec<Vec<f64>>>,
}

impl From<&CandidateResult> for JsMoireCandidate {
    fn from(c: &CandidateResult) -> Self {
        JsMoireCandidate {
            angle: c.angle,
            m: c.m,
            n: c.n,
            p: c.p,
            q: c.q,
            m2: c.m2,
            n2: c.n2,
            p2: c.p2,
            q2: c.q2,
            mismatch: c.mismatch,
            n_atoms: c.n_atoms,
            area_ratio: c.area_ratio,
            strain_percent: c.strain_percent,
            strain_tensor: c
                .strain_tensor
                .map(|t| vec![vec![t[0][0], t[0][1]], vec![t[1][0], t[1][1]]]),
        }
    }
}

impl JsMoireCandidate {
    fn to_internal(&self) -> CandidateResult {
        let strain_tensor = self.strain_tensor.as_ref().and_then(|t| {
            if t.len() == 2 && t[0].len() == 2 && t[1].len() == 2 {
                Some([[t[0][0], t[0][1]], [t[1][0], t[1][1]]])
            } else {
                None
            }
        });
        CandidateResult {
            angle: self.angle,
            m: self.m,
            n: self.n,
            p: self.p,
            q: self.q,
            m2: self.m2,
            n2: self.n2,
            p2: self.p2,
            q2: self.q2,
            mismatch: self.mismatch,
            n_atoms: self.n_atoms,
            area_ratio: self.area_ratio,
            strain_percent: self.strain_percent,
            strain_tensor,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct JsMoireBuildParams {
    translate_z: f64,
    vacuum: f64,
    z_a: f64,
}

impl Default for JsMoireBuildParams {
    fn default() -> Self {
        let p = MoireBuildParams::default();
        Self {
            translate_z: p.translate_z,
            vacuum: p.vacuum,
            z_a: p.z_a,
        }
    }
}

#[derive(Debug, Deserialize)]
struct JsSearchRequest {
    layer_a: JsMoireLayerInput,
    #[serde(default)]
    layer_b: Option<JsMoireLayerInput>,
    #[serde(default)]
    params: Option<JsMoireSearchParams>,
}

#[derive(Debug, Deserialize)]
struct JsBuildRequest {
    layer_a: JsMoireLayerInput,
    #[serde(default)]
    layer_b: Option<JsMoireLayerInput>,
    candidate: JsMoireCandidate,
    #[serde(default)]
    params: Option<JsMoireBuildParams>,
}

#[derive(Debug, Serialize)]
struct JsSearchResult {
    candidates: Vec<JsMoireCandidate>,
    n_candidates: usize,
    angle_range: [f64; 2],
    message: String,
}

#[derive(Debug, Serialize)]
struct JsBuildResult {
    structure: JsCrystal,
    n_atoms: usize,
    n_atoms_layer_a: usize,
    n_atoms_layer_b: usize,
    angle: f64,
    supercell_area: f64,
    strain_applied: bool,
    message: String,
}

// === Layer extraction (mirror extract_layer_data) ===

fn vec2_from(v: &[f64]) -> Result<Vec2, String> {
    if v.len() < 2 {
        return Err("Expected at least 2 components in 2D vector".to_string());
    }
    Ok([v[0], v[1]])
}

fn extract_layer(input: &JsMoireLayerInput) -> Result<LayerData, String> {
    if let Some(crystal) = &input.structure {
        let structure = crystal.to_structure()?;
        Ok(moire::extract_layer_from_structure(&structure))
    } else if let Some(lv) = &input.lattice_vectors {
        let elements = input
            .elements
            .clone()
            .ok_or_else(|| "Must provide 'elements' with 'lattice_vectors'".to_string())?;
        let basis = input
            .basis_coords
            .as_ref()
            .ok_or_else(|| "Must provide 'basis_coords' with 'lattice_vectors'".to_string())?;
        if lv.len() != 2 {
            return Err("lattice_vectors must have exactly 2 rows".to_string());
        }
        let lattice_2d = [vec2_from(&lv[0])?, vec2_from(&lv[1])?];
        let basis_coords: Result<Vec<Vec2>, String> =
            basis.iter().map(|b| vec2_from(b)).collect();
        Ok(moire::extract_layer_from_raw(
            lattice_2d,
            elements,
            basis_coords?,
            input.celldm.as_deref(),
        ))
    } else {
        Err("MoireLayerInput must provide either 'structure' or 'lattice_vectors' + 'elements' + 'basis_coords'".to_string())
    }
}

// === WASM exports ===

/// Search for commensurate Moiré twist angles.
///
/// `request_json` is a JSON string matching the `/api/moire/search` request body
/// `{ layer_a, layer_b, params }`. Returns `WasmResult<String>` whose `ok`
/// field is a JSON string matching `MoireAngleSearchResult`.
#[wasm_bindgen]
pub fn moire_search(request_json: &str) -> WasmResult<String> {
    let result: Result<String, String> = (|| {
        let req: JsSearchRequest = serde_json::from_str(request_json)
            .map_err(|e| format!("Invalid Moiré search request JSON: {e}"))?;

        let layer_a = extract_layer(&req.layer_a)?;
        // Homobilayer default: layer_b = layer_a when omitted.
        let layer_b = match &req.layer_b {
            Some(lb) => extract_layer(lb)?,
            None => extract_layer(&req.layer_a)?,
        };

        let js_params = req.params.unwrap_or_default();
        let angle_range = [js_params.angle_min, js_params.angle_max];
        let params: MoireSearchParams = js_params.into();

        let candidates = moire::search_moire(&layer_a, &layer_b, &params);

        let js_candidates: Vec<JsMoireCandidate> =
            candidates.iter().map(JsMoireCandidate::from).collect();
        let n = js_candidates.len();
        let message = format!(
            "Found {n} commensurate angles in [{}°, {}°]",
            angle_range[0], angle_range[1]
        );

        let out = JsSearchResult {
            candidates: js_candidates,
            n_candidates: n,
            angle_range,
            message,
        };
        serde_json::to_string(&out).map_err(|e| e.to_string())
    })();
    result.into()
}

/// Build a Moiré bilayer supercell from a selected candidate.
///
/// `request_json` is a JSON string matching the `/api/moire/build` request body
/// `{ layer_a, layer_b, candidate, params }`. Returns `WasmResult<String>`
/// whose `ok` field is a JSON string matching `MoireBuildResult`.
#[wasm_bindgen]
pub fn build_moire(request_json: &str) -> WasmResult<String> {
    let result: Result<String, String> = (|| {
        let req: JsBuildRequest = serde_json::from_str(request_json)
            .map_err(|e| format!("Invalid Moiré build request JSON: {e}"))?;

        let layer_a = extract_layer(&req.layer_a)?;
        let layer_b = match &req.layer_b {
            Some(lb) => extract_layer(lb)?,
            None => extract_layer(&req.layer_a)?,
        };

        let candidate = req.candidate.to_internal();
        let angle = candidate.angle;
        let params: MoireBuildParams = {
            let jp = req.params.unwrap_or_default();
            MoireBuildParams {
                translate_z: jp.translate_z,
                vacuum: jp.vacuum,
                z_a: jp.z_a,
            }
        };

        let built = moire::build_moire(&layer_a, &layer_b, &candidate, &params)?;
        let n_atoms = built.structure.num_sites();
        let crystal = JsCrystal::from_structure(&built.structure);

        let out = JsBuildResult {
            structure: crystal,
            n_atoms,
            n_atoms_layer_a: built.n_atoms_layer_a,
            n_atoms_layer_b: built.n_atoms_layer_b,
            angle,
            supercell_area: built.supercell_area,
            strain_applied: built.strain_applied,
            message: format!("Built Moiré bilayer with {n_atoms} atoms at θ={angle}°"),
        };
        serde_json::to_string(&out).map_err(|e| e.to_string())
    })();
    result.into()
}

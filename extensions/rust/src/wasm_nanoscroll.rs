//! WASM binding for the nanoscroll builder.
//!
//! Kept in a dedicated module (not `wasm.rs`) to avoid merge conflicts with
//! other in-flight builder ports. Declared in `lib.rs` via
//! `#[cfg(feature = "wasm")] pub mod wasm_nanoscroll;`.

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::nanoscroll::{
    build_nanoscroll as core_build_nanoscroll, NanoscrollParams, RollDir,
    DEFAULT_INTERLAYER_GAP, DEFAULT_STRAIN_WARN_THRESHOLD,
};
use crate::wasm_types::{JsCrystal, WasmResult};

/// Parameters for the nanoscroll builder, deserialized from a JSON string.
///
/// All fields have sensible defaults so callers can supply a partial object.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(from_wasm_abi)]
pub struct JsNanoscrollParams {
    /// Number of windings (turns). Default 6.
    #[serde(default = "default_turns")]
    pub turns: u32,
    /// Inner winding radius (Å). Default 25.
    #[serde(default = "default_inner_radius")]
    pub inner_radius: f64,
    /// Scroll height along z (Å). Default 12.
    #[serde(default = "default_length")]
    pub length: f64,
    /// Roll direction: "a1" or "a2". Default "a1".
    #[serde(default = "default_roll_dir")]
    pub roll_dir: String,
    /// Van-der-Waals interlayer gap (Å). Default 3.3.
    #[serde(default = "default_gap")]
    pub interlayer_gap: f64,
    /// Strain warning threshold (fraction). Default 0.15.
    #[serde(default = "default_strain_threshold")]
    pub strain_warn_threshold: f64,
}

fn default_turns() -> u32 {
    6
}
fn default_inner_radius() -> f64 {
    25.0
}
fn default_length() -> f64 {
    12.0
}
fn default_roll_dir() -> String {
    "a1".to_string()
}
fn default_gap() -> f64 {
    DEFAULT_INTERLAYER_GAP
}
fn default_strain_threshold() -> f64 {
    DEFAULT_STRAIN_WARN_THRESHOLD
}

/// Metadata describing the built nanoscroll, returned alongside the structure.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsNanoscrollInfo {
    /// Number of windings.
    pub turns: u32,
    /// Inner winding radius (Å).
    pub inner_radius: f64,
    /// Outer winding radius (Å).
    pub outer_radius: f64,
    /// Realized scroll length along z (Å).
    pub length: f64,
    /// Monolayer thickness (Å).
    pub monolayer_thickness: f64,
    /// Interlayer gap used (Å).
    pub interlayer_gap: f64,
    /// Spiral arc length (Å).
    pub arc_length: f64,
    /// Supercell tiling [nx, ny].
    pub supercell: [u32; 2],
    /// Number of atoms.
    pub n_atoms: u32,
    /// Maximum local bending strain (fraction).
    pub max_local_strain: f64,
    /// Optional curvature-strain warning.
    pub warning: Option<String>,
}

/// Combined result: the rolled structure plus build metadata.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsNanoscrollResult {
    /// The rolled (non-periodic) structure in pymatgen-compatible form.
    pub structure: JsCrystal,
    /// Build metadata.
    pub info: JsNanoscrollInfo,
}

/// Build a nanoscroll from a monolayer.
///
/// `monolayer` is a single 2D layer (any composition). `params_json` is a JSON
/// object string with optional keys: turns, inner_radius, length, roll_dir,
/// interlayer_gap, strain_warn_threshold.
///
/// Returns the rolled structure plus metadata (turns, inner/outer radius,
/// length, n_atoms, supercell, strain warning).
#[wasm_bindgen]
pub fn build_nanoscroll(
    monolayer: JsCrystal,
    params_json: &str,
) -> WasmResult<JsNanoscrollResult> {
    let result: Result<JsNanoscrollResult, String> = (|| {
        let js_params: JsNanoscrollParams = if params_json.trim().is_empty() {
            serde_json::from_str("{}").unwrap()
        } else {
            serde_json::from_str(params_json)
                .map_err(|e| format!("Invalid params JSON: {e}"))?
        };

        let params = NanoscrollParams {
            turns: js_params.turns,
            inner_radius: js_params.inner_radius,
            length: js_params.length,
            roll_dir: RollDir::parse(&js_params.roll_dir),
            interlayer_gap: js_params.interlayer_gap,
            strain_warn_threshold: js_params.strain_warn_threshold,
        };

        let structure = monolayer.to_structure()?;
        let (scroll, info) =
            core_build_nanoscroll(&structure, &params).map_err(|e| e.to_string())?;

        Ok(JsNanoscrollResult {
            structure: JsCrystal::from_structure(&scroll),
            info: JsNanoscrollInfo {
                turns: info.turns,
                inner_radius: info.inner_radius,
                outer_radius: info.outer_radius,
                length: info.length,
                monolayer_thickness: info.monolayer_thickness,
                interlayer_gap: info.interlayer_gap,
                arc_length: info.arc_length,
                supercell: info.supercell,
                n_atoms: info.n_atoms,
                max_local_strain: info.max_local_strain,
                warning: info.warning,
            },
        })
    })();
    result.into()
}

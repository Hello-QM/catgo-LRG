//! JavaScript bindings.

use wasm_bindgen::prelude::*;

use crate::esp::EspEngine;
use crate::grid::{esp_points, Function, GridSpec};
use crate::Wavefunction;

#[wasm_bindgen(start)]
pub fn wasm_init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct WfnHandle {
    wf: Wavefunction,
    esp: std::cell::OnceCell<EspEngine>,
}

#[wasm_bindgen]
impl WfnHandle {
    /// Parse a .fchk / .molden / .wfn / .wfx file.
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str, filename: &str) -> Result<WfnHandle, JsError> {
        crate::load(text, filename)
            .map(|wf| WfnHandle {
                wf,
                esp: std::cell::OnceCell::new(),
            })
            .map_err(|e| JsError::new(&e))
    }

    /// Summary (atoms, orbitals, frontier orbitals …) as JSON.
    pub fn info_json(&self) -> String {
        serde_json::to_string(&self.wf.info()).unwrap_or_default()
    }

    /// Tr(P S) (+ EDF core electrons): equals the electron count for a sound file.
    pub fn trace_ps(&self) -> f64 {
        self.wf.described_electrons()
    }

    /// Multiwfn-style grid for "low" / "medium" / "high" as JSON (Bohr).
    pub fn grid_json(&self, quality: &str) -> Result<String, JsError> {
        let spec = self.wf.grid(quality).map_err(|e| JsError::new(&e))?;
        Ok(serde_json::to_string(&spec).unwrap_or_default())
    }

    /// Evaluate a grid function on x-slices `ix0..ix1` of the grid given as
    /// JSON. `kind`: orbital | density | gradient | laplacian | sl2r | rdg |
    /// iri_sl2r | igmh_sl2r; `args_json` carries {"orbital": n} or
    /// {"fragments": [[…], […]]} (1-based).
    pub fn evaluate(
        &self,
        kind: &str,
        args_json: &str,
        grid_json: &str,
        ix0: u32,
        ix1: u32,
    ) -> Result<Vec<f64>, JsError> {
        let spec: GridSpec =
            serde_json::from_str(grid_json).map_err(|e| JsError::new(&e.to_string()))?;
        let args: serde_json::Value =
            serde_json::from_str(args_json).map_err(|e| JsError::new(&e.to_string()))?;
        let func =
            Function::parse(kind, &args, self.wf.atoms.len()).map_err(|e| JsError::new(&e))?;
        self.wf
            .evaluate_slab(&func, &spec, ix0 as usize, ix1 as usize)
            .map_err(|e| JsError::new(&e))
    }

    /// Total electrostatic potential (a.u.) at the listed flat grid indices.
    pub fn esp_points(&self, grid_json: &str, indices: Vec<u32>) -> Result<Vec<f64>, JsError> {
        let spec: GridSpec =
            serde_json::from_str(grid_json).map_err(|e| JsError::new(&e.to_string()))?;
        let n = spec.n_points() as u32;
        if indices.iter().any(|&i| i >= n) {
            return Err(JsError::new("grid index out of range"));
        }
        let engine = self.esp.get_or_init(|| EspEngine::new(&self.wf));
        Ok(esp_points(engine, &spec, &indices))
    }

    /// QTAIM critical points, their properties and bond paths as JSON (Å).
    pub fn aim_json(&self) -> String {
        serde_json::to_string(&self.wf.aim()).unwrap_or_default()
    }

    /// Total electrostatic potential (a.u.) at points given as flat x, y, z
    /// triples in Bohr.
    pub fn esp_xyz(&self, xyz: Vec<f64>) -> Vec<f64> {
        let engine = self.esp.get_or_init(|| EspEngine::new(&self.wf));
        let mut s = crate::esp::EspScratch::new();
        xyz.chunks_exact(3)
            .map(|p| engine.total([p[0], p[1], p[2]], &mut s))
            .collect()
    }
}

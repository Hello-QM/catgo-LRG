//! JavaScript bindings.

use wasm_bindgen::prelude::*;

use crate::grid::{Function, GridSpec};
use crate::Wavefunction;

#[wasm_bindgen(start)]
pub fn wasm_init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct WfnHandle {
    wf: Wavefunction,
}

#[wasm_bindgen]
impl WfnHandle {
    /// Parse a .fchk / .molden / .wfn / .wfx file.
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str, filename: &str) -> Result<WfnHandle, JsError> {
        crate::load(text, filename)
            .map(|wf| WfnHandle { wf })
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
    /// iri_sl2r; `orbital` is 1-based and only used for kind = orbital.
    pub fn evaluate(
        &self,
        kind: &str,
        orbital: u32,
        grid_json: &str,
        ix0: u32,
        ix1: u32,
    ) -> Result<Vec<f64>, JsError> {
        let spec: GridSpec =
            serde_json::from_str(grid_json).map_err(|e| JsError::new(&e.to_string()))?;
        let func = Function::parse(kind, (orbital as usize).saturating_sub(1))
            .map_err(|e| JsError::new(&e))?;
        self.wf
            .evaluate_slab(func, &spec, ix0 as usize, ix1 as usize)
            .map_err(|e| JsError::new(&e))
    }
}

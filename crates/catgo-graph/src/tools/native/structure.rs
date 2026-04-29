//! Pymatgen Structure JSON parser and serializer.
//!
//! Provides a lightweight representation of crystal structures compatible
//! with the pymatgen JSON format used throughout CatGO. This module does
//! NOT depend on the `extensions/rust/` WASM crate — it is self-contained
//! within catgo-graph for native tool use.
//!
//! The pymatgen format:
//! ```json
//! {
//!   "@module": "pymatgen.core.structure",
//!   "@class": "Structure",
//!   "lattice": { "matrix": [[a1x,a1y,a1z],[a2x,a2y,a2z],[a3x,a3y,a3z]], "pbc": [true,true,true] },
//!   "sites": [
//!     { "species": [{"element": "Ti", "occu": 1}], "abc": [0,0,0], "xyz": [0,0,0], "label": "Ti", "properties": {} }
//!   ]
//! }
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A crystal structure in pymatgen-compatible JSON format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PymatgenStructure {
    #[serde(rename = "@module", default = "default_module")]
    pub module: String,
    #[serde(rename = "@class", default = "default_class")]
    pub class: String,
    pub lattice: Lattice,
    pub sites: Vec<Site>,
    #[serde(default)]
    pub charge: f64,
    #[serde(default)]
    pub properties: serde_json::Value,
}

fn default_module() -> String {
    "pymatgen.core.structure".into()
}
fn default_class() -> String {
    "Structure".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lattice {
    pub matrix: [[f64; 3]; 3],
    #[serde(default = "default_pbc")]
    pub pbc: [bool; 3],
    // Computed fields (optional in input, always set in output)
    #[serde(default)]
    pub a: f64,
    #[serde(default)]
    pub b: f64,
    #[serde(default)]
    pub c: f64,
    #[serde(default)]
    pub alpha: f64,
    #[serde(default)]
    pub beta: f64,
    #[serde(default)]
    pub gamma: f64,
    #[serde(default)]
    pub volume: f64,
}

fn default_pbc() -> [bool; 3] {
    [true, true, true]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Site {
    pub species: Vec<Species>,
    pub abc: [f64; 3],
    #[serde(default)]
    pub xyz: [f64; 3],
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub properties: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Species {
    pub element: String,
    #[serde(default = "default_occu")]
    pub occu: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oxidation_state: Option<f64>,
}

fn default_occu() -> f64 {
    1.0
}

impl PymatgenStructure {
    /// Parse from a JSON string (either full pymatgen dict or structure_json string).
    pub fn from_json(json_str: &str) -> Result<Self, String> {
        serde_json::from_str(json_str).map_err(|e| format!("Failed to parse structure JSON: {e}"))
    }

    /// Parse from a serde_json::Value.
    pub fn from_value(value: &serde_json::Value) -> Result<Self, String> {
        serde_json::from_value(value.clone())
            .map_err(|e| format!("Failed to parse structure: {e}"))
    }

    /// Serialize to a serde_json::Value with computed lattice parameters.
    pub fn to_value(&self) -> serde_json::Value {
        let mut s = self.clone();
        s.recompute_lattice_params();
        s.recompute_cartesian();
        serde_json::to_value(s).unwrap()
    }

    /// Serialize to a JSON string.
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.to_value()).unwrap()
    }

    /// Get the primary element for a site (first species).
    pub fn element_at(&self, idx: usize) -> &str {
        &self.sites[idx].species[0].element
    }

    /// Count atoms of each element.
    pub fn element_counts(&self) -> HashMap<String, usize> {
        let mut counts = HashMap::new();
        for site in &self.sites {
            let elem = &site.species[0].element;
            *counts.entry(elem.clone()).or_insert(0) += 1;
        }
        counts
    }

    /// Replace the element at a site index.
    pub fn replace_element(&mut self, idx: usize, new_element: &str) {
        if let Some(site) = self.sites.get_mut(idx) {
            site.species = vec![Species {
                element: new_element.to_string(),
                occu: 1.0,
                oxidation_state: None,
            }];
            site.label = new_element.to_string();
        }
    }

    /// Remove a site by index.
    pub fn remove_site(&mut self, idx: usize) {
        if idx < self.sites.len() {
            self.sites.remove(idx);
        }
    }

    /// Append a new site with fractional coordinates.
    pub fn append_site(&mut self, element: &str, abc: [f64; 3]) {
        let xyz = frac_to_cart(&self.lattice.matrix, &abc);
        self.sites.push(Site {
            species: vec![Species {
                element: element.to_string(),
                occu: 1.0,
                oxidation_state: None,
            }],
            abc,
            xyz,
            label: element.to_string(),
            properties: serde_json::json!({}),
        });
    }

    /// Apply a 3x3 deformation matrix to the lattice.
    /// new_lattice = deformation × old_lattice (row-wise).
    pub fn apply_deformation(&mut self, deform: &[[f64; 3]; 3]) {
        let old = self.lattice.matrix;
        let mut new_matrix = [[0.0f64; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                new_matrix[i][j] = deform[i][0] * old[0][j]
                    + deform[i][1] * old[1][j]
                    + deform[i][2] * old[2][j];
            }
        }
        self.lattice.matrix = new_matrix;
        self.recompute_cartesian();
        self.recompute_lattice_params();
    }

    /// Make a supercell by replicating along a, b, c.
    pub fn make_supercell(&mut self, na: usize, nb: usize, nc: usize) {
        let old_sites = self.sites.clone();
        let n_orig = old_sites.len();
        self.sites.clear();

        for ia in 0..na {
            for ib in 0..nb {
                for ic in 0..nc {
                    for (orig_idx, site) in old_sites.iter().enumerate() {
                        let new_abc = [
                            (site.abc[0] + ia as f64) / na as f64,
                            (site.abc[1] + ib as f64) / nb as f64,
                            (site.abc[2] + ic as f64) / nc as f64,
                        ];
                        let mut props = site.properties.clone();
                        if let Some(obj) = props.as_object_mut() {
                            obj.insert(
                                "orig_unit_cell_idx".into(),
                                serde_json::json!(orig_idx % n_orig),
                            );
                        }
                        self.sites.push(Site {
                            species: site.species.clone(),
                            abc: new_abc,
                            xyz: [0.0; 3], // recomputed below
                            label: site.label.clone(),
                            properties: props,
                        });
                    }
                }
            }
        }

        // Scale lattice vectors
        for j in 0..3 {
            self.lattice.matrix[0][j] *= na as f64;
        }
        for j in 0..3 {
            self.lattice.matrix[1][j] *= nb as f64;
        }
        for j in 0..3 {
            self.lattice.matrix[2][j] *= nc as f64;
        }

        self.recompute_cartesian();
        self.recompute_lattice_params();
    }

    /// Recompute xyz from abc + lattice matrix.
    pub fn recompute_cartesian(&mut self) {
        for site in &mut self.sites {
            site.xyz = frac_to_cart(&self.lattice.matrix, &site.abc);
        }
    }

    /// Recompute lattice parameters (a, b, c, alpha, beta, gamma, volume) from matrix.
    pub fn recompute_lattice_params(&mut self) {
        let m = &self.lattice.matrix;
        let a_vec = m[0];
        let b_vec = m[1];
        let c_vec = m[2];

        self.lattice.a = vec_len(&a_vec);
        self.lattice.b = vec_len(&b_vec);
        self.lattice.c = vec_len(&c_vec);

        self.lattice.alpha = vec_angle(&b_vec, &c_vec).to_degrees();
        self.lattice.beta = vec_angle(&a_vec, &c_vec).to_degrees();
        self.lattice.gamma = vec_angle(&a_vec, &b_vec).to_degrees();

        // Volume = a · (b × c)
        let cross = vec_cross(&b_vec, &c_vec);
        self.lattice.volume = vec_dot(&a_vec, &cross).abs();
    }
}

// --- Linear algebra helpers ---

fn frac_to_cart(matrix: &[[f64; 3]; 3], abc: &[f64; 3]) -> [f64; 3] {
    [
        abc[0] * matrix[0][0] + abc[1] * matrix[1][0] + abc[2] * matrix[2][0],
        abc[0] * matrix[0][1] + abc[1] * matrix[1][1] + abc[2] * matrix[2][1],
        abc[0] * matrix[0][2] + abc[1] * matrix[1][2] + abc[2] * matrix[2][2],
    ]
}

fn vec_len(v: &[f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn vec_dot(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn vec_cross(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn vec_angle(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    let cos_angle = vec_dot(a, b) / (vec_len(a) * vec_len(b));
    cos_angle.clamp(-1.0, 1.0).acos()
}

/// Extract structure from tool inputs (handles nested formats).
/// Looks for structure_json in params or parent outputs.
pub fn extract_parent_structure(inputs: &serde_json::Value) -> Result<PymatgenStructure, String> {
    // Try __parent_outputs first
    if let Some(parents) = inputs.get("__parent_outputs").and_then(|v| v.as_object()) {
        for output in parents.values() {
            // Try structure_json field (string or object)
            if let Some(sj) = output.get("structure_json") {
                if let Some(s) = sj.as_str() {
                    if !s.is_empty() {
                        return PymatgenStructure::from_json(s);
                    }
                } else if sj.is_object() {
                    return PymatgenStructure::from_value(sj);
                }
            }
            // Try structure field directly
            if let Some(st) = output.get("structure") {
                if st.is_object() {
                    return PymatgenStructure::from_value(st);
                }
            }
        }
    }

    // Try params.structure_json
    if let Some(params) = inputs.get("params") {
        if let Some(sj) = params.get("structure_json") {
            if let Some(s) = sj.as_str() {
                if !s.is_empty() {
                    return PymatgenStructure::from_json(s);
                }
            } else if sj.is_object() {
                return PymatgenStructure::from_value(sj);
            }
        }
    }

    Err("No structure found in inputs (checked __parent_outputs and params.structure_json)".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tio2() -> PymatgenStructure {
        let json = r#"{
            "@module": "pymatgen.core.structure",
            "@class": "Structure",
            "lattice": {
                "matrix": [[4.6, 0.0, 0.0], [-2.3, 3.984, 0.0], [0.0, 0.0, 2.96]],
                "pbc": [true, true, true]
            },
            "sites": [
                {"species": [{"element": "Ti", "occu": 1}], "abc": [0.0, 0.0, 0.0], "label": "Ti"},
                {"species": [{"element": "O", "occu": 1}], "abc": [0.304, 0.304, 0.0], "label": "O"},
                {"species": [{"element": "O", "occu": 1}], "abc": [0.696, 0.696, 0.0], "label": "O"}
            ]
        }"#;
        PymatgenStructure::from_json(json).unwrap()
    }

    #[test]
    fn test_parse_and_serialize() {
        let s = sample_tio2();
        assert_eq!(s.sites.len(), 3);
        assert_eq!(s.element_at(0), "Ti");
        assert_eq!(s.element_at(1), "O");

        let val = s.to_value();
        assert!(val["lattice"]["volume"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn test_element_counts() {
        let s = sample_tio2();
        let counts = s.element_counts();
        assert_eq!(counts["Ti"], 1);
        assert_eq!(counts["O"], 2);
    }

    #[test]
    fn test_replace_element() {
        let mut s = sample_tio2();
        s.replace_element(0, "Fe");
        assert_eq!(s.element_at(0), "Fe");
        assert_eq!(s.sites[0].label, "Fe");
    }

    #[test]
    fn test_remove_site() {
        let mut s = sample_tio2();
        s.remove_site(0);
        assert_eq!(s.sites.len(), 2);
        assert_eq!(s.element_at(0), "O");
    }

    #[test]
    fn test_append_site() {
        let mut s = sample_tio2();
        s.append_site("Li", [0.5, 0.5, 0.5]);
        assert_eq!(s.sites.len(), 4);
        assert_eq!(s.element_at(3), "Li");
        // xyz should be computed
        assert!(s.sites[3].xyz[0].abs() > 0.0 || s.sites[3].xyz[1].abs() > 0.0);
    }

    #[test]
    fn test_supercell_2x2x1() {
        let mut s = sample_tio2();
        let orig_n = s.sites.len(); // 3
        s.make_supercell(2, 2, 1);
        assert_eq!(s.sites.len(), orig_n * 4);
        // Lattice a should be doubled
        assert!((s.lattice.matrix[0][0] - 9.2).abs() < 1e-10);
    }

    #[test]
    fn test_deformation_uniaxial() {
        let mut s = sample_tio2();
        let orig_a = s.lattice.matrix[0][0];
        // 5% strain along a
        let deform = [[1.05, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        s.apply_deformation(&deform);
        assert!((s.lattice.matrix[0][0] - orig_a * 1.05).abs() < 1e-10);
    }

    #[test]
    fn test_lattice_params() {
        let mut s = sample_tio2();
        s.recompute_lattice_params();
        assert!((s.lattice.a - 4.6).abs() < 1e-10);
        assert!(s.lattice.volume > 0.0);
    }

    #[test]
    fn test_frac_to_cart_identity() {
        let matrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let abc = [0.5, 0.5, 0.5];
        let xyz = frac_to_cart(&matrix, &abc);
        assert!((xyz[0] - 0.5).abs() < 1e-10);
        assert!((xyz[1] - 0.5).abs() < 1e-10);
        assert!((xyz[2] - 0.5).abs() < 1e-10);
    }
}

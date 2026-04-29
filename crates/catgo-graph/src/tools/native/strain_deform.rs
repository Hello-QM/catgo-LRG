//! StrainDeformTool: apply strain/deformation to crystal structures.
//!
//! Supports uniaxial, biaxial, hydrostatic, and shear strain types.
//! Can generate multiple strained structures in a sweep.
//!
//! Input:
//! ```json
//! {
//!   "params": {
//!     "strain_type": "uniaxial",   // uniaxial | biaxial | hydrostatic | shear
//!     "axis": "c",                  // a | b | c (for uniaxial)
//!     "magnitude": 0.05,            // strain fraction (0.05 = 5%)
//!     "n_steps": 1                  // number of steps (1 = single, >1 = sweep)
//!   },
//!   "__parent_outputs": { "<step>": { "structure_json": "..." } }
//! }
//! ```

use async_trait::async_trait;
use serde_json::json;

use crate::core::*;
use crate::graph::run::ToolExecutionResult;
use crate::tools::native::structure::extract_parent_structure;
use crate::tools::traits::{Tool, ToolExecutionContext};

#[derive(Default)]
pub struct StrainDeformTool;

impl StrainDeformTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for StrainDeformTool {
    fn name(&self) -> &str {
        "strain_deform"
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let params = inputs.get("params").cloned().unwrap_or(json!({}));
        let strain_type = params
            .get("strain_type")
            .and_then(|v| v.as_str())
            .unwrap_or("uniaxial");
        let axis = params
            .get("axis")
            .and_then(|v| v.as_str())
            .unwrap_or("c");
        let magnitude = params
            .get("magnitude")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.05);
        let n_steps = params
            .get("n_steps")
            .and_then(|v| v.as_u64())
            .unwrap_or(1) as usize;

        let base_structure =
            extract_parent_structure(&inputs).map_err(|e| StructuredError {
                category: ErrorCategory::Validation,
                code: Some("NO_STRUCTURE".into()),
                message: e,
                retryable: false,
                details: json!({}),
            })?;

        // Generate magnitudes for sweep
        let magnitudes: Vec<f64> = if n_steps <= 1 {
            vec![magnitude]
        } else {
            (0..n_steps)
                .map(|i| {
                    let t = i as f64 / (n_steps - 1) as f64;
                    -magnitude.abs() + 2.0 * magnitude.abs() * t
                })
                .collect()
        };

        let mut structures = Vec::new();
        let mut labels = Vec::new();

        for mag in &magnitudes {
            let mut s = base_structure.clone();
            let deform = build_deformation_matrix(strain_type, axis, *mag)?;
            s.apply_deformation(&deform);

            let pct = mag * 100.0;
            let label = format!("{} {} {:+.1}%", strain_type, axis, pct);
            labels.push(label);
            structures.push(s.to_value());
        }

        // For single structure, also output as structure_json for downstream tools
        let primary_output = if structures.len() == 1 {
            json!({
                "structure_json": structures[0].clone(),
                "structure": structures[0].clone(),
                "structures": structures,
                "labels": labels,
                "count": 1,
            })
        } else {
            json!({
                "structures": structures,
                "labels": labels,
                "count": structures.len(),
            })
        };

        Ok(ToolExecutionResult {
            outputs: primary_output,
            artifacts: vec![],
            logs: vec![format!(
                "Applied {} strain: {} structures generated",
                strain_type,
                magnitudes.len()
            )],
            metadata: Default::default(),
        })
    }
}

fn build_deformation_matrix(
    strain_type: &str,
    axis: &str,
    mag: f64,
) -> Result<[[f64; 3]; 3], StructuredError> {
    let mut m = [[0.0f64; 3]; 3];
    m[0][0] = 1.0;
    m[1][1] = 1.0;
    m[2][2] = 1.0;

    match strain_type {
        "uniaxial" => {
            let idx = match axis {
                "a" => 0,
                "b" => 1,
                _ => 2,
            };
            m[idx][idx] = 1.0 + mag;
        }
        "biaxial" => {
            m[0][0] = 1.0 + mag;
            m[1][1] = 1.0 + mag;
        }
        "hydrostatic" => {
            m[0][0] = 1.0 + mag;
            m[1][1] = 1.0 + mag;
            m[2][2] = 1.0 + mag;
        }
        "shear" => {
            m[0][1] = mag;
        }
        _ => {
            return Err(StructuredError {
                category: ErrorCategory::Validation,
                code: Some("UNKNOWN_STRAIN_TYPE".into()),
                message: format!("Unknown strain type: {strain_type}"),
                retryable: false,
                details: json!({"strain_type": strain_type}),
            });
        }
    }

    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_ctx() -> ToolExecutionContext {
        ToolExecutionContext {
            run_id: "run-001".into(),
            node_id: "strain".into(),
            attempt_index: 0,
            work_dir: "/tmp/test".into(),
        }
    }

    fn cubic_inputs(strain_type: &str, axis: &str, mag: f64, n_steps: u64) -> serde_json::Value {
        json!({
            "params": {"strain_type": strain_type, "axis": axis, "magnitude": mag, "n_steps": n_steps},
            "__parent_outputs": {
                "s": {"structure_json": {
                    "lattice": {"matrix": [[5.0,0.0,0.0],[0.0,5.0,0.0],[0.0,0.0,5.0]]},
                    "sites": [
                        {"species": [{"element": "Si", "occu": 1}], "abc": [0.0,0.0,0.0], "label": "Si"}
                    ]
                }}
            }
        })
    }

    #[tokio::test]
    async fn test_uniaxial_c() {
        let tool = StrainDeformTool::new();
        let result = tool
            .execute(test_ctx(), cubic_inputs("uniaxial", "c", 0.05, 1))
            .await
            .unwrap();

        let s = &result.outputs["structure"];
        let c_vec = &s["lattice"]["matrix"][2];
        // c should be 5.0 * 1.05 = 5.25
        assert!((c_vec[2].as_f64().unwrap() - 5.25).abs() < 1e-10);
        // a should be unchanged
        assert!((s["lattice"]["matrix"][0][0].as_f64().unwrap() - 5.0).abs() < 1e-10);
    }

    #[tokio::test]
    async fn test_hydrostatic() {
        let tool = StrainDeformTool::new();
        let result = tool
            .execute(test_ctx(), cubic_inputs("hydrostatic", "", 0.1, 1))
            .await
            .unwrap();

        let s = &result.outputs["structure"];
        assert!((s["lattice"]["matrix"][0][0].as_f64().unwrap() - 5.5).abs() < 1e-10);
        assert!((s["lattice"]["matrix"][1][1].as_f64().unwrap() - 5.5).abs() < 1e-10);
        assert!((s["lattice"]["matrix"][2][2].as_f64().unwrap() - 5.5).abs() < 1e-10);
    }

    #[tokio::test]
    async fn test_sweep_5_steps() {
        let tool = StrainDeformTool::new();
        let result = tool
            .execute(test_ctx(), cubic_inputs("uniaxial", "a", 0.05, 5))
            .await
            .unwrap();

        assert_eq!(result.outputs["count"], 5);
        let labels = result.outputs["labels"].as_array().unwrap();
        assert_eq!(labels.len(), 5);
    }

    #[tokio::test]
    async fn test_unknown_type() {
        let tool = StrainDeformTool::new();
        let err = tool
            .execute(test_ctx(), cubic_inputs("zigzag", "", 0.05, 1))
            .await
            .unwrap_err();
        assert_eq!(err.code, Some("UNKNOWN_STRAIN_TYPE".into()));
    }
}

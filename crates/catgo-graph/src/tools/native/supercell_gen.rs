//! SupercellGenTool: generate supercells by lattice replication.
//!
//! Input:
//! ```json
//! {
//!   "params": { "scaling": "2 2 1" | [2,2,1] },
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
pub struct SupercellGenTool;

impl SupercellGenTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for SupercellGenTool {
    fn name(&self) -> &str {
        "supercell_gen"
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let params = inputs.get("params").cloned().unwrap_or(json!({}));

        let (na, nb, nc) = parse_scaling(&params)?;

        let mut structure =
            extract_parent_structure(&inputs).map_err(|e| StructuredError {
                category: ErrorCategory::Validation,
                code: Some("NO_STRUCTURE".into()),
                message: e,
                retryable: false,
                details: json!({}),
            })?;

        let orig_atoms = structure.sites.len();
        structure.make_supercell(na, nb, nc);
        let new_atoms = structure.sites.len();

        let result_value = structure.to_value();
        let result_json = structure.to_json();
        let label = format!("Supercell {}×{}×{}", na, nb, nc);

        Ok(ToolExecutionResult {
            outputs: json!({
                "structure_json": result_json,
                "structure": result_value,
                "label": label,
                "original_atoms": orig_atoms,
                "supercell_atoms": new_atoms,
            }),
            artifacts: vec![],
            logs: vec![format!(
                "{}: {} → {} atoms",
                label, orig_atoms, new_atoms
            )],
            metadata: Default::default(),
        })
    }
}

/// Parse scaling from params. Accepts:
/// - "2 2 1" (space-separated string)
/// - [2, 2, 1] (array)
/// - {"na": 2, "nb": 2, "nc": 1} (object)
fn parse_scaling(params: &serde_json::Value) -> Result<(usize, usize, usize), StructuredError> {
    let scaling = params.get("scaling");

    if let Some(s) = scaling.and_then(|v| v.as_str()) {
        let parts: Vec<usize> = s
            .split_whitespace()
            .filter_map(|p| p.parse().ok())
            .collect();
        if parts.len() >= 3 {
            return Ok((parts[0].max(1), parts[1].max(1), parts[2].max(1)));
        }
        // Try comma-separated
        let parts: Vec<usize> = s.split(',').filter_map(|p| p.trim().parse().ok()).collect();
        if parts.len() >= 3 {
            return Ok((parts[0].max(1), parts[1].max(1), parts[2].max(1)));
        }
    }

    if let Some(arr) = scaling.and_then(|v| v.as_array()) {
        if arr.len() >= 3 {
            let na = arr[0].as_u64().unwrap_or(1) as usize;
            let nb = arr[1].as_u64().unwrap_or(1) as usize;
            let nc = arr[2].as_u64().unwrap_or(1) as usize;
            return Ok((na.max(1), nb.max(1), nc.max(1)));
        }
    }

    // Try individual params
    let na = params
        .get("na")
        .and_then(|v| v.as_u64())
        .unwrap_or(2) as usize;
    let nb = params
        .get("nb")
        .and_then(|v| v.as_u64())
        .unwrap_or(2) as usize;
    let nc = params
        .get("nc")
        .and_then(|v| v.as_u64())
        .unwrap_or(1) as usize;

    Ok((na.max(1), nb.max(1), nc.max(1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_ctx() -> ToolExecutionContext {
        ToolExecutionContext {
            run_id: "run-001".into(),
            node_id: "supercell".into(),
            attempt_index: 0,
            work_dir: "/tmp/test".into(),
        }
    }

    fn si_inputs(scaling: serde_json::Value) -> serde_json::Value {
        json!({
            "params": {"scaling": scaling},
            "__parent_outputs": {
                "s": {"structure_json": {
                    "lattice": {"matrix": [[5.43,0.0,0.0],[0.0,5.43,0.0],[0.0,0.0,5.43]]},
                    "sites": [
                        {"species": [{"element": "Si", "occu": 1}], "abc": [0.0,0.0,0.0], "label": "Si"},
                        {"species": [{"element": "Si", "occu": 1}], "abc": [0.25,0.25,0.25], "label": "Si"}
                    ]
                }}
            }
        })
    }

    #[tokio::test]
    async fn test_2x2x2_supercell() {
        let tool = SupercellGenTool::new();
        let result = tool.execute(test_ctx(), si_inputs(json!("2 2 2"))).await.unwrap();
        assert_eq!(result.outputs["supercell_atoms"], 16); // 2 * 2*2*2
        assert_eq!(result.outputs["original_atoms"], 2);
    }

    #[tokio::test]
    async fn test_array_scaling() {
        let tool = SupercellGenTool::new();
        let result = tool.execute(test_ctx(), si_inputs(json!([3, 1, 1]))).await.unwrap();
        assert_eq!(result.outputs["supercell_atoms"], 6); // 2 * 3
    }

    #[tokio::test]
    async fn test_default_scaling() {
        let tool = SupercellGenTool::new();
        // No scaling param → defaults to 2x2x1
        let inputs = json!({
            "params": {},
            "__parent_outputs": {
                "s": {"structure_json": {
                    "lattice": {"matrix": [[5.0,0.0,0.0],[0.0,5.0,0.0],[0.0,0.0,5.0]]},
                    "sites": [{"species": [{"element": "Si", "occu": 1}], "abc": [0.0,0.0,0.0], "label": "Si"}]
                }}
            }
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["supercell_atoms"], 4); // 1 * 2*2*1
    }

    #[tokio::test]
    async fn test_lattice_scaled() {
        let tool = SupercellGenTool::new();
        let result = tool.execute(test_ctx(), si_inputs(json!("2 1 1"))).await.unwrap();
        let s_json = result.outputs["structure_json"].as_str().unwrap();
        let s = super::super::structure::PymatgenStructure::from_json(s_json).unwrap();
        // a should be doubled
        assert!((s.lattice.matrix[0][0] - 10.86).abs() < 1e-10);
        // b unchanged
        assert!((s.lattice.matrix[1][1] - 5.43).abs() < 1e-10);
    }
}

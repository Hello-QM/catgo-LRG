//! DopingGenTool: generate doped crystal structures by element substitution.
//!
//! Replaces target atoms with dopant atoms. Auto-detects the host element
//! (most abundant non-ligand element) when target_element is not specified.
//!
//! Input:
//! ```json
//! {
//!   "params": { "dopant": "Fe", "target_element": "", "count": 1 },
//!   "__parent_outputs": { "<step>": { "structure_json": "..." } }
//! }
//! ```

use async_trait::async_trait;
use serde_json::json;

use crate::core::*;
use crate::graph::run::ToolExecutionResult;
use crate::tools::native::structure::extract_parent_structure;
use crate::tools::traits::{Tool, ToolExecutionContext};

const LIGAND_ELEMENTS: &[&str] = &["O", "H", "N", "F", "Cl"];

#[derive(Default)]
pub struct DopingGenTool;

impl DopingGenTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for DopingGenTool {
    fn name(&self) -> &str {
        "doping_gen"
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let params = inputs.get("params").cloned().unwrap_or(json!({}));
        let dopant = params
            .get("dopant")
            .and_then(|v| v.as_str())
            .unwrap_or("Fe");
        let target_element = params
            .get("target_element")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let count = params
            .get("count")
            .and_then(|v| v.as_u64())
            .unwrap_or(1) as usize;

        let mut structure = extract_parent_structure(&inputs).map_err(|e| StructuredError {
            category: ErrorCategory::Validation,
            code: Some("NO_STRUCTURE".into()),
            message: e,
            retryable: false,
            details: json!({}),
        })?;

        // Determine target element
        let target = if target_element.is_empty() {
            auto_detect_host(&structure)
        } else {
            target_element
        };

        // Find target site indices
        let host_indices: Vec<usize> = structure
            .sites
            .iter()
            .enumerate()
            .filter(|(_, site)| site.species[0].element == target)
            .map(|(i, _)| i)
            .collect();

        if host_indices.is_empty() {
            return Err(StructuredError {
                category: ErrorCategory::Validation,
                code: Some("NO_TARGET_ATOMS".into()),
                message: format!("No {target} atoms found in structure for doping"),
                retryable: false,
                details: json!({"target": target, "available": structure.element_counts()}),
            });
        }

        let actual_count = count.min(host_indices.len());
        for &idx in &host_indices[..actual_count] {
            structure.replace_element(idx, dopant);
        }

        let result_value = structure.to_value();
        let result_json = structure.to_json();
        let note = format!("Doped: {}x {}->{}", actual_count, target, dopant);

        Ok(ToolExecutionResult {
            outputs: json!({
                "structure_json": result_json,
                "structure": result_value,
                "note": note,
            }),
            artifacts: vec![],
            logs: vec![note],
            metadata: Default::default(),
        })
    }
}

fn auto_detect_host(structure: &super::structure::PymatgenStructure) -> String {
    let counts = structure.element_counts();
    // Filter out ligand atoms
    let non_ligand: Vec<_> = counts
        .iter()
        .filter(|(e, _)| !LIGAND_ELEMENTS.contains(&e.as_str()))
        .collect();

    if let Some((elem, _)) = non_ligand.iter().max_by_key(|(_, c)| *c) {
        elem.to_string()
    } else {
        // Fallback: most common element overall
        counts
            .iter()
            .max_by_key(|(_, c)| *c)
            .map(|(e, _)| e.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_ctx() -> ToolExecutionContext {
        ToolExecutionContext {
            run_id: "run-001".into(),
            node_id: "doping".into(),
            attempt_index: 0,
            work_dir: "/tmp/test".into(),
        }
    }

    fn tio2_inputs(dopant: &str, target: &str, count: u64) -> serde_json::Value {
        json!({
            "params": {"dopant": dopant, "target_element": target, "count": count},
            "__parent_outputs": {
                "struct_step": {
                    "structure_json": {
                        "@module": "pymatgen.core.structure",
                        "@class": "Structure",
                        "lattice": {"matrix": [[4.6,0.0,0.0],[-2.3,3.984,0.0],[0.0,0.0,2.96]]},
                        "sites": [
                            {"species": [{"element": "Ti", "occu": 1}], "abc": [0.0,0.0,0.0], "label": "Ti"},
                            {"species": [{"element": "Ti", "occu": 1}], "abc": [0.5,0.5,0.0], "label": "Ti"},
                            {"species": [{"element": "O", "occu": 1}], "abc": [0.3,0.3,0.0], "label": "O"},
                            {"species": [{"element": "O", "occu": 1}], "abc": [0.7,0.7,0.0], "label": "O"}
                        ]
                    }
                }
            }
        })
    }

    #[tokio::test]
    async fn test_doping_explicit_target() {
        let tool = DopingGenTool::new();
        let result = tool.execute(test_ctx(), tio2_inputs("Fe", "Ti", 1)).await.unwrap();

        assert!(result.outputs["note"].as_str().unwrap().contains("Ti->Fe"));
        // Parse the result structure
        let s_json = result.outputs["structure_json"].as_str().unwrap();
        let s = super::super::structure::PymatgenStructure::from_json(s_json).unwrap();
        // One Ti should be replaced with Fe
        let counts = s.element_counts();
        assert_eq!(counts.get("Fe"), Some(&1));
        assert_eq!(counts.get("Ti"), Some(&1));
    }

    #[tokio::test]
    async fn test_doping_auto_detect() {
        let tool = DopingGenTool::new();
        let result = tool.execute(test_ctx(), tio2_inputs("Mn", "", 1)).await.unwrap();
        // Should auto-detect Ti (most abundant non-ligand)
        assert!(result.outputs["note"].as_str().unwrap().contains("Ti->Mn"));
    }

    #[tokio::test]
    async fn test_doping_count_2() {
        let tool = DopingGenTool::new();
        let result = tool.execute(test_ctx(), tio2_inputs("Fe", "Ti", 2)).await.unwrap();
        let s_json = result.outputs["structure_json"].as_str().unwrap();
        let s = super::super::structure::PymatgenStructure::from_json(s_json).unwrap();
        assert_eq!(s.element_counts().get("Fe"), Some(&2));
        assert_eq!(s.element_counts().get("Ti"), None); // Both Ti replaced
    }

    #[tokio::test]
    async fn test_doping_no_structure() {
        let tool = DopingGenTool::new();
        let inputs = json!({"params": {"dopant": "Fe"}});
        let err = tool.execute(test_ctx(), inputs).await.unwrap_err();
        assert_eq!(err.code, Some("NO_STRUCTURE".into()));
    }
}

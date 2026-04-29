//! DefectGenTool: generate point defects in crystal structures.
//!
//! Supports three defect types:
//! - **vacancy**: Remove an atom at a specified site
//! - **substitution**: Replace an atom with a different element
//! - **interstitial**: Insert a new atom near a specified site
//!
//! Input:
//! ```json
//! {
//!   "params": {
//!     "defect_type": "vacancy",         // vacancy | substitution | interstitial
//!     "site_index": 0,                   // atom index (-1 for all unique sites)
//!     "substitute_element": "Fe",        // for substitution/interstitial
//!     "supercell": "2 2 2"              // optional: make supercell first
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
pub struct DefectGenTool;

impl DefectGenTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for DefectGenTool {
    fn name(&self) -> &str {
        "defect_gen"
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let params = inputs.get("params").cloned().unwrap_or(json!({}));
        let defect_type = params
            .get("defect_type")
            .and_then(|v| v.as_str())
            .unwrap_or("vacancy");
        let site_index = params
            .get("site_index")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let substitute_element = params
            .get("substitute_element")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let mut structure =
            extract_parent_structure(&inputs).map_err(|e| StructuredError {
                category: ErrorCategory::Validation,
                code: Some("NO_STRUCTURE".into()),
                message: e,
                retryable: false,
                details: json!({}),
            })?;

        // Optionally make supercell first
        if let Some(sc) = params.get("supercell").and_then(|v| v.as_str()) {
            let parts: Vec<usize> = sc
                .split_whitespace()
                .filter_map(|p| p.parse().ok())
                .collect();
            if parts.len() >= 3 && parts.iter().any(|&p| p > 1) {
                structure.make_supercell(parts[0].max(1), parts[1].max(1), parts[2].max(1));
            }
        }

        let n_sites = structure.sites.len();

        let mut results: Vec<serde_json::Value> = Vec::new();
        let mut labels: Vec<String> = Vec::new();

        match defect_type {
            "vacancy" => {
                if site_index == -1 {
                    // Generate vacancy at each unique element type
                    let mut seen_elements = std::collections::HashSet::new();
                    for i in 0..n_sites {
                        let elem = structure.element_at(i).to_string();
                        if seen_elements.insert(elem.clone()) {
                            let mut s = structure.clone();
                            s.remove_site(i);
                            labels.push(format!("Vacancy: {} site {}", elem, i));
                            results.push(s.to_value());
                        }
                    }
                } else {
                    let idx = site_index as usize;
                    if idx >= n_sites {
                        return Err(StructuredError {
                            category: ErrorCategory::Validation,
                            code: Some("INVALID_SITE_INDEX".into()),
                            message: format!(
                                "site_index {} out of range (0..{})",
                                idx, n_sites
                            ),
                            retryable: false,
                            details: json!({"site_index": idx, "n_sites": n_sites}),
                        });
                    }
                    let elem = structure.element_at(idx).to_string();
                    let mut s = structure.clone();
                    s.remove_site(idx);
                    labels.push(format!("Vacancy: {} site {}", elem, idx));
                    results.push(s.to_value());
                }
            }
            "substitution" => {
                if substitute_element.is_empty() {
                    return Err(StructuredError {
                        category: ErrorCategory::Validation,
                        code: Some("MISSING_SUBSTITUTE".into()),
                        message: "substitute_element required for substitution defect".into(),
                        retryable: false,
                        details: json!({}),
                    });
                }
                let idx = site_index.max(0) as usize;
                if idx >= n_sites {
                    return Err(StructuredError {
                        category: ErrorCategory::Validation,
                        code: Some("INVALID_SITE_INDEX".into()),
                        message: format!("site_index {} out of range", idx),
                        retryable: false,
                        details: json!({}),
                    });
                }
                let orig_elem = structure.element_at(idx).to_string();
                let mut s = structure.clone();
                s.replace_element(idx, substitute_element);
                labels.push(format!(
                    "Substitution: {}→{} at site {}",
                    orig_elem, substitute_element, idx
                ));
                results.push(s.to_value());
            }
            "interstitial" => {
                let idx = site_index.max(0) as usize;
                if idx >= n_sites {
                    return Err(StructuredError {
                        category: ErrorCategory::Validation,
                        code: Some("INVALID_SITE_INDEX".into()),
                        message: format!("site_index {} out of range", idx),
                        retryable: false,
                        details: json!({}),
                    });
                }
                let element = if substitute_element.is_empty() {
                    structure.element_at(idx).to_string()
                } else {
                    substitute_element.to_string()
                };
                let ref_abc = structure.sites[idx].abc;
                // Place interstitial at offset from reference site
                let new_abc = [
                    (ref_abc[0] + 0.5) % 1.0,
                    (ref_abc[1] + 0.5) % 1.0,
                    (ref_abc[2] + 0.5) % 1.0,
                ];
                let mut s = structure.clone();
                s.append_site(&element, new_abc);
                labels.push(format!("Interstitial: {} near site {}", element, idx));
                results.push(s.to_value());
            }
            _ => {
                return Err(StructuredError {
                    category: ErrorCategory::Validation,
                    code: Some("UNKNOWN_DEFECT_TYPE".into()),
                    message: format!("Unknown defect type: {defect_type}"),
                    retryable: false,
                    details: json!({"defect_type": defect_type}),
                });
            }
        }

        // Output: for single defect, include structure_json; for multiple, array
        let outputs = if results.len() == 1 {
            let s_json = serde_json::to_string(&results[0]).unwrap();
            json!({
                "structure_json": s_json,
                "structure": results[0],
                "label": labels[0],
                "structures": results,
                "labels": labels,
                "count": 1,
            })
        } else {
            json!({
                "structures": results,
                "labels": labels,
                "count": results.len(),
            })
        };

        Ok(ToolExecutionResult {
            outputs,
            artifacts: vec![],
            logs: labels,
            metadata: Default::default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_ctx() -> ToolExecutionContext {
        ToolExecutionContext {
            run_id: "run-001".into(),
            node_id: "defect".into(),
            attempt_index: 0,
            work_dir: "/tmp/test".into(),
        }
    }

    fn nacl_inputs(defect_type: &str, site_index: i64, sub_elem: &str) -> serde_json::Value {
        json!({
            "params": {
                "defect_type": defect_type,
                "site_index": site_index,
                "substitute_element": sub_elem,
            },
            "__parent_outputs": {
                "s": {"structure_json": {
                    "lattice": {"matrix": [[5.64,0.0,0.0],[0.0,5.64,0.0],[0.0,0.0,5.64]]},
                    "sites": [
                        {"species": [{"element": "Na", "occu": 1}], "abc": [0.0,0.0,0.0], "label": "Na"},
                        {"species": [{"element": "Na", "occu": 1}], "abc": [0.5,0.5,0.0], "label": "Na"},
                        {"species": [{"element": "Cl", "occu": 1}], "abc": [0.5,0.0,0.0], "label": "Cl"},
                        {"species": [{"element": "Cl", "occu": 1}], "abc": [0.0,0.5,0.0], "label": "Cl"}
                    ]
                }}
            }
        })
    }

    #[tokio::test]
    async fn test_vacancy_single() {
        let tool = DefectGenTool::new();
        let result = tool
            .execute(test_ctx(), nacl_inputs("vacancy", 0, ""))
            .await
            .unwrap();
        assert_eq!(result.outputs["count"], 1);
        assert!(result.outputs["label"]
            .as_str()
            .unwrap()
            .contains("Vacancy: Na"));
        // Should have 3 atoms (removed 1 Na)
        let s_json = result.outputs["structure_json"].as_str().unwrap();
        let s = super::super::structure::PymatgenStructure::from_json(s_json).unwrap();
        assert_eq!(s.sites.len(), 3);
    }

    #[tokio::test]
    async fn test_vacancy_all_unique() {
        let tool = DefectGenTool::new();
        let result = tool
            .execute(test_ctx(), nacl_inputs("vacancy", -1, ""))
            .await
            .unwrap();
        // Should generate one vacancy per unique element (Na, Cl)
        assert_eq!(result.outputs["count"], 2);
    }

    #[tokio::test]
    async fn test_substitution() {
        let tool = DefectGenTool::new();
        let result = tool
            .execute(test_ctx(), nacl_inputs("substitution", 0, "K"))
            .await
            .unwrap();
        assert!(result.outputs["label"]
            .as_str()
            .unwrap()
            .contains("Na→K"));
        let s_json = result.outputs["structure_json"].as_str().unwrap();
        let s = super::super::structure::PymatgenStructure::from_json(s_json).unwrap();
        assert_eq!(s.element_at(0), "K");
        assert_eq!(s.sites.len(), 4); // No atoms removed
    }

    #[tokio::test]
    async fn test_interstitial() {
        let tool = DefectGenTool::new();
        let result = tool
            .execute(test_ctx(), nacl_inputs("interstitial", 0, "Li"))
            .await
            .unwrap();
        assert!(result.outputs["label"]
            .as_str()
            .unwrap()
            .contains("Interstitial: Li"));
        let s_json = result.outputs["structure_json"].as_str().unwrap();
        let s = super::super::structure::PymatgenStructure::from_json(s_json).unwrap();
        assert_eq!(s.sites.len(), 5); // Added 1 atom
    }

    #[tokio::test]
    async fn test_invalid_site_index() {
        let tool = DefectGenTool::new();
        let err = tool
            .execute(test_ctx(), nacl_inputs("vacancy", 99, ""))
            .await
            .unwrap_err();
        assert_eq!(err.code, Some("INVALID_SITE_INDEX".into()));
    }

    #[tokio::test]
    async fn test_substitution_missing_element() {
        let tool = DefectGenTool::new();
        let err = tool
            .execute(test_ctx(), nacl_inputs("substitution", 0, ""))
            .await
            .unwrap_err();
        assert_eq!(err.code, Some("MISSING_SUBSTITUTE".into()));
    }

    #[tokio::test]
    async fn test_unknown_defect_type() {
        let tool = DefectGenTool::new();
        let err = tool
            .execute(test_ctx(), nacl_inputs("frenkel", 0, ""))
            .await
            .unwrap_err();
        assert_eq!(err.code, Some("UNKNOWN_DEFECT_TYPE".into()));
    }
}

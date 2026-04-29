//! EnergyCompareTool: compares energies from multiple parent calculations.
//!
//! Collects energy values from parent step outputs, sorts by energy,
//! computes relative energies against a reference, and reports the ranking.
//!
//! Input format (from resolved inputs):
//! ```json
//! {
//!   "params": {
//!     "reference": "lowest" | "<step_id>"   // optional, default "lowest"
//!   },
//!   "__parent_outputs": {
//!     "<step_id>": { "summary": { "energy": -123.45, "n_atoms": 8 } },
//!     ...
//!   }
//! }
//! ```
//!
//! Output format:
//! ```json
//! {
//!   "analysis_type": "energy_compare",
//!   "status": "completed" | "no_energies",
//!   "reference_energy_eV": -123.45,
//!   "entries": [
//!     { "step_id": "...", "energy_eV": ..., "n_atoms": ..., "relative_eV": 0.0 },
//!     ...
//!   ],
//!   "lowest_step": "step_id",
//!   "spread_eV": 0.123
//! }
//! ```

use async_trait::async_trait;
use serde_json::json;

use crate::core::*;
use crate::graph::run::ToolExecutionResult;
use crate::tools::traits::{Tool, ToolExecutionContext};

#[derive(Default)]
pub struct EnergyCompareTool;

impl EnergyCompareTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for EnergyCompareTool {
    fn name(&self) -> &str {
        "energy_compare"
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let params = inputs.get("params").cloned().unwrap_or(json!({}));
        let parent_outputs = inputs
            .get("__parent_outputs")
            .cloned()
            .unwrap_or(json!({}));
        let reference = params
            .get("reference")
            .and_then(|v| v.as_str())
            .unwrap_or("lowest");

        // Collect entries with energy values from parent outputs
        let mut entries: Vec<serde_json::Value> = Vec::new();
        if let Some(parents) = parent_outputs.as_object() {
            for (step_id, output) in parents {
                let summary = output.get("summary").unwrap_or(output);
                if let Some(energy) = summary.get("energy").and_then(|e| e.as_f64()) {
                    let n_atoms = summary
                        .get("n_atoms")
                        .and_then(|n| n.as_u64())
                        .unwrap_or(0);
                    entries.push(json!({
                        "step_id": step_id,
                        "energy_eV": energy,
                        "n_atoms": n_atoms,
                    }));
                }
            }
        }

        if entries.is_empty() {
            return Ok(ToolExecutionResult {
                outputs: json!({
                    "analysis_type": "energy_compare",
                    "status": "no_energies",
                }),
                artifacts: vec![],
                logs: vec!["No parent steps with energy values found".into()],
                metadata: Default::default(),
            });
        }

        // Sort by energy (ascending)
        entries.sort_by(|a, b| {
            let ea = a["energy_eV"].as_f64().unwrap_or(f64::MAX);
            let eb = b["energy_eV"].as_f64().unwrap_or(f64::MAX);
            ea.partial_cmp(&eb).unwrap_or(std::cmp::Ordering::Equal)
        });

        // Determine reference energy
        let ref_energy = if reference == "lowest" {
            entries[0]["energy_eV"].as_f64().unwrap()
        } else {
            // Find specific reference step
            entries
                .iter()
                .find(|e| e["step_id"].as_str() == Some(reference))
                .and_then(|e| e["energy_eV"].as_f64())
                .unwrap_or_else(|| entries[0]["energy_eV"].as_f64().unwrap())
        };

        // Compute relative energies
        for entry in &mut entries {
            let energy = entry["energy_eV"].as_f64().unwrap();
            entry
                .as_object_mut()
                .unwrap()
                .insert("relative_eV".into(), json!(energy - ref_energy));
        }

        let lowest_step = entries[0]["step_id"].as_str().unwrap_or("").to_string();
        let max_energy = entries.last().unwrap()["energy_eV"].as_f64().unwrap();
        let min_energy = entries[0]["energy_eV"].as_f64().unwrap();
        let spread = max_energy - min_energy;

        let outputs = json!({
            "analysis_type": "energy_compare",
            "status": "completed",
            "reference_energy_eV": ref_energy,
            "entries": entries,
            "lowest_step": lowest_step,
            "spread_eV": spread,
        });

        Ok(ToolExecutionResult {
            outputs,
            artifacts: vec![],
            logs: vec![format!(
                "Compared {} energies, spread={:.6} eV",
                entries.len(),
                spread
            )],
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
            node_id: "energy-cmp".into(),
            attempt_index: 0,
            work_dir: "/tmp/test".into(),
        }
    }

    #[tokio::test]
    async fn test_basic_comparison() {
        let tool = EnergyCompareTool::new();
        let inputs = json!({
            "params": {},
            "__parent_outputs": {
                "step_a": {"summary": {"energy": -100.5, "n_atoms": 8}},
                "step_b": {"summary": {"energy": -100.2, "n_atoms": 8}},
                "step_c": {"summary": {"energy": -100.8, "n_atoms": 8}},
            }
        });

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["status"], "completed");
        assert_eq!(result.outputs["lowest_step"], "step_c");
        assert_eq!(result.outputs["reference_energy_eV"], -100.8);

        let entries = result.outputs["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 3);
        // First entry (lowest) should have relative_eV = 0
        assert!((entries[0]["relative_eV"].as_f64().unwrap()).abs() < 1e-10);
    }

    #[tokio::test]
    async fn test_specific_reference() {
        let tool = EnergyCompareTool::new();
        let inputs = json!({
            "params": {"reference": "step_b"},
            "__parent_outputs": {
                "step_a": {"summary": {"energy": -100.0}},
                "step_b": {"summary": {"energy": -99.0}},
            }
        });

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["reference_energy_eV"], -99.0);

        let entries = result.outputs["entries"].as_array().unwrap();
        // step_a relative to step_b: -100 - (-99) = -1.0
        let step_a_entry = entries.iter().find(|e| e["step_id"] == "step_a").unwrap();
        assert!((step_a_entry["relative_eV"].as_f64().unwrap() - (-1.0)).abs() < 1e-10);
    }

    #[tokio::test]
    async fn test_no_energies() {
        let tool = EnergyCompareTool::new();
        let inputs = json!({
            "params": {},
            "__parent_outputs": {
                "step_a": {"summary": {"converged": true}},
            }
        });

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["status"], "no_energies");
    }

    #[tokio::test]
    async fn test_single_entry() {
        let tool = EnergyCompareTool::new();
        let inputs = json!({
            "params": {},
            "__parent_outputs": {
                "step_a": {"summary": {"energy": -42.0, "n_atoms": 4}},
            }
        });

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["spread_eV"], 0.0);
        assert_eq!(result.outputs["lowest_step"], "step_a");
    }

    #[tokio::test]
    async fn test_empty_parents() {
        let tool = EnergyCompareTool::new();
        let inputs = json!({"params": {}});

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["status"], "no_energies");
    }
}

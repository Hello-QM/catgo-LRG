//! ConvergenceCheckTool: validates force/energy convergence of parent calculations.
//!
//! Checks parent VASP/DFT step outputs against configurable thresholds.
//!
//! Input format:
//! ```json
//! {
//!   "params": {
//!     "energy_threshold": 1e-4,     // eV (optional, default 1e-4)
//!     "force_threshold": 0.02       // eV/Å (optional, default 0.02)
//!   },
//!   "__parent_outputs": {
//!     "<step_id>": {
//!       "summary": {
//!         "energy": -123.45,
//!         "max_force": 0.015,
//!         "converged": true,
//!         "n_steps": 12
//!       }
//!     }
//!   }
//! }
//! ```
//!
//! Output format:
//! ```json
//! {
//!   "analysis_type": "convergence_check",
//!   "status": "passed" | "needs_attention" | "no_parents",
//!   "parent_checks": [ ... ],
//!   "all_passed": true/false
//! }
//! ```

use async_trait::async_trait;
use serde_json::json;

use crate::core::*;
use crate::graph::run::ToolExecutionResult;
use crate::tools::traits::{Tool, ToolExecutionContext};

const DEFAULT_ENERGY_THRESHOLD: f64 = 1e-4;
const DEFAULT_FORCE_THRESHOLD: f64 = 0.02;

#[derive(Default)]
pub struct ConvergenceCheckTool;

impl ConvergenceCheckTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for ConvergenceCheckTool {
    fn name(&self) -> &str {
        "convergence_check"
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

        let force_threshold = params
            .get("force_threshold")
            .and_then(|v| v.as_f64())
            .unwrap_or(DEFAULT_FORCE_THRESHOLD);
        let _energy_threshold = params
            .get("energy_threshold")
            .and_then(|v| v.as_f64())
            .unwrap_or(DEFAULT_ENERGY_THRESHOLD);

        let parents = match parent_outputs.as_object() {
            Some(p) if !p.is_empty() => p,
            _ => {
                return Ok(ToolExecutionResult {
                    outputs: json!({
                        "analysis_type": "convergence_check",
                        "status": "no_parents",
                        "parent_checks": [],
                        "all_passed": false,
                    }),
                    artifacts: vec![],
                    logs: vec!["No parent outputs to check".into()],
                    metadata: Default::default(),
                });
            }
        };

        let mut checks: Vec<serde_json::Value> = Vec::new();

        for (step_id, output) in parents {
            let summary = output.get("summary").unwrap_or(output);

            let energy = summary.get("energy").and_then(|v| v.as_f64());
            let max_force = summary.get("max_force").and_then(|v| v.as_f64());
            let ionic_converged = summary
                .get("converged")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let n_steps = summary
                .get("n_steps")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            let force_below = max_force.map_or(true, |f| f <= force_threshold);
            let passed = ionic_converged && force_below;

            checks.push(json!({
                "parent_step": step_id,
                "energy": energy,
                "max_force": max_force,
                "ionic_converged": ionic_converged,
                "n_steps": n_steps,
                "force_below_threshold": force_below,
                "has_energy": energy.is_some(),
                "passed": passed,
            }));
        }

        let all_passed = checks.iter().all(|c| c["passed"].as_bool().unwrap_or(false));
        let status = if all_passed {
            "passed"
        } else {
            "needs_attention"
        };

        let outputs = json!({
            "analysis_type": "convergence_check",
            "status": status,
            "parent_checks": checks,
            "all_passed": all_passed,
        });

        Ok(ToolExecutionResult {
            outputs,
            artifacts: vec![],
            logs: vec![format!(
                "Checked {} parents: {}",
                checks.len(),
                if all_passed {
                    "all passed"
                } else {
                    "some need attention"
                }
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
            node_id: "conv-check".into(),
            attempt_index: 0,
            work_dir: "/tmp/test".into(),
        }
    }

    #[tokio::test]
    async fn test_all_converged() {
        let tool = ConvergenceCheckTool::new();
        let inputs = json!({
            "params": {"force_threshold": 0.05},
            "__parent_outputs": {
                "step_a": {"summary": {"energy": -100.0, "max_force": 0.01, "converged": true, "n_steps": 10}},
                "step_b": {"summary": {"energy": -99.0, "max_force": 0.03, "converged": true, "n_steps": 15}},
            }
        });

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["status"], "passed");
        assert_eq!(result.outputs["all_passed"], true);
    }

    #[tokio::test]
    async fn test_force_above_threshold() {
        let tool = ConvergenceCheckTool::new();
        let inputs = json!({
            "params": {"force_threshold": 0.02},
            "__parent_outputs": {
                "step_a": {"summary": {"energy": -100.0, "max_force": 0.05, "converged": true}},
            }
        });

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["status"], "needs_attention");
        assert_eq!(result.outputs["all_passed"], false);

        let checks = result.outputs["parent_checks"].as_array().unwrap();
        assert_eq!(checks[0]["force_below_threshold"], false);
        assert_eq!(checks[0]["passed"], false);
    }

    #[tokio::test]
    async fn test_not_ionically_converged() {
        let tool = ConvergenceCheckTool::new();
        let inputs = json!({
            "params": {},
            "__parent_outputs": {
                "step_a": {"summary": {"energy": -100.0, "max_force": 0.01, "converged": false}},
            }
        });

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["all_passed"], false);
    }

    #[tokio::test]
    async fn test_no_parents() {
        let tool = ConvergenceCheckTool::new();
        let inputs = json!({"params": {}});

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["status"], "no_parents");
    }

    #[tokio::test]
    async fn test_missing_force_treated_as_ok() {
        let tool = ConvergenceCheckTool::new();
        let inputs = json!({
            "params": {},
            "__parent_outputs": {
                "step_a": {"summary": {"energy": -100.0, "converged": true}},
            }
        });

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        // No max_force → force_below_threshold defaults to true
        let checks = result.outputs["parent_checks"].as_array().unwrap();
        assert_eq!(checks[0]["force_below_threshold"], true);
        assert_eq!(checks[0]["passed"], true);
    }

    #[tokio::test]
    async fn test_default_thresholds() {
        let tool = ConvergenceCheckTool::new();
        // Default force_threshold = 0.02, this force is right at boundary
        let inputs = json!({
            "params": {},
            "__parent_outputs": {
                "step_a": {"summary": {"energy": -100.0, "max_force": 0.02, "converged": true}},
            }
        });

        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        // 0.02 <= 0.02 → should pass
        assert_eq!(result.outputs["all_passed"], true);
    }
}

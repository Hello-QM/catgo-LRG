//! Control flow tools: condition, loop, merge.
//!
//! These tools handle workflow control flow logic. In the Rust DAG engine,
//! actual branching/iteration is managed by the graph executor's dependency
//! resolution and skip conditions. These tools pass through parent outputs
//! to enable data flow continuity.
//!
//! For condition nodes, real branching is handled by the executor via
//! `SkipCondition` on downstream edges, not by this tool.

use async_trait::async_trait;
use serde_json::json;

use crate::core::*;
use crate::graph::run::ToolExecutionResult;
use crate::tools::traits::{Tool, ToolExecutionContext};

// ---------------------------------------------------------------------------
// ConditionTool
// ---------------------------------------------------------------------------

/// Evaluates a condition expression and passes through parent outputs.
///
/// The actual branching (which downstream nodes to skip) is handled by the
/// graph executor via SkipCondition on edges. This tool evaluates the
/// condition and exposes the result as an output for downstream reference.
///
/// Input: `{ "params": { "condition": "...", "logic_type": "if" }, "__parent_outputs": {...} }`
/// Output: `{ "condition_result": true/false, "passed_through": {...} }`
#[derive(Default)]
pub struct ConditionTool;

impl ConditionTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for ConditionTool {
    fn name(&self) -> &str {
        "condition"
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let parent_outputs = inputs
            .get("__parent_outputs")
            .cloned()
            .unwrap_or(json!({}));

        // Find first parent's output to pass through
        let passed_through = parent_outputs
            .as_object()
            .and_then(|p| p.values().next())
            .cloned()
            .unwrap_or(json!({}));

        // Condition evaluation: check if the parent provided a boolean result
        // or a specific field. The graph executor uses SkipCondition for
        // actual branch routing; this tool just exposes the evaluation.
        let params = inputs.get("params").cloned().unwrap_or(json!({}));
        let condition_expr = params
            .get("condition")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Simple condition evaluation:
        // - "true" / "false" literals
        // - Check if parent output has a "converged" or "passed" boolean field
        let condition_result = evaluate_simple_condition(condition_expr, &parent_outputs);

        let outputs = json!({
            "condition_result": condition_result,
            "passed_through": passed_through,
        });

        Ok(ToolExecutionResult {
            outputs,
            artifacts: vec![],
            logs: vec![format!(
                "Condition '{}' evaluated to {}",
                condition_expr, condition_result
            )],
            metadata: Default::default(),
        })
    }
}

/// Simple condition evaluator. Handles:
/// - "true"/"false" literals
/// - Checks parent outputs for "converged", "all_passed", "passed" boolean fields
fn evaluate_simple_condition(expr: &str, parent_outputs: &serde_json::Value) -> bool {
    let trimmed = expr.trim().to_lowercase();

    // Literal booleans
    if trimmed == "true" {
        return true;
    }
    if trimmed == "false" {
        return false;
    }

    // Check common boolean fields in parent outputs
    if let Some(parents) = parent_outputs.as_object() {
        for output in parents.values() {
            let summary = output.get("summary").unwrap_or(output);
            // Check for known boolean result fields
            for field in &["converged", "all_passed", "passed", "condition_result"] {
                if let Some(val) = summary.get(*field).and_then(|v| v.as_bool()) {
                    return val;
                }
            }
        }
    }

    // Default: pass through (true)
    true
}

// ---------------------------------------------------------------------------
// LoopTool
// ---------------------------------------------------------------------------

/// Loop control node. In the current Rust DAG engine, actual iteration is
/// managed by the executor (re-scheduling subgraph sections) or by rewrite
/// rules. This tool tracks iteration metadata and passes through data.
///
/// Input: `{ "params": { "max_iterations": 10, ... }, "__parent_outputs": {...} }`
/// Output: `{ "iteration": 0, "passed_through": {...} }`
#[derive(Default)]
pub struct LoopTool;

impl LoopTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for LoopTool {
    fn name(&self) -> &str {
        "loop"
    }

    async fn execute(
        &self,
        ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let params = inputs.get("params").cloned().unwrap_or(json!({}));
        let parent_outputs = inputs
            .get("__parent_outputs")
            .cloned()
            .unwrap_or(json!({}));

        let max_iterations = params
            .get("max_iterations")
            .and_then(|v| v.as_u64())
            .unwrap_or(10);

        // Pass through first parent's output
        let passed_through = parent_outputs
            .as_object()
            .and_then(|p| p.values().next())
            .cloned()
            .unwrap_or(json!({}));

        // Use attempt_index as a proxy for iteration count
        let iteration = ctx.attempt_index;

        let outputs = json!({
            "iteration": iteration,
            "max_iterations": max_iterations,
            "passed_through": passed_through,
        });

        Ok(ToolExecutionResult {
            outputs,
            artifacts: vec![],
            logs: vec![format!(
                "Loop iteration {} (max {})",
                iteration, max_iterations
            )],
            metadata: Default::default(),
        })
    }
}

// ---------------------------------------------------------------------------
// MergeTool
// ---------------------------------------------------------------------------

/// Merges outputs from multiple parent steps into a single output.
///
/// Merge modes:
/// - "all" (default): collect all parent outputs into an array
/// - "lowest_energy": select parent with lowest energy
/// - "first": pass through first parent's output
///
/// Input: `{ "params": { "merge_type": "all" }, "__parent_outputs": {...} }`
/// Output: `{ "merged": [...], "num_parents": N, "merge_type": "..." }`
#[derive(Default)]
pub struct MergeTool;

impl MergeTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for MergeTool {
    fn name(&self) -> &str {
        "merge"
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

        let merge_type = params
            .get("merge_type")
            .and_then(|v| v.as_str())
            .unwrap_or("all");

        let parents = parent_outputs.as_object();
        let num_parents = parents.map_or(0, |p| p.len());

        let outputs = match merge_type {
            "lowest_energy" => merge_lowest_energy(&parent_outputs),
            "first" => merge_first(&parent_outputs),
            _ => merge_all(&parent_outputs), // "all" or default
        };

        let mut result = outputs;
        result
            .as_object_mut()
            .unwrap()
            .insert("num_parents".into(), json!(num_parents));
        result
            .as_object_mut()
            .unwrap()
            .insert("merge_type".into(), json!(merge_type));

        Ok(ToolExecutionResult {
            outputs: result,
            artifacts: vec![],
            logs: vec![format!(
                "Merged {} parents (mode: {})",
                num_parents, merge_type
            )],
            metadata: Default::default(),
        })
    }
}

fn merge_all(parent_outputs: &serde_json::Value) -> serde_json::Value {
    let entries: Vec<serde_json::Value> = parent_outputs
        .as_object()
        .map(|p| {
            p.iter()
                .map(|(id, out)| {
                    json!({
                        "step_id": id,
                        "output": out,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({ "merged": entries })
}

fn merge_first(parent_outputs: &serde_json::Value) -> serde_json::Value {
    let first = parent_outputs
        .as_object()
        .and_then(|p| p.iter().next())
        .map(|(id, out)| {
            json!({
                "selected_step": id,
                "merged": out,
            })
        })
        .unwrap_or(json!({"merged": null}));
    first
}

fn merge_lowest_energy(parent_outputs: &serde_json::Value) -> serde_json::Value {
    let parents = match parent_outputs.as_object() {
        Some(p) => p,
        None => return json!({"merged": null}),
    };

    let mut best_id: Option<&str> = None;
    let mut best_energy = f64::MAX;
    let mut best_output: Option<&serde_json::Value> = None;

    for (id, output) in parents {
        let summary = output.get("summary").unwrap_or(output);
        if let Some(energy) = summary.get("energy").and_then(|e| e.as_f64()) {
            if energy < best_energy {
                best_energy = energy;
                best_id = Some(id.as_str());
                best_output = Some(output);
            }
        }
    }

    match (best_id, best_output) {
        (Some(id), Some(out)) => json!({
            "selected_step": id,
            "selected_energy_eV": best_energy,
            "merged": out,
        }),
        _ => merge_first(parent_outputs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_ctx() -> ToolExecutionContext {
        ToolExecutionContext {
            run_id: "run-001".into(),
            node_id: "ctrl".into(),
            attempt_index: 0,
            work_dir: "/tmp/test".into(),
        }
    }

    // -- Condition tests --

    #[tokio::test]
    async fn test_condition_true_literal() {
        let tool = ConditionTool::new();
        let inputs = json!({
            "params": {"condition": "true"},
            "__parent_outputs": {"s1": {"value": 42}}
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["condition_result"], true);
        assert_eq!(result.outputs["passed_through"]["value"], 42);
    }

    #[tokio::test]
    async fn test_condition_false_literal() {
        let tool = ConditionTool::new();
        let inputs = json!({
            "params": {"condition": "false"},
            "__parent_outputs": {}
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["condition_result"], false);
    }

    #[tokio::test]
    async fn test_condition_reads_parent_converged() {
        let tool = ConditionTool::new();
        let inputs = json!({
            "params": {"condition": "check_parent"},
            "__parent_outputs": {
                "step_a": {"summary": {"converged": false}}
            }
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["condition_result"], false);
    }

    #[tokio::test]
    async fn test_condition_default_true() {
        let tool = ConditionTool::new();
        let inputs = json!({
            "params": {"condition": "some_unknown_expr"},
            "__parent_outputs": {"s1": {"data": 123}}
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        // No recognized boolean field → default true
        assert_eq!(result.outputs["condition_result"], true);
    }

    // -- Loop tests --

    #[tokio::test]
    async fn test_loop_passthrough() {
        let tool = LoopTool::new();
        let inputs = json!({
            "params": {"max_iterations": 5},
            "__parent_outputs": {"s1": {"structure_json": "..."}}
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["iteration"], 0);
        assert_eq!(result.outputs["max_iterations"], 5);
        assert_eq!(result.outputs["passed_through"]["structure_json"], "...");
    }

    // -- Merge tests --

    #[tokio::test]
    async fn test_merge_all() {
        let tool = MergeTool::new();
        let inputs = json!({
            "params": {"merge_type": "all"},
            "__parent_outputs": {
                "s1": {"energy": -100.0},
                "s2": {"energy": -99.0},
            }
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["num_parents"], 2);
        assert_eq!(result.outputs["merge_type"], "all");
        let merged = result.outputs["merged"].as_array().unwrap();
        assert_eq!(merged.len(), 2);
    }

    #[tokio::test]
    async fn test_merge_lowest_energy() {
        let tool = MergeTool::new();
        let inputs = json!({
            "params": {"merge_type": "lowest_energy"},
            "__parent_outputs": {
                "s1": {"summary": {"energy": -100.0}},
                "s2": {"summary": {"energy": -102.0}},
            }
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["selected_step"], "s2");
        assert_eq!(result.outputs["selected_energy_eV"], -102.0);
    }

    #[tokio::test]
    async fn test_merge_first() {
        let tool = MergeTool::new();
        let inputs = json!({
            "params": {"merge_type": "first"},
            "__parent_outputs": {
                "s1": {"data": 1},
            }
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["selected_step"], "s1");
    }

    #[tokio::test]
    async fn test_merge_empty_parents() {
        let tool = MergeTool::new();
        let inputs = json!({"params": {}});
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert_eq!(result.outputs["num_parents"], 0);
    }
}

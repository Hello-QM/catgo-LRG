//! StatsTool: computes basic statistics on a numeric array.
//!
//! A domain-agnostic analysis tool that validates the runtime can handle
//! tools that consume structured input, produce computed outputs, and
//! register result artifacts.
//!
//! Lives in `tools/` because it implements the Tool trait and is domain-agnostic
//! (statistics computation is not chemistry-specific).

use async_trait::async_trait;
use std::path::Path;
use uuid::Uuid;

use crate::core::*;
use crate::graph::run::{ArtifactKind, ArtifactRef, ToolExecutionResult};
use crate::tools::traits::{Tool, ToolExecutionContext};

pub struct StatsTool {
    tool_name: String,
}

impl StatsTool {
    pub fn new(name: &str) -> Self {
        Self {
            tool_name: name.to_string(),
        }
    }
}

#[async_trait]
impl Tool for StatsTool {
    fn name(&self) -> &str {
        &self.tool_name
    }

    async fn execute(
        &self,
        ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        // Extract and validate "values" array
        let values = inputs
            .get("values")
            .and_then(|v| v.as_array())
            .ok_or_else(|| StructuredError {
                category: ErrorCategory::Validation,
                code: Some("MISSING_VALUES".into()),
                message: "Input must contain a 'values' array of numbers".into(),
                retryable: false,
                details: serde_json::json!({
                    "received_keys": inputs.as_object().map(|o| o.keys().collect::<Vec<_>>())
                }),
            })?;

        let numbers: Vec<f64> = values
            .iter()
            .enumerate()
            .map(|(i, v)| {
                v.as_f64().ok_or_else(|| StructuredError {
                    category: ErrorCategory::Validation,
                    code: Some("INVALID_NUMBER".into()),
                    message: format!("values[{i}] is not a number"),
                    retryable: false,
                    details: serde_json::json!({"index": i, "value": v}),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        if numbers.is_empty() {
            return Err(StructuredError {
                category: ErrorCategory::Validation,
                code: Some("EMPTY_VALUES".into()),
                message: "values array must not be empty".into(),
                retryable: false,
                details: serde_json::json!({}),
            });
        }

        let count = numbers.len();
        let sum: f64 = numbers.iter().sum();
        let mean = sum / count as f64;
        let min = numbers.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = numbers.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let label = inputs
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("unlabeled");

        let result = serde_json::json!({
            "count": count,
            "sum": sum,
            "mean": mean,
            "min": min,
            "max": max,
            "label": label,
        });

        // Create working directory and write result file
        let work_dir = Path::new(&ctx.work_dir);
        std::fs::create_dir_all(work_dir).map_err(|e| StructuredError {
            category: ErrorCategory::ToolInvocation,
            code: Some("IO_ERROR".into()),
            message: format!("Failed to create work_dir: {e}"),
            retryable: true,
            details: serde_json::json!({"path": ctx.work_dir}),
        })?;

        let file_path = work_dir.join("statistics.json");
        let json_bytes = serde_json::to_vec_pretty(&result).expect("result serialization");
        std::fs::write(&file_path, &json_bytes).map_err(|e| StructuredError {
            category: ErrorCategory::ToolInvocation,
            code: Some("IO_ERROR".into()),
            message: format!("Failed to write statistics.json: {e}"),
            retryable: true,
            details: serde_json::json!({"path": file_path.display().to_string()}),
        })?;

        let artifact = ArtifactRef {
            id: Uuid::new_v4().to_string(),
            kind: ArtifactKind::Json,
            path: Some(file_path.display().to_string()),
            uri: None,
            metadata: Default::default(),
        };

        Ok(ToolExecutionResult {
            outputs: result,
            artifacts: vec![artifact],
            logs: vec![format!(
                "[{}] computed stats for {} values (mean={:.4})",
                self.tool_name, count, mean
            )],
            metadata: Default::default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn test_ctx(work_dir: &str) -> ToolExecutionContext {
        ToolExecutionContext {
            run_id: "run-001".to_string(),
            node_id: "stats-node".to_string(),
            attempt_index: 1,
            work_dir: work_dir.to_string(),
        }
    }

    #[tokio::test]
    async fn test_computes_correct_statistics() {
        let tmp = TempDir::new().unwrap();
        let tool = StatsTool::new("compute_stats");
        let inputs = json!({"values": [2.0, 4.0, 6.0, 8.0, 10.0], "label": "energies"});
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let result = tool.execute(ctx, inputs).await.unwrap();

        assert_eq!(result.outputs["count"], 5);
        assert_eq!(result.outputs["sum"], 30.0);
        assert_eq!(result.outputs["mean"], 6.0);
        assert_eq!(result.outputs["min"], 2.0);
        assert_eq!(result.outputs["max"], 10.0);
        assert_eq!(result.outputs["label"], "energies");
    }

    #[tokio::test]
    async fn test_writes_statistics_file() {
        let tmp = TempDir::new().unwrap();
        let tool = StatsTool::new("stats");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let result = tool.execute(ctx, json!({"values": [1.0, 2.0]})).await.unwrap();

        // File was created
        let file_path = tmp.path().join("statistics.json");
        assert!(file_path.exists());

        // File content matches outputs
        let content: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file_path).unwrap()).unwrap();
        assert_eq!(content["mean"], 1.5);
        assert_eq!(content["count"], 2);

        // Artifact registered
        assert_eq!(result.artifacts.len(), 1);
        assert_eq!(result.artifacts[0].kind, ArtifactKind::Json);
    }

    #[tokio::test]
    async fn test_missing_values_error() {
        let tmp = TempDir::new().unwrap();
        let tool = StatsTool::new("stats");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let err = tool.execute(ctx, json!({"data": [1, 2]})).await.unwrap_err();
        assert_eq!(err.category, ErrorCategory::Validation);
        assert_eq!(err.code, Some("MISSING_VALUES".into()));
        assert!(!err.retryable);
    }

    #[tokio::test]
    async fn test_empty_values_error() {
        let tmp = TempDir::new().unwrap();
        let tool = StatsTool::new("stats");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let err = tool
            .execute(ctx, json!({"values": []}))
            .await
            .unwrap_err();
        assert_eq!(err.code, Some("EMPTY_VALUES".into()));
    }

    #[tokio::test]
    async fn test_non_numeric_value_error() {
        let tmp = TempDir::new().unwrap();
        let tool = StatsTool::new("stats");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let err = tool
            .execute(ctx, json!({"values": [1.0, "not_a_number", 3.0]}))
            .await
            .unwrap_err();
        assert_eq!(err.code, Some("INVALID_NUMBER".into()));
        assert!(err.message.contains("values[1]"));
    }

    #[tokio::test]
    async fn test_default_label() {
        let tmp = TempDir::new().unwrap();
        let tool = StatsTool::new("stats");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let result = tool.execute(ctx, json!({"values": [42.0]})).await.unwrap();
        assert_eq!(result.outputs["label"], "unlabeled");
    }

    #[tokio::test]
    async fn test_single_value() {
        let tmp = TempDir::new().unwrap();
        let tool = StatsTool::new("stats");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let result = tool
            .execute(ctx, json!({"values": [7.5]}))
            .await
            .unwrap();
        assert_eq!(result.outputs["count"], 1);
        assert_eq!(result.outputs["mean"], 7.5);
        assert_eq!(result.outputs["min"], 7.5);
        assert_eq!(result.outputs["max"], 7.5);
        assert_eq!(result.outputs["sum"], 7.5);
    }
}

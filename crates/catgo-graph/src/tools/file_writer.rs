//! FileWriterTool: writes input data to a JSON file in the working directory.
//!
//! This is a lightweight real tool that bridges mock tools and real execution:
//! - Creates the working directory if it doesn't exist
//! - Writes the full input JSON to `data.json`
//! - Registers the file as an artifact
//! - Passes through all input fields as outputs (like EchoTool, but with real I/O)
//!
//! Lives in `tools/` because it implements the Tool trait and is domain-agnostic.

use async_trait::async_trait;
use std::path::Path;
use uuid::Uuid;

use crate::core::*;
use crate::graph::run::{ArtifactKind, ArtifactRef, ToolExecutionResult};
use crate::tools::traits::{Tool, ToolExecutionContext};

pub struct FileWriterTool {
    tool_name: String,
}

impl FileWriterTool {
    pub fn new(name: &str) -> Self {
        Self {
            tool_name: name.to_string(),
        }
    }
}

#[async_trait]
impl Tool for FileWriterTool {
    fn name(&self) -> &str {
        &self.tool_name
    }

    async fn execute(
        &self,
        ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let work_dir = Path::new(&ctx.work_dir);
        std::fs::create_dir_all(work_dir).map_err(|e| StructuredError {
            category: ErrorCategory::ToolInvocation,
            code: Some("IO_ERROR".into()),
            message: format!("Failed to create work_dir: {e}"),
            retryable: true,
            details: serde_json::json!({"path": ctx.work_dir}),
        })?;

        let file_path = work_dir.join("data.json");
        let json_bytes = serde_json::to_vec_pretty(&inputs).map_err(|e| StructuredError {
            category: ErrorCategory::ToolInvocation,
            code: Some("SERIALIZE_ERROR".into()),
            message: format!("Failed to serialize inputs: {e}"),
            retryable: false,
            details: serde_json::json!({}),
        })?;

        std::fs::write(&file_path, &json_bytes).map_err(|e| StructuredError {
            category: ErrorCategory::ToolInvocation,
            code: Some("IO_ERROR".into()),
            message: format!("Failed to write data.json: {e}"),
            retryable: true,
            details: serde_json::json!({"path": file_path.display().to_string()}),
        })?;

        let artifact = ArtifactRef {
            id: Uuid::new_v4().to_string(),
            kind: ArtifactKind::File,
            path: Some(file_path.display().to_string()),
            uri: None,
            metadata: Default::default(),
        };

        Ok(ToolExecutionResult {
            outputs: inputs,
            artifacts: vec![artifact],
            logs: vec![format!(
                "[{}] wrote {} bytes to {}",
                self.tool_name,
                json_bytes.len(),
                file_path.display()
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
            node_id: "node-A".to_string(),
            attempt_index: 1,
            work_dir: work_dir.to_string(),
        }
    }

    #[tokio::test]
    async fn test_creates_work_dir_and_writes_file() {
        let tmp = TempDir::new().unwrap();
        let work_dir = tmp.path().join("run-001").join("node-A");
        let tool = FileWriterTool::new("file_writer");

        let inputs = json!({"structure": "Si", "energy": -5.2});
        let ctx = test_ctx(work_dir.to_str().unwrap());
        let result = tool.execute(ctx, inputs.clone()).await.unwrap();

        // Outputs pass through
        assert_eq!(result.outputs, inputs);

        // Work dir was created
        assert!(work_dir.exists());

        // File was written
        let file_path = work_dir.join("data.json");
        assert!(file_path.exists());

        // File content matches input
        let content: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file_path).unwrap()).unwrap();
        assert_eq!(content, inputs);

        // Artifact was registered
        assert_eq!(result.artifacts.len(), 1);
        assert_eq!(result.artifacts[0].kind, ArtifactKind::File);
        assert!(result.artifacts[0].path.is_some());
    }

    #[tokio::test]
    async fn test_passthrough_outputs() {
        let tmp = TempDir::new().unwrap();
        let tool = FileWriterTool::new("writer");
        let inputs = json!({"values": [1, 2, 3], "label": "test"});
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let result = tool.execute(ctx, inputs.clone()).await.unwrap();
        assert_eq!(result.outputs["values"], json!([1, 2, 3]));
        assert_eq!(result.outputs["label"], "test");
    }

    #[tokio::test]
    async fn test_artifact_has_valid_id() {
        let tmp = TempDir::new().unwrap();
        let tool = FileWriterTool::new("writer");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let result = tool.execute(ctx, json!({})).await.unwrap();
        assert!(!result.artifacts[0].id.is_empty());
        // UUID v4 format
        assert!(Uuid::parse_str(&result.artifacts[0].id).is_ok());
    }

    #[tokio::test]
    async fn test_logs_contain_file_info() {
        let tmp = TempDir::new().unwrap();
        let tool = FileWriterTool::new("my_writer");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let result = tool.execute(ctx, json!({"x": 1})).await.unwrap();
        assert_eq!(result.logs.len(), 1);
        assert!(result.logs[0].contains("my_writer"));
        assert!(result.logs[0].contains("data.json"));
    }
}

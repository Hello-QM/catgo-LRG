//! StructureInputTool: passthrough entry point for crystal structures.
//!
//! Reads structure_json from params and passes it through as output.
//! This is the starting node for most workflows.

use async_trait::async_trait;
use serde_json::json;

use crate::core::*;
use crate::graph::run::ToolExecutionResult;
use crate::tools::traits::{Tool, ToolExecutionContext};

#[derive(Default)]
pub struct StructureInputTool;

impl StructureInputTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for StructureInputTool {
    fn name(&self) -> &str {
        "structure_input"
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let params = inputs.get("params").cloned().unwrap_or(json!({}));
        let structure_json = params
            .get("structure_json")
            .cloned()
            .unwrap_or(json!(null));

        Ok(ToolExecutionResult {
            outputs: json!({ "structure_json": structure_json }),
            artifacts: vec![],
            logs: vec!["Structure input passthrough".into()],
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
            node_id: "struct-in".into(),
            attempt_index: 0,
            work_dir: "/tmp/test".into(),
        }
    }

    #[tokio::test]
    async fn test_passthrough() {
        let tool = StructureInputTool::new();
        let inputs = json!({
            "params": {
                "structure_json": {"lattice": {"matrix": [[1,0,0],[0,1,0],[0,0,1]]}, "sites": []}
            }
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert!(result.outputs["structure_json"].is_object());
    }

    #[tokio::test]
    async fn test_string_passthrough() {
        let tool = StructureInputTool::new();
        let inputs = json!({
            "params": {"structure_json": "{\"lattice\": {}}"}
        });
        let result = tool.execute(test_ctx(), inputs).await.unwrap();
        assert!(result.outputs["structure_json"].is_string());
    }
}

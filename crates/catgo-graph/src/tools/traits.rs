use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use crate::core::*;
use crate::graph::run::ToolExecutionResult;

/// Context provided to every tool execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecutionContext {
    pub run_id: GraphRunId,
    pub node_id: NodeId,
    pub attempt_index: u32,
    pub work_dir: String,
}

/// The core trait that all tools implement.
/// The runtime depends only on this interface -- never on tool internals.
#[async_trait]
pub trait Tool: Send + Sync {
    /// Tool name (must match NodeTemplate.tool field)
    fn name(&self) -> &str;

    /// Execute with the given context and resolved inputs.
    /// Returns structured result or structured error.
    async fn execute(
        &self,
        ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError>;
}

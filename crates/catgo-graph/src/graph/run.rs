use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use crate::core::*;

/// Typed artifact reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub id: ArtifactId,
    pub kind: ArtifactKind,
    pub path: Option<String>,
    pub uri: Option<String>,
    #[serde(default)]
    pub metadata: Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    File,
    Json,
    Number,
    Table,
    Directory,
    Image,
    Plot,
    Unknown,
}

/// One execution attempt of a node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeAttempt {
    pub attempt_index: u32,
    pub status: AttemptStatus,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub tool_request: serde_json::Value,
    pub tool_result: Option<ToolExecutionResult>,
    pub logs_path: Option<String>,
    pub error: Option<StructuredError>,
}

/// Structured result from tool execution (stored in attempts)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecutionResult {
    pub outputs: serde_json::Value,
    pub artifacts: Vec<ArtifactRef>,
    pub logs: Vec<String>,
    #[serde(default)]
    pub metadata: Metadata,
}

/// Runtime state for one node in one run
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRun {
    pub node_id: NodeId,
    pub status: NodeStatus,
    pub resolved_inputs: Option<serde_json::Value>,
    pub outputs: Option<serde_json::Value>,
    pub artifacts: Vec<ArtifactRef>,
    pub attempts: Vec<NodeAttempt>,
    pub current_attempt: u32,
    /// Number of repair attempts made for this node.
    #[serde(default)]
    pub repair_count: u32,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub last_error: Option<StructuredError>,
}

impl NodeRun {
    /// Create a new NodeRun in Pending state
    pub fn new(node_id: NodeId) -> Self {
        Self {
            node_id,
            status: NodeStatus::Pending,
            resolved_inputs: None,
            outputs: None,
            artifacts: Vec::new(),
            attempts: Vec::new(),
            current_attempt: 0,
            repair_count: 0,
            started_at: None,
            finished_at: None,
            last_error: None,
        }
    }
}

/// One instantiated execution of a graph template
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphRun {
    pub id: GraphRunId,
    pub template_id: GraphTemplateId,
    pub template_version: String,
    pub status: GraphRunStatus,
    pub inputs: serde_json::Value,
    pub node_runs: Vec<NodeRun>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub run_dir: String,
    #[serde(default)]
    pub metadata: Metadata,
    /// Rewrite events that were applied during execution.
    /// Used for provenance, idempotency, and monitoring.
    #[serde(default)]
    pub rewrite_events: Vec<crate::graph::rewrite::RewriteEvent>,
}

impl GraphRun {
    /// Find a NodeRun by node_id
    pub fn node_run(&self, node_id: &str) -> Option<&NodeRun> {
        self.node_runs.iter().find(|n| n.node_id == node_id)
    }

    /// Find a mutable NodeRun by node_id
    pub fn node_run_mut(&mut self, node_id: &str) -> Option<&mut NodeRun> {
        self.node_runs.iter_mut().find(|n| n.node_id == node_id)
    }
}

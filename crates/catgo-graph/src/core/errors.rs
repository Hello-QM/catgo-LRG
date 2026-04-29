use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::state::{NodeStatus, GraphRunStatus};

/// Categorized error for domain-aware failure classification
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    ToolInvocation,
    Validation,
    InputResolution,
    Timeout,
    ExternalProcess,
    Scheduler,
    Storage,
    ScfNonConvergence,
    IonicNonConvergence,
    ParseFailure,
    RepairFailed,
    Unknown,
}

/// Machine-readable structured error (returned by tools, stored in attempts)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredError {
    pub category: ErrorCategory,
    pub code: Option<String>,
    pub message: String,
    pub retryable: bool,
    pub details: serde_json::Value,
}

impl std::fmt::Display for StructuredError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.category, self.message)
    }
}

impl std::error::Error for StructuredError {}

/// Top-level engine error
#[derive(Debug, Error)]
pub enum EngineError {
    #[error("Validation failed: {reason}")]
    Validation { reason: String },

    #[error("Cycle detected involving nodes: {nodes:?}")]
    CycleDetected { nodes: Vec<String> },

    #[error("Node '{node_id}' not found in run '{run_id}'")]
    NodeNotFound { run_id: String, node_id: String },

    #[error("Tool '{tool_name}' not registered")]
    ToolNotFound { tool_name: String },

    #[error("Input resolution failed for '{expression}': {reason}")]
    InputResolution { expression: String, reason: String },

    #[error("Invalid state transition for node '{node_id}': {from:?} -> {to:?}")]
    InvalidTransition { node_id: String, from: NodeStatus, to: NodeStatus },

    #[error("Tool execution failed: {0}")]
    ToolExecution(StructuredError),

    #[error("Storage error: {reason}")]
    Storage { reason: String },

    #[error("Run '{run_id}' is in state {state:?}, expected one of {expected:?}")]
    InvalidRunState { run_id: String, state: GraphRunStatus, expected: Vec<GraphRunStatus> },

    #[error("YAML parse error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

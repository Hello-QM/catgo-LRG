use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// Flexible metadata map
pub type Metadata = HashMap<String, serde_json::Value>;

/// How a node should be executed
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Local,
    Hpc,
    Remote,
}

impl Default for ExecutionMode {
    fn default() -> Self { Self::Local }
}

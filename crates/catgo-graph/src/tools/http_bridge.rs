//! HTTP bridge tool: delegates node execution to an external Python service.
//!
//! This is the core integration point between catgo-graph's Rust scheduler
//! and CatGO's existing Python workflow handlers.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::core::*;
use crate::graph::run::ToolExecutionResult;
use crate::tools::traits::{Tool, ToolExecutionContext};

/// Request payload sent to the Python tool bridge endpoint.
#[derive(Debug, Serialize)]
struct ToolBridgeRequest {
    node_type: String,
    step_id: String,
    inputs: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<serde_json::Value>,
}

/// Response payload from the Python tool bridge endpoint.
#[derive(Debug, Deserialize)]
struct ToolBridgeResponse {
    status: String,
    #[serde(default)]
    outputs: serde_json::Value,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    artifacts: Vec<BridgeArtifact>,
}

#[derive(Debug, Deserialize)]
struct BridgeArtifact {
    #[serde(default)]
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    uri: Option<String>,
}

/// A tool that delegates execution to an external HTTP service (Python backend).
///
/// Each node execution becomes a POST request to `{base_url}/api/tool/execute`.
/// The Python side routes to the appropriate handler based on `node_type`.
pub struct HttpBridgeTool {
    client: reqwest::Client,
    base_url: String,
    /// The node type this tool handles. When set to "*", acts as a wildcard.
    node_type: String,
}

impl HttpBridgeTool {
    /// Create a new HTTP bridge tool.
    ///
    /// - `base_url`: Python backend URL (e.g., "http://localhost:8000")
    /// - `node_type`: The node type this tool handles (use "*" for wildcard)
    /// - `timeout`: Maximum time to wait for a response (default: 24 hours for HPC jobs)
    pub fn new(base_url: impl Into<String>, node_type: impl Into<String>, timeout: Duration) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("Failed to create reqwest client");

        Self {
            client,
            base_url: base_url.into(),
            node_type: node_type.into(),
        }
    }

    /// Create with default timeout (24 hours).
    pub fn with_defaults(base_url: impl Into<String>, node_type: impl Into<String>) -> Self {
        Self::new(base_url, node_type, Duration::from_secs(24 * 60 * 60))
    }
}

#[async_trait]
impl Tool for HttpBridgeTool {
    fn name(&self) -> &str {
        &self.node_type
    }

    async fn execute(
        &self,
        ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let url = format!("{}/api/tool/execute", self.base_url);

        // The node_type to send is extracted from metadata or falls back to tool name
        let actual_node_type = inputs
            .get("__node_type")
            .and_then(|v| v.as_str())
            .unwrap_or(&self.node_type)
            .to_string();

        let request = ToolBridgeRequest {
            node_type: actual_node_type,
            step_id: ctx.node_id.clone(),
            inputs: inputs.clone(),
            config: inputs.get("__config").cloned(),
        };

        let response = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| StructuredError {
                category: ErrorCategory::ToolInvocation,
                code: Some("HTTP_BRIDGE_REQUEST_FAILED".into()),
                message: format!("Failed to reach Python tool bridge: {}", e),
                retryable: e.is_timeout() || e.is_connect(),
                details: serde_json::json!({ "url": url, "error": e.to_string() }),
            })?;

        let status_code = response.status();
        if !status_code.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(StructuredError {
                category: ErrorCategory::ToolInvocation,
                code: Some(format!("HTTP_{}", status_code.as_u16())),
                message: format!("Tool bridge returned {}: {}", status_code, body),
                retryable: status_code.is_server_error(),
                details: serde_json::json!({ "status_code": status_code.as_u16(), "body": body }),
            });
        }

        let bridge_resp: ToolBridgeResponse =
            response.json().await.map_err(|e| StructuredError {
                category: ErrorCategory::ToolInvocation,
                code: Some("HTTP_BRIDGE_PARSE_FAILED".into()),
                message: format!("Failed to parse tool bridge response: {}", e),
                retryable: false,
                details: serde_json::json!({ "error": e.to_string() }),
            })?;

        // Check if the Python side reported an error
        if bridge_resp.status == "failed" {
            return Err(StructuredError {
                category: ErrorCategory::ExternalProcess,
                code: Some("TOOL_EXECUTION_FAILED".into()),
                message: bridge_resp
                    .error
                    .unwrap_or_else(|| "Unknown error from tool bridge".into()),
                retryable: false,
                details: bridge_resp.outputs,
            });
        }

        // Convert bridge artifacts to our ArtifactRef format
        let artifacts = bridge_resp
            .artifacts
            .into_iter()
            .map(|a| crate::graph::run::ArtifactRef {
                id: if a.id.is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    a.id
                },
                kind: match a.kind.as_str() {
                    "file" => crate::graph::run::ArtifactKind::File,
                    "json" => crate::graph::run::ArtifactKind::Json,
                    "number" => crate::graph::run::ArtifactKind::Number,
                    "table" => crate::graph::run::ArtifactKind::Table,
                    "directory" => crate::graph::run::ArtifactKind::Directory,
                    "image" => crate::graph::run::ArtifactKind::Image,
                    "plot" => crate::graph::run::ArtifactKind::Plot,
                    _ => crate::graph::run::ArtifactKind::Unknown,
                },
                path: a.path,
                uri: a.uri,
                metadata: Default::default(),
            })
            .collect();

        Ok(ToolExecutionResult {
            outputs: bridge_resp.outputs,
            artifacts,
            logs: Vec::new(),
            metadata: Default::default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_bridge_request_serialization() {
        let req = ToolBridgeRequest {
            node_type: "vasp_relax".into(),
            step_id: "step-1".into(),
            inputs: serde_json::json!({"ENCUT": 520}),
            config: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("vasp_relax"));
        assert!(json.contains("step-1"));
        // config is None so should be skipped
        assert!(!json.contains("config"));
    }

    #[test]
    fn test_tool_bridge_response_deserialization() {
        let json = r#"{
            "status": "completed",
            "outputs": {"energy": -123.45},
            "artifacts": [{"id": "a1", "kind": "file", "path": "/tmp/CONTCAR"}]
        }"#;
        let resp: ToolBridgeResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.status, "completed");
        assert_eq!(resp.artifacts.len(), 1);
        assert_eq!(resp.artifacts[0].kind, "file");
    }

    #[test]
    fn test_tool_bridge_response_minimal() {
        let json = r#"{"status": "completed"}"#;
        let resp: ToolBridgeResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.status, "completed");
        assert!(resp.outputs.is_null());
        assert!(resp.error.is_none());
        assert!(resp.artifacts.is_empty());
    }

    #[test]
    fn test_http_bridge_tool_name() {
        let tool = HttpBridgeTool::with_defaults("http://localhost:8000", "vasp_relax");
        assert_eq!(tool.name(), "vasp_relax");
    }
}

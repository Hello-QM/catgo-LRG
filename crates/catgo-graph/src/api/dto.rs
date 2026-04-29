use serde::{Deserialize, Serialize};
use crate::core::state::{GraphRunStatus, NodeStatus};
use crate::graph::run::ArtifactRef;

/// Summary of a graph run for agent consumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphRunSummary {
    pub id: String,
    pub template_id: String,
    pub status: GraphRunStatus,
    pub node_count: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub pending: usize,
    pub created_at: String,
    pub updated_at: String,
}

/// Summary of a single node for agent consumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRunSummary {
    pub node_id: String,
    pub status: NodeStatus,
    pub attempts: u32,
    pub has_error: bool,
    pub artifact_count: usize,
    /// Tool name from the template (useful for display/debugging)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Human-readable last error message (avoids exposing full StructuredError)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_message: Option<String>,
    /// Number of repair attempts made
    #[serde(default)]
    pub repair_count: u32,
}

/// Description of a graph template for agent consumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphTemplateInfo {
    pub id: String,
    pub version: String,
    pub description: Option<String>,
    pub inputs_schema: serde_json::Value,
    pub node_count: usize,
    pub node_ids: Vec<String>,
    pub output_names: Vec<String>,
    /// Whether this template has rewrite rules configured
    #[serde(default)]
    pub has_rewrite_rules: bool,
    /// Number of rewrite rules
    #[serde(default)]
    pub rewrite_rule_count: usize,
}

/// Artifact listing grouped by node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeArtifacts {
    pub node_id: String,
    pub artifacts: Vec<ArtifactRef>,
}

/// Detailed node status for frontend monitoring (Phase 7).
/// Contains everything a workflow panel needs to render one node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeStatusDetail {
    pub node_id: String,
    pub status: NodeStatus,
    pub attempts: u32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub last_error: Option<String>,
    pub artifact_count: usize,
    pub artifacts: Vec<ArtifactRef>,
    /// Number of repair attempts made
    #[serde(default)]
    pub repair_count: u32,
    /// If this node was dynamically injected by a rewrite rule, this field
    /// contains the rewrite source information.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewrite_source: Option<RewriteSourceInfo>,
}

/// Full graph run detail for frontend monitoring (Phase 7).
/// A single response containing everything a workflow UI needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphRunDetail {
    pub id: String,
    pub template_id: String,
    pub status: GraphRunStatus,
    pub created_at: String,
    pub updated_at: String,
    pub node_count: usize,
    pub nodes: Vec<NodeStatusDetail>,
    /// Rewrite events that were applied during execution.
    #[serde(default)]
    pub rewrite_events: Vec<RewriteEventSummary>,
}

/// Template listing entry for agent consumption (Phase 6).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSummary {
    pub id: String,
    pub version: String,
    pub description: Option<String>,
    pub node_count: usize,
}

/// Hierarchical node representation for monitoring.
/// Groups subgraph-expanded nodes under their parent subgraph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeHierarchyDetail {
    /// The display node ID (just the leaf name, not the full path)
    pub node_id: String,
    /// Full path including subgraph prefixes (e.g., "relax_step/save_input")
    pub full_path: String,
    pub status: NodeStatus,
    pub attempts: u32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub last_error: Option<String>,
    pub artifact_count: usize,
    /// True if this is a virtual subgraph group node (not a real execution node)
    pub is_subgraph_group: bool,
    /// Aggregate status summary for subgraph groups
    pub group_summary: Option<GroupSummary>,
    /// Child nodes (empty for leaf nodes, populated for subgraph groups)
    pub children: Vec<NodeHierarchyDetail>,
    /// If this node was dynamically injected by a rewrite rule
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewrite_source: Option<RewriteSourceInfo>,
}

/// Summary statistics for a subgraph group.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupSummary {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub pending: usize,
    pub running: usize,
}

/// Full hierarchical graph run detail for frontend monitoring.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphHierarchyDetail {
    pub id: String,
    pub template_id: String,
    pub status: GraphRunStatus,
    pub created_at: String,
    pub updated_at: String,
    pub node_count: usize,
    /// Hierarchical node tree (top-level nodes + subgraph groups)
    pub nodes: Vec<NodeHierarchyDetail>,
}

/// Summary of a rewrite event for monitoring/API consumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewriteEventSummary {
    /// Unique event ID
    pub event_id: String,
    /// Which rule fired
    pub rule_id: String,
    /// Which node triggered the rewrite
    pub source_node: String,
    /// Which subgraph template was injected
    pub injected_template_id: String,
    /// How many nodes were injected
    pub injected_node_count: usize,
    /// When the rewrite was applied
    pub applied_at: String,
}

/// Source information for a dynamically injected node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewriteSourceInfo {
    /// The rewrite event that created this node
    pub rewrite_event_id: String,
    /// The rule that triggered injection
    pub rewrite_rule_id: String,
    /// The node whose output triggered the rewrite
    pub source_node: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::run::ArtifactKind;
    use serde_json::json;

    #[test]
    fn test_graph_run_summary_serialization() {
        let summary = GraphRunSummary {
            id: "run-001".to_string(),
            template_id: "oer_screen".to_string(),
            status: GraphRunStatus::Succeeded,
            node_count: 5,
            succeeded: 4,
            failed: 1,
            pending: 0,
            created_at: "2025-01-01T00:00:00+00:00".to_string(),
            updated_at: "2025-01-01T01:00:00+00:00".to_string(),
        };

        let serialized = serde_json::to_value(&summary).unwrap();

        assert_eq!(serialized["id"], "run-001");
        assert_eq!(serialized["template_id"], "oer_screen");
        assert_eq!(serialized["status"], "succeeded");
        assert_eq!(serialized["node_count"], 5);
        assert_eq!(serialized["succeeded"], 4);
        assert_eq!(serialized["failed"], 1);
        assert_eq!(serialized["pending"], 0);
        assert_eq!(serialized["created_at"], "2025-01-01T00:00:00+00:00");
        assert_eq!(serialized["updated_at"], "2025-01-01T01:00:00+00:00");

        // Verify round-trip deserialization
        let deserialized: GraphRunSummary = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.id, "run-001");
        assert_eq!(deserialized.status, GraphRunStatus::Succeeded);
        assert_eq!(deserialized.node_count, 5);
    }

    #[test]
    fn test_node_run_summary_serialization() {
        let summary = NodeRunSummary {
            node_id: "relax_slab".to_string(),
            status: NodeStatus::Failed,
            attempts: 3,
            has_error: true,
            artifact_count: 2,
            tool_name: Some("vasp_relax".to_string()),
            last_error_message: Some("SCF did not converge".to_string()),
            repair_count: 1,
        };

        let serialized = serde_json::to_value(&summary).unwrap();

        assert_eq!(serialized["node_id"], "relax_slab");
        assert_eq!(serialized["status"], "failed");
        assert_eq!(serialized["attempts"], 3);
        assert_eq!(serialized["has_error"], true);
        assert_eq!(serialized["artifact_count"], 2);

        // Verify round-trip deserialization
        let deserialized: NodeRunSummary = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.node_id, "relax_slab");
        assert_eq!(deserialized.status, NodeStatus::Failed);
        assert_eq!(deserialized.attempts, 3);
        assert!(deserialized.has_error);
    }

    #[test]
    fn test_graph_template_info_serialization() {
        let info = GraphTemplateInfo {
            id: "oer_screen".to_string(),
            version: "2.0.0".to_string(),
            description: Some("OER catalyst screening workflow".to_string()),
            inputs_schema: json!({"type": "object", "properties": {"structure": {"type": "string"}}}),
            node_count: 3,
            node_ids: vec!["relax".to_string(), "adsorb".to_string(), "calc".to_string()],
            output_names: vec!["overpotential".to_string(), "report".to_string()],
            has_rewrite_rules: true,
            rewrite_rule_count: 2,
        };

        let serialized = serde_json::to_value(&info).unwrap();

        assert_eq!(serialized["id"], "oer_screen");
        assert_eq!(serialized["version"], "2.0.0");
        assert_eq!(serialized["description"], "OER catalyst screening workflow");
        assert_eq!(serialized["node_count"], 3);
        assert_eq!(serialized["node_ids"], json!(["relax", "adsorb", "calc"]));
        assert_eq!(serialized["output_names"], json!(["overpotential", "report"]));
        assert!(serialized["inputs_schema"]["properties"]["structure"].is_object());

        // Verify round-trip deserialization
        let deserialized: GraphTemplateInfo = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.id, "oer_screen");
        assert_eq!(deserialized.description, Some("OER catalyst screening workflow".to_string()));
        assert_eq!(deserialized.node_ids.len(), 3);
        assert_eq!(deserialized.output_names.len(), 2);
    }

    // ---- Phase 7: Frontend monitoring DTO serialization tests ----

    #[test]
    fn test_node_status_detail_serialization() {
        let detail = NodeStatusDetail {
            node_id: "relax_slab".to_string(),
            status: NodeStatus::Succeeded,
            attempts: 2,
            started_at: Some("2025-06-01T10:00:00+00:00".to_string()),
            finished_at: Some("2025-06-01T10:05:00+00:00".to_string()),
            last_error: None,
            artifact_count: 3,
            artifacts: vec![
                ArtifactRef {
                    id: "art-001".to_string(),
                    kind: ArtifactKind::File,
                    path: Some("/tmp/CONTCAR".to_string()),
                    uri: None,
                    metadata: Default::default(),
                },
            ],
            repair_count: 0,
            rewrite_source: None,
        };

        let serialized = serde_json::to_value(&detail).unwrap();

        assert_eq!(serialized["node_id"], "relax_slab");
        assert_eq!(serialized["status"], "succeeded");
        assert_eq!(serialized["attempts"], 2);
        assert_eq!(serialized["started_at"], "2025-06-01T10:00:00+00:00");
        assert_eq!(serialized["finished_at"], "2025-06-01T10:05:00+00:00");
        assert!(serialized["last_error"].is_null());
        assert_eq!(serialized["artifact_count"], 3);
        assert_eq!(serialized["artifacts"].as_array().unwrap().len(), 1);
        assert_eq!(serialized["artifacts"][0]["id"], "art-001");
        assert_eq!(serialized["artifacts"][0]["kind"], "file");

        // Round-trip deserialization
        let deserialized: NodeStatusDetail = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.node_id, "relax_slab");
        assert_eq!(deserialized.status, NodeStatus::Succeeded);
        assert_eq!(deserialized.attempts, 2);
        assert_eq!(deserialized.started_at, Some("2025-06-01T10:00:00+00:00".to_string()));
        assert_eq!(deserialized.finished_at, Some("2025-06-01T10:05:00+00:00".to_string()));
        assert!(deserialized.last_error.is_none());
        assert_eq!(deserialized.artifact_count, 3);
        assert_eq!(deserialized.artifacts.len(), 1);
    }

    #[test]
    fn test_graph_run_detail_serialization() {
        let detail = GraphRunDetail {
            id: "run-042".to_string(),
            template_id: "oer_screen".to_string(),
            status: GraphRunStatus::Running,
            created_at: "2025-06-01T09:00:00+00:00".to_string(),
            updated_at: "2025-06-01T10:00:00+00:00".to_string(),
            node_count: 2,
            nodes: vec![
                NodeStatusDetail {
                    node_id: "relax".to_string(),
                    status: NodeStatus::Succeeded,
                    attempts: 1,
                    started_at: Some("2025-06-01T09:01:00+00:00".to_string()),
                    finished_at: Some("2025-06-01T09:30:00+00:00".to_string()),
                    last_error: None,
                    artifact_count: 1,
                    artifacts: vec![],
                    repair_count: 0,
                    rewrite_source: None,
                },
                NodeStatusDetail {
                    node_id: "adsorb".to_string(),
                    status: NodeStatus::Running,
                    attempts: 1,
                    started_at: Some("2025-06-01T09:31:00+00:00".to_string()),
                    finished_at: None,
                    last_error: None,
                    artifact_count: 0,
                    artifacts: vec![],
                    repair_count: 0,
                    rewrite_source: None,
                },
            ],
            rewrite_events: vec![],
        };

        let serialized = serde_json::to_value(&detail).unwrap();

        // Top-level fields
        assert_eq!(serialized["id"], "run-042");
        assert_eq!(serialized["template_id"], "oer_screen");
        assert_eq!(serialized["status"], "running");
        assert_eq!(serialized["node_count"], 2);
        assert_eq!(serialized["created_at"], "2025-06-01T09:00:00+00:00");
        assert_eq!(serialized["updated_at"], "2025-06-01T10:00:00+00:00");

        // Nodes array structure
        let nodes = serialized["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0]["node_id"], "relax");
        assert_eq!(nodes[0]["status"], "succeeded");
        assert_eq!(nodes[1]["node_id"], "adsorb");
        assert_eq!(nodes[1]["status"], "running");
        assert!(nodes[1]["finished_at"].is_null());

        // Round-trip deserialization
        let deserialized: GraphRunDetail = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.id, "run-042");
        assert_eq!(deserialized.status, GraphRunStatus::Running);
        assert_eq!(deserialized.node_count, 2);
        assert_eq!(deserialized.nodes.len(), 2);
        assert_eq!(deserialized.nodes[0].node_id, "relax");
        assert_eq!(deserialized.nodes[0].status, NodeStatus::Succeeded);
        assert_eq!(deserialized.nodes[1].node_id, "adsorb");
        assert_eq!(deserialized.nodes[1].status, NodeStatus::Running);
        assert!(deserialized.nodes[1].finished_at.is_none());
    }

    #[test]
    fn test_rewrite_event_summary_serialization() {
        let summary = RewriteEventSummary {
            event_id: "evt-001".to_string(),
            rule_id: "refine_if_low".to_string(),
            source_node: "relax".to_string(),
            injected_template_id: "refinement_v1".to_string(),
            injected_node_count: 3,
            applied_at: "2025-06-01T10:00:00+00:00".to_string(),
        };

        let serialized = serde_json::to_value(&summary).unwrap();
        assert_eq!(serialized["event_id"], "evt-001");
        assert_eq!(serialized["rule_id"], "refine_if_low");
        assert_eq!(serialized["source_node"], "relax");
        assert_eq!(serialized["injected_template_id"], "refinement_v1");
        assert_eq!(serialized["injected_node_count"], 3);

        let deserialized: RewriteEventSummary = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.event_id, "evt-001");
        assert_eq!(deserialized.injected_node_count, 3);
    }

    #[test]
    fn test_rewrite_source_info_serialization() {
        let info = RewriteSourceInfo {
            rewrite_event_id: "evt-001".to_string(),
            rewrite_rule_id: "refine_if_low".to_string(),
            source_node: "relax".to_string(),
        };

        let serialized = serde_json::to_value(&info).unwrap();
        assert_eq!(serialized["rewrite_event_id"], "evt-001");
        assert_eq!(serialized["rewrite_rule_id"], "refine_if_low");
        assert_eq!(serialized["source_node"], "relax");

        let deserialized: RewriteSourceInfo = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.rewrite_event_id, "evt-001");
    }

    #[test]
    fn test_node_status_detail_with_rewrite_source() {
        let detail = NodeStatusDetail {
            node_id: "refine/optimize".to_string(),
            status: NodeStatus::Succeeded,
            attempts: 1,
            started_at: Some("2025-06-01T10:00:00+00:00".to_string()),
            finished_at: Some("2025-06-01T10:05:00+00:00".to_string()),
            last_error: None,
            artifact_count: 0,
            artifacts: vec![],
            repair_count: 0,
            rewrite_source: Some(RewriteSourceInfo {
                rewrite_event_id: "evt-001".to_string(),
                rewrite_rule_id: "refine_if_low".to_string(),
                source_node: "relax".to_string(),
            }),
        };

        let serialized = serde_json::to_value(&detail).unwrap();
        assert!(serialized["rewrite_source"].is_object());
        assert_eq!(serialized["rewrite_source"]["rewrite_event_id"], "evt-001");

        // Without rewrite source - field should be absent
        let detail_no_rewrite = NodeStatusDetail {
            node_id: "relax".to_string(),
            status: NodeStatus::Succeeded,
            attempts: 1,
            started_at: None,
            finished_at: None,
            last_error: None,
            artifact_count: 0,
            artifacts: vec![],
            repair_count: 0,
            rewrite_source: None,
        };

        let serialized2 = serde_json::to_value(&detail_no_rewrite).unwrap();
        assert!(serialized2.get("rewrite_source").is_none());
    }

    #[test]
    fn test_template_summary_serialization() {
        let summary = TemplateSummary {
            id: "oer_screen".to_string(),
            version: "3.1.0".to_string(),
            description: Some("OER catalyst screening".to_string()),
            node_count: 5,
        };

        let serialized = serde_json::to_value(&summary).unwrap();

        assert_eq!(serialized["id"], "oer_screen");
        assert_eq!(serialized["version"], "3.1.0");
        assert_eq!(serialized["description"], "OER catalyst screening");
        assert_eq!(serialized["node_count"], 5);

        // Verify round-trip
        let deserialized: TemplateSummary = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.id, "oer_screen");
        assert_eq!(deserialized.version, "3.1.0");
        assert_eq!(deserialized.description, Some("OER catalyst screening".to_string()));
        assert_eq!(deserialized.node_count, 5);
    }
}

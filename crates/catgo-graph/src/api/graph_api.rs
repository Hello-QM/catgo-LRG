use std::collections::HashMap;
use std::sync::RwLock;

use crate::api::dto::*;
use crate::core::errors::EngineError;
use crate::core::state::NodeStatus;
use crate::graph::template::GraphTemplate;
use crate::runtime::engine::GraphEngine;

/// Template registry: stores registered templates for agent discovery.
/// Lives in the API layer (not the runtime core) because template management
/// is an agent-facing concern, not an execution concern.
pub struct TemplateRegistry {
    /// Latest version by ID (backward compatible)
    templates: RwLock<HashMap<String, GraphTemplate>>,
    /// Versioned index: (id, version) -> template
    versioned: RwLock<HashMap<(String, String), GraphTemplate>>,
}

impl TemplateRegistry {
    pub fn new() -> Self {
        Self {
            templates: RwLock::new(HashMap::new()),
            versioned: RwLock::new(HashMap::new()),
        }
    }

    /// Register a template. Stores by ID (latest) and by (ID, version).
    pub fn register(&self, template: GraphTemplate) {
        let id = template.id.clone();
        let version = template.version.clone();

        // Store as latest
        self.templates.write().unwrap().insert(id.clone(), template.clone());
        // Store versioned
        self.versioned.write().unwrap().insert((id, version), template);
    }

    pub fn get(&self, id: &str) -> Option<GraphTemplate> {
        self.templates.read().unwrap().get(id).cloned()
    }

    /// Get a template by ID and exact version.
    pub fn get_versioned(&self, id: &str, version: &str) -> Option<GraphTemplate> {
        self.versioned.read().unwrap()
            .get(&(id.to_string(), version.to_string()))
            .cloned()
    }

    pub fn list(&self) -> Vec<TemplateSummary> {
        let map = self.templates.read().unwrap();
        let mut summaries: Vec<TemplateSummary> = map
            .values()
            .map(|t| TemplateSummary {
                id: t.id.clone(),
                version: t.version.clone(),
                description: t.description.clone(),
                node_count: t.nodes.len(),
            })
            .collect();
        summaries.sort_by(|a, b| a.id.cmp(&b.id));
        summaries
    }

    pub fn list_full(&self) -> Vec<GraphTemplate> {
        let map = self.templates.read().unwrap();
        let mut templates: Vec<GraphTemplate> = map.values().cloned().collect();
        templates.sort_by(|a, b| a.id.cmp(&b.id));
        templates
    }
}

impl Default for TemplateRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Build hierarchical node tree from flat node runs.
///
/// Nodes without "/" in their ID are top-level.
/// Nodes with "/" are grouped under virtual subgraph group nodes.
/// E.g., "sub/inner_a" and "sub/inner_b" are grouped under a "sub" group.
/// Nested: "outer/middle/inner" goes under "outer" > "outer/middle".
fn build_node_hierarchy(node_runs: &[crate::graph::run::NodeRun]) -> Vec<NodeHierarchyDetail> {
    use std::collections::BTreeMap;

    // Separate top-level nodes from subgraph-expanded nodes.
    // Group expanded nodes by their first "/" segment.
    let mut top_level: Vec<NodeHierarchyDetail> = Vec::new();
    let mut groups: BTreeMap<String, Vec<&crate::graph::run::NodeRun>> = BTreeMap::new();

    for nr in node_runs {
        if let Some(slash_pos) = nr.node_id.find('/') {
            let group_name = nr.node_id[..slash_pos].to_string();
            groups.entry(group_name).or_default().push(nr);
        } else {
            // Top-level leaf node
            top_level.push(node_run_to_leaf(nr, &nr.node_id));
        }
    }

    // Build virtual group nodes for each subgraph group
    for (group_name, members) in &groups {
        let group_node = build_group_node(group_name, group_name, members);
        top_level.push(group_node);
    }

    top_level
}

/// Convert a NodeRun into a leaf NodeHierarchyDetail.
fn node_run_to_leaf(nr: &crate::graph::run::NodeRun, display_name: &str) -> NodeHierarchyDetail {
    NodeHierarchyDetail {
        node_id: display_name.to_string(),
        full_path: nr.node_id.clone(),
        status: nr.status,
        attempts: nr.current_attempt,
        started_at: nr.started_at.map(|t| t.to_rfc3339()),
        finished_at: nr.finished_at.map(|t| t.to_rfc3339()),
        last_error: nr.last_error.as_ref().map(|e| e.message.clone()),
        artifact_count: nr.artifacts.len(),
        is_subgraph_group: false,
        group_summary: None,
        children: vec![],
        rewrite_source: None,
    }
}

/// Recursively build a virtual group node from member NodeRuns.
///
/// `prefix` is the full path prefix for this group (e.g., "outer" or "outer/middle").
/// `display_name` is the leaf segment shown as node_id.
/// Members have their first segment already consumed; we strip `prefix/` from their node_id
/// to determine if they are direct children or need further nesting.
fn build_group_node(
    display_name: &str,
    prefix: &str,
    members: &[&crate::graph::run::NodeRun],
) -> NodeHierarchyDetail {
    use std::collections::BTreeMap;

    let mut direct_children: Vec<NodeHierarchyDetail> = Vec::new();
    let mut sub_groups: BTreeMap<String, Vec<&crate::graph::run::NodeRun>> = BTreeMap::new();

    let strip_prefix = format!("{}/", prefix);

    for nr in members {
        let remainder = nr.node_id.strip_prefix(&strip_prefix).unwrap_or(&nr.node_id);
        if let Some(slash_pos) = remainder.find('/') {
            let next_segment = &remainder[..slash_pos];
            sub_groups.entry(next_segment.to_string()).or_default().push(nr);
        } else {
            // Direct child leaf
            direct_children.push(node_run_to_leaf(nr, remainder));
        }
    }

    // Recursively build nested sub-groups
    for (sub_name, sub_members) in &sub_groups {
        let sub_prefix = format!("{}/{}", prefix, sub_name);
        let sub_group = build_group_node(sub_name, &sub_prefix, sub_members);
        direct_children.push(sub_group);
    }

    // Compute aggregate summary from all children (recursively)
    let summary = compute_group_summary(&direct_children);
    let worst_status = compute_worst_status(&direct_children);

    NodeHierarchyDetail {
        node_id: display_name.to_string(),
        full_path: prefix.to_string(),
        status: worst_status,
        attempts: 0,
        started_at: None,
        finished_at: None,
        last_error: None,
        artifact_count: 0,
        is_subgraph_group: true,
        group_summary: Some(summary),
        children: direct_children,
        rewrite_source: None,
    }
}

/// Compute aggregate GroupSummary from children (counts all leaf statuses recursively).
fn compute_group_summary(children: &[NodeHierarchyDetail]) -> GroupSummary {
    let mut summary = GroupSummary {
        total: 0,
        succeeded: 0,
        failed: 0,
        pending: 0,
        running: 0,
    };

    for child in children {
        if child.is_subgraph_group {
            // Aggregate from nested group summary
            if let Some(ref child_summary) = child.group_summary {
                summary.total += child_summary.total;
                summary.succeeded += child_summary.succeeded;
                summary.failed += child_summary.failed;
                summary.pending += child_summary.pending;
                summary.running += child_summary.running;
            }
        } else {
            // Leaf node: count by status
            summary.total += 1;
            match child.status {
                NodeStatus::Succeeded => summary.succeeded += 1,
                NodeStatus::Failed => summary.failed += 1,
                NodeStatus::Running | NodeStatus::Repairing => summary.running += 1,
                NodeStatus::Pending | NodeStatus::Ready | NodeStatus::Blocked => summary.pending += 1,
                NodeStatus::Skipped | NodeStatus::Cancelled => summary.succeeded += 1,
            }
        }
    }

    summary
}

/// Compute worst status of children.
/// Priority: Failed > Running > Pending > Succeeded.
fn compute_worst_status(children: &[NodeHierarchyDetail]) -> NodeStatus {
    let mut has_failed = false;
    let mut has_running = false;
    let mut has_pending = false;

    for child in children {
        match child.status {
            NodeStatus::Failed => has_failed = true,
            NodeStatus::Running | NodeStatus::Repairing => has_running = true,
            NodeStatus::Pending | NodeStatus::Ready | NodeStatus::Blocked => has_pending = true,
            _ => {}
        }
    }

    if has_failed {
        NodeStatus::Failed
    } else if has_running {
        NodeStatus::Running
    } else if has_pending {
        NodeStatus::Pending
    } else {
        NodeStatus::Succeeded
    }
}

/// Agent-facing API: higher-level wrappers that return DTOs suitable for
/// AI agent consumption (serializable, concise summaries).
impl GraphEngine {
    /// List all graph runs as summaries.
    pub fn list_graph_run_summaries(&self) -> Result<Vec<GraphRunSummary>, EngineError> {
        let runs = self.list_graph_runs()?;
        Ok(runs
            .iter()
            .map(|r| GraphRunSummary {
                id: r.id.clone(),
                template_id: r.template_id.clone(),
                status: r.status,
                node_count: r.node_runs.len(),
                succeeded: r.node_runs.iter().filter(|n| n.status == NodeStatus::Succeeded).count(),
                failed: r.node_runs.iter().filter(|n| n.status == NodeStatus::Failed).count(),
                pending: r.node_runs.iter().filter(|n| n.status == NodeStatus::Pending).count(),
                created_at: r.created_at.to_rfc3339(),
                updated_at: r.updated_at.to_rfc3339(),
            })
            .collect())
    }

    /// Get a structured description of a graph template.
    pub fn get_template_info(&self, template: &GraphTemplate) -> GraphTemplateInfo {
        GraphTemplateInfo {
            id: template.id.clone(),
            version: template.version.clone(),
            description: template.description.clone(),
            inputs_schema: template.inputs_schema.clone(),
            node_count: template.nodes.len(),
            node_ids: template.nodes.iter().map(|n| n.id.clone()).collect(),
            output_names: template.outputs.iter().map(|o| o.name.clone()).collect(),
            has_rewrite_rules: !template.rewrite_rules.is_empty(),
            rewrite_rule_count: template.rewrite_rules.len(),
        }
    }

    /// Get node-level summaries for a run.
    pub fn get_node_summaries(&self, run_id: &str) -> Result<Vec<NodeRunSummary>, EngineError> {
        let run = self.get_graph_status(run_id)?;
        Ok(run
            .node_runs
            .iter()
            .map(|nr| NodeRunSummary {
                node_id: nr.node_id.clone(),
                status: nr.status,
                attempts: nr.current_attempt,
                has_error: nr.last_error.is_some(),
                artifact_count: nr.artifacts.len(),
                tool_name: None,
                last_error_message: nr.last_error.as_ref().map(|e| e.message.clone()),
                repair_count: nr.repair_count,
            })
            .collect())
    }

    /// List artifacts grouped by node for a run.
    pub fn get_node_artifacts(&self, run_id: &str) -> Result<Vec<NodeArtifacts>, EngineError> {
        let pairs = self.list_graph_artifacts(run_id)?;
        Ok(pairs
            .into_iter()
            .map(|(node_id, artifacts)| NodeArtifacts {
                node_id,
                artifacts,
            })
            .collect())
    }

    /// Get full run detail for frontend monitoring (Phase 7).
    /// Returns everything a workflow UI panel needs in a single call.
    pub fn get_run_detail(&self, run_id: &str) -> Result<GraphRunDetail, EngineError> {
        let run = self.get_graph_status(run_id)?;
        let nodes = run
            .node_runs
            .iter()
            .map(|nr| NodeStatusDetail {
                node_id: nr.node_id.clone(),
                status: nr.status,
                attempts: nr.current_attempt,
                started_at: nr.started_at.map(|t| t.to_rfc3339()),
                finished_at: nr.finished_at.map(|t| t.to_rfc3339()),
                last_error: nr.last_error.as_ref().map(|e| e.message.clone()),
                artifact_count: nr.artifacts.len(),
                artifacts: nr.artifacts.clone(),
                repair_count: nr.repair_count,
                rewrite_source: None,
            })
            .collect();

        Ok(GraphRunDetail {
            id: run.id,
            template_id: run.template_id,
            status: run.status,
            created_at: run.created_at.to_rfc3339(),
            updated_at: run.updated_at.to_rfc3339(),
            node_count: run.node_runs.len(),
            nodes,
            rewrite_events: run.rewrite_events.iter().map(|e| RewriteEventSummary {
                event_id: e.event_id.clone(),
                rule_id: e.rule_id.clone(),
                source_node: e.source_node.clone(),
                injected_template_id: e.injected_template_id.clone(),
                injected_node_count: e.injected_node_ids.len(),
                applied_at: e.applied_at.clone(),
            }).collect(),
        })
    }

    /// Get hierarchical run detail for frontend monitoring.
    ///
    /// Reconstructs subgraph hierarchy from "/" separators in node IDs.
    /// Top-level nodes appear directly; expanded subgraph nodes are grouped
    /// under virtual "subgraph group" nodes.
    pub fn get_run_hierarchy(&self, run_id: &str) -> Result<GraphHierarchyDetail, EngineError> {
        let run = self.get_graph_status(run_id)?;

        // Build hierarchy from node IDs
        let hierarchy_nodes = build_node_hierarchy(&run.node_runs);

        Ok(GraphHierarchyDetail {
            id: run.id,
            template_id: run.template_id,
            status: run.status,
            created_at: run.created_at.to_rfc3339(),
            updated_at: run.updated_at.to_rfc3339(),
            node_count: run.node_runs.len(),
            nodes: hierarchy_nodes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::state::GraphRunStatus;
    use crate::graph::template::{GraphOutputSpec, GraphTemplate, NodeTemplate};
    use crate::runtime::engine::RuntimeConfig;
    use crate::storage::file_store::FileArtifactStore;
    use crate::storage::sqlite_store::SqliteStateStore;
    use crate::tools::mock::EchoTool;
    use crate::tools::registry::ToolRegistry;
    use serde_json::json;
    use std::sync::Arc;

    /// Build a GraphEngine with in-memory SQLite and a tempdir for artifacts.
    fn test_engine() -> GraphEngine {
        let state_store = Arc::new(
            SqliteStateStore::new(":memory:").expect("in-memory SQLite should work"),
        );
        let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-graph-test-artifacts"));

        let mut tool_registry = ToolRegistry::new();
        tool_registry.register(Arc::new(EchoTool::new("echo")));

        GraphEngine::new(
            RuntimeConfig {
                max_concurrent_nodes: 2,
                artifact_root: "/tmp/catgo-graph-test-artifacts".into(),
                state_db_path: ":memory:".into(),
            },
            tool_registry,
            state_store,
            artifact_store,
        )
    }

    /// Build a simple two-node template where both nodes use the "echo" tool.
    fn test_template() -> GraphTemplate {
        GraphTemplate {
            id: "test-workflow".to_string(),
            version: "1.0.0".to_string(),
            description: Some("A test workflow".to_string()),
            inputs_schema: json!({"type": "object"}),
            nodes: vec![
                NodeTemplate {
                    id: "node-a".to_string(),
                    tool: "echo".to_string(),
                    depends_on: vec![],
                    input_bindings: json!({}),
                    output_spec: None,
                    retry_policy: None,
                    timeout_seconds: None,
                    repair_policy: None,
                    execution_mode: Default::default(),
                    skip_condition: None,
                    subgraph: None,
                    metadata: Default::default(),
                },
                NodeTemplate {
                    id: "node-b".to_string(),
                    tool: "echo".to_string(),
                    depends_on: vec!["node-a".to_string()],
                    input_bindings: json!({}),
                    output_spec: None,
                    retry_policy: None,
                    timeout_seconds: None,
                    repair_policy: None,
                    execution_mode: Default::default(),
                    skip_condition: None,
                    subgraph: None,
                    metadata: Default::default(),
                },
            ],
            outputs: vec![GraphOutputSpec {
                name: "result".to_string(),
                source: "${nodes.node-b.outputs.data}".to_string(),
            }],
            metadata: Default::default(),
            rewrite_rules: vec![],
        }
    }

    #[test]
    fn test_list_graph_run_summaries_empty() {
        let engine = test_engine();
        let summaries = engine.list_graph_run_summaries().unwrap();
        assert!(summaries.is_empty());
    }

    #[tokio::test]
    async fn test_list_graph_run_summaries_after_run() {
        let engine = test_engine();
        let template = test_template();

        let mut run = engine
            .instantiate_graph(&template, json!({"structure": "Si"}))
            .unwrap();

        engine.run_graph(&mut run, &template).await.unwrap();

        let summaries = engine.list_graph_run_summaries().unwrap();
        assert_eq!(summaries.len(), 1);

        let summary = &summaries[0];
        assert_eq!(summary.template_id, "test-workflow");
        assert_eq!(summary.node_count, 2);
        // After a successful run, both nodes should have succeeded
        assert_eq!(summary.succeeded, 2);
        assert_eq!(summary.failed, 0);
        assert_eq!(summary.pending, 0);
    }

    #[test]
    fn test_get_template_info() {
        let engine = test_engine();
        let template = test_template();

        let info = engine.get_template_info(&template);

        assert_eq!(info.id, "test-workflow");
        assert_eq!(info.version, "1.0.0");
        assert_eq!(info.description, Some("A test workflow".to_string()));
        assert_eq!(info.node_count, 2);
        assert_eq!(info.node_ids, vec!["node-a", "node-b"]);
        assert_eq!(info.output_names, vec!["result"]);
        assert_eq!(info.inputs_schema, json!({"type": "object"}));
    }

    #[tokio::test]
    async fn test_get_node_summaries() {
        let engine = test_engine();
        let template = test_template();

        let mut run = engine
            .instantiate_graph(&template, json!({"x": 1}))
            .unwrap();

        engine.run_graph(&mut run, &template).await.unwrap();

        let summaries = engine.get_node_summaries(&run.id).unwrap();
        assert_eq!(summaries.len(), 2);

        // Both nodes should have succeeded
        for summary in &summaries {
            assert_eq!(summary.status, NodeStatus::Succeeded);
            assert!(!summary.has_error);
        }

        // Verify node IDs are present
        let node_ids: Vec<&str> = summaries.iter().map(|s| s.node_id.as_str()).collect();
        assert!(node_ids.contains(&"node-a"));
        assert!(node_ids.contains(&"node-b"));
    }

    #[tokio::test]
    async fn test_get_node_artifacts_empty() {
        let engine = test_engine();
        let template = test_template();

        let mut run = engine
            .instantiate_graph(&template, json!({}))
            .unwrap();

        engine.run_graph(&mut run, &template).await.unwrap();

        // EchoTool produces no artifacts, so the list should be empty
        let artifacts = engine.get_node_artifacts(&run.id).unwrap();
        assert!(artifacts.is_empty());
    }

    // ---- Phase 6: Template Registry tests ----

    #[test]
    fn test_template_registry_register_and_list() {
        let registry = TemplateRegistry::new();

        // Register two templates (inserted in reverse alphabetical order)
        let mut t1 = test_template();
        t1.id = "beta-workflow".to_string();
        t1.version = "2.0.0".to_string();
        t1.description = Some("Beta workflow".to_string());

        let mut t2 = test_template();
        t2.id = "alpha-workflow".to_string();
        t2.version = "1.0.0".to_string();
        t2.description = Some("Alpha workflow".to_string());

        registry.register(t1);
        registry.register(t2);

        let summaries = registry.list();
        assert_eq!(summaries.len(), 2);

        // list() returns sorted by id
        assert_eq!(summaries[0].id, "alpha-workflow");
        assert_eq!(summaries[0].version, "1.0.0");
        assert_eq!(summaries[0].description, Some("Alpha workflow".to_string()));
        assert_eq!(summaries[0].node_count, 2);

        assert_eq!(summaries[1].id, "beta-workflow");
        assert_eq!(summaries[1].version, "2.0.0");
        assert_eq!(summaries[1].description, Some("Beta workflow".to_string()));
        assert_eq!(summaries[1].node_count, 2);
    }

    #[test]
    fn test_template_registry_get() {
        let registry = TemplateRegistry::new();

        let template = test_template();
        registry.register(template.clone());

        // get() for registered template returns Some
        let retrieved = registry.get("test-workflow");
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.id, "test-workflow");
        assert_eq!(retrieved.version, "1.0.0");
        assert_eq!(retrieved.nodes.len(), 2);

        // get() for nonexistent template returns None
        assert!(registry.get("nonexistent").is_none());
    }

    #[test]
    fn test_template_registry_list_full() {
        let registry = TemplateRegistry::new();

        let mut t1 = test_template();
        t1.id = "beta-workflow".to_string();

        let mut t2 = test_template();
        t2.id = "alpha-workflow".to_string();

        registry.register(t1);
        registry.register(t2);

        let full = registry.list_full();
        assert_eq!(full.len(), 2);

        // list_full() returns full GraphTemplate objects, sorted by id
        assert_eq!(full[0].id, "alpha-workflow");
        assert_eq!(full[1].id, "beta-workflow");

        // Verify they contain full node data
        assert_eq!(full[0].nodes.len(), 2);
        assert_eq!(full[0].nodes[0].id, "node-a");
        assert_eq!(full[0].nodes[1].id, "node-b");
        assert_eq!(full[1].nodes.len(), 2);
    }

    #[tokio::test]
    async fn test_get_run_detail() {
        let engine = test_engine();
        let template = test_template();

        let mut run = engine
            .instantiate_graph(&template, json!({"structure": "Si"}))
            .unwrap();

        engine.run_graph(&mut run, &template).await.unwrap();

        let detail = engine.get_run_detail(&run.id).unwrap();

        // Top-level fields
        assert_eq!(detail.id, run.id);
        assert_eq!(detail.template_id, "test-workflow");
        assert_eq!(detail.status, GraphRunStatus::Succeeded);
        assert_eq!(detail.node_count, 2);
        assert!(!detail.created_at.is_empty());
        assert!(!detail.updated_at.is_empty());

        // Node-level details
        assert_eq!(detail.nodes.len(), 2);

        for node in &detail.nodes {
            assert_eq!(node.status, NodeStatus::Succeeded);
            assert!(node.started_at.is_some(), "succeeded node should have started_at");
            assert!(node.finished_at.is_some(), "succeeded node should have finished_at");
            assert!(node.last_error.is_none());
            // EchoTool produces no artifacts
            assert_eq!(node.artifact_count, 0);
            assert!(node.artifacts.is_empty());
        }

        // Verify both node IDs are present
        let node_ids: Vec<&str> = detail.nodes.iter().map(|n| n.node_id.as_str()).collect();
        assert!(node_ids.contains(&"node-a"));
        assert!(node_ids.contains(&"node-b"));
    }

    #[test]
    fn test_get_run_detail_partial() {
        let engine = test_engine();
        let template = test_template();

        // Instantiate but do NOT run — all nodes should be Pending
        let run = engine
            .instantiate_graph(&template, json!({"structure": "Si"}))
            .unwrap();

        let detail = engine.get_run_detail(&run.id).unwrap();

        assert_eq!(detail.id, run.id);
        assert_eq!(detail.template_id, "test-workflow");
        assert_eq!(detail.node_count, 2);
        assert_eq!(detail.nodes.len(), 2);

        // All nodes should be Pending with no timestamps
        for node in &detail.nodes {
            assert_eq!(node.status, NodeStatus::Pending);
            assert!(node.started_at.is_none(), "pending node should have no started_at");
            assert!(node.finished_at.is_none(), "pending node should have no finished_at");
            assert!(node.last_error.is_none());
            assert_eq!(node.artifact_count, 0);
            assert_eq!(node.attempts, 0);
        }
    }

    // ---- Monitoring hierarchy tests ----

    use crate::graph::run::NodeRun;

    /// Helper: create a NodeRun with given id and status.
    fn make_node_run(node_id: &str, status: NodeStatus) -> NodeRun {
        let mut nr = NodeRun::new(node_id.to_string());
        nr.status = status;
        nr
    }

    #[test]
    fn test_get_run_hierarchy_flat() {
        // No subgraph nodes: all top-level, no groups
        let node_runs = vec![
            make_node_run("setup", NodeStatus::Succeeded),
            make_node_run("compute", NodeStatus::Running),
            make_node_run("cleanup", NodeStatus::Pending),
        ];

        let hierarchy = build_node_hierarchy(&node_runs);

        assert_eq!(hierarchy.len(), 3);
        for node in &hierarchy {
            assert!(!node.is_subgraph_group);
            assert!(node.group_summary.is_none());
            assert!(node.children.is_empty());
        }

        // Verify node IDs
        let ids: Vec<&str> = hierarchy.iter().map(|n| n.node_id.as_str()).collect();
        assert!(ids.contains(&"setup"));
        assert!(ids.contains(&"compute"));
        assert!(ids.contains(&"cleanup"));
    }

    #[test]
    fn test_get_run_hierarchy_with_subgraph() {
        // "setup" is top-level; "sub/inner_a" and "sub/inner_b" form a group
        let node_runs = vec![
            make_node_run("setup", NodeStatus::Succeeded),
            make_node_run("sub/inner_a", NodeStatus::Succeeded),
            make_node_run("sub/inner_b", NodeStatus::Failed),
        ];

        let hierarchy = build_node_hierarchy(&node_runs);

        // Should have 2 top-level entries: "setup" (leaf) and "sub" (group)
        assert_eq!(hierarchy.len(), 2);

        // Find setup
        let setup = hierarchy.iter().find(|n| n.node_id == "setup").unwrap();
        assert!(!setup.is_subgraph_group);
        assert_eq!(setup.full_path, "setup");
        assert_eq!(setup.status, NodeStatus::Succeeded);

        // Find sub group
        let sub_group = hierarchy.iter().find(|n| n.node_id == "sub").unwrap();
        assert!(sub_group.is_subgraph_group);
        assert_eq!(sub_group.full_path, "sub");
        assert_eq!(sub_group.children.len(), 2);

        // Children should be inner_a and inner_b
        let child_ids: Vec<&str> = sub_group.children.iter().map(|c| c.node_id.as_str()).collect();
        assert!(child_ids.contains(&"inner_a"));
        assert!(child_ids.contains(&"inner_b"));

        // inner_a should have full_path "sub/inner_a"
        let inner_a = sub_group.children.iter().find(|c| c.node_id == "inner_a").unwrap();
        assert_eq!(inner_a.full_path, "sub/inner_a");
        assert!(!inner_a.is_subgraph_group);

        // inner_b should have full_path "sub/inner_b"
        let inner_b = sub_group.children.iter().find(|c| c.node_id == "inner_b").unwrap();
        assert_eq!(inner_b.full_path, "sub/inner_b");
        assert!(!inner_b.is_subgraph_group);
    }

    #[test]
    fn test_get_run_hierarchy_nested() {
        // "outer/middle/inner" -> nested groups: outer > middle > inner
        let node_runs = vec![
            make_node_run("outer/middle/inner", NodeStatus::Succeeded),
        ];

        let hierarchy = build_node_hierarchy(&node_runs);

        // Top level: one "outer" group
        assert_eq!(hierarchy.len(), 1);
        let outer = &hierarchy[0];
        assert_eq!(outer.node_id, "outer");
        assert!(outer.is_subgraph_group);
        assert_eq!(outer.full_path, "outer");

        // Middle group inside outer
        assert_eq!(outer.children.len(), 1);
        let middle = &outer.children[0];
        assert_eq!(middle.node_id, "middle");
        assert!(middle.is_subgraph_group);
        assert_eq!(middle.full_path, "outer/middle");

        // Inner leaf inside middle
        assert_eq!(middle.children.len(), 1);
        let inner = &middle.children[0];
        assert_eq!(inner.node_id, "inner");
        assert!(!inner.is_subgraph_group);
        assert_eq!(inner.full_path, "outer/middle/inner");
        assert_eq!(inner.status, NodeStatus::Succeeded);
    }

    #[test]
    fn test_hierarchy_group_summary() {
        // Group with mixed statuses: verify GroupSummary counts
        let node_runs = vec![
            make_node_run("grp/a", NodeStatus::Succeeded),
            make_node_run("grp/b", NodeStatus::Succeeded),
            make_node_run("grp/c", NodeStatus::Failed),
            make_node_run("grp/d", NodeStatus::Pending),
            make_node_run("grp/e", NodeStatus::Running),
        ];

        let hierarchy = build_node_hierarchy(&node_runs);

        assert_eq!(hierarchy.len(), 1);
        let group = &hierarchy[0];
        assert!(group.is_subgraph_group);
        assert_eq!(group.node_id, "grp");

        let summary = group.group_summary.as_ref().unwrap();
        assert_eq!(summary.total, 5);
        assert_eq!(summary.succeeded, 2);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.pending, 1);
        assert_eq!(summary.running, 1);
    }

    #[test]
    fn test_hierarchy_group_status() {
        // Group status should reflect worst child status:
        // Failed > Running > Pending > Succeeded

        // Case 1: has Failed child -> group is Failed
        let node_runs = vec![
            make_node_run("g1/a", NodeStatus::Succeeded),
            make_node_run("g1/b", NodeStatus::Failed),
        ];
        let hierarchy = build_node_hierarchy(&node_runs);
        assert_eq!(hierarchy[0].status, NodeStatus::Failed);

        // Case 2: has Running child (no Failed) -> group is Running
        let node_runs = vec![
            make_node_run("g2/a", NodeStatus::Succeeded),
            make_node_run("g2/b", NodeStatus::Running),
        ];
        let hierarchy = build_node_hierarchy(&node_runs);
        assert_eq!(hierarchy[0].status, NodeStatus::Running);

        // Case 3: has Pending child (no Failed, no Running) -> group is Pending
        let node_runs = vec![
            make_node_run("g3/a", NodeStatus::Succeeded),
            make_node_run("g3/b", NodeStatus::Pending),
        ];
        let hierarchy = build_node_hierarchy(&node_runs);
        assert_eq!(hierarchy[0].status, NodeStatus::Pending);

        // Case 4: all Succeeded -> group is Succeeded
        let node_runs = vec![
            make_node_run("g4/a", NodeStatus::Succeeded),
            make_node_run("g4/b", NodeStatus::Succeeded),
        ];
        let hierarchy = build_node_hierarchy(&node_runs);
        assert_eq!(hierarchy[0].status, NodeStatus::Succeeded);
    }

    // ---- Versioned registry tests ----

    #[test]
    fn test_versioned_registry_register_and_get() {
        let registry = TemplateRegistry::new();

        let mut t1 = test_template();
        t1.id = "workflow-a".to_string();
        t1.version = "1.0.0".to_string();

        let mut t2 = test_template();
        t2.id = "workflow-a".to_string();
        t2.version = "2.0.0".to_string();
        t2.description = Some("Version 2".to_string());

        registry.register(t1);
        registry.register(t2);

        // get_versioned returns correct version
        let v1 = registry.get_versioned("workflow-a", "1.0.0").unwrap();
        assert_eq!(v1.version, "1.0.0");
        assert_eq!(v1.description, Some("A test workflow".to_string()));

        let v2 = registry.get_versioned("workflow-a", "2.0.0").unwrap();
        assert_eq!(v2.version, "2.0.0");
        assert_eq!(v2.description, Some("Version 2".to_string()));
    }

    #[test]
    fn test_versioned_registry_latest_is_last_registered() {
        let registry = TemplateRegistry::new();

        let mut t1 = test_template();
        t1.id = "workflow-a".to_string();
        t1.version = "1.0.0".to_string();
        t1.description = Some("Version 1".to_string());

        let mut t2 = test_template();
        t2.id = "workflow-a".to_string();
        t2.version = "2.0.0".to_string();
        t2.description = Some("Version 2".to_string());

        registry.register(t1);
        registry.register(t2);

        // get() (latest) returns the most recently registered version
        let latest = registry.get("workflow-a").unwrap();
        assert_eq!(latest.version, "2.0.0");
        assert_eq!(latest.description, Some("Version 2".to_string()));
    }

    #[test]
    fn test_versioned_registry_get_nonexistent_version() {
        let registry = TemplateRegistry::new();

        let mut t = test_template();
        t.id = "workflow-a".to_string();
        t.version = "1.0.0".to_string();
        registry.register(t);

        // Nonexistent version returns None
        assert!(registry.get_versioned("workflow-a", "9.9.9").is_none());
        // Nonexistent id returns None
        assert!(registry.get_versioned("nonexistent", "1.0.0").is_none());
    }

    #[test]
    fn test_versioned_registry_multiple_templates_multiple_versions() {
        let registry = TemplateRegistry::new();

        // Template A with versions 1.0 and 2.0
        let mut a1 = test_template();
        a1.id = "template-a".to_string();
        a1.version = "1.0.0".to_string();
        a1.description = Some("A v1".to_string());

        let mut a2 = test_template();
        a2.id = "template-a".to_string();
        a2.version = "2.0.0".to_string();
        a2.description = Some("A v2".to_string());

        // Template B with versions 1.0 and 3.0
        let mut b1 = test_template();
        b1.id = "template-b".to_string();
        b1.version = "1.0.0".to_string();
        b1.description = Some("B v1".to_string());

        let mut b2 = test_template();
        b2.id = "template-b".to_string();
        b2.version = "3.0.0".to_string();
        b2.description = Some("B v3".to_string());

        registry.register(a1);
        registry.register(a2);
        registry.register(b1);
        registry.register(b2);

        // Versioned lookups work independently
        assert_eq!(registry.get_versioned("template-a", "1.0.0").unwrap().description, Some("A v1".to_string()));
        assert_eq!(registry.get_versioned("template-a", "2.0.0").unwrap().description, Some("A v2".to_string()));
        assert_eq!(registry.get_versioned("template-b", "1.0.0").unwrap().description, Some("B v1".to_string()));
        assert_eq!(registry.get_versioned("template-b", "3.0.0").unwrap().description, Some("B v3".to_string()));

        // Cross-version lookups return None
        assert!(registry.get_versioned("template-a", "3.0.0").is_none());
        assert!(registry.get_versioned("template-b", "2.0.0").is_none());

        // Latest by ID
        assert_eq!(registry.get("template-a").unwrap().version, "2.0.0");
        assert_eq!(registry.get("template-b").unwrap().version, "3.0.0");

        // list() returns 2 templates (latest per ID)
        let summaries = registry.list();
        assert_eq!(summaries.len(), 2);
    }
}

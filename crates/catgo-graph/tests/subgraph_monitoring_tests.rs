//! Integration tests for the monitoring hierarchy feature.
//!
//! Tests that `get_run_hierarchy()` correctly groups subgraph-expanded nodes
//! under virtual group nodes, supporting the frontend monitoring panel.

mod helpers;

use catgo_graph::*;
use catgo_graph::api::dto::{GraphHierarchyDetail, NodeHierarchyDetail, GroupSummary};
use catgo_graph::api::graph_api::TemplateRegistry;
use catgo_graph::graph::template::SubgraphRef;
use catgo_graph::storage::file_store::FileArtifactStore;
use catgo_graph::storage::sqlite_store::SqliteStateStore;
use catgo_graph::tools::mock::EchoTool;
use serde_json::json;
use std::sync::Arc;
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

fn make_engine(tmp: &std::path::Path) -> GraphEngine {
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(tmp));
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(EchoTool::new("echo")));
    GraphEngine::new(
        RuntimeConfig {
            max_concurrent_nodes: 2,
            artifact_root: tmp.to_str().unwrap().into(),
            state_db_path: ":memory:".into(),
        },
        tools,
        state_store,
        artifact_store,
    )
}

/// Create a simple flat template with the given node IDs (all using "echo" tool).
fn flat_template(id: &str, node_ids: Vec<&str>) -> GraphTemplate {
    let mut nodes = Vec::new();
    let mut prev: Option<String> = None;
    for nid in node_ids {
        let deps = match &prev {
            Some(p) => vec![p.clone()],
            None => vec![],
        };
        nodes.push(NodeTemplate {
            id: nid.to_string(),
            tool: "echo".to_string(),
            depends_on: deps,
            input_bindings: json!({}),
            output_spec: None,
            retry_policy: None,
            timeout_seconds: None,
            repair_policy: None,
            execution_mode: Default::default(),
            skip_condition: None,
            subgraph: None,
            metadata: Default::default(),
        });
        prev = Some(nid.to_string());
    }
    GraphTemplate {
        id: id.to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes,
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    }
}

/// Create a NodeTemplate that is a subgraph reference (not a tool node).
fn subgraph_node(id: &str, template_id: &str, deps: Vec<&str>) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: "".to_string(),
        depends_on: deps.into_iter().map(|s| s.to_string()).collect(),
        input_bindings: json!({}),
        output_spec: None,
        retry_policy: None,
        timeout_seconds: None,
        repair_policy: None,
        execution_mode: Default::default(),
        skip_condition: None,
        subgraph: Some(SubgraphRef {
            template_id: template_id.to_string(),
            version: None,
            input_map: json!({}),
        }),
        metadata: Default::default(),
    }
}

/// Create a simple tool node.
fn tool_node(id: &str, deps: Vec<&str>) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: "echo".to_string(),
        depends_on: deps.into_iter().map(|s| s.to_string()).collect(),
        input_bindings: json!({}),
        output_spec: None,
        retry_policy: None,
        timeout_seconds: None,
        repair_policy: None,
        execution_mode: Default::default(),
        skip_condition: None,
        subgraph: None,
        metadata: Default::default(),
    }
}

// ---------------------------------------------------------------------------
// Test 1: Flat workflow — no subgraphs, all nodes top-level
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_monitoring_flat_workflow() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());
    let template = flat_template("flat_wf", vec!["step_a", "step_b", "step_c"]);

    let mut run = engine
        .instantiate_graph(&template, json!({}))
        .expect("instantiate should succeed");

    engine.run_graph(&mut run, &template).await.unwrap();

    let hierarchy = engine.get_run_hierarchy(&run.id).unwrap();

    // All nodes should be at the top level (no groups)
    assert_eq!(hierarchy.node_count, 3);
    assert_eq!(hierarchy.nodes.len(), 3);

    for node in &hierarchy.nodes {
        assert!(
            !node.is_subgraph_group,
            "Flat workflow should have no subgraph groups, but '{}' is a group",
            node.node_id,
        );
        assert!(
            node.children.is_empty(),
            "Flat workflow nodes should have no children",
        );
        assert!(
            node.group_summary.is_none(),
            "Flat workflow nodes should have no group_summary",
        );
    }

    // Verify node IDs
    let ids: Vec<&str> = hierarchy.nodes.iter().map(|n| n.node_id.as_str()).collect();
    assert!(ids.contains(&"step_a"));
    assert!(ids.contains(&"step_b"));
    assert!(ids.contains(&"step_c"));
}

// ---------------------------------------------------------------------------
// Test 2: Workflow with subgraph — expanded nodes are grouped
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_monitoring_with_subgraph() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // Sub-template: inner_a -> inner_b
    let sub_template = GraphTemplate {
        id: "sub_wf".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![
            tool_node("inner_a", vec![]),
            tool_node("inner_b", vec!["inner_a"]),
        ],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    };

    // Parent: setup -> sub_step(subgraph) -> final_step
    let parent_template = GraphTemplate {
        id: "parent_wf".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![
            tool_node("setup", vec![]),
            subgraph_node("sub_step", "sub_wf", vec!["setup"]),
            tool_node("final_step", vec!["sub_step"]),
        ],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    };

    let registry = TemplateRegistry::new();
    registry.register(sub_template);

    let (mut run, expanded) = engine
        .instantiate_graph_with_subgraphs(&parent_template, json!({}), &registry)
        .unwrap();

    engine.run_graph(&mut run, &expanded).await.unwrap();

    let hierarchy = engine.get_run_hierarchy(&run.id).unwrap();

    // Should have 3 top-level entries:
    //   "setup" (leaf), "sub_step" (group), "final_step" (leaf)
    assert_eq!(hierarchy.nodes.len(), 3);

    // Find the subgraph group
    let group = hierarchy
        .nodes
        .iter()
        .find(|n| n.node_id == "sub_step")
        .expect("should have a 'sub_step' group node");

    assert!(group.is_subgraph_group, "sub_step should be a subgraph group");
    assert_eq!(group.children.len(), 2, "sub_step should have 2 children (inner_a, inner_b)");

    // Verify group_summary
    let summary = group.group_summary.as_ref().expect("group should have a summary");
    assert_eq!(summary.total, 2);
    assert_eq!(summary.succeeded, 2);
    assert_eq!(summary.failed, 0);
    assert_eq!(summary.pending, 0);

    // Verify children are leaf nodes, not groups
    for child in &group.children {
        assert!(!child.is_subgraph_group, "children should be leaf nodes");
        assert!(child.children.is_empty());
    }

    // Verify other top-level nodes
    let setup = hierarchy.nodes.iter().find(|n| n.node_id == "setup").unwrap();
    assert!(!setup.is_subgraph_group);

    let final_node = hierarchy.nodes.iter().find(|n| n.node_id == "final_step").unwrap();
    assert!(!final_node.is_subgraph_group);
}

// ---------------------------------------------------------------------------
// Test 3: Nested subgraphs — groups can contain groups
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_monitoring_nested_subgraph() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // Inner template: single leaf node
    let inner_template = GraphTemplate {
        id: "inner_tpl".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![tool_node("leaf", vec![])],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    };

    // Middle template: references inner_tpl + its own tool node
    let middle_template = GraphTemplate {
        id: "middle_tpl".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![
            subgraph_node("inner_sg", "inner_tpl", vec![]),
            tool_node("mid_step", vec!["inner_sg"]),
        ],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    };

    // Top-level template: references middle_tpl
    let top_template = GraphTemplate {
        id: "top_wf".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![
            subgraph_node("outer_sg", "middle_tpl", vec![]),
        ],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    };

    let registry = TemplateRegistry::new();
    registry.register(inner_template);
    registry.register(middle_template);

    let (mut run, expanded) = engine
        .instantiate_graph_with_subgraphs(&top_template, json!({}), &registry)
        .unwrap();

    engine.run_graph(&mut run, &expanded).await.unwrap();

    let hierarchy = engine.get_run_hierarchy(&run.id).unwrap();

    // Top-level should have one group: "outer_sg"
    assert_eq!(hierarchy.nodes.len(), 1);
    let outer_group = &hierarchy.nodes[0];
    assert!(outer_group.is_subgraph_group, "outer_sg should be a group");
    assert_eq!(outer_group.node_id, "outer_sg");
    assert_eq!(outer_group.full_path, "outer_sg");

    // outer_sg should contain: "inner_sg" (group) and "mid_step" (leaf)
    assert_eq!(outer_group.children.len(), 2);

    let inner_group = outer_group
        .children
        .iter()
        .find(|c| c.is_subgraph_group)
        .expect("should have a nested subgraph group (inner_sg)");
    assert_eq!(inner_group.node_id, "inner_sg");
    assert_eq!(inner_group.full_path, "outer_sg/inner_sg");

    // Inner group should contain the leaf node
    assert_eq!(inner_group.children.len(), 1);
    assert_eq!(inner_group.children[0].node_id, "leaf");
    assert_eq!(inner_group.children[0].full_path, "outer_sg/inner_sg/leaf");
    assert!(!inner_group.children[0].is_subgraph_group);

    // mid_step should be a leaf under outer_sg
    let mid_step = outer_group
        .children
        .iter()
        .find(|c| c.node_id == "mid_step")
        .expect("should have mid_step as direct child");
    assert!(!mid_step.is_subgraph_group);
    assert_eq!(mid_step.full_path, "outer_sg/mid_step");
}

// ---------------------------------------------------------------------------
// Test 4: Hierarchy JSON serialization — verify frontend-friendly structure
// ---------------------------------------------------------------------------

#[test]
fn test_monitoring_hierarchy_json_serialization() {
    // Construct a hierarchy manually to test serialization
    let hierarchy = GraphHierarchyDetail {
        id: "run-001".to_string(),
        template_id: "my_workflow".to_string(),
        status: GraphRunStatus::Succeeded,
        created_at: "2025-06-01T10:00:00+00:00".to_string(),
        updated_at: "2025-06-01T10:05:00+00:00".to_string(),
        node_count: 3,
        nodes: vec![
            NodeHierarchyDetail {
                node_id: "setup".to_string(),
                full_path: "setup".to_string(),
                status: NodeStatus::Succeeded,
                attempts: 1,
                started_at: Some("2025-06-01T10:00:00+00:00".to_string()),
                finished_at: Some("2025-06-01T10:01:00+00:00".to_string()),
                last_error: None,
                artifact_count: 0,
                is_subgraph_group: false,
                group_summary: None,
                children: vec![],
                rewrite_source: None,
            },
            NodeHierarchyDetail {
                node_id: "sub_step".to_string(),
                full_path: "sub_step".to_string(),
                status: NodeStatus::Succeeded,
                attempts: 0,
                started_at: None,
                finished_at: None,
                last_error: None,
                artifact_count: 0,
                is_subgraph_group: true,
                group_summary: Some(GroupSummary {
                    total: 2,
                    succeeded: 2,
                    failed: 0,
                    pending: 0,
                    running: 0,
                }),
                children: vec![
                    NodeHierarchyDetail {
                        node_id: "inner_a".to_string(),
                        full_path: "sub_step/inner_a".to_string(),
                        status: NodeStatus::Succeeded,
                        attempts: 1,
                        started_at: Some("2025-06-01T10:01:00+00:00".to_string()),
                        finished_at: Some("2025-06-01T10:02:00+00:00".to_string()),
                        last_error: None,
                        artifact_count: 0,
                        is_subgraph_group: false,
                        group_summary: None,
                        children: vec![],
                        rewrite_source: None,
                    },
                    NodeHierarchyDetail {
                        node_id: "inner_b".to_string(),
                        full_path: "sub_step/inner_b".to_string(),
                        status: NodeStatus::Succeeded,
                        attempts: 1,
                        started_at: Some("2025-06-01T10:02:00+00:00".to_string()),
                        finished_at: Some("2025-06-01T10:03:00+00:00".to_string()),
                        last_error: None,
                        artifact_count: 0,
                        is_subgraph_group: false,
                        group_summary: None,
                        children: vec![],
                        rewrite_source: None,
                    },
                ],
                rewrite_source: None,
            },
        ],
    };

    // Serialize to JSON
    let json_value = serde_json::to_value(&hierarchy).unwrap();

    // Top-level structure
    assert_eq!(json_value["id"], "run-001");
    assert_eq!(json_value["template_id"], "my_workflow");
    assert_eq!(json_value["status"], "succeeded");
    assert_eq!(json_value["node_count"], 3);

    // Nodes array
    let nodes = json_value["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 2);

    // First node: leaf
    assert_eq!(nodes[0]["node_id"], "setup");
    assert_eq!(nodes[0]["is_subgraph_group"], false);
    assert!(nodes[0]["children"].as_array().unwrap().is_empty());
    assert!(nodes[0]["group_summary"].is_null());

    // Second node: group
    assert_eq!(nodes[1]["node_id"], "sub_step");
    assert_eq!(nodes[1]["is_subgraph_group"], true);
    assert_eq!(nodes[1]["group_summary"]["total"], 2);
    assert_eq!(nodes[1]["group_summary"]["succeeded"], 2);
    assert_eq!(nodes[1]["children"].as_array().unwrap().len(), 2);
    assert_eq!(nodes[1]["children"][0]["node_id"], "inner_a");
    assert_eq!(nodes[1]["children"][0]["full_path"], "sub_step/inner_a");

    // Round-trip deserialization
    let deserialized: GraphHierarchyDetail = serde_json::from_value(json_value).unwrap();
    assert_eq!(deserialized.id, "run-001");
    assert_eq!(deserialized.nodes.len(), 2);
    assert!(deserialized.nodes[1].is_subgraph_group);
    assert_eq!(deserialized.nodes[1].children.len(), 2);
}

// ---------------------------------------------------------------------------
// Test 5: Flat API still works after running subgraph workflow
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_monitoring_flat_api_still_works() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // Sub-template
    let sub_template = GraphTemplate {
        id: "sub_wf".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![tool_node("inner_node", vec![])],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    };

    // Parent with subgraph
    let parent_template = GraphTemplate {
        id: "parent_wf".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![
            tool_node("pre", vec![]),
            subgraph_node("sg", "sub_wf", vec!["pre"]),
        ],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    };

    let registry = TemplateRegistry::new();
    registry.register(sub_template);

    let (mut run, expanded) = engine
        .instantiate_graph_with_subgraphs(&parent_template, json!({}), &registry)
        .unwrap();

    engine.run_graph(&mut run, &expanded).await.unwrap();

    // The existing flat API should still work
    let detail = engine.get_run_detail(&run.id).unwrap();

    assert_eq!(detail.status, GraphRunStatus::Succeeded);
    // Flat API returns expanded node IDs (pre, sg/inner_node)
    assert_eq!(detail.nodes.len(), 2);

    let flat_ids: Vec<&str> = detail.nodes.iter().map(|n| n.node_id.as_str()).collect();
    assert!(flat_ids.contains(&"pre"));
    assert!(flat_ids.contains(&"sg/inner_node"));

    // All nodes succeeded
    for node in &detail.nodes {
        assert_eq!(node.status, NodeStatus::Succeeded);
    }

    // Also verify get_run_hierarchy works on the same run
    let hierarchy = engine.get_run_hierarchy(&run.id).unwrap();
    assert_eq!(hierarchy.status, GraphRunStatus::Succeeded);
    // Hierarchy should group sg/inner_node under "sg"
    assert_eq!(hierarchy.nodes.len(), 2); // "pre" (leaf) + "sg" (group)
}

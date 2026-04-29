//! Integration tests for nested subgraph expansion and execution.
//!
//! Tests the subgraph composition system where a node with `subgraph: Some(ref)`
//! is expanded inline into the parent graph, with ID prefixing, dependency rewiring,
//! and input/output remapping.

mod helpers;

use std::collections::HashMap;
use std::sync::Arc;

use catgo_graph::*;
use catgo_graph::api::graph_api::TemplateRegistry;
use catgo_graph::graph::composer::{expand_subgraphs, TemplateProvider};
use catgo_graph::graph::template::SubgraphRef;
use catgo_graph::storage::SqliteStateStore;
use catgo_graph::storage::FileArtifactStore;
use catgo_graph::tools::mock::EchoTool;
use catgo_graph::tools::stats::StatsTool;
use catgo_graph::tools::file_writer::FileWriterTool;
use serde_json::json;
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/// A simple map-based TemplateProvider for tests, in case TemplateRegistry's
/// TemplateProvider impl isn't available yet (being added by Agent 3).
struct MapProvider {
    templates: HashMap<String, GraphTemplate>,
}

impl MapProvider {
    fn new() -> Self {
        Self {
            templates: HashMap::new(),
        }
    }

    fn insert(&mut self, template: GraphTemplate) {
        self.templates.insert(template.id.clone(), template);
    }
}

impl TemplateProvider for MapProvider {
    fn get_template(&self, id: &str) -> Option<GraphTemplate> {
        self.templates.get(id).cloned()
    }
}

/// Create a minimal NodeTemplate with tool and optional subgraph.
fn tool_node(id: &str, tool: &str, deps: Vec<&str>) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: tool.to_string(),
        depends_on: deps.into_iter().map(|d| d.to_string()).collect(),
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

/// Create a subgraph node (no tool, has subgraph ref).
fn subgraph_node(
    id: &str,
    template_id: &str,
    input_map: serde_json::Value,
    deps: Vec<&str>,
) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: String::new(),
        depends_on: deps.into_iter().map(|d| d.to_string()).collect(),
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
            input_map,
        }),
        metadata: Default::default(),
    }
}

/// Create a GraphTemplate from nodes.
fn make_template(id: &str, nodes: Vec<NodeTemplate>) -> GraphTemplate {
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

/// Create a GraphEngine with echo tools and an in-memory state store.
fn make_echo_engine() -> GraphEngine {
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-subgraph-test"));

    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(EchoTool::new("echo")));

    GraphEngine::new(RuntimeConfig::default(), registry, state_store, artifact_store)
}

/// Create a GraphEngine with real tools (echo, compute_stats, file_writer)
/// using a tempdir for artifacts.
fn make_full_engine(artifact_root: &str) -> GraphEngine {
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(artifact_root));

    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(EchoTool::new("echo")));
    registry.register(Arc::new(StatsTool::new("compute_stats")));
    registry.register(Arc::new(FileWriterTool::new("file_writer")));

    GraphEngine::new(RuntimeConfig::default(), registry, state_store, artifact_store)
}

/// Build a simple inner template with two echo nodes: inner_a -> inner_b.
fn simple_inner_template() -> GraphTemplate {
    make_template(
        "inner_v1",
        vec![
            tool_node("inner_a", "echo", vec![]),
            tool_node("inner_b", "echo", vec!["inner_a"]),
        ],
    )
}

// ---------------------------------------------------------------------------
// Test 1: Expand and run a subgraph end-to-end
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subgraph_expand_and_run() {
    // Inner template: inner_a -> inner_b (both echo)
    let inner = simple_inner_template();

    // Parent template: root -> sub (subgraph) -> final_node
    let parent = make_template(
        "parent_v1",
        vec![
            tool_node("root", "echo", vec![]),
            subgraph_node("sub", "inner_v1", json!({}), vec!["root"]),
            tool_node("final_node", "echo", vec!["sub"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.insert(inner);

    // Expand subgraphs
    let expanded = expand_subgraphs(&parent, &provider)
        .expect("expand_subgraphs should succeed");

    // The expanded template should have: root, sub/inner_a, sub/inner_b, final_node
    assert_eq!(
        expanded.nodes.len(),
        4,
        "Expected 4 nodes after expansion (root + 2 inner + final_node), got {}: {:?}",
        expanded.nodes.len(),
        expanded.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
    );

    // The subgraph placeholder node "sub" should be gone
    assert!(
        expanded.nodes.iter().all(|n| n.id != "sub"),
        "Subgraph placeholder 'sub' should be removed after expansion"
    );

    // Run the expanded graph
    let engine = make_echo_engine();
    let mut run = engine
        .instantiate_graph(&expanded, json!({}))
        .expect("instantiate should succeed");
    engine.run_graph(&mut run, &expanded).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should succeed, got: {:?}",
        run.node_runs
            .iter()
            .map(|n| (&n.node_id, &n.status))
            .collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// Test 2: Node ID prefixing follows {parent}/{inner} pattern
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subgraph_node_id_prefixing() {
    let inner = simple_inner_template();

    let parent = make_template(
        "parent_v1",
        vec![
            tool_node("root", "echo", vec![]),
            subgraph_node("compute", "inner_v1", json!({}), vec!["root"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.insert(inner);

    let expanded = expand_subgraphs(&parent, &provider).unwrap();

    let node_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();

    // Root stays unchanged
    assert!(node_ids.contains(&"root"), "Root node should keep its ID");

    // Inner nodes get prefixed with parent node ID
    assert!(
        node_ids.contains(&"compute/inner_a"),
        "Inner node 'inner_a' should be prefixed as 'compute/inner_a', got: {:?}",
        node_ids
    );
    assert!(
        node_ids.contains(&"compute/inner_b"),
        "Inner node 'inner_b' should be prefixed as 'compute/inner_b', got: {:?}",
        node_ids
    );

    // The subgraph node itself should not be present
    assert!(
        !node_ids.contains(&"compute"),
        "Subgraph placeholder 'compute' should be removed"
    );
}

// ---------------------------------------------------------------------------
// Test 3: Dependency wiring — inner roots inherit parent deps,
//         parent dependents rewired to inner terminals
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subgraph_dependency_wiring() {
    let inner = simple_inner_template(); // inner_a -> inner_b

    // parent: prep -> sub(inner_v1) -> finish
    let parent = make_template(
        "parent_v1",
        vec![
            tool_node("prep", "echo", vec![]),
            subgraph_node("sub", "inner_v1", json!({}), vec!["prep"]),
            tool_node("finish", "echo", vec!["sub"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.insert(inner);

    let expanded = expand_subgraphs(&parent, &provider).unwrap();

    // Find nodes by ID for dependency checks
    let find_node = |id: &str| -> &NodeTemplate {
        expanded.nodes.iter().find(|n| n.id == id).unwrap_or_else(|| {
            panic!(
                "Node '{}' not found in expanded template. Available: {:?}",
                id,
                expanded.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
            )
        })
    };

    // Inner root node (sub/inner_a) should inherit parent's depends_on: ["prep"]
    let inner_root = find_node("sub/inner_a");
    assert!(
        inner_root.depends_on.contains(&"prep".to_string()),
        "Inner root 'sub/inner_a' should depend on 'prep', got: {:?}",
        inner_root.depends_on
    );

    // Inner chain: sub/inner_b should depend on sub/inner_a
    let inner_leaf = find_node("sub/inner_b");
    assert!(
        inner_leaf.depends_on.contains(&"sub/inner_a".to_string()),
        "Inner node 'sub/inner_b' should depend on 'sub/inner_a', got: {:?}",
        inner_leaf.depends_on
    );

    // Parent's "finish" node originally depended on "sub" (the subgraph placeholder).
    // After expansion, it should depend on the terminal inner node(s) — "sub/inner_b".
    let finish_node = find_node("finish");
    assert!(
        finish_node.depends_on.contains(&"sub/inner_b".to_string()),
        "Node 'finish' should now depend on terminal inner node 'sub/inner_b', got: {:?}",
        finish_node.depends_on
    );
    assert!(
        !finish_node.depends_on.contains(&"sub".to_string()),
        "Node 'finish' should NOT still depend on removed subgraph placeholder 'sub'"
    );
}

// ---------------------------------------------------------------------------
// Test 4: Input passthrough — subgraph input_map values propagate to inner nodes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subgraph_input_passthrough() {
    // Inner template with input bindings referencing ${inputs.X}
    let inner = {
        let mut node_a = tool_node("step", "echo", vec![]);
        node_a.input_bindings = json!({
            "data": "${inputs.values}",
            "tag": "${inputs.label}"
        });
        make_template("inner_with_inputs", vec![node_a])
    };

    // Parent that maps inputs via subgraph input_map
    let parent = make_template(
        "parent_v1",
        vec![subgraph_node(
            "sub",
            "inner_with_inputs",
            json!({
                "values": "${inputs.my_data}",
                "label": "hardcoded_label"
            }),
            vec![],
        )],
    );

    let mut provider = MapProvider::new();
    provider.insert(inner);

    let expanded = expand_subgraphs(&parent, &provider).unwrap();

    // The expanded node "sub/step" should have its ${inputs.values} rewritten
    // to ${inputs.my_data} (from the input_map), and ${inputs.label} rewritten
    // to the literal "hardcoded_label".
    let step_node = expanded
        .nodes
        .iter()
        .find(|n| n.id == "sub/step")
        .expect("sub/step should exist after expansion");

    let bindings = &step_node.input_bindings;

    // ${inputs.values} in inner -> mapped to ${inputs.my_data} via input_map
    let data_binding = bindings.get("data").expect("data binding should exist");
    assert_eq!(
        data_binding, "${inputs.my_data}",
        "Inner ${{inputs.values}} should be rewritten to ${{inputs.my_data}} via input_map"
    );

    // ${inputs.label} in inner -> mapped to literal "hardcoded_label" via input_map
    let tag_binding = bindings.get("tag").expect("tag binding should exist");
    assert_eq!(
        tag_binding, "hardcoded_label",
        "Inner ${{inputs.label}} should be rewritten to literal 'hardcoded_label' via input_map"
    );
}

// ---------------------------------------------------------------------------
// Test 5: Output remapping — parent nodes referencing subgraph outputs get rewritten
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subgraph_output_remapping() {
    // Inner template: step_a -> step_b, with known outputs
    let inner = make_template(
        "inner_v1",
        vec![
            tool_node("step_a", "echo", vec![]),
            tool_node("step_b", "echo", vec!["step_a"]),
        ],
    );

    // Parent: sub(inner_v1) -> consumer
    // consumer references ${nodes.sub.outputs.result} — but after expansion,
    // there is no "sub" node. Inner node references like ${nodes.X.outputs.Y}
    // within the inner template get X prefixed, but parent references to the
    // subgraph node's outputs need remapping to inner terminal nodes.
    let mut consumer = tool_node("consumer", "echo", vec!["sub"]);
    consumer.input_bindings = json!({
        "value": "${nodes.sub.outputs.result}"
    });

    let parent = make_template(
        "parent_v1",
        vec![
            subgraph_node("sub", "inner_v1", json!({}), vec![]),
            consumer,
        ],
    );

    let mut provider = MapProvider::new();
    provider.insert(inner);

    let expanded = expand_subgraphs(&parent, &provider).unwrap();

    // After expansion, ${nodes.sub.outputs.result} in consumer should be rewritten.
    // The exact remapping depends on the composer implementation; it may become
    // ${nodes.sub/step_b.outputs.result} (referencing the terminal inner node).
    let consumer_node = expanded
        .nodes
        .iter()
        .find(|n| n.id == "consumer")
        .expect("consumer should exist");

    let value_binding = consumer_node
        .input_bindings
        .get("value")
        .and_then(|v| v.as_str())
        .expect("value binding should be a string expression");

    // The binding should no longer reference the removed "sub" node directly
    // but should reference a prefixed inner node instead.
    assert!(
        !value_binding.contains("${nodes.sub.outputs"),
        "Output reference should be remapped away from removed subgraph placeholder. Got: {}",
        value_binding
    );
    assert!(
        value_binding.contains("sub/"),
        "Output reference should be remapped to a prefixed inner node. Got: {}",
        value_binding
    );
}

// ---------------------------------------------------------------------------
// Test 6: State persistence with expanded subgraph node IDs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subgraph_persistence_and_resume() {
    let inner = simple_inner_template();

    let parent = make_template(
        "parent_v1",
        vec![
            tool_node("root", "echo", vec![]),
            subgraph_node("sub", "inner_v1", json!({}), vec!["root"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.insert(inner);

    let expanded = expand_subgraphs(&parent, &provider).unwrap();

    // Use a shared state store so we can verify persistence
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-subgraph-persist"));

    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(EchoTool::new("echo")));

    let engine = GraphEngine::new(
        RuntimeConfig::default(),
        registry,
        state_store.clone(),
        artifact_store,
    );

    let mut run = engine
        .instantiate_graph(&expanded, json!({"test": true}))
        .unwrap();
    let run_id = run.id.clone();

    engine.run_graph(&mut run, &expanded).await.unwrap();
    assert_eq!(run.status, GraphRunStatus::Succeeded);

    // Load from store and verify expanded node IDs are persisted
    let loaded = engine.get_graph_status(&run_id).unwrap();
    assert_eq!(loaded.status, GraphRunStatus::Succeeded);

    let loaded_ids: Vec<&str> = loaded
        .node_runs
        .iter()
        .map(|n| n.node_id.as_str())
        .collect();

    // The persisted run should have the expanded (prefixed) node IDs
    assert!(
        loaded_ids.contains(&"root"),
        "Persisted run should contain 'root'"
    );
    assert!(
        loaded_ids.contains(&"sub/inner_a"),
        "Persisted run should contain expanded 'sub/inner_a'"
    );
    assert!(
        loaded_ids.contains(&"sub/inner_b"),
        "Persisted run should contain expanded 'sub/inner_b'"
    );

    // The subgraph placeholder should NOT be present
    assert!(
        !loaded_ids.contains(&"sub"),
        "Persisted run should NOT contain subgraph placeholder 'sub'"
    );

    // All nodes should be succeeded
    assert!(
        loaded.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All persisted nodes should be Succeeded"
    );
}

// ---------------------------------------------------------------------------
// Test 7: Backward compatibility — templates without subgraphs still work
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subgraph_backward_compat() {
    // Load the existing data_pipeline.yaml fixture (no subgraph nodes)
    let yaml = include_str!("fixtures/data_pipeline.yaml");
    let template: GraphTemplate =
        serde_yaml::from_str(yaml).expect("data_pipeline.yaml should parse");

    // Verify it parsed correctly
    assert_eq!(template.id, "data_pipeline_v1");
    assert_eq!(template.nodes.len(), 3);

    // All nodes should have subgraph: None
    for node in &template.nodes {
        assert!(
            node.subgraph.is_none(),
            "Legacy node '{}' should have subgraph: None",
            node.id
        );
    }

    // expand_subgraphs on a template with no subgraph nodes should return
    // an identical template (pass-through).
    let provider = MapProvider::new();
    let expanded = expand_subgraphs(&template, &provider)
        .expect("expand_subgraphs should succeed on templates with no subgraphs");

    assert_eq!(
        expanded.nodes.len(),
        template.nodes.len(),
        "Expansion of a non-subgraph template should not change node count"
    );
    for (orig, exp) in template.nodes.iter().zip(expanded.nodes.iter()) {
        assert_eq!(orig.id, exp.id, "Node IDs should be unchanged");
        assert_eq!(orig.tool, exp.tool, "Tool names should be unchanged");
        assert_eq!(orig.depends_on, exp.depends_on, "Dependencies should be unchanged");
    }

    // Also verify the template can still run with real tools
    let tmp = tempdir().unwrap();
    let engine = make_full_engine(tmp.path().to_str().unwrap());

    let mut run = engine
        .instantiate_graph(&expanded, json!({"values": [1.0, 2.0, 3.0], "label": "compat_test"}))
        .unwrap();
    engine.run_graph(&mut run, &expanded).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should succeed in backward-compat run"
    );
}

// ---------------------------------------------------------------------------
// Test 8: Subgraph with real tools (StatsTool + FileWriterTool)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subgraph_with_real_tools() {
    // Load the reusable_stats subgraph template
    let inner_yaml = include_str!("fixtures/reusable_stats.yaml");
    let inner: GraphTemplate =
        serde_yaml::from_str(inner_yaml).expect("reusable_stats.yaml should parse");

    assert_eq!(inner.id, "reusable_stats_v1");
    assert_eq!(inner.nodes.len(), 2);

    // Build a parent template that invokes it as a subgraph
    let parent = make_template(
        "real_tools_parent",
        vec![
            tool_node("init", "echo", vec![]),
            subgraph_node(
                "stats",
                "reusable_stats_v1",
                json!({
                    "values": "${inputs.data}",
                    "label": "${inputs.label}"
                }),
                vec!["init"],
            ),
            tool_node("done", "echo", vec!["stats"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.insert(inner);

    let expanded = expand_subgraphs(&parent, &provider)
        .expect("expand should succeed with real tool template");

    // Verify expansion produced the expected nodes
    let node_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();
    assert!(node_ids.contains(&"init"), "Should have 'init' node");
    assert!(
        node_ids.contains(&"stats/compute"),
        "Should have expanded 'stats/compute' node"
    );
    assert!(
        node_ids.contains(&"stats/save"),
        "Should have expanded 'stats/save' node"
    );
    assert!(node_ids.contains(&"done"), "Should have 'done' node");

    // Verify inner nodes have correct tools
    let compute_node = expanded
        .nodes
        .iter()
        .find(|n| n.id == "stats/compute")
        .unwrap();
    assert_eq!(
        compute_node.tool, "compute_stats",
        "Expanded compute node should use compute_stats tool"
    );

    let save_node = expanded
        .nodes
        .iter()
        .find(|n| n.id == "stats/save")
        .unwrap();
    assert_eq!(
        save_node.tool, "file_writer",
        "Expanded save node should use file_writer tool"
    );

    // Run the expanded graph with real tools
    let tmp = tempdir().unwrap();
    let engine = make_full_engine(tmp.path().to_str().unwrap());

    let mut run = engine
        .instantiate_graph(&expanded, json!({"data": [10.0, 20.0, 30.0], "label": "real_test"}))
        .unwrap();
    engine.run_graph(&mut run, &expanded).await.unwrap();

    assert_eq!(
        run.status,
        GraphRunStatus::Succeeded,
        "Run with real tools should succeed. Node statuses: {:?}",
        run.node_runs
            .iter()
            .map(|n| (&n.node_id, &n.status))
            .collect::<Vec<_>>()
    );

    // Verify the stats/compute node produced correct outputs
    let compute_run = run
        .node_run("stats/compute")
        .expect("stats/compute node run should exist");
    assert_eq!(compute_run.status, NodeStatus::Succeeded);

    if let Some(ref outputs) = compute_run.outputs {
        assert_eq!(outputs["mean"], 20.0, "Mean of [10, 20, 30] should be 20.0");
        assert_eq!(outputs["count"], 3, "Count of [10, 20, 30] should be 3");
        assert_eq!(outputs["label"], "real_test");
    }
}

// ---------------------------------------------------------------------------
// Test: YAML fixture parsing for pipeline_with_subgraph
// ---------------------------------------------------------------------------

#[test]
fn test_pipeline_with_subgraph_yaml_parses() {
    let yaml = include_str!("fixtures/pipeline_with_subgraph.yaml");
    let template: GraphTemplate =
        serde_yaml::from_str(yaml).expect("pipeline_with_subgraph.yaml should parse");

    assert_eq!(template.id, "pipeline_with_subgraph_v1");
    assert_eq!(template.version, "1.0.0");
    assert_eq!(template.nodes.len(), 3);

    // First node is a tool node
    let prepare = &template.nodes[0];
    assert_eq!(prepare.id, "prepare");
    assert_eq!(prepare.tool, "file_writer");
    assert!(prepare.subgraph.is_none());

    // Second node is a subgraph node
    let analyze = &template.nodes[1];
    assert_eq!(analyze.id, "analyze");
    assert!(
        analyze.subgraph.is_some(),
        "analyze node should have a subgraph reference"
    );
    let subref = analyze.subgraph.as_ref().unwrap();
    assert_eq!(subref.template_id, "reusable_stats_v1");
    assert_eq!(subref.input_map["values"], "${inputs.data}");
    assert_eq!(subref.input_map["label"], "${inputs.label}");
    assert_eq!(analyze.depends_on, vec!["prepare"]);

    // Third node depends on the subgraph node
    let report = &template.nodes[2];
    assert_eq!(report.id, "report");
    assert_eq!(report.tool, "file_writer");
    assert!(report.subgraph.is_none());
    assert_eq!(report.depends_on, vec!["analyze"]);

    // Verify outputs reference the subgraph node
    assert_eq!(template.outputs.len(), 2);
    assert_eq!(template.outputs[0].name, "mean");
    assert_eq!(template.outputs[1].name, "count");
}

// ---------------------------------------------------------------------------
// Test: Reusable stats YAML fixture parses correctly
// ---------------------------------------------------------------------------

#[test]
fn test_reusable_stats_yaml_parses() {
    let yaml = include_str!("fixtures/reusable_stats.yaml");
    let template: GraphTemplate =
        serde_yaml::from_str(yaml).expect("reusable_stats.yaml should parse");

    assert_eq!(template.id, "reusable_stats_v1");
    assert_eq!(template.version, "1.0.0");
    assert_eq!(template.nodes.len(), 2);

    // compute node
    let compute = &template.nodes[0];
    assert_eq!(compute.id, "compute");
    assert_eq!(compute.tool, "compute_stats");
    assert!(compute.depends_on.is_empty());
    assert!(compute.subgraph.is_none());

    // save node depends on compute
    let save = &template.nodes[1];
    assert_eq!(save.id, "save");
    assert_eq!(save.tool, "file_writer");
    assert_eq!(save.depends_on, vec!["compute"]);
    assert!(save.subgraph.is_none());

    // Outputs
    assert_eq!(template.outputs.len(), 2);
    assert_eq!(template.outputs[0].name, "mean");
    assert_eq!(template.outputs[1].name, "count");
}

// ---------------------------------------------------------------------------
// Test: Multiple subgraph nodes in one parent
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_multiple_subgraphs_in_parent() {
    // Two different inner templates
    let inner_a = make_template(
        "inner_a_v1",
        vec![tool_node("step", "echo", vec![])],
    );
    let inner_b = make_template(
        "inner_b_v1",
        vec![
            tool_node("x", "echo", vec![]),
            tool_node("y", "echo", vec!["x"]),
        ],
    );

    // Parent with two subgraph nodes
    let parent = make_template(
        "multi_sub",
        vec![
            tool_node("start", "echo", vec![]),
            subgraph_node("first", "inner_a_v1", json!({}), vec!["start"]),
            subgraph_node("second", "inner_b_v1", json!({}), vec!["start"]),
            tool_node("join", "echo", vec!["first", "second"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.insert(inner_a);
    provider.insert(inner_b);

    let expanded = expand_subgraphs(&parent, &provider).unwrap();

    let node_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();

    // start + first/step + second/x + second/y + join = 5 nodes
    assert_eq!(
        expanded.nodes.len(),
        5,
        "Expected 5 nodes after expanding two subgraphs, got {}: {:?}",
        expanded.nodes.len(),
        node_ids
    );

    assert!(node_ids.contains(&"start"));
    assert!(node_ids.contains(&"first/step"));
    assert!(node_ids.contains(&"second/x"));
    assert!(node_ids.contains(&"second/y"));
    assert!(node_ids.contains(&"join"));

    // Neither subgraph placeholder should remain
    assert!(!node_ids.contains(&"first"));
    assert!(!node_ids.contains(&"second"));

    // Run it
    let engine = make_echo_engine();
    let mut run = engine.instantiate_graph(&expanded, json!({})).unwrap();
    engine.run_graph(&mut run, &expanded).await.unwrap();
    assert_eq!(run.status, GraphRunStatus::Succeeded);
}

// ---------------------------------------------------------------------------
// Test: TemplateRegistry as TemplateProvider (if impl available)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_template_registry_as_provider() {
    let inner = simple_inner_template();

    let registry = TemplateRegistry::new();
    registry.register(inner);

    // TemplateRegistry should implement TemplateProvider (added by Agent 3).
    // If the impl is available, we can use it directly for expansion.
    let parent = make_template(
        "parent_v1",
        vec![
            tool_node("root", "echo", vec![]),
            subgraph_node("sub", "inner_v1", json!({}), vec!["root"]),
        ],
    );

    let expanded = expand_subgraphs(&parent, &registry)
        .expect("expand_subgraphs with TemplateRegistry should succeed");

    let node_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();
    assert!(node_ids.contains(&"root"));
    assert!(node_ids.contains(&"sub/inner_a"));
    assert!(node_ids.contains(&"sub/inner_b"));
}

// ---------------------------------------------------------------------------
// Test: Inner node references (${nodes.X.outputs.Y}) get X prefixed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_inner_node_ref_prefixing() {
    // Inner template where step_b references step_a's outputs
    let inner = {
        let mut step_b = tool_node("step_b", "echo", vec!["step_a"]);
        step_b.input_bindings = json!({
            "prev_result": "${nodes.step_a.outputs.value}"
        });
        make_template(
            "ref_inner_v1",
            vec![tool_node("step_a", "echo", vec![]), step_b],
        )
    };

    let parent = make_template(
        "parent_v1",
        vec![subgraph_node("sg", "ref_inner_v1", json!({}), vec![])],
    );

    let mut provider = MapProvider::new();
    provider.insert(inner);

    let expanded = expand_subgraphs(&parent, &provider).unwrap();

    // Find the expanded step_b node
    let step_b = expanded
        .nodes
        .iter()
        .find(|n| n.id == "sg/step_b")
        .expect("sg/step_b should exist");

    // Its reference to ${nodes.step_a.outputs.value} should become
    // ${nodes.sg/step_a.outputs.value}
    let binding = step_b
        .input_bindings
        .get("prev_result")
        .and_then(|v| v.as_str())
        .expect("prev_result binding should be a string");

    assert!(
        binding.contains("sg/step_a"),
        "Inner node reference should be prefixed: expected 'sg/step_a' in '{}'. Got: {}",
        "${nodes.sg/step_a.outputs.value}",
        binding
    );
}

// ---------------------------------------------------------------------------
// Test: Missing subgraph template returns error
// ---------------------------------------------------------------------------

#[test]
fn test_subgraph_missing_template_errors() {
    let parent = make_template(
        "parent_v1",
        vec![subgraph_node("sub", "nonexistent_template", json!({}), vec![])],
    );

    let provider = MapProvider::new(); // empty — no templates registered

    let result = expand_subgraphs(&parent, &provider);
    assert!(
        result.is_err(),
        "expand_subgraphs should fail when referenced template is missing"
    );
}

// ---------------------------------------------------------------------------
// Test: Full pipeline_with_subgraph.yaml expansion and run
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_full_pipeline_with_subgraph_yaml() {
    // Load both YAML fixtures
    let inner_yaml = include_str!("fixtures/reusable_stats.yaml");
    let inner: GraphTemplate = serde_yaml::from_str(inner_yaml).unwrap();

    let parent_yaml = include_str!("fixtures/pipeline_with_subgraph.yaml");
    let parent: GraphTemplate = serde_yaml::from_str(parent_yaml).unwrap();

    let mut provider = MapProvider::new();
    provider.insert(inner);

    let expanded = expand_subgraphs(&parent, &provider)
        .expect("Full pipeline expansion should succeed");

    // Verify structure: prepare + analyze/compute + analyze/save + report = 4 nodes
    let node_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(
        expanded.nodes.len(),
        4,
        "Expected 4 nodes in expanded pipeline, got: {:?}",
        node_ids
    );
    assert!(node_ids.contains(&"prepare"));
    assert!(node_ids.contains(&"analyze/compute"));
    assert!(node_ids.contains(&"analyze/save"));
    assert!(node_ids.contains(&"report"));

    // Run with real tools
    let tmp = tempdir().unwrap();
    let engine = make_full_engine(tmp.path().to_str().unwrap());

    let mut run = engine
        .instantiate_graph(
            &expanded,
            json!({"data": [5.0, 10.0, 15.0, 20.0], "label": "full_pipeline"}),
        )
        .unwrap();
    engine.run_graph(&mut run, &expanded).await.unwrap();

    assert_eq!(
        run.status,
        GraphRunStatus::Succeeded,
        "Full pipeline run should succeed. Statuses: {:?}",
        run.node_runs
            .iter()
            .map(|n| (&n.node_id, &n.status))
            .collect::<Vec<_>>()
    );
}

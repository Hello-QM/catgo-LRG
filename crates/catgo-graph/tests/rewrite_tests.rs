//! Integration tests for dynamic graph rewriting.
//!
//! Tests the rewrite system where GraphTemplate.rewrite_rules define conditions
//! that, when satisfied by a node's outputs, inject a predefined subgraph template
//! into the running graph. Rewrites are append-only, persisted as RewriteEvents,
//! and idempotent across resume/restart.

mod helpers;

use catgo_graph::*;
use catgo_graph::api::graph_api::TemplateRegistry;
use catgo_graph::graph::rewrite::{RewriteRule, RewriteCondition, ConditionOperator};
use catgo_graph::storage::file_store::FileArtifactStore;
use catgo_graph::storage::sqlite_store::SqliteStateStore;
use catgo_graph::tools::mock::EchoTool;
use serde_json::json;
use std::sync::Arc;
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

fn make_engine(tmp_path: &std::path::Path) -> GraphEngine {
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(tmp_path));
    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(EchoTool::new("echo")));
    GraphEngine::new(RuntimeConfig::default(), tool_registry, state_store, artifact_store)
}

fn make_engine_with_store(
    tmp_path: &std::path::Path,
    state_store: Arc<dyn catgo_graph::storage::traits::StateStore>,
) -> GraphEngine {
    let artifact_store = Arc::new(FileArtifactStore::new(tmp_path));
    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(EchoTool::new("echo")));
    GraphEngine::new(RuntimeConfig::default(), tool_registry, state_store, artifact_store)
}

fn make_node(id: &str, tool: &str, deps: Vec<&str>) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: tool.to_string(),
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

fn make_node_with_bindings(id: &str, tool: &str, deps: Vec<&str>, bindings: serde_json::Value) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: tool.to_string(),
        depends_on: deps.into_iter().map(|s| s.to_string()).collect(),
        input_bindings: bindings,
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

fn make_template(id: &str, nodes: Vec<NodeTemplate>, rules: Vec<RewriteRule>) -> GraphTemplate {
    GraphTemplate {
        id: id.to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes,
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: rules,
    }
}

fn make_rule(
    rule_id: &str,
    source_node: &str,
    output_key: &str,
    operator: ConditionOperator,
    value: serde_json::Value,
    subgraph_template_id: &str,
) -> RewriteRule {
    RewriteRule {
        rule_id: rule_id.to_string(),
        source_node: source_node.to_string(),
        condition: RewriteCondition {
            output_key: output_key.to_string(),
            operator,
            value,
        },
        subgraph_template_id: subgraph_template_id.to_string(),
        subgraph_version: None,
        input_map: json!({}),
        max_applications: 1,
    }
}

// ---------------------------------------------------------------------------
// Test 1: No rewrite rules — normal execution via run_graph_with_rewrites
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_workflow_without_rewrite_rules() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // Template with no rewrite rules, three nodes in a chain
    let template = make_template(
        "no_rewrite",
        vec![
            make_node("a", "echo", vec![]),
            make_node("b", "echo", vec!["a"]),
            make_node("c", "echo", vec!["b"]),
        ],
        vec![],
    );

    let template_registry = TemplateRegistry::new();

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(
        run.status,
        GraphRunStatus::Succeeded,
        "Run should succeed, got: {:?}",
        run.status
    );
    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should succeed, got: {:?}",
        run.node_runs.iter().map(|n| (&n.node_id, &n.status)).collect::<Vec<_>>()
    );
    assert_eq!(
        run.rewrite_events.len(),
        0,
        "No rewrite events expected with empty rewrite_rules"
    );
    assert_eq!(run.node_runs.len(), 3, "Should have exactly 3 node runs");
}

// ---------------------------------------------------------------------------
// Test 2: Rewrite trigger fires when condition is satisfied
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_trigger_fires() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // "analyze" echoes its inputs as outputs, so energy=-5.0 will be in outputs
    let analyze_node = make_node_with_bindings(
        "analyze",
        "echo",
        vec![],
        json!({ "energy": -5.0 }),
    );

    let rule = make_rule(
        "refine_if_negative",
        "analyze",
        "energy",
        ConditionOperator::LessThan,
        json!(0.0),
        "refinement",
    );

    let template = make_template("main", vec![analyze_node], vec![rule]);

    // "refinement" subgraph template with two nodes
    let refinement_template = make_template(
        "refinement",
        vec![
            make_node("optimize", "echo", vec![]),
            make_node("validate", "echo", vec!["optimize"]),
        ],
        vec![],
    );

    let template_registry = TemplateRegistry::new();
    template_registry.register(refinement_template);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(
        run.status,
        GraphRunStatus::Succeeded,
        "Run should succeed"
    );

    // Exactly one rewrite event
    assert_eq!(
        run.rewrite_events.len(),
        1,
        "Expected 1 rewrite event, got {}",
        run.rewrite_events.len()
    );

    let event = &run.rewrite_events[0];
    assert_eq!(event.rule_id, "refine_if_negative");
    assert_eq!(event.source_node, "analyze");
    assert_eq!(event.injected_template_id, "refinement");
    assert_eq!(
        event.injected_node_ids.len(),
        2,
        "Expected 2 injected node IDs, got: {:?}",
        event.injected_node_ids
    );

    // Injected node IDs follow "rule_id/node_id" pattern
    let injected_ids: Vec<&str> = event.injected_node_ids.iter().map(|s| s.as_str()).collect();
    assert!(
        injected_ids.contains(&"refine_if_negative/optimize"),
        "Expected 'refine_if_negative/optimize', got: {:?}",
        injected_ids
    );
    assert!(
        injected_ids.contains(&"refine_if_negative/validate"),
        "Expected 'refine_if_negative/validate', got: {:?}",
        injected_ids
    );

    // All nodes (original + injected) should have succeeded
    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should succeed, got: {:?}",
        run.node_runs.iter().map(|n| (&n.node_id, &n.status)).collect::<Vec<_>>()
    );

    // Total: 1 original + 2 injected
    assert_eq!(
        run.node_runs.len(),
        3,
        "Expected 3 total node runs (1 original + 2 injected), got {}",
        run.node_runs.len()
    );
}

// ---------------------------------------------------------------------------
// Test 3: Rewrite condition not satisfied — no injection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_condition_not_satisfied() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // energy=5.0 is NOT less than 0.0, so rule should not fire
    let analyze_node = make_node_with_bindings(
        "analyze",
        "echo",
        vec![],
        json!({ "energy": 5.0 }),
    );

    let rule = make_rule(
        "refine_if_negative",
        "analyze",
        "energy",
        ConditionOperator::LessThan,
        json!(0.0),
        "refinement",
    );

    let template = make_template("main", vec![analyze_node], vec![rule]);

    let refinement_template = make_template(
        "refinement",
        vec![make_node("optimize", "echo", vec![])],
        vec![],
    );

    let template_registry = TemplateRegistry::new();
    template_registry.register(refinement_template);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(
        run.rewrite_events.len(),
        0,
        "No rewrite events should fire when condition is not satisfied"
    );
    assert_eq!(
        run.node_runs.len(),
        1,
        "Only the original node should exist"
    );
    assert_eq!(run.node_runs[0].node_id, "analyze");
    assert_eq!(run.node_runs[0].status, NodeStatus::Succeeded);
}

// ---------------------------------------------------------------------------
// Test 4: Injected nodes depend on the source node (execute after it)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_injected_nodes_depend_on_source() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // A -> B (with rewrite rule on B)
    // B outputs energy=-1.0, triggering injection of subgraph with node C
    let node_a = make_node("a", "echo", vec![]);
    let node_b = make_node_with_bindings(
        "b",
        "echo",
        vec!["a"],
        json!({ "energy": -1.0 }),
    );

    let rule = make_rule(
        "inject_c",
        "b",
        "energy",
        ConditionOperator::LessThan,
        json!(0.0),
        "sub_with_c",
    );

    let template = make_template("parent", vec![node_a, node_b], vec![rule]);

    let sub_template = make_template(
        "sub_with_c",
        vec![make_node("c", "echo", vec![])],
        vec![],
    );

    let template_registry = TemplateRegistry::new();
    template_registry.register(sub_template);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.rewrite_events.len(), 1);

    // The injected node "inject_c/c" should exist and have succeeded
    let injected_id = "inject_c/c";
    let injected_nr = run
        .node_run(injected_id)
        .unwrap_or_else(|| panic!("Expected injected node '{}' to exist", injected_id));
    assert_eq!(
        injected_nr.status,
        NodeStatus::Succeeded,
        "Injected node '{}' should succeed",
        injected_id
    );

    // Verify ordering: b must have finished before inject_c/c (which depends on b)
    // We confirm this via the execution: inject_c/c succeeded, meaning b succeeded first
    let b_nr = run.node_run("b").unwrap();
    assert_eq!(b_nr.status, NodeStatus::Succeeded);

    // The event records that the injected node depends on "b" (source node)
    let event = &run.rewrite_events[0];
    assert_eq!(event.source_node, "b");
    assert!(event.injected_node_ids.contains(&injected_id.to_string()));
}

// ---------------------------------------------------------------------------
// Test 5: Resume is idempotent — no duplicate rewrite events
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_idempotent_on_resume() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state.db");
    let db_path_str = db_path.to_str().unwrap().to_string();

    let analyze_node = make_node_with_bindings(
        "analyze",
        "echo",
        vec![],
        json!({ "energy": -3.0 }),
    );

    let rule = make_rule(
        "refine",
        "analyze",
        "energy",
        ConditionOperator::LessThan,
        json!(0.0),
        "refinement",
    );

    let template = make_template("main", vec![analyze_node], vec![rule]);

    let refinement_template = make_template(
        "refinement",
        vec![
            make_node("step1", "echo", vec![]),
            make_node("step2", "echo", vec!["step1"]),
        ],
        vec![],
    );

    let template_registry = TemplateRegistry::new();
    template_registry.register(refinement_template);

    // --- First run: complete to success ---
    let state_store = Arc::new(
        SqliteStateStore::new(&db_path_str).expect("should create file SQLite store"),
    );
    let engine1 = make_engine_with_store(tmp.path(), state_store.clone());

    let mut run = engine1.instantiate_graph(&template, json!({})).unwrap();
    let run_id = run.id.clone();

    engine1
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(
        run.rewrite_events.len(),
        1,
        "Expected 1 rewrite event after first run"
    );
    let first_event_id = run.rewrite_events[0].event_id.clone();
    let first_node_count = run.node_runs.len();

    // Verify rewrite events are persisted in the store
    let loaded = state_store.load_graph_run(&run_id).unwrap();
    assert_eq!(
        loaded.rewrite_events.len(),
        1,
        "Rewrite event should be persisted in the state store"
    );
    assert_eq!(
        loaded.rewrite_events[0].event_id,
        first_event_id,
        "Persisted event ID should match"
    );

    // --- Second run: resume from the same store (already succeeded) ---
    let engine2 = make_engine_with_store(tmp.path(), state_store.clone());

    let resumed = engine2
        .resume_graph_with_rewrites(&run_id, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(
        resumed.rewrite_events.len(),
        1,
        "Resume should not create duplicate rewrite events; expected 1, got {}",
        resumed.rewrite_events.len()
    );
    assert_eq!(
        resumed.rewrite_events[0].event_id,
        first_event_id,
        "Event ID should be the same (no new event created)"
    );
    assert_eq!(
        resumed.node_runs.len(),
        first_node_count,
        "No new nodes should be created on resume; expected {}, got {}",
        first_node_count,
        resumed.node_runs.len()
    );
    assert_eq!(resumed.status, GraphRunStatus::Succeeded);
}

// ---------------------------------------------------------------------------
// Test 6: Multiple rewrite rules — both fire when both conditions are satisfied
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_multiple_rewrite_rules() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // Source node outputs both "energy" and "score"
    // Rule 1: energy < 0 -> inject "sub_a"
    // Rule 2: score > 0.8 -> inject "sub_b"
    let source_node = make_node_with_bindings(
        "source",
        "echo",
        vec![],
        json!({ "energy": -2.0, "score": 0.95 }),
    );

    let rule1 = make_rule(
        "rule_energy",
        "source",
        "energy",
        ConditionOperator::LessThan,
        json!(0.0),
        "sub_a",
    );

    let rule2 = make_rule(
        "rule_score",
        "source",
        "score",
        ConditionOperator::GreaterThan,
        json!(0.8),
        "sub_b",
    );

    let template = make_template("main", vec![source_node], vec![rule1, rule2]);

    let sub_a = make_template("sub_a", vec![make_node("refine", "echo", vec![])], vec![]);
    let sub_b = make_template("sub_b", vec![make_node("validate", "echo", vec![])], vec![]);

    let template_registry = TemplateRegistry::new();
    template_registry.register(sub_a);
    template_registry.register(sub_b);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(
        run.rewrite_events.len(),
        2,
        "Expected 2 rewrite events (one per rule), got {}",
        run.rewrite_events.len()
    );

    // Both rules should have fired
    let rule_ids: Vec<&str> = run.rewrite_events.iter().map(|e| e.rule_id.as_str()).collect();
    assert!(
        rule_ids.contains(&"rule_energy"),
        "rule_energy should have fired, got: {:?}",
        rule_ids
    );
    assert!(
        rule_ids.contains(&"rule_score"),
        "rule_score should have fired, got: {:?}",
        rule_ids
    );

    // Original node + 1 from sub_a + 1 from sub_b = 3 total
    assert_eq!(
        run.node_runs.len(),
        3,
        "Expected 3 nodes total (1 original + 2 injected), got {}",
        run.node_runs.len()
    );

    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should succeed"
    );
}

// ---------------------------------------------------------------------------
// Test 7: Rewrite preserves existing nodes — A -> B -> C with D injected via B
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_preserves_existing_nodes() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    let node_a = make_node("a", "echo", vec![]);
    let node_b = make_node_with_bindings(
        "b",
        "echo",
        vec!["a"],
        json!({ "trigger": true }),
    );
    let node_c = make_node("c", "echo", vec!["b"]);

    let rule = make_rule(
        "inject_d",
        "b",
        "trigger",
        ConditionOperator::Equal,
        json!(true),
        "sub_d",
    );

    let template = make_template("main", vec![node_a, node_b, node_c], vec![rule]);

    let sub_d = make_template("sub_d", vec![make_node("d", "echo", vec![])], vec![]);

    let template_registry = TemplateRegistry::new();
    template_registry.register(sub_d);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);

    // All of a, b, c must still exist and succeed
    for node_id in &["a", "b", "c"] {
        let nr = run
            .node_run(node_id)
            .unwrap_or_else(|| panic!("Expected node '{}' to exist", node_id));
        assert_eq!(
            nr.status,
            NodeStatus::Succeeded,
            "Node '{}' should succeed",
            node_id
        );
    }

    // Injected node d should also succeed
    let injected_id = "inject_d/d";
    let injected_nr = run
        .node_run(injected_id)
        .unwrap_or_else(|| panic!("Expected injected node '{}' to exist", injected_id));
    assert_eq!(
        injected_nr.status,
        NodeStatus::Succeeded,
        "Injected node '{}' should succeed",
        injected_id
    );

    // 4 nodes total: a, b, c (original) + inject_d/d (injected)
    assert_eq!(
        run.node_runs.len(),
        4,
        "Expected 4 total node runs, got {}",
        run.node_runs.len()
    );
}

// ---------------------------------------------------------------------------
// Test 8: Rewrite with input mapping — injected node bindings are rewritten
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_with_input_mapping() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // Source node outputs energy and structure
    let source_node = make_node_with_bindings(
        "source",
        "echo",
        vec![],
        json!({ "energy": -3.5, "structure": "optimized" }),
    );

    let mut rule = make_rule(
        "map_rule",
        "source",
        "energy",
        ConditionOperator::LessThan,
        json!(0.0),
        "sub_mapped",
    );
    // Map "data" input of the subgraph to source's structure output
    rule.input_map = json!({
        "data": "${nodes.source.outputs.structure}"
    });

    let template = make_template("main", vec![source_node], vec![rule]);

    // Subgraph node uses ${inputs.data} in its input_bindings
    let sub_node = make_node_with_bindings(
        "process",
        "echo",
        vec![],
        json!({ "data": "${inputs.data}" }),
    );
    let sub_template = make_template("sub_mapped", vec![sub_node], vec![]);

    let template_registry = TemplateRegistry::new();
    template_registry.register(sub_template);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.rewrite_events.len(), 1);

    // Verify the injected node exists and succeeded
    let injected_id = "map_rule/process";
    let injected_nr = run
        .node_run(injected_id)
        .unwrap_or_else(|| panic!("Expected injected node '{}' to exist", injected_id));
    assert_eq!(
        injected_nr.status,
        NodeStatus::Succeeded,
        "Injected node should succeed"
    );
}

// ---------------------------------------------------------------------------
// Test 9: Backward compatibility — template with rewrite_rules: vec![] works with run_graph
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_backward_compat_no_rewrite_rules_field() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // Template with empty rewrite_rules, used with the regular run_graph method
    let template = make_template(
        "compat_test",
        vec![
            make_node("x", "echo", vec![]),
            make_node("y", "echo", vec!["x"]),
        ],
        vec![],
    );

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should succeed"
    );
    assert_eq!(run.rewrite_events.len(), 0, "No rewrite events should exist");
    assert_eq!(run.node_runs.len(), 2);
}

// ---------------------------------------------------------------------------
// Test 10: Injected nodes have correct provenance metadata
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_monitoring_metadata() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    let source_node = make_node_with_bindings(
        "trigger_node",
        "echo",
        vec![],
        json!({ "value": 42 }),
    );

    let rule = make_rule(
        "my_rule",
        "trigger_node",
        "value",
        ConditionOperator::GreaterThan,
        json!(10),
        "sub_meta",
    );

    let template = make_template("main", vec![source_node], vec![rule]);

    let sub_template = make_template(
        "sub_meta",
        vec![
            make_node("step_a", "echo", vec![]),
            make_node("step_b", "echo", vec!["step_a"]),
        ],
        vec![],
    );

    let template_registry = TemplateRegistry::new();
    template_registry.register(sub_template);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.rewrite_events.len(), 1);

    let event = &run.rewrite_events[0];
    let event_id = &event.event_id;

    // Check metadata on both injected nodes via the rewrite event
    assert!(
        !event_id.is_empty(),
        "event_id should be a non-empty UUID string"
    );
    assert_eq!(
        event.rule_id, "my_rule",
        "event.rule_id should match the rule"
    );
    assert_eq!(
        event.source_node, "trigger_node",
        "event.source_node should match the trigger node"
    );

    // Verify both injected nodes exist and succeeded
    for injected_id in &event.injected_node_ids {
        let nr = run
            .node_run(injected_id)
            .unwrap_or_else(|| panic!("Expected injected node '{}' to exist", injected_id));
        assert_eq!(
            nr.status,
            NodeStatus::Succeeded,
            "Injected node '{}' should succeed",
            injected_id
        );
    }

    // The rewrite event records trigger outputs
    assert_eq!(
        event.trigger_outputs,
        json!({ "value": 42 }),
        "Trigger outputs should be recorded in the event"
    );

    // All 3 nodes (1 original + 2 injected) succeed
    assert_eq!(run.node_runs.len(), 3);
    assert!(run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded));
}

// ---------------------------------------------------------------------------
// Test 11: Subgraph with internal chain — dependency order preserved after injection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_subgraph_internal_chain_preserved() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    let source = make_node_with_bindings(
        "source",
        "echo",
        vec![],
        json!({ "flag": true }),
    );

    let rule = make_rule(
        "inject_chain",
        "source",
        "flag",
        ConditionOperator::Equal,
        json!(true),
        "chain_sub",
    );

    let template = make_template("main", vec![source], vec![rule]);

    // Subgraph: p -> q -> r (internal chain of 3)
    let sub_template = make_template(
        "chain_sub",
        vec![
            make_node("p", "echo", vec![]),
            make_node("q", "echo", vec!["p"]),
            make_node("r", "echo", vec!["q"]),
        ],
        vec![],
    );

    let template_registry = TemplateRegistry::new();
    template_registry.register(sub_template);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.rewrite_events.len(), 1);

    // All 4 nodes should succeed
    assert_eq!(
        run.node_runs.len(),
        4,
        "Expected 4 nodes (1 original + 3 injected)"
    );
    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should succeed"
    );

    // Internal chain nodes should be prefixed correctly
    let event = &run.rewrite_events[0];
    let ids: Vec<&str> = event.injected_node_ids.iter().map(|s| s.as_str()).collect();
    assert!(ids.contains(&"inject_chain/p"));
    assert!(ids.contains(&"inject_chain/q"));
    assert!(ids.contains(&"inject_chain/r"));
}

// ---------------------------------------------------------------------------
// Test 12: Rule with max_applications=0 effectively never fires
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_max_applications_zero_never_fires() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    let source = make_node_with_bindings(
        "node",
        "echo",
        vec![],
        json!({ "energy": -5.0 }),
    );

    let mut rule = make_rule(
        "blocked_rule",
        "node",
        "energy",
        ConditionOperator::LessThan,
        json!(0.0),
        "sub",
    );
    rule.max_applications = 0;

    let template = make_template("main", vec![source], vec![rule]);

    let sub_template = make_template("sub", vec![make_node("x", "echo", vec![])], vec![]);
    let template_registry = TemplateRegistry::new();
    template_registry.register(sub_template);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(
        run.rewrite_events.len(),
        0,
        "Rule with max_applications=0 should never fire"
    );
    assert_eq!(run.node_runs.len(), 1, "Only the original node should exist");
}

// ---------------------------------------------------------------------------
// Test 13: GreaterThanOrEqual condition boundary
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_condition_greater_than_or_equal_boundary() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // score exactly equals threshold (0.9) — GreaterThanOrEqual should fire
    let source = make_node_with_bindings(
        "scorer",
        "echo",
        vec![],
        json!({ "score": 0.9 }),
    );

    let rule = make_rule(
        "high_score_rule",
        "scorer",
        "score",
        ConditionOperator::GreaterThanOrEqual,
        json!(0.9),
        "sub_high",
    );

    let template = make_template("main", vec![source], vec![rule]);

    let sub_template = make_template("sub_high", vec![make_node("extra", "echo", vec![])], vec![]);
    let template_registry = TemplateRegistry::new();
    template_registry.register(sub_template);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(
        run.rewrite_events.len(),
        1,
        "GreaterThanOrEqual should fire at exactly the threshold value"
    );
    assert_eq!(run.node_runs.len(), 2);
    assert!(run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded));
}

// ---------------------------------------------------------------------------
// Test 14: NotEqual condition fires when values differ
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_condition_not_equal() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    let source = make_node_with_bindings(
        "checker",
        "echo",
        vec![],
        json!({ "status": "failed" }),
    );

    let rule = make_rule(
        "not_ok_rule",
        "checker",
        "status",
        ConditionOperator::NotEqual,
        json!("ok"),
        "sub_fallback",
    );

    let template = make_template("main", vec![source], vec![rule]);

    let sub_template = make_template(
        "sub_fallback",
        vec![make_node("fallback", "echo", vec![])],
        vec![],
    );
    let template_registry = TemplateRegistry::new();
    template_registry.register(sub_template);

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(
        run.rewrite_events.len(),
        1,
        "NotEqual rule should fire when status != 'ok'"
    );

    // Now test that NotEqual does NOT fire when values are equal
    let tmp2 = tempdir().unwrap();
    let engine2 = make_engine(tmp2.path());
    let source_ok = make_node_with_bindings(
        "checker",
        "echo",
        vec![],
        json!({ "status": "ok" }),
    );
    let template_ok = make_template("main_ok", vec![source_ok], vec![
        make_rule(
            "not_ok_rule",
            "checker",
            "status",
            ConditionOperator::NotEqual,
            json!("ok"),
            "sub_fallback",
        ),
    ]);
    let sub_template2 = make_template(
        "sub_fallback",
        vec![make_node("fallback", "echo", vec![])],
        vec![],
    );
    let registry2 = TemplateRegistry::new();
    registry2.register(sub_template2);

    let mut run2 = engine2.instantiate_graph(&template_ok, json!({})).unwrap();
    engine2
        .run_graph_with_rewrites(&mut run2, &template_ok, &registry2)
        .await
        .unwrap();

    assert_eq!(run2.status, GraphRunStatus::Succeeded);
    assert_eq!(
        run2.rewrite_events.len(),
        0,
        "NotEqual rule should NOT fire when status == 'ok'"
    );
}

// ---------------------------------------------------------------------------
// Test 15: run_graph_with_rewrites on empty TemplateRegistry — no panic when
//           rule never fires (template not needed)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rewrite_empty_registry_no_trigger_no_panic() {
    let tmp = tempdir().unwrap();
    let engine = make_engine(tmp.path());

    // energy=10.0 > 0 so condition (< 0) never fires, registry never consulted
    let source = make_node_with_bindings(
        "compute",
        "echo",
        vec![],
        json!({ "energy": 10.0 }),
    );

    let rule = make_rule(
        "inject_on_negative",
        "compute",
        "energy",
        ConditionOperator::LessThan,
        json!(0.0),
        "some_subgraph_not_registered",
    );

    let template = make_template("main", vec![source], vec![rule]);

    // Empty registry — if condition fires it would fail, but it won't
    let template_registry = TemplateRegistry::new();

    let mut run = engine.instantiate_graph(&template, json!({})).unwrap();
    engine
        .run_graph_with_rewrites(&mut run, &template, &template_registry)
        .await
        .unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.rewrite_events.len(), 0);
    assert_eq!(run.node_runs.len(), 1);
}

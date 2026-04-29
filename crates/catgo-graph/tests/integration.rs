mod helpers;

use std::sync::Arc;

use catgo_graph::*;
use catgo_graph::tools::mock::*;
use catgo_graph::storage::SqliteStateStore;
use catgo_graph::storage::FileArtifactStore;

fn oer_template() -> GraphTemplate {
    let yaml = include_str!("fixtures/oer_workflow.yaml");
    serde_yaml::from_str(yaml).expect("parse OER template")
}

fn make_engine(tools: Vec<Arc<dyn Tool>>) -> GraphEngine {
    let mut registry = ToolRegistry::new();
    for t in tools {
        registry.register(t);
    }

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-artifacts"));

    GraphEngine::new(
        RuntimeConfig::default(),
        registry,
        state_store,
        artifact_store,
    )
}

#[tokio::test]
async fn test_oer_workflow_all_echo() {
    // Register EchoTool for every tool name in the OER template
    let tool_names = [
        "generate_surface",
        "enumerate_adsorbates",
        "run_vasp_relax",
        "run_vasp_freq",
        "compute_gibbs_free_energy",
        "compute_oer_overpotential",
    ];
    let tools: Vec<Arc<dyn Tool>> = tool_names
        .iter()
        .map(|n| Arc::new(EchoTool::new(n)) as Arc<dyn Tool>)
        .collect();

    let engine = make_engine(tools);
    let template = oer_template();
    let inputs = serde_json::json!({"surface": "Pt(111)"});

    let mut run = engine.instantiate_graph(&template, inputs).unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should be Succeeded, got: {:?}",
        run.node_runs.iter().map(|n| (&n.node_id, &n.status)).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn test_failure_propagation() {
    // 3-node chain: a -> b -> c, where b always fails
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: test_fail
        version: '1.0'
        nodes:
          - id: a
            tool: echo
            input_bindings: {}
          - id: b
            tool: fail
            depends_on: [a]
            input_bindings: {}
          - id: c
            tool: echo
            depends_on: [b]
            input_bindings: {}
    ",
    )
    .unwrap();

    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(EchoTool::new("echo")),
        Arc::new(FailTool::new("fail", false)),
    ];
    let engine = make_engine(tools);

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.node_run("a").unwrap().status, NodeStatus::Succeeded);
    assert_eq!(run.node_run("b").unwrap().status, NodeStatus::Failed);
    assert_eq!(run.node_run("c").unwrap().status, NodeStatus::Blocked);
}

#[tokio::test]
async fn test_retry_success() {
    // Node with FlakeyTool that fails 2x then succeeds, retry_policy max_attempts: 3
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: test_retry
        version: '1.0'
        nodes:
          - id: flakey_node
            tool: flakey
            input_bindings: {}
            retry_policy:
              max_attempts: 3
              backoff:
                type: none
              retry_on: []
    ",
    )
    .unwrap();

    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(FlakeyTool::new("flakey", 2))];
    let engine = make_engine(tools);

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    let nr = run.node_run("flakey_node").unwrap();
    assert_eq!(nr.status, NodeStatus::Succeeded);
    assert_eq!(
        nr.attempts.len(),
        3,
        "Expected 3 attempts (2 failures + 1 success), got {}",
        nr.attempts.len()
    );
}

#[tokio::test]
async fn test_parallel_execution() {
    // 3 independent nodes should run in parallel
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: test_parallel
        version: '1.0'
        nodes:
          - id: a
            tool: delay
            input_bindings: {}
          - id: b
            tool: delay
            input_bindings: {}
          - id: c
            tool: delay
            input_bindings: {}
    ",
    )
    .unwrap();

    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(DelayTool::new("delay", 50))];
    let engine = make_engine(tools);

    let start = std::time::Instant::now();
    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();
    let elapsed = start.elapsed();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    // 3 nodes x 50ms each, but parallel should take ~50ms, definitely < 200ms
    assert!(
        elapsed.as_millis() < 200,
        "Parallel execution took too long: {:?}ms (expected < 200ms)",
        elapsed.as_millis()
    );
}

#[tokio::test]
async fn test_instantiate_validates_template() {
    // Template with a cycle should fail at instantiation
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: cyclic
        version: '1.0'
        nodes:
          - id: a
            tool: echo
            depends_on: [b]
            input_bindings: {}
          - id: b
            tool: echo
            depends_on: [a]
            input_bindings: {}
    ",
    )
    .unwrap();

    let engine = make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let result = engine.instantiate_graph(&template, serde_json::json!({}));
    assert!(result.is_err(), "Cyclic template should fail validation");
}

#[tokio::test]
async fn test_diamond_dag() {
    // Diamond: a -> b, a -> c, b+c -> d
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: test_diamond
        version: '1.0'
        nodes:
          - id: a
            tool: echo
            input_bindings: {}
          - id: b
            tool: echo
            depends_on: [a]
            input_bindings: {}
          - id: c
            tool: echo
            depends_on: [a]
            input_bindings: {}
          - id: d
            tool: echo
            depends_on: [b, c]
            input_bindings: {}
    ",
    )
    .unwrap();

    let engine = make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert!(run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded));
}

#[tokio::test]
async fn test_single_node_workflow() {
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: single
        version: '1.0'
        nodes:
          - id: only_node
            tool: echo
            input_bindings:
              msg: hello
    ",
    )
    .unwrap();

    let engine = make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    let nr = run.node_run("only_node").unwrap();
    assert_eq!(nr.status, NodeStatus::Succeeded);
    assert_eq!(nr.outputs.as_ref().unwrap()["msg"], "hello");
}

#[tokio::test]
async fn test_retry_exhausted_then_fails() {
    // FlakeyTool that fails 5 times, but retry_policy only allows 2 attempts
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: test_retry_fail
        version: '1.0'
        nodes:
          - id: node_a
            tool: flakey
            input_bindings: {}
            retry_policy:
              max_attempts: 2
              backoff:
                type: none
              retry_on: []
    ",
    )
    .unwrap();

    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(FlakeyTool::new("flakey", 5))];
    let engine = make_engine(tools);

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    let nr = run.node_run("node_a").unwrap();
    assert_eq!(nr.status, NodeStatus::Failed);
    assert!(nr.last_error.is_some());
}

#[tokio::test]
async fn test_state_persistence() {
    // Verify that run state is persisted to the state store
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: persist_test
        version: '1.0'
        nodes:
          - id: a
            tool: echo
            input_bindings: {}
    ",
    )
    .unwrap();

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-persist"));
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(EchoTool::new("echo")));

    let engine = GraphEngine::new(
        RuntimeConfig::default(),
        registry,
        state_store.clone(),
        artifact_store,
    );

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    let run_id = run.id.clone();
    engine.run_graph(&mut run, &template).await.unwrap();

    // Load from store and verify
    let loaded = engine.get_graph_status(&run_id).unwrap();
    assert_eq!(loaded.status, GraphRunStatus::Succeeded);
    assert_eq!(loaded.node_runs.len(), 1);
    assert_eq!(
        loaded.node_run("a").unwrap().status,
        NodeStatus::Succeeded
    );
}

// ---- Tests using shared helpers ----

#[tokio::test]
async fn test_helpers_linear_template() {
    let engine = helpers::make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let template = helpers::linear_template(4);

    assert_eq!(template.nodes.len(), 4);

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert!(run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded));
}

#[tokio::test]
async fn test_helpers_diamond_template() {
    let engine = helpers::make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let template = helpers::diamond_template();

    assert_eq!(template.nodes.len(), 4);
    assert_eq!(template.id, "diamond");

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert!(run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded));
}

// ============================================================================
// NEW TESTS: Workflow Patterns
// ============================================================================

#[tokio::test]
async fn test_wide_fan_out_10_nodes() {
    // 1 root -> 10 children, all echo tools, verify all Succeeded
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: fan_out_10
        version: '1.0'
        nodes:
          - id: root
            tool: echo
            input_bindings: {}
          - id: child_0
            tool: echo
            depends_on: [root]
            input_bindings: {}
          - id: child_1
            tool: echo
            depends_on: [root]
            input_bindings: {}
          - id: child_2
            tool: echo
            depends_on: [root]
            input_bindings: {}
          - id: child_3
            tool: echo
            depends_on: [root]
            input_bindings: {}
          - id: child_4
            tool: echo
            depends_on: [root]
            input_bindings: {}
          - id: child_5
            tool: echo
            depends_on: [root]
            input_bindings: {}
          - id: child_6
            tool: echo
            depends_on: [root]
            input_bindings: {}
          - id: child_7
            tool: echo
            depends_on: [root]
            input_bindings: {}
          - id: child_8
            tool: echo
            depends_on: [root]
            input_bindings: {}
          - id: child_9
            tool: echo
            depends_on: [root]
            input_bindings: {}
    ",
    )
    .unwrap();

    let engine = make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({"data": "fan_out"}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.node_runs.len(), 11, "Expected 1 root + 10 children = 11 nodes");
    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All 11 nodes should be Succeeded, got: {:?}",
        run.node_runs.iter().map(|n| (&n.node_id, &n.status)).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn test_fan_in_synchronization() {
    // a, b, c independent -> d depends on all 3, verify d waits for all
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: fan_in
        version: '1.0'
        nodes:
          - id: a
            tool: delay
            input_bindings:
              source: a
          - id: b
            tool: delay
            input_bindings:
              source: b
          - id: c
            tool: delay
            input_bindings:
              source: c
          - id: d
            tool: echo
            depends_on: [a, b, c]
            input_bindings:
              combined: true
    ",
    )
    .unwrap();

    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(DelayTool::new("delay", 30)),
        Arc::new(EchoTool::new("echo")),
    ];
    let engine = make_engine(tools);

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    // All 4 nodes should succeed
    for node_id in &["a", "b", "c", "d"] {
        assert_eq!(
            run.node_run(node_id).unwrap().status,
            NodeStatus::Succeeded,
            "Node '{}' should be Succeeded",
            node_id
        );
    }
    // d should have finished after a, b, c
    let d_nr = run.node_run("d").unwrap();
    assert_eq!(d_nr.status, NodeStatus::Succeeded);
}

#[tokio::test]
async fn test_deep_chain_5_nodes() {
    // a -> b -> c -> d -> e linear chain, verify execution order via outputs
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: deep_chain
        version: '1.0'
        nodes:
          - id: a
            tool: echo
            input_bindings:
              step: 1
          - id: b
            tool: echo
            depends_on: [a]
            input_bindings:
              step: 2
          - id: c
            tool: echo
            depends_on: [b]
            input_bindings:
              step: 3
          - id: d
            tool: echo
            depends_on: [c]
            input_bindings:
              step: 4
          - id: e
            tool: echo
            depends_on: [d]
            input_bindings:
              step: 5
    ",
    )
    .unwrap();

    let engine = make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.node_runs.len(), 5);

    // Verify each node succeeded with correct step output
    for (node_id, expected_step) in &[("a", 1), ("b", 2), ("c", 3), ("d", 4), ("e", 5)] {
        let nr = run.node_run(node_id).unwrap();
        assert_eq!(nr.status, NodeStatus::Succeeded, "Node '{}' should be Succeeded", node_id);
        assert_eq!(
            nr.outputs.as_ref().unwrap()["step"],
            *expected_step,
            "Node '{}' should have step={}",
            node_id,
            expected_step
        );
    }

    // Verify started_at ordering: each node must start after its predecessor finished
    for (prev, next) in &[("a", "b"), ("b", "c"), ("c", "d"), ("d", "e")] {
        let prev_finished = run.node_run(prev).unwrap().finished_at.unwrap();
        let next_started = run.node_run(next).unwrap().started_at.unwrap();
        assert!(
            next_started >= prev_finished,
            "Node '{}' should start after '{}' finishes (started={:?}, finished={:?})",
            next, prev, next_started, prev_finished
        );
    }
}

#[tokio::test]
async fn test_mixed_success_and_failure() {
    // a -> [b, c], b succeeds, c fails -> verify PartiallySucceeded
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: mixed
        version: '1.0'
        nodes:
          - id: a
            tool: echo
            input_bindings: {}
          - id: b
            tool: echo
            depends_on: [a]
            input_bindings: {}
          - id: c
            tool: fail
            depends_on: [a]
            input_bindings: {}
    ",
    )
    .unwrap();

    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(EchoTool::new("echo")),
        Arc::new(FailTool::new("fail", false)),
    ];
    let engine = make_engine(tools);

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.node_run("a").unwrap().status, NodeStatus::Succeeded);
    assert_eq!(run.node_run("b").unwrap().status, NodeStatus::Succeeded);
    assert_eq!(run.node_run("c").unwrap().status, NodeStatus::Failed);

    // Graph status should be PartiallySucceeded (some succeeded, some failed)
    assert_eq!(
        run.status,
        GraphRunStatus::PartiallySucceeded,
        "Expected PartiallySucceeded when some nodes succeed and some fail"
    );
}

// ============================================================================
// NEW TESTS: Retry and Failure
// ============================================================================

#[tokio::test]
async fn test_non_retryable_error_fails_immediately() {
    // FailTool(retryable=false), retry_policy allows 3, but fails on first attempt
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: non_retryable
        version: '1.0'
        nodes:
          - id: node_a
            tool: fail_noretry
            input_bindings: {}
            retry_policy:
              max_attempts: 3
              backoff:
                type: none
              retry_on: []
    ",
    )
    .unwrap();

    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(FailTool::new("fail_noretry", false))];
    let engine = make_engine(tools);

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    let nr = run.node_run("node_a").unwrap();
    assert_eq!(nr.status, NodeStatus::Failed);
    // Should have only 1 attempt since the error is not retryable
    assert_eq!(
        nr.attempts.len(),
        1,
        "Non-retryable error should fail after 1 attempt, got {}",
        nr.attempts.len()
    );
    assert!(nr.last_error.is_some());
    assert!(!nr.last_error.as_ref().unwrap().retryable);
}

#[tokio::test]
async fn test_retry_with_backoff_completes() {
    // FlakeyTool with Fixed backoff, verify succeeds after retries
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: retry_backoff
        version: '1.0'
        nodes:
          - id: node_a
            tool: flakey
            input_bindings:
              data: important
            retry_policy:
              max_attempts: 3
              backoff:
                type: fixed
                seconds: 0
              retry_on: []
    ",
    )
    .unwrap();

    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(FlakeyTool::new("flakey", 2))];
    let engine = make_engine(tools);

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    let nr = run.node_run("node_a").unwrap();
    assert_eq!(nr.status, NodeStatus::Succeeded);
    assert_eq!(
        nr.attempts.len(),
        3,
        "Expected 3 attempts (2 failures + 1 success with Fixed backoff), got {}",
        nr.attempts.len()
    );
    // Verify the outputs are correct after successful retry
    assert_eq!(nr.outputs.as_ref().unwrap()["data"], "important");
}

#[tokio::test]
async fn test_tool_not_found_error() {
    // Template references non-existent tool name, should error
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: tool_missing
        version: '1.0'
        nodes:
          - id: node_a
            tool: nonexistent_tool
            input_bindings: {}
    ",
    )
    .unwrap();

    // Register NO tools at all
    let engine = make_engine(vec![]);

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    let result = engine.run_graph(&mut run, &template).await;

    assert!(result.is_err(), "Running with missing tool should return an error");
    let err = result.unwrap_err();
    let err_msg = format!("{}", err);
    assert!(
        err_msg.contains("nonexistent_tool"),
        "Error should mention the missing tool name, got: {}",
        err_msg
    );
}

// ============================================================================
// NEW TESTS: Persistence and Resume
// ============================================================================

#[tokio::test]
async fn test_resume_after_partial_completion() {
    // Run workflow where one node fails, save state, create new engine from same store, resume
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: resume_test
        version: '1.0'
        nodes:
          - id: a
            tool: echo
            input_bindings:
              data: first
          - id: b
            tool: flakey
            depends_on: [a]
            input_bindings:
              data: second
            retry_policy:
              max_attempts: 1
              backoff:
                type: none
              retry_on: []
    ",
    )
    .unwrap();

    // Shared state store (persistent across engines)
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-resume"));

    // First engine: flakey tool fails on first call (fail_until=1)
    let mut registry1 = ToolRegistry::new();
    registry1.register(Arc::new(EchoTool::new("echo")));
    registry1.register(Arc::new(FlakeyTool::new("flakey", 1)));
    let engine1 = GraphEngine::new(
        RuntimeConfig::default(),
        registry1,
        state_store.clone(),
        artifact_store.clone(),
    );

    let mut run = engine1
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    let run_id = run.id.clone();
    engine1.run_graph(&mut run, &template).await.unwrap();

    // Verify partial completion: a succeeded, b failed
    assert_eq!(run.node_run("a").unwrap().status, NodeStatus::Succeeded);
    assert_eq!(run.node_run("b").unwrap().status, NodeStatus::Failed);

    // Second engine: same state store, new flakey tool with fail_until=0 (succeeds immediately)
    let mut registry2 = ToolRegistry::new();
    registry2.register(Arc::new(EchoTool::new("echo")));
    registry2.register(Arc::new(FlakeyTool::new("flakey", 0)));
    let engine2 = GraphEngine::new(
        RuntimeConfig::default(),
        registry2,
        state_store.clone(),
        artifact_store.clone(),
    );

    // Load the run from state store and verify it was persisted correctly
    let loaded = engine2.get_graph_status(&run_id).unwrap();
    assert_eq!(loaded.node_run("a").unwrap().status, NodeStatus::Succeeded);
    assert_eq!(loaded.node_run("b").unwrap().status, NodeStatus::Failed);
}

#[tokio::test]
async fn test_persistence_consistency_after_each_node() {
    // Run a 3-node chain, after completion verify store has correct node states
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: persist_chain
        version: '1.0'
        nodes:
          - id: step1
            tool: echo
            input_bindings:
              stage: one
          - id: step2
            tool: echo
            depends_on: [step1]
            input_bindings:
              stage: two
          - id: step3
            tool: echo
            depends_on: [step2]
            input_bindings:
              stage: three
    ",
    )
    .unwrap();

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-persist-chain"));
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(EchoTool::new("echo")));
    let engine = GraphEngine::new(
        RuntimeConfig::default(),
        registry,
        state_store.clone(),
        artifact_store,
    );

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    let run_id = run.id.clone();
    engine.run_graph(&mut run, &template).await.unwrap();

    // Load from store
    let loaded = engine.get_graph_status(&run_id).unwrap();
    assert_eq!(loaded.status, GraphRunStatus::Succeeded);
    assert_eq!(loaded.node_runs.len(), 3);

    // Verify each node has correct status and outputs
    for (node_id, expected_stage) in &[("step1", "one"), ("step2", "two"), ("step3", "three")] {
        let nr = loaded.node_run(node_id).unwrap();
        assert_eq!(
            nr.status,
            NodeStatus::Succeeded,
            "Persisted node '{}' should be Succeeded",
            node_id
        );
        assert_eq!(
            nr.outputs.as_ref().unwrap()["stage"],
            *expected_stage,
            "Persisted node '{}' should have stage='{}'",
            node_id,
            expected_stage
        );
        assert!(
            nr.started_at.is_some(),
            "Persisted node '{}' should have started_at",
            node_id
        );
        assert!(
            nr.finished_at.is_some(),
            "Persisted node '{}' should have finished_at",
            node_id
        );
        assert!(
            !nr.attempts.is_empty(),
            "Persisted node '{}' should have at least one attempt",
            node_id
        );
    }
}

// ============================================================================
// NEW TESTS: Repair
// ============================================================================

struct FixingRepairHandler;

#[async_trait::async_trait]
impl catgo_graph::RepairHandler for FixingRepairHandler {
    fn name(&self) -> &str {
        "fixer"
    }

    async fn repair(
        &self,
        _ctx: catgo_graph::RepairContext,
        _node_run: &catgo_graph::NodeRun,
    ) -> Result<catgo_graph::RepairOutcome, catgo_graph::StructuredError> {
        Ok(catgo_graph::RepairOutcome {
            repaired_inputs: Some(serde_json::json!({"fixed": true})),
            notes: "Applied fix".to_string(),
            artifacts: vec![],
        })
    }
}

#[tokio::test]
async fn test_repair_handler_invoked_on_failure() {
    // FlakeyTool(fail_until=1): fails once, then succeeds
    // retry_policy max_attempts=1: no retries, so repair kicks in after first failure
    // repair_policy points to "fixer" handler
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: repair_test
        version: '1.0'
        nodes:
          - id: repairable
            tool: repairable_tool
            input_bindings:
              initial: data
            retry_policy:
              max_attempts: 1
              backoff:
                type: none
              retry_on: []
            repair_policy:
              handler: fixer
              config: {}
    ",
    )
    .unwrap();

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(FlakeyTool::new("repairable_tool", 1)));

    let mut repair_registry = RepairRegistry::new();
    repair_registry.register(Arc::new(FixingRepairHandler));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-repair"));

    let engine = GraphEngine::with_repair_registry(
        RuntimeConfig::default(),
        tool_registry,
        state_store,
        artifact_store,
        repair_registry,
    );

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    let nr = run.node_run("repairable").unwrap();
    assert_eq!(
        nr.status,
        NodeStatus::Succeeded,
        "Node should succeed after repair re-execution, got {:?}",
        nr.status
    );
    // Should have at least 2 attempts: first failure + post-repair success
    assert!(
        nr.attempts.len() >= 2,
        "Expected at least 2 attempts (1 failure + 1 post-repair success), got {}",
        nr.attempts.len()
    );
}

// ============================================================================
// NEW TESTS: API
// ============================================================================

#[tokio::test]
async fn test_describe_graph_template_output() {
    // Verify describe_graph_template returns expected JSON structure
    let engine = make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let template = oer_template();

    let desc = engine.describe_graph_template(&template);

    assert_eq!(desc["id"], "oer_workflow_v1");
    assert_eq!(desc["version"], "1.0");
    assert_eq!(desc["node_count"], 10);

    // Verify node_ids is an array with the correct nodes
    let node_ids = desc["node_ids"].as_array().unwrap();
    assert_eq!(node_ids.len(), 10);
    assert!(node_ids.contains(&serde_json::json!("build_surface")));
    assert!(node_ids.contains(&serde_json::json!("enumerate_adsorbates")));
    assert!(node_ids.contains(&serde_json::json!("relax_OH")));
    assert!(node_ids.contains(&serde_json::json!("relax_O")));
    assert!(node_ids.contains(&serde_json::json!("relax_OOH")));
    assert!(node_ids.contains(&serde_json::json!("freq_OH")));
    assert!(node_ids.contains(&serde_json::json!("freq_O")));
    assert!(node_ids.contains(&serde_json::json!("freq_OOH")));
    assert!(node_ids.contains(&serde_json::json!("compute_gibbs")));
    assert!(node_ids.contains(&serde_json::json!("evaluate_oer")));

    // Verify outputs are present
    let outputs = desc["outputs"].as_array().unwrap();
    assert_eq!(outputs.len(), 2);
    assert!(outputs.contains(&serde_json::json!("oer_overpotential")));
    assert!(outputs.contains(&serde_json::json!("gibbs_summary")));

    // Verify description is present
    assert_eq!(
        desc["description"],
        "Evaluate OER activity on a catalyst surface"
    );
}

#[tokio::test]
async fn test_list_graph_runs_after_execution() {
    // Run two workflows, verify list returns both
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-list"));
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(EchoTool::new("echo")));
    let engine = GraphEngine::new(
        RuntimeConfig::default(),
        registry,
        state_store.clone(),
        artifact_store,
    );

    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: list_test
        version: '1.0'
        nodes:
          - id: a
            tool: echo
            input_bindings: {}
    ",
    )
    .unwrap();

    // Run first workflow
    let mut run1 = engine
        .instantiate_graph(&template, serde_json::json!({"run": 1}))
        .unwrap();
    let run1_id = run1.id.clone();
    engine.run_graph(&mut run1, &template).await.unwrap();

    // Run second workflow
    let mut run2 = engine
        .instantiate_graph(&template, serde_json::json!({"run": 2}))
        .unwrap();
    let run2_id = run2.id.clone();
    engine.run_graph(&mut run2, &template).await.unwrap();

    // List all runs
    let runs = engine.list_graph_runs().unwrap();
    assert_eq!(runs.len(), 2, "Expected 2 runs, got {}", runs.len());

    let run_ids: Vec<&str> = runs.iter().map(|r| r.id.as_str()).collect();
    assert!(
        run_ids.contains(&run1_id.as_str()),
        "Run list should contain first run ID"
    );
    assert!(
        run_ids.contains(&run2_id.as_str()),
        "Run list should contain second run ID"
    );

    // Both should be Succeeded
    for r in &runs {
        assert_eq!(r.status, GraphRunStatus::Succeeded);
    }
}

// ============================================================================
// NEW TESTS: Template Parsing
// ============================================================================

#[tokio::test]
async fn test_parse_oer_fixture_yaml() {
    // Load and parse tests/fixtures/oer_workflow.yaml, verify 10 nodes, correct deps
    let template = oer_template();

    assert_eq!(template.id, "oer_workflow_v1");
    assert_eq!(template.version, "1.0");
    assert_eq!(
        template.description.as_deref(),
        Some("Evaluate OER activity on a catalyst surface")
    );
    assert_eq!(template.nodes.len(), 10);

    // Verify node IDs
    let node_ids: Vec<&str> = template.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(
        node_ids,
        vec![
            "build_surface",
            "enumerate_adsorbates",
            "relax_OH",
            "relax_O",
            "relax_OOH",
            "freq_OH",
            "freq_O",
            "freq_OOH",
            "compute_gibbs",
            "evaluate_oer",
        ]
    );

    // Verify dependency structure
    let build_surface = template.nodes.iter().find(|n| n.id == "build_surface").unwrap();
    assert!(build_surface.depends_on.is_empty());
    assert_eq!(build_surface.tool, "generate_surface");

    let enumerate = template.nodes.iter().find(|n| n.id == "enumerate_adsorbates").unwrap();
    assert_eq!(enumerate.depends_on, vec!["build_surface"]);
    assert_eq!(enumerate.tool, "enumerate_adsorbates");

    // Three relaxation nodes depend on enumerate_adsorbates
    for relax_id in &["relax_OH", "relax_O", "relax_OOH"] {
        let relax = template.nodes.iter().find(|n| n.id == *relax_id).unwrap();
        assert_eq!(relax.depends_on, vec!["enumerate_adsorbates"]);
        assert_eq!(relax.tool, "run_vasp_relax");
        // Verify retry policy
        let rp = relax.retry_policy.as_ref().unwrap();
        assert_eq!(rp.max_attempts, 3);
        match &rp.backoff {
            BackoffPolicy::Fixed { seconds } => assert_eq!(*seconds, 60),
            other => panic!("Expected Fixed backoff for {}, got {:?}", relax_id, other),
        }
    }

    // Three frequency nodes depend on their respective relaxation
    for (freq_id, dep_id) in &[("freq_OH", "relax_OH"), ("freq_O", "relax_O"), ("freq_OOH", "relax_OOH")] {
        let freq = template.nodes.iter().find(|n| n.id == *freq_id).unwrap();
        assert_eq!(freq.depends_on, vec![dep_id.to_string()]);
        assert_eq!(freq.tool, "run_vasp_freq");
    }

    // compute_gibbs depends on all three frequency nodes
    let gibbs = template.nodes.iter().find(|n| n.id == "compute_gibbs").unwrap();
    assert_eq!(gibbs.depends_on, vec!["freq_OH", "freq_O", "freq_OOH"]);
    assert_eq!(gibbs.tool, "compute_gibbs_free_energy");

    // evaluate_oer depends on compute_gibbs
    let eval = template.nodes.iter().find(|n| n.id == "evaluate_oer").unwrap();
    assert_eq!(eval.depends_on, vec!["compute_gibbs"]);
    assert_eq!(eval.tool, "compute_oer_overpotential");

    // Verify outputs
    assert_eq!(template.outputs.len(), 2);
    assert_eq!(template.outputs[0].name, "oer_overpotential");
    assert_eq!(template.outputs[1].name, "gibbs_summary");
}

// ============================================================================
// NEW TESTS: VASP Adaptor Integration
// ============================================================================

#[tokio::test]
async fn test_vasp_relax_workflow() {
    // 3-node workflow: save_input(file_writer) → vasp_relax(VaspTool dry-run) → save_result(file_writer)
    let tmp = tempfile::TempDir::new().unwrap();
    let artifact_root = tmp.path().to_str().unwrap().to_string();

    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: vasp_relax_test
        version: '1.0'
        nodes:
          - id: save_input
            tool: file_writer
            input_bindings:
              structure: ${inputs.structure}
              encut: ${inputs.encut}
              kpoints: ${inputs.kpoints}
          - id: vasp_relax
            tool: vasp_relax
            depends_on: [save_input]
            input_bindings:
              structure: ${nodes.save_input.outputs.structure}
              calculation_type: relax
              encut: ${nodes.save_input.outputs.encut}
              kpoints: ${nodes.save_input.outputs.kpoints}
          - id: save_result
            tool: file_writer
            depends_on: [vasp_relax]
            input_bindings:
              energy: ${nodes.vasp_relax.outputs.energy}
              converged: ${nodes.vasp_relax.outputs.converged}
              final_structure: ${nodes.vasp_relax.outputs.final_structure}
    ",
    )
    .unwrap();

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(FileWriterTool::new("file_writer")));
    tool_registry.register(Arc::new(VaspTool::new_dry_run("vasp_relax")));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(&artifact_root));

    let engine = GraphEngine::new(
        RuntimeConfig {
            artifact_root: artifact_root.clone(),
            ..Default::default()
        },
        tool_registry,
        state_store,
        artifact_store,
    );

    let inputs = serde_json::json!({
        "structure": "Pt(111)",
        "encut": 450.0,
        "kpoints": "4 4 1"
    });

    let mut run = engine.instantiate_graph(&template, inputs).unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    // 1. All 3 nodes succeed
    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.node_runs.len(), 3);
    for node_id in &["save_input", "vasp_relax", "save_result"] {
        assert_eq!(
            run.node_run(node_id).unwrap().status,
            NodeStatus::Succeeded,
            "Node '{}' should be Succeeded",
            node_id
        );
    }

    // 2. vasp_relax outputs contain energy, converged=true
    let vasp_nr = run.node_run("vasp_relax").unwrap();
    let vasp_outputs = vasp_nr.outputs.as_ref().unwrap();
    assert!(vasp_outputs.get("energy").is_some(), "vasp_relax should have energy output");
    assert_eq!(vasp_outputs["converged"], true, "vasp_relax should have converged=true");

    // 3. save_result outputs contain energy from vasp
    let save_result_nr = run.node_run("save_result").unwrap();
    let save_outputs = save_result_nr.outputs.as_ref().unwrap();
    assert_eq!(
        save_outputs["energy"], vasp_outputs["energy"],
        "save_result energy should match vasp_relax energy"
    );

    // 4. vasp_relax node has 6 artifacts (INCAR, POSCAR, KPOINTS, OUTCAR, CONTCAR, result.json)
    assert_eq!(
        vasp_nr.artifacts.len(),
        6,
        "vasp_relax should have 6 artifacts, got {}",
        vasp_nr.artifacts.len()
    );

    // 5. Actual INCAR file contains "ENCUT = 450.0"
    let vasp_work_dir = format!("{}/{}", run.run_dir, "vasp_relax");
    let incar_path = std::path::Path::new(&vasp_work_dir).join("INCAR");
    let incar_content = std::fs::read_to_string(&incar_path)
        .unwrap_or_else(|e| panic!("Failed to read INCAR at {}: {}", incar_path.display(), e));
    assert!(
        incar_content.contains("ENCUT = 450.0"),
        "INCAR should contain 'ENCUT = 450.0', got:\n{}",
        incar_content
    );

    // 6. Graph status is Succeeded (already checked above, but explicit)
    assert_eq!(run.status, GraphRunStatus::Succeeded);
}

#[tokio::test]
async fn test_vasp_relax_yaml_fixture() {
    // Load vasp_relax.yaml fixture, register tools, run, verify graph succeeds
    let tmp = tempfile::TempDir::new().unwrap();
    let artifact_root = tmp.path().to_str().unwrap().to_string();

    let yaml = include_str!("fixtures/vasp_relax.yaml");
    let template: GraphTemplate = serde_yaml::from_str(yaml).expect("parse vasp_relax template");

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(FileWriterTool::new("file_writer")));
    tool_registry.register(Arc::new(VaspTool::new_dry_run("vasp_relax")));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(&artifact_root));

    let engine = GraphEngine::new(
        RuntimeConfig {
            artifact_root: artifact_root.clone(),
            ..Default::default()
        },
        tool_registry,
        state_store,
        artifact_store,
    );

    let inputs = serde_json::json!({
        "structure": "Pt(111)",
        "encut": 520.0,
        "kpoints": "3 3 1"
    });

    let mut run = engine.instantiate_graph(&template, inputs).unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.node_runs.len(), 3, "vasp_relax.yaml should have 3 nodes");
    assert!(
        run.node_runs.iter().all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should be Succeeded, got: {:?}",
        run.node_runs.iter().map(|n| (&n.node_id, &n.status)).collect::<Vec<_>>()
    );

    // Verify vasp_relax outputs
    let vasp_nr = run.node_run("vasp_relax").unwrap();
    let outputs = vasp_nr.outputs.as_ref().unwrap();
    assert!(outputs.get("energy").is_some());
    assert_eq!(outputs["converged"], true);
    assert_eq!(outputs["final_structure"], "Pt(111)");
}

#[tokio::test]
async fn test_vasp_freq_calculation() {
    // Single vasp node with calculation_type="freq"
    let tmp = tempfile::TempDir::new().unwrap();
    let artifact_root = tmp.path().to_str().unwrap().to_string();

    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: vasp_freq_test
        version: '1.0'
        nodes:
          - id: vasp_freq
            tool: vasp_freq
            input_bindings:
              structure: Pt(111)
              calculation_type: freq
              encut: 520.0
              kpoints: '3 3 1'
    ",
    )
    .unwrap();

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(VaspTool::new_dry_run("vasp_freq")));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(&artifact_root));

    let engine = GraphEngine::new(
        RuntimeConfig {
            artifact_root: artifact_root.clone(),
            ..Default::default()
        },
        tool_registry,
        state_store,
        artifact_store,
    );

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);

    let vasp_nr = run.node_run("vasp_freq").unwrap();
    assert_eq!(vasp_nr.status, NodeStatus::Succeeded);

    // Verify INCAR contains IBRION=5 for freq calculation
    let vasp_work_dir = format!("{}/{}", run.run_dir, "vasp_freq");
    let incar_content = std::fs::read_to_string(
        std::path::Path::new(&vasp_work_dir).join("INCAR"),
    )
    .expect("Failed to read INCAR");
    assert!(
        incar_content.contains("IBRION = 5"),
        "INCAR should contain 'IBRION = 5' for freq calculation, got:\n{}",
        incar_content
    );

    // Verify n_ionic_steps=1 for freq calculation
    let outputs = vasp_nr.outputs.as_ref().unwrap();
    assert_eq!(
        outputs["n_ionic_steps"], 1,
        "freq calculation should have n_ionic_steps=1"
    );
}

#[tokio::test]
async fn test_vasp_deterministic_energy() {
    // Run two separate graphs with same structure, verify energy outputs are identical
    let tmp1 = tempfile::TempDir::new().unwrap();
    let tmp2 = tempfile::TempDir::new().unwrap();

    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: vasp_determ_test
        version: '1.0'
        nodes:
          - id: vasp_relax
            tool: vasp_relax
            input_bindings:
              structure: ${inputs.structure}
              calculation_type: relax
              encut: 450.0
              kpoints: '3 3 1'
    ",
    )
    .unwrap();

    let inputs = serde_json::json!({"structure": "Pt(111)"});

    // Run 1
    let artifact_root_1 = tmp1.path().to_str().unwrap().to_string();
    let mut tool_registry_1 = ToolRegistry::new();
    tool_registry_1.register(Arc::new(VaspTool::new_dry_run("vasp_relax")));
    let engine1 = GraphEngine::new(
        RuntimeConfig {
            artifact_root: artifact_root_1.clone(),
            ..Default::default()
        },
        tool_registry_1,
        Arc::new(SqliteStateStore::new(":memory:").unwrap()),
        Arc::new(FileArtifactStore::new(&artifact_root_1)),
    );
    let mut run1 = engine1
        .instantiate_graph(&template, inputs.clone())
        .unwrap();
    engine1.run_graph(&mut run1, &template).await.unwrap();

    // Run 2
    let artifact_root_2 = tmp2.path().to_str().unwrap().to_string();
    let mut tool_registry_2 = ToolRegistry::new();
    tool_registry_2.register(Arc::new(VaspTool::new_dry_run("vasp_relax")));
    let engine2 = GraphEngine::new(
        RuntimeConfig {
            artifact_root: artifact_root_2.clone(),
            ..Default::default()
        },
        tool_registry_2,
        Arc::new(SqliteStateStore::new(":memory:").unwrap()),
        Arc::new(FileArtifactStore::new(&artifact_root_2)),
    );
    let mut run2 = engine2
        .instantiate_graph(&template, inputs)
        .unwrap();
    engine2.run_graph(&mut run2, &template).await.unwrap();

    // Both should succeed
    assert_eq!(run1.status, GraphRunStatus::Succeeded);
    assert_eq!(run2.status, GraphRunStatus::Succeeded);

    // Energy outputs should be identical (deterministic dry-run)
    let energy1 = run1
        .node_run("vasp_relax")
        .unwrap()
        .outputs
        .as_ref()
        .unwrap()["energy"]
        .as_f64()
        .unwrap();
    let energy2 = run2
        .node_run("vasp_relax")
        .unwrap()
        .outputs
        .as_ref()
        .unwrap()["energy"]
        .as_f64()
        .unwrap();

    assert_eq!(
        energy1, energy2,
        "Deterministic dry-run should produce identical energy: {} vs {}",
        energy1, energy2
    );
}

// ============================================================================
// NEW TESTS: Phase 7 — Mid-Execution Monitoring & Template Registry
// ============================================================================

#[tokio::test]
async fn test_monitoring_during_execution() {
    // Phase 7: Verify get_run_detail() produces correct, serializable output
    // suitable for frontend consumption at different lifecycle stages.

    // 1. Create engine with echo + delay tools
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-monitoring"));
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(EchoTool::new("echo")));
    registry.register(Arc::new(DelayTool::new("delay", 50)));
    let engine = GraphEngine::new(
        RuntimeConfig::default(),
        registry,
        state_store.clone(),
        artifact_store,
    );

    // 2. Build a 3-node chain: A(delay) -> B(echo) -> C(echo)
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: monitoring_test
        version: '1.0'
        nodes:
          - id: a
            tool: delay
            input_bindings:
              step: first
          - id: b
            tool: echo
            depends_on: [a]
            input_bindings:
              step: second
          - id: c
            tool: echo
            depends_on: [b]
            input_bindings:
              step: third
    ",
    )
    .unwrap();

    // 3. Instantiate the graph (not yet run)
    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({"workflow": "monitoring"}))
        .unwrap();
    let run_id = run.id.clone();

    // 4. Query get_run_detail() BEFORE execution — all nodes should be Pending, status Created
    let pre_detail = engine.get_run_detail(&run_id).unwrap();
    assert_eq!(pre_detail.status, GraphRunStatus::Created);
    assert_eq!(pre_detail.node_count, 3);
    assert_eq!(pre_detail.template_id, "monitoring_test");
    assert_eq!(pre_detail.nodes.len(), 3);

    // All nodes should be Pending before execution
    for node_detail in &pre_detail.nodes {
        assert_eq!(
            node_detail.status,
            NodeStatus::Pending,
            "Pre-run: node '{}' should be Pending, got {:?}",
            node_detail.node_id,
            node_detail.status
        );
        // No timestamps before execution
        assert!(
            node_detail.started_at.is_none(),
            "Pre-run: node '{}' should have no started_at",
            node_detail.node_id
        );
        assert!(
            node_detail.finished_at.is_none(),
            "Pre-run: node '{}' should have no finished_at",
            node_detail.node_id
        );
        assert!(
            node_detail.last_error.is_none(),
            "Pre-run: node '{}' should have no error",
            node_detail.node_id
        );
    }

    // Verify pre-run detail serializes to valid JSON
    let pre_json = serde_json::to_value(&pre_detail).unwrap();
    assert_eq!(pre_json["status"], "created");
    assert_eq!(pre_json["node_count"], 3);

    // 5. Run the graph to completion
    engine.run_graph(&mut run, &template).await.unwrap();

    // 6. Query get_run_detail() AFTER execution — all nodes should be Succeeded
    let post_detail = engine.get_run_detail(&run_id).unwrap();
    assert_eq!(post_detail.status, GraphRunStatus::Succeeded);
    assert_eq!(post_detail.node_count, 3);
    assert_eq!(post_detail.template_id, "monitoring_test");
    assert_eq!(post_detail.nodes.len(), 3);

    // All nodes should be Succeeded after execution
    for node_detail in &post_detail.nodes {
        assert_eq!(
            node_detail.status,
            NodeStatus::Succeeded,
            "Post-run: node '{}' should be Succeeded, got {:?}",
            node_detail.node_id,
            node_detail.status
        );
        assert!(
            node_detail.last_error.is_none(),
            "Post-run: node '{}' should have no error",
            node_detail.node_id
        );
    }

    // 7. Verify timestamps are present on completed nodes
    for node_detail in &post_detail.nodes {
        assert!(
            node_detail.started_at.is_some(),
            "Post-run: node '{}' should have started_at timestamp",
            node_detail.node_id
        );
        assert!(
            node_detail.finished_at.is_some(),
            "Post-run: node '{}' should have finished_at timestamp",
            node_detail.node_id
        );
    }

    // 8. Verify the full detail serializes to valid JSON (frontend-consumable)
    let post_json = serde_json::to_value(&post_detail).unwrap();
    assert_eq!(post_json["status"], "succeeded");
    assert_eq!(post_json["node_count"], 3);
    assert!(post_json["id"].is_string());
    assert!(post_json["template_id"].is_string());
    assert!(post_json["created_at"].is_string());
    assert!(post_json["updated_at"].is_string());

    // Verify nodes array in JSON
    let nodes_json = post_json["nodes"].as_array().unwrap();
    assert_eq!(nodes_json.len(), 3);
    for node_json in nodes_json {
        assert!(node_json["node_id"].is_string());
        assert_eq!(node_json["status"], "succeeded");
        assert!(node_json["started_at"].is_string());
        assert!(node_json["finished_at"].is_string());
        assert!(node_json["attempts"].is_number());
        assert!(node_json["artifact_count"].is_number());
        // last_error should be null for successful nodes
        assert!(node_json["last_error"].is_null());
    }

    // 9. Verify round-trip: JSON can be deserialized back to GraphRunDetail
    let roundtrip: catgo_graph::api::dto::GraphRunDetail =
        serde_json::from_value(post_json.clone()).unwrap();
    assert_eq!(roundtrip.id, post_detail.id);
    assert_eq!(roundtrip.status, GraphRunStatus::Succeeded);
    assert_eq!(roundtrip.node_count, 3);
    assert_eq!(roundtrip.nodes.len(), 3);
}

#[test]
fn test_template_registry_integration() {
    use catgo_graph::TemplateRegistry;

    let registry = TemplateRegistry::new();

    // Create two templates with different IDs
    let template_a: GraphTemplate = serde_yaml::from_str(
        "
        id: alpha_workflow
        version: '2.0'
        description: Alpha workflow for testing
        nodes:
          - id: step1
            tool: echo
            input_bindings: {}
          - id: step2
            tool: echo
            depends_on: [step1]
            input_bindings: {}
    ",
    )
    .unwrap();

    let template_b: GraphTemplate = serde_yaml::from_str(
        "
        id: beta_workflow
        version: '1.5'
        description: Beta workflow for testing
        nodes:
          - id: only
            tool: echo
            input_bindings: {}
    ",
    )
    .unwrap();

    // Register both templates
    registry.register(template_a.clone());
    registry.register(template_b.clone());

    // Verify list() returns sorted summaries (alpha before beta)
    let summaries = registry.list();
    assert_eq!(summaries.len(), 2);

    // Should be sorted by ID alphabetically
    assert_eq!(summaries[0].id, "alpha_workflow");
    assert_eq!(summaries[0].version, "2.0");
    assert_eq!(
        summaries[0].description,
        Some("Alpha workflow for testing".to_string())
    );
    assert_eq!(summaries[0].node_count, 2);

    assert_eq!(summaries[1].id, "beta_workflow");
    assert_eq!(summaries[1].version, "1.5");
    assert_eq!(
        summaries[1].description,
        Some("Beta workflow for testing".to_string())
    );
    assert_eq!(summaries[1].node_count, 1);

    // Verify get() returns the correct template
    let got_a = registry.get("alpha_workflow").unwrap();
    assert_eq!(got_a.id, "alpha_workflow");
    assert_eq!(got_a.version, "2.0");
    assert_eq!(got_a.nodes.len(), 2);
    assert_eq!(got_a.nodes[0].id, "step1");
    assert_eq!(got_a.nodes[1].id, "step2");
    assert_eq!(got_a.nodes[1].depends_on, vec!["step1"]);

    let got_b = registry.get("beta_workflow").unwrap();
    assert_eq!(got_b.id, "beta_workflow");
    assert_eq!(got_b.version, "1.5");
    assert_eq!(got_b.nodes.len(), 1);
    assert_eq!(got_b.nodes[0].id, "only");

    // Verify get() returns None for non-existent template
    assert!(registry.get("nonexistent").is_none());

    // Verify TemplateSummary serializes correctly (frontend-consumable)
    let summary_json = serde_json::to_value(&summaries[0]).unwrap();
    assert_eq!(summary_json["id"], "alpha_workflow");
    assert_eq!(summary_json["version"], "2.0");
    assert_eq!(summary_json["description"], "Alpha workflow for testing");
    assert_eq!(summary_json["node_count"], 2);

    // Verify list_full() returns full templates sorted by ID
    let full_list = registry.list_full();
    assert_eq!(full_list.len(), 2);
    assert_eq!(full_list[0].id, "alpha_workflow");
    assert_eq!(full_list[1].id, "beta_workflow");
}

// ============================================================================
// NEW TESTS: Phase 8 — Conditional Node Skipping
// ============================================================================

#[tokio::test]
async fn test_conditional_skip_workflow() {
    // 3-node chain: relax -> freq -> analyze
    // relax produces converged=false
    // freq has skip_condition: skip when ${nodes.relax.outputs.converged} == false
    // Expected: relax=Succeeded, freq=Skipped, analyze=Blocked (dep freq not Succeeded)
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: conditional_skip_test
        version: '1.0'
        nodes:
          - id: relax
            tool: echo
            input_bindings:
              converged: false
              energy: -123.45
          - id: freq
            tool: echo
            depends_on: [relax]
            input_bindings:
              structure: relaxed
            skip_condition:
              expression: '${nodes.relax.outputs.converged}'
              equals: false
          - id: analyze
            tool: echo
            depends_on: [freq]
            input_bindings:
              data: final
    ",
    )
    .unwrap();

    let engine = make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    // relax should succeed (it runs normally, outputs converged=false)
    assert_eq!(
        run.node_run("relax").unwrap().status,
        NodeStatus::Succeeded,
        "relax node should succeed"
    );
    assert_eq!(
        run.node_run("relax").unwrap().outputs.as_ref().unwrap()["converged"],
        false,
        "relax should output converged=false"
    );

    // freq should be Skipped (skip_condition matches: converged == false)
    assert_eq!(
        run.node_run("freq").unwrap().status,
        NodeStatus::Skipped,
        "freq node should be Skipped because converged=false matches skip_condition"
    );

    // analyze should be Blocked (its dep freq was Skipped, not Succeeded)
    assert_eq!(
        run.node_run("analyze").unwrap().status,
        NodeStatus::Blocked,
        "analyze node should be Blocked because its dependency freq was Skipped"
    );

    // Graph should not be fully Succeeded (has Skipped and Blocked nodes)
    assert_ne!(
        run.status,
        GraphRunStatus::Succeeded,
        "Graph should not be Succeeded when nodes are Skipped/Blocked"
    );
}

#[tokio::test]
async fn test_conditional_skip_no_trigger() {
    // Same structure as test_conditional_skip_workflow, but relax outputs converged=true.
    // freq's skip_condition (skip when converged==false) does NOT match.
    // All 3 nodes should succeed normally.
    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: conditional_no_skip_test
        version: '1.0'
        nodes:
          - id: relax
            tool: echo
            input_bindings:
              converged: true
              energy: -456.78
          - id: freq
            tool: echo
            depends_on: [relax]
            input_bindings:
              structure: relaxed
            skip_condition:
              expression: '${nodes.relax.outputs.converged}'
              equals: false
          - id: analyze
            tool: echo
            depends_on: [freq]
            input_bindings:
              data: final
    ",
    )
    .unwrap();

    let engine = make_engine(vec![Arc::new(EchoTool::new("echo"))]);
    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    // All 3 nodes should succeed
    assert_eq!(run.status, GraphRunStatus::Succeeded);
    for node_id in &["relax", "freq", "analyze"] {
        assert_eq!(
            run.node_run(node_id).unwrap().status,
            NodeStatus::Succeeded,
            "Node '{}' should be Succeeded when skip_condition does not match",
            node_id
        );
    }
}

// ============================================================================
// Phase 3: Real Workflow with Real Tools (data pipeline)
// ============================================================================

#[tokio::test]
async fn test_data_pipeline_end_to_end() {
    // Build a 3-node pipeline programmatically:
    // save_input (FileWriterTool) -> compute_stats (StatsTool) -> save_result (FileWriterTool)
    let tmp = tempfile::TempDir::new().unwrap();
    let artifact_root = tmp.path().to_str().unwrap().to_string();

    let template = GraphTemplate {
        id: "data_pipeline_e2e".to_string(),
        version: "1.0".to_string(),
        description: Some("End-to-end data pipeline test".to_string()),
        inputs_schema: serde_json::json!({}),
        rewrite_rules: vec![],
        nodes: vec![
            NodeTemplate {
                id: "save_input".to_string(),
                tool: "file_writer".to_string(),
                depends_on: vec![],
                input_bindings: serde_json::json!({
                    "values": "${inputs.values}",
                    "label": "${inputs.label}"
                }),
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
                id: "compute_stats".to_string(),
                tool: "compute_stats".to_string(),
                depends_on: vec!["save_input".to_string()],
                input_bindings: serde_json::json!({
                    "values": "${nodes.save_input.outputs.values}",
                    "label": "${nodes.save_input.outputs.label}"
                }),
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
                id: "save_result".to_string(),
                tool: "file_writer".to_string(),
                depends_on: vec!["compute_stats".to_string()],
                input_bindings: serde_json::json!({
                    "mean": "${nodes.compute_stats.outputs.mean}",
                    "min": "${nodes.compute_stats.outputs.min}",
                    "max": "${nodes.compute_stats.outputs.max}",
                    "count": "${nodes.compute_stats.outputs.count}",
                    "label": "${nodes.compute_stats.outputs.label}"
                }),
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
        outputs: vec![],
        metadata: Default::default(),
    };

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(FileWriterTool::new("file_writer")));
    tool_registry.register(Arc::new(StatsTool::new("compute_stats")));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(tmp.path()));

    let engine = GraphEngine::new(
        RuntimeConfig {
            artifact_root: artifact_root.clone(),
            ..RuntimeConfig::default()
        },
        tool_registry,
        state_store,
        artifact_store,
    );

    let inputs = serde_json::json!({
        "values": [10.0, 20.0, 30.0],
        "label": "test_data"
    });

    let mut run = engine.instantiate_graph(&template, inputs).unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    // All 3 nodes succeed
    assert_eq!(run.status, GraphRunStatus::Succeeded);
    assert_eq!(run.node_runs.len(), 3);
    for nr in &run.node_runs {
        assert_eq!(
            nr.status,
            NodeStatus::Succeeded,
            "Node '{}' should be Succeeded, got {:?}",
            nr.node_id,
            nr.status
        );
    }

    // compute_stats node outputs have correct statistics
    let stats_nr = run.node_run("compute_stats").unwrap();
    let stats_outputs = stats_nr.outputs.as_ref().unwrap();
    assert_eq!(stats_outputs["mean"], 20.0);
    assert_eq!(stats_outputs["min"], 10.0);
    assert_eq!(stats_outputs["max"], 30.0);
    assert_eq!(stats_outputs["count"], 3);
    assert_eq!(stats_outputs["label"], "test_data");

    // save_result node outputs contain the stats
    let result_nr = run.node_run("save_result").unwrap();
    let result_outputs = result_nr.outputs.as_ref().unwrap();
    assert_eq!(result_outputs["mean"], 20.0);
    assert_eq!(result_outputs["min"], 10.0);
    assert_eq!(result_outputs["max"], 30.0);

    // Each node has at least 1 artifact
    for nr in &run.node_runs {
        assert!(
            !nr.artifacts.is_empty(),
            "Node '{}' should have at least 1 artifact, got {}",
            nr.node_id,
            nr.artifacts.len()
        );
    }

    // Artifact file paths exist on disk
    for nr in &run.node_runs {
        for artifact in &nr.artifacts {
            if let Some(path) = &artifact.path {
                assert!(
                    std::path::Path::new(path).exists(),
                    "Artifact file should exist on disk: {} (node '{}')",
                    path,
                    nr.node_id
                );
            }
        }
    }

    // Graph status is Succeeded
    assert_eq!(run.status, GraphRunStatus::Succeeded);
}

#[tokio::test]
async fn test_data_pipeline_yaml_fixture() {
    // Load data_pipeline.yaml, register file_writer + compute_stats tools,
    // run with inputs, verify graph succeeds.
    let yaml = include_str!("fixtures/data_pipeline.yaml");
    let template: GraphTemplate = serde_yaml::from_str(yaml).expect("parse data_pipeline.yaml");

    let tmp = tempfile::TempDir::new().unwrap();

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(FileWriterTool::new("file_writer")));
    tool_registry.register(Arc::new(StatsTool::new("compute_stats")));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(tmp.path()));

    let engine = GraphEngine::new(
        RuntimeConfig {
            artifact_root: tmp.path().to_str().unwrap().to_string(),
            ..RuntimeConfig::default()
        },
        tool_registry,
        state_store,
        artifact_store,
    );

    let inputs = serde_json::json!({
        "values": [5.0, 15.0, 25.0],
        "label": "yaml_fixture_test"
    });

    let mut run = engine.instantiate_graph(&template, inputs).unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(
        run.status,
        GraphRunStatus::Succeeded,
        "Graph from YAML fixture should succeed"
    );
    assert_eq!(run.node_runs.len(), 3);
    assert!(
        run.node_runs
            .iter()
            .all(|n| n.status == NodeStatus::Succeeded),
        "All nodes should succeed, got: {:?}",
        run.node_runs
            .iter()
            .map(|n| (&n.node_id, &n.status))
            .collect::<Vec<_>>()
    );

    // Verify stats are correct
    let stats = run.node_run("compute_stats").unwrap();
    let out = stats.outputs.as_ref().unwrap();
    assert_eq!(out["mean"], 15.0);
    assert_eq!(out["min"], 5.0);
    assert_eq!(out["max"], 25.0);
}

#[tokio::test]
async fn test_real_tool_output_propagation() {
    // Two-node chain: file_writer ("save") -> compute_stats ("stats")
    // file_writer receives {values: [1.0, 2.0, 3.0]}, passes through outputs.
    // compute_stats receives values from save node via ${nodes.save.outputs.values}
    let tmp = tempfile::TempDir::new().unwrap();

    let template = GraphTemplate {
        id: "output_propagation".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: serde_json::json!({}),
        rewrite_rules: vec![],
        nodes: vec![
            NodeTemplate {
                id: "save".to_string(),
                tool: "file_writer".to_string(),
                depends_on: vec![],
                input_bindings: serde_json::json!({
                    "values": "${inputs.values}",
                    "label": "${inputs.label}"
                }),
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
                id: "stats".to_string(),
                tool: "compute_stats".to_string(),
                depends_on: vec!["save".to_string()],
                input_bindings: serde_json::json!({
                    "values": "${nodes.save.outputs.values}",
                    "label": "${nodes.save.outputs.label}"
                }),
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
        outputs: vec![],
        metadata: Default::default(),
    };

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(FileWriterTool::new("file_writer")));
    tool_registry.register(Arc::new(StatsTool::new("compute_stats")));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(tmp.path()));

    let engine = GraphEngine::new(
        RuntimeConfig {
            artifact_root: tmp.path().to_str().unwrap().to_string(),
            ..RuntimeConfig::default()
        },
        tool_registry,
        state_store,
        artifact_store,
    );

    let inputs = serde_json::json!({
        "values": [1.0, 2.0, 3.0],
        "label": "propagation_test"
    });

    let mut run = engine.instantiate_graph(&template, inputs).unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);

    // Verify file_writer passed through the values array correctly
    let save_nr = run.node_run("save").unwrap();
    assert_eq!(
        save_nr.outputs.as_ref().unwrap()["values"],
        serde_json::json!([1.0, 2.0, 3.0])
    );

    // Verify stats computed correctly from propagated values
    let stats_nr = run.node_run("stats").unwrap();
    let stats_out = stats_nr.outputs.as_ref().unwrap();
    assert_eq!(stats_out["mean"], 2.0);
    assert_eq!(stats_out["min"], 1.0);
    assert_eq!(stats_out["max"], 3.0);
    assert_eq!(stats_out["count"], 3);
    assert_eq!(stats_out["sum"], 6.0);
    assert_eq!(stats_out["label"], "propagation_test");
}

// ============================================================================
// Phase 4: Retry / Resume / Artifact Validation with Real Tools
// ============================================================================

#[tokio::test]
async fn test_real_tool_retry_then_success() {
    // FlakeyTool(fail_until=1) as first node with retry_policy(max_attempts=3),
    // followed by a FileWriterTool node.
    // First node retries once then succeeds, second node runs and produces artifact.
    let tmp = tempfile::TempDir::new().unwrap();

    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: retry_then_success
        version: '1.0'
        nodes:
          - id: flakey_node
            tool: flakey
            input_bindings:
              values: ${inputs.values}
            retry_policy:
              max_attempts: 3
              backoff:
                type: none
              retry_on: []
          - id: save_node
            tool: file_writer
            depends_on: [flakey_node]
            input_bindings:
              values: ${nodes.flakey_node.outputs.values}
    ",
    )
    .unwrap();

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(FlakeyTool::new("flakey", 1)));
    tool_registry.register(Arc::new(FileWriterTool::new("file_writer")));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(tmp.path()));

    let engine = GraphEngine::new(
        RuntimeConfig {
            artifact_root: tmp.path().to_str().unwrap().to_string(),
            ..RuntimeConfig::default()
        },
        tool_registry,
        state_store,
        artifact_store,
    );

    let inputs = serde_json::json!({"values": [10.0, 20.0]});
    let mut run = engine.instantiate_graph(&template, inputs).unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    assert_eq!(run.status, GraphRunStatus::Succeeded);

    // First node: retried once then succeeded
    let flakey_nr = run.node_run("flakey_node").unwrap();
    assert_eq!(flakey_nr.status, NodeStatus::Succeeded);
    assert_eq!(
        flakey_nr.attempts.len(),
        2,
        "Expected 2 attempts (1 failure + 1 success), got {}",
        flakey_nr.attempts.len()
    );

    // Second node: ran and produced artifact
    let save_nr = run.node_run("save_node").unwrap();
    assert_eq!(save_nr.status, NodeStatus::Succeeded);
    assert!(
        !save_nr.artifacts.is_empty(),
        "save_node should have at least 1 artifact"
    );
    // Artifact file should exist on disk
    for artifact in &save_nr.artifacts {
        if let Some(path) = &artifact.path {
            assert!(
                std::path::Path::new(path).exists(),
                "Artifact file should exist: {}",
                path
            );
        }
    }
}

#[tokio::test]
async fn test_real_tool_retry_exhausted() {
    // FailTool(retryable=true) with retry_policy(max_attempts=2).
    // Downstream node should become Blocked.
    let tmp = tempfile::TempDir::new().unwrap();

    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: retry_exhausted
        version: '1.0'
        nodes:
          - id: always_fail
            tool: fail_retryable
            input_bindings: {}
            retry_policy:
              max_attempts: 2
              backoff:
                type: none
              retry_on: []
          - id: downstream
            tool: echo
            depends_on: [always_fail]
            input_bindings:
              data: should_not_run
    ",
    )
    .unwrap();

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(FailTool::new("fail_retryable", true)));
    tool_registry.register(Arc::new(EchoTool::new("echo")));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(tmp.path()));

    let engine = GraphEngine::new(
        RuntimeConfig {
            artifact_root: tmp.path().to_str().unwrap().to_string(),
            ..RuntimeConfig::default()
        },
        tool_registry,
        state_store,
        artifact_store,
    );

    let mut run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();

    // First node exhausted retries and failed
    let fail_nr = run.node_run("always_fail").unwrap();
    assert_eq!(fail_nr.status, NodeStatus::Failed);
    assert_eq!(
        fail_nr.attempts.len(),
        2,
        "Expected 2 attempts, got {}",
        fail_nr.attempts.len()
    );

    // Downstream node should be Blocked
    let downstream_nr = run.node_run("downstream").unwrap();
    assert_eq!(
        downstream_nr.status,
        NodeStatus::Blocked,
        "Downstream node should be Blocked when upstream fails"
    );

    // Graph should be Failed or PartiallySucceeded
    assert!(
        run.status == GraphRunStatus::Failed || run.status == GraphRunStatus::PartiallySucceeded,
        "Graph should be Failed or PartiallySucceeded, got {:?}",
        run.status
    );
}

#[tokio::test]
async fn test_resume_after_partial_with_real_tools() {
    // 3-node chain: echo_node -> fail_node -> file_writer_node
    // Run 1: echo succeeds, fail fails, file_writer blocked.
    // Manually reset fail node to Pending, replace tool with EchoTool, resume.
    // Verify node 1 stays Succeeded, nodes 2+3 complete.
    let tmp = tempfile::TempDir::new().unwrap();

    let template: GraphTemplate = serde_yaml::from_str(
        "
        id: resume_real_tools
        version: '1.0'
        nodes:
          - id: step1
            tool: echo
            input_bindings:
              values: ${inputs.values}
          - id: step2
            tool: middle_tool
            depends_on: [step1]
            input_bindings:
              values: ${nodes.step1.outputs.values}
          - id: step3
            tool: file_writer
            depends_on: [step2]
            input_bindings:
              values: ${nodes.step2.outputs.values}
    ",
    )
    .unwrap();

    // First run: middle_tool = FailTool (non-retryable)
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(tmp.path()));

    let mut registry1 = ToolRegistry::new();
    registry1.register(Arc::new(EchoTool::new("echo")));
    registry1.register(Arc::new(FailTool::new("middle_tool", false)));
    registry1.register(Arc::new(FileWriterTool::new("file_writer")));

    let engine1 = GraphEngine::new(
        RuntimeConfig {
            artifact_root: tmp.path().to_str().unwrap().to_string(),
            ..RuntimeConfig::default()
        },
        registry1,
        state_store.clone(),
        artifact_store.clone(),
    );

    let inputs = serde_json::json!({"values": [100.0, 200.0]});
    let mut run = engine1.instantiate_graph(&template, inputs).unwrap();
    let run_id = run.id.clone();
    engine1.run_graph(&mut run, &template).await.unwrap();

    // Verify partial completion: step1 succeeded, step2 failed, step3 blocked
    assert_eq!(run.node_run("step1").unwrap().status, NodeStatus::Succeeded);
    assert_eq!(run.node_run("step2").unwrap().status, NodeStatus::Failed);
    assert_eq!(run.node_run("step3").unwrap().status, NodeStatus::Blocked);

    // Manually reset step2 and step3 to Pending in the persisted state
    {
        let mut loaded = state_store.load_graph_run(&run_id).unwrap();
        let s2 = loaded.node_run_mut("step2").unwrap();
        s2.status = NodeStatus::Pending;
        s2.last_error = None;
        s2.started_at = None;
        s2.finished_at = None;
        let s3 = loaded.node_run_mut("step3").unwrap();
        s3.status = NodeStatus::Pending;
        loaded.status = GraphRunStatus::Running;
        state_store.save_graph_run(&loaded).unwrap();
    }

    // Second engine: middle_tool = EchoTool (will succeed)
    let mut registry2 = ToolRegistry::new();
    registry2.register(Arc::new(EchoTool::new("echo")));
    registry2.register(Arc::new(EchoTool::new("middle_tool")));
    registry2.register(Arc::new(FileWriterTool::new("file_writer")));

    let engine2 = GraphEngine::new(
        RuntimeConfig {
            artifact_root: tmp.path().to_str().unwrap().to_string(),
            ..RuntimeConfig::default()
        },
        registry2,
        state_store.clone(),
        artifact_store.clone(),
    );

    // Resume the run
    let resumed = engine2.resume_graph(&run_id, &template).await.unwrap();

    // Verify: step1 stays Succeeded, steps 2+3 complete
    assert_eq!(
        resumed.node_run("step1").unwrap().status,
        NodeStatus::Succeeded,
        "step1 should remain Succeeded after resume"
    );
    assert_eq!(
        resumed.node_run("step2").unwrap().status,
        NodeStatus::Succeeded,
        "step2 should be Succeeded after resume"
    );
    assert_eq!(
        resumed.node_run("step3").unwrap().status,
        NodeStatus::Succeeded,
        "step3 should be Succeeded after resume"
    );
    assert_eq!(
        resumed.status,
        GraphRunStatus::Succeeded,
        "Graph should be fully Succeeded after resume"
    );

    // step3 (file_writer) should have produced an artifact
    let step3_nr = resumed.node_run("step3").unwrap();
    assert!(
        !step3_nr.artifacts.is_empty(),
        "step3 (file_writer) should produce at least 1 artifact"
    );
}

#[tokio::test]
async fn test_artifact_consistency_after_run() {
    // Run data pipeline, then reload state from store, verify artifact refs
    // on nodes match, and file paths still exist on disk.
    let tmp = tempfile::TempDir::new().unwrap();

    let template = GraphTemplate {
        id: "artifact_consistency".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: serde_json::json!({}),
        rewrite_rules: vec![],
        nodes: vec![
            NodeTemplate {
                id: "save_input".to_string(),
                tool: "file_writer".to_string(),
                depends_on: vec![],
                input_bindings: serde_json::json!({
                    "values": "${inputs.values}",
                    "label": "${inputs.label}"
                }),
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
                id: "compute_stats".to_string(),
                tool: "compute_stats".to_string(),
                depends_on: vec!["save_input".to_string()],
                input_bindings: serde_json::json!({
                    "values": "${nodes.save_input.outputs.values}",
                    "label": "${nodes.save_input.outputs.label}"
                }),
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
                id: "save_result".to_string(),
                tool: "file_writer".to_string(),
                depends_on: vec!["compute_stats".to_string()],
                input_bindings: serde_json::json!({
                    "mean": "${nodes.compute_stats.outputs.mean}",
                    "min": "${nodes.compute_stats.outputs.min}",
                    "max": "${nodes.compute_stats.outputs.max}"
                }),
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
        outputs: vec![],
        metadata: Default::default(),
    };

    let mut tool_registry = ToolRegistry::new();
    tool_registry.register(Arc::new(FileWriterTool::new("file_writer")));
    tool_registry.register(Arc::new(StatsTool::new("compute_stats")));

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new(tmp.path()));

    let engine = GraphEngine::new(
        RuntimeConfig {
            artifact_root: tmp.path().to_str().unwrap().to_string(),
            ..RuntimeConfig::default()
        },
        tool_registry,
        state_store.clone(),
        artifact_store,
    );

    let inputs = serde_json::json!({
        "values": [7.0, 14.0, 21.0],
        "label": "artifact_test"
    });

    let mut run = engine.instantiate_graph(&template, inputs).unwrap();
    let run_id = run.id.clone();
    engine.run_graph(&mut run, &template).await.unwrap();
    assert_eq!(run.status, GraphRunStatus::Succeeded);

    // Reload state from store
    let loaded = engine.get_graph_status(&run_id).unwrap();
    assert_eq!(loaded.status, GraphRunStatus::Succeeded);
    assert_eq!(loaded.node_runs.len(), run.node_runs.len());

    // Verify artifact refs on reloaded nodes match the original run
    for node_id in &["save_input", "compute_stats", "save_result"] {
        let original_nr = run.node_run(node_id).unwrap();
        let loaded_nr = loaded.node_run(node_id).unwrap();

        assert_eq!(
            original_nr.artifacts.len(),
            loaded_nr.artifacts.len(),
            "Node '{}': artifact count mismatch (original={}, reloaded={})",
            node_id,
            original_nr.artifacts.len(),
            loaded_nr.artifacts.len()
        );

        // Verify each artifact's file still exists on disk
        for artifact in &loaded_nr.artifacts {
            if let Some(path) = &artifact.path {
                assert!(
                    std::path::Path::new(path).exists(),
                    "Reloaded artifact file should still exist on disk: {} (node '{}')",
                    path,
                    node_id
                );
            }
        }

        // Verify artifact kinds match
        for (orig, reloaded) in original_nr.artifacts.iter().zip(loaded_nr.artifacts.iter()) {
            assert_eq!(
                orig.kind, reloaded.kind,
                "Node '{}': artifact kind mismatch",
                node_id
            );
        }
    }

    // Also verify via list_graph_artifacts API
    let all_artifacts = engine.list_graph_artifacts(&run_id).unwrap();
    assert_eq!(
        all_artifacts.len(),
        3,
        "Should have artifacts for 3 nodes, got {}",
        all_artifacts.len()
    );
    for (node_id, artifacts) in &all_artifacts {
        assert!(
            !artifacts.is_empty(),
            "Node '{}' should have at least 1 artifact via list_graph_artifacts",
            node_id
        );
    }
}

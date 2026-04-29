//! Regression tests for kernel stabilization fixes.
//!
//! Covers:
//! - SQLite transaction safety (atomic save/delete)
//! - Resume: Ready nodes properly reset to Pending
//! - Executor lifecycle: Failed → Repairing sets finished_at correctly
//! - Repair loop bound (max_repair_attempts enforcement)

mod helpers;

use std::sync::Arc;
use catgo_graph::*;
use catgo_graph::tools::mock::EchoTool;
use catgo_graph::storage::SqliteStateStore;
use catgo_graph::storage::FileArtifactStore;

// ---------------------------------------------------------------------------
// 1. Resume: Ready nodes are properly reset to Pending
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_resume_resets_ready_nodes_to_pending() {
    let engine = helpers::echo_engine();
    let template = helpers::template("resume_ready", vec![
        helpers::node("a", vec![]),
        helpers::node("b", vec!["a"]),
    ]);

    // Start a run, let it complete
    let mut run = engine.instantiate_graph(&template, serde_json::json!({})).unwrap();
    engine.run_graph(&mut run, &template).await.unwrap();
    assert_eq!(run.status, GraphRunStatus::Succeeded);

    // Manually set node "b" to Ready (simulating a crash during scheduling)
    if let Some(nr) = run.node_run_mut("b") {
        nr.status = NodeStatus::Ready;
        nr.finished_at = None;
    }
    run.status = GraphRunStatus::Running;

    // Save the corrupted state
    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-stabilization-1"));
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(EchoTool::new("echo")));
    let engine2 = GraphEngine::new(
        RuntimeConfig::default(),
        registry,
        state_store.clone(),
        artifact_store,
    );

    // Save the run with Ready node
    state_store.save_graph_run(&run).unwrap();

    // Resume should reset Ready → Pending, then re-execute
    let resumed = engine2.resume_graph(&run.id, &template).await.unwrap();
    assert_eq!(resumed.status, GraphRunStatus::Succeeded);
    for nr in &resumed.node_runs {
        assert!(
            nr.status == NodeStatus::Succeeded,
            "Node '{}' should be Succeeded after resume, got {:?}",
            nr.node_id, nr.status,
        );
    }
}

// ---------------------------------------------------------------------------
// 2. State machine: Failed → Repairing is valid
// ---------------------------------------------------------------------------

#[test]
fn test_failed_to_repairing_transition_valid() {
    assert!(NodeStatus::Failed.can_transition_to(NodeStatus::Repairing));
}

#[test]
fn test_failed_to_repairing_via_lifecycle() {
    use catgo_graph::graph::run::NodeRun;

    let mut nr = NodeRun::new("test_node".to_string());
    // Simulate: Pending → Ready → Running → Failed
    nr.status = NodeStatus::Ready;
    nr.status = NodeStatus::Running;
    nr.started_at = Some(chrono::Utc::now());
    nr.status = NodeStatus::Failed;
    nr.finished_at = Some(chrono::Utc::now());

    // Now transition Failed → Repairing via lifecycle
    catgo_graph::runtime::lifecycle::transition_node(&mut nr, NodeStatus::Repairing).unwrap();
    assert_eq!(nr.status, NodeStatus::Repairing);
    // finished_at should be cleared since node is being worked on again
    assert!(nr.finished_at.is_none(), "finished_at should be None after entering Repairing");
}

#[test]
fn test_repairing_to_failed_sets_finished_at() {
    use catgo_graph::graph::run::NodeRun;

    let mut nr = NodeRun::new("test_node".to_string());
    nr.status = NodeStatus::Repairing;
    nr.finished_at = None;

    catgo_graph::runtime::lifecycle::transition_node(&mut nr, NodeStatus::Failed).unwrap();
    assert_eq!(nr.status, NodeStatus::Failed);
    assert!(nr.finished_at.is_some(), "finished_at should be set when transitioning to Failed");
}

// ---------------------------------------------------------------------------
// 3. NodeRun has repair_count field
// ---------------------------------------------------------------------------

#[test]
fn test_node_run_repair_count_defaults_to_zero() {
    use catgo_graph::graph::run::NodeRun;
    let nr = NodeRun::new("test".to_string());
    assert_eq!(nr.repair_count, 0);
}

#[test]
fn test_node_run_repair_count_serde_default() {
    // Old serialized data without repair_count should deserialize with default 0
    let json = serde_json::json!({
        "node_id": "test",
        "status": "pending",
        "resolved_inputs": null,
        "outputs": null,
        "artifacts": [],
        "attempts": [],
        "current_attempt": 0,
        "started_at": null,
        "finished_at": null,
        "last_error": null
    });
    let nr: catgo_graph::graph::run::NodeRun = serde_json::from_value(json).unwrap();
    assert_eq!(nr.repair_count, 0);
}

// ---------------------------------------------------------------------------
// 4. RepairPolicyRef has max_repair_attempts with default
// ---------------------------------------------------------------------------

#[test]
fn test_repair_policy_ref_max_attempts_default() {
    let json = serde_json::json!({
        "handler": "test_handler",
        "config": {}
    });
    let rpr: catgo_graph::graph::template::RepairPolicyRef = serde_json::from_value(json).unwrap();
    assert_eq!(rpr.max_repair_attempts, 3, "default max_repair_attempts should be 3");
}

#[test]
fn test_repair_policy_ref_max_attempts_custom() {
    let json = serde_json::json!({
        "handler": "test_handler",
        "config": {},
        "max_repair_attempts": 5
    });
    let rpr: catgo_graph::graph::template::RepairPolicyRef = serde_json::from_value(json).unwrap();
    assert_eq!(rpr.max_repair_attempts, 5);
}

// ---------------------------------------------------------------------------
// 5. DTO alignment: new fields present and serde-compatible
// ---------------------------------------------------------------------------

#[test]
fn test_node_run_summary_new_fields() {
    use catgo_graph::api::dto::NodeRunSummary;

    let summary = NodeRunSummary {
        node_id: "test".to_string(),
        status: NodeStatus::Failed,
        attempts: 2,
        has_error: true,
        artifact_count: 0,
        tool_name: Some("vasp_relax".to_string()),
        last_error_message: Some("convergence failed".to_string()),
        repair_count: 1,
    };

    let json = serde_json::to_value(&summary).unwrap();
    assert_eq!(json["tool_name"], "vasp_relax");
    assert_eq!(json["last_error_message"], "convergence failed");
    assert_eq!(json["repair_count"], 1);
}

#[test]
fn test_node_run_summary_backward_compat() {
    use catgo_graph::api::dto::NodeRunSummary;

    // Old JSON without new fields should deserialize
    let json = serde_json::json!({
        "node_id": "test",
        "status": "failed",
        "attempts": 1,
        "has_error": true,
        "artifact_count": 0
    });
    let summary: NodeRunSummary = serde_json::from_value(json).unwrap();
    assert!(summary.tool_name.is_none());
    assert!(summary.last_error_message.is_none());
    assert_eq!(summary.repair_count, 0);
}

#[test]
fn test_graph_template_info_rewrite_fields() {
    use catgo_graph::api::dto::GraphTemplateInfo;

    let info = GraphTemplateInfo {
        id: "test".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: serde_json::json!({}),
        node_count: 2,
        node_ids: vec!["a".to_string(), "b".to_string()],
        output_names: vec![],
        has_rewrite_rules: true,
        rewrite_rule_count: 3,
    };

    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["has_rewrite_rules"], true);
    assert_eq!(json["rewrite_rule_count"], 3);
}

// ---------------------------------------------------------------------------
// 6. SQLite transaction: save and load roundtrip
// ---------------------------------------------------------------------------

#[test]
fn test_sqlite_transaction_save_load_roundtrip() {
    let store = SqliteStateStore::new(":memory:").unwrap();
    let template = helpers::template("tx_test", vec![
        helpers::node("a", vec![]),
        helpers::node("b", vec!["a"]),
    ]);

    let run = catgo_graph::graph::run::GraphRun {
        id: "run-tx-test".to_string(),
        template_id: template.id.clone(),
        template_version: template.version.clone(),
        status: GraphRunStatus::Running,
        inputs: serde_json::json!({}),
        node_runs: vec![
            catgo_graph::graph::run::NodeRun::new("a".to_string()),
            catgo_graph::graph::run::NodeRun::new("b".to_string()),
        ],
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        run_dir: "/tmp/tx-test".to_string(),
        metadata: Default::default(),
        rewrite_events: vec![],
    };

    // Save and load back
    store.save_graph_run(&run).unwrap();
    let loaded = store.load_graph_run("run-tx-test").unwrap();
    assert_eq!(loaded.id, "run-tx-test");
    assert_eq!(loaded.node_runs.len(), 2);
    assert_eq!(loaded.status, GraphRunStatus::Running);
}

#[test]
fn test_sqlite_delete_then_load_fails() {
    let store = SqliteStateStore::new(":memory:").unwrap();
    let run = catgo_graph::graph::run::GraphRun {
        id: "run-del-test".to_string(),
        template_id: "test".to_string(),
        template_version: "1.0".to_string(),
        status: GraphRunStatus::Succeeded,
        inputs: serde_json::json!({}),
        node_runs: vec![catgo_graph::graph::run::NodeRun::new("a".to_string())],
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        run_dir: "/tmp/del-test".to_string(),
        metadata: Default::default(),
        rewrite_events: vec![],
    };

    store.save_graph_run(&run).unwrap();
    store.delete_graph_run("run-del-test").unwrap();
    let result = store.load_graph_run("run-del-test");
    assert!(result.is_err(), "Loading a deleted run should fail");
}

// ---------------------------------------------------------------------------
// 7. ExecutionEvent new variants compile and serialize
// ---------------------------------------------------------------------------

#[test]
fn test_execution_event_new_variants_serialize() {
    use catgo_graph::runtime::executor::ExecutionEvent;

    let retry_event = ExecutionEvent::NodeRetryScheduled {
        node_id: "test".to_string(),
        attempt: 2,
        backoff_seconds: 5,
    };
    let json = serde_json::to_value(&retry_event).unwrap();
    assert_eq!(json["event_type"], "node_retry_scheduled");
    assert_eq!(json["attempt"], 2);
    assert_eq!(json["backoff_seconds"], 5);

    let repair_start = ExecutionEvent::NodeRepairStarted {
        node_id: "test".to_string(),
        repair_attempt: 1,
        handler: "scf_fixer".to_string(),
    };
    let json = serde_json::to_value(&repair_start).unwrap();
    assert_eq!(json["event_type"], "node_repair_started");
    assert_eq!(json["handler"], "scf_fixer");

    let repair_done = ExecutionEvent::NodeRepairCompleted {
        node_id: "test".to_string(),
        success: true,
    };
    let json = serde_json::to_value(&repair_done).unwrap();
    assert_eq!(json["event_type"], "node_repair_completed");
    assert_eq!(json["success"], true);
}

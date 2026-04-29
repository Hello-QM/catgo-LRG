//! Tauri-side workflow engine: run GraphEngine in-process.
//!
//! Provides `db_run_workflow`, `db_pause_workflow`, `db_resume_workflow`
//! commands that execute workflows directly via catgo-graph without
//! the subprocess + DB-polling bridge.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use catgo_graph::api::svelteflow::svelteflow_to_template;
use catgo_graph::runtime::executor::ExecutionEvent;
use catgo_graph::storage::catgo_store::CatgoStateStore;
use catgo_graph::storage::FileArtifactStore;
use catgo_graph::tools::http_bridge::HttpBridgeTool;
use catgo_graph::{GraphEngine, GraphRunStatus, RuntimeConfig, ToolRegistry};

use crate::db::DbState;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct WorkflowEngineState {
    /// Active cancel tokens for running workflows (workflow_id → token).
    active_runs: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl Default for WorkflowEngineState {
    fn default() -> Self {
        Self {
            active_runs: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl WorkflowEngineState {
    /// Cancel all active workflow runs (called on app shutdown).
    pub fn cancel_all(&self) {
        if let Ok(runs) = self.active_runs.lock() {
            for (wf_id, token) in runs.iter() {
                log::info!("[WorkflowEngine] Cancelling workflow {} on shutdown", wf_id);
                token.cancel();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn get_db_path(db_state: &DbState) -> Result<String, String> {
    db_state.resolve_path()
}

fn load_graph_json(db_path: &str, workflow_id: &str) -> Result<String, String> {
    let conn =
        rusqlite::Connection::open(db_path).map_err(|e| format!("sqlite open: {e}"))?;
    conn.execute_batch("PRAGMA busy_timeout=5000;")
        .map_err(|e| format!("pragma: {e}"))?;
    conn.query_row(
        "SELECT graph_json FROM workflows WHERE id = ?1",
        [workflow_id],
        |row| row.get(0),
    )
    .map_err(|e| format!("load graph_json: {e}"))
}

fn mark_workflow_running(db_path: &str, workflow_id: &str, run_id: &str) -> Result<(), String> {
    let conn =
        rusqlite::Connection::open(db_path).map_err(|e| format!("sqlite open: {e}"))?;
    conn.execute_batch("PRAGMA busy_timeout=5000;")
        .map_err(|e| format!("pragma: {e}"))?;
    conn.execute(
        "UPDATE workflows SET status = 'running', engine_type = 'rust', rust_run_id = ?1 WHERE id = ?2",
        rusqlite::params![run_id, workflow_id],
    )
    .map_err(|e| format!("update workflow: {e}"))?;
    Ok(())
}

fn mark_workflow_finished(db_path: &str, workflow_id: &str, status: GraphRunStatus) {
    let status_str = match status {
        GraphRunStatus::Succeeded | GraphRunStatus::PartiallySucceeded => "completed",
        GraphRunStatus::Failed | GraphRunStatus::Cancelled => "failed",
        GraphRunStatus::Paused => "paused",
        _ => "failed",
    };
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = conn.execute_batch("PRAGMA busy_timeout=5000;");
        let _ = conn.execute(
            "UPDATE workflows SET status = ?1 WHERE id = ?2",
            rusqlite::params![status_str, workflow_id],
        );
    }
}

fn extract_python_url(config_json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(config_json)
        .ok()
        .and_then(|v| v.get("python_url").and_then(|u| u.as_str()).map(String::from))
        .unwrap_or_else(|| "http://localhost:8000".to_string())
}

fn build_registry(template: &catgo_graph::GraphTemplate, python_url: &str) -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    catgo_graph::register_native_tools(&mut registry);

    let tool_names: std::collections::HashSet<String> =
        template.nodes.iter().map(|n| n.tool.clone()).collect();

    for tool_name in tool_names {
        if tool_name.is_empty() || registry.get(&tool_name).is_some() {
            continue;
        }
        let tool = HttpBridgeTool::with_defaults(python_url, tool_name);
        registry.register(Arc::new(tool));
    }
    registry
}

/// Status event payload sent to the frontend via Tauri events.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WorkflowEvent {
    StepStatus { step_id: String, status: String },
    WorkflowStatus { status: String },
    StepLog { step_id: String, message: String },
}

fn node_status_to_str(status: catgo_graph::NodeStatus) -> &'static str {
    match status {
        catgo_graph::NodeStatus::Pending | catgo_graph::NodeStatus::Ready => "pending",
        catgo_graph::NodeStatus::Running | catgo_graph::NodeStatus::Repairing => "running",
        catgo_graph::NodeStatus::Succeeded => "completed",
        catgo_graph::NodeStatus::Failed
        | catgo_graph::NodeStatus::Blocked
        | catgo_graph::NodeStatus::Cancelled => "failed",
        catgo_graph::NodeStatus::Skipped => "skipped",
    }
}

fn run_status_to_str(status: GraphRunStatus) -> &'static str {
    match status {
        GraphRunStatus::Created | GraphRunStatus::Validated => "draft",
        GraphRunStatus::Running => "running",
        GraphRunStatus::Paused => "paused",
        GraphRunStatus::Succeeded | GraphRunStatus::PartiallySucceeded => "completed",
        GraphRunStatus::Failed | GraphRunStatus::Cancelled => "failed",
    }
}

/// Spawn event relay: read ExecutionEvents from channel, emit as Tauri events.
fn spawn_event_relay(
    app: tauri::AppHandle,
    workflow_id: String,
    mut event_rx: tokio::sync::mpsc::UnboundedReceiver<ExecutionEvent>,
) {
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let event_name = format!("workflow-event-{}", workflow_id);
        while let Some(event) = event_rx.recv().await {
            let wf_event = match &event {
                ExecutionEvent::NodeStateChanged {
                    node_id,
                    new_status,
                    ..
                } => Some(WorkflowEvent::StepStatus {
                    step_id: node_id.clone(),
                    status: node_status_to_str(*new_status).to_string(),
                }),
                ExecutionEvent::GraphStateChanged { status, .. } => {
                    Some(WorkflowEvent::WorkflowStatus {
                        status: run_status_to_str(*status).to_string(),
                    })
                }
                ExecutionEvent::NodeLog { node_id, message } => Some(WorkflowEvent::StepLog {
                    step_id: node_id.clone(),
                    message: message.clone(),
                }),
                _ => None,
            };
            if let Some(wf_event) = wf_event {
                let _ = app.emit(&event_name, &wf_event);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_run_workflow(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    engine_state: tauri::State<'_, WorkflowEngineState>,
    workflow_id: String,
    config_json: String,
) -> Result<String, String> {
    // Check if workflow is already running
    {
        let runs = engine_state.active_runs.lock().map_err(|e| e.to_string())?;
        if runs.contains_key(&workflow_id) {
            return Err(format!("Workflow {} is already running", workflow_id));
        }
    }

    let db_path = get_db_path(&db_state)?;
    let graph_json = load_graph_json(&db_path, &workflow_id)?;
    let template = svelteflow_to_template(&graph_json, &workflow_id)
        .map_err(|e| format!("template conversion: {e}"))?;

    let python_url = extract_python_url(&config_json);
    let registry = build_registry(&template, &python_url);

    let store =
        CatgoStateStore::open(&db_path).map_err(|e| format!("state store: {e}"))?;

    let run_dir = format!("/tmp/catgo_runs/{}", workflow_id);
    let config = RuntimeConfig {
        max_concurrent_nodes: 4,
        artifact_root: run_dir.clone(),
        state_db_path: db_path.clone(),
    };
    let artifact_store = Arc::new(FileArtifactStore::new(&run_dir));
    let engine = GraphEngine::new(config, registry, Arc::new(store), artifact_store);

    let mut graph_run = engine
        .instantiate_graph(&template, serde_json::json!({}))
        .map_err(|e| format!("instantiate: {e}"))?;
    let run_id = graph_run.id.clone();

    mark_workflow_running(&db_path, &workflow_id, &run_id)?;

    // Create cancellation token + register
    let cancel_token = CancellationToken::new();
    {
        let mut runs = engine_state.active_runs.lock().map_err(|e| e.to_string())?;
        runs.insert(workflow_id.clone(), cancel_token.clone());
    }

    // Event channel
    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel::<ExecutionEvent>();
    spawn_event_relay(app, workflow_id.clone(), event_rx);

    // Spawn execution task
    let wf_id = workflow_id.clone();
    let db_path_run = db_path.clone();
    let active_runs = Arc::clone(&engine_state.active_runs);
    tauri::async_runtime::spawn(async move {
        let result = engine
            .run_graph_with_events(&mut graph_run, &template, event_tx, cancel_token)
            .await;

        // Remove from active runs
        if let Ok(mut runs) = active_runs.lock() {
            runs.remove(&wf_id);
        }

        let final_status = match result {
            Ok(()) => graph_run.status,
            Err(e) => {
                log::error!("[WorkflowEngine] Workflow {} error: {}", wf_id, e);
                GraphRunStatus::Failed
            }
        };

        mark_workflow_finished(&db_path_run, &wf_id, final_status);
        log::info!("[WorkflowEngine] Workflow {} finished: {:?}", wf_id, final_status);
    });

    log::info!("[WorkflowEngine] Started workflow {} (run_id: {})", workflow_id, run_id);
    Ok(run_id)
}

#[tauri::command]
pub async fn db_pause_workflow(
    engine_state: tauri::State<'_, WorkflowEngineState>,
    workflow_id: String,
) -> Result<(), String> {
    let runs = engine_state.active_runs.lock().map_err(|e| e.to_string())?;
    if let Some(token) = runs.get(&workflow_id) {
        log::info!("[WorkflowEngine] Pausing workflow {}", workflow_id);
        token.cancel();
        Ok(())
    } else {
        Err(format!("Workflow {} is not running", workflow_id))
    }
}

#[tauri::command]
pub async fn db_resume_workflow(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    engine_state: tauri::State<'_, WorkflowEngineState>,
    workflow_id: String,
    config_json: String,
) -> Result<String, String> {
    // Check not already running
    {
        let runs = engine_state.active_runs.lock().map_err(|e| e.to_string())?;
        if runs.contains_key(&workflow_id) {
            return Err(format!("Workflow {} is already running", workflow_id));
        }
    }

    let db_path = get_db_path(&db_state)?;

    // Load the existing run_id from DB
    let run_id: String = {
        let conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| format!("sqlite: {e}"))?;
        conn.execute_batch("PRAGMA busy_timeout=5000;")
            .map_err(|e| format!("pragma: {e}"))?;
        conn.query_row(
            "SELECT rust_run_id FROM workflows WHERE id = ?1",
            [&workflow_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("load run_id: {e}"))?
    };

    let graph_json = load_graph_json(&db_path, &workflow_id)?;
    let template = svelteflow_to_template(&graph_json, &workflow_id)
        .map_err(|e| format!("template: {e}"))?;

    let python_url = extract_python_url(&config_json);
    let registry = build_registry(&template, &python_url);

    let store =
        CatgoStateStore::open(&db_path).map_err(|e| format!("state store: {e}"))?;

    let run_dir = format!("/tmp/catgo_runs/{}", workflow_id);
    let config = RuntimeConfig {
        max_concurrent_nodes: 4,
        artifact_root: run_dir.clone(),
        state_db_path: db_path.clone(),
    };
    let artifact_store = Arc::new(FileArtifactStore::new(&run_dir));
    let engine = GraphEngine::new(config, registry, Arc::new(store), artifact_store);

    mark_workflow_running(&db_path, &workflow_id, &run_id)?;

    let cancel_token = CancellationToken::new();
    {
        let mut runs = engine_state.active_runs.lock().map_err(|e| e.to_string())?;
        runs.insert(workflow_id.clone(), cancel_token.clone());
    }

    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel::<ExecutionEvent>();
    spawn_event_relay(app, workflow_id.clone(), event_rx);

    // Spawn resume execution
    let wf_id = workflow_id.clone();
    let db_path_run = db_path.clone();
    let run_id_clone = run_id.clone();
    let active_runs = Arc::clone(&engine_state.active_runs);
    tauri::async_runtime::spawn(async move {
        let result = engine
            .resume_graph_with_events(&run_id_clone, &template, event_tx, cancel_token)
            .await;

        if let Ok(mut runs) = active_runs.lock() {
            runs.remove(&wf_id);
        }

        let final_status = match result {
            Ok(run) => run.status,
            Err(e) => {
                log::error!("[WorkflowEngine] Resume {} error: {}", wf_id, e);
                GraphRunStatus::Failed
            }
        };

        mark_workflow_finished(&db_path_run, &wf_id, final_status);
        log::info!("[WorkflowEngine] Resumed workflow {} finished: {:?}", wf_id, final_status);
    });

    log::info!("[WorkflowEngine] Resumed workflow {} (run_id: {})", workflow_id, run_id);
    Ok(run_id)
}

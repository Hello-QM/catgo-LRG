//! CLI binary for running a CatGO workflow via the Rust catgo-graph engine.
//!
//! Usage:
//!   catgo_run --workflow <id> --db <path> --python-url <url>
//!   catgo_run --workflow <id> --db <path> --resume <run_id>
//!
//! This loads a workflow's graph_json from the CatGO SQLite database,
//! converts it to a GraphTemplate, and runs it using the Rust graph engine
//! with HttpBridgeTool for tool execution.
//!
//! Exit codes:
//!   0 = success (workflow completed)
//!   1 = error (workflow failed or infrastructure error)
//!   2 = paused (received SIGTERM/SIGINT, state saved)

use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;

use catgo_graph::api::svelteflow::svelteflow_to_template;
use catgo_graph::storage::catgo_store::CatgoStateStore;
use catgo_graph::storage::FileArtifactStore;
use catgo_graph::tools::http_bridge::HttpBridgeTool;
use catgo_graph::{CancellationToken, GraphEngine, GraphRunStatus, RuntimeConfig, ToolRegistry};

#[derive(Parser, Debug)]
#[command(name = "catgo_run", about = "Run a CatGO workflow via Rust DAG engine")]
struct Args {
    /// Workflow ID to run
    #[arg(short, long)]
    workflow: String,

    /// Path to CatGO SQLite database
    #[arg(short, long)]
    db: String,

    /// Python backend URL (e.g., http://localhost:8000)
    #[arg(short, long, default_value = "http://localhost:8000")]
    python_url: String,

    /// Maximum concurrent nodes
    #[arg(long, default_value = "4")]
    max_concurrency: usize,

    /// Run directory for artifacts
    #[arg(long, default_value = "/tmp/catgo_runs")]
    run_dir: String,

    /// Resume a previously paused/interrupted run by its rust_run_id
    #[arg(long)]
    resume: Option<String>,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(status) => match status {
            GraphRunStatus::Succeeded | GraphRunStatus::PartiallySucceeded => ExitCode::from(0),
            GraphRunStatus::Paused => ExitCode::from(2),
            _ => ExitCode::from(1),
        },
        Err(e) => {
            eprintln!("catgo_run: Fatal error: {e}");
            ExitCode::from(1)
        }
    }
}

async fn run() -> Result<GraphRunStatus, Box<dyn std::error::Error>> {
    let args = Args::parse();

    eprintln!(
        "catgo_run: Loading workflow {} from {}",
        args.workflow, args.db
    );

    // Open the database
    let store = CatgoStateStore::open(&args.db)?;

    // Load graph_json from the database
    let graph_json = load_graph_json(&args.db, &args.workflow)?;
    eprintln!("catgo_run: Loaded graph_json ({} bytes)", graph_json.len());

    // Convert SvelteFlow → GraphTemplate
    let template = svelteflow_to_template(&graph_json, &args.workflow)?;
    eprintln!(
        "catgo_run: Converted to template with {} nodes",
        template.nodes.len()
    );

    // Collect all unique tool names from the template
    let tool_names: Vec<String> = template
        .nodes
        .iter()
        .map(|n| n.tool.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    // Register native Rust tools first (take priority over HTTP bridge)
    let mut registry = ToolRegistry::new();
    catgo_graph::register_native_tools(&mut registry);
    let native_tools: Vec<String> = registry.list();
    for name in &native_tools {
        eprintln!("catgo_run: Registered native tool '{}'", name);
    }

    // Register HttpBridgeTool for remaining node types (not already native)
    for tool_name in &tool_names {
        if registry.get(tool_name).is_some() {
            continue; // Already registered as native tool
        }
        let tool = HttpBridgeTool::with_defaults(&args.python_url, tool_name.clone());
        registry.register(Arc::new(tool));
        eprintln!("catgo_run: Registered HTTP bridge for '{}'", tool_name);
    }

    // Build engine config
    let config = RuntimeConfig {
        max_concurrent_nodes: args.max_concurrency,
        artifact_root: args.run_dir.clone(),
        state_db_path: args.db.clone(),
    };

    // Create artifact store
    let artifact_store = Arc::new(FileArtifactStore::new(&args.run_dir));

    // Create engine
    let engine = GraphEngine::new(config, registry, Arc::new(store), artifact_store);

    // Set up cancellation token for SIGTERM/SIGINT handling
    let cancel_token = CancellationToken::new();
    let token_clone = cancel_token.clone();
    tokio::spawn(async move {
        // Wait for Ctrl+C (SIGINT) or SIGTERM
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        {
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("failed to register SIGTERM handler");
            tokio::select! {
                _ = ctrl_c => {},
                _ = sigterm.recv() => {},
            }
        }
        #[cfg(not(unix))]
        {
            ctrl_c.await.ok();
        }
        eprintln!("catgo_run: Received shutdown signal, pausing...");
        token_clone.cancel();
    });

    // Execute: fresh start or resume
    let final_status = if let Some(run_id) = &args.resume {
        eprintln!("catgo_run: Resuming run {}", run_id);
        let mut resumed_run = engine.state_store.load_graph_run(run_id)?;

        // Validate template compatibility
        for nr in &resumed_run.node_runs {
            if !template.nodes.iter().any(|n| n.id == nr.node_id) {
                return Err(format!(
                    "Graph was edited since pause: node '{}' no longer exists in template",
                    nr.node_id
                )
                .into());
            }
        }

        // Reset interrupted nodes
        for nr in &mut resumed_run.node_runs {
            if matches!(
                nr.status,
                catgo_graph::NodeStatus::Running
                    | catgo_graph::NodeStatus::Ready
                    | catgo_graph::NodeStatus::Repairing
            ) {
                eprintln!(
                    "catgo_run: Resetting interrupted node '{}' from {:?} to Pending",
                    nr.node_id, nr.status
                );
                nr.status = catgo_graph::NodeStatus::Pending;
                nr.started_at = None;
            }
        }

        engine
            .run_graph_with_cancel(&mut resumed_run, &template, cancel_token)
            .await?;
        let status = resumed_run.status;

        // Print summary
        for nr in &resumed_run.node_runs {
            eprintln!(
                "  Node '{}': {:?} (attempts: {}, repairs: {})",
                nr.node_id, nr.status, nr.current_attempt, nr.repair_count
            );
        }
        status
    } else {
        // Fresh start
        let mut new_run = engine.instantiate_graph(&template, serde_json::json!({}))?;
        eprintln!("catgo_run: Instantiated run {}", new_run.id);

        eprintln!("catgo_run: Starting execution...");
        engine
            .run_graph_with_cancel(&mut new_run, &template, cancel_token)
            .await?;
        let status = new_run.status;

        eprintln!(
            "catgo_run: Execution finished. Status: {:?}, Run ID: {}",
            status, new_run.id
        );

        // Print summary
        for nr in &new_run.node_runs {
            eprintln!(
                "  Node '{}': {:?} (attempts: {}, repairs: {})",
                nr.node_id, nr.status, nr.current_attempt, nr.repair_count
            );
        }
        status
    };

    Ok(final_status)
}

/// Load graph_json from the CatGO SQLite database.
fn load_graph_json(db_path: &str, workflow_id: &str) -> Result<String, Box<dyn std::error::Error>> {
    let conn = rusqlite::Connection::open(db_path)?;
    let json: String = conn.query_row(
        "SELECT graph_json FROM workflows WHERE id = ?1",
        [workflow_id],
        |row| row.get(0),
    )?;
    Ok(json)
}

// Common test helper functions used across integration tests.
// Provides factory functions for mock templates, runs, tools, and engine setup.

use std::sync::Arc;

use catgo_graph::*;
use catgo_graph::tools::mock::EchoTool;
use catgo_graph::storage::SqliteStateStore;
use catgo_graph::storage::FileArtifactStore;

/// Create a minimal `NodeTemplate` with the given id and dependency list.
/// Uses "echo" as the default tool name.
pub fn node(id: &str, deps: Vec<&str>) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: "echo".to_string(),
        depends_on: deps.into_iter().map(|d| d.to_string()).collect(),
        input_bindings: serde_json::json!({}),
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

/// Create a minimal `GraphTemplate` with the given id and nodes.
pub fn template(id: &str, nodes: Vec<NodeTemplate>) -> GraphTemplate {
    GraphTemplate {
        id: id.to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: serde_json::json!({}),
        nodes,
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    }
}

/// Create a linear chain of `n` nodes: node_0 -> node_1 -> ... -> node_{n-1}.
/// Each node depends on the previous one (except the first).
pub fn linear_template(n: usize) -> GraphTemplate {
    let mut nodes = Vec::with_capacity(n);
    for i in 0..n {
        let id = format!("node_{}", i);
        let deps = if i == 0 {
            vec![]
        } else {
            vec![format!("node_{}", i - 1)]
        };
        nodes.push(NodeTemplate {
            id,
            tool: "echo".to_string(),
            depends_on: deps,
            input_bindings: serde_json::json!({}),
            output_spec: None,
            retry_policy: None,
            timeout_seconds: None,
            repair_policy: None,
            execution_mode: Default::default(),
            skip_condition: None,
            subgraph: None,
            metadata: Default::default(),
        });
    }
    template("linear", nodes)
}

/// Create a standard diamond DAG:
///
/// ```text
///     a
///    / \
///   b   c
///    \ /
///     d
/// ```
///
/// Node `a` has no dependencies, `b` and `c` depend on `a`, `d` depends on both `b` and `c`.
pub fn diamond_template() -> GraphTemplate {
    let nodes = vec![
        node("a", vec![]),
        node("b", vec!["a"]),
        node("c", vec!["a"]),
        node("d", vec!["b", "c"]),
    ];
    template("diamond", nodes)
}

/// Create a `GraphEngine` with the given tools, using an in-memory SQLite state store.
pub fn make_engine(tools: Vec<Arc<dyn Tool>>) -> GraphEngine {
    let mut registry = ToolRegistry::new();
    for t in tools {
        registry.register(t);
    }

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-helpers-artifacts"));

    GraphEngine::new(
        RuntimeConfig::default(),
        registry,
        state_store,
        artifact_store,
    )
}

/// Create a `GraphEngine` with the given tools and a custom `RepairRegistry`,
/// using an in-memory SQLite state store.
#[allow(dead_code)]
pub fn make_engine_with_repair(
    tools: Vec<Arc<dyn Tool>>,
    repair_registry: RepairRegistry,
) -> GraphEngine {
    let mut registry = ToolRegistry::new();
    for t in tools {
        registry.register(t);
    }

    let state_store = Arc::new(SqliteStateStore::new(":memory:").unwrap());
    let artifact_store = Arc::new(FileArtifactStore::new("/tmp/catgo-test-helpers-artifacts"));

    GraphEngine::with_repair_registry(
        RuntimeConfig::default(),
        registry,
        state_store,
        artifact_store,
        repair_registry,
    )
}

/// Convenience: create a default echo engine (registers a single EchoTool named "echo").
#[allow(dead_code)]
pub fn echo_engine() -> GraphEngine {
    make_engine(vec![Arc::new(EchoTool::new("echo"))])
}

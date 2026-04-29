use std::sync::Arc;
use uuid::Uuid;
use tokio_util::sync::CancellationToken;

use crate::api::graph_api::TemplateRegistry;
use crate::core::errors::EngineError;
use crate::core::state::{GraphRunStatus, NodeStatus};
use crate::graph::composer::{self, TemplateProvider};
use crate::graph::run::{ArtifactRef, GraphRun, NodeRun};
use crate::graph::template::GraphTemplate;
use crate::graph::validate;
use crate::repair::RepairRegistry;
use crate::runtime::executor;
use crate::storage::traits::{ArtifactStore, StateStore};
use crate::tools::registry::ToolRegistry;

/// Implement TemplateProvider for TemplateRegistry so it can be used
/// for subgraph expansion in the engine.
impl TemplateProvider for TemplateRegistry {
    fn get_template(&self, id: &str) -> Option<GraphTemplate> {
        self.get(id)
    }

    fn get_template_versioned(&self, id: &str, version: &str) -> Option<GraphTemplate> {
        self.get_versioned(id, version)
    }
}

/// Configuration for the graph engine runtime.
pub struct RuntimeConfig {
    /// Maximum number of nodes to execute in parallel.
    pub max_concurrent_nodes: usize,
    /// Root directory for artifacts storage.
    pub artifact_root: String,
    /// Path for the state database. Use `":memory:"` for in-memory.
    pub state_db_path: String,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            max_concurrent_nodes: 4,
            artifact_root: "./artifacts".into(),
            state_db_path: ":memory:".into(),
        }
    }
}

/// The top-level API for creating, running, and managing graph workflows.
pub struct GraphEngine {
    pub config: RuntimeConfig,
    pub tool_registry: Arc<ToolRegistry>,
    pub state_store: Arc<dyn StateStore>,
    pub artifact_store: Arc<dyn ArtifactStore>,
    pub repair_registry: Arc<RepairRegistry>,
}

impl GraphEngine {
    /// Create a new `GraphEngine` with the given configuration and dependencies.
    pub fn new(
        config: RuntimeConfig,
        tool_registry: ToolRegistry,
        state_store: Arc<dyn StateStore>,
        artifact_store: Arc<dyn ArtifactStore>,
    ) -> Self {
        Self {
            config,
            tool_registry: Arc::new(tool_registry),
            state_store,
            artifact_store,
            repair_registry: Arc::new(RepairRegistry::new()),
        }
    }

    /// Create a new `GraphEngine` with a custom repair registry.
    pub fn with_repair_registry(
        config: RuntimeConfig,
        tool_registry: ToolRegistry,
        state_store: Arc<dyn StateStore>,
        artifact_store: Arc<dyn ArtifactStore>,
        repair_registry: RepairRegistry,
    ) -> Self {
        Self {
            config,
            tool_registry: Arc::new(tool_registry),
            state_store,
            artifact_store,
            repair_registry: Arc::new(repair_registry),
        }
    }

    /// Instantiate a new `GraphRun` from a template and inputs.
    ///
    /// Validates the template, creates a `NodeRun` for each node in `Pending` state,
    /// and persists the run to the state store.
    pub fn instantiate_graph(
        &self,
        template: &GraphTemplate,
        inputs: serde_json::Value,
    ) -> Result<GraphRun, EngineError> {
        validate::validate_template(template)?;

        let run_id = Uuid::new_v4().to_string();
        let now = crate::core::time::now();

        let node_runs: Vec<NodeRun> =
            template.nodes.iter().map(|n| NodeRun::new(n.id.clone())).collect();

        let run = GraphRun {
            id: run_id,
            template_id: template.id.clone(),
            template_version: template.version.clone(),
            status: GraphRunStatus::Created,
            inputs,
            node_runs,
            created_at: now,
            updated_at: now,
            run_dir: format!("{}/{}", self.config.artifact_root, Uuid::new_v4()),
            metadata: Default::default(),
            rewrite_events: vec![],
        };

        self.state_store.save_graph_run(&run)?;
        Ok(run)
    }

    /// Run a graph to completion.
    ///
    /// Executes all nodes, handling dependencies, retries, repair, and failure propagation.
    pub async fn run_graph(
        &self,
        run: &mut GraphRun,
        template: &GraphTemplate,
    ) -> Result<(), EngineError> {
        executor::execute_run(
            run,
            template,
            &self.tool_registry,
            self.state_store.as_ref(),
            self.artifact_store.as_ref(),
            &self.repair_registry,
            self.config.max_concurrent_nodes,
            None,
            None,
            None,  // no cancel_token
        )
        .await
    }

    /// Run a graph with a cancellation token for pause support.
    ///
    /// When the token is cancelled, the executor drains in-flight tasks,
    /// sets the run status to Paused, and returns.
    pub async fn run_graph_with_cancel(
        &self,
        run: &mut GraphRun,
        template: &GraphTemplate,
        cancel_token: CancellationToken,
    ) -> Result<(), EngineError> {
        executor::execute_run(
            run,
            template,
            &self.tool_registry,
            self.state_store.as_ref(),
            self.artifact_store.as_ref(),
            &self.repair_registry,
            self.config.max_concurrent_nodes,
            None,
            None,
            Some(cancel_token),
        )
        .await
    }

    /// Run a graph with event streaming and cancellation support.
    ///
    /// Emits `ExecutionEvent`s on the provided channel for real-time monitoring.
    /// When the cancel token is triggered, drains in-flight tasks and pauses.
    pub async fn run_graph_with_events(
        &self,
        run: &mut GraphRun,
        template: &GraphTemplate,
        event_tx: tokio::sync::mpsc::UnboundedSender<executor::ExecutionEvent>,
        cancel_token: CancellationToken,
    ) -> Result<(), EngineError> {
        executor::execute_run(
            run,
            template,
            &self.tool_registry,
            self.state_store.as_ref(),
            self.artifact_store.as_ref(),
            &self.repair_registry,
            self.config.max_concurrent_nodes,
            Some(event_tx),
            None,
            Some(cancel_token),
        )
        .await
    }

    /// Resume a previously interrupted run.
    ///
    /// Resets any `Running`, `Ready`, or `Repairing` nodes to `Pending` (they
    /// may have been mid-execution when the process died), then re-executes.
    pub async fn resume_graph(
        &self,
        run_id: &str,
        template: &GraphTemplate,
    ) -> Result<GraphRun, EngineError> {
        let mut run = self.state_store.load_graph_run(run_id)?;
        reset_interrupted_nodes(&mut run);
        self.run_graph(&mut run, template).await?;
        Ok(run)
    }

    /// Resume a previously interrupted run with event streaming and cancellation.
    pub async fn resume_graph_with_events(
        &self,
        run_id: &str,
        template: &GraphTemplate,
        event_tx: tokio::sync::mpsc::UnboundedSender<executor::ExecutionEvent>,
        cancel_token: CancellationToken,
    ) -> Result<GraphRun, EngineError> {
        let mut run = self.state_store.load_graph_run(run_id)?;
        reset_interrupted_nodes(&mut run);
        self.run_graph_with_events(&mut run, template, event_tx, cancel_token)
            .await?;
        Ok(run)
    }

    /// Run a graph with dynamic rewrite support.
    ///
    /// When a node succeeds, its outputs are checked against the template's
    /// rewrite rules. If a rule fires, the referenced subgraph template is
    /// injected into the running graph via the template_provider.
    pub async fn run_graph_with_rewrites(
        &self,
        run: &mut GraphRun,
        template: &GraphTemplate,
        provider: &dyn TemplateProvider,
    ) -> Result<(), EngineError> {
        executor::execute_run(
            run,
            template,
            &self.tool_registry,
            self.state_store.as_ref(),
            self.artifact_store.as_ref(),
            &self.repair_registry,
            self.config.max_concurrent_nodes,
            None,
            Some(provider),
            None,
        )
        .await
    }

    /// Resume a previously interrupted run with rewrite support.
    ///
    /// Same as `resume_graph` but allows rewrite rules to continue firing.
    pub async fn resume_graph_with_rewrites(
        &self,
        run_id: &str,
        template: &GraphTemplate,
        provider: &dyn TemplateProvider,
    ) -> Result<GraphRun, EngineError> {
        let mut run = self.state_store.load_graph_run(run_id)?;
        reset_interrupted_nodes(&mut run);
        self.run_graph_with_rewrites(&mut run, template, provider).await?;
        Ok(run)
    }

    /// Get current status of a run.
    pub fn get_graph_status(&self, run_id: &str) -> Result<GraphRun, EngineError> {
        self.state_store.load_graph_run(run_id)
    }

    /// List all graph runs.
    pub fn list_graph_runs(&self) -> Result<Vec<GraphRun>, EngineError> {
        self.state_store.list_graph_runs()
    }

    /// Describe a graph template: returns structured metadata for agent inspection.
    pub fn describe_graph_template(
        &self,
        template: &GraphTemplate,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": template.id,
            "version": template.version,
            "description": template.description,
            "inputs_schema": template.inputs_schema,
            "node_count": template.nodes.len(),
            "node_ids": template.nodes.iter().map(|n| &n.id).collect::<Vec<_>>(),
            "outputs": template.outputs.iter().map(|o| &o.name).collect::<Vec<_>>(),
        })
    }

    /// List all artifacts across all nodes in a run.
    pub fn list_graph_artifacts(
        &self,
        run_id: &str,
    ) -> Result<Vec<(String, Vec<ArtifactRef>)>, EngineError> {
        let run = self.state_store.load_graph_run(run_id)?;
        let mut result = Vec::new();
        for nr in &run.node_runs {
            if !nr.artifacts.is_empty() {
                result.push((nr.node_id.clone(), nr.artifacts.clone()));
            }
        }
        Ok(result)
    }

    /// Trigger repair on a failed node, then re-run the graph.
    ///
    /// Uses the node's `repair_policy` to find the appropriate repair handler,
    /// transitions the node through Repairing state, and if repair succeeds,
    /// resets the node for re-execution.
    pub async fn repair_failed_node(
        &self,
        run_id: &str,
        node_id: &str,
        template: &GraphTemplate,
    ) -> Result<GraphRun, EngineError> {
        let mut run = self.state_store.load_graph_run(run_id)?;

        let node_tmpl = template
            .nodes
            .iter()
            .find(|n| n.id == node_id)
            .ok_or_else(|| EngineError::NodeNotFound {
                run_id: run_id.to_string(),
                node_id: node_id.to_string(),
            })?;

        // Verify node is in Failed state
        let nr = run.node_run(node_id).ok_or_else(|| EngineError::NodeNotFound {
            run_id: run_id.to_string(),
            node_id: node_id.to_string(),
        })?;
        if nr.status != NodeStatus::Failed {
            return Err(EngineError::InvalidTransition {
                node_id: node_id.to_string(),
                from: nr.status,
                to: NodeStatus::Repairing,
            });
        }

        // Look up repair handler
        let repair_ref = node_tmpl.repair_policy.as_ref().ok_or_else(|| {
            EngineError::Validation {
                reason: format!("Node '{}' has no repair_policy configured", node_id),
            }
        })?;

        let handler = self.repair_registry.get(&repair_ref.handler).ok_or_else(|| {
            EngineError::Validation {
                reason: format!(
                    "Repair handler '{}' not found in registry",
                    repair_ref.handler
                ),
            }
        })?;

        // Transition to Repairing
        {
            let nr_mut = run.node_run_mut(node_id).unwrap();
            nr_mut.status = NodeStatus::Repairing;
        }
        self.state_store.save_graph_run(&run)?;

        // Execute repair
        let ctx = crate::repair::RepairContext {
            run_id: run_id.to_string(),
            node_id: node_id.to_string(),
            work_dir: format!("{}/{}", run.run_dir, node_id),
        };

        let nr_snapshot = run.node_run(node_id).unwrap().clone();
        match handler.repair(ctx, &nr_snapshot).await {
            Ok(outcome) => {
                let nr_mut = run.node_run_mut(node_id).unwrap();
                // Reset for re-execution
                nr_mut.status = NodeStatus::Pending;
                nr_mut.started_at = None;
                nr_mut.finished_at = None;
                if let Some(repaired) = outcome.repaired_inputs {
                    nr_mut.resolved_inputs = Some(repaired);
                }
                nr_mut.artifacts.extend(outcome.artifacts);
                self.state_store.save_graph_run(&run)?;

                // Re-run the graph from current state
                self.run_graph(&mut run, template).await?;
                Ok(run)
            }
            Err(err) => {
                let nr_mut = run.node_run_mut(node_id).unwrap();
                nr_mut.status = NodeStatus::Failed;
                nr_mut.last_error = Some(err);
                self.state_store.save_graph_run(&run)?;
                Ok(run)
            }
        }
    }

    /// Instantiate a graph with subgraph expansion.
    ///
    /// Expands any subgraph references in the template using the given provider,
    /// then instantiates the expanded (flat) template.
    ///
    /// Returns both the GraphRun and the expanded GraphTemplate (needed for run_graph).
    pub fn instantiate_graph_with_subgraphs(
        &self,
        template: &GraphTemplate,
        inputs: serde_json::Value,
        provider: &dyn TemplateProvider,
    ) -> Result<(GraphRun, GraphTemplate), EngineError> {
        let expanded = composer::expand_subgraphs(template, provider)?;
        let run = self.instantiate_graph(&expanded, inputs)?;
        Ok((run, expanded))
    }

    /// Run a graph with subgraph expansion.
    ///
    /// Convenience method that expands subgraphs and then runs.
    pub async fn run_graph_with_subgraphs(
        &self,
        run: &mut GraphRun,
        template: &GraphTemplate,
        provider: &dyn TemplateProvider,
    ) -> Result<(), EngineError> {
        let expanded = composer::expand_subgraphs(template, provider)?;
        executor::execute_run(
            &mut *run,
            &expanded,
            &self.tool_registry,
            self.state_store.as_ref(),
            self.artifact_store.as_ref(),
            &self.repair_registry,
            self.config.max_concurrent_nodes,
            None,
            None,
            None,
        )
        .await
    }
}

/// Reset nodes that were mid-execution when the process was interrupted.
///
/// On crash recovery, nodes in `Running`, `Ready`, or `Repairing` states
/// cannot be trusted — they may have been partially executed. This resets
/// them to `Pending` so they will be re-scheduled from scratch.
fn reset_interrupted_nodes(run: &mut GraphRun) {
    for nr in &mut run.node_runs {
        if nr.status == NodeStatus::Running
            || nr.status == NodeStatus::Ready
            || nr.status == NodeStatus::Repairing
        {
            tracing::warn!(
                "Resetting interrupted node '{}' from {:?} to Pending",
                nr.node_id,
                nr.status,
            );
            nr.status = NodeStatus::Pending;
            nr.started_at = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::template::{GraphTemplate, NodeTemplate};
    use crate::storage::file_store::FileArtifactStore;
    use crate::storage::sqlite_store::SqliteStateStore;
    use crate::tools::mock::EchoTool;
    use serde_json::json;
    use std::sync::Arc;
    use tempfile::tempdir;

    /// Helper: create a minimal valid GraphTemplate
    fn make_template(nodes: Vec<(&str, &str, Vec<&str>)>) -> GraphTemplate {
        GraphTemplate {
            id: "test-template".to_string(),
            version: "1.0".to_string(),
            description: Some("Test template".to_string()),
            inputs_schema: json!({"type": "object"}),
            nodes: nodes
                .into_iter()
                .map(|(id, tool, deps)| NodeTemplate {
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
                })
                .collect(),
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        }
    }

    /// Helper: create a GraphEngine with in-memory store and temp artifact dir
    fn make_engine(tmp_path: &std::path::Path) -> GraphEngine {
        let state_store = Arc::new(
            SqliteStateStore::new(":memory:").expect("in-memory SQLite should work"),
        );
        let artifact_store = Arc::new(FileArtifactStore::new(tmp_path));
        let mut tool_registry = ToolRegistry::new();
        tool_registry.register(Arc::new(EchoTool::new("echo")));

        GraphEngine::new(
            RuntimeConfig::default(),
            tool_registry,
            state_store,
            artifact_store,
        )
    }

    #[test]
    fn test_instantiate_graph_creates_node_runs() {
        let tmp = tempdir().unwrap();
        let engine = make_engine(tmp.path());
        let template = make_template(vec![
            ("a", "echo", vec![]),
            ("b", "echo", vec!["a"]),
            ("c", "echo", vec!["a"]),
            ("d", "echo", vec!["b", "c"]),
        ]);

        let run = engine
            .instantiate_graph(&template, json!({"structure": "Si"}))
            .expect("instantiate_graph should succeed");

        // Verify correct number of node_runs
        assert_eq!(run.node_runs.len(), 4);

        // Verify all nodes start in Pending status
        for nr in &run.node_runs {
            assert_eq!(
                nr.status,
                NodeStatus::Pending,
                "Node '{}' should start as Pending",
                nr.node_id
            );
        }

        // Verify node IDs match template
        let node_ids: Vec<&str> = run.node_runs.iter().map(|n| n.node_id.as_str()).collect();
        assert!(node_ids.contains(&"a"));
        assert!(node_ids.contains(&"b"));
        assert!(node_ids.contains(&"c"));
        assert!(node_ids.contains(&"d"));

        // Verify run-level properties
        assert_eq!(run.status, GraphRunStatus::Created);
        assert_eq!(run.template_id, "test-template");
        assert_eq!(run.template_version, "1.0");
        assert_eq!(run.inputs, json!({"structure": "Si"}));
    }

    #[test]
    fn test_instantiate_graph_validates_template() {
        let tmp = tempdir().unwrap();
        let engine = make_engine(tmp.path());

        // Create a template with a cycle: a -> b -> a
        let template = GraphTemplate {
            id: "cyclic".to_string(),
            version: "1.0".to_string(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![
                NodeTemplate {
                    id: "a".to_string(),
                    tool: "echo".to_string(),
                    depends_on: vec!["b".to_string()],
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
                    id: "b".to_string(),
                    tool: "echo".to_string(),
                    depends_on: vec!["a".to_string()],
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
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let result = engine.instantiate_graph(&template, json!({}));
        assert!(
            result.is_err(),
            "instantiate_graph should fail on a cyclic template"
        );

        // Verify it's specifically a CycleDetected error
        match result.unwrap_err() {
            EngineError::CycleDetected { nodes } => {
                assert!(nodes.contains(&"a".to_string()));
                assert!(nodes.contains(&"b".to_string()));
            }
            other => panic!("Expected CycleDetected error, got: {:?}", other),
        }
    }

    #[test]
    fn test_instantiate_graph_persists_to_store() {
        let tmp = tempdir().unwrap();
        let engine = make_engine(tmp.path());
        let template = make_template(vec![
            ("step1", "echo", vec![]),
            ("step2", "echo", vec!["step1"]),
        ]);

        let run = engine
            .instantiate_graph(&template, json!({"param": "value"}))
            .expect("instantiate_graph should succeed");
        let run_id = run.id.clone();

        // Load the run back from the store using get_graph_status
        let loaded = engine
            .get_graph_status(&run_id)
            .expect("should be able to load persisted run");

        assert_eq!(loaded.id, run_id);
        assert_eq!(loaded.template_id, "test-template");
        assert_eq!(loaded.status, GraphRunStatus::Created);
        assert_eq!(loaded.node_runs.len(), 2);
        assert_eq!(loaded.inputs, json!({"param": "value"}));

        // Verify node IDs roundtrip
        let loaded_node_ids: Vec<&str> =
            loaded.node_runs.iter().map(|n| n.node_id.as_str()).collect();
        assert!(loaded_node_ids.contains(&"step1"));
        assert!(loaded_node_ids.contains(&"step2"));

        // Also verify it shows up in list_graph_runs
        let all_runs = engine.list_graph_runs().expect("list_graph_runs should work");
        assert_eq!(all_runs.len(), 1);
        assert_eq!(all_runs[0].id, run_id);
    }

    #[test]
    fn test_default_config() {
        let config = RuntimeConfig::default();
        assert_eq!(
            config.max_concurrent_nodes, 4,
            "Default max_concurrent_nodes should be 4"
        );
        assert_eq!(
            config.artifact_root, "./artifacts",
            "Default artifact_root should be './artifacts'"
        );
        assert_eq!(
            config.state_db_path, ":memory:",
            "Default state_db_path should be ':memory:'"
        );
    }

    #[test]
    fn test_describe_graph_template() {
        let tmp = tempdir().unwrap();
        let engine = make_engine(tmp.path());

        let mut template = make_template(vec![
            ("relax", "echo", vec![]),
            ("adsorb", "echo", vec!["relax"]),
            ("calc", "echo", vec!["adsorb"]),
        ]);
        template.description = Some("OER screening workflow".to_string());
        template.outputs = vec![
            crate::graph::template::GraphOutputSpec {
                name: "energy".to_string(),
                source: "${nodes.calc.outputs.energy}".to_string(),
            },
        ];

        let desc = engine.describe_graph_template(&template);

        // Verify expected keys exist
        assert_eq!(desc["id"], json!("test-template"));
        assert_eq!(desc["version"], json!("1.0"));
        assert_eq!(desc["description"], json!("OER screening workflow"));
        assert_eq!(desc["node_count"], json!(3));

        // Verify node_ids
        let node_ids = desc["node_ids"].as_array().expect("node_ids should be array");
        assert_eq!(node_ids.len(), 3);
        assert!(node_ids.contains(&json!("relax")));
        assert!(node_ids.contains(&json!("adsorb")));
        assert!(node_ids.contains(&json!("calc")));

        // Verify outputs
        let outputs = desc["outputs"].as_array().expect("outputs should be array");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0], json!("energy"));

        // Verify inputs_schema is present
        assert!(desc.get("inputs_schema").is_some());
    }

    #[test]
    fn test_instantiate_with_subgraph_expansion() {
        let tmp = tempdir().unwrap();
        let engine = make_engine(tmp.path());

        // Create a simple subgraph template
        let sub_template = GraphTemplate {
            id: "sub_workflow".to_string(),
            version: "1.0".to_string(),
            description: Some("A sub-workflow".to_string()),
            inputs_schema: json!({"type": "object"}),
            nodes: vec![
                NodeTemplate {
                    id: "inner_a".to_string(),
                    tool: "echo".to_string(),
                    depends_on: vec![],
                    input_bindings: json!({"data": "${inputs.x}"}),
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
            outputs: vec![
                crate::graph::template::GraphOutputSpec {
                    name: "result".to_string(),
                    source: "${nodes.inner_a.outputs.data}".to_string(),
                },
            ],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        // Create parent template that uses the subgraph
        let parent_template = GraphTemplate {
            id: "parent_workflow".to_string(),
            version: "1.0".to_string(),
            description: Some("A parent workflow".to_string()),
            inputs_schema: json!({"type": "object"}),
            nodes: vec![
                NodeTemplate {
                    id: "setup".to_string(),
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
                    id: "sub_step".to_string(),
                    tool: "".to_string(),
                    depends_on: vec!["setup".to_string()],
                    input_bindings: json!({}),
                    output_spec: None,
                    retry_policy: None,
                    timeout_seconds: None,
                    repair_policy: None,
                    execution_mode: Default::default(),
                    skip_condition: None,
                    subgraph: Some(crate::graph::template::SubgraphRef {
                        template_id: "sub_workflow".to_string(),
                        version: None,
                        input_map: json!({"x": "${inputs.value}"}),
                    }),
                    metadata: Default::default(),
                },
            ],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        // Create provider with sub_template registered
        let registry = crate::api::graph_api::TemplateRegistry::new();
        registry.register(sub_template);

        // Instantiate with subgraph expansion
        let (run, expanded) = engine
            .instantiate_graph_with_subgraphs(&parent_template, json!({"value": "hello"}), &registry)
            .unwrap();

        // Verify: setup + sub_step/inner_a (expanded)
        assert_eq!(run.node_runs.len(), 2, "Should have setup + expanded inner_a");

        let node_ids: Vec<&str> = run.node_runs.iter().map(|n| n.node_id.as_str()).collect();
        assert!(node_ids.contains(&"setup"));
        assert!(node_ids.contains(&"sub_step/inner_a"), "Expanded node should have prefixed ID");

        // Verify expanded template has the right structure
        assert_eq!(expanded.nodes.len(), 2);
    }

    #[tokio::test]
    async fn test_run_graph_with_subgraph_execution() {
        let tmp = tempdir().unwrap();
        let engine = make_engine(tmp.path());

        // Simple subgraph with one echo node
        let sub_template = GraphTemplate {
            id: "echo_sub".to_string(),
            version: "1.0".to_string(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![NodeTemplate {
                id: "echo_node".to_string(),
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
            }],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        // Parent with subgraph node
        let parent = GraphTemplate {
            id: "parent".to_string(),
            version: "1.0".to_string(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![NodeTemplate {
                id: "sub".to_string(),
                tool: "".to_string(),
                depends_on: vec![],
                input_bindings: json!({}),
                output_spec: None,
                retry_policy: None,
                timeout_seconds: None,
                repair_policy: None,
                execution_mode: Default::default(),
                skip_condition: None,
                subgraph: Some(crate::graph::template::SubgraphRef {
                    template_id: "echo_sub".to_string(),
                    version: None,
                    input_map: json!({}),
                }),
                metadata: Default::default(),
            }],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let registry = crate::api::graph_api::TemplateRegistry::new();
        registry.register(sub_template);

        let (mut run, expanded) = engine
            .instantiate_graph_with_subgraphs(&parent, json!({}), &registry)
            .unwrap();

        // Run the expanded graph
        engine.run_graph(&mut run, &expanded).await.unwrap();

        // Verify all nodes succeeded
        assert_eq!(run.status, GraphRunStatus::Succeeded);
        for nr in &run.node_runs {
            assert_eq!(nr.status, NodeStatus::Succeeded, "Node '{}' should succeed", nr.node_id);
        }
    }
}

use crate::core::EngineError;
use crate::graph::run::{ArtifactRef, GraphRun, NodeRun};

/// Trait for persisting execution state (graph runs, node states).
/// Must survive process restart.
pub trait StateStore: Send + Sync {
    /// Persist an entire graph run (inserts or replaces).
    fn save_graph_run(&self, run: &GraphRun) -> Result<(), EngineError>;

    /// Load a graph run by its ID.
    fn load_graph_run(&self, run_id: &str) -> Result<GraphRun, EngineError>;

    /// Update a single node run within an existing graph run.
    /// More efficient than re-saving the entire graph.
    fn update_node_run(&self, run_id: &str, node: &NodeRun) -> Result<(), EngineError>;

    /// List all stored graph runs.
    fn list_graph_runs(&self) -> Result<Vec<GraphRun>, EngineError>;

    /// Delete a graph run and all associated node runs.
    fn delete_graph_run(&self, run_id: &str) -> Result<(), EngineError>;
}

/// Trait for storing artifacts (files, JSON results, etc.).
/// Separate from state store by design — artifacts live on disk while
/// state metadata lives in a database.
pub trait ArtifactStore: Send + Sync {
    /// Serialize a JSON value as a named artifact for a node.
    fn save_json(
        &self,
        run_id: &str,
        node_id: &str,
        name: &str,
        value: &serde_json::Value,
    ) -> Result<ArtifactRef, EngineError>;

    /// Copy a file into the artifact store from `src_path`.
    fn save_file(
        &self,
        run_id: &str,
        node_id: &str,
        src_path: &str,
    ) -> Result<ArtifactRef, EngineError>;

    /// Load a previously-saved JSON artifact by name.
    fn load_json(
        &self,
        run_id: &str,
        node_id: &str,
        name: &str,
    ) -> Result<serde_json::Value, EngineError>;

    /// List all artifacts for a given node in a given run.
    fn list_node_artifacts(
        &self,
        run_id: &str,
        node_id: &str,
    ) -> Result<Vec<ArtifactRef>, EngineError>;
}

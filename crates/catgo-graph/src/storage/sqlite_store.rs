use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{params, Connection};

use crate::core::EngineError;
use crate::graph::run::{GraphRun, NodeRun};
use crate::storage::traits::StateStore;

/// SQLite-backed state store.
///
/// Serializes `GraphRun` as JSON into a `graph_runs` table and each
/// `NodeRun` separately into a `node_runs` table. This allows
/// `update_node_run` to update individual nodes efficiently without
/// rewriting the entire run.
///
/// When loading, the `GraphRun` is deserialized from `graph_runs.data`
/// but its `node_runs` field is **replaced** with the individual records
/// from the `node_runs` table (which may be more up-to-date after
/// incremental updates).
pub struct SqliteStateStore {
    conn: Mutex<Connection>,
}

impl SqliteStateStore {
    /// Open (or create) a SQLite state store at the given path.
    /// Use `":memory:"` for an in-memory database (useful for tests).
    pub fn new(path: &str) -> Result<Self, EngineError> {
        let conn = if path == ":memory:" {
            Connection::open_in_memory().map_err(Self::map_sqlite_err)?
        } else {
            Connection::open(path).map_err(Self::map_sqlite_err)?
        };
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.init_tables()?;
        Ok(store)
    }

    /// Create the required tables if they don't already exist.
    fn init_tables(&self) -> Result<(), EngineError> {
        let conn = self.lock_conn()?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS graph_runs (
                id TEXT PRIMARY KEY,
                template_id TEXT NOT NULL,
                status TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS node_runs (
                run_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                status TEXT NOT NULL,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (run_id, node_id)
            );
            ",
        )
        .map_err(Self::map_sqlite_err)?;
        Ok(())
    }

    /// Lock the mutex and return the connection, mapping poison errors.
    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, EngineError> {
        self.conn.lock().map_err(|e| EngineError::Storage {
            reason: format!("Failed to acquire database lock: {}", e),
        })
    }

    /// Map a `rusqlite::Error` into `EngineError::Storage`.
    fn map_sqlite_err(e: rusqlite::Error) -> EngineError {
        EngineError::Storage {
            reason: format!("SQLite error: {}", e),
        }
    }

    /// Map a `serde_json::Error` into `EngineError::Storage`.
    fn map_json_err(e: serde_json::Error) -> EngineError {
        EngineError::Storage {
            reason: format!("JSON serialization error: {}", e),
        }
    }
}

impl StateStore for SqliteStateStore {
    fn save_graph_run(&self, run: &GraphRun) -> Result<(), EngineError> {
        let conn = self.lock_conn()?;
        let data = serde_json::to_string(run).map_err(Self::map_json_err)?;
        let status = serde_json::to_string(&run.status).map_err(Self::map_json_err)?;
        let now = Utc::now().to_rfc3339();

        // Wrap all writes in a transaction so graph_runs + node_runs are
        // persisted atomically.  A crash between statements cannot leave
        // the database in an inconsistent state.
        conn.execute_batch("BEGIN TRANSACTION")
            .map_err(Self::map_sqlite_err)?;

        let result = (|| -> Result<(), EngineError> {
            // Upsert the graph run record
            conn.execute(
                "INSERT OR REPLACE INTO graph_runs (id, template_id, status, data, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    run.id,
                    run.template_id,
                    status,
                    data,
                    run.created_at.to_rfc3339(),
                    now,
                ],
            )
            .map_err(Self::map_sqlite_err)?;

            // Upsert each node run separately
            for node_run in &run.node_runs {
                let node_data = serde_json::to_string(node_run).map_err(Self::map_json_err)?;
                let node_status =
                    serde_json::to_string(&node_run.status).map_err(Self::map_json_err)?;

                conn.execute(
                    "INSERT OR REPLACE INTO node_runs (run_id, node_id, status, data, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![run.id, node_run.node_id, node_status, node_data, now],
                )
                .map_err(Self::map_sqlite_err)?;
            }

            Ok(())
        })();

        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT")
                    .map_err(Self::map_sqlite_err)?;
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    fn load_graph_run(&self, run_id: &str) -> Result<GraphRun, EngineError> {
        let conn = self.lock_conn()?;

        // Load the base GraphRun from graph_runs
        let data: String = conn
            .query_row(
                "SELECT data FROM graph_runs WHERE id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => EngineError::Storage {
                    reason: format!("Graph run not found: {}", run_id),
                },
                other => Self::map_sqlite_err(other),
            })?;

        let mut run: GraphRun = serde_json::from_str(&data).map_err(Self::map_json_err)?;

        // Load individual node runs (which may be more up-to-date)
        let mut stmt = conn
            .prepare("SELECT data FROM node_runs WHERE run_id = ?1")
            .map_err(Self::map_sqlite_err)?;

        let node_runs: Vec<NodeRun> = stmt
            .query_map(params![run_id], |row| {
                let node_data: String = row.get(0)?;
                Ok(node_data)
            })
            .map_err(Self::map_sqlite_err)?
            .map(|row_result| {
                let node_data = row_result.map_err(Self::map_sqlite_err)?;
                serde_json::from_str(&node_data).map_err(Self::map_json_err)
            })
            .collect::<Result<Vec<_>, _>>()?;

        // Replace with individual node records (more up-to-date)
        if !node_runs.is_empty() {
            run.node_runs = node_runs;
        }

        Ok(run)
    }

    fn update_node_run(&self, run_id: &str, node: &NodeRun) -> Result<(), EngineError> {
        let conn = self.lock_conn()?;
        let node_data = serde_json::to_string(node).map_err(Self::map_json_err)?;
        let node_status = serde_json::to_string(&node.status).map_err(Self::map_json_err)?;
        let now = Utc::now().to_rfc3339();

        // Update or insert the node run
        let rows = conn
            .execute(
                "INSERT OR REPLACE INTO node_runs (run_id, node_id, status, data, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![run_id, node.node_id, node_status, node_data, now],
            )
            .map_err(Self::map_sqlite_err)?;

        if rows == 0 {
            return Err(EngineError::Storage {
                reason: format!(
                    "Failed to update node run: run_id={}, node_id={}",
                    run_id, node.node_id
                ),
            });
        }

        // Touch the graph run's updated_at timestamp
        conn.execute(
            "UPDATE graph_runs SET updated_at = ?1 WHERE id = ?2",
            params![now, run_id],
        )
        .map_err(Self::map_sqlite_err)?;

        Ok(())
    }

    fn list_graph_runs(&self) -> Result<Vec<GraphRun>, EngineError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare("SELECT id FROM graph_runs ORDER BY created_at DESC")
            .map_err(Self::map_sqlite_err)?;

        let run_ids: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .map_err(Self::map_sqlite_err)?
            .map(|r| r.map_err(Self::map_sqlite_err))
            .collect::<Result<Vec<_>, _>>()?;

        // Need to drop the connection lock before calling load_graph_run
        // which acquires it again. So we collect IDs first, drop, then load.
        drop(stmt);
        drop(conn);

        let mut runs = Vec::with_capacity(run_ids.len());
        for run_id in &run_ids {
            runs.push(self.load_graph_run(run_id)?);
        }
        Ok(runs)
    }

    fn delete_graph_run(&self, run_id: &str) -> Result<(), EngineError> {
        let conn = self.lock_conn()?;

        // Delete atomically so a crash cannot leave orphaned records.
        conn.execute_batch("BEGIN TRANSACTION")
            .map_err(Self::map_sqlite_err)?;

        let result = (|| -> Result<(), EngineError> {
            conn.execute(
                "DELETE FROM node_runs WHERE run_id = ?1",
                params![run_id],
            )
            .map_err(Self::map_sqlite_err)?;

            conn.execute("DELETE FROM graph_runs WHERE id = ?1", params![run_id])
                .map_err(Self::map_sqlite_err)?;

            Ok(())
        })();

        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT")
                    .map_err(Self::map_sqlite_err)?;
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{GraphRunStatus, NodeStatus};
    use crate::graph::run::{GraphRun, NodeRun};
    use chrono::Utc;
    use std::collections::HashMap;

    /// Create a minimal GraphRun for testing.
    fn make_test_run(id: &str) -> GraphRun {
        let now = Utc::now();
        GraphRun {
            id: id.to_string(),
            template_id: "template-1".to_string(),
            template_version: "1.0.0".to_string(),
            status: GraphRunStatus::Created,
            inputs: serde_json::json!({"structure": "Si"}),
            node_runs: vec![
                NodeRun::new("node-a".to_string()),
                NodeRun::new("node-b".to_string()),
            ],
            created_at: now,
            updated_at: now,
            run_dir: "/tmp/runs/test".to_string(),
            metadata: HashMap::new(),
            rewrite_events: vec![],
        }
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let store = SqliteStateStore::new(":memory:").unwrap();
        let run = make_test_run("run-1");

        store.save_graph_run(&run).unwrap();
        let loaded = store.load_graph_run("run-1").unwrap();

        assert_eq!(loaded.id, "run-1");
        assert_eq!(loaded.template_id, "template-1");
        assert_eq!(loaded.template_version, "1.0.0");
        assert_eq!(loaded.status, GraphRunStatus::Created);
        assert_eq!(loaded.node_runs.len(), 2);
        assert_eq!(loaded.node_runs[0].node_id, "node-a");
        assert_eq!(loaded.node_runs[1].node_id, "node-b");
        assert_eq!(loaded.run_dir, "/tmp/runs/test");
    }

    #[test]
    fn test_load_nonexistent_run() {
        let store = SqliteStateStore::new(":memory:").unwrap();
        let result = store.load_graph_run("no-such-run");
        assert!(result.is_err());
    }

    #[test]
    fn test_update_node_run() {
        let store = SqliteStateStore::new(":memory:").unwrap();
        let run = make_test_run("run-1");
        store.save_graph_run(&run).unwrap();

        // Update node-a to Running with some outputs
        let mut updated_node = NodeRun::new("node-a".to_string());
        updated_node.status = NodeStatus::Running;
        updated_node.started_at = Some(Utc::now());
        updated_node.resolved_inputs = Some(serde_json::json!({"input": "resolved"}));

        store.update_node_run("run-1", &updated_node).unwrap();

        // Reload and verify node-a was updated
        let loaded = store.load_graph_run("run-1").unwrap();
        let node_a = loaded.node_run("node-a").expect("node-a should exist");
        assert_eq!(node_a.status, NodeStatus::Running);
        assert!(node_a.started_at.is_some());
        assert!(node_a.resolved_inputs.is_some());

        // node-b should remain unchanged
        let node_b = loaded.node_run("node-b").expect("node-b should exist");
        assert_eq!(node_b.status, NodeStatus::Pending);
    }

    #[test]
    fn test_update_node_run_to_succeeded() {
        let store = SqliteStateStore::new(":memory:").unwrap();
        let run = make_test_run("run-1");
        store.save_graph_run(&run).unwrap();

        let mut node = NodeRun::new("node-a".to_string());
        node.status = NodeStatus::Succeeded;
        node.outputs = Some(serde_json::json!({"energy": -42.5}));
        node.finished_at = Some(Utc::now());

        store.update_node_run("run-1", &node).unwrap();

        let loaded = store.load_graph_run("run-1").unwrap();
        let node_a = loaded.node_run("node-a").unwrap();
        assert_eq!(node_a.status, NodeStatus::Succeeded);
        assert_eq!(
            node_a.outputs,
            Some(serde_json::json!({"energy": -42.5}))
        );
    }

    #[test]
    fn test_list_graph_runs() {
        let store = SqliteStateStore::new(":memory:").unwrap();

        // Start empty
        let runs = store.list_graph_runs().unwrap();
        assert!(runs.is_empty());

        // Add two runs
        store.save_graph_run(&make_test_run("run-1")).unwrap();
        store.save_graph_run(&make_test_run("run-2")).unwrap();

        let runs = store.list_graph_runs().unwrap();
        assert_eq!(runs.len(), 2);

        let ids: Vec<&str> = runs.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"run-1"));
        assert!(ids.contains(&"run-2"));
    }

    #[test]
    fn test_delete_graph_run() {
        let store = SqliteStateStore::new(":memory:").unwrap();
        store.save_graph_run(&make_test_run("run-1")).unwrap();
        store.save_graph_run(&make_test_run("run-2")).unwrap();

        // Delete run-1
        store.delete_graph_run("run-1").unwrap();

        // run-1 should be gone
        assert!(store.load_graph_run("run-1").is_err());

        // run-2 should still exist
        let loaded = store.load_graph_run("run-2").unwrap();
        assert_eq!(loaded.id, "run-2");

        // list should have 1 run
        let runs = store.list_graph_runs().unwrap();
        assert_eq!(runs.len(), 1);
    }

    #[test]
    fn test_delete_nonexistent_run_is_ok() {
        let store = SqliteStateStore::new(":memory:").unwrap();
        // Deleting a non-existent run should not error
        let result = store.delete_graph_run("no-such-run");
        assert!(result.is_ok());
    }

    #[test]
    fn test_save_overwrites_existing() {
        let store = SqliteStateStore::new(":memory:").unwrap();

        let mut run = make_test_run("run-1");
        store.save_graph_run(&run).unwrap();

        // Modify status and re-save
        run.status = GraphRunStatus::Running;
        store.save_graph_run(&run).unwrap();

        let loaded = store.load_graph_run("run-1").unwrap();
        assert_eq!(loaded.status, GraphRunStatus::Running);
    }

    #[test]
    fn test_concurrent_access_via_mutex() {
        // Verify that the Mutex allows sequential access from multiple "threads"
        // (single-threaded test but validates the locking pattern works)
        let store = SqliteStateStore::new(":memory:").unwrap();
        store.save_graph_run(&make_test_run("run-1")).unwrap();

        // Multiple load/save cycles should not deadlock
        for i in 0..10 {
            let mut run = store.load_graph_run("run-1").unwrap();
            run.metadata
                .insert("iteration".to_string(), serde_json::json!(i));
            store.save_graph_run(&run).unwrap();
        }

        let final_run = store.load_graph_run("run-1").unwrap();
        assert_eq!(final_run.metadata["iteration"], serde_json::json!(9));
    }

    #[test]
    fn test_update_node_run_preserves_other_runs() {
        // Two separate graph runs; updating a node in one should not affect the other
        let store = SqliteStateStore::new(":memory:").unwrap();
        store.save_graph_run(&make_test_run("run-1")).unwrap();
        store.save_graph_run(&make_test_run("run-2")).unwrap();

        // Update node-a in run-1 to Succeeded
        let mut node_a = NodeRun::new("node-a".to_string());
        node_a.status = NodeStatus::Succeeded;
        node_a.outputs = Some(serde_json::json!({"energy": -100.0}));
        node_a.finished_at = Some(Utc::now());
        store.update_node_run("run-1", &node_a).unwrap();

        // Verify run-1 node-a was updated
        let loaded_run1 = store.load_graph_run("run-1").unwrap();
        let run1_node_a = loaded_run1.node_run("node-a").unwrap();
        assert_eq!(run1_node_a.status, NodeStatus::Succeeded);
        assert_eq!(
            run1_node_a.outputs,
            Some(serde_json::json!({"energy": -100.0}))
        );

        // Verify run-2 node-a is still Pending (unchanged)
        let loaded_run2 = store.load_graph_run("run-2").unwrap();
        let run2_node_a = loaded_run2.node_run("node-a").unwrap();
        assert_eq!(run2_node_a.status, NodeStatus::Pending);
        assert!(run2_node_a.outputs.is_none());

        // Verify run-2 node-b is also still Pending
        let run2_node_b = loaded_run2.node_run("node-b").unwrap();
        assert_eq!(run2_node_b.status, NodeStatus::Pending);
    }

    #[test]
    fn test_save_run_with_artifacts() {
        use crate::graph::run::{ArtifactKind, ArtifactRef};

        let store = SqliteStateStore::new(":memory:").unwrap();
        let now = Utc::now();

        // Create a run where node-a has artifacts
        let mut node_a = NodeRun::new("node-a".to_string());
        node_a.status = NodeStatus::Succeeded;
        node_a.artifacts = vec![
            ArtifactRef {
                id: "art-1".to_string(),
                kind: ArtifactKind::Json,
                path: Some("/tmp/output.json".to_string()),
                uri: None,
                metadata: HashMap::new(),
            },
            ArtifactRef {
                id: "art-2".to_string(),
                kind: ArtifactKind::File,
                path: Some("/tmp/POSCAR".to_string()),
                uri: Some("file:///tmp/POSCAR".to_string()),
                metadata: HashMap::new(),
            },
        ];

        let run = GraphRun {
            id: "run-artifacts".to_string(),
            template_id: "template-1".to_string(),
            template_version: "1.0.0".to_string(),
            status: GraphRunStatus::Succeeded,
            inputs: serde_json::json!({}),
            node_runs: vec![node_a],
            created_at: now,
            updated_at: now,
            run_dir: "/tmp/runs/artifacts".to_string(),
            metadata: HashMap::new(),
            rewrite_events: vec![],
        };

        store.save_graph_run(&run).unwrap();
        let loaded = store.load_graph_run("run-artifacts").unwrap();

        let loaded_node_a = loaded.node_run("node-a").unwrap();
        assert_eq!(loaded_node_a.artifacts.len(), 2);

        // Verify first artifact
        assert_eq!(loaded_node_a.artifacts[0].id, "art-1");
        assert_eq!(loaded_node_a.artifacts[0].kind, ArtifactKind::Json);
        assert_eq!(
            loaded_node_a.artifacts[0].path,
            Some("/tmp/output.json".to_string())
        );

        // Verify second artifact
        assert_eq!(loaded_node_a.artifacts[1].id, "art-2");
        assert_eq!(loaded_node_a.artifacts[1].kind, ArtifactKind::File);
        assert_eq!(
            loaded_node_a.artifacts[1].uri,
            Some("file:///tmp/POSCAR".to_string())
        );
    }

    #[test]
    fn test_save_run_with_attempts() {
        use crate::core::AttemptStatus;
        use crate::graph::run::{NodeAttempt, ToolExecutionResult};

        let store = SqliteStateStore::new(":memory:").unwrap();
        let now = Utc::now();

        // Create a node with two attempts: first failed, second succeeded
        let mut node_a = NodeRun::new("node-a".to_string());
        node_a.status = NodeStatus::Succeeded;
        node_a.current_attempt = 1;
        node_a.attempts = vec![
            NodeAttempt {
                attempt_index: 0,
                status: AttemptStatus::Failed,
                started_at: now,
                finished_at: Some(now),
                tool_request: serde_json::json!({"input": "first"}),
                tool_result: None,
                logs_path: Some("/tmp/logs/attempt-0.log".to_string()),
                error: Some(crate::core::StructuredError {
                    category: crate::core::ErrorCategory::ScfNonConvergence,
                    code: Some("SCF_FAIL".to_string()),
                    message: "SCF did not converge".to_string(),
                    retryable: true,
                    details: serde_json::json!({"max_iter": 100}),
                }),
            },
            NodeAttempt {
                attempt_index: 1,
                status: AttemptStatus::Succeeded,
                started_at: now,
                finished_at: Some(now),
                tool_request: serde_json::json!({"input": "second"}),
                tool_result: Some(ToolExecutionResult {
                    outputs: serde_json::json!({"energy": -42.5}),
                    artifacts: vec![],
                    logs: vec!["converged after 50 steps".to_string()],
                    metadata: HashMap::new(),
                }),
                logs_path: Some("/tmp/logs/attempt-1.log".to_string()),
                error: None,
            },
        ];

        let run = GraphRun {
            id: "run-attempts".to_string(),
            template_id: "template-1".to_string(),
            template_version: "1.0.0".to_string(),
            status: GraphRunStatus::Succeeded,
            inputs: serde_json::json!({}),
            node_runs: vec![node_a],
            created_at: now,
            updated_at: now,
            run_dir: "/tmp/runs/attempts".to_string(),
            metadata: HashMap::new(),
            rewrite_events: vec![],
        };

        store.save_graph_run(&run).unwrap();
        let loaded = store.load_graph_run("run-attempts").unwrap();

        let loaded_node = loaded.node_run("node-a").unwrap();
        assert_eq!(loaded_node.attempts.len(), 2);
        assert_eq!(loaded_node.current_attempt, 1);

        // Verify first attempt (failed)
        let attempt0 = &loaded_node.attempts[0];
        assert_eq!(attempt0.attempt_index, 0);
        assert_eq!(attempt0.status, AttemptStatus::Failed);
        assert_eq!(attempt0.tool_request, serde_json::json!({"input": "first"}));
        assert!(attempt0.error.is_some());
        let err = attempt0.error.as_ref().unwrap();
        assert_eq!(err.category, crate::core::ErrorCategory::ScfNonConvergence);
        assert!(err.retryable);

        // Verify second attempt (succeeded)
        let attempt1 = &loaded_node.attempts[1];
        assert_eq!(attempt1.attempt_index, 1);
        assert_eq!(attempt1.status, AttemptStatus::Succeeded);
        assert!(attempt1.tool_result.is_some());
        let result = attempt1.tool_result.as_ref().unwrap();
        assert_eq!(result.outputs, serde_json::json!({"energy": -42.5}));
        assert_eq!(result.logs, vec!["converged after 50 steps".to_string()]);
        assert!(attempt1.error.is_none());
    }
}

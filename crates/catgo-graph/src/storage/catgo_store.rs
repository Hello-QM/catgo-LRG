//! CatGO-compatible state store.
//!
//! Implements the `StateStore` trait but writes to the Python-compatible
//! normalized schema (`workflow_steps` table) instead of catgo-graph's
//! default JSON blob storage.
//!
//! This allows both Python and Rust to read/write the same database.

use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Mutex;

use crate::core::*;
use crate::graph::run::{ArtifactRef, GraphRun, NodeAttempt, NodeRun};
use crate::storage::traits::StateStore;

/// Maps Rust's 9-state NodeStatus to Python's 6-state status string.
pub fn rust_to_python_status(status: NodeStatus) -> &'static str {
    match status {
        NodeStatus::Pending => "pending",
        NodeStatus::Ready => "pending",    // Python has no Ready; stays pending until running
        NodeStatus::Running => "running",
        NodeStatus::Repairing => "running", // Python has no Repairing; maps to running
        NodeStatus::Succeeded => "completed",
        NodeStatus::Failed => "failed",
        NodeStatus::Blocked => "failed",    // Python has no Blocked; treated as failed
        NodeStatus::Skipped => "skipped",
        NodeStatus::Cancelled => "failed",  // Python has no Cancelled; treated as failed
    }
}

/// Maps Python's status string to Rust's NodeStatus.
pub fn python_to_rust_status(status: &str) -> NodeStatus {
    match status {
        "pending" | "queued" => NodeStatus::Pending,
        "running" => NodeStatus::Running,
        "completed" => NodeStatus::Succeeded,
        "failed" => NodeStatus::Failed,
        "skipped" => NodeStatus::Skipped,
        "paused" => NodeStatus::Pending, // paused → pending for resume
        _ => NodeStatus::Pending,
    }
}

/// Maps Rust's GraphRunStatus to Python workflow status.
pub fn rust_to_python_workflow_status(status: GraphRunStatus) -> &'static str {
    match status {
        GraphRunStatus::Created => "draft",
        GraphRunStatus::Validated => "draft",
        GraphRunStatus::Running => "running",
        GraphRunStatus::Paused => "paused",
        GraphRunStatus::Succeeded => "completed",
        GraphRunStatus::Failed => "failed",
        GraphRunStatus::Cancelled => "failed",
        GraphRunStatus::PartiallySucceeded => "completed",
    }
}

/// A StateStore implementation that reads/writes to CatGO's Python-compatible
/// SQLite schema.
///
/// Schema expected:
/// - `workflows` table (workflow-level status)
/// - `workflow_steps` table (step-level status, outputs, errors)
///
/// Additional columns added by migration:
/// - `workflow_steps.rust_status` — preserves the full 9-state Rust status
/// - `workflow_steps.retry_count` — number of retry attempts
/// - `workflow_steps.repair_count` — number of repair attempts
/// - `workflow_steps.last_error_json` — structured error as JSON
/// - `workflow_steps.attempts_json` — full attempt history as JSON
pub struct CatgoStateStore {
    conn: Mutex<Connection>,
}

impl CatgoStateStore {
    /// Open or create a CatGO-compatible SQLite database.
    pub fn open(path: &str) -> Result<Self, EngineError> {
        let conn = Connection::open(path).map_err(|e| EngineError::Storage {
            reason: format!("Failed to open database: {}", e),
        })?;

        // Enable WAL mode and set busy timeout for concurrent access with Python
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;")
            .map_err(|e| EngineError::Storage {
                reason: format!("Failed to set PRAGMAs: {}", e),
            })?;

        let store = Self {
            conn: Mutex::new(conn),
        };
        store.ensure_schema()?;
        Ok(store)
    }

    /// Run additive schema migration (safe to run multiple times).
    fn ensure_schema(&self) -> Result<(), EngineError> {
        let conn = self.conn.lock().map_err(|e| EngineError::Storage {
            reason: format!("Lock poisoned: {}", e),
        })?;

        // Add new columns to workflow_steps (IF NOT EXISTS via ALTER TABLE + ignore error)
        let migrations = [
            "ALTER TABLE workflow_steps ADD COLUMN rust_status TEXT DEFAULT 'pending'",
            "ALTER TABLE workflow_steps ADD COLUMN retry_count INTEGER DEFAULT 0",
            "ALTER TABLE workflow_steps ADD COLUMN repair_count INTEGER DEFAULT 0",
            "ALTER TABLE workflow_steps ADD COLUMN last_error_json TEXT DEFAULT NULL",
            "ALTER TABLE workflow_steps ADD COLUMN attempts_json TEXT DEFAULT '[]'",
            "ALTER TABLE workflow_steps ADD COLUMN started_at TEXT DEFAULT NULL",
            "ALTER TABLE workflow_steps ADD COLUMN finished_at TEXT DEFAULT NULL",
            "ALTER TABLE workflow_steps ADD COLUMN outputs_json TEXT DEFAULT NULL",
            "ALTER TABLE workflow_steps ADD COLUMN artifacts_json TEXT DEFAULT '[]'",
            // Also store graph run metadata
            "ALTER TABLE workflows ADD COLUMN rust_run_id TEXT DEFAULT NULL",
            "ALTER TABLE workflows ADD COLUMN rust_run_json TEXT DEFAULT NULL",
            // M2: subprocess tracking columns
            "ALTER TABLE workflows ADD COLUMN rust_engine_pid INTEGER DEFAULT NULL",
            "ALTER TABLE workflows ADD COLUMN engine_type TEXT DEFAULT 'python'",
        ];

        for sql in &migrations {
            // Ignore "duplicate column" errors (column already exists)
            let _ = conn.execute(sql, []);
        }

        Ok(())
    }

    /// Update a single workflow step in the Python-compatible table.
    fn write_node_to_steps(
        &self,
        conn: &Connection,
        workflow_id: &str,
        node: &NodeRun,
    ) -> Result<(), EngineError> {
        let python_status = rust_to_python_status(node.status);
        let rust_status = serde_json::to_string(&node.status).unwrap_or_default();
        let last_error_json = node
            .last_error
            .as_ref()
            .map(|e| serde_json::to_string(e).unwrap_or_default());
        let attempts_json = serde_json::to_string(&node.attempts).unwrap_or_default();
        let outputs_json = node
            .outputs
            .as_ref()
            .map(|o| serde_json::to_string(o).unwrap_or_default());
        let artifacts_json = serde_json::to_string(&node.artifacts).unwrap_or_default();
        let started_at = node.started_at.map(|t| t.to_rfc3339());
        let finished_at = node.finished_at.map(|t| t.to_rfc3339());

        conn.execute(
            "UPDATE workflow_steps SET
                status = ?1,
                rust_status = ?2,
                retry_count = ?3,
                repair_count = ?4,
                last_error_json = ?5,
                attempts_json = ?6,
                started_at = ?7,
                finished_at = ?8,
                outputs_json = ?9,
                artifacts_json = ?10
            WHERE workflow_id = ?11 AND id = ?12",
            params![
                python_status,
                rust_status,
                node.current_attempt,
                node.repair_count,
                last_error_json,
                attempts_json,
                started_at,
                finished_at,
                outputs_json,
                artifacts_json,
                workflow_id,
                node.node_id,
            ],
        )
        .map_err(|e| EngineError::Storage {
            reason: format!("Failed to update workflow_steps: {}", e),
        })?;

        Ok(())
    }

    /// Read a NodeRun from the workflow_steps table.
    #[allow(dead_code)]
    fn read_node_from_steps(
        &self,
        conn: &Connection,
        workflow_id: &str,
        step_id: &str,
    ) -> Result<Option<NodeRun>, EngineError> {
        let mut stmt = conn
            .prepare(
                "SELECT id, status, rust_status, retry_count, repair_count,
                        last_error_json, attempts_json, started_at, finished_at,
                        outputs_json, artifacts_json
                 FROM workflow_steps WHERE workflow_id = ?1 AND id = ?2",
            )
            .map_err(|e| EngineError::Storage {
                reason: format!("Failed to prepare query: {}", e),
            })?;

        let node = stmt
            .query_row(params![workflow_id, step_id], |row| {
                let node_id: String = row.get(0)?;
                let rust_status_str: Option<String> = row.get(2)?;
                let python_status: String = row.get(1)?;

                // Prefer rust_status if available, fall back to python status mapping
                let status = rust_status_str
                    .and_then(|s| serde_json::from_str::<NodeStatus>(&s).ok())
                    .unwrap_or_else(|| python_to_rust_status(&python_status));

                let retry_count: u32 = row.get::<_, Option<u32>>(3)?.unwrap_or(0);
                let repair_count: u32 = row.get::<_, Option<u32>>(4)?.unwrap_or(0);
                let last_error_json: Option<String> = row.get(5)?;
                let attempts_json: Option<String> = row.get(6)?;
                let started_at: Option<String> = row.get(7)?;
                let finished_at: Option<String> = row.get(8)?;
                let outputs_json: Option<String> = row.get(9)?;
                let artifacts_json: Option<String> = row.get(10)?;

                let last_error = last_error_json
                    .and_then(|s| serde_json::from_str::<StructuredError>(&s).ok());
                let attempts = attempts_json
                    .and_then(|s| serde_json::from_str::<Vec<NodeAttempt>>(&s).ok())
                    .unwrap_or_default();
                let outputs = outputs_json
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                let artifacts = artifacts_json
                    .and_then(|s| serde_json::from_str::<Vec<ArtifactRef>>(&s).ok())
                    .unwrap_or_default();

                let started = started_at.and_then(|s| {
                    chrono::DateTime::parse_from_rfc3339(&s)
                        .ok()
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                });
                let finished = finished_at.and_then(|s| {
                    chrono::DateTime::parse_from_rfc3339(&s)
                        .ok()
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                });

                Ok(NodeRun {
                    node_id,
                    status,
                    resolved_inputs: None,
                    outputs,
                    artifacts,
                    attempts,
                    current_attempt: retry_count,
                    repair_count,
                    started_at: started,
                    finished_at: finished,
                    last_error,
                })
            })
            .optional()
            .map_err(|e| EngineError::Storage {
                reason: format!("Failed to read step: {}", e),
            })?;

        Ok(node)
    }
}

impl StateStore for CatgoStateStore {
    fn save_graph_run(&self, run: &GraphRun) -> Result<(), EngineError> {
        let conn = self.conn.lock().map_err(|e| EngineError::Storage {
            reason: format!("Lock poisoned: {}", e),
        })?;

        let tx = conn.unchecked_transaction().map_err(|e| EngineError::Storage {
            reason: format!("Failed to begin transaction: {}", e),
        })?;

        // Update workflow-level status
        let workflow_status = rust_to_python_workflow_status(run.status);
        let run_json = serde_json::to_string(run).unwrap_or_default();

        tx.execute(
            "UPDATE workflows SET status = ?1, rust_run_id = ?2, rust_run_json = ?3
             WHERE id = ?4",
            params![workflow_status, run.id, run_json, run.template_id],
        )
        .map_err(|e| EngineError::Storage {
            reason: format!("Failed to update workflow status: {}", e),
        })?;

        // Update each node
        for node in &run.node_runs {
            self.write_node_to_steps(&tx, &run.template_id, node)?;
        }

        tx.commit().map_err(|e| EngineError::Storage {
            reason: format!("Failed to commit transaction: {}", e),
        })?;

        Ok(())
    }

    fn load_graph_run(&self, run_id: &str) -> Result<GraphRun, EngineError> {
        let conn = self.conn.lock().map_err(|e| EngineError::Storage {
            reason: format!("Lock poisoned: {}", e),
        })?;

        // Try to load from the rust_run_json column first (full fidelity)
        let run_json: Option<String> = conn
            .query_row(
                "SELECT rust_run_json FROM workflows WHERE rust_run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| EngineError::Storage {
                reason: format!("Failed to query workflow: {}", e),
            })?
            .flatten();

        if let Some(json) = run_json {
            if let Ok(run) = serde_json::from_str::<GraphRun>(&json) {
                return Ok(run);
            }
        }

        Err(EngineError::Storage {
            reason: format!("Graph run '{}' not found", run_id),
        })
    }

    fn update_node_run(&self, run_id: &str, node: &NodeRun) -> Result<(), EngineError> {
        let conn = self.conn.lock().map_err(|e| EngineError::Storage {
            reason: format!("Lock poisoned: {}", e),
        })?;

        // Find the workflow_id for this run
        let workflow_id: Option<String> = conn
            .query_row(
                "SELECT id FROM workflows WHERE rust_run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| EngineError::Storage {
                reason: format!("Failed to find workflow for run: {}", e),
            })?;

        let workflow_id = workflow_id.ok_or_else(|| EngineError::Storage {
            reason: format!("No workflow found for run '{}'", run_id),
        })?;

        self.write_node_to_steps(&conn, &workflow_id, node)?;

        // Also update the full run JSON
        let run_json: Option<String> = conn
            .query_row(
                "SELECT rust_run_json FROM workflows WHERE id = ?1",
                params![workflow_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| EngineError::Storage {
                reason: format!("Failed to read run JSON: {}", e),
            })?
            .flatten();

        if let Some(json) = run_json {
            if let Ok(mut run) = serde_json::from_str::<GraphRun>(&json) {
                if let Some(nr) = run.node_run_mut(&node.node_id) {
                    *nr = node.clone();
                }
                let updated_json = serde_json::to_string(&run).unwrap_or_default();
                conn.execute(
                    "UPDATE workflows SET rust_run_json = ?1 WHERE id = ?2",
                    params![updated_json, workflow_id],
                )
                .map_err(|e| EngineError::Storage {
                    reason: format!("Failed to update run JSON: {}", e),
                })?;
            }
        }

        Ok(())
    }

    fn list_graph_runs(&self) -> Result<Vec<GraphRun>, EngineError> {
        let conn = self.conn.lock().map_err(|e| EngineError::Storage {
            reason: format!("Lock poisoned: {}", e),
        })?;

        let mut stmt = conn
            .prepare("SELECT rust_run_json FROM workflows WHERE rust_run_json IS NOT NULL")
            .map_err(|e| EngineError::Storage {
                reason: format!("Failed to prepare list query: {}", e),
            })?;

        let runs = stmt
            .query_map([], |row| {
                let json: String = row.get(0)?;
                Ok(json)
            })
            .map_err(|e| EngineError::Storage {
                reason: format!("Failed to list runs: {}", e),
            })?
            .filter_map(|r| r.ok())
            .filter_map(|json| serde_json::from_str::<GraphRun>(&json).ok())
            .collect();

        Ok(runs)
    }

    fn delete_graph_run(&self, run_id: &str) -> Result<(), EngineError> {
        let conn = self.conn.lock().map_err(|e| EngineError::Storage {
            reason: format!("Lock poisoned: {}", e),
        })?;

        conn.execute(
            "UPDATE workflows SET rust_run_id = NULL, rust_run_json = NULL
             WHERE rust_run_id = ?1",
            params![run_id],
        )
        .map_err(|e| EngineError::Storage {
            reason: format!("Failed to delete run: {}", e),
        })?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rust_to_python_status_mapping() {
        assert_eq!(rust_to_python_status(NodeStatus::Pending), "pending");
        assert_eq!(rust_to_python_status(NodeStatus::Ready), "pending");
        assert_eq!(rust_to_python_status(NodeStatus::Running), "running");
        assert_eq!(rust_to_python_status(NodeStatus::Repairing), "running");
        assert_eq!(rust_to_python_status(NodeStatus::Succeeded), "completed");
        assert_eq!(rust_to_python_status(NodeStatus::Failed), "failed");
        assert_eq!(rust_to_python_status(NodeStatus::Blocked), "failed");
        assert_eq!(rust_to_python_status(NodeStatus::Skipped), "skipped");
        assert_eq!(rust_to_python_status(NodeStatus::Cancelled), "failed");
    }

    #[test]
    fn test_python_to_rust_status_mapping() {
        assert_eq!(python_to_rust_status("pending"), NodeStatus::Pending);
        assert_eq!(python_to_rust_status("queued"), NodeStatus::Pending);
        assert_eq!(python_to_rust_status("running"), NodeStatus::Running);
        assert_eq!(python_to_rust_status("completed"), NodeStatus::Succeeded);
        assert_eq!(python_to_rust_status("failed"), NodeStatus::Failed);
        assert_eq!(python_to_rust_status("skipped"), NodeStatus::Skipped);
        assert_eq!(python_to_rust_status("paused"), NodeStatus::Pending);
        assert_eq!(python_to_rust_status("unknown"), NodeStatus::Pending);
    }

    #[test]
    fn test_workflow_status_mapping() {
        assert_eq!(rust_to_python_workflow_status(GraphRunStatus::Created), "draft");
        assert_eq!(rust_to_python_workflow_status(GraphRunStatus::Running), "running");
        assert_eq!(rust_to_python_workflow_status(GraphRunStatus::Succeeded), "completed");
        assert_eq!(rust_to_python_workflow_status(GraphRunStatus::Failed), "failed");
        assert_eq!(rust_to_python_workflow_status(GraphRunStatus::Paused), "paused");
    }
}

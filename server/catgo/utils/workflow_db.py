"""SQLite database for workflow persistence."""

import asyncio
import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from catgo.models.workflow import (
    WorkflowCreate,
    WorkflowDetail,
    WorkflowStatus,
    WorkflowSummary,
    WorkflowTemplate,
    StepStatus,
)

DB_DIR = Path(__file__).parent.parent / "data"

# [2025-02] MERGED: workflow tables now live in the same SQLite file as ASE DB.
# Default fallback path for when no explicit DB is set.  On first run this will
# be the legacy "workflows.db"; once a user opens/creates a DB via the UI, both
# ASE results and workflow metadata share that single .db file.
#
# ROLLBACK: to revert to separate files, restore DB_PATH = DB_DIR / "workflows.db"
# and remove the set_active_wf_db_path(path) call in ase_db.set_active_db_path().
DB_PATH = DB_DIR / "catgo_results.db"

_active_wf_db_path: Optional[str] = None

_write_lock = threading.Lock()


def get_active_wf_db_path() -> str:
    """Return the current active workflows DB path."""
    return _active_wf_db_path or str(DB_PATH)


def set_active_wf_db_path(path: Optional[str]):
    """Switch the active workflows DB and ensure tables exist.
    Called by ase_db.set_active_db_path() to keep both in the same file."""
    global _active_wf_db_path
    _active_wf_db_path = path
    _ensure_db()  # create workflow tables in the target DB if needed


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_db():
    """Create database directory and tables if they don't exist."""
    db_path = get_active_wf_db_path()
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            ase_db_path TEXT,
            parent_id TEXT REFERENCES projects(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workflows (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            template_id TEXT,
            status TEXT DEFAULT 'draft',
            graph_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            metadata TEXT DEFAULT '{}',
            project_id TEXT REFERENCES projects(id),
            run_config_json TEXT DEFAULT '{}',
            engine_type TEXT DEFAULT 'python',
            rust_engine_pid INTEGER,
            rust_run_id TEXT
        );

        CREATE TABLE IF NOT EXISTS workflow_steps (
            id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
            node_type TEXT NOT NULL,
            label TEXT DEFAULT '',
            config_json TEXT DEFAULT '{}',
            status TEXT DEFAULT 'pending',
            hpc_job_id TEXT,
            hpc_session_id TEXT,
            ase_db_id INTEGER,
            input_ase_db_id INTEGER,
            result_json TEXT DEFAULT '{}',
            error_message TEXT,
            started_at TEXT,
            completed_at TEXT,
            work_dir TEXT,
            input_source TEXT
        );

        CREATE TABLE IF NOT EXISTS workflow_edges (
            id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
            source_step_id TEXT NOT NULL,
            target_step_id TEXT NOT NULL,
            edge_type TEXT DEFAULT 'sequential',
            condition_json TEXT DEFAULT '{}',
            source_handle TEXT,
            target_handle TEXT
        );

        CREATE TABLE IF NOT EXISTS workflow_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            category TEXT DEFAULT 'general',
            graph_json TEXT NOT NULL,
            metadata TEXT DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_steps_workflow ON workflow_steps(workflow_id);
        CREATE INDEX IF NOT EXISTS idx_steps_status ON workflow_steps(status);
        CREATE INDEX IF NOT EXISTS idx_edges_workflow ON workflow_edges(workflow_id);
    """)
    conn.commit()

    # Migrations: add columns that may be missing from older databases
    _migrate_add_column(conn, "workflows", "project_id", "TEXT REFERENCES projects(id)")
    _migrate_add_column(conn, "workflows", "run_config_json", "TEXT DEFAULT '{}'")
    _migrate_add_column(conn, "workflows", "engine_type", "TEXT DEFAULT 'python'")
    _migrate_add_column(conn, "workflows", "rust_engine_pid", "INTEGER")
    _migrate_add_column(conn, "workflows", "rust_run_id", "TEXT")
    _migrate_add_column(conn, "workflow_steps", "work_dir", "TEXT")
    _migrate_add_column(conn, "workflow_steps", "input_source", "TEXT")
    _migrate_add_column(conn, "workflow_steps", "hpc_host", "TEXT")
    _migrate_add_column(conn, "workflow_steps", "last_polled_at", "TEXT")
    _migrate_add_column(conn, "workflow_steps", "state_history", "TEXT DEFAULT '[]'")
    # Error classification: remote_error (SSH/network, retryable), compute_error (VASP/ORCA),
    # input_error (missing POTCAR etc., needs user intervention)
    _migrate_add_column(conn, "workflow_steps", "error_type", "TEXT")
    _migrate_add_column(conn, "workflow_steps", "retry_count", "INTEGER DEFAULT 0")
    _migrate_add_column(conn, "projects", "parent_id", "TEXT REFERENCES projects(id)")

    conn.close()


def _migrate_add_column(conn, table: str, column: str, col_type: str):
    """Add a column to a table if it doesn't already exist."""
    try:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
        conn.commit()
    except sqlite3.OperationalError:
        # Column already exists
        pass


# [2025-02] One-time migration: copy data from legacy workflows.db into catgo_results.db
# if the old file exists and the new one doesn't have workflow data yet.
_LEGACY_WF_PATH = DB_DIR / "workflows.db"


def _migrate_legacy_workflows_db():
    """Migrate projects/workflows from legacy separate workflows.db into the
    merged catgo_results.db.  Safe to call multiple times — skips if already done
    or if legacy file doesn't exist."""
    target_path = get_active_wf_db_path()
    if not _LEGACY_WF_PATH.exists():
        return
    if str(_LEGACY_WF_PATH.resolve()) == str(Path(target_path).resolve()):
        return  # same file, nothing to migrate

    target_conn = sqlite3.connect(target_path)
    # Check if target already has project data (skip if so)
    try:
        count = target_conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        if count > 0:
            target_conn.close()
            return  # already has data, skip
    except sqlite3.OperationalError:
        pass  # table doesn't exist yet, will be created by _ensure_db

    target_conn.close()

    # Attach legacy DB and copy using explicit column names
    # (column order may differ between CREATE TABLE and ALTER TABLE ADD COLUMN)
    conn = sqlite3.connect(target_path)
    try:
        conn.execute("ATTACH DATABASE ? AS legacy", (str(_LEGACY_WF_PATH),))
        tables = ["projects", "workflows", "workflow_steps", "workflow_edges", "workflow_templates"]
        for table in tables:
            try:
                target_cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
                legacy_cols = [r[1] for r in conn.execute(f"PRAGMA legacy.table_info({table})").fetchall()]
                common = [c for c in target_cols if c in legacy_cols]
                cols_str = ", ".join(common)
                conn.execute(f"INSERT OR IGNORE INTO {table} ({cols_str}) SELECT {cols_str} FROM legacy.{table}")
            except sqlite3.OperationalError:
                pass  # table doesn't exist in legacy
        conn.commit()
        conn.execute("DETACH DATABASE legacy")
        # Rename legacy file to .bak so migration doesn't repeat
        _LEGACY_WF_PATH.rename(_LEGACY_WF_PATH.with_suffix(".db.bak"))
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Legacy migration failed: %s", e)
    finally:
        conn.close()


# Initialize on import
_ensure_db()
_migrate_legacy_workflows_db()


@contextmanager
def get_db():
    """Get a database connection with row factory."""
    conn = sqlite3.connect(get_active_wf_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    try:
        yield conn
    finally:
        conn.close()


def create_workflow(data: WorkflowCreate) -> WorkflowDetail:
    """Create a new workflow. If data.id is provided and already exists, update it instead."""
    wf_id = data.id or str(uuid.uuid4())
    now = _now()
    with _write_lock:
        with get_db() as conn:
            # Check if workflow with this ID already exists (Tauri/Desktop sync case)
            existing = conn.execute("SELECT id FROM workflows WHERE id = ?", (wf_id,)).fetchone()
            if existing:
                conn.execute(
                    """UPDATE workflows SET name = ?, description = ?, graph_json = ?, updated_at = ?,
                       project_id = COALESCE(?, project_id)
                       WHERE id = ?""",
                    (data.name, data.description, data.graph_json, now, getattr(data, 'project_id', None), wf_id),
                )
            else:
                conn.execute(
                    """INSERT INTO workflows (id, name, description, template_id, status, graph_json, project_id, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)""",
                    (wf_id, data.name, data.description, data.template_id, data.graph_json,
                     getattr(data, 'project_id', None), now, now),
                )
            _sync_steps_from_graph(conn, wf_id, data.graph_json)
            conn.commit()
    return get_workflow(wf_id)


def list_workflows() -> list[WorkflowSummary]:
    """List all workflows with step counts."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT w.*,
                      (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
                      (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status IN ('completed', 'not_converged')) as completed_steps
               FROM workflows w ORDER BY w.updated_at DESC"""
        ).fetchall()
        return [
            WorkflowSummary(
                id=r["id"],
                name=r["name"],
                description=r["description"],
                status=WorkflowStatus(r["status"]),
                template_id=r["template_id"],
                project_id=dict(r).get("project_id"),
                created_at=r["created_at"],
                updated_at=r["updated_at"],
                step_count=r["step_count"],
                completed_steps=r["completed_steps"],
            )
            for r in rows
        ]


def get_workflow(wf_id: str) -> WorkflowDetail:
    """Get a single workflow with all details."""
    with get_db() as conn:
        r = conn.execute("SELECT * FROM workflows WHERE id = ?", (wf_id,)).fetchone()
        if not r:
            raise KeyError(f"Workflow {wf_id} not found")
        step_count = conn.execute(
            "SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = ?", (wf_id,)
        ).fetchone()[0]
        completed = conn.execute(
            "SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = ? AND status IN ('completed', 'not_converged')",
            (wf_id,),
        ).fetchone()[0]
        return WorkflowDetail(
            id=r["id"],
            name=r["name"],
            description=r["description"],
            status=WorkflowStatus(r["status"]),
            template_id=r["template_id"],
            created_at=r["created_at"],
            updated_at=r["updated_at"],
            graph_json=r["graph_json"],
            metadata=r["metadata"],
            step_count=step_count,
            completed_steps=completed,
        )


def update_workflow(wf_id: str, data: dict) -> WorkflowDetail:
    """Update workflow fields."""
    with _write_lock:
        with get_db() as conn:
            sets = []
            vals = []
            for key in ("name", "description", "status", "metadata"):
                if key in data and data[key] is not None:
                    sets.append(f"{key} = ?")
                    vals.append(data[key])
            if "graph_json" in data and data["graph_json"] is not None:
                sets.append("graph_json = ?")
                vals.append(data["graph_json"])
                _sync_steps_from_graph(conn, wf_id, data["graph_json"])
            if sets:
                sets.append("updated_at = ?")
                vals.append(_now())
                vals.append(wf_id)
                conn.execute(f"UPDATE workflows SET {', '.join(sets)} WHERE id = ?", vals)
                conn.commit()
    return get_workflow(wf_id)


def delete_workflow(wf_id: str):
    """Delete a workflow and all related data."""
    with _write_lock:
        with get_db() as conn:
            conn.execute("DELETE FROM workflow_edges WHERE workflow_id = ?", (wf_id,))
            conn.execute("DELETE FROM workflow_steps WHERE workflow_id = ?", (wf_id,))
            conn.execute("DELETE FROM workflows WHERE id = ?", (wf_id,))
            conn.commit()


def update_step(wf_id: str, step_id: str, data: dict) -> dict:
    """Update a workflow step, auto-appending to state_history if status changes.

    Args:
        wf_id: Workflow ID.
        step_id: Step ID within the workflow.
        data: Dict of fields to update. Recognized keys include status,
              hpc_job_id, result_json, error_message, etc.

    Returns:
        The updated step row as a dict.
    """
    with _write_lock:
        with get_db() as conn:
            sets = []
            vals = []
            for key in ("config_json", "status", "hpc_job_id", "hpc_session_id",
                        "hpc_host", "result_json", "error_message", "ase_db_id",
                        "input_ase_db_id", "work_dir", "input_source", "last_polled_at",
                        "error_type", "retry_count"):
                if key in data:
                    if data[key] is None:
                        sets.append(f"{key} = NULL")
                    else:
                        sets.append(f"{key} = ?")
                        vals.append(data[key])
            # Auto-append to state_history when status changes (audit trail)
            if "status" in data:
                row = conn.execute(
                    "SELECT status, state_history FROM workflow_steps WHERE id = ? AND workflow_id = ?",
                    (step_id, wf_id),
                ).fetchone()
                if row and row["status"] != data["status"]:
                    history = json.loads(row["state_history"] or "[]")
                    history.append({
                        "state": data["status"],
                        "created_on": _now(),
                    })
                    sets.append("state_history = ?")
                    vals.append(json.dumps(history))

                if data["status"] == "running":
                    sets.append("started_at = ?")
                    vals.append(_now())
                    # Clear stale completed_at from previous runs
                    sets.append("completed_at = NULL")
                elif data["status"] in ("completed", "failed"):
                    sets.append("completed_at = ?")
                    vals.append(_now())
            if sets:
                vals.extend([step_id, wf_id])
                conn.execute(
                    f"UPDATE workflow_steps SET {', '.join(sets)} WHERE id = ? AND workflow_id = ?",
                    vals,
                )
                conn.execute(
                    "UPDATE workflows SET updated_at = ? WHERE id = ?", (_now(), wf_id)
                )
                conn.commit()
            row = conn.execute(
                "SELECT * FROM workflow_steps WHERE id = ? AND workflow_id = ?",
                (step_id, wf_id),
            ).fetchone()
            if not row:
                raise KeyError(f"Step {step_id} not found in workflow {wf_id}")
            return dict(row)


def get_step_status(wf_id: str, step_id: str) -> dict:
    """Get status of a single step."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, node_type, config_json, status, hpc_job_id, hpc_session_id, work_dir, result_json, error_message, started_at, completed_at FROM workflow_steps WHERE id = ? AND workflow_id = ?",
            (step_id, wf_id),
        ).fetchone()
        if not row:
            raise KeyError(f"Step {step_id} not found")
        return dict(row)


def reset_step_and_descendants(workflow_id: str, step_id: str) -> list[str]:
    """Reset a step and all its downstream dependents to pending.

    Uses BFS on the workflow DAG edges to find all successor nodes,
    then batch-resets them. This enables "rerun from here" functionality
    where a failed node and everything downstream gets re-executed.

    Args:
        workflow_id: Workflow ID.
        step_id: The root step to reset (also resets all downstream).

    Returns:
        List of reset node IDs (including the root step).
    """
    from collections import deque

    with _write_lock:
        with get_db() as conn:
            # Build adjacency list from workflow edges
            edges = conn.execute(
                "SELECT source_step_id, target_step_id FROM workflow_edges WHERE workflow_id = ?",
                (workflow_id,),
            ).fetchall()

            adj: dict[str, list[str]] = {}
            for row in edges:
                adj.setdefault(row["source_step_id"], []).append(row["target_step_id"])

            # BFS to find all downstream nodes (including the start node)
            to_reset: set[str] = set()
            queue = deque([step_id])
            while queue:
                nid = queue.popleft()
                if nid in to_reset:
                    continue
                to_reset.add(nid)
                queue.extend(adj.get(nid, []))

            if not to_reset:
                return []

            # Batch reset: clear results, errors, and timestamps
            ids = list(to_reset)
            placeholders = ",".join("?" * len(ids))
            conn.execute(f"""
                UPDATE workflow_steps
                SET status = 'pending', result_json = '{{}}',
                    error_message = NULL, error_type = NULL,
                    retry_count = 0,
                    started_at = NULL, completed_at = NULL
                WHERE workflow_id = ? AND id IN ({placeholders})
            """, [workflow_id, *ids])
            conn.commit()

    return ids


def reset_all_steps(workflow_id: str) -> int:
    """Reset ALL steps in a workflow to pending.

    Clears results, errors, timestamps, and job IDs for every step.
    Used by the frontend "Reset" button to start fresh.

    Returns number of steps reset.
    """
    with _write_lock:
        with get_db() as conn:
            result = conn.execute("""
                UPDATE workflow_steps
                SET status = 'pending', result_json = '{}',
                    error_message = NULL, error_type = NULL,
                    retry_count = 0,
                    started_at = NULL, completed_at = NULL
                WHERE workflow_id = ?
            """, (workflow_id,))
            conn.execute(
                "UPDATE workflows SET status = 'draft', updated_at = ? WHERE id = ?",
                (_now(), workflow_id),
            )
            conn.commit()
            return result.rowcount


# --- Execution helpers ---

def update_step_work_dir(wf_id: str, step_id: str, work_dir: str):
    """Set the remote work directory for a step."""
    with _write_lock:
        with get_db() as conn:
            conn.execute(
                "UPDATE workflow_steps SET work_dir = ? WHERE id = ? AND workflow_id = ?",
                (work_dir, step_id, wf_id),
            )
            conn.commit()


def list_steps(wf_id: str) -> list[dict]:
    """List all steps for a workflow with full details."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY started_at NULLS LAST",
            (wf_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def update_workflow_run_config(wf_id: str, config_json: str):
    """Store the run configuration for a workflow."""
    with _write_lock:
        with get_db() as conn:
            conn.execute(
                "UPDATE workflows SET run_config_json = ?, updated_at = ? WHERE id = ?",
                (config_json, _now(), wf_id),
            )
            conn.commit()


# --- Project management ---

def create_project(name: str, description: str = "", parent_id: Optional[str] = None) -> dict:
    """Create a new project (optionally nested under parent_id)."""
    proj_id = str(uuid.uuid4())
    now = _now()
    with _write_lock:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO projects (id, name, description, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (proj_id, name, description, parent_id, now, now),
            )
            conn.commit()
    return get_project(proj_id)


def get_project(proj_id: str) -> dict:
    """Get a project by ID, including full workflows array."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (proj_id,)).fetchone()
        if not row:
            raise KeyError(f"Project {proj_id} not found")
        result = dict(row)
        # Include full workflows array (for ProjectDetail type compatibility)
        wf_rows = conn.execute(
            """SELECT w.id, w.name, w.status,
                      (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
                      (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status IN ('completed', 'not_converged')) as completed_steps,
                      w.created_at
               FROM workflows w WHERE w.project_id = ? ORDER BY w.updated_at DESC""",
            (proj_id,),
        ).fetchall()
        result["workflows"] = [dict(r) for r in wf_rows]
        result["workflow_count"] = len(result["workflows"])
        return result


def list_projects() -> list[dict]:
    """List all projects."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT p.*,
                      (SELECT COUNT(*) FROM workflows WHERE project_id = p.id) as workflow_count
               FROM projects p ORDER BY p.updated_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def update_project(proj_id: str, data: dict) -> dict:
    """Update a project.

    Supports 'name', 'description', and 'parent_id'.
    Use parent_id=None with 'parent_id' key present to move to root level.
    """
    with _write_lock:
        with get_db() as conn:
            sets = []
            vals = []
            for key in ("name", "description"):
                if key in data and data[key] is not None:
                    sets.append(f"{key} = ?")
                    vals.append(data[key])
            # parent_id: explicitly handle None (move to root)
            if "parent_id" in data:
                sets.append("parent_id = ?")
                vals.append(data["parent_id"])  # can be None
            if sets:
                sets.append("updated_at = ?")
                vals.append(_now())
                vals.append(proj_id)
                conn.execute(f"UPDATE projects SET {', '.join(sets)} WHERE id = ?", vals)
                conn.commit()
    return get_project(proj_id)


def delete_project(proj_id: str):
    """Delete a project, its sub-projects, and dissociate workflows."""
    with _write_lock:
        with get_db() as conn:
            # Collect all descendant project IDs (recursive)
            ids_to_delete = [proj_id]
            queue = [proj_id]
            while queue:
                pid = queue.pop()
                children = [r[0] for r in conn.execute(
                    "SELECT id FROM projects WHERE parent_id = ?", (pid,)
                ).fetchall()]
                ids_to_delete.extend(children)
                queue.extend(children)

            placeholders = ",".join("?" * len(ids_to_delete))
            # Un-assign workflows
            conn.execute(
                f"UPDATE workflows SET project_id = NULL WHERE project_id IN ({placeholders})",
                ids_to_delete,
            )
            # Delete all projects in the subtree
            conn.execute(
                f"DELETE FROM projects WHERE id IN ({placeholders})",
                ids_to_delete,
            )
            conn.commit()


def assign_workflow_to_project(wf_id: str, project_id: Optional[str]):
    """Assign or unassign a workflow to/from a project."""
    with _write_lock:
        with get_db() as conn:
            conn.execute(
                "UPDATE workflows SET project_id = ?, updated_at = ? WHERE id = ?",
                (project_id, _now(), wf_id),
            )
            conn.commit()


# --- Templates ---

def list_templates() -> list[WorkflowTemplate]:
    """List all workflow templates."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM workflow_templates ORDER BY category, name").fetchall()
        return [WorkflowTemplate(**dict(r)) for r in rows]


def get_template(template_id: str) -> WorkflowTemplate:
    """Get a single template."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM workflow_templates WHERE id = ?", (template_id,)).fetchone()
        if not row:
            raise KeyError(f"Template {template_id} not found")
        return WorkflowTemplate(**dict(row))


def create_from_template(template_id: str, name: str) -> WorkflowDetail:
    """Create a new workflow from a template."""
    template = get_template(template_id)
    return create_workflow(
        WorkflowCreate(
            name=name,
            description=f"Created from template: {template.name}",
            template_id=template_id,
            graph_json=template.graph_json,
        )
    )


def upsert_template(template: WorkflowTemplate):
    """Insert or update a template."""
    with _write_lock:
        with get_db() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO workflow_templates (id, name, description, category, graph_json, metadata)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (template.id, template.name, template.description, template.category, template.graph_json, template.metadata),
            )
            conn.commit()


# --- Internal helpers ---

def _sync_steps_from_graph(conn: sqlite3.Connection, wf_id: str, graph_json: str):
    """Sync workflow_steps and workflow_edges tables from Svelte Flow graph JSON."""
    try:
        graph = json.loads(graph_json)
    except (json.JSONDecodeError, TypeError):
        return

    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    existing = {}
    for row in conn.execute(
        "SELECT id, status, config_json, result_json, hpc_job_id, error_message FROM workflow_steps WHERE workflow_id = ?",
        (wf_id,),
    ).fetchall():
        existing[row["id"]] = dict(row)

    node_ids = {n["id"] for n in nodes}

    # Remove steps no longer in graph
    for old_id in set(existing.keys()) - node_ids:
        conn.execute("DELETE FROM workflow_steps WHERE id = ? AND workflow_id = ?", (old_id, wf_id))

    # Upsert steps
    for node in nodes:
        nid = node["id"]
        ntype = node.get("type", "unknown")
        # Support both Svelte Flow format (data.label/data.config) and our format (params)
        label = node.get("data", {}).get("label", ntype) if "data" in node else ntype
        raw_config = node.get("data", {}).get("config", {}) if "data" in node else node.get("params", {})
        config = json.dumps(raw_config)
        if nid in existing:
            old = existing[nid]
            if old["status"] in ("pending", "draft"):
                conn.execute(
                    "UPDATE workflow_steps SET label = ?, config_json = ?, node_type = ? WHERE id = ? AND workflow_id = ?",
                    (label, config, ntype, nid, wf_id),
                )
        else:
            conn.execute(
                """INSERT OR REPLACE INTO workflow_steps (id, workflow_id, node_type, label, config_json)
                   VALUES (?, ?, ?, ?, ?)""",
                (nid, wf_id, ntype, label, config),
            )

    # Replace edges (support both Svelte Flow format and our format)
    conn.execute("DELETE FROM workflow_edges WHERE workflow_id = ?", (wf_id,))
    for edge in edges:
        # Our format uses from/to, Svelte Flow uses source/target
        source = edge.get("source") or edge.get("from", "")
        target = edge.get("target") or edge.get("to", "")
        src_handle = edge.get("sourceHandle") or edge.get("fromHandle", "")
        tgt_handle = edge.get("targetHandle") or edge.get("toHandle", "")
        conn.execute(
            """INSERT OR REPLACE INTO workflow_edges (id, workflow_id, source_step_id, target_step_id, edge_type, source_handle, target_handle)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                edge.get("id", str(uuid.uuid4())),
                wf_id,
                source,
                target,
                edge.get("type", "sequential"),
                src_handle,
                tgt_handle,
            ),
        )


# --- Async wrappers for critical operations ---
# These wrap blocking database calls with asyncio.to_thread() to prevent
# the event loop from blocking when the _write_lock is contended.
# Used in workflow_engine.py's async functions to avoid freezing the server.


async def async_update_step(wf_id: str, step_id: str, data: dict) -> dict:
    """Async wrapper for update_step(). Offloads DB I/O to thread pool."""
    return await asyncio.to_thread(update_step, wf_id, step_id, data)


async def async_get_workflow(wf_id: str) -> WorkflowDetail:
    """Async wrapper for get_workflow(). Offloads DB I/O to thread pool."""
    return await asyncio.to_thread(get_workflow, wf_id)


async def async_update_workflow(wf_id: str, data: dict) -> WorkflowDetail:
    """Async wrapper for update_workflow(). Offloads DB I/O to thread pool."""
    return await asyncio.to_thread(update_workflow, wf_id, data)


async def async_update_step_work_dir(wf_id: str, step_id: str, work_dir: str) -> None:
    """Async wrapper for update_step_work_dir(). Offloads DB I/O to thread pool."""
    return await asyncio.to_thread(update_step_work_dir, wf_id, step_id, work_dir)


async def async_update_workflow_run_config(wf_id: str, config_json: str) -> None:
    """Async wrapper for update_workflow_run_config(). Offloads DB I/O to thread pool."""
    return await asyncio.to_thread(update_workflow_run_config, wf_id, config_json)


async def async_count_failed_steps(wf_id: str) -> int:
    """Async wrapper to count failed steps. Offloads DB I/O to thread pool."""
    def _count():
        with get_db() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = ? AND status = 'failed'",
                (wf_id,),
            ).fetchone()[0]
    return await asyncio.to_thread(_count)


async def async_list_steps(wf_id: str) -> list[dict]:
    """Async wrapper for list_steps(). Offloads DB I/O to thread pool."""
    return await asyncio.to_thread(list_steps, wf_id)

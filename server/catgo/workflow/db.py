"""SQLite database for workflow state persistence."""

from __future__ import annotations
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_id() -> str:
    return uuid.uuid4().hex[:16]


class _PooledConn:
    """Proxy over a sqlite3.Connection whose close() is a no-op.

    WorkflowDB caches one real connection per thread via threading.local,
    and hands out this proxy so existing callers can keep their
    ``conn = self._get_conn(); ...; conn.close()`` pattern unchanged.
    The real connection lives for the lifetime of the thread.
    """

    __slots__ = ("_conn",)

    def __init__(self, conn: sqlite3.Connection) -> None:
        object.__setattr__(self, "_conn", conn)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._conn, name)

    def close(self) -> None:  # noqa: D401 — kept as a no-op
        """No-op: the connection stays in the per-thread pool."""
        return None

    def __enter__(self):
        return self._conn.__enter__()

    def __exit__(self, *args):
        return self._conn.__exit__(*args)


class WorkflowDB:
    """Thread-safe SQLite wrapper for CatGo workflow data.

    Each thread gets its own persistent sqlite3 connection, cached on a
    ``threading.local``. This amortises the per-call ``sqlite3.connect`` +
    PRAGMA cost and satisfies SQLite's ``check_same_thread`` requirement
    without forcing every caller to manage connection lifetime.
    """

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._tls = threading.local()
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        conn = getattr(self._tls, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.db_path, timeout=10)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=5000")
            self._tls.conn = conn
        return _PooledConn(conn)

    def _init_db(self):
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        # Run migration FIRST so v2_ tables get renamed before CREATE TABLE IF NOT EXISTS
        self._migrate_db()
        with self._lock:
            conn = self._get_conn()
            conn.executescript(_SCHEMA_SQL)
            conn.commit()
            conn.close()

    @classmethod
    def from_config(cls, config: dict) -> "WorkflowDB":
        """Create a WorkflowDB from a config dict.

        Reads ``config["paths"]["db_path"]``, defaulting to ``~/.catgo/catgo.db``.
        """
        path = config.get("paths", {}).get("db_path", "~/.catgo/catgo.db")
        return cls(str(Path(path).expanduser()))

    def _migrate_db(self):
        """Add new columns to existing databases and rename legacy tables."""
        conn = self._get_conn()
        # Migration: rename v2_ tables to unprefixed
        for old, new in [("v2_workflows", "workflows"), ("v2_tasks", "tasks"),
                          ("v2_task_links", "task_links"), ("v2_task_results", "task_results"),
                          ("v2_provenance", "provenance")]:
            # Check if old table exists and new doesn't
            exists = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (old,)
            ).fetchone()
            if exists:
                new_exists = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (new,)
                ).fetchone()
                if new_exists:
                    # Both exist — drop the new (empty) one, keep the old (with data)
                    conn.execute(f"DROP TABLE {new}")
                conn.execute(f"ALTER TABLE {old} RENAME TO {new}")
                conn.commit()
        for col, type_ in [
            ("parent_task_id", "TEXT"),
            ("map_key", "TEXT"),
            ("task_group", "TEXT"),
            ("condition_json", "TEXT"),
            ("node_id", "TEXT"),
        ]:
            try:
                conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {type_}")
            except Exception:
                pass  # column already exists
        # Back-fill node_id for pre-namespacing rows (id was the bare node id).
        try:
            conn.execute("UPDATE tasks SET node_id = id WHERE node_id IS NULL")
        except Exception:
            pass
        # Add link_type to task_links
        try:
            conn.execute("ALTER TABLE task_links ADD COLUMN link_type TEXT DEFAULT 'data'")
        except Exception:
            pass
        # Add project_id to workflows
        try:
            conn.execute("ALTER TABLE workflows ADD COLUMN project_id TEXT")
        except Exception:
            pass
        # task_results: add columns referenced by query_task_results
        # (convergence_json, created_at). task_type / status live on `tasks`
        # and are JOINed in. ALTER cannot reuse the CREATE TABLE's
        # `DEFAULT (datetime('now'))` for existing rows — they remain NULL;
        # backfilled below so ORDER BY behaves.
        for col, type_ in [
            ("convergence_json", "TEXT"),
            ("created_at", "TEXT"),
        ]:
            try:
                conn.execute(f"ALTER TABLE task_results ADD COLUMN {col} {type_}")
            except Exception:
                pass  # column already exists
        try:
            conn.execute("UPDATE task_results SET created_at = datetime('now') WHERE created_at IS NULL")
        except Exception:
            pass
        # Migrate task_links: add ON DELETE CASCADE to FKs (SQLite requires table recreation)
        try:
            # Check if task_links exists and lacks CASCADE
            fk_info = conn.execute("PRAGMA foreign_key_list(task_links)").fetchall()
            needs_migrate = any(
                dict(row).get("on_delete", "NO ACTION") != "CASCADE"
                for row in fk_info
            ) if fk_info else False
            if needs_migrate:
                conn.execute("PRAGMA foreign_keys=OFF")
                conn.execute("""CREATE TABLE IF NOT EXISTS task_links_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workflow_id TEXT NOT NULL,
                    source_task_id TEXT NOT NULL,
                    target_task_id TEXT NOT NULL,
                    source_key TEXT NOT NULL,
                    target_key TEXT NOT NULL,
                    link_type TEXT DEFAULT 'data',
                    FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                    FOREIGN KEY (target_task_id) REFERENCES tasks(id) ON DELETE CASCADE
                )""")
                conn.execute("INSERT INTO task_links_new SELECT * FROM task_links")
                conn.execute("DROP TABLE task_links")
                conn.execute("ALTER TABLE task_links_new RENAME TO task_links")
                conn.execute("PRAGMA foreign_keys=ON")
                conn.commit()
        except Exception:
            pass  # Fresh DB or already migrated
        conn.commit()
        conn.close()

    # --- Workflows ---

    def create_workflow(self, name: str, config: dict | None = None,
                        graph_json: str | None = None,
                        workflow_id: str | None = None) -> str:
        wf_id = workflow_id or _generate_id()
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                "INSERT OR REPLACE INTO workflows (id, name, status, created_at, updated_at, config_json, graph_json) VALUES (?, ?, 'draft', ?, ?, ?, ?)",
                (wf_id, name, _now(), _now(), json.dumps(config or {}), graph_json),
            )
            conn.commit()
            conn.close()
        return wf_id

    def get_workflow(self, wf_id: str) -> dict:
        conn = self._get_conn()
        row = conn.execute("SELECT * FROM workflows WHERE id = ?", (wf_id,)).fetchone()
        conn.close()
        if not row:
            raise KeyError(f"Workflow {wf_id} not found")
        return dict(row)

    def update_workflow(self, wf_id: str, **fields) -> None:
        fields["updated_at"] = _now()
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [wf_id]
        with self._lock:
            conn = self._get_conn()
            conn.execute(f"UPDATE workflows SET {sets} WHERE id = ?", vals)
            conn.commit()
            conn.close()

    def list_workflows(self) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute("SELECT * FROM workflows ORDER BY created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def assign_project(self, wf_id: str, project_id: str | None) -> None:
        """Assign or unassign an engine workflow to/from a project."""
        self.update_workflow(wf_id, project_id=project_id)

    def list_workflows_for_project(self, project_id: str) -> list[dict]:
        """List engine workflows assigned to a specific project."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # --- Tasks ---

    def create_task(
        self, workflow_id: str, task_type: str, *,
        task_id: str | None = None,
        node_id: str | None = None,
        name: str | None = None, params: dict | None = None,
        software: str | None = None, system_name: str | None = None,
    ) -> str:
        task_id = task_id or _generate_id()
        if node_id is None:
            node_id = task_id
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                """INSERT OR REPLACE INTO tasks
                   (id, workflow_id, node_id, task_type, name, status, params_json, software, system_name, created_at)
                   VALUES (?, ?, ?, ?, ?, 'WAITING', ?, ?, ?, ?)""",
                (task_id, workflow_id, node_id, task_type, name, json.dumps(params or {}),
                 software, system_name, _now()),
            )
            conn.commit()
            conn.close()
        return task_id

    def get_task(self, task_id: str) -> dict:
        conn = self._get_conn()
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        conn.close()
        if not row:
            raise KeyError(f"Task {task_id} not found")
        return dict(row)

    def delete_workflow_tasks_and_links(self, workflow_id: str) -> None:
        """Remove all tasks and links for a workflow (used before graph recreation)."""
        with self._lock:
            conn = self._get_conn()
            conn.execute("DELETE FROM task_links WHERE workflow_id = ?", (workflow_id,))
            conn.execute("DELETE FROM tasks WHERE workflow_id = ?", (workflow_id,))
            conn.commit()
            conn.close()

    def update_task(self, task_id: str, **fields) -> None:
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [task_id]
        with self._lock:
            conn = self._get_conn()
            conn.execute(f"UPDATE tasks SET {sets} WHERE id = ?", vals)
            conn.commit()
            conn.close()

    def get_tasks_by_status(self, workflow_id: str, status: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM tasks WHERE workflow_id = ? AND status = ?",
            (workflow_id, status),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_all_tasks(self, workflow_id: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at",
            (workflow_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_children_of(self, parent_task_id: str) -> list[dict]:
        """Get all child tasks of a parent (map/zone/while) task."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY map_key",
            (parent_task_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def clear_workflow_graph(self, workflow_id: str) -> None:
        """Delete all tasks and links for a workflow (used before re-creating from graph_json)."""
        with self._lock:
            conn = self._get_conn()
            conn.execute("DELETE FROM task_links WHERE workflow_id = ?", (workflow_id,))
            conn.execute("DELETE FROM tasks WHERE workflow_id = ?", (workflow_id,))
            conn.commit()
            conn.close()

    # --- Links ---

    def create_link(
        self, workflow_id: str,
        source_task_id: str, target_task_id: str,
        source_key: str, target_key: str,
    ) -> None:
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                """INSERT OR REPLACE INTO task_links
                   (workflow_id, source_task_id, target_task_id, source_key, target_key)
                   VALUES (?, ?, ?, ?, ?)""",
                (workflow_id, source_task_id, target_task_id, source_key, target_key),
            )
            conn.commit()
            conn.close()

    def get_task_parents(self, task_id: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM task_links WHERE target_task_id = ?", (task_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_task_children(self, task_id: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM task_links WHERE source_task_id = ?", (task_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # --- Results ---

    def store_result(self, task_id: str, workflow_id: str, **fields) -> None:
        cols = ["task_id", "workflow_id"] + list(fields.keys())
        placeholders = ", ".join(["?"] * len(cols))
        col_names = ", ".join(cols)
        vals = [task_id, workflow_id] + list(fields.values())
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                f"INSERT OR REPLACE INTO task_results ({col_names}) VALUES ({placeholders})",
                vals,
            )
            conn.commit()
            conn.close()

    def get_result(self, task_id: str) -> dict | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM task_results WHERE task_id = ?", (task_id,),
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    # --- Map children ---

    def get_children_of(self, parent_task_id: str) -> list[dict]:
        """Get child tasks of a map/zone/while controller task."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY map_key",
            (parent_task_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # --- DAG ---

    def get_dag(self, workflow_id: str) -> dict:
        return {
            "tasks": self.get_all_tasks(workflow_id),
            "links": self._get_all_links(workflow_id),
        }

    def _get_all_links(self, workflow_id: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM task_links WHERE workflow_id = ?", (workflow_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # --- Provenance ---

    def record_provenance(self, **fields) -> None:
        """Insert a provenance record."""
        fields.setdefault("created_at", _now())
        cols = list(fields.keys())
        placeholders = ", ".join(["?"] * len(cols))
        col_names = ", ".join(cols)
        vals = list(fields.values())
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                f"INSERT INTO provenance ({col_names}) VALUES ({placeholders})",
                vals,
            )
            conn.commit()
            conn.close()

    def get_provenance(self, task_id: str, output_key: str | None = None) -> list[dict]:
        """Get provenance records for a task, optionally filtered by output_key."""
        conn = self._get_conn()
        if output_key:
            rows = conn.execute(
                "SELECT * FROM provenance WHERE task_id = ? AND output_key = ?",
                (task_id, output_key),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM provenance WHERE task_id = ?", (task_id,),
            ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def find_provenance_by_hash(self, value_hash: str) -> list[dict]:
        """Find provenance records that produced a given value hash."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM provenance WHERE value_hash = ?", (value_hash,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # --- HPC Sessions ---

    def save_hpc_session(
        self,
        session_id: str,
        host: str,
        username: str,
        port: int = 22,
        auth_method: str = "ssh_config",
        ssh_alias: str | None = None,
        key_file: str | None = None,
        scheduler: str = "slurm",
    ) -> None:
        """Persist an HPC session config for auto-reconnect after restart."""
        now = _now()
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                """INSERT OR REPLACE INTO hpc_sessions
                   (session_id, host, username, port, auth_method, ssh_alias,
                    key_file, scheduler, connected_at, last_used)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (session_id, host, username, port, auth_method, ssh_alias,
                 key_file, scheduler, now, now),
            )
            conn.commit()
            conn.close()

    def get_hpc_sessions(self) -> list[dict]:
        """Get all persisted HPC session configs."""
        conn = self._get_conn()
        rows = conn.execute("SELECT * FROM hpc_sessions").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def delete_hpc_session(self, session_id: str) -> None:
        """Remove a persisted HPC session."""
        with self._lock:
            conn = self._get_conn()
            conn.execute("DELETE FROM hpc_sessions WHERE session_id = ?", (session_id,))
            conn.commit()
            conn.close()

    def update_hpc_session_last_used(self, session_id: str) -> None:
        """Update the last_used timestamp for an HPC session."""
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                "UPDATE hpc_sessions SET last_used = ? WHERE session_id = ?",
                (_now(), session_id),
            )
            conn.commit()
            conn.close()


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    created_at TEXT,
    updated_at TEXT,
    config_json TEXT DEFAULT '{}',
    graph_json TEXT,
    project_id TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    node_id TEXT,
    task_type TEXT NOT NULL,
    name TEXT,
    status TEXT DEFAULT 'WAITING',
    params_json TEXT DEFAULT '{}',
    hpc_session_id TEXT,
    hpc_job_id TEXT,
    work_dir TEXT,
    created_at TEXT,
    submitted_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    last_polled_at TEXT,
    error_message TEXT,
    error_type TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    result_json TEXT DEFAULT '{}',
    software TEXT,
    system_name TEXT,
    condition_json TEXT,
    parent_task_id TEXT,
    map_key TEXT,
    task_group TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

CREATE TABLE IF NOT EXISTS task_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    target_task_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    target_key TEXT NOT NULL,
    link_type TEXT DEFAULT 'data',
    FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (target_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_results (
    task_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    energy REAL,
    structure_json TEXT,
    real_freqs_json TEXT,
    imag_freqs_json TEXT,
    positions_json TEXT,
    masses_json TEXT,
    gibbs REAL,
    zpe REAL,
    ts_correction REAL,
    outputs_json TEXT DEFAULT '{}',
    convergence_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    output_key TEXT NOT NULL,
    value_hash TEXT,
    input_hashes TEXT,
    software TEXT,
    created_at TEXT,
    metadata_json TEXT DEFAULT '{}',
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hpc_sessions (
    session_id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    username TEXT NOT NULL,
    port INTEGER DEFAULT 22,
    auth_method TEXT DEFAULT 'ssh_config',
    ssh_alias TEXT,
    key_file TEXT,
    scheduler TEXT DEFAULT 'slurm',
    connected_at TEXT,
    last_used TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_links_source ON task_links(source_task_id);
CREATE INDEX IF NOT EXISTS idx_task_links_target ON task_links(target_task_id);
CREATE INDEX IF NOT EXISTS idx_provenance_hash ON provenance(value_hash);
CREATE INDEX IF NOT EXISTS idx_provenance_task ON provenance(task_id);
"""

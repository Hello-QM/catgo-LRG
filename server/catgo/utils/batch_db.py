"""Batch subtask database for SLURM array job tracking.

Provides CRUD operations for the batch_subtasks table, which tracks
individual subtasks within a SLURM array job. Each subtask corresponds
to one structure in a batch computation (e.g., one VASP relaxation in
a catalyst screening run of N structures).
"""

import json
import sqlite3
import statistics
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

_write_lock = threading.Lock()


def _get_db_path() -> str:
    """Return the active workflow DB path (shared with workflow_db)."""
    from catgo.utils.workflow_db import get_active_wf_db_path
    return get_active_wf_db_path()


def _now() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


_tables_ensured = False

@contextmanager
def get_batch_db():
    """Get a database connection with row factory for batch operations."""
    global _tables_ensured
    conn = sqlite3.connect(_get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    if not _tables_ensured:
        _ensure_tables(conn)
        _tables_ensured = True
    try:
        yield conn
    finally:
        conn.close()


_CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS batch_subtasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        subtask_index INTEGER NOT NULL,
        slurm_array_id TEXT,
        status TEXT DEFAULT 'pending',
        work_dir TEXT,
        energy REAL,
        result_json TEXT DEFAULT '{}',
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        input_hash TEXT,
        UNIQUE(step_id, subtask_index)
    );
    CREATE INDEX IF NOT EXISTS idx_batch_step ON batch_subtasks(step_id, status);
    CREATE INDEX IF NOT EXISTS idx_batch_energy ON batch_subtasks(step_id, energy);
"""


def _ensure_tables(conn: sqlite3.Connection):
    """Create batch_subtasks table on an existing connection."""
    conn.executescript(_CREATE_SQL)


def ensure_batch_tables():
    """Create batch_subtasks table if not exists.

    Safe to call multiple times; uses CREATE TABLE IF NOT EXISTS.
    The table lives in the same DB as workflow tables.
    """
    conn = sqlite3.connect(_get_db_path())
    conn.executescript(_CREATE_SQL)
    conn.commit()
    conn.close()


def insert_subtasks_batch(workflow_id: str, step_id: str, count: int):
    """Bulk insert N subtask rows with status 'pending'.

    Args:
        workflow_id: Parent workflow ID.
        step_id: Parent step/node ID within the workflow.
        count: Number of subtasks to create (0..count-1).
    """
    with _write_lock:
        with get_batch_db() as conn:
            rows = [
                (step_id, workflow_id, i, "pending")
                for i in range(count)
            ]
            conn.executemany(
                "INSERT OR IGNORE INTO batch_subtasks (step_id, workflow_id, subtask_index, status) "
                "VALUES (?, ?, ?, ?)",
                rows,
            )
            conn.commit()


def update_subtask_statuses(workflow_id: str, step_id: str, statuses_dict: dict[int, str]):
    """Batch update subtask statuses from a dict of {index: status}.

    Also sets started_at/completed_at timestamps based on the new status.

    Args:
        workflow_id: Parent workflow ID.
        step_id: Parent step/node ID.
        statuses_dict: Mapping of subtask_index to new SLURM status string.
    """
    now = _now()
    with _write_lock:
        with get_batch_db() as conn:
            for idx, status in statuses_dict.items():
                status_upper = status.strip().upper()
                # Normalise SLURM status codes to simple labels
                if status_upper in ("COMPLETED", "CD"):
                    norm = "completed"
                elif status_upper in ("FAILED", "F", "NODE_FAIL", "NF", "TIMEOUT", "TO", "OUT_OF_MEMORY", "OOM"):
                    norm = "failed"
                elif status_upper in ("RUNNING", "R"):
                    norm = "running"
                elif status_upper in ("PENDING", "PD"):
                    norm = "pending"
                elif status_upper in ("CANCELLED", "CA"):
                    norm = "cancelled"
                else:
                    norm = status.lower()

                sets = ["status = ?"]
                vals: list = [norm]

                if norm == "running":
                    sets.append("started_at = COALESCE(started_at, ?)")
                    vals.append(now)
                elif norm in ("completed", "failed", "cancelled"):
                    sets.append("completed_at = ?")
                    vals.append(now)

                vals.extend([step_id, workflow_id, idx])
                conn.execute(
                    f"UPDATE batch_subtasks SET {', '.join(sets)} "
                    "WHERE step_id = ? AND workflow_id = ? AND subtask_index = ?",
                    vals,
                )
            conn.commit()


def update_subtask_result(workflow_id: str, step_id: str, index: int, **kwargs):
    """Update a single subtask's result fields.

    Accepted keyword arguments: energy, result_json, error_message,
    work_dir, status, slurm_array_id, input_hash.

    Args:
        workflow_id: Parent workflow ID.
        step_id: Parent step/node ID.
        index: Subtask index within the batch.
        **kwargs: Fields to update.
    """
    allowed = {"energy", "result_json", "error_message", "work_dir",
               "status", "slurm_array_id", "input_hash",
               "started_at", "completed_at"}
    sets = []
    vals: list = []
    for key, value in kwargs.items():
        if key not in allowed:
            continue
        if key == "result_json" and not isinstance(value, str):
            value = json.dumps(value)
        sets.append(f"{key} = ?")
        vals.append(value)

    if not sets:
        return

    with _write_lock:
        with get_batch_db() as conn:
            vals.extend([step_id, workflow_id, index])
            conn.execute(
                f"UPDATE batch_subtasks SET {', '.join(sets)} "
                "WHERE step_id = ? AND workflow_id = ? AND subtask_index = ?",
                vals,
            )
            conn.commit()


def get_batch_summary(workflow_id: str, step_id: str) -> dict:
    """Return aggregate statistics for a batch step.

    Returns a dict with keys: total, pending, running, completed, failed,
    cancelled, energy_min, energy_max, energy_mean, energy_stdev.

    Args:
        workflow_id: Parent workflow ID.
        step_id: Parent step/node ID.
    """
    with get_batch_db() as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM batch_subtasks WHERE step_id = ? AND workflow_id = ?",
            (step_id, workflow_id),
        ).fetchone()[0]

        status_counts = {}
        for row in conn.execute(
            "SELECT status, COUNT(*) as cnt FROM batch_subtasks "
            "WHERE step_id = ? AND workflow_id = ? GROUP BY status",
            (step_id, workflow_id),
        ).fetchall():
            status_counts[row["status"]] = row["cnt"]

        energies = [
            row[0] for row in conn.execute(
                "SELECT energy FROM batch_subtasks "
                "WHERE step_id = ? AND workflow_id = ? AND energy IS NOT NULL",
                (step_id, workflow_id),
            ).fetchall()
        ]

    energy_stats: dict = {}
    if energies:
        energy_stats["energy_min"] = min(energies)
        energy_stats["energy_max"] = max(energies)
        energy_stats["energy_mean"] = statistics.mean(energies)
        energy_stats["energy_stdev"] = statistics.stdev(energies) if len(energies) > 1 else 0.0
    else:
        energy_stats["energy_min"] = None
        energy_stats["energy_max"] = None
        energy_stats["energy_mean"] = None
        energy_stats["energy_stdev"] = None

    return {
        "total": total,
        "pending": status_counts.get("pending", 0),
        "running": status_counts.get("running", 0),
        "completed": status_counts.get("completed", 0),
        "failed": status_counts.get("failed", 0),
        "cancelled": status_counts.get("cancelled", 0),
        **energy_stats,
    }


def get_batch_results_page(
    workflow_id: str,
    step_id: str,
    page: int = 1,
    per_page: int = 50,
    sort: str = "energy",
    order: str = "asc",
    status_filter: str | None = None,
) -> dict:
    """Return paginated batch subtask results.

    Args:
        workflow_id: Parent workflow ID.
        step_id: Parent step/node ID.
        page: 1-based page number.
        per_page: Number of results per page (max 200).
        sort: Column to sort by (energy, subtask_index, status, completed_at).
        order: Sort direction ('asc' or 'desc').
        status_filter: Optional status to filter by (e.g. 'completed', 'failed').

    Returns:
        Dict with keys: items (list of row dicts), total, page, per_page, pages.
    """
    # Sanitise inputs
    per_page = min(max(per_page, 1), 200)
    page = max(page, 1)
    allowed_sorts = {"energy", "subtask_index", "status", "completed_at", "started_at"}
    if sort not in allowed_sorts:
        sort = "subtask_index"
    if order.lower() not in ("asc", "desc"):
        order = "asc"

    where = "step_id = ? AND workflow_id = ?"
    params: list = [step_id, workflow_id]
    if status_filter:
        where += " AND status = ?"
        params.append(status_filter)

    with get_batch_db() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM batch_subtasks WHERE {where}", params
        ).fetchone()[0]

        offset = (page - 1) * per_page
        # Use NULLS LAST for energy sorting so null energies sort to the end
        nulls_clause = " NULLS LAST" if sort == "energy" else ""
        rows = conn.execute(
            f"SELECT * FROM batch_subtasks WHERE {where} "
            f"ORDER BY {sort} {order}{nulls_clause} "
            f"LIMIT ? OFFSET ?",
            [*params, per_page, offset],
        ).fetchall()

    items = []
    for r in rows:
        d = dict(r)
        # Parse result_json for convenience
        try:
            d["result"] = json.loads(d.get("result_json") or "{}")
        except (json.JSONDecodeError, TypeError):
            d["result"] = {}
        items.append(d)

    pages = max(1, (total + per_page - 1) // per_page)
    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": pages,
    }


def get_failed_subtask_indices(workflow_id: str, step_id: str) -> list[int]:
    """Return list of subtask indices with 'failed' status.

    Args:
        workflow_id: Parent workflow ID.
        step_id: Parent step/node ID.
    """
    with get_batch_db() as conn:
        rows = conn.execute(
            "SELECT subtask_index FROM batch_subtasks "
            "WHERE step_id = ? AND workflow_id = ? AND status = 'failed' "
            "ORDER BY subtask_index",
            (step_id, workflow_id),
        ).fetchall()
    return [r[0] for r in rows]


def get_batch_energies(workflow_id: str, step_id: str) -> list[float]:
    """Return list of non-null energy values for a batch step.

    Args:
        workflow_id: Parent workflow ID.
        step_id: Parent step/node ID.
    """
    with get_batch_db() as conn:
        rows = conn.execute(
            "SELECT energy FROM batch_subtasks "
            "WHERE step_id = ? AND workflow_id = ? AND energy IS NOT NULL "
            "ORDER BY energy",
            (step_id, workflow_id),
        ).fetchall()
    return [r[0] for r in rows]


def reset_subtasks(workflow_id: str, step_id: str, indices: list[int]):
    """Reset specified subtasks back to 'pending' status for retry.

    Clears error_message, energy, result_json, and timestamps.

    Args:
        workflow_id: Parent workflow ID.
        step_id: Parent step/node ID.
        indices: List of subtask indices to reset.
    """
    if not indices:
        return
    with _write_lock:
        with get_batch_db() as conn:
            placeholders = ",".join("?" * len(indices))
            conn.execute(
                f"UPDATE batch_subtasks SET "
                f"status = 'pending', energy = NULL, result_json = '{{}}', "
                f"error_message = NULL, started_at = NULL, completed_at = NULL "
                f"WHERE step_id = ? AND workflow_id = ? "
                f"AND subtask_index IN ({placeholders})",
                [step_id, workflow_id, *indices],
            )
            conn.commit()

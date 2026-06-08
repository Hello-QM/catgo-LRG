"""Shared HPC utilities for the state machine engine."""

from __future__ import annotations
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def get_hpc_connection(task: dict, config: dict) -> Any | None:
    """Get an HPC connection for a task. Returns None if unavailable.

    Tries: task's stored session -> auto-reconnect -> config default session -> any available.
    """
    from catgo.utils.hpc_client import pool, LOCAL_SESSION_ID

    session_id = task.get("hpc_session_id")
    if not session_id:
        # Support both "default_session_id" and "default_session" config keys
        hpc_cfg = config.get("hpc", {})
        session_id = hpc_cfg.get("default_session_id") or hpc_cfg.get("default_session")

    if session_id and session_id != LOCAL_SESSION_ID:
        hpc = pool.get_connection(session_id)
        if hpc:
            return hpc

        # Connection missing or dead — try auto-reconnect
        try:
            hpc = await pool.try_reconnect(session_id)
        except Exception:
            hpc = None
        if hpc:
            logger.info(f"Auto-reconnected session {session_id}")
            return hpc

    # Fallback: any active remote session
    for sid, conn in list(pool.connections.items()):
        if sid != LOCAL_SESSION_ID and conn and conn.is_alive:
            return conn

    return None


# States in which the stored tasks.work_dir is authoritative — these only
# occur after `mkdir -p` has succeeded on the remote in submitter.py.
# For any other state the column may hold a stale path from a failed prior
# attempt, or a local preview path written by the advancer, and must be
# recomputed from the current run config.
_REMOTE_DIR_EXISTS_STATES = frozenset({
    "UPLOADING", "SUBMITTED", "QUEUED", "RUNNING",
    "COMPLETED_REMOTE", "COLLECTING", "COMPLETED",
})


def resolve_work_dir(task: dict, workflow_id: str, config: dict) -> str:
    """Build remote work directory path for a task.

    The stored ``tasks.work_dir`` is only trusted when the task is past
    the upload step; for pre-submission states it is recomputed from the
    current run config so that a stale path from a failed prior attempt
    (or a since-corrected ``base_work_dir``) cannot be stickied indefinitely.
    """
    import logging
    _logger = logging.getLogger(__name__)

    existing = task.get("work_dir")
    if existing and task.get("status") in _REMOTE_DIR_EXISTS_STATES:
        return existing

    template = config.get("paths", {}).get(
        "work_dir_template", "{base_dir}/{workflow_id}/{task_id}"
    )
    base_dir = (
        config.get("paths", {}).get("base_dir")
        or config.get("hpc", {}).get("base_work_dir")
        or config.get("base_work_dir")
        or "~/calculations"
    )
    _logger.info(f"[resolve_work_dir] config.hpc.base_work_dir={config.get('hpc', {}).get('base_work_dir')}")
    _logger.info(f"[resolve_work_dir] Using base_dir={base_dir}")
    _logger.info(f"[resolve_work_dir] template={template}")
    work_dir = template.format(
        base_dir=base_dir,
        workflow_id=workflow_id,
        task_id=task.get("node_id") or task["id"],
    )
    _logger.info(f"[resolve_work_dir] Final work_dir={work_dir}")
    return work_dir


def map_task_type_to_engine(task_type: str, params: dict) -> tuple[str, str]:
    """Map task_type + software to (resolved_node_type, engine_key).

    Uses the unified calc map built from all declarative engine definitions,
    with fallback to node_sets for non-declarative engines.
    """
    try:
        from workflow.node_sets import get_engine_for_node, _resolve_software

        resolved_type, software = _resolve_software(task_type, params)
        engine_key = get_engine_for_node(resolved_type)
        return resolved_type, engine_key
    except Exception as e:
        _logger.error("map_task_type_to_engine failed for %s: %s", task_type, e, exc_info=True)
        engine_key = task_type.split("_")[0] if "_" in task_type else "unknown"
        return task_type, engine_key

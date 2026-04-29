"""Shared HPC utilities for the state machine engine."""

from __future__ import annotations
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def get_hpc_connection(task: dict, config: dict, wf_config: dict | None = None) -> Any | None:
    """Get an HPC connection for a task. Returns None if unavailable.

    Tries: task's stored session -> wf_config default -> config default -> any available.
    For __local__ sessions, returns the LocalFileConnection from the pool.
    """
    from catgo.utils.hpc_client import pool, LOCAL_SESSION_ID

    session_id = task.get("hpc_session_id")
    if not session_id and wf_config:
        # Check per-workflow config first (supports both nested and flat formats)
        wf_hpc = wf_config.get("hpc", {})
        session_id = (
            wf_hpc.get("default_session_id") or wf_hpc.get("default_session")
            or wf_config.get("default_session_id") or wf_config.get("default_session")
        )
    if not session_id:
        # Fallback to global config
        hpc_cfg = config.get("hpc", {})
        session_id = hpc_cfg.get("default_session_id") or hpc_cfg.get("default_session")

    # Return local connection for __local__ session
    if session_id == LOCAL_SESSION_ID:
        local_conn = pool.get_connection(LOCAL_SESSION_ID)
        if local_conn:
            return local_conn
        # Local connection should always exist, but fall through if missing

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


def resolve_work_dir(task: dict, workflow_id: str, config: dict, wf_config: dict | None = None) -> str:
    """Build work directory path for a task.

    For local execution (__local__ session), uses the per-workflow base_work_dir
    instead of the global HPC paths.base_dir.
    """
    if task.get("work_dir"):
        return task["work_dir"]

    # Check per-workflow config for base_work_dir
    # Support both nested (hpc.base_work_dir) and top-level (base_work_dir)
    if wf_config:
        wf_hpc = wf_config.get("hpc", {})
        local_base = (
            wf_hpc.get("base_work_dir")
            or wf_config.get("base_work_dir")
        )
        if local_base:
            return f"{local_base}/{workflow_id}/{task['id']}"

    template = config.get("paths", {}).get(
        "work_dir_template", "{base_dir}/{workflow_id}/{task_id}"
    )
    base_dir = config.get("paths", {}).get("base_dir", "")
    return template.format(base_dir=base_dir, workflow_id=workflow_id, task_id=task["id"])


def map_task_type_to_engine(task_type: str, params: dict) -> tuple[str, str]:
    """Map task_type + software to (resolved_node_type, engine_key).

    Uses the unified calc map built from all declarative engine definitions,
    with fallback to node_sets for non-declarative engines.
    """
    from workflow.node_sets import get_engine_for_node, _resolve_software

    resolved_type, software = _resolve_software(task_type, params)
    engine_key = get_engine_for_node(resolved_type)
    return resolved_type, engine_key

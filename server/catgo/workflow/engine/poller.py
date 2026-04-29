"""Poll HPC job status for SUBMITTED/QUEUED/RUNNING tasks."""

from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.hpc_utils import get_hpc_connection

logger = logging.getLogger(__name__)

_COMPLETED_STATUSES = {"COMPLETED", "CD"}
_FAILED_STATUSES = {"FAILED", "F", "NODE_FAIL", "NF", "TIMEOUT", "TO",
                     "CANCELLED", "CA", "OOM", "OUT_OF_MEMORY"}
_PENDING_STATUSES = {"PENDING", "PD"}


async def poll_active_tasks(
    db: WorkflowDB, workflow_id: str, config: dict[str, Any],
) -> None:
    """Check HPC status for all submitted/queued/running tasks."""
    active_statuses = (
        TaskState.SUBMITTED.value,
        TaskState.QUEUED.value,
        TaskState.RUNNING.value,
    )
    tasks = db.get_all_tasks(workflow_id)
    active = [t for t in tasks if t["status"] in active_statuses and t.get("hpc_job_id")]

    for task in active:
        task_id = task["id"]
        job_id = task["hpc_job_id"]

        hpc = await get_hpc_connection(task, config)
        if not hpc:
            # No HPC connection available — mark as REMOTE_ERROR so the
            # error_handler can retry (which resets to READY and triggers
            # re-submission with a potentially restored connection).
            # Without this, the task stays stuck in RUNNING forever.
            logger.warning(
                "Task %s: no HPC connection (session_id=%s), marking REMOTE_ERROR",
                task_id, task.get("hpc_session_id"),
            )
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message="HPC connection lost during polling",
                error_type="transient",
            )
            continue

        try:
            new_status = await _check_job(hpc, job_id)
            _apply_status(db, task, new_status)
        except Exception as e:
            logger.warning("Task %s: poll error: %s", task_id, e)


async def _check_job(hpc, job_id: str) -> str:
    """Query scheduler for actual job status. Returns state string."""
    try:
        info = await hpc.scheduler.get_job_status(hpc.conn, job_id)
        if info is not None:
            s = (info.status or "").upper()
            if s in _COMPLETED_STATUSES:
                return "COMPLETED_REMOTE"
            if s in _FAILED_STATUSES:
                return "FAILED"
            if s in _PENDING_STATUSES:
                return "QUEUED"
            return "RUNNING"
    except Exception:
        pass

    # Fallback: sacct (finished jobs)
    if hasattr(hpc.scheduler, "get_job_status_sacct"):
        try:
            info = await hpc.scheduler.get_job_status_sacct(hpc.conn, job_id)
            if info and info.status:
                s = info.status.upper()
                if s in _COMPLETED_STATUSES:
                    return "COMPLETED_REMOTE"
                if s in _FAILED_STATUSES:
                    return "FAILED"
        except Exception:
            pass

    return "UNKNOWN"


def _apply_status(db: WorkflowDB, task: dict, new_status: str) -> None:
    """Update task status based on poll result."""
    task_id = task["id"]
    old_status = task["status"]
    now = datetime.now(timezone.utc).isoformat()

    if new_status == "UNKNOWN":
        db.update_task(task_id, last_polled_at=now)
        return

    if new_status == old_status:
        db.update_task(task_id, last_polled_at=now)
        return

    if new_status == "COMPLETED_REMOTE":
        db.update_task(task_id, status=TaskState.COMPLETED_REMOTE.value, last_polled_at=now)
        logger.info("Task %s: %s -> COMPLETED_REMOTE (job done on HPC)", task_id, old_status)
    elif new_status == "FAILED":
        db.update_task(task_id,
            status=TaskState.REMOTE_ERROR.value,
            error_message="HPC job failed",
            error_type="compute",
            last_polled_at=now,
        )
        logger.warning("Task %s: %s -> REMOTE_ERROR (HPC job failed)", task_id, old_status)
    elif new_status == "QUEUED":
        db.update_task(task_id, status=TaskState.QUEUED.value, last_polled_at=now)
    elif new_status == "RUNNING":
        db.update_task(task_id, status=TaskState.RUNNING.value, last_polled_at=now)

"""Handle REMOTE_ERROR tasks: smart recovery, retry, or escalate.

Three-tier error recovery:
  Tier 1: Custodian (handles VASP errors at runtime -- already integrated)
  Tier 2: Rule-based diagnosis (parse error message, apply known fixes, retry)
  Tier 3: Escalate to user (mark PAUSED with diagnosis)
"""

from __future__ import annotations
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState

logger = logging.getLogger(__name__)


def handle_errors(db: WorkflowDB, workflow_id: str, config: dict[str, Any]) -> list[str]:
    """Process all REMOTE_ERROR tasks: smart recovery, retry, or fail.

    Returns list of task IDs that were retried (set back to READY).
    """
    from catgo.workflow.engine.smart_recovery import diagnose_and_fix, apply_fix

    retry_config = config.get("retry", {})
    max_retries = retry_config.get("max_retries", 3)

    error_tasks = db.get_tasks_by_status(workflow_id, TaskState.REMOTE_ERROR.value)
    retried = []

    for task in error_tasks:
        task_id = task["id"]
        error_type = task.get("error_type", "")
        retry_count = task.get("retry_count", 0) or 0

        # Check max retries FIRST — applies to ALL error types including transient
        if retry_count >= max_retries:
            db.update_task(task_id,
                status=TaskState.FAILED.value,
                error_message=f"Failed after {max_retries} retries: {task.get('error_message', '')}",
            )
            logger.warning("Task %s: REMOTE_ERROR -> FAILED (max retries %d)", task_id, max_retries)
            continue

        # Transient errors (SSH disconnect, network issues) get a simple
        # retry back to READY without smart recovery analysis.
        if error_type == "transient":
            db.update_task(task_id,
                status=TaskState.READY.value,
                retry_count=retry_count + 1,
                error_message=f"Transient error (retry {retry_count + 1}/{max_retries}): {task.get('error_message', '')}",
            )
            retried.append(task_id)
            logger.info("Task %s: REMOTE_ERROR (transient) -> READY (retry %d/%d)", task_id, retry_count + 1, max_retries)
            continue

        # Try smart recovery (Tier 2/3)
        diagnosis = diagnose_and_fix(db, task, config)

        if diagnosis and diagnosis["tier"] == 2 and diagnosis["fixes"]:
            # Tier 2: apply known fix and retry
            apply_fix(db, task_id, diagnosis["fixes"])
            db.update_task(task_id,
                status=TaskState.READY.value,
                retry_count=retry_count + 1,
                error_message=f"Auto-fix applied: {diagnosis['diagnosis']}",
            )
            retried.append(task_id)
            logger.info("Task %s: smart recovery applied (%s)", task_id, diagnosis["diagnosis"])
        elif diagnosis and diagnosis["tier"] == 3:
            # Tier 3: known error, no auto-fix -- escalate to user
            db.update_task(task_id,
                status=TaskState.PAUSED.value,
                error_message=f"Needs manual review: {diagnosis['diagnosis']}. Original: {task.get('error_message', '')}",
            )
            logger.info("Task %s: escalated to user (%s)", task_id, diagnosis["diagnosis"])
        else:
            # Unknown error -- simple retry
            db.update_task(task_id,
                status=TaskState.READY.value,
                retry_count=retry_count + 1,
                error_message=None,
            )
            retried.append(task_id)
            logger.info("Task %s: REMOTE_ERROR -> READY (retry %d/%d)", task_id, retry_count + 1, max_retries)

    return retried

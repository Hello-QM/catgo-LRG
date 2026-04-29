"""Control-flow task handlers: Zone, While, Map.

Extracted from scanner.py to keep each file focused and under 150 lines.
"""

from __future__ import annotations

import asyncio
import json
import logging

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.broadcast import broadcast as _broadcast

logger = logging.getLogger(__name__)


def handle_while_task(db: WorkflowDB, task: dict, workflow_id: str) -> bool:
    """Handle a __while__ loop task. Returns True if handled."""
    task_id = task["id"]
    children = db.get_children_of(task_id)

    if not children:
        # Empty loop -- mark completed immediately
        db.update_task(task_id, status=TaskState.COMPLETED.value)
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "COMPLETED"})
        )
        db.store_result(task_id, workflow_id, outputs_json=json.dumps({"iterations": 0, "converged": True}))
        logger.info("Task %s (__while__): completed (no children)", task_id)
        return True

    params = json.loads(task.get("params_json", "{}") or "{}")
    max_iter = params.get("max_iterations", 10)
    condition_key = params.get("condition_key", "converged")
    condition_value = params.get("condition_value", True)
    iteration = task.get("retry_count", 0) or 0

    child_statuses = [c["status"] for c in children]

    # If children still running, wait
    if not all(
        s in (TaskState.COMPLETED.value, TaskState.FAILED.value, TaskState.SKIPPED.value)
        for s in child_statuses
    ):
        db.update_task(task_id, status=TaskState.WAITING.value)
        return True

    # If any child failed, loop fails
    if any(s == TaskState.FAILED.value for s in child_statuses):
        db.update_task(task_id, status=TaskState.FAILED.value)
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "FAILED"})
        )
        logger.info("Task %s (__while__): failed (child failed)", task_id)
        return True

    # Check convergence condition from last child's result
    last_child = children[-1]
    result = db.get_result(last_child["id"])
    converged = False
    if result:
        outputs = {}
        if result.get("outputs_json"):
            try:
                outputs = json.loads(result["outputs_json"]) if isinstance(result["outputs_json"], str) else result["outputs_json"]
            except (json.JSONDecodeError, TypeError):
                pass
        if condition_key in outputs:
            actual = outputs[condition_key]
        else:
            actual = result.get(condition_key)
        converged = (actual == condition_value)

    if converged:
        db.update_task(task_id, status=TaskState.COMPLETED.value)
        db.store_result(
            task_id, workflow_id,
            outputs_json=json.dumps({"iterations": iteration + 1, "converged": True}),
        )
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "COMPLETED"})
        )
        logger.info("Task %s (__while__): converged after %d iteration(s)", task_id, iteration + 1)
        return True

    # Check max iterations
    if iteration + 1 >= max_iter:
        db.update_task(task_id, status=TaskState.COMPLETED.value)
        db.store_result(
            task_id, workflow_id,
            outputs_json=json.dumps({"iterations": iteration + 1, "converged": False}),
        )
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "COMPLETED"})
        )
        logger.info("Task %s (__while__): max iterations (%d) reached", task_id, max_iter)
        return True

    # Not converged: reset children for next iteration
    for child in children:
        db.update_task(child["id"], status=TaskState.WAITING.value, error_message=None)
    db.update_task(task_id, status=TaskState.WAITING.value, retry_count=iteration + 1)
    logger.info("Task %s (__while__): iteration %d/%d, resetting children", task_id, iteration + 1, max_iter)
    return True


def handle_zone_task(db: WorkflowDB, task: dict, workflow_id: str) -> bool:
    """Handle a __zone__ group task. Returns True if handled."""
    task_id = task["id"]
    children = db.get_children_of(task_id)

    if not children:
        # Empty zone -- mark completed immediately
        db.update_task(task_id, status=TaskState.COMPLETED.value)
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "COMPLETED"})
        )
        logger.info("Task %s (__zone__): completed (no children)", task_id)
        return True

    child_statuses = [c["status"] for c in children]
    if all(s == TaskState.COMPLETED.value for s in child_statuses):
        db.update_task(task_id, status=TaskState.COMPLETED.value)
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "COMPLETED"})
        )
        logger.info("Task %s (__zone__): completed (all children done)", task_id)
    elif any(s == TaskState.FAILED.value for s in child_statuses):
        db.update_task(task_id, status=TaskState.FAILED.value)
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "FAILED"})
        )
        logger.info("Task %s (__zone__): failed (child failed)", task_id)
    else:
        # Children still running -- keep zone WAITING so it gets
        # re-evaluated in the next cycle.
        db.update_task(task_id, status=TaskState.WAITING.value)

    return True

"""Collect results from HPC for COMPLETED_REMOTE tasks."""

from __future__ import annotations
import json
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.hpc_utils import get_hpc_connection, map_task_type_to_engine

logger = logging.getLogger(__name__)


async def collect_completed_tasks(
    db: WorkflowDB, workflow_id: str, config: dict[str, Any],
) -> list[str]:
    """Read results from HPC for all COMPLETED_REMOTE tasks.

    Returns list of task IDs that were successfully collected.
    """
    tasks = db.get_tasks_by_status(workflow_id, TaskState.COMPLETED_REMOTE.value)
    collected = []

    for task in tasks:
        task_id = task["id"]
        db.update_task(task_id, status=TaskState.COLLECTING.value)

        try:
            await _collect_one(db, task, workflow_id, config)
            collected.append(task_id)
        except Exception as e:
            logger.error("Task %s: result collection failed: %s", task_id, e, exc_info=True)
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message=f"Result collection failed: {e}",
                error_type="transient",
            )

    return collected


async def _collect_one(
    db: WorkflowDB, task: dict, workflow_id: str, config: dict,
) -> None:
    """Collect results for a single task."""
    task_id = task["id"]
    task_type = task["task_type"]
    work_dir = task.get("work_dir", "")
    job_id = task.get("hpc_job_id", "")
    session_id = task.get("hpc_session_id", "")
    params = json.loads(task.get("params_json", "{}") or "{}")

    hpc = await get_hpc_connection(task, config)
    if not hpc:
        raise RuntimeError("No HPC connection for result collection")

    resolved_type, engine_key = map_task_type_to_engine(task_type, params)

    # Use pluggable collector registry — each engine registers its own collector
    from catgo.workflow.engine.engine_registry import get_result_collector
    collector = get_result_collector(engine_key)
    if not collector:
        raise RuntimeError(f"No collector registered for '{engine_key}'. "
                          f"Register one with @register_collector('{engine_key}')")
    result = await collector(hpc, work_dir, task_id, resolved_type, params, session_id, job_id)

    _store_result(db, task_id, workflow_id, result)
    db.update_task(task_id, status=TaskState.COMPLETED.value)
    logger.info("Task %s (%s): COMPLETED_REMOTE -> COMPLETED", task_id, task_type)


def _store_result(db: WorkflowDB, task_id: str, workflow_id: str, result: dict) -> None:
    """Map the result dict to task_results columns."""
    fields: dict[str, Any] = {}

    if "energy" in result:
        fields["energy"] = result["energy"]
    if "structure" in result:
        s = result["structure"]
        fields["structure_json"] = s if isinstance(s, str) else json.dumps(s)
    if "real_freqs" in result:
        fields["real_freqs_json"] = json.dumps(result["real_freqs"])
    if "imag_freqs" in result:
        fields["imag_freqs_json"] = json.dumps(result["imag_freqs"])
    if "positions" in result:
        fields["positions_json"] = json.dumps(result["positions"])
    if "masses" in result:
        fields["masses_json"] = json.dumps(result["masses"])
    if "gibbs" in result:
        fields["gibbs"] = result["gibbs"]
    if "zpe" in result or "zpe_ev" in result:
        fields["zpe"] = result.get("zpe") or result.get("zpe_ev")

    # Store full result as generic outputs for anything not mapped
    fields["outputs_json"] = json.dumps(result, default=str)

    if fields:
        db.store_result(task_id, workflow_id, **fields)

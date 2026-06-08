# server/catgo/workflow/v1_compat.py
"""V1 compatibility shim — read V2 tasks table, return V1-shaped step dicts.

Used by the V1 API endpoints in workflow.py so the frontend sees the same
JSON shape it always has, but data comes from the V2 engine's tables.
"""

from __future__ import annotations
import json
from catgo.workflow.db import WorkflowDB
from catgo.workflow.state_map import v2_to_v1_status


def list_steps_v1(db: WorkflowDB, workflow_id: str) -> list[dict]:
    """Return V2 tasks formatted as V1 step dicts."""
    tasks = db.get_all_tasks(workflow_id)
    return [_task_to_step(db, t) for t in tasks]


def get_step_status_v1(db: WorkflowDB, workflow_id: str, step_id: str) -> dict:
    """Get a single V2 task formatted as V1 step dict."""
    tasks = db.get_all_tasks(workflow_id)
    for t in tasks:
        if (t.get("node_id") or t["id"]) == step_id:
            return _task_to_step(db, t)
    raise KeyError(f"Step {step_id} not found in workflow {workflow_id}")


def _task_to_step(db: WorkflowDB, task: dict) -> dict:
    """Convert a V2 task row to a V1 step dict.

    Merges data from both the tasks table (result_json column) and the
    task_results table (energy, structure_json, outputs_json, etc.) so
    the frontend sees a complete result_json even for V2-executed tasks.
    """
    params = json.loads(task.get("params_json", "{}") or "{}")

    # Start with whatever is already in the tasks.result_json column
    result = json.loads(task.get("result_json", "{}") or "{}")

    # Enrich with V2 task_results table (energy, structure, frequencies, etc.)
    task_result = db.get_result(task["id"])
    if task_result:
        for key, val in task_result.items():
            if key in ("task_id", "workflow_id") or val is None:
                continue
            if key == "outputs_json" and isinstance(val, str):
                try:
                    extras = json.loads(val)
                    result.update(extras)
                except Exception:
                    pass
            else:
                result[key] = val

    return {
        "id": task.get("node_id") or task["id"],
        "workflow_id": task["workflow_id"],
        "node_type": task["task_type"],
        "label": task.get("name", "") or params.get("label", "") or task["task_type"],
        "status": v2_to_v1_status(task["status"]),
        "config_json": task.get("params_json", "{}"),
        "hpc_job_id": task.get("hpc_job_id"),
        "hpc_session_id": task.get("hpc_session_id"),
        "hpc_host": params.get("hpc_host"),
        "work_dir": task.get("work_dir"),
        "ase_db_id": None,
        "result_json": json.dumps(result),
        "error_message": task.get("error_message"),
        "started_at": task.get("started_at"),
        "completed_at": task.get("completed_at"),
    }

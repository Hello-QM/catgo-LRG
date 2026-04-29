"""Workflow service — shared ops for REST API and MCP tools."""

from __future__ import annotations
import json
from collections import deque
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.workflow import Workflow
from catgo.workflow.reference import OutputReference
from catgo.workflow.states import TaskState
from catgo.workflow.engine.lifecycle import (
    submit_workflow as _submit,
    pause_workflow as _pause,
    resume_workflow as _resume,
    reset_workflow as _reset,
)


def create_workflow(db: WorkflowDB, name: str, config: dict | None = None) -> dict:
    """Create a new workflow and return its id + name."""
    wf = Workflow(name, db=db, config=config)
    return {"workflow_id": wf.workflow_id, "name": wf.name}


def add_task(
    db: WorkflowDB,
    workflow_id: str,
    task_type: str,
    name: str | None = None,
    system_name: str | None = None,
    **kwargs: Any,
) -> dict:
    """Add a task to an existing workflow. Returns task_id + task_type."""
    resolved = {}
    for k, v in kwargs.items():
        if isinstance(v, dict) and "_ref" in v:
            resolved[k] = OutputReference(v["_ref"], v.get("_key"))
        else:
            resolved[k] = v

    wf = Workflow.__new__(Workflow)
    wf.db = db
    wf.workflow_id = workflow_id
    wf.name = ""
    wf.config = {}

    handle = wf.add_task(task_type, name=name, system_name=system_name, **resolved)
    return {"task_id": handle.task_id, "task_type": handle.task_type}


def get_status(db: WorkflowDB, workflow_id: str) -> dict:
    """Return workflow summary with task list."""
    wf = db.get_workflow(workflow_id)
    tasks = db.get_all_tasks(workflow_id)
    return {
        "workflow": {"id": wf["id"], "name": wf["name"], "status": wf["status"]},
        "tasks": [
            {
                "id": t["id"],
                "type": t["task_type"],
                "name": t.get("name"),
                "status": t["status"],
                "system_name": t.get("system_name"),
            }
            for t in tasks
        ],
    }


def list_workflows(db: WorkflowDB) -> list[dict]:
    """List all workflows (id, name, status)."""
    return [
        {"id": w["id"], "name": w["name"], "status": w["status"]}
        for w in db.list_workflows()
    ]


def modify_task_params(db: WorkflowDB, task_id: str, updates: dict) -> dict:
    """Merge *updates* into existing task params. Only allowed for editable states."""
    task = db.get_task(task_id)
    editable = {TaskState.WAITING.value, TaskState.READY.value, TaskState.PAUSED.value}
    if task["status"] not in editable:
        raise ValueError(f"Cannot edit: task is {task['status']}")
    existing = json.loads(task.get("params_json", "{}") or "{}")
    existing.update(updates)
    db.update_task(task_id, params_json=json.dumps(existing))
    return {"task_id": task_id, "params": existing}


def retry_task(db: WorkflowDB, task_id: str) -> list[str]:
    """Reset a task and all downstream dependents to WAITING."""
    to_reset: set[str] = set()
    queue = deque([task_id])
    while queue:
        tid = queue.popleft()
        if tid in to_reset:
            continue
        to_reset.add(tid)
        for link in db.get_task_children(tid):
            queue.append(link["target_task_id"])
    for tid in to_reset:
        db.update_task(
            tid,
            status=TaskState.WAITING.value,
            error_message=None,
            error_type=None,
            retry_count=0,
        )
    return list(to_reset)


def submit(db: WorkflowDB, workflow_id: str) -> dict:
    _submit(db, workflow_id); return {"status": "running"}

def pause(db: WorkflowDB, workflow_id: str) -> dict:
    _pause(db, workflow_id); return {"status": "paused"}

def resume(db: WorkflowDB, workflow_id: str) -> dict:
    _resume(db, workflow_id); return {"status": "running"}

def reset(db: WorkflowDB, workflow_id: str) -> dict:
    _reset(db, workflow_id); return {"status": "draft"}

"""MCP tool interface for AI agents to create/manage CatGo workflows.

AI agents call these via MCP protocol. Each action maps to service.py.
"""

from __future__ import annotations
import asyncio
from typing import Any
import contextvars

from catgo.workflow.task_ids import make_task_id

# Track the active project context (e.g., when called from ProjectDashboard)
_active_project_id: contextvars.ContextVar[str | None] = contextvars.ContextVar('active_project_id', default=None)


def set_active_project(project_id: str | None) -> None:
    """Set the active project context for workflow creation."""
    _active_project_id.set(project_id)


def get_active_project() -> str | None:
    """Get the active project context."""
    return _active_project_id.get()


def get_tool_definition() -> dict:
    """Return the MCP tool schema for catgo_workflow_engine."""
    return {
        "name": "catgo_workflow_engine",
        "description": (
            "Create and manage computational chemistry workflows. Build: create -> "
            "add_task (one per node) -> submit. "
            "Actions: create, add_task, submit, status, list, modify_params, retry, "
            "pause, resume, reset, get_result, get_dag. "
            "WIRE TASKS by data flow (there is no separate connect action): pass an "
            "upstream task's output as an input param of the downstream add_task, using "
            "an output reference {'_ref': '<upstream_task_id>', '_key': '<output_key>'}. "
            "e.g. add_task geo_opt with params {'structure': {'_ref': '<slab_task_id>', "
            "'_key': 'structure'}} creates the slab.structure -> geo_opt.structure edge. "
            "add_task returns the new task_id. "
            "IMPORTANT: Before using action='submit', you MUST ask the user which HPC "
            "cluster to use (e.g., Expanse, Shaheen, local) and confirm job parameters "
            "(partition, account, walltime, ntasks). Never submit without user confirmation. "
            "HPC job parameters can be set per-task via add_task params. "
            "Task ids are namespaced as '{workflow_id}:{node_id}'. For per-task actions "
            "(get_result, modify_params, retry) pass either an explicit 'task_id', or "
            "'workflow_id' + 'node_id' (the graph node id) which will be namespaced for you."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "create", "add_task", "submit",
                        "status", "list", "modify_params", "retry",
                        "pause", "resume", "reset", "get_result", "get_dag",
                    ],
                },
                "params": {
                    "type": "object",
                    "description": (
                        "Action-specific parameters. add_task: workflow_id, task_type, and "
                        "input params (use {'_ref':'<task_id>','_key':'<key>'} values to wire "
                        "from upstream tasks). For per-task actions (get_result, "
                        "modify_params, retry), provide either 'task_id' (already namespaced "
                        "as '{workflow_id}:{node_id}') or 'workflow_id' + 'node_id'."
                    ),
                },
            },
            "required": ["action"],
        },
    }


def _resolve_task_id(params: dict[str, Any]) -> str:
    """Resolve a (namespaced) task id from MCP params.

    Task ids are namespaced ``{workflow_id}:{node_id}`` (issue #227). Result/status
    tools may be called either with an explicit ``task_id`` (back-compat) or with
    ``workflow_id`` + ``node_id`` (the graph node id), which are namespaced here.
    """
    if params.get("task_id"):
        return params["task_id"]
    wf = params.get("workflow_id")
    node = params.get("node_id")
    if wf and node:
        return make_task_id(wf, node)
    raise ValueError("provide task_id, or workflow_id + node_id")


def _get_db():
    """Get a WorkflowDB instance from config."""
    from catgo.workflow.db import WorkflowDB
    from catgo.workflow.config import load_config
    from pathlib import Path

    config = load_config()
    db_path = str(Path(config["paths"]["db_path"]).expanduser())
    return WorkflowDB(db_path)


def _dispatch_sync(action: str, params: dict[str, Any]) -> dict[str, Any]:
    """Synchronous dispatch. Runs in a worker thread via asyncio.to_thread."""
    from catgo.workflow import service

    db = _get_db()

    if action == "create":
        wf = service.create_workflow(db, params.get("name", "Untitled"), params.get("config"))
        # Assign to project if provided explicitly OR from active context
        project_id = params.get("project_id") or get_active_project()
        if project_id:
            db.assign_project(wf["workflow_id"], project_id)
            wf["project_id"] = project_id
        return wf

    elif action == "add_task":
        nested = params.get("params")
        if isinstance(nested, dict):
            task_params = dict(nested)
        else:
            task_params = {k: v for k, v in params.items()
                           if k not in ("workflow_id", "task_type", "name", "system_name", "params")}
        return service.add_task(
            db, params["workflow_id"], params["task_type"],
            name=params.get("name"), system_name=params.get("system_name"),
            **task_params,
        )

    elif action == "submit":
        return service.submit(db, params["workflow_id"])

    elif action == "status":
        return service.get_status(db, params["workflow_id"])

    elif action == "list":
        return {"workflows": service.list_workflows(db)}

    elif action == "get_dag":
        return db.get_dag(params["workflow_id"])

    elif action == "get_result":
        result = db.get_result(_resolve_task_id(params))
        return result or {"error": "No result found"}

    elif action == "modify_params":
        return service.modify_task_params(db, _resolve_task_id(params), params.get("updates", {}))

    elif action == "retry":
        reset_ids = service.retry_task(db, _resolve_task_id(params))
        return {"reset_tasks": reset_ids}

    elif action == "pause":
        return service.pause(db, params["workflow_id"])

    elif action == "resume":
        return service.resume(db, params["workflow_id"])

    elif action == "reset":
        return service.reset(db, params["workflow_id"])

    else:
        return {"error": f"Unknown action: {action}"}


async def handle_tool_call(action: str, params: dict[str, Any]) -> dict[str, Any]:
    """Route MCP tool calls to service functions.

    Offloads sync SQLite / service work to a thread so the FastAPI event loop
    never blocks on DB I/O, HPC SSH, or file system calls.
    """
    return await asyncio.to_thread(_dispatch_sync, action, params)

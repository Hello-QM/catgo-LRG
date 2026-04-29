"""MCP tool interface for AI agents to create/manage CatGo workflows.

AI agents call these via MCP protocol. Each action maps to service.py.
"""

from __future__ import annotations
import asyncio
from typing import Any


def get_tool_definition() -> dict:
    """Return the MCP tool schema for catgo_workflow_engine."""
    return {
        "name": "catgo_workflow_engine",
        "description": (
            "Create and manage computational chemistry workflows. "
            "Actions: create, add_task, connect, submit, status, list, "
            "modify_params, retry, pause, resume, reset, get_result, get_dag. "
            "IMPORTANT: Before using action='submit', you MUST ask the user which HPC "
            "cluster to use (e.g., Expanse, Shaheen, local) and confirm job parameters "
            "(partition, account, walltime, ntasks). Never submit without user confirmation. "
            "HPC job parameters can be set per-task via add_task params."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "create", "add_task", "connect", "submit",
                        "status", "list", "modify_params", "retry",
                        "pause", "resume", "reset", "get_result", "get_dag",
                    ],
                },
                "params": {
                    "type": "object",
                    "description": "Action-specific parameters",
                },
            },
            "required": ["action"],
        },
    }


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
        return service.create_workflow(db, params.get("name", "Untitled"), params.get("config"))

    elif action == "add_task":
        task_params = {k: v for k, v in params.items()
                       if k not in ("workflow_id", "task_type", "name", "system_name")}
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
        result = db.get_result(params["task_id"])
        return result or {"error": "No result found"}

    elif action == "modify_params":
        return service.modify_task_params(db, params["task_id"], params.get("updates", {}))

    elif action == "retry":
        reset_ids = service.retry_task(db, params["task_id"])
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

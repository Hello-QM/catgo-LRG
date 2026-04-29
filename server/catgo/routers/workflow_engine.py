"""REST API for the state-machine workflow engine.

Endpoints:
  GET  /api/engine/workflows              — list all workflows
  GET  /api/engine/workflows/{id}         — get workflow + summary
  GET  /api/engine/workflows/{id}/dag     — get DAG (tasks + links)
  POST /api/engine/workflows/{id}/submit  — start execution
  POST /api/engine/workflows/{id}/pause   — pause workflow
  POST /api/engine/workflows/{id}/resume  — resume workflow
  POST /api/engine/workflows/{id}/reset   — reset all tasks
"""

from __future__ import annotations
import asyncio
import json
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from catgo.workflow.db import WorkflowDB
from catgo.workflow import service
from catgo.workflow.engine.broadcast import add_listener, remove_listener
from catgo.workflow.graph_converter import convert_graph_json

router = APIRouter(prefix="/api/engine/workflows", tags=["workflow-engine"])

_db: WorkflowDB | None = None


def set_db(db: WorkflowDB) -> None:
    global _db
    _db = db


def _get_db() -> WorkflowDB:
    if _db is None:
        raise RuntimeError("Workflow DB not initialized")
    return _db


def _summarize_workflow(db: WorkflowDB, wf: dict) -> dict:
    tasks = db.get_all_tasks(wf["id"])
    status_counts: dict[str, int] = {}
    for t in tasks:
        s = t["status"]
        status_counts[s] = status_counts.get(s, 0) + 1
    return {
        "id": wf["id"],
        "name": wf["name"],
        "status": wf["status"],
        "created_at": wf.get("created_at"),
        "updated_at": wf.get("updated_at"),
        "task_count": len(tasks),
        "status_counts": status_counts,
        "project_id": wf.get("project_id"),
    }


@router.get("")
def list_workflows():
    db = _get_db()
    workflows = db.list_workflows()
    return [_summarize_workflow(db, wf) for wf in workflows]


@router.get("/by-project/{project_id}")
def list_workflows_for_project(project_id: str):
    """List engine workflows assigned to a specific project."""
    db = _get_db()
    workflows = db.list_workflows_for_project(project_id)
    return [_summarize_workflow(db, wf) for wf in workflows]


@router.get("/{workflow_id}")
def get_workflow(workflow_id: str):
    db = _get_db()
    try:
        wf = db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    tasks = db.get_all_tasks(workflow_id)
    return {"workflow": wf, "tasks": tasks, "task_count": len(tasks)}


@router.get("/{workflow_id}/dag")
def get_dag(workflow_id: str):
    db = _get_db()
    try:
        db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    return db.get_dag(workflow_id)


def _ensure_exists(db: WorkflowDB, workflow_id: str):
    try:
        db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")


@router.post("/{workflow_id}/submit")
def submit(workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    wf = db.get_workflow(workflow_id)
    if wf["status"] == "running":
        raise HTTPException(409, "Already running")
    return {**service.submit(db, workflow_id), "workflow_id": workflow_id}


@router.post("/{workflow_id}/pause")
def pause(workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    return {**service.pause(db, workflow_id), "workflow_id": workflow_id}


@router.post("/{workflow_id}/resume")
def resume(workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    return {**service.resume(db, workflow_id), "workflow_id": workflow_id}


@router.post("/{workflow_id}/reset")
def reset(workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    return {**service.reset(db, workflow_id), "workflow_id": workflow_id}


@router.post("/{workflow_id}/confirm-all")
def confirm_all(workflow_id: str):
    """Confirm ALL PENDING_REVIEW tasks in a workflow, advancing them to READY."""
    db = _get_db()
    _ensure_exists(db, workflow_id)
    from catgo.workflow.states import TaskState
    pending = db.get_tasks_by_status(workflow_id, TaskState.PENDING_REVIEW.value)
    for task in pending:
        db.update_task(task["id"], status=TaskState.READY.value)
    return {"workflow_id": workflow_id, "confirmed": len(pending)}


class ConvertRequest(BaseModel):
    name: str
    graph_json: str
    config: dict | None = None


@router.post("/convert")
def convert(body: ConvertRequest):
    """Convert a GUI graph_json into an engine workflow with tasks + links."""
    db = _get_db()
    wf_id = convert_graph_json(db, body.name, body.graph_json, body.config)
    wf = db.get_workflow(wf_id)
    tasks = db.get_all_tasks(wf_id)
    return {"workflow_id": wf_id, "name": wf["name"], "task_count": len(tasks)}


@router.put("/{workflow_id}/project/{project_id}")
def assign_project(workflow_id: str, project_id: str):
    """Assign an engine workflow to a project."""
    db = _get_db()
    _ensure_exists(db, workflow_id)
    db.assign_project(workflow_id, project_id)
    return {"status": "assigned", "workflow_id": workflow_id, "project_id": project_id}


@router.delete("/{workflow_id}/project")
def unassign_project(workflow_id: str):
    """Remove an engine workflow from its project."""
    db = _get_db()
    _ensure_exists(db, workflow_id)
    db.assign_project(workflow_id, None)
    return {"status": "unassigned", "workflow_id": workflow_id}


@router.websocket("/{workflow_id}/monitor")
async def monitor(websocket: WebSocket, workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    await websocket.accept()

    q = add_listener(workflow_id)
    try:
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=30.0)
                await websocket.send_json(msg)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        remove_listener(workflow_id, q)

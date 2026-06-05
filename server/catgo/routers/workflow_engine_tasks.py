"""Task-level REST API for the workflow engine.

Endpoints:
  GET  /api/engine/tasks/{id}           — get task details
  PUT  /api/engine/tasks/{id}/params    — update params (only WAITING/READY)
  GET  /api/engine/tasks/{id}/result    — get result data
  POST /api/engine/tasks/{id}/retry     — reset task + downstream
  POST /api/engine/tasks/{id}/cancel    — cancel task
  GET  /api/engine/tasks/{id}/provenance — get provenance lineage
  GET  /api/engine/tasks/{id}/files     — list files in work_dir
  GET  /api/engine/tasks/{id}/convergence — parse convergence data
  GET  /api/engine/tasks/{id}/file-content — read a file from work_dir
  PUT  /api/engine/tasks/{id}/file-content — write a file in work_dir
  GET  /api/engine/tasks/{id}/frequencies  — parse vibrational frequencies
"""

from __future__ import annotations
from pathlib import Path
import json
import logging
import asyncio
import time
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from catgo.workflow.states import TaskState
from catgo.workflow import service
from catgo.workflow.engine.advancer import PREVIEW_DIR_PREFIX

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/engine/tasks", tags=["workflow-engine-tasks"])

_db = None


def set_db(db) -> None:
    global _db
    _db = db


def _get_db():
    if _db is None:
        raise RuntimeError("Workflow DB not initialized")
    return _db


def _is_local_preview(work_dir: str | None) -> bool:
    """Return True if work_dir points to a local preview directory."""
    return bool(work_dir and work_dir.startswith(PREVIEW_DIR_PREFIX) and Path(work_dir).exists())


def _get_task_hpc(task_id: str):
    """Look up task and its HPC connection. Falls back to any available session."""
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    work_dir = task.get("work_dir")
    if not work_dir:
        raise HTTPException(404, f"Task {task_id} has no work_dir")

    from catgo.utils.hpc_client import pool, LOCAL_SESSION_ID

    # Try stored session first
    session_id = task.get("hpc_session_id")
    if session_id:
        hpc = pool.get_connection(session_id)
        if hpc:
            return task, hpc

    # Fallback: any available remote session
    for sid, conn in list(pool.connections.items()):
        if sid != LOCAL_SESSION_ID and conn and conn.is_alive:
            return task, conn

    raise HTTPException(404, f"No HPC connection available (stored session expired)")


@router.get("/{task_id}")
def get_task(task_id: str):
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")
    # Expose node_id so the frontend can map a namespaced task id back to its
    # graph node. Fresh rows already carry it via SELECT *; legacy/pre-migration
    # rows (NULL node_id) fall back to the task id. (#227)
    if task.get("node_id") is None:
        task["node_id"] = task["id"]
    parents = db.get_task_parents(task_id)
    children = db.get_task_children(task_id)
    return {"task": task, "parents": parents, "children": children}


class ParamUpdate(BaseModel):
    params: dict


@router.put("/{task_id}/params")
def update_params(task_id: str, body: ParamUpdate):
    db = _get_db()
    try:
        db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")
    try:
        return service.modify_task_params(db, task_id, body.params)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.get("/{task_id}/result")
async def get_result(task_id: str):
    """Get result for a task.

    Supports both engine task_id and node_id for backwards compatibility:
    - Direct lookup by task_id (V2 engine tasks)
    - Fallback: lookup by node_id if task_id not found (frontend polls with node_id)
    """
    db = _get_db()

    # Try direct task_id lookup first
    result = db.get_result(task_id)
    if result:
        return result

    # Fallback: try looking up task by ID (might be a node_id from frontend)
    try:
        task = db.get_task(task_id)
        if task and task.get("result"):
            return task["result"]
    except KeyError:
        pass

    raise HTTPException(404, f"No result for task {task_id}")


@router.post("/{task_id}/retry")
def retry_task(task_id: str):
    db = _get_db()
    try:
        db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")
    reset_ids = service.retry_task(db, task_id)
    return {"reset_tasks": reset_ids}


@router.post("/{task_id}/cancel")
def cancel_task(task_id: str):
    db = _get_db()
    try:
        db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")
    db.update_task(task_id, status=TaskState.CANCELLED.value)
    return {"task_id": task_id, "status": "CANCELLED"}


@router.post("/{task_id}/confirm")
async def confirm_task(task_id: str):
    """Confirm a PENDING_REVIEW task, advancing to READY for HPC submission.

    Moves the task to READY so the engine scanner's submit_ready_tasks()
    picks it up on the next cycle and handles the full submission pipeline
    (generate inputs, upload, sbatch).
    """
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    if task["status"] != TaskState.PENDING_REVIEW.value:
        raise HTTPException(
            409,
            f"Task {task_id} is {task['status']}, not PENDING_REVIEW",
        )

    # Move to READY so the scanner's submitter picks it up
    db.update_task(task_id, status=TaskState.READY.value)
    logger.info("Task %s: PENDING_REVIEW -> READY (user confirmed)", task_id)

    # Broadcast so the frontend WebSocket sees the status change
    from catgo.workflow.engine.broadcast import broadcast as _broadcast
    asyncio.create_task(
        _broadcast(task["workflow_id"], {"type": "task_status", "task_id": task_id, "status": "READY"})
    )

    return {
        "task_id": task_id,
        "status": "READY",
        "message": "Task confirmed. Will be submitted on next engine cycle.",
    }


@router.post("/{task_id}/reject")
async def reject_task(task_id: str):
    """Reject a PENDING_REVIEW task, returning it to WAITING state."""
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")
    if task["status"] != TaskState.PENDING_REVIEW.value:
        raise HTTPException(
            409,
            f"Task {task_id} is {task['status']}, not PENDING_REVIEW",
        )
    # Return to WAITING so user can edit params
    db.update_task(task_id, status=TaskState.WAITING.value)
    return {"task_id": task_id, "status": "WAITING"}


@router.get("/{task_id}/provenance")
def get_task_provenance(task_id: str):
    """Return provenance lineage for a task."""
    db = _get_db()
    try:
        db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    records = db.get_provenance(task_id)
    if not records:
        return {"task_id": task_id, "lineage": {}, "duplicate": None}

    from catgo.workflow.provenance import trace_provenance
    lineage = {}
    for rec in records:
        trace = trace_provenance(db, task_id, rec.get("output_key"))
        if trace:
            lineage[rec["output_key"]] = trace

    # Check for duplicates
    duplicate_info = None
    for rec in records:
        if rec.get("value_hash"):
            dupes = db.find_provenance_by_hash(rec["value_hash"])
            if dupes and len(dupes) > 1:
                other_tasks = [d["task_id"] for d in dupes if d["task_id"] != task_id]
                if other_tasks:
                    duplicate_info = {"hash": rec["value_hash"], "matching_tasks": other_tasks}
                    break

    return {"task_id": task_id, "lineage": lineage, "duplicate": duplicate_info}


@router.get("/{task_id}/files")
async def get_task_files(task_id: str, subdir: str = Query("", description="Subdirectory relative to work_dir")):
    """List files in the task's work_dir (local preview or HPC)."""
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    work_dir = task.get("work_dir")
    if not work_dir:
        raise HTTPException(404, f"Task {task_id} has no work_dir")

    # Local preview files — read directly from filesystem
    if _is_local_preview(work_dir):
        local_dir = Path(work_dir) / subdir if subdir else Path(work_dir)
        if not local_dir.exists():
            raise HTTPException(404, f"Directory not found: {subdir}")
        files = []
        for f in sorted(local_dir.iterdir()):
            files.append({
                "name": f.name,
                "path": str(f.relative_to(Path(work_dir))),
                "is_dir": f.is_dir(),
                "size_bytes": f.stat().st_size if f.is_file() else 0,
                "modified_time": "",
            })
        return {"work_dir": work_dir, "resolved_path": str(local_dir), "subdir": subdir, "files": files}

    # HPC path — use SSH connection
    task, hpc = _get_task_hpc(task_id)
    target = f"{work_dir}/{subdir}" if subdir else work_dir

    try:
        resolved, files = await hpc.list_remote_dir(target)
        return {
            "work_dir": work_dir,
            "resolved_path": resolved,
            "subdir": subdir,
            "files": [
                {
                    "name": f.name,
                    "path": f.path,
                    "is_dir": f.is_dir,
                    "size_bytes": f.size_bytes,
                    "modified_time": f.modified_time,
                }
                for f in files
            ],
        }
    except Exception as exc:
        raise HTTPException(500, f"Failed to list files: {exc}")


@router.get("/{task_id}/convergence")
async def get_task_convergence(task_id: str):
    """Parse convergence data from the task's OSZICAR/OUTCAR."""
    task, hpc = _get_task_hpc(task_id)
    work_dir = task["work_dir"]

    task_type = task.get("task_type", "")

    # Resolve unified calc types (e.g. irc + software=orca → orca_irc)
    from workflow.node_sets import UNIFIED_CALC_NODES, _resolve_software
    if task_type in UNIFIED_CALC_NODES:
        params = json.loads(task.get("params_json", "{}") or "{}")
        task_type, _ = _resolve_software(task_type, params)

    try:
        # ORCA tasks: use ORCA-specific parser (detect via task_type, not file sniffing)
        if task_type.startswith("orca_"):
            from catgo.utils.job_parser import parse_orca_progress
            data = await parse_orca_progress(hpc.conn, work_dir, task_type)
            result = data.model_dump()
            logger.info(
                "Task %s convergence (%s): success=%s, %d points, converged=%s",
                task_id, task_type, data.success, len(data.points), data.converged,
            )
            return result

        # VASP / other: use file-based detection
        from catgo.utils.job_parser import detect_calc_type, parse_vasp_convergence
        from catgo.models.hpc import CalcSoftware

        software, _ = await detect_calc_type(hpc.conn, work_dir)
        if software == CalcSoftware.VASP:
            data = await parse_vasp_convergence(hpc.conn, work_dir)
            return data.model_dump()
        return {"success": False, "points": [], "converged": False,
                "message": f"Convergence not yet supported for {software.value}"}
    except Exception as exc:
        logger.error("Task %s convergence (%s) failed: %s", task_id, task_type, exc)
        return {"success": False, "points": [], "converged": False,
                "message": str(exc)}


@router.get("/{task_id}/file-content")
async def get_task_file_content(task_id: str, path: str = Query(..., description="Relative path within work_dir")):
    """Read a file from the task's work_dir (local preview or HPC)."""
    # Security: prevent path traversal
    if ".." in path or path.startswith("/"):
        raise HTTPException(400, "Path must be relative and cannot contain '..'")

    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    work_dir = task.get("work_dir")
    if not work_dir:
        raise HTTPException(404, f"Task {task_id} has no work_dir")

    # Local preview files — read directly from filesystem
    if _is_local_preview(work_dir):
        local_path = Path(work_dir) / path
        if not local_path.exists():
            raise HTTPException(404, f"File not found: {path}")
        content = local_path.read_text(encoding="utf-8", errors="replace")
        total = content.count("\n") + 1
        return {"path": path, "content": content, "total_lines": total}

    # HPC path — use SSH connection
    task, hpc = _get_task_hpc(task_id)

    full_path = f"{work_dir}/{path}"
    try:
        from catgo.utils.hpc_client import LocalFileConnection
        if isinstance(hpc, LocalFileConnection):
            content, total = await hpc.read_file_content(full_path)
        else:
            from catgo.utils.job_parser import read_remote_file
            content, total = await read_remote_file(hpc.conn, full_path)
        return {"path": path, "content": content, "total_lines": total}
    except Exception as exc:
        raise HTTPException(500, f"Failed to read file: {exc}")


class FileWriteBody(BaseModel):
    path: str
    content: str


@router.put("/{task_id}/file-content")
async def put_task_file_content(task_id: str, body: FileWriteBody):
    """Write a file to the task's work_dir (local preview or HPC)."""
    if ".." in body.path or body.path.startswith("/"):
        raise HTTPException(400, "Path must be relative and cannot contain '..'")

    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    work_dir = task.get("work_dir")
    if not work_dir:
        raise HTTPException(404, f"Task {task_id} has no work_dir")

    # Local preview files — write directly to filesystem
    if _is_local_preview(work_dir):
        local_path = Path(work_dir) / body.path
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_text(body.content, encoding="utf-8")
        return {"path": body.path, "success": True}

    # HPC path — use SSH connection
    task, hpc = _get_task_hpc(task_id)

    full_path = f"{work_dir}/{body.path}"
    try:
        from catgo.utils.hpc_client import LocalFileConnection
        if isinstance(hpc, LocalFileConnection):
            resolved = hpc._resolve_local_path(full_path)
            Path(resolved).write_text(body.content, encoding="utf-8")
            ok = True
        else:
            from catgo.utils.job_parser import write_remote_file
            ok = await write_remote_file(hpc.conn, full_path, body.content)
        if not ok:
            raise HTTPException(500, "Write returned failure")
        return {"path": body.path, "success": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Failed to write file: {exc}")


@router.get("/{task_id}/frequencies")
async def get_task_frequencies(task_id: str):
    """Parse vibrational frequencies from task's output (VASP OUTCAR or ORCA.out)."""
    task, hpc = _get_task_hpc(task_id)
    work_dir = task["work_dir"]
    task_type = task.get("task_type", "")

    try:
        # ORCA freq: parse from ORCA.out via OrcaFreqOutput
        if task_type in ("orca_freq",):
            from catgo.utils.orca_output import OrcaFreqOutput
            result = await hpc.run(f"cat {work_dir}/ORCA.out", check=True)
            parser = OrcaFreqOutput(result.stdout)
            return {"success": True, **parser.get_summary()}

        # Default: VASP
        from catgo.utils.vasp_freq_parser import parse_vasp_frequencies
        data = await parse_vasp_frequencies(hpc.conn, work_dir)
        return data
    except Exception as exc:
        return {"success": False, "message": str(exc)}

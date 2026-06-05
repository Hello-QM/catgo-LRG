"""Task-level REST API for the workflow engine.

Endpoints:
  GET  /api/engine/tasks/{id}           — get task details
  PUT  /api/engine/tasks/{id}/params    — update params (only WAITING/READY)
  GET  /api/engine/tasks/{id}/result    — get result data
  GET  /api/engine/tasks/{id}/step-results — completed-step convergence/energy summary
  POST /api/engine/tasks/{id}/retry     — reset task + downstream
  POST /api/engine/tasks/{id}/cancel    — cancel task
  GET  /api/engine/tasks/{id}/provenance — get provenance lineage
  GET  /api/engine/tasks/{id}/files     — list files in work_dir
  GET  /api/engine/tasks/{id}/convergence — parse convergence data
  GET  /api/engine/tasks/{id}/file-content — read a file from work_dir
  PUT  /api/engine/tasks/{id}/file-content — write a file in work_dir
  GET  /api/engine/tasks/{id}/frequencies  — parse vibrational frequencies
  GET  /api/engine/tasks/{id}/forces       — per-ionic-step force vectors
  GET  /api/engine/tasks/{id}/mlp-progress — MLP optimizer live progress
  GET  /api/engine/tasks/{id}/orca-progress — ORCA stdout-tail calc stage
  GET  /api/engine/tasks/{id}/irc-trajectory — ORCA IRC full trajectory (XYZ)
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
# Reuse the V1 request schema rather than redefining it (additive convergence).
from catgo.routers.workflow import GibbsRequest

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


@router.get("/{task_id}/step-results")
def get_step_results(task_id: str):
    """Completed-step results (convergence points, energy, etc.) for a V2 task.

    V2-native mirror of V1 ``GET /api/workflow/{wf}/step-results/{step}``
    (``catgo.routers.workflow.api_get_step_results``). Resolves the task via
    ``WorkflowDB.get_task`` and reads its stored result via
    ``WorkflowDB.get_result`` (the ``task_results`` table) instead of the legacy
    ``workflow_steps`` table.

    The result-merge (tasks.result_json + task_results.outputs_json + the typed
    result columns) is delegated to the SAME V1-compat shim
    (``catgo.workflow.v1_compat._task_to_step``) the V1 endpoint already reads
    through — this is additive convergence work, not a re-implementation of the
    merge. The scalar fields are then pulled out of the merged summary exactly as
    V1 does, so the response shape is byte-for-byte compatible with the V1
    endpoint the frontend already consumes.

    Contract (matches V1): unknown task -> clean 404; task not completed -> 400;
    on success the documented ``{node_type, convergence_points, energy_eh,
    energy_ev, converged, n_steps, full_summary}`` payload.
    """
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    # Build the V1-shaped step dict (merges result_json + task_results columns +
    # flattened outputs_json) via the shared compat shim, then read it exactly as
    # the V1 step-results handler does.
    from catgo.workflow.v1_compat import _task_to_step
    step = _task_to_step(db, task)

    status = (step.get("status") or "").lower()
    if status != "completed":
        raise HTTPException(400, f"Step not completed (status: {status})")

    result_json_str = step.get("result_json", "{}") or "{}"
    result_json = json.loads(result_json_str) if isinstance(result_json_str, str) else result_json_str

    return {
        "node_type": step.get("node_type"),
        "convergence_points": result_json.get("convergence_points", []),
        "energy_eh": result_json.get("energy_eh"),
        "energy_ev": result_json.get("energy_ev"),
        "converged": result_json.get("converged"),
        "n_steps": result_json.get("n_steps"),
        "full_summary": result_json,  # Full merged summary for detailed analysis
    }


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


@router.get("/{task_id}/forces")
async def get_task_forces(task_id: str, ionic_step: int = Query(0, description="Ionic step (0 = last)")):
    """Per-atom force vectors for one ionic step from the task's VASP output.

    V2-native mirror of V1 ``GET /api/workflow/{wf}/forces/{step}``. Resolves the
    task (and its HPC connection) via ``WorkflowDB.get_task`` / ``_get_task_hpc``
    instead of the legacy ``workflow_steps`` table, then delegates the actual
    OUTCAR/vaspout.h5 parsing to the SAME V1 helpers
    (``parse_vasp_forces_h5`` then ``parse_vasp_forces``) — this is additive
    convergence work, not a re-implementation.

    ``_get_task_hpc`` raises a clean 404 when the task is unknown or has no
    ``work_dir``, and a 404 when no HPC connection is available.
    """
    task, hpc = _get_task_hpc(task_id)
    work_dir = task["work_dir"]

    from catgo.utils.job_parser import parse_vasp_forces, parse_vasp_forces_h5

    # Try H5 first (VASP 6.4+ vaspout.h5), fall back to OUTCAR AWK — same order
    # the V1 handler uses.
    h5_result = await parse_vasp_forces_h5(hpc.conn, work_dir, ionic_step)
    if h5_result and h5_result.get("success"):
        return h5_result
    return await parse_vasp_forces(hpc.conn, work_dir, ionic_step)


@router.get("/{task_id}/mlp-progress")
async def get_task_mlp_progress(task_id: str):
    """Per-iteration live progress from an MLP optimizer log for a V2 task.

    V2-native mirror of V1 ``GET /api/workflow/{wf}/mlp-progress/{step}``
    (``catgo.routers.workflow.api_get_mlp_progress``). Resolves the task via
    ``WorkflowDB.get_task`` (V2 store) for its ``work_dir`` / ``task_type`` /
    ``params_json`` instead of the legacy ``workflow_steps`` table, then reuses
    the SAME V1 parser (``catgo.utils.job_parser.parse_ase_opt_log``) and emits
    the identical ``{points, converged, message}`` shape the frontend's
    ``NormalizedConvergence`` adapter renders — this is additive convergence
    work, not a re-implementation.

    This is what the frontend task-adapter's ``mode:'task'`` branch (currently a
    placeholder message) calls to make live MLP progress real.

    Local-only, same as V1: an HPC-remote MLP task returns a deferred message
    rather than SSH-tailing the log. Unknown task -> clean 404; no work_dir or
    no log yet -> clean empty result (never a 500).
    """
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    work_dir = task.get("work_dir")
    if not work_dir:
        return {"points": [], "converged": False, "message": "No work directory yet"}

    # Only local work dirs are readable here. HPC work dirs would need SSH
    # tailing — deferred until the MLP+HPC path is tested (mirrors V1).
    if task.get("hpc_session_id"):
        return {
            "points": [], "converged": False,
            "message": "MLP progress over HPC is not yet wired",
        }

    import os
    # Pick opt.log for relax/vibrations, neb.log for NEB / ts_search. Match the
    # V1 contract: only the log files ASE actually writes, no os.listdir
    # fallback (OS-dependent ordering could shadow the current log with a stale
    # one from an aborted run).
    task_type = (task.get("task_type") or "").lower()
    candidates = []
    if "neb" in task_type or task_type == "ts_search":
        candidates.append(os.path.join(work_dir, "neb.log"))
    candidates.append(os.path.join(work_dir, "opt.log"))

    log_path = next((p for p in candidates if os.path.isfile(p)), None)
    if not log_path:
        return {"points": [], "converged": False, "message": "Log file not created yet"}

    # Resolve the per-task fmax target from params_json (the V2 analog of V1's
    # config_json). We DON'T silently default to 0.05 — a wrong target could
    # flip a still-running node to converged=True and prematurely complete it.
    # When unresolvable, return converged=None so the frontend status-sync
    # short-circuits and keeps the node "running" (mirrors V1 exactly).
    fmax_target: float | None = None
    try:
        params = json.loads(task.get("params_json") or "{}")
        if isinstance(params, dict) and "fmax" in params:
            fmax_target = float(params["fmax"])
    except (ValueError, TypeError) as exc:
        logger.warning(
            "Could not parse fmax from task %s params_json: %s — "
            "convergence flag will be reported as null.",
            task_id, exc,
        )
    if fmax_target is None:
        # No known target -> parse points but skip the converged check. The
        # parser uses a sentinel fmax that's never reached so converged stays
        # False; we override to null below.
        fmax_target = -1.0

    from catgo.utils.job_parser import parse_ase_opt_log
    # Parser is synchronous & reads a local file — offload so the event loop
    # doesn't block on large log tails.
    try:
        conv_data = await asyncio.to_thread(parse_ase_opt_log, log_path, fmax_target)
    except Exception:
        logger.exception("Error parsing MLP progress for task %s", task_id)
        raise HTTPException(500, f"Error reading MLP progress for task {task_id}")

    if not conv_data.success:
        return {"points": [], "converged": False, "message": conv_data.message}

    # If fmax_target was unresolvable, null out converged so the frontend
    # status-sync branch in NodeStatusPanel can't use it.
    unresolved_fmax = fmax_target < 0

    prev_energy = None
    points = []
    for pt in conv_data.points:
        dE = (pt.energy - prev_energy) if prev_energy is not None else 0.0
        points.append({
            "step": pt.step,
            "energy": pt.energy,
            "dE": dE,
            "energy_sigma0": pt.energy_sigma0,
            "max_force": pt.max_force,
            "rms_force": pt.rms_force,
        })
        prev_energy = pt.energy

    converged_value = None if unresolved_fmax else conv_data.converged
    message = conv_data.message
    if unresolved_fmax and points:
        message = (
            f"step {points[-1]['step']} · fmax={points[-1]['max_force']:.3f} eV/Å "
            f"(target fmax not in params — convergence flag suppressed)"
        )
    return {"points": points, "converged": converged_value, "message": message}


def _starting_stage() -> dict:
    """Clean default stage when there is nothing to parse yet."""
    return {"stage": "starting", "message": "Starting calculation..."}


@router.get("/{task_id}/orca-progress")
async def get_task_orca_progress(task_id: str):
    """Coarse-grained ORCA calculation *stage* parsed from the output tail.

    V2-native mirror of V1 ``GET /api/workflow/{wf}/orca_progress/{step}``
    (``catgo.routers.workflow.api_get_orca_progress``). Resolves the task via
    ``WorkflowDB.get_task`` (V2 store) for its ``work_dir`` / ``task_type`` /
    ``params_json`` instead of the legacy ``workflow_steps`` table, tails the
    task's ``ORCA.out`` and derives a stage from it. The stage parsing is
    delegated to the SAME engine parsers the poller already uses
    (``catgo.workflow.engine.orca_progress.get_orca_stage`` /
    ``get_orca_irc_stage``) — this is additive convergence work, not a
    re-implementation of the physics/parsing.

    Unlike the V1 endpoint (which returns convergence *points* via
    ``parse_orca_progress``), this returns the lightweight stdout-tail *stage*
    dict — the coarse progress label the poller surfaces. The IRC parser is
    dispatched for ``orca_irc`` (resolving unified nodes like ``geo_opt`` +
    ``software=orca`` first); every other ORCA node uses the opt/freq parser.

    Contract: unknown task -> clean 404; no work_dir, no ORCA.out yet, or no
    live HPC connection -> a clean ``starting`` stage (never a 500). The
    response always echoes ``task_id`` + the resolved ``task_type`` so the
    frontend can map it back to its graph node.
    """
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    work_dir = task.get("work_dir")
    if not work_dir:
        return {"task_id": task_id, "task_type": task.get("task_type", ""), **_starting_stage()}

    # Resolve unified calc types (e.g. geo_opt + software=orca → orca_opt, or
    # ts_search + software=orca → orca_neb_ts) so the right parser is dispatched
    # — same resolution the convergence endpoint + V1 handler use.
    task_type = task.get("task_type", "")
    from workflow.node_sets import UNIFIED_CALC_NODES, _resolve_software
    if task_type in UNIFIED_CALC_NODES:
        params = json.loads(task.get("params_json", "{}") or "{}")
        task_type, _ = _resolve_software(task_type, params)

    base = {"task_id": task_id, "task_type": task_type}

    # Tail the ORCA.out — local preview reads straight from disk; HPC tails over
    # SSH. Any failure (no file / dead session) degrades to a clean starting
    # stage rather than a 500, matching the V1 "no work directory" behaviour.
    tail_text = ""
    orca_out = f"{work_dir}/ORCA.out"
    if _is_local_preview(work_dir):
        local_path = Path(work_dir) / "ORCA.out"
        if local_path.is_file():
            tail_text = local_path.read_text(encoding="utf-8", errors="replace")
    else:
        try:
            _task, hpc = _get_task_hpc(task_id)
        except HTTPException:
            # No live HPC connection (expired session) → clean starting stage.
            return {**base, **_starting_stage()}
        try:
            result = await hpc.run(
                f"test -f {orca_out} && tail -c 20000 {orca_out} || echo ''",
                check=False,
            )
            tail_text = result.stdout or ""
        except Exception as exc:
            logger.warning("Task %s orca-progress tail failed: %s", task_id, exc)
            return {**base, **_starting_stage()}

    if not tail_text.strip():
        return {**base, **_starting_stage()}

    from catgo.workflow.engine.orca_progress import get_orca_stage, get_orca_irc_stage
    if task_type == "orca_irc":
        stage = get_orca_irc_stage(tail_text)
    else:
        stage = get_orca_stage(tail_text)

    return {**base, **stage}


@router.get("/{task_id}/irc-trajectory")
async def get_task_irc_trajectory(task_id: str):
    """Serve the ORCA IRC full trajectory (``ORCA_IRC_Full_trj.xyz``) for a V2 task.

    V2-native mirror of V1 ``GET /api/workflow/{wf}/irc_trajectory/{step}``
    (``catgo.routers.workflow.api_get_irc_trajectory``). Resolves the task via
    ``WorkflowDB.get_task`` (V2 store) for its ``work_dir`` / ``task_type`` /
    ``params_json`` instead of the legacy ``workflow_steps`` table, then reads
    the IRC trajectory file ORCA writes (input basename ``ORCA`` →
    ``ORCA_IRC_Full_trj.xyz``) and returns it as raw XYZ text for the trajectory
    viewer. The HPC read reuses the SAME V1 file helper
    (``catgo.utils.job_parser.read_remote_file``) — this is additive convergence
    work, not a re-implementation of the I/O.

    Unified ``irc`` nodes (``software=orca``) are resolved to ``orca_irc`` first,
    matching the V1 node-type guard: this endpoint only serves ORCA IRC nodes.

    Contract: unknown task / no ``work_dir`` -> clean 404; non-IRC node -> 400;
    trajectory file absent (not produced yet) or no live HPC connection -> clean
    404. The response echoes ``task_id`` + the resolved ``task_type`` so the
    frontend can map it back to its graph node, alongside the documented V1
    ``{content, filename}`` payload.
    """
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    work_dir = task.get("work_dir")
    if not work_dir:
        raise HTTPException(404, f"Task {task_id} has no work_dir")

    # Resolve unified calc types (irc + software=orca → orca_irc) so the node-type
    # guard matches the V1 handler — same resolution the convergence/orca-progress
    # endpoints use.
    task_type = task.get("task_type", "")
    from workflow.node_sets import UNIFIED_CALC_NODES, _resolve_software
    if task_type in UNIFIED_CALC_NODES:
        params = json.loads(task.get("params_json", "{}") or "{}")
        task_type, _ = _resolve_software(task_type, params)

    if task_type != "orca_irc":
        raise HTTPException(400, "This endpoint only supports orca_irc nodes")

    # ORCA appends the input basename to all IRC output files. The input is
    # always written as ORCA.inp, so basename = ORCA → ORCA_IRC_Full_trj.xyz.
    filename = "ORCA_IRC_Full_trj.xyz"
    base = {"task_id": task_id, "task_type": task_type}

    # Local-preview work dirs read straight from disk; HPC work dirs read over
    # SSH via the shared V1 helper.
    if _is_local_preview(work_dir):
        local_path = Path(work_dir) / filename
        if not local_path.is_file():
            raise HTTPException(404, f"{filename} not found")
        content = local_path.read_text(encoding="utf-8", errors="replace")
        if not content:
            raise HTTPException(404, f"{filename} not found")
        return {**base, "content": content, "filename": filename}

    # HPC path — a missing/expired session degrades to a clean 404 (file is
    # unreachable), matching the V1 "file not found on HPC" behaviour.
    try:
        _task, hpc = _get_task_hpc(task_id)
    except HTTPException:
        raise HTTPException(404, f"{filename} not reachable (no HPC session)")

    trajectory_path = f"{work_dir}/{filename}"
    try:
        from catgo.utils.hpc_client import LocalFileConnection
        if isinstance(hpc, LocalFileConnection):
            content, _ = await hpc.read_file_content(trajectory_path)
        else:
            from catgo.utils.job_parser import read_remote_file
            # IRC trajectories are typically 10–200 KB for 40-step paths.
            content, _ = await read_remote_file(
                hpc.conn, trajectory_path, max_bytes=10 * 1024 * 1024
            )
    except asyncio.TimeoutError:
        raise HTTPException(504, "Timeout reading trajectory file from HPC")
    except Exception as exc:
        logger.warning("Task %s irc-trajectory read failed: %s", task_id, exc)
        raise HTTPException(404, f"{filename} not found")

    if not content:
        raise HTTPException(404, f"{filename} not found")

    return {**base, "content": content, "filename": filename}


def _freqs_from_v2_result(result: dict) -> tuple[list[float], list[float]]:
    """Extract real/imag frequency lists (cm⁻¹) from a V2 task_results row.

    The V2 engine stores frequencies in the dedicated ``real_freqs_json`` /
    ``imag_freqs_json`` columns (lists of floats, or lists of dicts carrying a
    ``frequency_cm`` key). For robustness we also fall back to a nested
    ``outputs_json`` blob using the same legacy key names the V1 path reads
    (``real_freqs`` / ``imag_freqs``).
    """
    def _coerce(raw) -> list[float]:
        if raw is None:
            return []
        data = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(data, list):
            return []
        return [f["frequency_cm"] if isinstance(f, dict) else f for f in data]

    real_cm = _coerce(result.get("real_freqs_json"))
    imag_cm = _coerce(result.get("imag_freqs_json"))

    # Fallback: legacy-shaped frequencies nested in outputs_json.
    if not real_cm and not imag_cm:
        outputs_raw = result.get("outputs_json")
        if outputs_raw:
            outputs = json.loads(outputs_raw) if isinstance(outputs_raw, str) else outputs_raw
            if isinstance(outputs, dict):
                real_cm = _coerce(outputs.get("real_freqs"))
                imag_cm = _coerce(outputs.get("imag_freqs"))

    return real_cm, imag_cm


@router.post("/{task_id}/gibbs")
def calculate_task_gibbs(task_id: str, req: GibbsRequest):
    """Calculate Gibbs free-energy correction from a V2 task's stored frequencies.

    V2-native mirror of V1 ``POST /api/workflow/{wf}/gibbs/{step}``. Reads the
    task's frequency data from the ``task_results`` table (via
    ``WorkflowDB.get_result``) — the V1 path is broken for V2 because
    ``task_results`` has no ``result_json`` mirror. The Gibbs/thermo physics is
    delegated to the same shared helpers the V1 handler calls
    (``catgo.utils.gibbs_calculator.calc_adsorbed`` / ``calc_gas``).
    """
    db = _get_db()
    try:
        db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    result = db.get_result(task_id)
    if not result:
        raise HTTPException(404, f"No result for task {task_id}")

    real_cm, imag_cm = _freqs_from_v2_result(result)
    if not real_cm:
        return {"success": False, "message": "No frequency data available"}

    from catgo.utils.gibbs_calculator import calc_adsorbed, calc_gas

    if req.mode == "adsorbed":
        return calc_adsorbed(real_cm, imag_cm, req.temperature, req.freq_cutoff)
    elif req.mode == "gas":
        positions = _coerce_json_list(result.get("positions_json"))
        masses = _coerce_json_list(result.get("masses_json"))
        atom_types = _coerce_json_list(result.get("atom_types_json"))

        if not positions or not masses:
            return {"success": False, "message": "Position/mass data required for gas mode"}

        return calc_gas(
            real_cm, imag_cm, positions, masses, atom_types,
            T=req.temperature, P=req.pressure,
            n_unpaired=req.n_unpaired,
        )
    else:
        return {"success": False, "message": f"Unknown mode: {req.mode}"}


def _coerce_json_list(raw):
    """Decode a JSON-encoded list column, returning [] for missing/blank."""
    if raw is None:
        return []
    data = json.loads(raw) if isinstance(raw, str) else raw
    return data if isinstance(data, list) else []

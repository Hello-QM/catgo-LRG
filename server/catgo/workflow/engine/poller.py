"""Poll HPC job status for SUBMITTED/QUEUED/RUNNING tasks."""

from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import asyncssh

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.hpc_utils import get_hpc_connection
from catgo.workflow.engine.broadcast import broadcast_stage_message
from catgo.workflow.engine.orca_progress import get_orca_stage, get_orca_irc_stage
from catgo.workflow.engine.result_handler import on_task_completed

logger = logging.getLogger(__name__)

_COMPLETED_STATUSES = {"COMPLETED", "CD"}
_FAILED_STATUSES = {"FAILED", "F", "NODE_FAIL", "NF", "TIMEOUT", "TO",
                     "CANCELLED", "CA", "OOM", "OUT_OF_MEMORY"}
_PENDING_STATUSES = {"PENDING", "PD"}


async def _verify_connection(hpc, session_id: str, cache: dict[str, bool]) -> bool:
    """Quick health check for an HPC connection (once per session per cycle).

    Sends a lightweight echo command to detect half-open TCP sockets before
    we waste 30s on a dead connection during job status queries.
    """
    if session_id in cache:
        return cache[session_id]
    try:
        result = await asyncio.wait_for(
            hpc.run_on_owner(lambda: hpc.conn.run("echo __catgo_poll_check__", check=False)),
            timeout=10,
        )
        ok = "__catgo_poll_check__" in (result.stdout or "")
        cache[session_id] = ok
        if not ok:
            logger.warning("Health check failed for session %s (bad output)", session_id)
            hpc._alive = False
        return ok
    except Exception as exc:
        logger.warning("Health check failed for session %s: %s", session_id, exc)
        hpc._alive = False
        cache[session_id] = False
        return False


async def poll_active_tasks(
    db: WorkflowDB, workflow_id: str, config: dict[str, Any],
) -> None:
    """Check HPC status for all submitted/queued/running tasks."""
    active_statuses = (
        TaskState.SUBMITTED.value,
        TaskState.QUEUED.value,
        TaskState.RUNNING.value,
    )
    tasks = db.get_all_tasks(workflow_id)
    active = [t for t in tasks if t["status"] in active_statuses and t.get("hpc_job_id")]

    # Pre-flight health check cache — one probe per HPC session per cycle
    _health_cache: dict[str, bool] = {}

    for task in active:
        task_id = task["id"]
        job_id = task["hpc_job_id"]

        hpc = await get_hpc_connection(task, config)
        if not hpc:
            logger.warning(
                "Task %s: no HPC connection (session_id=%s), marking REMOTE_ERROR",
                task_id, task.get("hpc_session_id"),
            )
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message="HPC connection lost during polling",
                error_type="transient",
            )
            continue

        # Verify connection is actually usable (catches half-open sockets)
        session_id = task.get("hpc_session_id") or hpc.session_id
        if not await _verify_connection(hpc, session_id, _health_cache):
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message="HPC connection health check failed",
                error_type="transient",
            )
            continue

        try:
            new_status = await _check_job(hpc, job_id)
            await _apply_status(db, task, new_status, hpc)

            # Extract and broadcast ORCA stage for running tasks
            if task["status"] == TaskState.RUNNING.value:
                try:
                    stage_msg = await _extract_orca_stage(hpc, task)
                    if stage_msg:
                        await broadcast_stage_message(workflow_id, task_id, stage_msg)
                except Exception as e:
                    logger.debug(f"Stage extraction failed for task {task_id}: {e}")
        except asyncio.TimeoutError:
            logger.warning("Task %s: poll command timed out, marking connection dead", task_id)
            hpc._alive = False
            _health_cache[session_id] = False
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message="HPC poll timed out (connection may be lost)",
                error_type="transient",
            )
        except (OSError, asyncssh.Error) as e:
            logger.warning("Task %s: SSH error during poll: %s", task_id, e)
            hpc._alive = False
            _health_cache[session_id] = False
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message=f"SSH error: {e}",
                error_type="transient",
            )
        except Exception as e:
            logger.warning("Task %s: poll error: %s", task_id, e)


async def _check_job(hpc, job_id: str) -> str:
    """Query scheduler for actual job status. Returns state string."""
    try:
        info = await hpc.run_on_owner(
            lambda: hpc.scheduler.get_job_status(hpc.conn, job_id)
        )
        if info is not None:
            s = (info.status or "").upper()
            if s in _COMPLETED_STATUSES:
                return "COMPLETED_REMOTE"
            if s in _FAILED_STATUSES:
                return "FAILED"
            if s in _PENDING_STATUSES:
                return "QUEUED"
            return "RUNNING"
    except Exception:
        pass

    # Fallback: sacct (finished jobs)
    if hasattr(hpc.scheduler, "get_job_status_sacct"):
        try:
            info = await hpc.run_on_owner(
                lambda: hpc.scheduler.get_job_status_sacct(hpc.conn, job_id)
            )
            if info and info.status:
                s = info.status.upper()
                if s in _COMPLETED_STATUSES:
                    return "COMPLETED_REMOTE"
                if s in _FAILED_STATUSES:
                    return "FAILED"
        except Exception:
            pass

    return "UNKNOWN"


async def _apply_status(
    db: WorkflowDB,
    task: dict,
    new_status: str,
    hpc: Any,
) -> None:
    """Update task status based on poll result.

    When a task completes (COMPLETED_REMOTE), triggers result collection
    to parse output files and store results in the database.
    """
    task_id = task["id"]
    job_id = task.get("hpc_job_id", "unknown")
    old_status = task["status"]
    now = datetime.now(timezone.utc).isoformat()

    if new_status == "UNKNOWN":
        db.update_task(task_id, last_polled_at=now)
        return

    if new_status == old_status:
        db.update_task(task_id, last_polled_at=now)
        return

    if new_status == "COMPLETED_REMOTE":
        db.update_task(task_id, status=TaskState.COMPLETED_REMOTE.value, last_polled_at=now)
        logger.info("Task %s: %s -> COMPLETED_REMOTE (job done on HPC)", task_id, old_status)

        # Broadcast status update
        from catgo.workflow.engine.broadcast import broadcast
        wf_id = task.get("workflow_id", "")
        await broadcast(wf_id, {
            "type": "task_status",
            "task_id": task_id,
            "status": TaskState.COMPLETED_REMOTE.value,
            "job_id": job_id,
        })

        # Trigger result collection for ORCA and other engines
        try:
            await on_task_completed(db, task, hpc)
        except Exception as e:
            logger.error(f"Task {task_id}: result collection failed: {e}", exc_info=True)

    elif new_status == "FAILED":
        db.update_task(task_id,
            status=TaskState.REMOTE_ERROR.value,
            error_message="HPC job failed",
            error_type="compute",
            last_polled_at=now,
        )
        logger.warning("Task %s: %s -> REMOTE_ERROR (HPC job failed)", task_id, old_status)
        # Broadcast status update
        from catgo.workflow.engine.broadcast import broadcast
        wf_id = task.get("workflow_id", "")
        await broadcast(wf_id, {
            "type": "task_status",
            "task_id": task_id,
            "status": TaskState.REMOTE_ERROR.value,
            "job_id": job_id,
        })
    elif new_status == "QUEUED":
        db.update_task(task_id, status=TaskState.QUEUED.value, last_polled_at=now)
        # Broadcast status update
        from catgo.workflow.engine.broadcast import broadcast
        wf_id = task.get("workflow_id", "")
        await broadcast(wf_id, {
            "type": "task_status",
            "task_id": task_id,
            "status": TaskState.QUEUED.value,
            "job_id": job_id,
        })
    elif new_status == "RUNNING":
        db.update_task(task_id, status=TaskState.RUNNING.value, last_polled_at=now)
        # Broadcast status update
        from catgo.workflow.engine.broadcast import broadcast
        wf_id = task.get("workflow_id", "")
        await broadcast(wf_id, {
            "type": "task_status",
            "task_id": task_id,
            "status": TaskState.RUNNING.value,
            "job_id": job_id,
        })


async def _extract_orca_stage(hpc, task: dict) -> str | None:
    """Extract ORCA stage from remote output file.

    Returns the stage message if ORCA calculation is detected, None otherwise.
    """
    task_type = task.get("task_type", "")
    work_dir = task.get("work_dir")

    if not work_dir:
        return None

    # Resolve unified calc types (e.g. irc + software=orca → orca_irc)
    from workflow.node_sets import UNIFIED_CALC_NODES, _resolve_software
    if task_type in UNIFIED_CALC_NODES:
        import json
        params = json.loads(task.get("params_json", "{}") or "{}")
        task_type, _ = _resolve_software(task_type, params)

    # Only extract stage for ORCA calculations
    _ORCA_TYPES = {"orca_freq", "orca_irc", "orca_opt", "orca_neb_ts", "orca_sp", "orca_uvvis"}
    if task_type not in _ORCA_TYPES:
        return None

    try:
        # For all ORCA nodes, use parse_orca_progress from job_parser
        from catgo.utils.job_parser import parse_orca_progress

        conv_data = await hpc.run_on_owner(lambda: parse_orca_progress(hpc.conn, work_dir, task_type))

        # Extract stage message from convergence data
        if conv_data.points:
            last_point = conv_data.points[-1]
            step = last_point.step
            energy = last_point.energy

            if "neb" in task_type.lower():
                return f"NEB Image {step}: {energy:.6f} eV"
            elif task_type == "orca_irc":
                n_pts = len(conv_data.points)
                return conv_data.message or f"IRC Step {step}: {energy:.6f} Eh ({n_pts} points)"
            else:
                return f"Step {step}: {energy:.6f} eV"

        # Fallback: for freq/irc/uvvis, parse the raw output
        if task_type in ("orca_freq", "orca_irc", "orca_uvvis"):
            result = await hpc.run(
                f"test -f {work_dir}/ORCA.out && tail -c 10000 {work_dir}/ORCA.out || echo ''",
                check=False,
            )

            if result.exit_status != 0 or not result.stdout:
                return None

            # Parse stage from output tail
            if task_type == "orca_freq":
                stage_dict = get_orca_stage(result.stdout)
            elif task_type == "orca_irc":
                stage_dict = get_orca_irc_stage(result.stdout)
            elif task_type == "orca_uvvis":
                from catgo.utils.job_parser import parse_orca_uvvis_progress
                conv_data = await parse_orca_uvvis_progress(hpc, work_dir)
                if conv_data.success:
                    return conv_data.message
                return None
            else:
                return None

            return stage_dict.get("message")

        return None
    except Exception as e:
        logger.warning(f"Error extracting ORCA stage for {task_type}: {e}")
        return None

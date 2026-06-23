"""Workflow engine lifecycle — start, pause, resume, reset, cancel HPC jobs."""

from __future__ import annotations
import asyncio
import logging
import threading
from typing import Any, Optional

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.scanner import WorkflowEngine

logger = logging.getLogger(__name__)

# The engine runs in a dedicated daemon thread with its own asyncio loop.
# This isolates slow SQLite / SSH / subprocess work in scan_cycle from
# FastAPI's request-handling loop, so HTTP endpoints and MCP tool calls
# never stall on an engine operation.
_engine: WorkflowEngine | None = None
_engine_thread: threading.Thread | None = None
_engine_loop: asyncio.AbstractEventLoop | None = None
_engine_task: asyncio.Task | None = None
_engine_ready = threading.Event()


def get_engine() -> WorkflowEngine | None:
    """Get the global engine instance."""
    return _engine


def get_engine_loop() -> asyncio.AbstractEventLoop | None:
    """Return the engine's asyncio loop (running on a dedicated thread)."""
    return _engine_loop


def assert_engine_loop() -> None:
    """Sanity check — must be called from the engine loop.

    Triggers immediately (AssertionError) if a caller accidentally invokes
    engine-side SSH helpers from the FastAPI loop. The enforcement exists
    to make the one-way ownership invariant (FastAPI -> engine via
    call_soon_threadsafe; engine -> FastAPI via run_on_owner) impossible
    to violate silently.
    """
    if _engine_loop is None:
        return  # Engine not started yet (tests, cold start)
    try:
        current = asyncio.get_running_loop()
    except RuntimeError:
        return  # Not inside an async context; nothing to assert
    if current is not _engine_loop:
        raise AssertionError(
            f"assert_engine_loop: called on loop {id(current)} but engine "
            f"loop is {id(_engine_loop)}. Engine-only helpers must not be "
            f"invoked from FastAPI-side code."
        )


async def start_engine(db: WorkflowDB, config: dict[str, Any]) -> WorkflowEngine:
    """Start the global workflow engine in a dedicated thread.

    The engine gets its own asyncio event loop so its scan cycles never
    block the FastAPI request loop. The call returns once the engine loop
    is up and ready to accept cross-thread scheduling.
    """
    global _engine, _engine_thread, _engine_loop, _engine_task

    if _engine is not None:
        return _engine

    _engine = WorkflowEngine(db=db, config=config)
    _engine_ready.clear()

    def runner() -> None:
        global _engine_loop, _engine_task
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        _engine_loop = loop
        _engine._loop = loop  # expose to cancel_inflight for thread-safe cancel

        task = loop.create_task(_engine.run_forever())
        _engine_task = task
        _engine_ready.set()
        try:
            loop.run_until_complete(task)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Workflow engine thread crashed")
        finally:
            try:
                loop.close()
            except Exception:
                pass

    _engine_thread = threading.Thread(
        target=runner, daemon=True, name="workflow-engine",
    )
    _engine_thread.start()

    # Wait until the loop is set so subsequent call_soon_threadsafe users are safe.
    if not _engine_ready.wait(timeout=5.0):
        logger.error("Workflow engine thread failed to start within 5s")

    logger.info("Workflow engine started in dedicated thread")
    return _engine


async def stop_engine() -> None:
    """Stop the global engine scanner (thread-safe)."""
    global _engine, _engine_thread, _engine_loop, _engine_task

    if _engine_loop is not None and _engine_task is not None and not _engine_task.done():
        _engine_loop.call_soon_threadsafe(_engine_task.cancel)

    if _engine_thread is not None:
        _engine_thread.join(timeout=5.0)

    _engine = None
    _engine_thread = None
    _engine_loop = None
    _engine_task = None
    logger.info("Workflow engine stopped")


def submit_workflow(db: WorkflowDB, workflow_id: str) -> None:
    """Mark a workflow as running so the engine picks it up."""
    db.update_workflow(workflow_id, status="running")
    logger.info("Workflow %s submitted for execution", workflow_id)


def pause_workflow(db: WorkflowDB, workflow_id: str) -> None:
    """Pause a workflow — engine will skip it on next cycle."""
    db.update_workflow(workflow_id, status="paused")
    # Mark active tasks as paused
    for status in (TaskState.READY, TaskState.WAITING):
        tasks = db.get_tasks_by_status(workflow_id, status.value)
        for t in tasks:
            db.update_task(t["id"], status=TaskState.PAUSED.value)
    logger.info("Workflow %s paused", workflow_id)


def resume_workflow(db: WorkflowDB, workflow_id: str) -> None:
    """Resume a paused workflow."""
    # Unpause paused tasks back to WAITING
    tasks = db.get_tasks_by_status(workflow_id, TaskState.PAUSED.value)
    for t in tasks:
        db.update_task(t["id"], status=TaskState.WAITING.value)
    db.update_workflow(workflow_id, status="running")
    logger.info("Workflow %s resumed", workflow_id)


def reset_workflow(db: WorkflowDB, workflow_id: str) -> None:
    """Reset all tasks to WAITING and clear their HPC job binding.

    Clears hpc_job_id and work_dir so a re-run submits FRESH jobs. Previously a
    reset left the old hpc_job_id in place: on the next run the engine polled
    that (now-finished or cancelled) job, saw it gone, and marked the task
    FAILED instead of resubmitting — the whole workflow then failed without ever
    launching a new calculation.

    Sets workflow status to 'resetting' so the scanner skips it,
    then resets all task states with retry logic for DB lock contention.
    Always ensures the workflow ends in 'draft' status (never stuck in 'resetting').
    """
    # 1. Cancel any in-flight async tasks (MLP subprocess, analysis, etc.)
    engine = get_engine()
    if engine:
        engine.cancel_inflight(workflow_id)

    # 2. Tell the scanner to stop processing this workflow
    try:
        db.update_workflow(workflow_id, status="resetting")
    except Exception:
        pass

    # 2. Reset all tasks with retry, always restoring status on failure
    try:
        tasks = db.get_all_tasks(workflow_id)
        max_retries = 5
        for attempt in range(max_retries):
            try:
                for t in tasks:
                    db.update_task(t["id"],
                        status=TaskState.WAITING.value,
                        error_message=None,
                        error_type=None,
                        retry_count=0,
                        hpc_job_id=None,
                        work_dir=None,
                    )
                db.update_workflow(workflow_id, status="draft")
                logger.info("Workflow %s reset (%d tasks)", workflow_id, len(tasks))
                return
            except Exception as e:
                if "locked" in str(e).lower() and attempt < max_retries - 1:
                    logger.warning("Reset retry %d/%d for %s: %s", attempt + 1, max_retries, workflow_id, e)
                    # Brief non-blocking pause — acceptable since reset is synchronous
                    import time
                    time.sleep(0.2)
                else:
                    raise
    except Exception:
        # Always ensure we don't leave workflow stuck in "resetting"
        try:
            db.update_workflow(workflow_id, status="draft")
        except Exception:
            pass
        raise


# ---------------------------------------------------------------------------
# HPC job cancellation
# ---------------------------------------------------------------------------

_CANCELABLE_STATES = {
    TaskState.RUNNING.value,
    TaskState.SUBMITTED.value,
    TaskState.QUEUED.value,
}


async def cancel_workflow_jobs(
    db: WorkflowDB,
    workflow_id: str,
    only_task_ids: list[str] | None = None,
) -> list[dict]:
    """Cancel running/queued HPC jobs for a workflow (V2 DB).

    Args:
        db: V2 WorkflowDB instance.
        workflow_id: The workflow to cancel jobs for.
        only_task_ids: If provided, only cancel jobs for these task IDs.
                       If None, cancel all running/queued jobs.

    Returns list of {step_id, job_id, success, message} dicts.
    Best-effort: individual failures are logged but don't raise.
    """
    tasks = db.get_all_tasks(workflow_id)
    results = []

    for task in tasks:
        status = task.get("status", "")
        job_id = task.get("hpc_job_id")
        session_id = task.get("hpc_session_id")

        if not job_id or status not in _CANCELABLE_STATES:
            continue

        if only_task_ids is not None and task["id"] not in only_task_ids:
            continue

        success, message = await _cancel_single_job(session_id, job_id)
        results.append({
            "step_id": task["id"],
            "job_id": job_id,
            "success": success,
            "message": message,
        })

        if success:
            db.update_task(task["id"], status=TaskState.CANCELLED.value)

        level = logging.INFO if success else logging.WARNING
        logger.log(
            level,
            "Workflow %s: cancel job %s for task %s — %s",
            workflow_id, job_id, task["id"],
            "OK" if success else f"FAILED: {message}",
        )

    return results


async def _cancel_single_job(
    session_id: Optional[str], job_id: str,
) -> tuple[bool, str]:
    """Cancel a single HPC job via its scheduler.

    Returns (success, message). Never raises — errors are caught and
    returned as (False, error_message).
    """
    if not session_id:
        return False, "No session_id available for this task"

    try:
        from catgo.utils.hpc_client import pool

        hpc = pool.get_connection(session_id)
        if not hpc:
            # Try any available session as fallback
            for sid, conn in list(pool.connections.items()):
                if conn and conn.conn:
                    logger.info(
                        "Session %s unavailable, trying fallback session %s for job %s",
                        session_id, sid, job_id,
                    )
                    hpc = conn
                    break
            if not hpc:
                return False, f"HPC session '{session_id}' not connected and no fallback available"

        success, message = await hpc.run_on_owner(
            lambda: hpc.scheduler.cancel_job(hpc.conn, job_id)
        )
        if not success:
            logger.error("scancel failed for job %s: %s", job_id, message)
        return success, message
    except Exception as e:
        logger.error("Cancel job %s failed with exception: %s", job_id, e, exc_info=True)
        return False, f"Cancel failed: {e}"

"""Handle task completion and trigger result collection.

When a task transitions to COMPLETED_REMOTE status, this module collects
and parses the output files, storing results in the database for frontend
display and downstream node processing.
"""

from __future__ import annotations
import json
import shlex
import logging
from typing import Any, Optional

from catgo.workflow.db import WorkflowDB
from catgo.workflow.engine.result_collector import (
    collect_orca_freq_results,
    collect_orca_irc_results,
    collect_orca_opt_results,
    collect_orca_neb_results,
    collect_orca_sp_results,
    collect_orca_uvvis_results,
)

logger = logging.getLogger(__name__)


async def on_task_completed(
    db: WorkflowDB,
    task: dict[str, Any],
    hpc_connection: Any,
) -> None:
    """Trigger result collection when a task completes.

    Called by poller.py when task transitions to COMPLETED_REMOTE.

    This function:
    1. Routes to the appropriate result collector based on task_type
    2. Reads and parses output files from HPC
    3. Stores results in database (tasks.outputs_json)
    4. Logs success/failure for debugging

    If result collection fails, the error is stored in outputs_json
    instead of failing the entire task (task already completed on HPC).
    """
    task_id = task["id"]
    task_type = task.get("task_type", "")
    work_dir = task.get("work_dir")

    if not work_dir:
        logger.warning(f"Task {task_id}: no work_dir, skipping result collection")
        return

    # Resolve unified calc types to engine-specific types
    # (e.g., "geo_opt" + software="orca" -> "orca_opt")
    params = json.loads(task.get("params_json", "{}") or "{}")
    from catgo.workflow.engine.hpc_utils import map_task_type_to_engine
    resolved_type, engine_key = map_task_type_to_engine(task_type, params)

    # Map task types to their result collectors (exact match, order-independent)
    _ORCA_COLLECTORS = {
        "orca_freq": ("ORCA freq", collect_orca_freq_results),
        "orca_irc": ("ORCA IRC", collect_orca_irc_results),
        "orca_sp": ("ORCA SP", collect_orca_sp_results),
        "orca_uvvis": ("ORCA UV-Vis", collect_orca_uvvis_results),
        "orca_opt": ("ORCA opt", collect_orca_opt_results),
        "orca_neb_ts": ("ORCA NEB-TS", collect_orca_neb_results),
    }

    published: tuple | None = None
    try:
        collector_entry = _ORCA_COLLECTORS.get(resolved_type)
        if collector_entry:
            label, collector_fn = collector_entry
            outputs = await collector_fn(hpc_connection, work_dir, task_id)
            workflow_id = task.get("workflow_id", "")

            # For NEB-TS: also extract the TS structure now, while the SSH
            # connection is alive.  Stage 2 (collector.py) may fail if the
            # connection drops before the next scanner cycle.
            extra_fields: dict[str, Any] = {}
            if resolved_type == "orca_neb_ts":
                ts_xyz = await _read_neb_ts_structure(hpc_connection, work_dir)
                if ts_xyz:
                    extra_fields["structure_json"] = ts_xyz
                    logger.info(f"Task {task_id}: extracted NEB-TS structure ({len(ts_xyz)} bytes)")

            # Store results in task_results table
            db.store_result(task_id, workflow_id, outputs_json=outputs, **extra_fields)
            logger.info(f"Task {task_id}: collected {label} results")
            published = (hpc_connection, work_dir, task_id, resolved_type)
        else:
            logger.debug(f"Task {task_id}: no result collector for {task_type}")

    except Exception as e:
        logger.error(
            f"Task {task_id}: result collection failed: {e}",
            exc_info=True
        )
        # Don't fail the task — it already completed on HPC
        # Store error message instead for frontend display
        error_output = json.dumps({
            "error": f"Result collection failed: {str(e)}",
            "error_type": type(e).__name__,
        })
        workflow_id = task.get("workflow_id", "")
        db.store_result(task_id, workflow_id, outputs_json=error_output)
        return

    # OUTSIDE the try: `store_result` is INSERT OR REPLACE, and the handler above
    # overwrites the committed scientific results with an error row. A display
    # side-effect must never be able to trigger that.
    if published:
        await _publish_path_trajectory(*published)


# A path calculation already writes its whole path as one multi-frame XYZ, so
# the reaction can be ANIMATED instead of reduced to a barrier number. Read it
# while the SSH connection is still alive, like the TS structure above.
# ponytail: ORCA only — a VASP NEB keeps its images in `00/`…`NN/` sub-dirs and
# needs N reads plus an ordering rule; add that when a VASP NEB collector exists
# (today nothing collects one).
_PATH_TRAJECTORY_FILES = {
    "orca_neb_ts": ("ORCA_MEP_trj.xyz", "ORCA_MEP_ALL_trj.xyz"),
    "orca_irc": ("ORCA_IRC_Full_trj.xyz",),
}
# The viewer animates a path, not a production MD run. Above this the transfer
# costs more than the picture is worth — say so in the log rather than stalling
# the SSE bus with megabytes.
_MAX_PATH_TRAJECTORY_BYTES = 8_000_000


async def _publish_path_trajectory(
    hpc_connection: Any, work_dir: str, task_id: str, resolved_type: str
) -> None:
    """Push a finished path calculation into the viewer as an animation."""
    candidates = _PATH_TRAJECTORY_FILES.get(resolved_type)
    if not candidates or not work_dir:
        return
    for name in candidates:
        path = f"{work_dir}/{name}"
        try:
            quoted = shlex.quote(path)
            sized = await hpc_connection.run_on_owner(
                lambda q=quoted: hpc_connection.conn.run(
                    f"stat -c %s {q}", check=False
                )
            )
            if sized.exit_status != 0:
                continue
            size = int((sized.stdout or "0").strip() or 0)
            if size > _MAX_PATH_TRAJECTORY_BYTES:
                logger.info(
                    "Task %s: %s is %d bytes, too large to animate — skipping",
                    task_id, name, size,
                )
                continue
            read = await hpc_connection.run_on_owner(
                lambda q=quoted: hpc_connection.conn.run(f"cat {q}", check=False)
            )
            content = read.stdout or ""
            if read.exit_status != 0 or content.count("\n") < 4:
                continue
            from catgo.routers import view_state

            # NOT `last_active_panel_id`: that is by definition the pane the human
            # is touching, and push_trajectory is DESTRUCTIVE — it pops
            # `panel_structures` for that panel. A job finishing in the background
            # would delete the slab the user is editing, and the next tool that
            # auto-injects "the current structure" would silently pick up some
            # other pane's geometry. The remote/External pane is the inbox for
            # anything the user did not initiate.
            view_state.push_trajectory("default", content, name)
            logger.info("Task %s: pushed %s to the viewer (%d bytes)", task_id, name, size)
            return
        except Exception:
            logger.debug("Task %s: could not publish %s", task_id, name, exc_info=True)
    return


async def _read_neb_ts_structure(hpc_connection: Any, work_dir: str) -> Optional[str]:
    """Read the converged TS structure from the dedicated NEB-TS XYZ file.

    ORCA writes ORCA_NEB-TS_converged.xyz (~1KB) on convergence.
    This is far more reliable than re-extracting from the ~5MB ORCA.out.
    Falls back to ORCA.out extraction if the converged file is missing.
    """
    # Try authoritative converged XYZ files first
    for suffix in ("_NEB-TS_converged.xyz", "_NEB-CI_converged.xyz"):
        try:
            ts_file = f"{work_dir}/ORCA{suffix}"
            result = await hpc_connection.run_on_owner(
                lambda ts_file=ts_file: hpc_connection.conn.run(f"cat {ts_file}", check=False)
            )
            if result.exit_status == 0 and result.stdout and len(result.stdout.strip()) > 5:
                logger.info("Read NEB-TS converged structure from %s", ts_file)
                return result.stdout
        except Exception:
            continue

    # Fallback: extract last coordinate block from ORCA.out
    try:
        from catgo.workflow.engine.result_collector import _extract_xyz_from_orca_output
        result = await hpc_connection.run_on_owner(
            lambda: hpc_connection.conn.run(f"cat {work_dir}/ORCA.out", check=False)
        )
        if result.exit_status == 0 and result.stdout:
            xyz_str = _extract_xyz_from_orca_output(result.stdout, "orca_neb_ts")
            if xyz_str:
                logger.info("Extracted NEB-TS structure from ORCA.out (converged XYZ not found)")
                return xyz_str
    except Exception as e:
        logger.debug("Failed to extract NEB-TS structure from ORCA.out: %s", e)

    return None

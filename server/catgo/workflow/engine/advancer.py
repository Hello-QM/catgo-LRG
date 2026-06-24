"""Advance WAITING tasks to READY when all parents are COMPLETED.

HPC tasks go to PENDING_REVIEW instead of READY unless auto_submit is enabled.
When a task enters PENDING_REVIEW, input files are generated locally so the
user can inspect and edit them before HPC submission.
"""

from __future__ import annotations
import json
import logging
from pathlib import Path

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.task_decorator import get_task_definition
from catgo.workflow.engine.broadcast import broadcast as _broadcast

logger = logging.getLogger(__name__)

# States that count as "done" for dependency purposes
_DONE_STATES = {TaskState.COMPLETED.value, TaskState.SKIPPED.value, TaskState.MAPPED.value}


def _broadcast_status(workflow_id: str, task_id: str, status: str) -> None:
    """Fire-and-forget broadcast of a task status change to WebSocket listeners."""
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        loop.create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": status})
        )
    except RuntimeError:
        pass  # No event loop — unit tests or CLI context

# Nodes that require ALL parent structures in a single job (not independent fan-out tasks).
# These nodes inherently need multiple parents to be processed together.
# ORCA NEB-TS requires both reactant and product structures in the same calculation.
_MULTI_PARENT_SINGLE_EXEC_NODES = frozenset({"orca_neb_ts", "ts_search"})

# Local preview directory prefix — used to detect local paths in file endpoints
PREVIEW_DIR_PREFIX = str(Path.home() / ".catgo" / "preview")


def _evaluate_condition(db: WorkflowDB, condition: dict) -> bool:
    """Check whether a task's condition_json is satisfied.

    condition format: {"source_task_id": "xxx", "output_key": "key", "expected": value}
    Returns True if the condition is met (task should proceed).
    """
    result = db.get_result(condition["source_task_id"])
    if not result:
        return True  # no result yet, assume condition met
    # Check outputs_json first, then top-level columns
    outputs = {}
    if result.get("outputs_json"):
        try:
            outputs = json.loads(result["outputs_json"]) if isinstance(result["outputs_json"], str) else result["outputs_json"]
        except (json.JSONDecodeError, TypeError):
            pass
    output_key = condition["output_key"]
    if output_key in outputs:
        actual = outputs[output_key]
    else:
        actual = result.get(output_key)
    return actual == condition.get("expected", True)


def _get_auto_submit(db: WorkflowDB, workflow_id: str) -> bool:
    """Check if the workflow has auto_submit enabled in config_json."""
    try:
        wf = db.get_workflow(workflow_id)
        config_raw = wf.get("config_json", "{}")
        config = json.loads(config_raw) if isinstance(config_raw, str) else (config_raw or {})
        return bool(config.get("auto_submit", False))
    except Exception:
        return False


def _ready_state_for_task(task: dict, auto_submit: bool) -> TaskState:
    """Determine whether a task should go to READY or PENDING_REVIEW.

    Local tasks always go straight to READY.
    HPC tasks go to PENDING_REVIEW unless auto_submit is True.
    """
    task_type = task.get("task_type", "")
    defn = get_task_definition(task_type)
    is_local = defn.local if defn else False
    if is_local or auto_submit:
        return TaskState.READY
    return TaskState.PENDING_REVIEW


def advance_waiting_tasks(db: WorkflowDB, workflow_id: str) -> list[str]:
    """Check all WAITING tasks: if all parents COMPLETED/SKIPPED, set to READY.

    If a task has a condition_json and the condition is not met, the task
    is set to SKIPPED instead of READY.

    HPC tasks are set to PENDING_REVIEW instead of READY unless the workflow
    config has ``auto_submit: true``.

    Returns list of task IDs that were advanced to READY/PENDING_REVIEW (or SKIPPED).
    """
    waiting = db.get_tasks_by_status(workflow_id, TaskState.WAITING.value)
    advanced = []
    auto_submit = _get_auto_submit(db, workflow_id)

    for task in waiting:
        task_id = task["id"]
        parents = db.get_task_parents(task_id)

        if not parents:
            # No parents — check condition then set ready
            condition = _parse_condition(task)
            if condition is not None and not _evaluate_condition(db, condition):
                db.update_task(task_id, status=TaskState.SKIPPED.value)
                advanced.append(task_id)
                logger.info("Task %s: WAITING -> SKIPPED (condition not met, no parents)", task_id)
                continue
            target = _ready_state_for_task(task, auto_submit)
            db.update_task(task_id, status=target.value)
            _broadcast_status(workflow_id, task_id, target.value)
            if target == TaskState.PENDING_REVIEW:
                try:
                    _generate_local_preview(db, task, workflow_id)
                except Exception as e:
                    logger.warning("Failed to generate preview files for %s: %s", task_id, e)
            advanced.append(task_id)
            logger.info("Task %s: WAITING -> %s (no parents)", task_id, target.value)
            continue

        # Check all parent tasks are done (COMPLETED, SKIPPED, or MAPPED)
        all_done = True
        for link in parents:
            parent = db.get_task(link["source_task_id"])
            if parent["status"] not in _DONE_STATES:
                all_done = False
                break

        if all_done:
            # Check condition before advancing
            condition = _parse_condition(task)
            if condition is not None and not _evaluate_condition(db, condition):
                db.update_task(task_id, status=TaskState.SKIPPED.value)
                advanced.append(task_id)
                logger.info("Task %s: WAITING -> SKIPPED (condition not met)", task_id)
                continue
            target = _ready_state_for_task(task, auto_submit)
            db.update_task(task_id, status=target.value)
            _broadcast_status(workflow_id, task_id, target.value)
            if target == TaskState.PENDING_REVIEW:
                try:
                    _generate_local_preview(db, task, workflow_id)
                except Exception as e:
                    logger.warning("Failed to generate preview files for %s: %s", task_id, e)
            advanced.append(task_id)
            logger.info("Task %s: WAITING -> %s (all parents done)", task_id, target.value)

    return advanced


def _parse_condition(task: dict) -> dict | None:
    """Parse condition_json from a task dict, returning None if absent."""
    raw = task.get("condition_json")
    if not raw:
        return None
    try:
        cond = json.loads(raw) if isinstance(raw, str) else raw
        return cond if isinstance(cond, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


def _generate_local_preview(db: WorkflowDB, task: dict, workflow_id: str) -> None:
    """Generate input files to a local directory for pre-submission review.

    Creates files under ``~/.catgo/preview/<task_id>/`` and stores the path
    in the task's ``work_dir`` so the file-content endpoints can serve them.
    """
    from catgo.workflow.engine.resolver import resolve_task_inputs, primary_structure_input
    from catgo.workflow.engine.hpc_utils import map_task_type_to_engine

    task_id = task["id"]
    task_type = task["task_type"]
    params = json.loads(task.get("params_json", "{}") or "{}")

    # Resolve inputs from parent tasks
    inputs = resolve_task_inputs(db, task_id)
    structure_str = primary_structure_input(inputs.get("structure"))

    # Stash product structure for NEB-TS (same pattern as submitter.py)
    if inputs.get("structure_product"):
        params["_resolved_product_structure"] = inputs["structure_product"]
    elif inputs.get("product_structure"):
        # Legacy fallback
        params["_resolved_product_structure"] = inputs["product_structure"]
    elif task_type in ("neb", "ts_search"):
        # NEB endpoints wired to the same `structure` port (two parents, e.g.
        # reactant_opt + product_opt → neb) instead of structure/structure_product.
        # Use the first structure as initial (already structure_str) and the
        # second as the product endpoint. Mirrors orca._resolve_neb_product.
        structs = inputs.get("structure")
        if isinstance(structs, list) and len(structs) > 1:
            params["_resolved_product_structure"] = structs[1]

    # Create local preview directory keyed on the bare graph node_id (not the
    # namespaced task id) so the path stays stable and matches submitter.py.
    node_id = task.get("node_id") or task_id
    preview_dir = Path.home() / ".catgo" / "preview" / node_id
    preview_dir.mkdir(parents=True, exist_ok=True)

    # Resolve engine type
    resolved_type, engine_key = map_task_type_to_engine(task_type, params)

    # Use engine generator to create files locally
    from catgo.workflow.engine.engine_builtins import _generate_inputs_local
    _generate_inputs_local(str(preview_dir), resolved_type, engine_key, params, structure_str)

    # Store preview dir in task so file endpoints can serve it
    db.update_task(task_id, work_dir=str(preview_dir))
    logger.info("Generated preview files for task %s in %s", task_id, preview_dir)

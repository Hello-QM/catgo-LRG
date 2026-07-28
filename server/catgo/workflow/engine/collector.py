"""Collect results from HPC for COMPLETED_REMOTE tasks."""

from __future__ import annotations
import json
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.hpc_utils import get_hpc_connection, map_task_type_to_engine

logger = logging.getLogger(__name__)


async def collect_completed_tasks(
    db: WorkflowDB, workflow_id: str, config: dict[str, Any],
) -> list[str]:
    """Read results from HPC for all COMPLETED_REMOTE tasks.

    Returns list of task IDs that were successfully collected.
    """
    tasks = db.get_tasks_by_status(workflow_id, TaskState.COMPLETED_REMOTE.value)
    collected = []

    for task in tasks:
        task_id = task["id"]
        db.update_task(task_id, status=TaskState.COLLECTING.value)

        try:
            await _collect_one(db, task, workflow_id, config)
            collected.append(task_id)
        except Exception as e:
            logger.error("Task %s: result collection failed: %s", task_id, e, exc_info=True)
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message=f"Result collection failed: {e}",
                error_type="transient",
            )

    return collected


async def _collect_one(
    db: WorkflowDB, task: dict, workflow_id: str, config: dict,
) -> None:
    """Collect results for a single task."""
    task_id = task["id"]
    task_type = task["task_type"]
    work_dir = task.get("work_dir", "")
    job_id = task.get("hpc_job_id", "")
    session_id = task.get("hpc_session_id", "")
    params = json.loads(task.get("params_json", "{}") or "{}")

    # Check if result_handler already collected and stored results (during polling)
    existing_result = db.get_result(task_id)
    if existing_result and existing_result.get("outputs_json"):
        task_outputs_raw = existing_result.get("outputs_json")
        try:
            task_outputs = json.loads(task_outputs_raw) if isinstance(task_outputs_raw, str) else task_outputs_raw
            # Only skip if result_handler stored successfully AND structure_json is
            # already populated.  result_handler stores parsed ORCA results (frequencies,
            # convergence, NEB data) but does NOT extract the output structure.  If we
            # skip here when structure_json is NULL, downstream nodes will never receive
            # the structure from this task.
            has_structure = bool(existing_result.get("structure_json"))
            if isinstance(task_outputs, dict) and "error" not in task_outputs and has_structure:
                logger.debug(f"Task {task_id}: result_handler already collected results (with structure), skipping second collector")
                db.update_task(task_id, status=TaskState.COMPLETED.value)
                logger.info("Task %s (%s): COMPLETED_REMOTE -> COMPLETED", task_id, task_type)
                return
        except (json.JSONDecodeError, TypeError):
            pass

    hpc = await get_hpc_connection(task, config)
    if not hpc:
        raise RuntimeError("No HPC connection for result collection")

    resolved_type, engine_key = map_task_type_to_engine(task_type, params)

    # Use pluggable collector registry — each engine registers its own collector
    from catgo.workflow.engine.engine_registry import get_result_collector
    collector = get_result_collector(engine_key)
    if not collector:
        raise RuntimeError(f"No collector registered for '{engine_key}'. "
                          f"Register one with @register_collector('{engine_key}')")
    result = await collector(hpc, work_dir, task_id, resolved_type, params, session_id, job_id)

    # If result_handler already collected parsed results, merge them instead of replacing
    task_outputs_raw = None
    if existing_result:
        task_outputs_raw = existing_result.get("outputs_json")
    if task_outputs_raw:
        try:
            task_outputs = json.loads(task_outputs_raw) if isinstance(task_outputs_raw, str) else task_outputs_raw
            if isinstance(task_outputs, dict) and "error" not in task_outputs:
                # Merge: generic result provides structure/energy/wavefunction,
                # rich data provides detailed results (freq, IRC, NEB)
                merged = {**result, **task_outputs}
                # Preserve keys from generic collector that rich data doesn't have
                for keep_key in ("structure", "energy", "energy_eh", "wavefunction_file"):
                    if keep_key in result and keep_key not in task_outputs:
                        merged[keep_key] = result[keep_key]
                result = merged
        except (json.JSONDecodeError, TypeError):
            pass

    _store_result(db, task_id, workflow_id, result)
    db.update_task(task_id, status=TaskState.COMPLETED.value)
    logger.info("Task %s (%s): COMPLETED_REMOTE -> COMPLETED", task_id, task_type)


def _store_result(db: WorkflowDB, task_id: str, workflow_id: str, result: dict) -> None:
    """Map the result dict to task_results columns.

    Handles both legacy key names (VASP era) and ORCA parser output keys,
    normalizing them for storage in the database.
    """
    fields: dict[str, Any] = {}

    if "energy" in result:
        fields["energy"] = result["energy"]
    if "structure" in result:
        s = result["structure"]
        fields["structure_json"] = s if isinstance(s, str) else json.dumps(s)

    # ====== ORCA Frequency Output (OrcaFreqOutput) ======
    # Parser returns: "frequencies" (list of dicts with frequency_cm and imaginary flag)
    # Need to split into: "real_freqs_json", "imag_freqs_json" for frontend
    if "frequencies" in result:
        frequencies = result["frequencies"]
        # Each freq is {"index": int, "frequency_cm": float, "imaginary": bool, "ir_intensity_km_mol": float}
        real_freqs = [f["frequency_cm"] for f in frequencies if not f.get("imaginary", False)]
        imag_freqs = [f["frequency_cm"] for f in frequencies if f.get("imaginary", False)]

        # Presence of a parsed frequency payload is distinct from absence of
        # frequency analysis.  Persist empty lists too, so a verified minimum
        # (zero imaginary modes) does not become an ambiguous SQL NULL.
        fields["real_freqs_json"] = json.dumps(real_freqs)
        fields["imag_freqs_json"] = json.dumps(imag_freqs)

    # ORCA parsers expose both Hartree and eV values.  task_results.energy is
    # the common eV column used by enriched-result consumers.
    if "energy" not in fields and "energy_ev" in result:
        fields["energy"] = result["energy_ev"]

    # Fallback for old-style keys (if any other code returns direct lists)
    if "real_freqs" in result:
        fields["real_freqs_json"] = json.dumps(result["real_freqs"])
    if "imag_freqs" in result:
        fields["imag_freqs_json"] = json.dumps(result["imag_freqs"])

    # ====== Non-ORCA Optimization/Structure Output ======
    if "positions" in result:
        fields["positions_json"] = json.dumps(result["positions"])
    if "masses" in result:
        fields["masses_json"] = json.dumps(result["masses"])

    # ====== Thermochemistry Data ======
    # Handle both ORCA key names (zpe_eh, gibbs_eh) and legacy names
    if "zpe_eh" in result:
        fields["zpe"] = result["zpe_eh"]
    elif "zpe_kj_mol" in result:
        # ORCA freq parser also returns zpe_kj_mol, use Hartree version if available
        fields["zpe"] = result.get("zpe_eh") or result["zpe_kj_mol"]
    elif "zpe" in result or "zpe_ev" in result:
        fields["zpe"] = result.get("zpe") or result.get("zpe_ev")

    if "gibbs_eh" in result:
        fields["gibbs"] = result["gibbs_eh"]
    elif "gibbs" in result:
        fields["gibbs"] = result["gibbs"]

    # ====== Optional ORCA thermochemistry (OrcaFreqOutput only) ======
    # Store in outputs_json for later access if needed
    if "enthalpy_eh" in result:
        # Can add as optional field if needed, for now in outputs_json
        pass
    if "entropy_j_mol_k" in result:
        # Can add as optional field if needed, for now in outputs_json
        pass

    # Store full result as generic outputs for anything not mapped
    # This ensures no data is lost (IRC, UV-Vis, NEB data, etc.)
    fields["outputs_json"] = json.dumps(result, default=str)

    if fields:
        db.store_result(task_id, workflow_id, **fields)

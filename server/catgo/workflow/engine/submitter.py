"""Submit READY HPC tasks: generate inputs -> upload -> sbatch.

Supports auto-promotion to SLURM array jobs when multiple tasks of the
same type are READY (fan-out from a map task).
"""

from __future__ import annotations
import json
import logging
from collections import defaultdict
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.hpc_utils import get_hpc_connection, resolve_work_dir, map_task_type_to_engine
from catgo.workflow.engine.resolver import resolve_task_inputs, primary_structure_input
from catgo.workflow.engine.batch_submitter import ARRAY_JOB_THRESHOLD

logger = logging.getLogger(__name__)


async def submit_ready_tasks(
    db: WorkflowDB, workflow_id: str, config: dict[str, Any],
) -> list[str]:
    """Submit all READY HPC tasks for a workflow.

    When multiple READY tasks share the same task_type (fan-out from a map),
    they are auto-promoted to a single SLURM array job instead of individual
    sbatch calls. This matches the V1 engine's batch_execute.py pattern.

    Returns list of task IDs that were submitted.
    """
    ready = db.get_tasks_by_status(workflow_id, TaskState.READY.value)
    submitted: list[str] = []
    batch_size = config.get("engine", {}).get("submit_batch_size", 5)

    # Filter out local tasks and tasks handled by the scanner's local executor
    hpc_tasks: list[dict] = []
    # Check if this workflow runs in local mode
    wf_config = _get_workflow_config(db, workflow_id)
    wf_execution_mode = wf_config.get("execution_mode", "hpc")

    for task in ready[:batch_size]:
        from catgo.workflow.task_decorator import get_task_definition
        defn = get_task_definition(task["task_type"])
        if defn and defn.local:
            continue

        # Resolve node type for filtering
        from workflow.node_sets import MLP_NODES, ANALYSIS_NODES, LOCAL_NODES, BUILD_NODES, _resolve_software, UNIFIED_CALC_NODES
        task_type = task["task_type"]
        params = json.loads(task.get("params_json", "{}") or "{}")
        resolved = task_type
        if task_type in UNIFIED_CALC_NODES:
            resolved, _ = _resolve_software(task_type, params)

        # Always skip analysis/local/build nodes — scanner handles them regardless of mode
        if resolved in ANALYSIS_NODES or resolved in LOCAL_NODES or resolved in BUILD_NODES:
            continue

        # Skip MLP nodes only when execution_mode is "local" (HPC mode submits them normally)
        if wf_execution_mode == "local" and resolved in MLP_NODES:
            continue

        hpc_tasks.append(task)

    # Group by task_type — same-type groups above threshold get batch submission
    by_type: dict[str, list[dict]] = defaultdict(list)
    for task in hpc_tasks:
        by_type[task["task_type"]].append(task)

    batched_ids: set[str] = set()
    for task_type, group in by_type.items():
        if len(group) >= ARRAY_JOB_THRESHOLD:
            from catgo.workflow.engine.batch_submitter import submit_batch_tasks
            try:
                job_id = await submit_batch_tasks(
                    db, [t["id"] for t in group], workflow_id, config,
                )
                if job_id:
                    for t in group:
                        submitted.append(t["id"])
                        batched_ids.add(t["id"])
            except Exception as e:
                logger.error("Batch submit for %s failed: %s", task_type, e, exc_info=True)
                for t in group:
                    db.update_task(t["id"],
                        status=TaskState.REMOTE_ERROR.value,
                        error_message=f"Batch submit failed: {e}",
                        error_type="transient",
                    )
                    batched_ids.add(t["id"])

    # Submit remaining tasks individually (below batch threshold)
    for task in hpc_tasks:
        if task["id"] in batched_ids:
            continue
        task_id = task["id"]
        params = json.loads(task.get("params_json", "{}") or "{}")

        try:
            await _submit_one(db, task, workflow_id, params, config)
            submitted.append(task_id)
        except Exception as e:
            logger.error("Task %s submit failed: %s", task_id, e, exc_info=True)
            # Classify error: mid-job network glitches are transient,
            # but session-level failures (disconnected, not connected) are permanent
            err_str = str(e).lower()
            is_permanent_session = any(kw in err_str for kw in [
                "no longer connected", "not connected", "session expired",
                "disconnected", "no hpc connection",
            ])
            is_transient = not is_permanent_session and any(kw in err_str for kw in [
                "connection reset", "ssh", "sftp", "timeout", "network",
                "broken pipe", "reset by peer", "no route",
            ])
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message=f"Submit failed: {e}",
                error_type="transient" if is_transient else "permanent",
            )

    return submitted


def _is_local_session(task: dict, config: dict) -> bool:
    """Check if this task should run locally (not via HPC sbatch)."""
    from catgo.utils.hpc_client import LOCAL_SESSION_ID
    session_id = task.get("hpc_session_id") or ""
    if session_id == LOCAL_SESSION_ID:
        return True
    hpc_cfg = config.get("hpc", {})
    default_session = hpc_cfg.get("default_session_id") or hpc_cfg.get("default_session")
    return default_session == LOCAL_SESSION_ID


def _get_workflow_config(db: WorkflowDB, workflow_id: str) -> dict:
    """Load per-workflow config from DB config_json field."""
    try:
        wf = db.get_workflow(workflow_id)
        config_str = wf.get("config_json", "{}")
        if config_str:
            return json.loads(config_str)
    except Exception:
        pass
    return {}


def _resolve_cluster_config(wf_config: dict, session_id: str) -> dict:
    """Resolve cluster-specific config from per-workflow config.

    The frontend stores per-cluster settings under
    wf_config["cluster_configs"][session_id] with keys like:
      potcar_root, potcar_functional, vasp_command, module_loads,
      default_job_params, python_env, default_template

    Returns a flat dict of resolved settings, or empty dict if not found.
    """
    if not wf_config:
        return {}
    cluster_configs = wf_config.get("cluster_configs", {})
    # Try exact session_id match first
    if session_id and session_id in cluster_configs:
        return cluster_configs[session_id]
    # If only one cluster config exists, use it
    if len(cluster_configs) == 1:
        return next(iter(cluster_configs.values()))
    return {}


async def _submit_one(
    db: WorkflowDB, task: dict, workflow_id: str,
    params: dict, config: dict,
) -> None:
    """Submit a single task to HPC or run locally."""
    task_id = task["id"]
    task_type = task["task_type"]

    is_local = _is_local_session(task, config)

    # Load per-workflow config first (needed for session ID, work_dir, cluster config)
    wf_config = _get_workflow_config(db, workflow_id)

    # 1. Get HPC connection (or local connection for __local__)
    hpc = await get_hpc_connection(task, config, wf_config=wf_config)
    if not hpc:
        raise RuntimeError("No HPC connection available")

    # 2. Resolve node type and engine
    resolved_type, engine_key = map_task_type_to_engine(task_type, params)

    # 3. Resolve input structure from parent results
    inputs = resolve_task_inputs(db, task_id)
    structure_str = primary_structure_input(inputs.get("structure"))

    # 4. Resolve work directory (use per-workflow config for both local and HPC)
    work_dir = resolve_work_dir(task, workflow_id, config, wf_config=wf_config)

    # 5. Create directory
    db.update_task(task_id, status=TaskState.GENERATING.value, work_dir=work_dir)
    if is_local:
        import os
        os.makedirs(work_dir, exist_ok=True)
    else:
        await hpc.conn.run(f"mkdir -p {work_dir}", check=True)

    # 5.5 Check if preview files exist (from PENDING_REVIEW local generation)
    from pathlib import Path
    from catgo.workflow.engine.advancer import PREVIEW_DIR_PREFIX
    preview_dir = Path(PREVIEW_DIR_PREFIX) / task_id
    if preview_dir.exists() and any(preview_dir.iterdir()):
        # Upload existing (possibly user-edited) files instead of regenerating
        db.update_task(task_id, status=TaskState.UPLOADING.value)
        for f in preview_dir.iterdir():
            if f.is_file():
                content = f.read_bytes()
                if is_local:
                    (Path(work_dir) / f.name).write_bytes(content)
                else:
                    await hpc.conn.run(
                        f"cat > {work_dir}/{f.name}",
                        input=content, check=True,
                    )
        # Update work_dir
        db.update_task(task_id, work_dir=work_dir)
        # Clean up preview dir
        import shutil
        shutil.rmtree(preview_dir, ignore_errors=True)
        logger.info("Task %s: uploaded preview files from %s", task_id, preview_dir)
    else:
        # 6. Generate inputs via pluggable engine registry
        db.update_task(task_id, status=TaskState.UPLOADING.value)
        from catgo.workflow.engine.engine_registry import get_engine_generator
        generator = get_engine_generator(engine_key)
        if not generator:
            raise RuntimeError(f"No engine registered for '{engine_key}'. "
                              f"Register one with @register_engine('{engine_key}')")
        gen_params = params
        if engine_key == "lammps":
            gen_params = {**params, "_resolved_workflow_inputs": inputs}
        await generator(hpc, work_dir, resolved_type, gen_params, structure_str, config, task)

    session_id = task.get("hpc_session_id") or ""

    # --- Local execution path: run script directly via subprocess ---
    if is_local:
        await _run_local(db, task_id, workflow_id, engine_key, work_dir, session_id)
        return

    # --- HPC path: build job script and submit via sbatch ---
    # Resolve per-cluster config from workflow config (potcar, vasp_command, etc.)
    # Note: cluster_configs lives at the top level of wf_config, not under "hpc"
    cluster_cfg = _resolve_cluster_config(wf_config, session_id or getattr(hpc, 'session_id', ''))

    # 7. Build or use explicit job script
    # Priority: task params > wf_config job_script_template > generated script
    job_script = params.get("job_script", "")
    if not job_script or "#SBATCH" not in job_script:
        # Check workflow-level job_script_template (full SLURM script with headers)
        wf_template = wf_config.get("job_script_template", "")
        if wf_template and "#SBATCH" in wf_template:
            # Inject the wf_template into params so generate_job_script uses it
            # instead of the built-in default. generate_job_script handles all
            # {{nodes}}/{{ntasks}}/etc. replacements + run command injection.
            from catgo.workflow.engine.job_script import generate_job_script as _gen_js
            params_with_template = {**params, "job_script_template": wf_template}
            job_script = _gen_js(engine_key, work_dir, task, params_with_template, config)
        else:
            from catgo.workflow.engine.job_script import generate_job_script, generate_custodian_script
            # Resolve VASP command for custodian script
            hpc_cfg = config.get("hpc", {})
            vasp_cmd = (
                cluster_cfg.get("vasp_command")
                or hpc_cfg.get("run_commands", {}).get(engine_key)
                or "srun vasp_std"
            )
            job_script = generate_job_script(engine_key, work_dir, task, params, config)

            # Upload custodian script if needed
            custodian_py = generate_custodian_script(vasp_cmd, params, config)
            if custodian_py:
                await hpc.conn.run(
                    f"cat > {work_dir}/run_custodian.py << 'CATGO_EOF'\n{custodian_py}\nCATGO_EOF",
                    check=True,
                )

    # 8. Generate POTCAR on remote (for VASP)
    if engine_key == "vasp":
        potcar_root = (
            cluster_cfg.get("potcar_root")
            or config.get("hpc", {}).get("potcar_root", "")
        )
        potcar_func = (
            cluster_cfg.get("potcar_functional")
            or config.get("hpc", {}).get("potcar_functional", "potpaw_PBE")
        )
        if potcar_root:
            await _generate_potcar(hpc, work_dir, potcar_root, potcar_func)

    success, message, job_id = await _submit_job(
        hpc, work_dir, resolved_type, job_script, params, config,
    )

    if not success:
        raise RuntimeError(f"Job submission failed: {message}")

    db.update_task(task_id,
        status=TaskState.SUBMITTED.value,
        hpc_job_id=job_id,
        hpc_session_id=session_id or getattr(hpc, 'session_id', ''),
    )
    logger.info("Task %s: READY -> SUBMITTED (job %s)", task_id, job_id)


async def _run_local(
    db: WorkflowDB, task_id: str, workflow_id: str,
    engine_key: str, work_dir: str, session_id: str,
) -> None:
    """Run a task locally via subprocess instead of sbatch.

    For engines like MLP/xTB, this runs 'python run_mlp.py' directly.
    The task goes GENERATING -> RUNNING -> COMPLETED/FAILED.
    """
    import asyncio
    import sys

    from catgo.workflow.engine.job_script import _ENGINE_COMMANDS

    run_cmd = _ENGINE_COMMANDS.get(engine_key, "")
    if not run_cmd:
        raise RuntimeError(f"No run command for engine '{engine_key}' in local mode")

    db.update_task(task_id,
        status=TaskState.RUNNING.value,
        hpc_session_id=session_id,
    )
    logger.info("Task %s: running locally in %s (cmd=%s)", task_id, work_dir, run_cmd)

    # Split command and use current Python for 'python' commands
    cmd_parts = run_cmd.split()
    if cmd_parts[0] == "python":
        cmd_parts[0] = sys.executable

    proc = await asyncio.create_subprocess_exec(
        *cmd_parts,
        cwd=work_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await proc.communicate()
    stdout_str = stdout_bytes.decode("utf-8", errors="replace")
    stderr_str = stderr_bytes.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        error_msg = stderr_str or stdout_str or f"Exited with code {proc.returncode}"
        logger.error(
            "Task %s: local execution FAILED (exit %d)\nSTDOUT:\n%s\nSTDERR:\n%s",
            task_id, proc.returncode, stdout_str[:2000], stderr_str[:2000],
        )
        raise RuntimeError(error_msg[:2000])

    logger.info("Task %s: local execution completed successfully", task_id)
    # Mark as COMPLETED_REMOTE so the collector can pick up results
    db.update_task(task_id, status=TaskState.COMPLETED_REMOTE.value)
    logger.info("Task %s: RUNNING -> COMPLETED_REMOTE (local)", task_id)


async def _submit_job(
    hpc, work_dir: str, node_type: str, job_script: str,
    params: dict, config: dict,
) -> tuple[bool, str, str]:
    """Submit job to HPC scheduler. Returns (success, message, job_id).

    If job_script contains #SBATCH, write it as submit.sh and sbatch directly.
    Otherwise fall through to scheduler's auto-header generation.
    """
    if job_script and "#SBATCH" in job_script:
        # Write complete script and submit via sbatch
        script_path = f"{work_dir}/submit.sh"
        await hpc.conn.run(
            f"cat > {script_path} << 'CATGO_EOF'\n{job_script}\nCATGO_EOF", check=True
        )
        await hpc.conn.run(f"chmod +x {script_path}", check=True)
        result = await hpc.conn.run(f"cd {work_dir} && sbatch submit.sh", check=False)
        stdout = result.stdout.strip() if hasattr(result, 'stdout') else str(result)
        stderr = result.stderr.strip() if hasattr(result, 'stderr') and result.stderr else ""
        # Parse job ID from "Submitted batch job 12345"
        job_id = ""
        for word in stdout.split():
            if word.isdigit():
                job_id = word
                break
        if job_id:
            return (True, f"Job submitted: {job_id}", job_id)
        detail = stderr or stdout or "(no output)"
        return (False, f"sbatch failed: {detail}", "")
    else:
        return await hpc.scheduler.submit_job(
            hpc.conn,
            script_content=job_script or "",
            job_name=f"catgo-{node_type}",
            work_dir=work_dir,
            partition=params.get("partition"),
            nodes=params.get("nodes"),
            ntasks=params.get("ntasks"),
            cpus_per_task=params.get("cpus_per_task"),
            time_limit=params.get("walltime"),
            memory=params.get("memory"),
        )


# Recommended POTCAR variants (same as pymatgen defaults)
_POTCAR_VARIANTS = {
    "Li": "Li_sv", "Na": "Na_pv", "K": "K_sv", "Ca": "Ca_sv",
    "Sc": "Sc_sv", "Ti": "Ti_pv", "V": "V_pv", "Cr": "Cr_pv",
    "Mn": "Mn_pv", "Fe": "Fe_pv", "Co": "Co", "Ni": "Ni_pv",
    "Cu": "Cu_pv", "Zn": "Zn", "Ga": "Ga_d", "Ge": "Ge_d",
    "Rb": "Rb_sv", "Sr": "Sr_sv", "Y": "Y_sv", "Zr": "Zr_sv",
    "Nb": "Nb_pv", "Mo": "Mo_pv", "Ru": "Ru_pv", "Rh": "Rh_pv",
    "Pd": "Pd", "In": "In_d", "Sn": "Sn_d", "Cs": "Cs_sv",
    "Ba": "Ba_sv", "La": "La", "Hf": "Hf_pv", "Ta": "Ta_pv",
    "W": "W_pv", "Pt": "Pt", "Au": "Au", "Pb": "Pb_d", "Bi": "Bi_d",
}


async def _generate_potcar(
    hpc, work_dir: str, potcar_root: str, potcar_functional: str,
) -> None:
    """Concatenate POTCAR files on remote from POSCAR element order."""
    # Read POSCAR to get element order
    result = await hpc.conn.run(f"cat {work_dir}/POSCAR", check=False)
    if result.exit_status != 0 or not result.stdout.strip():
        logger.warning("Cannot read POSCAR for POTCAR generation")
        return

    lines = result.stdout.strip().split("\n")
    if len(lines) < 6:
        return
    # Element symbols are on line 6 (0-indexed: line 5)
    elements = lines[5].split()

    parts = []
    for el in elements:
        variant = _POTCAR_VARIANTS.get(el, el)
        parts.append(f"{potcar_root}/{potcar_functional}/{variant}/POTCAR")

    cat_cmd = f"cat {' '.join(parts)} > {work_dir}/POTCAR"
    result = await hpc.conn.run(cat_cmd, check=False)
    if result.exit_status != 0:
        logger.error("POTCAR generation failed: %s", result.stderr if hasattr(result, 'stderr') else "")
    else:
        logger.info("POTCAR generated from %d elements: %s", len(elements), elements)

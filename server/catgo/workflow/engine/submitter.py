"""Submit READY HPC tasks: generate inputs -> upload -> sbatch.

Supports auto-promotion to SLURM array jobs when multiple tasks of the
same type are READY (fan-out from a map task).
"""

from __future__ import annotations
import json
import logging
import shlex
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
            resolved = resolved or task_type

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
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message=f"Submit failed: {e}",
                error_type="transient",
            )

    return submitted


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


def _resolve_potcar_settings(config: dict) -> tuple[str, str]:
    """Return (potcar_root, potcar_functional) for VASP POTCAR generation.

    Reads from ``config["hpc"]["potcar_root"]`` first, then falls back to
    ``config["hpc"]["job_defaults"]["potcar_root"]``. The scanner only promotes
    potcar_root to the hpc root when a per-session cluster_config supplies it;
    when it comes from default_job_params it lands only in job_defaults. Reading
    just the root level silently skipped POTCAR generation and the VASP job died
    with "file not found ... POTCAR".
    """
    hpc_cfg = config.get("hpc", {}) or {}
    jd = hpc_cfg.get("job_defaults", {}) or {}
    root = hpc_cfg.get("potcar_root") or jd.get("potcar_root") or ""
    func = hpc_cfg.get("potcar_functional") or jd.get("potcar_functional") or "potpaw_PBE"
    return root, func


async def _submit_one(
    db: WorkflowDB, task: dict, workflow_id: str,
    params: dict, config: dict,
) -> None:
    """Submit a single task to HPC.

    ATOMIC: Verifies task is still READY before submission begins.
    If another cycle beat us here, this will detect it and abort early.
    """
    task_id = task["id"]
    task_type = task["task_type"]

    # GUARD: Verify task is still READY (not already submitted by another cycle)
    current_task = db.get_task(task_id)
    if current_task["status"] != TaskState.READY.value:
        logger.warning(
            "Task %s: skipping submission — already in %s state (another cycle submitted it)",
            task_id, current_task["status"],
        )
        return

    # Load per-workflow config (needed for session ID, work_dir, cluster config)
    wf_config = _get_workflow_config(db, workflow_id)

    # 1. Get HPC connection
    hpc = await get_hpc_connection(task, config)
    if not hpc:
        raise RuntimeError("No HPC connection available")

    # 2. Resolve node type and engine
    resolved_type, engine_key = map_task_type_to_engine(task_type, params)
    if not resolved_type:
        resolved_type = task_type
        engine_key = engine_key or "unknown"
        logger.warning("map_task_type_to_engine returned None for %s, using raw task_type", task_type)

    # 3. Resolve input structure from parent results
    inputs = resolve_task_inputs(db, task_id)
    structure_str = primary_structure_input(inputs.get("structure"))

    # 3.5 Stash extra inputs (e.g. product_structure for NEB-TS) in params
    #     so engine generators can access them without a DB reference.
    if resolved_type == "orca_neb_ts":
        logger.info(
            "NEB-TS submitter: resolved inputs keys=%s, structure=%s, structure_product=%s",
            list(inputs.keys()),
            bool(inputs.get("structure")),
            bool(inputs.get("structure_product")),
        )
    if inputs.get("structure_product"):
        params["_resolved_product_structure"] = inputs["structure_product"]
    elif inputs.get("product_structure"):
        # Legacy fallback — older workflows may use "product_structure" as key
        params["_resolved_product_structure"] = inputs["product_structure"]
    elif resolved_type in ("neb", "mlp_neb", "orca_neb_ts"):
        # NEB endpoints wired to the same `structure` port (two parents:
        # reactant_opt + product_opt) rather than structure/structure_product.
        # Take the second structure as the product endpoint.
        structs = inputs.get("structure")
        if isinstance(structs, list) and len(structs) > 1:
            params["_resolved_product_structure"] = structs[1]

    # Stash parent .gbw wavefunction path for ORCA SCF restart.
    # The wavefunction_file is not a linked handle — scan all parent results.
    if resolved_type.startswith("orca_"):
        parent_links = db.get_task_parents(task_id)
        for link in (parent_links or []):
            parent_result = db.get_result(link["source_task_id"])
            if parent_result:
                wfn = None
                # Check outputs_json first
                raw = parent_result.get("outputs_json")
                if raw:
                    try:
                        import json as _json
                        out = _json.loads(raw) if isinstance(raw, str) else raw
                        wfn = out.get("wavefunction_file") if isinstance(out, dict) else None
                    except Exception:
                        pass
                # Then check top-level result columns
                if not wfn:
                    wfn = parent_result.get("wavefunction_file")
                if wfn:
                    params["_resolved_wavefunction_file"] = wfn
                    break

    # 4. Resolve work directory (ignore local preview path from advancer)
    from catgo.workflow.engine.advancer import PREVIEW_DIR_PREFIX
    task_for_resolve = task
    if (task.get("work_dir") or "").startswith(PREVIEW_DIR_PREFIX):
        task_for_resolve = {**task, "work_dir": ""}
    work_dir = resolve_work_dir(task_for_resolve, workflow_id, config)

    # 5. Create remote directory. Persist work_dir only AFTER mkdir succeeds
    # so a failed attempt does not leave a stale path stickied to the row —
    # otherwise resolve_work_dir will reuse it on every subsequent retry.
    db.update_task(task_id, status=TaskState.GENERATING.value)
    await hpc.run_on_owner(lambda: hpc.conn.run(f"mkdir -p {work_dir}", check=True))
    db.update_task(task_id, work_dir=work_dir)

    # 5.5 Check if preview files exist (from PENDING_REVIEW local generation)
    from pathlib import Path
    # Keyed on the bare graph node_id (not the namespaced task id) to match the
    # path the advancer wrote the preview to in _generate_local_preview.
    node_id = task.get("node_id") or task_id
    preview_dir = Path(PREVIEW_DIR_PREFIX) / node_id
    if preview_dir.exists() and any(preview_dir.iterdir()):
        # Upload existing (possibly user-edited) files instead of regenerating
        db.update_task(task_id, status=TaskState.UPLOADING.value)
        for f in preview_dir.iterdir():
            if f.is_file():
                content = f.read_text(encoding="utf-8")
                await hpc.run_on_owner(lambda content=content, name=f.name: hpc.conn.run(
                    f"cat > {work_dir}/{name}",
                    input=content, check=True,
                ))
        # Update work_dir to HPC path
        db.update_task(task_id, work_dir=work_dir)
        # Clean up preview dir
        import shutil
        shutil.rmtree(preview_dir, ignore_errors=True)
        logger.info("Task %s: uploaded preview files from %s", task_id, preview_dir)
    else:
        # 6. Generate and upload inputs via pluggable engine registry
        db.update_task(task_id, status=TaskState.UPLOADING.value)
        from catgo.workflow.engine.engine_registry import get_engine_generator
        generator = get_engine_generator(engine_key)
        if not generator:
            raise RuntimeError(f"No engine registered for '{engine_key}'. "
                              f"Register one with @register_engine('{engine_key}')")
        gen_params = params
        if engine_key == "lammps":
            gen_params = {**params, "_resolved_workflow_inputs": inputs}
        # Input generators internally do `await write_remote_files(hpc.conn, ...)`
        # — run the whole generator on the connection's owner loop.
        await hpc.run_on_owner(
            lambda: generator(hpc, work_dir, resolved_type, gen_params, structure_str, config, task)
        )

    # 7. Build or use explicit job script
    session_id = task.get("hpc_session_id") or ""
    cluster_cfg = _resolve_cluster_config(wf_config, session_id or getattr(hpc, 'session_id', ''))
    from catgo.workflow.engine.job_script import generate_job_script, generate_custodian_script
    hpc_cfg = config.get("hpc", {})
    vasp_cmd = (
        cluster_cfg.get("vasp_command")
        or hpc_cfg.get("run_commands", {}).get(engine_key)
        or "srun vasp_std"
    )

    # Pick a template source. If a previous Run-dialog click stamped
    # params.job_script with a raw cluster template (still contains
    # `{{placeholders}}`), treat it as a template — NOT as a finished script
    # — so generate_job_script can substitute {{nodes}}/{{partition}}/etc and
    # apply engine-specific run_command + (for CP2K on a VASP-flavored
    # cluster template) swap in the CP2K built-in template.
    job_script_param = params.get("job_script", "")
    has_placeholders = "{{" in job_script_param and "}}" in job_script_param

    if job_script_param and _has_scheduler_directives(job_script_param) and not has_placeholders:
        # Fully-substituted explicit script — pass through unchanged.
        job_script = job_script_param
    else:
        template_source = ""
        if job_script_param and has_placeholders:
            template_source = job_script_param
        else:
            template_source = (
                wf_config.get("job_script_template", "")
                or wf_config.get("hpc", {}).get("job_script_template", "")
            )
        if template_source and _has_scheduler_directives(template_source):
            params_with_template = {**params, "job_script_template": template_source}
            params_with_template.pop("job_script", None)
            job_script = generate_job_script(engine_key, work_dir, task, params_with_template, config)
        else:
            params_no_stale_js = {k: v for k, v in params.items() if k != "job_script"}
            job_script = generate_job_script(engine_key, work_dir, task, params_no_stale_js, config)

    # Upload custodian script if needed
    custodian_py = generate_custodian_script(vasp_cmd, params, config)
    if custodian_py:
        await hpc.run_on_owner(lambda: hpc.conn.run(
            f"cat > {work_dir}/run_custodian.py << 'CATGO_EOF'\n{custodian_py}\nCATGO_EOF",
            check=True,
        ))

    # 8. Generate POTCAR on remote (for VASP)
    if engine_key == "vasp":
        potcar_root, potcar_func = _resolve_potcar_settings(config)
        if potcar_root:
            await _generate_potcar(hpc, work_dir, potcar_root, potcar_func)
        else:
            logger.warning(
                "Task %s: VASP node but no potcar_root in config (hpc root or "
                "job_defaults) — POTCAR NOT generated, the job will fail on a "
                "missing POTCAR", task_id)

    success, message, job_id = await _submit_job(
        hpc, work_dir, resolved_type, job_script, params, config,
    )

    if not success:
        raise RuntimeError(f"Job submission failed: {message}")

    # FIX #2: Force immediate polling to get initial HPC status
    # Instead of waiting for the next scan_cycle, check job status right now
    from datetime import datetime, timezone
    from catgo.workflow.engine.poller import _check_job

    now = datetime.now(timezone.utc).isoformat()
    initial_hpc_status = await _check_job(hpc, job_id)

    # Map HPC status to task state
    if initial_hpc_status == "QUEUED":
        task_status = TaskState.QUEUED.value
    elif initial_hpc_status == "RUNNING":
        task_status = TaskState.RUNNING.value
    else:
        # UNKNOWN or fallback: keep as SUBMITTED (will be polled next cycle)
        task_status = TaskState.SUBMITTED.value

    db.update_task(task_id,
        status=task_status,
        hpc_job_id=job_id,
        hpc_session_id=session_id or getattr(hpc, 'session_id', ''),
        last_polled_at=now,
    )

    logger.info(
        "Task %s: READY -> %s (job %s, initial HPC status: %s)",
        task_id, task_status, job_id, initial_hpc_status,
    )

    # Broadcast status update to WebSocket listeners
    from catgo.workflow.engine.broadcast import broadcast_stage_message, broadcast
    await broadcast_stage_message(workflow_id, task_id, f"Job {job_id} {initial_hpc_status.lower()}")
    await broadcast(workflow_id, {
        "type": "task_status",
        "task_id": task_id,
        "status": task_status,
        "job_id": job_id,
    })


async def _submit_job(
    hpc, work_dir: str, node_type: str, job_script: str,
    params: dict, config: dict,
) -> tuple[bool, str, str]:
    """Submit job to HPC scheduler. Returns (success, message, job_id).

    If job_script contains scheduler directives, write it as submit.sh and submit
    directly. Otherwise fall through to scheduler auto-header generation.
    """
    directive_kind = _scheduler_directive_kind(job_script)
    if directive_kind:
        submit_cmd = _submit_command_for_script(hpc, directive_kind)
        if not submit_cmd:
            return (False, f"Unsupported scheduler directive: {directive_kind}", "")

        script_path = f"{work_dir}/submit.sh"
        safe_script_path = shlex.quote(script_path)
        safe_work_dir = shlex.quote(work_dir)
        await hpc.run_on_owner(lambda: hpc.conn.run(
            f"cat > {safe_script_path} << 'CATGO_EOF'\n{job_script}\nCATGO_EOF", check=True
        ))
        await hpc.run_on_owner(lambda: hpc.conn.run(f"chmod +x {safe_script_path}", check=True))
        result = await hpc.run_on_owner(
            lambda: hpc.conn.run(f"cd {safe_work_dir} && {submit_cmd} submit.sh", check=False)
        )
        stdout = (result.stdout or "").strip() if hasattr(result, 'stdout') else str(result)
        stderr = (result.stderr or "").strip() if hasattr(result, 'stderr') else ""
        job_id = _parse_scheduler_job_id(stdout, directive_kind)
        if job_id:
            return (True, f"Job submitted: {job_id}", job_id)
        err_detail = stderr or stdout or "(no output)"
        return (False, f"{submit_cmd} failed: {err_detail}", "")

    scheduler_params = _scheduler_submit_params(params, config)
    return await hpc.run_on_owner(lambda: hpc.scheduler.submit_job(
        hpc.conn,
        script_content=job_script or "",
        job_name=f"catgo-{node_type}",
        work_dir=work_dir,
        partition=scheduler_params["partition"],
        nodes=scheduler_params["nodes"],
        ntasks=scheduler_params["ntasks"],
        cpus_per_task=scheduler_params["cpus_per_task"],
        time_limit=scheduler_params["walltime"],
        memory=scheduler_params["memory"],
    ))


def _has_scheduler_directives(job_script: str) -> bool:
    return _scheduler_directive_kind(job_script) is not None


def _scheduler_directive_kind(job_script: str) -> str | None:
    if not job_script:
        return None
    has_slurm = "#SBATCH" in job_script
    has_pbs = "#PBS" in job_script
    if has_pbs and not has_slurm:
        return "pbs"
    if has_slurm and not has_pbs:
        return "slurm"
    if has_pbs and has_slurm:
        return "mixed"
    return None


def _submit_command_for_script(hpc, directive_kind: str) -> str:
    scheduler_name = hpc.scheduler.__class__.__name__.lower()
    if directive_kind == "pbs":
        return "qsub"
    if directive_kind == "slurm":
        return "sbatch"
    if directive_kind == "mixed":
        if "pbs" in scheduler_name:
            return "qsub"
        if "slurm" in scheduler_name:
            return "sbatch"
    return ""


def _parse_scheduler_job_id(stdout: str, directive_kind: str) -> str:
    if not stdout:
        return ""
    words = stdout.split()
    if directive_kind == "pbs":
        return words[0].strip() if words else ""

    for word in reversed(words):
        if word.isdigit():
            return word
    return ""


def _scheduler_submit_params(params: dict, config: dict) -> dict:
    """Merge task params with workflow job defaults for scheduler auto-headers."""
    job_defaults = config.get("hpc", {}).get("job_defaults", {})

    def _pick(*keys: str, fallback=None):
        for source in (params, job_defaults):
            for key in keys:
                val = source.get(key)
                if val is not None and val != "":
                    return val
        return fallback

    def _as_int(value, fallback: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return fallback

    return {
        "partition": _pick("partition", "queue", fallback=None),
        "nodes": _as_int(_pick("nodes", fallback=1), 1),
        "ntasks": _as_int(_pick("ntasks", fallback=1), 1),
        "cpus_per_task": _as_int(_pick("cpus_per_task", "ppn", fallback=1), 1),
        "walltime": str(_pick("walltime", "time_limit", fallback="24:00:00")),
        "memory": _pick("memory", fallback=None),
    }


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
    """Concatenate POTCAR files on remote from POSCAR element order.

    Raises RuntimeError on any failure (unreadable POSCAR, a missing source
    POTCAR, a failed concat, or an empty result). The caller (_submit_one /
    submit_batch_tasks) turns the exception into a REMOTE_ERROR task so the
    failure is surfaced in the UI instead of silently submitting a VASP job
    with no POTCAR that later crashes on the cluster with no visible error.
    """
    wd = shlex.quote(work_dir)
    # Read POSCAR to get element order
    result = await hpc.run_on_owner(lambda: hpc.conn.run(f"cat {wd}/POSCAR", check=False))
    if result.exit_status != 0 or not result.stdout.strip():
        raise RuntimeError(f"Cannot read POSCAR for POTCAR generation in {work_dir}")

    lines = result.stdout.strip().split("\n")
    if len(lines) < 6:
        raise RuntimeError("POSCAR has fewer than 6 lines; cannot determine element order for POTCAR")
    # Element symbols are on line 6 (0-indexed: line 5)
    elements = lines[5].split()
    if not elements:
        raise RuntimeError("POSCAR line 6 lists no element symbols; cannot build POTCAR")

    parts = []
    for el in elements:
        variant = _POTCAR_VARIANTS.get(el, el)
        parts.append(f"{potcar_root}/{potcar_functional}/{variant}/POTCAR")

    # Verify every source POTCAR exists first, so the error names the culprit
    # element/path instead of leaving a partial or empty POTCAR behind.
    check_cmd = " ; ".join(f"test -f {shlex.quote(p)} || echo MISSING {p}" for p in parts)
    chk = await hpc.run_on_owner(lambda: hpc.conn.run(check_cmd, check=False))
    missing = [ln[len("MISSING "):] for ln in (chk.stdout or "").splitlines() if ln.startswith("MISSING ")]
    if missing:
        raise RuntimeError(
            "POTCAR source files not found (check POTCAR root/functional and "
            f"element→pseudopotential mapping): {', '.join(missing)}"
        )

    cat_cmd = f"cat {' '.join(shlex.quote(p) for p in parts)} > {wd}/POTCAR"
    result = await hpc.run_on_owner(lambda: hpc.conn.run(cat_cmd, check=False))
    if result.exit_status != 0:
        stderr = (getattr(result, "stderr", "") or "").strip()
        raise RuntimeError(f"POTCAR concatenation failed: {stderr or 'unknown error'}")

    # Sanity: a real POTCAR is never empty.
    size = await hpc.run_on_owner(lambda: hpc.conn.run(f"wc -c < {wd}/POTCAR", check=False))
    try:
        nbytes = int((size.stdout or "0").strip())
    except ValueError:
        nbytes = 0
    if nbytes <= 0:
        raise RuntimeError("Generated POTCAR is empty after concatenation")

    logger.info("POTCAR generated from %d elements: %s", len(elements), elements)

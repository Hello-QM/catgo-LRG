"""Batch submission: submit multiple tasks as a single SLURM array job.

When the submitter detects a fan-out (multiple READY tasks of the same type),
it auto-promotes them to a single ``sbatch --array=0-N%max_concurrent`` call
instead of N individual sbatch submissions. This matches the V1 engine's
batch_execute.py pattern but integrates with the V2 scanner/submitter.

Reuses existing engine_registry generators for input file creation and
job_script.py for SLURM script generation.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.hpc_utils import (
    get_hpc_connection,
    resolve_work_dir,
    map_task_type_to_engine,
)
from catgo.workflow.engine.resolver import resolve_task_inputs, primary_structure_input
from catgo.workflow.engine.job_script import generate_job_script
from catgo.workflow.engine.engine_registry import get_engine_generator

logger = logging.getLogger(__name__)

# Minimum number of same-type tasks before promoting to array job
ARRAY_JOB_THRESHOLD = 3


async def submit_batch_tasks(
    db: WorkflowDB,
    task_ids: list[str],
    workflow_id: str,
    config: dict[str, Any],
) -> str | None:
    """Submit multiple tasks as a single SLURM array job.

    All tasks must be the same task_type. Generates inputs into numbered
    subdirectories (000000/, 000001/, ...) under a shared batch directory,
    then submits one ``sbatch --array`` call.

    Returns the SLURM job_id, or None on failure.
    """
    n = len(task_ids)
    if n == 0:
        return None

    tasks = [db.get_task(tid) for tid in task_ids]
    first_task = tasks[0]
    params = json.loads(first_task.get("params_json", "{}") or "{}")
    resolved_type, engine_key = map_task_type_to_engine(first_task["task_type"], params)

    # Get HPC connection from the first task
    hpc = await get_hpc_connection(first_task, config)
    if not hpc:
        logger.error("No HPC connection for batch submission")
        return None

    # Batch directory: base_dir/workflow_id/batch_<task_type>.
    # Resolve base_dir the same way resolve_work_dir does — the run config sets
    # base_work_dir (promoted to hpc.base_work_dir by the scanner), NOT
    # paths.base_dir. Reading only paths.base_dir left base_dir empty, so the
    # batch dir became "/<workflow_id>/..." and mkdir failed with permission
    # denied at the filesystem root.
    base_dir = (
        config.get("paths", {}).get("base_dir")
        or config.get("hpc", {}).get("base_work_dir")
        or config.get("base_work_dir")
        or "~/calculations"
    )
    batch_dir = f"{base_dir}/{workflow_id}/batch_{first_task['task_type']}"

    # ── Phase 1: Generate inputs into numbered subdirectories ──
    generator = get_engine_generator(engine_key)
    if not generator:
        logger.error("No engine registered for '%s'", engine_key)
        return None

    await hpc.run_on_owner(lambda: hpc.conn.run(f"mkdir -p {batch_dir}", check=True))

    for i, task in enumerate(tasks):
        task_params = json.loads(task.get("params_json", "{}") or "{}")
        inputs = resolve_task_inputs(db, task["id"])
        structure_str = primary_structure_input(inputs.get("structure")) or ""
        if engine_key == "lammps":
            task_params = {**task_params, "_resolved_workflow_inputs": inputs}

        work_dir = f"{batch_dir}/{i:06d}"
        db.update_task(task["id"], status=TaskState.GENERATING.value, work_dir=work_dir)
        await hpc.run_on_owner(lambda wd=work_dir: hpc.conn.run(f"mkdir -p {wd}", check=True))
        await hpc.run_on_owner(lambda wd=work_dir, tp=task_params, ss=structure_str, t=task:
            generator(hpc, wd, resolved_type, tp, ss, config, t)
        )

        # Upload custodian script if needed (same as _submit_one in submitter.py)
        if engine_key == "vasp":
            from catgo.workflow.engine.job_script import generate_custodian_script
            hpc_cfg = config.get("hpc", {})
            vasp_cmd = hpc_cfg.get("run_commands", {}).get(engine_key) or "srun vasp_std"
            custodian_py = generate_custodian_script(vasp_cmd, task_params, config)
            if custodian_py:
                await hpc.run_on_owner(lambda wd=work_dir, py=custodian_py: hpc.conn.run(
                    f"cat > {wd}/run_custodian.py << 'CATGO_EOF'\n{py}\nCATGO_EOF",
                    check=True,
                ))
            # Generate POTCAR
            from catgo.workflow.engine.submitter import _generate_potcar
            potcar_root = hpc_cfg.get("potcar_root", "")
            potcar_func = hpc_cfg.get("potcar_functional", "potpaw_PBE")
            if potcar_root:
                await _generate_potcar(hpc, work_dir, potcar_root, potcar_func)

        db.update_task(task["id"], status=TaskState.UPLOADING.value)

    # ── Phase 2: Build array job script ──
    max_concurrent = config.get("hpc", {}).get("job_defaults", {}).get("max_concurrent", 50)

    # Generate a base job script from the first task
    job_script = generate_job_script(engine_key, "$TASK_DIR", first_task, params, config)

    # Inject --array directive and array-aware cd
    lines = job_script.split("\n")
    array_line = f"#SBATCH --array=0-{n - 1}%{max_concurrent}"
    cd_line = f'cd {batch_dir}/$(printf "%06d" $SLURM_ARRAY_TASK_ID)'

    # Find the last #SBATCH line to insert array directive after it
    last_sbatch = -1
    for i_line, line in enumerate(lines):
        if line.strip().startswith("#SBATCH"):
            last_sbatch = i_line

    if last_sbatch >= 0:
        lines.insert(last_sbatch + 1, array_line)
        # Fix output/error paths for array jobs: write logs into each subdirectory
        for i_line, line in enumerate(lines):
            if "#SBATCH --output=" in line:
                lines[i_line] = f'#SBATCH --output=%A_%a.out'
            elif "#SBATCH --error=" in line:
                lines[i_line] = f'#SBATCH --error=%A_%a.err'
        # Replace the existing "cd ..." line with the array-aware version
        replaced_cd = False
        for i_line, line in enumerate(lines):
            if line.strip().startswith("cd ") and "$TASK_DIR" in line:
                lines[i_line] = cd_line
                replaced_cd = True
                break
        if not replaced_cd:
            # Insert cd after the last SBATCH + array line
            insert_at = last_sbatch + 2
            while insert_at < len(lines) and (
                not lines[insert_at].strip() or lines[insert_at].strip().startswith("#")
            ):
                insert_at += 1
            lines.insert(insert_at, cd_line)
    else:
        lines = [f"#!/bin/bash", array_line, "", cd_line] + lines

    # Replace any remaining $TASK_DIR references
    array_script = "\n".join(lines).replace(
        "$TASK_DIR", f'{batch_dir}/$(printf "%06d" $SLURM_ARRAY_TASK_ID)'
    )

    # ── Phase 3: Write script and submit ──
    script_path = f"{batch_dir}/submit_array.sh"
    await hpc.run_on_owner(lambda: hpc.conn.run(
        f"cat > {script_path} << 'CATGO_EOF'\n{array_script}\nCATGO_EOF",
        check=True,
    ))
    await hpc.run_on_owner(lambda: hpc.conn.run(f"chmod +x {script_path}", check=True))

    result = await hpc.run_on_owner(
        lambda: hpc.conn.run(f"cd {batch_dir} && sbatch submit_array.sh", check=False)
    )
    stdout = result.stdout.strip() if hasattr(result, "stdout") else str(result)

    # Parse job ID from "Submitted batch job 12345"
    job_id = ""
    for word in stdout.split():
        if word.isdigit():
            job_id = word
            break

    if not job_id:
        logger.error("Batch submission failed: %s", stdout)
        for task in tasks:
            db.update_task(
                task["id"],
                status=TaskState.REMOTE_ERROR.value,
                error_message=f"Batch sbatch failed: {stdout}",
                error_type="transient",
            )
        return None

    # ── Phase 4: Update all tasks with array job IDs ──
    for i, task in enumerate(tasks):
        db.update_task(
            task["id"],
            status=TaskState.SUBMITTED.value,
            hpc_job_id=f"{job_id}_{i}",  # SLURM array task ID format
        )

    logger.info("Batch submitted %d tasks as array job %s", n, job_id)
    return job_id

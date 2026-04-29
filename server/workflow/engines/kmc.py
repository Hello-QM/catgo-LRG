"""KMC input generation for workflow engine.

Generates model.json and run script for the mykmc-rs Rust KMC binary
on HPC. The Rust binary must be pre-compiled on the cluster.
"""

import json
import logging
from typing import Any, Optional


logger = logging.getLogger(__name__)

__all__ = ["generate_kmc_inputs"]


async def generate_kmc_inputs(
    hpc: Any,
    work_dir: str,
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
    config: Any = None,
    session_id: str = "",
):
    """Generate KMC input files and upload to HPC.

    Files generated:
      - model.json   — KMC model definition (species, parameters, processes, lattice)
      - run_kmc.sh   — Wrapper script to invoke the mykmc Rust binary
    """
    from catgo.utils.job_parser import write_remote_file

    # ── 1. Build model.json from node params ──

    model_str = params.get("model_json", "")
    if not model_str:
        raise RuntimeError(
            "KMC node requires a model definition (model_json parameter). "
            "Use the C-N coupling network tool or paste a model JSON."
        )

    # Parse model — accept both string and dict
    if isinstance(model_str, str):
        try:
            model_data = json.loads(model_str)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Invalid model JSON: {e}")
    else:
        model_data = model_str

    # Override model parameters with node-level settings
    temperature = float(params.get("temperature", 300))
    potential = float(params.get("potential", 0.0))

    # Update T and U in the model's parameter list
    for p in model_data.get("parameters", []):
        if p["name"] == "T":
            p["value"] = temperature
        elif p["name"] == "U":
            p["value"] = potential

    model_json_str = json.dumps(model_data, indent=2)
    await write_remote_file(hpc.conn, f"{work_dir}/model.json", model_json_str)
    logger.info("Wrote model.json (%d bytes) to %s", len(model_json_str), work_dir)

    # ── 2. Determine run mode and build CLI arguments ──

    mode = params.get("mode", "both")
    lattice_size = int(params.get("lattice_size", 20))
    kmc_steps = int(params.get("kmc_steps", 100000))
    scan_type = params.get("scan_type", "none")
    cycle_flag = "--cycle" if params.get("cycle_mode", True) else ""

    # Resolve KMC binary path from config
    kmc_binary = "mykmc"  # default, user should have it in PATH
    if config and session_id:
        cluster = config.cluster_configs.get(session_id)
        if cluster and hasattr(cluster, "kmc_command") and cluster.kmc_command:
            kmc_binary = cluster.kmc_command

    # Build commands for the run script
    commands = []

    if scan_type == "potential":
        u_min = float(params.get("scan_u_min", -0.5))
        u_max = float(params.get("scan_u_max", -3.0))
        u_steps = int(params.get("scan_steps", 20))
        # Rust binary: scan-u subcommand
        commands.append(
            f'{kmc_binary} scan-u {cycle_flag} '
            f'--model model.json '
            f'--t {temperature} '
            f'--u-min {u_min} --u-max {u_max} --u-steps {u_steps} '
            f'--size {lattice_size} --steps {kmc_steps} '
            f'> potential_scan_results.dat 2>&1'
        )
    elif scan_type == "temperature":
        t_min = float(params.get("scan_t_min", 250))
        t_max = float(params.get("scan_t_max", 500))
        t_steps = int(params.get("scan_steps", 20))
        commands.append(
            f'{kmc_binary} scan-t {cycle_flag} '
            f'--model model.json '
            f'--u {potential} '
            f'--t-min {t_min} --t-max {t_max} --t-steps {t_steps} '
            f'--size {lattice_size} --steps {kmc_steps} '
            f'> temperature_scan_results.dat 2>&1'
        )
    else:
        # Single-point simulation
        if mode in ("kmc", "both"):
            commands.append(
                f'{kmc_binary} kmc {cycle_flag} '
                f'--model model.json '
                f'--t {temperature} --u {potential} '
                f'--size {lattice_size} --steps {kmc_steps} '
                f'> kmc_results.dat 2>&1'
            )
        if mode in ("mkm", "both"):
            commands.append(
                f'{kmc_binary} mkm {cycle_flag} '
                f'--model model.json '
                f'--t {temperature} --u {potential} '
                f'> mkm_results.dat 2>&1'
            )

    # ── 3. Generate run script ──

    run_script = "#!/bin/bash\n"
    run_script += f"# CatGO KMC simulation — {model_data.get('meta', {}).get('model_name', 'unnamed')}\n"
    run_script += f"# T={temperature} K, U={potential} V, mode={mode}, scan={scan_type}\n\n"
    run_script += f"cd {work_dir}\n\n"

    for i, cmd in enumerate(commands, 1):
        run_script += f"echo '=== Step {i}/{len(commands)}: {cmd.split()[1] if len(cmd.split()) > 1 else 'run'} ==='\n"
        run_script += f"{cmd}\n"
        run_script += f"echo 'Step {i} exit code:' $?\n\n"

    run_script += "echo 'KMC simulation completed.'\n"

    await write_remote_file(hpc.conn, f"{work_dir}/run_kmc.sh", run_script)
    logger.info("Wrote run_kmc.sh to %s", work_dir)

"""Auto-generate SLURM job scripts for HPC tasks.

Uses config-driven templates. No hardcoded values.

Resolution order for each field:
  task params → config.hpc.job_defaults → built-in fallbacks
"""

from __future__ import annotations

from typing import Any

# Default SLURM template — all values are {{placeholders}}
_DEFAULT_TEMPLATE = """#!/bin/bash
#SBATCH --job-name={{job_name}}
#SBATCH --nodes={{nodes}}
#SBATCH --ntasks={{ntasks}}
#SBATCH --cpus-per-task={{cpus_per_task}}
#SBATCH --time={{walltime}}
#SBATCH --partition={{partition}}
#SBATCH --account={{account}}
#SBATCH --mem={{memory}}
#SBATCH --output=%j.out
#SBATCH --error=%j.err

{{module_loads}}
{{env_setup}}

cd {{work_dir}}
{{run_command}}
"""

# Engine → run command mapping. CP2K needs the input filename + tee to
# capture stdout: generate_cp2k_inputs writes `project.inp` so we run
# `cp2k.popt project.inp | tee cp2k.out`. Any cluster override flows in via
# params.cp2k_command or job_defaults.cp2k_command (resolved in
# generate_job_script's cp2k branch).
_ENGINE_COMMANDS: dict[str, str] = {
    "vasp": "srun vasp_std",
    "cp2k": "srun cp2k.popt project.inp | tee cp2k.out",
    "orca": "orca ORCA.inp > ORCA.out 2>&1",
    "lammps": "python run_lammps.py",
    "mlp": "python run_mlp.py",
    "xtb": "python run_xtb.py",
    "sella": "python run_sella.py",
}


# Built-in CP2K SLURM template. Used when the cluster's default_template is
# VASP-flavored (contains VASP_HOME / {{vasp_run_command}} / PrgEnv-cray
# hardcoded module switches) and the task engine is cp2k — the VASP template
# would otherwise leak its hardcoded `module switch PrgEnv-cray` /
# `export VASP_HOME=...` lines into the CP2K submission.
#
# Module loads come from job_defaults.module_loads (typed in RunConfigDialog
# Clusters tab → "Module loads" textbox, e.g. `module load cp2k/2023.2`).
_CP2K_DEFAULT_TEMPLATE = """#!/bin/bash
#SBATCH --job-name={{job_name}}
#SBATCH --nodes={{nodes}}
#SBATCH --ntasks={{ntasks}}
#SBATCH --time={{walltime}}
#SBATCH --partition={{partition}}
{% if account %}#SBATCH --account={{account}}{% endif %}
#SBATCH --exclusive
#SBATCH --output=cp2k_%j.out
#SBATCH --error=cp2k_%j.err

{{module_loads}}

export OMP_NUM_THREADS=1

cd {{work_dir}}
{{run_command}}
"""


def _process_conditionals(template: str, replacements: dict[str, str]) -> str:
    """Process {% if var %}...{% endif %} conditionals in job script templates.

    A block is kept if the referenced {{var}} placeholder has a non-empty value
    in replacements. Otherwise the entire block (including the if/endif lines)
    is removed.
    """
    import re
    # Match {% if varname %}...{% endif %} — supports multiline content
    pattern = re.compile(
        r'\{%\s*if\s+(\w+)\s*%\}(.*?)\{%\s*endif\s*%\}',
        re.DOTALL,
    )

    def _replace(m: re.Match) -> str:
        var_name = m.group(1)
        content = m.group(2)
        # Check if the corresponding {{var_name}} has a truthy value
        key = "{{" + var_name + "}}"
        val = replacements.get(key, "")
        if val and val.strip():
            return content
        return ""

    return pattern.sub(_replace, template)


def generate_job_script(
    engine_key: str,
    work_dir: str,
    task: dict,
    params: dict,
    config: dict,
) -> str:
    """Build a complete SLURM job script from config + params.

    Returns a string with #SBATCH headers + run command.
    """
    hpc_cfg = config.get("hpc", {})
    job_defaults = hpc_cfg.get("job_defaults", {})

    # Template resolution: task > per-engine calc_template > config > built-in
    template = params.get("job_script_template")
    if not template:
        # Check calc_templates from workflow run config (set in RunConfigDialog)
        calc_templates = config.get("calc_templates", {})
        template = calc_templates.get(engine_key)
    if not template:
        template = hpc_cfg.get("job_script_template")
    if not template:
        template = _DEFAULT_TEMPLATE

    # If a cluster's default_template is VASP-flavored (hardcodes VASP_HOME /
    # `module switch PrgEnv-cray` / `{{vasp_run_command}}`), we can't reuse it
    # for non-VASP engines — placeholder substitution alone cannot strip the
    # hardcoded VASP module-switch lines. Fall back to a built-in template
    # that honors {{module_loads}} so the user's CP2K modules (configured in
    # RunConfigDialog → Clusters → Module loads) flow through cleanly.
    if engine_key == "cp2k" and template and (
        "VASP_HOME" in template
        or "{{vasp_run_command}}" in template
        or "PrgEnv-cray" in template
    ):
        template = _CP2K_DEFAULT_TEMPLATE

    # Resolve each field with priority: params > job_defaults > fallback
    def _get(key: str, fallback: str = "") -> str:
        val = params.get(key) or job_defaults.get(key) or fallback
        return str(val) if val else ""

    task_id = task.get("id", "")[:8]
    task_type = task.get("task_type", "unknown")

    # Resolve ORCA directory early (before run_command construction)
    orca_dir = ""
    if engine_key == "orca":
        orca_dir = (params.get("orca_dir") or job_defaults.get("orca_dir", "")).strip()

    # Run command: params > cluster-specific override > config > engine default
    run_command = params.get("run_command")
    if not run_command:
        # For ORCA, use $ORCA_DIR/orca (full path required for parallel MPI runs)
        if engine_key == "orca" and orca_dir:
            run_command = "$ORCA_DIR/orca ORCA.inp > ORCA.out 2>&1"
        elif engine_key == "cp2k":
            # cp2k_command lives on ClusterConfig and gets propagated to
            # hpc.job_defaults by scanner._merged_config. Per-task override
            # via params.run_command still wins above.
            #
            # The CP2K binary REQUIRES an input filename argument — if the
            # user provided a command like `srun cp2k.psmp` (binary only)
            # without it, append the input file + tee for stdout capture so
            # cp2k.psmp doesn't bail with "At least one command line argument
            # must be specified". `generate_cp2k_inputs` always writes
            # `project.inp`, so that's what we append.
            cp2k_cmd = (
                params.get("cp2k_command")
                or job_defaults.get("cp2k_command")
                or hpc_cfg.get("run_commands", {}).get(engine_key)
                or _ENGINE_COMMANDS.get(engine_key, f"srun {engine_key}")
            )
            if ".inp" not in cp2k_cmd:
                cp2k_cmd = f"{cp2k_cmd} project.inp | tee cp2k.out"
            run_command = cp2k_cmd
        else:
            run_command = (
                hpc_cfg.get("run_commands", {}).get(engine_key)
                or _ENGINE_COMMANDS.get(engine_key, f"srun {engine_key}")
            )

    # ORCA: SLURM resources (nodes/ntasks/cpus_per_task/memory) come from the
    # run dialog — ORCA self-caps at the .inp's %pal nprocs and %maxcore, so
    # over-allocation is harmless and the dialog stays the source of truth.
    # ORCA manages MPI internally (no srun/mpirun in _ENGINE_COMMANDS) and the
    # full pathname is required for parallel MPI runs.
    if engine_key == "orca" and orca_dir and not params.get("env_setup"):
        params["env_setup"] = (
            f"export ORCA_DIR={orca_dir}\n"
            f"export PATH=$ORCA_DIR:$PATH\n"
            f"export LD_LIBRARY_PATH=$ORCA_DIR/lib:$LD_LIBRARY_PATH"
        )

    # Custodian override for VASP
    use_custodian = params.get("use_custodian", hpc_cfg.get("use_custodian", False))
    if engine_key == "vasp" and use_custodian:
        run_command = "python run_custodian.py"

    # VASP executable override (vasp_gam, vasp_ncl, etc.)
    if engine_key == "vasp" and not use_custodian:
        vasp_exe = params.get("vasp_executable")
        if vasp_exe and vasp_exe != "vasp_std":
            run_command = run_command.replace("vasp_std", vasp_exe)

    replacements = {
        "{{job_name}}": f"catgo-{task_type}-{task_id}",
        "{{work_dir}}": work_dir,
        "{{nodes}}": _get("nodes", "1"),
        "{{ntasks}}": _get("ntasks", "32"),
        "{{cpus_per_task}}": _get("cpus_per_task", "1"),
        "{{walltime}}": _get("walltime", "24:00:00"),
        "{{partition}}": _get("partition", "shared"),
        "{{account}}": _get("account", ""),
        "{{memory}}": _get("memory", ""),
        "{{module_loads}}": _get("module_loads", "") or hpc_cfg.get("module_loads", {}).get(engine_key, ""),
        "{{env_setup}}": _get("env_setup", "") or hpc_cfg.get("env_setup", {}).get(engine_key, ""),
        "{{run_command}}": run_command,
        "{{calc_command}}": run_command,
        "{{vasp_run_command}}": run_command,
        "{{orca_dir}}": _get("orca_dir", ""),
        "{{python_env_activate}}": _get("python_env", ""),
    }

    # Process {% if var %}...{% endif %} conditionals before placeholder substitution.
    # Templates from JOB_SCRIPT_PRESETS use Jinja2-style conditionals.
    script = _process_conditionals(template, replacements)

    # Substitute all {{placeholders}}
    for key, val in replacements.items():
        script = script.replace(key, val)

    # Strip {% comment %} ... {% endcomment %} blocks
    import re
    script = re.sub(r'\{%\s*comment\s*%\}.*?\{%\s*endcomment\s*%\}', '', script)

    # Clean up empty #SBATCH lines (e.g., --account= when no account)
    lines = []
    for line in script.split("\n"):
        if line.startswith("#SBATCH") and line.endswith("="):
            continue  # Skip empty SBATCH directives
        if line.startswith("#SBATCH") and line.rstrip().endswith('""'):
            continue  # Skip #SBATCH --job-name=""
        lines.append(line)

    return "\n".join(lines)


def generate_custodian_script(
    vasp_command: str,
    params: dict,
    config: dict,
) -> str | None:
    """Generate run_custodian.py if custodian is enabled. Returns None otherwise."""
    hpc_cfg = config.get("hpc", {})
    use_custodian = params.get("use_custodian", hpc_cfg.get("use_custodian", False))
    if not use_custodian:
        return None

    max_errors = params.get("custodian_max_errors", hpc_cfg.get("custodian_max_errors", 5))

    return f'''#!/usr/bin/env python3
"""Run VASP with custodian error handling. Generated by CatGo v2 engine."""
import logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    handlers=[logging.FileHandler("custodian_run.log"), logging.StreamHandler()])

from custodian.custodian import Custodian
from custodian.vasp.handlers import (
    VaspErrorHandler, MeshSymmetryErrorHandler, UnconvergedErrorHandler,
    NonConvergingErrorHandler, PotimErrorHandler, FrozenJobErrorHandler,
    StdErrHandler, WalltimeHandler,
)
from custodian.vasp.jobs import VaspJob

vasp_cmd = "{vasp_command}".split()
handlers = [
    VaspErrorHandler(), MeshSymmetryErrorHandler(), UnconvergedErrorHandler(),
    NonConvergingErrorHandler(), PotimErrorHandler(), FrozenJobErrorHandler(),
    StdErrHandler(), WalltimeHandler(),
]
jobs = [VaspJob(vasp_cmd, output_file="vasp.out", stderr_file="std_err.txt")]
c = Custodian(handlers, jobs, max_errors={max_errors})
c.run()
'''

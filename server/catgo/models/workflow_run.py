"""Pydantic models for workflow execution configuration and status."""

from typing import Optional

from pydantic import BaseModel, Field


class JobScriptParams(BaseModel):
    """Per-step job scheduler parameters (overrides defaults from RunConfig)."""
    nodes: int = 1
    ntasks: int = 96
    cpus_per_task: int = 2
    walltime: str = "24:00:00"
    partition: Optional[str] = "workq"
    memory: Optional[str] = None
    account: Optional[str] = None
    # POTCAR location for VASP. Kept here (not only on ClusterConfig) so a
    # workflow run that sets potcar_root in default_job_params is not silently
    # dropped by validation — the scanner copies default_job_params into
    # hpc.job_defaults, where the submitter reads it. Without this, VASP jobs
    # die on a missing POTCAR.
    potcar_root: Optional[str] = None
    potcar_functional: Optional[str] = None


class ClusterConfig(BaseModel):
    """Per-cluster HPC settings."""

    # POTCAR configuration
    potcar_root: str = Field(
        default="/scratch/reny0b/VASP/pot64",
        description="Base POTCAR directory on HPC, e.g. /scratch/user/VASP/pot64",
    )
    potcar_functional: str = Field(
        default="potpaw_PBE",
        description="POTCAR functional subdirectory name",
    )

    # VASP execution command (used by custodian and {{vasp_run_command}})
    vasp_command: str = Field(
        default="srun --hint=nomultithread vasp_std",
        description="Actual VASP run command (for custodian and template substitution)",
    )

    # Python environment activation command (for custodian / pymatgen)
    python_env: str = Field(
        default="",
        description="Python env activation command, e.g. 'source activate pymatgen' or 'conda activate myenv'",
    )

    # Default job script template for this cluster
    default_template: str = Field(
        default="",
        description="Default job script template for this cluster",
    )

    # Default job parameters for this cluster
    default_job_params: JobScriptParams = Field(
        default_factory=JobScriptParams,
    )

    # SLURM account for billing/allocation (#SBATCH --account)
    account: str = Field(default="", description="SLURM account, e.g. sdp126")

    # Module load commands (newline-separated)
    module_loads: str = Field(default="", description="Module load commands, one per line")

    # ORCA installation directory on HPC
    orca_dir: str = Field(default="", description="ORCA installation directory, e.g. /home/user/orca_6_1_1")


# ====== Calculation type categories ======

CALC_TYPE_CATEGORIES = {
    "vasp_opt": {
        "label": "VASP Optimization",
        "node_types": ["vasp_relax", "bulk_opt", "slab_relax"],
    },
    "vasp_static": {
        "label": "VASP Static / Electronic",
        "node_types": ["vasp_static", "electronic", "reference_mol"],
    },
    "vasp_md": {
        "label": "VASP MD",
        "node_types": ["vasp_md"],
    },
    "vasp_freq": {
        "label": "VASP Frequency",
        "node_types": ["frequency"],
    },
    "mlp": {
        "label": "ML Potential (MACE/CHGNet/M3GNet)",
        "node_types": ["mlp_relax", "mlp_md"],
    },
    "bader": {
        "label": "Bader Charge Analysis",
        "node_types": ["charge_analysis"],
    },
    "xtb": {
        "label": "xTB (Semi-empirical)",
        "node_types": ["xtb_relax", "xtb_static"],
    },
    "sella": {
        "label": "Sella (Transition State)",
        "node_types": ["sella_ts"],
    },
    "cp2k": {
        "label": "CP2K (DFT)",
        "node_types": ["cp2k_geopt", "cp2k_static", "cp2k_cellopt", "cp2k_md", "cp2k_freq"],
    },
    "amber_md": {
        "label": "AMBER MD (ML/MM)",
        "node_types": ["amber_md"],
    },
    "amber_min": {
        "label": "AMBER Minimization",
        "node_types": ["amber_minimize"],
    },
    # Unified task-type nodes (resolved by software param at runtime)
    "unified": {
        "label": "Unified Calculation",
        "node_types": ["geo_opt", "single_point", "cell_opt", "md", "freq", "ts_search", "irc"],
    },
}

# Reverse map: node_type → calc_category
NODE_TYPE_TO_CALC_CATEGORY: dict[str, str] = {}
for cat_key, cat_info in CALC_TYPE_CATEGORIES.items():
    for nt in cat_info["node_types"]:
        NODE_TYPE_TO_CALC_CATEGORY[nt] = cat_key


# ====== Node categories (broad, MCP-facing) ======
#
# CALC_TYPE_CATEGORIES (above) is calculation-focused and serves the
# frontend's "Calc Type" dropdown — it lists software-bucketed *legacy*
# names like vasp_relax for human discoverability.
#
# NODE_CATEGORIES is the broader catalog surfaced to CatBot via the
# /node-categories endpoint and the MCP `node_types` action. It groups
# every node type that MCP's `add_node` can actually instantiate — calc,
# build, analysis, logic, kmc — so an LLM driving the workflow tool has
# one comprehensive map.
#
# INVARIANT: every type listed here must exist as a key in
# `server/catgo/mcp_tools/workflow_tools._NODE_DEFAULTS` and must NOT be
# an alias entry. Adding a type without backing defaults breaks add_node
# (the new did-you-mean validation will reject it).
NODE_CATEGORIES = {
    "calculation": {
        "label": "Calculation (unified)",
        "description": "Preferred. Pass a 'software' param (vasp/orca/cp2k/xtb/mlp/lammps/gromacs/amber/qe/qchem) to select the engine.",
        "node_types": [
            "geo_opt", "single_point", "cell_opt", "md", "freq",
            "ts_search", "irc", "slow_growth",
        ],
    },
    "calculation_engine_specific": {
        "label": "Calculation (engine-specific)",
        "description": "Engine-specific nodes not covered by the unified set above (ORCA UV-Vis, QE phonons, Q-Chem TS, etc.).",
        "node_types": [
            "mlp_relax", "mlp_md",
            "orca_opt", "orca_sp", "orca_freq", "orca_neb_ts", "orca_irc", "orca_uvvis",
            "qe_scf", "qe_relax", "qe_bands", "qe_dos", "qe_phonon",
            "qchem_static", "qchem_opt", "qchem_ts",
            "amber_md", "amber_minimize",
        ],
    },
    "build": {
        "label": "Structure build / preprocessing",
        "description": "Generate or modify structures before running calculations.",
        "node_types": [
            "structure_input", "structure_list_input",
            "slab_gen", "adsorbate_place", "batch_generate",
        ],
    },
    "analysis": {
        "label": "Analysis & postprocessing",
        "description": "Derive thermodynamic, electronic, or comparative quantities from completed calculations.",
        "node_types": [
            "gibbs_energy", "free_energy",
            "dos_analysis", "cohp_analysis", "md_analysis", "convergence_check",
            "electronic", "phonon_analysis", "eos_analysis", "elastic_analysis",
            "export_data",
        ],
    },
    "logic": {
        "label": "Flow control",
        "description": "Branch, loop, map over collections, and aggregate results.",
        "node_types": ["condition", "loop", "merge", "map", "aggregate"],
    },
    "kmc": {
        "label": "Kinetic Monte Carlo",
        "description": "Lattice KMC simulations using barriers from DFT.",
        "node_types": ["kmc"],
    },
}


class WorkflowRunConfig(BaseModel):
    """Configuration for executing a workflow (local or HPC)."""

    # Execution mode: "local" or "hpc"
    execution_mode: str = Field(
        default="hpc",
        description="Execution mode: 'local' (run on this machine) or 'hpc' (submit to cluster)"
    )

    # Local execution settings
    lmp_command: str = Field(
        default="lmp_serial",
        description="LAMMPS binary for local execution (e.g. lmp_serial, lmp_mpi, lmp)"
    )
    local_work_dir: str = Field(
        default="",
        description="Local working directory (empty = auto temp dir)"
    )

    # Default HPC session for all steps (required for HPC mode)
    default_session_id: str = Field(
        default="",
        description="Default HPC connection session_id"
    )

    # Job script template with {{placeholders}} — fallback if no cluster/calc-type template
    job_script_template: str = Field(
        default="",
        description="Fallback shell script template with {{job_name}}, {{nodes}}, {{ntasks}}, "
        "{{cpus_per_task}}, {{walltime}}, {{partition}}, {{memory}}, {{work_dir}} placeholders",
    )

    # Per-cluster settings (session_id → ClusterConfig)
    cluster_configs: dict[str, ClusterConfig] = Field(
        default_factory=dict,
        description="Per-cluster HPC settings (POTCAR, vasp_command, templates)",
    )

    # Per-calculation-type job script templates (calc_category → template)
    # Keys: "vasp_opt", "vasp_static", "vasp_md", "vasp_freq", "mlp", "bader"
    # If empty, falls back to cluster default_template → job_script_template
    calc_templates: dict[str, str] = Field(
        default_factory=dict,
        description="Per-calculation-type job script template overrides",
    )

    # Base directory (remote for HPC, local for local mode)
    base_work_dir: str = Field(
        default="~/calculations",
        description="Base directory on HPC for calculation files",
    )

    # Polling interval for job status checks
    poll_interval: int = Field(default=15, ge=5, le=120, description="Seconds between status polls")

    # Per-step HPC session overrides (step_id → session_id)
    step_sessions: dict[str, str] = Field(
        default_factory=dict,
        description="Override HPC session per step (for multi-cluster)",
    )

    # Per-step job parameters (step_id → JobScriptParams)
    step_job_params: dict[str, JobScriptParams] = Field(
        default_factory=dict,
        description="Override job script parameters per step",
    )

    # Per-step custom job script template overrides (step_id → template string)
    step_scripts: dict[str, str] = Field(
        default_factory=dict,
        description="Per-step custom job script template overrides (step_id -> template string)",
    )

    # Default job parameters (used when no per-step or per-cluster override)
    default_job_params: JobScriptParams = Field(
        default_factory=JobScriptParams,
        description="Default job scheduler parameters",
    )

    # Custodian error handling
    use_custodian: bool = Field(
        default=True,
        description="Use custodian to automatically fix VASP errors and restart",
    )
    auto_submit: bool = Field(
        default=False,
        description="If False (default), HPC tasks pause at PENDING_REVIEW so the user "
        "can review/edit the generated input files before submission (user-in-the-loop). "
        "Set True to submit directly without a review gate.",
    )
    custodian_max_errors: int = Field(
        default=5,
        ge=1,
        le=50,
        description="Maximum number of errors custodian will try to fix per job",
    )

    # Batch transport method for high-throughput workflows
    transport_method: str = Field(
        default="auto",
        description="File transport for batch jobs: 'auto' (tar if >10 tasks, else heredoc), 'tar', 'heredoc'",
    )

    # Auto-continuation for non-converged relaxations (like atomate2 Response(detour))
    auto_continue_on_not_converged: bool = Field(
        default=True,
        description="Auto-continue relaxation from CONTCAR if not converged",
    )
    max_continuation_runs: int = Field(
        default=3,
        ge=0,
        le=10,
        description="Maximum continuation attempts for non-converged relaxations",
    )
    nsw_multiplier: float = Field(
        default=1.5,
        ge=1.0,
        le=5.0,
        description="Multiply NSW by this factor on each continuation",
    )

    # ORCA binary path
    orca_binary: str = Field(
        default="orca",
        description="Path to ORCA executable (default: 'orca' assumes in PATH)",
    )


class StepInfo(BaseModel):
    """Detailed info about a workflow step's execution state."""

    id: str
    node_type: str
    label: str = ""
    status: str = "pending"
    config_json: str = "{}"
    hpc_job_id: Optional[str] = None
    hpc_session_id: Optional[str] = None
    hpc_host: Optional[str] = None
    work_dir: Optional[str] = None
    ase_db_id: Optional[int] = None
    result_json: str = "{}"
    error_message: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


class WorkflowRunStatus(BaseModel):
    """Real-time workflow execution status."""

    workflow_id: str
    status: str  # draft, running, paused, completed, failed
    steps: list[StepInfo] = []
    progress: float = 0.0  # 0.0 - 1.0


# ====== Job Script Presets ======

JOB_SCRIPT_PRESETS: dict[str, dict[str, str]] = {
    "generic_slurm": {
        "name": "Generic SLURM",
        "template": """#!/bin/bash
#SBATCH --job-name={{job_name}}
#SBATCH --nodes={{nodes}}
#SBATCH --ntasks={{ntasks}}
#SBATCH --cpus-per-task={{cpus_per_task}}
#SBATCH --time={{walltime}}
{% if partition %}#SBATCH --partition={{partition}}{% endif %}
{% if memory %}#SBATCH --mem={{memory}}{% endif %}
#SBATCH --output=%j.out
#SBATCH --error=%j.err

{% if python_env_activate %}# Activate Python environment
{{python_env_activate}}
{% endif %}
cd {{work_dir}}
{{run_command}}
""",
    },
    "generic_pbs": {
        "name": "Generic PBS",
        "template": """#!/bin/bash
#PBS -N {{job_name}}
#PBS -l nodes={{nodes}}:ppn={{cpus_per_task}}
#PBS -l walltime={{walltime}}
{% if partition %}#PBS -q {{partition}}{% endif %}
{% if memory %}#PBS -l mem={{memory}}{% endif %}
#PBS -o {{job_name}}.out
#PBS -e {{job_name}}.err

{% if python_env_activate %}# Activate Python environment
{{python_env_activate}}
{% endif %}
cd {{work_dir}}
{{run_command}}
""",
    },
    "shaheen3": {
        "name": "Shaheen-III (KAUST)",
        "template": """#!/bin/bash
#SBATCH --partition={{partition}}
#SBATCH --job-name={{job_name}}
#SBATCH --nodes={{nodes}}
#SBATCH --time={{walltime}}
#SBATCH --ntasks-per-node={{ntasks}}
#SBATCH --cpus-per-task={{cpus_per_task}}
#SBATCH --exclusive
#SBATCH --err=std.%j.err
#SBATCH --output=std.%j.out
#----------------------------------------------------------#
module switch PrgEnv-cray PrgEnv-intel
module switch intel intel/19.0.5.281

export VASP_HOME=/scratch/reny0b/VASP/vasp.6.4.3-vtst/bin
export VASP_PP_PATH=/scratch/reny0b/VASP/pot64
export VASP_POT=/scratch/reny0b/VASP/pot64

export FI_CXI_RX_MATCH_MODE=software
export MKL_DEBUG_CPU_TYPE=5
export MKL_CBWR=auto
export OMP_NUM_THREADS=$SLURM_CPUS_PER_TASK
export PATH=$VASP_HOME:/sw/ex111genoa/vasp/tools/util/bin:$PATH
export LD_LIBRARY_PATH=/opt/cray/pe/netcdf/4.9.0.7/INTEL/2022.2/lib:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/opt/cray/pe/hdf5/1.12.2.7/INTEL/2022.2/lib:$LD_LIBRARY_PATH

# Activate Python environment (for custodian / pymatgen)
source /scratch/reny0b/iops/sw/miniconda3-amd64/etc/profile.d/conda.sh
conda activate /scratch/reny0b/iops/sw/envs/gs

#----------------------------------------------------------#
cd {{work_dir}}
{{vasp_run_command}}

#----------------------------------------------------------#
echo "Calculation finished on $(date)."
""",
    },
    "lammps_slurm": {
        "name": "LAMMPS SLURM",
        "template": """#!/bin/bash
#SBATCH --job-name={{job_name}}
#SBATCH --nodes={{nodes}}
#SBATCH --ntasks={{ntasks}}
#SBATCH --cpus-per-task={{cpus_per_task}}
#SBATCH --time={{walltime}}
{% if partition %}#SBATCH --partition={{partition}}{% endif %}
{% if memory %}#SBATCH --mem={{memory}}{% endif %}
#SBATCH --output=%j.out
#SBATCH --error=%j.err

cd {{work_dir}}
{{run_command}}
""",
    },
    "expanse_vasp": {
        "name": "Expanse VASP (SDSC)",
        "template": """#!/bin/bash
#SBATCH --job-name={{job_name}}
#SBATCH --partition={{partition}}
#SBATCH --nodes={{nodes}}
#SBATCH --ntasks-per-node={{ntasks}}
#SBATCH --cpus-per-task={{cpus_per_task}}
#SBATCH --time={{walltime}}
{% if account %}#SBATCH --account={{account}}{% endif %}
#SBATCH --output=shared.o%j.%N
#SBATCH --export=ALL
{% if memory %}#SBATCH --mem={{memory}}{% endif %}

module purge
module load slurm
module load cpu/0.17.3b
module load ucx/1.10.1/wla3unl
module load cm-pmix3/3.1.7

export I_MPI_PMI_LIBRARY=/cm/shared/apps/slurm/current/lib64/libpmi.so
export PATH=/expanse/projects/qstore/csd807/gliu3/vasp.6.5.1-vtst-vaspsol/bin:$PATH
source /home/gliu3/intel/oneapi/setvars.sh

{% if python_env_activate %}# Activate Python environment
{{python_env_activate}}
{% endif %}
cd {{work_dir}}
{{vasp_run_command}}
""",
    },
    "orca_slurm": {
        "name": "ORCA SLURM with Local Scratch",
        "template": """#!/bin/bash
#SBATCH --job-name={{job_name}}
#SBATCH --output={{job_name}}.%j.out
#SBATCH --partition={{partition}}
#SBATCH --nodes={{nodes}}
#SBATCH --ntasks-per-node={{ntasks}}
#SBATCH --cpus-per-task={{cpus_per_task}}
{% if memory %}#SBATCH --mem={{memory}}{% endif %}
#SBATCH --time={{walltime}}
{% if account %}#SBATCH --account={{account}}{% endif %}

# Clean module environment
module purge

# Load required modules
{{module_loads}}

# ORCA environment setup
{% if orca_dir %}export ORCA_DIR={{orca_dir}}
export PATH=$ORCA_DIR:$PATH
export LD_LIBRARY_PATH=$ORCA_DIR/lib:$LD_LIBRARY_PATH
{% endif %}

# Prevent MPI binding issues for NEB
export OMPI_MCA_hwloc_base_binding_policy=none

{% if python_env_activate %}# Activate Python environment
{{python_env_activate}}
{% endif %}

# Run calculation in submit directory
cd $SLURM_SUBMIT_DIR
{{calc_command}}
""",
    },
    "orca_local": {
        "name": "ORCA Local Machine",
        "template": """#!/bin/bash
# CatGO local ORCA job script (no scheduler)
set -e
cd {{work_dir}}
{{calc_command}} > ORCA.out 2>&1
""",
    },
    "mlp_slurm": {
        "name": "MLP (MACE/CHGNet/M3GNet) SLURM",
        "template": """#!/bin/bash
#SBATCH --job-name={{job_name}}
#SBATCH --output={{job_name}}.%j.out
#SBATCH --error={{job_name}}.%j.err
#SBATCH --partition={{partition}}
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task={{cpus_per_task}}
{% if memory %}#SBATCH --mem={{memory}}{% endif %}
#SBATCH --time={{walltime}}
{% if account %}#SBATCH --account={{account}}{% endif %}

{% if python_env_activate %}# Activate Python environment (required for ML potentials)
{{python_env_activate}}
{% endif %}

cd {{work_dir}}
{{calc_command}}

echo "Calculation finished on $(date)."
""",
    },
}


# ====== POTCAR recommended variants (Materials Project standard) ======

RECOMMENDED_POTCAR: dict[str, str] = {
    "Ac": "Ac", "Ag": "Ag", "Al": "Al", "Am": "Am", "Ar": "Ar",
    "As": "As", "At": "At", "Au": "Au", "B": "B", "Ba": "Ba_sv",
    "Be": "Be_sv", "Bi": "Bi", "Br": "Br", "C": "C", "Ca": "Ca_sv",
    "Cd": "Cd", "Ce": "Ce", "Cl": "Cl", "Co": "Co", "Cr": "Cr_pv",
    "Cs": "Cs_sv", "Cu": "Cu_pv", "Dy": "Dy_3", "Er": "Er_3",
    "Eu": "Eu", "F": "F", "Fe": "Fe_pv", "Fr": "Fr_sv", "Ga": "Ga_d",
    "Gd": "Gd", "Ge": "Ge_d", "H": "H", "He": "He", "Hf": "Hf_pv",
    "Hg": "Hg", "Ho": "Ho_3", "I": "I", "In": "In_d", "Ir": "Ir",
    "K": "K_sv", "Kr": "Kr", "La": "La", "Li": "Li_sv", "Lu": "Lu_3",
    "Mg": "Mg_pv", "Mn": "Mn_pv", "Mo": "Mo_pv", "N": "N",
    "Na": "Na_pv", "Nb": "Nb_pv", "Nd": "Nd_3", "Ne": "Ne",
    "Ni": "Ni_pv", "Np": "Np", "O": "O", "Os": "Os_pv", "P": "P",
    "Pa": "Pa", "Pb": "Pb_d", "Pd": "Pd", "Pm": "Pm_3",
    "Pr": "Pr_3", "Pt": "Pt", "Pu": "Pu", "Ra": "Ra_sv",
    "Rb": "Rb_sv", "Re": "Re_pv", "Rh": "Rh_pv", "Rn": "Rn",
    "Ru": "Ru_pv", "S": "S", "Sb": "Sb", "Sc": "Sc_sv",
    "Se": "Se", "Si": "Si", "Sm": "Sm_3", "Sn": "Sn_d",
    "Sr": "Sr_sv", "Ta": "Ta_pv", "Tb": "Tb_3", "Tc": "Tc_pv",
    "Te": "Te", "Th": "Th", "Ti": "Ti_pv", "Tl": "Tl_d",
    "Tm": "Tm_3", "U": "U", "V": "V_sv", "W": "W_pv",
    "Xe": "Xe", "Y": "Y_sv", "Yb": "Yb_2", "Zn": "Zn", "Zr": "Zr_sv",
}


# ====== Custodian run script ======

CUSTODIAN_RUN_SCRIPT = '''#!/usr/bin/env python3
"""Run VASP with custodian error handling.

Generated by CatGo workflow engine.
"""
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    handlers=[logging.FileHandler("custodian_run.log"), logging.StreamHandler()],
)
logger = logging.getLogger("catgo.custodian")

from custodian.custodian import Custodian
from custodian.vasp.handlers import (
    VaspErrorHandler,
    MeshSymmetryErrorHandler,
    UnconvergedErrorHandler,
    NonConvergingErrorHandler,
    IncorrectSmearingHandler,
    LargeSigmaHandler,
    PotimErrorHandler,
    FrozenJobErrorHandler,
    StdErrHandler,
    LrfCommutatorHandler,
    AliasingErrorHandler,
    DriftErrorHandler,
    WalltimeHandler,
)
from custodian.vasp.jobs import VaspJob

vasp_cmd = "{{vasp_cmd}}".split()
max_errors = {{max_errors}}
wall_time = {{wall_time_seconds}}
output_file = "{{output_file}}"
stderr_file = "{{stderr_file}}"

logger.info("VASP command: %s", vasp_cmd)
logger.info("Max errors: %d, Wall time: %d s", max_errors, wall_time)
logger.info("Output: %s, Stderr: %s", output_file, stderr_file)

# --- Error handlers (order: monitors first, then post-run) ---
handlers = [
    # Monitor handlers — checked every monitor_freq cycles during the run
    FrozenJobErrorHandler(output_filename=output_file, timeout=3600),
    PotimErrorHandler(),
    LargeSigmaHandler(),
    AliasingErrorHandler(output_filename=output_file),
    NonConvergingErrorHandler(nionic_steps=10),
    WalltimeHandler(wall_time=wall_time, buffer_time=300),

    # Post-run handlers — checked after VASP exits
    VaspErrorHandler(output_filename=output_file),
    StdErrHandler(output_filename=stderr_file),
    LrfCommutatorHandler(output_filename=stderr_file),
    MeshSymmetryErrorHandler(output_filename=output_file),
    UnconvergedErrorHandler(),
    IncorrectSmearingHandler(),
    DriftErrorHandler(),
]

jobs = [VaspJob(
    vasp_cmd,
    output_file=output_file,
    stderr_file=stderr_file,
    auto_npar=False,
    auto_gamma=True,
    backup=True,
    auto_continue=True,
)]

c = Custodian(
    handlers,
    jobs,
    max_errors=max_errors,
    max_errors_per_job=max_errors,
    polling_time_step=10,
    monitor_freq=30,
    checkpoint=True,
    gzipped_output=False,
    skip_over_errors=False,
    terminate_on_nonzero_returncode=False,
)

try:
    c.run()
except Exception:
    logger.exception("Custodian run failed")
    sys.exit(1)
'''

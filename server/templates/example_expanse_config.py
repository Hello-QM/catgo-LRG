"""
Example: Configure CatGO to run ORCA calculations on Expanse supercomputer

This example shows how to load the Expanse template and set up cluster-specific
configuration for running ORCA jobs.

Usage:
    1. Copy this file to your server config directory
    2. Import and use in your FastAPI/Starlette startup
    3. Pass to workflow execution engine
"""

from pathlib import Path
from server.models.workflow_run import WorkflowRunConfig, ClusterConfig, JobScriptParams


def load_expanse_config() -> WorkflowRunConfig:
    """Load ORCA configuration for Expanse cluster.

    Expanse (https://www.sdsc.edu/support/user_guides/expanse.html):
    - Located at: login.expanse.sdsc.edu
    - ORCA path: /home/jyang25/orca_6_1_1_RRP8
    - Typical resources: 8 cores, 32GB memory, 4 hours
    - Partition: shared (best for ORCA), gpu-shared, compute
    """

    # Load Expanse ORCA template
    template_path = Path(__file__).parent / "orca_expanse.sh"
    orca_template = template_path.read_text()

    # Create Expanse cluster configuration
    expanse_cluster = ClusterConfig(
        # Default job script template for this cluster
        default_template=orca_template,

        # Default job parameters when submitting to Expanse
        default_job_params=JobScriptParams(
            nodes=1,                           # Single node (sufficient for ORCA)
            ntasks=8,                          # Threads for ORCA (Expanse node has 128 cores)
            cpus_per_task=1,                   # 1 CPU per task
            walltime="04:00:00",               # 4 hour default walltime
            partition="shared",                # Use shared partition (good for small jobs)
            memory="32G"                       # Memory allocation
        ),

        # POTCAR configuration (if using VASP)
        potcar_root="/scratch/reny0b/VASP/pot64",
        potcar_functional="potpaw_PBE",

        # ORCA binary path (important!)
        orca_dir="/home/jyang25/orca_6_1_1_RRP8"
    )

    # Create workflow run configuration
    config = WorkflowRunConfig(
        # Default HPC session (must match your SSH profile name)
        default_session_id="expanse_jyang25",

        # Cluster-specific configurations (can have multiple clusters)
        cluster_configs={
            "expanse_jyang25": expanse_cluster,

            # Example: Could also add other clusters
            # "local_cluster": local_cluster_config,
            # "kahoot_cluster": kahoot_cluster_config,
        },

        # Base directory on Expanse where calculations run
        base_work_dir="/scratch/reny0b/gs/catgo_workflow",

        # Polling interval for job status checks (seconds)
        poll_interval=15,

        # Use custodian for error handling (VASP only, not ORCA)
        use_custodian=False,  # ORCA doesn't need custodian

        # ORCA binary path (fallback, use cluster config above)
        orca_binary="/home/jyang25/orca_6_1_1_RRP8/orca",
    )

    return config


# Alternative: Per-calculation-type templates
def load_expanse_config_with_calc_templates() -> WorkflowRunConfig:
    """Advanced: Different templates for different calculation types."""

    template_path = Path(__file__).parent

    config = load_expanse_config()

    # Override with per-calculation-type templates (optional)
    config.calc_templates = {
        "orca": (template_path / "orca_expanse.sh").read_text(),
        # Could add VASP, MLP, etc. templates here
    }

    return config


# Example: How to use this configuration
if __name__ == "__main__":
    # Load configuration
    config = load_expanse_config()

    print(f"Cluster configs: {list(config.cluster_configs.keys())}")
    print(f"Default session: {config.default_session_id}")
    print(f"Base work dir: {config.base_work_dir}")
    print(f"ORCA binary: {config.orca_binary}")

    # Print Expanse job parameters
    expanse = config.cluster_configs["expanse_jyang25"]
    print(f"\nExpanse defaults:")
    print(f"  Template location: {len(expanse.default_template)} bytes")
    print(f"  Job params: {expanse.default_job_params.dict()}")
    print(f"  ORCA dir: {expanse.orca_dir}")


"""
USAGE EXAMPLES
==============

1. Basic ORCA optimization on Expanse:
   ✅ System automatically:
      - Loads orca_expanse.sh template
      - Substitutes job_name, ntasks=8, memory=32G, etc.
      - Generates submit.sh with local scratch setup
      - Uploads ORCA.inp and submit.sh to /scratch/reny0b/gs/catgo_workflow/orca_opt_xyz/
      - Runs: sbatch submit.sh
      - Polls job status every 15 seconds
      - Downloads results when complete

2. NEB-TS (Nudged Elastic Band):
   ✅ Template automatically:
      - Detects reactant.xyz and product.xyz
      - Copies to local scratch before running ORCA
      - ORCA processes: ORCA.inp + reactant.xyz + product.xyz
      - Generates NEB.out with path information

3. Override per-step parameters:
   ```python
   config.step_job_params["step_id_xyz"] = JobScriptParams(
       ntasks=16,           # More cores for this specific job
       walltime="08:00:00", # Longer time
       partition="compute"  # Different partition
   )
   ```

4. Connect from CatGO UI:
   - Click "Connect HPC Cluster"
   - Enter: host=login.expanse.sdsc.edu, username=jyang25
   - Auth method: SSH key (recommended) or password
   - System creates session_id (e.g., "expanse_jyang25_abc123")
   - Create or load workflow
   - Add ORCA node → configure method/basis → "Run Workflow"
   - System finds matching cluster config → loads template → submits job

TROUBLESHOOTING
===============

Error: "orca: command not found"
  → Check {{orca_dir}} in template
  → Verify: /home/jyang25/orca_6_1_1_RRP8/orca exists
  → Test: ssh jyang25@login.expanse.sdsc.edu /home/jyang25/orca_6_1_1_RRP8/orca --version

Job fails: "No space left on device"
  → Scratch full: df -h /scratch/$USER
  → Clean old jobs: rm -rf /scratch/reny0b/gs/catgo_workflow/orca_*

Job timeout
  → Increase walltime in template or step_job_params
  → Check ORCA.out for convergence issues

Slow I/O
  → Verify local scratch is used: grep "SCRATCH_DIR" ORCA.out
  → Check job logs: tail -f /scratch/reny0b/gs/catgo_workflow/orca_opt_xyz/ORCA.out

EXPANSE QUICK REFERENCE
=======================

Login:
  ssh -l jyang25 login.expanse.sdsc.edu

Check job status:
  squeue -u jyang25

Cancel job:
  scancel <job_id>

View job details:
  scontrol show job <job_id>

Monitor running job:
  tail -f /scratch/reny0b/gs/catgo_workflow/orca_opt_xyz/ORCA.out

Check available partitions:
  sinfo

Check account/allocation:
  saccg

Disk usage:
  df -h /home /scratch
  quota -s

Module information:
  module avail
  module spider gcc
  module show gcc/10.2.0

Transfer files:
  scp file.txt jyang25@login.expanse.sdsc.edu:/scratch/reny0b/

ORCA documentation:
  https://www.orcagaust.de/

Expanse documentation:
  https://www.sdsc.edu/support/user_guides/expanse.html
"""

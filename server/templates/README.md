# ORCA & VASP Job Script Templates

This directory contains job submission script templates for various HPC clusters. Templates use `{{placeholder}}` syntax for parameter substitution.

## Available Templates

### ORCA Templates

#### `orca_expanse.sh` - Expanse Supercomputer (SDSC)
**Best for:** ORCA calculations on Expanse cluster
- Loads gcc/10.2.0 and OpenMPI/4.1.1
- Uses local scratch (`/scratch/$USER/job_$SLURM_JOB_ID`) for I/O performance
- Automatically copies reactant/product.xyz for NEB-TS calculations
- Expected ORCA location: `/home/jyang25/orca_6_1_1_RRP8` or configured via `{{orca_dir}}`

**Cluster Info:**
- Partition: `shared`, `gpu-shared`, `compute`
- Account: `sdp126` (or your allocation)
- Memory per node: 96 GB (shared), 256 GB (standard)
- CPU: AMD EPYC 7742 (2-socket, 128 cores/node)

#### `orca_generic.sh` - Generic SLURM Cluster
**Best for:** Most Linux HPC clusters with standard SLURM
- Minimal cluster-specific setup
- Flexible module loading via `{{module_loads}}`
- Works with or without local scratch
- Ideal for:
  - Local university clusters
  - Cloud HPC (AWS ParallelCluster, Azure HPC)
  - Custom research clusters

#### `orca_shaheen.sh` - Shaheen II (KAUST)
**Best for:** ORCA on Shaheen II supercomputer
- Loads Intel compiler and Intel MPI
- Uses Intel MKL for optimized linear algebra
- Uses `$TMPDIR` for local scratch
- Expected ORCA location: configured via `{{orca_dir}}`

**Cluster Info:**
- CPU: Intel Xeon E5-2698 v3 (Haswell, 2-socket, 32 cores/node)
- Memory: 128 GB per node
- Partition: `workq` (standard queue)

## Template Placeholders

Common placeholders that get substituted:

| Placeholder | Example | Description |
|------------|---------|-------------|
| `{{job_name}}` | `catgo_orca_opt_abc123` | Job name shown in squeue |
| `{{nodes}}` | `1` | Number of compute nodes |
| `{{ntasks}}` | `8` | Total number of MPI tasks (or ntasks-per-node for ORCA) |
| `{{memory}}` | `32G` | Memory per node |
| `{{partition}}` | `shared` | SLURM partition/queue name |
| `{{account}}` | `sdp126` | Compute allocation account |
| `{{walltime}}` | `04:00:00` | Time limit in HH:MM:SS format |
| `{{orca_dir}}` | `/home/jyang25/orca_6_1_1_RRP8` | Path to ORCA installation |
| `{{module_loads}}` | `module load gcc openmpi` | Module load commands |
| `{{work_dir}}` | `/scratch/user/orca_opt_xyz/` | Working directory on HPC |
| `{{calc_command}}` | `orca ORCA.inp > ORCA.out` | Calculation command to run |

## How Templates are Used in CatGO

### 1. **Global Fallback Template**
```python
# server/models/workflow_run.py
config = WorkflowRunConfig(
    job_script_template=open("server/templates/orca_generic.sh").read()
)
```

### 2. **Per-Cluster Template** (Recommended)
```python
config = WorkflowRunConfig(
    default_session_id="expanse_session_123",
    cluster_configs={
        "expanse_session_123": ClusterConfig(
            default_template=open("server/templates/orca_expanse.sh").read(),
            default_job_params=JobScriptParams(
                nodes=1,
                ntasks=8,
                walltime="04:00:00",
                partition="shared",
                memory="32G"
            ),
            orca_binary="/home/jyang25/orca_6_1_1_RRP8/orca"
        )
    }
)
```

### 3. **Per-Calculation-Type Template**
```python
config = WorkflowRunConfig(
    calc_templates={
        "orca": open("server/templates/orca_expanse.sh").read(),
        "vasp_opt": open("server/templates/vasp_expanse.sh").read(),
    }
)
```

## Setup Instructions

### For Expanse Users

1. **Update your cluster configuration:**
```python
from server.models.workflow_run import WorkflowRunConfig, ClusterConfig, JobScriptParams

config = WorkflowRunConfig(
    default_session_id="expanse_jyang25",
    cluster_configs={
        "expanse_jyang25": ClusterConfig(
            default_template=open("server/templates/orca_expanse.sh").read(),
            default_job_params=JobScriptParams(
                nodes=1,
                ntasks=8,
                walltime="04:00:00",
                partition="shared",
                memory="32G"
            ),
            orca_dir="/home/jyang25/orca_6_1_1_RRP8"
        )
    }
)
```

2. **In WorkflowEditor.svelte**, when user clicks "Run Workflow":
   - System loads cluster template from config
   - Substitutes job parameters and ORCA path
   - Generates final submit.sh

3. **Monitor job on Expanse:**
```bash
ssh -l jyang25 login.expanse.sdsc.edu
squeue -u jyang25
```

### For Other Clusters

1. **Choose appropriate template:**
   - Use `orca_generic.sh` as starting point
   - Customize module loads for your cluster
   - Update ORCA path and compiler setup

2. **Test template on your cluster:**
```bash
# Create a test ORCA input
cp server/templates/orca_generic.sh /tmp/test_submit.sh

# Edit placeholders manually and test
sbatch /tmp/test_submit.sh
```

3. **Add to CatGO configuration:**
```python
cluster_configs["my_cluster"] = ClusterConfig(
    default_template=custom_template_content,
    orca_dir="/path/to/orca/bin"
)
```

## Key Features of Expanse Template

### Local Scratch Usage
```bash
export SCRATCH_DIR=/scratch/$USER/job_$SLURM_JOB_ID
mkdir -p $SCRATCH_DIR
cd $SCRATCH_DIR

# Copy inputs, run calculation, copy results back
```
**Benefits:**
- ✅ Fast local I/O (NVMe scratch)
- ✅ Automatic cleanup via SLURM
- ✅ Better for large ORCA output files
- ✅ Reduces shared filesystem load

### NEB-TS File Handling
```bash
# Automatically detect and copy reactant/product structures
if [ -f "$SLURM_SUBMIT_DIR/reactant.xyz" ]; then
    cp $SLURM_SUBMIT_DIR/reactant.xyz .
fi
```
**Supports:**
- Standard ORCA optimizations
- NEB-TS (Nudged Elastic Band Transition State)
- IRC (Intrinsic Reaction Coordinate)

### Module Loading
```bash
module purge
module load cpu/0.17.3b
module load gcc/10.2.0/npcyll4
module load openmpi/4.1.1
```
**Ensures:**
- ✅ Clean environment (purge)
- ✅ Correct compiler/MPI versions
- ✅ Reproducible builds

## Customization Examples

### Use Different ORCA Version
```bash
export ORCA_DIR=/home/user/orca_5.0.4
```

### Override Partition
```python
job_params = JobScriptParams(
    partition="gpu-shared",  # Use GPU partition if needed
    ntasks=8,
    walltime="02:00:00"
)
```

### Add Custom Environment Variables
Edit the template to add:
```bash
export OMP_NUM_THREADS=4
export ORCA_TMPDIR=/scratch/$USER/orca_tmp
```

### Disable Local Scratch (for small jobs)
Edit template to remove:
```bash
# (Remove scratch setup code if not needed)
cd {{work_dir}}
{{calc_command}}
```

## Troubleshooting

### "orca: command not found"
- Check `{{orca_dir}}` path is correct
- Verify modules are loaded: `module list`
- Test: `$ORCA_DIR/orca --version`

### Job fails: "No space left on device"
- Scratch might be full: `df -h /scratch/$USER`
- Clean up old jobs: `rm -rf /scratch/$USER/job_*`
- Or reduce calculation size

### Job times out
- Increase `{{walltime}}` in job parameters
- For NEB: adjust `NImages` and `MaxIter` in ORCA.inp
- For IRC: reduce `MaxIter` (default 30 steps)

### Slow I/O performance
- Verify local scratch is being used
- Check if files are still on shared filesystem
- Monitor with: `iostat 1` during job

## Integration with CatGO Workflow

When running a workflow:

1. **User creates ORCA node** in WorkflowEditor
2. **User configures parameters** (method, basis set, etc.)
3. **User clicks "Run Workflow"**
4. **System**:
   - Looks up cluster config by session_id
   - Loads appropriate template (`orca_expanse.sh`, etc.)
   - Substitutes parameters
   - Uploads ORCA.inp + generated script to HPC
   - Submits: `sbatch submit.sh`
   - Polls job status
   - Extracts results when done

## File Structure

```
server/templates/
├── README.md              ← This file
├── orca_expanse.sh        ← Expanse (SDSC)
├── orca_generic.sh        ← Generic SLURM
├── orca_shaheen.sh        ← Shaheen II (KAUST)
└── vasp_expanse.sh        ← VASP on Expanse (future)
```

## Contributing New Templates

To add a new cluster template:

1. Create new file: `orca_<clustername>.sh`
2. Use appropriate module loads for your cluster
3. Test locally with sample ORCA input
4. Document in this README
5. Submit PR with template + documentation

---

**Last Updated:** Feb 20, 2026

# ORCA Template Usage Flow

## How Templates Work in CatGO

```
┌─────────────────────────────────────────────────────────────┐
│ User runs workflow with ORCA node (in CatGO UI)             │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ server/utils/workflow_engine.py                              │
│ _submit_and_monitor() function                              │
│                                                              │
│ 1. Look up HPC session_id (e.g., "expanse_jyang25")        │
│ 2. Generate ORCA.inp from structure + parameters           │
│ 3. Upload ORCA.inp to HPC work directory                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ _render_job_script() function                                │
│                                                              │
│ Template Selection Priority:                                │
│   1. calc_templates["orca"] (if defined)                   │
│   2. cluster_configs[session_id].default_template          │
│   3. job_script_template (fallback)                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Load Template File                                           │
│ (e.g., server/templates/orca_expanse.sh)                    │
│                                                              │
│ #!/bin/bash                                                 │
│ #SBATCH --job-name="{{job_name}}"                          │
│ #SBATCH --nodes={{nodes}}                                  │
│ #SBATCH --ntasks-per-node={{ntasks}}                       │
│ #SBATCH --mem={{memory}}                                   │
│ ...                                                         │
│ export ORCA_DIR={{orca_dir}}                               │
│ cd {{work_dir}}                                             │
│ {{calc_command}}                                            │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Placeholder Substitution                                     │
│                                                              │
│ Replacements = {                                            │
│   "{{job_name}}": "catgo_orca_opt_abc123"                  │
│   "{{nodes}}": "1"                                          │
│   "{{ntasks}}": "8"                                         │
│   "{{memory}}": "32G"                                       │
│   "{{orca_dir}}": "/home/jyang25/orca_6_1_1_RRP8"         │
│   "{{work_dir}}": "/scratch/reny0b/gs/catgo_workflow/..."  │
│   "{{calc_command}}": "orca ORCA.inp > ORCA.out"           │
│ }                                                           │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Generate Final submit.sh                                     │
│                                                              │
│ #!/bin/bash                                                 │
│ #SBATCH --job-name="catgo_orca_opt_abc123"                 │
│ #SBATCH --nodes=1                                           │
│ #SBATCH --ntasks-per-node=8                                │
│ #SBATCH --mem=32G                                           │
│ #SBATCH --partition=shared                                  │
│ #SBATCH --account=sdp126                                    │
│ #SBATCH -t 04:00:00                                         │
│                                                              │
│ module load gcc/10.2.0/npcyll4                              │
│ module load openmpi/4.1.1                                   │
│ export ORCA_DIR=/home/jyang25/orca_6_1_1_RRP8             │
│ ...                                                         │
│ orca ORCA.inp > ORCA.out                                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Upload to HPC                                                │
│                                                              │
│ /scratch/reny0b/gs/catgo_workflow/orca_opt_abc123/          │
│   ├── ORCA.inp          ← Generated from parameters         │
│   ├── submit.sh         ← Generated from template           │
│   └── (empty for now)                                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Submit Job                                                   │
│                                                              │
│ $ sbatch submit.sh                                          │
│ Submitted batch job 12345678                                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ ORCA Runs on Expanse Compute Node                           │
│                                                              │
│ Local scratch: /scratch/$USER/job_12345678                 │
│   ├── ORCA.inp (copied from submit dir)                    │
│   ├── ORCA.out (generated by orca)                         │
│   ├── ORCA_...  (temporary files)                          │
│   └── (other output)                                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Copy Results Back                                            │
│                                                              │
│ /scratch/reny0b/gs/catgo_workflow/orca_opt_abc123/          │
│   ├── ORCA.inp                                              │
│   ├── submit.sh                                             │
│   ├── ORCA.out          ← Results here                      │
│   ├── ORCA_opt...       ← Optional                          │
│   └── 12345678.out      ← Job stdout                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Extract Results (server/utils/orca_output.py)              │
│                                                              │
│ Parse ORCA.out:                                             │
│   - Final energy                                            │
│   - Convergence status                                      │
│   - Geometry (XYZ format)                                   │
│   - Frequencies (if freq=true)                              │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Store in Database                                            │
│                                                              │
│ workflow_steps table:                                       │
│   - step_id: (same)                                         │
│   - status: "completed"                                     │
│   - result_json: { energy: -75.123, structure: "xyz..." }   │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ CatGO UI Shows Results                                       │
│                                                              │
│ ✅ Node marked as completed                                │
│ ✅ Energy displayed                                         │
│ ✅ Structure visualization available                       │
│ ✅ Downstream nodes can now execute                        │
└─────────────────────────────────────────────────────────────┘
```

## Configuration Hierarchy

When submitting a job, CatGO looks for templates in this order:

### 1. **Per-Calculation-Type Template** (Highest Priority)
```python
config.calc_templates["orca"] = "..."  # Most specific
```
**Use when:** You want one template for ALL ORCA jobs, regardless of cluster

### 2. **Per-Cluster Default Template** (Recommended)
```python
config.cluster_configs["expanse_jyang25"].default_template = "..."
```
**Use when:** Different clusters need different environments (gcc vs intel, etc.)

### 3. **Global Fallback Template** (Lowest Priority)
```python
config.job_script_template = "..."  # Generic fallback
```
**Use when:** Single template works for all clusters

## Parameter Sources

Job parameters come from multiple sources (highest to lowest priority):

```
┌──────────────────────────────────────┐
│ 1. Per-Step Override                 │  Highest priority
│    config.step_job_params[step_id]   │
└──────────────────────────────────────┘
            ↓ (if not defined)
┌──────────────────────────────────────┐
│ 2. Per-Cluster Default                │
│    cluster_configs[session_id]        │
│        .default_job_params            │
└──────────────────────────────────────┘
            ↓ (if not defined)
┌──────────────────────────────────────┐
│ 3. Global Default                     │  Lowest priority
│    config.default_job_params          │
└──────────────────────────────────────┘
```

## Example: Two Clusters

```python
config = WorkflowRunConfig(
    cluster_configs={
        "expanse_jyang25": ClusterConfig(
            default_template=open("server/templates/orca_expanse.sh").read(),
            default_job_params=JobScriptParams(
                ntasks=8,
                partition="shared",
                memory="32G",
                walltime="04:00:00"
            )
        ),
        "shaheen_jyang": ClusterConfig(
            default_template=open("server/templates/orca_shaheen.sh").read(),
            default_job_params=JobScriptParams(
                ntasks=16,
                partition="workq",
                memory="64G",
                walltime="02:00:00"
            )
        )
    }
)

# When submitting to Expanse:
# → Uses orca_expanse.sh, 8 ntasks, shared partition, 32G, 4hrs

# When submitting to Shaheen:
# → Uses orca_shaheen.sh, 16 ntasks, workq partition, 64G, 2hrs
```

## Template Comparison Table

| Feature | Expanse | Shaheen | Generic |
|---------|---------|---------|---------|
| **Modules** | gcc/openmpi | Intel/IMpi | Flexible |
| **Scratch** | `/scratch/$USER/` | `$TMPDIR` | Configurable |
| **Compiler** | GCC 10.2.0 | Intel 2019/2020 | None (add manually) |
| **MPI** | OpenMPI 4.1.1 | Intel MPI | None |
| **CPU Type** | AMD EPYC | Xeon Haswell | Unknown |
| **Memory/node** | 96 GB | 128 GB | Flexible |
| **Scratch Speed** | ⚡ NVMe | ⚡ High-speed | Depends |
| **Setup Time** | ~30s | ~30s | Variable |

## Choosing a Template

```
Do you know which cluster you're using?
│
├─ YES
│  │
│  ├─ Expanse? → Use orca_expanse.sh
│  ├─ Shaheen? → Use orca_shaheen.sh
│  └─ Other? → Start with orca_generic.sh + customize
│
└─ NO → Use orca_generic.sh (most flexible)
```

## When to Customize

**Create a new template when:**
- ✅ Your cluster has specific modules (NVIDIA, Intel, PGI, etc.)
- ✅ You need different compiler flags (-O3, -march, etc.)
- ✅ Your scratch filesystem is in a different location
- ✅ Your scheduler has unique options (cgroup limits, GPU request, etc.)

**Don't create a new template when:**
- ❌ Just changing ntasks/memory/walltime (use job_params instead)
- ❌ Just changing ORCA path (set {{orca_dir}} instead)
- ❌ Just changing partition (use partition parameter)

## Quick Start: Expanse

1. **SSH Connection:**
   - Host: `login.expanse.sdsc.edu`
   - Username: `jyang25` (your Expanse username)
   - Auth: SSH key or password

2. **Configure:**
   ```python
   config = WorkflowRunConfig(
       default_session_id="expanse_jyang25",
       cluster_configs={
           "expanse_jyang25": ClusterConfig(
               default_template=open("server/templates/orca_expanse.sh").read(),
               orca_dir="/home/jyang25/orca_6_1_1_RRP8"
           )
       }
   )
   ```

3. **Run:**
   - Create ORCA node in CatGO
   - Set method (r2SCAN-3c recommended) and basis
   - Click "Run Workflow"
   - System handles everything else!

## File Locations Summary

```
CatGO Project Root
│
├── server/
│   ├── models/
│   │   └── workflow_run.py          ← WorkflowRunConfig definition
│   │
│   ├── templates/
│   │   ├── orca_expanse.sh          ← Expanse template (recommended)
│   │   ├── orca_generic.sh          ← Generic SLURM template
│   │   ├── orca_shaheen.sh          ← Shaheen II template
│   │   ├── README.md                ← Full documentation
│   │   ├── TEMPLATE_USAGE.md        ← This file
│   │   └── example_expanse_config.py← Example configuration
│   │
│   ├── utils/
│   │   ├── workflow_engine.py       ← _render_job_script() function
│   │   ├── orca_input.py            ← ORCA.inp generator
│   │   └── orca_output.py           ← Result parser
│   │
│   └── routers/
│       ├── orca.py                  ← ORCA API endpoints
│       └── workflow.py              ← Workflow execution endpoints
│
└── README.md                        ← Project root docs
```

---

**For detailed template customization, see** [README.md](README.md)

**For example configuration, see** [example_expanse_config.py](example_expanse_config.py)

**Last Updated:** Feb 20, 2026

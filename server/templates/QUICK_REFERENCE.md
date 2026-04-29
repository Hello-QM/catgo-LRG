# ORCA Job Template - Quick Reference Card

## Expanse Configuration (Copy-Paste Ready)

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
    },
    base_work_dir="/scratch/reny0b/gs/catgo_workflow",
    orca_binary="/home/jyang25/orca_6_1_1_RRP8/orca",
)
```

## Key Placeholders

| Placeholder | What It Does | Example |
|---|---|---|
| `{{job_name}}` | Job name in scheduler | catgo_orca_opt_abc |
| `{{nodes}}` | Number of compute nodes | 1 |
| `{{ntasks}}` | Cores/tasks per node | 8 |
| `{{memory}}` | RAM allocation | 32G |
| `{{partition}}` | SLURM queue name | shared, gpu-shared, compute |
| `{{account}}` | Compute account | sdp126 |
| `{{walltime}}` | Max runtime HH:MM:SS | 04:00:00 |
| `{{orca_dir}}` | ORCA installation path | /home/jyang25/orca_6_1_1_RRP8 |

## Expanse Partitions

| Partition | Cores/Node | Memory | Best For |
|---|---|---|---|
| `shared` | Up to 128 | 96 GB | ✅ ORCA opt, freq, sp |
| `gpu-shared` | Up to 128 | 96 GB + 4× GPU | ML/neural networks |
| `compute` | 128 | 96 GB | Heavy workloads |
| `large-shared` | 128 | 768 GB | Large VASP calcs |

**Recommended for ORCA:** `shared` partition with 8 cores

## Expanse Job Time Limits

```
Single-node (shared): max 48 hours
Multi-node (compute): max 48 hours
GPU nodes: max 48 hours
```

**Typical ORCA walltime:** 1-4 hours
**Start with:** 2-4 hours, adjust based on system size

## Template Files Available

```
✅ server/templates/orca_expanse.sh   ← Use this for Expanse
   server/templates/orca_generic.sh   ← Generic Linux clusters
   server/templates/orca_shaheen.sh   ← KAUST Shaheen II
```

## Common ORCA Methods & Est. Runtime

```
HF           5-30 min  (fast)
B3LYP        10-60 min (medium)
PBE          10-60 min (medium)
ωB97X-D      15-90 min (medium-slow)
CCSD         30-120+ min (slow, needs big molecules)
```

**For system size:**
- Atoms 1-10:   < 5 min with most methods
- Atoms 10-30:  5-30 min
- Atoms 30+:    30+ min or use r2SCAN-3c (fast)

## Expanse ORCA Setup Details

```bash
# Module commands automatically run in template:
module load cpu/0.17.3b
module load gcc/10.2.0/npcyll4
module load openmpi/4.1.1

# ORCA path:
export ORCA_DIR=/home/jyang25/orca_6_1_1_RRP8

# Verify ORCA works:
ssh jyang25@login.expanse.sdsc.edu
/home/jyang25/orca_6_1_1_RRP8/orca --version
```

## Common ORCA Calculation Types

```
opt      Geometry Optimization
         Time: system_size × method
         Use: Find minimum energy structure

sp       Single Point
         Time: 10-30% of opt
         Use: Energy at fixed geometry

freq     Vibrational Frequencies
         Time: ~10× single point
         Use: Get ZPE, thermodynamics

neb      Nudged Elastic Band
         Time: images × (2× opt time)
         Use: Reaction path, TS search

irc      Intrinsic Reaction Coordinate
         Time: 1-2 hours for small molecules
         Use: TS → reactant/product path
```

## Result Files on HPC

After job completes, results at:
```
/scratch/reny0b/gs/catgo_workflow/orca_opt_<id>/
├── ORCA.inp
├── ORCA.out       ← Main output (parse this)
├── OPT_...        ← Intermediate files
├── submit.sh
└── <jobid>.out    ← Job log
```

Download with SCP:
```bash
scp -r jyang25@login.expanse.sdsc.edu:/scratch/reny0b/gs/catgo_workflow/orca_opt_abc123/ ./local_dir/
```

## Troubleshooting 30-Second Guide

| Problem | Check | Fix |
|---|---|---|
| "orca: not found" | Module load | `module load gcc` |
| Job times out | Runtime | Increase `{{walltime}}` |
| No scratch space | Disk | `df -h /scratch` |
| Slow I/O | Scratch setup | Verify template uses local scratch |
| Memory error | RAM | Increase `{{memory}}` or reduce system |
| Job won't start | Queue | Try different partition |

## Expanse Management Commands

```bash
# Check job queue
squeue -u jyang25

# View running job details
scontrol show job <JOB_ID>

# Cancel job
scancel <JOB_ID>

# Check disk usage
du -sh /scratch/reny0b/
df -h /scratch

# Monitor job (from HPC)
tail -f /scratch/reny0b/gs/catgo_workflow/orca_opt_xyz/ORCA.out

# Check account balance
saccg
```

## File Transfer

```bash
# Push file to Expanse
scp localfile jyang25@login.expanse.sdsc.edu:/scratch/reny0b/gs/

# Pull file from Expanse
scp jyang25@login.expanse.sdsc.edu:/scratch/reny0b/gs/result.out .

# Directory sync
rsync -avz /local/path/ jyang25@login.expanse.sdsc.edu:/scratch/reny0b/gs/
```

## Performance Tips

```
✅ Use local scratch (template does this)
✅ Set ntasks matching molecule size
✅ Use r2SCAN-3c for fast geometry opt
✅ Use smaller basis set for initial calcs
✅ Chain calculations: opt → freq → IRC
✅ Batch multiple small jobs together
❌ Don't use GPU partition for ORCA (CPU-only)
❌ Don't run > 128 cores on one node
```

## NEB-TS (Reaction Path) Example

```python
# Config: use same Expanse template

# Workflow:
1. Add "orca_neb_ts" node
2. Inputs: connect reactant structure, product structure
3. Params:
   - Method: r2SCAN-3c (fast)
   - Basis: 6-31G
   - Images: 8 (default, good balance)
   - MaxIter: 100
4. Run workflow

# Output: activation barrier, TS structure, reaction path
```

## Template Modification (Advanced)

If you need to customize the Expanse template:

```bash
# Copy template
cp server/templates/orca_expanse.sh server/templates/orca_expanse_custom.sh

# Edit (e.g., add OMP threads)
nano server/templates/orca_expanse_custom.sh

# Add to config
config.calc_templates["orca"] = open("server/templates/orca_expanse_custom.sh").read()
```

Common edits:
```bash
# Add OpenMP threads
export OMP_NUM_THREADS=4

# Add temporary ORCA work dir
export ORCA_TMPDIR=/scratch/$USER/orca_tmp_$SLURM_JOB_ID
mkdir -p $ORCA_TMPDIR

# Reduce memory footprint (slow but works)
# export ORCA_OLD_STACKSIZE=true
```

## Estimate Walltimes

Formula: `walltime = (atom_count × method_factor × 0.5) + 0.5 hours`

```
Examples:
- H₂O (3 atoms) + B3LYP/6-31G:
  (3 × 1 × 0.5) + 0.5 = 2 hours
  Recommended: 1 hour

- Benzene (12 atoms) + ωB97X-D/cc-pVDZ:
  (12 × 2 × 0.5) + 0.5 = 12.5 hours
  Recommended: 4-6 hours

- TS search (NEB-TS, 12 images):
  (atom_count × 12 × method_factor × 0.1) = hours
  For 10 atoms + B3LYP: (10 × 12 × 1 × 0.1) = 12 hours
```

## Reference Links

- **Expanse Docs:** https://www.sdsc.edu/support/user_guides/expanse.html
- **ORCA Manual:** https://www.orcagaust.de/tutorials/
- **SLURM Docs:** https://slurm.schedmd.com/sbatch.html

---

**Version:** Feb 20, 2026 | **For CatGO Workflow System**

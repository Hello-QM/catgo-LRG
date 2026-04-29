# Integration Guide: Adding ORCA Templates to CatGO

This guide walks you through integrating the ORCA job script templates into your CatGO deployment.

## Step 1: Copy Template Files

All templates are in `server/templates/`:

```bash
cd /path/to/CatGO
ls server/templates/
# Output:
# orca_expanse.sh
# orca_generic.sh
# orca_shaheen.sh
# README.md (this directory)
```

✅ **Done** - Templates are already in the repository!

## Step 2: Create Cluster Configuration

In your server startup code (e.g., `server/main.py` or a config module):

```python
from pathlib import Path
from server.models.workflow_run import WorkflowRunConfig, ClusterConfig, JobScriptParams

def load_hpc_config() -> WorkflowRunConfig:
    """Load HPC configuration with ORCA templates."""

    template_path = Path(__file__).parent / "templates"

    # Load Expanse template
    orca_expanse_template = (template_path / "orca_expanse.sh").read_text()
    orca_generic_template = (template_path / "orca_generic.sh").read_text()

    return WorkflowRunConfig(
        default_session_id="expanse_jyang25",  # Or your default

        cluster_configs={
            "expanse_jyang25": ClusterConfig(
                default_template=orca_expanse_template,
                default_job_params=JobScriptParams(
                    nodes=1,
                    ntasks=8,
                    cpus_per_task=1,
                    walltime="04:00:00",
                    partition="shared",
                    memory="32G"
                ),
                orca_dir="/home/jyang25/orca_6_1_1_RRP8",
                potcar_root="/scratch/reny0b/VASP/pot64",
            ),
            # Add more clusters as needed
        },

        base_work_dir="/scratch/reny0b/gs/catgo_workflow",
        poll_interval=15,
        use_custodian=False,
        orca_binary="/home/jyang25/orca_6_1_1_RRP8/orca",
    )

# In your FastAPI app startup:
@app.on_event("startup")
async def startup():
    global hpc_config
    hpc_config = load_hpc_config()
    # Pass to workflow engine
```

## Step 3: Pass Configuration to Workflow Engine

The workflow engine needs access to the config. Update `server/utils/workflow_engine.py`:

```python
# In _submit_and_monitor() method:

async def _submit_and_monitor(self, step_id: str, config: WorkflowRunConfig):
    """Submit calculation job and monitor progress."""

    # ... existing code ...

    # When rendering job script:
    job_script = _render_job_script(
        template=template,  # Loaded from cluster_configs
        job_name=job_name,
        work_dir=work_dir,
        nodes=params.nodes,
        ntasks=params.ntasks,
        walltime=params.walltime,
        partition=params.partition,
        memory=params.memory,
        account=params.account,
        node_type=step.node_type,
        orca_dir=cluster_config.orca_dir,
        orca_binary=config.orca_binary,
    )
```

## Step 4: Update Workflow Routes

In `server/routers/workflow.py`, when receiving a run request:

```python
from server.models.workflow_run import WorkflowRunConfig

@router.post("/workflows/{workflow_id}/run")
async def run_workflow(workflow_id: str, run_config: WorkflowRunConfig):
    """Execute workflow with provided configuration."""

    # Load workflow
    workflow = db.get_workflow(workflow_id)

    # Start execution with config
    task = asyncio.create_task(
        workflow_engine.execute_workflow(
            workflow,
            run_config,  # Pass the config!
            db
        )
    )

    return {"status": "running", "workflow_id": workflow_id}
```

## Step 5: Update CatGO UI Components

In the RunConfigDialog component (`src/lib/workflow/RunConfigDialog.svelte`):

```svelte
<script>
    import { generateOrcaInputs } from '$lib/api/compute'

    export let workflow
    export let onRun

    let selectedCluster = 'expanse_jyang25'
    let orcaMethod = 'r2SCAN-3c'
    let orcaBasis = '6-31G'

    async function runWorkflow() {
        const config = {
            default_session_id: selectedCluster,
            cluster_configs: {
                [selectedCluster]: {
                    default_template: orcaTemplate,
                    orca_dir: orcaDir,
                    default_job_params: {
                        ntasks: ntasks,
                        walltime: walltime,
                        memory: memory
                    }
                }
            }
        }

        await onRun(config)
    }
</script>
```

## Step 6: Test Configuration

### Local Testing

```bash
# Test template substitution
cd server

python3 << 'EOF'
from pathlib import Path
from utils.workflow_engine import _render_job_script

template = Path("templates/orca_expanse.sh").read_text()

script = _render_job_script(
    template=template,
    job_name="test_orca_opt_123",
    work_dir="/scratch/user/test/",
    nodes=1,
    ntasks=8,
    walltime="04:00:00",
    partition="shared",
    memory="32G",
    orca_dir="/home/jyang25/orca_6_1_1_RRP8",
    node_type="orca_opt"
)

print(script)
# Should show fully substituted script
EOF
```

### Test on HPC

```bash
# SSH to Expanse
ssh -l jyang25 login.expanse.sdsc.edu

# Create test directory
mkdir -p /scratch/reny0b/gs/catgo_test
cd /scratch/reny0b/gs/catgo_test

# Create minimal ORCA input
cat > ORCA.inp << 'EOF'
! r2SCAN-3c 6-31G OPT
* xyz 0 1
H 0 0 0
H 0 0 1
*
EOF

# Copy generated submit.sh from CatGO
# (or create one manually from template)

# Test submission
sbatch submit.sh
# Submitted batch job 12345678

# Monitor
squeue -u jyang25
tail -f ORCA.out
```

## Step 7: Add to Database

Store cluster configurations persistently:

```python
# models/hpc.py - already has HPCProfile

class SavedClusterConfig(BaseModel):
    """Save cluster configurations to database."""
    name: str  # "expanse", "shaheen", "local"
    host: str  # "login.expanse.sdsc.edu"
    session_id: str  # "expanse_jyang25"
    cluster_config: ClusterConfig
    is_default: bool = False

# In database:
saved_configs: dict[str, SavedClusterConfig] = {}

def save_cluster_config(config: SavedClusterConfig):
    saved_configs[config.session_id] = config

def load_cluster_config(session_id: str) -> ClusterConfig:
    return saved_configs[session_id].cluster_config
```

## Step 8: Add UI for Cluster Management

Create `src/lib/workflow/ClusterSettings.svelte`:

```svelte
<script>
    import { getHPCConnection } from '$lib/api/hpc'

    let clusters = []

    async function loadClusters() {
        clusters = await getHPCConnection()
    }

    async function selectCluster(clusterId) {
        // Save as default for future workflows
        localStorage.setItem('default_cluster', clusterId)
    }
</script>

<div>
    <h2>HPC Clusters</h2>
    {#each clusters as cluster}
        <div class="cluster-card">
            <h3>{cluster.host}</h3>
            <p>Username: {cluster.username}</p>
            <p>Status: {cluster.connected ? '✅ Connected' : '❌ Disconnected'}</p>
            <button on:click={() => selectCluster(cluster.id)}>
                Use for Workflows
            </button>
        </div>
    {/each}
</div>
```

## Step 9: Documentation for Users

Create deployment documentation (`docs/SETUP_HPC.md`):

```markdown
# Setting Up HPC for CatGO

## For Expanse Users

1. **SSH Configuration**
   ```
   Host: login.expanse.sdsc.edu
   Username: your_expanse_username
   ```

2. **ORCA Installation**
   - Path: `/home/your_username/orca_X_X_X_RRP8`
   - Test: `orca --version`

3. **Configure CatGO**
   - Update `server/templates/example_expanse_config.py`
   - Set your ORCA path
   - Set your account allocation

4. **Run Workflows**
   - Create ORCA node in CatGO
   - Select Expanse cluster
   - Configure calculation parameters
   - Click "Run"

## For Other Clusters

See template-specific docs:
- Shaheen II: `server/templates/orca_shaheen.sh`
- Generic SLURM: `server/templates/orca_generic.sh`
```

## Step 10: Add Tests

Create `tests/vitest/workflow_templates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { renderJobScript } from '../server/utils/workflow_engine'

describe('Job Script Templates', () => {
    it('should substitute expanse placeholders', () => {
        const template = '{{job_name}} {{ntasks}} {{orca_dir}}'
        const result = renderJobScript(template, {
            job_name: 'test',
            ntasks: 8,
            orca_dir: '/path/to/orca'
        })
        expect(result).toBe('test 8 /path/to/orca')
    })

    it('should handle conditional blocks', () => {
        const template = '{% if account %}#SBATCH --account={{account}}{% endif %}'
        const result = renderJobScript(template, { account: 'proj123' })
        expect(result).toContain('#SBATCH --account=proj123')
    })
})
```

## Step 11: Error Handling

Add template validation:

```python
def validate_template(template: str) -> bool:
    """Check template has required placeholders."""
    required = ['{{work_dir}}', '{{calc_command}}']
    for placeholder in required:
        if placeholder not in template:
            raise ValueError(f"Missing required: {placeholder}")
    return True

# In config loading:
for name, cluster_config in cluster_configs.items():
    validate_template(cluster_config.default_template)
```

## Step 12: Logging & Monitoring

Add logging to workflow submission:

```python
import logging
logger = logging.getLogger(__name__)

def _submit_and_monitor(...):
    logger.info(f"Submitting {node_type} to cluster {cluster_id}")
    logger.debug(f"Job script:\n{job_script}")
    logger.info(f"Job submitted: {job_id}")
    # ...
    logger.info(f"Job completed: {job_id}")
    logger.info(f"Results extracted: {result_json}")
```

## Checklist

- [ ] Templates copied to `server/templates/`
- [ ] `ClusterConfig` created with template paths
- [ ] `WorkflowRunConfig` instantiated
- [ ] Config passed to workflow engine
- [ ] Routes updated to accept config
- [ ] UI updated for cluster selection
- [ ] Database storage for configs (optional)
- [ ] User documentation written
- [ ] Tests added
- [ ] Tested on actual HPC system
- [ ] Error handling implemented
- [ ] Logging configured

## Troubleshooting Integration

**Problem:** Template placeholders not substituting
```python
# Check: Does the placeholder spelling match?
# Template: {{orca_dir}}
# In _render_job_script: "{{orca_dir}}": orca_dir_value
```

**Problem:** Job not submitting
```python
# Check: Is cluster_config in cluster_configs?
# Check: Is default_session_id set correctly?
# Check: Does ORCA path exist on HPC?
```

**Problem:** Results not extracted
```python
# Check: Does output file exist? (ORCA.out, NEB.out)
# Check: Is node_type in ORCA_CALC_NODES?
# Check: Are output parsers working? (_extract_orca_results)
```

## Next Steps

1. **Customize templates** for your specific clusters
2. **Add more calculation types** (VASP, MLP, etc.)
3. **Implement result visualization** in UI
4. **Add job monitoring dashboard**
5. **Create cluster management UI**

---

**Integration Complete!** Your CatGO instance is now ready to submit ORCA jobs to HPC clusters.

For questions, see [README.md](README.md) or [TEMPLATE_USAGE.md](TEMPLATE_USAGE.md)

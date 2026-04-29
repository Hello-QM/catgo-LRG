# CatGo Workflow Engine Refactor — Architecture Design

## Vision

CatGo's workflow engine should be:
- **Backend-first**: Python API is the core, frontend is observer
- **Crash-safe**: CatGo can close/crash at any time, workflows resume on restart
- **HPC-native**: HPC files are ground truth, DB is cache
- **AI-ready**: Claude Code / Codex / Gemini CLI operate workflows via MCP/Python API
- **Zero-deploy**: SQLite, no MongoDB/PostgreSQL/RabbitMQ

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Entry Points (all produce the same Workflow objects)    │
│                                                         │
│  Python API        GUI Editor        AI Agent (MCP)     │
│  wf = Workflow()   drag & drop       claude code        │
│  wf.add_task(...)  → JSON → API      → MCP tools        │
└──────────┬──────────────┬──────────────┬────────────────┘
           │              │              │
           ▼              ▼              ▼
┌─────────────────────────────────────────────────────────┐
│  SQLite Database (single source of truth for CatGo)     │
│                                                         │
│  workflows    tasks    task_links    task_results        │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  State Machine Engine (periodic scanner, configurable)    │
│                                                         │
│  1. Find READY tasks (all parents COMPLETED)            │
│  2. Generate inputs → Upload → Submit to HPC            │
│  3. Poll SUBMITTED/RUNNING tasks via squeue/sacct       │
│  4. Collect results from COMPLETED_HPC tasks            │
│  5. Advance downstream tasks to READY                   │
│  6. Sleep 30s → repeat                                  │
└──────────────────────────┬──────────────────────────────┘
                           │ SSH
                           ▼
┌─────────────────────────────────────────────────────────┐
│  HPC Cluster (ground truth for job results)              │
│                                                         │
│  work_dir/POSCAR  OUTCAR  CONTCAR  vasprun.xml          │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 1: Python API + DB Schema

### 1.1 Task Definition (`@task` decorator)

```python
from catgo.workflow import task, Workflow

@task(
    software="vasp",
    task_type="geo_opt",
    outputs=["structure", "energy"],
)
def geo_opt(structure, ENCUT=520, EDIFF=1e-5, NSW=200, ISIF=2, **params):
    """Geometry optimization. Params become INCAR tags."""
    pass  # Body is never executed by user — engine handles execution

@task(software="vasp", task_type="freq", outputs=["frequencies", "zpe"])
def freq(structure, IBRION=5, NFREE=2, POTIM=0.015, **params):
    pass

@task(task_type="gibbs_energy", local=True, outputs=["gibbs"])
def gibbs_energy(energy, frequencies, phase="adsorbed", temperature=298.15, **params):
    """Local computation — runs in CatGo process, not on HPC."""
    pass
```

Key design decisions:
- `@task` registers the function as a task type, NOT executes it
- The function body is a no-op for HPC tasks — engine generates inputs from params
- For `local=True` tasks (gibbs_energy), the function body IS the implementation
- `outputs` declares what this task produces (used for type checking connections)
- `**params` catches all INCAR/software-specific parameters

### 1.2 Workflow Construction

```python
wf = Workflow("RuO2 OER")

# Input structure
slab = wf.add_task("structure_input", structure="RuO2_110.cif")

# For each adsorbate
for ads in ["OH", "O", "OOH"]:
    placed = wf.add_task("adsorbate_place",
        structure=slab.output.structure,
        species=ads, site="all",
    )
    opt = wf.add_task(geo_opt,
        structure=placed.output.structure,
        system_name=f"*{ads}",
        ENCUT=520, EDIFF=1e-5,
    )
    frq = wf.add_task(freq,
        structure=opt.output.structure,
        system_name=f"*{ads}",
        freeze_mode="layers", freeze_layers=4,
    )
    gib = wf.add_task(gibbs_energy,
        energy=opt.output.energy,
        frequencies=frq.output.frequencies,
        system_name=f"*{ads}",
        phase="adsorbed",
    )

# Submit to engine
wf.submit()  # Writes to SQLite, scanner picks it up
```

### 1.3 OutputReference

```python
class OutputReference:
    """Lazy pointer to a task's future output."""

    def __init__(self, task_id: str, key: str = None):
        self.task_id = task_id
        self.key = key  # e.g., "structure", "energy"

    def __getattr__(self, name):
        """ref.structure → OutputReference(task_id, "structure")"""
        return OutputReference(self.task_id, name)
```

When `wf.add_task(freq, structure=opt.output.structure)`:
1. `opt.output` returns `OutputReference(opt.task_id)`
2. `.structure` returns `OutputReference(opt.task_id, "structure")`
3. `add_task` detects this is a reference → creates a link in DB
4. At execution time, engine resolves the reference from `task_results`

### 1.4 DB Schema

```sql
-- Workflows
CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'draft',  -- draft/running/paused/completed/failed
    created_at TEXT,
    updated_at TEXT,
    config_json TEXT DEFAULT '{}',  -- HPC session, run config
    graph_json TEXT,  -- Frontend visual layout (optional, for GUI)
);

-- Tasks (nodes in the DAG)
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id),
    task_type TEXT NOT NULL,       -- "geo_opt", "freq", "gibbs_energy", etc.
    name TEXT,                     -- user-friendly name, e.g. "*OH"
    status TEXT DEFAULT 'WAITING', -- see state machine below
    params_json TEXT DEFAULT '{}', -- all task parameters (INCAR tags, etc.)

    -- HPC execution info
    hpc_session_id TEXT,
    hpc_job_id TEXT,
    work_dir TEXT,

    -- Timing
    created_at TEXT,
    submitted_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    last_polled_at TEXT,

    -- Error handling
    error_message TEXT,
    error_type TEXT,  -- "transient" or "permanent"
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,

    -- Result
    result_json TEXT DEFAULT '{}',

    -- Metadata
    software TEXT,        -- "vasp", "cp2k", "orca", "local"
    system_name TEXT,     -- for free energy diagram labels

    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

-- Task Links (edges in the DAG)
CREATE TABLE task_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    target_task_id TEXT NOT NULL,
    source_key TEXT NOT NULL,    -- "structure", "energy", "frequencies"
    target_key TEXT NOT NULL,    -- which input parameter to bind
    FOREIGN KEY (source_task_id) REFERENCES tasks(id),
    FOREIGN KEY (target_task_id) REFERENCES tasks(id)
);

-- Task Results (separate table for large data)
CREATE TABLE task_results (
    task_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,

    -- Core outputs
    energy REAL,
    structure_json TEXT,     -- pymatgen dict JSON

    -- Frequency outputs
    real_freqs_json TEXT,    -- [{index, frequency_cm, ...}]
    imag_freqs_json TEXT,
    positions_json TEXT,
    masses_json TEXT,

    -- Gibbs outputs
    gibbs REAL,
    zpe REAL,
    ts_correction REAL,

    -- Generic outputs (for custom tasks)
    outputs_json TEXT DEFAULT '{}',

    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Indices
CREATE INDEX idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_task_links_source ON task_links(source_task_id);
CREATE INDEX idx_task_links_target ON task_links(target_task_id);
```

### 1.5 Built-in Task Types

Registered via `@task` decorator or explicit registration:

| Category | Types | Execution |
|----------|-------|-----------|
| **Input** | structure_input, structure_list | Local (instant) |
| **Build** | slab_gen, adsorbate_place, doping_gen, supercell_gen | Local (WASM/pymatgen) |
| **Calculation** | geo_opt, single_point, freq, cell_opt, md, ts_search | HPC |
| **Analysis** | gibbs_energy, dos_analysis, charge_analysis | Local (Python) |
| **Diagram** | free_energy_diagram | Local (Plotly) |
| **Logic** | condition, loop, map, aggregate | Engine (control flow) |

---

## Phase 2: State Machine Engine

### 2.1 Task States (14 states)

```
                    ┌──────────┐
                    │ WAITING  │ All parents not yet COMPLETED
                    └────┬─────┘
                         │ (all parents COMPLETED)
                    ┌────▼─────┐
                    │  READY   │ Can be picked up by engine
                    └────┬─────┘
                         │ (engine picks up)
                  ┌──────▼────────┐
                  │  GENERATING   │ Creating input files (INCAR/POSCAR/KPOINTS)
                  └──────┬────────┘
                         │
                  ┌──────▼────────┐
                  │  UPLOADING    │ SSH transfer to HPC work_dir
                  └──────┬────────┘
                         │
                  ┌──────▼────────┐
                  │  SUBMITTED    │ sbatch executed, got job_id
                  └──────┬────────┘
                         │ (squeue shows PENDING)
                  ┌──────▼────────┐
                  │   QUEUED      │ In HPC queue
                  └──────┬────────┘
                         │ (squeue shows RUNNING)
                  ┌──────▼────────┐
                  │   RUNNING     │ Computing on HPC nodes
                  └──────┬────────┘
                         │ (squeue gone + sacct COMPLETED)
               ┌─────────▼──────────┐
               │  COMPLETED_REMOTE   │ HPC done, results on remote
               └─────────┬──────────┘
                         │ (results read via SSH)
               ┌─────────▼──────────┐
               │   COLLECTING       │ Reading OUTCAR/CONTCAR/frequencies
               └─────────┬──────────┘
                         │
               ┌─────────▼──────────┐
               │    COMPLETED       │ Results in DB, downstream unblocked
               └────────────────────┘

  At any active state:
       transient error → REMOTE_ERROR (retry with backoff)
       permanent error → FAILED
       user action     → PAUSED / CANCELLED
```

### 2.2 Engine Scanner (the "Runner")

```python
class WorkflowEngine:
    """Stateless periodic scanner — the heart of CatGo's execution."""

    def __init__(self, db_path: str, config: dict = None):
        self.db_path = db_path
        self.config = config or {}
        # All intervals/limits configurable, no hardcoded values
        self.poll_interval = self.config.get("poll_interval", 30)       # seconds between scan cycles
        self.submit_batch_size = self.config.get("submit_batch_size", 5) # max tasks to submit per cycle
        self.max_concurrent_jobs = self.config.get("max_concurrent_jobs", 20)  # HPC job limit
        self.retry_backoff_base = self.config.get("retry_backoff_base", 60)    # seconds
        self.retry_backoff_factor = self.config.get("retry_backoff_factor", 2) # exponential
        self.max_retries = self.config.get("max_retries", 3)
        self.result_collect_timeout = self.config.get("result_collect_timeout", 300)  # seconds

    async def run_forever(self):
        """Main loop — scan and advance tasks every cycle."""
        while True:
            try:
                await self.scan_cycle()
            except Exception as e:
                logger.error("Scan cycle failed: %s", e)
            await asyncio.sleep(self.poll_interval)

    async def scan_cycle(self):
        """One cycle of the state machine. Reads DB, advances states."""

        # 1. Advance WAITING → READY (check parent completion)
        await self._advance_waiting_tasks()

        # 2. Pick up READY tasks → GENERATING → UPLOADING → SUBMITTED
        await self._submit_ready_tasks()

        # 3. Poll SUBMITTED/QUEUED/RUNNING → check HPC status
        await self._poll_active_tasks()

        # 4. Collect results from COMPLETED_REMOTE → COMPLETED
        await self._collect_completed_tasks()

        # 5. Handle REMOTE_ERROR → retry or FAILED
        await self._handle_errors()

        # 6. Update workflow-level status
        await self._update_workflow_statuses()

    async def _advance_waiting_tasks(self):
        """Check if all parents of WAITING tasks are COMPLETED."""
        waiting = db.query("SELECT * FROM tasks WHERE status = 'WAITING'")
        for task in waiting:
            parents = db.query("""
                SELECT t.status FROM task_links l
                JOIN tasks t ON t.id = l.source_task_id
                WHERE l.target_task_id = ?
            """, task.id)
            if all(p.status == 'COMPLETED' for p in parents):
                db.update_task(task.id, status='READY')

    async def _submit_ready_tasks(self):
        """Generate inputs and submit READY tasks to HPC."""
        ready = db.query("SELECT * FROM tasks WHERE status = 'READY'")
        for task in ready:
            if task.software == 'local':
                await self._execute_local_task(task)
            else:
                await self._submit_hpc_task(task)

    async def _poll_active_tasks(self):
        """Check HPC status for submitted/running tasks."""
        active = db.query("""
            SELECT * FROM tasks
            WHERE status IN ('SUBMITTED', 'QUEUED', 'RUNNING')
            AND hpc_job_id IS NOT NULL
        """)
        for task in active:
            hpc = get_hpc_connection(task.hpc_session_id)
            if not hpc:
                continue  # Will retry next cycle

            job_status = await check_job_status(hpc, task.hpc_job_id)

            if job_status == 'PENDING':
                db.update_task(task.id, status='QUEUED')
            elif job_status == 'RUNNING':
                db.update_task(task.id, status='RUNNING')
            elif job_status == 'COMPLETED':
                db.update_task(task.id, status='COMPLETED_REMOTE')
            elif job_status in ('FAILED', 'TIMEOUT', 'CANCELLED'):
                db.update_task(task.id, status='FAILED',
                    error_message=f"HPC job {job_status}")

    async def _collect_completed_tasks(self):
        """Read results from HPC for tasks that finished."""
        completed = db.query(
            "SELECT * FROM tasks WHERE status = 'COMPLETED_REMOTE'"
        )
        for task in completed:
            db.update_task(task.id, status='COLLECTING')
            try:
                results = await collect_results(task)
                db.store_results(task.id, results)
                db.update_task(task.id, status='COMPLETED')
            except Exception as e:
                db.update_task(task.id, status='REMOTE_ERROR',
                    error_message=str(e))
```

### 2.3 Key Properties

1. **Stateless**: Engine reads everything from DB each cycle. Kill and restart safely.
2. **Idempotent**: Running `scan_cycle()` multiple times has no side effects.
3. **Concurrent-safe**: Multiple scanners can run (DB locking prevents double-submit).
4. **Resumable**: After CatGo restart, scanner picks up from current DB state.
5. **Observable**: Every state transition is a DB write — frontend can poll or subscribe.

### 2.4 Local Task Execution

Tasks with `local=True` (gibbs_energy, slab_gen, etc.) execute in-process:

```python
async def _execute_local_task(self, task):
    """Execute a local task immediately."""
    db.update_task(task.id, status='RUNNING')

    # Resolve input references
    inputs = self._resolve_inputs(task)

    # Get the registered function
    func = task_registry.get(task.task_type)

    # Execute
    try:
        result = func(**inputs, **task.params)
        db.store_results(task.id, result)
        db.update_task(task.id, status='COMPLETED')
    except Exception as e:
        db.update_task(task.id, status='FAILED', error_message=str(e))
```

### 2.5 Input Resolution

Before executing/submitting a task, resolve all OutputReferences from parent results:

```python
def _resolve_inputs(self, task):
    """Replace OutputReferences with actual data from DB."""
    links = db.query(
        "SELECT * FROM task_links WHERE target_task_id = ?", task.id
    )
    inputs = {}
    for link in links:
        result = db.get_result(link.source_task_id)
        value = result.get(link.source_key)
        inputs[link.target_key] = value
    return inputs
```

---

## Phase 3: Frontend Observer

### 3.1 Role Change

```
Before (current):  Frontend DRIVES execution
                   Frontend builds graph → sends JSON → backend executes
                   Frontend monitors via WebSocket
                   Frontend stores graph_json as canonical format

After (refactor):  Frontend OBSERVES and EDITS
                   Backend/Python API creates workflows → tasks table is canonical
                   Frontend reads tasks table → renders DAG
                   Frontend can edit params of WAITING/READY tasks
                   Frontend monitors via polling or WebSocket
```

### 3.2 API Endpoints

```
GET  /api/workflows                    → list all workflows
GET  /api/workflows/{id}               → get workflow + all tasks
GET  /api/workflows/{id}/tasks         → list tasks with status
GET  /api/workflows/{id}/dag           → get DAG structure (nodes + edges)
POST /api/workflows/{id}/submit        → start execution
POST /api/workflows/{id}/pause         → pause (cancel HPC jobs)
POST /api/workflows/{id}/resume        → resume from current state
POST /api/workflows/{id}/reset         → reset all tasks to WAITING

GET  /api/tasks/{id}                   → get task details
PUT  /api/tasks/{id}/params            → update params (only if WAITING/READY)
GET  /api/tasks/{id}/result            → get result data
GET  /api/tasks/{id}/structure         → get output structure (3D viewer)
POST /api/tasks/{id}/retry             → reset task + downstream to WAITING
POST /api/tasks/{id}/cancel            → cancel this task

WS   /api/workflows/{id}/monitor       → real-time status updates
```

### 3.3 Frontend Rendering

The frontend reads the `tasks` and `task_links` tables to render:
- DAG graph (nodes = tasks, edges = links)
- Node colors based on status
- Click node → show params, results, 3D structure
- Edit params of WAITING/READY tasks
- Monitor running tasks

**graph_json is optional** — only stores visual layout (x/y positions). The canonical workflow structure lives in `tasks` + `task_links`.

### 3.4 Backward Compatibility

Existing frontend-created workflows (graph_json based) continue to work:
1. Frontend saves graph_json as before
2. On "Run", backend parses graph_json → creates tasks + task_links in DB
3. Engine executes from DB
4. Frontend monitors from DB

This means the GUI workflow editor doesn't need immediate changes — it just needs a new "Run" endpoint that converts graph_json to tasks.

---

## Phase 4: AI Agent Interface

### 4.1 No Custom UI — Use Existing AI Tools

AI agents (Claude Code, Codex, Gemini CLI) interact via:
1. **MCP Tools** — `catgo_workflow` tool with actions (create, add_task, submit, status, modify)
2. **Python API** — `from catgo.workflow import Workflow, task` (direct import)
3. **Agent Skills** — SKILL.md files teaching agents how to use CatGo

### 4.2 MCP Tool Interface

```python
# Single MCP tool with action routing (like current catgo_workflow)
catgo_workflow_tool = {
    "name": "catgo_workflow",
    "description": "Create and manage computational chemistry workflows",
    "actions": {
        "create": "Create a new workflow",
        "add_task": "Add a task to a workflow",
        "connect": "Connect task outputs to inputs",
        "submit": "Submit workflow for execution",
        "status": "Get workflow/task status",
        "modify": "Modify task parameters (if not yet running)",
        "results": "Get task results",
        "list": "List all workflows",
    }
}
```

### 4.3 Agent Skills (CCAS-style)

```markdown
# SKILL.md — catgo-oer-workflow

## Description
Create and submit an OER overpotential workflow for a given catalyst surface.

## Steps
1. Load the catalyst structure (CIF/POSCAR)
2. Generate slab with appropriate miller indices
3. For each OER intermediate (*OH, *O, *OOH):
   a. Place adsorbate on surface
   b. Add geometry optimization task
   c. Add frequency calculation task (freeze bulk atoms)
   d. Add Gibbs energy calculation task
4. Add free energy diagram task
5. Submit workflow

## Python API Example
```python
from catgo.workflow import Workflow, geo_opt, freq, gibbs_energy

wf = Workflow("RuO2 OER")
slab = wf.add_task("slab_gen", structure=structure, miller=[1,1,0])
for ads in ["OH", "O", "OOH"]:
    placed = wf.add_task("adsorbate_place", structure=slab.output.structure, species=ads)
    opt = wf.add_task(geo_opt, structure=placed.output.structure, ENCUT=520)
    frq = wf.add_task(freq, structure=opt.output.structure, freeze_mode="layers", freeze_layers=4)
    gib = wf.add_task(gibbs_energy, energy=opt.output.energy, frequencies=frq.output.frequencies)
wf.submit()
```
```

### 4.4 Multi-Agent Support

Multiple agents can work concurrently because:
- Each workflow has its own ID — no conflicts
- SQLite handles concurrent reads, serialized writes
- Agent A creates workflow for catalyst X, Agent B for catalyst Y
- Both submit, engine executes both in parallel

---

## Migration Strategy

### Phase 1 (Python API + DB): ~2 weeks
- New `catgo/workflow/` Python package alongside existing code
- New DB tables (`tasks`, `task_links`, `task_results`)
- Existing frontend workflows unaffected

### Phase 2 (Engine): ~2 weeks
- New `WorkflowEngine` scanner replaces `orchestrator.py`
- Reuse existing HPC code (`hpc_execute.py`, `vasp.py`, etc.)
- Old orchestrator kept as fallback

### Phase 3 (Frontend): ~1 week
- Add "observe from DB" mode to existing frontend
- Keep existing graph editor working
- graph_json → tasks conversion on Run

### Phase 4 (AI): ~1 week
- Update MCP tools to use new Python API
- Write Agent Skills
- Test with Claude Code

### Total: ~6 weeks, incremental, no big-bang rewrite

---

## Design Principles

1. **DB is the API** — Everything goes through SQLite. No in-memory state.
2. **HPC is truth** — Remote files are authoritative. DB can be rebuilt from them.
3. **Scanner is dumb** — Each cycle does one pass. No complex scheduling.
4. **Fail loudly, recover quietly** — Log errors at ERROR level, retry automatically.
5. **Frontend is optional** — Workflows run without anyone watching.
6. **Python first, GUI second** — API works without frontend.
7. **Backward compatible** — Existing GUI workflows continue to work.
8. **No hardcoded values** — All parameters are configurable. Zero magic numbers in code.

---

## Configuration System

### Layered Config Resolution

All parameters follow a 4-layer priority chain (highest wins):

```
Task-level override  >  Workflow-level config  >  User config  >  System defaults
```

### Config File: `~/.catgo/config.yaml`

```yaml
# ─── Engine ───
engine:
  poll_interval: 30             # seconds between scan cycles
  submit_batch_size: 5          # max tasks to submit per cycle
  max_concurrent_jobs: 20       # total HPC jobs across all workflows
  result_collect_timeout: 300   # seconds to wait for result collection

# ─── HPC Connection ───
hpc:
  ssh_timeout: 30               # seconds
  ssh_retry_max: 3
  ssh_retry_backoff: 10         # seconds base delay
  poll_retry_max: 5             # max consecutive poll failures before giving up
  poll_retry_backoff: 60        # seconds base delay for poll retries
  poll_retry_factor: 2          # exponential backoff multiplier

# ─── Task Retry ───
retry:
  max_retries: 3                # per task
  backoff_base: 60              # seconds
  backoff_factor: 2             # exponential
  max_backoff: 3600             # cap at 1 hour

# ─── Software Defaults ───
# These are the fallback values when a task doesn't specify a parameter.
# Users can override per-task via Python API or GUI.
defaults:
  vasp:
    ENCUT: 520
    EDIFF: 1e-5
    PREC: "Accurate"
    ALGO: "Fast"
    ISMEAR: 0
    SIGMA: 0.05
    LREAL: "Auto"
    NELM: 200
    ISPIN: 1
    LORBIT: 11
    LWAVE: false
    LCHARG: false
    NCORE: 4

  vasp_geo_opt:
    ISIF: 2
    NSW: 200
    EDIFFG: -0.02
    IBRION: 2

  vasp_freq:
    IBRION: 5
    NFREE: 2
    POTIM: 0.015
    LREAL: ".FALSE."
    EDIFF: 1e-6

  vasp_single_point:
    NSW: 0
    IBRION: -1
    NEDOS: 3001

  cp2k:
    cutoff: 600
    rel_cutoff: 60
    xc_functional: "PBE"
    scf_max_iter: 200

  orca:
    method: "B3LYP"
    basis: "def2-SVP"
    charge: 0
    multiplicity: 1

  gibbs:
    temperature: 298.15
    freq_cutoff: 50
    pressure_atm: 1.0
    phase: "adsorbed"

# ─── Paths ───
paths:
  work_dir_template: "{base_dir}/{workflow_id}/{task_id}"
  base_dir: ""                  # set per HPC session, e.g. /scratch/$USER/catgo
  db_path: "~/.catgo/catgo.db"
  log_dir: "~/.catgo/logs/"
  config_dir: "~/.catgo/"

# ─── Logging ───
logging:
  level: "INFO"                 # DEBUG/INFO/WARNING/ERROR
  max_log_size: 10485760        # 10MB
  log_rotation: 5               # keep 5 rotated files
```

### Config Loading in Python

```python
from catgo.config import load_config, get_default

# Load merges: system defaults → ~/.catgo/config.yaml → env vars
config = load_config()

# Get a value with fallback chain
encut = get_default(config, "vasp", "ENCUT")           # → 520
freq_potim = get_default(config, "vasp_freq", "POTIM") # → 0.015
poll = config["engine"]["poll_interval"]                # → 30

# Environment variable override (highest priority)
# CATGO_ENGINE_POLL_INTERVAL=10 overrides config.yaml
```

### Per-Workflow Config Override

```python
wf = Workflow("test", config={
    "engine": {"poll_interval": 10},     # faster polling for this workflow
    "defaults": {"vasp": {"ENCUT": 600}} # higher ENCUT for this workflow
})
```

### Per-Task Parameter Override

```python
# Task-level params always win over defaults
wf.add_task(geo_opt,
    structure=slab.output.structure,
    ENCUT=800,        # overrides workflow default (600) and global default (520)
    EDIFF=1e-7,       # overrides global default (1e-5)
    # PREC not specified → falls back to workflow config → global config → "Accurate"
)
```

### Resolution Order Example

For `ENCUT` on a geo_opt task:

```
1. Task params_json has ENCUT=800?         → use 800
2. Workflow config has defaults.vasp.ENCUT? → use that
3. User config has defaults.vasp.ENCUT?     → use that (e.g. 520)
4. System defaults has ENCUT?               → use built-in fallback
```

# P8: Surpass AiiDA-WorkGraph — Map / Zone / Loop / Provenance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five capabilities that close every feature gap with AiiDA-WorkGraph while leveraging CatGo's existing advantages (zero-deploy SQLite, GUI, AI agent, Custodian). After this plan, CatGo has everything AiiDA-WorkGraph offers plus things it cannot match.

**Architecture:** All features build on the existing `catgo.workflow` package. New task types (`map`, `zone`, `while`) are registered via the `@task` decorator. The scanner handles control-flow semantics during `scan_cycle()`. DB schema extends with two new tables and two new columns. No new infrastructure dependencies.

**Tech Stack:** Python 3.11+, SQLite, existing `catgo.workflow` package

**Spec:** Based on analysis of AiiDA-WorkGraph source (see `references/aiida_workgraph_analysis.md`)

---

## Strategic Analysis: Where AiiDA-WorkGraph is Strong

AiiDA-WorkGraph's power comes from four control-flow primitives built as "Zone" tasks:
1. **Map** — fan-out: clone a sub-graph N times with different inputs
2. **Zone** — grouping: encapsulate sub-graphs as reusable modules
3. **While** — iteration: repeat until convergence condition met
4. **If** — conditional: skip branches based on runtime values

Plus two infrastructure strengths:
5. **Full provenance** — every data node links to the computation that produced it
6. **Live graph modification** — add/remove/reset tasks via RabbitMQ messages

CatGo's counter-strengths that AiiDA cannot match:
- Zero deploy (SQLite vs PostgreSQL + RabbitMQ)
- 3D visualization + convergence plots + file browser in one GUI
- AI agent native (MCP + skills + CatBot)
- Custodian error recovery already integrated
- Crash-recoverable stateless scanner (no daemon state to lose)
- GUI drag-and-drop editor for non-programmers

**Strategy:** Implement Map, Zone, While, conditional execution, and lightweight provenance — but do it the CatGo way: SQLite-native, scanner-friendly, GUI-visible, AI-agent-composable.

---

## Feature 1: Map Operation (Fan-Out)

### Design

The Map operation expands a template task (or sub-graph) into N parallel instances. Unlike AiiDA's clone-and-rewire approach, CatGo uses a cleaner model: the map task is a special local task that creates child tasks in the DB during execution.

### Proposed API

```python
from catgo.workflow import Workflow
from catgo.workflow.builtins import geo_opt, freq, gibbs_energy

wf = Workflow("OER — All Intermediates")
slab = wf.add_task("structure_input", structure=clean_slab)

# Map over adsorbates: creates 4 parallel branches
adsorbates = {"OH": oh_struct, "O": o_struct, "OOH": ooh_struct, "clean": clean_slab}
mapped = wf.map(
    source=adsorbates,
    tasks=lambda item: [
        geo_opt(structure=item.value, system_name=item.key),
        freq(structure=geo_opt.output.structure, system_name=item.key),
        gibbs_energy(energy=geo_opt.output.energy,
                     frequencies=freq.output.frequencies,
                     system_name=item.key),
    ],
)

# Gather results from all branches
diagram = wf.add_task(free_energy_diagram,
                      gibbs_values=mapped.gather("gibbs"))
wf.submit()
```

### Alternative API (simpler, for single-task fan-out)

```python
# Fan-out a single task over a list of structures
encuts = [400, 450, 500, 550, 600]
mapped = wf.map_task(
    single_point,
    over={"ENCUT": encuts},
    structure=slab.output.structure,
)
# mapped.gather("energy") -> list of energies in order
```

### DB Schema Extension

```sql
-- New columns on tasks table
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;      -- points to map/zone/while task
ALTER TABLE tasks ADD COLUMN map_key TEXT;              -- "OH", "O", etc. for mapped instances
ALTER TABLE tasks ADD COLUMN task_group TEXT;           -- groups cloned sub-graphs

-- New index
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
```

### State Machine Extension

Add one new state to `TaskState`:

```python
MAPPED = "MAPPED"    # Template task — children were spawned, template itself won't run
```

Update `_TERMINAL_STATES` to include `MAPPED` (it is a terminal state for the template).

### Scanner Logic

In `_process_workflow`, after `advance_waiting_tasks`:

```python
# Expand READY map tasks into children
map_tasks = db.get_tasks_by_status(workflow_id, "READY")
for task in map_tasks:
    if task["task_type"] == "map":
        self._expand_map_task(task)
```

The `_expand_map_task` method:
1. Reads `source` from params (dict or list)
2. For each key/value, creates child tasks in the DB with `parent_task_id` set
3. Wires links between children (reproducing the template's internal links)
4. Sets template task status to `MAPPED`
5. Children start as `WAITING` and get advanced normally

### Gather Mechanism

A `gather` task is a local task that:
1. Waits for all children of a map task to complete
2. Collects specified output key from each child's results
3. Returns them as a list (ordered by map_key)

```python
@task(task_type="__gather__", local=True, outputs=["gathered"])
def gather_results(parent_task_id, output_key, db):
    children = db.get_children_of(parent_task_id)
    results = []
    for child in sorted(children, key=lambda c: c["map_key"]):
        result = db.get_result(child["id"])
        results.append(result.get(output_key))
    return {"gathered": results}
```

### GUI Representation

Map tasks render as a "group box" in the DAG viewer. Children inside the group are shown as a stack with the map_key label. When collapsed, shows "Map: 4 branches (3 done)".

---

## Feature 2: Zone / SubWorkflow (Reusable Task Groups)

### Design

A Zone is a named group of tasks that can be:
1. Defined once and reused across workflows
2. Collapsed/expanded in the GUI
3. Treated as a single node for dependency purposes

Unlike AiiDA's Zone which is a special Task subclass with a `children` attribute, CatGo's approach uses the existing DAG model: a zone is just a task whose "execution" means "wait for all my children to finish."

### Proposed API

```python
from catgo.workflow import Workflow, Zone

# Define a reusable zone
def opt_freq_gibbs(wf, structure_ref, system_name):
    """Standard optimization -> frequency -> Gibbs pipeline."""
    zone = wf.zone(f"OFG-{system_name}")
    opt = zone.add_task(geo_opt, structure=structure_ref, system_name=system_name)
    frq = zone.add_task(freq, structure=opt.output.structure, system_name=system_name)
    gib = zone.add_task(gibbs_energy, energy=opt.output.energy,
                        frequencies=frq.output.frequencies, system_name=system_name)
    return zone  # zone.output.gibbs, zone.output.structure, etc.

# Use in a workflow
wf = Workflow("OER Study")
slab = wf.add_task("structure_input", structure=clean_slab)

oh_zone = opt_freq_gibbs(wf, slab.output.structure, "*OH")
o_zone = opt_freq_gibbs(wf, slab.output.structure, "*O")

diagram = wf.add_task(free_energy_diagram,
                      gibbs_values=[oh_zone.output.gibbs, o_zone.output.gibbs])
wf.submit()
```

### Implementation

The `Zone` class is a thin wrapper around `Workflow.add_task`:

```python
class Zone:
    """A named group of tasks within a workflow."""

    def __init__(self, workflow: Workflow, name: str):
        self.workflow = workflow
        self.name = name
        # Create a zone task in the DB (local, acts as a barrier)
        self.zone_task_id = workflow.db.create_task(
            workflow_id=workflow.workflow_id,
            task_type="__zone__",
            name=name,
        )
        self._child_ids: list[str] = []
        self._output_map: dict[str, OutputReference] = {}

    def add_task(self, task_or_type, **kwargs) -> TaskHandle:
        handle = self.workflow.add_task(task_or_type, **kwargs)
        # Mark as child of this zone
        self.workflow.db.update_task(handle.task_id, parent_task_id=self.zone_task_id)
        self._child_ids.append(handle.task_id)
        # Track outputs for zone.output.X forwarding
        if hasattr(task_or_type, '_catgo_definition'):
            for out_key in task_or_type._catgo_definition.outputs:
                self._output_map[out_key] = getattr(handle.output, out_key)
        return handle

    @property
    def output(self) -> OutputReference:
        # Returns the zone task's output ref (resolved from last child)
        return OutputReference(self.zone_task_id)
```

The `__zone__` task type in the scanner:
- Transitions to RUNNING when all children become READY or are already running
- Transitions to COMPLETED when all children are COMPLETED
- Transitions to FAILED if any child is FAILED
- Propagates PAUSED/CANCELLED to children

### Zone as Template (Reusable)

```python
# Save a zone definition as a template
wf.save_zone_template("opt-freq-gibbs", zone_definition_dict)

# Load and instantiate in another workflow
wf2 = Workflow("CO2RR Study")
zone = wf2.load_zone_template("opt-freq-gibbs",
                               structure=some_structure,
                               system_name="*COOH")
```

Templates are stored in a new `zone_templates` table:

```sql
CREATE TABLE IF NOT EXISTS zone_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    definition_json TEXT NOT NULL,  -- serialized task types + links
    created_at TEXT
);
```

---

## Feature 3: While / Loop (Iterative Convergence)

### Design

The While loop repeats a zone of tasks until a condition is met or max_iterations is reached. This is essential for:
- Convergence testing (repeat until energy change < threshold)
- Self-consistent field iteration
- Iterative structure refinement

### Proposed API

```python
wf = Workflow("Convergence Test")
struct = wf.add_task("structure_input", structure=initial)

# While loop: keep optimizing until forces converge
loop = wf.while_loop(
    name="force-convergence",
    max_iterations=10,
    condition=lambda results: results.get("max_force", 999) > 0.01,
)
opt = loop.add_task(geo_opt, structure=struct.output.structure, NSW=50)
check = loop.add_task("convergence_check",
                      structure=opt.output.structure,
                      energy=opt.output.energy)
# Loop feeds output back as input for next iteration
loop.feedback(opt.output.structure, to=opt, key="structure")

wf.submit()
```

### Alternative: Decorator-Based Loop

```python
@task(task_type="convergence_check", local=True, outputs=["converged", "max_force"])
def convergence_check(energy=None, prev_energy=None, structure=None, threshold=0.01):
    forces = compute_forces(structure)
    max_force = max(abs(f) for f in forces)
    converged = max_force < threshold
    return {"converged": converged, "max_force": max_force}
```

### Implementation

While loops use the existing scanner with loop-awareness:

```python
# New task types
@task(task_type="__while__", local=True)
def while_controller(**kwargs):
    """Control task for while loops. Never called directly."""
    pass
```

Scanner logic for while tasks:

```python
def _handle_while_task(self, task, workflow_id):
    children = self.db.get_children_of(task["id"])
    params = json.loads(task["params_json"])
    max_iter = params.get("max_iterations", 100)
    iteration = task.get("retry_count", 0)  # reuse retry_count as iteration counter

    if iteration >= max_iter:
        self.db.update_task(task["id"], status=TaskState.COMPLETED.value)
        return

    # Check if all children finished this iteration
    all_done = all(c["status"] == TaskState.COMPLETED.value for c in children)
    if not all_done:
        return  # Still running

    # Evaluate condition
    condition_task = next(c for c in children if c["task_type"] == "convergence_check")
    result = self.db.get_result(condition_task["id"])
    if result and result.get("converged"):
        self.db.update_task(task["id"], status=TaskState.COMPLETED.value)
        return

    # Not converged: reset children for next iteration, increment counter
    for child in children:
        self.db.update_task(child["id"], status=TaskState.WAITING.value)
    # Apply feedback links (copy outputs to inputs for next iteration)
    self._apply_feedback_links(task["id"], workflow_id)
    self.db.update_task(task["id"], retry_count=iteration + 1)
```

### DB Changes

Feedback links stored in `task_links` with a special marker:

```sql
-- Add link_type column to distinguish regular links from feedback
ALTER TABLE task_links ADD COLUMN link_type TEXT DEFAULT 'data';
-- link_type: 'data' (normal), 'feedback' (loop back), 'condition' (while condition)
```

### GUI Representation

While loops render as a dashed-border group with an iteration counter badge: "Iteration 3/10". The convergence check task shows a mini-chart of the convergence metric over iterations.

---

## Feature 4: Smart Error Recovery (Custodian + AI Agent)

### Design

CatGo already has Custodian integrated for VASP error recovery. The gap is:
1. Non-VASP errors (CP2K, ORCA, LAMMPS) have no handler
2. No AI-assisted recovery for novel errors
3. No user-in-the-loop recovery option

### Architecture: Three-Tier Error Recovery

```
Tier 1: Custodian (automatic, milliseconds)
  - VASP: existing handlers (ZBRENT, EDDDAV, etc.)
  - CP2K/ORCA: add custodian-like handlers

Tier 2: AI Agent (automatic, seconds)
  - Parse error output with LLM
  - Suggest parameter fixes
  - Apply and retry if confidence > threshold

Tier 3: User Decision (manual, GUI)
  - Show error + AI diagnosis in GUI
  - User picks: retry with fix / skip / abort
  - MCP tool for CLI-based recovery
```

### Proposed API

```python
from catgo.workflow import Workflow
from catgo.workflow.recovery import custodian_handler, ai_handler

wf = Workflow("Robust Calculation")
opt = wf.add_task(geo_opt, structure=struct,
                  error_handlers=[
                      custodian_handler(max_retries=3),
                      ai_handler(model="claude-sonnet", max_retries=1),
                  ])
```

### Implementation

Extend the error_handler.py:

```python
def handle_errors(db: WorkflowDB, workflow_id: str, config: dict):
    errored = db.get_tasks_by_status(workflow_id, TaskState.REMOTE_ERROR.value)
    for task in errored:
        retry_count = task.get("retry_count", 0)
        max_retries = task.get("max_retries", 3)

        if retry_count < max_retries:
            # Tier 1: Try custodian-style fix
            fix = try_custodian_fix(task, db)
            if fix:
                apply_fix(db, task, fix)
                db.update_task(task["id"],
                    status=TaskState.READY.value,
                    retry_count=retry_count + 1)
                continue

            # Tier 2: Try AI diagnosis
            if config.get("ai_recovery", {}).get("enabled", False):
                diagnosis = await diagnose_with_ai(task, db, config)
                if diagnosis and diagnosis["confidence"] > 0.7:
                    apply_fix(db, task, diagnosis["fix"])
                    db.update_task(task["id"],
                        status=TaskState.READY.value,
                        retry_count=retry_count + 1,
                        error_message=f"AI fix applied: {diagnosis['summary']}")
                    continue

            # Tier 3: Escalate to user
            db.update_task(task["id"],
                status=TaskState.PAUSED.value,
                error_message=f"Needs manual review: {task.get('error_message')}")
        else:
            db.update_task(task["id"], status=TaskState.FAILED.value)
```

### AI Diagnosis MCP Tool

```python
# Exposed as MCP tool for Claude Code to call
async def diagnose_calculation_error(task_id: str):
    """AI agent reads error output and suggests fixes."""
    task = db.get_task(task_id)
    error_log = read_remote_error_log(task)

    prompt = f"""Analyze this {task['software']} calculation error:
    Task type: {task['task_type']}
    Parameters: {task['params_json']}
    Error output (last 200 lines):
    {error_log[-200:]}

    Suggest specific parameter changes to fix this error."""

    # Call LLM for diagnosis
    response = await llm_call(prompt)
    return {"diagnosis": response, "task_id": task_id}
```

---

## Feature 5: Lightweight Provenance Tracking

### Design

AiiDA's provenance is a full ORM with Data nodes, CalcJob nodes, and Link objects in PostgreSQL. It is powerful but heavyweight. CatGo's approach: track provenance in SQLite with a simple lineage table that records what produced each result.

### Schema

```sql
CREATE TABLE IF NOT EXISTS provenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    output_key TEXT NOT NULL,           -- "energy", "structure", etc.
    value_hash TEXT,                     -- SHA-256 of the output value
    input_hashes TEXT,                   -- JSON: {"structure": "abc123", "ENCUT": "def456"}
    software TEXT,                       -- "vasp", "cp2k", etc.
    software_version TEXT,               -- "6.4.1"
    created_at TEXT,
    metadata_json TEXT DEFAULT '{}',     -- walltime, node count, etc.
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_provenance_hash ON provenance(value_hash);
CREATE INDEX idx_provenance_task ON provenance(task_id);
```

### Automatic Recording

In the scanner, after storing results:

```python
# After db.store_result(task_id, workflow_id, **db_result)
import hashlib, json

for key, value in db_result.items():
    value_str = json.dumps(value, sort_keys=True, default=str)
    value_hash = hashlib.sha256(value_str.encode()).hexdigest()[:16]

    input_hashes = {}
    for link in db.get_task_parents(task_id):
        parent_result = db.get_result(link["source_task_id"])
        if parent_result:
            parent_val = parent_result.get(link["source_key"])
            if parent_val:
                pv_str = json.dumps(parent_val, sort_keys=True, default=str)
                input_hashes[link["source_key"]] = hashlib.sha256(pv_str.encode()).hexdigest()[:16]

    db.record_provenance(
        workflow_id=workflow_id,
        task_id=task_id,
        output_key=key,
        value_hash=value_hash,
        input_hashes=json.dumps(input_hashes),
        software=task.get("software"),
    )
```

### Query API

```python
# "Where did this energy value come from?"
provenance = db.trace_provenance(task_id="abc123", output_key="energy")
# Returns: {
#   "task": "geo_opt", "software": "vasp",
#   "inputs": {"structure": {"from_task": "xyz789", "hash": "a1b2c3"}},
#   "output_hash": "d4e5f6",
#   "created_at": "2026-03-28T..."
# }

# "What calculations used this structure?"
descendants = db.find_descendants(value_hash="a1b2c3")
# Returns list of tasks that consumed this exact structure
```

### Provenance Comparison (Deduplication)

Before submitting a task, check if an identical computation already exists:

```python
def check_duplicate(db, task_type, input_hashes, params):
    """Find existing result with same inputs + params."""
    existing = db.find_provenance_by_inputs(
        input_hashes=input_hashes,
        params_hash=hash_params(params),
    )
    if existing:
        logger.info("Reusing cached result from task %s", existing["task_id"])
        return existing["task_id"]
    return None
```

This gives CatGo a lightweight equivalent of AiiDA's caching without the ORM overhead.

---

## Feature 6: Conditional Task Execution

### Design

Simple: add a `condition` parameter to `add_task` that skips the task if the condition evaluates to False at runtime.

### Proposed API

```python
opt = wf.add_task(geo_opt, structure=struct)
# Only run frequency if optimization converged
frq = wf.add_task(freq, structure=opt.output.structure,
                  run_if=opt.output.converged)
# Skip downstream if frequency was skipped
gib = wf.add_task(gibbs_energy,
                  energy=opt.output.energy,
                  frequencies=frq.output.frequencies,
                  skip_on_parent_skip=True)
```

### Implementation

Add `condition_json` column to tasks table. In the advancer:

```python
def advance_waiting_tasks(db, workflow_id):
    for task in waiting:
        # ... existing parent check ...
        if all_completed:
            # Check condition
            condition = json.loads(task.get("condition_json") or "null")
            if condition is not None:
                should_run = evaluate_condition(db, condition)
                if not should_run:
                    db.update_task(task_id, status=TaskState.SKIPPED.value)
                    continue
            db.update_task(task_id, status=TaskState.READY.value)
```

Add `SKIPPED` to `TaskState` (treated as terminal, like COMPLETED for dependency purposes).

---

## Feature 7: High-Throughput Batch Execution (Port from Old Engine)

### Motivation

The V1 workflow engine (`batch_execute.py`, `hpc_execute.py`) has battle-tested capabilities for high-throughput HPC execution that the V2 scanner-based engine currently lacks. These must be ported to V2 before it can handle real catalysis screening workloads (1000+ structures).

The V2 engine currently submits each task as a separate `sbatch` call with a `submit_batch_size` throttle. This is fundamentally wrong for high-throughput: 1000 catalysts should be 1 SLURM array job, not 1000 individual submissions.

### Key Capabilities to Port

#### 7a. SLURM Array Jobs (from batch_execute.py)

When the scanner detects a fan-out (a map task that spawned N children of the same task type), it should auto-promote to a single `sbatch --array=0-N%max_concurrent` submission instead of N separate sbatch calls.

**Why this matters:** SLURM schedulers penalize users who submit thousands of individual jobs. Array jobs are a single scheduler entry, start faster, and are easier to monitor.

**Proposed V2 API:**

```python
# The scanner detects fan-out automatically. No user config needed.
# But users can tune array job behavior:
wf = Workflow("Catalyst Screen")

mapped = wf.map_task(
    geo_opt,
    over={"structure": catalyst_list},  # 1000 structures
    array_job=True,                     # default: auto-detect
    max_concurrent=50,                  # sbatch --array=0-999%50
)

# Under the hood, the scanner:
# 1. Sees 1000 READY children of same task_type from a single map
# 2. Generates a shared SLURM array script
# 3. Submits ONE sbatch call: sbatch --array=0-999%50 run.sh
# 4. Each array task reads input from subdirectory $SLURM_ARRAY_TASK_ID/
```

**Scanner auto-promotion logic:**

```python
def _maybe_promote_to_array(self, parent_task_id: str, children: list[dict]):
    """Detect fan-out and promote to SLURM array job."""
    # Only promote if all children are same task_type and READY
    task_types = {c["task_type"] for c in children}
    statuses = {c["status"] for c in children}
    if len(task_types) != 1 or statuses != {TaskState.READY.value}:
        return False
    if len(children) < self.ARRAY_JOB_THRESHOLD:  # default: 3
        return False

    # Generate array job script
    array_script = self._generate_array_script(children)
    max_concurrent = self._get_max_concurrent(children[0])

    # Single sbatch submission
    job_id = self.hpc.submit_array_job(
        script=array_script,
        array_range=f"0-{len(children)-1}%{max_concurrent}",
        work_dir=parent_work_dir,
    )

    # Tag all children with the shared SLURM job ID
    for i, child in enumerate(children):
        self.db.update_task(child["id"],
            status=TaskState.SUBMITTED.value,
            slurm_job_id=f"{job_id}_{i}",
            array_index=i,
        )
    return True
```

#### 7b. Batch Upload (from batch_execute.py lines 130-151)

All N subdirectories of input files are uploaded in a single SSH transport call, not N separate `sftp.put()` calls. The old engine also uses an 8-way `asyncio.Semaphore` for parallel POTCAR generation before upload.

**Proposed V2 implementation:**

```python
async def batch_upload(self, children: list[dict], base_remote_dir: str):
    """Upload all child task inputs in one SSH session."""
    # Phase 1: Generate all input files locally (parallel, semaphore-limited)
    sem = asyncio.Semaphore(8)
    async def gen_inputs(child):
        async with sem:
            return await self._generate_input_files(child)

    local_dirs = await asyncio.gather(*[gen_inputs(c) for c in children])

    # Phase 2: Single recursive upload
    # tar locally -> sftp single file -> untar remotely
    tarball = self._create_tarball(local_dirs, base_remote_dir)
    async with self.hpc.ssh_session() as ssh:
        await ssh.put(tarball, f"{base_remote_dir}/inputs.tar.gz")
        await ssh.run(f"cd {base_remote_dir} && tar xzf inputs.tar.gz && rm inputs.tar.gz")
```

#### 7c. Auto-Continuation for Non-Convergence (from hpc_execute.py lines 437-550)

VASP calculations frequently hit the NSW (max ionic steps) limit without converging. The old engine detects this and auto-continues: copies CONTCAR to POSCAR, optionally scales NSW upward, and re-submits in the same work_dir.

**Proposed V2 implementation:**

```python
# Task-level configuration
opt = wf.add_task(geo_opt, structure=struct,
                  auto_continue=True,       # default for geo_opt
                  max_continuations=3,       # default: 3
                  nsw_scale_factor=1.5)      # multiply NSW each continuation

# Scanner logic after task completes:
def _check_auto_continuation(self, task: dict, result: dict):
    """Check if a completed task needs auto-continuation."""
    if not task.get("auto_continue"):
        return False
    continuation_count = task.get("continuation_count", 0)
    max_cont = task.get("max_continuations", 3)

    if continuation_count >= max_cont:
        return False

    # Check for non-convergence indicators
    if result.get("converged") is False or result.get("reached_nsw_limit"):
        # Copy CONTCAR -> POSCAR on remote
        self.hpc.copy_remote(
            f"{task['work_dir']}/CONTCAR",
            f"{task['work_dir']}/POSCAR"
        )
        # Optionally scale NSW
        scale = task.get("nsw_scale_factor", 1.0)
        if scale > 1.0:
            self._update_remote_incar(task['work_dir'], "NSW",
                                       int(task['nsw'] * scale))

        self.db.update_task(task["id"],
            status=TaskState.READY.value,
            continuation_count=continuation_count + 1)
        return True
    return False
```

#### 7d. Adaptive Polling with Reconnection (from hpc_execute.py lines 334-436)

The old engine handles SSH instability gracefully:
- **Exponential backoff** on SSH connection failures (30s -> 60s -> 120s -> ... capped at 600s)
- **Auto-reconnection** with fresh SSH session on failure
- **7-day timeout** for long calculations (some DFT jobs run for days)
- **Three-tier status fallback:** `squeue` (running jobs) -> `sacct` (completed jobs) -> file-based check (look for OUTCAR/output files on disk)

**Proposed V2 implementation:**

```python
class AdaptiveHPCPoller:
    """Resilient HPC job status polling."""

    def __init__(self, base_interval=30, max_interval=600, job_timeout=7*24*3600):
        self.base_interval = base_interval
        self.max_interval = max_interval
        self.job_timeout = job_timeout
        self._backoff_count = 0

    async def check_job_status(self, job_id: str, work_dir: str) -> str:
        """Three-tier status check with automatic fallback."""
        try:
            # Tier 1: squeue (fastest, for running/pending jobs)
            status = await self.hpc.squeue_check(job_id)
            if status:
                self._backoff_count = 0
                return status

            # Tier 2: sacct (for recently completed jobs)
            status = await self.hpc.sacct_check(job_id)
            if status:
                self._backoff_count = 0
                return status

            # Tier 3: File-based check (last resort, SSH may have dropped)
            return await self._file_based_check(work_dir)

        except SSHConnectionError:
            self._backoff_count += 1
            wait = min(self.base_interval * (2 ** self._backoff_count),
                       self.max_interval)
            logger.warning("SSH failed, backing off %ds (attempt %d)",
                          wait, self._backoff_count)
            await asyncio.sleep(wait)
            await self.hpc.reconnect()
            return "POLLING_RETRY"

    async def _file_based_check(self, work_dir: str) -> str:
        """Check output files to determine job status."""
        async with self.hpc.ssh_session() as ssh:
            # Check for completion markers
            if await ssh.exists(f"{work_dir}/OUTCAR"):
                content = await ssh.tail(f"{work_dir}/OUTCAR", lines=5)
                if "General timing" in content:
                    return "COMPLETED"
            if await ssh.exists(f"{work_dir}/slurm-*.out"):
                content = await ssh.tail(f"{work_dir}/slurm-*.out", lines=20)
                if "error" in content.lower():
                    return "FAILED"
            return "UNKNOWN"
```

#### 7e. Parameter Override Hierarchy

The old engine supports step-level > cluster-level > global defaults for SLURM parameters, so the same workflow runs on different clusters without modification:

```python
# Global defaults (in config.yaml)
defaults:
  vasp:
    nodes: 1
    ntasks_per_node: 48
    time: "24:00:00"

# Cluster overrides (in clusters.yaml)
clusters:
  perlmutter:
    partition: "regular"
    qos: "regular"
    nodes: 2
    constraint: "cpu"
  frontera:
    partition: "normal"
    nodes: 4
    ntasks_per_node: 56

# Step-level override (in workflow definition)
opt = wf.add_task(geo_opt, structure=struct,
                  slurm={"nodes": 4, "time": "48:00:00"})
```

Resolution order: `task.slurm > cluster_config > global_defaults`

#### 7f. Topological Sort Layer Execution

All nodes in the same topological layer execute as concurrent asyncio tasks. The scanner already handles this via the READY state, but the old engine's explicit layer-based execution is more efficient for batch submission: all tasks in a layer can be submitted as a single array job if they share the same task_type.

### Schema Extensions for Batch Execution

```sql
-- New columns on tasks table for array job support
ALTER TABLE tasks ADD COLUMN array_index INTEGER;          -- position in SLURM array
ALTER TABLE tasks ADD COLUMN array_parent_job_id TEXT;      -- shared SLURM job ID
ALTER TABLE tasks ADD COLUMN continuation_count INTEGER DEFAULT 0;

-- Batch execution tracking
CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    parent_task_id TEXT,               -- the map task that spawned this batch
    slurm_job_id TEXT,                 -- SLURM array job ID
    array_size INTEGER NOT NULL,
    max_concurrent INTEGER DEFAULT 50,
    status TEXT DEFAULT 'PENDING',     -- PENDING, SUBMITTED, PARTIAL, COMPLETED, FAILED
    submitted_at TEXT,
    completed_at TEXT,
    completed_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    failed_indices TEXT,               -- JSON array of failed array indices
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX idx_batch_jobs_workflow ON batch_jobs(workflow_id);
CREATE INDEX idx_batch_jobs_slurm ON batch_jobs(slurm_job_id);
```

### Batch Results Schema

Per-array-task results are stored individually in the existing `task_results` table (one row per child task), but the `batch_jobs` table provides aggregate tracking:

```python
# Query batch progress
batch = db.get_batch_job(batch_id)
# {
#   "array_size": 1000,
#   "completed_count": 847,
#   "failed_count": 3,
#   "failed_indices": [42, 517, 893],
#   "status": "PARTIAL"
# }

# Retry only failed tasks
db.retry_batch_failures(batch_id)
# -> re-submits sbatch --array=42,517,893 run.sh
```

---



### Phase A: Foundation (Estimated: 4-6 hours)

- [ ] Add `parent_task_id`, `map_key`, `task_group` columns to tasks table
- [ ] Add `link_type` column to task_links table
- [ ] Add `MAPPED` and `SKIPPED` states to TaskState
- [ ] Update advancer to treat `SKIPPED` as terminal (satisfies parent dependency)
- [ ] Create `provenance` and `zone_templates` tables
- [ ] Add DB migration function for existing databases

### Phase B: Zone + Conditional (Estimated: 4-6 hours)

- [ ] Implement `Zone` class in `workflow.py`
- [ ] Register `__zone__` task type in builtins
- [ ] Add zone execution logic to scanner (RUNNING when children start, COMPLETED when all done)
- [ ] Implement `condition_json` evaluation in advancer
- [ ] Add `run_if` and `skip_on_parent_skip` parameters to `add_task`
- [ ] Test: zone with 3 tasks, conditional skip

### Phase C: Map Operation (Estimated: 6-8 hours)

- [ ] Implement `Workflow.map()` and `Workflow.map_task()` methods
- [ ] Implement `_expand_map_task()` in scanner (clone tasks, wire links)
- [ ] Implement `__gather__` task type
- [ ] Test: map over 4 adsorbates, gather results
- [ ] Test: map_task over list of ENCUT values
- [ ] GUI: render map groups in DAG viewer

### Phase D: While Loop (Estimated: 6-8 hours)

- [ ] Implement `Workflow.while_loop()` method
- [ ] Implement `__while__` task type and scanner logic
- [ ] Implement feedback links (loop output back to input)
- [ ] Register `convergence_check` built-in task
- [ ] Test: while loop with max_iterations=5, convergence after 3
- [ ] GUI: render while loops with iteration counter

### Phase E: Provenance (Estimated: 3-4 hours)

- [ ] Add provenance recording to scanner (after store_result)
- [ ] Implement `trace_provenance()` and `find_descendants()` queries
- [ ] Implement duplicate detection (`check_duplicate`)
- [ ] Add provenance viewer to task detail panel in GUI
- [ ] Test: trace lineage through 3-task chain

### Phase F: Smart Error Recovery (Estimated: 4-6 hours)

- [ ] Extend error_handler.py with three-tier system
- [ ] Add AI diagnosis function (reads error log, calls LLM)
- [ ] Add MCP tool for manual error diagnosis
- [ ] Add "Fix & Retry" button to GUI task detail panel
- [ ] Test: simulated VASP error -> custodian fix -> retry

### Phase G: High-Throughput Batch Execution (Estimated: 8-10 hours)

- [ ] Add `array_index`, `array_parent_job_id`, `continuation_count` columns to tasks table
- [ ] Create `batch_jobs` table and migration
- [ ] Implement `_maybe_promote_to_array()` in scanner (detect fan-out, generate array script)
- [ ] Implement `batch_upload()` — tar+sftp+untar single-session upload
- [ ] Implement `_check_auto_continuation()` — CONTCAR->POSCAR + NSW scaling + resubmit
- [ ] Implement `AdaptiveHPCPoller` — exponential backoff, reconnection, 3-tier status fallback
- [ ] Implement parameter override hierarchy (step > cluster > global)
- [ ] Wire array job results back to individual child tasks in scanner
- [ ] Implement `retry_batch_failures()` — resubmit only failed array indices
- [ ] Test: map 10 structures -> single array job -> gather results
- [ ] Test: auto-continuation with NSW scaling on non-converged VASP
- [ ] Test: SSH disconnect recovery during polling

---

## What This Gives CatGo Over AiiDA-WorkGraph

| Capability | AiiDA-WorkGraph | CatGo (after P8) | CatGo Advantage |
|-----------|----------------|-------------------|-----------------|
| Map/fan-out | Clone-and-rewire via RabbitMQ | DB-native child tasks | Survives crashes, no message broker |
| Zones/groups | Zone Task subclass | Zone via parent_task_id | Simpler, SQLite-native |
| While/loops | plumpy state machine | Scanner-driven iteration | Stateless, crash-recoverable |
| Conditionals | If Zone | `run_if` parameter | Simpler API, per-task granularity |
| Provenance | Full ORM (PostgreSQL) | Lightweight hash-based (SQLite) | Zero deploy, fast queries |
| Error recovery | Error handlers with retry | 3-tier: Custodian + AI + User | AI-native, GUI-integrated |
| **Batch HPC submission** | Individual transport calls per job | SLURM array jobs, single sbatch | 1000 catalysts = 1 job, not 1000 |
| **Batch upload** | Per-task file staging via daemon | Single tar+sftp+untar transfer | Orders-of-magnitude fewer SSH calls |
| **Auto-continuation** | Not built-in (user must handle) | Auto CONTCAR->POSCAR + resubmit | Zero-touch non-convergence handling |
| **Adaptive polling** | Daemon-based, crashes lose state | Exponential backoff + 3-tier fallback | Survives SSH drops, 7-day jobs |
| **Param hierarchy** | Profile-based overrides | Step > Cluster > Global defaults | Same workflow, any cluster |
| GUI | Jupyter widget only | Full web/desktop GUI | Drag-and-drop, 3D viewer |
| AI integration | None | MCP + skills + CatBot | Build workflows by talking |
| Deploy | PostgreSQL + RabbitMQ + daemon | SQLite + single process | `pip install catgo` and go |
| Live modification | RabbitMQ RPC messages | REST API + WebSocket | No message broker needed |

---

## Key Design Decisions

1. **Scanner-native control flow.** AiiDA uses plumpy's Continue/Wait state machine with RabbitMQ. CatGo's scanner is stateless and reads everything from SQLite. Control-flow tasks (map, while, zone) are handled as special cases in the scan cycle, not as process-level primitives. This means control flow survives crashes without checkpointing.

2. **parent_task_id over separate children table.** Rather than maintaining a separate children relationship, we add `parent_task_id` to the tasks table. This keeps the schema simple and lets us query children with a single SQL WHERE clause.

3. **Feedback links for loops.** While loops need to feed outputs back as inputs. Instead of mutating task params (which breaks idempotency), we store feedback as a special link type and apply it in the scanner before each iteration.

4. **Hash-based provenance over ORM nodes.** AiiDA creates a full Data node for every intermediate value. CatGo hashes values and records lineage in a flat table. This trades queryability for simplicity — you can still trace "where did this come from" but cannot query "all structures with energy < -5.0" through the provenance layer. (The task_results table handles that.)

5. **AI error recovery as a first-class feature.** AiiDA has error handlers but they are purely programmatic. CatGo's AI agent can read error logs, understand the physics, and suggest fixes. This is a genuine capability moat that AiiDA's architecture cannot easily replicate.
```

---
# P2b: HPC Bridge — Connect State Machine to Real HPC Execution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bridge the new state machine engine to existing HPC execution code. After this, `engine.scan_cycle()` can submit VASP/CP2K/ORCA/MLP/LAMMPS jobs to real HPC clusters, poll their status, and collect results.

**Architecture:** Three new modules in `engine/`: submitter, poller, collector. Each wraps existing code (not duplicates it). The scanner delegates to them based on task state. All HPC-specific code stays in existing `workflow/engines/` — the bridge just calls it.

**Principle:** Each file <150 lines. No copy-paste from existing code — import and call.

**Depends on:** P1 (API), P2 (core engine) — both completed

---

## File Structure

| File | Lines (target) | Responsibility |
|------|---------------|---------------|
| `engine/submitter.py` | ~120 | READY → generate inputs → upload → submit → SUBMITTED |
| `engine/poller.py` | ~80 | SUBMITTED/QUEUED/RUNNING → check squeue/sacct → update state |
| `engine/collector.py` | ~80 | COMPLETED_REMOTE → read results via SSH → COMPLETED |
| `engine/hpc_utils.py` | ~50 | Shared: get HPC connection, resolve work_dir, map task_type to engine |
| `engine/scanner.py` | modify | Wire submitter/poller/collector into scan_cycle |

Existing code reused (NOT duplicated):
- `workflow/engines/vasp.py` → `generate_vasp_inputs()`
- `workflow/engines/cp2k.py` → `generate_cp2k_inputs()`
- `workflow/engines/orca.py` → `generate_orca_inputs()`
- `workflow/engines/mlp.py` → `generate_mlp_inputs()`
- `workflow/engines/lammps.py` → `generate_lammps_inputs()`
- `workflow/hpc_execute.py` → `collect_completed_results()`
- `workflow/node_sets.py` → `get_engine_for_node()`
- `utils/connection_pool.py` → `pool.get_connection()`

---

### Task 1: HPC Utilities + Engine Registry

Shared helpers + **pluggable engine registry**. New software = register one function, nothing else to change.

**Files:**
- Create: `server/catgo/workflow/engine/hpc_utils.py`
- Create: `server/catgo/workflow/engine/engine_registry.py`

- [ ] **Step 1: Implement engine registry (pluggable)**

```python
# server/catgo/workflow/engine/engine_registry.py
"""Pluggable engine registry — add new software without modifying submitter.

Usage:
    @register_engine("vasp")
    async def generate_vasp(hpc, work_dir, node_type, params, structure_str, config, task):
        from workflow.engines.vasp import generate_vasp_inputs
        await generate_vasp_inputs(hpc, work_dir, node_type, params, structure_str, config)

    # In submitter:
    generator = get_engine_generator("vasp")
    await generator(hpc, work_dir, ...)
"""

from __future__ import annotations
import logging
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)

# Type for engine generator functions
EngineGenerator = Callable[..., Awaitable[None]]

_ENGINE_REGISTRY: dict[str, EngineGenerator] = {}


def register_engine(engine_key: str):
    """Decorator to register an input generator for a software engine."""
    def decorator(func: EngineGenerator) -> EngineGenerator:
        _ENGINE_REGISTRY[engine_key] = func
        return func
    return decorator


def get_engine_generator(engine_key: str) -> EngineGenerator | None:
    """Look up the input generator for an engine. Returns None if not registered."""
    return _ENGINE_REGISTRY.get(engine_key)


def list_engines() -> list[str]:
    """List all registered engine keys."""
    return list(_ENGINE_REGISTRY.keys())


# ─── Register all built-in engines ───

@register_engine("vasp")
async def _gen_vasp(hpc, work_dir, node_type, params, structure_str, config, task):
    session_id = task.get("hpc_session_id", "")
    from workflow.engines.vasp import generate_vasp_inputs
    await generate_vasp_inputs(hpc, work_dir, node_type, params, structure_str, config, session_id)


@register_engine("cp2k")
async def _gen_cp2k(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.cp2k import generate_cp2k_inputs
    await generate_cp2k_inputs(hpc, work_dir, node_type, params, structure_str)


@register_engine("orca")
async def _gen_orca(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.orca import generate_orca_input_files
    files = generate_orca_input_files(node_type, params, structure_str)
    from utils.job_parser import write_remote_files
    await write_remote_files(hpc.conn, {f"{work_dir}/{k}": v for k, v in files.items()})


@register_engine("mlp")
async def _gen_mlp(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.mlp import generate_mlp_inputs
    await generate_mlp_inputs(hpc, work_dir, node_type, params, structure_str)


@register_engine("lammps")
async def _gen_lammps(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.lammps import generate_lammps_inputs
    await generate_lammps_inputs(hpc, work_dir, node_type, params, structure_str)
```

- [ ] **Step 2: Implement hpc_utils**

```python
# server/catgo/workflow/engine/hpc_utils.py
"""Shared HPC utilities for the state machine engine."""

from __future__ import annotations
import logging
from typing import Any

logger = logging.getLogger(__name__)


def get_hpc_connection(task: dict, config: dict) -> Any | None:
    """Get an HPC connection for a task. Returns None if unavailable.

    Tries: task's stored session → config default session → any available.
    """
    from utils.hpc_client import pool, LOCAL_SESSION_ID

    session_id = task.get("hpc_session_id")
    if not session_id:
        session_id = config.get("hpc", {}).get("default_session_id")

    if session_id and session_id != LOCAL_SESSION_ID:
        hpc = pool.get_connection(session_id)
        if hpc:
            return hpc

    # Fallback: any active remote session
    for sid, conn in list(pool.connections.items()):
        if sid != LOCAL_SESSION_ID and conn and conn.is_alive:
            return conn

    return None


def resolve_work_dir(task: dict, workflow_id: str, config: dict) -> str:
    """Build remote work directory path for a task."""
    if task.get("work_dir"):
        return task["work_dir"]

    template = config.get("paths", {}).get(
        "work_dir_template", "{base_dir}/{workflow_id}/{task_id}"
    )
    base_dir = config.get("paths", {}).get("base_dir", "")
    return template.format(base_dir=base_dir, workflow_id=workflow_id, task_id=task["id"])


def map_task_type_to_engine(task_type: str, params: dict) -> tuple[str, str]:
    """Map task_type + software to (resolved_node_type, engine_key).

    Example: ("geo_opt", {"software": "vasp"}) → ("vasp_relax", "vasp")
    """
    from workflow.node_sets import get_engine_for_node

    software = params.get("software", "vasp")
    UNIFIED_MAP = {
        ("geo_opt", "vasp"): "vasp_relax", ("geo_opt", "cp2k"): "cp2k_geopt",
        ("geo_opt", "orca"): "orca_opt", ("geo_opt", "mlp"): "mlp_relax",
        ("single_point", "vasp"): "vasp_static", ("single_point", "cp2k"): "cp2k_static",
        ("single_point", "orca"): "orca_sp",
        ("freq", "vasp"): "frequency", ("freq", "cp2k"): "cp2k_freq",
        ("freq", "orca"): "orca_freq",
        ("cell_opt", "vasp"): "vasp_relax", ("cell_opt", "cp2k"): "cp2k_cellopt",
        ("md", "vasp"): "vasp_md", ("md", "cp2k"): "cp2k_md",
        ("md", "lammps"): "lammps_md", ("md", "mlp"): "mlp_md",
        ("ts_search", "sella"): "sella_ts", ("ts_search", "orca"): "orca_neb_ts",
    }

    resolved = UNIFIED_MAP.get((task_type, software), task_type)
    engine_key = get_engine_for_node(resolved)
    return resolved, engine_key
```

- [ ] **Step 2: Commit**

```bash
git add server/catgo/workflow/engine/hpc_utils.py
git commit -m "feat(P2b): HPC utilities — connection, work_dir, type mapping"
```

---

### Task 2: Submitter (READY → SUBMITTED)

Takes READY HPC tasks, generates inputs, uploads, submits to scheduler.

**Files:**
- Create: `server/catgo/workflow/engine/submitter.py`

- [ ] **Step 1: Implement submitter**

```python
# server/catgo/workflow/engine/submitter.py
"""Submit READY HPC tasks: generate inputs → upload → sbatch."""

from __future__ import annotations
import json
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.hpc_utils import get_hpc_connection, resolve_work_dir, map_task_type_to_engine
from catgo.workflow.engine.resolver import resolve_task_inputs

logger = logging.getLogger(__name__)


async def submit_ready_tasks(
    db: WorkflowDB, workflow_id: str, config: dict[str, Any],
) -> list[str]:
    """Submit all READY HPC tasks for a workflow.

    Returns list of task IDs that were submitted.
    """
    ready = db.get_tasks_by_status(workflow_id, TaskState.READY.value)
    submitted = []
    batch_size = config.get("engine", {}).get("submit_batch_size", 5)

    for task in ready[:batch_size]:
        task_id = task["id"]
        task_type = task["task_type"]
        params = json.loads(task.get("params_json", "{}") or "{}")

        # Skip local tasks — handled by scanner directly
        from catgo.workflow.task_decorator import get_task_definition
        defn = get_task_definition(task_type)
        if defn and defn.local:
            continue

        try:
            await _submit_one(db, task, workflow_id, params, config)
            submitted.append(task_id)
        except Exception as e:
            logger.error("Task %s submit failed: %s", task_id, e, exc_info=True)
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message=f"Submit failed: {e}",
                error_type="transient",
            )

    return submitted


async def _submit_one(
    db: WorkflowDB, task: dict, workflow_id: str,
    params: dict, config: dict,
) -> None:
    """Submit a single task to HPC."""
    task_id = task["id"]
    task_type = task["task_type"]

    # 1. Get HPC connection
    hpc = get_hpc_connection(task, config)
    if not hpc:
        raise RuntimeError("No HPC connection available")

    # 2. Resolve node type and engine
    resolved_type, engine_key = map_task_type_to_engine(task_type, params)

    # 3. Resolve input structure from parent results
    inputs = resolve_task_inputs(db, task_id)
    structure_str = inputs.get("structure")

    # 4. Resolve work directory
    work_dir = resolve_work_dir(task, workflow_id, config)

    # 5. Create remote directory
    db.update_task(task_id, status=TaskState.GENERATING.value, work_dir=work_dir)
    await hpc.conn.run(f"mkdir -p {work_dir}", check=True)

    # 6. Generate and upload inputs via pluggable engine registry
    db.update_task(task_id, status=TaskState.UPLOADING.value)
    from catgo.workflow.engine.engine_registry import get_engine_generator
    generator = get_engine_generator(engine_key)
    if not generator:
        raise RuntimeError(f"No engine registered for '{engine_key}'. "
                          f"Register one with @register_engine('{engine_key}')")
    await generator(hpc, work_dir, resolved_type, params, structure_str, config, task)

    # 7. Submit job
    session_id = task.get("hpc_session_id") or ""
    job_script = params.get("job_script", "")
    success, message, job_id = await _submit_job(
        hpc, work_dir, resolved_type, job_script, params, config,
    )

    if not success:
        raise RuntimeError(f"Job submission failed: {message}")

    db.update_task(task_id,
        status=TaskState.SUBMITTED.value,
        hpc_job_id=job_id,
        hpc_session_id=session_id or getattr(hpc, 'session_id', ''),
    )
    logger.info("Task %s: READY → SUBMITTED (job %s)", task_id, job_id)


async def _submit_job(
    hpc, work_dir: str, node_type: str, job_script: str,
    params: dict, config: dict,
) -> tuple[bool, str, str]:
    """Submit job to HPC scheduler. Returns (success, message, job_id)."""
    import shlex

    if job_script and "#SBATCH" in job_script:
        # User-provided script
        script_path = f"{work_dir}/submit.sh"
        await hpc.conn.run(f"cat > {script_path} << 'CATGO_EOF'\n{job_script}\nCATGO_EOF", check=True)
        await hpc.conn.run(f"chmod +x {script_path}", check=True)
        return await hpc.scheduler.submit_job(hpc.conn, script_file=script_path, work_dir=work_dir)
    else:
        # Auto-generated submission
        partition = params.get("partition")
        nodes = params.get("nodes")
        ntasks = params.get("ntasks")
        cpus = params.get("cpus_per_task")
        walltime = params.get("walltime")
        memory = params.get("memory")

        return await hpc.scheduler.submit_job(
            hpc.conn,
            script_content=job_script or "",
            job_name=f"catgo-{node_type}",
            work_dir=work_dir,
            partition=partition,
            nodes=nodes,
            ntasks=ntasks,
            cpus_per_task=cpus,
            time_limit=walltime,
            memory=memory,
        )
```

- [ ] **Step 2: Commit**

```bash
git add server/catgo/workflow/engine/submitter.py
git commit -m "feat(P2b): submitter — READY → generate inputs → upload → SUBMITTED"
```

---

### Task 3: Poller (SUBMITTED/RUNNING → check HPC status)

**Files:**
- Create: `server/catgo/workflow/engine/poller.py`

- [ ] **Step 1: Implement poller**

```python
# server/catgo/workflow/engine/poller.py
"""Poll HPC job status for SUBMITTED/QUEUED/RUNNING tasks."""

from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.hpc_utils import get_hpc_connection

logger = logging.getLogger(__name__)

_COMPLETED_STATUSES = {"COMPLETED", "CD"}
_FAILED_STATUSES = {"FAILED", "F", "NODE_FAIL", "NF", "TIMEOUT", "TO",
                     "CANCELLED", "CA", "OOM", "OUT_OF_MEMORY"}
_PENDING_STATUSES = {"PENDING", "PD"}


async def poll_active_tasks(
    db: WorkflowDB, workflow_id: str, config: dict[str, Any],
) -> None:
    """Check HPC status for all submitted/queued/running tasks."""
    active_statuses = (
        TaskState.SUBMITTED.value,
        TaskState.QUEUED.value,
        TaskState.RUNNING.value,
    )
    tasks = db.get_all_tasks(workflow_id)
    active = [t for t in tasks if t["status"] in active_statuses and t.get("hpc_job_id")]

    for task in active:
        task_id = task["id"]
        job_id = task["hpc_job_id"]

        hpc = get_hpc_connection(task, config)
        if not hpc:
            logger.debug("Task %s: no HPC connection, skip polling", task_id)
            continue

        try:
            new_status = await _check_job(hpc, job_id)
            _apply_status(db, task, new_status)
        except Exception as e:
            logger.warning("Task %s: poll error: %s", task_id, e)
            # Don't fail the task on poll errors — retry next cycle


async def _check_job(hpc, job_id: str) -> str:
    """Query scheduler for actual job status. Returns state string."""
    # Try squeue (active jobs)
    try:
        info = await hpc.scheduler.get_job_status(hpc.conn, job_id)
        if info is not None:
            s = (info.status or "").upper()
            if s in _COMPLETED_STATUSES:
                return "COMPLETED_REMOTE"
            if s in _FAILED_STATUSES:
                return "FAILED"
            if s in _PENDING_STATUSES:
                return "QUEUED"
            return "RUNNING"
    except Exception:
        pass

    # Fallback: sacct (finished jobs)
    if hasattr(hpc.scheduler, "get_job_status_sacct"):
        try:
            info = await hpc.scheduler.get_job_status_sacct(hpc.conn, job_id)
            if info and info.status:
                s = info.status.upper()
                if s in _COMPLETED_STATUSES:
                    return "COMPLETED_REMOTE"
                if s in _FAILED_STATUSES:
                    return "FAILED"
        except Exception:
            pass

    return "UNKNOWN"


def _apply_status(db: WorkflowDB, task: dict, new_status: str) -> None:
    """Update task status based on poll result."""
    task_id = task["id"]
    old_status = task["status"]
    now = datetime.now(timezone.utc).isoformat()

    if new_status == "UNKNOWN":
        db.update_task(task_id, last_polled_at=now)
        return

    if new_status == old_status:
        db.update_task(task_id, last_polled_at=now)
        return

    if new_status == "COMPLETED_REMOTE":
        db.update_task(task_id, status=TaskState.COMPLETED_REMOTE.value, last_polled_at=now)
        logger.info("Task %s: %s → COMPLETED_REMOTE (job done on HPC)", task_id, old_status)
    elif new_status == "FAILED":
        db.update_task(task_id,
            status=TaskState.REMOTE_ERROR.value,
            error_message=f"HPC job failed",
            error_type="transient",
            last_polled_at=now,
        )
        logger.warning("Task %s: %s → REMOTE_ERROR (HPC job failed)", task_id, old_status)
    elif new_status == "QUEUED":
        db.update_task(task_id, status=TaskState.QUEUED.value, last_polled_at=now)
    elif new_status == "RUNNING":
        db.update_task(task_id, status=TaskState.RUNNING.value, last_polled_at=now)
```

- [ ] **Step 2: Commit**

```bash
git add server/catgo/workflow/engine/poller.py
git commit -m "feat(P2b): poller — check squeue/sacct for active tasks"
```

---

### Task 4: Collector (COMPLETED_REMOTE → read results → COMPLETED)

**Files:**
- Create: `server/catgo/workflow/engine/collector.py`

- [ ] **Step 1: Implement collector**

```python
# server/catgo/workflow/engine/collector.py
"""Collect results from HPC for COMPLETED_REMOTE tasks."""

from __future__ import annotations
import json
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.hpc_utils import get_hpc_connection, map_task_type_to_engine

logger = logging.getLogger(__name__)


async def collect_completed_tasks(
    db: WorkflowDB, workflow_id: str, config: dict[str, Any],
) -> list[str]:
    """Read results from HPC for all COMPLETED_REMOTE tasks.

    Returns list of task IDs that were successfully collected.
    """
    tasks = db.get_tasks_by_status(workflow_id, TaskState.COMPLETED_REMOTE.value)
    collected = []

    for task in tasks:
        task_id = task["id"]
        db.update_task(task_id, status=TaskState.COLLECTING.value)

        try:
            await _collect_one(db, task, workflow_id, config)
            collected.append(task_id)
        except Exception as e:
            logger.error("Task %s: result collection failed: %s", task_id, e, exc_info=True)
            db.update_task(task_id,
                status=TaskState.REMOTE_ERROR.value,
                error_message=f"Result collection failed: {e}",
                error_type="transient",
            )

    return collected


async def _collect_one(
    db: WorkflowDB, task: dict, workflow_id: str, config: dict,
) -> None:
    """Collect results for a single task."""
    task_id = task["id"]
    task_type = task["task_type"]
    work_dir = task.get("work_dir", "")
    job_id = task.get("hpc_job_id", "")
    session_id = task.get("hpc_session_id", "")
    params = json.loads(task.get("params_json", "{}") or "{}")

    hpc = get_hpc_connection(task, config)
    if not hpc:
        raise RuntimeError("No HPC connection for result collection")

    # Resolve the actual node type for the collector
    resolved_type, engine_key = map_task_type_to_engine(task_type, params)

    # Use the existing collect_completed_results() — don't duplicate logic
    from workflow.hpc_execute import collect_completed_results
    result = await collect_completed_results(
        hpc, work_dir, task_id, resolved_type, params, session_id, job_id,
    )

    # Store results in the new DB schema
    _store_result(db, task_id, workflow_id, result)

    db.update_task(task_id, status=TaskState.COMPLETED.value)
    logger.info("Task %s (%s): COMPLETED_REMOTE → COMPLETED", task_id, task_type)


def _store_result(db: WorkflowDB, task_id: str, workflow_id: str, result: dict) -> None:
    """Map the result dict to task_results columns."""
    fields = {}

    if "energy" in result:
        fields["energy"] = result["energy"]
    if "structure" in result:
        s = result["structure"]
        fields["structure_json"] = s if isinstance(s, str) else json.dumps(s)
    if "real_freqs" in result:
        fields["real_freqs_json"] = json.dumps(result["real_freqs"])
    if "imag_freqs" in result:
        fields["imag_freqs_json"] = json.dumps(result["imag_freqs"])
    if "positions" in result:
        fields["positions_json"] = json.dumps(result["positions"])
    if "masses" in result:
        fields["masses_json"] = json.dumps(result["masses"])
    if "gibbs" in result:
        fields["gibbs"] = result["gibbs"]
    if "zpe" in result or "zpe_ev" in result:
        fields["zpe"] = result.get("zpe") or result.get("zpe_ev")

    # Store full result as generic outputs for anything not mapped
    fields["outputs_json"] = json.dumps(result, default=str)

    if fields:
        db.store_result(task_id, workflow_id, **fields)
```

- [ ] **Step 2: Commit**

```bash
git add server/catgo/workflow/engine/collector.py
git commit -m "feat(P2b): collector — read HPC results → COMPLETED"
```

---

### Task 5: Wire into Scanner

Update `scanner.py` to call submitter, poller, collector in each scan cycle.

**Files:**
- Modify: `server/catgo/workflow/engine/scanner.py`

- [ ] **Step 1: Update scanner to call bridge modules**

In `scanner.py`, update `_process_workflow()` to replace the TODO markers:

```python
    async def _process_workflow(self, workflow_id: str) -> None:
        """Process one workflow: advance states, submit, poll, collect, handle errors."""

        # 1. WAITING → READY
        advance_waiting_tasks(self.db, workflow_id)

        # 2. Execute READY local tasks immediately
        self._execute_ready_local_tasks(workflow_id)

        # 3. Submit READY HPC tasks
        from catgo.workflow.engine.submitter import submit_ready_tasks
        await submit_ready_tasks(self.db, workflow_id, self.config)

        # 4. Poll SUBMITTED/QUEUED/RUNNING tasks
        from catgo.workflow.engine.poller import poll_active_tasks
        await poll_active_tasks(self.db, workflow_id, self.config)

        # 5. Collect results from COMPLETED_REMOTE tasks
        from catgo.workflow.engine.collector import collect_completed_tasks
        await collect_completed_tasks(self.db, workflow_id, self.config)

        # 6. Handle REMOTE_ERROR → retry or FAILED
        handle_errors(self.db, workflow_id, self.config)

        # 7. Update workflow-level status
        self._update_workflow_status(workflow_id)
```

Also change `scan_cycle` and `_process_workflow` to be `async`:

```python
    async def scan_cycle(self) -> None:
        """One pass of the state machine."""
        workflows = self.db.list_workflows()
        active = [w for w in workflows if w["status"] == "running"]

        for wf in active:
            try:
                await self._process_workflow(wf["id"])
            except Exception as e:
                logger.error("Error processing workflow %s: %s", wf["id"], e, exc_info=True)
```

- [ ] **Step 2: Run all tests**

```bash
cd server && PYTHONPATH=. python -m pytest tests/ -v
```

- [ ] **Step 3: Commit**

```bash
git add server/catgo/workflow/engine/scanner.py
git commit -m "feat(P2b): wire submitter/poller/collector into scanner"
```

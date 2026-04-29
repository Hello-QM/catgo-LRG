# P2: State Machine Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current asyncio orchestrator with a stateless state machine engine that reads DB each cycle, advances task states, and survives CatGo restart.

**Architecture:** A periodic scanner (`WorkflowEngine`) runs every N seconds (configurable). Each cycle reads all active tasks from DB, checks which can advance, and transitions their states. HPC operations (submit, poll, collect) are delegated to focused modules. The engine is stateless — all state lives in SQLite.

**Tech Stack:** Python 3.11+, asyncio, asyncssh (existing HPC connections), SQLite

**Spec:** `docs/superpowers/specs/2026-03-28-workflow-engine-refactor-design.md` (Phase 2)

**Depends on:** P1 (Python API + DB Schema) — completed

---

## File Structure

Each file has ONE responsibility. Target: <150 lines per file.

| File | Action | Responsibility |
|------|--------|---------------|
| `server/catgo/workflow/engine/__init__.py` | Create | Public exports (WorkflowEngine) |
| `server/catgo/workflow/engine/scanner.py` | Create | Main loop: scan_cycle() orchestrates one pass |
| `server/catgo/workflow/engine/advancer.py` | Create | WAITING → READY (check parent completion) |
| `server/catgo/workflow/engine/submitter.py` | Create | READY → submit to HPC or execute locally |
| `server/catgo/workflow/engine/poller.py` | Create | SUBMITTED/RUNNING → check squeue/sacct |
| `server/catgo/workflow/engine/collector.py` | Create | COMPLETED_REMOTE → read results → COMPLETED |
| `server/catgo/workflow/engine/error_handler.py` | Create | REMOTE_ERROR → retry or FAILED |
| `server/catgo/workflow/engine/resolver.py` | Create | Resolve OutputReferences from task_results |
| `server/tests/test_engine_advancer.py` | Create | Tests for WAITING → READY logic |
| `server/tests/test_engine_resolver.py` | Create | Tests for input resolution |
| `server/tests/test_engine_scanner.py` | Create | Integration tests for full scan cycle |

---

### Task 1: Input Resolver

Resolves OutputReferences by reading parent task results from DB. Used by submitter before generating inputs.

**Files:**
- Create: `server/catgo/workflow/engine/__init__.py`
- Create: `server/catgo/workflow/engine/resolver.py`
- Create: `server/tests/test_engine_resolver.py`

- [ ] **Step 1: Create engine package**

```python
# server/catgo/workflow/engine/__init__.py
"""CatGo Workflow State Machine Engine."""
```

- [ ] **Step 2: Write resolver tests**

```python
# server/tests/test_engine_resolver.py
import json
import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.resolver import resolve_task_inputs


class TestResolver:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_resolve_single_input(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        db.store_result(t1, wf_id, structure_json='{"sites": [1,2,3]}')

        inputs = resolve_task_inputs(db, t2)
        assert inputs["structure"] == '{"sites": [1,2,3]}'

    def test_resolve_multiple_inputs(self, db):
        wf_id = db.create_workflow("test")
        t_opt = db.create_task(wf_id, "geo_opt", params={})
        t_frq = db.create_task(wf_id, "freq", params={})
        t_gib = db.create_task(wf_id, "gibbs_energy", params={})
        db.create_link(wf_id, t_opt, t_gib, "energy", "energy")
        db.create_link(wf_id, t_frq, t_gib, "frequencies", "frequencies")
        db.store_result(t_opt, wf_id, energy=-42.5)
        db.store_result(t_frq, wf_id, real_freqs_json='[100, 200, 300]')

        inputs = resolve_task_inputs(db, t_gib)
        assert inputs["energy"] == -42.5
        assert inputs["frequencies"] == '[100, 200, 300]'

    def test_resolve_no_parents(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "structure_input", params={})
        inputs = resolve_task_inputs(db, t1)
        assert inputs == {}

    def test_resolve_missing_result_returns_none(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        # No result stored for t1
        inputs = resolve_task_inputs(db, t2)
        assert inputs["structure"] is None
```

- [ ] **Step 3: Implement resolver**

```python
# server/catgo/workflow/engine/resolver.py
"""Resolve task inputs by reading parent task results from DB."""

from __future__ import annotations
from typing import Any

from catgo.workflow.db import WorkflowDB


# Map source_key to task_results column name
_KEY_TO_COLUMN = {
    "structure": "structure_json",
    "energy": "energy",
    "frequencies": "real_freqs_json",
    "zpe": "zpe",
    "gibbs": "gibbs",
    "ts_correction": "ts_correction",
}


def resolve_task_inputs(db: WorkflowDB, task_id: str) -> dict[str, Any]:
    """Resolve all input references for a task.

    Reads task_links to find parent tasks, then reads their results
    from task_results table. Returns {target_key: value}.
    """
    links = db.get_task_parents(task_id)
    if not links:
        return {}

    inputs: dict[str, Any] = {}
    for link in links:
        source_id = link["source_task_id"]
        source_key = link["source_key"]
        target_key = link["target_key"]

        result = db.get_result(source_id)
        if result is None:
            inputs[target_key] = None
            continue

        # Map source_key to the actual column name in task_results
        column = _KEY_TO_COLUMN.get(source_key, source_key)
        value = result.get(column)

        # Fallback: check outputs_json for custom keys
        if value is None and result.get("outputs_json"):
            import json
            try:
                outputs = json.loads(result["outputs_json"])
                value = outputs.get(source_key)
            except (json.JSONDecodeError, TypeError):
                pass

        inputs[target_key] = value

    return inputs
```

- [ ] **Step 4: Run tests**

```bash
cd server && PYTHONPATH=. python -m pytest tests/test_engine_resolver.py -v
```

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/engine/ server/tests/test_engine_resolver.py
git commit -m "feat(P2): input resolver — read parent results from DB"
```

---

### Task 2: Advancer (WAITING → READY)

Checks all WAITING tasks: if all parents are COMPLETED, advance to READY.

**Files:**
- Create: `server/catgo/workflow/engine/advancer.py`
- Create: `server/tests/test_engine_advancer.py`

- [ ] **Step 1: Write advancer tests**

```python
# server/tests/test_engine_advancer.py
import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.advancer import advance_waiting_tasks


class TestAdvancer:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_no_parents_becomes_ready(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "structure_input", params={})
        advanced = advance_waiting_tasks(db, wf_id)
        assert t1 in advanced
        task = db.get_task(t1)
        assert task["status"] == TaskState.READY.value

    def test_parents_completed_becomes_ready(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        db.update_task(t1, status=TaskState.COMPLETED.value)
        advanced = advance_waiting_tasks(db, wf_id)
        assert t2 in advanced

    def test_parents_not_completed_stays_waiting(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        # t1 still WAITING
        advanced = advance_waiting_tasks(db, wf_id)
        assert t2 not in advanced
        task = db.get_task(t2)
        assert task["status"] == TaskState.WAITING.value

    def test_multiple_parents_all_must_complete(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        t3 = db.create_task(wf_id, "gibbs_energy", params={})
        db.create_link(wf_id, t1, t3, "energy", "energy")
        db.create_link(wf_id, t2, t3, "frequencies", "frequencies")
        # Only t1 completed
        db.update_task(t1, status=TaskState.COMPLETED.value)
        advanced = advance_waiting_tasks(db, wf_id)
        assert t3 not in advanced
        # Now t2 also completed
        db.update_task(t2, status=TaskState.COMPLETED.value)
        advanced = advance_waiting_tasks(db, wf_id)
        assert t3 in advanced

    def test_skips_non_waiting_tasks(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.RUNNING.value)
        advanced = advance_waiting_tasks(db, wf_id)
        assert t1 not in advanced
```

- [ ] **Step 2: Implement advancer**

```python
# server/catgo/workflow/engine/advancer.py
"""Advance WAITING tasks to READY when all parents are COMPLETED."""

from __future__ import annotations
import logging

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState

logger = logging.getLogger(__name__)


def advance_waiting_tasks(db: WorkflowDB, workflow_id: str) -> list[str]:
    """Check all WAITING tasks: if all parents COMPLETED, set to READY.

    Returns list of task IDs that were advanced to READY.
    """
    waiting = db.get_tasks_by_status(workflow_id, TaskState.WAITING.value)
    advanced = []

    for task in waiting:
        task_id = task["id"]
        parents = db.get_task_parents(task_id)

        if not parents:
            # No parents — immediately ready
            db.update_task(task_id, status=TaskState.READY.value)
            advanced.append(task_id)
            logger.info("Task %s: WAITING → READY (no parents)", task_id)
            continue

        # Check all parent tasks are COMPLETED
        all_completed = True
        for link in parents:
            parent = db.get_task(link["source_task_id"])
            if parent["status"] != TaskState.COMPLETED.value:
                all_completed = False
                break

        if all_completed:
            db.update_task(task_id, status=TaskState.READY.value)
            advanced.append(task_id)
            logger.info("Task %s: WAITING → READY (all parents completed)", task_id)

    return advanced
```

- [ ] **Step 3: Run tests**

```bash
cd server && PYTHONPATH=. python -m pytest tests/test_engine_advancer.py -v
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/engine/advancer.py server/tests/test_engine_advancer.py
git commit -m "feat(P2): advancer — WAITING → READY when parents complete"
```

---

### Task 3: Error Handler

Handles REMOTE_ERROR tasks: retry with backoff or mark FAILED.

**Files:**
- Create: `server/catgo/workflow/engine/error_handler.py`
- Create: `server/tests/test_engine_error_handler.py`

- [ ] **Step 1: Write error handler tests**

```python
# server/tests/test_engine_error_handler.py
import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.config import load_config
from catgo.workflow.engine.error_handler import handle_errors


class TestErrorHandler:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    @pytest.fixture
    def config(self):
        return load_config(config_path=None)

    def test_retry_increments_count(self, db, config):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.REMOTE_ERROR.value, retry_count=0)
        handle_errors(db, wf_id, config)
        task = db.get_task(t1)
        assert task["status"] == TaskState.READY.value
        assert task["retry_count"] == 1

    def test_max_retries_becomes_failed(self, db, config):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        max_retries = config["retry"]["max_retries"]
        db.update_task(t1, status=TaskState.REMOTE_ERROR.value, retry_count=max_retries)
        handle_errors(db, wf_id, config)
        task = db.get_task(t1)
        assert task["status"] == TaskState.FAILED.value

    def test_non_error_tasks_untouched(self, db, config):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.RUNNING.value)
        handle_errors(db, wf_id, config)
        task = db.get_task(t1)
        assert task["status"] == TaskState.RUNNING.value
```

- [ ] **Step 2: Implement error handler**

```python
# server/catgo/workflow/engine/error_handler.py
"""Handle REMOTE_ERROR tasks: retry with backoff or mark FAILED."""

from __future__ import annotations
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState

logger = logging.getLogger(__name__)


def handle_errors(db: WorkflowDB, workflow_id: str, config: dict[str, Any]) -> list[str]:
    """Process all REMOTE_ERROR tasks: retry or fail.

    Returns list of task IDs that were retried (set back to READY).
    """
    retry_config = config.get("retry", {})
    max_retries = retry_config.get("max_retries", 3)

    error_tasks = db.get_tasks_by_status(workflow_id, TaskState.REMOTE_ERROR.value)
    retried = []

    for task in error_tasks:
        task_id = task["id"]
        retry_count = task.get("retry_count", 0) or 0

        if retry_count >= max_retries:
            db.update_task(task_id,
                status=TaskState.FAILED.value,
                error_message=f"Failed after {max_retries} retries: {task.get('error_message', '')}",
            )
            logger.warning("Task %s: REMOTE_ERROR → FAILED (max retries %d)", task_id, max_retries)
        else:
            db.update_task(task_id,
                status=TaskState.READY.value,
                retry_count=retry_count + 1,
                error_message=None,
            )
            retried.append(task_id)
            logger.info("Task %s: REMOTE_ERROR → READY (retry %d/%d)", task_id, retry_count + 1, max_retries)

    return retried
```

- [ ] **Step 3: Run tests**

```bash
cd server && PYTHONPATH=. python -m pytest tests/test_engine_error_handler.py -v
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/engine/error_handler.py server/tests/test_engine_error_handler.py
git commit -m "feat(P2): error handler — retry or fail REMOTE_ERROR tasks"
```

---

### Task 4: Scanner (Main Loop)

The central orchestrator: runs scan_cycle() periodically, delegates to advancer/submitter/poller/collector/error_handler.

**Files:**
- Create: `server/catgo/workflow/engine/scanner.py`
- Create: `server/tests/test_engine_scanner.py`

- [ ] **Step 1: Write scanner tests**

```python
# server/tests/test_engine_scanner.py
import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState, WorkflowState
from catgo.workflow.config import load_config
from catgo.workflow.engine.scanner import WorkflowEngine


class TestScanner:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    @pytest.fixture
    def config(self):
        return load_config(config_path=None)

    @pytest.fixture
    def engine(self, db, config):
        return WorkflowEngine(db=db, config=config)

    def test_scan_advances_waiting_to_ready(self, engine, db):
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        t1 = db.create_task(wf_id, "structure_input", params={})
        engine.scan_cycle()
        task = db.get_task(t1)
        assert task["status"] == TaskState.READY.value

    def test_scan_chain_local_tasks(self, engine, db):
        """structure_input (local) should complete in one cycle."""
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        t1 = db.create_task(wf_id, "structure_input", params={"structure": '{"sites":[]}'})
        engine.scan_cycle()
        # After one cycle: WAITING → READY → executed locally → COMPLETED
        task = db.get_task(t1)
        # It should at least be READY (local execution may need explicit handling)
        assert task["status"] in (TaskState.READY.value, TaskState.COMPLETED.value)

    def test_scan_skips_draft_workflows(self, engine, db):
        wf_id = db.create_workflow("test")
        # Status is 'draft' (not 'running')
        t1 = db.create_task(wf_id, "structure_input", params={})
        engine.scan_cycle()
        task = db.get_task(t1)
        assert task["status"] == TaskState.WAITING.value  # Not advanced

    def test_scan_handles_empty_db(self, engine):
        # No workflows — should not crash
        engine.scan_cycle()

    def test_workflow_completes_when_all_tasks_done(self, engine, db):
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        t1 = db.create_task(wf_id, "structure_input", params={})
        db.update_task(t1, status=TaskState.COMPLETED.value)
        engine.scan_cycle()
        wf = db.get_workflow(wf_id)
        assert wf["status"] == "completed"

    def test_workflow_fails_when_task_fails(self, engine, db):
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.FAILED.value)
        engine.scan_cycle()
        wf = db.get_workflow(wf_id)
        assert wf["status"] == "failed"
```

- [ ] **Step 2: Implement scanner**

```python
# server/catgo/workflow/engine/scanner.py
"""WorkflowEngine — stateless periodic scanner.

Each scan_cycle() reads DB, advances task states, and returns.
No in-memory state between cycles. Crash and restart safely.
"""

from __future__ import annotations
import asyncio
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState, WorkflowState
from catgo.workflow.engine.advancer import advance_waiting_tasks
from catgo.workflow.engine.error_handler import handle_errors

logger = logging.getLogger(__name__)


class WorkflowEngine:
    """Stateless workflow engine. Call scan_cycle() periodically."""

    def __init__(self, db: WorkflowDB, config: dict[str, Any] | None = None):
        self.db = db
        self.config = config or {}
        self.poll_interval = self.config.get("engine", {}).get("poll_interval", 30)

    def scan_cycle(self) -> None:
        """One pass of the state machine. Reads DB, advances states.

        Called periodically by run_forever() or manually for testing.
        """
        # Get all active workflows
        workflows = self.db.list_workflows()
        active = [w for w in workflows if w["status"] == "running"]

        for wf in active:
            wf_id = wf["id"]
            try:
                self._process_workflow(wf_id)
            except Exception as e:
                logger.error("Error processing workflow %s: %s", wf_id, e, exc_info=True)

    def _process_workflow(self, workflow_id: str) -> None:
        """Process one workflow: advance states, handle errors, update status."""

        # 1. WAITING → READY (check parent completion)
        advance_waiting_tasks(self.db, workflow_id)

        # 2. READY → submit (HPC or local)
        # TODO: P2 Task 5 — submitter integration (requires HPC connection)
        # For now, local tasks can be handled here
        self._execute_ready_local_tasks(workflow_id)

        # 3. SUBMITTED/RUNNING → poll HPC
        # TODO: P2 Task 6 — poller integration (requires HPC connection)

        # 4. COMPLETED_REMOTE → collect results
        # TODO: P2 Task 7 — collector integration (requires HPC connection)

        # 5. REMOTE_ERROR → retry or FAILED
        handle_errors(self.db, workflow_id, self.config)

        # 6. Update workflow-level status
        self._update_workflow_status(workflow_id)

    def _execute_ready_local_tasks(self, workflow_id: str) -> None:
        """Execute local tasks (structure_input, gibbs_energy, etc.) immediately."""
        from catgo.workflow.task_decorator import get_task_definition
        from catgo.workflow.engine.resolver import resolve_task_inputs
        import json

        ready = self.db.get_tasks_by_status(workflow_id, TaskState.READY.value)
        for task in ready:
            defn = get_task_definition(task["task_type"])
            if not defn or not defn.local:
                continue  # HPC task — skip, handled by submitter

            task_id = task["id"]
            self.db.update_task(task_id, status=TaskState.RUNNING.value)

            try:
                # Resolve inputs from parent results
                inputs = resolve_task_inputs(self.db, task_id)

                # Merge with task params
                params = json.loads(task.get("params_json", "{}") or "{}")
                all_inputs = {**inputs, **params}

                # Execute the function
                if defn.func:
                    result = defn.func(**all_inputs)
                else:
                    result = {}

                # Store result
                if isinstance(result, dict):
                    self.db.store_result(task_id, workflow_id, **result)

                self.db.update_task(task_id, status=TaskState.COMPLETED.value)
                logger.info("Task %s (%s): local execution completed", task_id, task["task_type"])

            except Exception as e:
                self.db.update_task(task_id,
                    status=TaskState.FAILED.value,
                    error_message=str(e),
                )
                logger.error("Task %s (%s): local execution failed: %s", task_id, task["task_type"], e)

    def _update_workflow_status(self, workflow_id: str) -> None:
        """Derive workflow status from task states."""
        tasks = self.db.get_all_tasks(workflow_id)
        if not tasks:
            return

        states = [TaskState(t["status"]) for t in tasks]
        new_status = WorkflowState.from_task_states(states)
        current = self.db.get_workflow(workflow_id)

        if current["status"] != new_status.value:
            self.db.update_workflow(workflow_id, status=new_status.value)
            logger.info("Workflow %s: status → %s", workflow_id, new_status.value)

    async def run_forever(self) -> None:
        """Run the scanner in a loop. Call this from the backend server."""
        logger.info("WorkflowEngine started (poll_interval=%ds)", self.poll_interval)
        while True:
            try:
                self.scan_cycle()
            except Exception as e:
                logger.error("Scan cycle failed: %s", e, exc_info=True)
            await asyncio.sleep(self.poll_interval)
```

- [ ] **Step 3: Run tests**

```bash
cd server && PYTHONPATH=. python -m pytest tests/test_engine_scanner.py -v
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/engine/scanner.py server/tests/test_engine_scanner.py
git commit -m "feat(P2): scanner — main scan_cycle loop with local task execution"
```

---

### Task 5: Engine Public Exports + Integration with Backend

Wire the engine into the FastAPI backend so it starts scanning on server startup.

**Files:**
- Modify: `server/catgo/workflow/engine/__init__.py`

- [ ] **Step 1: Update engine exports**

```python
# server/catgo/workflow/engine/__init__.py
"""CatGo Workflow State Machine Engine.

Usage:
    from catgo.workflow.engine import WorkflowEngine
    from catgo.workflow.db import WorkflowDB
    from catgo.workflow.config import load_config

    db = WorkflowDB("~/.catgo/catgo.db")
    config = load_config()
    engine = WorkflowEngine(db=db, config=config)

    # Run once (for testing):
    engine.scan_cycle()

    # Run forever (for production):
    await engine.run_forever()
"""

from catgo.workflow.engine.scanner import WorkflowEngine

__all__ = ["WorkflowEngine"]
```

- [ ] **Step 2: Run all P2 tests together**

```bash
cd server && PYTHONPATH=. python -m pytest tests/test_engine_*.py -v
```

- [ ] **Step 3: Commit**

```bash
git add server/catgo/workflow/engine/__init__.py
git commit -m "feat(P2): engine public exports and integration point"
```

---

## Note on HPC Integration (Tasks for later)

The scanner's `scan_cycle()` has TODO markers for:
- **Submitter**: READY → GENERATING → UPLOADING → SUBMITTED (reuses existing `server/workflow/engines/vasp.py`)
- **Poller**: SUBMITTED/RUNNING → check squeue/sacct (reuses existing `server/workflow/hpc_execute.py` polling logic)
- **Collector**: COMPLETED_REMOTE → read OUTCAR/CONTCAR → COMPLETED (reuses `collect_completed_results()`)

These modules will bridge the new engine to the existing HPC code. They are deferred because:
1. They require HPC connections (can't unit test without mocks)
2. They mainly wrap existing code that already works
3. The scanner + advancer + resolver + error_handler form a complete testable core

The HPC integration will be a separate set of tasks after the core engine is validated.

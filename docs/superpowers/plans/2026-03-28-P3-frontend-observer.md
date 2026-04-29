# P3: Frontend Observer — REST API for New Workflow Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose the new state machine engine (P1+P2) via REST API endpoints so the frontend can observe workflow status, view DAGs, edit task params, and monitor execution — without changing the frontend yet.

**Architecture:** New FastAPI router `server/routers/workflow_v2.py` exposes the new `tasks`/`task_links`/`task_results` tables. The existing `workflow.py` router stays untouched (backward compatible). Frontend can switch to v2 endpoints when ready.

**Principle:** Backend-only changes. No frontend code in this phase. Each file <150 lines.

**Depends on:** P1, P2, P2b — all completed

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/routers/workflow_v2.py` | Create | REST API for new engine (list/get/submit/pause/status/dag) |
| `server/routers/workflow_v2_tasks.py` | Create | Task-level CRUD (get/update params/retry/cancel) |
| `server/catgo/workflow/engine/lifecycle.py` | Create | Start/stop/pause engine scanning for a workflow |
| `server/tests/test_api_v2.py` | Create | API endpoint tests |

---

### Task 1: Engine Lifecycle Manager

Controls starting/stopping the engine scanner for specific workflows.

**Files:**
- Create: `server/catgo/workflow/engine/lifecycle.py`
- Create: `server/tests/test_engine_lifecycle.py`

- [ ] **Step 1: Implement lifecycle**

```python
# server/catgo/workflow/engine/lifecycle.py
"""Workflow engine lifecycle — start, pause, resume, reset."""

from __future__ import annotations
import asyncio
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.scanner import WorkflowEngine

logger = logging.getLogger(__name__)

# Global engine instance (started once, scans all workflows)
_engine: WorkflowEngine | None = None
_engine_task: asyncio.Task | None = None


def get_engine() -> WorkflowEngine | None:
    """Get the global engine instance."""
    return _engine


async def start_engine(db: WorkflowDB, config: dict[str, Any]) -> WorkflowEngine:
    """Start the global workflow engine scanner."""
    global _engine, _engine_task

    if _engine is not None:
        return _engine

    _engine = WorkflowEngine(db=db, config=config)
    _engine_task = asyncio.create_task(_engine.run_forever())
    logger.info("Workflow engine started")
    return _engine


async def stop_engine() -> None:
    """Stop the global engine scanner."""
    global _engine, _engine_task

    if _engine_task and not _engine_task.done():
        _engine_task.cancel()
        try:
            await _engine_task
        except asyncio.CancelledError:
            pass

    _engine = None
    _engine_task = None
    logger.info("Workflow engine stopped")


def submit_workflow(db: WorkflowDB, workflow_id: str) -> None:
    """Mark a workflow as running so the engine picks it up."""
    db.update_workflow(workflow_id, status="running")
    logger.info("Workflow %s submitted for execution", workflow_id)


def pause_workflow(db: WorkflowDB, workflow_id: str) -> None:
    """Pause a workflow — engine will skip it on next cycle."""
    db.update_workflow(workflow_id, status="paused")
    # Mark active tasks as paused
    for status in (TaskState.READY, TaskState.WAITING):
        tasks = db.get_tasks_by_status(workflow_id, status.value)
        for t in tasks:
            db.update_task(t["id"], status=TaskState.PAUSED.value)
    logger.info("Workflow %s paused", workflow_id)


def resume_workflow(db: WorkflowDB, workflow_id: str) -> None:
    """Resume a paused workflow."""
    # Unpause paused tasks back to WAITING
    tasks = db.get_tasks_by_status(workflow_id, TaskState.PAUSED.value)
    for t in tasks:
        db.update_task(t["id"], status=TaskState.WAITING.value)
    db.update_workflow(workflow_id, status="running")
    logger.info("Workflow %s resumed", workflow_id)


def reset_workflow(db: WorkflowDB, workflow_id: str) -> None:
    """Reset all tasks to WAITING. Does NOT clear work_dir/hpc_job_id."""
    tasks = db.get_all_tasks(workflow_id)
    for t in tasks:
        db.update_task(t["id"],
            status=TaskState.WAITING.value,
            error_message=None,
            error_type=None,
            retry_count=0,
        )
    db.update_workflow(workflow_id, status="draft")
    logger.info("Workflow %s reset (%d tasks)", workflow_id, len(tasks))
```

- [ ] **Step 2: Write tests**

```python
# server/tests/test_engine_lifecycle.py
import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.lifecycle import (
    submit_workflow, pause_workflow, resume_workflow, reset_workflow,
)


class TestLifecycle:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_submit(self, db):
        wf_id = db.create_workflow("test")
        submit_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "running"

    def test_pause(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.READY.value)
        submit_workflow(db, wf_id)
        pause_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "paused"
        assert db.get_task(t1)["status"] == TaskState.PAUSED.value

    def test_resume(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.PAUSED.value)
        resume_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "running"
        assert db.get_task(t1)["status"] == TaskState.WAITING.value

    def test_reset(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.COMPLETED.value)
        reset_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "draft"
        assert db.get_task(t1)["status"] == TaskState.WAITING.value
```

- [ ] **Step 3: Run tests**

```bash
cd server && PYTHONPATH=. python -m pytest tests/test_engine_lifecycle.py -v
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/engine/lifecycle.py server/tests/test_engine_lifecycle.py
git commit -m "feat(P3): engine lifecycle — submit/pause/resume/reset"
```

---

### Task 2: Workflow V2 REST API

**Files:**
- Create: `server/routers/workflow_v2.py`

- [ ] **Step 1: Implement workflow-level endpoints**

```python
# server/routers/workflow_v2.py
"""REST API for the new state machine workflow engine (v2).

Endpoints:
  GET  /api/v2/workflows              — list all workflows
  GET  /api/v2/workflows/{id}         — get workflow + summary
  GET  /api/v2/workflows/{id}/dag     — get DAG (tasks + links)
  POST /api/v2/workflows/{id}/submit  — start execution
  POST /api/v2/workflows/{id}/pause   — pause workflow
  POST /api/v2/workflows/{id}/resume  — resume workflow
  POST /api/v2/workflows/{id}/reset   — reset all tasks
"""

from __future__ import annotations
import json
from fastapi import APIRouter, HTTPException
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState, WorkflowState
from catgo.workflow.engine.lifecycle import (
    submit_workflow, pause_workflow, resume_workflow, reset_workflow,
)

router = APIRouter(prefix="/api/v2/workflows", tags=["workflow-v2"])

# DB instance — set by app startup
_db: WorkflowDB | None = None


def set_db(db: WorkflowDB) -> None:
    global _db
    _db = db


def _get_db() -> WorkflowDB:
    if _db is None:
        raise RuntimeError("Workflow DB not initialized")
    return _db


@router.get("")
async def list_workflows():
    db = _get_db()
    workflows = db.list_workflows()
    result = []
    for wf in workflows:
        tasks = db.get_all_tasks(wf["id"])
        status_counts = {}
        for t in tasks:
            s = t["status"]
            status_counts[s] = status_counts.get(s, 0) + 1
        result.append({
            "id": wf["id"],
            "name": wf["name"],
            "status": wf["status"],
            "created_at": wf.get("created_at"),
            "updated_at": wf.get("updated_at"),
            "task_count": len(tasks),
            "status_counts": status_counts,
        })
    return result


@router.get("/{workflow_id}")
async def get_workflow(workflow_id: str):
    db = _get_db()
    try:
        wf = db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    tasks = db.get_all_tasks(workflow_id)
    return {
        "workflow": wf,
        "tasks": tasks,
        "task_count": len(tasks),
    }


@router.get("/{workflow_id}/dag")
async def get_dag(workflow_id: str):
    db = _get_db()
    try:
        db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    return db.get_dag(workflow_id)


@router.post("/{workflow_id}/submit")
async def submit(workflow_id: str):
    db = _get_db()
    try:
        wf = db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    if wf["status"] == "running":
        raise HTTPException(409, "Already running")
    submit_workflow(db, workflow_id)
    return {"status": "running", "workflow_id": workflow_id}


@router.post("/{workflow_id}/pause")
async def pause(workflow_id: str):
    db = _get_db()
    try:
        wf = db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    pause_workflow(db, workflow_id)
    return {"status": "paused", "workflow_id": workflow_id}


@router.post("/{workflow_id}/resume")
async def resume(workflow_id: str):
    db = _get_db()
    try:
        wf = db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    resume_workflow(db, workflow_id)
    return {"status": "running", "workflow_id": workflow_id}


@router.post("/{workflow_id}/reset")
async def reset(workflow_id: str):
    db = _get_db()
    try:
        wf = db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    reset_workflow(db, workflow_id)
    return {"status": "draft", "workflow_id": workflow_id}
```

- [ ] **Step 2: Commit**

```bash
git add server/routers/workflow_v2.py
git commit -m "feat(P3): workflow v2 REST API — list/get/dag/submit/pause/resume/reset"
```

---

### Task 3: Task-level REST API

**Files:**
- Create: `server/routers/workflow_v2_tasks.py`

- [ ] **Step 1: Implement task endpoints**

```python
# server/routers/workflow_v2_tasks.py
"""Task-level REST API for the v2 workflow engine.

Endpoints:
  GET  /api/v2/tasks/{id}           — get task details
  PUT  /api/v2/tasks/{id}/params    — update params (only WAITING/READY)
  GET  /api/v2/tasks/{id}/result    — get result data
  POST /api/v2/tasks/{id}/retry     — reset task + downstream
  POST /api/v2/tasks/{id}/cancel    — cancel task
"""

from __future__ import annotations
import json
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from catgo.workflow.states import TaskState

router = APIRouter(prefix="/api/v2/tasks", tags=["workflow-v2-tasks"])

_db = None


def set_db(db) -> None:
    global _db
    _db = db


def _get_db():
    if _db is None:
        raise RuntimeError("Workflow DB not initialized")
    return _db


@router.get("/{task_id}")
async def get_task(task_id: str):
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")
    parents = db.get_task_parents(task_id)
    children = db.get_task_children(task_id)
    return {
        "task": task,
        "parents": parents,
        "children": children,
    }


class ParamUpdate(BaseModel):
    params: dict


@router.put("/{task_id}/params")
async def update_params(task_id: str, body: ParamUpdate):
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    editable = {TaskState.WAITING.value, TaskState.READY.value, TaskState.PAUSED.value}
    if task["status"] not in editable:
        raise HTTPException(409, f"Cannot edit params: task is {task['status']}")

    # Merge with existing params
    existing = json.loads(task.get("params_json", "{}") or "{}")
    existing.update(body.params)
    db.update_task(task_id, params_json=json.dumps(existing))
    return {"task_id": task_id, "params": existing}


@router.get("/{task_id}/result")
async def get_result(task_id: str):
    db = _get_db()
    result = db.get_result(task_id)
    if not result:
        raise HTTPException(404, f"No result for task {task_id}")
    return result


@router.post("/{task_id}/retry")
async def retry_task(task_id: str):
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    # Reset this task and all downstream tasks
    reset_ids = _reset_downstream(db, task_id, task["workflow_id"])
    return {"reset_tasks": reset_ids}


@router.post("/{task_id}/cancel")
async def cancel_task(task_id: str):
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    db.update_task(task_id, status=TaskState.CANCELLED.value)
    return {"task_id": task_id, "status": "CANCELLED"}


def _reset_downstream(db, task_id: str, workflow_id: str) -> list[str]:
    """Reset a task and all its downstream dependents to WAITING."""
    from collections import deque

    to_reset = set()
    queue = deque([task_id])
    while queue:
        tid = queue.popleft()
        if tid in to_reset:
            continue
        to_reset.add(tid)
        children = db.get_task_children(tid)
        for link in children:
            queue.append(link["target_task_id"])

    for tid in to_reset:
        db.update_task(tid,
            status=TaskState.WAITING.value,
            error_message=None,
            error_type=None,
            retry_count=0,
        )

    return list(to_reset)
```

- [ ] **Step 2: Commit**

```bash
git add server/routers/workflow_v2_tasks.py
git commit -m "feat(P3): task v2 REST API — get/update params/result/retry/cancel"
```

---

### Task 4: Register V2 Routers + Start Engine on Backend Startup

**Files:**
- Modify: `server/main.py`

- [ ] **Step 1: Register v2 routers and start engine in lifespan**

Add to `server/main.py` (in the lifespan function, after existing startup code):

```python
# ─── V2 Workflow Engine ───
from catgo.workflow.db import WorkflowDB
from catgo.workflow.config import load_config as load_catgo_config
from catgo.workflow.engine.lifecycle import start_engine, stop_engine
from routers.workflow_v2 import router as wf_v2_router, set_db as set_wf_v2_db
from routers.workflow_v2_tasks import router as tasks_v2_router, set_db as set_tasks_v2_db

catgo_config = load_catgo_config()
catgo_db_path = str(Path(catgo_config["paths"]["db_path"]).expanduser())
catgo_db = WorkflowDB(catgo_db_path)
set_wf_v2_db(catgo_db)
set_tasks_v2_db(catgo_db)

app.include_router(wf_v2_router)
app.include_router(tasks_v2_router)

# Start the state machine engine
await start_engine(catgo_db, catgo_config)
```

And in shutdown:
```python
await stop_engine()
```

- [ ] **Step 2: Run all tests**

```bash
cd server && PYTHONPATH=. python -m pytest tests/ -v
```

- [ ] **Step 3: Commit**

```bash
git add server/main.py
git commit -m "feat(P3): register v2 routers, start engine on backend startup"
```

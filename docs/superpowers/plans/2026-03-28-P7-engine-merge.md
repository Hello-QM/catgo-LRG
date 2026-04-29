# P7: Engine Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the V1 in-memory workflow engine with the V2 crash-recoverable stateless scanner while keeping the rich V1 frontend UI (WorkflowEditor, NodeStatusPanel, NodeConfigPanel) fully working.

**Architecture:** The V1 API endpoints in `server/routers/workflow.py` remain the frontend's entry point (no frontend URL changes). Internally, the run/pause/resume/reset handlers are rewired to call V2 lifecycle functions (`graph_converter` + `lifecycle.py`). The V1 WebSocket monitor is replaced by a V2-backed monitor that translates V2 broadcast messages to V1's wire format. Rich monitoring endpoints (convergence, files, frequencies, forces) are updated to read `work_dir` and `hpc_session_id` from V2's `tasks` table instead of V1's `workflow_steps` table. A state-mapping layer translates V2's 14 uppercase TaskStates to V1's 6 lowercase frontend statuses.

**Depends on:** P1, P2, P2b, P3 -- all completed.

**Principle:** Backend-only changes. No Svelte files modified. The frontend continues calling the same `/api/workflow/` endpoints and receiving the same JSON shapes.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/catgo/workflow/state_map.py` | Create | Map V2 14-state TaskState to V1 6-state frontend status |
| `server/catgo/workflow/graph_converter.py` | Modify | Preserve original node IDs as task IDs; store `graph_json` on workflow |
| `server/catgo/workflow/db.py` | Modify | Accept optional `task_id` in `create_task`; accept optional `graph_json` in `create_workflow` |
| `server/catgo/workflow/v1_compat.py` | Create | Shim: read V2 tasks table, return V1-shaped step dicts |
| `server/routers/workflow.py` | Modify | Rewire run/pause/resume/reset/monitor/list_steps to use V2 engine |
| `server/catgo/workflow/engine/broadcast.py` | Modify | Add `initial_state` broadcast helper |
| `server/tests/test_state_map.py` | Create | Test state mapping |
| `server/tests/test_v1_compat.py` | Create | Test V1 compatibility shim |
| `server/tests/test_engine_merge.py` | Create | Integration test: run via V1 API, verify V2 engine executes |

---

### Task 1: State Mapping Layer

Map V2's 14 uppercase TaskStates to V1's 6 lowercase frontend statuses so the existing `STATUS_COLORS` and `node_statuses` logic works without frontend changes.

**Files:**
- Create: `server/catgo/workflow/state_map.py`
- Create: `server/tests/test_state_map.py`

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_state_map.py
"""Test V2 TaskState -> V1 frontend status mapping."""

from catgo.workflow.state_map import v2_to_v1_status, v1_to_v2_status


def test_terminal_states():
    assert v2_to_v1_status("COMPLETED") == "completed"
    assert v2_to_v1_status("FAILED") == "failed"
    assert v2_to_v1_status("CANCELLED") == "failed"


def test_active_states():
    assert v2_to_v1_status("RUNNING") == "running"
    assert v2_to_v1_status("GENERATING") == "running"
    assert v2_to_v1_status("UPLOADING") == "running"
    assert v2_to_v1_status("COLLECTING") == "running"
    assert v2_to_v1_status("COMPLETED_REMOTE") == "running"


def test_queued_states():
    assert v2_to_v1_status("SUBMITTED") == "queued"
    assert v2_to_v1_status("QUEUED") == "queued"


def test_pending_states():
    assert v2_to_v1_status("WAITING") == "pending"
    assert v2_to_v1_status("READY") == "pending"


def test_special_states():
    assert v2_to_v1_status("PAUSED") == "paused"
    assert v2_to_v1_status("REMOTE_ERROR") == "failed"


def test_unknown_passthrough():
    assert v2_to_v1_status("some_unknown") == "some_unknown"


def test_v1_to_v2_pending():
    assert v1_to_v2_status("pending") == "WAITING"


def test_v1_to_v2_running():
    assert v1_to_v2_status("running") == "RUNNING"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_state_map.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'catgo.workflow.state_map'`

- [ ] **Step 3: Write implementation**

```python
# server/catgo/workflow/state_map.py
"""Map V2 14-state TaskState to V1 6-state frontend status.

V2 states: WAITING, READY, GENERATING, UPLOADING, SUBMITTED, QUEUED,
           RUNNING, COMPLETED_REMOTE, COLLECTING, COMPLETED, FAILED,
           REMOTE_ERROR, PAUSED, CANCELLED

V1 frontend statuses (STATUS_COLORS in workflow-types.ts):
  pending, queued, running, completed, not_converged, failed, paused
"""

from __future__ import annotations

_V2_TO_V1: dict[str, str] = {
    "WAITING": "pending",
    "READY": "pending",
    "GENERATING": "running",
    "UPLOADING": "running",
    "SUBMITTED": "queued",
    "QUEUED": "queued",
    "RUNNING": "running",
    "COMPLETED_REMOTE": "running",
    "COLLECTING": "running",
    "COMPLETED": "completed",
    "FAILED": "failed",
    "REMOTE_ERROR": "failed",
    "PAUSED": "paused",
    "CANCELLED": "failed",
}

_V1_TO_V2: dict[str, str] = {
    "pending": "WAITING",
    "queued": "QUEUED",
    "running": "RUNNING",
    "completed": "COMPLETED",
    "failed": "FAILED",
    "paused": "PAUSED",
    "not_converged": "COMPLETED",
}


def v2_to_v1_status(v2_status: str) -> str:
    """Convert V2 TaskState string to V1 frontend status."""
    return _V2_TO_V1.get(v2_status, v2_status)


def v1_to_v2_status(v1_status: str) -> str:
    """Convert V1 frontend status to V2 TaskState string."""
    return _V1_TO_V2.get(v1_status, v1_status.upper())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_state_map.py -v`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/state_map.py server/tests/test_state_map.py
git commit -m "feat(workflow): add V2-to-V1 state mapping layer for engine merge"
```

---

### Task 2: Preserve Node IDs in Graph Converter

The V1 frontend uses `node.id` from `graph_json` as step IDs in all API calls. V2's `graph_converter` currently generates random task IDs. We must preserve the original node IDs so the frontend's existing calls (`/steps/{step_id}/files`, `/convergence/{step_id}`, etc.) continue working.

**Files:**
- Modify: `server/catgo/workflow/db.py:84-101` (add optional `task_id` param to `create_task`)
- Modify: `server/catgo/workflow/db.py:46-56` (add optional `graph_json` param to `create_workflow`)
- Modify: `server/catgo/workflow/graph_converter.py:55-107` (pass node IDs as task IDs; store graph_json)
- Create: `server/tests/test_graph_converter_ids.py`

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_graph_converter_ids.py
"""Test that graph_converter preserves original node IDs as task IDs."""

import json
import os
import tempfile
from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def test_node_ids_preserved():
    db, path = _make_db()
    try:
        graph = {
            "nodes": [
                {"id": "node_abc", "type": "structure_input", "params": {}},
                {"id": "node_xyz", "type": "geo_opt", "params": {"software": "vasp"}},
            ],
            "edges": [
                {"from": "node_abc", "to": "node_xyz", "fromH": "out-0", "toH": "in-0"},
            ],
        }
        wf_id = convert_graph_json(db, "test", json.dumps(graph))
        tasks = db.get_all_tasks(wf_id)
        task_ids = {t["id"] for t in tasks}
        assert task_ids == {"node_abc", "node_xyz"}
    finally:
        os.unlink(path)


def test_graph_json_stored_on_workflow():
    db, path = _make_db()
    try:
        graph = {"nodes": [{"id": "n1", "type": "geo_opt", "params": {}}], "edges": []}
        wf_id = convert_graph_json(db, "test", json.dumps(graph))
        wf = db.get_workflow(wf_id)
        assert wf.get("graph_json") is not None
        stored = json.loads(wf["graph_json"])
        assert stored["nodes"][0]["id"] == "n1"
    finally:
        os.unlink(path)


def test_links_use_original_ids():
    db, path = _make_db()
    try:
        graph = {
            "nodes": [
                {"id": "src_node", "type": "structure_input", "params": {}},
                {"id": "tgt_node", "type": "geo_opt", "params": {}},
            ],
            "edges": [
                {"from": "src_node", "to": "tgt_node", "fromH": "out-0", "toH": "in-0"},
            ],
        }
        wf_id = convert_graph_json(db, "test", json.dumps(graph))
        dag = db.get_dag(wf_id)
        links = dag["links"]
        assert len(links) == 1
        assert links[0]["source_task_id"] == "src_node"
        assert links[0]["target_task_id"] == "tgt_node"
    finally:
        os.unlink(path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_graph_converter_ids.py -v`
Expected: FAIL -- task IDs are random hex, not `node_abc`/`node_xyz`

- [ ] **Step 3: Modify `db.py` to accept optional task_id and graph_json**

In `server/catgo/workflow/db.py`, modify `create_task` (line 84) and `create_workflow` (line 46):

```python
# server/catgo/workflow/db.py — modify create_task (line 84)
    def create_task(
        self, workflow_id: str, task_type: str, *,
        task_id: str | None = None,  # NEW: allow caller to set ID
        name: str | None = None, params: dict | None = None,
        software: str | None = None, system_name: str | None = None,
    ) -> str:
        task_id = task_id or _generate_id()
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                """INSERT INTO tasks
                   (id, workflow_id, task_type, name, status, params_json, software, system_name, created_at)
                   VALUES (?, ?, ?, ?, 'WAITING', ?, ?, ?, ?)""",
                (task_id, workflow_id, task_type, name, json.dumps(params or {}),
                 software, system_name, _now()),
            )
            conn.commit()
            conn.close()
        return task_id
```

```python
# server/catgo/workflow/db.py — modify create_workflow (line 46)
    def create_workflow(self, name: str, config: dict | None = None,
                        graph_json: str | None = None) -> str:
        wf_id = _generate_id()
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                "INSERT INTO workflows (id, name, status, created_at, updated_at, config_json, graph_json) VALUES (?, ?, 'draft', ?, ?, ?, ?)",
                (wf_id, name, _now(), _now(), json.dumps(config or {}), graph_json),
            )
            conn.commit()
            conn.close()
        return wf_id
```

- [ ] **Step 4: Modify `graph_converter.py` to pass node IDs and store graph_json**

```python
# server/catgo/workflow/graph_converter.py — modify convert_graph_json (line 55)
def convert_graph_json(
    db: WorkflowDB,
    name: str,
    graph_json: str,
    config: dict[str, Any] | None = None,
) -> str:
    """Parse graph_json, create v2 workflow with tasks + links. Returns workflow_id."""
    graph = json.loads(graph_json) if isinstance(graph_json, str) else graph_json
    raw_json = graph_json if isinstance(graph_json, str) else json.dumps(graph_json)
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    wf_id = db.create_workflow(name, config=config, graph_json=raw_json)

    # Create tasks, preserving original node IDs as task IDs
    for node in nodes:
        node_id = node["id"]
        node_type = node["type"]
        params = node.get("params", {})

        software = params.get("software") if isinstance(params, dict) else None

        db.create_task(
            wf_id, node_type,
            task_id=node_id,  # preserve original node ID
            name=params.get("label") or params.get("system_name"),
            params=params,
            software=software,
            system_name=params.get("system_name"),
        )

    # Create links from edges
    for edge in edges:
        src_node_id = edge.get("from", edge.get("source", ""))
        tgt_node_id = edge.get("to", edge.get("target", ""))
        src_handle = edge.get("fromH", edge.get("fromHandle", "out-0"))
        tgt_handle = edge.get("toH", edge.get("toHandle", "in-0"))

        if not src_node_id or not tgt_node_id:
            continue

        # Resolve semantic keys from handle IDs
        src_node_type = next((n["type"] for n in nodes if n["id"] == src_node_id), "")
        tgt_node_type = next((n["type"] for n in nodes if n["id"] == tgt_node_id), "")

        source_key = _get_handle_name(src_node_type, src_handle, "output")
        target_key = _get_handle_name(tgt_node_type, tgt_handle, "input")

        db.create_link(wf_id, src_node_id, tgt_node_id, source_key, target_key)

    return wf_id
```

Note: The `node_to_task` mapping dict is removed because node IDs ARE task IDs now.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_graph_converter_ids.py -v`
Expected: All 3 tests PASS

- [ ] **Step 6: Run existing V2 tests to verify no regressions**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/ -k "workflow" -v --timeout=30`
Expected: All existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add server/catgo/workflow/db.py server/catgo/workflow/graph_converter.py server/tests/test_graph_converter_ids.py
git commit -m "feat(workflow): preserve node IDs as task IDs in graph converter"
```

---

### Task 3: V1 Compatibility Shim

Create a compatibility layer that reads from V2's `tasks` table and returns V1-shaped step dicts. This replaces `utils/workflow_db.list_steps()` and `utils/workflow_db.get_step_status()` calls in `workflow.py`.

**Files:**
- Create: `server/catgo/workflow/v1_compat.py`
- Create: `server/tests/test_v1_compat.py`

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_v1_compat.py
"""Test V1 compatibility shim that reads V2 tasks table in V1 format."""

import json
import os
import tempfile
from catgo.workflow.db import WorkflowDB
from catgo.workflow.v1_compat import list_steps_v1, get_step_status_v1


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def test_list_steps_returns_v1_shape():
    db, path = _make_db()
    try:
        wf_id = db.create_workflow("test")
        db.create_task(wf_id, "geo_opt", task_id="step1", name="Optimize",
                       params={"software": "vasp"})
        db.update_task("step1", status="RUNNING", work_dir="/scratch/calc",
                       hpc_job_id="12345", hpc_session_id="sess1")

        steps = list_steps_v1(db, wf_id)
        assert len(steps) == 1
        s = steps[0]
        # V1 shape uses lowercase status
        assert s["id"] == "step1"
        assert s["node_type"] == "geo_opt"
        assert s["status"] == "running"
        assert s["work_dir"] == "/scratch/calc"
        assert s["hpc_job_id"] == "12345"
        assert s["hpc_session_id"] == "sess1"
    finally:
        os.unlink(path)


def test_get_step_status_v1():
    db, path = _make_db()
    try:
        wf_id = db.create_workflow("test")
        db.create_task(wf_id, "freq", task_id="s2", params={"software": "vasp"})
        db.update_task("s2", status="COMPLETED", work_dir="/scratch/freq",
                       hpc_session_id="sess2")

        step = get_step_status_v1(db, wf_id, "s2")
        assert step["status"] == "completed"
        assert step["work_dir"] == "/scratch/freq"
    finally:
        os.unlink(path)


def test_get_step_missing_raises():
    db, path = _make_db()
    try:
        wf_id = db.create_workflow("test")
        try:
            get_step_status_v1(db, wf_id, "nonexistent")
            assert False, "Should have raised KeyError"
        except KeyError:
            pass
    finally:
        os.unlink(path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_v1_compat.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write implementation**

```python
# server/catgo/workflow/v1_compat.py
"""V1 compatibility shim — read V2 tasks table, return V1-shaped step dicts.

Used by the V1 API endpoints in workflow.py so the frontend sees the same
JSON shape it always has, but data comes from the V2 engine's tables.
"""

from __future__ import annotations
import json
from catgo.workflow.db import WorkflowDB
from catgo.workflow.state_map import v2_to_v1_status


def list_steps_v1(db: WorkflowDB, workflow_id: str) -> list[dict]:
    """Return V2 tasks formatted as V1 step dicts."""
    tasks = db.get_all_tasks(workflow_id)
    return [_task_to_step(t) for t in tasks]


def get_step_status_v1(db: WorkflowDB, workflow_id: str, step_id: str) -> dict:
    """Get a single V2 task formatted as V1 step dict."""
    tasks = db.get_all_tasks(workflow_id)
    for t in tasks:
        if t["id"] == step_id:
            return _task_to_step(t)
    raise KeyError(f"Step {step_id} not found in workflow {workflow_id}")


def _task_to_step(task: dict) -> dict:
    """Convert a V2 task row to a V1 step dict."""
    params = json.loads(task.get("params_json", "{}") or "{}")
    result = json.loads(task.get("result_json", "{}") or "{}")
    return {
        "id": task["id"],
        "workflow_id": task["workflow_id"],
        "node_type": task["task_type"],
        "label": task.get("name", "") or params.get("label", "") or task["task_type"],
        "status": v2_to_v1_status(task["status"]),
        "config_json": task.get("params_json", "{}"),
        "hpc_job_id": task.get("hpc_job_id"),
        "hpc_session_id": task.get("hpc_session_id"),
        "hpc_host": params.get("hpc_host"),
        "work_dir": task.get("work_dir"),
        "ase_db_id": None,
        "result_json": task.get("result_json", "{}"),
        "error_message": task.get("error_message"),
        "started_at": task.get("started_at"),
        "completed_at": task.get("completed_at"),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_v1_compat.py -v`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/v1_compat.py server/tests/test_v1_compat.py
git commit -m "feat(workflow): V1 compatibility shim reads V2 tasks in V1 format"
```

---

### Task 4: V2 WebSocket Monitor with V1 Wire Format

The V1 monitor sends `initial_state` on connect (with step snapshot), then streams `step_status` and `workflow_status` messages. The V2 monitor just streams from broadcast queue with no initial state. We need a monitor that: (a) sends V1-shaped `initial_state` on connect, (b) translates V2 broadcast messages to V1 wire format (lowercase status, `step_id` not `task_id`).

**Files:**
- Create: `server/catgo/workflow/engine/v1_monitor.py`
- Create: `server/tests/test_v1_monitor.py`

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_v1_monitor.py
"""Test V1-compatible monitor message translation."""

from catgo.workflow.engine.v1_monitor import (
    build_initial_state,
    translate_broadcast_message,
)


def test_build_initial_state():
    tasks = [
        {"id": "n1", "task_type": "geo_opt", "status": "RUNNING",
         "hpc_job_id": "123", "error_message": None},
        {"id": "n2", "task_type": "freq", "status": "WAITING",
         "hpc_job_id": None, "error_message": None},
    ]
    msg = build_initial_state("running", tasks)
    assert msg["type"] == "initial_state"
    assert msg["workflow_status"] == "running"
    assert len(msg["steps"]) == 2
    assert msg["steps"][0]["id"] == "n1"
    assert msg["steps"][0]["status"] == "running"
    assert msg["steps"][1]["status"] == "pending"


def test_translate_task_status():
    v2_msg = {"type": "task_status", "task_id": "n1", "status": "COMPLETED"}
    v1_msg = translate_broadcast_message(v2_msg)
    assert v1_msg["type"] == "step_status"
    assert v1_msg["step_id"] == "n1"
    assert v1_msg["status"] == "completed"


def test_translate_workflow_status():
    v2_msg = {"type": "workflow_status", "status": "completed"}
    v1_msg = translate_broadcast_message(v2_msg)
    assert v1_msg["type"] == "workflow_status"
    assert v1_msg["status"] == "completed"


def test_translate_unknown_passthrough():
    v2_msg = {"type": "ping"}
    v1_msg = translate_broadcast_message(v2_msg)
    assert v1_msg["type"] == "ping"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_v1_monitor.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write implementation**

```python
# server/catgo/workflow/engine/v1_monitor.py
"""Translate V2 engine broadcast messages to V1 frontend wire format.

V1 wire format (consumed by workflow-execution.svelte.ts):
  - initial_state: {type, workflow_status, steps: [{id, status, hpc_job_id, error_message}]}
  - step_status:   {type, step_id, status, job_id?}
  - workflow_status: {type, status}
  - ping:          {type: "ping"}

V2 broadcast format (from broadcast.py):
  - task_status:    {type, task_id, status}  (status is UPPERCASE)
  - workflow_status: {type, status}          (status is lowercase)
"""

from __future__ import annotations
from typing import Any

from catgo.workflow.state_map import v2_to_v1_status


def build_initial_state(
    workflow_status: str,
    tasks: list[dict],
) -> dict[str, Any]:
    """Build V1-shaped initial_state message from V2 task rows."""
    steps = []
    for t in tasks:
        steps.append({
            "id": t["id"],
            "node_type": t.get("task_type", ""),
            "status": v2_to_v1_status(t["status"]),
            "hpc_job_id": t.get("hpc_job_id"),
            "error_message": t.get("error_message"),
        })
    return {
        "type": "initial_state",
        "workflow_status": workflow_status,
        "steps": steps,
    }


def translate_broadcast_message(msg: dict[str, Any]) -> dict[str, Any]:
    """Translate a V2 broadcast message to V1 wire format."""
    msg_type = msg.get("type", "")

    if msg_type == "task_status":
        return {
            "type": "step_status",
            "step_id": msg.get("task_id", ""),
            "status": v2_to_v1_status(msg.get("status", "")),
            "job_id": msg.get("job_id"),
        }

    if msg_type == "workflow_status":
        return {
            "type": "workflow_status",
            "status": msg.get("status", ""),
        }

    # ping, error, etc — pass through
    return msg
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_v1_monitor.py -v`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/engine/v1_monitor.py server/tests/test_v1_monitor.py
git commit -m "feat(workflow): V1-compatible monitor message translator for V2 broadcast"
```

---

### Task 5: Rewire V1 Run Endpoint to V2 Engine

Replace the V1 `api_run_workflow` handler to: (1) convert `graph_json` to V2 tasks via `graph_converter`, (2) apply `WorkflowRunConfig` to V2 tasks, (3) submit to V2 engine. The existing HPC validation and slab pre-generation logic in the frontend stays unchanged.

**Files:**
- Modify: `server/routers/workflow.py:552-665` (rewrite `api_run_workflow`)

- [ ] **Step 1: Read the current endpoint to understand all pre-flight checks**

Read `server/routers/workflow.py` lines 552-665 carefully. The pre-flight checks to preserve:
- Check not already running (line 563-564)
- Check workflow exists (line 566-569)
- Check status allows run (line 571-575)
- Pre-classify workflow (line 583-584)
- Validate HPC session alive (line 593-603)
- Check HPC nodes have session (line 606-623)
- Reset steps to pending (line 631-638) -- this now happens via V2 `reset_workflow`

- [ ] **Step 2: Rewrite api_run_workflow to use V2 engine**

Replace `server/routers/workflow.py` function `api_run_workflow` (around line 552):

```python
@router.post("/{workflow_id}/run")
async def api_run_workflow(workflow_id: str, config: WorkflowRunConfig):
    """Start executing a workflow via V2 stateless engine.

    1. Convert graph_json -> V2 tasks (preserving node IDs)
    2. Apply WorkflowRunConfig to V2 tasks (sessions, job params)
    3. Submit to V2 engine scanner
    """
    try:
        wf = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    if wf.status not in ("draft", "failed", "completed", "paused", "running"):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot start workflow in '{wf.status}' state."
        )

    # Pre-classify for user-facing message
    from workflow.classify import classify_workflow
    classification = classify_workflow(wf.graph_json)

    # Validate HPC session if needed
    if config.execution_mode == "hpc" and config.default_session_id:
        from utils.hpc_client import pool as hpc_pool
        hpc = hpc_pool.get_connection(config.default_session_id)
        if hpc is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"HPC session '{config.default_session_id}' is no longer connected. "
                    f"Please reconnect to the HPC cluster before running the workflow."
                ),
            )

    if config.execution_mode == "hpc" and not config.default_session_id:
        from utils.hpc_client import pool as hpc_pool, LOCAL_SESSION_ID
        has_remote = any(
            sid != LOCAL_SESSION_ID and conn.is_alive
            for sid, conn in hpc_pool.connections.items()
        )
        from workflow.node_dispatch import get_hpc_node_types_in_graph
        hpc_types = get_hpc_node_types_in_graph(wf.graph_json)
        if hpc_types and not has_remote:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"No HPC cluster connected. This workflow has nodes that require "
                    f"HPC execution: {', '.join(hpc_types)}. "
                    f"Connect to an HPC cluster first, or switch nodes to Local execution mode."
                ),
            )

    # --- V2 Engine Path ---
    from routers.workflow_v2 import _db as v2_db
    if v2_db is None:
        raise HTTPException(status_code=500, detail="V2 workflow engine not initialized")

    # Convert graph to V2 tasks (idempotent: uses node IDs as task IDs)
    from catgo.workflow.graph_converter import convert_graph_json
    graph = wf.graph_json

    # Reset existing V2 workflow if it exists, or create new one
    try:
        v2_wf = v2_db.get_workflow(workflow_id)
        # Workflow already exists in V2 — reset it
        from catgo.workflow.engine.lifecycle import reset_workflow as v2_reset
        v2_reset(v2_db, workflow_id)
    except KeyError:
        # First run: create V2 workflow from graph_json
        pass

    v2_wf_id = convert_graph_json(v2_db, wf.name or workflow_id, graph,
                                   config=_run_config_to_engine_config(config))

    # Apply per-step HPC sessions and job params to V2 tasks
    _apply_run_config_to_tasks(v2_db, v2_wf_id, config)

    # Submit to V2 engine
    from catgo.workflow.engine.lifecycle import submit_workflow
    submit_workflow(v2_db, v2_wf_id)

    return {
        "status": "started",
        "workflow_id": workflow_id,
        "v2_workflow_id": v2_wf_id,
        "engine_path": classification.path,
        "routing_reason": classification.reason,
        "warnings": classification.warnings,
    }


def _run_config_to_engine_config(config: WorkflowRunConfig) -> dict:
    """Convert V1 WorkflowRunConfig to V2 engine config dict."""
    return {
        "engine": {"poll_interval": config.poll_interval},
        "hpc": {
            "default_session_id": config.default_session_id,
            "base_work_dir": config.base_work_dir,
            "use_custodian": config.use_custodian,
            "potcar_root": "",
        },
        "execution_mode": config.execution_mode,
    }


def _apply_run_config_to_tasks(
    db, workflow_id: str, config: WorkflowRunConfig
) -> None:
    """Apply per-step session, job params, and scripts to V2 tasks."""
    import json

    tasks = db.get_all_tasks(workflow_id)
    for task in tasks:
        tid = task["id"]
        updates = {}

        # Per-step session override
        session_id = config.step_sessions.get(tid, config.default_session_id)
        if session_id:
            updates["hpc_session_id"] = session_id

        # Per-step job params — merge into params_json
        step_params = config.step_job_params.get(tid)
        step_script = config.step_scripts.get(tid)
        if step_params or step_script:
            params = json.loads(task.get("params_json", "{}") or "{}")
            if step_params:
                params.update(step_params.model_dump(exclude_none=True))
            if step_script:
                params["job_script"] = step_script
            updates["params_json"] = json.dumps(params)

        if updates:
            db.update_task(tid, **updates)
```

- [ ] **Step 3: Also update the V1 `list_steps` / `get_step_status` calls in workflow.py**

Near the top of `server/routers/workflow.py`, add the V2 DB import and replace step-reading functions. Add after the existing imports (around line 68):

```python
# V2 engine bridge: read steps from V2 tasks table
def _v2_list_steps(wf_id: str) -> list[dict]:
    """Read steps from V2 engine. Falls back to V1 if V2 not available."""
    from routers.workflow_v2 import _db as v2_db
    if v2_db is None:
        return list_steps(wf_id)
    from catgo.workflow.v1_compat import list_steps_v1
    try:
        steps = list_steps_v1(v2_db, wf_id)
        return steps if steps else list_steps(wf_id)
    except Exception:
        return list_steps(wf_id)


def _v2_get_step_status(wf_id: str, step_id: str) -> dict:
    """Read one step from V2 engine. Falls back to V1 if V2 not available."""
    from routers.workflow_v2 import _db as v2_db
    if v2_db is None:
        return get_step_status(wf_id, step_id)
    from catgo.workflow.v1_compat import get_step_status_v1
    try:
        return get_step_status_v1(v2_db, wf_id, step_id)
    except KeyError:
        return get_step_status(wf_id, step_id)
```

Then replace all calls to `list_steps(workflow_id)` and `get_step_status(workflow_id, step_id)` in the monitoring endpoints with `_v2_list_steps(workflow_id)` and `_v2_get_step_status(workflow_id, step_id)`. The affected endpoints are:

- `api_list_steps` (line 718): `steps = list_steps(workflow_id)` -> `steps = _v2_list_steps(workflow_id)`
- `api_get_run_status` (line 748): `steps = list_steps(workflow_id)` -> `steps = _v2_list_steps(workflow_id)`
- `api_get_step_files` (line 794): `steps = list_steps(workflow_id)` -> `steps = _v2_list_steps(workflow_id)`
- `api_get_step_output` (line 848): `steps = list_steps(workflow_id)` -> `steps = _v2_list_steps(workflow_id)`
- `api_get_convergence` (line 1105): `step = get_step_status(workflow_id, step_id)` -> `step = _v2_get_step_status(workflow_id, step_id)`
- `api_get_step_forces` (line 1156): same replacement
- `api_get_vasp_frequencies` (line 1193): same replacement
- `api_get_orca_progress` (line 1370): same replacement
- `api_get_step_results` (line 1317): same replacement

- [ ] **Step 4: Verify run endpoint compiles**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -c "from routers.workflow import router; print('OK')"` (from `server/` directory)
Expected: `OK` (no import errors)

- [ ] **Step 5: Commit**

```bash
git add server/routers/workflow.py
git commit -m "feat(workflow): rewire V1 run endpoint and step-reading to V2 engine"
```

---

### Task 6: Rewire Pause/Resume/Reset Endpoints

Replace V1's asyncio-based pause/resume/reset with V2 lifecycle calls.

**Files:**
- Modify: `server/routers/workflow.py:668-716` (pause, resume endpoints)
- Modify: `server/routers/workflow.py:283-317` (reset endpoint)

- [ ] **Step 1: Rewrite pause endpoint**

Replace `api_pause_workflow` (around line 673):

```python
@router.post("/{workflow_id}/pause")
async def api_pause_workflow(workflow_id: str, req: PauseRequest = PauseRequest()):
    """Pause a running workflow via V2 engine."""
    try:
        wf = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    if wf.status not in ("running", "paused"):
        raise HTTPException(status_code=409,
                            detail=f"Workflow is not running or paused (status: {wf.status})")

    from routers.workflow_v2 import _db as v2_db
    if v2_db is None:
        raise HTTPException(status_code=500, detail="V2 engine not initialized")

    from catgo.workflow.engine.lifecycle import pause_workflow as v2_pause
    v2_pause(v2_db, workflow_id)

    # Also cancel HPC jobs if requested
    if req.cancel_step_ids is None or req.cancel_step_ids:
        try:
            from workflow.hpc_lifecycle import cancel_workflow_jobs
            await cancel_workflow_jobs(workflow_id, only_step_ids=req.cancel_step_ids)
        except Exception:
            pass  # best-effort job cancellation

    return {"status": "paused", "workflow_id": workflow_id}
```

- [ ] **Step 2: Rewrite resume endpoint**

Replace `api_resume_workflow` (around line 695):

```python
@router.post("/{workflow_id}/resume")
async def api_resume_workflow(workflow_id: str, config: WorkflowRunConfig):
    """Resume a paused workflow via V2 engine."""
    try:
        wf = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    if wf.status != "paused":
        raise HTTPException(status_code=409,
                            detail=f"Workflow is not paused (status: {wf.status})")

    from routers.workflow_v2 import _db as v2_db
    if v2_db is None:
        raise HTTPException(status_code=500, detail="V2 engine not initialized")

    # Re-apply config (user may have changed session/params)
    _apply_run_config_to_tasks(v2_db, workflow_id, config)

    from catgo.workflow.engine.lifecycle import resume_workflow as v2_resume
    v2_resume(v2_db, workflow_id)

    return {"status": "resumed", "workflow_id": workflow_id}
```

- [ ] **Step 3: Rewrite reset endpoint**

Replace `api_reset_workflow` (around line 283):

```python
@router.post("/{workflow_id}/reset")
async def api_reset_workflow(workflow_id: str):
    """Reset all tasks to WAITING via V2 engine + cancel HPC jobs."""
    # Cancel HPC jobs (best-effort)
    cancelled = []
    try:
        from workflow.hpc_lifecycle import cancel_workflow_jobs
        cancelled = await cancel_workflow_jobs(workflow_id, only_step_ids=None)
    except Exception as e:
        logger.warning("Cancel jobs on reset failed: %s", e)

    from routers.workflow_v2 import _db as v2_db
    if v2_db is None:
        # Fall back to V1 reset
        from utils.workflow_db import reset_all_steps
        count = reset_all_steps(workflow_id)
    else:
        from catgo.workflow.engine.lifecycle import reset_workflow as v2_reset
        v2_reset(v2_db, workflow_id)
        tasks = v2_db.get_all_tasks(workflow_id)
        count = len(tasks)

    return {
        "status": "reset",
        "workflow_id": workflow_id,
        "steps_reset": count,
        "jobs_cancelled": len([r for r in cancelled if r.get("success")]),
    }
```

- [ ] **Step 4: Rewrite retry endpoint**

Replace `api_retry_step` (around line 270):

```python
@router.post("/{workflow_id}/steps/{step_id}/retry")
async def api_retry_step(workflow_id: str, step_id: str):
    """Reset a task and its downstream dependents to WAITING."""
    from routers.workflow_v2 import _db as v2_db
    if v2_db is None:
        from utils.workflow_db import reset_step_and_descendants
        reset_ids = reset_step_and_descendants(workflow_id, step_id)
    else:
        from catgo.workflow.service import retry_task
        reset_ids = retry_task(v2_db, step_id)

    if not reset_ids:
        raise HTTPException(status_code=404, detail=f"Step {step_id} not found")
    return {"reset_nodes": reset_ids, "message": f"Reset {len(reset_ids)} nodes to pending"}
```

- [ ] **Step 5: Verify endpoints compile**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files/server && python -c "from routers.workflow import router; print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add server/routers/workflow.py
git commit -m "feat(workflow): rewire pause/resume/reset/retry to V2 engine"
```

---

### Task 7: Rewire WebSocket Monitor to V2 Broadcast

Replace the V1 WebSocket monitor endpoint to use V2's broadcast queue with V1 wire format translation.

**Files:**
- Modify: `server/routers/workflow.py:1615-1702` (rewrite `ws_workflow_monitor`)

- [ ] **Step 1: Rewrite the monitor endpoint**

Replace `ws_workflow_monitor` (around line 1615):

```python
@router.websocket("/{workflow_id}/monitor")
async def ws_workflow_monitor(websocket: WebSocket, workflow_id: str):
    """Stream real-time workflow execution status via V2 engine broadcast.

    Sends V1-compatible wire format:
    - {"type": "initial_state", "workflow_status": "...", "steps": [...]}
    - {"type": "step_status", "step_id": "...", "status": "..."}
    - {"type": "workflow_status", "status": "..."}
    """
    await websocket.accept()

    from routers.workflow_v2 import _db as v2_db
    from catgo.workflow.engine.v1_monitor import (
        build_initial_state,
        translate_broadcast_message,
    )

    # Determine which DB to read initial state from
    if v2_db is not None:
        try:
            wf = v2_db.get_workflow(workflow_id)
            tasks = v2_db.get_all_tasks(workflow_id)
            initial_status = wf["status"]
        except KeyError:
            # Workflow not in V2 DB — try V1
            try:
                wf_v1 = get_workflow(workflow_id)
                initial_status = wf_v1.status.value if hasattr(wf_v1.status, 'value') else wf_v1.status
                tasks_v1 = list_steps(workflow_id)
                # Convert V1 steps to task-like dicts for build_initial_state
                tasks = [
                    {"id": s["id"], "task_type": s["node_type"],
                     "status": s.get("status", "pending").upper(),
                     "hpc_job_id": s.get("hpc_job_id"),
                     "error_message": s.get("error_message")}
                    for s in tasks_v1
                ]
            except Exception as e:
                await websocket.send_json({"type": "error", "message": str(e)})
                await websocket.close(code=1000)
                return
    else:
        await websocket.send_json({"type": "error", "message": "V2 engine not initialized"})
        await websocket.close(code=1000)
        return

    # Send initial state
    initial_msg = build_initial_state(initial_status, tasks)
    await websocket.send_json(initial_msg)

    # If workflow already finished and not being re-run, close
    if initial_status in ("completed", "failed"):
        await websocket.send_json({"type": "workflow_status", "status": initial_status})
        await websocket.close(code=1000, reason="Workflow already finished")
        return

    # Subscribe to V2 broadcast
    from catgo.workflow.engine.broadcast import add_listener, remove_listener
    queue = add_listener(workflow_id)

    try:
        while True:
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=30.0)
                v1_msg = translate_broadcast_message(msg)
                await websocket.send_json(v1_msg)
                if v1_msg.get("type") == "workflow_status" and v1_msg.get("status") in ("completed", "failed"):
                    await websocket.close(code=1000, reason="Workflow finished")
                    return
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    return
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.debug("Monitor WS for %s closed with error", workflow_id, exc_info=True)
    finally:
        remove_listener(workflow_id, queue)
```

- [ ] **Step 2: Verify endpoint compiles**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files/server && python -c "from routers.workflow import router; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add server/routers/workflow.py
git commit -m "feat(workflow): rewire WebSocket monitor to V2 broadcast with V1 wire format"
```

---

### Task 8: Ensure Recheck Jobs Works with V2

The `api_recheck_jobs` endpoint (called automatically on WebSocket connect by frontend) needs to read from V2 tasks table.

**Files:**
- Modify: `server/routers/workflow.py` (recheck-jobs endpoint)

- [ ] **Step 1: Find and read the current recheck-jobs endpoint**

Search for `recheck-jobs` or `recheck_jobs` in `server/routers/workflow.py`.

- [ ] **Step 2: Update recheck to read V2 tasks**

The recheck endpoint queries steps with `status=running|queued|submitting` and polls HPC for actual status. Update it to use `_v2_list_steps()` instead of `list_steps()`. The existing logic for polling HPC and updating status should work since `work_dir`, `hpc_session_id`, and `hpc_job_id` are all present in V2 task rows.

If the endpoint updates `workflow_steps` table directly, change it to update V2 `tasks` table via `v2_db.update_task()`.

Find the endpoint, identify all `list_steps` and `get_step_status` calls, and replace with `_v2_list_steps` / `_v2_get_step_status`. Also replace any direct DB updates like `UPDATE workflow_steps SET status=...` with `v2_db.update_task(step_id, status=...)`.

- [ ] **Step 3: Commit**

```bash
git add server/routers/workflow.py
git commit -m "fix(workflow): recheck-jobs reads from V2 tasks table"
```

---

### Task 9: Integration Test — Full Run Cycle

End-to-end test: create workflow via V1 API, run it, verify V2 engine processes it, verify V1-shaped responses.

**Files:**
- Create: `server/tests/test_engine_merge.py`

- [ ] **Step 1: Write integration test**

```python
# server/tests/test_engine_merge.py
"""Integration test: V1 API -> V2 engine -> V1 response format."""

import json
import os
import tempfile
from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json
from catgo.workflow.v1_compat import list_steps_v1, get_step_status_v1
from catgo.workflow.engine.lifecycle import submit_workflow, pause_workflow, resume_workflow, reset_workflow
from catgo.workflow.engine.scanner import WorkflowEngine
from catgo.workflow.state_map import v2_to_v1_status
import asyncio


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def _sample_graph():
    return json.dumps({
        "nodes": [
            {"id": "n1", "type": "structure_input", "params": {"structure_json": '{"lattice":{},"sites":[]}'}},
            {"id": "n2", "type": "geo_opt", "params": {"software": "vasp"}},
        ],
        "edges": [
            {"from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
        ],
    })


def test_convert_preserves_ids():
    db, path = _make_db()
    try:
        wf_id = convert_graph_json(db, "test", _sample_graph())
        tasks = db.get_all_tasks(wf_id)
        assert {t["id"] for t in tasks} == {"n1", "n2"}
    finally:
        os.unlink(path)


def test_v1_compat_after_submit():
    db, path = _make_db()
    try:
        wf_id = convert_graph_json(db, "test", _sample_graph())
        submit_workflow(db, wf_id)

        wf = db.get_workflow(wf_id)
        assert wf["status"] == "running"

        steps = list_steps_v1(db, wf_id)
        assert len(steps) == 2
        assert all(s["status"] in ("pending", "running", "completed") for s in steps)
    finally:
        os.unlink(path)


def test_pause_resume_reset_cycle():
    db, path = _make_db()
    try:
        wf_id = convert_graph_json(db, "test", _sample_graph())
        submit_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "running"

        pause_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "paused"

        resume_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "running"

        reset_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "draft"
        tasks = db.get_all_tasks(wf_id)
        assert all(t["status"] == "WAITING" for t in tasks)
    finally:
        os.unlink(path)


def test_local_task_executes_in_scan():
    """structure_input is a local task — should complete in one scan cycle."""
    db, path = _make_db()
    try:
        graph = json.dumps({
            "nodes": [
                {"id": "n1", "type": "structure_input",
                 "params": {"structure_json": '{"lattice":{"matrix":[[1,0,0],[0,1,0],[0,0,1]]},"sites":[]}'}},
            ],
            "edges": [],
        })
        wf_id = convert_graph_json(db, "test", graph)
        submit_workflow(db, wf_id)

        engine = WorkflowEngine(db=db)
        asyncio.get_event_loop().run_until_complete(engine.scan_cycle())

        steps = list_steps_v1(db, wf_id)
        assert steps[0]["status"] == "completed"
    finally:
        os.unlink(path)
```

- [ ] **Step 2: Run integration tests**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_engine_merge.py -v --timeout=30`
Expected: All 4 tests PASS

- [ ] **Step 3: Commit**

```bash
git add server/tests/test_engine_merge.py
git commit -m "test(workflow): integration tests for V1 API -> V2 engine merge"
```

---

### Task 10: Wire V2 Engine Startup in main.py

Ensure the V2 engine scanner starts when the Python backend boots, so it is ready when the frontend hits "Run".

**Files:**
- Modify: `server/main.py` (lifespan startup)

- [ ] **Step 1: Find the existing V2 engine startup code**

Search `server/main.py` for `workflow_v2` or `start_engine` or `WorkflowDB` to see if V2 is already started on boot.

Run: `grep -n "workflow_v2\|start_engine\|WorkflowDB\|v2_db\|catgo_db" server/main.py`

- [ ] **Step 2: Ensure V2 DB and engine are initialized in lifespan**

If not already present, add to the `lifespan` async context manager in `main.py`:

```python
# In the lifespan startup section of main.py:
from pathlib import Path

# Initialize V2 workflow DB
catgo_dir = Path.home() / ".catgo"
catgo_dir.mkdir(exist_ok=True)
v2_db_path = str(catgo_dir / "catgo.db")

from catgo.workflow.db import WorkflowDB
v2_db = WorkflowDB(v2_db_path)

# Share DB with V2 router
from routers.workflow_v2 import set_db
set_db(v2_db)

# Load V2 engine config
v2_config = {}
config_path = catgo_dir / "config.yaml"
if config_path.exists():
    import yaml
    with open(config_path) as f:
        v2_config = yaml.safe_load(f) or {}

# Start V2 engine scanner
from catgo.workflow.engine.lifecycle import start_engine, stop_engine
await start_engine(v2_db, v2_config)
```

In the shutdown section:
```python
await stop_engine()
```

- [ ] **Step 3: Verify server starts cleanly**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files/server && timeout 5 python main.py 2>&1 || true`
Expected: Server starts without import errors, log shows "Workflow engine started"

- [ ] **Step 4: Commit**

```bash
git add server/main.py
git commit -m "feat(workflow): start V2 engine scanner on backend boot"
```

---

### Task 11: Verify Rich Monitoring Features End-to-End

The rich monitoring features (convergence plots, file browser, VASP frequencies, forces, Gibbs calculator) all work by: (1) reading `work_dir` and `hpc_session_id` from the step, (2) SSH-ing to HPC to read files. Since Task 5 rewired all `list_steps`/`get_step_status` calls to read from V2 tasks, these features should work automatically. This task is a manual verification checklist.

**Files:** No code changes -- verification only.

- [ ] **Step 1: Verify convergence endpoint reads V2 data**

The `/convergence/{step_id}` endpoint calls `_v2_get_step_status(wf_id, step_id)` which returns `work_dir` and `hpc_session_id` from V2 tasks table. Confirm by reading `server/routers/workflow.py` around line 1101.

- [ ] **Step 2: Verify file browser endpoint reads V2 data**

The `/steps/{step_id}/files` endpoint calls `_v2_list_steps(wf_id)` and finds the step. Confirm `work_dir` is present.

- [ ] **Step 3: Verify VASP frequency endpoint reads V2 data**

The `/vasp_frequencies/{step_id}` endpoint calls `_v2_get_step_status()`. Confirm.

- [ ] **Step 4: Verify forces endpoint reads V2 data**

The `/forces/{step_id}` endpoint calls `_v2_get_step_status()`. Confirm.

- [ ] **Step 5: Verify step-results endpoint reads V2 data**

The `/step-results/{step_id}` endpoint reads `result_json` from the step. V2 stores `result_json` in the tasks table. The V1 compat shim returns `result_json` in the step dict. Confirm.

- [ ] **Step 6: Manual test (if HPC available)**

1. Open WorkflowEditor in browser
2. Create a simple workflow: structure_input -> geo_opt
3. Click Run, configure HPC session
4. Observe: nodes turn blue (running), then green (completed)
5. Click a completed node -> NodeStatusPanel should show:
   - Convergence plot (if VASP geo_opt)
   - File browser with CONTCAR, OUTCAR etc.
   - "View Structure" button loads CONTCAR

---

### Critical Verification: graph_json Node IDs match create_workflow IDs

The entire merge hinges on the fact that when the frontend calls `/api/workflow/{workflow_id}/steps/{step_id}/files`, the `step_id` it sends is the same `node.id` from `graph_json`. With Task 2, `graph_converter` now uses these IDs as V2 task IDs. But there is one subtle issue: the `workflow_id` used by the frontend is the V1 workflow ID (from `workflows` table in `catgo_results.db`), while V2 creates a NEW workflow ID in `catgo.db`.

This means the V1 `workflow_id` and V2 `workflow_id` are different. The rewired `api_run_workflow` must store the V2 workflow ID so that subsequent step-reading calls can find the right V2 workflow.

**Resolution (already handled):** The `_v2_list_steps` and `_v2_get_step_status` shim functions in Task 5 try V2 first, then fall back to V1. For this to work, the V2 workflow must be findable by the V1 workflow_id. Two approaches:

**Option A (recommended):** Store the V2 workflow_id mapping in the V1 workflow's metadata. Then `_v2_list_steps` reads the mapping and queries V2 DB with the V2 workflow_id.

**Option B:** Use the V1 workflow_id as the V2 workflow_id. This requires modifying `convert_graph_json` to accept an explicit `workflow_id`.

Let me add a supplementary task for this.

---

### Task 12: Use V1 Workflow ID as V2 Workflow ID

To avoid a mapping layer, modify `convert_graph_json` and `WorkflowDB.create_workflow` to accept an explicit workflow ID. The V1 workflow ID becomes the V2 workflow ID.

**Files:**
- Modify: `server/catgo/workflow/db.py:46-56`
- Modify: `server/catgo/workflow/graph_converter.py:55-107`
- Modify: `server/routers/workflow.py` (api_run_workflow)

- [ ] **Step 1: Add optional `workflow_id` to `create_workflow`**

```python
# server/catgo/workflow/db.py — modify create_workflow
    def create_workflow(self, name: str, config: dict | None = None,
                        graph_json: str | None = None,
                        workflow_id: str | None = None) -> str:
        wf_id = workflow_id or _generate_id()
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                "INSERT OR REPLACE INTO workflows (id, name, status, created_at, updated_at, config_json, graph_json) VALUES (?, ?, 'draft', ?, ?, ?, ?)",
                (wf_id, name, _now(), _now(), json.dumps(config or {}), graph_json),
            )
            conn.commit()
            conn.close()
        return wf_id
```

Note: `INSERT OR REPLACE` handles the case where re-running creates a new V2 workflow with the same ID.

- [ ] **Step 2: Add optional `workflow_id` to `convert_graph_json`**

```python
# server/catgo/workflow/graph_converter.py — modify signature
def convert_graph_json(
    db: WorkflowDB,
    name: str,
    graph_json: str,
    config: dict[str, Any] | None = None,
    workflow_id: str | None = None,
) -> str:
    """Parse graph_json, create v2 workflow with tasks + links. Returns workflow_id."""
    graph = json.loads(graph_json) if isinstance(graph_json, str) else graph_json
    raw_json = graph_json if isinstance(graph_json, str) else json.dumps(graph_json)
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    wf_id = db.create_workflow(name, config=config, graph_json=raw_json,
                                workflow_id=workflow_id)
    # ... rest unchanged (uses node IDs as task IDs per Task 2)
```

- [ ] **Step 3: Pass V1 workflow_id in api_run_workflow**

In the `api_run_workflow` function (from Task 5), change the `convert_graph_json` call:

```python
    v2_wf_id = convert_graph_json(v2_db, wf.name or workflow_id, graph,
                                   config=_run_config_to_engine_config(config),
                                   workflow_id=workflow_id)  # use V1 ID
```

And update `_v2_list_steps` and `_v2_get_step_status` since they now use the same workflow_id:

```python
def _v2_list_steps(wf_id: str) -> list[dict]:
    from routers.workflow_v2 import _db as v2_db
    if v2_db is None:
        return list_steps(wf_id)
    from catgo.workflow.v1_compat import list_steps_v1
    try:
        return list_steps_v1(v2_db, wf_id)  # same ID, no mapping needed
    except Exception:
        return list_steps(wf_id)
```

- [ ] **Step 4: Update integration test**

Add to `test_engine_merge.py`:

```python
def test_explicit_workflow_id():
    db, path = _make_db()
    try:
        wf_id = convert_graph_json(db, "test", _sample_graph(),
                                    workflow_id="my_v1_id")
        assert wf_id == "my_v1_id"
        wf = db.get_workflow("my_v1_id")
        assert wf["name"] == "test"
        tasks = db.get_all_tasks("my_v1_id")
        assert len(tasks) == 2
    finally:
        os.unlink(path)
```

- [ ] **Step 5: Run all tests**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_graph_converter_ids.py server/tests/test_engine_merge.py server/tests/test_v1_compat.py server/tests/test_v1_monitor.py server/tests/test_state_map.py -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/catgo/workflow/db.py server/catgo/workflow/graph_converter.py server/routers/workflow.py server/tests/test_engine_merge.py
git commit -m "feat(workflow): use V1 workflow ID as V2 ID to avoid mapping layer"
```

---

## Summary of Data Flow After Merge

```
Frontend (unchanged)                    Backend (modified)
====================                    ==================

WorkflowEditor.svelte                   workflow.py (V1 router)
  |                                       |
  |-- POST /workflow/{id}/run ----------> api_run_workflow
  |                                         |-- convert_graph_json(v2_db, ..., workflow_id=id)
  |                                         |     -> creates V2 tasks with original node IDs
  |                                         |-- submit_workflow(v2_db, id)
  |                                         |     -> sets status=running
  |                                         |
  |                                       V2 Scanner (background loop)
  |                                         |-- scan_cycle()
  |                                         |     -> advance_waiting -> READY
  |                                         |     -> execute local tasks
  |                                         |     -> submit HPC tasks
  |                                         |     -> poll running jobs
  |                                         |     -> collect results
  |                                         |     -> broadcast({type: "task_status", ...})
  |                                         |
  |-- WS /workflow/{id}/monitor --------> ws_workflow_monitor
  |                                         |-- build_initial_state(tasks)
  |                                         |-- translate_broadcast_message()
  |                                         |     -> {type: "step_status", step_id, status: lowercase}
  |                                         |
  |-- GET /workflow/{id}/steps ---------> api_list_steps
  |                                         |-- _v2_list_steps(id)
  |                                         |     -> v1_compat.list_steps_v1(v2_db, id)
  |                                         |     -> returns V1-shaped dicts with lowercase status
  |                                         |
  |-- GET /workflow/{id}/convergence/X -> api_get_convergence
  |                                         |-- _v2_get_step_status(id, X)
  |                                         |     -> reads work_dir from V2 tasks table
  |                                         |-- SSH to HPC, parse OSZICAR
  |                                         |
NodeStatusPanel.svelte                    (convergence, files, frequencies, forces
  |-- polls convergence, files             all work unchanged — they just read
  |-- displays status colors               work_dir from V2 instead of V1)
  |-- shows file browser
```

---

Plan complete. The plan would be saved to `docs/superpowers/plans/2026-03-28-P7-engine-merge.md`.

Since I am in read-only mode, I cannot write the file. Please save the plan content above to that path.

**Two execution options:**

**1. Subagent-Driven (recommended)** -- I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** -- Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

### Critical Files for Implementation
- `/home/james0001/project/catgo/.worktrees/split-files/server/routers/workflow.py` -- the V1 router being rewired (run/pause/resume/reset/monitor + all step-reading calls)
- `/home/james0001/project/catgo/.worktrees/split-files/server/catgo/workflow/graph_converter.py` -- must preserve node IDs as task IDs and accept explicit workflow_id
- `/home/james0001/project/catgo/.worktrees/split-files/server/catgo/workflow/db.py` -- must accept optional task_id in `create_task` and optional workflow_id in `create_workflow`
- `/home/james0001/project/catgo/.worktrees/split-files/server/catgo/workflow/engine/lifecycle.py` -- V2 submit/pause/resume/reset called by rewired V1 endpoints
- `/home/james0001/project/catgo/.worktrees/split-files/server/catgo/workflow/states.py` -- V2's 14-state enum that the state mapping layer translates from
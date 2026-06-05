# Workflow Task-ID Namespacing (issue #227) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two workflows that share graph node ids (e.g. the RPBE and RPBE-D3 ORR templates, both with `si`/`slab_opt`/`ap_OOH`/…) coexist in the V2 engine without clobbering each other's tasks/results.

**Architecture:** The V2 engine stores each task keyed by `tasks.id`, a *global* single-column primary key whose value today equals the graph node id. Two workflows therefore cannot both own a task `slab_opt`; `INSERT OR REPLACE` in `create_task` silently relabels the other workflow's row (root cause of #227). We make `tasks.id` globally unique by storing it as `{workflow_id}:{node_id}` and add a new `node_id` column holding the original graph node id. The primary key stays single-column, foreign keys stay single-column, and every DB method that keys by `id`/`task_id` keeps working unchanged (ids are now globally unique). The churn is confined to: (a) the place that builds task ids from node ids (`graph_converter`), (b) filesystem paths that embedded the id (`work_dir`/preview), (c) the V1-compat + WebSocket bridge that exposes node ids to the frontend, (d) four frontend sites that built engine URLs from `node.id`, and (e) MCP result/status tools keyed by task id.

**Tech Stack:** Python 3.11 (FastAPI, SQLite via `sqlite3`), pytest; Svelte 5 / SvelteKit (TypeScript) frontend.

**Branch:** `fix/workflow-runconfig-and-task-namespacing` (already checked out; carries the #231 route/`.specie` fixes and the #228 fix). Run the Python test suite with `/home/james0001/miniforge3/envs/catgo/bin/python -m pytest` from `server/`.

**Migration safety:** The schema change is *additive* — add a `node_id` column and back-fill `node_id = id` for existing rows. Existing tasks keep their bare ids (still globally unique, so they coexist with newly-namespaced ids); only *newly converted* graphs get `{wf}:{node}` ids. No destructive id rewrite. Back up first: `cp ~/.catgo/catgo.db ~/.catgo/catgo.db.bak-pre-namespacing`.

---

## File Structure

New:
- `server/catgo/workflow/task_ids.py` — single source of truth for the id convention (`make_task_id`, `node_id_from_task_id`).
- `server/tests/test_task_id_namespacing.py` — #227 regression + helper tests.

Modified (backend):
- `server/catgo/workflow/db.py` — `node_id` column (schema + migration + `create_task`).
- `server/catgo/workflow/graph_converter.py` — namespace task ids + link endpoints; store `node_id`.
- `server/catgo/workflow/engine/hpc_utils.py` — `resolve_work_dir` uses `node_id`.
- `server/catgo/workflow/engine/advancer.py`, `submitter.py` — preview dir uses `node_id`.
- `server/catgo/routers/workflow.py` — recreate/reconcile/retry bridge via `node_id`.
- `server/catgo/workflow/v1_compat.py` — expose `node_id` as the V1 step id.
- `server/catgo/workflow/engine/scanner.py` — V1 step sync keyed by `node_id`.
- `server/catgo/workflow/engine/v1_monitor.py` — de-namespace broadcasts to node ids.
- `server/catgo/routers/workflow_engine_tasks.py` — expose `node_id` in task response.
- `server/catgo/workflow/mcp_tools.py` — result/status tools accept `workflow_id`+`node_id`.

Modified (frontend):
- `src/lib/api/workflow-v2.ts` — `V2Task.node_id`.
- `src/lib/workflow/NodeStatusPanel.svelte` — lines 174, 796.
- `src/lib/workflow/WorkflowEditor.svelte` — line 945.
- `src/lib/workflow/workflow-execution.svelte.ts` — line 601.

---

## Task 1: Task-id convention helper

**Files:**
- Create: `server/catgo/workflow/task_ids.py`
- Test: `server/tests/test_task_id_namespacing.py`

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_task_id_namespacing.py
"""Issue #227: workflow task IDs are namespaced {workflow_id}:{node_id}."""
from catgo.workflow.task_ids import make_task_id, node_id_from_task_id


def test_make_task_id():
    assert make_task_id("wfA", "slab_opt") == "wfA:slab_opt"


def test_node_id_from_task_id_with_workflow_id():
    assert node_id_from_task_id("wfA:slab_opt", "wfA") == "slab_opt"


def test_node_id_from_task_id_without_workflow_id():
    # workflow ids never contain ':', so splitting on the first ':' recovers the node id
    assert node_id_from_task_id("wfA:slab_opt") == "slab_opt"


def test_node_id_from_task_id_passthrough_for_bare_or_random_ids():
    # legacy bare ids and DSL random ids (no ':') pass through unchanged
    assert node_id_from_task_id("slab_opt") == "slab_opt"
    assert node_id_from_task_id("a1b2c3d4e5f6a7b8") == "a1b2c3d4e5f6a7b8"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py -p no:cacheprovider -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'catgo.workflow.task_ids'`

- [ ] **Step 3: Write minimal implementation**

```python
# server/catgo/workflow/task_ids.py
"""Single source of truth for the V2 workflow task-id convention.

A task's primary-key `id` is globally unique and formed as `{workflow_id}:{node_id}`,
where `node_id` is the graph node id (stored separately in the `tasks.node_id`
column). Workflow ids never contain ':', so the node id is always recoverable.
Legacy bare ids and DSL-generated random ids (no ':') pass through unchanged.
"""
from __future__ import annotations


def make_task_id(workflow_id: str, node_id: str) -> str:
    """Build the globally-unique task primary key from a workflow + node id."""
    return f"{workflow_id}:{node_id}"


def node_id_from_task_id(task_id: str, workflow_id: str | None = None) -> str:
    """Recover the graph node id from a (possibly namespaced) task id."""
    if workflow_id and task_id.startswith(f"{workflow_id}:"):
        return task_id[len(workflow_id) + 1:]
    if ":" in task_id:
        return task_id.split(":", 1)[1]
    return task_id
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py -p no:cacheprovider -q`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/task_ids.py server/tests/test_task_id_namespacing.py
git commit -m "feat(workflow): add task-id namespacing helpers (#227)"
```

---

## Task 2: `node_id` column — schema, migration, create_task

**Files:**
- Modify: `server/catgo/workflow/db.py` (`_SCHEMA_SQL` ~516-543; migration loop ~114-123; `create_task` 238-256)
- Test: `server/tests/test_task_id_namespacing.py`

- [ ] **Step 1: Write the failing test**

```python
# append to server/tests/test_task_id_namespacing.py
import os
import sqlite3
import tempfile
from catgo.workflow.db import WorkflowDB


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def test_create_task_stores_node_id():
    db, path = _make_db()
    try:
        tid = db.create_task("wfA", "geo_opt", task_id="wfA:slab_opt", node_id="slab_opt")
        assert tid == "wfA:slab_opt"
        t = db.get_task("wfA:slab_opt")
        assert t["node_id"] == "slab_opt"
        assert t["workflow_id"] == "wfA"
    finally:
        os.unlink(path)


def test_migration_backfills_node_id_from_id():
    # Simulate a pre-migration DB: tasks row created without node_id, then reopened.
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        raw = sqlite3.connect(path)
        raw.executescript(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, "
            "task_type TEXT NOT NULL, status TEXT DEFAULT 'WAITING', created_at TEXT);"
        )
        raw.execute("INSERT INTO tasks (id, workflow_id, task_type) VALUES ('slab_opt','wfOld','geo_opt')")
        raw.commit()
        raw.close()

        db = WorkflowDB(path)  # triggers _migrate_db + schema
        t = db.get_task("slab_opt")
        assert t["node_id"] == "slab_opt"  # back-filled
    finally:
        os.unlink(path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py::test_create_task_stores_node_id tests/test_task_id_namespacing.py::test_migration_backfills_node_id_from_id -p no:cacheprovider -q`
Expected: FAIL — `create_task() got an unexpected keyword argument 'node_id'` / `KeyError: 'node_id'`

- [ ] **Step 3: Write minimal implementation**

In `_SCHEMA_SQL`, add the column to the `tasks` CREATE TABLE (after `workflow_id TEXT NOT NULL,`):

```python
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    node_id TEXT,
    task_type TEXT NOT NULL,
```

In `_migrate_db`, extend the ALTER-COLUMN loop and back-fill (the loop currently lists `parent_task_id`, `map_key`, `task_group`, `condition_json`):

```python
        for col, type_ in [
            ("parent_task_id", "TEXT"),
            ("map_key", "TEXT"),
            ("task_group", "TEXT"),
            ("condition_json", "TEXT"),
            ("node_id", "TEXT"),
        ]:
            try:
                conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {type_}")
            except Exception:
                pass  # column already exists
        # Back-fill node_id for pre-namespacing rows (id was the bare node id).
        try:
            conn.execute("UPDATE tasks SET node_id = id WHERE node_id IS NULL")
        except Exception:
            pass
```

In `create_task`, add the `node_id` kwarg and write it:

```python
    def create_task(
        self, workflow_id: str, task_type: str, *,
        task_id: str | None = None,
        node_id: str | None = None,
        name: str | None = None, params: dict | None = None,
        software: str | None = None, system_name: str | None = None,
    ) -> str:
        task_id = task_id or _generate_id()
        if node_id is None:
            node_id = task_id
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                """INSERT OR REPLACE INTO tasks
                   (id, workflow_id, node_id, task_type, name, status, params_json, software, system_name, created_at)
                   VALUES (?, ?, ?, ?, ?, 'WAITING', ?, ?, ?, ?)""",
                (task_id, workflow_id, node_id, task_type, name, json.dumps(params or {}),
                 software, system_name, _now()),
            )
            conn.commit()
            conn.close()
        return task_id
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py -p no:cacheprovider -q`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/db.py server/tests/test_task_id_namespacing.py
git commit -m "feat(workflow): add tasks.node_id column + back-fill migration (#227)"
```

---

## Task 3: Namespace ids in graph_converter (the #227 fix)

**Files:**
- Modify: `server/catgo/workflow/graph_converter.py` (task creation 103-118; link creation 124-140)
- Test: `server/tests/test_task_id_namespacing.py`

- [ ] **Step 1: Write the failing test**

```python
# append to server/tests/test_task_id_namespacing.py
import json
from catgo.workflow.graph_converter import convert_graph_json


def _overlap_graph():
    return json.dumps({
        "nodes": [
            {"id": "si", "type": "structure_input", "params": {}},
            {"id": "slab_opt", "type": "geo_opt", "params": {"software": "vasp"}},
        ],
        "edges": [{"from": "si", "to": "slab_opt", "fromH": "out-0", "toH": "in-0"}],
    })


def test_two_workflows_overlapping_node_ids_dont_clobber():
    """Running/converting workflow A must not delete workflow B's tasks when both
    use identical node ids (the ORR-template collision in #227)."""
    db, path = _make_db()
    try:
        # Workflow B: convert + give slab_opt a completed result.
        convert_graph_json(db, "RPBE-D3", _overlap_graph(), workflow_id="wfB")
        db.update_task("wfB:slab_opt", status="COMPLETED")
        db.store_result("wfB:slab_opt", "wfB", energy=-123.4)

        # Workflow A: convert with the SAME node ids (the recreate path).
        db.delete_workflow_tasks_and_links("wfA")  # no-op; A has none yet
        convert_graph_json(db, "RPBE", _overlap_graph(), workflow_id="wfA")

        # B survives intact.
        b_nodes = {t["node_id"] for t in db.get_all_tasks("wfB")}
        assert b_nodes == {"si", "slab_opt"}, "workflow B tasks were clobbered (#227)"
        assert db.get_result("wfB:slab_opt")["energy"] == -123.4
        # A exists independently with its own namespaced ids.
        a_ids = {t["id"] for t in db.get_all_tasks("wfA")}
        assert a_ids == {"wfA:si", "wfA:slab_opt"}
    finally:
        os.unlink(path)


def test_convert_namespaces_links():
    db, path = _make_db()
    try:
        convert_graph_json(db, "RPBE", _overlap_graph(), workflow_id="wfA")
        links = db._get_all_links("wfA")
        assert any(
            l["source_task_id"] == "wfA:si" and l["target_task_id"] == "wfA:slab_opt"
            for l in links
        )
    finally:
        os.unlink(path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py::test_two_workflows_overlapping_node_ids_dont_clobber tests/test_task_id_namespacing.py::test_convert_namespaces_links -p no:cacheprovider -q`
Expected: FAIL — `test_two_...`: `assert set() == {'si','slab_opt'}` (B clobbered, because A's `INSERT OR REPLACE` on bare id `slab_opt` stole B's row); `test_convert_namespaces_links`: link endpoints are `si`/`slab_opt`, not `wfA:si`/`wfA:slab_opt`.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `graph_converter.py`:

```python
from catgo.workflow.task_ids import make_task_id
```

In the node loop, build a namespaced task id and pass `node_id` (replace the `db.create_task(... task_id=node_id ...)` call):

```python
        for i, node in enumerate(nodes):
            node_id = node["id"]
            node_type = node["type"]
            params = node.get("params", {})
            software = params.get("software") if isinstance(params, dict) else None
            ...
            db.create_task(
                wf_id, node_type,
                task_id=make_task_id(wf_id, node_id),
                node_id=node_id,
                name=params.get("label") or params.get("system_name"),
                params=params,
                software=software,
                system_name=params.get("system_name"),
            )
```

In the edge loop, namespace both endpoints (replace the `db.create_link(...)` call):

```python
    for edge in edges:
        src_node_id = edge.get("from", edge.get("source", ""))
        tgt_node_id = edge.get("to", edge.get("target", ""))
        ...
        db.create_link(
            wf_id,
            make_task_id(wf_id, src_node_id),
            make_task_id(wf_id, tgt_node_id),
            source_key, target_key,
        )
```

> NOTE: keep the rest of `convert_graph_json` unchanged. `test_convert_preserves_ids` in `test_engine_merge.py` asserts `{t["id"]} == {"n1","n2"}` for a single workflow — update that assertion in this step to expect the namespaced ids `{f"{wf_id}:n1", f"{wf_id}:n2"}` (or switch it to compare `t["node_id"]`). Apply: in `server/tests/test_engine_merge.py::test_convert_preserves_ids`, change `assert {t["id"] for t in tasks} == {"n1", "n2"}` to `assert {t["node_id"] for t in tasks} == {"n1", "n2"}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py tests/test_engine_merge.py -p no:cacheprovider -q`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/graph_converter.py server/tests/test_task_id_namespacing.py server/tests/test_engine_merge.py
git commit -m "fix(workflow): namespace task ids per workflow to stop cross-workflow clobber (#227)"
```

---

## Task 4: work_dir + preview dirs use node_id (keep paths stable)

**Files:**
- Modify: `server/catgo/workflow/engine/hpc_utils.py:71-84`; `server/catgo/workflow/engine/advancer.py:183,199`; `server/catgo/workflow/engine/submitter.py:246`
- Test: `server/tests/test_task_id_namespacing.py`

- [ ] **Step 1: Write the failing test**

```python
# append to server/tests/test_task_id_namespacing.py
from catgo.workflow.engine.hpc_utils import resolve_work_dir


def test_resolve_work_dir_uses_node_id():
    config = {"hpc": {"base_work_dir": "/scratch/me/catgo"}}
    task = {"id": "wfA:slab_opt", "node_id": "slab_opt", "workflow_id": "wfA"}
    wd = resolve_work_dir(task, "wfA", config)
    assert wd.endswith("/wfA/slab_opt"), wd
    assert ":" not in wd.rsplit("/", 1)[-1]  # no namespaced segment in the path
```

(If `resolve_work_dir`'s real signature differs, adapt the call to match `hpc_utils.py:71`; the assertion on the produced path is the contract.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py::test_resolve_work_dir_uses_node_id -p no:cacheprovider -q`
Expected: FAIL — path ends with `/wfA/wfA:slab_opt` (the namespaced id leaked into the path).

- [ ] **Step 3: Write minimal implementation**

`hpc_utils.py` — in `resolve_work_dir`, feed the node id to the template:

```python
    work_dir = template.format(
        base_dir=base_dir,
        workflow_id=workflow_id,
        task_id=task.get("node_id") or task["id"],
    )
    return work_dir
```

`advancer.py:199` — preview dir from node id (the local var `task_id` is set at line 183 from `task["id"]`; add a `node_id` local right after it and use it):

```python
    node_id = task.get("node_id") or task_id
    ...
    preview_dir = Path.home() / ".catgo" / "preview" / node_id
```

`submitter.py:246` — match advancer (derive node id from the task dict in scope; if only `task_id` string is available, use `node_id_from_task_id`):

```python
    from catgo.workflow.task_ids import node_id_from_task_id
    preview_dir = Path(PREVIEW_DIR_PREFIX) / node_id_from_task_id(task_id, task.get("workflow_id"))
```

(Use `task["node_id"]` directly if the `task` dict is in scope at submitter.py:246; otherwise the helper above recovers it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py::test_resolve_work_dir_uses_node_id -p no:cacheprovider -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/engine/hpc_utils.py server/catgo/workflow/engine/advancer.py server/catgo/workflow/engine/submitter.py server/tests/test_task_id_namespacing.py
git commit -m "fix(workflow): build work_dir/preview paths from node_id, not namespaced id (#227)"
```

---

## Task 5: api_run_workflow recreate/reconcile/retry bridge via node_id

**Files:**
- Modify: `server/catgo/routers/workflow.py` (recreate compare 773-777; same-id branch 804, 829; reconcile response 924-936; retry 426)
- Test: `server/tests/test_run_workflow_reconcile.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_run_workflow_reconcile.py
"""Issue #227: re-running a workflow whose tasks are namespaced must take the
same-id reconcile branch (preserving results), not the full-recreate branch."""
import json
import os
import tempfile
from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def _graph():
    return json.dumps({
        "nodes": [{"id": "slab_opt", "type": "geo_opt", "params": {"software": "vasp"}}],
        "edges": [],
    })


def test_rerun_preserves_completed_result_via_node_id_match():
    """The recreate decision must compare graph node ids against tasks.node_id."""
    db, path = _make_db()
    try:
        convert_graph_json(db, "RPBE", _graph(), workflow_id="wfA")
        db.update_task("wfA:slab_opt", status="COMPLETED")
        db.store_result("wfA:slab_opt", "wfA", energy=-1.0)

        # Simulate the recreate-decision logic from api_run_workflow:
        graph_dict = json.loads(_graph())
        new_node_ids = {n["id"] for n in graph_dict["nodes"]}
        old_tasks = db.get_all_tasks("wfA")
        old_node_ids = {t["node_id"] for t in old_tasks}
        assert new_node_ids == old_node_ids  # MUST match → same-id branch, not full recreate
    finally:
        os.unlink(path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_run_workflow_reconcile.py -p no:cacheprovider -q`
Expected: PASS at the data level once Task 3 is in (this test asserts the *contract* the router must use). If it FAILS it means `node_id` isn't populated — fix Task 2/3 first. (This test guards the router edit below; the router edit itself is verified by the integration test in Task 11.)

- [ ] **Step 3: Write minimal implementation**

In `server/catgo/routers/workflow.py`, recreate decision (around 773-777):

```python
            graph_dict = json.loads(graph) if isinstance(graph, str) else graph
            new_node_ids = {n["id"] for n in graph_dict.get("nodes", [])}
            old_tasks = engine_db.get_all_tasks(workflow_id)
            old_node_ids = {t.get("node_id") or t["id"] for t in old_tasks}

            if new_node_ids != old_node_ids:
```

Same-id branch (around 804 and 829):

```python
                old_by_node = {(t.get("node_id") or t["id"]): t for t in old_tasks}
                for n in graph_dict.get("nodes", []):
                    nid = n.get("id")
                    if nid not in old_by_node:
                        continue
                    old_t = old_by_node[nid]
                    ...
                    if updates:
                        engine_db.update_task(old_t["id"], **updates)
```

Reconcile response (around 924-936) — add `node_id`:

```python
        return {"status": "ok", "tasks": [
            {"id": t["id"], "node_id": t.get("node_id") or t["id"],
             "task_type": t["task_type"], "status": t["status"]}
            for t in tasks
        ]}
```

Retry endpoint (around 426) — namespace the node id from the frontend before the V2 BFS:

```python
        from catgo.workflow.task_ids import make_task_id
        reset_ids = retry_task(engine_db, make_task_id(workflow_id, step_id))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_run_workflow_reconcile.py -p no:cacheprovider -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/catgo/routers/workflow.py server/tests/test_run_workflow_reconcile.py
git commit -m "fix(workflow): run/recreate/retry bridge maps graph node ids to namespaced tasks (#227)"
```

---

## Task 6: v1_compat exposes node_id as the V1 step id

**Files:**
- Modify: `server/catgo/workflow/v1_compat.py:24,57`
- Test: `server/tests/test_task_id_namespacing.py`

- [ ] **Step 1: Write the failing test**

```python
# append to server/tests/test_task_id_namespacing.py
from catgo.workflow.v1_compat import get_step_status_v1, list_steps_v1


def test_v1_compat_steps_keyed_by_node_id():
    db, path = _make_db()
    try:
        convert_graph_json(db, "RPBE", _overlap_graph(), workflow_id="wfA")
        steps = list_steps_v1(db, "wfA")
        assert {s["id"] for s in steps} == {"si", "slab_opt"}  # node ids, not namespaced
        one = get_step_status_v1(db, "wfA", "slab_opt")        # look up by node id
        assert one["id"] == "slab_opt"
    finally:
        os.unlink(path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py::test_v1_compat_steps_keyed_by_node_id -p no:cacheprovider -q`
Expected: FAIL — `{s["id"]}` is `{"wfA:si","wfA:slab_opt"}`; `get_step_status_v1(..., "slab_opt")` raises `KeyError` (compares `t["id"] == "slab_opt"`).

- [ ] **Step 3: Write minimal implementation**

`v1_compat.py` — line 24 (`get_step_status_v1`): compare against `node_id`:

```python
    for t in tasks:
        if (t.get("node_id") or t["id"]) == step_id:
            return _task_to_step(db, t)
```

`v1_compat.py` — line 57 (`_task_to_step` return): emit node id as `"id"` (keep `get_result(task["id"])` at line 42 unchanged — that lookup uses the namespaced PK):

```python
    return {
        "id": task.get("node_id") or task["id"],
        "workflow_id": task["workflow_id"],
        "node_type": task["task_type"],
        ...
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_task_id_namespacing.py::test_v1_compat_steps_keyed_by_node_id -p no:cacheprovider -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/v1_compat.py server/tests/test_task_id_namespacing.py
git commit -m "fix(workflow): v1_compat exposes node_id as the step id (#227)"
```

---

## Task 7: scanner V1 sync + v1_monitor de-namespacing

**Files:**
- Modify: `server/catgo/workflow/engine/scanner.py:1037`; `server/catgo/workflow/engine/v1_monitor.py:99,119,127`
- Test: `server/tests/test_v1_monitor_denamespace.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_v1_monitor_denamespace.py
"""Issue #227: V2 broadcasts (namespaced task ids) must reach the V1 frontend
wire format as graph node ids so `nodes.find(n => n.id === step_id)` matches."""
from catgo.workflow.engine.v1_monitor import translate_broadcast_message


def test_translate_broadcast_denamespaces_task_id():
    msg = {"type": "task_status", "task_id": "wfA:slab_opt", "status": "RUNNING"}
    out = translate_broadcast_message(msg, workflow_id="wfA")
    assert out["type"] == "step_status"
    assert out["step_id"] == "slab_opt"  # node id, not namespaced
```

(If `translate_broadcast_message`'s signature lacks `workflow_id`, this step adds it — see implementation.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_v1_monitor_denamespace.py -p no:cacheprovider -q`
Expected: FAIL — `step_id` is `"wfA:slab_opt"` (or `TypeError` for the new `workflow_id` arg).

- [ ] **Step 3: Write minimal implementation**

`v1_monitor.py` — import the helper and de-namespace in `translate_broadcast_message` (lines 119, 127). Thread `workflow_id` from the caller (the monitor is per-workflow). Replace `"step_id": msg.get("task_id", "")` with:

```python
from catgo.workflow.task_ids import node_id_from_task_id

def translate_broadcast_message(msg: dict, workflow_id: str | None = None) -> dict:
    ...
    step_id = node_id_from_task_id(msg.get("task_id", ""), workflow_id)
    return {"type": "step_status", "step_id": step_id, ...}
```

`v1_monitor.py:99` (`build_initial_state`) — it iterates task dicts `t`; emit the node id:

```python
        steps.append({"id": t.get("node_id") or t["id"], ...})
```

`scanner.py:1037` (`update_v1_step`) — it has the task dict `t`; key the V1 mirror by node id:

```python
            for t in tasks:
                v1_status = _V2_TO_V1_STATUS.get(t["status"], "pending")
                update_v1_step(workflow_id, t.get("node_id") or t["id"], {...})
```

Find every caller of `translate_broadcast_message` (grep `translate_broadcast_message(`) and pass the connection's `workflow_id`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_v1_monitor_denamespace.py -p no:cacheprovider -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/engine/scanner.py server/catgo/workflow/engine/v1_monitor.py server/tests/test_v1_monitor_denamespace.py
git commit -m "fix(workflow): V1 step sync + monitor translate namespaced ids to node ids (#227)"
```

---

## Task 8: engine task API exposes node_id

**Files:**
- Modify: `server/catgo/routers/workflow_engine_tasks.py` (`get_task` 81-90)
- Test: `server/tests/test_engine_tasks_api_node_id.py` (new) — uses the TestClient `client` fixture from `conftest.py`

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_engine_tasks_api_node_id.py
"""Issue #227: the engine task endpoint exposes node_id so the frontend can map
namespaced task ids back to graph nodes."""
import json


def test_get_task_returns_node_id(client):
    # Create a workflow + task via the engine, then fetch it.
    from main import app  # noqa: F401 — ensures app/engine import side effects
    # Use the engine DB directly through the running app's dependency if available;
    # otherwise drive via the public convert + get_task endpoints.
    from catgo.workflow.graph_converter import convert_graph_json
    from catgo.routers.workflow_engine import _db  # the engine WorkflowDB instance
    convert_graph_json(_db, "RPBE", json.dumps({
        "nodes": [{"id": "slab_opt", "type": "geo_opt", "params": {}}], "edges": []
    }), workflow_id="wfApi")

    r = client.get("/api/engine/tasks/wfApi:slab_opt")
    assert r.status_code == 200
    body = r.json()
    assert body["task"]["node_id"] == "slab_opt"
```

(Adapt the engine-db accessor to the actual symbol exported by `workflow_engine.py` — e.g. a module-level `_db` set via `set_db`. If no such accessor exists, replace the setup with two HTTP calls: POST the graph through the public create endpoint, then GET the task.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_engine_tasks_api_node_id.py -p no:cacheprovider -q`
Expected: FAIL — `KeyError: 'node_id'` or assertion error (response task has no `node_id`).

- [ ] **Step 3: Write minimal implementation**

In `workflow_engine_tasks.py` `get_task` (81-90), the `task` dict from `db.get_task` already contains `node_id` (SELECT *). Ensure the response includes it explicitly and back-compat for legacy rows:

```python
@router.get("/tasks/{task_id}")
def get_task(task_id: str):
    task = db.get_task(task_id)
    task.setdefault("node_id", task["id"])
    parents = db.get_task_parents(task_id)
    children = db.get_task_children(task_id)
    return {"task": task, "parents": parents, "children": children}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_engine_tasks_api_node_id.py -p no:cacheprovider -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/catgo/routers/workflow_engine_tasks.py server/tests/test_engine_tasks_api_node_id.py
git commit -m "feat(workflow): expose node_id on engine task API (#227)"
```

---

## Task 9: MCP result/status tools accept workflow_id + node_id

**Files:**
- Modify: `server/catgo/workflow/mcp_tools.py:111` (and any sibling tool keyed by `task_id`)
- Test: `server/tests/test_mcp_tools_node_id.py` (new)

> **Why:** the workflow-*creation* MCP tools submit graph_json (node ids) and are unaffected. The *result/status* MCP tools key by `task_id` (`mcp_tools.py:111 db.get_result(params["task_id"])`). With namespacing, a caller passing the bare node id `slab_opt` would miss. Accept `workflow_id` + `node_id` and namespace internally, while still accepting an already-namespaced `task_id` for back-compat.

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_mcp_tools_node_id.py
import json, os, tempfile
from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json


def _db():
    fd, p = tempfile.mkstemp(suffix=".db"); os.close(fd); return WorkflowDB(p), p


def test_mcp_get_result_by_workflow_and_node_id():
    from catgo.workflow.mcp_tools import get_task_result_tool  # adapt to real symbol
    db, p = _db()
    try:
        convert_graph_json(db, "RPBE", json.dumps({
            "nodes": [{"id": "slab_opt", "type": "geo_opt", "params": {}}], "edges": []
        }), workflow_id="wfA")
        db.store_result("wfA:slab_opt", "wfA", energy=-7.0)
        out = get_task_result_tool(db, {"workflow_id": "wfA", "node_id": "slab_opt"})
        assert out["energy"] == -7.0
    finally:
        os.unlink(p)
```

(Adapt `get_task_result_tool`/param names to the actual function in `mcp_tools.py`. Inspect the file first to match its signature and dispatch style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_mcp_tools_node_id.py -p no:cacheprovider -q`
Expected: FAIL — the tool looks up `params["task_id"]` and can't resolve `workflow_id`+`node_id`.

- [ ] **Step 3: Write minimal implementation**

In `mcp_tools.py`, resolve the task id from either an explicit `task_id` or `workflow_id`+`node_id`:

```python
from catgo.workflow.task_ids import make_task_id

def _resolve_task_id(params: dict) -> str:
    if params.get("task_id"):
        return params["task_id"]
    wf = params.get("workflow_id"); node = params.get("node_id")
    if wf and node:
        return make_task_id(wf, node)
    raise ValueError("provide task_id, or workflow_id + node_id")

# at line 111 and any sibling tool:
    result = db.get_result(_resolve_task_id(params))
```

Update the MCP tool's input schema/docstring to document the `workflow_id`+`node_id` form.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_mcp_tools_node_id.py -p no:cacheprovider -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/mcp_tools.py server/tests/test_mcp_tools_node_id.py
git commit -m "feat(workflow): MCP result/status tools accept workflow_id+node_id (#227)"
```

---

## Task 10: Frontend — type + four must-change sites

**Files:**
- Modify: `src/lib/api/workflow-v2.ts:22-38` (`V2Task`); `src/lib/workflow/NodeStatusPanel.svelte:174,796`; `src/lib/workflow/WorkflowEditor.svelte:945`; `src/lib/workflow/workflow-execution.svelte.ts:601`

> Frontend has no unit-test harness for these flows; verify via type-check + a manual run (Task 11). Keep edits minimal and mechanical.

- [ ] **Step 1: Add `node_id` to the V2 task type**

`src/lib/api/workflow-v2.ts` `interface V2Task` (22-38):

```ts
export interface V2Task {
  id: string
  workflow_id: string
  node_id?: string   // graph node id (id is namespaced {workflow_id}:{node_id})
  task_type: string
  status: string
  // …existing fields…
}
```

- [ ] **Step 2: Build a node_id→task_id map and stop using node_id as a task id**

`src/lib/workflow/NodeStatusPanel.svelte` — the component receives `engine_task` (the V2 task object from the DAG). Use its real id instead of `node_id`:

Line 170-176:
```ts
  const task_ref = $derived<TaskRef>(
    mode === 'task' && task_id
      ? { mode: 'task', task_id }
      : engine_task
        ? { mode: 'task', task_id: engine_task.id }   // was: node_id
        : { mode: 'step', workflow_id, node_id }
  )
```

Line 796 — fetch by the engine task's real id (fall back to a node→task lookup if only node_id is known):
```ts
        const data = await get_v2_task(engine_task?.id ?? `${workflow_id}:${node_id}`)
```

- [ ] **Step 3: Fix WorkflowEditor result fetch**

`src/lib/workflow/WorkflowEditor.svelte:945` — construct the namespaced id:
```ts
          const resp = await fetch(
            `${API_BASE}/engine/tasks/${encodeURIComponent(`${workflow_id}:${node_id}`)}/result`
          )
```
(`workflow_id` is in scope in this handler; confirm the variable name and use it.)

- [ ] **Step 4: Fix workflow-execution result polling**

`src/lib/workflow/workflow-execution.svelte.ts:601` — `task_id` here is the V1 step/node id; namespace it for the engine endpoint:
```ts
      const resp = await fetch(
        `${API_BASE}/engine/tasks/${encodeURIComponent(`${workflow_id}:${task_id}`)}/result`
      )
```
(Confirm `workflow_id` is in scope in `setup_result_polling`; it is passed alongside `step_id` per the agent report. If the V1 result endpoint suffices here, prefer routing to `/api/workflow/{workflow_id}/steps/{task_id}/result` instead — pick whichever already returns the needed shape.)

- [ ] **Step 5: Type-check + commit**

Run: `pnpm exec svelte-check --threshold error` (or the repo's configured check; if RTK serves stale output use `rtk proxy pnpm exec svelte-check`).
Expected: no new type errors in the edited files.

```bash
git add src/lib/api/workflow-v2.ts src/lib/workflow/NodeStatusPanel.svelte src/lib/workflow/WorkflowEditor.svelte src/lib/workflow/workflow-execution.svelte.ts
git commit -m "fix(ui): send namespaced engine task ids; map via node_id (#227)"
```

---

## Task 11: Verify — DAG WS parity, regression suite, live migration, manual run

**Files:** none (verification only)

- [ ] **Step 1: Verify the V2 DAG WebSocket parity (no code change expected)**

Confirm the V2 monitor WS (`/v2/workflows/{id}/monitor`, consumed by `WorkflowDAGViewer.svelte:168` `tasks.findIndex(t => t.id === task_id)`) emits the **namespaced** `task_id` (matching `/dag` `task.id`). Grep `server/catgo/workflow/engine/scanner.py` broadcasts and the V2 monitor route: the broadcast uses `task["id"]` (namespaced) and the V2 monitor passes it raw (no v1_monitor translation). If true, `:168` is already correct — note it in the commit message. If the V2 monitor translates through v1_monitor, add a `node_id` field to the WS payload and match on it.

- [ ] **Step 2: Run the targeted regression suite**

Run:
```bash
cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest -p no:cacheprovider -q \
  tests/test_task_id_namespacing.py \
  tests/test_run_workflow_reconcile.py \
  tests/test_v1_monitor_denamespace.py \
  tests/test_engine_tasks_api_node_id.py \
  tests/test_mcp_tools_node_id.py \
  tests/test_engine_merge.py \
  tests/test_graph_converter_ids.py \
  tests/test_active_db_persistence.py \
  tests/test_tool_api.py
```
Expected: all pass.

- [ ] **Step 3: Back up + migrate the live engine DB**

```bash
cp ~/.catgo/catgo.db ~/.catgo/catgo.db.bak-pre-namespacing
```
Restart the backend so `_migrate_db` adds + back-fills `node_id`:
```bash
# stop the current backend (graceful), then:
cd /home/james0001/project/catgo-LRG && /home/james0001/miniforge3/envs/catgo/bin/python server/main.py
```
Verify the column + back-fill (read-only):
```bash
/home/james0001/miniforge3/envs/catgo/bin/python -c "import sqlite3,os; c=sqlite3.connect(os.path.expanduser('~/.catgo/catgo.db')); print([r[1] for r in c.execute('PRAGMA table_info(tasks)')]); print(c.execute('SELECT count(*) FROM tasks WHERE node_id IS NULL').fetchone())"
```
Expected: `node_id` present; `0` NULL node_ids.

- [ ] **Step 4: Manual end-to-end check (two same-template workflows)**

Create/convert the two ORR workflows (RPBE + RPBE-D3) via the editor or MCP, give one a completed `slab_opt`, then run the other. Confirm via the engine API that neither loses tasks:
```bash
/home/james0001/miniforge3/envs/catgo/bin/python -c "import sqlite3,os; c=sqlite3.connect(os.path.expanduser('~/.catgo/catgo.db')); print([(r[0][:18], r[1]) for r in c.execute(\"SELECT workflow_id, count(*) FROM tasks GROUP BY workflow_id\")])"
```
Expected: both workflows retain their full task counts; no cross-workflow clobber.

- [ ] **Step 5: Final commit / PR**

Use `superpowers:finishing-a-development-branch`. PR base `fix/workflow-db-active-path-persistence` (stacked) or `main` if #231/#228 already merged. Reference: `Closes #227`.

---

## Self-Review

**Spec coverage:** Root cause (global PK collision) → Tasks 1-3 (namespaced unique ids + node_id column + converter). Path stability → Task 4. V1 bridge (recreate/retry/reconcile, v1_compat, scanner, v1_monitor) → Tasks 5-7. API exposure → Task 8. MCP (user's question) → Task 9. Frontend → Task 10. Migration + verification → Task 11. ✓

**Placeholder scan:** Test/impl code blocks are concrete. Three sites are explicitly flagged "adapt to the real symbol" (engine-db accessor in Task 8, `mcp_tools` symbol in Task 9, `translate_broadcast_message` signature in Task 7) because the agents quoted call sites but not the exact private symbol names — the implementer must open the file and match. These are bounded "confirm the local name" notes, not behavioral TBDs.

**Type/name consistency:** `make_task_id`/`node_id_from_task_id` (Task 1) used identically in Tasks 3, 5, 9. `node_id` column name consistent across schema, methods, API, frontend type. `task["node_id"] or task["id"]` fallback used uniformly for legacy rows.

**Known residual:** Conditions added via graph_json are not namespaced (graph path never sets `condition_json` today — Task 4/agent §4). If conditional edges are added to the graph builder later, namespace `condition_json.source_task_id` there too.

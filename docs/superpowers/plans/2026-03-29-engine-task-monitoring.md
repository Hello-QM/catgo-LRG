# Engine Task Monitoring — Implementation Plan

**Date:** 2026-03-29
**Branch:** `split-files`
**Goal:** Give engine tasks the same monitoring capabilities as V1 workflow nodes (convergence plots, file browser, structure preview, frequency analysis, file editing).

## Architecture

Add 5 backend endpoints to the existing `server/routers/workflow_engine_tasks.py` router. Each endpoint looks up the task's `work_dir` and `hpc_session_id` from DB, gets the HPC connection from the pool, and calls existing parser utilities. Then add matching frontend API functions in `src/lib/api/workflow-v2.ts` and enhance `src/lib/workflow/TaskDetailPanel.svelte` to use existing reusable components (ConvergencePlot, StepFileTree).

**No code duplication from NodeStatusPanel.** We reuse:
- `parse_vasp_convergence()` from `server/utils/job_parser.py`
- `parse_vasp_frequencies()` from `server/utils/vasp_freq_parser.py`
- `read_remote_file()` / `write_remote_file()` from `server/utils/job_parser.py`
- `list_remote_dir()` from `SSHFileOpsMixin` on HPC connections
- `detect_calc_type()` from `server/utils/job_parser.py`
- `ConvergencePlot.svelte` from `src/lib/workflow/`
- `StepFileTree.svelte` from `src/lib/workflow/`

---

## Task 1 — Backend helper: resolve task HPC connection (~3 min)

**File:** `server/routers/workflow_engine_tasks.py`

Add a helper that takes a task_id, looks up the task row, validates `work_dir` and `hpc_session_id`, and returns `(task_dict, hpc_connection)`. This avoids repeating the lookup in every new endpoint.

### Code

Add after the existing `_get_db()` helper (line 31):

```python
def _get_task_hpc(task_id: str):
    """Look up task and its HPC connection. Raises HTTPException on failure."""
    db = _get_db()
    try:
        task = db.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")

    work_dir = task.get("work_dir")
    if not work_dir:
        raise HTTPException(404, f"Task {task_id} has no work_dir")

    session_id = task.get("hpc_session_id")
    if not session_id:
        raise HTTPException(404, f"Task {task_id} has no HPC session")

    from utils.hpc_client import pool
    hpc = pool.get_connection(session_id)
    if not hpc:
        raise HTTPException(404, f"HPC session {session_id} not found or expired")

    return task, hpc
```

Add the new import at the top of the file:

```python
from fastapi import APIRouter, HTTPException, Query
```

(`Query` is needed for later endpoints.)

### Commit
```
feat(engine-tasks): add _get_task_hpc helper for HPC connection lookup
```

---

## Task 2 — Backend: GET files endpoint (~5 min)

**File:** `server/routers/workflow_engine_tasks.py`

List files in a task's `work_dir` on HPC. Supports `subdir` query param to browse subdirectories.

### Code

```python
@router.get("/{task_id}/files")
async def get_task_files(task_id: str, subdir: str = Query("", description="Subdirectory relative to work_dir")):
    """List files in the task's work_dir on HPC."""
    task, hpc = _get_task_hpc(task_id)
    work_dir = task["work_dir"]

    target = f"{work_dir}/{subdir}" if subdir else work_dir

    try:
        resolved, files = await hpc.list_remote_dir(target)
        return {
            "work_dir": work_dir,
            "resolved_path": resolved,
            "subdir": subdir,
            "files": [
                {
                    "name": f.name,
                    "path": f.path,
                    "is_dir": f.is_dir,
                    "size_bytes": f.size_bytes,
                    "modified_time": f.modified_time,
                }
                for f in files
            ],
        }
    except Exception as exc:
        raise HTTPException(500, f"Failed to list files: {exc}")
```

### Test — `server/tests/test_engine_task_monitoring.py`

```python
"""Tests for engine task monitoring endpoints (files, convergence, file-content, frequencies)."""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers.workflow_engine_tasks import router, set_db


def _make_app():
    app = FastAPI()
    app.include_router(router)
    return app


class FakeDB:
    def __init__(self, tasks=None):
        self._tasks = tasks or {}

    def get_task(self, task_id):
        if task_id not in self._tasks:
            raise KeyError(f"Task {task_id} not found")
        return self._tasks[task_id]

    def get_task_parents(self, task_id):
        return []

    def get_task_children(self, task_id):
        return []


SAMPLE_TASK = {
    "id": "t1",
    "workflow_id": "w1",
    "task_type": "vasp_relax",
    "status": "RUNNING",
    "work_dir": "/scratch/user/calc_001",
    "hpc_session_id": "sess1",
    "params_json": "{}",
}


class TestGetTaskFiles:
    def test_files_listed(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_file = MagicMock()
        mock_file.name = "INCAR"
        mock_file.path = "/scratch/user/calc_001/INCAR"
        mock_file.is_dir = False
        mock_file.size_bytes = 1024
        mock_file.modified_time = "1711700000"

        mock_hpc = AsyncMock()
        mock_hpc.list_remote_dir = AsyncMock(return_value=("/scratch/user/calc_001", [mock_file]))

        with patch("routers.workflow_engine_tasks.pool") as mock_pool:
            mock_pool.get_connection.return_value = mock_hpc
            # Need to also patch the import inside _get_task_hpc
            with patch.dict("sys.modules", {"utils.hpc_client": MagicMock(pool=mock_pool)}):
                client = TestClient(_make_app())
                resp = client.get("/api/engine/tasks/t1/files")

        assert resp.status_code == 200
        data = resp.json()
        assert data["work_dir"] == "/scratch/user/calc_001"
        assert len(data["files"]) == 1
        assert data["files"][0]["name"] == "INCAR"

    def test_no_work_dir(self):
        task_no_dir = {**SAMPLE_TASK, "work_dir": None}
        db = FakeDB(tasks={"t1": task_no_dir})
        set_db(db)
        client = TestClient(_make_app())
        resp = client.get("/api/engine/tasks/t1/files")
        assert resp.status_code == 404

    def test_task_not_found(self):
        db = FakeDB(tasks={})
        set_db(db)
        client = TestClient(_make_app())
        resp = client.get("/api/engine/tasks/t1/files")
        assert resp.status_code == 404
```

### Commit
```
feat(engine-tasks): add GET files endpoint with tests
```

---

## Task 3 — Backend: GET convergence endpoint (~4 min)

**File:** `server/routers/workflow_engine_tasks.py`

Parse OSZICAR/OUTCAR for convergence data. Reuses `parse_vasp_convergence` and `detect_calc_type` from `utils/job_parser.py`.

### Code

```python
@router.get("/{task_id}/convergence")
async def get_task_convergence(task_id: str):
    """Parse convergence data from the task's OSZICAR/OUTCAR."""
    task, hpc = _get_task_hpc(task_id)
    work_dir = task["work_dir"]

    try:
        from utils.job_parser import detect_calc_type, parse_vasp_convergence
        from models.hpc import CalcSoftware

        software, _ = await detect_calc_type(hpc.conn, work_dir)
        if software == CalcSoftware.VASP:
            data = await parse_vasp_convergence(hpc.conn, work_dir)
            return data.model_dump()
        return {"success": False, "points": [], "converged": False,
                "message": f"Convergence not yet supported for {software.value}"}
    except Exception as exc:
        return {"success": False, "points": [], "converged": False,
                "message": str(exc)}
```

### Test — append to `server/tests/test_engine_task_monitoring.py`

```python
class TestGetTaskConvergence:
    def test_vasp_convergence(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_conv = MagicMock()
        mock_conv.model_dump.return_value = {
            "success": True,
            "points": [{"step": 1, "energy": -10.5, "energy_sigma0": -10.4,
                         "max_force": 0.05, "rms_force": 0.02}],
            "converged": False,
            "message": "",
        }

        mock_hpc = MagicMock()
        mock_hpc.conn = AsyncMock()

        with patch("routers.workflow_engine_tasks.pool") as mock_pool, \
             patch.dict("sys.modules", {"utils.hpc_client": MagicMock(pool=mock_pool)}), \
             patch("utils.job_parser.detect_calc_type", new_callable=AsyncMock) as mock_detect, \
             patch("utils.job_parser.parse_vasp_convergence", new_callable=AsyncMock) as mock_parse:
            mock_pool.get_connection.return_value = mock_hpc
            from models.hpc import CalcSoftware
            mock_detect.return_value = (CalcSoftware.VASP, None)
            mock_parse.return_value = mock_conv

            client = TestClient(_make_app())
            resp = client.get("/api/engine/tasks/t1/convergence")

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert len(data["points"]) == 1
```

### Commit
```
feat(engine-tasks): add GET convergence endpoint with tests
```

---

## Task 4 — Backend: GET/PUT file-content endpoints (~5 min)

**File:** `server/routers/workflow_engine_tasks.py`

Read and write individual files in the task's work_dir. Reuses `read_remote_file` and `write_remote_file` from `utils/job_parser.py`.

### Code

```python
@router.get("/{task_id}/file-content")
async def get_task_file_content(task_id: str, path: str = Query(..., description="Relative path within work_dir")):
    """Read a file from the task's work_dir."""
    task, hpc = _get_task_hpc(task_id)
    work_dir = task["work_dir"]

    # Security: prevent path traversal
    if ".." in path or path.startswith("/"):
        raise HTTPException(400, "Path must be relative and cannot contain '..'")

    full_path = f"{work_dir}/{path}"
    try:
        from utils.hpc_client import LocalFileConnection
        if isinstance(hpc, LocalFileConnection):
            content, total = await hpc.read_file_content(full_path)
        else:
            from utils.job_parser import read_remote_file
            content, total = await read_remote_file(hpc.conn, full_path)
        return {"path": path, "content": content, "total_lines": total}
    except Exception as exc:
        raise HTTPException(500, f"Failed to read file: {exc}")


class FileWriteBody(BaseModel):
    path: str
    content: str


@router.put("/{task_id}/file-content")
async def put_task_file_content(task_id: str, body: FileWriteBody):
    """Write a file to the task's work_dir."""
    task, hpc = _get_task_hpc(task_id)
    work_dir = task["work_dir"]

    if ".." in body.path or body.path.startswith("/"):
        raise HTTPException(400, "Path must be relative and cannot contain '..'")

    full_path = f"{work_dir}/{body.path}"
    try:
        from utils.hpc_client import LocalFileConnection
        if isinstance(hpc, LocalFileConnection):
            from pathlib import PurePosixPath
            resolved = hpc._resolve_local_path(full_path)
            Path(resolved).write_text(body.content, encoding="utf-8")
            ok = True
        else:
            from utils.job_parser import write_remote_file
            ok = await write_remote_file(hpc.conn, full_path, body.content)
        if not ok:
            raise HTTPException(500, "Write returned failure")
        return {"path": body.path, "success": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Failed to write file: {exc}")
```

### Test — append to `server/tests/test_engine_task_monitoring.py`

```python
class TestGetTaskFileContent:
    def test_read_file(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_hpc = MagicMock()
        mock_hpc.conn = AsyncMock()
        # Not a LocalFileConnection
        mock_hpc.__class__ = type("HPCConnection", (), {})

        with patch("routers.workflow_engine_tasks.pool") as mock_pool, \
             patch.dict("sys.modules", {"utils.hpc_client": MagicMock(pool=mock_pool, LocalFileConnection=type("LC", (), {}))}), \
             patch("utils.job_parser.read_remote_file", new_callable=AsyncMock) as mock_read:
            mock_pool.get_connection.return_value = mock_hpc
            mock_read.return_value = ("SYSTEM = test\nENCUT = 400\n", 2)

            client = TestClient(_make_app())
            resp = client.get("/api/engine/tasks/t1/file-content?path=INCAR")

        assert resp.status_code == 200
        data = resp.json()
        assert "ENCUT" in data["content"]
        assert data["total_lines"] == 2

    def test_path_traversal_blocked(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_hpc = MagicMock()
        with patch("routers.workflow_engine_tasks.pool") as mock_pool, \
             patch.dict("sys.modules", {"utils.hpc_client": MagicMock(pool=mock_pool)}):
            mock_pool.get_connection.return_value = mock_hpc
            client = TestClient(_make_app())
            resp = client.get("/api/engine/tasks/t1/file-content?path=../../etc/passwd")
        assert resp.status_code == 400


class TestPutTaskFileContent:
    def test_write_file(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_hpc = MagicMock()
        mock_hpc.conn = AsyncMock()
        mock_hpc.__class__ = type("HPCConnection", (), {})

        with patch("routers.workflow_engine_tasks.pool") as mock_pool, \
             patch.dict("sys.modules", {"utils.hpc_client": MagicMock(pool=mock_pool, LocalFileConnection=type("LC", (), {}))}), \
             patch("utils.job_parser.write_remote_file", new_callable=AsyncMock) as mock_write:
            mock_pool.get_connection.return_value = mock_hpc
            mock_write.return_value = True

            client = TestClient(_make_app())
            resp = client.put(
                "/api/engine/tasks/t1/file-content",
                json={"path": "INCAR", "content": "SYSTEM = new\nENCUT = 500\n"},
            )

        assert resp.status_code == 200
        assert resp.json()["success"] is True
```

### Commit
```
feat(engine-tasks): add GET/PUT file-content endpoints with tests
```

---

## Task 5 — Backend: GET frequencies endpoint (~4 min)

**File:** `server/routers/workflow_engine_tasks.py`

Parse vibrational frequencies from OUTCAR. Reuses `parse_vasp_frequencies` from `utils/vasp_freq_parser.py`.

### Code

```python
@router.get("/{task_id}/frequencies")
async def get_task_frequencies(task_id: str):
    """Parse vibrational frequencies from task's OUTCAR."""
    task, hpc = _get_task_hpc(task_id)
    work_dir = task["work_dir"]

    try:
        from utils.vasp_freq_parser import parse_vasp_frequencies
        data = await parse_vasp_frequencies(hpc.conn, work_dir)
        return data
    except Exception as exc:
        return {"success": False, "message": str(exc)}
```

### Test — append to `server/tests/test_engine_task_monitoring.py`

```python
class TestGetTaskFrequencies:
    def test_frequencies(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_hpc = MagicMock()
        mock_hpc.conn = AsyncMock()

        freq_result = {
            "success": True,
            "real_freqs": [100.0, 200.0, 300.0],
            "imag_freqs": [-50.0],
            "num_imaginary": 1,
            "total_atoms": 3,
            "message": "",
        }

        with patch("routers.workflow_engine_tasks.pool") as mock_pool, \
             patch.dict("sys.modules", {"utils.hpc_client": MagicMock(pool=mock_pool)}), \
             patch("utils.vasp_freq_parser.parse_vasp_frequencies", new_callable=AsyncMock) as mock_parse:
            mock_pool.get_connection.return_value = mock_hpc
            mock_parse.return_value = freq_result

            client = TestClient(_make_app())
            resp = client.get("/api/engine/tasks/t1/frequencies")

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert len(data["real_freqs"]) == 3
        assert data["num_imaginary"] == 1
```

### Commit
```
feat(engine-tasks): add GET frequencies endpoint with tests
```

---

## Task 6 — Frontend API functions (~3 min)

**File:** `src/lib/api/workflow-v2.ts`

Add 5 API functions matching the new backend endpoints.

### Code

Append after the existing `get_v2_task_provenance` function (line 119):

```typescript
// --- Task Monitoring ---

export interface TaskFileEntry {
  name: string
  path: string
  is_dir: boolean
  size_bytes: number
  modified_time: string
}

export interface TaskFilesResponse {
  work_dir: string
  resolved_path: string
  subdir: string
  files: TaskFileEntry[]
}

export interface ConvergencePoint {
  step: number
  energy: number
  energy_sigma0: number
  max_force: number
  rms_force: number
}

export interface TaskConvergenceResponse {
  success: boolean
  points: ConvergencePoint[]
  converged: boolean
  message: string
}

export interface TaskFileContentResponse {
  path: string
  content: string
  total_lines: number
}

export async function get_engine_task_files(task_id: string, subdir = ''): Promise<TaskFilesResponse> {
  const params = subdir ? `?subdir=${encodeURIComponent(subdir)}` : ''
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/files${params}`))
}

export async function get_engine_task_convergence(task_id: string): Promise<TaskConvergenceResponse> {
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/convergence`))
}

export async function get_engine_task_file_content(task_id: string, path: string): Promise<TaskFileContentResponse> {
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/file-content?path=${encodeURIComponent(path)}`))
}

export async function put_engine_task_file_content(task_id: string, path: string, content: string): Promise<{ path: string; success: boolean }> {
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/file-content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  }))
}

export async function get_engine_task_frequencies(task_id: string): Promise<Record<string, unknown>> {
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/frequencies`))
}
```

### Commit
```
feat(workflow-v2): add frontend API functions for task monitoring
```

---

## Task 7 — TaskDetailPanel: add tab navigation + convergence tab (~5 min)

**File:** `src/lib/workflow/TaskDetailPanel.svelte`

Replace the flat panel with a tab-based layout: **Info** (existing content), **Convergence**, **Files**, **Frequencies**. Start with the Convergence tab.

### Code

Add to the `<script>` block — new imports and state:

```typescript
import ConvergencePlot from './ConvergencePlot.svelte'
import type { ConvergencePoint } from '$lib/api/workflow-v2'
import { get_engine_task_convergence } from '$lib/api/workflow-v2'

type TabId = 'info' | 'convergence' | 'files' | 'frequencies'
let active_tab = $state<TabId>('info')

// Convergence state
let conv_points = $state<ConvergencePoint[]>([])
let conv_converged = $state(false)
let conv_loading = $state(false)
let conv_error = $state('')

async function load_convergence() {
  if (!task_id || !task?.work_dir) return
  conv_loading = true
  conv_error = ''
  try {
    const data = await get_engine_task_convergence(task_id)
    if (data.success) {
      conv_points = data.points
      conv_converged = data.converged
    } else {
      conv_error = data.message || 'No convergence data'
    }
  } catch (e: any) {
    conv_error = e.message
  } finally {
    conv_loading = false
  }
}
```

In the template, after the `<div class="panel-header">` block, add the tab bar:

```svelte
{#if task}
  <div class="tab-bar">
    <button class="tab" class:active={active_tab === 'info'} onclick={() => active_tab = 'info'}>Info</button>
    <button class="tab" class:active={active_tab === 'convergence'} onclick={() => { active_tab = 'convergence'; load_convergence() }}>Convergence</button>
    <button class="tab" class:active={active_tab === 'files'} onclick={() => { active_tab = 'files' }}>Files</button>
    <button class="tab" class:active={active_tab === 'frequencies'} onclick={() => { active_tab = 'frequencies' }}>Freq</button>
  </div>
{/if}
```

Wrap existing Info content in `{#if active_tab === 'info'}...{/if}` and add the convergence tab:

```svelte
{#if active_tab === 'convergence'}
  <div class="section">
    {#if conv_loading}
      <div class="hint">Loading convergence data...</div>
    {:else if conv_error}
      <div class="hint">{conv_error}</div>
    {:else if conv_points.length > 0}
      <ConvergencePlot points={conv_points} is_orca={false} running={task.status === 'RUNNING'} />
      {#if conv_converged}
        <div class="field" style="color:#22c55e"><span class="label">Status</span> <span>Converged</span></div>
      {/if}
      <button class="sm-btn" onclick={load_convergence}>Refresh</button>
    {:else}
      <div class="hint">No convergence data yet. Task may not have started writing OSZICAR.</div>
    {/if}
  </div>
{/if}
```

Add tab bar styles:

```css
.tab-bar { display: flex; border-bottom: 1px solid var(--border-color, #333); }
.tab { flex: 1; padding: 6px 4px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-color-dim, #888); cursor: pointer; font-size: 11px; font-weight: 500; transition: color 0.15s, border-color 0.15s; }
.tab:hover { color: var(--text-color, #e5e5e5); }
.tab.active { color: var(--accent-color, #3b82f6); border-bottom-color: var(--accent-color, #3b82f6); }
```

### Commit
```
feat(task-panel): add tab navigation and convergence plot
```

---

## Task 8 — TaskDetailPanel: add Files tab (~5 min)

**File:** `src/lib/workflow/TaskDetailPanel.svelte`

Add file browser in the Files tab. This is a lightweight inline version (not the full StepFileTree, which is wired to V1 API). We use the new engine task file APIs directly.

### Code

Add to `<script>`:

```typescript
import {
  get_engine_task_files, get_engine_task_file_content, put_engine_task_file_content,
  type TaskFileEntry,
} from '$lib/api/workflow-v2'

// Files state
let files = $state<TaskFileEntry[]>([])
let files_subdir = $state('')
let files_loading = $state(false)
let files_error = $state('')
let viewing_file = $state<{ path: string; content: string } | null>(null)
let editing_file = $state(false)
let file_edit_content = $state('')
let file_saving = $state(false)

async function load_files(subdir = '') {
  if (!task_id) return
  files_loading = true
  files_error = ''
  try {
    const data = await get_engine_task_files(task_id, subdir)
    files = data.files
    files_subdir = subdir
  } catch (e: any) {
    files_error = e.message
  } finally {
    files_loading = false
  }
}

async function view_file(filename: string) {
  if (!task_id) return
  const rel_path = files_subdir ? `${files_subdir}/${filename}` : filename
  try {
    const data = await get_engine_task_file_content(task_id, rel_path)
    viewing_file = { path: rel_path, content: data.content }
    file_edit_content = data.content
    editing_file = false
  } catch (e: any) {
    error = e.message
  }
}

async function save_file() {
  if (!task_id || !viewing_file) return
  file_saving = true
  try {
    await put_engine_task_file_content(task_id, viewing_file.path, file_edit_content)
    viewing_file = { ...viewing_file, content: file_edit_content }
    editing_file = false
  } catch (e: any) {
    error = e.message
  } finally {
    file_saving = false
  }
}

function enter_dir(name: string) {
  const sub = files_subdir ? `${files_subdir}/${name}` : name
  load_files(sub)
}

function go_up() {
  const parts = files_subdir.split('/').filter(Boolean)
  parts.pop()
  load_files(parts.join('/'))
}

function format_size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
```

Add the Files tab template:

```svelte
{#if active_tab === 'files'}
  <div class="section">
    {#if viewing_file}
      <!-- File viewer/editor -->
      <div class="file-viewer-header">
        <button class="sm-btn" onclick={() => { viewing_file = null }}>Back</button>
        <span class="mono" style="font-size:11px; flex:1; overflow:hidden; text-overflow:ellipsis">{viewing_file.path}</span>
        {#if !editing_file}
          <button class="sm-btn" onclick={() => { editing_file = true }}>Edit</button>
        {/if}
      </div>
      {#if editing_file}
        <textarea bind:value={file_edit_content} rows={12} class="param-editor" style="min-height:200px"></textarea>
        <div class="btn-row">
          <button class="sm-btn save" onclick={save_file} disabled={file_saving}>
            {file_saving ? 'Saving...' : 'Save'}
          </button>
          <button class="sm-btn" onclick={() => { editing_file = false; file_edit_content = viewing_file?.content ?? '' }}>Cancel</button>
        </div>
      {:else}
        <pre class="params" style="max-height:400px; overflow:auto">{viewing_file.content}</pre>
      {/if}
    {:else}
      <!-- File listing -->
      {#if files_loading}
        <div class="hint">Loading files...</div>
      {:else if files_error}
        <div class="error">{files_error}</div>
      {:else}
        {#if files_subdir}
          <div class="file-nav">
            <button class="sm-btn" onclick={go_up}>.. (up)</button>
            <span class="mono" style="font-size:10px; color:var(--text-color-dim)">{files_subdir}</span>
          </div>
        {/if}
        {#if files.length === 0}
          <div class="hint">No files found. Task may not have started.</div>
        {:else}
          <div class="file-list">
            {#each files as f}
              <div class="file-row">
                {#if f.is_dir}
                  <button class="file-link dir" onclick={() => enter_dir(f.name)}>
                    {f.name}/
                  </button>
                {:else}
                  <button class="file-link" onclick={() => view_file(f.name)}>
                    {f.name}
                  </button>
                  <span class="file-size">{format_size(f.size_bytes)}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        <button class="sm-btn" style="margin-top:6px" onclick={() => load_files(files_subdir)}>Refresh</button>
      {/if}
    {/if}
  </div>
{/if}
```

Add file browser styles:

```css
.file-viewer-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.file-nav { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.file-list { display: flex; flex-direction: column; }
.file-row { display: flex; align-items: center; justify-content: space-between; padding: 2px 0; }
.file-link { background: none; border: none; color: var(--accent-color, #3b82f6); cursor: pointer; font-size: 12px; font-family: monospace; text-align: left; padding: 1px 0; }
.file-link:hover { text-decoration: underline; }
.file-link.dir { color: #eab308; }
.file-size { color: var(--text-color-dim); font-size: 10px; font-family: monospace; }
```

### Commit
```
feat(task-panel): add file browser tab with view/edit
```

---

## Task 9 — TaskDetailPanel: add Frequencies tab (~4 min)

**File:** `src/lib/workflow/TaskDetailPanel.svelte`

Show parsed vibrational frequencies from OUTCAR.

### Code

Add to `<script>`:

```typescript
import { get_engine_task_frequencies } from '$lib/api/workflow-v2'

// Frequencies state
let freq_data = $state<Record<string, any> | null>(null)
let freq_loading = $state(false)
let freq_error = $state('')

async function load_frequencies() {
  if (!task_id || !task?.work_dir) return
  freq_loading = true
  freq_error = ''
  try {
    const data = await get_engine_task_frequencies(task_id)
    if (data.success) {
      freq_data = data
    } else {
      freq_error = (data.message as string) || 'No frequency data'
    }
  } catch (e: any) {
    freq_error = e.message
  } finally {
    freq_loading = false
  }
}
```

Add template:

```svelte
{#if active_tab === 'frequencies'}
  <div class="section">
    {#if freq_loading}
      <div class="hint">Loading frequency data...</div>
    {:else if freq_error}
      <div class="hint">{freq_error}</div>
      <button class="sm-btn" onclick={load_frequencies}>Retry</button>
    {:else if freq_data}
      {#if (freq_data.num_imaginary ?? 0) > 0}
        <div class="field" style="color:#ef4444">
          <span class="label">Imaginary</span>
          <span>{freq_data.num_imaginary} mode(s)</span>
        </div>
        {#each (freq_data.imag_freqs ?? []) as f}
          <div class="field"><span class="label mono">{f.toFixed(1)}i cm-1</span></div>
        {/each}
      {:else}
        <div class="field" style="color:#22c55e">
          <span class="label">Status</span>
          <span>All real (true minimum)</span>
        </div>
      {/if}
      <div class="section-title" style="margin-top:8px">Real Frequencies (cm-1)</div>
      <div class="freq-table">
        {#each (freq_data.real_freqs ?? []) as f, i}
          <div class="field">
            <span class="label">#{i + 1}</span>
            <span class="mono">{f.toFixed(1)}</span>
          </div>
        {/each}
      </div>
      <button class="sm-btn" style="margin-top:6px" onclick={load_frequencies}>Refresh</button>
    {:else}
      <div class="hint">No frequency data. Click tab when a freq calculation is running.</div>
      <button class="sm-btn" onclick={load_frequencies}>Load</button>
    {/if}
  </div>
{/if}
```

Add style:

```css
.freq-table { max-height: 300px; overflow-y: auto; }
```

### Commit
```
feat(task-panel): add frequencies tab
```

---

## Task 10 — Wire tab loading to task changes + auto-refresh (~3 min)

**File:** `src/lib/workflow/TaskDetailPanel.svelte`

When `task_id` changes, reset tab to 'info'. When switching tabs, auto-load data. Add polling for convergence during RUNNING state.

### Code

Update the existing `$effect` that calls `load()`:

```typescript
$effect(() => {
  // Reset state when task_id changes
  active_tab = 'info'
  conv_points = []
  files = []
  freq_data = null
  viewing_file = null
  load()
})
```

Add a convergence auto-refresh effect:

```typescript
let conv_interval: ReturnType<typeof setInterval> | null = null

$effect(() => {
  // Auto-refresh convergence every 10s while task is RUNNING and convergence tab is active
  if (active_tab === 'convergence' && task?.status === 'RUNNING') {
    conv_interval = setInterval(load_convergence, 10_000)
  }
  return () => {
    if (conv_interval) { clearInterval(conv_interval); conv_interval = null }
  }
})
```

Wire the tab buttons to load data on click:

```svelte
<button class="tab" class:active={active_tab === 'files'} onclick={() => { active_tab = 'files'; if (files.length === 0) load_files() }}>Files</button>
<button class="tab" class:active={active_tab === 'frequencies'} onclick={() => { active_tab = 'frequencies'; if (!freq_data) load_frequencies() }}>Freq</button>
```

### Commit
```
feat(task-panel): auto-refresh convergence, lazy-load tabs on switch
```

---

## Summary

| Task | What | File(s) | ~Min |
|------|------|---------|------|
| 1 | `_get_task_hpc` helper | `workflow_engine_tasks.py` | 3 |
| 2 | GET files endpoint + tests | `workflow_engine_tasks.py`, `test_engine_task_monitoring.py` | 5 |
| 3 | GET convergence endpoint + tests | same | 4 |
| 4 | GET/PUT file-content endpoints + tests | same | 5 |
| 5 | GET frequencies endpoint + tests | same | 4 |
| 6 | Frontend API functions | `workflow-v2.ts` | 3 |
| 7 | Tab nav + Convergence tab | `TaskDetailPanel.svelte` | 5 |
| 8 | Files tab (browse/view/edit) | `TaskDetailPanel.svelte` | 5 |
| 9 | Frequencies tab | `TaskDetailPanel.svelte` | 4 |
| 10 | Auto-refresh + lazy loading | `TaskDetailPanel.svelte` | 3 |
| **Total** | | | **~41 min** |

## Out of Scope (future tasks)

- **Structure preview/edit** — opening the 3D Structure.svelte viewer from task panel (requires structure file parsing + viewer integration)
- **VASP parameter forms** — rendering proper INCAR/KPOINTS forms instead of JSON (requires schema mapping from node-defs)
- **ORCA convergence** — extending convergence parsing beyond VASP
- **Force vector visualization** — displaying per-atom force vectors in the 3D viewer

"""Tests for the V2-native MLP live-progress endpoint (#224 Phase 2).

Covers:
  GET /api/engine/tasks/{task_id}/mlp-progress

This endpoint mirrors the V1 ``GET /api/workflow/{wf}/mlp-progress/{step}`` shape
but resolves the task via ``WorkflowDB.get_task`` (V2 store) instead of the legacy
``workflow_steps`` table. The actual ASE opt.log/neb.log parsing is delegated to
the SAME V1 helper (``catgo.utils.job_parser.parse_ase_opt_log``) — this task is
additive and must not re-implement it. It also makes the frontend task-adapter's
``mode:'task'`` path real (it currently returns a placeholder message).

Temp DBs only — never ~/.catgo/catgo.db. The optimizer log is written to a real
temp dir so the (local-only) parser runs offline with no HPC connection.
"""

import os
import sys
import tempfile
from pathlib import Path

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from fastapi import FastAPI
from fastapi.testclient import TestClient

from catgo.workflow.db import WorkflowDB
import catgo.routers.workflow_engine_tasks as wet


# A minimal ASE BFGS opt.log. parse_ase_opt_log keys off the iteration lines.
_OPT_LOG = """      Step     Time          Energy         fmax
BFGS:    0 12:00:00     -10.000000        0.5000
BFGS:    1 12:00:01     -10.500000        0.2000
BFGS:    2 12:00:02     -10.700000        0.0080
"""


def _make_db_with_task(*, work_dir, task_type="geo_opt", params=None):
    """Build a temp WorkflowDB with a single MLP-capable task.

    Returns (db, db_path, workflow_id, task_id).
    """
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)

    workflow_id = db.create_workflow("v2-mlp-progress-wf")
    task_id = db.create_task(
        workflow_id, task_type, task_id=f"{workflow_id}:opt", params=params or {}
    )
    db.update_task(task_id, status="RUNNING")
    if work_dir is not None:
        db.update_task(task_id, work_dir=work_dir)
    return db, db_path, workflow_id, task_id


def _make_app(db: WorkflowDB) -> TestClient:
    wet.set_db(db)
    app = FastAPI()
    app.include_router(wet.router)
    return TestClient(app)


def test_mlp_progress_resolves_task_and_returns_shape():
    """Happy path: endpoint resolves task work_dir, parses opt.log, returns shape."""
    tmp = tempfile.mkdtemp(prefix="catgo-mlp-")
    (Path(tmp) / "opt.log").write_text(_OPT_LOG)
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=tmp, task_type="geo_opt", params={"fmax": 0.01}
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/mlp-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # Same shape the V1 endpoint + frontend NormalizedConvergence expect.
        assert set(("points", "converged", "message")) <= set(data.keys())
        assert len(data["points"]) == 3
        first = data["points"][0]
        for key in ("step", "energy", "dE", "energy_sigma0", "max_force", "rms_force"):
            assert key in first, f"missing point key: {key}"
        # Last fmax (0.008) is at/below the resolved target (0.01) → converged.
        assert data["converged"] is True
        assert data["points"][-1]["max_force"] == pytest.approx(0.008)
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_mlp_progress_unresolved_fmax_suppresses_converged():
    """No fmax in params → converged is nulled (mirrors V1 status-sync guard)."""
    tmp = tempfile.mkdtemp(prefix="catgo-mlp-")
    (Path(tmp) / "opt.log").write_text(_OPT_LOG)
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=tmp, task_type="geo_opt", params={}
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/mlp-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert len(data["points"]) == 3
        assert data["converged"] is None
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_mlp_progress_neb_picks_neb_log():
    """A ts_search/NEB task reads neb.log when present."""
    tmp = tempfile.mkdtemp(prefix="catgo-mlp-")
    (Path(tmp) / "neb.log").write_text(_OPT_LOG)
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=tmp, task_type="ts_search", params={"fmax": 0.05}
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/mlp-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert len(data["points"]) == 3
        assert data["converged"] is True
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_mlp_progress_no_log_clean_empty():
    """work_dir exists but no log yet → clean empty result, not a 500."""
    tmp = tempfile.mkdtemp(prefix="catgo-mlp-")  # empty dir
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=tmp, task_type="geo_opt", params={"fmax": 0.01}
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/mlp-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["points"] == []
        assert data["converged"] in (False, None)
        assert "message" in data
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_mlp_progress_hpc_session_not_wired():
    """HPC-remote MLP step returns the deferred message (mirrors V1), not a crash."""
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir="/scratch/run1", task_type="geo_opt", params={"fmax": 0.01}
    )
    db.update_task(task_id, hpc_session_id="sess-123")
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/mlp-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["points"] == []
        assert "HPC" in (data.get("message") or "")
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_mlp_progress_unknown_task_404():
    """Unknown task id returns a clean 404."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)
    try:
        client = _make_app(db)
        resp = client.get("/api/engine/tasks/does-not-exist/mlp-progress")
        assert resp.status_code == 404
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_mlp_progress_no_work_dir_clean_empty():
    """A task without a work_dir returns a clean empty result (no work dir yet)."""
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=None, task_type="geo_opt", params={"fmax": 0.01}
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/mlp-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["points"] == []
        assert "message" in data
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)

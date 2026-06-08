"""Tests for the V2-native per-ionic-step forces endpoint (#224 Phase 2).

Covers:
  GET /api/engine/tasks/{task_id}/forces

This endpoint mirrors the V1 ``GET /api/workflow/{wf}/forces/{step}`` shape but
resolves the task via ``WorkflowDB.get_task`` (V2 store) instead of the legacy
``workflow_steps`` table. The actual OUTCAR/vaspout.h5 parsing is delegated to
the SAME V1 helpers (``catgo.utils.job_parser.parse_vasp_forces`` /
``parse_vasp_forces_h5``) — this task is additive and must not re-implement them.

Temp DBs only — never ~/.catgo/catgo.db. The HPC connection + remote file parse
are mocked so the test runs offline with no fixture OUTCAR.
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


def _make_db_with_task(*, work_dir: str | None):
    """Build a temp WorkflowDB with a single geo_opt task.

    Returns (db, db_path, workflow_id, task_id).
    """
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)

    workflow_id = db.create_workflow("v2-forces-wf")
    task_id = db.create_task(workflow_id, "geo_opt", task_id=f"{workflow_id}:opt")
    db.update_task(task_id, status="COMPLETED")
    if work_dir is not None:
        db.update_task(task_id, work_dir=work_dir)
    return db, db_path, workflow_id, task_id


def _make_app(db: WorkflowDB) -> TestClient:
    wet.set_db(db)
    app = FastAPI()
    app.include_router(wet.router)
    return TestClient(app)


def test_forces_endpoint_resolves_task_and_returns_shape(monkeypatch):
    """Happy path: endpoint resolves the task, calls the V1 parser, returns shape."""
    db, db_path, workflow_id, task_id = _make_db_with_task(work_dir="/scratch/run1")

    class _FakeHpc:
        conn = object()  # opaque; the parser is mocked so it is never used

    # Stub the task+connection resolver so no real HPC/SSH is touched.
    monkeypatch.setattr(wet, "_get_task_hpc", lambda tid: (db.get_task(tid), _FakeHpc()))

    parsed = {
        "success": True,
        "forces": [[0.0, 0.0, 0.01], [0.0, 0.0, -0.01]],
        "positions": [[0.0, 0.0, 0.0], [0.0, 0.0, 2.0]],
        "step": 3,
        "total_steps": 3,
        "structure_content": "POSCAR-text",
    }

    async def _fake_forces(conn, work_dir, ionic_step=0):
        # Assert the endpoint forwarded the task's work_dir + ionic_step.
        assert work_dir == "/scratch/run1"
        assert ionic_step == 2
        return parsed

    async def _fake_forces_h5(conn, work_dir, ionic_step=0):
        return None  # force fallback to OUTCAR parser

    import catgo.utils.job_parser as jp
    monkeypatch.setattr(jp, "parse_vasp_forces", _fake_forces)
    monkeypatch.setattr(jp, "parse_vasp_forces_h5", _fake_forces_h5)

    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/forces?ionic_step=2")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["success"] is True
        for key in ("forces", "positions", "step", "total_steps"):
            assert key in data, f"missing key: {key}"
        assert data["forces"] == parsed["forces"]
        assert data["step"] == 3
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_forces_endpoint_prefers_h5_when_available(monkeypatch):
    """If the H5 parser succeeds, the OUTCAR fallback is not used (mirrors V1)."""
    db, db_path, workflow_id, task_id = _make_db_with_task(work_dir="/scratch/run2")

    class _FakeHpc:
        conn = object()

    monkeypatch.setattr(wet, "_get_task_hpc", lambda tid: (db.get_task(tid), _FakeHpc()))

    h5_result = {"success": True, "forces": [[1.0, 2.0, 3.0]], "positions": [[0, 0, 0]],
                 "step": 1, "total_steps": 1, "structure_content": None}

    async def _fake_forces_h5(conn, work_dir, ionic_step=0):
        return h5_result

    async def _boom(conn, work_dir, ionic_step=0):
        raise AssertionError("OUTCAR parser should not run when H5 succeeds")

    import catgo.utils.job_parser as jp
    monkeypatch.setattr(jp, "parse_vasp_forces_h5", _fake_forces_h5)
    monkeypatch.setattr(jp, "parse_vasp_forces", _boom)

    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/forces")
        assert resp.status_code == 200, resp.text
        assert resp.json()["forces"] == [[1.0, 2.0, 3.0]]
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_forces_endpoint_unknown_task_404():
    """Unknown task id returns a clean 404."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)
    try:
        client = _make_app(db)
        resp = client.get("/api/engine/tasks/does-not-exist/forces")
        assert resp.status_code == 404
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_forces_endpoint_no_work_dir_404():
    """A task without a work_dir returns a clean 404 (no work directory yet)."""
    db, db_path, workflow_id, task_id = _make_db_with_task(work_dir=None)
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/forces")
        assert resp.status_code == 404
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)

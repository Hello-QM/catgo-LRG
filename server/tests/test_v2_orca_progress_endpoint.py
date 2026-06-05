"""Tests for the V2-native ORCA stdout-tail stage endpoint (#224 Phase 2).

Covers:
  GET /api/engine/tasks/{task_id}/orca-progress

This endpoint mirrors the V1 ``GET /api/workflow/{wf}/orca_progress/{step}`` idea
but resolves the task via ``WorkflowDB.get_task`` (V2 store) instead of the legacy
``workflow_steps`` table, and reports the coarse-grained calculation *stage*
parsed from the tail of the task's ORCA output. The stage parsing is delegated to
the SAME engine parsers (``catgo.workflow.engine.orca_progress.get_orca_stage`` /
``get_orca_irc_stage``) — this task is additive and must not re-implement them.

Temp DBs only — never ~/.catgo/catgo.db. Local-preview work dirs are read straight
from a real temp dir so the parser runs offline with no HPC connection.
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
from catgo.workflow.engine.advancer import PREVIEW_DIR_PREFIX


# A minimal ORCA.out tail for a freq run that has reached "VIBRATIONAL FREQUENCIES".
_ORCA_FREQ_TAIL = """\
                         SCF ITERATIONS
...
                    Setting up the Hessian
...
-----------------------
VIBRATIONAL FREQUENCIES
-----------------------
"""

# A minimal ORCA IRC tail mid-Hessian.
_ORCA_IRC_TAIL = """\
Calculating gradient on displaced geometry 3 (of 12)
Calculating gradient on displaced geometry 4 (of 12)
"""


def _make_db_with_task(*, work_dir, task_type="orca_freq", params=None):
    """Build a temp WorkflowDB with a single ORCA task.

    Returns (db, db_path, workflow_id, task_id).
    """
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)

    workflow_id = db.create_workflow("v2-orca-progress-wf")
    task_id = db.create_task(
        workflow_id, task_type, task_id=f"{workflow_id}:orca", params=params or {}
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


def _local_preview_dir() -> str:
    """Create a unique local-preview work dir (under PREVIEW_DIR_PREFIX)."""
    base = Path(PREVIEW_DIR_PREFIX)
    base.mkdir(parents=True, exist_ok=True)
    return tempfile.mkdtemp(prefix="orca-prog-", dir=str(base))


def test_orca_progress_resolves_task_and_returns_stage_shape():
    """Happy path: local-preview ORCA.out tail → freq stage from get_orca_stage."""
    work_dir = _local_preview_dir()
    (Path(work_dir) / "ORCA.out").write_text(_ORCA_FREQ_TAIL)
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=work_dir, task_type="orca_freq"
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/orca-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # Stage shape: at minimum a stage key + human-readable message.
        assert "stage" in data
        assert "message" in data
        # The freq tail's latest marker is VIBRATIONAL FREQUENCIES.
        assert data["stage"] == "frequencies"
        # Task resolution echoed back for the frontend.
        assert data["task_id"] == task_id
        assert data["task_type"] == "orca_freq"
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_orca_progress_irc_uses_irc_parser():
    """An orca_irc task dispatches to get_orca_irc_stage (Hessian progress fields)."""
    work_dir = _local_preview_dir()
    (Path(work_dir) / "ORCA.out").write_text(_ORCA_IRC_TAIL)
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=work_dir, task_type="orca_irc"
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/orca-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["stage"] == "irc_hessian"
        # IRC-specific progress fields surfaced by get_orca_irc_stage.
        assert data["hessian_current"] == 4
        assert data["hessian_total"] == 12
        assert data["task_type"] == "orca_irc"
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_orca_progress_unified_geo_opt_resolves_to_orca():
    """A unified geo_opt task with software=orca resolves to an ORCA parser."""
    work_dir = _local_preview_dir()
    (Path(work_dir) / "ORCA.out").write_text(_ORCA_FREQ_TAIL)
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=work_dir, task_type="geo_opt", params={"software": "orca"}
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/orca-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # Resolved to orca_opt → non-IRC parser → still reads frequencies marker.
        assert data["stage"] == "frequencies"
        assert data["task_type"] == "orca_opt"
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_orca_progress_no_output_file_clean_empty():
    """work_dir exists but no ORCA.out yet → clean 'starting' stage, not a 500."""
    work_dir = _local_preview_dir()  # empty dir
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=work_dir, task_type="orca_freq"
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/orca-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["stage"] == "starting"
        assert "message" in data
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_orca_progress_no_work_dir_clean_empty():
    """A task without a work_dir returns a clean 'starting' stage (no work dir yet)."""
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=None, task_type="orca_freq"
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/orca-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["stage"] == "starting"
        assert "message" in data
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_orca_progress_unknown_task_404():
    """Unknown task id returns a clean 404."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)
    try:
        client = _make_app(db)
        resp = client.get("/api/engine/tasks/does-not-exist/orca-progress")
        assert resp.status_code == 404
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_orca_progress_hpc_session_not_connected_clean_empty():
    """An HPC task whose session has expired returns a clean empty stage, not 404/500."""
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir="/scratch/run1", task_type="orca_freq"
    )
    db.update_task(task_id, hpc_session_id="sess-expired")
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/orca-progress")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["stage"] == "starting"
        assert "message" in data
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)

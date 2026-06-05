"""Tests for the V2-native IRC trajectory endpoint (#224 Phase 2).

Covers:
  GET /api/engine/tasks/{task_id}/irc-trajectory

This endpoint mirrors the V1 ``GET /api/workflow/{wf}/irc_trajectory/{step}``
(``catgo.routers.workflow.api_get_irc_trajectory``) but resolves the task via
``WorkflowDB.get_task`` (V2 store) instead of the legacy ``workflow_steps``
table. Like V1 it serves the ORCA IRC full trajectory file
(``ORCA_IRC_Full_trj.xyz``) as raw XYZ text for the trajectory viewer, and
reuses the SAME V1 file helper (``catgo.utils.job_parser.read_remote_file``)
for the HPC path — this task is additive and must not re-implement parsing.

Temp DBs only — never ~/.catgo/catgo.db. Local-preview work dirs are read
straight from a real temp dir so the endpoint runs offline with no HPC
connection.
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


# A minimal 2-frame ORCA IRC trajectory (XYZ format).
_IRC_TRAJ_XYZ = """\
3
Coordinates from ORCA-job ORCA E -76.000000
O    0.000000    0.000000    0.117300
H    0.000000    0.757200   -0.469200
H    0.000000   -0.757200   -0.469200
3
Coordinates from ORCA-job ORCA E -76.010000
O    0.000000    0.000000    0.120000
H    0.000000    0.760000   -0.470000
H    0.000000   -0.760000   -0.470000
"""


def _make_db_with_task(*, work_dir, task_type="orca_irc", params=None):
    """Build a temp WorkflowDB with a single IRC task.

    Returns (db, db_path, workflow_id, task_id).
    """
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)

    workflow_id = db.create_workflow("v2-irc-traj-wf")
    task_id = db.create_task(
        workflow_id, task_type, task_id=f"{workflow_id}:irc", params=params or {}
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
    return tempfile.mkdtemp(prefix="irc-traj-", dir=str(base))


def test_irc_trajectory_resolves_task_and_returns_documented_shape():
    """Happy path: local-preview ORCA_IRC_Full_trj.xyz → {content, filename} shape."""
    work_dir = _local_preview_dir()
    (Path(work_dir) / "ORCA_IRC_Full_trj.xyz").write_text(_IRC_TRAJ_XYZ)
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=work_dir, task_type="orca_irc"
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/irc-trajectory")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # Documented V1 shape: content + filename.
        assert data["filename"] == "ORCA_IRC_Full_trj.xyz"
        assert data["content"] == _IRC_TRAJ_XYZ
        # Task resolution echoed back for the frontend (V2 convention).
        assert data["task_id"] == task_id
        assert data["task_type"] == "orca_irc"
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_irc_trajectory_unified_irc_resolves_to_orca():
    """A unified irc task with software=orca resolves to orca_irc."""
    work_dir = _local_preview_dir()
    (Path(work_dir) / "ORCA_IRC_Full_trj.xyz").write_text(_IRC_TRAJ_XYZ)
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=work_dir, task_type="irc", params={"software": "orca"}
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/irc-trajectory")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["filename"] == "ORCA_IRC_Full_trj.xyz"
        assert data["task_type"] == "orca_irc"
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_irc_trajectory_non_irc_node_rejected():
    """A non-IRC ORCA node returns 400, mirroring the V1 node-type guard."""
    work_dir = _local_preview_dir()
    (Path(work_dir) / "ORCA_IRC_Full_trj.xyz").write_text(_IRC_TRAJ_XYZ)
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=work_dir, task_type="orca_freq"
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/irc-trajectory")
        assert resp.status_code == 400, resp.text
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_irc_trajectory_absent_file_clean_404():
    """work_dir exists but no trajectory file yet → clean 404, not a 500."""
    work_dir = _local_preview_dir()  # empty dir
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=work_dir, task_type="orca_irc"
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/irc-trajectory")
        assert resp.status_code == 404, resp.text
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_irc_trajectory_no_work_dir_404():
    """A task without a work_dir returns a clean 404."""
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir=None, task_type="orca_irc"
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/irc-trajectory")
        assert resp.status_code == 404, resp.text
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_irc_trajectory_unknown_task_404():
    """Unknown task id returns a clean 404."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)
    try:
        client = _make_app(db)
        resp = client.get("/api/engine/tasks/does-not-exist/irc-trajectory")
        assert resp.status_code == 404
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_irc_trajectory_hpc_session_not_connected_404():
    """An HPC task whose session has expired returns a clean 404, not a 500."""
    db, db_path, workflow_id, task_id = _make_db_with_task(
        work_dir="/scratch/run1", task_type="orca_irc"
    )
    db.update_task(task_id, hpc_session_id="sess-expired")
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/irc-trajectory")
        assert resp.status_code == 404, resp.text
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)

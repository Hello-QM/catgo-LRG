"""Tests for the V2-native step-results endpoint (#224 Phase 2).

Covers:
  GET /api/engine/tasks/{task_id}/step-results

This endpoint mirrors the V1 ``GET /api/workflow/{wf}/step-results/{step}`` shape
(``catgo.routers.workflow.api_get_step_results``) but resolves the task via
``WorkflowDB.get_task`` / ``WorkflowDB.get_result`` (V2 store) instead of the
legacy ``workflow_steps`` table. The result-merge logic is delegated to the SAME
V1-compat shim (``catgo.workflow.v1_compat._task_to_step``) the V1 endpoint reads
through — this is additive convergence work, not a re-implementation.

The V1 contract:
  - 404 if the task/step is unknown
  - 400 if the task is not completed
  - on success, ``{node_type, convergence_points, energy_eh, energy_ev,
    converged, n_steps, full_summary}`` where ``full_summary`` is the merged
    result JSON and the scalar fields are pulled out of it.

Temp DBs only — never ~/.catgo/catgo.db.
"""

import json
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


# A representative summary the engine writes to task_results.outputs_json: it
# carries the same keys the V1 step-results endpoint surfaces.
_SUMMARY = {
    "convergence_points": [
        {"step": 0, "energy": -10.0},
        {"step": 1, "energy": -10.5},
        {"step": 2, "energy": -10.7},
    ],
    "energy_eh": -0.393,
    "energy_ev": -10.7,
    "converged": True,
    "n_steps": 3,
}


def _make_db_with_completed_result(*, task_type="geo_opt", outputs=None,
                                   status="COMPLETED"):
    """Build a temp WorkflowDB with one task + stored result.

    Returns (db, db_path, workflow_id, task_id).
    """
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)

    workflow_id = db.create_workflow("v2-step-results-wf")
    task_id = db.create_task(
        workflow_id, task_type, task_id=f"{workflow_id}:opt", params={}
    )
    db.update_task(task_id, status=status)
    if outputs is not None:
        db.store_result(
            task_id, workflow_id,
            energy=outputs.get("energy_ev"),
            outputs_json=json.dumps(outputs),
        )
    return db, db_path, workflow_id, task_id


def _make_app(db: WorkflowDB) -> TestClient:
    wet.set_db(db)
    app = FastAPI()
    app.include_router(wet.router)
    return TestClient(app)


def test_step_results_returns_v1_shape():
    """Happy path: stored result is returned in the V1-compatible shape."""
    db, db_path, workflow_id, task_id = _make_db_with_completed_result(
        outputs=_SUMMARY
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/step-results")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # Exact V1 key set.
        assert set(data.keys()) == {
            "node_type", "convergence_points", "energy_eh", "energy_ev",
            "converged", "n_steps", "full_summary",
        }
        assert data["node_type"] == "geo_opt"
        assert data["convergence_points"] == _SUMMARY["convergence_points"]
        assert data["energy_eh"] == pytest.approx(-0.393)
        assert data["energy_ev"] == pytest.approx(-10.7)
        assert data["converged"] is True
        assert data["n_steps"] == 3
        # full_summary carries the merged result and includes the scalar keys.
        assert data["full_summary"]["energy_ev"] == pytest.approx(-10.7)
        assert data["full_summary"]["n_steps"] == 3
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_step_results_missing_optional_fields_default():
    """A sparse result still returns the full key set with safe defaults."""
    db, db_path, workflow_id, task_id = _make_db_with_completed_result(
        outputs={"energy_ev": -5.0}
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/step-results")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["convergence_points"] == []
        assert data["energy_ev"] == pytest.approx(-5.0)
        # Absent scalars come back as null (matches V1 .get() defaults).
        assert data["energy_eh"] is None
        assert data["converged"] is None
        assert data["n_steps"] is None
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_step_results_unknown_task_404():
    """Unknown task id returns a clean 404."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)
    try:
        client = _make_app(db)
        resp = client.get("/api/engine/tasks/does-not-exist/step-results")
        assert resp.status_code == 404
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_step_results_not_completed_400():
    """A task that has not completed returns 400 (mirrors V1 status guard)."""
    db, db_path, workflow_id, task_id = _make_db_with_completed_result(
        outputs=_SUMMARY, status="RUNNING"
    )
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/tasks/{task_id}/step-results")
        assert resp.status_code == 400
    finally:
        wet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)

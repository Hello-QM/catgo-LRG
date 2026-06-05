"""Tests for the V2-native dashboard aggregation endpoint (#224 Phase 2).

Covers:
  GET /api/engine/workflows/{workflow_id}/results-enriched

This endpoint mirrors the V1 ``GET /api/workflow/{workflow_id}/results-enriched``
shape but reads the V2 store (WorkflowDB.get_all_tasks + get_result +
provenance) instead of the legacy ase_db / workflow_steps tables.

These tests build a temporary WorkflowDB, convert a tiny graph into V2 tasks,
store a result on a task, and assert the enriched fields appear via both the
service function and the HTTP endpoint. Temp DBs only — never ~/.catgo/catgo.db.
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
from catgo.workflow.graph_converter import convert_graph_json
import catgo.routers.workflow_engine as wfe


SAMPLE_GRAPH = json.dumps({
    "nodes": [
        {"id": "n1", "type": "structure_input", "x": 0, "y": 0,
         "params": {"label": "Pt4"}},
        {"id": "n2", "type": "geo_opt", "x": 300, "y": 0,
         "params": {"software": "vasp", "ENCUT": 520}},
    ],
    "edges": [
        {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    ],
})


def _make_db_with_result():
    """Build a temp WorkflowDB, convert a tiny graph, store a result on geo_opt.

    Returns (db, db_path, workflow_id, geo_opt_task_id).
    """
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)

    workflow_id = convert_graph_json(db, "v2-enriched-wf", SAMPLE_GRAPH)
    tasks = db.get_all_tasks(workflow_id)
    geo_opt = next(t for t in tasks if t["task_type"] == "geo_opt")
    task_id = geo_opt["id"]

    # Mark completed + store a result the way the engine collector would.
    db.update_task(task_id, status="COMPLETED", system_name="Pt4")
    db.store_result(
        task_id,
        workflow_id,
        energy=-24.6,
        structure_json=None,
        outputs_json=json.dumps({
            "energy_ev": -24.6,
            "natoms": 4,
            "formula": "Pt4",
            "convergence_points": [
                {"step": 1, "energy": -24.0, "dE": 0.0},
                {"step": 2, "energy": -24.6, "dE": -0.6},
            ],
        }),
    )
    return db, db_path, workflow_id, task_id


def _make_app(db: WorkflowDB) -> TestClient:
    wfe.set_db(db)
    app = FastAPI()
    app.include_router(wfe.router)
    return TestClient(app)


def test_service_builds_enriched_rows_from_v2_store():
    """The V2-native service iterates tasks+results and returns enriched dicts."""
    from catgo.services.workflow_results import build_enriched_results_for_workflow

    db, db_path, workflow_id, task_id = _make_db_with_result()
    try:
        results = build_enriched_results_for_workflow(db, workflow_id)
        assert isinstance(results, list)
        assert len(results) >= 1

        row = next(r for r in results if r.get("step_id") == task_id)
        # Same enriched-shape keys the V1 endpoint / FE dashboard expects.
        for key in (
            "id", "formula", "energy", "energy_per_atom", "natoms",
            "volume", "a", "b", "c", "alpha", "beta", "gamma",
            "workflow_id", "workflow_name", "step_id", "step_label", "node_type",
        ):
            assert key in row, f"missing enriched key: {key}"

        assert row["workflow_id"] == workflow_id
        assert row["workflow_name"] == "v2-enriched-wf"
        assert row["formula"] == "Pt4"
        assert row["energy"] == pytest.approx(-24.6)
        assert row["natoms"] == 4
        assert row["energy_per_atom"] == pytest.approx(-24.6 / 4)
    finally:
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_endpoint_returns_enriched_results():
    """GET /api/engine/workflows/{id}/results-enriched returns the V1-shaped payload."""
    db, db_path, workflow_id, task_id = _make_db_with_result()
    try:
        client = _make_app(db)
        resp = client.get(f"/api/engine/workflows/{workflow_id}/results-enriched")
        assert resp.status_code == 200, resp.text
        data = resp.json()

        assert "results" in data
        assert "count" in data
        assert data["count"] == len(data["results"])
        assert data["count"] >= 1

        row = next(r for r in data["results"] if r.get("step_id") == task_id)
        assert row["workflow_id"] == workflow_id
        assert row["workflow_name"] == "v2-enriched-wf"
        assert row["formula"] == "Pt4"
        assert row["energy"] == pytest.approx(-24.6)
        assert row["node_type"] == "geo_opt"
    finally:
        wfe.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_endpoint_unknown_workflow_404():
    """Unknown workflow id returns 404, not a 500."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)
    try:
        client = _make_app(db)
        resp = client.get("/api/engine/workflows/does-not-exist/results-enriched")
        assert resp.status_code == 404
    finally:
        wfe.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_endpoint_no_results_empty_list():
    """A workflow with tasks but no stored results returns an empty results list."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)
    try:
        workflow_id = convert_graph_json(db, "empty-results-wf", SAMPLE_GRAPH)
        client = _make_app(db)
        resp = client.get(f"/api/engine/workflows/{workflow_id}/results-enriched")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["results"] == []
        assert data["count"] == 0
    finally:
        wfe.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)

"""Tests for the V2-native task analysis endpoint (#224 Phase 2).

Covers:
  POST /api/engine/tasks/{task_id}/gibbs

This endpoint mirrors the V1 ``POST /api/workflow/{wf}/gibbs/{step}`` shape but
reads the V2 task's stored frequency data from the ``task_results`` table (via
``WorkflowDB.get_result``) instead of ``workflow_steps.result_json`` (the V1
path is broken for V2 — task_results has no result_json mirror). It reuses the
same Gibbs/thermo physics (``catgo.utils.gibbs_calculator.calc_adsorbed`` /
``calc_gas``) the V1 handler calls.

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
from catgo.workflow.graph_converter import convert_graph_json
import catgo.routers.workflow_engine_tasks as wfet


SAMPLE_GRAPH = json.dumps({
    "nodes": [
        {"id": "n1", "type": "structure_input", "x": 0, "y": 0,
         "params": {"label": "COOH"}},
        {"id": "n2", "type": "freq", "x": 300, "y": 0,
         "params": {"software": "vasp"}},
    ],
    "edges": [
        {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    ],
})

# Real vibrational frequencies (cm^-1) for an adsorbed species.
REAL_FREQS = [3200.0, 1600.0, 1100.0, 800.0, 600.0, 400.0]
IMAG_FREQS = [120.0]


def _make_db_with_freq_result():
    """Build a temp WorkflowDB, convert a tiny graph, store a freq result.

    Frequencies are stored the way the V2 engine collector / scanner stores
    them: as JSON lists in the dedicated real_freqs_json / imag_freqs_json
    columns of task_results.

    Returns (db, db_path, workflow_id, freq_task_id).
    """
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)

    workflow_id = convert_graph_json(db, "v2-gibbs-wf", SAMPLE_GRAPH)
    tasks = db.get_all_tasks(workflow_id)
    freq_task = next(t for t in tasks if t["task_type"] == "freq")
    task_id = freq_task["id"]

    db.update_task(task_id, status="COMPLETED", system_name="COOH")
    db.store_result(
        task_id,
        workflow_id,
        energy=-12.3,
        real_freqs_json=json.dumps(REAL_FREQS),
        imag_freqs_json=json.dumps(IMAG_FREQS),
    )
    return db, db_path, workflow_id, task_id


def _make_app(db: WorkflowDB) -> TestClient:
    wfet.set_db(db)
    app = FastAPI()
    app.include_router(wfet.router)
    return TestClient(app)


def test_gibbs_endpoint_returns_value_for_adsorbed():
    """POST .../gibbs returns a Gibbs correction computed from stored freqs."""
    db, db_path, workflow_id, task_id = _make_db_with_freq_result()
    try:
        client = _make_app(db)
        resp = client.post(
            f"/api/engine/tasks/{task_id}/gibbs",
            json={"mode": "adsorbed", "temperature": 298.15, "freq_cutoff": 50.0},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()

        assert data["mode"] == "adsorbed"
        # A real Gibbs correction value must be present and finite.
        assert "g_corr_ev" in data
        assert data["g_corr_ev"] is not None
        assert isinstance(data["g_corr_ev"], (int, float))
        # ZPE for these frequencies is positive and non-trivial.
        assert data["zpe_ev"] > 0
        assert data["n_real"] == len(REAL_FREQS)
        assert data["n_imag"] == len(IMAG_FREQS)

        # Cross-check the value against the shared physics helper directly.
        from catgo.utils.gibbs_calculator import calc_adsorbed
        expected = calc_adsorbed(REAL_FREQS, IMAG_FREQS, 298.15, 50.0)
        assert data["g_corr_ev"] == pytest.approx(expected["g_corr_ev"])
        assert data["zpe_ev"] == pytest.approx(expected["zpe_ev"])
    finally:
        wfet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_gibbs_endpoint_unknown_task_404():
    """Unknown task id returns 404, not a 500."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)
    try:
        client = _make_app(db)
        resp = client.post(
            "/api/engine/tasks/does-not-exist/gibbs",
            json={"mode": "adsorbed"},
        )
        assert resp.status_code == 404
    finally:
        wfet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_gibbs_endpoint_no_freqs_reports_gracefully():
    """A completed task without frequency data returns success=False, not 500."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)
    try:
        workflow_id = convert_graph_json(db, "no-freq-wf", SAMPLE_GRAPH)
        tasks = db.get_all_tasks(workflow_id)
        freq_task = next(t for t in tasks if t["task_type"] == "freq")
        task_id = freq_task["id"]
        db.update_task(task_id, status="COMPLETED")
        db.store_result(task_id, workflow_id, energy=-12.3)

        client = _make_app(db)
        resp = client.post(
            f"/api/engine/tasks/{task_id}/gibbs",
            json={"mode": "adsorbed"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("success") is False
    finally:
        wfet.set_db(None)
        if os.path.exists(db_path):
            os.unlink(db_path)

"""Tests for the V2 monitor WebSocket ``initial_state`` seed frame (#224 Phase 3 prep).

The V2 monitor WS (``/api/engine/workflows/{workflow_id}/monitor``) historically
only streamed live ``task_status`` / ``workflow_status`` broadcast messages — the
DAG viewer seeded its initial state via a SEPARATE ``GET .../dag`` REST call. The
editor's V1 path, by contrast, relies on the WS itself emitting an
``initial_state`` frame on connect.

This task makes the V2 monitor ADDITIVELY emit one ``initial_state`` frame BEFORE
any streamed update, carrying the SAME ``{tasks, links}`` payload that the DAG REST
endpoint returns (built from ``WorkflowDB.get_dag``). Existing
``task_status`` / ``workflow_status`` streaming is unchanged; old consumers ignore
the unknown ``initial_state`` type.

Temp DBs only — never ~/.catgo/catgo.db.
"""

import os
import sys
import tempfile
from pathlib import Path

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from fastapi import FastAPI
from fastapi.testclient import TestClient

from catgo.workflow.db import WorkflowDB
import catgo.routers.workflow_engine as we


def _make_db_with_dag():
    """Build a temp WorkflowDB with a workflow, two tasks and one link.

    Returns (db, db_path, workflow_id, task_a_id, task_b_id).
    """
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = WorkflowDB(db_path)

    workflow_id = db.create_workflow("v2-monitor-initial-state-wf")
    task_a = db.create_task(
        workflow_id, "geo_opt", task_id=f"{workflow_id}:a", node_id="a"
    )
    task_b = db.create_task(
        workflow_id, "freq", task_id=f"{workflow_id}:b", node_id="b"
    )
    db.create_link(workflow_id, task_a, task_b, "structure", "structure")
    return db, db_path, workflow_id, task_a, task_b


def _make_client(db: WorkflowDB) -> TestClient:
    we.set_db(db)
    app = FastAPI()
    app.include_router(we.router)
    return TestClient(app)


# --- Helper-level unit test (works even if TestClient WS is impractical) ---

def test_build_initial_state_payload_carries_dag():
    db, db_path, workflow_id, task_a, task_b = _make_db_with_dag()
    try:
        msg = we.build_v2_initial_state(db, workflow_id)
        assert msg["type"] == "initial_state"
        # Same shape the DAG REST endpoint returns.
        ids = {t["id"] for t in msg["tasks"]}
        assert ids == {task_a, task_b}
        assert len(msg["links"]) == 1
        link = msg["links"][0]
        assert link["source_task_id"] == task_a
        assert link["target_task_id"] == task_b
    finally:
        os.unlink(db_path)


def test_build_initial_state_matches_get_dag():
    """The payload must carry exactly the get_dag tasks/links (no divergence)."""
    db, db_path, workflow_id, _a, _b = _make_db_with_dag()
    try:
        dag = db.get_dag(workflow_id)
        msg = we.build_v2_initial_state(db, workflow_id)
        assert msg["tasks"] == dag["tasks"]
        assert msg["links"] == dag["links"]
    finally:
        os.unlink(db_path)


# --- WebSocket-level test: first frame is initial_state ---

def test_monitor_first_frame_is_initial_state():
    db, db_path, workflow_id, task_a, task_b = _make_db_with_dag()
    client = _make_client(db)
    try:
        with client.websocket_connect(
            f"/api/engine/workflows/{workflow_id}/monitor"
        ) as ws:
            frame = ws.receive_json()
            assert frame["type"] == "initial_state"
            ids = {t["id"] for t in frame["tasks"]}
            assert ids == {task_a, task_b}
            assert len(frame["links"]) == 1
            assert frame["links"][0]["source_task_id"] == task_a
            assert frame["links"][0]["target_task_id"] == task_b
    finally:
        os.unlink(db_path)

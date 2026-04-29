# server/tests/test_engine_merge.py
"""Integration test: V1 API -> V2 engine -> V1 response format."""

import json
import os
import tempfile
from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json
from catgo.workflow.v1_compat import list_steps_v1, get_step_status_v1
from catgo.workflow.engine.lifecycle import submit_workflow, pause_workflow, resume_workflow, reset_workflow
from catgo.workflow.engine.scanner import WorkflowEngine
from catgo.workflow.state_map import v2_to_v1_status
import asyncio


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def _sample_graph():
    return json.dumps({
        "nodes": [
            {"id": "n1", "type": "structure_input", "params": {"structure_json": '{"lattice":{},"sites":[]}'}},
            {"id": "n2", "type": "geo_opt", "params": {"software": "vasp"}},
        ],
        "edges": [
            {"from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
        ],
    })


def test_convert_preserves_ids():
    db, path = _make_db()
    try:
        wf_id = convert_graph_json(db, "test", _sample_graph())
        tasks = db.get_all_tasks(wf_id)
        assert {t["id"] for t in tasks} == {"n1", "n2"}
    finally:
        os.unlink(path)


def test_v1_compat_after_submit():
    db, path = _make_db()
    try:
        wf_id = convert_graph_json(db, "test", _sample_graph())
        submit_workflow(db, wf_id)

        wf = db.get_workflow(wf_id)
        assert wf["status"] == "running"

        steps = list_steps_v1(db, wf_id)
        assert len(steps) == 2
        assert all(s["status"] in ("pending", "running", "completed") for s in steps)
    finally:
        os.unlink(path)


def test_pause_resume_reset_cycle():
    db, path = _make_db()
    try:
        wf_id = convert_graph_json(db, "test", _sample_graph())
        submit_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "running"

        pause_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "paused"

        resume_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "running"

        reset_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "draft"
        tasks = db.get_all_tasks(wf_id)
        assert all(t["status"] == "WAITING" for t in tasks)
    finally:
        os.unlink(path)


def test_local_task_executes_in_scan():
    """structure_input is a local task — should complete in one scan cycle."""
    db, path = _make_db()
    try:
        graph = json.dumps({
            "nodes": [
                {"id": "n1", "type": "structure_input",
                 "params": {"structure_json": '{"lattice":{"matrix":[[1,0,0],[0,1,0],[0,0,1]]},"sites":[]}'}},
            ],
            "edges": [],
        })
        wf_id = convert_graph_json(db, "test", graph)
        submit_workflow(db, wf_id)

        engine = WorkflowEngine(db=db)
        asyncio.new_event_loop().run_until_complete(engine.scan_cycle())

        steps = list_steps_v1(db, wf_id)
        assert steps[0]["status"] == "completed"
    finally:
        os.unlink(path)


def test_explicit_workflow_id():
    """workflow_id parameter is preserved when passed to convert_graph_json."""
    db, path = _make_db()
    try:
        explicit_id = "my-custom-wf-id-123"
        wf_id = convert_graph_json(db, "test", _sample_graph(), workflow_id=explicit_id)
        assert wf_id == explicit_id
        wf = db.get_workflow(explicit_id)
        assert wf["id"] == explicit_id
    finally:
        os.unlink(path)

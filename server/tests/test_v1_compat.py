# server/tests/test_v1_compat.py
"""Test V1 compatibility shim that reads V2 tasks table in V1 format."""

import json
import os
import tempfile
from catgo.workflow.db import WorkflowDB
from catgo.workflow.v1_compat import list_steps_v1, get_step_status_v1


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def test_list_steps_returns_v1_shape():
    db, path = _make_db()
    try:
        wf_id = db.create_workflow("test")
        db.create_task(wf_id, "geo_opt", task_id="step1", name="Optimize",
                       params={"software": "vasp"})
        db.update_task("step1", status="RUNNING", work_dir="/scratch/calc",
                       hpc_job_id="12345", hpc_session_id="sess1")

        steps = list_steps_v1(db, wf_id)
        assert len(steps) == 1
        s = steps[0]
        # V1 shape uses lowercase status
        assert s["id"] == "step1"
        assert s["node_type"] == "geo_opt"
        assert s["status"] == "running"
        assert s["work_dir"] == "/scratch/calc"
        assert s["hpc_job_id"] == "12345"
        assert s["hpc_session_id"] == "sess1"
    finally:
        os.unlink(path)


def test_get_step_status_v1():
    db, path = _make_db()
    try:
        wf_id = db.create_workflow("test")
        db.create_task(wf_id, "freq", task_id="s2", params={"software": "vasp"})
        db.update_task("s2", status="COMPLETED", work_dir="/scratch/freq",
                       hpc_session_id="sess2")

        step = get_step_status_v1(db, wf_id, "s2")
        assert step["status"] == "completed"
        assert step["work_dir"] == "/scratch/freq"
    finally:
        os.unlink(path)


def test_get_step_missing_raises():
    db, path = _make_db()
    try:
        wf_id = db.create_workflow("test")
        try:
            get_step_status_v1(db, wf_id, "nonexistent")
            assert False, "Should have raised KeyError"
        except KeyError:
            pass
    finally:
        os.unlink(path)

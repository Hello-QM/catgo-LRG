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
        assert {t["node_id"] for t in tasks} == {"n1", "n2"}
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


def test_cluster_default_job_params_not_clobbered_by_global_defaults():
    """Issue #228: a cluster's default_job_params (partition/ntasks/walltime)
    must land in config_json.hpc.job_defaults and NOT be overwritten by the
    *unset* global default_job_params, which always carries the JobScriptParams
    model defaults (partition='workq', ntasks=96)."""
    from catgo.models.workflow_run import WorkflowRunConfig, ClusterConfig, JobScriptParams
    from catgo.routers.workflow import _run_config_to_engine_config

    sid = "sess-abc"
    cfg = WorkflowRunConfig(
        execution_mode="hpc",
        default_session_id=sid,
        cluster_configs={sid: ClusterConfig(
            account="sdp126",
            module_loads="module load vasp",
            potcar_root="/scratch/me/VASP/pot64",
            default_job_params=JobScriptParams(
                nodes=1, ntasks=32, cpus_per_task=1,
                walltime="8:00:00", partition="shared", memory="64G", account="sdp126",
            ),
        )},
        # global default_job_params left at JobScriptParams() defaults (workq/96)
    )

    out = _run_config_to_engine_config(cfg)
    jd = out["hpc"]["job_defaults"]

    assert jd["partition"] == "shared"   # was 'workq' before fix
    assert jd["ntasks"] == 32            # was 96 before fix
    assert jd["walltime"] == "8:00:00"
    assert jd["account"] == "sdp126"
    assert out["hpc"]["potcar_root"] == "/scratch/me/VASP/pot64"


def test_user_modified_global_job_params_still_override_cluster():
    """The fix must not break the documented intent: a value the user actually
    changed in the dialog (global default_job_params) still overrides the
    cluster default."""
    from catgo.models.workflow_run import WorkflowRunConfig, ClusterConfig, JobScriptParams
    from catgo.routers.workflow import _run_config_to_engine_config

    sid = "sess-abc"
    cfg = WorkflowRunConfig(
        execution_mode="hpc",
        default_session_id=sid,
        cluster_configs={sid: ClusterConfig(
            default_job_params=JobScriptParams(partition="shared", ntasks=32),
        )},
        # user explicitly set a different partition in the dialog
        default_job_params=JobScriptParams(partition="gpu-shared", ntasks=40),
    )

    out = _run_config_to_engine_config(cfg)
    jd = out["hpc"]["job_defaults"]

    assert jd["partition"] == "gpu-shared"   # user choice wins over cluster
    assert jd["ntasks"] == 40

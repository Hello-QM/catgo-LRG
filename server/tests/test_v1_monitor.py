"""Test V1-compatible monitor message translation."""

from catgo.workflow.engine.v1_monitor import (
    build_initial_state,
    translate_broadcast_message,
)


def test_build_initial_state():
    tasks = [
        {"id": "n1", "task_type": "geo_opt", "status": "RUNNING",
         "hpc_job_id": "123", "error_message": None},
        {"id": "n2", "task_type": "freq", "status": "WAITING",
         "hpc_job_id": None, "error_message": None},
    ]
    msg = build_initial_state("running", tasks)
    assert msg["type"] == "initial_state"
    assert msg["workflow_status"] == "running"
    assert len(msg["steps"]) == 2
    assert msg["steps"][0]["id"] == "n1"
    assert msg["steps"][0]["status"] == "running"
    assert msg["steps"][1]["status"] == "pending"


def test_translate_task_status():
    v2_msg = {"type": "task_status", "task_id": "n1", "status": "COMPLETED"}
    v1_msg = translate_broadcast_message(v2_msg)
    assert v1_msg["type"] == "step_status"
    assert v1_msg["step_id"] == "n1"
    assert v1_msg["status"] == "completed"


def test_translate_workflow_status():
    v2_msg = {"type": "workflow_status", "status": "completed"}
    v1_msg = translate_broadcast_message(v2_msg)
    assert v1_msg["type"] == "workflow_status"
    assert v1_msg["status"] == "completed"


def test_translate_unknown_passthrough():
    v2_msg = {"type": "ping"}
    v1_msg = translate_broadcast_message(v2_msg)
    assert v1_msg["type"] == "ping"

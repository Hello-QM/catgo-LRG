# server/tests/test_state_map.py
"""Test V2 TaskState -> V1 frontend status mapping."""

from catgo.workflow.state_map import v2_to_v1_status, v1_to_v2_status


def test_terminal_states():
    assert v2_to_v1_status("COMPLETED") == "completed"
    assert v2_to_v1_status("FAILED") == "failed"
    assert v2_to_v1_status("CANCELLED") == "failed"


def test_active_states():
    assert v2_to_v1_status("RUNNING") == "running"
    assert v2_to_v1_status("GENERATING") == "running"
    assert v2_to_v1_status("UPLOADING") == "running"
    assert v2_to_v1_status("COLLECTING") == "running"
    assert v2_to_v1_status("COMPLETED_REMOTE") == "running"


def test_queued_states():
    assert v2_to_v1_status("SUBMITTED") == "queued"
    assert v2_to_v1_status("QUEUED") == "queued"


def test_pending_states():
    assert v2_to_v1_status("WAITING") == "pending"
    assert v2_to_v1_status("READY") == "pending"


def test_special_states():
    assert v2_to_v1_status("PAUSED") == "paused"
    assert v2_to_v1_status("REMOTE_ERROR") == "failed"


def test_unknown_passthrough():
    assert v2_to_v1_status("some_unknown") == "some_unknown"


def test_v1_to_v2_pending():
    assert v1_to_v2_status("pending") == "WAITING"


def test_v1_to_v2_running():
    assert v1_to_v2_status("running") == "RUNNING"

# server/tests/test_v1_monitor_denamespace.py
"""Issue #227: V2 broadcasts (namespaced task ids) must reach the V1 frontend
wire format as graph node ids so `nodes.find(n => n.id === step_id)` matches."""
from catgo.workflow.engine.v1_monitor import translate_broadcast_message


def test_translate_broadcast_denamespaces_task_id():
    msg = {"type": "task_status", "task_id": "wfA:slab_opt", "status": "RUNNING"}
    out = translate_broadcast_message(msg, workflow_id="wfA")
    assert out["type"] == "step_status"
    assert out["step_id"] == "slab_opt"  # node id, not namespaced


def test_translate_passthrough_step_status_denamespaces_step_id():
    """Local execution engines (mlp/local/analysis/lammps) broadcast messages
    already typed `step_status` with a namespaced `step_id`. Those hit the
    pass-through branch and must still be de-namespaced, or the frontend (which
    keys nodes by graph node id) loses live status and double-namespaces the
    result-polling URL."""
    msg = {"type": "step_status", "step_id": "wfA:slab_opt", "status": "running"}
    out = translate_broadcast_message(msg, workflow_id="wfA")
    assert out["type"] == "step_status"
    assert out["step_id"] == "slab_opt"  # node id, not namespaced
    assert out["status"] == "running"    # other fields preserved


def test_translate_passthrough_without_step_id_unchanged():
    """ping/error messages with no step_id pass through untouched."""
    msg = {"type": "ping"}
    assert translate_broadcast_message(msg, workflow_id="wfA") == {"type": "ping"}

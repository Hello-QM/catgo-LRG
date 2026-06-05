# server/tests/test_v1_monitor_denamespace.py
"""Issue #227: V2 broadcasts (namespaced task ids) must reach the V1 frontend
wire format as graph node ids so `nodes.find(n => n.id === step_id)` matches."""
from catgo.workflow.engine.v1_monitor import translate_broadcast_message


def test_translate_broadcast_denamespaces_task_id():
    msg = {"type": "task_status", "task_id": "wfA:slab_opt", "status": "RUNNING"}
    out = translate_broadcast_message(msg, workflow_id="wfA")
    assert out["type"] == "step_status"
    assert out["step_id"] == "slab_opt"  # node id, not namespaced

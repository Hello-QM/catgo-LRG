# server/tests/test_run_workflow_reconcile.py
"""Issue #227: re-running a workflow whose tasks are namespaced must take the
same-id reconcile branch (preserving results), not the full-recreate branch."""
import json
import os
import tempfile
from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def _graph():
    return json.dumps({
        "nodes": [{"id": "slab_opt", "type": "geo_opt", "params": {"software": "vasp"}}],
        "edges": [],
    })


def test_rerun_preserves_completed_result_via_node_id_match():
    """The recreate decision must compare graph node ids against tasks.node_id."""
    db, path = _make_db()
    try:
        db.create_workflow("RPBE", workflow_id="wfA")
        convert_graph_json(db, "RPBE", _graph(), workflow_id="wfA")
        db.update_task("wfA:slab_opt", status="COMPLETED")
        db.store_result("wfA:slab_opt", "wfA", energy=-1.0)

        # Simulate the recreate-decision logic from api_run_workflow:
        graph_dict = json.loads(_graph())
        new_node_ids = {n["id"] for n in graph_dict["nodes"]}
        old_tasks = db.get_all_tasks("wfA")
        old_node_ids = {t.get("node_id") or t["id"] for t in old_tasks}
        assert new_node_ids == old_node_ids  # MUST match → same-id branch, not full recreate
    finally:
        os.unlink(path)

# server/tests/test_task_id_namespacing.py
"""Issue #227: workflow task IDs are namespaced {workflow_id}:{node_id}."""
from catgo.workflow.task_ids import make_task_id, node_id_from_task_id


def test_make_task_id():
    assert make_task_id("wfA", "slab_opt") == "wfA:slab_opt"


def test_node_id_from_task_id_with_workflow_id():
    assert node_id_from_task_id("wfA:slab_opt", "wfA") == "slab_opt"


def test_node_id_from_task_id_without_workflow_id():
    # workflow ids never contain ':', so splitting on the first ':' recovers the node id
    assert node_id_from_task_id("wfA:slab_opt") == "slab_opt"


def test_node_id_from_task_id_passthrough_for_bare_or_random_ids():
    # legacy bare ids and DSL random ids (no ':') pass through unchanged
    assert node_id_from_task_id("slab_opt") == "slab_opt"
    assert node_id_from_task_id("a1b2c3d4e5f6a7b8") == "a1b2c3d4e5f6a7b8"


import os
import sqlite3
import tempfile
from catgo.workflow.db import WorkflowDB


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def test_create_task_stores_node_id():
    db, path = _make_db()
    try:
        # tasks.workflow_id has an FK to workflows(id) (foreign_keys=ON), so the
        # parent workflow row must exist before the task can be inserted.
        db.create_workflow("wfA", workflow_id="wfA")
        tid = db.create_task("wfA", "geo_opt", task_id="wfA:slab_opt", node_id="slab_opt")
        assert tid == "wfA:slab_opt"
        t = db.get_task("wfA:slab_opt")
        assert t["node_id"] == "slab_opt"
        assert t["workflow_id"] == "wfA"
    finally:
        os.unlink(path)


def test_migration_backfills_node_id_from_id():
    # Simulate a pre-migration DB: tasks row created without node_id, then reopened.
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        raw = sqlite3.connect(path)
        raw.executescript(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, "
            "task_type TEXT NOT NULL, status TEXT DEFAULT 'WAITING', created_at TEXT);"
        )
        raw.execute("INSERT INTO tasks (id, workflow_id, task_type) VALUES ('slab_opt','wfOld','geo_opt')")
        raw.commit()
        raw.close()

        db = WorkflowDB(path)  # triggers _migrate_db + schema
        t = db.get_task("slab_opt")
        assert t["node_id"] == "slab_opt"  # back-filled
    finally:
        os.unlink(path)


import json
from catgo.workflow.graph_converter import convert_graph_json


def _overlap_graph():
    return json.dumps({
        "nodes": [
            {"id": "si", "type": "structure_input", "params": {}},
            {"id": "slab_opt", "type": "geo_opt", "params": {"software": "vasp"}},
        ],
        "edges": [{"from": "si", "to": "slab_opt", "fromH": "out-0", "toH": "in-0"}],
    })


def test_two_workflows_overlapping_node_ids_dont_clobber():
    """Running/converting workflow A must not delete workflow B's tasks when both
    use identical node ids (the ORR-template collision in #227)."""
    db, path = _make_db()
    try:
        db.create_workflow("RPBE-D3", workflow_id="wfB")
        convert_graph_json(db, "RPBE-D3", _overlap_graph(), workflow_id="wfB")
        db.update_task("wfB:slab_opt", status="COMPLETED")
        db.store_result("wfB:slab_opt", "wfB", energy=-123.4)

        db.create_workflow("RPBE", workflow_id="wfA")
        db.delete_workflow_tasks_and_links("wfA")  # no-op; A has none yet
        convert_graph_json(db, "RPBE", _overlap_graph(), workflow_id="wfA")

        b_nodes = {t["node_id"] for t in db.get_all_tasks("wfB")}
        assert b_nodes == {"si", "slab_opt"}, "workflow B tasks were clobbered (#227)"
        assert db.get_result("wfB:slab_opt")["energy"] == -123.4
        a_ids = {t["id"] for t in db.get_all_tasks("wfA")}
        assert a_ids == {"wfA:si", "wfA:slab_opt"}
    finally:
        os.unlink(path)


def test_convert_namespaces_links():
    db, path = _make_db()
    try:
        db.create_workflow("RPBE", workflow_id="wfA")
        convert_graph_json(db, "RPBE", _overlap_graph(), workflow_id="wfA")
        links = db._get_all_links("wfA")
        assert any(
            l["source_task_id"] == "wfA:si" and l["target_task_id"] == "wfA:slab_opt"
            for l in links
        )
    finally:
        os.unlink(path)


from catgo.workflow.engine.hpc_utils import resolve_work_dir


def test_resolve_work_dir_uses_node_id():
    config = {"hpc": {"base_work_dir": "/scratch/me/catgo"}}
    task = {"id": "wfA:slab_opt", "node_id": "slab_opt", "workflow_id": "wfA"}
    wd = resolve_work_dir(task, "wfA", config)
    assert wd.endswith("/wfA/slab_opt"), wd
    assert ":" not in wd.rsplit("/", 1)[-1]  # no namespaced segment in the last path component


from catgo.workflow.v1_compat import get_step_status_v1, list_steps_v1


def test_v1_compat_steps_keyed_by_node_id():
    db, path = _make_db()
    try:
        db.create_workflow("RPBE", workflow_id="wfA")
        convert_graph_json(db, "RPBE", _overlap_graph(), workflow_id="wfA")
        steps = list_steps_v1(db, "wfA")
        assert {s["id"] for s in steps} == {"si", "slab_opt"}  # node ids, not namespaced
        one = get_step_status_v1(db, "wfA", "slab_opt")        # look up by node id
        assert one["id"] == "slab_opt"
    finally:
        os.unlink(path)

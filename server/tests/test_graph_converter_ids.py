"""Test that graph_converter preserves original node IDs as task IDs."""

import json
import os
import tempfile
from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def test_node_ids_preserved():
    db, path = _make_db()
    try:
        graph = {
            "nodes": [
                {"id": "node_abc", "type": "structure_input", "params": {}},
                {"id": "node_xyz", "type": "geo_opt", "params": {"software": "vasp"}},
            ],
            "edges": [
                {"from": "node_abc", "to": "node_xyz", "fromH": "out-0", "toH": "in-0"},
            ],
        }
        wf_id = convert_graph_json(db, "test", json.dumps(graph))
        tasks = db.get_all_tasks(wf_id)
        node_ids = {t["node_id"] for t in tasks}
        assert node_ids == {"node_abc", "node_xyz"}
    finally:
        os.unlink(path)


def test_graph_json_stored_on_workflow():
    db, path = _make_db()
    try:
        graph = {"nodes": [{"id": "n1", "type": "geo_opt", "params": {}}], "edges": []}
        wf_id = convert_graph_json(db, "test", json.dumps(graph))
        wf = db.get_workflow(wf_id)
        assert wf.get("graph_json") is not None
        stored = json.loads(wf["graph_json"])
        assert stored["nodes"][0]["id"] == "n1"
    finally:
        os.unlink(path)


def test_links_use_original_ids():
    db, path = _make_db()
    try:
        graph = {
            "nodes": [
                {"id": "src_node", "type": "structure_input", "params": {}},
                {"id": "tgt_node", "type": "geo_opt", "params": {}},
            ],
            "edges": [
                {"from": "src_node", "to": "tgt_node", "fromH": "out-0", "toH": "in-0"},
            ],
        }
        wf_id = convert_graph_json(db, "test", json.dumps(graph))
        dag = db.get_dag(wf_id)
        links = dag["links"]
        assert len(links) == 1
        assert links[0]["source_task_id"] == f"{wf_id}:src_node"
        assert links[0]["target_task_id"] == f"{wf_id}:tgt_node"
    finally:
        os.unlink(path)


def test_explicit_workflow_id():
    db, path = _make_db()
    try:
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input", "params": {}},
                {"id": "n2", "type": "geo_opt", "params": {}},
            ],
            "edges": [
                {"from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
            ],
        }
        wf_id = convert_graph_json(db, "test", json.dumps(graph),
                                    workflow_id="my_v1_id")
        assert wf_id == "my_v1_id"
        wf = db.get_workflow("my_v1_id")
        assert wf["name"] == "test"
        tasks = db.get_all_tasks("my_v1_id")
        assert len(tasks) == 2
    finally:
        os.unlink(path)


def test_rerun_with_same_workflow_id():
    """INSERT OR REPLACE should allow re-creating a workflow with the same ID."""
    db, path = _make_db()
    try:
        graph = {
            "nodes": [{"id": "n1", "type": "geo_opt", "params": {}}],
            "edges": [],
        }
        wf_id1 = convert_graph_json(db, "run1", json.dumps(graph),
                                     workflow_id="reuse_id")
        assert wf_id1 == "reuse_id"

        # Re-run with the same workflow ID
        wf_id2 = convert_graph_json(db, "run2", json.dumps(graph),
                                     workflow_id="reuse_id")
        assert wf_id2 == "reuse_id"
        wf = db.get_workflow("reuse_id")
        assert wf["name"] == "run2"
    finally:
        os.unlink(path)

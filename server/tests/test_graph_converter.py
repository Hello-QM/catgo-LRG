# server/tests/test_graph_converter.py
"""Tests for graph_json -> v2 tasks converter."""
import json
import os
import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json


@pytest.fixture
def db(tmp_path):
    return WorkflowDB(str(tmp_path / "test.db"))


SAMPLE_GRAPH = json.dumps({
    "nodes": [
        {"id": "n1", "type": "structure_input", "x": 0, "y": 0, "params": {"label": "TiO2"}},
        {"id": "n2", "type": "geo_opt", "x": 300, "y": 0, "params": {"software": "vasp", "ENCUT": 520}},
        {"id": "n3", "type": "freq", "x": 600, "y": 0, "params": {"software": "vasp"}},
    ],
    "edges": [
        {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
        {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    ],
})


def test_converts_nodes_to_tasks(db):
    wf_id = convert_graph_json(db, "test-wf", SAMPLE_GRAPH)
    tasks = db.get_all_tasks(wf_id)
    assert len(tasks) == 3
    types = [t["task_type"] for t in tasks]
    assert "structure_input" in types
    assert "geo_opt" in types
    assert "freq" in types


def test_converts_edges_to_links(db):
    wf_id = convert_graph_json(db, "test-wf", SAMPLE_GRAPH)
    dag = db.get_dag(wf_id)
    links = dag["links"]
    assert len(links) == 2
    # First link: structure_input -> geo_opt
    assert links[0]["source_key"] == "structure"
    assert links[0]["target_key"] == "structure"


def test_preserves_params(db):
    wf_id = convert_graph_json(db, "test-wf", SAMPLE_GRAPH)
    tasks = db.get_all_tasks(wf_id)
    geo_opt = [t for t in tasks if t["task_type"] == "geo_opt"][0]
    params = json.loads(geo_opt["params_json"])
    assert params["ENCUT"] == 520
    assert params["software"] == "vasp"


def test_preserves_software_field(db):
    wf_id = convert_graph_json(db, "test-wf", SAMPLE_GRAPH)
    tasks = db.get_all_tasks(wf_id)
    geo_opt = [t for t in tasks if t["task_type"] == "geo_opt"][0]
    assert geo_opt["software"] == "vasp"


def test_empty_graph(db):
    empty = json.dumps({"nodes": [], "edges": []})
    wf_id = convert_graph_json(db, "empty-wf", empty)
    tasks = db.get_all_tasks(wf_id)
    assert len(tasks) == 0

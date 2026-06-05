"""Issue #227: MCP result/status tools accept workflow_id + node_id (the task id
is namespaced {workflow_id}:{node_id}).

The MCP workflow tool dispatches through ``mcp_tools._dispatch_sync(action, params)``,
which obtains a ``WorkflowDB`` internally via ``mcp_tools._get_db()``. These tests
monkeypatch ``_get_db`` to a temp DB so the *real* dispatch path is exercised, and
also unit-test the ``_resolve_task_id`` helper directly.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# Ensure server/ is importable
_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json


def _db():
    fd, p = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(p), p


def _seed(db):
    """Create workflow 'wfA' with a single node 'slab_opt' and a stored result."""
    db.create_workflow("RPBE", workflow_id="wfA")
    convert_graph_json(db, "RPBE", json.dumps({
        "nodes": [{"id": "slab_opt", "type": "geo_opt", "params": {}}],
        "edges": [],
    }), workflow_id="wfA")
    db.store_result("wfA:slab_opt", "wfA", energy=-7.0)


def test_mcp_result_by_workflow_and_node_id(monkeypatch):
    """get_result resolves workflow_id + node_id -> namespaced task id."""
    import catgo.workflow.mcp_tools as mcp
    db, p = _db()
    try:
        _seed(db)
        monkeypatch.setattr(mcp, "_get_db", lambda: db)

        out = mcp._dispatch_sync("get_result", {"workflow_id": "wfA", "node_id": "slab_opt"})
        assert out.get("energy") == -7.0
    finally:
        os.unlink(p)


def test_mcp_result_by_explicit_task_id_still_works(monkeypatch):
    """Back-compat: an already-namespaced task_id still resolves."""
    import catgo.workflow.mcp_tools as mcp
    db, p = _db()
    try:
        _seed(db)
        monkeypatch.setattr(mcp, "_get_db", lambda: db)

        out = mcp._dispatch_sync("get_result", {"task_id": "wfA:slab_opt"})
        assert out.get("energy") == -7.0
    finally:
        os.unlink(p)


def test_resolve_task_id_helper():
    """The resolver prefers explicit task_id, else namespaces workflow_id+node_id."""
    import catgo.workflow.mcp_tools as mcp

    assert mcp._resolve_task_id({"task_id": "wfA:slab_opt"}) == "wfA:slab_opt"
    assert mcp._resolve_task_id({"workflow_id": "wfA", "node_id": "slab_opt"}) == "wfA:slab_opt"
    # explicit task_id wins even if workflow_id/node_id also present
    assert mcp._resolve_task_id(
        {"task_id": "explicit:id", "workflow_id": "wfA", "node_id": "slab_opt"}
    ) == "explicit:id"
    with pytest.raises(ValueError):
        mcp._resolve_task_id({})
    with pytest.raises(ValueError):
        mcp._resolve_task_id({"workflow_id": "wfA"})  # node_id missing

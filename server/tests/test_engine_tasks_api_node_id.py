"""Issue #227: the engine task endpoint exposes node_id so the frontend can map
namespaced task ids back to graph nodes.

The router stores its WorkflowDB in a module-level ``_db`` (set via ``set_db``
during app startup). The TestClient triggers the app lifespan, so by the time
this test runs ``wet._db`` is the SAME WorkflowDB the running app/engine uses.
We create clearly-named throwaway workflows ("wfApi*") in that db and leave all
other workflows untouched.
"""
import json


def test_get_task_returns_node_id(client):
    """A normal (post-namespacing) task carries its graph node_id through the API."""
    import catgo.routers.workflow_engine_tasks as wet
    from catgo.workflow.graph_converter import convert_graph_json

    db = wet._db  # the real WorkflowDB the router uses (module global, set by set_db)
    assert db is not None, "router db not initialized; app lifespan should set it"

    # convert_graph_json creates the workflow + tasks (namespaced ids "wfApi:<node_id>").
    convert_graph_json(db, "RPBE", json.dumps({
        "nodes": [{"id": "slab_opt", "type": "geo_opt", "params": {}}],
        "edges": [],
    }), workflow_id="wfApi")

    r = client.get("/api/engine/tasks/wfApi:slab_opt")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["task"]["node_id"] == "slab_opt"


def test_get_task_returns_node_id_for_legacy_row(client):
    """Back-compat: a legacy task row with NULL node_id still exposes node_id
    on the API (the handler falls back to the task id)."""
    import catgo.routers.workflow_engine_tasks as wet
    from catgo.workflow.graph_converter import convert_graph_json

    db = wet._db
    assert db is not None

    convert_graph_json(db, "RPBE", json.dumps({
        "nodes": [{"id": "legacy_node", "type": "geo_opt", "params": {}}],
        "edges": [],
    }), workflow_id="wfApiLegacy")

    task_id = "wfApiLegacy:legacy_node"
    # Simulate a pre-migration row where node_id was never populated.
    conn = db._get_conn()
    conn.execute("UPDATE tasks SET node_id = NULL WHERE id = ?", (task_id,))
    conn.commit()
    conn.close()

    r = client.get(f"/api/engine/tasks/{task_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    # Without the handler's setdefault fallback, node_id would be None here.
    assert body["task"]["node_id"] == task_id

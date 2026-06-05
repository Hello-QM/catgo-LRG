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

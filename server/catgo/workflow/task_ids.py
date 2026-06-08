# server/catgo/workflow/task_ids.py
"""Single source of truth for the V2 workflow task-id convention.

A task's primary-key `id` is globally unique and formed as `{workflow_id}:{node_id}`,
where `node_id` is the graph node id (stored separately in the `tasks.node_id`
column). Workflow ids never contain ':', so the node id is always recoverable.
Legacy bare ids and DSL-generated random ids (no ':') pass through unchanged.
"""
from __future__ import annotations


def make_task_id(workflow_id: str, node_id: str) -> str:
    """Build the globally-unique task primary key from a workflow + node id."""
    return f"{workflow_id}:{node_id}"


def node_id_from_task_id(task_id: str, workflow_id: str | None = None) -> str:
    """Recover the graph node id from a (possibly namespaced) task id."""
    if workflow_id and task_id.startswith(f"{workflow_id}:"):
        return task_id[len(workflow_id) + 1:]
    if ":" in task_id:
        return task_id.split(":", 1)[1]
    return task_id

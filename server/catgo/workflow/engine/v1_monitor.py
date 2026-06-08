"""Translate V2 engine broadcast messages to V1 frontend wire format.

V1 wire format (consumed by workflow-execution.svelte.ts):
  - initial_state: {type, workflow_status, steps: [{id, status, hpc_job_id, error_message}]}
  - step_status:   {type, step_id, status, job_id?}
  - workflow_status: {type, status}
  - ping:          {type: "ping"}

V2 broadcast format (from broadcast.py):
  - task_status:    {type, task_id, status}  (status is UPPERCASE)
  - workflow_status: {type, status}          (status is lowercase)
"""

from __future__ import annotations
from typing import Any

from catgo.workflow.state_map import v2_to_v1_status
from catgo.workflow.task_ids import node_id_from_task_id


def build_initial_state(
    workflow_status: str,
    tasks: list[dict],
) -> dict[str, Any]:
    """Build V1-shaped initial_state message from V2 task rows."""
    steps = []
    for t in tasks:
        steps.append({
            "id": t.get("node_id") or t["id"],
            "node_type": t.get("task_type", ""),
            "status": v2_to_v1_status(t["status"]),
            "hpc_job_id": t.get("hpc_job_id"),
            "error_message": t.get("error_message"),
        })
    return {
        "type": "initial_state",
        "workflow_status": workflow_status,
        "steps": steps,
    }


def translate_broadcast_message(
    msg: dict[str, Any], workflow_id: str | None = None
) -> dict[str, Any]:
    """Translate a V2 broadcast message to V1 wire format.

    V2 broadcasts carry the namespaced task id (`{workflow_id}:{node_id}`); the
    V1 frontend keys steps by graph node id, so de-namespace via the passed
    workflow_id before emitting `step_id`.
    """
    msg_type = msg.get("type", "")

    if msg_type == "task_status":
        return {
            "type": "step_status",
            "step_id": node_id_from_task_id(msg.get("task_id", ""), workflow_id),
            "status": v2_to_v1_status(msg.get("status", "")),
            "job_id": msg.get("job_id"),
        }

    if msg_type == "step_message":
        return {
            "type": "step_status",
            "step_id": node_id_from_task_id(msg.get("task_id", ""), workflow_id),
            "status": "running",
            "message": msg.get("message", ""),
        }

    if msg_type == "workflow_status":
        return {
            "type": "workflow_status",
            "status": msg.get("status", ""),
        }

    # Pass-through (ping, error, and step_status/step_log broadcast directly by
    # local execution engines). Those carry a namespaced step_id that the V1
    # frontend keys by graph node id, so de-namespace it here too.
    if "step_id" in msg:
        return {**msg, "step_id": node_id_from_task_id(msg.get("step_id", ""), workflow_id)}
    return msg

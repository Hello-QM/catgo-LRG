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


def build_initial_state(
    workflow_status: str,
    tasks: list[dict],
) -> dict[str, Any]:
    """Build V1-shaped initial_state message from V2 task rows."""
    steps = []
    for t in tasks:
        steps.append({
            "id": t["id"],
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


def translate_broadcast_message(msg: dict[str, Any]) -> dict[str, Any]:
    """Translate a V2 broadcast message to V1 wire format."""
    msg_type = msg.get("type", "")

    if msg_type == "task_status":
        return {
            "type": "step_status",
            "step_id": msg.get("task_id", ""),
            "status": v2_to_v1_status(msg.get("status", "")),
            "job_id": msg.get("job_id"),
        }

    if msg_type == "workflow_status":
        return {
            "type": "workflow_status",
            "status": msg.get("status", ""),
        }

    # ping, error, etc — pass through
    return msg

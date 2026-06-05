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
import re

from catgo.workflow.state_map import v2_to_v1_status
from catgo.workflow.task_ids import node_id_from_task_id


def get_orca_stage(tail_text: str) -> dict:
    """Parse ORCA output tail to determine current calculation stage.

    Markers are listed in chronological order. Returns the latest stage found.
    """
    stage_markers = [
        ("SCF ITERATIONS", "scf", "Converging SCF..."),
        ("Hessian", "hessian", "Setting up Hessian..."),
        ("Calculating the COSX Hessian", "hessian_cosx", "Computing Hessian (slowest step, ~54% of runtime)..."),
        ("Calculating normal modes", "normal_modes", "Deriving normal modes..."),
        ("VIBRATIONAL FREQUENCIES", "frequencies", "Computing vibrational frequencies..."),
        ("Thermochemistry", "thermochem", "Calculating thermochemistry..."),
        ("ORCA TERMINATED NORMALLY", "done", "Calculation complete"),
    ]
    current: dict = {"stage": "starting", "message": "Starting calculation..."}
    for marker, stage_key, message in stage_markers:
        if marker in tail_text:
            current = {"stage": stage_key, "message": message}
    return current


def get_orca_irc_stage(tail_text: str) -> dict:
    """Parse ORCA IRC output tail to determine current phase and step counts.

    Returns a dict with stage, message, and optional progress fields:
      hessian_current / hessian_total  — during numerical Hessian
      forward_steps / backward_steps   — during IRC path following
    """
    # Check phases in reverse chronological order so we return the latest
    if "BACKWARD IRC" in tail_text:
        # Count completed backward steps from the last step-data line pattern
        steps = re.findall(
            r"^\s+(\d+)\s+[-\d.]+\s+[-\d.]+\s+[\d.]+\s+[\d.]+",
            tail_text[tail_text.rfind("BACKWARD IRC"):],
            re.MULTILINE,
        )
        n = int(steps[-1]) + 1 if steps else 0
        return {"stage": "irc_backward", "message": f"Backward IRC: {n} step(s)", "backward_steps": n}

    if "FORWARD IRC" in tail_text:
        steps = re.findall(
            r"^\s+(\d+)\s+[-\d.]+\s+[-\d.]+\s+[\d.]+\s+[\d.]+",
            tail_text[tail_text.rfind("FORWARD IRC"):],
            re.MULTILINE,
        )
        n = int(steps[-1]) + 1 if steps else 0
        return {"stage": "irc_forward", "message": f"Forward IRC: {n} step(s)", "forward_steps": n}

    if "Calculating gradient on displaced geometry" in tail_text:
        # Find the highest displacement number seen so far
        matches = re.findall(
            r"Calculating gradient on displaced geometry\s+(\d+) \(of\s+(\d+)\)",
            tail_text,
        )
        if matches:
            current_n, total_n = int(matches[-1][0]), int(matches[-1][1])
            return {
                "stage": "irc_hessian",
                "message": f"Computing Hessian ({current_n}/{total_n})...",
                "hessian_current": current_n,
                "hessian_total": total_n,
            }
        return {"stage": "irc_hessian", "message": "Computing Hessian..."}

    if "Energy+Gradient Calculation" in tail_text:
        return {"stage": "irc_initial", "message": "Computing initial TS energy..."}

    return {"stage": "starting", "message": "Starting IRC calculation..."}


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

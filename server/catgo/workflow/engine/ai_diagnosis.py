"""AI-assisted error diagnosis for failed HPC tasks.

Reads error logs from HPC and formats structured diagnosis that can be:
1. Automatically processed by the error handler (if confidence is high)
2. Returned via MCP tool for manual AI agent review
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from catgo.workflow.db import WorkflowDB

logger = logging.getLogger(__name__)


async def read_error_log(hpc, task: dict, max_lines: int = 200) -> str:
    """Read error log from HPC for a failed task."""
    work_dir = task.get("work_dir")
    if not work_dir or not hpc:
        return ""

    software = task.get("software", "vasp")
    # Try different log files based on software
    log_files = {
        "vasp": ["OUTCAR", "vasp.out", "std_err.txt", "custodian_run.log"],
        "orca": ["ORCA.out", "*.err"],
        "cp2k": ["project.out", "cp2k.out", "*.out", "*.err"],
    }
    files_to_check = log_files.get(software, ["*.out", "*.err"])

    for filename in files_to_check:
        try:
            result = await hpc.conn.run(
                f"tail -n {max_lines} {work_dir}/{filename} 2>/dev/null",
                check=False,
            )
            if result.exit_status == 0 and result.stdout.strip():
                return result.stdout.strip()
        except Exception:
            continue
    return ""


def format_diagnosis_prompt(task: dict, error_log: str) -> str:
    """Format a structured prompt for AI diagnosis."""
    params = json.loads(task.get("params_json", "{}") or "{}")
    return (
        f"Analyze this {task.get('software', 'unknown')} calculation error "
        f"and suggest specific parameter fixes.\n\n"
        f"Task type: {task.get('task_type', 'unknown')}\n"
        f"Software: {task.get('software', 'unknown')}\n"
        f"Current parameters: {json.dumps(params, indent=2)}\n"
        f"Error message: {task.get('error_message', 'N/A')}\n\n"
        f"Error log (last lines):\n{error_log[-3000:]}\n\n"
        'Respond with:\n'
        '1. Root cause (one sentence)\n'
        '2. Suggested parameter changes as JSON: {"param": "value", ...}\n'
        '3. Confidence (high/medium/low)'
    )


def parse_diagnosis_response(response: str) -> dict | None:
    """Parse AI response for parameter fixes."""
    json_match = re.search(r'\{[^{}]+\}', response)
    if json_match:
        try:
            fixes = json.loads(json_match.group())
            confidence = "medium"
            if "high" in response.lower():
                confidence = "high"
            elif "low" in response.lower():
                confidence = "low"
            return {
                "fixes": fixes,
                "confidence": confidence,
                "diagnosis": response[:500],
                "tier": 2.5,
            }
        except json.JSONDecodeError:
            pass
    return None


async def get_diagnosis_for_mcp(db: WorkflowDB, task_id: str) -> dict:
    """Get structured error diagnosis for MCP tool response."""
    task = db.get_task(task_id)
    error_msg = task.get("error_message", "No error message")
    params = json.loads(task.get("params_json", "{}") or "{}")

    # Get rule-based diagnosis first
    from catgo.workflow.engine.smart_recovery import diagnose_and_fix

    rule_fix = diagnose_and_fix(db, task, {})

    return {
        "task_id": task_id,
        "task_type": task.get("task_type"),
        "software": task.get("software"),
        "status": task.get("status"),
        "error_message": error_msg,
        "work_dir": task.get("work_dir"),
        "current_params": params,
        "rule_based_diagnosis": rule_fix,
        "hint": (
            "Use catgo_workflow_engine(action='modify_params') to apply fixes, "
            "then catgo_workflow_engine(action='retry') to retry."
        ),
    }

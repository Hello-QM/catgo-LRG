"""Three-tier smart error recovery for failed HPC tasks.

Tier 1: Custodian (handles VASP errors at runtime -- already integrated)
Tier 2: Rule-based diagnosis (parse error message, apply known fixes)
Tier 3: Escalate to user (PAUSED with diagnosis message)
"""

from __future__ import annotations

import json
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB

logger = logging.getLogger(__name__)

# Known error patterns -> parameter fixes
_VASP_FIXES: list[dict] = [
    {
        "pattern": "ZBRENT",
        "diagnosis": "Ionic step optimizer (ZBRENT) failed to bracket minimum",
        "fixes": {"IBRION": 1, "POTIM": 0.1},
    },
    {
        "pattern": "BRMIX",
        "diagnosis": "Charge density mixing instability",
        "fixes": {"AMIX": 0.1, "BMIX": 0.001, "AMIX_MAG": 0.2, "BMIX_MAG": 0.001},
    },
    {
        "pattern": "EDDDAV",
        "diagnosis": "Sub-space rotation failed in electronic minimization",
        "fixes": {"ALGO": "All"},
    },
    {
        "pattern": "VERY BAD NEWS",
        "diagnosis": "Internal VASP error -- often caused by bad geometry or pseudopotential",
        "fixes": {"SYMPREC": 1e-4},
    },
    {
        "pattern": "RSPHER",
        "diagnosis": "Atoms too close together -- augmentation sphere overlap",
        "fixes": {},  # Can't auto-fix, escalate
    },
    {
        "pattern": "exceeded",  # NSW exceeded
        "diagnosis": "Ionic relaxation did not converge within NSW steps",
        "fixes": {"NSW": 500},
    },
    {
        "pattern": "PRICEL",
        "diagnosis": "Primitive cell determination failed",
        "fixes": {"SYMPREC": 1e-4, "ISYM": 0},
    },
    {
        "pattern": "not converge",  # SCF not converged
        "diagnosis": "Electronic SCF did not converge",
        "fixes": {"ALGO": "All", "NELM": 300, "AMIX": 0.1, "BMIX": 0.001},
    },
]

_ORCA_FIXES: list[dict] = [
    {
        "pattern": "SCF NOT CONVERGED",
        "diagnosis": "ORCA SCF did not converge",
        "fixes": {"scf_max_iter": 500, "scf_conv": "SlowConv"},
    },
    {
        "pattern": "ORCA TERMINATED ABNORMALLY",
        "diagnosis": "ORCA crashed -- often memory or input error",
        "fixes": {},  # Escalate
    },
]


def diagnose_and_fix(
    db: WorkflowDB,
    task: dict,
    config: dict,
) -> dict | None:
    """Analyze error message and return a fix dict, or None to escalate.

    Returns: {"diagnosis": str, "fixes": dict, "tier": int} or None
    """
    error_msg = task.get("error_message", "") or ""
    software = task.get("software", "")

    # Select fix database based on software
    if software == "vasp":
        fixes_db = _VASP_FIXES
    elif software == "orca":
        fixes_db = _ORCA_FIXES
    else:
        fixes_db = []

    for entry in fixes_db:
        if entry["pattern"].lower() in error_msg.lower():
            if entry["fixes"]:
                return {
                    "diagnosis": entry["diagnosis"],
                    "fixes": entry["fixes"],
                    "tier": 2,
                }
            else:
                # Known error but no auto-fix -- escalate
                return {
                    "diagnosis": entry["diagnosis"],
                    "fixes": {},
                    "tier": 3,
                }

    return None  # Unknown error -- escalate


def apply_fix(db: WorkflowDB, task_id: str, fixes: dict) -> None:
    """Merge fixes into task params and reset to READY."""
    task = db.get_task(task_id)
    params = json.loads(task.get("params_json", "{}") or "{}")
    params.update(fixes)
    db.update_task(task_id, params_json=json.dumps(params))
    logger.info("Applied fix to task %s: %s", task_id, fixes)

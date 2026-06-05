"""Pure ORCA stdout-tail parsers for calculation-stage progress.

Engine-internal helpers with no FE/wire-format dependencies. Used by the
poller to derive a coarse-grained progress stage from the tail of an ORCA
output file (geometry-opt/freq via :func:`get_orca_stage`, IRC via
:func:`get_orca_irc_stage`).
"""

from __future__ import annotations
import re


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

"""LAMMPS engine hooks — wraps existing input generators for declarative framework."""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def generate_inputs(
    params: dict[str, Any],
    structure_str: Optional[str],
) -> tuple[dict[str, Any], Optional[str]]:
    """Pre-generate hook: generate LAMMPS input files using existing generator."""
    from workflow.engines.lammps import generate_lammps_input_files

    node_type = params.get("_node_type", "lammps_md")
    files = generate_lammps_input_files(node_type, params, structure_str)

    params["_generated_files"] = files
    return params, structure_str

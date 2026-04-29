"""CP2K engine hooks — wraps existing input generators for declarative framework."""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def generate_inputs(
    params: dict[str, Any],
    structure_str: Optional[str],
) -> tuple[dict[str, Any], Optional[str]]:
    """Pre-generate hook: generate CP2K input files using existing generator."""
    from workflow.engines.cp2k import generate_cp2k_input_files

    node_type = params.get("_node_type", "cp2k_static")
    files = generate_cp2k_input_files(node_type, params, structure_str)

    params["_generated_files"] = files
    return params, structure_str

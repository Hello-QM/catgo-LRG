"""Sella engine hooks — wraps existing input generators."""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def generate_inputs(
    params: dict[str, Any],
    structure_str: Optional[str],
) -> tuple[dict[str, Any], Optional[str]]:
    from workflow.engines.sella import generate_sella_input_files

    node_type = params.get("_node_type", "sella_ts")
    files = generate_sella_input_files(node_type, params, structure_str)
    params["_generated_files"] = files
    return params, structure_str

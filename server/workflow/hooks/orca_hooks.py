"""ORCA engine hooks — wraps existing input generators for declarative framework."""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def generate_inputs(
    params: dict[str, Any],
    structure_str: Optional[str],
) -> tuple[dict[str, Any], Optional[str]]:
    """Pre-generate hook: generate ORCA input files using existing generator.

    Returns (params, structure_str) with params['_generated_files'] containing
    the files dict from generate_orca_input_files().
    """
    from workflow.engines.orca import generate_orca_input_files

    node_type = params.get("_node_type", "orca_sp")
    product_str = params.get("_product_structure_str")

    files = generate_orca_input_files(node_type, params, structure_str, product_str)

    # Attach generated files to params for the runtime to upload
    params["_generated_files"] = files

    return params, structure_str

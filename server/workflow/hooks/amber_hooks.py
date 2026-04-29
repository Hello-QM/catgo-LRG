"""AMBER engine hooks — wraps existing input generators."""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def generate_inputs(
    params: dict[str, Any],
    structure_str: Optional[str],
) -> tuple[dict[str, Any], Optional[str]]:
    from workflow.engines.amber import _build_mdin

    node_type = params.get("_node_type", "amber_md")
    mdin_content = _build_mdin(node_type, params)
    params["_generated_files"] = {"mdin": mdin_content}
    return params, structure_str

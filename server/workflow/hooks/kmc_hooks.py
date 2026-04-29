"""KMC engine hooks — wraps existing input generators."""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def generate_inputs(
    params: dict[str, Any],
    structure_str: Optional[str],
) -> tuple[dict[str, Any], Optional[str]]:
    model_json = params.get("model_json", "{}")
    if isinstance(model_json, str):
        try:
            model = json.loads(model_json)
        except json.JSONDecodeError:
            model = {}
    else:
        model = model_json

    # Override T and U in model from params
    model["temperature"] = params.get("temperature", 300)
    model["potential"] = params.get("potential", 0.0)

    params["_generated_files"] = {"model.json": json.dumps(model, indent=2)}
    return params, structure_str

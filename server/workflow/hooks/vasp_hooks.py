"""VASP engine hooks — wraps existing input generators for declarative framework."""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def generate_inputs(
    params: dict[str, Any],
    structure_str: Optional[str],
) -> tuple[dict[str, Any], Optional[str]]:
    """Pre-generate hook: generate VASP input files using existing generator.

    VASP is special: generate_vasp_input_files returns (files, poscar_obj, pseudo_h_potcars).
    We store all three for the runtime to use during POTCAR generation.
    """
    from workflow.engines.vasp import generate_vasp_input_files

    node_type = params.get("_node_type", "vasp_relax")
    files, poscar_obj, pseudo_h_potcars = generate_vasp_input_files(node_type, params, structure_str)

    params["_generated_files"] = files
    # Store extra VASP-specific data for POTCAR generation
    params["_vasp_poscar_obj"] = poscar_obj
    params["_vasp_pseudo_h_potcars"] = pseudo_h_potcars

    return params, structure_str

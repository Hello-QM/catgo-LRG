"""FastAPI router for atomate2 workflow import and template access.

Provides endpoints to:
- Import a serialized atomate2 Flow JSON and convert it to CatGo graph format
- List and retrieve pre-built atomate2 workflow templates
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, File, HTTPException, UploadFile

from catgo.converters.atomate2.converter import atomate2_flow_to_catgo
from catgo.converters.atomate2.templates import ATOMATE2_TEMPLATES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/atomate2", tags=["atomate2"])


@router.post("/import-flow")
async def import_flow(file: UploadFile = File(...)):
    """Import an atomate2 Flow from a JSON file upload.

    Accepts the JSON output of ``flow.as_dict()`` (serialized via
    ``monty.json.MontyEncoder``). Returns a CatGo workflow graph
    ready for the editor.

    Returns
    -------
    dict
        ``{"nodes": [...], "edges": [...]}`` in CatGo graph format.
    """
    content = await file.read()
    try:
        flow_dict = json.loads(content)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid JSON: {exc}",
        )

    if not isinstance(flow_dict, dict):
        raise HTTPException(
            status_code=400,
            detail="Expected a JSON object (dict) at the top level.",
        )

    try:
        result = atomate2_flow_to_catgo(flow_dict)
    except Exception as exc:
        logger.exception("Failed to convert atomate2 flow")
        raise HTTPException(
            status_code=422,
            detail=f"Conversion error: {exc}",
        )

    return result


@router.get("/templates")
def list_templates():
    """List all available atomate2 workflow templates.

    Returns a list of template metadata (id, name, description,
    category, tags). The ``graph_json`` field contains the full
    CatGo graph as a JSON string.
    """
    return ATOMATE2_TEMPLATES


@router.get("/templates/{template_id}")
def get_template(template_id: str):
    """Get a specific atomate2 workflow template by ID.

    Parameters
    ----------
    template_id:
        The template identifier, e.g. ``"atomate2-double-relax"``.

    Returns
    -------
    dict
        The full template object including ``graph_json``.
    """
    for tpl in ATOMATE2_TEMPLATES:
        if tpl["id"] == template_id:
            return tpl
    raise HTTPException(
        status_code=404,
        detail=f"Template '{template_id}' not found.",
    )

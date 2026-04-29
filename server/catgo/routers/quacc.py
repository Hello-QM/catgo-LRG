"""FastAPI router for quacc workflow import and template access.

Endpoints:
- POST /quacc/import-flow  -- convert quacc source or job list to CatGo graph
- GET  /quacc/templates     -- list all quacc templates
- GET  /quacc/templates/{template_id} -- get a specific template
"""

from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from catgo.converters.quacc.converter import parse_quacc_flow, quacc_jobs_to_catgo
from catgo.converters.quacc.templates import QUACC_TEMPLATES, get_template

router = APIRouter(prefix="/quacc", tags=["quacc"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class JobDescription(BaseModel):
    """A single job in a declarative job list."""
    id: Optional[str] = None
    recipe: str = Field(..., description="Fully-qualified quacc recipe path")
    kwargs: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)


class ImportFlowRequest(BaseModel):
    """Request body for flow import.

    Supply exactly one of ``source`` or ``jobs``.
    """
    source: Optional[str] = Field(
        None,
        description="Python source code of a @flow-decorated function",
    )
    jobs: Optional[list[JobDescription]] = Field(
        None,
        description="Declarative list of job descriptions",
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/import-flow")
def import_flow(body: ImportFlowRequest) -> dict[str, Any]:
    """Import a quacc flow and convert to CatGo workflow graph.

    Accepts either:
    - ``source``: Python source code containing a ``@flow``-decorated function
    - ``jobs``: A list of job description dicts with recipe paths and dependencies
    """
    if body.source:
        try:
            result = parse_quacc_flow(body.source)
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to parse quacc flow source: {exc}",
            )
        return result

    if body.jobs:
        job_dicts = [j.model_dump() for j in body.jobs]
        try:
            result = quacc_jobs_to_catgo(job_dicts)
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to convert job list: {exc}",
            )
        return result

    raise HTTPException(
        status_code=400,
        detail="Provide either 'source' (Python code) or 'jobs' (job list).",
    )


@router.get("/templates")
def list_templates() -> list[dict[str, Any]]:
    """List all available quacc workflow templates (without full graph JSON)."""
    return [
        {k: v for k, v in t.items() if k != "graph_json"}
        for t in QUACC_TEMPLATES
    ]


@router.get("/templates/{template_id}")
def get_template_by_id(template_id: str) -> dict[str, Any]:
    """Get a specific quacc workflow template by ID, including graph JSON."""
    template = get_template(template_id)
    if template is None:
        raise HTTPException(
            status_code=404,
            detail=f"Template '{template_id}' not found.",
        )
    # Return with parsed graph_json for convenience
    result = dict(template)
    result["graph"] = json.loads(template["graph_json"])
    return result

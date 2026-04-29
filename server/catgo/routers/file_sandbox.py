"""REST endpoints for the CatBot file sandbox.

Provides a propose/approve/reject workflow for AI-generated files,
plus a direct-write path for trusted callers (e.g. Claude Code).
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from catgo.tools.file_sandbox import (
    stage_file,
    commit_file,
    reject_file,
    get_proposal,
    write_direct,
    get_template,
)

logger = logging.getLogger(__name__)

__all__ = ["router"]

router = APIRouter(prefix="/files/sandbox", tags=["file-sandbox"])


# ── Request models ──

class ProposeRequest(BaseModel):
    content: str
    target_path: str
    description: str = ""
    overwrite: bool = False


class WriteDirectRequest(BaseModel):
    content: str
    target_path: str


# ── Endpoints ──

@router.post("/propose")
def propose_file(req: ProposeRequest):
    """Stage a file for user review and approval."""
    try:
        result = stage_file(
            content=req.content,
            target_path=req.target_path,
            description=req.description,
            overwrite=req.overwrite,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{proposal_id}/approve")
def approve_file(proposal_id: str):
    """Approve and write a previously staged file."""
    try:
        result = commit_file(proposal_id)
        return result
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {e}")


@router.post("/{proposal_id}/reject")
def reject_proposal(proposal_id: str):
    """Reject and discard a staged file proposal."""
    try:
        result = reject_file(proposal_id)
        return result
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/write-direct")
def write_file_direct(req: WriteDirectRequest, request: Request):
    """Validate, audit, and write a file directly (no staging).

    Intended for the Claude Code path where human approval is implicit.
    Restricted to localhost connections only.
    """
    client_host = request.client.host if request.client else ""
    if client_host not in ("127.0.0.1", "::1"):
        raise HTTPException(status_code=403, detail="write-direct is restricted to localhost")
    try:
        result = write_direct(content=req.content, target_path=req.target_path)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {e}")


@router.get("/templates/{file_type}")
def get_file_template(file_type: str):
    """Return a starter template for a given file type.

    Supported types: plugin, script, workflow_node, config.
    """
    try:
        template = get_template(file_type)
        return {"file_type": file_type, "template": template}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{proposal_id}")
def get_file_proposal(proposal_id: str):
    """Retrieve a staged file proposal by ID."""
    proposal = get_proposal(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail=f"Proposal '{proposal_id}' not found")
    return proposal

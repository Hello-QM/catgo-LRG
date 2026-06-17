"""Campaign scaffolding HTTP route — POST /api/campaign/new.

md-orchestration campaigns live on disk (not the DB); this thin route lets the
GUI scaffold one by calling the campaign reference lib's scaffold_project. The
folder name is the readable slug of the project name (never a hash).
"""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from catgo.campaign_cli import run_campaign_cli

router = APIRouter(prefix="/campaign", tags=["campaign"])

_TEMPLATES = ("blank", "saa_her")


class CampaignCreateRequest(BaseModel):
    name: str
    base: str                       # parent directory (user-chosen location)
    template: str = "blank"


class CampaignRunRequest(BaseModel):
    action: str
    args: list[str] = []


def _campaign_lib():
    """Import the campaign reference lib shipped inside the catgo package."""
    import catgo
    scripts = str(Path(catgo.__file__).resolve().parent
                  / "workflow" / "skills" / "campaign" / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import campaign_lib
    return campaign_lib


@router.post("/new")
def create_campaign(req: CampaignCreateRequest) -> dict:
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    if req.template not in _TEMPLATES:
        raise HTTPException(
            status_code=400,
            detail=f"template must be one of {', '.join(_TEMPLATES)}")
    if not req.base.strip():
        raise HTTPException(status_code=400, detail="base (location) required")
    try:
        cl = _campaign_lib()
        base = Path(req.base).expanduser()
        root = cl.scaffold_project(base / cl.slugify(name), name,
                                   template=req.template)
    except Exception as exc:  # noqa: BLE001 — surface a clean 400 to the UI
        raise HTTPException(status_code=400, detail=f"scaffold failed: {exc}")
    return {"ok": True, "path": str(root), "name": name, "template": req.template}


@router.post("/run")
async def run_campaign(req: CampaignRunRequest) -> dict:
    """Run any `catgo campaign <action> <args>` for the client-direct (API)
    chat path, which can't reach the backend-only catgo_campaign MCP tool.
    Mirrors that tool; the action is enum-validated and no shell is used."""
    try:
        output, exit_code = await run_campaign_cli(
            req.action, [str(a) for a in req.args],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001 — surface a clean 500 to the UI
        raise HTTPException(status_code=500, detail=f"campaign run failed: {exc}")
    return {
        "ok": exit_code == 0,
        "action": req.action,
        "exit_code": exit_code,
        "output": output,
    }

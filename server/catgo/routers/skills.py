# server/routers/skills.py
"""REST API for reading SKILL.md workflow guides.

Exposes the same skill content that the MCP catgo_skills tool serves,
but via a lightweight REST endpoint so the frontend workflow tools can
fetch discussion checkpoints before building calculation workflows.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/skills", tags=["skills"])

_SKILLS_DIR = os.path.join(
    os.path.dirname(__file__), os.pardir, "workflow", "skills",
)


@router.get("/")
def list_skills():
    """List available skill paths."""
    skills: list[str] = []
    base = Path(_SKILLS_DIR).resolve()
    if not base.is_dir():
        return {"skills": []}
    for skill_file in sorted(base.rglob("SKILL.md")):
        rel = skill_file.parent.relative_to(base)
        path = str(rel).replace(os.sep, "/")
        if path and path != ".":
            skills.append(path)
    return {"skills": skills}


@router.get("/{skill_path:path}")
def read_skill(skill_path: str):
    """Read a SKILL.md file by path (e.g. 'vasp/relax', 'analysis/oer')."""
    if not skill_path:
        raise HTTPException(status_code=400, detail="skill_path is required")

    resolved = os.path.join(_SKILLS_DIR, skill_path.replace("/", os.sep), "SKILL.md")
    resolved = os.path.realpath(resolved)

    # Prevent path traversal
    base = os.path.realpath(_SKILLS_DIR)
    if not resolved.startswith(base):
        raise HTTPException(status_code=400, detail="Invalid skill path")

    if not os.path.isfile(resolved):
        raise HTTPException(
            status_code=404,
            detail=f"Skill not found: {skill_path}. Use GET /api/skills/ to list available skills.",
        )

    try:
        with open(resolved, "r", encoding="utf-8") as f:
            content = f.read()
        return {"skill_path": skill_path, "content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading skill: {e}")

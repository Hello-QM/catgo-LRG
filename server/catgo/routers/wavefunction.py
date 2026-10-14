"""Wavefunction files: orbital listing and Multiwfn-generated orbital cubes."""

from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from catgo.utils.multiwfn import GRID_CHOICES, MultiwfnError, find_multiwfn, orbital_cube
from catgo.utils.wavefunction_parser import (
    SUPPORTED_SUFFIXES,
    WavefunctionParseError,
    detect_format,
    parse_wavefunction,
)

router = APIRouter(prefix="/wavefunction", tags=["wavefunction"])

CACHE_DIR = Path(tempfile.gettempdir()) / "catgo-wavefunction-cache"
_SESSION_RE = re.compile(r"^[0-9a-f]{32}$")
_MAX_SESSIONS = 20


def _session_file(session_id: str) -> Path:
    if not _SESSION_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
    folder = CACHE_DIR / session_id
    files = [p for p in folder.iterdir() if p.is_file()] if folder.is_dir() else []
    if not files:
        raise HTTPException(status_code=404, detail="Wavefunction session not found; load the file again")
    return files[0]


def _prune_sessions() -> None:
    """Keep only the most recent sessions; wavefunction files can be large."""
    if not CACHE_DIR.is_dir():
        return
    folders = sorted(
        (p for p in CACHE_DIR.iterdir() if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in folders[_MAX_SESSIONS:]:
        shutil.rmtree(old, ignore_errors=True)


@router.get("/multiwfn-status")
def multiwfn_status(path: str | None = Query(None, description="Optional Multiwfn executable or folder")):
    """Report whether Multiwfn can be found (and where)."""
    found, source = find_multiwfn(path or None)
    return {"found": bool(found), "path": found, "source": source}


@router.post("/load")
async def load_wavefunction(file: UploadFile = File(...)):
    """Store a wavefunction file and return its atoms and orbital list."""
    filename = Path(file.filename or "").name
    if not detect_format(filename):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type; expected one of {', '.join(SUPPORTED_SUFFIXES)}",
        )
    content = await file.read()
    try:
        text = content.decode("utf-8", errors="replace")
        result = await asyncio.to_thread(parse_wavefunction, text, filename)
    except WavefunctionParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    session_id = uuid.uuid4().hex
    folder = CACHE_DIR / session_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / filename).write_bytes(content)
    _prune_sessions()

    result["session_id"] = session_id
    return result


class OrbitalCubeRequest(BaseModel):
    session_id: str
    orbital_index: int
    grid: str = "medium"
    multiwfn_path: str | None = None


@router.post("/orbital-cube", response_class=PlainTextResponse)
async def orbital_cube_endpoint(req: OrbitalCubeRequest):
    """Run Multiwfn to grid one orbital and return the cube file text."""
    if req.grid not in GRID_CHOICES:
        raise HTTPException(status_code=400, detail=f"grid must be one of {sorted(GRID_CHOICES)}")
    if req.orbital_index < 1:
        raise HTTPException(status_code=400, detail="orbital_index is 1-based")
    path = _session_file(req.session_id)
    executable, _ = find_multiwfn(req.multiwfn_path or None)
    if not executable:
        raise HTTPException(
            status_code=424,
            detail="Multiwfn not found. Set its path in the orbital panel, or set CATGO_MULTIWFN / "
            "Multiwfnpath, or put Multiwfn on PATH.",
        )
    try:
        cube = await asyncio.to_thread(
            orbital_cube, path, req.orbital_index, req.grid, executable
        )
    except MultiwfnError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return PlainTextResponse(cube, media_type="chemical/x-cube")

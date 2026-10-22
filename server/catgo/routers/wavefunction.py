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

from catgo.utils.cube_grid import read_cube, write_cube
from catgo.utils.multiwfn import (
    GRID_CHOICES,
    MultiwfnError,
    aim_cpprop,
    find_multiwfn,
    grid_function_cube,
    igmh_cubes,
    load_recipes,
    orbital_cube,
)
from catgo.utils.wavefunction_analysis import (
    iri_grid,
    pair_bond_paths,
    parse_cpprop,
    parse_nbo,
    same_grid,
    scatter_plot,
)
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


_MISSING_MULTIWFN = (
    "Multiwfn not found. Set its path in the orbital panel, or set CATGO_MULTIWFN / "
    "Multiwfnpath, or put Multiwfn on PATH."
)


def _executable(path: str | None) -> str:
    executable, _ = find_multiwfn(path or None)
    if not executable:
        raise HTTPException(status_code=424, detail=_MISSING_MULTIWFN)
    return executable


def _check_grid(grid: str) -> None:
    if grid not in GRID_CHOICES:
        raise HTTPException(status_code=400, detail=f"grid must be one of {sorted(GRID_CHOICES)}")


async def _run(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except MultiwfnError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/multiwfn-recipes")
def multiwfn_recipes():
    """Keystroke recipes in use (defaults merged with the override file)."""
    recipes, codes = load_recipes()
    return {"recipes": recipes, "grid_function_codes": codes}


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
    executable = _executable(req.multiwfn_path)
    cube = await _run(orbital_cube, path, req.orbital_index, req.grid, executable)
    return PlainTextResponse(cube, media_type="chemical/x-cube")


class AnalysisRequest(BaseModel):
    session_id: str
    grid: str = "medium"
    multiwfn_path: str | None = None


class GridCubeRequest(AnalysisRequest):
    function: str


@router.post("/grid-cube", response_class=PlainTextResponse)
async def grid_cube_endpoint(req: GridCubeRequest):
    """Cube of density, gradient, laplacian, esp or sl2r via Multiwfn."""
    _check_grid(req.grid)
    path = _session_file(req.session_id)
    executable = _executable(req.multiwfn_path)
    cube = await _run(grid_function_cube, path, req.function, req.grid, executable)
    return PlainTextResponse(cube, media_type="chemical/x-cube")


def _iri(path, grid: str, executable: str) -> dict:
    rho = read_cube(grid_function_cube(path, "density", grid, executable))
    grad = read_cube(grid_function_cube(path, "gradient", grid, executable))
    sl2r_text = grid_function_cube(path, "sl2r", grid, executable)
    sl2r = read_cube(sl2r_text)
    if not (same_grid(rho, grad) and same_grid(rho, sl2r)):
        raise MultiwfnError("Multiwfn produced density/gradient/sign(λ2)ρ cubes on different grids")
    iri = iri_grid(rho.data, grad.data)
    return {
        "iri_cube": write_cube(rho, iri, "IRI = |grad rho| / rho^1.1 (CatGo)"),
        "sl2r_cube": sl2r_text,
        "scatter": scatter_plot(sl2r.data, iri, "IRI", 1.5),
    }


@router.post("/iri")
async def iri_endpoint(req: AnalysisRequest):
    """Interaction region indicator: IRI cube, sign(λ2)ρ cube and scatter data."""
    _check_grid(req.grid)
    path = _session_file(req.session_id)
    return await _run(_iri, path, req.grid, _executable(req.multiwfn_path))


class IgmhRequest(AnalysisRequest):
    fragments: list[list[int]]


def _igmh(path, fragments, grid: str, executable: str) -> dict:
    cubes = igmh_cubes(path, fragments, grid, executable)
    dg = read_cube(cubes["dg_inter.cub"])
    sl2r = read_cube(cubes["sl2r.cub"])
    if not same_grid(dg, sl2r):
        raise MultiwfnError("dg_inter.cub and sl2r.cub are on different grids")
    return {
        "dg_inter_cube": cubes["dg_inter.cub"],
        "sl2r_cube": cubes["sl2r.cub"],
        "scatter": scatter_plot(sl2r.data, dg.data, "δg_inter (a.u.)", 0.1),
    }


@router.post("/igmh")
async def igmh_endpoint(req: IgmhRequest):
    """IGMH between fragments (1-based atom indices): δg_inter and sign(λ2)ρ."""
    _check_grid(req.grid)
    path = _session_file(req.session_id)
    return await _run(_igmh, path, req.fragments, req.grid, _executable(req.multiwfn_path))


def _esp(path, grid: str, executable: str) -> dict:
    density = grid_function_cube(path, "density", grid, executable)
    esp = grid_function_cube(path, "esp", grid, executable)
    if not same_grid(read_cube(density), read_cube(esp)):
        raise MultiwfnError("density and ESP cubes are on different grids")
    return {"density_cube": density, "esp_cube": esp}


@router.post("/esp")
async def esp_endpoint(req: AnalysisRequest):
    """Density and ESP cubes for an ESP-mapped ρ = 0.001 a.u. surface."""
    _check_grid(req.grid)
    path = _session_file(req.session_id)
    return await _run(_esp, path, req.grid, _executable(req.multiwfn_path))


def _aim(path, executable: str) -> dict:
    cps = parse_cpprop(aim_cpprop(path, executable))
    if not cps:
        raise MultiwfnError("CPprop.txt contained no critical points")
    text = Path(path).read_text(errors="replace")
    atoms = parse_wavefunction(text, Path(path).name)["atoms"]
    paths = pair_bond_paths(cps, atoms)
    counts: dict[str, int] = {}
    for cp in cps:
        counts[cp["kind"]] = counts.get(cp["kind"], 0) + 1
    return {"critical_points": cps, "bond_paths": paths, "counts": counts}


@router.post("/aim")
async def aim_endpoint(req: AnalysisRequest):
    """QTAIM critical points (Multiwfn topology analysis) and bond paths."""
    path = _session_file(req.session_id)
    return await _run(_aim, path, _executable(req.multiwfn_path))


@router.post("/nbo")
async def nbo_endpoint(file: UploadFile = File(...)):
    """Parse NBO results (charges, Wiberg indices, E(2)) from a .log/.out file."""
    text = (await file.read()).decode("utf-8", errors="replace")
    try:
        return await asyncio.to_thread(parse_nbo, text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

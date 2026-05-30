"""Cube file processing router - isosurface extraction and slice generation.

Uses the high-performance Rust `cube-processor` binary for computation.
"""

import asyncio
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

router = APIRouter(prefix="/cube", tags=["cube"])

# Path to the Rust binary (relative to server directory)
CUBE_PROCESSOR = (
    Path(__file__).parent.parent.parent.parent / "tools" / "cube-processor" / "target" / "release" / "cube-processor"
)

# Cache directory for uploaded cube files and results
CACHE_DIR = Path(tempfile.gettempdir()) / "catgo-cube-cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _run_cube_processor(args: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    """Run the cube-processor binary with the given arguments."""
    if not CUBE_PROCESSOR.exists():
        raise HTTPException(
            status_code=503,
            detail=f"cube-processor binary not found at {CUBE_PROCESSOR}. "
            "Build it with: cd tools/cube-processor && cargo build --release",
        )
    cmd = [str(CUBE_PROCESSOR)] + args
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"cube-processor failed: {result.stderr}",
            )
        return result
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="cube-processor timed out")


@router.post("/upload")
async def upload_cube_file(file: UploadFile = File(...)):
    """Upload a cube file and return its metadata.

    The file is cached for subsequent isosurface/slice operations.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    # Save uploaded file
    cube_path = CACHE_DIR / file.filename
    content = await file.read()
    cube_path.write_bytes(content)

    # Get info
    result = await asyncio.to_thread(_run_cube_processor, ["info", str(cube_path)])

    # Parse the info output
    lines = result.stdout.strip().split("\n")
    info = {"filename": file.filename, "path": str(cube_path), "raw_info": result.stdout}

    return JSONResponse(content=info)


@router.post("/info")
async def cube_info(file: UploadFile = File(...)):
    """Get metadata about a cube file without caching it."""
    with tempfile.NamedTemporaryFile(suffix=".cube", delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        result = await asyncio.to_thread(_run_cube_processor, ["info", tmp_path])
        return {"info": result.stdout}
    finally:
        Path(tmp_path).unlink(missing_ok=True)


class IsosurfaceRequest(BaseModel):
    """Request parameters for isosurface extraction."""
    filepath: str
    isovalue: float = 0.05
    dual: bool = False
    decimate: Optional[float] = None
    format: str = "json"  # "json", "glb", "obj"


@router.post("/isosurface")
def extract_isosurface(request: IsosurfaceRequest):
    """Extract isosurface mesh from a cube file.

    Returns vertex positions, normals, and indices as JSON,
    or as GLB/OBJ binary download.
    """
    cube_path = Path(request.filepath)
    if not cube_path.exists():
        raise HTTPException(status_code=404, detail=f"Cube file not found: {request.filepath}")

    if request.format == "json":
        args = ["json", str(cube_path), "--iso", str(request.isovalue)]
        if request.dual:
            args.append("--dual")
        if request.decimate:
            args.extend(["--decimate", str(request.decimate)])

        result = _run_cube_processor(args)
        mesh_data = json.loads(result.stdout)
        return JSONResponse(content=mesh_data)

    elif request.format in ("glb", "obj"):
        out_suffix = f".{request.format}"
        out_path = CACHE_DIR / f"isosurface{out_suffix}"
        args = [
            "isosurface",
            str(cube_path),
            "--iso",
            str(request.isovalue),
            "--format",
            request.format,
            "-o",
            str(out_path),
        ]
        if request.dual:
            args.append("--dual")
        if request.decimate:
            args.extend(["--decimate", str(request.decimate)])

        _run_cube_processor(args)

        media_type = "model/gltf-binary" if request.format == "glb" else "text/plain"
        return FileResponse(
            str(out_path),
            media_type=media_type,
            filename=f"isosurface{out_suffix}",
        )
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {request.format}")


class SliceRequest(BaseModel):
    """Request parameters for slice extraction."""
    filepath: str
    axis: str = "z"  # "x", "y", "z"
    position: float = 0.5  # fractional position 0.0-1.0
    colormap: str = "blue-white-red"
    format: str = "png"  # "png" or "raw"


@router.post("/slice")
def extract_slice(request: SliceRequest):
    """Extract a 2D cross-section slice from a cube file.

    Returns PNG image or raw float32 binary data.
    """
    cube_path = Path(request.filepath)
    if not cube_path.exists():
        raise HTTPException(status_code=404, detail=f"Cube file not found: {request.filepath}")

    if request.format == "png":
        out_path = CACHE_DIR / "slice.png"
    else:
        out_path = CACHE_DIR / "slice.bin"

    args = [
        "slice",
        str(cube_path),
        "--axis",
        request.axis,
        "--position",
        str(request.position),
        "--colormap",
        request.colormap,
        "-o",
        str(out_path),
    ]

    _run_cube_processor(args)

    if request.format == "png":
        return FileResponse(str(out_path), media_type="image/png", filename="slice.png")
    else:
        return FileResponse(
            str(out_path),
            media_type="application/octet-stream",
            filename="slice.bin",
        )


class PlaneSliceRequest(BaseModel):
    """Request parameters for arbitrary plane slice."""
    filepath: str
    normal: list[float]  # [nx, ny, nz]
    center: list[float]  # [cx, cy, cz] in Angstroms
    colormap: str = "blue-white-red"
    resolution: float = 1.0


@router.post("/plane-slice")
def extract_plane_slice(request: PlaneSliceRequest):
    """Extract a 2D slice along an arbitrary plane defined by normal and center."""
    cube_path = Path(request.filepath)
    if not cube_path.exists():
        raise HTTPException(status_code=404, detail=f"Cube file not found: {request.filepath}")

    if len(request.normal) != 3 or len(request.center) != 3:
        raise HTTPException(status_code=400, detail="normal and center must each have 3 values")

    out_path = CACHE_DIR / "plane_slice.png"

    args = [
        "plane-slice",
        str(cube_path),
        "--normal",
        str(request.normal[0]), str(request.normal[1]), str(request.normal[2]),
        "--center",
        str(request.center[0]), str(request.center[1]), str(request.center[2]),
        "--colormap",
        request.colormap,
        "--resolution",
        str(request.resolution),
        "-o",
        str(out_path),
    ]

    _run_cube_processor(args)

    return FileResponse(str(out_path), media_type="image/png", filename="plane_slice.png")


@router.get("/cached-files")
def list_cached_files():
    """List cube files currently in the cache."""
    files = []
    for f in CACHE_DIR.glob("*.cube"):
        files.append({
            "filename": f.name,
            "filepath": str(f),
            "size_mb": f.stat().st_size / 1e6,
        })
    return {"files": files}

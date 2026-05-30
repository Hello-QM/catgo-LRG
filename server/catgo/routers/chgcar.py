"""CHGCAR file processing router — convert VASP CHGCAR to Gaussian cube format.

Uses the high-performance Rust `cube-processor` binary for conversion.
CHGCAR files contain volumetric charge density data from VASP calculations.
This router converts them to .cube format so they can be visualized using
the existing CubeViewer infrastructure.
"""

import asyncio
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

router = APIRouter(prefix="/chgcar", tags=["chgcar"])

# Path to the Rust binary (same as cube.py). __file__ is
# server/catgo/routers/chgcar.py, so four .parent hops reach the repo root
# where tools/cube-processor lives (three only reached server/, which has no
# tools/ → binary never found even when built).
CUBE_PROCESSOR = (
    Path(__file__).parent.parent.parent.parent
    / "tools"
    / "cube-processor"
    / "target"
    / "release"
    / "cube-processor"
)

# Cache directory for uploaded/converted files
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


@router.post("/convert-to-cube")
async def convert_chgcar_to_cube(file: UploadFile = File(...)):
    """Convert a CHGCAR/AECCAR/LOCPOT file to Gaussian cube format.

    Uses the Rust cube-processor binary for high-performance conversion.
    Returns the cube file content as text, which can be directly loaded
    into the CubeViewer for visualization.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    content_bytes = await file.read()

    # Save CHGCAR to temp file for Rust binary
    chgcar_path = CACHE_DIR / file.filename
    chgcar_path.write_bytes(content_bytes)

    # Output cube file path
    cube_filename = Path(file.filename).stem + ".cube"
    cube_path = CACHE_DIR / cube_filename

    # Run Rust binary: cube-processor convert-chgcar <input> -o <output>
    await asyncio.to_thread(_run_cube_processor, ["convert-chgcar", str(chgcar_path), "-o", str(cube_path)])

    cube_text = cube_path.read_text(encoding="utf-8")

    return Response(
        content=cube_text,
        media_type="chemical/x-cube",
        headers={
            "Content-Disposition": f'attachment; filename="{cube_filename}"',
            "X-Cube-Filepath": str(cube_path),
        },
    )


@router.post("/compute-diff")
async def compute_chgdiff(
    file_ab: UploadFile = File(..., description="CHGCAR of combined system (AB)"),
    file_a: UploadFile = File(..., description="CHGCAR of subsystem A"),
    file_b: UploadFile = File(..., description="CHGCAR of subsystem B"),
):
    """Compute difference charge density rho_AB - rho_A - rho_B.

    Uses the Rust cube-processor binary for high-performance computation.
    Accepts three CHGCAR files and returns the difference in Gaussian cube format
    for 3D isosurface visualization.
    """
    # Save all three files to cache
    paths = {}
    for label, f in [("AB", file_ab), ("A", file_a), ("B", file_b)]:
        raw = await f.read()
        filename = f.filename or f"CHGCAR_{label}"
        path = CACHE_DIR / f"chgdiff_{label}_{filename}"
        path.write_bytes(raw)
        paths[label] = str(path)

    # Output cube file path
    cube_filename = "CHGCAR_diff.cube"
    cube_path = CACHE_DIR / cube_filename

    # Run Rust binary: cube-processor chgdiff <AB> <A> <B> -o <output>
    await asyncio.to_thread(
        _run_cube_processor,
        ["chgdiff", paths["AB"], paths["A"], paths["B"], "-o", str(cube_path)],
    )

    cube_text = cube_path.read_text(encoding="utf-8")

    return Response(
        content=cube_text,
        media_type="chemical/x-cube",
        headers={
            "Content-Disposition": f'attachment; filename="{cube_filename}"',
            "X-Cube-Filepath": str(cube_path),
        },
    )

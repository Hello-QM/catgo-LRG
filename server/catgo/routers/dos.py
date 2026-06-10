"""DOS analysis API endpoints.

Provides endpoints for uploading VASP HDF5 files and vasprun.xml files,
and computing projected density of states (PDOS) and d-band properties.
"""

import logging
import math
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException, UploadFile

# Add dos-analysis library to path
_ext_dir = Path(__file__).resolve().parent.parent.parent / "extensions" / "dos-analysis"
if str(_ext_dir) not in sys.path:
    sys.path.insert(0, str(_ext_dir))

from catgo.models.dos import (
    AtomSelectionRequest,
    DBandRequest,
    DBandResponse,
    DOSUploadResponse,
    PDOSRequest,
    PDOSResponse,
    PDOSSeries,
    TotalDOSRequest,
)

router = APIRouter(prefix="/dos", tags=["dos"])


@dataclass
class DOSSession:
    """Session holding VaspData from any source (h5, procar, etc.)."""

    data: Any  # VaspData
    source: str  # "h5" or "procar"
    timestamp: float


# In-memory session cache: session_id -> DOSSession
_sessions: Dict[str, DOSSession] = {}
_SESSION_TTL = 1800  # 30 minutes


def _cleanup_expired():
    """Remove sessions older than TTL."""
    now = time.time()
    expired = [sid for sid, s in _sessions.items() if now - s.timestamp > _SESSION_TTL]
    for sid in expired:
        del _sessions[sid]


def _get_session(session_id: str) -> DOSSession:
    """Retrieve DOSSession from cache, raising 404 if not found."""
    _cleanup_expired()
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found or expired")
    session = _sessions[session_id]
    session.timestamp = time.time()  # refresh timestamp
    return session


def _get_data(session_id: str):
    """Retrieve VaspData from cache (backwards compat helper)."""
    return _get_session(session_id).data


def _vasp_data_to_pymatgen(data) -> dict:
    """Convert VaspData to a PymatgenStructure dict for the 3D viewer."""
    import numpy as np

    lattice_matrix = data.lattice.tolist()  # (3,3)

    # Compute lattice parameters
    a_vec = np.array(lattice_matrix[0])
    b_vec = np.array(lattice_matrix[1])
    c_vec = np.array(lattice_matrix[2])

    a = float(np.linalg.norm(a_vec))
    b = float(np.linalg.norm(b_vec))
    c = float(np.linalg.norm(c_vec))

    alpha = float(np.degrees(np.arccos(np.clip(np.dot(b_vec, c_vec) / (b * c), -1, 1))))
    beta = float(np.degrees(np.arccos(np.clip(np.dot(a_vec, c_vec) / (a * c), -1, 1))))
    gamma = float(np.degrees(np.arccos(np.clip(np.dot(a_vec, b_vec) / (a * b), -1, 1))))

    volume = float(abs(np.linalg.det(data.lattice)))

    # Build sites
    sites = []
    for i in range(data.nions):
        elem = str(data.elements[i])
        sites.append({
            "species": [{"element": elem, "occu": 1, "oxidation_state": 0}],
            "abc": data.positions_frac[i].tolist(),
            "xyz": data.positions[i].tolist(),
            "label": elem,
            "properties": {},
        })

    return {
        "lattice": {
            "matrix": lattice_matrix,
            "pbc": [True, True, True],
            "volume": volume,
            "a": a, "b": b, "c": c,
            "alpha": alpha, "beta": beta, "gamma": gamma,
        },
        "sites": sites,
        "charge": 0,
    }


def _create_session(data, source: str = "h5") -> DOSUploadResponse:
    """Create a DOS session from VaspData and return the response."""
    import numpy as np

    session_id = str(uuid.uuid4())
    _sessions[session_id] = DOSSession(data=data, source=source, timestamp=time.time())
    _cleanup_expired()

    elements = data.elements.tolist() if isinstance(data.elements, np.ndarray) else list(data.elements)
    structure = _vasp_data_to_pymatgen(data)

    # Ensure all values are native Python types (not numpy) for JSON serialization
    return DOSUploadResponse(
        session_id=session_id,
        nions=int(data.nions),
        nkpts=int(data.nkpts),
        nbands=int(data.nbands),
        nchannels=int(data.nchannels),
        nspin=int(data.nspin),
        elements=[str(e) for e in elements],
        ion_types=[str(t) for t in data.ion_types],
        ion_counts=[int(c) for c in data.ion_counts],
        efermi=float(data.efermi),
        structure=structure,
    )


@router.post("/upload", response_model=DOSUploadResponse)
async def upload_h5(file: UploadFile) -> DOSUploadResponse:
    """Upload a vaspout.h5 file and return session metadata + structure."""
    import tempfile
    from catgo_dos.io import read_vaspout_h5

    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    suffix = Path(file.filename).suffix or ".h5"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        data = read_vaspout_h5(tmp_path)
    except Exception as e:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Failed to read HDF5 file: {e}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    try:
        return _create_session(data, source="h5")
    except Exception as e:
        logger.error("Failed to create H5 session: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create session: {e}")


@router.post("/upload-procar", response_model=DOSUploadResponse)
async def upload_procar(
    procar: UploadFile,
    outcar: Optional[UploadFile] = None,
    poscar: Optional[UploadFile] = None,
    efermi: Optional[float] = None,
) -> DOSUploadResponse:
    """Upload PROCAR (+ optional OUTCAR and POSCAR) and create a DOS session.

    The PROCAR file contains eigenvalues and orbital projections.
    OUTCAR provides the Fermi energy. POSCAR provides structure info.
    """
    import numpy as np
    from catgo_dos.io import read_procar, extract_efermi_outcar

    if not procar.filename:
        raise HTTPException(status_code=400, detail="No PROCAR file provided")

    procar_text = (await procar.read()).decode("utf-8", errors="replace")

    # Extract Fermi energy from OUTCAR
    ef = 0.0
    if efermi is not None:
        ef = efermi
    elif outcar is not None:
        outcar_text = (await outcar.read()).decode("utf-8", errors="replace")
        try:
            ef = extract_efermi_outcar(outcar_text)
        except ValueError:
            logger.warning("Could not extract E-fermi from OUTCAR, using 0.0")

    # Parse POSCAR for structure
    poscar_text = None
    if poscar is not None:
        poscar_text = (await poscar.read()).decode("utf-8", errors="replace")

    try:
        data = read_procar(procar_text, efermi=ef, poscar_text=poscar_text)
    except Exception as e:
        logger.error("Failed to parse PROCAR: %s", e, exc_info=True)
        raise HTTPException(status_code=400, detail=f"Failed to parse PROCAR: {e}")

    try:
        return _create_session(data, source="procar")
    except Exception as e:
        logger.error("Failed to create PROCAR session: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create session: {e}")


@router.post("/from-remote")
async def dos_from_remote(session_id: str, remote_path: str):
    """Download vaspout.h5 from HPC and create a DOS analysis session.

    Downloads the file via SSH, parses it, and creates a session
    just like the upload endpoint.
    """
    import tempfile
    import numpy as np
    from catgo_dos.io import read_vaspout_h5

    try:
        from catgo.utils.hpc_client import pool
        hpc = pool.get_connection(session_id)
        if not hpc:
            raise HTTPException(status_code=503, detail=f"HPC session {session_id} not connected")

        # Download file to temp location
        with tempfile.NamedTemporaryFile(suffix=".h5", delete=False) as tmp:
            tmp_path = tmp.name

        await hpc.download_to_local(remote_path, tmp_path)

        try:
            data = read_vaspout_h5(tmp_path)
        except Exception as e:
            Path(tmp_path).unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=f"Failed to read HDF5 file: {e}")
        finally:
            Path(tmp_path).unlink(missing_ok=True)

        return _create_session(data, source="h5")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download from HPC: {e}")


@router.post("/from-directory", response_model=DOSUploadResponse)
async def dos_from_directory(session_id: str, remote_path: str):
    """Auto-detect DOS data files from a remote directory.

    Looks for PROCAR (preferred) or vaspout.h5 (fallback).
    For PROCAR: also reads OUTCAR (efermi) and CONTCAR/POSCAR (structure).
    """
    import shlex
    import tempfile
    from catgo_dos.io import read_procar, extract_efermi_outcar, read_vaspout_h5

    try:
        from catgo.utils.hpc_client import pool
        hpc = pool.get_connection(session_id)
        if not hpc:
            raise HTTPException(status_code=503, detail=f"HPC session {session_id} not connected")

        async def _read_remote_text(path: str) -> str:
            """Read a remote text file via SSH, gzip-compressed in transit.

            PROCAR/OUTCAR are large text files and the remote link can be slow
            (~0.2 MB/s through a ProxyJump to shaheen). gzip+base64 cuts the
            transfer ~6x (text compresses well; a 20 MB PROCAR drops to ~2.3 MB
            and ~15 s vs ~100 s). The large timeout still guards the slow path.
            Falls back to plain `cat` if the compressed read isn't decodable.
            """
            import base64 as _b64
            import gzip as _gzip
            r = await hpc.conn.run(
                f"gzip -c {shlex.quote(path)} 2>/dev/null | base64",
                check=False, timeout=900,
            )
            if r.exit_status == 0 and r.stdout.strip():
                try:
                    return _gzip.decompress(_b64.b64decode(r.stdout)).decode(
                        "utf-8", errors="replace"
                    )
                except Exception:
                    logger.warning("gzip read failed for %s; falling back to cat", path)
            r = await hpc.conn.run(
                f"cat {shlex.quote(path)} 2>/dev/null", check=False, timeout=900
            )
            if r.exit_status != 0 or not r.stdout:
                return ""
            return r.stdout

        # List directory to find files
        resolved, files = await hpc.list_remote_dir(remote_path)
        file_names = {f.name: f.path for f in files if not f.is_dir}

        # Try PROCAR first (preferred — has orbital projections)
        procar_path = None
        for name in ["PROCAR", "PROCAR.gz"]:
            if name in file_names:
                procar_path = file_names[name]
                break

        if procar_path:
            # PROCAR path
            procar_text = await _read_remote_text(procar_path)
            if not procar_text:
                raise HTTPException(status_code=400, detail="PROCAR file is empty")

            # Read OUTCAR for efermi (optional)
            ef = 0.0
            for name in ["OUTCAR", "OUTCAR.gz"]:
                if name in file_names:
                    outcar_text = await _read_remote_text(file_names[name])
                    if outcar_text:
                        try:
                            ef = extract_efermi_outcar(outcar_text)
                        except ValueError:
                            logger.warning("Could not extract E-fermi from OUTCAR")
                    break

            # Read CONTCAR or POSCAR (optional)
            poscar_text = None
            for name in ["CONTCAR", "POSCAR"]:
                if name in file_names:
                    poscar_text = await _read_remote_text(file_names[name])
                    if poscar_text:
                        break

            data = read_procar(procar_text, efermi=ef, poscar_text=poscar_text)
            return _create_session(data, source="procar")

        # Fallback: vaspout.h5
        h5_path = None
        for name in ["vaspout.h5"]:
            if name in file_names:
                h5_path = file_names[name]
                break

        if h5_path:
            with tempfile.NamedTemporaryFile(suffix=".h5", delete=False) as tmp:
                tmp_path = tmp.name
            try:
                await hpc.download_to_local(h5_path, tmp_path)
                data = read_vaspout_h5(tmp_path)
            finally:
                Path(tmp_path).unlink(missing_ok=True)
            return _create_session(data, source="h5")

        # Nothing found
        available = ", ".join(sorted(file_names.keys())[:20])
        raise HTTPException(
            status_code=404,
            detail=f"No PROCAR or vaspout.h5 found in {resolved}. Files: {available}"
        )

    except HTTPException:
        raise
    except Exception as e:
        # Log the full traceback and surface the exception TYPE in the detail —
        # some failures (e.g. asyncio.TimeoutError) have an empty str(), which
        # produced the useless "Failed to load from directory: " message.
        logger.exception("dos_from_directory failed for remote_path=%s", remote_path)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to load from directory: {type(e).__name__}: {e}".rstrip(": "),
        )


## ---------- Compute Endpoints (unified VaspData path) ---------- ##


@router.post("/compute", response_model=PDOSResponse)
def compute_pdos(request: PDOSRequest) -> PDOSResponse:
    """Compute projected DOS for one or more atom/orbital groups."""
    session = _get_session(request.session_id)
    from catgo_dos.pdos import compute_pdos_groups

    groups = [
        {
            "atoms": g.atoms,
            "channels": g.channels,
            "label": g.label,
            "normalize": g.normalize,
        }
        for g in request.groups
    ]

    data = session.data
    try:
        results = compute_pdos_groups(
            data,
            groups,
            sigma=request.sigma,
            emin=request.emin,
            emax=request.emax,
            ngrid=request.ngrid,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PDOS computation failed: {e}")

    series = []
    for res in results:
        s = PDOSSeries(
            label=res.label,
            spin_up=res.pdos[0].tolist(),
            spin_down=res.pdos[1].tolist() if res.pdos.shape[0] > 1 else None,
        )
        series.append(s)

    return PDOSResponse(
        grid=results[0].grid.tolist(),
        series=series,
        efermi=data.efermi,
    )


@router.post("/total", response_model=PDOSResponse)
def compute_total_dos(request: TotalDOSRequest) -> PDOSResponse:
    """Compute total density of states."""
    session = _get_session(request.session_id)
    from catgo_dos.pdos import compute_total_dos as _compute_total

    data = session.data
    try:
        result = _compute_total(
            data,
            sigma=request.sigma,
            emin=request.emin,
            emax=request.emax,
            ngrid=request.ngrid,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Total DOS computation failed: {e}")

    return PDOSResponse(
        grid=result.grid.tolist(),
        series=[
            PDOSSeries(
                label="Total DOS",
                spin_up=result.pdos[0].tolist(),
                spin_down=result.pdos[1].tolist() if result.pdos.shape[0] > 1 else None,
            )
        ],
        efermi=data.efermi,
    )


@router.post("/dband", response_model=DBandResponse)
def compute_dband(request: DBandRequest) -> DBandResponse:
    """Compute d-band properties for selected atoms."""
    session = _get_session(request.session_id)
    from catgo_dos.dband import analyze_d_band

    data = session.data
    try:
        props = analyze_d_band(
            data,
            atoms=request.atoms,
            occupied_only_center=request.occupied_only_center,
            sigma=request.sigma,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"D-band analysis failed: {e}")

    return DBandResponse(
        center_abs=props.center.eps_abs,
        center_rel=props.center.eps_rel,
        width=props.width.width,
        variance=props.width.variance,
        n_d=props.filling.n_d,
        total_d_weight=props.filling.total_weight,
        filling_fraction=props.filling.filling_fraction,
        skewness=props.moments.skewness,
        kurtosis=props.moments.kurtosis,
        lower_edge=props.lower_edge,
        upper_edge=props.upper_edge,
    )


def _select_by_element(elements, requested: list[str]) -> list[int]:
    wanted = {str(e).strip() for e in requested if str(e).strip()}
    return [idx for idx, element in enumerate(elements) if str(element).strip() in wanted]


def _select_by_index(index_spec: str, nions: int) -> list[int]:
    atoms: set[int] = set()
    for raw_part in index_spec.split(","):
        part = raw_part.strip()
        if not part:
            continue

        if "-" in part:
            bounds = [p.strip() for p in part.split("-", 1)]
            if len(bounds) != 2 or not bounds[0].isdigit() or not bounds[1].isdigit():
                raise HTTPException(status_code=400, detail=f"Invalid atom index range: {part}")
            start = int(bounds[0])
            end = int(bounds[1])
            lo, hi = sorted((start, end))
            for one_based in range(lo, hi + 1):
                idx = one_based - 1
                if 0 <= idx < nions:
                    atoms.add(idx)
            continue

        if not part.isdigit():
            raise HTTPException(status_code=400, detail=f"Invalid atom index: {part}")

        idx = int(part) - 1
        if 0 <= idx < nions:
            atoms.add(idx)

    return sorted(atoms)


@router.post("/select-atoms")
def select_atoms(request: AtomSelectionRequest) -> dict:
    """Select atom indices by element symbol or index range (1-based)."""
    session = _get_session(request.session_id)

    data = session.data
    selections = []

    if request.elements:
        indices = _select_by_element(data.elements, request.elements)
        selections.append(indices)

    if request.index_spec:
        indices = _select_by_index(request.index_spec, data.nions)
        selections.append(indices)

    if not selections:
        raise HTTPException(status_code=400, detail="Provide elements or index_spec")

    result = sorted({idx for indices in selections for idx in indices})
    return {"atoms": result}


@router.delete("/{session_id}")
def cleanup_session(session_id: str) -> dict:
    """Clean up a cached session."""
    if session_id in _sessions:
        del _sessions[session_id]
    return {"status": "ok"}

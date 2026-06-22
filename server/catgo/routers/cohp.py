"""COHP analysis API endpoints.

Provides endpoints for uploading LOBSTER COHPCAR and ICOHPLIST files
and retrieving COHP data for visualization.
"""

import sys
import time
import uuid
from pathlib import Path
from typing import Dict

from fastapi import APIRouter, HTTPException, UploadFile

# Add cohp-analysis library to path
_ext_dir = Path(__file__).resolve().parent.parent.parent / "extensions" / "cohp-analysis"
if str(_ext_dir) not in sys.path:
    sys.path.insert(0, str(_ext_dir))

from catgo.models.cohp import (
    COHPBondInfo,
    COHPDataRequest,
    COHPDataResponse,
    COHPSeries,
    COHPUploadResponse,
    ICOHPEntry as ICOHPEntryModel,
    ICOHPUploadResponse,
)

router = APIRouter(prefix="/cohp", tags=["cohp"])

# In-memory session cache: session_id -> (COHPData, timestamp)
_sessions: Dict[str, tuple] = {}
# Separate cache for ICOHP data
_icohp_sessions: Dict[str, tuple] = {}
_SESSION_TTL = 1800  # 30 minutes


def _cleanup_expired():
    """Remove sessions older than TTL."""
    now = time.time()
    for cache in (_sessions, _icohp_sessions):
        expired = [sid for sid, (_, ts) in cache.items() if now - ts > _SESSION_TTL]
        for sid in expired:
            del cache[sid]


def _get_cohp_data(session_id: str):
    """Retrieve COHPData from cache."""
    _cleanup_expired()
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found or expired")
    data, _ = _sessions[session_id]
    _sessions[session_id] = (data, time.time())
    return data


@router.post("/upload-cohpcar", response_model=COHPUploadResponse)
async def upload_cohpcar(file: UploadFile) -> COHPUploadResponse:
    """Upload a COHPCAR.lobster file and return session metadata."""
    import tempfile
    from catgo_cohp.io import parse_cohpcar

    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    with tempfile.NamedTemporaryFile(suffix=".lobster", delete=False, mode="wb") as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        data = parse_cohpcar(tmp_path)
    except Exception as e:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Failed to parse COHPCAR file: {e}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    session_id = str(uuid.uuid4())
    _sessions[session_id] = (data, time.time())
    _cleanup_expired()

    # Build bond info lists
    total_bonds = []
    all_bonds_list = []
    for b in data.bonds:
        info = COHPBondInfo(
            bond_index=b.bond_index,
            atom1=b.atom1,
            atom2=b.atom2,
            distance=b.distance,
            orbital1=b.orbital1,
            orbital2=b.orbital2,
            is_total=b.is_total,
            label=b.label,
            element1=b.element1,
            element2=b.element2,
        )
        all_bonds_list.append(info)
        if b.is_total and b.bond_index > 0:  # Skip "Average"
            total_bonds.append(info)

    return COHPUploadResponse(
        session_id=session_id,
        nspin=data.nspin,
        npoints=data.npoints,
        ncols=data.ncols,
        efermi=data.efermi,
        emin=data.emin,
        emax=data.emax,
        bonds=total_bonds,
        all_bonds=all_bonds_list,
    )


@router.post("/from-remote")
async def cohp_from_remote(session_id: str, remote_path: str):
    """Download COHPCAR.lobster from HPC and create a COHP analysis session.

    Downloads the file via SSH, parses it, and creates a session
    just like the upload endpoint.
    """
    import tempfile
    from catgo_cohp.io import parse_cohpcar

    try:
        from catgo.utils.hpc_client import pool
        hpc = pool.get_connection(session_id)
        if not hpc:
            raise HTTPException(status_code=503, detail=f"HPC session {session_id} not connected")

        # Download file to temp location
        with tempfile.NamedTemporaryFile(suffix=".lobster", delete=False, mode="wb") as tmp:
            tmp_path = tmp.name

        await hpc.download_to_local(remote_path, tmp_path)

        try:
            data = parse_cohpcar(tmp_path)
        except Exception as e:
            Path(tmp_path).unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=f"Failed to parse COHPCAR file: {e}")
        finally:
            Path(tmp_path).unlink(missing_ok=True)

        sid = str(uuid.uuid4())
        _sessions[sid] = (data, time.time())
        _cleanup_expired()

        total_bonds = []
        all_bonds_list = []
        for b in data.bonds:
            info = COHPBondInfo(
                bond_index=b.bond_index,
                atom1=b.atom1,
                atom2=b.atom2,
                distance=b.distance,
                orbital1=b.orbital1,
                orbital2=b.orbital2,
                is_total=b.is_total,
                label=b.label,
                element1=b.element1,
                element2=b.element2,
            )
            all_bonds_list.append(info)
            if b.is_total and b.bond_index > 0:
                total_bonds.append(info)

        return COHPUploadResponse(
            session_id=sid,
            nspin=data.nspin,
            npoints=data.npoints,
            ncols=data.ncols,
            efermi=data.efermi,
            emin=data.emin,
            emax=data.emax,
            bonds=total_bonds,
            all_bonds=all_bonds_list,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download from HPC: {e}")


@router.post("/data", response_model=COHPDataResponse)
def get_cohp_data(request: COHPDataRequest) -> COHPDataResponse:
    """Get COHP data for specific bonds."""
    from catgo_cohp.analysis import (
        aggregate_orbital_cohp,
        filter_bonds,
        get_bond_cohp,
    )

    data = _get_cohp_data(request.session_id)
    series = []

    for bond_idx in request.bond_indices:
        if request.aggregate_orbitals:
            # Parse orbital filter
            orb_filter = None
            if request.orbital_filter:
                # e.g. ["p-d"] -> ("p", "d")
                for filt in request.orbital_filter:
                    parts = filt.split("-")
                    if len(parts) == 2:
                        orb_filter = (parts[0], parts[1])
                        result = aggregate_orbital_cohp(data, bond_idx, orbital_filter=orb_filter)
                        series.append(COHPSeries(
                            label=result["label"],
                            spin_up=result["spin_up"].tolist(),
                            spin_down=result["spin_down"].tolist() if result.get("spin_down") is not None else None,
                            bond_index=bond_idx,
                            is_total=False,
                        ))
            else:
                result = aggregate_orbital_cohp(data, bond_idx)
                series.append(COHPSeries(
                    label=result["label"],
                    spin_up=result["spin_up"].tolist(),
                    spin_down=result["spin_down"].tolist() if result.get("spin_down") is not None else None,
                    bond_index=bond_idx,
                    is_total=False,
                ))
        else:
            # Get total bond COHP
            total_bonds = [b for b in data.bonds if b.bond_index == bond_idx and b.is_total]
            for bond in total_bonds:
                result = get_bond_cohp(data, bond)
                series.append(COHPSeries(
                    label=bond.label,
                    spin_up=result["spin_up"].tolist(),
                    spin_down=result["spin_down"].tolist() if result.get("spin_down") is not None else None,
                    bond_index=bond_idx,
                    is_total=True,
                ))

            # Optionally include orbital-resolved
            if request.include_orbitals:
                orbital_bonds = [b for b in data.bonds if b.bond_index == bond_idx and not b.is_total]

                if request.orbital_filter:
                    # Filter by orbital type
                    filtered = []
                    for b in orbital_bonds:
                        for filt in request.orbital_filter:
                            parts = filt.split("-")
                            if len(parts) == 2:
                                o1_type, o2_type = parts
                                if b.orbital1 and b.orbital2:
                                    if (o1_type in b.orbital1 and o2_type in b.orbital2) or \
                                       (o2_type in b.orbital1 and o1_type in b.orbital2):
                                        filtered.append(b)
                    orbital_bonds = filtered

                for bond in orbital_bonds:
                    result = get_bond_cohp(data, bond)
                    series.append(COHPSeries(
                        label=bond.label,
                        spin_up=result["spin_up"].tolist(),
                        spin_down=result["spin_down"].tolist() if result.get("spin_down") is not None else None,
                        bond_index=bond_idx,
                        is_total=False,
                    ))

    return COHPDataResponse(
        energies=data.energies.tolist(),
        series=series,
        efermi=data.efermi,
    )


@router.post("/upload-icohplist", response_model=ICOHPUploadResponse)
async def upload_icohplist(file: UploadFile) -> ICOHPUploadResponse:
    """Upload an ICOHPLIST.lobster file."""
    import tempfile
    from catgo_cohp.io import parse_icohplist

    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    with tempfile.NamedTemporaryFile(suffix=".lobster", delete=False, mode="wb") as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        entries = parse_icohplist(tmp_path)
    except Exception as e:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Failed to parse ICOHPLIST file: {e}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    session_id = str(uuid.uuid4())

    entry_models = []
    for e in entries:
        entry_models.append(ICOHPEntryModel(
            cohp_num=e.cohp_num,
            atom1=e.atom1,
            atom2=e.atom2,
            distance=e.distance,
            spin_up=e.spin_up,
            spin_down=e.spin_down,
            total=e.total,
            orbital1=e.orbital1,
            orbital2=e.orbital2,
            is_total=e.is_total,
            label=e.label,
        ))

    _icohp_sessions[session_id] = (entries, time.time())

    return ICOHPUploadResponse(
        session_id=session_id,
        entries=entry_models,
    )


@router.post("/icohp-from-remote", response_model=ICOHPUploadResponse)
async def icohp_from_remote(session_id: str, remote_path: str) -> ICOHPUploadResponse:
    """Download ICOHPLIST.lobster from HPC and parse it into an ICOHP session.

    Downloads the file via SSH, parses it, and stores a session
    just like the upload endpoint.
    """
    import tempfile
    from catgo_cohp.io import parse_icohplist

    try:
        from catgo.utils.hpc_client import pool
        hpc = pool.get_connection(session_id)
        if not hpc:
            raise HTTPException(status_code=503, detail=f"HPC session {session_id} not connected")

        # Download file to temp location
        with tempfile.NamedTemporaryFile(suffix=".lobster", delete=False, mode="wb") as tmp:
            tmp_path = tmp.name

        await hpc.download_to_local(remote_path, tmp_path)

        try:
            entries = parse_icohplist(tmp_path)
        except Exception as e:
            Path(tmp_path).unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=f"Failed to parse ICOHPLIST file: {e}")
        finally:
            Path(tmp_path).unlink(missing_ok=True)

        sid = str(uuid.uuid4())

        entry_models = []
        for e in entries:
            entry_models.append(ICOHPEntryModel(
                cohp_num=e.cohp_num,
                atom1=e.atom1,
                atom2=e.atom2,
                distance=e.distance,
                spin_up=e.spin_up,
                spin_down=e.spin_down,
                total=e.total,
                orbital1=e.orbital1,
                orbital2=e.orbital2,
                is_total=e.is_total,
                label=e.label,
            ))

        _icohp_sessions[sid] = (entries, time.time())

        return ICOHPUploadResponse(
            session_id=sid,
            entries=entry_models,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download from HPC: {e}")


@router.delete("/{session_id}")
def cleanup_session(session_id: str) -> dict:
    """Clean up cached sessions."""
    if session_id in _sessions:
        del _sessions[session_id]
    if session_id in _icohp_sessions:
        del _icohp_sessions[session_id]
    return {"status": "ok"}

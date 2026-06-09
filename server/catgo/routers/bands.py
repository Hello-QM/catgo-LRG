"""Band structure analysis API endpoints."""

import time
import uuid
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form

from catgo.models.bands import (
    BandAtomSelectionRequest,
    BandBranch,
    BandDataRequest,
    BandDataResponse,
    BandGapInfo,
    BandProjection,
    BandProjectionGroup,
    BandProjectionRequest,
    BandProjectionResponse,
    BandSeries,
    BandUploadResponse,
)

router = APIRouter(prefix="/bands", tags=["bands"])


@dataclass
class BandSession:
    bs: Any  # BandStructureSymmLine or BandStructure
    vr: Any  # Vasprun (kept for projections)
    timestamp: float


_sessions: Dict[str, BandSession] = {}
_SESSION_TTL = 1800  # 30 minutes


def _cleanup_expired():
    now = time.time()
    expired = [sid for sid, s in _sessions.items() if now - s.timestamp > _SESSION_TTL]
    for sid in expired:
        del _sessions[sid]


def _get_session(session_id: str) -> BandSession:
    _cleanup_expired()
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found or expired")
    s = _sessions[session_id]
    s.timestamp = time.time()
    return s


def _structure_to_pymatgen_dict(structure) -> dict:
    """Convert pymatgen Structure to frontend-compatible dict."""
    import numpy as np
    lattice = structure.lattice
    sites = []
    for site in structure:
        elem = str(site.specie)
        sites.append({
            "species": [{"element": elem, "occu": 1, "oxidation_state": 0}],
            "abc": list(site.frac_coords),
            "xyz": list(site.coords),
            "label": elem,
            "properties": {},
        })
    return {
        "lattice": {
            "matrix": lattice.matrix.tolist(),
            "pbc": [True, True, True],
            "volume": float(lattice.volume),
            "a": float(lattice.a), "b": float(lattice.b), "c": float(lattice.c),
            "alpha": float(lattice.alpha), "beta": float(lattice.beta), "gamma": float(lattice.gamma),
        },
        "sites": sites,
        "charge": 0,
    }


def _extract_band_gap(bs) -> Optional[BandGapInfo]:
    """Extract band gap info from a pymatgen BandStructure object."""
    bg = bs.get_band_gap()
    if bg["energy"] <= 0 or bg["energy"] > 20:
        return None
    return BandGapInfo(
        energy=float(bg["energy"]),
        direct=bool(bg["direct"]),
        transition=str(bg.get("transition", "")),
    )


def _kpoint_count(bs) -> int:
    """Return the number of k-points for SymmLine and regular band structures."""
    kpoints = getattr(bs, "kpoints", None)
    if kpoints is not None:
        return len(kpoints)

    for bands in getattr(bs, "bands", {}).values():
        if hasattr(bands, "shape") and len(bands.shape) >= 2:
            return int(bands.shape[1])
        if bands:
            return len(bands[0])
    return 0


def _band_distance(bs) -> List[float]:
    """Return plot x-axis positions, falling back to k-point indices."""
    distance = getattr(bs, "distance", None)
    if distance is not None:
        return [float(d) for d in distance]
    return [float(idx) for idx in range(_kpoint_count(bs))]


def _extract_branches(bs) -> List[BandBranch]:
    """Extract branch info, with a fallback for runs without line-mode KPOINTS."""
    branches = []
    bs_branches = getattr(bs, "branches", None)
    if not bs_branches:
        nkpts = _kpoint_count(bs)
        return [BandBranch(start_index=0, end_index=nkpts - 1, name="")] if nkpts else []

    for b in bs_branches:
        name = b["name"]
        start = b["start_index"]
        end = b["end_index"]
        branches.append(BandBranch(start_index=start, end_index=end, name=name))
    return branches


def _extract_tick_info(bs) -> tuple:
    """Extract high-symmetry ticks, or simple endpoint ticks without KPOINTS."""
    labels = []
    positions = []
    bs_branches = getattr(bs, "branches", None)

    if not bs_branches:
        distance = _band_distance(bs)
        if not distance:
            return labels, positions
        if len(distance) == 1:
            return ["1"], [distance[0]]
        return ["1", str(len(distance))], [distance[0], distance[-1]]

    # bs.distance is the cumulative distance array
    distance = _band_distance(bs)

    for b in bs_branches:
        start_idx = b["start_index"]
        end_idx = b["end_index"]
        name_parts = b["name"].split("-")

        if len(labels) == 0 or positions[-1] != distance[start_idx]:
            # Add start label
            lbl = name_parts[0] if name_parts else ""
            lbl = lbl.replace("\\Gamma", "\u0393").replace("GAMMA", "\u0393")
            labels.append(lbl)
            positions.append(float(distance[start_idx]))
        else:
            # Merge with existing label if at same position
            lbl = name_parts[0] if name_parts else ""
            lbl = lbl.replace("\\Gamma", "\u0393").replace("GAMMA", "\u0393")
            if labels[-1] != lbl:
                labels[-1] = f"{labels[-1]}|{lbl}"

        if len(name_parts) > 1:
            lbl = name_parts[-1].replace("\\Gamma", "\u0393").replace("GAMMA", "\u0393")
            labels.append(lbl)
            positions.append(float(distance[end_idx]))

    return labels, positions


def _parse_index_spec(spec: str, nions: int) -> List[int]:
    """Parse '1-5,8-10' into 0-based indices."""
    indices = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            start = int(a.strip()) - 1
            end = int(b.strip()) - 1
            indices.extend(range(max(0, start), min(nions, end + 1)))
        else:
            idx = int(part.strip()) - 1
            if 0 <= idx < nions:
                indices.append(idx)
    return sorted(set(indices))


@router.post("/upload", response_model=BandUploadResponse)
async def upload_band_vasprun(
    file: UploadFile = File(...),
    kpoints_file: Optional[UploadFile] = File(None),
) -> BandUploadResponse:
    """Upload vasprun.xml (+ optional KPOINTS) for band structure analysis."""
    import numpy as np
    from pymatgen.io.vasp import Vasprun

    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    # Save vasprun.xml to temp
    with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        vasprun_path = tmp.name

    # Save KPOINTS if provided
    kpoints_path = None
    if kpoints_file and kpoints_file.filename:
        with tempfile.NamedTemporaryFile(suffix=".KPOINTS", delete=False) as tmp:
            kp_content = await kpoints_file.read()
            tmp.write(kp_content)
            kpoints_path = tmp.name

    try:
        vr = Vasprun(vasprun_path, parse_projected_eigen=True, parse_potcar_file=False, exception_on_bad_xml=False)
        bs = vr.get_band_structure(kpoints_filename=kpoints_path, line_mode=kpoints_path is not None)
    except Exception as e:
        Path(vasprun_path).unlink(missing_ok=True)
        if kpoints_path:
            Path(kpoints_path).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Failed to parse band structure: {e}")
    finally:
        Path(vasprun_path).unlink(missing_ok=True)
        if kpoints_path:
            Path(kpoints_path).unlink(missing_ok=True)

    return _create_band_session(vr, bs)


def _create_band_session(vr, bs) -> BandUploadResponse:
    """Create a band session from parsed Vasprun + BandStructure."""
    import numpy as np
    from pymatgen.electronic_structure.core import Spin
    from collections import Counter

    session_id = str(uuid.uuid4())
    _sessions[session_id] = BandSession(bs=bs, vr=vr, timestamp=time.time())
    _cleanup_expired()

    structure = vr.final_structure
    elements = [str(site.specie) for site in structure]
    elem_counts = Counter(elements)
    ion_types = list(elem_counts.keys())
    ion_counts = list(elem_counts.values())

    nspin = 2 if bs.is_spin_polarized else 1
    nbands = bs.nb_bands
    nkpts = _kpoint_count(bs)

    band_gap = _extract_band_gap(bs)
    branches = _extract_branches(bs)
    struct_dict = _structure_to_pymatgen_dict(structure)

    return BandUploadResponse(
        session_id=session_id,
        nbands=nbands,
        nkpts=nkpts,
        nspin=nspin,
        is_spin_polarized=bs.is_spin_polarized,
        efermi=float(bs.efermi),
        is_metal=bs.is_metal(),
        band_gap=band_gap,
        elements=list(set(elements)),
        ion_types=ion_types,
        ion_counts=ion_counts,
        branches=branches,
        structure=struct_dict,
    )


@router.post("/from-directory", response_model=BandUploadResponse)
async def band_from_directory(session_id: str, remote_path: str):
    """Auto-detect vasprun.xml (+ optional KPOINTS) from a remote directory."""
    import shlex
    from pymatgen.io.vasp import Vasprun

    try:
        from catgo.utils.hpc_client import pool
        hpc = pool.get_connection(session_id)
        if not hpc:
            raise HTTPException(status_code=503, detail=f"HPC session {session_id} not connected")

        # List directory
        resolved, files = await hpc.list_remote_dir(remote_path)
        file_names = {f.name: f.path for f in files if not f.is_dir}

        # Find vasprun.xml (required)
        vasprun_path = None
        for name in ["vasprun.xml", "vasprun.xml.gz"]:
            if name in file_names:
                vasprun_path = file_names[name]
                break
        if not vasprun_path:
            available = ", ".join(sorted(file_names.keys())[:20])
            raise HTTPException(
                status_code=404,
                detail=f"vasprun.xml not found in {resolved}. Files: {available}"
            )

        # Download vasprun.xml via SFTP
        with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as tmp:
            tmp_vasprun = tmp.name
        try:
            async with hpc.conn.start_sftp_client() as sftp:
                await sftp.get(vasprun_path, tmp_vasprun)

            # Optionally download KPOINTS
            tmp_kpoints = None
            if "KPOINTS" in file_names:
                with tempfile.NamedTemporaryFile(suffix=".KPOINTS", delete=False) as tmp:
                    tmp_kpoints = tmp.name
                async with hpc.conn.start_sftp_client() as sftp:
                    await sftp.get(file_names["KPOINTS"], tmp_kpoints)

            vr = Vasprun(tmp_vasprun, parse_projected_eigen=True, parse_potcar_file=False, exception_on_bad_xml=False)
            bs = vr.get_band_structure(kpoints_filename=tmp_kpoints, line_mode=tmp_kpoints is not None)
        finally:
            Path(tmp_vasprun).unlink(missing_ok=True)
            if tmp_kpoints:
                Path(tmp_kpoints).unlink(missing_ok=True)

        return _create_band_session(vr, bs)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load bands from directory: {e}")


@router.post("/data", response_model=BandDataResponse)
def get_band_data(request: BandDataRequest) -> BandDataResponse:
    """Get band structure data for plotting."""
    from pymatgen.electronic_structure.core import Spin

    session = _get_session(request.session_id)
    bs = session.bs

    distance = _band_distance(bs)

    band_series = []

    # Spin up
    bands_up = bs.bands[Spin.up]  # shape: (nbands, nkpts)
    # Shift to E - Ef
    bands_up_shifted = (bands_up - bs.efermi).tolist()
    band_series.append(BandSeries(spin="up", bands=bands_up_shifted))

    # Spin down if polarized
    if bs.is_spin_polarized and Spin.down in bs.bands:
        bands_down = bs.bands[Spin.down]
        bands_down_shifted = (bands_down - bs.efermi).tolist()
        band_series.append(BandSeries(spin="down", bands=bands_down_shifted))

    branches = _extract_branches(bs)
    band_gap = _extract_band_gap(bs)
    tick_labels, tick_positions = _extract_tick_info(bs)

    return BandDataResponse(
        distance=distance,
        branches=branches,
        band_series=band_series,
        efermi=float(bs.efermi),
        is_metal=bs.is_metal(),
        band_gap=band_gap,
        tick_labels=tick_labels,
        tick_positions=tick_positions,
    )


@router.post("/projections", response_model=BandProjectionResponse)
def get_band_projections(request: BandProjectionRequest) -> BandProjectionResponse:
    """Get projected (fat) band data."""
    import numpy as np
    from pymatgen.electronic_structure.core import Spin, Orbital, OrbitalType

    session = _get_session(request.session_id)
    bs = session.bs

    if not bs.projections:
        raise HTTPException(status_code=400, detail="No projection data available. Upload with parse_projected_eigen=True.")

    distance = _band_distance(bs)

    # Build base band data
    band_series = []
    bands_up = bs.bands[Spin.up]
    bands_up_shifted = (bands_up - bs.efermi).tolist()
    band_series.append(BandSeries(spin="up", bands=bands_up_shifted))

    if bs.is_spin_polarized and Spin.down in bs.bands:
        bands_down = bs.bands[Spin.down]
        bands_down_shifted = (bands_down - bs.efermi).tolist()
        band_series.append(BandSeries(spin="down", bands=bands_down_shifted))

    # Orbital mapping
    orbital_type_to_indices = {
        "s": [Orbital.s],
        "p": [Orbital.py, Orbital.pz, Orbital.px],
        "d": [Orbital.dxy, Orbital.dyz, Orbital.dz2, Orbital.dxz, Orbital.dx2],
        "f": [Orbital.f_3, Orbital.f_2, Orbital.f_1, Orbital.f0, Orbital.f1, Orbital.f2, Orbital.f3],
    }

    single_orbital_map = {
        "s": Orbital.s, "py": Orbital.py, "pz": Orbital.pz, "px": Orbital.px,
        "dxy": Orbital.dxy, "dyz": Orbital.dyz, "dz2": Orbital.dz2,
        "dxz": Orbital.dxz, "dx2": Orbital.dx2, "dx2-y2": Orbital.dx2,
    }

    projections = []

    for group in request.groups:
        channel_list = [c.strip() for c in group.channels.split(",")]

        # Determine which orbital indices to sum over
        orbitals_to_sum = []
        for ch in channel_list:
            if ch in orbital_type_to_indices:
                orbitals_to_sum.extend(orbital_type_to_indices[ch])
            elif ch in single_orbital_map:
                orbitals_to_sum.append(single_orbital_map[ch])

        if not orbitals_to_sum:
            continue

        for spin in [Spin.up] + ([Spin.down] if bs.is_spin_polarized else []):
            if spin not in bs.projections:
                continue

            proj_data = bs.projections[spin]  # shape: (nbands, nkpts, norbitals, nions)
            nbands, nkpts_proj = proj_data.shape[0], proj_data.shape[1]

            weights = np.zeros((nbands, nkpts_proj))

            for atom_idx in group.atoms:
                for orb in orbitals_to_sum:
                    orb_idx = orb.value  # Orbital enum value = index
                    if orb_idx < proj_data.shape[2] and atom_idx < proj_data.shape[3]:
                        weights += proj_data[:, :, orb_idx, atom_idx]

            # Normalize to [0, 1] by dividing by max if max > 0
            max_w = weights.max()
            if max_w > 0:
                weights = weights / max_w

            spin_label = "up" if spin == Spin.up else "down"
            projections.append(BandProjection(
                label=group.label or f"{group.channels}",
                spin=spin_label,
                weights=weights.tolist(),
            ))

    branches = _extract_branches(bs)
    band_gap = _extract_band_gap(bs)
    tick_labels, tick_positions = _extract_tick_info(bs)

    return BandProjectionResponse(
        distance=distance,
        branches=branches,
        band_series=band_series,
        efermi=float(bs.efermi),
        is_metal=bs.is_metal(),
        band_gap=band_gap,
        tick_labels=tick_labels,
        tick_positions=tick_positions,
        projections=projections,
    )


@router.post("/select-atoms")
def select_band_atoms(request: BandAtomSelectionRequest) -> dict:
    """Select atom indices by element or index range."""
    session = _get_session(request.session_id)
    structure = session.bs.structure

    selections = []

    if request.elements:
        indices = [i for i, site in enumerate(structure) if str(site.specie) in request.elements]
        selections.append(indices)

    if request.index_spec:
        indices = _parse_index_spec(request.index_spec, len(structure))
        selections.append(indices)

    if not selections:
        raise HTTPException(status_code=400, detail="Provide elements or index_spec")

    result = sorted(set(idx for sel in selections for idx in sel))
    return {"atoms": result}


@router.delete("/{session_id}")
def cleanup_band_session(session_id: str) -> dict:
    """Clean up a cached session."""
    if session_id in _sessions:
        del _sessions[session_id]
    return {"status": "ok"}

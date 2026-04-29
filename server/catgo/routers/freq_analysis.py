"""Frequency analysis API — independent of workflow.

Supports:
  - Upload OUTCAR file for local parsing
  - Parse from remote HPC directory via SSH
  - Gibbs free energy calculation
"""

import io
import json
import logging
import re

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/freq-analysis", tags=["freq-analysis"])


def _parse_outcar_content(text: str) -> dict:
    """Parse OUTCAR text content for frequencies + eigenvectors (local mode)."""
    lines = text.splitlines()

    masses_per_type: list[float] = []
    ions_per_type: list[int] = []
    raw_real: list[dict] = []
    raw_imag: list[dict] = []

    freq_real_re = re.compile(
        r"^\s*(\d+)\s+f\s+=\s+([\d.]+)\s+THz\s+([\d.]+)\s+2PiTHz\s+([\d.]+)\s+cm-1\s+([\d.]+)\s+meV"
    )
    freq_imag_re = re.compile(
        r"^\s*(\d+)\s+f/i\s*=\s+([\d.]+)\s+THz\s+([\d.]+)\s+2PiTHz\s+([\d.]+)\s+cm-1\s+([\d.]+)\s+meV"
    )

    for line in lines:
        if "POMASS" in line and "ZVAL" in line:
            m = re.search(r"POMASS\s*=\s*([\d.]+)", line)
            if m:
                masses_per_type.append(float(m.group(1)))
        if "ions per type" in line:
            ions_per_type = [int(x) for x in line.split("=")[1].split()]

        m = freq_real_re.match(line)
        if m:
            raw_real.append({
                "index": int(m.group(1)),
                "frequency_cm": float(m.group(4)),
                "thz": float(m.group(2)),
                "mev": float(m.group(5)),
            })
            continue
        m = freq_imag_re.match(line)
        if m:
            raw_imag.append({
                "index": int(m.group(1)),
                "frequency_cm": float(m.group(4)),
                "thz": float(m.group(2)),
                "mev": float(m.group(5)),
            })

    # Deduplicate (OUTCAR prints frequencies twice)
    for fl in [raw_real, raw_imag]:
        n = len(fl)
        if n > 0 and n % 2 == 0:
            half = n // 2
            if [e["frequency_cm"] for e in fl[:half]] == [e["frequency_cm"] for e in fl[half:]]:
                del fl[half:]

    if not raw_real and not raw_imag:
        return {"success": False, "message": "No frequency data found in OUTCAR"}

    total_atoms = sum(ions_per_type) if ions_per_type else 0

    # Build per-atom masses and type indices
    masses: list[float] = []
    atom_types: list[int] = []
    for idx, (mass, count) in enumerate(zip(masses_per_type, ions_per_type)):
        masses.extend([mass] * count)
        atom_types.extend([idx] * count)

    # Extract eigenvectors
    eigenvectors: list[list[list[float]]] = []
    positions: list[list[float]] = []

    i = 0
    while i < len(lines):
        # Find eigenvector header
        if "X         Y         Z           dx          dy          dz" in lines[i]:
            mode_vecs: list[list[float]] = []
            for j in range(i + 1, min(i + 1 + total_atoms, len(lines))):
                parts = lines[j].split()
                if len(parts) >= 6:
                    try:
                        mode_vecs.append([float(parts[3]), float(parts[4]), float(parts[5])])
                    except (ValueError, IndexError):
                        break
                else:
                    break
            if mode_vecs:
                eigenvectors.append(mode_vecs)
        # Last POSITION TOTAL-FORCE block
        if "POSITION" in lines[i] and "TOTAL-FORCE" in lines[i]:
            positions = []
            for j in range(i + 2, min(i + 2 + total_atoms, len(lines))):
                parts = lines[j].split()
                if len(parts) >= 3:
                    try:
                        positions.append([float(parts[0]), float(parts[1]), float(parts[2])])
                    except ValueError:
                        break
        i += 1

    # Deduplicate eigenvectors
    total_modes = len(raw_real) + len(raw_imag)
    if len(eigenvectors) == total_modes * 2:
        eigenvectors = eigenvectors[total_modes:]
    elif len(eigenvectors) > total_modes:
        eigenvectors = eigenvectors[-total_modes:]

    return {
        "success": True,
        "real_freqs": raw_real,
        "imag_freqs": raw_imag,
        "eigenvectors": eigenvectors,
        "positions": positions,
        "masses": masses,
        "ions_per_type": ions_per_type,
        "atom_types": atom_types,
        "total_atoms": total_atoms,
        "num_imaginary": len(raw_imag),
        "free_indices": None,
    }


@router.post("/upload")
async def upload_outcar(file: UploadFile):
    """Upload OUTCAR file and parse frequency data."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    content = await file.read()
    text = content.decode("utf-8", errors="replace")
    return _parse_outcar_content(text)


class RemoteParseRequest(BaseModel):
    session_id: str
    directory: str


@router.post("/from-directory")
async def parse_from_directory(req: RemoteParseRequest):
    """Parse OUTCAR from remote HPC directory via SSH."""
    from catgo.utils.hpc_client import pool
    hpc = pool.get_connection(req.session_id)
    if not hpc or not hpc.conn:
        raise HTTPException(status_code=503, detail="HPC session not connected")

    from catgo.utils.vasp_freq_parser import parse_vasp_frequencies
    return await parse_vasp_frequencies(hpc.conn, req.directory)


class FreqGibbsRequest(BaseModel):
    real_freqs_cm: list[float]
    imag_freqs_cm: list[float] = []
    positions: list[list[float]] = []
    masses: list[float] = []
    atom_types: list[int] = []
    free_indices: list[int] | None = None
    mode: str = "adsorbed"
    temperature: float = 298.15
    pressure: float = 101325.0
    freq_cutoff: float = 50.0
    n_unpaired: int = 0


@router.post("/gibbs")
def calculate_gibbs(req: FreqGibbsRequest):
    """Calculate Gibbs free energy correction from frequency data."""
    from catgo.utils.gibbs_calculator import calc_adsorbed, calc_gas

    if req.mode == "adsorbed":
        return calc_adsorbed(req.real_freqs_cm, req.imag_freqs_cm, req.temperature, req.freq_cutoff)
    elif req.mode == "gas":
        if not req.positions or not req.masses:
            raise HTTPException(status_code=400, detail="Positions and masses required for gas mode")
        return calc_gas(
            req.real_freqs_cm, req.imag_freqs_cm,
            req.positions, req.masses, req.atom_types,
            T=req.temperature, P=req.pressure,
            n_unpaired=req.n_unpaired, free_indices=req.free_indices,
        )
    else:
        raise HTTPException(status_code=400, detail=f"Unknown mode: {req.mode}")

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
async def upload_freq_file(file: UploadFile):
    """Upload a frequency output (VASP OUTCAR, CP2K Molden .mol or .out)."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    content = await file.read()
    text = content.decode("utf-8", errors="replace")
    from catgo.services.cp2k_freq import parse_freq_content
    return parse_freq_content(text)


class ParsePathRequest(BaseModel):
    path: str


@router.post("/parse-path")
def parse_freq_path(req: ParsePathRequest):
    """Parse a server-local frequency output file (MCP/CLI entry point)."""
    from pathlib import Path as _Path

    p = _Path(req.path).expanduser()
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {req.path}")
    if p.stat().st_size > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (>50 MB)")
    from catgo.services.cp2k_freq import parse_freq_content
    return parse_freq_content(p.read_text(encoding="utf-8", errors="replace"))


class RemoteParseRequest(BaseModel):
    session_id: str
    directory: str


@router.post("/from-directory")
async def parse_from_directory(req: RemoteParseRequest):
    """Parse frequency output from a remote HPC directory via SSH.

    Priority: CP2K Molden vibrations file > VASP OUTCAR (awk remote parse,
    no download) > CP2K .out containing VIB| lines.
    """
    import shlex

    from catgo.utils.hpc_client import pool
    hpc = pool.get_connection(req.session_id)
    if not hpc or not hpc.conn:
        raise HTTPException(status_code=503, detail="HPC session not connected")

    from catgo.services.cp2k_freq import (
        parse_cp2k_out_vibrations,
        parse_molden_vibrations,
        pick_freq_source,
    )

    safe_dir = shlex.quote(req.directory)
    listing = await hpc.conn.run(f"ls -1 {safe_dir} 2>/dev/null", check=False)
    names = (listing.stdout or "").split()
    kind, fname = pick_freq_source(names)

    if kind == "molden":
        cat = await hpc.conn.run(f"cat {safe_dir}/{shlex.quote(fname)}", check=False)
        if not cat.stdout:
            return {"success": False, "message": f"Could not read {fname}"}
        return parse_molden_vibrations(cat.stdout)

    if kind == "outcar":
        from catgo.utils.vasp_freq_parser import parse_vasp_frequencies
        return await parse_vasp_frequencies(hpc.conn, req.directory)

    if kind == "cp2k_out":
        # Find the first .out that actually contains VIB| lines (cheap grep -l).
        hit = await hpc.conn.run(
            f"grep -l 'VIB|' {safe_dir}/*.out 2>/dev/null | head -1", check=False
        )
        target = (hit.stdout or "").strip()
        if not target:
            return {"success": False, "message": "No OUTCAR, Molden vibrations file, or CP2K VIB| output found in directory"}
        cat = await hpc.conn.run(f"cat {shlex.quote(target)}", check=False)
        return parse_cp2k_out_vibrations(cat.stdout or "")

    return {"success": False, "message": "No OUTCAR, Molden vibrations file, or CP2K VIB| output found in directory"}


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


class IrSpectrumRequest(BaseModel):
    freqs_cm: list[float]
    intensities: list[float | None] | None = None
    sigma: float = 10.0
    emin: float | None = None
    emax: float | None = None


@router.post("/ir-spectrum")
def ir_spectrum(req: IrSpectrumRequest):
    """Gaussian-broadened IR spectrum from explicit per-mode intensities."""
    from catgo.cli.ir import compute_ir_spectrum

    if req.intensities is not None:
        if len(req.intensities) != len(req.freqs_cm):
            raise HTTPException(status_code=400, detail="freqs_cm and intensities length mismatch")
        pairs = [(f, i) for f, i in zip(req.freqs_cm, req.intensities) if i is not None]
        freqs = [f for f, _ in pairs]
        intens = [i for _, i in pairs]
    else:
        freqs = req.freqs_cm
        intens = None

    spec = compute_ir_spectrum(
        freqs, None, None, emin=req.emin, emax=req.emax, sigma=req.sigma,
        intensities=intens,
    )
    return {"grid_cm": spec.grid_cm, "intensity": spec.intensity, "n_modes": spec.n_modes}

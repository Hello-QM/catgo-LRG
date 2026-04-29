"""VASP input file generation and post-processing API endpoints."""

import time
import uuid

from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional

from catgo.models.vasp import (
    VASPInputFiles, VASPInputRequest,
    SlowGrowthUploadResponse, SlowGrowthAnalysisResponse,
    SlowGrowthConstraintData, SlowGrowthBarrierAnalysis,
)
from catgo.utils.vasp_input import generate_vasp_inputs
from catgo.utils.vasp_report import parse_report, SlowGrowthData

router = APIRouter(prefix="/vasp", tags=["vasp"])

# --- Slow-growth REPORT session store ---
_SESSION_TTL = 1800  # 30 minutes

_sessions: dict[str, dict] = {}  # session_id → {"data": SlowGrowthData, "ts": float}


def _cleanup_sessions():
    now = time.time()
    expired = [k for k, v in _sessions.items() if now - v["ts"] > _SESSION_TTL]
    for k in expired:
        del _sessions[k]


def _get_session(session_id: str) -> SlowGrowthData:
    _cleanup_sessions()
    entry = _sessions.get(session_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Session not found or expired")
    entry["ts"] = time.time()
    return entry["data"]


class ParseStructureRequest(BaseModel):
    content: str
    format: Optional[str] = None


@router.post("/parse-structure")
def parse_structure(request: ParseStructureRequest):
    """Parse a structure string (POSCAR, CIF, XYZ, etc.) into pymatgen JSON.

    Accepts various structure formats and returns the pymatgen Structure
    as a JSON dict suitable for the frontend structure viewer.
    """
    try:
        from pymatgen.core import Structure, Molecule

        content = request.content.strip()
        fmt = request.format

        structure = None
        errors = []

        # Try specified format first
        if fmt:
            try:
                if fmt.lower() in ("xyz",):
                    mol = Molecule.from_str(content, fmt="xyz")
                    return mol.as_dict()
                else:
                    structure = Structure.from_str(content, fmt=fmt)
            except Exception as e:
                errors.append(f"{fmt}: {e}")

        # Auto-detect format
        if structure is None:
            for try_fmt in ["poscar", "cif", "json"]:
                try:
                    structure = Structure.from_str(content, fmt=try_fmt)
                    break
                except Exception as e:
                    errors.append(f"{try_fmt}: {e}")

        # Try XYZ as molecule
        if structure is None:
            try:
                mol = Molecule.from_str(content, fmt="xyz")
                return mol.as_dict()
            except Exception as e:
                errors.append(f"xyz: {e}")

        # Try JSON dict directly
        if structure is None:
            try:
                import json
                data = json.loads(content)
                structure = Structure.from_dict(data)
            except Exception as e:
                errors.append(f"json_dict: {e}")

        if structure is None:
            raise ValueError(f"Could not parse structure. Tried formats: {'; '.join(errors)}")

        return structure.as_dict()
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error parsing structure: {str(e)}")


@router.post("/generate", response_model=VASPInputFiles)
def generate_vasp_inputs_endpoint(
    request: VASPInputRequest,
) -> VASPInputFiles:
    """Generate VASP input files (INCAR, POSCAR, KPOINTS) for a structure.

    Args:
        request: VASP input generation request with structure and parameters

    Returns:
        VASPInputFiles containing INCAR, POSCAR, KPOINTS strings and metadata
    """
    try:
        result = generate_vasp_inputs(request)
        return VASPInputFiles(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error generating VASP inputs: {str(e)}")


@router.get("/calculation-types")
def list_calculation_types() -> dict:
    """List available VASP calculation types."""
    from catgo.models.vasp import VASPCalculationType

    types = {}
    for calc_type in VASPCalculationType:
        descriptions = {
            "opt": "Structure optimization (relax ions and/or cell)",
            "scf": "Single-point energy calculation (static)",
            "freq": "Frequency/vibrational analysis (requires optimized structure)",
            "bader": "Bader charge analysis (requires CHGCAR)",
            "dos": "Density of states calculation",
            "ddec": "DDEC charge analysis (requires CHGCAR and AECCAR)",
            "elf": "Electron localization function calculation",
            "md": "Molecular dynamics (NVT/NVE/NPT)",
            "slow_growth": "Slow-growth MD (thermodynamic integration with ICONST constraints)",
        }
        types[calc_type.value] = descriptions.get(calc_type.value, "VASP calculation")

    return types


@router.get("/optimizer-types")
def list_optimizer_types() -> dict:
    """List available VASP optimizer presets."""
    from catgo.models.vasp import VASPOptimizerType

    optimizers = {}
    for opt_type in VASPOptimizerType:
        descriptions = {
            "standard": "Standard VASP optimizer (IBRION=2, conjugate gradient)",
            "vtst_fire": "VTST FIRE optimizer (IBRION=3, IOPT=7, LVTST=.TRUE.)",
            "quasi_newton": "Quasi-Newton optimizer (IBRION=1)",
        }
        optimizers[opt_type.value] = descriptions.get(opt_type.value, "VASP optimizer")

    return optimizers


# --- Slow-growth REPORT post-processing endpoints ---


@router.post("/report/upload", response_model=SlowGrowthUploadResponse)
async def upload_report_file(file: UploadFile = File(...)):
    """Upload a VASP REPORT file for slow-growth post-processing.

    Parses the file and returns a session_id for subsequent analysis requests.
    """
    try:
        content = await file.read()
        text = content.decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {e}")

    data = parse_report(text)
    if not data.steps:
        raise HTTPException(
            status_code=422,
            detail="No slow-growth data found in REPORT file. "
            "Ensure LBLUEOUT=.TRUE. was set and the file contains 'cc>' lines.",
        )

    session_id = str(uuid.uuid4())
    _sessions[session_id] = {"data": data, "ts": time.time()}

    return SlowGrowthUploadResponse(
        session_id=session_id,
        total_steps=data.total_steps,
        num_constraints=data.num_constraints,
        constraints=data.get_all_constraints(),
        has_blue_moon=data.has_blue_moon,
    )


@router.post("/report/upload-text", response_model=SlowGrowthUploadResponse)
def upload_report_text(request: ParseStructureRequest):
    """Upload REPORT content as text (for HPC remote file content)."""
    data = parse_report(request.content)
    if not data.steps:
        raise HTTPException(
            status_code=422,
            detail="No slow-growth data found. Ensure LBLUEOUT=.TRUE. was set.",
        )

    session_id = str(uuid.uuid4())
    _sessions[session_id] = {"data": data, "ts": time.time()}

    return SlowGrowthUploadResponse(
        session_id=session_id,
        total_steps=data.total_steps,
        num_constraints=data.num_constraints,
        constraints=data.get_all_constraints(),
        has_blue_moon=data.has_blue_moon,
    )


@router.get("/report/{session_id}", response_model=SlowGrowthAnalysisResponse)
def get_report_analysis(session_id: str):
    """Get full slow-growth analysis data for all constraints."""
    data = _get_session(session_id)

    constraints = []
    barriers = []
    for b_cnt in data.get_all_constraints():
        cd = data.get_constraint_data(b_cnt)
        constraints.append(SlowGrowthConstraintData(
            b_cnt=b_cnt,
            step=cd["step"],
            cv=cd["cv"],
            dcv=cd["dcv"],
            dA_dxsi=cd["dA_dxsi"],
            delta_F=cd["delta_F"],
            cv_target=cd["cv_target"],
            cv_actual=cd["cv_actual"],
            cv_diff=cd["cv_diff"],
            lambda_val=cd["lambda_val"],
            z_inv_sqrt=cd["z_inv_sqrt"],
            GkT=cd["GkT"],
            mean_force=cd["mean_force"],
        ))
        # Barrier analysis
        ba = data.get_barrier_analysis(b_cnt)
        barriers.append(SlowGrowthBarrierAnalysis(
            total_delta_F=ba.total_delta_F,
            total_delta_F_kcal=ba.total_delta_F_kcal,
            max_F=ba.max_F,
            max_F_cv=ba.max_F_cv,
            min_F=ba.min_F,
            min_F_cv=ba.min_F_cv,
            barrier_forward=ba.barrier_forward,
            barrier_forward_kcal=ba.barrier_forward_kcal,
            barrier_reverse=ba.barrier_reverse,
            barrier_reverse_kcal=ba.barrier_reverse_kcal,
            cv_start=ba.cv_start,
            cv_end=ba.cv_end,
            num_steps=ba.num_steps,
        ))

    return SlowGrowthAnalysisResponse(
        session_id=session_id,
        total_steps=data.total_steps,
        num_constraints=data.num_constraints,
        has_blue_moon=data.has_blue_moon,
        constraints=constraints,
        barriers=barriers,
    )

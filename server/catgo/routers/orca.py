"""ORCA input file generation API endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from catgo.models.structure import PymatgenStructure
from catgo.utils.orca_input import generate_orca_inputs, generate_orca_neb_inputs, generate_orca_irc_inputs

router = APIRouter(prefix="/orca", tags=["orca"])


class ORCAInputRequest(BaseModel):
    structure: Optional[PymatgenStructure] = None
    xyzfile_name: Optional[str] = None  # Use *xyzfile directive instead of inline geometry
    method: Optional[str] = "B3LYP"
    basis_set: Optional[str] = "6-31G"
    wavefunction: Optional[str] = None
    opt_type: Optional[str] = "MinSteps"
    opt_convergence: Optional[str] = None  # LooseOpt, TightOpt, VeryTightOpt
    cartesian_opt: Optional[bool] = False
    uno: Optional[bool] = False
    uco: Optional[bool] = False
    num_cores: Optional[int] = 4
    max_iterations: Optional[int] = 50
    charge: Optional[int] = 0
    multiplicity: Optional[int] = 1


class OrcaNebInputRequest(BaseModel):
    """NEB-TS input request with reactant and product structures."""
    structure_reactant: Optional[PymatgenStructure] = None
    structure_product: Optional[PymatgenStructure] = None
    method: Optional[str] = "B3LYP"
    basis: Optional[str] = "6-31G"
    wavefunction: Optional[str] = None
    uno: Optional[bool] = False
    uco: Optional[bool] = False
    nimages: Optional[int] = 8
    ts_opt: Optional[bool] = True
    neb_cycles: Optional[int] = 100
    interpolation: Optional[str] = "IDPP"
    num_cores: Optional[int] = 8
    charge: Optional[int] = 0
    multiplicity: Optional[int] = 1


class OrcaIrcInputRequest(BaseModel):
    """IRC input request for intrinsic reaction coordinate following."""
    structure: Optional[PymatgenStructure] = None
    external_ts_file: Optional[str] = None  # e.g., "NEB-TS_converged.xyz" or "ts.xyz"
    method: Optional[str] = "r2SCAN-3c"
    basis: Optional[str] = "6-31G"
    wavefunction: Optional[str] = None
    uno: Optional[bool] = False
    uco: Optional[bool] = False
    max_iterations: Optional[int] = 30
    initial_displacement_energy: Optional[float] = 2.0
    num_cores: Optional[int] = 4
    charge: Optional[int] = 0
    multiplicity: Optional[int] = 1


class ORCAInputFiles(BaseModel):
    inp: str
    notes: Optional[str] = None


class OrcaNebInputFiles(BaseModel):
    """Response model for NEB-TS input generation with multiple files."""
    inp: str
    reactant_xyz: str
    product_xyz: str
    notes: Optional[str] = None


class OrcaIrcInputFiles(BaseModel):
    """Response model for IRC input generation with INP and TS structure files."""
    inp: str
    ts_xyz: str
    notes: Optional[str] = None


@router.post("/generate", response_model=ORCAInputFiles)
def generate_orca_inputs_endpoint(
    request: ORCAInputRequest,
) -> ORCAInputFiles:
    """Generate ORCA input file (.inp) for a structure.

    Args:
        request: ORCA input generation request with structure and parameters

    Returns:
        ORCAInputFiles containing INP string and metadata
    """
    try:
        result = generate_orca_inputs(request)
        return ORCAInputFiles(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error generating ORCA inputs: {str(e)}")


@router.post("/generate-neb-ts", response_model=OrcaNebInputFiles)
def generate_orca_neb_ts_endpoint(
    request: OrcaNebInputRequest,
) -> OrcaNebInputFiles:
    """Generate ORCA NEB-TS input file for transition state search.

    Args:
        request: NEB-TS request with reactant and product structures plus parameters

    Returns:
        OrcaNebInputFiles containing INP and XYZ files plus instructions
    """
    try:
        result = generate_orca_neb_inputs(request)
        return OrcaNebInputFiles(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error generating ORCA NEB-TS inputs: {str(e)}")


@router.post("/generate-irc", response_model=OrcaIrcInputFiles)
def generate_orca_irc_endpoint(
    request: OrcaIrcInputRequest,
) -> OrcaIrcInputFiles:
    """Generate ORCA IRC input file for intrinsic reaction coordinate.

    Args:
        request: IRC request with TS structure and IRC parameters

    Returns:
        OrcaIrcInputFiles containing INP and TS XYZ files plus instructions
    """
    try:
        result = generate_orca_irc_inputs(request)
        return OrcaIrcInputFiles(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error generating ORCA IRC inputs: {str(e)}")

"""Force field conversion endpoints for molecular dynamics.

This module uses:
- AmberTools (antechamber, parmchk2) and moltemplate for GAFF2/GAFF
- Open Babel for OPLS-AA, MMFF94, UFF, and other force fields

Helper functions are in forcefield_utils.py.
"""

__all__ = [
    "router",
    "ForceFieldType",
    "ChargeMethod",
    "WaterModel",
    "ForceFieldConvertRequest",
    "ForceFieldConvertResponse",
]

import logging
import shutil
from enum import Enum
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .forcefield_utils import (
    FORCE_FIELD_FILES,
    MOLTEMPLATE_DIR,
    _check_openbabel_available,
    _check_tools_available,
    _convert_with_antechamber_and_moltemplate,
    _convert_with_openbabel,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/forcefield", tags=["forcefield"])


# ============================================================================
# Enums and Constants
# ============================================================================

class ForceFieldType(str, Enum):
    """Supported force field types.

    GAFF force fields use AmberTools (antechamber, parmchk2, moltemplate).
    Other force fields use Open Babel for atom typing and parameter generation.
    """
    GAFF2 = "gaff2"
    GAFF = "gaff"
    OPLSAA = "oplsaa"
    MMFF94 = "mmff94"
    MMFF94S = "mmff94s"
    UFF = "uff"
    GHEMICAL = "ghemical"


class ChargeMethod(str, Enum):
    """Charge calculation methods.

    Gasteiger: Fast, approximate (works with all force fields)
    AM1-BCC: More accurate, requires AmberTools (GAFF only)
    MMFF94: MMFF94 charges (Open Babel, works with MMFF94 force field)
    Zero: No charges (for testing)
    """
    GASTEIGER = "gasteiger"
    AM1BCC = "am1bcc"
    MMFF94 = "mmff94"
    ZERO = "zero"


class WaterModel(str, Enum):
    """Water model types for solvation."""
    TIP3P = "tip3p"
    TIP4P = "tip4p"


# ============================================================================
# Request/Response Models
# ============================================================================

class ForceFieldConvertRequest(BaseModel):
    """Request to convert PDB/MOL2 to LAMMPS format with force field."""

    # Input structure
    structure_content: str = Field(
        ...,
        description="Structure file content (PDB or MOL2 format)"
    )
    structure_format: Literal["pdb", "mol2", "xyz"] = Field(
        default="pdb",
        description="Input structure format"
    )

    # Force field parameters
    force_field: ForceFieldType = Field(
        default=ForceFieldType.GAFF2,
        description="Force field type (GAFF2, GAFF, OPLS-AA)"
    )
    charge_method: ChargeMethod = Field(
        default=ChargeMethod.GASTEIGER,
        description="Charge calculation method"
    )

    # Multi-molecule/box options
    num_molecules: int = Field(
        default=1,
        ge=1,
        le=1000,
        description="Number of molecules for multi-molecule system"
    )
    box_mode: Literal["size", "density"] = Field(
        default="size",
        description="How to determine box size"
    )
    box_size: str = Field(
        default="20 20 20",
        description="Box size in Å (format: 'x y z')"
    )
    density: float = Field(
        default=1.0,
        ge=0.1,
        le=5.0,
        description="Target density in g/cm³ (for density mode)"
    )

    # Internal options
    include_init: bool = Field(
        default=False,
        description="Include init file content (for workflow use)"
    )


class ForceFieldConvertResponse(BaseModel):
    """Response from force field conversion."""

    success: bool
    message: str
    data_file: Optional[str] = Field(
        None,
        description="LAMMPS data file content"
    )
    init_file: Optional[str] = Field(
        None,
        description="LAMMPS init file content (basic force field settings)"
    )
    num_atoms: int = Field(
        default=0,
        description="Number of atoms in the system"
    )
    num_atom_types: int = Field(
        default=0,
        description="Number of atom types"
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="Warning messages during conversion"
    )


# ============================================================================
# API Endpoints
# ============================================================================

@router.get("/forcefields")
def list_forcefields():
    """List available force fields."""
    gaff_available = _check_tools_available()
    openbabel_available = _check_openbabel_available()

    # GAFF force fields (require AmberTools + moltemplate)
    gaff_forcefields = []
    for ff_name, ff_path in FORCE_FIELD_FILES.items():
        available = gaff_available and ff_path.exists()
        gaff_forcefields.append({
            "id": ff_name,
            "name": ff_name.upper(),
            "category": "ambers",
            "available": available,
            "description": {
                "gaff2": "General AMBER Force Field 2 (recommended for organic molecules)",
                "gaff": "Original GAFF (backward compatibility)",
                "oplsaa": "OPLS All-Atom force field",
            }.get(ff_name, "")
        })

    # Open Babel force fields
    openbabel_forcefields = [
        {
            "id": "oplsaa",
            "name": "OPLS-AA",
            "category": "openbabel",
            "available": openbabel_available,
            "description": "OPLS All-Atom force field (proteins, organic liquids)",
        },
        {
            "id": "mmff94",
            "name": "MMFF94",
            "category": "openbabel",
            "available": openbabel_available,
            "description": "Merck Molecular Force Field (drug-like molecules)",
        },
        {
            "id": "mmff94s",
            "name": "MMFF94s",
            "category": "openbabel",
            "available": openbabel_available,
            "description": "MMFF94s variant (sparc-minimized)",
        },
        {
            "id": "uff",
            "name": "UFF",
            "category": "openbabel",
            "available": openbabel_available,
            "description": "Universal Force Field (broad coverage, less accurate)",
        },
        {
            "id": "ghemical",
            "name": "Ghemical",
            "category": "openbabel",
            "available": openbabel_available,
            "description": "Ghemical force field (compatible with Ghemical software)",
        },
    ]

    # Merge and deduplicate (OPLS-AA appears in both but Open Babel path is preferred)
    all_forcefields = openbabel_forcefields.copy()
    for ff in gaff_forcefields:
        if ff["id"] not in ["oplsaa"]:  # Skip OPLS-AA from GAFF list
            all_forcefields.append(ff)

    return {"forcefields": all_forcefields}


@router.post("/convert", response_model=ForceFieldConvertResponse)
def convert_with_forcefield(request: ForceFieldConvertRequest):
    """
    Convert PDB/MOL2/XYZ structure to LAMMPS format with proper force field parameters.

    Supports PDB, MOL2, and XYZ input formats. The tool will assign force field
    atom types to your structure regardless of existing atom naming.

    Supported force fields:
    - gaff2: General AMBER Force Field 2 (recommended for organic molecules) - uses AmberTools
    - gaff: Original GAFF (backward compatibility) - uses AmberTools
    - oplsaa: OPLS All-Atom force field - uses Open Babel
    - mmff94: Merck Molecular Force Field - uses Open Babel
    - mmff94s: MMFF94s variant - uses Open Babel
    - uff: Universal Force Field - uses Open Babel
    - ghemical: Ghemical force field - uses Open Babel

    GAFF force fields use AmberTools (antechamber, parmchk2, moltemplate).
    Other force fields use Open Babel for atom typing and parameter generation.
    """
    ff = request.force_field.value
    is_gaff = ff in ("gaff2", "gaff")

    # Check tool availability based on force field
    if is_gaff:
        if not _check_tools_available():
            raise HTTPException(
                status_code=500,
                detail="AmberTools not available. Please install: "
                       "AmberTools (antechamber, parmchk2) and moltemplate"
            )
    else:
        if not _check_openbabel_available():
            raise HTTPException(
                status_code=500,
                detail="Open Babel not available. Install with: pip install openbabel"
            )
        # Validate charge method for Open Babel
        if request.charge_method.value == "am1bcc":
            return ForceFieldConvertResponse(
                success=False,
                message="AM1-BCC charges only available with GAFF force fields. "
                       "Use 'gasteiger' or 'mmff94' charges for this force field.",
                data_file=None,
                num_atoms=0,
                num_atom_types=0,
                warnings=[]
            )

    try:
        if is_gaff:
            # Use AmberTools path for GAFF/GAFF2
            data_content, init_content, warnings = _convert_with_antechamber_and_moltemplate(
                structure_content=request.structure_content,
                structure_format=request.structure_format,
                force_field=ff,
                charge_method=request.charge_method.value,
                num_molecules=request.num_molecules,
                box_mode=request.box_mode,
                box_size=request.box_size,
                density=request.density,
                include_init=request.include_init,
            )
        else:
            # Use Open Babel path for other force fields
            data_content, init_content, warnings = _convert_with_openbabel(
                structure_content=request.structure_content,
                structure_format=request.structure_format,
                force_field=ff,
                charge_method=request.charge_method.value,
                num_molecules=request.num_molecules,
                box_mode=request.box_mode,
                box_size=request.box_size,
                density=request.density,
            )

        # Count atoms from data file
        num_atoms = 0
        num_atom_types = 0
        for line in data_content.split('\n'):
            # Look for "     N  atoms" pattern
            if 'atoms' in line and num_atoms == 0:
                parts = line.split()
                if len(parts) >= 2 and parts[1] == 'atoms':
                    try:
                        num_atoms = int(parts[0])
                    except ValueError:
                        pass
            elif 'atom types' in line:
                parts = line.split()
                if parts:
                    try:
                        num_atom_types = int(parts[0])
                    except ValueError:
                        pass
                    break

        return ForceFieldConvertResponse(
            success=True,
            message=f"Structure converted successfully with {ff.upper()} force field",
            data_file=data_content,
            init_file=init_content if request.include_init else None,
            num_atoms=num_atoms,
            num_atom_types=num_atom_types,
            warnings=warnings
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Force field conversion failed: {e}")
        return ForceFieldConvertResponse(
            success=False,
            message=f"Conversion failed: {str(e)}",
            data_file=None,
            num_atoms=0,
            num_atom_types=0,
            warnings=[f"Error: {str(e)}"]
        )


@router.get("/status")
def get_status():
    """Check force field conversion service status."""
    tools_available = _check_tools_available()
    moltemplate_available = MOLTEMPLATE_DIR.exists()
    openbabel_available = _check_openbabel_available()

    # Determine overall status
    gaff_available = tools_available
    other_ff_available = openbabel_available
    status = "available" if (gaff_available or other_ff_available) else "unavailable"

    return {
        "status": status,
        "ambers_tools": "available" if gaff_available else "not installed",
        "antechamber": "installed" if shutil.which("antechamber") else "not installed",
        "parmchk2": "installed" if shutil.which("parmchk2") else "not installed",
        "moltemplate": "available" if moltemplate_available else "not found",
        "moltemplate_dir": str(MOLTEMPLATE_DIR),
        "openbabel": "available" if openbabel_available else "not installed",
        "gaff_forcefields": "available" if gaff_available else "not available",
        "other_forcefields": "available" if other_ff_available else "not available",
    }

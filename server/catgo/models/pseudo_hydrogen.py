"""Pydantic models for pseudo-hydrogen passivation."""

from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class PseudoHydrogenParams(BaseModel):
    """Parameters for pseudo-hydrogen passivation."""

    passivate_top: bool = Field(
        default=False, description="Passivate top surface"
    )
    passivate_bottom: bool = Field(
        default=True, description="Passivate bottom surface"
    )
    surface_depth: float = Field(
        default=1.5, ge=0.5, le=5.0,
        description="Surface depth threshold (A) for identifying surface atoms",
    )
    bond_length_scale: float = Field(
        default=1.0, ge=0.5, le=1.5,
        description="Pseudo-H bond length = (r_parent + r_H) * scale",
    )
    cutoff_mult: float = Field(
        default=1.15, ge=0.8, le=2.0,
        description="Neighbor cutoff multiplier for coordination analysis",
    )
    selected_indices: Optional[List[int]] = Field(
        default=None,
        description="Atom indices to passivate (None = auto-detect all surface atoms)",
    )
    valence_electrons: Optional[Dict[str, float]] = Field(
        default=None,
        description="Custom valence electron overrides, e.g. {\"Fe\": 8}",
    )
    bulk_coordination: Optional[Dict[str, int]] = Field(
        default=None,
        description="Manual bulk coordination, e.g. {\"Fe\": 8}",
    )


class PseudoHydrogenRequest(BaseModel):
    """Request for pseudo-hydrogen passivation."""

    slab: PymatgenStructure
    bulk: PymatgenStructure
    params: Optional[PseudoHydrogenParams] = None


class PseudoHInfoResponse(BaseModel):
    """Info about a single pseudo-hydrogen atom."""

    position: List[float] = Field(min_length=3, max_length=3)
    charge: float = Field(description="Exact charge (V_missing / N_missing)")
    vasp_charge: float = Field(description="Nearest available VASP charge")
    potcar_name: str = Field(description="POTCAR name (e.g., H.50)")
    parent_index: int = Field(description="Index of parent atom in original slab")
    parent_symbol: str = Field(description="Element of parent atom")
    missing_symbol: str = Field(description="Element that was cut away")


class PseudoHydrogenResult(BaseModel):
    """Result of pseudo-hydrogen passivation."""

    structure: PymatgenStructure
    n_pseudo_h: int = Field(description="Number of pseudo-H atoms added")
    bulk_coordination: Dict[str, int] = Field(
        description="Detected bulk coordination numbers"
    )
    valence_used: Dict[str, float] = Field(
        default_factory=dict,
        description="Valence electrons used for each element",
    )
    pseudo_h_list: List[PseudoHInfoResponse] = Field(
        description="Details of each pseudo-H atom"
    )
    unique_potcars: List[str] = Field(
        description="List of required POTCAR names"
    )
    bond_warnings: List[str] = Field(
        default_factory=list,
        description="Validation warnings (e.g., V_A/N_A + V_B/N_B != 2)",
    )
    message: str = ""

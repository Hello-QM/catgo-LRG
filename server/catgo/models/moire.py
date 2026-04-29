"""Pydantic models for Moiré superlattice construction."""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class StrainLayer(str, Enum):
    """Which layer(s) to apply strain to achieve commensurability."""

    TOP = "top"
    BOTTOM = "bottom"
    BOTH = "both"


class MoireLayerInput(BaseModel):
    """Input for a single layer in the Moiré bilayer.

    Supports either a PymatgenStructure (from the frontend) or raw lattice
    vectors + basis atoms for direct specification.
    """

    structure: Optional[PymatgenStructure] = Field(
        default=None,
        description="Pymatgen-compatible structure. If provided, lattice vectors and basis are extracted automatically.",
    )
    lattice_vectors: Optional[list[list[float]]] = Field(
        default=None,
        min_length=2,
        max_length=2,
        description="2D lattice vectors [[a1x, a1y], [a2x, a2y]] in Å. Used if structure is not provided.",
    )
    elements: Optional[list[str]] = Field(
        default=None,
        description="Element symbols for basis atoms, e.g. ['C', 'C']. Used if structure is not provided.",
    )
    basis_coords: Optional[list[list[float]]] = Field(
        default=None,
        description="Fractional coordinates of basis atoms [[f1, f2], ...]. Used if structure is not provided.",
    )
    celldm: Optional[list[float]] = Field(
        default=None,
        min_length=1,
        max_length=3,
        description="Lattice constants [celldm1, celldm2, celldm3] in Å. Vectors are scaled component-wise: real_x = vec_x * celldm1, real_y = vec_y * celldm2. If a single value, used for all components.",
    )


class MoireAngleSearchParams(BaseModel):
    """Parameters controlling the commensurate angle search."""

    angle_min: float = Field(
        default=0.0, ge=0.0, le=180.0, description="Minimum twist angle (degrees)"
    )
    angle_max: float = Field(
        default=60.0, ge=0.0, le=180.0, description="Maximum twist angle (degrees)"
    )
    angle_step: float = Field(
        default=0.01, gt=0.0, le=10.0, description="Angle step size (degrees)"
    )
    max_index: int = Field(
        default=12, ge=1, le=50, description="Maximum superlattice index (m, n, p, q)"
    )
    mismatch_threshold: float = Field(
        default=0.01,
        ge=1e-6,
        le=1.0,
        description="Maximum allowed mismatch between coincidence lattice vectors (Å)",
    )
    max_atoms: int = Field(
        default=2000,
        ge=10,
        le=100000,
        description="Maximum number of atoms in the supercell (filters large candidates)",
    )
    strain_layer: StrainLayer = Field(
        default=StrainLayer.BOTH,
        description="Which layer to strain for exact commensurability",
    )
    apply_strain: bool = Field(
        default=True,
        description="Whether to compute strain tensor for exact commensurability",
    )
    max_strain_percent: float = Field(
        default=5.0,
        ge=0.0,
        le=20.0,
        description="Maximum allowed strain percentage. Candidates exceeding this are filtered out.",
    )
    deep_search: bool = Field(
        default=False,
        description="Enable deep search refinement around found angles for better candidates",
    )
    deep_search_range: float = Field(
        default=0.5,
        ge=0.01,
        le=5.0,
        description="Angular range (degrees) around each candidate for deep search",
    )
    deep_search_step: float = Field(
        default=0.001,
        gt=0.0,
        le=1.0,
        description="Step size (degrees) for deep search refinement",
    )
    final_mismatch_threshold: float = Field(
        default=0.00001,
        ge=1e-8,
        le=1.0,
        description="Final mismatch threshold for deep search (Å). Tighter than initial threshold.",
    )
    fix_angle: bool = Field(
        default=False,
        description="If True, search only at the fixed angle specified by fixed_angle_value.",
    )
    fixed_angle_value: float = Field(
        default=60.0,
        ge=0.0,
        le=180.0,
        description="Fixed angle value (degrees) when fix_angle is True.",
    )
    max_results: int = Field(
        default=50, ge=1, le=500, description="Maximum number of candidates to return"
    )


class MoireCandidate(BaseModel):
    """A single commensurate twist angle candidate."""

    angle: float = Field(description="Twist angle (degrees)")
    m: int = Field(description="Superlattice index m for layer A")
    n: int = Field(description="Superlattice index n for layer A")
    p: int = Field(description="Superlattice index p for layer B")
    q: int = Field(description="Superlattice index q for layer B")
    m2: int = Field(description="Second vector superlattice index m2 for layer A")
    n2: int = Field(description="Second vector superlattice index n2 for layer A")
    p2: int = Field(description="Second vector superlattice index p2 for layer B")
    q2: int = Field(description="Second vector superlattice index q2 for layer B")
    mismatch: float = Field(description="Lattice mismatch (Å)")
    n_atoms: int = Field(description="Estimated total number of atoms in bilayer supercell")
    area_ratio: float = Field(description="Area of supercell / area of unit cell")
    strain_percent: Optional[float] = Field(
        default=None, description="Applied strain magnitude (%)"
    )
    strain_tensor: Optional[list[list[float]]] = Field(
        default=None, description="2x2 strain tensor if strain is applied"
    )


class MoireAngleSearchRequest(BaseModel):
    """Request for Moiré commensurate angle search."""

    layer_a: MoireLayerInput
    layer_b: Optional[MoireLayerInput] = Field(
        default=None,
        description="Second layer. If None, same as layer_a (homobilayer).",
    )
    params: Optional[MoireAngleSearchParams] = None


class MoireAngleSearchResult(BaseModel):
    """Result of Moiré angle search."""

    candidates: list[MoireCandidate]
    n_candidates: int = Field(description="Number of candidates found")
    angle_range: list[float] = Field(
        min_length=2, max_length=2, description="Searched angle range [min, max] (degrees)"
    )
    message: str = ""


class MoireBuildParams(BaseModel):
    """Parameters for building the Moiré bilayer structure."""

    translate_z: float = Field(
        default=3.35,
        ge=1.0,
        le=20.0,
        description="Interlayer distance (Å). Default 3.35 Å for graphene.",
    )
    vacuum: float = Field(
        default=15.0,
        ge=0.0,
        le=50.0,
        description="Vacuum layer thickness above the bilayer (Å)",
    )
    z_a: float = Field(
        default=0.0,
        description="z-coordinate of layer A (Å). Default 0.",
    )


class MoireBuildRequest(BaseModel):
    """Request for building a Moiré bilayer structure."""

    layer_a: MoireLayerInput
    layer_b: Optional[MoireLayerInput] = None
    candidate: MoireCandidate
    params: Optional[MoireBuildParams] = None


class MoireBuildResult(BaseModel):
    """Result of Moiré bilayer construction."""

    structure: PymatgenStructure
    n_atoms: int = Field(description="Total number of atoms in the bilayer supercell")
    n_atoms_layer_a: int = Field(description="Number of atoms in layer A")
    n_atoms_layer_b: int = Field(description="Number of atoms in layer B")
    angle: float = Field(description="Applied twist angle (degrees)")
    supercell_area: float = Field(description="Supercell area (Å²)")
    strain_applied: bool = Field(default=False, description="Whether strain was applied")
    message: str = ""

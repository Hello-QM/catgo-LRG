"""Pydantic models for nanotube construction."""

from typing import Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class NanotubeLayerInput(BaseModel):
    """Input definition for the 2D material to roll into a nanotube.

    Can be provided either as a PymatgenStructure or as raw lattice vectors + basis atoms.
    """

    structure: Optional[PymatgenStructure] = None

    # Raw lattice specification (used if structure is None)
    lattice_vectors: Optional[list[list[float]]] = Field(
        default=None,
        description="2D lattice vectors [[a1x, a1y], [a2x, a2y]] in Angstroms",
    )
    elements: Optional[list[str]] = Field(
        default=None,
        description="Element symbols for each basis atom",
    )
    basis_coords: Optional[list[list[float]]] = Field(
        default=None,
        description="Fractional coordinates [[fx, fy], ...] for each basis atom",
    )
    z_coords: Optional[list[float]] = Field(
        default=None,
        description="Z-offsets in Angstroms for each basis atom (relative to layer center). "
        "For monolayer materials like graphene, all zeros. "
        "For TMDC (e.g. MoS2), the chalcogen atoms have +/- dz offset.",
    )


class NanotubeInfoParams(BaseModel):
    """Parameters for computing nanotube geometry info (no actual building)."""

    n: int = Field(ge=0, description="First chiral index")
    m: int = Field(ge=0, description="Second chiral index")
    NL: int = Field(default=1, ge=1, le=50, description="Number of unit cells along tube axis")


class NanotubeInfoRequest(BaseModel):
    """Request for computing nanotube geometry info."""

    layer: NanotubeLayerInput
    params: NanotubeInfoParams


class NanotubeInfoResult(BaseModel):
    """Geometry info about a nanotube (without building it)."""

    chiral_angle_deg: float = Field(description="Chiral angle in degrees")
    circumference: float = Field(description="Circumference in Angstroms")
    diameter: float = Field(description="Diameter in Angstroms")
    radius: float = Field(description="Radius in Angstroms")
    trans_length: float = Field(description="Translational vector length in Angstroms")
    tube_length: float = Field(description="Total tube length (NL * trans_length) in Angstroms")
    n_atoms_estimate: int = Field(description="Estimated total atom count")
    t1: int = Field(description="Translational vector index t1")
    t2: int = Field(description="Translational vector index t2")
    chirality: str = Field(description="Chirality type: zigzag, armchair, or chiral")
    message: str = ""


class NanotubeBuildParams(BaseModel):
    """Parameters for building a nanotube."""

    n: int = Field(ge=0, description="First chiral index")
    m: int = Field(ge=0, description="Second chiral index")
    NL: int = Field(default=1, ge=1, le=50, description="Number of unit cells along tube axis")
    vacuum: float = Field(
        default=15.0,
        ge=5.0,
        le=100.0,
        description="Vacuum padding from tube wall in Angstroms",
    )
    n_walls: int = Field(
        default=1,
        ge=1,
        le=10,
        description="Number of walls (1 = SWNT, 2+ = MWNT)",
    )
    interlayer_spacing: float = Field(
        default=3.4,
        ge=2.0,
        le=10.0,
        description="Interlayer spacing between walls in Angstroms",
    )


class NanotubeBuildRequest(BaseModel):
    """Request for building a nanotube structure."""

    layer: NanotubeLayerInput
    params: NanotubeBuildParams


class WallInfo(BaseModel):
    """Info about one wall in a multi-wall nanotube."""
    n: int
    m: int
    radius: float
    n_atoms: int


class NanotubeBuildResult(BaseModel):
    """Result of nanotube construction."""

    structure: PymatgenStructure
    n_atoms: int = Field(description="Total number of atoms")
    chiral_angle_deg: float
    circumference: float
    diameter: float
    tube_length: float
    chirality: str
    n_walls: int = Field(default=1, description="Number of walls")
    walls: list[WallInfo] = Field(default_factory=list, description="Per-wall info")
    message: str = ""

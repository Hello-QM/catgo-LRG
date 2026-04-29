"""Pydantic models for band structure analysis."""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class BandBranch(BaseModel):
    """A branch/segment in the band structure k-path."""
    start_index: int
    end_index: int
    name: str = Field(default="", description="Branch label e.g. 'Γ-X'")


class BandGapInfo(BaseModel):
    """Band gap information."""
    energy: float = Field(description="Band gap energy in eV")
    direct: bool = Field(description="Whether the gap is direct")
    transition: str = Field(default="", description="e.g. 'Γ → X'")


class BandUploadResponse(BaseModel):
    """Response after uploading a vasprun.xml for band structure."""
    session_id: str
    nbands: int
    nkpts: int
    nspin: int
    is_spin_polarized: bool
    efermi: float
    is_metal: bool
    band_gap: Optional[BandGapInfo] = None
    elements: List[str]
    ion_types: List[str]
    ion_counts: List[int]
    branches: List[BandBranch]
    structure: Optional[Dict[str, Any]] = None


class BandSeries(BaseModel):
    """Band energies for one spin channel."""
    spin: str = Field(description="'up' or 'down'")
    bands: List[List[float]] = Field(description="[n_bands][n_kpoints] energies relative to Ef")


class BandProjectionGroup(BaseModel):
    """A group of atoms + orbitals for band projection (fat bands)."""
    atoms: List[int] = Field(description="0-based atom indices")
    channels: str = Field(default="d", description="Orbital spec: 'd', 's,p', 'dxy', etc.")
    label: str = Field(default="")


class BandProjection(BaseModel):
    """Projected weights for one group & spin channel."""
    label: str
    spin: str
    weights: List[List[float]] = Field(description="[n_bands][n_kpoints] projection weights (0-1)")


class BandDataRequest(BaseModel):
    """Request band data for plotting."""
    session_id: str
    emin: float = Field(default=-8.0)
    emax: float = Field(default=6.0)


class BandDataResponse(BaseModel):
    """Band structure data for plotting."""
    distance: List[float]
    branches: List[BandBranch]
    band_series: List[BandSeries]
    efermi: float
    is_metal: bool
    band_gap: Optional[BandGapInfo] = None
    tick_labels: List[str]
    tick_positions: List[float]


class BandProjectionRequest(BaseModel):
    """Request projected band data."""
    session_id: str
    groups: List[BandProjectionGroup]
    emin: float = Field(default=-8.0)
    emax: float = Field(default=6.0)


class BandProjectionResponse(BandDataResponse):
    """Band data with projections overlaid."""
    projections: List[BandProjection]


class BandAtomSelectionRequest(BaseModel):
    """Select atoms for band projections."""
    session_id: str
    elements: Optional[List[str]] = None
    index_spec: Optional[str] = None

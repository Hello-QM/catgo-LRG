"""Pydantic models for DOS analysis requests and responses."""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class DOSGroup(BaseModel):
    """A group of atoms + orbitals for PDOS computation."""

    atoms: List[int] = Field(description="0-based atom indices")
    channels: str = Field(default="d", description="Orbital spec: 'd', 's,p', 'dxy,dz2', etc.")
    label: str = Field(default="", description="Human-readable label")
    normalize: bool = Field(default=False, description="Per-atom normalization")


class DOSUploadResponse(BaseModel):
    """Response after uploading a vaspout.h5 file."""

    session_id: str
    nions: int
    nkpts: int
    nbands: int
    nchannels: int
    nspin: int
    elements: List[str]
    ion_types: List[str]
    ion_counts: List[int]
    efermi: float
    structure: Optional[Dict[str, Any]] = Field(
        default=None,
        description="PymatgenStructure dict for 3D viewer",
    )


class PDOSRequest(BaseModel):
    """Request to compute projected DOS."""

    session_id: str
    groups: List[DOSGroup]
    sigma: float = Field(default=0.05, ge=0.001, le=1.0)
    emin: float = Field(default=-8.0)
    emax: float = Field(default=6.0)
    ngrid: int = Field(default=2000, ge=100, le=10000)


class PDOSSeries(BaseModel):
    """A single PDOS series (one group)."""

    label: str
    spin_up: List[float]
    spin_down: Optional[List[float]] = None


class PDOSResponse(BaseModel):
    """Response with computed PDOS data."""

    grid: List[float]
    series: List[PDOSSeries]
    efermi: float


class TotalDOSRequest(BaseModel):
    """Request to compute total DOS."""

    session_id: str
    sigma: float = Field(default=0.05, ge=0.001, le=1.0)
    emin: float = Field(default=-8.0)
    emax: float = Field(default=6.0)
    ngrid: int = Field(default=2000, ge=100, le=10000)


class DBandRequest(BaseModel):
    """Request for d-band analysis."""

    session_id: str
    atoms: List[int] = Field(description="0-based atom indices for d-band analysis")
    sigma: float = Field(default=0.05)
    occupied_only_center: bool = Field(default=True, description="Occupied-only for center calc")
    emin: float = Field(default=-8.0)
    emax: float = Field(default=6.0)
    ngrid: int = Field(default=2000)


class DBandResponse(BaseModel):
    """D-band analysis results."""

    center_abs: Optional[float] = Field(description="D-band center absolute (eV)")
    center_rel: Optional[float] = Field(description="D-band center relative to Ef (eV)")
    width: Optional[float] = Field(description="D-band width / RMS (eV)")
    variance: Optional[float] = Field(description="D-band variance (eV^2)")
    n_d: Optional[float] = Field(description="Occupied d-electron count")
    total_d_weight: Optional[float] = Field(description="Total d-weight")
    filling_fraction: Optional[float] = Field(description="D-band filling fraction (0-1)")
    skewness: Optional[float] = Field(description="3rd standardised moment")
    kurtosis: Optional[float] = Field(description="4th standardised moment")
    lower_edge: Optional[float] = Field(description="Lower band edge (eV rel Ef)")
    upper_edge: Optional[float] = Field(description="Upper band edge (eV rel Ef)")


class AtomSelectionRequest(BaseModel):
    """Request to select atoms by element or index range."""

    session_id: str
    elements: Optional[List[str]] = Field(default=None, description="Element symbols")
    index_spec: Optional[str] = Field(default=None, description="Index spec e.g. '1-5,8-10' (1-based)")

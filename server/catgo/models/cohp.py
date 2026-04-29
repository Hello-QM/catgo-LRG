"""Pydantic models for COHP analysis requests and responses."""

from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field


class COHPBondInfo(BaseModel):
    """Bond metadata returned from parsing."""
    bond_index: int = Field(description="1-based bond number")
    atom1: str = Field(description="First atom, e.g. 'N92'")
    atom2: str = Field(description="Second atom, e.g. 'Mo26'")
    distance: float = Field(description="Bond distance in Angstrom")
    orbital1: Optional[str] = Field(default=None, description="First orbital, e.g. '2s'")
    orbital2: Optional[str] = Field(default=None, description="Second orbital, e.g. '4d_xy'")
    is_total: bool = Field(description="True if total bond (no orbital resolution)")
    label: str = Field(description="Human-readable label")
    element1: str = Field(description="Element symbol of atom1")
    element2: str = Field(description="Element symbol of atom2")


class COHPUploadResponse(BaseModel):
    """Response after uploading COHPCAR.lobster file."""
    session_id: str
    nspin: int
    npoints: int
    ncols: int
    efermi: float
    emin: float
    emax: float
    bonds: List[COHPBondInfo] = Field(description="List of total bonds (no orbital pairs)")
    all_bonds: List[COHPBondInfo] = Field(description="All bonds including orbital-resolved")


class COHPSeries(BaseModel):
    """A single COHP series for plotting."""
    label: str
    spin_up: List[float]
    spin_down: Optional[List[float]] = None
    bond_index: int = Field(description="Bond number this series belongs to")
    is_total: bool = Field(default=False)


class COHPDataRequest(BaseModel):
    """Request COHP data for specific bonds."""
    session_id: str
    bond_indices: List[int] = Field(description="1-based bond numbers to retrieve")
    include_orbitals: bool = Field(default=False, description="Include orbital-resolved data")
    orbital_filter: Optional[List[str]] = Field(
        default=None,
        description="Filter orbital types, e.g. ['p-d', 's-d'] for specific interactions"
    )
    aggregate_orbitals: bool = Field(default=False, description="Sum orbital contributions")


class COHPDataResponse(BaseModel):
    """Response with COHP data for plotting."""
    energies: List[float]
    series: List[COHPSeries]
    efermi: float


class ICOHPEntry(BaseModel):
    """Single ICOHP entry."""
    cohp_num: int
    atom1: str
    atom2: str
    distance: float
    spin_up: float
    spin_down: float
    total: float
    orbital1: Optional[str] = None
    orbital2: Optional[str] = None
    is_total: bool
    label: str


class ICOHPUploadResponse(BaseModel):
    """Response after uploading ICOHPLIST.lobster."""
    session_id: str
    entries: List[ICOHPEntry]


class COHPViewState(BaseModel):
    """Shared view state for COHP display options."""
    show_fermi_line: bool = True
    show_fill: bool = False
    show_spin_down: bool = True
    orientation: str = Field(default="horizontal", description="'horizontal' or 'vertical'")
    x_range: Optional[List[float]] = None
    y_range: Optional[List[float]] = None
    show_gridlines: bool = True
    show_axis_lines: bool = True
    axis_line_width: float = 1.0
    tick_length: int = 5
    tick_width: float = 1.0
    legend_visible: bool = True
    hidden_series: List[str] = Field(default_factory=list)
    invert_cohp: bool = Field(default=True, description="Invert COHP axis (bonding below, antibonding above)")

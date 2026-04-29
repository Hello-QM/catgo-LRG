"""Pydantic models for adsorption site finding."""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class AdsorptionSiteType(str, Enum):
    """Type of adsorption site."""

    TOP = "top"
    BRIDGE = "bridge"
    HOLLOW3 = "hollow3"
    HOLLOW4 = "hollow4"


class AdsorptionSite(BaseModel):
    """A single adsorption site with all relevant information."""

    id: int = Field(..., description="Unique site ID")
    position: list[float] = Field(..., min_length=3, max_length=3, description="Cartesian position [x, y, z] in Å")
    site_type: AdsorptionSiteType = Field(..., description="Type of adsorption site")
    normal: list[float] = Field(default=[0.0, 0.0, 1.0], min_length=3, max_length=3, description="Surface normal vector")
    neighbor_indices: list[int] = Field(default=[], description="Indices of neighboring atoms")
    neighbor_elements: list[str] = Field(default=[], description="Element symbols of neighboring atoms")
    env_signature: str = Field(default="", description="Environment signature (e.g., 'Fe-Fe-O')")
    height: float = Field(default=1.5, description="Height above the surface atoms (Å)")


class AdsorptionSiteFinderParams(BaseModel):
    """Parameters for the V7 Alpha Shape adsorption site finder."""

    alpha: float = Field(default=2.7, ge=1.0, le=10.0, description="Alpha Shape parameter (Å)")
    height: float = Field(default=1.5, ge=0.5, le=5.0, description="Site height above surface (Å)")
    gap_ratio: float = Field(default=1.2, ge=1.0, le=3.0, description="Distance gap ratio for neighbor detection")
    blocking: float = Field(default=0.8, ge=0.1, le=2.0, description="Blocking threshold for direct neighbor check")
    merge: float = Field(default=1.0, ge=0.0, le=5.0, description="Merge threshold for close sites (Å), 0 = no merge")
    pbc: Optional[bool] = Field(default=None, description="Enable PBC (None = auto-detect from structure)")
    keep_bottom: bool = Field(default=False, description="Keep bottom layer in PBC mode")
    bottom_fraction: float = Field(default=0.5, ge=0.0, le=1.0, description="Fraction of slab Z range for bottom surface cutoff (0-1)")
    expansion_distance: float = Field(default=3.0, ge=0.0, le=5.0, description="PBC boundary expansion distance (Å)")
    filter_internal: bool = Field(default=True, description="Filter out internal (non-surface) sites")
    filter_radius: float = Field(default=5.0, description="Radius for internal site filtering (Å)")
    filter_threshold: float = Field(default=0.7, description="Hemisphere ratio threshold for internal filtering")


class AdsorptionSiteRequest(BaseModel):
    """Request for finding adsorption sites."""

    structure: PymatgenStructure
    params: Optional[AdsorptionSiteFinderParams] = None


class AdsorptionSiteResult(BaseModel):
    """Result of adsorption site finding."""

    sites: list[AdsorptionSite]
    n_top: int = 0
    n_bridge: int = 0
    n_hollow3: int = 0
    n_hollow4: int = 0
    message: str = ""

"""Pydantic models for adsorbate placement."""

from typing import Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class AdsorbatePlacementRequest(BaseModel):
    """Request to place an adsorbate molecule at a surface site."""

    slab: PymatgenStructure = Field(..., description="Slab structure")
    adsorbate: PymatgenStructure = Field(..., description="Adsorbate molecule structure")
    binding_atom_index: Optional[int] = Field(default=None, ge=0, description="Index of the binding atom (single-dentate, deprecated)")
    binding_atom_indices: Optional[list[int]] = Field(default=None, description="Indices of binding atoms (supports multi-dentate)")
    site_position: list[float] = Field(..., min_length=3, max_length=3, description="Adsorption site position [x,y,z] in Å")
    site_normal: list[float] = Field(..., min_length=3, max_length=3, description="Surface normal at the site (unit vector)")
    neighbor_positions: Optional[list[list[float]]] = Field(default=None, description="Positions of surface atoms neighboring the site (for topological alignment)")
    height_offset: float = Field(default=0.0, description="Additional height offset along normal (Å)")
    auto_rotate: bool = Field(default=True, description="Rotate adsorbate to align binding direction with surface normal")


class AdsorbatePlacementResult(BaseModel):
    """Result of adsorbate placement."""

    structure: PymatgenStructure = Field(..., description="Merged slab+adsorbate structure")
    slab_atom_count: int = Field(..., description="Number of atoms from the slab")
    adsorbate_atom_count: int = Field(..., description="Number of atoms from the adsorbate")
    adsorbate_indices: list[int] = Field(..., description="Indices of adsorbate atoms in the merged structure")
    binding_atom_position: list[float] = Field(..., description="Final position of the binding atom(s) centroid")
    message: str = Field(default="")

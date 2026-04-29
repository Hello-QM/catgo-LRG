"""Pydantic models for water layer generation."""

from typing import Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class WaterLayerParams(BaseModel):
    """Parameters for water layer generation."""

    z_start: float = Field(
        default=0.0, description="Start z-coordinate of the water filling region (Å)"
    )
    z_end: float = Field(
        default=15.0, description="End z-coordinate of the water filling region (Å)"
    )
    density: float = Field(
        default=0.997, ge=0.1, le=2.0, description="Water density (g/cm³)"
    )
    min_distance: float = Field(
        default=2.0, ge=1.0, le=5.0, description="Minimum distance between water and slab atoms (Å, Packmol tolerance)"
    )
    equilibrate: bool = Field(
        default=False, description="Run LAMMPS TIP4P equilibration after packing"
    )
    equil_steps: int = Field(
        default=1000, ge=100, le=50000, description="Number of equilibration MD steps"
    )
    equil_temperature: float = Field(
        default=300.0, ge=1.0, le=1000.0, description="Equilibration temperature (K)"
    )


class WaterLayerRequest(BaseModel):
    """Request for adding a water layer to a structure."""

    structure: PymatgenStructure
    params: Optional[WaterLayerParams] = None


class WaterLayerResult(BaseModel):
    """Result of water layer generation."""

    structure: PymatgenStructure
    n_water_molecules: int = Field(description="Number of water molecules added")
    n_atoms_added: int = Field(description="Total number of atoms added (3 per water molecule)")
    n_water_filled: int = Field(default=0, description="Total water molecules before removing overlaps")
    n_water_removed: int = Field(default=0, description="Water molecules removed due to overlap")
    z_start: float = Field(description="Start z-coordinate of the water region (Å)")
    z_end: float = Field(description="End z-coordinate of the water region (Å)")
    c_axis_adjusted: bool = Field(default=False, description="Whether c-axis was expanded to fit z_end")
    new_c_length: float = Field(description="New c-axis length (Å)")
    equilibrated: bool = Field(default=False, description="Whether LAMMPS equilibration was performed")
    actual_density: float = Field(default=0.0, description="Actual water density in fill region (g/cm³)")
    message: str = ""

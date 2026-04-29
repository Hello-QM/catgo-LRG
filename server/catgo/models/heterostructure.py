"""Pydantic models for heterostructure (coherent interface) construction."""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class HeterostructureMode(str, Enum):
    """Input mode for heterostructure construction."""

    BULK = "bulk"  # Two bulk structures + Miller indices → CoherentInterfaceBuilder
    SLAB = "slab"  # Two pre-existing slabs → strip vacuum → ZSL match → stack
    LATERAL = "lateral"  # Two slabs joined side-by-side in-plane


class HeterostructureSearchParams(BaseModel):
    """Parameters controlling the lattice-match search via ZSLGenerator."""

    mode: HeterostructureMode = Field(
        default=HeterostructureMode.BULK,
        description="Input mode: 'bulk' (structures + Miller indices) or 'slab' (pre-existing slabs).",
    )
    substrate_miller: list[int] = Field(
        default=[0, 0, 1],
        min_length=3,
        max_length=3,
        description="Miller index (h, k, l) for the substrate surface. Only used in bulk mode.",
    )
    film_miller: list[int] = Field(
        default=[0, 0, 1],
        min_length=3,
        max_length=3,
        description="Miller index (h, k, l) for the film surface. Only used in bulk mode.",
    )
    max_area: float = Field(
        default=400.0,
        ge=10.0,
        le=5000.0,
        description="Maximum superlattice area (Å²) to search.",
    )
    max_area_ratio_tol: float = Field(
        default=0.09,
        ge=0.001,
        le=1.0,
        description="Tolerance on the ratio of film/substrate superlattice areas.",
    )
    max_length_tol: float = Field(
        default=0.03,
        ge=0.001,
        le=0.5,
        description="Max fractional length tolerance for vector matching.",
    )
    max_angle_tol: float = Field(
        default=0.01,
        ge=0.001,
        le=0.5,
        description="Max angle tolerance (radians) for vector matching.",
    )
    max_results: int = Field(
        default=50,
        ge=1,
        le=200,
        description="Maximum number of match candidates to return.",
    )


class HeterostructureMatch(BaseModel):
    """A single lattice match candidate from ZSL search."""

    match_id: int = Field(description="Index of this match")
    match_area: float = Field(description="Matched superlattice area (Å²)")
    film_miller: list[int] = Field(description="Film Miller index used")
    substrate_miller: list[int] = Field(description="Substrate Miller index used")
    film_transformation: list[list[int]] = Field(
        description="2x2 integer transformation matrix (film unit cell → superlattice)"
    )
    substrate_transformation: list[list[int]] = Field(
        description="2x2 integer transformation matrix (substrate unit cell → superlattice)"
    )
    film_sl_vectors: list[list[float]] = Field(
        description="Film superlattice vectors (2 × 3D)"
    )
    substrate_sl_vectors: list[list[float]] = Field(
        description="Substrate superlattice vectors (2 × 3D)"
    )
    strain: float = Field(
        description="Von Mises strain between film and substrate superlattices (%)"
    )
    n_atoms_substrate: int = Field(
        default=0, description="Estimated substrate atom count for this match"
    )
    n_atoms_film: int = Field(
        default=0, description="Estimated film atom count for this match"
    )


class HeterostructureTermination(BaseModel):
    """A termination pair (film_termination, substrate_termination)."""

    film_termination: str
    substrate_termination: str
    label: str = Field(description="Combined label for display")


class HeterostructureSearchRequest(BaseModel):
    """Request for heterostructure lattice-match search."""

    substrate: PymatgenStructure
    film: PymatgenStructure
    params: Optional[HeterostructureSearchParams] = None


class HeterostructureSearchResult(BaseModel):
    """Result of heterostructure lattice-match search."""

    matches: list[HeterostructureMatch]
    terminations: list[HeterostructureTermination]
    n_matches: int = Field(description="Number of lattice matches found")
    n_terminations: int = Field(description="Number of termination pairs")
    message: str = ""


class HeterostructureBuildParams(BaseModel):
    """Parameters for building the heterostructure interface."""

    gap: float = Field(
        default=2.0,
        ge=0.5,
        le=10.0,
        description="Gap distance between film and substrate (Å).",
    )
    vacuum: float = Field(
        default=20.0,
        ge=0.0,
        le=60.0,
        description="Vacuum layer thickness above the film (Å).",
    )
    substrate_thickness: int = Field(
        default=3,
        ge=1,
        le=20,
        description="Substrate thickness (number of layers).",
    )
    film_thickness: int = Field(
        default=3,
        ge=1,
        le=20,
        description="Film thickness (number of layers).",
    )
    twist_angle: float = Field(
        default=0.0,
        ge=0.0,
        le=180.0,
        description="Twist angle to rotate the film relative to the substrate (degrees).",
    )


class HeterostructureBuildRequest(BaseModel):
    """Request for building a heterostructure interface."""

    substrate: PymatgenStructure
    film: PymatgenStructure
    match: HeterostructureMatch
    termination_index: int = Field(
        default=0,
        ge=0,
        description="Index into the terminations list from search result.",
    )
    params: Optional[HeterostructureBuildParams] = None
    search_params: Optional[HeterostructureSearchParams] = None


class ManualBuildRequest(BaseModel):
    """Request for manual slab-mode heterostructure build with user-specified transforms."""

    substrate: PymatgenStructure
    film: PymatgenStructure
    substrate_transform: list[list[int]] = Field(
        description="2×2 integer transformation matrix for substrate supercell.",
    )
    film_transform: list[list[int]] = Field(
        description="2×2 integer transformation matrix for film supercell.",
    )
    gap: float = Field(default=2.0, ge=0.5, le=10.0)
    vacuum: float = Field(default=20.0, ge=0.0, le=60.0)
    twist_angle: float = Field(default=0.0, ge=0.0, le=180.0)


class HeterostructureBuildResult(BaseModel):
    """Result of heterostructure interface construction."""

    structure: PymatgenStructure
    n_atoms: int = Field(description="Total number of atoms")
    n_atoms_substrate: int = Field(description="Number of substrate atoms")
    n_atoms_film: int = Field(description="Number of film atoms")
    match_area: float = Field(description="Superlattice match area (Å²)")
    strain: float = Field(description="Applied strain (%)")
    message: str = ""


# ---------------------------------------------------------------------------
# Registry candidates (batch build)
# ---------------------------------------------------------------------------


class RegistryCandidatesRequest(BaseModel):
    """Request for generating registry scan candidates."""

    substrate: PymatgenStructure
    film: PymatgenStructure
    match: HeterostructureMatch
    n_shift: int = Field(
        default=0, ge=0, le=10,
        description="Grid size: 0 = auto (surface atoms), 2-10 = N×N uniform grid.",
    )
    step_angstrom: float = Field(
        default=0.0, ge=0.0, le=10.0,
        description="Step size in Å for XY grid. If > 0, overrides n_shift.",
    )
    target_z: float = Field(
        default=0.0, ge=0.0, le=200.0,
        description="Target total c-axis length (Å). If > 0, overrides vacuum.",
    )
    gap: float = Field(default=2.0, ge=0.5, le=10.0)
    vacuum: float = Field(default=20.0, ge=0.0, le=60.0)
    fmt: str = Field(
        default="cif",
        description="Output file format: cif, poscar, xyz, extxyz.",
    )
    search_params: Optional[HeterostructureSearchParams] = None


# ---------------------------------------------------------------------------
# Intermat mode models
# ---------------------------------------------------------------------------


class IntermatBuildParams(BaseModel):
    """Parameters for intermat-based heterostructure construction."""

    substrate_miller: list[int] = Field(
        default=[0, 0, 1], min_length=3, max_length=3,
        description="Substrate Miller index (h, k, l).",
    )
    film_miller: list[int] = Field(
        default=[0, 0, 1], min_length=3, max_length=3,
        description="Film Miller index (h, k, l).",
    )
    substrate_thickness: float = Field(
        default=16.0, ge=2.0, le=100.0,
        description="Substrate slab thickness (Å).",
    )
    film_thickness: float = Field(
        default=16.0, ge=2.0, le=100.0,
        description="Film slab thickness (Å).",
    )
    separation: float = Field(
        default=2.5, ge=0.5, le=10.0,
        description="Gap between film and substrate (Å).",
    )
    vacuum: float = Field(
        default=8.0, ge=0.0, le=60.0,
        description="Vacuum padding (Å).",
    )
    max_area: float = Field(
        default=300.0, ge=10.0, le=5000.0,
        description="Maximum superlattice area (Å²).",
    )
    ltol: float = Field(
        default=0.08, ge=0.001, le=0.5,
        description="Length tolerance for ZSL matching.",
    )
    atol: float = Field(
        default=1.0, ge=0.01, le=10.0,
        description="Angle tolerance for ZSL matching (degrees).",
    )
    max_area_ratio_tol: float = Field(
        default=1.0, ge=0.01, le=2.0,
        description="Area ratio tolerance.",
    )
    apply_strain: bool = Field(
        default=False,
        description="Strain the film to match the substrate lattice.",
    )
    disp_intvl: float = Field(
        default=0.0, ge=0.0, le=1.0,
        description="Displacement scan interval (0 = no scan, e.g. 0.25 = 5×5 grid).",
    )


class IntermatBuildRequest(BaseModel):
    """Request for intermat-based heterostructure construction."""

    substrate: PymatgenStructure
    film: PymatgenStructure
    params: Optional[IntermatBuildParams] = None


class IntermatBuildResult(BaseModel):
    """Result of intermat-based heterostructure construction."""

    structure: PymatgenStructure
    n_atoms: int = Field(description="Total number of atoms")
    n_atoms_substrate: int = Field(description="Number of substrate atoms")
    n_atoms_film: int = Field(description="Number of film atoms")
    match_area: float = Field(description="Superlattice match area (Å²)")
    strain: float = Field(description="Von Mises strain (%)")
    mismatch_u: float = Field(description="Lattice mismatch along u (%)")
    mismatch_v: float = Field(description="Lattice mismatch along v (%)")
    mismatch_angle: float = Field(description="Angle mismatch (degrees)")
    area_substrate: float = Field(description="Substrate superlattice area (Å²)")
    area_film: float = Field(description="Film superlattice area (Å²)")
    message: str = ""


# ---------------------------------------------------------------------------
# Lateral (in-plane) heterojunction models
# ---------------------------------------------------------------------------


class LateralSearchParams(BaseModel):
    """Parameters for lateral heterojunction 1D edge-match search."""

    interface_axis: int = Field(
        default=0, ge=0, le=1,
        description="Interface direction: 0 = a-vector, 1 = b-vector.",
    )
    max_length: float = Field(
        default=100.0, ge=5.0, le=500.0,
        description="Maximum matched edge length (Å).",
    )
    max_strain: float = Field(
        default=5.0, ge=0.1, le=20.0,
        description="Maximum 1D strain tolerance (%).",
    )
    max_results: int = Field(
        default=50, ge=1, le=200,
        description="Maximum number of match candidates to return.",
    )


class LateralMatch(BaseModel):
    """A single 1D edge-match candidate for lateral heterojunction."""

    match_id: int = Field(description="Index of this match")
    n1: int = Field(description="Supercell multiplier for slab A along interface edge")
    n2: int = Field(description="Supercell multiplier for slab B along interface edge")
    edge_length_A: float = Field(description="Matched edge length for slab A (Å)")
    edge_length_B: float = Field(description="Matched edge length for slab B (Å)")
    strain_percent: float = Field(description="1D mismatch strain (%)")
    n_atoms_A: int = Field(description="Atom count for slab A supercell")
    n_atoms_B: int = Field(description="Atom count for slab B supercell")


class LateralSearchRequest(BaseModel):
    """Request for lateral heterojunction edge-match search."""

    slab_A: PymatgenStructure
    slab_B: PymatgenStructure
    params: Optional[LateralSearchParams] = None


class LateralSearchResult(BaseModel):
    """Result of lateral heterojunction edge-match search."""

    matches: list[LateralMatch]
    n_matches: int = Field(description="Number of matches found")
    message: str = ""


class LateralBuildParams(BaseModel):
    """Parameters for building a lateral heterojunction."""

    width_A: int = Field(
        default=1, ge=1, le=10,
        description="Repetitions of slab A perpendicular to interface.",
    )
    width_B: int = Field(
        default=1, ge=1, le=10,
        description="Repetitions of slab B perpendicular to interface.",
    )
    buffer: float = Field(
        default=0.0, ge=0.0, le=10.0,
        description="Gap at the lateral interface (Å).",
    )
    vacuum: float = Field(
        default=20.0, ge=0.0, le=60.0,
        description="Vacuum above/below the 2D plane (Å).",
    )


class LateralBuildRequest(BaseModel):
    """Request for building a lateral heterojunction."""

    slab_A: PymatgenStructure
    slab_B: PymatgenStructure
    match: LateralMatch
    params: Optional[LateralBuildParams] = None
    search_params: Optional[LateralSearchParams] = None


class LateralBuildResult(BaseModel):
    """Result of lateral heterojunction construction."""

    structure: PymatgenStructure
    n_atoms: int = Field(description="Total number of atoms")
    n_atoms_A: int = Field(description="Number of slab A atoms")
    n_atoms_B: int = Field(description="Number of slab B atoms")
    interface_length: float = Field(description="Matched interface edge length (Å)")
    strain: float = Field(description="1D strain (%)")
    message: str = ""


# ---------------------------------------------------------------------------
# Grid Scan mode — symmetry-reduced lateral shift exhaustive search
# ---------------------------------------------------------------------------


class GridScanParams(BaseModel):
    """Parameters for grid scan of lateral shifts."""

    n_grid_x: int = Field(default=6, ge=2, le=30, description="Grid density along a-direction.")
    n_grid_y: int = Field(default=6, ge=2, le=30, description="Grid density along b-direction.")
    symprec: float = Field(default=0.1, ge=0.001, le=1.0, description="Symmetry tolerance for 2D analysis.")


class GridScanRequest(BaseModel):
    """Request for grid scan of lateral shifts on a built heterostructure."""

    heterostructure: PymatgenStructure = Field(description="The already-built heterostructure.")
    film: PymatgenStructure = Field(description="Original film slab (for symmetry analysis).")
    n_atoms_substrate: int = Field(description="Number of substrate atoms in the heterostructure.")
    params: Optional[GridScanParams] = None


class GridScanShiftEntry(BaseModel):
    """A single shift point with its structure."""

    shift_frac: list[float] = Field(description="Fractional shift [fx, fy].")
    shift_cart: list[float] = Field(description="Cartesian shift [x, y, z] (Å).")
    structure: PymatgenStructure
    n_atoms: int
    label: str = ""


class GridScanResult(BaseModel):
    """Result of grid scan across irreducible lateral shifts."""

    entries: list[GridScanShiftEntry]
    n_total_grid: int = Field(description="Total grid points before symmetry reduction.")
    n_irreducible: int = Field(description="Number of irreducible grid points.")
    n_symmetry_ops: int = Field(description="Number of 2D symmetry operations found.")
    reduction_ratio: float = Field(description="Symmetry reduction factor.")
    structures: list[PymatgenStructure] = Field(description="All structures for workflow fan-out.")
    labels: list[str] = Field(description="Labels for each structure.")
    message: str = ""

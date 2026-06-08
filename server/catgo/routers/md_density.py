"""MD trajectory density profile analysis endpoints.

Computes 1D density profiles along an axis and 2D planar density maps
from molecular dynamics trajectories using mdtraj and numpy.
Useful for analyzing water layer distributions, surface ordering,
and adsorbate density at interfaces.
"""

import logging
import traceback
from typing import Literal, Optional

import mdtraj as md
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .md_utils import load_trajectory, select_water_atoms

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/md/density", tags=["md-density"])

# Avogadro's number and conversion factors
AVOGADRO = 6.02214076e23
# 1 nm^3 = 1e-24 L = 1e-21 cm^3; 1 Angstrom^3 = 1e-24 cm^3
# For mass density: g/cm^3 = (mass_amu * n_atoms) / (volume_A3 * 1e-24 * AVOGADRO)


# =============================================================================
# Pydantic Models
# =============================================================================


class DensityProfileRequest(BaseModel):
    """Request for a 1D density profile along a Cartesian axis."""

    trajectory_b64: str = Field(
        ..., description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        ...,
        description="Trajectory file format (e.g., 'pdb', 'xyz', 'gro', 'xtc', 'trr', 'dcd', 'nc')",
    )
    topology_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded topology file content (required for binary formats like xtc, trr, dcd)",
    )
    topology_format: Optional[str] = Field(
        default=None,
        description="Topology file format (e.g., 'pdb', 'gro')",
    )
    axis: Literal["x", "y", "z"] = Field(
        ..., description="Cartesian axis along which to compute the density profile"
    )
    n_bins: int = Field(
        default=100, ge=1, le=10000, description="Number of bins along the axis"
    )
    density_type: Literal["number", "mass"] = Field(
        default="number",
        description="Type of density: 'number' (atoms/A^3) or 'mass' (g/cm^3)",
    )
    atom_indices: Optional[list[int]] = Field(
        default=None,
        description="Atom indices to include (0-based). If None, all atoms are used.",
    )
    selection: Optional[str] = Field(
        default=None,
        description=(
            "Semantic atom selection, applied when atom_indices is not given: "
            "'water' (O + 2 H of each water molecule) or 'water_oxygen' (water "
            "O only). Water is found by residue name, falling back to geometry "
            "(O with exactly two H within 1.3 A) for files without residues "
            "such as XDATCAR. If None/'all', all atoms are used."
        ),
    )
    frame_range: Optional[list[int]] = Field(
        default=None,
        description="Frame range [start, end] (inclusive). If None, all frames are used.",
    )


class DensityProfileResponse(BaseModel):
    """Response containing a 1D density profile."""

    bin_centers: list[float] = Field(
        description="Bin center positions along the axis (Angstroms)"
    )
    density: list[float] = Field(
        description="Density values in each bin (atoms/A^3 or g/cm^3)"
    )
    density_type: str = Field(description="Type of density returned")
    axis: str = Field(description="Axis along which the profile was computed")
    axis_label: str = Field(description="Human-readable axis label with units")
    density_label: str = Field(description="Human-readable density label with units")
    total_frames: int = Field(description="Number of frames analyzed")
    n_atoms_selected: int = Field(description="Number of atoms included in the analysis")
    bin_width: float = Field(description="Width of each bin (Angstroms)")


class PlanarDensityRequest(BaseModel):
    """Request for a 2D planar density map."""

    trajectory_b64: str = Field(
        ..., description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        ...,
        description="Trajectory file format (e.g., 'pdb', 'xyz', 'gro', 'xtc', 'trr', 'dcd', 'nc')",
    )
    topology_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded topology file content (required for binary formats like xtc, trr, dcd)",
    )
    topology_format: Optional[str] = Field(
        default=None,
        description="Topology file format (e.g., 'pdb', 'gro')",
    )
    plane: Literal["xy", "xz", "yz"] = Field(
        ..., description="Projection plane for the 2D density map"
    )
    n_bins: list[int] = Field(
        default=[50, 50],
        description="Number of bins [nx, ny] for the 2D histogram",
    )
    atom_indices: Optional[list[int]] = Field(
        default=None,
        description="Atom indices to include (0-based). If None, all atoms are used.",
    )
    selection: Optional[str] = Field(
        default=None,
        description=(
            "Semantic atom selection, applied when atom_indices is not given: "
            "'water' (O + 2 H of each water molecule) or 'water_oxygen' (water "
            "O only). Water is found by residue name, falling back to geometry "
            "(O with exactly two H within 1.3 A) for files without residues "
            "such as XDATCAR. If None/'all', all atoms are used."
        ),
    )
    z_range: Optional[list[float]] = Field(
        default=None,
        description=(
            "Range [min, max] in Angstroms along the axis perpendicular to the plane "
            "for filtering atoms. E.g., for plane='xy', this filters along z."
        ),
    )
    frame_range: Optional[list[int]] = Field(
        default=None,
        description="Frame range [start, end] (inclusive). If None, all frames are used.",
    )


class PlanarDensityResponse(BaseModel):
    """Response containing a 2D planar density map."""

    density: list[list[float]] = Field(
        description="2D density array (n_bins_x x n_bins_y), units: atoms/A^3"
    )
    x_edges: list[float] = Field(
        description="Bin edges along the first axis of the plane (Angstroms)"
    )
    y_edges: list[float] = Field(
        description="Bin edges along the second axis of the plane (Angstroms)"
    )
    x_label: str = Field(description="Label for the first axis of the plane")
    y_label: str = Field(description="Label for the second axis of the plane")
    plane: str = Field(description="Projection plane used")
    total_frames: int = Field(description="Number of frames analyzed")
    n_atoms_selected: int = Field(description="Number of atoms included in the analysis")
    perp_axis: str = Field(
        description="Axis perpendicular to the plane (used for z_range filtering)"
    )


# =============================================================================
# Helper Functions
# =============================================================================


def _get_axis_index(axis: str) -> int:
    """Convert axis name to array index.

    Args:
        axis: One of 'x', 'y', 'z'.

    Returns:
        0, 1, or 2.
    """
    return {"x": 0, "y": 1, "z": 2}[axis.lower()]


def _get_plane_axes(plane: str) -> tuple[int, int, int]:
    """Get the two in-plane axis indices and the perpendicular axis index.

    Args:
        plane: One of 'xy', 'xz', 'yz'.

    Returns:
        Tuple of (axis1_index, axis2_index, perp_axis_index).
    """
    mapping = {
        "xy": (0, 1, 2),
        "xz": (0, 2, 1),
        "yz": (1, 2, 0),
    }
    return mapping[plane.lower()]


def _get_atomic_masses(topology: md.Topology, atom_indices: list[int]) -> np.ndarray:
    """Get atomic masses for the specified atom indices from the mdtraj topology.

    Args:
        topology: mdtraj Topology object.
        atom_indices: List of atom indices.

    Returns:
        Array of atomic masses in atomic mass units (daltons).
    """
    masses = np.array(
        [topology.atom(i).element.mass for i in atom_indices], dtype=np.float64
    )
    return masses


def _select_frames(
    traj: md.Trajectory, frame_range: Optional[list[int]]
) -> md.Trajectory:
    """Slice trajectory to the requested frame range.

    Args:
        traj: Full trajectory.
        frame_range: [start, end] inclusive, or None for all frames.

    Returns:
        Sliced trajectory.
    """
    if frame_range is None:
        return traj

    if len(frame_range) != 2:
        raise HTTPException(
            status_code=400,
            detail="frame_range must be a list of exactly 2 integers [start, end].",
        )

    start, end = frame_range
    if start < 0:
        start = 0
    if end >= traj.n_frames:
        end = traj.n_frames - 1
    if start > end:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid frame_range: start ({start}) > end ({end}).",
        )

    # end+1 because slice is exclusive on the upper bound, but we want inclusive
    return traj[start : end + 1]


def _resolve_atom_indices(
    traj: md.Trajectory,
    atom_indices: Optional[list[int]],
    selection: Optional[str],
) -> np.ndarray:
    """Resolve the atoms to analyze from an explicit list or a semantic
    ``selection`` ('water' / 'water_oxygen' / 'all'). Explicit indices win.
    """
    if atom_indices is not None:
        idx = np.array(atom_indices, dtype=int)
        if len(idx) == 0:
            raise HTTPException(status_code=400, detail="atom_indices is empty.")
        if np.any(idx < 0) or np.any(idx >= traj.n_atoms):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"atom_indices contains out-of-range values. "
                    f"Valid range: 0 to {traj.n_atoms - 1}."
                ),
            )
        return idx

    sel = (selection or "all").lower().strip()
    if sel in ("", "all", "none"):
        return np.arange(traj.n_atoms)
    if sel in ("water", "water_oxygen"):
        idx = select_water_atoms(traj, oxygen_only=(sel == "water_oxygen"))
        if len(idx) == 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No water molecules found in this trajectory (looked for "
                    "water residues, then for O with two nearby H). Use explicit "
                    "atom_indices instead."
                ),
            )
        return idx
    raise HTTPException(
        status_code=400,
        detail=f"Unknown selection '{selection}'. Use 'all', 'water', or 'water_oxygen'.",
    )


def _get_cell_dimensions_angstrom(traj: md.Trajectory) -> Optional[np.ndarray]:
    """Get average unit cell dimensions in Angstroms from the trajectory.

    Args:
        traj: mdtraj Trajectory.

    Returns:
        Array of shape (3,) with [Lx, Ly, Lz] in Angstroms, or None if no
        unit cell information is available.
    """
    if traj.unitcell_lengths is None:
        return None
    # unitcell_lengths is in nm, shape (n_frames, 3)
    # Average over frames and convert to Angstroms
    avg_lengths = np.mean(traj.unitcell_lengths, axis=0) * 10.0  # nm -> A
    return avg_lengths


# =============================================================================
# API Endpoints
# =============================================================================


@router.post("/profile", response_model=DensityProfileResponse)
def density_profile(request: DensityProfileRequest) -> DensityProfileResponse:
    """Compute a 1D density profile along a specified Cartesian axis.

    Bins atom positions along the chosen axis and computes either number density
    (atoms per Angstrom^3) or mass density (g/cm^3) in each bin. The density is
    averaged over all selected frames.

    Use cases:
    - Analyzing water layer density distribution near surfaces
    - Identifying surface layers and density oscillations at interfaces
    - Measuring density gradients across membranes or thin films
    """
    try:
        # Load trajectory
        traj = load_trajectory(
            request.trajectory_b64,
            request.format,
            request.topology_b64,
            request.topology_format,
        )

        # Select frame range
        traj = _select_frames(traj, request.frame_range)
        n_frames = traj.n_frames

        if n_frames == 0:
            raise HTTPException(status_code=400, detail="No frames in the selected range.")

        # Determine atom indices (explicit list, or a semantic selection)
        atom_indices = _resolve_atom_indices(
            traj, request.atom_indices, request.selection
        )
        n_atoms_selected = len(atom_indices)

        # Get positions in Angstroms: mdtraj stores in nm
        # traj.xyz shape: (n_frames, n_atoms, 3) in nm
        positions = traj.xyz[:, atom_indices, :] * 10.0  # nm -> Angstroms

        axis_idx = _get_axis_index(request.axis)
        axis_positions = positions[:, :, axis_idx]  # (n_frames, n_selected_atoms)

        # Determine bin range from cell dimensions or from data extent
        cell_dims = _get_cell_dimensions_angstrom(traj)
        if cell_dims is not None:
            bin_min = 0.0
            bin_max = cell_dims[axis_idx]
        else:
            # No unit cell: use data extent with a small padding
            bin_min = float(np.min(axis_positions))
            bin_max = float(np.max(axis_positions))
            padding = (bin_max - bin_min) * 0.01
            bin_min -= padding
            bin_max += padding

        if bin_max <= bin_min:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Degenerate axis range along {request.axis}: "
                    f"min={bin_min:.4f}, max={bin_max:.4f}."
                ),
            )

        bin_edges = np.linspace(bin_min, bin_max, request.n_bins + 1)
        bin_width = bin_edges[1] - bin_edges[0]  # Angstroms
        bin_centers = 0.5 * (bin_edges[:-1] + bin_edges[1:])

        # Compute histogram: count atoms in each bin across all frames
        # Flatten frame and atom dimensions for histogram
        all_positions_flat = axis_positions.ravel()
        counts, _ = np.histogram(all_positions_flat, bins=bin_edges)
        # counts[i] = total number of atom-frame observations in bin i

        # Compute bin volume for normalization
        # The bin occupies bin_width along the profile axis, and the full cell
        # extent along the other two axes.
        if cell_dims is not None:
            # Cross-sectional area perpendicular to the profile axis
            other_axes = [i for i in range(3) if i != axis_idx]
            cross_section_area = cell_dims[other_axes[0]] * cell_dims[other_axes[1]]
        else:
            # Without cell info, estimate cross-section from data extent
            other_axes = [i for i in range(3) if i != axis_idx]
            all_pos = traj.xyz[:, atom_indices, :] * 10.0  # nm -> A
            extents = []
            for ax in other_axes:
                ax_data = all_pos[:, :, ax]
                extents.append(float(np.max(ax_data) - np.min(ax_data)))
            cross_section_area = extents[0] * extents[1]
            if cross_section_area < 1e-10:
                cross_section_area = 1.0  # Avoid division by zero for 1D/2D systems

        bin_volume = bin_width * cross_section_area  # Angstrom^3

        if request.density_type == "number":
            # Number density: atoms / A^3, averaged over frames
            density = counts.astype(np.float64) / (bin_volume * n_frames)
            density_label = "Number density (atoms/A^3)"
        else:
            # Mass density: g/cm^3
            masses = _get_atomic_masses(traj.topology, atom_indices.tolist())

            # Weight histogram by atomic mass
            # We need per-bin mass, so re-histogram with weights
            mass_tiled = np.tile(masses, n_frames)  # repeat masses for each frame
            mass_counts, _ = np.histogram(
                all_positions_flat, bins=bin_edges, weights=mass_tiled
            )
            # mass_counts[i] = total mass (in amu) in bin i across all frames

            # Convert amu to grams: mass_amu / AVOGADRO
            # Convert A^3 to cm^3: 1 A^3 = 1e-24 cm^3
            # density = (mass_counts / AVOGADRO) / (bin_volume * 1e-24 * n_frames)
            density = mass_counts / (AVOGADRO * bin_volume * 1e-24 * n_frames)
            density_label = "Mass density (g/cm^3)"

        axis_label = f"{request.axis.upper()} (A)"

        return DensityProfileResponse(
            bin_centers=bin_centers.tolist(),
            density=density.tolist(),
            density_type=request.density_type,
            axis=request.axis,
            axis_label=axis_label,
            density_label=density_label,
            total_frames=n_frames,
            n_atoms_selected=n_atoms_selected,
            bin_width=float(bin_width),
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Error computing density profile: %s\n%s", exc, traceback.format_exc()
        )
        raise HTTPException(status_code=500, detail=f"Density profile failed: {exc}")


@router.post("/planar", response_model=PlanarDensityResponse)
def planar_density(request: PlanarDensityRequest) -> PlanarDensityResponse:
    """Compute a 2D planar density map by projecting atom positions onto a plane.

    Creates a 2D histogram of atom positions projected onto the chosen plane
    (xy, xz, or yz). An optional z_range filter restricts the atoms along the
    perpendicular axis, useful for isolating specific layers.

    Use cases:
    - Visualizing in-plane ordering of water molecules at interfaces
    - Mapping adsorbate distributions on surfaces
    - Identifying 2D structural motifs in thin films
    """
    try:
        # Validate n_bins
        if len(request.n_bins) != 2:
            raise HTTPException(
                status_code=400,
                detail="n_bins must be a list of exactly 2 integers [nx, ny].",
            )
        nx, ny = request.n_bins
        if nx < 1 or ny < 1 or nx > 10000 or ny > 10000:
            raise HTTPException(
                status_code=400,
                detail="Each n_bins value must be between 1 and 10000.",
            )

        # Validate z_range
        if request.z_range is not None and len(request.z_range) != 2:
            raise HTTPException(
                status_code=400,
                detail="z_range must be a list of exactly 2 floats [min, max].",
            )

        # Load trajectory
        traj = load_trajectory(
            request.trajectory_b64,
            request.format,
            request.topology_b64,
            request.topology_format,
        )

        # Select frame range
        traj = _select_frames(traj, request.frame_range)
        n_frames = traj.n_frames

        if n_frames == 0:
            raise HTTPException(status_code=400, detail="No frames in the selected range.")

        # Determine atom selection (explicit list, or a semantic selection)
        atom_indices = _resolve_atom_indices(
            traj, request.atom_indices, request.selection
        )
        n_atoms_selected = len(atom_indices)

        # Get positions in Angstroms
        positions = traj.xyz[:, atom_indices, :] * 10.0  # nm -> A
        # positions shape: (n_frames, n_selected, 3)

        # Determine plane axes
        ax1_idx, ax2_idx, perp_idx = _get_plane_axes(request.plane)
        axis_names = {0: "x", 1: "y", 2: "z"}
        x_label = f"{axis_names[ax1_idx].upper()} (A)"
        y_label = f"{axis_names[ax2_idx].upper()} (A)"
        perp_axis_name = axis_names[perp_idx]

        # Filter atoms by z_range (along the perpendicular axis)
        if request.z_range is not None:
            z_min, z_max = request.z_range
            if z_min >= z_max:
                raise HTTPException(
                    status_code=400,
                    detail=f"z_range min ({z_min}) must be less than max ({z_max}).",
                )
            # Get perpendicular axis positions
            perp_positions = positions[:, :, perp_idx]  # (n_frames, n_selected)
            # Create mask: True where atom is within z_range
            mask = (perp_positions >= z_min) & (perp_positions <= z_max)
            # Extract the in-plane coordinates for atoms that pass the filter
            pos_ax1 = positions[:, :, ax1_idx][mask]  # flattened
            pos_ax2 = positions[:, :, ax2_idx][mask]  # flattened
            slab_thickness = z_max - z_min
        else:
            pos_ax1 = positions[:, :, ax1_idx].ravel()
            pos_ax2 = positions[:, :, ax2_idx].ravel()
            # Use full cell extent or data extent for the perpendicular axis
            cell_dims = _get_cell_dimensions_angstrom(traj)
            if cell_dims is not None:
                slab_thickness = cell_dims[perp_idx]
            else:
                perp_data = positions[:, :, perp_idx]
                slab_thickness = float(np.max(perp_data) - np.min(perp_data))
                if slab_thickness < 1e-10:
                    slab_thickness = 1.0

        # Determine bin ranges
        cell_dims = _get_cell_dimensions_angstrom(traj)
        if cell_dims is not None:
            x_range = (0.0, cell_dims[ax1_idx])
            y_range = (0.0, cell_dims[ax2_idx])
        else:
            x_pad = (float(np.max(pos_ax1)) - float(np.min(pos_ax1))) * 0.01
            y_pad = (float(np.max(pos_ax2)) - float(np.min(pos_ax2))) * 0.01
            x_range = (float(np.min(pos_ax1)) - x_pad, float(np.max(pos_ax1)) + x_pad)
            y_range = (float(np.min(pos_ax2)) - y_pad, float(np.max(pos_ax2)) + y_pad)

        if x_range[1] <= x_range[0] or y_range[1] <= y_range[0]:
            raise HTTPException(
                status_code=400,
                detail="Degenerate axis range for the selected plane. Check your data and selections.",
            )

        x_edges = np.linspace(x_range[0], x_range[1], nx + 1)
        y_edges = np.linspace(y_range[0], y_range[1], ny + 1)

        # 2D histogram: counts per bin
        hist, _, _ = np.histogram2d(
            pos_ax1, pos_ax2, bins=[x_edges, y_edges]
        )
        # hist shape: (nx, ny), total counts across all frames

        # Normalize to number density (atoms / A^3)
        # Each bin has volume = dx * dy * slab_thickness
        dx = x_edges[1] - x_edges[0]
        dy = y_edges[1] - y_edges[0]
        bin_volume = dx * dy * slab_thickness  # A^3
        density_2d = hist / (bin_volume * n_frames)

        return PlanarDensityResponse(
            density=density_2d.tolist(),
            x_edges=x_edges.tolist(),
            y_edges=y_edges.tolist(),
            x_label=x_label,
            y_label=y_label,
            plane=request.plane,
            total_frames=n_frames,
            n_atoms_selected=n_atoms_selected,
            perp_axis=perp_axis_name,
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Error computing planar density: %s\n%s", exc, traceback.format_exc()
        )
        raise HTTPException(status_code=500, detail=f"Planar density failed: {exc}")


@router.get("/health")
def md_density_health():
    """Health check for MD density analysis endpoints."""
    return {"status": "healthy", "service": "md-density"}

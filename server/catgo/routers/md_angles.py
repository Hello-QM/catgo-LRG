"""MD trajectory angle and dihedral analysis endpoints using mdtraj.

Provides endpoints for computing bond angles and dihedral angles from
molecular dynamics trajectories. Useful for tracking conformational changes
such as CO2 bending angles during AIMD or adsorbate torsion analysis.
"""

from typing import Optional

import mdtraj as md
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .md_utils import load_trajectory, resolve_periodic

router = APIRouter(prefix="/md/angles", tags=["md-angles"])


# ============================================================================
# Request/Response Models
# ============================================================================

class AngleRequest(BaseModel):
    """Request body for bond angle computation.

    Attributes:
        trajectory_b64: Base64-encoded trajectory file content.
        format: File format/extension (e.g., 'pdb', 'xyz', 'xtc').
        topology_b64: Base64-encoded topology file (required for xtc/trr/dcd formats).
        topology_format: Format of the topology file (default: 'pdb').
        atom_triplets: List of atom index triplets [[i, j, k], ...] where j is
            the vertex atom. Indices are 0-based.
        periodic: Whether to use the minimum image convention when computing
            angles across periodic boundaries.
    """

    trajectory_b64: str = Field(
        ..., description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        ..., description="Trajectory file format/extension (e.g., 'pdb', 'xyz', 'xtc')"
    )
    topology_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded topology file (required for xtc/trr/dcd formats)",
    )
    topology_format: str = Field(
        default="pdb",
        description="Format of the topology file",
    )
    atom_triplets: list[list[int]] = Field(
        ...,
        description=(
            "List of atom index triplets [[i, j, k], ...] where j is the vertex. "
            "Indices are 0-based."
        ),
    )
    periodic: bool = Field(
        default=True,
        description="Use minimum image convention for periodic boundaries",
    )


class DihedralRequest(BaseModel):
    """Request body for dihedral angle computation.

    Attributes:
        trajectory_b64: Base64-encoded trajectory file content.
        format: File format/extension (e.g., 'pdb', 'xyz', 'xtc').
        topology_b64: Base64-encoded topology file (required for xtc/trr/dcd formats).
        topology_format: Format of the topology file (default: 'pdb').
        atom_quartets: List of atom index quartets [[i, j, k, l], ...].
            The dihedral is measured as the angle between planes (i,j,k) and
            (j,k,l). Indices are 0-based.
        periodic: Whether to use the minimum image convention when computing
            dihedrals across periodic boundaries.
    """

    trajectory_b64: str = Field(
        ..., description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        ..., description="Trajectory file format/extension (e.g., 'pdb', 'xyz', 'xtc')"
    )
    topology_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded topology file (required for xtc/trr/dcd formats)",
    )
    topology_format: str = Field(
        default="pdb",
        description="Format of the topology file",
    )
    atom_quartets: list[list[int]] = Field(
        ...,
        description=(
            "List of atom index quartets [[i, j, k, l], ...]. "
            "Dihedral is the angle between planes (i,j,k) and (j,k,l). "
            "Indices are 0-based."
        ),
    )
    periodic: bool = Field(
        default=True,
        description="Use minimum image convention for periodic boundaries",
    )


class AngleResponse(BaseModel):
    """Response containing computed bond angles.

    Attributes:
        angles_deg: 2D array of angles in degrees, shape (n_frames, n_angles).
        frame_indices: List of frame indices [0, 1, 2, ...].
        n_frames: Number of frames in the trajectory.
        n_angles: Number of angle triplets computed.
        atom_triplets: Echo of the input atom triplets for reference.
    """

    angles_deg: list[list[float]] = Field(
        ..., description="Angles in degrees, shape (n_frames, n_angles)"
    )
    frame_indices: list[int] = Field(
        ..., description="Frame indices [0, 1, 2, ...]"
    )
    n_frames: int = Field(..., description="Number of frames in the trajectory")
    n_angles: int = Field(..., description="Number of angle triplets computed")
    atom_triplets: list[list[int]] = Field(
        ..., description="Echo of input atom triplets"
    )


class DihedralResponse(BaseModel):
    """Response containing computed dihedral angles.

    Attributes:
        dihedrals_deg: 2D array of dihedral angles in degrees,
            shape (n_frames, n_dihedrals). Range is [-180, 180].
        frame_indices: List of frame indices [0, 1, 2, ...].
        n_frames: Number of frames in the trajectory.
        n_dihedrals: Number of dihedral quartets computed.
        atom_quartets: Echo of the input atom quartets for reference.
    """

    dihedrals_deg: list[list[float]] = Field(
        ..., description="Dihedral angles in degrees, shape (n_frames, n_dihedrals)"
    )
    frame_indices: list[int] = Field(
        ..., description="Frame indices [0, 1, 2, ...]"
    )
    n_frames: int = Field(..., description="Number of frames in the trajectory")
    n_dihedrals: int = Field(
        ..., description="Number of dihedral quartets computed"
    )
    atom_quartets: list[list[int]] = Field(
        ..., description="Echo of input atom quartets"
    )


# ============================================================================
# Helper Functions
# ============================================================================

def validate_atom_indices(
    indices: list[list[int]], n_atoms: int, expected_width: int, label: str
) -> np.ndarray:
    """Validate and convert atom index lists to a numpy array.

    Args:
        indices: List of atom index tuples (triplets or quartets).
        n_atoms: Total number of atoms in the trajectory.
        expected_width: Expected number of indices per tuple (3 for angles,
            4 for dihedrals).
        label: Human-readable label for error messages (e.g., 'triplet',
            'quartet').

    Returns:
        numpy ndarray of shape (n_tuples, expected_width) with dtype int32.

    Raises:
        HTTPException: If indices are empty, have wrong width, or are out of
            range.
    """
    if len(indices) == 0:
        raise HTTPException(
            status_code=400,
            detail=f"At least one atom {label} must be provided.",
        )

    for idx, group in enumerate(indices):
        if len(group) != expected_width:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Atom {label} at position {idx} has {len(group)} indices, "
                    f"expected {expected_width}. Got: {group}"
                ),
            )
        for atom_idx in group:
            if not isinstance(atom_idx, int) or atom_idx < 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Invalid atom index {atom_idx} in {label} at position "
                        f"{idx}. Indices must be non-negative integers."
                    ),
                )
            if atom_idx >= n_atoms:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Atom index {atom_idx} in {label} at position {idx} "
                        f"is out of range. Trajectory has {n_atoms} atoms "
                        f"(valid range: 0 to {n_atoms - 1})."
                    ),
                )

    return np.array(indices, dtype=np.int32)


# ============================================================================
# API Endpoints
# ============================================================================

@router.post("/angles", response_model=AngleResponse)
def compute_angles(request: AngleRequest) -> AngleResponse:
    """Compute bond angles from an MD trajectory.

    Calculates the angle formed by each atom triplet [i, j, k] where atom j
    is the vertex. This is useful for tracking geometric changes such as the
    O-C-O bending angle in CO2 during ab initio molecular dynamics (AIMD).

    mdtraj.compute_angles returns values in radians; this endpoint converts
    them to degrees before returning.

    Args:
        request: AngleRequest containing the trajectory data, format, atom
            triplets, and periodicity flag.

    Returns:
        AngleResponse with angles in degrees for each frame and each triplet.

    Raises:
        HTTPException 400: Invalid input (bad base64, unsupported format,
            invalid atom indices).
        HTTPException 500: Unexpected computation error.
    """
    # Load trajectory
    traj = load_trajectory(
        content_b64=request.trajectory_b64,
        fmt=request.format,
        topology_b64=request.topology_b64,
        topology_format=request.topology_format,
    )

    # Validate and convert atom triplets
    n_atoms = traj.n_atoms
    angle_indices = validate_atom_indices(
        indices=request.atom_triplets,
        n_atoms=n_atoms,
        expected_width=3,
        label="triplet",
    )

    # Compute angles using mdtraj (returns radians)
    try:
        angles_rad = md.compute_angles(
            traj, angle_indices, periodic=resolve_periodic(traj, request.periodic), opt=True
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"mdtraj.compute_angles failed: {exc}",
        )

    # Convert radians to degrees
    angles_deg = np.degrees(angles_rad)

    # Build response
    n_frames = angles_deg.shape[0]
    n_angles = angles_deg.shape[1]
    frame_indices = list(range(n_frames))

    return AngleResponse(
        angles_deg=angles_deg.tolist(),
        frame_indices=frame_indices,
        n_frames=n_frames,
        n_angles=n_angles,
        atom_triplets=request.atom_triplets,
    )


@router.post("/dihedrals", response_model=DihedralResponse)
def compute_dihedrals(request: DihedralRequest) -> DihedralResponse:
    """Compute dihedral (torsion) angles from an MD trajectory.

    Calculates the dihedral angle for each atom quartet [i, j, k, l], defined
    as the angle between the plane formed by atoms (i, j, k) and the plane
    formed by atoms (j, k, l). This is useful for analyzing adsorbate
    conformational changes, backbone torsions, and rotational barriers.

    mdtraj.compute_dihedrals returns values in radians (range [-pi, pi]);
    this endpoint converts them to degrees (range [-180, 180]).

    Args:
        request: DihedralRequest containing the trajectory data, format, atom
            quartets, and periodicity flag.

    Returns:
        DihedralResponse with dihedral angles in degrees for each frame and
        each quartet.

    Raises:
        HTTPException 400: Invalid input (bad base64, unsupported format,
            invalid atom indices).
        HTTPException 500: Unexpected computation error.
    """
    # Load trajectory
    traj = load_trajectory(
        content_b64=request.trajectory_b64,
        fmt=request.format,
        topology_b64=request.topology_b64,
        topology_format=request.topology_format,
    )

    # Validate and convert atom quartets
    n_atoms = traj.n_atoms
    dihedral_indices = validate_atom_indices(
        indices=request.atom_quartets,
        n_atoms=n_atoms,
        expected_width=4,
        label="quartet",
    )

    # Compute dihedrals using mdtraj (returns radians in [-pi, pi])
    try:
        dihedrals_rad = md.compute_dihedrals(
            traj, dihedral_indices, periodic=resolve_periodic(traj, request.periodic), opt=True
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"mdtraj.compute_dihedrals failed: {exc}",
        )

    # Convert radians to degrees
    dihedrals_deg = np.degrees(dihedrals_rad)

    # Build response
    n_frames = dihedrals_deg.shape[0]
    n_dihedrals = dihedrals_deg.shape[1]
    frame_indices = list(range(n_frames))

    return DihedralResponse(
        dihedrals_deg=dihedrals_deg.tolist(),
        frame_indices=frame_indices,
        n_frames=n_frames,
        n_dihedrals=n_dihedrals,
        atom_quartets=request.atom_quartets,
    )

"""MD trajectory RMSD and RMSF analysis endpoints using mdtraj."""

from typing import Optional

import mdtraj as md
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .md_utils import load_trajectory


router = APIRouter(prefix="/md/rmsd", tags=["md-rmsd"])


# ============================================================================
# Request/Response Models
# ============================================================================


class RMSDRequest(BaseModel):
    """Request for RMSD calculation over an MD trajectory."""

    trajectory_b64: str = Field(
        description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        description=(
            "Trajectory file format extension (e.g., 'pdb', 'xyz', 'xtc', "
            "'trr', 'dcd', 'nc', 'h5', 'lh5', 'lammpstrj')"
        )
    )
    ref_frame: int = Field(
        default=0,
        description="Index of the reference frame for RMSD calculation (0-indexed)",
    )
    atom_indices: Optional[list[int]] = Field(
        default=None,
        description=(
            "Atom indices to include in the RMSD calculation (0-indexed). "
            "If None, all atoms are used."
        ),
    )
    precentered: bool = Field(
        default=False,
        description=(
            "If True, assume the trajectory coordinates are already centered "
            "at the origin. This skips the centering step and can speed up "
            "repeated calculations on the same trajectory. The user must call "
            "traj.center_coordinates() beforehand for correct results."
        ),
    )


class RMSDResponse(BaseModel):
    """Response containing RMSD values for each frame."""

    rmsd_angstroms: list[float] = Field(
        description="RMSD values per frame in Angstroms"
    )
    frame_indices: list[int] = Field(
        description="Frame indices corresponding to each RMSD value"
    )
    ref_frame: int = Field(
        description="Reference frame index used for the calculation"
    )
    n_frames: int = Field(description="Total number of frames in the trajectory")
    n_atoms_used: int = Field(
        description="Number of atoms included in the RMSD calculation"
    )


class RMSFRequest(BaseModel):
    """Request for RMSF calculation per atom over an MD trajectory."""

    trajectory_b64: str = Field(
        description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        description=(
            "Trajectory file format extension (e.g., 'pdb', 'xyz', 'xtc', "
            "'trr', 'dcd', 'nc', 'h5', 'lh5', 'lammpstrj')"
        )
    )
    atom_indices: Optional[list[int]] = Field(
        default=None,
        description=(
            "Atom indices to include in the RMSF calculation (0-indexed). "
            "If None, all atoms are used."
        ),
    )
    ref_frame: Optional[int] = Field(
        default=None,
        description=(
            "Reference frame index for RMSF calculation. If None, the average "
            "structure over the trajectory is used as the reference (recommended "
            "for fluctuation analysis)."
        ),
    )


class RMSFResponse(BaseModel):
    """Response containing RMSF values for each atom."""

    rmsf_angstroms: list[float] = Field(
        description="RMSF values per atom in Angstroms"
    )
    atom_indices: list[int] = Field(
        description="Atom indices corresponding to each RMSF value"
    )
    n_frames: int = Field(description="Total number of frames used in the calculation")
    n_atoms: int = Field(
        description="Number of atoms included in the RMSF calculation"
    )
    reference: str = Field(
        description=(
            "Description of the reference used: 'average' for average structure "
            "or 'frame:<N>' for a specific frame index"
        )
    )


# ============================================================================
# Helper Functions
# ============================================================================


def _compute_average_structure(traj: md.Trajectory) -> md.Trajectory:
    """Compute the average structure of a trajectory.

    Creates a single-frame trajectory whose coordinates are the mean
    positions across all frames. This is used as the reference for RMSF
    when no specific reference frame is given.

    Args:
        traj: Input trajectory.

    Returns:
        A single-frame trajectory with averaged coordinates.
    """
    avg_xyz = traj.xyz.mean(axis=0, keepdims=True)  # shape (1, n_atoms, 3)
    avg_traj = md.Trajectory(
        xyz=avg_xyz,
        topology=traj.topology,
        unitcell_lengths=traj.unitcell_lengths[0:1] if traj.unitcell_lengths is not None else None,
        unitcell_angles=traj.unitcell_angles[0:1] if traj.unitcell_angles is not None else None,
    )
    return avg_traj


# ============================================================================
# API Endpoints
# ============================================================================


@router.post("/rmsd", response_model=RMSDResponse)
def compute_rmsd(request: RMSDRequest) -> RMSDResponse:
    """Compute the RMSD of each trajectory frame relative to a reference frame.

    The Root-Mean-Square Deviation (RMSD) measures how much the atomic
    positions in each frame deviate from a reference configuration. This is
    useful for tracking structural drift over an MD simulation, monitoring
    convergence, and identifying surface reconstruction events.

    The calculation uses mdtraj.rmsd() which performs an optimal rigid-body
    superposition (Kabsch algorithm) before computing the deviation. Results
    are returned in Angstroms (mdtraj works internally in nanometers).

    Args:
        request: RMSDRequest with trajectory data, format, and options.

    Returns:
        RMSDResponse with per-frame RMSD values in Angstroms.
    """
    # Load trajectory
    traj = load_trajectory(request.trajectory_b64, request.format)

    # Validate reference frame index
    if request.ref_frame < 0 or request.ref_frame >= traj.n_frames:
        raise HTTPException(
            status_code=400,
            detail=(
                f"ref_frame={request.ref_frame} is out of range. "
                f"Trajectory has {traj.n_frames} frames (valid range: "
                f"0 to {traj.n_frames - 1})."
            ),
        )

    # Validate atom indices if provided
    atom_indices = None
    if request.atom_indices is not None:
        atom_indices = np.array(request.atom_indices, dtype=np.int32)
        if len(atom_indices) == 0:
            raise HTTPException(
                status_code=400,
                detail="atom_indices is empty. Provide at least one atom index or omit the field to use all atoms.",
            )
        if atom_indices.min() < 0 or atom_indices.max() >= traj.n_atoms:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"atom_indices contains out-of-range values. "
                    f"Valid atom indices are 0 to {traj.n_atoms - 1}. "
                    f"Got min={int(atom_indices.min())}, max={int(atom_indices.max())}."
                ),
            )

    # Optionally pre-center coordinates for performance
    if request.precentered:
        traj.center_coordinates()

    # Compute RMSD using mdtraj
    # md.rmsd(target, reference, frame, atom_indices, precentered)
    # - target: the trajectory whose frames are compared
    # - reference: the trajectory containing the reference frame
    # - frame: index of the reference frame within the reference trajectory
    # - atom_indices: subset of atoms to use
    # - precentered: skip centering if already done
    try:
        rmsd_nm = md.rmsd(
            traj,
            traj,
            frame=request.ref_frame,
            atom_indices=atom_indices,
            precentered=request.precentered,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"RMSD calculation failed: {exc}",
        )

    # Convert nanometers -> Angstroms
    rmsd_angstroms = (rmsd_nm * 10.0).tolist()

    n_atoms_used = len(atom_indices) if atom_indices is not None else traj.n_atoms

    return RMSDResponse(
        rmsd_angstroms=rmsd_angstroms,
        frame_indices=list(range(traj.n_frames)),
        ref_frame=request.ref_frame,
        n_frames=traj.n_frames,
        n_atoms_used=n_atoms_used,
    )


@router.post("/rmsf", response_model=RMSFResponse)
def compute_rmsf(request: RMSFRequest) -> RMSFResponse:
    """Compute the RMSF of each atom over the trajectory.

    The Root-Mean-Square Fluctuation (RMSF) measures the time-averaged
    deviation of each atom from a reference position. High RMSF values
    indicate mobile or flexible atoms, while low values indicate rigid
    regions. This is particularly useful for identifying active surface
    sites, mobile adsorbates, and regions of structural disorder.

    When no reference frame is specified, the average structure across
    all frames is used as the reference, which is the standard approach
    for computing thermal fluctuations.

    Results are returned in Angstroms (mdtraj works internally in
    nanometers).

    Args:
        request: RMSFRequest with trajectory data, format, and options.

    Returns:
        RMSFResponse with per-atom RMSF values in Angstroms.
    """
    # Load trajectory
    traj = load_trajectory(request.trajectory_b64, request.format)

    if traj.n_frames < 2:
        raise HTTPException(
            status_code=400,
            detail=(
                "RMSF calculation requires at least 2 frames in the trajectory. "
                f"Got {traj.n_frames} frame(s)."
            ),
        )

    # Validate atom indices if provided
    atom_indices = None
    if request.atom_indices is not None:
        atom_indices = np.array(request.atom_indices, dtype=np.int32)
        if len(atom_indices) == 0:
            raise HTTPException(
                status_code=400,
                detail="atom_indices is empty. Provide at least one atom index or omit the field to use all atoms.",
            )
        if atom_indices.min() < 0 or atom_indices.max() >= traj.n_atoms:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"atom_indices contains out-of-range values. "
                    f"Valid atom indices are 0 to {traj.n_atoms - 1}. "
                    f"Got min={int(atom_indices.min())}, max={int(atom_indices.max())}."
                ),
            )

    # Determine reference structure
    if request.ref_frame is not None:
        # Use a specific frame as the reference
        if request.ref_frame < 0 or request.ref_frame >= traj.n_frames:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"ref_frame={request.ref_frame} is out of range. "
                    f"Trajectory has {traj.n_frames} frames (valid range: "
                    f"0 to {traj.n_frames - 1})."
                ),
            )
        reference = traj
        ref_frame_idx = request.ref_frame
        reference_label = f"frame:{request.ref_frame}"
    else:
        # Use the average structure as reference.
        # Superpose the trajectory onto the first frame first so that the
        # average is computed on aligned structures.
        traj.superpose(traj, frame=0, atom_indices=atom_indices)
        avg_traj = _compute_average_structure(traj)
        reference = avg_traj
        ref_frame_idx = 0
        reference_label = "average"

    # Compute RMSF using mdtraj
    # md.rmsf(target, reference, frame, atom_indices=None)
    # - target: trajectory whose fluctuations are calculated
    # - reference: trajectory containing the reference frame
    # - frame: index of the reference frame within the reference trajectory
    # - atom_indices: subset of atoms to analyze
    try:
        rmsf_nm = md.rmsf(
            traj,
            reference,
            ref_frame_idx,
            atom_indices=atom_indices,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"RMSF calculation failed: {exc}",
        )

    # Convert nanometers -> Angstroms
    rmsf_angstroms = (rmsf_nm * 10.0).tolist()

    # Determine which atom indices are in the result
    if atom_indices is not None:
        result_atom_indices = atom_indices.tolist()
    else:
        result_atom_indices = list(range(traj.n_atoms))

    return RMSFResponse(
        rmsf_angstroms=rmsf_angstroms,
        atom_indices=result_atom_indices,
        n_frames=traj.n_frames,
        n_atoms=len(rmsf_angstroms),
        reference=reference_label,
    )

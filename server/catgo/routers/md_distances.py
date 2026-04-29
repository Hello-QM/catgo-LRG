"""MD trajectory distance analysis endpoints using mdtraj.

Provides pairwise distance tracking, neighbor analysis, center-of-mass
computation, and radial distribution function (RDF) calculation for
molecular dynamics trajectories. All distance outputs are in Angstroms.
"""

from typing import Optional

import mdtraj as md
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .md_utils import load_trajectory, resolve_periodic

router = APIRouter(prefix="/md/distances", tags=["md-distances"])

# mdtraj works in nanometers; our users work in Angstroms
NM_TO_ANGSTROM = 10.0
ANGSTROM_TO_NM = 0.1


# ============================================================================
# Request / Response Models
# ============================================================================


class PairwiseDistancesRequest(BaseModel):
    """Request body for pairwise distance computation."""

    trajectory_b64: str = Field(
        ..., description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        ..., description="Trajectory file format (pdb, xyz, extxyz, lammpstrj, ...)"
    )
    atom_pairs: list[list[int]] = Field(
        ...,
        description="List of atom index pairs [[i, j], ...] (0-indexed)",
        min_length=1,
    )
    periodic: bool = Field(
        default=True,
        description="Whether to apply periodic boundary conditions",
    )


class PairwiseDistancesResponse(BaseModel):
    """Response for pairwise distance computation."""

    distances: list[list[float]] = Field(
        description="Distance matrix (n_frames x n_pairs) in Angstroms"
    )
    frame_indices: list[int] = Field(
        description="Frame indices [0, 1, ..., n_frames-1]"
    )
    n_frames: int
    n_pairs: int


class NeighborsRequest(BaseModel):
    """Request body for neighbor-list computation."""

    trajectory_b64: str = Field(
        ..., description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        ..., description="Trajectory file format"
    )
    query_indices: list[int] = Field(
        ...,
        description="Atom indices to find neighbors for (0-indexed)",
        min_length=1,
    )
    cutoff: float = Field(
        ...,
        description="Cutoff radius in Angstroms",
        gt=0,
    )
    haystack_indices: Optional[list[int]] = Field(
        default=None,
        description=(
            "Atom indices to search among. If None, all atoms are candidates."
        ),
    )
    frame_index: Optional[int] = Field(
        default=None,
        description=(
            "Specific frame to analyze (0-indexed). "
            "If None, all frames are analyzed."
        ),
    )


class FrameNeighborEntry(BaseModel):
    """Neighbor information for a single frame."""

    frame: int
    neighbors: dict[str, list[int]] = Field(
        description=(
            "Mapping from query atom index (as string key) to list of "
            "neighbor atom indices"
        ),
    )
    distances: dict[str, list[float]] = Field(
        description=(
            "Mapping from query atom index (as string key) to list of "
            "distances in Angstroms, same order as neighbors"
        ),
    )


class NeighborsResponse(BaseModel):
    """Response for neighbor-list computation."""

    frames: list[FrameNeighborEntry]
    cutoff_angstrom: float
    n_query_atoms: int


class CenterOfMassRequest(BaseModel):
    """Request body for center-of-mass computation."""

    trajectory_b64: str = Field(
        ..., description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        ..., description="Trajectory file format"
    )
    atom_indices: list[int] = Field(
        ...,
        description="Atom indices defining the group (0-indexed)",
        min_length=1,
    )


class CenterOfMassResponse(BaseModel):
    """Response for center-of-mass computation."""

    positions: list[list[float]] = Field(
        description="Center-of-mass positions per frame (n_frames x 3) in Angstroms"
    )
    frame_indices: list[int]
    n_frames: int


class AtomSelection(BaseModel):
    """Defines one side of an RDF pair selection."""

    indices: Optional[list[int]] = Field(
        default=None,
        description="Explicit atom indices (0-indexed). Mutually exclusive with 'element'.",
    )
    element: Optional[str] = Field(
        default=None,
        description=(
            "Element symbol to select (e.g. 'O', 'Cu'). "
            "Mutually exclusive with 'indices'."
        ),
    )


class RdfRequest(BaseModel):
    """Request body for radial distribution function computation."""

    trajectory_b64: str = Field(
        ..., description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        ..., description="Trajectory file format"
    )
    selection_1: AtomSelection = Field(
        ..., description="First atom selection for RDF pairs"
    )
    selection_2: AtomSelection = Field(
        ..., description="Second atom selection for RDF pairs"
    )
    r_range: list[float] = Field(
        default=[0.0, 10.0],
        description="[r_min, r_max] in Angstroms",
        min_length=2,
        max_length=2,
    )
    n_bins: int = Field(
        default=200,
        description="Number of histogram bins",
        gt=0,
    )
    periodic: bool = Field(
        default=True,
        description="Whether to apply periodic boundary conditions",
    )


class RdfResponse(BaseModel):
    """Response for radial distribution function computation."""

    r: list[float] = Field(description="Bin center positions in Angstroms")
    g_r: list[float] = Field(description="g(r) values")
    coordination_number: list[float] = Field(
        description="Running coordination number (cumulative integral of g(r))"
    )
    n_pairs: int = Field(description="Number of atom pairs used")


# ============================================================================
# Helper: resolve AtomSelection to indices
# ============================================================================


def _resolve_selection(
    selection: AtomSelection, topology: md.Topology, label: str
) -> np.ndarray:
    """Convert an AtomSelection into a numpy array of atom indices.

    Args:
        selection: The atom selection specification.
        topology: mdtraj Topology for element-based lookups.
        label: Human-readable label for error messages (e.g. "selection_1").

    Returns:
        1-D numpy int array of atom indices.
    """
    if selection.indices is not None and selection.element is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{label}: provide either 'indices' or 'element', not both"
            ),
        )
    if selection.indices is not None:
        return np.array(selection.indices, dtype=np.int32)
    if selection.element is not None:
        indices = topology.select(f"element {selection.element}")
        if len(indices) == 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{label}: no atoms found for element '{selection.element}'"
                ),
            )
        return indices
    raise HTTPException(
        status_code=400,
        detail=f"{label}: must specify either 'indices' or 'element'",
    )


# ============================================================================
# Endpoints
# ============================================================================


@router.post("/pairwise", response_model=PairwiseDistancesResponse)
def compute_distances(request: PairwiseDistancesRequest) -> PairwiseDistancesResponse:
    """Compute pairwise distances between specified atom pairs across all frames.

    Tracks the distance evolution of specific atom pairs throughout a
    trajectory. Typical use case: monitoring adsorbate-surface distance
    in AIMD simulations.

    All returned distances are in Angstroms.
    """
    traj = load_trajectory(request.trajectory_b64, request.format)

    atom_pairs = np.array(request.atom_pairs, dtype=np.int32)
    if atom_pairs.ndim != 2 or atom_pairs.shape[1] != 2:
        raise HTTPException(
            status_code=400,
            detail="atom_pairs must be a list of [i, j] pairs",
        )

    # Validate indices
    n_atoms = traj.n_atoms
    if np.any(atom_pairs < 0) or np.any(atom_pairs >= n_atoms):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Atom indices out of range. Trajectory has {n_atoms} atoms "
                f"(valid range: 0 to {n_atoms - 1})"
            ),
        )

    try:
        # md.compute_distances returns shape (n_frames, n_pairs) in nanometers
        distances_nm = md.compute_distances(
            traj, atom_pairs, periodic=resolve_periodic(traj, request.periodic)
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"mdtraj compute_distances failed: {exc}",
        )

    distances_ang = (distances_nm * NM_TO_ANGSTROM).tolist()
    frame_indices = list(range(traj.n_frames))

    return PairwiseDistancesResponse(
        distances=distances_ang,
        frame_indices=frame_indices,
        n_frames=traj.n_frames,
        n_pairs=atom_pairs.shape[0],
    )


@router.post("/neighbors", response_model=NeighborsResponse)
def compute_neighbors(request: NeighborsRequest) -> NeighborsResponse:
    """Find atoms within a cutoff radius of query atoms.

    For each query atom and each requested frame, returns the list of
    neighboring atom indices and their distances.  Useful for coordination
    environment analysis around active sites.

    All distances are in Angstroms.
    """
    traj = load_trajectory(request.trajectory_b64, request.format)

    n_atoms = traj.n_atoms
    for idx in request.query_indices:
        if idx < 0 or idx >= n_atoms:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Query atom index {idx} out of range. "
                    f"Trajectory has {n_atoms} atoms (0 to {n_atoms - 1})"
                ),
            )

    cutoff_nm = request.cutoff * ANGSTROM_TO_NM

    haystack = (
        np.array(request.haystack_indices, dtype=np.int32)
        if request.haystack_indices is not None
        else None
    )

    # Determine frames to analyze
    if request.frame_index is not None:
        if request.frame_index < 0 or request.frame_index >= traj.n_frames:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"frame_index {request.frame_index} out of range. "
                    f"Trajectory has {traj.n_frames} frames (0 to {traj.n_frames - 1})"
                ),
            )
        frame_iter = [request.frame_index]
    else:
        frame_iter = range(traj.n_frames)

    result_frames: list[FrameNeighborEntry] = []

    try:
        for frame_idx in frame_iter:
            frame_traj = traj[frame_idx]
            neighbors_dict: dict[str, list[int]] = {}
            distances_dict: dict[str, list[float]] = {}

            for q_idx in request.query_indices:
                # md.compute_neighbors returns a 1-D array of neighbor indices
                # for a single-frame trajectory.
                # Signature: compute_neighbors(traj, cutoff, query_indices,
                #                              haystack_indices=None, periodic=True)
                neighbor_indices = md.compute_neighbors(
                    frame_traj,
                    cutoff_nm,
                    [q_idx],
                    haystack_indices=haystack,
                )
                # compute_neighbors returns a list of arrays (one per frame);
                # for single frame we take the first
                if isinstance(neighbor_indices, list):
                    nb_arr = np.asarray(neighbor_indices[0], dtype=np.int32)
                else:
                    nb_arr = np.asarray(neighbor_indices, dtype=np.int32)

                # Remove the query atom itself if present
                nb_arr = nb_arr[nb_arr != q_idx]

                # Compute the actual distances for these neighbors
                if len(nb_arr) > 0:
                    pairs = np.column_stack(
                        [np.full(len(nb_arr), q_idx, dtype=np.int32), nb_arr]
                    )
                    dists_nm = md.compute_distances(frame_traj, pairs, periodic=resolve_periodic(traj, True))
                    dists_ang = (dists_nm[0] * NM_TO_ANGSTROM).tolist()
                else:
                    dists_ang = []

                neighbors_dict[str(q_idx)] = nb_arr.tolist()
                distances_dict[str(q_idx)] = dists_ang

            result_frames.append(
                FrameNeighborEntry(
                    frame=frame_idx,
                    neighbors=neighbors_dict,
                    distances=distances_dict,
                )
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Neighbor computation failed: {exc}",
        )

    return NeighborsResponse(
        frames=result_frames,
        cutoff_angstrom=request.cutoff,
        n_query_atoms=len(request.query_indices),
    )


@router.post("/center-of-mass", response_model=CenterOfMassResponse)
def compute_center_of_mass(
    request: CenterOfMassRequest,
) -> CenterOfMassResponse:
    """Compute the center of mass of a group of atoms for each frame.

    Useful for tracking molecular adsorbate position and orientation
    relative to a surface throughout an AIMD trajectory.

    Positions are returned in Angstroms.
    """
    traj = load_trajectory(request.trajectory_b64, request.format)

    n_atoms = traj.n_atoms
    for idx in request.atom_indices:
        if idx < 0 or idx >= n_atoms:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Atom index {idx} out of range. "
                    f"Trajectory has {n_atoms} atoms (0 to {n_atoms - 1})"
                ),
            )

    try:
        # Build a sub-trajectory containing only the selected atoms
        sub_traj = traj.atom_slice(request.atom_indices)

        # md.compute_center_of_mass returns shape (n_frames, 3) in nanometers
        # It uses atomic masses from the topology
        com_nm = md.compute_center_of_mass(sub_traj)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Center-of-mass computation failed: {exc}",
        )

    com_ang = (com_nm * NM_TO_ANGSTROM).tolist()
    frame_indices = list(range(traj.n_frames))

    return CenterOfMassResponse(
        positions=com_ang,
        frame_indices=frame_indices,
        n_frames=traj.n_frames,
    )


@router.post("/rdf", response_model=RdfResponse)
def compute_rdf(request: RdfRequest) -> RdfResponse:
    """Compute the radial distribution function g(r) between two atom selections.

    Selections can be specified by explicit atom indices or by element symbol.
    Also returns the running coordination number (cumulative integral).
    Useful for analyzing liquid-solid interfaces and solvation shells.

    All distances are in Angstroms.
    """
    traj = load_trajectory(request.trajectory_b64, request.format)

    # Resolve selections to index arrays
    sel1 = _resolve_selection(request.selection_1, traj.topology, "selection_1")
    sel2 = _resolve_selection(request.selection_2, traj.topology, "selection_2")

    # Validate index ranges
    n_atoms = traj.n_atoms
    for label, arr in [("selection_1", sel1), ("selection_2", sel2)]:
        if np.any(arr < 0) or np.any(arr >= n_atoms):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{label} contains indices out of range. "
                    f"Trajectory has {n_atoms} atoms (0 to {n_atoms - 1})"
                ),
            )

    # Build pair list: all combinations of sel1 x sel2
    # md.compute_rdf expects pairs as (n_pairs, 2) array
    pairs = np.array(
        [(i, j) for i in sel1 for j in sel2 if i != j], dtype=np.int32
    )
    if len(pairs) == 0:
        raise HTTPException(
            status_code=400,
            detail=(
                "No valid pairs generated from the selections. "
                "Ensure the two selections have distinct atoms."
            ),
        )

    # Convert r_range from Angstroms to nanometers for mdtraj
    r_min_nm = request.r_range[0] * ANGSTROM_TO_NM
    r_max_nm = request.r_range[1] * ANGSTROM_TO_NM

    if r_min_nm >= r_max_nm:
        raise HTTPException(
            status_code=400,
            detail="r_range[0] must be less than r_range[1]",
        )

    periodic = resolve_periodic(traj, request.periodic)

    try:
        has_unitcell = (
            traj.unitcell_volumes is not None
            and np.all(traj.unitcell_volumes > 0)
        )

        if has_unitcell:
            # Use mdtraj's built-in RDF (normalizes by unitcell volume)
            r_nm, g_r = md.compute_rdf(
                traj,
                pairs=pairs,
                r_range=(r_min_nm, r_max_nm),
                n_bins=request.n_bins,
                periodic=periodic,
            )
        else:
            # Non-periodic system: mdtraj.compute_rdf crashes on unitcell_volumes=None.
            # Compute RDF manually using a bounding-box volume estimate.
            distances = md.compute_distances(traj, pairs, periodic=False)
            g_r_raw, edges = np.histogram(
                distances, range=(r_min_nm, r_max_nm), bins=request.n_bins
            )
            r_nm = 0.5 * (edges[1:] + edges[:-1])

            # Estimate volume from coordinate bounding box per frame
            bbox_volumes = []
            for fi in range(traj.n_frames):
                coords = traj.xyz[fi]  # (n_atoms, 3) in nm
                span = coords.max(axis=0) - coords.min(axis=0)
                span = np.maximum(span, 0.1)  # avoid zero volume
                bbox_volumes.append(span[0] * span[1] * span[2])
            avg_vol = np.mean(bbox_volumes)

            V_shell = (4.0 / 3.0) * np.pi * (
                np.power(edges[1:], 3) - np.power(edges[:-1], 3)
            )
            norm = len(pairs) * (traj.n_frames / avg_vol) * V_shell
            g_r = g_r_raw.astype(np.float64) / np.where(norm > 0, norm, 1.0)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"RDF computation failed: {exc}",
        )

    # Convert r from nm to Angstroms
    r_ang = (r_nm * NM_TO_ANGSTROM).tolist()
    g_r_list = g_r.tolist()

    # Compute running coordination number:
    # n(r) = 4*pi*rho * integral_0^r g(r') * r'^2 dr'
    # where rho = N_sel2 / V  (number density of the second selection)
    dr_nm = r_nm[1] - r_nm[0] if len(r_nm) > 1 else 0.0

    has_unitcell = (
        traj.unitcell_volumes is not None
        and np.all(traj.unitcell_volumes > 0)
    )
    if has_unitcell:
        avg_volume_nm3 = np.mean(traj.unitcell_volumes)
        rho = len(sel2) / avg_volume_nm3
        integrand = 4.0 * np.pi * rho * g_r * r_nm**2 * dr_nm
        coord_number = np.cumsum(integrand).tolist()
    else:
        # Without periodic box, use bounding-box estimate
        integrand = 4.0 * np.pi * g_r * r_nm**2 * dr_nm
        coord_number = np.cumsum(integrand).tolist()

    return RdfResponse(
        r=r_ang,
        g_r=g_r_list,
        coordination_number=coord_number,
        n_pairs=len(pairs),
    )

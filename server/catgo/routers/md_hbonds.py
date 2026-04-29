"""MD trajectory hydrogen bond analysis endpoints using mdtraj.

Provides detection, lifetime analysis, and spatial density computation of
hydrogen bonds in molecular dynamics trajectories. Designed for studying
water dynamics at electrochemical interfaces.
"""

import logging
from typing import Optional

import mdtraj as md
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .md_utils import load_trajectory, resolve_periodic

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/md/hbonds", tags=["md-hbonds"])


# ============================================================================
# Pydantic Request/Response Models
# ============================================================================


class HBondDetectRequest(BaseModel):
    """Request for hydrogen bond detection across a trajectory."""

    trajectory_b64: str = Field(
        description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        description="Trajectory file format (e.g. 'pdb', 'xyz', 'gro', 'xtc', 'trr', 'dcd')"
    )
    topology_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded topology file (required for binary formats like xtc, trr, dcd)"
    )
    topology_format: Optional[str] = Field(
        default=None,
        description="Topology file format (e.g. 'pdb', 'gro')"
    )
    method: str = Field(
        default="baker_hubbard",
        description="H-bond detection method: 'baker_hubbard' or 'wernet_nilsson'"
    )
    distance_cutoff: float = Field(
        default=3.5,
        description="H...Acceptor distance cutoff in Angstroms (converted to nm for mdtraj)"
    )
    angle_cutoff: float = Field(
        default=150.0,
        description="Donor-H...Acceptor angle cutoff in degrees"
    )
    freq: float = Field(
        default=0.1,
        description="Frequency cutoff for baker_hubbard: return H-bonds present in at least this fraction of frames"
    )
    exclude_water: bool = Field(
        default=False,
        description="Whether to exclude water-water H-bonds (False to include all, important for interface studies)"
    )
    donor_indices: Optional[list[int]] = Field(
        default=None,
        description="Optional list of donor atom indices to restrict detection to"
    )
    acceptor_indices: Optional[list[int]] = Field(
        default=None,
        description="Optional list of acceptor atom indices to restrict detection to"
    )
    periodic: bool = Field(
        default=True,
        description="Whether to account for periodic boundary conditions"
    )


class HBondTriplet(BaseModel):
    """A single hydrogen bond defined by donor, hydrogen, and acceptor atom indices."""

    donor_idx: int
    hydrogen_idx: int
    acceptor_idx: int


class HBondDetectResponse(BaseModel):
    """Response from hydrogen bond detection."""

    hbonds_per_frame: list[list[HBondTriplet]] = Field(
        description="Per-frame list of H-bond triplets (donor, hydrogen, acceptor)"
    )
    count_per_frame: list[int] = Field(
        description="Number of H-bonds detected in each frame"
    )
    unique_hbonds: list[HBondTriplet] = Field(
        description="Unique H-bond triplets observed across the entire trajectory"
    )
    n_unique: int = Field(
        description="Total number of unique H-bond triplets"
    )
    n_frames: int = Field(
        description="Number of frames analyzed"
    )
    method: str = Field(
        description="Detection method used"
    )


class HBondLifetimeRequest(BaseModel):
    """Request for hydrogen bond lifetime analysis."""

    trajectory_b64: str = Field(
        description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        description="Trajectory file format"
    )
    topology_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded topology file (required for binary formats)"
    )
    topology_format: Optional[str] = Field(
        default=None,
        description="Topology file format"
    )
    distance_cutoff: float = Field(
        default=3.5,
        description="H...Acceptor distance cutoff in Angstroms"
    )
    angle_cutoff: float = Field(
        default=150.0,
        description="Donor-H...Acceptor angle cutoff in degrees"
    )
    exclude_water: bool = Field(
        default=False,
        description="Whether to exclude water-water H-bonds"
    )
    periodic: bool = Field(
        default=True,
        description="Whether to account for periodic boundary conditions"
    )
    donor_acceptor_pairs: Optional[list[list[int]]] = Field(
        default=None,
        description="Optional specific donor-acceptor pairs as [[donor_idx, acceptor_idx], ...] to track"
    )
    time_step: float = Field(
        default=1.0,
        description="Time between frames in picoseconds, used to convert frame indices to time"
    )
    max_lag_fraction: float = Field(
        default=0.5,
        description="Maximum lag as a fraction of total trajectory length for autocorrelation"
    )


class HBondLifetimeResponse(BaseModel):
    """Response from hydrogen bond lifetime analysis."""

    autocorrelation: list[float] = Field(
        description="Normalized autocorrelation function C(t) of H-bond existence"
    )
    time_ps: list[float] = Field(
        description="Time values in picoseconds corresponding to autocorrelation"
    )
    average_lifetime_ps: float = Field(
        description="Estimated average H-bond lifetime in picoseconds (from integral of C(t))"
    )
    n_hbonds_sampled: int = Field(
        description="Number of unique H-bond pairs used in the autocorrelation"
    )
    n_frames: int = Field(
        description="Number of frames in the trajectory"
    )


class HBondDensityRequest(BaseModel):
    """Request for hydrogen bond density in a spatial region."""

    trajectory_b64: str = Field(
        description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        description="Trajectory file format"
    )
    topology_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded topology file (required for binary formats)"
    )
    topology_format: Optional[str] = Field(
        default=None,
        description="Topology file format"
    )
    z_range: list[float] = Field(
        description="[z_min, z_max] in Angstroms defining the region of interest along z-axis"
    )
    distance_cutoff: float = Field(
        default=3.5,
        description="H...Acceptor distance cutoff in Angstroms"
    )
    angle_cutoff: float = Field(
        default=150.0,
        description="Donor-H...Acceptor angle cutoff in degrees"
    )
    exclude_water: bool = Field(
        default=False,
        description="Whether to exclude water-water H-bonds"
    )
    periodic: bool = Field(
        default=True,
        description="Whether to account for periodic boundary conditions"
    )


class HBondDensityResponse(BaseModel):
    """Response from hydrogen bond density analysis."""

    h_bond_count_per_frame: list[int] = Field(
        description="Number of H-bonds within the z-range for each frame"
    )
    average_density: float = Field(
        description="Average H-bond density in H-bonds per cubic Angstrom"
    )
    z_range: list[float] = Field(
        description="The [z_min, z_max] range used (Angstroms)"
    )
    n_frames: int = Field(
        description="Number of frames analyzed"
    )
    average_count: float = Field(
        description="Average number of H-bonds per frame in the region"
    )
    region_volume_ang3: float = Field(
        description="Volume of the selected region in cubic Angstroms"
    )


# ============================================================================
# Helper Functions
# ============================================================================


def compute_hbonds_per_frame(
    traj: md.Trajectory,
    distance_cutoff_nm: float,
    angle_cutoff_deg: float,
    exclude_water: bool,
    periodic: bool,
) -> list[np.ndarray]:
    """Detect hydrogen bonds on a per-frame basis using wernet_nilsson.

    wernet_nilsson returns per-frame results, unlike baker_hubbard which
    aggregates across all frames. For per-frame analysis, we use
    wernet_nilsson on individual frame slices and then apply a distance
    and angle filter.

    Args:
        traj: The mdtraj Trajectory.
        distance_cutoff_nm: H...Acceptor distance cutoff in nanometers.
        angle_cutoff_deg: Donor-H...Acceptor angle cutoff in degrees.
        exclude_water: Whether to exclude water-water H-bonds.
        periodic: Whether to use periodic boundary conditions.

    Returns:
        A list of numpy arrays, one per frame, each of shape (n_hbonds, 3)
        containing [donor_idx, hydrogen_idx, acceptor_idx] triplets.
    """
    per_frame_hbonds = []

    for frame_idx in range(traj.n_frames):
        frame = traj[frame_idx]
        # wernet_nilsson returns a list (one element per frame) of arrays
        frame_results = md.wernet_nilsson(
            frame,
            exclude_water=exclude_water,
            periodic=periodic,
        )
        # frame_results is a list with one element (since single frame)
        hbonds = frame_results[0] if len(frame_results) > 0 else np.empty((0, 3), dtype=int)

        if len(hbonds) == 0:
            per_frame_hbonds.append(np.empty((0, 3), dtype=int))
            continue

        # Apply custom distance cutoff filter
        # Compute D-A distances for filtering
        da_pairs = hbonds[:, [0, 2]]  # donor, acceptor
        da_distances = md.compute_distances(frame, da_pairs, periodic=periodic)[0]

        # Compute D-H-A angles for filtering
        angle_indices = hbonds[:, [0, 1, 2]]  # donor, hydrogen, acceptor
        angles_rad = md.compute_angles(frame, angle_indices, periodic=periodic)[0]
        angles_deg = np.degrees(angles_rad)

        # Filter by both distance (H-A) and angle (D-H-A)
        # Also compute H-A distances for the distance cutoff
        ha_pairs = hbonds[:, [1, 2]]  # hydrogen, acceptor
        ha_distances = md.compute_distances(frame, ha_pairs, periodic=periodic)[0]

        mask = (ha_distances <= distance_cutoff_nm) & (angles_deg >= angle_cutoff_deg)
        filtered = hbonds[mask]
        per_frame_hbonds.append(filtered)

    return per_frame_hbonds


def compute_autocorrelation(binary_matrix: np.ndarray, max_lag: int) -> np.ndarray:
    """Compute the normalized autocorrelation function of a binary existence matrix.

    For each H-bond pair (row in binary_matrix), computes:
        C(tau) = <h(t) * h(t+tau)> / <h(t)>

    where h(t) = 1 if the H-bond exists at frame t, 0 otherwise. The result
    is averaged over all H-bond pairs.

    This is the "intermittent" hydrogen bond correlation function, which counts
    all re-formations of the bond.

    Args:
        binary_matrix: Shape (n_hbonds, n_frames), values are 0 or 1.
        max_lag: Maximum lag in frames.

    Returns:
        Normalized autocorrelation array of length max_lag + 1.
    """
    n_bonds, n_frames = binary_matrix.shape
    if n_bonds == 0 or n_frames == 0:
        return np.ones(max_lag + 1)

    acf = np.zeros(max_lag + 1)
    norm = np.zeros(max_lag + 1)

    for tau in range(max_lag + 1):
        # For each lag, compute h(t)*h(t+tau) averaged over t and bonds
        valid_frames = n_frames - tau
        if valid_frames <= 0:
            break
        product = binary_matrix[:, :valid_frames] * binary_matrix[:, tau:tau + valid_frames]
        acf[tau] = product.sum()
        norm[tau] = binary_matrix[:, :valid_frames].sum()

    # Normalize: C(tau) = sum(h(t)*h(t+tau)) / sum(h(t))
    # Avoid division by zero
    with np.errstate(divide="ignore", invalid="ignore"):
        acf = np.where(norm > 0, acf / norm, 0.0)

    # Ensure C(0) = 1.0 (if there are any bonds at all)
    if acf[0] > 0:
        acf = acf / acf[0]

    return acf


# ============================================================================
# API Endpoints
# ============================================================================


@router.post("/detect", response_model=HBondDetectResponse)
def detect_hbonds(request: HBondDetectRequest) -> HBondDetectResponse:
    """Detect hydrogen bonds across all frames of an MD trajectory.

    Supports two detection methods:
    - **baker_hubbard**: Returns H-bonds that persist across a minimum fraction
      of frames (controlled by `freq`). Good for finding stable/persistent bonds.
    - **wernet_nilsson**: Returns per-frame H-bond lists using a distance-based
      criterion. Good for capturing all transient bonds.

    Both methods identify (donor, hydrogen, acceptor) triplets. Custom distance
    and angle cutoffs are applied as filters.

    Use case: Identifying water-surface hydrogen bonds at electrochemical interfaces.
    """
    traj = load_trajectory(
        request.trajectory_b64,
        request.format,
        request.topology_b64,
        request.topology_format,
    )

    n_frames = traj.n_frames
    distance_cutoff_nm = request.distance_cutoff / 10.0  # Angstroms -> nm

    if request.method == "baker_hubbard":
        # baker_hubbard returns aggregate H-bonds across trajectory
        # Note: baker_hubbard's distance_cutoff is the H...A distance in nm
        # and angle_cutoff is the minimum D-H...A angle in degrees
        all_hbonds = md.baker_hubbard(
            traj,
            freq=request.freq,
            exclude_water=request.exclude_water,
            periodic=resolve_periodic(traj, request.periodic),
            distance_cutoff=distance_cutoff_nm,
            angle_cutoff=request.angle_cutoff,
        )

        # Filter by donor/acceptor indices if specified
        if request.donor_indices is not None and len(all_hbonds) > 0:
            donor_set = set(request.donor_indices)
            mask = np.array([h[0] in donor_set for h in all_hbonds])
            all_hbonds = all_hbonds[mask]

        if request.acceptor_indices is not None and len(all_hbonds) > 0:
            acceptor_set = set(request.acceptor_indices)
            mask = np.array([h[2] in acceptor_set for h in all_hbonds])
            all_hbonds = all_hbonds[mask]

        # For baker_hubbard, we need to compute per-frame presence
        # Check each identified H-bond in each frame by distance + angle
        hbonds_per_frame: list[list[HBondTriplet]] = []
        count_per_frame: list[int] = []

        if len(all_hbonds) > 0:
            # Compute H-A distances and D-H-A angles across all frames
            ha_pairs = all_hbonds[:, [1, 2]]
            ha_distances = md.compute_distances(traj, ha_pairs, periodic=resolve_periodic(traj, request.periodic))
            # ha_distances shape: (n_frames, n_hbonds)

            angle_triples = all_hbonds[:, [0, 1, 2]]
            angles_rad = md.compute_angles(traj, angle_triples, periodic=resolve_periodic(traj, request.periodic))
            angles_deg = np.degrees(angles_rad)
            # angles_deg shape: (n_frames, n_hbonds)

            for frame_idx in range(n_frames):
                frame_mask = (
                    (ha_distances[frame_idx] <= distance_cutoff_nm)
                    & (angles_deg[frame_idx] >= request.angle_cutoff)
                )
                frame_hbonds = all_hbonds[frame_mask]
                triplets = [
                    HBondTriplet(
                        donor_idx=int(h[0]),
                        hydrogen_idx=int(h[1]),
                        acceptor_idx=int(h[2]),
                    )
                    for h in frame_hbonds
                ]
                hbonds_per_frame.append(triplets)
                count_per_frame.append(len(triplets))
        else:
            hbonds_per_frame = [[] for _ in range(n_frames)]
            count_per_frame = [0] * n_frames

        # Unique H-bonds across trajectory
        unique_set: set[tuple[int, int, int]] = set()
        for frame_triplets in hbonds_per_frame:
            for t in frame_triplets:
                unique_set.add((t.donor_idx, t.hydrogen_idx, t.acceptor_idx))

        unique_hbonds = [
            HBondTriplet(donor_idx=d, hydrogen_idx=h, acceptor_idx=a)
            for d, h, a in sorted(unique_set)
        ]

    elif request.method == "wernet_nilsson":
        # wernet_nilsson returns per-frame H-bond lists natively
        per_frame_arrays = compute_hbonds_per_frame(
            traj,
            distance_cutoff_nm=distance_cutoff_nm,
            angle_cutoff_deg=request.angle_cutoff,
            exclude_water=request.exclude_water,
            periodic=resolve_periodic(traj, request.periodic),
        )

        hbonds_per_frame = []
        count_per_frame = []
        unique_set = set()

        for frame_hbonds in per_frame_arrays:
            # Filter by donor/acceptor indices if specified
            if len(frame_hbonds) > 0 and request.donor_indices is not None:
                donor_set = set(request.donor_indices)
                mask = np.array([h[0] in donor_set for h in frame_hbonds])
                frame_hbonds = frame_hbonds[mask]

            if len(frame_hbonds) > 0 and request.acceptor_indices is not None:
                acceptor_set = set(request.acceptor_indices)
                mask = np.array([h[2] in acceptor_set for h in frame_hbonds])
                frame_hbonds = frame_hbonds[mask]

            triplets = [
                HBondTriplet(
                    donor_idx=int(h[0]),
                    hydrogen_idx=int(h[1]),
                    acceptor_idx=int(h[2]),
                )
                for h in frame_hbonds
            ]
            hbonds_per_frame.append(triplets)
            count_per_frame.append(len(triplets))

            for t in triplets:
                unique_set.add((t.donor_idx, t.hydrogen_idx, t.acceptor_idx))

        unique_hbonds = [
            HBondTriplet(donor_idx=d, hydrogen_idx=h, acceptor_idx=a)
            for d, h, a in sorted(unique_set)
        ]
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown method '{request.method}'. Use 'baker_hubbard' or 'wernet_nilsson'."
        )

    return HBondDetectResponse(
        hbonds_per_frame=hbonds_per_frame,
        count_per_frame=count_per_frame,
        unique_hbonds=unique_hbonds,
        n_unique=len(unique_hbonds),
        n_frames=n_frames,
        method=request.method,
    )


@router.post("/lifetime", response_model=HBondLifetimeResponse)
def hbond_lifetime(request: HBondLifetimeRequest) -> HBondLifetimeResponse:
    """Compute hydrogen bond lifetime via autocorrelation analysis.

    The lifetime is estimated from the intermittent hydrogen bond correlation
    function C(t), which measures the probability that an H-bond existing at
    time 0 also exists at time t (allowing breaking and re-formation in between).

    The average lifetime is estimated as the integral of C(t) using the
    trapezoidal rule. Shorter lifetimes indicate more dynamic hydrogen bonding
    (e.g., water at charged interfaces).

    Steps:
    1. Detect H-bonds in every frame using wernet_nilsson with distance/angle cutoffs.
    2. Build a binary existence matrix (n_unique_hbonds x n_frames).
    3. Compute the autocorrelation function C(tau) averaged over all H-bond pairs.
    4. Integrate C(t) to estimate the average lifetime.

    Use case: Understanding water dynamics at interfaces -- shorter lifetime
    indicates more dynamic hydrogen bonding.
    """
    traj = load_trajectory(
        request.trajectory_b64,
        request.format,
        request.topology_b64,
        request.topology_format,
    )

    n_frames = traj.n_frames
    if n_frames < 2:
        raise HTTPException(
            status_code=400,
            detail="Trajectory must have at least 2 frames for lifetime analysis."
        )

    distance_cutoff_nm = request.distance_cutoff / 10.0  # Angstroms -> nm

    # Step 1: Detect H-bonds per frame
    per_frame_arrays = compute_hbonds_per_frame(
        traj,
        distance_cutoff_nm=distance_cutoff_nm,
        angle_cutoff_deg=request.angle_cutoff,
        exclude_water=request.exclude_water,
        periodic=resolve_periodic(traj, request.periodic),
    )

    # Step 2: Identify unique H-bond pairs and build binary matrix
    # Use (donor, hydrogen, acceptor) as the unique key
    unique_bonds: dict[tuple[int, int, int], int] = {}

    for frame_hbonds in per_frame_arrays:
        for h in frame_hbonds:
            key = (int(h[0]), int(h[1]), int(h[2]))
            if key not in unique_bonds:
                unique_bonds[key] = len(unique_bonds)

    # If specific donor-acceptor pairs are requested, filter
    if request.donor_acceptor_pairs is not None:
        requested_da = {(pair[0], pair[1]) for pair in request.donor_acceptor_pairs}
        filtered_bonds = {
            key: idx for key, idx in unique_bonds.items()
            if (key[0], key[2]) in requested_da
        }
        # Re-index
        unique_bonds = {key: i for i, (key, _) in enumerate(filtered_bonds.items())}

    n_unique = len(unique_bonds)

    if n_unique == 0:
        # No H-bonds found; return flat autocorrelation
        max_lag = int(n_frames * request.max_lag_fraction)
        time_values = [i * request.time_step for i in range(max_lag + 1)]
        return HBondLifetimeResponse(
            autocorrelation=[1.0] + [0.0] * max_lag,
            time_ps=time_values,
            average_lifetime_ps=0.0,
            n_hbonds_sampled=0,
            n_frames=n_frames,
        )

    # Build binary existence matrix
    binary_matrix = np.zeros((n_unique, n_frames), dtype=np.float64)
    for frame_idx, frame_hbonds in enumerate(per_frame_arrays):
        for h in frame_hbonds:
            key = (int(h[0]), int(h[1]), int(h[2]))
            if key in unique_bonds:
                binary_matrix[unique_bonds[key], frame_idx] = 1.0

    # Step 3: Compute autocorrelation
    max_lag = max(1, int(n_frames * request.max_lag_fraction))
    max_lag = min(max_lag, n_frames - 1)

    acf = compute_autocorrelation(binary_matrix, max_lag)

    # Step 4: Estimate lifetime by integrating C(t)
    time_values = np.arange(max_lag + 1) * request.time_step
    # Trapezoidal integration of C(t) to get lifetime
    average_lifetime_ps = float(np.trapz(acf, time_values))

    return HBondLifetimeResponse(
        autocorrelation=acf.tolist(),
        time_ps=time_values.tolist(),
        average_lifetime_ps=average_lifetime_ps,
        n_hbonds_sampled=n_unique,
        n_frames=n_frames,
    )


@router.post("/density", response_model=HBondDensityResponse)
def hbond_density(request: HBondDensityRequest) -> HBondDensityResponse:
    """Compute hydrogen bond density within a specified z-range slab.

    Selects hydrogen bonds where BOTH the donor and acceptor atoms fall within
    the specified z-range, then normalizes by the slab volume to obtain a
    spatial density.

    This is useful for comparing the H-bond network structure in different
    water layers above a surface, e.g., distinguishing the strongly-bound
    first water layer from bulk-like water further from the surface.

    Steps:
    1. Detect H-bonds in every frame.
    2. For each frame, filter to H-bonds where both donor and acceptor are
       within [z_min, z_max].
    3. Compute region volume from unit cell xy-area and z-range thickness.
    4. Report per-frame counts and average density.

    Use case: Comparing H-bond network density in different water layers above
    an electrode surface.
    """
    if len(request.z_range) != 2:
        raise HTTPException(
            status_code=400,
            detail="z_range must be a list of exactly 2 values: [z_min, z_max] in Angstroms."
        )

    z_min_ang, z_max_ang = sorted(request.z_range)
    if z_min_ang >= z_max_ang:
        raise HTTPException(
            status_code=400,
            detail="z_range values must define a non-zero range: z_min < z_max."
        )

    # Convert z-range to nanometers for mdtraj coordinate comparison
    z_min_nm = z_min_ang / 10.0
    z_max_nm = z_max_ang / 10.0

    traj = load_trajectory(
        request.trajectory_b64,
        request.format,
        request.topology_b64,
        request.topology_format,
    )

    n_frames = traj.n_frames
    distance_cutoff_nm = request.distance_cutoff / 10.0

    # Compute region volume in Angstroms^3
    # Use the unit cell vectors' xy-plane area (from the first frame)
    # mdtraj stores unitcell_vectors in nm; convert to Angstroms for output
    if traj.unitcell_vectors is not None:
        # Average unit cell across frames (handles NPT fluctuations)
        avg_cell_nm = np.mean(traj.unitcell_vectors, axis=0)  # shape (3, 3), in nm
        avg_cell_ang = avg_cell_nm * 10.0  # convert to Angstroms
        a = avg_cell_ang[0]
        b = avg_cell_ang[1]
        # xy-plane area = |a x b| (z-component of cross product)
        xy_area_ang2 = abs(np.cross(a[:2], b[:2]))
    else:
        # No unit cell info -- estimate from coordinate range
        positions_ang = traj.xyz * 10.0  # nm -> Angstroms
        x_range = positions_ang[:, :, 0].max() - positions_ang[:, :, 0].min()
        y_range = positions_ang[:, :, 1].max() - positions_ang[:, :, 1].min()
        xy_area_ang2 = x_range * y_range

    z_thickness_ang = z_max_ang - z_min_ang
    region_volume_ang3 = float(xy_area_ang2 * z_thickness_ang)

    if region_volume_ang3 <= 0:
        raise HTTPException(
            status_code=400,
            detail="Computed region volume is zero or negative. Check z_range and unit cell."
        )

    # Detect H-bonds per frame
    per_frame_arrays = compute_hbonds_per_frame(
        traj,
        distance_cutoff_nm=distance_cutoff_nm,
        angle_cutoff_deg=request.angle_cutoff,
        exclude_water=request.exclude_water,
        periodic=resolve_periodic(traj, request.periodic),
    )

    # Filter H-bonds by z-range: both donor and acceptor must be in [z_min, z_max]
    h_bond_count_per_frame: list[int] = []

    for frame_idx, frame_hbonds in enumerate(per_frame_arrays):
        if len(frame_hbonds) == 0:
            h_bond_count_per_frame.append(0)
            continue

        # mdtraj coordinates are in nm
        positions = traj.xyz[frame_idx]  # shape (n_atoms, 3), in nm

        donor_z = positions[frame_hbonds[:, 0], 2]
        acceptor_z = positions[frame_hbonds[:, 2], 2]

        # Both donor and acceptor z must be within range (in nm)
        in_range = (
            (donor_z >= z_min_nm) & (donor_z <= z_max_nm)
            & (acceptor_z >= z_min_nm) & (acceptor_z <= z_max_nm)
        )
        h_bond_count_per_frame.append(int(in_range.sum()))

    average_count = float(np.mean(h_bond_count_per_frame))
    average_density = average_count / region_volume_ang3

    return HBondDensityResponse(
        h_bond_count_per_frame=h_bond_count_per_frame,
        average_density=average_density,
        z_range=[z_min_ang, z_max_ang],
        n_frames=n_frames,
        average_count=average_count,
        region_volume_ang3=region_volume_ang3,
    )

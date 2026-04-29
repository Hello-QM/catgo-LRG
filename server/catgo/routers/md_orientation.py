"""MD water orientation order parameter <cos phi>(z).

For each water molecule (an O atom with at least 2 H neighbours), the dipole
vector is defined as the bisector of the H-O-H angle pointing from O towards
the midpoint of the two hydrogens. phi is the angle between this dipole and
the user-selected surface normal (default z axis). The response is the per-z
profile of <cos phi> (P1) and optionally the second Legendre polynomial
<P2(cos phi)> = <(3 cos^2 phi - 1)/2>, binned by the O-atom coordinate along
the normal axis.
"""

import logging
from typing import Literal, Optional

import mdtraj as md
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .md_utils import load_trajectory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/md/orientation", tags=["md-orientation"])


# ============================================================================
# Models
# ============================================================================


class WaterOrientationRequest(BaseModel):
    trajectory_b64: str = Field(description="Base64-encoded trajectory file content")
    format: str = Field(description="Trajectory format extension")
    topology_b64: Optional[str] = Field(default=None)
    topology_format: Optional[str] = Field(default=None)
    axis: Literal["x", "y", "z"] = Field(
        default="z",
        description="Surface normal direction along which to bin and reference phi.",
    )
    n_bins: int = Field(default=100, ge=1, le=5000)
    z_range: Optional[list[float]] = Field(
        default=None,
        description="[z_min, z_max] in Angstroms. Defaults to the full cell extent.",
    )
    frame_range: Optional[list[int]] = Field(
        default=None,
        description="[start, end] frame range (inclusive/exclusive like a slice).",
    )
    oh_cutoff_angstrom: float = Field(
        default=1.25,
        gt=0.0,
        description="Maximum O-H distance to count an H as belonging to a water molecule.",
    )
    periodic: bool = Field(
        default=True,
        description="Use PBC minimum-image distances when searching for H atoms near each O.",
    )
    compute_p2: bool = Field(
        default=True,
        description="Also return <P2(cos phi)> per bin along with <cos phi>.",
    )


class WaterOrientationResponse(BaseModel):
    axis: str
    bin_centers_angstrom: list[float]
    cos_phi_mean: list[float] = Field(description="<cos phi>(z) per bin; NaN if empty")
    p2_cos_phi_mean: Optional[list[float]] = Field(
        default=None,
        description="<(3 cos^2 phi - 1)/2>(z) per bin; None if compute_p2=False",
    )
    counts: list[int] = Field(description="Number of water molecules sampled per bin")
    n_frames_used: int
    n_waters_mean: float = Field(
        description="Average number of water molecules identified per frame."
    )


# ============================================================================
# Helpers
# ============================================================================

_AXIS_INDEX = {"x": 0, "y": 1, "z": 2}


def _identify_waters(
    traj: md.Trajectory, oh_cutoff_ang: float, periodic: bool
) -> tuple[np.ndarray, np.ndarray]:
    """Return (oxygen_idx, hydrogen_pairs) using first-frame geometry.

    hydrogen_pairs has shape (n_waters, 2); if an oxygen only has a single H
    within the cutoff, it is skipped. The detection uses the first frame and
    the assignment is reused across frames (standard assumption — no proton
    hopping in classical MD; for reactive AIMD this is an approximation).
    """
    o_indices = np.array(
        [a.index for a in traj.topology.atoms if a.element and a.element.symbol == "O"],
        dtype=np.int64,
    )
    h_indices = np.array(
        [a.index for a in traj.topology.atoms if a.element and a.element.symbol == "H"],
        dtype=np.int64,
    )
    if o_indices.size == 0 or h_indices.size == 0:
        raise HTTPException(
            status_code=400,
            detail="Trajectory contains no O or H atoms — cannot identify water molecules.",
        )

    # distances in nm using mdtraj; pair array (len(o)*len(h), 2)
    pairs = np.array(
        [[o, h] for o in o_indices for h in h_indices], dtype=np.int32
    )
    use_periodic = periodic and traj.unitcell_vectors is not None
    dists_nm = md.compute_distances(traj[0], pairs, periodic=use_periodic)[0]
    dists_ang = dists_nm * 10.0
    cutoff_mask = dists_ang <= oh_cutoff_ang
    dists_ang = dists_ang.reshape(o_indices.size, h_indices.size)
    cutoff_mask = cutoff_mask.reshape(o_indices.size, h_indices.size)

    waters_o: list[int] = []
    waters_h: list[list[int]] = []
    for i, o in enumerate(o_indices):
        h_candidates = np.where(cutoff_mask[i])[0]
        if h_candidates.size >= 2:
            order = np.argsort(dists_ang[i, h_candidates])
            chosen = h_candidates[order[:2]]
            waters_o.append(int(o))
            waters_h.append([int(h_indices[chosen[0]]), int(h_indices[chosen[1]])])
    if not waters_o:
        raise HTTPException(
            status_code=400,
            detail=(
                f"No water molecules detected (no O atom has 2 H neighbours within "
                f"{oh_cutoff_ang} A). Check oh_cutoff_angstrom or topology."
            ),
        )
    return np.asarray(waters_o, dtype=np.int64), np.asarray(waters_h, dtype=np.int64)


def _min_image_vector(
    delta: np.ndarray, box_nm: Optional[np.ndarray]
) -> np.ndarray:
    """Minimum-image correction for an (..., 3) displacement, orthorhombic only."""
    if box_nm is None:
        return delta
    return delta - np.round(delta / box_nm) * box_nm


# ============================================================================
# Endpoint
# ============================================================================


@router.post("/water", response_model=WaterOrientationResponse)
def compute_water_orientation(request: WaterOrientationRequest) -> WaterOrientationResponse:
    """Compute <cos phi>(z) for the water dipole relative to a surface normal.

    phi is measured between the H-O-H bisector dipole and the normal axis.
    Positive <cos phi> means water dipoles point *towards* +axis; negative
    means they point towards -axis (H-down / O-up configurations flip signs).
    """
    traj = load_trajectory(
        request.trajectory_b64,
        request.format,
        request.topology_b64,
        request.topology_format,
    )
    if traj.n_frames < 1:
        raise HTTPException(status_code=400, detail="Empty trajectory")

    # slice frames if requested
    if request.frame_range is not None:
        if len(request.frame_range) != 2:
            raise HTTPException(status_code=400, detail="frame_range must be [start, end]")
        start, end = request.frame_range
        traj = traj[start:end]
        if traj.n_frames == 0:
            raise HTTPException(status_code=400, detail="frame_range yields zero frames.")

    waters_o, waters_h = _identify_waters(
        traj, request.oh_cutoff_angstrom, request.periodic
    )
    logger.info("Identified %d water molecules", waters_o.size)

    axis_idx = _AXIS_INDEX[request.axis]

    # Normal vector in the lab frame (simple unit axis).
    normal = np.zeros(3, dtype=np.float64)
    normal[axis_idx] = 1.0

    # Determine z range
    coords_ang_all = traj.xyz * 10.0  # (n_frames, n_atoms, 3)
    o_coords = coords_ang_all[:, waters_o, :]  # (n_frames, n_w, 3)
    z_all = o_coords[..., axis_idx]
    if request.z_range is not None:
        if len(request.z_range) != 2:
            raise HTTPException(status_code=400, detail="z_range must be [z_min, z_max]")
        z_min, z_max = sorted(request.z_range)
    else:
        z_min = float(np.min(z_all))
        z_max = float(np.max(z_all))
    if z_max <= z_min:
        raise HTTPException(status_code=400, detail="Invalid z_range (max <= min)")

    bin_edges = np.linspace(z_min, z_max, request.n_bins + 1)
    bin_centers = 0.5 * (bin_edges[:-1] + bin_edges[1:])

    cos_sum = np.zeros(request.n_bins, dtype=np.float64)
    p2_sum = np.zeros(request.n_bins, dtype=np.float64)
    counts = np.zeros(request.n_bins, dtype=np.int64)

    # Pre-extract H coords for both H of each water
    h_coords_1 = coords_ang_all[:, waters_h[:, 0], :]
    h_coords_2 = coords_ang_all[:, waters_h[:, 1], :]
    box_nm_all = traj.unitcell_lengths  # (n_frames, 3)

    n_waters_total = 0
    for t in range(traj.n_frames):
        o_xyz = o_coords[t]
        h1 = h_coords_1[t]
        h2 = h_coords_2[t]
        box_nm = box_nm_all[t] if box_nm_all is not None else None
        box_ang = box_nm * 10.0 if box_nm is not None else None

        d1 = _min_image_vector(h1 - o_xyz, box_ang)
        d2 = _min_image_vector(h2 - o_xyz, box_ang)
        dipole = d1 + d2  # H-O-H bisector, points from O to H midpoint*2
        norm = np.linalg.norm(dipole, axis=1)
        good = norm > 1e-8
        if not good.any():
            continue
        unit = dipole[good] / norm[good, None]
        cos_phi = unit @ normal  # (n_w_valid,)
        z_vals = o_xyz[good, axis_idx]

        idx = np.digitize(z_vals, bin_edges) - 1
        valid = (idx >= 0) & (idx < request.n_bins)
        idx = idx[valid]
        cos_phi = cos_phi[valid]
        np.add.at(cos_sum, idx, cos_phi)
        if request.compute_p2:
            np.add.at(p2_sum, idx, 0.5 * (3.0 * cos_phi * cos_phi - 1.0))
        np.add.at(counts, idx, 1)
        n_waters_total += int(good.sum())

    with np.errstate(invalid="ignore", divide="ignore"):
        cos_mean = np.where(counts > 0, cos_sum / counts, np.nan)
        p2_mean = np.where(counts > 0, p2_sum / counts, np.nan) if request.compute_p2 else None

    return WaterOrientationResponse(
        axis=request.axis,
        bin_centers_angstrom=bin_centers.tolist(),
        cos_phi_mean=[float(x) for x in cos_mean],
        p2_cos_phi_mean=([float(x) for x in p2_mean] if p2_mean is not None else None),
        counts=[int(c) for c in counts],
        n_frames_used=int(traj.n_frames),
        n_waters_mean=float(n_waters_total) / max(traj.n_frames, 1),
    )


@router.get("/health")
def md_orientation_health() -> dict:
    return {"status": "ok", "module": "md_orientation"}

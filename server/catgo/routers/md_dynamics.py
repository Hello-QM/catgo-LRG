"""MD trajectory dynamics endpoints — MSD, diffusion coefficient, VACF.

Implements the mean squared displacement and related transport descriptors
described in the paper companion. The batch MSD follows

    MSD(tau) = (1/N) * sum_i < |r_i(t+tau) - r_i(t)|^2 >_t

with multiple time origins for statistical averaging. The Einstein relation
MSD = 2 * d * D * tau is used to extract the self-diffusion coefficient D by
linear least-squares in a user-selected [tau_min, tau_max] window.
"""

import logging
from typing import Literal, Optional

import mdtraj as md
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .md_utils import load_trajectory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/md/dynamics", tags=["md-dynamics"])


# ============================================================================
# Pydantic Models
# ============================================================================


class MSDRequest(BaseModel):
    """Request for mean squared displacement over a trajectory."""

    trajectory_b64: str = Field(description="Base64-encoded trajectory file content")
    format: str = Field(
        description="Trajectory format (e.g., 'pdb', 'xyz', 'xtc', 'trr', 'dcd', 'lammpstrj')"
    )
    topology_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded topology (required for binary formats like xtc/trr/dcd)",
    )
    topology_format: Optional[str] = Field(default=None)
    atom_indices: Optional[list[int]] = Field(
        default=None,
        description="Atom subset (0-indexed). If omitted all atoms are used.",
    )
    element: Optional[str] = Field(
        default=None,
        description=(
            "Element symbol to select (e.g., 'O' for water oxygens). "
            "Takes precedence over atom_indices if set."
        ),
    )
    timestep_ps: float = Field(
        default=1.0,
        gt=0.0,
        description="Time between consecutive frames in picoseconds (used for time axis and D units).",
    )
    max_tau_frames: Optional[int] = Field(
        default=None,
        ge=1,
        description="Maximum lag tau (in frames). Defaults to n_frames // 2.",
    )
    directions: Literal["xyz", "xy", "z", "x", "y"] = Field(
        default="xyz",
        description=(
            "Which Cartesian directions contribute: 'xyz' isotropic 3D, 'xy' in-plane 2D, "
            "or a single Cartesian component."
        ),
    )
    unwrap_pbc: bool = Field(
        default=True,
        description=(
            "Unwrap periodic-boundary jumps before computing MSD (required for meaningful "
            "diffusion coefficients in periodic systems)."
        ),
    )
    fit_range_ps: Optional[list[float]] = Field(
        default=None,
        description=(
            "[tau_min, tau_max] in picoseconds over which to linearly fit MSD(tau) = slope*tau+c "
            "for the diffusion coefficient. Defaults to the inner 20%-80% window."
        ),
    )


class MSDResponse(BaseModel):
    tau_ps: list[float] = Field(description="Lag times in picoseconds")
    msd_angstrom2: list[float] = Field(description="MSD(tau) in Angstroms^2")
    n_atoms_used: int
    n_frames: int
    directions: str
    dimensionality: int = Field(description="Number of spatial directions used (d in MSD=2dDτ)")
    diffusion_coefficient_cm2_s: Optional[float] = Field(
        default=None,
        description="Self-diffusion coefficient D in cm^2/s from Einstein fit (None if fit failed).",
    )
    diffusion_coefficient_ang2_ps: Optional[float] = Field(
        default=None,
        description="D in Angstrom^2/ps (same value, alternative units)",
    )
    fit_slope_ang2_per_ps: Optional[float] = None
    fit_intercept_ang2: Optional[float] = None
    fit_r_squared: Optional[float] = None
    fit_tau_range_ps: Optional[list[float]] = None


class VACFRequest(BaseModel):
    trajectory_b64: str = Field(description="Base64-encoded trajectory file content")
    format: str
    topology_b64: Optional[str] = None
    topology_format: Optional[str] = None
    atom_indices: Optional[list[int]] = None
    element: Optional[str] = None
    timestep_ps: float = Field(default=1.0, gt=0.0)
    max_tau_frames: Optional[int] = Field(default=None, ge=1)


class VACFResponse(BaseModel):
    tau_ps: list[float]
    vacf: list[float] = Field(
        description="Normalised velocity autocorrelation C(tau)/C(0)"
    )
    n_atoms_used: int
    n_frames: int


# ============================================================================
# Helpers
# ============================================================================

_DIRECTION_AXES = {
    "xyz": (0, 1, 2),
    "xy": (0, 1),
    "x": (0,),
    "y": (1,),
    "z": (2,),
}


def _select_atoms(
    traj: md.Trajectory,
    atom_indices: Optional[list[int]],
    element: Optional[str],
) -> np.ndarray:
    """Resolve an atom subset. Element filter wins over explicit indices."""
    if element is not None:
        sym = element.strip().capitalize()
        selected = [
            atom.index
            for atom in traj.topology.atoms
            if atom.element is not None and atom.element.symbol == sym
        ]
        if not selected:
            raise HTTPException(
                status_code=400,
                detail=f"No atoms of element '{element}' found in trajectory.",
            )
        return np.asarray(selected, dtype=np.int64)

    if atom_indices is not None:
        arr = np.asarray(atom_indices, dtype=np.int64)
        if arr.size == 0:
            raise HTTPException(status_code=400, detail="atom_indices is empty")
        if arr.min() < 0 or arr.max() >= traj.n_atoms:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"atom_indices out of range [0, {traj.n_atoms - 1}]: "
                    f"min={int(arr.min())}, max={int(arr.max())}"
                ),
            )
        return arr

    return np.arange(traj.n_atoms, dtype=np.int64)


def _unwrap_coordinates(xyz_nm: np.ndarray, unitcell_lengths_nm: Optional[np.ndarray]) -> np.ndarray:
    """Remove PBC jumps from a (n_frames, n_atoms, 3) coordinate array.

    Uses the minimum-image convention frame-by-frame against the *previous*
    unwrapped coordinate. Only works for orthorhombic cells (diagonal lattice),
    but that is by far the most common case in slab/interface MD.
    """
    if unitcell_lengths_nm is None:
        return xyz_nm  # no PBC information, nothing to do
    out = xyz_nm.copy()
    for t in range(1, out.shape[0]):
        box = unitcell_lengths_nm[t]
        delta = out[t] - out[t - 1]
        shift = np.round(delta / box) * box
        out[t] -= shift
    return out


def _compute_msd_multiple_origins(
    coords: np.ndarray,
    axes: tuple[int, ...],
    max_tau: int,
) -> np.ndarray:
    """MSD(tau) averaged over time origins.

    Args:
        coords: (n_frames, n_atoms, 3) coordinate array.
        axes: Indices of the Cartesian components to include.
        max_tau: Maximum tau in frames (inclusive).

    Returns:
        (max_tau + 1,) array of MSD values (same units^2 as coords).
    """
    n_frames, n_atoms, _ = coords.shape
    sub = coords[:, :, list(axes)]
    msd = np.zeros(max_tau + 1, dtype=np.float64)
    msd[0] = 0.0
    for tau in range(1, max_tau + 1):
        disp = sub[tau:] - sub[:-tau]
        sq = np.sum(disp * disp, axis=2)
        msd[tau] = sq.mean()
    return msd


def _linear_fit(
    x: np.ndarray, y: np.ndarray
) -> tuple[float, float, float]:
    """Return (slope, intercept, R^2) for y = slope*x + intercept."""
    if x.size < 2:
        return float("nan"), float("nan"), float("nan")
    slope, intercept = np.polyfit(x, y, 1)
    y_hat = slope * x + intercept
    ss_res = float(np.sum((y - y_hat) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    return float(slope), float(intercept), r2


# ============================================================================
# Endpoints
# ============================================================================


@router.post("/msd", response_model=MSDResponse)
def compute_msd(request: MSDRequest) -> MSDResponse:
    """Compute MSD(tau) and (optionally) the diffusion coefficient.

    Multiple time origins are averaged via the standard sliding-window
    estimator. PBC jumps are removed (orthorhombic cells) so the slope of
    the linear regime is physically meaningful via Einstein's relation.
    """
    traj = load_trajectory(
        request.trajectory_b64,
        request.format,
        request.topology_b64,
        request.topology_format,
    )
    if traj.n_frames < 2:
        raise HTTPException(
            status_code=400,
            detail=f"MSD needs >=2 frames; got {traj.n_frames}.",
        )

    atoms = _select_atoms(traj, request.atom_indices, request.element)

    # coordinates in Angstroms (mdtraj stores nm internally)
    xyz_nm = traj.xyz[:, atoms, :]
    unitcell_nm = traj.unitcell_lengths  # (n_frames, 3) or None
    if request.unwrap_pbc:
        # unwrap per-atom (broadcasting box against frame dimension)
        box_nm = unitcell_nm if unitcell_nm is not None else None
        xyz_nm = _unwrap_coordinates(xyz_nm, box_nm)
    coords_ang = xyz_nm * 10.0

    max_tau = request.max_tau_frames or (traj.n_frames // 2)
    max_tau = min(max_tau, traj.n_frames - 1)
    if max_tau < 1:
        raise HTTPException(status_code=400, detail="max_tau too small")

    axes = _DIRECTION_AXES[request.directions]
    d_dim = len(axes)

    msd_vals = _compute_msd_multiple_origins(coords_ang, axes, max_tau)
    tau_ps = np.arange(max_tau + 1, dtype=np.float64) * request.timestep_ps

    # Pick a fit range
    if request.fit_range_ps is not None:
        if len(request.fit_range_ps) != 2:
            raise HTTPException(
                status_code=400,
                detail="fit_range_ps must be [tau_min, tau_max] in picoseconds.",
            )
        tau_min, tau_max = sorted(request.fit_range_ps)
    else:
        tau_min = tau_ps[1] + 0.2 * (tau_ps[-1] - tau_ps[1])
        tau_max = tau_ps[1] + 0.8 * (tau_ps[-1] - tau_ps[1])

    mask = (tau_ps >= tau_min) & (tau_ps <= tau_max)
    slope = intercept = r2 = None
    d_ang2_ps = d_cm2_s = None
    fit_range: Optional[list[float]] = None

    if mask.sum() >= 2:
        slope_f, intercept_f, r2_f = _linear_fit(tau_ps[mask], msd_vals[mask])
        if np.isfinite(slope_f):
            slope = slope_f
            intercept = intercept_f
            r2 = r2_f if np.isfinite(r2_f) else None
            # MSD = 2 d D tau  =>  D = slope / (2d)
            d_ang2_ps = slope_f / (2.0 * d_dim)
            # 1 Angstrom^2/ps = 1e-16 cm^2 / 1e-12 s = 1e-4 cm^2/s
            d_cm2_s = d_ang2_ps * 1e-4
            fit_range = [float(tau_min), float(tau_max)]

    return MSDResponse(
        tau_ps=tau_ps.tolist(),
        msd_angstrom2=msd_vals.tolist(),
        n_atoms_used=int(atoms.size),
        n_frames=int(traj.n_frames),
        directions=request.directions,
        dimensionality=d_dim,
        diffusion_coefficient_cm2_s=d_cm2_s,
        diffusion_coefficient_ang2_ps=d_ang2_ps,
        fit_slope_ang2_per_ps=slope,
        fit_intercept_ang2=intercept,
        fit_r_squared=r2,
        fit_tau_range_ps=fit_range,
    )


@router.post("/vacf", response_model=VACFResponse)
def compute_vacf(request: VACFRequest) -> VACFResponse:
    """Velocity autocorrelation C(tau)/C(0) via finite differences.

    Velocities are estimated by centred differences on the (optionally PBC-
    unwrapped) coordinates. The autocorrelation is averaged over time origins
    and atoms, then normalised by C(0).
    """
    traj = load_trajectory(
        request.trajectory_b64,
        request.format,
        request.topology_b64,
        request.topology_format,
    )
    if traj.n_frames < 3:
        raise HTTPException(status_code=400, detail="VACF needs >=3 frames.")

    atoms = _select_atoms(traj, request.atom_indices, request.element)
    xyz_nm = traj.xyz[:, atoms, :]
    xyz_nm = _unwrap_coordinates(xyz_nm, traj.unitcell_lengths)
    coords_ang = xyz_nm * 10.0
    dt = request.timestep_ps
    # centred difference velocities in Angstrom/ps, shape (n_frames-2, n_atoms, 3)
    vel = (coords_ang[2:] - coords_ang[:-2]) / (2.0 * dt)

    max_tau = request.max_tau_frames or (vel.shape[0] // 2)
    max_tau = min(max_tau, vel.shape[0] - 1)
    if max_tau < 1:
        raise HTTPException(status_code=400, detail="Not enough frames for VACF")

    vacf = np.zeros(max_tau + 1, dtype=np.float64)
    for tau in range(max_tau + 1):
        dot = np.sum(vel[: vel.shape[0] - tau] * vel[tau:], axis=2)
        vacf[tau] = dot.mean()
    c0 = vacf[0] if vacf[0] != 0 else 1.0
    tau_ps = np.arange(max_tau + 1, dtype=np.float64) * dt

    return VACFResponse(
        tau_ps=tau_ps.tolist(),
        vacf=(vacf / c0).tolist(),
        n_atoms_used=int(atoms.size),
        n_frames=int(traj.n_frames),
    )


@router.get("/health")
def md_dynamics_health() -> dict:
    return {"status": "ok", "module": "md_dynamics"}

"""MD cavitation free energy ΔG_cav(R, z) via Lum-Chandler-Weeks analysis.

For a spherical probe of radius R centred at (x, y, z) the cavitation
probability

    P0(R, z) = <indicator(probe volume contains zero solvent atoms)>

is estimated by placing probes on a uniform (x, y) grid inside the simulation
cell for every trajectory frame, then counting how many probe placements are
empty. The cavitation free energy follows the Boltzmann relation

    ΔG_cav(R, z) = -k_B T ln P0(R, z).

For probe bins where P0 = 0 within the available sampling the response
records NaN and reports the Laplace lower bound
    ΔG_lower = k_B T ln(n_samples + 1)
to allow the caller to decide how to display empty bins.

LCW scaling: for small hydrophobic cavities, theory predicts that
ΔG_cav grows linearly with the cavity volume V = (4/3) π R^3. The endpoint
optionally performs this linear regression within user-selected IHP / Stern
z windows and returns the slope/R^2. It also reports the migration
descriptor ΔG_cav(R) = ΔG_cav^IHP(R) - ΔG_cav^Stern(R) if both windows are
provided.
"""

import logging
import math
from typing import Optional

import mdtraj as md
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .md_utils import load_trajectory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/md/cavitation", tags=["md-cavitation"])

# Boltzmann constant in eV/K
_KB_EV_PER_K = 8.617333262e-5


# ============================================================================
# Pydantic models
# ============================================================================


class CavitationRequest(BaseModel):
    trajectory_b64: str = Field(description="Base64-encoded trajectory file content")
    format: str = Field(description="Trajectory format extension")
    topology_b64: Optional[str] = Field(default=None)
    topology_format: Optional[str] = Field(default=None)

    solvent_element: str = Field(
        default="O",
        description="Element symbol for the solvent site (default O = water oxygens).",
    )
    probe_radii_angstrom: list[float] = Field(
        default=[1.25, 1.50, 1.75, 2.00, 2.25, 2.50],
        description="List of probe radii R in Angstroms.",
    )
    axis: str = Field(
        default="z",
        description="Surface normal ('x', 'y', or 'z') along which to bin ΔG_cav.",
    )
    n_z_bins: int = Field(default=60, ge=1, le=1000)
    z_range: Optional[list[float]] = Field(
        default=None,
        description="[z_min, z_max] in Angstroms. Defaults to the full cell extent along axis.",
    )
    grid_spacing_angstrom: float = Field(
        default=0.8,
        gt=0.1,
        description="In-plane probe grid spacing. Smaller → better statistics, quadratic cost.",
    )
    frame_stride: int = Field(
        default=1,
        ge=1,
        description="Sample every Nth frame (larger stride → faster, noisier statistics).",
    )
    temperature_K: float = Field(
        default=300.0,
        gt=0.0,
        description="Temperature used in ΔG = -k_B T ln P0.",
    )
    ihp_z_range: Optional[list[float]] = Field(
        default=None,
        description="Optional [z_min, z_max] for the IHP window (LCW scaling + migration).",
    )
    stern_z_range: Optional[list[float]] = Field(
        default=None,
        description="Optional [z_min, z_max] for the Stern window.",
    )
    periodic: bool = Field(
        default=True,
        description="Wrap probe-solvent distances with minimum image convention.",
    )


class LCWRegion(BaseModel):
    region: str
    z_range_angstrom: list[float]
    probe_radii_angstrom: list[float]
    cavity_volume_angstrom3: list[float]
    delta_g_cav_eV: list[float]
    linear_fit_slope_eV_per_A3: Optional[float] = None
    linear_fit_intercept_eV: Optional[float] = None
    linear_fit_r_squared: Optional[float] = None


class CavitationResponse(BaseModel):
    axis: str
    probe_radii_angstrom: list[float]
    z_bin_centers_angstrom: list[float]
    p0: list[list[float]] = Field(
        description="P0(R, z); rows = probe radii, cols = z bins"
    )
    delta_g_cav_eV: list[list[float]] = Field(
        description="ΔG_cav(R, z) in eV; NaN where P0 = 0 within sampling"
    )
    sampling_lower_bound_eV: list[list[float]] = Field(
        description="For empty bins: k_B T ln(n_samples+1), the highest ΔG the data can resolve.",
    )
    n_samples: list[list[int]] = Field(
        description="Number of (frame × grid point) probe placements per bin."
    )
    temperature_K: float
    n_frames_used: int
    n_solvent_atoms: int
    lcw_ihp: Optional[LCWRegion] = None
    lcw_stern: Optional[LCWRegion] = None
    migration_descriptor_eV: Optional[list[float]] = Field(
        default=None,
        description="ΔG_cav(R) = ΔG_cav^IHP(R) - ΔG_cav^Stern(R) for each probe radius (if both windows given).",
    )


# ============================================================================
# Helpers
# ============================================================================


_AXIS_INDEX = {"x": 0, "y": 1, "z": 2}


def _linear_fit(x: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    mask = np.isfinite(y)
    if mask.sum() < 2:
        return float("nan"), float("nan"), float("nan")
    xx = x[mask]
    yy = y[mask]
    slope, intercept = np.polyfit(xx, yy, 1)
    yhat = slope * xx + intercept
    ss_res = float(np.sum((yy - yhat) ** 2))
    ss_tot = float(np.sum((yy - yy.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    return float(slope), float(intercept), r2


def _mean_in_window(
    z_centers: np.ndarray, values: np.ndarray, window: list[float]
) -> float:
    lo, hi = sorted(window)
    mask = (z_centers >= lo) & (z_centers <= hi) & np.isfinite(values)
    if mask.sum() == 0:
        return float("nan")
    return float(values[mask].mean())


# ============================================================================
# Endpoint
# ============================================================================


@router.post("/profile", response_model=CavitationResponse)
def compute_cavitation_profile(request: CavitationRequest) -> CavitationResponse:
    """Compute ΔG_cav(R, z) from an AIMD trajectory via LCW cavitation theory."""
    traj = load_trajectory(
        request.trajectory_b64,
        request.format,
        request.topology_b64,
        request.topology_format,
    )
    if traj.n_frames < 1:
        raise HTTPException(status_code=400, detail="Empty trajectory")
    if traj.unitcell_lengths is None:
        raise HTTPException(
            status_code=400,
            detail="Cavitation analysis needs a periodic cell (unitcell_lengths). None found.",
        )

    sym = request.solvent_element.strip().capitalize()
    solvent_idx = np.array(
        [a.index for a in traj.topology.atoms if a.element and a.element.symbol == sym],
        dtype=np.int64,
    )
    if solvent_idx.size == 0:
        raise HTTPException(
            status_code=400,
            detail=f"No atoms of element '{sym}' in trajectory.",
        )

    axis = request.axis.lower()
    if axis not in _AXIS_INDEX:
        raise HTTPException(status_code=400, detail="axis must be 'x', 'y', or 'z'")
    axis_idx = _AXIS_INDEX[axis]
    in_plane = [i for i in (0, 1, 2) if i != axis_idx]

    radii = np.asarray(request.probe_radii_angstrom, dtype=np.float64)
    if radii.size == 0 or np.any(radii <= 0):
        raise HTTPException(status_code=400, detail="probe_radii_angstrom must be positive")
    r_max = float(radii.max())

    # Stride frames
    frame_indices = list(range(0, traj.n_frames, request.frame_stride))
    if not frame_indices:
        raise HTTPException(status_code=400, detail="No frames selected")

    # Cell lengths in Angstroms (assume orthorhombic; warn otherwise)
    box_nm_all = traj.unitcell_lengths  # (n_frames, 3)
    angles = traj.unitcell_angles
    if angles is not None and np.any(np.abs(angles - 90.0) > 1.0):
        logger.warning(
            "md_cavitation: non-orthorhombic cell detected (angles != 90). "
            "Using orthorhombic minimum-image approximation."
        )

    # Solvent coords in Angstroms (n_frames, n_solv, 3)
    solvent_xyz = traj.xyz[:, solvent_idx, :] * 10.0

    # z bin edges
    if request.z_range is not None:
        if len(request.z_range) != 2:
            raise HTTPException(status_code=400, detail="z_range must be [z_min, z_max]")
        z_min, z_max = sorted(request.z_range)
    else:
        z_min = float(solvent_xyz[..., axis_idx].min())
        z_max = float(solvent_xyz[..., axis_idx].max())
    if z_max <= z_min:
        raise HTTPException(status_code=400, detail="Invalid z_range (max <= min)")
    z_edges = np.linspace(z_min, z_max, request.n_z_bins + 1)
    z_centers = 0.5 * (z_edges[:-1] + z_edges[1:])

    # Empty-probe counts and total samples per (radius, z) cell
    n_r = radii.size
    n_z = request.n_z_bins
    empty_counts = np.zeros((n_r, n_z), dtype=np.int64)
    total_counts = np.zeros((n_r, n_z), dtype=np.int64)

    gs = float(request.grid_spacing_angstrom)

    for t in frame_indices:
        box_ang = box_nm_all[t] * 10.0
        Lx = box_ang[in_plane[0]]
        Ly = box_ang[in_plane[1]]

        nx = max(int(math.floor(Lx / gs)), 1)
        ny = max(int(math.floor(Ly / gs)), 1)
        x_coords = (np.arange(nx) + 0.5) * (Lx / nx)
        y_coords = (np.arange(ny) + 0.5) * (Ly / ny)

        # For every z bin center, build probes and test
        solv = solvent_xyz[t]  # (n_solv, 3)
        # Pre-compute in-plane distances from probes to every solvent atom —
        # Reused across all probe radii. Build a (nx*ny, n_solv) squared-distance matrix
        # restricted by the perpendicular cutoff for each z_center separately to cut cost.
        # Strategy: per z_center, filter solvent atoms within |Δaxis| < r_max + margin,
        # then check full 3D distance against each probe radius.
        for zi, zc in enumerate(z_centers):
            d_axis = solv[:, axis_idx] - zc
            # minimum image along axis
            if request.periodic:
                Laxis = box_ang[axis_idx]
                d_axis = d_axis - np.round(d_axis / Laxis) * Laxis
            near_mask = np.abs(d_axis) <= r_max
            if not near_mask.any():
                # no solvent within r_max along axis: every probe is empty
                # but still allocate samples
                for ri in range(n_r):
                    empty_counts[ri, zi] += nx * ny
                    total_counts[ri, zi] += nx * ny
                continue

            solv_near = solv[near_mask]
            d_axis_near = d_axis[near_mask]

            # Probe grid (nx*ny, 2) in-plane coordinates
            XX, YY = np.meshgrid(x_coords, y_coords, indexing="ij")
            probes_xy = np.stack([XX.ravel(), YY.ravel()], axis=1)  # (P, 2)
            P = probes_xy.shape[0]

            # In-plane deltas: (P, n_near, 2)
            dxy = probes_xy[:, None, :] - solv_near[None, :, in_plane]
            if request.periodic:
                L_in = box_ang[in_plane]
                dxy = dxy - np.round(dxy / L_in) * L_in
            dist_sq = (dxy * dxy).sum(axis=2) + (d_axis_near * d_axis_near)[None, :]

            for ri, R in enumerate(radii):
                inside = dist_sq < (R * R)
                empty_per_probe = ~inside.any(axis=1)  # (P,)
                empty_counts[ri, zi] += int(empty_per_probe.sum())
                total_counts[ri, zi] += P

    p0 = np.where(total_counts > 0, empty_counts / np.maximum(total_counts, 1), np.nan)

    kBT = _KB_EV_PER_K * request.temperature_K
    with np.errstate(divide="ignore", invalid="ignore"):
        delta_g = np.where(p0 > 0, -kBT * np.log(p0), np.nan)
    lower_bound = np.where(
        total_counts > 0, kBT * np.log(total_counts + 1), np.nan
    )

    response = CavitationResponse(
        axis=axis,
        probe_radii_angstrom=[float(r) for r in radii],
        z_bin_centers_angstrom=[float(z) for z in z_centers],
        p0=[[float(v) for v in row] for row in p0],
        delta_g_cav_eV=[[float(v) for v in row] for row in delta_g],
        sampling_lower_bound_eV=[[float(v) for v in row] for row in lower_bound],
        n_samples=[[int(v) for v in row] for row in total_counts],
        temperature_K=request.temperature_K,
        n_frames_used=len(frame_indices),
        n_solvent_atoms=int(solvent_idx.size),
    )

    # Optional LCW linear fits
    def _build_region(
        window: Optional[list[float]], label: str
    ) -> Optional[LCWRegion]:
        if window is None or len(window) != 2:
            return None
        g_region = np.array(
            [_mean_in_window(z_centers, delta_g[ri], window) for ri in range(n_r)],
            dtype=np.float64,
        )
        volumes = (4.0 / 3.0) * math.pi * radii ** 3
        slope, intercept, r2 = _linear_fit(volumes, g_region)
        return LCWRegion(
            region=label,
            z_range_angstrom=list(map(float, sorted(window))),
            probe_radii_angstrom=[float(r) for r in radii],
            cavity_volume_angstrom3=[float(v) for v in volumes],
            delta_g_cav_eV=[float(v) for v in g_region],
            linear_fit_slope_eV_per_A3=slope if math.isfinite(slope) else None,
            linear_fit_intercept_eV=intercept if math.isfinite(intercept) else None,
            linear_fit_r_squared=r2 if math.isfinite(r2) else None,
        )

    response.lcw_ihp = _build_region(request.ihp_z_range, "IHP")
    response.lcw_stern = _build_region(request.stern_z_range, "Stern")

    if response.lcw_ihp is not None and response.lcw_stern is not None:
        g_ihp = np.asarray(response.lcw_ihp.delta_g_cav_eV, dtype=np.float64)
        g_stern = np.asarray(response.lcw_stern.delta_g_cav_eV, dtype=np.float64)
        response.migration_descriptor_eV = [
            float(a - b) for a, b in zip(g_ihp, g_stern)
        ]

    return response


@router.get("/health")
def md_cavitation_health() -> dict:
    return {"status": "ok", "module": "md_cavitation"}

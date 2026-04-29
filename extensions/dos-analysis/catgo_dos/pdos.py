"""Projected density of states (PDOS) computation.

Core routines for Gaussian broadening of discrete eigenvalues onto a
continuous energy grid, weighted by k-point weights and projector
coefficients.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple, Union

import numpy as np

from .io import VaspData
from .orbital import d_indices, parse_orbital_spec


# ---------------------------------------------------------------------------
# Gaussian broadening
# ---------------------------------------------------------------------------

def gaussian_broaden(
    energies: np.ndarray,
    weights: np.ndarray,
    grid: np.ndarray,
    sigma: float,
) -> np.ndarray:
    """Broaden discrete states onto a continuous energy grid.

    Each eigenvalue contributes a normalised Gaussian:
        w * exp(-(E - Ei)^2 / (2 sigma^2)) / (sigma * sqrt(2 pi))

    Parameters
    ----------
    energies : ndarray, shape (nstates,)
        Eigenvalue energies (already shifted if desired).
    weights : ndarray, shape (nstates,)
        Corresponding weights for each state.
    grid : ndarray, shape (ngrid,)
        Energy grid points.
    sigma : float
        Gaussian broadening width in eV.

    Returns
    -------
    ndarray, shape (ngrid,)
    """
    if energies.size == 0:
        return np.zeros_like(grid)
    pref = 1.0 / (sigma * math.sqrt(2.0 * math.pi))
    dos = np.zeros_like(grid)
    chunk = 50_000
    for i in range(0, energies.size, chunk):
        e = energies[i : i + chunk]
        w = weights[i : i + chunk]
        diff = grid[:, None] - e[None, :]
        g = np.exp(-0.5 * (diff / sigma) ** 2) * pref
        dos += g @ w
    return dos


# ---------------------------------------------------------------------------
# PDOS computation
# ---------------------------------------------------------------------------

@dataclass
class PDOSResult:
    """Result of a PDOS computation.

    Attributes
    ----------
    grid : ndarray, shape (ngrid,)
        Energy grid relative to E_f (eV).
    pdos : ndarray, shape (nspin, ngrid)
        Projected DOS on the grid.
    atoms : list[int]
        Atom indices used.
    channels : list[int]
        Projector channel indices used.
    label : str
        Human-readable label.
    normalized : bool
        Whether per-atom normalization was applied.
    """

    grid: np.ndarray
    pdos: np.ndarray
    atoms: List[int] = field(default_factory=list)
    channels: List[int] = field(default_factory=list)
    label: str = ""
    normalized: bool = False


def compute_pdos(
    data: VaspData,
    atoms: List[int],
    channels: Union[List[int], str],
    *,
    sigma: float = 0.05,
    emin: float = -8.0,
    emax: float = 6.0,
    ngrid: int = 2000,
    normalize: bool = False,
    label: str = "",
) -> PDOSResult:
    """Compute projected DOS for a selection of atoms and orbitals.

    Parameters
    ----------
    data : VaspData
        Electronic structure data from ``read_vaspout_h5``.
    atoms : list[int]
        0-based atom indices.
    channels : list[int] or str
        Projector channel indices, or an orbital spec string like ``"d"`` or ``"dxy,dz2"``.
    sigma : float
        Gaussian broadening (eV).
    emin, emax : float
        Energy range relative to E_f (eV).
    ngrid : int
        Number of grid points.
    normalize : bool
        If True, divide by the number of selected atoms (per-atom average).
    label : str
        Human-readable label for this PDOS group.

    Returns
    -------
    PDOSResult
    """
    if isinstance(channels, str):
        channels = parse_orbital_spec(channels, data.nchannels)

    E = data.eigenvalues  # (spin, k, band)
    wk = data.kweights    # (k,)
    par = data.projectors  # (spin, ion, chan, k, band)
    Ef = data.efermi

    nspin, nk, nb = E.shape
    wk_b = wk[None, :, None]  # (1, k, 1)

    # Sum projectors over selected atoms and channels
    Pd = par[:, atoms, :, :, :]               # (spin, natoms, chan, k, band)
    Pd = Pd[:, :, channels, :, :].sum(axis=(1, 2))  # (spin, k, band)
    weights = wk_b * Pd

    # Build energy grid
    grid = np.linspace(emin, emax, ngrid)
    Erel = E - Ef

    pdos = np.zeros((nspin, ngrid), dtype=np.float64)
    for s in range(nspin):
        e_flat = Erel[s].reshape(-1)
        w_flat = weights[s].reshape(-1)
        pdos[s] = gaussian_broaden(e_flat, w_flat, grid, sigma)

    if normalize and len(atoms) > 0:
        pdos /= float(len(atoms))

    return PDOSResult(
        grid=grid,
        pdos=pdos,
        atoms=list(atoms),
        channels=list(channels),
        label=label,
        normalized=normalize,
    )


def compute_total_dos(
    data: VaspData,
    *,
    sigma: float = 0.05,
    emin: float = -8.0,
    emax: float = 6.0,
    ngrid: int = 2000,
) -> PDOSResult:
    """Compute the total density of states (all atoms, all channels).

    Parameters
    ----------
    data : VaspData
    sigma, emin, emax, ngrid : float/int
        Broadening and grid parameters.
    """
    all_atoms = list(range(data.nions))
    all_channels = list(range(data.nchannels))
    return compute_pdos(
        data,
        all_atoms,
        all_channels,
        sigma=sigma,
        emin=emin,
        emax=emax,
        ngrid=ngrid,
        label="Total DOS",
    )


# ---------------------------------------------------------------------------
# DOS integration
# ---------------------------------------------------------------------------

def integrate_dos(
    grid: np.ndarray,
    dos: np.ndarray,
    emin: Optional[float] = None,
    emax: Optional[float] = None,
) -> np.ndarray:
    """Integrate DOS curve(s) over an energy window using the trapezoidal rule.

    Parameters
    ----------
    grid : ndarray, shape (ngrid,)
        Energy grid.
    dos : ndarray, shape (..., ngrid)
        DOS values (can be multi-spin).
    emin, emax : float, optional
        Integration bounds. Defaults to full grid range.

    Returns
    -------
    ndarray
        Integrated value(s), same leading shape as *dos* minus the last axis.
    """
    mask = np.ones(grid.shape, dtype=bool)
    if emin is not None:
        mask &= grid >= emin
    if emax is not None:
        mask &= grid <= emax
    return np.trapz(dos[..., mask], grid[mask], axis=-1)


def cumulative_dos(
    grid: np.ndarray,
    dos: np.ndarray,
) -> np.ndarray:
    """Compute the cumulative (running) integral of the DOS.

    Parameters
    ----------
    grid : ndarray, shape (ngrid,)
    dos : ndarray, shape (..., ngrid)

    Returns
    -------
    ndarray, same shape as *dos*
        Cumulative integral from grid[0] to each grid point.
    """
    dE = np.diff(grid, prepend=grid[0])
    return np.cumsum(dos * dE, axis=-1)


def find_band_edges(
    grid: np.ndarray,
    dos: np.ndarray,
    threshold: float = 0.01,
) -> Tuple[float, float]:
    """Find the lower and upper band edges where DOS exceeds a threshold.

    Parameters
    ----------
    grid : ndarray, shape (ngrid,)
    dos : ndarray, shape (ngrid,)
        1-D DOS array (sum spins first if needed).
    threshold : float
        Minimum DOS value to consider as "occupied".

    Returns
    -------
    (lower_edge, upper_edge) : tuple[float, float]
    """
    above = np.where(dos > threshold)[0]
    if len(above) == 0:
        return (float("nan"), float("nan"))
    return float(grid[above[0]]), float(grid[above[-1]])


# ---------------------------------------------------------------------------
# Convenience: multi-group PDOS
# ---------------------------------------------------------------------------

def compute_pdos_groups(
    data: VaspData,
    groups: List[dict],
    *,
    sigma: float = 0.05,
    emin: float = -8.0,
    emax: float = 6.0,
    ngrid: int = 2000,
) -> List[PDOSResult]:
    """Compute PDOS for multiple groups at once.

    Parameters
    ----------
    data : VaspData
    groups : list of dict
        Each dict should have keys ``"atoms"`` (list[int]),
        ``"channels"`` (list[int] or str), and optionally
        ``"label"`` (str), ``"normalize"`` (bool).

    Returns
    -------
    list[PDOSResult]
    """
    results = []
    for g in groups:
        res = compute_pdos(
            data,
            atoms=g["atoms"],
            channels=g.get("channels", g.get("orbitals", "d")),
            sigma=sigma,
            emin=emin,
            emax=emax,
            ngrid=ngrid,
            normalize=g.get("normalize", False),
            label=g.get("label", ""),
        )
        results.append(res)
    return results

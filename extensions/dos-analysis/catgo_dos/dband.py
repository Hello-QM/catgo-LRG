"""D-band theory analysis.

Computes d-band descriptors from VASP projector data:
- d-band center (1st moment)
- d-band width (2nd moment, standard deviation)
- d-band skewness (3rd moment)
- d-band kurtosis (4th moment)
- d-band filling (occupied d-electron count)
- d-band upper/lower edge
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

from .io import VaspData
from .orbital import d_indices


@dataclass
class DBandCenter:
    """D-band center result.

    Attributes
    ----------
    eps_abs : float
        Absolute d-band center (eV).
    eps_rel : float
        D-band center relative to E_f (eV).
    denominator : float
        Sum of weights (normalisation factor).
    """

    eps_abs: float
    eps_rel: float
    denominator: float


@dataclass
class DBandWidth:
    """D-band width (standard deviation) result.

    Attributes
    ----------
    width : float
        RMS width sqrt(<(E - eps_d)^2>) in eV.
    variance : float
        Second central moment (eV^2).
    """

    width: float
    variance: float


@dataclass
class DBandFilling:
    """D-band filling result.

    Attributes
    ----------
    n_d : float
        Occupied d-electron count (projector-weighted).
    total_weight : float
        Total d-weight in the window (occupied + unoccupied).
    filling_fraction : float
        n_d / total_weight (0..1).
    """

    n_d: float
    total_weight: float
    filling_fraction: float


@dataclass
class DBandMoments:
    """Full set of d-band statistical moments.

    Attributes
    ----------
    center : float
        1st moment (d-band center) relative to E_f (eV).
    width : float
        Square root of 2nd central moment (eV).
    skewness : float
        3rd standardised moment (dimensionless).
    kurtosis : float
        4th standardised moment (dimensionless). Gaussian = 3.
    """

    center: float
    width: float
    skewness: float
    kurtosis: float


@dataclass
class DBandProperties:
    """Comprehensive d-band analysis result."""

    center: DBandCenter
    width: DBandWidth
    filling: DBandFilling
    moments: DBandMoments
    upper_edge: float
    lower_edge: float


# ---------------------------------------------------------------------------
# Internal: extract d-projected weights
# ---------------------------------------------------------------------------

def _d_weights(
    data: VaspData,
    atoms: List[int],
) -> Tuple[np.ndarray, np.ndarray]:
    """Return (E, W) arrays for d-projected states.

    E : (spin, k, band) eigenvalues
    W : (spin, k, band) k-weighted d-projector sums
    """
    E = data.eigenvalues   # (spin, k, band)
    wk = data.kweights     # (k,)
    par = data.projectors  # (spin, ion, chan, k, band)

    d_idx = d_indices(data.nchannels)

    Pd = par[:, atoms, :, :, :]                  # (spin, natoms, chan, k, band)
    Pd = Pd[:, :, d_idx, :, :].sum(axis=(1, 2))  # (spin, k, band)
    W = wk[None, :, None] * Pd                   # (spin, k, band)
    return E, W


def _apply_mask(
    E: np.ndarray,
    W: np.ndarray,
    efermi: float,
    occupied_only: bool,
    window: Optional[Tuple[float, float]],
) -> np.ndarray:
    """Return masked weight array (zeros where excluded)."""
    mask = np.ones_like(E, dtype=bool)
    if occupied_only:
        mask &= E <= efermi
    if window is not None:
        lo, hi = window
        mask &= (E >= efermi + lo) & (E <= efermi + hi)
    return np.where(mask, W, 0.0)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def compute_d_center(
    data: VaspData,
    atoms: List[int],
    *,
    occupied_only: bool = True,
    window: Optional[Tuple[float, float]] = None,
) -> DBandCenter:
    """Compute the d-band center.

    .. math::
        \\varepsilon_d = \\frac{\\sum_{s,k,n} w_k P_d(s,k,n) E(s,k,n)}
                               {\\sum_{s,k,n} w_k P_d(s,k,n)}

    Parameters
    ----------
    data : VaspData
    atoms : list[int]
        0-based atom indices.
    occupied_only : bool
        If True, only include states with E <= E_f.
    window : (lo, hi), optional
        Energy window relative to E_f (eV).

    Returns
    -------
    DBandCenter
    """
    E, W = _d_weights(data, atoms)
    Wm = _apply_mask(E, W, data.efermi, occupied_only, window)

    den = float(np.sum(Wm))
    if den <= 0:
        return DBandCenter(eps_abs=float("nan"), eps_rel=float("nan"), denominator=0.0)

    eps_abs = float(np.sum(Wm * E)) / den
    eps_rel = eps_abs - data.efermi
    return DBandCenter(eps_abs=eps_abs, eps_rel=eps_rel, denominator=den)


def compute_d_width(
    data: VaspData,
    atoms: List[int],
    *,
    occupied_only: bool = False,
    window: Optional[Tuple[float, float]] = None,
) -> DBandWidth:
    """Compute the d-band width (RMS deviation from center).

    .. math::
        W_d = \\sqrt{\\frac{\\sum w_k P_d (E - \\varepsilon_d)^2}{\\sum w_k P_d}}

    Parameters
    ----------
    data : VaspData
    atoms : list[int]
    occupied_only : bool
    window : (lo, hi), optional
        Energy window relative to E_f (eV).
    """
    E, W = _d_weights(data, atoms)
    Wm = _apply_mask(E, W, data.efermi, occupied_only, window)

    den = float(np.sum(Wm))
    if den <= 0:
        return DBandWidth(width=float("nan"), variance=float("nan"))

    eps = float(np.sum(Wm * E)) / den
    var = float(np.sum(Wm * (E - eps) ** 2)) / den
    return DBandWidth(width=float(np.sqrt(max(var, 0.0))), variance=var)


def compute_d_filling(
    data: VaspData,
    atoms: List[int],
    *,
    occupied_only: bool = True,
    window: Optional[Tuple[float, float]] = None,
) -> DBandFilling:
    """Compute d-band filling (occupied d-electron count).

    Parameters
    ----------
    data : VaspData
    atoms : list[int]
    occupied_only : bool
        If True, count only states with E <= E_f as occupied.
    window : (lo, hi), optional
        Energy window relative to E_f (eV).
    """
    E, W = _d_weights(data, atoms)

    # Include mask (energy window)
    include = np.ones_like(E, dtype=bool)
    if window is not None:
        lo, hi = window
        include &= (E >= data.efermi + lo) & (E <= data.efermi + hi)

    # Occupancy mask
    occ = (E <= data.efermi) if occupied_only else np.ones_like(E, dtype=bool)

    W_in = np.where(include, W, 0.0)
    n_d = float(np.sum(np.where(occ, W_in, 0.0)))
    total = float(np.sum(W_in))
    frac = (n_d / total) if total > 0 else float("nan")
    return DBandFilling(n_d=n_d, total_weight=total, filling_fraction=frac)


def compute_d_moments(
    data: VaspData,
    atoms: List[int],
    *,
    occupied_only: bool = False,
    window: Optional[Tuple[float, float]] = None,
) -> DBandMoments:
    """Compute up to the 4th standardised moment of the d-band.

    Returns center, width, skewness, and kurtosis.

    Parameters
    ----------
    data : VaspData
    atoms : list[int]
    occupied_only : bool
    window : (lo, hi), optional
    """
    E, W = _d_weights(data, atoms)
    Wm = _apply_mask(E, W, data.efermi, occupied_only, window)

    den = float(np.sum(Wm))
    nan = float("nan")
    if den <= 0:
        return DBandMoments(center=nan, width=nan, skewness=nan, kurtosis=nan)

    # 1st moment (center)
    mu1 = float(np.sum(Wm * E)) / den
    center_rel = mu1 - data.efermi

    # Central moments
    dE = E - mu1
    mu2 = float(np.sum(Wm * dE**2)) / den
    sigma = float(np.sqrt(max(mu2, 0.0)))

    if sigma <= 0:
        return DBandMoments(center=center_rel, width=0.0, skewness=nan, kurtosis=nan)

    mu3 = float(np.sum(Wm * dE**3)) / den
    mu4 = float(np.sum(Wm * dE**4)) / den

    skewness = mu3 / sigma**3
    kurtosis = mu4 / sigma**4

    return DBandMoments(
        center=center_rel,
        width=sigma,
        skewness=skewness,
        kurtosis=kurtosis,
    )


def compute_d_band_edges(
    data: VaspData,
    atoms: List[int],
    *,
    sigma: float = 0.05,
    threshold: float = 0.01,
    emin: float = -10.0,
    emax: float = 10.0,
    ngrid: int = 2000,
) -> Tuple[float, float]:
    """Find the lower and upper d-band edges from broadened d-PDOS.

    Parameters
    ----------
    data : VaspData
    atoms : list[int]
    sigma : float
        Gaussian broadening (eV).
    threshold : float
        Minimum PDOS to consider as "band".
    emin, emax, ngrid : float/int
        Grid parameters.

    Returns
    -------
    (lower_edge, upper_edge) : tuple[float, float]
        In eV relative to E_f.
    """
    from .pdos import compute_pdos

    d_ch = d_indices(data.nchannels)
    result = compute_pdos(
        data, atoms, d_ch,
        sigma=sigma, emin=emin, emax=emax, ngrid=ngrid,
    )

    # Sum over spins for edge detection
    total_pdos = result.pdos.sum(axis=0)

    from .pdos import find_band_edges
    return find_band_edges(result.grid, total_pdos, threshold)


def analyze_d_band(
    data: VaspData,
    atoms: List[int],
    *,
    occupied_only_center: bool = True,
    window: Optional[Tuple[float, float]] = None,
    sigma: float = 0.05,
    edge_threshold: float = 0.01,
) -> DBandProperties:
    """Run a comprehensive d-band analysis.

    Computes center, width, filling, moments, and band edges in one call.

    Parameters
    ----------
    data : VaspData
    atoms : list[int]
    occupied_only_center : bool
        Use occupied-only states for d-band center.
    window : (lo, hi), optional
        Energy window relative to E_f for center/width/filling.
    sigma : float
        Gaussian broadening for edge detection.
    edge_threshold : float
        PDOS threshold for edge detection.

    Returns
    -------
    DBandProperties
    """
    center = compute_d_center(data, atoms, occupied_only=occupied_only_center, window=window)
    width = compute_d_width(data, atoms, window=window)
    filling = compute_d_filling(data, atoms, window=window)
    moments = compute_d_moments(data, atoms, window=window)
    lower_edge, upper_edge = compute_d_band_edges(
        data, atoms, sigma=sigma, threshold=edge_threshold,
    )
    return DBandProperties(
        center=center,
        width=width,
        filling=filling,
        moments=moments,
        upper_edge=upper_edge,
        lower_edge=lower_edge,
    )

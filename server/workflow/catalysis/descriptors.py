"""Catalytic activity descriptors for structure-activity correlations.

Extracts electronic and geometric descriptors from DFT results:
- d-band center (from projected DOS)
- coordination number (from structure geometry)
- surface strain (from lattice mismatch)

Note: d-band center can also be computed interactively via the DOS
analysis session (/api/dos/dband). This module is for non-interactive
workflow pipeline usage where a full DOS session isn't needed.
"""

import math
from typing import Optional


def compute_d_band_center(
    energies: list[float],
    dos_d: list[float],
    e_fermi: float = 0.0,
) -> dict:
    """Compute d-band center from projected density of states.

    epsilon_d = integral(E * DOS_d(E) dE) / integral(DOS_d(E) dE)

    The d-band center position relative to Fermi level correlates with
    adsorption strength (Hammer-Norskov d-band model).

    Args:
        energies: Energy grid points (eV).
        dos_d: d-orbital projected DOS at each energy point.
        e_fermi: Fermi energy (eV). Energies are shifted by this value.

    Returns:
        Dict with d_band_center, d_band_width, d_band_filling.
    """
    if len(energies) != len(dos_d) or len(energies) < 2:
        return {"error": "Invalid DOS data"}

    dE = energies[1] - energies[0]  # Uniform energy grid spacing

    # Shift to Fermi-referenced energies
    e_shifted = [e - e_fermi for e in energies]

    # Integrals (trapezoidal rule)
    integral_E_dos = sum(e * d * dE for e, d in zip(e_shifted, dos_d))
    integral_dos = sum(d * dE for d in dos_d)

    if abs(integral_dos) < 1e-10:
        return {"error": "Zero total DOS"}

    d_center = integral_E_dos / integral_dos

    # d-band width: sqrt(<E^2> - <E>^2)
    integral_E2_dos = sum(e**2 * d * dE for e, d in zip(e_shifted, dos_d))
    variance = integral_E2_dos / integral_dos - d_center**2
    d_width = math.sqrt(max(variance, 0))

    # d-band filling: fraction of states below Fermi level
    states_below = sum(d * dE for e, d in zip(e_shifted, dos_d) if e <= 0)
    d_filling = states_below / integral_dos if integral_dos > 0 else 0

    return {
        "d_band_center": d_center,  # eV relative to E_Fermi
        "d_band_width": d_width,     # eV
        "d_band_filling": d_filling, # 0-1
    }


def compute_coordination_number(
    structure_dict: dict,
    site_index: int,
    cutoff: float = 3.0,
) -> int:
    """Count nearest neighbors within cutoff distance.

    Args:
        structure_dict: pymatgen-compatible structure dict.
        site_index: Index of the atom to analyze.
        cutoff: Distance cutoff in Angstroms.

    Returns:
        Number of neighbors within cutoff.
    """
    sites = structure_dict.get("sites", [])
    if site_index >= len(sites):
        return 0

    target = sites[site_index]["xyz"]
    count = 0
    for i, site in enumerate(sites):
        if i == site_index:
            continue
        dx = site["xyz"][0] - target[0]
        dy = site["xyz"][1] - target[1]
        dz = site["xyz"][2] - target[2]
        dist = math.sqrt(dx*dx + dy*dy + dz*dz)
        if dist <= cutoff:
            count += 1
    return count


def compute_surface_strain(
    slab_lattice: list[list[float]],
    bulk_lattice: list[list[float]],
) -> dict:
    """Compute in-plane strain of a slab relative to bulk.

    strain = (a_slab - a_bulk) / a_bulk

    Args:
        slab_lattice: 3x3 lattice matrix of slab.
        bulk_lattice: 3x3 lattice matrix of bulk.

    Returns:
        Dict with strain_a, strain_b, strain_avg (percentage).
    """
    def vec_len(v):
        return math.sqrt(sum(x*x for x in v))

    a_slab = vec_len(slab_lattice[0])
    b_slab = vec_len(slab_lattice[1])
    a_bulk = vec_len(bulk_lattice[0])
    b_bulk = vec_len(bulk_lattice[1])

    strain_a = (a_slab - a_bulk) / a_bulk * 100
    strain_b = (b_slab - b_bulk) / b_bulk * 100

    return {
        "strain_a_pct": strain_a,
        "strain_b_pct": strain_b,
        "strain_avg_pct": (strain_a + strain_b) / 2,
    }

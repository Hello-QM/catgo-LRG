"""Analysis functions for COHP data.

Provides filtering, extraction, aggregation, and integration utilities
that operate on the data structures produced by :mod:`catgo_cohp.io`.
"""

from typing import List, Optional, Tuple

import numpy as np

from .io import COHPData, BondInfo, ICOHPEntry


# ---------------------------------------------------------------------------
# Bond listing and filtering
# ---------------------------------------------------------------------------

def list_bonds(data: COHPData, total_only: bool = True) -> List[BondInfo]:
    """List available bonds in the COHP data.

    Parameters
    ----------
    data : COHPData
        Parsed COHP data.
    total_only : bool, optional
        If ``True`` (default), only return total bonds (no orbital-resolved
        pairs). The "Average" column (bond_index=0) is always excluded.

    Returns
    -------
    list of BondInfo
    """
    result: List[BondInfo] = []
    for bond in data.bonds:
        # Skip the Average column
        if bond.bond_index == 0:
            continue
        if total_only and not bond.is_total:
            continue
        result.append(bond)
    return result


def _orbital_type_match(orbital: Optional[str], type_char: str) -> bool:
    """Check whether *orbital* belongs to the given angular-momentum type.

    The *type_char* is one of ``"s"``, ``"p"``, ``"d"``, ``"f"``.  An orbital
    string like ``"2p_x"`` matches ``"p"``; ``"4d_z^2"`` matches ``"d"``.

    Parameters
    ----------
    orbital : str or None
        Orbital name from :class:`BondInfo` (e.g. ``"2s"``, ``"3d_xy"``).
    type_char : str
        Single character: ``"s"``, ``"p"``, ``"d"``, or ``"f"``.

    Returns
    -------
    bool
    """
    if orbital is None:
        return False
    # The orbital string starts with the principal quantum number (one or
    # more digits), followed by the angular-momentum letter.
    # Examples: "2s", "2p_x", "3d_z^2", "4f_xyz"
    # We strip the leading digits and check the first remaining character.
    stripped = orbital.lstrip("0123456789")
    if not stripped:
        return False
    return stripped[0].lower() == type_char.lower()


def filter_bonds(
    data: COHPData,
    bond_indices: Optional[List[int]] = None,
    elements: Optional[Tuple[str, str]] = None,
    atom_pair: Optional[Tuple[str, str]] = None,
    orbital_types: Optional[Tuple[str, str]] = None,
    total_only: bool = False,
) -> List[BondInfo]:
    """Filter bonds by various criteria.

    All criteria that are not ``None`` must be satisfied simultaneously (AND
    logic).  The "Average" column (bond_index=0) is always excluded.

    Parameters
    ----------
    data : COHPData
        Parsed COHP data.
    bond_indices : list of int, optional
        Keep only bonds whose :attr:`BondInfo.bond_index` is in this list.
    elements : (str, str), optional
        Keep only bonds between these two element symbols (order-independent).
        Example: ``("N", "Mo")``.
    atom_pair : (str, str), optional
        Keep only bonds between these two specific atom labels
        (order-independent).  Example: ``("N92", "Mo26")``.
    orbital_types : (str, str), optional
        Keep only orbital-resolved entries where atom1's orbital matches the
        first type and atom2's matches the second, or vice versa.
        Example: ``("p", "d")`` matches ``N[2p_x]->Mo[3d_xy]``.
    total_only : bool, optional
        If ``True``, only return total bonds (no orbital pairs).

    Returns
    -------
    list of BondInfo
    """
    result: List[BondInfo] = []

    for bond in data.bonds:
        # Always skip Average
        if bond.bond_index == 0:
            continue

        # total_only filter
        if total_only and not bond.is_total:
            continue

        # bond_indices filter
        if bond_indices is not None and bond.bond_index not in bond_indices:
            continue

        # elements filter (order-independent)
        if elements is not None:
            pair = {bond.element1, bond.element2}
            target = {elements[0], elements[1]}
            if pair != target:
                continue

        # atom_pair filter (order-independent)
        if atom_pair is not None:
            pair = {bond.atom1, bond.atom2}
            target = {atom_pair[0], atom_pair[1]}
            if pair != target:
                continue

        # orbital_types filter (order-independent)
        if orbital_types is not None:
            if bond.is_total:
                continue  # total bonds have no orbital info
            t1, t2 = orbital_types
            forward = (
                _orbital_type_match(bond.orbital1, t1)
                and _orbital_type_match(bond.orbital2, t2)
            )
            reverse = (
                _orbital_type_match(bond.orbital1, t2)
                and _orbital_type_match(bond.orbital2, t1)
            )
            if not (forward or reverse):
                continue

        result.append(bond)

    return result


# ---------------------------------------------------------------------------
# COHP extraction
# ---------------------------------------------------------------------------

def get_bond_cohp(data: COHPData, bond: BondInfo) -> dict:
    """Get COHP data for a specific bond.

    Parameters
    ----------
    data : COHPData
        Parsed COHP data.
    bond : BondInfo
        Bond whose COHP to extract (must have a valid ``column_index``).

    Returns
    -------
    dict
        ``"energies"`` : np.ndarray of shape ``(npoints,)``
        ``"spin_up"`` : np.ndarray of shape ``(npoints,)``
        ``"spin_down"`` : np.ndarray of shape ``(npoints,)`` (only if nspin=2)
        ``"label"`` : str -- human-readable label
    """
    col = bond.column_index
    if col < 0 or col >= data.ncols:
        raise IndexError(
            f"column_index {col} out of range [0, {data.ncols}) "
            f"for bond {bond.label!r}"
        )

    result = {
        "energies": data.energies.copy(),
        "spin_up": data.cohp[0, col, :].copy(),
        "label": bond.label,
    }
    if data.nspin == 2:
        result["spin_down"] = data.cohp[1, col, :].copy()

    return result


def aggregate_orbital_cohp(
    data: COHPData,
    bond_index: int,
    orbital_filter: Optional[Tuple[str, str]] = None,
) -> dict:
    """Aggregate (sum) orbital-resolved COHP for a given bond.

    Sums over all orbital-pair columns that belong to the specified
    ``bond_index``.  Optionally filters by orbital angular-momentum type.

    Parameters
    ----------
    data : COHPData
        Parsed COHP data.
    bond_index : int
        The 1-based bond number (from ``No.X`` labels) to aggregate.
    orbital_filter : (str, str), optional
        If given, only include orbital pairs matching these angular-momentum
        types (order-independent).  Example: ``("p", "d")``.

    Returns
    -------
    dict
        ``"energies"`` : np.ndarray of shape ``(npoints,)``
        ``"spin_up"`` : np.ndarray of shape ``(npoints,)``
        ``"spin_down"`` : np.ndarray of shape ``(npoints,)`` (only if nspin=2)
        ``"label"`` : str -- descriptive label for the aggregated data
        ``"n_orbitals"`` : int -- number of orbital pairs summed

    Raises
    ------
    ValueError
        If no matching orbital-resolved columns are found.
    """
    # Collect orbital-resolved columns for this bond
    matching_bonds: List[BondInfo] = []
    for bond in data.bonds:
        if bond.bond_index != bond_index:
            continue
        if bond.is_total:
            continue  # skip the total-bond column

        if orbital_filter is not None:
            t1, t2 = orbital_filter
            forward = (
                _orbital_type_match(bond.orbital1, t1)
                and _orbital_type_match(bond.orbital2, t2)
            )
            reverse = (
                _orbital_type_match(bond.orbital1, t2)
                and _orbital_type_match(bond.orbital2, t1)
            )
            if not (forward or reverse):
                continue

        matching_bonds.append(bond)

    if not matching_bonds:
        filter_desc = (
            f" with orbital_filter={orbital_filter}" if orbital_filter else ""
        )
        raise ValueError(
            f"No orbital-resolved columns found for bond_index={bond_index}"
            f"{filter_desc}"
        )

    # Sum the COHP values
    spin_up = np.zeros(data.npoints, dtype=np.float64)
    spin_down = np.zeros(data.npoints, dtype=np.float64) if data.nspin == 2 else None

    for bond in matching_bonds:
        spin_up += data.cohp[0, bond.column_index, :]
        if data.nspin == 2:
            spin_down += data.cohp[1, bond.column_index, :]

    # Build a descriptive label
    # Find the total bond for this index to get atom names
    total_bond = None
    for bond in data.bonds:
        if bond.bond_index == bond_index and bond.is_total:
            total_bond = bond
            break

    if total_bond is not None:
        base_label = f"{total_bond.atom1}-{total_bond.atom2}"
    else:
        # Fall back to first matching orbital bond
        b = matching_bonds[0]
        base_label = f"{b.atom1}-{b.atom2}"

    if orbital_filter is not None:
        label = f"{base_label} ({orbital_filter[0]}-{orbital_filter[1]})"
    else:
        label = f"{base_label} (all orbitals)"

    result = {
        "energies": data.energies.copy(),
        "spin_up": spin_up,
        "label": label,
        "n_orbitals": len(matching_bonds),
    }
    if data.nspin == 2:
        result["spin_down"] = spin_down

    return result


# ---------------------------------------------------------------------------
# Integration
# ---------------------------------------------------------------------------

def integrate_cohp(
    energies: np.ndarray,
    cohp_values: np.ndarray,
    emin: Optional[float] = None,
    emax: Optional[float] = None,
) -> float:
    """Integrate COHP over an energy range using the trapezoidal rule.

    Parameters
    ----------
    energies : np.ndarray
        Energy grid, shape ``(npoints,)``.
    cohp_values : np.ndarray
        COHP values on the same grid, shape ``(npoints,)``.
    emin : float, optional
        Lower bound of integration. Defaults to the minimum energy in the grid.
    emax : float, optional
        Upper bound of integration. Defaults to 0.0 (the Fermi level).

    Returns
    -------
    float
        Integrated COHP value.

    Notes
    -----
    The function selects grid points within ``[emin, emax]`` and applies
    :func:`numpy.trapz`.  For accuracy, the energy grid should be
    sufficiently dense.
    """
    if emin is None:
        emin = float(energies.min())
    if emax is None:
        emax = 0.0

    mask = (energies >= emin) & (energies <= emax)
    if not np.any(mask):
        return 0.0

    return float(np.trapz(cohp_values[mask], energies[mask]))


def get_bond_icohp(data: COHPData, bond: BondInfo) -> dict:
    """Get ICOHP data for a specific bond from the parsed ICOHP array.

    The COHPCAR file stores both COHP and ICOHP columns; this function
    reads the pre-parsed ICOHP values directly rather than re-integrating.

    Parameters
    ----------
    data : COHPData
        Parsed COHP data.
    bond : BondInfo
        Bond whose ICOHP to extract.

    Returns
    -------
    dict
        ``"energies"`` : np.ndarray of shape ``(npoints,)``
        ``"spin_up"`` : np.ndarray of shape ``(npoints,)``
        ``"spin_down"`` : np.ndarray of shape ``(npoints,)`` (only if nspin=2)
        ``"label"`` : str
        ``"icohp_at_ef"`` : float -- total ICOHP at the Fermi level (sum of spins)
    """
    col = bond.column_index
    if col < 0 or col >= data.ncols:
        raise IndexError(
            f"column_index {col} out of range [0, {data.ncols}) "
            f"for bond {bond.label!r}"
        )

    # Find the energy point closest to E_f = 0
    ef_idx = int(np.argmin(np.abs(data.energies)))
    icohp_at_ef = float(data.icohp[0, col, ef_idx])
    if data.nspin == 2:
        icohp_at_ef += float(data.icohp[1, col, ef_idx])

    result = {
        "energies": data.energies.copy(),
        "spin_up": data.icohp[0, col, :].copy(),
        "label": bond.label,
        "icohp_at_ef": icohp_at_ef,
    }
    if data.nspin == 2:
        result["spin_down"] = data.icohp[1, col, :].copy()

    return result

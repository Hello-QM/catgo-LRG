"""Atom selection utilities for DOS analysis.

All atom indices are **0-based** throughout this module.
"""

from __future__ import annotations

import re
from typing import List, Optional, Sequence, Union

import numpy as np


def select_by_element(
    elements: Union[np.ndarray, Sequence[str]],
    target: Union[str, List[str]],
) -> List[int]:
    """Select atom indices matching one or more element symbols.

    Parameters
    ----------
    elements : array-like of str
        Per-ion element symbols.
    target : str or list[str]
        Element(s) to select, e.g. ``"Mo"`` or ``["Mo", "S"]``.
    """
    if isinstance(target, str):
        target = [t.strip() for t in target.split(",") if t.strip()]
    target_set = set(target)
    elems = list(elements) if isinstance(elements, np.ndarray) else elements
    return [i for i, e in enumerate(elems) if e in target_set]


def select_by_index(
    spec: str,
    nions: int,
    *,
    one_based: bool = False,
) -> List[int]:
    """Parse an index specification string to atom indices.

    Parameters
    ----------
    spec : str
        Comma- or space-separated ranges, e.g. ``"0,2,5"`` or ``"2-5,8-10"``.
    nions : int
        Total number of ions (for bounds checking).
    one_based : bool
        If True, interpret numbers as 1-based (VASP convention).

    Returns
    -------
    list[int]
        Sorted unique 0-based indices.
    """
    spec = spec.strip()
    if not spec:
        raise ValueError("Empty atom selection spec.")
    parts = re.split(r"[,\s]+", spec)
    idx: set[int] = set()
    for p in parts:
        if not p:
            continue
        if "-" in p:
            a_s, b_s = p.split("-", 1)
            a, b = int(a_s), int(b_s)
            if a > b:
                a, b = b, a
            for i in range(a, b + 1):
                idx.add(i - 1 if one_based else i)
        else:
            v = int(p)
            idx.add(v - 1 if one_based else v)
    result = sorted(idx)
    if any(i < 0 or i >= nions for i in result):
        raise ValueError(
            f"Atom index out of range [0, {nions - 1}]. "
            f"Got {result[:20]}{'...' if len(result) > 20 else ''}"
        )
    return result


def select_top_layer(
    positions: np.ndarray,
    atoms: List[int],
    z_thickness: float,
) -> List[int]:
    """Keep atoms within *z_thickness* of the maximum z coordinate.

    Parameters
    ----------
    positions : ndarray, shape (N, 3)
        Cartesian positions.
    atoms : list[int]
        Candidate atom indices.
    z_thickness : float
        Angstrom thickness from the top.
    """
    if not atoms:
        return []
    z = positions[atoms, 2]
    zmax = float(np.max(z))
    thresh = zmax - z_thickness
    return [a for a, zi in zip(atoms, z.tolist()) if zi >= thresh]


def select_bottom_layer(
    positions: np.ndarray,
    atoms: List[int],
    z_thickness: float,
) -> List[int]:
    """Keep atoms within *z_thickness* of the minimum z coordinate."""
    if not atoms:
        return []
    z = positions[atoms, 2]
    zmin = float(np.min(z))
    thresh = zmin + z_thickness
    return [a for a, zi in zip(atoms, z.tolist()) if zi <= thresh]


def select_within_radius(
    positions: np.ndarray,
    atoms: List[int],
    center: np.ndarray,
    radius: float,
) -> List[int]:
    """Keep atoms within *radius* Angstrom of a given center point.

    Parameters
    ----------
    positions : ndarray, shape (N, 3)
        Cartesian positions.
    atoms : list[int]
        Candidate atom indices.
    center : ndarray, shape (3,)
        Center point in Cartesian coordinates.
    radius : float
        Cutoff radius in Angstrom.
    """
    if not atoms:
        return []
    p = positions[atoms]
    d = np.linalg.norm(p - center[None, :], axis=1)
    return [a for a, di in zip(atoms, d.tolist()) if di <= radius]


def select_within_radius_of_atom(
    positions: np.ndarray,
    atoms: List[int],
    center_atom: int,
    radius: float,
) -> List[int]:
    """Keep atoms within *radius* of a specific atom."""
    center = positions[center_atom]
    return select_within_radius(positions, atoms, center, radius)


def combine_selections(
    *selections: List[int],
    mode: str = "union",
) -> List[int]:
    """Combine multiple atom selections.

    Parameters
    ----------
    *selections : list[int]
        Atom index lists.
    mode : str
        ``"union"`` or ``"intersection"``.
    """
    if not selections:
        return []
    sets = [set(s) for s in selections]
    if mode == "union":
        combined = set().union(*sets)
    elif mode == "intersection":
        combined = sets[0].intersection(*sets[1:])
    else:
        raise ValueError(f"Unknown mode {mode!r}, expected 'union' or 'intersection'")
    return sorted(combined)

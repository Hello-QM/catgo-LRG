"""Orbital channel mapping for VASP projectors.

VASP projector channel order (LORBIT >= 10):
    s  py  pz  px  dxy  dyz  dz2  dxz  dx2-y2  [f1..f7]

Index:  0   1   2   3    4    5    6    7     8   [9..15]
"""

from __future__ import annotations

from typing import Dict, List, Tuple

# Canonical channel layout per angular momentum quantum number l.
# Each entry is (channel_index, orbital_name).
CHANNEL_MAP_9: Dict[int, List[Tuple[int, str]]] = {
    0: [(0, "s")],
    1: [(1, "py"), (2, "pz"), (3, "px")],
    2: [(4, "dxy"), (5, "dyz"), (6, "dz2"), (7, "dxz"), (8, "dx2-y2")],
}

CHANNEL_MAP_16: Dict[int, List[Tuple[int, str]]] = {
    **CHANNEL_MAP_9,
    3: [(9 + i, f"f{i + 1}") for i in range(7)],
}

L_LABELS = {0: "s", 1: "p", 2: "d", 3: "f"}


def channel_map(nchannels: int) -> Dict[int, List[Tuple[int, str]]]:
    """Return the full channel map for a given number of projector channels."""
    if nchannels >= 16:
        return CHANNEL_MAP_16
    return CHANNEL_MAP_9


def channel_indices(l: int, nchannels: int = 9) -> List[int]:
    """Return the projector channel indices for angular momentum *l*.

    Parameters
    ----------
    l : int
        Angular momentum quantum number (0=s, 1=p, 2=d, 3=f).
    nchannels : int
        Total number of projector channels (9 or 16).
    """
    cmap = channel_map(nchannels)
    if l not in cmap:
        raise ValueError(f"Angular momentum l={l} not available (nchannels={nchannels})")
    return [idx for idx, _ in cmap[l]]


def d_indices(nchannels: int = 9) -> List[int]:
    """Shorthand for d-channel indices (l=2)."""
    return channel_indices(2, nchannels)


def s_indices(nchannels: int = 9) -> List[int]:
    """Shorthand for s-channel indices (l=0)."""
    return channel_indices(0, nchannels)


def p_indices(nchannels: int = 9) -> List[int]:
    """Shorthand for p-channel indices (l=1)."""
    return channel_indices(1, nchannels)


def f_indices(nchannels: int = 16) -> List[int]:
    """Shorthand for f-channel indices (l=3).  Requires nchannels >= 16."""
    return channel_indices(3, nchannels)


def channel_name_map(nchannels: int) -> Dict[int, str]:
    """Return {channel_index: orbital_name} for all channels."""
    cmap = channel_map(nchannels)
    return {idx: name for chans in cmap.values() for idx, name in chans}


def parse_orbital_spec(spec: str, nchannels: int = 9) -> List[int]:
    """Parse a human-readable orbital specification to channel indices.

    Accepted formats:
        ``"d"``      -> all d channels
        ``"s,p"``    -> all s and p channels
        ``"dxy,dz2"``  -> specific m channels
        ``"d-all"``  -> same as "d"
        ``"4,5,6"``  -> explicit integer indices

    Parameters
    ----------
    spec : str
        Comma-separated orbital specification.
    nchannels : int
        Total projector channels.

    Returns
    -------
    list[int]
        Sorted unique channel indices.
    """
    cmap = channel_map(nchannels)
    name_to_idx = {name.lower(): idx for idx, name in channel_name_map(nchannels).items()}
    l_by_name = {"s": 0, "p": 1, "d": 2, "f": 3}

    result: set[int] = set()
    items = [x.strip().lower() for x in spec.split(",") if x.strip()]

    for item in items:
        # Try as integer
        try:
            result.add(int(item))
            continue
        except ValueError:
            pass

        # "d-all" style
        if item.endswith("-all"):
            key = item.split("-", 1)[0]
            if key in l_by_name and l_by_name[key] in cmap:
                result.update(idx for idx, _ in cmap[l_by_name[key]])
                continue

        # Single letter = whole shell
        if item in l_by_name and l_by_name[item] in cmap:
            result.update(idx for idx, _ in cmap[l_by_name[item]])
            continue

        # Specific orbital name
        if item in name_to_idx:
            result.add(name_to_idx[item])
            continue

        raise ValueError(f"Unknown orbital specifier: {item!r}")

    return sorted(result)

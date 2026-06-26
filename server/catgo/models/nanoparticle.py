"""Nanoparticle / cluster builder — wraps ``ase.cluster``.

Builds finite metal clusters (no input structure needed) and returns a pymatgen
``Structure`` centred in a vacuum box so it round-trips through the rest of the
pipeline / viewer.

Shapes:
* ``wulff``      — Wulff construction from per-facet surface energies (the
  equilibrium shape); the general-purpose option.
* ``octahedron`` — regular/truncated octahedron (``length`` shells, ``cutoff``).
* ``icosahedron``— Mackay icosahedron (``shells``).
* ``decahedron`` — Marks decahedron (``p``, ``q``, ``r``).
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class NanoparticleParams:
    element: str
    shape: str = "wulff"
    # wulff
    structure: str = "fcc"            # fcc | bcc | sc | hcp
    size: int = 100                   # target atom count (wulff)
    surfaces: list = field(default_factory=lambda: [(1, 1, 1), (1, 0, 0), (1, 1, 0)])
    energies: list = field(default_factory=lambda: [1.0, 1.1, 1.2])
    rounding: str = "closest"         # closest | above | below
    # octahedron
    length: int = 5
    cutoff: int = 0
    # icosahedron
    shells: int = 3
    # decahedron
    p: int = 3
    q: int = 3
    r: int = 0
    # common
    lattice_constant: float = 0.0     # 0 = ASE default for the element
    vacuum: float = 10.0              # padding around the cluster (Å)


def _to_structure(atoms, vacuum: float):
    """Centre the cluster in a cubic vacuum box → pymatgen Structure."""
    atoms = atoms.copy()
    atoms.center(vacuum=vacuum)
    from pymatgen.io.ase import AseAtomsAdaptor

    return AseAtomsAdaptor.get_structure(atoms)


def build_nanoparticle(params: NanoparticleParams):
    """Build the cluster and return a pymatgen ``Structure``."""
    from ase.cluster import (
        Decahedron,
        Icosahedron,
        Octahedron,
        wulff_construction,
    )

    lc = params.lattice_constant or None
    shape = params.shape.lower()

    if shape == "wulff":
        if len(params.surfaces) != len(params.energies):
            raise ValueError(
                f"surfaces ({len(params.surfaces)}) and energies "
                f"({len(params.energies)}) must have equal length"
            )
        atoms = wulff_construction(
            params.element,
            surfaces=[tuple(s) for s in params.surfaces],
            energies=list(params.energies),
            size=int(params.size),
            structure=params.structure,
            rounding=params.rounding,
            latticeconstant=lc,
        )
    elif shape == "octahedron":
        atoms = Octahedron(
            params.element,
            length=int(params.length),
            cutoff=int(params.cutoff),
            latticeconstant=lc,
        )
    elif shape == "icosahedron":
        atoms = Icosahedron(
            params.element,
            noshells=int(params.shells),
            latticeconstant=lc,
        )
    elif shape == "decahedron":
        atoms = Decahedron(
            params.element,
            p=int(params.p),
            q=int(params.q),
            r=int(params.r),
            latticeconstant=lc,
        )
    else:
        raise ValueError(
            f"unknown shape '{params.shape}' "
            "(wulff | octahedron | icosahedron | decahedron)"
        )

    if len(atoms) == 0:
        raise ValueError("nanoparticle build produced 0 atoms — check parameters")

    return _to_structure(atoms, params.vacuum)

"""Convert between CatGo/Pymatgen structure format and ASE Atoms."""

import re

import numpy as np
from ase import Atoms

from catgo.models.structure import Lattice, PymatgenStructure, Site, Species


def _clean_element_symbol(raw: str) -> str:
    """Strip oxidation-state suffixes (e.g. 'H0+' -> 'H', 'O2-' -> 'O')."""
    m = re.match(r"[A-Z][a-z]?", raw)
    return m.group() if m else raw


def pymatgen_to_ase(structure: PymatgenStructure) -> Atoms:
    """Convert PymatgenStructure to ASE Atoms object.

    For molecules without lattice (XYZ files without PBC), creates an
    ASE Atoms object without periodic boundary conditions.
    """
    # Extract symbols from species
    symbols = []
    for site in structure.sites:
        # Use the first species with highest occupancy
        main_species = max(site.species, key=lambda s: s.occu)
        symbols.append(_clean_element_symbol(main_species.element))

    # Extract positions (use Cartesian xyz)
    positions = np.array([site.xyz for site in structure.sites])

    # Handle structures without lattice (isolated molecules)
    if structure.lattice is None:
        # No lattice - treat as isolated molecule without PBC
        return Atoms(
            symbols=symbols,
            positions=positions,
            pbc=False,
        )

    # Extract lattice matrix
    cell = np.array(structure.lattice.matrix)

    # Get PBC
    pbc = structure.lattice.pbc or [True, True, True]

    return Atoms(
        symbols=symbols,
        positions=positions,
        cell=cell,
        pbc=pbc,
    )


def ase_to_pymatgen(atoms: Atoms, include_forces: bool = True) -> PymatgenStructure:
    """Convert ASE Atoms object back to PymatgenStructure.

    Args:
        atoms: ASE Atoms object
        include_forces: If True and atoms has a calculator, include forces in site properties

    For molecules without PBC (pbc=False or no cell), returns a structure
    without lattice information.
    """
    cell = atoms.get_cell()
    positions = atoms.get_positions()
    symbols = atoms.get_chemical_symbols()

    # Check if this is a molecule without periodic boundary conditions
    has_cell = cell is not None and cell.volume > 0.01
    has_pbc = any(atoms.pbc) if hasattr(atoms, 'pbc') else False
    is_periodic = has_cell and has_pbc

    # Build lattice only for periodic structures
    lattice = None
    if is_periodic:
        # Calculate lattice parameters
        a, b, c = cell.lengths()
        alpha, beta, gamma = cell.angles()
        volume = cell.volume

        lattice = Lattice(
            matrix=cell.tolist(),
            a=float(a),
            b=float(b),
            c=float(c),
            alpha=float(alpha),
            beta=float(beta),
            gamma=float(gamma),
            volume=float(volume),
            pbc=list(atoms.pbc),
        )

    # Get scaled positions (fractional coords) only if we have a lattice
    # wrap=False preserves actual positions — critical for molecules near
    # cell boundaries (e.g., water H atoms) where wrapping would teleport
    # atoms to the opposite side of the cell, breaking molecular geometry.
    if is_periodic:
        scaled_positions = atoms.get_scaled_positions(wrap=False)
    else:
        # For molecules, use Cartesian positions as "fractional" coords
        scaled_positions = positions

    # Get forces if available and requested
    forces = None
    energy = None
    if include_forces and atoms.calc is not None:
        try:
            forces = atoms.get_forces()
            energy = float(atoms.get_potential_energy())
        except Exception:
            pass  # Calculator might not support forces/energy

    sites = []
    for i, symbol in enumerate(symbols):
        # Build site properties
        properties = {}
        if forces is not None:
            properties["force"] = forces[i].tolist()  # [fx, fy, fz] for CatGo visualization

        site = Site(
            species=[Species(element=symbol, occu=1.0)],
            abc=scaled_positions[i].tolist(),
            xyz=positions[i].tolist(),
            label=symbol,
            properties=properties if properties else None,
        )
        sites.append(site)

    structure = PymatgenStructure(lattice=lattice, sites=sites)

    # Store energy as structure-level property (CatGo can display this)
    if energy is not None:
        structure.energy = energy  # type: ignore

    return structure

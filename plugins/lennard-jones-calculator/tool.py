"""Lennard-Jones pair potential calculator for noble gases — Tool-First format."""

# Lennard-Jones parameters (epsilon in eV, sigma in Angstrom)
LJ_PARAMS = {
    "Ar": {"epsilon": 0.0104, "sigma": 3.40},
    "Kr": {"epsilon": 0.0140, "sigma": 3.60},
    "Xe": {"epsilon": 0.0200, "sigma": 3.98},
    "Ne": {"epsilon": 0.0031, "sigma": 2.74},
    "He": {"epsilon": 0.0009, "sigma": 2.56},
}

TOOL = {
    "name": "lennard_jones",
    "display_name": "Lennard-Jones",
    "description": "Lennard-Jones pair potential for noble gases",
    "category": "calculator",
    "input_schema": {
        "type": "object",
        "properties": {
            "cutoff": {
                "type": "number",
                "default": 10.0,
                "minimum": 3.0,
                "maximum": 20.0,
                "description": "Cutoff radius for pair interactions (Angstrom)",
            },
        },
    },
    "output_type": "structure",
    "supported_elements": list(LJ_PARAMS.keys()),
    "version": "1.0.0",
    "author": "CatGo Team",
}


def get_calculator(cutoff: float = 10.0, **kwargs):
    """Return an ASE LennardJones calculator.

    Args:
        cutoff: Cutoff radius in Angstrom (default: 10.0)

    Returns:
        ASE Calculator instance
    """
    from ase.calculators.lj import LennardJones

    return LennardJones(
        epsilon=0.0104,  # Use Ar as default
        sigma=3.40,
        rc=cutoff,
    )


async def execute(context):
    """Create a LJ calculator and compute energy/forces for the structure."""
    from ase import Atoms
    from pymatgen.core import Structure

    structure = context["structure"]
    params = context.get("params", {})
    cutoff = params.get("cutoff", 10.0)

    struct = Structure.from_dict(structure) if isinstance(structure, dict) else structure

    # Convert to ASE Atoms
    atoms = Atoms(
        symbols=[str(s) for s in struct.species],
        positions=struct.cart_coords,
        cell=struct.lattice.matrix if struct.lattice else None,
        pbc=True if struct.lattice else False,
    )

    calc = get_calculator(cutoff=cutoff)
    atoms.calc = calc

    energy = atoms.get_potential_energy()
    forces = atoms.get_forces()

    return {
        "energy": float(energy),
        "forces": forces.tolist(),
        "calculator": "lennard_jones",
        "params": {"cutoff": cutoff},
    }

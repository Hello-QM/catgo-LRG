"""
Lennard-Jones Calculator Plugin for CatGo

A simple example of a backend calculator plugin using the Lennard-Jones
potential for noble gas atoms (Ar, Kr, Xe).

This plugin demonstrates:
- How to create a CalculatorPlugin
- Defining supported elements
- Parameter schemas for UI generation
- Creating an ASE-compatible calculator
"""

from typing import Optional

# Import the base class from the plugins package
# When installed, this would be: from catgo.plugins import CalculatorPlugin
import sys
from pathlib import Path

# Add server directory to path for development
server_dir = Path(__file__).parent.parent.parent.parent / "server"
if server_dir.exists():
    sys.path.insert(0, str(server_dir))

try:
    from plugins.base import CalculatorPlugin
except ImportError:
    # Fallback for standalone testing
    from abc import ABC, abstractmethod

    class CalculatorPlugin(ABC):
        name: str
        calculator_id: str
        display_name: str
        description: str
        version: str
        author: str
        supported_elements: Optional[list[str]] = None

        @abstractmethod
        def get_calculator(self, **kwargs):
            pass


# Lennard-Jones parameters (epsilon in eV, sigma in Angstrom)
LJ_PARAMS = {
    "Ar": {"epsilon": 0.0104, "sigma": 3.40},
    "Kr": {"epsilon": 0.0140, "sigma": 3.60},
    "Xe": {"epsilon": 0.0200, "sigma": 3.98},
    "Ne": {"epsilon": 0.0031, "sigma": 2.74},
    "He": {"epsilon": 0.0009, "sigma": 2.56},
}


class LennardJonesPlugin(CalculatorPlugin):
    """
    Lennard-Jones potential calculator for noble gases.

    The LJ potential is: V(r) = 4*epsilon * [(sigma/r)^12 - (sigma/r)^6]

    This is a simple pair potential useful for:
    - Noble gas simulations
    - Testing and demonstrations
    - Quick structural relaxations
    """

    name = "lennard-jones"
    calculator_id = "lennard_jones"
    display_name = "Lennard-Jones"
    description = "Lennard-Jones pair potential for noble gases"
    version = "1.0.0"
    author = "CatGo Team"

    # Only support noble gases
    supported_elements = list(LJ_PARAMS.keys())

    def get_calculator(self, cutoff: float = 10.0, **kwargs):
        """
        Return an ASE LennardJones calculator.

        Args:
            cutoff: Cutoff radius in Angstrom (default: 10.0)

        Returns:
            ASE Calculator instance
        """
        from ase.calculators.lj import LennardJones

        # Create the calculator with our parameters
        return LennardJones(
            epsilon=0.0104,  # Use Ar as default
            sigma=3.40,
            rc=cutoff,
        )

    def get_parameter_schema(self) -> dict:
        """
        Return JSON schema for calculator parameters.

        This schema is used by the frontend to generate
        parameter input forms.
        """
        return {
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
        }


# For testing
if __name__ == "__main__":
    plugin = LennardJonesPlugin()
    print(f"Plugin: {plugin.display_name}")
    print(f"Supported elements: {plugin.supported_elements}")
    print(f"Parameters: {plugin.get_parameter_schema()}")

    # Test calculator
    try:
        from ase import Atoms

        # Create a simple Ar dimer
        atoms = Atoms("Ar2", positions=[[0, 0, 0], [3.8, 0, 0]])
        calc = plugin.get_calculator()
        atoms.calc = calc

        energy = atoms.get_potential_energy()
        forces = atoms.get_forces()

        print(f"\nAr dimer test:")
        print(f"  Energy: {energy:.4f} eV")
        print(f"  Forces: {forces}")
    except ImportError:
        print("\nASE not installed, skipping calculator test")

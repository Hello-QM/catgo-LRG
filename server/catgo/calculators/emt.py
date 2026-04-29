"""EMT (Effective Medium Theory) calculator - fast, for metals only."""

from ase.calculators.emt import EMT

from .base import BaseCalculator


class EMTCalculator(BaseCalculator):
    """EMT calculator for metallic systems.

    Fast but only supports: Al, Ni, Cu, Pd, Ag, Pt, Au
    Good for testing and demonstration.
    """

    name = "emt"
    description = "Effective Medium Theory - fast calculator for FCC metals"
    supported_elements = ["Al", "Ni", "Cu", "Pd", "Ag", "Pt", "Au"]

    def get_calculator(self) -> EMT:
        return EMT()

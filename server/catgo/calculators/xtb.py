"""xTB semi-empirical tight-binding calculator.

xTB (extended tight-binding) is a fast and accurate semi-empirical method
developed by the Grimme group. It supports molecules and periodic systems.

This implementation uses:
- tblite for GFN2-xTB, GFN1-xTB, IPEA1-xTB (preferred, faster)
- xtb CLI for GFN0-xTB, GFN-FF (not available in tblite)

Methods available:
- GFN2-xTB: Most accurate, default choice (anisotropic electrostatics + D4 dispersion)
- GFN1-xTB: Faster, isotropic electrostatics
- GFN0-xTB: Fastest TB method (CLI only)
- GFN-FF: Force field, very fast (CLI only)
- IPEA1-xTB: Specialized for ionization potentials and electron affinities

Installation:
    mamba install tblite tblite-python xtb

Reference: https://github.com/grimme-lab/xtb
Documentation: https://tblite.readthedocs.io/
"""

from .base import BaseCalculator


# Elements supported by GFN2-xTB (H-Rn, Z=1-86)
XTB_SUPPORTED_ELEMENTS = [
    "H", "He",
    "Li", "Be", "B", "C", "N", "O", "F", "Ne",
    "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
    "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
    "Ga", "Ge", "As", "Se", "Br", "Kr",
    "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
    "In", "Sn", "Sb", "Te", "I", "Xe",
    "Cs", "Ba",
    "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu",
    "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
    "Tl", "Pb", "Bi", "Po", "At", "Rn",
]

# Methods that require CLI (not available in tblite)
CLI_ONLY_METHODS = {"GFN0-XTB", "GFN0", "GFN-FF", "GFNFF"}

# Methods available in tblite
TBLITE_METHODS = {"GFN2-XTB", "GFN2", "GFN1-XTB", "GFN1", "IPEA1-XTB", "IPEA1"}


class XTBCalculator(BaseCalculator):
    """xTB semi-empirical tight-binding calculator.

    Automatically selects between tblite (for GFN2/GFN1/IPEA1) and
    xtb CLI (for GFN0/GFN-FF) based on the requested method.

    Fast and accurate for molecules and periodic systems.
    Particularly good for organic molecules and organometallic compounds.
    """

    name = "xtb"
    description = "xTB tight-binding (GFN2/GFN1/GFN0/GFN-FF) - fast for molecules and crystals"
    supported_elements = XTB_SUPPORTED_ELEMENTS

    def __init__(
        self,
        method: str = "GFN2-xTB",
        accuracy: float = 1.0,
        electronic_temperature: float = 300.0,
        max_iterations: int = 250,
        cache_api: bool = True,
    ):
        """Initialize xTB calculator.

        Args:
            method: xTB method - "GFN2-xTB" (default), "GFN1-xTB", "GFN0-xTB", "GFN-FF", or "IPEA1-xTB"
            accuracy: Numerical accuracy for calculations (default 1.0)
            electronic_temperature: Electronic temperature in K for Fermi smearing (default 300.0)
            max_iterations: Maximum SCF iterations (default 250)
            cache_api: Whether to cache the API objects for performance (default True, tblite only)
        """
        self.method = method
        self.accuracy = accuracy
        self.electronic_temperature = electronic_temperature
        self.max_iterations = max_iterations
        self.cache_api = cache_api

    def _use_cli(self) -> bool:
        """Check if we need to use CLI for this method."""
        return self.method.upper() in CLI_ONLY_METHODS

    def get_calculator(self):
        """Return an ASE calculator instance (tblite or CLI based on method)."""
        if self._use_cli():
            # Use CLI for GFN0 and GFN-FF
            from .xtb_cli import XTBCliCalculator

            return XTBCliCalculator(
                method=self.method,
                accuracy=self.accuracy,
                electronic_temperature=self.electronic_temperature,
                max_iterations=self.max_iterations,
            )
        else:
            # Use tblite for GFN2, GFN1, IPEA1
            from tblite.ase import TBLite

            return TBLite(
                method=self.method,
                accuracy=self.accuracy,
                electronic_temperature=self.electronic_temperature,
                max_iterations=self.max_iterations,
                cache_api=self.cache_api,
            )

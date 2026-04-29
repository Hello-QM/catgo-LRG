"""xTB command-line calculator wrapper for ASE.

This calculator runs the xtb binary directly, supporting all xTB methods
including GFN-FF which is not available in tblite.

Supported methods:
- GFN2-xTB (--gfn 2): Most accurate, default
- GFN1-xTB (--gfn 1): Faster
- GFN0-xTB (--gfn 0): Fastest TB method
- GFN-FF (--gfnff): Force field, very fast

Installation:
    mamba install xtb
"""

import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from ase import Atoms
from ase.calculators.calculator import Calculator, all_changes
from ase.io import write as ase_write

from .base import BaseCalculator


# Supported elements (same as tblite, H-Rn)
XTB_CLI_SUPPORTED_ELEMENTS = [
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


class XTBCliCalculator(Calculator):
    """ASE Calculator that wraps the xtb command-line program."""

    implemented_properties = ["energy", "forces"]

    def __init__(
        self,
        method: str = "GFN2-xTB",
        accuracy: float = 1.0,
        electronic_temperature: float = 300.0,
        max_iterations: int = 250,
        xtb_command: str = "xtb",
        **kwargs
    ):
        """Initialize xTB CLI calculator.

        Args:
            method: xTB method - "GFN2-xTB", "GFN1-xTB", "GFN0-xTB", or "GFN-FF"
            accuracy: Numerical accuracy (default 1.0)
            electronic_temperature: Electronic temperature in K (default 300.0)
            max_iterations: Maximum SCF iterations (default 250)
            xtb_command: Path to xtb executable (default "xtb")
        """
        super().__init__(**kwargs)
        self.method = method
        self.accuracy = accuracy
        self.electronic_temperature = electronic_temperature
        self.max_iterations = max_iterations
        self.xtb_command = xtb_command

    def _get_method_flags(self) -> list[str]:
        """Get xtb command-line flags for the selected method."""
        method_upper = self.method.upper()
        if method_upper in ("GFN2-XTB", "GFN2"):
            return ["--gfn", "2"]
        elif method_upper in ("GFN1-XTB", "GFN1"):
            return ["--gfn", "1"]
        elif method_upper in ("GFN0-XTB", "GFN0"):
            return ["--gfn", "0"]
        elif method_upper in ("GFN-FF", "GFNFF"):
            return ["--gfnff"]
        else:
            # Default to GFN2
            return ["--gfn", "2"]

    def calculate(
        self,
        atoms: Atoms = None,
        properties: list[str] = None,
        system_changes: list[str] = all_changes,
    ):
        """Run xTB calculation."""
        if properties is None:
            properties = self.implemented_properties

        super().calculate(atoms, properties, system_changes)

        # Create temporary directory for calculation
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)

            # Write structure to xyz file
            xyz_file = tmpdir / "input.xyz"
            ase_write(str(xyz_file), atoms, format="xyz")

            # Build xtb command
            cmd = [self.xtb_command, str(xyz_file)]
            cmd.extend(self._get_method_flags())
            cmd.extend(["--grad"])  # Request gradient calculation
            cmd.extend(["--acc", str(self.accuracy)])

            # Only add etemp for non-FF methods
            if "FF" not in self.method.upper():
                cmd.extend(["--etemp", str(self.electronic_temperature)])
                cmd.extend(["--iterations", str(self.max_iterations)])

            # Run xtb
            try:
                result = subprocess.run(
                    cmd,
                    cwd=str(tmpdir),
                    capture_output=True,
                    text=True,
                    timeout=300,  # 5 minute timeout
                )
            except subprocess.TimeoutExpired:
                raise RuntimeError("xTB calculation timed out")
            except FileNotFoundError:
                raise RuntimeError(f"xTB executable not found: {self.xtb_command}")

            if result.returncode != 0:
                raise RuntimeError(f"xTB calculation failed:\n{result.stderr}")

            # Parse energy from output
            energy = self._parse_energy(result.stdout)

            # Parse forces from gradient file
            gradient_file = tmpdir / "gradient"
            forces = self._parse_gradient(gradient_file, len(atoms))

            # Store results (convert to eV and eV/Angstrom)
            self.results["energy"] = energy * 27.211386245988  # Hartree to eV
            self.results["forces"] = forces * 27.211386245988 / 0.529177210903  # Hartree/Bohr to eV/Angstrom

    def _parse_energy(self, output: str) -> float:
        """Parse total energy from xtb output (in Hartree)."""
        for line in output.split("\n"):
            if "TOTAL ENERGY" in line:
                parts = line.split()
                for i, part in enumerate(parts):
                    if part == "TOTAL" and i + 2 < len(parts):
                        try:
                            return float(parts[i + 2])
                        except (ValueError, IndexError):
                            continue
        raise RuntimeError("Could not parse energy from xTB output")

    def _parse_gradient(self, gradient_file: Path, n_atoms: int) -> np.ndarray:
        """Parse gradient from xtb gradient file."""
        if not gradient_file.exists():
            raise RuntimeError("Gradient file not found")

        with open(gradient_file) as f:
            lines = f.readlines()

        # Find gradient section (after $grad)
        grad_start = None
        for i, line in enumerate(lines):
            if "$grad" in line:
                grad_start = i + 1 + n_atoms  # Skip coordinates
                break

        if grad_start is None:
            raise RuntimeError("Could not find gradient section in gradient file")

        # Parse gradients
        gradients = []
        for i in range(n_atoms):
            line = lines[grad_start + i]
            parts = line.split()
            grad = [float(x.replace("D", "E")) for x in parts[:3]]
            gradients.append(grad)

        # Forces are negative gradient
        return -np.array(gradients)


class XTBCLICalculatorWrapper(BaseCalculator):
    """Wrapper for xTB CLI calculator for CatGo server."""

    name = "xtb-cli"
    description = "xTB command-line (supports GFN-FF) - fast force field and tight-binding"
    supported_elements = XTB_CLI_SUPPORTED_ELEMENTS

    def __init__(
        self,
        method: str = "GFN2-xTB",
        accuracy: float = 1.0,
        electronic_temperature: float = 300.0,
        max_iterations: int = 250,
    ):
        self.method = method
        self.accuracy = accuracy
        self.electronic_temperature = electronic_temperature
        self.max_iterations = max_iterations

    def get_calculator(self):
        return XTBCliCalculator(
            method=self.method,
            accuracy=self.accuracy,
            electronic_temperature=self.electronic_temperature,
            max_iterations=self.max_iterations,
        )

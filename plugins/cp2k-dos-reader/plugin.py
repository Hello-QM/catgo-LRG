"""CP2K PDOS file reader plugin.

Parses CP2K .pdos output files and produces VaspData-compatible dicts
that integrate with CatGo's DOS analysis pipeline.

CP2K .pdos file format:
    Line 1: # Projected DOS for atomic kind <KIND> at iteration step i = <N>,
            E(Fermi) = <EF> a.u.
    Line 2: # MO Eigenvalue [a.u.] Occupation s py pz px ...
    Data:   <MO> <eigenvalue> <occupation> <orbital contributions...>

Each atom kind produces a separate .pdos file. Spin-polarized calculations
produce ALPHA and BETA variants per kind.
"""

import re
from pathlib import Path
from typing import Optional

import numpy as np

from plugins.base import ReaderPlugin

# Constants
HA_TO_EV = 27.211386245988  # 1 Hartree in eV

# Standard orbital ordering (matching VASP PROCAR convention)
ORBITAL_CHANNELS = ["s", "py", "pz", "px", "dxy", "dyz", "dz2", "dxz", "dx2"]


class CP2KDosReader(ReaderPlugin):
    """Reader for CP2K .pdos files."""

    name = "cp2k-dos-reader"
    reader_id = "cp2k_pdos"
    display_name = "CP2K DOS"
    description = "Read projected density of states from CP2K .pdos output files"
    version = "1.0.0"
    author = "CatGo"

    supported_formats = [".pdos"]
    output_type = "electronic_dos"
    multi_file = True  # CP2K produces one .pdos file per atom kind

    def priority_score(self, filenames: list[str]) -> int:
        """CP2K .pdos files are very specific — high priority."""
        if any(fn.lower().endswith(".pdos") for fn in filenames):
            return 20  # Higher than generic readers
        return 0

    async def read(
        self, file_paths: list[str], options: Optional[dict] = None
    ) -> dict:
        """Read CP2K .pdos files and return VaspData-compatible dict.

        Args:
            file_paths: List of .pdos files (one per atom kind, possibly
                        ALPHA/BETA pairs for spin-polarized)
            options: Optional dict with:
                - fermi_override: float, override Fermi energy in eV
                - dummy_lattice: float, lattice constant for dummy cell (default 10.0)

        Returns:
            Dict with VaspData-compatible fields
        """
        options = options or {}

        # Filter to .pdos files only
        pdos_files = [p for p in file_paths if p.lower().endswith(".pdos")]
        if not pdos_files:
            raise ValueError("No .pdos files found in uploaded files")

        # Parse all .pdos files
        parsed = [_parse_pdos_file(Path(fp)) for fp in pdos_files]

        # Detect spin polarization
        spins_found = set(p["spin"] for p in parsed)
        has_alpha = "ALPHA" in spins_found
        has_beta = "BETA" in spins_found
        is_spin_polarized = has_alpha and has_beta
        nspin = 2 if is_spin_polarized else 1

        # Determine Fermi energy
        if "fermi_override" in options:
            efermi_ev = float(options["fermi_override"])
        else:
            # Use Fermi from first file (should be consistent across files)
            efermi_ev = parsed[0]["fermi_ev"]

        # Group by spin channel
        if is_spin_polarized:
            alpha_files = [p for p in parsed if p["spin"] == "ALPHA"]
            beta_files = [p for p in parsed if p["spin"] == "BETA"]
        else:
            alpha_files = parsed
            beta_files = []

        # Build element list and orbital mapping from alpha (or all) files
        # Sort by kind name for consistency
        alpha_files.sort(key=lambda p: p["kind"])
        if beta_files:
            beta_files.sort(key=lambda p: p["kind"])

        # Collect element info: each file represents one atom kind,
        # but CP2K doesn't tell us how many atoms of each kind.
        # We treat each kind as one "ion" for the projector array.
        elements = [p["kind"] for p in alpha_files]
        ion_types = list(dict.fromkeys(elements))  # unique, order-preserving
        ion_counts = [elements.count(t) for t in ion_types]
        nions = len(elements)

        # All files should have the same eigenvalue count
        neig = alpha_files[0]["eigenvalues_ev"].shape[0]

        # Determine orbital channels present across all files
        all_orbital_names: list[str] = []
        for p in alpha_files:
            for name in p["orbital_names"]:
                if name not in all_orbital_names:
                    all_orbital_names.append(name)

        # Map orbital names to channel indices
        nchannels = len(all_orbital_names)

        # Build eigenvalues array: (nspin, 1, nbands) — single k-point (Gamma)
        # CP2K .pdos files list eigenvalues per MO, not per k-point.
        # We use nkpts=1 (Gamma-point equivalent).
        nkpts = 1
        nbands = neig

        eigenvalues = np.zeros((nspin, nkpts, nbands))
        eigenvalues[0, 0, :] = alpha_files[0]["eigenvalues_ev"]
        if is_spin_polarized and beta_files:
            eigenvalues[1, 0, :] = beta_files[0]["eigenvalues_ev"]

        # k-weights: single k-point with weight 1
        kweights = np.array([1.0])

        # Build projectors: (nspin, nions, nchannels, nkpts, nbands)
        projectors = np.zeros((nspin, nions, nchannels, nkpts, nbands))

        for ion_idx, p in enumerate(alpha_files):
            for orb_name, orb_data in p["orbitals"].items():
                if orb_name in all_orbital_names:
                    ch_idx = all_orbital_names.index(orb_name)
                    n = min(len(orb_data), nbands)
                    projectors[0, ion_idx, ch_idx, 0, :n] = orb_data[:n]

        if is_spin_polarized:
            for ion_idx, p in enumerate(beta_files):
                for orb_name, orb_data in p["orbitals"].items():
                    if orb_name in all_orbital_names:
                        ch_idx = all_orbital_names.index(orb_name)
                        n = min(len(orb_data), nbands)
                        projectors[1, ion_idx, ch_idx, 0, :n] = orb_data[:n]

        # Dummy structure (CP2K .pdos doesn't include geometry)
        lattice_a = float(options.get("dummy_lattice", 10.0))
        lattice = np.eye(3) * lattice_a
        positions = np.zeros((nions, 3))
        positions_frac = np.zeros((nions, 3))
        # Place atoms along diagonal for visualization
        for i in range(nions):
            frac = (i + 0.5) / max(nions, 1)
            positions_frac[i] = [frac, frac, frac]
            positions[i] = positions_frac[i] * lattice_a

        return {
            "eigenvalues": eigenvalues.tolist(),
            "kweights": kweights.tolist(),
            "efermi": efermi_ev,
            "projectors": projectors.tolist(),
            "positions": positions.tolist(),
            "positions_frac": positions_frac.tolist(),
            "lattice": lattice.tolist(),
            "elements": elements,
            "ion_types": ion_types,
            "ion_counts": ion_counts,
        }


def _parse_pdos_file(filepath: Path) -> dict:
    """Parse a single CP2K .pdos file.

    Returns:
        Dict with keys: filename, kind, spin, fermi_au, fermi_ev,
        eigenvalues_au, eigenvalues_ev, occupations, orbitals, orbital_names
    """
    lines = filepath.read_text(encoding="utf-8", errors="replace").splitlines()

    if len(lines) < 3:
        raise ValueError(f"File too short: {filepath}")

    # Parse header line 1: extract kind, Fermi energy
    header = lines[0]
    kind_match = re.search(r"atomic kind\s+(\w+)", header)
    kind = kind_match.group(1) if kind_match else "X"

    fermi_match = re.search(r"E\(Fermi\)\s*=\s*([-\d.Ee+]+)\s*a\.u\.", header)
    fermi_au = float(fermi_match.group(1)) if fermi_match else 0.0
    fermi_ev = fermi_au * HA_TO_EV

    # Detect spin channel from filename
    spin = ""
    fname = filepath.name.upper()
    if "ALPHA" in fname:
        spin = "ALPHA"
    elif "BETA" in fname:
        spin = "BETA"

    # Parse column headers (line 2)
    col_header = lines[1].lstrip("#").split()
    # Find where orbital columns start (after "Occupation")
    orbital_start_idx = None
    for i, name in enumerate(col_header):
        if name.lower() == "occupation":
            orbital_start_idx = i + 1
            break
    if orbital_start_idx is None:
        orbital_start_idx = 4  # Fallback

    orbital_names = col_header[orbital_start_idx:]

    # Parse data lines
    data_lines = [l for l in lines[2:] if l.strip() and not l.strip().startswith("#")]
    if not data_lines:
        raise ValueError(f"No data found in {filepath}")

    data = np.loadtxt(data_lines)
    # Columns: MO_index, eigenvalue_au, occupation, orbital1, orbital2, ...
    eigenvalues_au = data[:, 1]
    eigenvalues_ev = eigenvalues_au * HA_TO_EV
    occupations = data[:, 2]

    orbitals: dict[str, np.ndarray] = {}
    for i, name in enumerate(orbital_names):
        col_idx = 3 + i
        if col_idx < data.shape[1]:
            orbitals[name] = data[:, col_idx]

    return {
        "filename": str(filepath),
        "kind": kind,
        "spin": spin,
        "fermi_au": fermi_au,
        "fermi_ev": fermi_ev,
        "eigenvalues_au": eigenvalues_au,
        "eigenvalues_ev": eigenvalues_ev,
        "occupations": occupations,
        "orbitals": orbitals,
        "orbital_names": orbital_names,
    }

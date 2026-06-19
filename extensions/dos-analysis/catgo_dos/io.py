"""Read electronic structure data from VASP output files.

Supported formats:
  - vaspout.h5 (HDF5, VASP >= 6.4)
  - PROCAR + OUTCAR + POSCAR/CONTCAR (all VASP versions)
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Tuple, Union

import numpy as np

# h5py is optional — only needed for read_vaspout_h5 (HDF5 files).
# Lazy-imported inside that function to avoid breaking PROCAR-only usage.
h5py = None  # type: ignore

logger = logging.getLogger(__name__)

_FLOAT_RE = re.compile(
    r"[+-]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[Ee][+-]?\d+)?"
)


def _parse_float_fields(text: str) -> list[float]:
    """Parse floats even when VASP prints adjacent signed values.

    Some PROCAR files contain fields such as ``0.00000000-0.00000000``
    without whitespace between values. Splitting on whitespace leaves that as
    one invalid token, so use a numeric regex to recover both floats.
    """
    return [float(match.group(0)) for match in _FLOAT_RE.finditer(text)]


def _normalize_adjacent_signed_floats(text: str) -> str:
    """Insert whitespace between adjacent floats while preserving exponents.

    VASP can emit fixed-width values without a separating space when the next
    value is signed, e.g. ``0.30000000-0.10000000``. Add a space before that
    sign globally, but do not touch exponent signs such as ``1.25E-03``.
    """
    return re.sub(r"(?<=[0-9])([+-])(?=[0-9.])", r" \1", text)


def _decode(x: object) -> str:
    if isinstance(x, (bytes, np.bytes_)):
        return x.decode()
    return str(x)


@dataclass
class VaspData:
    """Container for all electronic-structure arrays from vaspout.h5.

    Attributes
    ----------
    eigenvalues : ndarray, shape (nspin, nkpts, nbands)
        Kohn-Sham eigenvalues in eV.
    kweights : ndarray, shape (nkpts,)
        Symmetry-reduced k-point weights (sum to 1).
    efermi : float
        Fermi energy in eV.
    projectors : ndarray, shape (nspin, nions, nchannels, nkpts, nbands)
        Site- and angular-momentum projected wavefunctions.
    positions : ndarray, shape (nions, 3)
        Cartesian positions in Angstrom.
    positions_frac : ndarray, shape (nions, 3)
        Fractional (direct) coordinates.
    lattice : ndarray, shape (3, 3)
        Lattice vectors in Angstrom (row vectors).
    elements : ndarray of str, shape (nions,)
        Element symbol for each ion.
    ion_types : list[str]
        Unique element types in POSCAR order.
    ion_counts : list[int]
        Number of ions per type.
    """

    eigenvalues: np.ndarray
    kweights: np.ndarray
    efermi: float
    projectors: np.ndarray
    positions: np.ndarray
    positions_frac: np.ndarray
    lattice: np.ndarray
    elements: np.ndarray
    ion_types: list[str] = field(default_factory=list)
    ion_counts: list[int] = field(default_factory=list)

    # derived dimensions
    @property
    def nspin(self) -> int:
        return self.eigenvalues.shape[0]

    @property
    def nkpts(self) -> int:
        return self.eigenvalues.shape[1]

    @property
    def nbands(self) -> int:
        return self.eigenvalues.shape[2]

    @property
    def nions(self) -> int:
        return len(self.elements)

    @property
    def nchannels(self) -> int:
        return self.projectors.shape[2]


def read_vaspout_h5(path: Union[str, Path]) -> VaspData:
    """Read electronic-structure data from a VASP vaspout.h5 file.

    Parameters
    ----------
    path : str or Path
        Path to the vaspout.h5 file.

    Returns
    -------
    VaspData
        Dataclass containing all arrays needed for DOS analysis.
    """
    import h5py as _h5py  # lazy import — not needed for PROCAR path

    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"HDF5 file not found: {path}")

    with _h5py.File(path, "r") as f:
        # Eigenvalues & k-weights
        eigenvalues = f["results/electron_eigenvalues/eigenvalues"][...]  # (spin, k, band)
        kweights = f["results/electron_eigenvalues/kpoints_symmetry_weight"][...]  # (k,)
        efermi = float(np.array(f["results/electron_dos/efermi"]))

        # Projectors
        projectors = f["results/projectors/par"][...]  # (spin, ion, chan, k, band)

        # Lattice
        lattice = f["results/positions/lattice_vectors"][...]  # (3, 3)

        # Positions (fractional -> Cartesian)
        if "results/positions/position_ions" in f:
            positions_frac = f["results/positions/position_ions"][...]
        elif "results/positions/direct_coordinates" in f:
            positions_frac = f["results/positions/direct_coordinates"][...]
        else:
            raise KeyError(
                "No position data found in vaspout.h5 "
                "(expected results/positions/position_ions or direct_coordinates)"
            )
        positions = positions_frac @ lattice  # (N, 3) Cartesian Angstrom

        # Ion types & counts
        ion_types = [_decode(x) for x in f["results/positions/ion_types"][...]]
        ion_counts = f["results/positions/number_ion_types"][...].astype(int).tolist()

    # Build per-ion element array
    elements: list[str] = []
    for typ, cnt in zip(ion_types, ion_counts):
        elements.extend([typ] * cnt)

    return VaspData(
        eigenvalues=np.asarray(eigenvalues, dtype=np.float64),
        kweights=np.asarray(kweights, dtype=np.float64),
        efermi=efermi,
        projectors=np.asarray(projectors, dtype=np.float64),
        positions=np.asarray(positions, dtype=np.float64),
        positions_frac=np.asarray(positions_frac, dtype=np.float64),
        lattice=np.asarray(lattice, dtype=np.float64),
        elements=np.array(elements, dtype=object),
        ion_types=ion_types,
        ion_counts=ion_counts,
    )


def write_contcar(
    path: Union[str, Path],
    data: VaspData,
    coord_mode: str = "direct",
) -> None:
    """Write a POSCAR/CONTCAR file from VaspData.

    Parameters
    ----------
    path : str or Path
        Output file path.
    data : VaspData
        Structure data.
    coord_mode : str
        ``"direct"`` for fractional or ``"cart"`` for Cartesian coordinates.
    """
    path = Path(path)
    nions = data.nions

    if coord_mode == "direct":
        coords = data.positions_frac
        label = "Direct"
    else:
        coords = data.positions
        label = "Cartesian"

    with open(path, "w") as w:
        w.write("Structure from vaspout.h5\n")
        w.write("1.0\n")
        for i in range(3):
            w.write(
                f"{data.lattice[i, 0]: .16f} "
                f"{data.lattice[i, 1]: .16f} "
                f"{data.lattice[i, 2]: .16f}\n"
            )
        w.write(" ".join(data.ion_types) + "\n")
        w.write(" ".join(str(c) for c in data.ion_counts) + "\n")
        w.write(label + "\n")
        for i in range(nions):
            w.write(
                f"{coords[i, 0]: .16f} "
                f"{coords[i, 1]: .16f} "
                f"{coords[i, 2]: .16f}\n"
            )


# ---------------------------------------------------------------------------
# OUTCAR helpers
# ---------------------------------------------------------------------------

def extract_efermi_outcar(text: str) -> float:
    """Extract Fermi energy from OUTCAR text content."""
    match = re.search(r"E-fermi\s*:\s*([-\d.]+)", text)
    if match:
        return float(match.group(1))
    raise ValueError("Could not find E-fermi in OUTCAR")


# ---------------------------------------------------------------------------
# POSCAR / CONTCAR reader
# ---------------------------------------------------------------------------

def read_poscar(text: str) -> Tuple[np.ndarray, np.ndarray, list[str], list[int]]:
    """Parse POSCAR/CONTCAR text.

    Returns
    -------
    lattice : ndarray (3, 3)
    positions_frac : ndarray (nions, 3)
    ion_types : list[str]
    ion_counts : list[int]
    """
    lines = [l.rstrip() for l in text.strip().splitlines()]
    if len(lines) < 7:
        raise ValueError("POSCAR too short")

    scale = float(lines[1].strip())
    lattice = np.zeros((3, 3))
    for i in range(3):
        lattice[i] = [float(x) for x in lines[2 + i].split()[:3]]
    lattice *= scale

    # Species line (VASP 5+ format)
    species_line = lines[5].split()
    try:
        # Check if line 5 is counts (VASP 4) or species names (VASP 5+)
        _ = int(species_line[0])
        # It's counts -> no species names available
        ion_types = [f"Type{i}" for i in range(len(species_line))]
        ion_counts = [int(x) for x in species_line]
        coord_start = 7 if lines[6].strip()[0].upper() in ("S", "D", "C", "K") else 6
    except ValueError:
        # It's species names
        ion_types = species_line
        ion_counts = [int(x) for x in lines[6].split()]
        # Line 7 might be "Selective dynamics" or coordinate mode
        idx = 7
        if idx < len(lines) and lines[idx].strip().lower().startswith("s"):
            idx += 1  # skip selective dynamics
        coord_start = idx + 1 if idx < len(lines) else idx

    nions = sum(ion_counts)
    # Determine coordinate mode
    mode_line = lines[coord_start - 1].strip().lower()
    is_cartesian = mode_line.startswith("c") or mode_line.startswith("k")

    positions = np.zeros((nions, 3))
    for i in range(nions):
        if coord_start + i >= len(lines):
            break
        parts = lines[coord_start + i].split()[:3]
        positions[i] = [float(x) for x in parts]

    if is_cartesian:
        positions_frac = positions @ np.linalg.inv(lattice)
    else:
        positions_frac = positions

    return lattice, positions_frac, ion_types, ion_counts


# ---------------------------------------------------------------------------
# PROCAR reader  (reference: pyprocar ProcarParser)
# ---------------------------------------------------------------------------

def read_procar(
    procar_text: str,
    efermi: float = 0.0,
    poscar_text: Optional[str] = None,
) -> VaspData:
    """Parse PROCAR file text into VaspData.

    Parameters
    ----------
    procar_text : str
        Full text content of the PROCAR file.
    efermi : float
        Fermi energy in eV (from OUTCAR or DOSCAR).
    poscar_text : str, optional
        Text content of POSCAR/CONTCAR for structure info.

    Returns
    -------
    VaspData
    """
    procar_text = _normalize_adjacent_signed_floats(procar_text)

    # --- Step 1: Parse header ---
    # Line 2: "# of k-points:  N   # of bands:  M   # of ions:  K"
    header_match = re.search(
        r"#\s*of\s*k-points\s*:\s*(\d+)\s*#\s*of\s*bands\s*:\s*(\d+)\s*#\s*of\s*ions\s*:\s*(\d+)",
        procar_text,
    )
    if not header_match:
        raise ValueError("Cannot find PROCAR header (# of k-points / bands / ions)")

    nkpts = int(header_match.group(1))
    nbands = int(header_match.group(2))
    nions = int(header_match.group(3))
    logger.info("PROCAR header: nkpts=%d, nbands=%d, nions=%d", nkpts, nbands, nions)

    # --- Step 2: Parse k-points and weights ---
    kpoint_pattern = re.compile(
        r"k-point\s+(\d+)\s*:\s+([-+.\d\sEe]+?)weight\s*=\s*([-+.\dEe]+)"
    )
    kp_matches = kpoint_pattern.findall(procar_text)

    # Determine spin: if we find 2*nkpts k-point entries, it's spin-polarized
    if len(kp_matches) == 2 * nkpts:
        nspin = 2
        logger.info("Spin-polarized PROCAR detected")
    elif len(kp_matches) == nkpts:
        nspin = 1
    else:
        # Could be non-collinear (4x) or malformed
        if len(kp_matches) == 4 * nkpts:
            nspin = 1  # treat non-collinear as single spin for now
            logger.info("Non-collinear PROCAR detected, treating as single-spin")
        else:
            raise ValueError(
                f"Expected {nkpts} or {2*nkpts} k-point entries, found {len(kp_matches)}"
            )

    kpoints = np.zeros((nkpts, 3))
    kweights = np.zeros(nkpts)
    for i in range(nkpts):
        coords = _parse_float_fields(kp_matches[i][1])
        if len(coords) < 3:
            raise ValueError(f"Could not parse k-point coordinates from PROCAR entry {i + 1}")
        kpoints[i] = coords[:3]
        kweights[i] = _parse_float_fields(kp_matches[i][2])[0]

    # Normalize weights to sum to 1
    wsum = kweights.sum()
    if wsum > 0:
        kweights /= wsum

    # --- Step 3: Parse band energies ---
    band_pattern = re.compile(r"band\s+(\d+)\s*#\s*energy\s+([-.\dEe+]+)")
    band_matches = band_pattern.findall(procar_text)

    expected_bands = nspin * nkpts * nbands
    if len(band_matches) != expected_bands:
        logger.warning(
            "Expected %d band entries, found %d", expected_bands, len(band_matches)
        )
        # Try to use what we have
        actual_nbands = len(band_matches) // (nspin * nkpts)
        if actual_nbands == 0:
            raise ValueError("No band data found in PROCAR")
        nbands = actual_nbands

    eigenvalues = np.zeros((nspin, nkpts, nbands))
    idx = 0
    for ispin in range(nspin):
        for ik in range(nkpts):
            for ib in range(nbands):
                if idx < len(band_matches):
                    eigenvalues[ispin, ik, ib] = float(band_matches[idx][1])
                    idx += 1

    # --- Step 4: Parse orbital projections ---
    # Find the orbital header to know how many orbitals
    orb_header = re.search(r"ion\s+(s\s+.+?)\s*\n", procar_text)
    if orb_header:
        orb_names = orb_header.group(1).split()
        # Remove "tot" from the list — it's the total, not a channel
        if orb_names and orb_names[-1].lower() == "tot":
            orb_names = orb_names[:-1]
        nchannels = len(orb_names)
    else:
        # Fallback: try to detect from data
        nchannels = 9  # default spd
        orb_names = ["s", "py", "pz", "px", "dxy", "dyz", "dz2", "dxz", "dx2-y2"]

    logger.info("Orbital channels: %d (%s)", nchannels, ", ".join(orb_names))

    # Parse projection blocks
    # Each block looks like:
    #   ion      s     py     pz   ...   tot
    #     1  0.079  0.000  ...  0.079
    #     2  0.152  ...
    #   tot  0.686  ...
    #
    # For nions atoms, there are nions+1 lines per block (atoms + tot)
    # For spin-polarized, blocks alternate or repeat

    # Strategy: find all numeric data blocks after "ion" headers
    # Use the pattern from pyprocar: find blocks between "ion" headers
    ion_block_pattern = re.compile(
        r"ion\s+(?:s|px|py|pz|dxy|dyz|dz2|dxz|dx2|x2-y2|tot).+?\n"
        r"((?:\s*\d+\s+[-+.\d\sEe]+\n)*"  # atom lines
        r"\s*tot\s+[-+.\d\sEe]+)",          # tot line
        re.MULTILINE,
    )
    blocks = ion_block_pattern.findall(procar_text)

    if not blocks:
        # Fallback: try simpler pattern
        blocks = re.findall(
            r"ion.+tot\n([-+.\d\sEeto\n]+?)(?=\n\s*\n|\n\s*band|\n\s*k-point|\Z)",
            procar_text,
        )

    # Initialize projectors: (nspin, nions, nchannels, nkpts, nbands)
    projectors = np.zeros((nspin, nions, nchannels, nkpts, nbands))

    if blocks:
        # Determine if we have ispin blocks (non-collinear: 4 blocks per band*kpt)
        expected_blocks = nspin * nkpts * nbands
        block_idx = 0

        for ispin in range(nspin):
            for ik in range(nkpts):
                for ib in range(nbands):
                    if block_idx >= len(blocks):
                        break
                    block_text = blocks[block_idx]
                    block_idx += 1

                    # Parse each atom line
                    lines = block_text.strip().split("\n")
                    for line in lines:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            # First value is ion index or "tot"
                            if line.lower().startswith("tot"):
                                continue
                            match = re.match(r"^(\d+)\s+(.*)$", line)
                            if not match:
                                continue
                            ion_idx = int(match.group(1)) - 1  # 1-based to 0-based
                            if 0 <= ion_idx < nions:
                                # Values are orbitals + tot at end
                                vals = _parse_float_fields(match.group(2))
                                # Take only the orbital channels (skip "tot")
                                norbs = min(nchannels, len(vals) - 1) if len(vals) > nchannels else len(vals)
                                projectors[ispin, ion_idx, :norbs, ik, ib] = vals[:norbs]
                        except (ValueError, IndexError):
                            continue
    else:
        logger.warning("No projection blocks found in PROCAR")

    # --- Step 5: Structure info from POSCAR ---
    if poscar_text:
        lattice, positions_frac, ion_types, ion_counts = read_poscar(poscar_text)
        positions = positions_frac @ lattice
        elements_list: list[str] = []
        for typ, cnt in zip(ion_types, ion_counts):
            elements_list.extend([typ] * cnt)
        elements = np.array(elements_list, dtype=object)
    else:
        # No structure info — create dummy
        lattice = np.eye(3) * 10.0
        positions_frac = np.zeros((nions, 3))
        positions = positions_frac.copy()
        ion_types = [f"X{i}" for i in range(nions)]
        ion_counts = [1] * nions
        elements = np.array([f"X{i}" for i in range(nions)], dtype=object)

    return VaspData(
        eigenvalues=eigenvalues,
        kweights=kweights,
        efermi=efermi,
        projectors=projectors,
        positions=positions,
        positions_frac=positions_frac,
        lattice=lattice,
        elements=elements,
        ion_types=ion_types,
        ion_counts=ion_counts,
    )

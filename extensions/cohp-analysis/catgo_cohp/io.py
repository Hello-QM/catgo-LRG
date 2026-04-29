"""Parse COHPCAR.lobster and ICOHPLIST.lobster files from LOBSTER calculations.

COHPCAR.lobster contains Crystal Orbital Hamilton Population (COHP) data,
which quantifies bonding/antibonding interactions between atom pairs as a
function of energy. ICOHPLIST.lobster contains the integrated COHP values
evaluated at the Fermi level for each bond.

Supports both spin-polarized (nspin=2) and non-spin-polarized (nspin=1) data,
total bond and orbital-resolved entries, and orbital names with special
characters (e.g. d_z^2, d_x^2-y^2).
"""

import re
import numpy as np
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple, Union


# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

# Matches bond labels like:
#   No.1:N92->Mo26(2.2796981659003812)
#   No.1:N92[2s]->Mo26[4s](2.2796981659003812)
#   No.4:N92[2p_x]->N93[2p_x](1.2628513508925576)
_BOND_LABEL_RE = re.compile(
    r"No\.(\d+):"           # bond index
    r"(\w+)"                # atom1 (e.g. N92, Mo26)
    r"(?:\[([^\]]+)\])?"    # optional orbital1 in brackets
    r"->"
    r"(\w+)"                # atom2
    r"(?:\[([^\]]+)\])?"    # optional orbital2 in brackets
    r"\(([^)]+)\)"          # distance in parentheses
)

# Matches atom+number like "N92", "Mo26", "Li1", "O128"
_ATOM_RE = re.compile(r"^([A-Z][a-z]?)(\d+)$")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class BondInfo:
    """Metadata for a single COHP bond or orbital pair.

    Each column in the COHPCAR data array corresponds to one BondInfo entry.
    Total bonds (no orbital resolution) have ``orbital1`` and ``orbital2``
    set to ``None`` and ``is_total=True``.
    """

    bond_index: int
    """1-based bond number from the ``No.X`` label. 0 for the Average column."""

    atom1: str
    """First atom label, e.g. ``"N92"``."""

    atom2: str
    """Second atom label, e.g. ``"Mo26"``."""

    distance: float
    """Bond distance in Angstrom."""

    orbital1: Optional[str]
    """Orbital on atom1, e.g. ``"2s"``, ``"2p_y"``. ``None`` for total bond."""

    orbital2: Optional[str]
    """Orbital on atom2, e.g. ``"4d_xy"``. ``None`` for total bond."""

    column_index: int
    """0-based column index in the COHP data array."""

    is_total: bool
    """``True`` if this is a total bond (no orbital resolution)."""

    @property
    def label(self) -> str:
        """Human-readable label for this bond/orbital pair."""
        if self.bond_index == 0:
            return "Average"
        if self.is_total:
            return f"{self.atom1}-{self.atom2}"
        return f"{self.atom1}[{self.orbital1}]-{self.atom2}[{self.orbital2}]"

    @property
    def element1(self) -> str:
        """Element symbol of atom1 (digits stripped)."""
        return re.sub(r"\d+", "", self.atom1)

    @property
    def element2(self) -> str:
        """Element symbol of atom2 (digits stripped)."""
        return re.sub(r"\d+", "", self.atom2)


@dataclass
class COHPData:
    """Container for parsed COHPCAR.lobster data.

    The ``cohp`` array stores pCOHP values with shape
    ``(nspin, ncols, npoints)``, where *ncols* includes the Average column
    at index 0.  The ``icohp`` array has the same shape and stores integrated
    COHP values read from the file.  Energies are already shifted so the
    Fermi level is at 0 eV.
    """

    energies: np.ndarray
    """Shape ``(npoints,)`` -- energy grid relative to E_f."""

    cohp: np.ndarray
    """Shape ``(nspin, ncols, npoints)`` -- COHP values."""

    icohp: np.ndarray
    """Shape ``(nspin, ncols, npoints)`` -- integrated COHP values."""

    bonds: List[BondInfo]
    """Metadata for each column (``ncols`` entries, including Average at index 0)."""

    nspin: int
    """Number of spin channels (1 or 2)."""

    npoints: int
    """Number of energy grid points."""

    ncols: int
    """Number of COHP columns (including Average)."""

    efermi: float
    """Fermi energy from the file header (data is already shifted to E_f = 0)."""

    emin: float
    """Minimum energy in the grid."""

    emax: float
    """Maximum energy in the grid."""


@dataclass
class ICOHPEntry:
    """One entry from ICOHPLIST.lobster.

    Stores the integrated COHP at the Fermi level for a single bond (total
    or orbital-resolved).
    """

    cohp_num: int
    """1-based COHP bond number."""

    atom1: str
    """First atom label, e.g. ``"N92"``."""

    atom2: str
    """Second atom label, e.g. ``"Mo26"``."""

    distance: float
    """Bond distance in Angstrom."""

    translation: Tuple[int, int, int]
    """Lattice translation vector ``(t1, t2, t3)``."""

    spin_up: float
    """ICOHP value for spin-up channel at E_f."""

    spin_down: float
    """ICOHP value for spin-down channel at E_f (0.0 if non-spin-polarized)."""

    orbital1: Optional[str]
    """Orbital on atom1. ``None`` for total-bond entries."""

    orbital2: Optional[str]
    """Orbital on atom2. ``None`` for total-bond entries."""

    @property
    def total(self) -> float:
        """Sum of spin-up and spin-down ICOHP values."""
        return self.spin_up + self.spin_down

    @property
    def is_total(self) -> bool:
        """``True`` if this is a total-bond entry (no orbital decomposition)."""
        return self.orbital1 is None

    @property
    def label(self) -> str:
        """Human-readable label."""
        if self.is_total:
            return f"{self.atom1}-{self.atom2}"
        return f"{self.atom1}[{self.orbital1}]-{self.atom2}[{self.orbital2}]"


# ---------------------------------------------------------------------------
# COHPCAR parser
# ---------------------------------------------------------------------------

def _parse_bond_label(label: str, column_index: int) -> BondInfo:
    """Parse a single bond label line from the COHPCAR header.

    Parameters
    ----------
    label : str
        A line like ``"No.1:N92->Mo26(2.279...)"`` or
        ``"No.1:N92[2s]->Mo26[4s](2.279...)"`` or ``"Average"``.
    column_index : int
        0-based column index this label corresponds to.

    Returns
    -------
    BondInfo
    """
    stripped = label.strip()

    # Handle the special "Average" column
    if stripped.lower() == "average":
        return BondInfo(
            bond_index=0,
            atom1="Average",
            atom2="Average",
            distance=0.0,
            orbital1=None,
            orbital2=None,
            column_index=column_index,
            is_total=True,
        )

    m = _BOND_LABEL_RE.match(stripped)
    if m is None:
        raise ValueError(f"Cannot parse COHP bond label: {stripped!r}")

    bond_idx = int(m.group(1))
    atom1 = m.group(2)
    orb1 = m.group(3) if m.group(3) else None
    atom2 = m.group(4)
    orb2 = m.group(5) if m.group(5) else None
    dist = float(m.group(6))

    is_total = orb1 is None and orb2 is None

    return BondInfo(
        bond_index=bond_idx,
        atom1=atom1,
        atom2=atom2,
        distance=dist,
        orbital1=orb1,
        orbital2=orb2,
        column_index=column_index,
        is_total=is_total,
    )


def parse_cohpcar(path: Union[str, Path]) -> COHPData:
    """Parse a COHPCAR.lobster file.

    Parameters
    ----------
    path : str or Path
        Path to COHPCAR.lobster.

    Returns
    -------
    COHPData
        Parsed COHP data container.

    Raises
    ------
    FileNotFoundError
        If the file does not exist.
    ValueError
        If the file format is unexpected.
    """
    path = Path(path)
    with open(path, "r") as fh:
        lines = fh.readlines()

    if len(lines) < 3:
        raise ValueError(f"COHPCAR file too short ({len(lines)} lines): {path}")

    # ------------------------------------------------------------------
    # Line 1: comment / metadata (skip)
    # Line 2: ncols  nspin  npoints  emin  emax  efermi
    # ------------------------------------------------------------------
    header_parts = lines[1].split()
    if len(header_parts) < 6:
        raise ValueError(
            f"Expected 6 values on line 2, got {len(header_parts)}: {lines[1].strip()!r}"
        )

    ncols = int(header_parts[0])
    nspin = int(header_parts[1])
    npoints = int(header_parts[2])
    emin = float(header_parts[3])
    emax = float(header_parts[4])
    efermi = float(header_parts[5])

    if nspin not in (1, 2):
        raise ValueError(f"nspin must be 1 or 2, got {nspin}")

    # ------------------------------------------------------------------
    # Lines 3 .. 3+ncols: bond labels
    # First label is "Average", then ncols-1 bond/orbital labels
    # ------------------------------------------------------------------
    bonds: List[BondInfo] = []
    label_start = 2  # 0-indexed line number (line 3 in 1-based)
    for i in range(ncols):
        line_idx = label_start + i
        if line_idx >= len(lines):
            raise ValueError(
                f"Ran out of lines while reading bond labels "
                f"(expected {ncols} labels, file has {len(lines)} lines)"
            )
        bond = _parse_bond_label(lines[line_idx], column_index=i)
        bonds.append(bond)

    # ------------------------------------------------------------------
    # Data section: npoints lines of COHP/ICOHP data.
    #
    # Each line: energy  [spin-up block]  [spin-down block]
    #
    # Each spin block has ncols pairs of (COHP, ICOHP), giving 2*ncols
    # values per spin block.  Total values per line:
    #   1 + 2 * ncols * nspin
    #
    # Within each spin block the columns are ordered:
    #   avg_COHP, avg_ICOHP, bond0_COHP, bond0_ICOHP, bond1_COHP, ...
    #
    # For a given column `col` (0-based, with Average at 0) and spin `s`
    # (0=up, 1=down):
    #   COHP index  = 1 + 2*col + 2*s*ncols
    #   ICOHP index = 2 + 2*col + 2*s*ncols
    # ------------------------------------------------------------------
    data_start = label_start + ncols
    expected_values_per_line = 1 + 2 * ncols * nspin

    energies = np.empty(npoints, dtype=np.float64)
    cohp = np.empty((nspin, ncols, npoints), dtype=np.float64)
    icohp = np.empty((nspin, ncols, npoints), dtype=np.float64)

    data_line_count = 0
    for line_idx in range(data_start, len(lines)):
        line = lines[line_idx].strip()
        if not line:
            continue  # skip blank lines

        parts = line.split()
        if len(parts) < expected_values_per_line:
            # Some files may have trailing blank lines or comments
            if data_line_count >= npoints:
                break
            raise ValueError(
                f"Data line {line_idx + 1} has {len(parts)} values, "
                f"expected {expected_values_per_line}: {line!r}"
            )

        if data_line_count >= npoints:
            break

        energies[data_line_count] = float(parts[0])

        # Grouped spin layout: all spin-up pairs first, then all spin-down.
        for spin in range(nspin):
            for col in range(ncols):
                cohp_idx = 1 + 2 * col + 2 * spin * ncols
                icohp_idx = cohp_idx + 1
                cohp[spin, col, data_line_count] = float(parts[cohp_idx])
                icohp[spin, col, data_line_count] = float(parts[icohp_idx])

        data_line_count += 1

    if data_line_count != npoints:
        raise ValueError(
            f"Expected {npoints} data points, but parsed {data_line_count}"
        )

    return COHPData(
        energies=energies,
        cohp=cohp,
        icohp=icohp,
        bonds=bonds,
        nspin=nspin,
        npoints=npoints,
        ncols=ncols,
        efermi=efermi,
        emin=emin,
        emax=emax,
    )


# ---------------------------------------------------------------------------
# ICOHPLIST parser
# ---------------------------------------------------------------------------

def _split_atom_orbital(token: str) -> Tuple[str, Optional[str]]:
    """Split an ICOHPLIST atom token into (atom_label, orbital_or_None).

    The token format from LOBSTER is either:
      - ``"N92"`` (total bond, no orbital) -- element + index, no underscore
      - ``"N92_2s"`` (orbital-resolved) -- element + index + ``_`` + orbital
      - ``"Mo26_4d_xy"`` -- underscore *within* the orbital name

    Strategy: match ``^([A-Z][a-z]?\\d+)`` for the atom label. If there is
    remaining text starting with ``_``, that is the orbital.

    Parameters
    ----------
    token : str
        Raw atom/orbital token from the ICOHPLIST line.

    Returns
    -------
    (atom, orbital) : tuple
        ``atom`` is e.g. ``"N92"``; ``orbital`` is ``"2s"`` or ``None``.
    """
    m = re.match(r"^([A-Z][a-z]?\d+)(?:_(.+))?$", token)
    if m is None:
        raise ValueError(f"Cannot parse ICOHPLIST atom token: {token!r}")
    atom = m.group(1)
    orbital = m.group(2)  # None if no orbital suffix
    return atom, orbital


def parse_icohplist(path: Union[str, Path]) -> List[ICOHPEntry]:
    """Parse an ICOHPLIST.lobster file.

    The file lists integrated COHP values at the Fermi level for each bond,
    optionally decomposed by orbital contributions.

    Parameters
    ----------
    path : str or Path
        Path to ICOHPLIST.lobster.

    Returns
    -------
    list of ICOHPEntry
        Parsed ICOHP entries.

    Raises
    ------
    FileNotFoundError
        If the file does not exist.
    ValueError
        If the file format is unexpected.

    Notes
    -----
    The file format is::

        COHP#  atomMU  atomNU  distance  translation  ICOHP(eF) spin1  ICOHP(eF) spin2
                                                       for spin 1       for spin 2
              1    N92    Mo26   2.27970    0  0  0      -1.03856        -1.03352
              1  N92_2s Mo26_4s  2.27970    0  0  0      -0.00524        -0.00502

    For non-spin-polarized calculations, the spin-2 column is absent.
    """
    path = Path(path)
    with open(path, "r") as fh:
        lines = fh.readlines()

    entries: List[ICOHPEntry] = []

    # Detect number of spins from the header.
    # The header typically has "for spin 1" and optionally "for spin 2".
    # We also infer from data line column count.
    has_spin2: Optional[bool] = None

    # Skip header lines (lines starting with non-numeric content).
    # Data lines start with whitespace followed by an integer.
    data_line_re = re.compile(r"^\s*(\d+)\s+")

    for line in lines:
        line_stripped = line.strip()
        if not line_stripped:
            continue

        m = data_line_re.match(line)
        if m is None:
            # Header or comment line -- try to detect spin channels
            if "for spin 2" in line.lower():
                has_spin2 = True
            continue

        parts = line.split()

        # Determine layout from column count:
        #   nspin=2: cohp_num  atom1  atom2  distance  t1 t2 t3  icohp_up  icohp_down  => 9 cols
        #   nspin=1: cohp_num  atom1  atom2  distance  t1 t2 t3  icohp_up              => 8 cols
        if has_spin2 is None:
            # First data line determines spin count
            has_spin2 = len(parts) >= 9

        if len(parts) < 8:
            raise ValueError(
                f"ICOHPLIST data line has too few columns ({len(parts)}): "
                f"{line_stripped!r}"
            )

        cohp_num = int(parts[0])
        raw_atom1 = parts[1]
        raw_atom2 = parts[2]
        distance = float(parts[3])
        t1, t2, t3 = int(parts[4]), int(parts[5]), int(parts[6])
        spin_up = float(parts[7])
        spin_down = float(parts[8]) if has_spin2 and len(parts) >= 9 else 0.0

        atom1, orb1 = _split_atom_orbital(raw_atom1)
        atom2, orb2 = _split_atom_orbital(raw_atom2)

        entries.append(
            ICOHPEntry(
                cohp_num=cohp_num,
                atom1=atom1,
                atom2=atom2,
                distance=distance,
                translation=(t1, t2, t3),
                spin_up=spin_up,
                spin_down=spin_down,
                orbital1=orb1,
                orbital2=orb2,
            )
        )

    return entries

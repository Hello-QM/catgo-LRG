"""Shared LAMMPS utilities — force field mapping, atom type handling, helper functions.

Provides enums (ExecutionMode, LammpsJobState), element data (ATOMIC_MASSES),
polymer force field definitions (POLYMER_MONOMERS, POLYMER_FORCE_FIELDS),
and helper functions for extracting structure info, computing LAMMPS box bounds,
transforming coordinates, and parsing LAMMPS log/dump output files.
"""

__all__ = [
    "ExecutionMode",
    "LammpsJobState",
    "ATOMIC_MASSES",
    "POLYMER_MONOMERS",
    "POLYMER_FORCE_FIELDS",
    "extract_structure_info",
    "get_box_bounds",
    "transform_coords_to_lammps",
    "parse_lammps_data_info",
    "parse_lammps_log",
    "parse_lammps_dump",
    "get_charge",
]

import re
from enum import Enum
from typing import Optional

import numpy as np

from catgo.models.structure import PymatgenStructure


# ============================================================================
# Enums and Constants
# ============================================================================

class ExecutionMode(str, Enum):
    """LAMMPS execution mode."""
    LOCAL = "local"
    HPC = "hpc"


class LammpsJobState(str, Enum):
    """LAMMPS job status enum."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


# ============================================================================
# Polymer Force Field Data
# ============================================================================

# OPLS-AA force field parameters for common polymer monomers
POLYMER_MONOMERS = {
    # Polyethylene (PE)
    "PE": {
        "repeat_unit": "C2H4",
        "bond_length": 1.54,
        "bond_angle": 109.5,
        "dihedral_type": "opls",
        "elements": ["C", "C", "H", "H", "H", "H"],
        "charges": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        "template_coords": [
            [0.0, 0.0, 0.0],      # C1
            [1.54, 0.0, 0.0],     # C2
            [-0.5, 0.9, 0.0],     # H on C1
            [-0.5, -0.4, 0.9],    # H on C1
            [-0.5, -0.4, -0.9],   # H on C1
            [2.04, 0.9, 0.0],     # H on C2
        ],
    },
    # Polypropylene (PP)
    "PP": {
        "repeat_unit": "C3H6",
        "bond_length": 1.54,
        "bond_angle": 112.0,
        "dihedral_type": "opls",
        "elements": ["C", "C", "C", "H", "H", "H", "H", "H", "H"],
        "charges": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        "has_backbone_branch": True,
    },
    # Polystyrene (PS)
    "PS": {
        "repeat_unit": "C8H8",
        "bond_length": 1.54,
        "bond_angle": 112.0,
        "dihedral_type": "opls",
        "has_aromatic": True,
    },
    # Polymethylmethacrylate (PMMA)
    "PMMA": {
        "repeat_unit": "C5O2H8",
        "bond_length": 1.54,
        "bond_angle": 109.5,
        "dihedral_type": "opls",
        "has_carbonyl": True,
    },
    # Polyethylene terephthalate (PET)
    "PET": {
        "repeat_unit": "C10H8O4",
        "bond_length": 1.54,
        "bond_angle": 111.0,
        "dihedral_type": "opls",
        "has_ester": True,
    },
    # Polyamide 6 (Nylon 6)
    "PA6": {
        "repeat_unit": "C6H11NO",
        "bond_length": 1.54,
        "bond_angle": 110.0,
        "dihedral_type": "opls",
        "has_amide": True,
    },
}

# Polymer force fields
POLYMER_FORCE_FIELDS = {
    "opls": {
        "name": "OPLS-AA",
        "description": "Optimized Potentials for Liquid Simulations - All Atom",
        "pair_style": "hybrid/overlay lj/cut 12.0 coul/long 12.0",
        "kspace_style": "ewald 1e-6",
        "typical_polymers": ["PE", "PP", "PS", "PMMA"],
        "parameters": "bond fene bond_coeff 1 30.0 1.5\nangle cosine\nangle_coeff * 75.0 109.5",
    },
    "pcff": {
        "name": "PCFF (Consistent Force Field)",
        "description": "Class II force field for polymers and organic materials",
        "pair_style": "class2",
        "typical_polymers": ["PE", "PP", "PET", "PA6"],
    },
    "compass": {
        "name": "COMPASS",
        "description": "Condensed-phase Optimized Molecular Potentials for Atomistic Simulation",
        "pair_style": "class2",
        "typical_polymers": ["PE", "PP", "PS", "PET"],
    },
    "dreiding": {
        "name": "Dreiding",
        "description": "Generic force field for organic molecules",
        "pair_style": "lj/cut 12.0",
        "typical_polymers": ["PE", "PP", "PS"],
    },
    "traPPE": {
        "name": "Transferable Potentials for Phase Equilibria",
        "description": "United-atom force field for hydrocarbons",
        "pair_style": "lj/cut 14.0",
        "united_atom": True,
        "typical_polymers": ["PE", "PP"],
    },
}


# ============================================================================
# Element Data
# ============================================================================

ATOMIC_MASSES = {
    'H': 1.008, 'He': 4.003, 'Li': 6.941, 'Be': 9.012, 'B': 10.81, 'C': 12.01,
    'N': 14.01, 'O': 16.00, 'F': 19.00, 'Ne': 20.18, 'Na': 22.99, 'Mg': 24.31,
    'Al': 26.98, 'Si': 28.09, 'P': 30.97, 'S': 32.07, 'Cl': 35.45, 'Ar': 39.95,
    'K': 39.10, 'Ca': 40.08, 'Sc': 44.96, 'Ti': 47.87, 'V': 50.94, 'Cr': 52.00,
    'Mn': 54.94, 'Fe': 55.85, 'Co': 58.93, 'Ni': 58.69, 'Cu': 63.55, 'Zn': 65.38,
    'Ga': 69.72, 'Ge': 72.64, 'As': 74.92, 'Se': 78.96, 'Br': 79.90, 'Kr': 83.80,
    'Rb': 85.47, 'Sr': 87.62, 'Y': 88.91, 'Zr': 91.22, 'Nb': 92.91, 'Mo': 95.96,
    'Tc': 98.00, 'Ru': 101.1, 'Rh': 102.9, 'Pd': 106.4, 'Ag': 107.9, 'Cd': 112.4,
    'In': 114.8, 'Sn': 118.7, 'Sb': 121.8, 'Te': 127.6, 'I': 126.9, 'Xe': 131.3,
    'Cs': 132.9, 'Ba': 137.3, 'La': 138.9, 'Ce': 140.1, 'Pr': 140.9, 'Nd': 144.2,
    'Pm': 145.0, 'Sm': 150.4, 'Eu': 152.0, 'Gd': 157.3, 'Tb': 158.9, 'Dy': 162.5,
    'Ho': 164.9, 'Er': 167.3, 'Tm': 168.9, 'Yb': 173.1, 'Lu': 175.0, 'Hf': 178.5,
    'Ta': 180.9, 'W': 183.8, 'Re': 186.2, 'Os': 190.2, 'Ir': 192.2, 'Pt': 195.1,
    'Au': 197.0, 'Hg': 200.6, 'Tl': 204.4, 'Pb': 207.2, 'Bi': 209.0, 'Po': 209.0,
    'At': 210.0, 'Rn': 222.0, 'Fr': 223.0, 'Ra': 226.0, 'Ac': 227.0, 'Th': 232.0,
    'Pa': 231.0, 'U': 238.0, 'Np': 237.0, 'Pu': 244.0
}


# ============================================================================
# Helper Functions
# ============================================================================


def get_charge(species) -> float:
    """Extract charge from species, handling both Pydantic objects and plain dicts.

    Args:
        species: Species object (Pydantic) or dict with oxidation_state

    Returns:
        Charge value (0.0 if not specified)
    """
    # Handle dict-like objects (plain JSON)
    if isinstance(species, dict):
        return species.get('oxidation_state', 0.0) or 0.0

    # Handle Pydantic models and objects with oxidation_state attribute
    if hasattr(species, 'oxidation_state'):
        val = species.oxidation_state
        return val if val is not None else 0.0

    # Default to 0.0 for unknown types
    return 0.0


def _clean_element_symbol(raw: str) -> str:
    """Strip oxidation-state suffixes (e.g. 'H0+' -> 'H', 'O2-' -> 'O').

    Species strings from pymatgen may carry oxidation state notation that
    breaks ATOMIC_MASSES lookup and LAMMPS type assignment.
    """
    return re.match(r"[A-Z][a-z]?", raw).group() if re.match(r"[A-Z][a-z]?", raw) else raw


def extract_structure_info(structure: PymatgenStructure) -> dict:
    """Extract structure information for LAMMPS."""
    cell = np.array(structure.lattice.matrix)

    elements = []
    cart_coords = []
    charges = []

    for site in structure.sites:
        main_species = max(site.species, key=lambda s: s.occu)
        elements.append(_clean_element_symbol(str(main_species.element)))
        cart_coords.append(site.xyz)
        charges.append(get_charge(main_species))

    # Get unique elements (preserve order)
    unique_elements = []
    element_to_type = {}
    for el in elements:
        if el not in element_to_type:
            element_to_type[el] = len(unique_elements) + 1  # LAMMPS types start at 1
            unique_elements.append(el)

    # Assign type to each atom
    atom_types = [element_to_type[el] for el in elements]

    return {
        "cell": cell,
        "elements": elements,
        "unique_elements": unique_elements,
        "element_to_type": element_to_type,
        "atom_types": atom_types,
        "cart_coords": np.array(cart_coords),
        "charges": charges,
        "n_atoms": len(elements),
        "n_types": len(unique_elements),
    }


def get_box_bounds(cell: np.ndarray) -> dict:
    """Calculate LAMMPS box bounds from cell matrix.

    For triclinic cells, LAMMPS uses:
    - xlo, xhi, ylo, yhi, zlo, zhi for orthogonal bounds
    - xy, xz, yz for tilt factors
    """
    # LAMMPS convention: a along x, b in xy plane, c anywhere
    a = cell[0]
    b = cell[1]
    c = cell[2]

    # Box dimensions
    xhi = np.linalg.norm(a)
    xy = np.dot(b, a / xhi)
    yhi = np.sqrt(np.dot(b, b) - xy**2)
    xz = np.dot(c, a / xhi)
    yz = (np.dot(b, c) - xy * xz) / yhi
    zhi = np.sqrt(np.dot(c, c) - xz**2 - yz**2)

    return {
        "xlo": 0.0, "xhi": xhi,
        "ylo": 0.0, "yhi": yhi,
        "zlo": 0.0, "zhi": zhi,
        "xy": xy, "xz": xz, "yz": yz,
        "is_triclinic": abs(xy) > 1e-8 or abs(xz) > 1e-8 or abs(yz) > 1e-8
    }


def transform_coords_to_lammps(coords: np.ndarray, cell: np.ndarray) -> np.ndarray:
    """Transform coordinates to LAMMPS coordinate system."""
    # For consistency with LAMMPS box, we need to transform coordinates
    a = cell[0]
    b = cell[1]
    c = cell[2]

    xhi = np.linalg.norm(a)
    xy = np.dot(b, a / xhi)
    yhi = np.sqrt(np.dot(b, b) - xy**2)
    xz = np.dot(c, a / xhi)
    yz = (np.dot(b, c) - xy * xz) / yhi
    zhi = np.sqrt(np.dot(c, c) - xz**2 - yz**2)

    # Transformation matrix
    # Original: r = s[0]*a + s[1]*b + s[2]*c (where s is fractional)
    # LAMMPS: x = s[0]*xhi + s[1]*xy + s[2]*xz
    #         y = s[1]*yhi + s[2]*yz
    #         z = s[2]*zhi

    # Get fractional coordinates
    cell_inv = np.linalg.inv(cell.T)
    frac = coords @ cell_inv.T

    # Transform to LAMMPS coordinates
    lammps_coords = np.zeros_like(coords)
    lammps_coords[:, 0] = frac[:, 0] * xhi + frac[:, 1] * xy + frac[:, 2] * xz
    lammps_coords[:, 1] = frac[:, 1] * yhi + frac[:, 2] * yz
    lammps_coords[:, 2] = frac[:, 2] * zhi

    return lammps_coords


def parse_lammps_data_info(content: str) -> dict:
    """Extract metadata from a LAMMPS data file for generate_input_script()."""
    lines = content.splitlines()

    n_atoms = 0
    n_types = 0
    xlo = xhi = ylo = yhi = zlo = zhi = 0.0
    xy = xz = yz = 0.0
    masses: dict[int, float] = {}
    mass_labels: dict[int, str] = {}

    in_section: str | None = None
    atom_rows: list[str] = []

    HEADER_RE = re.compile(
        r"^\s*(\d+)\s+(atoms|bonds|angles|dihedrals|impropers"
        r"|atom types|bond types|angle types|dihedral types|improper types)\s*$"
    )
    BOX_RE = re.compile(
        r"^\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+(xlo\s+xhi|ylo\s+yhi|zlo\s+zhi)\s*$"
    )
    TILT_RE = re.compile(
        r"^\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+xy\s+xz\s+yz"
    )
    SECTION_KW = {
        "Masses", "Atoms", "Velocities", "Bonds", "Angles",
        "Dihedrals", "Impropers", "Pair Coeffs", "Bond Coeffs",
        "Angle Coeffs", "Dihedral Coeffs", "Improper Coeffs",
    }

    for line in lines:
        stripped = line.split("#")
        comment = stripped[1].strip() if len(stripped) > 1 else ""
        body = stripped[0].strip()
        if not body:
            continue

        if body in SECTION_KW or any(body.startswith(k) for k in SECTION_KW):
            in_section = body.split()[0] if body.startswith("Atoms") else body
            if body.startswith("Atoms"):
                in_section = "Atoms"
            continue

        hdr = HEADER_RE.match(line)
        if hdr:
            val, kw = int(hdr.group(1)), hdr.group(2)
            if kw == "atoms":
                n_atoms = val
            elif kw == "atom types":
                n_types = val
            in_section = None
            continue

        box = BOX_RE.match(line)
        if box:
            lo, hi, label = float(box.group(1)), float(box.group(2)), box.group(3)
            if "xlo" in label:
                xlo, xhi = lo, hi
            elif "ylo" in label:
                ylo, yhi = lo, hi
            elif "zlo" in label:
                zlo, zhi = lo, hi
            in_section = None
            continue

        tilt = TILT_RE.match(line)
        if tilt:
            xy, xz, yz = float(tilt.group(1)), float(tilt.group(2)), float(tilt.group(3))
            in_section = None
            continue

        if in_section == "Masses":
            parts = body.split()
            if len(parts) >= 2:
                try:
                    type_id = int(parts[0])
                    mass_val = float(parts[1])
                    masses[type_id] = mass_val
                    if comment:
                        mass_labels[type_id] = comment.strip()
                except ValueError:
                    pass

        elif in_section == "Atoms":
            atom_rows.append(body)

    # Reverse-lookup elements from masses when labels aren't provided
    MASS_TO_ELEM = {round(v, 0): k for k, v in ATOMIC_MASSES.items()}

    unique_elements: list[str] = []
    element_to_type: dict[str, int] = {}
    for tid in sorted(masses):
        label = mass_labels.get(tid)
        if not label:
            rounded = round(masses[tid], 0)
            label = MASS_TO_ELEM.get(rounded, f"Type{tid}")
        label = _clean_element_symbol(label)
        unique_elements.append(label)
        element_to_type[label] = tid

    # Build cell matrix (orthogonal or restricted triclinic)
    a = [xhi - xlo, 0.0, 0.0]
    b = [xy, yhi - ylo, 0.0]
    c = [xz, yz, zhi - zlo]
    cell = np.array([a, b, c])

    # Parse atom coordinates and types from Atoms section
    atom_types: list[int] = []
    charges: list[float] = []
    cart_coords: list[list[float]] = []

    for row in atom_rows:
        parts = row.split()
        if len(parts) < 4:
            continue
        try:
            int(parts[0])  # atom-ID
        except ValueError:
            continue

        # Auto-detect atom_style from column count:
        #   atomic:     ID type x y z            (5+ cols)
        #   charge:     ID type q x y z           (6+ cols, but no mol-ID)
        #   molecular:  ID mol type x y z         (6+ cols)
        #   full:       ID mol type q x y z       (7+ cols)
        ncol = len(parts)
        if ncol >= 7:
            atom_types.append(int(parts[2]))
            charges.append(float(parts[3]))
            cart_coords.append([float(parts[4]), float(parts[5]), float(parts[6])])
        elif ncol >= 6:
            try:
                float(parts[3])
                float(parts[4])
                float(parts[5])
                # Could be charge (ID type q x y z) or molecular (ID mol type x y z)
                # Heuristic: if parts[1] is a small int and parts[2] <= n_types, it's molecular
                if int(parts[2]) <= n_types and int(parts[1]) > n_types:
                    # molecular: ID mol type x y z
                    atom_types.append(int(parts[2]))
                    charges.append(0.0)
                    cart_coords.append([float(parts[3]), float(parts[4]), float(parts[5])])
                else:
                    # charge: ID type q x y z
                    atom_types.append(int(parts[1]))
                    charges.append(float(parts[2]))
                    cart_coords.append([float(parts[3]), float(parts[4]), float(parts[5])])
            except ValueError:
                pass
        elif ncol >= 5:
            atom_types.append(int(parts[1]))
            charges.append(0.0)
            cart_coords.append([float(parts[2]), float(parts[3]), float(parts[4])])

    return {
        "cell": cell,
        "elements": [unique_elements[t - 1] if t <= len(unique_elements) else f"Type{t}" for t in atom_types],
        "unique_elements": unique_elements,
        "element_to_type": element_to_type,
        "atom_types": atom_types,
        "cart_coords": np.array(cart_coords) if cart_coords else np.zeros((0, 3)),
        "charges": charges,
        "n_atoms": n_atoms or len(atom_rows),
        "n_types": n_types or len(unique_elements),
    }


def parse_lammps_log(log_content: str) -> list:
    """Parse LAMMPS log file for thermodynamic output.

    Looks for thermo output blocks and extracts step, temp, press, pe, ke, etotal, vol.
    Returns list of dicts (imported as ThermoData by callers).
    """
    from .simulation import ThermoData

    thermo_data = []
    lines = log_content.split("\n")

    # Find thermo header
    header_idx = None
    headers = []
    for i, line in enumerate(lines):
        if "Step" in line:
            parts = line.split()
            if "Temp" in parts:
                header_idx = i
                headers = parts
                break

    if header_idx is None:
        return thermo_data

    # Map column names to indices
    col_map = {}
    for idx, header in enumerate(headers):
        lower = header.lower()
        if "step" in lower:
            col_map["step"] = idx
        elif "temp" in lower:
            col_map["temp"] = idx
        elif "press" in lower:
            col_map["press"] = idx
        elif "pe" in lower or "PotEng" in lower:
            col_map["pe"] = idx
        elif "ke" in lower or "KinEng" in lower:
            col_map["ke"] = idx
        elif "totale" in lower or "TotEng" in lower:
            col_map["etotal"] = idx
        elif "vol" in lower or "Volume" in lower:
            col_map["vol"] = idx

    # Parse data lines
    for i in range(header_idx + 1, len(lines)):
        line = lines[i].strip()
        if not line or line.startswith(("Loop", "WARNING", "ERROR", "=")):
            continue

        parts = line.split()
        if len(parts) < len(headers):
            continue

        try:
            data = ThermoData(
                step=int(parts[col_map.get("step", 0)]) if "step" in col_map else 0,
                temp=float(parts[col_map["temp"]]) if "temp" in col_map else None,
                press=float(parts[col_map["press"]]) if "press" in col_map else None,
                pe=float(parts[col_map["pe"]]) if "pe" in col_map else None,
                ke=float(parts[col_map["ke"]]) if "ke" in col_map else None,
                etotal=float(parts[col_map["etotal"]]) if "etotal" in col_map else None,
                vol=float(parts[col_map["vol"]]) if "vol" in col_map else None,
            )
            thermo_data.append(data)
        except (ValueError, IndexError):
            continue

    return thermo_data


def parse_lammps_dump(dump_content: str) -> list[dict]:
    """Parse LAMMPS dump file to extract trajectory frames.

    Returns list of frames with atoms data (id, type, x, y, z).
    """
    frames = []
    lines = dump_content.split("\n")
    i = 0

    while i < len(lines):
        # Find ITEM: TIMESTEP
        while i < len(lines) and "ITEM: TIMESTEP" not in lines[i]:
            i += 1
        if i >= len(lines):
            break

        i += 1
        if i >= len(lines):
            break
        timestep = int(lines[i].strip())
        i += 1

        # ITEM: NUMBER OF ATOMS
        while i < len(lines) and "ITEM: NUMBER OF ATOMS" not in lines[i]:
            i += 1
        if i >= len(lines):
            break
        i += 1
        natoms = int(lines[i].strip())
        i += 1

        # ITEM: BOX (or BOX BOUNDS)
        box_bounds = None
        while i < len(lines) and "ITEM: BOX" not in lines[i]:
            i += 1
        if i < len(lines):
            i += 1
            # Parse box bounds (simplified - read next 2 or 3 lines)
            box_bounds = []
            for _ in range(2 if "BOUNDS" in lines[i-1] else 3):
                if i < len(lines):
                    box_bounds.append(lines[i].strip())
                    i += 1

        # ITEM: ATOMS
        while i < len(lines) and "ITEM: ATOMS" not in lines[i]:
            i += 1
        if i >= len(lines):
            break
        i += 1

        # Parse atom lines
        atoms = []
        for _ in range(natoms):
            if i >= len(lines):
                break
            parts = lines[i].strip().split()
            if len(parts) >= 5:  # id type x y z minimum
                atoms.append({
                    "id": int(parts[0]),
                    "type": int(parts[1]),
                    "x": float(parts[2]),
                    "y": float(parts[3]),
                    "z": float(parts[4]),
                })
            i += 1

        frames.append({
            "timestep": timestep,
            "natoms": natoms,
            "box_bounds": box_bounds,
            "atoms": atoms,
        })

    return frames

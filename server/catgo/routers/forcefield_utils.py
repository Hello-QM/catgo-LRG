"""Force field conversion helper functions.

Extracted from forcefield.py for maintainability. Contains all tool-checking,
parsing, Open Babel, antechamber, mol22lt, and moltemplate helper functions.
"""

__all__ = [
    "FORCE_FIELD_FILES",
    "FORCE_FIELD_SETTINGS",
    "MOLTEMPLATE_DIR",
    "OPENBABEL_AVAILABLE",
    "get_ff_settings",
    "_check_tools_available",
    "_check_openbabel_available",
    "_convert_with_antechamber_and_moltemplate",
    "_convert_with_openbabel",
]

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Try to import Open Babel (optional dependency)
try:
    from openbabel import openbabel as ob
    OPENBABEL_AVAILABLE = True
    logger.info("Open Babel is available for force field conversion")
except ImportError:
    OPENBABEL_AVAILABLE = False
    logger.info("Open Babel not available. Force field conversion will use alternative methods.")


# ============================================================================
# Configuration
# ============================================================================

MOLTEMPLATE_DIR = Path("/Users/chem/Downloads/moltemplate-master")
MOL22LT_SCRIPT = MOLTEMPLATE_DIR / "moltemplate/mol22lt.py"
MOLTEMPLATE_SCRIPT = MOLTEMPLATE_DIR / "moltemplate/scripts/moltemplate.sh"

# Force field file paths
FORCE_FIELD_FILES = {
    "gaff2": MOLTEMPLATE_DIR / "moltemplate/force_fields/gaff2.lt",
    "gaff": MOLTEMPLATE_DIR / "moltemplate/force_fields/gaff.lt",
    "oplsaa": MOLTEMPLATE_DIR / "moltemplate/force_fields/oplsaa.lt",
}


def _get_forcefield_file(force_field: str) -> Path:
    """Get the moltemplate force field file path for a given force field."""
    ff_key = force_field.lower()
    if ff_key not in FORCE_FIELD_FILES:
        raise ValueError(f"Unsupported force field: {force_field}. Supported: {list(FORCE_FIELD_FILES.keys())}")
    return FORCE_FIELD_FILES[ff_key]


# Standard LAMMPS settings for each force field.
# Used by both the Open Babel init-file generators and the workflow engine
# fallback so that pair_style, kspace_style, and special_bonds are always
# correct for the chosen force field.
FORCE_FIELD_SETTINGS: dict[str, dict[str, str]] = {
    # GAFF2 — AMBER General Force Field v2
    # Arithmetic (Lorentz-Berthelot) combining rules; 1-4 scaling 0.5/0.5 (amber keyword)
    "gaff2": {
        "bond_style":     "harmonic",
        "angle_style":    "harmonic",
        "dihedral_style": "fourier",
        "improper_style": "cvff",
        "pair_style":     "lj/charmm/coul/long 10.0 12.0",
        "pair_modify":    "mix arithmetic",
        "special_bonds":  "amber",          # lj/coul 0.0 0.0 0.5
        "kspace_style":   "pppm 0.0001",
    },
    # GAFF — AMBER General Force Field (original)
    # Same rules as GAFF2
    "gaff": {
        "bond_style":     "harmonic",
        "angle_style":    "harmonic",
        "dihedral_style": "fourier",
        "improper_style": "cvff",
        "pair_style":     "lj/charmm/coul/long 10.0 12.0",
        "pair_modify":    "mix arithmetic",
        "special_bonds":  "amber",
        "kspace_style":   "pppm 0.0001",
    },
    # OPLS-AA — Optimized Potentials for Liquid Simulations (All-Atom)
    # Geometric combining rules; 1-4 scaling 0.5/0.5; cvff impropers
    "oplsaa": {
        "bond_style":     "harmonic",
        "angle_style":    "harmonic",
        "dihedral_style": "opls",
        "improper_style": "cvff",
        "pair_style":     "lj/charmm/coul/long 10.0 12.0",
        "pair_modify":    "mix geometric",
        "special_bonds":  "lj/coul 0.0 0.0 0.5",
        "kspace_style":   "pppm 0.0001",
    },
    # COMPASS — Condensed-phase Optimized Molecular Potentials for Atomistic Simulation Studies
    # Class2 force field; sixth-power (6th-power) combining rules; no 1-4 exclusions
    "compass": {
        "bond_style":     "class2",
        "angle_style":    "class2",
        "dihedral_style": "class2",
        "improper_style": "class2",
        "pair_style":     "lj/class2/coul/long 12.0",
        "pair_modify":    "mix sixthpower",
        "special_bonds":  "lj/coul 0.0 0.0 1.0",
        "kspace_style":   "pppm 0.0001",
    },
    # MMFF94 — Merck Molecular Force Field 94
    # Geometric combining rules; 1-4 scaling 0.75/0.75
    "mmff94": {
        "bond_style":     "harmonic",
        "angle_style":    "harmonic",
        "dihedral_style": "fourier",
        "improper_style": "umbrella",
        "pair_style":     "lj/charmm/coul/long 10.0 12.0",
        "pair_modify":    "mix geometric",
        "special_bonds":  "lj/coul 0.0 0.0 0.75",
        "kspace_style":   "pppm 0.0001",
    },
    # UFF — Universal Force Field
    # Geometric combining rules; no Coulomb long-range (uncharged by default); no 1-4 exclusions
    "uff": {
        "bond_style":     "harmonic",
        "angle_style":    "cosine/periodic",
        "dihedral_style": "cosine/periodic",
        "improper_style": "umbrella",
        "pair_style":     "lj/cut 12.0",
        "pair_modify":    "mix geometric",
        "special_bonds":  "lj 0.0 0.0 1.0",
        "kspace_style":   "",
    },
}

# Fallback used when the force field key is not in FORCE_FIELD_SETTINGS
_DEFAULT_FF_SETTINGS = FORCE_FIELD_SETTINGS["gaff2"]


def get_ff_settings(force_field: str) -> dict[str, str]:
    """Return the canonical LAMMPS settings dict for *force_field*."""
    return FORCE_FIELD_SETTINGS.get(force_field.lower(), _DEFAULT_FF_SETTINGS)


def _build_ff_init_lines(
    ffs: dict[str, str],
    force_field: str,
    generator_label: str = "",
) -> list[str]:
    """Build the LAMMPS init-file lines from a force-field settings dict.

    Order follows LAMMPS convention:
      units / atom_style
      bond/angle/dihedral/improper_style   (before read_data)
      pair_style / pair_modify             (before read_data)
      special_bonds                        (MUST be before read_data)
      kspace_style                         (before read_data)
      read_data
      neighbor / neigh_modify
    """
    tag = f" ({generator_label})" if generator_label else ""
    lines = [
        f"# LAMMPS init script for {force_field.upper()} force field",
        f"# Generated by CatGo{tag}",
        f"",
        f"units           real",
        f"atom_style      full",
        f"",
        f"bond_style      {ffs['bond_style']}",
        f"angle_style     {ffs['angle_style']}",
        f"dihedral_style  {ffs['dihedral_style']}",
    ]

    if ffs.get("improper_style"):
        lines.append(f"improper_style  {ffs['improper_style']}")

    lines.extend([
        f"",
        f"pair_style      {ffs['pair_style']}",
    ])

    if ffs.get("pair_modify"):
        lines.append(f"pair_modify     {ffs['pair_modify']}")

    lines.append(f"special_bonds   {ffs['special_bonds']}")

    if ffs.get("kspace_style"):
        lines.append(f"kspace_style    {ffs['kspace_style']}")

    lines.extend([
        f"",
        f"read_data       system.data",
        f"",
        f"neighbor        2.0 bin",
        f"neigh_modify    delay 0 every 1 check yes",
    ])

    return lines


# ============================================================================
# Tool availability checks
# ============================================================================


def _check_tools_available() -> bool:
    """Check if required tools are available."""
    has_antechamber = shutil.which("antechamber") is not None
    has_parmchk2 = shutil.which("parmchk2") is not None
    has_python = shutil.which("python3") is not None
    has_moltemplate = MOLTEMPLATE_DIR.exists() and MOL22LT_SCRIPT.exists()

    return all([has_antechamber, has_parmchk2, has_python, has_moltemplate])


def _check_openbabel_available() -> bool:
    """Check if Open Babel is available (Python bindings or CLI)."""
    if OPENBABEL_AVAILABLE:
        try:
            # Test basic functionality
            ob.OBError()
            return True
        except Exception:
            pass
    # Check for CLI tool as fallback
    return shutil.which("obabel") is not None


def _get_obabel_cmd() -> Optional[str]:
    """Get the Open Babel command-line tool path."""
    return shutil.which("obabel")


# ============================================================================
# Parsing helpers
# ============================================================================


def _parse_pdb_atoms(pdb_content: str) -> list[dict]:
    """Parse PDB file and return basic atom information."""
    atoms = []
    for line in pdb_content.split('\n'):
        if line.startswith('ATOM') or line.startswith('HETATM'):
            element = line[76:78].strip() or line[12:16].strip()[0]
            x = float(line[30:38].strip())
            y = float(line[38:46].strip())
            z = float(line[46:54].strip())
            atoms.append({
                'element': element,
                'x': x, 'y': y, 'z': z,
            })
    return atoms


def _estimate_molecular_mass(atoms: list[dict]) -> float:
    """Estimate molecular mass from atom composition."""
    masses = {'H': 1.008, 'C': 12.011, 'N': 14.007, 'O': 15.999,
              'F': 18.998, 'P': 30.974, 'S': 32.06, 'Cl': 35.45,
              'Si': 28.085, 'Na': 22.990, 'Mg': 24.305}
    mass = sum(masses.get(a['element'], 12.011) for a in atoms)
    return mass


# ============================================================================
# Antechamber functions
# ============================================================================


def _get_antechamber_charge_flag(charge_method: str) -> str:
    """Get antechamber charge method flag.

    From antechamber -L:
    - resp: RESP charge
    - bcc: AM1-BCC charge
    - gas: Gasteiger charge
    - dc: Delete charge (set to zero)
    """
    charge_flags = {
        "gasteiger": "gas",     # Gasteiger
        "am1bcc": "bcc",        # AM1-BCC
        "zero": "dc",           # Delete charge (zero)
    }
    return charge_flags.get(charge_method, "gas")


def _run_antechamber(
    input_file: Path,
    input_format: str = "pdb",
    charge_method: str = "gasteiger",
    force_field: str = "gaff2",
) -> tuple[Path, Optional[Path]]:
    """
    Run antechamber to generate MOL2 file with GAFF atom types.

    Can process PDB, MOL2, and XYZ input files. If input already has
    GAFF atom types, it will preserve them; otherwise it will assign
    new GAFF atom types based on the structure.

    Args:
        input_file: Path to input structure file (PDB, MOL2, or XYZ)
        input_format: "pdb", "mol2", or "xyz"
        charge_method: Gasteiger, AM1-BCC, or zero
        force_field: gaff2, gaff, or oplsaa

    Returns:
        (mol2_file_path, frcmod_file_path or None)
    """
    mol2_file = input_file.with_suffix('.out.mol2')
    frcmod_file = None

    # Build antechamber command
    ac_cmd = [
        "antechamber",
        "-i", str(input_file),
        "-fi", input_format,
        "-o", str(mol2_file),
        "-fo", "mol2",
        "-c", _get_antechamber_charge_flag(charge_method),
        "-s", "2",  # Status level
        "-rn", "MOL",  # Residue name
    ]

    # Add force field flag
    if force_field == "gaff2":
        ac_cmd.extend(["-at", "gaff2"])
    elif force_field == "gaff":
        ac_cmd.extend(["-at", "gaff"])

    try:
        result = subprocess.run(
            ac_cmd,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            logger.warning(f"antechamber output: {result.stderr}")
            # Check if output file was still created despite warnings
            if not mol2_file.exists():
                raise RuntimeError(f"antechamber failed: {result.stderr}")
    except subprocess.TimeoutExpired:
        raise RuntimeError("antechamber timed out after 60 seconds")

    # Generate frcmod file if using GAFF/GAFF2
    if force_field in ("gaff2", "gaff"):
        frcmod_file = mol2_file.with_suffix('.frcmod')
        pc_cmd = [
            "parmchk2",
            "-i", str(mol2_file),
            "-f", "mol2",
            "-o", str(frcmod_file),
        ]

        try:
            subprocess.run(pc_cmd, capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            logger.warning("parmchk2 timed out, using default parameters")
            frcmod_file = None

    return mol2_file, frcmod_file


# ============================================================================
# Open Babel functions
# ============================================================================


def _get_openbabel_forcefield_name(force_field: str) -> Optional[str]:
    """Get Open Babel force field name.

    Maps our force field names to Open Babel's internal names.
    """
    ff_mapping = {
        "oplsaa": "OPLSAA",
        "mmff94": "MMFF94",
        "mmff94s": "MMFF94s",
        "uff": "UFF",
        "ghemical": "Ghemical",
    }
    return ff_mapping.get(force_field.lower())


def _get_openbabel_charge_method(charge_method: str) -> int:
    """Get Open Babel charge method constant.

    Returns:
        Open Babel charge method constant (e.g., 7 for Gasteiger)
    """
    # Open Babel charge method constants
    # 0: No charges
    # 5: MMFF94 charges
    # 7: Gasteiger (partial charges)
    charge_methods = {
        "zero": 0,
        "mmff94": 5,
        "gasteiger": 7,
    }
    return charge_methods.get(charge_method.lower(), 7)  # Default to Gasteiger


def _convert_with_openbabel_cli(
    structure_content: str,
    structure_format: str,
    force_field: str,
    charge_method: str,
    num_molecules: int,
    box_mode: str,
    box_size: str,
    density: float,
    temp_dir: Path,
    ob_cmd: str,
) -> tuple[str, str, list[str]]:
    """
    Convert structure to LAMMPS using Open Babel CLI tool (fallback when Python bindings unavailable).
    """
    warnings: list[str] = []

    # Ensure temp directory exists
    temp_dir.mkdir(parents=True, exist_ok=True)

    # Write input file
    format_map = {"pdb": "pdb", "mol2": "mol2", "xyz": "xyz"}
    in_format = format_map.get(structure_format.lower(), "pdb")
    input_file = temp_dir / f"input.{in_format}"

    # For XYZ format, ensure it has a comment line after the atom count
    if in_format == "xyz":
        lines = structure_content.strip().split('\n')
        # Find the first line that's a number (atom count)
        atom_count_idx = -1
        for i, line in enumerate(lines):
            if line.strip().isdigit():
                atom_count_idx = i
                break

        if atom_count_idx >= 0:
            atom_count = int(lines[atom_count_idx].strip())
            # Check if next line exists and is a comment (not an atom line)
            # Atom lines start with element symbols (H, C, N, O, etc.)
            has_comment = False
            if atom_count_idx + 1 < len(lines):
                next_line = lines[atom_count_idx + 1].strip()
                # Check if next line is NOT an atom line (doesn't start with element symbol)
                element_symbols = {'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
                                  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
                                  'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
                                  'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Zr'}
                has_comment = next_line and not next_line[0].upper() in element_symbols

            if not has_comment:
                # Insert comment line after atom count
                comment = "molecule"
                lines.insert(atom_count_idx + 1, comment)
                # Trim to correct number of atom lines
                atom_lines = []
                for line in lines[atom_count_idx + 1:]:
                    line = line.strip()
                    # Check if this looks like an atom line (starts with element)
                    if line and line[0].upper() in element_symbols:
                        atom_lines.append(line)
                        if len(atom_lines) >= atom_count:
                            break
                structure_content = f"{lines[atom_count_idx]}\n{comment}\n" + "\n".join(atom_lines[:atom_count])

        input_file.write_text(structure_content)
    else:
        input_file.write_text(structure_content)

    # Convert to MOL2 with charges using obabel
    mol2_file = temp_dir / "output.mol2"
    charge_flag = "--charges" if charge_method in ("gasteiger", "mmff94") else "--nocharges"

    try:
        # obabel syntax: obabel input.xyz -omol2 -Ooutput.mol2 --charges
        result = subprocess.run(
            [ob_cmd, str(input_file), "-omol2", "-O", str(mol2_file), charge_flag],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            warnings.append(f"obabel warning: {result.stderr}")
            # Try without charges flag if it failed
            result = subprocess.run(
                [ob_cmd, str(input_file), "-omol2", "-O", str(mol2_file)],
                capture_output=True,
                text=True,
                timeout=30,
            )
    except subprocess.TimeoutExpired:
        warnings.append("obabel timed out, using partial output")

    if not mol2_file.exists():
        raise RuntimeError(f"Failed to convert {in_format} to MOL2 with obabel")

    mol2_content = mol2_file.read_text()

    # Parse MOL2 to extract atom data
    atoms = []
    atom_types = {}
    charges = {}

    in_atoms = False
    for line in mol2_content.split('\n'):
        if line.startswith('@<TRIPOS>ATOM'):
            in_atoms = True
            continue
        if line.startswith('@') and in_atoms:
            in_atoms = False
            continue
        if in_atoms and line.strip():
            parts = line.split()
            if len(parts) >= 9:
                # MOL2 format: idx atom_name x y z type stereo mol_name charge
                # Each column: 1(id) C(name) x y z C.3(type) 1(stereo) UNL1(mol) -0.0418(charge)
                try:
                    atom_id = parts[0].strip()
                    atom_name = parts[1].strip()
                    x, y, z = float(parts[2]), float(parts[3]), float(parts[4])
                    elem = atom_name[0].upper() if atom_name else 'C'  # Get element symbol
                    charge = float(parts[-1]) if len(parts) > 8 else 0.0

                    # Simple atom typing based on element
                    atom_type = f"{elem}"

                    atoms.append({
                        "idx": int(atom_id),
                        "type": atom_type,
                        "element": elem,
                        "x": x, "y": y, "z": z,
                        "charge": charge,
                    })
                except (ValueError, IndexError) as e:
                    warnings.append(f"Failed to parse MOL2 atom line: {line.strip()} - {e}")
                    continue

                if atom_type not in atom_types:
                    # Simple atomic masses
                    masses = {
                        'H': 1.008, 'C': 12.011, 'N': 14.007, 'O': 15.999,
                        'F': 18.998, 'P': 30.974, 'S': 32.06, 'Cl': 35.45,
                        'Br': 79.904, 'I': 126.904, 'Si': 28.085,
                    }
                    atom_types[atom_type] = masses.get(elem, 12.011)

    num_atoms = len(atoms)

    # Calculate box size from density if needed
    if box_mode == "density":
        # Calculate mass from atom types
        masses = {
            'H': 1.008, 'C': 12.011, 'N': 14.007, 'O': 15.999,
            'F': 18.998, 'P': 30.974, 'S': 32.06, 'Cl': 35.45,
            'Br': 79.904, 'I': 126.904, 'Si': 28.085,
        }
        total_mass = sum(masses.get(a.get("element", "C"), 12.011) for a in atoms)
        volume_cm3 = (num_molecules * total_mass) / (density * 6.022e23)
        volume_angstrom3 = volume_cm3 * 1e24
        box_len = volume_angstrom3 ** (1/3)
        box_size = f"{box_len:.2f} {box_len:.2f} {box_len:.2f}"

    # Parse box size (format: "x y z" in Angstroms, box is centered at origin)
    try:
        box_x, box_y, box_z = [float(x) for x in box_size.split()]
        # Box is centered at origin, so bounds are +/- half the box size
        xlo, ylo, zlo = -box_x/2, -box_y/2, -box_z/2
        xhi, yhi, zhi = box_x/2, box_y/2, box_z/2
    except ValueError:
        xlo = ylo = zlo = -10.0
        xhi = yhi = zhi = 10.0

    # Simple bond detection based on distance
    bond_data = []
    for i in range(len(atoms)):
        for j in range(i + 1, len(atoms)):
            a1, a2 = atoms[i], atoms[j]
            dx, dy, dz = a1["x"] - a2["x"], a1["y"] - a2["y"], a1["z"] - a2["z"]
            dist = (dx*dx + dy*dy + dz*dz) ** 0.5
            # Simple distance-based bond detection
            max_dist = 1.7  # Typical single bond length
            if dist < max_dist:
                bond_order = 1 if dist > 1.4 else (2 if dist > 1.3 else 3)
                bond_data.append({"idx1": i + 1, "idx2": j + 1, "order": bond_order})

    # Generate LAMMPS data file
    num_atom_types = len(atom_types)

    # Calculate bond info
    num_bonds = len(bond_data)
    num_bond_types = len(set(b["order"] for b in bond_data)) if bond_data else 1

    data_lines = [
        f"# LAMMPS data file generated by CatGo with Open Babel (CLI mode)",
        f"# Force field: {force_field.upper()}",
        f"",
        f"{num_atoms * num_molecules} atoms",
        f"{num_atom_types} atom types",
        f"{num_bonds * num_molecules} bonds" if num_bonds > 0 else f"{num_bonds} bonds",
        f"{num_bond_types} bond types" if num_bonds > 0 else f"{num_bond_types} bond types",
        f"",
        f"{xlo:.4f} {xhi:.4f} xlo xhi",
        f"{ylo:.4f} {yhi:.4f} ylo yhi",
        f"{zlo:.4f} {zhi:.4f} zlo zhi",
        f"",
        f"Masses",
        f"",
    ]

    for i, (atom_type, mass) in enumerate(sorted(atom_types.items()), 1):
        data_lines.append(f"{i:4d} {mass:10.4f}  # {atom_type}")

    type_to_idx = {t: i for i, t in enumerate(sorted(atom_types.keys()), 1)}

    # Write atoms
    data_lines.extend([
        f"",
        f"Atoms",
        f"",
    ])

    for mol_idx in range(num_molecules):
        offset = mol_idx * num_atoms
        for atom in atoms:
            idx = atom["idx"] + offset
            type_idx = type_to_idx[atom["type"]]
            if num_molecules > 1:
                grid_size = int(num_molecules ** (1/3)) + 1
                mx = (mol_idx % grid_size) * (xhi - xlo) / grid_size
                my = ((mol_idx // grid_size) % grid_size) * (yhi - ylo) / grid_size
                mz = (mol_idx // (grid_size * grid_size)) * (zhi - zlo) / grid_size
                x = atom["x"] + mx
                y = atom["y"] + my
                z = atom["z"] + mz
            else:
                x, y, z = atom["x"], atom["y"], atom["z"]

            data_lines.append(f"{idx:4d} {mol_idx + 1:4d} {type_idx:4d} {atom['charge']:10.6f} {x:12.6f} {y:12.6f} {z:12.6f}")

    # Write bonds (without Bond Coeffs - use input script for coefficients)
    if bond_data:
        bond_type_map = {1: 1, 2: 2, 3: 3}
        data_lines.extend([
            f"",
            f"Bonds",
            f"",
        ])
        for i, bond in enumerate(bond_data, 1):
            btype = bond_type_map.get(bond["order"], 1)
            data_lines.append(f"{i:4d} {btype:4d} {bond['idx1']:4d} {bond['idx2']:4d}")

    # Generate init file with correct force-field-specific settings
    ffs = get_ff_settings(force_field)
    init_lines = _build_ff_init_lines(ffs, force_field, "CLI mode")

    return "\n".join(data_lines), "\n".join(init_lines), warnings


def _convert_with_openbabel(
    structure_content: str,
    structure_format: str = "pdb",
    force_field: str = "oplsaa",
    charge_method: str = "gasteiger",
    num_molecules: int = 1,
    box_mode: str = "size",
    box_size: str = "20 20 20",
    density: float = 1.0,
) -> tuple[str, str, list[str]]:
    """
    Convert structure to LAMMPS using Open Babel for force field typing.

    Open Babel supports OPLS-AA, MMFF94, UFF, and other force fields.
    This function generates a LAMMPS data file with proper atom types,
    charges, and parameters for the selected force field.

    Uses Python bindings if available, otherwise falls back to obabel CLI.

    Args:
        structure_content: PDB, MOL2, or XYZ file content
        structure_format: "pdb", "mol2", or "xyz"
        force_field: oplsaa, mmff94, mmff94s, uff, ghemical
        charge_method: gasteiger, mmff94, zero
        num_molecules: Number of molecules
        box_mode: "size" or "density"
        box_size: Box size in Å
        density: Target density in g/cm³

    Returns:
        (data_file_content, init_file_content, warnings_list)
    """
    warnings: list[str] = []
    temp_dir = Path(tempfile.mkdtemp())

    try:
        # Check if we should use Python bindings or CLI
        use_python_bindings = OPENBABEL_AVAILABLE
        ob_cmd = _get_obabel_cmd()

        if not use_python_bindings and not ob_cmd:
            raise RuntimeError("Open Babel is not available. Install with: pip install openbabel or brew install openbabel")

        # If Python bindings are not available, use CLI fallback
        if not use_python_bindings and ob_cmd:
            return _convert_with_openbabel_cli(
                structure_content, structure_format, force_field, charge_method,
                num_molecules, box_mode, box_size, density, temp_dir, ob_cmd
            )

        # Use Python bindings (existing code)
        # Parse input format for Open Babel
        format_map = {"pdb": "pdb", "mol2": "mol2", "xyz": "xyz"}
        ob_format = format_map.get(structure_format.lower(), "pdb")

        # Create Open Babel molecule
        mol = ob.OBMol()
        ob_conv = ob.OBConversion()
        ob_conv.SetInFormat(ob_format)

        if not ob_conv.ReadString(mol, structure_content):
            raise RuntimeError(f"Failed to parse {structure_format.upper()} content with Open Babel")

        # Assign force field
        ff_name = _get_openbabel_forcefield_name(force_field)
        if not ff_name:
            raise RuntimeError(f"Unsupported force field for Open Babel: {force_field}")

        ff = ob.OBForceField.FindForceField(ff_name)
        if not ff:
            raise RuntimeError(f"Force field {ff_name} not found in Open Babel")

        # Setup force field
        if not ff.Setup(mol):
            # Try with warnings
            warnings.append(f"Force field setup had issues for {ff_name}, continuing anyway")
            ff = ob.OBForceField.FindForceField("UFF")  # Fallback to UFF
            if not ff or not ff.Setup(mol):
                raise RuntimeError("Failed to setup any force field")

        # Assign charges
        charge_method_code = _get_openbabel_charge_method(charge_method)
        if charge_method_code > 0:
            mol.DeleteData(ob.ChargeSet())  # Clear existing charges
            if not ff.ComputeCharges(mol, charge_method_code):
                warnings.append(f"Charge calculation ({charge_method}) may have failed")

        # Get atom types, masses, charges
        num_atoms = mol.NumAtoms()
        atom_data = []
        type_masses: dict[str, float] = {}
        type_charges: dict[str, float] = {}

        for i in range(1, num_atoms + 1):
            atom = mol.GetAtom(i)
            element = ob.OBElementTable().GetSymbol(atom.GetAtomicNum())
            x, y, z = atom.GetX(), atom.GetY(), atom.GetZ()
            charge = atom.GetPartialCharge()
            mass = atom.GetAtomicMass()

            # For OPLS-AA, get atom type from residue info or element
            if force_field == "oplsaa":
                # OPLS-AA uses specific atom types - use element + hybridization as proxy
                hybrid = atom.GetHyb()
                atom_type = f"{element}_{hybrid}"
            else:
                atom_type = element

            atom_data.append({
                "idx": i,
                "type": atom_type,
                "element": element,
                "x": x, "y": y, "z": z,
                "charge": charge,
                "mass": mass,
            })

            # Collect unique types
            if atom_type not in type_masses:
                type_masses[atom_type] = mass
                type_charges[atom_type] = charge

        # Detect bonds (simple distance-based)
        bond_data = []
        mol.ConnectTheDots()  # Simple bond detection
        mol.PerceiveBondOrders()  # Assign bond orders

        for bond in ob.OBMolBondIter(mol):
            idx1 = bond.GetBeginAtomIdx()
            idx2 = bond.GetEndAtomIdx()
            bond_order = bond.GetBondOrder()
            if bond_order > 0:
                bond_data.append({
                    "idx1": idx1,
                    "idx2": idx2,
                    "order": bond_order,
                })

        # Calculate box size from density if needed
        if box_mode == "density":
            total_mass = sum(a["mass"] for a in atom_data)
            # Volume from density: V = (n * M) / (density * NA)
            volume_cm3 = (num_molecules * total_mass) / (density * 6.022e23)
            volume_angstrom3 = volume_cm3 * 1e24
            box_len = volume_angstrom3 ** (1/3)
            box_size = f"{box_len:.2f} {box_len:.2f} {box_len:.2f}"
            logger.info(f"Calculated box size: {box_size} Å from density {density} g/cm³")

        # Parse box size (format: "x y z" in Angstroms, box is centered at origin)
        try:
            box_x, box_y, box_z = [float(x) for x in box_size.split()]
            # Box is centered at origin, so bounds are +/- half the box size
            xlo, ylo, zlo = -box_x/2, -box_y/2, -box_z/2
            xhi, yhi, zhi = box_x/2, box_y/2, box_z/2
        except ValueError:
            xlo = ylo = zlo = -10.0
            xhi = yhi = zhi = 10.0

        # Generate LAMMPS data file
        num_atom_types = len(type_masses)
        num_bonds = len(bond_data)
        num_bond_types = len(set(b["order"] for b in bond_data))

        data_lines = [
            f"# LAMMPS data file generated by CatGo with Open Babel",
            f"# Force field: {force_field.upper()}, Charge method: {charge_method}",
            f"",
            f"{num_atoms * num_molecules} atoms",
            f"{num_atom_types} atom types",
            f"{num_bonds * num_molecules} bonds",
            f"{num_bond_types} bond types",
            f"",
            f"{xlo:.4f} {xhi:.4f} xlo xhi",
            f"{ylo:.4f} {yhi:.4f} ylo yhi",
            f"{zlo:.4f} {zhi:.4f} zlo zhi",
            f"",
            f"Masses",
            f"",
        ]

        # Write masses
        for i, (atom_type, mass) in enumerate(sorted(type_masses.items()), 1):
            data_lines.append(f"{i:4d} {mass:10.4f}  # {atom_type}")

        # Write atoms (with type mapping)
        type_to_idx = {t: i for i, t in enumerate(sorted(type_masses.keys()), 1)}
        data_lines.extend([
            f"",
            f"Atoms",
            f"",
        ])

        for mol_idx in range(num_molecules):
            offset = mol_idx * num_atoms
            for atom in atom_data:
                idx = atom["idx"] + offset
                type_idx = type_to_idx[atom["type"]]
                # Center molecules in box for multi-molecule systems
                if num_molecules > 1:
                    # Simple grid layout for multiple molecules
                    grid_size = int(num_molecules ** (1/3)) + 1
                    mx = (mol_idx % grid_size) * (xhi - xlo) / grid_size
                    my = ((mol_idx // grid_size) % grid_size) * (yhi - ylo) / grid_size
                    mz = (mol_idx // (grid_size * grid_size)) * (zhi - zlo) / grid_size
                    x = atom["x"] + mx
                    y = atom["y"] + my
                    z = atom["z"] + mz
                else:
                    x, y, z = atom["x"], atom["y"], atom["z"]

                data_lines.append(
                    f"{idx:4d} {mol_idx + 1:4d} {type_idx:4d} "
                    f"{atom['charge']:10.6f} {x:12.6f} {y:12.6f} {z:12.6f}"
                )

        # Write bonds
        if bond_data:
            bond_type_map = {1.0: 1, 2.0: 2, 3.0: 3}  # Simple mapping
            data_lines.extend([
                f"",
                f"Bond Coeffs",
                f"",
            ])
            for bond_order in sorted(set(b["order"] for b in bond_data)):
                btype = bond_type_map.get(bond_order, 1)
                # Default bond strength (would need proper force field params)
                k = 350.0 if bond_order == 1 else (600.0 if bond_order == 2 else 800.0)
                req = 1.53 if bond_order == 1 else (1.34 if bond_order == 2 else 1.20)
                data_lines.append(f"{btype:4d} {k:10.2f} {req:10.6f}  # bond order {int(bond_order)}")

            data_lines.extend([
                f"",
                f"Bonds",
                f"",
            ])

            for mol_idx in range(num_molecules):
                offset = mol_idx * num_atoms
                atom_offset = mol_idx * num_atoms
                for bond in bond_data:
                    idx1 = bond["idx1"] + atom_offset
                    idx2 = bond["idx2"] + atom_offset
                    btype = bond_type_map.get(bond["order"], 1)
                    bond_idx = len(data_lines) - len([l for l in data_lines if l.startswith("    ")]) + 1
                    data_lines.append(f"{bond_idx:4d} {btype:4d} {idx1:4d} {idx2:4d}")

        # Generate init file with correct force-field-specific settings
        ffs = get_ff_settings(force_field)
        init_lines = _build_ff_init_lines(ffs, force_field)

        return "\n".join(data_lines), "\n".join(init_lines), warnings

    finally:
        # Clean up temp directory
        shutil.rmtree(temp_dir, ignore_errors=True)


# ============================================================================
# Moltemplate functions
# ============================================================================


def _run_mol22lt(
    mol2_file: Path,
    molecule_name: str = "Molecule",
    force_field: str = "gaff2",
    charges_file: Optional[Path] = None,
) -> Path:
    """
    Run mol22lt.py to convert MOL2 to moltemplate .lt format.

    Returns:
        Path to the generated .lt file
    """
    lt_file = mol2_file.parent / f"{molecule_name}.lt"
    ff_file = _get_forcefield_file(force_field)

    cmd = [
        "python3",
        str(MOL22LT_SCRIPT),
        "--in", str(mol2_file),
        "--out", str(lt_file),
        "--name", molecule_name,
        "--ff", force_field.upper(),
        "--ff-file", str(ff_file),
    ]

    if charges_file:
        cmd.extend(["-charge", str(charges_file)])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"mol22lt.py failed: {result.stderr}")
    except subprocess.TimeoutExpired:
        raise RuntimeError("mol22lt.py timed out after 30 seconds")

    return lt_file


def _create_system_lt(
    molecule_lt_file: Path,
    molecule_name: str = "Molecule",
    num_molecules: int = 1,
    box_mode: str = "size",
    box_size: str = "20 20 20",
    density: float = 1.0,
) -> Path:
    """
    Create the system.lt file for moltemplate.

    Returns:
        Path to the generated system.lt file
    """
    system_lt_file = molecule_lt_file.parent / "system.lt"

    # Parse molecule file to get atom count for density calculation
    with open(molecule_lt_file) as f:
        content = f.read()

    # Count atom definitions (look for $atom lines)
    num_atoms = content.count('$atom:')

    # Calculate box size from density if needed
    if box_mode == "density":
        # Estimate mass from element types
        mass = 0.0
        for line in content.split('\n'):
            if '$atom:' in line and '@atom:' in line:
                # Extract element from @atom type
                for element in ['C', 'H', 'N', 'O', 'F', 'P', 'S', 'Cl']:
                    if f'@atom:{element.lower()}' in line.lower():
                        if element == 'C': mass += 12.011
                        elif element == 'H': mass += 1.008
                        elif element == 'N': mass += 14.007
                        elif element == 'O': mass += 15.999
                        elif element == 'F': mass += 18.998
                        elif element == 'P': mass += 30.974
                        elif element == 'S': mass += 32.06
                        elif element == 'Cl': mass += 35.45
                        break

        # Volume from density: V = (n * M) / (density * NA)
        # density in g/cm³, mass in g/mol, NA = 6.022e23
        volume_cm3 = (num_molecules * mass) / (density * 6.022e23)
        volume_angstrom3 = volume_cm3 * 1e24
        box_len = volume_angstrom3 ** (1/3)
        box_size = f"{box_len:.2f} {box_len:.2f} {box_len:.2f}"
        logger.info(f"Calculated box size: {box_size} Å from density {density} g/cm³, mass {mass:.1f}")

    # Parse box size for bounds (format: "x y z" in Angstroms, box is centered at origin)
    try:
        box_x, box_y, box_z = [float(x) for x in box_size.split()]
        # Box is centered at origin, so bounds are +/- half the box size
        xlo, ylo, zlo = -box_x/2, -box_y/2, -box_z/2
        xhi, yhi, zhi = box_x/2, box_y/2, box_z/2
    except ValueError:
        xlo = ylo = zlo = -10.0
        xhi = yhi = zhi = 10.0

    # Create system.lt content
    # Note: We use write() not write_once() for data sections
    # The import should use the .lt filename (without path since we're in same dir)
    lt_content = f"""# System file for moltemplate
# Generated by CatGo force field conversion
# {num_molecules} molecules, box: {box_size}

# Import the force field
import "gaff2.lt"

# Import the molecule (must match the actual filename)
import "{molecule_lt_file.name}"

# Create {num_molecules} molecule(s)
molecules = new {molecule_name}[{num_molecules}]

# Write all the sections needed for LAMMPS
write("Data Atoms") {{
}}
write("Masses") {{
}}
write("Bond Coeffs") {{
}}
write("Angle Coeffs") {{
}}
write("Dihedral Coeffs") {{
}}
write("Improper Coeffs") {{
}}
"""

    with open(system_lt_file, 'w') as f:
        f.write(lt_content)

    return system_lt_file


def _run_moltemplate(
    system_lt_file: Path,
) -> tuple[str, list[str]]:
    """
    Run moltemplate.sh to generate LAMMPS files.

    Returns:
        (data_file_content, warnings_list)
    """
    system_dir = system_lt_file.parent

    # Run moltemplate.sh
    cmd = [
        "bash",
        str(MOLTEMPLATE_SCRIPT),
        str(system_lt_file.name),
    ]

    try:
        result = subprocess.run(
            cmd,
            cwd=system_dir,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("moltemplate.sh timed out after 120 seconds")

    if result.returncode != 0:
        raise RuntimeError(f"moltemplate.sh failed: {result.stderr}")

    # Read the generated data file
    data_file = system_dir / "system.data"
    if not data_file.exists():
        raise RuntimeError("moltemplate.sh did not generate system.data")

    data_content = data_file.read_text()

    warnings: list[str] = []
    if "Missing parameter" in result.stdout or "Missing parameter" in result.stderr:
        warnings.append("Some force field parameters may be missing. Check output_ttree/ for details.")

    return data_content, warnings


def _convert_with_antechamber_and_moltemplate(
    structure_content: str,
    structure_format: str = "pdb",
    force_field: str = "gaff2",
    charge_method: str = "gasteiger",
    num_molecules: int = 1,
    box_mode: str = "size",
    box_size: str = "20 20 20",
    density: float = 1.0,
    include_init: bool = False,
) -> tuple[str, str, list[str]]:
    """
    Convert PDB/MOL2/XYZ to LAMMPS using proper AmberTools/moltemplate workflow.

    The antechamber tool will assign GAFF/GAFF2 atom types to the structure
    regardless of the input format or existing atom types. This means even
    if your file has generic atom names (C, H, O, N, etc.), it will be converted
    to proper GAFF2 types (c3, hc, oh, etc.).

    Args:
        structure_content: PDB, MOL2, or XYZ file content
        structure_format: "pdb", "mol2", or "xyz"
        force_field: gaff2, gaff, oplsaa
        charge_method: gasteiger, am1bcc, zero
        num_molecules: Number of molecules for multi-molecule system
        box_mode: "size" or "density"
        box_size: Box size in Å
        density: Target density in g/cm³
        include_init: Whether to return init file content

    Returns:
        (data_file_content, init_file_content, warnings_list)
    """
    warnings: list[str] = []
    temp_dir = Path(tempfile.mkdtemp())

    try:
        # Write input file and convert to PDB if needed
        if structure_format == "pdb":
            input_file = temp_dir / "molecule.pdb"
            input_file.write_text(structure_content)
        elif structure_format == "mol2":
            input_file = temp_dir / "molecule.mol2"
            input_file.write_text(structure_content)
        else:  # xyz - convert to PDB first
            xyz_file = temp_dir / "molecule.xyz"
            xyz_file.write_text(structure_content)
            # Convert XYZ to PDB using ASE
            try:
                from ase.io import read, write
                atoms = read(xyz_file, format='xyz')
                pdb_file = temp_dir / "molecule.pdb"
                write(pdb_file, atoms, format='proteindatabank')
                input_file = pdb_file
                logger.info(f"[forcefield] Converted XYZ to PDB for antechamber")
            except ImportError:
                raise RuntimeError("ASE package not available for XYZ conversion")
            except Exception as e:
                raise RuntimeError(f"XYZ to PDB conversion failed: {e}")

        # Step 1: Run antechamber to generate MOL2 with GAFF atom types
        # Note: input_file is always PDB at this point (XYZ was converted if needed)
        logger.info(f"[forcefield] Running antechamber on {input_file.name}")
        mol2_file, frcmod_file = _run_antechamber(input_file, "pdb", charge_method, force_field)

        if not mol2_file.exists():
            raise RuntimeError("antechamber failed to generate MOL2 file")

        # Step 2: Run mol22lt.py to generate molecule .lt file
        logger.info(f"[forcefield] Running mol22lt.py on {mol2_file.name}")
        molecule_name = "Molecule"
        molecule_lt = _run_mol22lt(mol2_file, molecule_name, force_field)

        # Copy force field .lt file to temp directory for moltemplate to find it
        ff_file = _get_forcefield_file(force_field)
        ff_lt_name = f"{force_field}.lt"
        ff_lt_dest = temp_dir / ff_lt_name
        shutil.copy(ff_file, ff_lt_dest)

        # Fix the force field import path in the molecule .lt file
        lt_content = molecule_lt.read_text()
        lt_content = lt_content.replace(
            f'import "{ff_file}"',
            f'import "{ff_lt_name}"'
        )
        molecule_lt.write_text(lt_content)

        # Step 3: Create system.lt file
        logger.info("[forcefield] Creating system.lt")
        system_lt = _create_system_lt(molecule_lt, molecule_name, num_molecules, box_mode, box_size, density)

        # Step 4: Run moltemplate.sh to generate LAMMPS files
        logger.info("[forcefield] Running moltemplate.sh")
        data_content, warnings_msg = _run_moltemplate(system_lt)

        if warnings_msg:
            warnings.extend(warnings_msg)

        # Read init file if requested
        init_content = ""
        if include_init:
            init_file = temp_dir / "system.in.init"
            if init_file.exists():
                init_content = init_file.read_text()

        return data_content, init_content, warnings

    finally:
        # Clean up temp directory
        shutil.rmtree(temp_dir, ignore_errors=True)

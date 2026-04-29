"""Quantum ESPRESSO input file generation endpoints."""

import numpy as np
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from catgo.models.structure import PymatgenStructure


router = APIRouter(prefix="/qe", tags=["quantum-espresso"])


# ============================================================================
# Element Data
# ============================================================================

ELEMENTS = [
    'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al',
    'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe',
    'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr',
    'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn',
    'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm',
    'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W',
    'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn',
    'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf',
    'Es', 'Fm', 'Md', 'No', 'Lr'
]

ATOMIC_WEIGHTS = {
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
    'Pa': 231.0, 'U': 238.0, 'Np': 237.0, 'Pu': 244.0, 'Am': 243.0, 'Cm': 247.0,
    'Bk': 247.0, 'Cf': 251.0, 'Es': 252.0, 'Fm': 257.0, 'Md': 258.0, 'No': 259.0,
    'Lr': 262.0
}


# ============================================================================
# Request/Response Models
# ============================================================================

class QECalculationType(str):
    """QE calculation types."""
    SCF = "scf"
    RELAX = "relax"
    VC_RELAX = "vc-relax"
    NSCF = "nscf"
    BANDS = "bands"
    DOS = "dos"


class QEInputRequest(BaseModel):
    """Request for QE input file generation."""

    structure: PymatgenStructure
    calculation: str = Field(default="scf", description="Calculation type: scf, relax, vc-relax, nscf, bands")
    prefix: str = Field(default="pwscf", description="Prefix for output files")

    # Cutoffs
    ecutwfc: float = Field(default=60.0, description="Kinetic energy cutoff for wavefunctions (Ry)")
    ecutrho: float = Field(default=480.0, description="Kinetic energy cutoff for charge density (Ry)")

    # K-points
    kpoints: Optional[list[int]] = Field(default=None, description="K-point grid [kx, ky, kz]. Auto-generated if None")
    kpoints_shift: list[int] = Field(default=[0, 0, 0], description="K-point grid shift")
    kspacing: float = Field(default=0.04, description="K-point spacing for auto-generation (1/Angstrom)")

    # Smearing
    occupations: str = Field(default="smearing", description="Occupations method")
    smearing: str = Field(default="mv", description="Smearing method: mv, gaussian, mp, etc.")
    degauss: float = Field(default=0.01, description="Smearing width (Ry)")

    # Convergence
    conv_thr: float = Field(default=1e-8, description="SCF convergence threshold")
    forc_conv_thr: float = Field(default=1e-4, description="Force convergence threshold for relax")
    etot_conv_thr: float = Field(default=1e-5, description="Total energy convergence threshold")

    # Relaxation
    ion_dynamics: str = Field(default="bfgs", description="Ion dynamics algorithm")
    cell_dynamics: str = Field(default="bfgs", description="Cell dynamics algorithm")
    press: float = Field(default=0.0, description="Target pressure (kbar) for vc-relax")
    press_conv_thr: float = Field(default=0.5, description="Pressure convergence threshold")

    # Pseudopotentials
    pseudo_dir: str = Field(default="./", description="Pseudopotential directory")
    pseudopotentials: Optional[dict[str, str]] = Field(
        default=None,
        description="Pseudopotential filenames {element: filename}. Left blank if not provided."
    )

    # Coordinate output format
    coord_type: str = Field(default="crystal", description="Coordinate type: crystal, angstrom")

    # Spin
    nspin: int = Field(default=1, description="Number of spin components (1=unpolarized, 2=collinear)")
    starting_magnetization: Optional[dict[str, float]] = Field(
        default=None, description="Starting magnetization per element"
    )

    # Fixed atoms (for surface/slab calculations)
    fixed_indices: Optional[list[int]] = Field(
        default=None,
        description="Indices of atoms to fix during relaxation (0-indexed). For surface slabs, typically fix bottom layers."
    )
    fixed_z_below: Optional[float] = Field(
        default=None,
        description="Fix all atoms with z-coordinate below this value (in Angstrom). Useful for surface slabs."
    )


class QEInputResponse(BaseModel):
    """Response containing QE input file."""

    success: bool
    input_file: str = Field(description="Generated QE input file content")
    elements: list[str] = Field(description="List of unique elements")
    n_atoms: int = Field(description="Total number of atoms")
    n_types: int = Field(description="Number of atom types")
    kpoints: list[int] = Field(description="K-point grid used")
    missing_pseudopotentials: list[str] = Field(
        default=[],
        description="Elements that need pseudopotential files to be specified"
    )
    message: str = ""


# ============================================================================
# Helper Functions
# ============================================================================

def extract_structure_info(structure: PymatgenStructure) -> dict:
    """Extract structure information from PymatgenStructure."""
    cell = np.array(structure.lattice.matrix)

    # Get elements, positions, and selective dynamics
    elements = []
    cart_coords = []
    frac_coords = []
    selective_dynamics = []  # Per-atom constraints: [bool, bool, bool] for x, y, z

    inv_cell = np.linalg.inv(cell)
    for site in structure.sites:
        main_species = max(site.species, key=lambda s: s.occu)
        elements.append(main_species.element)
        cart_coords.append(site.xyz)
        if site.abc is not None:
            frac_coords.append(site.abc)
        else:
            frac = inv_cell @ np.array(site.xyz)
            frac_coords.append(frac.tolist())

        # Extract selective_dynamics from site.properties
        # True = free to move, False = fixed
        # Default: [True, True, True] (fully free)
        site_props = site.properties if hasattr(site, 'properties') and site.properties else {}
        sd = site_props.get('selective_dynamics', [True, True, True])

        # Handle various formats (list of bools, or possibly ints/strings)
        if isinstance(sd, (list, tuple)) and len(sd) == 3:
            selective_dynamics.append([bool(v) for v in sd])
        else:
            selective_dynamics.append([True, True, True])

    # Get unique elements (preserve order)
    unique_elements = []
    element_counts = {}
    for el in elements:
        if el not in element_counts:
            unique_elements.append(el)
            element_counts[el] = 0
        element_counts[el] += 1

    return {
        "cell": cell,
        "elements": elements,
        "unique_elements": unique_elements,
        "element_counts": element_counts,
        "cart_coords": np.array(cart_coords),
        "frac_coords": np.array(frac_coords),
        "selective_dynamics": selective_dynamics,  # Per-atom per-direction constraints
        "n_atoms": len(elements),
        "n_types": len(unique_elements),
        "lattice_params": np.array([np.linalg.norm(v) for v in cell]),
    }


def generate_kpoints(lattice_params: np.ndarray, calc_type: str = "scf", kspacing: float = 0.04) -> list[int]:
    """Generate k-points based on lattice parameters and calculation type."""
    reciprocal_lengths = 1.0 / lattice_params

    # Adjust spacing for different calculation types
    if calc_type == "nscf":
        kspacing = kspacing / 2
    elif calc_type == "bands":
        kspacing = kspacing / 3

    kpoints = [max(1, int(np.ceil(rl / kspacing))) for rl in reciprocal_lengths]

    # Ensure even kpoints for some symmetry
    min_k = min(kpoints)
    kpoints = [min_k * (k // min_k) if min_k > 0 else k for k in kpoints]

    return kpoints


def get_pseudopotential_placeholder(element: str) -> str:
    """Return a placeholder for pseudopotential filename.

    Users should replace this with their actual pseudopotential file.
    """
    return f"<{element}_PSEUDOPOTENTIAL>"


# ============================================================================
# Input File Generation
# ============================================================================

def generate_control_namelist(request: QEInputRequest) -> str:
    """Generate &CONTROL namelist."""
    lines = ["&CONTROL"]

    calc_type = request.calculation.lower()

    settings = {
        "calculation": f"'{calc_type}'",
        "restart_mode": "'from_scratch'",
        "prefix": f"'{request.prefix}'",
        "pseudo_dir": f"'{request.pseudo_dir}'",
        "outdir": "'./tmp/'",
    }

    if calc_type in ["relax", "vc-relax"]:
        settings["forc_conv_thr"] = f"{request.forc_conv_thr:.1e}"
        settings["etot_conv_thr"] = f"{request.etot_conv_thr:.1e}"

    for key, value in settings.items():
        lines.append(f"   {key:<18} = {value}")

    lines.append("/\n")
    return "\n".join(lines)


def generate_system_namelist(request: QEInputRequest, info: dict) -> str:
    """Generate &SYSTEM namelist."""
    lines = ["&SYSTEM"]

    settings = {
        "ibrav": 0,
        "nat": info["n_atoms"],
        "ntyp": info["n_types"],
        "ecutwfc": request.ecutwfc,
        "ecutrho": request.ecutrho,
        "occupations": f"'{request.occupations}'",
        "smearing": f"'{request.smearing}'",
        "degauss": request.degauss,
    }

    if request.nspin == 2:
        settings["nspin"] = 2
        if request.starting_magnetization:
            for i, el in enumerate(info["unique_elements"], 1):
                mag = request.starting_magnetization.get(el, 0.0)
                settings[f"starting_magnetization({i})"] = mag

    for key, value in settings.items():
        lines.append(f"   {key:<26} = {value}")

    lines.append("/\n")
    return "\n".join(lines)


def generate_electrons_namelist(request: QEInputRequest) -> str:
    """Generate &ELECTRONS namelist."""
    lines = ["&ELECTRONS"]

    settings = {
        "conv_thr": f"{request.conv_thr:.1e}",
        "mixing_beta": 0.7,
        "electron_maxstep": 200,
    }

    for key, value in settings.items():
        lines.append(f"   {key:<18} = {value}")

    lines.append("/\n")
    return "\n".join(lines)


def generate_ions_namelist(request: QEInputRequest) -> str:
    """Generate &IONS namelist for relax calculations."""
    if request.calculation.lower() not in ["relax", "vc-relax"]:
        return ""

    lines = ["&IONS"]
    settings = {"ion_dynamics": f"'{request.ion_dynamics}'"}

    for key, value in settings.items():
        lines.append(f"   {key:<18} = {value}")

    lines.append("/\n")
    return "\n".join(lines)


def generate_cell_namelist(request: QEInputRequest) -> str:
    """Generate &CELL namelist for vc-relax calculations."""
    if request.calculation.lower() != "vc-relax":
        return ""

    lines = ["&CELL"]
    settings = {
        "cell_dynamics": f"'{request.cell_dynamics}'",
        "press": request.press,
        "press_conv_thr": request.press_conv_thr,
    }

    for key, value in settings.items():
        lines.append(f"   {key:<18} = {value}")

    lines.append("/\n")
    return "\n".join(lines)


def generate_atomic_species(request: QEInputRequest, info: dict) -> str:
    """Generate ATOMIC_SPECIES card.

    If pseudopotentials are not provided, uses placeholders that users should replace.
    """
    lines = ["ATOMIC_SPECIES"]

    for el in info["unique_elements"]:
        weight = ATOMIC_WEIGHTS.get(el, 1.0)
        if request.pseudopotentials and el in request.pseudopotentials:
            pp_file = request.pseudopotentials[el]
        else:
            # Leave blank placeholder for user to fill in
            pp_file = get_pseudopotential_placeholder(el)

        lines.append(f"   {el:<4} {weight:>10.4f}   {pp_file}")

    lines.append("")
    return "\n".join(lines)


def generate_cell_parameters(info: dict) -> str:
    """Generate CELL_PARAMETERS card."""
    lines = ["CELL_PARAMETERS {angstrom}"]

    for vec in info["cell"]:
        lines.append(f"   {vec[0]:>18.12f} {vec[1]:>18.12f} {vec[2]:>18.12f}")

    lines.append("")
    return "\n".join(lines)


def generate_atomic_positions(request: QEInputRequest, info: dict) -> str:
    """Generate ATOMIC_POSITIONS card.

    Supports per-direction selective dynamics constraints from structure's site.properties.
    Also supports additional fixing via:
    - fixed_indices: list of atom indices to fix (all directions)
    - fixed_z_below: fix all atoms with z < this value (all directions)

    The structure's selective_dynamics takes precedence, additional constraints
    can override to fix but not to free.
    """
    coord_type = request.coord_type.lower()

    if coord_type == "crystal":
        lines = ["ATOMIC_POSITIONS {crystal}"]
        coords = info["frac_coords"]
    else:
        lines = ["ATOMIC_POSITIONS {angstrom}"]
        coords = info["cart_coords"]

    # Get selective dynamics from structure (per-atom, per-direction)
    # True = free to move, False = fixed
    selective_dynamics = info.get("selective_dynamics", [[True, True, True]] * info["n_atoms"])

    # Apply additional constraints from fixed_indices (fix all directions)
    if request.fixed_indices:
        for idx in request.fixed_indices:
            if 0 <= idx < len(selective_dynamics):
                selective_dynamics[idx] = [False, False, False]

    # Apply additional constraints from fixed_z_below (fix all directions for atoms below threshold)
    if request.fixed_z_below is not None:
        cart_coords = info["cart_coords"]
        for i, cart_coord in enumerate(cart_coords):
            if cart_coord[2] < request.fixed_z_below:
                selective_dynamics[i] = [False, False, False]

    # Check if we need constraints (only for relax calculations, and only if any atom has constraints)
    is_relax = request.calculation.lower() in ["relax", "vc-relax"]
    has_any_constraint = any(
        not all(sd) for sd in selective_dynamics  # Any atom not fully free
    )
    needs_constraints = is_relax and has_any_constraint

    for i, (el, coord) in enumerate(zip(info["elements"], coords)):
        pos_line = f"   {el:<4} {coord[0]:>18.12f} {coord[1]:>18.12f} {coord[2]:>18.12f}"
        if needs_constraints:
            sd = selective_dynamics[i]
            # Convert: True (free) -> 1, False (fixed) -> 0
            constraint_str = f"   {int(sd[0])} {int(sd[1])} {int(sd[2])}"
            pos_line += constraint_str
        lines.append(pos_line)

    lines.append("")
    return "\n".join(lines)


def generate_kpoints_card(request: QEInputRequest, kpoints: list[int]) -> str:
    """Generate K_POINTS card."""
    shift = request.kpoints_shift
    return f"K_POINTS automatic\n   {kpoints[0]} {kpoints[1]} {kpoints[2]}  {shift[0]} {shift[1]} {shift[2]}\n"


def generate_qe_input(request: QEInputRequest) -> tuple[str, dict]:
    """Generate complete QE input file.

    Returns:
        Tuple of (input_file_content, structure_info)
    """
    # Extract structure information
    info = extract_structure_info(request.structure)

    # Generate or use provided k-points
    if request.kpoints:
        kpoints = request.kpoints
    else:
        kpoints = generate_kpoints(
            info["lattice_params"],
            request.calculation,
            request.kspacing
        )

    # Track elements without pseudopotentials
    missing_pp = []
    for el in info["unique_elements"]:
        if not request.pseudopotentials or el not in request.pseudopotentials:
            missing_pp.append(el)

    # Build input file
    sections = [
        generate_control_namelist(request),
        generate_system_namelist(request, info),
        generate_electrons_namelist(request),
        generate_ions_namelist(request),
        generate_cell_namelist(request),
        generate_atomic_species(request, info),
        generate_kpoints_card(request, kpoints),
        generate_cell_parameters(info),
        generate_atomic_positions(request, info),
    ]

    # Filter out empty sections
    input_content = "\n".join(section for section in sections if section)

    return input_content, {**info, "kpoints": kpoints, "missing_pseudopotentials": missing_pp}


# ============================================================================
# API Endpoints
# ============================================================================

@router.post("/input", response_model=QEInputResponse)
def generate_input_file(request: QEInputRequest) -> QEInputResponse:
    """Generate Quantum ESPRESSO input file from structure.

    Args:
        request: QE input request with structure and calculation parameters

    Returns:
        QEInputResponse with generated input file content
    """
    try:
        input_content, info = generate_qe_input(request)

        missing_pp = info.get("missing_pseudopotentials", [])
        message = f"Generated {request.calculation} input for {info['n_atoms']} atoms"
        if missing_pp:
            message += f". Note: Please set pseudopotentials for: {', '.join(missing_pp)}"

        return QEInputResponse(
            success=True,
            input_file=input_content,
            elements=info["unique_elements"],
            n_atoms=info["n_atoms"],
            n_types=info["n_types"],
            kpoints=info["kpoints"],
            missing_pseudopotentials=missing_pp,
            message=message
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/templates")
def list_templates() -> dict:
    """List available calculation templates with typical settings."""
    return {
        "templates": {
            "scf": {
                "description": "Single-point self-consistent field calculation",
                "typical_settings": {
                    "ecutwfc": 60,
                    "ecutrho": 480,
                    "conv_thr": 1e-8,
                }
            },
            "relax": {
                "description": "Ionic relaxation (fixed cell)",
                "typical_settings": {
                    "ecutwfc": 60,
                    "ecutrho": 480,
                    "forc_conv_thr": 1e-4,
                    "ion_dynamics": "bfgs",
                }
            },
            "vc-relax": {
                "description": "Variable-cell relaxation",
                "typical_settings": {
                    "ecutwfc": 60,
                    "ecutrho": 480,
                    "forc_conv_thr": 1e-4,
                    "press_conv_thr": 0.5,
                    "cell_dynamics": "bfgs",
                }
            },
            "nscf": {
                "description": "Non-self-consistent calculation (for DOS/bands)",
                "typical_settings": {
                    "ecutwfc": 60,
                    "ecutrho": 480,
                    "kpoints": "denser than scf",
                }
            },
        }
    }


@router.get("/elements")
def list_supported_elements() -> dict:
    """List supported elements with their atomic weights."""
    return {
        "elements": ATOMIC_WEIGHTS,
        "count": len(ATOMIC_WEIGHTS),
    }

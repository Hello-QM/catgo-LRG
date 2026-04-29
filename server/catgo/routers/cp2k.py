"""CP2K input file generation endpoints."""

import numpy as np
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from catgo.models.structure import PymatgenStructure


router = APIRouter(prefix="/cp2k", tags=["cp2k"])


# ============================================================================
# Element Data
# ============================================================================

VALENCE_ELECTRONS = {
    'H': 1, 'He': 2, 'Li': 3, 'Be': 4, 'B': 3, 'C': 4, 'N': 5, 'O': 6, 'F': 7, 'Ne': 8,
    'Na': 9, 'Mg': 10, 'Al': 3, 'Si': 4, 'P': 5, 'S': 6, 'Cl': 7, 'Ar': 8,
    'K': 9, 'Ca': 10, 'Sc': 11, 'Ti': 12, 'V': 13, 'Cr': 14, 'Mn': 15, 'Fe': 16, 'Co': 17, 'Ni': 18, 'Cu': 11, 'Zn': 12,
    'Ga': 13, 'Ge': 4, 'As': 5, 'Se': 6, 'Br': 7, 'Kr': 8,
    'Rb': 9, 'Sr': 10, 'Y': 11, 'Zr': 12, 'Nb': 13, 'Mo': 14, 'Ru': 16, 'Rh': 17, 'Pd': 18, 'Ag': 11, 'Cd': 12,
    'In': 13, 'Sn': 4, 'Sb': 5, 'Te': 6, 'I': 7, 'Xe': 8,
    'Cs': 9, 'Ba': 10, 'La': 11, 'Ce': 12, 'W': 14, 'Re': 15, 'Os': 16, 'Ir': 17, 'Pt': 18, 'Au': 11, 'Hg': 12,
    'Tl': 13, 'Pb': 4, 'Bi': 5,
}


# ============================================================================
# Request/Response Models
# ============================================================================

class DFTPlusUElement(BaseModel):
    """DFT+U settings for a single element."""
    l: int = Field(default=2, description="Angular momentum quantum number (0=s, 1=p, 2=d, 3=f)")
    u_minus_j: float = Field(default=0.0, description="Effective U-J parameter in eV")


class CP2KInputRequest(BaseModel):
    """Request for CP2K input file generation."""

    structure: PymatgenStructure
    prefix: str = Field(default="calc", description="Project name for output files")
    run_type: str = Field(default="MD", description="Run type")
    functional: str = Field(default="PBE", description="XC functional")
    basis_set: str = Field(default="DZVP-MOLOPT-SR-GTH", description="Basis set name")
    cutoff: float = Field(default=450, description="Plane-wave cutoff in Ry")
    rel_cutoff: float = Field(default=40, description="Relative cutoff in Ry")
    # SCF method
    scf_method: str = Field(default="DIAG", description="SCF method: OT or DIAG")
    scf_eps: float = Field(default=1e-5, description="SCF convergence criterion")
    max_scf: int = Field(default=300, description="Maximum SCF iterations")
    ot_preconditioner: str = Field(default="FULL_KINETIC", description="OT preconditioner")
    ot_minimizer: str = Field(default="DIIS", description="OT minimizer: DIIS, CG, BROYDEN")
    outer_scf: bool = Field(default=True, description="Enable outer SCF loop")
    outer_max_scf: int = Field(default=20, description="Maximum outer SCF iterations")
    outer_eps: float = Field(default=1e-5, description="Outer SCF convergence criterion")
    # Diagonalization + Smearing
    smearing: bool = Field(default=True, description="Enable smearing (DIAG only)")
    smearing_method: str = Field(default="FERMI_DIRAC", description="Smearing method")
    electronic_temperature: float = Field(default=300, description="Electronic temperature in K")
    added_mos: int = Field(default=50, description="Number of added MOs for DIAG")
    # Dispersion
    vdw: str = Field(default="DFTD3(BJ)", description="Van der Waals correction")
    # Periodicity
    periodic: str = Field(default="XYZ", description="Periodicity")
    # Spin
    charge: int = Field(default=0, description="Total system charge")
    multiplicity: int = Field(default=1, description="Spin multiplicity")
    uks: bool = Field(default=False, description="Use unrestricted Kohn-Sham")
    # K-points
    kpoints_enabled: bool = Field(default=False, description="Enable Monkhorst-Pack k-points")
    kpoints_nx: int = Field(default=1, description="K-points grid Nx")
    kpoints_ny: int = Field(default=1, description="K-points grid Ny")
    kpoints_nz: int = Field(default=1, description="K-points grid Nz")
    # DFT+U
    dftpu_enabled: bool = Field(default=False, description="Enable DFT+U")
    dftpu_settings: Optional[dict[str, DFTPlusUElement]] = Field(default=None, description="Per-element DFT+U settings")
    # GEO_OPT
    geo_optimizer: str = Field(default="BFGS", description="Geometry optimizer algorithm")
    geo_max_force: float = Field(default=4.5e-4, description="Max force convergence")
    geo_max_iter: int = Field(default=200, description="Max geometry optimization iterations")
    # CELL_OPT
    cell_opt_max_iter: int = Field(default=100, description="Max cell optimization iterations")
    cell_opt_pressure: float = Field(default=0.0, description="External pressure (GPa)")
    # MD
    md_ensemble: str = Field(default="NVT", description="MD ensemble")
    md_steps: int = Field(default=10000, description="Number of MD steps")
    md_timestep: float = Field(default=1.0, description="MD timestep in fs")
    md_temperature: float = Field(default=300, description="MD temperature in K")
    md_thermostat: str = Field(default="CSVR", description="MD thermostat type")
    md_timecon: float = Field(default=80, description="Thermostat time constant in fs")
    # Fixed atoms
    fixed_indices: Optional[list[int]] = Field(default=None, description="0-indexed atom indices to fix")
    fixed_z_below: Optional[float] = Field(default=None, description="Fix atoms with z below this value (Angstrom)")
    fixed_elements: Optional[list[str]] = Field(default=None, description="Fix all atoms of these elements")
    # Advanced cp2kmate features
    lrigpw: bool = Field(default=False, description="Use LRIGPW instead of GPW")
    ls_scf: bool = Field(default=False, description="Use linear scaling SCF")
    poisson_solver: str = Field(default="PERIODIC", description="Poisson solver type")
    surf_dipole: str = Field(default="NONE", description="Surface dipole correction: NONE or SURF_DIP")
    efield_enabled: bool = Field(default=False, description="Enable external electric field")
    efield_x: float = Field(default=0.0, description="Electric field X component (a.u.)")
    efield_y: float = Field(default=0.0, description="Electric field Y component (a.u.)")
    efield_z: float = Field(default=0.0, description="Electric field Z component (a.u.)")
    magnetization: Optional[dict[str, float]] = Field(default=None, description="Per-element magnetization")
    center_coords: bool = Field(default=False, description="Center coordinates in the box")
    cell_rep_x: int = Field(default=1, description="Cell replication in X")
    cell_rep_y: int = Field(default=1, description="Cell replication in Y")
    cell_rep_z: int = Field(default=1, description="Cell replication in Z")
    fine_grid_xc: bool = Field(default=False, description="Use finer grid for XC")
    print_level: str = Field(default="LOW", description="Print level: LOW, MEDIUM, HIGH")
    print_moments: bool = Field(default=False, description="Print electric/magnetic moments")
    print_orbital_energies: bool = Field(default=False, description="Print orbital energies")
    output_overlap_csr: bool = Field(default=False, description="Output overlap matrix to CSR")
    output_ks_csr: bool = Field(default=False, description="Output Kohn-Sham matrix to CSR")
    epr_hyperfine: bool = Field(default=False, description="Print EPR hyperfine coupling")
    coord_from_file: bool = Field(default=False, description="Read coordinates from external file")
    coord_file_name: str = Field(default="", description="External coordinate file name")


class CP2KInputResponse(BaseModel):
    """Response containing CP2K input file."""

    success: bool
    input_file: str = Field(description="Generated CP2K input file content")
    elements: list[str] = Field(description="List of unique elements")
    n_atoms: int = Field(description="Total number of atoms")
    message: str = ""


# ============================================================================
# Helper Functions
# ============================================================================

def extract_structure_info(structure: PymatgenStructure) -> dict:
    """Extract structure information from PymatgenStructure."""
    cell = np.array(structure.lattice.matrix)

    elements = []
    cart_coords = []
    selective_dynamics = []

    inv_cell = np.linalg.inv(cell)
    for site in structure.sites:
        main_species = max(site.species, key=lambda s: s.occu)
        elements.append(main_species.element)
        cart_coords.append(site.xyz)

        site_props = site.properties if hasattr(site, 'properties') and site.properties else {}
        sd = site_props.get('selective_dynamics', [True, True, True])
        if isinstance(sd, (list, tuple)) and len(sd) == 3:
            selective_dynamics.append([bool(v) for v in sd])
        else:
            selective_dynamics.append([True, True, True])

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
        "selective_dynamics": selective_dynamics,
        "n_atoms": len(elements),
    }


def get_cp2k_valence(element: str) -> int:
    """Get the number of valence electrons for GTH pseudopotential suffix."""
    return VALENCE_ELECTRONS.get(element, 4)


def get_ref_functional(functional: str) -> str:
    """Determine the reference functional for VDW parameters."""
    mapping = {
        'BLYP': 'BLYP', 'revPBE': 'revPBE', 'PBEsol': 'PBEsol',
        'BP86': 'BP86', 'RPBE': 'RPBE', 'TPSS': 'TPSS',
        'revTPSS': 'revTPSS', 'r2SCAN': 'r2SCAN', 'SCAN': 'SCAN',
    }
    return mapping.get(functional, 'PBE')


def get_fixed_atom_indices(request: CP2KInputRequest, info: dict) -> list[int]:
    """Determine which atoms should be fixed. Returns 1-indexed list."""
    fixed = set()

    for i, sd in enumerate(info["selective_dynamics"]):
        if not all(sd):
            fixed.add(i)

    if request.fixed_indices:
        for idx in request.fixed_indices:
            if 0 <= idx < info["n_atoms"]:
                fixed.add(idx)

    if request.fixed_z_below is not None:
        for i, coord in enumerate(info["cart_coords"]):
            if coord[2] < request.fixed_z_below:
                fixed.add(i)

    if request.fixed_elements:
        for i, el in enumerate(info["elements"]):
            if el in request.fixed_elements:
                fixed.add(i)

    return sorted([idx + 1 for idx in fixed])


# ============================================================================
# Input File Generation
# ============================================================================

def generate_cp2k_input(request: CP2KInputRequest, info: dict) -> str:
    """Generate a complete CP2K input file string."""
    lines = []

    f = request.functional
    if f in ("BLYP", "B3LYP", "BP86", "BHandHLYP"):
        potential_prefix = "GTH-BLYP"
    elif f == "PADE":
        potential_prefix = "GTH-PADE"
    else:
        potential_prefix = "GTH-PBE"
    fixed_atoms = get_fixed_atom_indices(request, info)

    # Determine if UKS should be forced by magnetization
    has_mag = request.magnetization and any(v != 0 for v in request.magnetization.values())
    effective_uks = request.uks or has_mag

    # Task-specific defaults
    run_type = request.run_type
    eps_scf = request.scf_eps
    eps_default = 1.0e-12
    if run_type in ("VIBRATIONAL_ANALYSIS", "LINEAR_RESPONSE"):
        eps_default = 1.0e-14
        if eps_scf > 5e-7:
            eps_scf = 1.0e-7
    elif run_type == "MD":
        if eps_scf < 5e-6:
            eps_scf = 1.0e-5

    # ---- &GLOBAL ----
    lines.append("&GLOBAL")
    lines.append(f"  PROJECT {request.prefix}")
    lines.append(f"  RUN_TYPE {run_type}")
    lines.append(f"  PRINT_LEVEL {request.print_level}")
    lines.append("&END GLOBAL")
    lines.append("")

    # ---- &FORCE_EVAL ----
    lines.append("&FORCE_EVAL")
    lines.append("  METHOD Quickstep")

    need_stress = run_type == "CELL_OPT" or (run_type == "MD" and request.md_ensemble == "NPT_I")
    if need_stress:
        lines.append("  STRESS_TENSOR ANALYTICAL")

    # ---- &DFT ----
    lines.append("  &DFT")
    lines.append("    BASIS_SET_FILE_NAME BASIS_MOLOPT")
    if request.lrigpw:
        lines.append("    BASIS_SET_FILE_NAME LRI_BASIS_SETS")
    lines.append("    POTENTIAL_FILE_NAME GTH_POTENTIALS")
    if request.charge != 0:
        lines.append(f"    CHARGE {request.charge}")
    if effective_uks:
        lines.append("    UKS .TRUE.")
        lines.append(f"    MULTIPLICITY {request.multiplicity}")
    elif request.multiplicity != 1:
        lines.append(f"    MULTIPLICITY {request.multiplicity}")

    if request.surf_dipole == "SURF_DIP":
        lines.append("    SURFACE_DIPOLE_CORRECTION T")
        lines.append("    SURF_DIP_DIR Z")

    if request.dftpu_enabled:
        lines.append("    PLUS_U_METHOD MULLIKEN")

    # &MGRID
    lines.append("    &MGRID")
    lines.append(f"      CUTOFF {request.cutoff}")
    lines.append(f"      REL_CUTOFF {request.rel_cutoff}")
    ngrids = 5 if request.fine_grid_xc else 4
    lines.append(f"      NGRIDS {ngrids}")
    lines.append("    &END MGRID")

    # &QS
    lines.append("    &QS")
    lines.append(f"      EPS_DEFAULT {eps_default:.1E}")
    if request.lrigpw:
        lines.append("      METHOD LRIGPW")
    lines.append("      EXTRAPOLATION ASPC")
    lines.append("      EXTRAPOLATION_ORDER 3")
    lines.append("    &END QS")

    # &SCF (or &LS_SCF for linear scaling)
    if request.ls_scf:
        lines.append("    &LS_SCF")
        lines.append(f"      EPS_SCF {eps_scf:.1E}")
        lines.append("      MAX_SCF 50")
        lines.append("      PURIFICATION_METHOD TRS4")
        lines.append("      S_PRECONDITIONER ATOMIC")
        lines.append("    &END LS_SCF")
    else:
        lines.append("    &SCF")
        lines.append("      SCF_GUESS ATOMIC")

        if request.scf_method == "DIAG":
            max_scf = request.max_scf if request.max_scf != 300 else 128
            lines.append(f"      MAX_SCF {max_scf}")
            lines.append(f"      EPS_SCF {eps_scf:.1E}")
            added = request.added_mos
            if effective_uks:
                lines.append(f"      ADDED_MOS {added} {added}")
            else:
                lines.append(f"      ADDED_MOS {added}")
            lines.append("      &DIAGONALIZATION")
            lines.append("        ALGORITHM STANDARD")
            lines.append("      &END DIAGONALIZATION")
            if request.smearing:
                lines.append("      &SMEAR ON")
                lines.append(f"        METHOD {request.smearing_method}")
                lines.append(f"        ELECTRONIC_TEMPERATURE [K] {request.electronic_temperature}")
                lines.append("      &END SMEAR")
            lines.append("      &MIXING")
            lines.append("        METHOD BROYDEN_MIXING")
            lines.append("        ALPHA 0.4")
            lines.append("        NBROYDEN 8")
            lines.append("      &END MIXING")
        else:
            # OT
            max_scf = request.max_scf if request.max_scf != 300 else 25
            lines.append(f"      MAX_SCF {max_scf}")
            lines.append(f"      EPS_SCF {eps_scf:.1E}")
            lines.append("      &OT T")
            n_atoms = info["n_atoms"]
            if n_atoms < 300:
                lines.append("        PRECONDITIONER FULL_ALL")
            else:
                lines.append(f"        PRECONDITIONER {request.ot_preconditioner}")
            lines.append(f"        MINIMIZER {request.ot_minimizer}")
            lines.append("        LINESEARCH 2PNT")
            lines.append("        ALGORITHM STRICT")
            lines.append("      &END OT")

        if request.outer_scf:
            lines.append("      &OUTER_SCF")
            lines.append(f"        MAX_SCF {request.outer_max_scf}")
            lines.append(f"        EPS_SCF {request.outer_eps:.1E}")
            lines.append("      &END OUTER_SCF")

        # SCF PRINT
        if run_type in ("VIBRATIONAL_ANALYSIS", "MD"):
            lines.append("      &PRINT")
            lines.append("        &RESTART OFF")
            lines.append("        &END RESTART")
            lines.append("      &END PRINT")
        else:
            lines.append("      &PRINT")
            lines.append("        &RESTART")
            lines.append("          BACKUP_COPIES 0")
            lines.append("        &END RESTART")
            lines.append("      &END PRINT")

        lines.append("    &END SCF")

    # ---- &XC ----
    lines.append("    &XC")
    f = request.functional
    ref_func = get_ref_functional(f)

    if f in ("PBE", "BLYP"):
        lines.append(f"      &XC_FUNCTIONAL {f}")
        lines.append(f"      &END XC_FUNCTIONAL")
    elif f == "SCAN":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &LIBXC")
        lines.append("          FUNCTIONAL MGGA_X_SCAN")
        lines.append("        &END LIBXC")
        lines.append("        &LIBXC")
        lines.append("          FUNCTIONAL MGGA_C_SCAN")
        lines.append("        &END LIBXC")
        lines.append("      &END XC_FUNCTIONAL")
    elif f == "r2SCAN":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &LIBXC")
        lines.append("          FUNCTIONAL MGGA_X_R2SCAN")
        lines.append("        &END LIBXC")
        lines.append("        &LIBXC")
        lines.append("          FUNCTIONAL MGGA_C_R2SCAN")
        lines.append("        &END LIBXC")
        lines.append("      &END XC_FUNCTIONAL")
    elif f == "revPBE":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &PBE")
        lines.append("          PARAMETRIZATION REVPBE")
        lines.append("        &END PBE")
        lines.append("      &END XC_FUNCTIONAL")
    elif f == "PBEsol":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &PBE")
        lines.append("          PARAMETRIZATION PBESOL")
        lines.append("        &END PBE")
        lines.append("      &END XC_FUNCTIONAL")
    elif f == "RPBE":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &GGA_X_RPBE")
        lines.append("        &END GGA_X_RPBE")
        lines.append("        &GGA_C_PBE")
        lines.append("        &END GGA_C_PBE")
        lines.append("      &END XC_FUNCTIONAL")
    elif f == "BP86":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &BECKE88")
        lines.append("        &END BECKE88")
        lines.append("        &P86C")
        lines.append("        &END P86C")
        lines.append("      &END XC_FUNCTIONAL")
    elif f == "TPSS":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &TPSS")
        lines.append("        &END TPSS")
        lines.append("      &END XC_FUNCTIONAL")
    elif f == "revTPSS":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &TPSS")
        lines.append("          FUNCTIONAL REVTPSS")
        lines.append("        &END TPSS")
        lines.append("      &END XC_FUNCTIONAL")
    elif f == "PBE0":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &PBE")
        lines.append("          SCALE_X 0.75")
        lines.append("          SCALE_C 1.0")
        lines.append("        &END PBE")
        lines.append("      &END XC_FUNCTIONAL")
        lines.append("      &HF")
        lines.append("        FRACTION 0.25")
        lines.append("        &SCREENING")
        lines.append("          EPS_SCHWARZ 1.0E-6")
        lines.append("        &END SCREENING")
        lines.append("      &END HF")
    elif f == "B3LYP":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &B3LYP")
        lines.append("        &END B3LYP")
        lines.append("      &END XC_FUNCTIONAL")
        lines.append("      &HF")
        lines.append("        FRACTION 0.20")
        lines.append("        &SCREENING")
        lines.append("          EPS_SCHWARZ 1.0E-6")
        lines.append("        &END SCREENING")
        lines.append("      &END HF")
    elif f == "HSE06":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &PBE")
        lines.append("          SCALE_X 0.0")
        lines.append("          SCALE_C 1.0")
        lines.append("        &END PBE")
        lines.append("        &XWPBE")
        lines.append("          SCALE_X -0.25")
        lines.append("          SCALE_X0 1.0")
        lines.append("          OMEGA 0.11")
        lines.append("        &END XWPBE")
        lines.append("      &END XC_FUNCTIONAL")
        lines.append("      &HF")
        lines.append("        FRACTION 0.25")
        lines.append("        &SCREENING")
        lines.append("          EPS_SCHWARZ 1.0E-6")
        lines.append("        &END SCREENING")
        lines.append("        &INTERACTION_POTENTIAL")
        lines.append("          POTENTIAL_TYPE SHORTRANGE")
        lines.append("          OMEGA 0.11")
        lines.append("        &END INTERACTION_POTENTIAL")
        lines.append("      &END HF")
    elif f == "BHandHLYP":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &BECKE88")
        lines.append("          SCALE_X 0.5")
        lines.append("        &END BECKE88")
        lines.append("        &LYP_ADIABATIC")
        lines.append("        &END LYP_ADIABATIC")
        lines.append("      &END XC_FUNCTIONAL")
        lines.append("      &HF")
        lines.append("        FRACTION 0.50")
        lines.append("        &SCREENING")
        lines.append("          EPS_SCHWARZ 1.0E-6")
        lines.append("        &END SCREENING")
        lines.append("      &END HF")

    # VDW
    if request.vdw != "none":
        lines.append("      &VDW_POTENTIAL")
        if request.vdw == "DFTD4":
            lines.append("        POTENTIAL_TYPE PAIR_POTENTIAL")
            lines.append("        &PAIR_POTENTIAL")
            lines.append("          TYPE DFTD4")
            lines.append(f"          REFERENCE_FUNCTIONAL {ref_func}")
            lines.append("        &END PAIR_POTENTIAL")
        else:
            lines.append("        POTENTIAL_TYPE PAIR_POTENTIAL")
            lines.append("        &PAIR_POTENTIAL")
            lines.append(f"          TYPE {request.vdw}")
            lines.append(f"          REFERENCE_FUNCTIONAL {ref_func}")
            lines.append("          R_CUTOFF 15")
            lines.append("          PARAMETER_FILE_NAME dftd3.dat")
            lines.append("        &END PAIR_POTENTIAL")
        lines.append("      &END VDW_POTENTIAL")

    # Finer grid for XC (XC_GRID is a subsection of &XC)
    if request.fine_grid_xc:
        lines.append("      &XC_GRID")
        lines.append("        XC_DERIV SPLINE2")
        lines.append("        XC_SMOOTH_RHO NN10")
        lines.append("      &END XC_GRID")

    lines.append("    &END XC")

    # &POISSON
    poisson_periodic = request.periodic
    if request.poisson_solver == "PERIODIC":
        poisson_periodic = "XYZ"
    lines.append("    &POISSON")
    lines.append(f"      PERIODIC {poisson_periodic}")
    lines.append(f"      POISSON_SOLVER {request.poisson_solver}")
    lines.append("    &END POISSON")

    # External electric field (periodic)
    if request.efield_enabled:
        lines.append("    &PERIODIC_EFIELD")
        lines.append(f"      INTENSITY {(request.efield_x**2 + request.efield_y**2 + request.efield_z**2)**0.5:.6E}")
        # Direction normalized
        mag = (request.efield_x**2 + request.efield_y**2 + request.efield_z**2)**0.5
        if mag > 0:
            lines.append(f"      POLARISATION {request.efield_x/mag:.6f} {request.efield_y/mag:.6f} {request.efield_z/mag:.6f}")
        lines.append("    &END PERIODIC_EFIELD")

    # &KPOINTS
    if request.kpoints_enabled and request.periodic != "NONE":
        lines.append("    &KPOINTS")
        lines.append(f"      SCHEME MONKHORST-PACK {request.kpoints_nx} {request.kpoints_ny} {request.kpoints_nz}")
        lines.append("    &END KPOINTS")

    # &PRINT (DFT level)
    has_dft_print = (
        run_type in ("ENERGY", "ENERGY_FORCE") or
        request.print_moments or request.print_orbital_energies or
        request.output_overlap_csr or request.output_ks_csr or
        request.epr_hyperfine
    )
    if has_dft_print:
        lines.append("    &PRINT")
        if request.print_moments:
            lines.append("      &MOMENTS")
            lines.append("      &END MOMENTS")
        if request.print_orbital_energies:
            lines.append("      &MO")
            lines.append("        EIGENVALUES T")
            lines.append("        OCCUPATION_NUMBERS T")
            lines.append("      &END MO")
        if request.output_overlap_csr:
            lines.append("      &AO_MATRICES")
            lines.append("        OVERLAP T")
            lines.append("        FILENAME overlap")
            lines.append("      &END AO_MATRICES")
        if request.output_ks_csr:
            lines.append("      &AO_MATRICES")
            lines.append("        KOHN_SHAM_MATRIX T")
            lines.append("        FILENAME ks")
            lines.append("      &END AO_MATRICES")
        if request.epr_hyperfine:
            lines.append("      &HYPERFINE_COUPLING_TENSOR")
            lines.append("      &END HYPERFINE_COUPLING_TENSOR")
        lines.append("    &END PRINT")

    lines.append("  &END DFT")

    # ---- &SUBSYS ----
    lines.append("  &SUBSYS")

    # &CELL
    cell = info["cell"]
    cell_periodic = request.periodic
    if request.poisson_solver == "PERIODIC":
        cell_periodic = "XYZ"

    # Apply cell repetitions
    rep_x, rep_y, rep_z = request.cell_rep_x, request.cell_rep_y, request.cell_rep_z
    lines.append("    &CELL")
    lines.append(f"      A {cell[0][0]:>18.12f} {cell[0][1]:>18.12f} {cell[0][2]:>18.12f}")
    lines.append(f"      B {cell[1][0]:>18.12f} {cell[1][1]:>18.12f} {cell[1][2]:>18.12f}")
    lines.append(f"      C {cell[2][0]:>18.12f} {cell[2][1]:>18.12f} {cell[2][2]:>18.12f}")
    if rep_x > 1 or rep_y > 1 or rep_z > 1:
        lines.append(f"      MULTIPLE_UNIT_CELL {rep_x} {rep_y} {rep_z}")
    lines.append(f"      PERIODIC {cell_periodic}")
    lines.append("    &END CELL")

    # &TOPOLOGY
    if request.center_coords or request.coord_from_file or (rep_x > 1 or rep_y > 1 or rep_z > 1):
        lines.append("    &TOPOLOGY")
        if rep_x > 1 or rep_y > 1 or rep_z > 1:
            lines.append(f"      MULTIPLE_UNIT_CELL {rep_x} {rep_y} {rep_z}")
        if request.center_coords and run_type != "VIBRATIONAL_ANALYSIS":
            lines.append("      &CENTER_COORDINATES")
            lines.append("      &END CENTER_COORDINATES")
        if request.coord_from_file and request.coord_file_name:
            lines.append(f"      COORD_FILE_NAME {request.coord_file_name}")
            lines.append("      COORD_FILE_FORMAT XYZ")
        lines.append("    &END TOPOLOGY")

    # &COORD (only if not reading from file)
    if not (request.coord_from_file and request.coord_file_name):
        lines.append("    &COORD")
        for el, coord in zip(info["elements"], info["cart_coords"]):
            lines.append(f"      {el:<4} {coord[0]:>18.12f} {coord[1]:>18.12f} {coord[2]:>18.12f}")
        lines.append("    &END COORD")

    # &KIND per unique element
    for el in info["unique_elements"]:
        valence = get_cp2k_valence(el)
        lines.append(f"    &KIND {el}")
        lines.append(f"      BASIS_SET {request.basis_set}")
        if request.lrigpw:
            lines.append(f"      BASIS_SET LRI_AUX LRI-DZVP")
        lines.append(f"      POTENTIAL {potential_prefix}-q{valence}")
        if request.magnetization and el in request.magnetization and request.magnetization[el] != 0:
            lines.append(f"      MAGNETIZATION {request.magnetization[el]:.2f}")
        if request.dftpu_enabled and request.dftpu_settings and el in request.dftpu_settings:
            u = request.dftpu_settings[el]
            lines.append("      &DFT_PLUS_U")
            lines.append(f"        L {u.l}")
            lines.append(f"        U_MINUS_J [eV] {u.u_minus_j:.2f}")
            lines.append("      &END DFT_PLUS_U")
        lines.append(f"    &END KIND")

    lines.append("  &END SUBSYS")

    # FORCE_EVAL PRINT for energy_force or cell_opt stress
    if run_type == "ENERGY_FORCE":
        lines.append("  &PRINT")
        lines.append("    &FORCES")
        lines.append("    &END FORCES")
        lines.append("  &END PRINT")
    elif run_type == "CELL_OPT":
        lines.append("  &PRINT")
        lines.append("    &STRESS_TENSOR")
        lines.append("    &END STRESS_TENSOR")
        lines.append("  &END PRINT")
    lines.append("&END FORCE_EVAL")
    lines.append("")

    # ---- &MOTION ----
    motion_types = ("GEO_OPT", "CELL_OPT", "MD")
    if run_type in motion_types:
        lines.append("&MOTION")

        if run_type == "GEO_OPT":
            lines.append("  &GEO_OPT")
            lines.append(f"    OPTIMIZER {request.geo_optimizer}")
            lines.append(f"    MAX_FORCE {request.geo_max_force:.2E}")
            lines.append(f"    MAX_ITER {request.geo_max_iter}")
            lines.append("  &END GEO_OPT")

        elif run_type == "CELL_OPT":
            lines.append("  &CELL_OPT")
            lines.append(f"    OPTIMIZER {request.geo_optimizer}")
            lines.append(f"    MAX_FORCE {request.geo_max_force:.2E}")
            lines.append(f"    MAX_ITER {request.cell_opt_max_iter}")
            if request.cell_opt_pressure > 0:
                lines.append(f"    EXTERNAL_PRESSURE {request.cell_opt_pressure}")
            lines.append("  &END CELL_OPT")

        elif run_type == "MD":
            lines.append("  &MD")
            lines.append(f"    ENSEMBLE {request.md_ensemble}")
            lines.append(f"    STEPS {request.md_steps}")
            lines.append(f"    TIMESTEP [fs] {request.md_timestep}")
            lines.append(f"    TEMPERATURE [K] {request.md_temperature}")

            if request.md_ensemble in ("NVT", "NPT_I"):
                lines.append("    &THERMOSTAT")
                lines.append(f"      TYPE {request.md_thermostat}")
                lines.append(f"      &{request.md_thermostat}")
                lines.append(f"        TIMECON [fs] {request.md_timecon}")
                lines.append(f"      &END {request.md_thermostat}")
                lines.append("    &END THERMOSTAT")

            if request.md_ensemble == "NPT_I":
                lines.append("    &BAROSTAT")
                lines.append(f"      TIMECON [fs] {request.md_timecon * 10}")
                lines.append("    &END BAROSTAT")

            lines.append("  &END MD")

        # &CONSTRAINT
        if fixed_atoms:
            lines.append("  &CONSTRAINT")
            lines.append("    &FIXED_ATOMS")
            lines.append("      COMPONENTS_TO_FIX XYZ")
            lines.append(f"      LIST {' '.join(str(idx) for idx in fixed_atoms)}")
            lines.append("    &END FIXED_ATOMS")
            lines.append("  &END CONSTRAINT")

        # &PRINT
        print_each_key = "MD" if run_type == "MD" else run_type
        lines.append("  &PRINT")
        lines.append("    &TRAJECTORY")
        lines.append("      &EACH")
        lines.append(f"        {print_each_key} 1")
        lines.append("      &END EACH")
        lines.append("    &END TRAJECTORY")
        if run_type == "MD":
            lines.append("    &RESTART OFF")
            lines.append("    &END RESTART")
        else:
            lines.append("    &RESTART")
            lines.append("      BACKUP_COPIES 0")
            lines.append("      &EACH")
            lines.append(f"        {print_each_key} 1")
            lines.append("      &END EACH")
            lines.append("    &END RESTART")
        lines.append("  &END PRINT")

        lines.append("&END MOTION")
        lines.append("")

    # ---- &VIBRATIONAL_ANALYSIS (top-level section) ----
    if run_type == "VIBRATIONAL_ANALYSIS":
        lines.append("&VIBRATIONAL_ANALYSIS")
        lines.append("  DX 0.01")
        lines.append("  INTENSITIES T")
        lines.append("  THERMOCHEMISTRY T")
        lines.append("  TC [K] 298.15")
        lines.append("&END VIBRATIONAL_ANALYSIS")
        lines.append("")

    return "\n".join(lines)


# ============================================================================
# API Endpoints
# ============================================================================

@router.post("/input", response_model=CP2KInputResponse)
def generate_input_file(request: CP2KInputRequest) -> CP2KInputResponse:
    """Generate CP2K input file from structure."""
    try:
        info = extract_structure_info(request.structure)
        input_content = generate_cp2k_input(request, info)

        message = f"Generated {request.run_type} input for {info['n_atoms']} atoms"
        message += f" ({', '.join(info['unique_elements'])})"
        message += f" with {request.functional}/{request.basis_set}"
        if request.scf_method == "DIAG":
            message += " [Diagonalization"
            if request.smearing:
                message += f"+Smearing({request.electronic_temperature}K)"
            message += "]"

        return CP2KInputResponse(
            success=True,
            input_file=input_content,
            elements=info["unique_elements"],
            n_atoms=info["n_atoms"],
            message=message
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/templates")
def list_templates() -> dict:
    """List available calculation templates with typical settings for CP2K."""
    return {
        "templates": {
            "energy": {
                "description": "Single-point energy calculation",
                "typical_settings": {
                    "run_type": "ENERGY", "functional": "PBE",
                    "basis_set": "DZVP-MOLOPT-SR-GTH", "cutoff": 400,
                    "scf_method": "OT", "vdw": "DFTD3(BJ)",
                }
            },
            "geo_opt": {
                "description": "Geometry optimization (fixed cell)",
                "typical_settings": {
                    "run_type": "GEO_OPT", "functional": "PBE",
                    "basis_set": "DZVP-MOLOPT-SR-GTH", "cutoff": 400,
                    "scf_method": "OT", "geo_optimizer": "BFGS",
                    "geo_max_force": 4.5e-4, "vdw": "DFTD3(BJ)",
                }
            },
            "metal": {
                "description": "Metallic system with Diagonalization + Smearing",
                "typical_settings": {
                    "run_type": "GEO_OPT", "functional": "PBE",
                    "basis_set": "DZVP-MOLOPT-SR-GTH", "cutoff": 400,
                    "scf_method": "DIAG", "smearing": True,
                    "smearing_method": "FERMI_DIRAC", "electronic_temperature": 300,
                    "added_mos": 50, "vdw": "DFTD3(BJ)",
                }
            },
            "md_nvt": {
                "description": "NVT molecular dynamics at 300 K",
                "typical_settings": {
                    "run_type": "MD", "functional": "PBE",
                    "basis_set": "DZVP-MOLOPT-SR-GTH", "cutoff": 400,
                    "scf_method": "OT", "md_ensemble": "NVT",
                    "md_steps": 1000, "md_timestep": 0.5,
                    "md_temperature": 300, "md_thermostat": "CSVR",
                    "vdw": "DFTD3(BJ)",
                }
            },
            "hybrid_pbe0": {
                "description": "Hybrid PBE0 single-point",
                "typical_settings": {
                    "run_type": "ENERGY", "functional": "PBE0",
                    "basis_set": "DZVP-MOLOPT-SR-GTH", "cutoff": 400,
                    "scf_method": "OT", "vdw": "DFTD3(BJ)",
                }
            },
            "hybrid_hse06": {
                "description": "Range-separated HSE06 (good for band gaps)",
                "typical_settings": {
                    "run_type": "ENERGY", "functional": "HSE06",
                    "basis_set": "DZVP-MOLOPT-SR-GTH", "cutoff": 400,
                    "scf_method": "OT", "vdw": "DFTD3(BJ)",
                }
            },
        }
    }

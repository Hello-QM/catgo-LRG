"""CP2K input generation for workflow engine."""

import logging
import re as _re
from typing import Any, Optional

from workflow.engines.vasp import _structure_to_pymatgen_dict

logger = logging.getLogger(__name__)

__all__ = [
    "generate_cp2k_inputs",
]


def _cp2k_valence_electrons(element: str) -> int:
    """Return GTH pseudopotential valence electron count for an element."""
    _table = {
        "H": 1, "He": 2, "Li": 3, "Be": 4, "B": 3, "C": 4, "N": 5, "O": 6,
        "F": 7, "Ne": 8, "Na": 9, "Mg": 10, "Al": 3, "Si": 4, "P": 5, "S": 6,
        "Cl": 7, "Ar": 8, "K": 9, "Ca": 10, "Sc": 11, "Ti": 12, "V": 13,
        "Cr": 14, "Mn": 15, "Fe": 16, "Co": 17, "Ni": 18, "Cu": 11, "Zn": 12,
        "Ga": 13, "Ge": 4, "As": 5, "Se": 6, "Br": 7, "Kr": 8, "Rb": 9,
        "Sr": 10, "Y": 11, "Zr": 12, "Nb": 13, "Mo": 14, "Tc": 15, "Ru": 16,
        "Rh": 17, "Pd": 18, "Ag": 11, "Cd": 12, "In": 13, "Sn": 4, "Sb": 5,
        "Te": 6, "I": 7, "Xe": 8, "Cs": 9, "Ba": 10, "La": 11, "Ce": 12,
        "Pr": 13, "Nd": 14, "Pm": 15, "Sm": 16, "Eu": 17, "Gd": 18, "Tb": 19,
        "Dy": 20, "Ho": 21, "Er": 22, "Tm": 23, "Yb": 24, "Lu": 25, "Hf": 12,
        "Ta": 13, "W": 14, "Re": 15, "Os": 16, "Ir": 17, "Pt": 18, "Au": 11,
        "Hg": 12, "Tl": 13, "Pb": 4, "Bi": 5, "Po": 6, "At": 7, "Rn": 8,
    }
    return _table.get(element, 4)


def generate_cp2k_input_files(
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
) -> dict[str, str]:
    """Pure function: return {filename: content} for CP2K calculation.

    Delegates to _generate_cp2k_input_content() for the heavy lifting.
    Handles the custom_inp_text shortcut path.
    """
    if params.get("custom_inp_text"):
        files = {"project.inp": params["custom_inp_text"]}
        if structure_str:
            from workflow.engines import ensure_poscar
            try:
                files["POSCAR"] = ensure_poscar(structure_str)
            except Exception:
                logger.warning("Failed to prepare POSCAR for custom CP2K input")
        return files

    content = _generate_cp2k_input_content(node_type, params, structure_str)
    return {"project.inp": content}


async def generate_cp2k_inputs(
    hpc: Any,
    work_dir: str,
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
):
    """Generate CP2K input files and upload to HPC."""
    from catgo.utils.job_parser import write_remote_files
    files = generate_cp2k_input_files(node_type, params, structure_str)
    await write_remote_files(hpc.conn, {f"{work_dir}/{k}": v for k, v in files.items()})


def _generate_cp2k_input_content(
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
) -> str:
    """Pure function: generate CP2K project.inp content string."""
    import json
    from pymatgen.core import Structure

    if not structure_str:
        raise RuntimeError("No structure provided for CP2K calculation")

    try:
        struct = Structure.from_str(structure_str, fmt="poscar")
    except Exception:
        struct = Structure.from_dict(json.loads(structure_str))

    # Map node_type to CP2K RUN_TYPE
    run_type_map = {
        "cp2k_geopt": "GEO_OPT",
        "cp2k_static": "ENERGY",
        "cp2k_cellopt": "CELL_OPT",
        "cp2k_md": "MD",
        "cp2k_freq": "VIBRATIONAL_ANALYSIS",
    }
    run_type = params.get("run_type", run_type_map.get(node_type, "ENERGY"))

    functional = params.get("functional", "PBE")
    basis_set = params.get("basis_set", "DZVP-MOLOPT-SR-GTH")
    cutoff = int(params.get("cutoff", 350))
    rel_cutoff = int(params.get("rel_cutoff", 50))
    scf_method = params.get("scf_method", "OT")
    eps_scf = float(params.get("eps_scf", 1e-6))
    max_scf = int(params.get("max_scf", 25 if scf_method == "OT" else 128))
    charge = int(params.get("charge", 0))
    uks = params.get("uks", False)
    multiplicity = int(params.get("multiplicity", 1))
    vdw = params.get("vdw", "none")
    periodic = params.get("periodic", "XYZ")

    # Get unique elements
    elements = sorted(set(str(s) for s in struct.species))

    # Determine potential prefix from functional
    func_upper = functional.upper()
    if func_upper in ("PBE", "PBE0", "REVPBE", "PBESOL", "RPBE", "HSE06"):
        pot_prefix = "GTH-PBE"
    elif func_upper in ("BLYP", "B3LYP", "BP86", "BHANDHLYP"):
        pot_prefix = "GTH-BLYP"
    elif func_upper == "PADE":
        pot_prefix = "GTH-PADE"
    elif func_upper in ("SCAN", "R2SCAN", "TPSS", "REVTPSS"):
        pot_prefix = "GTH-PBE"
    else:
        pot_prefix = "GTH-PBE"

    lines: list[str] = []

    # &GLOBAL
    lines.append("&GLOBAL")
    lines.append("  PROJECT project")
    lines.append(f"  RUN_TYPE {run_type}")
    lines.append("  PRINT_LEVEL LOW")
    lines.append("&END GLOBAL")
    lines.append("")

    # &FORCE_EVAL
    lines.append("&FORCE_EVAL")
    lines.append("  METHOD Quickstep")

    if run_type in ("CELL_OPT",) or (run_type == "MD" and params.get("md_ensemble") == "NPT_I"):
        lines.append("  STRESS_TENSOR ANALYTICAL")

    # &DFT
    lines.append("  &DFT")
    # When the cluster's cp2k_data_dir is set (from RunConfigDialog →
    # Clusters tab → CP2K Data Directory), emit absolute paths. Without
    # it, CP2K resolves the bare filename via $CP2K_DATA_DIR — works on
    # clusters where `module load cp2k` exports that variable, breaks
    # otherwise. The absolute form is the safe default.
    cp2k_data_dir = (params.get("cp2k_data_dir") or "").rstrip("/")
    if cp2k_data_dir:
        lines.append(f"    BASIS_SET_FILE_NAME {cp2k_data_dir}/BASIS_MOLOPT")
        lines.append(f"    POTENTIAL_FILE_NAME {cp2k_data_dir}/GTH_POTENTIALS")
    else:
        lines.append("    BASIS_SET_FILE_NAME BASIS_MOLOPT")
        lines.append("    POTENTIAL_FILE_NAME GTH_POTENTIALS")
    if charge != 0:
        lines.append(f"    CHARGE {charge}")
    if uks:
        lines.append("    UKS T")
        lines.append(f"    MULTIPLICITY {multiplicity}")

    # &MGRID
    lines.append("    &MGRID")
    lines.append(f"      CUTOFF {cutoff}")
    lines.append(f"      REL_CUTOFF {rel_cutoff}")
    lines.append("      NGRIDS 4")
    lines.append("    &END MGRID")

    # &QS
    lines.append("    &QS")
    lines.append("      EPS_DEFAULT 1.0E-12")
    lines.append("    &END QS")

    # &SCF
    if scf_method == "OT":
        lines.append("    &SCF")
        lines.append(f"      EPS_SCF {eps_scf:.1E}")
        lines.append(f"      MAX_SCF {max_scf}")
        lines.append("      SCF_GUESS ATOMIC")
        lines.append("      &OT T")
        ot_minimizer = params.get("ot_minimizer", "DIIS")
        lines.append(f"        MINIMIZER {ot_minimizer}")
        n_atoms = len(struct)
        if n_atoms < 300:
            lines.append("        PRECONDITIONER FULL_ALL")
        else:
            lines.append("        PRECONDITIONER FULL_SINGLE_INVERSE")
        lines.append("        LINESEARCH 2PNT")
        lines.append("        ALGORITHM STRICT")
        lines.append("      &END OT")
        lines.append("      &OUTER_SCF")
        lines.append("        MAX_SCF 20")
        lines.append("        EPS_SCF 1.0E-6")
        lines.append("      &END OUTER_SCF")
        lines.append("    &END SCF")
    else:
        # Diagonalization
        added_mos = int(params.get("added_mos", 50))
        lines.append("    &SCF")
        lines.append(f"      EPS_SCF {eps_scf:.1E}")
        lines.append(f"      MAX_SCF {max_scf}")
        lines.append("      SCF_GUESS ATOMIC")
        if uks:
            lines.append(f"      ADDED_MOS {added_mos} {added_mos}")
        else:
            lines.append(f"      ADDED_MOS {added_mos}")
        lines.append("      &DIAGONALIZATION")
        lines.append("        ALGORITHM STANDARD")
        lines.append("      &END DIAGONALIZATION")

        smearing = params.get("smearing", False)
        if smearing:
            smearing_method = params.get("smearing_method", "FERMI_DIRAC")
            elec_temp = float(params.get("electronic_temperature", 300))
            lines.append("      &SMEAR ON")
            lines.append(f"        METHOD {smearing_method}")
            lines.append(f"        ELECTRONIC_TEMPERATURE [K] {elec_temp}")
            lines.append("      &END SMEAR")

        lines.append("      &MIXING")
        lines.append("        METHOD BROYDEN_MIXING")
        lines.append("        ALPHA 0.4")
        lines.append("        NBROYDEN 8")
        lines.append("      &END MIXING")
        lines.append("    &END SCF")

    # &XC
    lines.append("    &XC")
    # Handle functional families
    hybrid_functionals = {"PBE0", "B3LYP", "HSE06", "BHANDHLYP"}
    shortcut_functionals = {"PBE", "BLYP", "TPSS", "PADE"}
    if func_upper in hybrid_functionals:
        if func_upper == "PBE0":
            lines.append("      &XC_FUNCTIONAL")
            lines.append("        &PBE")
            lines.append("          SCALE_X 0.75")
            lines.append("          SCALE_C 1.0")
            lines.append("        &END PBE")
            lines.append("      &END XC_FUNCTIONAL")
        elif func_upper == "B3LYP":
            lines.append("      &XC_FUNCTIONAL")
            lines.append("        &B3LYP")
            lines.append("        &END B3LYP")
            lines.append("      &END XC_FUNCTIONAL")
        elif func_upper == "HSE06":
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
        elif func_upper == "BHANDHLYP":
            lines.append("      &XC_FUNCTIONAL")
            lines.append("        &BECKE88")
            lines.append("          SCALE_X 0.5")
            lines.append("        &END BECKE88")
            lines.append("        &LYP_ADIABATIC")
            lines.append("        &END LYP_ADIABATIC")
            lines.append("      &END XC_FUNCTIONAL")
        lines.append("      &HF")
        if func_upper == "PBE0":
            lines.append("        FRACTION 0.25")
        elif func_upper == "B3LYP":
            lines.append("        FRACTION 0.20")
        elif func_upper == "HSE06":
            lines.append("        FRACTION 0.25")
        elif func_upper == "BHANDHLYP":
            lines.append("        FRACTION 0.50")
        lines.append("        &SCREENING")
        lines.append("          EPS_SCHWARZ 1.0E-6")
        lines.append("        &END SCREENING")
        if func_upper == "HSE06":
            lines.append("        &INTERACTION_POTENTIAL")
            lines.append("          POTENTIAL_TYPE SHORTRANGE")
            lines.append("          OMEGA 0.11")
            lines.append("        &END INTERACTION_POTENTIAL")
        lines.append("      &END HF")
    elif func_upper in shortcut_functionals:
        lines.append(f"      &XC_FUNCTIONAL {func_upper}")
        lines.append(f"      &END XC_FUNCTIONAL")
    elif func_upper == "SCAN":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &LIBXC")
        lines.append("          FUNCTIONAL MGGA_X_SCAN")
        lines.append("        &END LIBXC")
        lines.append("        &LIBXC")
        lines.append("          FUNCTIONAL MGGA_C_SCAN")
        lines.append("        &END LIBXC")
        lines.append("      &END XC_FUNCTIONAL")
    elif func_upper == "R2SCAN":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &LIBXC")
        lines.append("          FUNCTIONAL MGGA_X_R2SCAN")
        lines.append("        &END LIBXC")
        lines.append("        &LIBXC")
        lines.append("          FUNCTIONAL MGGA_C_R2SCAN")
        lines.append("        &END LIBXC")
        lines.append("      &END XC_FUNCTIONAL")
    elif func_upper == "REVPBE":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &PBE")
        lines.append("          PARAMETRIZATION REVPBE")
        lines.append("        &END PBE")
        lines.append("      &END XC_FUNCTIONAL")
    elif func_upper == "PBESOL":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &PBE")
        lines.append("          PARAMETRIZATION PBESOL")
        lines.append("        &END PBE")
        lines.append("      &END XC_FUNCTIONAL")
    elif func_upper == "RPBE":
        lines.append("      &XC_FUNCTIONAL")
        lines.append("        &GGA_X_RPBE")
        lines.append("        &END GGA_X_RPBE")
        lines.append("        &GGA_C_PBE")
        lines.append("        &END GGA_C_PBE")
        lines.append("      &END XC_FUNCTIONAL")
    else:
        # Fallback: use as shortcut (works for PBE, BLYP, etc.)
        lines.append(f"      &XC_FUNCTIONAL {func_upper}")
        lines.append(f"      &END XC_FUNCTIONAL")

    # VDW
    if vdw != "none":
        lines.append("      &VDW_POTENTIAL")
        lines.append("        POTENTIAL_TYPE PAIR_POTENTIAL")
        lines.append("        &PAIR_POTENTIAL")
        if vdw == "DFTD3(BJ)":
            lines.append("          TYPE DFTD3(BJ)")
            lines.append(f"          REFERENCE_FUNCTIONAL {func_upper}")
            lines.append("          PARAMETER_FILE_NAME dftd3.dat")
        elif vdw == "DFTD3":
            lines.append("          TYPE DFTD3")
            lines.append(f"          REFERENCE_FUNCTIONAL {func_upper}")
            lines.append("          PARAMETER_FILE_NAME dftd3.dat")
        elif vdw == "DFTD2":
            lines.append("          TYPE DFTD2")
            lines.append(f"          REFERENCE_FUNCTIONAL {func_upper}")
        elif vdw == "DFTD4":
            lines.append("          TYPE DFTD4")
            lines.append(f"          REFERENCE_FUNCTIONAL {func_upper}")
        lines.append("        &END PAIR_POTENTIAL")
        lines.append("      &END VDW_POTENTIAL")

    lines.append("    &END XC")

    # &POISSON
    poisson_solver = params.get("poisson_solver", "PERIODIC")
    lines.append("    &POISSON")
    lines.append(f"      PERIODIC {periodic}")
    lines.append(f"      POISSON_SOLVER {poisson_solver}")
    lines.append("    &END POISSON")

    lines.append("  &END DFT")

    # &SUBSYS
    lines.append("  &SUBSYS")

    # &CELL
    lattice = struct.lattice
    lines.append("    &CELL")
    lines.append(f"      A {lattice.matrix[0][0]:.10f} {lattice.matrix[0][1]:.10f} {lattice.matrix[0][2]:.10f}")
    lines.append(f"      B {lattice.matrix[1][0]:.10f} {lattice.matrix[1][1]:.10f} {lattice.matrix[1][2]:.10f}")
    lines.append(f"      C {lattice.matrix[2][0]:.10f} {lattice.matrix[2][1]:.10f} {lattice.matrix[2][2]:.10f}")
    lines.append(f"      PERIODIC {periodic}")
    lines.append("    &END CELL")

    # &COORD
    lines.append("    &COORD")
    for site in struct:
        x, y, z = site.coords
        lines.append(f"      {str(site.specie):>4s}  {x:.10f}  {y:.10f}  {z:.10f}")
    lines.append("    &END COORD")

    # &KIND for each element
    for el in elements:
        lines.append(f"    &KIND {el}")
        lines.append(f"      BASIS_SET {basis_set}")
        lines.append(f"      POTENTIAL {pot_prefix}-q{_cp2k_valence_electrons(el)}")
        lines.append(f"    &END KIND")

    lines.append("  &END SUBSYS")

    # FORCE_EVAL PRINT for energy_force
    if run_type == "ENERGY_FORCE":
        lines.append("  &PRINT")
        lines.append("    &FORCES")
        lines.append("    &END FORCES")
        lines.append("  &END PRINT")

    lines.append("&END FORCE_EVAL")
    lines.append("")

    # &MOTION section
    if run_type in ("GEO_OPT", "CELL_OPT"):
        optimizer = params.get("geo_opt_optimizer", "BFGS")
        max_iter = int(params.get("geo_opt_max_iter", 200))
        max_force = float(params.get("geo_opt_max_force", 4.5e-4))
        lines.append("&MOTION")
        if run_type == "GEO_OPT":
            lines.append("  &GEO_OPT")
        else:
            lines.append("  &CELL_OPT")
        lines.append(f"    OPTIMIZER {optimizer}")
        lines.append(f"    MAX_ITER {max_iter}")
        lines.append(f"    MAX_FORCE {max_force:.2E}")
        if run_type == "GEO_OPT":
            lines.append("  &END GEO_OPT")
        else:
            lines.append("  &END CELL_OPT")

        # Print trajectory
        lines.append("  &PRINT")
        lines.append("    &TRAJECTORY")
        lines.append("      &EACH")
        lines.append("        GEO_OPT 1")
        lines.append("      &END EACH")
        lines.append("    &END TRAJECTORY")
        lines.append("    &RESTART")
        lines.append("      BACKUP_COPIES 0")
        lines.append("      &EACH")
        lines.append("        GEO_OPT 1")
        lines.append("      &END EACH")
        lines.append("    &END RESTART")
        lines.append("  &END PRINT")
        lines.append("&END MOTION")
        lines.append("")
    elif run_type == "MD":
        ensemble = params.get("md_ensemble", "NVT")
        md_steps = int(params.get("md_steps", 1000))
        timestep = float(params.get("md_timestep", 0.5))
        temperature = float(params.get("md_temperature", 300))
        lines.append("&MOTION")
        lines.append("  &MD")
        lines.append(f"    ENSEMBLE {ensemble}")
        lines.append(f"    STEPS {md_steps}")
        lines.append(f"    TIMESTEP [fs] {timestep}")
        lines.append(f"    TEMPERATURE [K] {temperature}")
        if ensemble == "NVT":
            lines.append("    &THERMOSTAT")
            lines.append("      TYPE NOSE")
            lines.append("      &NOSE")
            lines.append("        LENGTH 3")
            lines.append("        YOSHIDA 3")
            lines.append(f"        TIMECON [fs] {10 * timestep}")
            lines.append("        MTS 2")
            lines.append("      &END NOSE")
            lines.append("    &END THERMOSTAT")
        elif ensemble == "NPT_I":
            lines.append("    &THERMOSTAT")
            lines.append("      TYPE NOSE")
            lines.append("      &NOSE")
            lines.append("        LENGTH 3")
            lines.append("        YOSHIDA 3")
            lines.append(f"        TIMECON [fs] {10 * timestep}")
            lines.append("        MTS 2")
            lines.append("      &END NOSE")
            lines.append("    &END THERMOSTAT")
            lines.append("    &BAROSTAT")
            lines.append(f"      TIMECON [fs] {100 * timestep}")
            lines.append("    &END BAROSTAT")
        lines.append("  &END MD")

        lines.append("  &PRINT")
        lines.append("    &TRAJECTORY")
        lines.append("      &EACH")
        lines.append("        MD 1")
        lines.append("      &END EACH")
        lines.append("    &END TRAJECTORY")
        lines.append("    &RESTART OFF")
        lines.append("    &END RESTART")
        lines.append("  &END PRINT")
        lines.append("&END MOTION")
        lines.append("")

    elif run_type == "VIBRATIONAL_ANALYSIS":
        lines.append("&VIBRATIONAL_ANALYSIS")
        lines.append("  DX 0.01")
        lines.append("  INTENSITIES T")
        lines.append("  THERMOCHEMISTRY T")
        lines.append("  TC [K] 298.15")
        lines.append("&END VIBRATIONAL_ANALYSIS")
        lines.append("")

    # Fixed atoms via &CONSTRAINT
    fixed_elements = params.get("fixed_elements", [])
    fixed_indices_str = params.get("fixed_indices", "")
    fixed_indices: list[int] = []
    if fixed_indices_str:
        for part in str(fixed_indices_str).split(","):
            part = part.strip()
            m = _re.match(r"(\d+)\s*-\s*(\d+)", part)
            if m:
                fixed_indices.extend(range(int(m.group(1)), int(m.group(2)) + 1))
            elif part.isdigit():
                fixed_indices.append(int(part))

    # Collect indices from fixed elements
    if fixed_elements:
        for i, site in enumerate(struct, 1):
            if str(site.specie) in fixed_elements:
                if i not in fixed_indices:
                    fixed_indices.append(i)

    if fixed_indices:
        # Insert &CONSTRAINT into &MOTION (if MOTION section exists)
        constraint_lines = []
        constraint_lines.append("  &CONSTRAINT")
        constraint_lines.append("    &FIXED_ATOMS")
        constraint_lines.append("      COMPONENTS_TO_FIX XYZ")
        idx_str = " ".join(str(i) for i in sorted(set(fixed_indices)))
        constraint_lines.append(f"      LIST {idx_str}")
        constraint_lines.append("    &END FIXED_ATOMS")
        constraint_lines.append("  &END CONSTRAINT")
        # Find the last &END MOTION and insert before it
        for i in range(len(lines) - 1, -1, -1):
            if lines[i].strip() == "&END MOTION":
                for j, cl in enumerate(constraint_lines):
                    lines.insert(i, cl)
                break

    input_content = "\n".join(lines) + "\n"
    logger.info("Generated CP2K input (%s)", run_type)
    return input_content

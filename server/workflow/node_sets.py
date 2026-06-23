"""Node type set definitions and software resolution.

Every workflow node type belongs to exactly one set, which determines how
the engine dispatches it (HPC submission, local execution, analysis, etc.).
"""

__all__ = [
    "VASP_CALC_NODES",
    "UNIFIED_CALC_NODES",
    "LOCAL_NODES",
    "MLP_NODES",
    "XTB_NODES",
    "SELLA_NODES",
    "CP2K_NODES",
    "LAMMPS_NODES",
    "BUILD_NODES",
    "POLYMER_SIM_NODES",
    "ORCA_CALC_NODES",
    "GAUSSIAN_CALC_NODES",
    "GROMACS_NODES",
    "QE_CALC_NODES",
    "QCHEM_CALC_NODES",
    "AMBER_NODES",
    "KMC_NODES",
    "ANALYSIS_NODES",
    "HPC_ANALYSIS_NODES",
    "get_engine_for_node",
]

# Node types that produce VASP calculations
VASP_CALC_NODES = {
    "vasp_relax", "vasp_static", "vasp_md", "bulk_opt", "slab_relax",
    "frequency", "electronic", "reference_mol", "slow_growth", "neb",
}

# Unified node types (software chosen by params.software)
UNIFIED_CALC_NODES = {"geo_opt", "single_point", "cell_opt", "md", "md_minimize", "freq", "ts_search", "irc", "uvvis", "neb"}

# Node types that are handled locally (no HPC submission)
LOCAL_NODES = {
    "structure_input", "structure_list_input", "slab_gen", "adsorbate_place",
    "batch_adsorbate_place",
    "condition", "loop", "merge",
    # NOTE: free_energy is routed via ANALYSIS_NODES (its handler lives in
    # workflow.engines.analysis.execute_analysis_node, not local.py). Keeping it
    # out of LOCAL_NODES avoids the no-op path that marked it COMPLETED with no
    # result (which silently broke every recipe ending in free_energy).
    "gibbs_energy",
    # export_data is handled by workflow.engines.local (node_type=="export_data")
    # but was missing from this set, so it routed to "unknown".
    "export_data",
    # High-throughput screening nodes (local orchestration)
    "batch_generate", "batch_slab_gen", "batch_coverage_gen", "map", "aggregate",
    # Build/transform nodes (local structure operations)
    "doping_gen", "defect_gen", "supercell_gen", "strain_deform",
    "intercalation", "heterostructure_build", "nanotube_build",
    "water_solvate", "passivate",
    "polymer_build", "polymer_crosslink",
}

# Node types that use ML potentials (submitted as HPC jobs too)
MLP_NODES = {"mlp_relax", "mlp_md", "mlp_single_point", "mlp_vibrations", "mlp_neb"}

# Node types that use xTB (semi-empirical, submitted as HPC jobs)
XTB_NODES = {"xtb_relax", "xtb_static"}

# Node types that use Sella (transition state search, submitted as HPC jobs)
SELLA_NODES = {"sella_ts"}

# Node types that produce CP2K calculations (submitted as HPC jobs)
CP2K_NODES = {"cp2k_geopt", "cp2k_static", "cp2k_cellopt", "cp2k_md", "cp2k_freq"}

# Node types that use LAMMPS (submitted as HPC jobs)
LAMMPS_NODES = {"lammps_md", "lammps_minimize", "polymer_md"}

# Node types that build/transform structures locally (no HPC)
BUILD_NODES = {
    "defect_gen", "supercell_gen", "strain_deform", "doping_gen",
    "intercalation", "heterostructure_build", "nanotube_build",
    "water_solvate", "passivate",
    "polymer_build", "polymer_crosslink",
}

# Polymer nodes that run LAMMPS locally or on HPC
POLYMER_SIM_NODES = {"polymer_deform", "glass_transition"}

# Node types that use ORCA (quantum chemistry, submitted as HPC jobs)
ORCA_CALC_NODES = {"orca_opt", "orca_sp", "orca_freq", "orca_neb_ts", "orca_irc", "orca_uvvis"}

# Node types that use Gaussian (quantum chemistry, submitted as HPC jobs)
GAUSSIAN_CALC_NODES = {"gaussian_opt", "gaussian_sp", "gaussian_freq"}

# Node types that use GROMACS (classical MD, submitted as HPC jobs)
GROMACS_NODES = {"gromacs_md", "gromacs_minimize"}

# Node types that use Quantum ESPRESSO (submitted as HPC jobs)
QE_CALC_NODES = {"qe_scf", "qe_relax", "qe_bands", "qe_dos", "qe_phonon"}

# Node types that use Q-Chem (quantum chemistry, submitted as HPC jobs)
QCHEM_CALC_NODES = {"qchem_static", "qchem_opt", "qchem_ts"}

# Node types that use AMBER (ML/MM, classical MD, submitted as HPC jobs)
AMBER_NODES = {"amber_md", "amber_minimize"}

# Node types that use KMC (Kinetic Monte Carlo, submitted as HPC jobs)
KMC_NODES = {"kmc"}

# Node types that perform analysis locally
ANALYSIS_NODES = {
    "dos_analysis", "cohp_analysis", "md_analysis",
    "charge_analysis",
    "phonon_analysis", "eos_analysis", "elastic_analysis",
    "surface_energy", "wulff_construction", "adsorption_energy",
    "coverage_analysis",
    # Post-processing nodes whose handlers already live in
    # workflow.engines.analysis.execute_analysis_node but were never listed
    # here, so the scanner routed them to "unknown" and templates using them
    # could not run.
    "convergence_check", "energy_compare", "pick_best", "her_analysis",
    # free_energy builds the reaction free-energy diagram from upstream
    # freq/energy results; its handler is in execute_analysis_node. It used to
    # sit in LOCAL_NODES (→ no-op COMPLETED, empty result), breaking every
    # recipe (HER/OER/ORR/NRR/CO2RR) whose final node is free_energy.
    "free_energy",
    # Generic passthrough for unmapped/blank analysis kinds (see _resolve_software).
    "analysis_passthrough",
}

# HPC analysis nodes (currently empty — charge_analysis moved to ANALYSIS_NODES
# because it is post-processing that reads existing HPC output, not a new HPC job)
HPC_ANALYSIS_NODES: set[str] = set()


# A generic "analysis" node carries the concrete kind in params["type"]; map it
# to the specific analysis node whose handler already exists in
# workflow.engines.analysis. Without this, templates that use an `analysis` node
# (elastic / phonon / EOS / trajectory / surface energy) routed to "unknown".
_ANALYSIS_TYPE_MAP = {
    "elastic": "elastic_analysis",
    "phonon": "phonon_analysis",
    "eos": "eos_analysis",
    "trajectory_analysis": "md_analysis",
    "trajectory": "md_analysis",
    "md": "md_analysis",
    "dos": "dos_analysis",
    "cohp": "cohp_analysis",
    "charge": "charge_analysis",
    "bader": "charge_analysis",
    "surface_energy": "surface_energy",
    "wulff": "wulff_construction",
    "adsorption_energy": "adsorption_energy",
    "coverage": "coverage_analysis",
}


def _resolve_software(node_type: str, params: dict[str, object]) -> tuple[str, str]:
    """For unified nodes, resolve (effective_node_type, software) from params.

    Consults declarative engine specs first, then falls back to hardcoded map
    for engines not yet migrated to YAML.
    """
    if node_type == "analysis":
        atype = str(params.get("type", "")).lower()
        mapped = _ANALYSIS_TYPE_MAP.get(atype)
        if mapped:
            return mapped, ""
        # Unmapped analysis kind (e.g. a teaching template with type="re-optimize"
        # or a blank type) → generic passthrough that echoes upstream results,
        # so the node completes locally with real data instead of falling through
        # to the HPC submitter ("No HPC connection available").
        return "analysis_passthrough", ""

    if node_type not in UNIFIED_CALC_NODES:
        return node_type, ""

    software = str(params.get("software", "vasp"))

    # 1. Try declarative engine runtime
    try:
        from workflow.engine_runtime import build_unified_calc_map
        declarative_map = build_unified_calc_map()
        resolved = declarative_map.get((node_type, software))
        if resolved:
            return resolved, software
    except Exception:
        pass

    # 2. Fallback: hardcoded map for engines not yet migrated
    _legacy_map: dict[tuple[str, str], str] = {
        ("geo_opt", "vasp"): "vasp_relax",
        ("geo_opt", "cp2k"): "cp2k_geopt",
        ("geo_opt", "orca"): "orca_opt",
        ("geo_opt", "xtb"): "xtb_relax",
        ("geo_opt", "mlp"): "mlp_relax",
        ("single_point", "vasp"): "vasp_static",
        ("single_point", "cp2k"): "cp2k_static",
        ("single_point", "orca"): "orca_sp",
        ("single_point", "xtb"): "xtb_static",
        ("single_point", "mlp"): "mlp_single_point",
        ("freq", "mlp"): "mlp_vibrations",
        ("neb", "vasp"): "neb",
        ("neb", "mlp"): "mlp_neb",
        ("ts_search", "mlp"): "mlp_neb",
        ("cell_opt", "vasp"): "bulk_opt",
        ("cell_opt", "cp2k"): "cp2k_cellopt",
        ("cell_opt", "mlp"): "mlp_relax",
        ("md", "vasp"): "vasp_md",
        ("md", "cp2k"): "cp2k_md",
        ("md", "lammps"): "lammps_md",
        ("md", "gromacs"): "gromacs_md",
        ("md", "amber"): "amber_md",
        ("md", "mlp"): "mlp_md",
        ("md_minimize", "lammps"): "lammps_minimize",
        ("md_minimize", "gromacs"): "gromacs_minimize",
        ("md_minimize", "amber"): "amber_minimize",
        ("md_minimize", "mlp"): "mlp_relax",
        ("freq", "vasp"): "frequency",
        ("freq", "cp2k"): "cp2k_freq",
        ("freq", "orca"): "orca_freq",
        ("freq", "gaussian"): "gaussian_freq",
        ("geo_opt", "amber"): "amber_minimize",
        ("geo_opt", "gaussian"): "gaussian_opt",
        ("single_point", "gaussian"): "gaussian_sp",
        ("ts_search", "sella"): "sella_ts",
        ("ts_search", "orca"): "orca_neb_ts",
        ("irc", "orca"): "orca_irc",
        ("uvvis", "orca"): "orca_uvvis",
    }
    resolved = _legacy_map.get((node_type, software))
    if resolved:
        return resolved, software
    return node_type, software


def get_engine_for_node(node_type: str) -> str:
    """Return the engine key for a given resolved node type.

    Returns one of: 'vasp', 'cp2k', 'mlp', 'xtb', 'sella', 'lammps',
    'orca', 'gaussian', 'gromacs', 'local', 'analysis', 'hpc_analysis',
    'build', 'polymer_sim', or 'unknown'.
    """
    if node_type in VASP_CALC_NODES:
        return "vasp"
    if node_type in CP2K_NODES:
        return "cp2k"
    if node_type in MLP_NODES:
        return "mlp"
    if node_type in XTB_NODES:
        return "xtb"
    if node_type in SELLA_NODES:
        return "sella"
    if node_type in LAMMPS_NODES:
        return "lammps"
    if node_type in ORCA_CALC_NODES:
        return "orca"
    if node_type in GAUSSIAN_CALC_NODES:
        return "gaussian"
    if node_type in GROMACS_NODES:
        return "gromacs"
    if node_type in QE_CALC_NODES:
        return "qe"
    if node_type in QCHEM_CALC_NODES:
        return "qchem"
    if node_type in AMBER_NODES:
        return "amber"
    if node_type in KMC_NODES:
        return "kmc"
    if node_type in LOCAL_NODES:
        return "local"
    if node_type in ANALYSIS_NODES:
        return "analysis"
    if node_type in HPC_ANALYSIS_NODES:
        return "hpc_analysis"
    if node_type in BUILD_NODES:
        return "build"
    if node_type in POLYMER_SIM_NODES:
        return "polymer_sim"
    return "unknown"

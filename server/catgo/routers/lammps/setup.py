"""LAMMPS input file generation endpoints (data file, input script, sequential, polymer).

Provides FastAPI endpoints for generating LAMMPS data files, input scripts,
polymer building, cross-linking, glass transition workflows, and sequential
multi-stage simulation scripts. Also includes validation utilities for
pair styles, units, and potential templates.
"""

import os
from typing import Optional

__all__ = [
    "router",
    "LammpsInputRequest",
    "LammpsInputResponse",
    "ValidationResult",
    "LammpsErrorResponse",
    "PolymerBuildRequest",
    "PolymerBuildResponse",
    "PolymerCrosslinkRequest",
    "CrosslinkResponse",
    "GlassTransitionRequest",
    "GlassTransitionResponse",
    "PolymerWorkflowRequest",
    "PolymerWorkflowResponse",
    "generate_data_file",
    "generate_input_script",
    "validate_pair_coeff",
    "validate_units_and_params",
]

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from catgo.models.structure import (
    PymatgenStructure,
    SequentialLammpsRequest,
    SequentialLammpsResponse,
    SimulationStage,
)
from .utils import (
    ATOMIC_MASSES,
    POLYMER_MONOMERS,
    POLYMER_FORCE_FIELDS,
    extract_structure_info,
    get_box_bounds,
    transform_coords_to_lammps,
    parse_lammps_data_info,
)

router = APIRouter()


# ============================================================================
# Request/Response Models
# ============================================================================

class LammpsInputRequest(BaseModel):
    """Request for LAMMPS input file generation."""

    structure: PymatgenStructure
    prefix: str = Field(default="system", description="Prefix for output files")

    # Units and style
    units: str = Field(default="metal", description="LAMMPS units: metal, real, lj, etc.")
    atom_style: str = Field(default="atomic", description="Atom style: atomic, charge, full, etc.")
    boundary: str = Field(default="p p p", description="Boundary conditions (e.g., 'p p p' for periodic)")

    # Simulation type
    simulation_type: str = Field(
        default="minimize",
        description="Simulation type: minimize, nve, nvt, npt"
    )

    # Pair interactions
    pair_style: str = Field(default="eam/alloy", description="Pair style for interactions")
    pair_coeff: Optional[str] = Field(
        default=None,
        description="Pair coefficients (e.g., '* * potential.eam.alloy Ni Cu'). Left as placeholder if not provided."
    )
    potential_file: Optional[str] = Field(
        default=None,
        description="Path to potential file (for EAM, ReaxFF, etc.)"
    )

    # Bonded interactions (required for molecular systems)
    bond_style: Optional[str] = Field(default=None, description="Bond style (e.g., 'harmonic', 'fene', 'zero')")
    bond_coeff: Optional[str] = Field(
        default=None,
        description="Bond coefficients, one line per type (e.g., '1 176.864 0.9611')"
    )
    angle_style: Optional[str] = Field(default=None, description="Angle style (e.g., 'harmonic', 'charmm', 'zero')")
    angle_coeff: Optional[str] = Field(
        default=None,
        description="Angle coefficients, one line per type (e.g., '1 42.1845 109.4712')"
    )
    dihedral_style: Optional[str] = Field(default=None, description="Dihedral style (e.g., 'opls', 'charmm', 'harmonic')")
    dihedral_coeff: Optional[str] = Field(default=None, description="Dihedral coefficients, one line per type")
    improper_style: Optional[str] = Field(default=None, description="Improper style (e.g., 'cvff', 'harmonic')")
    improper_coeff: Optional[str] = Field(default=None, description="Improper coefficients, one line per type")

    # Long-range electrostatics
    kspace_style: Optional[str] = Field(default=None, description="KSpace solver (e.g., 'pppm 1.0e-5', 'ewald 1.0e-4')")

    # Special bonds (controls 1-2, 1-3, 1-4 exclusions)
    special_bonds: Optional[str] = Field(default=None, description="Special bond weights (e.g., 'lj 0.0 0.0 0.5 coul 0.0 0.0 0.8333')")

    # Topology for data file (bonds, angles, etc.)
    bonds: Optional[list[list[int]]] = Field(
        default=None,
        description="Bond list: [[bond_type, atom1_id, atom2_id], ...] (1-indexed)"
    )
    angles: Optional[list[list[int]]] = Field(
        default=None,
        description="Angle list: [[angle_type, atom1_id, atom2_id, atom3_id], ...] (1-indexed)"
    )
    dihedrals: Optional[list[list[int]]] = Field(
        default=None,
        description="Dihedral list: [[type, atom1, atom2, atom3, atom4], ...] (1-indexed)"
    )
    impropers: Optional[list[list[int]]] = Field(
        default=None,
        description="Improper list: [[type, atom1, atom2, atom3, atom4], ...] (1-indexed)"
    )
    n_bond_types: int = Field(default=0, description="Number of bond types")
    n_angle_types: int = Field(default=0, description="Number of angle types")
    n_dihedral_types: int = Field(default=0, description="Number of dihedral types")
    n_improper_types: int = Field(default=0, description="Number of improper types")
    molecule_ids: Optional[list[int]] = Field(
        default=None,
        description="Molecule ID for each atom (1-indexed). Auto-assigned as 1 if not provided."
    )

    # Minimization settings
    min_style: str = Field(default="cg", description="Minimization style: cg, sd, fire, etc.")
    etol: float = Field(default=1e-8, description="Energy tolerance for minimization")
    ftol: float = Field(default=1e-8, description="Force tolerance for minimization")
    maxiter: int = Field(default=10000, description="Max iterations for minimization")
    maxeval: int = Field(default=100000, description="Max force evaluations for minimization")

    # MD settings
    timestep: float = Field(default=0.001, description="Timestep (in time units)")
    temperature: float = Field(default=300.0, description="Temperature (K)")
    pressure: float = Field(default=0.0, description="Pressure (bar)")
    run_steps: int = Field(default=10000, description="Number of MD steps")

    # Thermostat/Barostat
    tdamp: float = Field(default=0.1, description="Temperature damping parameter (ps)")
    pdamp: float = Field(default=1.0, description="Pressure damping parameter (ps)")

    # Output settings
    thermo_freq: int = Field(default=100, description="Thermo output frequency")
    dump_freq: int = Field(default=1000, description="Dump output frequency")
    dump_format: str = Field(default="custom", description="Dump format: atom, custom, xyz, cfg")

    # Fixed atoms
    fixed_indices: Optional[list[int]] = Field(
        default=None,
        description="Indices of atoms to fix during simulation"
    )
    fixed_z_below: Optional[float] = Field(
        default=None,
        description="Fix all atoms with z-coordinate below this value"
    )

    # Custom data file (use existing file instead of generating)
    custom_data_file: Optional[str] = Field(
        default=None,
        description="Path to existing LAMMPS data file. Skips data file generation."
    )

    # Extra commands (inserted after force field section)
    extra_commands: Optional[str] = Field(
        default=None,
        description="Additional LAMMPS commands after force field (e.g. kspace_style, bond_style)"
    )

    # Restart file
    read_restart: bool = Field(
        default=False,
        description="Read from restart file instead of data file"
    )
    restart_filename: str = Field(
        default="input.restart",
        description="Restart filename to read from"
    )
    write_restart: bool = Field(
        default=True,
        description="Write restart file at the end of simulation"
    )


class LammpsInputResponse(BaseModel):
    """Response containing LAMMPS input files."""

    success: bool
    input_script: str = Field(description="LAMMPS input script (.in)")
    data_file: str = Field(description="LAMMPS data file (.data)")
    elements: list[str] = Field(description="List of unique elements")
    n_atoms: int = Field(description="Total number of atoms")
    n_types: int = Field(description="Number of atom types")
    message: str = ""
    warnings: list[str] = Field(default_factory=list, description="Validation warnings")
    errors: list[str] = Field(default_factory=list, description="Validation errors")


class ValidationResult(BaseModel):
    """Result of input validation."""
    valid: bool = True
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class LammpsErrorResponse(BaseModel):
    """Detailed error response for LAMMPS generation failures."""
    error: str = Field(description="Error category")
    message: str = Field(description="Human-readable error message")
    expected: str = Field(default="", description="Expected format/value")
    received: str = Field(default="", description="Actual received value")
    suggestion: str = Field(default="", description="Suggestion for fixing the error")


# ============================================================================
# Polymer-Specific Request/Response Models
# ============================================================================

class PolymerBuildRequest(BaseModel):
    """Request to build a polymer chain."""
    polymer_type: str = Field(..., description="Polymer type: PE, PP, PS, PMMA, PET, PA6")
    chain_length: int = Field(default=100, description="Number of monomer units", ge=1, le=10000)
    tacticity: str = Field(default="atactic", description="Tacticity: isotactic, syndiotactic, atactic")
    force_field: str = Field(default="opls", description="Force field: opls, pcff, compass, dreiding")
    density: float = Field(default=0.85, description="Target density for packing (g/cm^3)")
    box_size: Optional[tuple[float, float, float]] = Field(
        default=None,
        description="Box size (x, y, z) in Angstroms. If None, auto-calculated from density"
    )
    seed: int = Field(default=42, description="Random seed for chain generation")


class PolymerCrosslinkRequest(BaseModel):
    """Request to create crosslinked polymer network."""
    polymer_structure: PymatgenStructure = Field(..., description="Polymer structure to crosslink")
    crosslinker_type: str = Field(default="sulfur", description="Crosslinker: sulfur, peroxide, radiation")
    crosslink_density: float = Field(
        default=0.05,
        description="Target crosslink density (fraction of bonds to crosslink)",
        ge=0.0, le=1.0
    )
    target_atoms: Optional[list[str]] = Field(
        default=None,
        description="Element types to crosslink (e.g., ['C', 'H']). None = auto-detect"
    )
    min_distance: float = Field(default=4.0, description="Minimum distance for crosslink formation (Angstroms)")
    max_distance: float = Field(default=6.0, description="Maximum distance for crosslink formation (Angstroms)")


class GlassTransitionRequest(BaseModel):
    """Request to calculate glass transition temperature."""
    polymer_structure: PymatgenStructure = Field(..., description="Polymer structure")
    temp_min: float = Field(default=100.0, description="Starting temperature (K)")
    temp_max: float = Field(default=500.0, description="Ending temperature (K)")
    temp_step: float = Field(default=20.0, description="Temperature increment (K)")
    equil_steps: int = Field(default=10000, description="Equilibration steps per temperature")
    prod_steps: int = Field(default=5000, description="Production steps per temperature")
    cooling_rate: float = Field(default=1.0, description="Cooling rate (K/ns)")


class PolymerBuildResponse(BaseModel):
    """Response from polymer building."""
    success: bool
    structure: Optional[PymatgenStructure] = None
    data_file: Optional[str] = None
    input_script: Optional[str] = None
    n_chains: int = 1
    n_monomers: int = 0
    density: float = 0.0
    message: str = ""
    warnings: list[str] = Field(default_factory=list)


class CrosslinkResponse(BaseModel):
    """Response from crosslinking."""
    success: bool
    structure: Optional[PymatgenStructure] = None
    n_crosslinks: int = 0
    crosslink_positions: list[tuple[float, float, float]] = Field(default_factory=list)
    message: str = ""


class GlassTransitionResponse(BaseModel):
    """Response from Tg calculation."""
    success: bool
    tg_estimate: Optional[float] = Field(None, description="Estimated Tg (K)")
    density_profile: list[dict] = Field(default_factory=list, description="Density vs temperature data")
    script: str = Field(default="", description="LAMMPS input script for Tg calculation")
    message: str = ""


class PolymerWorkflowRequest(BaseModel):
    """Request for multi-stage polymer MD workflow."""
    # Structure
    structure: PymatgenStructure
    prefix: str = Field(default="polymer", description="Prefix for output files")

    # Force field
    pair_style: str = Field(default="lj/cut 2.5", description="Pair style")
    pair_coeff: str = Field(default="* * 1.0 1.0", description="Pair coefficients")
    bond_style: str = Field(default="none", description="Bond style: none, fene, harmonic")
    bond_coeff: str = Field(default="", description="Bond coefficients")

    # Workflow mode
    workflow_mode: str = Field(
        default="polymer_kg",
        description="Workflow: single, polymer_kg, glass_transition"
    )

    # Simulation parameters
    temperature: float = Field(default=1.0, description="Temperature (reduced units or K)")
    pressure: float = Field(default=0.0, description="Pressure (reduced units or atm)")
    timestep: float = Field(default=0.01, description="Timestep")

    # Stage-specific steps
    gen_steps_nvt: int = Field(default=5000, description="Generation NVT steps")
    gen_steps_npt: int = Field(default=50000, description="Generation NPT steps")
    equil_steps: int = Field(default=100000, description="Equilibration NPT steps")
    prod_steps: int = Field(default=100000, description="Production NVT steps")
    prod_dump_freq: int = Field(default=1000, description="Production dump frequency")

    # Units
    units: str = Field(default="lj", description="Units: lj, real, metal")
    atom_style: str = Field(default="molecular", description="Atom style")


class PolymerWorkflowResponse(BaseModel):
    """Response from polymer workflow generation."""
    success: bool
    input_script: str
    data_file: str
    stages: list[dict]
    message: str
    warnings: list[str] = Field(default_factory=list)


# ============================================================================
# File Generation Functions
# ============================================================================

def generate_data_file(request: LammpsInputRequest, info: dict) -> str:
    """Generate LAMMPS data file.

    Supports the full LAMMPS data format including Bonds, Angles, Dihedrals,
    and Impropers sections when topology is provided in the request.  Molecule
    IDs can be supplied per atom; otherwise all atoms are placed in molecule 1.

    See https://docs.lammps.org/read_data.html for the specification.
    """
    n_bonds = len(request.bonds) if request.bonds else 0
    n_angles = len(request.angles) if request.angles else 0
    n_dihedrals = len(request.dihedrals) if request.dihedrals else 0
    n_impropers = len(request.impropers) if request.impropers else 0

    n_bond_types = request.n_bond_types or (max(b[0] for b in request.bonds) if request.bonds else 0)
    n_angle_types = request.n_angle_types or (max(a[0] for a in request.angles) if request.angles else 0)
    n_dihedral_types = request.n_dihedral_types or (max(d[0] for d in request.dihedrals) if request.dihedrals else 0)
    n_improper_types = request.n_improper_types or (max(im[0] for im in request.impropers) if request.impropers else 0)

    lines = [f"# LAMMPS data file for {request.prefix}"]
    lines.append("")

    # ---- Header ----
    lines.append(f"{info['n_atoms']} atoms")
    if n_bonds:
        lines.append(f"{n_bonds} bonds")
    if n_angles:
        lines.append(f"{n_angles} angles")
    if n_dihedrals:
        lines.append(f"{n_dihedrals} dihedrals")
    if n_impropers:
        lines.append(f"{n_impropers} impropers")

    lines.append(f"{info['n_types']} atom types")
    if n_bond_types:
        lines.append(f"{n_bond_types} bond types")
    if n_angle_types:
        lines.append(f"{n_angle_types} angle types")
    if n_dihedral_types:
        lines.append(f"{n_dihedral_types} dihedral types")
    if n_improper_types:
        lines.append(f"{n_improper_types} improper types")
    lines.append("")

    # ---- Box bounds ----
    bounds = get_box_bounds(info["cell"])
    lines.append(f"{bounds['xlo']:.10f} {bounds['xhi']:.10f} xlo xhi")
    lines.append(f"{bounds['ylo']:.10f} {bounds['yhi']:.10f} ylo yhi")
    lines.append(f"{bounds['zlo']:.10f} {bounds['zhi']:.10f} zlo zhi")
    if bounds["is_triclinic"]:
        lines.append(f"{bounds['xy']:.10f} {bounds['xz']:.10f} {bounds['yz']:.10f} xy xz yz")
    lines.append("")

    # ---- Masses ----
    lines.append("Masses")
    lines.append("")
    for i, el in enumerate(info["unique_elements"], 1):
        mass = ATOMIC_MASSES.get(el, 1.0)
        lines.append(f"{i} {mass:.6f} # {el}")
    lines.append("")

    # ---- Atoms ----
    style = request.atom_style
    lines.append(f"Atoms # {style}")
    lines.append("")

    lammps_coords = transform_coords_to_lammps(info["cart_coords"], info["cell"])
    mol_ids = request.molecule_ids

    for i in range(info["n_atoms"]):
        atom_id = i + 1
        atom_type = info["atom_types"][i]
        x, y, z = lammps_coords[i]
        charge = info["charges"][i] if info["charges"] else 0.0
        mol_id = mol_ids[i] if mol_ids else 1

        if style == "full":
            lines.append(f"{atom_id} {mol_id} {atom_type} {charge:.6f} {x:.10f} {y:.10f} {z:.10f}")
        elif style == "molecular":
            lines.append(f"{atom_id} {mol_id} {atom_type} {x:.10f} {y:.10f} {z:.10f}")
        elif style == "charge":
            lines.append(f"{atom_id} {atom_type} {charge:.6f} {x:.10f} {y:.10f} {z:.10f}")
        else:
            lines.append(f"{atom_id} {atom_type} {x:.10f} {y:.10f} {z:.10f}")
    lines.append("")

    # ---- Bonds ----
    if request.bonds:
        lines.append("Bonds")
        lines.append("")
        for idx, bond in enumerate(request.bonds, 1):
            lines.append(f"{idx} {bond[0]} {bond[1]} {bond[2]}")
        lines.append("")

    # ---- Angles ----
    if request.angles:
        lines.append("Angles")
        lines.append("")
        for idx, angle in enumerate(request.angles, 1):
            lines.append(f"{idx} {angle[0]} {angle[1]} {angle[2]} {angle[3]}")
        lines.append("")

    # ---- Dihedrals ----
    if request.dihedrals:
        lines.append("Dihedrals")
        lines.append("")
        for idx, dih in enumerate(request.dihedrals, 1):
            lines.append(f"{idx} {dih[0]} {dih[1]} {dih[2]} {dih[3]} {dih[4]}")
        lines.append("")

    # ---- Impropers ----
    if request.impropers:
        lines.append("Impropers")
        lines.append("")
        for idx, imp in enumerate(request.impropers, 1):
            lines.append(f"{idx} {imp[0]} {imp[1]} {imp[2]} {imp[3]} {imp[4]}")
        lines.append("")

    return "\n".join(lines)


def generate_input_script(request: LammpsInputRequest, info: dict) -> str:
    """Generate LAMMPS input script."""
    lines = ["# LAMMPS input script"]
    lines.append(f"# Generated for {request.prefix}")
    lines.append("")

    # Initialization
    lines.append("# ============ Initialization ============")
    lines.append(f"units           {request.units}")
    lines.append(f"atom_style      {request.atom_style}")
    lines.append(f"boundary        {request.boundary}")
    lines.append("")

    # Read data or restart file
    lines.append("# ============ Read Structure ============")
    if request.read_restart:
        lines.append(f"read_restart    {request.restart_filename}")
        lines.append("# Note: When reading from restart, pair_style and pair_coeff must match the original run")
    elif request.custom_data_file:
        # Use user-provided data file directly (preserves bonds, angles, charges)
        data_basename = request.custom_data_file.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        lines.append(f"read_data       {data_basename}")
    else:
        lines.append(f"read_data       {request.prefix}.data")
    lines.append("")

    # ---- Pair interactions ----
    lines.append("# ============ Force Field ============")
    lines.append(f"pair_style      {request.pair_style}")

    if request.pair_coeff:
        pair_style_lower = request.pair_style.lower()
        n_coeff_lines = 0
        for pc_line in request.pair_coeff.strip().splitlines():
            pc_line = pc_line.strip()
            if pc_line:
                if pc_line.lower().startswith("pair_coeff"):
                    lines.append(pc_line)
                else:
                    lines.append(f"pair_coeff      {pc_line}")
                n_coeff_lines += 1

        n_types = info["n_types"]
        n_required_pairs = n_types * (n_types + 1) // 2
        if n_coeff_lines < n_required_pairs and any(
            kw in pair_style_lower for kw in ("lj", "morse", "buck")
        ):
            lines.append("pair_modify     mix arithmetic")
    else:
        elements_str = " ".join(info["unique_elements"])
        if "eam" in request.pair_style.lower():
            lines.append(f"pair_coeff      * * <POTENTIAL_FILE> {elements_str}")
        elif "lj" in request.pair_style.lower():
            lines.append("# Set pair_coeff for each pair type:")
            for i in range(1, info["n_types"] + 1):
                for j in range(i, info["n_types"] + 1):
                    lines.append(f"# pair_coeff      {i} {j} <epsilon> <sigma>")
        elif "reax" in request.pair_style.lower():
            lines.append(f"pair_coeff      * * <REAX_POTENTIAL> {elements_str}")
        else:
            lines.append("pair_coeff      * * <PARAMETERS>")
    lines.append("")

    # ---- Bonded interactions ----
    # Skip if style is "none", None, or empty string
    if request.bond_style and request.bond_style.lower() != "none":
        lines.append(f"bond_style      {request.bond_style}")
        if request.bond_coeff:
            for bc_line in request.bond_coeff.strip().splitlines():
                bc_line = bc_line.strip()
                if bc_line:
                    if bc_line.lower().startswith("bond_coeff"):
                        lines.append(bc_line)
                    else:
                        lines.append(f"bond_coeff      {bc_line}")
        lines.append("")

    if request.angle_style and request.angle_style.lower() != "none":
        lines.append(f"angle_style     {request.angle_style}")
        if request.angle_coeff:
            for ac_line in request.angle_coeff.strip().splitlines():
                ac_line = ac_line.strip()
                if ac_line:
                    if ac_line.lower().startswith("angle_coeff"):
                        lines.append(ac_line)
                    else:
                        lines.append(f"angle_coeff     {ac_line}")
        lines.append("")

    if request.dihedral_style and request.dihedral_style.lower() != "none":
        lines.append(f"dihedral_style  {request.dihedral_style}")
        if request.dihedral_coeff:
            for dc_line in request.dihedral_coeff.strip().splitlines():
                dc_line = dc_line.strip()
                if dc_line:
                    if dc_line.lower().startswith("dihedral_coeff"):
                        lines.append(dc_line)
                    else:
                        lines.append(f"dihedral_coeff  {dc_line}")
        lines.append("")

    if request.improper_style and request.improper_style.lower() != "none":
        lines.append(f"improper_style  {request.improper_style}")
        if request.improper_coeff:
            for ic_line in request.improper_coeff.strip().splitlines():
                ic_line = ic_line.strip()
                if ic_line:
                    if ic_line.lower().startswith("improper_coeff"):
                        lines.append(ic_line)
                    else:
                        lines.append(f"improper_coeff  {ic_line}")
        lines.append("")

    # ---- Long-range electrostatics ----
    if request.kspace_style:
        lines.append(f"kspace_style    {request.kspace_style}")
        lines.append("")

    # ---- Special bonds (1-2, 1-3, 1-4 exclusions) ----
    if request.special_bonds:
        lines.append(f"special_bonds   {request.special_bonds}")
        lines.append("")

    # ---- Extra commands (user-defined, appended after force field) ----
    if request.extra_commands:
        for cmd_line in request.extra_commands.strip().splitlines():
            cmd_line = cmd_line.strip()
            if cmd_line:
                lines.append(cmd_line)
        lines.append("")

    # ---- Neighbor settings ----
    lines.append("neighbor        2.0 bin")
    lines.append("neigh_modify    every 1 delay 0 check yes")
    lines.append("")

    # Handle fixed atoms
    fixed_set = set()
    if request.fixed_indices:
        fixed_set.update(request.fixed_indices)

    if request.fixed_z_below is not None:
        lammps_coords = transform_coords_to_lammps(info["cart_coords"], info["cell"])
        for i, coord in enumerate(lammps_coords):
            if coord[2] < request.fixed_z_below:
                fixed_set.add(i)

    if fixed_set:
        # Create group for fixed atoms (LAMMPS uses 1-indexed atom IDs)
        fixed_ids = sorted([i + 1 for i in fixed_set])

        # Write fixed atoms in chunks to avoid line length limits
        # LAMMPS allows multiple group commands with same name (adds to group)
        chunk_size = 20
        lines.append(f"# Fixed atoms: {len(fixed_ids)} atoms")
        for i in range(0, len(fixed_ids), chunk_size):
            chunk = fixed_ids[i:i + chunk_size]
            ids_str = " ".join(map(str, chunk))
            lines.append(f"group           fixed id {ids_str}")

        lines.append("group           mobile subtract all fixed")
        lines.append("")

    # Thermo output
    lines.append("# ============ Output Settings ============")
    lines.append(f"thermo          {request.thermo_freq}")
    lines.append("thermo_style    custom step temp pe ke etotal press vol")
    lines.append("")

    # Simulation type specific settings
    lines.append("# ============ Simulation ============")

    if request.simulation_type == "minimize":
        lines.append(f"min_style       {request.min_style}")
        if fixed_set:
            lines.append("fix             freeze fixed setforce 0.0 0.0 0.0")
        lines.append(f"minimize        {request.etol} {request.ftol} {request.maxiter} {request.maxeval}")

    elif request.simulation_type == "nve":
        lines.append(f"timestep        {request.timestep}")
        lines.append(f"dump            1 all {request.dump_format} {request.dump_freq} {request.prefix}.dump id type x y z")
        if fixed_set:
            lines.append("fix             freeze fixed setforce 0.0 0.0 0.0")
            lines.append("fix             1 mobile nve")
        else:
            lines.append("fix             1 all nve")
        lines.append(f"run             {request.run_steps}")

    elif request.simulation_type == "nvt":
        lines.append(f"timestep        {request.timestep}")
        lines.append(f"velocity        all create {request.temperature} 12345 dist gaussian")
        lines.append(f"dump            1 all {request.dump_format} {request.dump_freq} {request.prefix}.dump id type x y z")
        if fixed_set:
            lines.append("fix             freeze fixed setforce 0.0 0.0 0.0")
            lines.append(f"fix             1 mobile nvt temp {request.temperature} {request.temperature} {request.tdamp}")
        else:
            lines.append(f"fix             1 all nvt temp {request.temperature} {request.temperature} {request.tdamp}")
        lines.append(f"run             {request.run_steps}")

    elif request.simulation_type == "npt":
        lines.append(f"timestep        {request.timestep}")
        lines.append(f"velocity        all create {request.temperature} 12345 dist gaussian")
        lines.append(f"dump            1 all {request.dump_format} {request.dump_freq} {request.prefix}.dump id type x y z")
        if fixed_set:
            lines.append("fix             freeze fixed setforce 0.0 0.0 0.0")
            lines.append(f"fix             1 mobile npt temp {request.temperature} {request.temperature} {request.tdamp} iso {request.pressure} {request.pressure} {request.pdamp}")
        else:
            lines.append(f"fix             1 all npt temp {request.temperature} {request.temperature} {request.tdamp} iso {request.pressure} {request.pressure} {request.pdamp}")
        lines.append(f"run             {request.run_steps}")

    lines.append("")
    lines.append("# ============ Finalize ============")
    lines.append(f"write_data      {request.prefix}_final.data")
    if request.write_restart:
        lines.append(f"write_restart   {request.prefix}.restart")
    lines.append("")

    return "\n".join(lines)


# ============================================================================
# Validation Functions
# ============================================================================

def validate_pair_coeff(pair_style: str, pair_coeff: Optional[str], n_types: int) -> ValidationResult:
    """Validate pair_coeff matches pair_style requirements.

    Supports multi-line pair_coeff (one line per pair for LJ/Buck etc.).
    """
    result = ValidationResult()

    if not pair_coeff:
        result.warnings.append("pair_coeff is empty - placeholder will be generated")
        return result

    coeff_lines = [ln.strip() for ln in pair_coeff.strip().splitlines() if ln.strip()]
    if not coeff_lines:
        result.warnings.append("pair_coeff is empty - placeholder will be generated")
        return result

    pair_style_lower = pair_style.lower()

    for i, line in enumerate(coeff_lines):
        raw = line.lower().removeprefix("pair_coeff").strip() if line.lower().startswith("pair_coeff") else line
        parts = raw.split()

        if "eam" in pair_style_lower:
            if len(parts) < 3:
                result.errors.append(
                    f"EAM pair_coeff requires at least 3 arguments: * * <potential_file> <element(s)>. "
                    f"Got: '{line}'"
                )
            else:
                if parts[0] != "*" or parts[1] != "*":
                    result.warnings.append(
                        f"EAM pair_coeff typically starts with '* *', got: '{parts[0]} {parts[1]}'"
                    )
                expected_elements = len(parts) - 2
                if expected_elements != n_types:
                    result.warnings.append(
                        f"EAM pair_coeff specifies {expected_elements} elements but system has {n_types} atom types"
                    )

        elif "lj" in pair_style_lower:
            if len(parts) < 4:
                result.errors.append(
                    f"LJ pair_coeff line {i+1} requires at least 4 arguments: type1 type2 epsilon sigma. "
                    f"Got: '{line}'"
                )
            else:
                try:
                    int(parts[0])
                    int(parts[1])
                    float(parts[2])
                    float(parts[3])
                except ValueError as e:
                    result.errors.append(
                        f"LJ pair_coeff line {i+1} has invalid format: {e}. Line: '{line}'"
                    )

        elif "reax" in pair_style_lower:
            if len(parts) < 3:
                result.errors.append(f"ReaxFF pair_coeff requires at least 3 arguments. Got: '{line}'")

        elif "tersoff" in pair_style_lower:
            if len(parts) < 3:
                result.errors.append(f"Tersoff pair_coeff requires at least 3 arguments. Got: '{line}'")

        elif pair_style_lower == "sw":
            if len(parts) < 3:
                result.errors.append(f"SW pair_coeff requires at least 3 arguments. Got: '{line}'")

        elif "buck" in pair_style_lower:
            if len(parts) < 5:
                result.errors.append(
                    f"Buckingham pair_coeff line {i+1} requires at least 5 arguments. Got: '{line}'"
                )

        elif "comb" in pair_style_lower:
            if len(parts) < 3:
                result.errors.append(f"COMB pair_coeff requires at least 3 arguments. Got: '{line}'")

    return result


def validate_units_and_params(request: LammpsInputRequest) -> ValidationResult:
    """Validate unit consistency and simulation parameters."""
    result = ValidationResult()

    # Timestep validation vs units
    if request.units == "metal":
        if request.timestep > 0.01:
            result.warnings.append(
                f"timestep ({request.timestep} ps) may be unstable for metal units. "
                f"Typical values: 0.0001 - 0.001 ps"
            )
    elif request.units == "real":
        if request.timestep > 1.0:
            result.warnings.append(
                f"timestep ({request.timestep} fs) may be unstable for real units. "
                f"Typical values: 0.1 - 1.0 fs"
            )
    elif request.units == "lj":
        pass

    if "lj" in request.pair_style.lower() and request.units != "lj":
        result.warnings.append(
            f"LJ potential typically uses 'lj' units, but '{request.units}' is selected"
        )

    if request.simulation_type in ["nvt", "npt"]:
        if request.tdamp <= 0:
            result.errors.append("tdamp (temperature damping) must be positive")
        if request.pdamp <= 0:
            result.errors.append("pdamp (pressure damping) must be positive")

    if request.temperature < 0:
        result.errors.append("temperature cannot be negative")
    elif request.temperature > 100000:
        result.warnings.append(
            f"temperature ({request.temperature} K) is extremely high"
        )

    if request.run_steps < 100:
        result.warnings.append(
            f"run_steps ({request.run_steps}) is very short, may not reach equilibrium"
        )

    return result


# ============================================================================
# Polymer Building Functions
# ============================================================================

def generate_polymer_chain(
    polymer_type: str,
    chain_length: int,
    tacticity: str = "atactic",
    bond_length: float = 1.54,
    seed: int = 42
) -> dict:
    """Generate a polymer chain using rotational isomeric state model."""
    np.random.seed(seed)

    monomer = POLYMER_MONOMERS.get(polymer_type.upper(), POLYMER_MONOMERS["PE"])

    elements = []
    coords = []
    bonds = []

    current_pos = np.array([0.0, 0.0, 0.0])
    current_dir = np.array([1.0, 0.0, 0.0])

    for i in range(chain_length):
        elements.append("C")
        coords.append(current_pos.copy())

        if i > 0:
            bonds.append((i, i - 1))

        if i < chain_length - 1:
            if tacticity == "isotactic":
                probs = [0.6, 0.2, 0.2]
            elif tacticity == "syndiotactic":
                probs = [0.5, 0.25, 0.25]
            else:
                probs = [0.55, 0.225, 0.225]

            rotation = np.random.choice([0, 1, 2], p=probs)
            angle = np.pi * (1 + rotation * 2 / 3)

            perp = np.cross(current_dir, np.array([0, 0, 1]))
            if np.linalg.norm(perp) < 0.1:
                perp = np.cross(current_dir, np.array([0, 1, 0]))
            perp = perp / np.linalg.norm(perp)

            cos_a = np.cos(angle)
            sin_a = np.sin(angle)
            current_dir = (current_dir * cos_a +
                          np.cross(perp, current_dir) * sin_a +
                          perp * np.dot(perp, current_dir) * (1 - cos_a))
            current_dir = current_dir / np.linalg.norm(current_dir)

            current_pos = current_pos + current_dir * bond_length

    n_carbons = len(coords)
    for i in range(n_carbons):
        for h in range(2):
            perp = np.random.randn(3)
            perp[2] = 0
            perp = perp / np.linalg.norm(perp)
            h_pos = np.array(coords[i]) + perp * 1.09
            elements.append("H")
            coords.append(h_pos)
            bonds.append((n_carbons + i * 2 + h, i))

    return {
        "elements": elements,
        "coords": np.array(coords),
        "bonds": bonds,
        "n_atoms": len(elements),
    }


def pack_polymers_in_box(
    chain_data: dict,
    n_chains: int,
    box_size: tuple[float, float, float],
    density: float
) -> dict:
    """Pack multiple polymer chains in a simulation box."""
    all_elements = []
    all_coords = []
    all_bonds = []

    atoms_per_chain = chain_data["n_atoms"]

    for chain_idx in range(n_chains):
        offset = np.array([
            np.random.uniform(0, box_size[0] * 0.8),
            np.random.uniform(0, box_size[1] * 0.8),
            np.random.uniform(0, box_size[2] * 0.8),
        ])

        chain_coords = chain_data["coords"] + offset
        chain_elements = chain_data["elements"]

        atom_offset = chain_idx * atoms_per_chain
        chain_bonds = [(i + atom_offset, j + atom_offset)
                       for i, j in chain_data["bonds"]]

        all_elements.extend(chain_elements)
        all_coords.append(chain_coords)
        all_bonds.extend(chain_bonds)

    return {
        "elements": all_elements,
        "coords": np.vstack(all_coords),
        "bonds": all_bonds,
        "box_size": box_size,
        "n_atoms": len(all_elements),
    }


def generate_polymer_data_file(packed_data: dict, request: PolymerBuildRequest) -> str:
    """Generate LAMMPS data file for polymer."""
    lines = ["# LAMMPS data file for polymer"]
    lines.append("")
    lines.append(f"{packed_data['n_atoms']} atoms")
    lines.append(f"{len(set(packed_data['elements']))} atom types")
    lines.append("")

    box = packed_data["box_size"]
    lines.append(f"0.0 {box[0]:.2f} xlo xhi")
    lines.append(f"0.0 {box[1]:.2f} ylo yhi")
    lines.append(f"0.0 {box[2]:.2f} zlo zhi")
    lines.append("")

    # Masses
    lines.append("Masses")
    lines.append("")
    unique_elements = list(set(packed_data["elements"]))
    for i, el in enumerate(unique_elements, 1):
        mass = ATOMIC_MASSES.get(el, 12.0)
        lines.append(f"{i} {mass:.6f} # {el}")
    lines.append("")

    # Atoms
    lines.append("Atoms # atomic")
    lines.append("")

    element_to_type = {el: i+1 for i, el in enumerate(unique_elements)}

    for i, (el, coord) in enumerate(zip(packed_data["elements"], packed_data["coords"])):
        atom_type = element_to_type[el]
        lines.append(f"{i+1} {atom_type} {coord[0]:.6f} {coord[1]:.6f} {coord[2]:.6f}")

    return "\n".join(lines)


def generate_polymer_input_script(request: PolymerBuildRequest, box_size: tuple) -> str:
    """Generate LAMMPS input script for polymer simulation."""
    ff = POLYMER_FORCE_FIELDS.get(request.force_field.lower(), POLYMER_FORCE_FIELDS["opls"])

    lines = [
        "# LAMMPS input script for polymer simulation",
        f"# Polymer: {request.polymer_type}",
        f"# Force field: {ff['name']}",
        "",
        "# ============ Initialization ============",
        "units           real",
        "atom_style      atomic",
        "boundary        p p p",
        "",
        "# ============ Read Structure ============",
        "read_data       polymer.data",
        "",
        "# ============ Force Field ============",
        f"pair_style      {ff.get('pair_style', 'lj/cut 12.0')}",
        "pair_coeff      * * 0.15 3.5",
        "",
        "bond_style      harmonic",
        "bond_coeff      1 350.0 1.54",
        "",
        "angle_style     harmonic",
        "angle_coeff     1 60.0 109.5",
        "",
        "neighbor        2.0 bin",
        "neigh_modify    every 1 delay 0 check yes",
        "",
        "# ============ Minimization ============",
        "min_style       cg",
        "minimize        1e-6 1e-8 1000 10000",
        "",
        "# ============ NVT Equilibration ============",
        "timestep        1.0",
        f"velocity        all create 300.0 {request.seed} dist gaussian",
        "fix             1 all nvt temp 300.0 300.0 100.0",
        "thermo          100",
        "thermo_style    custom step temp pe ke etotal press vol density",
        "dump            1 all custom 100 polymer.dump id type x y z",
        "run             10000",
        "",
        "# ============ Write Output ============",
        "write_data      polymer_final.data",
        "",
    ]

    return "\n".join(lines)


# ============================================================================
# Sequential / Polymer Workflow Helper Functions
# ============================================================================

def generate_data_file_content(structure: PymatgenStructure, info: dict,
                             atom_style: str, boundary: str, prefix: str) -> str:
    """Generate LAMMPS data file content."""
    temp_request = LammpsInputRequest(
        structure=structure,
        prefix=prefix,
        atom_style=atom_style,
        boundary=boundary,
        pair_style="",
        pair_coeff=""
    )
    return generate_data_file(temp_request, info)


def generate_data_file_read_section(prefix: str) -> str:
    """Generate read_data section."""
    return f"""# ============ Read Structure ============
read_data       {prefix}.data

"""


def generate_force_field_section(request: SequentialLammpsRequest) -> str:
    """Generate force field section (shared by all stages)."""
    return f"""# ============ Force Field ============
pair_style      {request.pair_style}
pair_coeff      {request.pair_coeff}

neighbor        2.0 bin
neigh_modify    every 1 delay 0 check yes

"""


def generate_stage_script(stage: "SimulationStage", stage_num: int,
                         request: SequentialLammpsRequest, info: dict) -> list[str]:
    """Generate input script for a single stage."""
    lines = []
    lines.append(f"# ============ Stage {stage_num + 1}: {stage.stage_type.upper()} ============")

    # Thermo output
    lines.append(f"thermo          {request.thermo_interval}")
    lines.append("thermo_style    custom step temp pe ke etotal press vol")
    lines.append("")

    # Get default values from stage
    temp = stage.temperature or 300.0
    press = stage.pressure or 1.0
    tdamp = stage.tdamp or 100.0
    pdamp = stage.pdamp or 1000.0
    steps = stage.run_steps

    if stage.stage_type == "minimize":
        lines.append("# Energy minimization")
        lines.append("min_style       cg")
        lines.append(f"minimize        1e-6 1e-8 100 1000")

    elif stage.stage_type == "nve":
        lines.append("# NVE dynamics")
        lines.append("timestep        0.001")
        lines.append(f"dump            {stage_num + 1} all custom {request.dump_interval} stage{stage_num + 1}.dump id type x y z")
        lines.append(f"fix             {stage_num + 1} all nve")
        lines.append(f"run             {steps}")

    elif stage.stage_type == "nvt":
        lines.append("# NVT dynamics")
        lines.append("timestep        0.001")
        lines.append(f"velocity        all create {temp} 12345 dist gaussian")
        lines.append(f"dump            {stage_num + 1} all custom {request.dump_interval} stage{stage_num + 1}.dump id type x y z")
        lines.append(f"fix             {stage_num + 1} all nvt temp {temp} {temp} {tdamp}")
        lines.append(f"run             {steps}")

    elif stage.stage_type == "npt":
        lines.append("# NPT dynamics")
        lines.append("timestep        0.001")
        lines.append(f"velocity        all create {temp} 12345 dist gaussian")
        lines.append(f"dump            {stage_num + 1} all custom {request.dump_interval} stage{stage_num + 1}.dump id type x y z")
        lines.append(f"fix             {stage_num + 1} all npt temp {temp} {temp} {tdamp} iso {press} {press} {pdamp}")
        lines.append(f"run             {steps}")

    elif stage.stage_type == "temp":
        t_start = stage.temp_start or temp
        t_end = stage.temp_end or temp
        lines.append("# Temperature ramp")
        lines.append("timestep        0.001")
        lines.append(f"velocity        all create {t_start} 12345 dist gaussian")
        lines.append(f"dump            {stage_num + 1} all custom {request.dump_interval} stage{stage_num + 1}.dump id type x y z")
        lines.append(f"fix             {stage_num + 1} all nvt temp {t_start} {t_end} {tdamp}")
        lines.append(f"run             {steps}")

    elif stage.stage_type == "deform":
        lines.append("# Box deformation")
        lines.append("timestep        0.001")
        lines.append(f"dump            {stage_num + 1} all custom {request.dump_interval} stage{stage_num + 1}.dump id type x y z")
        lines.append(f"fix             {stage_num + 1} all npt temp {temp} {temp} {tdamp} iso {press} {press} {pdamp}")
        if stage.deform_rate:
            lines.append(f"deform         {stage_num + 1} all erate {stage.deform_rate[0]} {stage.deform_rate[1]} {stage.deform_rate[2]} units box")
        lines.append(f"run             {steps}")

    elif stage.stage_type == "press":
        lines.append("# Apply pressure")
        lines.append("timestep        0.001")
        target_p = stage.target_pressure or press
        lines.append(f"dump            {stage_num + 1} all custom {request.dump_interval} stage{stage_num + 1}.dump id type x y z")
        lines.append(f"fix             {stage_num + 1} all npt temp {temp} {temp} {tdamp} iso {target_p} {target_p} {pdamp}")
        lines.append(f"run             {steps}")

    elif stage.stage_type == "vac":
        lines.append("# Create vacancy")
        if stage.vacancy_index is not None and stage.vacancy_index >= 0:
            lines.append(f"group           vacancy atom {stage.vacancy_index + 1}")
            lines.append("delete_atoms    group vacancy")
        else:
            lines.append("# Random vacancy - user needs to specify atom index")
        lines.append(f"run             0")

    lines.append("")
    return lines


def generate_polymer_workflow_data_file(request: PolymerWorkflowRequest, info: dict) -> str:
    """Generate LAMMPS data file for polymer workflow."""
    lines = [
        f"# LAMMPS data file for {request.prefix}",
        f"# Workflow: {request.workflow_mode}",
        "",
        f"{info['n_atoms']} atoms",
        f"{info['n_types']} atom types",
        "",
    ]

    bounds = get_box_bounds(info["cell"])
    lines.extend([
        f"{bounds['xlo']:.6f} {bounds['xhi']:.6f} xlo xhi",
        f"{bounds['ylo']:.6f} {bounds['yhi']:.6f} ylo yhi",
        f"{bounds['zlo']:.6f} {bounds['zhi']:.6f} zlo zhi",
        "",
    ])

    lines.append("Masses")
    lines.append("")
    for i, el in enumerate(info["unique_elements"], 1):
        mass = ATOMIC_MASSES.get(el, 1.0)
        lines.append(f"{i} {mass:.6f} # {el}")
    lines.append("")

    if request.atom_style == "molecular":
        lines.append("Atoms # molecular")
    else:
        lines.append("Atoms # atomic")
    lines.append("")

    lammps_coords = transform_coords_to_lammps(info["cart_coords"], info["cell"])

    for i in range(info["n_atoms"]):
        atom_id = i + 1
        atom_type = info["atom_types"][i]
        x, y, z = lammps_coords[i]
        lines.append(f"{atom_id} {atom_type} {x:.10f} {y:.10f} {z:.10f}")

    lines.append("")
    return "\n".join(lines)


def generate_polymer_workflow_script(request: PolymerWorkflowRequest, info: dict) -> tuple[str, list[dict]]:
    """Generate multi-stage polymer workflow input script.

    Returns:
        (input_script_content, list_of_stages)
    """
    stages = []
    lines = [
        f"# Multi-Stage Polymer MD Workflow",
        f"# Mode: {request.workflow_mode}",
        f"# System: {info['n_atoms']} atoms",
        "",
        "# ============ Initialization ============",
        f"units           {request.units}",
        f"atom_style      {request.atom_style}",
        "boundary        p p p",
        "",
        "# ============ Read Structure ============",
        f"read_data       {request.prefix}.data",
        "",
        "# ============ Force Field ============",
        f"pair_style      {request.pair_style}",
    ]
    n_coeff_lines = 0
    for pc_line in request.pair_coeff.strip().splitlines():
        pc_line = pc_line.strip()
        if pc_line:
            if pc_line.lower().startswith("pair_coeff"):
                lines.append(pc_line)
            else:
                lines.append(f"pair_coeff      {pc_line}")
            n_coeff_lines += 1

    n_types = info["n_types"]
    n_required_pairs = n_types * (n_types + 1) // 2
    pair_style_lower = request.pair_style.lower()
    if n_coeff_lines < n_required_pairs and any(
        kw in pair_style_lower for kw in ("lj", "morse", "buck")
    ):
        lines.append("pair_modify     mix arithmetic")
    lines.append("")

    if request.bond_style and request.bond_style != "none":
        lines.extend([
            f"bond_style      {request.bond_style}",
        ])
        if request.bond_coeff:
            for bc_line in request.bond_coeff.strip().splitlines():
                bc_line = bc_line.strip()
                if bc_line:
                    if bc_line.lower().startswith("bond_coeff"):
                        lines.append(bc_line)
                    else:
                        lines.append(f"bond_coeff      {bc_line}")
        lines.append("")

    lines.extend([
        "neighbor        0.3 bin",
        "neigh_modify    every 1 delay 0 check yes",
        "",
        "# ============ Output Settings ============",
        "thermo          1000",
        "thermo_style    custom step temp pe ke etotal press vol density",
        "",
    ])

    if request.workflow_mode == "polymer_kg":
        stages.extend([
            {"name": "Generation NVT", "ensemble": "nvt", "steps": request.gen_steps_nvt},
            {"name": "Generation NPT", "ensemble": "npt", "steps": request.gen_steps_npt},
            {"name": "Equilibration NPT", "ensemble": "npt", "steps": request.equil_steps},
            {"name": "Production NVT", "ensemble": "nvt", "steps": request.prod_steps},
        ])

        lines.extend([
            "# ============ Stage 1: Generation (NVT) ============",
            f"timestep        {request.timestep}",
            f"velocity        all create {request.temperature} 12345 dist gaussian",
            "fix             1 all nvt temp {0} {0} 0.1".format(request.temperature),
            "run             {}".format(request.gen_steps_nvt),
            "",
        ])

        lines.extend([
            "# ============ Stage 2: Generation (NPT) ============",
            "unfix           1",
            "fix             1 all npt temp {0} {0} 0.1 iso {1} {1} 1.0".format(
                request.temperature, request.pressure
            ),
            "run             {}".format(request.gen_steps_npt),
            "",
        ])

        lines.extend([
            "# ============ Stage 3: Equilibration (NPT) ============",
            "unfix           1",
            "fix             1 all npt temp {0} {0} 0.1 iso {1} {1} 1.0".format(
                request.temperature, request.pressure
            ),
            "run             {}".format(request.equil_steps),
            "",
        ])

        lines.extend([
            "# ============ Stage 4: Production (NVT) ============",
            "unfix           1",
            "fix             1 all nvt temp {0} {0} 0.1".format(request.temperature),
            f"dump            2 all custom {request.prod_dump_freq} {request.prefix}.dump id type x y z",
            "run             {}".format(request.prod_steps),
            "",
        ])

    elif request.workflow_mode == "glass_transition":
        temp_min = request.temperature * 0.5
        temp_max = request.temperature * 2.0
        temp_step = (temp_max - temp_min) / 5

        current_temp = temp_max
        stage_num = 1
        while current_temp > temp_min:
            stages.append({
                "name": f"Cooling to {current_temp:.0f}K",
                "ensemble": "npt",
                "steps": request.equil_steps // 5
            })
            current_temp -= temp_step

        current_temp = temp_max
        while current_temp > temp_min:
            lines.extend([
                f"# ============ Cooling to {current_temp:.0f} ============",
                f"fix             1 all npt temp {current_temp} {current_temp - temp_step} 0.1 iso 0 0 1.0",
                f"run             {request.equil_steps // 5}",
                "",
            ])
            current_temp -= temp_step

    else:
        stages.append({
            "name": "Production",
            "ensemble": "nvt",
            "steps": request.prod_steps
        })

        lines.extend([
            "# ============ Production Run ============",
            f"timestep        {request.timestep}",
            f"velocity        all create {request.temperature} 12345 dist gaussian",
            f"fix             1 all nvt temp {request.temperature} {request.temperature} 0.1",
            f"dump            1 all custom {request.prod_dump_freq} {request.prefix}.dump id type x y z",
            f"run             {request.prod_steps}",
            "",
        ])

    lines.extend([
        "# ============ Finalize ============",
        f"write_data      {request.prefix}_final.data",
        "",
    ])

    return "\n".join(lines), stages


# ============================================================================
# API Endpoints
# ============================================================================

@router.post("/input", response_model=LammpsInputResponse)
def generate_input_files(request: LammpsInputRequest) -> LammpsInputResponse:
    """Generate LAMMPS input script and data file from structure.

    When ``custom_data_file`` points to an existing LAMMPS data file the
    file is used as-is — no structure conversion or data-file generation
    is performed.  Only the input script is generated.
    """
    try:
        # --- Custom LAMMPS data file: skip generation, parse info from file ---
        if request.custom_data_file and os.path.isfile(request.custom_data_file):
            data_content = open(request.custom_data_file).read()
            info = parse_lammps_data_info(data_content)

            pair_coeff_validation = validate_pair_coeff(
                request.pair_style, request.pair_coeff, info["n_types"])
            params_validation = validate_units_and_params(request)
            all_warnings = pair_coeff_validation.warnings + params_validation.warnings
            all_errors = pair_coeff_validation.errors + params_validation.errors

            input_script = generate_input_script(request, info)

            return LammpsInputResponse(
                success=len(all_errors) == 0,
                input_script=input_script,
                data_file=data_content,
                elements=info["unique_elements"],
                n_atoms=info["n_atoms"],
                n_types=info["n_types"],
                message=f"Using LAMMPS data file {os.path.basename(request.custom_data_file)} "
                        f"({info['n_atoms']} atoms, {info['n_types']} types)",
                warnings=all_warnings,
                errors=all_errors,
            )

        # --- Standard path: generate data file from structure ---
        info = extract_structure_info(request.structure)

        pair_coeff_validation = validate_pair_coeff(
            request.pair_style, request.pair_coeff, info["n_types"])
        params_validation = validate_units_and_params(request)
        all_warnings = pair_coeff_validation.warnings + params_validation.warnings
        all_errors = pair_coeff_validation.errors + params_validation.errors

        input_script = generate_input_script(request, info)
        data_file = generate_data_file(request, info)

        message = f"Generated LAMMPS {request.simulation_type} input for {info['n_atoms']} atoms"
        if all_warnings:
            message += f" ({len(all_warnings)} warning{'s' if len(all_warnings) > 1 else ''})"

        return LammpsInputResponse(
            success=len(all_errors) == 0,
            input_script=input_script,
            data_file=data_file,
            elements=info["unique_elements"],
            n_atoms=info["n_atoms"],
            n_types=info["n_types"],
            message=message,
            warnings=all_warnings,
            errors=all_errors,
        )

    except ValueError as e:
        error_msg = str(e)
        error_response = LammpsErrorResponse(
            error="validation_error",
            message=error_msg,
            suggestion="Please check your input parameters are valid"
        )

        if "oxidation_state" in error_msg:
            error_response.error = "charge_style_error"
            error_response.message = "Failed to extract oxidation state from structure"
            error_response.suggestion = "Ensure structure species have oxidation_state property or use atom_style='atomic'"

        elif "lattice" in error_msg.lower():
            error_response.error = "structure_error"
            error_response.message = "Invalid or missing lattice in structure"
            error_response.suggestion = "Structure must have a lattice defined for LAMMPS input"

        raise HTTPException(status_code=400, detail=error_response.model_dump())

    except Exception as e:
        error_response = LammpsErrorResponse(
            error="internal_error",
            message=f"Unexpected error: {str(e)}",
            suggestion="Please report this issue with the full error message"
        )
        raise HTTPException(status_code=500, detail=error_response.model_dump())


@router.get("/pair_styles")
def list_pair_styles() -> dict:
    """List common LAMMPS pair styles with descriptions."""
    return {
        "pair_styles": {
            "eam": {"description": "Embedded Atom Method for metals", "variants": ["eam", "eam/alloy", "eam/fs"], "typical_materials": ["Cu", "Al", "Ni", "Fe", "Au", "Ag"]},
            "lj/cut": {"description": "Lennard-Jones potential with cutoff", "variants": ["lj/cut", "lj/smooth", "lj/expand"], "typical_materials": ["Noble gases", "Generic particles"]},
            "reaxff": {"description": "ReaxFF reactive force field", "variants": ["reaxff"], "typical_materials": ["Hydrocarbons", "Oxides", "Interfaces"]},
            "tersoff": {"description": "Tersoff potential for covalent materials", "variants": ["tersoff", "tersoff/zbl"], "typical_materials": ["Si", "C", "Ge", "SiC"]},
            "sw": {"description": "Stillinger-Weber potential", "variants": ["sw"], "typical_materials": ["Si", "Ge"]},
            "buck": {"description": "Buckingham potential for ionic materials", "variants": ["buck", "buck/coul/long"], "typical_materials": ["MgO", "Al2O3", "Oxides"]},
            "comb": {"description": "Charge-optimized many-body potential", "variants": ["comb", "comb3"], "typical_materials": ["Metal oxides", "Semiconductors"]},
        }
    }


@router.get("/units")
def list_units() -> dict:
    """List LAMMPS unit systems."""
    return {
        "units": {
            "metal": {"description": "Common for metals and materials science", "mass": "g/mol", "distance": "Angstroms", "time": "picoseconds", "energy": "eV", "force": "eV/Angstrom", "temperature": "K", "pressure": "bar"},
            "real": {"description": "Common for molecular systems", "mass": "g/mol", "distance": "Angstroms", "time": "femtoseconds", "energy": "kcal/mol", "force": "kcal/mol-Angstrom", "temperature": "K", "pressure": "atm"},
            "lj": {"description": "Lennard-Jones reduced units", "mass": "1", "distance": "sigma", "time": "tau", "energy": "epsilon", "force": "epsilon/sigma", "temperature": "epsilon/kB", "pressure": "epsilon/sigma^3"},
            "si": {"description": "SI units", "mass": "kg", "distance": "meters", "time": "seconds", "energy": "Joules", "force": "Newtons", "temperature": "K", "pressure": "Pascal"},
        }
    }


@router.get("/potential_templates")
def list_potential_templates() -> dict:
    """List common potential file templates with pair_coeff suggestions."""
    return {
        "templates": {
            "Cu_eam": {"name": "Copper EAM/alloy", "description": "FCC Copper with Mishin EAM potential", "pair_style": "eam/alloy", "pair_coeff": "* * Cu_u3.eam Cu", "reference": "Mishin Y, Farkas D, Papaconstantopoulos D J. Phys.: Condens. Matter 1999", "typical_use": "Bulk Cu, Cu alloys, Cu nanoparticles"},
            "Ni3Al_eam": {"name": "Ni3Al EAM/alloy", "description": "Ni3Al intermetallic with EAM", "pair_style": "eam/alloy", "pair_coeff": "* * NiAlH.eam.alloy Ni Al", "reference": "Mishin R. et al. Acta Materialia 1999", "typical_use": "Ni-Al alloys, intermetallics"},
            "Ni_eam": {"name": "Nickel EAM", "description": "FCC Nickel with EAM potential", "pair_style": "eam/alloy", "pair_coeff": "* * Ni_u3.eam Ni", "reference": "Foiles and Adams 1989", "typical_use": "Bulk Ni, Ni alloys"},
            "Au_eam": {"name": "Gold EAM", "description": "FCC Gold with EAM potential", "pair_style": "eam/alloy", "pair_coeff": "* * Au_u3.eam Au", "reference": "Foiles and Adams 1989", "typical_use": "Bulk Au, Au nanoparticles"},
            "Si_tersoff": {"name": "Silicon Tersoff", "description": "Diamond cubic Silicon with Tersoff potential", "pair_style": "tersoff", "pair_coeff": "* * Si.tersoff Si", "reference": "Tersoff J. Phys. Rev. B 1988", "typical_use": "Bulk Si, Si surfaces, amorphous Si"},
            "Ge_tersoff": {"name": "Germanium Tersoff", "description": "Diamond cubic Germanium with Tersoff potential", "pair_style": "tersoff", "pair_coeff": "* * Ge.tersoff Ge", "reference": "Tersoff Phys. Rev. B 1989", "typical_use": "Bulk Ge, Ge surfaces"},
            "C_tersoff": {"name": "Carbon Tersoff (Erhart)", "description": "Diamond cubic Carbon with Erhart/Abell Tersoff", "pair_style": "tersoff", "pair_coeff": "* * C.tersoff Erhart C", "reference": "Erhart and Albe J. Phys.: Condens. Matter 2002", "typical_use": "Diamond, graphene, carbon nanotubes"},
            "LJ_argon": {"name": "Argon Lennard-Jones", "description": "Argon with truncated LJ potential", "pair_style": "lj/cut", "pair_coeff": "1 1 0.0103 3.4", "reference": "Standard LJ parameters for Argon", "typical_use": "Noble gases, generic LJ systems"},
            "Fe_eam": {"name": "Iron EAM", "description": "BCC/FCC Iron with EAM potential", "pair_style": "eam/alloy", "pair_coeff": "* * Fe_u3.eam Fe", "reference": "Mishin et al. Phys. Rev. B 1994", "typical_use": "Bulk Fe, Fe alloys, steels"},
            "Al_eam": {"name": "Aluminum EAM", "description": "FCC Aluminum with EAM potential", "pair_style": "eam/alloy", "pair_coeff": "* * Al_u3.eam Al", "reference": "Mishin et al. Phys. Rev. B 1999", "typical_use": "Bulk Al, Al alloys"},
        },
        "note": "These templates provide starting points. Adjust parameters as needed for your specific system."
    }


@router.post("/validate", response_model=ValidationResult)
def validate_lammps_input(request: LammpsInputRequest) -> ValidationResult:
    """Validate LAMMPS input parameters without generating files."""
    try:
        info = extract_structure_info(request.structure)

        pair_coeff_validation = validate_pair_coeff(
            request.pair_style, request.pair_coeff, info["n_types"])
        params_validation = validate_units_and_params(request)

        all_warnings = pair_coeff_validation.warnings + params_validation.warnings
        all_errors = pair_coeff_validation.errors + params_validation.errors

        return ValidationResult(
            valid=len(all_errors) == 0,
            warnings=all_warnings,
            errors=all_errors
        )

    except Exception as e:
        return ValidationResult(
            valid=False,
            errors=[f"Validation error: {str(e)}"]
        )


@router.get("/polymer/monomers")
def list_polymer_monomers() -> dict:
    """List available polymer monomer types."""
    return {
        "monomers": {
            name: {"repeat_unit": m.get("repeat_unit"), "description": f"{name} repeat unit"}
            for name, m in POLYMER_MONOMERS.items()
        },
        "force_fields": {
            name: {"name": ff["name"], "description": ff["description"], "typical_polymers": ff.get("typical_polymers", [])}
            for name, ff in POLYMER_FORCE_FIELDS.items()
        }
    }


@router.post("/polymer/build", response_model=PolymerBuildResponse)
def build_polymer(request: PolymerBuildRequest) -> PolymerBuildResponse:
    """Build a polymer structure for LAMMPS simulation."""
    warnings = []

    try:
        polymer_type_upper = request.polymer_type.upper()
        if polymer_type_upper not in POLYMER_MONOMERS:
            return PolymerBuildResponse(
                success=False,
                message=f"Unknown polymer type: {request.polymer_type}. "
                       f"Available: {', '.join(POLYMER_MONOMERS.keys())}"
            )

        chain_data = generate_polymer_chain(
            polymer_type=request.polymer_type,
            chain_length=request.chain_length,
            tacticity=request.tacticity,
            seed=request.seed
        )

        if request.box_size is None:
            avg_mass = 14.0
            total_mass = chain_data["n_atoms"] * avg_mass / 6.022e23
            volume_cm3 = total_mass / (request.density * 1000)
            volume_angstrom3 = volume_cm3 * 1e24
            box_side = volume_angstrom3 ** (1/3)
            box_size = (box_side, box_side, box_side)
        else:
            box_size = request.box_size

        packed_data = pack_polymers_in_box(
            chain_data=chain_data, n_chains=1, box_size=box_size, density=request.density
        )

        data_file = generate_polymer_data_file(packed_data, request)
        input_script = generate_polymer_input_script(request, box_size)

        return PolymerBuildResponse(
            success=True, n_chains=1, n_monomers=request.chain_length,
            density=request.density, data_file=data_file, input_script=input_script,
            message=f"Built {request.polymer_type} chain with {request.chain_length} monomers",
            warnings=warnings
        )

    except Exception as e:
        return PolymerBuildResponse(success=False, message=f"Error building polymer: {str(e)}")


@router.post("/sequential", response_model=SequentialLammpsResponse)
def generate_sequential_lammps(request: SequentialLammpsRequest) -> SequentialLammpsResponse:
    """Generate multi-stage LAMMPS simulation."""
    warnings = []
    errors = []

    try:
        info = extract_structure_info(request.structure)

        data_file_content = generate_data_file_content(
            request.structure, info,
            request.atom_style, request.boundary, request.prefix
        )

        stages_data = []
        all_input_lines = []

        for stage_num, stage in enumerate(request.stages):
            stage_lines = generate_stage_script(
                stage=stage, stage_num=stage_num, request=request, info=info
            )
            all_input_lines.extend(stage_lines)

            stages_data.append({
                "stage": stage_num + 1,
                "type": stage.stage_type.upper(),
                "input_script": "\n".join(stage_lines)
            })

        combined_input = "\n\n".join([
            "# Sequential LAMMPS Simulation",
            f"# Stages: {len(request.stages)}",
            "",
            generate_data_file_read_section(request.prefix),
            generate_force_field_section(request),
            "",
            "\n\n".join(["\n".join(stage.get("input_script", "")) for stage in stages_data])
        ])

        return SequentialLammpsResponse(
            success=True,
            message=f"Generated {len(request.stages)} stage simulation",
            stages=stages_data, combined_input=combined_input,
            data_file=data_file_content, warnings=warnings, errors=errors
        )

    except Exception as e:
        return SequentialLammpsResponse(
            success=False, message=f"Error: {str(e)}",
            stages=[], combined_input="", data_file="",
            warnings=[], errors=[str(e)]
        )


@router.post("/polymer/workflow", response_model=PolymerWorkflowResponse)
def generate_polymer_workflow(request: PolymerWorkflowRequest) -> PolymerWorkflowResponse:
    """Generate multi-stage polymer MD workflow input script."""
    warnings = []

    try:
        info = extract_structure_info(request.structure)
        data_file = generate_polymer_workflow_data_file(request, info)
        input_script, stages = generate_polymer_workflow_script(request, info)

        return PolymerWorkflowResponse(
            success=True, input_script=input_script, data_file=data_file,
            stages=stages,
            message=f"Generated {request.workflow_mode} workflow with {len(stages)} stages",
            warnings=warnings
        )

    except Exception as e:
        return PolymerWorkflowResponse(
            success=False, input_script="", data_file="",
            stages=[], message=f"Error: {str(e)}"
        )

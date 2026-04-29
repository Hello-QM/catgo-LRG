"""Sella transition state search input generation for workflow engine."""

import re
import logging
from typing import Any, Optional

from catgo.models.workflow_run import RECOMMENDED_POTCAR
from workflow.engines.vasp import _resolve_potcar_info, _resolve_vasp_command

logger = logging.getLogger(__name__)

__all__ = [
    "generate_sella_input_files",
    "generate_sella_inputs",
]


async def generate_sella_inputs(
    hpc: Any,
    work_dir: str,
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
    config: Any = None,
    session_id: str = "",
):
    """Generate Sella input files and upload to HPC."""
    potcar_root, potcar_functional = _resolve_potcar_info(config, session_id) if config else ("", "")
    vasp_command = _resolve_vasp_command(config, session_id) if config else "vasp_std"

    files = generate_sella_input_files(
        node_type, params, structure_str,
        potcar_root=potcar_root, potcar_functional=potcar_functional, vasp_command=vasp_command,
    )
    from catgo.utils.job_parser import write_remote_files
    await write_remote_files(hpc.conn, {f"{work_dir}/{k}": v for k, v in files.items()})


def generate_sella_input_files(
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
    potcar_root: str = "",
    potcar_functional: str = "",
    vasp_command: str = "vasp_std",
) -> dict[str, str]:
    """Pure function: return {filename: content} for Sella TS search."""
    calculator = params.get("calculator", "xtb")
    calculator_method = params.get("calculator_method", "GFN2-xTB")
    fmax = params.get("fmax", 0.01)
    max_steps = params.get("max_steps", 500)
    order = params.get("order", 1)
    delta = params.get("delta", 0.01)
    gamma = params.get("gamma", 0.4)

    # Build calculator setup block
    if calculator == "vasp":
        # Resolve VASP settings from cluster config
        encut = params.get("ENCUT", 520)
        ediff = params.get("EDIFF", "1e-5")
        ismear = params.get("ISMEAR", 0)

        # Parse kpoints
        kpoints_str = params.get("kpoints", "1×1×1")
        kpts = [1, 1, 1]
        if isinstance(kpoints_str, str):
            kp = re.split(r"[×xX\s,]+", kpoints_str.strip())
            if len(kp) == 3:
                try:
                    kpts = [int(k) for k in kp]
                except ValueError:
                    pass

        # Use potcar info and VASP command from function parameters
        cluster_vasp_cmd = vasp_command

        # Build RECOMMENDED_POTCAR dict as Python literal for the runner script
        potcar_map_str = repr(RECOMMENDED_POTCAR)

        calc_setup = f'''import os, subprocess, shlex

# Build POTCAR from cluster storage
potcar_root = "{potcar_root}"
potcar_functional = "{potcar_functional}"

# Get unique elements in POSCAR order
unique_elements = []
seen = set()
for sym in atoms.get_chemical_symbols():
    if sym not in seen:
        unique_elements.append(sym)
        seen.add(sym)

# Map to recommended POTCAR variants
RECOMMENDED = {potcar_map_str}
potcar_parts = []
for el in unique_elements:
    variant = RECOMMENDED.get(el, el)
    potcar_path = os.path.join(potcar_root, potcar_functional, variant, "POTCAR")
    potcar_parts.append(shlex.quote(potcar_path))

potcar_cmd = "cat " + " ".join(potcar_parts) + " > POTCAR"
result = subprocess.run(potcar_cmd, shell=True, capture_output=True)
if result.returncode != 0:
    raise RuntimeError(f"POTCAR generation failed: {{result.stderr.decode()}}")

os.environ["VASP_PP_PATH"] = potcar_root

# VASP as single-point calculator (Sella drives the optimization)
from ase.calculators.vasp import Vasp
calc = Vasp(
    command="{cluster_vasp_cmd}",
    encut={encut},
    ediff={ediff},
    ismear={ismear},
    sigma=0.05,
    kpts={kpts},
    nsw=0,
    ibrion=-1,
    lwave=False,
    lcharg=False,
    ncore=4,
)'''
    elif calculator == "xtb":
        accuracy = params.get("accuracy", 1.0)
        etemp = params.get("electronic_temperature", 300)
        calc_setup = f'''# Try tblite first, fallback to xtb-python
try:
    from tblite.ase import TBLite
    calc = TBLite(method="{calculator_method}", accuracy={accuracy}, electronic_temperature={etemp})
except ImportError:
    from xtb.ase.calculator import XTB
    calc = XTB(method="{calculator_method}")'''
    elif calculator == "mace":
        calc_setup = '''from mace.calculators import mace_mp
calc = mace_mp(model="medium", default_dtype="float64")'''
    elif calculator == "chgnet":
        calc_setup = '''from matgl.ext.ase import M3GNetCalculator
import matgl
pot = matgl.load_model("CHGNet")
calc = M3GNetCalculator(pot)'''
    elif calculator == "orca":
        orca_method = params.get("orca_method", "B3LYP")
        orca_basis = params.get("orca_basis", "6-31G*")
        charge = params.get("charge", 0)
        multiplicity = params.get("multiplicity", 1)
        num_cores = params.get("num_cores", 4)
        max_core_mb = params.get("max_core_mb", 4000)

        # Resolve ORCA directory from run config or params
        orca_dir_path = params.get("orca_dir", "")
        if not orca_dir_path and config:
            orca_dir_path = getattr(config, "orca_binary", "") or ""
            # Also check cluster_configs for orca_dir
            if not orca_dir_path and hasattr(config, "cluster_configs"):
                for cc in config.cluster_configs.values():
                    if hasattr(cc, "orca_dir") and cc.orca_dir:
                        orca_dir_path = cc.orca_dir
                        break

        # EnGrad MUST be first keyword after '!' — ORCA requires it at the start
        # of the route line to properly compute energy + gradient for Sella
        if orca_method == "r2SCAN-3c":
            orca_route = f"EnGrad {orca_method}"
        else:
            orca_route = f"EnGrad {orca_method} {orca_basis}"

        if orca_dir_path:
            # ORCA directory known from config — hardcode path in script
            calc_setup = f'''from ase.calculators.orca import ORCA, OrcaProfile

orca_profile = OrcaProfile(command="{orca_dir_path}/orca")

calc = ORCA(
    profile=orca_profile,
    label="ORCA",
    orcasimpleinput="{orca_route}",
    charge={charge},
    mult={multiplicity},
    task='gradient',
    orcablocks="%pal nprocs {num_cores} end\\n%maxcore {max_core_mb}",
)'''
        else:
            # Fallback: read from ORCA_DIR environment variable
            calc_setup = f'''import os
from ase.calculators.orca import ORCA, OrcaProfile

orca_dir = os.environ.get("ORCA_DIR")
if not orca_dir:
    raise RuntimeError("ORCA_DIR not set. Set it in the Run Configuration or SLURM script.")

orca_profile = OrcaProfile(command=f"{{orca_dir}}/orca")

calc = ORCA(
    profile=orca_profile,
    label="ORCA",
    orcasimpleinput="{orca_route}",
    charge={charge},
    mult={multiplicity},
    task='gradient',
    orcablocks="%pal nprocs {num_cores} end\\n%maxcore {max_core_mb}",
)'''
    else:
        calc_setup = f'raise RuntimeError("Unknown calculator: {calculator}")'

    # Determine input format: ORCA with JSON input vs standard POSCAR
    use_json = calculator == "orca" and structure_str and structure_str.strip().startswith("{")

    if use_json:
        # ORCA with JSON input: parse pymatgen dict to ASE atoms
        structure_loader = '''import json
import numpy as np
from ase import Atoms

with open("input.json") as f:
    struct_dict = json.load(f)

sites = struct_dict.get("sites", [])
symbols = [site["species"][0]["element"] for site in sites]
positions = [site["xyz"] for site in sites]

# Handle periodic structures (lattice present)
lattice = struct_dict.get("lattice", {})
cell = lattice.get("matrix")
if cell:
    atoms = Atoms(symbols=symbols, positions=positions, cell=cell, pbc=True)
else:
    atoms = Atoms(symbols=symbols, positions=positions, pbc=False)'''
        input_file = "input.json"
    else:
        structure_loader = '''from ase.io import read
atoms = read("POSCAR", format="vasp")'''
        input_file = "POSCAR"

    # Unified script — same Sella setup for both paths
    script = f'''#!/usr/bin/env python3
"""Sella transition state search generated by CatGo workflow engine."""
import sys
from ase.io import write
from sella import Sella

# Load structure
{structure_loader}

# Setup calculator
{calc_setup}

atoms.calc = calc

# Run Sella TS search
print(f"Starting Sella TS search (order={order}, fmax={fmax}, max_steps={max_steps})")
print(f"Calculator: {calculator}")
print(f"Atoms: {{len(atoms)}} ({{atoms.get_chemical_formula()}})")
sys.stdout.flush()

try:
    opt = Sella(atoms, trajectory="ts.traj", logfile="ts.log", order={order})
    converged = opt.run(fmax={fmax}, steps={max_steps})

    energy = atoms.get_potential_energy()
    max_force = max(abs(atoms.get_forces()).flat)
    print(f"Final energy: {{energy:.6f}} eV")
    print(f"Max force: {{max_force:.6f}} eV/A")
    print(f"Converged: {{converged}}")

    # Write output — VASP format needs a lattice, XYZ always works
    write("structure.xyz", atoms, format="xyz")
    if any(atoms.pbc):
        write("CONTCAR", atoms, format="vasp")
        print("Wrote CONTCAR and structure.xyz")
    else:
        print("Wrote structure.xyz (no lattice — skipping CONTCAR)")
except Exception as e:
    print(f"Sella optimization failed: {{e}}", file=sys.stderr)
    # Write last geometry even on failure so partial results are available
    try:
        write("structure.xyz", atoms, format="xyz")
        if any(atoms.pbc):
            write("CONTCAR", atoms, format="vasp")
        print("Wrote partial results")
    except Exception:
        pass
    sys.exit(1)
'''

    files = {"run_sella.py": script}
    if structure_str:
        if input_file == "input.json":
            files[input_file] = structure_str
        else:
            from workflow.engines import ensure_poscar
            try:
                files[input_file] = ensure_poscar(structure_str)
            except Exception as e:
                logger.warning("Could not convert structure to POSCAR: %s", e)
                files[input_file] = structure_str
    return files

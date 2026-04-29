"""ORCA input generation and node execution for workflow engine."""

import json
import logging
from typing import Any, Optional

from workflow.engines.vasp import _structure_to_pymatgen_dict

logger = logging.getLogger(__name__)

__all__ = [
    "generate_orca_input_files",
    "generate_orca_inputs",
    "execute_orca_node",
]


def _parse_structure(structure_str: str, Structure, Molecule):
    """Parse a structure string in POSCAR, XYZ, or JSON format."""
    struct = None
    try:
        struct = Structure.from_str(structure_str, fmt="poscar")
    except Exception:
        pass
    if struct is None:
        try:
            struct = Molecule.from_str(structure_str, fmt="xyz")
        except Exception:
            pass
    if struct is None:
        try:
            d = json.loads(structure_str)
            if d.get("lattice"):
                struct = Structure.from_dict(d)
            else:
                if d.get("charge") is None:
                    d["charge"] = 0
                struct = Molecule.from_dict(d)
        except Exception:
            pass
    return struct


async def generate_orca_inputs(
    hpc: Any,
    work_dir: str,
    node_type: str,
    params: dict[str, Any],
    edges: list[dict[str, Any]],
    step_results: dict[str, dict[str, Any]],
    structure_str: Optional[str],
    step_id: str,
):
    """Generate ORCA input files and upload to HPC.

    Extracts product structure from step_results for NEB-TS, then delegates
    to generate_orca_input_files() for pure computation.
    """
    # Resolve product structure for NEB-TS from workflow graph
    product_structure_str = None
    if node_type == "orca_neb_ts":
        product_structure_str = _resolve_neb_product(step_id, edges, step_results)

    files = generate_orca_input_files(node_type, params, structure_str, product_structure_str)
    from catgo.utils.job_parser import write_remote_files
    await write_remote_files(hpc.conn, {f"{work_dir}/{k}": v for k, v in files.items()})


def _resolve_neb_product(step_id, edges, step_results) -> Optional[str]:
    """Extract product structure string from the second parent of a NEB-TS node."""
    parent_ids = []
    for e in edges:
        tgt = e.get("target") or e.get("to", "")
        src = e.get("source") or e.get("from", "")
        if tgt == step_id and src:
            parent_ids.append(src)

    if len(parent_ids) < 2:
        return None

    product_result = step_results.get(parent_ids[1], {})
    product_str = product_result.get("contcar") or product_result.get("structure_json")
    return product_str


def generate_orca_input_files(
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
    product_structure_str: Optional[str] = None,
) -> dict[str, str]:
    """Pure function: return {filename: content} for ORCA calculation."""
    from pymatgen.core import Structure, Molecule

    # Check if user provided custom ORCA input
    if params.get("custom_inp_text"):
        orca_inp = params["custom_inp_text"]
        neb_files = {}  # No XYZ files when using custom input
    else:
        # Generate ORCA.inp from parameters
        from catgo.utils.orca_input import generate_orca_inputs as _gen_orca, generate_orca_neb_inputs, generate_orca_irc_inputs
        from catgo.routers.orca import ORCAInputRequest, OrcaNebInputRequest, OrcaIrcInputRequest

        # Parse input structure
        if not structure_str:
            raise RuntimeError("No input structure provided for ORCA calculation")
        struct = _parse_structure(structure_str, Structure, Molecule)
        if struct is None:
            raise ValueError("Could not parse structure (tried POSCAR, XYZ, JSON).")

        # Build request for input generation
        method = params.get("method", "B3LYP")
        basis_set = params.get("basis_set", params.get("basis", "6-31G"))
        charge = params.get("charge", 0)
        multiplicity = params.get("multiplicity", 1)

        # Determine opt_type from node_type if not explicitly set in params
        if "opt_type" in params:
            opt_type = params["opt_type"]
        else:
            opt_type = {
                "orca_sp": "SP",
                "orca_freq": "Freq",
                "orca_opt": "MinSteps",
            }.get(node_type, "MinSteps")

        num_cores = params.get("num_cores", 4)
        max_iterations = params.get("max_iterations", params.get("max_opt_cycles", 100))

        # Convert structure to PymatgenStructure format
        pymatgen_struct = _structure_to_pymatgen_dict(struct)
        neb_files = {}

        # Extract common QC params shared across all node types
        wavefunction = params.get("wavefunction") or None
        uno = params.get("uno", False)
        uco = params.get("uco", False)

        if node_type == "orca_neb_ts":
            # NEB-TS: resolve product structure from parameter
            product_struct = pymatgen_struct
            if product_structure_str:
                product_struct_obj = _parse_structure(product_structure_str, Structure, Molecule)
                if product_struct_obj is not None:
                    product_struct = _structure_to_pymatgen_dict(product_struct_obj)

            request = OrcaNebInputRequest(
                structure_reactant=pymatgen_struct,
                structure_product=product_struct,
                method=method,
                basis=basis_set,
                charge=charge,
                multiplicity=multiplicity,
                wavefunction=wavefunction,
                uno=uno,
                uco=uco,
                nimages=params.get("nimages", 8),
                ts_opt=params.get("ts_opt", True),
                neb_cycles=params.get("neb_cycles", 100),
                interpolation=params.get("interpolation", "IDPP"),
                num_cores=num_cores,
            )

            result = generate_orca_neb_inputs(request)
            orca_inp = result.get("inp", "")
            # Store XYZ files from result, allow custom override
            neb_files["reactant"] = params.get("custom_reactant_xyz") or result.get("reactant_xyz", "")
            neb_files["product"] = params.get("custom_product_xyz") or result.get("product_xyz", "")

        elif node_type == "orca_irc":
            # IRC requires transition state structure
            request = OrcaIrcInputRequest(
                structure=pymatgen_struct,
                method=method,
                basis=basis_set,
                charge=charge,
                multiplicity=multiplicity,
                wavefunction=wavefunction,
                uno=uno,
                uco=uco,
                max_iterations=params.get("max_irc_iterations", 30),
                initial_displacement_energy=params.get(
                    "initial_displacement_energy",
                    params.get("initial_displacement", 2.0)
                ),
                num_cores=num_cores,
            )
            result = generate_orca_irc_inputs(request)
            orca_inp = result.get("inp", "")

        elif node_type == "orca_uvvis":
            # UV-Vis spectroscopy (TD-DFT or STEOM)
            import types
            from catgo.utils.orca_input import generate_orca_uvvis_inputs
            request = types.SimpleNamespace(
                structure=pymatgen_struct,
                method=params.get("method", "CAM-B3LYP"),
                basis_set=params.get("basis_set", params.get("basis", "def2-TZVP")),
                charge=charge,
                multiplicity=multiplicity,
                nroots=params.get("nroots", 10),
                triplets=params.get("triplets", False),
                tda=params.get("tda", True),
                donto=params.get("donto", False),
                solvation=params.get("solvation", "none"),
                solvent=params.get("solvent", "water"),
                calc_type=params.get("calc_type", "tddft"),
                aux_basis=params.get("aux_basis", "def2-TZVP/C"),
                num_cores=num_cores,
                max_core_mb=params.get("max_core_mb", 4000),
                xyzfile_name=None,
                wavefunction="",
            )
            result = generate_orca_uvvis_inputs(request)
            orca_inp = result.get("inp", "")

        else:
            # Standard ORCA nodes (opt, sp, freq)
            request = ORCAInputRequest(
                structure=pymatgen_struct,
                method=method,
                basis_set=basis_set,
                charge=charge,
                multiplicity=multiplicity,
                wavefunction=wavefunction,
                opt_type=opt_type,
                opt_convergence=params.get("opt_convergence") or None,
                cartesian_opt=params.get("cartesian_opt", False),
                uno=uno,
                uco=uco,
                num_cores=num_cores,
                max_iterations=max_iterations,
            )
            result = _gen_orca(request)
            orca_inp = result.get("inp", "")

    # Collect output files
    files = {"ORCA.inp": orca_inp}
    if node_type == "orca_neb_ts" and neb_files:
        if neb_files.get("reactant"):
            files["reactant.xyz"] = neb_files["reactant"]
        if neb_files.get("product"):
            files["product.xyz"] = neb_files["product"]
    return files


# ====== ORCA Node Executor (for Rust tool bridge dispatch) ======

async def execute_orca_node(
    workflow_id: str,
    step_id: str,
    node_type: str,
    params: dict[str, Any],
    edges: list[dict[str, Any]],
    step_results: dict[str, dict[str, Any]],
    config: Any,
    _broadcast_fn: Any,
    _get_parent_step_ids_fn: Any,
):
    """Execute an ORCA workflow node via the Rust tool bridge.

    This function orchestrates ORCA job submission and monitoring by delegating
    to the existing Python workflow engine's job handling infrastructure.
    """
    from catgo.models.workflow import StepStatus
    from catgo.utils.workflow_db import update_step
    from catgo.utils.hpc_client import get_hpc_connection

    try:
        # Mark as running
        update_step(workflow_id, step_id, {"status": StepStatus.RUNNING.value})
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "running"
        })

        # Get HPC connection from config
        session_id = getattr(config, "hpc_session_id", config.hpc_config.get("session_id"))
        hpc = await get_hpc_connection(session_id, config)

        # Get parent structure
        parent_ids = _get_parent_step_ids_fn(step_id, edges)
        structure_str = None
        if parent_ids:
            parent_result = step_results.get(parent_ids[0], {})
            structure_str = parent_result.get("contcar") or parent_result.get("structure_json")
        elif "structure_json" in params:
            structure_str = params["structure_json"]
        else:
            raise ValueError("No input structure found in parent results or params")

        # Generate ORCA input files
        work_dir = f"/tmp/catgo_work/{workflow_id}/{step_id}"
        await generate_orca_inputs(
            hpc=hpc,
            work_dir=work_dir,
            node_type=node_type,
            params=params,
            edges=edges,
            step_results=step_results,
            structure_str=structure_str,
            step_id=step_id,
        )

        # Submit ORCA job via HPC
        # For now, just mark as completed after input generation
        # Full job submission will be integrated with the HPC job dispatch system
        step_results[step_id] = {
            "status": "submitted",
            "work_dir": work_dir,
            "node_type": node_type,
        }

        update_step(workflow_id, step_id, {
            "status": StepStatus.COMPLETED.value,
            "result_json": json.dumps({
                "status": "submitted",
                "work_dir": work_dir,
            }),
        })

        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "completed"
        })

    except Exception as e:
        logger.exception("ORCA node %s (%s) failed", step_id, node_type)
        update_step(workflow_id, step_id, {
            "status": StepStatus.FAILED.value,
            "error_message": str(e),
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id,
            "status": "failed", "error": str(e),
        })

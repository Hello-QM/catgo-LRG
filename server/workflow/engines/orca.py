"""ORCA input generation and node execution for workflow engine."""

import json
import logging
from typing import Any, Optional

from workflow.engines.vasp import _structure_to_pymatgen_dict

logger = logging.getLogger(__name__)

__all__ = [
    "generate_orca_input_files",
    "generate_orca_inputs",
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
        logger.warning(
            "NEB-TS node '%s' has fewer than 2 parents (found %d). "
            "Connect both reactant and product nodes.",
            step_id, len(parent_ids),
        )
        return None

    product_result = step_results.get(parent_ids[1], {})
    # Check all structure key formats:
    # - "contcar": POSCAR string (VASP/MLP output via contcar)
    # - "structure_json": pymatgen dict (legacy format)
    # - "structure": string or dict (hpc_execute single-path ORCA/VASP output)
    product_str = product_result.get("contcar") or product_result.get("structure_json")
    if not product_str:
        struct = product_result.get("structure")
        if struct:
            product_str = struct if isinstance(struct, str) else json.dumps(struct)
    if not product_str:
        logger.warning(
            "NEB-TS node '%s': product parent '%s' has no structure output "
            "(keys: %s). Check the product node completed successfully.",
            step_id, parent_ids[1], list(product_result.keys()),
        )
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
        neb_files = {}
        # NEB-TS still needs reactant.xyz / product.xyz even with custom .inp
        if node_type == "orca_neb_ts":
            from catgo.utils.orca_input import _structure_to_xyz_file_content
            struct = _parse_structure(structure_str, Structure, Molecule) if structure_str else None
            if struct is not None:
                neb_files["reactant"] = params.get("custom_reactant_xyz") or \
                    _structure_to_xyz_file_content(_structure_to_pymatgen_dict(struct))
            if product_structure_str:
                prod = _parse_structure(product_structure_str, Structure, Molecule)
                if prod is not None:
                    neb_files["product"] = params.get("custom_product_xyz") or \
                        _structure_to_xyz_file_content(_structure_to_pymatgen_dict(prod))
            elif params.get("custom_product_xyz"):
                neb_files["product"] = params["custom_product_xyz"]
    else:
        # Generate ORCA.inp from parameters
        from catgo.utils.orca_input import (
            generate_orca_inputs as _gen_orca,
            generate_orca_irc_inputs,
            generate_orca_neb_inputs,
        )
        from catgo.routers.orca import (
            ORCAInputRequest,
            OrcaIrcInputRequest,
            OrcaNebInputRequest,
        )

        # Parse input structure
        if not structure_str:
            raise RuntimeError("No input structure provided for ORCA calculation")
        struct = _parse_structure(structure_str, Structure, Molecule)
        if struct is None:
            raise ValueError("Could not parse structure (tried POSCAR, XYZ, JSON).")

        # Build request for input generation
        method = params.get("method", "B3LYP")
        basis_set = params.get("basis_set", params.get("basis", "def2-SVP"))
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
        max_core_mb = params.get("max_core_mb", 4000)
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
            if not product_structure_str and not params.get("custom_product_xyz"):
                raise RuntimeError(
                    "orca_neb_ts requires a product structure. Connect both reactant "
                    "and product nodes to the NEB-TS node (in-0 = reactant, in-1 = product), "
                    "or provide custom_product_xyz in params."
                )
            if product_structure_str:
                product_struct_obj = _parse_structure(product_structure_str, Structure, Molecule)
                if product_struct_obj is None:
                    raise ValueError(
                        "orca_neb_ts: could not parse product structure. "
                        "Ensure the product parent node completed with a valid structure output."
                    )
                product_struct = _structure_to_pymatgen_dict(product_struct_obj)

            # NEB-TS UI defaults to r2SCAN-3c / 6-31G; override the opt/sp-style
            # defaults computed at the top so the engine matches the preview.
            neb_method = params.get("method") or "r2SCAN-3c"
            neb_basis = params.get("basis_set") or params.get("basis") or "6-31G"
            request = OrcaNebInputRequest(
                structure_reactant=pymatgen_struct,
                structure_product=product_struct,
                method=neb_method,
                basis_set=neb_basis,
                basis=neb_basis,
                charge=charge,
                multiplicity=multiplicity,
                wavefunction=wavefunction,
                uno=uno,
                uco=uco,
                dispersion=params.get("dispersion") or None,
                three_body_dispersion=params.get("three_body_dispersion", False),
                grid=params.get("grid") or None,
                nimages=params.get("nimages", 8),
                ts_opt=params.get("ts_opt", True),
                neb_cycles=params.get("neb_cycles", 100),
                interpolation=params.get("interpolation", "IDPP"),
                num_cores=num_cores,
                max_core_mb=max_core_mb,
            )

            result = generate_orca_neb_inputs(request)
            orca_inp = result.get("inp", "")
            # Store XYZ files from result, allow custom override
            neb_files["reactant"] = params.get("custom_reactant_xyz") or result.get("reactant_xyz", "")
            neb_files["product"] = params.get("custom_product_xyz") or result.get("product_xyz", "")

        elif node_type == "orca_irc":
            # IRC defaults differ from opt/sp/freq (see node-definitions.ts
            # `irc` entry): method=r2SCAN-3c, basis=6-31G. Override the
            # opt/sp-style defaults computed at the top of this function so the
            # engine matches what the preview generator emits.
            irc_method = params.get("method") or "r2SCAN-3c"
            irc_basis = params.get("basis_set") or params.get("basis") or "6-31G"
            # UI form writes Max IRC Steps under `max_iterations`. Read that
            # first; fall back to legacy `max_irc_iterations` for MCP/skill
            # callers that still use the old name.
            irc_max_iter = params.get(
                "max_iterations",
                params.get("max_irc_iterations", 30),
            )
            request = OrcaIrcInputRequest(
                structure=pymatgen_struct,
                method=irc_method,
                basis_set=irc_basis,
                basis=irc_basis,
                charge=charge,
                multiplicity=multiplicity,
                wavefunction=wavefunction,
                uno=uno,
                uco=uco,
                dispersion=params.get("dispersion") or None,
                three_body_dispersion=params.get("three_body_dispersion", False),
                grid=params.get("grid") or None,
                max_iterations=irc_max_iter,
                num_cores=num_cores,
                max_core_mb=max_core_mb,
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
                dispersion=params.get("dispersion") or None,
                three_body_dispersion=params.get("three_body_dispersion", False),
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
                dispersion=params.get("dispersion") or None,
                three_body_dispersion=params.get("three_body_dispersion", False),
                grid=params.get("grid") or None,
                num_cores=num_cores,
                max_core_mb=max_core_mb,
                max_iterations=max_iterations,
            )
            result = _gen_orca(request)
            orca_inp = result.get("inp", "")

    # Inject %moinp for wavefunction restart from parent node
    parent_gbw = params.get("_parent_gbw_name")
    if parent_gbw and orca_inp and "%moinp" not in orca_inp:
        # Insert %moinp after %pal/%maxcore block (before route line "!")
        moinp_line = f'%moinp "{parent_gbw}"'
        if "!" in orca_inp:
            orca_inp = orca_inp.replace("!", f"{moinp_line}\n\n!", 1)
        else:
            orca_inp = moinp_line + "\n\n" + orca_inp

    # Collect output files
    files = {"ORCA.inp": orca_inp}
    if node_type == "orca_neb_ts":
        if neb_files.get("reactant"):
            files["reactant.xyz"] = neb_files["reactant"]
        else:
            logger.error("NEB-TS: reactant XYZ is empty/missing! neb_files=%s", list(neb_files.keys()))
        if neb_files.get("product"):
            files["product.xyz"] = neb_files["product"]
        else:
            logger.error("NEB-TS: product XYZ is empty/missing! neb_files=%s", list(neb_files.keys()))
        logger.info("NEB-TS: returning %d files: %s", len(files), list(files.keys()))
    return files

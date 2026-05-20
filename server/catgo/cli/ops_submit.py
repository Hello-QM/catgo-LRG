"""hpc-group handler: submit. (session, params) -> OpResult.

Generates an input deck for the requested code, scp's it to a remote
HPC profile, and sbatches a SLURM script that runs the deck.

needs_server=False (this op does NOT touch the local CatGO viewer).
"""
from __future__ import annotations

from pymatgen.core import Structure

from catgo.cli.adapter import call_route


_VASP_BODY = """\
cd "$SLURM_SUBMIT_DIR"
mpirun vasp_std > vasp.log 2>&1
"""

_CP2K_BODY_TEMPLATE = """\
cd "$SLURM_SUBMIT_DIR"
mpirun cp2k.psmp -i {prefix}.inp -o {prefix}.out
"""


def _slurm_script(code: str, job_name: str, nodes: int, walltime_h: int,
                  queue: str, prefix: str) -> str:
    """Build a SLURM submit script for `code` on `nodes` nodes.

    Hardcoded inline (rather than reusing a backend template generator)
    because the FastAPI `/hpc/submit` route also takes raw
    `script_content` — no shared template exists. Two short bodies
    (VASP / CP2K) keep the surface tight and testable.

    `walltime_h` is an integer count of hours, translated to `HH:00:00`
    — matches the registry's one-scalar-per-param shape.
    """
    sbatch_lines = [
        "#!/bin/bash",
        f"#SBATCH --job-name={job_name}",
        f"#SBATCH --nodes={nodes}",
        f"#SBATCH --time={walltime_h:02d}:00:00",
        "#SBATCH --output=slurm-%j.out",
        "#SBATCH --error=slurm-%j.err",
    ]
    if queue:
        sbatch_lines.append(f"#SBATCH -p {queue}")
    sbatch_lines.append("")
    if code == "vasp":
        body = _VASP_BODY
    elif code == "cp2k":
        body = _CP2K_BODY_TEMPLATE.format(prefix=prefix)
    else:
        raise ValueError(f"unsupported code: {code}")
    return "\n".join(sbatch_lines) + "\n" + body


# ============================================================================
# Input-deck generators (in-process adapter to /vasp/generate, /cp2k/input)
# ============================================================================


def _generate_vasp_deck(structure: Structure) -> dict[str, str]:
    """Generate a VASP geometry-opt input deck for `structure`.

    Returns {filename: content} for INCAR, POSCAR, KPOINTS, and a
    POTCAR_NEEDED marker. POTCAR is intentionally NOT generated — VASP
    requires the user's licensed pseudopotentials; the existing
    `make-potcar` skill handles that locally.
    """
    # Lazy import: only the submit op pulls these in, keeps the cold-start
    # surface for build/convert/analyze ops unchanged.
    from catgo.routers.vasp import generate_vasp_inputs_endpoint
    from catgo.models.vasp import VASPInputRequest, VASPCalculationType

    result = call_route(
        generate_vasp_inputs_endpoint, VASPInputRequest,
        structure=structure.as_dict(),
        calculation_type=VASPCalculationType.OPT,
    )
    elements = result.potcar_info.get("elements", [])
    marker = (
        "# POTCAR NEEDED\n"
        f"# Required elements (in POSCAR order): {' '.join(elements)}\n"
        "# Generate locally with the make-potcar skill or vaspkit option 103,\n"
        "# then scp the resulting POTCAR into this remote work directory.\n"
    )
    return {
        "INCAR": result.incar,
        "POSCAR": result.poscar,
        "KPOINTS": result.kpoints,
        "POTCAR_NEEDED": marker,
    }


def _generate_cp2k_deck(structure: Structure, prefix: str = "calc",
                        run_type: str = "GEO_OPT") -> dict[str, str]:
    """Generate a CP2K input deck (single `.inp` file)."""
    from catgo.routers.cp2k import generate_input_file, CP2KInputRequest

    result = call_route(
        generate_input_file, CP2KInputRequest,
        structure=structure.as_dict(),
        prefix=prefix,
        run_type=run_type,
    )
    return {f"{prefix}.inp": result.input_file}

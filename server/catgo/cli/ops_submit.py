"""hpc-group handler: submit. (session, params) -> OpResult.

Generates an input deck for the requested code, scp's it to a remote
HPC profile, and sbatches a SLURM script that runs the deck.

needs_server=False (this op does NOT touch the local CatGO viewer).
"""
from __future__ import annotations


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

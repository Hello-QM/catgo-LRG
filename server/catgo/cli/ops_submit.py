"""hpc-group handler: submit. (session, params) -> OpResult.

Generates an input deck for the requested code, scp's it to a remote
HPC profile, and sbatches a SLURM script that runs the deck.

needs_server=False (this op does NOT touch the local CatGO viewer).
"""
from __future__ import annotations

import datetime
from pathlib import Path

from pymatgen.core import Structure

from catgo.cli.adapter import OpError, call_route
from catgo.cli.hpc_link import HpcError, HpcLink
from catgo.cli.registry import OpResult
from catgo.utils.connection_pool import load_profiles


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


# ============================================================================
# Profile + input resolution
# ============================================================================


def _resolve_profile(host: str):
    """Look up the requested profile (or first available) from
    ~/.catgo/hpc_profiles.json. Raises OpError on miss."""
    profiles = load_profiles()
    if not profiles:
        raise OpError(
            "no HPC profiles; add one via 'catgo serve' web UI or "
            "~/.catgo/hpc_profiles.json"
        )
    if not host:
        return profiles[0]
    for p in profiles:
        if p.name == host:
            return p
    available = ", ".join(p.name for p in profiles) or "(none)"
    raise OpError(
        f"host '{host}' not found in ~/.catgo/hpc_profiles.json "
        f"(available: {available})"
    )


def _resolve_structure(session, params: dict) -> Structure:
    inp = params.get("input")
    if inp:
        src = Path(inp)
        if not src.exists():
            raise OpError(f"submit input not found: {src}")
        from catgo.cli.session import read_structure, SessionError
        try:
            return read_structure(src)
        except SessionError as exc:
            raise OpError(str(exc)) from exc
    if session.structure is None:
        raise OpError(
            "submit requires <input> file or a loaded session structure"
        )
    return session.structure


# ============================================================================
# Public handler
# ============================================================================


def submit(session, params: dict) -> OpResult:
    """Generate input deck, scp to remote, sbatch, return job id.

    See docs/superpowers/specs/2026-05-19-catgo-cli-hpc-submit-design.md
    for the full design rationale.
    """
    code = params.get("code", "vasp")
    if code not in ("vasp", "cp2k"):
        raise OpError(f"submit: unsupported code '{code}' (vasp|cp2k)")

    profile = _resolve_profile(params.get("host") or "")
    structure = _resolve_structure(session, params)
    formula = structure.composition.reduced_formula

    job_name = params.get("job_name") or f"catgo_{formula}"
    nodes = int(params.get("nodes", 1))
    walltime_h = int(params.get("walltime", 24))
    queue = params.get("queue") or ""
    prefix = "calc"

    # Build the HpcLink — auth validation happens in HpcLink.__post_init__
    try:
        link = HpcLink(profile)
    except HpcError as exc:
        raise OpError(f"host '{profile.name}': {exc}") from exc

    # Generate input deck (in-process adapter)
    if code == "vasp":
        deck = _generate_vasp_deck(structure)
    else:
        deck = _generate_cp2k_deck(structure, prefix=prefix)

    # Build submit script
    script = _slurm_script(
        code=code, job_name=job_name, nodes=nodes,
        walltime_h=walltime_h, queue=queue, prefix=prefix,
    )
    deck["catgo_submit.sh"] = script

    # Resolve remote dir (default ~/catgo-jobs/<UTC-ts>-<jobname>)
    remote_dir = params.get("remote_dir") or ""
    if not remote_dir:
        # tz-aware UTC; utcnow() is deprecated in py3.12+.
        ts = datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y%m%dT%H%M%SZ"
        )
        remote_dir = f"~/catgo-jobs/{ts}-{job_name}"

    # Talk to the remote host
    try:
        link.preflight()
        link.mkdir_p(remote_dir)
        for name, content in deck.items():
            link.put_text(content, f"{remote_dir}/{name}")
        job_id = link.sbatch(remote_dir, "catgo_submit.sh")
    except HpcError as exc:
        raise OpError(str(exc)) from exc

    # Stash a local copy under ./catgo-submit-<job_id>/
    artifact = Path.cwd() / f"catgo-submit-{job_id}"
    artifact.mkdir(parents=True, exist_ok=True)
    for name, content in deck.items():
        (artifact / name).write_text(content)

    return OpResult(
        ok=True,
        message=(
            f"submitted {code} {formula} job={job_id} host={profile.name} "
            f"dir={remote_dir}  (watch: ssh {profile.ssh_alias or profile.host} "
            f"squeue -j {job_id})"
        ),
        artifact=artifact,
        structure=None,
    )

"""AMBER input generation for workflow engine.

Supports ML/MM molecular dynamics with sander (MACE, ANI, AIMNet2 etc.)
and standard AMBER minimization / MD.

Reference workflow: ML/MM electric-field response in enzyme catalysis.
"""

import json
import logging
from typing import Any, Optional


logger = logging.getLogger(__name__)

__all__ = [
    "generate_amber_inputs",
]

# ---------------------------------------------------------------------------
# MLP model display-name → file-stem mapping (matches .pt files on HPC)
# ---------------------------------------------------------------------------
MLP_MODELS: dict[str, str] = {
    "maceomol_v2": "maceomol_v2",
    "macepol_l": "macepol_l",
    "macepol_m": "macepol_m",
    "macepol_s": "macepol_s",
    "mace_off23_large": "MACE-OFF23_large",
    "mace_off23_medium": "MACE-OFF23_medium",
    "mace_off23_small": "MACE-OFF23_small",
    "aimnet2": "aimnet2",
    "aimnet2nse": "aimnet2nse",
    "ani2x": "ani2x_model",
    "ani1_xnr": "ani1_xnr",
    "spookynet": "spookynet",
    "egret_s": "egret-s",
}


def _build_mdin(node_type: str, params: dict[str, Any]) -> str:
    """Build an AMBER mdin input string from workflow parameters.

    The mdin has two namelists:
      &cntrl  — standard AMBER MD / minimization controls
      &mlp    — ML potential settings (only when ifmlp=1)
    """
    lines: list[str] = []

    # Title line
    title = params.get("title", "CatGO AMBER job")
    lines.append(title)

    # ── &cntrl namelist ──
    cntrl: dict[str, Any] = {}

    if node_type == "amber_minimize":
        cntrl["imin"] = 1
        cntrl["maxcyc"] = params.get("maxcyc", 5000)
        cntrl["ncyc"] = params.get("ncyc", 2500)
        cntrl["drms"] = params.get("drms", 0.0001)
    else:
        # MD run
        cntrl["imin"] = 0
        cntrl["nstlim"] = params.get("nstlim", 5000000)
        cntrl["dt"] = params.get("dt", 0.0001)

    # Restart control
    irest = params.get("irest", 1)
    cntrl["irest"] = irest
    cntrl["ntx"] = 5 if irest == 1 else 1

    # Thermostat
    ntt = params.get("ntt", 0)
    cntrl["ntt"] = ntt
    if ntt in (1, 2, 3):
        cntrl["temp0"] = params.get("temp0", 300.0)
        cntrl["tempi"] = params.get("tempi", params.get("temp0", 300.0))
    if ntt == 3:
        cntrl["gamma_ln"] = params.get("gamma_ln", 2.0)

    # Periodic boundary
    ntb = params.get("ntb", 0)
    cntrl["ntb"] = ntb

    # Cutoff
    cntrl["cut"] = params.get("cut", 9999.0 if ntb == 0 else 10.0)

    # SHAKE constraints
    cntrl["ntc"] = params.get("ntc", 1)
    cntrl["ntf"] = params.get("ntf", 1)

    # Output frequencies
    cntrl["ntpr"] = params.get("ntpr", 1000)
    cntrl["ntwe"] = params.get("ntwe", 1000)
    cntrl["ntwx"] = params.get("ntwx", 10000)
    cntrl["ntwv"] = params.get("ntwv", 0)
    cntrl["ntwr"] = params.get("ntwr", 100000)

    # Output format
    cntrl["ioutfm"] = params.get("ioutfm", 1)
    cntrl["ntxo"] = params.get("ntxo", 2)

    # ML potential flag
    use_mlp = params.get("use_mlp", True)
    if use_mlp:
        cntrl["ifmlp"] = 1

    # Barostat (NPT)
    ntp = params.get("ntp", 0)
    if ntp > 0:
        cntrl["ntp"] = ntp
        cntrl["barostat"] = params.get("barostat", 2)
        cntrl["pres0"] = params.get("pres0", 1.0)

    # Extra &cntrl params (advanced)
    extra_cntrl = params.get("extra_cntrl", "")
    if isinstance(extra_cntrl, str):
        extra_cntrl = extra_cntrl.strip()

    # Render &cntrl
    lines.append(" &cntrl")
    for key, val in cntrl.items():
        if isinstance(val, float):
            lines.append(f"  {key} = {val},")
        else:
            lines.append(f"  {key} = {val},")
    if extra_cntrl:
        for extra_line in extra_cntrl.splitlines():
            extra_line = extra_line.strip()
            if extra_line:
                if not extra_line.endswith(","):
                    extra_line += ","
                lines.append(f"  {extra_line}")
    lines.append(" /")

    # ── &mlp namelist (ML/MM) ──
    if use_mlp:
        mlp: dict[str, Any] = {}

        # Model selection
        mlp_model = params.get("mlp_model", "macepol_l")
        mlp["mlp_model"] = f"'{mlp_model}'"

        # Atom mask for ML region
        animask = params.get("animask", "")
        if animask:
            mlp["animask"] = f'"{animask}"'

        # SHAKE in ML region
        mlp["mlp_shake"] = params.get("mlp_shake", 1)

        # GPU
        mlp["gpu_id"] = params.get("gpu_id", 0)

        # Embedding & multipole settings
        mlp["mlp_embedding"] = params.get("mlp_embedding", 2)
        mlp["mlp_multipole"] = params.get("mlp_multipole", 1)
        mlp["mlp_polar"] = params.get("mlp_polar", 2)

        # Charge adjustment
        mlp["adjust_q"] = params.get("adjust_q", 1)

        # Extra &mlp params
        extra_mlp = params.get("extra_mlp", "")
        if isinstance(extra_mlp, str):
            extra_mlp = extra_mlp.strip()

        lines.append("&mlp")
        for key, val in mlp.items():
            lines.append(f"{key}={val},")
        if extra_mlp:
            for extra_line in extra_mlp.splitlines():
                extra_line = extra_line.strip()
                if extra_line:
                    if not extra_line.endswith(","):
                        extra_line += ","
                    lines.append(f"{extra_line}")
        lines.append("/")

    return "\n".join(lines) + "\n"


async def generate_amber_inputs(
    hpc: Any,
    work_dir: str,
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str] = None,
    config: Any = None,
    session_id: str = "",
):
    """Generate AMBER input files and upload to HPC.

    Required user-provided files (via params):
      - topology_file:  path to prmtop on HPC (or upload content)
      - restart_file:   path to rst7/ncrst on HPC (or upload content)

    Generated files:
      - mdin:  MD/minimization control input
    """
    from catgo.utils.job_parser import write_remote_file

    # ── 1. mdin — generate or use custom ──
    custom_mdin = params.get("custom_mdin", "")
    if custom_mdin:
        mdin_content = custom_mdin
        logger.info("Using custom mdin for %s", work_dir)
    else:
        mdin_content = _build_mdin(node_type, params)

    await write_remote_file(hpc.conn, f"{work_dir}/mdin", mdin_content)

    # ── 2. prmtop — link or copy from user-specified path ──
    topology_file = params.get("topology_file", "")
    if topology_file:
        # Symlink to the user's prmtop (avoid copying large files)
        await hpc.conn.run(
            f"ln -sf {topology_file} {work_dir}/prmtop",
            check=True,
        )
        logger.info("Linked prmtop: %s → %s/prmtop", topology_file, work_dir)
    else:
        logger.warning("No topology_file specified for AMBER job in %s", work_dir)

    # ── 3. rst7 — link or copy restart file ──
    restart_file = params.get("restart_file", "")
    if restart_file:
        await hpc.conn.run(
            f"ln -sf {restart_file} {work_dir}/inpcrd",
            check=True,
        )
        logger.info("Linked restart: %s → %s/inpcrd", restart_file, work_dir)
    else:
        logger.warning("No restart_file specified for AMBER job in %s", work_dir)

    # ── 4. ML model files — symlink if model_path provided ──
    model_path = params.get("model_path", "")
    if model_path and params.get("use_mlp", True):
        # Symlink the model directory so sander can find .pt files
        await hpc.conn.run(
            f"ln -sf {model_path} {work_dir}/model",
            check=True,
        )
        logger.info("Linked model dir: %s → %s/model", model_path, work_dir)

    logger.info(
        "AMBER inputs generated for %s (%s) in %s",
        node_type, params.get("mlp_model", "N/A"), work_dir,
    )

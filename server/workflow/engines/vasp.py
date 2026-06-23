"""VASP input generation and result extraction for workflow engine."""

import json
import logging
import re
import shlex

logger = logging.getLogger(__name__)
import logging
from typing import Any, Optional

from catgo.models.vasp import VASPCalculationType, VASPInputRequest, VASPOptimizerType
from catgo.models.workflow_run import RECOMMENDED_POTCAR

logger = logging.getLogger(__name__)

__all__ = [
    "generate_vasp_inputs",
    "generate_potcar_from_poscar",
    "generate_potcar",
]


def _node_type_to_calc_type(node_type: str) -> VASPCalculationType:
    """Map workflow node type -> VASPCalculationType for input generation."""
    mapping = {
        "vasp_relax": VASPCalculationType.OPT,
        "bulk_opt": VASPCalculationType.OPT,
        "slab_relax": VASPCalculationType.OPT,
        "vasp_static": VASPCalculationType.SCF,
        "electronic": VASPCalculationType.DOS,
        "frequency": VASPCalculationType.FREQ,
        "vasp_md": VASPCalculationType.OPT,  # MD uses NSW > 0, IBRION=0
        "reference_mol": VASPCalculationType.OPT,
        # Unified types (VASP software)
        "geo_opt": VASPCalculationType.OPT,
        "single_point": VASPCalculationType.SCF,
        "cell_opt": VASPCalculationType.OPT,
        "md": VASPCalculationType.OPT,
        "freq": VASPCalculationType.FREQ,
        "slow_growth": VASPCalculationType.SLOW_GROWTH,
    }
    return mapping.get(node_type, VASPCalculationType.SCF)


def _get_layer_z_threshold(struct: Any, n_frozen_layers: int) -> float:
    """Get z-coordinate threshold for freezing bottom N layers of a slab."""
    z_coords = sorted(set(round(site.coords[2], 2) for site in struct))
    if n_frozen_layers >= len(z_coords):
        return max(z_coords) + 0.1
    # Return midpoint between frozen and free layers
    return (z_coords[n_frozen_layers - 1] + z_coords[n_frozen_layers]) / 2


def _freeze_n_bottom_layers(params: dict) -> int:
    """Number of bottom slab layers to freeze, tolerant of every param spelling
    used across the frontend / skills / MCP (`frozen_layers`, `freeze_layers`,
    `freeze_n_layers`). Returns 0 if none set. Single source of truth so a slab
    is frozen regardless of which producer authored the node."""
    for key in ("frozen_layers", "freeze_layers", "freeze_n_layers"):
        v = params.get(key)
        if v:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return 0


def _structure_to_pymatgen_dict(struct: Any) -> dict[str, Any]:
    """Convert a pymatgen Structure or Molecule to the PymatgenStructure model format."""
    sites = []
    for site in struct:
        try:
            sp = site.specie
        except AttributeError:
            # Disordered / partial-occupancy site: pymatgen's `.specie` property
            # raises (it falls through to __getattr__). Fall back to the
            # dominant species so VASP input generation still resolves an element.
            sp = max(site.species.items(), key=lambda kv: kv[1])[0]
        elem = str(sp.element) if hasattr(sp, "element") else str(sp)
        oxi = getattr(sp, "oxi_state", None) or getattr(sp, "oxidation_state", None)
        species_dict = {"element": elem, "occu": 1.0}
        if oxi is not None:
            species_dict["oxidation_state"] = float(oxi)
        sites.append({
            "species": [species_dict],
            "abc": list(site.frac_coords) if hasattr(site, "frac_coords") else [0, 0, 0],
            "xyz": list(site.coords),
        })

    result = {"sites": sites}

    # Only include lattice for periodic structures (not molecules)
    if hasattr(struct, "lattice") and struct.lattice is not None:
        result["lattice"] = {
            "matrix": struct.lattice.matrix.tolist(),
            "a": struct.lattice.a,
            "b": struct.lattice.b,
            "c": struct.lattice.c,
            "alpha": struct.lattice.alpha,
            "beta": struct.lattice.beta,
            "gamma": struct.lattice.gamma,
        }

    return result


def _resolve_potcar_info(config: Any, session_id: str) -> tuple[str, str]:
    """Get (potcar_root, potcar_functional) for a cluster. Returns ("", "") if not configured."""
    cluster = config.cluster_configs.get(session_id)
    if cluster and cluster.potcar_root.strip():
        return cluster.potcar_root.rstrip("/"), cluster.potcar_functional or "potpaw_PBE"
    return "", ""


def _resolve_vasp_command(config: Any, session_id: str) -> str:
    """Get the VASP run command for a given cluster."""
    cluster = config.cluster_configs.get(session_id)
    if cluster and cluster.vasp_command.strip():
        return cluster.vasp_command
    return "srun --hint=nomultithread vasp_std"


async def generate_vasp_inputs(
    hpc: Any,
    work_dir: str,
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
    config: Any = None,
    session_id: str = "",
):
    """Generate VASP input files and upload to HPC. POTCAR generated remotely."""
    files, poscar, pseudo_h = generate_vasp_input_files(node_type, params, structure_str)
    from catgo.utils.job_parser import write_remote_files
    await write_remote_files(hpc.conn, {f"{work_dir}/{k}": v for k, v in files.items()})

    if config and session_id:
        await generate_potcar_from_poscar(
            hpc, work_dir, poscar, config, session_id,
            pseudo_h_potcars=pseudo_h,
        )


def generate_vasp_input_files(
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
) -> tuple[dict[str, str], Any, dict]:
    """Pure function: return (files_dict, poscar_obj, pseudo_h_potcars).

    files_dict: {filename: content} for INCAR, KPOINTS, POSCAR, optional run_vasp.sh
    poscar_obj: pymatgen Poscar for downstream POTCAR generation
    pseudo_h_potcars: pseudo-H POTCAR mapping (may be empty dict)
    """
    from pymatgen.core import Structure
    from pymatgen.io.vasp import Poscar
    from catgo.utils.vasp_input import generate_incar, generate_kpoints

    # Parse input structure
    if structure_str:
        try:
            struct = Structure.from_str(structure_str, fmt="poscar")
        except Exception:
            # Try as pymatgen JSON
            struct = Structure.from_dict(json.loads(structure_str))
    else:
        raise RuntimeError("No structure provided for VASP calculation")

    # Apply VASP best-practice presets (atomate2-style defaults)
    from workflow.presets.vasp import apply_preset

    _preset_calc_type_map = {
        "geo_opt": "relax", "vasp_relax": "relax", "bulk_opt": "relax",
        "slab_relax": "slab_relax",
        "single_point": "static", "vasp_static": "static",
        "freq": "freq", "frequency": "freq",
        "band_structure": "band", "electronic": "static",
        "vasp_md": "md", "md": "md",
        "slow_growth": "slow_growth",
    }
    preset_calc_type = _preset_calc_type_map.get(node_type, "relax")
    user_incar = params.get("incar", {})
    preset_params = apply_preset(preset_calc_type, user_incar)
    # Merge preset values into params (user explicit params override preset)
    for k, v in preset_params.items():
        if k not in params or params[k] is None:
            params[k] = v

    # Build VASPInputRequest from node params
    calc_type = _node_type_to_calc_type(node_type)

    # Map node params to VASPInputRequest fields
    request_data: dict[str, Any] = {
        "calculation_type": calc_type,
        "structure": _structure_to_pymatgen_dict(struct),
    }

    # Copy relevant params
    param_mapping = {
        "ENCUT": "encut", "EDIFF": "ediff", "EDIFFG": "ediffg",
        "NSW": "nsw", "ISIF": "isif", "IBRION": "ibrion",
        "ISMEAR": "ismear", "SIGMA": "sigma", "ISPIN": "ispin",
        "POTIM": "potim", "NFREE": "nfree", "NEDOS": "nedos",
        "NCORE": "ncore", "NPAR": "npar", "IVDW": "ivdw",
        "LORBIT": "lorbit", "LWAVE": "lwave", "LCHARG": "lcharg",
        "LREAL": "lreal",
        "ALGO": "algo", "PREC": "prec", "GGA": "gga",
    }

    for param_key, request_key in param_mapping.items():
        if param_key in params and params[param_key] is not None:
            val = params[param_key]
            # Parse string numbers
            if isinstance(val, str):
                try:
                    if "." in val or "e" in val.lower():
                        val = float(val)
                    else:
                        val = int(val)
                except ValueError:
                    pass
            # LREAL expects a string in the Pydantic model (e.g. "False", "Auto")
            if request_key == "lreal" and isinstance(val, bool):
                val = str(val)
            request_data[request_key] = val

    # Pass through any OTHER INCAR tags so users can set arbitrary INCAR options
    # (e.g. LH5, MAGMOM, ICHARG, AMIX, LDAU*) that aren't in param_mapping above.
    # VASP INCAR tags are UPPERCASE; CatGo control keys (software, kpoints,
    # freeze_mode, system_type, ...) are lowercase, so route uppercase-and-unmapped
    # keys plus an explicit `custom_incar` dict into request.custom_incar.
    extra_incar: dict[str, Any] = dict(params.get("custom_incar") or {})
    for k, v in params.items():
        if v is None or k in param_mapping or k == "KPOINTS":
            continue
        if isinstance(k, str) and len(k) >= 2 and k.isupper():
            if isinstance(v, str):
                try:
                    v = float(v) if ("." in v or "e" in v.lower()) else int(v)
                except ValueError:
                    pass
            extra_incar.setdefault(k, v)
    if extra_incar:
        request_data.setdefault("custom_incar", {})
        for k, v in extra_incar.items():
            request_data["custom_incar"].setdefault(k, v)

    # Handle optimizer
    ibrion = params.get("IBRION")
    if ibrion == 3:
        request_data["optimizer"] = VASPOptimizerType.VTST_FIRE
    elif ibrion == 1:
        request_data["optimizer"] = VASPOptimizerType.QUASI_NEWTON

    # Handle KPOINTS
    kpoints_str = params.get("kpoints") or params.get("KPOINTS")
    if kpoints_str and isinstance(kpoints_str, str):
        # Parse "4x4x4" or "4x4x4" or "4 4 4"
        kp = re.split(r"[×xX\s,]+", kpoints_str.strip())
        if len(kp) == 3:
            try:
                request_data["kpoints"] = [[int(k) for k in kp]]
            except ValueError:
                pass

    # Handle slab-specific params (unified geo_opt/vasp_relax + legacy slab_relax)
    if node_type in ("slab_relax", "vasp_relax", "geo_opt"):
        request_data.setdefault("isif", 2)
        if params.get("LDIPOL"):
            request_data.setdefault("custom_incar", {})
            request_data["custom_incar"]["LDIPOL"] = True
            request_data["custom_incar"]["IDIPOL"] = 3
        # Freeze bottom N layers (selective dynamics). Previously only wired for
        # slab_relax, so the unified geo_opt/vasp_relax path silently ignored
        # frozen_layers and the slab was never actually constrained.
        n_frozen_layers = _freeze_n_bottom_layers(params)
        if n_frozen_layers > 0 and struct:
            z_threshold = _get_layer_z_threshold(struct, n_frozen_layers)
            request_data["fixed_z_below"] = z_threshold
            sd = [[False, False, False] if site.coords[2] < z_threshold else [True, True, True]
                  for site in struct]
            struct.add_site_property("selective_dynamics", sd)
            n_frozen = sum(1 for row in sd if row == [False, False, False])
            logger.info("[FREEZE] %s: fixed %d/%d atoms below z=%.3f",
                        node_type, n_frozen, len(struct), z_threshold)

    # Handle frozen atoms for frequency calculations
    if node_type in ("freq", "frequency"):
        freeze_mode = params.get("freeze_mode", "none")
        frozen_set: set[int] = set()
        n_atoms = len(struct) if struct else 0

        if freeze_mode == "z_range" and struct:
            z_lo = float(params.get("freeze_z_below", 0))
            for idx, site in enumerate(struct):
                if site.coords[2] < z_lo:
                    frozen_set.add(idx)

        elif freeze_mode == "element" and struct:
            elems = {e.strip() for e in str(params.get("freeze_elements", "")).split(",") if e.strip()}
            for idx, site in enumerate(struct):
                if str(site.specie) in elems:
                    frozen_set.add(idx)

        elif freeze_mode == "adsorbate" and struct:
            # Surface-frequency methodology: fix the entire slab, vibrate only the
            # adsorbate. Adsorbate atoms are tagged is_adsorbate=True by
            # run_adsorbate_place; everything else is frozen.
            tags = struct.site_properties.get("is_adsorbate")
            if not tags or not any(tags):
                logger.warning(
                    "[FREEZE] freeze_mode=adsorbate but structure has no is_adsorbate "
                    "tag (%d atoms) — freezing nothing", n_atoms)
            else:
                for idx, is_ads in enumerate(tags):
                    if not is_ads:
                        frozen_set.add(idx)

        elif freeze_mode in ("indices", "manual"):
            idx_str = str(params.get("freeze_indices", ""))
            for part in idx_str.split(","):
                part = part.strip()
                if not part:
                    continue
                if "-" in part:
                    try:
                        a, b = part.split("-", 1)
                        frozen_set.update(range(int(a), int(b) + 1))
                    except ValueError:
                        pass
                else:
                    try:
                        frozen_set.add(int(part))
                    except ValueError:
                        pass

        elif freeze_mode in ("layers", "bottom") and struct:
            # "bottom" is the workflow_builder/MCP spelling; "layers" the skills'.
            n_layers = _freeze_n_bottom_layers(params)
            if n_layers > 0:
                z_threshold = _get_layer_z_threshold(struct, n_layers)
                request_data["fixed_z_below"] = z_threshold
                for idx, site in enumerate(struct):
                    if site.coords[2] < z_threshold:
                        frozen_set.add(idx)

        # Apply invert: freeze everything EXCEPT the selected atoms
        if freeze_mode not in ("none", "layers", "bottom") and params.get("freeze_invert"):
            frozen_set = set(range(n_atoms)) - frozen_set

        if frozen_set:
            request_data["fixed_indices"] = sorted(frozen_set)
            # Apply selective dynamics directly to struct so Poscar writes T/F flags
            sd = [[False, False, False] if i in frozen_set else [True, True, True]
                  for i in range(n_atoms)]
            struct.add_site_property("selective_dynamics", sd)
            logger.info("[FREEZE] Applied selective_dynamics to struct: %d frozen, %d free",
                       len(frozen_set), n_atoms - len(frozen_set))
        elif freeze_mode != "none":
            logger.warning("[FREEZE] freeze_mode=%s but frozen_set is EMPTY! n_atoms=%d",
                          freeze_mode, n_atoms)

    # Handle electronic analysis params
    if node_type == "electronic":
        analysis_types = str(params.get("analysis", "dos")).split(",")
        if "dos" in analysis_types:
            request_data["calculation_type"] = VASPCalculationType.DOS
            request_data.setdefault("nedos", 3001)
        if "bader" in analysis_types:
            request_data["calculation_type"] = VASPCalculationType.BADER

    # Handle VASP MD
    if node_type == "vasp_md":
        request_data["ibrion"] = 0
        request_data["nsw"] = params.get("NSW", 5000)
        request_data.setdefault("custom_incar", {})
        request_data["custom_incar"]["SMASS"] = params.get("SMASS", 0)
        request_data["custom_incar"]["TEBEG"] = params.get("TEBEG", 300)
        request_data["custom_incar"]["ISYM"] = 0
        # Constant-potential overlay for MD equilibration
        cp_method = params.get("constant_potential", "none")
        if cp_method and cp_method != "none":
            request_data["constant_potential"] = cp_method
            if cp_method == "tpot":
                if params.get("tpot_vtarget") is not None:
                    request_data["tpot_vtarget"] = float(params["tpot_vtarget"])
                if params.get("tpot_electstep") is not None:
                    request_data["tpot_electstep"] = float(params["tpot_electstep"])
            elif cp_method == "cpvasp":
                if params.get("cpvasp_targetmu") is not None:
                    request_data["cpvasp_targetmu"] = float(params["cpvasp_targetmu"])
                if params.get("cpvasp_nescheme") is not None:
                    request_data["cpvasp_nescheme"] = int(params["cpvasp_nescheme"])
        # Slab settings for MD
        if params.get("LDIPOL"):
            request_data["custom_incar"]["LDIPOL"] = True
            request_data["custom_incar"]["IDIPOL"] = 3
        frozen_layers = params.get("frozen_layers", 0)
        if frozen_layers and int(frozen_layers) > 0:
            request_data["fixed_z_below"] = _get_layer_z_threshold(
                struct, int(frozen_layers)
            )

    # Handle Slow-Growth AIMD
    if node_type == "slow_growth":
        request_data["calculation_type"] = VASPCalculationType.SLOW_GROWTH
        request_data["ibrion"] = 0
        request_data["nsw"] = params.get("NSW", 10000)
        request_data.setdefault("custom_incar", {})
        request_data["custom_incar"]["SMASS"] = params.get("SMASS", 0)
        request_data["custom_incar"]["TEBEG"] = params.get("TEBEG", 300)
        request_data["custom_incar"]["TEEND"] = params.get("TEBEG", 300)
        request_data["custom_incar"]["ISYM"] = 0
        # LBLUEOUT and INCREM for REPORT file generation
        if params.get("lblueout", True):
            request_data["lblueout"] = True
        increm = params.get("increm", "-0.005")
        if increm:
            request_data["custom_incar"]["INCREM"] = str(increm)
        # ICONST content for constraint definition
        iconst_content = params.get("iconst_content", "")
        if iconst_content and str(iconst_content).strip():
            request_data["iconst_content"] = str(iconst_content).strip()
        # Constant-potential overlay
        cp_method = params.get("constant_potential", "none")
        if cp_method and cp_method != "none":
            request_data["constant_potential"] = cp_method
            if cp_method == "tpot":
                if params.get("tpot_vtarget") is not None:
                    request_data["tpot_vtarget"] = float(params["tpot_vtarget"])
                if params.get("tpot_fermi") is not None:
                    request_data["tpot_fermi"] = float(params["tpot_fermi"])
                if params.get("tpot_electstep") is not None:
                    request_data["tpot_electstep"] = float(params["tpot_electstep"])
            elif cp_method == "cpvasp":
                if params.get("cpvasp_targetmu") is not None:
                    request_data["cpvasp_targetmu"] = float(params["cpvasp_targetmu"])
                if params.get("cpvasp_nescheme") is not None:
                    request_data["cpvasp_nescheme"] = int(params["cpvasp_nescheme"])
        # Slab settings for slow-growth (dipole correction, frozen layers)
        if params.get("LDIPOL"):
            request_data["custom_incar"]["LDIPOL"] = True
            request_data["custom_incar"]["IDIPOL"] = 3
        frozen_layers = params.get("frozen_layers", 0)
        if frozen_layers and int(frozen_layers) > 0:
            request_data["fixed_z_below"] = _get_layer_z_threshold(
                struct, int(frozen_layers)
            )

    # Check for user-provided custom INCAR/KPOINTS text (from frontend editor)
    custom_incar = params.get("custom_incar_text")
    custom_kpoints = params.get("custom_kpoints_text")

    if custom_incar:
        incar_str = custom_incar
        kpoints_str_out = custom_kpoints or ""
        logger.info("Using custom INCAR text (user override) for %s", work_dir)
    else:
        # Build the request and generate from params
        request = VASPInputRequest(**request_data)
        incar_str = str(generate_incar(request, struct))
        kpoints_str_out = str(generate_kpoints(request, struct))

    # Sanitize selective_dynamics: if only some sites have the property,
    # pymatgen's Poscar.get_string() will crash iterating over None entries.
    # Ensure ALL sites have it (default [True,True,True] = free to move)
    # or NONE do (remove the property entirely).
    sd = struct.site_properties.get("selective_dynamics")
    if sd is not None:
        n_sites = len(struct)
        if len(sd) != n_sites or any(v is None for v in sd):
            # Rebuild with proper defaults
            sd_full = []
            for i in range(n_sites):
                if i < len(sd) and sd[i] is not None:
                    sd_full.append(list(sd[i]))
                else:
                    sd_full.append([True, True, True])
            struct.remove_site_property("selective_dynamics")
            struct.add_site_property("selective_dynamics", sd_full)

    # ── Pseudo-hydrogen handling ──
    # Pseudo-H atoms have per-site property "pseudo_h_potcar" (e.g. "H.50", "H.75")
    # and need distinct element labels in POSCAR so VASP uses the correct POTCAR.
    # NOTE: struct.site_properties only returns keys present on ALL sites.
    # Pseudo-H properties only exist on pseudo-H sites, so we must check per-site.
    pseudo_h_potcars: dict[str, str] = {}  # label → potcar dir name
    for i, site in enumerate(struct):
        potcar_name = site.properties.get("pseudo_h_potcar") if site.properties else None
        if not potcar_name:
            # Also check label — pseudo_hydrogen.py sets site.label = potcar_name
            lbl = getattr(site, "label", None) or ""
            if lbl.startswith("H") and "." in lbl and str(site.specie) == "H":
                potcar_name = lbl
        if potcar_name and potcar_name != "H" and str(site.specie) == "H":
            pseudo_h_potcars[potcar_name] = potcar_name
            struct[i].label = potcar_name
    if pseudo_h_potcars:
        logger.info("Detected %d pseudo-H types: %s", len(pseudo_h_potcars), list(pseudo_h_potcars.keys()))

    # Optionally sort structure by element (user toggle).
    # When pseudo-H present, use custom sort to keep pseudo-H grouped at end
    # (pymatgen sort treats all H equally, mixing regular H and pseudo-H).
    if pseudo_h_potcars:
        # Sort: non-H elements alphabetically, then regular H, then pseudo-H grouped by potcar
        def _sort_key(site):
            s = str(site.specie)
            lbl = getattr(site, "label", s) or s
            if lbl in pseudo_h_potcars:
                return (2, lbl, site.frac_coords[2])
            elif s == "H":
                return (1, "H", site.frac_coords[2])
            else:
                return (0, s, site.frac_coords[2])
        indices = sorted(range(len(struct)), key=lambda i: _sort_key(struct[i]))
        from pymatgen.core import Structure as PmgStructure
        sorted_sites = [struct[i] for i in indices]
        struct = PmgStructure.from_sites(sorted_sites)
    elif params.get("sort_structure"):
        struct = struct.get_sorted_structure()
    poscar = Poscar(struct, sort_structure=False)

    # Compute final POSCAR content (handle pseudo-H species relabeling)
    poscar_str = str(poscar)
    if pseudo_h_potcars:
        species_labels: list[str] = []
        for site in struct:
            lbl = getattr(site, "label", None) or str(site.specie)
            species_labels.append(lbl)
        grouped: list[str] = []
        counts: list[int] = []
        for lbl in species_labels:
            if grouped and grouped[-1] == lbl:
                counts[-1] += 1
            else:
                grouped.append(lbl)
                counts.append(1)
        lines = poscar_str.splitlines()
        if len(lines) >= 7:
            lines[5] = "  ".join(grouped)
            lines[6] = "  ".join(str(c) for c in counts)
            poscar_str = "\n".join(lines) + "\n"

    input_files = {
        "INCAR": incar_str,
        "KPOINTS": kpoints_str_out,
        "POSCAR": poscar_str,
    }

    if params.get("double_relax") and node_type in ("vasp_relax", "bulk_opt"):
        input_files["run_vasp.sh"] = (
            "#!/bin/bash\n"
            "# Double relaxation (atomate2 DoubleRelaxMaker pattern)\n"
            "echo '=== Relaxation 1 ==='\n"
            "mpirun -np $SLURM_NTASKS vasp_std\n"
            "if [ $? -ne 0 ]; then echo 'Relaxation 1 failed'; exit 1; fi\n"
            "cp CONTCAR POSCAR\n"
            "# Archive first run outputs\n"
            "for f in OUTCAR OSZICAR vasprun.xml; do [ -f $f ] && cp $f ${f}.relax1; done\n"
            "echo '=== Relaxation 2 ==='\n"
            "mpirun -np $SLURM_NTASKS vasp_std\n"
        )

    # Add ICONST for slow-growth calculations
    iconst = params.get("iconst_content", "")
    if iconst and str(iconst).strip():
        input_files["ICONST"] = str(iconst).strip() + "\n"

    return input_files, poscar, pseudo_h_potcars


async def generate_potcar_from_poscar(
    hpc: Any,
    work_dir: str,
    poscar: Any,
    config: Any,
    session_id: str,
    pseudo_h_potcars: dict[str, str] | None = None,
):
    """Generate POTCAR on HPC, element order taken directly from the Poscar object."""
    potcar_root, potcar_functional = _resolve_potcar_info(config, session_id)
    if not potcar_root:
        logger.warning("No potcar_root configured for session %s, skipping POTCAR!", session_id)
        return

    # If pseudo-H rewrote the POSCAR, read species from the rewritten file
    if pseudo_h_potcars:
        # Read species line from the POSCAR we wrote (line 6, 0-indexed line 5)
        result = await hpc.conn.run(f"sed -n '6p' {shlex.quote(work_dir)}/POSCAR", check=False)
        elements = (result.stdout or "").strip().split()
    else:
        # Get species blocks in exact POSCAR order (including duplicates for
        # non-contiguous elements, e.g. Mo Ti Mo Ti Mo S Hf N -> 8 POTCAR entries)
        elements = []
        prev = None
        for sym in poscar.site_symbols:
            if sym != prev:
                elements.append(sym)
                prev = sym

    potcar_dir = f"{potcar_root}/{potcar_functional}"
    parts = []
    for el in elements:
        # Pseudo-H labels map directly to POTCAR directory names (e.g. "H.50" → H.50/POTCAR)
        if pseudo_h_potcars and el in pseudo_h_potcars:
            variant = pseudo_h_potcars[el]
        else:
            variant = RECOMMENDED_POTCAR.get(el, el)
        parts.append(shlex.quote(f"{potcar_dir}/{variant}/POTCAR"))

    if not parts:
        return

    cat_cmd = f"cat {' '.join(parts)} > {shlex.quote(work_dir)}/POTCAR"
    logger.info("POTCAR command: %s (elements: %s)", cat_cmd, elements)
    result = await hpc.conn.run(cat_cmd, check=False)
    if result.exit_status != 0:
        stderr = (result.stderr or "").strip()
        logger.warning(
            "POTCAR generation failed for %s: %s. Elements: %s",
            work_dir, stderr, elements,
        )
        if "No such file" in stderr:
            logger.warning(
                "Check that potcar_root=%s/%s contains directories: %s",
                potcar_root, potcar_functional,
                ", ".join(RECOMMENDED_POTCAR.get(el, el) for el in elements),
            )
    else:
        logger.info("Generated POTCAR for %s with elements: %s", work_dir, elements)


async def generate_potcar(
    hpc: Any,
    work_dir: str,
    structure_str: Optional[str],
    config: Any,
    session_id: str,
):
    """Generate POTCAR on HPC by concatenating element POTCARs from potcar_root.

    Uses the recommended POTCAR variants from Materials Project standards.
    Elements are ordered to match POSCAR (unique elements in order of appearance).
    """
    potcar_root, potcar_functional = _resolve_potcar_info(config, session_id)
    if not potcar_root:
        logger.info("No potcar_root configured for session %s, skipping POTCAR generation", session_id)
        return

    # Parse structure to get element order (must match POSCAR)
    from pymatgen.core import Structure

    if not structure_str:
        return

    try:
        struct = Structure.from_str(structure_str, fmt="poscar")
    except Exception:
        struct = Structure.from_dict(json.loads(structure_str))

    # Get species blocks in exact POSCAR order (including duplicates)
    from pymatgen.io.vasp import Poscar
    poscar = Poscar(struct)
    elements: list[str] = []
    prev = None
    for sym in poscar.site_symbols:
        if sym != prev:
            elements.append(sym)
            prev = sym

    # Build cat command to concatenate POTCARs
    potcar_dir = f"{potcar_root}/{potcar_functional}"
    parts = []
    for el in elements:
        variant = RECOMMENDED_POTCAR.get(el, el)
        parts.append(shlex.quote(f"{potcar_dir}/{variant}/POTCAR"))

    if not parts:
        return

    cat_cmd = f"cat {' '.join(parts)} > {shlex.quote(work_dir)}/POTCAR"
    result = await hpc.conn.run(cat_cmd, check=False)
    if result.exit_status != 0:
        stderr = (result.stderr or "").strip()
        logger.warning(
            "POTCAR generation failed for %s: %s. Elements: %s",
            work_dir, stderr, elements,
        )
        # Try to provide helpful error
        if "No such file" in stderr:
            logger.warning(
                "Check that potcar_root=%s/%s contains directories: %s",
                potcar_root, potcar_functional,
                ", ".join(RECOMMENDED_POTCAR.get(el, el) for el in elements),
            )
    else:
        logger.info("Generated POTCAR for %s with elements: %s", work_dir, elements)

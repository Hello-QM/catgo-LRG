"""Local node execution for workflow engine.

Handles nodes that don't need HPC submission: structure_input, slab_gen,
adsorbate_place, condition, loop, merge, analysis, export_data, etc.
"""

import json
import logging
import os
from typing import Any

import httpx

from catgo.models.workflow import StepStatus

logger = logging.getLogger(__name__)

__all__ = [
    "execute_local_node",
]


def _get_api_base() -> str:
    port = int(os.environ.get("SERVER_PORT", 0)) or 8000
    return f"http://localhost:{port}/api"


async def execute_local_node(
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
    """Handle nodes that don't need HPC submission.

    Called by both V1 tool_bridge (step exists in workflow_steps table) and
    V2 scanner (task exists only in V2 tasks table). The update_step wrapper
    handles both cases — V2 tasks won't exist in the V1 table, and that's
    expected. The V2 scanner's bridge methods handle all V2 DB writes.
    """
    from catgo.utils.workflow_db import update_step as _v1_update_step

    def update_step(wf_id: str, s_id: str, data: dict) -> None:
        """Update V1 workflow_steps table. No-op for V2-only tasks."""
        try:
            _v1_update_step(wf_id, s_id, data)
        except KeyError:
            pass  # V2 engine: scanner bridge handles status via WorkflowDB

    try:
        if node_type == "structure_input":
            # Structure already stored in config -- just pass through
            structure_json = params.get("structure_json", "")
            step_results[step_id] = {"structure_json": structure_json}
            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps({"structure_json": structure_json}),
            })

        elif node_type == "structure_list_input":
            # Multiple structures stored as JSON list in params
            structures_json = params.get("structures_json", "[]")
            structures = json.loads(structures_json)
            result = {"structures": structures, "count": len(structures)}
            step_results[step_id] = result
            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps(result),
            })

        elif node_type == "condition":
            # Evaluate condition against parent results
            parent_ids = _get_parent_step_ids_fn(step_id, edges)
            parent_results = [step_results.get(pid, {}) for pid in parent_ids]
            check_type = params.get("check_type", "converged")
            operator = params.get("operator", "lt")
            threshold = float(params.get("threshold", 0.01))

            # Extract the value to check
            if check_type == "energy_diff" and len(parent_results) >= 2:
                e1 = parent_results[0].get("final_energy") or parent_results[0].get("summary", {}).get("energy_eh", 0)
                e2 = parent_results[1].get("final_energy") or parent_results[1].get("summary", {}).get("energy_eh", 0)
                value = abs(float(e1 or 0) - float(e2 or 0))
            elif check_type == "max_force":
                parent = parent_results[0] if parent_results else {}
                value = parent.get("max_force") or parent.get("summary", {}).get("max_force", 0)
            elif check_type == "converged":
                parent = parent_results[0] if parent_results else {}
                value = 1.0 if parent.get("converged", False) else 0.0
                threshold = 0.5
                operator = "gt"
            elif check_type == "n_steps":
                parent = parent_results[0] if parent_results else {}
                value = parent.get("n_steps") or parent.get("summary", {}).get("n_steps", 0)
            else:
                value = 0

            # Compare value against threshold
            ops = {
                "lt": lambda a, b: a < b,
                "gt": lambda a, b: a > b,
                "eq": lambda a, b: abs(a - b) < 1e-10,
                "lte": lambda a, b: a <= b,
                "gte": lambda a, b: a >= b,
            }
            condition_met = ops.get(operator, ops["lt"])(float(value), threshold)

            step_results[step_id] = {
                "condition_met": condition_met,
                "check_type": check_type,
                "value": float(value),
                "threshold": threshold,
                "operator": operator,
            }
            # Pass through parent structure to downstream
            for pid in parent_ids:
                if "structure" in step_results.get(pid, {}):
                    step_results[step_id]["structure"] = step_results[pid]["structure"]
                    break
                if "structure_json" in step_results.get(pid, {}):
                    step_results[step_id]["structure_json"] = step_results[pid]["structure_json"]
                    break

            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps(step_results[step_id]),
            })
            logger.info(
                "condition node %s: check_type=%s, value=%s %s %s → %s",
                step_id, check_type, value, operator, threshold, condition_met,
            )

        elif node_type == "loop":
            parent_ids = _get_parent_step_ids_fn(step_id, edges)
            loop_type = params.get("loop_type", "structures")
            parent = step_results.get(parent_ids[0], {}) if parent_ids else {}

            if loop_type == "structures":
                structures = parent.get("structures", [])
                if not structures and parent.get("structure"):
                    structures = [parent["structure"]]
                if not structures and parent.get("structure_json"):
                    structures = [parent["structure_json"]]
                # Always bridge a scalar structure_json (first structure) so a
                # downstream single-structure consumer (e.g. geo_opt with only one
                # iteration) can find an input. The _fan_out batch path uses the
                # `structures` list; the single path uses structure_json. Without
                # this, a loop over 1 structure produced only `structures` (which
                # the single MLP consumer never reads) → "No input structure".
                first_struct = structures[0] if structures else None
                if isinstance(first_struct, dict):
                    first_json = json.dumps(first_struct)
                else:
                    first_json = first_struct
                step_results[step_id] = {
                    "structures": structures,
                    "_fan_out": True,
                    "n_iterations": len(structures),
                    **({"structure_json": first_json} if first_json else {}),
                }
            elif loop_type == "parameters":
                step_results[step_id] = {
                    "structure": parent.get("structure"),
                    "structure_json": parent.get("structure_json"),
                    "n_iterations": params.get("max_iterations", 10),
                }
            else:
                step_results[step_id] = {"structure": parent.get("structure")}

            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps({
                    "loop_type": loop_type,
                    "n_iterations": step_results[step_id].get("n_iterations", 0),
                    "_fan_out": step_results[step_id].get("_fan_out", False),
                }),
            })
            logger.info("loop node %s: type=%s, iterations=%s", step_id, loop_type,
                        step_results[step_id].get("n_iterations", 0))

        elif node_type == "merge":
            parent_ids = _get_parent_step_ids_fn(step_id, edges)
            merged_structures = []
            merged_energies = []
            for pid in parent_ids:
                parent = step_results.get(pid, {})
                if parent.get("structures"):
                    merged_structures.extend(parent["structures"])
                elif parent.get("structure"):
                    merged_structures.append(parent["structure"])
                elif parent.get("structure_json"):
                    merged_structures.append(parent["structure_json"])
                energy = parent.get("final_energy") or parent.get("summary", {}).get("energy_eh")
                if energy is not None:
                    merged_energies.append({"step_id": pid, "energy": float(energy)})

            step_results[step_id] = {
                "structures": merged_structures,
                "energies": merged_energies,
                "n_merged": len(merged_structures),
            }
            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps({
                    "n_merged": len(merged_structures),
                    "n_energies": len(merged_energies),
                }),
            })
            logger.info("merge node %s: merged %d structures, %d energies",
                        step_id, len(merged_structures), len(merged_energies))

        elif node_type == "export_data":
            parent_ids = _get_parent_step_ids_fn(step_id, edges)
            export_format = params.get("format", "json")
            parent = step_results.get(parent_ids[0], {}) if parent_ids else {}

            export_result: dict[str, Any] = {"exported": True, "format": export_format}

            if export_format == "json":
                export_result["data"] = json.dumps(parent, default=str)
            elif export_format == "csv":
                entries = parent.get("entries") or parent.get("summary", {}).get("entries", [])
                if entries:
                    header = ",".join(str(k) for k in entries[0].keys())
                    rows = [",".join(str(v) for v in e.values()) for e in entries]
                    export_result["data"] = header + "\n" + "\n".join(rows)
                else:
                    export_result["data"] = ""
                    export_result["note"] = "No tabular entries found in parent results"
            elif export_format in ("cif", "poscar"):
                structure = parent.get("structure") or parent.get("structure_json")
                if structure:
                    export_result["structure"] = structure
                else:
                    export_result["exported"] = False
                    export_result["error"] = "No structure found in parent results"
            else:
                export_result["exported"] = False
                export_result["error"] = f"Unsupported export format: {export_format}"

            step_results[step_id] = export_result
            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps({
                    "exported": export_result.get("exported", False),
                    "format": export_format,
                }),
            })
            logger.info("export_data node %s: format=%s, exported=%s",
                        step_id, export_format, export_result.get("exported", False))

        elif node_type == "slab_gen":
            # Slab generation: prefer pre-generated structure_json from frontend WASM.
            # If missing (e.g. workflow created via MCP without frontend preview),
            # fall back to pymatgen with correct layer-based sizing.
            structure_json = params.get("structure_json", "")
            slabs: list = []  # populated by pymatgen fallback if multiple terminations
            if not structure_json:
                # Get parent structure
                parent_ids = _get_parent_step_ids_fn(step_id, edges)
                parent_structure = None
                for pid in parent_ids:
                    if pid in step_results and step_results[pid].get("structure_json"):
                        parent_structure = step_results[pid]["structure_json"]
                        break

                if parent_structure:
                    try:
                        from pymatgen.core import Structure as PmgStructure
                        from pymatgen.core.surface import SlabGenerator

                        if isinstance(parent_structure, str):
                            struct_dict = json.loads(parent_structure)
                        else:
                            struct_dict = parent_structure
                        bulk = PmgStructure.from_dict(struct_dict)

                        # Parse miller indices from "1,1,0" format
                        miller_str = str(params.get("miller", "1,1,1"))
                        miller = tuple(int(x) for x in miller_str.replace(" ", "").split(","))
                        num_layers = int(params.get("layers", 4))
                        vacuum = float(params.get("vacuum", 15.0))

                        # Convert layer count to approximate slab thickness:
                        # Use the c-lattice parameter / number of layers in unit cell as layer spacing.
                        # This avoids the bug where layers=4 was interpreted as 4 Angstroms.
                        c_param = bulk.lattice.c
                        n_layers_in_cell = max(1, len(set(round(s.frac_coords[2], 4) for s in bulk)))
                        layer_spacing = c_param / n_layers_in_cell
                        min_slab_size = num_layers * layer_spacing

                        gen = SlabGenerator(
                            bulk, miller, min_slab_size=min_slab_size,
                            min_vacuum_size=vacuum, center_slab=True,
                        )
                        slabs = gen.get_slabs()
                        if slabs:
                            # Apply supercell to each slab if specified
                            sa = int(params.get("supercell_a", 1))
                            sb = int(params.get("supercell_b", 1))
                            # Backward compat: old "supercell" string param (e.g. "2×2")
                            if sa == 1 and sb == 1 and params.get("supercell"):
                                sc_str = str(params["supercell"]).replace("\u00d7", "x")
                                sc_parts = sc_str.lower().split("x")
                                if len(sc_parts) >= 2:
                                    sa, sb = int(sc_parts[0]), int(sc_parts[1])
                            for slab in slabs:
                                if sa > 1 or sb > 1:
                                    slab.make_supercell([[sa, 0, 0], [0, sb, 0], [0, 0, 1]])

                            # Use the first slab as the primary structure_json
                            structure_json = json.dumps(slabs[0].as_dict())
                            logger.info(
                                "slab_gen: generated %d slab(s) via pymatgen fallback, primary has %d sites",
                                len(slabs), len(slabs[0]),
                            )
                        else:
                            slabs = []
                            logger.warning("slab_gen: SlabGenerator returned no slabs for miller=%s", miller)
                    except Exception as e:
                        slabs = []
                        logger.warning("slab_gen pymatgen fallback failed: %s", e)

            # If multiple slabs were generated, mark as fan-out for downstream batch execution
            is_fan_out = len(slabs) > 1
            if is_fan_out:
                all_slab_dicts = [s.as_dict() for s in slabs]
                step_results[step_id] = {
                    "structure_json": structure_json,
                    "structures": all_slab_dicts,
                    "_fan_out": True,
                }
                logger.info(
                    "slab_gen: fan-out enabled with %d slab terminations",
                    len(all_slab_dicts),
                )
            else:
                step_results[step_id] = {"structure_json": structure_json}

            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps({
                    "note": "Slab generated" if structure_json else "No slab structure available",
                    "has_structure": bool(structure_json),
                    "_fan_out": is_fan_out,
                    "n_slabs": len(slabs) if slabs else (1 if structure_json else 0),
                }),
            })

        elif node_type == "adsorbate_place":
            # Priority 1: pre-configured structure_json from interactive UI
            structure_json = params.get("structure_json", "")
            if not structure_json:
                # --- Pymatgen fallback ---
                parent_ids = _get_parent_step_ids_fn(step_id, edges)
                parent_structure = None
                for pid in parent_ids:
                    if pid in step_results:
                        pr = step_results[pid]
                        if pr.get("structure_json"):
                            parent_structure = pr["structure_json"]
                            break
                        if pr.get("structure"):
                            parent_structure = pr["structure"]
                            break

                if parent_structure:
                    try:
                        if isinstance(parent_structure, str):
                            struct_dict = json.loads(parent_structure)
                        else:
                            struct_dict = parent_structure

                        species = params.get("species", "OH")
                        height = float(params.get("height", 2.0))
                        site_strategy = params.get("_site_strategy", "")

                        # --- Manual position: append saved Cartesian adsorbate atoms ---
                        manual_cart = params.get("_manual_adsorbate_cart", [])
                        if site_strategy == "manual_position" and manual_cart:
                            from pymatgen.core import Structure as PmgStructure, Element as PmgElement
                            from pymatgen.core.surface import Slab as PmgSlab
                            import numpy as np

                            # Preserve Slab type if present (needed by AdsorbateSiteFinder)
                            if struct_dict.get("@class") == "Slab":
                                slab = PmgSlab.from_dict(struct_dict)
                            else:
                                slab = PmgStructure.from_dict(struct_dict)

                            # Get surface normal from params (default: z-up)
                            manual_normal = params.get("_manual_normal", [0, 0, 1])
                            n_vec = np.array(manual_normal, dtype=float)
                            n_len = np.linalg.norm(n_vec)
                            normal = n_vec / n_len if n_len > 1e-9 else np.array([0.0, 0.0, 1.0])

                            # Extract atom symbols and positions
                            elems = [a["symbol"] for a in manual_cart]
                            ads_positions = [np.array(a["position"], dtype=float) for a in manual_cart]

                            # Overlap check: push up along surface normal
                            OVERLAP_FACTOR = 0.7
                            NUDGE_STEP = 0.2
                            MAX_NUDGES = 20
                            for _ in range(MAX_NUDGES):
                                overlap = False
                                for ae, ap in zip(elems, ads_positions):
                                    try:
                                        r_ads = PmgElement(ae).atomic_radius.real if PmgElement(ae).atomic_radius else 1.5
                                    except Exception:
                                        r_ads = 1.5
                                    for ss in slab:
                                        d = np.linalg.norm(ap - ss.coords)
                                        try:
                                            r_slab = ss.specie.atomic_radius.real if ss.specie.atomic_radius else 1.5
                                        except Exception:
                                            r_slab = 1.5
                                        if d < (r_ads + r_slab) * OVERLAP_FACTOR:
                                            overlap = True
                                            break
                                    if overlap:
                                        break
                                if not overlap:
                                    break
                                ads_positions = [p + NUDGE_STEP * normal for p in ads_positions]

                            new_slab = slab.copy()
                            for elem, cart in zip(elems, ads_positions):
                                new_slab.append(elem, cart, coords_are_cartesian=True)
                            structure_json = json.dumps(new_slab.as_dict())
                            logger.info(
                                "adsorbate_place: appended %d manual Cartesian atoms",
                                len(elems),
                            )
                        else:
                            # Delegate to catgo.workflow.builtins_impl.run_adsorbate_place,
                            # which uses the ferrox site finder + CatGo placement engine
                            # (same algorithm as the 3D viewer). The previous import
                            # `from workflow.engines.batch_adsorbate import _place_adsorbate`
                            # pointed at a module that doesn't exist in this repo —
                            # the call always raised ImportError, the surrounding
                            # try/except swallowed it, and the node "completed"
                            # without an adsorbate, which is exactly the bug CatBot
                            # users were hitting.
                            from catgo.workflow.builtins_impl import run_adsorbate_place

                            site = params.get("site", "all")
                            if species == "custom":
                                custom_xyz = params.get("custom_xyz", "")
                                if custom_xyz:
                                    from pymatgen.core import Molecule, Structure as PmgStructure
                                    from pymatgen.analysis.adsorption import AdsorbateSiteFinder
                                    elements, coords = [], []
                                    for line in custom_xyz.strip().splitlines():
                                        parts = line.split()
                                        if len(parts) >= 4:
                                            elements.append(parts[0])
                                            coords.append([float(parts[1]), float(parts[2]), float(parts[3])])
                                    if elements:
                                        from pymatgen.core.surface import Slab as _Slab
                                        if struct_dict.get("@class") == "Slab":
                                            slab = _Slab.from_dict(struct_dict)
                                        else:
                                            _s = PmgStructure.from_dict(struct_dict)
                                            slab = _Slab(_s.lattice, _s.species, _s.frac_coords,
                                                         miller_index=(0,0,1), oriented_unit_cell=_s,
                                                         shift=0, scale_factor=[[1,0,0],[0,1,0],[0,0,1]])
                                        asf = AdsorbateSiteFinder(slab)
                                        placed = asf.generate_adsorption_structures(
                                            Molecule(elements, coords), repeat=[1, 1, 1], height=height,
                                        )
                                        if placed:
                                            structure_json = json.dumps(placed[0].as_dict())
                            else:
                                # site_index left as None → pick the site closest
                                # to the slab xy centroid (the default a user
                                # expects for an auto-generated workflow).
                                result = run_adsorbate_place(
                                    struct_dict, species=species, site=site, height=height,
                                )
                                structure_json = result["structure"]

                            if structure_json:
                                logger.info(
                                    "adsorbate_place: placed %s via run_adsorbate_place (site=%s, height=%.1f)",
                                    species, site, height,
                                )
                    except Exception as e:
                        logger.warning("adsorbate_place pymatgen fallback failed: %s", e)

            if structure_json:
                step_results[step_id] = {"structure_json": structure_json, "structure": json.loads(structure_json)}
                update_step(workflow_id, step_id, {
                    "status": StepStatus.COMPLETED.value,
                    "result_json": json.dumps({"source": "pre_configured"}),
                })
            else:
                # Priority 2: auto-place using parent structure + node params
                parent_ids = _get_parent_step_ids_fn(step_id, edges)
                parent = step_results.get(parent_ids[0], {}) if parent_ids else {}

                # Check for multi-structure input (fan-out from slab_gen, doping_gen, etc.)
                parent_structures_list = None
                if parent.get("_fan_out") and parent.get("structures"):
                    parent_structures_list = parent["structures"]
                elif parent.get("structures_json"):
                    sjs = parent["structures_json"]
                    if isinstance(sjs, str):
                        try: parent_structures_list = json.loads(sjs)
                        except Exception: pass
                    elif isinstance(sjs, list):
                        parent_structures_list = [json.loads(s) if isinstance(s, str) else s for s in sjs]

                parent_struct = parent.get("structure")
                if not parent_struct:
                    sj = parent.get("structure_json")
                    if sj:
                        parent_struct = json.loads(sj) if isinstance(sj, str) else sj
                if not parent_struct and not parent_structures_list:
                    raise RuntimeError(
                        "adsorbate_place: no parent structure and no pre-configured "
                        "structure_json. Connect to a slab node or configure manually."
                    )
                from catgo.workflow.builtins_impl import run_adsorbate_place
                species = params.get("species", "OH")
                site = params.get("site", "all")
                height = float(params.get("height", 2.0))

                def _place_one(struct_dict: dict) -> dict:
                    """Wrap run_adsorbate_place so the calling code keeps the
                    `list[dict]`-shape it had with the old _place_adsorbate.
                    site_index is left at its default (None) so the placement
                    lands on the site closest to the slab's xy centroid.
                    """
                    res = run_adsorbate_place(struct_dict, species=species, site=site, height=height)
                    return json.loads(res["structure"])

                # Multi-structure: place adsorbate on each input structure
                if parent_structures_list and len(parent_structures_list) > 1:
                    all_placed = []
                    for ps in parent_structures_list:
                        ps_dict = json.loads(ps) if isinstance(ps, str) else ps
                        try:
                            all_placed.append(_place_one(ps_dict))
                        except Exception as exc:
                            logger.warning("adsorbate_place: %s on a fan-out structure failed: %s — keeping original", species, exc)
                            all_placed.append(ps_dict)
                    if not all_placed:
                        raise RuntimeError(f"adsorbate_place: failed to place {species} on any structure.")
                    # Fan-out: primary is first, all are in structures list
                    primary_json = json.dumps(all_placed[0])
                    step_results[step_id] = {
                        "structure_json": primary_json,
                        "structure": all_placed[0],
                        "structures": all_placed,
                        "structures_json": json.dumps([json.dumps(s) for s in all_placed]),
                        "_fan_out": True,
                    }
                    update_step(workflow_id, step_id, {
                        "status": StepStatus.COMPLETED.value,
                        "result_json": json.dumps({"source": "auto_placed_multi", "species": species, "site": site, "count": len(all_placed)}),
                    })
                else:
                    target_struct = parent_struct or (parent_structures_list[0] if parent_structures_list else None)
                    if isinstance(target_struct, str):
                        target_struct = json.loads(target_struct)
                    try:
                        result_struct = _place_one(target_struct)
                    except Exception as exc:
                        raise RuntimeError(
                            f"adsorbate_place: failed to place {species} on parent structure "
                            f"(site={site}, height={height} Å): {exc}. "
                            "Try a different site type or check the slab structure."
                        ) from exc
                    result_json_str = json.dumps(result_struct)
                    step_results[step_id] = {"structure_json": result_json_str, "structure": result_struct}
                    update_step(workflow_id, step_id, {
                        "status": StepStatus.COMPLETED.value,
                        "result_json": json.dumps({"source": "auto_placed", "species": species, "site": site}),
                    })

        elif node_type == "doping_gen":
            # Get parent structure
            parent_ids = _get_parent_step_ids_fn(step_id, edges)
            parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
            structure = parent.get("structure")
            if not structure:
                structure_json_p = parent.get("structure_json")
                if structure_json_p:
                    structure = json.loads(structure_json_p) if isinstance(structure_json_p, str) else structure_json_p

            if not structure:
                raise RuntimeError("No structure from parent for doping")

            mode = params.get("mode", "simple")
            api_base = _get_api_base()

            async with httpx.AsyncClient(timeout=30) as client:
                if mode == "combinatorial" and params.get("groups"):
                    # Multi-group combinatorial doping via /build/substitution
                    groups_raw = params.get("groups", "[]")
                    groups = json.loads(groups_raw) if isinstance(groups_raw, str) else groups_raw
                    valid_groups = [
                        {
                            "target_element": g.get("target", ""),
                            "replacement_elements": g.get("replacements", []),
                        }
                        for g in groups if g.get("target") and g.get("replacements")
                    ]
                    if not valid_groups:
                        raise RuntimeError("Combinatorial mode requires at least one group with target element and replacement elements")
                    max_configs = int(params.get("combo_max_configs", params.get("max_configs", 50)))
                    resp = await client.post(f"{api_base}/build/substitution", json={
                        "structure": structure,
                        "groups": valid_groups,
                        "max_structures": max_configs,
                    })
                else:
                    # Simple single-dopant mode via /build/doping
                    dopant = params.get("dopant", "")
                    host_element = params.get("target_element", "")
                    count = int(params.get("count", 1))
                    enumerate_all = params.get("enumerate", False)
                    # Parse target_indices if provided (comma-separated string or list)
                    target_indices_raw = params.get("target_indices", "")
                    target_indices = None
                    if target_indices_raw:
                        if isinstance(target_indices_raw, str):
                            target_indices = [int(x.strip()) for x in target_indices_raw.split(",") if x.strip().isdigit()]
                        elif isinstance(target_indices_raw, list):
                            target_indices = [int(x) for x in target_indices_raw]
                    doping_payload: dict = {
                        "structure": structure,
                        "dopant": dopant,
                        "host_element": host_element,
                        "concentration": count,
                        "enumerate": enumerate_all,
                    }
                    if target_indices:
                        doping_payload["target_indices"] = target_indices
                    resp = await client.post(f"{api_base}/build/doping", json=doping_payload)

                if resp.status_code != 200:
                    raise RuntimeError(f"Doping failed: {resp.text}")

                result = resp.json()
                structures = result.get("structures", [])
                labels = result.get("labels", [])

                if len(structures) == 1:
                    step_results[step_id] = {
                        "structure": structures[0],
                        "label": labels[0] if labels else f"{host_element}->{dopant}",
                    }
                else:
                    # Multiple structures: set _fan_out for downstream batch/loop.
                    # Also bridge a scalar structure_json (first config) so a
                    # single-structure downstream consumer still has an input.
                    _first = structures[0] if structures else None
                    _first_json = json.dumps(_first) if isinstance(_first, dict) else _first
                    step_results[step_id] = {
                        "structures": structures,
                        "labels": labels,
                        "_fan_out": True,
                        "n_configs": len(structures),
                        **({"structure_json": _first_json} if _first_json else {}),
                    }

                update_step(workflow_id, step_id, {
                    "status": StepStatus.COMPLETED.value,
                    "result_json": json.dumps({
                        "mode": mode,
                        "n_configs": len(structures),
                        **({
                            "dopant": params.get("dopant", ""),
                            "host_element": params.get("target_element", ""),
                            "enumerate": params.get("enumerate", False),
                        } if mode == "simple" else {
                            "groups": params.get("groups", "[]"),
                        }),
                    }),
                })
                logger.info(
                    "doping_gen: mode=%s, %d config(s)",
                    mode, len(structures),
                )

        elif node_type in ("polymer_build", "polymer_crosslink", "glass_transition", "polymer_deform"):
            update_step(workflow_id, step_id, {
                "status": StepStatus.FAILED.value,
                "error_message": f"Node type '{node_type}' is not yet implemented in the workflow engine. "
                                 f"Use the LAMMPS build tools in the Structure viewer for polymer simulations.",
                "error_type": "input_error",
            })
            await _broadcast_fn(workflow_id, {
                "type": "step_status", "step_id": step_id,
                "status": "failed",
                "error": f"Node type '{node_type}' is not yet implemented",
            })
            return  # Don't fall through to the completion broadcast code

        elif node_type == "batch_slab_gen":
            # Batch slab generation: generate slabs for multiple (miller, layers) combos
            parent_ids = _get_parent_step_ids_fn(step_id, edges)
            parent_structure = None
            for pid in parent_ids:
                if pid in step_results:
                    pr = step_results[pid]
                    parent_structure = pr.get("structure_json") or pr.get("structure")
                    if parent_structure:
                        break

            if not parent_structure:
                raise RuntimeError(
                    "batch_slab_gen: no parent structure found. "
                    "Connect a Structure Input or Geo Opt node upstream."
                )

            # Parse combinations: JSON array of [h, k, l, layers] tuples
            combos_raw = params.get("combinations", "[]")
            if isinstance(combos_raw, str):
                combos = json.loads(combos_raw)
            else:
                combos = combos_raw

            if not combos:
                raise RuntimeError("batch_slab_gen: 'combinations' param is empty or missing.")

            vacuum = float(params.get("vacuum", 15.0))
            center_slab = params.get("center_slab", True)

            # Parse parent structure
            if isinstance(parent_structure, str):
                struct_dict = json.loads(parent_structure)
            else:
                struct_dict = parent_structure

            from pymatgen.core import Structure as PmgStructure
            from pymatgen.core.surface import SlabGenerator

            bulk = PmgStructure.from_dict(struct_dict)

            # Pre-compute layer spacing for converting layer count → thickness
            c_param = bulk.lattice.c
            n_layers_in_cell = max(1, len(set(round(s.frac_coords[2], 4) for s in bulk)))
            layer_spacing = c_param / n_layers_in_cell

            all_slabs: list[dict] = []
            labels: list[str] = []
            for combo in combos:
                if len(combo) < 4:
                    logger.warning("batch_slab_gen: skipping invalid combo %s (need [h,k,l,layers])", combo)
                    continue
                h, k, l, num_layers = int(combo[0]), int(combo[1]), int(combo[2]), int(combo[3])
                min_slab_size = num_layers * layer_spacing

                try:
                    gen = SlabGenerator(
                        bulk, (h, k, l),
                        min_slab_size=min_slab_size,
                        min_vacuum_size=vacuum,
                        center_slab=center_slab,
                    )
                    slabs = gen.get_slabs()
                    if slabs:
                        # Apply supercell if specified
                        sa = int(params.get("supercell_a", 1))
                        sb = int(params.get("supercell_b", 1))
                        if sa > 1 or sb > 1:
                            slabs[0].make_supercell([[sa, 0, 0], [0, sb, 0], [0, 0, 1]])
                        all_slabs.append(slabs[0].as_dict())
                        labels.append(f"({h}{k}{l})-{num_layers}L")
                    else:
                        logger.warning(
                            "batch_slab_gen: no slabs for miller=(%d,%d,%d) layers=%d",
                            h, k, l, num_layers,
                        )
                except Exception as e:
                    logger.warning(
                        "batch_slab_gen: failed for (%d,%d,%d)-%dL: %s",
                        h, k, l, num_layers, e,
                    )

            if not all_slabs:
                raise RuntimeError(
                    f"batch_slab_gen: SlabGenerator produced 0 slabs from {len(combos)} combinations."
                )

            step_results[step_id] = {
                "structures": all_slabs,
                "labels": labels,
                "_fan_out": True,
                "n_slabs": len(all_slabs),
                "structure_json": json.dumps(all_slabs[0]),
            }
            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps({
                    "_fan_out": True,
                    "n_slabs": len(all_slabs),
                    "labels": labels,
                }),
            })
            logger.info(
                "batch_slab_gen: generated %d slabs from %d combinations",
                len(all_slabs), len(combos),
            )

        elif node_type == "batch_coverage_gen":
            # Generate multiple slab+adsorbate structures at different coverages
            parent_ids = _get_parent_step_ids_fn(step_id, edges)
            parent_structure = None
            for pid in parent_ids:
                if pid in step_results:
                    pr = step_results[pid]
                    parent_structure = pr.get("structure_json") or pr.get("structure")
                    if parent_structure:
                        break

            if not parent_structure:
                raise RuntimeError(
                    "batch_coverage_gen: no parent structure found. "
                    "Connect a Structure Input or Slab Gen node upstream."
                )

            # Parse parent structure
            if isinstance(parent_structure, str):
                struct_dict = json.loads(parent_structure)
            else:
                struct_dict = parent_structure

            # Parse params
            species = params.get("species", "H")
            coverages_raw = params.get("coverages", "[1, 2, 3, 4]")
            if isinstance(coverages_raw, str):
                coverages = json.loads(coverages_raw)
            else:
                coverages = coverages_raw
            site = params.get("site", "ontop")
            n_surface_sites = int(params.get("n_surface_sites", 0))
            height = float(params.get("height", 1.8))

            if not coverages:
                raise RuntimeError("batch_coverage_gen: 'coverages' param is empty or missing.")

            from pymatgen.core import Structure as PmgStructure
            from pymatgen.analysis.adsorption import AdsorbateSiteFinder

            # Single source of truth: catgo.workflow.builtins_impl loads from
            # server/data/adsorbates.json (~70 species, kept in sync with the
            # frontend library). Importing here lets a Ni(111) coverage sweep
            # use, say, NH2NH2 or OCCO without us needing to duplicate the
            # molecule definitions in two places.
            from catgo.workflow.builtins_impl import _ADSORBATE_MOLECULES

            slab = PmgStructure.from_dict(struct_dict)
            asf = AdsorbateSiteFinder(slab)
            # symm_reduce=0 returns ALL sites, not just symmetry-unique ones.
            # Without this, a perfect 4×4 Ni(111) slab returns only 2 hollow sites
            # instead of 32 — making coverage sweeps impossible.
            sites_dict = asf.find_adsorption_sites(symm_reduce=0)

            # Select sites of the desired type
            available_sites = sites_dict.get(site, [])
            if not available_sites:
                # Fallback: try all site types
                for st in ("ontop", "bridge", "hollow"):
                    available_sites = sites_dict.get(st, [])
                    if available_sites:
                        logger.warning(
                            "batch_coverage_gen: site '%s' not found, using '%s' (%d sites)",
                            site, st, len(available_sites),
                        )
                        break
            if not available_sites:
                raise RuntimeError(
                    f"batch_coverage_gen: no adsorption sites found on slab (tried {site}, ontop, bridge, hollow)."
                )

            # Determine n_surface_sites if not set
            if n_surface_sites <= 0:
                n_surface_sites = len(available_sites)

            # Build adsorbate molecule
            mol_data = _ADSORBATE_MOLECULES.get(species.upper())
            if mol_data:
                mol_species, mol_coords = mol_data
            else:
                # Single atom fallback
                mol_species = [species]
                mol_coords = [[0, 0, 0]]

            import numpy as np

            all_structures: list[dict] = []
            labels: list[str] = []
            coverage_values: list[float] = []

            for n_ads in coverages:
                n_ads = int(n_ads)
                if n_ads <= 0:
                    continue
                if n_ads > len(available_sites):
                    logger.warning(
                        "batch_coverage_gen: requested %d adsorbates but only %d sites available, capping",
                        n_ads, len(available_sites),
                    )
                    n_ads = len(available_sites)

                # Start from clean slab copy
                modified_slab = slab.copy()

                # Place N adsorbates on the first N available sites
                for i in range(n_ads):
                    site_pos = np.array(available_sites[i])
                    for atom_idx, (el, coord) in enumerate(zip(mol_species, mol_coords)):
                        cart_pos = site_pos + np.array(coord) + np.array([0, 0, height])
                        modified_slab.append(el, cart_pos, coords_are_cartesian=True)

                all_structures.append(modified_slab.as_dict())
                theta = n_ads / n_surface_sites
                labels.append(f"{n_ads}{species.upper()}-{theta:.2f}ML")
                coverage_values.append(theta)

            if not all_structures:
                raise RuntimeError(
                    f"batch_coverage_gen: produced 0 structures from {len(coverages)} coverage values."
                )

            step_results[step_id] = {
                "structures": all_structures,
                "labels": labels,
                "coverages": coverage_values,
                "_fan_out": True,
                "n_structures": len(all_structures),
                "n_surface_sites": n_surface_sites,
                "structure_json": json.dumps(all_structures[0]),
            }
            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps({
                    "_fan_out": True,
                    "n_structures": len(all_structures),
                    "labels": labels,
                    "coverages": coverage_values,
                    "n_surface_sites": n_surface_sites,
                }),
            })
            logger.info(
                "batch_coverage_gen: generated %d structures for coverages %s",
                len(all_structures), coverages,
            )

        elif node_type == "gibbs_energy":
            # Compute Gibbs free energy from parent energy + frequencies
            from catgo.utils.gibbs_calculator import calc_adsorbed, calc_gas

            parent_ids = _get_parent_step_ids_fn(step_id, edges)
            # Get DFT energy and frequency data from parent nodes
            e_dft = None
            real_freqs_cm: list[float] = []
            imag_freqs_cm: list[float] = []
            freq_positions: list[list[float]] = []
            freq_masses: list[float] = []
            freq_atom_types: list[int] = []
            freq_free_indices: list[int] | None = None

            for pid in parent_ids:
                pr = step_results.get(pid, {})
                # Energy: check multiple common keys
                if e_dft is None:
                    e_val = pr.get("energy") or pr.get("final_energy")
                    if e_val is not None:
                        e_dft = float(e_val)
                # Frequencies: check real_freqs (from vasp_freq_parser) and frequencies (legacy)
                if not real_freqs_cm:
                    if pr.get("real_freqs"):
                        # vasp_freq_parser format: list of dicts with frequency_cm
                        real_freqs_cm = [float(f["frequency_cm"]) for f in pr["real_freqs"]]
                        imag_freqs_cm = [float(f["frequency_cm"]) for f in pr.get("imag_freqs", [])]
                        freq_positions = pr.get("positions", [])
                        freq_masses = pr.get("masses", [])
                        freq_atom_types = pr.get("atom_types", [])
                        freq_free_indices = pr.get("free_indices")
                    elif pr.get("frequencies"):
                        # Legacy format: plain list of floats (negative = imaginary)
                        for f in pr["frequencies"]:
                            f_val = float(f)
                            if f_val < 0:
                                imag_freqs_cm.append(abs(f_val))
                            else:
                                real_freqs_cm.append(f_val)

            if e_dft is None:
                step_results[step_id] = {"error": "No energy found from parent nodes"}
                update_step(workflow_id, step_id, {"status": StepStatus.FAILED.value, "error_message": "No energy from parent"})
                return

            phase = params.get("phase", "adsorbed")
            temperature = float(params.get("temperature", 298.15))
            freq_cutoff = float(params.get("freq_cutoff", 50))
            pressure_atm = float(params.get("pressure_atm", 1.0))
            n_unpaired = int(params.get("n_unpaired", 0))

            # Compute thermodynamic corrections using gibbs_calculator
            if phase == "gas" and freq_positions and freq_masses:
                gibbs_result = calc_gas(
                    real_freqs_cm, imag_freqs_cm,
                    freq_positions, freq_masses, freq_atom_types,
                    T=temperature, P=pressure_atm * 101325.0,
                    n_unpaired=n_unpaired,
                    free_indices=freq_free_indices,
                )
            else:
                gibbs_result = calc_adsorbed(
                    real_freqs_cm, imag_freqs_cm,
                    T=temperature, freq_cutoff=freq_cutoff,
                )

            zpe = gibbs_result["zpe_ev"]
            g_corr = gibbs_result["g_corr_ev"]
            h_corr = gibbs_result["h_corr_ev"]
            ts = h_corr - g_corr  # T*S = H_corr - G_corr
            g_total = e_dft + g_corr

            # Resolve system_name: own param > inherited from parent calc nodes > fallback
            system_name = params.get("system_name", "") or params.get("label", "")
            if not system_name:
                for pid in parent_ids:
                    pr = step_results.get(pid, {})
                    inherited = pr.get("system_name", "")
                    if inherited:
                        system_name = inherited
                        break
            if not system_name:
                system_name = step_id[:8]
            step_results[step_id] = {
                "gibbs": g_total,
                "system_name": system_name,
                "energy": e_dft,
                "zpe": zpe,
                "g_corr": g_corr,
                "h_corr": h_corr,
                "ts_correction": ts,
                "temperature": temperature,
                "phase": phase,
                "n_real_freqs": len(real_freqs_cm),
                "n_imag_freqs": len(imag_freqs_cm),
                "mode": gibbs_result.get("mode", phase),
                "gibbs_detail": gibbs_result,
            }
            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps(step_results[step_id]),
            })
            logger.info(
                "Gibbs energy: G=%.4f eV (E_DFT=%.4f, ZPE=%.4f, G_corr=%.4f, TS=%.4f, phase=%s, %d freqs)",
                g_total, e_dft, zpe, g_corr, ts, phase, len(real_freqs_cm),
            )

        else:
            # free_energy, reference_mol, etc.
            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
            })

        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "completed"
        })

    except Exception as e:
        logger.exception("Local node %s failed", step_id)
        update_step(workflow_id, step_id, {
            "status": StepStatus.FAILED.value,
            "error_message": str(e),
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id,
            "status": "failed", "error": str(e),
        })
        # Re-raise so the V2 task engine (scanner._execute_v1_local_task) marks
        # the task FAILED too. Without this the exception is swallowed here and
        # the V2 task is marked COMPLETED with no result — a silent false pass
        # (e.g. doping_gen API error reported as "completed", downstream then
        # dies with "No input structure"). Mirrors the mlp.py re-raise fix.
        raise

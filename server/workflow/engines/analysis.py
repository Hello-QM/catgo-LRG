"""Analysis node execution for workflow engine.

Handles DOS analysis, COHP analysis, MD analysis, convergence checks,
and energy comparisons.
"""

import json
import logging
import os
from typing import Any

import httpx

from catgo.models.workflow import StepStatus

logger = logging.getLogger(__name__)


def _get_api_base() -> str:
    port = int(os.environ.get("SERVER_PORT", 0)) or 8000
    return f"http://localhost:{port}/api"

__all__ = [
    "execute_analysis_node",
]


async def execute_analysis_node(
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
    """Execute an ANALYSIS node locally.

    ANALYSIS nodes read output data from parent steps and produce
    analysis results (energies, convergence info, spectra, etc.).

    Called by both V1 tool_bridge and V2 scanner. The update_step wrapper
    handles V2 tasks that don't exist in the V1 workflow_steps table.
    """
    from catgo.utils.workflow_db import update_step as _v1_update_step

    def update_step(wf_id: str, s_id: str, data: dict) -> None:
        try:
            _v1_update_step(wf_id, s_id, data)
        except KeyError:
            pass  # V2 engine: scanner bridge handles status

    try:
        update_step(workflow_id, step_id, {"status": StepStatus.RUNNING.value})
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "running"
        })

        parent_ids = _get_parent_step_ids_fn(step_id, edges)
        analysis_result: dict[str, Any] = {"node_type": node_type}

        if node_type == "dos_analysis":
            analysis_result.update(
                await _analyze_dos(parent_ids, step_results, params, config)
            )

        elif node_type == "cohp_analysis":
            analysis_result.update(
                await _analyze_cohp(parent_ids, step_results, params, config)
            )

        elif node_type == "md_analysis":
            analysis_result.update(
                await _analyze_md(parent_ids, step_results, params, config)
            )

        elif node_type == "convergence_check":
            analysis_result.update(
                await _check_convergence(parent_ids, step_results, params, config)
            )

        elif node_type == "energy_compare":
            analysis_result.update(
                _compare_energies(parent_ids, step_results, params)
            )

        elif node_type == "pick_best":
            analysis_result.update(
                _pick_best(parent_ids, step_results, params)
            )

        elif node_type == "free_energy":
            import json as _json
            input_mode = params.get("input_mode", "auto")

            if input_mode == "manual":
                # User-provided pathways JSON
                try:
                    pathways = _json.loads(params.get("pathways", "[]"))
                except (ValueError, TypeError):
                    pathways = []
            else:
                # Auto mode: collect Gibbs free energies from upstream gibbs_energy nodes
                pathways = []
                steps = []
                for pid in parent_ids:
                    pr = step_results.get(pid, {})
                    label = pr.get("system_name") or pr.get("label") or pr.get("formula") or pid[:8]
                    # Prefer gibbs (from gibbs_energy node), fallback to G, energy
                    energy = pr.get("gibbs") or pr.get("G") or pr.get("final_energy") or pr.get("energy")
                    if energy is not None:
                        steps.append({"label": label, "energy": float(energy)})

                # Apply user-defined step order if provided
                step_order = params.get("step_order")
                if step_order and steps:
                    try:
                        order_list = _json.loads(step_order) if isinstance(step_order, str) else step_order
                        ordered = []
                        step_by_label = {s["label"]: s for s in steps}
                        for name in order_list:
                            if name in step_by_label:
                                ordered.append(step_by_label.pop(name))
                        # Append any remaining steps not in the order list
                        ordered.extend(step_by_label.values())
                        steps = ordered
                    except Exception:
                        pass  # Keep original order

                if steps:
                    pathways = [{"name": "Reaction Path", "color": "#3b82f6", "steps": steps}]

            # Generate diagram if we have pathway data
            if pathways:
                try:
                    from workflow.catalysis.energy_diagram import generate_energy_diagram
                    diagram_data = generate_energy_diagram(pathways)
                    analysis_result["plotly_data"] = diagram_data
                    analysis_result["pathways"] = pathways
                except Exception as exc:
                    logger.warning("Failed to generate energy diagram: %s", exc)

        elif node_type == "charge_analysis":
            parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
            work_dir = parent.get("work_dir", "") or parent.get("summary", {}).get("work_dir", "")
            session_id = (
                parent.get("session_id")
                or parent.get("hpc_session_id", "")
                or parent.get("summary", {}).get("session_id", "")
            )
            method = params.get("method", "bader")

            if not work_dir:
                analysis_result["error"] = "No work directory from parent step"
            else:
                from catgo.utils.hpc_client import pool
                hpc = pool.get_connection(session_id) if session_id else None

                if not hpc:
                    analysis_result["error"] = "HPC session unavailable for Bader analysis"
                else:
                    # Check required files exist
                    check = await hpc.conn.run(
                        f"test -f {work_dir}/CHGCAR && test -f {work_dir}/AECCAR0 && test -f {work_dir}/AECCAR2",
                        check=False,
                    )
                    if check.exit_status != 0:
                        analysis_result["error"] = (
                            "Bader analysis requires CHGCAR + AECCAR0 + AECCAR2. "
                            "Make sure parent calculation has LAECHG=True in INCAR."
                        )
                    else:
                        # Run bader on HPC
                        bader_cmd = f"cd {work_dir} && bader CHGCAR -ref AECCAR0 AECCAR2"
                        bader_result = await hpc.conn.run(bader_cmd, check=False)

                        if bader_result.exit_status != 0:
                            analysis_result["error"] = f"Bader command failed: {bader_result.stderr}"
                        else:
                            # Parse ACF.dat
                            acf_result = await hpc.conn.run(f"cat {work_dir}/ACF.dat", check=False)
                            if acf_result.exit_status == 0:
                                charges = _parse_acf_dat(acf_result.stdout)
                                analysis_result.update({
                                    "method": method,
                                    "charges": charges,
                                    "n_atoms": len(charges),
                                    "work_dir": work_dir,
                                })

        elif node_type == "her_analysis":
            # HER selectivity analysis: compare *H vs *N2H adsorption energies
            parent_results = {pid: step_results.get(pid, {}) for pid in parent_ids}

            dG_H = None
            dG_N2H = None
            for pid, result in parent_results.items():
                summary = result.get("summary", result)
                if summary.get("adsorbate") == "H":
                    dG_H = summary.get("G") or summary.get("dG_ads")
                elif summary.get("adsorbate") in ("N2H", "NNH"):
                    dG_N2H = summary.get("G") or summary.get("dG_ads")

            if dG_H is not None and dG_N2H is not None:
                her_favorable = abs(float(dG_H)) < abs(float(dG_N2H))
                analysis_result.update({
                    "dG_H": float(dG_H),
                    "dG_N2H": float(dG_N2H),
                    "her_favorable": her_favorable,
                    "selectivity": "HER" if her_favorable else "NRR",
                    "selectivity_gap": abs(float(dG_N2H)) - abs(float(dG_H)),
                })
            else:
                analysis_result["error"] = "Missing H or N2H adsorption energy from parent nodes"

        elif node_type == "eos_analysis":
            analysis_result.update(
                _analyze_eos(parent_ids, step_results, params)
            )

        elif node_type == "surface_energy":
            analysis_result.update(
                _analyze_surface_energy(parent_ids, step_results, params)
            )

        elif node_type == "wulff_construction":
            analysis_result.update(
                _analyze_wulff(parent_ids, step_results, params)
            )

        elif node_type == "adsorption_energy":
            analysis_result.update(
                _analyze_adsorption_energy(parent_ids, step_results, params)
            )

        elif node_type == "coverage_analysis":
            analysis_result.update(
                _analyze_coverage(parent_ids, step_results, params)
            )

        elif node_type in ("elastic_analysis", "phonon_analysis"):
            # Lightweight collect-and-pass-through. The elastic-tensor / phonon
            # visualization is rendered frontend-side (elastic-analysis.ts,
            # phonon-analysis.ts) — the workflow editor is for teaching demos.
            # Production-grade elastic/phonon analysis is done via catgo-campaign,
            # not here. The node completes and forwards upstream structures +
            # energies so the editor can plot them.
            energies = [
                step_results.get(pid, {}).get("final_energy")
                for pid in parent_ids
            ]
            analysis_result.update({
                "analysis_type": node_type.replace("_analysis", ""),
                "n_inputs": len(parent_ids),
                "energies": [e for e in energies if e is not None],
                "note": "Upstream results collected; visualized in the editor "
                        "(teaching demo). Use catgo-campaign for production runs.",
            })

        else:
            raise RuntimeError(f"Unhandled ANALYSIS node type: {node_type}")

        # For pick_best, pass through the best parent's structure data
        if node_type == "pick_best" and analysis_result.get("best_step_id"):
            best_pid = analysis_result["best_step_id"]
            passthrough = {
                k: v for k, v in step_results.get(best_pid, {}).items()
                if k in ("contcar", "structure_json", "structure", "final_energy")
            }
        else:
            passthrough = {
                k: v for pid in parent_ids
                for k, v in step_results.get(pid, {}).items()
                if k in ("contcar", "structure_json")
            }

        step_results[step_id] = {
            "summary": analysis_result,
            **passthrough,
        }
        update_step(workflow_id, step_id, {
            "status": StepStatus.COMPLETED.value,
            "result_json": json.dumps(analysis_result),
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "completed"
        })

    except Exception as e:
        logger.exception("ANALYSIS node %s (%s) failed", step_id, node_type)
        update_step(workflow_id, step_id, {
            "status": StepStatus.FAILED.value,
            "error_message": str(e),
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id,
            "status": "failed", "error": str(e),
        })


# ====== ANALYSIS node helpers ======

async def _analyze_dos(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
    config: Any,
) -> dict[str, Any]:
    """Run DOS analysis on a parent step's electronic structure output.

    Uploads DOS data from HPC via the session API, computes total DOS
    and optionally d-band center, then cleans up the session.
    """
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
    work_dir = parent.get("work_dir", "") or parent.get("summary", {}).get("work_dir", "")
    session_id = (
        parent.get("session_id")
        or parent.get("hpc_session_id", "")
        or parent.get("summary", {}).get("session_id", "")
    )

    if not work_dir:
        return {"error": "No work directory from parent step"}

    api_base = _get_api_base()
    async with httpx.AsyncClient(timeout=60) as client:
        # Step 1: Upload DOS data from HPC remote directory
        upload_resp = await client.post(f"{api_base}/dos/from-directory", json={
            "session_id": session_id,
            "remote_path": work_dir,
        })
        if upload_resp.status_code != 200:
            return {"error": f"DOS upload failed: {upload_resp.text[:200]}"}

        dos_session = upload_resp.json()
        dos_session_id = dos_session.get("session_id", "")

        result: dict[str, Any] = {
            "status": "completed",
            "analysis_type": "dos",
            "dos_session_id": dos_session_id,
            "efermi": dos_session.get("efermi"),
        }

        # Step 2: Compute total DOS
        total_resp = await client.post(f"{api_base}/dos/total", json={
            "session_id": dos_session_id,
            "sigma": params.get("sigma", 0.05),
            "emin": params.get("emin", -10),
            "emax": params.get("emax", 10),
            "ngrid": params.get("ngrid", 2000),
        })
        if total_resp.status_code == 200:
            result["total_dos"] = total_resp.json()

        # Step 3: Compute d-band center if requested
        if params.get("d_band", True):
            dband_resp = await client.post(f"{api_base}/dos/dband", json={
                "session_id": dos_session_id,
                "sigma": 0.05,
                "occupied_only_center": True,
            })
            if dband_resp.status_code == 200:
                result["dband"] = dband_resp.json()

        # Cleanup session
        await client.delete(f"{api_base}/dos/{dos_session_id}")

        return result


async def _analyze_cohp(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
    config: Any,
) -> dict[str, Any]:
    """Run COHP analysis.

    Loads COHPCAR.lobster from HPC via the session API, computes COHP
    data for total bonds, then cleans up the session.
    """
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
    work_dir = parent.get("work_dir", "") or parent.get("summary", {}).get("work_dir", "")
    session_id = (
        parent.get("session_id")
        or parent.get("hpc_session_id", "")
        or parent.get("summary", {}).get("session_id", "")
    )

    if not work_dir:
        return {"error": "No work directory from parent step"}

    api_base = _get_api_base()
    async with httpx.AsyncClient(timeout=60) as client:
        # Load COHPCAR from HPC
        cohp_path = f"{work_dir}/COHPCAR.lobster"
        upload_resp = await client.post(f"{api_base}/cohp/from-remote", json={
            "session_id": session_id,
            "remote_path": cohp_path,
        })
        if upload_resp.status_code != 200:
            return {"error": f"COHP upload failed (need LOBSTER output): {upload_resp.text[:200]}"}

        cohp_session = upload_resp.json()
        cohp_session_id = cohp_session.get("session_id", "")
        bonds = cohp_session.get("bonds", [])

        result: dict[str, Any] = {
            "status": "completed",
            "analysis_type": "cohp",
            "cohp_session_id": cohp_session_id,
            "n_bonds": len(bonds),
        }

        # Compute COHP for all total bonds
        bond_indices = [b["bond_index"] for b in bonds if b.get("is_total")]
        if bond_indices:
            data_resp = await client.post(f"{api_base}/cohp/data", json={
                "session_id": cohp_session_id,
                "bond_indices": bond_indices[:20],  # limit to avoid excessive data
                "include_orbitals": False,
            })
            if data_resp.status_code == 200:
                result.update(data_resp.json())

        # Cleanup session
        await client.delete(f"{api_base}/cohp/{cohp_session_id}")

        return result


async def _analyze_md(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
    config: Any,
) -> dict[str, Any]:
    """Run MD trajectory analysis (RMSD, RDF, etc.).

    Downloads trajectory file from HPC, base64-encodes it, and calls
    the MD analysis session APIs for RDF/RMSD computation.
    """
    import base64

    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
    work_dir = parent.get("work_dir", "") or parent.get("summary", {}).get("work_dir", "")
    session_id = (
        parent.get("session_id")
        or parent.get("hpc_session_id", "")
        or parent.get("summary", {}).get("session_id", "")
    )
    requested = params.get("analyses", "rmsd,rdf").split(",")

    if not work_dir:
        return {"error": "No work directory from parent step"}

    from catgo.utils.hpc_client import pool
    hpc = pool.get_connection(session_id) if session_id else None

    if not hpc:
        return {"error": "HPC session unavailable for trajectory download"}

    # Try to download a trajectory file from HPC
    traj_files = ["XDATCAR", "vasprun.xml", "dump.lammpstrj", "traj.xyz"]
    traj_content: str | None = None
    traj_format = "pdb"

    for fname in traj_files:
        try:
            cat_result = await hpc.conn.run(f"cat {work_dir}/{fname}", check=True)
            traj_content = cat_result.stdout
            if "XDATCAR" in fname:
                traj_format = "vasp-xdatcar"
            elif "lammpstrj" in fname:
                traj_format = "lammpstrj"
            elif "xyz" in fname:
                traj_format = "xyz"
            break
        except Exception:
            continue

    if not traj_content:
        return {"error": "No trajectory file found in work directory"}

    traj_b64 = base64.b64encode(traj_content.encode()).decode()
    api_base = _get_api_base()

    result: dict[str, Any] = {
        "status": "completed",
        "analysis_type": "md",
        "requested_analyses": requested,
        "trajectory_format": traj_format,
    }

    async with httpx.AsyncClient(timeout=120) as client:
        if "rdf" in requested:
            rdf_resp = await client.post(f"{api_base}/md/rdf/compute", json={
                "trajectory_b64": traj_b64,
                "format": traj_format,
                "n_bins": params.get("n_bins", 100),
            })
            if rdf_resp.status_code == 200:
                result["rdf"] = rdf_resp.json()

        if "rmsd" in requested:
            rmsd_resp = await client.post(f"{api_base}/md/rmsd/compute", json={
                "trajectory_b64": traj_b64,
                "format": traj_format,
            })
            if rmsd_resp.status_code == 200:
                result["rmsd"] = rmsd_resp.json()

    return result


async def _check_convergence(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
    config: Any,
) -> dict[str, Any]:
    """Check convergence of a parent VASP calculation.

    Reads OSZICAR/OUTCAR from the parent step's work_dir.
    Uses the convergence data already extracted in step_results.
    """
    threshold_energy = params.get("energy_threshold", 1e-4)  # eV
    threshold_force = params.get("force_threshold", 0.02)  # eV/A

    results = {"analysis_type": "convergence_check", "parent_checks": []}

    for pid in parent_ids:
        parent = step_results.get(pid, {})
        summary = parent.get("summary", {})

        energy = summary.get("energy")
        max_force = summary.get("max_force")
        converged = summary.get("converged", False)
        n_steps = summary.get("n_steps", 0)

        check = {
            "parent_step": pid,
            "energy": energy,
            "max_force": max_force,
            "ionic_converged": converged,
            "n_steps": n_steps,
        }

        # Evaluate against thresholds
        if max_force is not None:
            check["force_below_threshold"] = max_force <= threshold_force
        if energy is not None:
            check["has_energy"] = True

        check["passed"] = converged and (
            max_force is not None and max_force <= threshold_force
        )

        results["parent_checks"].append(check)

    # Overall pass/fail
    if results["parent_checks"]:
        results["all_passed"] = all(c.get("passed", False) for c in results["parent_checks"])
        results["status"] = "passed" if results["all_passed"] else "needs_attention"
    else:
        results["status"] = "no_parents"

    return results


def _compare_energies(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Gather and compare energies from ALL parent steps.

    Aggregates final_energy from every parent node, sorts by energy,
    computes relative energies (total and per-atom), and produces a
    ranked comparison table.

    Useful for comparing different configurations (e.g., adsorption sites,
    defect positions, strained vs. unstrained).
    """
    reference_label = params.get("reference", None)  # step_id or "lowest"
    entries = []

    for pid in parent_ids:
        parent = step_results.get(pid, {})
        summary = parent.get("summary", {})
        # Try multiple energy keys — different engines store it differently
        energy = (
            parent.get("final_energy")
            or summary.get("energy")
            or summary.get("energy_eh")
            or summary.get("final_energy")
        )
        if energy is not None:
            energy = float(energy)
            n_atoms = summary.get("n_atoms")
            structure = parent.get("structure")
            entries.append({
                "step_id": pid,
                "energy_eV": energy,
                "n_atoms": n_atoms,
                "structure": structure,
                "label": summary.get("node_type") or parent.get("node_type", pid),
            })

    if not entries:
        return {"status": "no_energies", "analysis_type": "energy_compare"}

    # Sort by energy (lowest = most stable)
    entries.sort(key=lambda x: x["energy_eV"])

    # Assign ranks
    for rank, entry in enumerate(entries):
        entry["rank"] = rank + 1

    # Compute relative energies
    ref_energy = entries[0]["energy_eV"]  # default: lowest energy
    if reference_label and reference_label != "lowest":
        for e in entries:
            if e["step_id"] == reference_label:
                ref_energy = e["energy_eV"]
                break

    for e in entries:
        e["relative_eV"] = e["energy_eV"] - ref_energy
        e["relative_meV_per_atom"] = (
            (e["energy_eV"] - ref_energy) * 1000
            / max(e.get("n_atoms") or 1, 1)
        )

    return {
        "status": "completed",
        "analysis_type": "energy_compare",
        "reference_energy_eV": ref_energy,
        "entries": entries,
        "best_step_id": entries[0]["step_id"],
        "lowest_step": entries[0]["step_id"],
        "n_compared": len(entries),
        "spread_eV": entries[-1]["energy_eV"] - entries[0]["energy_eV"],
    }


def _pick_best(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Select the lowest-energy structure from parent nodes.

    Picks the parent with the lowest energy and passes its structure
    through to downstream nodes. Useful as a convergence/selection
    node after comparing multiple configurations.
    """
    best_energy = float("inf")
    best_parent: str | None = None

    for pid in parent_ids:
        parent = step_results.get(pid, {})
        summary = parent.get("summary", {})
        energy = (
            parent.get("final_energy")
            or summary.get("energy")
            or summary.get("energy_eh")
            or summary.get("final_energy")
        )
        if energy is not None and float(energy) < best_energy:
            best_energy = float(energy)
            best_parent = pid

    if best_parent is not None:
        best_result = step_results[best_parent]
        return {
            "status": "completed",
            "analysis_type": "pick_best",
            "best_step_id": best_parent,
            "best_energy_eV": best_energy,
            "structure": best_result.get("structure"),
            "n_candidates": len(parent_ids),
        }
    else:
        return {
            "status": "no_energies",
            "analysis_type": "pick_best",
            "error": "No valid energies found in parent nodes",
        }


def _parse_acf_dat(content: str) -> list[dict]:
    """Parse Bader ACF.dat output into per-atom charges."""
    charges = []
    for line in content.strip().split("\n"):
        parts = line.split()
        if len(parts) >= 5 and parts[0].isdigit():
            charges.append({
                "index": int(parts[0]),
                "x": float(parts[1]),
                "y": float(parts[2]),
                "z": float(parts[3]),
                "charge": float(parts[4]),
                "min_dist": float(parts[5]) if len(parts) > 5 else None,
                "volume": float(parts[6]) if len(parts) > 6 else None,
            })
    return charges


def _try_load_atoms(parent: dict[str, Any]):
    """Try to load an ASE Atoms object from a parent step result.

    Checks structure_json (pymatgen dict) first, then contcar (POSCAR string).
    Returns None if neither works.
    """
    # Try pymatgen dict
    if parent.get("structure_json"):
        try:
            data = parent["structure_json"]
            if isinstance(data, str):
                import json as _json
                data = _json.loads(data)
            from pymatgen.core import Structure as PmgStructure
            from pymatgen.io.ase import AseAtomsAdaptor
            struct = PmgStructure.from_dict(data)
            return AseAtomsAdaptor.get_atoms(struct)
        except Exception:
            pass

    # Try POSCAR/CONTCAR string (skip if it looks like JSON — handled below)
    contcar = parent.get("contcar") or parent.get("structure")
    if contcar and isinstance(contcar, str) and len(contcar) > 10 and not contcar.strip().startswith("{"):
        try:
            import io
            from ase.io import read as ase_read
            return ase_read(io.StringIO(contcar), format="vasp")
        except Exception as e:
            logger.debug("_try_load_atoms: POSCAR parse failed: %s", e)

    # Try pymatgen dict stored as string in "structure" key
    struct_val = parent.get("structure")
    if struct_val and isinstance(struct_val, str) and struct_val.strip().startswith("{"):
        try:
            import json as _json2
            data = _json2.loads(struct_val)
            from pymatgen.core import Structure as PmgStructure
            from pymatgen.io.ase import AseAtomsAdaptor
            struct = PmgStructure.from_dict(data)
            return AseAtomsAdaptor.get_atoms(struct)
        except Exception as e:
            logger.debug("_try_load_atoms: JSON structure parse failed: %s", e)

    return None


def _analyze_eos(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Fit energy-volume data to an equation of state.

    Collects (volume, energy) pairs from parent calculation steps and
    fits them to a Birch-Murnaghan, Vinet, or Murnaghan EOS using ASE.

    Returns equilibrium volume V0, energy E0, bulk modulus B0, and
    the fitted E(V) curve for plotting.
    """
    import numpy as np

    # Collect (volume, energy) data from parent steps
    data_points: list[dict[str, Any]] = []

    for pid in parent_ids:
        parent = step_results.get(pid, {})
        summary = parent.get("summary", {})

        energy = (
            parent.get("final_energy")
            or summary.get("energy")
            or summary.get("energy_eh")
            or summary.get("final_energy")
        )
        if energy is None:
            continue
        energy = float(energy)

        # Volume can come from: metadata (batch_generate lattice scan),
        # summary, or the structure itself
        volume = (
            summary.get("volume")
            or parent.get("volume")
            or (summary.get("metadata") or {}).get("volume")
        )

        # If no explicit volume, try to compute from structure
        if volume is None:
            atoms = _try_load_atoms(parent)
            if atoms is not None:
                volume = float(atoms.get_volume())

        if volume is not None:
            data_points.append({
                "volume": float(volume),
                "energy": energy,
                "step_id": pid,
            })

    if len(data_points) < 3:
        return {
            "status": "error",
            "analysis_type": "eos",
            "error": f"Need at least 3 (volume, energy) points, got {len(data_points)}",
        }

    # Sort by volume
    data_points.sort(key=lambda d: d["volume"])
    volumes = np.array([d["volume"] for d in data_points])
    energies = np.array([d["energy"] for d in data_points])

    # Map EOS type parameter to ASE name
    eos_type_map = {
        "birch_murnaghan": "birchmurnaghan",
        "vinet": "vinet",
        "murnaghan": "murnaghan",
    }
    eos_name = eos_type_map.get(params.get("eos_type", "birch_murnaghan"), "birchmurnaghan")

    try:
        from ase.eos import EquationOfState
        eos = EquationOfState(volumes, energies, eos=eos_name)
        v0, e0, B0 = eos.fit()

        # B0 from ASE is in eV/A^3, convert to GPa (1 eV/A^3 = 160.2176634 GPa)
        B0_GPa = float(B0) * 160.2176634

        # Get fitted curve from ASE's getplotdata
        # Returns tuple: (v0, e0, B, ..., fit_volumes[100], fit_energies[100], data_v, data_e)
        plot_data = eos.getplotdata()
        v_fit = np.array(plot_data[4])
        e_fit = np.array(plot_data[5]).tolist()

        # Try to extract lattice constant for cubic systems
        # V = a^3 for simple cubic, a^3/4 for FCC (4 atoms), a^3/2 for BCC (2 atoms)
        n_atoms_per_cell = None
        for pid in parent_ids:
            parent = step_results.get(pid, {})
            summary = parent.get("summary", {})
            n = summary.get("n_atoms")
            if n is not None:
                n_atoms_per_cell = int(n)
                break

        result: dict[str, Any] = {
            "status": "completed",
            "analysis_type": "eos",
            "eos_model": eos_name,
            "v0": float(v0),
            "e0": float(e0),
            "B0_eV_per_A3": float(B0),
            "B0_GPa": B0_GPa,
            "n_points": len(data_points),
            "data_points": data_points,
            "fit_curve": {
                "volumes": v_fit.tolist(),
                "energies": e_fit,
            },
        }

        # Estimate lattice constant for common cubic cells
        if n_atoms_per_cell is not None:
            # Common atoms/cell: 1 (SC), 2 (BCC), 4 (FCC), 8 (diamond cubic)
            for label, n_per_cell in [("fcc", 4), ("bcc", 2), ("sc", 1), ("diamond", 8)]:
                if n_atoms_per_cell == n_per_cell:
                    a0 = float(v0 ** (1.0 / 3.0))  # cubic cell lattice constant
                    result["lattice_constant_A"] = a0
                    result["cell_type"] = label
                    break

        return result

    except Exception as exc:
        return {
            "status": "error",
            "analysis_type": "eos",
            "error": f"EOS fitting failed: {exc}",
            "n_points": len(data_points),
            "data_points": data_points,
        }


def _extract_facet(label: str) -> str | None:
    """Extract Miller index from a label like 'Ni(111)-4L' -> '111'."""
    import re
    m = re.search(r'\((\d+)\)', label)
    return m.group(1) if m else None


def _collect_data_from_result(
    result_dict: dict[str, Any],
    step_id: str,
    label: str | None,
    data_points: list[dict[str, Any]],
    surface_areas: dict[str, float],
    np: Any,
) -> None:
    """Extract energy, n_atoms, and surface_area from a single result dict."""
    energy = (
        result_dict.get("final_energy")
        or result_dict.get("energy")
    )
    if energy is None:
        summary = result_dict.get("summary", {})
        energy = (
            summary.get("energy")
            or summary.get("energy_eh")
            or summary.get("final_energy")
        )
    if energy is None:
        return
    energy = float(energy)

    n_atoms: int | None = None
    summary = result_dict.get("summary", {})
    n_atoms = summary.get("n_atoms")

    area: float | None = None
    atoms = _try_load_atoms(result_dict)
    if atoms is not None:
        if n_atoms is None:
            n_atoms = len(atoms)
        cell = atoms.get_cell()
        a_vec = cell[0]
        b_vec = cell[1]
        area = float(np.linalg.norm(np.cross(a_vec, b_vec)))

    if n_atoms is None:
        return

    point: dict[str, Any] = {
        "n_atoms": int(n_atoms),
        "energy": energy,
        "step_id": step_id,
    }
    if label is not None:
        point["label"] = label

    data_points.append(point)

    # Track surface area per facet (or global)
    facet_key = (_extract_facet(label) if label else None) or "__global__"
    if area is not None and area > 0.1:
        surface_areas.setdefault(facet_key, area)


def _fit_surface_energy(
    data_points: list[dict[str, Any]],
    surface_area: float,
    np: Any,
) -> dict[str, Any]:
    """Perform linear fit and compute surface energy for a set of data points."""
    pts = sorted(data_points, key=lambda d: d["n_atoms"])
    n_atoms_arr = np.array([d["n_atoms"] for d in pts])
    energies_arr = np.array([d["energy"] for d in pts])

    coeffs = np.polyfit(n_atoms_arr, energies_arr, 1)
    slope = float(coeffs[0])
    intercept = float(coeffs[1])

    gamma_eV_per_A2 = intercept / (2.0 * surface_area)
    gamma_J_per_m2 = gamma_eV_per_A2 * 16.0218  # eV/A^2 -> J/m^2

    e_pred = slope * n_atoms_arr + intercept
    ss_res = float(np.sum((energies_arr - e_pred) ** 2))
    ss_tot = float(np.sum((energies_arr - np.mean(energies_arr)) ** 2))
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    n_fit = np.linspace(
        float(n_atoms_arr.min()) - 2,
        float(n_atoms_arr.max()) + 2,
        50,
    )
    e_fit = (slope * n_fit + intercept).tolist()

    return {
        "gamma_eV_per_A2": gamma_eV_per_A2,
        "gamma_J_per_m2": gamma_J_per_m2,
        "surface_area_A2": surface_area,
        "slope_eV_per_atom": slope,
        "intercept_eV": intercept,
        "r_squared": r_squared,
        "n_points": len(pts),
        "data_points": pts,
        "fit_curve": {
            "n_atoms": n_fit.tolist(),
            "energies": e_fit,
        },
    }


def _analyze_surface_energy(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Calculate surface energy via linear extrapolation.

    Collects (n_atoms, energy) pairs from parent slab calculations at
    different thicknesses and fits E_slab = slope*N + intercept.

    Surface energy: gamma = intercept / (2 * A)

    The slope is the self-consistent bulk energy per atom derived from
    the slab series, eliminating the need for a separate bulk reference.

    Supports batch/fan-out parent results and per-facet grouping.
    """
    from collections import defaultdict

    import numpy as np

    # Collect (n_atoms, energy, area) data from parent slab steps
    data_points: list[dict[str, Any]] = []
    surface_areas: dict[str, float] = {}  # facet_key -> area

    for pid in parent_ids:
        parent = step_results.get(pid, {})

        # Check if parent is a batch/fan-out result
        if parent.get("_fan_out") and isinstance(parent.get("results"), list):
            for r in parent["results"]:
                r_result = r.get("result", {})
                r_label = r.get("label")
                branch_id = r.get("branch_id", f"{pid}:{r.get('index', '?')}")
                _collect_data_from_result(
                    r_result, branch_id, r_label, data_points, surface_areas, np
                )
        else:
            # Single (non-fan-out) parent
            _collect_data_from_result(
                parent, pid, None, data_points, surface_areas, np
            )

    if len(data_points) < 2:
        return {
            "status": "error",
            "analysis_type": "surface_energy",
            "error": f"Need at least 2 slab calculations at different thicknesses, got {len(data_points)}",
        }

    # Allow user to override surface area from params (in A^2)
    override_area = params.get("surface_area")
    if override_area:
        override_area = float(override_area)

    # Determine grouping mode
    grouping = params.get("grouping", "auto")

    # Group data points by facet
    facet_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if grouping != "none":
        for dp in data_points:
            label = dp.get("label", "")
            facet = _extract_facet(label) if label else None
            facet_groups[facet or "__none__"].append(dp)
    else:
        facet_groups["__none__"] = data_points

    # Filter out the "__none__" key to see if we have real facets
    real_facets = {k: v for k, v in facet_groups.items() if k != "__none__"}
    has_multiple_facets = len(real_facets) >= 2
    has_any_facets = len(real_facets) >= 1

    # If we have multiple facets, do per-facet fitting
    if has_multiple_facets or (has_any_facets and grouping == "auto"):
        per_facet: dict[str, dict[str, Any]] = {}
        all_facets_sorted = sorted(real_facets.keys())

        for facet_key in all_facets_sorted:
            facet_pts = real_facets[facet_key]
            if len(facet_pts) < 2:
                continue

            # Determine surface area for this facet
            area = override_area or surface_areas.get(facet_key)
            if area is None or area < 0.1:
                per_facet[facet_key] = {
                    "status": "error",
                    "error": f"Could not determine surface area for facet ({facet_key}). "
                             f"Provide it via 'surface_area' parameter or ensure parent steps include structure data.",
                    "n_points": len(facet_pts),
                    "data_points": facet_pts,
                }
                continue

            per_facet[facet_key] = _fit_surface_energy(facet_pts, area, np)

        if not per_facet:
            return {
                "status": "error",
                "analysis_type": "surface_energy",
                "error": "No facet group had enough data points (need at least 2 per facet).",
            }

        # Use first facet alphabetically for top-level backward compat
        first_facet = all_facets_sorted[0]
        first_result = per_facet.get(first_facet, {})

        result: dict[str, Any] = {
            "status": "completed",
            "analysis_type": "surface_energy",
            "per_facet": per_facet,
        }

        # Copy top-level fields from first facet for backward compat
        for key in (
            "gamma_eV_per_A2", "gamma_J_per_m2", "surface_area_A2",
            "slope_eV_per_atom", "intercept_eV", "r_squared",
            "n_points", "data_points", "fit_curve",
        ):
            if key in first_result:
                result[key] = first_result[key]

        # Summary comparison across facets
        summary_lines = []
        for fk in all_facets_sorted:
            fr = per_facet.get(fk, {})
            if "gamma_J_per_m2" in fr:
                summary_lines.append(
                    f"({fk}): gamma = {fr['gamma_J_per_m2']:.4f} J/m2, "
                    f"R2 = {fr.get('r_squared', 0):.4f}, "
                    f"n = {fr.get('n_points', 0)}"
                )
        if summary_lines:
            result["facet_summary"] = "; ".join(summary_lines)

        # Optional: bulk energy per atom from params for comparison
        bulk_energy_per_atom = params.get("bulk_energy_per_atom")
        if bulk_energy_per_atom is not None and "slope_eV_per_atom" in result:
            result["bulk_energy_per_atom_ref"] = float(bulk_energy_per_atom)
            result["slope_vs_bulk_diff_meV"] = (
                result["slope_eV_per_atom"] - float(bulk_energy_per_atom)
            ) * 1000

        return result

    # --- Single-facet / no-grouping fallback (backward compat) ---

    # Determine global surface area
    surface_area: float | None = override_area
    if surface_area is None:
        # Use any detected area
        for area_val in surface_areas.values():
            if area_val is not None and area_val > 0.1:
                surface_area = area_val
                break

    if surface_area is None or surface_area < 0.1:
        return {
            "status": "error",
            "analysis_type": "surface_energy",
            "error": "Could not determine surface area. Provide it via 'surface_area' parameter or ensure parent steps include structure data.",
        }

    fit_result = _fit_surface_energy(data_points, surface_area, np)

    result = {
        "status": "completed",
        "analysis_type": "surface_energy",
        **fit_result,
    }

    # Optional: bulk energy per atom from params for comparison
    bulk_energy_per_atom = params.get("bulk_energy_per_atom")
    if bulk_energy_per_atom is not None:
        result["bulk_energy_per_atom_ref"] = float(bulk_energy_per_atom)
        result["slope_vs_bulk_diff_meV"] = (
            fit_result["slope_eV_per_atom"] - float(bulk_energy_per_atom)
        ) * 1000

    return result


def _analyze_wulff(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Compute Wulff construction from surface energy results.

    Reads per_facet surface energies from a parent surface_energy node
    and a bulk lattice from an upstream structure node, then uses
    pymatgen WulffShape to compute equilibrium nanoparticle morphology.
    """
    try:
        from pymatgen.analysis.wulff import WulffShape
        from pymatgen.core import Lattice, Structure as PmgStructure
    except ImportError:
        return {
            "status": "error",
            "analysis_type": "wulff_construction",
            "error": "pymatgen is required for Wulff construction.",
        }

    # --- Collect surface energies from parent nodes ---
    miller_list: list[tuple[int, ...]] = []
    energy_list: list[float] = []
    lattice: Lattice | None = None

    for pid in parent_ids:
        parent = step_results.get(pid, {})
        summary = parent.get("summary", {})

        # Check if parent is a surface_energy node with per_facet results
        if summary.get("analysis_type") == "surface_energy" and summary.get("per_facet"):
            for facet_key, fdata in summary["per_facet"].items():
                gamma = fdata.get("gamma_J_per_m2")
                if gamma is None or not isinstance(gamma, (int, float)):
                    continue
                digits = [int(c) for c in facet_key if c.isdigit()]
                if len(digits) >= 3:
                    miller_list.append(tuple(digits[:3]))
                    energy_list.append(float(gamma))

        # Try to extract lattice from parent structure data
        if lattice is None:
            struct_data = (
                parent.get("contcar")
                or parent.get("structure_json")
                or parent.get("structure")
            )
            if struct_data:
                try:
                    if isinstance(struct_data, str):
                        stripped = struct_data.strip()
                        if stripped.startswith("{"):
                            import json as _json
                            struct = PmgStructure.from_dict(_json.loads(struct_data))
                        else:
                            from pymatgen.io.vasp import Poscar
                            struct = Poscar.from_str(struct_data).structure
                    elif isinstance(struct_data, dict):
                        struct = PmgStructure.from_dict(struct_data)
                    else:
                        struct = None
                    if struct is not None:
                        lattice = struct.lattice
                except Exception:
                    pass

    if not miller_list:
        return {
            "status": "error",
            "analysis_type": "wulff_construction",
            "error": "No surface energies found. Connect a Surface Energy node as parent.",
        }

    if len(miller_list) < 2:
        return {
            "status": "error",
            "analysis_type": "wulff_construction",
            "error": f"Need at least 2 facets, got {len(miller_list)}.",
        }

    # --- Determine lattice for Wulff construction ---
    # User-provided lattice_constant always takes priority.
    lc = params.get("lattice_constant")
    if lc is not None:
        lattice = Lattice.cubic(float(lc))
    elif lattice is not None:
        # The parent structure is typically a slab with a large vacuum layer
        # (c >> a, b).  Passing a slab lattice to WulffShape produces a
        # wildly elongated polyhedron because the Wulff dual construction
        # treats the lattice metric as the bulk crystal metric.
        # Fix: detect slab-like lattices and fall back to a cubic lattice
        # built from the shortest in-plane parameter.  For cubic materials
        # (by far the most common Wulff use case), the area fractions depend
        # only on crystal symmetry, not on the absolute lattice constant.
        a, b, c = lattice.a, lattice.b, lattice.c
        shortest = min(a, b, c)
        longest = max(a, b, c)
        if longest / shortest > 2.0:
            # Slab detected — use shortest parameter as cubic bulk constant
            logger.info(
                "Slab lattice detected (a=%.2f, b=%.2f, c=%.2f). "
                "Using cubic lattice a=%.3f for Wulff construction.",
                a, b, c, shortest,
            )
            lattice = Lattice.cubic(shortest)
    else:
        lattice = Lattice.cubic(3.52)

    # --- Compute Wulff shape ---
    try:
        wulff = WulffShape(lattice, miller_list, energy_list)
    except Exception as e:
        return {
            "status": "error",
            "analysis_type": "wulff_construction",
            "error": f"WulffShape failed: {e}",
        }

    # Extract 3D facet geometry for visualization
    wulff_facets_3d = []
    try:
        for facet in wulff.facets:
            if not facet.points:
                continue
            miller_key = "".join(str(i) for i in facet.miller)
            triangles = []
            for tri in facet.points:
                triangles.append([[float(v) for v in vertex] for vertex in tri])
            centroid = [0.0, 0.0, 0.0]
            n_verts = 0
            for tri in facet.points:
                for vertex in tri:
                    for k in range(3):
                        centroid[k] += float(vertex[k])
                    n_verts += 1
            if n_verts > 0:
                centroid = [c / n_verts for c in centroid]
            wulff_facets_3d.append({
                "miller": miller_key,
                "normal": [float(x) for x in facet.normal],
                "e_surf": float(facet.e_surf),
                "triangles": triangles,
                "centroid": centroid,
            })
    except Exception as e:
        logger.warning("Failed to extract 3D Wulff facet geometry: %s", e)
        wulff_facets_3d = []

    area_fractions: dict[str, float] = {}
    for hkl, frac in wulff.area_fraction_dict.items():
        area_fractions["".join(str(i) for i in hkl)] = float(frac)

    sorted_facets = sorted(area_fractions.items(), key=lambda x: x[1], reverse=True)

    facet_table = []
    for facet_key, frac in sorted_facets:
        gamma = None
        for m, e in zip(miller_list, energy_list):
            if "".join(str(i) for i in m) == facet_key:
                gamma = e
                break
        facet_table.append({
            "facet": facet_key,
            "area_fraction": frac,
            "area_percent": frac * 100,
            "gamma_J_per_m2": gamma,
        })

    return {
        "status": "completed",
        "analysis_type": "wulff_construction",
        "volume_A3": float(wulff.volume),
        "surface_area_A2": float(wulff.surface_area),
        "effective_radius_A": float(wulff.effective_radius),
        "weighted_surface_energy_J_per_m2": float(wulff.weighted_surface_energy),
        "n_facets": len(miller_list),
        "area_fractions": area_fractions,
        "facet_table": facet_table,
        "dominant_facet": sorted_facets[0][0] if sorted_facets else None,
        "wulff_facets_3d": wulff_facets_3d,
    }


_FREQ_NODE_TYPES = {
    "freq", "mlp_vibrations", "frequency",
    "vasp_freq", "orca_freq", "gaussian_freq", "cp2k_freq",
}


def _analyze_adsorption_energy(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Calculate adsorption energy from parent calculation results.

    E_ads = E(slab+adsorbate) - E(clean slab) - coefficient * E(reference)

    With optional ZPE correction from freq/vibration parent nodes:
    E_ads_ZPE = E_ads + ZPE(slab+ads) - ZPE(slab) - coefficient * ZPE(ref)

    Identifies parents by atom count: the parent with the most atoms is
    slab+adsorbate, the next is clean slab, and the smallest is the
    gas-phase reference molecule. Freq nodes are paired with their
    corresponding energy node by matching atom count.
    """
    # --- Collect energies from non-freq parents ---
    entries: list[dict[str, Any]] = []
    # --- Collect ZPE data from freq/vibration parents ---
    zpe_entries: list[dict[str, Any]] = []

    for pid in parent_ids:
        parent = step_results.get(pid, {})
        parent_node_type = parent.get("node_type", "")

        # Classify: freq/vibration nodes go to zpe_entries, rest to energy entries
        if parent_node_type in _FREQ_NODE_TYPES or (
            parent.get("zpe") is not None and parent.get("energy") is None
        ):
            # --- ZPE source ---
            zpe_val = parent.get("zpe")
            if zpe_val is None:
                # Compute from frequencies if available
                freqs = parent.get("frequencies", [])
                if not freqs:
                    real_freqs = parent.get("real_freqs", [])
                    if real_freqs:
                        freqs = [f["frequency_cm"] for f in real_freqs if isinstance(f, dict)]
                if freqs:
                    from workflow.catalysis.free_energy import compute_zpe
                    zpe_val = compute_zpe(freqs)
            if zpe_val is not None:
                n_atoms = parent.get("n_atoms")
                if n_atoms is None:
                    atoms = _try_load_atoms(parent)
                    if atoms is not None:
                        n_atoms = len(atoms)
                zpe_entries.append({"step_id": pid, "zpe": float(zpe_val), "n_atoms": n_atoms})
            continue

        # --- Energy source ---
        energy = parent.get("energy") or parent.get("final_energy")
        if energy is None:
            summary = parent.get("summary", {})
            energy = (
                summary.get("energy")
                or summary.get("final_energy")
            )
        if energy is None:
            stdout = parent.get("stdout", "")
            if "Final energy:" in stdout:
                try:
                    energy = float(stdout.split("Final energy:")[1].strip().split()[0])
                except (ValueError, IndexError):
                    pass
        if energy is None:
            continue

        energy = float(energy)

        n_atoms = parent.get("n_atoms")
        if n_atoms is None:
            atoms = _try_load_atoms(parent)
            if atoms is not None:
                n_atoms = len(atoms)

        entries.append({
            "step_id": pid,
            "energy": energy,
            "n_atoms": n_atoms,
        })

    if len(entries) < 2:
        return {
            "status": "error",
            "analysis_type": "adsorption_energy",
            "error": f"Need at least 2 parent calculations (slab+ads and clean slab), got {len(entries)}.",
        }

    # --- Assign roles by atom count ---
    slab_ads_id = params.get("slab_adsorbate_step")
    slab_id = params.get("clean_slab_step")
    ref_id = params.get("reference_step")

    if slab_ads_id and slab_id:
        e_slab_ads = next((e for e in entries if e["step_id"] == slab_ads_id), None)
        e_slab = next((e for e in entries if e["step_id"] == slab_id), None)
        e_ref = next((e for e in entries if e["step_id"] == ref_id), None) if ref_id else None
    else:
        with_atoms = [e for e in entries if e["n_atoms"] is not None]
        if with_atoms:
            with_atoms.sort(key=lambda x: x["n_atoms"], reverse=True)
            e_slab_ads = with_atoms[0]
            e_slab = with_atoms[1] if len(with_atoms) > 1 else None
            e_ref = with_atoms[2] if len(with_atoms) > 2 else None
        else:
            e_slab_ads = entries[0]
            e_slab = entries[1] if len(entries) > 1 else None
            e_ref = entries[2] if len(entries) > 2 else None

    if e_slab_ads is None or e_slab is None:
        return {
            "status": "error",
            "analysis_type": "adsorption_energy",
            "error": "Could not identify slab+adsorbate and clean slab energies from parent nodes.",
        }

    # --- Compute E_ads (electronic) ---
    ref_coefficient = float(params.get("reference_coefficient") or 0.5)
    E_slab_ads = e_slab_ads["energy"]
    E_slab = e_slab["energy"]
    E_ref = e_ref["energy"] if e_ref else 0.0

    E_ads = E_slab_ads - E_slab - ref_coefficient * E_ref

    result: dict[str, Any] = {
        "status": "completed",
        "analysis_type": "adsorption_energy",
        "E_ads_eV": E_ads,
        "E_slab_adsorbate_eV": E_slab_ads,
        "E_clean_slab_eV": E_slab,
        "n_atoms_slab_adsorbate": e_slab_ads.get("n_atoms"),
        "n_atoms_clean_slab": e_slab.get("n_atoms"),
    }

    if e_ref:
        result["E_reference_eV"] = E_ref
        result["reference_coefficient"] = ref_coefficient
        result["n_atoms_reference"] = e_ref.get("n_atoms")

    # --- ZPE Correction ---
    include_zpe = params.get("include_zpe", True)
    if include_zpe and zpe_entries:
        # Pair ZPE entries with energy entries by atom count
        zpe_slab_ads = None
        zpe_slab = None
        zpe_ref = None

        for ze in zpe_entries:
            if ze["n_atoms"] is None:
                continue  # Cannot pair without atom count
            if e_slab_ads and ze["n_atoms"] == e_slab_ads.get("n_atoms"):
                zpe_slab_ads = ze["zpe"]
            elif e_slab and ze["n_atoms"] == e_slab.get("n_atoms"):
                zpe_slab = ze["zpe"]
            elif e_ref and ze["n_atoms"] == e_ref.get("n_atoms"):
                zpe_ref = ze["zpe"]

        # Warn if atom counts are ambiguous (e.g. slab and ref have same count)
        energy_counts = [
            e_slab_ads.get("n_atoms") if e_slab_ads else None,
            e_slab.get("n_atoms") if e_slab else None,
            e_ref.get("n_atoms") if e_ref else None,
        ]
        energy_counts = [c for c in energy_counts if c is not None]
        if len(energy_counts) != len(set(energy_counts)):
            result["zpe_warning"] = (
                "Ambiguous ZPE pairing: multiple systems have the same atom count. "
                "ZPE may be assigned to the wrong system. Consider verifying manually."
            )

        # Compute dZPE — only include terms that exist
        dZPE = 0.0
        zpe_applied = False

        if zpe_slab_ads is not None:
            dZPE += zpe_slab_ads
            result["ZPE_slab_adsorbate_eV"] = zpe_slab_ads
            zpe_applied = True
        if zpe_slab is not None:
            dZPE -= zpe_slab
            result["ZPE_clean_slab_eV"] = zpe_slab
            zpe_applied = True
        if zpe_ref is not None:
            dZPE -= ref_coefficient * zpe_ref
            result["ZPE_reference_eV"] = zpe_ref
            zpe_applied = True

        if zpe_applied:
            E_ads_zpe = E_ads + dZPE
            result["E_ads_ZPE_eV"] = E_ads_zpe
            result["dZPE_eV"] = dZPE

            if E_ads_zpe < 0:
                result["binding_zpe"] = "exothermic"
                result["binding_strength_zpe_eV"] = abs(E_ads_zpe)
            else:
                result["binding_zpe"] = "endothermic"

    # Binding assessment (electronic)
    if E_ads < 0:
        result["binding"] = "exothermic"
        result["binding_strength_eV"] = abs(E_ads)
    else:
        result["binding"] = "endothermic"

    return result


def _analyze_coverage(
    parent_ids: list[str],
    step_results: dict[str, dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Analyze adsorption energy as a function of surface coverage.

    Collects energies from fan-out coverage relaxation branches, a clean slab
    reference, and a gas-phase reference molecule. Computes per-adsorbate
    adsorption energy at each coverage and fits a linear trend.

    E_ads/adsorbate = [E(slab+nX) - E(slab) - n * coeff * E(ref)] / n

    theta = n / n_surface_sites
    """
    import re

    import numpy as np

    ref_coefficient = float(params.get("reference_coefficient", 0.5))
    n_surface_sites = int(params.get("n_surface_sites", 0))
    species = params.get("species", "H")

    # Classify parents
    fan_out_results: list[dict[str, Any]] = []
    single_parents: list[dict[str, Any]] = []

    for pid in parent_ids:
        parent = step_results.get(pid, {})
        if parent.get("_fan_out") and isinstance(parent.get("results"), list):
            fan_out_results.append(parent)
            # Try to get n_surface_sites from the coverage generator
            if n_surface_sites <= 0 and parent.get("n_surface_sites"):
                n_surface_sites = int(parent["n_surface_sites"])
        else:
            # Collect energy and n_atoms for single parents
            energy = parent.get("energy") or parent.get("final_energy")
            if energy is None:
                summary = parent.get("summary", {})
                energy = summary.get("energy") or summary.get("final_energy")
            if energy is None:
                continue

            n_atoms = parent.get("n_atoms")
            if n_atoms is None:
                atoms = _try_load_atoms(parent)
                if atoms is not None:
                    n_atoms = len(atoms)

            single_parents.append({
                "step_id": pid,
                "energy": float(energy),
                "n_atoms": n_atoms,
            })

    if not fan_out_results:
        return {
            "status": "error",
            "analysis_type": "coverage_analysis",
            "error": "No fan-out parent found. Connect coverage relaxation results upstream.",
        }

    # Identify clean slab (most atoms) and reference (fewest atoms) from single parents
    E_slab = None
    E_ref = None
    if single_parents:
        with_atoms = [p for p in single_parents if p["n_atoms"] is not None]
        if with_atoms:
            with_atoms.sort(key=lambda x: x["n_atoms"], reverse=True)
            E_slab = with_atoms[0]["energy"]
            if len(with_atoms) > 1:
                E_ref = with_atoms[-1]["energy"]
        else:
            # Fallback: first = slab, last = ref
            E_slab = single_parents[0]["energy"]
            if len(single_parents) > 1:
                E_ref = single_parents[-1]["energy"]

    if E_slab is None:
        return {
            "status": "error",
            "analysis_type": "coverage_analysis",
            "error": "Could not identify clean slab energy from parent nodes.",
        }

    if E_ref is None:
        E_ref = 0.0
        logger.warning("coverage_analysis: no reference energy found, using 0.0")

    # Extract per-branch data from fan-out results
    coverage_data: list[dict[str, Any]] = []

    for fo_parent in fan_out_results:
        for branch in fo_parent.get("results", []):
            r_result = branch.get("result", {})
            label = branch.get("label", "")

            # Get energy from branch result
            energy = r_result.get("energy") or r_result.get("final_energy")
            if energy is None:
                summary = r_result.get("summary", {})
                energy = summary.get("energy") or summary.get("final_energy")
            if energy is None:
                continue
            energy = float(energy)

            # Parse adsorbate count from label (e.g. "3H-0.25ML")
            n_ads = None
            m = re.match(r"(\d+)" + re.escape(species.upper()), label)
            if m:
                n_ads = int(m.group(1))
            else:
                # Try generic digit pattern
                m2 = re.match(r"(\d+)", label)
                if m2:
                    n_ads = int(m2.group(1))

            if n_ads is None or n_ads <= 0:
                logger.warning(
                    "coverage_analysis: could not parse adsorbate count from label '%s', skipping",
                    label,
                )
                continue

            # E_ads per adsorbate
            e_ads_per = (energy - E_slab - n_ads * ref_coefficient * E_ref) / n_ads

            theta = n_ads / n_surface_sites if n_surface_sites > 0 else float(n_ads)

            coverage_data.append({
                "n_adsorbates": n_ads,
                "theta": theta,
                "E_total_eV": energy,
                "E_ads_per_eV": e_ads_per,
                "label": label,
            })

    if len(coverage_data) < 2:
        return {
            "status": "error",
            "analysis_type": "coverage_analysis",
            "error": f"Need at least 2 coverage data points, got {len(coverage_data)}.",
        }

    # Sort by theta
    coverage_data.sort(key=lambda d: d["theta"])

    thetas = np.array([d["theta"] for d in coverage_data])
    e_ads_arr = np.array([d["E_ads_per_eV"] for d in coverage_data])

    # Linear fit: E_ads(theta) = a * theta + b
    if len(set(thetas.tolist())) < 2:
        slope = 0.0
        intercept = float(np.mean(e_ads_arr))
    else:
        coeffs = np.polyfit(thetas, e_ads_arr, 1)
        slope = float(coeffs[0])
        intercept = float(coeffs[1])
        # Guard against inf/nan from ill-conditioned fit
        if not (np.isfinite(slope) and np.isfinite(intercept)):
            slope = 0.0
            intercept = float(np.mean(e_ads_arr))

    # R-squared
    e_pred = slope * thetas + intercept
    ss_res = float(np.sum((e_ads_arr - e_pred) ** 2))
    ss_tot = float(np.sum((e_ads_arr - np.mean(e_ads_arr)) ** 2))
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    # Generate smooth fit curve for plotting
    theta_fit = np.linspace(
        max(0.0, float(thetas.min()) - 0.05),
        float(thetas.max()) + 0.05,
        50,
    )
    e_fit = (slope * theta_fit + intercept).tolist()

    return {
        "status": "completed",
        "analysis_type": "coverage_analysis",
        "species": species,
        "n_surface_sites": n_surface_sites,
        "reference_coefficient": ref_coefficient,
        "E_clean_slab_eV": E_slab,
        "E_reference_eV": E_ref,
        "n_points": len(coverage_data),
        "data_points": coverage_data,
        # Frontend-compatible arrays (NodeStatusPanel expects these keys)
        "coverages": [d["theta"] for d in coverage_data],
        "adsorbate_counts": [d["n_adsorbates"] for d in coverage_data],
        "e_ads_per_h": [d["E_ads_per_eV"] for d in coverage_data],
        "fit": {
            "slope": slope,
            "intercept": intercept,
            "r_squared": r_squared,
        },
        "fit_curve": {
            "coverages": theta_fit.tolist(),
            "energies": e_fit,
        },
    }

"""Result enrichment logic extracted from the workflow router.

Contains:
- Convergence point expansion (ORCA opt/IRC/NEB-TS/UV-Vis)
- Frequency fetching
- Part B result building (non-structure ORCA nodes from V1 workflow_steps)
- Part C result building (ORCA nodes from V2 task_results table)
"""

import json
import logging

logger = logging.getLogger(__name__)


def expand_convergence_points(
    base_row: dict,
    convergence_points: list,
    node_type: str,
    step_label: str,
) -> list[dict]:
    """Expand one result row into multiple rows: one per convergence step/image/state.

    Returns empty list if 0-1 convergence points (caller handles single-point case).
    """
    if not convergence_points or len(convergence_points) <= 1:
        return []

    rows = []
    for point in convergence_points:
        r = base_row.copy()
        r["energy"] = point.get("energy")

        # Add UV-Vis specific fields when present
        if "wavelength_nm" in point:
            r["wavelength_nm"] = point["wavelength_nm"]
        if "oscillator_strength" in point:
            r["oscillator_strength"] = point["oscillator_strength"]

        # Label by node type (handles both resolved and unified type names)
        if node_type in ("orca_neb_ts", "ts_search"):
            r["step_label"] = f"{step_label} (Image {point.get('step', 1)})"
        elif node_type in ("orca_irc", "irc"):
            r["step_label"] = f"{step_label} (IRC Step {point.get('step', 1)})"
        elif node_type in ("orca_freq", "freq"):
            r["step_label"] = f"{step_label} (Frequency Analysis)"
        elif node_type in ("orca_sp", "single_point"):
            r["step_label"] = f"{step_label} (Energy)"
        elif node_type in ("orca_uvvis", "uvvis"):
            wavelength = point.get("wavelength_nm")
            state_num = point.get("state", point.get("step", 1))
            if wavelength:
                r["step_label"] = f"{step_label} (State {state_num}: {wavelength:.1f} nm)"
            else:
                r["step_label"] = f"{step_label} (State {state_num})"
        else:
            # orca_opt and anything else: show step number
            r["step_label"] = f"{step_label} (Step {point.get('step', 1)})"
        rows.append(r)
    return rows


def fetch_convergence_points(step_ids: list[str]) -> dict[str, list]:
    """Batch-fetch convergence_points from result_json for opt/neb_ts/irc steps.

    Returns {step_id: [convergence_points]} dict. Runs in thread pool to avoid
    blocking the async event loop with SQLite reads.
    """
    from catgo.utils.workflow_db import get_db

    if not step_ids:
        return {}
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT id, result_json FROM workflow_steps WHERE id IN ({','.join('?' * len(step_ids))})",
            step_ids,
        ).fetchall()
    result = {}
    for r in rows:
        rj = json.loads(r["result_json"] or "{}")
        result[r["id"]] = rj.get("convergence_points", [])
    return result


def fetch_frequencies(step_ids: list[str]) -> dict[str, list]:
    """Batch-fetch vibrational frequencies from result_json for orca_freq steps.

    Returns {step_id: [frequencies]} dict. Runs in thread pool to avoid
    blocking the async event loop with SQLite reads.
    """
    from catgo.utils.workflow_db import get_db

    if not step_ids:
        return {}
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT id, result_json FROM workflow_steps WHERE id IN ({','.join('?' * len(step_ids))})",
            step_ids,
        ).fetchall()
    result = {}
    for r in rows:
        rj = json.loads(r["result_json"] or "{}")
        result[r["id"]] = rj.get("frequencies", [])
    return result


def build_part_b_results(step_rows: list) -> list:
    """Build Part B results (non-structure ORCA nodes) synchronously in thread pool.

    This function runs on a separate thread so json.loads() and dict construction
    don't block the FastAPI async event loop.
    """
    results = []
    for row in step_rows:
        try:
            result_json = json.loads(row["result_json"])
            step_label = row["label"] or row["node_type"]
            node_type = row["node_type"]
            convergence_points = result_json.get("convergence_points", [])

            # Create base result row
            base_result = {
                "id": None,
                "formula": result_json.get("formula"),
                "energy": result_json.get("energy_ev"),  # energy in eV
                "energy_per_atom": None,
                "natoms": None,
                "volume": None,
                "a": None, "b": None, "c": None,
                "alpha": None, "beta": None, "gamma": None,
                "workflow_id": row["workflow_id"],
                "workflow_name": row["wf_name"],
                "step_id": row["id"],
                "step_label": step_label,
                "node_type": node_type,
                "energy_eh": result_json.get("energy_eh"),
            }

            # Handle IRC special case: use forward endpoint energy if main energy is missing
            if base_result["energy"] is None and node_type in ("orca_irc", "irc"):
                fwd = result_json.get("forward_endpoint", {})
                eh = fwd.get("final_energy")
                if eh is not None:
                    base_result["energy"] = eh * 27.2114

            # Add type-specific plot data for frontend
            # Override empty formula with parsed formula from result_json
            if result_json.get("formula") and not base_result.get("formula"):
                base_result["formula"] = result_json["formula"]

            if node_type in ("orca_freq", "freq"):
                # Vibrational frequencies for frequency spectrum plot
                base_result["frequencies"] = result_json.get("frequencies", [])
                base_result["num_imaginary"] = result_json.get("num_imaginary", 0)
                # Include Gibbs correction if auto-computed
                gibbs = result_json.get("gibbs")
                if gibbs:
                    base_result["gibbs_g_corr_ev"] = gibbs.get("g_corr_ev")
                    base_result["gibbs_zpe_ev"] = gibbs.get("zpe_ev")
                    base_result["gibbs_mode"] = gibbs.get("mode")
                    base_result["gibbs_temperature"] = gibbs.get("temperature")
                results.append(base_result)
            elif node_type in ("orca_uvvis", "uvvis"):
                # Electronic states for absorption spectrum plot (single row, no expansion)
                base_result["absorption_states"] = result_json.get("transitions", result_json.get("convergence_points", []))
                base_result["n_transitions"] = result_json.get("n_transitions", 0)
                base_result["brightest_wavelength_nm"] = result_json.get("brightest_wavelength_nm")
                results.append(base_result)
            elif node_type in ("orca_neb_ts", "ts_search", "orca_irc", "irc"):
                # NEB-TS: expand energy per image; IRC: expand energy per IRC step
                # Add NEB-specific fields for NEB nodes
                if node_type in ("orca_neb_ts", "ts_search"):
                    base_result["activation_barrier_kcal_mol"] = result_json.get("activation_barrier_kcal_mol")
                    base_result["neb_converged"] = result_json.get("neb_converged", False)
                    base_result["path_summary"] = result_json.get("path_summary")
                    # Per-iteration image energies from ORCA.interp for dashboard graphs
                    if result_json.get("image_energies"):
                        base_result["image_energies"] = result_json["image_energies"]

                if len(convergence_points) > 1:
                    expanded = expand_convergence_points(base_result, convergence_points, node_type, step_label)
                    if expanded:
                        results.extend(expanded)
                    else:
                        results.append(base_result)
                else:
                    results.append(base_result)
            elif node_type == "slow_growth":
                # Slow-growth barrier analysis from REPORT auto-parsing
                sg = result_json.get("slow_growth", {})
                if sg:
                    base_result["barrier_forward_eV"] = sg.get("barrier_forward_eV")
                    base_result["barrier_reverse_eV"] = sg.get("barrier_reverse_eV")
                    base_result["barrier_forward_kcal"] = sg.get("barrier_forward_kcal")
                    base_result["barrier_reverse_kcal"] = sg.get("barrier_reverse_kcal")
                    base_result["total_delta_F_eV"] = sg.get("total_delta_F_eV")
                    base_result["cv_start"] = sg.get("cv_start")
                    base_result["cv_end"] = sg.get("cv_end")
                results.append(base_result)
            else:
                # orca_sp and other single-result types
                results.append(base_result)

        except Exception as e:
            logger.warning("Failed to parse result_json for step %s: %s", row["id"], e)

    return results


# ─── Part C: V2 engine results (task_results table) ───────────────────────────


def fetch_v2_task_results_for_project(project_id: str) -> list[dict]:
    """Query V2 task_results for all completed ORCA tasks in a project.

    Joins task_results → tasks → workflows filtered by project_id.
    Filters by tasks.software = 'orca' (the tasks table stores unified type
    names like 'geo_opt'/'freq', not engine-specific names like 'orca_opt').
    Returns raw dicts; call via asyncio.to_thread().
    """
    import sqlite3
    from catgo.routers.workflow_engine import _db as engine_db
    from catgo.utils.workflow_db import get_db as get_workflow_db

    if engine_db is None:
        logger.debug("fetch_v2_task_results_for_project: engine_db is None, returning empty list")
        return []

    # Get workflows assigned to this project from the V1 workflow database
    assigned_workflow_ids = []
    try:
        with get_workflow_db() as wf_conn:
            proj_wfs = wf_conn.execute(
                "SELECT id FROM workflows WHERE project_id = ?",
                (project_id,)
            ).fetchall()
            assigned_workflow_ids = [row["id"] for row in proj_wfs]
            logger.debug(f"fetch_v2_task_results_for_project: {project_id} has {len(assigned_workflow_ids)} workflows with project_id set")
    except Exception as e:
        logger.debug(f"fetch_v2_task_results_for_project: could not fetch workflows with project_id: {e}")

    try:
        conn = sqlite3.connect(engine_db.db_path)
        conn.row_factory = sqlite3.Row

        if assigned_workflow_ids:
            wf_placeholders = ",".join("?" * len(assigned_workflow_ids))
            rows = conn.execute(
                f"""
                SELECT
                    tr.task_id,
                    tr.workflow_id,
                    tr.energy,
                    tr.outputs_json,
                    t.task_type,
                    t.name       AS task_name,
                    t.params_json,
                    t.system_name,
                    w.name       AS wf_name
                FROM task_results tr
                JOIN tasks t  ON t.id  = tr.task_id
                JOIN workflows w ON w.id = tr.workflow_id
                WHERE w.id IN ({wf_placeholders})
                  AND t.software = 'orca'
                  AND t.status IN ('COMPLETED', 'COMPLETED_REMOTE')
                """,
                (*assigned_workflow_ids,),
            ).fetchall()
        else:
            rows = []

        conn.close()
        result = [dict(r) for r in rows]
        logger.debug(f"fetch_v2_task_results_for_project({project_id}): found {len(result)} V2 task results from {len(assigned_workflow_ids)} workflows")
        return result
    except Exception as e:
        logger.warning("fetch_v2_task_results_for_project failed: %s", e, exc_info=True)
        return []


def fetch_v2_task_results_by_workflow(workflow_id: str) -> list[dict]:
    """Query V2 task_results for all completed ORCA tasks in a workflow.

    Joins task_results → tasks filtered by workflow_id (not project_id).
    Filters by tasks.software = 'orca' (unified type names in task_type column).
    Returns raw dicts; call via asyncio.to_thread().
    """
    import sqlite3
    from catgo.routers.workflow_engine import _db as engine_db
    if engine_db is None:
        return []

    try:
        conn = sqlite3.connect(engine_db.db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT
                tr.task_id,
                tr.workflow_id,
                tr.energy,
                tr.outputs_json,
                t.task_type,
                t.name       AS task_name,
                t.params_json,
                t.system_name,
                (SELECT name FROM workflows WHERE id = ?) AS wf_name
            FROM task_results tr
            JOIN tasks t  ON t.id  = tr.task_id
            WHERE tr.workflow_id = ?
              AND t.software = 'orca'
              AND t.status IN ('COMPLETED', 'COMPLETED_REMOTE')
            """,
            (workflow_id, workflow_id),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning("fetch_v2_task_results_by_workflow failed: %s", e)
        return []


def build_part_c_results(task_rows: list[dict]) -> list[dict]:
    """Build Part C results from V2 task_results rows.

    Converts V2 task_results + tasks rows into EnrichedResult dicts
    with the same shape as build_part_b_results output.

    The tasks table stores unified type names (geo_opt, freq, etc.) in
    task_type, but each ORCA collector writes the engine-specific type
    (orca_opt, orca_freq, etc.) into outputs_json["type"].  We branch on
    that outputs type so formatting is correct regardless of the DB column.
    """
    results = []
    logger.debug(f"build_part_c_results: processing {len(task_rows)} V2 task rows")
    for row in task_rows:
        try:
            outputs = json.loads(row.get("outputs_json") or "{}")
            if outputs.get("error"):
                continue

            task_type = row["task_type"]
            params = json.loads(row.get("params_json") or "{}")

            # Engine-specific type written by the ORCA collectors
            # (e.g. "orca_freq", "orca_opt") — used for result formatting.
            orca_type = outputs.get("type", "")

            step_label = (
                row.get("task_name")
                or params.get("label")
                or task_type
            )
            formula = (
                row.get("system_name")
                or params.get("system_name")
                or params.get("formula")
                or outputs.get("formula")
            )

            energy_ev = row.get("energy") or outputs.get("energy_ev") or outputs.get("energy")
            energy_eh = outputs.get("energy_eh")

            base_result = {
                "id": None,
                "formula": formula,
                "energy": energy_ev,
                "energy_per_atom": None,
                "natoms": None,
                "volume": None,
                "a": None, "b": None, "c": None,
                "alpha": None, "beta": None, "gamma": None,
                "workflow_id": row["workflow_id"],
                "workflow_name": row["wf_name"],
                "step_id": row["task_id"],
                "step_label": step_label,
                "node_type": orca_type or task_type,
                "energy_eh": energy_eh,
            }

            convergence_points = outputs.get("convergence_points", [])

            if orca_type == "orca_freq":
                base_result["frequencies"] = outputs.get("frequencies", [])
                base_result["num_imaginary"] = outputs.get("num_imaginary", 0)
                gibbs_eh = outputs.get("gibbs_eh")
                if gibbs_eh is not None:
                    base_result["gibbs_g_corr_ev"] = gibbs_eh * 27.211386
                    zpe_kj = outputs.get("zpe_kj_mol", 0) or 0
                    base_result["gibbs_zpe_ev"] = zpe_kj / 96.485
                results.append(base_result)

            elif orca_type == "orca_uvvis":
                base_result["absorption_states"] = outputs.get(
                    "transitions", outputs.get("convergence_points", [])
                )
                base_result["n_transitions"] = outputs.get("n_transitions", 0)
                base_result["brightest_wavelength_nm"] = outputs.get("brightest_wavelength_nm")
                results.append(base_result)

            elif orca_type == "orca_neb_ts":
                base_result["activation_barrier_kcal_mol"] = outputs.get("activation_barrier_kcal_mol")
                base_result["neb_converged"] = outputs.get("neb_converged", False)
                base_result["path_summary"] = outputs.get("path_summary")
                if outputs.get("image_energies"):
                    base_result["image_energies"] = outputs["image_energies"]
                if convergence_points:
                    base_result["convergence_points"] = convergence_points
                results.append(base_result)

            elif orca_type == "orca_irc":
                if base_result["energy"] is None:
                    fwd = outputs.get("forward_endpoint", {})
                    eh = fwd.get("final_energy")
                    if eh is not None:
                        base_result["energy"] = eh * 27.211386
                if convergence_points:
                    base_result["convergence_points"] = convergence_points
                results.append(base_result)

            elif orca_type == "orca_opt":
                if convergence_points:
                    base_result["convergence_points"] = convergence_points
                    final_energy = convergence_points[-1].get("energy")
                    if final_energy is not None and base_result["energy"] is None:
                        base_result["energy"] = final_energy
                results.append(base_result)

            else:
                # orca_sp or any other single-result type
                results.append(base_result)

        except Exception as e:
            logger.warning("Failed to parse outputs_json for V2 task %s: %s", row.get("task_id"), e, exc_info=True)

    logger.debug(f"build_part_c_results: built {len(results)} enriched results from {len(task_rows)} rows")
    return results


# ─── V2-native enriched results (#224 Phase 2) ───────────────────────────────


def build_enriched_results_for_workflow(db, workflow_id: str) -> list[dict]:
    """Build dashboard-enriched results for a workflow from the V2 store ONLY.

    Mirrors the response shape of the V1 ``GET /api/workflow/{id}/results-enriched``
    endpoint (see catgo/routers/workflow.py), but reads exclusively from the V2
    ``WorkflowDB`` instead of the legacy ase_db / ``workflow_steps`` tables:

      * iterate the workflow's tasks via ``db.get_all_tasks``
      * join each task's stored result via ``db.get_result``
      * attach provenance via ``db.get_provenance`` (best-effort, additive)

    Unlike :func:`fetch_v2_task_results_by_workflow` (which filters to
    ``software = 'orca'`` for the V1 Part-C merge), this V2-native path surfaces
    *every* task with a stored result regardless of engine (vasp / cp2k / orca /
    mlp / …). ORCA tasks are formatted via :func:`build_part_c_results` so the
    engine-specific fields (frequencies, convergence_points, NEB/IRC, UV-Vis)
    stay identical to the V1 merge; all other engines get the generic enriched
    base row.

    Each returned dict carries the same keys the FE dashboard expects:
    ``id, formula, energy, energy_per_atom, natoms, volume, a, b, c, alpha,
    beta, gamma, workflow_id, workflow_name, step_id, step_label, node_type``.
    """
    try:
        wf = db.get_workflow(workflow_id)
        wf_name = wf.get("name") or workflow_id
    except KeyError:
        raise
    except Exception:
        wf_name = workflow_id

    tasks = db.get_all_tasks(workflow_id)

    # Rows destined for the ORCA-aware formatter, shaped like the SQL join in
    # fetch_v2_task_results_by_workflow so build_part_c_results works unchanged.
    orca_rows: list[dict] = []
    generic_results: list[dict] = []

    for task in tasks:
        task_id = task.get("id")
        try:
            result = db.get_result(task_id)
        except Exception:
            result = None
        if not result:
            continue  # task has no stored result yet — nothing to enrich

        try:
            outputs = json.loads(result.get("outputs_json") or "{}")
        except Exception:
            outputs = {}
        if outputs.get("error"):
            continue

        try:
            params = json.loads(task.get("params_json") or "{}")
        except Exception:
            params = {}

        software = (task.get("software") or params.get("software") or "").lower()

        common_row = {
            "task_id": task_id,
            "workflow_id": result.get("workflow_id") or workflow_id,
            "energy": result.get("energy"),
            "outputs_json": result.get("outputs_json") or "{}",
            "task_type": task.get("task_type"),
            "task_name": task.get("name"),
            "params_json": task.get("params_json") or "{}",
            "system_name": task.get("system_name"),
            "wf_name": wf_name,
        }

        if software == "orca" or outputs.get("type", "").startswith("orca"):
            orca_rows.append(common_row)
            continue

        # Generic (non-ORCA) enriched base row — same key set as build_part_c.
        task_type = task.get("task_type")
        step_label = task.get("name") or params.get("label") or task_type
        formula = (
            task.get("system_name")
            or params.get("system_name")
            or params.get("formula")
            or outputs.get("formula")
        )
        energy = result.get("energy")
        if energy is None:
            energy = outputs.get("energy_ev") or outputs.get("energy")
        natoms = outputs.get("natoms")
        energy_per_atom = None
        if energy is not None and isinstance(natoms, (int, float)) and natoms:
            energy_per_atom = energy / natoms

        base_result = {
            "id": None,
            "formula": formula,
            "energy": energy,
            "energy_per_atom": energy_per_atom,
            "natoms": natoms,
            "volume": outputs.get("volume"),
            "a": outputs.get("a"), "b": outputs.get("b"), "c": outputs.get("c"),
            "alpha": outputs.get("alpha"), "beta": outputs.get("beta"),
            "gamma": outputs.get("gamma"),
            "workflow_id": result.get("workflow_id") or workflow_id,
            "workflow_name": wf_name,
            "step_id": task_id,
            "step_label": step_label,
            "node_type": task_type,
            "energy_eh": outputs.get("energy_eh"),
        }

        convergence_points = outputs.get("convergence_points", [])
        if convergence_points:
            base_result["convergence_points"] = convergence_points
            if base_result["energy"] is None:
                final_energy = convergence_points[-1].get("energy")
                if final_energy is not None:
                    base_result["energy"] = final_energy

        # Provenance (best-effort, additive — never blocks the row).
        try:
            prov = db.get_provenance(task_id)
            if prov:
                base_result["provenance"] = prov
        except Exception:
            pass

        generic_results.append(base_result)

    enriched = build_part_c_results(orca_rows) if orca_rows else []

    # Attach provenance to ORCA rows too (best-effort) so the shape is uniform.
    for row in enriched:
        sid = row.get("step_id")
        if not sid:
            continue
        try:
            prov = db.get_provenance(sid)
            if prov:
                row["provenance"] = prov
        except Exception:
            pass

    enriched.extend(generic_results)
    return enriched

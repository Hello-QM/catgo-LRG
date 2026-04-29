"""Result enrichment logic extracted from the workflow router.

Contains:
- Convergence point expansion (ORCA opt/IRC/NEB-TS/UV-Vis)
- Frequency fetching
- Part B result building (non-structure ORCA nodes)
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

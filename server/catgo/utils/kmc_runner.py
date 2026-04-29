"""KMC simulation runner — wraps leshenzhang/KMC (mykmc package).

Provides async-friendly wrappers around the mykmc KMC engine and
mean-field microkinetic solver for use in CatGO workflow nodes,
REST endpoints, and MCP tools.
"""

import json
import logging
import sys
from pathlib import Path
from typing import Any, Optional

import numpy as np

logger = logging.getLogger(__name__)

# Add KMC submodule to path
_KMC_ROOT = Path(__file__).resolve().parent.parent / "ext" / "KMC"
if str(_KMC_ROOT) not in sys.path:
    sys.path.insert(0, str(_KMC_ROOT))


def _import_mykmc():
    """Lazy import mykmc to avoid startup cost."""
    import mykmc  # noqa: F811
    return mykmc


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def load_model_from_json(model_json: dict) -> Any:
    """Build a mykmc.Project from a JSON model dict (co_model.json format)."""
    mykmc = _import_mykmc()
    from mykmc.types import Project, Condition, Action, Coord, Site, Layer

    pt = Project()
    meta = model_json.get("meta", {})
    pt.set_meta(**meta)

    # Species
    for sp in model_json.get("species", []):
        pt.add_species(name=sp["name"], color=sp.get("color"), tags=sp.get("tags"))

    # Parameters
    for p in model_json.get("parameters", []):
        pt.add_parameter(
            name=p["name"],
            value=p["value"],
            adjustable=p.get("adjustable", False),
            min=p.get("min", 0.0),
            max=p.get("max", 0.0),
        )

    # Lattice
    lattice_data = model_json.get("lattice", {})
    if "cell" in lattice_data:
        pt.lattice.cell = np.array(lattice_data["cell"])
    for layer_data in lattice_data.get("layers", []):
        layer = Layer(name=layer_data.get("name", "default"))
        for site_data in layer_data.get("sites", []):
            site = Site(
                name=site_data["name"],
                pos=tuple(site_data.get("pos", (0.5, 0.5, 0.5))),
                default_species=site_data.get("default_species", "empty"),
            )
            layer.sites.append(site)
        pt.lattice.layers.append(layer)

    # Processes
    for proc_data in model_json.get("processes", []):
        conditions = []
        for c in proc_data.get("conditions", []):
            coord = Coord(offset=tuple(c.get("offset", (0, 0, 0))))
            conditions.append(Condition(coord, c["species"]))
        actions = []
        for a in proc_data.get("actions", []):
            coord = Coord(offset=tuple(a.get("offset", (0, 0, 0))))
            actions.append(Action(coord, a["species"]))
        pt.add_process(
            name=proc_data["name"],
            conditions=conditions,
            actions=actions,
            rate_constant=proc_data.get("rate_constant", "0"),
            tof_count=proc_data.get("tof_count", {}),
        )

    return pt


# ---------------------------------------------------------------------------
# KMC simulation
# ---------------------------------------------------------------------------

def run_kmc(
    model_json: dict,
    temperature: float = 300.0,
    potential: float = 0.0,
    lattice_size: int = 20,
    steps: int = 100000,
    record_interval: int = 1000,
) -> dict[str, Any]:
    """Run lattice KMC simulation and return results.

    Returns dict with keys: coverages, tof, trajectory, process_stats, metadata.
    """
    mykmc = _import_mykmc()
    from mykmc.engine import KMCEngine
    from mykmc.analysis import TrajectoryRecorder

    project = load_model_from_json(model_json)

    # Set temperature and potential if they exist as parameters
    engine = KMCEngine(project, size=[lattice_size, lattice_size], print_rates=False, banner=False)
    if hasattr(engine.parameters, "T"):
        engine.parameters.T = temperature
    if hasattr(engine.parameters, "U"):
        engine.parameters.U = potential
    if hasattr(engine.parameters, "p_N2"):
        pass  # keep default

    recorder = TrajectoryRecorder(engine)

    # Run with periodic recording
    steps_per_interval = max(1, steps // max(1, steps // record_interval))
    n_intervals = steps // steps_per_interval

    trajectory_time = []
    trajectory_coverage = []

    for _ in range(n_intervals):
        engine.do_steps(steps_per_interval)
        cov = engine.get_coverage()
        trajectory_time.append(engine.kmc_time)
        trajectory_coverage.append(cov)

    # Final state
    final_coverage = engine.get_coverage()
    tof = engine.get_tof()
    process_stats = engine.get_process_stats()

    return {
        "coverages": final_coverage,
        "tof": {k: float(v) for k, v in tof.items()},
        "process_stats": process_stats,
        "trajectory": {
            "time": trajectory_time,
            "coverage": trajectory_coverage,
        },
        "metadata": {
            "temperature": temperature,
            "potential": potential,
            "lattice_size": lattice_size,
            "total_steps": engine.kmc_step,
            "total_time": engine.kmc_time,
            "model_name": project.meta.get("model_name", ""),
        },
    }


# ---------------------------------------------------------------------------
# Mean-field microkinetic model
# ---------------------------------------------------------------------------

def run_microkinetic(
    model_json: dict,
    temperature: float = 300.0,
    potential: float = 0.0,
    t_end: float = 1e6,
) -> dict[str, Any]:
    """Run mean-field microkinetic model and return steady-state results.

    Returns dict with keys: coverages, tof, rates, metadata.
    """
    mykmc = _import_mykmc()
    from mykmc.microkinetic import MicroKineticModel
    from mykmc.rates import evaluate_rate_expression

    project = load_model_from_json(model_json)

    # Build parameter dict
    param_dict = {p.name: p.value for p in project.parameter_list}
    param_dict["T"] = temperature
    param_dict["U"] = potential

    mkm = MicroKineticModel()

    # Add species (skip 'empty')
    species_names = [sp.name for sp in project.species_list if sp.name != "empty"]
    for name in species_names:
        mkm.add_species(name)

    # Add reactions from processes (pair forward/reverse)
    added = set()
    process_list = project.process_list
    for proc in process_list:
        if proc.name in added:
            continue

        # Find reverse process by matching reversed conditions/actions
        reverse = None
        for other in process_list:
            if other.name == proc.name or other.name in added:
                continue
            # Check if conditions/actions are swapped
            proc_cond_sp = {c.species for c in proc.conditions}
            proc_act_sp = {a.species for a in proc.actions}
            other_cond_sp = {c.species for c in other.conditions}
            other_act_sp = {a.species for a in other.actions}
            if proc_cond_sp == other_act_sp and proc_act_sp == other_cond_sp:
                reverse = other
                break

        # Determine reactants and products (skip 'empty' for MKM)
        reactants = {c.species: 1 for c in proc.conditions if c.species != "empty"}
        products = {a.species: 1 for a in proc.actions if a.species != "empty"}

        rate_fwd = evaluate_rate_expression(proc.rate_constant, param_dict)
        rate_rev = evaluate_rate_expression(reverse.rate_constant, param_dict) if reverse else 0.0

        mkm.add_reaction(
            name=proc.name,
            reactants=reactants,
            products=products,
            rate_fwd=rate_fwd,
            rate_rev=rate_rev,
            tof_count=proc.tof_count,
        )

        added.add(proc.name)
        if reverse:
            added.add(reverse.name)

    # Solve steady state
    try:
        theta_ss = mkm.solve_steady_state()
    except Exception:
        # Fallback to ODE integration
        sol = mkm.solve_ode(t_span=(0, t_end))
        theta_ss = sol.y[:, -1]

    # Build coverage dict
    coverages = {}
    for i, name in enumerate(species_names):
        coverages[name] = float(theta_ss[i]) if i < len(theta_ss) else 0.0
    coverages["empty"] = max(0.0, 1.0 - sum(coverages.values()))

    # TOF
    tof = mkm.get_tof(theta_ss)

    return {
        "coverages": coverages,
        "tof": {k: float(v) for k, v in tof.items()},
        "metadata": {
            "temperature": temperature,
            "potential": potential,
            "model_name": project.meta.get("model_name", ""),
            "method": "mean_field_ode",
        },
    }


# ---------------------------------------------------------------------------
# Parameter scans
# ---------------------------------------------------------------------------

def run_potential_scan(
    model_json: dict,
    temperature: float = 300.0,
    u_min: float = -0.5,
    u_max: float = -3.0,
    u_steps: int = 20,
    method: str = "mkm",
    lattice_size: int = 20,
    kmc_steps: int = 100000,
) -> dict[str, Any]:
    """Scan across applied potentials and collect TOF/coverage.

    method: 'mkm' (fast mean-field) or 'kmc' (stochastic).
    """
    potentials = np.linspace(u_min, u_max, u_steps).tolist()
    results = []

    for u in potentials:
        if method == "kmc":
            r = run_kmc(model_json, temperature=temperature, potential=u,
                        lattice_size=lattice_size, steps=kmc_steps)
        else:
            r = run_microkinetic(model_json, temperature=temperature, potential=u)
        results.append({
            "potential": u,
            "coverages": r["coverages"],
            "tof": r["tof"],
        })

    return {
        "scan_type": "potential",
        "method": method,
        "temperature": temperature,
        "potentials": potentials,
        "results": results,
        "model_name": model_json.get("meta", {}).get("model_name", ""),
    }


def run_temperature_scan(
    model_json: dict,
    potential: float = -1.0,
    t_min: float = 250.0,
    t_max: float = 500.0,
    t_steps: int = 20,
    method: str = "mkm",
    lattice_size: int = 20,
    kmc_steps: int = 100000,
) -> dict[str, Any]:
    """Scan across temperatures and collect TOF/coverage."""
    temperatures = np.linspace(t_min, t_max, t_steps).tolist()
    results = []

    for t in temperatures:
        if method == "kmc":
            r = run_kmc(model_json, temperature=t, potential=potential,
                        lattice_size=lattice_size, steps=kmc_steps)
        else:
            r = run_microkinetic(model_json, temperature=t, potential=potential)
        results.append({
            "temperature": t,
            "coverages": r["coverages"],
            "tof": r["tof"],
        })

    return {
        "scan_type": "temperature",
        "method": method,
        "potential": potential,
        "temperatures": temperatures,
        "results": results,
        "model_name": model_json.get("meta", {}).get("model_name", ""),
    }

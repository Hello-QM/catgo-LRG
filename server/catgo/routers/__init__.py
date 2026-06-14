"""Lazy-loading re-exports of CatGo router modules.

Importing this package used to eagerly load every router module — including
heavy ones (heterostructure, vasp, md_clustering) — which added several
seconds to backend cold-start.  We now use PEP 562 module-level `__getattr__`
so each router module is imported the first time its public name is
accessed.  This preserves the existing public API (`from catgo.routers
import heterostructure_router` still works), but lets `server/main.py`
decide which routers to eagerly load at startup and which to defer.
"""

from __future__ import annotations

import importlib
from typing import Any

# Map: public attribute name  ->  relative submodule (without leading dot).
# Each submodule must expose its APIRouter instance as `router`.
_ROUTERS: dict[str, str] = {
    "optimize_router": "optimize",
    "optimize_ws_router": "optimize_ws",
    "qe_router": "qe",
    "lammps_router": "lammps",
    "forcefield_router": "forcefield",
    "vasp_router": "vasp",
    "optimade_router": "optimade",
    "pubchem_router": "pubchem",
    "mp_router": "materials_project",
    "cube_router": "cube",
    "water_layer_router": "water_layer",
    "moire_router": "moire",
    "nanotube_router": "nanotube",
    "heterostructure_router": "heterostructure",
    "reticular_router": "reticular",
    "mofdb_router": "mofdb",
    "md_distances_router": "md_distances",
    "md_angles_router": "md_angles",
    "md_rmsd_router": "md_rmsd",
    "md_density_router": "md_density",
    "md_hbonds_router": "md_hbonds",
    "md_clustering_router": "md_clustering",
    "md_dynamics_router": "md_dynamics",
    "md_orientation_router": "md_orientation",
    "md_cavitation_router": "md_cavitation",
    "hpc_router": "hpc",
    "workflow_router": "workflow",
    "dos_router": "dos",
    "cohp_router": "cohp",
    "bands_router": "bands",
    "pseudo_hydrogen_router": "pseudo_hydrogen",
    "build_router": "build",
    "trajectory_edit_router": "trajectory_edit",
    "trajectory_stream_router": "trajectory_stream",
    "pty_router": "pty",
    "orca_router": "orca",
    "chat_router": "chat",
    "structure_ops_router": "structure_ops",
    "paper_router": "paper",
    "view_capture_router": "view_capture",
    "cp2k_router": "cp2k",
    "chgcar_router": "chgcar",
    "plugins_router": "plugins",
    "tool_bridge_router": "tool_bridge",
    "freq_analysis_router": "freq_analysis",
    "system_router": "system",
    "hub_router": "hub",
    "atomate2_router": "atomate2",
    "quacc_router": "quacc",
    "file_sandbox_router": "file_sandbox",
    "kmc_router": "kmc",
    "skills_router": "skills",
    "campaign_router": "campaign",
}

__all__ = list(_ROUTERS.keys())


def __getattr__(name: str) -> Any:
    """Lazy-load router submodules on first access (PEP 562)."""
    mod_name = _ROUTERS.get(name)
    if mod_name is None:
        raise AttributeError(f"module 'catgo.routers' has no attribute {name!r}")
    mod = importlib.import_module(f".{mod_name}", package=__name__)
    router = mod.router
    # Cache on this module so subsequent accesses hit the normal attribute path.
    globals()[name] = router
    return router


def __dir__() -> list[str]:
    return sorted(list(globals().keys()) + __all__)

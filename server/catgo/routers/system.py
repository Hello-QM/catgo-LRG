"""System status and diagnostics endpoints."""
import importlib.util
import os
from collections import deque
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(prefix="/system", tags=["system"])

# Repo root: server/catgo/routers/system.py -> parents[3] == repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]

# Optional heavy deps we probe (find_spec only — never imported here).
_OPTIONAL_DEPS = ("pymatgen", "ase", "asyncssh", "numpy")

# THIN-SKIP router attribute names (mirror of main.py's THIN-SKIP block). When
# CATGO_THIN=1 these are intentionally absent — reported as "missing" so the
# wizard/CatBot can explain why heavy features are unavailable in thin mode.
_THIN_SKIP_ROUTERS = (
    "cube_router", "chgcar_router", "water_layer_router", "moire_router",
    "nanotube_router", "reticular_router", "dos_router", "cohp_router",
    "bands_router", "pseudo_hydrogen_router", "build_router", "paper_router",
    "freq_analysis_router", "kmc_router",
)

_error_log: deque[dict] = deque(maxlen=200)

def log_user_error(category: str, message: str, details: str = ""):
    """Record an error for the diagnostics panel."""
    _error_log.append({
        "timestamp": datetime.now().isoformat(),
        "category": category,
        "message": message,
        "details": details,
    })

@router.get("/errors")
def get_recent_errors(limit: int = 50):
    """Return the most recent error log entries."""
    return list(_error_log)[-limit:]

@router.get("/status")
def get_system_status():
    """Return backend and HPC connection status summary."""
    try:
        from catgo.utils.hpc_client import pool
        connections = pool.list_connections()
        sessions = []
        for c in connections:
            entry = {}
            if hasattr(c, 'host'):
                entry['host'] = c.host
            if hasattr(c, 'username'):
                entry['username'] = c.username
            if hasattr(c, 'uptime_seconds'):
                entry['uptime'] = c.uptime_seconds
            sessions.append(entry)
    except Exception:
        connections = []
        sessions = []

    return {
        "backend": "connected",
        "hpc_connections": len(connections),
        "hpc_sessions": sessions,
    }


def _resolve_version() -> str:
    """Best-effort version string (no hard dependency)."""
    try:
        from importlib.metadata import version as _pkg_version
        return _pkg_version("catgo")
    except Exception:
        pass
    try:
        # main.py declares FastAPI(version="0.1.0"); reuse it if importable cheaply.
        import main  # type: ignore
        app = getattr(main, "app", None)
        v = getattr(app, "version", None)
        if v:
            return str(v)
    except Exception:
        pass
    return "dev"


def _probe_hpc() -> tuple[int, bool, list[dict]]:
    """Read the existing connection pool defensively.

    Returns (active_sessions, any_connected, extra_issues). Never raises and
    never hard-depends on asyncssh — mirrors the /status import pattern.
    """
    issues: list[dict] = []
    try:
        from catgo.utils.hpc_client import pool, LOCAL_SESSION_ID
        active = [
            c for c in pool.list_connections()
            if getattr(c, "session_id", None) != LOCAL_SESSION_ID
        ]
        return len(active), len(active) > 0, issues
    except Exception:
        issues.append({
            "id": "hpc-pool-unreachable",
            "severity": "info",
            "message": "HPC connection pool not reachable from diagnostics",
            "fix_hint": "Connect a cluster from the HPC panel",
        })
        return 0, False, issues


@router.get("/diagnostics")
def get_diagnostics():
    """Aggregate backend health for the setup wizard and CatBot.

    Dependency-light and fast: optional heavy deps are probed with find_spec
    only (never imported), and the HPC pool read is fully defensive. Works in
    THIN mode.
    """
    mode = "thin" if os.environ.get("CATGO_THIN") == "1" else "full"
    version = _resolve_version()

    # frontend_served: CATGO_FRONTEND_DIR or <repo>/build-desktop is a dir.
    frontend_dir = Path(
        os.environ.get("CATGO_FRONTEND_DIR") or (_REPO_ROOT / "build-desktop")
    )
    frontend_served = frontend_dir.is_dir()

    # routers: count registered routes (cheap). In thin mode the THIN-SKIP
    # routers are intentionally absent → report them as "missing".
    try:
        from main import app as _app  # type: ignore
        routers_loaded = len(_app.routes)
    except Exception:
        routers_loaded = len(router.routes)
    routers_missing = list(_THIN_SKIP_ROUTERS) if mode == "thin" else []

    # deps: import-probe only (find_spec), never import heavy libs.
    deps = {
        name: importlib.util.find_spec(name) is not None
        for name in _OPTIONAL_DEPS
    }

    active_sessions, any_connected, hpc_issues = _probe_hpc()

    issues: list[dict] = []

    if not deps.get("pymatgen"):
        issues.append({
            "id": "pymatgen-missing",
            "severity": "error",
            "message": "pymatgen not installed — structure operations unavailable",
            "fix_hint": "pip install pymatgen",
        })
    if not deps.get("ase"):
        issues.append({
            "id": "ase-missing",
            "severity": "error",
            "message": "ase not installed — atomistic I/O and builders unavailable",
            "fix_hint": "pip install ase",
        })
    if not deps.get("numpy"):
        issues.append({
            "id": "numpy-missing",
            "severity": "error",
            "message": "numpy not installed — core numerics unavailable",
            "fix_hint": "pip install numpy",
        })
    if not deps.get("asyncssh"):
        issues.append({
            "id": "asyncssh-missing",
            "severity": "warn",
            "message": "asyncssh not installed — HPC/SSH features unavailable",
            "fix_hint": "pip install asyncssh",
        })

    if mode == "thin":
        issues.append({
            "id": "thin-mode",
            "severity": "info",
            "message": "Running in THIN mode — heavy domain builders/analysis are disabled",
            "fix_hint": "Unset CATGO_THIN and install heavy deps for full features",
        })

    issues.extend(hpc_issues)

    if not any_connected:
        issues.append({
            "id": "no-hpc-session",
            "severity": "info",
            "message": "No HPC cluster connected",
            "fix_hint": "Connect a cluster to submit and monitor jobs",
        })

    health = "degraded" if any(i["severity"] == "error" for i in issues) else "ok"

    return {
        "ok": True,
        "version": version,
        "mode": mode,
        "frontend_served": frontend_served,
        "routers": {"loaded": routers_loaded, "missing": routers_missing},
        "deps": deps,
        "hpc": {"active_sessions": active_sessions, "any_connected": any_connected},
        "health": health,
        "issues": issues,
    }

"""CatGo Computation Server - FastAPI backend for structure optimization."""

import asyncio
import logging
import os
import re
import sys
import warnings
from contextlib import asynccontextmanager
from pathlib import Path

# Configure root logger so workflow engine logs are visible
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s:%(name)s:%(message)s",
    stream=sys.stderr,
)

# Suppress e3nn / PyTorch weights_only warning (e3nn 0.4.4 + torch ≥2.6).
# Must be set before any import of e3nn (triggered at module load time).
warnings.filterwarnings("ignore", message=".*TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD.*")
warnings.filterwarnings("ignore", message=".*weights_only.*torch\\.load.*")

# Add server directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))


def _worktree_offset() -> int:
    """Compute deterministic port offset from worktree directory name.

    Uses the same hash as vite.shared.ts so frontend and backend ports match.
    Main repo -> offset 0 (port 8000). Worktrees -> 1-99 (port 8001-8099).
    Accepts either `.claude/worktrees/<name>` or `.worktrees/<name>`.
    """
    cwd = os.path.abspath(".")
    match = re.search(r"\.(?:claude[/\\])?worktrees[/\\]([^/\\]+)", cwd)
    if not match:
        return 0
    name = match.group(1)
    h = 0
    for ch in name:
        # Emulate JS: hash = ((hash << 5) - hash + charCode) | 0
        h = (h << 5) - h + ord(ch)
        h = h & 0xFFFFFFFF
        if h >= 0x80000000:
            h -= 0x100000000
    return 1 + (abs(h) % 99)


SERVER_PORT = int(os.environ.get("SERVER_PORT", 0)) or (8000 + _worktree_offset())

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware

# ============================================================================
# Essential routers — imported eagerly so /health and first-touch UI paths
# (optimize, structure_ops, view_capture, optimade/pubchem/mp search, etc.)
# are ready the moment uvicorn binds.
# ============================================================================
from catgo.routers import (
    optimize_router,
    optimize_ws_router,
    optimade_router,
    pubchem_router,
    mp_router,
    cube_router,
    chgcar_router,
    water_layer_router,
    moire_router,
    nanotube_router,
    reticular_router,
    dos_router,
    cohp_router,
    bands_router,
    pseudo_hydrogen_router,
    workflow_router,
    build_router,
    trajectory_edit_router,
    pty_router,
    chat_router,
    structure_ops_router,
    view_capture_router,
    paper_router,
    plugins_router,
    tool_bridge_router,
    freq_analysis_router,
    system_router,
    hub_router,
    file_sandbox_router,
    kmc_router,
    skills_router,
)

# ============================================================================
# Deferred routers — imported AFTER lifespan yields, so they don't block the
# /health endpoint from going green.  Each entry is the attribute name inside
# `catgo.routers`; `_deferred_startup()` imports the module via `getattr`
# which triggers the heavy module load at that point.
#
# Selection criteria: any router whose transitive imports cost >~100 ms
# (measured with `python -X importtime`) and that is NOT touched in the
# first couple of seconds of a typical session.  The real heavy hitters
# (heterostructure, vasp, md_clustering) are the primary targets.
# ============================================================================
_DEFERRED_ROUTER_ATTRS: list[str] = [
    "heterostructure_router",  # ~1340 ms (pymatgen.analysis.interfaces)
    "vasp_router",              # ~1310 ms (pymatgen.io.vasp.inputs)
    "md_clustering_router",     # ~600 ms (sklearn.cluster, scipy.signal)
    "md_distances_router",
    "md_angles_router",
    "md_rmsd_router",
    "md_density_router",
    "md_hbonds_router",
    "md_dynamics_router",       # MSD / VACF / diffusion coefficient
    "md_orientation_router",    # water orientation <cos phi>(z)
    "md_cavitation_router",     # LCW cavitation ΔG_cav(R, z)
    "hpc_router",               # ~210 ms (asyncssh)
    "qe_router",
    "lammps_router",
    "orca_router",
    "cp2k_router",
    "quacc_router",
    "atomate2_router",
    "forcefield_router",        # ~76 ms (openbabel)
]

# Light-weight import; plugin_manager.initialize() is the slow part and is
# deferred inside the lifespan.
from catgo.plugins import plugin_manager

logger = logging.getLogger(__name__)


def _sync_import_deferred_routers() -> list[tuple[str, object]]:
    """Blocking: import every module listed in `_DEFERRED_ROUTER_ATTRS`.

    Returns a list of (attr_name, router) pairs.  Meant to be run in a thread
    pool executor so the main event loop stays responsive (`/health`,
    `/api/optimize/*`, workflow endpoints) while this runs.
    """
    import importlib
    _router_mod = importlib.import_module("catgo.routers")
    pairs: list[tuple[str, object]] = []
    for attr in _DEFERRED_ROUTER_ATTRS:
        try:
            pairs.append((attr, getattr(_router_mod, attr)))
        except Exception as exc:
            logger.warning("Deferred router %s import failed: %s", attr, exc)
    return pairs


def _sync_discover_tools() -> None:
    """Blocking: filesystem scan for plugins + tool discovery.

    Runs inside executor so the event loop isn't blocked on file I/O.
    """
    try:
        from catgo.tools import registry as tool_registry
        from catgo.tools.discovery import discover_tools, discover_builtin_tools

        _tool_dirs: list[Path] = []
        _project_plugins = Path(__file__).resolve().parent.parent / "plugins"
        if _project_plugins.exists():
            _tool_dirs.append(_project_plugins)
        _user_tools = Path.home() / ".catgo" / "tools"
        if _user_tools.exists():
            _tool_dirs.append(_user_tools)

        _entries, _errors = discover_tools(_tool_dirs, default_trust="user")
        for _entry in _entries:
            tool_registry.register(_entry)

        _builtin_entries = discover_builtin_tools()
        for _entry in _builtin_entries:
            tool_registry.register(_entry)

        _total = len(_entries) + len(_builtin_entries)
        logger.info(
            "Tool registry: %d tools loaded (%d user, %d builtin), %d errors",
            _total, len(_entries), len(_builtin_entries), len(_errors),
        )
    except Exception as exc:
        logger.warning("Tool discovery failed: %s", exc)


def _sync_seed_workflow_templates() -> None:
    """Blocking: seeds built-in workflow presets. Safe to call repeatedly."""
    try:
        from workflow.presets.templates import seed_builtin_templates
        seed_builtin_templates()
    except Exception as exc:
        logger.warning("Workflow template seeding failed: %s", exc)


async def _deferred_startup(app: "FastAPI") -> None:
    """Heavy work that used to block `/health` from going green.

    Runs as an `asyncio.Task` scheduled from `lifespan()`.  All CPU- and
    I/O-bound pieces are pushed to the default thread pool executor via
    `loop.run_in_executor()` so the main event loop stays responsive and
    uvicorn can serve `/health`, structure ops, and optimization requests
    while this initialization finishes in the background.
    """
    loop = asyncio.get_running_loop()

    # Yield once so the surrounding `lifespan()` coroutine has a chance to
    # finish its own startup phase (MCP session __aenter__, yield) before
    # we queue a blocking job on the executor.
    await asyncio.sleep(0)

    # 1. Heavy router imports — blocking, offloaded to executor.
    try:
        pairs = await loop.run_in_executor(None, _sync_import_deferred_routers)
        for attr, router in pairs:
            try:
                app.include_router(router, prefix="/api")
            except Exception as exc:
                logger.warning("Deferred router %s include failed: %s", attr, exc)
        logger.info("Deferred routers included (%d of %d)",
                    len(pairs), len(_DEFERRED_ROUTER_ATTRS))
    except Exception as exc:
        logger.warning("Deferred router batch failed: %s", exc)

    # 2. Plugin manager init — already async, should cooperate with loop.
    try:
        await plugin_manager.initialize()
        logger.info("Plugin manager initialized (deferred)")
    except Exception as exc:
        logger.warning("Plugin manager init failed: %s", exc)

    # 3. Tool discovery — filesystem scan, offloaded.
    try:
        await loop.run_in_executor(None, _sync_discover_tools)
    except Exception as exc:
        logger.warning("Tool discovery executor failed: %s", exc)

    # 4. Workflow template seeding — file I/O, offloaded.
    try:
        await loop.run_in_executor(None, _sync_seed_workflow_templates)
    except Exception as exc:
        logger.warning("Workflow template executor failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown events.

    Fast-path: we start the workflow engine (needed synchronously so the
    workflow dashboard is responsive) and the MCP Streamable HTTP session
    manager, then schedule `_deferred_startup()` as a background task and
    yield immediately.  The heavy plugin/tool/router init runs in parallel
    with the first few user requests.
    """
    # ─── Workflow Engine (sync — needed for workflow endpoints) ───
    _engine_started = False
    _stop_engine_fn = None
    try:
        from catgo.workflow.db import WorkflowDB as CatgoDB
        from catgo.workflow.config import load_config as load_catgo_config
        from catgo.workflow.engine.lifecycle import start_engine, stop_engine
        from catgo.routers.workflow_engine import router as wf_engine_router, set_db as set_wf_engine_db
        from catgo.routers.workflow_engine_tasks import router as tasks_engine_router, set_db as set_tasks_engine_db

        catgo_config = load_catgo_config()
        catgo_db_path = str(Path(catgo_config["paths"]["db_path"]).expanduser())
        catgo_db = CatgoDB(catgo_db_path)
        set_wf_engine_db(catgo_db)
        set_tasks_engine_db(catgo_db)

        app.include_router(wf_engine_router)
        app.include_router(tasks_engine_router)

        await start_engine(catgo_db, catgo_config)
        _engine_started = True
        _stop_engine_fn = stop_engine
        logger.info("Workflow engine started")
    except Exception as exc:
        logger.warning("Workflow engine setup failed (non-fatal): %s", exc)

    # Schedule deferred heavy work; runs concurrently with serving.
    deferred_task = asyncio.create_task(_deferred_startup(app))

    def _log_deferred_done(t: asyncio.Task) -> None:
        if t.cancelled():
            return
        exc = t.exception()
        if exc is None:
            logger.info("Deferred startup complete")
        else:
            logger.warning("Deferred startup raised: %r", exc)
    deferred_task.add_done_callback(_log_deferred_done)

    # Start MCP Streamable HTTP session manager (must be active before requests)
    try:
        from catgo.routers.mcp_http import session_manager as mcp_session_manager
        async with mcp_session_manager.run():
            logger.info("MCP HTTP session manager started")
            yield
    except Exception as exc:
        logger.warning("MCP session manager failed (non-fatal): %s", exc)
        yield

    # ─── Shutdown ───
    if not deferred_task.done():
        deferred_task.cancel()
        try:
            await deferred_task
        except (asyncio.CancelledError, Exception):
            pass
    if _engine_started and _stop_engine_fn is not None:
        try:
            await _stop_engine_fn()
            logger.info("Workflow engine stopped")
        except Exception:
            pass
    logger.info("Shutting down...")


app = FastAPI(
    title="CatGo Computation Server",
    description="Backend service for crystal structure optimization and calculations",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS configuration - allow frontend to connect
# Covers: Tauri app, localhost dev servers on any port, worktree ports,
# and VSCode webview panels (origin is `vscode-webview://<opaque-id>`).
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"(https?://(localhost|127\.0\.0\.1)(:\d+)?|vscode-webview://[A-Za-z0-9\-]+)",
    allow_origins=[
        "tauri://localhost",  # Tauri app (macOS/Linux)
        "https://tauri.localhost",  # Tauri app (Windows)
        "http://tauri.localhost",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# GZip compression — auto-compress responses > 1KB (benefits large structure JSONs).
# IMPORTANT: SSE (text/event-stream) MUST be excluded.  GZipMiddleware's internal
# zlib compressor buffers small chunks to build efficient gzip blocks, which prevents
# individual SSE events from being flushed to the client in real-time.  The browser
# decompressor also waits for complete gzip blocks before passing data to JS, so
# chat streams appear permanently "stuck" — especially on Windows where the initial
# response already takes ~60s due to MCP server startup inside Claude Code.
class _SSEAwareGZipMiddleware(GZipMiddleware):
    """GZipMiddleware that skips SSE streams."""
    async def __call__(self, scope, receive, send):
        # For non-HTTP scopes or SSE endpoints, bypass gzip entirely
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path.endswith("/stream") or "/mcp/" in path:
                # Plain ASGI pass-through (no gzip wrapping)
                await self.app(scope, receive, send)
                return
        await super().__call__(scope, receive, send)

app.add_middleware(_SSEAwareGZipMiddleware, minimum_size=1000)


# Global exception handler — ensures unhandled 500s still get CORS headers
# (ServerErrorMiddleware is outermost and can bypass CORSMiddleware)
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    import logging
    logging.getLogger(__name__).error("Unhandled error: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {type(exc).__name__}: {exc}"},
    )


# Include essential routers synchronously.
# Heavy routers (VASP input, heterostructure, md_clustering, HPC, QE, ORCA,
# CP2K, LAMMPS, quacc, atomate2, forcefield) are registered later
# inside `_deferred_startup()` so they don't block /health from going green.
app.include_router(optimize_router, prefix="/api")
app.include_router(optimize_ws_router, prefix="/api")
app.include_router(optimade_router, prefix="/api")
app.include_router(pubchem_router, prefix="/api")
app.include_router(mp_router, prefix="/api")
app.include_router(cube_router, prefix="/api")
app.include_router(chgcar_router, prefix="/api")
app.include_router(water_layer_router, prefix="/api")
app.include_router(moire_router, prefix="/api")
app.include_router(nanotube_router, prefix="/api")
app.include_router(reticular_router, prefix="/api")
app.include_router(dos_router, prefix="/api")
app.include_router(cohp_router, prefix="/api")
app.include_router(bands_router, prefix="/api")
app.include_router(workflow_router, prefix="/api")
app.include_router(pseudo_hydrogen_router, prefix="/api")
app.include_router(build_router, prefix="/api")
app.include_router(trajectory_edit_router, prefix="/api")
app.include_router(pty_router, prefix="/api")
app.include_router(chat_router, prefix="/api")
app.include_router(structure_ops_router, prefix="/api")
app.include_router(view_capture_router, prefix="/api")
app.include_router(paper_router, prefix="/api")
app.include_router(plugins_router, prefix="/api")
app.include_router(tool_bridge_router, prefix="/api")
app.include_router(freq_analysis_router, prefix="/api")
app.include_router(system_router, prefix="/api")
app.include_router(hub_router, prefix="/api")
app.include_router(file_sandbox_router, prefix="/api")
app.include_router(kmc_router, prefix="/api")
app.include_router(skills_router, prefix="/api")

from catgo.routers.tools import router as tools_router
app.include_router(tools_router, prefix="/api")

# MCP over Streamable HTTP — Claude Code connects via URL, no Python needed on client
try:
    from catgo.routers.mcp_http import mcp_asgi_app
    app.mount("/api/mcp", mcp_asgi_app)
    print("[Server] MCP HTTP endpoint available at /api/mcp")
except Exception as e:
    print(f"[Server] MCP HTTP setup failed (non-fatal): {e}")



@app.get("/")
async def root():
    """Root endpoint with API information."""
    return {
        "name": "CatGo Computation Server",
        "version": "0.1.0",
        "docs": "/docs",
        "endpoints": {
            "calculators": "/api/optimize/calculators",
            "optimize": "/api/optimize/structure",
            "energy": "/api/optimize/energy",
            "optimize_ws": f"ws://localhost:{SERVER_PORT}/api/optimize/ws",
            "qe_input": "/api/qe/input",
            "qe_templates": "/api/qe/templates",
            "qe_elements": "/api/qe/elements",
            "lammps_input": "/api/lammps/input",
            "lammps_pair_styles": "/api/lammps/pair_styles",
            "lammps_units": "/api/lammps/units",
            "vasp_input": "/api/vasp/input",
            "optimade_providers": "/api/optimade/providers",
            "optimade_structure": "/api/optimade/structure/{provider_id}/{structure_id}",
            "optimade_search": "/api/optimade/search",
            "pubchem_search": "/api/pubchem/search",
            "pubchem_compound": "/api/pubchem/compound/{cid}",
            "water_layer_add": "/api/water-layer/add",
            "moire_search": "/api/moire/search",
            "moire_build": "/api/moire/build",
            "nanotube_info": "/api/nanotube/info",
            "nanotube_build": "/api/nanotube/build",
            "plugins": "/api/plugins",
            "plugin_calculators": "/api/plugins/calculators",
        },
    }


@app.get("/health")
@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "port": SERVER_PORT, "pid": os.getpid()}


# ---------------------------------------------------------------------------
# Daemon / CLI helpers
# ---------------------------------------------------------------------------

_CATGO_DIR = Path.home() / ".catgo"
_PID_FILE = _CATGO_DIR / "server.pid"
_PORT_FILE = _CATGO_DIR / "server.port"


def _write_pid_port(pid: int, port: int) -> None:
    """Write PID and port files to ~/.catgo/."""
    _CATGO_DIR.mkdir(parents=True, exist_ok=True)
    _PID_FILE.write_text(str(pid))
    _PORT_FILE.write_text(str(port))


def _read_pid() -> int | None:
    """Read the daemon PID from the PID file, or None."""
    try:
        return int(_PID_FILE.read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def _read_port() -> int | None:
    """Read the daemon port from the port file, or None."""
    try:
        return int(_PORT_FILE.read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def _is_process_alive(pid: int) -> bool:
    """Check whether a process with the given PID is alive."""
    try:
        os.kill(pid, 0)  # signal 0 = existence check, no actual signal sent
        return True
    except (OSError, ProcessLookupError):
        return False


def _cleanup_pid_files() -> None:
    """Remove PID and port files."""
    for f in (_PID_FILE, _PORT_FILE):
        try:
            f.unlink(missing_ok=True)
        except OSError:
            pass


def _cmd_status() -> None:
    """Print daemon status and exit."""
    pid = _read_pid()
    port = _read_port()
    if pid and _is_process_alive(pid):
        print(f"CatGo backend is running  (pid={pid}, port={port})")
    else:
        print("CatGo backend is not running")
        if pid:
            print(f"  (stale pid file references pid={pid})")
            _cleanup_pid_files()
    sys.exit(0)


def _cmd_stop() -> None:
    """Send SIGTERM to the daemon and exit."""
    import signal
    pid = _read_pid()
    if pid is None:
        print("No PID file found — backend may not be running as a daemon")
        sys.exit(1)
    if not _is_process_alive(pid):
        print(f"Process {pid} is not alive (cleaning up stale PID file)")
        _cleanup_pid_files()
        sys.exit(0)
    print(f"Sending SIGTERM to backend (pid={pid}) ...")
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        print(f"Failed to stop backend: {exc}")
        sys.exit(1)
    # Wait briefly for the process to exit
    import time
    for _ in range(20):
        time.sleep(0.25)
        if not _is_process_alive(pid):
            break
    if _is_process_alive(pid):
        print(f"Process {pid} did not exit in time — you may need to kill it manually")
    else:
        print("Backend stopped")
        _cleanup_pid_files()
    sys.exit(0)


def _cmd_daemon(port: int) -> None:
    """Fork into a background daemon and run uvicorn.

    On Unix this uses os.fork().  On Windows, use ``pythonw server/main.py``
    (or run without --daemon and use a service wrapper).
    """
    if sys.platform == "win32":
        print("ERROR: --daemon is not supported on Windows.")
        print("Run the server with pythonw or as a Windows service instead.")
        sys.exit(1)

    # First fork — detach from terminal
    pid = os.fork()
    if pid > 0:
        # Parent — wait briefly for the grandchild to write its PID file,
        # then report it and exit.
        import time
        time.sleep(0.3)
        daemon_pid = _read_pid() or pid  # fallback to child pid
        print(f"CatGo backend daemonised  (pid={daemon_pid}, port={port})")
        sys.exit(0)

    # Child — become session leader
    os.setsid()

    # Second fork — prevent reacquiring a controlling terminal
    pid2 = os.fork()
    if pid2 > 0:
        os._exit(0)

    # Grandchild — the actual daemon process
    # Write PID/port files before redirecting stdio so the parent can read them
    _write_pid_port(os.getpid(), port)

    # Redirect stdin/stdout/stderr to /dev/null
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    os.close(devnull)

    # Install cleanup handler
    import signal
    import atexit

    atexit.register(_cleanup_pid_files)

    def _sigterm_handler(signum, frame):
        _cleanup_pid_files()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _sigterm_handler)

    # Run uvicorn in the daemon process (no reload — daemon mode)
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="CatGo Computation Server")
    parser.add_argument("--daemon", action="store_true",
                        help="Run as a background daemon (Unix only)")
    parser.add_argument("--stop", action="store_true",
                        help="Stop a running daemon")
    parser.add_argument("--status", action="store_true",
                        help="Check if the daemon is running")
    parser.add_argument("--port", type=int, default=None,
                        help="Override server port (0 = auto-assign free port)")
    args = parser.parse_args()

    if args.stop:
        _cmd_stop()
    elif args.status:
        _cmd_status()
    elif args.daemon:
        _cmd_daemon(args.port or SERVER_PORT)
    else:
        run_port = args.port if args.port is not None else SERVER_PORT

        if run_port == 0:
            # Auto-assign: let OS pick a free port, report it via stdout JSON
            import socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("", 0))
            run_port = sock.getsockname()[1]
            sock.close()

        # Print port as first stdout line (extension reads this)
        import json as _json
        print(_json.dumps({"port": run_port}), flush=True)

        print(f"Starting CatGo server on port {run_port}")
        uvicorn.run(
            "main:app",
            host="0.0.0.0",
            port=run_port,
            reload=False,
            log_level="warning",
        )

"""CatGo Computation Server - FastAPI backend for structure optimization."""

import asyncio
import logging
import os
import re
import sys
import warnings
from contextlib import asynccontextmanager
from pathlib import Path

# PyInstaller windowed build (console=False) leaves sys.stdout/sys.stderr as None
# on Windows when the .exe is launched directly (e.g. double-clicked). That makes
# the port-handshake print() and uvicorn's ColourizedFormatter crash —
# ColourizedFormatter.__init__ calls sys.stdout.isatty(), raising
# "AttributeError: 'NoneType' object has no attribute 'isatty'". Restore writable
# streams so logging and uvicorn start cleanly. (When launched by the desktop app
# the streams are real pipes, so this guard is a no-op.)
if sys.stdout is None or sys.stderr is None:
    _devnull = open(os.devnull, "w")  # noqa: SIM115
    if sys.stdout is None:
        sys.stdout = _devnull
    if sys.stderr is None:
        sys.stderr = _devnull

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
_repo_root = Path(__file__).resolve().parent.parent

# Make local extension packages importable by the routers. catgo_dos /
# catgo_cohp live under extensions/<name>/ and are not regular dependencies.
# In a PyInstaller build they are extracted under sys._MEIPASS; in source runs
# they live at the repository root.
def _extension_roots() -> list[Path]:
    roots: list[Path] = []
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            roots.append(Path(meipass))
        roots.append(Path(sys.executable).resolve().parent)
    roots.append(_repo_root)
    roots.append(Path.cwd())
    return roots


for _ext_dir_name in ("dos-analysis", "cohp-analysis"):
    for _root in _extension_roots():
        _ext_dir = _root / "extensions" / _ext_dir_name
        if _ext_dir.is_dir() and str(_ext_dir) not in sys.path:
            sys.path.insert(0, str(_ext_dir))
            break


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

# Thin mode: skip heavy domain routers (cube/chgcar/water/moire/.../kmc) and
# their transitive pymatgen/ase imports.  Gated entirely by env; when unset the
# server loads every router exactly as before.
CATGO_THIN = os.environ.get("CATGO_THIN") == "1"

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware

# ============================================================================
# Essential routers — imported eagerly so /health and first-touch UI paths
# (optimize, structure_ops, view_capture, optimade/pubchem/mp search, etc.)
# are ready the moment uvicorn binds.
# ============================================================================
# THIN-BASE routers — always imported (light deps, core UI/search/workflow).
from catgo.routers import (
    optimize_router,
    optimize_ws_router,
    optimade_router,
    pubchem_router,
    mp_router,
    mofdb_router,
    structure_ops_router,
    view_capture_router,
    trajectory_stream_router,
    trajectory_edit_router,
    pty_router,
    chat_router,
    workflow_router,
    system_router,
    hub_router,
    file_sandbox_router,
    skills_router,
    campaign_router,
    tool_bridge_router,
    plugins_router,
    terminal_bridge_router,
)

# THIN-SKIP routers — heavy domain builders/analysis (pymatgen/ase/etc).
# Skipped entirely (import AND include) when CATGO_THIN=1.
if not CATGO_THIN:
    from catgo.routers import (
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
        build_router,
        paper_router,
        freq_analysis_router,
        kmc_router,
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
_DEFERRED_ROUTER_ATTRS: list[str] = ["hpc_router"] if CATGO_THIN else [
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


def _sync_setup_claude_integration() -> None:
    """Blocking: register the catgo MCP server + skills with Claude Code.

    Runs ONLY in the bundled (frozen) desktop app. Installer users have no
    `catgo` CLI on PATH, so the server self-registers on startup: it writes the
    HTTP MCP entry to ``~/.claude.json`` (the file Claude Code actually reads —
    NOT ``~/.claude/mcp.json``) pointing at this server's own ``/api/mcp/``, and
    copies the campaign skills into ``~/.claude/skills``.

    Gated on ``sys.frozen`` and an env opt-out so dev runs are untouched. Fully
    guarded; ``ensure_claude_integration`` never raises. Idempotent — fine to
    run on every launch.

    The base URL is built from the module-global ``SERVER_PORT``, which is the
    exact port uvicorn binds (the frozen sidecar is started with no ``--port``,
    so ``run_port == SERVER_PORT``; and a frozen exe is never inside a worktree,
    so the offset is 0 → port 8000 unless ``SERVER_PORT`` env overrides it).
    """
    if not getattr(sys, "frozen", False):
        return
    if os.environ.get("CATGO_NO_CLAUDE_SETUP") in ("1", "true"):
        return
    try:
        from catgo.setup_claude import (
            default_skills_dir,
            ensure_claude_integration,
        )

        api_base = f"http://127.0.0.1:{SERVER_PORT}/api"
        result = ensure_claude_integration(
            api_base=api_base,
            prefer_symlink=False,  # copy, not symlink — Windows non-admin safe
            skills_src=default_skills_dir(),
        )
        if result.get("errors"):
            logger.warning(
                "Claude integration self-setup partial: mcp_url=%s skills=%d errors=%s",
                result.get("mcp_url"),
                len(result.get("skills") or []),
                result["errors"],
            )
        else:
            logger.info(
                "Claude integration ready: MCP %s registered in %s, %d skill(s) installed",
                result.get("mcp_url"),
                result.get("claude_json"),
                len(result.get("skills") or []),
            )
    except Exception as exc:
        logger.warning("Claude integration self-setup failed (non-fatal): %s", exc)


def _move_spa_fallback_last(app: "FastAPI") -> None:
    """Move the SPA catch-all route (`/{full_path:path}`) to the end of the
    route table so routers included after import time are matched first.

    In SPA mode the catch-all is registered at module load and 404s any
    unmatched `/api/*` path. Routers included later — the workflow engine in
    `lifespan()` and the hpc/heterostructure/etc. routers in
    `_deferred_startup()` — are appended *after* it, so Starlette matches the
    catch-all first and those deferred `/api/*` routes 404. Re-appending the
    catch-all keeps it last. No-op (and safe) when no catch-all is registered
    (dev mode without a prebuilt frontend). Idempotent.
    """
    routes = app.router.routes
    for i, route in enumerate(routes):
        if getattr(route, "path", None) == "/{full_path:path}":
            routes.append(routes.pop(i))
            return


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
        # Deferred routers were appended after the module-load SPA catch-all;
        # re-float the catch-all to the end so they aren't shadowed (→ 404).
        _move_spa_fallback_last(app)
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

    # 5. Claude Code integration self-setup — register the catgo MCP server in
    #    ~/.claude.json and install the campaign skills into ~/.claude/skills.
    #    Only in the bundled (frozen) desktop app, where the user has no `catgo`
    #    CLI on PATH to run `catgo setup` themselves. Idempotent (every launch).
    try:
        await loop.run_in_executor(None, _sync_setup_claude_integration)
    except Exception as exc:
        logger.warning("Claude integration self-setup executor failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown events.

    Fast-path: we start the workflow engine (needed synchronously so the
    workflow dashboard is responsive) and the MCP Streamable HTTP session
    manager, then schedule `_deferred_startup()` as a background task and
    yield immediately.  The heavy plugin/tool/router init runs in parallel
    with the first few user requests.
    """
    # ─── Restore last active workflow DB (before any create/list/get) ───
    # A fresh backend otherwise defaults to the packaged DB while the frontend
    # later re-opens the user's project DB, orphaning API-created workflows in
    # the wrong file. Restoring the persisted path keeps a single source of truth.
    try:
        from catgo.utils.ase_db import restore_active_db_path
        restored = restore_active_db_path()
        if restored:
            logger.info("Active workflow DB restored to: %s", restored)
    except Exception as exc:  # non-fatal
        logger.warning("Active DB restore skipped: %s", exc)

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
        # Keep the SPA catch-all last so these engine routes aren't shadowed.
        _move_spa_fallback_last(app)

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
# Base origins: Tauri app on all platforms.
_cors_allow_origins = [
    "tauri://localhost",  # Tauri app (macOS/Linux)
    "https://tauri.localhost",  # Tauri app (Windows)
    "http://tauri.localhost",
]
# Extra origins from CATGO_ALLOWED_ORIGINS (comma-separated; empties dropped).
# Unset -> no change from previous behaviour.
for _origin in os.environ.get("CATGO_ALLOWED_ORIGINS", "").split(","):
    _origin = _origin.strip()
    if _origin:
        _cors_allow_origins.append(_origin)

# Base regex: localhost/127.0.0.1 on any port + VSCode webview.
# Extended to also match Tailscale MagicDNS hosts
# (https://<machine>.<tailnet>.ts.net) so a remote-served SPA can reach the API.
_cors_allow_origin_regex = (
    r"(https?://(localhost|127\.0\.0\.1)(:\d+)?"
    r"|vscode-webview://[A-Za-z0-9\-]+"
    r"|https://[A-Za-z0-9\-]+\.[A-Za-z0-9\-]+\.ts\.net)"
)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=_cors_allow_origin_regex,
    allow_origins=_cors_allow_origins,
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
# THIN-BASE includes — always registered.
app.include_router(optimize_router, prefix="/api")
app.include_router(optimize_ws_router, prefix="/api")
app.include_router(optimade_router, prefix="/api")
app.include_router(pubchem_router, prefix="/api")
app.include_router(mp_router, prefix="/api")
app.include_router(mofdb_router, prefix="/api")
app.include_router(trajectory_stream_router, prefix="/api")
app.include_router(workflow_router, prefix="/api")
app.include_router(trajectory_edit_router, prefix="/api")
app.include_router(pty_router, prefix="/api")
app.include_router(chat_router, prefix="/api")
app.include_router(structure_ops_router, prefix="/api")
app.include_router(view_capture_router, prefix="/api")
app.include_router(terminal_bridge_router, prefix="/api")
app.include_router(plugins_router, prefix="/api")
app.include_router(tool_bridge_router, prefix="/api")
app.include_router(system_router, prefix="/api")
app.include_router(hub_router, prefix="/api")
app.include_router(file_sandbox_router, prefix="/api")
app.include_router(skills_router, prefix="/api")
app.include_router(campaign_router, prefix="/api")

# THIN-SKIP includes — registered only outside thin mode (heavy deps).
if not CATGO_THIN:
    app.include_router(cube_router, prefix="/api")
    app.include_router(chgcar_router, prefix="/api")
    app.include_router(water_layer_router, prefix="/api")
    app.include_router(moire_router, prefix="/api")
    app.include_router(nanotube_router, prefix="/api")
    app.include_router(reticular_router, prefix="/api")
    app.include_router(dos_router, prefix="/api")
    app.include_router(cohp_router, prefix="/api")
    app.include_router(bands_router, prefix="/api")
    app.include_router(pseudo_hydrogen_router, prefix="/api")
    app.include_router(build_router, prefix="/api")
    app.include_router(paper_router, prefix="/api")
    app.include_router(freq_analysis_router, prefix="/api")
    app.include_router(kmc_router, prefix="/api")

from catgo.routers.tools import router as tools_router
app.include_router(tools_router, prefix="/api")

# MCP over Streamable HTTP — Claude Code connects via URL, no Python needed on client
try:
    from catgo.routers.mcp_http import mcp_asgi_app
    app.mount("/api/mcp", mcp_asgi_app)
    print("[Server] MCP HTTP endpoint available at /api/mcp/")
except Exception as e:
    print(f"[Server] MCP HTTP setup failed (non-fatal): {e}")



@app.get("/api/info")
async def root():
    """API information endpoint (moved off '/' so the SPA can own the root)."""
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
# Prebuilt SPA serving (remote / hosted mode).
#
# Only enabled when the frontend build directory exists, so the desktop/dev
# flow (separate Vite dev server, no build-desktop/) is completely untouched.
# The catch-all route is registered LAST in this module — after every
# include_router(), /health and /api/info — so it never shadows the API.
# ---------------------------------------------------------------------------
_frontend_dir = Path(
    os.environ.get("CATGO_FRONTEND_DIR") or (_repo_root / "build-desktop")
)
if _frontend_dir.is_dir():
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
    from starlette.responses import Response

    _index_html = _frontend_dir / "index.html"
    _frontend_base = _frontend_dir.resolve()
    _assets_dir = _frontend_dir / "assets"
    if _assets_dir.is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=str(_assets_dir)),
            name="assets",
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> Response:
        """Serve the prebuilt SPA; never shadow /api/* routes."""
        # API paths must 404 here so they resolve to real routers above
        # (or a genuine 404), never the index.html shell.
        if full_path.startswith("api"):
            return Response(status_code=404)
        # Path-traversal guard: reject absolute / `..` paths and confirm the
        # resolved candidate stays inside the frontend dir before serving — a
        # request like `../../etc/passwd` must never escape build-desktop/.
        if full_path and not full_path.startswith("/") and ".." not in full_path.split("/"):
            try:
                candidate = (_frontend_base / full_path).resolve()
                candidate.relative_to(_frontend_base)
            except (ValueError, OSError):
                candidate = None
            if candidate is not None and candidate.is_file():
                return FileResponse(str(candidate))
        return FileResponse(str(_index_html))

    print(f"[Server] Serving prebuilt SPA from {_frontend_dir}")


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

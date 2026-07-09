"""CatGo CLI — serve the workflow engine and configure MCP integration."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


def _server_dir() -> Path:
    """Return the server/ directory (parent of catgo/ package)."""
    return Path(__file__).resolve().parent.parent


def _ensure_sys_path():
    """Add server/ to sys.path so that `from routers import ...` etc. work."""
    sd = str(_server_dir())
    if sd not in sys.path:
        sys.path.insert(0, sd)
    # In a pip wheel, the top-level server modules that the code imports by bare
    # name (`main`, the full `workflow` engine, `plugin_loader`, `mcp_server`)
    # live outside the `catgo` package, so `packages=["catgo"]` can't ship them.
    # The wheel force-includes them under `catgo/_bundled/`; put that first on
    # the path so those bare imports resolve (and `import workflow` picks the
    # full engine here, not the smaller `catgo.workflow`). In a source/editable
    # checkout this directory doesn't exist, so this is a no-op there.
    bundled = _server_dir() / "_bundled"
    if bundled.is_dir():
        bs = str(bundled)
        if bs not in sys.path:
            sys.path.insert(0, bs)


def _get_port() -> int:
    return int(os.environ.get("SERVER_PORT", 0)) or 8000


def _bundled_frontend() -> Path | None:
    """Return the built SPA shipped inside the installed package (catgo/web),
    if present. This is what makes `pip install catgo` show a UI."""
    web = Path(__file__).resolve().parent.parent / "web"
    return web if (web / "index.html").is_file() else None


def _ensure_frontend_dir() -> Path | None:
    """Point CATGO_FRONTEND_DIR at the bundled SPA (unless already set), so
    main.py mounts it. Returns the resolved dir (or None if no UI is bundled)."""
    existing = os.environ.get("CATGO_FRONTEND_DIR")
    if existing:
        return Path(existing) if Path(existing, "index.html").is_file() else None
    web = _bundled_frontend()
    if web:
        os.environ["CATGO_FRONTEND_DIR"] = str(web)
    return web


# ──────────────────────────────────────────────
# catgo (bare) / catgo app — launch the UI
# ──────────────────────────────────────────────

def cmd_app(args) -> int:
    """Launch CatGo: start the backend and open the web UI in a browser.

    This is what bare `catgo` runs. The SPA is served same-origin by the
    FastAPI backend (default port 8000, matching the built bundle's API URL)."""
    import threading
    import time
    import webbrowser

    _ensure_sys_path()
    web = _ensure_frontend_dir()
    port = getattr(args, "port", 0) or _get_port()
    host = getattr(args, "host", None) or "127.0.0.1"
    url = f"http://localhost:{port}"

    if web is None:
        print("⚠  No bundled web UI found (catgo/web/index.html missing).")
        print("   Serving the API only — run a dev frontend, or reinstall a")
        print("   release wheel that bundles the UI. Continuing with API at")
        print(f"   {url}/api")
    else:
        print(f"CatGo — starting at {url}")

    if web is not None and not getattr(args, "no_browser", False):
        def _open() -> None:
            time.sleep(1.8)  # give uvicorn a moment to bind
            try:
                webbrowser.open(url)
            except Exception:
                pass
        threading.Thread(target=_open, daemon=True).start()

    import uvicorn
    print(f"  (Ctrl-C to stop)")
    uvicorn.run("main:app", host=host, port=port)
    return 0


# ──────────────────────────────────────────────
# catgo serve
# ──────────────────────────────────────────────

def cmd_serve(args):
    """Start the CatGo backend server."""
    _ensure_sys_path()
    _ensure_frontend_dir()
    port = args.port or _get_port()

    if args.daemon:
        # Delegate to main.py daemon logic
        from main import _cmd_daemon
        _cmd_daemon(port)
    else:
        import uvicorn
        print(f"Starting CatGo server on port {port}")
        print(f"API: http://localhost:{port}/api")
        print(f"MCP: Configure with 'catgo setup'")
        uvicorn.run(
            "main:app",
            host=args.host,
            port=port,
            reload=args.reload,
        )


# ──────────────────────────────────────────────
# catgo setup
# ──────────────────────────────────────────────

def cmd_setup(args):
    """Configure MCP integration for Claude Code."""
    port = args.port or _get_port()
    api_url = f"http://localhost:{port}/api"

    if args.check:
        _check_environment(port)
        return

    print("CatGo Setup — Configuring MCP for Claude Code")
    print("=" * 50)

    # 1. Register the catgo MCP server in ~/.claude.json.
    #    Claude Code reads user-scoped MCP servers from ~/.claude.json (top-level
    #    `mcpServers`), NOT from ~/.claude/mcp.json — the latter is ignored, so
    #    the older mcp.json write never worked. The dev server mounts an HTTP MCP
    #    at /api/mcp, so register the HTTP transport (no client-side Python).
    from catgo.setup_claude import (
        default_skills_dir,
        install_skills,
        register_mcp_http,
    )

    mcp_url = register_mcp_http(api_url)
    claude_json = Path.home() / ".claude.json"
    print(f"  [OK] MCP registered in {claude_json}")
    print(f"       Transport: http")
    print(f"       URL:       {mcp_url}")
    print(f"  [NOTE] ~/.claude/mcp.json is deprecated/ignored by Claude Code")

    # 2. Check if mcp package is installed (server-side dependency)
    try:
        import mcp
        print(f"  [OK] mcp package installed (v{getattr(mcp, '__version__', '?')})")
    except ImportError:
        print(f"  [WARN] mcp package not installed — run: pip install mcp")

    # 3. Check Claude Code CLI
    claude_bin = shutil.which("claude")
    if claude_bin:
        print(f"  [OK] Claude Code CLI found: {claude_bin}")
    else:
        print(f"  [INFO] Claude Code CLI not found (optional — MCP still works)")

    # 4. Install Claude Code campaign skills into ~/.claude/skills. Dev prefers
    #    symlinks so edits in the repo are picked up live (copy fallback on
    #    platforms without symlink support, e.g. Windows non-admin).
    installed = install_skills(default_skills_dir(), prefer_symlink=True)
    skills_dir = Path.home() / ".claude" / "skills"
    print(f"  [OK] installed {len(installed)} Claude Code skill(s) -> {skills_dir}")
    if installed:
        print(f"       {', '.join(installed)}")

    print()
    print("Setup complete! Start the server with: catgo serve")
    print(f"Then use Claude Code — CatGo MCP tools will be available automatically.")


def _check_environment(port: int):
    """Check if everything is configured correctly."""
    import socket

    print("CatGo Environment Check")
    print("=" * 50)

    # 1. Server running?
    try:
        sock = socket.create_connection(("localhost", port), timeout=2)
        sock.close()
        print(f"  [OK] Server running on port {port}")
    except (ConnectionRefusedError, OSError):
        print(f"  [--] Server NOT running on port {port}")

    # 2. MCP config? Claude Code reads ~/.claude.json (NOT ~/.claude/mcp.json).
    claude_json = Path.home() / ".claude.json"
    if claude_json.exists():
        try:
            cfg = json.loads(claude_json.read_text())
            servers = cfg.get("mcpServers", {}) if isinstance(cfg, dict) else {}
            if "catgo" in servers:
                catgo_cfg = servers["catgo"]
                print(f"  [OK] MCP registered in {claude_json}")
                print(f"       Transport: {catgo_cfg.get('type')}")
                print(f"       URL:       {catgo_cfg.get('url')}")
            else:
                print(f"  [--] {claude_json} exists but has no 'catgo' MCP entry")
                print(f"       Run: catgo setup")
        except (json.JSONDecodeError, OSError):
            print(f"  [--] {claude_json} exists but unreadable")
    else:
        print(f"  [--] No Claude config at {claude_json}")
        print(f"       Run: catgo setup")

    # 3. Python packages
    for pkg in ["mcp", "fastapi", "uvicorn", "ase", "pymatgen"]:
        try:
            __import__(pkg)
            print(f"  [OK] {pkg} installed")
        except ImportError:
            print(f"  [--] {pkg} NOT installed")

    # 5. Claude Code?
    claude_bin = shutil.which("claude")
    if claude_bin:
        print(f"  [OK] Claude Code CLI: {claude_bin}")
    else:
        print(f"  [--] Claude Code CLI not found")

    # 6. Skills
    skills_dir = _server_dir() / "catgo" / "workflow" / "skills"
    if skills_dir.exists():
        skill_count = sum(1 for _ in skills_dir.rglob("SKILL.md"))
        print(f"  [OK] {skill_count} SKILLs found in {skills_dir}")
    else:
        print(f"  [--] Skills directory not found")


# ──────────────────────────────────────────────
# catgo status / stop
# ──────────────────────────────────────────────

def cmd_status(args):
    """Check server status."""
    _ensure_sys_path()
    from main import _cmd_status
    _cmd_status()


def cmd_stop(args):
    """Stop a running daemon."""
    _ensure_sys_path()
    from main import _cmd_stop
    _cmd_stop()

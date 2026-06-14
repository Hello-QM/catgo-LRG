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


def _get_port() -> int:
    return int(os.environ.get("SERVER_PORT", 0)) or 8000


# ──────────────────────────────────────────────
# catgo serve
# ──────────────────────────────────────────────

def cmd_serve(args):
    """Start the CatGo backend server."""
    _ensure_sys_path()
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
    server_dir = _server_dir()
    mcp_script = server_dir / "catgo" / "mcp_tools" / "server_claude_code.py"
    python_exe = sys.executable

    if args.check:
        _check_environment(port, mcp_script)
        return

    print("CatGo Setup — Configuring MCP for Claude Code")
    print("=" * 50)

    # 1. Write ~/.claude/mcp.json
    claude_dir = Path.home() / ".claude"
    claude_dir.mkdir(exist_ok=True)
    mcp_config_path = claude_dir / "mcp.json"

    mcp_config = {}
    if mcp_config_path.exists():
        try:
            mcp_config = json.loads(mcp_config_path.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    if "mcpServers" not in mcp_config:
        mcp_config["mcpServers"] = {}

    mcp_config["mcpServers"]["catgo"] = {
        "command": python_exe,
        "args": [str(mcp_script)],
        "env": {"CATGO_API": api_url},
    }

    mcp_config_path.write_text(json.dumps(mcp_config, indent=2) + "\n")
    print(f"  [OK] MCP config written to {mcp_config_path}")
    print(f"       Python: {python_exe}")
    print(f"       Script: {mcp_script}")
    print(f"       API:    {api_url}")

    # 2. Verify MCP server script exists
    if not mcp_script.exists():
        print(f"  [WARN] MCP script not found: {mcp_script}")
        print(f"         Run from the CatGo repository directory")
    else:
        print(f"  [OK] MCP server script found")

    # 3. Check if mcp package is installed
    try:
        import mcp
        print(f"  [OK] mcp package installed (v{getattr(mcp, '__version__', '?')})")
    except ImportError:
        print(f"  [WARN] mcp package not installed — run: pip install mcp")

    # 4. Check Claude Code CLI
    claude_bin = shutil.which("claude")
    if claude_bin:
        print(f"  [OK] Claude Code CLI found: {claude_bin}")
    else:
        print(f"  [INFO] Claude Code CLI not found (optional — MCP still works)")

    # 5. Install Claude Code campaign skills (symlink repo -> ~/.claude/skills)
    _install_claude_skills(server_dir, claude_dir)

    print()
    print("Setup complete! Start the server with: catgo serve")
    print(f"Then use Claude Code — CatGo MCP tools will be available automatically.")


def _install_claude_skills(server_dir: Path, claude_dir: Path):
    """Symlink the repo's Claude Code campaign skills into ~/.claude/skills so a
    fresh clone gets them (the canonical copies ship in the repo; this just makes
    Claude Code discover them globally). Idempotent; never clobbers a real dir."""
    # Resolve the repo skills dir relative to THIS file (server/catgo/cli/_legacy.py
    # -> server/catgo/workflow/skills); robust regardless of cwd / _server_dir shape.
    repo_skills = Path(__file__).resolve().parent.parent / "workflow" / "skills"
    dest_root = claude_dir / "skills"
    dest_root.mkdir(parents=True, exist_ok=True)
    sources = sorted(repo_skills.glob("catgo-*"))
    if not sources:
        return
    n = 0
    for src in sources:
        if not (src / "SKILL.md").is_file():
            continue
        link = dest_root / src.name
        if link.is_symlink() or not link.exists():
            if link.is_symlink():
                link.unlink()
            link.symlink_to(src)
            n += 1
        else:
            print(f"  [WARN] {link} is a real dir (not a symlink) — left as-is")
    print(f"  [OK] linked {n} Claude Code skill(s) -> {dest_root} "
          f"(catgo-campaign, -conventions, -loop, gibbs-pipeline)")


def _check_environment(port: int, mcp_script: Path):
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

    # 2. MCP config?
    mcp_path = Path.home() / ".claude" / "mcp.json"
    if mcp_path.exists():
        try:
            cfg = json.loads(mcp_path.read_text())
            if "catgo" in cfg.get("mcpServers", {}):
                print(f"  [OK] MCP config found: {mcp_path}")
                catgo_cfg = cfg["mcpServers"]["catgo"]
                print(f"       Command: {catgo_cfg.get('command')}")
                print(f"       API:     {catgo_cfg.get('env', {}).get('CATGO_API')}")
            else:
                print(f"  [--] MCP config exists but no 'catgo' entry")
        except (json.JSONDecodeError, OSError):
            print(f"  [--] MCP config exists but unreadable")
    else:
        print(f"  [--] No MCP config at {mcp_path}")
        print(f"       Run: catgo setup")

    # 3. MCP script?
    if mcp_script.exists():
        print(f"  [OK] MCP server script: {mcp_script}")
    else:
        print(f"  [--] MCP server script NOT found: {mcp_script}")

    # 4. Python packages
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

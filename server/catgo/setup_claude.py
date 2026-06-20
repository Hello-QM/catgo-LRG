"""Register the CatGo MCP server and campaign skills with Claude Code.

Claude Code reads **user-scoped** MCP servers from ``~/.claude.json`` (the
top-level ``mcpServers`` key), NOT from ``~/.claude/mcp.json``. The latter is
silently ignored, which is why an older ``catgo setup`` left Claude Code unable
to find the catgo MCP.

This module is shared by:

* the dev CLI (``catgo setup`` — :mod:`catgo.cli._legacy`), and
* the bundled server's startup self-setup (:mod:`main`),

so the registration logic lives in exactly one place. Everything here is
idempotent (safe to run on every launch), cross-platform (``pathlib`` only) and
never raises to the caller — failures are collected and returned so a broken
skills copy can't take down server startup.

The bundled server mounts an HTTP MCP at ``/api/mcp/`` (see
``main.py``: ``app.mount("/api/mcp", mcp_asgi_app)``), so registration uses the
HTTP transport (``{"type": "http", "url": ".../api/mcp/"}``) — no Python on the
client side is required.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path


def _claude_json_path() -> Path:
    """Path to Claude Code's user config (``~/.claude.json``)."""
    return Path.home() / ".claude.json"


def _skills_dir() -> Path:
    """Path to Claude Code's user skills directory (``~/.claude/skills``)."""
    return Path.home() / ".claude" / "skills"


def default_skills_dir() -> Path:
    """Return the bundled skills source directory.

    ``Path(__file__).parent`` is the ``catgo`` package; the skills live at
    ``catgo/workflow/skills``. When frozen by PyInstaller this resolves inside
    the bundle, because ``catgo_server.spec`` bundles
    ``('catgo/workflow/skills', 'catgo/workflow/skills')``.
    """
    return Path(__file__).resolve().parent / "workflow" / "skills"


def _atomic_write_json(path: Path, data: dict) -> None:
    """Write ``data`` as pretty JSON to ``path`` atomically.

    Writes to a temp file in the *same directory* (so ``os.replace`` stays on
    one filesystem and is atomic) then replaces the target in one syscall —
    a crash mid-write can never leave a truncated ``~/.claude.json``.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        # Best-effort cleanup of the temp file on any failure.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def register_mcp_http(api_base: str) -> str:
    """Register the catgo HTTP MCP server in ``~/.claude.json``.

    ``api_base`` is the API root, e.g. ``http://127.0.0.1:8000/api``; the MCP
    URL is ``<api_base>/mcp/`` (→ ``http://127.0.0.1:8000/api/mcp/``).

    The trailing slash is required by Starlette's mounted ASGI route. Without
    it, POST requests can fall through to a later GET-only route and return
    HTTP 405 before reaching the MCP session manager.

    Loads the existing config (or ``{}`` if missing / corrupt), sets only the
    ``mcpServers.catgo`` entry — preserving every other ``mcpServers`` entry and
    all other top-level keys — and writes it back atomically.

    Returns the registered MCP URL.
    """
    url = api_base.rstrip("/") + "/mcp/"
    path = _claude_json_path()

    cfg: dict = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                cfg = loaded
        except (json.JSONDecodeError, OSError, ValueError):
            # Corrupt / unreadable — start fresh rather than crash. We do NOT
            # delete the file here; the atomic replace below overwrites it.
            cfg = {}

    servers = cfg.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    servers["catgo"] = {"type": "http", "url": url}
    cfg["mcpServers"] = servers

    _atomic_write_json(path, cfg)
    return url


def install_skills(
    skills_src: Path, prefer_symlink: bool, name_glob: str = "catgo-*"
) -> list[str]:
    """Install Claude Code skills from ``skills_src`` into ``~/.claude/skills``.

    Only subdirectories whose name matches ``name_glob`` (default ``catgo-*``,
    i.e. the catgo campaign skills) are installed — NOT the bundled compute
    skills (abinit/vasp/orca/…), which are provided separately by the
    autochem-core plugin and would collide. For each matching direct
    subdirectory of ``skills_src`` that contains a ``SKILL.md``, refresh
    ``~/.claude/skills/<name>``:

    * remove any existing target first (symlink → ``unlink``, dir → ``rmtree``,
      file → ``unlink``) so re-runs never stack stale copies, then
    * if ``prefer_symlink`` is set, try a directory symlink and on ``OSError``
      (e.g. Windows without the developer-mode / admin symlink privilege) fall
      back to :func:`shutil.copytree`;
    * otherwise always copy.

    Returns the list of installed skill names. Idempotent.
    """
    skills_src = Path(skills_src)
    dest_root = _skills_dir()
    dest_root.mkdir(parents=True, exist_ok=True)

    installed: list[str] = []
    if not skills_src.is_dir():
        return installed

    for src in sorted(p for p in skills_src.glob(name_glob) if p.is_dir()):
        if not (src / "SKILL.md").is_file():
            continue
        target = dest_root / src.name

        # Clear whatever is currently there so the install is a clean refresh.
        if target.is_symlink():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()

        if prefer_symlink:
            try:
                target.symlink_to(src, target_is_directory=True)
            except OSError:
                # Windows non-admin (or filesystem without symlink support).
                shutil.copytree(src, target)
        else:
            shutil.copytree(src, target)

        installed.append(src.name)

    return installed


def ensure_claude_integration(
    api_base: str,
    *,
    prefer_symlink: bool = False,
    skills_src: Path | None = None,
) -> dict:
    """Register the MCP server and install skills; never raises.

    Each step is wrapped independently so a failure in one (e.g. a skills copy
    that hits a permission error) does not abort the other. Errors are collected
    under the ``"errors"`` key of the returned dict.

    Returns::

        {
            "mcp_url": "<url or None>",
            "skills": ["<installed names>"],
            "claude_json": "<path to ~/.claude.json>",
            "errors": {"mcp": "...", "skills": "..."},  # only present on failure
        }
    """
    if skills_src is None:
        skills_src = default_skills_dir()

    result: dict = {
        "mcp_url": None,
        "skills": [],
        "claude_json": str(_claude_json_path()),
    }
    errors: dict[str, str] = {}

    try:
        result["mcp_url"] = register_mcp_http(api_base)
    except Exception as exc:  # noqa: BLE001 — never raise to caller
        errors["mcp"] = f"{type(exc).__name__}: {exc}"

    try:
        result["skills"] = install_skills(skills_src, prefer_symlink=prefer_symlink)
    except Exception as exc:  # noqa: BLE001 — never raise to caller
        errors["skills"] = f"{type(exc).__name__}: {exc}"

    if errors:
        result["errors"] = errors
    return result

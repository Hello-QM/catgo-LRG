# server/routers/hub.py
"""Plugin Hub — browse, install, update, and publish plugins from a GitHub registry."""

from __future__ import annotations

import ast
import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from catgo.tools import registry
from catgo.tools.models import ToolEntry
from catgo.tools.sandbox import audit_code, verify_tool_format

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hub", tags=["hub"])

# ── Configuration ──

CATGO_HUB_URL = os.environ.get(
    "CATGO_HUB_URL",
    "https://raw.githubusercontent.com/Hello-QM/catgo-plugins/main",
)

# Optional GitHub token for private repo access.
# Set CATGO_HUB_TOKEN to a PAT with repo read scope.
# Falls back to `gh auth token` if available.
def _resolve_hub_token() -> str:
    token = os.environ.get("CATGO_HUB_TOKEN", "")
    if token:
        return token
    try:
        import subprocess
        result = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return ""

CATGO_HUB_TOKEN = _resolve_hub_token()

TOOLS_DIR = Path.home() / ".catgo" / "tools"


def _hub_headers() -> dict[str, str]:
    """Build HTTP headers for hub requests, with auth if token is configured."""
    headers: dict[str, str] = {}
    if CATGO_HUB_TOKEN:
        headers["Authorization"] = f"token {CATGO_HUB_TOKEN}"
    return headers

# ── Index Cache ──

_index_cache: Optional[list[dict]] = None
_index_cache_time: float = 0.0
_INDEX_TTL: float = 300.0  # 5 minutes
_index_lock = asyncio.Lock()

# Plugin ID validation — matches tools.models.validate_tool_id pattern
_VALID_PLUGIN_ID = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def _validate_plugin_id(plugin_id: str) -> None:
    """Raise HTTPException if plugin_id contains path traversal or invalid chars."""
    if not _VALID_PLUGIN_ID.match(plugin_id):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid plugin_id: {plugin_id!r}. Must match [a-z0-9][a-z0-9_-]*",
        )


async def _fetch_index(force: bool = False) -> list[dict]:
    """Fetch and cache the hub index.json. Raises HTTPException on failure."""
    global _index_cache, _index_cache_time

    async with _index_lock:
        now = time.time()
        if not force and _index_cache is not None and (now - _index_cache_time) < _INDEX_TTL:
            return _index_cache

        url = f"{CATGO_HUB_URL}/index.json"
        try:
            async with httpx.AsyncClient(timeout=10.0, headers=_hub_headers()) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                data = resp.json()
        except httpx.TimeoutException:
            raise HTTPException(
                status_code=504,
                detail=f"Timeout fetching hub index from {url}",
            )
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status_code=502,
                detail=f"Hub returned {e.response.status_code}: {url}",
            )
        except Exception as e:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to fetch hub index: {e}",
            )

        plugins = data if isinstance(data, list) else data.get("plugins", [])
        _index_cache = plugins
        _index_cache_time = now
        return plugins


def _find_plugin_in_index(plugins: list[dict], plugin_id: str) -> dict:
    """Look up a plugin by id in the index. Raises HTTPException if not found."""
    for p in plugins:
        if p.get("id") == plugin_id:
            return p
    raise HTTPException(status_code=404, detail=f"Plugin not found in hub: {plugin_id}")


# ── Response Models ──

class InstalledPlugin(BaseModel):
    id: str
    name: str
    version: str
    latest_version: Optional[str] = None
    update_available: bool = False
    trust: str = "sandboxed"
    category: str = "general"
    source: str = "hub"


class PublishInfo(BaseModel):
    id: str
    name: str
    version: str
    description: str
    author: str
    category: str
    folder: str
    sha256_tool_py: str
    tags: list[str] = []
    instructions: str


# ── Endpoints ──

@router.get("/index")
async def get_index():
    """Fetch the hub plugin index (cached 5 min)."""
    plugins = await _fetch_index()
    return {"plugins": plugins}


@router.get("/installed")
async def get_installed():
    """List locally installed plugins with update availability."""
    plugins = await _safe_fetch_index()
    hub_map = {p["id"]: p for p in plugins} if plugins else {}

    installed: list[dict] = []
    if not TOOLS_DIR.exists():
        return {"installed": installed}

    for item in sorted(TOOLS_DIR.iterdir()):
        if not item.is_dir() or item.name.startswith((".", "__")):
            continue
        manifest_path = item / "catgo-tool.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("Failed to parse manifest: %s", manifest_path)
            continue

        plugin_id = manifest.get("name", item.name)
        version = manifest.get("version", "0.0.0")
        hub_entry = hub_map.get(plugin_id)
        latest = hub_entry.get("version", version) if hub_entry else version

        installed.append({
            "id": plugin_id,
            "name": manifest.get("displayName", plugin_id),
            "version": version,
            "latest_version": latest,
            "update_available": _is_newer(latest, version),
            "trust": manifest.get("trust", "sandboxed"),
            "category": manifest.get("category", "general"),
            "source": "hub" if hub_entry else "local",
        })

    return {"installed": installed}


@router.post("/install/{plugin_id}")
async def install_plugin(plugin_id: str):
    """Download, verify, and install a plugin from the hub."""
    _validate_plugin_id(plugin_id)
    plugins = await _fetch_index()
    entry = _find_plugin_in_index(plugins, plugin_id)
    return await _download_and_install(entry, plugin_id)


@router.post("/update/{plugin_id}")
async def update_plugin(plugin_id: str):
    """Update an installed plugin to the latest hub version."""
    _validate_plugin_id(plugin_id)
    plugins = await _fetch_index()
    entry = _find_plugin_in_index(plugins, plugin_id)

    # Backup old install for atomic update
    tool_dir = TOOLS_DIR / plugin_id
    backup = tool_dir.with_suffix(".bak")
    if tool_dir.exists():
        if backup.exists():
            shutil.rmtree(backup)
        shutil.move(str(tool_dir), str(backup))

    # Unregister old entry
    existing = registry.get(plugin_id)
    if existing:
        registry.unregister(plugin_id)

    try:
        result = await _download_and_install(entry, plugin_id)
        # Success — remove backup
        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
        return result
    except Exception:
        # Restore backup on failure
        if backup.exists():
            shutil.rmtree(tool_dir, ignore_errors=True)
            shutil.move(str(backup), str(tool_dir))
        raise


@router.delete("/uninstall/{plugin_id}")
def uninstall_plugin(plugin_id: str):
    """Remove an installed plugin."""
    _validate_plugin_id(plugin_id)
    registry.unregister(plugin_id)

    tool_dir = TOOLS_DIR / plugin_id
    if not tool_dir.exists():
        raise HTTPException(status_code=404, detail=f"Plugin not installed: {plugin_id}")

    shutil.rmtree(tool_dir)
    logger.info("Uninstalled plugin: %s", plugin_id)
    return {"status": "uninstalled", "plugin_id": plugin_id}


@router.post("/publish/{tool_id}")
def publish_plugin(tool_id: str):
    """Generate index.json entry data for publishing a tool to the hub."""
    # Look in ~/.catgo/tools/ first, then project plugins/
    tool_dir = TOOLS_DIR / tool_id
    if not tool_dir.exists():
        project_plugins = Path(__file__).resolve().parent.parent.parent / "plugins"
        tool_dir = project_plugins / tool_id
    if not tool_dir.exists():
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")

    tool_py = tool_dir / "tool.py"
    if not tool_py.exists():
        raise HTTPException(status_code=400, detail=f"No tool.py in {tool_dir}")

    source = tool_py.read_text(encoding="utf-8")
    sha256 = hashlib.sha256(source.encode("utf-8")).hexdigest()

    # Load manifest for metadata
    manifest: dict = {}
    manifest_path = tool_dir / "catgo-tool.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    # Try to extract TOOL dict for additional metadata
    tool_dict = _extract_tool_dict_safe(source)

    plugin_id = manifest.get("name", tool_dict.get("name", tool_id))
    return {
        "id": plugin_id,
        "name": manifest.get("displayName", tool_dict.get("display_name", plugin_id)),
        "version": manifest.get("version", tool_dict.get("version", "1.0.0")),
        "description": manifest.get("description", tool_dict.get("description", "")),
        "author": manifest.get("author", tool_dict.get("author", "")),
        "category": tool_dict.get("category", "general"),
        "folder": plugin_id,
        "sha256_tool_py": sha256,
        "tags": tool_dict.get("tags", []),
        "instructions": (
            "To publish this plugin:\n"
            "1. Fork https://github.com/Hello-QM/catgo-plugins\n"
            f"2. Create plugins/{plugin_id}/ with tool.py and catgo-tool.json\n"
            "3. Add the entry above to index.json\n"
            "4. Submit a pull request"
        ),
    }


@router.get("/search")
async def search_plugins(q: str = Query(..., min_length=1)):
    """Search hub index by name, description, or tags."""
    plugins = await _fetch_index()
    query = q.lower()
    results = []
    for p in plugins:
        searchable = " ".join([
            p.get("name", ""),
            p.get("description", ""),
            " ".join(p.get("tags", [])),
            p.get("id", ""),
        ]).lower()
        if query in searchable:
            results.append(p)
    return {"plugins": results, "query": q}


# ── Helpers ──

async def _safe_fetch_index() -> list[dict]:
    """Fetch index without raising — returns empty list on failure."""
    try:
        return await _fetch_index()
    except HTTPException:
        logger.warning("Could not fetch hub index; skipping update checks")
        return []


async def _download_and_install(entry: dict, plugin_id: str) -> dict:
    """Download files from hub, verify, audit, and register a plugin."""
    folder = entry.get("folder", plugin_id)
    expected_sha = entry.get("sha256_tool_py")

    base_url = f"{CATGO_HUB_URL}/plugins/{folder}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        # Download tool.py
        try:
            resp = await client.get(f"{base_url}/tool.py")
            resp.raise_for_status()
            tool_py_content = resp.text
        except Exception as e:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to download tool.py for {plugin_id}: {e}",
            )

        # Download catgo-tool.json
        try:
            resp = await client.get(f"{base_url}/catgo-tool.json")
            resp.raise_for_status()
            manifest_content = resp.text
        except Exception as e:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to download catgo-tool.json for {plugin_id}: {e}",
            )

    # Verify SHA-256 (required — refuse install if missing)
    if not expected_sha:
        raise HTTPException(
            status_code=422,
            detail=f"Hub index entry for {plugin_id} has no sha256_tool_py — refusing install",
        )
    actual_sha = hashlib.sha256(tool_py_content.encode("utf-8")).hexdigest()
    if actual_sha != expected_sha:
        raise HTTPException(
            status_code=422,
            detail=(
                f"SHA-256 mismatch for {plugin_id}/tool.py: "
                f"expected {expected_sha[:16]}..., got {actual_sha[:16]}..."
            ),
        )

    # Security audit
    violations = audit_code(tool_py_content)
    if violations:
        raise HTTPException(
            status_code=422,
            detail=f"Security audit failed for {plugin_id}:\n" + "\n".join(violations),
        )

    # Format verification
    format_errors = verify_tool_format(tool_py_content)
    if format_errors:
        raise HTTPException(
            status_code=422,
            detail=f"Format check failed for {plugin_id}:\n" + "\n".join(format_errors),
        )

    # Write to disk
    tool_dir = TOOLS_DIR / plugin_id
    tool_dir.mkdir(parents=True, exist_ok=True)

    (tool_dir / "tool.py").write_text(tool_py_content, encoding="utf-8")

    # Force trust to sandboxed regardless of what the hub manifest says
    try:
        manifest = json.loads(manifest_content)
    except json.JSONDecodeError:
        manifest = {}
    manifest["trust"] = "sandboxed"
    (tool_dir / "catgo-tool.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # Extract TOOL dict via AST (safe - no module-level code runs in-process).
    # Sandboxed tools read tool.py from disk at call time via the sandbox subprocess.
    try:
        tool_dict = _extract_tool_dict_safe(tool_py_content)
    except Exception as e:
        shutil.rmtree(tool_dir, ignore_errors=True)
        raise HTTPException(
            status_code=422,
            detail=f"Failed to extract TOOL dict from {plugin_id}: {e}",
        )

    # Build ToolEntry manually without importing the module
    tool_entry = ToolEntry(
        id=plugin_id,
        name=tool_dict.get("name", plugin_id),
        description=tool_dict.get("description", ""),
        version=manifest.get("version", "1.0.0"),
        author=manifest.get("author", ""),
        category=tool_dict.get("category", "general"),
        input_schema=tool_dict.get("input_schema", {"type": "object", "properties": {}}),
        output_type=tool_dict.get("output_type", "text"),
        trust="sandboxed",
        permissions=[],
        source="directory",
        path=tool_dir,
        node_definition=tool_dict.get("node_definition"),
        supported_formats=tool_dict.get("supported_formats"),
    )

    registry.register(tool_entry)
    logger.info("Installed plugin from hub: %s v%s", plugin_id, tool_entry.version)

    return {"status": "installed", "tool": tool_entry.to_dict()}


def _is_newer(latest: str, current: str) -> bool:
    """Simple semver comparison: True if latest > current."""
    try:
        lat = tuple(int(x) for x in latest.split("."))
        cur = tuple(int(x) for x in current.split("."))
        return lat > cur
    except (ValueError, AttributeError):
        return latest != current


def _extract_tool_dict_safe(source: str) -> dict:
    """Extract TOOL dict from source via AST (safe — only static literals)."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "TOOL":
                    try:
                        return ast.literal_eval(node.value)
                    except (ValueError, TypeError):
                        return {}
    return {}

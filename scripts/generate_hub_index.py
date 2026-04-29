#!/usr/bin/env python3
"""Generate index.json for the CatGO Plugin Hub.

Walks a plugins directory, reads each plugin's catgo-tool.json manifest
and tool.py TOOL dict, then produces a single index.json suitable for
the hub API to serve.

Usage:
    python scripts/generate_hub_index.py plugins/ -o index.json
    python scripts/generate_hub_index.py              # defaults: plugins/ → index.json
"""

import argparse
import ast
import hashlib
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# Well-known scientific Python packages to detect in imports
KNOWN_PACKAGES = frozenset({
    "numpy", "pymatgen", "ase", "scipy", "matplotlib",
    "sklearn", "pandas", "h5py", "torch", "tensorflow",
    "jarvis", "mp_api", "phonopy", "spglib",
})


def _extract_tool_dict(source: str) -> dict | None:
    """Parse tool.py source and extract the TOOL dict via AST.

    Looks for a top-level assignment ``TOOL = {...}`` and safely evaluates
    the right-hand side with ``ast.literal_eval`` (only allows Python
    literals — no function calls or arbitrary code execution).
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        logger.warning("Failed to parse tool.py: %s", exc)
        return None

    for node in ast.iter_child_nodes(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "TOOL":
                try:
                    return ast.literal_eval(node.value)
                except (ValueError, TypeError) as exc:
                    logger.warning("TOOL dict is not a literal: %s", exc)
                    return None
    return None


def _extract_imports(source: str) -> list[str]:
    """Scan tool.py for import statements and return known package names."""
    requires: set[str] = set()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in KNOWN_PACKAGES:
                    requires.add(top)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                top = node.module.split(".")[0]
                if top in KNOWN_PACKAGES:
                    requires.add(top)

    return sorted(requires)


def _sha256(content: bytes) -> str:
    """Return hex SHA-256 digest of content."""
    return hashlib.sha256(content).hexdigest()


def _file_mtime_iso(path: Path) -> str:
    """Return file modification time as ISO 8601 string (UTC)."""
    ts = os.path.getmtime(path)
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def process_plugin(plugin_dir: Path) -> dict | None:
    """Process a single plugin directory and return its index entry."""
    tool_py = plugin_dir / "tool.py"
    manifest = plugin_dir / "catgo-tool.json"

    if not tool_py.exists():
        logger.debug("Skipping %s: no tool.py", plugin_dir.name)
        return None

    # Read tool.py
    tool_source = tool_py.read_text(encoding="utf-8")
    tool_bytes = tool_py.read_bytes()
    tool_dict = _extract_tool_dict(tool_source)
    if not tool_dict:
        logger.warning("Skipping %s: could not extract TOOL dict", plugin_dir.name)
        return None

    # Read manifest (optional — fill defaults from TOOL dict)
    manifest_data: dict = {}
    if manifest.exists():
        try:
            manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Bad catgo-tool.json in %s: %s", plugin_dir.name, exc)

    # Build entry
    plugin_id = tool_dict.get("name", plugin_dir.name)
    display_name = (
        manifest_data.get("displayName")
        or tool_dict.get("display_name")
        or tool_dict.get("name", plugin_dir.name)
    )

    entry: dict = {
        "id": plugin_id,
        "display_name": display_name,
        "description": tool_dict.get("description", manifest_data.get("description", "")),
        "version": manifest_data.get("version", tool_dict.get("version", "0.0.0")),
        "author": manifest_data.get("author", tool_dict.get("author", "")),
        "category": tool_dict.get("category", "general"),
        "output_type": tool_dict.get("output_type", "text"),
        "tags": manifest_data.get("tags", []),
        "requires": _extract_imports(tool_source),
        "folder": plugin_dir.name,
        "sha256_tool_py": _sha256(tool_bytes),
        "updated_at": _file_mtime_iso(tool_py),
    }

    return entry


def generate_index(plugins_dir: Path) -> dict:
    """Generate the full index.json structure."""
    plugins: list[dict] = []

    if not plugins_dir.is_dir():
        logger.error("Plugins directory does not exist: %s", plugins_dir)
        return {"schema_version": "1", "generated_at": "", "plugins": []}

    for child in sorted(plugins_dir.iterdir()):
        if not child.is_dir():
            continue
        # Skip hidden directories and __pycache__
        if child.name.startswith((".", "_")):
            continue

        entry = process_plugin(child)
        if entry:
            plugins.append(entry)
            logger.info("Indexed: %s (%s)", entry["id"], entry["folder"])

    index = {
        "schema_version": "1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "plugins": plugins,
    }

    logger.info("Generated index with %d plugin(s)", len(plugins))
    return index


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate index.json for the CatGO Plugin Hub",
    )
    parser.add_argument(
        "plugins_dir",
        nargs="?",
        default="plugins/",
        help="Path to plugins directory (default: plugins/)",
    )
    parser.add_argument(
        "-o", "--output",
        default="index.json",
        help="Output file path (default: index.json)",
    )
    args = parser.parse_args()

    plugins_dir = Path(args.plugins_dir).resolve()
    output_path = Path(args.output)

    index = generate_index(plugins_dir)

    output_path.write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    logger.info("Wrote %s", output_path)

    return 0


if __name__ == "__main__":
    sys.exit(main())

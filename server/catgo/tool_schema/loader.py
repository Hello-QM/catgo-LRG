"""Load tool definitions from JSON schema files.

Each .json file in this directory contains a list of tool definitions.
Files are loaded in sorted order so the final list is deterministic.
"""

import json
from pathlib import Path


def load_all_tools() -> list[dict]:
    """Load and return all tool definitions from JSON schema files."""
    schema_dir = Path(__file__).parent
    tools: list[dict] = []
    for f in sorted(schema_dir.glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        if isinstance(data, list):
            tools.extend(data)
    return tools


def load_tools_by_category(category: str) -> list[dict]:
    """Load tool definitions from a single category JSON file.

    Args:
        category: The category name (without .json extension),
                  e.g. "structure", "building", "optimization".

    Returns:
        List of tool definition dicts, or empty list if file not found.
    """
    schema_dir = Path(__file__).parent
    path = schema_dir / f"{category}.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else []

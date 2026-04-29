"""Structure Manipulation + Structure Building tools.

Structure Manipulation tools are loaded from the shared JSON schema at
server/tool_schema/structure.json (single source of truth for both
backend and future frontend code generation).

Structure Building tools remain inline here until migrated.
"""

import sys
from pathlib import Path

# Ensure server/ is on sys.path so tool_schema can be imported
_server_dir = str(Path(__file__).resolve().parent.parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from catgo.tool_schema.loader import load_tools_by_category

# ─── Structure Manipulation (from shared JSON schema) ───
_structure_tools = load_tools_by_category("structure")

# ─── Structure Building (inline, pending migration) ───
_building_tools: list[dict] = [
    {
        "name": "catgo_build_defect",
        "description": "Generate point defects (vacancy, substitution, interstitial) in a structure.",
        "endpoint": "/build/defect",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "defect_type": {"type": "string", "enum": ["vacancy", "substitution", "interstitial"]},
                "site_index": {"type": "integer", "description": "Site index for vacancy/substitution"},
                "new_element": {"type": "string", "description": "New element for substitution/interstitial"},
                "position": {"type": "array", "items": {"type": "number"}, "description": "Position for interstitial"},
            },
            "required": ["structure", "defect_type"],
        },
    },
    {
        "name": "catgo_build_strain",
        "description": "Apply strain/deformation to a periodic structure.",
        "endpoint": "/build/strain",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "strain": {
                    "type": "array", "items": {"type": "number"},
                    "description": "Strain values (Voigt notation or 3x3 matrix)",
                },
            },
            "required": ["structure", "strain"],
        },
    },
]

__all__ = ["TOOLS"]

TOOLS: list[dict] = _structure_tools + _building_tools

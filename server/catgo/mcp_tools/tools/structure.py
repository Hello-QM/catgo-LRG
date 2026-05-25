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
        "name": "catgo_build_slab",
        "description": (
            "Cut a surface slab from a bulk crystal using Miller indices. "
            "Returns all symmetrically distinct terminations, each as a "
            "full Structure dict with vacuum padding applied. "
            "\n\n"
            "USE THIS WHEN the user asks to: build/cut/generate/make a "
            "slab / surface / facet / Miller-index surface (e.g. Pt(111), "
            "Cu(100), TiO2(110), ZnO(0001), MoS2(001)) / 切面 / 表面 / "
            "slab 模型. Also use this when a heterostructure flow needs "
            "an intermediate slab BEFORE pmacker / interface tools. "
            "\n\n"
            "DO NOT call bash + import pymatgen.surface.SlabGenerator and "
            "write your own slab cutting code. This tool wraps it with "
            "the right conventional-cell + Miller-index handling. "
            "Hand-rolling produces wrong Miller orientation for non-cubic "
            "systems (hexagonal / trigonal especially). "
            "\n\n"
            "EXAMPLES of prompts that trigger this tool: "
            "'cut Pt(111) slab', '切 ZnO(0001) 表面', "
            "'build a 5-layer Cu(100) slab with 15 Å vacuum', "
            "'generate the (110) surface of TiO2'."
        ),
        "endpoint": "/structure-ops/generate-slab",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {
                    "type": "object",
                    "description": "Bulk crystal structure dict (pymatgen Structure.as_dict() format)",
                },
                "miller_index": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "minItems": 3,
                    "maxItems": 3,
                    "description": "Miller indices [h, k, l], e.g. [1, 1, 1] for (111)",
                },
                "min_slab_size": {
                    "type": "number",
                    "default": 10.0,
                    "description": "Minimum slab thickness in Angstroms (or unit planes if in_unit_planes=true)",
                },
                "min_vacuum_size": {
                    "type": "number",
                    "default": 15.0,
                    "description": "Minimum vacuum spacing in Angstroms",
                },
                "center_slab": {
                    "type": "boolean",
                    "default": True,
                    "description": "Center the slab vertically in the cell",
                },
                "in_unit_planes": {
                    "type": "boolean",
                    "default": False,
                    "description": "Interpret min_slab_size as number of unit planes instead of Angstroms",
                },
                "max_normal_search": {
                    "type": "integer",
                    "description": "Max integer for normal vector search (omit for default). Higher = more accurate normal but slower.",
                },
                "orthogonalize_c": {
                    "type": "boolean",
                    "default": False,
                    "description": "Force c-vector perpendicular to surface (lossless for cubic, may distort hexagonal cells)",
                },
            },
            "required": ["structure", "miller_index"],
        },
    },
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

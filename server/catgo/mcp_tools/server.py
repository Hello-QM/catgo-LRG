"""CatGO MCP Server — thin wrapper over the FastAPI backend.

Exposes CatGO's structure manipulation, building, optimization, view capture,
and analysis capabilities as MCP tools. Designed for use with Claude Code,
Gemini CLI, VS Code Copilot, and other MCP-compatible AI clients.

Usage:
    # stdio transport (for Claude Code / Gemini CLI):
    python mcp_server.py

    # Or specify a custom backend URL:
    CATGO_API=http://localhost:8000/api python mcp_server.py

MCP config (claude_desktop_config.json / .claude/mcp.json):
    {
      "mcpServers": {
        "catgo": {
          "command": "conda",
          "args": ["run", "-n", "catgo", "python", "/path/to/server/mcp_server.py"]
        }
      }
    }
"""

import json
import logging
import os
import sys

import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

# Ensure server/ is on sys.path so plugin_loader and mcp_tools are importable
_server_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from plugin_loader import get_plugin_tool_defs, dispatch_plugin
from catgo.mcp_tools.tools import TOOLS

# Import helpers and sub-modules
from catgo.mcp_tools.helpers import API_BASE, _strip_structure_from_schema, _summarize_structure_result
from catgo.mcp_tools.workflow_tools import (
    _handle_workflow,
    _handle_import_atomate2_template,
    _handle_import_quacc_template,
    _handle_create_screening_workflow,
    CATBOT_KNOWLEDGE,
)
from catgo.mcp_tools.structure_tools import (
    _handle_set_lattice,
    _handle_fetch_crystal,
    _handle_search_crystals,
    _handle_fetch_molecule,
)
from catgo.mcp_tools.plugin_tools import _handle_plugin_analyzer, _handle_plugin_reader

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

server = Server("catgo")


@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    all_tools = [
        Tool(
            name=t["name"],
            description=t["description"],
            inputSchema=_strip_structure_from_schema(t["inputSchema"]),
        )
        for t in TOOLS
    ]

    # Hot-reload user plugins from ~/.catgo/plugins/
    for pdef in get_plugin_tool_defs():
        all_tools.append(Tool(
            name=pdef["name"],
            description=pdef.get("description", ""),
            inputSchema=_strip_structure_from_schema(pdef.get("inputSchema", {})),
        ))

    # Add tools from ToolRegistry
    try:
        from catgo.tools import registry as tool_registry
        for entry in tool_registry.list_all():
            if entry.enabled:
                all_tools.append(Tool(
                    name=f"catgo_ext_{entry.id}",
                    description=entry.description,
                    inputSchema=entry.input_schema or {"type": "object", "properties": {}},
                ))
    except ImportError:
        pass

    # Add workflow import and screening tools
    all_tools.extend([
        Tool(
            name="catgo_import_atomate2_template",
            description=(
                "Import a pre-built atomate2 workflow template into a new CatGo workflow. "
                "Creates a complete workflow with nodes and edges ready to run. "
                "Available templates: atomate2-double-relax, atomate2-band-structure, "
                "atomate2-hse-band-structure, atomate2-elastic, atomate2-phonon, "
                "atomate2-eos, atomate2-dielectric, atomate2-optics, "
                "atomate2-mlp-vasp-refinement, atomate2-mlp-phonon. "
                "Example: import_atomate2_template(template_id='atomate2-double-relax')"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "template_id": {
                        "type": "string",
                        "description": "Template ID, e.g. 'atomate2-double-relax'",
                    },
                },
                "required": ["template_id"],
            },
        ),
        Tool(
            name="catgo_import_quacc_template",
            description=(
                "Import a pre-built quacc workflow template into a new CatGo workflow. "
                "Creates a complete workflow with nodes and edges ready to run. "
                "Available templates: quacc-slab-relax, quacc-band-structure, "
                "quacc-mlp-phonon, quacc-mlp-elastic, quacc-mlp-dft-refine, "
                "quacc-xtb-orca, quacc-qe-bands, quacc-qe-phonon. "
                "Example: import_quacc_template(template_id='quacc-mlp-phonon')"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "template_id": {
                        "type": "string",
                        "description": "Template ID, e.g. 'quacc-mlp-phonon'",
                    },
                },
                "required": ["template_id"],
            },
        ),
        Tool(
            name="catgo_create_screening_workflow",
            description=(
                "Create a high-throughput screening workflow from a template pattern. "
                "Builds a complete workflow: structure_input → batch_generate → map → "
                "[calculation nodes] → aggregate. Supports catalyst screening (adsorbate "
                "placement), dopant screening (element substitution), surface energy "
                "screening (Miller indices), EOS (lattice scan), and two-stage MLP+DFT "
                "pre-screening. "
                "Example: create_screening_workflow(screening_type='dopant', software='vasp', "
                "elements='Ti,V,Cr,Mn,Fe')"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "screening_type": {
                        "type": "string",
                        "enum": ["catalyst", "dopant", "surface", "eos", "mlp_prescreen"],
                        "description": "Type of screening workflow to create",
                    },
                    "software": {
                        "type": "string",
                        "enum": ["vasp", "cp2k", "orca", "mlp", "xtb"],
                        "description": "Calculation software to use",
                    },
                    "elements": {
                        "type": "string",
                        "description": "Comma-separated elements for dopant screening, e.g. 'Ti,V,Cr,Mn,Fe'",
                    },
                    "miller_indices": {
                        "type": "string",
                        "description": "Comma-separated Miller indices for surface screening, e.g. '100,110,111'",
                    },
                    "adsorbate": {
                        "type": "string",
                        "description": "Adsorbate formula for catalyst screening, e.g. 'OH', 'CO', 'N2'",
                    },
                },
                "required": ["screening_type", "software"],
            },
        ),
    ])

    # Add sandbox file-writing tools
    all_tools.extend([
        Tool(
            name="catgo_write_file",
            description=(
                "Propose writing a file to CatGO sandbox directories (~/.catgo/plugins/, scripts/, "
                "config/, tools/). The file will be staged for user approval before being written. "
                "Use catgo_get_template first to get the correct format."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "target_path": {
                        "type": "string",
                        "description": "Target file path, e.g. '~/.catgo/plugins/my_tool.py' or '~/.catgo/scripts/analyze.py'",
                    },
                    "content": {
                        "type": "string",
                        "description": "Complete file content to write",
                    },
                    "description": {
                        "type": "string",
                        "description": "Brief description of what this file does",
                    },
                },
                "required": ["target_path", "content"],
            },
        ),
        Tool(
            name="catgo_get_template",
            description=(
                "Get a file template for CatGO plugins, scripts, workflow nodes, or config files. "
                "Call this BEFORE writing a file to get the correct format."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "file_type": {
                        "type": "string",
                        "enum": ["plugin", "script", "workflow_node", "config"],
                        "description": "Type of file template to retrieve",
                    },
                },
                "required": ["file_type"],
            },
        ),
    ])

    # Add lifecycle tools
    _CREATE_TOOL_DESC = (
        "Create and test a CatGO tool from Python code. The code is audited for security, "
        "format-checked, then executed in a sandboxed subprocess (30s timeout). Returns "
        "{ephemeral_id, data, error}. Use catgo_save_tool to persist it.\n"
        "\n"
        "## TOOL Dict (required top-level assignment)\n"
        "```python\n"
        "TOOL = {\n"
        '    "name": "my_tool",              # unique ID, must match [a-z0-9][a-z0-9_-]*\n'
        '    "display_name": "My Tool",      # human-readable label for UI\n'
        '    "description": "What it does",  # shown in tool list\n'
        '    "category": "general",          # general | calculator | reader | optimizer | workflow_node\n'
        '    "input_schema": {               # JSON Schema for user params\n'
        '        "type": "object",\n'
        '        "properties": {\n'
        '            "param1": {"type": "number", "default": 1.0, "description": "..."}\n'
        "        }\n"
        "    },\n"
        '    "output_type": "bar_plot",      # determines how frontend renders the result\n'
        "    # For workflow_node category only:\n"
        '    "node_definition": {\n'
        '        "type": "my_node_type", "label": "My Node", "color": "#22c55e",\n'
        '        "icon": "wrench", "category": "Plugin",\n'
        '        "inputs": ["structure"], "outputs": ["structure"],\n'
        '        "param_schema": [{"name": "p", "type": "float", "default": 1.0}]\n'
        "    }\n"
        "}\n"
        "```\n"
        "\n"
        "## execute() Function (required)\n"
        "```python\n"
        "async def execute(context: dict) -> dict:\n"
        '    structure = context.get("structure")  # auto-injected pymatgen dict (may be None)\n'
        '    params = context.get("params", {})    # user parameters matching input_schema\n'
        "    # ... compute ...\n"
        "    return result_dict  # shape depends on output_type\n"
        "```\n"
        "\n"
        "## Context Keys by Category\n"
        '- general / calculator / optimizer: {"structure": pymatgen_dict | None, "params": {...}}\n'
        '- reader: {"file_paths": [str, ...], "params": {...}}\n'
        '- workflow_node: {"structure": pymatgen_dict, "params": {...}, "config": {...}}\n'
        "\n"
        "## Category-Specific Extras\n"
        "- calculator: also define `def get_calculator(**params)` returning an ASE calculator\n"
        "- reader: also define `def detect_files(filenames) -> bool` and `def priority_score(filenames) -> int`\n"
        "- optimizer: also define `def get_optimizer(atoms, **params)` returning an ASE optimizer\n"
        "- workflow_node: must include 'node_definition' in TOOL dict\n"
        "\n"
        "## Output Types and Expected Return Shapes\n"
        '- scatter_plot: {"series": [{"label": str, "x": [float], "y": [float]}], "x_axis": {"label": str}, "y_axis": {"label": str}}\n'
        '- bar_plot: {"series": [{"label": str, "values": [float], "categories": [str]}], "x_axis": {"label": str}, "y_axis": {"label": str}}\n'
        '- table: {"columns": [str], "rows": [[any]]}\n'
        '- text: {"text": str}\n'
        '- image: {"base64": str, "mime": str}\n'
        "- structure: pymatgen-compatible structure dict (auto-pushed to 3D viewer)\n"
        '- atom_property: {"property_name": str, "values": [float]} (per-atom coloring)\n'
        '- trajectory: {"frames": [structure_dict, ...]}\n'
        '- electronic_dos: {"energies": [float], "densities": {...}}\n'
        '- electronic_bands: {"bands": [...], "kpoints": [...]}\n'
        '- cohp: {"energies": [float], "cohp": {...}}\n'
        "\n"
        "## Sandbox Security Rules (30s timeout, subprocess isolation)\n"
        "Allowed imports: math, cmath, numpy, scipy, pymatgen, ase, json, re, typing, "
        "dataclasses, collections, itertools, functools, operator, copy\n"
        "Forbidden imports: os, sys, subprocess, socket, http, urllib, requests, pathlib, io, "
        "shutil, pickle, threading, asyncio, ctypes, importlib, glob, inspect, multiprocessing, "
        "tempfile, signal\n"
        "Forbidden calls: exec, eval, compile, __import__, open, input, breakpoint, getattr, "
        "setattr, delattr\n"
        "\n"
        "## Example: Bond Length Histogram\n"
        "```python\n"
        "TOOL = {\n"
        '    "name": "bond_length_histogram",\n'
        '    "display_name": "Bond Length Histogram",\n'
        '    "description": "Compute bond length distribution",\n'
        '    "category": "general",\n'
        '    "input_schema": {"type": "object", "properties": {\n'
        '        "cutoff": {"type": "number", "default": 3.0}\n'
        "    }},\n"
        '    "output_type": "bar_plot",\n'
        "}\n"
        "\n"
        "async def execute(context):\n"
        "    import numpy as np\n"
        "    from pymatgen.core import Structure\n"
        '    structure = context.get("structure")\n'
        '    if not structure: return {"error": "No structure loaded"}\n'
        "    struct = Structure.from_dict(structure)\n"
        '    cutoff = context.get("params", {}).get("cutoff", 3.0)\n'
        "    neighbors = struct.get_all_neighbors(cutoff)\n"
        "    distances = [n.nn_distance for site_nbrs in neighbors for n in site_nbrs]\n"
        "    hist, edges = np.histogram(distances, bins=20)\n"
        "    centers = [(edges[i] + edges[i+1]) / 2 for i in range(len(hist))]\n"
        "    return {\n"
        '        "series": [{"label": "Bond Lengths", "values": hist.tolist(),\n'
        '                    "categories": [f"{c:.2f}" for c in centers]}],\n'
        '        "x_axis": {"label": "Distance (A)"},\n'
        '        "y_axis": {"label": "Count"},\n'
        "    }\n"
        "```"
    )

    _SAVE_TOOL_DESC = (
        "Save a recently created tool permanently to ~/.catgo/tools/{tool_id}/. "
        "The tool_id defaults to TOOL['name'] from the code, or can be overridden with save_as. "
        "Creates two files: tool.py (source code) and catgo-tool.json (manifest with trust='sandboxed'). "
        "The tool is immediately registered in the ToolRegistry and becomes available as catgo_ext_{tool_id}. "
        "Only tools that executed successfully via catgo_create_tool can be saved (requires valid ephemeral_id)."
    )

    _UPGRADE_TOOL_DESC = (
        "Upgrade a saved tool's trust level from 'sandboxed' to 'user'. "
        "Trust levels: sandboxed = executed in isolated subprocess with 30s timeout and restricted imports "
        "(safe but slower, ~1s overhead); user = executed in-process with full import access "
        "(fast, no timeout, but code must be reviewed for safety first). "
        "Only tools saved to ~/.catgo/tools/ can be upgraded. Updates the catgo-tool.json manifest on disk "
        "and the in-memory ToolRegistry entry. Cannot upgrade to 'builtin' (reserved for shipped tools)."
    )

    _DELETE_TOOL_DESC = (
        "Delete a saved tool from both disk and the in-memory ToolRegistry. "
        "Removes the entire ~/.catgo/tools/{tool_id}/ directory (tool.py + catgo-tool.json). "
        "The tool immediately becomes unavailable. This action is irreversible."
    )

    _LIST_TOOLS_DESC = (
        "List all registered tools in the ToolRegistry. Returns an array of ToolEntry dicts, each containing: "
        "id, name, description, version, category (general|calculator|reader|optimizer|workflow_node), "
        "input_schema, output_type, trust (builtin|user|sandboxed), enabled, source, and category-specific "
        "fields (supported_elements, supported_formats, node_definition, etc.). "
        "Includes tools from all sources: server/tools/builtin/ (trust=builtin), plugins/ (trust=user), "
        "and ~/.catgo/tools/ (trust=sandboxed or user)."
    )

    all_tools.extend([
        Tool(name="catgo_create_tool", description=_CREATE_TOOL_DESC, inputSchema={
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Python source code containing a TOOL dict assignment and an async def execute(context) function. See tool description for full format specification."},
                "test_input": {"type": "object", "description": "Optional test parameters passed as context['params'] during sandbox execution. The current viewer structure is auto-injected as context['structure']."},
            },
            "required": ["code"],
        }),
        Tool(name="catgo_save_tool", description=_SAVE_TOOL_DESC, inputSchema={
            "type": "object",
            "properties": {
                "ephemeral_id": {"type": "string", "description": "The ephemeral_id returned by a successful catgo_create_tool call"},
                "save_as": {"type": "string", "description": "Override the tool ID (defaults to TOOL['name'] from the code). Must match [a-z0-9][a-z0-9_-]*."},
            },
            "required": ["ephemeral_id"],
        }),
        Tool(name="catgo_upgrade_tool", description=_UPGRADE_TOOL_DESC, inputSchema={
            "type": "object",
            "properties": {
                "tool_id": {"type": "string", "description": "ID of the saved tool to upgrade (the directory name under ~/.catgo/tools/)"},
                "trust": {"type": "string", "enum": ["user"], "description": "Target trust level. Currently only 'user' is allowed."},
            },
            "required": ["tool_id"],
        }),
        Tool(name="catgo_delete_tool", description=_DELETE_TOOL_DESC, inputSchema={
            "type": "object",
            "properties": {"tool_id": {"type": "string", "description": "ID of the tool to delete (the directory name under ~/.catgo/tools/)"}},
            "required": ["tool_id"],
        }),
        Tool(name="catgo_list_tools", description=_LIST_TOOLS_DESC, inputSchema={
            "type": "object", "properties": {},
        }),
    ])

    return all_tools


# ---------------------------------------------------------------------------
# Special tool dispatch
# ---------------------------------------------------------------------------

# Map special endpoint keys to handler functions
_SPECIAL_HANDLERS = {
    "__special__/set-lattice": _handle_set_lattice,
    "__special__/fetch-crystal": _handle_fetch_crystal,
    "__special__/search-crystals": _handle_search_crystals,
    "__special__/fetch-molecule": _handle_fetch_molecule,
}


async def _handle_special_tool(name: str, endpoint: str, arguments: dict) -> list[TextContent]:
    """Handle special tools: viewer-dependent ops and database imports."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:

            # Check for structure/viewer handlers
            handler = _SPECIAL_HANDLERS.get(endpoint)
            if handler is not None:
                return await handler(client, arguments)

            # Workflow (unified)
            if endpoint == "__special__/workflow":
                return await _handle_workflow(client, arguments)

            return [TextContent(type="text", text=f"Unknown special tool: {endpoint}")]

    except httpx.ConnectError:
        return [TextContent(type="text", text=f"Cannot connect to CatGO backend at {API_BASE}.")]
    except Exception as exc:
        return [TextContent(type="text", text=f"{name} failed: {exc}")]


# ---------------------------------------------------------------------------
# Direct-dispatch tools (catalysis, presets — no REST endpoint)
# ---------------------------------------------------------------------------

async def _handle_direct_tool(tool_name: str, arguments: dict) -> list[TextContent]:
    """Handle tools that call Python modules directly instead of REST endpoints."""
    try:
        if tool_name == "catgo_catalysis_oer":
            from workflow.catalysis.oer import compute_oer_overpotential
            result = compute_oer_overpotential(**arguments)
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        elif tool_name == "catgo_catalysis_free_energy":
            from workflow.catalysis.free_energy import gibbs_free_energy
            result = gibbs_free_energy(**arguments)
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        elif tool_name == "catgo_catalysis_volcano":
            from workflow.catalysis.volcano import generate_volcano_data
            result = generate_volcano_data(**arguments)
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        elif tool_name == "catgo_cn_coupling_network":
            from catgo.utils.cn_coupling import generate_cn_coupling_network
            c = arguments.get("c_species")
            n = arguments.get("n_species")
            incl = arguments.get("include_infeasible", False)
            result = generate_cn_coupling_network(c, n, incl)
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        elif tool_name == "catgo_catalysis_energy_diagram":
            from workflow.catalysis.energy_diagram import generate_energy_diagram
            pathways = arguments.get("pathways", [])
            if not pathways:
                return [TextContent(type="text", text="Error: at least one pathway is required")]
            config = arguments.get("config")
            result = generate_energy_diagram(pathways=pathways, config=config)
            return [TextContent(type="text", text=json.dumps(result, indent=2, default=str))]

        elif tool_name == "catgo_vasp_presets":
            from workflow.presets.vasp import get_preset
            result = get_preset(arguments["preset_name"])
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        else:
            return [TextContent(type="text", text=f"Unknown direct tool: {tool_name}")]

    except Exception as exc:
        return [TextContent(type="text", text=f"{tool_name} failed: {exc}")]


# ---------------------------------------------------------------------------
# Tool call dispatch
# ---------------------------------------------------------------------------

@server.call_tool()
async def handle_call_tool(name: str, arguments: dict | None) -> list[TextContent]:
    arguments = arguments or {}

    # Find tool definition
    tool_def = next((t for t in TOOLS if t["name"] == name), None)
    if not tool_def:
        # Try hot-loaded user plugins from ~/.catgo/plugins/
        async with httpx.AsyncClient(timeout=30.0) as client:
            plugin_result = await dispatch_plugin(name, arguments, client, API_BASE)
            if plugin_result is not None:
                return plugin_result

        # Check for plugin tools before returning "unknown"
        if name.startswith("catgo_analyze_"):
            return await _handle_plugin_analyzer(name[len("catgo_analyze_"):], arguments)
        if name.startswith("catgo_read_"):
            return await _handle_plugin_reader(name[len("catgo_read_"):], arguments)

        # Workflow import and screening tools
        if name == "catgo_import_atomate2_template":
            async with httpx.AsyncClient(timeout=30.0) as client:
                return await _handle_import_atomate2_template(client, arguments)
        if name == "catgo_import_quacc_template":
            async with httpx.AsyncClient(timeout=30.0) as client:
                return await _handle_import_quacc_template(client, arguments)
        if name == "catgo_create_screening_workflow":
            async with httpx.AsyncClient(timeout=30.0) as client:
                return await _handle_create_screening_workflow(client, arguments)

        # Auto-fetch current structure from viewer for tool lifecycle / registry tools
        panel_id = arguments.pop("panel_id", "default")
        auto_structure = None
        try:
            async with httpx.AsyncClient(timeout=10.0) as sc:
                resp = await sc.get(
                    f"{API_BASE}/view/structure/current",
                    params={"panel_id": panel_id},
                )
                if resp.status_code == 200:
                    auto_structure = resp.json()
        except Exception:
            pass

        # Tool lifecycle MCP tools
        if name == "catgo_create_tool":
            from tools.builder import create_from_code
            try:
                result, eph_id = await create_from_code(
                    arguments["code"],
                    test_input=arguments.get("test_input"),
                    injected_structure=auto_structure,
                )
                text = json.dumps({"ephemeral_id": eph_id, "data": result.data, "error": result.error})
                return [TextContent(type="text", text=text)]
            except ValueError as e:
                return [TextContent(type="text", text=json.dumps({"error": str(e)}))]

        if name == "catgo_save_tool":
            from tools.builder import save_tool
            from catgo.tools import registry as tool_registry
            try:
                entry = save_tool(arguments["ephemeral_id"], save_as=arguments.get("save_as"))
                tool_registry.register(entry)
                return [TextContent(type="text", text=f"Saved tool '{entry.id}' to ~/.catgo/tools/{entry.id}/")]
            except KeyError as e:
                return [TextContent(type="text", text=f"Error: {e}")]

        if name == "catgo_upgrade_tool":
            from tools.builder import upgrade_trust
            from catgo.tools import registry as tool_registry
            try:
                upgrade_trust(arguments["tool_id"], arguments.get("trust", "user"), registry=tool_registry)
                return [TextContent(type="text", text=f"Upgraded '{arguments['tool_id']}' to trust={arguments.get('trust', 'user')}")]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]

        if name == "catgo_delete_tool":
            from tools.builder import delete_tool
            from catgo.tools import registry as tool_registry
            delete_tool(arguments["tool_id"], registry=tool_registry)
            return [TextContent(type="text", text=f"Deleted tool '{arguments['tool_id']}'")]

        if name == "catgo_list_tools":
            from catgo.tools import registry as tool_registry
            tools = [t.to_dict() for t in tool_registry.list_all()]
            return [TextContent(type="text", text=json.dumps(tools, indent=2))]

        # Sandbox file-writing tools
        if name == "catgo_write_file":
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(
                        f"{API_BASE}/files/sandbox/propose",
                        json={
                            "content": arguments.get("content", ""),
                            "target_path": arguments.get("target_path", ""),
                            "description": arguments.get("description", ""),
                            "overwrite": arguments.get("overwrite", False),
                        },
                    )
                    if resp.status_code == 200:
                        return [TextContent(type="text", text=json.dumps(resp.json(), indent=2))]
                    else:
                        detail = resp.text[:500]
                        try:
                            err_data = resp.json()
                            if isinstance(err_data.get("detail"), str):
                                detail = err_data["detail"]
                        except Exception:
                            pass
                        return [TextContent(type="text", text=f"catgo_write_file failed ({resp.status_code}): {detail}")]
            except httpx.ConnectError:
                return [TextContent(type="text", text=f"Cannot connect to CatGO backend at {API_BASE}.")]
            except Exception as exc:
                return [TextContent(type="text", text=f"catgo_write_file failed: {exc}")]

        if name == "catgo_get_template":
            try:
                file_type = arguments.get("file_type", "plugin")
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.get(f"{API_BASE}/files/sandbox/templates/{file_type}")
                    if resp.status_code == 200:
                        return [TextContent(type="text", text=resp.json().get("template", ""))]
                    else:
                        detail = resp.text[:500]
                        try:
                            err_data = resp.json()
                            if isinstance(err_data.get("detail"), str):
                                detail = err_data["detail"]
                        except Exception:
                            pass
                        return [TextContent(type="text", text=f"catgo_get_template failed ({resp.status_code}): {detail}")]
            except httpx.ConnectError:
                return [TextContent(type="text", text=f"Cannot connect to CatGO backend at {API_BASE}.")]
            except Exception as exc:
                return [TextContent(type="text", text=f"catgo_get_template failed: {exc}")]

        # Registry tool dispatch (catgo_ext_*)
        if name.startswith("catgo_ext_"):
            tool_id = name[len("catgo_ext_"):]
            from catgo.tools import registry as tool_registry
            from tools.executor import execute_tool
            entry = tool_registry.get(tool_id)
            if entry:
                result = await execute_tool(entry, arguments, injected_structure=auto_structure)
                if result.error:
                    return [TextContent(type="text", text=f"Error: {result.error}")]
                return [TextContent(type="text", text=json.dumps(result.data))]

        return [TextContent(type="text", text=f"Unknown tool: {name}")]

    endpoint = tool_def["endpoint"]
    method = tool_def["method"]

    # Special tools that auto-fetch the current structure from the viewer
    if endpoint.startswith("__special__/"):
        return await _handle_special_tool(name, endpoint, arguments)

    # Direct-dispatch tools (no REST endpoint, call Python modules directly)
    if endpoint.startswith("__direct__/"):
        return await _handle_direct_tool(name, arguments)

    url = f"{API_BASE}{endpoint}"

    # Auto-inject current viewer structure if tool requires it but caller didn't provide
    panel_id = arguments.pop("panel_id", "default")
    schema = tool_def.get("inputSchema", {})
    needs_structure = "structure" in schema.get("required", [])
    if needs_structure and "structure" not in arguments:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{API_BASE}/view/structure/current",
                    params={"panel_id": panel_id},
                )
                if resp.status_code == 200:
                    arguments["structure"] = resp.json()
                else:
                    return [TextContent(type="text", text="No structure loaded in viewer. Load a structure first.")]
        except Exception:
            return [TextContent(type="text", text="Cannot fetch current structure from viewer.")]

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            if method == "GET":
                resp = await client.get(url, params=arguments if arguments else None)
            else:
                resp = await client.post(url, json=arguments)

            if resp.status_code == 200:
                data = resp.json()

                # Auto-push modified structure back to viewer
                result_struct = None
                if needs_structure:
                    if "structure" in data:
                        result_struct = data["structure"]
                    elif "slabs" in data and data["slabs"]:
                        # Slab generation returns a list — push the first one
                        result_struct = data["slabs"][0]

                if result_struct:
                    push_warn = ""
                    try:
                        await client.post(
                            f"{API_BASE}/view/structure/push",
                            params={"panel_id": panel_id},
                            json={"structure": result_struct},
                        )
                        await client.post(
                            f"{API_BASE}/view/structure/pending-update",
                            params={"panel_id": panel_id},
                            json={"structure": result_struct},
                        )
                    except Exception as exc:
                        push_warn = f"\n\u26a0\ufe0f Viewer push failed: {exc}"
                        logger.warning("Auto-push to viewer failed: %s", exc)

                    # Return concise summary instead of huge structure dict
                    summary = _summarize_structure_result(
                        {**data, "structure": result_struct} if "structure" not in data else data
                    )
                    return [TextContent(type="text", text=summary + push_warn)]

                return [TextContent(type="text", text=json.dumps(data, indent=2))]
            else:
                # Parse error detail for helpful messages
                detail = resp.text[:500]
                try:
                    err_data = resp.json()
                    if isinstance(err_data.get("detail"), list):
                        detail = "; ".join(
                            f"{'.'.join(str(x) for x in d.get('loc', []))}: {d.get('msg', '')}"
                            for d in err_data["detail"]
                        )
                    elif isinstance(err_data.get("detail"), str):
                        detail = err_data["detail"]
                except Exception:
                    pass

                hints = {
                    422: "Check required parameters and their types.",
                    400: "Invalid request \u2014 verify parameters.",
                    404: "Endpoint not found \u2014 the backend may need updating.",
                    500: "Server error \u2014 try simpler parameters or check backend logs.",
                    503: "Service unavailable \u2014 ensure the server is running.",
                }
                hint = hints.get(resp.status_code, "")
                msg = f"{name} failed ({resp.status_code}): {detail}"
                if hint:
                    msg += f"\nHint: {hint}"
                return [TextContent(type="text", text=msg)]

    except httpx.ConnectError:
        return [TextContent(
            type="text",
            text=(
                f"Cannot connect to CatGO backend at {API_BASE}. "
                f"Start it with: conda run -n catgo python -m uvicorn server.main:app --reload"
            ),
        )]
    except httpx.TimeoutException:
        return [TextContent(
            type="text",
            text=f"{name} timed out after 120s. The computation may be too large \u2014 try with a smaller structure or fewer parameters.",
        )]
    except Exception as exc:
        return [TextContent(type="text", text=f"{name} failed: {exc}")]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

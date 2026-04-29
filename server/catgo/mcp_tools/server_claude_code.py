"""CatGO MCP Server — Claude Code Edition.

Lightweight MCP entry point with 8 consolidated tools (instead of 50+).
Designed for minimal token overhead in Claude Code's system prompt.

Routes to the same FastAPI backend as the full server.

Usage:
    python server/mcp_tools/server_claude_code.py

MCP config (~/.claude/mcp.json):
    {
      "mcpServers": {
        "catgo": {
          "command": "/path/to/python",
          "args": ["/path/to/server/mcp_tools/server_claude_code.py"],
          "env": {"CATGO_API": "http://localhost:8000/api"}
        }
      }
    }
"""

import asyncio
import json
import logging
import os
import sys

import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

# Ensure server/ is on sys.path so we can reuse helpers from the full server
_server_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

logger = logging.getLogger(__name__)

API_BASE = os.environ.get("CATGO_API", "http://localhost:8000/api")

server = Server("catgo-claude-code")


# ---------------------------------------------------------------------------
# Tool Definitions (8 consolidated tools)
# ---------------------------------------------------------------------------

TOOLS = [
    Tool(
        name="catgo_structure",
        description=(
            "Manipulate crystal structures in CatGO viewer. "
            "Actions: get, add_atom, add_atoms, delete, replace, move, "
            "supercell, set_lattice, slab, doping, merge, add_molecule, load_file. "
            "doping: substitutional doping — replaces host_element atoms with dopant. "
            "Supports concentration (number of substitutions) and enumerate (unique configs). "
            "IMPORTANT: For doped slabs, ALWAYS generate the slab from pristine bulk FIRST, "
            "then dope the slab. Doping bulk before slabbing replicates the dopant N× "
            "(once per bulk repeat in slab thickness), giving unrealistically high concentrations. "
            "add_molecule fetches a molecule by name from PubChem and merges "
            "it into the current structure. Use 'count' to add multiple copies "
            "at once (e.g. count=5 for a cluster). Positions auto-arranged "
            "around center with 'spacing' (default 2.8 Å). "
            "load_file parses file content (POSCAR/CONTCAR/CIF/XYZ) and loads "
            "into the viewer — use this to visualize structures from local files. "
            "Structure is auto-fetched from viewer."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "get", "add_atom", "add_atoms", "delete", "replace",
                        "move", "supercell", "set_lattice", "slab", "doping",
                        "merge", "add_molecule", "load_file",
                    ],
                    "description": "Operation to perform",
                },
                "element": {"type": "string", "description": "Element symbol (e.g. 'O', 'Fe')"},
                "position": {
                    "type": "array", "items": {"type": "number"},
                    "description": "Cartesian [x,y,z] in Angstroms",
                },
                "atoms": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "element": {"type": "string"},
                            "xyz": {"type": "array", "items": {"type": "number"}},
                        },
                    },
                    "description": "List of atoms for add_atoms",
                },
                "indices": {"type": "array", "items": {"type": "integer"}, "description": "Atom indices"},
                "index": {"type": "integer", "description": "Single atom index"},
                "new_element": {"type": "string", "description": "Replacement element for replace"},
                "displacement": {
                    "type": "array", "items": {"type": "number"},
                    "description": "Translation vector [dx,dy,dz] for move",
                },
                "scaling": {
                    "type": "array", "items": {"type": "integer"},
                    "description": "Supercell scaling [nx,ny,nz]",
                },
                "matrix": {
                    "type": "array",
                    "description": "3x3 supercell transformation matrix",
                },
                "a": {"type": "number"}, "b": {"type": "number"}, "c": {"type": "number"},
                "alpha": {"type": "number"}, "beta": {"type": "number"}, "gamma": {"type": "number"},
                "miller_index": {
                    "type": "array", "items": {"type": "integer"},
                    "description": "Miller indices [h,k,l] for slab",
                },
                "min_slab_size": {"type": "number", "description": "Slab thickness in Angstroms (default 10)"},
                "min_vacuum_size": {"type": "number", "description": "Vacuum spacing in Angstroms (default 15)"},
                "dopant": {"type": "string", "description": "Dopant element symbol for doping (e.g. 'Fe')"},
                "host_element": {"type": "string", "description": "Host element to replace for doping (e.g. 'Ti')"},
                "concentration": {"type": "integer", "description": "Number of host atoms to replace with dopant (default 1)"},
                "enumerate": {"type": "boolean", "description": "If true, generate all unique doping configurations (default false)"},
                "structure": {"type": "object", "description": "Incoming structure for merge"},
                "query": {"type": "string", "description": "Molecule name/formula for add_molecule (e.g. 'water', 'ethanol')"},
                "count": {"type": "integer", "description": "Number of molecule copies to add (default 1). For clusters, molecules are arranged around center."},
                "spacing": {"type": "number", "description": "Distance between molecules in Angstroms (default 2.8, ~hydrogen bond length)"},
                "file_content": {"type": "string", "description": "Raw file content for load_file (POSCAR/CONTCAR/CIF/XYZ text)"},
                "file_format": {"type": "string", "description": "Format hint for load_file: poscar, cif, xyz (auto-detected if omitted)"},
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_fetch",
        description=(
            "Fetch crystal structures from OPTIMADE (Materials Project, Alexandria, MC3D) "
            "or molecules from PubChem. "
            "Actions: crystal (load one), search (list matches), molecule."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["crystal", "search", "molecule"],
                    "description": "crystal=load one, search=list matches, molecule=PubChem",
                },
                "formula": {"type": "string", "description": "Chemical formula (e.g. 'TiO2')"},
                "elements": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Element filter (e.g. ['Ti', 'O'])",
                },
                "structure_id": {"type": "string", "description": "Specific database ID"},
                "provider": {
                    "type": "string", "default": "mp",
                    "description": "Database: mp, mc3d, alexandria, omdb, twodmatpedia",
                },
                "query": {"type": "string", "description": "PubChem compound name/formula"},
                "cid": {"type": "integer", "description": "PubChem compound ID"},
                "search_type": {"type": "string", "default": "name"},
                "limit": {"type": "integer", "default": 5},
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_workflow",
        description=(
            "Manage computation workflows (DFT, MD, ML). "
            "Actions: list, templates, node_types, node_details, create, get, add_node, "
            "remove_node, connect, set_params, batch, run, pause, resume, validate, status, step_error, "
            "retry, batch_status, batch_results, list_presets.\n\n"
            "BUILDING: create → batch (all nodes+edges in ONE call) → run.\n"
            "create auto-adds structure_input — do NOT add another.\n"
            "connect requires explicit from_handle/to_handle.\n"
            "batch: operations=[{op:'add_node',node_type:str,label?:str,params?:{}}, "
            "{op:'connect',from_id:str,to_id:str,from_handle:str,to_handle:str}]. "
            "Labels from add_node can be referenced as from_id/to_id in connect ops.\n"
            "run IMMEDIATELY executes. Pass run_config for HPC, confirm:true for local.\n"
            "Call node_types/node_details to discover types and param schemas.\n"
            "CATALYSIS: Use slab_gen + adsorbate_place nodes (NOT catgo_structure) for slabs and adsorbates.\n"
            "FREQ NODES: Do NOT copy geo_opt params. Freq requires kpoints='1×1×1', NCORE=0, LREAL=.FALSE. "
            "For slabs: set freeze_mode='layers', freeze_layers=N (N=total slab layers, only adsorbate vibrates)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list", "templates", "node_types", "node_details", "create", "get",
                        "add_node", "remove_node", "connect", "set_params", "batch",
                        "run", "pause", "resume", "validate", "status", "step_error",
                        "retry", "batch_status", "batch_results", "list_presets",
                    ],
                    "description": "Workflow operation",
                },
                "workflow_id": {"type": "string"},
                "name": {"type": "string", "description": "Workflow name for create"},
                "template_id": {"type": "string"},
                "node_type": {
                    "type": "string",
                    "description": (
                        "Node type. Call node_types for full list. Common: structure_input, slab_gen, "
                        "adsorbate_place, geo_opt, single_point, cell_opt, md, freq, ts_search, irc, "
                        "gibbs_energy, free_energy, dos_analysis, cohp_analysis, export_data. "
                        "Set 'software' in params: vasp, cp2k, orca, xtb, mlp."
                    ),
                },
                "node_id": {"type": "string"},
                "from_id": {"type": "string"}, "to_id": {"type": "string"},
                "from_handle": {"type": "string", "default": "structure"},
                "to_handle": {"type": "string", "default": "structure"},
                "params": {"type": "object", "description": "Node params or run config"},
                "step_id": {"type": "string"},
                "category": {"type": "string", "description": "Filter for node_types"},
                "preset_type": {"type": "string", "enum": ["vasp", "adsorbates"], "description": "For list_presets: 'vasp' (DFT params) or 'adsorbates' (molecule library)"},
                "run_config": {"type": "object", "description": "Execution config for run"},
                "operations": {
                    "type": "array",
                    "description": "Operations for batch action (see tool description).",
                    "items": {"type": "object"},
                },
                "page": {"type": "integer", "default": 1, "description": "Page number for batch_results (default 1)"},
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_analyze",
        description=(
            "Analyze structures and manage Plugin Hub. "
            "Analysis: symmetry, DOS, RDF, optimize, DFT input (VASP/QE/LAMMPS), "
            "adsorption sites, coordination. "
            "Hub: hub_search (find plugins by keyword), hub_install (install a plugin by ID), "
            "hub_list (list installed plugins)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "symmetry", "dos", "rdf", "optimize",
                        "dft_input", "adsorption_sites", "coordination",
                        "hub_search", "hub_install", "hub_list",
                    ],
                    "description": "Analysis type or hub action",
                },
                "software": {
                    "type": "string", "enum": ["vasp", "qe", "lammps"],
                    "description": "DFT software for dft_input",
                },
                "calc_type": {"type": "string", "description": "Calculation type (relax, static, md)"},
                "model": {"type": "string", "description": "ML model for optimize (MACE, CHGNet)"},
                "fmax": {"type": "number", "description": "Force convergence for optimize"},
                "params": {"type": "object", "description": "Additional analysis parameters"},
                "query": {"type": "string", "description": "Search query for hub_search"},
                "plugin_id": {"type": "string", "description": "Plugin ID for hub_install"},
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_view",
        description=(
            "Read CatGO viewer state. "
            "get_state: structure summary + selection. "
            "selection: selected atom details. "
            "screenshot: capture 3D view image."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["get_state", "selection", "screenshot"],
                    "description": "get_state=summary, selection=atoms, screenshot=image",
                },
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_catalysis",
        description=(
            "Catalysis analysis: compute reaction overpotentials, free energy corrections, "
            "descriptors, and volcano plots for catalyst screening."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "oer", "co2rr", "nrr", "free_energy",
                        "volcano", "d_band_center", "adsorption_energy",
                    ],
                    "description": (
                        "oer: OER 4-step overpotential. co2rr: CO2RR limiting potential. "
                        "nrr: NRR overpotential. free_energy: Gibbs G=E+ZPE-TS. "
                        "volcano: generate volcano plot data. d_band_center: compute from DOS. "
                        "adsorption_energy: ΔG_ads calculation."
                    ),
                },
                "params": {
                    "type": "object",
                    "description": (
                        "Action-specific parameters. "
                        "OER: {dG_OH, dG_O, dG_OOH}. "
                        "CO2RR: {dG_COOH, dG_CO, pathway}. "
                        "NRR: {dG_N2H}. "
                        "free_energy: {e_dft, frequencies_cm, temperature}. "
                        "volcano: {results, reaction, descriptor_x}. "
                        "d_band_center: {energies, dos_d, e_fermi}. "
                        "adsorption_energy: {e_slab_ads, e_slab, e_ref_molecule, zpe_correction, ts_correction}."
                    ),
                },
            },
            "required": ["action", "params"],
        },
    ),
    Tool(
        name="catgo_system",
        description=(
            "System diagnostics: check backend status, HPC connections, and recent errors."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "errors"],
                    "description": "status: backend + HPC connection info. errors: recent error log.",
                },
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_workflow_engine",
        description=(
            "State-machine workflow engine for HPC execution. "
            "Actions: create, add_task, submit, status, list, modify_params, retry, "
            "pause, resume, reset, get_result, get_dag. "
            "Pass workflow_id, task_id, task_type inside params. "
            "Ask user which HPC cluster before submit."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "create", "add_task", "submit", "status", "list",
                        "modify_params", "retry", "pause", "resume", "reset",
                        "get_result", "get_dag",
                    ],
                    "description": "Workflow engine operation",
                },
                "params": {
                    "type": "object",
                    "description": "Action-specific parameters",
                },
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_file",
        description=(
            "Write files to CatGO sandbox directories (~/.catgo/plugins/, scripts/, config/, tools/). "
            "Actions: write (write file directly), template (get file template and format docs), "
            "list (list files in a sandbox directory)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["write", "template", "list"],
                    "description": "Action to perform",
                },
                "target_path": {"type": "string", "description": "File path for write action"},
                "content": {"type": "string", "description": "File content for write action"},
                "file_type": {
                    "type": "string",
                    "enum": ["plugin", "script", "workflow_node", "config"],
                    "description": "Template type for template action",
                },
                "directory": {
                    "type": "string",
                    "enum": ["plugins", "scripts", "config", "tools"],
                    "description": "Directory to list for list action",
                },
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_diagnose",
        description=(
            "Diagnose a failed HPC task. Returns error analysis, current params, "
            "rule-based fix suggestions, and hints for manual fixes. "
            "Use when a workflow task has FAILED or REMOTE_ERROR status."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "The task ID to diagnose",
                },
            },
            "required": ["task_id"],
        },
    ),
    Tool(
        name="catgo_skills",
        description=(
            "Read CatGo workflow skill guides for domain-specific advice. "
            "Actions: list (show available skills), read (get skill content). "
            "Skills contain best practices, parameter guidance, and discussion checkpoints. "
            "Example paths: 'vasp/relax', 'analysis/oer', 'structure/slab'."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "read"],
                    "description": "list=show available skills, read=get skill content",
                },
                "skill": {
                    "type": "string",
                    "description": (
                        "Skill path to read (e.g. 'vasp', 'vasp/relax', "
                        "'analysis/oer', 'troubleshooting/vasp_errors')"
                    ),
                },
            },
            "required": ["action"],
        },
    ),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_current_structure(
    client: httpx.AsyncClient, panel_id: str = "default",
) -> dict | None:
    """Fetch current structure from viewer. Returns None if unavailable."""
    try:
        resp = await client.get(
            f"{API_BASE}/view/structure/current",
            params={"panel_id": panel_id},
        )
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return None


async def _push_structure(
    client: httpx.AsyncClient, struct: dict, panel_id: str = "default",
) -> str | None:
    """Push structure to viewer. Returns None on success, error string on failure."""
    try:
        await client.post(
            f"{API_BASE}/view/structure/push",
            params={"panel_id": panel_id},
            json={"structure": struct},
        )
        await client.post(
            f"{API_BASE}/view/structure/pending-update",
            params={"panel_id": panel_id},
            json={"structure": struct},
        )
        return None
    except Exception as exc:
        return str(exc)


def _summarize(data: dict) -> str:
    """Build concise summary from a structure-modifying response."""
    from collections import Counter

    struct = data.get("structure", {})
    sites = struct.get("sites", [])
    num = data.get("num_sites", len(sites))

    counts = Counter()
    for s in sites:
        el = s.get("label", s.get("species", [{}])[0].get("element", "?"))
        counts[el] += 1
    formula = " ".join(f"{el}{n}" for el, n in sorted(counts.items()))

    parts = [f"Done. {num} atoms ({formula})."]

    lat = struct.get("lattice", {})
    if lat:
        parts.append(f"Cell: a={lat.get('a', 0):.2f} b={lat.get('b', 0):.2f} c={lat.get('c', 0):.2f} Å.")

    for k, v in data.items():
        if k not in ("structure", "num_sites") and isinstance(v, (str, int, float)):
            parts.append(f"{k}: {v}")

    return " ".join(parts)


# ---------------------------------------------------------------------------
# MCP Handlers
# ---------------------------------------------------------------------------


@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    return TOOLS


# ---------------------------------------------------------------------------
# Action Dispatchers
# ---------------------------------------------------------------------------


async def _handle_structure(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_structure actions."""
    from collections import Counter

    action = args.get("action", "")
    T = TextContent

    if action == "get":
        struct = await _get_current_structure(client)
        if not struct:
            return [T(type="text", text="No structure loaded in viewer.")]
        sites = struct.get("sites", [])
        lat = struct.get("lattice", {})
        counts = Counter()
        for s in sites:
            el = s.get("label", s.get("species", [{}])[0].get("element", "?"))
            counts[el] += 1
        formula = " ".join(f"{el}{n}" for el, n in sorted(counts.items()))
        msg = (
            f"Current structure: {len(sites)} atoms ({formula}). "
            f"Cell: a={lat.get('a', 0):.2f} b={lat.get('b', 0):.2f} c={lat.get('c', 0):.2f} Å."
        )
        return [T(type="text", text=msg)]

    # load_file: parse file content and load into viewer
    if action == "load_file":
        content = args.get("file_content", "")
        if not content:
            return [T(type="text", text="load_file requires 'file_content' (raw POSCAR/CIF/XYZ text).")]
        fmt = args.get("file_format")
        payload = {"content": content}
        if fmt:
            payload["format"] = fmt
        resp = await client.post(f"{API_BASE}/vasp/parse-structure", json=payload)
        if resp.status_code != 200:
            return [T(type="text", text=f"parse failed ({resp.status_code}): {resp.text[:300]}")]
        struct = resp.json()
        push_err = await _push_structure(client, struct)
        summary = _summarize({"structure": struct})
        if push_err:
            summary += f"\n⚠️ Viewer push failed: {push_err}"
        return [T(type="text", text=f"Structure loaded. {summary}")]

    # add_molecule: fetch from PubChem + merge into current structure
    if action == "add_molecule":
        query = args.get("query")
        if not query:
            return [T(type="text", text="add_molecule requires 'query' (molecule name, e.g. 'water').")]
        position = args.get("position", [0.0, 0.0, 0.0])
        count = max(1, int(args.get("count", 1)))
        spacing = float(args.get("spacing", 2.8))

        # Water molecule handling: two modes
        # Mode 1 (fill): count=0 or "fill" flag → SPC216 packing to bulk density
        # Mode 2 (exact): count=N → place exactly N molecules individually
        is_water = query.lower().strip() in ("water", "h2o", "h₂o")
        fill_mode = args.get("fill", False) or count == 0
        if is_water and count > 1:
            base_struct = await _get_current_structure(client)

            # SPC216 ONLY when explicitly requested via fill:true or count=0 ("fill with water")
            # Specific counts (count=4, count=10, count=50) always use individual placement
            if fill_mode:
                # MODE 1: SPC216 packing — fill cell to bulk liquid water density
                # Auto-create lattice if non-periodic
                if base_struct and not base_struct.get("lattice"):
                    import math
                    volume = max(count, 20) / 0.0334  # at least 20 molecules for fill mode
                    box_size = max(8.0, round(volume ** (1/3), 1))
                    logger.info("Auto-creating %.1f Å cubic cell for water fill", box_size)
                    resp = await client.post(f"{API_BASE}/structure-ops/set-lattice", json={
                        "structure": base_struct,
                        "a": box_size, "b": box_size, "c": box_size,
                        "alpha": 90, "beta": 90, "gamma": 90,
                    })
                    if resp.status_code == 200:
                        base_struct = resp.json().get("structure", base_struct)
                        await _push_structure(client, base_struct)

                if base_struct and base_struct.get("lattice"):
                    lattice = base_struct["lattice"]
                    matrix = lattice.get("matrix", [[10, 0, 0], [0, 10, 0], [0, 0, 10]])
                    c_length = lattice.get("c", matrix[2][2] if len(matrix) > 2 else 10)
                    resp = await client.post(f"{API_BASE}/water-layer/add", json={
                        "structure": base_struct,
                        "params": {
                            "z_start": 0.0,
                            "z_end": float(c_length),
                            "min_distance": 2.0,
                        },
                    })
                    if resp.status_code == 200:
                        data = resp.json()
                        result_struct = data.get("structure")
                        n_placed = data.get("n_water_placed", 0)
                        if result_struct:
                            push_err = await _push_structure(client, result_struct)
                            summary = _summarize({"structure": result_struct})
                            msg = f"Filled cell with {n_placed} water molecules (SPC216 packing, ~1 g/cm³ density). {summary}"
                            if push_err:
                                msg += f"\n⚠️ Viewer push failed: {push_err}"
                            return [T(type="text", text=msg)]
                    else:
                        try:
                            err_detail = resp.json().get("detail", resp.text[:200])
                        except Exception:
                            err_detail = resp.text[:200]
                        logger.warning("Water layer endpoint failed (%d): %s — falling back to individual placement", resp.status_code, err_detail)

            # MODE 2: Individual placement — use dedicated add-water endpoint
            base_struct = base_struct or await _get_current_structure(client)
            if not base_struct:
                return [T(type="text", text="No structure loaded. Load a structure first.")]

            resp = await client.post(f"{API_BASE}/structure-ops/add-water", json={
                "structure": base_struct,
                "count": count,
                "spacing": spacing,
                "auto_lattice": True,
            })
            if resp.status_code != 200:
                try:
                    detail = resp.json().get("detail", resp.text[:300])
                except Exception:
                    detail = resp.text[:300]
                return [T(type="text", text=f"Failed to add water: {detail}")]

            data = resp.json()
            result_struct = data.get("structure")
            if result_struct:
                push_err = await _push_structure(client, result_struct)
                summary = _summarize({"structure": result_struct})
                msg = f"{data.get('message', f'Added {count} water molecules')}. {summary}"
                if push_err:
                    msg += f"\n⚠️ Viewer push failed: {push_err}"
                return [T(type="text", text=msg)]
            return [T(type="text", text="Water placement returned no structure.")]

        # 1. Save current base structure (re-fetch in case water layer path consumed it)
        base_struct = await _get_current_structure(client)

        # 2. Fetch molecule from PubChem (this pushes to viewer as side-effect)
        from catgo.mcp_tools.server import _handle_special_tool
        fetch_result = await _handle_special_tool(
            "catgo_fetch_molecule", "__special__/fetch-molecule",
            {"query": query, "search_type": "name"},
        )
        fetch_text = fetch_result[0].text if fetch_result else ""
        if "error" in fetch_text.lower() or "not found" in fetch_text.lower():
            return fetch_result

        # 3. If no base structure and only 1 molecule, just keep it
        if not base_struct and count == 1:
            return [T(type="text", text=fetch_text)]

        # 4. Get the molecule template from viewer (fetch pushed it there)
        mol_struct = await _get_current_structure(client)
        if not mol_struct:
            return [T(type="text", text=f"Fetched {query} but couldn't retrieve molecule from viewer.")]

        # 5. Compute positions for multiple molecules
        import math
        cx, cy, cz = position
        if count == 1:
            positions = [[cx, cy, cz]]
        else:
            # Arrange molecules evenly on a sphere around center
            positions = []
            for i in range(count):
                if count == 2:
                    # Along x-axis
                    dx = spacing * (i - 0.5)
                    positions.append([cx + dx, cy, cz])
                elif count <= 4:
                    # Square arrangement in xy-plane
                    angle = 2 * math.pi * i / count
                    positions.append([
                        cx + spacing * math.cos(angle),
                        cy + spacing * math.sin(angle),
                        cz,
                    ])
                else:
                    # First at center, rest on ring
                    if i == 0:
                        positions.append([cx, cy, cz])
                    else:
                        angle = 2 * math.pi * (i - 1) / (count - 1)
                        positions.append([
                            cx + spacing * math.cos(angle),
                            cy + spacing * math.sin(angle),
                            cz,
                        ])

        # 6. Merge all molecules into base (or build from scratch)
        current = base_struct or mol_struct
        merge_errors = []
        for idx, pos in enumerate(positions):
            # Skip first merge if no base (mol_struct already placed at origin)
            if idx == 0 and not base_struct:
                current = mol_struct
                continue
            merge_payload = {
                "base": current,
                "incoming": mol_struct,
                "position": pos,
            }
            resp = await client.post(f"{API_BASE}/structure-ops/merge", json=merge_payload)
            if resp.status_code != 200:
                merge_errors.append(f"#{idx+1}: {resp.status_code}")
                continue
            data = resp.json()
            current = data.get("structure", current)

        push_err = await _push_structure(client, current)
        summary = _summarize({"structure": current})
        msg = f"Added {count}x {query} molecule(s)"
        if count > 1:
            msg += f" (spacing={spacing}Å)"
        msg += f". {summary}"
        if merge_errors:
            msg += f"\n⚠️ {len(merge_errors)} merge(s) failed: {merge_errors}"
        if push_err:
            msg += f"\n⚠️ Viewer push failed: {push_err}"
        return [T(type="text", text=msg)]

    # Map actions to backend endpoints
    ROUTES: dict[str, tuple[str, str]] = {
        "add_atom":  ("POST", "/structure-ops/add-atom"),
        "add_atoms": ("POST", "/structure-ops/add-atoms"),
        "delete":    ("POST", "/structure-ops/delete-atoms"),
        "replace":   ("POST", "/structure-ops/replace-atom"),
        "move":      ("POST", "/structure-ops/move-atom"),
        "supercell": ("POST", "/structure-ops/supercell"),
        "slab":      ("POST", "/structure-ops/generate-slab"),
        "doping":    ("POST", "/build/doping"),
        "merge":     ("POST", "/structure-ops/merge"),
    }

    if action == "set_lattice":
        struct = await _get_current_structure(client)
        if not struct:
            return [T(type="text", text="No structure loaded in viewer.")]
        payload = {k: v for k, v in args.items() if k != "action"}
        payload["structure"] = struct
        resp = await client.post(f"{API_BASE}/structure-ops/set-lattice", json=payload)
        if resp.status_code != 200:
            return [T(type="text", text=f"set_lattice failed ({resp.status_code}): {resp.text[:300]}")]
        data = resp.json()
        new_struct = data.get("structure", {})
        push_err = await _push_structure(client, new_struct)
        lat = new_struct.get("lattice", {})
        msg = (
            f"Lattice set. a={lat.get('a', 0):.2f} b={lat.get('b', 0):.2f} "
            f"c={lat.get('c', 0):.2f} Å. {data.get('num_sites', '?')} sites."
        )
        if push_err:
            msg += f"\n⚠️ Viewer push failed: {push_err}"
        return [T(type="text", text=msg)]

    route = ROUTES.get(action)
    if not route:
        valid = ", ".join(["get", "set_lattice"] + list(ROUTES.keys()))
        return [T(type="text", text=f"Unknown action '{action}'. Valid: {valid}")]

    method, endpoint = route

    # Auto-inject current structure
    struct = await _get_current_structure(client)
    if not struct:
        return [T(type="text", text="No structure loaded in viewer. Load one first.")]

    payload = {k: v for k, v in args.items() if k != "action"}
    payload["structure"] = struct

    # Normalize parameter name variants between MCP schema and backend API
    if "miller_indices" in payload and "miller_index" not in payload:
        payload["miller_index"] = payload.pop("miller_indices")
    if "thickness" in payload and "min_slab_size" not in payload:
        payload["min_slab_size"] = payload.pop("thickness")
    if "vacuum" in payload and "min_vacuum_size" not in payload:
        payload["min_vacuum_size"] = payload.pop("vacuum")

    resp = await client.post(f"{API_BASE}{endpoint}", json=payload)
    if resp.status_code != 200:
        return [T(type="text", text=f"{action} failed ({resp.status_code}): {resp.text[:300]}")]

    data = resp.json()
    result_struct = data.get("structure")
    if not result_struct and "slabs" in data and data["slabs"]:
        result_struct = data["slabs"][0]
        # Mark slab as non-periodic in c-direction (vacuum gap)
        if result_struct and "lattice" in result_struct:
            result_struct["lattice"]["pbc"] = [True, True, False]

    # BuildResult format (doping, etc.): {structures: [...], labels: [...], count: N}
    # Push the first structure and report all labels
    if not result_struct and "structures" in data and data["structures"]:
        result_struct = data["structures"][0]
        labels = data.get("labels", [])
        push_err = await _push_structure(client, result_struct)
        summary = _summarize({**data, "structure": result_struct})
        if len(labels) > 1:
            summary += f" ({data.get('count', len(labels))} configurations generated, showing first.)"
        elif labels:
            summary += f" {labels[0]}."
        if push_err:
            summary += f"\n⚠️ Viewer push failed: {push_err}"
        return [T(type="text", text=summary)]

    if result_struct:
        push_err = await _push_structure(client, result_struct)
        summary = _summarize(
            {**data, "structure": result_struct} if "structure" not in data else data
        )
        if push_err:
            summary += f"\n⚠️ Viewer push failed: {push_err}"
        return [T(type="text", text=summary)]

    return [T(type="text", text=json.dumps(data, indent=2, ensure_ascii=False))]


async def _handle_fetch(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_fetch actions. Delegates to the full server's special handlers."""
    from catgo.mcp_tools.server import _handle_special_tool

    action = args.get("action", "")
    fwd_args = {k: v for k, v in args.items() if k != "action"}

    SPECIAL_MAP = {
        "crystal":  "__special__/fetch-crystal",
        "search":   "__special__/search-crystals",
        "molecule": "__special__/fetch-molecule",
    }

    endpoint = SPECIAL_MAP.get(action)
    if not endpoint:
        return [TextContent(type="text", text=f"Unknown fetch action '{action}'. Valid: crystal, search, molecule")]

    return await _handle_special_tool(f"catgo_fetch_{action}", endpoint, fwd_args)


async def _handle_workflow(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_workflow actions. Delegates to full server's workflow handler."""
    from catgo.mcp_tools.server import _handle_special_tool
    return await _handle_special_tool("catgo_workflow", "__special__/workflow", args)


async def _handle_analyze(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_analyze actions."""
    action = args.get("action", "")
    T = TextContent

    # --- Hub actions ---
    if action == "hub_search":
        query = args.get("query", "")
        if not query:
            return [T(type="text", text="hub_search requires 'query' parameter.")]
        resp = await client.get(f"{API_BASE}/hub/search", params={"q": query})
        if resp.status_code != 200:
            return [T(type="text", text=f"hub_search failed ({resp.status_code}): {resp.text[:300]}")]
        return [T(type="text", text=json.dumps(resp.json(), indent=2, ensure_ascii=False))]

    if action == "hub_install":
        plugin_id = args.get("plugin_id", "")
        if not plugin_id:
            return [T(type="text", text="hub_install requires 'plugin_id' parameter.")]
        resp = await client.post(f"{API_BASE}/hub/install/{plugin_id}")
        if resp.status_code != 200:
            return [T(type="text", text=f"hub_install failed ({resp.status_code}): {resp.text[:300]}")]
        return [T(type="text", text=json.dumps(resp.json(), indent=2, ensure_ascii=False))]

    if action == "hub_list":
        resp = await client.get(f"{API_BASE}/hub/installed")
        if resp.status_code != 200:
            return [T(type="text", text=f"hub_list failed ({resp.status_code}): {resp.text[:300]}")]
        return [T(type="text", text=json.dumps(resp.json(), indent=2, ensure_ascii=False))]

    # --- Analysis actions ---
    ROUTES: dict[str, tuple[str, str]] = {
        "symmetry":         ("POST", "/symmetry/analyze"),
        "dos":              ("POST", "/dos/compute"),
        "rdf":              ("POST", "/analysis/rdf"),
        "optimize":         ("POST", "/optimize/structure"),
        "dft_input":        ("POST", "/dft-input/generate"),
        "adsorption_sites": ("GET",  "/adsorption/sites"),
        "coordination":     ("POST", "/analysis/coordination"),
    }

    route = ROUTES.get(action)
    if not route:
        valid = ", ".join(list(ROUTES.keys()) + ["hub_search", "hub_install", "hub_list"])
        return [T(type="text", text=f"Unknown analyze action '{action}'. Valid: {valid}")]

    method, endpoint = route
    payload = {k: v for k, v in args.items() if k != "action"}

    # Normalize optimize params: MCP uses "model", backend uses "calculator"
    if action == "optimize":
        if "model" in payload and "calculator" not in payload:
            payload["calculator"] = payload.pop("model").lower()

    # Auto-inject structure for POST endpoints that need it
    if method == "POST" and "structure" not in payload:
        struct = await _get_current_structure(client)
        if struct:
            payload["structure"] = struct

    if method == "GET":
        resp = await client.get(f"{API_BASE}{endpoint}", params=payload or None)
    else:
        resp = await client.post(f"{API_BASE}{endpoint}", json=payload)

    if resp.status_code != 200:
        return [T(type="text", text=f"{action} failed ({resp.status_code}): {resp.text[:300]}")]

    data = resp.json()

    # If it returned a structure, push to viewer
    if isinstance(data, dict) and "structure" in data:
        push_err = await _push_structure(client, data["structure"])
        summary = _summarize(data)
        if push_err:
            summary += f"\n⚠️ {push_err}"
        return [T(type="text", text=summary)]

    return [T(type="text", text=json.dumps(data, indent=2, ensure_ascii=False))]


async def _handle_view(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_view actions."""
    action = args.get("action", "")
    T = TextContent

    if action == "get_state":
        resp = await client.get(f"{API_BASE}/view/state")
        if resp.status_code != 200:
            return [T(type="text", text="Cannot get CatGO state. Is the backend running?")]
        return [T(type="text", text=json.dumps(resp.json(), indent=2, ensure_ascii=False))]

    if action == "selection":
        resp = await client.get(f"{API_BASE}/view/selection")
        if resp.status_code != 200:
            return [T(type="text", text="Cannot get selection.")]
        return [T(type="text", text=json.dumps(resp.json(), indent=2, ensure_ascii=False))]

    if action == "screenshot":
        resp = await client.post(f"{API_BASE}/view/screenshot", json={})
        if resp.status_code != 200:
            return [T(type="text", text=f"Screenshot failed ({resp.status_code}): {resp.text[:200]}")]
        data = resp.json()
        return [T(type="text", text=f"Screenshot captured ({data.get('width')}x{data.get('height')}). Base64 image: {data.get('image', '')[:100]}...")]

    return [T(type="text", text=f"Unknown view action '{action}'. Valid: get_state, selection, screenshot")]


async def _handle_catalysis(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_catalysis actions."""
    action = args.get("action", "")
    params = args.get("params", {})
    T = TextContent

    try:
        if action == "oer":
            from workflow.catalysis.oer import compute_oer_overpotential
            result = compute_oer_overpotential(**params)
        elif action == "co2rr":
            from workflow.catalysis.co2rr import compute_co2rr_limiting_potential
            result = compute_co2rr_limiting_potential(**params)
        elif action == "nrr":
            from workflow.catalysis.nrr import compute_nrr_overpotential
            result = compute_nrr_overpotential(**params)
        elif action == "free_energy":
            from workflow.catalysis.free_energy import gibbs_free_energy
            result = gibbs_free_energy(**params)
        elif action == "volcano":
            from workflow.catalysis.volcano import generate_volcano_data
            result = generate_volcano_data(**params)
        elif action == "d_band_center":
            from workflow.catalysis.descriptors import compute_d_band_center
            result = compute_d_band_center(**params)
        elif action == "adsorption_energy":
            from workflow.catalysis.oer import compute_adsorption_free_energy
            result = {"dG_ads": compute_adsorption_free_energy(**params)}
        else:
            valid = "oer, co2rr, nrr, free_energy, volcano, d_band_center, adsorption_energy"
            return [T(type="text", text=f"Unknown catalysis action '{action}'. Valid: {valid}")]

        return [T(type="text", text=json.dumps(result, indent=2, ensure_ascii=False))]
    except ImportError as exc:
        return [T(type="text", text=f"Catalysis module not available: {exc}")]
    except Exception as exc:
        return [T(type="text", text=f"catalysis/{action} failed: {exc}")]


async def _handle_file(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_file actions."""
    from pathlib import Path

    action = args.get("action", "")
    T = TextContent

    if action == "write":
        target_path = args.get("target_path", "")
        content = args.get("content", "")
        if not target_path or not content:
            return [T(type="text", text="write requires 'target_path' and 'content' parameters.")]
        resp = await client.post(
            f"{API_BASE}/files/sandbox/write-direct",
            json={"content": content, "target_path": target_path},
        )
        if resp.status_code != 200:
            return [T(type="text", text=f"write failed ({resp.status_code}): {resp.text[:300]}")]
        return [T(type="text", text=json.dumps(resp.json(), indent=2, ensure_ascii=False))]

    if action == "template":
        file_type = args.get("file_type", "plugin")
        resp = await client.get(f"{API_BASE}/files/sandbox/templates/{file_type}")
        if resp.status_code != 200:
            return [T(type="text", text=f"template failed ({resp.status_code}): {resp.text[:300]}")]
        return [T(type="text", text=resp.json().get("template", ""))]

    if action == "list":
        directory = args.get("directory", "plugins")
        # Use canonical sandbox dirs from file_sandbox to avoid path divergence
        from tools.file_sandbox import SANDBOX_DIRS
        sandbox_dir = SANDBOX_DIRS.get(directory)
        if not sandbox_dir:
            return [T(type="text", text=f"Invalid directory '{directory}'. Valid: {', '.join(SANDBOX_DIRS)}")]
        resolved = sandbox_dir.resolve()
        if not resolved.exists():
            return [T(type="text", text=f"Directory ~/.catgo/{directory}/ does not exist (no files yet).")]
        files = sorted(f.name for f in resolved.iterdir() if f.is_file() and not f.is_symlink())
        if not files:
            return [T(type="text", text=f"No files in ~/.catgo/{directory}/.")]
        return [T(type="text", text=json.dumps({"directory": f"~/.catgo/{directory}/", "files": files}, indent=2))]

    return [T(type="text", text=f"Unknown file action '{action}'. Valid: write, template, list")]


async def _handle_system(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_system actions."""
    action = args.get("action", "")
    T = TextContent

    if action == "status":
        resp = await client.get(f"{API_BASE}/system/status")
        if resp.status_code != 200:
            return [T(type="text", text=f"Cannot get system status ({resp.status_code}). Is the backend running?")]
        return [T(type="text", text=json.dumps(resp.json(), indent=2, ensure_ascii=False))]

    if action == "errors":
        resp = await client.get(f"{API_BASE}/system/errors")
        if resp.status_code != 200:
            return [T(type="text", text=f"Cannot get error log ({resp.status_code}).")]
        return [T(type="text", text=json.dumps(resp.json(), indent=2, ensure_ascii=False))]

    return [T(type="text", text=f"Unknown system action '{action}'. Valid: status, errors")]


async def _handle_workflow_engine(args: dict) -> list[TextContent]:
    """Dispatch catgo_workflow_engine actions via the service layer."""
    T = TextContent
    action = args.get("action", "")
    params = args.get("params", {})
    try:
        from catgo.workflow.mcp_tools import handle_tool_call
        result = await handle_tool_call(action, params)
        return [T(type="text", text=json.dumps(result, indent=2, default=str))]
    except Exception as e:
        return [T(type="text", text=f"workflow_engine error: {e}")]


# ---------------------------------------------------------------------------
# Skills Handler
# ---------------------------------------------------------------------------

_SKILLS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "catgo", "workflow", "skills",
)


async def _handle_skills(args: dict) -> list[TextContent]:
    """Dispatch catgo_skills actions."""
    T = TextContent
    action = args.get("action", "")

    if action == "list":
        skills = []
        for root, dirs, files in os.walk(_SKILLS_DIR):
            if "SKILL.md" in files:
                rel = os.path.relpath(root, _SKILLS_DIR)
                if rel == ".":
                    skills.append("(root)")
                else:
                    skills.append(rel.replace(os.sep, "/"))
        skills.sort()
        if not skills:
            return [T(type="text", text="No skills found.")]
        return [T(type="text", text="Available skills:\n" + "\n".join(f"  - {s}" for s in skills))]

    if action == "read":
        skill = args.get("skill", "")
        if not skill:
            return [T(type="text", text="read requires 'skill' param (e.g. 'vasp', 'vasp/relax', 'analysis/oer').")]
        skill_path = os.path.join(_SKILLS_DIR, skill.replace("/", os.sep), "SKILL.md")
        if not os.path.isfile(skill_path):
            return [T(type="text", text=f"Skill not found: {skill}. Use action='list' to see available skills.")]
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                content = f.read()
            return [T(type="text", text=content)]
        except Exception as e:
            return [T(type="text", text=f"Error reading skill {skill}: {e}")]

    return [T(type="text", text=f"Unknown skills action: {action}. Use 'list' or 'read'.")]


# ---------------------------------------------------------------------------
# Diagnose Handler
# ---------------------------------------------------------------------------


async def _handle_diagnose(args: dict) -> list[TextContent]:
    """Dispatch catgo_diagnose — AI-powered error diagnosis."""
    T = TextContent
    task_id = args.get("task_id", "")
    if not task_id:
        return [T(type="text", text="catgo_diagnose requires 'task_id'.")]
    try:
        from catgo.workflow.engine.ai_diagnosis import get_diagnosis_for_mcp
        from catgo.workflow.config import load_config

        config = load_config(config_path=None)
        from catgo.workflow.db import WorkflowDB

        db = WorkflowDB(config.get("db_path", "~/.catgo/workflow.db"))
        result = await get_diagnosis_for_mcp(db, task_id)
        return [T(type="text", text=json.dumps(result, indent=2, default=str))]
    except KeyError:
        return [T(type="text", text=f"Task {task_id} not found.")]
    except Exception as e:
        return [T(type="text", text=f"Diagnosis error: {e}")]


# ---------------------------------------------------------------------------
# Tool Dispatcher
# ---------------------------------------------------------------------------


@server.call_tool()
async def handle_call_tool(name: str, arguments: dict | None) -> list[TextContent]:
    arguments = arguments or {}
    T = TextContent

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            if name == "catgo_structure":
                return await _handle_structure(client, arguments)
            elif name == "catgo_fetch":
                return await _handle_fetch(client, arguments)
            elif name == "catgo_workflow":
                return await _handle_workflow(client, arguments)
            elif name == "catgo_analyze":
                return await _handle_analyze(client, arguments)
            elif name == "catgo_view":
                return await _handle_view(client, arguments)
            elif name == "catgo_catalysis":
                return await _handle_catalysis(client, arguments)
            elif name == "catgo_system":
                return await _handle_system(client, arguments)
            elif name == "catgo_workflow_engine":
                return await _handle_workflow_engine(arguments)
            elif name == "catgo_file":
                return await _handle_file(client, arguments)
            elif name == "catgo_diagnose":
                return await _handle_diagnose(arguments)
            elif name == "catgo_skills":
                return await _handle_skills(arguments)
            else:
                return [T(type="text", text=f"Unknown tool: {name}")]
    except httpx.ConnectError:
        return [T(
            type="text",
            text=f"Cannot connect to CatGO backend at {API_BASE}. "
                 "Start it with: cd ~/projects/catgo/CatGO && pnpm desktop:serve",
        )]
    except Exception as exc:
        logger.error("Tool %s failed: %s", name, exc, exc_info=True)
        return [T(type="text", text=f"{name} failed: {exc}")]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())

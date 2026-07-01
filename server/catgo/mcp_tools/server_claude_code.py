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
import time

import httpx
from catgo.mcp_tools.helpers import _push_workflow_navigate
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
            "Manipulate the structure in the CatGo viewer. ONE tool call per "
            "user intent — do not chain discovery calls. Actions:\n"
            "  get        — summary (sites, lattice). Call once per turn.\n"
            "  export     — raw POSCAR/CIF/XYZ text (specify file_format).\n"
            "  load_file  — load from user path (Read path first, pass file_content).\n"
            "  add_atom   — add one atom at position[x,y,z]. element required.\n"
            "  add_atoms  — add multiple atoms: atoms=[{element, xyz}, ...].\n"
            "  delete     — delete by indices[...] OR by element. 0-based.\n"
            "  replace    — substitute one atom: index + new_element.\n"
            "  move       — relocate one atom: index + position (absolute) or displacement (relative).\n"
            "  supercell  — expand via scaling=[nx,ny,nz] or 3x3 matrix. Do this BEFORE adsorbate placement.\n"
            "  set_lattice — change lattice parameters (a,b,c,alpha,beta,gamma).\n"
            "  slab       — cut from bulk: miller_index, min_slab_size, min_vacuum_size.\n"
            "  doping     — substitutional: dopant, host_element, concentration. Slab FIRST then dope.\n"
            "  merge      — drop an external pymatgen structure dict at position.\n"
            "  add_molecule — place library molecule(s): query='water'/'CO'/'NH2'/..., count, spacing, position.\n"
            "  add_cluster — server-side metal / oxide cluster geometry via ASE: cluster_type "
            "(icosahedron|octahedron|cuboctahedron|fcc|hcp|decahedron|oxide_<name>) + element + size. "
            "USE THIS for Pt13/Au55/Cu7/Pd6/etc and oxide nanoparticles instead of "
            "emitting every atom xyz through add_atoms. CatBot sends recipe name only "
            "— server generates ~50 tokens vs ~25/atom for explicit coords. Position "
            "auto-computes to slab-top centre + offset (1.8 Å default) if omitted.\n"
            "\n"
            "ADSORBATE PLACEMENT (CO/H/OH/H2O on a surface): one workflow only:\n"
            "  1) catgo_analyze action='adsorption_sites' (returns list of {type, x, y, z}). Call ONCE.\n"
            "  2) catgo_structure action='add_molecule' query='<species>' count=1 "
            "     position=[site.x, site.y, site.z + offset]\n"
            "     offset: 1.8 for C/N/O-to-metal, 1.5 for H-to-metal, 2.2 for H2O η¹-O.\n"
            "\n"
            "WATER LAYER on a slab: add_molecule query='water' count=16 spacing=2.8 "
            "position=[center_x, center_y, top_z+3.0].\n"
            "\n"
            "DO NOT use catgo_workflow for one-off structure edits — that builds a multi-node "
            "DAG which is overkill for 'place CO' or 'delete atom 5'. Build a workflow only when "
            "the user wants a chained calculation pipeline (geo_opt → freq → free_energy).\n"
            "\n"
            "Mutations auto-fetch the current viewer structure. MCP server runs on the user's "
            "local box — it cannot Read paths from your filesystem."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "get", "export", "add_atom", "add_atoms", "delete", "replace",
                        "move", "supercell", "set_lattice", "slab", "doping",
                        "merge", "add_molecule", "add_cluster", "load_file",
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
                "cluster_type": {
                    "type": "string",
                    "description": "For add_cluster: metal shape (icosahedron|octahedron|cuboctahedron|fcc|hcp|decahedron) or oxide_<key> (oxide_Pt2O2, oxide_TiO2_anatase_8, oxide_CeO2_3, oxide_Al2O3_5).",
                },
                "size": {
                    "type": "integer",
                    "description": "For metal add_cluster: shells (icosahedron) / edge length (octahedron, cubo, decahedron) / layers (fcc, hcp). Ignored for oxide_* recipes.",
                },
                "offset": {
                    "type": "number",
                    "description": "For add_cluster: height above topmost slab atom in Å when position is omitted. Default 1.8.",
                },
                "file_content": {"type": "string", "description": "Raw POSCAR/CIF/XYZ text for load_file (Read the user's path first)."},
                "file_format": {"type": "string", "description": "Format for load_file (input hint) or export (output choice). poscar | cif | xyz | extxyz | mol2 | pdb. Default: poscar."},
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
            "Manage CatGo DAG **calculation** workflows (DFT, MD, ML).\n\n"
            "STOP — check first: is the user asking for HER / OER / CO2RR / DOS? "
            "If yes, use **catgo_quickbuild** instead — it builds the same pipeline in "
            "ONE MCP call without forcing the LLM to emit a batch payload. Only fall "
            "back to this tool when the recipe is genuinely custom (NEB, slow-growth, "
            "NRR, ORR, multi-intermediate CO2RR with C2+ products, …) or the user "
            "explicitly wants to tune the node graph.\n\n"
            "USE THIS TOOL when the user wants a calculation pipeline — i.e. their prompt "
            "mentions any of: workflow, pipeline, free energy, ΔG, Gibbs, overpotential, "
            "barrier, NEB, energy diagram, opt+freq, opt+SP+DOS, slow-growth, CO2RR/OER/HER/"
            "NRR/ORR, or asks to 'compute' / 'calculate' / 'run' an analysis.\n\n"
            "DO NOT use this tool for pure structure edits — slab cuts, adsorbate placement, "
            "supercell expansion, atom add/delete — those are catgo_structure + catgo_analyze. "
            "The disambiguator: does the user want NUMBERS (energies, ΔG, barriers) at the end? "
            "If yes, build a workflow. If they just want a STRUCTURE in the viewer, don't.\n\n"
            "Actions: list, templates, node_types, node_details, create, rename, get, add_node, "
            "remove_node, connect, set_params, batch, run, pause, resume, validate, status, step_error, "
            "retry, batch_status, batch_results, list_presets.\n\n"
            "RENAME an existing workflow: rename {workflow_id:'<ID from context>', "
            "name:'<new name>'}. This only changes the display name — the graph is "
            "untouched. Use it when the user asks to rename/retitle the current "
            "workflow; do NOT create a new workflow for a rename.\n\n"
            "FAST PATH for a new reaction-mechanism workflow (CO2RR / OER / HER / NRR / NEB / "
            "DOS / slow-growth — i.e. when the user wants ΔG values, overpotentials, barriers):\n"
            "  1) create name='<descriptive>' — auto-adds a structure_input node from the viewer.\n"
            "  2) batch operations=[...] — every add_node + connect in ONE round-trip. Do NOT "
            "     call add_node serially.\n"
            "  3) (optional) run with run_config for HPC, or confirm:true for local.\n"
            "Every reaction-mechanism pipeline MUST include freq + free_energy nodes after "
            "geo_opt so the reported ΔG is a real Gibbs energy (electronic + ZPE + TS), not "
            "bare DFT energy. Frequency on slabs needs freeze_mode='bottom' freeze_n_layers=2 "
            "so only the adsorbate vibrates.\n\n"
            "batch op format: {op:'add_node',node_type:str,label?:str,params?:{}}, "
            "{op:'connect',from_id:str,to_id:str,from_handle:str,to_handle:str}. "
            "Labels from add_node can be referenced as from_id/to_id in connect ops.\n"
            "connect requires explicit from_handle/to_handle.\n\n"
            "WORKED EXAMPLE — HER free energy on Pt(111) in TWO calls only:\n"
            "  call 1: catgo_workflow {action:'create', name:'HER on Pt(111)', material_ids:['mp-126']}\n"
            "  call 2: catgo_workflow {action:'batch', operations:[\n"
            "    {op:'add_node', node_type:'slab_gen',           label:'slab', params:{miller:'1,1,1', layers:4, vacuum:15, supercell:'2x2x1'}},\n"
            "    {op:'add_node', node_type:'adsorbate_place', label:'ads',  params:{species:'H', site:'fcc'}},\n"
            "    {op:'add_node', node_type:'geo_opt',             label:'opt',  params:{software:'vasp', encut:520, ediffg:-0.03, freeze_mode:'bottom', freeze_n_layers:2}},\n"
            "    {op:'add_node', node_type:'freq',                label:'freq', params:{software:'vasp', freeze_mode:'bottom', freeze_n_layers:2}},\n"
            "    {op:'add_node', node_type:'free_energy',         label:'fe',   params:{temperature:298.15, reference:'CHE', target:'H'}},\n"
            "    {op:'connect', from_id:'<structure_input>', to_id:'slab'},\n"
            "    {op:'connect', from_id:'slab',              to_id:'ads'},\n"
            "    {op:'connect', from_id:'ads',               to_id:'opt'},\n"
            "    {op:'connect', from_id:'opt',               to_id:'freq'},\n"
            "    {op:'connect', from_id:'freq',              to_id:'fe'}\n"
            "  ]}\n"
            "That's 5 nodes + 5 edges in ONE batch operation — total two MCP round-trips. "
            "Do not split into add_node-then-connect-then-add_node sequences; the LLM will be "
            "tempted to but it shouldn't.\n\n"
            "EDITING AN EXISTING WORKFLOW (CRITICAL — do NOT rebuild from scratch):\n"
            "  If the context shows an '## Active Workflow' block with an ID, there is already "
            "an open workflow on the user's canvas. To fix a node error, change a parameter, "
            "rename, add/remove/rewire a node, or otherwise adjust it, you MUST operate on that "
            "existing workflow by its ID. Do NOT call 'create' again — 'create' makes a brand-new "
            "workflow row and pops a second graph on the canvas, losing the user's current one.\n"
            "  - Change one node's params (e.g. fix a bad mp_id / wrong miller / encut): "
            "set_params {workflow_id:'<ID from context>', node_id:'<the node>', params:{…only the keys to change…}}.\n"
            "  - Add / remove / reconnect nodes on the open workflow: "
            "batch {workflow_id:'<ID from context>', operations:[…]} — same op format as above.\n"
            "  - To see current node ids/params before editing, call get {workflow_id:'<ID>'}.\n"
            "  - To set/replace the structure on a structure_input node: set_params with "
            "params:{mp_id:'mp-XXXX'} to pull that Materials Project entry, OR set_params "
            "with no structure param at all to capture whatever structure the user currently "
            "has in the viewer. Do NOT try to paste a structure_json yourself — the backend "
            "resolves mp_id/viewer into the real structure automatically.\n"
            "  Only call 'create' when the user explicitly asks for a NEW/separate workflow, or "
            "when there is no Active Workflow in the context. set_params/batch/get all REQUIRE "
            "workflow_id — take it verbatim from the '## Active Workflow' ID line; never guess it "
            "and never substitute the workflow name.\n\n"
            "Other reactions follow the same shape (CO2RR adds CO2/COOH/CO intermediate "
            "geo_opt+freq nodes per intermediate all feeding one free_energy aggregator; OER "
            "adds OOH/O/OH intermediates; NEB swaps geo_opt+freq for a single neb node "
            "between two structure_inputs).\n\n"
            "CATALYSIS: Use slab_gen + adsorbate_place nodes (NOT catgo_structure) for slabs and "
            "adsorbates inside a workflow.\n"
            "ADSORBATE_PLACE PARAMS — ONLY these keys are accepted; everything else is dropped:\n"
            "  - species (ASCII formula, case-insensitive): "
            "OH, O, OOH (OER/ORR); H (HER); CO, COOH, CHO, OCCO, CH3OH, OCH3, CH2OH, … (CO₂RR);\n"
            "    N2, NNH, NHNH, NH2NH2, NH, NH2, NH3 (NRR); NO, NOH, NHOH, NH2OH, NO2, NO3 (NO₃RR).\n"
            "    For the complete library call action='list_presets' preset_type='adsorbates'.\n"
            "  - site (literal string, ONE OF): 'ontop', 'bridge', 'fcc', 'hcp', 'all'. "
            "Do NOT write 'top' — the schema only accepts the exact strings above. "
            "'all' picks the best ontop site automatically (closest to the slab xy centre).\n"
            "  - height (Å, default 2.0): atom-surface distance.\n"
            "  - auto_rotate (bool, default true): orient adsorbate perpendicular to surface "
            "(end-on / η¹). Set false for side-on / η²-like placement.\n"
            "  - quick_optimize: 'none' | 'uff' | 'xtb' — optional post-placement relax.\n"
            "  DO NOT invent keys like 'mode', 'dentate', 'orientation', 'binding_mode' — the "
            "schema rejects them and the panel will look empty to the user.\n"
            "For OER, emit three adsorbate_place nodes feeding three geo_opt+freq+gibbs_energy "
            "chains that converge on ONE free_energy aggregator: species='OH', 'O', 'OOH', "
            "all with site='ontop' (or 'fcc'/'hcp' if the user explicitly requested hollow). "
            "CO₂RR / NRR / ORR follow the same shape with their respective intermediates.\n"
            "FREQ NODES: Do NOT copy geo_opt params. Freq requires kpoints='1×1×1', NCORE=0, LREAL=.FALSE. "
            "For slabs: set freeze_mode='layers', freeze_layers=N (N=total slab layers, only adsorbate vibrates).\n\n"
            "CONFIRMATION: After the workflow is built, reply in ONE short sentence — "
            "name of the workflow, node count, and that the editor is open. The user can "
            "see the graph in the canvas; do not enumerate every node's params or VASP "
            "setting back at them. They will ask follow-ups if they need to tune anything."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list", "templates", "node_types", "node_details", "create", "rename", "get",
                        "add_node", "remove_node", "connect", "set_params", "batch",
                        "run", "pause", "resume", "validate", "status", "step_error",
                        "retry", "batch_status", "batch_results", "list_presets",
                    ],
                    "description": "Workflow operation",
                },
                "workflow_id": {"type": "string"},
                "name": {"type": "string", "description": "Workflow name (for create, or the new name for rename)"},
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
            "Read CatGO viewer state and drive its atom selection. "
            "get_state: structure summary + selection. "
            "selection: selected atom details. "
            "screenshot: capture 3D view image. "
            "select: highlight atoms in the viewer using a selection DSL query "
            "(returns the resolved 0-based atom indices). "
            "Selection DSL — combine selectors with AND/OR/NOT (or & | !) and "
            "parentheses; AND binds tighter than OR. Selectors:\n"
            "  *                all atoms\n"
            "  elem:O           atoms of an element (case-insensitive)\n"
            "  label:O1         per-element 1-BASED ordinal (O1=first O); O1-5 = range\n"
            "  label:3          bare number = 1-BASED GLOBAL site number; 3-7 = range\n"
            "  ids:0,4,5        literal 0-BASED indices (out-of-range dropped)\n"
            "  id:7             single 0-BASED index\n"
            "  pos:z>10         cartesian Å on x/y/z; ops > < >= <= = == !=\n"
            "  frac:c>0.5       fractional on a/b/c (empty if no lattice)\n"
            "  bonded:@i        bond-neighbours of atom i (PBC-aware; excludes i)\n"
            "  sphere:@i;R      atoms within R Å of atom i (PBC-aware; includes i)\n"
            "Examples: 'elem:O AND frac:c>0.9'  '(elem:C OR elem:N) AND pos:z>5'  "
            "'elem:H AND NOT bonded:@0'. "
            "NOTE: ids:/id: are 0-based, but label: numbering is 1-based — prefer "
            "ids: for index work. mode=replace|add|subtract controls how the result "
            "merges with the current selection."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["get_state", "selection", "screenshot", "select"],
                    "description": "get_state=summary, selection=atoms, screenshot=image, select=apply DSL query",
                },
                "query": {
                    "type": "string",
                    "description": "Selection DSL query (required for action=select), e.g. 'elem:O AND frac:c>0.9'.",
                },
                "panel_id": {
                    "type": "string",
                    "description": "Target viewer/panel id (default 'default' → backend resolves the populated pane).",
                },
                "mode": {
                    "type": "string",
                    "enum": ["replace", "add", "subtract"],
                    "description": "How the resolved indices merge with the current selection (default replace).",
                },
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_pane",
        description=(
            "Target one specific CatGo structure/trajectory pane by viewer_id. "
            "The system prompt lists every pane and its viewer_id. "
            "Actions: list (all pane manifests), inspect (atom indices, neighbors, coordination, connected components, terminal/branch candidates), "
            "add_atom (element + Cartesian position), delete_atoms, replace_atoms "
            "(element + indices), move_atoms "
            "(moves=[{index,displacement}]; all trajectory frames), and scale_geometry "
            "(factor required; real coordinates/lattice, all trajectory frames). "
            "Use inspect before interpreting semantic descriptions such as terminal branch carbon; "
            "if multiple candidates match, ask the user instead of guessing."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "viewer_id": {"type": "string", "description": "Exact viewer_id or unique pane position. Omit only for list."},
                "action": {
                    "type": "string",
                    "enum": ["list", "inspect", "add_atom", "delete_atoms", "replace_atoms", "move_atoms", "scale_geometry"],
                },
                "element": {"type": "string"},
                "position": {
                    "type": "array", "items": {"type": "number"},
                    "minItems": 3, "maxItems": 3,
                },
                "indices": {"type": "array", "items": {"type": "integer"}},
                "moves": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {"type": "integer"},
                            "displacement": {
                                "type": "array", "items": {"type": "number"},
                                "minItems": 3, "maxItems": 3,
                            },
                        },
                        "required": ["index", "displacement"],
                    },
                },
                "factor": {"type": "number", "exclusiveMinimum": 0},
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
            "State-machine workflow engine (V2) for HPC execution. Build: create -> "
            "add_task (one per calculation node) -> submit. "
            "WIRE TASKS by data flow, NOT a connect action: pass an upstream task's "
            "output as an input param of the downstream add_task, using an output "
            "reference {\"_ref\": \"<upstream_task_id>\", \"_key\": \"<output_key>\"}. "
            "e.g. add_task geo_opt with params {\"structure\": {\"_ref\": \"<slab_task_id>\", "
            "\"_key\": \"structure\"}} links slab.structure -> geo_opt.structure (creates "
            "the edge). add_task returns the new task_id to reference next. "
            "Task ids are namespaced '{workflow_id}:{node_id}'. For per-task actions "
            "(get_result, modify_params, retry, status) pass either an explicit 'task_id' "
            "or 'workflow_id' + 'node_id' -- do NOT hand-build the namespaced id. "
            "HPC job params (partition, account, walltime, ntasks) are set per-task via "
            "add_task params. "
            "IMPORTANT: before action='submit' you MUST ask the user which HPC cluster "
            "(Expanse, Shaheen, local) and confirm job parameters; never submit without "
            "confirmation. ALSO confirm the pseudopotential/POTCAR directory for that "
            "cluster: if you are not certain where POTCAR/pseudopotential files live "
            "(potcar_root etc.), STOP and ASK THE USER -- do NOT guess (a wrong path "
            "fails every job, and it is per-user/per-cluster, not inferable from another "
            "workflow). On Expanse POTCAR can be generated via 'echo -e 103 | vaspkit'. "
            "SAME for the compute binary: confirm how the executable is loaded/invoked on "
            "the cluster (vasp_command + 'module load'/'conda activate'/full path); if not "
            "certain, ASK THE USER -- a wrong command/module dies with 'command not found' "
            "(e.g. execve(): vasp_std: No such file or directory). "
            "Verify with catgo_validate_config before submit."
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
                    "description": (
                        "Action-specific parameters. add_task: workflow_id, task_type, "
                        "and input params (use {\"_ref\":\"<task_id>\",\"_key\":\"<key>\"} "
                        "values to wire from upstream tasks). Per-task actions: task_id OR "
                        "workflow_id + node_id."
                    ),
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
        name="catgo_quickbuild",
        description=(
            "PREFERRED workflow builder for stock reactions. ONE MCP round-trip "
            "vs the 2+ round-trips of catgo_workflow create+batch — CatBot does "
            "NOT have to generate any graph JSON, the server emits the full "
            "pipeline directly.\n\n"
            "USE THIS FIRST whenever the user asks for any of: HER, OER, ORR, "
            "CO2RR, NRR, NEB, slow-growth, DOS on any material. Only fall back "
            "to catgo_workflow create+batch for genuinely custom recipes that "
            "the registry does not cover, or when the user explicitly wants to "
            "tune the node graph.\n\n"
            "Recipes: HER (H adsorption + free energy), OER (OH/O/OOH "
            "intermediates fan-in to free_energy), ORR (OOH/O/OH path), NRR "
            "(N2/N2H/NH2 path), CO2RR_2e (COOH*/CO* path), NEB (CI-NEB TS "
            "search between reactant + product structure_inputs), slow_growth "
            "(opt → NVT equilibration → constrained AIMD via ICONST → barrier "
            "analysis), DOS (geo_opt + single_point + d-band centre). All "
            "reaction recipes terminate in freq → free_energy so reported ΔG "
            "is a real Gibbs energy.\n\n"
            "Params: recipe (required); material_id (optional MP id like "
            "'mp-126' for Pt — omit to use the current viewer structure); "
            "name (optional custom title)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "recipe": {
                    "type": "string",
                    "enum": ["HER", "OER", "ORR", "NRR", "CO2RR_2e", "NEB", "slow_growth", "DOS"],
                    "description": "Recipe name from the server-side registry.",
                },
                "material_id": {
                    "type": "string",
                    "description": "Optional Materials Project ID (e.g. 'mp-126' for Pt). "
                                   "If omitted, the workflow uses the current viewer structure.",
                },
                "name": {
                    "type": "string",
                    "description": "Optional custom workflow title.",
                },
            },
            "required": ["recipe"],
        },
    ),
    Tool(
        name="catgo_skills",
        description=(
            "Read CatGo workflow skill guides for domain-specific advice. "
            "Actions: list (show available skills), read (get skill content). "
            "Skills contain tight one-shot playbooks and best practices. "
            "ALWAYS read the relevant skill BEFORE the exploration loop:\n"
            "  - 'workflow_builder' — when the user asks to create / build / "
            "set up a workflow or pipeline (CO2RR / OER / HER / NEB / DOS / "
            "slow-growth / bulk→slab→adsorbate). Skips templates / node_types "
            "/ node_details exploration.\n"
            "  - 'structure/atom_ops' — when the user adds, deletes, moves, or "
            "replaces individual atoms.\n"
            "  - 'structure/cluster_ops' — when the user places adsorbates, "
            "builds water layers, places dual adsorbates for coupling, builds "
            "supercells, or removes clusters.\n"
            "Other useful paths: 'vasp/relax', 'analysis/oer', 'structure/slab', "
            "'troubleshooting/vasp_errors'."
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
    Tool(
        name="catgo_campaign",
        description=(
            "Create and drive a CatGo Campaign — the md-orchestration system for "
            "exploratory / HPC research studies (agent-driven folder + markdown). "
            "READ the campaign skill first: catgo_skills(action='read', skill='campaign'). "
            "Actions map to the `catgo campaign` CLI:\n"
            "  new        — scaffold a new campaign folder (args: <name> [--location DIR] ...)\n"
            "  fetch-ref  — fetch reference data\n"
            "  submit     — submit a calculation\n"
            "  poll       — poll job status\n"
            "  aggregate  — aggregate results\n"
            "  report     — build the report\n"
            "  ingest     — ingest literature\n"
            "  archive    — archive the campaign\n"
            "After `new`, work the scaffolded folder with your own bash/file tools."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["new", "fetch-ref", "submit", "poll", "aggregate", "report", "ingest", "archive"],
                },
                "args": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Extra CLI args passed verbatim, e.g. ['my-study', '--location', '/home/james/research'].",
                },
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_terminal",
        description=(
            "Operate the user's VISIBLE terminal pane (local or HPC) — the same one "
            "they see on screen, with its own cwd / env / SSH session. Each "
            "run/send_keys/interrupt asks the user to approve in the app. Prefer "
            "'run' for non-interactive commands; 'send_keys' to answer a prompt or "
            "drive a TUI; 'read' to inspect the current buffer (no approval). Output "
            "reflects the visible terminal, NOT your own agent shell. If the terminal "
            "is inside tmux or a full-screen app (vim/less/htop), 'run' cannot capture "
            "output and returns a notice — drive it with 'send_keys' (type the command "
            "+ '<enter>') then 'read'."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["read", "run", "send_keys", "interrupt"],
                },
                "command": {
                    "type": "string",
                    "description": "Shell command to run (action=run).",
                },
                "keys": {
                    "type": "string",
                    "description": "Keys to send (action=send_keys), e.g. 'y<enter>', '<c-c>'.",
                },
                "lines": {
                    "type": "number",
                    "description": "Trailing lines to read (action=read, default 40).",
                },
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_validate_config",
        description=(
            "Validate the user's VASP/HPC cluster configuration against the LIVE "
            "cluster over SSH before submitting a workflow. Checks the POTCAR root "
            "and functional directories exist, the pseudopotential for each element "
            "is present, and the VASP binary resolves under the given module loads + "
            "conda env. Read potcar_root, potcar_functional, vasp_command, "
            "module_loads and python_env from the user's run config or submit "
            "script. Use whenever the user asks to test/verify/debug their cluster "
            "setup or before running VASP — never guess whether a cluster is "
            "configured correctly. See skill 'troubleshooting/cluster_config_test'."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "potcar_root": {"type": "string", "description": "POTCAR tree root, e.g. /scratch/user/VASP/pot64"},
                "potcar_functional": {"type": "string", "description": "Functional subdir (default potpaw_PBE)"},
                "vasp_command": {"type": "string", "description": "Run command, e.g. 'srun --hint=nomultithread vasp_std'"},
                "module_loads": {"type": "string", "description": "module load lines from the submit script"},
                "python_env": {"type": "string", "description": "conda/env activation lines from the submit script"},
                "elements": {"type": "array", "items": {"type": "string"}, "description": "Element symbols to check"},
                "session_id": {"type": "string", "description": "HPC session id; defaults to the active connected cluster"},
            },
            "required": ["potcar_root"],
        },
    ),
    Tool(
        name="catgo_heterostructure",
        description=(
            "Build heterostructures / interfaces / van der Waals stacks "
            "between two crystalline materials. ONE call gets you a full "
            "3D atomic structure — no need to bash + Python + pymatgen.\n"
            "\n"
            "USE THIS WHEN the user asks to: build/stack/搭/做 a "
            "heterostructure / 异质结 / interface / 界面 / epitaxial film / "
            "two-material bilayer between two crystals (e.g. MoS2/WSe2, "
            "Cu2O/ZnO, graphene/hBN, Ag on TiO2). This is the PREFERRED "
            "tool for ANY two-material interface request.\n"
            "\n"
            "DO NOT call bash + write Python + import pymatgen.interfaces / "
            "intermat / ASE to do this manually. This tool wraps the "
            "canonical Zur-McGill (ZSL) algorithm + intermat pipeline; "
            "hand-rolling produces wrong strain values and miss valid "
            "matches. DO NOT manually cut slabs first — this tool handles "
            "slab cutting internally.\n"
            "\n"
            "Actions:\n"
            "  build      — ONE-SHOT (default, RECOMMENDED): substrate "
            "+ film + optional miller_index = full heterostructure. Uses "
            "intermat pipeline, auto-picks lowest-strain ZSL match.\n"
            "  search     — return list of (match_id, strain, area) "
            "candidates without building. Use when user wants to browse "
            "options before committing.\n"
            "  build_match — build a specific match_id from a prior search. "
            "Use after `search` when user picked a candidate.\n"
            "\n"
            "EFFICIENT PATTERN — do NOT fetch+export+parse POSCARs first:\n"
            "  Just pass mp_ids directly. The tool auto-fetches both materials.\n"
            "  catgo_heterostructure{action:'build', substrate:{mp_id:'mp-30'}, "
            "film:{mp_id:'mp-81'}, substrate_miller:[1,1,1], film_miller:[1,1,1]}\n"
            "  → ONE call, done. No catgo_fetch, no catgo_structure export, no "
            "manual dict rebuild. (You may still catgo_fetch first if you want "
            "the user to SEE each bulk in the viewer, but it's not required.)\n"
            "\n"
            "EXAMPLES of prompts that should trigger THIS tool (not bash):\n"
            "  '帮我搭 Cu2O/ZnO 异质结' → build (substrate={mp_id:Cu2O id}, film={mp_id:ZnO id})\n"
            "  'build Au111 on Cu111' → build (substrate={mp_id:'mp-30'}, "
            "film={mp_id:'mp-81'}, substrate_miller=[1,1,1], film_miller=[1,1,1])\n"
            "  'epitaxial Ag on TiO2(110)' → build (substrate={mp_id:TiO2 id}, "
            "substrate_miller=[1,1,0], film={mp_id:Ag id})\n"
            "  'search heterostructure matches for Cu/Pt' → search first, "
            "then build_match.\n"
            "\n"
            "If only ONE structure is loaded in the viewer, ask the user "
            "for the second one (or its MP id) before calling this tool."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["build", "search", "build_match",
                             "search_lateral", "build_lateral"],
                    "default": "build",
                    "description": "build = one-shot vertical stack (intermat); "
                                   "search = enumerate vertical ZSL matches; "
                                   "build_match = build from prior search.match_id. "
                                   "search_lateral = enumerate 1D edge matches for a "
                                   "LATERAL (side-by-side, in-plane) heterojunction; "
                                   "build_lateral = build the lateral junction. "
                                   "Lateral takes two pre-cut SLABS (substrate/slab_A "
                                   "+ film/slab_B), not bulk + miller.",
                },
                "substrate": {
                    "type": "object",
                    "description": (
                        "Substrate material. SHORTCUT: pass {\"mp_id\": \"mp-30\"} and "
                        "the tool auto-fetches it — you do NOT need to fetch + export "
                        "POSCAR + rebuild a Structure dict first. A full pymatgen "
                        ".as_dict() also works. Omit entirely to use the current viewer "
                        "structure."
                    ),
                },
                "film": {
                    "type": "object",
                    "description": (
                        "Film material — the second one to stack. REQUIRED. SHORTCUT: "
                        "pass {\"mp_id\": \"mp-81\"} and the tool auto-fetches it. Do NOT "
                        "fetch+export+parse first — just give the mp_id. A full "
                        "pymatgen .as_dict() also works."
                    ),
                },
                "substrate_miller": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "default": [0, 0, 1],
                    "description": "Miller indices for substrate surface, e.g. [1,1,0]",
                },
                "film_miller": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "default": [0, 0, 1],
                    "description": "Miller indices for film surface",
                },
                "substrate_thickness": {
                    "type": "number",
                    "default": 10.0,
                    "description": "Substrate slab thickness in Å",
                },
                "film_thickness": {
                    "type": "number",
                    "default": 10.0,
                    "description": "Film slab thickness in Å",
                },
                "separation": {
                    "type": "number",
                    "default": 3.0,
                    "description": "Interface gap (Å) between substrate and film",
                },
                "vacuum": {
                    "type": "number",
                    "default": 20.0,
                    "description": "Vacuum spacing above the assembled stack",
                },
                "max_area": {
                    "type": "number",
                    "default": 400,
                    "description": "Max in-plane area (Å²) for ZSL lattice match search",
                },
                "max_strain": {
                    "type": "number",
                    "default": 0.09,
                    "description": "Max allowed lattice mismatch (0.09 = 9%)",
                },
                "match_id": {
                    "type": "integer",
                    "description": "Match id from a prior `search`/`search_lateral` call "
                                   "(build_match / build_lateral). For build_lateral, "
                                   "omit to auto-pick the lowest-strain / smallest match.",
                },
                "slab_A": {
                    "type": "object",
                    "description": "LATERAL only — first pre-cut slab (alias of `substrate`). "
                                   "Pass a full Structure dict, or omit to use the current "
                                   "viewer slab. mp_id is NOT appropriate here (lateral needs "
                                   "a slab, not a bulk).",
                },
                "slab_B": {
                    "type": "object",
                    "description": "LATERAL only — second pre-cut slab (alias of `film`).",
                },
                "interface_axis": {
                    "type": "integer",
                    "enum": [0, 1],
                    "default": 0,
                    "description": "LATERAL only — which in-plane edge to match: 0 = a-vector, "
                                   "1 = b-vector. The other axis is filled by width repetition.",
                },
                "lateral_max_length": {
                    "type": "number",
                    "default": 100.0,
                    "description": "LATERAL only — max matched edge length (Å) when searching.",
                },
                "lateral_max_strain": {
                    "type": "number",
                    "default": 5.0,
                    "description": "LATERAL only — max 1D edge strain tolerance in PERCENT "
                                   "(e.g. 5.0 = 5%). Distinct from `max_strain` (a 0-1 ratio "
                                   "used by the vertical ZSL search).",
                },
                "width_A": {
                    "type": "integer",
                    "default": 1,
                    "description": "LATERAL only — repetitions of slab A perpendicular to the "
                                   "interface.",
                },
                "width_B": {
                    "type": "integer",
                    "default": 1,
                    "description": "LATERAL only — repetitions of slab B perpendicular to the "
                                   "interface.",
                },
                "buffer": {
                    "type": "number",
                    "default": 0.0,
                    "description": "LATERAL only — gap (Å) inserted at the side-by-side seam.",
                },
            },
            "required": [],
        },
    ),
    Tool(
        name="catgo_nanotube",
        description=(
            "Build a nanotube by rolling up a 2D material sheet (graphene → "
            "CNT, hBN → BN nanotube, MoS2 → MoS2 nanotube). ONE call gets you "
            "a full 3D tube structure — no bash + Python + ASE.\n"
            "\n"
            "USE THIS WHEN the user asks to: build/roll/卷/做 a nanotube / "
            "碳纳米管 / 纳米管 / CNT / SWNT / MWNT / single- or multi-walled "
            "tube from a 2D sheet, with chiral indices (n,m) "
            "(e.g. '搭一个 (5,5) 碳纳米管', 'build an armchair CNT', "
            "'roll graphene into a (10,0) zigzag tube').\n"
            "\n"
            "DO NOT call bash + write Python + import ase/pymatgen to roll a "
            "sheet manually. This tool wraps the canonical chiral-vector "
            "rolling algorithm and returns a ready structure in the viewer.\n"
            "\n"
            "The LAYER to roll is a 2D material. SHORTCUT: omit `layer` and the "
            "tool rolls whatever 2D sheet is currently in the viewer (the usual "
            "case — user has graphene/hBN/MoS2 loaded). You can also pass a full "
            "Structure dict, or {mp_id:'mp-N'}. The layer must be a 2D sheet "
            "(atoms in the ab-plane, vacuum along c) — a bulk crystal will not "
            "roll correctly.\n"
            "\n"
            "Actions:\n"
            "  build — (default) roll the sheet into a tube. Needs n, m.\n"
            "  info  — compute geometry (diameter, chiral angle, atom count) "
            "WITHOUT building. Use to preview before committing.\n"
            "\n"
            "Chirality: m=0 → zigzag, n=m → armchair, else chiral.\n"
            "\n"
            "EXAMPLES:\n"
            "  '把当前石墨烯卷成 (5,5) 碳纳米管' → build {n:5, m:5}  (layer omitted = viewer)\n"
            "  'build a (10,0) zigzag CNT, 4 unit cells long' → build {n:10, m:0, NL:4}\n"
            "  'double-walled CNT (5,5)@(10,10)' → build {n:10, m:10, n_walls:2}\n"
            "  'what diameter is a (12,6) tube?' → info {n:12, m:6}"
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["build", "info"],
                    "default": "build",
                    "description": "build = construct the tube; info = geometry only (no build).",
                },
                "layer": {
                    "type": "object",
                    "description": (
                        "The 2D material sheet to roll. OMIT to use the current "
                        "viewer structure (recommended — user usually has the "
                        "sheet loaded). Or a full pymatgen Structure dict, or "
                        "{mp_id:'mp-N'}. Must be a 2D sheet, not a bulk crystal."
                    ),
                },
                "n": {"type": "integer", "minimum": 0, "description": "First chiral index n."},
                "m": {"type": "integer", "minimum": 0, "description": "Second chiral index m."},
                "NL": {
                    "type": "integer",
                    "default": 3,
                    "minimum": 1,
                    "maximum": 50,
                    "description": "Number of unit cells along the tube axis (tube length).",
                },
                "vacuum": {
                    "type": "number",
                    "default": 15.0,
                    "description": "Vacuum padding from the tube wall (Å).",
                },
                "n_walls": {
                    "type": "integer",
                    "default": 1,
                    "minimum": 1,
                    "maximum": 10,
                    "description": "Number of walls (1 = SWNT, 2+ = MWNT).",
                },
                "interlayer_spacing": {
                    "type": "number",
                    "default": 3.4,
                    "description": "Spacing between walls for MWNT (Å).",
                },
            },
            "required": ["n", "m"],
        },
    ),
    Tool(
        name="catgo_nanoparticle",
        description=(
            "Build a finite metal nanoparticle / cluster (no periodic bulk) and "
            "drop it in the viewer. ONE call — no bash + Python + ase.cluster.\n"
            "\n"
            "USE THIS WHEN the user asks to: build/make a nanoparticle / "
            "nanocluster / 纳米颗粒 / 纳米团簇 / NP, a Wulff construction / "
            "equilibrium shape, or a named cluster shape (octahedron / "
            "icosahedron / decahedron / cuboctahedron) of a metal "
            "(e.g. '做一个 100 原子的 Au 纳米颗粒', 'build a Pt icosahedron', "
            "'Wulff shape of Cu').\n"
            "\n"
            "Shapes:\n"
            "  wulff       — (default) equilibrium shape from per-facet surface "
            "energies. Set `size` (target atom count), `surfaces` + `energies`.\n"
            "  octahedron  — set `length` (edge), `cutoff` (truncation).\n"
            "  icosahedron — set `shells`.\n"
            "  decahedron  — set `p`, `q`, `r`.\n"
            "\n"
            "The cluster is centred in a vacuum box (`vacuum` Å padding) so it is "
            "ready for a molecular/cluster DFT calculation.\n"
            "\n"
            "EXAMPLES:\n"
            "  '100-atom Au Wulff nanoparticle' → {element:'Au', size:100}\n"
            "  'Pt icosahedron, 3 shells' → {element:'Pt', shape:'icosahedron', shells:3}\n"
            "  'truncated Cu octahedron' → {element:'Cu', shape:'octahedron', length:6, cutoff:2}"
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "element": {"type": "string", "description": "Metal element symbol, e.g. Au."},
                "shape": {
                    "type": "string",
                    "enum": ["wulff", "octahedron", "icosahedron", "decahedron"],
                    "default": "wulff",
                    "description": "Cluster shape.",
                },
                "structure": {
                    "type": "string",
                    "enum": ["fcc", "bcc", "sc", "hcp"],
                    "default": "fcc",
                    "description": "Lattice for the wulff construction.",
                },
                "size": {
                    "type": "integer",
                    "default": 100,
                    "description": "Target atom count (wulff).",
                },
                "surfaces": {
                    "type": "array",
                    "items": {"type": "array", "items": {"type": "integer"}},
                    "description": "Wulff Miller facets, e.g. [[1,1,1],[1,0,0]]. Default {111,100,110}.",
                },
                "energies": {
                    "type": "array",
                    "items": {"type": "number"},
                    "description": "Wulff per-facet surface energies (same length as surfaces).",
                },
                "length": {"type": "integer", "default": 5, "description": "Octahedron edge length."},
                "cutoff": {"type": "integer", "default": 0, "description": "Octahedron truncation."},
                "shells": {"type": "integer", "default": 3, "description": "Icosahedron shells."},
                "p": {"type": "integer", "default": 3, "description": "Decahedron p."},
                "q": {"type": "integer", "default": 3, "description": "Decahedron q."},
                "r": {"type": "integer", "default": 0, "description": "Decahedron r."},
                "vacuum": {"type": "number", "default": 10.0, "description": "Vacuum padding around the cluster (Å)."},
            },
            "required": ["element"],
        },
    ),
    Tool(
        name="catgo_moire",
        description=(
            "Build a twisted / moiré bilayer (twisted bilayer graphene, magic "
            "angle, twisted TMDs) from a 2D material. ONE call stacks two layers "
            "at a commensurate twist angle — no bash + Python.\n"
            "\n"
            "USE THIS WHEN the user asks to: build/搭/做 a moiré / 魔角 / 转角 / "
            "扭转双层 / 莫尔 superlattice, twisted bilayer, magic-angle graphene, "
            "twisted TMD heterobilayer (e.g. '搭一个 21.8° 转角石墨烯', "
            "'build twisted bilayer graphene', 'magic angle moiré').\n"
            "\n"
            "DO NOT hand-roll the coincidence-lattice / twist math in Python — "
            "this tool wraps the commensurate-angle search and bilayer builder.\n"
            "\n"
            "The LAYER is a 2D material. SHORTCUT: omit `layer_a` to use the "
            "current viewer structure. For a homobilayer (e.g. twisted graphene) "
            "leave `layer_b` unset — it reuses layer_a. Pass `layer_b` only for a "
            "twisted HETERObilayer. Each layer = full Structure dict, "
            "{mp_id:'mp-N'}, or omitted (viewer). Must be a 2D sheet.\n"
            "\n"
            "Actions:\n"
            "  build  — (default) build a bilayer near a target twist `angle` "
            "(degrees). The tool searches commensurate angles internally and "
            "snaps to the nearest one (twist angles are discrete), then builds.\n"
            "  search — enumerate commensurate twist angles + atom counts so the "
            "user can pick. Use when the user wants to browse before committing.\n"
            "\n"
            "⚠️ PERFORMANCE: the commensurate search is CPU-bound and grows with "
            "max_index (≈4 s at 6, ≈11 s at 10). Keep max_index ≤ 8 unless the "
            "user needs a very small angle. Small magic angles (~1°) require a "
            "large max_index and produce thousand-atom cells — warn the user it "
            "will be slow and large.\n"
            "\n"
            "EXAMPLES:\n"
            "  '把石墨烯做成 21.8° 转角双层' → build {angle:21.8}  (layer omitted = viewer)\n"
            "  'twisted bilayer graphene at 13.2°' → build {angle:13.2}\n"
            "  'list possible twist angles for graphene below 15°' → search {angle_max:15}\n"
            "  'twisted MoS2/WSe2 heterobilayer at 5°' → build {angle:5, layer_a:{mp_id:..}, layer_b:{mp_id:..}}"
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["build", "search"],
                    "default": "build",
                    "description": "build = construct bilayer near target angle; search = list commensurate angles.",
                },
                "angle": {
                    "type": "number",
                    "description": "Target twist angle (degrees) for build. The tool snaps to the nearest commensurate angle.",
                },
                "layer_a": {
                    "type": "object",
                    "description": "First 2D layer. OMIT to use the current viewer structure. Full Structure dict or {mp_id:'mp-N'}.",
                },
                "layer_b": {
                    "type": "object",
                    "description": "Second 2D layer — ONLY for a twisted heterobilayer. Omit for a homobilayer (reuses layer_a).",
                },
                "angle_min": {
                    "type": "number",
                    "default": 0.0,
                    "description": "Min twist angle for search (degrees).",
                },
                "angle_max": {
                    "type": "number",
                    "default": 30.0,
                    "description": "Max twist angle for search (degrees).",
                },
                "max_index": {
                    "type": "integer",
                    "default": 6,
                    "minimum": 1,
                    "maximum": 50,
                    "description": "Superlattice search index. Higher = more/smaller angles but SLOWER (≈4 s@6, ≈11 s@10). Keep ≤ 8.",
                },
                "vacuum": {
                    "type": "number",
                    "default": 15.0,
                    "description": "Vacuum spacing above the bilayer (Å).",
                },
                "translate_z": {
                    "type": "number",
                    "default": 3.35,
                    "description": "Interlayer spacing between the two layers (Å).",
                },
                "candidate": {
                    "type": "object",
                    "description": "Optional full MoireCandidate dict from a prior `search` to build exactly that one (skips the internal re-search).",
                },
            },
            "required": [],
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
    intent: str = "edit",
) -> str | None:
    """Push structure to viewer. Returns None on success, error string on failure.

    ``intent`` is ``"edit"`` (default — apply in place) or ``"load"`` (a fresh
    load; the frontend may prompt before overwriting an existing structure).
    Forwarded as a query param to BOTH endpoints. The in-process replacement
    ``_push_structure_direct`` (mcp_http.py) accepts the same param, so callers
    passing ``intent="load"`` work on both the HTTP and monkeypatched paths.
    """
    try:
        await client.post(
            f"{API_BASE}/view/structure/push",
            params={"panel_id": panel_id, "intent": intent},
            json={"structure": struct},
        )
        await client.post(
            f"{API_BASE}/view/structure/pending-update",
            params={"panel_id": panel_id, "intent": intent},
            json={"structure": struct},
        )
        return None
    except Exception as exc:
        return str(exc)


def _summarize(data: dict) -> str:
    """Build concise summary from a structure-modifying response."""
    from collections import Counter

    # `or {}` / `or []`: a response may carry `structure: null` (e.g. an optimize
    # that produced no structure) — plain `.get(k, default)` returns None then,
    # and the chained `.get` crashes with 'NoneType' object has no attribute 'get'.
    struct = data.get("structure") or {}
    sites = struct.get("sites") or []
    num = data.get("num_sites", len(sites))

    counts = Counter()
    for s in sites:
        el = s.get("label", (s.get("species") or [{}])[0].get("element", "?"))
        counts[el] += 1
    formula = " ".join(f"{el}{n}" for el, n in sorted(counts.items()))

    parts = [f"Done. {num} atoms ({formula})."]

    lat = struct.get("lattice") or {}
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


# ---------------------------------------------------------------------------
# Cluster generators — server-side ASE-driven geometries so CatBot does not
# have to emit every atom's xyz in the tool call. Saves an estimated 25
# tokens per atom (a 13-atom icosahedron drops from ~325 input tokens to
# ~50).
# ---------------------------------------------------------------------------

def _build_metal_cluster(cluster_type: str, element: str, size):
    """Build an ASE Atoms object for the requested metal cluster.

    Returns None if the cluster_type / element combination is not supported.
    The metals fall into a small table of constructors; if you need a shape
    we don't list, add it here rather than asking CatBot to enumerate atoms.
    """
    try:
        from ase.cluster import (
            Icosahedron, Octahedron, FaceCenteredCubic,
            HexagonalClosedPacked, Decahedron,
        )
    except ImportError:
        return None

    ct = cluster_type.lower()
    try:
        if ct == "icosahedron" or ct == "ico":
            # size = noshells (1→13, 2→55, 3→147 …)
            noshells = int(size) if size is not None else 2
            # Map common atom counts to shells
            if size in (13, "13"): noshells = 2
            elif size in (55, "55"): noshells = 3
            elif size in (147, "147"): noshells = 4
            return Icosahedron(element, noshells=noshells)

        if ct == "octahedron" or ct == "oct":
            # size = length (number of atoms along edge). 2 → 6, 3 → 19 …
            length = int(size) if size is not None else 3
            return Octahedron(element, length=length)

        if ct == "cuboctahedron" or ct == "cubo":
            # Cuboctahedron is a truncated octahedron: length - cutoff
            length = int(size) if size is not None else 4
            cutoff = max(1, length // 2)
            return Octahedron(element, length=length, cutoff=cutoff)

        if ct == "fcc":
            # FaceCenteredCubic(symbol, surfaces, layers)
            n = int(size) if size is not None else 2
            return FaceCenteredCubic(
                element,
                surfaces=[(1, 0, 0), (1, 1, 0), (1, 1, 1)],
                layers=[n, n, n],
            )

        if ct == "hcp":
            n = int(size) if size is not None else 2
            return HexagonalClosedPacked(
                element,
                surfaces=[(0, 0, 0, 1), (1, 0, -1, 0)],
                layers=[n, n],
            )

        if ct == "decahedron" or ct == "deca":
            # Ino decahedron — three integers p, q, r controlling edge counts
            p = int(size) if size is not None else 3
            return Decahedron(element, p=p, q=p, r=0)

    except (ValueError, TypeError, AssertionError):
        return None
    return None


def _oxide_cluster_table() -> dict[str, dict]:
    """Pre-baked metal-oxide cluster geometries.

    Each entry is an ASE-style dict {symbols, positions}. Positions are in Å,
    centred near origin. Real-world starting geometries — relax these in your
    DFT engine before drawing conclusions, the bond lengths and angles here
    are deliberately approximate.
    """
    return {
        # Pt(IV) double-oxo dimer (Pt2O2 ring)
        "Pt2O2": {
            "symbols": ["Pt", "Pt", "O", "O"],
            "positions": [
                [0.0,  0.0, 0.0],
                [2.8,  0.0, 0.0],
                [1.4,  1.2, 0.0],
                [1.4, -1.2, 0.0],
            ],
        },
        # 3 CeO2 units (Ce3O6 cluster)
        "CeO2_3": {
            "symbols": ["Ce", "Ce", "Ce", "O", "O", "O", "O", "O", "O"],
            "positions": [
                [0.0,  0.0, 0.0],
                [3.8,  0.0, 0.0],
                [1.9,  3.3, 0.0],
                [1.9,  1.1, 1.3],
                [1.9,  1.1, -1.3],
                [-0.8, -1.4, 0.0],
                [4.6, -1.4, 0.0],
                [1.9,  4.7, 1.3],
                [1.9,  4.7, -1.3],
            ],
        },
        # Anatase TiO2 8-atom cluster
        "TiO2_anatase_8": {
            "symbols": ["Ti", "Ti", "O", "O", "O", "O", "O", "O"],
            "positions": [
                [0.0,  0.0, 0.0],
                [3.0,  0.0, 0.0],
                [1.5,  1.4, 0.0],
                [1.5, -1.4, 0.0],
                [-1.0, 0.0, 1.3],
                [-1.0, 0.0, -1.3],
                [4.0,  0.0, 1.3],
                [4.0,  0.0, -1.3],
            ],
        },
        # Smallest neutral Al2O3 cluster
        "Al2O3_5": {
            "symbols": ["Al", "Al", "O", "O", "O"],
            "positions": [
                [0.0,  0.0, 0.0],
                [2.6,  0.0, 0.0],
                [1.3,  1.3, 0.0],
                [1.3, -1.3, 0.0],
                [1.3,  0.0, 1.6],
            ],
        },
    }


def _build_cluster_atoms(cluster_type: str, element: str, size):
    """Dispatch metal vs oxide. Returns an ASE Atoms or None."""
    ct = cluster_type.lower()
    if ct.startswith("oxide_"):
        try:
            from ase import Atoms
        except ImportError:
            return None
        key = cluster_type[len("oxide_"):]
        oxides = _oxide_cluster_table()
        spec = oxides.get(key)
        if spec is None:
            return None
        return Atoms(symbols=spec["symbols"], positions=spec["positions"])
    if not element:
        return None
    return _build_metal_cluster(cluster_type, element, size)


def _slab_top_position(struct: dict, offset: float) -> list[float]:
    """Return [cx, cy, top_z + offset] where (cx, cy) is the lateral centre
    of the slab and top_z is the maximum atomic z. Falls back to [0, 0,
    offset] if the structure has no sites.
    """
    sites = (struct or {}).get("sites") or []
    if not sites:
        return [0.0, 0.0, offset]
    xs, ys, zs = [], [], []
    for s in sites:
        xyz = s.get("xyz") or [0, 0, 0]
        if len(xyz) >= 3:
            xs.append(float(xyz[0]))
            ys.append(float(xyz[1]))
            zs.append(float(xyz[2]))
    if not xs:
        return [0.0, 0.0, offset]
    cx = 0.5 * (min(xs) + max(xs))
    cy = 0.5 * (min(ys) + max(ys))
    return [cx, cy, max(zs) + offset]


def _center_atoms_at(atoms, target: list[float]):
    """Translate ASE Atoms so its centre of mass sits at `target`."""
    com = atoms.get_center_of_mass()
    delta = [target[i] - float(com[i]) for i in range(3)]
    atoms.translate(delta)
    return atoms


async def _add_cluster_action(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Build a cluster server-side via ASE and merge into the current structure.

    The tool call payload only carries cluster_type + element + size — the
    server expands to xyz coordinates. CatBot does not have to emit any
    atom positions, which is where the token savings come from.
    """
    T = TextContent
    cluster_type = (args.get("cluster_type") or "").strip()
    element = args.get("element")
    size = args.get("size")
    position = args.get("position")
    offset = float(args.get("offset", 1.8))

    if not cluster_type:
        return [T(type="text", text="add_cluster requires 'cluster_type' (e.g. 'icosahedron', 'octahedron', 'oxide_Pt2O2').")]

    atoms = _build_cluster_atoms(cluster_type, element, size)
    if atoms is None:
        oxide_keys = ", ".join(f"oxide_{k}" for k in _oxide_cluster_table())
        return [T(type="text", text=(
            f"Unknown cluster_type '{cluster_type}'"
            + (f" or unsupported element '{element}'" if element else "")
            + f". Valid: icosahedron|octahedron|cuboctahedron|fcc|hcp|decahedron + element, or one of: {oxide_keys}."
        ))]

    base_struct = await _get_current_structure(client)
    if not base_struct:
        return [T(type="text", text="No structure in viewer.")]

    if position is None:
        position = _slab_top_position(base_struct, offset)
    else:
        position = [float(position[0]), float(position[1]), float(position[2])]

    atoms = _center_atoms_at(atoms, position)
    new_atoms = [
        {"element": str(a.symbol),
         "xyz": [float(a.position[0]), float(a.position[1]), float(a.position[2])]}
        for a in atoms
    ]

    payload = {"structure": base_struct, "atoms": new_atoms}
    resp = await client.post(f"{API_BASE}/structure-ops/add-atoms", json=payload)
    if resp.status_code != 200:
        return [T(type="text", text=f"add_cluster failed ({resp.status_code}): {resp.text[:300]}")]

    data = resp.json()
    new_struct = data.get("structure", {})
    push_err = await _push_structure(client, new_struct)

    msg = (
        f"Added {len(new_atoms)}-atom {cluster_type} cluster"
        + (f" ({element})" if element else "")
        + f" centred at [{position[0]:.2f}, {position[1]:.2f}, {position[2]:.2f}] Å. "
        f"Total sites: {data.get('num_sites', '?')}."
    )
    if push_err:
        msg += f"\n⚠️ Viewer push failed: {push_err}"
    return [T(type="text", text=msg)]


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
            f"Cell: a={lat.get('a', 0):.2f} b={lat.get('b', 0):.2f} c={lat.get('c', 0):.2f} Å. "
            f"Use action='export' to get the full POSCAR/CIF/XYZ text."
        )
        return [T(type="text", text=msg)]

    # export: serialize current viewer structure as POSCAR/CIF/XYZ/etc text
    # so the caller can Write it locally and scp/upload (lab → HPC etc.).
    if action == "export":
        struct = await _get_current_structure(client)
        if not struct:
            return [T(type="text", text="No structure loaded in viewer.")]
        fmt = (args.get("file_format") or "poscar").lower()
        resp = await client.post(
            f"{API_BASE}/workflow/files/serialize-structure",
            json={"structure": struct, "format": fmt},
        )
        if resp.status_code != 200:
            return [T(type="text", text=f"export failed ({resp.status_code}): {resp.text[:300]}")]
        data = resp.json()
        return [T(type="text", text=data.get("content", ""))]

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
        push_err = await _push_structure(client, struct, intent="load")
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

    if action == "add_cluster":
        return await _add_cluster_action(client, args)

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
    # Paths verified against the live backend (see /api/openapi.json). The old
    # table pointed several actions at endpoints that never existed
    # (/symmetry/analyze, /analysis/rdf, /analysis/coordination, …) → 404/405.
    # DOS is not a single-structure analysis — it needs an electronic-structure
    # (DFT) calculation. Point the user at the workflow path instead of a 422.
    if action == "dos":
        return [T(type="text", text=(
            "DOS needs an electronic-structure (DFT) calculation, not a bare "
            "structure. Run a DOS workflow via catgo_quickbuild(recipe='DOS') or "
            "catgo_workflow, then read the results."
        ))]

    ROUTES: dict[str, tuple[str, str]] = {
        "symmetry":         ("POST", "/structure-ops/symmetry"),
        "rdf":              ("POST", "/structure-ops/rdf"),
        "optimize":         ("POST", "/optimize/structure"),
        "adsorption_sites": ("POST", "/adsorption/sites"),
        "coordination":     ("POST", "/structure-ops/coordination"),
    }

    # dft_input has no single endpoint — it routes by target software.
    if action == "dft_input":
        software = str(args.get("software", "vasp")).lower()
        dft_ep = {"vasp": "/vasp/generate", "qe": "/qe/input", "cp2k": "/cp2k/input"}.get(software)
        if not dft_ep:
            return [T(type="text", text=f"dft_input: unsupported software '{software}'. Use vasp, qe, or cp2k.")]
        ROUTES["dft_input"] = ("POST", dft_ep)

    route = ROUTES.get(action)
    if not route:
        valid = ", ".join(list(ROUTES.keys()) + ["hub_search", "hub_install", "hub_list"])
        return [T(type="text", text=f"Unknown analyze action '{action}'. Valid: {valid}")]

    method, endpoint = route
    # `software` is a routing hint for dft_input, not a request-body field.
    payload = {k: v for k, v in args.items() if k not in ("action", "software")}

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

    # If it returned a (non-null) structure, push to viewer
    if isinstance(data, dict) and data.get("structure"):
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

    if action == "select":
        query = args.get("query")
        if not query or not str(query).strip():
            return [T(type="text", text="catgo_view select: 'query' is required (a selection DSL string).")]
        # Reuse the SAME per-viewer command bus catgo_pane rides — no new bridge
        # endpoint needed. The frontend parses the DSL against the panel's CURRENT
        # structure, applies the selection, and posts the resolved indices back.
        payload = {
            "viewer_id": str(args.get("panel_id", "default")) or "default",
            "action": "select_atoms",
            "arguments": {
                "query": str(query),
                "mode": str(args.get("mode", "replace") or "replace"),
            },
        }
        resp = await client.post(f"{API_BASE}/view/command", json=payload)
        if resp.status_code != 200:
            return [T(type="text", text=f"catgo_view select failed ({resp.status_code}): {resp.text[:300]}")]
        data = resp.json()
        if not data.get("ok", False):
            # Surface the bridge error verbatim (e.g. "viewer not mounted",
            # or a DSL parse error from the frontend) rather than swallowing it.
            return [T(type="text", text=f"catgo_view select failed: {data.get('error', 'unknown error')}")]
        return [T(type="text", text=json.dumps(data.get("result", {}), ensure_ascii=False))]

    return [T(type="text", text=f"Unknown view action '{action}'. Valid: get_state, selection, screenshot, select")]


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
    "workflow", "skills",
)


async def _handle_validate_config(client, args: dict) -> list[TextContent]:
    """Validate a VASP cluster config against the live host via /hpc/preflight/vasp."""
    T = TextContent
    session_id = args.get("session_id", "")
    if not session_id:
        try:
            r = await client.get(f"{API_BASE}/hpc/connections")
            conns = r.json()
            conns = conns if isinstance(conns, list) else conns.get("connections", [])
            remote = [c for c in conns if c.get("session_id") and c.get("session_id") != "__local__"]
            if remote:
                session_id = remote[0]["session_id"]
        except Exception:
            pass
    if not session_id:
        return [T(type="text", text="No connected HPC cluster. Connect a cluster in CatGo first, then retry.")]

    payload = {
        "session_id": session_id,
        "potcar_root": args.get("potcar_root", ""),
        "potcar_functional": args.get("potcar_functional") or "potpaw_PBE",
        "vasp_command": args.get("vasp_command", ""),
        "module_loads": args.get("module_loads", ""),
        "python_env": args.get("python_env", ""),
        "elements": args.get("elements", []),
    }
    resp = await client.post(f"{API_BASE}/hpc/preflight/vasp", json=payload)
    d = resp.json()
    lines = []
    for c in d.get("checks", []):
        mark = "PASS" if c.get("ok") else ("WARN" if c.get("severity") == "warn" else "FAIL")
        lines.append(f"{mark}  {c.get('name','')} — {c.get('detail','')}")
    if d.get("message"):
        lines.append(d["message"])
    verdict = ("Configuration looks good." if d.get("success")
               else "Configuration has problems — fix the FAIL items above before submitting.")
    return [T(type="text", text=verdict + "\n" + "\n".join(lines))]


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
# Campaign Handler — let SDK agents run the `catgo campaign` md-orchestration CLI
# ---------------------------------------------------------------------------


# Pure argv builder kept as a thin alias over the shared helper so the SDK-agent
# path and the client-direct HTTP route stay in lock-step (DRY). The PYTHONPATH
# fix + subprocess live in catgo.campaign_cli.run_campaign_cli.
from catgo.campaign_cli import campaign_argv as _campaign_argv  # noqa: E402
from catgo.campaign_cli import run_campaign_cli as _run_campaign_cli  # noqa: E402


async def _handle_campaign(args: dict) -> list[TextContent]:
    """Run the `catgo campaign` CLI on behalf of an SDK agent and return its output."""
    action = str(args.get("action") or "").strip()
    extra = [str(a) for a in (args.get("args") or [])]
    if not action:
        return [TextContent(type="text", text="error: 'action' is required")]
    try:
        text, code = await _run_campaign_cli(action, extra)
    except ValueError as e:
        return [TextContent(type="text", text=f"error: {e}")]
    except Exception as e:  # noqa: BLE001 — surface any launcher error to the agent
        return [TextContent(type="text", text=f"[catgo campaign {action}] error: {e}")]
    if code == -1 and not text:
        return [TextContent(type="text", text=f"[catgo campaign {action}] still running after 300s — check the campaign folder / poll later.")]
    status = "ok" if code == 0 else f"exit {code}"
    return [TextContent(type="text", text=f"[catgo campaign {action}] {status}\n{text}".rstrip())]


async def _handle_terminal(args: dict) -> list[TextContent]:
    """Drive the renderer's visible terminal via the terminal_bridge round-trip."""
    from catgo.routers.terminal_bridge import request_terminal  # in-process; no self-HTTP

    action = str(args.get("action") or "").strip()
    if action not in {"read", "run", "send_keys", "interrupt"}:
        return [TextContent(type="text", text="error: action must be read|run|send_keys|interrupt")]
    payload: dict = {}
    if action == "run":
        payload["command"] = str(args.get("command") or "")
    elif action == "send_keys":
        payload["keys"] = str(args.get("keys") or "")
    elif action == "read":
        payload["lines"] = int(args.get("lines") or 40)
    res = await request_terminal(action, payload)
    if res.get("error"):
        return [TextContent(type="text", text=f"[terminal] {res['error']}")]
    if res.get("denied"):
        return [TextContent(type="text", text="[terminal] the user denied this command.")]
    body = res.get("output", "")
    if res.get("exit_code") is not None:
        tail = f"\n(exit {res['exit_code']})"
    elif res.get("running"):
        tail = "\n(still running — read or send_keys to continue)"
    else:
        tail = ""
    target = res.get("target", "?")
    return [TextContent(type="text", text=f"[terminal:{action}] target={target}\n{body}{tail}".rstrip())]


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
# Quick-Build Hook — one-call recipes for common reaction workflows
# ---------------------------------------------------------------------------
#
# These recipes are server-side hooks so CatBot does NOT need to generate the
# full graph JSON itself for the most common cases. CatBot calls
# `catgo_quickbuild recipe=<name>` and the server builds the workflow directly.
# Saves the LLM 80%+ of the output tokens it would spend emitting the batch
# operations array, and skips the create + batch round-trip pair.
#
# Recipes are intentionally minimal — they produce a runnable starting
# pipeline that the user can fine-tune in the editor afterwards. They all
# end in freq → free_energy so the reported ΔG includes ZPE + TS
# corrections (real Gibbs energy, not bare DFT).


def _quickbuild_recipes() -> dict[str, dict]:
    """Return the recipe registry. Each entry produces nodes + edges that
    build on top of the auto-added `structure_input` node from `create`."""
    vasp_opt = {"software": "vasp", "encut": 520, "ediffg": -0.03,
                "freeze_mode": "bottom", "freeze_n_layers": 2}
    # Frequency on an adsorbate/slab system must fix the ENTIRE slab and vibrate
    # only the adsorbate (harmonic-adsorbate approximation). freeze_mode=adsorbate
    # freezes every atom not tagged is_adsorbate by adsorbate_place. Bottom-N
    # freezing (like geo_opt) would wrongly let the top slab layers vibrate.
    vasp_freq = {"software": "vasp", "freeze_mode": "adsorbate"}

    return {
        "HER": {
            "label": "HER free energy",
            "nodes": [
                {"id": "slab", "type": "slab_gen",
                 "params": {"miller": "1,1,1", "layers": 4, "vacuum": 15, "supercell": "2x2x1"}},
                {"id": "ads", "type": "adsorbate_place",
                 "params": {"species": "H", "site": "fcc"}},
                {"id": "opt", "type": "geo_opt", "params": vasp_opt},
                {"id": "freq", "type": "freq", "params": vasp_freq},
                {"id": "fe", "type": "free_energy",
                 "params": {"temperature": 298.15, "reference": "CHE", "target": "H"}},
            ],
            "edges": [("__si__", "slab"), ("slab", "ads"), ("ads", "opt"),
                      ("opt", "freq"), ("freq", "fe")],
        },
        "OER": {
            "label": "OER free energy",
            "nodes": [
                {"id": "slab", "type": "slab_gen",
                 "params": {"miller": "1,1,1", "layers": 4, "vacuum": 15, "supercell": "2x2x1"}},
                # OH / O / OOH intermediates relax independently
                {"id": "ads_OH", "type": "adsorbate_place",
                 "params": {"species": "OH", "site": "ontop"}},
                {"id": "ads_O", "type": "adsorbate_place",
                 "params": {"species": "O", "site": "ontop"}},
                {"id": "ads_OOH", "type": "adsorbate_place",
                 "params": {"species": "OOH", "site": "ontop"}},
                {"id": "opt_OH", "type": "geo_opt", "params": vasp_opt},
                {"id": "opt_O", "type": "geo_opt", "params": vasp_opt},
                {"id": "opt_OOH", "type": "geo_opt", "params": vasp_opt},
                {"id": "freq_OH", "type": "freq", "params": vasp_freq},
                {"id": "freq_O", "type": "freq", "params": vasp_freq},
                {"id": "freq_OOH", "type": "freq", "params": vasp_freq},
                {"id": "fe", "type": "free_energy",
                 "params": {"temperature": 298.15, "reference": "CHE", "target": "OER"}},
            ],
            "edges": [
                ("__si__", "slab"),
                ("slab", "ads_OH"), ("slab", "ads_O"), ("slab", "ads_OOH"),
                ("ads_OH", "opt_OH"), ("ads_O", "opt_O"), ("ads_OOH", "opt_OOH"),
                ("opt_OH", "freq_OH"), ("opt_O", "freq_O"), ("opt_OOH", "freq_OOH"),
                ("freq_OH", "fe"), ("freq_O", "fe"), ("freq_OOH", "fe"),
            ],
        },
        "CO2RR_2e": {
            "label": "CO2RR 2-electron (CO2 → COOH* → CO* → CO)",
            "nodes": [
                {"id": "slab", "type": "slab_gen",
                 "params": {"miller": "1,1,1", "layers": 4, "vacuum": 15, "supercell": "2x2x1"}},
                {"id": "ads_COOH", "type": "adsorbate_place",
                 "params": {"species": "COOH", "site": "ontop"}},
                {"id": "ads_CO", "type": "adsorbate_place",
                 "params": {"species": "CO", "site": "ontop"}},
                {"id": "opt_COOH", "type": "geo_opt", "params": vasp_opt},
                {"id": "opt_CO", "type": "geo_opt", "params": vasp_opt},
                {"id": "freq_COOH", "type": "freq", "params": vasp_freq},
                {"id": "freq_CO", "type": "freq", "params": vasp_freq},
                {"id": "fe", "type": "free_energy",
                 "params": {"temperature": 298.15, "reference": "CHE", "target": "CO2RR"}},
            ],
            "edges": [
                ("__si__", "slab"),
                ("slab", "ads_COOH"), ("slab", "ads_CO"),
                ("ads_COOH", "opt_COOH"), ("ads_CO", "opt_CO"),
                ("opt_COOH", "freq_COOH"), ("opt_CO", "freq_CO"),
                ("freq_COOH", "fe"), ("freq_CO", "fe"),
            ],
        },
        "NRR": {
            "label": "NRR (N2 → *N2H → *NH2 → NH3) free energy",
            "nodes": [
                {"id": "slab", "type": "slab_gen",
                 "params": {"miller": "1,1,1", "layers": 4, "vacuum": 15, "supercell": "2x2x1"}},
                {"id": "ads_N2", "type": "adsorbate_place",
                 "params": {"species": "N2", "site": "ontop"}},
                {"id": "ads_N2H", "type": "adsorbate_place",
                 "params": {"species": "NNH", "site": "ontop"}},
                {"id": "ads_NH2", "type": "adsorbate_place",
                 "params": {"species": "NH2", "site": "ontop"}},
                {"id": "opt_N2", "type": "geo_opt", "params": vasp_opt},
                {"id": "opt_N2H", "type": "geo_opt", "params": vasp_opt},
                {"id": "opt_NH2", "type": "geo_opt", "params": vasp_opt},
                {"id": "freq_N2", "type": "freq", "params": vasp_freq},
                {"id": "freq_N2H", "type": "freq", "params": vasp_freq},
                {"id": "freq_NH2", "type": "freq", "params": vasp_freq},
                {"id": "fe", "type": "free_energy",
                 "params": {"temperature": 298.15, "reference": "CHE", "target": "NRR"}},
            ],
            "edges": [
                ("__si__", "slab"),
                ("slab", "ads_N2"), ("slab", "ads_N2H"), ("slab", "ads_NH2"),
                ("ads_N2", "opt_N2"), ("ads_N2H", "opt_N2H"), ("ads_NH2", "opt_NH2"),
                ("opt_N2", "freq_N2"), ("opt_N2H", "freq_N2H"), ("opt_NH2", "freq_NH2"),
                ("freq_N2", "fe"), ("freq_N2H", "fe"), ("freq_NH2", "fe"),
            ],
        },
        "ORR": {
            "label": "ORR (O2 → OOH* → O* → OH* → H2O) free energy",
            "nodes": [
                {"id": "slab", "type": "slab_gen",
                 "params": {"miller": "1,1,1", "layers": 4, "vacuum": 15, "supercell": "2x2x1"}},
                {"id": "ads_OOH", "type": "adsorbate_place",
                 "params": {"species": "OOH", "site": "ontop"}},
                {"id": "ads_O", "type": "adsorbate_place",
                 "params": {"species": "O", "site": "fcc"}},
                {"id": "ads_OH", "type": "adsorbate_place",
                 "params": {"species": "OH", "site": "ontop"}},
                {"id": "opt_OOH", "type": "geo_opt", "params": vasp_opt},
                {"id": "opt_O", "type": "geo_opt", "params": vasp_opt},
                {"id": "opt_OH", "type": "geo_opt", "params": vasp_opt},
                {"id": "freq_OOH", "type": "freq", "params": vasp_freq},
                {"id": "freq_O", "type": "freq", "params": vasp_freq},
                {"id": "freq_OH", "type": "freq", "params": vasp_freq},
                {"id": "fe", "type": "free_energy",
                 "params": {"temperature": 298.15, "reference": "CHE", "target": "ORR"}},
            ],
            "edges": [
                ("__si__", "slab"),
                ("slab", "ads_OOH"), ("slab", "ads_O"), ("slab", "ads_OH"),
                ("ads_OOH", "opt_OOH"), ("ads_O", "opt_O"), ("ads_OH", "opt_OH"),
                ("opt_OOH", "freq_OOH"), ("opt_O", "freq_O"), ("opt_OH", "freq_OH"),
                ("freq_OOH", "fe"), ("freq_O", "fe"), ("freq_OH", "fe"),
            ],
        },
        "NEB": {
            "label": "NEB / CI-NEB transition-state search",
            "nodes": [
                {"id": "r_opt", "type": "geo_opt",
                 "params": {**vasp_opt, "label_hint": "reactant"}},
                {"id": "p_opt", "type": "geo_opt",
                 "params": {**vasp_opt, "label_hint": "product"}},
                {"id": "neb", "type": "neb",
                 "params": {"software": "vasp", "n_images": 7, "climbing": True}},
                {"id": "freq", "type": "freq", "params": vasp_freq},
            ],
            "edges": [
                ("__si__", "r_opt"), ("__si__", "p_opt"),
                ("r_opt", "neb"), ("p_opt", "neb"),
                ("neb", "freq"),
            ],
        },
        "slow_growth": {
            "label": "Slow-growth constrained AIMD",
            "nodes": [
                {"id": "opt", "type": "geo_opt", "params": vasp_opt},
                {"id": "equil", "type": "md",
                 "params": {"software": "vasp", "ensemble": "nvt", "temperature": 300,
                            "nsw": 2000, "potim": 0.5}},
                {"id": "sg", "type": "slow_growth",
                 "params": {"software": "vasp", "iconst": "<set ICONST template per reaction>"}},
                {"id": "barrier", "type": "md_analysis", "params": {"mode": "barrier"}},
            ],
            "edges": [
                ("__si__", "opt"), ("opt", "equil"),
                ("equil", "sg"), ("sg", "barrier"),
            ],
        },
        "DOS": {
            "label": "DOS + d-band centre",
            "nodes": [
                {"id": "opt", "type": "geo_opt", "params": {"software": "vasp", "encut": 520, "ediffg": -0.03}},
                {"id": "sp", "type": "single_point", "params": {"software": "vasp", "encut": 520}},
                {"id": "dos", "type": "dos_analysis",
                 "params": {"emin": -10, "emax": 5, "d_band_center": True}},
            ],
            "edges": [("__si__", "opt"), ("opt", "sp"), ("sp", "dos")],
        },
    }


async def _handle_quickbuild(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Server-side hook: build a complete reaction workflow from a recipe name.

    Saves CatBot from generating the batch operations array — picks the right
    nodes + edges based on the recipe registry, calls the workflow create
    endpoint once, then routes navigation to the originating tab.
    """
    T = TextContent
    recipe_name = (args.get("recipe") or "").strip()
    material_id = (args.get("material_id") or "").strip() or None
    name_arg = (args.get("name") or "").strip() or None

    recipes = _quickbuild_recipes()
    if not recipe_name or recipe_name not in recipes:
        listing = ", ".join(sorted(recipes.keys()))
        return [T(type="text", text=f"Unknown recipe '{recipe_name}'. Available: {listing}.")]

    recipe = recipes[recipe_name]
    label = recipe["label"]
    final_name = name_arg or f"{label} ({material_id or 'current viewer'})"

    # Build init graph: structure_input + recipe nodes + edges.
    si_id = "si"
    nodes: list[dict] = []
    if material_id:
        si_params: dict[str, object] = {"label": material_id, "mp_id": material_id}
        # Pre-fetch the bulk structure here so the resulting workflow's
        # `structure_input` node is usable immediately. Without this,
        # quickbuild only writes {label, mp_id} and every downstream
        # `resolve_input_structure(...)` returns null until the user
        # manually clicks the node to trigger fetch — which makes
        # slab_gen / adsorbate_place preview empty on first load.
        # The MCP `batch` op already does this fetch (workflow_tools.py
        # add_node + batch path); we mirror it here.
        try:
            from catgo.mcp_tools.workflow_tools import _fetch_structure_by_mp_id
            struct_json = await _fetch_structure_by_mp_id(client, material_id)
            if struct_json:
                si_params["structure_json"] = struct_json
                logger.info("Quickbuild: prefetched %s for structure_input", material_id)
        except Exception as exc:
            logger.warning("Quickbuild: failed to prefetch %s: %s", material_id, exc)
    else:
        si_params = {}
    # Fallback: if the mp-id prefetch failed (or no material_id was given),
    # capture whatever the user already has in the viewer. CatBot typically
    # fetches the material by name and loads it into the viewer *before*
    # calling quickbuild, so the viewer is the most reliable source of the
    # intended structure — without this the structure_input node ends up
    # empty even though the correct structure is sitting on screen.
    if not si_params.get("structure_json"):
        viewer_struct = await _get_current_structure(client)
        if viewer_struct:
            si_params["structure_json"] = json.dumps(viewer_struct)
            logger.info("Quickbuild: captured viewer structure into structure_input")
    nodes.append({"id": si_id, "type": "structure_input", "x": 80, "y": 200, "params": si_params})

    x = 280
    for i, n in enumerate(recipe["nodes"]):
        nodes.append({
            "id": n["id"], "type": n["type"], "x": x, "y": 200 + (i % 3) * 130,
            "params": n["params"],
        })
        x += 220

    # Edge shape: workflow_tools.batch / add_node store edges as
    # {"id", "from", "to", "fromH", "toH"} and that's what the frontend
    # canvas + the workflow engine read. The previous version of this
    # function emitted {"source", "target"} and no handles, which got
    # saved verbatim into graph_json — the edges were present in the DB
    # but every consumer read `.from` / `.to` / `.fromH` and crashed on
    # `undefined.split(...)`, so the canvas drew nothing and the engine
    # couldn't traverse the DAG. Pick the handle names from each node's
    # registered I/O so freq → free_energy etc. wire up correctly.
    from catgo.mcp_tools.workflow_tools import _NODE_DEFAULTS as _ND
    node_io: dict[str, tuple[list[str], list[str]]] = {}
    for n in nodes:
        nd = _ND.get(n["type"], {})
        # Follow aliases (e.g. vasp_relax → geo_opt) the same way the
        # batch + add_node handlers do.
        if "_alias" in nd:
            nd = _ND.get(nd["_alias"], {})
        node_io[n["id"]] = (
            list(nd.get("_inputs", []) or []),
            list(nd.get("_outputs", []) or []),
        )

    def _pick_handles(from_id: str, to_id: str) -> tuple[str, str]:
        outs = node_io.get(from_id, ([], []))[1]
        ins = node_io.get(to_id, ([], []))[0]
        # Prefer a name that appears on both sides (structure → structure,
        # energy → energy, frequencies → frequencies). Otherwise fall back
        # to the first declared handle on each side.
        common = [h for h in outs if h in ins]
        if common:
            return common[0], common[0]
        return (outs[0] if outs else "structure",
                ins[0] if ins else "structure")

    edges: list[dict] = []
    edge_ts = int(time.time())
    for i, (src, dst) in enumerate(recipe["edges"]):
        from_id = si_id if src == "__si__" else src
        from_h, to_h = _pick_handles(from_id, dst)
        edges.append({
            "id": f"e{edge_ts}-{i:02d}",
            "from": from_id,
            "to": dst,
            "fromH": from_h,
            "toH": to_h,
        })

    graph_json = {"nodes": nodes, "edges": edges}
    payload = {"name": final_name, "graph_json": json.dumps(graph_json)}

    base = f"{API_BASE}/workflow"
    resp = await client.post(f"{base}/", json=payload)
    if resp.status_code not in (200, 201):
        return [T(type="text", text=f"QuickBuild failed ({resp.status_code}): {resp.text[:300]}")]
    wf = resp.json()
    try:
        await _push_workflow_navigate(client, wf["id"])
    except Exception:
        pass

    return [T(
        type="text",
        text=(
            f"Built {final_name!r} (id={wf['id']}): {len(nodes)} nodes, {len(edges)} edges. "
            "Workflow editor is open — adjust parameters or click Run when ready."
        ),
    )]


async def _resolve_hetero_material(
    client: httpx.AsyncClient, material: object | None, role: str = "material",
) -> dict | str:
    """Normalize substrate/film arg into a full Structure dict.

    Accepts:
      - dict with 'sites' / 'lattice' → already a Structure dict, pass through
      - dict with only {'mp_id': 'mp-N'} → fetch from Materials Project
      - {'structure_id': 'mp-N'}        → same
      - None (only for substrate)       → fall back to current viewer
      - bare string 'mp-N'              → fetch from MP

    Returns dict on success, error string on failure. LLM kept passing
    {mp_id:'...'} expecting the tool to auto-fetch (which is the natural
    shorthand from the catgo_fetch response); without this normalization
    every call 422s on `body.{substrate,film}.sites: Field required`.
    """
    # None → viewer fallback (substrate only)
    if material is None:
        if role == "substrate":
            cur = await _get_current_structure(client)
            if cur is not None:
                return cur
        return f"`{role}` is required. Either pass a full Structure dict, an mp_id ('mp-N'), or load it into the viewer first."

    # Bare string is interpreted as mp_id
    if isinstance(material, str):
        material = {"mp_id": material}

    if not isinstance(material, dict):
        return f"`{role}` must be a dict (Structure) or mp_id string, got {type(material).__name__}"

    # Already a full Structure dict — pass through
    if "sites" in material and "lattice" in material:
        return material

    # Just mp_id / structure_id — auto-fetch via OPTIMADE (same path as
    # catgo_fetch crystal). There is NO `GET /fetch/crystal` REST endpoint;
    # the MCP fetch handler resolves IDs through OPTIMADE provider APIs
    # directly. Reuse those helpers so a {mp_id:'mp-N'} shorthand resolves
    # to a real Structure dict instead of 404ing.
    mp_id = material.get("mp_id") or material.get("structure_id") or material.get("id")
    if isinstance(mp_id, str) and mp_id.strip():
        # Provider inferred from id prefix; default to mp.
        provider = "mp"
        try:
            from catgo.mcp_tools.structure_tools import (
                _optimade_fetch_by_id_direct,
                _optimade_to_pymatgen,
            )
            entry = await _optimade_fetch_by_id_direct(client, provider, mp_id)
            if not entry:
                return f"Could not fetch {role}={mp_id} from provider '{provider}'. Pass a full Structure dict instead, or load it in the viewer."
            struct_dict = _optimade_to_pymatgen(entry)
            # Standardize to conventional cell so Miller indices are correct
            # (mirrors _handle_fetch_crystal).
            try:
                conv = await client.post(
                    f"{API_BASE}/structure-ops/conventional-cell",
                    json={"structure": struct_dict}, timeout=15.0,
                )
                if conv.status_code == 200 and conv.json().get("structure"):
                    struct_dict = conv.json()["structure"]
            except Exception:
                pass
            return struct_dict
        except Exception as exc:
            return f"Failed to fetch {role}={mp_id}: {exc}"

    return f"`{role}` shape unrecognized; need full Structure dict or {{mp_id:'mp-N'}}. Got keys: {list(material.keys())[:5]}"


async def _handle_lateral_heterostructure(
    client: httpx.AsyncClient, args: dict,
) -> list[TextContent]:
    """Search / build a LATERAL (in-plane, side-by-side) heterojunction.

    Routes:
      - search_lateral → /heterostructure/search-lateral  (1D edge matches)
      - build_lateral  → /heterostructure/build-lateral   (join two slabs)

    Inputs are two PRE-CUT slabs, accepted under `slab_A`/`slab_B` (preferred)
    or the `substrate`/`film` aliases shared with the vertical path. `slab_A`
    falls back to the current viewer structure when omitted. mp_id is NOT a
    sensible input here (lateral needs a slab, not a bulk) — _resolve_hetero_material
    still accepts it, but we don't conventional-cell-standardize.

    build_lateral mirrors build_match: it re-runs search-lateral internally to
    recover the full LateralMatch dict (the backend's /build-lateral body needs
    n1/n2/edge lengths the LLM can't supply), picking the requested match_id or
    the best (lowest-strain) candidate when none is given.
    """
    T = TextContent
    action = (args.get("action") or "").lower()

    slab_A_arg = args.get("slab_A", args.get("substrate"))
    slab_B_arg = args.get("slab_B", args.get("film"))
    slab_A = await _resolve_hetero_material(client, slab_A_arg, role="substrate")
    if isinstance(slab_A, str):
        return [T(type="text", text=slab_A)]
    slab_B = await _resolve_hetero_material(client, slab_B_arg, role="film")
    if isinstance(slab_B, str):
        return [T(type="text", text=slab_B)]

    # Clamp to the backend's accepted ranges (LateralSearchParams /
    # LateralBuildParams Field bounds). The LLM frequently passes values just
    # outside these (e.g. max_strain=0.01 for "as tight as possible"); without
    # clamping the backend 422s with a raw pydantic error that the model can't
    # act on. Clamping turns it into a sensible run instead.
    def _clamp(v, lo, hi):
        return max(lo, min(hi, v))

    search_params = {
        "interface_axis": 1 if int(args.get("interface_axis", 0)) >= 1 else 0,
        "max_length": _clamp(float(args.get("lateral_max_length", 100.0)), 5.0, 500.0),
        "max_strain": _clamp(float(args.get("lateral_max_strain", 5.0)), 0.1, 20.0),
        "max_results": int(_clamp(int(args.get("max_results", 50)), 1, 200)),
    }

    # Always run the edge-match search first (both actions need it).
    sresp = await client.post(
        f"{API_BASE}/heterostructure/search-lateral",
        json={"slab_A": slab_A, "slab_B": slab_B, "params": search_params},
    )
    if sresp.status_code != 200:
        return [T(type="text", text=(
            f"Lateral search failed ({sresp.status_code}): {sresp.text[:400]}"
        ))]
    matches = sresp.json().get("matches") or []

    if action == "search_lateral":
        if not matches:
            return [T(type="text", text=(
                "No lateral edge matches found. Try a larger lateral_max_length "
                "or lateral_max_strain, or the other interface_axis."
            ))]
        lines = [f"Found {len(matches)} lateral edge matches "
                 f"(axis={search_params['interface_axis']}, lower strain = better):"]
        for m in matches[:10]:
            lines.append(
                f"  match_id={m.get('match_id')}: n1={m.get('n1')} n2={m.get('n2')}, "
                f"edge≈{m.get('edge_length_A')} Å, strain={m.get('strain_percent')}%, "
                f"atoms={m.get('n_atoms_A', 0) + m.get('n_atoms_B', 0)}"
            )
        lines.append("\nCall action=build_lateral with match_id to construct the junction.")
        return [T(type="text", text="\n".join(lines))]

    # action == build_lateral
    if not matches:
        return [T(type="text", text=(
            "Cannot build lateral junction — no edge matches at the current "
            "tolerances. Loosen lateral_max_strain / lateral_max_length first."
        ))]

    match_id = args.get("match_id")
    if match_id is None:
        # matches are already sorted by (total atoms, strain) — first is best.
        target = matches[0]
    else:
        target = next((m for m in matches if m.get("match_id") == int(match_id)), None)
        if target is None:
            ids = [m.get("match_id") for m in matches]
            return [T(type="text", text=(
                f"match_id={match_id} not in lateral search results. Available: {ids[:20]}"
            ))]

    build_params = {
        "width_A": int(_clamp(int(args.get("width_A", 1)), 1, 10)),
        "width_B": int(_clamp(int(args.get("width_B", 1)), 1, 10)),
        "buffer": _clamp(float(args.get("buffer", 0.0)), 0.0, 10.0),
        "vacuum": _clamp(float(args.get("vacuum", 20.0)), 0.0, 60.0),
    }
    resp = await client.post(
        f"{API_BASE}/heterostructure/build-lateral",
        json={
            "slab_A": slab_A,
            "slab_B": slab_B,
            "match": target,
            "params": build_params,
            "search_params": search_params,
        },
    )
    if resp.status_code != 200:
        return [T(type="text", text=(
            f"Lateral build failed ({resp.status_code}): {resp.text[:400]}"
        ))]
    data = resp.json()
    new_struct = data.get("structure")
    if not new_struct:
        return [T(type="text", text=(
            f"Lateral build returned no structure. Response: {json.dumps(data)[:400]}"
        ))]

    push_err = await _push_structure(client, new_struct)
    strain = data.get("strain")
    strain_str = f", strain={strain:.2f}%" if isinstance(strain, (int, float)) else ""
    msg = (
        f"Lateral heterojunction built: {data.get('n_atoms', '?')} atoms "
        f"({data.get('n_atoms_A', '?')} A + {data.get('n_atoms_B', '?')} B), "
        f"interface={data.get('interface_length', 0):.2f} Å{strain_str}. Viewer updated."
    )
    if push_err:
        msg += f"\n⚠️ Viewer push failed: {push_err}"
    return [T(type="text", text=msg)]


async def _handle_pane(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    action = str(args.get("action", "")).strip()
    if action == "list":
        resp = await client.get(f"{API_BASE}/view/manifest")
        if resp.status_code != 200:
            return [TextContent(type="text", text=f"catgo_pane failed ({resp.status_code}): {resp.text[:300]}")]
        return [TextContent(type="text", text=json.dumps(resp.json(), ensure_ascii=False))]
    viewer_id = str(args.get("viewer_id", "")).strip()
    if not viewer_id or not action:
        return [TextContent(type="text", text="viewer_id and action are required.")]
    arguments = {k: v for k, v in args.items() if k not in ("viewer_id", "action")}
    resp = await client.post(
        f"{API_BASE}/view/command",
        json={"viewer_id": viewer_id, "action": action, "arguments": arguments},
    )
    if resp.status_code != 200:
        return [TextContent(type="text", text=f"catgo_pane failed ({resp.status_code}): {resp.text[:300]}")]
    data = resp.json()
    if not data.get("ok", False):
        return [TextContent(type="text", text=f"catgo_pane failed: {data.get('error', 'unknown error')}")]
    return [TextContent(type="text", text=json.dumps(data.get("result", {}), ensure_ascii=False))]


async def _handle_heterostructure(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Build / search heterostructures between two crystal structures.

    Routes:
      - build       → /heterostructure/build-intermat (one-shot, default)
      - search      → /heterostructure/search        (enumerate ZSL matches)
      - build_match → /heterostructure/build         (build a specific match_id from search)

    Robustness:
      - If `substrate` / `film` is None or {mp_id: 'mp-N'}, auto-fetch the
        full Structure dict from Materials Project via /fetch/crystal.
      - For build_match, the LLM only needs to pass match_id — we re-run the
        underlying /search internally to recover the full match dict the
        backend wants (HeterostructureMatch with sl_vectors, transformations,
        ...). Without this the LLM has no way to construct match dict from
        scratch and every build_match call 422s.
      - High-strain results (>15%) get a clear WARNING in the message so the
        LLM doesn't accept a 273% mismatch as "success" and move on.
    """
    T = TextContent
    action = (args.get("action") or "build").lower()

    # Lateral (in-plane, side-by-side) heterojunction is a distinct code path:
    # it joins two PRE-CUT slabs along one in-plane edge via 1D edge matching,
    # rather than cutting slabs from bulk + miller and ZSL-stacking them. It
    # takes slab_A/slab_B (aliased to substrate/film) and lateral-specific
    # params, so handle and return before the bulk param assembly below.
    if action in ("search_lateral", "build_lateral"):
        return await _handle_lateral_heterostructure(client, args)

    substrate = args.get("substrate")
    film = args.get("film")
    substrate = await _resolve_hetero_material(client, substrate, role="substrate")
    if isinstance(substrate, str):  # error message
        return [T(type="text", text=substrate)]
    film = await _resolve_hetero_material(client, film, role="film")
    if isinstance(film, str):
        return [T(type="text", text=film)]

    # Build params payload from the optional knobs.
    params = {
        "substrate_miller": args.get("substrate_miller", [0, 0, 1]),
        "film_miller": args.get("film_miller", [0, 0, 1]),
        "substrate_thickness": args.get("substrate_thickness", 10.0),
        "film_thickness": args.get("film_thickness", 10.0),
        "max_area": args.get("max_area", 400),
    }
    if "max_strain" in args:
        params["max_area_ratio_tol"] = args["max_strain"]
        params["max_length_tol"] = args["max_strain"]

    if action == "build":
        params["separation"] = args.get("separation", 3.0)
        params["vacuum"] = args.get("vacuum", 20.0)
        payload = {"substrate": substrate, "film": film, "params": params}
        resp = await client.post(f"{API_BASE}/heterostructure/build-intermat", json=payload)
    elif action == "search":
        payload = {"substrate": substrate, "film": film, "params": params}
        resp = await client.post(f"{API_BASE}/heterostructure/search", json=payload)
    elif action == "build_match":
        match_id = args.get("match_id")
        if match_id is None:
            return [T(type="text", text="action=build_match needs `match_id` from a prior `search`.")]
        # Re-run search to recover the full match dict — backend's /build
        # needs match_area / transformations / sl_vectors which the LLM
        # cannot provide on its own. This is one extra RTT (~few s) but
        # makes build_match actually usable from the agent.
        search_payload = {"substrate": substrate, "film": film, "params": params}
        sresp = await client.post(f"{API_BASE}/heterostructure/search", json=search_payload)
        if sresp.status_code != 200:
            return [T(type="text", text=f"build_match needs prior search; search failed ({sresp.status_code}): {sresp.text[:300]}")]
        sdata = sresp.json()
        all_matches = sdata.get("matches") or []
        target_match = next((m for m in all_matches if m.get("match_id") == int(match_id)), None)
        if target_match is None:
            ids = [m.get("match_id") for m in all_matches]
            return [T(type="text", text=f"match_id={match_id} not in search results. Available ids: {ids[:20]}")]
        build_params = {
            "gap": args.get("separation", 2.0),
            "vacuum": args.get("vacuum", 20.0),
            "substrate_thickness": params["substrate_thickness"],
            "film_thickness": params["film_thickness"],
        }
        payload = {
            "substrate": substrate,
            "film": film,
            "match": target_match,
            "termination_index": args.get("termination_index", 0),
            "params": build_params,
            "search_params": params,
        }
        resp = await client.post(f"{API_BASE}/heterostructure/build", json=payload)
    else:
        return [T(type="text", text=f"Unknown heterostructure action: {action!r}. Valid: build, search, build_match.")]

    if resp.status_code != 200:
        return [T(
            type="text",
            text=f"Heterostructure {action} failed ({resp.status_code}): {resp.text[:400]}",
        )]
    data = resp.json()

    # Push the built structure into the viewer so the user sees it immediately.
    if action in ("build", "build_match"):
        new_struct = data.get("structure") or data.get("interface_structure")
        if new_struct:
            push_err = await _push_structure(client, new_struct)
            n_sites = (new_struct.get("sites") and len(new_struct["sites"])) or "?"
            # Backend's strain field is a percent value (e.g. 4.0 = 4%). NOT a
            # 0-1 ratio. Use literal %f formatting; the previous .3% format
            # added an extra ×100 which masked the issue but produced
            # nonsense like "273.290%" when the underlying strain was 2.73
            # (= 273% — already unusable, but the format made it look like
            # we agreed). High-strain warning helps the LLM realize the
            # interface is bad and try different miller indices / max_area.
            strain = data.get("strain")
            if not isinstance(strain, (int, float)):
                strain = (data.get("match") or {}).get("strain")
            strain_str = ""
            warning = ""
            if isinstance(strain, (int, float)):
                strain_str = f", strain={strain:.2f}%"
                if strain > 15:
                    warning = (
                        f"\n⚠️  STRAIN {strain:.1f}% IS UNUSABLY HIGH. The interface as "
                        f"built is not physically reasonable. Try one of:\n"
                        f"   - increase max_area to 600-1200 (current {params['max_area']})\n"
                        f"   - try different miller indices (current substrate={params['substrate_miller']}, film={params['film_miller']})\n"
                        f"   - call action='search' first to browse all candidates with strain values"
                    )
            mm_u = data.get("mismatch_u")
            mm_v = data.get("mismatch_v")
            mm_str = ""
            if isinstance(mm_u, (int, float)) and isinstance(mm_v, (int, float)):
                mm_str = f", mismatch u={mm_u:.2f}% v={mm_v:.2f}%"
            msg = f"Heterostructure built: {n_sites} atoms{strain_str}{mm_str}. Viewer updated.{warning}"
            if push_err:
                msg += f"\n⚠️ Viewer push failed: {push_err}"
            return [T(type="text", text=msg)]
        return [T(type="text", text=f"Heterostructure {action} returned no structure. Response: {json.dumps(data)[:400]}")]

    # search: report matches so LLM can pick one
    matches = data.get("matches") or []
    if not matches:
        return [T(type="text", text="No lattice matches found. Try increasing max_area or max_strain.")]
    lines = [f"Found {len(matches)} matches (lower strain = better):"]
    for i, m in enumerate(matches[:10]):
        mid = m.get("match_id", i)
        area = m.get("area") or m.get("supercell_area", "?")
        strain = m.get("strain") or m.get("max_strain", "?")
        lines.append(f"  match_id={mid}: area={area} Å², strain={strain}")
    lines.append("\nCall action=build_match with match_id to construct the chosen interface.")
    return [T(type="text", text="\n".join(lines))]


async def _resolve_layer(
    client: httpx.AsyncClient, layer: object | None, role: str = "layer",
) -> dict | str:
    """Normalize a 2D-layer arg (nanotube/moire) into a {structure: dict}.

    Unlike _resolve_hetero_material, the layer is the PRIMARY input for these
    tools, so None always falls back to the current viewer (the user usually
    has the 2D sheet loaded). Accepts a full Structure dict, {mp_id:'mp-N'},
    or a pre-wrapped {structure: {...}}. mp_id is fetched via OPTIMADE but NOT
    conventional-cell standardized — that can break a 2D sheet's vacuum axis.

    Returns a layer-input dict {"structure": <dict>} on success, or an error
    string on failure.
    """
    # Already wrapped as a layer input — pass through.
    if isinstance(layer, dict) and "structure" in layer and isinstance(layer["structure"], dict):
        return layer

    # None → viewer fallback.
    if layer is None:
        cur = await _get_current_structure(client)
        if cur is not None:
            return {"structure": cur}
        return (
            f"No {role} given and nothing in the viewer. Load a 2D material "
            f"(graphene/hBN/MoS2) first, or pass a Structure dict / {{mp_id:'mp-N'}}."
        )

    if isinstance(layer, str):
        layer = {"mp_id": layer}

    if not isinstance(layer, dict):
        return f"`{role}` must be a Structure dict or mp_id string, got {type(layer).__name__}"

    # Full Structure dict — wrap it.
    if "sites" in layer and "lattice" in layer:
        return {"structure": layer}

    # mp_id / structure_id → OPTIMADE fetch (no conventional-cell).
    mp_id = layer.get("mp_id") or layer.get("structure_id") or layer.get("id")
    if isinstance(mp_id, str) and mp_id.strip():
        try:
            from catgo.mcp_tools.structure_tools import (
                _optimade_fetch_by_id_direct,
                _optimade_to_pymatgen,
            )
            entry = await _optimade_fetch_by_id_direct(client, "mp", mp_id)
            if not entry:
                return f"Could not fetch {role}={mp_id}. Pass a Structure dict, or load the sheet in the viewer."
            return {"structure": _optimade_to_pymatgen(entry)}
        except Exception as exc:
            return f"Failed to fetch {role}={mp_id}: {exc}"

    return f"`{role}` shape unrecognized; need a Structure dict or {{mp_id:'mp-N'}}. Got keys: {list(layer.keys())[:5]}"


async def _handle_nanotube(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Build / inspect a nanotube rolled from a 2D sheet.

    Routes:
      - build → /nanotube/build (roll the sheet, push tube to viewer)
      - info  → /nanotube/info  (geometry only, no structure)

    The layer defaults to the current viewer structure (user usually has the
    2D sheet loaded). n, m are required chiral indices.
    """
    T = TextContent
    action = (args.get("action") or "build").lower()

    n = args.get("n")
    m = args.get("m")
    if n is None or m is None:
        return [T(type="text", text="catgo_nanotube needs chiral indices `n` and `m` (e.g. {n:5, m:5}).")]
    if int(n) == 0 and int(m) == 0:
        return [T(type="text", text="Both chiral indices cannot be zero — use e.g. (5,5) armchair or (10,0) zigzag.")]

    layer = await _resolve_layer(client, args.get("layer"), role="layer")
    if isinstance(layer, str):
        return [T(type="text", text=layer)]

    if action == "info":
        payload = {"layer": layer, "params": {"n": int(n), "m": int(m), "NL": int(args.get("NL", 1))}}
        resp = await client.post(f"{API_BASE}/nanotube/info", json=payload)
        if resp.status_code != 200:
            return [T(type="text", text=f"Nanotube info failed ({resp.status_code}): {resp.text[:400]}")]
        d = resp.json()
        return [T(type="text", text=d.get("message") or json.dumps(d, ensure_ascii=False)[:400])]

    if action != "build":
        return [T(type="text", text=f"Unknown nanotube action: {action!r}. Valid: build, info.")]

    params = {
        "n": int(n),
        "m": int(m),
        "NL": int(args.get("NL", 3)),
        "vacuum": float(args.get("vacuum", 15.0)),
        "n_walls": int(args.get("n_walls", 1)),
        "interlayer_spacing": float(args.get("interlayer_spacing", 3.4)),
    }
    resp = await client.post(f"{API_BASE}/nanotube/build", json={"layer": layer, "params": params})
    if resp.status_code != 200:
        return [T(type="text", text=f"Nanotube build failed ({resp.status_code}): {resp.text[:400]}")]
    data = resp.json()
    new_struct = data.get("structure")
    if not new_struct:
        return [T(type="text", text=f"Nanotube build returned no structure. Response: {json.dumps(data)[:400]}")]
    push_err = await _push_structure(client, new_struct, intent="load")
    msg = data.get("message") or f"Nanotube built: {data.get('n_atoms', '?')} atoms."
    msg += " Viewer updated."
    if push_err:
        msg += f"\n⚠️ Viewer push failed: {push_err}"
    return [T(type="text", text=msg)]


async def _handle_nanoparticle(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Build a finite metal nanoparticle/cluster and push it to the viewer.

    Routes to /build/nanoparticle (wraps ase.cluster). `element` is required;
    `shape` defaults to wulff.
    """
    T = TextContent
    element = (args.get("element") or "").strip()
    if not element:
        return [T(type="text", text="catgo_nanoparticle needs an `element` (e.g. {element:'Au'}).")]

    payload: dict = {"element": element}
    for key in ("shape", "structure", "size", "surfaces", "energies",
                "length", "cutoff", "shells", "p", "q", "r", "vacuum"):
        if args.get(key) is not None:
            payload[key] = args[key]

    resp = await client.post(f"{API_BASE}/build/nanoparticle", json=payload)
    if resp.status_code != 200:
        return [T(type="text", text=f"Nanoparticle build failed ({resp.status_code}): {resp.text[:400]}")]
    data = resp.json()
    new_struct = data.get("structure")
    if not new_struct:
        return [T(type="text", text=f"Nanoparticle build returned no structure. Response: {json.dumps(data)[:400]}")]
    push_err = await _push_structure(client, new_struct, intent="load")
    msg = data.get("message") or f"Nanoparticle built: {data.get('n_atoms', '?')} atoms."
    msg += " Viewer updated."
    if push_err:
        msg += f"\n⚠️ Viewer push failed: {push_err}"
    return [T(type="text", text=msg)]


async def _handle_moire(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Build / search a twisted (moiré) bilayer from a 2D sheet.

    Routes:
      - build  → /moire/build  (snap to nearest commensurate angle, push to viewer)
      - search → /moire/search (enumerate commensurate twist angles)

    Robustness (mirrors heterostructure build_match):
      - layer_a defaults to the viewer; layer_b defaults to layer_a (homobilayer).
      - For build, the backend needs a full MoireCandidate (angle, m, n, p, q,
        m2..q2, mismatch, area_ratio). The LLM can't construct that, so given a
        target `angle` we re-run /search internally and snap to the nearest
        commensurate candidate. A pre-fetched `candidate` dict is used directly.
    """
    T = TextContent
    action = (args.get("action") or "build").lower()

    layer_a = await _resolve_layer(client, args.get("layer_a"), role="layer_a")
    if isinstance(layer_a, str):
        return [T(type="text", text=layer_a)]
    layer_b = None
    if args.get("layer_b") is not None:
        layer_b = await _resolve_layer(client, args.get("layer_b"), role="layer_b")
        if isinstance(layer_b, str):
            return [T(type="text", text=layer_b)]

    def _search_payload(angle_min: float, angle_max: float, max_index: int) -> dict:
        p = {
            "layer_a": layer_a,
            "params": {
                "angle_min": float(angle_min),
                "angle_max": float(angle_max),
                "max_index": int(max_index),
            },
        }
        if layer_b is not None:
            p["layer_b"] = layer_b
        return p

    if action == "search":
        payload = _search_payload(
            args.get("angle_min", 0.0), args.get("angle_max", 30.0), args.get("max_index", 6),
        )
        resp = await client.post(f"{API_BASE}/moire/search", json=payload)
        if resp.status_code != 200:
            return [T(type="text", text=f"Moiré search failed ({resp.status_code}): {resp.text[:400]}")]
        cands = resp.json().get("candidates") or []
        if not cands:
            return [T(type="text", text="No commensurate angles found in range. Try widening angle_min/angle_max or raising max_index.")]
        # Sort by atom count so the user sees the cheapest cells first.
        cands = sorted(cands, key=lambda c: c.get("n_atoms", 1e9))
        lines = [f"Found {len(cands)} commensurate twist angles (smaller cell = cheaper):"]
        for c in cands[:12]:
            lines.append(
                f"  angle={c.get('angle'):.2f}°  n_atoms≈{c.get('n_atoms')}  "
                f"mismatch={c.get('mismatch', 0):.4f} Å  area_ratio={c.get('area_ratio', 0):.1f}"
            )
        lines.append("\nCall action=build with `angle` to construct the bilayer at the nearest angle.")
        return [T(type="text", text="\n".join(lines))]

    if action != "build":
        return [T(type="text", text=f"Unknown moiré action: {action!r}. Valid: build, search.")]

    build_params = {
        "translate_z": float(args.get("translate_z", 3.35)),
        "vacuum": float(args.get("vacuum", 15.0)),
    }

    # Prefer an explicitly-provided full candidate; else snap to nearest angle.
    candidate = args.get("candidate")
    if not (isinstance(candidate, dict) and candidate.get("angle") is not None and "m" in candidate):
        target = args.get("angle")
        if target is None:
            return [T(type="text", text="action=build needs a target `angle` (degrees), or a full `candidate` from a prior search.")]
        target = float(target)
        # Search a window around the target so we find a nearby commensurate angle.
        win = max(3.0, target * 0.5)
        a_min = max(0.0, target - win)
        a_max = min(60.0, target + win)
        sresp = await client.post(
            f"{API_BASE}/moire/search",
            json=_search_payload(a_min, a_max, args.get("max_index", 8)),
        )
        if sresp.status_code != 200:
            return [T(type="text", text=f"Could not search for angle {target}° ({sresp.status_code}): {sresp.text[:300]}")]
        cands = sresp.json().get("candidates") or []
        if not cands:
            return [T(type="text", text=f"No commensurate angle found near {target}°. Try a different angle or raise max_index (slower).")]
        candidate = min(cands, key=lambda c: abs(c.get("angle", 1e9) - target))

    payload = {"layer_a": layer_a, "candidate": candidate, "params": build_params}
    if layer_b is not None:
        payload["layer_b"] = layer_b
    resp = await client.post(f"{API_BASE}/moire/build", json=payload)
    if resp.status_code != 200:
        return [T(type="text", text=f"Moiré build failed ({resp.status_code}): {resp.text[:400]}")]
    data = resp.json()
    new_struct = data.get("structure")
    if not new_struct:
        return [T(type="text", text=f"Moiré build returned no structure. Response: {json.dumps(data)[:400]}")]
    push_err = await _push_structure(client, new_struct, intent="load")
    achieved = data.get("angle", candidate.get("angle"))
    msg = data.get("message") or f"Moiré bilayer built: {data.get('n_atoms', '?')} atoms at {achieved}°."
    requested = args.get("angle")
    if requested is not None and isinstance(achieved, (int, float)) and abs(float(achieved) - float(requested)) > 0.05:
        msg += f" (snapped to nearest commensurate angle {achieved:.2f}° from requested {float(requested):.2f}°.)"
    msg += " Viewer updated."
    if push_err:
        msg += f"\n⚠️ Viewer push failed: {push_err}"
    return [T(type="text", text=msg)]


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
            elif name == "catgo_pane":
                return await _handle_pane(client, arguments)
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
            elif name == "catgo_validate_config":
                return await _handle_validate_config(client, arguments)
            elif name == "catgo_quickbuild":
                return await _handle_quickbuild(client, arguments)
            elif name == "catgo_heterostructure":
                return await _handle_heterostructure(client, arguments)
            elif name == "catgo_nanotube":
                return await _handle_nanotube(client, arguments)
            elif name == "catgo_moire":
                return await _handle_moire(client, arguments)
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

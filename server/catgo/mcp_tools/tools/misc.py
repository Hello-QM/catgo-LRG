"""Provider Discovery + Database Import + Workflow tools."""

__all__ = ["TOOLS"]

TOOLS: list[dict] = [
    # ─── Provider Discovery ───
    {
        "name": "catgo_providers",
        "description": "List available AI providers (Anthropic, OpenAI, DeepSeek, Ollama, CLI agents, etc.).",
        "endpoint": "/chat/providers",
        "method": "GET",
        "inputSchema": {"type": "object", "properties": {}},
    },

    # ─── Database Import ───
    {
        "name": "catgo_fetch_crystal",
        "description": (
            "Fetch a crystal structure from an online database (OPTIMADE) and load it "
            "into the viewer. Covers Materials Project, Materials Cloud, Alexandria, "
            "2DMatpedia, OMDB — no API key needed. Use for requests like "
            "'load TiO2', 'fetch mp-2657', 'import NaCl from Materials Project'."
        ),
        "endpoint": "__special__/fetch-crystal",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "formula": {
                    "type": "string",
                    "description": "Chemical formula, e.g. 'TiO2', 'Fe2O3', 'NaCl'.",
                },
                "elements": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Element symbols to search, e.g. ['Ti', 'O']. Alternative to formula.",
                },
                "provider": {
                    "type": "string", "default": "mp",
                    "description": "Database: 'mp' (Materials Project), 'mc3d', 'alexandria', 'omdb', 'twodmatpedia'.",
                },
                "structure_id": {
                    "type": "string",
                    "description": "Specific ID for direct fetch, e.g. 'mp-2657'. Skips search.",
                },
            },
        },
    },
    {
        "name": "catgo_search_crystals",
        "description": (
            "Search online crystal databases (OPTIMADE) for structures matching a formula "
            "or element filter. Returns a summary list with IDs — use catgo_fetch_crystal "
            "with a specific structure_id to load one."
        ),
        "endpoint": "__special__/search-crystals",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "formula": {"type": "string", "description": "Chemical formula, e.g. 'TiO2'."},
                "elements": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Elements to search for, e.g. ['Li', 'Fe', 'O'].",
                },
                "provider": {"type": "string", "default": "mp"},
                "limit": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20},
            },
        },
    },
    {
        "name": "catgo_fetch_molecule",
        "description": (
            "Fetch a molecular structure from PubChem by name or formula and load it "
            "into the viewer. Use for molecules: 'load aspirin', 'fetch caffeine', 'import C6H12O6'."
        ),
        "endpoint": "__special__/fetch-molecule",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Compound name (e.g. 'aspirin') or formula (e.g. 'C8H10N4O2').",
                },
                "search_type": {
                    "type": "string", "default": "name",
                    "enum": ["name", "formula", "smiles"],
                    "description": "Search type.",
                },
                "cid": {
                    "type": "integer",
                    "description": "PubChem compound ID for direct fetch. If provided, query is ignored.",
                },
            },
        },
    },
    # ─── Workflow (unified) ───
    {
        "name": "catgo_workflow",
        "description": (
            "Manage CatGO DAG-based computational workflows for multi-step HPC pipelines "
            "(DFT relaxation → analysis → export, etc.). "
            "Do NOT use for simple structure operations (cutting slabs, supercells, doping, "
            "atom editing) — use direct tools instead (catgo_generate_slab, catgo_supercell, "
            "catgo_doping, etc.) which execute instantly. "
            "Actions: list, templates, create, get, add_node, remove_node, "
            "connect, set_params, batch, validate, run, pause, resume, status, step_error, "
            "node_types, node_details, retry, batch_status, batch_results, list_presets. "
            "Use batch to add multiple nodes + edges in a single call for efficiency. "
            "Pass 'action' + relevant params."
        ),
        "endpoint": "__special__/workflow",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list", "templates", "create", "get",
                        "add_node", "remove_node", "connect", "set_params", "batch",
                        "validate", "run", "pause", "resume",
                        "status", "step_error", "node_types", "node_details",
                        "retry", "batch_status", "batch_results", "list_presets",
                    ],
                    "description": (
                        "list: list all workflows. "
                        "templates: available workflow templates. "
                        "create: create workflow (name, template_id?). "
                        "get: get workflow details (workflow_id). "
                        "add_node: add node to workflow (workflow_id, node_type, params?). Multiple structure_input nodes allowed; use params.label to name them. "
                        "remove_node: remove node (workflow_id, node_id). "
                        "connect: connect two nodes (workflow_id, from_id, to_id, from_handle?, to_handle?). "
                        "set_params: set node params (workflow_id, node_id, params). "
                        "batch: add multiple nodes + edges in ONE call (workflow_id, operations[]). "
                        "Each op: {op:'add_node', node_type, label?, params?} | {op:'connect', from_id, to_id, from_handle?, to_handle?} | {op:'set_params', node_id, params} | {op:'remove_node', node_id}. "
                        "Labels from add_node can be used as from_id/to_id in connect ops within the same batch. "
                        "validate: check graph for cycles, missing edges, handle mismatches (workflow_id). "
                        "run: start workflow (workflow_id, run_config?). "
                        "pause: pause workflow (workflow_id). "
                        "resume: resume paused workflow (workflow_id, run_config?). "
                        "status: get run status (workflow_id). "
                        "step_error: get step error (workflow_id, step_id). "
                        "node_types: list available node types (category?). "
                        "node_details: get full schema for a node type — inputs, outputs, default params (node_type). "
                        "retry: reset a step and all downstream to pending (workflow_id, step_id). "
                        "batch_status: get batch job summary for a batch node (workflow_id, step_id). "
                        "batch_results: get paginated batch subtask results (workflow_id, step_id, page?). "
                        "list_presets: list available VASP calculation presets."
                    ),
                },
                "workflow_id": {"type": "string", "description": "Workflow ID."},
                "name": {"type": "string", "description": "Workflow name (for create)."},
                "template_id": {"type": "string", "description": "Template ID (for create)."},
                "material_ids": {"type": "array", "items": {"type": "string"}, "description": "List of Materials Project IDs for create (e.g. ['mp-825', 'mp-1008677']). Creates one structure_input per material. If omitted, captures viewer structure."},
                "node_type": {"type": "string", "description": "Node type (for add_node). e.g. geo_opt, single_point, structure_input, md, slab_gen."},
                "node_id": {"type": "string", "description": "Node ID (for remove_node, set_params)."},
                "from_id": {"type": "string", "description": "Source node ID (for connect)."},
                "to_id": {"type": "string", "description": "Target node ID (for connect)."},
                "from_handle": {"type": "string", "description": "Source output handle (default: structure)."},
                "to_handle": {"type": "string", "description": "Target input handle (default: structure)."},
                "step_id": {"type": "string", "description": "Step ID (for step_error, retry, batch_status, batch_results)."},
                "page": {"type": "integer", "default": 1, "description": "Page number for batch_results (default 1)."},
                "params": {"type": "object", "description": "Node parameters (for set_params, add_node). For structure_input: pass mp_id (e.g. 'mp-825') to fetch a specific material instead of capturing the viewer."},
                "category": {"type": "string", "description": "Filter category (for node_types)."},
                "run_config": {"type": "object", "description": "HPC run config (for run). Accepts hpc_session_id/default_session_id, queue/partition, nodes, ppn/cpus_per_task, ntasks, walltime, memory, account, modules/module_loads, env_commands/python_env."},
                "operations": {
                    "type": "array",
                    "description": "Array of operations for batch action.",
                    "items": {"type": "object"},
                },
            },
        },
    },
]

# Tool-First Architecture Design

**Date:** 2026-03-11
**Status:** Approved
**Scope:** Unified tool system replacing the fragmented plugin architecture

## Problem

CatGo has a fragmented plugin system with multiple overlapping subsystems:

1. **5 base classes** (`CalculatorPlugin`, `OptimizerPlugin`, `ReaderPlugin`, `AnalyzerPlugin`, `WorkflowNodePlugin`) — each with different interfaces, registration, and discovery paths
2. **Separate MCP hot-reload** (`plugin_loader.py`) — standalone `.py` files in `~/.catgo/plugins/`, uses `TOOL_DEF` + `handle(arguments, client, api_base)` format, disconnected from PluginManager
3. **Broken ToolPlugin** (`tool_builder.py`) — AI code generation code exists but imports `ToolPlugin` from `base.py` where it was never defined, so the entire module fails at import time. This is a clean-slate implementation, not a fix.
4. **Frontend plugin system** (`src/lib/plugins/`) — fully separate IndexedDB + Blob URL system with its own manager

Writing a simple analysis tool requires: inheriting a base class, setting 7+ class attributes, writing a manifest, placing files in the right directory. This is too heavy for AI generation and too fragmented for maintenance.

## Goals

1. **Unified abstraction**: One `Tool` concept replaces all plugin types
2. **AI-first**: CatBot can generate a complete tool from a single Python file (TOOL dict + execute function)
3. **Automatic lifecycle**: Generate → audit → sandbox test → execute → ask save → ask upgrade → ask frontend UI
4. **Tiered security**: builtin (full trust), user (declared permissions), sandboxed (whitelist-only)
5. **Frontend auto-rendering**: 90% of tools need zero frontend code — `output_type` drives rendering
6. **Backward compatible**: Existing plugins migrate with minimal changes; compatibility layer for transition

## Non-Goals

- Replacing the existing built-in MCP tools (catgo_structure, catgo_analyze, etc.) — these remain as-is
- Full containerization/Docker sandboxing — subprocess isolation is sufficient
- Plugin marketplace or remote registry

---

## Architecture

### Core Abstraction: Everything is a Tool

A tool is defined by a `TOOL` dict and an `execute` function. No base classes, no inheritance.

**Unified `execute()` signature:**

All tools use the same signature: `async def execute(context: dict) -> dict`. The `context` dict contains different fields depending on category:

| Category | `context` contents |
|---|---|
| `general` | `{"structure": pymatgen_dict_or_None, "params": {...}}` |
| `reader` | `{"file_paths": [...], "params": {...}}` |
| `calculator` | `{"structure": pymatgen_dict, "params": {...}}` |
| `optimizer` | `{"structure": pymatgen_dict, "params": {...}}` |
| `workflow_node` | `{"structure": pymatgen_dict, "params": {...}, "config": {...}}` |

For general tools, `structure` is auto-injected from the viewer if available, or `None` if the tool doesn't need it. The tool decides whether to use it.

**Minimal tool (what CatBot generates):**

```python
TOOL = {
    "name": "rdf_analysis",
    "description": "Compute radial distribution function",
    "input_schema": {
        "type": "object",
        "properties": {
            "r_max": {"type": "number", "default": 10.0},
            "n_bins": {"type": "integer", "default": 100},
        },
    },
    "output_type": "scatter_plot",
}

async def execute(context):
    from pymatgen.core import Structure
    structure = context["structure"]
    params = context.get("params", {})
    struct = Structure.from_dict(structure) if isinstance(structure, dict) else structure
    r_max = params.get("r_max", 10.0)
    n_bins = params.get("n_bins", 100)
    # ... compute RDF ...
    return {
        "series": [{"x": r_values.tolist(), "y": g_r.tolist(), "label": "g(r)"}],
        "x_axis": {"label": "r (Angstrom)"},
        "y_axis": {"label": "g(r)"},
    }
```

**`output_type` determines frontend rendering:**

| output_type | Frontend Component | Notes |
|---|---|---|
| `scatter_plot` | ScatterPlot | Standard data format: `{series, x_axis, y_axis}` |
| `bar_plot` | BarPlot | Same series format |
| `table` | DataTable | `{columns, rows}` |
| `text` | Markdown renderer | `{content: "..."}` |
| `image` | Base64 image | `{data: "...", mime: "image/png"}` |
| `structure` | Push to 3D viewer | pymatgen Structure dict |
| `atom_property` | Map to atom colors via `applyAtomColorsHooks` + push | `{values: [...], colormap?: "..."}` — requires special handling in StructureScene, not ToolResultRenderer |
| `trajectory` | Trajectory player | List of structure frames |
| `electronic_dos` | Create server-side VaspData session → return `session_id` → DosPlot | See "Reader Pipeline Integration" section below |
| `electronic_bands` | Create server-side session → BandPlot | Same session pattern |
| `cohp` | Create server-side session → CohpPlot | Same session pattern |

**`output_type` validation:** The registry validates `output_type` against a known set of values at registration time. Unknown types produce a warning but do not block registration (forward compatibility).

### Specialized Tools (Categories)

The `category` field enables specialized behavior. Default is `"general"`.

**Calculator tool** — adds `get_calculator()`:

```python
TOOL = {
    "name": "lennard_jones",
    "description": "LJ pair potential",
    "category": "calculator",
    "supported_elements": ["Ar", "Kr", "Xe"],
    "input_schema": {
        "type": "object",
        "properties": {
            "cutoff": {"type": "number", "default": 10.0},
        },
    },
}

def get_calculator(**params):
    """Return ASE Calculator instance. Called by optimize.py, NOT by registry.call()."""
    from ase.calculators.lj import LennardJones
    return LennardJones(rc=params.get("cutoff", 10.0))

async def execute(context):
    """Optional. If present, can be called directly via MCP/REST to compute single-point energy."""
    calc = get_calculator(**context.get("params", {}))
    from pymatgen.core import Structure
    from pymatgen.io.ase import AseAtomsAdaptor
    struct = Structure.from_dict(context["structure"])
    atoms = AseAtomsAdaptor.get_atoms(struct)
    atoms.calc = calc
    energy = atoms.get_potential_energy()
    return {"content": f"Energy: {energy:.4f} eV"}
```

**How calculator dispatch works:**
- `registry.call("lennard_jones", ...)` → calls `execute_fn` if present, returning a `ToolResult`
- `registry.get_calculator("lennard_jones", **params)` → calls `extra_fns["get_calculator"](**params)`, returning an ASE Calculator object
- `optimize.py` uses `registry.get_calculator()` (not `registry.call()`), preserving the existing ASE integration

**Optimizer tool** — adds `get_optimizer()`:

```python
TOOL = {
    "name": "custom_bfgs",
    "description": "Custom BFGS optimizer with line search",
    "category": "optimizer",
    "supports_cell_optimization": False,
    "input_schema": {
        "type": "object",
        "properties": {
            "fmax": {"type": "number", "default": 0.05},
        },
    },
}

def get_optimizer(atoms, **params):
    """Return ASE Optimizer instance. Called by optimize.py."""
    from ase.optimize import BFGS
    return BFGS(atoms, maxstep=params.get("maxstep", 0.2))
```

**Reader tool** — `execute` receives file paths via `context["file_paths"]`:

```python
TOOL = {
    "name": "cp2k_dos",
    "description": "Read CP2K .pdos files",
    "category": "reader",
    "supported_formats": [".pdos"],
    "output_type": "electronic_dos",
    "multi_file": True,
}

async def execute(context):
    file_paths = context["file_paths"]
    params = context.get("params", {})
    # Parse .pdos files, return VaspData-compatible dict
    return {"eigenvalues": ..., "efermi": ..., ...}

def detect_files(filenames):
    """Optional. Return True if this reader can handle these files. Used for auto-detection."""
    return any(fn.lower().endswith(".pdos") for fn in filenames)

def priority_score(filenames):
    """Optional. Higher = preferred when multiple readers match. Default 0."""
    return 20 if any(fn.lower().endswith(".pdos") for fn in filenames) else 0
```

**Workflow node tool** — adds `node_definition`:

```python
TOOL = {
    "name": "lammps_nvt",
    "description": "Run NVT MD using LAMMPS",
    "category": "workflow_node",
    "node_definition": {
        "type": "lammps_nvt",
        "label": "LAMMPS NVT",
        "color": "#22c55e",
        "icon": "runner",
        "category": "Plugin",
        "inputs": ["structure"],
        "outputs": ["structure", "trajectory"],
        "param_schema": [...],
    },
}

async def execute(context):
    structure = context["structure"]
    params = context.get("params", {})
    config = context.get("config", {})
    # Run LAMMPS simulation
    return {"structure_json": ..., "trajectory": ...}
```

### Unified Registry: ToolRegistry

Single registry replaces `PluginManager` + `plugin_loader.py`.

```python
@dataclass
class ToolResult:
    """Result of a tool execution."""
    data: dict                       # Output data
    output_type: str                 # How to render (scatter_plot, table, etc.)
    tool_id: str                     # Which tool produced this
    error: str | None = None         # Error message if failed
    traceback: str | None = None     # Stack trace for debugging (sandboxed tools only)
    session_id: str | None = None    # For reader pipelines (DOS/bands sessions)
```

```python
@dataclass
class ToolEntry:
    # Identity
    id: str                          # Unique ID, also used as directory name. Same as TOOL["name"].
    name: str                        # Human-readable display name. Defaults to id if not specified.
    description: str
    version: str = "1.0.0"
    author: str = ""

    # Behavior
    category: str = "general"        # general | calculator | reader | optimizer | workflow_node
    input_schema: dict = field(default_factory=dict)
    output_type: str = "text"

    # Trust
    trust: str = "sandboxed"         # builtin | user | sandboxed
    permissions: list[str] = field(default_factory=list)

    # Source
    source: str = "code"             # code | ai | directory
    path: Path | None = None
    ephemeral: bool = False

    # Callables
    execute_fn: Callable | None = None
    extra_fns: dict[str, Callable] = field(default_factory=dict)
    # extra_fns keys by category:
    #   calculator: {"get_calculator": fn}
    #   optimizer:  {"get_optimizer": fn}
    #   reader:     {"detect_files": fn, "priority_score": fn}  (both optional)

    # Optional frontend
    frontend: dict | None = None

    # Category-specific fields (flat, no subclasses)
    supported_elements: list[str] | None = None    # calculator
    supported_formats: list[str] | None = None     # reader
    multi_file: bool = False                        # reader
    node_definition: dict | None = None             # workflow_node
    supports_cell_optimization: bool = False        # optimizer

    # State
    enabled: bool = True                            # Toggle via registry.enable/disable

    # Lifecycle hooks (optional)
    on_load_fn: Callable | None = None              # async def on_load() — called on register
    on_unload_fn: Callable | None = None            # async def on_unload() — called on unregister
```

**`id` vs `name` clarification:** `id` is the unique identifier used for registration, file paths, and API calls (e.g., `"rdf_analysis"`). It must be a valid identifier: lowercase, no spaces, only `[a-z0-9_-]`. `name` is the human-readable display name (e.g., `"RDF Analysis"`). When loading from a TOOL dict, `id = TOOL["name"]` and `name = TOOL.get("display_name", TOOL["name"])`. The registry validates `id` format at registration time and rejects invalid identifiers. This matches the existing pattern where `analyzer_id` and `display_name` were separate fields.

```python
class ToolRegistry:
    """Singleton — the one registry for all tools."""

    # Core
    def register(self, tool: ToolEntry) -> None
    def unregister(self, tool_id: str) -> None

    # Query
    def get(self, tool_id: str) -> ToolEntry | None
    def list_all(self) -> list[ToolEntry]
    def list_by_category(self, category: str) -> list[ToolEntry]

    # Execution
    async def call(self, tool_id: str, arguments: dict) -> ToolResult
    #   arguments = {"structure": ..., "params": ..., "file_paths": ..., "config": ...}
    #   Assembled into context dict based on category, then passed to execute_fn

    # AI generation
    async def create_from_code(self, code: str, test_input: dict = None) -> ToolResult
    #   Returns result keyed by a session-scoped ephemeral_id for later save

    # Persistence
    async def save(self, ephemeral_id: str, save_as: str = None) -> ToolEntry
    #   ephemeral_id from create_from_code, not global "last created"
    def upgrade_trust(self, tool_id: str, trust: str) -> None
    async def delete(self, tool_id: str) -> bool

    # Discovery
    async def discover(self) -> None  # Scan plugins/ + ~/.catgo/tools/

    # Category-specific accessors (for optimize.py, reader routing, etc.)
    def get_calculator(self, tool_id: str, **params) -> "ASE Calculator"
    def get_optimizer(self, tool_id: str, atoms, **params) -> "ASE Optimizer"
    def find_reader_for_files(self, filenames: list[str]) -> ToolEntry | None
    def get_all_workflow_node_definitions(self) -> list[dict]

    # Enable/disable
    def enable(self, tool_id: str) -> None
    def disable(self, tool_id: str) -> None
```

**Execution dispatch:**

```
registry.call(tool_id, arguments)
    |
    +-- Build context dict from arguments + category conventions
    |     general:       {"structure": auto_inject_or_arg, "params": arguments}
    |     reader:        {"file_paths": arguments["file_paths"], "params": arguments}
    |     calculator:    {"structure": arguments["structure"], "params": arguments}
    |     workflow_node: {"structure": arguments["structure"], "params": ..., "config": ...}
    |
    +-- trust == "sandboxed"  --> sandbox.execute_in_sandbox(code, context)
    +-- trust == "user"       --> check permissions --> execute_fn(context)
    +-- trust == "builtin"    --> execute_fn(context)
    |
    +-- Post-process by output_type:
    |     electronic_dos/bands/cohp → create VaspData session → add session_id to result
    |     structure → auto-push to viewer
    |     atom_property → push property data to viewer
    |
    v
ToolResult { data, output_type, tool_id, error?, session_id? }
```

### Reader Pipeline Integration

Reader tools with `output_type` in `("electronic_dos", "electronic_bands", "cohp")` require server-side session management. This replicates the existing `routers/plugins.py` → `_create_dos_session_from_reader()` logic.

**Flow:**

```
Reader tool execute() returns raw data (eigenvalues, projectors, etc.)
    |
    v
registry.call() post-processing:
    if output_type == "electronic_dos":
        session = create_vasp_data_session(raw_data)  # VaspData + 30min TTL
        result.session_id = session.id
        result.data = {"session_id": session.id, "nions": ..., "elements": ...}
    |
    v
Frontend receives session_id → uses existing DOS/bands API to compute PDOS groups
```

This keeps the existing VaspData session pipeline intact. The only change is entry point: `routers/tools.py` calls the same session-creation functions that `routers/plugins.py` currently does.

### CatBot Generation Flow

```
User: "帮我算RDF"
    |
    v
CatBot calls MCP tool: catgo_create_tool { code: "...", test_input: {...} }
    |
    v
Step 1: audit_code() — AST scan for forbidden imports/calls
    | fail --> return error, CatBot auto-fixes and retries
    v
Step 2: verify TOOL dict format + execute() function signature
    | - TOOL must have "name", "description", "input_schema", "output_type"
    | - execute(context) must exist with correct signature
    | fail --> return error with details
    v
Step 3: execute_in_sandbox(code, context)
    | - subprocess isolation, 30s timeout
    | - auto-inject current viewer structure into context
    | - validate return value matches output_type format
    | fail --> return error + stderr, CatBot retries
    v
Step 4: Return ToolResult + ephemeral_id to CatBot
    |
    v
CatBot shows result to user, then asks:
    "要保存吗？" --> catgo_save_tool(ephemeral_id=...) --> saved as sandboxed
    "要升级权限吗？" --> catgo_upgrade_tool --> trust: "user"
    "要前端UI吗？" --> CatBot generates Svelte component + catgo_save_tool with frontend
```

**Note on sandbox and `async def`:** Sandboxed tools define `async def execute(context)` but the sandbox runner calls them synchronously via `asyncio.run()`. The `asyncio` module is allowed internally by the sandbox runner script (not by the tool code). Tool code itself cannot import `asyncio` — it is on the forbidden list. The runner script handles the async-to-sync bridge.

**MCP tools for the lifecycle:**

| Tool | Purpose |
|---|---|
| `catgo_create_tool` | Generate + audit + sandbox test + execute + return result + ephemeral_id |
| `catgo_save_tool` | Persist by ephemeral_id to `~/.catgo/tools/` (session-scoped, not global "last") |
| `catgo_upgrade_tool` | Upgrade trust level: sandboxed -> user |
| `catgo_delete_tool` | Delete a saved tool |
| `catgo_list_tools` | List all registered tools with metadata |

**`catgo_create_tool` schema:**

```json
{
    "name": "catgo_create_tool",
    "description": "Create and execute a tool from Python code",
    "inputSchema": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "Python source with TOOL dict + async def execute(context) function"
            },
            "test_input": {
                "type": "object",
                "description": "Test parameters (structure auto-injected from viewer)"
            }
        },
        "required": ["code"]
    }
}
```

**`catgo_save_tool` schema:**

```json
{
    "name": "catgo_save_tool",
    "description": "Save a recently created tool permanently",
    "inputSchema": {
        "type": "object",
        "properties": {
            "ephemeral_id": {
                "type": "string",
                "description": "ID returned by catgo_create_tool"
            },
            "save_as": {
                "type": "string",
                "description": "Override tool ID (defaults to TOOL.name)"
            }
        },
        "required": ["ephemeral_id"]
    }
}
```

**`catgo_upgrade_tool` schema:**

```json
{
    "name": "catgo_upgrade_tool",
    "description": "Upgrade a saved tool's trust level",
    "inputSchema": {
        "type": "object",
        "properties": {
            "tool_id": {"type": "string"},
            "trust": {"type": "string", "enum": ["user"]}
        },
        "required": ["tool_id"]
    }
}
```

### Security Model: Tiered Trust

**Three trust levels:**

| Level | Source | Audit | Permissions | Sandbox |
|---|---|---|---|---|
| `builtin` | Code in `server/` | None (dev responsibility) | Unlimited | No |
| `user` | User-installed or upgraded | No AST audit | Declared in manifest, confirmed by user | No |
| `sandboxed` | AI-generated | AST scan + subprocess isolation | Whitelist only | Yes, 30s timeout |

**Sandboxed whitelist:**

- stdlib: `math`, `cmath`, `itertools`, `collections`, `functools`, `operator`, `copy`, `json`, `re`, `typing`
- science: `numpy`, `scipy`, `pymatgen`, `ase`
- forbidden: `os`, `sys`, `subprocess`, `socket`, `requests`, `pathlib`, `io`, `pickle`, `threading`, `asyncio`, etc.

**Trust upgrade path:**

```
AI-generated (sandboxed) --> user saves --> still sandboxed
                                  |
                            user requests upgrade
                                  |
                                  v
                            trust: "user" (immediate)
```

Saved tools default to `sandboxed`. Upgrade to `user` only via explicit `catgo_upgrade_tool` call. CatBot cannot upgrade trust without user consent.

### Frontend Integration

**Automatic rendering (90% of tools):**

Tools return `ToolResult { data, output_type }`. A `ToolResultRenderer.svelte` component switches on `output_type` and renders the appropriate visualization component. No frontend code needed from the tool author.

```svelte
<!-- ToolResultRenderer.svelte -->
{#if result.error}
    <ErrorDisplay message={result.error} traceback={result.traceback} />
{:else if result.output_type === 'scatter_plot'}
    <ScatterPlot data={result.data} />
{:else if result.output_type === 'bar_plot'}
    <BarPlot data={result.data} />
{:else if result.output_type === 'table'}
    <DataTable columns={result.data.columns} rows={result.data.rows} />
{:else if result.output_type === 'text'}
    <Markdown content={result.data.content} />
{:else if result.output_type === 'image'}
    <img src={`data:${result.data.mime};base64,${result.data.data}`} alt="Tool output" />
{:else if result.output_type === 'electronic_dos'}
    <DosPlot sessionId={result.session_id} />
{:else}
    <pre>{JSON.stringify(result.data, null, 2)}</pre>
{/if}
```

**`atom_property` special handling:** This output type does not render in `ToolResultRenderer`. Instead, when `registry.call()` returns `output_type === "atom_property"`, the result data `{values: number[], colormap?: string}` is pushed to the 3D viewer via the existing atom coloring pipeline (similar to `applyAtomColorsHooks`). The chat message shows a text confirmation ("Applied charge coloring to N atoms").

**Custom frontend (10% of tools):**

Tools that need custom UI add a `catgo-tool.json` manifest with frontend declarations:

```json
{
    "name": "charge-coloring",
    "version": "1.0.0",
    "trust": "user",
    "tools": [{
        "name": "compute_charges",
        "output_type": "atom_property"
    }],
    "frontend": {
        "main": "index.js",
        "styles": "styles.css",
        "contributions": {
            "views": [{
                "id": "charge-panel",
                "name": "Charge Coloring",
                "location": "sidebar",
                "component": "ChargePanel"
            }],
            "structureHooks": [{
                "hook": "atomColors",
                "handler": "colorByCharge",
                "priority": 10
            }]
        }
    }
}
```

Frontend plugins use the existing `pluginManager` infrastructure (IndexedDB persistence, Blob URL loading, dynamic import). **Manifest compatibility:** The frontend loader accepts both `catgo-plugin.json` (legacy) and `catgo-tool.json` (new). During the transition period both are supported; eventually `catgo-plugin.json` will be deprecated.

**Frontend contribution types (unchanged from current system):**

- `views` — Custom panels in main/sidebar/modal
- `panels` — Sidebar panels for structure/analysis/workflow
- `structureHooks` — atomColors, atomRadii, bondFilter, sceneOverlay, contextMenu, selection
- `commands` — Keyboard shortcuts

### Disk Layout

```
~/.catgo/tools/                  # AI-generated + user-saved tools
    rdf_analysis/
        tool.py                  # TOOL dict + execute()
    charge_coloring/
        tool.py                  # Backend logic
        index.js                 # Frontend component (optional)
        styles.css               # Styles (optional)
        catgo-tool.json          # Manifest (optional, overrides TOOL dict)

plugins/                         # Project-bundled tools (git-tracked)
    bond-histogram/
        tool.py
    cp2k-dos-reader/
        tool.py
    lennard-jones-calculator/
        tool.py
    lammps-workflow/
        tool.py
```

**Discovery order:** `plugins/` (project) → `~/.catgo/tools/` (user). Conflict resolution: tools are keyed by `id` (= `TOOL["name"]`). If a user tool has the same `id` as a project tool, the user tool takes precedence (later wins). A warning is logged.

### REST API

| Endpoint | Method | Purpose |
|---|---|---|
| `/tools` | GET | List all tools |
| `/tools/{id}` | GET | Get tool details |
| `/tools/{id}/run` | POST | Execute a tool |
| `/tools/{id}/enable` | POST | Enable a tool |
| `/tools/{id}/disable` | POST | Disable a tool |
| `/tools/create` | POST | AI generate + execute |
| `/tools/{id}/save` | POST | Persist tool to disk |
| `/tools/{id}/upgrade` | POST | Upgrade trust level (MCP-only in practice; REST requires auth check) |
| `/tools/{id}` | DELETE | Delete tool |
| `/tools/install/upload` | POST | Install tool from ZIP upload |
| `/tools/discover` | POST | Re-scan directories |
| `/tools/calculators` | GET | List calculator-category tools |
| `/tools/readers` | GET | List reader-category tools |
| `/tools/readers/upload` | POST | Upload files to auto-detected reader |

**Security note on `/tools/{id}/upgrade`:** This endpoint only accepts requests from localhost (same-origin). Trust upgrade is designed to be initiated by CatBot via MCP after explicit user consent in the chat conversation. Direct REST calls to upgrade are blocked unless the request originates from the MCP session.

---

## Migration Strategy

### Existing Plugin Migration

| Plugin | Current Base Class | Migration |
|---|---|---|
| `bond-histogram` | `AnalyzerPlugin` | TOOL dict + `execute(context)`, category: general |
| `cp2k-dos-reader` | `ReaderPlugin` | TOOL dict + `execute(context)` + `detect_files()` + `priority_score()`, category: reader |
| `lennard-jones-calculator` | `CalculatorPlugin` | TOOL dict + `get_calculator()` + optional `execute(context)`, category: calculator |
| `lammps-workflow` | `WorkflowNodePlugin` | TOOL dict + `execute(context)` + `node_definition`, category: workflow_node |

### Builtin Readers Migration

`server/plugins/builtin_readers.py` registers 4 built-in readers as `ReaderPlugin` subclasses. These must also be migrated:

| Builtin Reader | Migration |
|---|---|
| `VaspoutH5Reader` | TOOL dict, category: reader, output_type: electronic_dos |
| `ProcarReader` | TOOL dict, category: reader, output_type: electronic_dos |
| `VasprunBandReader` | TOOL dict, category: reader, output_type: electronic_bands |
| `CohpcarReader` | TOOL dict, category: reader, output_type: cohp |

These become `trust: "builtin"` tools in `server/tools/builtin/` (not in the `plugins/` directory).

### MCP Hot-Reload Plugins Migration

Existing `~/.catgo/plugins/*.py` files use a different format (`TOOL_DEF` + `handle(arguments, client, api_base)`). Migration:

```python
# OLD format (plugin_loader.py)
TOOL_DEF = {"name": "my_tool", "inputSchema": {...}}
async def handle(arguments, client, api_base):
    # client = httpx.AsyncClient, api_base = "http://localhost:8000"
    resp = await client.get(f"{api_base}/view/structure/current")
    ...
    return [TextContent(type="text", text="result")]

# NEW format (tool.py)
TOOL = {"name": "my_tool", "input_schema": {...}, "output_type": "text"}
async def execute(context):
    structure = context["structure"]  # auto-injected, no HTTP call needed
    ...
    return {"content": "result"}
```

Key difference: old format makes HTTP calls to the backend; new format receives structure directly via `context`. The `compat.py` layer wraps old-format handlers to bridge the gap during transition.

### Migration Example: bond-histogram

**Before (AnalyzerPlugin, 7 class attributes + inheritance):**

```python
class BondHistogramPlugin(AnalyzerPlugin):
    name = "bond-histogram"
    analyzer_id = "bond_histogram"
    display_name = "Bond Length Histogram"
    description = "Compute distribution of interatomic distances"
    version = "1.0.0"
    author = "CatGo Team"
    output_type = "bar_plot"
    input_schema = {...}

    async def analyze(self, input_data: dict) -> dict:
        struct = Structure.from_dict(input_data["structure"])
        ...
```

**After (TOOL dict + execute function):**

```python
TOOL = {
    "name": "bond_histogram",
    "display_name": "Bond Length Histogram",
    "description": "Compute bond length distribution histogram",
    "input_schema": {
        "type": "object",
        "properties": {
            "r_max": {"type": "number", "default": 4.0},
            "n_bins": {"type": "integer", "default": 30},
        },
    },
    "output_type": "bar_plot",
    "version": "1.0.0",
    "author": "CatGo Team",
}

async def execute(context):
    from pymatgen.core import Structure
    struct = Structure.from_dict(context["structure"])
    params = context.get("params", {})
    ...
    return {"series": [...], "x_axis": {...}, "y_axis": {...}}
```

### Compatibility Layer

During transition, `server/tools/compat.py` auto-converts old-format plugins:

```python
from server.plugins.base import (
    BasePlugin, CalculatorPlugin, OptimizerPlugin,
    ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin,
)

_CATEGORY_MAP = {
    CalculatorPlugin: "calculator",
    OptimizerPlugin: "optimizer",
    ReaderPlugin: "reader",
    AnalyzerPlugin: "general",       # analyzers map to general category
    WorkflowNodePlugin: "workflow_node",
}

_EXECUTE_METHOD_MAP = {
    AnalyzerPlugin: "analyze",
    ReaderPlugin: "read",
    WorkflowNodePlugin: "execute",
}

def load_legacy_plugin(path: Path) -> ToolEntry:
    """Convert BasePlugin subclass to ToolEntry."""
    module = import_module(path)
    plugin_class = find_subclass_of(BasePlugin, module)
    plugin = plugin_class()

    category = "general"
    for base_cls, cat in _CATEGORY_MAP.items():
        if isinstance(plugin, base_cls):
            category = cat
            break

    # Map the appropriate method to execute_fn
    execute_method_name = _EXECUTE_METHOD_MAP.get(type(plugin).__mro__[1], "execute")
    execute_method = getattr(plugin, execute_method_name, None)

    extra_fns = {}
    if hasattr(plugin, "get_calculator"):
        extra_fns["get_calculator"] = plugin.get_calculator
    if hasattr(plugin, "get_optimizer"):
        extra_fns["get_optimizer"] = plugin.get_optimizer
    if hasattr(plugin, "detect_files"):
        extra_fns["detect_files"] = plugin.detect_files
    if hasattr(plugin, "priority_score"):
        extra_fns["priority_score"] = plugin.priority_score

    return ToolEntry(
        id=getattr(plugin, "analyzer_id", None) or getattr(plugin, "reader_id", None)
           or getattr(plugin, "calculator_id", None) or plugin.name,
        name=plugin.display_name,
        description=plugin.description,
        version=plugin.version,
        author=plugin.author,
        category=category,
        input_schema=getattr(plugin, "input_schema", {}),
        output_type=getattr(plugin, "output_type", "text"),
        trust="builtin",
        execute_fn=_wrap_legacy_execute(execute_method, category),
        extra_fns=extra_fns,
        supported_elements=getattr(plugin, "supported_elements", None),
        supported_formats=getattr(plugin, "supported_formats", None),
        multi_file=getattr(plugin, "multi_file", False),
        node_definition=getattr(plugin, "node_definition", None),
        supports_cell_optimization=getattr(plugin, "supports_cell_optimization", False),
        on_load_fn=plugin.on_load if hasattr(plugin, "on_load") else None,
        on_unload_fn=plugin.on_unload if hasattr(plugin, "on_unload") else None,
    )

def _wrap_legacy_execute(method, category):
    """Wrap old-style method(input_data) to new execute(context)."""
    if method is None:
        return None
    async def wrapped(context):
        if category == "reader":
            return await method(context["file_paths"], context.get("params", {}))
        elif category == "workflow_node":
            import json as _json
            return await method(
                _json.dumps(context.get("structure", {})),
                context.get("params", {}),
                context.get("config", {}),
            )
        else:
            input_data = {"structure": context.get("structure"), **context.get("params", {})}
            return await method(input_data)
    return wrapped
```

Also wraps old MCP hot-reload format:

```python
def load_legacy_mcp_plugin(path: Path) -> ToolEntry:
    """Convert old TOOL_DEF + handle() to ToolEntry."""
    module = import_module(path)
    tool_def = module.TOOL_DEF
    handle_fn = module.handle

    async def wrapped_execute(context):
        # Bridge: old handle(arguments, client, api_base) → new execute(context)
        import httpx
        async with httpx.AsyncClient(timeout=30) as client:
            result = await handle_fn(context.get("params", {}), client, "http://localhost:8000")
            return {"content": result[0].text if result else ""}

    return ToolEntry(
        id=tool_def["name"],
        name=tool_def.get("description", tool_def["name"]),
        description=tool_def.get("description", ""),
        input_schema=tool_def.get("inputSchema", {}),
        output_type="text",
        trust="user",
        execute_fn=wrapped_execute,
    )
```

Remove compatibility layer after all plugins are migrated to the new format.

---

## Files to Create

| File | Responsibility |
|---|---|
| `server/tools/__init__.py` | Exports `registry` singleton |
| `server/tools/registry.py` | `ToolRegistry` + `ToolEntry` + `ToolResult` |
| `server/tools/executor.py` | Unified execution (sandbox/direct dispatch, post-processing by output_type) |
| `server/tools/discovery.py` | Scan `plugins/` + `~/.catgo/tools/`, load TOOL dicts |
| `server/tools/builder.py` | AI code generation + audit + sandbox (refactored from tool_builder.py + sandbox.py) |
| `server/tools/compat.py` | Legacy BasePlugin + MCP hot-reload → ToolEntry converter |
| `server/tools/builtin/` | Migrated builtin readers (vasp, procar, vasprun_band, cohpcar) |
| `server/routers/tools.py` | REST API endpoints |
| `src/lib/tools/ToolResultRenderer.svelte` | Frontend auto-rendering by output_type |

## Files to Modify

| File | Change |
|---|---|
| `server/mcp_tools/server.py` | `list_tools` + `call_tool` delegate to ToolRegistry |
| `server/main.py` | Startup: `await registry.discover()` |
| `src/lib/chat/` | Chat messages integrate ToolResultRenderer |
| `src/lib/plugins/loader.ts` | Accept both `catgo-plugin.json` and `catgo-tool.json` manifest filenames |
| `src/lib/plugins/manager.svelte.ts` | Accept `catgo-tool.json` in ZIP install validation (line 113) |
| `plugins/*/plugin.py` | Migrate to `tool.py` format |

## Files to Delete (after migration complete)

| File | Reason |
|---|---|
| `server/plugin_loader.py` | Merged into ToolRegistry |
| `server/plugins/base.py` | 5 base classes replaced by ToolEntry dataclass |
| `server/plugins/manager.py` | Replaced by ToolRegistry |
| `server/plugins/discovery.py` | Replaced by tools/discovery.py |
| `server/plugins/tool_builder.py` | Replaced by tools/builder.py |
| `server/plugins/sandbox.py` | Merged into tools/builder.py |
| `server/plugins/builtin_readers.py` | Migrated to tools/builtin/ |
| `server/routers/plugins.py` | Replaced by routers/tools.py |

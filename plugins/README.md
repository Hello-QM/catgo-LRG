# CatGo Tools (Plugin Directory)

This directory contains user-installed tools for CatGo, using the **Tool-First** architecture.

## Tool-First Format

Every tool is a directory with a `tool.py` that exports a `TOOL` dict and an `async def execute(context)` function:

```python
# tool.py
TOOL = {
    "name": "my_tool",
    "display_name": "My Tool",
    "description": "What this tool does",
    "category": "general",         # general | calculator | reader | optimizer | workflow_node
    "input_schema": { ... },       # JSON Schema for parameters
    "output_type": "bar_plot",     # text | scatter_plot | bar_plot | table | structure | electronic_dos
    "version": "1.0.0",
    "author": "Your Name",
}

async def execute(context):
    structure = context["structure"]   # pymatgen-compatible dict (auto-injected)
    params = context.get("params", {})
    # ... compute ...
    return {"series": [...], "x_axis": {...}, "y_axis": {...}}
```

## Directory Structure

```
plugins/
  my-tool/
    catgo-tool.json   # Manifest (trust level, permissions)
    tool.py           # TOOL dict + execute(context)
    plugin.py         # Legacy format (auto-adapted via compat.py)
    requirements.txt  # Python dependencies (optional)
```

The discovery system (`server/tools/discovery.py`) scans this directory on startup.
It prefers `tool.py` over `plugin.py` and `catgo-tool.json` over `catgo-plugin.json`.

## Categories

### `general` — Analysis / visualization tools

```python
TOOL = {
    "name": "bond_histogram",
    "category": "general",
    "output_type": "bar_plot",
    "input_schema": {
        "type": "object",
        "properties": {
            "n_bins": {"type": "integer", "default": 30},
        },
    },
}

async def execute(context):
    struct = Structure.from_dict(context["structure"])
    # ... analyze ...
    return {"series": [{"x": [...], "y": [...], "label": "Bonds"}],
            "x_axis": {"label": "Distance"}, "y_axis": {"label": "Count"}}
```

### `calculator` — ASE-compatible calculators

Must also export `get_calculator(**kwargs)` returning an ASE calculator:

```python
TOOL = {
    "name": "lennard_jones",
    "category": "calculator",
    "supported_elements": ["Ar", "Kr", "Xe"],
}

def get_calculator(cutoff=10.0, **kwargs):
    from ase.calculators.lj import LennardJones
    return LennardJones(rc=cutoff)
```

### `reader` — File format readers

Must also export `detect_files(filenames) -> bool` and `priority_score(filenames) -> int`:

```python
TOOL = {
    "name": "cp2k_dos_reader",
    "category": "reader",
    "output_type": "electronic_dos",
    "supported_formats": [".pdos"],
    "multi_file": True,
}

def detect_files(filenames): return any(f.endswith(".pdos") for f in filenames)
def priority_score(filenames): return 20 if detect_files(filenames) else 0
```

### `optimizer` — Structure optimization backends

Same pattern as `calculator`, but the tool drives the optimization loop.

### `workflow_node` — Custom workflow graph nodes

Must include a `node_definition` dict describing inputs, outputs, and UI parameters:

```python
TOOL = {
    "name": "lammps_nvt",
    "category": "workflow_node",
    "node_definition": {
        "type": "lammps_nvt_plugin",
        "label": "LAMMPS NVT",
        "category": "Plugin",
        "inputs": ["structure"],
        "outputs": ["structure", "trajectory"],
        "param_schema": [{"key": "temperature", "type": "number", "default": 300}],
    },
}
```

## Manifest (`catgo-tool.json`)

Optional manifest for trust and permission metadata:

```json
{
  "name": "my_tool",
  "version": "1.0.0",
  "displayName": "My Tool",
  "description": "What this tool does",
  "author": "Your Name",
  "trust": "user",
  "permissions": []
}
```

The manifest overrides matching fields from the `TOOL` dict (e.g., `displayName`, `trust`).

## Trust Levels

| Level | Source | Execution | Example |
|-------|--------|-----------|---------|
| `builtin` | Shipped in `server/tools/builtin/` | Direct in-process call | VASP readers |
| `user` | Installed in `plugins/` with manifest | Direct in-process call | This directory |
| `sandboxed` | AI-generated via `catgo_create_tool` | AST audit + subprocess (30s timeout) | `~/.catgo/tools/` |

Tools in `plugins/` default to `sandboxed` unless `catgo-tool.json` sets `"trust": "user"`.

## Testing

### Via MCP (AI-generated tools)

Use the `catgo_create_tool` MCP tool to generate, test, and save tools:

1. AI writes `TOOL` dict + `execute(context)` code
2. `audit_code()` checks for forbidden imports/calls
3. `execute_in_sandbox()` runs a test in an isolated subprocess
4. On success, saves to `~/.catgo/tools/`
5. Optionally `upgrade_trust()` to promote to `user` level

### Manual testing

Place your tool directory in `plugins/`, restart the server, and call it via the
analysis UI or MCP tools.

## Migration from Legacy Plugins

The old `BasePlugin` subclass format (`CalculatorPlugin`, `ReaderPlugin`, etc. in `plugin.py`)
is auto-adapted via `server/tools/compat.py`. No changes needed -- legacy plugins continue
to work alongside Tool-First tools. However, new tools should use the Tool-First format.

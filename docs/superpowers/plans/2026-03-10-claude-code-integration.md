# Claude Code ↔ CatGO Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable bidirectional Claude Code ↔ CatGO interaction via 5 consolidated MCP tools, a SessionStart hook, and a new `/api/view/state` endpoint.

**Architecture:** A new lightweight MCP entry point (`server_claude_code.py`) consolidates 50+ tools into 5 unified tools with `action` routing. A SessionStart hook auto-detects the CatGO backend. A new FastAPI endpoint provides compact state summaries.

**Tech Stack:** Python 3.11+, FastAPI, MCP SDK (`mcp`), httpx, jq (for hook script)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/routers/view_capture.py` | MODIFY | Add `GET /api/view/state` endpoint |
| `server/mcp_tools/server_claude_code.py` | CREATE | Lightweight MCP server with 5 consolidated tools |
| `server/tests/test_claude_code_mcp.py` | CREATE | Tests for the new MCP server |
| `~/.claude/hooks/catgo-session-start.sh` | CREATE | SessionStart hook script |
| `~/.claude/settings.json` | MODIFY | Add hooks config |
| `~/.claude/mcp.json` | MODIFY | Point to new MCP entry |
| `CLAUDE.md` | MODIFY | Append MCP usage instructions |

---

## Chunk 1: Backend State Endpoint

### Task 1: Add `GET /api/view/state` endpoint

**Files:**
- Modify: `server/routers/view_capture.py:265` (append after last endpoint)

- [ ] **Step 1: Write the endpoint code**

Append to `server/routers/view_capture.py` after line 265 (after `update_selection`):

```python
# ---------------------------------------------------------------------------
# Unified state summary (for Claude Code)
# ---------------------------------------------------------------------------


@router.get("/state")
async def get_view_state():
    """Compact state summary for Claude Code MCP integration.

    Combines structure info, selection, and lattice into a single
    lightweight response (~200 bytes).
    """
    if not _current_structure_dict:
        return {"has_structure": False}

    info = _current_structure_info
    lattice = _current_structure_dict.get("lattice", {})
    sites = _current_structure_dict.get("sites", [])

    return {
        "has_structure": True,
        "formula": info.get("formula", "?") if info else "?",
        "num_sites": info.get("num_sites", len(sites)) if info else len(sites),
        "elements": info.get("elements", []) if info else [],
        "lattice": {
            "a": round(lattice.get("a", 0), 2),
            "b": round(lattice.get("b", 0), 2),
            "c": round(lattice.get("c", 0), 2),
        } if lattice else None,
        "space_group": info.get("space_group") if info else None,
        "selection": {
            "count": len(_current_selection.indices),
            "indices": _current_selection.indices[:20],
        },
    }
```

- [ ] **Step 2: Manually verify the endpoint**

Start backend and test with curl:

```bash
cd /home/james/projects/catgo/CatGO
conda run -n catgo python -m uvicorn server.main:app --port 8000 &
sleep 3
curl -s http://localhost:8000/api/view/state | python -m json.tool
# Expected: {"has_structure": false} (no frontend connected yet)
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add server/routers/view_capture.py
git commit -m "feat(api): add GET /api/view/state for Claude Code integration

Compact endpoint returning structure info, selection, and lattice
in a single ~200 byte response for MCP context injection.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 2: Consolidated MCP Server

### Task 2: Create `server_claude_code.py`

**Files:**
- Create: `server/mcp_tools/server_claude_code.py`

This is the main deliverable. It creates a new MCP server with 5 consolidated tools that route to existing FastAPI endpoints. It reuses helper functions from `server.py` (structure push, summarize, OPTIMADE, etc.) via imports.

- [ ] **Step 1: Create the file with imports and constants**

```python
"""CatGO MCP Server — Claude Code Edition.

Lightweight MCP entry point with 5 consolidated tools (instead of 50+).
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
```

- [ ] **Step 2: Add the 5 tool definitions**

```python
# ---------------------------------------------------------------------------
# Tool Definitions (5 consolidated tools)
# ---------------------------------------------------------------------------

TOOLS = [
    Tool(
        name="catgo_structure",
        description=(
            "Manipulate crystal structures in CatGO viewer. "
            "Actions: get, add_atom, add_atoms, delete, replace, move, "
            "supercell, set_lattice, slab, merge. "
            "Structure is auto-fetched from viewer."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "get", "add_atom", "add_atoms", "delete", "replace",
                        "move", "supercell", "set_lattice", "slab", "merge",
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
                "miller_indices": {
                    "type": "array", "items": {"type": "integer"},
                    "description": "Miller indices [h,k,l] for slab",
                },
                "thickness": {"type": "number", "description": "Slab thickness in layers"},
                "vacuum": {"type": "number", "description": "Vacuum thickness in Angstroms"},
                "structure": {"type": "object", "description": "Incoming structure for merge"},
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
            "Actions: list, templates, node_types, create, get, add_node, "
            "remove_node, connect, set_params, run, pause, status, step_error."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list", "templates", "node_types", "create", "get",
                        "add_node", "remove_node", "connect", "set_params",
                        "run", "pause", "status", "step_error",
                    ],
                    "description": "Workflow operation",
                },
                "workflow_id": {"type": "string"},
                "name": {"type": "string", "description": "Workflow name for create"},
                "template_id": {"type": "string"},
                "node_type": {"type": "string", "description": "Node type for add_node"},
                "node_id": {"type": "string"},
                "from_id": {"type": "string"}, "to_id": {"type": "string"},
                "from_handle": {"type": "string", "default": "structure"},
                "to_handle": {"type": "string", "default": "structure"},
                "params": {"type": "object", "description": "Node params or run config"},
                "step_id": {"type": "string"},
                "category": {"type": "string", "description": "Filter for node_types"},
                "run_config": {"type": "object", "description": "Execution config for run"},
            },
            "required": ["action"],
        },
    ),
    Tool(
        name="catgo_analyze",
        description=(
            "Analyze structures: symmetry, DOS, RDF, optimize, "
            "DFT input (VASP/QE/LAMMPS), adsorption sites, coordination."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "symmetry", "dos", "rdf", "optimize",
                        "dft_input", "adsorption_sites", "coordination",
                    ],
                    "description": "Analysis type",
                },
                "software": {
                    "type": "string", "enum": ["vasp", "qe", "lammps"],
                    "description": "DFT software for dft_input",
                },
                "calc_type": {"type": "string", "description": "Calculation type (relax, static, md)"},
                "model": {"type": "string", "description": "ML model for optimize (MACE, CHGNet)"},
                "fmax": {"type": "number", "description": "Force convergence for optimize"},
                "params": {"type": "object", "description": "Additional analysis parameters"},
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
]
```

- [ ] **Step 3: Add helper functions (reused from full server)**

```python
# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_current_structure(client: httpx.AsyncClient) -> dict | None:
    """Fetch current structure from viewer. Returns None if unavailable."""
    try:
        resp = await client.get(f"{API_BASE}/view/structure/current")
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return None


async def _push_structure(client: httpx.AsyncClient, struct: dict) -> str | None:
    """Push structure to viewer. Returns None on success, error string on failure."""
    try:
        await client.post(f"{API_BASE}/view/structure/push", json={"structure": struct})
        await client.post(f"{API_BASE}/view/structure/pending-update", json={"structure": struct})
        return None
    except Exception as exc:
        return str(exc)


def _summarize(data: dict) -> str:
    """Build concise summary from a structure-modifying response."""
    struct = data.get("structure", {})
    sites = struct.get("sites", [])
    num = data.get("num_sites", len(sites))

    from collections import Counter
    counts = Counter()
    for s in sites:
        el = s.get("label", s.get("species", [{}])[0].get("element", "?"))
        counts[el] += 1
    formula = " ".join(f"{el}{n}" for el, n in sorted(counts.items()))

    parts = [f"Done. {num} atoms ({formula})."]

    lat = struct.get("lattice", {})
    if lat:
        parts.append(f"Cell: a={lat.get('a',0):.2f} b={lat.get('b',0):.2f} c={lat.get('c',0):.2f} Å.")

    for k, v in data.items():
        if k not in ("structure", "num_sites") and isinstance(v, (str, int, float)):
            parts.append(f"{k}: {v}")

    return " ".join(parts)
```

- [ ] **Step 4: Add `list_tools` handler**

```python
# ---------------------------------------------------------------------------
# MCP Handlers
# ---------------------------------------------------------------------------


@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    return TOOLS
```

- [ ] **Step 5: Add the structure action dispatcher**

```python
async def _handle_structure(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_structure actions."""
    action = args.get("action", "")
    T = TextContent

    if action == "get":
        struct = await _get_current_structure(client)
        if not struct:
            return [T(type="text", text="No structure loaded in viewer.")]
        sites = struct.get("sites", [])
        lat = struct.get("lattice", {})
        from collections import Counter
        counts = Counter()
        for s in sites:
            el = s.get("label", s.get("species", [{}])[0].get("element", "?"))
            counts[el] += 1
        formula = " ".join(f"{el}{n}" for el, n in sorted(counts.items()))
        msg = (
            f"Current structure: {len(sites)} atoms ({formula}). "
            f"Cell: a={lat.get('a',0):.2f} b={lat.get('b',0):.2f} c={lat.get('c',0):.2f} Å."
        )
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
            f"Lattice set. a={lat.get('a',0):.2f} b={lat.get('b',0):.2f} "
            f"c={lat.get('c',0):.2f} Å. {data.get('num_sites', '?')} sites."
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

    resp = await client.post(f"{API_BASE}{endpoint}", json=payload)
    if resp.status_code != 200:
        return [T(type="text", text=f"{action} failed ({resp.status_code}): {resp.text[:300]}")]

    data = resp.json()
    result_struct = data.get("structure")
    if not result_struct and "slabs" in data and data["slabs"]:
        result_struct = data["slabs"][0]

    if result_struct:
        push_err = await _push_structure(client, result_struct)
        summary = _summarize({**data, "structure": result_struct} if "structure" not in data else data)
        if push_err:
            summary += f"\n⚠️ Viewer push failed: {push_err}"
        return [T(type="text", text=summary)]

    return [T(type="text", text=json.dumps(data, indent=2, ensure_ascii=False))]
```

- [ ] **Step 6: Add fetch and view action dispatchers**

```python
async def _handle_fetch(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_fetch actions. Delegates to the full server's special handlers."""
    # Import the full server's special tool handler
    from mcp_tools.server import _handle_special_tool

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
    from mcp_tools.server import _handle_special_tool
    return await _handle_special_tool("catgo_workflow", "__special__/workflow", args)


async def _handle_analyze(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Dispatch catgo_analyze actions."""
    action = args.get("action", "")
    T = TextContent

    ROUTES: dict[str, tuple[str, str]] = {
        "symmetry":         ("POST", "/symmetry/analyze"),
        "dos":              ("POST", "/dos/compute"),
        "rdf":              ("POST", "/analysis/rdf"),
        "optimize":         ("POST", "/optimize/run"),
        "dft_input":        ("POST", "/dft-input/generate"),
        "adsorption_sites": ("GET",  "/adsorption/sites"),
        "coordination":     ("POST", "/analysis/coordination"),
    }

    route = ROUTES.get(action)
    if not route:
        valid = ", ".join(ROUTES.keys())
        return [T(type="text", text=f"Unknown analyze action '{action}'. Valid: {valid}")]

    method, endpoint = route
    payload = {k: v for k, v in args.items() if k != "action"}

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
```

- [ ] **Step 7: Add `call_tool` dispatcher and entry point**

```python
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
```

- [ ] **Step 8: Verify the MCP server starts**

```bash
cd /home/james/projects/catgo/CatGO
timeout 5 /home/james/miniforge3/envs/catgo/bin/python server/mcp_tools/server_claude_code.py </dev/null 2>&1 || true
# Expected: exits cleanly (no stdin = no MCP transport). No import errors.
```

- [ ] **Step 9: Commit**

```bash
git add server/mcp_tools/server_claude_code.py
git commit -m "feat(mcp): add consolidated Claude Code MCP server

5 tools (catgo_structure, catgo_fetch, catgo_workflow, catgo_analyze,
catgo_view) replacing 50+ individual tools. Routes to existing FastAPI
endpoints. ~500 tokens instead of ~5000 in Claude Code's context.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 3: Tests

### Task 3: Write tests for the consolidated MCP server

**Files:**
- Create: `server/tests/test_claude_code_mcp.py`

- [ ] **Step 1: Write test file**

```python
"""Tests for the Claude Code consolidated MCP server.

Validates tool definitions, action routing, and schema compliance.
"""

import sys
from pathlib import Path

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)


def _get_tools():
    """Import the TOOLS list from server_claude_code."""
    try:
        from mcp_tools.server_claude_code import TOOLS
        return TOOLS
    except ImportError as e:
        pytest.skip(f"Cannot import server_claude_code: {e}")


class TestClaudeCodeToolDefinitions:
    """Validate the 5 consolidated tools."""

    def test_exactly_5_tools(self):
        tools = _get_tools()
        assert len(tools) == 5, f"Expected 5 tools, got {len(tools)}"

    def test_tool_names(self):
        tools = _get_tools()
        names = {t.name for t in tools}
        expected = {"catgo_structure", "catgo_fetch", "catgo_workflow", "catgo_analyze", "catgo_view"}
        assert names == expected, f"Tool names mismatch: {names}"

    def test_all_tools_have_action_enum(self):
        tools = _get_tools()
        for tool in tools:
            schema = tool.inputSchema
            assert "action" in schema["properties"], f"{tool.name} missing 'action' property"
            assert "enum" in schema["properties"]["action"], f"{tool.name} action missing enum"

    def test_all_tools_require_action(self):
        tools = _get_tools()
        for tool in tools:
            assert "action" in tool.inputSchema.get("required", []), (
                f"{tool.name} does not require 'action'"
            )

    def test_descriptions_are_concise(self):
        """Descriptions should be under 300 chars for token efficiency."""
        tools = _get_tools()
        for tool in tools:
            assert len(tool.description) < 300, (
                f"{tool.name} description is {len(tool.description)} chars (max 300)"
            )

    def test_structure_actions_complete(self):
        tools = _get_tools()
        struct_tool = next(t for t in tools if t.name == "catgo_structure")
        actions = struct_tool.inputSchema["properties"]["action"]["enum"]
        expected = ["get", "add_atom", "add_atoms", "delete", "replace",
                    "move", "supercell", "set_lattice", "slab", "merge"]
        assert actions == expected

    def test_fetch_actions_complete(self):
        tools = _get_tools()
        fetch_tool = next(t for t in tools if t.name == "catgo_fetch")
        actions = fetch_tool.inputSchema["properties"]["action"]["enum"]
        assert set(actions) == {"crystal", "search", "molecule"}

    def test_view_actions_complete(self):
        tools = _get_tools()
        view_tool = next(t for t in tools if t.name == "catgo_view")
        actions = view_tool.inputSchema["properties"]["action"]["enum"]
        assert set(actions) == {"get_state", "selection", "screenshot"}
```

- [ ] **Step 2: Run tests**

```bash
cd /home/james/projects/catgo/CatGO
conda run -n catgo python -m pytest server/tests/test_claude_code_mcp.py -v
# Expected: all tests PASS
```

- [ ] **Step 3: Commit**

```bash
git add server/tests/test_claude_code_mcp.py
git commit -m "test: add tests for Claude Code consolidated MCP server

Validates 5 tools, action enums, schema compliance, and description
conciseness for token efficiency.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 4: Claude Code Configuration (Hooks + MCP + CLAUDE.md)

### Task 4: Create SessionStart hook script

**Files:**
- Create: `~/.claude/hooks/catgo-session-start.sh`

- [ ] **Step 1: Create hooks directory and script**

```bash
mkdir -p ~/.claude/hooks
```

Write `~/.claude/hooks/catgo-session-start.sh`:

```bash
#!/bin/bash
# CatGO SessionStart hook — detect backend and inject one-line status.
# Cost: ~30 tokens, fires once per session.
STATE=$(curl -s --max-time 2 http://localhost:8000/api/view/state 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$STATE" ]; then
  exit 0
fi
HAS=$(echo "$STATE" | jq -r '.has_structure // false')
if [ "$HAS" = "true" ]; then
  FORMULA=$(echo "$STATE" | jq -r '.formula // "?"')
  NSITES=$(echo "$STATE" | jq -r '.num_sites // 0')
  echo "{\"additionalContext\": \"[CatGO] Backend online. Loaded: ${FORMULA}, ${NSITES} atoms. Use catgo_* MCP tools to interact.\"}"
else
  echo "{\"additionalContext\": \"[CatGO] Backend online, no structure loaded. Use catgo_fetch to load one.\"}"
fi
```

```bash
chmod +x ~/.claude/hooks/catgo-session-start.sh
```

- [ ] **Step 2: Test the hook script manually**

```bash
# With backend not running:
bash ~/.claude/hooks/catgo-session-start.sh
# Expected: no output (exit 0 silently)

# With backend running:
# Expected: {"additionalContext": "[CatGO] Backend online. ..."}
```

- [ ] **Step 3: Commit hook script into CatGO repo for reference**

```bash
mkdir -p /home/james/projects/catgo/CatGO/scripts
cp ~/.claude/hooks/catgo-session-start.sh /home/james/projects/catgo/CatGO/scripts/
git -C /home/james/projects/catgo/CatGO add scripts/catgo-session-start.sh
git -C /home/james/projects/catgo/CatGO commit -m "chore: add Claude Code SessionStart hook script

Reference copy of the hook installed at ~/.claude/hooks/.
Detects CatGO backend and injects one-line status into Claude Code context.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 5: Configure Claude Code settings

**Files:**
- Modify: `~/.claude/settings.json`
- Modify: `~/.claude/mcp.json`

- [ ] **Step 1: Add hooks to settings.json**

Add `"hooks"` key to existing `~/.claude/settings.json` (merge with existing content):

```json
{
  "permissions": { ... },
  "enabledPlugins": { ... },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{
          "type": "command",
          "command": "bash ~/.claude/hooks/catgo-session-start.sh",
          "timeout": 5
        }]
      }
    ]
  }
}
```

- [ ] **Step 2: Update mcp.json to point to new server**

Replace `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "catgo": {
      "command": "/home/james/miniforge3/envs/catgo/bin/python",
      "args": [
        "/home/james/projects/catgo/CatGO/server/mcp_tools/server_claude_code.py"
      ],
      "env": {
        "CATGO_API": "http://localhost:8000/api"
      }
    }
  }
}
```

- [ ] **Step 3: Verify MCP loads in Claude Code**

```bash
claude --mcp-debug
# Expected: "catgo" server listed with 5 tools
```

### Task 6: Update CLAUDE.md with MCP instructions

**Files:**
- Modify: `/home/james/projects/catgo/CatGO/CLAUDE.md`

- [ ] **Step 1: Append MCP instructions to CLAUDE.md**

Add to the end of the existing CLAUDE.md:

```markdown

## Claude Code MCP Integration

CatGO runs at localhost:8000. You have 5 MCP tools to control it.
The 3D viewer auto-updates when you modify structures.

### Tools
- `catgo_structure` — Get/modify crystal structures (get, add_atom, delete, supercell, slab, set_lattice, merge, ...)
- `catgo_fetch` — Fetch crystals from OPTIMADE databases or molecules from PubChem
- `catgo_workflow` — Create & run computation workflows (DFT, MD, ML optimization)
- `catgo_analyze` — Symmetry, DOS, RDF, optimize, DFT input generation
- `catgo_view` — Read viewer state (get_state), selection, screenshots

### Usage Pattern
1. Call `catgo_view(action="get_state")` to see what's loaded
2. Operate with catgo_structure / catgo_fetch / catgo_workflow / catgo_analyze
3. Results auto-push to the 3D viewer (visible within 500ms)
4. Workflow edits detected by frontend within 5s (user confirms reload)

### Conventions
- Positions are Cartesian (Angstroms) by default
- Structure format is pymatgen-compatible dict
- Backend: `cd ~/projects/catgo/CatGO && pnpm desktop:serve`
```

- [ ] **Step 2: Commit**

```bash
cd /home/james/projects/catgo/CatGO
git add CLAUDE.md
git commit -m "docs: add Claude Code MCP integration instructions to CLAUDE.md

Documents the 5 consolidated tools, usage pattern, and conventions
for Claude Code terminal integration.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 5: End-to-End Verification

### Task 7: Integration smoke test

- [ ] **Step 1: Start CatGO backend**

```bash
cd /home/james/projects/catgo/CatGO
pnpm desktop:serve
# Wait for backend to be ready on port 8000
```

- [ ] **Step 2: Test MCP server standalone**

```bash
# Send a list_tools request via stdio
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test"},"protocolVersion":"2024-11-05"}}' | \
  /home/james/miniforge3/envs/catgo/bin/python /home/james/projects/catgo/CatGO/server/mcp_tools/server_claude_code.py 2>/dev/null

# Expected: initialization response with server capabilities
```

- [ ] **Step 3: Test hook script with live backend**

```bash
bash ~/.claude/hooks/catgo-session-start.sh
# Expected with backend: {"additionalContext": "[CatGO] Backend online..."}
```

- [ ] **Step 4: Open Claude Code and test**

```bash
claude
# Say: "用 catgo_view 获取当前状态"
# Expected: Claude Code calls catgo_view(action="get_state") and returns state
```

- [ ] **Step 5: Test structure operation**

In Claude Code:
```
帮我从 Materials Project 加载 TiO2
```
Expected: Claude Code calls `catgo_fetch(action="crystal", formula="TiO2")`, CatGO viewer updates.

- [ ] **Step 6: Final commit with all integration tested**

```bash
cd /home/james/projects/catgo/CatGO
git add -A
git status  # Verify only expected files
git commit -m "feat: Claude Code ↔ CatGO deep integration complete

- 5 consolidated MCP tools (server_claude_code.py)
- GET /api/view/state endpoint
- SessionStart hook for auto-detection
- CLAUDE.md with usage instructions
- Tests for tool definitions

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

# Claude Code ↔ CatGO Deep Integration Design

## Goal

Enable bidirectional interaction between Claude Code (terminal CLI) and CatGO (materials science visualization app). Claude Code should be able to:
- **Read** current CatGO state (loaded structure, selection, workflow progress)
- **Write** structures, workflow edits, and analysis commands
- **See** real-time results in CatGO's 3D viewer

All with minimal token overhead (~730 tokens/conversation, comparable to context7 plugin).

## Architecture Overview

```
Claude Code (Terminal)
│
├── ~/.claude/settings.json (hooks)
│   └── SessionStart hook → detect CatGO backend, inject one-line status
│
├── ~/.claude/mcp.json → CatGO MCP Server (server_claude_code.py)
│   └── 5 consolidated tools (~500 tokens total)
│
├── Project CLAUDE.md → tool usage guide + conventions
│
└── catgo-session-start.sh → lightweight state injection script
       │ curl (2ms, ~30 tokens)
       ↓
CatGO Backend (FastAPI, localhost:8000)
├── GET  /api/view/state              ← NEW: unified state summary
├── GET  /api/view/structure/current  ← existing
├── GET  /api/view/selection          ← existing
├── POST /api/view/structure/push     ← existing
├── POST /api/view/structure/pending-update ← existing
└── All existing /api/ endpoints       ← existing
       ↑ pushes state every 5s
CatGO Frontend (Svelte 5 + Three.js)
```

## Component 1: Consolidated MCP Server

**File:** `server/mcp_tools/server_claude_code.py`

A lightweight MCP entry point that consolidates 50+ individual tools into 5 unified tools. Routes internally to existing handler functions — no business logic duplication.

### Tool 1: `catgo_structure`

Manipulate crystal structures. Auto-fetches current structure from viewer when needed, auto-pushes results back.

| Action | Description | Key Params |
|--------|-------------|------------|
| `get` | Get current structure summary + pymatgen dict | — |
| `add_atom` | Add single atom | `element`, `position` (cart/frac) |
| `add_atoms` | Batch add atoms | `atoms: [{element, position}]` |
| `delete` | Delete atoms by index | `indices: [int]` |
| `replace` | Replace element at index | `index`, `new_element` |
| `move` | Move atom(s) | `index`/`indices`, `displacement` |
| `supercell` | Create supercell | `scaling: [nx,ny,nz]` or `matrix: 3x3` |
| `set_lattice` | Set lattice parameters | `a,b,c,alpha,beta,gamma` |
| `slab` | Generate surface slab | `miller_indices`, `thickness`, `vacuum` |
| `merge` | Merge two structures | `structure` (incoming) |

```json
{
  "name": "catgo_structure",
  "description": "Manipulate crystal structures in CatGO viewer. Actions: get, add_atom, add_atoms, delete, replace, move, supercell, set_lattice, slab, merge. Structure is auto-fetched from viewer.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {"type": "string", "enum": ["get","add_atom","add_atoms","delete","replace","move","supercell","set_lattice","slab","merge"]},
      "element": {"type": "string"},
      "position": {"type": "array", "items": {"type": "number"}},
      "indices": {"type": "array", "items": {"type": "integer"}},
      "scaling": {"type": "array", "items": {"type": "integer"}},
      "miller_indices": {"type": "array", "items": {"type": "integer"}},
      "params": {"type": "object", "description": "Additional action-specific parameters"}
    },
    "required": ["action"]
  }
}
```

### Tool 2: `catgo_fetch`

Fetch structures from online databases.

| Action | Description | Key Params |
|--------|-------------|------------|
| `crystal` | Fetch from OPTIMADE (MP, Alexandria, etc.) | `formula`/`elements`/`structure_id`, `provider` |
| `search` | Search OPTIMADE (list only) | `formula`/`elements`, `provider`, `limit` |
| `molecule` | Fetch from PubChem | `query`/`cid`, `search_type` |

```json
{
  "name": "catgo_fetch",
  "description": "Fetch crystal structures from OPTIMADE databases (Materials Project, Alexandria, MC3D) or molecules from PubChem. Actions: crystal, search, molecule.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {"type": "string", "enum": ["crystal","search","molecule"]},
      "formula": {"type": "string"},
      "elements": {"type": "array", "items": {"type": "string"}},
      "structure_id": {"type": "string"},
      "provider": {"type": "string", "default": "mp"},
      "query": {"type": "string"},
      "cid": {"type": "integer"},
      "limit": {"type": "integer", "default": 5}
    },
    "required": ["action"]
  }
}
```

### Tool 3: `catgo_workflow`

**Already consolidated.** Keep existing implementation as-is from `server/mcp_tools/server.py`.

Actions: `list`, `templates`, `node_types`, `create`, `get`, `add_node`, `remove_node`, `connect`, `set_params`, `run`, `pause`, `status`, `step_error`

### Tool 4: `catgo_analyze`

Analysis and computation tools.

| Action | Description | Key Params |
|--------|-------------|------------|
| `symmetry` | Space group analysis | — |
| `dos` | Density of states | `source` |
| `rdf` | Radial distribution function | `r_max`, `bin_width` |
| `optimize` | Structure optimization | `model` (MACE/CHGNet), `fmax` |
| `dft_input` | Generate DFT input files | `software` (vasp/qe/lammps), `calc_type` |
| `adsorption_sites` | Find adsorption sites | `distance` |
| `coordination` | Coordination analysis | — |

```json
{
  "name": "catgo_analyze",
  "description": "Analyze structures: symmetry, DOS, RDF, optimize, generate DFT input (VASP/QE/LAMMPS), find adsorption sites, coordination. Actions: symmetry, dos, rdf, optimize, dft_input, adsorption_sites, coordination.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {"type": "string", "enum": ["symmetry","dos","rdf","optimize","dft_input","adsorption_sites","coordination"]},
      "software": {"type": "string", "enum": ["vasp","qe","lammps"]},
      "calc_type": {"type": "string"},
      "model": {"type": "string"},
      "params": {"type": "object"}
    },
    "required": ["action"]
  }
}
```

### Tool 5: `catgo_view` (NEW)

Read viewer state and capture screenshots.

| Action | Description | Returns |
|--------|-------------|---------|
| `get_state` | Full state summary | `{formula, num_sites, elements, lattice, selection, ...}` |
| `selection` | Get selected atoms | `{indices, elements, positions}` |
| `screenshot` | Capture 3D viewer | Base64 PNG image |

```json
{
  "name": "catgo_view",
  "description": "Read CatGO viewer state. get_state returns structure summary + selection + view settings. selection returns selected atoms. screenshot captures the 3D view.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {"type": "string", "enum": ["get_state","selection","screenshot"]}
    },
    "required": ["action"]
  }
}
```

### Internal Routing

`server_claude_code.py` routes to existing handlers:

```python
ROUTE_MAP = {
    "catgo_structure": {
        "get":         ("GET",  "/view/structure/current"),
        "add_atom":    ("POST", "/structure-ops/add-atom"),
        "add_atoms":   ("POST", "/structure-ops/add-atoms"),
        "delete":      ("POST", "/structure-ops/delete-atoms"),
        "replace":     ("POST", "/structure-ops/replace-atom"),
        "move":        ("POST", "/structure-ops/move-atom"),
        "supercell":   ("POST", "/structure-ops/supercell"),
        "set_lattice": ("__special__", "set-lattice"),
        "slab":        ("POST", "/structure-ops/generate-slab"),
        "merge":       ("POST", "/structure-ops/merge"),
    },
    "catgo_fetch": {
        "crystal":  ("__special__", "fetch-crystal"),
        "search":   ("__special__", "search-crystals"),
        "molecule": ("__special__", "fetch-molecule"),
    },
    "catgo_analyze": {
        "symmetry":         ("POST", "/symmetry/analyze"),
        "dos":              ("POST", "/dos/compute"),
        "rdf":              ("POST", "/analysis/rdf"),
        "optimize":         ("POST", "/optimize/run"),
        "dft_input":        ("POST", "/dft-input/generate"),
        "adsorption_sites": ("GET",  "/adsorption/sites"),
        "coordination":     ("POST", "/analysis/coordination"),
    },
    "catgo_view": {
        "get_state":  ("GET", "/view/state"),
        "selection":  ("GET", "/view/selection"),
        "screenshot": ("POST", "/view/screenshot"),
    },
}
```

## Component 2: New Backend Endpoint

### `GET /api/view/state`

**File:** `server/routers/view_capture.py`

Compact state summary combining structure info, selection, and metadata:

```python
@router.get("/view/state")
async def get_view_state():
    """Unified state summary for Claude Code. Compact, ~200 bytes."""
    info = _current_structure_info
    selection = _current_selection
    struct = _current_structure_dict

    if not struct:
        return {"has_structure": False}

    lattice = struct.get("lattice", {}) if struct else {}

    return {
        "has_structure": True,
        "formula": info.get("formula", "?") if info else "?",
        "num_sites": info.get("num_sites", 0) if info else 0,
        "elements": info.get("elements", []) if info else [],
        "lattice": {
            "a": round(lattice.get("a", 0), 2),
            "b": round(lattice.get("b", 0), 2),
            "c": round(lattice.get("c", 0), 2),
        } if lattice else None,
        "space_group": info.get("space_group") if info else None,
        "selection": {
            "count": len(selection.indices) if selection else 0,
            "indices": (selection.indices[:20] if selection else []),
        },
    }
```

## Component 3: SessionStart Hook

### Script: `~/.claude/hooks/catgo-session-start.sh`

```bash
#!/bin/bash
# Detect CatGO backend and inject one-line status (~30 tokens)
STATE=$(curl -s --max-time 2 http://localhost:8000/api/view/state 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$STATE" ]; then
  exit 0  # Backend not running, inject nothing
fi

HAS=$(echo "$STATE" | jq -r '.has_structure')
if [ "$HAS" = "true" ]; then
  FORMULA=$(echo "$STATE" | jq -r '.formula')
  NSITES=$(echo "$STATE" | jq -r '.num_sites')
  echo "{\"additionalContext\": \"[CatGO] Backend online. Loaded: ${FORMULA}, ${NSITES} atoms. Use catgo_* MCP tools to interact.\"}"
else
  echo "{\"additionalContext\": \"[CatGO] Backend online. No structure loaded. Use catgo_fetch to load one.\"}"
fi
```

### Hook Configuration: `~/.claude/settings.json`

```json
{
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

**Token cost:** ~30 tokens, fires once per session.

## Component 4: MCP Configuration

### `~/.claude/mcp.json`

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

Points to the NEW lightweight entry point instead of the original `mcp_server.py`.

## Component 5: CLAUDE.md Instructions

### Project-scoped: `/home/james/projects/catgo/CatGO/.claude/CLAUDE.md` (append)

Or global `~/.claude/CLAUDE.md` if you want it available everywhere:

```markdown
## CatGO MCP Integration

CatGO is a materials science app at localhost:8000. You have MCP tools to control it.
The 3D viewer auto-updates when you modify structures.

### Tools
- `catgo_structure` — Get/modify crystal structures (add_atom, supercell, slab, etc.)
- `catgo_fetch` — Fetch crystals from OPTIMADE (MP, Alexandria) or molecules from PubChem
- `catgo_workflow` — Create & run computation workflows (DFT, MD, ML optimization)
- `catgo_analyze` — Symmetry, DOS, RDF, optimize, DFT input generation
- `catgo_view` — Read viewer state, selection, capture screenshots

### Usage Pattern
1. Call `catgo_view(action="get_state")` first to understand current state
2. Perform operations with the appropriate tool
3. Results auto-push to the 3D viewer (structure changes visible within 500ms)
4. Workflow changes detected by frontend within 5s (user confirms reload)

### Conventions
- Positions default to Cartesian (Angstroms); specify `fractional: true` for fractional
- Structure format is pymatgen-compatible dict
- Backend must be running: `cd ~/projects/catgo/CatGO && pnpm desktop:serve`
```

## Token Budget Analysis

| Component | Token Cost | Frequency |
|-----------|-----------|-----------|
| 5 MCP tool definitions | ~500 | Per conversation (system prompt) |
| CLAUDE.md instructions | ~200 | Per conversation (system prompt) |
| SessionStart hook | ~30 | Once per session |
| `catgo_view(get_state)` call | ~100 | On demand (per call) |
| Tool result summaries | ~50 each | Per operation |
| **Total baseline** | **~730** | **Per conversation** |

Comparable to context7 (~300 tokens) + code-review (~200 tokens).

## Data Flow: Example Interaction

```
User: "帮我加载 TiO2 然后做个 2x2x2 超胞"

1. Claude Code calls catgo_fetch(action="crystal", formula="TiO2")
   → MCP server calls OPTIMADE API
   → Fetches TiO2 structure
   → Auto-pushes to viewer via /api/view/structure/pending-update
   → Returns: "Loaded TiO2 (mp-2657) from mp: 6 atoms, P42/mnm"
   → CatGO 3D viewer updates within 500ms

2. Claude Code calls catgo_structure(action="supercell", scaling=[2,2,2])
   → MCP server GETs current structure from /api/view/structure/current
   → POSTs to /api/structure-ops/supercell
   → Auto-pushes result to viewer
   → Returns: "Structure updated: 48 atoms (Ti16 O32). Cell: a=9.19 b=9.19 c=5.91 Å"
   → CatGO 3D viewer shows 2x2x2 supercell

User sees real-time 3D updates after each operation.
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `server/mcp_tools/server_claude_code.py` | CREATE | Lightweight MCP entry point with 5 consolidated tools |
| `server/routers/view_capture.py` | MODIFY | Add `GET /api/view/state` endpoint |
| `~/.claude/mcp.json` | MODIFY | Point to `server_claude_code.py` |
| `~/.claude/hooks/catgo-session-start.sh` | CREATE | SessionStart hook script |
| `~/.claude/settings.json` | MODIFY | Add SessionStart hook config |
| Project CLAUDE.md | MODIFY | Add CatGO MCP usage instructions |

## Non-Goals (Out of Scope)

- WebSocket push from CatGO to Claude Code (Claude Code doesn't support inbound events)
- Auto-reload workflow UI on MCP changes (existing 5s detect + manual Reload is sufficient)
- Rewriting existing fine-grained tools (kept for in-app AI chat, no changes needed)
- UserPromptSubmit hook (too expensive per-turn, CLAUDE.md instructions suffice)

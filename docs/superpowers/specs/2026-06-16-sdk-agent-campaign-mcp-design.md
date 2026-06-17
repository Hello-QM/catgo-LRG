# SDK-Agent Campaign MCP Tool (Sub-project C) — Design Spec

**Date:** 2026-06-16
**Status:** Approved (design); ready for implementation plan
**Branch target:** `feat/pane-tree-core`
**Part of:** "expose CatGo powers to SDK agents" (C = Campaign; B = visible terminal, next)

## Goal

Let the SDK agents (Claude Code / Codex / Gemini, reached through CatBot's agent-bridge) **use CatGo Campaign** — the md-orchestration system (`catgo campaign …`). Add a discoverable `catgo_campaign` MCP tool so the agent can scaffold and drive campaigns, guided by the existing `catgo-campaign-conventions` skill.

## Context (how SDK agents get tools)

The bridge wires a backend **CatGo MCP HTTP server** (`server/catgo/routers/mcp_http.py`) to each SDK agent; it serves the `TOOLS` list from `server/catgo/mcp_tools/server_claude_code.py` (`catgo_structure`, `catgo_fetch`, `catgo_workflow`, `catgo_skills`, `catgo_file`, `catgo_system`, …). `call_tool(name, args)` dispatches `if name == "catgo_X": return await _handle_X(...)`. These `catgo_*` tools are auto-allowed (trusted). `catgo_skills` already reads skill files, so `catgo-campaign-conventions` is readable. The **`catgo` CLI** is a console script (`pyproject: catgo = catgo.cli:main`) installed in the backend env; `python -m catgo` works (`server/catgo/__main__.py`). The `catgo campaign` launcher (`server/catgo/cli/campaign_cmd.py`) dispatches actions `new, fetch-ref, submit, poll, aggregate, report, ingest, archive` to scripts in `catgo/workflow/skills/campaign/scripts/`.

## Architecture

Add **one** `catgo_campaign` MCP tool — a thin, safe passthrough to the `catgo campaign` CLI. The agent reads `catgo-campaign-conventions` (via `catgo_skills`), scaffolds a campaign with `new`, then drives the resulting md folder with its own bash/file tools (and the tool's sub-actions for HPC steps). Campaign folders live at **absolute paths on the local machine**, reachable by both the backend (which runs the CLI) and the agent's local shell — so there's no cross-process path mismatch.

## Components

### 1. `server/catgo/mcp_tools/server_claude_code.py`

Add to `TOOLS`:

```python
Tool(
    name="catgo_campaign",
    description=(
        "Create and drive a CatGo Campaign — the md-orchestration system for "
        "exploratory / HPC research studies (agent-driven folder + markdown). "
        "READ the 'campaign' skill first (catgo_skills action=read skill=campaign) "
        "for conventions. Actions map to the `catgo campaign` CLI:\n"
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
            "action": {"type": "string", "enum": ["new", "fetch-ref", "submit", "poll", "aggregate", "report", "ingest", "archive"]},
            "args": {"type": "array", "items": {"type": "string"}, "description": "Extra CLI args passed verbatim, e.g. ['my-study', '--location', '/home/james/research']."},
        },
        "required": ["action"],
    },
),
```

Add the handler:

```python
async def _handle_campaign(args: dict) -> list[TextContent]:
    action = str(args.get("action") or "").strip()
    extra = [str(a) for a in (args.get("args") or [])]
    if not action:
        return [TextContent(type="text", text="error: 'action' is required")]
    argv = [sys.executable, "-m", "catgo", "campaign", action, *extra]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
        text = (out or b"").decode("utf-8", "replace")
        status = "ok" if proc.returncode == 0 else f"exit {proc.returncode}"
        return [TextContent(type="text", text=f"[catgo campaign {action}] {status}\n{text}".rstrip())]
    except asyncio.TimeoutError:
        return [TextContent(type="text", text=f"[catgo campaign {action}] still running after 300s — check the campaign folder / poll later.")]
    except Exception as e:  # noqa: BLE001 — surface any launcher error to the agent
        return [TextContent(type="text", text=f"[catgo campaign {action}] error: {e}")]
```

(`sys`, `asyncio`, `TextContent` are imported in this module; if `sys`/`asyncio` are not, add them.)

### 2. `server/catgo/routers/mcp_http.py`

In `call_tool`, add a dispatch arm (next to the other `elif name == …`):

```python
elif name == "catgo_campaign":
    return await _handle_campaign(arguments)
```

Import `_handle_campaign` from `server_claude_code` alongside the other handlers/`TOOLS` import.

### 3. `catgo_skills` discoverability

Ensure the `campaign` / `catgo-campaign-conventions` skill is discoverable: it lives at `server/catgo/workflow/skills/catgo-campaign-conventions/SKILL.md`. Confirm `catgo_skills(action=list)` includes it and `catgo_skills(action=read, skill='campaign')` (or the real path) returns it; if the skills lister doesn't already surface that directory, add it. Mention the skill in the `catgo_campaign` description (done above).

## Data flow

Agent (Claude Code) ↔ CatGo MCP → `catgo_campaign(action, args)` → subprocess `python -m catgo campaign <action> <args…>` → stdout + exit code returned as `TextContent`. The agent reads conventions via `catgo_skills`, then works the scaffolded folder with bash.

## Error handling / edge cases

- **Unknown action** — blocked by the enum schema; if it slips through, the CLI prints usage (exit 2), surfaced verbatim.
- **Missing required args** (e.g. `new` without a name) — the CLI's own usage/error is returned.
- **Long-running steps** (`submit`/`poll`) — 300 s timeout → returns "still running, poll later" (no hang).
- **Runs as the backend user**, same machine as the agent → absolute campaign paths are shared between backend and the agent's shell.
- **Auto-allowed**: like other `catgo_*` tools, `catgo_campaign` is trusted/auto-allowed — acceptable (it only runs the campaign launcher, not arbitrary shell; the agent already has bash anyway).

## Testing

- **pytest** (`server/tests/…`): `_handle_campaign` builds argv `[sys.executable, '-m', 'catgo', 'campaign', <action>, *args]` and returns stdout/exit (monkeypatch `asyncio.create_subprocess_exec` with a fake proc); empty action → error text; timeout path → "still running".
- **Integration (live backend):** `catgo_campaign(action='new', args=['mcp-smoke','--location', <tmp>])` creates a campaign folder under `<tmp>`; `catgo_skills(action='read', skill='campaign')` returns the conventions. (Run via the MCP server or a direct handler call.)

## File summary

| File | Change |
|---|---|
| `server/catgo/mcp_tools/server_claude_code.py` | add `catgo_campaign` Tool + `_handle_campaign` |
| `server/catgo/routers/mcp_http.py` | dispatch `catgo_campaign` |
| `catgo_skills` lister (in `server_claude_code.py` / its helper) | surface the campaign skill if not already |
| `server/tests/test_campaign_mcp.py` | **new** — handler unit tests |

## Out of scope

- B (SDK agents driving the visible terminal) — next sub-project.
- New campaign CLI actions / changing campaign internals.
- A GUI affordance for SDK-agent campaigns (the agent drives it conversationally).

# SDK-Agent Campaign MCP Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `catgo_campaign` MCP tool so SDK agents (Claude Code/Codex/Gemini) can scaffold + drive CatGo Campaigns via `catgo campaign …`.

**Architecture:** One thin passthrough tool in the backend CatGo MCP server: a pure `_campaign_argv` builder + an async `_handle_campaign` that runs `python -m catgo campaign <action> <args…>` and returns stdout/exit; dispatched from `mcp_http.py:call_tool`. Conventions are already discoverable via the existing `catgo_skills`.

**Tech Stack:** Python (FastAPI backend), `mcp` server lib, asyncio subprocess, pytest. Run server commands from `server/`.

**Spec:** `docs/superpowers/specs/2026-06-16-sdk-agent-campaign-mcp-design.md`

**Confirmed anchors:**
- `server/catgo/mcp_tools/server_claude_code.py` imports `asyncio`, `os`, `sys`, `httpx`, and `from mcp.types import TextContent, Tool`. It defines a module-level `TOOLS: list[Tool]` and `async def _handle_*` functions.
- `server/catgo/routers/mcp_http.py` does `from catgo.mcp_tools.server_claude_code import (TOOLS, _handle_structure, …, _handle_skills, API_BASE)` (lines 39-58) and dispatches in `call_tool` via `if name == "catgo_X": return await _handle_X(...)` (and `_handle_skills`/`_handle_diagnose`/`_handle_workflow_engine` are called as `await _handle_X(arguments)` — no `client` arg).
- `python -m catgo` works (`server/catgo/__main__.py` exists); the campaign launcher is `catgo campaign {new,fetch-ref,submit,poll,aggregate,report,ingest,archive}`.
- `catgo_skills` walks `_SKILLS_DIR = .../catgo/workflow/skills`, which already contains `campaign/SKILL.md`, `catgo-campaign-conventions/SKILL.md`, etc. → **already discoverable; do not modify `catgo_skills`.**
- Tests live in `server/tests/` (has `conftest.py`). Run from `server/`: `python -m pytest tests/<file> -q`.

---

## Task 1: `catgo_campaign` tool + handler + unit test

**Files:**
- Modify: `server/catgo/mcp_tools/server_claude_code.py`
- Test: `server/tests/test_campaign_mcp.py`

- [ ] **Step 1: Write the failing test** (sync — tests the pure argv builder):

```python
# server/tests/test_campaign_mcp.py
from catgo.mcp_tools.server_claude_code import _campaign_argv
import sys


def test_campaign_argv_basic():
    argv = _campaign_argv('new', ['my-study', '--location', '/tmp/x'])
    assert argv[0] == sys.executable
    assert argv[1:] == ['-m', 'catgo', 'campaign', 'new', 'my-study', '--location', '/tmp/x']


def test_campaign_argv_no_extra():
    assert _campaign_argv('poll', []) == [sys.executable, '-m', 'catgo', 'campaign', 'poll']
```

- [ ] **Step 2: Run it, confirm FAIL** — from `server/`:

Run: `python -m pytest tests/test_campaign_mcp.py -q`
Expected: FAIL — `ImportError: cannot import name '_campaign_argv'`.

- [ ] **Step 3: Add the tool, the argv builder, and the handler.** In `server_claude_code.py`:

(a) Append a `Tool` to the `TOOLS` list (place it next to the other `Tool(name="catgo_*")` entries):

```python
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
```

(b) Add the pure builder + async handler (place near the other `_handle_*` defs, e.g. just after `_handle_skills`):

```python
def _campaign_argv(action: str, extra: list[str]) -> list[str]:
    """Build the argv for `python -m catgo campaign <action> <extra...>` (pure, testable)."""
    return [sys.executable, "-m", "catgo", "campaign", action, *extra]


async def _handle_campaign(args: dict) -> list[TextContent]:
    """Run the `catgo campaign` CLI on behalf of an SDK agent and return its output."""
    action = str(args.get("action") or "").strip()
    extra = [str(a) for a in (args.get("args") or [])]
    if not action:
        return [TextContent(type="text", text="error: 'action' is required")]
    argv = _campaign_argv(action, extra)
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
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

- [ ] **Step 4: Run the test, confirm PASS** — from `server/`:

Run: `python -m pytest tests/test_campaign_mcp.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add server/catgo/mcp_tools/server_claude_code.py server/tests/test_campaign_mcp.py
git commit -m "feat(mcp): catgo_campaign tool + handler (SDK agents run catgo campaign)"
```

---

## Task 2: Dispatch `catgo_campaign` in the MCP HTTP server

**Files:**
- Modify: `server/catgo/routers/mcp_http.py`

- [ ] **Step 1: Import the handler.** In the `from catgo.mcp_tools.server_claude_code import ( … )` block (lines ~39-58), add `_handle_campaign,` to the imported names (e.g. after `_handle_skills,`).

- [ ] **Step 2: Add the dispatch arm.** In `call_tool`, next to the other `elif name == …:` arms, add:

```python
            elif name == "catgo_campaign":
                return await _handle_campaign(arguments)
```

- [ ] **Step 3: Smoke-import.** From `server/`, confirm the module imports and lists the tool:

Run:
```bash
python -c "import catgo.routers.mcp_http as m; names=[t.name for t in m.TOOLS]; print('catgo_campaign' in names); assert 'catgo_campaign' in names"
```
Expected: prints `True` (the tool is registered and the dispatch import resolved).

- [ ] **Step 4: Commit**

```bash
git add server/catgo/routers/mcp_http.py
git commit -m "feat(mcp): dispatch catgo_campaign in the MCP HTTP server"
```

---

## Task 3: Integration smoke (scaffold a real campaign)

**Files:** none (verification).

- [ ] **Step 1: Verify the skill is discoverable** — from `server/`:

```bash
python -c "import asyncio; from catgo.mcp_tools.server_claude_code import _handle_skills; r=asyncio.run(_handle_skills({'action':'list'})); print('campaign' in r[0].text)"
```
Expected: `True` (the `campaign` skill shows in the list).

- [ ] **Step 2: Scaffold a campaign via the handler** — from `server/`:

```bash
python -c "import asyncio, tempfile, os; from catgo.mcp_tools.server_claude_code import _handle_campaign; d=tempfile.mkdtemp(); r=asyncio.run(_handle_campaign({'action':'new','args':['mcp-smoke','--location',d]})); print(r[0].text[:400]); print('CREATED:', os.listdir(d))"
```
Expected: the handler prints `[catgo campaign new] ok` (or the CLI's real output) and the temp dir now contains a campaign folder. If `new`'s flags differ (e.g. it wants positional args), adjust the `args` to match `catgo campaign new --help` and note the correct invocation — the handler itself is unchanged.

- [ ] **Step 3:** Confirm `python -m pytest tests/test_campaign_mcp.py -q` passes.

---

## Final verification

- [ ] `python -m pytest tests/test_campaign_mcp.py -q` → passes.
- [ ] `python -c "import catgo.routers.mcp_http"` imports cleanly (no syntax/import error).
- [ ] Merge to `feat/pane-tree-core`.

## Notes / invariants

- `catgo_campaign` is auto-allowed like the other `catgo_*` MCP tools (it only runs the campaign launcher; the agent already has bash). No approval card needed for C.
- No frontend changes; this is backend-MCP only. No `src/lib/mobile/*`.
- `catgo_skills` is unchanged — the campaign skills already live under `_SKILLS_DIR`.
- Python style: match the file (4-space indent, double quotes as used in server_claude_code.py).

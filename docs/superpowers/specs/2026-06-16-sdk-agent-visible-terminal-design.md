# SDK-Agent Visible-Terminal Control (Sub-project B) — Design Spec

**Date:** 2026-06-16
**Status:** Approved (design); ready for implementation plan
**Branch target:** `feat/pane-tree-core`
**Part of:** "expose CatGo powers to SDK agents" (C = Campaign, shipped; B = this).

## Goal

Let the SDK agents (Claude Code / Codex / Gemini, via the agent-bridge) **drive the user's visible terminal pane** — run commands, read output, send keystrokes, interrupt — with per-command approval. Today these agents only have their *own* isolated shell (`~/.catgo/agents/claude`); this makes them operate the *visible* terminal (local or HPC), like the client-direct (DeepSeek) path already does.

## Why a round-trip

SDK-agent tools run as **backend MCP** (`server/catgo/mcp_tools/server_claude_code.py` served by `mcp_http.py`). The visible terminal is a **renderer** PTY (its `xterm` + the terminal-registry I built for the client-direct tools). So the backend tool must reach the renderer and get a result back. CatGo already has this exact pattern: **catrender** (`view_capture.py`): `POST /catrender/request` creates a `request_id` + `asyncio.Future`, `await`s it (timeout → 504); `GET /catrender/pending` lists params; `POST /catrender/result` does `future.set_result()`. We mirror it for the terminal, and reuse the renderer-side **terminal-registry** (`get_active_terminal()`, `run_command`/`read_buffer`/`send_keys`/`interrupt`, and the auto-spawn opener) already shipped in [[catbot-terminal-control]].

## Decisions (locked)

| Question | Decision |
|---|---|
| v1 scope | **Full**: `run`, `read`, `send_keys`, `interrupt`. |
| Approval | **Approve each** command in a **renderer card** (allow/deny) + a per-session **"auto-run"** toggle. (The `catgo_*` MCP tools are auto-allowed at the bridge, so the gate must live in the renderer.) |

## Components

### 1. Backend round-trip — `server/catgo/routers/terminal_bridge.py` (new)

Mirrors the catrender request/result pattern.

```python
_pending_terminal: dict[str, asyncio.Future] = {}
TERMINAL_TIMEOUT = 120.0  # seconds; run waits this long for the renderer

async def request_terminal(action: str, payload: dict) -> dict:
    """Enqueue a terminal request for the renderer and await its result.
    action ∈ {read, run, send_keys, interrupt}. Returns the renderer's result
    dict (or {'error': ...} on timeout / no terminal)."""
    request_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    _pending_terminal[request_id] = fut
    fut._params = {"request_id": request_id, "action": action, **payload}
    try:
        return await asyncio.wait_for(fut, timeout=TERMINAL_TIMEOUT)
    except asyncio.TimeoutError:
        return {"error": "No terminal responded (is a CatGo window open?) — timed out."}
    finally:
        _pending_terminal.pop(request_id, None)

router = APIRouter(prefix="/terminal", tags=["terminal-bridge"])

@router.get("/pending")
def list_pending():
    return {"pending": [getattr(f, "_params", {}) for f in _pending_terminal.values() if not f.done()]}

@router.post("/result")
def post_result(payload: dict):
    fut = _pending_terminal.get(payload.get("request_id", ""))
    if fut is None: raise HTTPException(404, "No pending terminal request")
    if fut.done(): raise HTTPException(409, "Already fulfilled")
    fut.set_result(payload)
    return {"status": "ok"}
```

Register the router in `server/main.py` (next to the other `app.include_router(...)` / the view_capture router).

### 2. Backend MCP tool — `server_claude_code.py` + `mcp_http.py`

Add `Tool(name="catgo_terminal", …)`: `{ action: enum[read,run,send_keys,interrupt], command?: string, keys?: string, lines?: number }`. Add `_handle_terminal(args)`:

```python
async def _handle_terminal(args: dict) -> list[TextContent]:
    from catgo.routers.terminal_bridge import request_terminal  # in-process; no self-HTTP
    action = str(args.get("action") or "").strip()
    if action not in {"read", "run", "send_keys", "interrupt"}:
        return [TextContent(type="text", text="error: action must be read|run|send_keys|interrupt")]
    payload = {}
    if action == "run": payload["command"] = str(args.get("command") or "")
    elif action == "send_keys": payload["keys"] = str(args.get("keys") or "")
    elif action == "read": payload["lines"] = int(args.get("lines") or 40)
    res = await request_terminal(action, payload)
    if res.get("error"): return [TextContent(type="text", text=f"[terminal] {res['error']}")]
    if res.get("denied"): return [TextContent(type="text", text="[terminal] the user denied this command.")]
    body = res.get("output", "")
    tail = f"\n(exit {res['exit_code']})" if res.get("exit_code") is not None else ("\n(still running)" if res.get("running") else "")
    return [TextContent(type="text", text=f"[terminal:{action}] target={res.get('target','?')}\n{body}{tail}".rstrip())]
```

Dispatch `elif name == "catgo_terminal": return await _handle_terminal(arguments)` in `mcp_http.py:call_tool` + import `_handle_terminal`. The tool description states commands need user approval and to prefer `run` for non-interactive commands, `send_keys` for prompts/TUIs, `read` to inspect.

### 3. Renderer global poller + approval — `desktop/lib/terminal-bridge-poller.svelte.ts` (new) + App wiring

A per-window poll loop (mirrors `tool-handler.ts:poll_screenshot`, ~1 s interval, started by an App `$effect`):

```
loop:
  GET {API_BASE}/terminal/pending
  for each pending req (claim one at a time):
    if mutating action (run/send_keys/interrupt) and NOT auto_run:
      show approval card (command/keys shown) → await allow/deny
      if deny: POST /terminal/result {request_id, denied:true}; continue
    handle = await ensure_active_terminal()   // terminal-registry; auto-spawn local if none
    if !handle: POST {request_id, error:'no terminal'}; continue
    switch action:
      run        → r = await handle.run_command(command)      → {output, exit_code, running}
      read       → output = handle.read_buffer(lines)         → {output}
      send_keys  → await handle.send_keys(resolve_keys(keys)) → {output: read_buffer()}
      interrupt  → await handle.interrupt()                   → {output: read_buffer()}
    POST /terminal/result {request_id, target, ...result}
```

- **Approval card**: a small modal in `App.svelte` (reuse the existing modal styles) driven by a `$state` the poller sets; shows the command + Allow / Deny + a "Run agent terminal commands without asking (this session)" checkbox that sets the per-session `auto_run` flag. `read` is passive → no card.
- The poller reuses the terminal-registry directly (`get_active_terminal`, `ensure_active_terminal`, `run_command`, `read_buffer`, `send_keys`, `interrupt`) and `resolve_keys` from `terminal-capture.ts`. No backend execution — the real PTY runs in the renderer, so cwd/env/HPC are the *visible* terminal's.

## Data flow

SDK agent → `catgo_terminal(run, cmd)` → MCP `_handle_terminal` → `await request_terminal('run', {command})` (Future) → renderer poller sees it via `/terminal/pending` → approval card → `get_active_terminal().run_command(cmd)` (real PTY, marker capture) → `POST /terminal/result` → Future resolves → tool returns the output to the agent.

## Error handling / edge cases

- **No window / no poller** → `request_terminal` times out (120 s) → tool returns "No terminal responded". (Renderer present but no terminal → auto-spawn local first.)
- **Denied** → tool returns "user denied this command".
- **Long/interactive command** → `run_command`'s own 15 s capture timeout returns `running:true` → tool says "still running"; the agent can `read`/`send_keys`.
- **Multi-window** → first poller to `POST /result` wins (the `Already fulfilled` 409 guards a second post). v1 targets the common single-window case.
- **Approval bypass** → only the per-session `auto_run` toggle skips the card; never persisted.
- **HPC terminal** → identical path; the active terminal may be a remote session.

## Testing

- **Backend (pytest):** `request_terminal` + `/result` round-trip — start `request_terminal` as a task, post a result, assert it resolves with that payload; `/result` for an unknown id → 404; timeout path returns `{'error': …}`. `_handle_terminal` rejects a bad action and formats `run`/`denied`/`error` results (monkeypatch `request_terminal`).
- **Live browser (acceptance):** with an **SDK agent** (Claude Code) selected, open a terminal, ask "run `pwd` in my terminal" → an approval card appears → Allow → the command runs in the **visible** terminal (cwd = the visible terminal's, e.g. `…/pane-tree-impl`, **not** `~/.catgo/agents/claude`) and the agent reports it. Test `send_keys` answering a `read -p` prompt; `read`; deny path; auto-run toggle.

## File summary

| File | Change |
|---|---|
| `server/catgo/routers/terminal_bridge.py` | **new** — `request_terminal` + `/terminal/pending` + `/terminal/result` |
| `server/main.py` | register the terminal_bridge router |
| `server/catgo/mcp_tools/server_claude_code.py` | `catgo_terminal` Tool + `_handle_terminal` |
| `server/catgo/routers/mcp_http.py` | import + dispatch `catgo_terminal` |
| `desktop/lib/terminal-bridge-poller.svelte.ts` | **new** — global poller + result POST |
| `desktop/App.svelte` | start the poller; terminal-approval modal |
| `server/tests/test_terminal_bridge.py` | **new** — round-trip + handler unit tests |

## Invariants / out of scope

- Reuses the existing terminal-registry / `run_command` marker capture / auto-spawn — no new PTY logic.
- No `src/lib/mobile/*` edits (the poller is desktop App-level).
- Out of scope: streaming live TUI output to the agent; targeting a *specific* terminal among many (v1 uses the active one); cross-window routing.

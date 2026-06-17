# SDK-Agent Visible-Terminal Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let SDK agents (Claude Code/Codex/Gemini) drive the user's **visible** terminal (run/read/send_keys/interrupt) with per-command approval, via a backend↔renderer round-trip.

**Architecture:** Mirror CatGo's catrender round-trip: a `catgo_terminal` MCP tool `await`s an in-process `request_terminal(...)` (a `Future`); a global renderer poller picks the request up from `/api/terminal/pending`, shows an approval card, executes via the existing **terminal-registry** (real PTY), and POSTs `/api/terminal/result` to resolve the tool.

**Tech Stack:** Python/FastAPI backend, `mcp` lib, asyncio; SvelteKit 2 / Svelte 5 renderer; pytest + browser. Python style = 4-space + double quotes; frontend = single-quote / no-semicolon / 2-space (never `deno fmt`).

**Spec:** `docs/superpowers/specs/2026-06-16-sdk-agent-visible-terminal-design.md`

**Confirmed anchors:**
- `view_capture.py`: `router = APIRouter(prefix="/view")`; catrender uses `request_id=str(uuid.uuid4())`, `loop.create_future()`, `_pending_catrender[id]=fut`, `await asyncio.wait_for(fut, timeout)`, `/catrender/pending` lists `getattr(f,"_params",{})`, `/catrender/result` does `fut.set_result(payload)`.
- `server/main.py` mounts routers with `app.include_router(X_router, prefix="/api")` (e.g. `view_capture_router`, `pty_router`, line ~499-502).
- Frontend `API_BASE = '/api'` (`src/lib/api/config.ts`); `CatRenderViewPane.svelte` polls `${API_BASE}/view/catrender/pending` and posts `${API_BASE}/view/catrender/result` in a loop.
- Renderer terminal-registry (`src/lib/structure/terminal-registry.svelte.ts`): `get_active_terminal()`, `ensure_active_terminal()` (auto-spawns local via the App-registered opener), and the handle's `run_command(cmd)→{output,exit_code,running}`, `read_buffer(lines)→string`, `send_keys(data)→Promise`, `interrupt()→Promise`. `resolve_keys(keys)` is in `src/lib/structure/terminal-capture.ts`.
- MCP tool wiring: `server_claude_code.py` `TOOLS` + `_handle_*`; `mcp_http.py` imports the handlers and dispatches `elif name == "catgo_X": return await _handle_X(arguments)`.

---

## Task 1: Backend terminal round-trip (`terminal_bridge.py`)

**Files:**
- Create: `server/catgo/routers/terminal_bridge.py`
- Modify: `server/main.py` (register the router)
- Test: `server/tests/test_terminal_bridge.py`

- [ ] **Step 1: Write the failing test** (sync, via `asyncio.run`):

```python
# server/tests/test_terminal_bridge.py
import asyncio
from catgo.routers import terminal_bridge as tb


def test_request_result_round_trip():
    async def go():
        task = asyncio.ensure_future(tb.request_terminal('run', {'command': 'echo hi'}))
        await asyncio.sleep(0)  # let request_terminal register the future
        pending = tb.list_pending()['pending']
        assert len(pending) == 1 and pending[0]['action'] == 'run' and pending[0]['command'] == 'echo hi'
        rid = pending[0]['request_id']
        tb.post_result({'request_id': rid, 'output': 'hi', 'exit_code': 0})
        return await task
    res = asyncio.run(go())
    assert res['output'] == 'hi' and res['exit_code'] == 0
    # after fulfilment the pending list is empty
    assert tb.list_pending()['pending'] == []


def test_post_result_unknown_id_raises():
    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        tb.post_result({'request_id': 'nope'})
```

- [ ] **Step 2: Run it, confirm FAIL** — from `server/`: `python -m pytest tests/test_terminal_bridge.py -q` → import error / function missing.

- [ ] **Step 3: Implement `server/catgo/routers/terminal_bridge.py`**:

```python
"""Terminal round-trip bridge: lets a backend MCP tool drive the renderer's
visible terminal. Mirrors the catrender request/result pattern in view_capture.py
— the backend enqueues a request + awaits a Future; the renderer polls
/terminal/pending, executes via its terminal-registry, and POSTs /terminal/result.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

TERMINAL_TIMEOUT = 120.0  # seconds a `run` waits for the renderer

_pending_terminal: dict[str, asyncio.Future] = {}

router = APIRouter(prefix="/terminal", tags=["terminal-bridge"])


async def request_terminal(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Enqueue a terminal request and await the renderer's result.
    action in {read, run, send_keys, interrupt}. Returns the result dict, or
    {'error': ...} on timeout (no renderer responded)."""
    request_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    _pending_terminal[request_id] = fut
    fut._params = {"request_id": request_id, "action": action, **payload}  # type: ignore[attr-defined]
    try:
        return await asyncio.wait_for(fut, timeout=TERMINAL_TIMEOUT)
    except asyncio.TimeoutError:
        return {"error": "No terminal responded (is a CatGo window open?) — timed out."}
    finally:
        _pending_terminal.pop(request_id, None)


@router.get("/pending")
def list_pending() -> dict[str, Any]:
    return {"pending": [getattr(f, "_params", {}) for f in _pending_terminal.values() if not f.done()]}


@router.post("/result")
def post_result(payload: dict[str, Any]) -> dict[str, str]:
    fut = _pending_terminal.get(payload.get("request_id", ""))
    if fut is None:
        raise HTTPException(status_code=404, detail="No pending terminal request")
    if fut.done():
        raise HTTPException(status_code=409, detail="Already fulfilled")
    fut.set_result(payload)
    return {"status": "ok"}
```

- [ ] **Step 4: Register the router** in `server/main.py`. Near the other `app.include_router(..., prefix="/api")` lines (e.g. after `pty_router`), add an import with the other router imports and:

```python
from catgo.routers.terminal_bridge import router as terminal_bridge_router
...
app.include_router(terminal_bridge_router, prefix="/api")
```

(Place the import where the other `from catgo.routers... import ... router` imports live; place the `include_router` with the others.)

- [ ] **Step 5: Run the test, confirm PASS** — from `server/`: `python -m pytest tests/test_terminal_bridge.py -q` → 2 passed.

- [ ] **Step 6: Commit**

```bash
git add server/catgo/routers/terminal_bridge.py server/main.py server/tests/test_terminal_bridge.py
git commit -m "feat(terminal-bridge): backend request/pending/result round-trip"
```

---

## Task 2: `catgo_terminal` MCP tool

**Files:**
- Modify: `server/catgo/mcp_tools/server_claude_code.py`
- Modify: `server/catgo/routers/mcp_http.py`
- Test: `server/tests/test_terminal_mcp.py`

- [ ] **Step 1: Write the failing test** (monkeypatch `request_terminal`, run handler via `asyncio.run`):

```python
# server/tests/test_terminal_mcp.py
import asyncio
from catgo.mcp_tools import server_claude_code as scc


def _run(args):
    return asyncio.run(scc._handle_terminal(args))


def test_bad_action_rejected():
    out = _run({'action': 'frobnicate'})
    assert 'action must be' in out[0].text


def test_run_formats_output(monkeypatch):
    async def fake_request(action, payload):
        assert action == 'run' and payload == {'command': 'pwd'}
        return {'output': '/home/x', 'exit_code': 0, 'target': 'local shell'}
    monkeypatch.setattr('catgo.routers.terminal_bridge.request_terminal', fake_request)
    out = _run({'action': 'run', 'command': 'pwd'})
    assert '/home/x' in out[0].text and 'exit 0' in out[0].text


def test_denied(monkeypatch):
    async def fake_request(action, payload):
        return {'denied': True}
    monkeypatch.setattr('catgo.routers.terminal_bridge.request_terminal', fake_request)
    out = _run({'action': 'run', 'command': 'rm -rf /'})
    assert 'denied' in out[0].text
```

- [ ] **Step 2: Run it, confirm FAIL** — from `server/`: `python -m pytest tests/test_terminal_mcp.py -q`.

- [ ] **Step 3: Add the tool + handler** to `server_claude_code.py`. Append to `TOOLS` (next to other `Tool(...)`):

```python
    Tool(
        name="catgo_terminal",
        description=(
            "Operate the user's VISIBLE terminal pane (local or HPC) — the same one "
            "they see. Each run/send_keys/interrupt asks the user to approve. Prefer "
            "'run' for non-interactive commands; 'send_keys' to answer prompts / drive "
            "a TUI; 'read' to inspect the current buffer. Output reflects the visible "
            "terminal's cwd / env (NOT your own agent shell)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["read", "run", "send_keys", "interrupt"]},
                "command": {"type": "string", "description": "Shell command (action=run)."},
                "keys": {"type": "string", "description": "Keys to send (action=send_keys), e.g. 'y<enter>', '<c-c>'."},
                "lines": {"type": "number", "description": "Trailing lines to read (action=read, default 40)."},
            },
            "required": ["action"],
        },
    ),
```

Add the handler (near `_handle_campaign`):

```python
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
```

- [ ] **Step 4: Dispatch in `mcp_http.py`.** Add `_handle_terminal,` to the `from catgo.mcp_tools.server_claude_code import ( … )` block, and in `call_tool` add (next to `catgo_campaign`):

```python
            elif name == "catgo_terminal":
                return await _handle_terminal(arguments)
```

- [ ] **Step 5: Run tests + smoke-import** — from `server/`:

```bash
python -m pytest tests/test_terminal_mcp.py -q
python -c "import catgo.routers.mcp_http as m; print('catgo_terminal' in [t.name for t in m.TOOLS])"
```
Expected: 3 passed; prints `True`.

- [ ] **Step 6: Commit**

```bash
git add server/catgo/mcp_tools/server_claude_code.py server/catgo/routers/mcp_http.py server/tests/test_terminal_mcp.py
git commit -m "feat(mcp): catgo_terminal tool drives the visible terminal via the bridge"
```

---

## Task 3: Renderer poller + approval modal

**Files:**
- Create: `desktop/lib/terminal-bridge-poller.svelte.ts`
- Modify: `desktop/App.svelte` (start the poller + render the approval modal)

- [ ] **Step 1: Create the poller** `desktop/lib/terminal-bridge-poller.svelte.ts`:

```ts
/**
 * Global (per-window) poller for SDK-agent terminal requests. The backend
 * `catgo_terminal` MCP tool enqueues a request; this polls /api/terminal/pending,
 * gates run/send_keys/interrupt behind an approval card, executes via the
 * terminal-registry (the real visible PTY), and POSTs /api/terminal/result.
 */
import { API_BASE } from '$lib/api/config'
import { ensure_active_terminal } from '$lib/structure/terminal-registry.svelte'
import { resolve_keys } from '$lib/structure/terminal-capture'

interface TerminalReq { request_id: string; action: string; command?: string; keys?: string; lines?: number }

// Approval state the App modal binds to. When a request needs approval, the
// poller sets `pending` and awaits the promise resolved by allow()/deny().
export const approval = $state<{
  pending: { request_id: string; action: string; detail: string } | null
  auto_run: boolean
  _resolve: ((ok: boolean) => void) | null
}>({ pending: null, auto_run: false, _resolve: null })

export function approval_allow(): void {
  const r = approval._resolve
  approval.pending = null; approval._resolve = null
  r?.(true)
}
export function approval_deny(): void {
  const r = approval._resolve
  approval.pending = null; approval._resolve = null
  r?.(false)
}

function request_approval(action: string, detail: string): Promise<boolean> {
  if (approval.auto_run) return Promise.resolve(true)
  return new Promise((resolve) => {
    approval.pending = { request_id: ``, action, detail }
    approval._resolve = resolve
  })
}

async function handle_one(req: TerminalReq): Promise<void> {
  const mutating = req.action === `run` || req.action === `send_keys` || req.action === `interrupt`
  const detail = req.action === `run` ? (req.command ?? ``) : req.action === `send_keys` ? (req.keys ?? ``) : req.action
  if (mutating) {
    const ok = await request_approval(req.action, detail)
    if (!ok) { await post_result({ request_id: req.request_id, denied: true }); return }
  }
  const h = await ensure_active_terminal()
  if (!h) { await post_result({ request_id: req.request_id, error: `no terminal available` }); return }
  const target = h.is_remote ? `remote (${h.host ?? h.session_id})` : `local shell`
  let result: Record<string, unknown>
  if (req.action === `run`) {
    result = await h.run_command(String(req.command ?? ``))
  } else if (req.action === `read`) {
    result = { output: h.read_buffer(typeof req.lines === `number` ? req.lines : 40) }
  } else if (req.action === `send_keys`) {
    await h.send_keys(resolve_keys(String(req.keys ?? ``)))
    await new Promise((r) => setTimeout(r, 200))
    result = { output: h.read_buffer(40) }
  } else { // interrupt
    await h.interrupt()
    await new Promise((r) => setTimeout(r, 200))
    result = { output: h.read_buffer(40) }
  }
  await post_result({ request_id: req.request_id, target, ...result })
}

async function post_result(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${API_BASE}/terminal/result`, {
      method: `POST`, headers: { 'Content-Type': `application/json` }, body: JSON.stringify(body),
    })
  } catch { /* renderer best-effort */ }
}

let _started = false
let _busy = false
export function start_terminal_bridge_poller(): () => void {
  if (_started) return () => {}
  _started = true
  let active = true
  async function loop() {
    while (active) {
      try {
        if (!_busy) {
          const resp = await fetch(`${API_BASE}/terminal/pending`)
          if (resp.ok) {
            const data = await resp.json()
            const reqs: TerminalReq[] = data?.pending ?? []
            if (reqs.length > 0) {
              _busy = true
              try { await handle_one(reqs[0]) } finally { _busy = false }
            }
          }
        }
      } catch { /* backend down / between reloads — keep trying */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  loop()
  return () => { active = false; _started = false }
}
```

- [ ] **Step 2: Start the poller + render the modal in `App.svelte`.** Add imports:

```ts
  import { start_terminal_bridge_poller, approval, approval_allow, approval_deny } from './lib/terminal-bridge-poller.svelte'
```

Start it once (with the other `$effect`s):

```ts
  $effect(() => start_terminal_bridge_poller())
```

Render the approval modal (near App's other modals, e.g. by the layout-change modal). Use App's existing modal classes:

```svelte
{#if approval.pending}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={approval_deny}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>{t('app.agent_terminal_approve_title')}</h3>
      <p class="agent-term-detail">{approval.pending.action}: <code>{approval.pending.detail}</code></p>
      <label class="agent-term-autorun">
        <input type="checkbox" bind:checked={approval.auto_run} />
        {t('app.agent_terminal_autorun')}
      </label>
      <div class="modal-actions">
        <button class="modal-btn cancel" onclick={approval_deny}>{t('common.cancel')}</button>
        <button class="modal-btn danger" onclick={approval_allow}>{t('app.allow')}</button>
      </div>
    </div>
  </div>
{/if}
```

(If App's modal class names differ, reuse the actual ones — grep `class="modal` in App.svelte. Add minimal CSS for `.agent-term-detail code` / `.agent-term-autorun` if needed.)

- [ ] **Step 3: i18n keys.** Add to `src/lib/i18n/en/app.ts` and `zh/app.ts` (parity): `agent_terminal_approve_title` (en `Agent wants to run in your terminal` / zh `Agent 想在你的终端执行`), `agent_terminal_autorun` (en `Run agent terminal commands without asking (this session)` / zh `本회话内不再询问，自动执行 Agent 终端命令` — use proper zh), `allow` (en `Allow` / zh `允许`) if not already present (check first).

- [ ] **Step 4: Type-check** — `pnpm check 2>&1 | tail -3` → **0 errors**.

- [ ] **Step 5: Commit**

```bash
git add desktop/lib/terminal-bridge-poller.svelte.ts desktop/App.svelte src/lib/i18n/en/app.ts src/lib/i18n/zh/app.ts
git commit -m "feat(terminal-bridge): renderer poller + approval card; agent drives the visible terminal"
```

---

## Task 4: Acceptance — SDK agent drives the visible terminal (live)

**Files:** none. Needs the full dev stack (:3186) + an **SDK agent** (Claude Code) selected in CatBot.

- [ ] **Step 1:** Open a terminal; note its cwd (e.g. `…/pane-tree-impl`). In CatBot (provider = Claude Code), say: "run `pwd` in my terminal".
- [ ] **Step 2:** An approval card appears showing `run: pwd`. Click **Allow**.
- [ ] **Step 3: Assert** the command ran in the **visible** terminal (the prompt shows `pwd` + the cwd `…/pane-tree-impl`, **not** `~/.catgo/agents/claude`) and the agent reports that cwd. (Contrast: before B, Claude Code ran in its own shell.)
- [ ] **Step 4:** Ask it to `read` the terminal (no card); to run a `read -p` prompt then `send_keys 'y<enter>'`; and a denied command (Deny → agent told it was denied). Toggle auto-run and confirm the next command skips the card.
- [ ] **Step 5:** `python -m pytest server/tests/test_terminal_bridge.py server/tests/test_terminal_mcp.py -q` passes; `pnpm check` 0 errors.

---

## Final verification

- [ ] `python -m pytest server/tests/test_terminal_bridge.py server/tests/test_terminal_mcp.py -q` → passes.
- [ ] `python -c "import catgo.routers.mcp_http"` clean; `pnpm check` 0 errors.
- [ ] Merge to `feat/pane-tree-core`.

## Notes / invariants

- Reuses the terminal-registry + `run_command` marker capture + auto-spawn — no new PTY logic.
- Approval lives in the renderer (the `catgo_*` MCP tools are auto-allowed at the bridge); never persisted; `read` is passive (no card).
- No `src/lib/mobile/*` edits.
- Python style 4-space/double-quote; frontend single-quote/no-semicolon/2-space; never `deno fmt`.

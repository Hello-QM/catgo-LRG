# Tab Isolation Architecture — Implementation Plan

**Date:** 2026-04-17
**Status:** Revised after first-round review (2026-04-17 evening)
**Base commit:** `65797ad3` + 4 stash-restored files + runtime fixes (guard, debounce, ThinkingSummary) — to be committed as checkpoint before Phase 1 starts

**Revision notes:** First-round review surfaced 3 HIGH and 2 MEDIUM issues. This revision addresses all of them:
- Phase 3 rewritten from "SDK interceptor" to "per-tab MCP URL routing" (Issue #1)
- Per-tab state audit expanded to include `abort_controller`, `action_handler`, `chat_position` (Issues #2, #4)
- BroadcastChannel fix specified concretely with payload + listener changes (Issue #3)
- Effect cleanup resolution clarified — `action_handler` as a tab-keyed Map supersedes the `inert` concern (Issue #5)
- Agent session abort path detailed (Issue #6)
- Checkpoint commit scope corrected to exclude auto-generated and user-data files (Issue #7)

---

## 1. Problem statement

CatGO's tab UI suggests independent workspaces (users open tabs to work on different structures / workflows), but the underlying state is almost entirely module-global. Opening a second tab causes:

- The chat message thread to be shared across tabs (writes from one tab overwrite the other's conversation)
- The workflow editor to load whichever workflow was last touched, regardless of which tab the user is viewing
- Structure viewer pushes (from MCP tools) to land in whichever tab polls the backend first, stealing updates from other tabs
- Reactive cascades to fire across all tabs for single-tab mutations, causing main-thread saturation and UI freezes

**Goal:** Each tab behaves as an independent session. Opening a second tab creates a fresh chat, a fresh workflow view, a fresh viewer panel, and CatBot work in one tab does not affect another.

---

## 2. Current architecture (from audits)

### 2.1 Tab UI — partially correct
- `desktop/App.svelte` renders tabs via `{#each tm.tabs as tab (tab.id)}` — properly keyed
- `tab-manager.svelte.ts:50-68` creates tabs with unique IDs for structures (`structure-N` counter)
- `tab_states[tab.id]` already stores per-tab pane layout (`desktop/pane-utils.ts:39-46`) — **this is the pattern to extend**
- Components (Structure, WorkflowView, Trajectory) are mounted per-tab via `{@const ts = tab_states[tab.id]}`
- Workflow tabs are artificially capped to 1 instance (`tab-manager.svelte.ts:51-58`) — will need to lift this cap

### 2.2 Module-level state — the core problem (18 variables, revised)

Per-tab candidates (need isolation):

**Chat state** (`src/lib/chat/chat-state.svelte.ts`):
- `chat_messages` (L63) — conversation thread
- `chat_loading` (L69), `chat_error` (L70) — per-conversation flags
- `active_tool_blocks` (L84) — CatBot's live tool call list
- `active_permission_blocks` (L87) — pending permission dialogs
- `structure_context` (L139), `workflow_context` (L142), `paper_context` (L145) — AI system prompt context
- `paper_session` (L148) — imported paper metadata
- `chat_position` (L103) — right / bottom / popout layout [**added post-review**]
- `abort_controller` (L89) — non-`$state` module `let`; cancel in tab A currently kills tab B's stream [**added post-review**]

**Workflow state** (`src/lib/workflow/workflow-state.svelte.ts`):
- `active_workflow` (L47) — open workflow graph
- `pending_navigate_workflow` (L62) — "open this workflow" signal
- `pending_open_structure` (L67) — "open structure in new tab" signal
- `active_project_context` (L72) — current project
- `workflow_reload_seq` (L78) — reload trigger
- `workflow_events` (L90) — step notifications

**Tool executor state** (`src/lib/chat/workflow-tool-executor.ts`):
- `action_handler` (L22-29) — non-`$state` module `let`; single-slot global, last workflow tab to mount overwrites earlier ones [**added post-review**]

Genuinely global (stay as singletons):
- `chat_config` (API keys, model) — shared user preference
- `chat_username` — cosmetic, per-session
- `session_list` — backend-synced
- `hpc_session_store` — shared HPC connections
- Theme, colors, fonts — app-wide UI

**Note on non-`$state` singletons:** The first-round review caught that `abort_controller` and `action_handler` are plain module `let` bindings — not reactive state, so a naive grep for `$state(...)` missed them. They still need tab-scoping because they hold per-conversation / per-editor context that collides across tabs.

### 2.3 panel_id — hardcoded everywhere
- `Structure.svelte:1799` — `let panel_id = $state('default')`, literal string, never changes
- All `tool-handler.ts` HTTP calls use this single value
- Backend `view_state.py` is actually **already per-panel** (`panel_structures: dict[str, dict]`, `panel_pending_updates: dict[str, deque]`) — the infrastructure exists, but frontend never uses it with unique IDs
- MCP tool pushes (`_push_structure_to_viewer`) default to `panel_id="default"`
- Result: pending-update queue is shared across tabs; first-polling tab steals pushes

### 2.4 MCP server — single stateless HTTP process
- `server/catgo/routers/mcp_http.py` — `StreamableHTTPSessionManager(stateless=True)` mounted at `/api/mcp`
- Each tool call is a separate stateless HTTP request; "session" in MCP terms ≠ user session
- Frontend agent bridge passes one `mcpServerUrl = http://localhost:8000/api/mcp` to every SDK query
- MCP tools can accept an explicit `panel_id` argument (the plumbing exists — `server_claude_code.py:456, 533, 668`) — they just default to `"default"` when none is provided
- **Verdict:** no new MCP server processes needed. Panel_id threading through tool calls is sufficient.

---

## 3. Target architecture

### 3.1 Core concept: tab_id as the routing key

Every tab gets a unique `tab_id` at creation (generated via `crypto.randomUUID()` or similar). This `tab_id` becomes:

1. **The panel_id for that tab's viewer** — every structure push, pending-update poll, and MCP tool targeting this tab uses `panel_id = tab_id`
2. **The key in tab-scoped state maps** — `chat_state.get(tab_id)`, `workflow_state.get(tab_id)`
3. **The routing parameter in MCP tool calls** — SDK adapter injects `panel_id: tab_id` into every catgo_* tool call from that tab's ChatPane

### 3.2 Three-layer isolation

**Layer 1 — Identity.** Each tab has a stable unique `tab_id`. Threaded as a prop from `App.svelte` → `Structure.svelte` → `tool-handler.ts` and from `App.svelte` → `WorkflowView.svelte` → `ChatPane.svelte` → SDK stream.

**Layer 2 — State.** Replace module-level `$state` singletons with `Map<tab_id, Slice>` patterns. Components receive their tab_id as a prop and read/write state via `getSlice(tab_id)`. Genuinely-global state remains as top-level exports unchanged.

**Layer 3 — Transport (revised post-review).** The MCP URL itself carries the tab identity, instead of trying to modify tool-call payloads from the frontend. Per-tab URL scheme:

- **Before:** `mcpServerUrl = http://localhost:8000/api/mcp` (one URL for all tabs — the current state)
- **After:** `mcpServerUrl = http://localhost:8000/api/mcp/tab/<tab_id>` (per-tab URL)

The backend `main.py` mounts the MCP handler under a FastAPI path with `{tab_id}` as a path parameter. A small middleware extracts `tab_id` and stores it in a `ContextVar` for the duration of the request. Tool handlers read the `ContextVar` and default `panel_id = tab_id` when the tool input doesn't provide an explicit panel_id. The `/view/workflow/pending-navigate` and `/view/structure/pending-update` channels already accept panel_id — they just need unique values driven by tab_id.

**Why URL-based routing over SDK interception (Issue #1 fix):** The Claude Code / Codex / Gemini SDKs do not expose a hook to mutate tool-call inputs before they're sent to the MCP server. `canUseTool` can allow/deny but not rewrite `input`. The SDKs own the HTTP transport internally. Attempting to inject panel_id from the frontend would require either a proxy-layer rewrite of HTTP request bodies (fragile, per-adapter work) or forking each SDK's transport (unmaintainable). Encoding tab_id in the URL itself is a single backend change — the SDKs don't need to know anything, they just use the URL they're given.

### 3.3 Why this design over alternatives

- **Why not per-tab component trees with fully local state?** Much larger refactor (every import in 40+ files becomes component-local), no meaningful correctness gain, and many components (popout windows, cross-tab broadcast) rely on shared state access patterns that would break.
- **Why not per-tab MCP server processes?** Port management becomes a bottleneck (N tabs = N ports), process startup adds latency, and MCP's stateless HTTP design means a single server can serve multiple tabs cleanly if URL routing is in place.
- **Why not a session-ID routing layer in MCP?** MCP `streamable_http` sessions die when a stream ends, and a new tool call in the same tab starts a new session — the mapping would need to be re-established constantly. Encoding tab_id in the URL path is permanent for the tab's lifetime.
- **Why not SDK interception (originally proposed)?** See the "Why URL-based routing" paragraph above — the SDK APIs don't expose the necessary hooks. This is the Issue #1 fix.

---

## 4. Phased implementation

Each phase is independently shippable. If any phase destabilizes, the previous phase remains functional.

### Phase 1 — tab_id infrastructure + panel_id routing

**Goal:** Each tab has a unique panel_id. Structure viewer pushes land in the correct tab. No state refactor yet — chat and workflow editor still use global state and collide.

**Estimated effort:** 4-6 hours.

**Files to modify (~10):**

1. `desktop/tab-manager.svelte.ts` (L22-68)
   - Generate `tab.tab_id = crypto.randomUUID()` on creation (or use existing `tab.id` if unique)
   - Lift the `workflow` tab cap — allow multiple workflow tabs

2. `desktop/App.svelte` (L1002-1438)
   - Pass `tab_id={tab.id}` prop to Structure, WorkflowView, Trajectory instances

3. `src/lib/structure/Structure.svelte` (L1799)
   - Replace `let panel_id = $state('default')` with `export let tab_id: string` and derive `panel_id = tab_id`

4. `src/lib/structure/controllers/tool-handler.ts`
   - Already uses `deps.panel_id` — verify every HTTP call includes it (audit found 7 call sites, all correct)
   - No logic change, just confirm it's plumbed from the right place

5. `src/lib/workflow/WorkflowView.svelte`
   - Accept `tab_id` prop, pass to ChatPane and WorkflowEditor

6. `src/lib/chat/ChatPane.svelte`
   - Accept `tab_id` prop (will be used in Phase 2 + 3)

7. `src/lib/workflow/WorkflowEditor.svelte`
   - Accept `tab_id` prop (will be used in Phase 2 + 3)

8. Backend `server/catgo/mcp_tools/helpers.py` (`_push_structure_to_viewer`)
   - Surface panel_id as a required parameter (already accepts it with a default) — no change yet, will be used in Phase 3

**Testing:**
- Open two structure tabs, load different structures via MCP's `catgo_fetch` — each tab should show its own structure, no cross-contamination
- Backend logs should show `panel_id=<uuid1>` for tab A and `panel_id=<uuid2>` for tab B
- No regression on single-tab workflow

**Rollback:** revert the ~10 file changes; panel_id falls back to "default" behavior.

### Phase 2 — Tab-keyed state for chat + workflow

**Goal:** Chat and workflow editor operate independently per tab. 15 module-level stores become tab-keyed maps.

**Estimated effort:** 1.5-2 days.

**Design pattern:**

```typescript
// In chat-state.svelte.ts:

interface ChatSlice {
  messages: ChatMessage[]
  loading: boolean
  error: string
  active_tool_blocks: Record<string, ToolEntry>
  active_permission_blocks: Record<string, PermissionEntry>
  structure_context: string
  workflow_context: string
  paper_context: string
  paper_session: PaperSession
  chat_position: 'right' | 'bottom' | 'popout'  // [added post-review]
  abort_controller: AbortController | null       // [added post-review]
}

const EMPTY_CHAT_SLICE: ChatSlice = { /* defaults */ }

// Tab-keyed state
const chat_slices = $state<Map<string, ChatSlice>>(new Map())

export function get_chat_slice(tab_id: string): ChatSlice {
  if (!chat_slices.has(tab_id)) {
    chat_slices.set(tab_id, { ...EMPTY_CHAT_SLICE })
  }
  return chat_slices.get(tab_id)!
}

export function remove_chat_slice(tab_id: string) {
  chat_slices.delete(tab_id)
}

// Genuinely global — stays as singletons
export const chat_config = $state<ChatConfig>({...})
export const chat_username = $state({...})
```

Same pattern in `workflow-state.svelte.ts` with a `WorkflowSlice`.

For the non-`$state` singleton `action_handler` in `workflow-tool-executor.ts`, the refactor replaces the single `let action_handler: WorkflowActionHandler | null = null` with a tab-keyed Map:

```typescript
// In workflow-tool-executor.ts (replaces L22-29):

const action_handlers = new Map<string, WorkflowActionHandler>()

export function register_workflow_action_handler(
  tab_id: string,
  handler: WorkflowActionHandler,
): void {
  action_handlers.set(tab_id, handler)
}

export function unregister_workflow_action_handler(tab_id: string): void {
  action_handlers.delete(tab_id)
}

export function get_workflow_action_handler(
  tab_id: string,
): WorkflowActionHandler | null {
  return action_handlers.get(tab_id) ?? null
}
```

This means multiple `WorkflowEditor` instances (one per tab) can coexist with registered handlers; the tool dispatcher looks up by the `tab_id` it received through the MCP URL path (Phase 3).

**Files to modify (~35-40):**

- `src/lib/chat/chat-state.svelte.ts` — introduce `ChatSlice`, `get_chat_slice()`, `remove_chat_slice()`
- `src/lib/workflow/workflow-state.svelte.ts` — introduce `WorkflowSlice`, `get_workflow_slice()`, `remove_workflow_slice()`
- `src/lib/chat/ChatPane.svelte` — take `tab_id` prop, replace `chat_messages` / `active_tool_blocks` / etc. with `get_chat_slice(tab_id).*`
- `src/lib/chat/workflow-tool-executor.ts` — accept `tab_id`, read slice
- `src/lib/workflow/WorkflowEditor.svelte` — take `tab_id`, use `get_workflow_slice(tab_id)`
- `src/lib/structure/controllers/tool-handler.ts` — thread tab_id where it reads workflow state
- `desktop/App.svelte` — on tab close, call `remove_chat_slice(tab_id)` + `remove_workflow_slice(tab_id)` + `unregister_workflow_action_handler(tab_id)`
- `src/routes/api/agent/stream/+server.ts` — **[added post-second-review]** pass `request.signal` as `abortSignal` into `adapter.stream({ ..., abortSignal: request.signal })`. The adapter layer (`claude.ts:120-123` and equivalents) already wires `abortSignal` into its own controller; the SvelteKit route is the missing link. Without this, `abort_controller.abort()` on the frontend has no effect on the backend stream.
- **Effect audit** — before refactor, grep `WorkflowEditor.svelte` and `ChatPane.svelte` for any other global subscriptions registered inside `$effect` (e.g. WebSocket listeners, long-polling intervals, BroadcastChannel consumers) and give them the same tab-keyed-Map treatment as `action_handler`. Known so far: only `action_handler` is cross-tab-colliding; a full grep is cheap insurance.
- ~30 smaller files that import these states — replace bare imports with `get_slice(tab_id)` calls

**Testing:**
- Open 2 chat tabs, send different messages in each — threads stay separate
- Generate workflows in each tab — canvases show only their own nodes
- `active_tool_blocks` renders only that tab's in-flight tools
- BroadcastChannel popouts still receive correct tab's context

**Rollback:** Single-commit revert returns to singletons; Phase 1 still functional.

### Phase 3 — Per-tab MCP URL routing (revised post-review)

**Goal:** When CatBot in tab A calls any `catgo_*` tool, the backend automatically routes the panel_id to tab A, so viewer pushes and workflow pushes land in tab A. Cross-tab leakage becomes impossible at the tool boundary.

**Estimated effort:** 3-4 hours (down from 4-6 because URL routing is simpler than SDK interception).

**Design:** Each tab's chat constructs a per-tab MCP URL: `http://localhost:${port}/api/mcp/tab/<tab_id>`. The SDK uses this URL as-is and makes requests to it. A FastAPI route extracts the tab_id path parameter. A `ContextVar` carries tab_id into tool handlers. Tools default `panel_id = tab_id` when no explicit panel_id is in the input.

**FastAPI implementation note (post-second-review):** `app.mount()` prefix-strips but does not parse path parameters — so a mount at `/api/mcp/tab/{tab_id}` would not work. Correct approach: use `@router.api_route("/mcp/tab/{tab_id}/{path:path}", methods=["GET", "POST"])` with a catchall for the rest of the MCP subpath, explicitly extract `tab_id` from the path, set the ContextVar, then delegate the request into `session_manager.handle_request(request)`. The existing `app.mount("/api/mcp", mcp_asgi_app)` stays as a backwards-compat alias that sets `tab_id = "default"`.

**Files to modify (~6):**

1. `server/main.py` and `server/catgo/routers/mcp_http.py`
   - Add new `@router.api_route("/mcp/tab/{tab_id}/{path:path}")` that sets ContextVar then calls `session_manager.handle_request(request)`
   - Keep existing `/api/mcp` mount as a fallback alias that uses `tab_id = "default"`

2. `server/catgo/routers/mcp_http.py` — middleware
   - Extract `tab_id` from the path parameter
   - Store in a `contextvars.ContextVar[str]` named e.g. `current_tab_id`
   - `ContextVar` is the Python-native way to carry per-request context through async code — inherited by all awaited tool handlers without explicit passing

3. `server/catgo/mcp_tools/helpers.py::_push_structure_to_viewer` and `_push_workflow_navigate`
   - Default `panel_id` parameter to `current_tab_id.get("default")` (read from the ContextVar)
   - Remove hardcoded `panel_id = "default"` defaults

4. `server/catgo/mcp_tools/server_claude_code.py` and `server/catgo/mcp_tools/server.py`
   - Every tool that accepts optional `panel_id` input defaults to the ContextVar value instead of `"default"`

5. `src/lib/chat/chat-state.svelte.ts::send_message`
   - Build the tab-specific URL: `mcpServerUrl = ${API_BASE}/mcp/tab/${tab_id}` and pass to `stream_sdk_agent`
   - `tab_id` flows in as a prop from ChatPane (Phase 1 already plumbed this)

6. `src/lib/server/agent-bridge/adapters/claude.ts`, `codex.ts`, `gemini.ts`
   - Change the fixed `/api/mcp` URL to whatever `stream()` receives via `mcpServerUrl`
   - (Trivial — they already accept a url parameter; just remove the hardcoded default)

**Testing:**
- CatBot in tab A fetches Pt → tab A's viewer shows Pt, tab B unchanged
- CatBot in tab A builds a workflow → workflow appears in tab A's editor, not tab B's
- Rapid switching between tabs while MCP is running doesn't cause cross-contamination
- Backwards-compat URL `/api/mcp` still works and uses panel_id="default"

**Rollback:** Revert FastAPI mount change; MCP tools fall back to the single endpoint and panel_id="default" behavior.

---

## 5. Testing checklist (end-to-end)

After all three phases:

- [ ] Open 3 tabs simultaneously
- [ ] Tab 1: load Pt via MCP, build geo_opt workflow
- [ ] Tab 2: load H2O via MCP, build bulk relaxation workflow
- [ ] Tab 3: load Cu slab manually, no workflow
- [ ] Each tab's viewer shows its own structure, no contamination
- [ ] Each tab's chat has its own history
- [ ] Each tab's workflow editor shows only its own graph
- [ ] Switching between tabs doesn't reset or reload state
- [ ] Closing a tab cleans up its slices (verify via devtools that Map sizes shrink)
- [ ] No main-thread freeze on any tab during parallel CatBot sessions
- [ ] Popout chat still works and shows the correct tab's context

## 6. Known risks (revised post-review)

1. **Popout chat windows — BroadcastChannel needs source identity** (Issue #3 fix).
   - Current problem: `broadcast_chat_context()` at `src/lib/chat/chat-state.svelte.ts:113-136` posts `{structure, workflow, paper}` with no source field. `listen_chat_context()` accepts any message on the `catgo-chat-context` channel with no filter logic.
   - Concrete fix:
     - Modify `broadcast_chat_context(source_tab_id: string)` to include `source_tab_id` in the payload.
     - Modify `listen_chat_context(expected_tab_id: string)` to compare `msg.source_tab_id === expected_tab_id` and drop mismatches.
     - Popout window receives its `tab_id` via URL param (`?tab_id=...`) when opened, passes it to `listen_chat_context()`.
     - Main window passes its current `tab_id` to `broadcast_chat_context()` whenever it sends.
   - This lives in Phase 2 (bundled with per-tab state).
   - **Bonus:** This is also being patched as a **standalone pre-Phase-1 fix** tonight so the popout behavior is correct even before the refactor — using a random per-window UUID as source_id in the interim, swapping to tab_id when Phase 1 lands.

2. **Effect cleanup on tab close** (Issue #5 fix).
   - Current problem: `desktop/App.svelte:1002-1438` hides inactive tabs with `inert` (keeps them mounted) rather than `{#if}` (unmounting). So `$effect` cleanup never runs. `WorkflowEditor.svelte:1891-1908` calls `register_workflow_action_handler(handler)` on mount — with two workflow tabs, whichever mounts last wins, and the earlier tab's closure stays live and inaccessible.
   - Concrete fix: make `action_handler` in `workflow-tool-executor.ts:22-29` a `Map<tab_id, WorkflowActionHandler>` instead of a single `let`. `register_workflow_action_handler(tab_id, handler)` stores per-tab. The tool dispatcher routes to the correct handler via the tab_id it received from chat-state (Phase 3 URL routing makes this tab_id available server-side).
   - This supersedes the original "maybe unmount with `{#if}`" suggestion — keeping `inert` is fine once handlers are tab-keyed.

3. **Agent session continuation on tab close / tab switch** (Issue #6 fix).
   - Current problem: `agent_sessions: Record<string, string>` maps `agent_name → session_id` globally. Closing tab A while an SDK stream is in flight orphans the stream — the SvelteKit route in `src/routes/api/agent/stream/+server.ts` keeps running, burning tokens for work no UI will ever display.
   - Concrete fix:
     - Key `agent_sessions` by `(tab_id, agent_name)`.
     - When `remove_chat_slice(tab_id)` is called (on tab close), fire the tab's `abort_controller.abort()`. This signals the fetch request driving the agent stream.
     - The SvelteKit route listens for `AbortSignal` on the incoming request — when aborted, it tells the SDK to cancel (SDK adapters expose `signal` in their stream params; we pass through).
     - Documented as best-effort: if the SDK has already started a tool call, the tool may run to completion server-side before the abort propagates.
   - This is also being patched as a **standalone pre-Phase-1 fix** tonight so window-close aborts work even before the refactor.

4. **Stateless MCP + panel_id mismatch.** If a tool is already running when the tab is closed, its response has no tab to land in. Backend silently drops the push. Risk #3's abort signaling mitigates this in most cases; for edge cases (tool already in-flight), we log but don't crash.

5. **Migration of existing workflows in progress.** If a user has a workflow actively running when this deploys, the 2s updated_at poll still works as a fallback, so no data loss. Live-sync may skip one cycle during the deploy window.

## 7. Checkpoint commit (revised post-review)

Before Phase 1 starts, commit **only** these 7 source files:

- `src/lib/chat/chat-state.svelte.ts` (stash restored + guard added)
- `src/lib/chat/llm-client.ts` (stash restored)
- `src/lib/chat/workflow-tools.ts` (stash restored — `plan_and_build_workflow` tool)
- `src/routes/api/agent/stream/+server.ts` (stash restored — systemPrompt plumbing)
- `src/lib/workflow/WorkflowEditor.svelte` (debounce added)
- `src/lib/chat/ThinkingSummary.svelte` (new, compact tool-call summary)
- `src/lib/chat/ChatPane.svelte` (wired in ThinkingSummary)

**Explicitly exclude** (Issue #7 fix):
- `src/lib/chat/docs-chunks.json` — auto-generated by a script; regenerable, should not be committed as part of this fix. Leave modified or regenerate cleanly.
- `server/catgo/data/catgo_results.db` — user experimental data (workflow runs, structures). Binary, not appropriate for source control in this commit. Should already be in `.gitignore`; if not, add it.
- Other pre-existing modified files in the working tree (e.g., `.claude/settings.local.json`, `server/workflow/engines/analysis.py`, `server/workflow/node_sets.py`, `desktop/App.svelte`, `src/lib/workflow/node-definitions.ts`) — these are unrelated in-progress work; stash separately or commit under their own topic in a separate commit.

Commit message: `fix: live-sync for MCP workflow mutations + compact thinking summary`

This gives a clean baseline to fall back to if the multi-phase refactor hits issues, without dragging in unrelated drift.

**Preflight:**
```bash
git status --short   # verify exactly which files are staged
git diff --cached    # eyeball the 7 files before committing
```

---

## 8. Approval gate

This plan assumes user approval at three points:

1. Before Phase 1 begins (plan + review sign-off, checkpoint committed)
2. After Phase 1 lands and is tested (decide whether to proceed to Phase 2)
3. After Phase 2 lands and is tested (decide whether to proceed to Phase 3)

Each phase is shippable independently — we can stop at Phase 1 (partial isolation, good for structure tabs but chat still shares) if the Phase 2 scope feels too large to tackle in the current timeframe.

# CatBot Client-Side Tool-Calling — Design

**Date:** 2026-05-26
**Branch:** `feat/catbot-client-side-tools`
**Status:** Approved design, pending implementation plan

## Goal

Make CatBot fully usable in a **pure-frontend (`STATIC_ONLY`) deployment** with only a
user-supplied LLM API key — including **structure manipulation** — with no Python backend
in the chat or tool-execution path.

Today, CatBot has three transport realities:

1. **SDK-agent path** (`stream_sdk_agent`) — Claude/Codex/Gemini CLI run **server-side**,
   call `mcp__catgo__*` tools in Python, push results back to the viewer over HTTP/SSE.
   Requires the Python backend.
2. **Universal path** (`stream_chat` → `/chat/stream-universal`) — even this "direct-API"
   path is **not** direct: the browser POSTs to the backend, which proxies to the provider.
   Text-only — it does **not** parse or execute tool calls.
3. **`STATIC_ONLY` mode** — a real build flag (`__CATGO_STATIC_ONLY__`). In this mode a
   `window.fetch` shim intercepts every call to the backend (`SERVER_URL`/`API_BASE`) and
   returns a 503. `pubchem.ts` / `optimade.ts` already detect `STATIC_ONLY` and fetch
   **client-side** instead. CatBot chat currently **breaks** in this mode because
   `/chat/stream-universal` is intercepted.

The structure-manipulation engine is **already client-side**: `ferrox-wasm.ts` (Rust→WASM,
sources in `extensions/rust/src/`) exposes slab generation (`generate_slab`,
`generate_slab_layers`, `slab_termination_info`, `miller_to_normal`), adsorbate site finding
(`adsorbate_find_sites`), supercell, defects, distortions (strain), symmetry/primitive,
bonding, XRD, neighbor lists, interpolation, perturbation, MOF analysis, and more.
"Fetch" (OPTIMADE/PubChem) is plain HTTP the browser can do directly.

The missing piece is **wiring**: a client-side agentic tool-calling loop that calls the LLM
provider directly, exposes the ferrox surface as tools, executes them in the browser, and
feeds results back.

## Non-Goals (YAGNI)

- A *Python* backend in the chat/tool path. (A thin edge CORS relay — see below — is in
  scope and does **not** count as a backend: zero-ops, no Python, runs on existing
  Cloudflare Worker infra.)
- Migrating the SDK or universal paths. They remain unchanged.
- Packmol bulk-liquid fill, POTCAR/vaspkit, DFT/HPC execution — genuinely backend/binary
  work, out of scope and unrelated to client-side structure manipulation.
- Anthropic `tool-use` format. First pass targets OpenAI-compatible function-calling only.

## Design Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Provider format | OpenAI-compat function-calling | One code path covers DeepSeek / Qwen(通义) / Kimi(Moonshot) / Zhipu(智谱) / OpenAI + Gemini compat. Most Chinese providers allow browser CORS. |
| Tool scope | Full ferrox surface | Engine already exists; expose viewer ops + full structure-manipulation set. |
| Approval UX | Reuse `PermissionCard`; auto-approve reads | Mutating ops gated; pure reads (fetch/symmetry/XRD/distance/info) auto-run. Matches existing UX, safe on destructive edits. |
| CORS-blocked origins | Thin Cloudflare Worker relay | Measured (2026-05-26): MP OPTIMADE (`optimade.materialsproject.org`) returns **no** `Access-Control-Allow-Origin` even for `localhost` → browser-direct fetch blocked. Alexandria / odbx return `ACAO: *` (fine direct). Some LLM provider chat endpoints likewise block browser CORS. A pure-passthrough Worker (no Python, existing wrangler infra) fixes both. |

## Architecture

```
ChatPane.svelte (UI — unchanged)
  └─ chat-state.send()           ← add a THIRD branch: "client-direct"
       ├─ agent branch (SDK)            — unchanged
       ├─ universal branch (backend proxy) — unchanged
       └─ ★ client-direct branch (new)
            └─ tool-loop.ts  (agentic multi-turn orchestration)
                 ├─ client-llm.ts        browser → provider /chat/completions, function-calling
                 ├─ permission gate       reuse active_permission_blocks / PermissionCard
                 └─ structure-tools.ts   ToolDefinition[] + ToolExecutor → ferrox WASM / current-structure

  CORS-blocked targets (MP OPTIMADE, some LLM endpoints) route through:
    cors-relay Worker (Cloudflare, pure passthrough, host-allowlisted)
```

### When the client-direct branch activates

- `STATIC_ONLY === true` **and** provider is a non-SDK (OpenAI-compat) provider, **or**
- an explicit config flag (e.g. `chat_config.client_direct === true`) for users who want
  browser-direct calls even when a backend is present.

Selection logic lives in `chat-state.send()`, alongside the existing
`agent_from_provider()` / `SDK_PROVIDERS` checks.

## New Modules (single responsibility each)

| Module | Responsibility | Depends on |
|---|---|---|
| `src/lib/chat/client-llm.ts` | Browser-direct transport: build OpenAI function-calling request (messages + `tools`), `fetch` to `${base_url}/chat/completions`, parse streamed `delta.content` and assembled `tool_calls`. Yields a typed event stream (`text` / `tool_calls` / `done` / `error`). | provider base_url + api_key from `ChatConfig` |
| `src/lib/chat/structure-tools.ts` | Define `ToolDefinition[]` for the full ferrox surface + the viewer tools already in `tools.ts`; provide a `ToolExecutor` registry mapping tool name → async fn that calls ferrox-wasm / current-structure controllers and returns a JSON result string. Tag each tool `read` or `mutate`. | `ferrox-wasm.ts`, `current-structure.svelte.ts`, `pubchem.ts`, `optimade.ts` |
| `src/lib/chat/tool-loop.ts` | Agentic loop: send messages+tools via `client-llm`; on `tool_calls`, gate each (auto-run reads; await `PermissionCard` for mutates), execute via registry, append `role:tool` results, re-call until the model returns no tool calls; surface `tool_start`/`tool_end`/`permission_request` events compatible with `chat-state`'s existing switch. | `client-llm.ts`, `structure-tools.ts`, permission state |
| `workers/cors-relay/` (+ `wrangler.relay.toml`) | Cloudflare Worker, pure passthrough for CORS-blocked targets (MP OPTIMADE, CORS-blocked LLM endpoints). Host-allowlisted, forwards method/body/whitelisted-headers, returns `ACAO: *`, handles preflight. No logging, no key persistence. | Cloudflare Workers runtime |

### Reuse (no new copies)

- `tools.ts` `TOOL_DEFINITIONS` (12 viewer tools) — fold into the registry, keep exports.
- `PermissionCard.svelte` + `active_permission_blocks` / `active_tool_blocks` slices.
- `current-structure.svelte.ts` store (`get`/`set` structure → viewer auto-rerenders).
- `ferrox-wasm.ts` wrappers (lazy WASM init already handled).
- `pubchem.ts` / `optimade.ts` (already client-side under `STATIC_ONLY`).

## Data Flow (one user turn)

1. `send()` detects client-direct mode → `tool_loop.run({ messages, tools, signal })`.
2. `client-llm` POSTs to `${base_url}/chat/completions` with `tools` schema + `stream:true`.
3. Stream yields text deltas (rendered live) and/or assembled `tool_calls`.
4. For each tool call:
   - **read** tool → execute immediately.
   - **mutate** tool → push a `permission_request`; render `PermissionCard`; await
     user decision (respect the existing session "allow-all" toggle).
5. Executor runs ferrox WASM / controller → writes the new structure to `current_structure`
   (viewer re-renders instantly). Returns a JSON result string.
6. Append each result as a `role:tool` message → loop back to step 2.
7. When the model returns no tool calls → emit final assistant text → done.

## Tool Classification (read vs mutate)

- **read (auto-run):** `fetch_*` (OPTIMADE/PubChem), `get_spacegroup`, `get_primitive`,
  `get_distance`/`get_distance_matrix`, `get_neighbor_list`, `get_composition`/formula,
  `compute_xrd`, `compute_d_spacing`, `detect_bonds_*`, `crystal_nn`, `get_structure_info`,
  `get_selection`.
- **mutate (needs approval):** `generate_slab` / `generate_slab_layers`, adsorbate place,
  `make_supercell`, doping/substitution, defects, strain/distortion, `translate_sites`,
  `perturb_structure`, `wrap_to_unit_cell`, `reorient_lattice`, add/delete/replace/move atom,
  `merge_structures`, `optimize_structure_uff`.

## Key / CORS Handling

- API key from `chat_config.api_key` (already persisted client-side via settings panel).
- Provider `base_url` from `ChatConfig` (per-provider endpoints already modeled for
  `custom`/`ollama`; extend the known-provider table with browser-direct endpoints).
- CORS routing — two tiers:
  - **Direct** when the target sets permissive `ACAO` (Alexandria / odbx / MC3D / OMDB
    OPTIMADE providers, PubChem, and OpenAI-compat LLM endpoints that allow browser
    origins, e.g. DeepSeek / Moonshot / Zhipu in most cases). Browser fetches the origin
    directly — no relay hop.
  - **Via relay** when the target blocks browser CORS. Confirmed: **Materials Project
    OPTIMADE**. The browser fetches `${RELAY_URL}/?url=<encoded target>` instead; the
    Worker forwards the request (preserving method/body/auth headers) and returns the
    response with `Access-Control-Allow-Origin: *`.
- A per-target `needs_relay` flag (small allowlist, default direct) decides the path so we
  never add a relay hop where it isn't needed. MP is on the relay list from day one.

## CORS Relay Worker

A new Cloudflare Worker (`workers/cors-relay/` + a `wrangler.relay.toml`), pure passthrough:

- Accepts `GET ?url=<encoded>` and `POST ?url=<encoded>` (POST for LLM chat endpoints).
- Forwards method, body, and a **strict allowlist** of forwardable headers
  (`Authorization`, `X-Api-Key`, `Content-Type`, `Accept`) to the target.
- Returns the upstream response with `Access-Control-Allow-Origin: *` and handles the
  `OPTIONS` preflight.
- **Target allowlist** (env-configured): only forwards to known hosts
  (`optimade.materialsproject.org`, configured LLM endpoints). Refuses arbitrary URLs so
  the relay can't be abused as an open proxy.
- No request/response body logging; no key persistence — keys pass through in-flight only.

Security note: a relay that forwards `Authorization` is sensitive. The host allowlist +
no-logging + forward-only-known-headers keep it from becoming an open credential proxy.
Users who object can run desktop/backend mode instead (keys never touch the edge).

## Error Handling

- Network/CORS failure → typed `error` event → inline chat warning, mirrors existing
  `parse_sse` warning style ("> ⚠️ …").
- WASM executor throw → caught, returned as a tool result with `{ error: "…" }` so the
  model can react, **not** a hard loop abort.
- Missing structure / no active panel for a mutate tool → tool result error string.
- Loop guard: cap tool-call iterations (e.g. 25) to prevent runaway loops; abort on
  `AbortSignal` (reuse `slice.abort_controller`).

## Testing

- `structure-tools` executors (vitest): each tool — mock input → assert ferrox-wasm call +
  resulting `current_structure` mutation + JSON result shape.
- `tool-loop` (vitest): mock `client-llm` emitting `tool_calls` → assert execution order,
  read-vs-mutate gating, `role:tool` result re-injection, termination, iteration cap, abort.
- `client-llm` parsing (vitest): mock SSE chunks → assert text-delta + `tool_calls`
  assembly (including split-across-chunk argument fragments) + `[DONE]` handling.
- CORS relay routing (vitest): assert `needs_relay` targets (MP) get rewritten to
  `${RELAY_URL}/?url=…` while open targets (Alexandria/odbx/PubChem) fetch directly.
- CORS Worker (`workers/cors-relay`): unit-test host-allowlist enforcement (reject
  non-allowlisted URL), header forwarding/stripping, preflight `OPTIONS`, `ACAO: *` on
  responses. Run with the Worker test runner (vitest + `@cloudflare/vitest-pool-workers`
  or miniflare), separate from the app suite.
- Run app tests via `rtk proxy pnpm exec vitest` (RTK serves stale vitest cache otherwise).

## Engineering Constraints

- Work on branch `feat/catbot-client-side-tools` — never on `main`.
- No regression to SDK or universal paths — only add the third branch.
- Subagents (if dispatched) use opus 4.7.

## Open Questions (resolve during planning, not blockers)

- Exact `ChatConfig` field name / UI affordance to opt into client-direct when a backend
  is present (vs. auto-on under `STATIC_ONLY`).
- Whether to also expose workflow tools (`workflow-tools.ts`) in the client-direct loop, or
  scope this strictly to structure ops first. Leaning structure-only first (workflow
  execution still needs the backend, so workflow CRUD without a runner is low value).

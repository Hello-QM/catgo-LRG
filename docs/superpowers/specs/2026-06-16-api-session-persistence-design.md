# API (Client-Direct) Session Persistence — Design Spec

**Date:** 2026-06-16
**Status:** SHIPPED — but **PIVOTED during implementation** (commit 23e0930). See note below.
**Branch target:** `feat/pane-tree-core`

> **⚠️ Implementation pivot (2026-06-16):** During build we found CatGo *already* has a
> client-side session system — `session_list` + `persist_session_messages`/`load_session_messages`
> (localStorage), surfaced in the Sessions tab (`all_sessions`, resume/delete). The only gap was
> that the round-end persist keyed off `agent_from_provider(provider)` → **null for API providers**,
> so API rounds were skipped. So instead of the IndexedDB store below, we **extended the existing
> system**: API rounds mint a per-tab id, call `record_session` + `persist_session_messages`, set it
> on resume, reset on `new_session`, and `ChatPane` auto-restores the newest API session on mount.
> No new store, no new dependency, ~49 lines. The IndexedDB design below is retained for reference
> only — the localStorage cap (400 msgs/session) is accepted (same as SDK sessions). If that cap
> ever bites, migrating *all* sessions to IndexedDB is the principled follow-up.

## Goal

Make **client-direct (API) chat sessions persist**. Today, SDK-agent chats (Claude Code / Codex / Gemini) are saved on the backend and listed in the **Sessions** tab; client-direct chats (DeepSeek / Qwen / Kimi / Zhipu / custom OpenAI-compat) live only in the in-browser `chat-state` slice (`messages = $state({ list })`) and vanish on reload. Persist them to a browser-local IndexedDB store, auto-restore the active tab's last session, and surface them in the same Sessions tab.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Storage | **Browser-local IndexedDB** (works offline / static mode; no backend; handles large histories). |
| UI surface | **Merge into the existing Sessions tab**, mixed with SDK sessions, **most-recent-first** (`last_active`). |
| Restore | **Auto-restore** the tab's last session on reload + **manual switch** from the Sessions tab; **New** starts fresh. |
| Tests | **No new dependency** — pure-logic unit tests + live browser verification (keep IndexedDB calls a thin shell). |

## Why IndexedDB (not localStorage / backend)

Client-direct mode runs entirely in the browser (works under `STATIC_ONLY`, no backend). A backend store would break that and need new endpoints. localStorage caps ~5 MB and chat histories can exceed it. IndexedDB is browser-local, large, and matches the existing `src/lib/plugins/storage.ts` pattern (a `PluginStorage` class: `indexedDB.open`, keyPath stores, transaction get/put/delete, exported singleton).

## Components

### 1. `src/lib/chat/local-session-store.ts` (new)

Thin IndexedDB wrapper mirroring `plugins/storage.ts`. DB `catgo-chat`, object store `sessions` (`keyPath: 'id'`), index on `tab_id` and `last_active`.

```ts
export interface LocalSessionRecord {
  id: string          // 'local-<timestamp>-<rand>'
  tab_id: string      // chat slice id (per chat tab)
  provider: string    // LLMProvider id, e.g. 'deepseek'
  model: string
  topic: string       // first user message, truncated ~80 chars
  created_at: number   // Unix ms
  last_active: number  // Unix ms
  messages: ChatMessage[]
}

// All async; every method resolves to a safe default if IndexedDB is unavailable.
save_local_session(rec: LocalSessionRecord): Promise<void>
list_local_sessions(): Promise<LocalSessionRecord[]>
load_local_session(id: string): Promise<LocalSessionRecord | null>
delete_local_session(id: string): Promise<void>
get_last_session_for_tab(tab_id: string): Promise<LocalSessionRecord | null> // newest by last_active
```

A pure, exported helper (unit-tested, no IndexedDB):

```ts
to_session_summary(rec: LocalSessionRecord): SessionSummary
// { session_id: rec.id, agent: 'local', topic: rec.topic, created_at, last_active,
//   message_count: rec.messages.length, model: rec.model }
function topic_from_messages(messages: ChatMessage[]): string // first user text, ≤80 chars, '' if none
```

### 2. Save hook — `chat-state.svelte.ts`

- Add per-slice state `local_session_id = $state({ value: '' })` (mirrors the existing `skip_permission` slice-state shape).
- After a **client-direct** turn completes (the `done` event handling after `run_tool_loop`, ~line 811): call `persist_local_session(slice, chat_config)`:
  - If `slice.local_session_id.value` is empty, mint `id = 'local-' + Date.now() + '-' + rand` and set it; set `created_at = now`.
  - Build the `LocalSessionRecord` from `slice.messages.list`, `chat_config.provider`/`.model`, `topic_from_messages(...)`, `last_active = now`, and `save_local_session(rec)`.
  - Skip entirely when `slice.messages.list` is empty or the provider is SDK (SDK has its own backend sessions).
- `new_session` for a client-direct tab clears `slice.messages.list` and resets `slice.local_session_id.value = ''`.

### 3. Auto-restore — `ChatPane.svelte` (mount)

On mount, for a client-direct provider, if `slice.messages.list` is empty and `slice.local_session_id.value` is empty:
- `const rec = await get_last_session_for_tab(tab_slice_id)`; if found, set `slice.messages.list = rec.messages` and `slice.local_session_id.value = rec.id`.
- Guarded so it runs once (an `$effect` with a `restored` flag), and never clobbers a non-empty conversation.

### 4. Sessions-tab merge — `ChatPane.svelte`

The Sessions tab already builds `backend_sessions` (SDK, via `GET /chat/sessions/{agent}`). Add:
- `let local_sessions = $state<SessionSummary[]>([])` + `async function fetch_local_sessions() { local_sessions = (await list_local_sessions()).map(to_session_summary) }`. Call it alongside `fetch_backend_sessions` whenever the Sessions tab opens.
- Render a **single merged list** = `[...backend_sessions, ...local_sessions]` sorted by `last_active` desc. A small tag distinguishes a `'local'`-agent row (label `t('chat.session_api')` → "API"), versus the existing CLI-agent tag.
- **Resume** a local row: `const rec = await load_local_session(id)`; set `slice.messages.list = rec.messages`, `slice.local_session_id.value = rec.id`, switch to the Chat tab. (SDK rows keep their existing `resume_session` path.)
- **Delete** a local row: `await delete_local_session(id)` + refresh `local_sessions`. (SDK rows keep `delete_session`.)

### 5. i18n

Add `session_api` (en: `API`, zh: `API`) to `src/lib/i18n/{en,zh}/chat.ts` for the row tag. Keep en/zh key sets in parity.

## Data flow

- **Save:** send → client-direct `run_tool_loop` → `done` → `persist_local_session` upserts the record (id stable across the conversation).
- **Restore:** ChatPane mounts (client-direct, empty slice) → `get_last_session_for_tab` → populate.
- **Switch / manage:** Sessions tab → click a local row → `load_local_session` → populate; delete/new as above.

## Error handling / edge cases

- **IndexedDB unavailable** (private mode / SSR): every store method catches and resolves to a no-op / empty / null. Chat works, just without persistence. The store guards `typeof indexedDB === 'undefined'`.
- **API key never persisted** — records hold only `ChatMessage` content; the key lives in memory (`set_api_key`, never serialized), consistent with the existing security rule.
- **Provider switch** within a tab (API → SDK): SDK uses its own sessions; the local record stays in IndexedDB and still lists in the Sessions tab. No cross-contamination.
- **Multi-window:** IndexedDB is shared per-origin; the list reflects all; concurrent writes are last-write-wins (acceptable for chat history).
- **SDK sessions untouched** — their fetch/resume/delete paths are unchanged; only the Sessions list gains the merged local rows.
- **Mobile (D8):** all changes live in `src/lib/chat/*` (shared) — no `src/lib/mobile/*` edits. IndexedDB works in the mobile WebView, so mobile client-direct chats persist too, for free.

## Testing

- **Unit (vitest, no new dep):** `to_session_summary` mapping; `topic_from_messages` (first user text, truncation, empty → ''); the upsert/merge + sort logic (a pure `merge_session_lists(backend, local)` helper that concatenates and sorts by `last_active` desc).
- **Live browser:** client-direct provider → send 2 messages → reload → conversation auto-restored; open Sessions tab → the session is listed (API tag, newest first) → **New** clears it → resume the saved one restores it → delete removes it.

## File summary

| File | Change |
|---|---|
| `src/lib/chat/local-session-store.ts` | **new** — IndexedDB wrapper + pure `to_session_summary`/`topic_from_messages`/`merge_session_lists` |
| `src/lib/chat/chat-state.svelte.ts` | per-slice `local_session_id`; `persist_local_session` on client-direct `done`; `new_session` resets it |
| `src/lib/chat/ChatPane.svelte` | auto-restore on mount; `fetch_local_sessions` + merged/sorted Sessions list; resume/delete local rows |
| `src/lib/i18n/{en,zh}/chat.ts` | `session_api` tag (parity) |
| `tests/vitest/local-session-store.test.ts` | **new** — pure helpers (mapping/topic/merge-sort) |

## Out of scope

- Cross-device sync (would need a backend store) — browser-local only.
- Exporting / importing chat histories.
- Persisting SDK-agent sessions differently (they already persist on the backend).

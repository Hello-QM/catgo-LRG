# API (Client-Direct) Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist client-direct (API) chat histories to browser-local IndexedDB so they survive reload, auto-restore the tab's last session, and list/resume/delete them in the merged Sessions tab.

**Architecture:** A thin IndexedDB store (`local-session-store.ts`, mirroring `plugins/storage.ts`) holds `{id, tab_id, provider, model, topic, created_at, last_active, messages}` records. `chat-state` upserts the current session after every non-SDK turn; `ChatPane` auto-restores on mount and merges local sessions into the existing Sessions list (most-recent-first). Pure helpers are unit-tested; the IndexedDB path is browser-verified (no new dep).

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript, IndexedDB, vitest. Style by hand: single quotes, **no semicolons**, 2-space indent. **Never run `deno fmt`.**

**Spec:** `docs/superpowers/specs/2026-06-16-api-session-persistence-design.md`

**Confirmed anchors:**
- `ChatSlice` interface + `make_chat_slice()` (chat-state.svelte.ts:203-275); slice fields are `{value}`/`{list}`/`{entries}` wrappers (e.g. `skip_permission = $state({ value: false })`).
- `send_message`'s `finally` block (~chat-state.svelte.ts:864) runs after every path; `chat_config` (with `.provider`/`.model`) and `tab_id` and `slice` are in scope there. `SDK_PROVIDERS` (a `Set<LLMProvider>`) is imported in chat-state from `./types`.
- `new_session(agent?, tab_id='default')` (chat-state.svelte.ts:1089) clears `slice.messages.list`.
- `SessionSummary` (types.ts:104): `{ session_id, agent, topic, created_at, last_active, message_count, model? }`. `get_display_text(content)` (types.ts) extracts text from a `ChatMessage.content`.
- `ChatPane.svelte` Sessions tab: `backend_sessions = $state<SessionSummary[]>([])`, `fetch_backend_sessions()` (~line 323), tab type `'chat'|'context'|'sessions'`, `tab_slice_id = $derived(tab_id ?? 'default')`.
- i18n modules `src/lib/i18n/{en,zh}/chat.ts` exist.

---

## Task 1: Local session store + pure helpers

**Files:**
- Create: `src/lib/chat/local-session-store.ts`
- Test: `tests/vitest/local-session-store.test.ts`

- [ ] **Step 1: Write the failing test (pure helpers only)**

```ts
// tests/vitest/local-session-store.test.ts
import { describe, it, expect } from 'vitest'
import { to_session_summary, topic_from_messages, merge_session_lists, type LocalSessionRecord } from '../../src/lib/chat/local-session-store'
import type { ChatMessage } from '../../src/lib/chat/types'

const rec = (over: Partial<LocalSessionRecord> = {}): LocalSessionRecord => ({
  id: 'local-1', tab_id: 'default', provider: 'deepseek', model: 'deepseek-chat',
  topic: 'hi', created_at: 10, last_active: 20, messages: [], ...over,
})

describe('topic_from_messages', () => {
  it('takes the first user message text', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'run pwd please', timestamp: 1 }]
    expect(topic_from_messages(msgs)).toBe('run pwd please')
  })
  it('truncates to 80 chars', () => {
    const long = 'x'.repeat(120)
    expect(topic_from_messages([{ role: 'user', content: long, timestamp: 1 }])).toHaveLength(80)
  })
  it('returns empty string when no user message', () => {
    expect(topic_from_messages([{ role: 'assistant', content: 'hello', timestamp: 1 }])).toBe('')
    expect(topic_from_messages([])).toBe('')
  })
})

describe('to_session_summary', () => {
  it('maps a record to a SessionSummary tagged agent=local', () => {
    const s = to_session_summary(rec({ id: 'local-7', topic: 'T', model: 'm', created_at: 5, last_active: 9, messages: [{ role: 'user', content: 'a', timestamp: 1 }, { role: 'assistant', content: 'b', timestamp: 2 }] }))
    expect(s).toEqual({ session_id: 'local-7', agent: 'local', topic: 'T', created_at: 5, last_active: 9, message_count: 2, model: 'm' })
  })
})

describe('merge_session_lists', () => {
  it('concatenates and sorts by last_active descending', () => {
    const a = [{ session_id: 'b1', agent: 'claude', topic: '', created_at: 0, last_active: 100, message_count: 1 }]
    const b = [
      { session_id: 'l1', agent: 'local', topic: '', created_at: 0, last_active: 200, message_count: 1 },
      { session_id: 'l2', agent: 'local', topic: '', created_at: 0, last_active: 50, message_count: 1 },
    ]
    expect(merge_session_lists(a, b).map((s) => s.session_id)).toEqual(['l1', 'b1', 'l2'])
  })
})
```

- [ ] **Step 2: Run it, confirm FAIL** — `pnpm vitest run tests/vitest/local-session-store.test.ts` (module not found).

- [ ] **Step 3: Implement `src/lib/chat/local-session-store.ts`**

```ts
/**
 * Browser-local persistence for client-direct (API) chat sessions. SDK-agent
 * chats persist on the backend; client-direct ones live only in the in-browser
 * chat-state slice and would vanish on reload — this IndexedDB store keeps them.
 * Mirrors the IndexedDB pattern in src/lib/plugins/storage.ts. All DB methods
 * resolve to a safe default if IndexedDB is unavailable (SSR / private mode).
 */
import type { ChatMessage, SessionSummary } from './types'
import { get_display_text } from './types'

export interface LocalSessionRecord {
  id: string
  tab_id: string
  provider: string
  model: string
  topic: string
  created_at: number
  last_active: number
  messages: ChatMessage[]
}

// ── Pure helpers (unit-tested) ──

/** First user message text, trimmed and capped at 80 chars; '' if none. */
export function topic_from_messages(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === `user`)
  if (!first) return ``
  const text = get_display_text(first.content).trim()
  return text.length > 80 ? text.slice(0, 80) : text
}

export function to_session_summary(rec: LocalSessionRecord): SessionSummary {
  return {
    session_id: rec.id,
    agent: `local`,
    topic: rec.topic,
    created_at: rec.created_at,
    last_active: rec.last_active,
    message_count: rec.messages.length,
    model: rec.model,
  }
}

/** Merge SDK + local session summaries, newest (last_active) first. */
export function merge_session_lists(backend: SessionSummary[], local: SessionSummary[]): SessionSummary[] {
  return [...backend, ...local].sort((a, b) => b.last_active - a.last_active)
}

// ── IndexedDB shell (browser-verified) ──

const DB_NAME = `catgo-chat`
const DB_VERSION = 1
const STORE = `sessions`

function has_idb(): boolean {
  return typeof indexedDB !== `undefined`
}

let _db_promise: Promise<IDBDatabase | null> | null = null
function open_db(): Promise<IDBDatabase | null> {
  if (!has_idb()) return Promise.resolve(null)
  if (_db_promise) return _db_promise
  _db_promise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: `id` })
          store.createIndex(`tab_id`, `tab_id`, { unique: false })
          store.createIndex(`last_active`, `last_active`, { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return _db_promise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open_db().then((db) => {
    if (!db) return null
    return new Promise<T | null>((resolve) => {
      try {
        const t = db.transaction([STORE], mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  })
}

export async function save_local_session(rec: LocalSessionRecord): Promise<void> {
  await tx(`readwrite`, (s) => s.put(rec) as unknown as IDBRequest<IDBValidKey>)
}

export async function list_local_sessions(): Promise<LocalSessionRecord[]> {
  const all = await tx<LocalSessionRecord[]>(`readonly`, (s) => s.getAll() as IDBRequest<LocalSessionRecord[]>)
  return all ?? []
}

export async function load_local_session(id: string): Promise<LocalSessionRecord | null> {
  return (await tx<LocalSessionRecord>(`readonly`, (s) => s.get(id) as IDBRequest<LocalSessionRecord>)) ?? null
}

export async function delete_local_session(id: string): Promise<void> {
  await tx(`readwrite`, (s) => s.delete(id) as unknown as IDBRequest<undefined>)
}

export async function get_last_session_for_tab(tab_id: string): Promise<LocalSessionRecord | null> {
  const all = await list_local_sessions()
  const mine = all.filter((r) => r.tab_id === tab_id).sort((a, b) => b.last_active - a.last_active)
  return mine[0] ?? null
}
```

- [ ] **Step 4: Run it, confirm PASS** — `pnpm vitest run tests/vitest/local-session-store.test.ts` (7 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/local-session-store.ts tests/vitest/local-session-store.test.ts
git commit -m "feat(chat): local-session-store (IndexedDB) + pure session helpers"
```

---

## Task 2: Save hook in `chat-state`

**Files:**
- Modify: `src/lib/chat/chat-state.svelte.ts`

- [ ] **Step 1: Add the import** (with the other `./` imports near the top):

```ts
import { save_local_session, get_last_session_for_tab, type LocalSessionRecord } from './local-session-store'
```

- [ ] **Step 2: Add the slice field.** In `ChatSlice` (after `skip_permission: { value: boolean }`):

```ts
  // Client-direct (API) chats persist to IndexedDB under this id (per tab). SDK
  // chats use the backend session store instead, so this stays '' for them.
  local_session_id: { value: string }
```

In `make_chat_slice()` (after `const skip_permission = $state({ value: false })`):

```ts
  const local_session_id = $state({ value: `` })
```

and add `local_session_id,` to the returned object.

- [ ] **Step 3: Add the persist helper** (top-level function in the module, e.g. just above `new_session`):

```ts
/** Upsert the current client-direct chat into IndexedDB. No-op for SDK agents
 *  or empty conversations. Mints a session id + topic on first save. */
export async function persist_local_session(
  tab_id: string,
  provider: string,
  model: string,
): Promise<void> {
  const slice = get_chat_slice(tab_id)
  if (SDK_PROVIDERS.has(provider as never)) return
  if (slice.messages.list.length === 0) return
  const now = Date.now()
  if (!slice.local_session_id.value) {
    slice.local_session_id.value = `local-${now}-${Math.random().toString(36).slice(2, 8)}`
  }
  const existing = await get_last_session_for_tab(tab_id)
  const created_at = existing && existing.id === slice.local_session_id.value ? existing.created_at : now
  const rec: LocalSessionRecord = {
    id: slice.local_session_id.value,
    tab_id,
    provider,
    model,
    topic: topic_from_messages(slice.messages.list),
    created_at,
    last_active: now,
    messages: slice.messages.list,
  }
  await save_local_session(rec)
}
```

Add `topic_from_messages` to the Task-1 import:
```ts
import { save_local_session, get_last_session_for_tab, topic_from_messages, type LocalSessionRecord } from './local-session-store'
```

- [ ] **Step 4: Call it in the `finally`.** In `send_message`'s `finally` block (~line 864), after `slice.loading.value = false`, add:

```ts
    // Persist client-direct (API) chats so they survive reload (SDK chats persist
    // on the backend). Fire-and-forget; never blocks the UI.
    void persist_local_session(tab_id, chat_config.provider, chat_config.model)
```

(`tab_id`, `chat_config`, and the module-level `persist_local_session` are all in scope. If `tab_id` is named differently in `send_message`, use that variable — it is the value passed to `get_chat_slice` at the top of the function.)

- [ ] **Step 5: Reset on New.** In `new_session` (~line 1089), after `slice.messages.list = []`, add:

```ts
  slice.local_session_id.value = ``
```

- [ ] **Step 6: Type-check** — `pnpm check 2>&1 | tail -3` → **0 errors**.

- [ ] **Step 7: Commit**

```bash
git add src/lib/chat/chat-state.svelte.ts
git commit -m "feat(chat): persist client-direct sessions on each turn; reset on new_session"
```

---

## Task 3: Auto-restore + merged Sessions list in `ChatPane`

**Files:**
- Modify: `src/lib/chat/ChatPane.svelte`

- [ ] **Step 1: Add imports** (with the chat-state import block):

```ts
  import { get_last_session_for_tab, load_local_session, delete_local_session, list_local_sessions, to_session_summary, merge_session_lists } from './local-session-store'
```

- [ ] **Step 2: Auto-restore on mount.** Near the other `$effect`s, add (uses `tab_slice_id` + the slice; `is_client_direct` and `chat_config` are already used in this file — if not imported, import `is_client_direct` from `./provider-routing` and read the existing `chat_config`):

```ts
  let _restored_local = false
  $effect(() => {
    if (_restored_local) return
    if (!is_client_direct(chat_config)) return
    const slice = get_chat_slice(tab_slice_id)
    if (slice.messages.list.length > 0 || slice.local_session_id.value) { _restored_local = true; return }
    _restored_local = true
    get_last_session_for_tab(tab_slice_id).then((rec) => {
      if (rec && slice.messages.list.length === 0) {
        slice.messages.list = rec.messages
        slice.local_session_id.value = rec.id
      }
    })
  })
```

(`get_chat_slice` is exported from chat-state and already imported in ChatPane; if not, add it to the chat-state import.)

- [ ] **Step 3: Fetch + merge local sessions.** Find `backend_sessions` / `fetch_backend_sessions` (~line 320-343). Add beside them:

```ts
  let local_sessions = $state<import('./types').SessionSummary[]>([])
  async function fetch_local_sessions() {
    local_sessions = (await list_local_sessions()).map(to_session_summary)
  }
```

Call `fetch_local_sessions()` wherever `fetch_backend_sessions()` is called (when the Sessions tab opens). Where the template renders the sessions list, replace the source array with the merged, sorted list:

```ts
  let all_sessions = $derived(merge_session_lists(backend_sessions, local_sessions))
```

and iterate `all_sessions` (instead of `backend_sessions`) in the `{#each}` that renders session rows.

- [ ] **Step 4: Route resume/delete by agent.** In the session row's resume + delete handlers, branch on `session.agent === 'local'`:

```svelte
  <!-- resume -->
  onclick={async () => {
    if (session.agent === `local`) {
      const rec = await load_local_session(session.session_id)
      if (rec) {
        const slice = get_chat_slice(tab_slice_id)
        slice.messages.list = rec.messages
        slice.local_session_id.value = rec.id
        active_tab = `chat`
      }
    } else {
      resume_session(session.session_id, session.agent, tab_slice_id)
      active_tab = `chat`
    }
  }}
```

```svelte
  <!-- delete -->
  onclick={async (e) => {
    e.stopPropagation()
    if (session.agent === `local`) { await delete_local_session(session.session_id); await fetch_local_sessions() }
    else { delete_session(session.session_id); /* existing backend refresh */ }
  }}
```

(Use the file's existing resume/delete handler shapes; only add the `session.agent === 'local'` branch. `resume_session`/`delete_session` are already imported.)

- [ ] **Step 5: Tag local rows.** Where the row renders the agent tag, show `{session.agent === 'local' ? t('chat.session_api') : session.agent}`.

- [ ] **Step 6: Type-check** — `pnpm check 2>&1 | tail -3` → **0 errors**.

- [ ] **Step 7: Commit**

```bash
git add src/lib/chat/ChatPane.svelte
git commit -m "feat(chat): auto-restore + merged Sessions list for API sessions"
```

---

## Task 4: i18n tag

**Files:**
- Modify: `src/lib/i18n/en/chat.ts`, `src/lib/i18n/zh/chat.ts`

- [ ] **Step 1:** In `src/lib/i18n/en/chat.ts`, add a key (in the same object, near other session keys):

```ts
  session_api: `API`,
```

- [ ] **Step 2:** In `src/lib/i18n/zh/chat.ts`, add the matching key:

```ts
  session_api: `API`,
```

- [ ] **Step 3: Verify parity + full suite** — `pnpm vitest run 2>&1 | tail -4` (i18n parity test passes; the 2 pre-existing XRD/RDF numerical failures are unrelated).

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/en/chat.ts src/lib/i18n/zh/chat.ts
git commit -m "i18n(chat): session_api tag (en+zh)"
```

---

## Task 5: Acceptance — persistence works (browser, live stack)

**Files:** none (verification). Requires a configured **client-direct** provider (e.g. DeepSeek with an API key) on the running stack (:3186).

- [ ] **Step 1:** Open AI Chat; ensure a client-direct provider is selected.
- [ ] **Step 2:** Send 2 messages; wait for replies.
- [ ] **Step 3:** Reload the page → the conversation **auto-restores** (messages reappear). Programmatic check: `page.evaluate` reads the IndexedDB `catgo-chat` store and finds one record whose `messages.length >= 4`.
- [ ] **Step 4:** Open the **Sessions** tab → the session is listed with an "API" tag, newest first.
- [ ] **Step 5:** Click **New** → chat clears; the old session is still in Sessions. Resume it → messages return. Delete it → it disappears from Sessions and IndexedDB.
- [ ] **Step 6:** `pnpm check` 0 errors; `pnpm vitest run tests/vitest/local-session-store.test.ts` passes.

---

## Final verification

- [ ] `pnpm check` → 0 errors.
- [ ] `pnpm vitest run` → all pass (minus the 2 pre-existing XRD/RDF flakes).
- [ ] Merge to `feat/pane-tree-core`.

## Notes / invariants

- **API key never persisted** — records hold only `ChatMessage` content; the key stays in memory.
- No `src/lib/mobile/*` edits (shared `src/lib/chat/*`; mobile benefits for free).
- IndexedDB-unavailable → all store methods no-op; chat still works.
- SDK-agent session paths (`resume_session`/`delete_session`/`backend_sessions`) are unchanged.
- Project style by hand (single-quote, no-semicolon, 2-space); never run `deno fmt`.

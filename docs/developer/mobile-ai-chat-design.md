# Design: AI chat on mobile (iPhone / iPad / Android), API-key option

**Status:** Accepted v2 — implementation-ready (revised after a 3-agent review: codebase fact-check, architecture, security)
**Date:** 2026-06-08
**Branch context:** `ios-app` (mobile WKWebView app), post-merge with `main`
**Author/reviewers:** Jen + mentor

> **Revision note (v2).** Incorporates a fact-check, architecture, and security
> review. Material changes from v1: text-only is `run_tool_loop` with an **empty
> tool list** (not a bypass) and the request must **omit** the `tools` field when
> empty (Anthropic 400s on `[]`); the mobile LLM fetch uses the Tauri HTTP plugin
> **directly with NO relay fallback** (the relay is a third party and the request
> carries the key); `api_key` must be kept out of the localStorage-persisted
> `chat_config`; reuse `get_chat_slice('mobile')`/`send_message`; default models
> only (drop the key-bearing model-list fetch on mobile); AI is an **overlay**,
> not a new mode; added base-URL validation, header requirements, a logging/redact
> rule, and a threat model.

---

## 1. Summary

Bring CatGo's AI assistant to the mobile app using a **user-supplied API key**.
Mobile has **no Python backend**, so the SDK-agent path (`/api/agent/stream`)
can't run — but CatGo already has a **client-direct** path
(`provider-routing.ts` `is_client_direct()`) that calls the provider API
directly from the webview. This lights that path up on mobile, **text-chat only**
for v1, for **all API-key providers**, with the key in the **native encrypted
key store**. One code path serves iPhone, iPad, and Android.

### Scope (v1)

**In:** text chat; all **API-key providers** (`anthropic`, `gemini`, `deepseek`,
`qwen`, `kimi`, `zhipu`, `custom`, `ollama`); on-device key entry stored
**encrypted** (native key store); streaming where supported with a non-streaming
fallback.

**Out (deferred):** the client tool-calling loop (we run it with an **empty**
tool list → pure text); **SDK providers** (backend-only); model-list fetch
(ship default models — avoids a key-bearing request, see §Security); RAG/doc
context; attachments; cross-launch conversation persistence.

---

## 2. Why this is mostly "wire up what exists" — with the real gaps named

Confirmed against the code (file:line from the review):

- **Client-direct path exists.** `provider-routing.ts:79` `is_client_direct()`;
  `client-llm.ts:93` `stream_client_llm()` → `parse_openai_stream()` reads
  `resp.body`. **Gap:** the provider call is a plain `fetch()`
  (`client-llm.ts:125`) — **not** `relay_fetch` — so it is **CORS-blocked on
  mobile and not yet solved** (v1 said "already solved"; that was wrong — only
  ancillary calls go through `relay_fetch`).
- **Config modeled.** `ChatConfig` (`types.ts:55-65`) has `provider`, `model`,
  `api_key`, `mode`, `client_direct`. **Gap:** `DEFAULT_CONFIG`
  (`chat-state.svelte.ts:35`) is `provider: 'sdk-claude'` — mobile must set a
  valid API-key provider. **Gap:** `custom` needs `client_direct: true` in
  non-`STATIC_ONLY` builds (the mobile Tauri app is not `STATIC_ONLY`)
  (`provider-routing.ts:81`).
- **Native encrypted store exists.** `keyStore(endpointKey, privateOpenssh)` /
  `keyLoad(endpointKey)` (`transport/index.ts:206,209`), implemented on the
  mobile tauri-ssh transport (`tauri-ssh.ts:251`), throws on the desktop http
  transport (`http.ts:167`). Stores the value **opaquely** (any string). The
  2nd param is *named* `privateOpenssh` but isn't validated as one.
- **Chat hidden on mobile.** `HIDDEN_TOOLBAR` includes `chat`
  (`MobileWorkspace.svelte:88`) — that gates the desktop **editor toolbar**, not
  the mobile workspace; mounting a mobile chat is independent.
- **`run_tool_loop` is load-bearing** (`chat-state.svelte.ts:611-693`): owns
  history, streaming indicators, abort, and the `pending_send` queue. Do **not**
  reimplement it.

---

## 3. The mobile LLM fetch (CORS) + streaming — the core technical work

`stream_client_llm` must reach the provider from a mobile WebView, where a plain
`fetch` to `api.anthropic.com` is CORS-blocked. The fix is the Tauri HTTP plugin
(native Rust fetch, no CORS) — the pattern proved for the database (`b1cd17a7`).

**Rules (security-critical — see §8):**

1. On `isMobile()`, route the call through `@tauri-apps/plugin-http` **directly**.
   It **MUST NOT** fall back to the CORS relay (`relay_url`) — that Worker is a
   third party and the request carries the user's key. On native-fetch failure,
   **surface an error**; never relay a key-bearing request.
   - Therefore do **not** reuse `relay_fetch` as-is (it falls back to the relay
     on plugin failure, `provider-routing.ts:75`). Add a sibling helper
     `llm_fetch(url, init)` (colocated in `provider-routing.ts`) that uses the
     plugin and throws on failure — no relay branch.
   - Defense-in-depth: add a guard in `relay_fetch` that **throws** if `init`
     carries an `Authorization`/`x-api-key` header and the URL would be relayed.
2. For the chat endpoint, pass the **direct** provider URL (skip the
   `needs_relay`/`relay_url` rewrite on the key-bearing path).

**Streaming via single-read detection** (replaces v1's "probe"): after obtaining
`resp.body.getReader()`, do one `read()`. If it returns `done: true` (whole body
arrived buffered — the plugin didn't stream) → JSON-parse the buffer as a
non-streaming response and feed it through `parse_openai_stream` as a single
synthetic chunk (reuse, don't fork). If `done: false` → proceed with the normal
SSE generator. No persistent flag, no probe request. For text-only chat, a
single-shot reply (with a "thinking…" indicator) is acceptable UX.

**Header + body fixes (apply on every client-direct call, desktop too):**
- **Omit `tools` from the body when the tool list is empty** — `client-llm.ts:120`
  currently always sends `tools: openai_tools`; `"tools": []` **400s on
  Anthropic**. Only include the field when non-empty.
- **Anthropic headers:** the OpenAI-compat base is `api.anthropic.com/v1`
  (`client-llm.ts:13`); confirm whether `/chat/completions` accepts
  `Authorization: Bearer` (current) or requires `x-api-key`, and send
  `anthropic-version: 2023-06-01`. The Python proxy (`server/.../chat.py:44`) is
  the reference header set. `anthropic-dangerous-direct-browser-access` is **not
  needed** on the native path (no browser CORS) — another reason the relay
  fallback is forbidden.

> Keep all mobile branching gated by `isMobile()` so desktop is byte-for-byte
> unchanged. The `tools`-omission and header fixes are correctness fixes that
> also benefit desktop client-direct mode.

---

## 4. Text-only = `run_tool_loop` with empty tools (reuse the lifecycle)

`MobileChat` does **not** invent its own send path. It reuses the existing
slice + loop:

- Use `get_chat_slice('mobile')` and call `send_message('mobile')` /
  `cancel_generation('mobile')` (`chat-state.svelte.ts`). That gives message
  list, loading/error flags, abort controller, and the `pending_send` queue for
  free.
- Drive it with a mobile `ChatConfig`: a valid API-key `provider`,
  `client_direct: true`, a default `model`, and the key supplied per-call (§5).
- **Text-only guardrail:** the client-direct branch calls `run_tool_loop` with
  an **empty** tool array. The loop runs one turn, sees zero `tool_calls`, emits
  `done`, and exits — no `execute_tool`/permission paths open. Combined with the
  **omit-`tools`-when-empty** body fix (§3), the model never attempts a tool
  call. (Bypassing the loop would lose history/abort/queue bookkeeping — don't.)

---

## 5. Key storage (the secure option) + no-leak rules

- **Store:** `ai-keys.ts` wraps the native store —
  `saveApiKey(provider, key)` → `transport.keyStore('llm-apikey:'+provider, key)`;
  `loadApiKey(provider)` → `transport.keyLoad('llm-apikey:'+provider)`. Stored
  opaquely, AES-256-GCM at rest. (The interface param is named `privateOpenssh`
  but stores any string; a future `secretStore`/`secretLoad` generalization is a
  clean follow-up, out of v1 scope.)
- **In memory only — never persisted to localStorage:** the loaded key lives in
  a **local `$state`** in `MobileChat`/`MobileChatSetup`. It is passed **by
  value** into the per-call config; it is **never** written to
  `chat_config.api_key` via `update_config()`.
  - **Why this matters:** `update_config()` calls `persist_config()` →
    `save_to_storage('catgo-chat-config', chat_config)` on **every** change
    (`chat-state.svelte.ts:93-100`). If the key ever lands in `chat_config`, any
    later config change serializes it to cleartext localStorage.
  - **Belt-and-suspenders:** on mobile, make `persist_config()` redact
    `api_key` (and any `custom` secret) before writing (`isMobile()` gate:
    `save_to_storage(KEY, { ...chat_config, api_key: '' })`). This protects every
    existing `update_config` caller.
- **Per provider:** one stored key per provider id, so switching providers
  recalls the right key. `custom`/`ollama` base URL is **non-secret** and may
  live in localStorage.
- **Async-race guard:** `keyLoad` is async; capture the provider at call start
  and only apply the result if the selected provider is still the same on
  resolve (`const p = sel; const k = await loadApiKey(p); if (p === sel) …`).

---

## 6. UX

AI is a **full-screen overlay** (like the existing remote-files overlay,
`files_open`), opened from a button in the mobile action bar and dismissed back
to the current mode. Overlay (not a new `Mode`) avoids keeping the 3D canvas +
terminal panes warm behind it — meaningful memory on a phone.

```
┌─ ◀ Back        AI · [Anthropic ▾]      ⚙ ─┐
│ ┌────────────────────────────────────────┐ │
│ │ assistant: …reply…                     │ │   ← message list
│ │ you: …                                 │ │
│ └────────────────────────────────────────┘ │
│ [ type a message…                ] [ Send ] │   ← composer
└──────────────────────────────────────────────┘
```

- **First-run / no key:** a **setup card** — pick a provider (API-key providers
  only), paste the key (+ base URL for `custom`/`ollama`), Save → `keyStore`.
  Mirrors `MobileConnect`/`KeySetup`.
- **Model:** a sensible **default per provider** (no model-list fetch — avoids a
  key-bearing request, §8). Optional manual model field.
- **Composer:** text input + Send; streaming or single-shot per §3; a "thinking…"
  indicator; cancel via `cancel_generation('mobile')` on dismiss/destroy.
- **Errors:** 401/invalid-key → inline "check your API key" (reuse
  `message-utils` 401 detection) with a shortcut to setup. Never echo raw
  provider error bodies that might reflect the key.
- **Markdown:** for v1 use a **lightweight renderer** (no `katex`/`highlight.js`)
  — `markdown.ts` pulls ~250 KB of katex+hljs at module load, disproportionate
  for conversational text. Lazy-load the full renderer only if a code block is
  detected.

---

## 7. Architecture / files

### Reused (no desktop behavior change)

`client-llm.ts` (`stream_client_llm`, `parse_openai_stream`,
`PROVIDER_BASE_URLS`), `provider-routing.ts` (`is_client_direct`),
`chat-state.svelte.ts` (`get_chat_slice`, `send_message`, `cancel_generation`),
`types.ts`, `message-utils.ts`.

### New

- `src/lib/mobile/ai-keys.ts` — `apiKeyId()`, `saveApiKey()`, `loadApiKey()`
  over `transport.keyStore`/`keyLoad`; `mobile_chat_providers()` =
  `LLMProvider` − `SDK_PROVIDERS`; `validate_base_url()` (§8 H2).
- `src/lib/mobile/MobileChat.svelte` — overlay: provider header, message list
  (lightweight markdown), composer; consumes `get_chat_slice('mobile')`; key in
  local `$state`.
- `src/lib/mobile/MobileChatSetup.svelte` — provider + key (+ base URL) card →
  `keyStore`; sets `client_direct: true` and a valid provider/model on the
  mobile config.

### Modified

- `client-llm.ts` — `isMobile()` path: `llm_fetch` (Tauri HTTP, **no relay**) +
  single-read detection; **omit `tools` when empty**; Anthropic headers.
- `provider-routing.ts` — `llm_fetch` helper; guard `relay_fetch` against
  relaying auth-bearing requests.
- `chat-state.svelte.ts` — `persist_config()` redacts `api_key` on mobile.
- `MobileWorkspace.svelte` — AI button + mount `MobileChat` overlay.
- `i18n/en/mobile.ts` + `zh/mobile.ts` — new strings (parity); `<Icon>` SVG.

---

## 8. Security requirements (must-fix, from the security review)

- **C — Key never transits the relay.** Key-bearing requests (chat; and any
  model-list call if ever added) use the Tauri-native path with **no `relay_url`
  fallback**. Guard `relay_fetch` to throw on an auth header + relayed URL.
  Simplest v1: **no model-list fetch on mobile** — ship default models.
- **H — No cleartext key in localStorage.** Keep the key in local `$state`,
  never in `chat_config`/`update_config`; redact `api_key` in `persist_config()`
  on mobile (§5).
- **H — Validate `custom`/`ollama` base URL** before sending the key: require
  `https://` for non-loopback/non-LAN hosts; warn (or block) on `http://`
  remote; reject non-URLs. For `ollama` with an empty key, send no `Authorization`
  header.
- **M — Never log the key.** Add a `redact()` helper for any error string /
  debug output; never `console.log` request `init`/headers on the key path. The
  existing 401 mapping (`message-utils.ts:143`) stays generic.
- **M — Anthropic:** native fetch moots `anthropic-dangerous-direct-browser-access`;
  still send `anthropic-version`; confirm Bearer-vs-`x-api-key` per endpoint.

### Open questions

1. Tauri HTTP streaming: does the plugin body stream incrementally? (Decides
   streaming vs single-read fallback; both ship.)
2. `keyStore` opaque-id reuse vs a `secretStore`/`secretLoad` generalization
   (v1 reuses; generalization is a follow-up).
3. `AbortSignal` on in-flight Tauri HTTP requests — may only cancel JS iteration,
   not the OS request. Document as a v1 limitation if so.

---

## 9. Build sequence

1. **`ai-keys.ts`** — `apiKeyId()` (+ Vitest for the id/derivation + base-URL
   validation, which *are* unit-testable) and `saveApiKey`/`loadApiKey`
   (round-trip is **device-only**, not CI-testable).
2. **`client-llm.ts` mobile fetch** — `llm_fetch` (Tauri HTTP, no relay) +
   single-read detection; omit-`tools`-when-empty; Anthropic headers. Extend
   `__tests__/client-llm.test.ts`: mock the fetch to return a single-chunk
   buffered body and assert the non-streaming branch + that `tools` is absent
   when empty.
3. **`persist_config` redaction + provider gating** — redact on mobile;
   `mobile_chat_providers()`; ensure `client_direct:true` + valid provider.
4. **`MobileChatSetup.svelte`** — provider picker + key/base-URL → `keyStore`.
5. **`MobileChat.svelte`** — overlay; `get_chat_slice('mobile')` + `send_message`;
   lightweight markdown; cancel on destroy.
6. **`MobileWorkspace` integration** — AI button + overlay; i18n en+zh.
7. **On-device pass** — iPhone + iPad (+ Android if SDK available): real key,
   real reply, streaming-or-fallback, 401 handling, provider switch, key never
   in localStorage (inspect), abort on dismiss.

Device loop: `TAURI_DEV_HOST=$(ipconfig getifaddr en0) pnpm tauri ios dev "<device>"`.

---

## 10. Threat model (key handling)

| Actor | Access | keyStore mitigation |
|---|---|---|
| Other apps | OS sandbox isolates app data | Encrypted at rest; localStorage would be plaintext-in-sandbox |
| Device backup / iCloud / adb | plaintext localStorage can be backed up | Wrapped envelope doesn't yield cleartext off-device |
| Jailbreak / root | app data + wrapping key | **Partial** — current build uses a *software* AES-256-GCM envelope (`transport/index.ts:204`), not yet hardware Keystore; hardening is follow-up |
| XSS in WebView | in-memory key during a session | Load on demand, don't persist; text-only v1 (no client tool exec) shrinks injection surface |

keyStore is strictly better than desktop's plaintext localStorage. Residual
risks: the relay fallback (forbidden, §8) and `persist_config` re-persistence
(redacted, §5) — both closed by this design.

---

## 11. Risks

- **Streaming unknown** → single-read fallback (§3); text-only makes single-shot
  fine.
- **Key in transit/at rest** → native-only fetch, keyStore, persist redaction,
  base-URL validation, and a no-log rule (§8).
- **Desktop regression** → all mobile paths `isMobile()`-gated; the `tools`/header
  fixes are correctness improvements verified against desktop client-direct mode.
- **App Review (iOS)** → a *working* AI entry avoids the visible-but-broken flag.
- **Scope creep into tools** → empty tool list + omit-`tools` body is the
  guardrail; tools are v2.

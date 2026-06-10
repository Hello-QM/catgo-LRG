# Mobile AI chat: enable tool calling (CLIENT_TOOLS agentic loop)

**Date:** 2026-06-10
**Status:** approved (design)

## Background

PR #292 shipped mobile AI chat as text-only v1: `chat-state.svelte.ts` passes an
empty tool list on mobile and routes any hallucinated tool call to an immediate
error, because `MobileChat.svelte` has no permission UI — a mutating tool call
would park `request_permission` forever and wedge the chat.

The tool loop itself (`run_tool_loop`, `CLIENT_TOOLS`, `execute_tool`) is
client-direct and runs in the WebView — the same path the web build uses. All
slice-level plumbing (`active_tool_blocks`, `active_permission_blocks`,
`skip_permission`) is UI-agnostic and already works. Only the mobile rendering
and the gates are missing.

## Decisions

- **Permission UX:** confirmation card per mutating call, with a
  "don't ask again this session" checkbox wired to the existing
  `slice.skip_permission` flag (desktop parity, asks at most once if the user
  opts out).
- **Tool display:** compact status row per tool call (spinner / ✓ / ✗ + tool
  name), tap to expand the raw output in a `<pre>`. No reuse of desktop
  `ToolProgressBlock`/`PermissionCard` (desktop styling + SDK-path coupling).
- **Tool scope:** full `CLIENT_TOOLS`, no mobile filter. Backend-dependent
  tools (`get_skill`) fail with a clear error that flows back to the model as a
  tool result; improve its error message for the no-backend case.

## Changes

### 1. Gates — `src/lib/chat/chat-state.svelte.ts`

- L710: `isMobile() ? [] : CLIENT_TOOLS` → `CLIENT_TOOLS`
- L718–723: remove the mobile `execute` stub (always `execute_tool`)
- L724: remove the mobile `kind_of` stub (always `tool_kind`)
- L683: stop passing `text_only: true` on mobile to
  `build_sdk_system_prompt` — the system prompt regains tool guidance.
  Verify the client-direct prompt branch doesn't advertise desktop-only
  tools (WebSearch/Bash); CLIENT_TOOLS path should already be correct.

### 2. Permission card — `src/lib/mobile/MobileChat.svelte`

Render pending entries of `slice.active_permission_blocks`:

- Tool name + compact JSON input summary
- Allow / Deny buttons → call the entry's `resolve(ok)`
- "Don't ask again this session" checkbox → sets `slice.skip_permission`
- Abort-while-pending already resolves false in chat-state (no wedge)

### 3. Tool status rows — `src/lib/mobile/MobileChat.svelte`

Render `slice.active_tool_blocks`:

- One row per call: status icon (running spinner / complete ✓ / error ✗) +
  tool name
- Tap toggles an expanded `<pre>` with the tool output (monospace,
  horizontal scroll)
- Placement: above the loading indicator in the message flow (simplified —
  not interleaved into historical message positions)

### 4. `get_skill` error message — `src/lib/chat/structure-tools.ts`

When the backend fetch fails on mobile, throw a message that tells the model
the backend is unavailable on mobile rather than a bare HTTP error.

### 5. i18n — `src/lib/i18n/{en,zh}/`

New keys (en/zh parity, enforced by the existing coverage test): allow, deny,
don't-ask-again, tool running/failed labels.

## Testing

- `chat-state` unit tests: on mobile the tool list is non-empty; permission
  entry is created for a mutating call and `resolve(true/false)` settles the
  loop; `skip_permission` bypasses the card.
- i18n coverage test picks up new keys automatically.
- Device verification on Android APK (build from this branch): ask CatBot to
  build a supercell → permission card → tool runs → structure updates.

## Risks

- Tool-calling quality of user-keyed mobile models (DeepSeek/Qwen/Kimi)
  varies — same exposure as desktop client-direct, no new risk.
- Desktop behavior unchanged (gates removed are mobile-only branches).

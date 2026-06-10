# Mobile Tool Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the CLIENT_TOOLS agentic tool-calling loop in mobile AI chat (currently text-only), with a mobile permission card and compact tool-status rows.

**Architecture:** All tool-loop plumbing already exists and is UI-agnostic (`slice.active_tool_blocks`, `slice.active_permission_blocks`, `slice.skip_permission` in `chat-state.svelte.ts`). The work is: (1) remove the three `isMobile()` text-only gates in chat-state, (2) keep the mobile Unicode-formula rendering instruction by adding a `unicode_math` param to the tooled system prompt, (3) render permission cards + tool rows in `MobileChat.svelte`, (4) friendlier `get_skill` error when no backend, (5) i18n keys (en/zh parity enforced by existing coverage test).

**Tech Stack:** Svelte 5 runes, vitest, existing chat-state slice plumbing. Formatting: repo pre-commit hook runs `deno fmt` (single quotes, no semicolons) — let it format, re-stage, commit again if it rewrites files. `.svelte` files are NOT deno-formatted.

**Branch:** `feat/mobile-tool-calling` (spec already committed: `plan/2026-06-10-mobile-tool-calling-design.md`).

---

### Task 1: `unicode_math` param on the tooled system prompt

Mobile loses the text-only prompt (which carried the "write formulas in Unicode, no LaTeX" instruction). The tooled prompt needs an opt-in version of that note, because the mobile markdown renderer is plain-text (no KaTeX/HTML).

**Files:**
- Modify: `src/lib/chat/llm-client.ts` (function `build_sdk_system_prompt`, starts ~line 21)
- Create: `src/lib/chat/__tests__/llm-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/chat/__tests__/llm-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { build_sdk_system_prompt } from '../llm-client'

describe(`build_sdk_system_prompt unicode_math`, () => {
  it(`appends the Unicode-formula note to the TOOLED prompt when unicode_math is set`, () => {
    const prompt = build_sdk_system_prompt(`deepseek`, undefined, false, false, true)
    expect(prompt).toMatch(/UNICODE characters/)
    expect(prompt).toMatch(/never use \$\.\.\.\$/)
    // Still the tooled prompt, not the text-only one
    expect(prompt).toMatch(/catgo_/)
  })

  it(`omits the note by default (desktop)`, () => {
    const prompt = build_sdk_system_prompt(`deepseek`, undefined, false, false)
    expect(prompt).not.toMatch(/does NOT render LaTeX/)
    expect(prompt).toMatch(/catgo_/)
  })

  it(`text_only branch is unchanged and already carries the note`, () => {
    const prompt = build_sdk_system_prompt(`deepseek`, undefined, false, true)
    expect(prompt).toMatch(/TEXT-ONLY/)
    expect(prompt).toMatch(/UNICODE characters/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/chat/__tests__/llm-client.test.ts`
Expected: FAIL — first test fails (5th argument ignored, no Unicode note in tooled prompt).

- [ ] **Step 3: Implement**

In `src/lib/chat/llm-client.ts`, add the param and the append. Signature change:

```ts
export function build_sdk_system_prompt(
  provider: LLMProvider,
  structure_context?: string,
  has_session: boolean = false,
  text_only: boolean = false,
  unicode_math: boolean = false,
): string {
```

At the END of the tooled branch (after the existing `msg` assembly, right before the
final `return` of the non-text-only path — keep the existing `has_session` /
`structure_context` appends in the same order they are today), add:

```ts
  if (unicode_math) {
    msg += `\n\nRendering: this chat does NOT render LaTeX or HTML. Write ` +
      `chemical formulas and math with UNICODE characters (e.g. TiO₂, H₂O, ` +
      `α-Fe₂O₃, x², E=mc²) — never use $...$, \\(...\\), <sub>, or <sup>.`
  }
```

Also update the doc comment above the function: `text_only` = no tools at all;
`unicode_math` = tooled, but the host UI has a plain-text renderer (mobile).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/chat/__tests__/llm-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/llm-client.ts src/lib/chat/__tests__/llm-client.test.ts
git commit -m "feat(chat): unicode_math note for tooled system prompt (mobile renderer)"
```

---

### Task 2: Remove the mobile text-only gates in chat-state

**Files:**
- Modify: `src/lib/chat/chat-state.svelte.ts` (client-direct branch, ~lines 676–724)

- [ ] **Step 1: Flip the system-prompt call**

At ~line 677 (`const system = build_sdk_system_prompt(`), the current code is:

```ts
      const system = build_sdk_system_prompt(
        chat_config.provider,
        combined_context,
        false,
        // Mobile/client-direct runs tool-free (isMobile() ? [] : CLIENT_TOOLS
        // below) — use the tool-free prompt so the model answers from the inline
        // structure context instead of promising tool actions it can't perform.
        isMobile(),
      )
```

Replace with:

```ts
      const system = build_sdk_system_prompt(
        chat_config.provider,
        combined_context,
        false,
        false,
        // Mobile renders chat with a plain-text markdown renderer (no KaTeX/
        // HTML) — keep the Unicode-formula instruction in the tooled prompt.
        isMobile(),
      )
```

- [ ] **Step 2: Flip the tool list, execute, and kind_of**

At ~lines 705–724, the current code is:

```ts
            // Text-only on mobile (§4): run the loop with an EMPTY tool list so the
            // model never attempts a tool call. Combined with Phase A's
            // omit-tools-when-empty body fix this makes mobile chat pure text.
            // Desktop keeps the full CLIENT_TOOLS agentic loop.
            isMobile() ? [] : CLIENT_TOOLS,
            slice.abort_controller?.signal,
          ),
        // Mobile is text-only and offers no tools, but a model can still
        // hallucinate a tool_call. There is no PermissionCard on mobile, so a
        // `mutate` call would park request_permission forever and wedge the chat
        // (loading never clears). Route any such call to an immediate error with
        // read-kind (skips the permission gate) so the loop unwinds cleanly.
        execute: isMobile()
          ? () =>
            Promise.resolve(
              `{"error":"tools are not available in mobile chat"}`,
            )
          : execute_tool,
        kind_of: isMobile() ? () => `read` as const : tool_kind,
```

Replace with:

```ts
            // Desktop AND mobile run the full CLIENT_TOOLS agentic loop; the
            // mobile permission card in MobileChat.svelte renders
            // active_permission_blocks, so mutating calls no longer wedge.
            CLIENT_TOOLS,
            slice.abort_controller?.signal,
          ),
        execute: execute_tool,
        kind_of: tool_kind,
```

If `isMobile` is now unused in this file, remove the import (check with
`grep -n isMobile src/lib/chat/chat-state.svelte.ts` — there is another use at
~line 110, so likely keep it).

- [ ] **Step 3: Run the chat suites**

Run: `pnpm vitest run src/lib/chat`
Expected: all pass (tool-loop, client-llm, structure-tools, etc. unaffected — they don't mock isMobile to true).

- [ ] **Step 4: Commit**

```bash
git add src/lib/chat/chat-state.svelte.ts
git commit -m "feat(mobile): run the full CLIENT_TOOLS tool loop in mobile chat"
```

---

### Task 3: Friendlier `get_skill` error when the backend is absent

**Files:**
- Modify: `src/lib/chat/structure-tools.ts` (~line 186, the `get_skill` executor)

- [ ] **Step 1: Wrap the backend fetch**

Current executor body:

```ts
  async (input) => {
    const path = String((input.skill_path as string) ?? ``).trim().replace(/^\/+|\/+$/g, ``)
    const url = path ? `${API_BASE}/skills/${path}` : `${API_BASE}/skills/`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Skill fetch failed (HTTP ${res.status}). Call get_skill with no argument to list available skills.`)
    }
    const data = await res.json()
    return path ? (data.content ?? data) : (data.skills ?? data)
  },
```

Replace the fetch + error handling (keep the rest):

```ts
  async (input) => {
    const path = String((input.skill_path as string) ?? ``).trim().replace(/^\/+|\/+$/g, ``)
    const url = path ? `${API_BASE}/skills/${path}` : `${API_BASE}/skills/`
    let res: Response
    try {
      res = await fetch(url)
    } catch {
      // Mobile / static builds have no Python backend at API_BASE.
      throw new Error(
        `Skill guides require the CatGo backend, which is not available in this build (mobile/static). Proceed with your own domain knowledge instead of retrying.`,
      )
    }
    if (!res.ok) {
      throw new Error(`Skill fetch failed (HTTP ${res.status}). Call get_skill with no argument to list available skills.`)
    }
    const data = await res.json()
    return path ? (data.content ?? data) : (data.skills ?? data)
  },
```

(No new unit test: the change is an error-message rewording on a network-level
failure; the existing structure-tools tests cover the registry wiring.)

- [ ] **Step 2: Run the suite**

Run: `pnpm vitest run src/lib/chat/__tests__/structure-tools.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/chat/structure-tools.ts
git commit -m "fix(chat): clear get_skill error when the backend is unavailable (mobile/static)"
```

---

### Task 4: i18n keys (en + zh, parity enforced by coverage test)

**Files:**
- Modify: `src/lib/i18n/en/mobile.ts`
- Modify: `src/lib/i18n/zh/mobile.ts`

- [ ] **Step 1: Add the keys**

In `src/lib/i18n/en/mobile.ts`, next to the existing `ai_*` keys (~line 135):

```ts
  ai_tool_permission:     `CatBot wants to run a tool`,
  ai_allow:               `Allow`,
  ai_deny:                `Deny`,
  ai_dont_ask_again:      `Don't ask again this session`,
  ai_tool_failed:         `failed`,
```

In `src/lib/i18n/zh/mobile.ts`, same keys:

```ts
  ai_tool_permission:     `CatBot 请求执行工具`,
  ai_allow:               `允许`,
  ai_deny:                `拒绝`,
  ai_dont_ask_again:      `本会话内不再询问`,
  ai_tool_failed:         `失败`,
```

(Match the literal style of the surrounding lines — backtick strings, aligned
colons if the file aligns them.)

- [ ] **Step 2: Run the i18n coverage test**

Run: `pnpm vitest run src/lib/i18n`
Expected: PASS — en/zh key sets in parity.

- [ ] **Step 3: Commit**

```bash
git add src/lib/i18n/en/mobile.ts src/lib/i18n/zh/mobile.ts
git commit -m "feat(i18n): mobile tool-permission strings (en/zh)"
```

---

### Task 5: Permission card + tool status rows in MobileChat

**Files:**
- Modify: `src/lib/mobile/MobileChat.svelte` (script ~line 21+, markup ~line 310, styles at the bottom)

- [ ] **Step 1: Script additions**

In the `<script>` block (near the other `$state` declarations, ~line 105):

```ts
  import { SvelteSet } from 'svelte/reactivity'
  import type { PermissionEntry } from '$lib/chat/chat-state.svelte'

  // Tool rows the user has tapped open (cleared per-send is unnecessary —
  // entries are replaced wholesale at the start of each client-direct run).
  const expanded_tools = new SvelteSet<string>()
  function toggle_tool(id: string): void {
    if (expanded_tools.has(id)) expanded_tools.delete(id)
    else expanded_tools.add(id)
  }

  // "Don't ask again this session" checkbox state for the permission card.
  let skip_session = $state(false)

  function decide_permission(entry: PermissionEntry, ok: boolean): void {
    entry.status = ok ? `approved` : `denied`
    if (ok && skip_session) slice.skip_permission.value = true
    entry.resolve?.(ok)
  }
```

(`SvelteSet` import goes with the other imports at the top; the rest after the
existing state declarations. `PermissionEntry` is exported from
`$lib/chat/chat-state.svelte` — verify with `grep -n 'export interface PermissionEntry' src/lib/chat/chat-state.svelte.ts`.)

- [ ] **Step 2: Markup**

In the `ai-body` block, AFTER the `{#each slice.messages.list …}` loop closes and
BEFORE the `{#if slice.loading.value}` thinking indicator (~line 311), insert:

```svelte
      <!-- Tool calls of the current run: compact status rows, tap to expand -->
      {#each Object.entries(slice.active_tool_blocks.entries) as [id, tb] (id)}
        <div class="ai-tool" class:error={tb.status === `error`}>
          <button type="button" class="ai-tool-row" onclick={() => toggle_tool(id)}>
            {#if tb.status === `running`}
              <span class="ai-dots" aria-hidden="true"></span>
            {:else if tb.status === `error`}
              <span class="ai-tool-mark err">✗</span>
            {:else}
              <span class="ai-tool-mark ok">✓</span>
            {/if}
            <span class="ai-tool-name">{tb.toolName}</span>
            {#if tb.status === `error`}<span class="ai-tool-sub">{t(`mobile.ai_tool_failed`)}</span>{/if}
          </button>
          {#if expanded_tools.has(id)}
            <pre class="ai-tool-out">{tb.output || JSON.stringify(tb.input, null, 1)}</pre>
          {/if}
        </div>
      {/each}

      <!-- Pending mutating-tool permission cards (client-direct loop) -->
      {#each Object.entries(slice.active_permission_blocks.entries) as [id, pb] (id)}
        {#if pb.status === `pending` && pb.resolve}
          <div class="ai-perm" role="alertdialog" aria-label={t(`mobile.ai_tool_permission`)}>
            <div class="ai-perm-title">{t(`mobile.ai_tool_permission`)}</div>
            <div class="ai-perm-tool">{pb.toolName}</div>
            <pre class="ai-perm-input">{JSON.stringify(pb.input, null, 1)}</pre>
            <label class="ai-perm-skip">
              <input type="checkbox" bind:checked={skip_session} />
              {t(`mobile.ai_dont_ask_again`)}
            </label>
            <div class="ai-perm-actions">
              <button type="button" class="ai-perm-deny" onclick={() => decide_permission(pb, false)}>{t(`mobile.ai_deny`)}</button>
              <button type="button" class="ai-perm-allow" onclick={() => decide_permission(pb, true)}>{t(`mobile.ai_allow`)}</button>
            </div>
          </div>
        {/if}
      {/each}
```

- [ ] **Step 3: Styles**

Append to the `<style>` block (follow existing `.ai-*` class conventions and CSS
custom properties used in the file):

```css
  .ai-tool {
    margin: 2px 0;
    border-radius: 8px;
    background: var(--surface-2, rgba(148, 163, 184, 0.08));
    overflow: hidden;
  }
  .ai-tool-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 13px;
    text-align: left;
  }
  .ai-tool-mark.ok { color: var(--success-color, #4ade80); }
  .ai-tool-mark.err { color: var(--error-color, #f87171); }
  .ai-tool-name { font-family: monospace; }
  .ai-tool-sub { margin-left: auto; font-size: 12px; opacity: 0.8; }
  .ai-tool-out,
  .ai-perm-input {
    margin: 0;
    padding: 8px 10px;
    font-size: 12px;
    font-family: monospace;
    overflow-x: auto;
    white-space: pre;
    color: var(--text-color-muted, #94a3b8);
    background: rgba(0, 0, 0, 0.15);
  }
  .ai-tool-out { max-height: 40vh; overflow-y: auto; }
  .ai-perm {
    margin: 6px 0;
    padding: 10px;
    border: 1px solid var(--warning-color, #facc15);
    border-radius: 10px;
    display: grid;
    gap: 8px;
  }
  .ai-perm-title { font-weight: 600; font-size: 14px; }
  .ai-perm-tool { font-family: monospace; font-size: 13px; }
  .ai-perm-skip { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .ai-perm-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .ai-perm-actions button {
    min-height: 40px;
    padding: 0 16px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 14px;
  }
  .ai-perm-allow { background: var(--accent-color, #3b82f6); color: white; }
  .ai-perm-deny { background: transparent; border-color: var(--border-color, #334155) !important; color: var(--text-color-muted, #94a3b8); }
```

(Adjust custom-property names to whatever the file already uses — check the
existing `.ai-error` / `.ai-msg` rules and reuse their variables.)

- [ ] **Step 4: Type-check + full test suite**

Run: `pnpm check 2>&1 | tail -20` — no new errors in MobileChat.svelte.
Run: `pnpm vitest run src/lib/chat src/lib/mobile src/lib/i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mobile/MobileChat.svelte
git commit -m "feat(mobile): permission card + tool status rows in AI chat"
```

---

### Task 6: Full-suite regression + device verification notes

- [ ] **Step 1: Full unit suite**

Run: `pnpm vitest run`
Expected: same pass count as main (1 known flaky: RdfPlot under full suite — rerun in isolation if it fails).

- [ ] **Step 2: Desktop smoke (no regression)**

Run `pnpm desktop:serve`, open chat, ask "make a 2x2x2 supercell" → desktop
PermissionCard appears as before, tool runs. (Desktop path untouched, but the
system-prompt call changed — verify a normal tooled conversation still works.)

- [ ] **Step 3: Device verification (Android)**

Build APK from this branch (conda env with openjdk=17, `pnpm tauri android build --apk true`, debug-sign, `adb install`). On device:
1. Open a structure → AI chat → ask "build a 2x2x2 supercell".
2. Expect: permission card → Allow → tool row ✓ → structure updates in the viewer.
3. Ask again with "don't ask again" checked → second mutating call runs without a card.
4. Ask something needing `get_skill` → tool row ✗, model continues with its own knowledge (no wedge).
5. Stop button mid-permission → card resolves, loading clears (abort path).

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/mobile-tool-calling
gh pr create --title "feat(mobile): tool calling in mobile AI chat" --body "..."
```

PR body: link `plan/2026-06-10-mobile-tool-calling-design.md`, note desktop
behavior unchanged, list device-verified steps from Step 3.

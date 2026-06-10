<!--
  MobileChat.svelte — full-screen AI chat overlay for the mobile workspace.

  Mirrors the .mw-files-overlay pattern. Reuses the existing chat lifecycle
  (get_chat_slice / send_message / cancel_generation) under tab id 'mobile', so
  history, the loading indicator, abort, and the pending-send queue all come for
  free (§4). Tool calling: chat-state runs the full CLIENT_TOOLS client-direct
  loop on mobile; this overlay renders the tool status rows and the
  permission card (active_tool_blocks / active_permission_blocks) so mutating
  calls are gated rather than wedging the chat.

  Key handling (§5/§8): the API key is loaded from the native encrypted store
  into a LOCAL $state and pushed into chat_config in-memory via
  set_session_api_key right before each send. It is NEVER written through
  update_config (which would persist it to localStorage). If no key is stored
  for the current provider, the setup card is shown instead of the chat.

  Markdown: a deliberately LIGHTWEIGHT inline renderer (no katex / highlight.js —
  markdown.ts pulls ~250 KB at module load, §6). Renders paragraphs + line
  breaks + **bold** + `inline code`, HTML-escaped. TODO: lazy-load the full
  renderer only when a fenced code block is detected.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import Icon from '$lib/Icon.svelte'
  import { get_display_text } from '$lib/chat/types'
  import {
    cancel_generation,
    chat_config,
    get_chat_slice,
    send_message,
    set_session_api_key,
  } from '$lib/chat/chat-state.svelte'
  import type { PermissionEntry } from '$lib/chat/chat-state.svelte'
  import { loadApiKey, redact } from './ai-keys'
  import MobileChatSetup from './MobileChatSetup.svelte'
  import { build_structure_context } from '$lib/chat/context'
  import type { AnyStructure } from '$lib'
  import {
    add_chat_tab,
    chat_tab_label,
    chat_tabs,
    close_chat_tab,
    ensure_chat_seed,
    MAX_CHAT_TABS,
    set_chat_title,
    switch_chat_tab,
  } from './chat-tabs.svelte'
  import { t } from '$lib/i18n/index.svelte'

  interface Props {
    /** Dismiss the overlay back to the workspace. */
    on_close: () => void
    /** The structure currently open in the workspace, so CatBot can answer
     *  about it. The typed mobile chat has no other context source — the
     *  desktop ChatPane / voice paths don't run here. */
    structure?: AnyStructure
  }

  let { on_close, structure }: Props = $props()

  // Seed the first tab once, then drive the visible chat off the active tab id
  // (which IS the chat-state slice id). Multiple chats, each its own slice.
  ensure_chat_seed()
  const active_id = $derived(chat_tabs.active_id ?? `mobile`)
  const slice = $derived(get_chat_slice(active_id))

  // Long-press a tab → close action sheet (mirrors the terminal tab bar).
  let sheet_tab = $state<string | null>(null)
  let lp_timer: ReturnType<typeof setTimeout> | null = null
  let lp_fired = false
  $effect(() => () => {
    if (lp_timer) clearTimeout(lp_timer)
  })
  function tab_pointerdown(id: string): void {
    if (lp_timer) clearTimeout(lp_timer)
    lp_fired = false
    lp_timer = setTimeout(() => {
      lp_fired = true
      sheet_tab = id
    }, 500)
  }
  function tab_pointerup(): void {
    if (lp_timer) clearTimeout(lp_timer)
    lp_timer = null
  }
  function tab_click(id: string): void {
    if (lp_fired) {
      lp_fired = false // long-press already opened the sheet; swallow the click
      return
    }
    switch_chat_tab(id)
  }
  function sheet_close(): void {
    if (sheet_tab) {
      close_chat_tab(sheet_tab)
      sheet_tab = null
    }
  }

  // The current provider, read reactively off the persisted (non-secret) config.
  const provider = $derived(chat_config.provider)

  // The API key for the current provider, held in memory ONLY (never persisted).
  let local_key = $state(``)
  // Whether we've finished the initial key lookup (so we don't flash the setup
  // card before loadApiKey resolves).
  let key_checked = $state(false)
  // Force the setup card open (gear button / "fix your key" shortcut).
  let setup_open = $state(false)

  let input = $state(``)

  // Tool rows the user has tapped open (entries are replaced wholesale at the
  // start of each client-direct run, so no per-send cleanup is needed).
  const expanded_tools = new SvelteSet<string>()
  function toggle_tool(id: string): void {
    if (expanded_tools.has(id)) expanded_tools.delete(id)
    else expanded_tools.add(id)
  }

  // "Don't ask again this session" checkbox state for the permission card.
  let skip_session = $state(false)

  // The checkbox is per-card UI state; the effective bypass lives per-slice in
  // slice.skip_permission. Reset the checkbox when switching chat tabs.
  $effect(() => {
    void active_id
    skip_session = false
  })

  // Cap the permission-card input preview (structure params can be huge).
  function truncate_input(input: Record<string, unknown>): string {
    const text = JSON.stringify(input, null, 1)
    return text.length > 400 ? `${text.slice(0, 400)}…` : text
  }

  function decide_permission(entry: PermissionEntry, ok: boolean): void {
    entry.status = ok ? `approved` : `denied`
    if (ok && skip_session) slice.skip_permission.value = true
    entry.resolve?.(ok)
  }

  // Load the stored key for the current provider whenever it changes. Async-race
  // guard (§5): capture the provider; only apply if it's still selected on
  // resolve. The key goes into local $state AND chat_config (in-memory) so the
  // next send can read it.
  $effect(() => {
    const p = provider
    key_checked = false
    local_key = ``
    loadApiKey(p)
      .then((k) => {
        if (p !== chat_config.provider) return // provider changed mid-flight
        if (k) {
          local_key = k
          set_session_api_key(k)
        }
        key_checked = true
      })
      .catch(() => {
        if (p === chat_config.provider) key_checked = true
      })
  })

  // Scroll container bound in the template — used for auto-scroll below.
  let body_el = $state<HTMLElement | null>(null)

  // Auto-scroll to bottom on new content (messages, tool rows, permission
  // cards) — a pending permission card below the fold would otherwise look
  // like a hang while the tool loop blocks awaiting the decision.
  $effect(() => {
    // Touch the reactive sources so the effect re-runs on any of them.
    void slice.messages.list.length
    void get_display_text(
      slice.messages.list[slice.messages.list.length - 1]?.content ?? ``,
    ).length
    void Object.values(slice.active_tool_blocks.entries)
      .map((tb) => tb.status)
      .join()
    void Object.keys(slice.active_permission_blocks.entries).length
    const el = body_el
    if (!el) return
    tick().then(() => el.scrollTo({ top: el.scrollHeight }))
  })

  // Abort the active chat's in-flight stream when the overlay unmounts (§6).
  // Read active_id via `untrack` so the effect takes NO reactive dependency on
  // it — otherwise switching tabs would re-run the effect and its teardown would
  // cancel the stream of the tab you just LEFT (breaking per-tab background
  // streaming). With untrack, the teardown runs only on real unmount and cancels
  // whatever tab is active at that moment.
  $effect(() => () => cancel_generation(untrack(() => active_id)))

  const has_key = $derived(local_key.trim().length > 0)
  const show_setup = $derived(setup_open || (key_checked && !has_key))

  // 401 / invalid-key detection on the slice error so we can offer a shortcut
  // back to setup without echoing the raw provider body (which might reflect the
  // key — redact before display, §8 M).
  const error_text = $derived(slice.error.value ? redact(slice.error.value) : ``)
  const is_key_error = $derived(
    /401|invalid[_\s-]?api[_\s-]?key|unauthor/i.test(slice.error.value),
  )
  // Rate-limit / quota (429 / RESOURCE_EXHAUSTED) — common on free tiers. Show a
  // plain-language explanation instead of the raw provider JSON.
  const is_rate_limit = $derived(
    /429|resource_exhausted|quota|rate.?limit/i.test(slice.error.value),
  )
  // Transient server overload (503 / UNAVAILABLE / "high demand") — the auto-retry
  // already tried; tell the user it's temporary and to resend.
  const is_overloaded = $derived(
    /503|unavailable|overloaded|high demand|try again later/i.test(slice.error.value),
  )

  function on_setup_done(): void {
    setup_open = false
    // chat_config.provider may have changed — the $effect above reloads the key.
    // Also pull it straight away so has_key flips without waiting a tick.
    const p = chat_config.provider
    loadApiKey(p)
      .then((k) => {
        if (p === chat_config.provider && k) {
          local_key = k
          set_session_api_key(k)
        }
      })
      .catch(() => {/* leave to the $effect */})
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text) return
    // Label this tab by its first message (no-op once a title is set).
    set_chat_title(active_id, text)
    // Refresh the structure context from whatever's open RIGHT NOW, every send.
    // This is the typed mobile chat's only context source, and it must be
    // current across app restarts (structure restored, no load event fires) and
    // mid-conversation structure swaps. Empty string when nothing is open, which
    // correctly tells CatBot there's no structure.
    slice.structure_context.value = build_structure_context({ structure })
    // Push the in-memory key right before sending so stream_client_llm reads it
    // off chat_config.api_key (§5). Never persisted.
    set_session_api_key(local_key)
    input = ``
    await send_message(text, undefined, active_id)
  }

  function on_input_keydown(e: KeyboardEvent): void {
    // Enter sends; Shift+Enter inserts a newline (desktop-style). On a soft
    // keyboard the dedicated Send button is the primary path.
    if (e.key === `Enter` && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // ── Lightweight markdown → safe HTML (no katex / hljs) ──
  function escape_html(s: string): string {
    return s
      .replace(/&/g, `&amp;`)
      .replace(/</g, `&lt;`)
      .replace(/>/g, `&gt;`)
      .replace(/"/g, `&quot;`)
  }

  /** Minimal inline markdown: escape first, then **bold** + `code`. Splitting
   *  on backticks keeps code spans verbatim (no bold inside them). */
  function render_inline(escaped: string): string {
    const parts = escaped.split(/(`[^`]*`)/g)
    return parts
      .map((part) => {
        if (part.startsWith(`\``) && part.endsWith(`\``) && part.length >= 2) {
          return `<code>${part.slice(1, -1)}</code>`
        }
        return part.replace(/\*\*([^*]+)\*\*/g, `<strong>$1</strong>`)
      })
      .join(``)
  }

  /** Paragraphs (blank-line separated) → <p>, single newlines → <br>. */
  function render_markdown(text: string): string {
    return text
      .split(/\n{2,}/)
      .map((para) => {
        const inner = render_inline(escape_html(para)).replace(/\n/g, `<br>`)
        return `<p>${inner}</p>`
      })
      .join(``)
  }
</script>

<div class="ai-overlay">
  <header class="ai-head">
    <!-- Chat tab strip: tap = switch, long-press = close sheet, + = new (capped
         at MAX_CHAT_TABS). Mirrors the terminal tab bar. -->
    <div class="ai-tabbar" role="tablist" aria-label={t(`mobile.ai_title`)}>
      {#each chat_tabs.tabs as tab (tab.id)}
        <div class="ai-tabchip" class:active={tab.id === active_id}>
          <button
            type="button"
            class="ai-tabchip-btn"
            role="tab"
            aria-selected={tab.id === active_id}
            onclick={() => tab_click(tab.id)}
            onpointerdown={() => tab_pointerdown(tab.id)}
            onpointerup={tab_pointerup}
            onpointercancel={tab_pointerup}
            oncontextmenu={(e) => e.preventDefault()}
          ><span class="ai-tabchip-label">{chat_tab_label(tab)}</span></button>
        </div>
      {/each}
      {#if chat_tabs.tabs.length < MAX_CHAT_TABS}
        <button
          type="button"
          class="ai-tab-add"
          aria-label={t(`mobile.ai_new_chat`)}
          title={t(`mobile.ai_new_chat`)}
          onclick={() => add_chat_tab()}
        ><Icon icon="Plus" /></button>
      {/if}
    </div>
    <div class="ai-head-ctrls">
      <button
        type="button"
        class="ai-head-btn"
        aria-label={t(`mobile.ai_setup`)}
        title={t(`mobile.ai_setup`)}
        onclick={() => (setup_open = true)}
      ><Icon icon="Settings" /></button>
      <button
        type="button"
        class="ai-head-btn"
        aria-label={t(`mobile.ai_minimize`)}
        title={t(`mobile.ai_minimize`)}
        onclick={on_close}
      ><Icon icon="Collapse" /></button>
    </div>
  </header>

  {#if show_setup}
    <div class="ai-setup-host">
      <MobileChatSetup on_done={on_setup_done} />
    </div>
  {:else}
    <div class="ai-body" bind:this={body_el}>
      {#if slice.messages.list.length === 0}
        <div class="ai-empty">
          <Icon icon="Chat" />
          <p>{t(`mobile.ai_empty`)}</p>
        </div>
      {:else}
        {#each slice.messages.list as msg, i (i)}
          {@const text = get_display_text(msg.content)}
          {#if text}
            <div class="ai-msg" class:user={msg.role === `user`}>
              <!-- Safe: render_markdown HTML-escapes its input before applying
                   the tiny inline transform, so no user text reaches the DOM
                   unescaped. -->
              <div class="ai-msg-body">{@html render_markdown(text)}</div>
            </div>
          {/if}
        {/each}
      {/if}

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
            <pre class="ai-perm-input">{truncate_input(pb.input)}</pre>
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

      {#if slice.loading.value}
        <div class="ai-thinking" aria-live="polite">
          <span class="ai-dots" aria-hidden="true"></span>
          <span>{t(`mobile.ai_thinking`)}</span>
        </div>
      {/if}

      {#if error_text}
        <div class="ai-error" role="alert">
          <span>
            {#if is_key_error}
              {t(`mobile.ai_invalid_key`)}
            {:else if is_rate_limit}
              {t(`mobile.ai_rate_limited`)}
            {:else if is_overloaded}
              {t(`mobile.ai_model_busy`)}
            {:else}
              {error_text}
            {/if}
          </span>
          {#if is_key_error || is_rate_limit || is_overloaded}
            <button type="button" class="ai-error-fix" onclick={() => (setup_open = true)}>
              {t(`mobile.ai_setup`)}
            </button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="ai-composer">
      <textarea
        class="ai-input"
        rows="1"
        placeholder={t(`mobile.ai_message_placeholder`)}
        bind:value={input}
        onkeydown={on_input_keydown}
      ></textarea>
      {#if slice.loading.value}
        <button
          type="button"
          class="ai-send stop"
          aria-label={t(`mobile.ai_stop`)}
          onclick={() => cancel_generation(active_id)}
        ><Icon icon="Close" /></button>
      {:else}
        <button
          type="button"
          class="ai-send"
          aria-label={t(`mobile.ai_send`)}
          disabled={!input.trim()}
          onclick={send}
        ><Icon icon="ArrowUp" /></button>
      {/if}
    </div>
  {/if}

  {#if sheet_tab}
    <!-- Long-press close sheet for a chat tab (mirrors the terminal one). -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="ai-sheet-backdrop" role="presentation" onclick={() => (sheet_tab = null)}>
      <div
        class="ai-sheet"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <button type="button" class="ai-sheet-btn danger" onclick={sheet_close}>
          {t(`mobile.ai_close_chat`)}
        </button>
        <button type="button" class="ai-sheet-btn" onclick={() => (sheet_tab = null)}>
          {t(`common.cancel`)}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .ai-overlay {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    background: var(--page-bg, #0e1117);
  }
  .ai-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
    padding: 8px 10px;
    padding-top: max(8px, env(safe-area-inset-top));
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .ai-head-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 40px;
    min-height: 40px;
    font-size: 17px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
  }
  .ai-head-ctrls {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .ai-tabbar {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .ai-tabbar::-webkit-scrollbar {
    display: none;
  }
  .ai-tabchip {
    position: relative;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .ai-tabchip-btn {
    display: inline-flex;
    align-items: center;
    max-width: 120px;
    min-height: 32px;
    padding: 0 10px;
    font-size: 12px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    cursor: pointer;
    /* iOS: long-press (to close) must not text-select the tab label. */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .ai-tabchip.active .ai-tabchip-btn {
    color: var(--accent-color, #3b82f6);
    border-color: var(--accent-color, #3b82f6);
    background: rgba(59, 130, 246, 0.1);
  }
  .ai-tabchip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-tab-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    font-size: 14px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
  }
  /* Long-press close action sheet (mirrors MobileWorkspace's terminal sheet). */
  .ai-sheet-backdrop {
    position: absolute;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .ai-sheet {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    padding: 12px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    background: var(--page-bg, #0e1117);
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .ai-sheet-btn {
    min-height: 48px;
    font-size: 15px;
    color: var(--text-color, #e0e0e0);
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .ai-sheet-btn.danger {
    color: #ff6b6b;
    border-color: rgba(255, 107, 107, 0.5);
  }
  .ai-setup-host {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .ai-setup-host :global(.cs-wrap) {
    flex: 1;
  }
  .ai-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    overflow-y: auto;
  }
  .ai-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font-size: 22px;
    color: var(--text-color-muted, #94a3b8);
  }
  .ai-empty p {
    font-size: 0.7em;
    margin: 0;
  }
  .ai-msg {
    max-width: 86%;
    padding: 10px 12px;
    border-radius: 12px;
    font-size: 15px;
    line-height: 1.5;
    color: var(--text-color, #e0e0e0);
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.1);
    align-self: flex-start;
  }
  .ai-msg.user {
    align-self: flex-end;
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border-color: var(--accent-color, #0a84ff);
  }
  .ai-msg-body :global(p) {
    margin: 0 0 0.5em;
  }
  .ai-msg-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .ai-msg-body :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    padding: 1px 5px;
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.3);
  }
  .ai-thinking {
    display: flex;
    align-items: center;
    gap: 8px;
    align-self: flex-start;
    font-size: 0.85em;
    color: var(--text-color-muted, #94a3b8);
  }
  .ai-dots {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: var(--accent-color, #3b82f6);
    border-radius: 50%;
    animation: ai-spin 0.8s linear infinite;
  }
  @keyframes ai-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .ai-error {
    display: flex;
    align-items: center;
    gap: 10px;
    align-self: stretch;
    font-size: 0.85em;
    color: #ff6b6b;
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid rgba(255, 107, 107, 0.3);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .ai-error span {
    flex: 1;
    min-width: 0;
  }
  .ai-error-fix {
    flex-shrink: 0;
    min-height: 32px;
    padding: 0 12px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  .ai-composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-shrink: 0;
    padding: 10px;
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    background: rgba(0, 0, 0, 0.3);
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .ai-input {
    flex: 1;
    min-width: 0;
    max-height: 120px;
    padding: 10px 12px;
    font-size: 16px; /* >=16px stops iOS zoom-on-focus. */
    font-family: inherit;
    line-height: 1.4;
    color: var(--text-color, #e0e0e0);
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 10px;
    outline: none;
    resize: none;
    box-sizing: border-box;
  }
  .ai-input:focus {
    border-color: var(--accent-color, #3b82f6);
  }
  .ai-send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    font-size: 18px;
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border: none;
    border-radius: 10px;
    cursor: pointer;
  }
  .ai-send:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ai-send.stop {
    background: #ff6b6b;
  }
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
    cursor: pointer;
  }
  .ai-tool-mark.ok { color: var(--success-color, #4ade80); }
  .ai-tool-mark.err { color: #ff6b6b; }
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
  .ai-perm-input {
    max-height: 120px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .ai-perm {
    margin: 6px 0;
    padding: 10px;
    border: 1px solid rgba(250, 204, 21, 0.6);
    border-radius: 10px;
    display: grid;
    gap: 8px;
  }
  .ai-perm-title { font-weight: 600; font-size: 14px; color: var(--text-color, #e0e0e0); }
  .ai-perm-tool { font-family: monospace; font-size: 13px; color: var(--text-color-muted, #94a3b8); }
  .ai-perm-skip { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-color-muted, #94a3b8); }
  .ai-perm-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .ai-perm-actions button {
    min-height: 40px;
    padding: 0 16px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 14px;
    cursor: pointer;
  }
  .ai-perm-allow { background: var(--accent-color, #3b82f6); color: white; }
  .ai-perm-deny {
    background: transparent;
    border-color: rgba(255, 255, 255, 0.12) !important;
    color: var(--text-color-muted, #94a3b8);
  }
</style>

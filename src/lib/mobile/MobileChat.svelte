<!--
  MobileChat.svelte — full-screen AI chat overlay for the mobile workspace.

  Mirrors the .mw-files-overlay pattern. Reuses the existing chat lifecycle
  (get_chat_slice / send_message / cancel_generation) under tab id 'mobile', so
  history, the loading indicator, abort, and the pending-send queue all come for
  free (§4). Text-only: chat-state runs the client-direct loop with an EMPTY
  tool list on mobile.

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
  import Icon from '$lib/Icon.svelte'
  import { get_display_text } from '$lib/chat/types'
  import {
    cancel_generation,
    chat_config,
    get_chat_slice,
    send_message,
    set_session_api_key,
  } from '$lib/chat/chat-state.svelte'
  import { loadApiKey, redact } from './ai-keys'
  import MobileChatSetup from './MobileChatSetup.svelte'
  import { t } from '$lib/i18n/index.svelte'

  interface Props {
    /** Dismiss the overlay back to the workspace. */
    on_close: () => void
  }

  let { on_close }: Props = $props()

  const TAB = `mobile`
  const slice = $derived(get_chat_slice(TAB))

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

  // Abort any in-flight stream when the overlay unmounts (§6).
  $effect(() => () => cancel_generation(TAB))

  const has_key = $derived(local_key.trim().length > 0)
  const show_setup = $derived(setup_open || (key_checked && !has_key))

  // 401 / invalid-key detection on the slice error so we can offer a shortcut
  // back to setup without echoing the raw provider body (which might reflect the
  // key — redact before display, §8 M).
  const error_text = $derived(slice.error.value ? redact(slice.error.value) : ``)
  const is_key_error = $derived(
    /401|invalid[_\s-]?api[_\s-]?key|unauthor/i.test(slice.error.value),
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
    // Push the in-memory key right before sending so stream_client_llm reads it
    // off chat_config.api_key (§5). Never persisted.
    set_session_api_key(local_key)
    input = ``
    await send_message(text, undefined, TAB)
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
    <button
      type="button"
      class="ai-head-btn"
      aria-label={t(`mobile.back`)}
      title={t(`mobile.back`)}
      onclick={on_close}
    ><Icon icon="Close" /></button>
    <span class="ai-head-title">{t(`mobile.ai_title`)} · {provider}</span>
    <button
      type="button"
      class="ai-head-btn"
      aria-label={t(`mobile.ai_setup`)}
      title={t(`mobile.ai_setup`)}
      onclick={() => (setup_open = true)}
    ><Icon icon="Settings" /></button>
  </header>

  {#if show_setup}
    <div class="ai-setup-host">
      <MobileChatSetup on_done={on_setup_done} />
    </div>
  {:else}
    <div class="ai-body">
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

      {#if slice.loading.value}
        <div class="ai-thinking" aria-live="polite">
          <span class="ai-dots" aria-hidden="true"></span>
          <span>{t(`mobile.ai_thinking`)}</span>
        </div>
      {/if}

      {#if error_text}
        <div class="ai-error" role="alert">
          <span>{is_key_error ? t(`mobile.ai_invalid_key`) : error_text}</span>
          {#if is_key_error}
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
          onclick={() => cancel_generation(TAB)}
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
  .ai-head-title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    font-size: 0.95em;
    text-align: center;
    color: var(--text-color, #e0e0e0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
</style>

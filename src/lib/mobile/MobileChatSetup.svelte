<!--
  MobileChatSetup.svelte — first-run / settings card for the mobile AI chat.

  Picks an API-key provider (no SDK agents — mobile has no backend), takes the
  key (+ a base URL for custom/ollama), then:
    1. saveApiKey(provider, key)  → native encrypted store (AES-256-GCM at rest)
    2. update_config({...})       → PERSISTS provider/model/base_url/client_direct/
                                     mode to localStorage (non-secret fields only)
    3. set_session_api_key(key)   → in-memory ONLY; the key is NEVER persisted

  Mirrors MobileConnect / KeySetup styling. The key lives in a local $state and
  in the native store — never in localStorage. See docs §4, §5, §8.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import type { ChatConfig, ChatMessage, LLMProvider } from '$lib/chat/types'
  import {
    chat_config,
    set_session_api_key,
    update_config,
  } from '$lib/chat/chat-state.svelte'
  import { stream_client_llm } from '$lib/chat/client-llm'
  import {
    loadApiKey,
    mobile_chat_providers,
    saveApiKey,
    validate_base_url,
  } from './ai-keys'
  import { t } from '$lib/i18n/index.svelte'

  interface Props {
    /** Emitted once the provider + key (+ base URL) are saved and applied. */
    on_done?: () => void
  }

  let { on_done }: Props = $props()

  // Sensible default model per provider — avoids a key-bearing model-list fetch
  // (§8 C). The user can change the model later via the manual field.
  const DEFAULT_MODELS: Record<LLMProvider, string> = {
    'sdk-claude': ``,
    'sdk-codex': ``,
    'sdk-gemini': ``,
    anthropic: `claude-3-5-sonnet-latest`,
    // gemini-2.0-flash was retired 2026-03-03 (free-tier quota → 0, every call
    // 429s); 2.5-flash is the current free-tier default.
    gemini: `gemini-2.5-flash`,
    deepseek: `deepseek-chat`,
    qwen: `qwen-plus`,
    kimi: `moonshot-v1-8k`,
    zhipu: `glm-4-plus`,
    custom: ``,
    ollama: `llama3.2`,
  }

  // Default base URL for self-hosted/local providers (custom has none — the user
  // must supply it; ollama defaults to the local daemon).
  const DEFAULT_BASE_URLS: Partial<Record<LLMProvider, string>> = {
    ollama: `http://localhost:11434/v1`,
  }

  const providers = mobile_chat_providers()
  const initial_provider: LLMProvider = providers[0] ?? `anthropic`

  // Title-case a provider id for display (deepseek → Deepseek).
  const display = (p: string): string => p.charAt(0).toUpperCase() + p.slice(1)

  let provider = $state<LLMProvider>(initial_provider)
  // What the user types when adding/replacing a key. The saved key itself is
  // NEVER loaded into this field — only `has_saved_key` (a boolean) drives the
  // UI; the real secret is fetched in-memory at save time (see save()).
  let entered_key = $state(``)
  let has_saved_key = $state(false)
  let replacing = $state(false)
  let base_url = $state(``)
  // Reference the const (not the `provider` $state) so this initializer doesn't
  // trip Svelte's state_referenced_locally warning; the value is identical.
  let model = $state(DEFAULT_MODELS[initial_provider] ?? ``)
  let error_msg = $state(``)
  let saving = $state(false)
  // Connection-test state: a tiny live request via the real chat path (see
  // test_connection). 'idle' hides the result; reset whenever inputs change so a
  // stale ✓ never lingers after editing the key/provider.
  let testing = $state(false)
  let test_status = $state<`idle` | `ok` | `fail`>(`idle`)
  let test_msg = $state(``)
  function reset_test(): void {
    test_status = `idle`
    test_msg = ``
  }

  // custom/ollama need a base URL (OpenAI-compat endpoint we can't infer).
  const needs_base_url = $derived(provider === `custom` || provider === `ollama`)
  // ollama typically needs no key; everything else does.
  const key_optional = $derived(provider === `ollama`)
  // Show the password input when nothing is saved yet, or the user chose Replace.
  const show_key_input = $derived(!has_saved_key || replacing)

  // Refresh the saved-key STATUS (a boolean — never the key) for a provider, so
  // re-opening setup reflects what's already configured. The actual secret stays
  // in the native store and is only read in-memory at save time.
  function refresh_saved(p: LLMProvider): void {
    has_saved_key = false
    replacing = false
    entered_key = ``
    loadApiKey(p)
      .then((k) => {
        // Async-race guard: only apply if the picker hasn't moved on (§5).
        if (p === provider) has_saved_key = !!k
      })
      .catch(() => {
        /* no stored key / desktop transport — type it manually */
      })
  }

  // When the picker changes, reset the model default + prefill any known base URL
  // and re-check whether that provider already has a saved key.
  function on_provider_change(): void {
    error_msg = ``
    reset_test()
    model = DEFAULT_MODELS[provider] ?? ``
    base_url = DEFAULT_BASE_URLS[provider] ?? ``
    refresh_saved(provider)
  }

  const can_test = $derived(
    !testing &&
      !saving &&
      (key_optional || has_saved_key || entered_key.trim().length > 0) &&
      (!needs_base_url || base_url.trim().length > 0),
  )

  // Probe the provider with a tiny "ping" through the SAME path a real message
  // takes (stream_client_llm): faithful auth headers, endpoint, retries. The
  // first non-error event = reachable + key valid; an `error` event = the reason.
  async function test_connection(): Promise<void> {
    if (!can_test) return
    reset_test()
    if (needs_base_url) {
      const v = validate_base_url(base_url)
      if (!v.ok) {
        test_status = `fail`
        test_msg = v.reason
        return
      }
    }
    testing = true
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 30000)
    try {
      // Use the typed key, else the saved one (fetched in-memory, never shown).
      const key = entered_key.trim() || (await loadApiKey(provider)) || ``
      const cfg: ChatConfig = {
        ...chat_config,
        provider,
        model: model.trim() || DEFAULT_MODELS[provider] || ``,
        base_url: needs_base_url ? base_url.trim() : ``,
        api_key: key,
        max_tokens: 8, // a one-word reply is all we need to prove the round-trip
        client_direct: true,
        mode: `universal`,
      }
      const messages: ChatMessage[] = [
        { role: `user`, content: `ping`, timestamp: Date.now() },
      ]
      for await (
        const ev of stream_client_llm(messages, cfg, `Reply with "ok".`, [], ac.signal)
      ) {
        if (ev.type === `error`) {
          test_status = `fail`
          test_msg = ev.message
          return
        }
        // First real token / completion → the round-trip works.
        if (ev.type === `text` || ev.type === `done` || ev.type === `tool_calls`) break
      }
      test_status = `ok`
    } catch (e: unknown) {
      test_status = `fail`
      test_msg = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
      testing = false
    }
  }

  // Preload the saved-key status for the initial provider on first render, so a
  // returning user sees "API key saved" instead of an empty field.
  onMount(() => refresh_saved(initial_provider))

  const can_save = $derived(
    !saving &&
      (key_optional || has_saved_key || entered_key.trim().length > 0) &&
      (!needs_base_url || base_url.trim().length > 0),
  )

  async function save(): Promise<void> {
    if (saving) return
    error_msg = ``

    if (needs_base_url) {
      const v = validate_base_url(base_url)
      if (!v.ok) {
        error_msg = v.reason
        return
      }
    }

    saving = true
    try {
      const typed = entered_key.trim()
      // 1. Persist a newly entered / replacement key in the native encrypted
      //    store (per provider). If the user kept the existing key, skip this.
      if (typed) await saveApiKey(provider, typed)
      // 2. The session needs the ACTUAL key in memory for the next send. If the
      //    user didn't type one, fetch the saved key transiently here — it is
      //    never rendered into the UI, only handed to the in-memory session.
      const key = typed || (await loadApiKey(provider)) || ``
      // 3. Persist the NON-SECRET config (provider/model/base_url/client_direct/
      //    mode) to localStorage. client_direct: true lights the in-browser
      //    provider-direct path; universal mode = OpenAI-compat.
      update_config({
        provider,
        model: model.trim() || DEFAULT_MODELS[provider] || ``,
        base_url: needs_base_url ? base_url.trim() : ``,
        client_direct: true,
        mode: `universal`,
      })
      // 4. Push the key into memory ONLY (never persisted to localStorage) so the
      //    very next send can read it off chat_config.api_key.
      set_session_api_key(key)
      on_done?.()
    } catch (e: unknown) {
      error_msg = e instanceof Error ? e.message : String(e)
    } finally {
      saving = false
    }
  }
</script>

<div class="cs-wrap">
  <div class="cs-card">
    <div class="cs-title">{t(`mobile.ai_setup`)}</div>
    <p class="cs-subtitle">{t(`mobile.ai_setup_subtitle`)}</p>

    <form
      class="cs-form"
      onsubmit={(e) => {
        e.preventDefault()
        if (can_save) save()
      }}
    >
      <label class="field">
        <span>{t(`mobile.ai_provider`)}</span>
        <select bind:value={provider} onchange={on_provider_change}>
          {#each providers as p (p)}
            <option value={p}>{display(p)}</option>
          {/each}
        </select>
      </label>

      <div class="field">
        <span>{t(`mobile.ai_api_key`)}</span>
        {#if show_key_input}
          <input
            type="password"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            autocomplete="off"
            placeholder={t(`mobile.ai_api_key_placeholder`)}
            bind:value={entered_key}
            oninput={reset_test}
          />
        {:else}
          <div class="cs-saved">
            <span class="cs-saved-badge">
              <span class="cs-saved-check" aria-hidden="true">✓</span>
              {t(`mobile.ai_key_saved`)}
            </span>
            <button
              type="button"
              class="cs-replace"
              onclick={() => {
                replacing = true
                reset_test()
              }}
            >
              {t(`mobile.ai_replace_key`)}
            </button>
          </div>
        {/if}
      </div>

      {#if needs_base_url}
        <label class="field">
          <span>{t(`mobile.ai_base_url`)}</span>
          <input
            type="text"
            inputmode="url"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            placeholder={t(`mobile.ai_base_url_placeholder`)}
            bind:value={base_url}
            oninput={reset_test}
          />
        </label>
      {/if}

      <label class="field">
        <span>{t(`mobile.ai_model`)}</span>
        <input
          type="text"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder={DEFAULT_MODELS[provider] ?? ``}
          bind:value={model}
          oninput={reset_test}
        />
      </label>

      <button
        type="button"
        class="cs-btn-secondary"
        disabled={!can_test}
        onclick={test_connection}
      >
        {testing ? t(`mobile.ai_testing`) : t(`mobile.ai_test_connection`)}
      </button>

      {#if test_status === `ok`}
        <div class="cs-test-ok" role="status">
          <span class="cs-saved-check" aria-hidden="true">✓</span>
          {t(`mobile.ai_test_ok`)}
        </div>
      {:else if test_status === `fail`}
        <div class="cs-error" role="alert">{test_msg}</div>
      {/if}

      {#if error_msg}
        <div class="cs-error" role="alert">{error_msg}</div>
      {/if}

      <button type="submit" class="cs-btn" disabled={!can_save}>
        {saving ? t(`mobile.ai_saving`) : t(`mobile.ai_save`)}
      </button>
    </form>
  </div>
</div>

<style>
  .cs-wrap {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 16px;
    padding-top: max(16px, env(safe-area-inset-top));
    overflow-y: auto;
    background: var(--page-bg, #0e1117);
    box-sizing: border-box;
  }
  .cs-card {
    width: 100%;
    max-width: 480px;
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 20px;
  }
  .cs-title {
    font-size: 1.25em;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text-color, #e0e0e0);
    margin: 0 0 4px;
  }
  .cs-subtitle {
    font-size: 0.82em;
    line-height: 1.4;
    color: var(--text-color-muted, #94a3b8);
    margin: 0 0 18px;
  }
  .cs-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field > span {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--text-color-muted, #94a3b8);
  }
  .field input,
  .field select {
    width: 100%;
    padding: 11px 12px;
    font-size: 16px; /* >=16px stops iOS zoom-on-focus. */
    color: var(--text-color, #e0e0e0);
    /* Neutral translucent fill so it reads cleanly on both light + dark themes
       (the old rgba(0,0,0,.3) went muddy-gray on a light background). */
    background: rgba(128, 128, 140, 0.1);
    border: 1px solid rgba(128, 128, 140, 0.28);
    border-radius: 9px;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .field input::placeholder {
    color: var(--text-color-muted, #94a3b8);
    opacity: 0.7;
  }
  .field input:focus,
  .field select:focus {
    border-color: var(--accent-color, #6366f1);
    background: rgba(128, 128, 140, 0.06);
  }
  /* Saved-key row: status + Replace, shown instead of the password input once a
     key exists. The key itself is never rendered — only this badge. */
  .cs-saved {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 9px;
    background: rgba(52, 199, 89, 0.1);
    border: 1px solid rgba(52, 199, 89, 0.3);
  }
  .cs-saved-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: 1;
    font-size: 0.92em;
    font-weight: 600;
    color: var(--text-color, #e0e0e0);
  }
  .cs-saved-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #34c759;
    color: #fff;
    font-size: 0.72em;
    font-weight: 700;
  }
  .cs-replace {
    flex-shrink: 0;
    padding: 5px 12px;
    font-size: 0.82em;
    font-weight: 600;
    color: var(--accent-color, #6366f1);
    background: transparent;
    border: 1px solid rgba(128, 128, 140, 0.32);
    border-radius: 7px;
    cursor: pointer;
  }
  .cs-replace:active {
    background: rgba(128, 128, 140, 0.12);
  }
  .cs-error {
    font-size: 0.85em;
    color: #ff6b6b;
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid rgba(255, 107, 107, 0.3);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .cs-btn {
    min-height: 48px;
    margin-top: 4px;
    font-size: 16px;
    font-weight: 600;
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border: 1px solid var(--accent-color, #0a84ff);
    border-radius: 8px;
    cursor: pointer;
  }
  .cs-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cs-btn-secondary {
    min-height: 44px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-color, #e0e0e0);
    background: rgba(128, 128, 140, 0.12);
    border: 1px solid rgba(128, 128, 140, 0.3);
    border-radius: 8px;
    cursor: pointer;
  }
  .cs-btn-secondary:active {
    background: rgba(128, 128, 140, 0.2);
  }
  .cs-btn-secondary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cs-test-ok {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 0.88em;
    font-weight: 600;
    color: #34c759;
  }
</style>

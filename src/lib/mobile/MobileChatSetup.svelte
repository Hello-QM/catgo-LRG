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
  import type { LLMProvider } from '$lib/chat/types'
  import { update_config, set_session_api_key } from '$lib/chat/chat-state.svelte'
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

  let provider = $state<LLMProvider>(initial_provider)
  let api_key = $state(``)
  let base_url = $state(``)
  // Reference the const (not the `provider` $state) so this initializer doesn't
  // trip Svelte's state_referenced_locally warning; the value is identical.
  let model = $state(DEFAULT_MODELS[initial_provider] ?? ``)
  let error_msg = $state(``)
  let saving = $state(false)

  // custom/ollama need a base URL (OpenAI-compat endpoint we can't infer).
  const needs_base_url = $derived(provider === `custom` || provider === `ollama`)
  // ollama typically needs no key; everything else does.
  const key_optional = $derived(provider === `ollama`)

  // When the picker changes, reset the model default + prefill any known base URL
  // and preload an already-saved key for that provider so re-opening setup shows
  // it is configured (the key itself stays in the native store / in-memory only).
  function on_provider_change(): void {
    error_msg = ``
    api_key = ``
    model = DEFAULT_MODELS[provider] ?? ``
    base_url = DEFAULT_BASE_URLS[provider] ?? ``
    const p = provider
    loadApiKey(p)
      .then((k) => {
        // Async-race guard: only apply if the picker hasn't moved on (§5).
        if (p === provider && k) api_key = k
      })
      .catch(() => {
        /* no stored key / desktop transport — type it manually */
      })
  }

  const can_save = $derived(
    !saving &&
      (key_optional || api_key.trim().length > 0) &&
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
      const key = api_key.trim()
      // 1. Persist the key in the native encrypted store (per provider).
      if (key) await saveApiKey(provider, key)
      // 2. Persist the NON-SECRET config (provider/model/base_url/client_direct/
      //    mode) to localStorage. client_direct: true lights the in-browser
      //    provider-direct path; universal mode = OpenAI-compat.
      update_config({
        provider,
        model: model.trim() || DEFAULT_MODELS[provider] || ``,
        base_url: needs_base_url ? base_url.trim() : ``,
        client_direct: true,
        mode: `universal`,
      })
      // 3. Push the key into memory ONLY (never persisted) so the very next send
      //    can read it off chat_config.api_key.
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
            <option value={p}>{p}</option>
          {/each}
        </select>
      </label>

      <label class="field">
        <span>{t(`mobile.ai_api_key`)}</span>
        <input
          type="password"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          autocomplete="off"
          placeholder={t(`mobile.ai_api_key_placeholder`)}
          bind:value={api_key}
        />
      </label>

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
        />
      </label>

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
    font-size: 1.15em;
    font-weight: 600;
    color: var(--text-color, #e0e0e0);
    margin-bottom: 16px;
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
    font-size: 0.85em;
    color: var(--text-color-muted, #94a3b8);
  }
  .field input,
  .field select {
    width: 100%;
    padding: 10px 12px;
    font-size: 16px; /* >=16px stops iOS zoom-on-focus. */
    color: var(--text-color, #e0e0e0);
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    outline: none;
    box-sizing: border-box;
  }
  .field input:focus,
  .field select:focus {
    border-color: var(--accent-color, #3b82f6);
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
</style>

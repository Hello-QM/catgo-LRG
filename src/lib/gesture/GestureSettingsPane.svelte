<script lang="ts">
  /**
   * Voice & Gesture settings panel.
   *
   * Simple floating panel — positioned absolutely in the top-right of the viewer.
   * Changes are auto-saved to localStorage.
   */
  import { onMount } from 'svelte'
  import type { GestureConfig, VoiceMethod, WhisperMode } from './gesture-types'
  import type { ModelStatus } from './local-whisper'
  import { save_gesture_config } from './gesture-config-store'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('structure')

  let {
    config = $bindable(),
    pane_open = $bindable(false),
    model_download_status = `idle` as ModelStatus,
    model_download_progress = 0,
  }: {
    config: GestureConfig
    pane_open?: boolean
    model_download_status?: ModelStatus
    model_download_progress?: number
  } = $props()

  let available_voices = $state<SpeechSynthesisVoice[]>([])
  let panel_el: HTMLDivElement | undefined = $state()

  // Check if Web Speech API is available in this browser
  const web_speech_supported = typeof window !== `undefined`
    && (`SpeechRecognition` in window || `webkitSpeechRecognition` in window)

  onMount(() => {
    if (typeof window !== `undefined` && `speechSynthesis` in window) {
      const load_voices = () => {
        available_voices = window.speechSynthesis.getVoices()
      }
      load_voices()
      window.speechSynthesis.onvoiceschanged = load_voices
    }
  })

  function update(updates: Partial<GestureConfig>) {
    config = { ...config, ...updates }
    save_gesture_config(config)
  }

  // Group voices by language match
  let lang_prefix = $derived(config.voice_language?.split(`-`)[0] ?? `en`)
  let matching_voices = $derived(available_voices.filter(v => v.lang.startsWith(lang_prefix)))
  let other_voices = $derived(available_voices.filter(v => !v.lang.startsWith(lang_prefix)))

  // Show Whisper options when method is whisper or auto fallback
  let show_whisper_options = $derived(
    config.voice_method === `whisper`
    || (config.voice_method === `auto` && !web_speech_supported),
  )

  // Show API key field only for cloud or auto whisper modes
  let needs_whisper_key = $derived(
    show_whisper_options
    && (config.whisper_mode === `cloud` || config.whisper_mode === `auto`),
  )

  const LANGUAGES: Array<{ value: string; label: string }> = [
    { value: `en-US`, label: `English (US)` },
    { value: `en-GB`, label: `English (UK)` },
    { value: `zh-CN`, label: `中文（简体）` },
    { value: `zh-TW`, label: `中文（繁體）` },
    { value: `ja-JP`, label: `日本語` },
    { value: `ko-KR`, label: `한국어` },
    { value: `de-DE`, label: `Deutsch` },
    { value: `fr-FR`, label: `Français` },
    { value: `es-ES`, label: `Español` },
  ]

  const METHODS: Array<{ value: VoiceMethod; label_key: string; desc_key: string }> = [
    { value: `auto`, label_key: `structure.gesture_auto`, desc_key: `structure.gesture_web_speech_to_whisper` },
    { value: `web_speech`, label_key: `structure.gesture_web_speech_api`, desc_key: `structure.gesture_free_chrome_edge` },
    { value: `whisper`, label_key: `structure.gesture_whisper`, desc_key: `structure.gesture_local_or_cloud` },
  ]

  const WHISPER_MODES: Array<{ value: WhisperMode; label_key: string; desc_key: string }> = [
    { value: `auto`, label_key: `structure.gesture_auto`, desc_key: `structure.gesture_local_cloud_fallback` },
    { value: `local`, label_key: `structure.gesture_local`, desc_key: `structure.gesture_in_browser_no_key` },
    { value: `cloud`, label_key: `structure.gesture_cloud`, desc_key: `structure.gesture_openai_needs_key` },
  ]

  function on_click_outside(e: PointerEvent | MouseEvent) {
    // Ignore clicks on gesture-toggle buttons (they handle their own toggle)
    const target = e.target as HTMLElement
    if (target.closest?.(`.gesture-toggle`)) return
    if (panel_el && !panel_el.contains(target)) {
      pane_open = false
    }
  }
</script>

<svelte:window onpointerdown={pane_open ? on_click_outside : undefined} />

{#if pane_open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="gesture-settings" bind:this={panel_el} onclick={(e) => e.stopPropagation()}>
    <div class="panel-header">
      <h4>{t('structure.voice_gesture')}</h4>
      <button class="close-btn" onclick={() => { pane_open = false }} aria-label={t('common.close')}>&times;</button>
    </div>

    <div class="panel-body">
      <!-- Section 1: Voice Recognition -->
      <section>
        <h5>{t('structure.voice_recognition')}</h5>

        <div class="param-row">
          <span class="label">{t('structure.method')}</span>
          <select
            value={config.voice_method ?? `auto`}
            onchange={(e) => update({ voice_method: (e.target as HTMLSelectElement).value as VoiceMethod })}
          >
            {#each METHODS as m}
              <option value={m.value}>{t(m.label_key)} ({t(m.desc_key)})</option>
            {/each}
          </select>
        </div>

        {#if config.voice_method === `web_speech` && !web_speech_supported}
          <p class="warning">{t('structure.gesture_web_speech_unavailable')}</p>
        {/if}

        <div class="param-row">
          <span class="label">{t('common.language')}</span>
          <select
            value={config.voice_language}
            onchange={(e) => update({ voice_language: (e.target as HTMLSelectElement).value })}
          >
            {#each LANGUAGES as lang}
              <option value={lang.value}>{lang.label}</option>
            {/each}
          </select>
        </div>

        {#if show_whisper_options}
          <div class="param-row">
            <span class="label">{t('structure.gesture_backend')}</span>
            <select
              value={config.whisper_mode ?? `auto`}
              onchange={(e) => update({ whisper_mode: (e.target as HTMLSelectElement).value as WhisperMode })}
            >
              {#each WHISPER_MODES as m}
                <option value={m.value}>{t(m.label_key)} ({t(m.desc_key)})</option>
              {/each}
            </select>
          </div>

          {#if model_download_status === `downloading`}
            <div class="progress-row">
              <span class="label">{t('structure.gesture_model')}</span>
              <div class="progress-bar">
                <div class="progress-fill" style:width="{Math.round(model_download_progress)}%"></div>
              </div>
              <span class="range-val">{Math.round(model_download_progress)}%</span>
            </div>
          {:else if model_download_status === `loading`}
            <p class="info-text">{t('structure.gesture_loading_model')}</p>
          {/if}
        {/if}

        {#if needs_whisper_key}
          <div class="param-row">
            <span class="label">{t('structure.gesture_api_key')}</span>
            <input
              type="password"
              value={config.whisper_api_key ?? ``}
              placeholder="sk-..."
              oninput={(e) => update({ whisper_api_key: (e.target as HTMLInputElement).value.trim() })}
            />
          </div>
        {/if}

        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={config.noise_suppression}
            onchange={() => update({ noise_suppression: !config.noise_suppression })}
          />
          <span>{t('structure.gesture_noise_suppression')}</span>
        </label>

        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={config.voice_ai_enabled}
            onchange={() => update({ voice_ai_enabled: !config.voice_ai_enabled })}
          />
          <span>{t('structure.gesture_route_unknown_ai')}</span>
        </label>
      </section>

      <!-- Section 2: Text-to-Speech -->
      <section>
        <h5>{t('structure.text_to_speech')}</h5>

        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={config.tts_enabled}
            onchange={() => update({ tts_enabled: !config.tts_enabled })}
          />
          <span>{t('structure.gesture_enable_voice_responses')}</span>
        </label>

        {#if config.tts_enabled}
          <div class="param-row">
            <span class="label">{t('structure.gesture_voice')}</span>
            <select
              value={config.tts_voice ?? ``}
              onchange={(e) => update({ tts_voice: (e.target as HTMLSelectElement).value })}
            >
              <option value="">{t('structure.gesture_auto_by_language')}</option>
              {#if matching_voices.length > 0}
                <optgroup label={t('structure.gesture_matching_language')}>
                  {#each matching_voices as v}
                    <option value={v.name}>{v.name}</option>
                  {/each}
                </optgroup>
              {/if}
              {#if other_voices.length > 0}
                <optgroup label={t('structure.gesture_other')}>
                  {#each other_voices as v}
                    <option value={v.name}>{v.name} ({v.lang})</option>
                  {/each}
                </optgroup>
              {/if}
            </select>
          </div>

          <div class="param-row">
            <span class="label">{t('structure.gesture_volume')}</span>
            <input
              type="range" min="0" max="1" step="0.05"
              value={config.tts_volume}
              oninput={(e) => update({ tts_volume: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <span class="range-val">{Math.round((config.tts_volume ?? 0.8) * 100)}%</span>
          </div>

          <div class="param-row">
            <span class="label">{t('structure.gesture_rate')}</span>
            <input
              type="range" min="0.5" max="2" step="0.1"
              value={config.tts_rate}
              oninput={(e) => update({ tts_rate: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <span class="range-val">{(config.tts_rate ?? 1.0).toFixed(1)}x</span>
          </div>
        {/if}
      </section>

      <!-- Section 3: Gesture Display -->
      <section>
        <h5>{t('structure.gesture_display')}</h5>

        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={config.show_webcam_pip}
            onchange={() => update({ show_webcam_pip: !config.show_webcam_pip })}
          />
          <span>{t('structure.gesture_webcam_pip')}</span>
        </label>

        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={config.show_skeleton}
            onchange={() => update({ show_skeleton: !config.show_skeleton })}
          />
          <span>{t('structure.gesture_skeleton_overlay')}</span>
        </label>

        <div class="param-row">
          <span class="label">{t('structure.gesture_neon_color')}</span>
          <input
            type="color"
            value={config.neon_color ?? `#00fff7`}
            oninput={(e) => update({ neon_color: (e.target as HTMLInputElement).value })}
          />
        </div>

        <div class="param-row">
          <span class="label">{t('structure.gesture_sensitivity')}</span>
          <input
            type="range" min="0.1" max="3" step="0.1"
            value={config.sensitivity}
            oninput={(e) => update({ sensitivity: parseFloat((e.target as HTMLInputElement).value) })}
          />
          <span class="range-val">{(config.sensitivity ?? 1.0).toFixed(1)}x</span>
        </div>
      </section>
    </div>
  </div>
{/if}

<style>
  .gesture-settings {
    position: fixed;
    top: max(40px, env(safe-area-inset-top, 0px) + 12px);
    right: max(8px, env(safe-area-inset-right, 0px) + 12px);
    z-index: 100000;
    width: 300px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 56px);
    overflow-y: auto;
    border: 1px solid rgba(0, 255, 247, 0.2);
    border-radius: 8px;
    background: rgba(13, 17, 23, 0.96);
    backdrop-filter: blur(16px);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5), 0 0 12px rgba(0, 255, 247, 0.08);
    font-family: var(--font-sans);
    color: var(--text-color, #ccc);
    pointer-events: auto;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 8px;
    border-bottom: 1px solid rgba(0, 255, 247, 0.1);
  }
  .panel-header h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: #00fff7;
    letter-spacing: 0.5px;
  }
  .close-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-size: 18px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }
  .close-btn:hover {
    color: #fff;
  }

  .panel-body {
    padding: 10px 12px 12px;
  }

  section {
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(0, 255, 247, 0.08);
  }
  section:last-child {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
  }

  h5 {
    margin: 0 0 6px;
    font-size: 10px;
    font-weight: 600;
    color: rgba(0, 255, 247, 0.65);
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .param-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
  }

  .label {
    min-width: 5.5em;
    font-size: 12px;
    color: var(--text-color, #ccc);
    flex-shrink: 0;
  }

  select,
  input[type="password"] {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    padding: 3px 6px;
    border-radius: 4px;
    border: 1px solid rgba(0, 255, 247, 0.15);
    background: rgba(0, 0, 0, 0.3);
    color: inherit;
  }
  select:focus,
  input[type="password"]:focus {
    border-color: rgba(0, 255, 247, 0.4);
    outline: none;
  }

  input[type="range"] {
    flex: 1;
    min-width: 0;
    accent-color: #00fff7;
  }

  input[type="color"] {
    width: 28px;
    height: 22px;
    padding: 1px;
    border: 1px solid rgba(0, 255, 247, 0.15);
    border-radius: 3px;
    background: transparent;
    cursor: pointer;
  }

  .range-val {
    min-width: 2.8em;
    text-align: right;
    font-size: 11px;
    opacity: 0.6;
    font-family: 'SF Mono', monospace;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    font-size: 12px;
    cursor: pointer;
  }
  .checkbox-row input[type="checkbox"] {
    accent-color: #00fff7;
  }

  .warning {
    margin: 2px 0 6px;
    padding: 4px 8px;
    font-size: 11px;
    color: #ffa500;
    background: rgba(255, 165, 0, 0.1);
    border-radius: 3px;
    border-left: 2px solid #ffa500;
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
  }

  .progress-bar {
    flex: 1;
    height: 6px;
    background: rgba(0, 255, 247, 0.1);
    border-radius: 3px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: #00fff7;
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .info-text {
    margin: 2px 0 6px;
    font-size: 11px;
    color: rgba(0, 255, 247, 0.6);
    font-style: italic;
  }
</style>

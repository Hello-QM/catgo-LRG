<script lang="ts">
  /**
   * Master gesture controller.
   *
   * Manages webcam, hand tracking, voice recognition, TTS, and AI routing.
   * Render this inside a viewer wrapper; it provides gesture data to children.
   */
  import { setContext, onMount } from 'svelte'
  import { HandTracker } from './hand-tracker'
  import { VoiceEngine, command_confirmation } from './voice-engine'
  import { WhisperVoiceEngine } from './whisper-voice-engine'
  import { LocalWhisperEngine } from './local-whisper'
  import type { ModelStatus } from './local-whisper'
  import { TTSEngine } from './tts-engine'
  import {
    LANDMARK,
    type HandState, type GestureEvent, type GestureAction, type VoiceEvent,
    type GestureConfig,
  } from './gesture-types'

  let {
    config,
    art_mode = false,
    ongesture,
    onvoice,
    onhand_update,
    on_ai_query,
    ondisable,
    children,
  }: {
    config: GestureConfig
    art_mode?: boolean
    ongesture?: (event: GestureEvent) => void
    onvoice?: (event: VoiceEvent) => void
    onhand_update?: (hands: HandState[]) => void
    on_ai_query?: (text: string) => Promise<string>
    // Ask the PARENT to disable gesture control. The parent owns `config`, so
    // the child must never mutate `config.enabled` directly — doing so is an
    // unbound-prop mutation that, combined with the enabled→active $effect,
    // triggers `effect_update_depth_exceeded` and freezes the whole app.
    ondisable?: () => void
    children?: import('svelte').Snippet
  } = $props()

  let tracker = $state<HandTracker | null>(null)
  let voice = $state<VoiceEngine | WhisperVoiceEngine | LocalWhisperEngine | null>(null)
  let tts = $state<TTSEngine | null>(null)
  let hands = $state<HandState[]>([])
  let last_voice = $state<VoiceEvent | null>(null)
  let active = $state(false)
  let error_msg = $state<string | null>(null)
  let voice_warning = $state<string | null>(null)
  let video_element = $state<HTMLVideoElement | null>(null)
  let ai_processing = $state(false)
  let model_download_status = $state<ModelStatus>(`idle`)
  let model_download_progress = $state(0)

  // Non-reactive ref for the in-flight HandTracker so stop() can reach it
  // even if start() hasn't finished setting the $state tracker yet.
  let _tracker_ref: HandTracker | null = null
  let _stop_requested = false

  // Track previous frame state for delta calculation
  let prev_centers: Map<string, { x: number; y: number }> = new Map()
  let prev_pinch: Map<string, number> = new Map()

  // ─── Smoothing Pipeline State ────────────────────────────────────
  let smoothed_delta: Map<string, { x: number; y: number }> = new Map()
  let smoothed_pinch: Map<string, number> = new Map()
  // Transition suppression: skip frames after gesture change to avoid artifacts
  let transition_cooldown: Map<string, number> = new Map()
  const TRANSITION_SUPPRESS_FRAMES = 5  // ~167ms at 30fps, generous settling window

  const DEAD_ZONE = { rotate_point: 0.002, rotate_palm: 0.003, pan: 0.003, zoom: 0.002 }
  const EMA_ALPHA = { rotate: 0.3, pan: 0.55, zoom: 0.3 }
  const ROTATION_SENSITIVITY = { point: 0.6, open_palm: 2.0 }
  // Velocity clamp: tanh soft-saturation limits (normalized coords per frame)
  const MAX_DELTA = { pan: 0.02, rotate: 0.04, zoom: 0.03 }
  // Outlier threshold: deltas above this are tracking glitches — skip the frame
  const OUTLIER_THRESHOLD = 0.08

  function apply_dead_zone_2d(
    delta: { x: number; y: number }, threshold: number,
  ): { x: number; y: number } {
    const mag = Math.sqrt(delta.x * delta.x + delta.y * delta.y)
    if (mag < threshold) return { x: 0, y: 0 }
    // Subtract threshold to remove jump on exit
    const scale = (mag - threshold) / mag
    return { x: delta.x * scale, y: delta.y * scale }
  }

  function apply_dead_zone_1d(value: number, threshold: number): number {
    const abs_val = Math.abs(value)
    if (abs_val < threshold) return 0
    return Math.sign(value) * (abs_val - threshold)
  }

  /** Soft velocity clamp via tanh — linear for small values, saturates at max. */
  function soft_clamp_2d(
    delta: { x: number; y: number }, max: number,
  ): { x: number; y: number } {
    const mag = Math.sqrt(delta.x * delta.x + delta.y * delta.y)
    if (mag < 1e-8) return { x: 0, y: 0 }
    const clamped_mag = max * Math.tanh(mag / max)
    return { x: delta.x * (clamped_mag / mag), y: delta.y * (clamped_mag / mag) }
  }

  function soft_clamp_1d(value: number, max: number): number {
    return max * Math.tanh(value / max)
    // tanh preserves sign, so this works for negative values too
  }

  // Provide state to children via context
  setContext(`gesture`, {
    get hands() { return hands },
    get active() { return active },
    get video_element() { return video_element },
    get last_voice() { return last_voice },
    get art_mode() { return art_mode },
    get config() { return config },
    get ai_processing() { return ai_processing },
    get tts() { return tts },
    get model_download_status() { return model_download_status },
    get model_download_progress() { return model_download_progress },
  })

  // ─── Helpers ────────────────────────────────────────────────────

  /** Try to get an OpenAI API key from chat config in localStorage. */
  function get_openai_key(): string | null {
    try {
      const raw = localStorage.getItem(`catgo-chat-config`)
      if (!raw) return null
      const cfg = JSON.parse(raw)
      // Only use the key if the provider is OpenAI-compatible
      if (cfg.api_key && [`openai`, `deepseek`, `kimi`, `qwen`].includes(cfg.provider)) {
        return cfg.api_key
      }
      return null
    } catch {
      return null
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  $effect(() => {
    if (config.enabled && !active) {
      start()
    } else if (!config.enabled) {
      // Always call stop() when disabled — even if active is false,
      // start() may be in-flight with an open webcam stream.
      stop()
    }
  })

  // Manage TTS lifecycle
  $effect(() => {
    if (config.tts_enabled && !tts) {
      tts = new TTSEngine({
        enabled: true,
        volume: config.tts_volume ?? 0.8,
        rate: config.tts_rate ?? 1.0,
        pitch: 1.0,
        language: config.voice_language,
      })
    } else if (!config.tts_enabled && tts) {
      tts.stop()
      tts = null
    } else if (tts) {
      tts.update_config({
        volume: config.tts_volume ?? 0.8,
        rate: config.tts_rate ?? 1.0,
        language: config.voice_language,
      })
    }
  })

  // Restart voice recognition when language changes
  $effect(() => {
    const lang = config.voice_language
    if (voice && voice.is_running) {
      voice.set_language(lang, config.voice_ai_enabled ?? false)
    }
  })

  // Apply TTS voice selection
  $effect(() => {
    const voice_name = config.tts_voice
    if (tts) {
      tts.set_voice_by_name(voice_name ?? ``)
    }
  })

  // Cleanup on unmount
  $effect(() => {
    return () => stop()
  })

  async function start(): Promise<void> {
    error_msg = null
    _stop_requested = false
    try {
      // Start hand tracking
      const t = new HandTracker()
      _tracker_ref = t  // Set before await so stop() can reach it
      await t.start(
        (detected_hands, timestamp) => {
          hands = detected_hands
          onhand_update?.(detected_hands)
          process_frame(detected_hands, timestamp)
        },
        (err_msg) => {
          // Detection loop error callback: fired when HandTracker hits MAX_ERRORS
          // consecutive detection failures. We must call stop() here to release
          // the webcam stream and all resources — otherwise the camera stays on.
          stop()
          error_msg = err_msg
        },
      )

      // If stop() was called while we were loading, tear down immediately
      if (_stop_requested) {
        t.stop()
        _tracker_ref = null
        return
      }

      tracker = t
      video_element = t.video_element

      // Start voice recognition (respects config.voice_method)
      if (config.voice_enabled) {
        const voice_cb = (event: VoiceEvent) => {
          last_voice = event
          onvoice?.(event)
          handle_voice_event(event)
        }
        const voice_err = (err: string) => {
          if (tts && err === `not-allowed`) {
            tts.speak(config.voice_language?.startsWith(`zh`)
              ? `麦克风权限被拒绝` : `Microphone access denied`, `high`)
          }
        }
        const lang = config.voice_language
        const ai = config.voice_ai_enabled ?? false
        const method = config.voice_method ?? `auto`

        const web_speech = new VoiceEngine()
        const use_whisper = method === `whisper`
          || (method === `auto` && !web_speech.is_supported)
        const noise_sup = config.noise_suppression ?? true

        if (!use_whisper && (method === `web_speech` || method === `auto`)) {
          if (web_speech.is_supported) {
            web_speech.start(voice_cb, lang, ai, voice_err)
            voice = web_speech
            console.info(`[GestureProvider] Voice started via Web Speech API (lang=${lang})`)
          } else {
            const zh = lang?.startsWith(`zh`)
            const msg = zh
              ? `语音不可用（需要 Chrome 或配置 Whisper Key）。手势控制正常工作。`
              : `Voice unavailable (needs Chrome or Whisper Key). Gesture control is working.`
            console.warn(`[GestureProvider] Web Speech API not supported, no Whisper key`)
            voice_warning = msg
          }
        } else {
          // Whisper mode: try local first based on whisper_mode config
          const whisper_mode = config.whisper_mode ?? `auto`
          const api_key = config.whisper_api_key || get_openai_key()
          let started = false

          // Try local Whisper (Transformers.js)
          if (whisper_mode === `local` || whisper_mode === `auto`) {
            try {
              const progress_cb = (status: ModelStatus, progress?: number) => {
                model_download_status = status
                if (typeof progress === `number`) model_download_progress = progress
              }
              const lw = new LocalWhisperEngine(progress_cb)
              if (lw.is_supported) {
                await lw.start(voice_cb, lang, ai, voice_err, noise_sup)
                voice = lw
                started = true
                const zh = lang?.startsWith(`zh`)
                if (tts) tts.speak(zh ? `语音已启动（本地模式）` : `Voice started (local mode)`, `low`)
                console.info(`[GestureProvider] Voice started via Local Whisper (lang=${lang})`)
              }
            } catch (err) {
              console.warn(`[GestureProvider] Local Whisper failed:`, err)
              model_download_status = `error`
              // Fall through to cloud if auto mode
            }
          }

          // Fall back to cloud Whisper
          if (!started && (whisper_mode === `cloud` || whisper_mode === `auto`)) {
            if (api_key) {
              const wv = new WhisperVoiceEngine(api_key)
              await wv.start(voice_cb, lang, ai, voice_err, noise_sup)
              voice = wv
              started = true
              const zh = lang?.startsWith(`zh`)
              if (tts) tts.speak(zh ? `语音已启动（云端模式）` : `Voice started (cloud mode)`, `low`)
              console.info(`[GestureProvider] Voice started via Whisper API (lang=${lang})`)
            }
          }

          if (!started) {
            const zh = lang?.startsWith(`zh`)
            const msg = whisper_mode === `cloud`
              ? (zh
                ? `需要 OpenAI API Key 才能使用语音。请在设置中配置。`
                : `OpenAI API key needed for voice. Configure in settings.`)
              : (zh
                ? `语音启动失败。请检查设置。手势控制正常工作。`
                : `Voice failed to start. Check settings. Gesture control is working.`)
            console.warn(`[GestureProvider] No voice engine started`)
            voice_warning = msg
          }
        }
      }

      active = true
    } catch (err) {
      // Clean up any partially-started resources (webcam, voice, etc.).
      // start() may fail partway through — e.g. camera opens successfully but
      // MediaPipe model fails to load, or voice engine throws. Without this
      // cleanup the webcam stream would leak and the camera light stays on.
      tracker?.stop()
      tracker = null
      _tracker_ref?.stop()
      _tracker_ref = null
      voice?.stop()
      voice = null
      video_element = null
      active = false
      // Extract useful message (script load errors are Event objects, not Error)
      const msg = err instanceof Error ? err.message
        : (err as any)?.target?.src ? `Failed to load: ${(err as any).target.src}`
        : String(err)
      const zh = config.voice_language?.startsWith(`zh`)
      error_msg = zh
        ? `手势启动失败：${msg}。请检查网络连接。`
        : `Failed to start gesture control: ${msg}`
      console.error(`[GestureProvider] start() failed:`, err)
    }
  }

  function stop(): void {
    _stop_requested = true
    // Stop via both reactive state and non-reactive ref to handle
    // the case where start() is still awaiting (tracker not yet set)
    tracker?.stop()
    tracker = null
    _tracker_ref?.stop()
    _tracker_ref = null
    voice?.stop()
    voice = null
    tts?.stop()
    tts = null
    video_element = null
    hands = []
    active = false
    ai_processing = false
    voice_warning = null
    prev_centers.clear()
    prev_pinch.clear()
    smoothed_delta.clear()
    smoothed_pinch.clear()
    transition_cooldown.clear()
  }

  // ─── Voice Event Handling ─────────────────────────────────────────

  function handle_voice_event(event: VoiceEvent): void {
    if (!event.is_final) return

    // TTS confirmation for recognized direct commands
    if (tts && event.action.type !== `ai_query` && event.action.type !== `unknown`) {
      const confirmation = command_confirmation(event.action, config.voice_language)
      if (confirmation) {
        tts.speak(confirmation, `low`)
      }
    }

    // Route AI queries to the chat system
    if (event.action.type === `ai_query` && on_ai_query) {
      handle_ai_query(event.action.raw)
    }
  }

  const AI_TIMEOUT_MS = 60_000

  async function handle_ai_query(text: string): Promise<void> {
    if (ai_processing) return  // Don't queue parallel AI requests

    ai_processing = true

    // Announce processing to user
    const zh = config.voice_language?.startsWith(`zh`)
    if (tts) {
      tts.speak(zh ? `正在思考...` : `Thinking...`, `low`)
    }

    try {
      const timeout_promise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`AI query timed out`)), AI_TIMEOUT_MS),
      )
      const response = await Promise.race([on_ai_query!(text), timeout_promise])
      if (response && tts) {
        tts.speak(response, `normal`)
      }
    } catch (err) {
      console.error(`[GestureProvider] AI query failed:`, err)
      if (tts) {
        const msg = (err as Error)?.message?.includes(`timed out`)
          ? (zh ? `请求超时，请重试` : `Request timed out, please try again.`)
          : (zh ? `抱歉，出错了` : `Sorry, there was an error.`)
        tts.speak(msg, `high`)
      }
    } finally {
      ai_processing = false
    }
  }

  // ─── Frame Processing ────────────────────────────────────────────

  function process_frame(detected: HandState[], timestamp: number): void {
    if (detected.length === 0) {
      prev_centers.clear()
      prev_pinch.clear()
      smoothed_delta.clear()
      smoothed_pinch.clear()
      transition_cooldown.clear()
      return
    }

    // Use the first (primary) hand for gestures
    const hand = detected[0]
    const hand_key = hand.side

    // For point gesture, track the index fingertip (more responsive to swipes).
    // For other gestures, use the palm center (more stable).
    const tip = hand.landmarks?.[LANDMARK.INDEX_TIP]
    const track_pos = hand.gesture === `point` && tip
      ? { x: tip.x, y: tip.y }
      : hand.center

    // ── Transition suppression ──────────────────────────────────
    // When switching gestures (e.g. fist→open_palm), the hand physically
    // reshapes over ~3 frames, shifting palm center and producing spurious
    // deltas. Suppress TRANSITION_SUPPRESS_FRAMES with per-frame re-anchoring
    // so the first active frame after transition has zero delta.
    // (Matches Apple Vision Pro's ~100ms "possible" state suppression.)
    if (hand.gesture !== hand.prev_gesture) {
      prev_centers.set(hand_key, { ...track_pos })
      prev_pinch.set(hand_key, hand.pinch_distance)
      smoothed_delta.set(hand_key, { x: 0, y: 0 })
      smoothed_pinch.set(hand_key, 0)
      transition_cooldown.set(hand_key, TRANSITION_SUPPRESS_FRAMES)
      return
    }

    // Suppress frames during cooldown (hand is physically settling into new pose)
    const cooldown = transition_cooldown.get(hand_key) ?? 0
    if (cooldown > 0) {
      transition_cooldown.set(hand_key, cooldown - 1)
      // Re-anchor each suppressed frame so first active frame has zero delta
      prev_centers.set(hand_key, { ...track_pos })
      prev_pinch.set(hand_key, hand.pinch_distance)
      smoothed_delta.set(hand_key, { x: 0, y: 0 })
      smoothed_pinch.set(hand_key, 0)
      return
    }

    // Confidence gate: suppress movement when gesture strength is low
    // (hand is transitioning — palm center shifts from shape change, not intent)
    const MIN_CONFIDENCE = 0.65
    if (hand.gesture_strength < MIN_CONFIDENCE && hand.gesture !== `none`) {
      prev_centers.set(hand_key, { ...track_pos })
      prev_pinch.set(hand_key, hand.pinch_distance)
      smoothed_delta.set(hand_key, { x: 0, y: 0 })
      smoothed_pinch.set(hand_key, 0)
      return
    }

    // 1. Compute raw deltas
    const sens = config.sensitivity ?? 1.0
    const prev_c = prev_centers.get(hand_key)
    let raw_delta = prev_c
      ? { x: (track_pos.x - prev_c.x) * sens, y: (track_pos.y - prev_c.y) * sens }
      : { x: 0, y: 0 }
    prev_centers.set(hand_key, { ...track_pos })

    const prev_p = prev_pinch.get(hand_key) ?? hand.pinch_distance
    let raw_pinch_delta = (hand.pinch_distance - prev_p) * sens
    prev_pinch.set(hand_key, hand.pinch_distance)

    // 2. Map gesture to action
    let action: GestureAction = `idle`

    if (art_mode) {
      // In art mode, pinch = place/draw, point = preview
      if (hand.gesture === `pinch`) action = `art_draw`
      else if (hand.gesture === `point`) action = `hover`
      else if (hand.gesture === `open_palm`) action = `rotate`
    } else {
      // Normal mode
      switch (hand.gesture) {
        case `open_palm`:
          action = `rotate`
          break
        case `pinch`:
          // Two-hand pinch = zoom, one-hand pinch = select click
          if (detected.length >= 2 && detected[1].gesture === `pinch`) {
            action = `zoom`
          } else if (hand.prev_gesture !== `pinch`) {
            // Just entered pinch = click
            action = `select`
          } else {
            action = `zoom`
          }
          break
        case `fist`:
          action = `pan`
          break
        case `point`:
          action = `idle`
          break
        case `thumbs_up`:
          action = `confirm`
          break
      }
    }

    // 3. Dead zone — suppress noise below perceptual threshold
    if (action === `rotate`) {
      const dz = hand.gesture === `point` ? DEAD_ZONE.rotate_point : DEAD_ZONE.rotate_palm
      raw_delta = apply_dead_zone_2d(raw_delta, dz)
    } else if (action === `pan`) {
      raw_delta = apply_dead_zone_2d(raw_delta, DEAD_ZONE.pan)
    }
    if (action === `zoom`) {
      raw_pinch_delta = apply_dead_zone_1d(raw_pinch_delta, DEAD_ZONE.zoom)
    }

    let final_delta: { x: number; y: number }
    let final_pinch: number

    if (action === `pan`) {
      // Pan = direct "grab and move" — raw deltas only, no smoothing/clamping.
      // EMA adds momentum, outlier rejection drops frames, tanh clamp caps speed.
      // None of that belongs in grab-and-move; the structure should follow the hand.
      final_delta = raw_delta
      final_pinch = raw_pinch_delta
      smoothed_delta.set(hand_key, raw_delta)
      smoothed_pinch.set(hand_key, raw_pinch_delta)
    } else {
      // 4. Differentiated sensitivity — point (finer) vs open_palm (broader)
      if (action === `rotate`) {
        const rot_sens = hand.gesture === `point`
          ? ROTATION_SENSITIVITY.point
          : ROTATION_SENSITIVITY.open_palm
        raw_delta = { x: raw_delta.x * rot_sens, y: raw_delta.y * rot_sens }
      }

      // 5. EMA smoothing — smooth out remaining frame-to-frame spikes
      const prev_sd = smoothed_delta.get(hand_key) ?? { x: 0, y: 0 }
      const prev_sp = smoothed_pinch.get(hand_key) ?? 0
      const alpha_xy = EMA_ALPHA.rotate
      const alpha_p = EMA_ALPHA.zoom

      final_delta = {
        x: alpha_xy * raw_delta.x + (1 - alpha_xy) * prev_sd.x,
        y: alpha_xy * raw_delta.y + (1 - alpha_xy) * prev_sd.y,
      }
      final_pinch = alpha_p * raw_pinch_delta + (1 - alpha_p) * prev_sp

      // 6. Outlier rejection — skip frames with impossibly large deltas
      const delta_mag = Math.sqrt(final_delta.x * final_delta.x + final_delta.y * final_delta.y)
      if (delta_mag > OUTLIER_THRESHOLD) {
        smoothed_delta.set(hand_key, { x: 0, y: 0 })
        smoothed_pinch.set(hand_key, 0)
        return
      }

      // 7. Soft velocity clamp via tanh — linear for small moves, saturates for fast ones
      final_delta = soft_clamp_2d(final_delta, MAX_DELTA.rotate)
      final_pinch = soft_clamp_1d(final_pinch, MAX_DELTA.zoom)

      smoothed_delta.set(hand_key, final_delta)
      smoothed_pinch.set(hand_key, final_pinch)
    }

    // Build screen position from normalized coords
    // (consumer must multiply by their canvas dimensions)
    const event: GestureEvent = {
      action,
      delta: final_delta,
      pinch_delta: final_pinch,
      screen_pos: { x: hand.center.x, y: hand.center.y },
      hands: detected,
      timestamp,
    }

    ongesture?.(event)
  }
</script>

{#if error_msg}
  <div class="gesture-error">
    <span>{error_msg}</span>
    <button onclick={() => { error_msg = null; start() }}>Retry</button>
    <!-- stop() explicitly releases the webcam stream before disabling,
         ensuring the camera light turns off even if start() failed partway.
         Disabling is delegated to the parent via ondisable() — the child must
         not mutate the unbound `config` prop (see ondisable doc above). -->
    <button onclick={() => { stop(); error_msg = null; ondisable?.() }}>Disable</button>
  </div>
{/if}

{#if voice_warning}
  <div class="gesture-warning">
    <span>{voice_warning}</span>
    <button onclick={() => { voice_warning = null }}>OK</button>
  </div>
{/if}

{@render children?.()}

<style>
  /* Positioned at top: 48px (not 8px) to sit below the Structure toolbar,
     which otherwise obscures the Retry/Disable buttons and makes them
     unclickable. */
  .gesture-error {
    position: absolute;
    top: 48px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: rgba(239, 68, 68, 0.9);
    color: white;
    border-radius: 6px;
    font-size: 12px;
    font-family: 'SF Mono', monospace;
    backdrop-filter: blur(8px);
  }
  .gesture-error button {
    padding: 2px 8px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 3px;
    background: transparent;
    color: white;
    font-size: 11px;
    cursor: pointer;
  }
  .gesture-error button:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  /* Same top: 48px offset as .gesture-error to clear the toolbar. */
  .gesture-warning {
    position: absolute;
    top: 48px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: rgba(180, 130, 20, 0.92);
    color: white;
    border-radius: 6px;
    font-size: 12px;
    font-family: 'SF Mono', monospace;
    backdrop-filter: blur(8px);
    max-width: 90%;
  }
  .gesture-warning button {
    padding: 2px 8px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 3px;
    background: transparent;
    color: white;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .gesture-warning button:hover {
    background: rgba(255, 255, 255, 0.15);
  }
</style>

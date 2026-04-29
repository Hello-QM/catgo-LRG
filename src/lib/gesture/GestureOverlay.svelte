<script lang="ts">
  /**
   * Cyberpunk gesture visualization overlay.
   *
   * Renders hand skeleton, gesture labels, voice feedback, and targeting
   * reticle on a transparent canvas over the viewer.
   */
  import { getContext, onMount } from 'svelte'
  import { HAND_CONNECTIONS, type HandState, type VoiceEvent, type GestureConfig } from './gesture-types'
  import type { TTSEngine } from './tts-engine'

  let {
    container_el,
  }: {
    container_el?: HTMLElement
  } = $props()

  const ctx = getContext<{
    hands: HandState[]
    active: boolean
    video_element: HTMLVideoElement | null
    last_voice: VoiceEvent | null
    art_mode: boolean
    config: GestureConfig
    ai_processing: boolean
    tts: TTSEngine | null
  }>(`gesture`)

  let canvas_el: HTMLCanvasElement | undefined = $state()
  let canvas_ctx: CanvasRenderingContext2D | null = $state(null)
  let pip_video_el: HTMLVideoElement | undefined = $state()
  let width = $state(800)
  let height = $state(600)
  let voice_fade = $state(0)
  let voice_text = $state(``)
  let voice_timer: ReturnType<typeof setTimeout> | undefined

  // Sync PiP video source
  $effect(() => {
    if (pip_video_el && ctx?.video_element?.srcObject) {
      pip_video_el.srcObject = ctx.video_element.srcObject
      pip_video_el.play().catch(() => {}) // Silent: autoplay may be blocked by browser policy
    }
  })

  // ─── Canvas Setup ─────────────────────────────────────────────

  onMount(() => {
    if (canvas_el) {
      canvas_ctx = canvas_el.getContext(`2d`)
    }
    // Track container size
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        width = entry.contentRect.width
        height = entry.contentRect.height
      }
    })
    if (container_el) ro.observe(container_el)
    return () => ro.disconnect()
  })

  // ─── Render Loop ──────────────────────────────────────────────

  $effect(() => {
    if (!canvas_ctx || !ctx?.active) return
    let raf: number
    const loop = () => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  })

  // ─── Voice Feedback ───────────────────────────────────────────

  $effect(() => {
    const v = ctx?.last_voice
    if (!v || !v.is_final) return
    voice_text = v.raw_text
    voice_fade = 1
    clearTimeout(voice_timer)
    voice_timer = setTimeout(() => { voice_fade = 0 }, 2500)
  })

  // ─── Drawing ──────────────────────────────────────────────────

  const NEON_COLORS: Record<string, string> = {
    left: `#00fff7`,   // cyan
    right: `#ff00ff`,  // magenta
  }

  const GESTURE_ICONS: Record<string, string> = {
    open_palm: ``,
    fist: ``,
    pinch: ``,
    point: ``,
    peace: ``,
    thumbs_up: ``,
    none: ``,
  }

  function draw(): void {
    const c = canvas_ctx!
    c.clearRect(0, 0, width, height)

    // Draw hand tracking visuals even when no hands detected
    // (AI/TTS indicators still need to render)

    if (ctx?.hands && ctx.hands.length > 0) {
      for (const hand of ctx.hands) {
        const color = ctx.config?.neon_color ?? NEON_COLORS[hand.side]
        const alt_color = hand.side === `left` ? `#00fff7` : `#ff00ff`

        if (ctx.config?.show_skeleton !== false) {
          draw_skeleton(c, hand, color)
        }
        draw_gesture_label(c, hand, alt_color)

        // Targeting reticle for point gesture
        if (hand.gesture === `point` || (ctx.art_mode && hand.gesture === `pinch`)) {
          draw_reticle(c, hand, color)
        }
      }
    }

    // AI processing indicator
    if (ctx?.ai_processing) {
      draw_ai_thinking(c)
    }

    // TTS speaking indicator
    if (ctx?.tts?.is_speaking) {
      draw_speaking_indicator(c)
    }

    // Voice command feedback
    if (voice_fade > 0) {
      draw_voice_hud(c)
    }

    // Scanline effect (subtle)
    draw_scanlines(c)
  }

  function draw_skeleton(c: CanvasRenderingContext2D, hand: HandState, color: string): void {
    const lm = hand.landmarks
    if (lm.length < 21) return

    // Glow effect
    c.shadowColor = color
    c.shadowBlur = 12

    // Draw connections
    c.strokeStyle = color
    c.lineWidth = 2
    c.globalAlpha = 0.8

    for (const [a, b] of HAND_CONNECTIONS) {
      const p1 = lm[a]
      const p2 = lm[b]
      c.beginPath()
      c.moveTo(p1.x * width, p1.y * height)
      c.lineTo(p2.x * width, p2.y * height)
      c.stroke()
    }

    // Draw landmark dots
    c.fillStyle = color
    for (let i = 0; i < lm.length; i++) {
      const p = lm[i]
      const r = i === 4 || i === 8 ? 5 : 3  // Thumb/index tips larger
      c.beginPath()
      c.arc(p.x * width, p.y * height, r, 0, Math.PI * 2)
      c.fill()
    }

    c.shadowBlur = 0
    c.globalAlpha = 1
  }

  function draw_gesture_label(c: CanvasRenderingContext2D, hand: HandState, color: string): void {
    if (hand.gesture === `none`) return

    const x = hand.center.x * width
    const y = hand.center.y * height - 40

    const icon = GESTURE_ICONS[hand.gesture] ?? ``
    const text = `${icon} ${hand.gesture.toUpperCase().replace(`_`, ` `)}`

    // Neon text
    c.shadowColor = color
    c.shadowBlur = 15
    c.font = `bold 11px 'SF Mono', 'Cascadia Code', monospace`
    c.textAlign = `center`
    c.fillStyle = color
    c.fillText(text, x, y)

    c.shadowBlur = 0
  }

  function draw_reticle(c: CanvasRenderingContext2D, hand: HandState, color: string): void {
    // Use fingertip position for point, palm center for pinch
    let x: number, y: number
    if (hand.gesture === `point` && hand.landmarks.length >= 9) {
      x = hand.landmarks[8].x * width   // Index fingertip
      y = hand.landmarks[8].y * height
    } else {
      x = hand.center.x * width
      y = hand.center.y * height
    }

    const t = performance.now() / 1000
    const pulse = 0.6 + 0.4 * Math.sin(t * 4)  // Pulsing animation

    c.shadowColor = color
    c.shadowBlur = 10
    c.strokeStyle = color
    c.lineWidth = 1.5
    c.globalAlpha = pulse

    // Outer ring
    c.beginPath()
    c.arc(x, y, 20, 0, Math.PI * 2)
    c.stroke()

    // Inner crosshair
    const sz = 8
    c.beginPath()
    c.moveTo(x - sz, y); c.lineTo(x + sz, y)
    c.moveTo(x, y - sz); c.lineTo(x, y + sz)
    c.stroke()

    // Corner brackets (rotating)
    const rot = t * 0.5
    c.save()
    c.translate(x, y)
    c.rotate(rot)
    for (let i = 0; i < 4; i++) {
      c.rotate(Math.PI / 2)
      c.beginPath()
      c.moveTo(14, 14)
      c.lineTo(14, 20)
      c.moveTo(14, 14)
      c.lineTo(20, 14)
      c.stroke()
    }
    c.restore()

    c.shadowBlur = 0
    c.globalAlpha = 1
  }

  function draw_voice_hud(c: CanvasRenderingContext2D): void {
    const x = width / 2
    const y = height - 50
    const alpha = voice_fade

    // Background pill
    c.globalAlpha = alpha * 0.8
    c.fillStyle = `rgba(0, 0, 0, 0.6)`
    const text_width = c.measureText(voice_text).width
    const pw = Math.max(text_width + 40, 120)
    c.beginPath()
    const r = 16
    c.roundRect(x - pw / 2, y - r, pw, r * 2, r)
    c.fill()

    // Voice icon + text
    c.globalAlpha = alpha
    const neon = ctx?.config?.neon_color ?? `#00fff7`
    c.shadowColor = neon
    c.shadowBlur = 10
    c.font = `bold 12px 'SF Mono', 'Cascadia Code', monospace`
    c.textAlign = `center`
    c.textBaseline = `middle`
    c.fillStyle = neon
    c.fillText(`  ${voice_text}`, x, y)

    c.shadowBlur = 0
    c.globalAlpha = 1
  }

  function draw_ai_thinking(c: CanvasRenderingContext2D): void {
    const x = width / 2
    const y = height - 90
    const t = performance.now() / 1000
    const dots = `.`.repeat(Math.floor(t % 4))

    // Background pill
    c.globalAlpha = 0.9
    c.fillStyle = `rgba(0, 0, 0, 0.7)`
    c.beginPath()
    c.roundRect(x - 85, y - 14, 170, 28, 14)
    c.fill()

    // Pulsing neon magenta text
    const pulse = 0.7 + 0.3 * Math.sin(t * 4)
    c.globalAlpha = pulse
    c.shadowColor = `#ff00ff`
    c.shadowBlur = 10
    c.font = `bold 11px 'SF Mono', 'Cascadia Code', monospace`
    c.textAlign = `center`
    c.textBaseline = `middle`
    c.fillStyle = `#ff00ff`
    c.fillText(`AI THINKING${dots}`, x, y)
    c.shadowBlur = 0
    c.globalAlpha = 1
  }

  function draw_speaking_indicator(c: CanvasRenderingContext2D): void {
    const x = 30
    const y = height - 30
    const t = performance.now() / 1000

    // Sound wave bars animation
    c.shadowColor = `#00ff88`
    c.shadowBlur = 4
    c.fillStyle = `#00ff88`
    for (let i = 0; i < 5; i++) {
      const bar_h = 4 + 8 * Math.abs(Math.sin(t * 5 + i * 0.8))
      c.globalAlpha = 0.8
      c.fillRect(x + i * 5, y - bar_h / 2, 3, bar_h)
    }

    // Label
    c.globalAlpha = 0.9
    c.font = `bold 9px 'SF Mono', 'Cascadia Code', monospace`
    c.textAlign = `left`
    c.textBaseline = `middle`
    c.fillText(`TTS`, x + 30, y)
    c.shadowBlur = 0
    c.globalAlpha = 1
  }

  function draw_scanlines(c: CanvasRenderingContext2D): void {
    c.globalAlpha = 0.03
    c.fillStyle = `#00fff7`
    for (let y = 0; y < height; y += 4) {
      c.fillRect(0, y, width, 1)
    }
    c.globalAlpha = 1
  }
</script>

<div class="gesture-overlay" style="width:{width}px;height:{height}px">
  <!-- Neon hand skeleton + HUD canvas -->
  <canvas
    bind:this={canvas_el}
    {width}
    {height}
    class="skeleton-canvas"
  ></canvas>

  <!-- Webcam PiP -->
  {#if ctx?.config?.show_webcam_pip && ctx?.video_element}
    <div class="webcam-pip">
      <video
        bind:this={pip_video_el}
        autoplay
        playsinline
        muted
        class="pip-video"
      ></video>
      <div class="pip-border"></div>
      <div class="pip-label">CAM</div>
    </div>
  {/if}

  <!-- Art mode indicator -->
  {#if ctx?.art_mode}
    <div class="art-mode-badge">
      <span class="art-pulse"></span>
      ART MODE
    </div>
  {/if}

  <!-- Status indicator -->
  {#if ctx?.active}
    <div class="status-indicator">
      <span class="status-dot"></span>
      GESTURE
    </div>
  {/if}
</div>

<style>
  .gesture-overlay {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    z-index: 9999;
    overflow: hidden;
  }

  .skeleton-canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }

  /* ─── Webcam PiP ─── */
  .webcam-pip {
    position: absolute;
    bottom: 12px;
    right: 12px;
    width: 140px;
    height: 105px;
    border-radius: 6px;
    overflow: hidden;
    opacity: 0.7;
    mix-blend-mode: screen;
    transition: opacity 0.2s;
  }
  .webcam-pip:hover {
    opacity: 1;
  }
  .pip-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scaleX(-1);  /* Mirror */
    filter: saturate(0.3) contrast(1.2) brightness(0.8);
  }
  .pip-border {
    position: absolute;
    inset: 0;
    border: 1px solid rgba(0, 255, 247, 0.4);
    border-radius: 6px;
    box-shadow:
      inset 0 0 15px rgba(0, 255, 247, 0.1),
      0 0 10px rgba(0, 255, 247, 0.15);
    pointer-events: none;
  }
  .pip-label {
    position: absolute;
    top: 4px;
    left: 6px;
    font-size: 8px;
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    color: rgba(0, 255, 247, 0.7);
    text-transform: uppercase;
    letter-spacing: 2px;
  }

  /* ─── Art Mode Badge ─── */
  .art-mode-badge {
    position: absolute;
    top: 12px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    background: rgba(255, 0, 255, 0.15);
    border: 1px solid rgba(255, 0, 255, 0.4);
    border-radius: 4px;
    font-size: 10px;
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    font-weight: 700;
    color: #ff00ff;
    text-shadow: 0 0 8px rgba(255, 0, 255, 0.6);
    letter-spacing: 2px;
  }
  .art-pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ff00ff;
    box-shadow: 0 0 6px #ff00ff;
    animation: pulse-neon 1.2s ease-in-out infinite;
  }

  /* ─── Status Indicator ─── */
  .status-indicator {
    position: absolute;
    top: 12px;
    left: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: rgba(0, 255, 247, 0.1);
    border: 1px solid rgba(0, 255, 247, 0.3);
    border-radius: 4px;
    font-size: 9px;
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    font-weight: 700;
    color: rgba(0, 255, 247, 0.8);
    letter-spacing: 2px;
  }
  .status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #00fff7;
    box-shadow: 0 0 4px #00fff7;
    animation: pulse-neon 1.5s ease-in-out infinite;
  }

  @keyframes pulse-neon {
    0%, 100% { opacity: 1; box-shadow: 0 0 4px currentColor; }
    50% { opacity: 0.4; box-shadow: 0 0 12px currentColor; }
  }
</style>

/**
 * MediaPipe HandLandmarker wrapper.
 *
 * Lazy-loads @mediapipe/tasks-vision, manages webcam stream,
 * and runs hand detection at ~30fps via requestAnimationFrame.
 */

import type { HandState, Landmark } from './gesture-types'
import { GestureRecognizer } from './gesture-recognizer'
import { LandmarkFilterBank } from './one-euro-filter'

export type HandTrackerCallback = (hands: HandState[], timestamp: number) => void

export class HandTracker {
  private video: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private landmarker: any = null  // HandLandmarker instance
  private raf_id = 0
  private running = false
  private callback: HandTrackerCallback | null = null
  private on_error: ((msg: string) => void) | null = null

  // Per-hand recognizers (support up to 2 hands)
  private recognizers = [new GestureRecognizer(), new GestureRecognizer()]
  private filter_banks = [new LandmarkFilterBank(), new LandmarkFilterBank()]
  private prev_gestures: HandState[`gesture`][] = [`none`, `none`]
  private prev_hand_count = 0

  /** Start webcam and hand detection. */
  async start(callback: HandTrackerCallback, on_error?: (msg: string) => void): Promise<void> {
    if (this.running) return
    this.callback = callback
    this.on_error = on_error ?? null

    // ── Pre-flight checks — run BEFORE `this.running = true` and BEFORE any
    //    getUserMedia call so a camera-less machine fails FAST instead of
    //    hanging. getUserMedia stalls when no device exists — on Chrome it
    //    blocks UI interaction, on Tauri's WebKitGTK the promise can hang —
    //    freezing the whole app so the user can't even click "Disable".

    // 1. The browser/webview must expose the camera API at all.
    //    Tauri's WKWebView on macOS may not provide navigator.mediaDevices.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        typeof window !== `undefined` && (window as any).__TAURI__
          ? `Webcam access isn't available in the desktop app. Open CatGO in Chrome or Edge instead.`
          : `Your browser does not support camera access. Please use Chrome, Edge, or Safari.`,
      )
    }

    // 2. Non-blocking probe: enumerateDevices() does NOT open the camera, so it
    //    returns quickly even with no device — unlike getUserMedia, which is
    //    the call that freezes the app on a camera-less machine. Bail here if
    //    there's no video input at all, so getUserMedia is never reached.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (!devices.some(d => d.kind === `videoinput`)) {
        throw new Error(`No camera found. Please connect a camera and try again.`)
      }
    } catch (e: any) {
      throw (e instanceof Error && e.message.startsWith(`No camera`))
        ? e
        : new Error(`No camera found. Please connect a camera and try again.`)
    }

    this.running = true

    // 2. Create hidden video element for webcam
    this.video = document.createElement(`video`)
    this.video.setAttribute(`playsinline`, ``)
    this.video.setAttribute(`autoplay`, ``)
    this.video.style.display = `none`
    document.body.appendChild(this.video)

    // 4. Request webcam access. Race against an 8s timeout so a present-but-
    //    stuck device (or a hung WebKitGTK getUserMedia) can't freeze start()
    //    forever. The timer runs on the event loop, so it fires even if the
    //    getUserMedia promise never settles.
    try {
      const gum = navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: `user` },
        audio: false,
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      this.stream = await Promise.race([
        gum,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Camera request timed out — no response from the device.`)), 8000)
        }),
      ])
      clearTimeout(timer)
      // If getUserMedia lost the race but resolves later, release that stream
      // so the camera light doesn't stay on.
      void gum.then(s => { if (this.stream !== s) s.getTracks().forEach(t => t.stop()) }).catch(() => {})
    } catch (e: any) {
      const msg = e?.name === `NotAllowedError` ? `Camera permission denied. Please allow camera access and try again.`
        : e?.name === `NotFoundError` ? `No camera found. Please connect a camera and try again.`
        : typeof e?.message === `string` && e.message.startsWith(`Camera request timed out`) ? e.message
        : `Camera access failed: ${e?.message ?? e?.name ?? e}`
      throw new Error(msg)
    }
    this.video.srcObject = this.stream

    // Wait for the video stream to produce its first frame.
    // Includes an error handler and 10s timeout to avoid hanging forever
    // if the stream stalls (e.g. WKWebView returning a dead stream).
    await new Promise<void>((resolve, reject) => {
      this.video!.onloadeddata = () => resolve()
      this.video!.onerror = (ev) => reject(new Error(`Video failed to load: ${(ev as any)?.message ?? `unknown error`}`))
      setTimeout(() => reject(new Error(`Camera timed out — video stream did not load`)), 10_000)
    })
    await this.video.play()

    // 3. Lazy-load MediaPipe HandLandmarker
    const vision = await import(`@mediapipe/tasks-vision`)
    const { HandLandmarker, FilesetResolver } = vision

    // WASM from jsDelivr CDN (works in China). Model prefers local (googleapis blocked by GFW).
    const WASM_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm`
    const MODEL_URLS = [
      `/models/hand_landmarker.task`,  // local (for China / offline)
      `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`,  // CDN
    ]

    console.info(`[HandTracker] Loading MediaPipe WASM from CDN...`)
    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN)

    // Try each model URL (local then CDN), with GPU→CPU fallback for each
    this.landmarker = await HandTracker.create_landmarker(HandLandmarker, fileset, MODEL_URLS)

    // 4. Start detection loop
    this.detect_loop()
  }

  /** Stop tracking and release resources. */
  stop(): void {
    this.running = false
    if (this.raf_id) cancelAnimationFrame(this.raf_id)
    this.raf_id = 0

    if (this.landmarker) {
      this.landmarker.close()
      this.landmarker = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop())
      this.stream = null
    }
    if (this.video) {
      this.video.remove()
      this.video = null
    }
    this.recognizers.forEach(r => r.reset())
    this.filter_banks.forEach(b => b.reset())
    this.prev_hand_count = 0
    this.prev_gestures = [`none`, `none`]
    this.callback = null
  }

  /** Get the raw video element (for PiP display). */
  get video_element(): HTMLVideoElement | null {
    return this.video
  }

  get is_running(): boolean {
    return this.running
  }

  /** Try model URLs in order, with GPU→CPU fallback for each. */
  private static async create_landmarker(
    HandLandmarker: any, fileset: any, model_urls: string[],
  ): Promise<any> {
    const base_opts: Record<string, any> = {
      runningMode: `VIDEO` as const,
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }

    for (const url of model_urls) {
      for (const delegate of [`GPU`, `CPU`]) {
        try {
          const opts = { ...base_opts, baseOptions: { modelAssetPath: url, delegate } }
          const lm = await HandLandmarker.createFromOptions(fileset, opts)
          console.info(`[HandTracker] Hand landmarker ready (${delegate}, model=${url.includes(`/models/`) ? `local` : `CDN`})`)
          return lm
        } catch (err) {
          console.warn(`[HandTracker] Failed (${delegate}, ${url}):`, (err as Error)?.message?.slice(0, 80) ?? err)
        }
      }
    }
    throw new Error(`All model sources failed. Check network connection.`)
  }

  private error_count = 0
  private static readonly MAX_ERRORS = 10

  private detect_loop(): void {
    if (!this.running || !this.video || !this.landmarker) return

    try {
      const now = performance.now()
      const results = this.landmarker.detectForVideo(this.video, now)

      const hands: HandState[] = []
      const detected_count = results.landmarks?.length ?? 0

      // Reset filter banks when hands disappear (count drops)
      if (detected_count < this.prev_hand_count) {
        for (let i = detected_count; i < this.filter_banks.length; i++) {
          this.filter_banks[i].reset()
        }
      }
      this.prev_hand_count = detected_count

      if (results.landmarks && detected_count > 0) {
        const t_seconds = now / 1000

        for (let i = 0; i < detected_count; i++) {
          const raw_landmarks: Landmark[] = results.landmarks[i].map((lm: any) => ({
            x: lm.x,
            y: lm.y,
            z: lm.z ?? 0,
          }))

          // Mirror x-axis (webcam is flipped)
          const mirrored = raw_landmarks.map(lm => ({
            ...lm,
            x: 1 - lm.x,
          }))

          // Apply One Euro Filter to smooth jittery landmarks
          const bank = this.filter_banks[i] ?? this.filter_banks[0]
          const filtered = bank.filter(mirrored, t_seconds)

          const recognizer = this.recognizers[i] ?? this.recognizers[0]
          const gesture = recognizer.classify(filtered)
          const gesture_strength = recognizer.current_strength
          const center = recognizer.palm_center(filtered)
          const pinch_distance = recognizer.pinch_distance(filtered)

          // Determine handedness
          const handedness = results.handednesses?.[i]?.[0]
          // MediaPipe reports handedness from the camera's perspective, so mirrored:
          // 'Left' from camera = user's right hand
          const side = handedness?.categoryName === `Left` ? `right` : `left`

          const prev_gesture = this.prev_gestures[i] ?? `none`
          this.prev_gestures[i] = gesture

          hands.push({
            side: side as HandState[`side`],
            gesture,
            prev_gesture,
            landmarks: filtered,
            center,
            pinch_distance,
            gesture_strength,
            confidence: handedness?.score ?? 0,
          })
        }
      }

      this.error_count = 0  // Reset on success
      this.callback?.(hands, now)
    } catch (err) {
      this.error_count++
      if (this.error_count <= 3) {
        console.error(`[HandTracker] Detection error (${this.error_count}):`, err)
      }
      if (this.error_count >= HandTracker.MAX_ERRORS) {
        console.error(`[HandTracker] Too many errors, stopping detection loop`)
        this.on_error?.(`Hand detection failed: ${(err as Error)?.message ?? err}`)
        this.running = false
        return
      }
    }

    this.raf_id = requestAnimationFrame(() => this.detect_loop())
  }
}

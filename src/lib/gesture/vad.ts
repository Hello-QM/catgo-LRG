/**
 * Silero VAD wrapper using @ricky0123/vad-web.
 *
 * Provides speech detection via a neural network model (ONNX) instead of
 * fragile RMS-threshold-based VAD. Delivers Float32Array audio segments
 * at 16kHz on speech end.
 */

export interface VadConfig {
  /** Called when a speech segment ends, with audio at 16kHz. */
  on_speech_end: (audio: Float32Array) => void
  /** Called when speech starts (optional). */
  on_speech_start?: () => void
  /** Positive speech threshold (0-1, default 0.5). Higher = stricter. */
  positive_speech_threshold?: number
  /** Negative speech threshold (0-1, default 0.35). */
  negative_speech_threshold?: number
  /** Min speech frames before triggering (default 6). */
  min_speech_frames?: number
  /** Pre-speech padding frames (default 1). */
  pre_speech_pad_frames?: number
  /** Optional pre-processed MediaStream (e.g. from noise suppression pipeline). */
  stream?: MediaStream
}

let vad_instance: any = null

export async function start_vad(config: VadConfig): Promise<void> {
  // Dynamic import to avoid SSR issues
  const { MicVAD } = await import(`@ricky0123/vad-web`)

  const vad_options: any = {
    // Load the VAD worklet + Silero ONNX model and the onnxruntime-web wasm from
    // CDNs pinned to the installed versions. The Vite build does not emit these
    // assets into the app, so the defaults ("./silero_vad_legacy.onnx", local
    // ort wasm) 404 — fatal on machines without WebGPU, which fall back to wasm.
    // Versions MUST match the installed @ricky0123/vad-web and onnxruntime-web.
    baseAssetPath: `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/`,
    onnxWASMBasePath:
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/`,
    positiveSpeechThreshold: config.positive_speech_threshold ?? 0.5,
    negativeSpeechThreshold: config.negative_speech_threshold ?? 0.35,
    minSpeechFrames: config.min_speech_frames ?? 6,
    preSpeechPadFrames: config.pre_speech_pad_frames ?? 1,
    onSpeechEnd: (audio: Float32Array) => {
      config.on_speech_end(audio)
    },
    onSpeechStart: () => {
      config.on_speech_start?.()
    },
  }

  // If a pre-processed stream is provided, pass it to MicVAD
  if (config.stream) {
    vad_options.stream = config.stream
  }

  vad_instance = await MicVAD.new(vad_options)
  vad_instance.start()
  console.info(`[VAD] Silero VAD started`)
}

export function stop_vad(): void {
  if (vad_instance) {
    vad_instance.pause()
    vad_instance.destroy()
    vad_instance = null
    console.info(`[VAD] Silero VAD stopped`)
  }
}

export function is_vad_running(): boolean {
  return vad_instance !== null
}

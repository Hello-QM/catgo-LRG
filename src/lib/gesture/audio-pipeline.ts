/**
 * Audio processing pipeline: Mic → Browser constraints → RNNoise AudioWorklet → Output.
 *
 * Creates a processed MediaStream with noise suppression that can be passed
 * to the VAD or any other consumer. Falls back gracefully if RNNoise fails.
 */

export interface AudioPipeline {
  /** Noise-suppressed output stream. */
  stream: MediaStream
  /** AudioContext used by the pipeline. */
  audio_ctx: AudioContext
  /** Tear down all resources. */
  destroy: () => void
}

export async function create_audio_pipeline(): Promise<AudioPipeline> {
  // Layer 1: Browser-level noise processing via getUserMedia constraints
  const raw_stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    },
  })

  const audio_ctx = new AudioContext({ sampleRate: 48000 })
  const source = audio_ctx.createMediaStreamSource(raw_stream)

  // Layer 2: Try RNNoise AudioWorklet for additional suppression
  let output_node: AudioNode = source
  let rnnoise_node: any = null

  try {
    const { RnnoiseWorkletNode, loadRnnoise } = await import(`@sapphi-red/web-noise-suppressor`)

    // Load WASM binary — specifiers must match the package.json "exports" map
    const wasm_url = new URL(
      `@sapphi-red/web-noise-suppressor/rnnoise.wasm`,
      import.meta.url,
    ).href
    const simd_url = new URL(
      `@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm`,
      import.meta.url,
    ).href

    const wasmBinary = await loadRnnoise({ url: wasm_url, simdUrl: simd_url })

    // Register the worklet processor
    const processor_url = new URL(
      `@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js`,
      import.meta.url,
    ).href
    await audio_ctx.audioWorklet.addModule(processor_url)

    rnnoise_node = new RnnoiseWorkletNode(audio_ctx, { maxChannels: 1, wasmBinary })
    source.connect(rnnoise_node)
    output_node = rnnoise_node
    console.info(`[AudioPipeline] RNNoise AudioWorklet loaded`)
  } catch (err) {
    console.warn(`[AudioPipeline] RNNoise unavailable, using browser-only noise suppression:`, err)
    // Fall back: source passes through directly
  }

  // Create output MediaStream from the processing chain
  const destination = audio_ctx.createMediaStreamDestination()
  output_node.connect(destination)

  const destroy = () => {
    // Destroy RNNoise node if loaded
    if (rnnoise_node?.destroy) rnnoise_node.destroy()
    // Stop all raw mic tracks
    raw_stream.getTracks().forEach(t => t.stop())
    // Close audio context
    audio_ctx.close().catch(() => {}) // Best-effort: AudioContext may already be closed
  }

  console.info(`[AudioPipeline] Pipeline ready: Mic → Browser NS${rnnoise_node ? ` → RNNoise` : ``} → Output`)

  return {
    stream: destination.stream,
    audio_ctx,
    destroy,
  }
}

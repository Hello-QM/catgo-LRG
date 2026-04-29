/**
 * Audio utility functions for voice processing.
 */

/** Encode Float32Array PCM samples as a WAV blob (Whisper API expects audio files). */
export function float32_to_wav(samples: Float32Array, sample_rate: number): Blob {
  const num_channels = 1
  const bits_per_sample = 16
  const byte_rate = sample_rate * num_channels * (bits_per_sample / 8)
  const block_align = num_channels * (bits_per_sample / 8)
  const data_size = samples.length * (bits_per_sample / 8)
  const buffer = new ArrayBuffer(44 + data_size)
  const view = new DataView(buffer)

  // RIFF header
  write_string(view, 0, `RIFF`)
  view.setUint32(4, 36 + data_size, true)
  write_string(view, 8, `WAVE`)

  // fmt chunk
  write_string(view, 12, `fmt `)
  view.setUint32(16, 16, true)              // chunk size
  view.setUint16(20, 1, true)               // PCM format
  view.setUint16(22, num_channels, true)
  view.setUint32(24, sample_rate, true)
  view.setUint32(28, byte_rate, true)
  view.setUint16(32, block_align, true)
  view.setUint16(34, bits_per_sample, true)

  // data chunk
  write_string(view, 36, `data`)
  view.setUint32(40, data_size, true)

  // Convert float32 to int16
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: `audio/wav` })
}

function write_string(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

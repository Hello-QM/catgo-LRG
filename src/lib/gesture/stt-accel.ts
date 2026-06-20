/**
 * Client for the optional STT GPU accelerator (whisper.cpp Vulkan/Metal).
 *
 * Wraps the backend /api/stt/accel/* endpoints: report status, download the
 * platform binary + GGML models on demand, and switch the active engine at
 * runtime. All calls degrade to a safe default (null / false) on error so the
 * voice menu never throws.
 */

import { API_BASE } from '$lib/api/config'

export type SttEngine = `faster-whisper` | `whispercpp`

export interface AccelDownload {
  active: boolean
  kind: string | null
  pct: number
  error: string | null
}

export interface AccelStatus {
  platform_key: string | null
  gpu_api: string | null
  gpu_name: string | null
  engine: SttEngine
  binary_installed: boolean
  models_installed: string[]
  download: AccelDownload
}

const _SIZE_ALIASES: Record<string, string> = {
  tiny: `tiny`, 'tiny.en': `tiny.en`, base: `base`, 'base.en': `base.en`,
  small: `small`, 'small.en': `small.en`, medium: `medium`, 'medium.en': `medium.en`,
  large: `large-v3`, 'large-v2': `large-v2`, 'large-v3': `large-v3`,
  'large-v3-turbo': `large-v3-turbo`, turbo: `large-v3-turbo`,
}

/** Mirror of the backend size resolver — maps a client model id
 *  ('onnx-community/whisper-small') to the size name the accelerator uses
 *  ('small'), so the UI can tell whether that GGML model is installed. */
export function resolve_stt_size(model_id: string): string {
  const name = (model_id || ``).split(`/`).pop()!.toLowerCase().replace(`whisper-`, ``)
  return _SIZE_ALIASES[name] ?? `base`
}

export async function accel_status(): Promise<AccelStatus | null> {
  try {
    const r = await fetch(`${API_BASE}/stt/accel/status`)
    if (!r.ok) return null
    return await r.json() as AccelStatus
  } catch {
    return null
  }
}

export async function accel_install(): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/stt/accel/install`, { method: `POST` })
    return r.ok
  } catch {
    return false
  }
}

export async function accel_download_model(size: string): Promise<boolean> {
  try {
    const r = await fetch(
      `${API_BASE}/stt/accel/model?size=${encodeURIComponent(size)}`,
      { method: `POST` },
    )
    return r.ok
  } catch {
    return false
  }
}

export async function accel_set_engine(engine: SttEngine): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/stt/accel/engine`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify({ engine }),
    })
    return r.ok
  } catch {
    return false
  }
}

/** Poll status, invoking `cb` each tick, until no download is active (or error).
 *  Resolves with the final status. */
export async function poll_accel_progress(
  cb: (s: AccelStatus) => void,
  interval = 800,
): Promise<AccelStatus | null> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const s = await accel_status()
    if (!s) return null
    cb(s)
    if (!s.download.active) return s
    await new Promise((r) => setTimeout(r, interval))
  }
}

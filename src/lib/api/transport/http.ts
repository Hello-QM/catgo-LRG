/**
 * HTTP transport (desktop / browser).
 *
 * Thin wrapper that delegates to the EXISTING Python-backend HTTP endpoints —
 * the same ones `hpc.ts` already uses. This is a minimal scaffold; it is NOT a
 * full reimplementation of `hpc.ts` (the real WebSocket-driven connect/OTP flow
 * still lives there). Its job is to satisfy the {@link HpcTransport} contract so
 * the selection in `index.ts` type-checks and the mobile path has a desktop
 * counterpart. Migrating the ~46 `hpc.ts` callers onto this is a later step.
 */

import { API_BASE } from '../config'
import type {
  HpcConnectConfig,
  HpcConnectResult,
  HpcExecResult,
  HpcTransport,
} from './index'

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(err.detail || `Request failed: ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

class HttpTransport implements HpcTransport {
  readonly kind = 'http' as const

  async connect(config: HpcConnectConfig): Promise<HpcConnectResult> {
    // Delegate to the existing ssh-config connect endpoint. The Python backend
    // owns the asyncssh session; the returned session_id is opaque to us.
    const res = await postJson<{
      type?: string
      session_id?: string
      message?: string
    }>(`/hpc/connect/ssh-config`, config)
    return {
      connected: Boolean(res.session_id),
      sessionId: res.session_id ?? ``,
      // The HTTP/WS connect path signals OTP via a separate `auth_challenge`
      // WS message handled in hpc.ts; this thin REST shim does not see it, so
      // the OTP fields below stay empty (the russh path owns real OTP wiring).
      needsOtp: res.type === `auth_challenge`,
      message: res.message ?? ``,
      pendingId: ``,
      prompts: [],
      instructions: ``,
    }
  }

  async submitOtp(_pendingId: string, _responses: string[]): Promise<HpcConnectResult> {
    // OTP on the HTTP path is driven over the existing WebSocket in hpc.ts
    // (`connectHPC(...).submit_otp`), not over REST. This shim does not own that
    // socket, so it cannot complete the round-trip here.
    throw new Error(
      `http transport: submitOtp is handled by hpc.ts's WebSocket flow, not this shim`,
    )
  }

  async exec(sessionId: string, cmd: string, timeoutMs?: number): Promise<HpcExecResult> {
    // Best-effort delegation to a generic remote-exec endpoint. Kept minimal:
    // never rejects on a remote failure — mirrors the never-throw contract.
    try {
      const res = await postJson<Partial<HpcExecResult>>(`/hpc/exec`, {
        session_id: sessionId,
        cmd,
        timeout_ms: timeoutMs,
      })
      return {
        stdout: res.stdout ?? ``,
        stderr: res.stderr ?? ``,
        code: typeof res.code === `number` ? res.code : -1,
      }
    } catch (err) {
      return { stdout: ``, stderr: String(err), code: -1 }
    }
  }

  // Interactive PTY is a mobile (russh) capability only. On desktop the existing
  // terminal is driven by the local-PTY / Python path, not this transport, so
  // these throw rather than pretend to stream.
  async ptyOpen(
    _sessionId: string,
    _cols: number,
    _rows: number,
    _onData: (bytes: Uint8Array) => void,
  ): Promise<string> {
    throw new Error(`http transport: interactive PTY is not supported (mobile russh only)`)
  }

  async ptyWrite(_sessionId: string, _channelId: string, _data: Uint8Array): Promise<void> {
    throw new Error(`http transport: interactive PTY is not supported (mobile russh only)`)
  }

  async ptyResize(
    _sessionId: string,
    _channelId: string,
    _cols: number,
    _rows: number,
  ): Promise<void> {
    throw new Error(`http transport: interactive PTY is not supported (mobile russh only)`)
  }

  async ptyClose(_sessionId: string, _channelId: string): Promise<void> {
    // No-op: nothing to tear down on the HTTP path.
  }
}

export const httpTransport: HpcTransport = new HttpTransport()

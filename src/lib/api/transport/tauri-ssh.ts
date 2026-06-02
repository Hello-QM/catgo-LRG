/**
 * Tauri-SSH transport (mobile: iOS / Android).
 *
 * Drives the Rust `ssh` module (src-tauri/src/ssh) via Tauri `invoke`. On
 * mobile there is no Python sidecar, so russh owns the SSH connection and these
 * commands are the only path to the cluster.
 *
 * Commands (registered in src-tauri/src/lib.rs on BOTH desktop and mobile):
 *   * `ssh_connect`    -> { connected, session_id, needs_otp, pending_id, prompts, instructions, message }
 *   * `ssh_exec`       -> { stdout, stderr, code }
 *   * `ssh_submit_otp` -> same shape as ssh_connect (multi-round 2FA: respond, may return more prompts)
 */

import type {
  HpcConnectConfig,
  HpcConnectResult,
  HpcExecResult,
  HpcTransport,
  OtpPrompt,
} from './index'

/** Lazily import the Tauri core so this module is importable in a browser
 * (where the selection in index.ts will pick `http` anyway). */
async function invokeTauri<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import(`@tauri-apps/api/core`)
  return invoke<T>(cmd, args)
}

/** Shape returned by the Rust `ssh_connect` / `ssh_submit_otp` commands. The
 * OTP fields are `#[serde(skip_serializing_if = ...)]` on the Rust side, so they
 * are absent (not `null`) on the non-OTP paths — hence optional here. */
interface RustConnectResult {
  connected: boolean
  session_id: string
  needs_otp: boolean
  message: string
  pending_id?: string
  prompts?: OtpPrompt[]
  instructions?: string
}

/** Shape returned by the Rust `ssh_exec` command. */
interface RustExecResult {
  stdout: string
  stderr: string
  code: number
}

/** Map the frontend connect config onto the Rust `ConnectConfig` (serde
 * `#[serde(flatten)]` of the `method`-tagged `AuthConfig`). */
function toRustConnectConfig(config: HpcConnectConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port ?? 22,
    username: config.username,
    // Rust AuthConfig is an internally-tagged enum on `method` with lowercase
    // variant names: "password" | "publickey" | "keyboard-interactive".
    method: config.method,
    password: config.password,
    key_path: config.keyPath,
    passphrase: config.passphrase,
  }
}

function fromRustConnectResult(r: RustConnectResult): HpcConnectResult {
  return {
    connected: r.connected,
    sessionId: r.session_id,
    needsOtp: r.needs_otp,
    message: r.message,
    pendingId: r.pending_id ?? ``,
    prompts: r.prompts ?? [],
    instructions: r.instructions ?? ``,
  }
}

class TauriSshTransport implements HpcTransport {
  readonly kind = 'tauri-ssh' as const

  async connect(config: HpcConnectConfig): Promise<HpcConnectResult> {
    const r = await invokeTauri<RustConnectResult>(`ssh_connect`, {
      config: toRustConnectConfig(config),
    })
    return fromRustConnectResult(r)
  }

  async submitOtp(pendingId: string, responses: string[]): Promise<HpcConnectResult> {
    // The Rust `ssh_submit_otp(submission: OtpSubmission, ...)` command takes a
    // single `submission` arg (serde-renamed `pending_id`). A `Success` reply
    // yields a live `sessionId`; an `InfoRequest` reply yields `needsOtp: true`
    // plus a fresh `pendingId`/`prompts` for the next multi-round 2FA step.
    const r = await invokeTauri<RustConnectResult>(`ssh_submit_otp`, {
      submission: { pending_id: pendingId, responses },
    })
    return fromRustConnectResult(r)
  }

  async exec(sessionId: string, cmd: string, timeoutMs?: number): Promise<HpcExecResult> {
    const r = await invokeTauri<RustExecResult>(`ssh_exec`, {
      sessionId,
      cmd,
      timeoutMs: timeoutMs ?? null,
    })
    return { stdout: r.stdout, stderr: r.stderr, code: r.code }
  }
}

export const tauriSshTransport: HpcTransport = new TauriSshTransport()

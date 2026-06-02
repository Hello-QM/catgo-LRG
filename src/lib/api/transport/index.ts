/**
 * HPC transport abstraction.
 *
 * Two interchangeable backends for reaching an HPC cluster:
 *
 *   1. `http`      — desktop / browser: the EXISTING behavior, where the
 *                    Python backend (server/catgo/...) owns the asyncssh
 *                    connection and the frontend talks to it over HTTP/WS.
 *   2. `tauri-ssh` — mobile (iOS/Android): there is no Python sidecar, so the
 *                    Rust `ssh` module (src-tauri/src/ssh) owns the russh
 *                    connection and the frontend drives it via Tauri `invoke`.
 *
 * `transport` is selected once at module load by {@link isMobile}. This is a
 * SCAFFOLD: it provides the interface, both impls, and the selection. The ~46
 * existing `hpc.ts` callers are NOT migrated here yet — that is a later step.
 */

/** Authentication method for an SSH/HPC connection. */
export type HpcAuthMethod = 'password' | 'publickey' | 'keyboard-interactive'

/** Parameters for opening an HPC connection. */
export interface HpcConnectConfig {
  host: string
  port?: number
  username: string
  method: HpcAuthMethod
  /** Required when `method === 'password'`. */
  password?: string
  /** Path to the private key file when `method === 'publickey'`. */
  keyPath?: string
  /** Optional passphrase decrypting an encrypted private key. */
  passphrase?: string
}

/** A single keyboard-interactive / OTP prompt surfaced by the server. */
export interface OtpPrompt {
  /** Prompt text to render (e.g. "One-time password: "). */
  prompt: string
  /** Whether the typed answer should be echoed. `false` => mask as a secret
   * (OTP / password). */
  echo: boolean
}

/** Result of a connect attempt. */
export interface HpcConnectResult {
  connected: boolean
  /** Opaque session id used by subsequent `exec`/`submitOtp` calls. */
  sessionId: string
  /** True when the server requires a keyboard-interactive / OTP round-trip;
   * drive {@link HpcTransport.submitOtp} with `pendingId` + answers to
   * `prompts`. */
  needsOtp: boolean
  /** Human-readable status / error message (empty on success). */
  message: string
  /** In-flight handshake id to pass to `submitOtp` (set only when `needsOtp`).
   * Empty otherwise. */
  pendingId: string
  /** Prompts the user must answer this round (set only when `needsOtp`). */
  prompts: OtpPrompt[]
  /** Server-supplied instructions for this round (may be empty). */
  instructions: string
}

/** Result of a remote command. */
export interface HpcExecResult {
  stdout: string
  stderr: string
  /** Process exit code, or -1 on any transport/timeout error. */
  code: number
}

/**
 * A pluggable HPC transport. Both the HTTP (desktop) and Tauri-SSH (mobile)
 * backends implement this exact surface so callers are backend-agnostic.
 */
export interface HpcTransport {
  /** Human-readable transport id (`'http'` | `'tauri-ssh'`) for diagnostics. */
  readonly kind: 'http' | 'tauri-ssh'

  /** Open + authenticate an HPC connection. */
  connect(config: HpcConnectConfig): Promise<HpcConnectResult>

  /**
   * Submit one round of keyboard-interactive / OTP responses for a connection
   * that returned `needsOtp: true`.
   */
  submitOtp(pendingId: string, responses: string[]): Promise<HpcConnectResult>

  /** Run a command on an established session. Never rejects on a *remote*
   * failure — surfaces `{ code: -1, stderr }` instead. */
  exec(sessionId: string, cmd: string, timeoutMs?: number): Promise<HpcExecResult>

  /**
   * Open an interactive PTY + shell on an established session and stream its
   * output bytes to `onData` (UTF-8-agnostic — pass straight to xterm.js).
   *
   * Resolves to an opaque `channelId` for {@link ptyWrite}/{@link ptyResize}/
   * {@link ptyClose}. Mobile (tauri-ssh) only; the HTTP shim throws.
   */
  ptyOpen(
    sessionId: string,
    cols: number,
    rows: number,
    onData: (bytes: Uint8Array) => void,
  ): Promise<string>

  /** Write stdin bytes to an open PTY channel. */
  ptyWrite(sessionId: string, channelId: string, data: Uint8Array): Promise<void>

  /** Inform the remote of a terminal resize. */
  ptyResize(sessionId: string, channelId: string, cols: number, rows: number): Promise<void>

  /** Tear down an open PTY channel (idempotent). */
  ptyClose(sessionId: string, channelId: string): Promise<void>
}

/**
 * Detect whether we are running on a mobile Tauri target (iOS / Android).
 *
 * NOTE: the spike suggested `@tauri-apps/api`'s `platform()`, but this project's
 * `@tauri-apps/api` v2 does NOT export `platform()` (it lives in the separate,
 * not-installed `@tauri-apps/plugin-os`). To avoid adding a dependency and to
 * keep `tsc` clean, we detect mobile from the userAgent, which Tauri's mobile
 * webviews populate with the platform string. Swap this for `plugin-os`'s
 * `platform()` once that plugin is added (a later step).
 */
export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent)
}

import { httpTransport } from './http'
import { tauriSshTransport } from './tauri-ssh'

/**
 * The active transport, selected at module load: Tauri-SSH on mobile, HTTP
 * everywhere else.
 */
export const transport: HpcTransport = isMobile() ? tauriSshTransport : httpTransport

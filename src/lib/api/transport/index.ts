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
export type HpcAuthMethod = `password` | `publickey` | `keyboard-interactive`

/** Parameters for opening an HPC connection. */
export interface HpcHostConfig {
  host: string
  port?: number
  username: string
  method: HpcAuthMethod
  /** Required when `method === 'password'`. */
  password?: string
  /** Path to the private key file when `method === 'publickey'`. */
  keyPath?: string
  /** In-memory private key text when the platform cannot expose a stable path. */
  keyContent?: string
  /** Optional passphrase decrypting an encrypted private key. */
  passphrase?: string
}

export interface HpcConnectConfig extends HpcHostConfig {
  /** Optional jump host (ProxyJump / bastion) to tunnel through. When set, the
   * jump host is authenticated first (any method, incl. its own OTP), then a
   * `direct-tcpip` tunnel carries the target handshake. Omit => direct connect.
   * Mobile (tauri-ssh) only — the HTTP transport ignores it. */
  jump?: HpcHostConfig
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

/** A single remote filesystem entry surfaced by the SFTP file browser. */
export interface SftpEntry {
  /** Base name (no directory component). */
  name: string
  /** Full remote path (POSIX `/`-joined). */
  path: string
  /** Whether the entry is a directory. */
  isDir: boolean
  /** File size in bytes (0 when the server omits it). */
  size: number
}

/** A freshly-generated SSH keypair (OpenSSH wire forms). */
export interface GeneratedKeyPair {
  /** `ssh-ed25519 AAAA... comment` — installed into `authorized_keys`. */
  publicOpenssh: string
  /** OpenSSH PEM private key (unencrypted on the wire; the device wraps it at
   * rest via {@link HpcTransport.keyStore}). */
  privateOpenssh: string
}

/** Result of reading a (possibly truncated) remote text file. */
export interface SftpReadResult {
  /** UTF-8 (lossy) decoded contents, capped at `maxBytes` when provided. */
  content: string
  /** True when the file was longer than `maxBytes` and got cut off. */
  truncated: boolean
}

/**
 * A pluggable HPC transport. Both the HTTP (desktop) and Tauri-SSH (mobile)
 * backends implement this exact surface so callers are backend-agnostic.
 */
export interface HpcTransport {
  /** Human-readable transport id (`'http'` | `'tauri-ssh'`) for diagnostics. */
  readonly kind: `http` | `tauri-ssh`

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

  /**
   * List the entries of a remote directory. Mobile (tauri-ssh) only; the HTTP
   * shim throws.
   */
  sftpList(sessionId: string, path: string): Promise<SftpEntry[]>

  /** Stat a single remote path. */
  sftpStat(sessionId: string, path: string): Promise<SftpEntry>

  /**
   * Read a remote file as UTF-8 (lossy) text, optionally capped at `maxBytes`
   * (returns `{ content, truncated }`).
   */
  sftpRead(sessionId: string, path: string, maxBytes?: number): Promise<SftpReadResult>

  /** Read a remote file as raw bytes (binary downloads / non-text files). */
  sftpReadBytes(sessionId: string, path: string): Promise<Uint8Array>

  /** Write (create/truncate) a remote text file. */
  sftpWrite(sessionId: string, path: string, content: string): Promise<void>

  /** Create a remote directory. */
  sftpMkdir(sessionId: string, path: string): Promise<void>

  /** Remove a remote file. */
  sftpRemove(sessionId: string, path: string): Promise<void>

  /** Rename / move a remote path. */
  sftpRename(sessionId: string, from: string, to: string): Promise<void>

  // ─── SSH-key passwordless login (mobile / tauri-ssh only; HTTP shim throws) ───

  /**
   * Generate a fresh ed25519 SSH keypair ON THE DEVICE. Ptyless. Returns both
   * halves in OpenSSH wire form; the caller installs the public half via
   * {@link installPubkey} and persists the private half via {@link keyStore}.
   */
  keygen(): Promise<GeneratedKeyPair>

  /**
   * Idempotently append `publicOpenssh` to the cluster's
   * `~/.ssh/authorized_keys` over the live session (creates `~/.ssh` 700,
   * `authorized_keys` 600; skips a duplicate line). Rejects if the remote
   * command fails.
   */
  installPubkey(sessionId: string, publicOpenssh: string): Promise<void>

  /**
   * Persist a private key wrapped at rest under the app data dir, keyed by an
   * opaque `endpointKey` (e.g. `host:port:username`). On Android the wrapping
   * key is intended to be Keystore-held (hardware-backed); the current build
   * uses a software AES-256-GCM envelope (see deploy/android/README.md).
   */
  keyStore(endpointKey: string, privateOpenssh: string): Promise<void>

  /** Load + unwrap a previously-stored private key, or `null` if none stored. */
  keyLoad(endpointKey: string): Promise<string | null>
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
  if (typeof navigator === `undefined`) return false
  const ua = navigator.userAgent
  if (/android|iphone|ipod/i.test(ua)) return true
  // iPadOS 13+ defaults its WKWebView to "desktop-class browsing", so the UA
  // reports `Macintosh` with no `iPad` token. A real Mac has maxTouchPoints 0;
  // an iPad reports 5 — that touch signal is what disambiguates the two.
  if (/ipad/i.test(ua)) return true
  return /macintosh/i.test(ua) && navigator.maxTouchPoints > 1
}

import { httpTransport } from './http'
import { tauriSshTransport } from './tauri-ssh'

/**
 * The active transport, selected at module load: Tauri-SSH on mobile, HTTP
 * everywhere else.
 */
export const transport: HpcTransport = isMobile() ? tauriSshTransport : httpTransport

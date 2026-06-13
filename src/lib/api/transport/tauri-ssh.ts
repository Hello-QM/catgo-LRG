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
  GeneratedKeyPair,
  HpcConnectConfig,
  HpcConnectResult,
  HpcExecResult,
  HpcTransport,
  OtpPrompt,
  SftpEntry,
  SftpReadResult,
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

/** Shape of a Rust `SftpEntry` (serde keeps `is_dir` snake_case). */
interface RustSftpEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
}

function fromRustSftpEntry(e: RustSftpEntry): SftpEntry {
  return { name: e.name, path: e.path, isDir: e.is_dir, size: e.size }
}

/** Map one host's fields (host/port/user + flattened `method`-tagged auth) onto
 * the Rust serde shape. Shared by the top-level target and the nested jump host. */
function toRustHost(h: {
  host: string
  port?: number
  username: string
  method: HpcConnectConfig[`method`]
  password?: string
  keyPath?: string
  keyContent?: string
  passphrase?: string
}): Record<string, unknown> {
  return {
    host: h.host,
    port: h.port ?? 22,
    username: h.username,
    // Rust AuthConfig is an internally-tagged enum on `method` with lowercase
    // variant names: "password" | "publickey" | "keyboard-interactive".
    method: h.method,
    password: h.password,
    key_path: h.keyPath,
    key_content: h.keyContent,
    passphrase: h.passphrase,
  }
}

/** Map the frontend connect config onto the Rust `ConnectConfig` (serde
 * `#[serde(flatten)]` of the `method`-tagged `AuthConfig`, plus optional
 * `jump` for ProxyJump). */
function toRustConnectConfig(config: HpcConnectConfig): Record<string, unknown> {
  return {
    ...toRustHost(config),
    // `jump` => Rust `Option<JumpConfig>`; omitted/undefined => direct connect.
    jump: config.jump ? toRustHost(config.jump) : undefined,
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

  async ptyOpen(
    sessionId: string,
    cols: number,
    rows: number,
    onData: (bytes: Uint8Array) => void,
  ): Promise<string> {
    // The Rust `ssh_pty_open` takes `on_output: tauri::ipc::Channel<Vec<u8>>`.
    // A `Channel<Vec<u8>>` is serialized over IPC as a JSON array of integers,
    // so each message arrives JS-side as `number[]` — normalize to `Uint8Array`
    // before handing it to xterm.
    const { Channel, invoke } = await import(`@tauri-apps/api/core`)
    const ch = new Channel<number[] | Uint8Array | ArrayBuffer>()
    ch.onmessage = (msg) => {
      if (msg instanceof Uint8Array) onData(msg)
      else if (msg instanceof ArrayBuffer) onData(new Uint8Array(msg))
      else onData(Uint8Array.from(msg))
    }
    return invoke<string>(`ssh_pty_open`, {
      sessionId,
      cols,
      rows,
      onOutput: ch,
    })
  }

  async ptyWrite(sessionId: string, channelId: string, data: Uint8Array): Promise<void> {
    // Rust `data: Vec<u8>` deserializes from a JSON number array.
    await invokeTauri<void>(`ssh_pty_write`, {
      sessionId,
      channelId,
      data: Array.from(data),
    })
  }

  async ptyResize(
    sessionId: string,
    channelId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    await invokeTauri<void>(`ssh_pty_resize`, { sessionId, channelId, cols, rows })
  }

  async ptyClose(sessionId: string, channelId: string): Promise<void> {
    await invokeTauri<void>(`ssh_pty_close`, { sessionId, channelId })
  }

  async sftpList(sessionId: string, path: string): Promise<SftpEntry[]> {
    const entries = await invokeTauri<RustSftpEntry[]>(`sftp_list`, { sessionId, path })
    return entries.map(fromRustSftpEntry)
  }

  async sftpStat(sessionId: string, path: string): Promise<SftpEntry> {
    const e = await invokeTauri<RustSftpEntry>(`sftp_stat`, { sessionId, path })
    return fromRustSftpEntry(e)
  }

  async sftpRead(sessionId: string, path: string, maxBytes?: number): Promise<SftpReadResult> {
    // Rust `max_bytes: Option<usize>` deserializes from a JSON number or null.
    return invokeTauri<SftpReadResult>(`sftp_read`, {
      sessionId,
      path,
      maxBytes: maxBytes ?? null,
    })
  }

  async sftpReadBytes(sessionId: string, path: string): Promise<Uint8Array> {
    // Rust returns `Vec<u8>`, serialized over IPC as a JSON number array.
    const bytes = await invokeTauri<number[]>(`sftp_read_bytes`, { sessionId, path })
    return Uint8Array.from(bytes)
  }

  async sftpWrite(sessionId: string, path: string, content: string): Promise<void> {
    await invokeTauri<void>(`sftp_write`, { sessionId, path, content })
  }

  async sftpMkdir(sessionId: string, path: string): Promise<void> {
    await invokeTauri<void>(`sftp_mkdir`, { sessionId, path })
  }

  async sftpRemove(sessionId: string, path: string): Promise<void> {
    await invokeTauri<void>(`sftp_remove`, { sessionId, path })
  }

  async sftpRename(sessionId: string, from: string, to: string): Promise<void> {
    await invokeTauri<void>(`sftp_rename`, { sessionId, from, to })
  }

  async keygen(): Promise<GeneratedKeyPair> {
    // Rust `ssh_keygen` -> { public_openssh, private_openssh } (snake_case).
    const r = await invokeTauri<{ public_openssh: string; private_openssh: string }>(
      `ssh_keygen`,
      {},
    )
    return { publicOpenssh: r.public_openssh, privateOpenssh: r.private_openssh }
  }

  async installPubkey(sessionId: string, publicOpenssh: string): Promise<void> {
    // Rust `ssh_install_pubkey` returns an ExecResult (never-throw); a non-zero
    // exit code means the remote install failed — surface it as a rejection so
    // the UI can show the error.
    const r = await invokeTauri<RustExecResult>(`ssh_install_pubkey`, {
      sessionId,
      publicOpenssh,
    })
    if (r.code !== 0) {
      throw new Error(r.stderr || `Public key install failed (code ${r.code})`)
    }
  }

  async keyStore(endpointKey: string, privateOpenssh: string): Promise<void> {
    await invokeTauri<void>(`ssh_key_store`, { endpointKey, privateOpenssh })
  }

  async keyLoad(endpointKey: string): Promise<string | null> {
    return invokeTauri<string | null>(`ssh_key_load`, { endpointKey })
  }
}

export const tauriSshTransport: HpcTransport = new TauriSshTransport()

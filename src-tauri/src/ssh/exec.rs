//! Remote command execution over an established SSH session.
//!
//! Ports the semantics of `server/catgo/utils/scheduler_base.py::_run`:
//!   * the command is wrapped in a LOGIN shell — `bash -l -c '<quoted cmd>'` —
//!     so module-managed tools (sbatch/squeue/...) are on PATH;
//!   * a default ~30s timeout applies;
//!   * it NEVER throws on a remote/transport error — on any failure it returns
//!     `code = -1` plus the error text in `stderr` (matching the Python layer's
//!     `check=False` + caller-tolerant contract).
//!
//! Channel I/O follows the spike: open a session channel, `exec(true, cmd)`,
//! then drain `ChannelMsg` until the channel closes, collecting `Data` (stdout),
//! `ExtendedData { ext == 1 }` (stderr), and `ExitStatus` (the u32 exit code).

use serde::Serialize;

use russh::ChannelMsg;

use super::state::SshState;

/// Default command timeout, mirroring the Python scheduler's `timeout=30`.
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// `SSH_EXTENDED_DATA_STDERR` — the `ext` discriminator for stderr bytes.
const SSH_EXTENDED_DATA_STDERR: u32 = 1;

/// Result of a remote command.
#[derive(Debug, Clone, Serialize)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    /// Process exit code, or `-1` on any transport/timeout/internal error
    /// (matching the Python never-throw contract).
    pub code: i32,
}

impl ExecResult {
    /// Build an error result (`code = -1`) with the given stderr message.
    fn error(msg: impl Into<String>) -> Self {
        Self {
            stdout: String::new(),
            stderr: msg.into(),
            code: -1,
        }
    }
}

/// POSIX single-quote shell escaping, equivalent to Python's `shlex.quote`.
///
/// Wraps the string in single quotes and renders embedded single quotes as the
/// classic `'\''` sequence. Empty string becomes `''`.
fn shlex_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    // Fast path: if every char is a safe unquoted shell token char, return as-is
    // (matches shlex.quote, which leaves such strings unquoted).
    let safe = s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '%' | '_' | '-' | '+' | '=' | ':' | ',' | '.' | '/'));
    if safe {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Execute `cmd` on an established session and collect its output.
///
/// `timeout_ms` overrides the default ~30s timeout. Never throws across the
/// Tauri boundary: every failure path yields `ExecResult { code: -1, stderr }`.
#[tauri::command]
pub async fn ssh_exec(
    session_id: String,
    cmd: String,
    timeout_ms: Option<u64>,
    state: tauri::State<'_, SshState>,
) -> Result<ExecResult, String> {
    let session = match state.get(&session_id).await {
        Some(s) => s,
        None => {
            return Ok(ExecResult::error(format!(
                "No such SSH session: {session_id}"
            )));
        }
    };
    if !session.is_alive() {
        return Ok(ExecResult::error(format!(
            "SSH session {session_id} is no longer alive"
        )));
    }

    // bash -l -c '<shlex-quoted cmd>'  (login shell, like the Python layer).
    let login_cmd = format!("bash -l -c {}", shlex_quote(&cmd));
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

    // Drive the whole exchange under a single timeout. Errors map to code = -1.
    let fut = run_exec(&session, login_cmd);
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(msg)) => {
            session.mark_dead();
            Ok(ExecResult::error(msg))
        }
        Err(_elapsed) => Ok(ExecResult::error(format!(
            "SSH command timed out ({}ms): {}",
            timeout.as_millis(),
            cmd.chars().take(80).collect::<String>()
        ))),
    }
}

/// Open a channel, exec the (already-wrapped) command, and drain output.
///
/// Returns `Err(message)` on any transport error; the caller turns that into a
/// `code = -1` result.
async fn run_exec(
    session: &super::state::SshSession,
    login_cmd: String,
) -> Result<ExecResult, String> {
    // `Channel::wait()` is `&mut self`, so we must hold the handle's async mutex
    // for the duration of the exec stream.
    let handle = session.handle.lock().await;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("channel_open_session failed: {e}"))?;

    channel
        .exec(true, login_cmd.into_bytes())
        .await
        .map_err(|e| format!("exec failed: {e}"))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut code: Option<i32> = None;

    // `wait()` needs `&mut`; the channel is owned locally so that's fine.
    let mut channel = channel;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext } if ext == SSH_EXTENDED_DATA_STDERR => {
                stderr.extend_from_slice(&data)
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status as i32),
            // Killed-by-signal: surface the signal name in stderr, mark nonzero.
            ChannelMsg::ExitSignal {
                signal_name,
                error_message,
                ..
            } => {
                stderr.extend_from_slice(
                    format!("[signal {signal_name:?}] {error_message}\n").as_bytes(),
                );
                if code.is_none() {
                    code = Some(-1);
                }
            }
            // Channel teardown — loop naturally ends after these.
            ChannelMsg::Eof | ChannelMsg::Close => {}
            _ => {}
        }
    }

    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        // Default to 0 if the server closed cleanly without an explicit status.
        code: code.unwrap_or(0),
    })
}

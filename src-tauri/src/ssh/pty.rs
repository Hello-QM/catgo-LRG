//! Native interactive PTY terminal over an established SSH session (mobile).
//!
//! This is SEPARATE from the desktop local-PTY at `src-tauri/src/pty.rs`: that
//! one spawns a local shell via `portable-pty`; this one drives a remote shell
//! over the existing russh connection so a phone with no Python sidecar gets a
//! real interactive terminal.
//!
//! Byte flow:
//!   * stdout/stderr from the remote shell are streamed to xterm.js via a typed
//!     Tauri `Channel<Vec<u8>>` (NOT a WebSocket). A spawned tokio task drives
//!     `ChannelReadHalf::wait()` and forwards every `Data`/`ExtendedData` chunk
//!     into the channel with `onOutput.send(bytes)`.
//!   * stdin / resize / close are plain `invoke()` commands that act on the
//!     `ChannelWriteHalf` stored per-session.
//!
//! Concurrency (validated against vendored russh 0.54.5):
//!   `Channel::wait()` is `&mut self` while `data()/window_change()/close()` are
//!   `&self`. `Channel::split()` (`channels/mod.rs:445`) yields a `ChannelReadHalf`
//!   (owns `wait`) and a `ChannelWriteHalf<Msg>` (owns the `&self` writers). The
//!   read half is MOVED into the spawned reader task; the write half is stored
//!   in the `SshSession` behind an `Arc` (no mutex needed — all methods `&self`).
//!   This cleanly avoids the `&mut`/`&self` conflict without an mpsc funnel.
//!
//! Never panics across the Tauri boundary: every command returns
//! `Result<_, String>` and maps transport errors to `Err(message)`.

use tauri::ipc::Channel;

use russh::ChannelMsg;

use super::state::{PtyHandle, SshState};

/// `SSH_EXTENDED_DATA_STDERR` — the `ext` discriminator for stderr bytes. The
/// terminal merges stderr into the same xterm stream (a PTY conflates them).
const SSH_EXTENDED_DATA_STDERR: u32 = 1;

/// Open an interactive PTY + shell on an established session and start streaming
/// its output into `on_output`.
///
/// Returns an opaque `channel_id` to pass to `ssh_pty_write/resize/close`.
#[tauri::command]
pub async fn ssh_pty_open(
    session_id: String,
    cols: u16,
    rows: u16,
    on_output: Channel<Vec<u8>>,
    state: tauri::State<'_, SshState>,
) -> Result<String, String> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| format!("No such SSH session: {session_id}"))?;
    if !session.is_alive() {
        return Err(format!("SSH session {session_id} is no longer alive"));
    }

    // Open the channel under the auth-handle lock (channel_open_session is the
    // only call that touches the handle; we drop the guard right after).
    let channel = {
        let handle = session.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| format!("channel_open_session failed: {e}"))?
    };

    // Request a PTY then a shell. `want_reply: false` for the PTY (we don't wait
    // on the per-request ack — matches the task spec); `true` for the shell so a
    // failure surfaces synchronously here rather than as a silent dead channel.
    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| format!("request_pty failed: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("request_shell failed: {e}"))?;

    // Split into independent owners: read half -> reader task, write half -> map.
    let (mut read_half, write_half) = channel.split();

    // Spawn the byte pump. It owns `read_half` (`&mut self` wait) and the cloned
    // Tauri channel. It runs until the remote closes (Eof/Close), `wait()`
    // returns None, or the task is aborted by `ssh_pty_close`.
    let reader = tokio::spawn(async move {
        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    if on_output.send(data.to_vec()).is_err() {
                        break; // frontend channel gone — stop pumping.
                    }
                }
                ChannelMsg::ExtendedData { data, ext } if ext == SSH_EXTENDED_DATA_STDERR => {
                    if on_output.send(data.to_vec()).is_err() {
                        break;
                    }
                }
                // Remote finished / channel torn down: stop the pump.
                ChannelMsg::Eof | ChannelMsg::Close => break,
                // ExitStatus/ExitSignal/WindowAdjusted/etc: nothing to forward
                // for a raw terminal byte stream.
                _ => {}
            }
        }
    });

    let pty = PtyHandle {
        write: std::sync::Arc::new(write_half),
        reader: reader.abort_handle(),
    };
    let channel_id = session.insert_pty(pty).await;
    Ok(channel_id)
}

/// Write stdin bytes to an open PTY channel.
#[tauri::command]
pub async fn ssh_pty_write(
    session_id: String,
    channel_id: String,
    data: Vec<u8>,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| format!("No such SSH session: {session_id}"))?;
    let write = session
        .get_pty_write(&channel_id)
        .await
        .ok_or_else(|| format!("No such PTY channel: {channel_id}"))?;
    // `data(R: AsyncRead + Unpin)` — a `&[u8]` implements that bound.
    write
        .data(&data[..])
        .await
        .map_err(|e| format!("pty write failed: {e}"))
}

/// Inform the remote of a terminal resize.
#[tauri::command]
pub async fn ssh_pty_resize(
    session_id: String,
    channel_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| format!("No such SSH session: {session_id}"))?;
    let write = session
        .get_pty_write(&channel_id)
        .await
        .ok_or_else(|| format!("No such PTY channel: {channel_id}"))?;
    write
        .window_change(cols as u32, rows as u32, 0, 0)
        .await
        .map_err(|e| format!("pty resize failed: {e}"))
}

/// Close an open PTY channel: send eof+close, abort the reader task (no leak),
/// and drop it from the session map.
#[tauri::command]
pub async fn ssh_pty_close(
    session_id: String,
    channel_id: String,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| format!("No such SSH session: {session_id}"))?;
    // Remove first so a concurrent write/resize can't resurrect a half-closed
    // channel; we own the `PtyHandle` (and its reader AbortHandle) from here.
    let pty = match session.remove_pty(&channel_id).await {
        Some(p) => p,
        // Already gone — idempotent close is not an error.
        None => return Ok(()),
    };

    // Best-effort polite teardown; ignore errors (the channel may already be
    // dead). Both are `&self` on the shared write half.
    let _ = pty.write.eof().await;
    let _ = pty.write.close().await;

    // Stop the byte pump so the spawned task does not leak. The reader holds the
    // only `ChannelReadHalf`; aborting it drops that and lets russh reclaim the
    // channel even if the remote never sends Eof/Close.
    pty.reader.abort();
    Ok(())
}

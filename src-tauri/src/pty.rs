//! PTY session manager for CatGo terminal integration.
//!
//! Uses portable-pty to spawn local shell processes with pseudo-terminals.
//! Communication with the frontend is done via Tauri IPC:
//! - Frontend → Rust: invoke commands (pty_spawn, pty_write, pty_resize, pty_kill)
//! - Rust → Frontend: events (pty-output, pty-exit)

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Check if an executable exists on PATH (used for shell detection on Windows).
fn which_exists(name: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("where")
            .arg(name)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = name;
        false
    }
}

/// Counter for generating unique session IDs.
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Payload emitted to the frontend when PTY produces output.
#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    id: u32,
    data: String, // base64-encoded raw terminal bytes
}

/// Payload emitted to the frontend when PTY process exits.
#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: u32,
    success: bool,
}

/// A single PTY session with its master writer and child process.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

/// Shared state holding all active PTY sessions.
pub struct PtyState {
    sessions: Mutex<HashMap<u32, PtySession>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl PtyState {
    /// Kill all active sessions (called on app shutdown).
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (id, mut session) in sessions.drain() {
                log::info!("[PTY] Killing session {id} on shutdown");
                let _ = session.child.kill();
            }
        }
    }
}

/// Spawn a new PTY shell process.
///
/// Returns the session ID which the frontend uses for all subsequent operations.
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<u32, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    // Guard against zero dimensions — ConPTY on Windows may not produce output with 0x0
    let cols = if cols == 0 { 80 } else { cols };
    let rows = if rows == 0 { 24 } else { rows };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    // Detect user's shell with platform-specific defaults
    let mut cmd = if cfg!(target_os = "windows") {
        // On Windows, $SHELL is typically unset.  Try PowerShell first, then cmd.
        let shell = std::env::var("SHELL").ok();
        match shell.as_deref() {
            Some(s) if s.contains("bash") => {
                // Git Bash: must use --login so /etc/profile sets PATH
                // (otherwise /usr/bin tools like ls, basename are missing)
                let mut c = CommandBuilder::new(s);
                c.arg("--login");
                c
            }
            Some(s) => CommandBuilder::new(s),
            None => {
                // Prefer PowerShell (widely available on modern Windows)
                if which_exists("powershell.exe") {
                    let mut c = CommandBuilder::new("powershell.exe");
                    c.arg("-NoLogo");
                    c
                } else {
                    // Fallback to cmd.exe via COMSPEC
                    let comspec = std::env::var("COMSPEC")
                        .unwrap_or_else(|_| "cmd.exe".into());
                    CommandBuilder::new(&comspec)
                }
            }
        }
    } else {
        // Unix: use $SHELL or /bin/bash, with --login for proper profile sourcing
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut c = CommandBuilder::new(&shell);
        c.arg("--login");
        c
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    // Get reader (cloneable) and writer from master
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // Store session
    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            id,
            PtySession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    // Spawn a dedicated reader thread that pushes output to the frontend via events.
    // This is more efficient than polling from the frontend.
    let app_handle = app.clone();
    std::thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .spawn(move || {
            let engine = base64::engine::general_purpose::STANDARD;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let encoded = engine.encode(&buf[..n]);
                        let _ = app_handle.emit(
                            "pty-output",
                            PtyOutputPayload {
                                id,
                                data: encoded,
                            },
                        );
                    }
                    Err(e) => {
                        log::debug!("[PTY {id}] Reader error: {e}");
                        break;
                    }
                }
            }
            // Notify frontend that the PTY has exited
            let _ = app_handle.emit("pty-exit", PtyExitPayload { id, success: true });
            log::info!("[PTY {id}] Reader thread exited");
        })
        .map_err(|e| format!("Failed to spawn reader thread: {e}"))?;

    log::info!("[PTY {id}] Session spawned ({cols}x{rows})");
    Ok(id)
}

/// Write data to a PTY session (keystrokes from the frontend).
#[tauri::command]
pub async fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("PTY session {id} not found"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write failed: {e}"))?;
    Ok(())
}

/// Resize a PTY session (when the terminal UI changes size).
#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("PTY session {id} not found"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {e}"))?;
    Ok(())
}

/// Kill a PTY session and clean up resources.
#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
        log::info!("[PTY {id}] Session killed");
        Ok(())
    } else {
        Err(format!("PTY session {id} not found"))
    }
}

//! Tauri-managed SSH session registry.
//!
//! Holds every live russh client connection keyed by an opaque `session_id`
//! (a v4 UUID minted at connect time). The whole thing is shared across Tauri
//! commands via `app.manage(SshState::default())`.
//!
//! Concurrency model (from the russh API spike):
//!   * `russh::client::Handle<H>` is BOTH `Send` AND `Sync` (verified in the
//!     spike via `assert_send`/`assert_sync`), so it can live inside Tauri's
//!     `State` without extra wrapping for *sharing*.
//!   * BUT the auth methods and `Channel::wait()` are `&mut self`, so any code
//!     that drives auth or reads an exec stream needs exclusive ownership. We
//!     therefore wrap the `Handle` in a `tokio::sync::Mutex` (async mutex —
//!     the guard is held across `.await`).
//!   * The outer `sessions` map is itself behind a `tokio::sync::Mutex` so the
//!     command layer can insert/lookup/remove sessions from async contexts.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use super::handler::MobileHandler;

/// The concrete russh client handle type used throughout the SSH module.
///
/// Aliased so the (verbose) generic `Handle<MobileHandler>` is written once.
pub type SshHandle = russh::client::Handle<MobileHandler>;

/// The concrete write-half type for an interactive PTY channel.
///
/// `russh::ChannelWriteHalf<S>` where `S = russh::client::Msg`. All of its I/O
/// methods (`data` / `window_change` / `eof` / `close`) take `&self`, so it can
/// be shared behind an `Arc` and driven from the `ssh_pty_write/resize/close`
/// commands WITHOUT a mutex — the `&mut self` half (`wait()`) lives entirely in
/// the spawned reader task (see `pty.rs`).
pub type PtyWriteHalf = russh::ChannelWriteHalf<russh::client::Msg>;

/// A live interactive PTY channel attached to a session.
///
/// Holds the write half (for `ssh_pty_write` / `ssh_pty_resize` / `ssh_pty_close`)
/// plus the `AbortHandle` of the spawned reader task so `ssh_pty_close` can stop
/// the byte pump WITHOUT leaking the task (it does not end on its own until the
/// remote closes the channel).
pub struct PtyHandle {
    /// The russh channel write half (shared; `&self` methods, no lock needed).
    pub write: Arc<PtyWriteHalf>,
    /// Abort handle for the reader task forwarding bytes into the Tauri channel.
    pub reader: AbortHandle,
}

/// A partially-authenticated (in-flight) keyboard-interactive / OTP handshake.
///
/// The russh keyboard-interactive `respond` call is `&mut self` on the SAME
/// `Handle` that `start` was called on, and the handshake can span MULTIPLE
/// Tauri command calls (one `InfoRequest` round per `ssh_submit_otp`). So the
/// mid-auth `Handle` itself must survive between commands — it is MOVED into
/// this struct (never cloned) and moved back out by `take_pending` so the next
/// round can drive it with `&mut`.
pub struct PendingAuth {
    /// The mid-auth russh handle (MOVED in/out — not shared, not cloned).
    pub handle: SshHandle,
    /// Remote host, carried so the live `SshSession` can be built once authed.
    pub host: String,
    /// Authenticated username, carried for the same reason.
    pub username: String,
}

impl PendingAuth {
    /// Construct a pending (mid-auth) handshake holder.
    pub fn new(handle: SshHandle, host: String, username: String) -> Self {
        Self { handle, host, username }
    }
}

/// A single live SSH connection plus the metadata the frontend needs to render
/// session state.
///
/// `host`/`username`/`connected_at` are populated now and consumed by the
/// session-listing command in a later step (not yet wired), so they are allowed
/// to be currently-unread.
#[allow(dead_code)]
pub struct SshSession {
    /// The russh client handle. Wrapped in an async `Mutex` because auth and
    /// `Channel::wait()` are `&mut self` (see module docs).
    pub handle: Mutex<SshHandle>,
    /// Remote host this session is connected to (for display / logging).
    pub host: String,
    /// Authenticated username (for display / `bash -l` context).
    pub username: String,
    /// Unix-epoch milliseconds when the session was established.
    pub connected_at: i64,
    /// Liveness flag. Set to `false` when a disconnect/error is observed so the
    /// command layer can prune dead sessions without racing the handle.
    pub alive: std::sync::atomic::AtomicBool,
    /// Interactive PTY channels owned by this session, keyed by an opaque
    /// `channel_id` (a v4 UUID minted by `ssh_pty_open`). Behind an async
    /// `Mutex` so the `ssh_pty_*` commands can insert/lookup/remove from async
    /// contexts. Distinct from `handle`: a PTY's write half is independent of
    /// the auth handle's lock, so opening/using a PTY never blocks `ssh_exec`.
    pub ptys: Mutex<HashMap<String, PtyHandle>>,
}

impl SshSession {
    /// Construct a new session wrapper around a freshly-authenticated handle.
    pub fn new(handle: SshHandle, host: String, username: String) -> Self {
        Self {
            handle: Mutex::new(handle),
            host,
            username,
            connected_at: chrono::Utc::now().timestamp_millis(),
            alive: std::sync::atomic::AtomicBool::new(true),
            ptys: Mutex::new(HashMap::new()),
        }
    }

    /// Register a freshly-opened PTY channel and return its opaque id.
    pub async fn insert_pty(&self, pty: PtyHandle) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.ptys.lock().await.insert(id.clone(), pty);
        id
    }

    /// Look up a PTY's write half by channel id, cloning the `Arc` so the outer
    /// map lock is released before any network I/O.
    pub async fn get_pty_write(&self, channel_id: &str) -> Option<Arc<PtyWriteHalf>> {
        self.ptys.lock().await.get(channel_id).map(|p| p.write.clone())
    }

    /// Remove (and return) a PTY channel by id, if present. The caller is
    /// responsible for aborting the returned reader task and tearing down the
    /// channel.
    pub async fn remove_pty(&self, channel_id: &str) -> Option<PtyHandle> {
        self.ptys.lock().await.remove(channel_id)
    }

    /// Whether the session is still believed to be alive.
    pub fn is_alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Mark the session as dead (called on observed disconnect/error).
    pub fn mark_dead(&self) {
        self.alive
            .store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Tauri-managed registry of all live SSH sessions.
///
/// Registered with `app.manage(SshState::default())` and accessed from commands
/// via `tauri::State<'_, SshState>`.
#[derive(Default)]
pub struct SshState {
    /// session_id (UUID v4) -> session. `Arc` so a command can clone the handle
    /// reference out of the map and drop the outer map lock before doing slow
    /// network I/O on the inner per-session `Mutex`.
    pub sessions: Mutex<HashMap<String, Arc<SshSession>>>,
    /// pending_id (UUID v4) -> in-flight keyboard-interactive handshake.
    ///
    /// Separate from `sessions` because these handles are NOT yet authenticated
    /// and are MOVED out (not `Arc`-shared) when the next OTP round drives them
    /// with `&mut self`. Populated by `ssh_connect` on the first `InfoRequest`
    /// round and drained by `ssh_submit_otp`.
    pub pending: Mutex<HashMap<String, PendingAuth>>,
}

impl SshState {
    /// Look up a session by id, cloning the `Arc` so the caller can release the
    /// outer map lock immediately.
    pub async fn get(&self, session_id: &str) -> Option<Arc<SshSession>> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    /// Insert a session under a freshly-generated id and return that id.
    pub async fn insert(&self, session: Arc<SshSession>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().await.insert(id.clone(), session);
        id
    }

    /// Remove (and return) a session by id, if present.
    ///
    /// Used by the disconnect command (a later step); kept here so the registry
    /// API is complete.
    #[allow(dead_code)]
    pub async fn remove(&self, session_id: &str) -> Option<Arc<SshSession>> {
        self.sessions.lock().await.remove(session_id)
    }

    /// Stash an in-flight keyboard-interactive handshake under a freshly-minted
    /// `pending_id` and return that id. The `PendingAuth` (and the `Handle` it
    /// owns) is MOVED into the map — it is not shared.
    pub async fn insert_pending(&self, pending: PendingAuth) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.pending.lock().await.insert(id.clone(), pending);
        id
    }

    /// Remove (and return ownership of) a pending handshake by id, if present.
    ///
    /// The `Handle` is MOVED out so the caller can drive its `&mut self`
    /// `respond` method. A consumed `pending_id` is gone — a re-stash for the
    /// next round mints a NEW id.
    pub async fn take_pending(&self, pending_id: &str) -> Option<PendingAuth> {
        self.pending.lock().await.remove(pending_id)
    }
}

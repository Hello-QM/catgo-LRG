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

use super::handler::MobileHandler;

/// The concrete russh client handle type used throughout the SSH module.
///
/// Aliased so the (verbose) generic `Handle<MobileHandler>` is written once.
pub type SshHandle = russh::client::Handle<MobileHandler>;

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
        }
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
}

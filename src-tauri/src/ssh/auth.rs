//! SSH connect + authentication command.
//!
//! Implements the `ssh_connect` Tauri command: open a TCP+SSH session via
//! `russh::client::connect`, verify the server key through the TOFU
//! [`MobileHandler`], then authenticate with PASSWORD or PUBLIC-KEY.
//!
//! KEYBOARD-INTERACTIVE / OTP (2FA) needs a frontend round-trip — the server
//! emits one or more `InfoRequest` prompt rounds and the user has to type the
//! codes — so it CANNOT complete inside a single `ssh_connect` call. We detect
//! it and return `needs_otp = true`; the actual prompt/response loop is a
//! clearly-marked TODO in [`super::otp`].

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use russh::client::{self, AuthResult};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};

use super::handler::MobileHandler;
use super::state::{SshSession, SshState};

/// Authentication method selector sent from the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase", tag = "method")]
pub enum AuthConfig {
    /// Username + password.
    Password { password: String },
    /// Public key loaded from a file path on disk. `passphrase` decrypts an
    /// encrypted private key (`None`/empty => unencrypted).
    Publickey {
        key_path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
    /// Keyboard-interactive (OTP / 2FA). Needs the frontend round-trip — see
    /// `super::otp`. We still accept it here so the frontend can signal intent.
    KeyboardInteractive,
}

/// Connection request from the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct ConnectConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(flatten)]
    pub auth: AuthConfig,
}

fn default_port() -> u16 {
    22
}

/// Result of an `ssh_connect` attempt.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ConnectResult {
    /// `true` when a session was established and authenticated.
    pub connected: bool,
    /// Opaque session id (UUID v4) when `connected` is true; empty otherwise.
    pub session_id: String,
    /// `true` when the server requires keyboard-interactive / OTP and the
    /// frontend must drive `ssh_submit_otp` (NOT yet implemented — see otp.rs).
    pub needs_otp: bool,
    /// Human-readable error / status message (empty on success).
    pub message: String,
}

/// Open + authenticate an SSH session.
///
/// NEVER throws across the Tauri boundary on a *connection* failure: returns a
/// `ConnectResult { connected: false, message }` instead, mirroring the
/// never-throw philosophy of the Python scheduler layer. (A `Result::Err` is
/// reserved for truly unexpected internal faults.)
#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    config: ConnectConfig,
    state: tauri::State<'_, SshState>,
) -> Result<ConnectResult, String> {
    let ConnectConfig {
        host,
        port,
        username,
        auth,
    } = config;

    // 1. Open TCP + SSH transport and run the persistent-TOFU server-key check.
    //    The pinned-key store lives under the app data dir; a key MISMATCH there
    //    refuses the connection (possible MITM).
    let pin_store = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join("ssh_known_hosts.json");
    let key_mismatch = Arc::new(AtomicBool::new(false));

    let ssh_config = Arc::new(client::Config::default());
    let handler = MobileHandler::new(host.clone(), port, pin_store, key_mismatch.clone());
    let addr = (host.as_str(), port);

    let mut handle = match client::connect(ssh_config, addr, handler).await {
        Ok(h) => h,
        Err(e) => {
            let message = if key_mismatch.load(Ordering::SeqCst) {
                format!(
                    "Host key for {host}:{port} CHANGED — refusing to connect (possible \
                     man-in-the-middle). If the host key legitimately changed, remove its \
                     entry from ssh_known_hosts.json and reconnect."
                )
            } else {
                format!("SSH connect to {host}:{port} failed: {e}")
            };
            return Ok(ConnectResult { message, ..Default::default() });
        }
    };

    // 2. Authenticate per the requested method.
    match auth {
        AuthConfig::Password { password } => {
            match handle.authenticate_password(&username, password).await {
                Ok(AuthResult::Success) => {}
                Ok(AuthResult::Failure { .. }) => {
                    return Ok(ConnectResult {
                        message: "Password authentication rejected".into(),
                        ..Default::default()
                    });
                }
                Err(e) => {
                    return Ok(ConnectResult {
                        message: format!("Password auth error: {e}"),
                        ..Default::default()
                    });
                }
            }
        }
        AuthConfig::Publickey {
            key_path,
            passphrase,
        } => {
            // load_secret_key wants Option<&str> for the passphrase.
            let pass_ref = passphrase.as_deref().filter(|s| !s.is_empty());
            let key = match load_secret_key(&key_path, pass_ref) {
                Ok(k) => k,
                Err(e) => {
                    return Ok(ConnectResult {
                        message: format!("Could not load private key {key_path}: {e}"),
                        ..Default::default()
                    });
                }
            };
            // hash_alg only matters for RSA (Sha512 here); ignored & forced to
            // None for ed25519/ecdsa by PrivateKeyWithHashAlg::new.
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha512));
            match handle.authenticate_publickey(&username, key_with_alg).await {
                Ok(AuthResult::Success) => {}
                Ok(AuthResult::Failure { .. }) => {
                    return Ok(ConnectResult {
                        message: "Public-key authentication rejected".into(),
                        ..Default::default()
                    });
                }
                Err(e) => {
                    return Ok(ConnectResult {
                        message: format!("Public-key auth error: {e}"),
                        ..Default::default()
                    });
                }
            }
        }
        AuthConfig::KeyboardInteractive => {
            // Keyboard-interactive / OTP requires a frontend round-trip: the
            // server sends prompt rounds (password, then OTP, ...) that the user
            // must answer interactively. That handshake cannot finish inside this
            // single command, so we surface `needs_otp` and leave the pending
            // handle wiring to `ssh_submit_otp`.
            //
            // TODO(OTP-wiring): to support this we must KEEP the partially-
            // authed `handle` alive between `ssh_connect` and `ssh_submit_otp`
            // (the start/respond loop is `&mut self` on the SAME handle). That
            // means stashing the in-flight handle in a separate "pending" map in
            // SshState and resuming the loop in `ssh_submit_otp`. Doing that
            // correctly (prompt surfacing, multi-round loops, echo masking,
            // timeout/cancel) is deliberately deferred rather than guessed.
            return Ok(ConnectResult {
                needs_otp: true,
                message: "Keyboard-interactive/OTP not yet wired (see ssh_submit_otp TODO)".into(),
                ..Default::default()
            });
        }
    }

    // 3. Authenticated — register the live session.
    let session = Arc::new(SshSession::new(handle, host.clone(), username.clone()));
    let session_id = state.insert(session).await;
    log::info!(
        "[CatGo SSH] connected session {session_id} ({username}@{host}:{port})"
    );

    Ok(ConnectResult {
        connected: true,
        session_id,
        message: String::new(),
        needs_otp: false,
    })
}

//! SSH connect + authentication command.
//!
//! Implements the `ssh_connect` Tauri command: open a TCP+SSH session via
//! `russh::client::connect`, verify the server key through the TOFU
//! [`MobileHandler`], then authenticate with PASSWORD or PUBLIC-KEY.
//!
//! KEYBOARD-INTERACTIVE / OTP (2FA) needs a frontend round-trip — the server
//! emits one or more `InfoRequest` prompt rounds and the user has to type the
//! codes — so it CANNOT complete inside a single `ssh_connect` call. We start
//! the handshake here, stash the in-flight handle in [`SshState`]'s pending map,
//! and return `needs_otp = true` + `pending_id` + `prompts`; the response
//! rounds are driven by [`super::otp::ssh_submit_otp`].

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse, Prompt};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};

use super::handler::MobileHandler;
use super::state::{PendingAuth, SshSession, SshState};

/// One keyboard-interactive / OTP prompt surfaced to the frontend.
///
/// Mirrors russh's [`russh::client::Prompt`] but is `Serialize` so it can cross
/// the Tauri boundary. `echo == false` => the answer is secret (OTP / password)
/// and the UI MUST mask it; `echo == true` => plain, visible input.
#[derive(Debug, Clone, Serialize)]
pub struct OtpPrompt {
    /// Prompt text to show the user (e.g. "One-time password: ").
    pub prompt: String,
    /// Whether the typed answer should be echoed (`false` => mask as a secret).
    pub echo: bool,
}

impl From<&Prompt> for OtpPrompt {
    fn from(p: &Prompt) -> Self {
        Self { prompt: p.prompt.clone(), echo: p.echo }
    }
}

/// Map a russh `Vec<Prompt>` to the serializable wire form.
pub fn map_prompts(prompts: &[Prompt]) -> Vec<OtpPrompt> {
    prompts.iter().map(OtpPrompt::from).collect()
}

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
    /// frontend must drive `ssh_submit_otp` with `pending_id` + `prompts`.
    pub needs_otp: bool,
    /// Human-readable error / status message (empty on success).
    pub message: String,
    /// In-flight handshake id to pass back to `ssh_submit_otp` (only set when
    /// `needs_otp` is true). Skipped from the wire when empty so the
    /// password/public-key paths serialize unchanged.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pending_id: String,
    /// The prompts the user must answer this round (only set with `needs_otp`).
    /// `echo == false` => mask the answer. Skipped when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prompts: Vec<OtpPrompt>,
    /// Server-supplied instructions for this round (may be empty). Skipped when
    /// empty so non-OTP paths stay clean.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instructions: String,
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
            // Start the keyboard-interactive handshake. The server may answer
            // immediately (Success, e.g. no actual prompts), reject (Failure),
            // or — the common 2FA case — return an `InfoRequest` round of
            // prompts (password, then OTP, ...). Because the start/respond loop
            // is `&mut self` on the SAME handle and can span MULTIPLE rounds,
            // each `InfoRequest` is handed back to the frontend and the mid-auth
            // handle is parked in the `pending` map for `ssh_submit_otp` to
            // resume. `None` submethods => let the server choose.
            match handle
                .authenticate_keyboard_interactive_start(&username, None)
                .await
            {
                // Authed in one shot — fall through to "register live session".
                Ok(KeyboardInteractiveAuthResponse::Success) => {}
                Ok(KeyboardInteractiveAuthResponse::InfoRequest {
                    instructions,
                    prompts,
                    ..
                }) => {
                    let wire_prompts = map_prompts(&prompts);
                    let pending = PendingAuth::new(handle, host.clone(), username.clone());
                    let pending_id = state.insert_pending(pending).await;
                    log::info!(
                        "[CatGo SSH] keyboard-interactive challenge for {username}@{host}:{port} \
                         — pending {pending_id} ({} prompt(s))",
                        wire_prompts.len()
                    );
                    return Ok(ConnectResult {
                        needs_otp: true,
                        pending_id,
                        prompts: wire_prompts,
                        instructions,
                        ..Default::default()
                    });
                }
                Ok(KeyboardInteractiveAuthResponse::Failure { .. }) => {
                    return Ok(ConnectResult {
                        message: "Keyboard-interactive auth rejected".into(),
                        ..Default::default()
                    });
                }
                Err(e) => {
                    return Ok(ConnectResult {
                        message: format!("Keyboard-interactive auth error: {e}"),
                        ..Default::default()
                    });
                }
            }
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
        ..Default::default()
    })
}

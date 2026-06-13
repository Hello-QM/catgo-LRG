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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse, Prompt};
use russh::keys::{decode_secret_key, load_secret_key, HashAlg, PrivateKeyWithHashAlg};

use super::handler::MobileHandler;
use super::state::{PendingAuth, PendingStage, SshHandle, SshSession, SshState, TargetPlan};

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
#[serde(rename_all = "kebab-case", tag = "method")]
pub enum AuthConfig {
    /// Username + password.
    Password { password: String },
    /// Public key loaded from a file path on disk. `passphrase` decrypts an
    /// encrypted private key (`None`/empty => unencrypted). `key_content` is
    /// used by browser/mobile pickers which cannot expose a stable file path.
    Publickey {
        #[serde(default)]
        key_path: Option<String>,
        #[serde(default)]
        key_content: Option<String>,
        #[serde(default)]
        passphrase: Option<String>,
    },
    /// Keyboard-interactive (OTP / 2FA). Needs the frontend round-trip — see
    /// `super::otp`. We still accept it here so the frontend can signal intent.
    KeyboardInteractive,
}

/// Optional jump host (ProxyJump / bastion) to tunnel through before reaching
/// the target. Authenticated first; then a `direct-tcpip` channel to the target
/// carries the target's SSH handshake. The jump may itself need any auth method
/// (password / public-key / keyboard-interactive OTP), independent of the target.
#[derive(Debug, Clone, Deserialize)]
pub struct JumpConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(flatten)]
    pub auth: AuthConfig,
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
    /// Optional jump host to tunnel through. `None` => direct connect (unchanged).
    #[serde(default)]
    pub jump: Option<JumpConfig>,
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

/// Outcome of one authentication attempt on a russh handle.
enum AuthOutcome {
    /// Authenticated — the now-authed handle is returned for use.
    Authed(SshHandle),
    /// The server wants a keyboard-interactive / OTP round. The mid-auth handle
    /// plus the prompts to surface; the caller parks the handle and returns
    /// `needs_otp` so the frontend drives `ssh_submit_otp`.
    NeedsOtp { handle: SshHandle, prompts: Vec<OtpPrompt>, instructions: String },
    /// Authentication failed or errored — human-readable message.
    Failed(String),
}

/// Run ONE authentication attempt for `auth` against `handle`. Shared by the
/// jump-host leg, the target leg, and the direct (no-jump) path. Keyboard-
/// interactive only STARTS here (one round); the OTP loop is driven by
/// `super::otp::ssh_submit_otp`.
async fn authenticate(mut handle: SshHandle, username: &str, auth: &AuthConfig) -> AuthOutcome {
    match auth {
        AuthConfig::Password { password } => {
            match handle.authenticate_password(username, password.clone()).await {
                Ok(AuthResult::Success) => AuthOutcome::Authed(handle),
                Ok(AuthResult::Failure { .. }) => {
                    AuthOutcome::Failed("Password authentication rejected".into())
                }
                Err(e) => AuthOutcome::Failed(format!("Password auth error: {e}")),
            }
        }
        AuthConfig::Publickey { key_path, key_content, passphrase } => {
            let pass_ref = passphrase.as_deref().filter(|s| !s.is_empty());
            let key = if let Some(content) = key_content.as_deref().filter(|s| !s.trim().is_empty()) {
                match decode_secret_key(content, pass_ref) {
                    Ok(k) => k,
                    Err(e) => {
                        return AuthOutcome::Failed(format!("Could not parse selected private key: {e}"))
                    }
                }
            } else if let Some(path) = key_path.as_deref().filter(|s| !s.trim().is_empty()) {
                match load_secret_key(path, pass_ref) {
                    Ok(k) => k,
                    Err(e) => {
                        return AuthOutcome::Failed(format!("Could not load private key {path}: {e}"))
                    }
                }
            } else {
                return AuthOutcome::Failed("Public-key authentication requires a key file".into())
            };
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha512));
            match handle.authenticate_publickey(username, key_with_alg).await {
                Ok(AuthResult::Success) => AuthOutcome::Authed(handle),
                Ok(AuthResult::Failure { .. }) => {
                    AuthOutcome::Failed("Public-key authentication rejected".into())
                }
                Err(e) => AuthOutcome::Failed(format!("Public-key auth error: {e}")),
            }
        }
        AuthConfig::KeyboardInteractive => {
            match handle
                .authenticate_keyboard_interactive_start(username, None)
                .await
            {
                Ok(KeyboardInteractiveAuthResponse::Success) => AuthOutcome::Authed(handle),
                Ok(KeyboardInteractiveAuthResponse::InfoRequest { instructions, prompts, .. }) => {
                    AuthOutcome::NeedsOtp { handle, prompts: map_prompts(&prompts), instructions }
                }
                Ok(KeyboardInteractiveAuthResponse::Failure { .. }) => {
                    AuthOutcome::Failed("Keyboard-interactive auth rejected".into())
                }
                Err(e) => AuthOutcome::Failed(format!("Keyboard-interactive auth error: {e}")),
            }
        }
    }
}

/// After the jump host is authenticated, open a `direct-tcpip` tunnel to the
/// target and run the target's SSH handshake + auth over it. Registers a
/// tunnelled session (keeping `jump_handle` alive) or parks a `Target`-stage
/// pending handshake when the target needs OTP. Shared by the synchronous jump
/// path (`ssh_connect`) and the jump-OTP path (`ssh_submit_otp`).
pub(super) async fn proceed_to_target(
    jump_handle: SshHandle,
    target: TargetPlan,
    pin_store: PathBuf,
    ssh_config: Arc<client::Config>,
    state: &SshState,
) -> ConnectResult {
    let channel = match jump_handle
        .channel_open_direct_tcpip(target.host.clone(), target.port as u32, "127.0.0.1", 0)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            return ConnectResult {
                message: format!(
                    "Jump: could not open tunnel to {}:{}: {e}",
                    target.host, target.port
                ),
                ..Default::default()
            }
        }
    };

    let key_mismatch = Arc::new(AtomicBool::new(false));
    let handler =
        MobileHandler::new(target.host.clone(), target.port, pin_store, key_mismatch.clone());
    let target_handle =
        match client::connect_stream(ssh_config, channel.into_stream(), handler).await {
            Ok(h) => h,
            Err(e) => {
                let message = if key_mismatch.load(Ordering::SeqCst) {
                    format!(
                        "Target host key for {}:{} CHANGED — refusing to connect \
                         (possible man-in-the-middle).",
                        target.host, target.port
                    )
                } else {
                    format!(
                        "SSH connect to target {}:{} over jump host failed: {e}",
                        target.host, target.port
                    )
                };
                return ConnectResult { message, ..Default::default() };
            }
        };

    match authenticate(target_handle, &target.username, &target.auth).await {
        AuthOutcome::Authed(h) => {
            let session = Arc::new(SshSession::new_tunnelled(
                h,
                target.host.clone(),
                target.username.clone(),
                jump_handle,
            ));
            let session_id = state.insert(session).await;
            log::info!(
                "[CatGo SSH] connected tunnelled session {session_id} ({}@{} via jump)",
                target.username, target.host
            );
            ConnectResult { connected: true, session_id, ..Default::default() }
        }
        AuthOutcome::NeedsOtp { handle, prompts, instructions } => {
            let pending = PendingAuth::new(
                handle,
                target.host.clone(),
                target.username.clone(),
                PendingStage::Target { jump: jump_handle },
            );
            let pending_id = state.insert_pending(pending).await;
            ConnectResult { needs_otp: true, pending_id, prompts, instructions, ..Default::default() }
        }
        AuthOutcome::Failed(message) => ConnectResult { message, ..Default::default() },
    }
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
        jump,
    } = config;

    // The pinned-key TOFU store (shared file, keyed per host) lives under the app
    // data dir; a key MISMATCH there refuses the connection (possible MITM).
    let pin_store = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join("ssh_known_hosts.json");

    // Keepalive so an idle session stays alive for ControlMaster-style reuse
    // (the frontend re-picks a still-live connection instead of re-authenticating).
    let ssh_config = Arc::new(client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    // ── ProxyJump path: authenticate the jump host first, then tunnel. ──
    if let Some(jump) = jump {
        let key_mismatch = Arc::new(AtomicBool::new(false));
        let handler = MobileHandler::new(
            jump.host.clone(),
            jump.port,
            pin_store.clone(),
            key_mismatch.clone(),
        );
        let jump_handle =
            match client::connect(ssh_config.clone(), (jump.host.as_str(), jump.port), handler).await
            {
                Ok(h) => h,
                Err(e) => {
                    let message = if key_mismatch.load(Ordering::SeqCst) {
                        format!(
                            "Jump host key for {}:{} CHANGED — refusing to connect \
                             (possible man-in-the-middle).",
                            jump.host, jump.port
                        )
                    } else {
                        format!("SSH connect to jump host {}:{} failed: {e}", jump.host, jump.port)
                    };
                    return Ok(ConnectResult { message, ..Default::default() });
                }
            };

        let target = TargetPlan { host, port, username, auth };
        return Ok(match authenticate(jump_handle, &jump.username, &jump.auth).await {
            AuthOutcome::Authed(jh) => {
                proceed_to_target(jh, target, pin_store, ssh_config, state.inner()).await
            }
            AuthOutcome::NeedsOtp { handle, prompts, instructions } => {
                let pending = PendingAuth::new(
                    handle,
                    jump.host.clone(),
                    jump.username.clone(),
                    PendingStage::Jump { target, pin_store, ssh_config },
                );
                let pending_id = state.insert_pending(pending).await;
                ConnectResult { needs_otp: true, pending_id, prompts, instructions, ..Default::default() }
            }
            AuthOutcome::Failed(message) => ConnectResult { message, ..Default::default() },
        });
    }

    // ── Direct path (no jump host) — original behavior via the shared helper. ──
    let key_mismatch = Arc::new(AtomicBool::new(false));
    let handler = MobileHandler::new(host.clone(), port, pin_store, key_mismatch.clone());
    let handle = match client::connect(ssh_config, (host.as_str(), port), handler).await {
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

    Ok(match authenticate(handle, &username, &auth).await {
        AuthOutcome::Authed(h) => {
            let session = Arc::new(SshSession::new(h, host.clone(), username.clone()));
            let session_id = state.insert(session).await;
            log::info!("[CatGo SSH] connected session {session_id} ({username}@{host}:{port})");
            ConnectResult { connected: true, session_id, ..Default::default() }
        }
        AuthOutcome::NeedsOtp { handle, prompts, instructions } => {
            let pending =
                PendingAuth::new(handle, host.clone(), username.clone(), PendingStage::Direct);
            let pending_id = state.insert_pending(pending).await;
            log::info!(
                "[CatGo SSH] keyboard-interactive challenge for {username}@{host}:{port} — \
                 pending {pending_id} ({} prompt(s))",
                prompts.len()
            );
            ConnectResult { needs_otp: true, pending_id, prompts, instructions, ..Default::default() }
        }
        AuthOutcome::Failed(message) => ConnectResult { message, ..Default::default() },
    })
}

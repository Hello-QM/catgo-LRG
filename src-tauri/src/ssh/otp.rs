//! Keyboard-interactive / OTP (2FA) submission.
//!
//! Resumes the keyboard-interactive handshake that `ssh_connect` began. The
//! mid-auth `Handle` was parked in `SshState::pending` (see `state.rs`); here we
//! MOVE it back out, drive one `authenticate_keyboard_interactive_respond`
//! round, and react to the server's reply:
//!
//!   * `Success`     => build + register the live `SshSession`, return
//!                      `connected: true` + the new `session_id`.
//!   * `InfoRequest` => the server wants ANOTHER round (multi-round 2FA, e.g.
//!                      password THEN OTP). Re-stash the SAME handle under a NEW
//!                      `pending_id` and return `needs_otp: true` + the new
//!                      prompts so the frontend submits again.
//!   * `Failure`     => surface "OTP rejected" (never throws across the
//!                      boundary on an auth failure).
//!   * `Err`         => surface "OTP error: ..." likewise.
//!
//! Because the handle is `&mut self` for `respond`, it is owned exclusively here
//! for the duration of the call; it is only ever shared once it becomes a live
//! `SshSession` (behind that session's own `Mutex`).

use std::sync::Arc;

use serde::Deserialize;

use russh::client::KeyboardInteractiveAuthResponse;

use super::auth::{map_prompts, proceed_to_target, ConnectResult};
use super::state::{PendingAuth, PendingStage, SshSession, SshState};

/// One OTP / keyboard-interactive submission round from the frontend: the
/// answers for the prompts most recently surfaced by the server.
#[derive(Debug, Clone, Deserialize)]
pub struct OtpSubmission {
    /// The pending (pre-auth) handshake id minted by `ssh_connect` (or by the
    /// previous `ssh_submit_otp` round, for multi-round 2FA).
    pub pending_id: String,
    /// One answer per prompt in the current `InfoRequest`, in order. Its length
    /// must equal the prompt count of that round (russh enforces this).
    pub responses: Vec<String>,
}

/// Submit OTP / keyboard-interactive responses for a pending handshake.
///
/// Never throws across the Tauri boundary on an auth failure — returns a
/// `ConnectResult` describing the outcome instead (mirrors `ssh_connect`).
#[tauri::command]
pub async fn ssh_submit_otp(
    submission: OtpSubmission,
    state: tauri::State<'_, SshState>,
) -> Result<ConnectResult, String> {
    let OtpSubmission { pending_id, responses } = submission;

    // MOVE the mid-auth handle out of the pending map. A missing id means the
    // handshake expired, was already consumed, or never existed.
    let PendingAuth { mut handle, host, username, stage } =
        match state.take_pending(&pending_id).await {
            Some(p) => p,
            None => {
                return Ok(ConnectResult {
                    message: "no pending OTP session (expired or already used)".into(),
                    ..Default::default()
                });
            }
        };

    // Drive exactly ONE round. The server decides whether more rounds follow.
    match handle
        .authenticate_keyboard_interactive_respond(responses)
        .await
    {
        Ok(KeyboardInteractiveAuthResponse::Success) => {
            // The hop authenticated. What happens next depends on the stage:
            match stage {
                // Direct connect, or the TARGET leg of a jump — register the
                // session (carrying the jump handle alive for the Target stage).
                PendingStage::Direct => {
                    let session = Arc::new(SshSession::new(handle, host.clone(), username.clone()));
                    let session_id = state.insert(session).await;
                    log::info!(
                        "[CatGo SSH] keyboard-interactive auth complete — session {session_id} \
                         ({username}@{host})"
                    );
                    Ok(ConnectResult { connected: true, session_id, ..Default::default() })
                }
                PendingStage::Target { jump } => {
                    let session = Arc::new(SshSession::new_tunnelled(
                        handle,
                        host.clone(),
                        username.clone(),
                        jump,
                    ));
                    let session_id = state.insert(session).await;
                    log::info!(
                        "[CatGo SSH] tunnelled keyboard-interactive auth complete — session \
                         {session_id} ({username}@{host} via jump)"
                    );
                    Ok(ConnectResult { connected: true, session_id, ..Default::default() })
                }
                // The JUMP host just finished authenticating — `handle` is now the
                // authed jump handle. Open the tunnel and start the target leg
                // (which may itself return another `needs_otp`).
                PendingStage::Jump { target, pin_store, ssh_config } => {
                    log::info!("[CatGo SSH] jump host {host} authenticated — opening tunnel");
                    Ok(proceed_to_target(handle, target, pin_store, ssh_config, state.inner()).await)
                }
            }
        }
        // Another round (multi-round 2FA): re-park the SAME handle + stage under a
        // NEW pending_id and ask the frontend for the next set of answers.
        Ok(KeyboardInteractiveAuthResponse::InfoRequest {
            instructions,
            prompts,
            ..
        }) => {
            let wire_prompts = map_prompts(&prompts);
            let pending = PendingAuth::new(handle, host, username, stage);
            let next_id = state.insert_pending(pending).await;
            log::info!(
                "[CatGo SSH] keyboard-interactive needs another round — pending {next_id} \
                 ({} prompt(s))",
                wire_prompts.len()
            );
            Ok(ConnectResult {
                needs_otp: true,
                pending_id: next_id,
                prompts: wire_prompts,
                instructions,
                ..Default::default()
            })
        }
        Ok(KeyboardInteractiveAuthResponse::Failure { .. }) => Ok(ConnectResult {
            message: "OTP rejected".into(),
            ..Default::default()
        }),
        // The connection died while the handshake sat waiting for the code —
        // the server's LoginGraceTime / Duo timeout expired, or (common on
        // iOS) switching to an authenticator app suspended CatGo long enough
        // for the socket to drop. The raw russh wording ("Unable to receive
        // more messages from the channel") reads like a bug; tell the user
        // what actually happened and what to do.
        Err(russh::Error::RecvError | russh::Error::SendError | russh::Error::Disconnect) => {
            Ok(ConnectResult {
                message: "OTP session expired: the SSH server closed the connection while                           waiting for the code (switching to another app to read it can                           suspend CatGo long enough to time out). Please connect again."
                    .into(),
                ..Default::default()
            })
        }
        Err(e) => Ok(ConnectResult {
            message: format!("OTP error: {e}"),
            ..Default::default()
        }),
    }
}

//! Keyboard-interactive / OTP (2FA) submission — STUB (clearly-marked TODO).
//!
//! The real flow (confirmed by the spike) is a start/respond loop driven on the
//! SAME `Handle` that `ssh_connect` opened:
//!
//! ```ignore
//! let mut resp = handle
//!     .authenticate_keyboard_interactive_start(user, None /* submethods */)
//!     .await?;
//! loop {
//!     match resp {
//!         KeyboardInteractiveAuthResponse::Success => break, // authed
//!         KeyboardInteractiveAuthResponse::Failure { .. } => /* fail */,
//!         KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
//!             // prompts: Vec<Prompt { prompt: String, echo: bool }>
//!             // echo == false => secret (OTP/password) -> mask in the UI.
//!             // responses.len() MUST equal prompts.len().
//!             let answers: Vec<String> = /* one per prompt, from the frontend */;
//!             resp = handle
//!                 .authenticate_keyboard_interactive_respond(answers)
//!                 .await?;
//!         }
//!     }
//! }
//! ```
//!
//! Why this is deferred and NOT blind-guessed:
//!   * The handshake spans MULTIPLE Tauri command calls (one `InfoRequest`
//!     round per `ssh_submit_otp` invocation), so the partially-authed `Handle`
//!     must survive between calls. That needs a dedicated "pending sessions"
//!     map in `SshState` (separate from the authed `sessions` map), created in
//!     `ssh_connect` when `needs_otp` is detected.
//!   * The frontend contract (how prompts are surfaced, how many rounds, how
//!     cancel/timeout behave) isn't pinned down yet. Guessing the wiring would
//!     bake in an API we'd have to break later.
//!
//! This stub compiles and returns an explicit "not yet implemented" error so
//! the command is registerable today without committing to a half-built path.

use serde::Deserialize;

use super::state::SshState;

/// One OTP/keyboard-interactive submission round from the frontend: the answers
/// for the prompts most recently surfaced by the server.
#[derive(Debug, Clone, Deserialize)]
pub struct OtpSubmission {
    /// The pending (pre-auth) session id minted by `ssh_connect` when it
    /// returned `needs_otp = true`.
    pub pending_id: String,
    /// One answer per prompt in the current `InfoRequest`, in order.
    pub responses: Vec<String>,
}

/// Submit OTP / keyboard-interactive responses for a pending session.
///
/// TODO(OTP-wiring): implement the start/respond loop documented above against
/// a pending-handle map in `SshState`. Until then this returns an explicit
/// error rather than silently failing or guessing the wiring.
#[tauri::command]
pub async fn ssh_submit_otp(
    submission: OtpSubmission,
    _state: tauri::State<'_, SshState>,
) -> Result<super::auth::ConnectResult, String> {
    // Touch the fields so the (intentional) stub still type-checks the payload
    // shape the frontend will send.
    let _ = (&submission.pending_id, &submission.responses);
    Err(
        "ssh_submit_otp is not yet implemented: keyboard-interactive/OTP wiring \
         (pending-handle map + start/respond loop) is a TODO. See src-tauri/src/ssh/otp.rs."
            .to_string(),
    )
}

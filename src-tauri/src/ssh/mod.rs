//! SSH foundation for the mobile HPC transport (russh-backed).
//!
//! This module is the future mobile SSH transport, but it is INTENTIONALLY NOT
//! `#[cfg]`-gated: russh compiles on every target, so the module builds (and is
//! validated) on desktop too. The Tauri commands are registered in BOTH the
//! `cfg(desktop)` and `cfg(not(desktop))` invoke handlers in `lib.rs`.
//!
//! Layout:
//!   * `state.rs`   — `SshState` registry + per-session `SshSession` wrapper.
//!   * `handler.rs` — `MobileHandler`: TOFU server-key verification.
//!   * `auth.rs`    — `ssh_connect` (password / public-key; OTP detection).
//!   * `otp.rs`     — `ssh_submit_otp` (clearly-marked TODO stub).
//!   * `exec.rs`    — `ssh_exec` (login-shell exec, never-throw, ~30s timeout).
//!
//! Known TODOs (see the respective files for detail):
//!   * TOFU persistent pinning (handler.rs) — currently accept-and-log only.
//!   * OTP / keyboard-interactive wiring (auth.rs + otp.rs).
//!   * ProxyJump / direct-tcpip (not yet implemented; spike documents the API).
//!   * SFTP file transfer (russh-sftp added, not yet wired).

pub mod auth;
pub mod exec;
pub mod handler;
pub mod otp;
pub mod pty;
pub mod state;

// Re-exported for ergonomic `ssh::ssh_connect` use elsewhere. NOTE: `lib.rs`'s
// `generate_handler!` references the commands via their DEFINING module path
// (`ssh::auth::ssh_connect`, ...) because the `#[tauri::command]` macro emits a
// sibling `__cmd__<name>` item that only resolves at the definition site — a
// plain re-export does not bring that hidden item along. These stay for any
// non-macro caller; allow(unused) keeps the build warning-free.
#[allow(unused_imports)]
pub use auth::ssh_connect;
#[allow(unused_imports)]
pub use exec::ssh_exec;
#[allow(unused_imports)]
pub use otp::ssh_submit_otp;
pub use state::SshState;

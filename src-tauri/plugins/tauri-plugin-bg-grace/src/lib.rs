//! iOS background grace period.
//!
//! iOS freezes an app within a few seconds of it entering the background — any
//! in-flight SSH socket then stalls, so switching to an authenticator app to
//! read an OTP code killed the pending keyboard-interactive handshake
//! ("OTP session expired", see ssh/otp.rs). `beginBackgroundTask` asks iOS for
//! ~30 s of continued execution (no special entitlement, no background-mode
//! Info.plist key), which covers the common "flip to another app and right
//! back" pattern — the same approach SSH clients like Termius use.
//!
//! The Swift side (ios/Sources/BgGracePlugin.swift) owns the whole behavior via
//! UIApplication lifecycle notifications; there is no JS or Rust API surface.
//! On non-iOS targets this plugin is inert.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_bg_grace);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bg-grace")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_bg_grace)?;
            Ok(())
        })
        .build()
}

//! iOS background grace period + screen-awake control.
//!
//! iOS freezes an app within a few seconds of it entering the background — any
//! in-flight SSH socket then stalls, so switching to an authenticator app to
//! read an OTP code killed the pending keyboard-interactive handshake
//! ("OTP session expired", see ssh/otp.rs). `beginBackgroundTask` asks iOS for
//! ~30 s of continued execution (no special entitlement, no background-mode
//! Info.plist key), which covers the common "flip to another app and right
//! back" pattern — the same approach SSH clients like Termius use. That lifecycle
//! behavior is owned entirely by the Swift side (ios/Sources/BgGracePlugin.swift).
//!
//! JS surface (see src/lib/mobile/screen-wake.svelte.ts):
//!   - `set_idle_timer { disabled }` → toggles UIApplication.isIdleTimerDisabled,
//!     so the screen won't auto-lock while the user is in the terminal (an
//!     auto-lock backgrounds the app and drops the SSH connection). The webview
//!     enables it while a terminal is foreground and releases it otherwise.
//!
//! On non-iOS targets the command returns `Unsupported`; the plugin is only
//! registered on iOS (see the app's lib.rs), so it is never reached there.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

// `Manager` (for `.manage`) and `PluginHandle` are only used on the iOS path.
#[cfg(target_os = "ios")]
use tauri::{plugin::PluginHandle, Manager};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_bg_grace);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    // run_mobile_plugin() returns this; only constructed on the iOS bridge, so
    // the From impl (and the variant) are iOS-only to avoid an unused-variant
    // warning on desktop.
    #[cfg(target_os = "ios")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("bg-grace is only available on iOS")]
    Unsupported,
}

impl serde::Serialize for Error {
    fn serialize<S>(&self, s: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        s.serialize_str(self.to_string().as_ref())
    }
}

type Result<T> = std::result::Result<T, Error>;

// Constructed only on the iOS path (run_mobile_plugin); dead on host builds.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
#[derive(serde::Serialize)]
struct IdleArgs {
    /// Maps directly to UIApplication.isIdleTimerDisabled: true = stay awake.
    disabled: bool,
}

/// Handle to the iOS-side plugin; only constructed on iOS.
#[cfg(target_os = "ios")]
pub struct BgGrace<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "ios")]
impl<R: Runtime> BgGrace<R> {
    fn set_idle_timer(&self, disabled: bool) -> Result<()> {
        self.0
            .run_mobile_plugin("setIdleTimer", IdleArgs { disabled })
            .map_err(Into::into)
    }
}

/// Keep the screen awake (disable the iOS auto-lock/idle timer) while the user is
/// in the terminal, so an auto-lock can't background the app and drop the SSH
/// connection. `disabled` maps directly to UIApplication.isIdleTimerDisabled.
#[tauri::command]
async fn set_idle_timer<R: Runtime>(app: tauri::AppHandle<R>, disabled: bool) -> Result<()> {
    #[cfg(target_os = "ios")]
    {
        return app.state::<BgGrace<R>>().set_idle_timer(disabled);
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, disabled);
        Err(Error::Unsupported)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bg-grace")
        .invoke_handler(tauri::generate_handler![set_idle_timer])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_bg_grace)?;
                _app.manage(BgGrace(handle));
            }
            Ok(())
        })
        .build()
}

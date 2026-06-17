//! On-device speech-to-text for the iOS chat input.
//!
//! The desktop chat uses the Web Speech API (`webkitSpeechRecognition`), which
//! WebKit — and therefore the iOS WKWebView — does not implement. This plugin
//! bridges to iOS's native Speech framework instead: a Swift `SpeechPlugin`
//! (ios/Sources/SpeechPlugin.swift) drives `SFSpeechRecognizer` + `AVAudioEngine`
//! and streams partial transcripts back to the webview as `partial` / `final`
//! events. Recognition runs on-device when the hardware supports it, so audio
//! never leaves the phone and no API key is needed.
//!
//! JS surface (see src/lib/mobile/ios-speech.ts):
//!   - `request_permission` → prompts for mic + speech authorization
//!   - `start_listening { locale }` → begins streaming `partial`/`final` events
//!   - `stop_listening` → ends the session, emits a final `final`
//!
//! On non-iOS targets the commands return `Unsupported`; the plugin is only
//! registered on iOS (see the app's lib.rs), so they are never reached there.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

// `Manager` (for `.manage`) and `PluginHandle` are only used on the iOS path.
#[cfg(target_os = "ios")]
use tauri::{plugin::PluginHandle, Manager};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_speech);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    // run_mobile_plugin() returns this; only constructed on the iOS bridge, so
    // the From impl (and the variant) are iOS-only to avoid an unused-variant
    // warning on desktop. Host `cargo check` never exercises this path.
    #[cfg(target_os = "ios")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("speech recognition is only available on iOS")]
    Unsupported,
}

impl Serialize for Error {
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartArgs {
    /// BCP-47 locale, e.g. "en-US". `None` → the device's current locale.
    locale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    /// True only when BOTH microphone and speech-recognition were authorized.
    pub granted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalesResponse {
    /// BCP-47 identifiers the device can recognize, e.g. ["en-US", "zh-CN", …].
    pub locales: Vec<String>,
}

/// Handle to the iOS-side plugin; only constructed on iOS.
#[cfg(target_os = "ios")]
pub struct Speech<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "ios")]
impl<R: Runtime> Speech<R> {
    fn request_permission(&self) -> Result<PermissionResponse> {
        self.0
            .run_mobile_plugin("requestPermission", ())
            .map_err(Into::into)
    }

    fn supported_locales(&self) -> Result<LocalesResponse> {
        self.0
            .run_mobile_plugin("supportedLocales", ())
            .map_err(Into::into)
    }

    fn start_listening(&self, locale: Option<String>) -> Result<()> {
        self.0
            .run_mobile_plugin("startListening", StartArgs { locale })
            .map_err(Into::into)
    }

    fn stop_listening(&self) -> Result<()> {
        self.0
            .run_mobile_plugin("stopListening", ())
            .map_err(Into::into)
    }
}

#[tauri::command]
async fn request_permission<R: Runtime>(app: tauri::AppHandle<R>) -> Result<PermissionResponse> {
    #[cfg(target_os = "ios")]
    {
        return app.state::<Speech<R>>().request_permission();
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err(Error::Unsupported)
    }
}

#[tauri::command]
async fn supported_locales<R: Runtime>(app: tauri::AppHandle<R>) -> Result<LocalesResponse> {
    #[cfg(target_os = "ios")]
    {
        return app.state::<Speech<R>>().supported_locales();
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err(Error::Unsupported)
    }
}

#[tauri::command]
async fn start_listening<R: Runtime>(
    app: tauri::AppHandle<R>,
    locale: Option<String>,
) -> Result<()> {
    #[cfg(target_os = "ios")]
    {
        return app.state::<Speech<R>>().start_listening(locale);
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, locale);
        Err(Error::Unsupported)
    }
}

#[tauri::command]
async fn stop_listening<R: Runtime>(app: tauri::AppHandle<R>) -> Result<()> {
    #[cfg(target_os = "ios")]
    {
        return app.state::<Speech<R>>().stop_listening();
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err(Error::Unsupported)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ios-speech")
        .invoke_handler(tauri::generate_handler![
            request_permission,
            supported_locales,
            start_listening,
            stop_listening
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_ios_speech)?;
                _app.manage(Speech(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use std::sync::Mutex;

/// Configure WKWebView for optimal WebGL/3D rendering performance.
/// Uses private WebKit APIs to enable hardware-accelerated drawing and compositing,
/// which are not always on by default in embedded WKWebView (unlike Safari).
#[cfg(target_os = "macos")]
fn optimize_webview_for_webgl(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|wv| {
        unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;

            // wv.inner() returns a Retained<WKWebView>; cast to AnyObject for msg_send
            let wk: &AnyObject = &*std::ptr::addr_of!(*wv.inner()).cast::<AnyObject>();

            // Get WKWebViewConfiguration -> WKPreferences
            let config: *const AnyObject = msg_send![wk, configuration];
            if config.is_null() {
                log::warn!("[CatGo] WKWebView configuration is null");
                return;
            }
            let prefs: *const AnyObject = msg_send![&*config, preferences];
            if prefs.is_null() {
                log::warn!("[CatGo] WKPreferences is null");
                return;
            }

            // Enable hardware-accelerated drawing (private WebKit APIs)
            let _: () = msg_send![&*prefs, _setAcceleratedDrawingEnabled: true];
            let _: () = msg_send![&*prefs, _setAcceleratedCompositingEnabled: true];
            let _: () = msg_send![&*prefs, _setCanvasUsesAcceleratedDrawing: true];
            let _: () = msg_send![&*prefs, _setWebGLEnabled: true];
            let _: () = msg_send![&*prefs, _setLargeImageAsyncDecodingEnabled: true];

            // Enable media capture (camera/microphone) for gesture control.
            // WKWebView doesn't expose navigator.mediaDevices by default — these
            // private WebKit APIs are required to make getUserMedia() available.
            // _setMediaDevicesEnabled: exposes the navigator.mediaDevices API
            // _setMediaStreamEnabled: allows MediaStream objects from camera/mic
            // _setMediaCaptureRequiresSecureConnection: permits capture over http://localhost
            let _: () = msg_send![&*prefs, _setMediaDevicesEnabled: true];
            let _: () = msg_send![&*prefs, _setMediaStreamEnabled: true];
            let _: () = msg_send![&*prefs, _setMediaCaptureRequiresSecureConnection: false];

            log::info!("[CatGo] WebGL optimizations applied to WKWebView");
        }
    });

    if let Err(e) = result {
        log::warn!("[CatGo] Could not configure WKWebView: {:?}", e);
    }
}

/// Auto-grant camera/microphone permissions and enable WebGL in WebKitGTK.
/// Without permission auto-grant, getUserMedia() fails with NotAllowedError
/// because there is no browser-style permission prompt in an embedded webview.
/// WebGL must be explicitly enabled for MediaPipe WASM to create GL contexts.
#[cfg(target_os = "linux")]
fn configure_webkitgtk(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|wv| {
        use webkit2gtk::WebViewExt;
        use webkit2gtk::PermissionRequestExt;
        use webkit2gtk::SettingsExt;

        let webview = wv.inner();

        // Auto-grant camera/microphone permissions
        webview.connect_permission_request(|_, request: &webkit2gtk::PermissionRequest| {
            request.allow();
            true
        });
        log::info!("[CatGo] Media permissions auto-granted for WebKitGTK");

        // Enable WebGL and hardware acceleration for MediaPipe
        if let Some(settings) = webview.settings() {
            settings.set_enable_webgl(true);
            settings.set_hardware_acceleration_policy(
                webkit2gtk::HardwareAccelerationPolicy::Always,
            );
            settings.set_enable_webaudio(true);
            log::info!("[CatGo] WebGL and hardware acceleration enabled for WebKitGTK");
        }
    });
    if let Err(e) = result {
        log::warn!("[CatGo] Could not configure WebKitGTK: {:?}", e);
    }
}

mod db;
mod pty;
mod workflow_engine;

// Global state to track the Python backend process
struct BackendState {
    child: Option<tauri_plugin_shell::process::CommandChild>,
    /// True when we spawned the sidecar ourselves; false if backend was already running.
    spawned_by_us: bool,
}

// Global state to track the Node agent-bridge sidecar (catgo-agent).
// Separate from BackendState because the two binaries have independent
// lifecycles and the agent sidecar may be missing on older builds.
struct AgentState {
    child: Option<tauri_plugin_shell::process::CommandChild>,
    spawned_by_us: bool,
}

// State to buffer file paths from file association opens
struct OpenedFiles {
    paths: Vec<String>,
}

#[tauri::command]
fn get_opened_files(state: tauri::State<'_, Mutex<OpenedFiles>>) -> Vec<String> {
    if let Ok(mut files) = state.lock() {
        std::mem::take(&mut files.paths)
    } else {
        Vec::new()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .manage(Mutex::new(BackendState { child: None, spawned_by_us: false }))
        .manage(Mutex::new(AgentState { child: None, spawned_by_us: false }))
        .manage(Mutex::new(OpenedFiles { paths: Vec::new() }))
        .manage(pty::PtyState::default())
        .manage(db::DbState::default())
        .manage(workflow_engine::WorkflowEngineState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            get_opened_files,
            // DB management (mod.rs)
            db::db_get_current,
            db::db_new,
            db::db_open,
            db::db_save_as,
            // Filesystem (files.rs)
            db::files::db_browse_directory,
            db::files::db_browse_files,
            db::files::db_read_file,
            db::files::db_write_file,
            db::files::db_fs_mkdir,
            db::files::db_fs_delete,
            db::files::db_fs_rename,
            db::files::db_fs_copy,
            db::files::db_fs_move,
            // Projects & workflows (workflow.rs)
            db::workflow::db_list_projects,
            db::workflow::db_create_project,
            db::workflow::db_update_project,
            db::workflow::db_delete_project,
            db::workflow::db_get_project,
            db::workflow::db_get_enriched_results,
            db::workflow::db_assign_workflow_to_project,
            db::workflow::db_list_workflow_folders,
            db::workflow::db_create_workflow_folder,
            db::workflow::db_get_workflow_folder,
            db::workflow::db_update_workflow_folder,
            db::workflow::db_delete_workflow_folder,
            db::workflow::db_assign_workflow_to_folder,
            db::workflow::db_unassign_workflow_from_folder,
            db::workflow::db_list_workflows,
            db::workflow::db_create_workflow,
            db::workflow::db_get_workflow_detail,
            db::workflow::db_update_workflow,
            db::workflow::db_delete_workflow,
            db::workflow::db_list_steps,
            db::workflow::db_get_run_status,
            // Results & structures (results.rs)
            db::results::db_query_results,
            db::results::db_update_result_label,
            db::results::db_delete_result,
            db::results::db_move_or_copy_result,
            db::results::db_get_result_structure,
            db::results::db_save_structure,
            db::results::db_export_structure,
            db::results::db_serialize_structure,
            workflow_engine::db_run_workflow,
            workflow_engine::db_pause_workflow,
            workflow_engine::db_resume_workflow,
        ])
        .setup(|app| {
            // Enable logging in desktop builds
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            log::info!("[CatGo] Desktop app started");

            // Apply WebGL/GPU optimizations to the WKWebView (macOS only)
            #[cfg(target_os = "macos")]
            if let Some(webview_window) = app.get_webview_window("main") {
                optimize_webview_for_webgl(&webview_window);
            }

            // Configure WebKitGTK: permissions, WebGL, hardware acceleration (Linux)
            #[cfg(target_os = "linux")]
            if let Some(webview_window) = app.get_webview_window("main") {
                configure_webkitgtk(&webview_window);
            }

            // Before spawning sidecar, check if backend is already running
            let port = std::env::var("SERVER_PORT").unwrap_or_else(|_| "8000".to_string());
            let backend_already_running = {
                use std::net::TcpStream;
                let addr = format!("127.0.0.1:{}", port);
                TcpStream::connect_timeout(
                    &addr.parse().unwrap(),
                    std::time::Duration::from_millis(500),
                ).is_ok()
            };

            if backend_already_running {
                log::info!(
                    "[CatGo] Backend already running on port {} — skipping sidecar spawn",
                    port
                );
            } else {
                // Try to spawn the bundled backend sidecar
                let shell = app.shell();
                match shell.sidecar("catgo-server") {
                    Ok(cmd) => {
                        match cmd.spawn() {
                            Ok((mut rx, child)) => {
                                log::info!("[CatGo] Backend server started (sidecar)");

                                // Store the child process handle for cleanup
                                if let Ok(mut state) = app.state::<Mutex<BackendState>>().lock() {
                                    state.child = Some(child);
                                    state.spawned_by_us = true;
                                }

                                // Spawn a task to log backend output
                                tauri::async_runtime::spawn(async move {
                                    use tauri_plugin_shell::process::CommandEvent;
                                    while let Some(event) = rx.recv().await {
                                        match event {
                                            CommandEvent::Stdout(line) => {
                                                if let Ok(s) = String::from_utf8(line) {
                                                    log::info!("[Backend] {}", s.trim());
                                                }
                                            }
                                            CommandEvent::Stderr(line) => {
                                                if let Ok(s) = String::from_utf8(line) {
                                                    log::warn!("[Backend] {}", s.trim());
                                                }
                                            }
                                            CommandEvent::Error(err) => {
                                                log::error!("[Backend] Error: {}", err);
                                            }
                                            CommandEvent::Terminated(status) => {
                                                log::info!("[Backend] Process terminated with status: {:?}", status);
                                                break;
                                            }
                                            _ => {}
                                        }
                                    }
                                });
                            }
                            Err(e) => {
                                log::warn!("[CatGo] Could not start backend sidecar: {}", e);
                                log::info!("[CatGo] To enable calculations, run the backend server separately:");
                                log::info!("[CatGo]   cd server && python main.py");
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[CatGo] Backend sidecar not found: {}", e);
                        log::info!("[CatGo] To enable calculations, run the backend server separately:");
                        log::info!("[CatGo]   cd server && python main.py");
                    }
                }
            }

            // ── catgo-agent sidecar (Node.js, serves /api/agent/*) ────────────
            //
            // The agent-bridge runs the official SDKs (claude-agent-sdk,
            // codex-sdk, gemini-cli-sdk) which spawn the platform CLIs
            // (`claude`, `codex`, `gemini`). Desktop launchers strip PATH, so
            // we re-augment it here with the usual user-bin locations or the
            // CLIs won't be found in production.
            let agent_port = std::env::var("CATGO_AGENT_PORT").unwrap_or_else(|_| "8001".to_string());
            let agent_already_running = {
                use std::net::TcpStream;
                let addr = format!("127.0.0.1:{}", agent_port);
                TcpStream::connect_timeout(
                    &addr.parse().unwrap(),
                    std::time::Duration::from_millis(500),
                ).is_ok()
            };

            if agent_already_running {
                log::info!(
                    "[CatGo] Agent bridge already running on port {} — skipping sidecar spawn",
                    agent_port
                );
            } else {
                let augmented_path = {
                    let current = std::env::var("PATH").unwrap_or_default();
                    let home = std::env::var("HOME").unwrap_or_default();
                    let extras = [
                        format!("{home}/.local/bin"),
                        format!("{home}/.bun/bin"),
                        format!("{home}/.cargo/bin"),
                        format!("{home}/.npm-global/bin"),
                        format!("{home}/.nvm/versions/node"),
                        "/usr/local/bin".to_string(),
                        "/opt/homebrew/bin".to_string(),
                    ];
                    let extra = extras.join(":");
                    if current.is_empty() { extra } else { format!("{extra}:{current}") }
                };

                let shell = app.shell();
                match shell.sidecar("catgo-agent") {
                    Ok(cmd) => {
                        let cmd = cmd
                            .env("CATGO_AGENT_PORT", &agent_port)
                            .env("CATGO_BACKEND_PORT", &port)
                            .env("PATH", &augmented_path);
                        match cmd.spawn() {
                            Ok((mut rx, child)) => {
                                log::info!("[CatGo] Agent bridge started (sidecar) on port {}", agent_port);
                                if let Ok(mut state) = app.state::<Mutex<AgentState>>().lock() {
                                    state.child = Some(child);
                                    state.spawned_by_us = true;
                                }
                                tauri::async_runtime::spawn(async move {
                                    use tauri_plugin_shell::process::CommandEvent;
                                    while let Some(event) = rx.recv().await {
                                        match event {
                                            CommandEvent::Stdout(line) => {
                                                if let Ok(s) = String::from_utf8(line) {
                                                    log::info!("[Agent] {}", s.trim());
                                                }
                                            }
                                            CommandEvent::Stderr(line) => {
                                                if let Ok(s) = String::from_utf8(line) {
                                                    log::warn!("[Agent] {}", s.trim());
                                                }
                                            }
                                            CommandEvent::Error(err) => {
                                                log::error!("[Agent] Error: {}", err);
                                            }
                                            CommandEvent::Terminated(status) => {
                                                log::info!("[Agent] Process terminated: {:?}", status);
                                                break;
                                            }
                                            _ => {}
                                        }
                                    }
                                });
                            }
                            Err(e) => {
                                log::warn!("[CatGo] Could not start agent bridge: {}", e);
                                log::info!("[CatGo] SDK chat (Claude Code / Codex / Gemini) will be unavailable.");
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[CatGo] Agent sidecar not bundled: {}", e);
                        log::info!("[CatGo] SDK chat (Claude Code / Codex / Gemini) will be unavailable.");
                    }
                }
            }

            // Expose the agent port to the webview so `sdk-stream.ts` can
            // build the absolute URL (otherwise it would try `/api/agent/stream`
            // against the webview's own origin, which 404s in production).
            if let Some(win) = app.get_webview_window("main") {
                let init = format!("window.__CATGO_AGENT_PORT__ = {};", agent_port);
                let _ = win.eval(&init);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Only exit the app when the main window is closed;
                // secondary windows (chat popout, workflow, terminal) just close themselves.
                if window.label() != "main" {
                    return;
                }

                // Only kill the backend if we spawned it ourselves.
                // If it was already running externally (daemon mode), leave it alone.
                if let Ok(mut state) = window.state::<Mutex<BackendState>>().lock() {
                    if state.spawned_by_us {
                        if let Some(child) = state.child.take() {
                            log::info!("[CatGo] Stopping backend server (spawned by us)...");
                            let _ = child.kill();
                        }
                    } else {
                        log::info!("[CatGo] Backend was external — leaving it running");
                    }
                }
                if let Ok(mut state) = window.state::<Mutex<AgentState>>().lock() {
                    if state.spawned_by_us {
                        if let Some(child) = state.child.take() {
                            log::info!("[CatGo] Stopping agent bridge (spawned by us)...");
                            let _ = child.kill();
                        }
                    }
                }
                // Cancel all running workflows
                let engine_state = window.state::<workflow_engine::WorkflowEngineState>();
                engine_state.cancel_all();

                // Kill all PTY sessions
                let pty_state = window.state::<pty::PtyState>();
                pty_state.kill_all();

                // Exit via Tauri so the CLI detects shutdown and
                // terminates the beforeDevCommand process group (Vite + Python).
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = _event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|url: &url::Url| url.to_file_path().ok())
                .map(|p: std::path::PathBuf| p.to_string_lossy().to_string())
                .collect();

            if !paths.is_empty() {
                log::info!("[CatGo] File association opened: {:?}", paths);

                // Buffer paths in state
                if let Ok(mut state) = _app_handle.state::<Mutex<OpenedFiles>>().lock() {
                    state.paths.extend(paths);
                }

                // Notify frontend that new files are available
                let _ = _app_handle.emit("file-opened", ());
            }
        }
    });
}

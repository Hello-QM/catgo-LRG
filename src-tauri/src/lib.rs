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
// Local-PTY terminal is desktop-only; mobile gets its terminal from the future
// russh layer instead, so portable-pty (and this module) is not compiled there.
#[cfg(desktop)]
mod pty;
// SSH foundation for the future mobile HPC transport. NOT cfg-gated: russh
// compiles on every target, so this builds (and is validated) on desktop too.
mod ssh;
mod workflow_engine;

// Global state to track the Python backend process.
// Sidecars (Python/Node) are spawned only on desktop, so this is desktop-only.
#[cfg(desktop)]
struct BackendState {
    child: Option<tauri_plugin_shell::process::CommandChild>,
    /// True when we spawned the sidecar ourselves; false if backend was already running.
    spawned_by_us: bool,
}

// Global state to track the Node agent-bridge sidecar (catgo-agent).
// Separate from BackendState because the two binaries have independent
// lifecycles and the agent sidecar may be missing on older builds.
#[cfg(desktop)]
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

/// Buffer file paths from a process's argv into `OpenedFiles` and notify the
/// frontend. Powers the Windows/Linux file-association "Open with CatGo" path:
/// cold start reads `std::env::args()`; a warm start (instance already running)
/// receives the second process's argv via tauri-plugin-single-instance. macOS/iOS
/// deliver opened files through `RunEvent::Opened` instead. Gated to desktop
/// both because single-instance (its warm-start caller) is desktop-only and
/// because mobile has no argv file-association path.
#[cfg(desktop)]
fn buffer_file_args<R: tauri::Runtime, I: IntoIterator<Item = String>>(
    app: &tauri::AppHandle<R>,
    args: I,
) {
    // Skip argv[0] (the executable). Keep every remaining arg that resolves to
    // a real FILE: `is_file()` is false for CLI flags, non-existent paths, and
    // directories, so it robustly discards webview/runtime flags while still
    // accepting filenames that legitimately start with '-'. Relative paths
    // resolve against the process CWD (the OS passes absolute paths for file
    // associations).
    let raw: Vec<String> = args.into_iter().skip(1).collect();
    let paths: Vec<String> = raw
        .iter()
        .filter(|a| std::path::Path::new(a.as_str()).is_file())
        .cloned()
        .collect();
    if paths.is_empty() {
        // Surface the case where launch args were present but none resolved to a
        // file (e.g. a relative path against an unexpected CWD) so it can be
        // diagnosed instead of failing silently.
        if !raw.is_empty() {
            log::debug!("[CatGo] file-association: no openable file in argv: {:?}", raw);
        }
        return;
    }
    log::info!("[CatGo] File association opened (argv): {:?}", paths);
    if let Ok(mut state) = app.state::<Mutex<OpenedFiles>>().lock() {
        state.paths.extend(paths);
    }
    // Frontend listens for "file-opened" (warm start) and also eagerly drains
    // get_opened_files() on mount (cold start); std::mem::take makes them idempotent.
    let _ = app.emit("file-opened", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // tauri-plugin-single-instance MUST be the first plugin registered (Tauri v2).
    // When CatGo is the default app for .cif/.poscar/… and one is already running,
    // the OS launches a second process with the file path in argv; this plugin
    // forwards that argv to the running instance, which loads the file and focuses.
    // (Cold start is handled in .setup() below; macOS/iOS use RunEvent::Opened.)
    // Desktop-only: single-instance does not build on mobile (Android/iOS).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        buffer_file_args(app, argv);
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(Mutex::new(OpenedFiles { paths: Vec::new() }))
        .manage(db::DbState::default())
        .manage(workflow_engine::WorkflowEngineState::default())
        // SSH session registry — shared by ssh_connect/ssh_exec/ssh_submit_otp
        // on both desktop and mobile (the SSH module is not cfg-gated).
        .manage(ssh::SshState::default());

    // iOS only: ~30 s background grace (beginBackgroundTask) so SSH sockets and
    // pending OTP handshakes survive a quick switch to an authenticator app
    // (reading a 2FA code) instead of dying when iOS freezes the process.
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_bg_grace::init());

    // Desktop-only managed state: the Python/Node sidecars (BackendState,
    // AgentState) and the local-PTY terminal (PtyState) only exist on desktop.
    #[cfg(desktop)]
    let builder = builder
        .manage(Mutex::new(BackendState { child: None, spawned_by_us: false }))
        .manage(Mutex::new(AgentState { child: None, spawned_by_us: false }))
        .manage(pty::PtyState::default());

    // The local-PTY commands (pty_*) are desktop-only because portable-pty isn't
    // compiled on mobile. `generate_handler!` can't `cfg` individual entries, so
    // register a desktop-only handler that includes the pty_* commands and a
    // mobile handler that omits them; everything else is shared verbatim.
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
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
            // SSH transport (mobile HPC; compiled & registered on desktop too)
            ssh::auth::ssh_connect,
            ssh::exec::ssh_exec,
            ssh::otp::ssh_submit_otp,
            ssh::pty::ssh_pty_open,
            ssh::pty::ssh_pty_write,
            ssh::pty::ssh_pty_resize,
            ssh::pty::ssh_pty_close,
            // SFTP file browser (mobile HPC; compiled & registered on desktop too)
            ssh::sftp::sftp_list,
            ssh::sftp::sftp_stat,
            ssh::sftp::sftp_read,
            ssh::sftp::sftp_read_bytes,
            ssh::sftp::sftp_write,
            ssh::sftp::sftp_mkdir,
            ssh::sftp::sftp_remove,
            ssh::sftp::sftp_rename,
            // SSH-key passwordless login (keygen / install / at-rest storage)
            ssh::keygen::ssh_keygen,
            ssh::keygen::ssh_install_pubkey,
            ssh::keygen::ssh_key_store,
            ssh::keygen::ssh_key_load,
        ]);

    // Mobile handler: identical to the desktop handler above minus the local-PTY
    // commands (pty_*), which are not compiled on mobile. Keep this list in sync
    // with the desktop one for every non-pty command.
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
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
            // SSH transport (mobile HPC) — same commands as the desktop handler.
            ssh::auth::ssh_connect,
            ssh::exec::ssh_exec,
            ssh::otp::ssh_submit_otp,
            ssh::pty::ssh_pty_open,
            ssh::pty::ssh_pty_write,
            ssh::pty::ssh_pty_resize,
            ssh::pty::ssh_pty_close,
            // SFTP file browser (mobile HPC; compiled & registered on desktop too)
            ssh::sftp::sftp_list,
            ssh::sftp::sftp_stat,
            ssh::sftp::sftp_read,
            ssh::sftp::sftp_read_bytes,
            ssh::sftp::sftp_write,
            ssh::sftp::sftp_mkdir,
            ssh::sftp::sftp_remove,
            ssh::sftp::sftp_rename,
            // SSH-key passwordless login (keygen / install / at-rest storage)
            ssh::keygen::ssh_keygen,
            ssh::keygen::ssh_install_pubkey,
            ssh::keygen::ssh_key_store,
            ssh::keygen::ssh_key_load,
        ]);

    let app = builder
        .setup(|app| {
            // Enable logging in desktop builds
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            // Cold-start file-association launch (Windows/Linux): the first process
            // receives the opened file path in its own argv. Buffer it so the
            // frontend's drain_opened_files() loads it on mount. (macOS/iOS deliver
            // this via RunEvent::Opened.) Desktop-only: buffer_file_args isn't
            // compiled on mobile.
            #[cfg(desktop)]
            buffer_file_args(app.handle(), std::env::args());

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

            // Sidecar machinery (Python backend + Node agent bridge) is
            // desktop-only: tauri-plugin-shell sidecars and the BackendState/
            // AgentState managed state don't exist on mobile. Mobile reaches a
            // remote backend over the network instead.
            #[cfg(desktop)]
            {
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
                            .env("PATH", &augmented_path)
                            // Force IPv4-first DNS so Node's `fetch` (undici)
                            // doesn't stall on hosts whose IPv6 path is broken
                            // — symptom: CatBot workflow generation freezes
                            // ~50% of the time on certain lab / corp networks.
                            // Harmless on healthy networks.
                            .env("NODE_OPTIONS", "--dns-result-order=ipv4first")
                            .env("BUN_DNS_ORDER", "ipv4first");
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
            } // end #[cfg(desktop)] sidecar block

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Only exit the app when the main window is closed;
                // secondary windows (chat popout, workflow, terminal) just close themselves.
                if window.label() != "main" {
                    return;
                }

                // Sidecar + local-PTY cleanup is desktop-only (those managed
                // states only exist on desktop).
                #[cfg(desktop)]
                {
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
                }

                // Cancel all running workflows
                let engine_state = window.state::<workflow_engine::WorkflowEngineState>();
                engine_state.cancel_all();

                // Kill all PTY sessions (desktop-only — portable-pty isn't on mobile)
                #[cfg(desktop)]
                {
                    let pty_state = window.state::<pty::PtyState>();
                    pty_state.kill_all();
                }

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

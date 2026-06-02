//! russh client `Handler` — server-key verification (persistent TOFU pinning).
//!
//! From the spike: the `Handler` trait uses native `async fn` (RPITIT), NOT
//! `#[async_trait]`, and `check_server_key` takes `&russh::keys::ssh_key::PublicKey`.
//! The *default* `check_server_key` REJECTS ALL keys (`Ok(false)`), so silence
//! means "connection refused". We MUST override it.
//!
//! TOFU (Trust-On-First-Use) policy — mobile has no `~/.ssh/known_hosts`, so we
//! own the store: a JSON map `{host}:{port} -> fingerprint` under the app data
//! dir (0600 on Unix).
//!   * first-seen  -> persist the fingerprint, accept (`Ok(true)`).
//!   * known match -> accept (`Ok(true)`).
//!   * MISMATCH    -> REJECT (`Ok(false)`) and flag it (possible MITM); the
//!                    connection then fails and `ssh_connect` surfaces a clear
//!                    "host key changed" message.
//! Store-IO errors never block a connection (treated as empty / best-effort
//! persist); only a genuine fingerprint mismatch refuses the key.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh::keys::ssh_key;

/// SSH client handler implementing persistent Trust-On-First-Use server-key
/// pinning. One instance per connection attempt; captures the endpoint so the
/// pinned-key lookup can be keyed by `{host}:{port}`.
pub struct MobileHandler {
    pub host: String,
    pub port: u16,
    /// Path to the per-app pinned-key store (JSON `{endpoint -> fingerprint}`).
    pin_store: PathBuf,
    /// Set to `true` when the offered key did NOT match the pinned one, so
    /// `ssh_connect` can distinguish a MITM/host-key-change from a generic
    /// connection failure.
    pub key_mismatch: Arc<AtomicBool>,
}

impl MobileHandler {
    pub fn new(
        host: String,
        port: u16,
        pin_store: PathBuf,
        key_mismatch: Arc<AtomicBool>,
    ) -> Self {
        Self { host, port, pin_store, key_mismatch }
    }
}

/// Read the pin store; a missing/unreadable/corrupt file yields an empty map so
/// the first connection is treated as first-use rather than failing.
fn load_pins(path: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist the pin store (best-effort, 0600 on Unix). Errors are logged, never
/// propagated — a failed persist must not block the connection.
fn save_pins(path: &Path, pins: &HashMap<String, String>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(pins) {
        Ok(json) => {
            if let Err(e) = std::fs::write(path, json) {
                log::warn!("[CatGo SSH] could not persist host-key pin store: {e}");
                return;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            }
        }
        Err(e) => log::warn!("[CatGo SSH] could not serialize host-key pin store: {e}"),
    }
}

impl russh::client::Handler for MobileHandler {
    // Reuse russh's own error so `?` works without a custom conversion.
    type Error = russh::Error;

    // NOTE: native `async fn` — do NOT add `#[async_trait]` (RPITIT trait).
    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let endpoint = format!("{}:{}", self.host, self.port);
        let fingerprint = server_public_key.fingerprint(Default::default()).to_string();

        let mut pins = load_pins(&self.pin_store);
        match pins.get(&endpoint) {
            // Known host, key matches the pin → trust.
            Some(pinned) if *pinned == fingerprint => Ok(true),
            // Known host, key CHANGED → refuse (possible MITM). Flag it so the
            // caller can surface a clear message instead of a generic failure.
            Some(pinned) => {
                self.key_mismatch.store(true, Ordering::SeqCst);
                log::error!(
                    "[CatGo SSH] HOST KEY MISMATCH for {endpoint}: pinned {pinned}, offered \
                     {fingerprint} — refusing (possible MITM)"
                );
                Ok(false)
            }
            // First sight → pin it and trust (Trust-On-First-Use).
            None => {
                pins.insert(endpoint.clone(), fingerprint.clone());
                save_pins(&self.pin_store, &pins);
                log::info!("[CatGo SSH] pinned new host key for {endpoint}: {fingerprint}");
                Ok(true)
            }
        }
    }
}

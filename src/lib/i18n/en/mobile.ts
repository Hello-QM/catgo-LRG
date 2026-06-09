/**
 * English — mobile UI strings (src/lib/mobile/*).
 *
 * Covers the purpose-built mobile workspace: entry chooser, top action bar,
 * SSH connect form, OTP dialog, SSH-key onboarding, remote file browser, and
 * the read-only file viewer.  Lazy-loaded via `load_i18n_module('mobile')`.
 */

const mobile: Record<string, string> = {
  // ── Entry chooser (MobileWorkspace) ──────────────────────────────────
  choose_prompt:          `What do you want to do?`,
  choice_structure_main:  `View / edit a structure`,
  choice_structure_desc:  `Open a local file — no cluster needed`,
  choice_database_main:   `Import from a database`,
  choice_database_desc:   `Search OPTIMADE / Materials Project / PubChem`,
  choice_connect_main:    `Connect to cluster`,
  choice_connect_desc:    `SSH terminal + remote files`,
  connect_app_only:       `Open the CatGo app to use the terminal — the browser can't open SSH`,

  // ── Top bar (MobileWorkspace) ────────────────────────────────────────
  tab_structure:          `Structure`,
  tab_split_stacked:      `Split (stacked)`,
  tab_split_side:         `Split (side by side)`,
  tab_terminal:           `Terminal`,
  action_remote_files:    `Remote files`,
  action_open_local:      `Open local file`,
  action_import_database: `Import from database`,
  action_save_structure:  `Save structure`,
  action_disconnect:      `Disconnect`,
  // Short labels shown under the top-bar action icons (keep them ~8 chars).
  action_remote_files_short:    `Files`,
  action_open_local_short:      `Open`,
  action_import_database_short: `Database`,
  action_save_structure_short:  `Save`,
  action_disconnect_short:      `Leave`,

  // ── Structure pane (MobileWorkspace) ─────────────────────────────────
  no_structure_loaded:    `No structure loaded.`,
  open_local_file:        `Open local file`,
  open_from_cluster:      `Open from cluster`,

  // ── Save / notices (MobileWorkspace) ─────────────────────────────────
  could_not_parse:        `Could not parse {filename} as a structure.`,
  saved_to:               `Saved to {path}`,
  save_failed_reason:     `Save failed: {reason}`,
  downloaded:             `Downloaded {filename}`,
  remote_files_title:     `Remote files`,

  // ── Connect form (MobileConnect) ─────────────────────────────────────
  connect_title:          `Connect to cluster`,
  saved_label:            `Saved`,
  new_connection:         `+ New`,
  remove_saved_connection: `Remove saved connection`,
  field_name:             `Name (optional)`,
  field_name_placeholder: `Expanse`,
  field_host:             `Host`,
  field_host_placeholder: `login.cluster.edu`,
  field_port:             `Port`,
  field_username:         `Username`,
  field_auth_method:      `Auth method`,
  method_password:        `Password`,
  method_publickey:       `Public key`,
  method_keyboard:        `Keyboard-interactive`,
  field_password:         `Password`,
  field_private_key_path: `Private key path`,
  field_passphrase:       `Passphrase (optional)`,
  keyboard_hint:          `You'll be prompted for any codes after connecting.`,
  use_jump_host:          `Use a jump host (ProxyJump)`,
  connecting:             `Connecting…`,
  connect_action:         `Connect`,
  connection_failed:      `Connection failed.`,
  saved_pw_rejected:      `Saved password was rejected — it may have changed. Enter it again to reconnect.`,
  auth_cancelled:         `Authentication cancelled.`,

  // ── Save-password prompt (MobileConnect) ─────────────────────────────
  save_pw_title:          `Save password for this cluster?`,
  save_pw_body:           `Next time you connect to {user} you'll only need the one-time passcode (OTP). The password is encrypted on this device.`,
  save_pw_not_now:        `Not now`,
  save_pw_save:           `Save password`,
  save_pw_retry:          `Retry`,
  save_pw_failed:         `Couldn't save the password — it wasn't stored. Retry, or continue and enter it next time.`,

  // ── OTP dialog (OtpDialog) ───────────────────────────────────────────
  otp_title:              `Verification required`,
  otp_cancel:             `Cancel`,
  otp_submit:             `Submit`,
  otp_submitting:         `Submitting…`,

  // ── Passwordless onboarding (KeySetup) ───────────────────────────────
  ks_aria:                `Set up passwordless login`,
  ks_title:               `Set up passwordless login?`,
  ks_body:                `Generate an SSH key on this device and install it on {user}. Future connects can use the key instead of a password. The private key is generated on-device and stored encrypted — it never leaves your phone unprotected.`,
  ks_generating:          `Generating a key on this device…`,
  ks_installing:          `Installing the public key on {host}…`,
  ks_storing:             `Securing the private key on this device…`,
  ks_done:                `Passwordless login is set up.`,
  ks_close:               `Close`,
  ks_not_now:             `Not now`,
  ks_try_again:           `Try again`,
  ks_working:             `Working…`,
  ks_set_up:              `Set up`,

  // ── File browser (MobileFiles) ───────────────────────────────────────
  loading:                `Loading…`,
  empty_directory:        `Empty directory`,
  parent:                 `parent`,
  path_placeholder:       `Go to path…  /home/{user}/project`,
  go:                     `Go`,
  aria_path:              `Path`,
  aria_refresh:           `Refresh`,

  // ── File viewer (MobileFileViewer) ───────────────────────────────────
  back:                   `Back`,
  back_to_files:          `Back to files`,
  binary_file:            `Binary file`,
  binary_note:            `{size} — not shown (non-text or too large to preview).`,
  truncated_note:         `Showing the first {size} — file is larger and was truncated.`,
  save:                   `Save`,
  saving:                 `Saving…`,
  saved:                  `Saved`,
  save_failed:            `Save failed`,

  // ── Terminal tabs ("Terminals" panel, MobileWorkspace) ───────────────
  term_panel:             `Terminals`,
  term_label:             `Terminal {n}`,
  term_new:               `New terminal`,
  term_close:             `Close terminal`,
  term_edit:              `Edit terminals`,

  // ── AI chat (MobileChat / MobileChatSetup) ───────────────────────────
  action_ai:              `AI assistant`,
  action_ai_short:        `AI`,
  ai_title:               `AI`,
  ai_provider:            `Provider`,
  ai_setup:               `AI setup`,
  ai_api_key:             `API key`,
  ai_api_key_placeholder: `Paste your API key`,
  ai_base_url:            `Base URL`,
  ai_base_url_placeholder: `https://host/v1`,
  ai_model:               `Model (optional)`,
  ai_save:                `Save`,
  ai_saving:              `Saving…`,
  ai_send:                `Send`,
  ai_new_chat:            `New chat`,
  ai_minimize:            `Minimize`,
  ai_close_chat:          `Close chat`,
  ai_stop:                `Stop`,
  ai_thinking:            `Thinking…`,
  ai_empty:               `Ask me anything about your structure or research.`,
  ai_no_key:              `Add an API key to start chatting.`,
  ai_invalid_key:         `API key is invalid. Check your key in AI setup.`,
  ai_rate_limited:        `Rate limit reached — the free tier allows only a few messages per minute. Wait a few seconds and resend, or pick a higher-limit model in settings.`,
  ai_model_busy:          `The model is busy right now (high demand) — usually temporary. Wait a moment and resend, or try a different model in settings.`,
  ai_message_placeholder: `Type a message…`,
}

export default mobile

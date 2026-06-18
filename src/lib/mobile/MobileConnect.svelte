<!--
  MobileConnect.svelte — SSH/HPC connect form for the mobile (tauri-ssh)
  transport.

  Collects host / port / username / auth-method (+ password or key path), then
  drives `transport.connect(...)`. If the server requires keyboard-interactive
  2FA (`needsOtp`), it shows {@link OtpDialog} and loops
  `transport.submitOtp(pendingId, responses)`:

    - a `Success` reply ends the loop and emits `session_id` to the parent;
    - an `InfoRequest` reply (another `needsOtp` with a fresh `pendingId` /
      `prompts`) re-shows the dialog for the next round (true multi-round 2FA).

  Persists the last host / username / method / port in localStorage as a
  convenience. NEVER persists passwords, passphrases, or OTP answers.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { transport, type HpcAuthMethod, type OtpPrompt } from '$lib/api/transport'
  import OtpDialog from './OtpDialog.svelte'
  import {
    loadConnections,
    upsertConnection,
    removeConnection,
    connectionLabel,
    type SavedConnection,
  } from './connections'
  import { endpointKey, reuseSession, rememberSession } from './sessions'
  import { clusters } from './clusters.svelte'
  import { t } from '$lib/i18n/index.svelte'
  import { pick_hpc_key_file } from '$lib/hpc-key-file'

  export interface ConnectedMeta {
    host: string
    port: number
    username: string
    /** Saved nickname if set, else `user@host`. */
    label: string
  }

  interface Props {
    /** Emitted with the live session id once authentication completes. */
    on_connected?: (session_id: string, meta: ConnectedMeta) => void
    /** Disconnect one live cluster (endpoint key) — owned by the workspace. */
    on_eject?: (key: string) => void
    /** When set (by the workspace on resume after a lock dropped the session),
     * auto-fill from this saved connection and reconnect once — reusing saved
     * creds (silent if OTP-free; surfaces OtpDialog otherwise). */
    auto_reconnect?: SavedConnection | null
    /** Called when an auto-reconnect attempt fails/cancels, so the workspace can
     * clear its `reconnect_target` (else it would re-trigger on a later mount). */
    on_reconnect_failed?: () => void
  }

  let { on_connected, on_eject, auto_reconnect, on_reconnect_failed }: Props = $props()

  function connected_meta(): ConnectedMeta {
    const h = host.trim()
    const u = username.trim()
    return {
      host: h,
      port,
      username: u,
      label: label.trim() || (port === 22 ? `${u}@${h}` : `${u}@${h}:${port}`),
    }
  }

  // ─── Saved (non-secret) connections ───
  let saved = $state<SavedConnection[]>([])

  // ─── Form state ───
  let label = $state(``)
  let host = $state(``)
  let port = $state(22)
  let username = $state(``)
  let method = $state<HpcAuthMethod>(`password`)
  let password = $state(``)
  let key_path = $state(``)
  let key_content = $state(``)
  let key_selected_name = $state(``)
  let passphrase = $state(``)

  // Optional jump host (ProxyJump / bastion). When `jump_enabled`, the jump host
  // is authenticated first, then a tunnel carries the target handshake. The jump
  // host has its own independent auth method (incl. its own OTP).
  let jump_enabled = $state(false)
  let jump_host = $state(``)
  let jump_port = $state(22)
  let jump_username = $state(``)
  let jump_method = $state<HpcAuthMethod>(`password`)
  let jump_password = $state(``)
  let jump_key_path = $state(``)
  let jump_key_content = $state(``)
  let jump_key_selected_name = $state(``)
  let jump_passphrase = $state(``)

  // ─── Flow state ───
  let connecting = $state(false)
  let error_msg = $state(``)

  // ─── OTP round state ───
  let otp_visible = $state(false)
  let otp_busy = $state(false)
  let otp_pending_id = $state(``)
  let otp_prompts = $state<OtpPrompt[]>([])
  let otp_instructions = $state(``)
  // Pre-filled answers for the current OTP round (index-aligned with
  // otp_prompts) — used to seed password prompt(s) from a saved password in a
  // mixed password+2FA round, so the user only types the OTP.
  let otp_prefill = $state<string[]>([])

  // ─── Saved-password / OTP-only reconnect ───
  // A password loaded from the encrypted store for the picked connection; when a
  // password prompt arrives it is auto-answered so the user only types the OTP.
  let auto_password = $state(``)
  // Whether THIS connect used a saved password (so we don't re-offer to save it).
  let used_saved_pw = false
  // The password actually used this connect (form value or a keyboard-interactive
  // response), captured so we can offer to persist it after success.
  let captured_password = ``
  // Post-success "save password?" prompt, parked until the user decides so we
  // stay mounted (calling on_connected swaps us out).
  let save_prompt_visible = $state(false)
  // Shown inside the save-password dialog when the encrypted store write fails,
  // so a failed save isn't silently swallowed (the dialog offers Retry).
  let save_error = $state(``)
  let pending_session = ``
  let pending_pw = ``

  /** Per-endpoint key for the encrypted password store (no method in the key —
   * the password is the same regardless of the method tried). */
  function endpoint_pw_key(): string {
    return `pw:${host.trim()}:${port}:${username.trim()}`
  }

  /** A prompt that asks for the account PASSWORD (not the 2FA passcode). */
  function is_password_prompt(p: OtpPrompt): boolean {
    return (
      !p.echo &&
      /pass\s*word/i.test(p.prompt) &&
      !/duo|passcode|one.?time|\botp\b|verification|token/i.test(p.prompt)
    )
  }

  // Prefill the form from the most-recent saved connection — but ONLY on first
  // mount. `untrack` + the `did_prefill` guard stop the effect from depending on
  // `host`; otherwise clearing the form (the "+ New" button) would set host=``,
  // re-run the effect, and immediately refill it (New appears to do nothing).
  let did_prefill = false
  $effect(() => {
    const list = loadConnections()
    saved = list
    untrack(() => {
      if (did_prefill) return
      did_prefill = true
      const recent = list[0]
      if (!recent || host) return
      label = recent.label ?? ``
      host = recent.host
      port = recent.port
      username = recent.username
      method = recent.method
      if (recent.keyPath) key_path = recent.keyPath
    })
  })

  // Auto-reconnect (workspace resumed after a lock killed the session): pre-fill
  // from the saved connection and run connect(). Reuses all the existing
  // saved-password / OTP machinery — silent when the round is OTP-free, OtpDialog
  // when a live passcode is needed.
  let auto_reconnecting = $state(false)
  // The target we've already kicked off, by IDENTITY. Each reconnect produces a
  // fresh SavedConnection object (loadConnections() returns new objects), so a
  // NEW target re-fires — but the same one won't loop. Resetting per-target also
  // clears `reconnect_fail_notified` so a later failure can notify again (else,
  // after the first failure, reconnect_target would stay stuck non-null).
  let handled_reconnect: SavedConnection | null = null
  // Notified the workspace once an auto-reconnect settled into a FAILED state
  // (so it drops `reconnect_target`); reset per new target above.
  let reconnect_fail_notified = false
  $effect(() => {
    const tgt = auto_reconnect
    if (!tgt || tgt === handled_reconnect || connecting || auto_reconnecting) return
    handled_reconnect = tgt
    reconnect_fail_notified = false
    auto_reconnecting = true
    pick_saved(tgt)
    void connect().finally(() => {
      auto_reconnecting = false
    })
  })

  // Tell the workspace to drop its `reconnect_target` once an auto-reconnect has
  // settled into a FAILED state (error shown, not connecting, no OTP pending) —
  // otherwise the stale target would re-trigger on a later mount.
  $effect(() => {
    if (
      auto_reconnect && !auto_reconnecting && !connecting && !otp_visible &&
      error_msg && !reconnect_fail_notified
    ) {
      reconnect_fail_notified = true
      on_reconnect_failed?.()
    }
  })

  /** Fill the form from a saved connection (tap-to-reconnect), and load its
   * stored password (if any) so the reconnect only needs the OTP. */
  function pick_saved(c: SavedConnection): void {
    label = c.label ?? ``
    host = c.host
    port = c.port
    username = c.username
    method = c.method
    key_path = c.keyPath ?? ``
    key_content = ``
    key_selected_name = ``
    password = `` // reset; filled (masked) from the store below for password auth
    error_msg = ``
    auto_password = ``
    transport
      .keyLoad(`pw:${c.host}:${c.port}:${c.username}`)
      .then((pw) => {
        if (pw) {
          auto_password = pw
          // Show the saved password (masked ••••) so the user sees it's stored
          // and can just tap Connect. keyboard-interactive has no password field
          // — it uses auto_password to answer the prompt round instead.
          if (c.method === `password`) password = pw
        }
      })
      .catch(() => {
        /* no stored password / desktop transport — type it manually */
      })
  }

  /** Clear the form to enter a brand-new cluster (the form otherwise prefills
   * from the most-recent saved connection). */
  function new_connection(): void {
    label = ``
    host = ``
    port = 22
    username = ``
    method = `keyboard-interactive`
    key_path = ``
    key_content = ``
    key_selected_name = ``
    password = ``
    passphrase = ``
    auto_password = ``
    error_msg = ``
  }

  /** Delete a saved connection (does not touch any stored key material). */
  function delete_saved(id: string, e: Event): void {
    e.stopPropagation()
    saved = removeConnection(id)
  }

  function persist_non_secrets(): void {
    // Trim host/username so the saved descriptor matches the password key
    // (endpoint_pw_key also trims) — otherwise a stray space means pick_saved's
    // keyLoad looks under a different key than the password was stored at.
    saved = upsertConnection(
      {
        host: host.trim(),
        port,
        username: username.trim(),
        method,
        keyPath: key_path,
        label,
      },
      Date.now(),
    )
  }

  async function choose_key_file(kind: `target` | `jump`): Promise<void> {
    const selected = await pick_hpc_key_file()
    if (!selected) return
    if (kind === `jump`) {
      jump_key_selected_name = selected.name
      if (selected.path) {
        jump_key_path = selected.path
        jump_key_content = ``
      } else if (selected.content) {
        jump_key_path = selected.name
        jump_key_content = selected.content
      }
      return
    }
    key_selected_name = selected.name
    if (selected.path) {
      key_path = selected.path
      key_content = ``
    } else if (selected.content) {
      key_path = selected.name
      key_content = selected.content
    }
  }

  /** Apply a connect / submitOtp result: succeed, advance OTP round, or error. */
  function apply_result(r: {
    connected: boolean
    sessionId: string
    needsOtp: boolean
    message: string
    pendingId: string
    prompts: OtpPrompt[]
    instructions: string
  }): void {
    if (r.needsOtp) {
      otp_pending_id = r.pendingId
      otp_prompts = r.prompts
      otp_instructions = r.instructions
      otp_prefill = []
      // Saved-password reconnect: answer the account-password prompt(s) from the
      // stored password. If the WHOLE round is password prompts, submit silently
      // (OTP-only reconnect). If it's MIXED (password + a Duo/OTP passcode),
      // surface the dialog with the password field(s) pre-filled so the user
      // only types the 2FA code — works regardless of how many prompts the
      // server bundles together.
      if (auto_password && r.prompts.some(is_password_prompt)) {
        used_saved_pw = true
        const pw = auto_password
        if (r.prompts.every(is_password_prompt)) {
          auto_password = `` // consumed
          void submit_otp(r.prompts.map(() => pw))
          return
        }
        // Mixed round: seed password prompts, leave OTP prompts blank. Keep
        // auto_password in case a later round re-prompts for the password.
        otp_prefill = r.prompts.map((p) => (is_password_prompt(p) ? pw : ``))
      }
      otp_visible = true
      otp_busy = false
      return
    }
    if (r.connected && r.sessionId) {
      otp_visible = false
      otp_busy = false
      persist_non_secrets()
      // Register the live session so a later reconnect to this endpoint reuses it.
      rememberSession(endpointKey(host.trim(), port, username.trim()), r.sessionId)
      // Offer to save the password (once) so the next reconnect is OTP-only.
      // Park until the user decides — calling on_connected swaps us out.
      if (captured_password && !used_saved_pw) {
        pending_session = r.sessionId
        pending_pw = captured_password
        captured_password = ``
        save_error = ``
        save_prompt_visible = true
        return
      }
      on_connected?.(r.sessionId, connected_meta())
      return
    }
    // Not connected and no OTP round => authentication failed / refused.
    otp_visible = false
    otp_busy = false
    error_msg = r.message || t(`mobile.connection_failed`)
    // If THIS attempt used a saved password and it was rejected, it's probably
    // stale (changed on the server). Clear it — in-memory AND from the encrypted
    // store (overwrite empty; there's no delete command, and an empty value
    // reads back as "no saved password") — so the next attempt prompts fresh
    // instead of silently re-submitting the wrong one (esp. the keyboard-
    // interactive auto-answer path, which the user can't otherwise interrupt).
    if (used_saved_pw) {
      auto_password = ``
      used_saved_pw = false
      transport.keyStore(endpoint_pw_key(), ``).catch(() => {/* best-effort */})
      error_msg = t(`mobile.saved_pw_rejected`)
    }
  }

  async function connect(): Promise<void> {
    if (connecting) return
    error_msg = ``
    connecting = true
    used_saved_pw = false
    captured_password = method === `password` ? password : ``
    // ControlMaster-style reuse: if a still-live session exists for this
    // endpoint, reuse it (no re-auth / no OTP) instead of connecting again.
    try {
      const reused = await reuseSession(endpointKey(host.trim(), port, username.trim()))
      if (reused) {
        persist_non_secrets()
        connecting = false
        on_connected?.(reused, connected_meta())
        return
      }
    } catch {
      /* fall through to a fresh connect */
    }
    // Load a saved password for THIS endpoint if we don't already have one (so a
    // manually-filled form benefits too, not just a saved-list tap).
    if (!auto_password) {
      try {
        const pw = await transport.keyLoad(endpoint_pw_key())
        if (pw) auto_password = pw
      } catch {
        /* no stored password / desktop transport */
      }
    }
    // password method: apply the saved password to the form value that connect()
    // sends below. This MUST run whether auto_password came from a saved-list tap
    // (pick_saved pre-loads it) or the keyLoad just above. The old code only set
    // `password` INSIDE the `if (!auto_password)` block, so tapping a saved
    // connection (which pre-loads auto_password) skipped it → an empty password
    // was sent → "Password authentication rejected". keyboard-interactive instead
    // uses auto_password to answer the prompt round (see apply_result).
    if (method === `password` && !password && auto_password) {
      password = auto_password
    }
    // If we're about to send EXACTLY the saved password (the user didn't edit the
    // pre-filled field), mark it so apply_result doesn't redundantly re-offer to
    // save it. If they edited it to a new value, this stays false → we offer to
    // save the new one.
    if (method === `password` && auto_password && password === auto_password) {
      used_saved_pw = true
    }
    try {
      const r = await transport.connect({
        host: host.trim(),
        port,
        username: username.trim(),
        method,
        password: method === `password` ? password : undefined,
        keyPath: method === `publickey` ? key_path.trim() || undefined : undefined,
        keyContent: method === `publickey` ? key_content || undefined : undefined,
        passphrase: method === `publickey` ? passphrase || undefined : undefined,
        jump: jump_enabled && jump_host.trim()
          ? {
              host: jump_host.trim(),
              port: jump_port,
              username: jump_username.trim(),
              method: jump_method,
              password: jump_method === `password` ? jump_password : undefined,
              keyPath: jump_method === `publickey` ? jump_key_path.trim() || undefined : undefined,
              keyContent: jump_method === `publickey` ? jump_key_content || undefined : undefined,
              passphrase: jump_method === `publickey` ? jump_passphrase || undefined : undefined,
            }
          : undefined,
      })
      apply_result(r)
    } catch (e: unknown) {
      error_msg = e instanceof Error ? e.message : String(e)
      otp_visible = false
    } finally {
      connecting = false
      // Drop the in-memory password as soon as the round-trip completes; OTP
      // rounds (if any) no longer need it.
      password = ``
      passphrase = ``
    }
  }

  /** One OTP round: submit answers, then loop on a follow-up InfoRequest. */
  async function submit_otp(responses: string[]): Promise<void> {
    otp_busy = true
    error_msg = ``
    // Remember the response to a password prompt so we can offer to save it.
    otp_prompts.forEach((p, i) => {
      if (is_password_prompt(p) && responses[i]) captured_password = responses[i]
    })
    try {
      const r = await transport.submitOtp(otp_pending_id, responses)
      apply_result(r)
    } catch (e: unknown) {
      error_msg = e instanceof Error ? e.message : String(e)
      otp_visible = false
      otp_busy = false
    }
  }

  function cancel_otp(): void {
    otp_visible = false
    otp_busy = false
    otp_pending_id = ``
    otp_prompts = []
    otp_instructions = ``
    error_msg = t(`mobile.auth_cancelled`)
  }

  function finish_connect(): void {
    save_prompt_visible = false
    save_error = ``
    const id = pending_session
    pending_session = ``
    pending_pw = ``
    on_connected?.(id, connected_meta())
  }

  /** Save the password (encrypted) for OTP-only reconnect, then continue. */
  async function save_password_yes(): Promise<void> {
    save_error = ``
    try {
      await transport.keyStore(endpoint_pw_key(), pending_pw)
    } catch {
      // The user explicitly chose to save — don't pretend it worked (that would
      // silently re-create the "empty password on reconnect → rejected" bug).
      // Surface it and keep the dialog so they can retry or continue without it.
      save_error = t(`mobile.save_pw_failed`)
      return
    }
    finish_connect()
  }

  const can_submit = $derived(
    host.trim().length > 0 &&
      username.trim().length > 0 &&
      (method !== `publickey` || key_path.trim().length > 0 || key_content.length > 0) &&
      (!jump_enabled || jump_method !== `publickey` || jump_key_path.trim().length > 0 || jump_key_content.length > 0) &&
      !connecting,
  )
</script>

<div class="connect-wrap">
  <div class="connect-card">
    <div class="connect-title">{t(`mobile.connect_title`)}</div>

    {#if auto_reconnect && (auto_reconnecting || connecting || otp_visible)}
      <div class="reconnect-banner" role="status">
        {t(`mobile.reconnecting_to`, { target: connectionLabel(auto_reconnect) })}
      </div>
    {/if}

    {#if clusters.list.length > 0}
      <!-- Clusters the user is logged into RIGHT NOW. Tap = make it the active
           one (instant — the session is already authenticated); ⏏ = disconnect
           just that cluster. Connecting a new cluster below does NOT drop these. -->
      <div class="live-list">
        <div class="saved-head">
          <span class="saved-label">{t(`mobile.connected_label`)}</span>
        </div>
        {#each clusters.list as c (c.key)}
          <div class="live-row" class:active={c.key === clusters.active_key}>
            <button
              type="button"
              class="live-pick"
              onclick={() =>
                on_connected?.(c.session_id, {
                  host: c.host,
                  port: c.port,
                  username: c.username,
                  label: c.label,
                })}
            >
              <span class="live-dot" aria-hidden="true"></span>
              <span class="live-name">{c.label}</span>
              {#if c.key === clusters.active_key}
                <span class="live-current">{t(`mobile.connected_current`)}</span>
              {/if}
            </button>
            <button
              type="button"
              class="live-eject"
              title={t(`mobile.connected_eject`)}
              aria-label={t(`mobile.connected_eject`)}
              onclick={() => on_eject?.(c.key)}
            >⏏</button>
          </div>
        {/each}
      </div>
    {/if}

    {#if saved.length > 0}
      <div class="saved-list">
        <div class="saved-head">
          <span class="saved-label">{t(`mobile.saved_label`)}</span>
          <button type="button" class="saved-new" onclick={new_connection}>{t(`mobile.new_connection`)}</button>
        </div>
        {#each saved as c (c.id)}
          <div
            class="saved-row"
            role="button"
            tabindex="0"
            onclick={() => pick_saved(c)}
            onkeydown={(e) => {
              if (e.key === `Enter` || e.key === ` `) {
                e.preventDefault()
                pick_saved(c)
              }
            }}
          >
            <span class="saved-main">{connectionLabel(c)}</span>
            <span class="saved-method">{c.method}</span>
            <button
              type="button"
              class="saved-del"
              aria-label={t(`mobile.remove_saved_connection`)}
              onclick={(e) => delete_saved(c.id, e)}
            >
              ✕
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <form
      class="connect-form"
      onsubmit={(e) => {
        e.preventDefault()
        if (can_submit) connect()
      }}
    >
      <label class="field name-field">
        <span>{t(`mobile.field_name`)}</span>
        <input
          type="text"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder={t(`mobile.field_name_placeholder`)}
          bind:value={label}
        />
      </label>

      <label class="field host-field">
        <span>{t(`mobile.field_host`)}</span>
        <input
          type="text"
          inputmode="url"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder={t(`mobile.field_host_placeholder`)}
          bind:value={host}
        />
      </label>

      <label class="field port-field">
        <span>{t(`mobile.field_port`)}</span>
        <input type="number" min="1" max="65535" bind:value={port} />
      </label>

      <label class="field user-field">
        <span>{t(`mobile.field_username`)}</span>
        <input
          type="text"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          bind:value={username}
        />
      </label>

      <label class="field method-field">
        <span>{t(`mobile.field_auth_method`)}</span>
        <select bind:value={method}>
          <option value="password">{t(`mobile.method_password`)}</option>
          <option value="publickey">{t(`mobile.method_publickey`)}</option>
          <option value="keyboard-interactive">{t(`mobile.method_keyboard`)}</option>
        </select>
      </label>

      {#if method === `password`}
        <label class="field">
          <span>{t(`mobile.field_password`)}</span>
          <input
            type="password"
            autocomplete="current-password"
            bind:value={password}
          />
        </label>
      {:else if method === `publickey`}
        <label class="field">
          <span>{t(`mobile.field_private_key_path`)}</span>
          <div class="key-file-row">
            <input
              type="text"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="~/.ssh/id_ed25519"
              bind:value={key_path}
              oninput={() => { key_content = ``; key_selected_name = `` }}
            />
            <button type="button" class="key-file-btn" onclick={() => choose_key_file(`target`)}>{t(`common.choose`)}</button>
          </div>
          {#if key_content && key_selected_name}
            <small>{t(`mobile.key_file_imported`, { name: key_selected_name })}</small>
          {/if}
        </label>
        <label class="field">
          <span>{t(`mobile.field_passphrase`)}</span>
          <input type="password" autocomplete="off" bind:value={passphrase} />
        </label>
      {:else}
        <div class="method-hint">
          {t(`mobile.keyboard_hint`)}
        </div>
      {/if}

      <!-- Optional jump host (ProxyJump / bastion) -->
      <label class="field jump-toggle">
        <input type="checkbox" bind:checked={jump_enabled} />
        <span>{t(`mobile.use_jump_host`)}</span>
      </label>

      {#if jump_enabled}
        <div class="jump-section">
          <label class="field">
            <span>{t(`mobile.field_host`)}</span>
            <input
              type="text"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="bastion.example.edu"
              bind:value={jump_host}
            />
          </label>
          <label class="field">
            <span>{t(`mobile.field_port`)}</span>
            <input type="number" min="1" max="65535" bind:value={jump_port} />
          </label>
          <label class="field">
            <span>{t(`mobile.field_username`)}</span>
            <input
              type="text"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              bind:value={jump_username}
            />
          </label>
          <label class="field">
            <span>{t(`mobile.field_auth_method`)}</span>
            <select bind:value={jump_method}>
              <option value="password">{t(`mobile.method_password`)}</option>
              <option value="publickey">{t(`mobile.method_publickey`)}</option>
              <option value="keyboard-interactive">{t(`mobile.method_keyboard`)}</option>
            </select>
          </label>
          {#if jump_method === `password`}
            <label class="field">
              <span>{t(`mobile.field_password`)}</span>
              <input type="password" autocomplete="off" bind:value={jump_password} />
            </label>
          {:else if jump_method === `publickey`}
            <label class="field">
              <span>{t(`mobile.field_private_key_path`)}</span>
              <div class="key-file-row">
                <input
                  type="text"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  placeholder="~/.ssh/id_ed25519"
                  bind:value={jump_key_path}
                  oninput={() => { jump_key_content = ``; jump_key_selected_name = `` }}
                />
                <button type="button" class="key-file-btn" onclick={() => choose_key_file(`jump`)}>{t(`common.choose`)}</button>
              </div>
              {#if jump_key_content && jump_key_selected_name}
                <small>{t(`mobile.key_file_imported`, { name: jump_key_selected_name })}</small>
              {/if}
            </label>
            <label class="field">
              <span>{t(`mobile.field_passphrase`)}</span>
              <input type="password" autocomplete="off" bind:value={jump_passphrase} />
            </label>
          {:else}
            <div class="method-hint">{t(`mobile.keyboard_hint`)}</div>
          {/if}
        </div>
      {/if}

      {#if error_msg}
        <div class="connect-error" role="alert">{error_msg}</div>
      {/if}

      <button type="submit" class="connect-btn" disabled={!can_submit}>
        {connecting ? t(`mobile.connecting`) : t(`mobile.connect_action`)}
      </button>
    </form>
  </div>
</div>

{#if auto_reconnect && (auto_reconnecting || connecting || otp_visible) && !error_msg}
  <!-- Clean "reconnecting" screen that COVERS the connect form during an
       auto-reconnect, so a dropped session doesn't flash the whole setup UI —
       it just shows progress. Below the OTP dialog's z-index (1000) so a 2FA
       prompt still pops over it. On failure, error_msg unhides the form so the
       user can fix it manually. -->
  <div class="reconnect-screen" role="status">
    <div class="reconnect-spin"></div>
    <div class="reconnect-msg">
      {t(`mobile.reconnecting_to`, { target: connectionLabel(auto_reconnect) })}
    </div>
    <!-- Escape hatch: if the reconnect hangs, drop back to the form. -->
    <button type="button" class="reconnect-cancel" onclick={() => on_reconnect_failed?.()}>
      {t(`common.cancel`)}
    </button>
  </div>
{/if}

{#if otp_visible}
  <OtpDialog
    prompts={otp_prompts}
    instructions={otp_instructions}
    busy={otp_busy}
    prefill={otp_prefill}
    on_submit={submit_otp}
    on_cancel={cancel_otp}
  />
{/if}

{#if save_prompt_visible}
  <div class="sp-overlay" role="dialog" aria-modal="true">
    <div class="sp-card">
      <div class="sp-title">{t(`mobile.save_pw_title`)}</div>
      <div class="sp-body">
        {t(`mobile.save_pw_body`, { user: `${username}@${host}` })}
      </div>
      {#if save_error}
        <div class="sp-error" role="alert">{save_error}</div>
      {/if}
      <div class="sp-actions">
        <button type="button" class="sp-no" onclick={finish_connect}>{t(`mobile.save_pw_not_now`)}</button>
        <button type="button" class="sp-yes" onclick={save_password_yes}>
          {save_error ? t(`mobile.save_pw_retry`) : t(`mobile.save_pw_save`)}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sp-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.6);
  }
  .sp-card {
    width: 100%;
    max-width: 420px;
    padding: 20px;
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
  }
  .sp-title {
    font-size: 1.05em;
    font-weight: 600;
    color: var(--text-color, #e0e0e0);
    margin-bottom: 10px;
  }
  .sp-body {
    font-size: 0.9em;
    line-height: 1.5;
    color: var(--text-color-muted, #cbd5e1);
    margin-bottom: 18px;
  }
  .sp-error {
    font-size: 0.85em;
    line-height: 1.4;
    color: #ff6b6b;
    margin-bottom: 14px;
  }
  .sp-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
  .sp-no,
  .sp-yes {
    min-height: 44px;
    padding: 0 16px;
    font-size: 15px;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
  }
  .sp-no {
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.18);
  }
  .sp-yes {
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border: 1px solid var(--accent-color, #0a84ff);
  }
  .connect-wrap {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 16px;
    padding-top: max(16px, env(safe-area-inset-top));
    overflow-y: auto;
    background: var(--page-bg, #0e1117);
    box-sizing: border-box;
  }
  .connect-card {
    width: 100%;
    max-width: 480px;
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 20px;
  }
  .connect-title {
    font-size: 1.15em;
    font-weight: 600;
    color: var(--text-color, #e0e0e0);
    margin-bottom: 16px;
  }
  .live-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }
  .live-row {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border-color, #4443);
    border-radius: 8px;
    padding: 2px 6px 2px 2px;
  }
  .live-row.active {
    border-color: var(--accent-color, #1976d2);
  }
  .live-pick {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    background: none;
    border: none;
    padding: 8px;
    font: inherit;
    color: inherit;
    text-align: left;
  }
  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #2e7d32;
    flex-shrink: 0;
  }
  .live-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .live-current {
    font-size: 11px;
    opacity: 0.65;
    flex-shrink: 0;
  }
  .live-eject {
    background: none;
    border: none;
    font-size: 16px;
    padding: 6px 8px;
    color: inherit;
    opacity: 0.8;
  }
  .saved-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 18px;
    padding-bottom: 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .saved-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .saved-label {
    font-size: 0.85em;
    color: var(--text-color-muted, #94a3b8);
  }
  .saved-new {
    min-height: 32px;
    padding: 0 12px;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent-color, #3b82f6);
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 8px;
    cursor: pointer;
  }
  .saved-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    cursor: pointer;
  }
  .saved-row:hover,
  .saved-row:focus-visible {
    border-color: var(--accent-color, #3b82f6);
    outline: none;
  }
  .saved-main {
    flex: 1;
    min-width: 0;
    font-size: 15px;
    color: var(--text-color, #e0e0e0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .saved-method {
    flex-shrink: 0;
    font-size: 0.72em;
    color: var(--text-color-muted, #94a3b8);
    background: rgba(255, 255, 255, 0.06);
    padding: 2px 8px;
    border-radius: 999px;
  }
  .saved-del {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    font-size: 14px;
    line-height: 1;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .saved-del:hover {
    color: #ff6b6b;
    background: rgba(255, 107, 107, 0.1);
  }
  .connect-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field > span {
    font-size: 0.85em;
    color: var(--text-color-muted, #94a3b8);
  }
  .field input,
  .field select {
    width: 100%;
    padding: 10px 12px;
    font-size: 16px; /* >=16px stops iOS zoom-on-focus. */
    color: var(--text-color, #e0e0e0);
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    outline: none;
    box-sizing: border-box;
  }
  .field input:focus,
  .field select:focus {
    border-color: var(--accent-color, #3b82f6);
  }
  .field small {
    color: var(--text-color-muted, #94a3b8);
    font-size: 0.78em;
  }
  .key-file-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .key-file-row input {
    flex: 1;
    min-width: 0;
  }
  .key-file-btn {
    flex-shrink: 0;
    min-height: 44px;
    padding: 0 12px;
    color: var(--accent-color, #3b82f6);
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
  }
  .method-hint {
    font-size: 0.82em;
    color: var(--text-color-muted, #94a3b8);
  }
  .connect-error {
    font-size: 0.85em;
    color: #ff6b6b;
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid rgba(255, 107, 107, 0.3);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .reconnect-banner {
    font-size: 0.85em;
    color: #3b82f6;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 8px;
    padding: 8px 10px;
  }
  /* Full-screen "reconnecting" cover (see template) — sits over the connect form
     during an auto-reconnect, below the OTP dialog (z 1000). */
  .reconnect-screen {
    position: fixed;
    inset: 0;
    z-index: 900;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 24px;
    text-align: center;
    background: var(--page-bg, #0e1117);
  }
  .reconnect-spin {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(59, 130, 246, 0.25);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: reconnect-spin 0.8s linear infinite;
  }
  @keyframes reconnect-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .reconnect-msg {
    font-size: 0.95em;
    color: var(--text-color, #e0e0e0);
  }
  .reconnect-cancel {
    margin-top: 8px;
    min-height: 40px;
    padding: 0 20px;
    font-size: 0.9em;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid var(--keybar-border, #333);
    border-radius: 10px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .connect-btn {
    min-height: 48px;
    margin-top: 4px;
    font-size: 16px;
    font-weight: 600;
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border: 1px solid var(--accent-color, #0a84ff);
    border-radius: 8px;
    cursor: pointer;
  }
  .connect-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>

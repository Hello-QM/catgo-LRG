<!--
  OtpDialog.svelte — one round of keyboard-interactive / OTP prompts.

  Given the `prompts` (and optional `instructions`) surfaced by a connect /
  submitOtp round that returned `needsOtp: true`, this renders one input per
  prompt — masked when `echo === false` (OTP / password) — plus Submit and
  Cancel. On submit it emits the answers array (1:1 with `prompts`) via
  `on_submit`; the parent (MobileConnect) drives `transport.submitOtp(...)`.

  STANDALONE: owns no transport/session state; a pure input widget. The parent
  re-mounts it (or passes fresh props) for each multi-round step.
-->
<script lang="ts">
  import type { OtpPrompt } from '$lib/api/transport'
  import { t } from '$lib/i18n/index.svelte'

  interface Props {
    /** Prompts to answer this round (one input each). */
    prompts: OtpPrompt[]
    /** Server-supplied instructions for this round (may be empty). */
    instructions?: string
    /** Disable inputs / show a busy state while the parent submits. */
    busy?: boolean
    /** Emitted with the answers array (index-aligned with `prompts`). */
    on_submit?: (responses: string[]) => void
    /** Emitted when the user cancels this OTP round. */
    on_cancel?: () => void
  }

  let { prompts, instructions = ``, busy = false, on_submit, on_cancel }: Props =
    $props()

  // One answer slot per prompt. Re-derived whenever the prompts array identity
  // changes (i.e. a new multi-round step), so stale answers never leak forward.
  let responses = $state<string[]>([])
  $effect(() => {
    // Track prompts length/identity; reset the answer buffer for a new round.
    responses = prompts.map(() => ``)
  })

  function submit(): void {
    if (busy) return
    on_submit?.(responses.slice())
  }

  function on_keydown(event: KeyboardEvent): void {
    // Enter on the last single-prompt field submits (common OTP UX).
    if (event.key === `Enter` && prompts.length === 1) {
      event.preventDefault()
      submit()
    }
  }
</script>

<div class="otp-overlay" role="dialog" aria-modal="true" aria-label={t(`mobile.otp_title`)}>
  <div class="otp-card">
    <div class="otp-title">{t(`mobile.otp_title`)}</div>

    {#if instructions}
      <div class="otp-instructions">{instructions}</div>
    {/if}

    <form
      class="otp-form"
      onsubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {#each prompts as p, i (i)}
        <label class="otp-field">
          <span class="otp-prompt">{p.prompt}</span>
          <input
            class="otp-input"
            type={p.echo ? `text` : `password`}
            inputmode="text"
            autocomplete="one-time-code"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            disabled={busy}
            bind:value={responses[i]}
            onkeydown={on_keydown}
          />
        </label>
      {/each}

      <div class="otp-actions">
        <button type="button" class="otp-btn cancel" disabled={busy} onclick={() => on_cancel?.()}>
          {t(`mobile.otp_cancel`)}
        </button>
        <button type="submit" class="otp-btn submit" disabled={busy}>
          {busy ? t(`mobile.otp_submitting`) : t(`mobile.otp_submit`)}
        </button>
      </div>
    </form>
  </div>
</div>

<style>
  .otp-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.6);
  }
  .otp-card {
    width: 100%;
    max-width: 420px;
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .otp-title {
    font-size: 1.05em;
    font-weight: 600;
    color: var(--text-color, #e0e0e0);
    margin-bottom: 8px;
  }
  .otp-instructions {
    font-size: 0.85em;
    color: var(--text-color-muted, #94a3b8);
    white-space: pre-wrap;
    margin-bottom: 12px;
  }
  .otp-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .otp-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .otp-prompt {
    font-size: 0.85em;
    color: var(--text-color, #e0e0e0);
    white-space: pre-wrap;
  }
  .otp-input {
    width: 100%;
    padding: 10px 12px;
    font-size: 16px; /* >=16px stops iOS zoom-on-focus. */
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-color, #e0e0e0);
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    outline: none;
  }
  .otp-input:focus {
    border-color: var(--accent-color, #3b82f6);
  }
  .otp-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 4px;
  }
  .otp-btn {
    min-height: 44px;
    padding: 0 16px;
    font-size: 15px;
    border-radius: 8px;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.14);
  }
  .otp-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .otp-btn.cancel {
    color: var(--text-color, #e0e0e0);
    background: rgba(255, 255, 255, 0.06);
  }
  .otp-btn.submit {
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border-color: var(--accent-color, #0a84ff);
  }
</style>

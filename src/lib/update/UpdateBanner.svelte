<script lang="ts">
  // Desktop-only auto-update banner. Mounted once at app root; inert on web and
  // mobile (see is_desktop_tauri). Pops in when a newer version is found.
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import Icon from '$lib/Icon.svelte'
  import {
    check_for_updates,
    dismiss_update,
    install_update,
    is_desktop_tauri,
    update_state,
  } from './auto-update.svelte'

  load_i18n_module('app')

  // Check shortly after launch (desktop only). The delay lets the window settle
  // and the backend come up before we hit the network. Only the MAIN window
  // checks: popouts (structure-*, terminal-*, …) load this same app root, and
  // each would otherwise fire its own duplicate check 4s after opening.
  $effect(() => {
    if (!is_desktop_tauri()) return
    const id = setTimeout(async () => {
      try {
        const { getCurrentWindow } = await import(`@tauri-apps/api/window`)
        if (getCurrentWindow().label !== `main`) return
      } catch {
        return
      }
      check_for_updates()
    }, 4000)
    return () => clearTimeout(id)
  })

  const visible = $derived(
    !update_state.dismissed &&
      (update_state.status === 'available' ||
        update_state.status === 'downloading' ||
        update_state.status === 'ready' ||
        update_state.status === 'error'),
  )

  const pct = $derived(Math.round(update_state.progress * 100))
  const busy = $derived(update_state.status === 'downloading' || update_state.status === 'ready')
</script>

{#if visible}
  <div class="update-banner" role="status">
    {#if update_state.status === 'available'}
      <Icon icon="Download" />
      <span class="ub-text">{t('app.update_available_title', { version: update_state.version ?? '' })}</span>
      <button class="ub-primary" onclick={() => install_update()}>
        {update_state.mode === 'manual'
          ? t('app.update_open_download_btn')
          : t('app.update_install_btn')}
      </button>
      <button class="ub-dismiss" onclick={() => dismiss_update()}>{t('app.update_later_btn')}</button>
    {:else if update_state.status === 'downloading'}
      <div class="ub-bar"><div class="ub-fill" style="width: {pct}%"></div></div>
      <span class="ub-text">{t('app.update_downloading', { pct: String(pct) })}</span>
    {:else if update_state.status === 'ready'}
      <span class="ub-text">{t('app.update_ready')}</span>
    {:else if update_state.status === 'error'}
      <span class="ub-text ub-err">{t('app.update_error', { error: update_state.error ?? '' })}</span>
      <button class="ub-dismiss" onclick={() => dismiss_update()}>{t('app.update_later_btn')}</button>
    {/if}
  </div>
{/if}

<style>
  .update-banner {
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9500;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 90vw;
    padding: 8px 14px;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
    border-radius: 10px;
    background: var(--dialog-bg, rgba(20, 24, 36, 0.97));
    color: var(--text-color, #f3f4f6);
    font-size: 13px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(6px);
  }
  .ub-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ub-err {
    color: var(--error-color, #f87171);
  }
  .ub-primary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border: none;
    border-radius: 7px;
    background: var(--accent-color, cornflowerblue);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .ub-primary:hover {
    filter: brightness(1.08);
  }
  .ub-dismiss {
    padding: 5px 10px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text-color-muted, #9ca3af);
    cursor: pointer;
    white-space: nowrap;
  }
  .ub-dismiss:hover {
    color: var(--text-color, #f3f4f6);
  }
  .ub-bar {
    width: 140px;
    height: 6px;
    border-radius: 3px;
    background: var(--surface-bg, rgba(255, 255, 255, 0.12));
    overflow: hidden;
  }
  .ub-fill {
    height: 100%;
    background: var(--accent-color, cornflowerblue);
    transition: width 0.2s ease;
  }
</style>

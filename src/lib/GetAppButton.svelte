<script lang="ts">
  // Persistent "Get the App" badge for the web (STATIC_ONLY) build — a
  // Star-on-GitHub-style pill that opens the OS-picker download modal. Hidden in
  // the desktop/mobile app (where you already have it).
  import { STATIC_ONLY } from '$lib/api/config'
  import { desktop_download } from '$lib/desktop-download.svelte'
  import Icon from '$lib/Icon.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('app')
</script>

{#if STATIC_ONLY}
  <button
    class="get-app"
    onclick={() => desktop_download.open()}
    title={t('app.desktop_get_app')}
  >
    <Icon icon="Download" />
    <span>{t('app.desktop_get_app')}</span>
  </button>
{/if}

<style>
  .get-app {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 9000;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: 1px solid rgba(59, 130, 246, 0.5);
    border-radius: 999px;
    background: rgba(59, 130, 246, 0.15);
    color: #2563eb;
    font-weight: 600;
    font-size: 0.82em;
    cursor: pointer;
    backdrop-filter: blur(4px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  }
  .get-app:hover {
    background: rgba(59, 130, 246, 0.28);
  }
</style>

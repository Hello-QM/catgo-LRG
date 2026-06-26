<script lang="ts">
  // Drop-in replacement for a pane's error `<div>{error_message}</div>`. Renders
  // the error text as before; when the error is the web-only "requires the CatGo
  // desktop app" message, also shows a Download button that opens the OS-picker
  // modal. For any other error it is just the plain error text.
  import { desktop_download } from '$lib/desktop-download.svelte'
  import Icon from '$lib/Icon.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('app')

  let { error, class: klass = `` }: { error?: string | null; class?: string } = $props()

  const SIGNATURE = `requires the CatGo desktop app`
  const is_desktop_required = $derived(
    typeof error === `string` && error.includes(SIGNATURE),
  )
</script>

{#if error}
  <div class="dr-notice {klass}">
    <span class="dr-text">{error}</span>
    {#if is_desktop_required}
      <button class="dr-btn" onclick={() => desktop_download.open()}>
        <Icon icon="Download" /> {t('app.desktop_download_btn')}
      </button>
    {/if}
  </div>
{/if}

<style>
  .dr-notice {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  .dr-text {
    color: var(--error-color, #d33);
    font-size: 0.85em;
    word-break: break-word;
  }
  .dr-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: #3b82f6;
    color: #fff;
    font-weight: 600;
    font-size: 0.85em;
    cursor: pointer;
  }
  .dr-btn:hover {
    background: #2563eb;
  }
</style>

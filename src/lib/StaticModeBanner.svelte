<script lang="ts">
  import { STATIC_ONLY } from '$lib/api/config'
  import { DOWNLOAD_HUB_URL } from '$lib/download-links'
  import Icon from '$lib/Icon.svelte'

  interface Props {
    title?: string
    message?: string
    show_download?: boolean
  }

  let {
    title = `Desktop Feature`,
    message = `This feature requires the CatGo desktop app or VS Code extension.`,
    show_download = true
  }: Props = $props()
</script>

{#if STATIC_ONLY}
  <div class="static-mode-banner">
    <div class="banner-icon">
      <Icon icon="Server" />
    </div>
    <div class="banner-content">
      <h3 class="banner-title">{title}</h3>
      <p class="banner-message">{message}</p>
      {#if show_download}
        <div class="banner-actions">
          <a href={DOWNLOAD_HUB_URL} target="_blank" rel="noopener" class="download-link">
            <Icon icon="Download" /> Download Desktop App
          </a>
          <a href="https://marketplace.visualstudio.com/items?itemName=Hello-QM.catgo-vscode" target="_blank" rel="noopener" class="vscode-link">
            <Icon icon="Link" /> VS Code Extension
          </a>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .static-mode-banner {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 24px;
    background: rgba(59, 130, 246, 0.05);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 12px;
    margin: 16px;
    color: var(--text-color, #e2e8f0);
  }

  .banner-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    border-radius: 8px;
    flex-shrink: 0;
  }

  .banner-content {
    flex: 1;
  }

  .banner-title {
    margin: 0 0 4px 0;
    font-size: 16px;
    font-weight: 600;
  }

  .banner-message {
    margin: 0 0 16px 0;
    font-size: 14px;
    color: var(--text-color-muted, #94a3b8);
    line-height: 1.5;
  }

  .banner-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .download-link, .vscode-link {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 500;
    text-decoration: none;
    border-radius: 6px;
    transition: all 0.2s;
  }

  .download-link {
    background: #3b82f6;
    color: white;
  }

  .download-link:hover {
    background: #2563eb;
    transform: translateY(-1px);
  }

  .vscode-link {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-color, #e2e8f0);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  }

  .vscode-link:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(128, 128, 128, 0.3);
  }
</style>

<script lang="ts">
  import { pluginManager } from '../manager.svelte'
  import PluginCard from './PluginCard.svelte'
  import PluginInstaller from './PluginInstaller.svelte'
  import { onMount } from 'svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('structure')

  let showInstaller = $state(false)
  let loading = $state(true)

  const plugins = $derived(pluginManager.pluginsArray)

  onMount(async () => {
    await pluginManager.init()
    loading = false
  })

  function handleInstalled() {
    showInstaller = false
  }
</script>

<div class="plugin-manager">
  <header>
    <div class="header-content">
      <h1>{t('structure.plugins')}</h1>
      <p class="subtitle">{t('structure.plugins_extend_catgo')}</p>
    </div>
    <button class="add-btn" onclick={() => (showInstaller = !showInstaller)}>
      {showInstaller ? t('common.cancel') : t('structure.add_plugin')}
    </button>
  </header>

  {#if showInstaller}
    <div class="installer-wrapper">
      <PluginInstaller
        onInstalled={handleInstalled}
        onClose={() => (showInstaller = false)}
      />
    </div>
  {/if}

  <div class="content">
    {#if loading}
      <div class="loading">
        <div class="spinner"></div>
        <span>{t('structure.loading_plugins')}</span>
      </div>
    {:else if plugins.length === 0}
      <div class="empty-state">
        <div class="empty-icon">+</div>
        <h2>{t('structure.plugins_none_installed_title')}</h2>
        <p>
          {t('structure.plugins_install_desc')}
        </p>
        <button class="install-btn" onclick={() => (showInstaller = true)}>
          {t('structure.install_plugin')}
        </button>
      </div>
    {:else}
      <div class="plugins-grid">
        {#each plugins as plugin (plugin.id)}
          <PluginCard {plugin} />
        {/each}
      </div>
    {/if}
  </div>

  <footer>
    <div class="footer-info">
      <span>{t('structure.plugins_installed_count', { n: plugins.length })}</span>
      <span class="separator"></span>
      <span>{t('structure.plugins_enabled_count', { n: plugins.filter((p) => p.enabled).length })}</span>
    </div>
  </footer>
</div>

<style>
  .plugin-manager {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-secondary, #f8f9fa);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 24px;
    background: var(--bg-color, #fff);
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .header-content h1 {
    margin: 0 0 4px 0;
    font-size: 1.5rem;
  }

  .subtitle {
    margin: 0;
    color: var(--text-secondary, #666);
    font-size: 0.9rem;
  }

  .add-btn {
    padding: 10px 20px;
    background: var(--primary, #007bff);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.95rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .add-btn:hover {
    background: var(--primary-dark, #0056b3);
  }

  .installer-wrapper {
    padding: 24px;
    background: var(--bg-color, #fff);
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    display: flex;
    justify-content: center;
  }

  .content {
    flex: 1;
    padding: 24px;
    overflow-y: auto;
  }

  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 60px 20px;
    color: var(--text-secondary, #666);
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border-color, #e0e0e0);
    border-top-color: var(--primary, #007bff);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 60px 20px;
  }

  .empty-icon {
    width: 80px;
    height: 80px;
    border: 3px dashed var(--border-color, #ccc);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2.5rem;
    color: var(--text-secondary, #999);
    margin-bottom: 20px;
  }

  .empty-state h2 {
    margin: 0 0 8px 0;
    font-size: 1.25rem;
    color: var(--text-color, #333);
  }

  .empty-state p {
    margin: 0 0 20px 0;
    color: var(--text-secondary, #666);
    max-width: 300px;
  }

  .install-btn {
    padding: 12px 24px;
    background: var(--primary, #007bff);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .install-btn:hover {
    background: var(--primary-dark, #0056b3);
  }

  .plugins-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }

  footer {
    padding: 16px 24px;
    background: var(--bg-color, #fff);
    border-top: 1px solid var(--border-color, #e0e0e0);
  }

  .footer-info {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 0.85rem;
    color: var(--text-secondary, #666);
  }

  .separator {
    width: 4px;
    height: 4px;
    background: var(--border-color, #ccc);
    border-radius: 50%;
  }
</style>

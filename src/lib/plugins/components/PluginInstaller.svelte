<script lang="ts">
  import { loadFromZip, loadFromUrl, type LoadedPluginData } from '../loader'
  import { pluginManager } from '../manager.svelte'
  import PermissionDialog from './PermissionDialog.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('structure')

  interface Props {
    onInstalled?: () => void
    onClose?: () => void
  }

  let { onInstalled, onClose }: Props = $props()

  let mode = $state<'select' | 'url'>('select')
  let urlInput = $state('')
  let loading = $state(false)
  let error = $state<string | null>(null)
  let pendingPlugin = $state<LoadedPluginData | null>(null)
  let isDragging = $state(false)

  async function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) {
      await processFile(file)
    }
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation() // Prevent document-level handlers from also processing this
    isDragging = false
    console.log('[PluginInstaller] handleDrop called', event.dataTransfer?.files)

    const file = event.dataTransfer?.files[0]
    if (file && file.name.endsWith('.zip')) {
      console.log('[PluginInstaller] Processing ZIP file:', file.name)
      await processFile(file)
    } else {
      error = t('structure.plugin_drop_zip_required')
    }
  }

  async function processFile(file: File) {
    loading = true
    error = null

    const result = await loadFromZip(file)

    if (result.success) {
      pendingPlugin = result.data
    } else {
      error = result.error.message
    }

    loading = false
  }

  async function handleUrlSubmit() {
    if (!urlInput.trim()) {
      error = t('structure.plugin_enter_url')
      return
    }

    loading = true
    error = null

    const result = await loadFromUrl(urlInput.trim())

    if (result.success) {
      pendingPlugin = result.data
    } else {
      error = result.error.message
    }

    loading = false
  }

  async function confirmInstall() {
    console.log('[PluginInstaller] confirmInstall called, pendingPlugin:', pendingPlugin?.manifest?.name)
    if (!pendingPlugin) return

    loading = true
    error = null

    try {
      console.log('[PluginInstaller] Installing plugin:', pendingPlugin.manifest.name)
      await pluginManager.installFromZip(pendingPlugin)
      console.log('[PluginInstaller] Plugin installed successfully')
      pendingPlugin = null
      onInstalled?.()
    } catch (err) {
      console.error('[PluginInstaller] Installation error:', err)
      error = err instanceof Error ? err.message : t('structure.plugin_installation_failed')
    }

    loading = false
  }

  function cancelInstall() {
    pendingPlugin = null
    error = null
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation() // Prevent document-level handlers
    isDragging = true
  }

  function handleDragLeave(event: DragEvent) {
    event.stopPropagation() // Prevent document-level handlers
    isDragging = false
  }
</script>

{#if pendingPlugin}
  <PermissionDialog
    manifest={pendingPlugin.manifest}
    onConfirm={confirmInstall}
    onCancel={cancelInstall}
  />
{/if}

<div class="installer">
  <header>
    <h2>{t('structure.install_plugin')}</h2>
    {#if onClose}
      <button class="close-btn" onclick={onClose} aria-label={t('common.close')}>X</button>
    {/if}
  </header>

  <div class="tabs">
    <button
      class="tab"
      class:active={mode === 'select'}
      onclick={() => (mode = 'select')}
    >
      {t('structure.plugin_upload_zip')}
    </button>
    <button
      class="tab"
      class:active={mode === 'url'}
      onclick={() => (mode = 'url')}
    >
      {t('structure.plugin_from_url')}
    </button>
  </div>

  <div class="content">
    {#if mode === 'select'}
      <div
        class="drop-zone"
        class:dragging={isDragging}
        ondrop={handleDrop}
        ondragover={handleDragOver}
        ondragleave={(e) => handleDragLeave(e)}
        role="button"
        tabindex="0"
      >
        <div class="drop-content">
          <span class="drop-icon">+</span>
          <p>{t('structure.plugin_drag_drop_zip')}</p>
          <p class="or">{t('common.or')}</p>
          <label class="file-btn">
            {t('common.browse_files')}
            <input
              type="file"
              accept=".zip"
              onchange={handleFileSelect}
              hidden
            />
          </label>
        </div>
      </div>
    {:else}
      <div class="url-input">
        <label for="plugin-url">{t('structure.plugin_url')}</label>
        <input
          id="plugin-url"
          type="url"
          bind:value={urlInput}
          placeholder="https://example.com/plugin.zip"
          onkeydown={(e) => e.key === 'Enter' && handleUrlSubmit()}
        />
        <button
          class="fetch-btn"
          onclick={handleUrlSubmit}
          disabled={loading || !urlInput.trim()}
        >
          {loading ? t('common.loading') : t('structure.plugin_fetch')}
        </button>
      </div>
      <p class="url-hint">
        {t('structure.plugin_url_hint')}
      </p>
    {/if}

    {#if error}
      <div class="error">
        <span class="error-icon">!</span>
        <span>{error}</span>
      </div>
    {/if}

    {#if loading}
      <div class="loading">
        <div class="spinner"></div>
        <span>{t('structure.plugin_loading')}</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .installer {
    background: var(--bg-color, #fff);
    border-radius: 8px;
    overflow: hidden;
    max-width: 500px;
    width: 100%;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  header h2 {
    margin: 0;
    font-size: 1.2rem;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.2rem;
    cursor: pointer;
    padding: 4px 8px;
    color: var(--text-secondary, #666);
  }

  .close-btn:hover {
    color: var(--text-color, #333);
  }

  .tabs {
    display: flex;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .tab {
    flex: 1;
    padding: 12px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.95rem;
    color: var(--text-secondary, #666);
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  }

  .tab:hover {
    background: var(--bg-secondary, #f5f5f5);
  }

  .tab.active {
    color: var(--primary, #007bff);
    border-bottom-color: var(--primary, #007bff);
  }

  .content {
    padding: 20px;
  }

  .drop-zone {
    border: 2px dashed var(--border-color, #ccc);
    border-radius: 8px;
    padding: 40px 20px;
    text-align: center;
    transition: all 0.2s;
  }

  .drop-zone.dragging {
    border-color: var(--primary, #007bff);
    background: rgba(0, 123, 255, 0.05);
  }

  .drop-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .drop-icon {
    font-size: 2.5rem;
    color: var(--text-secondary, #999);
  }

  .drop-content p {
    margin: 0;
    color: var(--text-secondary, #666);
  }

  .or {
    font-size: 0.85rem;
    color: var(--text-secondary, #999) !important;
  }

  .file-btn {
    padding: 8px 16px;
    background: var(--primary, #007bff);
    color: white;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: background 0.2s;
  }

  .file-btn:hover {
    background: var(--primary-dark, #0056b3);
  }

  .url-input {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .url-input label {
    font-size: 0.9rem;
    color: var(--text-secondary, #666);
  }

  .url-input input {
    padding: 10px 12px;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 6px;
    font-size: 0.95rem;
  }

  .url-input input:focus {
    outline: none;
    border-color: var(--primary, #007bff);
  }

  .fetch-btn {
    padding: 10px 16px;
    background: var(--primary, #007bff);
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.95rem;
    transition: background 0.2s;
  }

  .fetch-btn:hover:not(:disabled) {
    background: var(--primary-dark, #0056b3);
  }

  .fetch-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .url-hint {
    margin: 12px 0 0 0;
    font-size: 0.85rem;
    color: var(--text-secondary, #999);
  }

  .error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    padding: 12px;
    background: rgba(220, 53, 69, 0.1);
    border-radius: 6px;
    color: #dc3545;
  }

  .error-icon {
    width: 20px;
    height: 20px;
    background: #dc3545;
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 0.8rem;
    flex-shrink: 0;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 16px;
    padding: 16px;
    color: var(--text-secondary, #666);
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-color, #ccc);
    border-top-color: var(--primary, #007bff);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

<script lang="ts">
  import type { LoadedPlugin } from '../sdk/types'
  import { pluginManager } from '../manager.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('structure')

  interface Props {
    plugin: LoadedPlugin
  }

  let { plugin }: Props = $props()

  const manifest = $derived(plugin.manifest)
  const hasViews = $derived(
    (manifest.catgo?.frontend?.contributions?.views?.length ?? 0) > 0
  )
  const hasPanels = $derived(
    (manifest.catgo?.frontend?.contributions?.panels?.length ?? 0) > 0
  )
  const hasHooks = $derived(
    (manifest.catgo?.frontend?.contributions?.structureHooks?.length ?? 0) > 0
  )

  async function toggleEnabled() {
    if (plugin.enabled) {
      await pluginManager.disablePlugin(plugin.id)
    } else {
      await pluginManager.enablePlugin(plugin.id)
    }
  }

  async function uninstall() {
    if (
      confirm(
        t('structure.plugin_uninstall_confirm', { name: manifest.displayName || manifest.name })
      )
    ) {
      await pluginManager.uninstallPlugin(plugin.id)
    }
  }
</script>

<div class="plugin-card" class:disabled={!plugin.enabled}>
  <div class="plugin-header">
    <div class="plugin-info">
      <h3>{manifest.displayName || manifest.name}</h3>
      <span class="version">v{manifest.version}</span>
    </div>
    <label class="toggle">
      <input
        type="checkbox"
        checked={plugin.enabled}
        onchange={toggleEnabled}
      />
      <span class="slider"></span>
    </label>
  </div>

  {#if manifest.description}
    <p class="description">{manifest.description}</p>
  {/if}

  <div class="plugin-meta">
    {#if manifest.author}
      <span class="author">
        {t('structure.plugin_author_by', { author: typeof manifest.author === 'string'
          ? manifest.author
          : manifest.author?.name ?? t('common.unknown') })}
      </span>
    {/if}
  </div>

  <div class="contributions">
    {#if hasViews}
      <span class="badge views">{t('structure.plugin_views')}</span>
    {/if}
    {#if hasPanels}
      <span class="badge panels">{t('structure.plugin_panels')}</span>
    {/if}
    {#if hasHooks}
      <span class="badge hooks">{t('structure.plugin_hooks')}</span>
    {/if}
    {#if manifest.catgo?.frontend?.wasm}
      <span class="badge wasm">WASM</span>
    {/if}
  </div>

  <div class="plugin-actions">
    <button class="action-btn settings" disabled>{t('common.settings')}</button>
    <button class="action-btn uninstall" onclick={uninstall}>{t('structure.uninstall')}</button>
  </div>
</div>

<style>
  .plugin-card {
    background: var(--bg-color, #fff);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 8px;
    padding: 16px;
    transition: all 0.2s;
  }

  .plugin-card.disabled {
    opacity: 0.7;
  }

  .plugin-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }

  .plugin-info {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .plugin-info h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .version {
    font-size: 0.8rem;
    color: var(--text-secondary, #666);
  }

  .toggle {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
    flex-shrink: 0;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background: var(--bg-tertiary, #ccc);
    border-radius: 22px;
    transition: 0.3s;
  }

  .slider::before {
    position: absolute;
    content: '';
    height: 16px;
    width: 16px;
    left: 3px;
    bottom: 3px;
    background: white;
    border-radius: 50%;
    transition: 0.3s;
  }

  input:checked + .slider {
    background: var(--primary, #007bff);
  }

  input:checked + .slider::before {
    transform: translateX(18px);
  }

  .description {
    margin: 12px 0 8px 0;
    font-size: 0.9rem;
    color: var(--text-secondary, #555);
    line-height: 1.4;
  }

  .plugin-meta {
    margin-bottom: 12px;
  }

  .author {
    font-size: 0.8rem;
    color: var(--text-secondary, #888);
  }

  .contributions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 12px;
  }

  .badge {
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 500;
    text-transform: uppercase;
  }

  .badge.views {
    background: rgba(0, 123, 255, 0.15);
    color: #007bff;
  }

  .badge.panels {
    background: rgba(111, 66, 193, 0.15);
    color: #6f42c1;
  }

  .badge.hooks {
    background: rgba(40, 167, 69, 0.15);
    color: #28a745;
  }

  .badge.wasm {
    background: rgba(253, 126, 20, 0.15);
    color: #fd7e14;
  }

  .plugin-actions {
    display: flex;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--border-color, #e0e0e0);
  }

  .action-btn {
    padding: 6px 12px;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 4px;
    background: var(--bg-color, #fff);
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .action-btn:hover:not(:disabled) {
    background: var(--bg-secondary, #f5f5f5);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-btn.uninstall:hover {
    border-color: #dc3545;
    color: #dc3545;
  }
</style>

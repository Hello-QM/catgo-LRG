<script lang="ts">
  import type { Permission, PluginManifest } from '../sdk/types'
  import { getPermissionDescription, getPermissionRisk } from '../loader'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('structure')

  interface Props {
    manifest: PluginManifest
    onConfirm: () => void
    onCancel: () => void
  }

  let { manifest, onConfirm, onCancel }: Props = $props()

  const permissions = $derived(manifest.catgo?.permissions ?? [])

  function getRiskColor(risk: 'low' | 'medium' | 'high'): string {
    switch (risk) {
      case 'high':
        return 'var(--danger, #dc3545)'
      case 'medium':
        return 'var(--warning, #ffc107)'
      default:
        return 'var(--success, #28a745)'
    }
  }

  function getRiskIcon(risk: 'low' | 'medium' | 'high'): string {
    switch (risk) {
      case 'high':
        return '!'
      case 'medium':
        return '~'
      default:
        return ''
    }
  }
</script>

<div
  class="dialog-overlay"
  role="dialog"
  aria-modal="true"
  onclick={(e) => e.stopPropagation()}
  ondrop={(e) => { e.preventDefault(); e.stopPropagation(); }}
  ondragover={(e) => { e.preventDefault(); e.stopPropagation(); }}
>
  <div class="dialog">
    <header>
      <h2>{t('structure.install_plugin')}</h2>
    </header>

    <div class="plugin-info">
      <h3>{manifest.displayName || manifest.name}</h3>
      <p class="version">v{manifest.version}</p>
      {#if manifest.description}
        <p class="description">{manifest.description}</p>
      {/if}
      {#if manifest.author}
        <p class="author">
          {t('structure.plugin_author_by', { author: typeof manifest.author === 'string'
            ? manifest.author
            : manifest.author?.name ?? t('common.unknown') })}
        </p>
      {/if}
    </div>

    {#if permissions.length > 0}
      <div class="permissions">
        <h4>{t('structure.plugin_requested_permissions')}</h4>
        <ul>
          {#each permissions as permission}
            {@const risk = getPermissionRisk(permission)}
            <li style="--risk-color: {getRiskColor(risk)}">
              {#if getRiskIcon(risk)}
                <span class="risk-icon">{getRiskIcon(risk)}</span>
              {/if}
              <span class="permission-name"
                >{getPermissionDescription(permission)}</span
              >
              <span class="risk-badge {risk}">{risk}</span>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <div class="permissions">
        <p class="no-permissions">{t('structure.plugin_no_special_permissions')}</p>
      </div>
    {/if}

    <footer>
      <button class="cancel" onclick={(e) => { e.stopPropagation(); onCancel() }}>{t('common.cancel')}</button>
      <button class="confirm" onclick={(e) => { e.stopPropagation(); onConfirm() }}>{t('structure.install')}</button>
    </footer>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    z-index: 1000;
    overflow: auto;
  }

  .dialog {
    background: var(--bg-color, #fff);
    border-radius: 8px;
    width: min(450px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
    overflow: auto;
  }

  header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  header h2 {
    margin: 0;
    font-size: 1.25rem;
  }

  .plugin-info {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .plugin-info h3 {
    margin: 0 0 4px 0;
    font-size: 1.1rem;
  }

  .plugin-info .version {
    margin: 0;
    color: var(--text-secondary, #666);
    font-size: 0.9rem;
  }

  .plugin-info .description {
    margin: 8px 0 0 0;
    font-size: 0.95rem;
  }

  .plugin-info .author {
    margin: 4px 0 0 0;
    color: var(--text-secondary, #666);
    font-size: 0.85rem;
  }

  .permissions {
    padding: 16px 20px;
  }

  .permissions h4 {
    margin: 0 0 12px 0;
    font-size: 0.95rem;
    color: var(--text-secondary, #666);
  }

  .permissions ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .permissions li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .permissions li:last-child {
    border-bottom: none;
  }

  .risk-icon {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--risk-color);
    color: white;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8rem;
  }

  .permission-name {
    flex: 1;
  }

  .risk-badge {
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    font-weight: 500;
  }

  .risk-badge.low {
    background: rgba(40, 167, 69, 0.15);
    color: #28a745;
  }

  .risk-badge.medium {
    background: rgba(255, 193, 7, 0.15);
    color: #856404;
  }

  .risk-badge.high {
    background: rgba(220, 53, 69, 0.15);
    color: #dc3545;
  }

  .no-permissions {
    color: var(--text-secondary, #666);
    font-style: italic;
    margin: 0;
  }

  footer {
    padding: 16px 20px;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    border-top: 1px solid var(--border-color, #e0e0e0);
  }

  button {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 0.95rem;
    cursor: pointer;
    border: none;
    transition: background 0.2s;
  }

  button.cancel {
    background: var(--bg-secondary, #f5f5f5);
    color: var(--text-color, #333);
  }

  button.cancel:hover {
    background: var(--bg-tertiary, #e5e5e5);
  }

  button.confirm {
    background: var(--primary, #007bff);
    color: white;
  }

  button.confirm:hover {
    background: var(--primary-dark, #0056b3);
  }
</style>

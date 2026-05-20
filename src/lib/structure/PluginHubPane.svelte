<script lang="ts">
  import '$lib/pane-shared.css'
  import { DraggablePane } from '$lib'
  import { API_BASE } from '$lib/api/config'
  import { pluginManager } from '$lib/plugins'
  import PluginInstaller from '$lib/plugins/components/PluginInstaller.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')
  load_i18n_module('common')

  type HubPlugin = {
    id: string
    display_name: string
    description: string
    version: string
    author: string
    category: string
    output_type: string
    tags: string[]
    requires: string[]
    folder: string
    updated_at: string
  }

  type InstalledPlugin = {
    id: string
    name: string
    version: string
    latest_version: string | null
    update_available: boolean
    trust: string
    category: string
    source: string
  }

  let { show = $bindable(false) }: { show: boolean } = $props()

  let hub_plugins = $state<HubPlugin[]>([])
  let installed_plugins = $state<InstalledPlugin[]>([])
  let loading_hub = $state(false)
  let loading_installed = $state(false)
  let hub_error = $state<string | null>(null)
  let installed_error = $state<string | null>(null)
  let action_error = $state<string | null>(null)
  let hub_fetched = $state(false)
  let search_query = $state(``)
  let selected_category = $state(`all`)
  let installing = $state<Record<string, boolean>>({})
  let active_tab = $state<'hub' | 'installed' | 'create' | 'extensions'>(`hub`)
  let extensions_initialized = $state(false)
  let show_zip_installer = $state(false)

  const categories = [
    { value: `all`, label: t('structure.all') },
    { value: `general`, label: t('structure.plugin_category_general') },
    { value: `calculator`, label: t('structure.plugin_category_calculator') },
    { value: `reader`, label: t('structure.plugin_category_reader') },
    { value: `workflow_node`, label: t('common.workflow') },
    { value: `optimizer`, label: t('structure.optimizer') },
  ]

  const installed_ids = $derived(new Set(installed_plugins.map(p => p.id)))

  const filtered_hub_plugins = $derived.by(() => {
    let result = hub_plugins
    if (selected_category !== `all`) {
      result = result.filter(p => p.category === selected_category)
    }
    if (search_query.trim()) {
      const q = search_query.trim().toLowerCase()
      result = result.filter(p =>
        p.display_name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some(t => t.toLowerCase().includes(q))
      )
    }
    return result
  })

  async function fetch_hub_index() {
    loading_hub = true
    hub_error = null
    try {
      const resp = await fetch(`${API_BASE}/hub/index`)
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || resp.statusText)
      }
      const data = await resp.json()
      hub_plugins = data.plugins ?? data ?? []
      hub_fetched = true
    } catch (e: any) {
      hub_error = e.message || t('structure.failed_load_plugin_hub')
      console.warn(`[PluginHubPane] Hub fetch failed:`, e)
    } finally {
      loading_hub = false
    }
  }

  async function fetch_installed() {
    loading_installed = true
    installed_error = null
    try {
      const resp = await fetch(`${API_BASE}/hub/installed`)
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || resp.statusText)
      }
      const data = await resp.json()
      installed_plugins = data.installed ?? data.plugins ?? data ?? []
    } catch (e: any) {
      installed_error = e.message || t('structure.failed_load_installed_plugins')
      console.warn(`[PluginHubPane] Installed fetch failed:`, e)
    } finally {
      loading_installed = false
    }
  }

  async function install_plugin(plugin_id: string) {
    installing = { ...installing, [plugin_id]: true }
    action_error = null
    try {
      const resp = await fetch(`${API_BASE}/hub/install/${encodeURIComponent(plugin_id)}`, {
        method: `POST`,
      })
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || resp.statusText)
      }
      // Refresh installed list
      await fetch_installed()
    } catch (e: any) {
      action_error = e.message || t('structure.failed_install_plugin')
    } finally {
      installing = { ...installing, [plugin_id]: false }
    }
  }

  async function uninstall_plugin(plugin_id: string) {
    installing = { ...installing, [plugin_id]: true }
    action_error = null
    try {
      const resp = await fetch(`${API_BASE}/hub/uninstall/${encodeURIComponent(plugin_id)}`, {
        method: `DELETE`,
      })
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || resp.statusText)
      }
      await fetch_installed()
    } catch (e: any) {
      action_error = e.message || t('structure.failed_uninstall_plugin')
    } finally {
      installing = { ...installing, [plugin_id]: false }
    }
  }

  async function upgrade_trust(plugin_id: string) {
    installing = { ...installing, [plugin_id]: true }
    action_error = null
    try {
      const resp = await fetch(`${API_BASE}/tools/${encodeURIComponent(plugin_id)}/upgrade`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({ trust: `user` }),
      })
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || resp.statusText)
      }
      await fetch_installed()
    } catch (e: any) {
      action_error = e.message || t('structure.failed_upgrade_trust')
    } finally {
      installing = { ...installing, [plugin_id]: false }
    }
  }

  async function update_plugin(plugin_id: string) {
    installing = { ...installing, [plugin_id]: true }
    action_error = null
    try {
      const resp = await fetch(`${API_BASE}/hub/update/${encodeURIComponent(plugin_id)}`, {
        method: `POST`,
      })
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || resp.statusText)
      }
      await fetch_installed()
    } catch (e: any) {
      action_error = e.message || t('structure.failed_update_plugin')
    } finally {
      installing = { ...installing, [plugin_id]: false }
    }
  }

  function category_color(category: string): string {
    switch (category) {
      case `calculator`: return `#3b82f6`
      case `reader`: return `#8b5cf6`
      case `workflow_node`: return `#f59e0b`
      case `optimizer`: return `#10b981`
      default: return `#6b7280`
    }
  }

  function trust_color(trust: string): string {
    switch (trust) {
      case `builtin`: return `#3b82f6`
      case `user`: return `#10b981`
      case `sandboxed`: return `#f59e0b`
      default: return `#6b7280`
    }
  }

  function format_date(iso: string): string {
    try {
      const d = new Date(iso)
      return d.toLocaleDateString(undefined, { year: `numeric`, month: `short`, day: `numeric` })
    } catch {
      return iso
    }
  }

  // Fetch hub data on first open
  $effect(() => {
    if (show && !hub_fetched) {
      fetch_hub_index()
    }
  })
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="28em"
  pane_props={{ class: 'plugin-hub-pane' }}
>
  <h4 class="pane-title">{t('structure.plugin_hub')}</h4>
  <div class="tab-bar">
    <button class:active={active_tab === 'hub'} onclick={() => { active_tab = `hub` }}>{t('structure.plugin_hub_tab')}</button>
    <button class:active={active_tab === 'installed'} onclick={() => { active_tab = `installed`; fetch_installed() }}>{t('structure.plugin_installed')}</button>
    <button class:active={active_tab === 'create'} onclick={() => { active_tab = `create` }}>{t('structure.plugin_create')}</button>
    <button class:active={active_tab === 'extensions'} onclick={() => { active_tab = `extensions`; if (!extensions_initialized) pluginManager.init().then(() => { extensions_initialized = true }) }}>{t('structure.plugin_extensions')}</button>
  </div>

  {#if action_error}
    <p class="error-msg">{action_error}</p>
  {/if}

  <div class="pane-content">
    {#if active_tab === 'hub'}
      {#if hub_error}
        <p class="error-msg">{hub_error}</p>
      {/if}
      <!-- Search and filter controls -->
      <div class="filter-bar">
        <input
          type="text"
          placeholder={t('structure.search_plugins')}
          bind:value={search_query}
          class="search-input"
        />
        <select bind:value={selected_category} class="category-select">
          {#each categories as cat}
            <option value={cat.value}>{cat.label}</option>
          {/each}
        </select>
      </div>

      {#if loading_hub}
        <p class="hint">{t('structure.loading_plugins')}</p>
      {:else if filtered_hub_plugins.length === 0}
        <p class="hint">
          {hub_plugins.length === 0
            ? t('structure.no_plugins_available')
            : t('structure.no_plugins_match')}
        </p>
      {:else}
        <div class="plugin-grid">
          {#each filtered_hub_plugins as plugin (plugin.id)}
            <div class="plugin-card">
              <div class="card-header">
                <span class="plugin-name">{plugin.display_name}</span>
                <span class="category-badge" style="background: {category_color(plugin.category)}">
                  {plugin.category}
                </span>
              </div>
              <p class="plugin-desc">{plugin.description}</p>
              <div class="card-meta">
                <span class="meta-item">v{plugin.version}</span>
                {#if plugin.author}
                  <span class="meta-item">{plugin.author}</span>
                {/if}
                {#if plugin.updated_at}
                  <span class="meta-item">{format_date(plugin.updated_at)}</span>
                {/if}
              </div>
              {#if plugin.tags.length > 0}
                <div class="tag-row">
                  {#each plugin.tags.slice(0, 4) as tag}
                    <span class="tag">{tag}</span>
                  {/each}
                </div>
              {/if}
              <div class="card-actions">
                {#if installed_ids.has(plugin.id)}
                  {@const installed = installed_plugins.find(p => p.id === plugin.id)}
                  {#if installed?.update_available}
                    <button
                      class="action-btn update-btn"
                      disabled={installing[plugin.id]}
                      onclick={() => update_plugin(plugin.id)}
                    >
                      {installing[plugin.id] ? t('structure.updating') : t('structure.update')}
                    </button>
                  {:else}
                    <span class="installed-badge">{t('structure.plugin_installed')}</span>
                  {/if}
                {:else}
                  <button
                    class="action-btn install-btn"
                    disabled={installing[plugin.id]}
                    onclick={() => install_plugin(plugin.id)}
                  >
                    {installing[plugin.id] ? t('structure.installing') : t('structure.install')}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}

    {:else if active_tab === 'installed'}
      {#if installed_error}
        <p class="error-msg">{installed_error}</p>
      {/if}
      {#if loading_installed}
        <p class="hint">{t('structure.loading_installed_plugins')}</p>
      {:else if installed_plugins.length === 0}
        <p class="hint">{t('structure.no_plugins_installed')}</p>
      {:else}
        <div class="installed-list">
          {#each installed_plugins as plugin (plugin.id)}
            <div class="installed-item">
              <div class="installed-header">
                <span class="plugin-name">{plugin.name}</span>
                <span class="trust-badge" style="background: {trust_color(plugin.trust)}">
                  {plugin.trust}
                </span>
              </div>
              <div class="installed-meta">
                <span class="meta-item">v{plugin.version}</span>
                <span class="category-badge small" style="background: {category_color(plugin.category)}">
                  {plugin.category}
                </span>
                <span class="meta-item source">{plugin.source}</span>
              </div>
              <div class="installed-actions">
                {#if plugin.update_available}
                  <button
                    class="action-btn update-btn"
                    disabled={installing[plugin.id]}
                    onclick={() => update_plugin(plugin.id)}
                  >
                    {installing[plugin.id] ? t('structure.updating') : t('structure.update_to_version', { version: plugin.latest_version ?? '' })}
                  </button>
                {/if}
                {#if plugin.trust === 'sandboxed'}
                  <button
                    class="action-btn trust-btn"
                    onclick={() => upgrade_trust(plugin.id)}
                    title={t('structure.promote_trust_title')}
                  >
                    {t('structure.upgrade_trust')}
                  </button>
                {/if}
                {#if plugin.trust !== 'builtin'}
                  <button
                    class="action-btn uninstall-btn"
                    onclick={() => uninstall_plugin(plugin.id)}
                  >
                    {t('structure.uninstall')}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}

    {:else if active_tab === 'create'}
      <section class="create-section">
        <h5>{t('structure.create_plugins_with_catbot')}</h5>
        <p class="create-desc">
          {t('structure.create_plugins_desc')}
        </p>
        <div class="create-examples">
          <p class="examples-label">{t('structure.example_prompts')}</p>
          <ul>
            <li>"Create a plugin that calculates the coordination number distribution"</li>
            <li>"Make a reader plugin for custom XYZ format with velocities"</li>
            <li>"Build a workflow node that filters structures by band gap"</li>
          </ul>
        </div>
        <div class="create-format">
          <p class="examples-label">{t('structure.plugin_format')}</p>
          <p class="format-desc">
            {t('structure.plugin_format_desc')}
          </p>
          <pre class="format-example">{`TOOL = {
    "name": "my_tool",
    "description": "...",
    "category": "general",
    "input_schema": {...},
    "output_type": "bar_plot",
}

async def execute(context):
    structure = context["structure"]
    # ... compute ...
    return {"series": [...]}`}</pre>
        </div>
      </section>
    {:else if active_tab === 'extensions'}
      {#if show_zip_installer}
        <PluginInstaller
          onInstalled={() => { show_zip_installer = false }}
          onClose={() => { show_zip_installer = false }}
        />
      {:else}
        <div class="extensions-header">
          <span class="extensions-title">{t('structure.ui_extensions')}</span>
          <button class="action-btn install-btn" onclick={() => { show_zip_installer = true }}>
            {t('structure.install_zip')}
          </button>
        </div>
        {#if !extensions_initialized}
          <p class="hint">{t('common.loading')}</p>
        {:else if pluginManager.pluginsArray.length === 0}
          <p class="hint">
            {t('structure.no_ui_extensions')}
          </p>
        {:else}
          <div class="installed-list">
            {#each pluginManager.pluginsArray as plugin (plugin.id)}
              <div class="installed-item">
                <div class="installed-header">
                  <span class="plugin-name">{plugin.manifest.displayName || plugin.manifest.name}</span>
                  <span class="meta-item">v{plugin.manifest.version}</span>
                </div>
                {#if plugin.manifest.description}
                  <p class="plugin-desc">{plugin.manifest.description}</p>
                {/if}
                <div class="installed-actions">
                  <button
                    class="action-btn"
                    class:trust-btn={plugin.enabled}
                    class:install-btn={!plugin.enabled}
                    onclick={async () => {
                      action_error = null
                      try {
                        if (plugin.enabled) {
                          await pluginManager.disablePlugin(plugin.id)
                        } else {
                          await pluginManager.enablePlugin(plugin.id)
                        }
                      } catch (e: any) {
                        action_error = e.message || t('structure.failed_toggle_extension')
                      }
                    }}
                  >
                    {plugin.enabled ? t('structure.disable') : t('structure.enable')}
                  </button>
                  <button
                    class="action-btn uninstall-btn"
                    disabled={installing[plugin.id]}
                    onclick={async () => {
                      installing = { ...installing, [plugin.id]: true }
                      action_error = null
                      try {
                        await pluginManager.uninstallPlugin(plugin.id)
                      } catch (e: any) {
                        action_error = e.message || t('structure.failed_uninstall_extension')
                      } finally {
                        installing = { ...installing, [plugin.id]: false }
                      }
                    }}
                  >
                    {installing[plugin.id] ? t('structure.removing') : t('structure.uninstall')}
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</DraggablePane>

<style>
  .tab-bar {
    grid-template-columns: repeat(4, 1fr);
    min-width: 0;
  }
  .tab-bar button {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85em;
    padding: 6px 4px;
  }
  .error-msg {
    font-size: 0.8em;
    color: var(--error-color, #ef4444);
    margin: 4px 0 8px;
    line-height: 1.4;
  }
  .pane-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .filter-bar {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .search-input {
    flex: 1;
    padding: 5px 8px;
    border-radius: 6px;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.2));
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2));
    color: var(--text-color);
    font-size: 0.85em;
  }
  .search-input::placeholder {
    color: light-dark(rgba(0, 0, 0, 0.4), rgba(255, 255, 255, 0.4));
  }
  .category-select {
    padding: 5px 6px;
    border-radius: 6px;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.2));
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2));
    color: var(--text-color);
    font-size: 0.82em;
    min-width: 6em;
  }
  .hint {
    font-size: 0.82em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
    margin: 8px 0;
    line-height: 1.4;
  }

  /* Plugin cards (Hub tab) */
  .plugin-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .plugin-card {
    padding: 10px 12px;
    background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.04));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .plugin-name {
    font-weight: 600;
    font-size: 0.9em;
    color: var(--text-color, #fff);
  }
  .category-badge {
    font-size: 0.68em;
    padding: 2px 6px;
    border-radius: 10px;
    color: #fff;
    font-weight: 500;
    white-space: nowrap;
    text-transform: capitalize;
  }
  .category-badge.small {
    font-size: 0.62em;
    padding: 1px 5px;
  }
  .plugin-desc {
    font-size: 0.8em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.7));
    line-height: 1.4;
    margin: 0;
  }
  .card-meta {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .meta-item {
    font-size: 0.72em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.5));
  }
  .meta-item.source {
    opacity: 0.7;
    font-style: italic;
  }
  .tag-row {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .tag {
    font-size: 0.68em;
    padding: 1px 5px;
    border-radius: 4px;
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
  }
  .card-actions {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 2px;
  }
  .action-btn {
    padding: 4px 10px;
    border: 1px solid transparent;
    border-radius: 5px;
    font-size: 0.78em;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    font-weight: 500;
  }
  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .install-btn {
    background: var(--accent-color, #3b82f6);
    color: #fff;
    border-color: var(--accent-color, #3b82f6);
  }
  .install-btn:hover:not(:disabled) {
    opacity: 0.85;
  }
  .update-btn {
    background: #f59e0b;
    color: #fff;
    border-color: #f59e0b;
  }
  .update-btn:hover:not(:disabled) {
    opacity: 0.85;
  }
  .installed-badge {
    font-size: 0.78em;
    padding: 4px 10px;
    border-radius: 5px;
    background: light-dark(rgba(16, 185, 129, 0.12), rgba(16, 185, 129, 0.2));
    color: #10b981;
    font-weight: 500;
  }

  /* Installed list */
  .installed-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .installed-item {
    padding: 10px 12px;
    background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.04));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .installed-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .trust-badge {
    font-size: 0.68em;
    padding: 2px 6px;
    border-radius: 10px;
    color: #fff;
    font-weight: 500;
    white-space: nowrap;
    text-transform: capitalize;
  }
  .installed-meta {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .installed-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .trust-btn {
    background: light-dark(rgba(245, 158, 11, 0.12), rgba(245, 158, 11, 0.2));
    color: #f59e0b;
    border-color: light-dark(rgba(245, 158, 11, 0.3), rgba(245, 158, 11, 0.4));
  }
  .trust-btn:hover {
    background: light-dark(rgba(245, 158, 11, 0.2), rgba(245, 158, 11, 0.3));
  }
  .uninstall-btn {
    background: light-dark(rgba(239, 68, 68, 0.08), rgba(239, 68, 68, 0.15));
    color: var(--error-color, #ef4444);
    border-color: light-dark(rgba(239, 68, 68, 0.2), rgba(239, 68, 68, 0.3));
  }
  .uninstall-btn:hover {
    background: light-dark(rgba(239, 68, 68, 0.15), rgba(239, 68, 68, 0.25));
  }

  /* Create tab */
  .create-section {
    padding: 8px;
  }
  .create-section h5 {
    margin: 0 0 8px;
    font-size: 0.9em;
    font-weight: 600;
    color: var(--text-color, #fff);
  }
  .create-desc {
    font-size: 0.82em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.7));
    line-height: 1.5;
    margin: 0 0 12px;
  }
  .create-examples {
    margin-bottom: 12px;
  }
  .examples-label {
    font-size: 0.82em;
    font-weight: 600;
    color: var(--text-color, #fff);
    margin: 0 0 4px;
  }
  .create-examples ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .create-examples li {
    font-size: 0.78em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
    padding: 4px 8px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
    border-radius: 4px;
    line-height: 1.4;
    font-style: italic;
  }
  .create-format {
    margin-top: 4px;
  }
  .format-desc {
    font-size: 0.78em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
    line-height: 1.4;
    margin: 4px 0 8px;
  }
  .format-desc code {
    font-size: 0.95em;
    padding: 1px 4px;
    border-radius: 3px;
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1));
    color: var(--accent-color, #3b82f6);
  }
  .format-example {
    font-size: 0.72em;
    padding: 8px 10px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.3));
    border-radius: 6px;
    color: var(--text-color, #fff);
    overflow-x: auto;
    white-space: pre;
    line-height: 1.5;
    margin: 0;
  }

  /* Extensions tab */
  .extensions-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .extensions-title {
    font-size: 0.9em;
    font-weight: 600;
    color: var(--text-color, #fff);
  }
</style>

<script lang="ts">
  /**
   * PluginPanelHost - Renders plugin panels for a specific location
   *
   * Supports two types of panel components:
   * 1. Svelte components
   * 2. Vanilla JS render functions: { render: (container) => void }
   */
  import { pluginManager } from '../manager.svelte'
  import { SettingsSection } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  interface Props {
    location: string
    structure?: unknown
    onRequestRender?: () => void
  }

  let { location, structure, onRequestRender }: Props = $props()

  // Create a plugin context with the expected API
  const pluginContext = {
    structure: {
      get data() { return structure },
      requestRender: () => {
        console.log('[PluginPanelHost] requestRender called')
        onRequestRender?.()
      }
    },
    ui: {
      showNotification: (opts: { message: string; type?: string; duration?: number }) => {
        console.log(`[Plugin Notification] ${opts.type || 'info'}: ${opts.message}`)
      }
    },
    settings: {
      get: async (key: string) => {
        // TODO: implement settings storage
        return null
      },
      set: async (key: string, value: unknown) => {
        // TODO: implement settings storage
        console.log(`[Plugin Settings] ${key} =`, value)
      }
    }
  }

  // Get enabled panels for this location
  const enabledPanels = $derived(
    pluginManager.panelPlugins.filter(
      (p) =>
        p.location === location &&
        pluginManager.plugins.get(p.manifest.name)?.active
    )
  )

  // Debug logging
  $effect(() => {
    console.log(`[PluginPanelHost] location="${location}", total panels: ${pluginManager.panelPlugins.length}`)
    console.log(`[PluginPanelHost] enabled panels for this location:`, enabledPanels.length)
    for (const panel of pluginManager.panelPlugins) {
      const plugin = pluginManager.plugins.get(panel.manifest.name)
      console.log(`[PluginPanelHost] Panel: ${panel.id}, location: ${panel.location}, plugin active: ${plugin?.active}`)
    }
  })

  // Track container refs for vanilla JS panels
  let containerRefs = $state<Record<string, HTMLDivElement | null>>({})

  // Render vanilla JS panels when they become available
  $effect(() => {
    for (const panel of enabledPanels) {
      const container = containerRefs[panel.id]
      if (container && panel.component) {
        try {
          // Check if it's a render function style component
          const result = typeof panel.component === 'function'
            ? (panel.component as Function)({ structure, context: pluginContext })
            : null

          if (result && typeof result.render === 'function') {
            // Clear and render
            container.innerHTML = ''
            result.render(container)
          }
        } catch (err) {
          console.error(`[PluginPanelHost] Error rendering panel ${panel.id}:`, err)
          container.innerHTML = `<p class="plugin-error">${t('structure.plugin_error_rendering_panel')}</p>`
        }
      }
    }
  })

  // Check if component is a Svelte component (has $$ property)
  function isSvelteComponent(component: unknown): boolean {
    return !!(component && typeof component === 'function' && (component as any).$$)
  }
</script>

{#if pluginManager.panelPlugins.length > 0 && enabledPanels.length === 0}
  <SettingsSection title={t('structure.plugins')} current_values={{}}>
    <p class="plugin-placeholder">
      {t('structure.plugin_no_active_for_panel')}
    </p>
  </SettingsSection>
{/if}

{#each enabledPanels as panel (panel.id)}
  <SettingsSection title={panel.manifest.displayName || panel.manifest.name} current_values={{}}>
    <div class="plugin-panel">
      {#if panel.component}
        {#if isSvelteComponent(panel.component)}
          <!-- Render Svelte component -->
          {@const PanelComp = panel.component}
          <PanelComp {structure} />
        {:else}
          <!-- Container for vanilla JS render function -->
          <div
            class="vanilla-panel-container"
            bind:this={containerRefs[panel.id]}
          ></div>
        {/if}
      {:else}
        <p class="plugin-placeholder">
          {t('structure.plugin_panel_component_missing', { id: panel.id })}
        </p>
      {/if}
    </div>
  </SettingsSection>
{/each}

<style>
  .plugin-panel {
    padding: 4px 0;
  }

  .plugin-placeholder,
  :global(.plugin-error) {
    color: var(--text-muted, #888);
    font-size: 0.85em;
    font-style: italic;
    margin: 0;
  }

  :global(.plugin-error) {
    color: var(--danger, #dc3545);
  }

  .vanilla-panel-container {
    min-height: 20px;
  }

  /* Style for vanilla JS panel content */
  .vanilla-panel-container :global(label) {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
    font-size: 0.9em;
  }

  .vanilla-panel-container :global(select),
  .vanilla-panel-container :global(input[type="number"]) {
    padding: 4px 8px;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 4px;
    background: var(--bg-color, #fff);
    color: var(--text-color, #333);
  }

  .vanilla-panel-container :global(.settings) {
    margin-top: 8px;
    padding-left: 8px;
    border-left: 2px solid var(--border-color, #ddd);
  }

  .vanilla-panel-container :global(h3) {
    margin: 0 0 8px 0;
    font-size: 0.95em;
    font-weight: 600;
  }
</style>

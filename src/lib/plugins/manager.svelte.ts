/**
 * CatGo Plugin Manager
 *
 * Manages plugin lifecycle using Svelte 5 runes for reactivity.
 */

import type {
  PluginManifest,
  LoadedPlugin,
  ViewPlugin,
  PanelPlugin,
  StructureHook,
  StructureHookType,
  PluginContext,
  Permission,
  AtomColorsHook,
  Site,
} from './sdk/types'
import type { LoadedPluginData } from './loader'
import { pluginStorage } from './storage'

// API version supported by this plugin manager
const SUPPORTED_API_VERSION = '1.0'

class PluginManager {
  // Reactive state using Svelte 5 runes
  plugins = $state<Map<string, LoadedPlugin>>(new Map())
  viewPlugins = $state<ViewPlugin[]>([])
  panelPlugins = $state<PanelPlugin[]>([])
  structureHooks = $state<Map<StructureHookType, StructureHook[]>>(new Map())

  loading = $state(false)
  error = $state<string | null>(null)
  initialized = $state(false)

  // Derived state
  enabledPlugins = $derived(
    Array.from(this.plugins.values()).filter((p) => p.active)
  )

  availableViews = $derived(
    this.viewPlugins.filter((v) => this.plugins.get(v.manifest.name)?.active)
  )

  availablePanels = $derived(
    this.panelPlugins.filter((p) => this.plugins.get(p.manifest.name)?.active)
  )

  private context: PluginContext | null = null

  /**
   * Initialize the plugin manager and load stored plugins
   */
  async init(): Promise<void> {
    if (this.initialized) return

    this.loading = true
    this.error = null

    try {
      await pluginStorage.init()

      // Load all stored plugins
      const storedPlugins = await pluginStorage.listPlugins()

      for (const stored of storedPlugins) {
        try {
          await this.loadStoredPlugin(stored.manifest.name)

          // Auto-enable if was enabled before
          if (stored.enabled) {
            await this.enablePlugin(stored.manifest.name)
          }
        } catch (err) {
          console.error(`Failed to load plugin ${stored.manifest.name}:`, err)
        }
      }

      this.initialized = true
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to initialize plugin manager'
      throw err
    } finally {
      this.loading = false
    }
  }

  /**
   * Set the plugin context that will be passed to plugins
   */
  setContext(context: PluginContext): void {
    this.context = context
  }

  /**
   * Install a plugin from a ZIP file
   */
  async installFromZip(fileOrData: File | LoadedPluginData): Promise<PluginManifest> {
    console.log('[PluginManager] installFromZip called, isFile:', fileOrData instanceof File)
    this.loading = true
    this.error = null

    try {
      let manifest: PluginManifest
      let files: Map<string, ArrayBuffer>

      if (fileOrData instanceof File) {
        // Dynamic import JSZip
        const JSZip = (await import('jszip')).default
        const zip = await JSZip.loadAsync(fileOrData)

        // Find manifest
        const manifestFile = zip.file('catgo-plugin.json')
        if (!manifestFile) {
          throw new Error('No catgo-plugin.json manifest found in zip file')
        }

        const manifestContent = await manifestFile.async('string')
        manifest = JSON.parse(manifestContent) as PluginManifest

        // Extract all files
        files = new Map<string, ArrayBuffer>()
        for (const [path, zipEntry] of Object.entries(zip.files)) {
          if (!zipEntry.dir) {
            const content = await zipEntry.async('arraybuffer')
            files.set(path, content)
          }
        }
      } else {
        // Already parsed LoadedPluginData
        console.log('[PluginManager] Using pre-parsed plugin data')
        manifest = fileOrData.manifest
        files = new Map<string, ArrayBuffer>()
        console.log('[PluginManager] Converting', fileOrData.files.size, 'files to ArrayBuffer')
        for (const [path, blob] of fileOrData.files) {
          const content = await blob.arrayBuffer()
          files.set(path, content)
        }
      }

      // Validate manifest
      console.log('[PluginManager] Validating manifest:', manifest.name)
      this.validateManifest(manifest)

      // Save to storage
      console.log('[PluginManager] Saving to storage...')
      await pluginStorage.savePlugin(manifest, files)
      console.log('[PluginManager] Saved to storage successfully')

      // Load the plugin
      console.log('[PluginManager] Loading stored plugin...')
      await this.loadStoredPlugin(manifest.name)
      console.log('[PluginManager] Plugin loaded, total plugins:', this.plugins.size)

      return manifest
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to install plugin'
      throw err
    } finally {
      this.loading = false
    }
  }

  /**
   * Get plugins as an array
   */
  get pluginsArray(): LoadedPlugin[] {
    return Array.from(this.plugins.values())
  }

  /**
   * Get plugin by ID
   */
  get(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id)
  }

  /**
   * Install a plugin from a URL
   */
  async installFromUrl(url: string): Promise<PluginManifest> {
    this.loading = true
    this.error = null

    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch plugin: ${response.statusText}`)
      }

      const blob = await response.blob()
      const file = new File([blob], 'plugin.zip')
      return await this.installFromZip(file)
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to install plugin from URL'
      throw err
    } finally {
      this.loading = false
    }
  }

  /**
   * Load a plugin from storage
   */
  private async loadStoredPlugin(name: string): Promise<void> {
    const stored = await pluginStorage.getPlugin(name)
    if (!stored) {
      throw new Error(`Plugin not found in storage: ${name}`)
    }

    const { manifest, files } = stored

    // Create blob URLs for files
    const blobUrls = new Map<string, string>()
    for (const [path, content] of files) {
      const blob = new Blob([content], { type: this.getMimeType(path) })
      blobUrls.set(path, URL.createObjectURL(blob))
    }

    // Register the plugin
    this.plugins.set(name, {
      id: name,
      manifest,
      module: null,
      active: false,
      enabled: false,
      blobUrls,
    })
  }

  /**
   * Enable a plugin
   */
  async enablePlugin(name: string): Promise<void> {
    console.log(`[PluginManager] enablePlugin called for: ${name}`)
    const plugin = this.plugins.get(name)
    if (!plugin) {
      throw new Error(`Plugin not found: ${name}`)
    }

    if (plugin.active) {
      console.log(`[PluginManager] Plugin ${name} already active`)
      return
    }

    try {
      // Load the module if not loaded
      if (!plugin.module) {
        console.log(`[PluginManager] Loading module for ${name}...`)
        plugin.module = await this.loadPluginModule(plugin)
        console.log(`[PluginManager] Module loaded, exports:`, Object.keys(plugin.module as object))
      }

      // Register contributions
      console.log(`[PluginManager] Registering contributions for ${name}...`)
      await this.registerContributions(plugin)
      console.log(`[PluginManager] After registration - panelPlugins count:`, this.panelPlugins.length)

      // Call activate if exists
      const module = plugin.module as Record<string, unknown>
      if (typeof module.activate === 'function' && this.context) {
        console.log(`[PluginManager] Calling activate() for ${name}`)
        await (module.activate as (ctx: PluginContext) => Promise<void>)(this.context)
      }

      // Create a new object to trigger Svelte reactivity
      const enabledPlugin = { ...plugin, active: true, enabled: true }
      this.plugins.set(name, enabledPlugin)
      console.log(`[PluginManager] Plugin ${name} is now active, panelPlugins:`, this.panelPlugins.length)

      // Persist enabled state
      await pluginStorage.setPluginEnabled(name, true)
    } catch (err) {
      console.error(`[PluginManager] Error enabling plugin ${name}:`, err)
      plugin.error = err instanceof Error ? err.message : 'Activation failed'
      throw err
    }
  }

  /**
   * Disable a plugin
   */
  async disablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin || !plugin.active) return

    try {
      // Call deactivate if exists
      const module = plugin.module as Record<string, unknown>
      if (typeof module.deactivate === 'function') {
        await (module.deactivate as () => Promise<void>)()
      }

      // Unregister contributions
      this.unregisterContributions(plugin)

      // Create a new object to trigger Svelte reactivity
      const disabledPlugin = { ...plugin, active: false, enabled: false }
      this.plugins.set(name, disabledPlugin)

      // Persist disabled state
      await pluginStorage.setPluginEnabled(name, false)
    } catch (err) {
      console.error(`Error deactivating plugin ${name}:`, err)
    }
  }

  /**
   * Uninstall a plugin
   */
  async uninstallPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) return

    // Disable first
    await this.disablePlugin(name)

    // Revoke blob URLs
    if (plugin.blobUrls) {
      for (const url of plugin.blobUrls.values()) {
        URL.revokeObjectURL(url)
      }
    }

    // Remove from storage
    await pluginStorage.deletePlugin(name)
    await pluginStorage.clearPluginSettings(name)

    // Remove from state
    this.plugins.delete(name)
  }

  /**
   * Get hooks for a specific hook type
   */
  getHooks<T extends StructureHook>(type: T['type']): T[] {
    return (this.structureHooks.get(type) || []) as T[]
  }

  /**
   * Apply all atomColors hooks to get final colors for sites
   * @param sites - The structure sites
   * @param currentColors - Initial colors from element scheme or property coloring
   * @returns Array of colors (null means keep the current color)
   */
  applyAtomColorsHooks(
    sites: unknown[],
    currentColors: (string | null)[]
  ): (string | null)[] {
    const hooks = this.getHooks<AtomColorsHook>('atomColors')
    if (hooks.length === 0) return currentColors

    let colors = [...currentColors]
    for (const hook of hooks) {
      // Only apply if the plugin is active
      const plugin = hook.pluginName ? this.plugins.get(hook.pluginName) : null
      if (plugin && !plugin.active) continue

      try {
        const newColors = hook.handler(sites as Site[], colors)
        if (newColors && Array.isArray(newColors)) {
          // Merge: null means keep the existing color
          colors = colors.map((c, i) => newColors[i] ?? c)
        }
      } catch (err) {
        console.error(`[PluginManager] Error in atomColors hook:`, err)
      }
    }
    return colors
  }

  /**
   * Check if plugin requires specific permissions
   */
  checkPermissions(manifest: PluginManifest): {
    safe: Permission[]
    dangerous: Permission[]
  } {
    const permissions = manifest.catgo.permissions || []

    const dangerous: Permission[] = []
    const safe: Permission[] = []

    for (const perm of permissions) {
      if (['filesystem:write', 'network:external', 'compute:gpu'].includes(perm)) {
        dangerous.push(perm)
      } else {
        safe.push(perm)
      }
    }

    return { safe, dangerous }
  }

  // ============ Private Methods ============

  private validateManifest(manifest: PluginManifest): void {
    if (!manifest.name || !manifest.version) {
      throw new Error('Invalid plugin manifest: missing name or version')
    }

    if (!manifest.catgo) {
      throw new Error('Invalid plugin manifest: missing catgo configuration')
    }

    // Check API version
    const apiVersion = manifest.catgo.apiVersion
    const [major] = apiVersion.split('.').map(Number)
    const [supportedMajor] = SUPPORTED_API_VERSION.split('.').map(Number)

    if (major !== supportedMajor) {
      throw new Error(
        `Incompatible API version: ${apiVersion}. Supported: ${SUPPORTED_API_VERSION}`
      )
    }
  }

  private async loadPluginModule(plugin: LoadedPlugin): Promise<unknown> {
    const frontendConfig = plugin.manifest.catgo.frontend
    if (!frontendConfig) {
      return {}
    }

    const { blobUrls } = plugin
    if (!blobUrls) {
      throw new Error('Plugin files not loaded')
    }

    console.log(`[PluginManager] Looking for main module: "${frontendConfig.main}"`)
    console.log(`[PluginManager] Available blob URLs:`, Array.from(blobUrls.keys()))

    const mainUrl = blobUrls.get(frontendConfig.main)
    if (!mainUrl) {
      throw new Error(`Main module not found: ${frontendConfig.main}`)
    }

    console.log(`[PluginManager] Found main URL: ${mainUrl}`)

    // Dynamic import the module
    const module = await import(/* @vite-ignore */ mainUrl)
    console.log(`[PluginManager] Module imported, exports:`, Object.keys(module))

    // Load WASM if specified
    if (frontendConfig.wasm) {
      const wasmUrl = blobUrls.get(frontendConfig.wasm)
      if (wasmUrl) {
        const wasmModule = await WebAssembly.compileStreaming(fetch(wasmUrl))
        ;(module as Record<string, unknown>).__wasm__ = wasmModule
      }
    }

    // Load styles if specified
    if (frontendConfig.styles) {
      const styleUrl = blobUrls.get(frontendConfig.styles)
      if (styleUrl) {
        await this.loadStyles(styleUrl)
      }
    }

    return module
  }

  private async registerContributions(plugin: LoadedPlugin): Promise<void> {
    const contributions = plugin.manifest.catgo.frontend?.contributions
    if (!contributions) return

    const module = plugin.module as Record<string, unknown>

    // Register views
    if (contributions.views) {
      const newViews: ViewPlugin[] = []
      for (const view of contributions.views) {
        // Skip if view already registered
        if (this.viewPlugins.some(v => v.id === view.id)) {
          console.log(`[PluginManager] View ${view.id} already registered, skipping`)
          continue
        }
        const component = module[view.component]
        if (component) {
          newViews.push({
            id: view.id,
            manifest: plugin.manifest,
            component: component as ViewPlugin['component'],
            activate: module.activate as ViewPlugin['activate'],
            deactivate: module.deactivate as ViewPlugin['deactivate'],
          })
        }
      }
      // Reassign array to ensure reactivity
      if (newViews.length > 0) {
        this.viewPlugins = [...this.viewPlugins, ...newViews]
      }
    }

    // Register panels
    if (contributions.panels) {
      console.log('[PluginManager] Registering panels:', contributions.panels.length)
      const newPanels: PanelPlugin[] = []
      for (const panel of contributions.panels) {
        // Skip if panel already registered (prevents duplicates on re-enable)
        if (this.panelPlugins.some(p => p.id === panel.id)) {
          console.log(`[PluginManager] Panel ${panel.id} already registered, skipping`)
          continue
        }
        const component = module[panel.component]
        console.log(`[PluginManager] Panel ${panel.id}: component=${panel.component}, found=${!!component}`)
        if (component) {
          newPanels.push({
            id: panel.id,
            manifest: plugin.manifest,
            component: component as PanelPlugin['component'],
            location: panel.location,
            activate: module.activate as PanelPlugin['activate'],
            deactivate: module.deactivate as PanelPlugin['deactivate'],
          })
          console.log(`[PluginManager] Panel registered: ${panel.id} at ${panel.location}`)
        } else {
          console.warn(`[PluginManager] Panel component not found: ${panel.component}`)
        }
      }
      // Reassign array to ensure reactivity
      if (newPanels.length > 0) {
        this.panelPlugins = [...this.panelPlugins, ...newPanels]
      }
      console.log('[PluginManager] Total panels now:', this.panelPlugins.length)
    }

    // Register structure hooks
    if (contributions.structureHooks) {
      for (const hookContrib of contributions.structureHooks) {
        const handler = module[hookContrib.handler]
        if (typeof handler === 'function') {
          const hooks = this.structureHooks.get(hookContrib.hook) || []
          hooks.push({
            type: hookContrib.hook,
            handler: handler as StructureHook['handler'],
            priority: hookContrib.priority ?? 0,
            pluginName: plugin.manifest.name,
          } as StructureHook)
          // Sort by priority (higher priority runs later, can override)
          hooks.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
          this.structureHooks.set(hookContrib.hook, hooks)
          console.log(`[PluginManager] Registered hook: ${hookContrib.hook} from ${hookContrib.handler}`)
        } else {
          console.warn(`[PluginManager] Hook handler not found or not a function: ${hookContrib.handler}`)
        }
      }
    }
  }

  private unregisterContributions(plugin: LoadedPlugin): void {
    const pluginName = plugin.manifest.name

    // Remove views
    this.viewPlugins = this.viewPlugins.filter((v) => v.manifest.name !== pluginName)

    // Remove panels
    this.panelPlugins = this.panelPlugins.filter((p) => p.manifest.name !== pluginName)

    // Remove hooks (would need to track which hooks belong to which plugin)
    // For simplicity, we rebuild hooks when plugins change
  }

  private getMimeType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase()
    switch (ext) {
      case 'js':
      case 'mjs':
        return 'application/javascript'
      case 'wasm':
        return 'application/wasm'
      case 'css':
        return 'text/css'
      case 'json':
        return 'application/json'
      default:
        return 'application/octet-stream'
    }
  }

  private async loadStyles(url: string): Promise<void> {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = url
    document.head.appendChild(link)
  }
}

// Global plugin manager instance
export const pluginManager = new PluginManager()

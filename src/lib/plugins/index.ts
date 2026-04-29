/**
 * CatGo Plugin System
 *
 * Exports for frontend plugin development and management.
 */

// Plugin Manager
export { pluginManager } from './manager.svelte'

// Storage
export { pluginStorage } from './storage'

// Loader
export {
  loadFromZip,
  loadFromUrl,
  getPermissionDescription,
  getPermissionRisk,
  type LoadedPluginData,
  type LoadError,
  type LoadResult,
} from './loader'

// Components
export { default as PluginManager } from './components/PluginManager.svelte'
export { default as PluginCard } from './components/PluginCard.svelte'
export { default as PluginInstaller } from './components/PluginInstaller.svelte'
export { default as PermissionDialog } from './components/PermissionDialog.svelte'
export { default as PluginPanelHost } from './components/PluginPanelHost.svelte'

// SDK Types
export type {
  // Manifest
  PluginManifest,
  PluginAuthor,
  CatGoPluginConfig,
  Platform,
  Permission,
  SettingDefinition,

  // Frontend
  FrontendConfig,
  FrontendContributions,
  ViewContribution,
  ViewPlugin,
  ViewPluginProps,
  PanelContribution,
  PanelPlugin,
  PanelPluginProps,

  // Structure Hooks
  StructureHookType,
  StructureHookContribution,
  AtomColorsHook,
  AtomRadiiHook,
  SceneOverlayHook,
  ContextMenuHook,
  ContextMenuContext,
  ContextMenuItem,
  StructureHook,

  // Commands
  CommandContribution,

  // Backend
  BackendConfig,
  BackendContributions,
  CalculatorContribution,
  OptimizerContribution,
  RouterContribution,

  // Context API
  PluginContext,
  AppStateAPI,
  StructureAPI,
  UIAPI,
  ProgressHandle,
  BackendAPI,
  WebSocketConnection,
  WasmAPI,
  SettingsAPI,
  EventsAPI,
  PluginEvent,
  StorageAPI,

  // Structure Types
  PymatgenStructure,
  Lattice,
  Site,
  Species,

  // Optimization
  OptimizationRequest,
  OptimizationResult,
  EnergyResult,

  // Internal
  LoadedPlugin,
} from './sdk/types'

/**
 * CatGo Plugin SDK Type Definitions
 *
 * This file defines all interfaces for the plugin system.
 * Plugin developers should import these types to build compatible plugins.
 */

import type { ComponentType } from 'svelte'

// ============ Plugin Manifest Types ============

export interface PluginManifest {
  name: string
  version: string
  displayName: string
  description: string
  author: PluginAuthor
  license?: string
  repository?: string
  keywords?: string[]
  catgo: CatGoPluginConfig
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface PluginAuthor {
  name: string
  email?: string
  url?: string
}

export interface CatGoPluginConfig {
  apiVersion: string
  minAppVersion?: string
  platforms: Platform[]
  frontend?: FrontendConfig
  backend?: BackendConfig
  permissions: Permission[]
  settings?: Record<string, SettingDefinition>
}

export type Platform = 'web' | 'desktop' | 'server'

export type Permission =
  | 'structure:read'
  | 'structure:write'
  | 'structure:modify'
  | 'compute:cpu'
  | 'compute:gpu'
  | 'network:fetch'
  | 'storage:local'
  | 'ui:notification'
  | 'ui:modal'
  | 'filesystem:read'
  | 'filesystem:write'
  | 'network:local'
  | 'network:external'
  | 'wasm:execute'

export interface SettingDefinition {
  type: 'boolean' | 'string' | 'number' | 'select'
  default: unknown
  description: string
  min?: number
  max?: number
  options?: { label: string; value: unknown }[]
}

// ============ Frontend Plugin Config ============

export interface FrontendConfig {
  main: string
  types?: string
  wasm?: string
  styles?: string
  contributions: FrontendContributions
}

export interface FrontendContributions {
  views?: ViewContribution[]
  panels?: PanelContribution[]
  structureHooks?: StructureHookContribution[]
  commands?: CommandContribution[]
}

// ============ View Plugin ============

export interface ViewContribution {
  id: string
  name: string
  icon: string
  location: 'main' | 'sidebar' | 'modal'
  component: string
}

export interface ViewPlugin {
  id: string
  manifest: PluginManifest
  component: ComponentType
  activate?(context: PluginContext): Promise<void> | void
  deactivate?(): Promise<void> | void
}

export interface ViewPluginProps {
  context: PluginContext
  settings: Record<string, unknown>
}

// ============ Panel Plugin ============

export interface PanelContribution {
  id: string
  name: string
  icon: string
  location: 'structure-sidebar' | 'analysis-sidebar' | 'workflow-sidebar'
  component: string
  when?: string
}

export interface PanelPlugin {
  id: string
  manifest: PluginManifest
  component: ComponentType
  location: string
  activate?(context: PluginContext): Promise<void> | void
  deactivate?(): Promise<void> | void
}

export interface PanelPluginProps {
  context: PluginContext
  structure?: PymatgenStructure
  selectedSites?: number[]
  settings: Record<string, unknown>
}

// ============ Structure Hooks ============

export type StructureHookType =
  | 'atomColors'
  | 'atomRadii'
  | 'bondFilter'
  | 'sceneOverlay'
  | 'contextMenu'
  | 'selection'
  | 'tooltip'

export interface StructureHookContribution {
  id: string
  name: string
  hook: StructureHookType
  handler: string
  priority?: number
}

export interface AtomColorsHook {
  type: 'atomColors'
  handler: (sites: Site[], currentColors: (string | null)[]) => (string | null)[]
  priority?: number
  pluginName?: string
}

export interface AtomRadiiHook {
  type: 'atomRadii'
  handler: (sites: Site[], currentRadii: (number | null)[]) => (number | null)[]
  priority?: number
  pluginName?: string
}

export interface SceneOverlayHook {
  type: 'sceneOverlay'
  handler: ComponentType
  priority?: number
  pluginName?: string
}

export interface ContextMenuHook {
  type: 'contextMenu'
  handler: (context: ContextMenuContext) => ContextMenuItem[]
  priority?: number
  pluginName?: string
}

export interface ContextMenuContext {
  structure: PymatgenStructure
  siteIndex: number | null
  position: [number, number, number]
  selectedSites: number[]
}

export interface ContextMenuItem {
  id: string
  label: string
  icon?: string
  action: () => void | Promise<void>
  disabled?: boolean
  submenu?: ContextMenuItem[]
}

export type StructureHook =
  | AtomColorsHook
  | AtomRadiiHook
  | SceneOverlayHook
  | ContextMenuHook

// ============ Command ============

export interface CommandContribution {
  id: string
  title: string
  icon?: string
  keybinding?: string
  handler: string
}

// ============ Backend Config ============

export interface BackendConfig {
  main: string
  requirements?: string
  contributions: BackendContributions
}

export interface BackendContributions {
  calculators?: CalculatorContribution[]
  optimizers?: OptimizerContribution[]
  routers?: RouterContribution[]
}

export interface CalculatorContribution {
  id: string
  name: string
  class: string
  description: string
  supportedElements: string[] | null
}

export interface OptimizerContribution {
  id: string
  name: string
  class: string
  description: string
}

export interface RouterContribution {
  id: string
  prefix: string
  module: string
}

// ============ Plugin Context API ============

export interface PluginContext {
  readonly appState: AppStateAPI
  readonly structure: StructureAPI
  readonly ui: UIAPI
  readonly backend: BackendAPI
  readonly wasm: WasmAPI
  readonly settings: SettingsAPI
  readonly events: EventsAPI
  readonly storage: StorageAPI
}

export interface AppStateAPI {
  readonly activeTab: string
  readonly selectedJob: unknown | null
  navigate(tab: string): void
  openAnalysis(job: unknown): void
}

export interface StructureAPI {
  readonly current: PymatgenStructure | null
  readonly selectedSites: number[]
  setStructure(structure: PymatgenStructure): void
  selectSites(indices: number[]): void
  clearSelection(): void
  addAtom(element: string, position: [number, number, number]): void
  removeAtoms(indices: number[]): void
  moveAtoms(indices: number[], delta: [number, number, number]): void
  getNeighbors(siteIndex: number, cutoff: number): number[]
}

export interface UIAPI {
  showNotification(message: string, type: 'info' | 'success' | 'warning' | 'error'): void
  showModal(component: ComponentType, props?: Record<string, unknown>): Promise<unknown>
  closeModal(): void
  showProgress(title: string, total: number): ProgressHandle
}

export interface ProgressHandle {
  update(current: number, message?: string): void
  complete(): void
  error(message: string): void
}

export interface BackendAPI {
  readonly serverUrl: string
  readonly connected: boolean
  get<T>(path: string): Promise<T>
  post<T>(path: string, data: unknown): Promise<T>
  connectWebSocket(path: string): WebSocketConnection
  optimize(request: OptimizationRequest): Promise<OptimizationResult>
  calculateEnergy(structure: PymatgenStructure, calculator: string): Promise<EnergyResult>
}

export interface WebSocketConnection {
  send(data: unknown): void
  close(): void
  onMessage(handler: (data: unknown) => void): void
  onError(handler: (error: Error) => void): void
  onClose(handler: () => void): void
}

export interface WasmAPI {
  loadModule(wasmPath: string): Promise<WebAssembly.Module>
  instantiate(module: WebAssembly.Module, imports?: WebAssembly.Imports): Promise<WebAssembly.Instance>
  loadPluginWasm(): Promise<unknown>
}

export interface SettingsAPI {
  get<T>(key: string): T
  set(key: string, value: unknown): void
  onChange(key: string, callback: (value: unknown) => void): () => void
}

export interface EventsAPI {
  on(event: PluginEvent, handler: (...args: unknown[]) => void): () => void
  emit(event: PluginEvent, ...args: unknown[]): void
}

export type PluginEvent =
  | 'structure:loaded'
  | 'structure:modified'
  | 'selection:changed'
  | 'optimization:started'
  | 'optimization:progress'
  | 'optimization:completed'

export interface StorageAPI {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

// ============ Structure Types ============

export interface PymatgenStructure {
  lattice: Lattice
  sites: Site[]
  charge?: number
  properties?: Record<string, unknown>
}

export interface Lattice {
  matrix: [[number, number, number], [number, number, number], [number, number, number]]
  pbc?: [boolean, boolean, boolean]
}

export interface Site {
  species: Species[]
  abc: [number, number, number]
  xyz: [number, number, number]
  label?: string
  properties?: Record<string, unknown>
}

export interface Species {
  element: string
  occu: number
  oxidation_state?: number
}

// ============ Optimization Types ============

export interface OptimizationRequest {
  structure: PymatgenStructure
  calculator: string
  calculator_params?: Record<string, unknown>
  fmax?: number
  steps?: number
  optimize_cell?: boolean
  return_trajectory?: boolean
}

export interface OptimizationResult {
  success: boolean
  message: string
  initial_energy?: number
  final_energy?: number
  energy_change?: number
  steps_taken?: number
  trajectory?: PymatgenStructure[]
  final_structure?: PymatgenStructure
}

export interface EnergyResult {
  energy: number
  energy_per_atom: number
  forces?: number[][]
  fmax?: number
  units: string
}

// ============ Loaded Plugin State ============

export interface LoadedPlugin {
  id: string
  manifest: PluginManifest
  module: unknown
  active: boolean
  enabled: boolean
  error?: string
  blobUrls?: Map<string, string>
}

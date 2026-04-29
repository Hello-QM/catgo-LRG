/**
 * Plugin Loader
 *
 * Handles loading plugins from various sources:
 * - ZIP files (uploaded or from URL)
 * - Direct URL to plugin directory
 */

import JSZip from 'jszip'
import type { PluginManifest, Permission } from './sdk/types'

export interface LoadedPluginData {
  manifest: PluginManifest
  files: Map<string, Blob>
  mainModule?: string
  wasmModule?: Blob
}

export interface LoadError {
  type: 'manifest' | 'download' | 'parse' | 'validation'
  message: string
}

export type LoadResult =
  | { success: true; data: LoadedPluginData }
  | { success: false; error: LoadError }

/**
 * Load a plugin from a ZIP file
 */
export async function loadFromZip(file: File | Blob): Promise<LoadResult> {
  try {
    const zip = await JSZip.loadAsync(file)

    // Find manifest file
    const manifestFile =
      zip.file('catgo-plugin.json') || zip.file('plugin.json')

    if (!manifestFile) {
      return {
        success: false,
        error: {
          type: 'manifest',
          message:
            'No plugin manifest found. Expected catgo-plugin.json or plugin.json',
        },
      }
    }

    // Parse manifest
    let manifest: PluginManifest
    try {
      const manifestText = await manifestFile.async('text')
      manifest = JSON.parse(manifestText)
    } catch {
      return {
        success: false,
        error: {
          type: 'parse',
          message: 'Failed to parse plugin manifest JSON',
        },
      }
    }

    // Validate manifest
    const validationError = validateManifest(manifest)
    if (validationError) {
      return {
        success: false,
        error: {
          type: 'validation',
          message: validationError,
        },
      }
    }

    // Extract all files
    const files = new Map<string, Blob>()
    for (const [path, zipEntry] of Object.entries(zip.files)) {
      if (!zipEntry.dir) {
        const blob = await zipEntry.async('blob')
        files.set(path, blob)
      }
    }

    // Find main module
    let mainModule: string | undefined
    const frontendConfig = manifest.catgo?.frontend
    if (frontendConfig?.main) {
      const mainPath = frontendConfig.main.replace(/^\.\//, '')
      if (files.has(mainPath)) {
        mainModule = await zip.file(mainPath)?.async('text')
      }
    }

    // Find WASM module
    let wasmModule: Blob | undefined
    if (frontendConfig?.wasm) {
      const wasmPath = frontendConfig.wasm.replace(/^\.\//, '')
      wasmModule = files.get(wasmPath)
    }

    return {
      success: true,
      data: {
        manifest,
        files,
        mainModule,
        wasmModule,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: {
        type: 'parse',
        message: `Failed to read ZIP file: ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
    }
  }
}

/**
 * Load a plugin from a URL
 */
export async function loadFromUrl(url: string): Promise<LoadResult> {
  try {
    // First try to fetch as ZIP
    const response = await fetch(url)
    if (!response.ok) {
      return {
        success: false,
        error: {
          type: 'download',
          message: `Failed to download: ${response.status} ${response.statusText}`,
        },
      }
    }

    const contentType = response.headers.get('content-type') || ''

    if (
      contentType.includes('application/zip') ||
      url.endsWith('.zip')
    ) {
      // Handle as ZIP file
      const blob = await response.blob()
      return loadFromZip(blob)
    }

    // Try to fetch manifest directly (assuming URL points to plugin directory)
    const manifestUrl = url.endsWith('/')
      ? `${url}catgo-plugin.json`
      : `${url}/catgo-plugin.json`

    const manifestResponse = await fetch(manifestUrl)
    if (!manifestResponse.ok) {
      return {
        success: false,
        error: {
          type: 'manifest',
          message: 'Could not find plugin manifest at URL',
        },
      }
    }

    let manifest: PluginManifest
    try {
      manifest = await manifestResponse.json()
    } catch {
      return {
        success: false,
        error: {
          type: 'parse',
          message: 'Failed to parse plugin manifest',
        },
      }
    }

    const validationError = validateManifest(manifest)
    if (validationError) {
      return {
        success: false,
        error: {
          type: 'validation',
          message: validationError,
        },
      }
    }

    // Fetch main module
    const baseUrl = url.endsWith('/') ? url : `${url}/`
    const files = new Map<string, Blob>()
    let mainModule: string | undefined
    let wasmModule: Blob | undefined

    const frontendConfig = manifest.catgo?.frontend
    if (frontendConfig?.main) {
      const mainPath = frontendConfig.main.replace(/^\.\//, '')
      const mainResponse = await fetch(`${baseUrl}${mainPath}`)
      if (mainResponse.ok) {
        mainModule = await mainResponse.text()
        files.set(mainPath, new Blob([mainModule], { type: 'text/javascript' }))
      }
    }

    if (frontendConfig?.wasm) {
      const wasmPath = frontendConfig.wasm.replace(/^\.\//, '')
      const wasmResponse = await fetch(`${baseUrl}${wasmPath}`)
      if (wasmResponse.ok) {
        wasmModule = await wasmResponse.blob()
        files.set(wasmPath, wasmModule)
      }
    }

    return {
      success: true,
      data: {
        manifest,
        files,
        mainModule,
        wasmModule,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: {
        type: 'download',
        message: `Network error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
    }
  }
}

/**
 * Validate a plugin manifest
 */
function validateManifest(manifest: PluginManifest): string | null {
  if (!manifest.name) {
    return 'Missing required field: name'
  }
  if (!manifest.version) {
    return 'Missing required field: version'
  }
  if (!manifest.catgo) {
    return 'Missing required field: catgo'
  }
  if (!manifest.catgo.apiVersion) {
    return 'Missing required field: catgo.apiVersion'
  }

  // Check for at least one contribution
  const frontend = manifest.catgo.frontend
  const backend = manifest.catgo.backend

  if (!frontend && !backend) {
    return 'Plugin must have at least frontend or backend configuration'
  }

  if (frontend) {
    if (!frontend.main) {
      return 'Frontend config missing required field: main'
    }
  }

  return null
}

/**
 * Get human-readable permission descriptions
 */
export function getPermissionDescription(permission: Permission): string {
  const descriptions: Record<Permission, string> = {
    'structure:read': 'Read structure data',
    'structure:write': 'Replace or save structure data',
    'structure:modify': 'Modify structure data in place',
    'compute:cpu': 'Use CPU for calculations',
    'compute:gpu': 'Use GPU for calculations',
    'network:fetch': 'Make network requests',
    'network:local': 'Access local network services',
    'network:external': 'Access external network services',
    'storage:local': 'Store data locally',
    'filesystem:read': 'Read files from disk',
    'filesystem:write': 'Write files to disk',
    'ui:notification': 'Show notifications',
    'ui:modal': 'Show modal dialogs',
    'wasm:execute': 'Execute WebAssembly modules',
  }
  return descriptions[permission] || permission
}

/**
 * Get permission risk level
 */
export function getPermissionRisk(
  permission: Permission
): 'low' | 'medium' | 'high' {
  const highRisk: Permission[] = ['structure:write', 'compute:gpu']
  const mediumRisk: Permission[] = ['network:fetch', 'storage:local']

  if (highRisk.includes(permission)) return 'high'
  if (mediumRisk.includes(permission)) return 'medium'
  return 'low'
}

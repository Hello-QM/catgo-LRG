/**
 * Plugin Storage Layer
 *
 * Uses IndexedDB to persist installed plugins across sessions.
 */

import type { PluginManifest } from './sdk/types'

const DB_NAME = 'catgo-plugins'
const DB_VERSION = 1
const PLUGINS_STORE = 'plugins'
const SETTINGS_STORE = 'plugin-settings'

interface StoredPlugin {
  name: string
  manifest: PluginManifest
  files: Record<string, Uint8Array> // Use Uint8Array for reliable IndexedDB storage
  installedAt: number
  enabled: boolean
}

class PluginStorage {
  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null

  async init(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        console.error('Failed to open plugins database:', request.error)
        reject(request.error)
      }

      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        // Create plugins store
        if (!db.objectStoreNames.contains(PLUGINS_STORE)) {
          const store = db.createObjectStore(PLUGINS_STORE, { keyPath: 'name' })
          store.createIndex('installedAt', 'installedAt', { unique: false })
          store.createIndex('enabled', 'enabled', { unique: false })
        }

        // Create settings store
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' })
        }
      }
    })

    return this.initPromise
  }

  async savePlugin(
    manifest: PluginManifest,
    files: Map<string, ArrayBuffer>,
    enabled = false
  ): Promise<void> {
    await this.init()
    if (!this.db) throw new Error('Database not initialized')

    const transaction = this.db.transaction([PLUGINS_STORE], 'readwrite')
    const store = transaction.objectStore(PLUGINS_STORE)

    // Deep clone the manifest to remove any Proxy wrappers (from Svelte 5 $state)
    // This is necessary because IndexedDB cannot clone Proxy objects
    const clonedManifest = JSON.parse(JSON.stringify(manifest)) as PluginManifest

    // Convert ArrayBuffers to Uint8Arrays for reliable storage
    const filesObj: Record<string, Uint8Array> = {}
    for (const [path, buffer] of files) {
      filesObj[path] = new Uint8Array(buffer)
    }

    const pluginData: StoredPlugin = {
      name: clonedManifest.name,
      manifest: clonedManifest,
      files: filesObj,
      installedAt: Date.now(),
      enabled,
    }

    return new Promise((resolve, reject) => {
      const request = store.put(pluginData)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  async getPlugin(name: string): Promise<{
    manifest: PluginManifest
    files: Map<string, ArrayBuffer>
    enabled: boolean
  } | null> {
    await this.init()
    if (!this.db) throw new Error('Database not initialized')

    const transaction = this.db.transaction([PLUGINS_STORE], 'readonly')
    const store = transaction.objectStore(PLUGINS_STORE)

    return new Promise((resolve, reject) => {
      const request = store.get(name)
      request.onsuccess = () => {
        if (request.result) {
          const data = request.result as StoredPlugin
          // Convert Uint8Arrays back to ArrayBuffers
          const filesMap = new Map<string, ArrayBuffer>()
          for (const [path, uint8Array] of Object.entries(data.files)) {
            filesMap.set(path, uint8Array.buffer.slice(
              uint8Array.byteOffset,
              uint8Array.byteOffset + uint8Array.byteLength
            ) as ArrayBuffer)
          }
          resolve({
            manifest: data.manifest,
            files: filesMap,
            enabled: data.enabled,
          })
        } else {
          resolve(null)
        }
      }
      request.onerror = () => reject(request.error)
    })
  }

  async listPlugins(): Promise<
    Array<{ manifest: PluginManifest; enabled: boolean; installedAt: number }>
  > {
    await this.init()
    if (!this.db) throw new Error('Database not initialized')

    const transaction = this.db.transaction([PLUGINS_STORE], 'readonly')
    const store = transaction.objectStore(PLUGINS_STORE)

    return new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = () => {
        resolve(
          (request.result as StoredPlugin[]).map((data) => ({
            manifest: data.manifest,
            enabled: data.enabled,
            installedAt: data.installedAt,
          }))
        )
      }
      request.onerror = () => reject(request.error)
    })
  }

  async setPluginEnabled(name: string, enabled: boolean): Promise<void> {
    await this.init()
    if (!this.db) throw new Error('Database not initialized')

    const transaction = this.db.transaction([PLUGINS_STORE], 'readwrite')
    const store = transaction.objectStore(PLUGINS_STORE)

    return new Promise((resolve, reject) => {
      const getRequest = store.get(name)
      getRequest.onsuccess = () => {
        if (getRequest.result) {
          const data = getRequest.result as StoredPlugin
          data.enabled = enabled
          const putRequest = store.put(data)
          putRequest.onsuccess = () => resolve()
          putRequest.onerror = () => reject(putRequest.error)
        } else {
          reject(new Error(`Plugin not found: ${name}`))
        }
      }
      getRequest.onerror = () => reject(getRequest.error)
    })
  }

  async deletePlugin(name: string): Promise<void> {
    await this.init()
    if (!this.db) throw new Error('Database not initialized')

    const transaction = this.db.transaction([PLUGINS_STORE], 'readwrite')
    const store = transaction.objectStore(PLUGINS_STORE)

    return new Promise((resolve, reject) => {
      const request = store.delete(name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  // Settings storage for plugins
  async getSetting<T>(pluginName: string, key: string): Promise<T | null> {
    await this.init()
    if (!this.db) throw new Error('Database not initialized')

    const fullKey = `${pluginName}:${key}`
    const transaction = this.db.transaction([SETTINGS_STORE], 'readonly')
    const store = transaction.objectStore(SETTINGS_STORE)

    return new Promise((resolve, reject) => {
      const request = store.get(fullKey)
      request.onsuccess = () => {
        resolve(request.result?.value ?? null)
      }
      request.onerror = () => reject(request.error)
    })
  }

  async setSetting(pluginName: string, key: string, value: unknown): Promise<void> {
    await this.init()
    if (!this.db) throw new Error('Database not initialized')

    const fullKey = `${pluginName}:${key}`
    const transaction = this.db.transaction([SETTINGS_STORE], 'readwrite')
    const store = transaction.objectStore(SETTINGS_STORE)

    return new Promise((resolve, reject) => {
      const request = store.put({ key: fullKey, value })
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  async getPluginSettings(pluginName: string): Promise<Record<string, unknown>> {
    await this.init()
    if (!this.db) throw new Error('Database not initialized')

    const prefix = `${pluginName}:`
    const transaction = this.db.transaction([SETTINGS_STORE], 'readonly')
    const store = transaction.objectStore(SETTINGS_STORE)

    return new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = () => {
        const settings: Record<string, unknown> = {}
        for (const item of request.result) {
          if (item.key.startsWith(prefix)) {
            const key = item.key.slice(prefix.length)
            settings[key] = item.value
          }
        }
        resolve(settings)
      }
      request.onerror = () => reject(request.error)
    })
  }

  async clearPluginSettings(pluginName: string): Promise<void> {
    await this.init()
    if (!this.db) throw new Error('Database not initialized')

    const settings = await this.getPluginSettings(pluginName)
    const transaction = this.db.transaction([SETTINGS_STORE], 'readwrite')
    const store = transaction.objectStore(SETTINGS_STORE)

    const prefix = `${pluginName}:`
    for (const key of Object.keys(settings)) {
      store.delete(prefix + key)
    }
  }
}

export const pluginStorage = new PluginStorage()

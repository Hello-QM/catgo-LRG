// CatGo settings - re-export shim
// Split into: types.ts (type definitions), config.ts (SETTINGS_CONFIG), defaults.ts (DEFAULTS, merge, PD_DEFAULTS)

export * from './types'
export * from './config'
export * from './defaults'

// Runtime backend-URL control (Model C) + its store/persistence helpers.
export { default as BackendUrlSettings } from './BackendUrlSettings.svelte'
// "Connect & Check" wizard — probe/connect a backend then render diagnostics.
export { default as ConnectWizard } from './ConnectWizard.svelte'
export {
  apply_backend_url,
  backend_url_store,
  BACKEND_URL_STORAGE_KEY,
  DEFAULT_BACKEND_URL,
  init_backend_url,
  load_backend_url,
  save_backend_url,
} from '$lib/api/backend-url.svelte'

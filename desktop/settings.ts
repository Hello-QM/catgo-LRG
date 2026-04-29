/**
 * Settings persistence — extracted from App.svelte.
 *
 * Pure localStorage read/write for scene viewer settings.
 */

export const SETTINGS_KEY = `catgo-settings`

export interface PersistedSettings {
  camera_projection?: `perspective` | `orthographic`
  zoom_speed?: number
  rotate_speed?: number
  pan_speed?: number
  zoom_to_cursor?: boolean
  show_bonds?: string
  atom_radius?: number
  same_size_atoms?: boolean
  show_site_labels?: boolean
  show_site_indices?: boolean
  ambient_light?: number
  directional_light?: number
}

export function load_settings(): PersistedSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY)
    if (saved) return JSON.parse(saved)
  } catch (err) {
    console.warn(`Failed to load settings:`, err)
  }
  return {}
}

export function save_settings(settings: PersistedSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch (err) {
    console.warn(`Failed to save settings:`, err)
  }
}

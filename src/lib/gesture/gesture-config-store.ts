/**
 * localStorage persistence for gesture configuration.
 *
 * Follows the same pattern as chat-state.svelte.ts for chat config.
 */

import { DEFAULT_GESTURE_CONFIG, type GestureConfig } from './gesture-types'

const STORAGE_KEY = `catgo-gesture-config`

/** Load gesture config from localStorage, merging with defaults for new fields. */
export function load_gesture_config(): GestureConfig {
  try {
    if (typeof window === `undefined`) return { ...DEFAULT_GESTURE_CONFIG }
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return { ...DEFAULT_GESTURE_CONFIG }
    const parsed = JSON.parse(stored) as Partial<GestureConfig>
    return { ...DEFAULT_GESTURE_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_GESTURE_CONFIG }
  }
}

/** Save gesture config to localStorage. */
export function save_gesture_config(config: GestureConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // silently fail
  }
}

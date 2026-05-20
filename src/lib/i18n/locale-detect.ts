/**
 * System locale detection for CatGo LRG.
 *
 * Priority:  localStorage override  →  navigator.language  →  fallback 'en'
 *
 * Works in both Tauri (desktop) and plain browser environments.
 */

import type { Locale, LocalePreference } from './types'

const STORAGE_KEY = `catgo-locale`

/** Read the raw preference string from localStorage. */
export function get_saved_preference(): LocalePreference {
  try {
    if (typeof window !== `undefined` && globalThis.localStorage) {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved === `en` || saved === `zh` || saved === `system`) {
        return saved
      }
    }
  } catch {
    // localStorage unavailable (SSR, test env, etc.)
  }
  return `system`
}

/** Persist a locale preference to localStorage. */
export function save_preference(pref: LocalePreference): void {
  try {
    if (typeof window !== `undefined` && globalThis.localStorage) {
      localStorage.setItem(STORAGE_KEY, pref)
    }
  } catch {
    // Silently fail
  }
}

/**
 * Detect the system (OS / browser) locale.
 *
 * Returns 'zh' when the primary browser language starts with 'zh',
 * otherwise defaults to 'en'.
 */
export function detect_system_locale(): Locale {
  try {
    if (typeof navigator !== `undefined`) {
      const lang = navigator.language || (navigator.languages?.[0] ?? ``)
      if (lang.startsWith(`zh`)) return `zh`
    }
  } catch {
    // SSR or restricted env
  }
  return `en`
}

/**
 * Resolve the effective locale to use.
 *
 * If the preference is 'system', falls back to OS detection.
 */
export function resolve_locale(pref: LocalePreference): Locale {
  if (pref === `en` || pref === `zh`) return pref
  return detect_system_locale()
}

/**
 * One-shot helper: read saved preference → resolve to a concrete locale.
 *
 * Called once during i18n init.
 */
export function get_initial_locale(): Locale {
  return resolve_locale(get_saved_preference())
}

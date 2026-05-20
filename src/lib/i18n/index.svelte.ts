/**
 * i18n core — reactive translation engine for CatGo LRG.
 *
 * ## Design
 * - **Svelte 5 runes** (`$state`) for reactivity — all components that call
 *   `t()` re-render automatically when the locale changes.
 * - **Lazy module loading** — only `common` is loaded at startup (~10 KB).
 *   Feature-area packs (`structure`, `workflow`, …) are loaded on demand via
 *   `load_i18n_module()`.
 * - **Flat keys** — each module exports a `Record<string, string>`.  Keys are
 *   scoped by module name at lookup time: `t('common.save')`.
 *
 * ## Memory management
 * - Loaded translation maps are stored in a plain `Map` (not `SvelteMap`).
 *   A top-level `$state` revision counter (`_rev`) is bumped on every map
 *   mutation so Svelte tracks the change without making the entire Map deeply
 *   reactive (which would be wasteful for ~2 000 key-value pairs).
 * - Switching locale clears the cache and reloads only the modules that were
 *   previously active.
 */

import type { Locale, LocalePreference, TranslationModule, InterpolationParams } from './types'
import { get_initial_locale, get_saved_preference, save_preference, resolve_locale } from './locale-detect'

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

/** Effective locale ('en' | 'zh'). */
let _locale = $state<Locale>(get_initial_locale())

/** User preference ('en' | 'zh' | 'system'). */
let _preference = $state<LocalePreference>(get_saved_preference())

/**
 * Revision counter — bumped whenever the translation cache changes.
 * Components that call `t()` read this via the getter, creating a dependency
 * so Svelte re-renders them.  This is much cheaper than making the entire Map
 * deeply reactive.
 */
let _rev = $state(0)

// ---------------------------------------------------------------------------
// Translation cache (non-reactive Map — mutations tracked via _rev)
// ---------------------------------------------------------------------------

const _cache = new Map<string, Record<string, string>>()

// ---------------------------------------------------------------------------
// Dynamic importers — one per module per locale.
// Vite's `import()` with a template literal creates a glob at build time,
// so every `en/*.ts` and `zh/*.ts` file is included as a lazy chunk.
// ---------------------------------------------------------------------------

type ModuleImporter = () => Promise<{ default: Record<string, string> }>

const _importers: Record<Locale, Record<string, ModuleImporter>> = {
  en: {
    common:    () => import('./en/common'),
    app:       () => import('./en/app'),
    sidebar:   () => import('./en/sidebar'),
    structure: () => import('./en/structure'),
    workflow:  () => import('./en/workflow'),
    chat:      () => import('./en/chat'),
  },
  zh: {
    common:    () => import('./zh/common'),
    app:       () => import('./zh/app'),
    sidebar:   () => import('./zh/sidebar'),
    structure: () => import('./zh/structure'),
    workflow:  () => import('./zh/workflow'),
    chat:      () => import('./zh/chat'),
  },
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Current effective locale (reactive getter). */
export function get_locale(): Locale {
  return _locale
}

/** Current user preference (reactive getter). */
export function get_preference(): LocalePreference {
  return _preference
}

/**
 * Core translation function.
 *
 * @param key   Dot-separated key: `"module.sub_key"`.
 *              Example: `t('common.save')`, `t('sidebar.open_file')`.
 * @param params  Optional interpolation: `t('app.atoms', { n: 42 })` replaces
 *                `{n}` in the translated string.
 * @returns The translated string, or the raw key as fallback.
 */
export function t(key: string, params?: InterpolationParams): string {
  // Touch _rev so Svelte tracks this read
  void _rev

  const dot = key.indexOf(`.`)
  if (dot < 0) return key // no module prefix — return as-is

  const mod = key.slice(0, dot)
  const sub = key.slice(dot + 1)

  const map = _cache.get(mod)
  const value = map?.[sub]
  if (value == null) return key // missing → return key (acts as English fallback in dev)

  if (!params) return value
  return value.replace(/\{(\w+)\}/g, (_, k) => {
    const v = params[k]
    return v != null ? String(v) : `{${k}}`
  })
}

/**
 * Load a translation module into the cache (no-op if already loaded).
 *
 * Call this at the top of a feature component's `<script>`:
 * ```ts
 * import { load_i18n_module } from '$lib/i18n'
 * load_i18n_module('structure')
 * ```
 */
export async function load_i18n_module(name: TranslationModule): Promise<void> {
  if (_cache.has(name)) return

  const importer = _importers[_locale]?.[name]
  if (!importer) {
    console.warn(`[i18n] No importer for module "${name}" in locale "${_locale}"`)
    return
  }
  try {
    const mod = await importer()
    _cache.set(name, mod.default)
    _rev++
  } catch (err) {
    console.error(`[i18n] Failed to load module "${name}" for locale "${_locale}":`, err)
  }
}

/**
 * Switch the locale.
 *
 * - Saves the preference to localStorage.
 * - Clears the translation cache.
 * - Reloads all modules that were previously loaded.
 */
export async function set_locale(pref: LocalePreference): Promise<void> {
  _preference = pref
  save_preference(pref)

  const new_locale = resolve_locale(pref)
  if (new_locale === _locale && _cache.size > 0) return // no change

  _locale = new_locale

  // Remember which modules were loaded, then clear
  const active_modules = [..._cache.keys()]
  _cache.clear()
  _rev++

  // Reload all previously-active modules for the new locale
  await Promise.all(active_modules.map((m) => load_i18n_module(m as TranslationModule)))
}

/**
 * Initialise the i18n system.
 *
 * Loads the `common` module synchronously-ish (awaited at app startup).
 * Must be called once in the root component before any `t()` calls.
 */
export async function init_i18n(): Promise<void> {
  await load_i18n_module(`common`)
}

/**
 * Synchronously seed translation modules for unit tests.
 *
 * Runtime code should continue using `init_i18n()` / `load_i18n_module()` so
 * feature packs stay lazy-loaded. Vitest component tests, however, often mount
 * a component and assert text immediately; seeding avoids transient raw i18n
 * keys before dynamic imports resolve.
 */
export function seed_i18n_for_tests(
  locale: Locale,
  modules: Partial<Record<TranslationModule, Record<string, string>>>,
): void {
  _locale = locale
  _preference = locale
  _cache.clear()
  for (const [name, map] of Object.entries(modules)) {
    if (map) _cache.set(name, map)
  }
  _rev++
}

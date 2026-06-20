/**
 * i18n type definitions for CatGo LRG.
 *
 * Supports 'en' and 'zh' locales.
 * Translation modules are loaded lazily per feature area.
 */

/** Supported locale identifiers. */
export type Locale = 'en' | 'zh'

/** User preference: explicit locale or follow the OS. */
export type LocalePreference = Locale | 'system'

/** A flat key→value map exported by each translation module. */
export type TranslationMap = Record<string, string>

/**
 * Names of translation modules.  Each maps to a file under `en/` and `zh/`.
 * Only `common` is loaded at startup; the rest are lazy-loaded on demand.
 */
export type TranslationModule =
  | 'common'
  | 'app'
  | 'sidebar'
  | 'structure'
  | 'workflow'
  | 'chat'
  | 'mobile'
  | 'viewer'

/** Parameters that can be interpolated into a translation string via `{key}`. */
export type InterpolationParams = Record<string, string | number>

import en from './messages/en'
import zhCN from './messages/zh-CN'

export type AppLanguage = 'auto' | 'en' | 'zh-CN'
export type ResolvedLanguage = 'en' | 'zh-CN'

type Messages = typeof en

type MessageKey = keyof Messages

const STORAGE_KEY_APP_LANGUAGE = `catgo-app-language`

const dictionaries: Record<ResolvedLanguage, Messages> = {
  en,
  'zh-CN': zhCN,
}

function detect_browser_language(): ResolvedLanguage {
  if (typeof navigator === `undefined`) return `en`
  const lang = navigator.language || (navigator as any).userLanguage || `en`
  return lang.startsWith(`zh`) ? `zh-CN` : `en`
}

function load_language(): AppLanguage {
  try {
    if (typeof window === `undefined` || typeof localStorage === `undefined`) return `auto`
    const stored = localStorage.getItem(STORAGE_KEY_APP_LANGUAGE)
    if (stored === `en` || stored === `zh-CN` || stored === `auto`) return stored
    return `auto`
  } catch {
    return `auto`
  }
}

function save_language(lang: AppLanguage): void {
  try {
    if (typeof window === `undefined` || typeof localStorage === `undefined`) return
    localStorage.setItem(STORAGE_KEY_APP_LANGUAGE, lang)
  } catch {}
}

export const app_language = $state<{ value: AppLanguage }>({ value: load_language() })

export function set_app_language(lang: AppLanguage): void {
  app_language.value = lang
  save_language(lang)
}

export function get_resolved_language(): ResolvedLanguage {
  return app_language.value === `auto` ? detect_browser_language() : app_language.value
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const lang = get_resolved_language()
  const template = dictionaries[lang][key] ?? dictionaries.en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
}

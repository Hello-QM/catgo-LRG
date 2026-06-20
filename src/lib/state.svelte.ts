import type { ChemicalElement, ElementCategory, Vec3 } from '$lib'
import { AUTO_THEME, COLOR_THEMES, THEME_TYPE } from '$lib/theme/index'
import { default_category_colors, default_element_colors } from './colors'
import type { Tooltip } from './plot'
import type { ThemeMode, ThemeType } from './theme'

export const selected = $state<{
  category: ElementCategory | null
  element: ChemicalElement | null
  last_element: ChemicalElement | null
  heatmap_key: keyof ChemicalElement | null
}>({
  category: null,
  element: null,
  last_element: null,
  heatmap_key: null,
})

export const colors = $state<{
  category: typeof default_category_colors
  element: typeof default_element_colors
}>({
  category: { ...default_category_colors },
  element: { ...default_element_colors },
})

export const tooltip = $state<Tooltip>({ show: false, x: 0, y: 0, title: ``, items: [] })

export const periodic_table_state = $state({
  show_bonding_info: false,
  show_oxidation_state: false,
  highlighted_elements: [] as string[],
})

// Theme state with safe initialization
let initial_theme_mode: ThemeMode = AUTO_THEME
let initial_system_mode: ThemeType = COLOR_THEMES.light

// Safe theme initialization for test environments
try {
  if (typeof window !== `undefined` && globalThis.localStorage) {
    initial_theme_mode = (localStorage.getItem(`catgo-theme`) as ThemeMode) ||
      AUTO_THEME
  } else {
    initial_theme_mode = AUTO_THEME
    initial_system_mode = COLOR_THEMES.light
  }
} catch {
  // Fallback for test environments or when localStorage is not available
}

export const theme_state = $state<
  { mode: ThemeMode; system_mode: ThemeType; type: ThemeType }
>({
  mode: initial_theme_mode,
  system_mode: initial_system_mode,
  get type() {
    // For AUTO_THEME, use system_mode, otherwise lookup the mode in THEME_TYPE
    const effective_mode = this.mode === AUTO_THEME ? this.system_mode : this.mode
    return THEME_TYPE[effective_mode as keyof typeof THEME_TYPE]
  },
})

// Pane font-size preference
const PANE_FONT_SIZE_KEY = `catgo-pane-font-size`
export const DEFAULT_PANE_FONT_SIZE = 0.85 // em

let initial_pane_font_size = DEFAULT_PANE_FONT_SIZE
try {
  if (typeof window !== `undefined` && globalThis.localStorage) {
    const saved = localStorage.getItem(PANE_FONT_SIZE_KEY)
    if (saved) {
      const parsed = parseFloat(saved)
      if (!isNaN(parsed) && parsed >= 0.65 && parsed <= 1.3) {
        initial_pane_font_size = parsed
      }
    }
  }
} catch {
  // Fallback for test environments
}

export const pane_font_size_state = $state<{ size: number }>({
  size: initial_pane_font_size,
})

// Terminal font preferences
const TERMINAL_FONT_KEY = `catgo-terminal-font`
export const DEFAULT_TERMINAL_FONT_SIZE = 13
// Per-glyph fallback chain so the terminal renders Nerd Font icons (powerline /
// statusline), emoji, and CJK that the primary monospace fonts lack. Without
// it those glyphs show as tofu boxes (the primary fonts contain none of them,
// and a bare `monospace` fallback doesn't cover Nerd/emoji). Native terminals
// (kitty, gnome-terminal) don't have this problem because fontconfig supplies
// the fallback automatically.
//
// ORDER MATTERS: a real monospace Latin net ('DejaVu Sans Mono' / 'Liberation
// Mono' / generic `monospace`) sits BEFORE the emoji/CJK fonts. If the primary
// font is missing (e.g. proprietary Menlo/Consolas on Linux, or a bundled
// @font-face that failed to load), per-glyph matching must catch Latin on a
// real monospace — NOT fall through to a proportional CJK font like Noto Sans
// CJK SC, which would size every cell to the wrong advance and render the
// terminal as wide-spaced "garbled" text. CJK fonts stay last so they only
// ever serve CJK codepoints, which the Latin/symbol fonts don't cover.
export const TERMINAL_GLYPH_FALLBACK =
  `'Symbols Nerd Font Mono', 'Symbols Nerd Font', 'DejaVu Sans Mono', 'Liberation Mono', monospace, 'Noto Color Emoji', 'Apple Color Emoji', 'Noto Sans CJK SC', 'Microsoft YaHei'`

/**
 * Re-attach the current glyph fallback chain to a primary font. Idempotent and
 * self-migrating: a saved value embedding an OLD chain ordering is normalized
 * back to its primary and re-suffixed with the current chain, so existing users
 * pick up ordering fixes (e.g. the CJK-before-monospace bug) on next load.
 */
export function with_glyph_fallback(family: string): string {
  if (!family) return DEFAULT_TERMINAL_FONT_FAMILY
  // The bare fallback chain itself (the "monospace" picker option) — already current.
  if (family.trim().startsWith(`'Symbols Nerd Font`)) return TERMINAL_GLYPH_FALLBACK
  // Strip any previously-appended fallback chain (it always begins at the Nerd
  // Font token) plus a trailing bare `monospace`, leaving just the primary.
  let primary = family.replace(/,\s*'Symbols Nerd Font[\s\S]*$/i, ``).trim()
  primary = primary.replace(/,\s*monospace\s*$/i, ``).trim()
  return primary ? `${primary}, ${TERMINAL_GLYPH_FALLBACK}` : TERMINAL_GLYPH_FALLBACK
}

export const DEFAULT_TERMINAL_FONT_FAMILY = `'JetBrains Mono', ${TERMINAL_GLYPH_FALLBACK}`

export const TERMINAL_FONT_FAMILIES: { label: string; value: string }[] = [
  { label: `JetBrains Mono`, value: `'JetBrains Mono', ${TERMINAL_GLYPH_FALLBACK}` },
  { label: `Fira Code`, value: `'Fira Code', ${TERMINAL_GLYPH_FALLBACK}` },
  { label: `Source Code Pro`, value: `'Source Code Pro', ${TERMINAL_GLYPH_FALLBACK}` },
  { label: `Cascadia Code`, value: `'Cascadia Code', ${TERMINAL_GLYPH_FALLBACK}` },
  { label: `Menlo`, value: `Menlo, ${TERMINAL_GLYPH_FALLBACK}` },
  { label: `Consolas`, value: `Consolas, ${TERMINAL_GLYPH_FALLBACK}` },
  { label: `monospace`, value: TERMINAL_GLYPH_FALLBACK },
]

let initial_terminal_font_size = DEFAULT_TERMINAL_FONT_SIZE
let initial_terminal_font_family = DEFAULT_TERMINAL_FONT_FAMILY
try {
  if (typeof window !== `undefined` && globalThis.localStorage) {
    const saved = localStorage.getItem(TERMINAL_FONT_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (typeof parsed.font_size === `number` && parsed.font_size >= 10 && parsed.font_size <= 24) {
        initial_terminal_font_size = parsed.font_size
      }
      if (typeof parsed.font_family === `string`) {
        // Upgrade older saved values (e.g. "'JetBrains Mono', monospace") that
        // predate the glyph fallback chain, so existing users get Nerd/emoji/CJK.
        initial_terminal_font_family = with_glyph_fallback(parsed.font_family)
      }
    }
  }
} catch {
  // Fallback for test environments
}

export const terminal_font_state = $state<{ font_size: number; font_family: string }>({
  font_size: initial_terminal_font_size,
  font_family: initial_terminal_font_family,
})

export const save_terminal_font_state = (): void => {
  try {
    localStorage.setItem(TERMINAL_FONT_KEY, JSON.stringify({
      font_size: terminal_font_state.font_size,
      font_family: terminal_font_state.font_family,
    }))
  } catch {
    // Silently fail
  }
}

// Atom clipboard — shared across all Structure instances for cross-pane copy/paste
export interface ClipboardSite {
  species: Array<{ element: string; occu: number; oxidation_state: number }>
  xyz: Vec3
  label: string
  properties?: Record<string, unknown>
}
export const atom_clipboard = $state<{
  sites: ClipboardSite[] | null
  paste_count: number
}>({ sites: null, paste_count: 0 })

export const save_pane_font_size = (size: number): void => {
  try {
    localStorage.setItem(PANE_FONT_SIZE_KEY, String(size))
  } catch {
    // Silently fail
  }
}

// ── open-target preference ──────────────────────────────────────────────────
// A file opens into one of three destination *kinds* (a tab, a split pane, or a
// new OS window), in one of two *modes* (create new vs overwrite the current
// one). Holding Shift at open time flips the mode.
export type OpenKind = 'tab' | 'split' | 'window'
export type OpenMode = 'new' | 'overwrite'
export interface OpenTarget {
  kind: OpenKind
  mode: OpenMode
}

const OPEN_KIND_KEY = `catgo-open-kind`
const OPEN_MODE_KEY = `catgo-open-mode`
const LEGACY_OPEN_TARGET_KEY = `catgo-open-target`

function load_initial_open_target(): OpenTarget {
  try {
    if (typeof window !== `undefined` && globalThis.localStorage) {
      const kind = localStorage.getItem(OPEN_KIND_KEY)
      const mode = localStorage.getItem(OPEN_MODE_KEY)
      const valid_kind = kind === 'tab' || kind === 'split' || kind === 'window'
      const valid_mode = mode === 'new' || mode === 'overwrite'
      if (valid_kind) return { kind, mode: valid_mode ? mode : 'new' }
      // Migrate the old single-value preference ('split' | 'window').
      const legacy = localStorage.getItem(LEGACY_OPEN_TARGET_KEY)
      if (legacy === 'window') return { kind: 'window', mode: 'new' }
      if (legacy === 'split') return { kind: 'split', mode: 'new' }
    }
  } catch {
    // Fallback for test environments
  }
  return { kind: 'split', mode: 'new' }
}

export const open_target_state = $state<{ value: OpenTarget }>({ value: load_initial_open_target() })

export function set_open_kind(kind: OpenKind): void {
  open_target_state.value = { ...open_target_state.value, kind }
  try {
    if (typeof window !== `undefined` && globalThis.localStorage) localStorage.setItem(OPEN_KIND_KEY, kind)
  } catch {
    // Silently fail
  }
}

export function set_open_mode(mode: OpenMode): void {
  open_target_state.value = { ...open_target_state.value, mode }
  try {
    if (typeof window !== `undefined` && globalThis.localStorage) localStorage.setItem(OPEN_MODE_KEY, mode)
  } catch {
    // Silently fail
  }
}

/** Per-open override: holding Shift flips new⇄overwrite. */
export function resolve_open_target(deflt: OpenTarget, shift: boolean): OpenTarget {
  if (!shift) return deflt
  return { ...deflt, mode: deflt.mode === 'new' ? 'overwrite' : 'new' }
}

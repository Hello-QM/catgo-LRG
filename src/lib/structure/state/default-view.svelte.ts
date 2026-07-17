/**
 * Default-view state — the user's saved default camera view (VESTA-style Lock).
 *
 * One module-level $state shared by every Structure instance, so locking or
 * clearing the default view in one pane immediately updates all other panes
 * (Unlock button visibility, the default applied to newly opened structures).
 * A `storage` listener keeps separate windows (pop-outs) in sync too.
 *
 * ALL localStorage access is wrapped in try/catch: cookie-blocked browsers
 * throw SecurityError on the `localStorage` getter itself, and Safari private
 * mode / quota errors throw on setItem (same pattern as
 * controllers/settings.svelte.ts).
 */

export const DEFAULT_VIEW_STORAGE_KEY = `catgo-default-view`

export interface DefaultView {
  /** View direction (into the screen), world frame. */
  dir: [number, number, number]
  /** Camera up vector, world frame. */
  up: [number, number, number]
}

const is_vec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 &&
  v.every((n) => typeof n === `number` && Number.isFinite(n))

const length_sq = (v: [number, number, number]) => v[0] * v[0] + v[1] * v[1] + v[2] * v[2]

const is_valid_view = (view: DefaultView): boolean =>
  is_vec3(view.dir) && is_vec3(view.up) &&
  length_sq(view.dir) > 1e-12 && length_sq(view.up) > 1e-12

/**
 * Validate a raw localStorage payload. Rejects malformed JSON, non-finite
 * elements, and zero-length dir/up — a zero-length up survives three.js
 * `.normalize()` (no-op on zero vectors) and would yield a singular camera
 * basis on every load until localStorage is cleared.
 */
export function parse_default_view(raw: string | null): DefaultView | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const view = { dir: parsed?.dir, up: parsed?.up } as DefaultView
    if (is_valid_view(view)) return { dir: view.dir, up: view.up }
  } catch { /* corrupted entry — treat as absent */ }
  return null
}

export function load_default_view(): DefaultView | null {
  try {
    if (typeof window === `undefined`) return null
    return parse_default_view(localStorage.getItem(DEFAULT_VIEW_STORAGE_KEY))
  } catch {
    return null // localStorage access denied (cookie-blocked browser)
  }
}

// Shared across all Structure instances. Not exported directly — Svelte
// forbids exporting reassigned module state; read via get_default_view().
let default_view = $state<DefaultView | null>(load_default_view())

export function get_default_view(): DefaultView | null {
  return default_view
}

/**
 * Persist + share a default view. Returns false (and stores nothing) for
 * degenerate zero-length dir/up. A storage write failure (private mode,
 * quota) keeps the in-memory value so this session still behaves.
 */
export function set_default_view(view: DefaultView): boolean {
  if (!is_valid_view(view)) return false
  try {
    if (typeof window !== `undefined`) {
      localStorage.setItem(DEFAULT_VIEW_STORAGE_KEY, JSON.stringify(view))
    }
  } catch { /* private mode / quota — keep the in-memory value */ }
  default_view = view
  return true
}

export function clear_default_view(): void {
  try {
    if (typeof window !== `undefined`) {
      localStorage.removeItem(DEFAULT_VIEW_STORAGE_KEY)
    }
  } catch { /* ignore */ }
  default_view = null
}

// Cross-window sync: `storage` fires in OTHER same-origin windows when the
// key changes (event.key === null means localStorage.clear()). Module scope
// lives for the page lifetime — no listener removal needed.
if (typeof window !== `undefined` && typeof window.addEventListener === `function`) {
  window.addEventListener(`storage`, (event: StorageEvent) => {
    if (event.key !== null && event.key !== DEFAULT_VIEW_STORAGE_KEY) return
    default_view = event.key === null ? null : parse_default_view(event.newValue)
  })
}

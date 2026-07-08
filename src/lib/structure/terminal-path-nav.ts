/**
 * Terminal Ctrl+click path resolution: a clicked DIRECTORY navigates the Files
 * panel (reusing the existing `catgo-terminal-cwd` window-event bus that the
 * Directory-Sync feature already listens on — see desktop/sidebar/cwd-sync.svelte.ts),
 * while a clicked FILE opens in the viewer/editor via the existing on_open_file path.
 *
 * Split out of TerminalPanel.svelte so the dir-vs-file branch is unit-testable
 * without a DOM/xterm harness.
 */
import { API_BASE } from '$lib/api/config'
import { listFiles } from '$lib/api/hpc'

/** True if `path` is a directory. Local terminal (empty session_id) → the local
 * `/workflow/files/browse` endpoint; remote terminal → `listFiles` over that
 * session's SSH (success = dir). Any error → false, so the caller safely falls
 * back to treating it as a file (the prior behaviour).
 *
 * The local check requires the response to be the real directory-listing JSON
 * (an `items` array) rather than just HTTP 200: when the SPA is served same-origin
 * (browser dev, static build) an unmatched `/api/...` path falls through to the
 * index.html SPA fallback — a `200 text/html` — and the STATIC_ONLY fetch-stub
 * returns a `200 {detail}` error. Trusting `res.ok` alone would classify EVERY
 * file as a directory, so a Ctrl+clicked file would only navigate the Files panel
 * and never open. */
export async function path_is_directory(path: string, session_id: string): Promise<boolean> {
  try {
    if (session_id) {
      const res = await listFiles(session_id, path)
      return res.success
    }
    const res = await fetch(`${API_BASE}/workflow/files/browse?dir=${encodeURIComponent(path)}`)
    if (!res.ok) return false
    const data = await res.json().catch(() => null)
    return Array.isArray((data as { items?: unknown } | null)?.items)
  } catch {
    return false
  }
}

export interface TerminalClickHandlers {
  /** Open a file path (structure/editor/preview) — the pre-existing behaviour. */
  open_file: (path: string, session_id: string) => void
  /** Navigate the Files panel for this session to `path` (a directory). */
  navigate_dir: (path: string, session_id: string) => void
}

/** Route a Ctrl+clicked, already-resolved terminal path: directory → navigate the
 * Files panel; file → open it. `is_directory` is injectable for testing. */
export async function open_terminal_click(
  path: string,
  session_id: string,
  handlers: TerminalClickHandlers,
  is_directory: (path: string, session_id: string) => Promise<boolean> = path_is_directory,
): Promise<void> {
  if (await is_directory(path, session_id)) {
    handlers.navigate_dir(path, session_id)
  } else {
    handlers.open_file(path, session_id)
  }
}

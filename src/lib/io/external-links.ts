// Global external-link interception for the Tauri shells.
//
// Inside a Tauri WebView a plain `<a href="https://..." target="_blank">` is
// dead: iOS/Android WKWebView ignores it entirely, and the desktop WebView2 /
// WebKitGTK popup policy blocks `window.open`. Only code that explicitly calls
// the shell plugin (e.g. MobileWorkspace's GitHub button) worked — every other
// anchor (editor "Star on GitHub", chat markdown links, static-mode banner,
// release-notes links) silently did nothing on mobile.
//
// This installs ONE capture-phase click listener that routes any cross-origin
// http(s) anchor through `shell.open` (system browser). In a regular browser
// build it is a no-op. Same-origin links and non-http schemes are untouched.
import { check_tauri } from './tauri'

let installed = false

export function install_external_link_handler(): void {
  if (typeof document === `undefined` || installed) return
  installed = true

  document.addEventListener(
    `click`,
    (event) => {
      // Checked per-click (not at install) so a plain browser build stays a
      // strict no-op even if the handler was installed before Tauri detection.
      if (!check_tauri()) return
      if (event.defaultPrevented) return
      // Respect modified clicks (open-in-new-tab gestures in a real browser).
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const anchor = (event.target as HTMLElement | null)?.closest?.(`a[href]`)
      if (!anchor) return
      const href = anchor.getAttribute(`href`)
      if (!href || !/^https?:\/\//i.test(href)) return

      let url: URL
      try {
        url = new URL(href, globalThis.location?.href)
      } catch {
        return
      }
      if (url.origin === globalThis.location?.origin) return

      event.preventDefault()
      event.stopPropagation()
      void import(`@tauri-apps/plugin-shell`)
        .then(({ open }) => open(url.toString()))
        .catch((err) => console.warn(`[external-links] shell.open failed:`, err))
    },
    true,
  )
}

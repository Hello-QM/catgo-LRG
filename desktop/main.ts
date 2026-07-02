import '../src/lib/app.css'
import App from './App.svelte'
import { mount } from 'svelte'
import { init_backend_url } from '../src/lib/api/backend-url.svelte'
import { install_external_link_handler } from '../src/lib/io/external-links'

// Model C: a hosted frontend can target a user-chosen backend. Apply the saved
// backend URL (localStorage 'catgo-backend-url') to ALL API consumers BEFORE the
// app mounts and any HPC/MP/chat/compute module makes its first call. No-op when
// nothing is saved, so the default (http://localhost:8000) is preserved.
init_backend_url()

// In the Tauri shells (desktop + mobile), plain external <a> links are blocked
// by the WebView; route them through shell.open so they reach the system
// browser. No-op in regular browser builds.
install_external_link_handler()

const target = document.getElementById(`app`)!

function render_status(html: string, color = `#888`) {
  target.innerHTML =
    `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:system-ui;color:${color};padding:2rem;text-align:center;white-space:pre-wrap;font-size:14px">${html}</div>`
}

function is_ignorable_runtime_error(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ``
  return message === `ResizeObserver loop completed with undelivered notifications.` ||
    message === `ResizeObserver loop limit exceeded` ||
    // Monaco cancels in-flight delayers/worker requests when an editor or
    // model is disposed (doc tab closed, HMR remount) — the rejection reaches
    // this listener BEFORE MonacoEditorPanel's own guard can preventDefault
    // (listeners fire in registration order), so filter it here too. Benign.
    name === `Canceled` || message === `Canceled` ||
    // On mobile there is no Python/Node sidecar, so any code path that tries to
    // spawn one fails with the shell plugin's "Scoped shell IO error: No such
    // file or directory". That feature is simply unavailable on mobile — log it,
    // but never tear down the whole app with a fatal error screen.
    message.includes(`Scoped shell IO error`) ||
    // tauri-plugin-http (native fetch) frees a request/body resource once it is
    // fully read; aborting or cancelling it afterwards (idle watchdog,
    // cancel_generation, the plugin's own abort listener, or a stale closure
    // left by an HMR module swap) calls fetch_cancel on the freed id and rejects
    // with "The resource id N is invalid". It is entirely benign — the request
    // already completed — so log it instead of whiting out the whole WebView.
    /resource id \d+ is invalid/i.test(message)
}

function render_error(label: string, err: unknown) {
  if (is_ignorable_runtime_error(err)) {
    console.debug(`[CatGo] Ignored runtime browser notification:`, err)
    return
  }

  const detail = err instanceof Error
    ? `${err.name}: ${err.message}\n\n${err.stack ?? ``}`
    : String(err)
  render_status(
    `${label}\n\n${
      detail.replace(/[&<>]/g, (c) => ({ '&': `&amp;`, '<': `&lt;`, '>': `&gt;` }[c]!))
    }`,
    `#e44`,
  )
  console.error(`[CatGo] ${label}`, err)
}

render_status(`Loading CatGo…`)

window.addEventListener(
  `error`,
  (e) => render_error(`Runtime error:`, e.error ?? e.message),
)
window.addEventListener(
  `unhandledrejection`,
  (e) => render_error(`Unhandled rejection:`, e.reason),
)

let app: unknown
try {
  // Svelte 5 mount() APPENDS to target — it does not clear existing content.
  // render_status() above filled #app with the "Loading CatGo…" placeholder;
  // remove it here or it stays on top and visually masks the mounted app.
  target.replaceChildren()
  app = mount(App, { target })
} catch (err) {
  render_error(`CatGo failed to start:`, err)
}

export default app

import '../src/lib/app.css'
import App from './App.svelte'
import { mount } from 'svelte'
import { init_backend_url } from '../src/lib/api/backend-url.svelte'

// Model C: a hosted frontend can target a user-chosen backend. Apply the saved
// backend URL (localStorage 'catgo-backend-url') to ALL API consumers BEFORE the
// app mounts and any HPC/MP/chat/compute module makes its first call. No-op when
// nothing is saved, so the default (http://localhost:8000) is preserved.
init_backend_url()

const target = document.getElementById(`app`)!

function render_status(html: string, color = `#888`) {
  target.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:system-ui;color:${color};padding:2rem;text-align:center;white-space:pre-wrap;font-size:14px">${html}</div>`
}

function is_ignorable_runtime_error(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return message === `ResizeObserver loop completed with undelivered notifications.`
    || message === `ResizeObserver loop limit exceeded`
}

function render_error(label: string, err: unknown) {
  if (is_ignorable_runtime_error(err)) {
    console.debug(`[CatGo] Ignored runtime browser notification:`, err)
    return
  }

  const detail = err instanceof Error
    ? `${err.name}: ${err.message}\n\n${err.stack ?? ``}`
    : String(err)
  render_status(`${label}\n\n${detail.replace(/[&<>]/g, c => ({ '&': `&amp;`, '<': `&lt;`, '>': `&gt;` }[c]!))}`, `#e44`)
  console.error(`[CatGo] ${label}`, err)
}

render_status(`Loading CatGo…`)

window.addEventListener(`error`, (e) => render_error(`Runtime error:`, e.error ?? e.message))
window.addEventListener(`unhandledrejection`, (e) => render_error(`Unhandled rejection:`, e.reason))

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

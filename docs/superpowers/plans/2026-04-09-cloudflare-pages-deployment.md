# CatGo Cloudflare Pages Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the CatGo desktop frontend as a static site on Cloudflare Pages so anyone can access it at catgo-ucsd.org.

**Architecture:** The existing desktop Vite build (`pnpm desktop:build`) produces a static SPA. We add a `VITE_STATIC_ONLY` compile-time flag that disables backend pings and hides backend-dependent UI. The build output (`build-desktop/`) is deployed to Cloudflare Pages with a `_redirects` file for SPA routing.

**Tech Stack:** Vite, SvelteKit (components only, not SSR), Cloudflare Pages, existing ferrox/moyo WASM modules

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `vite.desktop.config.ts` | Modify | Add `__CATGO_STATIC_ONLY__` define from env |
| `src/lib/api/config.ts` | Modify | Read `__CATGO_STATIC_ONLY__`, export `STATIC_ONLY` constant, shortcircuit `desktop_backend_available()` |
| `desktop/App.svelte` | Modify | Hide backend-dependent tabs (Chat, Terminal) and sidebar panels in static mode |
| `desktop/Sidebar.svelte` | Modify | Hide HPC file browser section in static mode |
| `static/_redirects` | Create | Cloudflare Pages SPA routing rule |
| `package.json` | Modify | Add `deploy:build` script |

---

### Task 1: Add `__CATGO_STATIC_ONLY__` compile-time flag

**Files:**
- Modify: `vite.desktop.config.ts:571-574`
- Modify: `src/lib/api/config.ts:1-29`

- [ ] **Step 1: Add define to Vite config**

In `vite.desktop.config.ts`, add `__CATGO_STATIC_ONLY__` to the `define` block (line 571-574):

```typescript
  define: {
    ...shared_define(srv_port),
    __CATGO_DESKTOP__: `true`,
    __CATGO_STATIC_ONLY__: JSON.stringify(!!process.env.VITE_STATIC_ONLY),
  },
```

- [ ] **Step 2: Export `STATIC_ONLY` from config.ts and shortcircuit backend detection**

In `src/lib/api/config.ts`, add the declaration and export, then modify `desktop_backend_available()`:

```typescript
declare const __CATGO_SERVER_URL__: string
declare const __CATGO_DESKTOP__: boolean
declare const __CATGO_STATIC_ONLY__: boolean

export const SERVER_URL: string =
  typeof __CATGO_SERVER_URL__ !== `undefined`
    ? __CATGO_SERVER_URL__
    : `http://localhost:8000`

export const API_BASE = `${SERVER_URL}/api`
export const WS_BASE = SERVER_URL.replace(/^http/, `ws`) + `/api`

/** True when built for static-only deployment (no Python backend). */
export const STATIC_ONLY: boolean =
  typeof __CATGO_STATIC_ONLY__ !== `undefined` && __CATGO_STATIC_ONLY__

/** [2026-03] Detect if Python backend is available in desktop mode (desktop:serve).
 * Cached after first check.  Used by project.ts / workflow.ts to bypass stale WASM cache. */
let _backend_state: boolean | null = null
export async function desktop_backend_available(): Promise<boolean> {
  if (STATIC_ONLY) return false
  if (typeof __CATGO_DESKTOP__ === `undefined` || !__CATGO_DESKTOP__) return false
  if (_backend_state !== null) return _backend_state
  try {
    const resp = await fetch(`${API_BASE}/providers`, { signal: AbortSignal.timeout(2000) })
    _backend_state = resp.ok
  } catch {
    _backend_state = false
  }
  return _backend_state
}
```

- [ ] **Step 3: Verify build works**

Run: `VITE_STATIC_ONLY=true pnpm desktop:build`
Expected: Build succeeds, output in `build-desktop/`

- [ ] **Step 4: Commit**

```bash
git add vite.desktop.config.ts src/lib/api/config.ts
git commit -m "feat: add STATIC_ONLY compile-time flag for static deployment"
```

---

### Task 2: Hide backend-dependent UI in static mode

**Files:**
- Modify: `desktop/App.svelte`
- Modify: `desktop/Sidebar.svelte`

- [ ] **Step 1: Read the template section of App.svelte to find the Chat, Terminal, and HPC tab references**

Read `desktop/App.svelte` from line 800 onward to find where ChatPane, TerminalWindow, and tab creation logic renders. Identify the exact template locations for:
- Chat tab / ChatPane component
- Terminal tab / TerminalWindow component
- Any buttons that trigger backend-dependent features (OPTIMADE search, etc.)

Also read `desktop/Sidebar.svelte` to find the HPC file browser section.

- [ ] **Step 2: Import STATIC_ONLY in App.svelte**

Add at the top of the `<script>` block in `desktop/App.svelte`:

```typescript
import { STATIC_ONLY } from '$lib/api/config'
```

- [ ] **Step 3: Hide Chat tab in static mode**

Find where the Chat tab is rendered (popout_chat_mode or the chat button in the toolbar). Wrap with:

```svelte
{#if !STATIC_ONLY}
  <!-- existing chat button/tab -->
{/if}
```

- [ ] **Step 4: Hide Terminal tab in static mode**

Find where the Terminal tab/button is rendered. Wrap with:

```svelte
{#if !STATIC_ONLY}
  <!-- existing terminal button/tab -->
{/if}
```

- [ ] **Step 5: Hide OPTIMADE search button in static mode**

The OPTIMADE search modal (`OptimadeSearchModal`) fetches from the backend. Find the button that opens it and wrap with `{#if !STATIC_ONLY}`.

- [ ] **Step 6: Import STATIC_ONLY in Sidebar.svelte and hide HPC file browser**

In `desktop/Sidebar.svelte`, import `STATIC_ONLY` and hide the HPC file browser section:

```typescript
import { STATIC_ONLY } from '$lib/api/config'
```

Find the HPC file browser section and wrap with `{#if !STATIC_ONLY}`.

- [ ] **Step 7: Verify static build renders correctly**

Run:
```bash
VITE_STATIC_ONLY=true pnpm desktop:build
npx serve build-desktop
```
Open in browser — verify:
- Structure viewer loads and works
- Chat, Terminal, HPC buttons are hidden
- File open (local) works
- Drag & drop works

- [ ] **Step 8: Verify normal desktop build is unchanged**

Run: `pnpm desktop:dev`
Verify: Chat, Terminal, HPC buttons are all present.

- [ ] **Step 9: Commit**

```bash
git add desktop/App.svelte desktop/Sidebar.svelte
git commit -m "feat: hide backend-dependent UI in static deployment mode"
```

---

### Task 3: Add SPA routing and deploy build script

**Files:**
- Create: `static/_redirects`
- Modify: `package.json`

- [ ] **Step 1: Create Cloudflare Pages `_redirects` file**

The `static/` directory is the `publicDir` for the desktop build (see `vite.desktop.config.ts:539`), so files here are copied to `build-desktop/` during build.

Create `static/_redirects`:

```
/* /index.html 200
```

This tells Cloudflare Pages to serve `index.html` for all unmatched routes (SPA fallback).

- [ ] **Step 2: Add `deploy:build` script to package.json**

Find the `desktop:build` line in `package.json` (line 228) and add after it:

```json
"deploy:build": "VITE_STATIC_ONLY=true vite build --config vite.desktop.config.ts",
```

- [ ] **Step 3: Verify _redirects is in build output**

Run:
```bash
pnpm deploy:build
cat build-desktop/_redirects
```
Expected: `/* /index.html 200`

- [ ] **Step 4: Commit**

```bash
git add static/_redirects package.json
git commit -m "feat: add deploy:build script and Cloudflare Pages SPA routing"
```

---

### Task 4: Cloudflare Pages setup (manual — not code)

This task is performed in the Cloudflare dashboard, not in code.

- [ ] **Step 1: Create Cloudflare account**

Go to https://dash.cloudflare.com/sign-up, create a free account.

- [ ] **Step 2: Connect GitHub repo to Cloudflare Pages**

1. Dashboard → Workers & Pages → Create → Pages → Connect to Git
2. Select the CatGo repository
3. Configure build settings:
   - Production branch: `main`
   - Build command: `pnpm install && pnpm deploy:build`
   - Build output directory: `build-desktop`
   - Node.js version: `20` (set in Environment Variables: `NODE_VERSION` = `20`)
   - Environment variable: `VITE_STATIC_ONLY` = `true`

- [ ] **Step 3: Trigger first deploy**

Cloudflare auto-deploys on push. Or click "Deploy" manually in the dashboard.
Verify: site loads at `<project-name>.pages.dev`

- [ ] **Step 4: Configure custom domain (when ready)**

1. Buy `catgo-ucsd.org` from a registrar (Namecheap, Cloudflare Registrar, etc.)
2. In Cloudflare dashboard: add `catgo-ucsd.org` as a site
3. Update nameservers at the registrar to Cloudflare's nameservers
4. In Pages project → Custom Domains → Add `catgo-ucsd.org`
5. Cloudflare auto-provisions SSL certificate
6. Verify: `https://catgo-ucsd.org` loads the site

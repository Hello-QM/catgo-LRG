# CatGo Static Web Deployment — Cloudflare Pages

**Date:** 2026-04-09
**Domain:** catgo-ucsd.org
**Platform:** Cloudflare Pages (free tier)
**Scope:** Frontend-only static deployment — no Python backend

## Context

CatGo is a materials-science toolkit with a desktop frontend (standalone Vite SPA) and FastAPI backend. The advisor (Wanlu Li, UCSD) wants the project accessible online so anyone can use it via a browser. Backend-dependent features (HPC, workflow execution, AI chat) will be available through the desktop client or VS Code extension.

The deployed version is the **desktop frontend** (`pnpm desktop:dev`), NOT the SvelteKit web build (`pnpm dev`). The desktop build is a standalone Vite SPA that mocks `$app/*` modules and outputs pure static files.

## Deployment Architecture

```
User Browser
    │
    ▼
catgo-ucsd.org (Cloudflare Pages CDN)
    │
    ├── Static HTML/CSS/JS (Vite desktop build → build-desktop/)
    ├── WASM modules (ferrox, chgdiff, vsepr, moyo — bundled)
    └── All computation runs client-side in the browser
```

No server. No backend. No database. Zero cost.

## Build Setup

**Existing build infrastructure:**
- Config: `vite.desktop.config.ts`
- Entry point: `desktop/index.html` → `desktop/main.ts` → mounts Svelte `App` component
- `$app/*` mocks: `desktop/mocks/{environment,navigation,stores}.ts`
- Build command: `pnpm desktop:build`
- Output directory: `build-desktop/`
- Output uses root-relative paths (`/assets/...`) — must deploy at site root

## Features Available in Static Deployment

### Works 100% Client-Side

| Feature | Implementation |
|---------|---------------|
| **Structure viewer** | Threlte/Three.js 3D renderer, local file parsing (CIF, POSCAR, XYZ, PDB, MOL2, LAMMPS, CP2K, etc.) |
| **Build tools** | Supercell, slab cutting, Moiré patterns, nanotubes, heterostructures, adsorbate placement, water layers, H-passivation |
| **Bond detection** | ferrox WASM — 3 strategies |
| **Symmetry analysis** | moyo WASM |
| **File export** | All format writers are pure TypeScript (CIF, POSCAR, XYZ, MOL2, LAMMPS, ORCA, Gaussian, QE, GROMACS, etc.) |
| **Periodic table** | Interactive element viewer |
| **Composition analyzer** | Client-side |
| **Property coloring** | Element, coordination number, Wyckoff positions |
| **Charge visualization** | Ewald summation via WASM |
| **Structure editing** | Add/delete/move/replace atoms, bond editing, cell transformation |

### Does NOT Work (Requires Backend)

| Feature | Reason |
|---------|--------|
| Workflow execution | Backend CRUD + HPC job submission |
| AI chat | Needs Anthropic/OpenAI API proxy |
| HPC connection | SSH via backend |
| Material database queries | PubChem, Materials Project, OPTIMADE proxied via backend |
| DOS/Bands/COHP analysis | Backend computation |
| Project management | Backend database |

## Code Changes Required

### 1. Static deployment build mode

Add a `VITE_STATIC_ONLY` environment variable. When set to `true`:
- `desktop_backend_available()` in `src/lib/api/config.ts` always returns `false`
- No backend ping attempts on startup

### 2. UI adaptation for static mode

When `VITE_STATIC_ONLY` is true:

**Hide backend-dependent UI:**
- Hide or disable UI elements that require backend: Workflow panel, Chat pane, HPC/Server panel, Project management
- Keep: Structure Viewer, Build Tools, File I/O, Periodic Table, Settings

**Backend-dependent components:**
- Wrap API-calling UI sections with a check. When triggered in static mode, show a banner:
  > "This feature requires the CatGo desktop app. [Download](link) or use the VS Code extension."
- This applies to: workflow editor actions, chat pane, HPC panel, database search (PubChem/MP/OPTIMADE), DOS/Bands upload

**Structure viewer:**
- Works as-is. No changes needed for the core viewer, build tools, or file I/O.

### 3. Landing page / marketing content

Add a simple landing page or splash screen that explains:
- What CatGo is
- What you can do in the browser (structure viewer demo)
- Links to download desktop client / VS Code extension
- Link to documentation / GitHub repo

### 4. Build configuration

**New script in `package.json`:**
```json
{
  "deploy:build": "VITE_STATIC_ONLY=true vite build --config vite.desktop.config.ts"
}
```

This reuses the existing desktop Vite config with the static-only flag. Output goes to `build-desktop/`.

### 5. Cloudflare Pages configuration

**Connect GitHub repo → Cloudflare Pages:**
- Build command: `pnpm install && pnpm deploy:build`
- Build output directory: `build-desktop`
- Node.js version: 20
- Environment variable: `VITE_STATIC_ONLY=true`

**SPA routing:**
- The desktop build is a single `index.html` SPA entry point
- Add `build-desktop/_redirects` file (generated at build time):
  ```
  /* /index.html 200
  ```
  This tells Cloudflare Pages to serve `index.html` for all routes, enabling client-side routing.

**Custom domain (later):**
1. Buy `catgo-ucsd.org` from any registrar
2. Change nameservers to Cloudflare
3. In Cloudflare Pages dashboard: add custom domain `catgo-ucsd.org`
4. Cloudflare auto-provisions HTTPS via Let's Encrypt
5. Done — ~10 minutes, no code changes

## File Changes Summary

| File | Change |
|------|--------|
| `src/lib/api/config.ts` | Add `STATIC_ONLY` constant from env, shortcircuit `desktop_backend_available()` |
| `package.json` | Add `deploy:build` script |
| `vite.desktop.config.ts` | Copy `_redirects` to output dir for Cloudflare SPA routing |
| Desktop app UI components | Add static mode guard before API calls, show "download desktop app" banner |
| New: `src/lib/components/StaticModeBanner.svelte` | Reusable banner component for features that need backend |

## Deployment Workflow

```
Developer pushes to main branch
    │
    ▼
Cloudflare Pages auto-builds (pnpm deploy:build)
    │
    ▼
Static files deployed to global CDN
    │
    ▼
catgo-ucsd.org live (after domain configured)
```

No CI/CD config needed beyond the Cloudflare Pages dashboard setup. Automatic deploys on every push.

## Cost

| Item | Cost |
|------|------|
| Cloudflare Pages hosting | Free (unlimited bandwidth, 500 builds/month) |
| Domain `catgo-ucsd.org` | ~60-80 RMB/year |
| HTTPS certificate | Free (Cloudflare auto-provisions) |
| **Total** | **~60-80 RMB/year** |

## Future Extensions

- **Add backend later:** If needed, deploy backend separately (any cloud VM) and point `VITE_SERVER_URL` to it. No frontend code changes needed beyond removing `VITE_STATIC_ONLY`.
- **Analytics:** Cloudflare Web Analytics (free, privacy-friendly) to track usage.
- **Preview deployments:** Cloudflare Pages auto-creates preview URLs for every PR — useful for testing before merge.

## Out of Scope

- User authentication (no backend = no auth needed)
- Backend deployment
- VS Code extension development
- Desktop client packaging/distribution

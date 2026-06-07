# CatGo — repo guide for Claude & contributors

CatGo is an **AI-driven workbench for computational materials science**: a 3D
structure/trajectory editor + workflow engine, shipped as a Tauri desktop app
(and a Tauri **mobile** build) with a Python backend.

> **Agents:** working conventions (skills, campaign md-orchestration, poll-loop subagents,
> HPC config gate, Gibbs pipeline) live in **`AGENTS.md`** — read it. Run `catgo setup` to
> install the Claude Code skills.

## Stack & layout

- **Frontend:** SvelteKit 2 / **Svelte 5 (runes)** + Vite 7 — `src/`
- **Desktop/mobile shell:** Tauri 2 — `src-tauri/`. Mobile projects live in
  `src-tauri/gen/{apple,android}` and are machine-local / regenerated (not committed).
- **Backend:** FastAPI (Python) — `server/main.py`. An agent sidecar (`pnpm agent:dev`)
  serves `/api/agent/*`.
- **WASM / native:** `extensions/rust-wasm` (ferrox — bonds/geometry), `crates/`.
- **3D viewer:** Three.js. The purpose-built mobile UI lives in `src/lib/mobile/`.

## Commands

- `pnpm desktop:serve` — full dev stack (Vite frontend + Python backend + agent), desktop
- `pnpm tauri ios dev "<device>"` — run on a connected iPhone (see **Mobile / iOS** below)
- `pnpm check` — type-check (`svelte-check`)
- `pnpm test` — unit tests (`vitest run`)
- `pnpm desktop:build` — production desktop build

## Conventions

- **Formatting is enforced by a local pre-commit hook** (`deno fmt`): single quotes,
  **no semicolons**, 2-space indent, 90-col (`deno.jsonc`). `.svelte` / `.md` / `.yaml`
  are excluded from `deno fmt`. Don't fight it — let the hook format, then re-stage.
- **Svelte 5 runes** (`$state` / `$derived` / `$effect` / `$props`) — not legacy
  stores or `export let`.
- **i18n:** `src/lib/i18n/{en,zh}/*.ts` — keep the **en and zh key sets in parity**.
- **CI gates (PR → `main`):** `test.yml` (`vitest`) is the real one. `lint.yml` is
  `continue-on-error` (non-blocking) and skips eslint. Type-check is **not** a CI gate.

## Mobile / iOS

The mobile app reuses the desktop Svelte UI inside a Tauri **WKWebView**. iOS surfaced
several WKWebView-specific issues; the fixes are **gated on mobile** (`TAURI_DEV_HOST`)
so desktop / production behaviour is unchanged.

**Before changing mobile code, read `deploy/ios/LOCAL-TESTING-PROGRESS.md`** — it has the
build/run flow plus a table mapping every iOS change to its file and the knob to adjust.

Key invariants — these look odd but fix real iOS bugs, so don't silently revert them:

- Launch with `TAURI_DEV_HOST=<Mac LAN IP>` (`ipconfig getifaddr en0`) — the phone is not
  `localhost`, so the backend URL, CORS origin, and HMR all derive from it.
- `src/lib/Icon.svelte` uses `height: 1em` (not `auto`) — iOS collapses `auto` viewBox
  SVGs to 0px (blank squares).
- Don't `display:none` the mobile 3D-viewer pane — it zeroes the WebGL canvas (keep-warm
  off-screen instead).
- Use `<Icon>` SVG (`src/lib/icons.ts`) for mobile icons, never raw Unicode glyphs
  (no iOS font glyph → tofu squares).
- `vite.desktop.config.ts` sets `emitCss:false` on mobile dev (avoids a cold-load PostCSS
  race; the trade-off is losing CSS-only HMR on mobile).

A shipped `.ipa` (mobile *production*) still needs work the dev build papers over: the
backend must not be `localhost`, the chat agent's relative URL needs a real host, and the
structure formats should be declared as UTTypes in `Info.plist`. See the notes file.

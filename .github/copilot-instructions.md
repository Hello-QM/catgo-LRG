# Copilot review instructions — CatGo

CatGo is an AI-driven workbench for computational materials science: a SvelteKit 2
/ **Svelte 5 (runes)** frontend in a Tauri 2 desktop + **mobile (iOS)** shell, with
a FastAPI Python backend.

## Please focus reviews on

- **Correctness & logic bugs**, security issues, data loss, race conditions.
- **Broken invariants** in changed code, and missing error handling that would
  surface to the user.
- Whether new code matches **existing patterns** in nearby files.

## Please DO NOT comment on (these are intentional / automated)

- **Formatting / whitespace / import order / quote style / missing semicolons.**
  Formatting is enforced by a local `deno fmt` pre-commit hook: **single quotes,
  no semicolons, 2-space indent, 90-col** (see `deno.jsonc`). `.svelte` / `.md` /
  `.yaml` are intentionally excluded from `deno fmt`. Style is not up for review.
- **Comment wording / density / style.** Do not suggest rewording, removing, or
  adding doc comments unless a comment is factually *wrong* about the code.
- **Svelte 5 runes** (`$state` / `$derived` / `$effect` / `$props`) — this is the
  required API here, not legacy stores or `export let`. Don't suggest reverting.
- **Mobile/iOS-gated workarounds.** Several odd-looking lines fix real WKWebView
  bugs and are gated on mobile (`TAURI_DEV_HOST` / `isMobile()`), so desktop and
  production behaviour is unchanged. Examples: `Icon.svelte` `height: 1em` (not
  `auto`); keeping off-screen panes laid out instead of `display:none`;
  `-webkit-user-select: none` on tap targets; binding the dev server to `0.0.0.0`.
  See `deploy/ios/LOCAL-TESTING-PROGRESS.md`. Don't flag these as mistakes.

## Conventions worth knowing

- **i18n:** keep `src/lib/i18n/{en,zh}/*.ts` key sets in parity. Flag a *missing*
  key in one locale; don't comment on translation wording.
- **CI gate:** `test.yml` (`vitest`) is the real gate. `lint.yml` is
  `continue-on-error`; type-check is not a gate.
- Keep mobile-only changes inside `src/lib/mobile/` or gated, so desktop is
  untouched.

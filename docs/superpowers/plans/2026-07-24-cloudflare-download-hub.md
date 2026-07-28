# Cloudflare Download Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a China-friendly all-platform CatGo download page from
`https://dl.catgo-ucsd.org/`, route every normal app download and update through
Cloudflare, and publish the next complete CatGo release only after every
required platform gate passes.

**Architecture:** Keep one copy of release assets in the existing
`catgo-releases` R2 bucket. A small Worker maps the download domain root and
object paths to the R2 binding while preserving streaming, conditional requests,
and byte ranges. A deterministic Node generator builds a self-contained
bilingual page from actual release assets. Product entry points and the Tauri
updater use the download domain exclusively. Release workflows refresh the
mirror after every workflow that can add assets to the CatGo release.

**Tech stack:** Node.js 22 ESM, Vitest, Svelte 5, Tauri 2, Cloudflare Workers,
R2, Wrangler 4, GitHub Actions, AWS CLI, GitHub CLI.

## Global constraints

- Work only in the isolated worktree and feature branch.
- Follow red-green-refactor for each behavior.
- Commit after every task with only that task's files staged.
- Never stage or modify `.claude/gate-approvals/`, `.claude/tmp-*`, or
  `.superpowers/`.
- Preserve the current official `wasm-pack` installer in the Cloudflare app
  deployment workflow.
- Do not add external fonts, CDNs, analytics, GitHub API calls, or GitHub
  fallback links to the normal download flow.
- Do not buffer release binaries in Worker memory.
- Treat the STT accelerator release as a separate product. Its workflow
  publishes `stt-accel-v*` releases and must not refresh the CatGo app mirror.
- Use `v1.4.6` as the next patch release after the implementation is merged and
  all build inputs are green.

## Verified baseline

- [x] The original `wasm-pack --features` Cloudflare deployment failure is
  fixed on `main` by `f197708639f98f8f39b4acc688601cacd767424b`.
- [x] Main workflow run `30145089642` passed the docs, app, current wasm-pack,
  complete WASM build, artifact verification, SPA build, and Wrangler deploy
  gates.
- [x] `https://app.catgo-ucsd.org/` returns HTTP 200.
- [x] R2 currently serves `/index.html`, `/latest.json`, and mirrored v1.4.5
  assets, while the domain root still returns 404.

## Task 1: Lock the implementation contract

**Files:**

- Add:
  `docs/superpowers/plans/2026-07-24-cloudflare-download-hub.md`
- Modify:
  `docs/superpowers/specs/2026-07-24-cloudflare-download-hub-design.md`

- [ ] Mark the approved design as accepted.
- [ ] Correct the release-sync list so it excludes `Build STT accelerator`,
  because that workflow targets an independent release series.
- [ ] Confirm the plan names every production mutation, live gate, and rollback
  path.
- [ ] Scan for unresolved markers:

  ```bash
  rg -n 'TB[D]|TO[D]O|FIXM[E]|PLACEHOLDE[R]' \
    docs/superpowers/plans/2026-07-24-cloudflare-download-hub.md \
    docs/superpowers/specs/2026-07-24-cloudflare-download-hub-design.md
  ```

- [ ] Check whitespace:

  ```bash
  git diff --check
  ```

- [ ] Commit:

  ```bash
  git add \
    docs/superpowers/plans/2026-07-24-cloudflare-download-hub.md \
    docs/superpowers/specs/2026-07-24-cloudflare-download-hub-design.md
  git commit -m "docs: plan Cloudflare download hub implementation"
  ```

## Task 2: Build the deterministic download-page generator

**Files:**

- Add: `scripts/generate-download-page.mjs`
- Add: `scripts/__tests__/generate-download-page.test.mjs`

### Required behavior

- Classify the currently available installers:
  - Windows x64 NSIS setup EXE and MSI.
  - macOS Apple Silicon DMG.
  - Linux amd64 DEB, RPM, and AppImage when present.
  - Android universal APK.
  - iOS public TestFlight link.
- Prefer NSIS EXE for Windows, DMG for macOS, DEB for Linux, APK for Android,
  and TestFlight for iOS.
- Put signatures, updater archives, manifests, VSIX files, HPC bundles,
  sidecars, and unclassified files in “Other downloads”.
- Include version, architecture, format, byte size, installation guidance, and
  bilingual labels.
- Render a visible unavailable state when an installer is absent; never emit a
  broken platform link.
- HTML-escape every untrusted string and percent-encode every URL path segment.
- Reject an invalid base URL or a tag containing `/`, `\`, `.` path traversal,
  control characters, or empty text.
- Produce one self-contained page with system fonts and inline CSS/JavaScript.
- Use a Chinese-first deep-blue/graphite/copper “materials workbench” visual
  direction with an OS-aware platform rail, keyboard focus styles, responsive
  cards, and reduced-motion support.
- The page must remain useful when JavaScript is disabled.

### TDD steps

- [ ] Write a fixture test with representative assets for every supported
  platform. Assert classification, preferred format, byte size, bilingual
  labels, direct `dl.catgo-ucsd.org` URLs, and TestFlight.
- [ ] Write a partial-release test. Assert missing-platform guidance and the
  absence of empty `href` attributes.
- [ ] Write malicious tag and filename tests. Assert HTML escaping, URL
  encoding, and input rejection.
- [ ] Write a no-external-dependency test. Assert no `github.com`,
  `api.github.com`, external font, CDN, analytics, or remote script URL.
- [ ] Run the test and capture the expected red result:

  ```bash
  node --test scripts/__tests__/generate-download-page.test.mjs
  ```

- [ ] Implement exported pure helpers plus a thin CLI:

  ```text
  node scripts/generate-download-page.mjs \
    --assets-dir dist \
    --tag v1.4.6 \
    --base-url https://dl.catgo-ucsd.org \
    --output index.html
  ```

- [ ] Run the focused test until green:

  ```bash
  node --test scripts/__tests__/generate-download-page.test.mjs
  ```

- [ ] Generate a fixture page and inspect it with a local HTTP server in desktop
  and mobile viewports. Verify keyboard focus and JavaScript-disabled content.
- [ ] Check whitespace:

  ```bash
  git diff --check
  ```

- [ ] Commit:

  ```bash
  git add \
    scripts/generate-download-page.mjs \
    scripts/__tests__/generate-download-page.test.mjs
  git commit -m "feat(downloads): generate all-platform mirror page"
  ```

## Task 3: Add the streaming R2 download Worker

**Files:**

- Add: `workers/downloads/index.mjs`
- Add: `workers/downloads/index.test.mjs`
- Add: `wrangler.downloads.toml`
- Modify: `.github/workflows/deploy-cloudflare.yml`
- Modify: `scripts/__tests__/deploy-cloudflare-workflow.test.mjs`

### Required behavior

- Map `/` and `/index.html` to the `index.html` R2 key.
- Map `/latest.json` and `/<tag>/<asset>` directly to the same R2 keys.
- Allow only GET and HEAD. Return 405 with `Allow: GET, HEAD` otherwise.
- Reject encoded separators, NULs, `.`/`..` segments, and decoding failures.
- Use `env.RELEASES.head()` for HEAD and `env.RELEASES.get()` for GET.
- Forward `Range`, `If-Match`, `If-None-Match`, `If-Modified-Since`, and
  `If-Unmodified-Since` through R2's range/conditional options.
- Return 304 or 412 when the R2 conditional result has no body, as appropriate.
- Copy R2 HTTP metadata, ETag, content length, content range, cache control, and
  `Accept-Ranges: bytes`.
- Stream the R2 body directly.
- Render HTML/JSON inline and use attachment disposition for installers.
- Return a short bilingual 404 body.

### TDD steps

- [ ] Add fake-R2 tests for root mapping, object GET, HEAD, byte range,
  conditional 304, 404, 405, traversal rejection, metadata, and stream identity.
- [ ] Run the Worker test and capture the expected red result:

  ```bash
  node --test workers/downloads/index.test.mjs
  ```

- [ ] Implement the Worker request handler.
- [ ] Run the focused test until green:

  ```bash
  node --test workers/downloads/index.test.mjs
  ```

- [ ] Configure `wrangler.downloads.toml`:

  ```toml
  name = "catgo-downloads"
  main = "workers/downloads/index.mjs"
  compatibility_date = "2026-07-24"
  routes = [
    { pattern = "dl.catgo-ucsd.org/*", zone_name = "catgo-ucsd.org" }
  ]

  [[r2_buckets]]
  binding = "RELEASES"
  bucket_name = "catgo-releases"
  ```

- [ ] Extend the workflow regression test before editing the workflow. Assert:
  - download Worker paths trigger the Cloudflare workflow;
  - a `deploy-downloads` job exists;
  - it uses Wrangler with `wrangler.downloads.toml`;
  - the current official wasm-pack installer is unchanged.
- [ ] Run the workflow test and capture the expected red result:

  ```bash
  node --test scripts/__tests__/deploy-cloudflare-workflow.test.mjs
  ```

- [ ] Add the download Worker deploy job with checkout and
  `cloudflare/wrangler-action@v3`.
- [ ] Run both focused suites:

  ```bash
  node --test \
    workers/downloads/index.test.mjs \
    scripts/__tests__/deploy-cloudflare-workflow.test.mjs
  ```

- [ ] Validate the Worker bundle without deploying:

  ```bash
  pnpm exec wrangler deploy --dry-run --config wrangler.downloads.toml
  ```

- [ ] Check whitespace and commit:

  ```bash
  git diff --check
  git add \
    workers/downloads/index.mjs \
    workers/downloads/index.test.mjs \
    wrangler.downloads.toml \
    .github/workflows/deploy-cloudflare.yml \
    scripts/__tests__/deploy-cloudflare-workflow.test.mjs
  git commit -m "feat(downloads): serve R2 mirror through Worker"
  ```

## Task 4: Make mirror refreshes complete and repeatable

**Files:**

- Add: `scripts/__tests__/r2-release-mirror-workflow.test.mjs`
- Modify: `.github/workflows/r2-release-mirror.yml`

### Required behavior

- Preserve `release: published` and manual dispatch.
- Add `workflow_run: completed` for:
  - `Build Desktop App`
  - `Android build`
  - `Build HPC Bundle`
  - `Publish VSCode Extension`
  - `Build VSCode Sidecar Binaries`
- Run only for successful workflow completions.
- For workflow-run refreshes, always resolve the latest published CatGo release.
- Use the page generator instead of inline shell HTML.
- Rewrite all Tauri platform URLs to the R2 base and validate the resulting
  JSON.
- Upload the tag directory first, then `latest.json`, then `index.html`.
- Prune only after all uploads succeed and only when the synced tag is the
  repository's latest published release.
- Preserve the single concurrency group.

### TDD steps

- [ ] Add a workflow-source test that checks the exact trigger names, successful
  conclusion guard, generator invocation, mirror rewrite, upload order, and
  prune ordering.
- [ ] Assert `Build STT accelerator` is absent.
- [ ] Run and capture the expected red result:

  ```bash
  node --test scripts/__tests__/r2-release-mirror-workflow.test.mjs
  ```

- [ ] Implement the workflow changes.
- [ ] Run the focused test until green:

  ```bash
  node --test scripts/__tests__/r2-release-mirror-workflow.test.mjs
  ```

- [ ] Parse the workflow as YAML:

  ```bash
  ruby -e 'require "yaml"; YAML.load_file(".github/workflows/r2-release-mirror.yml", aliases: true)'
  ```

- [ ] Check whitespace and commit:

  ```bash
  git diff --check
  git add \
    .github/workflows/r2-release-mirror.yml \
    scripts/__tests__/r2-release-mirror-workflow.test.mjs
  git commit -m "ci(release): refresh complete R2 mirror"
  ```

## Task 5: Route every product download and update through Cloudflare

**Files:**

- Add: `src/lib/download-links.ts`
- Add: `src/lib/update/release-manifest.ts`
- Add: `src/lib/update/__tests__/release-manifest.test.ts`
- Add: `scripts/__tests__/cloudflare-download-entrypoints.test.mjs`
- Modify: `src/lib/DesktopDownloadModal.svelte`
- Modify: `src/lib/StaticModeBanner.svelte`
- Modify: `src/lib/api/config.ts`
- Modify: `src/lib/update/auto-update.svelte.ts`
- Modify: `src-tauri/tauri.conf.json`

### Required behavior

- Define one source of truth:

  ```ts
  export const DOWNLOAD_HUB_URL = 'https://dl.catgo-ucsd.org/';
  export const UPDATE_MANIFEST_URL =
    'https://dl.catgo-ucsd.org/latest.json';
  export const TESTFLIGHT_URL =
    'https://testflight.apple.com/join/FdHup5Hz';
  ```

- The download modal opens TestFlight for iOS and the Cloudflare hub for every
  downloadable desktop/mobile platform.
- The “all downloads” link, static-mode banner, and browser-only guidance open
  the hub.
- Linux fetches the mirrored Tauri manifest, compares semantic versions, shows
  mirrored notes, and opens the hub for installation.
- Windows and macOS continue to use the signed Tauri updater.
- `src-tauri/tauri.conf.json` contains exactly one updater endpoint:
  `https://dl.catgo-ucsd.org/latest.json`.
- Normal product download/update sources contain no GitHub API, release page,
  or asset URL.

### TDD steps

- [ ] Extract and test pure release-manifest parsing and version comparison for
  newer, equal, older, malformed, and prerelease versions.
- [ ] Add a static regression test that reads the product-entry files and Tauri
  config. Assert the one Cloudflare endpoint and absence of GitHub download
  paths.
- [ ] Run and capture the expected red results:

  ```bash
  pnpm exec vitest run \
    src/lib/update/__tests__/release-manifest.test.ts
  node --test \
    scripts/__tests__/cloudflare-download-entrypoints.test.mjs
  ```

- [ ] Implement shared constants and the pure manifest parser.
- [ ] Replace GitHub behavior in each product entry point.
- [ ] Run the focused tests until green:

  ```bash
  pnpm exec vitest run \
    src/lib/update/__tests__/release-manifest.test.ts
  node --test \
    scripts/__tests__/cloudflare-download-entrypoints.test.mjs
  ```

- [ ] Run Svelte and TypeScript checks:

  ```bash
  pnpm check
  ```

- [ ] Check whitespace and commit:

  ```bash
  git diff --check
  git add \
    src/lib/download-links.ts \
    src/lib/update/release-manifest.ts \
    src/lib/update/__tests__/release-manifest.test.ts \
    scripts/__tests__/cloudflare-download-entrypoints.test.mjs \
    src/lib/DesktopDownloadModal.svelte \
    src/lib/StaticModeBanner.svelte \
    src/lib/api/config.ts \
    src/lib/update/auto-update.svelte.ts \
    src-tauri/tauri.conf.json
  git commit -m "feat(downloads): use Cloudflare for app updates"
  ```

## Task 6: Validate the visual result and accessibility

**Files:**

- Modify only generator/test files if visual defects are found.
- Store screenshots outside the repository.

- [ ] Generate a representative page from real latest-release filenames.
- [ ] Serve it locally and inspect at:
  - 1440 by 1000 desktop;
  - 390 by 844 mobile;
  - keyboard-only navigation;
  - reduced motion;
  - JavaScript disabled.
- [ ] Verify:
  - the recommended platform is obvious but alternatives remain available;
  - Chinese labels lead and English translations are legible;
  - no text clips or overlaps;
  - focus is visible;
  - every downloadable link is under `dl.catgo-ucsd.org`;
  - iOS alone uses TestFlight;
  - page weight has no remote dependencies.
- [ ] If the generator changes, extend the test first, then rerun Task 2 tests.
- [ ] Commit only if validation required a change:

  ```bash
  git add \
    scripts/generate-download-page.mjs \
    scripts/__tests__/generate-download-page.test.mjs
  git commit -m "fix(downloads): polish download hub accessibility"
  ```

## Task 7: Run the complete pre-merge verification matrix

- [ ] Run all Node regression suites:

  ```bash
  node --test \
    scripts/__tests__/*.test.mjs \
    workers/downloads/index.test.mjs
  ```

- [ ] Run all frontend unit tests:

  ```bash
  pnpm test
  ```

- [ ] Run type and Svelte checks:

  ```bash
  pnpm check
  ```

- [ ] Rebuild and verify every WASM package:

  ```bash
  pnpm build:wasm
  node scripts/verify-wasm-artifacts.mjs
  ```

- [ ] Build the static production app:

  ```bash
  pnpm deploy:build
  ```

- [ ] Bundle the Worker:

  ```bash
  pnpm exec wrangler deploy --dry-run --config wrangler.downloads.toml
  ```

- [ ] Inspect branch scope and whitespace:

  ```bash
  git status --short
  git diff --check origin/main...HEAD
  git diff --stat origin/main...HEAD
  ```

- [ ] If a verification exposes a defect, add a failing regression test, fix it,
  rerun the affected gate and the entire matrix, and commit the fix separately.

## Task 8: Review, merge, and deploy the download hub

- [ ] Search for repository pull-request templates and use one if present.
- [ ] Push the feature branch after satisfying the repository's one-shot push
  approval gate.
- [ ] Open a PR summarizing the architecture, TDD evidence, and rollback.
- [ ] Wait for `prek`, `unit`, and `e2e`; fix any failure with a regression test.
- [ ] Merge only when every required check is green.
- [ ] Monitor the main `Deploy to Cloudflare Workers` run until docs, app, and
  download Worker jobs all succeed.
- [ ] Dispatch `Mirror release to R2` for the current latest tag and wait for
  success.
- [ ] Verify production:

  ```text
  GET  https://dl.catgo-ucsd.org/             -> 200 HTML
  HEAD https://dl.catgo-ucsd.org/latest.json  -> 200 JSON metadata
  GET  installer with Range: bytes=0-1023     -> 206 and Content-Range
  GET  missing object                         -> 404 bilingual response
  POST any object                             -> 405 and Allow: GET, HEAD
  ```

- [ ] Confirm the root page contains the current version and available Windows,
  macOS, Linux, Android, and iOS paths.
- [ ] Confirm the deployed app opens the hub and makes no GitHub API request for
  a normal download.

## Task 9: Prepare and publish CatGo v1.4.6

**Expected version files:**

- `package.json`
- `pnpm-lock.yaml`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `server/pyproject.toml`
- release notes or changelog files already used by the repository

- [ ] Create a release branch from the newly merged `origin/main`.
- [ ] Add failing version-consistency assertions if no existing gate covers all
  version surfaces.
- [ ] Bump CatGo to `1.4.6`; use the repository's existing Python post-release
  convention consistently.
- [ ] Update release notes to include:
  - exact smooth ASE trajectory playback and at least 24 unique presented FPS;
  - GPU impostor bonds in trajectory and static structure views;
  - Gaussian frame counting and IRC trajectory corrections;
  - China-friendly all-platform Cloudflare download center;
  - Cloudflare-only in-app update checks and packages.
- [ ] Run the full Task 7 verification matrix.
- [ ] Commit, push through the approval gate, open a release PR, wait for every
  required check, and merge.
- [ ] Create and push annotated tag `v1.4.6` from the exact merged main commit.
- [ ] Wait for successful tag workflows:
  - `Build Desktop App` for Windows, Apple Silicon macOS, and Linux;
  - `Build HPC Bundle`;
  - `Publish VSCode Extension`;
  - `Build VSCode Sidecar Binaries`.
- [ ] Dispatch `Android build` at `v1.4.6` with
  `release_tag=v1.4.6`; require a signed universal APK upload.
- [ ] Dispatch `iOS build` at `v1.4.6` with `signed=true` and `upload=true`;
  require successful TestFlight upload.
- [ ] Before publishing the draft release, require:
  - Windows NSIS EXE and MSI;
  - Apple Silicon DMG and signed updater archive;
  - Linux DEB, RPM, and AppImage if produced by the desktop workflow;
  - Android universal APK;
  - valid signed `latest.json`;
  - successful TestFlight upload;
  - any expected HPC, VSIX, and sidecar assets.
- [ ] Publish the draft as the latest release only after the checklist passes.
- [ ] Wait for the R2 mirror refresh; manually dispatch it if GitHub's release
  event does not fire.
- [ ] Verify final production state:
  - download root shows `v1.4.6`;
  - every published platform link returns 200;
  - a byte-range request against each large installer returns 206;
  - `latest.json` reports `1.4.6`;
  - every updater package URL uses `dl.catgo-ucsd.org`;
  - app download/update paths make no request to GitHub.

## Rollback

- Removing the `dl.catgo-ucsd.org/*` Worker route restores explicit R2 custom
  domain object paths.
- The mirror uploads replacement root metadata only after release assets upload
  successfully and prunes only after the synced tag is confirmed latest.
- The previous R2 `index.html`, `latest.json`, and tag assets remain valid until
  a successful refresh.
- If v1.4.6 platform builds are incomplete, leave the GitHub release as a draft
  and keep v1.4.5 as the published/latest release.

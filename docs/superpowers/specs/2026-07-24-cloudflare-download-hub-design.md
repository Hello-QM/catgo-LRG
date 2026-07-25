# Cloudflare Download Hub Design

**Date:** 2026-07-24  
**Status:** Accepted
**Audience:** CatGo maintainers and release engineers

## 1. Goal

Give users in mainland China a public, login-free, fast download path at:

`https://dl.catgo-ucsd.org/`

The page must always describe the newest published CatGo release and expose the
newest available installer for every supported platform:

- Windows: NSIS `.exe` and MSI
- macOS: Apple Silicon `.dmg`
- Linux: `.deb`, `.rpm`, and AppImage when one is published
- Android: universal `.apk`
- iOS: the current public TestFlight link

GitHub remains the maintainer-facing release source. It must not be required by
the normal user download flow.

## 2. Current State and Failure

The R2 release mirror already contains the latest release manifest and assets.
For v1.4.5, `latest.json` and a 328 MB Windows installer both return HTTP 200
from `dl.catgo-ucsd.org`.

Three gaps keep users on GitHub:

1. `https://dl.catgo-ucsd.org/` returns 404 because an R2 custom domain does
   not automatically map `/` to the `index.html` object.
2. `DesktopDownloadModal.svelte` fetches `api.github.com` and navigates to a
   GitHub Release URL. Its fallback link also points to GitHub.
3. The Tauri updater lists the GitHub manifest before the R2 manifest, while
   the Linux update checker calls the GitHub API and opens GitHub for manual
   installation. A blocked first endpoint can therefore delay or prevent an
   update even though the mirrored manifest is healthy.

The mirror workflow has only one recorded manual run. Release assets are
uploaded by several independent workflows, so a one-time `release: published`
event can mirror an incomplete asset set.

## 3. Architecture

### 3.1 One origin, one copy of every asset

Keep `catgo-releases` as the only mirrored asset store. Do not duplicate
installers inside the App Worker or maintain a second metadata database.

A small Cloudflare Worker sits on the existing
`dl.catgo-ucsd.org/*` route and reads the bucket through an R2 binding:

- `/` maps to the `index.html` object.
- `/latest.json` and `/<tag>/<asset>` map directly to the same R2 keys.
- GET and HEAD are supported.
- Object content type, length, ETag, cache metadata, conditional requests, and
  byte ranges are preserved.
- Object bodies are streamed; installers are never buffered in Worker memory.
- Missing keys return 404 and unsupported methods return 405.

Use a Worker route in front of the existing R2 custom-domain DNS record, not a
replacement custom domain. Removing the route restores the current direct-R2
behavior, which makes rollback safe.

### 3.2 Testable page generator

Move HTML generation out of inline workflow shell into a Node script. The
script receives a release tag, public base URL, and downloaded asset directory,
then produces a self-contained `index.html`.

The generated page:

- is Chinese-first with concise English translations;
- uses no external font, JavaScript, analytics, image, or CDN dependency;
- detects the visitor's OS locally and highlights the recommended installer;
- presents platform cards for Windows, macOS, Linux, Android, and iOS;
- uses direct R2 links for every downloadable installer;
- shows version, file size, architecture, and a short installation note;
- places signatures, updater files, VSIX/HPC bundles, and sidecars in a
  secondary “Other downloads” section instead of mixing them with installers;
- safely escapes release tags and asset names before writing HTML;
- remains useful with JavaScript disabled;
- contains no GitHub API call and no GitHub download fallback.

The visual direction is a restrained “materials workbench”: deep mineral blue,
cool graphite, a copper accent, compact technical labels, and a subtle lattice
motif. The memorable element is the OS-aware platform rail, not decorative
animation. Keyboard focus, mobile layout, and reduced-motion behavior are
required.

### 3.3 Release synchronization

The mirror remains idempotent and always resolves the repository's latest
published release unless an explicit manual tag is supplied.

In addition to `release: published` and manual dispatch, it re-runs after
successful completion of each workflow that can add release assets:

- Build Desktop App
- Android build
- Build HPC Bundle
- Publish VSCode Extension
- Build VSCode Sidecar Binaries

`Build STT accelerator` is intentionally excluded because it publishes an
independent `stt-accel-v*` release series rather than assets for the latest
CatGo app release. Triggering the app mirror from that workflow could select
the wrong release.

iOS is represented by TestFlight and does not require an R2 binary. A later iOS
workflow completion may still trigger a harmless idempotent refresh if its
release behavior changes.

Each refresh downloads the complete current asset list, regenerates the page
from that list, uploads new or changed objects, updates `latest.json`, and only
then prunes older tag prefixes. Concurrent refreshes collapse into the existing
single concurrency group.

### 3.4 Product entry points

All user-facing “get the app” and update paths use Cloudflare:

- the desktop download modal's primary action and “all downloads” link;
- the Tauri updater endpoint list contains only
  `https://dl.catgo-ucsd.org/latest.json`;
- that mirrored manifest contains only `dl.catgo-ucsd.org` package URLs;
- Linux checks the mirrored manifest for its latest version and opens the
  dedicated download page for manual installation;
- browser-only messages that currently tell users to visit GitHub.

iOS remains a direct TestFlight action. Windows and macOS continue to verify
the existing updater signatures before installing a mirrored package.

## 4. Error Handling

- A missing platform installer does not hide the page. Its card explains that
  the build is not available yet and offers the other-downloads list.
- A failed mirror never prunes the previous release.
- Page generation fails the workflow if an unsafe or malformed URL would be
  emitted.
- The Worker returns a short bilingual 404 response without redirecting to
  GitHub.
- R2 credential absence remains a visible skipped state, not a false success.
- Worker deployment and mirror synchronization report their public URLs and
  detected platform assets in the GitHub job summary.

## 5. Testing and Verification

Follow TDD for every behavior.

### Automated tests

1. Page-generator fixture containing all platform assets:
   - classifies each installer correctly;
   - selects the preferred format per platform;
   - emits only R2/TestFlight URLs;
   - includes version, size, and bilingual labels.
2. Partial-release fixture:
   - renders missing-platform guidance without broken links.
3. Malicious filename/tag fixture:
   - proves HTML and URL escaping.
4. Worker tests:
   - `/` to `index.html`;
   - GET, HEAD, range, conditional request, 404, and 405 behavior;
   - response bodies remain streams.
5. Workflow regression tests:
   - current wasm-pack installer remains in the Cloudflare App job;
   - download Worker is deployed with the R2 binding;
   - all release-asset workflows trigger a mirror refresh.
6. Product-entry tests:
   - ordinary download paths contain no GitHub API or Release URL;
   - the Tauri updater has exactly one Cloudflare manifest endpoint;
   - Linux derives update availability from the mirrored manifest;
   - iOS still opens TestFlight.

### Live gates after merge

- Cloudflare workflow is green for docs, App, and download Worker jobs.
- `GET https://dl.catgo-ucsd.org/` returns 200 and the latest version.
- HEAD and a small byte-range request against each available platform installer
  return the expected length/range headers.
- The page exposes the latest Windows, macOS, Linux, Android, and iOS paths.
- `app.catgo-ucsd.org` opens the dedicated page without calling GitHub.
- Windows/macOS update checks fetch the Cloudflare manifest and signed package;
  Linux update checks fetch that same manifest and open the Cloudflare page.
- A manual mirror dispatch for the latest tag succeeds and leaves
  `latest.json` on R2 URLs.

## 6. Rollback

The CI wasm-pack fix is an independent commit.

The download hub is split into reviewable commits for:

1. page generator and tests;
2. R2 Worker and tests;
3. release synchronization and product entry points.

If the Worker causes a production issue, remove or roll back its route. The
existing R2 custom domain continues serving explicit object paths. The previous
`index.html`, `latest.json`, and release assets remain recoverable R2 objects
until a successful replacement sync.

## 7. Acceptance Criteria

The work is complete only when:

- the original Cloudflare App WASM failure is green on `main`;
- `dl.catgo-ucsd.org/` is a real dedicated download page, not a 404 or GitHub
  redirect;
- every currently published platform is represented with its latest available
  build;
- future platform uploads trigger an idempotent mirror refresh;
- no normal download action requires GitHub access or login;
- every in-app update check and package download uses Cloudflare only;
- large installers support streaming and resumable byte-range downloads.

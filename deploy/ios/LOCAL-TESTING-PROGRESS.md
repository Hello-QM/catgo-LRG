# CatGo iOS — local device testing, progress & resume notes

**Goal:** build the CatGo iPhone/iPad app and run it on *our own* devices for testing
(free Apple ID, no $99 yet). Distribution decision (TestFlight / ad-hoc) deferred.

**Branch:** `feat/mobile-app-456`  ·  **Machine:** this Mac (Apple Silicon)
**Last worked:** 2026-06-02

---

## TL;DR — where we stopped

**✅ 2026-06-04: CatGo built, installed, and LAUNCHED on the iPhone (iPhone 17 Pro Max, iOS 26.4.2).**
The app runs as a live dev session loading its frontend from the Mac over the LAN.

To run it again (device plugged in + unlocked + trusted):

```bash
# from repo root:
TAURI_DEV_HOST=<MAC_LAN_IP> pnpm tauri ios dev "<your device name>"
#              ^ this Mac's current LAN IP (check: ipconfig getifaddr en0)
```

That builds CatGo and launches it on the connected device. Keep this process running —
the phone loads the UI from `http://<LAN-IP>:3100` and HMR pushes edits live.

### Two gotchas we hit on 2026-06-04 (both now solved)

1. **`tauri ios dev` hung forever on "Waiting for your frontend dev server".**
   Cause: `vite.desktop.config.ts` bound the dev server to `127.0.0.1` only, which the
   phone (a separate device on the LAN) can't reach. **Fix (now committed in the config):**
   the `server.host` now honors `TAURI_DEV_HOST`. You MUST pass `TAURI_DEV_HOST=<Mac LAN IP>`
   when running, or Vite stays on localhost and the phone can't load anything.
   *If the Mac's LAN IP changed, update it (`ipconfig getifaddr en0`).*

2. **First launch failed: "…has not been explicitly trusted by the user" (CoreDeviceError 10002).**
   The app installs fine but iOS quarantines the first launch from an untrusted dev cert.
   The signing cert is whatever **`Apple Development: <your-apple-id>`** identity Xcode's
   automatic signing picked (it may differ from your Personal Team's display name).
   **Fix (one-time per cert, on the phone):** Settings → General → VPN & Device Management →
   tap your `Apple Development: <your-apple-id>` profile → Trust. Then re-run the command above.

---

## ✅ Done

| Step | Notes |
|------|-------|
| Checked out `feat/mobile-app-456` | mobile/iOS code lives here (not on `main`) |
| Rust iOS targets | `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios` |
| `pnpm install` | deps present |
| **Full Xcode 26.5** | installed; license accepted (`sudo xcodebuild -license accept`) |
| `xcodegen` + CocoaPods | installed via Homebrew (Tauri needs both) |
| `pnpm tauri ios init` | generated `src-tauri/gen/apple/catgo.xcodeproj` |
| Info.plist patch | `ITSAppUsesNonExemptEncryption=false` set in `src-tauri/gen/apple/catgo_iOS/Info.plist` |
| iOS 26.5 platform | downloaded (8.5 GB) — device SDK `iphoneos26.5` + simulator runtime both present |
| Signing | Xcode → automatic signing ON, Team = **your Personal Team**, bundle id `com.catgo.app` accepted |

## ⬜ Remaining (start here tomorrow)

1. **Connect the iPhone/iPad** via USB → unlock → **Trust This Computer**.
   - Device must have **Developer Mode ON**: Settings → Privacy & Security → Developer Mode → On → restart.
2. In Xcode signing screen, click **Try Again** — with a device attached, the
   Personal Team generates the provisioning profile and the two red errors
   ("Communication with Apple failed / no devices", "No profiles for com.catgo.app")
   go green. *(Those errors are expected with no device attached — not a real problem.)*
3. Run `pnpm tauri ios dev`.
4. First launch on the device: **Settings → General → VPN & Device Management →
   trust the developer cert** (your developer profile).

---

## Gotchas / things to remember

- **Free Personal Team limits:** the app **expires after 7 days** (just re-run
  `pnpm tauri ios dev` / rebuild to refresh), max 3 sideloaded apps per Apple ID.
  This is the price of not paying the $99/yr — fine for personal testing.
- **`src-tauri/gen/apple/` is NOT committed** (machine-local, like `gen/android/`).
  After a fresh clone you must re-run `pnpm tauri ios init` **and re-apply the
  Info.plist patch** (`ITSAppUsesNonExemptEncryption=false`).
- **GitHub does NOT solve iOS distribution.** Unlike the desktop `.dmg`, an iPhone
  refuses to install an unsigned `.ipa` from a download. Real distribution needs
  either ad-hoc (paid, pre-registered device UDIDs) or TestFlight (paid $99/yr).
  See `deploy/ios/README.md`. Apple refs:
  - https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices
  - https://developer.apple.com/testflight/
- **Xcode 26 ships no iOS platform by default** — it's an on-demand ~8.5 GB
  download (`xcodebuild -downloadPlatform iOS`). Already done on this machine.
- If signing shows *"Failed to register bundle identifier"* on another machine/Apple ID,
  change the bundle id to something unique (e.g. `com.<yourname>.catgo`) and mirror
  it in `src-tauri/tauri.conf.json`. (Not needed here — `com.catgo.app` was accepted.)
- **iPad needed two fixes beyond the iPhone build (2026-06-07).** The PR built for iPhone
  but the iPad showed a letterboxed iPhone window rendering the *desktop* UI. Two causes,
  both now fixed (see the knobs table): (1) the generated Xcode project's device family
  wasn't pinned, so the iPad build wasn't universal → letterbox; pinned
  `TARGETED_DEVICE_FAMILY: "1,2"` in `project.yml`. (2) **iPadOS WKWebView masquerades as a
  Mac** — its `navigator.userAgent` says `Macintosh`, not `iPad` (desktop-class browsing,
  default since iPadOS 13), so `isMobile()` fell through to the desktop UI + localhost
  transport. Fixed by also matching a `Macintosh` UA with `navigator.maxTouchPoints > 1`.
  Canvas sizing needed **no** change — Threlte's `<Canvas>` `ResizeObserver` + the
  `flex:1 / 100%` `.mw-struct` pane already fill the larger iPad viewport.

## Mobile/iOS code changes — map & adjustable knobs

For anyone (or Claude) picking this up: every change below is **gated on mobile**
(mostly `TAURI_DEV_HOST` being set), so desktop + production behaviour is unchanged.
If you need to tweak the mobile build, start here. Each file also has inline `why`
comments at the change site.

| Area | File(s) | What & why | Knob to adjust |
|------|---------|------------|----------------|
| LAN backend routing | `vite.shared.ts`, `scripts/tauri-dev.mjs` | The phone isn't `localhost`; bake the Mac's LAN IP into `SERVER_URL` and whitelist the phone origin for the backend's CORS (`CATGO_ALLOWED_ORIGINS`). | Set `TAURI_DEV_HOST=<your Mac LAN IP>` at launch (`ipconfig getifaddr en0`). Both halves derive from it. |
| Vite dev (LAN/HMR/CSS) | `vite.desktop.config.ts` | Binds Vite to the LAN, pins HMR `clientPort`, and `emitCss:false` on mobile to dodge a cold-load PostCSS race. | `emitCss:false` disables CSS-only HMR on mobile dev (style edits reload the whole component). Drop it if that race no longer bites. |
| Icon rendering | `src/lib/Icon.svelte` | `height: 1em` (not `auto`) — iOS WKWebView collapses a `height:auto` + viewBox inline SVG to 0px (blank squares). | Do NOT revert to `height: auto`. |
| Tofu glyph icons | `MobileWorkspace.svelte`, `MobileFiles.svelte`, `LocaleSwitch.svelte` | iOS has no font glyph for `⬚ ⊟ ⊞ ▭ ⟳ ↰`; replaced with `<Icon>` SVG. `LocaleSwitch` gained a `compact` (icon-only) mode. | For any new mobile icon use `<Icon>` (from `src/lib/icons.ts`), never a raw Unicode symbol. |
| 3D viewer keep-warm | `MobileWorkspace.svelte` (`.mw-pane.mw-struct.hidden`) | `display:none` zeroes the WebGL canvas → blank viewer on return from the terminal. The struct pane stays laid out (off-screen, `visibility:hidden`) when inactive. | Do NOT `display:none` the structure pane. |
| Action bar overflow | `MobileWorkspace.svelte` | Compact locale switch + scrollable/shrinkable `.mw-actions` so the buttons (up to 6 when connected) never clip. | — |
| Terminal | `MobileTerminal.svelte` | Hides the OSC7 cwd-setup echo via a render-gate (private OSC 99 sentinel); registers the cwd hook for **zsh** (`precmd_functions`, not bash `PROMPT_COMMAND`); adds left/right padding. | — |
| Local file picker | `MobileWorkspace.svelte` (`accept="*/*"`) | iOS greys out unknown extensions (`.xyz`, `.cif`, …); `*/*` lets you pick any file and the handler parses by content. | Production fix: declare the formats as UTTypes in `src-tauri/gen/apple/.../Info.plist`. |
| **iPad: full-screen** | `src-tauri/gen/apple/project.yml` (`TARGETED_DEVICE_FAMILY: "1,2"`) | `project.yml` previously left device family to xcodegen's default → non-deterministic across build machines, so a build could ship iPhone-only (family `1`) and show the **letterboxed** window on iPad. Now pinned universal. | Pin in `project.yml` (tracked), **not** in Xcode — the `.xcodeproj` is gitignored/regenerated, so an Xcode-GUI toggle is wiped on the next build. Optionally add `UIRequiresFullScreen: true` to the Info.plist props to opt out of iPad Split View (protects the resize-fragile 3D viewer). |
| **iPad: mobile UI** | `src/lib/api/transport/index.ts` (`isMobile()`) | iPadOS 13+ defaults its WKWebView to *desktop-class browsing*, so `navigator.userAgent` reports `Macintosh` with **no `iPad` token** → the old regex returned false → iPad loaded the **desktop UI + HTTP/localhost transport** instead of the mobile UI + SSH transport. Fixed by also treating `Macintosh` UA **with `maxTouchPoints > 1`** as mobile (a real Mac reports 0). | The `maxTouchPoints > 1` threshold is the iPad tell. Don't drop it. A genuine desktop Mac is unaffected (touch points = 0). |
| **Terminal tabs** | `src/lib/mobile/terminal-tabs.svelte.ts`, `MobileTerminal.svelte`, `MobileWorkspace.svelte` | iTerm-style multi-terminal: a registry of tabs (one PTY each), a width-responsive "Terminals" panel (strip on phone / sidebar on iPad), kept-warm inactive tabs (`visibility:hidden`, never `display:none`). Single-host, cap 5. | Cap = `MAX_TABS` in `terminal-tabs.svelte.ts`. Keep inactive tabs `visibility:hidden` (display:none zeroes xterm's grid). Design: `docs/developer/mobile-terminal-tabs-design.md`. |
| **AI chat (API-key)** | `src/lib/mobile/ai-keys.ts`, `MobileChat.svelte`, `MobileChatSetup.svelte`; `src/lib/chat/{client-llm,provider-routing,chat-state,message-utils}.ts` | Text-only CatBot on mobile via the **client-direct** path with a user API key. Key stored **encrypted** (`transport.keyStore`), **never** localStorage. The LLM call uses `llm_fetch` (Tauri native HTTP, **no relay** — the key must not transit the third-party CORS Worker). Text-only = `run_tool_loop` with empty tools (and the request omits the `tools` field). Design: `docs/developer/mobile-ai-chat-design.md`. | API-key providers only (SDK providers hidden). Default model per provider in `MobileChatSetup`. **Device-test items:** does the Tauri HTTP plugin stream SSE (else the single-read fallback renders one-shot)? Anthropic Bearer-vs-`x-api-key` on the `/v1` compat endpoint? `AbortSignal` honored mid-request? **Never** route a key-bearing request through `relay_fetch`/`relay_url`. |

App icon: regenerated locally via `pnpm tauri icon src-tauri/icons/icon.png`, but
`gen/apple` is machine-local — the durable fix is a 1024×1024 master so `tauri icon` /
`ios init` always emit the real CatGo icon instead of the Tauri placeholder.

## Build prerequisites recap (all satisfied on this Mac)

- Xcode 26.5, license accepted · iOS 26.5 SDK + simulator runtime
- Rust iOS targets · xcodegen · CocoaPods 1.16.2 · libimobiledevice (auto-installed)
- Node/pnpm 10.28.2 · Tauri CLI v2.9.6

## Reference docs in repo

- `deploy/ios/README.md` — full iOS build guide (toolchain, signing, Keychain plan)
- `.github/workflows/ios-build.yml` — CI build on a GitHub macOS runner (simulator
  smoke build by default; signed IPA when `APPLE_*` secrets are set)

---
*Session notes — a resume guide for building and testing CatGo on iOS.*

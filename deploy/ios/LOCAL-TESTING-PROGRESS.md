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
| **Terminal input (iOS dup + CJK)** | `src/lib/mobile/terminal-input-dedup.ts`, `src/lib/mobile/terminal-ime.ts`, `MobileTerminal.svelte` | Two WKWebView soft-keyboard bugs xterm 6.0.0's textarea input mishandles. (1) **Latin doubling** — typing "hello" lands as "hhelllo" because xterm's keydown/keypress/input de-dup flags break under iOS's async event order, double-emitting to `onData`. Fixed by `createInputDedup`: WebKit fires `beforeinput` once per real insertion, so we drop the matching duplicate `onData`. (2) **CJK IME** — WKWebView routes Pinyin/Hangul through non-standard `beforeinput` types (`insertFromComposition`/`insertReplacementText`/CJK `insertText`); `createImeGuard` buffers the composed text and writes it itself, suppressing xterm's emission during composition + an 80ms confirmation-key residue window (ported from the desktop `TerminalPanel.svelte` guard, xterm.js PR #5704). | Order in `onData` is load-bearing: **IME suppress → dedup → sticky-Ctrl fold**. The guard writes via `transport.ptyWrite` (not desktop's `pty_session.write`) and clears `kb_ctrl_armed` on a CJK commit. **Unlike desktop**, non-CJK `insertReplacementText` (iOS Latin autocorrect) is passed through, not buffered, so corrected English words aren't swallowed. Listeners share `ime_ac` (AbortController), torn down on dispose. Debug: `window.__CATGO_IME_DEBUG = true` logs `[mobile-term]` events. Logic is unit-tested (`__tests__/terminal-{input-dedup,ime}.test.ts`). **Device-test:** plain English (no dup), Chinese Pinyin, Korean Hangul, and Ctrl+C via the key bar's sticky Ctrl. |
| Local file picker | `MobileWorkspace.svelte` (`accept="*/*"`) | iOS greys out unknown extensions (`.xyz`, `.cif`, …); `*/*` lets you pick any file and the handler parses by content. | Production fix: declare the formats as UTTypes in `src-tauri/gen/apple/.../Info.plist`. |
| **iPad: full-screen** | `src-tauri/gen/apple/project.yml` (`TARGETED_DEVICE_FAMILY: "1,2"`) | `project.yml` previously left device family to xcodegen's default → non-deterministic across build machines, so a build could ship iPhone-only (family `1`) and show the **letterboxed** window on iPad. Now pinned universal. | Pin in `project.yml` (tracked), **not** in Xcode — the `.xcodeproj` is gitignored/regenerated, so an Xcode-GUI toggle is wiped on the next build. Optionally add `UIRequiresFullScreen: true` to the Info.plist props to opt out of iPad Split View (protects the resize-fragile 3D viewer). |
| **iPad: mobile UI** | `src/lib/api/transport/index.ts` (`isMobile()`) | iPadOS 13+ defaults its WKWebView to *desktop-class browsing*, so `navigator.userAgent` reports `Macintosh` with **no `iPad` token** → the old regex returned false → iPad loaded the **desktop UI + HTTP/localhost transport** instead of the mobile UI + SSH transport. Fixed by also treating `Macintosh` UA **with `maxTouchPoints > 1`** as mobile (a real Mac reports 0). | The `maxTouchPoints > 1` threshold is the iPad tell. Don't drop it. A genuine desktop Mac is unaffected (touch points = 0). |
| **Terminal tabs** | `src/lib/mobile/terminal-tabs.svelte.ts`, `MobileTerminal.svelte`, `MobileWorkspace.svelte` | iTerm-style multi-terminal: a registry of tabs (one PTY each), a width-responsive "Terminals" panel (strip on phone / sidebar on iPad), kept-warm inactive tabs (`visibility:hidden`, never `display:none`). Single-host, cap 5. | Cap = `MAX_TABS` in `terminal-tabs.svelte.ts`. Keep inactive tabs `visibility:hidden` (display:none zeroes xterm's grid). Design: `docs/developer/mobile-terminal-tabs-design.md`. |
| **AI chat (API-key)** | `src/lib/mobile/ai-keys.ts`, `MobileChat.svelte`, `MobileChatSetup.svelte`; `src/lib/chat/{client-llm,provider-routing,chat-state,message-utils}.ts` | Text-only CatBot on mobile via the **client-direct** path with a user API key. Key stored **encrypted** (`transport.keyStore`), **never** localStorage. The LLM call uses `llm_fetch` (Tauri native HTTP, **no relay** — the key must not transit the third-party CORS Worker). Text-only = `run_tool_loop` with empty tools (and the request omits the `tools` field). Design: `docs/developer/mobile-ai-chat-design.md`. | API-key providers only (SDK providers hidden). Default model per provider in `MobileChatSetup`. **Device-test items:** does the Tauri HTTP plugin stream SSE (else the single-read fallback renders one-shot)? Anthropic Bearer-vs-`x-api-key` on the `/v1` compat endpoint? `AbortSignal` honored mid-request? **Never** route a key-bearing request through `relay_fetch`/`relay_url`. |
| **Chat voice input (STT)** | `src-tauri/plugins/tauri-plugin-ios-speech/` (Rust + Swift), `src-tauri/{Cargo.toml,src/lib.rs,Info.ios.plist,capabilities/mobile.json}`, `src/lib/mobile/ios-speech.ts`, `MobileChat.svelte`, `src/lib/icons.ts` (`Mic`) | WebKit has **no Web Speech API**, so the desktop `webkitSpeechRecognition` path is dead on iOS. A native plugin bridges to `SFSpeechRecognizer` + `AVAudioEngine`, forcing **on-device** recognition (no key, offline, audio never leaves the phone) and streaming `partial`/`final` transcripts to the webview as plugin events. The mic button lives in the mobile composer; `MobileChat.apply_transcript()` owns the merge/auto-send policy. | Needs **both** `NSMicrophoneUsageDescription` **and** `NSSpeechRecognitionUsageDescription` in `Info.ios.plist` — omit either and iOS silently blocks dictation. iOS-only permission lives in `capabilities/mobile.json` (`"platforms":["iOS","android"]`) so desktop capability validation never sees it. Mic button gated on `isMobile()`. **Device-test items:** permission prompt appears once? `requiresOnDeviceRecognition` supported on the test device (else it needs network)? listeners torn down on chat unmount (no leak across remounts)? |
| **Voice accents / Chinese** | `tauri-plugin-ios-speech` (`supported_locales` cmd, Swift `supportedLocales`), `ios-speech.ts` (`locale_label` via `Intl.DisplayNames`, persistence), `MobileChat.svelte` (pill + bottom sheet) | "Accent" = locale: passing `en-GB`/`en-IN`/`zh-CN`/`zh-TW`/`zh-HK` to `start_listening` swaps the recognizer's model. The picker only lists `SFSpeechRecognizer.supportedLocales()` so it can't offer a locale that fails. Selection persists in `localStorage` (`catgo.voice_locale`); a composer pill (e.g. "EN-US") opens the sheet. | Labels come from `Intl.DisplayNames` (WebKit-supported) in each locale's own language; `SPECIAL_LABELS` overrides the few Apple mislabels (zh-HK = Cantonese, not "Chinese (HK)"). **Non-US/Chinese locales often lack an on-device model → fall back to cloud (needs Wi-Fi)** — that's the existing `if supportsOnDeviceRecognition` guard, not a bug. **Device-test:** does the test iPhone actually list zh-* / en-GB in the sheet? |
| **Backend-less hardening** | `provider-routing.ts` (`llm_fetch` connectTimeout, `is_client_direct`), `pubchem.ts` (`IS_STATIC \|\| isMobile()`), `MobileChat.svelte` (SDK-provider reset), `hpc.ts`/`compute.ts`/`workflow.ts`/`workflow-v2.ts` (WebSocket `isMobile()` guards) | iOS has **no Python backend**, so any call that reaches it hangs (SYN_SENT, no connect timeout). Fixes: (1) `llm_fetch` gets `connectTimeout:10_000` so an unreachable Ollama fails fast not after 60s; (2) `is_client_direct` returns true on mobile so NVIDIA/custom hosts go direct via native HTTP; (3) PubChem queries the public API directly on mobile like OPTIMADE/MP already do; (4) a stale SDK provider persisted from desktop resets to a key-direct one (else the agent-sidecar fetch hangs); (5) the four backend WebSocket monitors (HPC, optimize, workflow v1/v2 — the v2 one retries *forever*) early-return inert on mobile. | The whole mobile app is designed to run backend-free; these close the gaps an audit found. Most backend panes are already hidden via `HIDDEN_TOOLBAR`. A true production `.ipa` should additionally build with `VITE_STATIC_ONLY=true` so the `window.fetch` stub catches any remaining stray backend call. See the 3-agent audit findings for the full feature-by-feature map. |

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

## 2026-06-08 session — iPad (M5) device run + AI-chat testing

Branch `ios-app`. Ran on a physical **iPad Pro 13" (M5, iPadOS 26)**. Several
issues surfaced building + running on a fresh device/OS; fixes below.

### Launch command (CORRECTED — `--host` flag is required)

```bash
TAURI_DEV_HOST=<MAC_LAN_IP> pnpm tauri ios dev "<device>" --host <MAC_LAN_IP>
```

`TAURI_DEV_HOST` (env) drives Vite's bind + backend CORS, but Tauri CLI **2.9.6
does not rewrite the app's baked devUrl from the env var alone** — you MUST pass
`--host <ip>` too, or the app loads `http://localhost:3100` (unreachable from the
device → "did you grant local network permissions?"). With `--host`, Tauri logs
`Replacing devUrl host with <ip>` and injects the ATS / local-network plist keys.

### Build/run fixes (all required to get a device build to launch)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `tauri ios dev` hangs, then `Could not connect to http://localhost:3100 after 180s` | Vite bound to ONLY `TAURI_DEV_HOST`; Tauri's readiness poll hits `localhost` (the configured devUrl), which isn't served. | `vite.desktop.config.ts`: bind mobile to `0.0.0.0` (`host: tauri_dev_host ? '0.0.0.0' : '127.0.0.1'`) so localhost + LAN both work. |
| Xcode build: `PhaseScriptExecution failed … pnpm: command not found` | Xcode GUI builds inherit launchd's minimal PATH (no Homebrew/cargo). | `gen/apple/project.yml` → `preBuildScripts` "Build Rust Code": prepend `export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"`. Re-run `xcodegen generate`. |
| Xcode: `Signing requires a development team` | `project.yml` carried no team, so each `xcodegen` regen dropped the Xcode-GUI selection. | `gen/apple/project.yml` target `settings.base`: `DEVELOPMENT_TEAM: 6G73SADM5R` + `CODE_SIGN_STYLE: Automatic` (re-apply after `tauri ios init`). Team = the one local `Apple Development: ijennheart@gmail.com` identity. |
| App launches but: `Failed to request http://localhost:3100 … local network permissions?` | See "Launch command" — `--host` not passed. | Pass `--host <ip>`; grant the iOS **Local Network** prompt (or Settings → Privacy & Security → Local Network → CatGo). |

`gen/apple` is gitignored/regenerated — re-apply the PATH + signing edits to
`project.yml` after any `tauri ios init`, then `xcodegen generate`.

### AI-chat (mobile, client-direct) findings

| Finding | Status / fix |
|---------|--------------|
| **Default model `gemini-2.0-flash` 429s with `limit: 0`** | Google **retired 2.0-flash 2026-03-03**; free-tier quota is 0. Bumped `DEFAULT_MODELS.gemini` → `gemini-2.5-flash` in `MobileChatSetup.svelte`. (Free tier is per-**project** & per-**model**; new keys/projects don't help — only a live model does.) |
| **Gemini `AQ.`-prefix keys** | New Google key format (replaces `AIza`). Works on CatGo's **native** Gemini path; known to break on **OpenAI-compat** endpoints ("Multiple authentication credentials"). |
| **No SSE streaming on iOS** | EXPECTED — the Tauri HTTP plugin buffers the whole body; `stream_client_llm`'s single-read detection falls back to one-shot render. Confirmed on device; not a bug. |
| **Chat freezes after loading a structure → no reply, no new sends** | The structure goes into the system prompt; that request **hung** (no client-side timeout) → awaited stream never settled → `loading` stuck `true` → every later message silently queued (`chat-state` line ~495). **Fixed:** added an idle-timeout watchdog (60s, re-arms per chunk, folded into the Stop signal) + clean retryable error in `stream_client_llm`. Test: `client-llm.test.ts` "idle-timeout …". |
| **System prompt advertised tools the mobile path doesn't have** | Mobile chat is tool-free (`isMobile() ? [] : CLIENT_TOOLS`), but `build_sdk_system_prompt` told the model to "call catgo_* tools directly" — so it promised actions (e.g. "I'll check the active structure") and burned turns / stalled. **Fixed:** added a `text_only` branch to `build_sdk_system_prompt` (no tool talk; answer from the inline structure context); `chat-state` passes `isMobile()`. The same `text_only` prompt also instructs **Unicode** formulas (TiO₂, α-Fe₂O₃) instead of LaTeX `$...$` — `MobileChat.svelte`'s renderer is lightweight by design (no KaTeX, to avoid its ~250 KB load), so LaTeX rendered raw (`$TiO_2$`). |
| **Typed mobile chat didn't get the structure context** | `structure_context.value` is only fed by desktop `ChatPane` and the `Structure.svelte` *voice* path — neither runs for `MobileChat` (tab `mobile`). So typed chat only had context by coincidence (right after a fetch); after an app restart (structure restored, no load event) it reported "no structure loaded". **Fixed:** `MobileChat` now takes a `structure` prop (passed from `MobileWorkspace`) and rebuilds `structure_context` via `build_structure_context({structure})` on every send — always current across restarts and mid-chat swaps. |
| Open: structure context may be sent **un-trimmed** | A large structure could bloat the prompt enough to stall every time. Timeout makes it fail gracefully; trimming/summarizing the context is the real cure (TODO). |
| Transient errors (429 rate-limit, 503 overload, 5xx/529) | **Fixed:** `stream_client_llm` now auto-retries the connect/status phase with exponential backoff (3 attempts; honors `Retry-After` up to 8s; abortable via Stop/idle-timeout; never retries once a 200 body streams). `gemini-2.5-flash` free tier is 10 RPM; busy-model 503s and brief 429s now self-heal before surfacing. Tests: `client-llm.test.ts` "auto-retries transient 503s", "does NOT retry a non-transient 4xx". |

### Multi-chat tabs + minimize (feature)

Mirrors the terminal tab bar for the AI chat. New `src/lib/mobile/chat-tabs.svelte.ts`
(module-scope reactive registry, like `terminal-tabs.svelte.ts`) — each tab's `id`
IS its chat-state slice id, so history/loading/abort/queue come free per tab.
`MobileChat.svelte` drives off `chat_tabs.active_id`, renders a header tab strip
(tap=switch, long-press=close sheet, **+**=new, cap `MAX_CHAT_TABS=5`) and a
**Collapse**(minimize) button — minimize/close just dismiss the overlay; chats persist
at module scope and restore on reopen. Tabs label by first message. New i18n keys:
`ai_new_chat`, `ai_minimize`, `ai_close_chat` (en + zh).

### Other mobile fix

- **Terminal tab long-press selected the "Delete" label text** (WKWebView native
  text-selection on press-and-hold). `MobileWorkspace.svelte`: added
  `-webkit-user-select: none` + `-webkit-touch-callout: none` to `.mw-tabchip-btn`
  and `.mw-sheet-btn`.

### SSH "connect to this Mac" (works)

Enable **System Settings → General → Sharing → Remote Login**, then in CatGo's
Connect dialog: host = Mac LAN IP, user = Mac username, port 22, Mac login
password. (iPad must be on the same LAN — it already is, since it loads the UI
from that IP.)

## 2026-06-09 — connection + terminal/keyboard polish (device-tested)

Found while a colleague + we tested SSH connections and the terminal on iPhone/iPad.

### SSH connection password (`MobileConnect.svelte`, `OtpDialog.svelte`)

- **Saved password never applied → "Password authentication rejected".** The
  `password = pw` copy lived INSIDE `if (!auto_password)`, but tapping a saved
  connection (`pick_saved`) pre-loads `auto_password`, so the block was skipped
  and an empty password was sent. Fixed: apply the saved password whenever it's
  the password method (any load path); mark `used_saved_pw` when sending the
  unchanged saved password so we don't re-offer to save it.
- **No masked feedback on tap.** `pick_saved` now fills the (masked) password
  field from the store for the password method, so the user sees `••••` and can
  just tap Connect.
- **2FA clusters.** Reconnect now pre-fills the password prompt(s) from the saved
  password even in a MIXED password+OTP round (new `prefill` prop on
  `OtpDialog`); submits silently only when the whole round is password prompts.
  Generalized from the old "exactly one prompt" rule.
- **Key-trim consistency.** `persist_non_secrets` trims host/username so the saved
  descriptor matches the (trimmed) password key.

### iPhone top-bar overflow (`MobileWorkspace.svelte`)

- Save (and Disconnect) were scrolling off the right edge. Wrapped the secondary
  actions in a `.mw-actions-scroll` flexbox scroller; Save/Disconnect stay OUTSIDE
  it (`flex-shrink:0`) so they're always pinned/visible on a narrow screen.

### Terminal soft-keyboard (`MobileTerminal.svelte`, `MobileWorkspace.svelte`)

- **Key bar hidden under the keyboard.** It floats `position:fixed` just above
  the keyboard (height tracked via `visualViewport`; no transformed ancestors so
  fixed tracks the viewport). CSS transition + debounced re-fit keep it smooth.
- **Split mode auto-expand.** When the keyboard opens in split layout, the
  workspace switches to full-terminal (keep-warm `visibility:hidden`, NOT
  display:none) and restores the split on close — so the terminal is usable.
- **Collapse toggle.** A toggle on the bar hides it to a corner pill (terminal
  visible) and back; `preventDefault` + refocus keep the keyboard up. Styled to
  fill the strip (`align-self:stretch`, strip bg) so there's no dark box.

### Visualizer (`MobileWorkspace.svelte`)

- Touch-drag to rotate the 3D viewer triggered WKWebView text selection
  ("selects the whole thing"). Added `-webkit-user-select:none` +
  `-webkit-touch-callout:none` to `.mw-struct`.

### Review follow-ups (post code-review)

- **Per-tab stream cancel.** `MobileChat`'s unmount-cancel `$effect` read the
  reactive `active_id`, so switching tabs cancelled the LEFT tab's stream. Now
  reads it via `untrack` → cancels only on real unmount.
- **Silent password-save failure.** `save_password_yes` swallowed a `keyStore`
  error. Now surfaces it in the save dialog with a Retry (`save_pw_failed` /
  `save_pw_retry`).
- **Stale saved password.** If a saved password is rejected on reconnect (changed
  server-side), clear it in-memory AND from the store (overwrite empty — no
  delete command; empty reads back as "none") and prompt to re-enter
  (`saved_pw_rejected`). Mainly matters for the keyboard-interactive auto-answer
  path, which the user couldn't otherwise interrupt.

### Fixed: Xcode deployment-target warnings

- The ~390 *"object file built for newer iOS (17.0) than being linked (14.0)"*
  warnings: added `export IPHONEOS_DEPLOYMENT_TARGET="${...:-14.0}"` to the
  `gen/apple/project.yml` "Build Rust Code" preBuildScript (next to the PATH
  export) so cargo builds the Rust lib for iOS 14 to match the project's link
  target. **Machine-local (gen/apple is gitignored) — re-apply after
  `tauri ios init`, then `xcodegen generate` + rebuild.**

### Not changed — by design / platform

- **No SSE streaming on iOS** — the Tauri HTTP plugin buffers the whole body;
  fixing needs native plugin work. The single-read fallback + idle-timeout make
  it correct, just one-shot. Out of scope.
- **Conservative password-prompt capture** — only offers to save when the prompt
  is recognized as a password (excludes passcode/OTP/duo) so we never persist a
  one-time code. Intentional; broadening it is unsafe.
- **One abort-listener per send** in `stream_client_llm` — bounded and GC'd with
  the per-send AbortController; not a real leak.

---
*Session notes — a resume guide for building and testing CatGo on iOS.*

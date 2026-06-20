> **DECISION (2026-06-19): NOT pursuing.** The built-in OS keyboard dictation
> (Android Gboard / iOS 听写) is already strong enough for CJK and other input,
> and it feeds text fields as ordinary input — the terminal CJK `insertText` fix
> (commit d4a7db3) already covers dictation into the terminal. Building/shipping
> a whisper.cpp engine + model download was judged not worth the size/battery/
> maintenance cost. This document is retained for the analysis (esp. why
> WASM-in-WebView is forbidden — the WebKit OOM leak) should the decision be
> revisited. The in-app SFSpeech mic button (iOS) stays as-is; its multi-sentence
> "second sentence overwrites first" quirk (A2) is left unfixed.

# Native whisper.cpp on-device STT for CatGo mobile — design + implementation plan (2026-06-19)

Replace the iOS-only `SFSpeechRecognizer` voice input with **whisper.cpp linked
as a native library** (iOS Metal, Android NDK), on the **same JS event contract**
so the chat consumer barely changes. Grounded against current source; cited
`file:line` throughout. No production code written yet — this is the spec.

## A. Goal + why

**What:** dictation in the mobile AI chat (and later terminal voice) powered by
whisper.cpp running natively on the device, not SFSpeech, not WASM-in-webview.

**Why:**
- **Chinese quality.** SFSpeechRecognizer is weak on Mandarin/code-mixed CN-EN;
  the team already overrides `zh-HK`/`yue-CN` labels by hand because Apple's
  locale handling is lossy (`src/lib/mobile/ios-speech.ts:46-50`). Whisper
  `small`/`medium` multilingual is materially better on zh.
- **Unify with desktop, conceptually.** Desktop already fled WASM Whisper to a
  native backend (`server/catgo/routers/stt.py:1-15`: "WebKit webviews leak
  ~0.8 GB of unreclaimable WASM memory per inference and OOM"). Mobile has the
  *same* WKWebView, so the *same* rule applies — but mobile is **backend-free**
  (`src-tauri/tauri.ios.conf.json:4` / `tauri.android.conf.json:4`
  `"externalBin": []`), so it can't reach a Python sidecar. The native-library
  route is the mobile analogue of the desktop native backend.
- **Offline, no API key, audio never leaves the phone** — same privacy posture
  as today's SFSpeech on-device mode (`SpeechPlugin.swift:114-118`).

**Non-goal / forbidden:** WASM Whisper (transformers.js) in the webview. This is
the exact bug the team escaped; do not reintroduce it on mobile. See
`MEMORY: webkit-wasm-memory-leak-native-stt`.

## B. Hard constraints (verified against source)

| Constraint | Evidence |
|---|---|
| Mobile is backend-free — no faster-whisper sidecar | `tauri.ios.conf.json:4`, `tauri.android.conf.json:4` `externalBin:[]`; build uses `VITE_STATIC_ONLY=1` |
| WASM-in-webview forbidden (OOM) | `server/catgo/routers/stt.py:3-6`; MEMORY note |
| iOS sandbox can't spawn CLI sidecars | so whisper.cpp must be a **linked library**, not the `whisper-cli` binary the desktop accelerator ships |
| Existing whisper.cpp build emits a **CLI + dylibs**, NOT iOS static libs | `scripts/build-whispercpp.sh:36-48` builds `--target whisper-cli`, copies `*.so/*.dylib/*.dll`; no `xcframework`, no `-DBUILD_SHARED_LIBS=OFF` static `.a`, no iOS toolchain (`-DCMAKE_SYSTEM_NAME=iOS`). The accelerator is **desktop-only** (`build-stt-accel.yml:24-37`: ubuntu/macos-x64/windows runners, `os-arch-api` keys, never an iOS slice). |

**Conclusion:** the existing Metal build output is **not reusable as-is for iOS**.
It is an x86-or-arm64 *macOS desktop* `whisper-cli` + dylibs. For the phone we need
a *new* compile: whisper.cpp built for the iOS arm64 device + simulator, Metal
backend, packaged as an **`.xcframework`** (or static `.a` + headers) and linked
into the Swift plugin. whisper.cpp upstream ships an iOS example and supports
`xcframework` packaging, so the toolchain exists; we just don't invoke it yet.

## C. Architecture

### C.1 Plugin shape — extend, don't fork

The current iOS plugin (`src-tauri/plugins/tauri-plugin-ios-speech/`) is the
proven pattern: a path-dependency Cargo crate
(`src-tauri/Cargo.toml:97`), registered iOS-only at
`src-tauri/src/lib.rs:217-218`. Its Swift `SpeechPlugin` already solves the hard
parts we need to **reuse verbatim**:

- AVAudioEngine mic tap + serial `DispatchQueue` teardown discipline
  (`SpeechPlugin.swift:35-53,99-191`). The comment block at `:11-20` is
  load-bearing: engine `stop()`/session `setActive(false)` **block** and freeze
  the WKWebView if run on main — keep all audio work on `queue`.
- `installTap`/`removeTap` reentrancy guard via `isTapInstalled`
  (`SpeechPlugin.swift:50-53,128-185`).
- `trigger("partial"/"final"/"error", ...)` event emission
  (`SpeechPlugin.swift:150-163`) — the JS side (`ios-speech.ts:123-137`) listens
  on exactly these names.

**Decision:** rather than a brand-new `tauri-plugin-mobile-whisper`, **add a
whisper engine inside the existing plugin** and keep the SFSpeech engine as a
fallback (see §H Migration). The Rust command surface and JS bridge stay; only
the Swift gains a `WhisperEngine` alongside the SFSpeech path, switched by a
`engine` arg on `start_listening`. This minimizes the `gen/apple` regeneration
surface (one plugin, not two) and keeps `MobileChat.svelte` untouched.

> If Android forces a clean split (different language/build), we can rename to
> `tauri-plugin-mobile-speech` and host both platforms' native code under it.
> Keep the crate/JS names stable to avoid touching `lib.rs` and capabilities.

### C.2 Audio → inference dataflow (the streaming problem)

SFSpeech is natively streaming: it hands back a growing `formattedString` each
callback (`SpeechPlugin.swift:144-154`). **whisper.cpp is NOT streaming** — it
transcribes a *complete* PCM buffer in one shot. We must synthesize the
`partial`/`final` contract on top of a batch transcriber:

```
mic (AVAudioEngine tap, 16 kHz mono f32)         [reuse SpeechPlugin tap]
  → ring buffer (PCM, accumulating)
  → VAD-segmented OR sliding-window scheduler
     · partial: every ~1.0–1.5 s, run whisper on [start..now] of the
       current utterance → trigger("partial", full text so far)
     · final:   on VAD silence (~600–800 ms) OR stop_listening() →
       run whisper on the whole utterance → trigger("final", text); reset buffer
  → whisper.cpp full(ctx, params, pcm) on a background queue (Metal)
```

Two viable strategies (recommend starting with **sliding re-decode**, simplest):

1. **Sliding re-decode (recommend for v1).** Keep the whole current utterance in
   a buffer; on a timer (or on every N samples) re-run whisper on the entire
   utterance-so-far and emit the result as `partial`. On silence/stop, the last
   decode is the `final`. Simple, matches the "full running transcript each
   event" contract `apply_transcript` already assumes
   (`MobileChat.svelte:380-395`). Cost: O(utterance²) compute as it grows — fine
   for short chat utterances (a few seconds), bad for long dictation. Cap
   utterance length (e.g. force a `final`+segment-commit at ~15 s).
2. **VAD-segmented commit.** Run a lightweight VAD (whisper.cpp ships an energy
   VAD; or port the desktop Silero approach noted in `stt.py:13-14`), decode each
   speech segment once on its trailing edge, emit `final` per segment. Lower CPU,
   but partials within a segment need a separate timer. This is the better
   long-term design and aligns with desktop (browser runs Silero VAD, POSTs
   segments — `stt.py:12-14`).

**Latency tradeoff vs SFSpeech (be honest in the UX):** SFSpeech partials feel
instant. whisper partials lag by the decode time of the model on the phone CPU/GPU
(tiny ~real-time on A-series Metal; small noticeably slower). Set expectations:
partials may update every ~1 s, not per-word. If that feels bad, keep SFSpeech as
the default for English and offer Whisper as the "better Chinese" option (§H).

### C.3 JS contract — unchanged

`src/lib/mobile/ios-speech.ts` stays the public surface: `start_listening`,
`stop_listening`, `supported_locales`, `on_transcript({on_partial,on_final,
on_error})` (`ios-speech.ts:93-159`). `MobileChat.svelte:407-442 toggle_mic` and
`:389-400 apply_transcript` need **no change** for the happy path — whisper just
becomes the engine behind the same events.

One addition: an **engine selector**. Add an optional `engine?: 'sfspeech' |
'whisper'` (and `model?` for whisper size) to `start_listening`, defaulting per
§H. `supported_locales()` for whisper returns whisper's multilingual set (a fixed
list, not Apple's), so the picker (`MobileChat.svelte:343-360`) keys off the
active engine.

## D. iOS implementation

### D.1 Build whisper.cpp for iOS (the missing artifact)

New script `scripts/build-whispercpp-ios.sh` (sibling to the existing
`build-whispercpp.sh`). It must:
- clone whisper.cpp at a **pinned ref** (the desktop script already pins via the
  3rd arg — `build-whispercpp.sh:15-16`; reuse the same ref for parity).
- build **static** libs for `arm64` device + `arm64`/`x86_64` simulator with
  `-DGGML_METAL=1 -DBUILD_SHARED_LIBS=OFF` and the iOS toolchain
  (`-DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0` — matches
  `Package.swift:8` `.iOS(.v13)`), or invoke whisper.cpp's own
  `build-xcframework.sh` if present at the pinned ref.
- package as `whisper.xcframework` (libwhisper + libggml + libggml-metal +
  `default.metallib` + headers) staged into the plugin's `ios/` tree.

> Metal note: whisper.cpp's Metal backend needs `ggml-metal.metal`/`default.metallib`
> bundled and loadable at runtime. The plugin must add the metallib as a bundle
> resource and point GGML at it. This is the #1 iOS-Metal footgun.

### D.2 Link into the Swift plugin

`tauri-plugin-ios-speech/ios/Package.swift` currently has one target depending on
`Tauri` (`Package.swift:19-26`). Add:
- a **binary target** for `whisper.xcframework`:
  `.binaryTarget(name: "whisper", path: "whisper.xcframework")`, and add `whisper`
  to the plugin target's `dependencies`.
- the metallib + GGML model resources via `.copy(...)` in the target's
  `resources:` (or bundle them through the Xcode project — see §G regeneration).

The committed-source boundary is favorable: the plugin's `.gitignore` only
ignores regenerated bindings (`.tauri/`, `ios/.build/`, `Package.resolved`,
`permissions/autogenerated/`) — **hand-authored Swift + Package.swift +
default.toml are committed**. So we *can* commit a checked-in `Package.swift` that
references the xcframework. The xcframework binary itself (~tens of MB) should be
fetched/built rather than committed (see §G + §F download decision).

### D.3 Swift `WhisperEngine`

New `ios/Sources/WhisperEngine.swift`, mirroring `SpeechPlugin`'s threading:
- reuse the AVAudioEngine tap (factor the audio capture out of `SpeechPlugin` so
  both engines share it; tap delivers 16 kHz mono f32 — note SFSpeech uses the
  input node's native format `SpeechPlugin.swift:127`, whisper needs a
  **resample to 16 kHz mono** via `AVAudioConverter`).
- own a `whisper_context` loaded from the GGML model (lazy, once).
- run the sliding/VAD scheduler (§C.2) on the serial `queue`; call
  `whisper_full` on a **dedicated inference queue** so a long decode doesn't stall
  the mic tap.
- emit `trigger("partial"/"final"/"error", ["text": ...])` — identical to
  `SpeechPlugin.swift:150-163`, so JS is unchanged.

### D.4 Permissions — simpler than today

whisper does **not** use Apple's Speech framework, so
`NSSpeechRecognitionUsageDescription` is **not required** for the whisper path
(only `NSMicrophoneUsageDescription`). Today both are declared
(`src-tauri/Info.ios.plist:22-25`). Keep both while SFSpeech remains a fallback;
if we ever fully drop SFSpeech, the speech-recognition string can go. The plugin's
`requestPermission` (`SpeechPlugin.swift:65-72`) currently AND-gates mic+speech —
add a mic-only path for the whisper engine so denial of speech auth doesn't block
whisper.

## E. Android implementation (greenfield — flag the effort)

**There is no existing Android native plugin.** `src-tauri/plugins/` holds only
`tauri-plugin-bg-grace` and `tauri-plugin-ios-speech`, both iOS-only
(`grep` confirmed: zero `.kt`, zero `android/` plugin dirs). So Android voice
input **does not exist today at all** — this is net-new, the larger of the two
phases.

Shape (Tauri mobile Android plugin = Kotlin + JNI):
- add an `android/` source set to the plugin (Kotlin `@TauriPlugin` class with
  `@Command` methods mirroring the iOS `@objc` commands), registered through the
  same Rust `init()` (`src/lib.rs` gains an Android-cfg `register_android_plugin`
  branch alongside the iOS one at `:217-218`).
- mic capture via `AudioRecord` (16 kHz mono PCM16) → same ring-buffer/VAD
  scheduler.
- whisper.cpp built via the **NDK** (`-DCMAKE_SYSTEM_NAME=Android`,
  ABIs `arm64-v8a` + optionally `x86_64` for emulator), producing
  `libwhisper.so`/`libggml*.so` under `jniLibs/<abi>/`. CPU backend first;
  **Vulkan optional** (whisper.cpp supports `-DGGML_VULKAN=1` — the desktop script
  already does Vulkan, `build-whispercpp.sh:19`, so the shader build is known, but
  Android Vulkan driver coverage is uneven — make it opt-in).
- JNI bridge (small C shim or `whisper.cpp`'s bundled `whisper_android` JNI) so
  Kotlin can call `whisper_full` and stream text back via the same
  `trigger(...)` event names.

**Effort flag:** Android is roughly 2× the iOS work — new Kotlin plugin
scaffolding, NDK cross-compile in CI, JNI, AudioRecord, AND it must survive the
`gen/android` regeneration problem (§G) which is *already* biting released APKs
(`plan/mobile-input-issues.md:67-86`).

## F. Model management

| Question | Recommendation |
|---|---|
| Which model | **`ggml-small`** multilingual for zh quality, or **distil-small** if a GGML build exists, as the default. Offer `tiny`/`base` as a "fast" option for low-end devices. Use **quantized** GGML (`q5_0`/`q8_0`) to cut size & memory. |
| Size impact | tiny ≈ 75 MB, base ≈ 142 MB, small ≈ 466 MB (q5 ≈ 180 MB), medium ≈ 1.5 GB. small-q5 (~180 MB) is the sweet spot for zh. **Do NOT bundle** a 180 MB+ model in the IPA/APK. |
| Bundle vs download | **Download-on-demand**, mirroring the desktop accelerator exactly (`stt.py:248-277` `/accel/install` + `/accel/model`; `deploy/stt-accel/README.md:17` "Everything lands in `~/.catgo/stt-accel/{bin,models}` — never the app bundle"). On mobile there's no backend, so the **plugin** (Swift/Kotlin) downloads the GGML from a pinned URL (GitHub Release, same as `stt-accel-manifest.json`) into app-support storage, sha256-verified. |
| Storage path | iOS: `Application Support/whisper/ggml-<size>.bin`. Android: `filesDir/whisper/`. Mirror the desktop `accel.model_path` naming `ggml-<size>.bin` (`stt.py:57-61`) for cross-surface consistency. |
| First-run UX | First mic tap with whisper engine + no model → emit a `partial`/`error` or a dedicated `model_required` event; the chat shows a one-time "Download voice model (~180 MB, Wi-Fi recommended)" sheet, then a progress indicator. Reuse the language-sheet pattern (`MobileChat.svelte:338,356-360`). Offer Wi-Fi-only gating. |
| Offline | Once downloaded, fully offline (the whole point). |

Optionally tiny/base **could** be bundled (75–142 MB) so voice works out-of-box
with a "download small for better Chinese" upsell. Decide per IPA/APK size budget
(open question §K).

## G. Build / CI impact — surviving `gen/{apple,android}` regeneration

This is the highest-risk operational concern, and it's a **known active bug**:
`plan/mobile-input-issues.md:67-86` documents that CI's `tauri android init`
regenerates `gen/android` from stock templates and **never re-applies** the
committed `MainActivity.kt`/`AndroidManifest.xml` patches, so **every released APK
ships broken inset handling**. Native whisper linking must not fall into the same
trap.

**iOS is mostly safe by construction.** The plugin lives *outside* `gen/apple` —
it's a path-dependency crate with **committed Swift + Package.swift**
(`.gitignore` only sheds `.tauri/`, `.build/`, `Package.resolved`). `tauri ios
init`/`build` regenerates `gen/apple` but pulls the plugin in via Cargo +
`register_ios_plugin` (`lib.rs:176`), so the Swift survives. **What does NOT
survive automatically:** Xcode project settings that must live in `gen/apple`
(e.g. embedding the metallib/model as bundle resources, extra framework search
paths if not expressed via Package.swift). Prefer expressing **everything**
through `Package.swift` `resources:`/`binaryTarget` so it's plugin-local and
regeneration-proof; anything that can't be must be re-applied by a committed
override + post-init script — the same fix `mobile-input-issues.md:83-85`
prescribes for Android.

**Android is NOT safe by construction.** The Kotlin plugin source can live in the
committed plugin dir, but `jniLibs` placement, NDK ABI config, and Gradle deps may
land in `gen/android`. **Action:** extend the override mechanism the input-issues
plan already calls for (`deploy/android/overrides/` + a post-`init` copy script
run in CI) to also stage `jniLibs/*` and any Gradle snippets. Build the whisper
`.so`s in a CI step (NDK) before `tauri android build`, copy into the regenerated
`gen/android/app/src/main/jniLibs/`.

**New CI:** add iOS-arm64 + Android-NDK whisper.cpp build jobs. Model these on
`build-stt-accel.yml` but with **mobile toolchains** (the existing matrix is
desktop-only — `build-stt-accel.yml:24-37`). Output an `xcframework` artifact and
per-ABI `.so` artifacts; publish GGML models + a mobile manifest to a Release
(reuse the `stt-accel-manifest.json` assembler pattern,
`build-stt-accel.yml:115-154`).

## H. Migration — keep SFSpeech, add an engine toggle

**Recommend: do NOT hard-replace SFSpeech.** Add an **engine abstraction** in
`ios-speech.ts` and a user toggle:
- `engine: 'sfspeech' | 'whisper'`, persisted next to `voice_locale`
  (`ios-speech.ts:74-91` `localStorage` pattern). Default `sfspeech` for English
  locales (instant partials, zero download), `whisper` offered/auto for zh.
- `start_listening(locale, {engine, model})`; the Swift plugin routes to
  `SpeechPlugin` (existing) or `WhisperEngine` (new). Same events out.
- `supported_locales()` returns Apple's set for sfspeech (`SpeechPlugin.swift:58-61`)
  vs whisper's multilingual set for whisper.
- Fallback chain: whisper selected but model missing/download-declined → fall back
  to sfspeech (iOS) with a notice; Android has no sfspeech, so whisper is the only
  engine there and the model download is mandatory before first use.

This makes the change **additive** (preserve-existing-functionality), keeps
`MobileChat.svelte` ~unchanged, and lets us ship iOS-whisper as opt-in before
trusting it as default.

## I. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| iOS memory — but **native**, not webview | low | This is the whole point: native whisper has no JSC/WASM leak (`stt.py:3-6`). Still cap utterance length & free `whisper_context` on teardown. |
| Inference latency on phone | **high** | tiny/base near real-time on Metal; small lags. Sliding re-decode is O(n²). Default to smaller model for partials, decode `small` only for `final`; or VAD-segment (§C.2). Set UX expectations. |
| Binary size (xcframework + libggml-metal) | med | Static libs add several MB to the IPA; acceptable. Models are the real weight → download-on-demand (§F). |
| Model download bandwidth (~180 MB) | med | Wi-Fi-only default, progress UI, resumable, sha256-verified; one-time. |
| Battery / thermal during long dictation | med | whisper on Metal/CPU is heavier than SFSpeech. Cap session length; stop engine promptly on teardown (reuse `SpeechPlugin` teardown discipline `:176-191`). |
| App Store / Play review | low | On-device ML is fine; no ITSAppUsesNonExemptEncryption surprises. Downloading a model post-install is allowed (it's data, not executable code) — keep it data-only, never download executable binaries on iOS. |
| `gen/{apple,android}` regeneration losing native linking | **high** (already biting Android) | §G: express via Package.swift on iOS; committed overrides + post-init script + CI build step on Android. |
| Android greenfield scope | high | Phase it after iOS (§J); it's a new Kotlin/JNI/NDK plugin from zero. |

**Single biggest risk: inference latency / streaming UX** — whisper isn't
streaming, so matching SFSpeech's instant per-word partials on a phone is the hard
part; the sliding-window/VAD design and model-size choices in §C.2/§F are the
whole ballgame.

## J. Phased rollout + task breakdown

### Phase 0 — spike (validate the unknown)
- [ ] `scripts/build-whispercpp-ios.sh`: build whisper.cpp `xcframework` (Metal,
      static, arm64 device+sim) at the pinned ref. **Verify the metallib loads on
      a real device.** (highest-uncertainty step — do first)
- [ ] Throwaway Swift harness: load `ggml-tiny`, transcribe a bundled wav,
      measure decode latency on an actual iPhone. Decide sliding vs VAD.

### Phase 1 — iOS whisper engine (reuses existing plugin + Metal toolchain)
- [ ] Factor shared AVAudioEngine capture out of `SpeechPlugin.swift` into a
      `MicCapture` helper (16 kHz mono f32 via `AVAudioConverter`).
- [ ] `ios/Sources/WhisperEngine.swift`: context load, scheduler, `trigger` events.
- [ ] `ios/Package.swift`: add `whisper` binaryTarget + metallib resource
      (`Package.swift:19-26`).
- [ ] `src/lib.rs` Swift plugin: add `start_listening` `engine`/`model` args; route.
- [ ] `tauri-plugin-ios-speech/src/lib.rs`: thread `engine`/`model` through
      `StartArgs` (`lib.rs:61-64,97-101`).
- [ ] Model download in Swift (app-support, sha256, progress events) + a
      `model_required`/progress event.
- [ ] `ios-speech.ts`: engine field, persisted toggle, whisper locale set
      (`ios-speech.ts:74-101`).
- [ ] `MobileChat.svelte`: engine picker in the language sheet (`:338,356-360`);
      `model_required` → download sheet. Keep `apply_transcript` (`:389-400`) and
      `toggle_mic` (`:407-442`) otherwise intact.
- [ ] CI: iOS-arm64 whisper build job; publish xcframework + GGML + manifest.
- [ ] Permissions: mic-only path for whisper (`SpeechPlugin.swift:65-72`).

### Phase 2 — Android (greenfield)
- [ ] Kotlin `@TauriPlugin` under the plugin's `android/` source set; Rust
      `register_android_plugin` branch in `src/lib.rs` (mirror `:217-218`).
- [ ] `AudioRecord` capture → same scheduler.
- [ ] NDK whisper.cpp build (`arm64-v8a` CPU, optional Vulkan) → `jniLibs/`.
- [ ] JNI bridge to `whisper_full`; emit same `trigger` events.
- [ ] Extend `deploy/android/overrides/` + post-`init` script (per
      `mobile-input-issues.md:83-85`) to stage `jniLibs` + Gradle; wire into
      `android-build.yml` BEFORE `android build`.
- [ ] Model download in Kotlin (`filesDir/whisper/`), mandatory before first use.

## K. Open questions for the user
1. **Default engine on iOS:** SFSpeech for EN + Whisper for zh (auto by locale),
   or Whisper-everywhere? (latency vs quality)
2. **Model size default:** `small-q5` (~180 MB, best zh) vs `base` (~140 MB) vs
   ship `tiny` bundled + upsell small?
3. **Bundle a tiny model in the IPA/APK** for out-of-box voice, or pure
   download-on-demand (zero size cost, but first voice needs a download)?
4. **Android priority:** is Android voice input wanted now (greenfield, ~2× the
   work), or iOS-first and defer Android?
5. **Terminal voice on mobile too?** Desktop terminal voice exists
   (`terminal-voice.svelte.ts`); should the mobile terminal keybar also get
   whisper dictation, or chat-only for v1?
6. **Vulkan on Android** worth the extra build/driver-coverage risk, or CPU-only?

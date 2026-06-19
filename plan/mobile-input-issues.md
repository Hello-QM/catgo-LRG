# Mobile input issues — root-cause log (2026-06-19)

Triage pass while user tests on-device (iOS + Android). Code paths verified
against current source. "Needs device evidence" = can't reproduce in agent env;
needs a screenshot or event log to close.

## A. Voice input — can't delete CJK after dictation (chat + terminal, multi-platform, NOT iOS-only)

Mechanism: speech transcript application overwrites/blocks user edits.

| Surface | Location | Mechanism |
|---|---|---|
| Desktop chat | `src/lib/chat/ChatPane.svelte:661-667` | `recognition.onresult` → `input_text = transcript` whole-value replace each event; recognizer auto-restarts on silence → overwrites user deletions |
| Mobile chat | `src/lib/mobile/MobileChat.svelte:389-395` | `apply_transcript` → `input = mic_base + sep + text` whole-value replace, no edit guard |
| Engine | `src/lib/gesture/voice-engine.ts:178` | `continuous = true` + auto-restart on silence |
| Desktop terminal | `src/lib/structure/TerminalPanel.svelte:449,567-576` | composition guard `IME_CONFIRM_KEYS` includes `\x7f` (DEL); 80ms post-compose window SWALLOWS Backspace after CJK commit |
| Terminal voice | `src/lib/structure/terminal-voice.svelte.ts:145` | final-only, `send_keys(text + space)` straight to PTY |

Two sub-causes:
- **A-chat**: whole-text replace + recognizer never stops → deletions回写. Fix = stop/freeze transcript application on user edit (`oninput`/edit → `stop_listening`; base from live value, not frozen `mic_base`).
- **A-terminal**: 80ms window treats DEL as a confirm key. Fix = drop `\x7f` from `IME_CONFIRM_KEYS` (suppress only space/enter, never Backspace).

## A2. iOS app-mic — second sentence overwrites first (CJK)

Native truth (`src-tauri/plugins/tauri-plugin-ios-speech/ios/Sources/SpeechPlugin.swift`):
- `bestTranscription.formattedString` cumulative WITHIN one task (:145)
- `isFinal` → emit `final` + `teardown()` (:149-151) → session ENDS, no auto-continue
- JS `mic_base` frozen at mic-start; `apply_transcript` whole-replace (`MobileChat.svelte:395`)

Root: design supports only ONE utterance per tap. Second sentence's text arrives
with `mic_base` still = start value → `input = "" + sentence2` → wipes sentence1.
No segment-commit / continuation.

Open unknown (needs device log of `partial`/`final` sequence): after `final`+teardown,
how does sentence 2 even emit events? Either (a) on-device partial regression after
pause, or (b) a restart. Fix below covers both.

Fix: `apply_transcript` → segment-commit + monotonic anti-regression:
- maintain `committed` buffer; continuation (longer/prefix) → `input = mic_base + committed + text`
- regression (shorter/diverged) → fold prev into `committed`, append new
- on native `final`: commit segment; if user hasn't stopped, `start_listening()` again
  to continue; do NOT flip `mic_listening` off except on user-stop/error

Product decision needed: continuous multi-sentence dictation (auto-continue) vs one-shot.

## B. Android — soft keyboard covers chat input + terminal keybar

Native patch IS in current source: `MainActivity.kt:29-39` `setOnApplyWindowInsetsListener`
pads `content` `(0, bars.top, 0, max(ime, bars.bottom))`; `AndroidManifest.xml:15`
`adjustResize`. (Gitignored — `deploy/android/README.md:115-171` documents required
re-apply after `tauri android init`.)

| Element | Handling | Verdict |
|---|---|---|
| Terminal keybar `MobileTerminal.svelte:679-695` | reads `visualViewport` → `position:fixed`, floats above kb when `kb_inset>0`, z=50 | has float logic; still covered on device → see hypothesis below |
| Chat composer `MobileChat.svelte:1150-1159` | ONLY `env(safe-area-inset-bottom)`, no visualViewport, no float | **genuine gap — will be covered** |

- **B1 chat composer**: real frontend bug. Fix = mirror terminal `kb_inset` float onto `.ai-composer`.
- **B2 keybar covered + C below**: likely same root → see hypothesis.

## C. Android — top overlaps status bar (time/signal/battery cover top of app)

Current source SHOULD be fine: `MainActivity.kt:37` pads top by `bars.top`; frontend
top bars use `env(safe-area-inset-top)` (`MobileChat.svelte:802`, etc.). With native
top padding, webview sits below status bar.

## CONFIRMED root cause for B2 + C: CI never re-applies the gitignored native inset patches

Device evidence (RMX2111, installed 1.2.1, lastUpdate 2026-06-19 04:22):
- Workspace + terminal top toolbar draws UNDER the status bar (time/battery/signal overlap) → C
- Terminal keybar fully hidden behind soft keyboard (no float above IME) → B2
- Landing screen top is fine (its own layout spacing), so it masked the issue

`.github/workflows/android-build.yml`:
- `:113 pnpm tauri android init` regenerates `gen/android` from STOCK templates
- `:126 pnpm tauri android build`
- **NO step between re-applies `MainActivity.kt` (inset listener) or `AndroidManifest.xml`
  (`windowSoftInputMode`)** → released APK ships a STOCK MainActivity with zero inset
  handling. `deploy/android/README.md` documents these as manual post-init patches; CI
  never runs them. Every released APK is broken on insets. The "validated on RMX2111"
  memory was a LOCAL build where the patch was hand-applied.

Fix: commit override copies of `MainActivity.kt` + `AndroidManifest.xml` (e.g.
`deploy/android/overrides/`) and a script that copies them into `gen/android` AFTER
`tauri android init`, BEFORE `android build` — invoked in CI and documented for local.
B1 (chat composer) is independent frontend work.

## Status

| Issue | State | Action |
|---|---|---|
| A-chat delete | confirmed | edit-stops-transcript fix |
| A-terminal delete | confirmed | drop `\x7f` from IME_CONFIRM_KEYS |
| A2 overwrite | WONTFIX | iOS SFSpeech only; built-in OS dictation is enough — whisper.cpp dropped, in-app mic left as-is (see plan/whisper-on-mobile.md) |
| B1 chat covered | confirmed | float composer on visualViewport |
| B2 keybar covered | needs device evidence | verify APK has patch |
| C status-bar overlap | needs device evidence | verify APK has patch |

No code changed yet — awaiting user test results + decisions.
